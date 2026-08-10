/* ============================================
   Live Browser View + Element Picker (Step 12).
   - window.BrowserView: { render(root), stop() }
   Streams the server-side Chromium page onto a <canvas> via the
   /browser/ws WebSocket (CDP screencast → base64 JPEG frames).
   Sends user clicks / typing / scrolling back to drive the real
   browser. An Element Picker reports a CSS selector + XPath which
   can be copied or inserted as a step into the linear flow builder.
   CSP-safe: no inline handlers, no eval.
   ============================================ */
(function () {
  'use strict';

  // Inline SVG icon helper (public/js/icons.js). Emoji glyphs were removed
  // project-wide: the target font stack has no emoji coverage, so they rendered
  // as empty boxes, and they could not be tinted with `currentColor`.
  function BIC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : '';
  }

  var API = window.API;

  function t(k) {
    return (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
  }
  // t() with placeholders. The panel needs "#2 of 7" and "المان ‎#۲"، which do
  // NOT share a word order, so the numbers are substituted INTO the translated
  // string rather than concatenated around it in JS.
  function tf(k, map) {
    return String(t(k)).replace(/\{(\w+)\}/g, function (m, name) {
      return map && map[name] != null ? String(map[name]) : m;
    });
  }
  function esc(s) {
    if (window.AppUtil && window.AppUtil.esc) return window.AppUtil.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) {
    if (window.AppUtil && window.AppUtil.toast) window.AppUtil.toast(msg, kind || 'info');
  }
  function effectiveUserId() {
    var uid = API.getUserId();
    if (!uid || uid === 'env_root') return '0';
    return uid;
  }

  // Active connection state (module-level so stop() can clean up).
  var state = null;

  function wsUrl(userId, apiKey) {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var q = 'userId=' + encodeURIComponent(userId);
    if (apiKey) q += '&api_key=' + encodeURIComponent(apiKey);
    return proto + '//' + location.host + '/browser/ws?' + q;
  }

  function render(root) {
    stop();

    root.innerHTML =
      '<div class="card">' +
        '<h3 class="card-title">' + BIC('frame') + ' ' + esc(t('bv.title')) + '</h3>' +
        '<p class="muted">' + esc(t('bv.subtitle')) + '</p>' +
        '<div class="form-row" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:220px;">' +
            '<label class="form-label" for="bv-url">' + esc(t('bv.url')) + '</label>' +
            '<input class="input field-input" id="bv-url" type="text" placeholder="https://example.com" autocomplete="off">' +
          '</div>' +
          '<button class="btn btn-primary" id="bv-connect">' + esc(t('bv.connect')) + '</button>' +
          '<button class="btn btn-ghost" id="bv-go" disabled>' + esc(t('bv.go')) + '</button>' +
          '<button class="btn btn-ghost" id="bv-picker" disabled>' + BIC('target', 14) + ' ' + esc(t('bv.pick')) + '</button>' +
          '<button class="btn btn-ghost" id="bv-disconnect" disabled>' + esc(t('bv.disconnect')) + '</button>' +
        '</div>' +
        '<div class="live-statusbar" style="margin-top:.6rem;">' +
          '<span class="badge" id="bv-status">—</span>' +
          '<span class="muted" id="bv-hint" style="margin-inline-start:.5rem;"></span>' +
        '</div>' +
      '</div>' +

      '<div class="card" style="margin-top:1rem;">' +
        '<div id="bv-stage" tabindex="0" style="position:relative;background:#111;border-radius:8px;overflow:hidden;min-height:240px;outline:none;">' +
          '<canvas id="bv-canvas" style="display:block;width:100%;height:auto;cursor:crosshair;"></canvas>' +
          '<div id="bv-overlay" class="muted" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem;">' +
            esc(t('bv.placeholder')) +
          '</div>' +
        '</div>' +
        '<p class="muted" style="margin-top:.5rem;font-size:.85rem;">' + esc(t('bv.typingHint')) + '</p>' +
      '</div>' +

      '<div class="card" id="bv-pickcard" style="margin-top:1rem;display:none;">' +
        '<h4 class="card-title">' + BIC('target') + ' ' + esc(t('bv.picked')) + '</h4>' +
        '<div class="form-row">' +
          '<label class="field" style="flex:1;">' +
            '<span class="field-label">CSS</span>' +
            '<input class="field-input" id="bv-css" readonly>' +
          '</label>' +
        '</div>' +
        '<div class="form-row">' +
          '<label class="field" style="flex:1;">' +
            '<span class="field-label">XPath</span>' +
            '<input class="field-input" id="bv-xpath" readonly>' +
          '</label>' +
        '</div>' +
        '<div class="toolbar" style="gap:.5rem;flex-wrap:wrap;">' +
          '<button class="btn btn-ghost btn-sm" id="bv-copy-css">' + esc(t('bv.copyCss')) + '</button>' +
          '<button class="btn btn-ghost btn-sm" id="bv-copy-xpath">' + esc(t('bv.copyXpath')) + '</button>' +
          '<button class="btn btn-sm" id="bv-add-click">+ ' + esc(t('bv.addClick')) + '</button>' +
          '<button class="btn btn-sm" id="bv-add-extract">+ ' + esc(t('bv.addExtract')) + '</button>' +
        '</div>' +
      '</div>';

    var urlInput = root.querySelector('#bv-url');
    var btnConnect = root.querySelector('#bv-connect');
    var btnGo = root.querySelector('#bv-go');
    var btnPicker = root.querySelector('#bv-picker');
    var btnDisconnect = root.querySelector('#bv-disconnect');
    var stage = root.querySelector('#bv-stage');
    var canvas = root.querySelector('#bv-canvas');
    var overlay = root.querySelector('#bv-overlay');
    var statusBadge = root.querySelector('#bv-status');
    var hint = root.querySelector('#bv-hint');
    var pickCard = root.querySelector('#bv-pickcard');
    var cssIn = root.querySelector('#bv-css');
    var xpathIn = root.querySelector('#bv-xpath');

    var ctx = canvas.getContext('2d');
    var pickerOn = false;
    // Clipboard + file transfer across the local/remote boundary. Created on
    // connect and torn down on disconnect, so a half-answered "the page wants a
    // file" prompt can never outlive the session it belonged to.
    var rio = null;
    // The page's logical size (CDP device px), used to map canvas clicks.
    var pageW = 1280, pageH = 720;

    function setStatus(label, cls) {
      statusBadge.className = 'badge ' + (cls || '');
      statusBadge.textContent = label;
    }
    function setEnabled(connected) {
      btnGo.disabled = !connected;
      btnPicker.disabled = !connected;
      btnDisconnect.disabled = !connected;
      btnConnect.disabled = connected;
    }

    function drawFrame(b64, w, h) {
      if (w && h) { pageW = w; pageH = h; }
      var img = new Image();
      img.onload = function () {
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        ctx.drawImage(img, 0, 0);
      };
      img.src = 'data:image/jpeg;base64,' + b64;
      if (overlay) { overlay.style.display = 'none'; }
    }

    // Map a DOM pointer event on the canvas to page device coordinates.
    function toPagePoint(ev) {
      var rect = canvas.getBoundingClientRect();
      var sx = canvas.width / rect.width || 1;
      var sy = canvas.height / rect.height || 1;
      return {
        x: (ev.clientX - rect.left) * sx,
        y: (ev.clientY - rect.top) * sy
      };
    }

    function send(obj) {
      if (state && state.ws && state.ws.readyState === WebSocket.OPEN) {
        try { state.ws.send(JSON.stringify(obj)); } catch (e) {}
      }
    }

    function onCanvasClick(ev) {
      if (!state) return;
      var p = toPagePoint(ev);
      send({ t: 'click', x: p.x, y: p.y });
    }
    function onCanvasWheel(ev) {
      if (!state) return;
      ev.preventDefault();
      var p = toPagePoint(ev);
      send({ t: 'scroll', x: p.x, y: p.y, dy: ev.deltaY });
    }
    function onStageKey(ev) {
      if (!state) return;
      var special = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab',
        ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft',
        ArrowRight: 'ArrowRight', Delete: 'Delete', Escape: 'Escape' };
      if (special[ev.key]) {
        ev.preventDefault();
        send({ t: 'key', key: special[ev.key] });
      } else if (ev.key && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        send({ t: 'type', text: ev.key });
      }
    }

    function showPick(data) {
      pickCard.style.display = '';
      cssIn.value = data.css || '';
      xpathIn.value = data.xpath || '';
      state.lastPick = data;
      toast(t('bv.pickedToast') + ' ' + (data.tag || ''), 'success');
    }

    function handleMessage(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || !msg.t) return;
      // Clipboard/file messages first. They are owned entirely by RemoteIO, and
      // routing them here keeps this switch from growing a second vocabulary.
      if (rio && rio.onMessage(msg)) return;
      switch (msg.t) {
        case 'frame':
          drawFrame(msg.data, msg.width, msg.height);
          break;
        case 'ready':
          setStatus(t('bv.connected'), 'ok');
          hint.textContent = msg.url || '';
          setEnabled(true);
          // The first navigation is sent HERE, not from `onopen`. The server
          // needs ~½ second to boot the page behind the socket, and a command
          // that arrives before it is ready is lost — which is what made
          // "type a URL, press Connect, nothing loads" the normal experience.
          if (state && state.pendingUrl) {
            var pu = state.pendingUrl;
            state.pendingUrl = '';
            send({ t: 'navigate', url: pu });
          }
          break;
        case 'navigated':
          hint.textContent = msg.url || '';
          break;
        case 'picker':
          pickerOn = !!msg.on;
          btnPicker.classList.toggle('btn-primary', pickerOn);
          canvas.style.cursor = pickerOn ? 'cell' : 'crosshair';
          break;
        case 'pick':
          showPick(msg);
          break;
        case 'expired':
          toast(t('bv.expired'), 'info');
          break;
        case 'error':
          toast(String(msg.message || 'error'), 'error');
          hint.textContent = String(msg.message || '');
          break;
      }
    }

    function connect() {
      var uid = effectiveUserId();
      var url = wsUrl(uid, API.getKey());
      var WS = window.WebSocket;
      if (!WS) { toast(t('bv.noWs'), 'error'); return; }
      setStatus(t('bv.connecting'), 'warn');
      var ws;
      try { ws = new WS(url); } catch (e) { setStatus(t('bv.error'), 'bad'); return; }
      // `pendingUrl` is flushed by the 'ready' event (see handleMessage): the
      // page does not exist yet at `onopen`.
      state = { ws: ws, lastPick: null, pendingUrl: (urlInput.value || '').trim() };
      if (window.RemoteIO && !rio) {
        rio = window.RemoteIO.attach({
          stage: stage, host: stage, send: send,
          // Same identity as the socket line above, or the upload lands in a
          // directory this session never looks in.
          userId: uid
        });
      }
      ws.onopen = function () {
        setStatus(t('bv.connecting'), 'warn'); // wait for 'ready'
      };
      ws.onmessage = function (m) { handleMessage(m.data); };
      ws.onerror = function () { setStatus(t('bv.error'), 'bad'); };
      ws.onclose = function () {
        setStatus(t('bv.disconnected'), '');
        setEnabled(false);
        state = null;
        dropRemoteIo();
      };
    }

    function dropRemoteIo() {
      if (!rio) return;
      try { rio.detach(); } catch (e) {}
      rio = null;
    }

    function disconnect() {
      if (state && state.ws) { try { state.ws.close(); } catch (e) {} }
      state = null;
      dropRemoteIo();
      setEnabled(false);
      setStatus(t('bv.disconnected'), '');
    }

    function go() {
      var url = (urlInput.value || '').trim();
      if (!url) { urlInput.focus(); return; }
      send({ t: 'navigate', url: url });
    }

    function togglePicker() {
      pickerOn = !pickerOn;
      send({ t: 'picker', on: pickerOn });
    }

    function addStep(action) {
      if (!state || !state.lastPick) return;
      var sel = state.lastPick.css || '';
      if (!sel) return;
      if (!window.Views || typeof window.Views.addStep !== 'function') {
        toast(t('bv.copied'), 'info');
        return;
      }
      var step = action === 'extract'
        ? { action: 'extract', params: { selector: sel, name: 'value' } }
        : { action: 'click', params: { selector: sel } };
      window.Views.addStep(step);
      toast(t('bv.stepAdded'), 'success');
    }

    // Wire events.
    btnConnect.addEventListener('click', connect);
    btnDisconnect.addEventListener('click', disconnect);
    btnGo.addEventListener('click', go);
    btnPicker.addEventListener('click', togglePicker);
    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (state) go(); else connect(); }
    });
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    stage.addEventListener('keydown', onStageKey);
    canvas.addEventListener('mousedown', function () { stage.focus(); });
    root.querySelector('#bv-copy-css').addEventListener('click', function () { copyVal(cssIn); });
    root.querySelector('#bv-copy-xpath').addEventListener('click', function () { copyVal(xpathIn); });
    root.querySelector('#bv-add-click').addEventListener('click', function () { addStep('click'); });
    root.querySelector('#bv-add-extract').addEventListener('click', function () { addStep('extract'); });

    setStatus(t('bv.disconnected'), '');
  }

  // ══════════════════════════════════════════════════════════════════════
  // requestPick(onPicked, opts) — the crosshair button on any selector field.
  // ----------------------------------------------------------------------
  // Opens a modal that streams the real page and floats a small picker panel
  // over it (the shape Automa uses inside the target tab). Hovering previews,
  // clicking locks, ↑/↓ walk the DOM, the double-check button counts matches,
  // and "Use this selector" hands the string back to the caller's field.
  //
  // Deliberately a MODAL over our own app, not an injected panel: the page is
  // rendered by the server browser onto a <canvas>, so there is no page DOM
  // here to inject into — and our CSP (`script-src 'self'`) would forbid it.
  // ══════════════════════════════════════════════════════════════════════

  var pickState = null;          // { ws, overlay, onPicked, ... }
  var URL_MEMO = 'abPickerUrl';  // last page a selector was picked from

  function memoUrl(v) {
    try {
      if (v === undefined) return localStorage.getItem(URL_MEMO) || '';
      localStorage.setItem(URL_MEMO, v);
    } catch (e) {}
    return v || '';
  }

  function closePick() {
    if (!pickState) return;
    var ps = pickState;
    pickState = null;
    if (ps.stallTimer) { clearInterval(ps.stallTimer); ps.stallTimer = null; }
    // The nav-busy lease outlives the modal otherwise, and would fire a toast
    // about a window that is no longer on screen.
    if (ps.navBusyTimer) { clearTimeout(ps.navBusyTimer); ps.navBusyTimer = 0; }
    // Same rule for the heal lease and its per-step countdowns: both would
    // otherwise outlive the modal and either toast about a window that is gone or
    // rewrite a node that has been detached.
    if (ps.healTimer) { clearTimeout(ps.healTimer); ps.healTimer = 0; }
    if (ps.healEtaTimers) {
      ps.healEtaTimers.forEach(function (id) { clearTimeout(id); });
      ps.healEtaTimers = [];
    }
    if (ps.ws) { try { ps.ws.close(); } catch (e) {} }
    if (ps.rio) { try { ps.rio.detach(); } catch (e) {} }
    if (ps.onKeyDoc) document.removeEventListener('keydown', ps.onKeyDoc, true);
    // The re-clamp listener holds the overlay's DOM alive; drop it with the modal.
    if (ps.onResize) window.removeEventListener('resize', ps.onResize);
    if (ps.overlay && ps.overlay.parentNode) ps.overlay.parentNode.removeChild(ps.overlay);
  }

  function pickerMarkup() {
    return '' +
      '<div class="bvp-shell" role="dialog" aria-modal="true">' +
        '<div class="bvp-bar">' +
          '<span class="bvp-bar-title">' + BIC('target', 15) + ' ' + esc(t('bvp.title')) + '</span>' +
          // Real history controls. Without them "browse to the page you need"
          // was a one-way trip: the only way back was retyping the URL, which is
          // not a thing a browser makes you do — and following a link into the
          // wrong page is the normal cost of browsing.
          '<button class="icon-btn bvp-nav" id="bvp-back" type="button" ' +
            'title="' + esc(t('bvp.back')) + '" aria-label="' + esc(t('bvp.back')) + '">' +
            BIC('chevron-left', 15) + '</button>' +
          '<button class="icon-btn bvp-nav" id="bvp-fwd" type="button" ' +
            'title="' + esc(t('bvp.forward')) + '" aria-label="' + esc(t('bvp.forward')) + '">' +
            BIC('chevron-right', 15) + '</button>' +
          '<button class="icon-btn bvp-nav" id="bvp-reload" type="button" ' +
            'title="' + esc(t('bvp.reload')) + '" aria-label="' + esc(t('bvp.reload')) + '">' +
            BIC('rotate-cw', 15) + '</button>' +
          '<input class="field-input bvp-url" id="bvp-url" type="text" dir="ltr" ' +
            'placeholder="https://example.com" autocomplete="off" spellcheck="false">' +
          '<button class="btn btn-primary btn-sm" id="bvp-go">' + esc(t('bv.go')) + '</button>' +
          // ── Zoom ────────────────────────────────────────────────────────
          // Ctrl+ / Ctrl− / Ctrl+0 are wired on the stage as well, but the
          // buttons have to exist: the keyboard versions only work while the
          // canvas has focus, and someone who has just been reading a page at
          // 50% has no reason to know that. The percentage is shown because a
          // zoom you cannot read is a zoom you cannot undo — and because every
          // click coordinate is divided by it, a wrong number here is a page
          // where clicks land in the wrong place.
          '<span class="bvp-zoomgrp">' +
            '<button class="icon-btn bvp-zoomout" id="bvp-zoomout" type="button" ' +
              'title="' + esc(t('bvp.zoomOut')) + '" aria-label="' + esc(t('bvp.zoomOut')) + '">' +
              BIC('minus', 14) + '</button>' +
            '<button class="bvp-zoomlvl" id="bvp-zoomlvl" type="button" ' +
              'title="' + esc(t('bvp.zoomReset')) + '">100%</button>' +
            '<button class="icon-btn bvp-zoomin" id="bvp-zoomin" type="button" ' +
              'title="' + esc(t('bvp.zoomIn')) + '" aria-label="' + esc(t('bvp.zoomIn')) + '">' +
              BIC('plus', 14) + '</button>' +
          '</span>' +
          '<span class="badge bvp-status" id="bvp-status">—</span>' +
          // The session chip is the visible half of the persistent context. Once
          // cookies survive between opens, "is this browser signed in?" becomes a
          // question the user cannot answer by looking at the page (they may not
          // have navigated anywhere yet) — so the picker answers it, and offers
          // the way back out.
          '<span class="badge bvp-session" id="bvp-session"></span>' +
          '<button class="icon-btn bvp-forget" id="bvp-forget" type="button" ' +
            'title="' + esc(t('bvp.forget')) + '" aria-label="' + esc(t('bvp.forget')) + '">' +
            BIC('cookie', 15) + '</button>' +
          // Pull the REMOTE clipboard onto this machine. Ctrl+C already does
          // this from the keyboard, but the case that needs a button has no
          // keystroke at all: an extension's "Export" writes straight to the
          // server's clipboard with navigator.clipboard.writeText(), and
          // without this the copied text is stranded on a machine the user
          // cannot see.
          '<button class="icon-btn bvp-clip" id="bvp-clip" type="button" ' +
            'title="' + esc(t('rio.pull')) + '" aria-label="' + esc(t('rio.pull')) + '">' +
            BIC('clipboard', 15) + '</button>' +
          // Reconnect. NOT "close the window and reopen it", which is what the
          // user was reduced to when a cookie extension refreshed the page — and
          // that cost them the whole tab list every single time. This asks the
          // server to rebuild the screencast (and the page under it, if that is
          // what died) on the SAME socket, so the tabs and the picker state
          // survive.
          //
          // It needs to be a button because the failure it fixes is invisible:
          // the socket stays open, the status still says "connected", and the
          // canvas keeps showing a perfectly good last frame of a page that is
          // already gone.
          '<button class="icon-btn bvp-resync" id="bvp-resync" type="button" ' +
            'title="' + esc(t('bvp.reconnect')) + '" aria-label="' + esc(t('bvp.reconnect')) + '">' +
            BIC('plug', 15) + '</button>' +
          // Restart the real Chrome. This is a DIFFERENT button from Reconnect
          // and both have to exist, because they fix different things:
          //   Reconnect  — the stream/page died, Chrome itself is fine (cheap,
          //                keeps the tab list)
          //   Restart    — Chrome must be relaunched, because it only reads
          //                extensions at launch, so a newly installed extension
          //                is invisible until it restarts
          // Only Reconnect existed after the tab work landed, which left no way
          // to load an extension you had just installed without hunting for the
          // button inside the Real Chrome panel.
          // ── WHY NOT A POWER GLYPH ──────────────────────────────────────────
          // This button was drawn with `power`, and the report that followed was
          // "I pressed the OFF button and it got stuck starting Chrome" — the
          // user was not confused, the icon was wrong. `icons.js` itself aliases
          // both `close` and `close-browser` to `power`, so in this product that
          // glyph already MEANS "shut it down"; using it for a relaunch made a
          // restart look like an off switch, and then the checklist that appeared
          // looked like a malfunction rather than the thing they had asked for.
          // `repeat` is a loop — it says "again" — and it is deliberately not
          // `rotate-cw`, which the Reload button two positions away already uses.
          '<button class="icon-btn bvp-restart" id="bvp-restart" type="button" ' +
            'title="' + esc(t('bvp.restartBrowser')) + '" aria-label="' + esc(t('bvp.restartBrowser')) + '">' +
            BIC('repeat', 15) + '</button>' +
          // Real Chrome. The canvas below is a screencast of a PAGE, so it can
          // never show an extension popup, chrome://extensions or a native file
          // dialog — they are not drawn by the page. This button is the way out
          // of that ceiling: import a cookie export, load a real extension, or
          // open the whole Chrome window over noVNC.
          '<button class="icon-btn bvp-chrome" id="bvp-chrome" type="button" ' +
            'title="' + esc(t('rc.title')) + '" aria-label="' + esc(t('rc.title')) + '">' +
            BIC('layers', 15) + '</button>' +
          '<button class="icon-btn bvp-close" id="bvp-close" type="button" ' +
            'title="' + esc(t('bvp.cancel')) + '" aria-label="' + esc(t('bvp.cancel')) + '">' +
            BIC('x', 15) + '</button>' +
        '</div>' +
        // ── The tab strip ──────────────────────────────────────────────────
        // Class names are `bvp-tabstrip` / `bvp-tabitem`, NOT `bvp-tabs` /
        // `bvp-tab`: those two already belong to the Attributes|Candidates
        // tablist inside the panel, and reusing them would style one widget with
        // the other's rules.
        //
        // Rendered empty and filled from the server's `tabs` event, because the
        // list is the SERVER's state — it includes tabs restored from previous
        // sessions and tabs the page opened for itself, neither of which the
        // client could know about.
        '<div class="bvp-tabstrip" id="bvp-tabstrip" role="tablist" ' +
          'aria-label="' + esc(t('bvp.tabs')) + '">' +
          '<div class="bvp-tablist" id="bvp-tablist"></div>' +
          '<button class="icon-btn bvp-tabadd" id="bvp-tabadd" type="button" ' +
            'title="' + esc(t('bvp.newTab')) + '" aria-label="' + esc(t('bvp.newTab')) + '">' +
            BIC('plus', 14) + '</button>' +
        '</div>' +
        '<div class="bvp-stage" id="bvp-stage" tabindex="0">' +
          '<canvas class="bvp-canvas" id="bvp-canvas"></canvas>' +
          '<div class="bvp-empty" id="bvp-empty">' + esc(t('bvp.needUrl')) + '</div>' +
          // ── The page's own dialogs, and the 401 ──────────────────────────
          // These are drawn OVER the canvas, not beside it, because that is
          // where Chrome puts them: they belong to the page you are looking at
          // and they block it. Both are created empty and filled from the
          // server's event — the text of an `alert()` and the origin behind a
          // 401 are facts only the server has.
          //
          // They are rendered ALWAYS PRESENT and hidden with a class, never
          // built on demand: a modal that is constructed at the moment the
          // dialog arrives is a modal that can fail to appear, and a page
          // dialog that fails to appear is a tab locked forever with no
          // explanation — the exact bug being fixed.
          '<div class="bvp-modal is-off" id="bvp-dialog" role="alertdialog" aria-modal="true">' +
            '<div class="bvp-modal-card">' +
              '<div class="bvp-modal-head">' +
                '<span class="bvp-modal-icon" id="bvp-dlg-icon">' + BIC('message-square', 16) + '</span>' +
                '<span class="bvp-modal-title" id="bvp-dlg-title"></span>' +
              '</div>' +
              '<p class="bvp-modal-from" id="bvp-dlg-from"></p>' +
              // The page's text, in a <pre>-ish box. It is untrusted content, so
              // it goes in via textContent and gets no HTML.
              '<div class="bvp-modal-body" id="bvp-dlg-msg"></div>' +
              // Only a prompt() shows this.
              '<input class="field-input bvp-modal-input is-off" id="bvp-dlg-input" type="text" ' +
                'autocomplete="off" spellcheck="false">' +
              '<div class="bvp-modal-foot">' +
                '<button class="btn btn-ghost btn-sm" id="bvp-dlg-no"></button>' +
                '<button class="btn btn-primary btn-sm" id="bvp-dlg-yes"></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="bvp-modal is-off" id="bvp-auth" role="dialog" aria-modal="true">' +
            '<div class="bvp-modal-card">' +
              '<div class="bvp-modal-head">' +
                '<span class="bvp-modal-icon">' + BIC('lock', 16) + '</span>' +
                '<span class="bvp-modal-title" id="bvp-auth-title"></span>' +
              '</div>' +
              // WHO is asking. A password prompt that does not name the site is
              // a prompt a careful person should refuse, so the origin and the
              // realm are not decoration.
              '<p class="bvp-modal-from" id="bvp-auth-who"></p>' +
              '<p class="bvp-modal-from" id="bvp-auth-realm"></p>' +
              '<input class="field-input bvp-modal-input" id="bvp-auth-user" type="text" ' +
                'autocomplete="off" spellcheck="false" placeholder="' + esc(t('bvp.authUser')) + '" ' +
                'aria-label="' + esc(t('bvp.authUser')) + '">' +
              '<input class="field-input bvp-modal-input" id="bvp-auth-pass" type="password" ' +
                'autocomplete="off" placeholder="' + esc(t('bvp.authPass')) + '" ' +
                'aria-label="' + esc(t('bvp.authPass')) + '">' +
              '<p class="bvp-modal-note">' + esc(t('bvp.authNote')) + '</p>' +
              '<div class="bvp-modal-foot">' +
                '<button class="btn btn-ghost btn-sm" id="bvp-auth-no">' +
                  esc(t('bvp.authCancel')) + '</button>' +
                '<button class="btn btn-primary btn-sm" id="bvp-auth-yes">' +
                  esc(t('bvp.authOk')) + '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          // ── Self-healing progress ───────────────────────────────────────
          // The answer to "which restart? I pressed it and nothing happened."
          // The server now heals itself and reports every step; this panel is
          // where those steps are read out, with a measured ETA per step, so
          // the wait is never a blank screen.
          '<div class="bvp-heal is-off" id="bvp-heal" role="status" aria-live="polite">' +
            '<div class="bvp-heal-card">' +
              '<div class="bvp-heal-head">' +
                '<span class="bvp-heal-spin" id="bvp-heal-spin">' + BIC('loader', 16) + '</span>' +
                '<span class="bvp-heal-title">' + esc(t('bvp.healTitle')) + '</span>' +
                // A way out. This panel dims the canvas and reads as "blocked",
                // so with no close control the design leaned entirely on the
                // happy path: one request that never answered left the user
                // under a permanent "about 6 seconds" with nothing to press.
                // Dismissing does NOT cancel the restart — the server owns that
                // and finishes regardless — it only hands the window back.
                '<button class="icon-btn bvp-heal-close" id="bvp-heal-close" type="button" ' +
                  'title="' + esc(t('bvp.healDismiss')) + '" ' +
                  'aria-label="' + esc(t('bvp.healDismiss')) + '">' +
                  BIC('x', 14) + '</button>' +
              '</div>' +
              '<ol class="bvp-heal-steps" id="bvp-heal-steps"></ol>' +
              '<p class="bvp-heal-note">' + esc(t('bvp.healNote')) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="bvp-panel" id="bvp-panel">' +
            // An explicit grip. The whole head was already draggable, but nothing
            // SAID so — a `cursor: move` only appears once the pointer is already
            // on it, which is no help to someone hunting for a way to move the
            // panel off the element they are trying to click. Automa puts a
            // visible handle above the panel; so do we.
            '<div class="bvp-grip" id="bvp-drag" role="separator" ' +
              'title="' + esc(t('bvp.drag')) + '" aria-label="' + esc(t('bvp.drag')) + '">' +
              BIC('move', 13) + '</div>' +
            '<div class="bvp-panel-head">' +
              '<span class="bvp-panel-title">' + esc(t('bvp.title')) + '</span>' +
              '<button class="icon-btn bvp-eye" id="bvp-eye" type="button" ' +
                'aria-pressed="false" title="">' + BIC('eye', 14) + '</button>' +
              '<button class="icon-btn bvp-min-btn" id="bvp-min-btn" type="button" ' +
                'aria-expanded="true" title="' + esc(t('bvp.minimize', 'Minimize panel')) + '">' + BIC('chevron-down', 14) + '</button>' +
            '</div>' +
            // Which of the two modes you are in, spelled out. An icon-only
            // toggle that changes what every click does needs a label.
            '<div class="bvp-modeline" id="bvp-modeline"></div>' +
            '<div class="bvp-panel-row">' +
              '<select class="field-input bvp-mode" id="bvp-mode" ' +
                'aria-label="' + esc(t('bvp.mode')) + '">' +
                '<option value="css">' + esc(t('bvp.modeCss')) + '</option>' +
                '<option value="xpath">' + esc(t('bvp.modeXpath')) + '</option>' +
              '</select>' +
              '<button class="icon-btn" id="bvp-up" type="button" ' +
                'title="' + esc(t('bvp.parent')) + '">' + BIC('chevron-up', 14) + '</button>' +
              '<button class="icon-btn" id="bvp-down" type="button" ' +
                'title="' + esc(t('bvp.child')) + '">' + BIC('chevron-down', 14) + '</button>' +
            '</div>' +
            '<div class="bvp-panel-row">' +
              '<input class="field-input bvp-sel" id="bvp-sel" type="text" dir="ltr" ' +
                'spellcheck="false" autocomplete="off" ' +
                'placeholder="' + esc(t('bvp.selPlaceholder')) + '">' +
              '<button class="icon-btn" id="bvp-verify" type="button" ' +
                'title="' + esc(t('bvp.verify')) + '">' + BIC('check', 14) + '</button>' +
              '<button class="icon-btn" id="bvp-copy" type="button" ' +
                'title="' + esc(t('bvp.copy')) + '">' + BIC('copy', 14) + '</button>' +
            '</div>' +
            '<div class="bvp-count" id="bvp-count"></div>' +
            // Two tabs, like Automa's "Attributes | Blocks". Ours is
            // "Attributes | Candidates": a Blocks tab would mean building steps
            // from inside the picker, which is the flow builder's job (HANDOFF 15
            // § 2.3), whereas alternative selectors are the thing the user
            // actually needs here — Automa shows one selector and no match count,
            // so a brittle `:nth-of-type` path looks exactly like a good one.
            '<div class="bvp-tabs" role="tablist">' +
              '<button class="bvp-tab is-on" id="bvp-tab-attrs" type="button" ' +
                'role="tab" aria-selected="true" data-pane="attrs">' +
                esc(t('bvp.attributes')) + '</button>' +
              '<button class="bvp-tab" id="bvp-tab-cands" type="button" ' +
                'role="tab" aria-selected="false" data-pane="cands">' +
                esc(t('bvp.tabCandidates')) +
                '<span class="bvp-tab-n" id="bvp-cands-n"></span></button>' +
            '</div>' +
            // "#1 Element", plus the two facts that tell you whether you grabbed
            // what you meant: the tag name and the text inside it.
            '<div class="bvp-elhead" id="bvp-elhead"></div>' +
            '<div class="bvp-pane" id="bvp-pane-attrs" role="tabpanel">' +
              '<div class="bvp-attrs" id="bvp-attrs"></div>' +
            '</div>' +
            '<div class="bvp-pane is-off" id="bvp-pane-cands" role="tabpanel">' +
              '<div class="bvp-cands" id="bvp-cands"></div>' +
            '</div>' +
            '<div class="bvp-panel-foot">' +
              '<button class="btn btn-primary btn-sm" id="bvp-use">' +
                esc(t('bvp.use')) + '</button>' +
            '</div>' +
            // Automa's footer line. Keyboard control is invisible unless the UI
            // names the keys — and the keys only exist in select mode, so this
            // line is rewritten by `applySelectMode()` rather than fixed here.
            '<p class="bvp-kbd" id="bvp-kbd"></p>' +
          '</div>' +
        '</div>' +
        // ── The download shelf ────────────────────────────────────────────
        // Chrome's download bar: it appears at the BOTTOM of the window the
        // moment a download starts and stays until dismissed. Ours has to
        // exist at all, because the file lands on the SERVER's disk — without
        // a shelf, a download in this browser is a file the user can never
        // reach and never even learns about. Each row therefore ends in a
        // real fetch link, not just a name.
        '<div class="bvp-shelf is-off" id="bvp-shelf" role="region" ' +
          'aria-label="' + esc(t('bvp.dlShelf')) + '">' +
          '<span class="bvp-shelf-icon">' + BIC('download', 14) + '</span>' +
          '<div class="bvp-shelf-items" id="bvp-shelf-items"></div>' +
          '<button class="icon-btn bvp-shelf-clear" id="bvp-shelf-clear" type="button" ' +
            'title="' + esc(t('bvp.dlClearAll')) + '" aria-label="' + esc(t('bvp.dlClearAll')) + '">' +
            BIC('trash', 13) + '</button>' +
          '<button class="icon-btn bvp-shelf-upload" id="bvp-shelf-upload" type="button" ' +
            'title="Upload from your computer" aria-label="Upload from your computer">' +
            BIC('upload', 13) + '</button>' +
          '<button class="icon-btn bvp-shelf-hide" id="bvp-shelf-hide" type="button" ' +
            'title="' + esc(t('bvp.dlHide')) + '" aria-label="' + esc(t('bvp.dlHide')) + '">' +
            BIC('x', 13) + '</button>' +
        '</div>' +
        // ── Context menus ─────────────────────────────────────────────────
        // ONE host element, reused by both the page menu and the tab menu.
        // Chrome's real context menu is drawn by the browser process and can
        // never appear in a screencast of a page, so it has to be rebuilt in
        // HTML here — and it must be a sibling of the shell rather than a child
        // of the stage, so it can overhang the canvas edge instead of being
        // clipped by it (a menu opened near the bottom right that gets cut in
        // half is worse than no menu).
        '<div class="bvp-ctx is-off" id="bvp-ctx" role="menu"></div>' +
        // The anonymity note is NOT optional polish. Our picker drives a
        // server-side browser with a fresh, signed-out context, so every
        // selector behind a login is unreachable — and the only symptom is a
        // login wall where the user expected their own page. Saying it up front
        // is the difference between a limitation and a bug report.
        // (HANDOFF 15 § 6.1 `AUTH-GAP`; the real fix is session reuse or the
        // extension, neither of which has landed.)
        // Filled in by setSession() once the server says whether it restored a
        // saved session: claiming "fresh, signed-out browser" would now be a LIE
        // half the time, and a UI that lies about auth state is worse than one
        // that says nothing.
        '<p class="bvp-hint">' + esc(t('bvp.hint')) +
          ' <span class="bvp-anon" id="bvp-anon"></span></p>' +
      '</div>';
  }

  function requestPick(onPicked, opts) {
    if (typeof onPicked !== 'function') return;
    closePick();
    var o = opts || {};

    var overlay = document.createElement('div');
    overlay.className = 'bvp-backdrop';
    overlay.innerHTML = pickerMarkup();
    document.body.appendChild(overlay);

    var q = function (id) { return overlay.querySelector('#' + id); };
    var urlIn = q('bvp-url');
    var canvas = q('bvp-canvas');
    var stage = q('bvp-stage');
    var empty = q('bvp-empty');
    var statusB = q('bvp-status');
    var panel = q('bvp-panel');
    var modeSel = q('bvp-mode');
    var selIn = q('bvp-sel');
    var countEl = q('bvp-count');
    var attrsEl = q('bvp-attrs');
    var candsEl = q('bvp-cands');
    var elHead = q('bvp-elhead');
    var sessEl = q('bvp-session');
    var anonEl = q('bvp-anon');
    var ctx = canvas.getContext('2d');

    pickState = {
      ws: null, overlay: overlay, onPicked: onPicked,
      last: null,      // last payload (hover or pick)
      locked: false,   // a click/traversal happened → stop following the pointer
      edited: false,   // the user typed in the field → stop overwriting it
      mode: (o.mode === 'xpath' ? 'xpath' : 'css'),
      // Element-selection mode is OFF at open: this window is a real browser
      // first. You almost always have to get somewhere before there is anything
      // worth picking — sign in, open a menu, expand a row — and none of that is
      // possible while every click is being converted into a pick.
      selectMode: false,
      signedIn: false, // set from the server's `ready` frame, never assumed
      pendingUrl: '',  // first URL to load, sent once the server says 'ready'
      rio: null,       // clipboard + file bridge, created with the socket
      // The tab strip, mirrored from the server. The SERVER owns this list: it
      // holds tabs restored from previous sessions and tabs the page opened for
      // itself, neither of which the client could have known about.
      tabs: [],
      activeTab: '',
      // Frame-stall detection, so a dead browser is noticed without the user
      // having to guess that the still image in front of them is stale.
      lastFrameAt: 0,
      stallTimer: null,
      recovering: false,
      // When we last asked the server "are you actually alive?" (stage one of
      // the stall watchdog). 0 = no question outstanding.
      pingSentAt: 0,
      onKeyDoc: null,
      onResize: null,
      // ── Zoom ──────────────────────────────────────────────────────────
      // The server zooms with Emulation.setDeviceMetricsOverride, which is
      // REAL browser zoom: the viewport gets smaller in CSS pixels and the
      // page reflows. The screencast frames stay the same pixel size, so a
      // canvas coordinate is `cssPixel * zoom` and every click must be divided
      // by this number on the way out. Measured in both directions: skip the
      // division and at 150% every click lands a third of the way up and left
      // of where the user aimed.
      zoom: 1,
      // ── Navigation ────────────────────────────────────────────────────
      // Whether Back/Forward would DO anything, straight from the server's
      // real Page.getNavigationHistory. Before this the arrows were always
      // enabled, so Back on the first page of a tab looked like a broken
      // button — which is exactly what was reported.
      canBack: false,
      canFwd: false,
      navBusy: false,
      // The lease that guarantees `navBusy` can never be permanent. 0 = no
      // navigation outstanding. See setNavBusy for why an optimistic busy state
      // MUST expire on its own.
      navBusyTimer: 0,
      // ── The heal panel's leases ───────────────────────────────────────
      // The same invariant as `navBusyTimer`, applied to the "getting the browser
      // ready" panel: it is raised optimistically on a press, so it MUST be able
      // to take itself down. `healTimer` bounds the whole panel; `healEtaTimers`
      // hold the per-step "the estimate has elapsed, stop quoting a number"
      // countdowns, which are a list because a heal reports several steps.
      healTimer: 0,
      healEtaTimers: [],
      // ── Drag, on the canvas ───────────────────────────────────────────
      // A real mousedown→mousemove→mouseup, which is what text selection,
      // sliders and drag & drop are all made of. `null` when the button is up.
      dragFrom: null,
      dragLast: null,
      // ── Tab strip ─────────────────────────────────────────────────────
      tabDragId: '',       // the tab currently being carried
      tabDragOver: -1,     // the slot it would land in
      // ── Page dialogs / auth ───────────────────────────────────────────
      dialog: null,        // the dialog currently on screen
      auth: null,          // the credentials request currently on screen
      // ── Downloads ─────────────────────────────────────────────────────
      // Keyed by id so a progress event updates the row that is already there
      // instead of appending a second copy of the same file.
      downloads: [],
      shelfHidden: false,
      // ── Self-healing ──────────────────────────────────────────────────
      healSteps: [],
      // ── Context menu ──────────────────────────────────────────────────
      ctxOpen: false
    };
    modeSel.value = pickState.mode;
    // Seed the field with whatever the caller's input already held, so the
    // picker refines an existing selector instead of blanking it.
    if (o.value) { selIn.value = String(o.value); pickState.edited = true; }
    urlIn.value = o.url || memoUrl();

    function setStatus(label, cls) {
      statusB.className = 'badge bvp-status ' + (cls || '');
      statusB.textContent = label;
    }

    /**
     * Grey out an arrow that would do nothing, and show that a navigation is in
     * flight. Both halves come from the server's real history, never guessed:
     * the client cannot know whether a page pushed history entries of its own.
     *
     * Reload turns into a spinner-ish busy state while loading, because the
     * complaint that "reload doesn't work" is usually a reload that DID work on
     * a slow page with nothing on screen to prove it.
     */
    function applyNavState() {
      var b = q('bvp-back');
      var f = q('bvp-fwd');
      var r = q('bvp-reload');
      if (b) {
        b.disabled = !pickState.canBack;
        b.classList.toggle('is-dim', !pickState.canBack);
      }
      if (f) {
        f.disabled = !pickState.canFwd;
        f.classList.toggle('is-dim', !pickState.canFwd);
      }
      if (r) r.classList.toggle('is-busy', !!pickState.navBusy);
    }

    /**
     * Mark a navigation as in flight — and guarantee the mark can come off again.
     *
     * `navBusy` is set OPTIMISTICALLY the moment a button is pressed, so the click
     * is acknowledged on the next frame instead of whenever the server gets round
     * to `navStart`. The cost of that is a state only the server can clear, and
     * MEASURED 2026-08-03 (tools/probe-ui-controls.js) it really did stick: drop
     * the nav command on the wire and none of `navStart`/`navEnd`/`navBlocked`
     * ever arrives, so the spinner spun forever and the toolbar LOOKED hung while
     * the session was perfectly alive. That is the same "dead but connected" lie
     * the whole browser-parity effort exists to remove, and the project's
     * no-restart mandate says the UI must correct itself rather than sit there.
     *
     * So the busy state is always a LEASE, never a promise: whatever happens on
     * the wire, it expires. There are TWO different waits here and one timeout
     * cannot serve both, which is why `phase` exists:
     *
     *   'press' — we have sent a command and not yet been acknowledged. The only
     *             thing outstanding is a round trip on an open socket, so this is
     *             SHORT (6s). Anything longer means the command was lost, and
     *             making the user stare at a spinner for half a minute to learn
     *             that is the bug, not the fix.
     *   'server' — `navStart` arrived, so the server really is loading a page and
     *             owns a 30s timeout of its own. The lease is longer than that
     *             (35s) so a genuinely slow page keeps its spinner and only a
     *             server that died mid-navigation trips it.
     */
    function setNavBusy(on, phase) {
      pickState.navBusy = !!on;
      if (pickState.navBusyTimer) {
        clearTimeout(pickState.navBusyTimer);
        pickState.navBusyTimer = 0;
      }
      if (on) {
        pickState.navBusyTimer = setTimeout(function () {
          if (!pickState) return;
          pickState.navBusyTimer = 0;
          pickState.navBusy = false;
          applyNavState();
          // Say something. A spinner that quietly gives up teaches the user that
          // the button does nothing; naming it as a lost request tells them the
          // truth and that pressing again is the right move.
          toast(t('bvp.navLost'), 'warning');
        }, phase === 'server' ? 35000 : 6000);
      }
      applyNavState();
    }

    /** Show the zoom, and remember it: every click coordinate divides by it. */
    function setZoomLabel(level) {
      var z = Number(level) || 1;
      pickState.zoom = z;
      var el = q('bvp-zoomlvl');
      if (el) {
        el.textContent = Math.round(z * 100) + '%';
        // Mark a non-default zoom. A page at 67% that looks merely "small" is a
        // page the user will try to fix by resizing the window forever.
        el.classList.toggle('is-off-default', Math.abs(z - 1) > 0.001);
      }
    }

    function send(obj) {
      var ps = pickState;
      if (ps && ps.ws && ps.ws.readyState === WebSocket.OPEN) {
        try { ps.ws.send(JSON.stringify(obj)); } catch (e) {}
      }
    }
    /**
     * A canvas event -> a coordinate the PAGE will agree with.
     *
     * Two corrections, and both are required:
     *
     *  1. CSS size -> frame size. The canvas is laid out to fit the stage but
     *     its backing store is whatever size the screencast sends, so a click
     *     at the visual centre is not at `frameWidth/2` unless we scale.
     *
     *  2. Frame size -> page CSS pixels, i.e. divide by zoom. The server zooms
     *     with `Emulation.setDeviceMetricsOverride`, which shrinks the viewport
     *     in CSS pixels while the frames keep their pixel size. Measured: at
     *     150% zoom, without this division every click lands about a third of
     *     the way up and to the left of the target. A browser where the pointer
     *     lies is not a browser, so this is not an optimisation.
     */
    function toPoint(ev) {
      var rect = canvas.getBoundingClientRect();
      var sx = canvas.width / rect.width || 1;
      var sy = canvas.height / rect.height || 1;
      var z = pickState.zoom || 1;
      return {
        x: (ev.clientX - rect.left) * sx / z,
        y: (ev.clientY - rect.top) * sy / z
      };
    }

    /**
     * The four modifier flags, in the shape the server's `mods()` normaliser
     * expects. Sent with EVERY mouse and key event rather than only when one is
     * held, because a missing field and `false` have to mean the same thing on
     * the wire — otherwise Ctrl+Click works and plain click silently inherits
     * the last Ctrl state.
     */
    function modsOf(ev) {
      return {
        ctrl: !!ev.ctrlKey, shift: !!ev.shiftKey,
        alt: !!ev.altKey, meta: !!ev.metaKey
      };
    }

    /** Which mouse button, in CDP's vocabulary. Middle-click matters: it is how
     *  Chrome opens a link in a background tab and how it closes a tab. */
    function buttonOf(ev) {
      return ev.button === 1 ? 'middle' : (ev.button === 2 ? 'right' : 'left');
    }
    function selectorOf(data) {
      if (!data) return '';
      return pickState.mode === 'xpath' ? (data.xpath || '') : (data.css || '');
    }
    function renderCount(n, invalid) {
      if (n === undefined || n === null) { countEl.textContent = ''; countEl.className = 'bvp-count'; return; }
      if (invalid || n < 0) {
        countEl.textContent = t('bvp.matchBad');
        countEl.className = 'bvp-count is-bad';
      } else if (n === 0) {
        countEl.textContent = t('bvp.matchNone');
        countEl.className = 'bvp-count is-bad';
      } else if (n === 1) {
        countEl.textContent = t('bvp.matchOne');
        countEl.className = 'bvp-count is-ok';
      } else {
        countEl.textContent = String(n) + ' ' + t('bvp.matchMany');
        countEl.className = 'bvp-count is-warn';
      }
    }
    function emptyNote(host, text) {
      host.innerHTML = '';
      // Deliberately NOT an attribute row: the empty state is prose, and reusing
      // the row made it inherit the blue monospace styling that marks a real
      // attribute key.
      var msg = document.createElement('div');
      msg.className = 'bvp-attr-empty';
      msg.textContent = text;
      host.appendChild(msg);
    }
    // An attribute CARD (Automa's shape): the name is a small label above, the
    // value sits in a boxed field with its own copy button. Two reasons this
    // beats the old single-line key/value row:
    //   * the value gets the full panel width instead of 60% of it, so
    //     `jslog="21578; u014N:cOuCgd,Kr2v"` stops being an ellipsis;
    //   * copy is per-attribute. Copying the selector was already one click;
    //     copying an `aria-label` off the page meant re-typing it by eye.
    // Clicking the box itself offers `tag[name="value"]` as the selector, which
    // is how a human actually decides ("the one with data-testid=submit").
    function attrCard(a) {
      var card = document.createElement('div');
      card.className = 'bvp-attr';

      var label = document.createElement('div');
      label.className = 'bvp-attr-name';
      label.textContent = a.name;
      card.appendChild(label);

      var box = document.createElement('div');
      box.className = 'bvp-attr-box';

      var cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'icon-btn bvp-attr-copy';
      cp.title = t('bvp.copyValue');
      cp.setAttribute('aria-label', t('bvp.copyValue') + ': ' + a.name);
      cp.innerHTML = BIC('copy', 13);
      cp.addEventListener('click', function (ev) {
        ev.stopPropagation();          // do not also "use as selector"
        copyText(a.value);
      });
      box.appendChild(cp);

      var v = document.createElement('span');
      v.className = 'bvp-attr-value';
      v.textContent = a.value;
      // Long values still ellipsise at 306px; the tooltip is the only way to read
      // one in full without copying it out first.
      v.title = a.value;
      box.appendChild(v);

      // Offer the attribute as a selector. Only meaningful in CSS mode — there is
      // no honest one-line XPath translation to hand back, so we say why instead
      // of silently doing nothing.
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', t('bvp.useAttr') + ': ' + a.name);
      box.addEventListener('click', function () {
        if (pickState.mode !== 'css') { toast(t('bvp.attrCssOnly'), 'info'); return; }
        var tag = (pickState.last && pickState.last.tag) || '';
        selIn.value = tag + '[' + a.name + '=' + JSON.stringify(a.value) + ']';
        pickState.edited = true;
        send({ t: 'verify', selector: selIn.value });   // never guess the count
      });
      card.appendChild(box);
      return card;
    }
    function renderAttrs(list) {
      if (!list || !list.length) { emptyNote(attrsEl, t('bvp.noAttrs')); return; }
      attrsEl.innerHTML = '';
      list.forEach(function (a) { attrsEl.appendChild(attrCard(a)); });
    }
    // Alternative selectors for the locked element, each with its own match
    // count. This is the tab Automa does not have, and the answer to § 6.5:
    // the generated path may be a `:nth-of-type` chain that breaks on the next
    // deploy, while `[data-testid=…]` is sitting right there.
    function renderCands(list) {
      var n = q('bvp-cands-n');
      n.textContent = list && list.length ? String(list.length) : '';
      if (!list || !list.length) { emptyNote(candsEl, t('bvp.noCands')); return; }
      candsEl.innerHTML = '';
      list.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'bvp-cand';
        // The full selector, because the row ellipsises: a 306px panel clipped
        // `div[aria-label="Compose a new message"]` by 22px (measured), and a
        // selector you cannot read is a selector you cannot choose.
        b.title = c.sel;
        b.setAttribute('aria-label', t('bvp.candUse') + ': ' + c.sel);

        var s = document.createElement('span');
        s.className = 'bvp-cand-sel';
        s.textContent = c.sel;
        b.appendChild(s);

        // Rule 0.10: never show a selector without saying how many it matches.
        var badge = document.createElement('span');
        badge.className = 'bvp-cand-n ' + (c.count === 1 ? 'is-ok' : 'is-warn');
        badge.textContent = c.count === 1 ? '1' : String(c.count);
        b.appendChild(badge);

        b.addEventListener('click', function () {
          selIn.value = c.sel;
          pickState.edited = true;
          renderCount(c.count);
          send({ t: 'verify', selector: c.sel });
        });
        candsEl.appendChild(b);
      });
    }
    // "#2 of 7  <a>  Save changes" — index, tag, text. `index`/`count` come from
    // the page, so the header can be honest about ambiguity where Automa's bare
    // "#1 Element" cannot.
    function renderElHead(data) {
      elHead.innerHTML = '';
      if (!data || !data.tag) return;
      var idx = document.createElement('span');
      idx.className = 'bvp-el-idx';
      if (data.index > 0 && data.count > 1) {
        idx.textContent = tf('bvp.elementIndexOf', { n: data.index, c: data.count });
      } else {
        idx.textContent = tf('bvp.elementIndex', { n: data.index > 0 ? data.index : 1 });
      }
      elHead.appendChild(idx);

      var tag = document.createElement('code');
      tag.className = 'bvp-el-tag';
      tag.textContent = '<' + data.tag + '>';
      elHead.appendChild(tag);

      if (data.text) {
        var txt = document.createElement('span');
        txt.className = 'bvp-el-text';
        txt.textContent = data.text;
        txt.title = data.text;
        elHead.appendChild(txt);
      }
    }
    function setPane(which) {
      var on = which === 'cands' ? 'cands' : 'attrs';
      ['attrs', 'cands'].forEach(function (p) {
        q('bvp-pane-' + p).classList.toggle('is-off', p !== on);
        var tab = q('bvp-tab-' + p);
        tab.classList.toggle('is-on', p === on);
        tab.setAttribute('aria-selected', p === on ? 'true' : 'false');
      });
    }
    /**
     * The one place that decides what a click means.
     *
     * `selectMode === false` (the default) is a REAL BROWSER: no picker script
     * is injected, so the CDP mouse/keyboard events reach the page unmodified —
     * links open, buttons submit, inputs receive text, and nothing is outlined.
     * The panel drops to 55% opacity because in that mode it is furniture in
     * front of the page you are trying to use, and it is not doing anything.
     *
     * `selectMode === true` is the picker: the page-side script is injected, so
     * hover outlines the element under the pointer and a click is swallowed and
     * reported as a pick instead of being delivered to the page. That swallowing
     * is the whole point of the mode — and the reason it must not be permanent.
     *
     * @param {boolean} on
     * @param {boolean} [quiet] skip the toast (used for the initial apply)
     */
    function applySelectMode(on, quiet) {
      var ps = pickState;
      if (!ps) return;
      ps.selectMode = !!on;
      send({ t: 'picker', on: ps.selectMode });
      // Leaving select mode also drops whatever the outline was pinned to; the
      // stale "#1 Element" panel would otherwise describe a page you have since
      // navigated away from.
      if (!ps.selectMode) ps.locked = false;

      var eye = q('bvp-eye');
      eye.classList.toggle('is-on', ps.selectMode);
      eye.setAttribute('aria-pressed', ps.selectMode ? 'true' : 'false');
      eye.title = ps.selectMode ? t('bvp.selectOff') : t('bvp.selectOn');
      eye.setAttribute('aria-label', eye.title);
      panel.classList.toggle('is-browse', !ps.selectMode);
      panel.classList.toggle('is-locked', ps.selectMode && ps.locked);
      canvas.classList.toggle('is-picking', ps.selectMode);

      var line = q('bvp-modeline');
      line.className = 'bvp-modeline ' + (ps.selectMode ? 'is-select' : 'is-browse');
      line.textContent = ps.selectMode ? t('bvp.inSelect') : t('bvp.inBrowse');

      var kbd = q('bvp-kbd');
      if (ps.selectMode) {
        kbd.innerHTML = esc(t('bvp.kbdClick')) + ' <kbd>Space</kbd> ' +
          esc(t('bvp.kbdLock')) + ' · <kbd>↑</kbd><kbd>↓</kbd> ' + esc(t('bvp.kbdWalk'));
      } else {
        kbd.textContent = t('bvp.kbdBrowse');
      }
      if (!quiet) toast(ps.selectMode ? t('bvp.selectedOn') : t('bvp.selectedOff'), 'info');
    }

    // Reports what the server told us about the persistent context, and keeps
    // the disclosure paragraph in sync with it.
    function setSession(signedIn) {
      pickState.signedIn = !!signedIn;
      sessEl.textContent = signedIn ? t('bvp.sessionSaved') : t('bvp.sessionAnon');
      sessEl.className = 'badge bvp-session ' + (signedIn ? 'ok' : '');
      anonEl.textContent = signedIn ? t('bvp.savedNote') : t('bvp.anonNote');
      q('bvp-forget').disabled = !signedIn;
    }
    // ── Tab strip ─────────────────────────────────────────────────────────
    // Redrawn wholesale from the server's `tabs` event. Wholesale rather than
    // diffed because the list is short (capped at 12) and the states that have
    // to show — active, `pending` (restored from a previous session, not loaded
    // yet), `dead` — change together far more often than individually.
    function tabLabel(tab) {
      var title = String(tab.title || '').trim();
      var url = String(tab.url || '');
      if (title && title !== url) return title;
      if (!url || url === 'about:blank') return t('bvp.blankTab');
      // No host is better than a 300-character URL in a 140px chip.
      try { return new URL(url).hostname || url; } catch (e) { return url; }
    }
    function renderTabs(list, activeId) {
      var host = q('bvp-tablist');
      if (!host) return;
      pickState.tabs = Array.isArray(list) ? list : [];
      pickState.activeTab = String(activeId || '');
      host.innerHTML = '';
      // The strip is ALWAYS visible, exactly like Chrome's. Hiding it while
      // there was only one tab was a real dead end and not a space saving: the
      // + button lives in the strip, so "hide until there are two tabs" left no
      // way to ever CREATE the second tab. A browser you cannot open a tab in
      // is not a browser.

      // Chrome-like widths, done with flex maths rather than a fixed size.
      // Chrome stretches tabs to fill the strip while there are few, then
      // shrinks them evenly once there are many, down to a floor where only the
      // favicon and the X remain. Reproduced here by handing every item the same
      // `flex: 1 1 0` and setting a max-width that falls as the count rises —
      // so two tabs are wide and comfortable, ten are narrow but still all
      // visible, and none of them ever scroll out of reach.
      var n = pickState.tabs.length || 1;
      var maxW = n <= 2 ? 240 : (n <= 4 ? 200 : (n <= 6 ? 168 : (n <= 9 ? 132 : 104)));
      host.style.setProperty('--bvp-tabmax', maxW + 'px');

      pickState.tabs.forEach(function (tab, slot) {
        var item = document.createElement('div');
        item.className = 'bvp-tabitem'
          + (tab.active ? ' is-on' : '')
          + (tab.pending ? ' is-pending' : '')
          + (tab.dead ? ' is-dead' : '')
          + (tab.loading ? ' is-loading' : '')
          + (tab.pinned ? ' is-pinned' : '')
          + (pickState.tabDragId === tab.id ? ' is-dragging' : '')
          + (pickState.tabDragOver === slot ? ' is-dropslot' : '');
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', tab.active ? 'true' : 'false');
        item.setAttribute('data-tabid', tab.id);
        item.setAttribute('data-slot', String(slot));
        // Drag to reorder. HTML5 drag-and-drop is deliberately NOT used: it
        // needs a drag image and fires no event while the pointer is between
        // slots, so the tab you are carrying disappears and nothing shows you
        // where it will land. Pointer events give both.
        item.draggable = false;

        // ── The favicon slot, which doubles as the loading spinner ────────
        // Chrome replaces the favicon with a spinning arc while the tab loads,
        // and that swap is the whole point: one slot answers both "which site
        // is this?" and "is it still working?". Two separate slots would make
        // every tab wider for no gain.
        var mark = document.createElement('span');
        mark.className = 'bvp-tabmark';
        if (tab.loading) {
          mark.classList.add('is-spin');
          mark.innerHTML = BIC('loader', 12);
          mark.title = t('bvp.tabLoading');
        } else if (tab.favicon) {
          var fav = document.createElement('img');
          fav.className = 'bvp-tabfav';
          fav.alt = '';
          fav.src = tab.favicon;
          // A site whose favicon 404s must not leave a broken-image glyph in
          // the strip; fall back to the generic globe, like Chrome does.
          fav.addEventListener('error', function () {
            mark.innerHTML = BIC('globe', 12);
          });
          mark.appendChild(fav);
        } else {
          mark.innerHTML = BIC('globe', 12);
        }
        item.appendChild(mark);

        var label = document.createElement('button');
        label.type = 'button';
        label.className = 'bvp-tabname';
        label.textContent = tabLabel(tab);
        // The full URL belongs in the tooltip: it is the only place the user can
        // tell two chips from the same host apart.
        label.title = tab.pending
          ? (String(tab.url || '') + ' — ' + t('bvp.tabPending'))
          : String(tab.url || '');
        label.addEventListener('click', function () {
          if (tab.active) return;
          send({ t: 'tabSelect', id: tab.id });
        });
        item.appendChild(label);

        // ── The audio indicator ──────────────────────────────────────────
        // Chrome shows a speaker on any tab that is making noise, and clicking
        // it mutes that tab. Both halves matter: the icon answers "which of my
        // nine tabs is the advert in?", and it being a BUTTON means the answer
        // is actionable without first switching to the tab — which is the only
        // reason anyone looks for it.
        if (tab.audible || tab.muted) {
          var snd = document.createElement('button');
          snd.type = 'button';
          snd.className = 'icon-btn bvp-tabsound' + (tab.muted ? ' is-muted' : '');
          snd.title = tab.muted ? t('bvp.tabMuted') : t('bvp.tabAudible');
          snd.setAttribute('aria-label', snd.title);
          snd.innerHTML = BIC(tab.muted ? 'volume-x' : 'volume', 11);
          snd.addEventListener('click', function (ev) {
            ev.stopPropagation();
            send({ t: 'tabMute', id: tab.id, muted: !tab.muted });
          });
          item.appendChild(snd);
        }

        // A pinned tab keeps its pin visible and loses its X, exactly like
        // Chrome: the point of pinning is that the tab is hard to close by
        // accident. The close route still exists through the context menu.
        if (tab.pinned) {
          var pin = document.createElement('span');
          pin.className = 'bvp-tabpin';
          pin.title = t('bvp.tabPinned');
          pin.innerHTML = BIC('pin', 11);
          item.appendChild(pin);
        } else {
          var kill = document.createElement('button');
          kill.type = 'button';
          kill.className = 'icon-btn bvp-tabkill';
          kill.title = t('bvp.closeTab');
          kill.setAttribute('aria-label', t('bvp.closeTab'));
          kill.innerHTML = BIC('x', 11);
          kill.addEventListener('click', function (ev) {
            ev.stopPropagation();   // closing a tab must not also select it
            send({ t: 'tabClose', id: tab.id });
          });
          item.appendChild(kill);
        }

        // Middle-click closes, anywhere on the chip. This is muscle memory for
        // anyone who uses tabs at all, and it is also the only comfortable way
        // to close several tabs in a row: the X moves as the strip re-flows,
        // the chip under the pointer does not.
        item.addEventListener('mousedown', function (ev) {
          if (ev.button === 1) {
            ev.preventDefault();          // stop the browser's autoscroll cursor
            send({ t: 'tabClose', id: tab.id });
            return;
          }
          if (ev.button !== 0) return;
          beginTabDrag(ev, tab.id, slot);
        });
        item.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          openTabMenu(ev.clientX, ev.clientY, tab, slot);
        });

        host.appendChild(item);
      });
    }

    // ── Dragging a tab to a new slot ──────────────────────────────────────
    // Pointer-driven, and the drop target is computed from the MIDPOINT of each
    // chip rather than from its edges. Using edges leaves a dead zone between
    // every pair of tabs where the carried tab shows no destination at all,
    // which reads as a broken drag; midpoints mean the pointer is always over
    // exactly one answer.
    function beginTabDrag(ev, id, slot) {
      var startX = ev.clientX;
      var moved = false;
      var host = q('bvp-tablist');
      if (!host) return;

      function slotAt(clientX) {
        var chips = host.querySelectorAll('.bvp-tabitem');
        for (var i = 0; i < chips.length; i++) {
          var r = chips[i].getBoundingClientRect();
          if (clientX < r.left + r.width / 2) return i;
        }
        return chips.length - 1;
      }
      function onMove(m) {
        // A 4px threshold, so an ordinary click to switch tabs is never
        // mistaken for a one-pixel drag that reorders the strip.
        if (!moved && Math.abs(m.clientX - startX) < 4) return;
        if (!moved) { moved = true; pickState.tabDragId = id; }
        pickState.tabDragOver = slotAt(m.clientX);
        renderTabs(pickState.tabs, pickState.activeTab);
      }
      function onUp(u) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        var target = moved ? slotAt(u.clientX) : -1;
        pickState.tabDragId = '';
        pickState.tabDragOver = -1;
        if (moved && target >= 0 && target !== slot) {
          send({ t: 'tabMove', id: id, index: target });
          return;
        }
        // Only redraw if a drag actually STARTED. Redrawing after an ordinary
        // press was a real dead-button bug.
        //
        // MEASURED 2026-08-03 (tools/probe-ui-controls.js): pressing a tab's X
        // sent no `tabClose` at all and the tab stayed open. The reason is that
        // `mouseup` fires BEFORE `click`, and this branch used to redraw the
        // whole strip unconditionally — so by the time the browser came to
        // dispatch `click`, the X element that had been pressed was detached
        // and replaced by a fresh copy that had never seen a mousedown. The
        // click therefore had no target and the listener never ran. The X, the
        // mute button and every other control inside a chip were all silently
        // un-clickable, while the wiring looked perfect in the source and the
        // protocol probe (which never clicks anything) stayed green.
        //
        // A press that never moved has nothing to clean up: `tabDragId` was
        // never set, so there is no drag styling on screen to clear.
        if (moved) renderTabs(pickState.tabs, pickState.activeTab);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Context menus
    // ══════════════════════════════════════════════════════════════════════
    // Chrome's context menu is drawn by the browser process, so it can never
    // appear in a screencast of a page. It is rebuilt here in HTML and each
    // entry sends a real command, so the menu is not a mock-up: "Reload" does
    // the same reload the toolbar button does.
    //
    // Built from a plain array of `{ label, icon, run, off }` so the tab menu
    // and the page menu share one renderer, one keyboard model and one
    // dismissal rule. A second implementation would drift.

    function closeCtx() {
      var host = q('bvp-ctx');
      if (!host) return;
      host.classList.add('is-off');
      host.innerHTML = '';
      pickState.ctxOpen = false;
    }

    function openCtx(clientX, clientY, items) {
      var host = q('bvp-ctx');
      if (!host) return;
      host.innerHTML = '';
      var live = items.filter(function (it) { return it && !it.off; });
      // Collapse separators. The page menu is built from many conditional
      // sections (link, image, media, selection), so whenever a whole section
      // is switched off its separator survives on its own — and two rules with
      // nothing between them, or a rule at the very top or bottom, reads as a
      // rendering bug. Chrome does exactly this collapsing too.
      live = live.filter(function (it, i, arr) {
        if (!it.sep) return true;
        // Drop a leading separator, and any that follows another separator.
        // Looking at the ORIGINAL array is correct: a separator only survives
        // when the entry before it is a real item, so a run of separators
        // keeps its first and drops the rest.
        if (i === 0 || arr[i - 1].sep) return false;
        // Drop a trailing separator: nothing but separators after this one.
        for (var j = i + 1; j < arr.length; j++) if (!arr[j].sep) return true;
        return false;
      });
      if (!live.length) return;

      live.forEach(function (it) {
        if (it.sep) {
          var hr = document.createElement('div');
          hr.className = 'bvp-ctx-sep';
          host.appendChild(hr);
          return;
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'bvp-ctx-item' + (it.disabled ? ' is-disabled' : '');
        b.setAttribute('role', 'menuitem');
        if (it.disabled) b.disabled = true;
        var ic = document.createElement('span');
        ic.className = 'bvp-ctx-icon';
        ic.innerHTML = it.icon ? BIC(it.icon, 13) : '';
        var tx = document.createElement('span');
        tx.className = 'bvp-ctx-label';
        tx.textContent = it.label;
        b.appendChild(ic);
        b.appendChild(tx);
        b.addEventListener('click', function () {
          closeCtx();
          try { it.run(); } catch (e) {}
        });
        host.appendChild(b);
      });

      // Place it, then pull it back inside the window. A menu opened near the
      // right or bottom edge that runs off-screen is a menu whose last two
      // items cannot be clicked — and the interesting items are usually at the
      // bottom, so this is not a cosmetic detail.
      host.classList.remove('is-off');
      host.style.left = '0px';
      host.style.top = '0px';
      var r = host.getBoundingClientRect();
      var x = Math.min(clientX, window.innerWidth - r.width - 6);
      var y = Math.min(clientY, window.innerHeight - r.height - 6);
      host.style.left = Math.max(6, x) + 'px';
      host.style.top = Math.max(6, y) + 'px';
      pickState.ctxOpen = true;
    }

    /** The tab strip's right-click menu, with Chrome's exact set. */
    function openTabMenu(clientX, clientY, tab, slot) {
      var many = pickState.tabs.length > 1;
      var rightOf = pickState.tabs.length - 1 > slot;
      openCtx(clientX, clientY, [
        { label: t('bvp.newTab'), icon: 'plus', run: function () { newTab(); } },
        { label: t('bvp.tabDuplicate'), icon: 'copy',
          run: function () { send({ t: 'tabDuplicate', id: tab.id }); } },
        { label: tab.pinned ? t('bvp.tabUnpin') : t('bvp.tabPin'), icon: 'pin',
          run: function () { send({ t: 'tabPin', id: tab.id, pinned: !tab.pinned }); } },
        { label: tab.muted ? t('bvp.tabMuted') : t('bvp.tabAudible'),
          icon: tab.muted ? 'volume-x' : 'volume',
          // Only offered when there is sound to talk about; Chrome hides it too.
          off: !(tab.audible || tab.muted),
          run: function () { send({ t: 'tabMute', id: tab.id, muted: !tab.muted }); } },
        { sep: true },
        { label: t('bvp.closeTab'), icon: 'x',
          run: function () { send({ t: 'tabClose', id: tab.id }); } },
        { label: t('bvp.tabCloseOthers'), icon: 'square-x', disabled: !many,
          run: function () { send({ t: 'tabCloseOthers', id: tab.id }); } },
        { label: t('bvp.tabCloseRight'), icon: 'chevron-right', disabled: !rightOf,
          run: function () { send({ t: 'tabCloseRight', id: tab.id }); } },
        { sep: true },
        { label: t('bvp.tabReopen'), icon: 'history',
          run: function () { send({ t: 'tabReopen' }); } }
      ]);
    }

    /**
     * The PAGE's right-click menu, built from what the server found under the
     * pointer. Chrome's menu changes with the target — a link offers "Open in
     * new tab", an image offers "Copy image address", a text box offers Paste —
     * and a fixed menu that offers all of them always would be a menu where
     * most entries do nothing.
     */
    function openPageMenu(info) {
      var rect = canvas.getBoundingClientRect();
      var z = pickState.zoom || 1;
      // The server echoed the coordinates back in CANVAS space, so they convert
      // to screen space the same way a click converts the other direction.
      var sx = rect.width / (canvas.width || 1);
      var sy = rect.height / (canvas.height || 1);
      var cx = rect.left + Number(info.x || 0) * sx;
      var cy = rect.top + Number(info.y || 0) * sy;
      var link = String(info.linkUrl || '');
      var img = String(info.imageUrl || '');
      var media = String(info.mediaUrl || '');
      var sel = String(info.selection || '');
      // The address bar is the client's only copy of "where this tab is", and
      // the server rewrites it on every navigation, so it cannot go stale.
      var pageUrl = (urlIn.value || '').trim();
      // "Save as" can only work on something the SERVER can fetch over http(s).
      // A `blob:` or `data:` target lives inside the renderer and would fail —
      // showing an entry that cannot work is worse than not showing it.
      var canSave = function (u) { return /^https?:\/\//i.test(u); };

      openCtx(cx, cy, [
        { label: t('bvp.cmBack'), icon: 'chevron-left', disabled: !pickState.canBack,
          run: function () { send({ t: 'back' }); } },
        { label: t('bvp.cmForward'), icon: 'chevron-right', disabled: !pickState.canFwd,
          run: function () { send({ t: 'forward' }); } },
        { label: t('bvp.cmReload'), icon: 'rotate-cw',
          run: function () { send({ t: 'reload' }); } },
        { sep: true },
        // ── Link ─────────────────────────────────────────────────────────
        { label: t('bvp.cmOpenNewTab'), icon: 'plus', off: !link,
          // A NEW tab, not this one: that is what the entry says, and a menu
          // item that navigates the current tab instead would lose the page the
          // user was reading.
          run: function () { send({ t: 'tabNew', url: link }); } },
        { label: t('bvp.cmSaveLinkAs'), icon: 'download', off: !link || !canSave(link),
          // Fetched by the SERVER, not by an injected anchor: measured, a
          // cross-origin `<a download>` makes Chrome navigate instead of
          // download. See LiveBrowser.saveUrl.
          run: function () { saveUrlToShelf(link); } },
        { label: t('bvp.cmCopyLink'), icon: 'link', off: !link,
          run: function () { copyText(link); } },
        { label: t('bvp.cmCopyLinkText'), icon: 'copy', off: !link || !info.linkText,
          run: function () { copyText(String(info.linkText || '')); } },
        { sep: true, off: !link },
        // ── Image ────────────────────────────────────────────────────────
        { label: t('bvp.cmOpenImage'), icon: 'image-frame', off: !img,
          run: function () { send({ t: 'tabNew', url: img }); } },
        { label: t('bvp.cmSaveImageAs'), icon: 'download', off: !img || !canSave(img),
          run: function () { saveUrlToShelf(img); } },
        { label: t('bvp.cmCopyImage'), icon: 'copy', off: !img,
          run: function () { copyText(img); } },
        { sep: true, off: !img },
        // ── Media (video / audio) ────────────────────────────────────────
        { label: t('bvp.cmSaveMediaAs'), icon: 'download', off: !media || !canSave(media),
          run: function () { saveUrlToShelf(media); } },
        { label: t('bvp.cmCopyMedia'), icon: 'copy', off: !media,
          run: function () { copyText(media); } },
        { sep: true, off: !media },
        // ── Editing ──────────────────────────────────────────────────────
        // Copy asks the SERVER for the selection, because the text is selected
        // in the remote page and this machine's clipboard has never seen it.
        { label: t('bvp.cmCopy'), icon: 'copy', disabled: !info.hasSelection,
          run: function () {
            if (pickState.rio) pickState.rio.pullClipboard();
            else send({ t: 'copy' });
          } },
        { label: t('bvp.cmCut'), icon: 'x', off: !info.editable,
          disabled: !info.hasSelection,
          // Cut is Copy + delete, and both halves must happen in the REMOTE
          // page, so it goes through the key translator rather than being
          // faked as two separate messages.
          run: function () { send({ t: 'key', key: 'x', mods: { ctrl: true } }); } },
        { label: t('bvp.cmPaste'), icon: 'clipboard', off: !info.editable,
          // Paste has to go the other way: read THIS machine's clipboard and
          // type it into the remote page, since the server cannot read a
          // clipboard it does not own.
          run: function () { pasteIntoPage(); } },
        { label: t('bvp.cmSelectAll'), icon: 'square-check',
          run: function () { send({ t: 'selectAll' }); } },
        { sep: true },
        // ── Selection ────────────────────────────────────────────────────
        { label: t('bvp.cmSearchSel'), icon: 'search', off: !info.hasSelection,
          // A new tab, exactly like Chrome: searching in the current tab would
          // throw away the page the selection came from.
          run: function () {
            send({ t: 'tabNew', url: 'https://www.google.com/search?q=' + encodeURIComponent(sel) });
          } },
        { sep: true, off: !info.hasSelection },
        // ── Page ─────────────────────────────────────────────────────────
        // The page's own URL comes from the address bar, which the server
        // updates on every navigation — there is no separate copy to go stale.
        { label: t('bvp.cmSavePageAs'), icon: 'download', off: !canSave(pageUrl),
          run: function () { saveUrlToShelf(pageUrl); } },
        { label: t('bvp.cmViewSource'), icon: 'file-text', off: !canSave(pageUrl),
          // `view-source:` is a real Chrome scheme and the honest way to show
          // this: it renders the source of the page as the server sent it.
          run: function () { send({ t: 'tabNew', url: 'view-source:' + pageUrl }); } },
        { label: t('bvp.cmCopyPageUrl'), icon: 'link', off: !pageUrl,
          run: function () { copyText(pageUrl); } },
        { label: t('bvp.cmPrint'), icon: 'file-text',
          // Ctrl+P in the REMOTE browser. The remote Chrome owns the page, so
          // printing this canvas would print a picture of a browser instead.
          run: function () { send({ t: 'key', key: 'p', mods: { ctrl: true } }); } },
        { sep: true },
        // "Inspect" in a picker window means the thing this window is for:
        // arm element selection and lock the element that was right-clicked.
        { label: t('bvp.cmInspect'), icon: 'target',
          run: function () {
            applySelectMode(true);
            send({ t: 'click', x: Number(info.x || 0) / z, y: Number(info.y || 0) / z });
          } }
      ]);
    }

    /**
     * Ask the server to put a URL's bytes on the download shelf.
     *
     * The shelf is the one place downloads arrive, so "Save image as" lands
     * next to a file the page downloaded itself, with the same progress row,
     * the same size cap and the same fetch button. The toast exists because the
     * bytes travel to the SERVER first: without it the menu item would look
     * like it did nothing at all.
     */
    function saveUrlToShelf(url) {
      if (!url) return;
      send({ t: 'saveUrl', url: url });
      toast(t('bvp.cmSaving'), 'info');
    }

    /** Read the local clipboard and type it into the remote page. */
    function pasteIntoPage() {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (txt) {
          if (txt) send({ t: 'paste', text: txt });
        }).catch(function () { toast(t('bvp.cmPaste'), 'info'); });
      }
    }

    /** A blank tab, exactly like Ctrl+T: the address bar takes it from here. */
    function newTab(url) {
      if (!pickState.ws || pickState.ws.readyState !== WebSocket.OPEN) { connect(); return; }
      send({ t: 'tabNew', url: url || '' });
      if (!url) { urlIn.value = ''; urlIn.focus(); }
    }

    // One paint routine for both channels; `locked` decides whether the
    // pointer is still allowed to move the answer.
    function paint(data, locked) {
      pickState.last = data;
      panel.classList.toggle('is-locked', !!locked);
      if (locked) { pickState.locked = true; pickState.edited = false; }
      if (!pickState.edited) selIn.value = selectorOf(data);
      renderCount(data.count);
      renderAttrs(data.attrs);
      renderElHead(data);
      // Candidates are computed page-side for picks only (a hover would pay for
      // N querySelectorAll calls ~14x/sec), so a hover must not blank the list
      // the user is reading — it keeps the locked element's candidates.
      if (locked) renderCands(data.candidates);
      q('bvp-up').disabled = !data.hasParent;
      q('bvp-down').disabled = !data.hasChild;
    }

    // ══════════════════════════════════════════════════════════════════════
    // The page's own dialogs
    // ══════════════════════════════════════════════════════════════════════
    // `alert()`, `confirm()`, `prompt()` and `beforeunload` are drawn by CHROME,
    // not by the page, so they are invisible in a screencast — and Playwright
    // leaves an unhandled dialog blocking the page forever. That combination is
    // what "the tab silently locks up" was: a modal the user could neither see
    // nor answer. This is the answer path.
    function showDialog(msg) {
      pickState.dialog = msg;
      var kind = String(msg.kind || 'alert');
      var box = q('bvp-dialog');
      var titleEl = q('bvp-dlg-title');
      var fromEl = q('bvp-dlg-from');
      var msgEl = q('bvp-dlg-msg');
      var input = q('bvp-dlg-input');
      var yes = q('bvp-dlg-yes');
      var no = q('bvp-dlg-no');

      titleEl.textContent =
        kind === 'confirm' ? t('bvp.dlgConfirm')
        : kind === 'prompt' ? t('bvp.dlgPrompt')
        : kind === 'beforeunload' ? t('bvp.dlgLeave')
        : t('bvp.dlgAlert');

      // Name the site. A modal that says "This page says: your session expired,
      // re-enter your password" without saying WHICH page is a phishing surface,
      // not a convenience.
      var origin = '';
      try { origin = msg.url ? new URL(msg.url).origin : ''; } catch (e) { origin = String(msg.url || ''); }
      fromEl.textContent = origin ? tf('bvp.dlgFrom', { origin: origin }) : '';
      fromEl.style.display = origin ? '' : 'none';

      // The page's own text, via textContent: it is untrusted and must never be
      // parsed as HTML. `beforeunload` messages are ignored by real Chrome too
      // (sites abused them), so we show Chrome's fixed wording instead.
      msgEl.textContent = kind === 'beforeunload'
        ? t('bvp.dlgLeaveBody')
        : String(msg.message || '');

      var isPrompt = kind === 'prompt';
      input.classList.toggle('is-off', !isPrompt);
      input.value = isPrompt ? String(msg.defaultValue || '') : '';

      // An `alert()` has ONE button in Chrome, because there is nothing to
      // decline — offering Cancel would imply the page might not be told.
      var oneWay = kind === 'alert';
      no.style.display = oneWay ? 'none' : '';
      no.textContent = kind === 'beforeunload' ? t('bvp.dlgStay') : t('bvp.dlgCancel');
      yes.textContent = kind === 'beforeunload' ? t('bvp.dlgLeaveOk') : t('bvp.dlgOk');

      box.classList.remove('is-off');
      // Focus what the user will act on. For a prompt that is the field; for
      // everything else the confirming button, so Enter alone answers it.
      setTimeout(function () { (isPrompt ? input : yes).focus(); }, 0);
    }

    function answerDialog(accept) {
      if (!pickState.dialog) return;
      var kind = String(pickState.dialog.kind || 'alert');
      var input = q('bvp-dlg-input');
      var payload = { t: 'dialogAnswer', accept: !!accept };
      if (kind === 'prompt' && accept) payload.text = input.value || '';
      send(payload);
      hideDialog();
      // Put the keyboard back on the page. Leaving focus on a button that has
      // just vanished means the next keystroke goes nowhere, which looks like
      // the page froze the instant the dialog closed.
      stage.focus();
    }

    function hideDialog() {
      pickState.dialog = null;
      var box = q('bvp-dialog');
      if (box) box.classList.add('is-off');
    }

    // ══════════════════════════════════════════════════════════════════════
    // HTTP basic auth (the 401)
    // ══════════════════════════════════════════════════════════════════════
    function showAuth(msg) {
      pickState.auth = msg;
      var box = q('bvp-auth');
      q('bvp-auth-title').textContent = msg.proxy ? t('bvp.authProxy') : t('bvp.authTitle');
      q('bvp-auth-who').textContent = tf('bvp.authWho', { origin: String(msg.origin || '') });
      var realmEl = q('bvp-auth-realm');
      realmEl.textContent = msg.realm ? tf('bvp.authRealm', { realm: String(msg.realm) }) : '';
      realmEl.style.display = msg.realm ? '' : 'none';
      q('bvp-auth-user').value = '';
      q('bvp-auth-pass').value = '';
      box.classList.remove('is-off');
      setTimeout(function () { q('bvp-auth-user').focus(); }, 0);
    }

    function answerAuth(accept) {
      if (!pickState.auth) return;
      var u = q('bvp-auth-user').value || '';
      var p = q('bvp-auth-pass').value || '';
      send({ t: 'authAnswer', accept: !!accept, username: u, password: p });
      // Clear the field immediately rather than on the next open. The password
      // is in a DOM node in a long-lived overlay; there is no reason for it to
      // outlive the request by even one frame.
      q('bvp-auth-pass').value = '';
      hideAuth();
      stage.focus();
    }

    function hideAuth() {
      pickState.auth = null;
      var box = q('bvp-auth');
      if (box) box.classList.add('is-off');
    }

    // ══════════════════════════════════════════════════════════════════════
    // The download shelf
    // ══════════════════════════════════════════════════════════════════════
    function humanBytes(n) {
      var b = Number(n || 0);
      if (!b) return '';
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    /**
     * One download, arriving or updating. Keyed by `id`, so the three events a
     * single file produces (started, progress, completed) update ONE row instead
     * of stacking three rows for the same download.
     */
    function upsertDownload(d) {
      var found = false;
      for (var i = 0; i < pickState.downloads.length; i++) {
        if (pickState.downloads[i].id === d.id) { pickState.downloads[i] = d; found = true; break; }
      }
      if (!found) {
        pickState.downloads.push(d);
        // A new download un-hides the shelf. Chrome does the same, and for the
        // same reason: the user dismissed the shelf for the PREVIOUS file, which
        // says nothing about whether they want to be told about this one.
        pickState.shelfHidden = false;
      }
      renderShelf();
    }

    function renderShelf() {
      var shelf = q('bvp-shelf');
      var host = q('bvp-shelf-items');
      if (!shelf || !host) return;
      var list = pickState.downloads;
      shelf.classList.toggle('is-off', !list.length || pickState.shelfHidden);
      host.innerHTML = '';

      list.forEach(function (d) {
        var row = document.createElement('div');
        row.className = 'bvp-dl is-' + String(d.state || 'started');

        var name = document.createElement('span');
        name.className = 'bvp-dl-name';
        name.textContent = String(d.name || '');
        name.title = String(d.url || '');
        row.appendChild(name);

        var meta = document.createElement('span');
        meta.className = 'bvp-dl-meta';
        if (d.state === 'completed') {
          meta.textContent = humanBytes(d.total || d.received) || t('bvp.dlUnknownSize');
        } else if (d.state === 'failed') {
          meta.textContent = d.error === 'download_too_large'
            ? t('bvp.dlTooLarge') : (String(d.error || '') || t('bvp.dlFailed'));
        } else if (d.total > 0) {
          meta.textContent = tf('bvp.dlProgress', {
            done: humanBytes(d.received), total: humanBytes(d.total)
          });
        } else {
          // A server that sends no Content-Length gives us bytes with no total.
          // Showing "0%" would be a lie; showing the byte count is the truth.
          meta.textContent = humanBytes(d.received) || t('bvp.dlUnknownSize');
        }
        row.appendChild(meta);

        // A real progress bar only when there is a real total. An indeterminate
        // stripe is used otherwise, because a bar stuck at 0% reads as "broken"
        // while a moving stripe reads as "working" — which is the truth.
        if (d.state !== 'completed' && d.state !== 'failed') {
          var bar = document.createElement('span');
          bar.className = 'bvp-dl-bar' + (d.total > 0 ? '' : ' is-indet');
          var fill = document.createElement('span');
          fill.className = 'bvp-dl-fill';
          if (d.total > 0) {
            var pct = Math.max(2, Math.min(100, Math.round((d.received / d.total) * 100)));
            fill.style.width = pct + '%';
          }
          bar.appendChild(fill);
          row.appendChild(bar);
        }

        // The link that makes the whole feature real. The bytes are on the
        // SERVER's disk, so without this the download is a file the user can
        // see named and never open. It is a fetch (not an <a href>) because the
        // route needs the `x-api-key` header, exactly like uploads.
        if (d.state === 'completed' && d.token) {
          var get = document.createElement('button');
          get.type = 'button';
          get.className = 'icon-btn bvp-dl-get';
          get.title = t('bvp.dlSave');
          get.setAttribute('aria-label', t('bvp.dlSave'));
          get.innerHTML = BIC('download', 13);
          get.addEventListener('click', function () { fetchDownload(d); });
          row.appendChild(get);
        }

        var drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'icon-btn bvp-dl-drop';
        drop.title = t('bvp.dlDrop');
        drop.setAttribute('aria-label', t('bvp.dlDrop'));
        drop.innerHTML = BIC('x', 12);
        drop.addEventListener('click', function () {
          if (d.token) send({ t: 'downloadClear', token: d.token });
          // Drop it locally too. A failed download has no token, so waiting for
          // the server's confirmation would leave a row that can never be
          // dismissed.
          pickState.downloads = pickState.downloads.filter(function (x) { return x.id !== d.id; });
          renderShelf();
        });
        row.appendChild(drop);

        host.appendChild(row);
      });
    }

    /**
     * Pull the file onto THIS machine — the step that makes a remote download
     * real, because the bytes land on the SERVER's disk, not the user's.
     *
     * WHY NOT A HIDDEN IFRAME (what this replaced)
     * --------------------------------------------
     * MEASURED (probe against this very server): appending a hidden
     * `<iframe src=…>` produced ZERO downloads and exactly this console error:
     *
     *   Refused to frame 'http://…/browser/downloads/dl_…' because it violates
     *   the following Content Security Policy directive: "frame-src 'none'"
     *
     * That CSP is OUR OWN (src/index.ts sets `frameSrc: ["'none'"]`), so the
     * iframe could never have worked in ANY deployment — and it fails silently,
     * which is why the button looked dead rather than broken. A plain anchor
     * click, in the same probe, downloaded the file every time.
     *
     * WHY A PREFLIGHT
     * ---------------
     * A download URL that answers non-2xx does not surface the server's message.
     * MEASURED: a 404 and a 401 on this route both reach Chrome as a failed
     * download whose only explanation is Chrome's own generic text — the
     * «Failed - Unknown server error» that was reported — while the response
     * body actually said "That download is no longer available." So ask with
     * `fetch` FIRST (it can read the body, and it can send the key as a HEADER)
     * and only hand the transfer to the browser once it is known to answer 200.
     *
     * WHY THE BYTES COME BACK AS A BLOB
     * ---------------------------------
     * With `fetch` the API key travels in `x-api-key`, so it never lands in a
     * URL — and therefore never in the browser's download history, the address
     * bar, or a reverse proxy's access log. MEASURED: a blob-URL anchor click
     * downloads fine under this CSP. Files too large to hold in memory keep the
     * streaming path (a real navigation), the one case where a token in the
     * query is worth it.
     */
    var BLOB_LIMIT_BYTES = 64 * 1024 * 1024;

    function downloadUrlFor(d, withToken) {
      var url = '/browser/downloads/' + encodeURIComponent(d.token)
        + '?userId=' + encodeURIComponent(effectiveUserId());
      if (withToken) {
        var k = (window.API && window.API.getKey) ? (window.API.getKey() || '') : '';
        if (k) url += '&token=' + encodeURIComponent(k);
      }
      return url;
    }

    /**
     * The filename the SERVER decided on, read back out of its own header.
     *
     * The shelf row carries a name too, but it is a copy made when the download
     * started, and the server may have improved it since (it renames a file
     * that arrived with no extension once it can identify the bytes). The
     * header is the authoritative answer, so a stale row cannot save the file
     * under a name that no longer matches what is on disk.
     *
     * RFC 6266: `filename*=UTF-8''<percent-encoded>` is preferred over the
     * ASCII `filename="…"`, because the ASCII copy is deliberately lossy — the
     * server replaces every non-ASCII character in it with `_`, so trusting it
     * would turn `صفحه.png` into `_____.png`.
     */
    function nameFromDisposition(cd) {
      var s = String(cd || '');
      var star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(s);
      if (star) {
        try {
          var d = decodeURIComponent(star[1].trim());
          if (d) return d;
        } catch (e) { /* malformed encoding: fall through to the ASCII copy */ }
      }
      var plain = /filename\s*=\s*"([^"]*)"/i.exec(s) || /filename\s*=\s*([^;]+)/i.exec(s);
      return plain ? plain[1].trim() : '';
    }

    /** Save a blob (or a URL) under `name`, via the anchor click that works. */
    function saveAs(href, name, revoke) {
      var a = document.createElement('a');
      a.href = href;
      a.download = name || 'download';
      a.rel = 'noopener';
      // Must be IN the document: a detached anchor's click is ignored by Firefox.
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (revoke) {
        // Revoking synchronously can cancel the transfer that just started, so
        // the URL is released later — long after Chrome has taken the bytes.
        setTimeout(function () { try { URL.revokeObjectURL(href); } catch (e) {} }, 60000);
      }
    }

    /**
     * Turn a failed download response into a sentence the user can act on.
     * Anything less leaves them with Chrome's generic text, which names no cause
     * and suggests no remedy.
     */
    function downloadFailureMessage(status, body) {
      if (body && body.error) return String(body.error);
      if (status === 401) return t('bvp.dlNoAuth');
      if (status === 403) return t('bvp.dlForbidden');
      if (status === 404) return t('bvp.dlGone');
      return t('bvp.dlServerError').replace('{status}', String(status || '?'));
    }

    function fetchDownload(d) {
      var key = (window.API && window.API.getKey) ? (window.API.getKey() || '') : '';
      var headers = {};
      if (key) headers['x-api-key'] = key;

      /** Read a failed response's own words, then throw them. */
      function explain(res) {
        return res.text().then(function (txt) {
          var body = null;
          try { body = JSON.parse(txt); } catch (e) { /* not JSON */ }
          throw new Error(downloadFailureMessage(res.status, body));
        });
      }

      // HEAD, not GET: same auth, same token resolution, so it answers
      // "will this work?" without moving the bytes twice.
      fetch(downloadUrlFor(d, false), { method: 'HEAD', headers: headers })
        .then(function (res) {
          if (!res.ok) {
            // HEAD carries no body, so re-ask with GET purely to quote the
            // server's own explanation instead of inventing one.
            return fetch(downloadUrlFor(d, false), { headers: headers }).then(explain);
          }
          var len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
          // Prefer the server's own Content-Disposition over the shelf row: the
          // row's name was captured when the download started, and the server
          // renames a file that arrived without an extension once it can
          // identify the bytes.
          var served = nameFromDisposition(res.headers.get('content-disposition'));
          var want = served || d.name;
          if (len > BLOB_LIMIT_BYTES) {
            // Too big to hold in memory: let the browser stream it to disk. The
            // only path that needs the key in the query, since a navigation
            // cannot carry a header.
            saveAs(downloadUrlFor(d, true), want, false);
            return null;
          }
          return fetch(downloadUrlFor(d, false), { headers: headers })
            .then(function (r) {
              if (!r.ok) return explain(r);
              // The GET's own header beats the HEAD's if they ever differ.
              want = nameFromDisposition(r.headers.get('content-disposition')) || want;
              return r.blob();
            })
            .then(function (blob) {
              if (!blob) return;
              saveAs(URL.createObjectURL(blob), want, true);
            });
        })
        .catch(function (e) {
          // Never silent. A download the user asked for and did not get has to
          // say why, or the only remaining move is to press the button again.
          toast(
            (e && e.message) ? e.message : t('bvp.dlServerError').replace('{status}', '?'),
            'error'
          );
        });
    }

    // ══════════════════════════════════════════════════════════════════════
    // Self-healing progress
    // ══════════════════════════════════════════════════════════════════════
    // "It said I must restart, I pressed it, nothing happened, and I had no idea
    // what was going on." The server now heals itself and reports every step it
    // takes; this renders those steps as a live checklist with a measured ETA,
    // so the wait always answers three questions: what is happening, whether it
    // needs me, and how much longer.
    /**
     * The heal panel's lease — the same invariant `setNavBusy` obeys.
     *
     * The standing rule in this file is that ANY state set optimistically on a
     * user action must expire on its own. The heal panel broke it: it was raised
     * before the request was sent (correctly — an empty-but-visible panel answers
     * "yes, something is happening") but it could only ever be taken down by an
     * explicit later event: the `.then`, the `.catch`, or a `ready` frame. A POST
     * that never SETTLES runs none of those, and a promise that never settles is
     * not exotic here: the socket can drop mid-flight, the tab can be suspended,
     * and the server restarting Chrome can die while holding the request open.
     *
     * Measured, not assumed: a probe that holds the restart POST open forever
     * left this panel up indefinitely, over a dimmed canvas, with `role="status"`
     * claiming "about 6 seconds" — which is exactly how a working app teaches its
     * user that it is broken.
     *
     * Two phases, because one number cannot serve both:
     *   'press'  — waiting for the POST to be answered at all. 20s, and that
     *              number is reconciled with the server rather than invented: the
     *              honest worst case SelfHeal publishes for itself totals ~12.5s
     *              (stop 2 + display 3 + start 6 + verify 1.5), so 20s cannot
     *              cut off a restart that is merely slow, while still being
     *              ~15x the 0.5-1.3s a restart actually takes here.
     *   'server' — the server has told us a heal is genuinely in flight (the
     *              resume path below). It owns the work and reports its own
     *              progress, so this is only a backstop against that report
     *              itself going silent.
     */
    /**
     * Ask the server whether a heal is running, and if so adopt it.
     *
     * THE REPORTED BUG, EXACTLY
     * -------------------------
     * The user's panel got stuck, so they closed the window and opened it again —
     * the correct instinct — and the new window "could not connect, apparently
     * stuck the same way". It was not stuck: it simply had no idea. A heal used to
     * be reported only down the request that started it, so a second window was
     * structurally incapable of learning that Chrome was mid-relaunch, and showed
     * a dead-looking window during the one interval when waiting was right.
     *
     * Now the server publishes the live heal on `/browser/status`, and a window
     * adopts it on open. Note what this does NOT do: it never invents a panel. A
     * `heal` of null means nothing is running, and then nothing is shown — a
     * reopened window that puts up a spinner "just in case" is the same lie in a
     * new place.
     */
    function resumeHeal() {
      if (!window.API || !window.API.get) return;
      var mine = pickState;                     // this window, not a later one
      window.API.get('/browser/status')
        .then(function (r) {
          // Bail if the window was closed, or reopened, while this was in flight.
          if (!pickState || pickState !== mine) return;
          var h = r && r.heal;
          if (!h || !h.step) return;            // nothing running: show nothing
          showHeal([h.step]);
          // 'server' phase: the server has SAID it is working, so the generous
          // backstop applies rather than the short "was the press even heard?" one.
          setHealLease('server');
          setStatus(t('bvp.restarting'), 'warn');
          toast(t('bvp.healResumed'), 'info');
        })
        .catch(function () { /* a status we cannot read is not worth a panel */ });
    }

    /** Drop every per-step "the estimate has elapsed" countdown. */
    function clearHealEtaTimers() {
      if (!pickState) return;
      if (!pickState.healEtaTimers) { pickState.healEtaTimers = []; return; }
      pickState.healEtaTimers.forEach(function (id) { clearTimeout(id); });
      pickState.healEtaTimers = [];
    }

    function setHealLease(phase) {
      if (!pickState) return;
      if (pickState.healTimer) {
        clearTimeout(pickState.healTimer);
        pickState.healTimer = 0;
      }
      if (!phase) return;
      pickState.healTimer = setTimeout(function () {
        if (!pickState) return;
        pickState.healTimer = 0;
        hideHeal();
        // ── GIVE THE BUTTON BACK ───────────────────────────────────────────
        // This is the part the probe caught that the report only hinted at. The
        // restart handler disables its own button and re-enables it in a trailing
        // `.then`, so a POST that never settles leaves `#bvp-restart` disabled
        // for the life of the window: the user was not merely looking at a stuck
        // panel, they had lost the one control that could have fixed it. Telling
        // them to "press it again" is only honest if pressing is possible.
        var rb = q('bvp-restart');
        if (rb) rb.disabled = false;
        // Say what happened and what to do about it. A panel that silently
        // vanishes is only marginally better than one that never leaves: the
        // user still does not know whether the restart happened. Naming it as a
        // lost answer, and pointing at Reconnect, is the same contract
        // `bvp.navLost` already keeps for a lost navigation.
        setStatus(t('bv.error'), 'bad');
        toast(t('bvp.healLost'), 'warning');
      }, phase === 'server' ? 45000 : 20000);
    }

    function showHeal(steps) {
      var box = q('bvp-heal');
      var host = q('bvp-heal-steps');
      if (!box || !host) return;
      pickState.healSteps = steps || [];
      // Every re-render throws away the previous lines, so the countdowns those
      // lines owned have to go with them; otherwise a step that finished half a
      // second ago can still rewrite a node from a later render.
      clearHealEtaTimers();
      host.innerHTML = '';
      if (!pickState.healSteps.length) { box.classList.add('is-off'); return; }

      pickState.healSteps.forEach(function (s) {
        var li = document.createElement('li');
        li.className = 'bvp-heal-step is-' + String(s.state || 'running');

        var icon = document.createElement('span');
        icon.className = 'bvp-heal-mark';
        icon.innerHTML = s.state === 'done' ? BIC('check', 13)
          : s.state === 'failed' ? BIC('alert-circle', 13)
          : BIC('loader', 13);
        if (s.state === 'running') icon.classList.add('is-spin');
        li.appendChild(icon);

        var label = document.createElement('span');
        label.className = 'bvp-heal-label';
        // The server sends a stable KEY, never a sentence, so this line can be
        // Persian. An English string on the wire would have made the whole
        // progress panel untranslatable.
        label.textContent = t('bvp.heal.' + String(s.key || '')) || String(s.key || '');
        li.appendChild(label);

        var meta = document.createElement('span');
        meta.className = 'bvp-heal-meta';
        if (s.state === 'running' && s.etaMs > 0) {
          meta.textContent = tf('bvp.healEta', { s: Math.ceil(s.etaMs / 1000) });
          // ── RECONCILE THE ESTIMATE WITH REALITY ──────────────────────────
          // An ETA is a promise, and this one used to be kept only by luck. Once
          // the estimate has elapsed, a line still reading "about 6 seconds" is
          // no longer optimistic, it is false — and a progress indicator caught
          // lying once is not believed again. So the estimate is given a deadline
          // of its own: when it passes, the line stops quoting a number and says
          // the honest thing instead, which is that this is taking longer than
          // expected and is still running.
          (function (el, ms) {
            pickState.healEtaTimers.push(setTimeout(function () {
              // Only if this very line is still on screen and still running:
              // a re-render replaces the node, and the new one carries its own.
              if (el.isConnected) el.textContent = t('bvp.healSlow');
            }, ms));
          }(meta, s.etaMs));
        } else if (s.detail) {
          meta.textContent = String(s.detail);
        }
        li.appendChild(meta);

        host.appendChild(li);
      });
      box.classList.remove('is-off');
    }

    function hideHeal() {
      // Drop the lease with the panel. Leaving it armed would fire a "no answer
      // came back" toast about an operation that in fact succeeded.
      if (pickState && pickState.healTimer) {
        clearTimeout(pickState.healTimer);
        pickState.healTimer = 0;
      }
      clearHealEtaTimers();
      var box = q('bvp-heal');
      if (box) box.classList.add('is-off');
    }

    function drawFrame(b64) {
      var img = new Image();
      img.onload = function () {
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width; canvas.height = img.height;
        }
        ctx.drawImage(img, 0, 0);
      };
      img.src = 'data:image/jpeg;base64,' + b64;
      empty.style.display = 'none';
    }

    function onMessage(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || !msg.t) return;
      // Clipboard and file-dialog traffic belongs to RemoteIO; give it first
      // refusal so those flows stay in one place instead of half here.
      if (pickState && pickState.rio && pickState.rio.onMessage(msg)) return;
      switch (msg.t) {
        case 'frame':
          // Every frame is proof of life. The stall watchdog reads this stamp,
          // and a recovery that has produced pixels again is finished whatever
          // else it says.
          pickState.lastFrameAt = Date.now();
          pickState.pingSentAt = 0;
          if (pickState.recovering) {
            pickState.recovering = false;
            setStatus(t('bv.connected'), 'ok');
          }
          drawFrame(msg.data);
          break;
        // Answer to the watchdog's silent probe: the page is fine, it simply had
        // nothing new to paint. Deliberately no status change and no toast —
        // an idle page must not look like a fault to the user.
        case 'alive':
          pickState.pingSentAt = 0;
          pickState.lastFrameAt = Date.now();
          break;
        case 'ready':
          setStatus(t('bv.connected'), 'ok');
          pickState.lastFrameAt = Date.now();
          setSession(msg.signedIn);             // cookies restored, or anonymous?
          // Say so when tabs came back. A window that silently opens four tabs
          // the user does not remember opening looks like a bug; naming it as a
          // restore makes it the feature it is.
          if (msg.restoredTabs > 0) {
            toast(tf('bvp.tabRestored', { n: msg.restoredTabs }), 'info');
          }
          // THE FIRST NAVIGATION HAPPENS HERE, not in `onopen`.
          // `session.start()` on the server boots a context + page + screencast
          // (~½ second). A command sent before that resolves used to be dropped
          // on the floor, so the picker window came up on `about:blank` and the
          // URL the user typed never loaded — the "the simulated browser won't
          // open google.com" bug. The server now queues early commands too;
          // this keeps the client correct on its own.
          if (pickState.pendingUrl) {
            var pu = pickState.pendingUrl;
            pickState.pendingUrl = '';
            send({ t: 'navigate', url: pu });
          }
          // Push the CURRENT mode rather than forcing the picker on. This line
          // used to be `send({ t: 'picker', on: true })`, which is what made the
          // window un-browsable from its very first frame.
          applySelectMode(pickState.selectMode, true);
          // A fresh socket knows nothing about history, zoom or the shelf, and
          // all three are SERVER state that survived the reconnect. Ask, rather
          // than assume: assuming zoom is 1 after resyncing into a page the user
          // had zoomed to 150% would silently break every click coordinate.
          if (typeof msg.zoom === 'number') setZoomLabel(msg.zoom);
          if (Array.isArray(msg.downloads)) {
            pickState.downloads = msg.downloads;
            renderShelf();
          }
          applyNavState();
          // Chrome is up and streaming, so any healing panel is finished.
          hideHeal();
          break;
        case 'session':
          setSession(msg.signedIn);
          if (msg.cleared) toast(t('bvp.forgotten'), 'success');
          break;
        case 'navigated':
          setStatus(t('bv.connected'), 'ok');
          // Follow the page. Clicking a link inside the window used to leave a
          // stale address in the bar, so "where am I?" had no answer. Never
          // overwrite what the user is currently typing into the field.
          if (msg.url && document.activeElement !== urlIn) urlIn.value = msg.url;
          break;
        // ── Tabs ──────────────────────────────────────────────────────────
        case 'tabs':
          renderTabs(msg.tabs, msg.activeId);
          break;
        case 'tabOpened':
          // A tab the PAGE opened (target=_blank, window.open, an OAuth popup).
          // The old single-page session simply never looked at these, so a login
          // the user had just started was invisible: the page existed, nothing
          // was streaming it, and the canvas kept showing the tab they left.
          if (msg.url && document.activeElement !== urlIn) urlIn.value = msg.url;
          break;
        // ── Recovery ──────────────────────────────────────────────────────
        // These two are the visible half of issue 1. The old code had no way to
        // say either of them, which is exactly why a refreshed tab looked like a
        // crash with no explanation and no way out.
        case 'recovering':
          pickState.recovering = true;
          pickState.pingSentAt = 0;
          setStatus(t('bvp.recovering'), 'warn');
          break;
        case 'recovered':
          pickState.recovering = false;
          pickState.pingSentAt = 0;
          pickState.lastFrameAt = Date.now();
          setStatus(t('bv.connected'), 'ok');
          if (msg.url && document.activeElement !== urlIn) urlIn.value = msg.url;
          toast(t('bvp.recovered'), 'success');
          // The picker script lives in the page, and the page is new. Re-arm the
          // mode the user had, or select mode is silently off after a recovery.
          applySelectMode(pickState.selectMode, true);
          break;
        // How much survived a relaunch. The user's report was not only that
        // tabs were lost — it was that they could not tell WHAT had happened
        // («نمیدونم ریستارت شد یا چی»). A count answers both halves: the
        // browser restarted, and here is what came back.
        case 'tabsRestored':
          if (Number(msg.count) > 0) {
            toast(tf('bvp.tabsRestored', { n: Number(msg.count) }), 'success');
          }
          break;
        case 'tabCrashed':
          toast(t('bvp.tabCrashed'), 'warning');
          break;
        // ── Navigation: are the arrows even meaningful? ────────────────────
        // The measured baseline never sent this, so both arrows were permanently
        // enabled and Back on the first page of a tab did nothing at all — which
        // is the "back/forward don't work correctly" report, exactly.
        case 'navState':
          pickState.canBack = !!msg.canGoBack;
          pickState.canFwd = !!msg.canGoForward;
          if (typeof msg.zoom === 'number') setZoomLabel(msg.zoom);
          applyNavState();
          if (msg.url && document.activeElement !== urlIn) urlIn.value = msg.url;
          break;
        case 'navStart':
          // Hand the lease over to the server phase: the command was received,
          // so the short "was that even heard?" window is finished and the long
          // "this page is loading" one starts, measured from now.
          setNavBusy(true, 'server');
          setStatus(t('bvp.stLoading'), 'warn');
          break;
        case 'navEnd':
          setNavBusy(false);
          setStatus(t('bvp.stLive'), 'ok');
          break;
        // A refusal, not a fault: you pressed Back on the first page. Saying so
        // is the difference between "this button is broken" and "there is
        // nothing behind this page".
        case 'navBlocked':
          setNavBusy(false);
          toast(msg.kind === 'forward'
            ? t('bvp.navBlockedForward') : t('bvp.navBlockedBack'), 'info');
          break;
        case 'zoom':
          setZoomLabel(msg.level);
          break;
        // ── The page's own dialogs ────────────────────────────────────────
        case 'dialog':
          showDialog(msg);
          break;
        case 'dialogDone':
          hideDialog();
          break;
        // The page said no to closing the tab (`beforeunload` declined). The tab
        // is still there and still yours — say so, or the X looks broken.
        case 'tabCloseCancelled':
          toast(t('bvp.tabCloseCancelled'), 'info');
          break;
        case 'tabReopenEmpty':
          toast(t('bvp.tabReopenEmpty'), 'info');
          break;
        // ── HTTP basic auth ──────────────────────────────────────────────
        case 'authRequired':
          showAuth(msg);
          break;
        case 'authDone':
          hideAuth();
          toast(msg.accepted ? t('bvp.authDone') : t('bvp.authCancelled'),
            msg.accepted ? 'success' : 'info');
          break;
        // ── Downloads ────────────────────────────────────────────────────
        case 'download':
          upsertDownload(msg);
          if (msg.state === 'completed') {
            toast(tf('bvp.dlDone', { name: String(msg.name || '') }), 'success');
          } else if (msg.state === 'failed') {
            toast(tf('bvp.dlFailed', { name: String(msg.name || '') }), 'error');
          }
          break;
        case 'downloadCleared':
          pickState.downloads = pickState.downloads.filter(function (d) {
            return d.token !== msg.token && d.id !== msg.id;
          });
          renderShelf();
          break;
        // ── The page context menu ────────────────────────────────────────
        case 'contextMenu':
          openPageMenu(msg);
          break;
        case 'hover':
          if (!pickState.locked) paint(msg, false);
          break;
        case 'pick': paint(msg, true); break;
        case 'verified': renderCount(msg.count); break;
        case 'expired': setStatus(t('bv.expired'), 'warn'); break;
        case 'error':
          // The tab cap is a refusal, not a fault: it happens when a page in a
          // redirect loop calls window.open() faster than a human closes tabs.
          // Showing it in the status badge as if the browser had broken would be
          // the wrong story — say what to do instead.
          if (String(msg.message || '') === 'too_many_tabs') {
            toast(t('bvp.tabsFull'), 'warning');
            break;
          }
          setStatus(String(msg.message || 'error'), 'bad');
          break;
      }
    }

    function connect() {
      var url = (urlIn.value || '').trim();
      if (!url) { urlIn.focus(); return; }
      memoUrl(url);
      if (pickState.ws && pickState.ws.readyState === WebSocket.OPEN) {
        send({ t: 'navigate', url: url });
        return;
      }
      if (!window.WebSocket) { setStatus(t('bv.noWs'), 'bad'); return; }
      setStatus(t('bv.connecting'), 'warn');
      var ws;
      try { ws = new WebSocket(wsUrl(effectiveUserId(), API.getKey())); }
      catch (e) { setStatus(t('bv.error'), 'bad'); return; }
      pickState.ws = ws;
      pickState.pendingUrl = url;   // flushed by the 'ready' event
      if (window.RemoteIO && !pickState.rio) {
        pickState.rio = window.RemoteIO.attach({
          stage: stage,
          host: stage,
          send: send,
          // Same identity as the socket, or the upload lands in a directory
          // this session never looks in.
          userId: effectiveUserId,
          // While the crosshair is armed every key means "walk the DOM", so the
          // clipboard shortcuts must stand down rather than fight the picker.
          isBusy: function () { return !!(pickState && pickState.selectMode); }
        });
      }
      ws.onopen = function () { setStatus(t('bv.connecting'), 'warn'); };
      ws.onmessage = function (m) { onMessage(m.data); };
      ws.onerror = function () { setStatus(t('bv.error'), 'bad'); };
      ws.onclose = function () { if (pickState) setStatus(t('bv.disconnected'), ''); };

      // ── Frame-stall watchdog ────────────────────────────────────────────
      // The server has its own liveness poll, but the client needs one too,
      // because the two notice different failures. The server can only tell that
      // its page stopped answering; the client can tell that PIXELS stopped
      // arriving, which also covers a screencast that was silently detached
      // (a new renderer process does that) on a page that is otherwise fine.
      // That was the whole shape of the reported bug: no error, no disconnect,
      // just a still image and every click going nowhere.
      //
      // But a frame gap on its own does NOT mean anything is broken. The
      // screencast is delta-based: it emits a frame when the compositor
      // repaints, so a static page paints once on load and then sends nothing
      // for as long as you leave it alone. Treating silence as a fault would put
      // a "reconnecting" banner on every ordinary page on a 20-second timer.
      //
      // So this is a two-stage probe, and stage one is SILENT:
      //   1. quiet for a while -> ask the server `ping`. It answers `alive` for a
      //      page that is merely idle (and quietly re-arms the screencast), or
      //      recovers for real if the page is gone. The user sees nothing.
      //   2. `ping` itself goes unanswered -> now something really is wrong, so
      //      say so and rebuild the stream.
      if (pickState.stallTimer) clearInterval(pickState.stallTimer);
      pickState.stallTimer = setInterval(function () {
        var ps = pickState;
        if (!ps || ps.recovering) return;
        if (!ps.ws || ps.ws.readyState !== WebSocket.OPEN) return;
        if (!ps.lastFrameAt) return;                 // nothing has ever arrived yet
        var quiet = Date.now() - ps.lastFrameAt;
        if (quiet < 20000) return;

        if (ps.pingSentAt) {
          // Stage 2: we already asked and got no answer at all.
          if (Date.now() - ps.pingSentAt < 10000) return;   // still waiting
          ps.pingSentAt = 0;
          ps.lastFrameAt = Date.now();               // do not re-fire every tick
          ps.recovering = true;
          setStatus(t('bvp.recovering'), 'warn');
          send({ t: 'resync' });
          return;
        }
        // Stage 1: silent. No status change — an idle page is not an error.
        ps.pingSentAt = Date.now();
        send({ t: 'ping' });
      }, 5000);
    }

    // ---- wiring ---------------------------------------------------------
    var lastMove = 0;
    canvas.addEventListener('mousemove', function (ev) {
      // ── A real drag ─────────────────────────────────────────────────────
      // While a button is down, every move is part of a gesture, not a hover.
      // This is the ONE primitive that text selection, range sliders, drag &
      // drop and canvas apps are all built from, and none of them can be done
      // with clicks: a slider moved by clicking jumps, and a selection made by
      // clicking is a caret. So drag moves are never throttled away and never
      // reinterpreted as hovers.
      if (pickState.dragFrom) {
        var dp = toPoint(ev);
        pickState.dragLast = dp;
        var now2 = Date.now();
        if (now2 - lastMove < 25) return;    // ~40/sec: smooth, not a flood
        lastMove = now2;
        send({
          t: 'move', x: dp.x, y: dp.y,
          buttons: pickState.dragFrom.button, mods: modsOf(ev)
        });
        return;
      }
      var now = Date.now();
      if (now - lastMove < 70) return;   // ~14 moves/sec is plenty for a preview
      lastMove = now;
      var p = toPoint(ev);
      send({ t: 'move', x: p.x, y: p.y, mods: modsOf(ev) });
    });

    // ── mousedown / mouseup, so a DRAG is possible at all ─────────────────
    // The old code only listened for `click`, which the browser synthesises
    // AFTER the button comes back up — so by the time we heard about it the
    // gesture was over and there was no way to express "press here, move there,
    // release". Selecting a paragraph, moving a slider and dropping a file all
    // become impossible, and all three were reported missing.
    canvas.addEventListener('mousedown', function (ev) {
      stage.focus();
      if (ev.button === 2) return;              // right button: contextmenu handles it
      var p = toPoint(ev);
      pickState.dragFrom = { x: p.x, y: p.y, button: buttonOf(ev), at: Date.now() };
      pickState.dragLast = { x: p.x, y: p.y };
    });

    canvas.addEventListener('mouseup', function (ev) {
      var from = pickState.dragFrom;
      pickState.dragFrom = null;
      if (!from) return;
      var p = toPoint(ev);
      var dx = Math.abs(p.x - from.x);
      var dy = Math.abs(p.y - from.y);
      // Under 4px is a click, not a drag — a hand shakes, and a click that
      // selects three characters of text because the pointer moved two pixels
      // is worse than no drag support at all. Above it, send the real gesture
      // and let `click` below know it has already been handled.
      if (dx < 4 && dy < 4) return;
      pickState.dragDone = Date.now();
      send({
        t: 'drag',
        from: { x: from.x, y: from.y },
        to: { x: p.x, y: p.y },
        button: from.button,
        mods: modsOf(ev)
      });
    });

    // If the button comes up outside the canvas the canvas never hears about it,
    // and the session would be stuck believing a button is still held — every
    // later hover becoming a phantom drag. Chrome ends the gesture at the window
    // edge; so do we.
    document.addEventListener('mouseup', function () {
      if (pickState && pickState.dragFrom) pickState.dragFrom = null;
    });

    canvas.addEventListener('click', function (ev) {
      // A drag already reported this gesture; a click on top of it would move
      // the caret to the end of the text that was just selected.
      if (pickState.dragDone && Date.now() - pickState.dragDone < 120) return;
      var p = toPoint(ev);
      // `detail` is the browser's own click counter: 1, then 2 for a
      // double-click, then 3 for a triple. Passing it straight through is what
      // makes double-click select a word and triple-click select a paragraph —
      // measured against real Chromium, `clickCount: 2` is the whole mechanism,
      // and no amount of two separate single clicks reproduces it.
      send({
        t: 'click', x: p.x, y: p.y,
        button: buttonOf(ev),
        clickCount: Math.min(3, Math.max(1, ev.detail || 1)),
        mods: modsOf(ev)
      });
    });

    // Right-click: ask the server what is under the pointer, then draw Chrome's
    // menu over the canvas. `preventDefault` stops the HOST browser's own menu
    // appearing on top of ours, which would offer "Save image as…" for a canvas.
    canvas.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (pickState.selectMode) return;      // in select mode the click picks
      var p = toPoint(ev);
      send({ t: 'contextMenu', x: p.x, y: p.y });
    });

    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = toPoint(ev);
      // Ctrl+wheel is ZOOM in every browser, not scroll. Sending it as a scroll
      // meant a user trying to zoom got a page that jumped around instead.
      if (ev.ctrlKey || ev.metaKey) {
        send({ t: 'zoom', dir: ev.deltaY < 0 ? 'in' : 'out' });
        return;
      }
      // Horizontal wheel. Two sources, and both are real: a trackpad sends
      // `deltaX` directly, while Shift+wheel is how a mouse with only a vertical
      // wheel scrolls sideways. A page with a wide table is unusable without it.
      var dx = ev.deltaX || (ev.shiftKey ? ev.deltaY : 0);
      var dy = ev.shiftKey && !ev.deltaX ? 0 : ev.deltaY;
      send({ t: 'scroll', x: p.x, y: p.y, dy: dy, dx: dx, mods: modsOf(ev) });
    }, { passive: false });
    // Keyboard on the focused stage. In SELECT mode the keys drive the picker:
    // Space locks the hovered element and ↑/↓ walk the DOM (they live here, not
    // only on the panel buttons, because walking the DOM is done while looking at
    // the page and moving the pointer to a button is what loses your place).
    //
    // In BROWSE mode the same keys have to mean what they mean in a browser —
    // Space scrolls, arrows scroll, and typing types — otherwise "it behaves like
    // a real browser" is false the moment you try to fill in a login form.
    // ── Keys the HOST browser keeps for itself ────────────────────────────
    // A short, honest list of the keystrokes the surrounding browser will not
    // deliver to a web page whatever we do: Ctrl+N/T/W, Ctrl+Shift+N/T, F11,
    // F12. They are NOT dropped — the ones that have a meaning here are handled
    // LOCALLY instead (Ctrl+T opens a tab in OUR strip, Ctrl+W closes one),
    // which is the only way they can work at all.
    //
    // Everything else — and it is everything: every letter, digit and function
    // key, with any combination of Ctrl/Shift/Alt/Meta — goes to the page via
    // `Input.dispatchKeyEvent`. The old code had a nine-item whitelist and,
    // worse, `if (ev.ctrlKey || ev.metaKey || ev.altKey) return;`, which threw
    // away EVERY modified keystroke: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z and
    // Ctrl+F all silently did nothing inside the page.
    function handledLocally(ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      if (!mod) return '';
      var k = String(ev.key || '').toLowerCase();
      if (k === 't') return ev.shiftKey ? 'reopenTab' : 'newTab';
      if (k === 'w') return 'closeTab';
      // Ctrl+Tab cycles OUR tabs. Left to the host browser it would switch the
      // user out of this window entirely.
      if (ev.key === 'Tab') return ev.shiftKey ? 'prevTab' : 'nextTab';
      if (k === '+' || k === '=' || ev.key === 'Add') return 'zoomIn';
      if (k === '-' || k === '_' || ev.key === 'Subtract') return 'zoomOut';
      if (k === '0') return 'zoomReset';
      return '';
    }

    stage.addEventListener('keydown', function (ev) {
      // Select mode keeps its own keys: Space locks the hovered element and the
      // arrows walk the DOM. They live here rather than only on the panel
      // buttons because walking the DOM is done while looking at the page, and
      // moving the pointer to a button is what loses your place.
      if (pickState.selectMode) {
        if (ev.key === ' ' || ev.code === 'Space') {
          ev.preventDefault(); send({ t: 'key', key: 'Space' });
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault(); send({ t: 'pickStep', dir: 'up' });
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault(); send({ t: 'pickStep', dir: 'down' });
        } else if (ev.key === 'Escape') {
          ev.preventDefault(); applySelectMode(false);
        }
        return;
      }

      // Escape closes whatever is open, innermost first — the order a person
      // expects.
      if (ev.key === 'Escape') {
        if (pickState.ctxOpen) { ev.preventDefault(); closeCtx(); return; }
        if (pickState.dialog) { ev.preventDefault(); answerDialog(false); return; }
        if (pickState.auth) { ev.preventDefault(); answerAuth(false); return; }
      }
      // A page dialog is modal, exactly as in Chrome: the page underneath is
      // blocked, so keystrokes must not leak through to it.
      if (pickState.dialog || pickState.auth) return;

      // Browser-level shortcuts we own.
      var local = handledLocally(ev);
      if (local) {
        ev.preventDefault();
        if (local === 'newTab') newTab();
        else if (local === 'closeTab') send({ t: 'tabClose', id: pickState.activeTab });
        else if (local === 'reopenTab') send({ t: 'tabReopen' });
        else if (local === 'nextTab') send({ t: 'tabCycle', dir: 1 });
        else if (local === 'prevTab') send({ t: 'tabCycle', dir: -1 });
        else if (local === 'zoomIn') send({ t: 'zoom', dir: 'in' });
        else if (local === 'zoomOut') send({ t: 'zoom', dir: 'out' });
        else if (local === 'zoomReset') send({ t: 'zoom', level: 1 });
        return;
      }

      // Reload, both spellings, because both are muscle memory. Ctrl+Shift+R
      // and Ctrl+F5 are Chrome's CACHE-BYPASSING reload, which is a genuinely
      // different action — the one you reach for when a page keeps serving a
      // stale script.
      var kl = String(ev.key).toLowerCase();
      if (ev.key === 'F5' || ((ev.ctrlKey || ev.metaKey) && kl === 'r')) {
        ev.preventDefault();
        send({ t: 'reload', hard: !!(ev.shiftKey || (ev.ctrlKey && ev.key === 'F5')) });
        return;
      }
      // Alt+Left / Alt+Right: Chrome's keyboard Back and Forward.
      if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        ev.preventDefault();
        send({ t: ev.key === 'ArrowLeft' ? 'back' : 'forward' });
        return;
      }
      // Ctrl+V must be intercepted rather than forwarded: the page's clipboard
      // belongs to the SERVER, which has never seen what the user copied on this
      // machine. So read the local clipboard and type it in — the only way paste
      // can cross the gap at all. (Ctrl+C goes the other way, and RemoteIO
      // already owns that direction.)
      if ((ev.ctrlKey || ev.metaKey) && kl === 'v' && !ev.shiftKey) {
        ev.preventDefault();
        pasteIntoPage();
        return;
      }

      // ── Everything else reaches the page, verbatim ───────────────────────
      // A printable character with no Ctrl/Meta/Alt is inserted as TEXT, which
      // is what makes accented and non-Latin input work: `Input.insertText`
      // handles a composed character that no keycode describes. Everything else,
      // including every modified combination, is dispatched as a real key event
      // so the page's own handlers see the modifiers they are testing for.
      var printable = ev.key && ev.key.length === 1
        && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
      ev.preventDefault();
      if (printable) {
        send({ t: 'type', text: ev.key });
      } else {
        send({
          t: 'key',
          key: ev.key === ' ' ? 'Space' : ev.key,
          mods: modsOf(ev),
          autoRepeat: !!ev.repeat
        });
      }
    });

    q('bvp-go').addEventListener('click', connect);
    urlIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });
    q('bvp-clip').addEventListener('click', function () {
      if (pickState && pickState.rio) pickState.rio.pullClipboard();
      else toast(t('rio.notConnected'), 'info');
    });
    // Reconnect, and a NEW tab. Both send commands, so both are no-ops until
    // there is a socket — `connect()` opens one on the URL that is in the bar,
    // which is the same rule the Go button follows.
    q('bvp-resync').addEventListener('click', function () {
      if (!pickState.ws || pickState.ws.readyState !== WebSocket.OPEN) { connect(); return; }
      setStatus(t('bvp.recovering'), 'warn');
      send({ t: 'resync' });
    });
    // Restart the real Chrome. Relaunching it kills every page in it, including
    // the one we are streaming, so the resync afterwards is not optional — it is
    // what stops the canvas being left on a frozen last frame of a page whose
    // browser no longer exists (the exact symptom this whole fix is about).
    // Dismiss the heal panel. This does NOT cancel anything: the restart runs on
    // the server and finishes whether or not this panel is watching, which is
    // exactly why dismissing is safe to offer. What it returns is the canvas —
    // the difference between "the app is busy" and "the app is stuck" is whether
    // the user has any move at all.
    q('bvp-heal-close').addEventListener('click', function () {
      hideHeal();
      toast(t('bvp.healDismissed'), 'info');
    });
    q('bvp-restart').addEventListener('click', function () {
      var b = q('bvp-restart');
      if (b.disabled) return;                      // a relaunch takes seconds
      b.disabled = true;
      setStatus(t('bvp.restarting'), 'warn');
      // Show the checklist BEFORE the request, not after it returns. The whole
      // failure this replaces was a wait with nothing on screen: the user
      // pressed a button, saw no change, and concluded it had not worked. An
      // empty-but-visible panel already answers "yes, something is happening".
      // NO ETA on this first line, deliberately. The 6000ms that used to be here
      // was invented on the client, while the server publishes real measured
      // budgets per step; the two disagreed, and the client's guess was the one
      // on screen. A restart actually completes in ~0.5-1.3s here, so "about 6
      // seconds" was wrong even when everything worked — and wrong for ever when
      // it did not. An indeterminate spinner promises nothing and so cannot lie;
      // the moment the server answers, `r.steps` replaces this with its own
      // honest numbers.
      showHeal([{ key: 'startingChrome', state: 'running', index: 1, total: 3 }]);
      // The panel is now on a lease: if this POST never settles, the panel comes
      // down by itself and says so, instead of stranding the user under it.
      setHealLease('press');
      window.API.post('/browser/restart', {})
        .then(function (r) {
          if (!r || r.success === false) throw new Error((r && (r.error || r.message)) || 'restart failed');
          // The route returns the REAL steps it took, each already finished.
          // Rendering them is what turns "it says it worked" into "here is what
          // it did" — and it is the same renderer the live progress uses, so the
          // two can never disagree.
          if (r.steps && r.steps.length) showHeal(r.steps);
          setTimeout(hideHeal, 1800);
          toast(t('bvp.restarted'), 'success');
          // Chrome is new, so the old page handle is gone whatever it says.
          if (pickState) {
            if (pickState.ws && pickState.ws.readyState === WebSocket.OPEN) send({ t: 'resync' });
            else connect();
          }
        })
        .catch(function (e) {
          // Name the reason. "Restart failed" with no cause is what sent the
          // user round in circles when Real Chrome was simply switched off.
          showHeal([{ key: 'startingChrome', state: 'failed', index: 1, total: 1,
            detail: (e && e.message) || '' }]);
          setTimeout(hideHeal, 6000);
          setStatus(t('bv.error'), 'bad');
          toast((e && e.message) || t('bvp.restartFailed'), 'error');
        })
        .then(function () { b.disabled = false; });
    });
    // The + button. It goes through `newTab()` so that it, Ctrl+T and the tab
    // context menu are literally the same code path — three entry points that
    // drift apart is how "the plus button doesn't work" happens.
    q('bvp-tabadd').addEventListener('click', function () { newTab(); });
    // Middle-clicking + reopens the last closed tab, which is Chrome's own
    // shortcut for it and the only mouse-only route to Ctrl+Shift+T.
    q('bvp-tabadd').addEventListener('mousedown', function (ev) {
      if (ev.button === 1) { ev.preventDefault(); send({ t: 'tabReopen' }); }
    });
    // Right-clicking empty strip space also offers "reopen closed tab", exactly
    // like Chrome — the one place a user looks for it without knowing the key.
    q('bvp-tabstrip').addEventListener('contextmenu', function (ev) {
      // Only the empty area: a chip has its own, richer menu.
      if (ev.target.closest && ev.target.closest('.bvp-tabitem')) return;
      ev.preventDefault();
      openCtx(ev.clientX, ev.clientY, [
        { label: t('bvp.newTab'), icon: 'plus', run: function () { newTab(); } },
        { label: t('bvp.tabReopen'), icon: 'history',
          run: function () { send({ t: 'tabReopen' }); } }
      ]);
    });

    // ── Zoom ──────────────────────────────────────────────────────────────
    // The server is the source of truth: it applies the step and echoes the
    // level back in a `zoom` event, which is what updates the label and the
    // divisor. Guessing locally would let the two drift, and a wrong divisor
    // means every click lands somewhere the user did not aim.
    q('bvp-zoomin').addEventListener('click', function () { send({ t: 'zoom', dir: 'in' }); });
    q('bvp-zoomout').addEventListener('click', function () { send({ t: 'zoom', dir: 'out' }); });
    q('bvp-zoomlvl').addEventListener('click', function () { send({ t: 'zoom', level: 1 }); });

    // ── The page's dialogs ────────────────────────────────────────────────
    q('bvp-dlg-yes').addEventListener('click', function () { answerDialog(true); });
    q('bvp-dlg-no').addEventListener('click', function () { answerDialog(false); });
    // Enter in a prompt() field submits it, because that is what Enter does in
    // every dialog anyone has ever used.
    q('bvp-dlg-input').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); answerDialog(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); answerDialog(false); }
    });
    // Deliberately NO backdrop-click-to-dismiss on either modal. A page dialog
    // is a question the page is BLOCKED on; dismissing it by clicking near it
    // would answer on the user's behalf, and for `beforeunload` that answer
    // could throw away their unsaved work.

    // ── Credentials ───────────────────────────────────────────────────────
    q('bvp-auth-yes').addEventListener('click', function () { answerAuth(true); });
    q('bvp-auth-no').addEventListener('click', function () { answerAuth(false); });
    ['bvp-auth-user', 'bvp-auth-pass'].forEach(function (id) {
      q(id).addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); answerAuth(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); answerAuth(false); }
      });
    });

    // ── The download shelf ────────────────────────────────────────────────
    q('bvp-shelf-hide').addEventListener('click', function () {
      // Hide, do not clear. Chrome's shelf close button leaves the files alone,
      // and deleting the bytes because the user tidied the bar away would be a
      // surprise with no undo.
      pickState.shelfHidden = true;
      renderShelf();
    });
    q('bvp-shelf-clear').addEventListener('click', function () {
      // Clear DOES delete the bytes on the server — a cookie export is
      // credentials, and leaving it on disk because the row was dismissed is
      // the wrong default.
      pickState.downloads.forEach(function (d) {
        if (d.token) send({ t: 'downloadClear', token: d.token });
      });
      pickState.downloads = [];
      renderShelf();
    });

    /**
     * The shelf's "upload from your computer" button.
     *
     * TWO MEASURED BUGS FIXED HERE
     * ----------------------------
     * 1. WIRING. This whole block used to sit INSIDE the
     *    `pickState.downloads.forEach(...)` callback above — the braces closed in
     *    the wrong order, so the listener was only ever attached as a side
     *    effect of pressing Clear, and only when the shelf was non-empty:
     *
     *        upload INSIDE forEach callback: true
     *        downloads=0: upload listener attached 0 time(s) (after 1 Clear click)
     *        downloads=1: upload listener attached 1 time(s) (after 1 Clear click)
     *
     *    In other words: on a fresh shelf the button was inert, and the only way
     *    to arm it was to first delete the very downloads you had. It is now a
     *    sibling of the other shelf bindings, so it is wired exactly once, when
     *    the shelf is built.
     *
     * 2. WRONG BROWSER. It sent `t: 'newTab'` over the WebSocket, which is
     *    doubly wrong:
     *      • the server has no such case — it handles `tabNew` (measured:
     *        `case 'newTab': false`, `case 'tabNew': true`), and an unknown `t`
     *        is dropped in silence, so the click did nothing and said nothing;
     *      • even had the name been right, a tab command opens the page in the
     *        SERVER's Chrome, whose file dialog is drawn by the server's window
     *        manager (never visible in the screencast) and browses the server's
     *        disk (never where the user's file is). That is precisely the
     *        failure RemoteIO exists to remove — see the header of
     *        public/js/remote-io.js.
     *
     *    "Upload from your computer" must therefore open in the USER's browser:
     *    a normal local tab.
     *
     * The key stays out of the URL: remote-upload.html already falls back to
     * `localStorage.ab_api_key`, which this same origin holds, so passing it as
     * a query parameter only copied a whole-instance credential into browser
     * history and the address bar for no gain.
     *
     * `userId` IS passed, because it is not a secret and it must match the id
     * this socket runs as — remote-upload.html would otherwise default to
     * 'admin' and store the bytes in a directory the session never reads, which
     * fails as a bare ENOENT (see uploadFile's comment in remote-io.js).
     */
    var uploadBtn = q('bvp-shelf-upload');
    if (uploadBtn && !uploadBtn._bound) {
      uploadBtn._bound = true;
      uploadBtn.addEventListener('click', function () {
        var url = '/remote-upload.html?userId=' + encodeURIComponent(effectiveUserId());
        window.open(url, '_blank', 'noopener');
      });
    }

    // A context menu closes on the next click anywhere, on scroll, and on a
    // window resize — the three things that make its position meaningless.
    document.addEventListener('mousedown', function (ev) {
      if (!pickState || !pickState.ctxOpen) return;
      var host = q('bvp-ctx');
      if (host && host.contains(ev.target)) return;
      closeCtx();
    });
    q('bvp-close').addEventListener('click', closePick);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) closePick();      // click the backdrop = cancel
    });
    modeSel.addEventListener('change', function () {
      pickState.mode = modeSel.value === 'xpath' ? 'xpath' : 'css';
      pickState.edited = false;
      if (pickState.last) selIn.value = selectorOf(pickState.last);
    });
    selIn.addEventListener('input', function () { pickState.edited = true; });
    q('bvp-up').addEventListener('click', function () { send({ t: 'pickStep', dir: 'up' }); });
    q('bvp-down').addEventListener('click', function () { send({ t: 'pickStep', dir: 'down' }); });
    q('bvp-verify').addEventListener('click', function () {
      send({ t: 'verify', selector: selIn.value || '' });
    });
    q('bvp-copy').addEventListener('click', function () { copyVal(selIn); });
    q('bvp-eye').addEventListener('click', function () {
      applySelectMode(!pickState.selectMode);
    });
    var minBtn = q('bvp-min-btn');
    if (minBtn) {
      minBtn.addEventListener('click', function () {
        var panel = q('bvp-panel');
        if (!panel) return;
        var min = panel.classList.toggle('is-minimized');
        minBtn.setAttribute('aria-expanded', min ? 'false' : 'true');
        minBtn.setAttribute('title', min ? esc(t('bvp.restore', 'Restore panel')) : esc(t('bvp.minimize', 'Minimize panel')));
      });
    }
    // ── History and reload ────────────────────────────────────────────────
    // Each one refuses when there is no socket instead of sending into the void.
    // That silent no-op is most of what "the back/forward/refresh buttons don't
    // work" was: before a page is open there is nothing to go back FROM, but the
    // button gave no sign of that, so it looked broken rather than inapplicable.
    function navCmd(cmd, extra) {
      if (!pickState.ws || pickState.ws.readyState !== WebSocket.OPEN) {
        toast(t('rio.notConnected'), 'info');
        return;
      }
      var m = { t: cmd };
      if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
      // Optimistic busy state, so the press is acknowledged on the very next
      // frame rather than whenever the server gets round to `navStart`. It is a
      // LEASE, not a promise — see setNavBusy: a command that never reaches the
      // server must not be able to leave the spinner running forever. 'press' is
      // the short phase; `navStart` upgrades it to the long one.
      setNavBusy(true, 'press');
      send(m);
    }
    q('bvp-back').addEventListener('click', function () { navCmd('back'); });
    q('bvp-fwd').addEventListener('click', function () { navCmd('forward'); });
    q('bvp-reload').addEventListener('click', function () { navCmd('reload'); });
    // Shift+click / Ctrl+click on Reload is Chrome's cache-bypassing reload.
    // It has to be on the same button, because that is where the user's hand
    // already is when a page is serving them something stale.
    q('bvp-reload').addEventListener('mousedown', function (ev) {
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        navCmd('reload', { hard: true });
      }
    });
    // Right-clicking Reload offers the hard reload as a named entry, because a
    // modifier nobody told you about is not a feature.
    q('bvp-reload').addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      openCtx(ev.clientX, ev.clientY, [
        { label: t('bvp.cmReload'), icon: 'rotate-cw',
          run: function () { navCmd('reload'); } },
        { label: t('bvp.reloadHard'), icon: 'rotate-ccw',
          run: function () { navCmd('reload', { hard: true }); } }
      ]);
    });
    q('bvp-tab-attrs').addEventListener('click', function () { setPane('attrs'); });
    q('bvp-tab-cands').addEventListener('click', function () { setPane('cands'); });
    // The persistent session must be resettable from the same window that created
    // it. Otherwise "sign in inside this modal" is a one-way door: the next user
    // of this browser profile inherits the previous account.
    q('bvp-forget').addEventListener('click', function () {
      send({ t: 'forgetSession' });
    });
    // The Real Chrome panel needs a way to point THIS canvas at a URL, because
    // its most useful action — "open the extension's popup here" — is a
    // navigation to a chrome-extension:// page. Handing it `send` directly would
    // leak the socket, so it gets one narrow callback instead.
    var chromeBtn = q('bvp-chrome');
    if (chromeBtn) {
      chromeBtn.addEventListener('click', function () {
        if (!window.RealChromePanel) return;
        window.RealChromePanel.open({
          anchor: chromeBtn,
          // Which page the extension is being opened FOR. The URL field tracks
          // the canvas (see the `msg.url` handlers), so it is the live answer,
          // and it is read at click time rather than captured here because the
          // panel can stay open while the canvas navigates.
          pageUrl: function () { return (urlIn.value || '').trim(); },
          onNavigate: function (url) {
            urlIn.value = url;
            // ── A NEW TAB, not this one ─────────────────────────────────────
            // This is the exact line that made issue 2 destructive. "Open here"
            // is almost always an extension popup (chrome-extension://…), and
            // the extension is being opened FOR the page in the current tab — a
            // cookie importer is imported into the site you are trying to reach.
            // Navigating the active tab to the popup therefore threw away the
            // very page the user wanted the cookies for, along with any state it
            // held, and the only way back was retyping the URL by hand.
            //
            // Real Chrome opens an extension's page in a new tab. So do we now.
            if (pickState.ws && pickState.ws.readyState === WebSocket.OPEN) {
              send({ t: 'tabNew', url: url });
              return;
            }
            // No socket yet: opening the panel before ever connecting is a
            // perfectly normal order of operations, and send() on a socket that
            // was never created is a silent no-op that leaves the canvas blank
            // and the status stuck on "Disconnected" (caught by
            // tools/probe-real-chrome-ui.js). connect() creates it, and the
            // first tab IS a new tab.
            connect();
          },
        });
      });
    }
    q('bvp-use').addEventListener('click', function () {
      var val = (selIn.value || '').trim();
      if (!val) { selIn.focus(); return; }
      var cb = pickState.onPicked;
      closePick();
      cb(val);
    });

    // ---- dragging the panel out of the way ------------------------------
    // The panel floats over the page image, so it must be movable. Two rules,
    // both learned from measuring this (tools/picker-probe2.js):
    //
    //  1. Clamp the WHOLE panel inside the stage, not just 40px of it. The old
    //     `min(stage.width - 40, x)` let the user park the panel 266px outside
    //     the stage, and `overflow: hidden` then ate the selector field and the
    //     "Use this selector" button — the panel's own primary action became
    //     unreachable with no way back except reopening the picker.
    //  2. Read the stage rect on every move, never once at mousedown, and
    //     re-clamp on resize. Inline left/top are absolute pixels: after the
    //     window shrank, a panel placed at left:1238px stayed there and ended up
    //     682px outside an 862px-wide stage.
    function placePanel(x, y) {
      var s = stage.getBoundingClientRect();
      var p = panel.getBoundingClientRect();
      var maxX = Math.max(0, s.width - p.width);
      var maxY = Math.max(0, s.height - p.height);
      panel.style.left = Math.max(0, Math.min(maxX, x)) + 'px';
      panel.style.top = Math.max(0, Math.min(maxY, y)) + 'px';
      // The stylesheet positions the panel with `inset-inline-end`, which maps to
      // `right` in LTR but `left` in RTL. Clearing `right` alone would leave the
      // fa layout fighting our inline `left`, so clear the LOGICAL property.
      panel.style.insetInlineEnd = 'auto';
    }
    // Keep the panel inside the stage when the stage itself changes size, so a
    // dragged panel can never be stranded off-screen.
    function reclampPanel() {
      if (!panel.style.left && !panel.style.top) return;   // still at its default
      var s = stage.getBoundingClientRect();
      var p = panel.getBoundingClientRect();
      placePanel(p.left - s.left, p.top - s.top);
    }

    var drag = null;
    q('bvp-drag').addEventListener('mousedown', function (ev) {
      var r = panel.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!drag || !pickState) return;
      var s = stage.getBoundingClientRect();
      placePanel(ev.clientX - s.left - drag.dx, ev.clientY - s.top - drag.dy);
    });
    document.addEventListener('mouseup', function () { drag = null; });
    pickState.onResize = reclampPanel;
    window.addEventListener('resize', reclampPanel);

    pickState.onKeyDoc = function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); closePick(); }
    };
    document.addEventListener('keydown', pickState.onKeyDoc, true);

    setStatus(t('bv.disconnected'), '');
    renderAttrs(null);
    renderCands(null);
    renderTabs([], '');  // empty strip until the server sends the real list
    setSession(false);   // pessimistic until the server's `ready` says otherwise
    resumeHeal();        // is a restart already running? then show THAT, not a guess
    if (urlIn.value) connect(); else urlIn.focus();
  }

  // Shared clipboard helper (used by the modal; render() has its own closure
  // copy because it also selects the readonly result fields).
  function copyVal(input) {
    try {
      input.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value);
      } else {
        document.execCommand('copy');
      }
      toast(t('bv.copied'), 'success');
    } catch (e) { toast(t('bv.copyFail'), 'error'); }
  }

  // Copy a bare string (an attribute value). copyVal() cannot serve here: it
  // select()s an input, and the attribute values live in spans. The textarea
  // fallback keeps this working on http:// origins, where navigator.clipboard
  // is undefined — the dev preview is one of those.
  function copyText(str) {
    var s = String(str == null ? '' : str);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s);
      } else {
        var ta = document.createElement('textarea');
        ta.value = s;
        ta.setAttribute('readonly', 'readonly');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(t('bv.copied'), 'success');
    } catch (e) { toast(t('bv.copyFail'), 'error'); }
  }

  function stop() {
    if (state && state.ws) { try { state.ws.close(); } catch (e) {} }
    state = null;
    closePick();
  }

  window.BrowserView = { render: render, stop: stop, requestPick: requestPick };
})();
