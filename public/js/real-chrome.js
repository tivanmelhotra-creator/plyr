/* ============================================
   real-chrome.js — control panel for the REAL Chrome.

   WHY THIS PANEL EXISTS
   ---------------------
   The picker canvas is a screencast of a PAGE. It can never show a Chrome
   extension's toolbar popup, chrome://extensions, or the native file dialog,
   because none of those are drawn by the page. People who rely on a cookie
   export/import extension therefore hit a hard wall in the simulated view.

   This panel exposes the three ways out, in the order of least effort:

     1. Import cookie file   — the fastest path to "I am logged in". Parses a
        Cookie-Editor / EditThisCookie / cookies.txt export server-side and puts
        the cookies in the profile, so BOTH the picker and queued runs get them.
     2. Open an extension    — an extension popup is also an extension PAGE, so
        it can be opened as a tab right inside this canvas, with full extension
        privileges. This is how you drive your cookie extension without a VNC.
     3. Open the desktop     — the whole Chrome window over noVNC, for the cases
        that genuinely need the toolbar or a native dialog.

   Exposes window.RealChromePanel.
   No inline handlers, no eval: the app runs under a strict CSP.
   ============================================ */
(function () {
  'use strict';

  var T = (window.I18N && window.I18N.t) ? window.I18N.t : function (k) { return k; };

  function t(key, fallback) {
    var v = T(key);
    // i18n returns the key itself when a string is missing; prefer readable
    // English over a raw dotted key leaking into the UI.
    return (v && v !== key) ? v : fallback;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function btn(label, cls) {
    var b = el('button', cls || 'btn btn-sm', label);
    b.type = 'button';
    return b;
  }

  /**
   * Icon-only button.
   *
   * Glyphs like "✕" are banned in shipped UI code (tests/unit/icons.test.ts
   * enforces it): they render differently per platform, some fonts have no
   * coverage at all, and they are invisible to a screen reader. Everything goes
   * through the shared SVG registry, with a text label as the accessible name.
   */
  function iconBtn(name, label, cls) {
    var b = el('button', cls || 'icon-btn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (window.Icons && window.Icons.svg) {
      b.innerHTML = window.Icons.svg(name, { size: 14 });
    } else {
      b.textContent = label;
    }
    return b;
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var current = null; // { root, onNavigate, status }

  function close() {
    if (!current) return;
    if (current.root && current.root.parentNode) {
      current.root.parentNode.removeChild(current.root);
    }
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    current = null;
  }

  function onOutside(ev) {
    if (!current) return;
    if (current.root.contains(ev.target)) return;
    // The trigger button toggles; ignoring it here stops close-then-reopen.
    if (current.anchor && current.anchor.contains(ev.target)) return;
    close();
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && current) {
      ev.stopPropagation();
      close();
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function setBusy(node, busy, label) {
    node.disabled = !!busy;
    if (busy) {
      node.dataset.label = node.textContent;
      node.textContent = label || '…';
    } else if (node.dataset.label) {
      node.textContent = node.dataset.label;
      delete node.dataset.label;
    }
  }

  function section(parent, title) {
    var s = el('div', 'rc-section');
    s.appendChild(el('div', 'rc-section-title', title));
    parent.appendChild(s);
    return s;
  }

  function note(parent, text, kind) {
    var n = el('div', 'rc-note' + (kind ? ' is-' + kind : ''), text);
    parent.appendChild(n);
    return n;
  }

  function render(root, status) {
    root.innerHTML = '';

    var head = el('div', 'rc-head');
    head.appendChild(el('span', 'rc-title', t('rc.title', 'Real Chrome')));
    var closeBtn = iconBtn('x', t('bvp.cancel', 'Close'), 'icon-btn rc-close');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    root.appendChild(head);

    var body = el('div', 'rc-body');
    root.appendChild(body);

    var rc = status.realChrome || {};
    var desk = status.desktop || {};

    // ── 1. Browser state ────────────────────────────────────────────────────
    var s1 = section(body, t('rc.browser', 'Browser'));
    var stateRow = el('div', 'rc-row');
    var chip = el('span', 'badge ' + (rc.running ? 'ok' : ''),
      rc.running
        ? t('rc.running', 'running') + (rc.browserVersion ? ' · ' + rc.browserVersion : '')
        : (rc.enabled ? t('rc.stopped', 'stopped') : t('rc.disabled', 'disabled')));
    stateRow.appendChild(chip);
    s1.appendChild(stateRow);

    if (!rc.enabled) {
      note(s1,
        t('rc.disabledHint',
          'Real Chrome is off. Set REAL_CHROME_ENABLED=true in .env and restart the server. ' +
          'Without it, extensions cannot be loaded at all.'),
        'warn');
    } else {
      var acts = el('div', 'rc-row');
      var startBtn = btn(rc.running ? t('rc.restart', 'Restart') : t('rc.start', 'Start'),
        'btn btn-primary btn-sm');
      startBtn.addEventListener('click', function () {
        setBusy(startBtn, true, t('rc.starting', 'starting…'));
        window.API.post(rc.running ? '/browser/restart' : '/browser/start', {})
          .then(refresh)
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () { setBusy(startBtn, false); });
      });
      acts.appendChild(startBtn);

      if (rc.running) {
        var stopBtn = btn(t('rc.stop', 'Stop'), 'btn btn-sm');
        stopBtn.addEventListener('click', function () {
          setBusy(stopBtn, true);
          window.API.post('/browser/stop', {})
            .then(refresh)
            .catch(function (e) { toast(e.message, 'error'); })
            .then(function () { setBusy(stopBtn, false); });
        });
        acts.appendChild(stopBtn);
      }
      s1.appendChild(acts);

      if (rc.lastError) note(s1, rc.lastError, 'error');
      if (rc.debugUrl) {
        note(s1, t('rc.devtools', 'DevTools port') + ': ' + rc.debugUrl +
          ' — ' + t('rc.devtoolsHint',
            'attach any CDP client, or open chrome://inspect in your own Chrome.'));
      }
    }

    // ── 2. Cookies ──────────────────────────────────────────────────────────
    var s2 = section(body, t('rc.cookies', 'Cookies'));
    note(s2, t('rc.cookiesHint',
      'Import the file your cookie extension exported. It is stored in the profile, ' +
      'so both this window and queued automation runs skip the login.'));

    var cookieRow = el('div', 'rc-row');
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.txt,application/json,text/plain';
    fileInput.className = 'rc-file';

    var importBtn = btn(t('rc.import', 'Import cookie file'), 'btn btn-primary btn-sm');
    importBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      setBusy(importBtn, true, t('rc.importing', 'importing…'));
      var reader = new FileReader();
      reader.onerror = function () {
        setBusy(importBtn, false);
        toast(t('rc.readFail', 'Could not read the file.'), 'error');
      };
      reader.onload = function () {
        window.API.post('/browser/cookies/import', { text: String(reader.result || '') })
          .then(function (res) {
            toast(res.message || t('rc.imported', 'Imported.'), 'ok');
            if (res.rejected && res.rejected.length) {
              toast(res.rejected.length + ' ' +
                t('rc.rejected', 'cookie(s) were rejected by Chrome.'), 'warn');
            }
            return refresh();
          })
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () {
            setBusy(importBtn, false);
            fileInput.value = '';
          });
      };
      reader.readAsText(file);
    });

    cookieRow.appendChild(importBtn);
    cookieRow.appendChild(fileInput);

    var exportBtn = btn(t('rc.export', 'Export'), 'btn btn-sm');
    exportBtn.addEventListener('click', function () {
      // A plain link download: the endpoint sets Content-Disposition, and the
      // API key rides in the query so the browser's own GET is authenticated.
      var key = window.API.getKey ? window.API.getKey() : '';
      var url = '/browser/cookies/export' + (key ? '?api_key=' + encodeURIComponent(key) : '');
      window.open(url, '_blank', 'noopener');
    });
    cookieRow.appendChild(exportBtn);
    s2.appendChild(cookieRow);

    // ── 3. Extensions ───────────────────────────────────────────────────────
    var s3 = section(body, t('rc.extensions', 'Extensions'));

    // Install from the Web Store first: it is the path that needs nothing from
    // the user but a link they already have open.
    note(s3, t('rc.storeHint',
      'Paste a Chrome Web Store link and the server downloads, unpacks and ' +
      'installs the extension itself. No .crx hunting and no remote desktop.'));

    var storeRow = el('div', 'rc-row rc-store');
    var storeInput = document.createElement('input');
    storeInput.type = 'text';
    storeInput.className = 'rc-input';
    storeInput.placeholder = t('rc.storePlaceholder',
      'https://chromewebstore.google.com/detail/…');
    storeInput.spellcheck = false;
    // Pasting a long URL into a narrow field is unreadable; the title shows all.
    storeInput.addEventListener('input', function () {
      storeInput.title = storeInput.value;
    });

    var storeBtn = btn(t('rc.installStore', 'Install'), 'btn btn-primary btn-sm');

    function installFromStore() {
      var value = storeInput.value.trim();
      if (!value) {
        toast(t('rc.storeEmpty', 'Paste a Chrome Web Store link first.'), 'warn');
        storeInput.focus();
        return;
      }
      setBusy(storeBtn, true, t('rc.installing', 'installing…'));
      storeInput.disabled = true;
      window.API.post('/browser/extensions/store', { url: value })
        .then(function (res) {
          toast(res.message || t('rc.installed', 'Installed.'), 'ok');
          storeInput.value = '';
          return refresh();
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () {
          setBusy(storeBtn, false);
          storeInput.disabled = false;
        });
    }

    storeBtn.addEventListener('click', installFromStore);
    // Enter is what everybody presses after pasting a URL.
    storeInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); installFromStore(); }
    });

    storeRow.appendChild(storeInput);
    storeRow.appendChild(storeBtn);
    s3.appendChild(storeRow);

    var list = el('div', 'rc-list');
    var exts = rc.extensions || [];
    if (!exts.length) {
      note(list, t('rc.noExtensions',
        'No extensions loaded. Install one from the Web Store above, or upload a ' +
        '.crx / .zip — then restart the browser, because Chrome only reads ' +
        'extensions at launch.'));
    } else {
      exts.forEach(function (ext) {
        var row = el('div', 'rc-ext');
        var meta = el('div', 'rc-ext-meta');
        meta.appendChild(el('div', 'rc-ext-name', ext.name));
        var sub = 'v' + ext.version + ' · MV' + ext.manifestVersion;
        meta.appendChild(el('div', 'rc-ext-ver', sub));
        if (ext.runtimeId) {
          // The id is what a workflow step needs to build a chrome-extension://
          // URL by hand, so it must be visible and selectable, not just implied.
          var idRow = el('div', 'rc-ext-id', ext.runtimeId);
          idRow.title = t('rc.extIdHint',
            'The id Chrome assigns this extension. Store installs keep the ' +
            'official id, so chrome-extension:// links stay valid.');
          meta.appendChild(idRow);
        }
        row.appendChild(meta);

        var openBtn = btn(t('rc.open', 'Open here'), 'btn btn-sm');
        openBtn.title = t('rc.openHint',
          'Opens the extension\'s own popup page in this canvas, with full extension privileges.');
        openBtn.disabled = !(ext.popupUrl || ext.optionsUrl || ext.url);
        openBtn.addEventListener('click', function () {
          var url = ext.popupUrl || ext.optionsUrl || ext.url;
          if (!url) return;
          if (current && typeof current.onNavigate === 'function') {
            current.onNavigate(url);
            close();
          }
        });
        row.appendChild(openBtn);

        var delBtn = iconBtn('trash', t('rc.remove', 'Remove'));
        delBtn.addEventListener('click', function () {
          setBusy(delBtn, true);
          window.API.del('/browser/extensions/' + encodeURIComponent(ext.id))
            .then(refresh)
            .catch(function (e) { toast(e.message, 'error'); })
            .then(function () { setBusy(delBtn, false); });
        });
        row.appendChild(delBtn);

        list.appendChild(row);
      });
    }
    s3.appendChild(list);

    if (rc.restartRequired) {
      note(s3, t('rc.restartRequired',
        'An extension was installed after the browser started. Restart to load it.'), 'warn');
    }

    var upRow = el('div', 'rc-row');
    var extFile = document.createElement('input');
    extFile.type = 'file';
    extFile.accept = '.crx,.zip';
    extFile.className = 'rc-file';
    var upBtn = btn(t('rc.upload', 'Upload .crx / .zip'), 'btn btn-sm');
    upBtn.addEventListener('click', function () { extFile.click(); });
    extFile.addEventListener('change', function () {
      var file = extFile.files && extFile.files[0];
      if (!file) return;
      setBusy(upBtn, true, t('rc.uploading', 'uploading…'));
      // Raw body, not multipart: no server-side multipart dependency, and the
      // File object is already a Blob fetch can send as-is.
      fetch('/browser/extensions?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-api-key': window.API.getKey ? window.API.getKey() : '',
        },
        body: file,
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error((r.d && r.d.error) || 'upload failed');
          toast(r.d.message || t('rc.installed', 'Installed.'), 'ok');
          return refresh();
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () { setBusy(upBtn, false); extFile.value = ''; });
    });
    upRow.appendChild(upBtn);
    upRow.appendChild(extFile);
    s3.appendChild(upRow);

    // ── 4. Remote desktop ───────────────────────────────────────────────────
    var s4 = section(body, t('rc.desktop', 'Remote desktop'));
    note(s4, t('rc.desktopHint',
      'Optional. Installing from the Web Store above and opening an extension ' +
      'with “Open here” covers almost everything. This is only for a native OS ' +
      'file dialog or the toolbar button itself, and needs extra packages.'));

    var dRow = el('div', 'rc-row');
    var dChip = el('span', 'badge ' + (desk.running ? 'ok' : ''),
      desk.running ? t('rc.running', 'running') : t('rc.stopped', 'stopped'));
    dRow.appendChild(dChip);

    if (desk.missing && desk.missing.length) {
      // Deliberately NOT styled as a warning. Nothing is broken: the desktop is
      // an optional extra now that extensions install from the store, and an
      // orange block here reads as "your setup is wrong" for a feature most
      // people never need.
      note(s4, t('rc.desktopOptional',
        'Not installed — and not needed for extensions.') + ' ' +
        (desk.installHint || ('Missing: ' + desk.missing.join(', '))));
    } else if (desk.running) {
      var openDesk = btn(t('rc.openDesktop', 'Open desktop'), 'btn btn-primary btn-sm');
      openDesk.addEventListener('click', function () {
        // Same hostname, different port: noVNC is its own server, not proxied
        // through this app, so the URL is built from location.hostname.
        var url = window.location.protocol + '//' + window.location.hostname +
          ':' + desk.novncPort + (desk.novncPath || '/vnc.html');
        window.open(url, '_blank', 'noopener');
      });
      dRow.appendChild(openDesk);

      var stopDesk = btn(t('rc.stop', 'Stop'), 'btn btn-sm');
      stopDesk.addEventListener('click', function () {
        setBusy(stopDesk, true);
        window.API.post('/browser/desktop/stop', {})
          .then(refresh)
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () { setBusy(stopDesk, false); });
      });
      dRow.appendChild(stopDesk);
    } else {
      var startDesk = btn(t('rc.startDesktop', 'Start desktop'), 'btn btn-sm');
      startDesk.addEventListener('click', function () {
        setBusy(startDesk, true, t('rc.starting', 'starting…'));
        window.API.post('/browser/desktop/start', {})
          .then(refresh)
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () { setBusy(startDesk, false); });
      });
      dRow.appendChild(startDesk);
    }
    s4.appendChild(dRow);

    if (desk.running && !desk.passwordProtected) {
      note(s4, t('rc.noVncPassword',
        'This screen has no password. It holds every cookie you import — do not ' +
        'expose the port publicly; tunnel it over SSH instead.'), 'warn');
    }
  }

  function toast(msg, kind) {
    if (window.AppUtil && typeof window.AppUtil.toast === 'function') {
      window.AppUtil.toast(msg, kind === 'error' ? 'error' : (kind || 'info'));
      return;
    }
    if (!current) return;
    var n = current.root.querySelector('.rc-toast');
    if (!n) {
      n = el('div', 'rc-toast');
      current.root.appendChild(n);
    }
    n.className = 'rc-toast is-' + (kind || 'info');
    n.textContent = msg;
  }

  function refresh() {
    if (!current) return Promise.resolve();
    return window.API.get('/browser/status')
      .then(function (status) {
        if (!current) return;
        current.status = status;
        render(current.root, status);
      })
      .catch(function (e) {
        if (!current) return;
        current.root.innerHTML = '';
        note(current.root, e.message, 'error');
      });
  }

  /**
   * Open the panel.
   *
   * opts.anchor     element the panel is positioned under (the toolbar button)
   * opts.onNavigate fn(url) — used by "Open here" to point the picker canvas at
   *                 a chrome-extension:// page.
   */
  function openPanel(opts) {
    opts = opts || {};
    if (current) { close(); return; }

    var root = el('div', 'rc-panel');
    root.setAttribute('role', 'dialog');
    (opts.container || document.body).appendChild(root);

    if (opts.anchor && opts.anchor.getBoundingClientRect) {
      var r = opts.anchor.getBoundingClientRect();
      root.style.position = 'fixed';

      // Clamp horizontally: the trigger lives at the right edge of the picker
      // toolbar, so anchoring naively puts most of the panel off-screen.
      var left = Math.min(Math.round(r.left), window.innerWidth - 380);
      root.style.left = Math.max(8, left) + 'px';

      // Clamp vertically too. The panel is tall (four sections) and the toolbar
      // is near the top, but on a short window the bottom section — the remote
      // desktop controls, which is what half of this feature is about — would
      // otherwise be pushed below the fold with no way to reach it.
      var top = Math.round(r.bottom + 6);
      var available = window.innerHeight - top - 12;
      if (available < 260) {
        // Not enough room below: sit above the trigger instead.
        root.style.top = 'auto';
        root.style.bottom = Math.max(8, window.innerHeight - Math.round(r.top) + 6) + 'px';
        root.style.maxHeight = Math.max(220, Math.round(r.top) - 20) + 'px';
      } else {
        root.style.top = top + 'px';
        root.style.maxHeight = available + 'px';
      }
    }

    current = { root: root, anchor: opts.anchor || null, onNavigate: opts.onNavigate || null };

    note(root, t('rc.loading', 'Loading…'));
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    refresh();
  }

  window.RealChromePanel = {
    open: openPanel,
    close: close,
    isOpen: function () { return !!current; },
  };
})();
