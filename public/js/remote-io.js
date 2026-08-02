/* ============================================
   RemoteIO — clipboard and file transfer for a browser that is not on this
   machine.

   THE GAP THIS CLOSES
   -------------------
   The picker/live canvas is a JPEG stream of a Chrome running on the SERVER.
   Everything about it feels like a browser until you try to move data across
   the boundary, and then two everyday actions simply have no effect:

     Ctrl+V   pastes into YOUR browser, which is showing an image. The remote
              page's focused field never hears about it.
     Ctrl+C   copies from YOUR selection — an image — while the text you meant
              is selected on the server. Worse: an extension whose "Export"
              button calls navigator.clipboard.writeText() writes to the
              SERVER's clipboard, i.e. into a void the user cannot reach.
     Import   opens a native file dialog, drawn by the server's window manager
              (never in the screencast) and browsing the server's disk (never
              where the user's file is). The button appears broken.

   All three are carried explicitly over the same WebSocket that already carries
   clicks and keystrokes:

     local paste  → { t:'paste', text }          → Input.insertText + remote clipboard
     local Ctrl+C → { t:'copy' }                 → ← { t:'clipboard', text }
     page dialog  ← { t:'filechooser', accept }  → upload → { t:'fileAccept', tokens }

   CSP-safe: no inline handlers, no eval. Shared by the picker modal and the
   Live Browser View so the two surfaces cannot drift apart.
   ============================================ */
(function () {
  'use strict';

  function t(k, fallback) {
    var s = (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
    return (s === k && fallback) ? fallback : s;
  }
  function toast(msg, kind) {
    if (window.AppUtil && window.AppUtil.toast) window.AppUtil.toast(msg, kind || 'info');
  }
  function BIC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 14 }) : '';
  }

  /**
   * Put text on the LOCAL clipboard.
   *
   * navigator.clipboard is unavailable on plain http:// origins (a self-hosted
   * server on a LAN is exactly that), so the execCommand path is not legacy
   * cruft — it is the only path that works for a large share of this project's
   * deployments.
   */
  function writeLocalClipboard(text) {
    var s = String(text == null ? '' : text);
    if (!s) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(s); });
    }
    return Promise.resolve(legacyCopy(s));
  }

  function legacyCopy(s) {
    try {
      var ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /**
   * Upload one File to the server and resolve with its opaque token.
   *
   * `userId` is not optional in spirit: the token is resolved again by the
   * WebSocket session, which runs as the userId its own URL carried. Uploading
   * under a different identity stores the bytes in a directory the session
   * never looks in, and the hand-over fails with a bare ENOENT — i.e. Import
   * appears to do nothing, which is the bug this module exists to fix.
   */
  function uploadFile(file, userId) {
    var q = '?name=' + encodeURIComponent(file.name || 'file');
    if (userId) q += '&userId=' + encodeURIComponent(userId);
    return fetch('/browser/uploads' + q, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-api-key': (window.API && window.API.getKey) ? window.API.getKey() : ''
      },
      body: file
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d || !d.success) {
          throw new Error((d && d.error) || 'upload failed');
        }
        return d.token;
      });
    });
  }

  /**
   * Does this file satisfy the page's `accept` attribute?
   *
   * Checked here, before the upload, because the alternative is a round trip
   * that ends in the page silently rejecting the file with no message — the
   * exact failure mode this whole module exists to remove. Extensions and MIME
   * types both, since `accept` may hold either ('.json' or 'application/json').
   */
  function acceptsFile(accept, file) {
    var spec = String(accept || '').trim();
    if (!spec) return true;
    var name = String(file.name || '').toLowerCase();
    var type = String(file.type || '').toLowerCase();
    var parts = spec.split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim().toLowerCase();
      if (!p) continue;
      if (p.charAt(0) === '.') {
        if (name.slice(-p.length) === p) return true;
      } else if (p.slice(-2) === '/*') {
        if (type.indexOf(p.slice(0, -1)) === 0) return true;
      } else if (p === type) {
        return true;
      }
    }
    return false;
  }

  /**
   * Wire a stage (the canvas container) for clipboard + file transfer.
   *
   * opts = {
   *   stage:     focusable element that receives keys/paste,
   *   host:      element the file prompt is appended to (defaults to stage),
   *   send:      function(msgObject) — the WebSocket sender,
   *   userId:    string or function() -> string; the SAME identity the socket
   *              was opened with, so the upload lands where the session looks,
   *   isBusy:    optional function() -> bool; true = swallow nothing (e.g.
   *              element-selection mode, where keys mean something else)
   * }
   * Returns { onMessage(msg) -> handled, detach() }.
   */
  function attach(opts) {
    var o = opts || {};
    var stage = o.stage;
    var host = o.host || stage;
    var send = o.send || function () {};
    var isBusy = o.isBusy || function () { return false; };
    var userId = typeof o.userId === 'function'
      ? o.userId
      : function () { return o.userId || ''; };
    if (!stage) return { onMessage: function () { return false; }, detach: function () {} };

    var bar = null;          // the file prompt, created on demand
    var pending = null;      // { accept, multiple }
    var listeners = [];

    function on(el, type, fn, capture) {
      el.addEventListener(type, fn, !!capture);
      listeners.push([el, type, fn, !!capture]);
    }

    // ── Clipboard ──────────────────────────────────────────────────────────

    // A real `paste` event is the ONLY way to read the local clipboard without
    // asking for a permission prompt, so the flow is driven by the event rather
    // than by the keystroke: the browser hands us the data, we forward it.
    on(stage, 'paste', function (ev) {
      if (isBusy()) return;
      var dt = ev.clipboardData;
      if (!dt) return;
      // A file on the clipboard while the page is waiting for one is the
      // shortest possible path: copy in your OS file manager, paste here.
      if (pending && dt.files && dt.files.length) {
        ev.preventDefault();
        sendFiles(dt.files);
        return;
      }
      var text = dt.getData('text/plain');
      if (!text) return;
      ev.preventDefault();
      send({ t: 'paste', text: text });
    });

    on(stage, 'keydown', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      var k = String(ev.key || '').toLowerCase();
      if (k === 'v') return;            // handled by the paste event above
      if (k === 'c' || k === 'x') {
        // Swallowed on purpose. Letting the local browser handle it would copy
        // the empty selection of a canvas and CLEAR the clipboard the user is
        // about to need. The answer arrives as a 'clipboard' message.
        ev.preventDefault();
        send({ t: 'copy' });
      } else if (k === 'a') {
        ev.preventDefault();
        send({ t: 'selectAll' });
      }
    }, true);

    // ── File prompt ────────────────────────────────────────────────────────

    function closeBar() {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      bar = null;
    }

    function sendFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      if (!pending) return;
      if (!pending.multiple) files = files.slice(0, 1);

      var bad = files.filter(function (f) { return !acceptsFile(pending.accept, f); });
      if (bad.length) {
        toast(t('rio.wrongType', 'The page only accepts') + ' ' + pending.accept, 'error');
        return;
      }
      setBarBusy(true);
      Promise.all(files.map(function (f) { return uploadFile(f, userId()); }))
        .then(function (tokens) {
          send({ t: 'fileAccept', tokens: tokens });
        })
        .catch(function (e) {
          setBarBusy(false);
          toast(e.message || 'upload failed', 'error');
        });
    }

    function setBarBusy(busy) {
      if (!bar) return;
      var btn = bar.querySelector('.rio-choose');
      var status = bar.querySelector('.rio-status');
      if (btn) btn.disabled = !!busy;
      if (status) status.textContent = busy ? t('rio.uploading', 'sending…') : '';
    }

    function openBar(info) {
      closeBar();
      pending = info;
      bar = document.createElement('div');
      bar.className = 'rio-filebar';
      bar.innerHTML =
        '<span class="rio-ico">' + BIC('upload', 15) + '</span>' +
        '<span class="rio-text">' +
          '<b>' + t('rio.wants', 'The page is asking for a file') + '</b>' +
          (info.accept
            ? '<span class="rio-accept" dir="ltr">' + String(info.accept) + '</span>'
            : '') +
        '</span>' +
        '<span class="rio-status"></span>' +
        '<button type="button" class="btn btn-primary btn-sm rio-choose">' +
          t('rio.choose', 'Choose a file…') + '</button>' +
        '<button type="button" class="btn btn-sm rio-cancel">' +
          t('rio.cancel', 'Cancel') + '</button>';

      var input = document.createElement('input');
      input.type = 'file';
      input.className = 'rio-input';
      if (info.accept) input.accept = info.accept;
      if (info.multiple) input.multiple = true;
      bar.appendChild(input);

      bar.querySelector('.rio-choose').addEventListener('click', function () {
        input.click();
      });
      bar.querySelector('.rio-cancel').addEventListener('click', function () {
        send({ t: 'fileCancel' });
        pending = null;
        closeBar();
      });
      input.addEventListener('change', function () {
        sendFiles(input.files);
      });

      host.appendChild(bar);
    }

    // Drag a file onto the canvas — the gesture people try first, and which
    // otherwise makes the LOCAL browser navigate away to the file.
    on(stage, 'dragover', function (ev) {
      if (!pending) return;
      ev.preventDefault();
      stage.classList.add('rio-dropping');
    });
    on(stage, 'dragleave', function () { stage.classList.remove('rio-dropping'); });
    on(stage, 'drop', function (ev) {
      if (!pending) return;
      ev.preventDefault();
      stage.classList.remove('rio-dropping');
      if (ev.dataTransfer && ev.dataTransfer.files) sendFiles(ev.dataTransfer.files);
    });

    // ── Inbound messages ───────────────────────────────────────────────────

    function onMessage(msg) {
      if (!msg || !msg.t) return false;
      switch (msg.t) {
        case 'filechooser':
          openBar({
            accept: msg.accept || '',
            multiple: !!msg.multiple
          });
          return true;
        case 'fileChooserDone':
          pending = null;
          closeBar();
          if (msg.ok) {
            toast(t('rio.sent', 'File sent to the page.'), 'success');
          } else if (msg.reason && msg.reason !== 'cancelled') {
            toast(String(msg.reason), 'error');
          }
          return true;
        case 'clipboard':
          if (!msg.text) {
            toast(t('rio.nothingToCopy',
              'Nothing was selected in the remote page, and its clipboard is empty.'),
            'info');
            return true;
          }
          writeLocalClipboard(msg.text).then(function (ok) {
            toast(ok
              ? t('rio.copied', 'Copied from the remote browser.')
              : t('rio.copyFailed', 'Could not write to your clipboard.'),
            ok ? 'success' : 'error');
          });
          return true;
        default:
          return false;
      }
    }

    function detach() {
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]);
        } catch (e) { /* element already gone */ }
      }
      listeners = [];
      pending = null;
      closeBar();
    }

    return {
      onMessage: onMessage,
      detach: detach,
      /** Explicit "pull the remote clipboard" for the toolbar button. */
      pullClipboard: function () { send({ t: 'copy' }); },
      hasPendingFile: function () { return !!pending; }
    };
  }

  window.RemoteIO = {
    attach: attach,
    // Exported for tests: the accept-filter rule is the one piece of logic here
    // that is worth pinning, and it must not need a DOM to check.
    acceptsFile: acceptsFile,
    writeLocalClipboard: writeLocalClipboard
  };
})();
