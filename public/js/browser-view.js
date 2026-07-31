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
      switch (msg.t) {
        case 'frame':
          drawFrame(msg.data, msg.width, msg.height);
          break;
        case 'ready':
          setStatus(t('bv.connected'), 'ok');
          hint.textContent = msg.url || '';
          setEnabled(true);
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
      state = { ws: ws, lastPick: null };
      ws.onopen = function () {
        setStatus(t('bv.connecting'), 'warn'); // wait for 'ready'
        var startUrl = (urlInput.value || '').trim();
        if (startUrl) send({ t: 'navigate', url: startUrl });
      };
      ws.onmessage = function (m) { handleMessage(m.data); };
      ws.onerror = function () { setStatus(t('bv.error'), 'bad'); };
      ws.onclose = function () {
        setStatus(t('bv.disconnected'), '');
        setEnabled(false);
        state = null;
      };
    }

    function disconnect() {
      if (state && state.ws) { try { state.ws.close(); } catch (e) {} }
      state = null;
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
    if (ps.ws) { try { ps.ws.close(); } catch (e) {} }
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
          '<button class="icon-btn bvp-close" id="bvp-close" type="button" ' +
            'title="' + esc(t('bvp.cancel')) + '" aria-label="' + esc(t('bvp.cancel')) + '">' +
            BIC('x', 15) + '</button>' +
        '</div>' +
        '<div class="bvp-stage" id="bvp-stage" tabindex="0">' +
          '<canvas class="bvp-canvas" id="bvp-canvas"></canvas>' +
          '<div class="bvp-empty" id="bvp-empty">' + esc(t('bvp.needUrl')) + '</div>' +
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
              // THE EYE IS A MODE SWITCH, not a "hide the panel" button. It used
              // to only fade the panel to 22% opacity, while the page-side picker
              // stayed injected for the whole session — which is what made this
              // window unable to browse: the injected `onClick` swallowed every
              // real click and turned it into a pick, so links never opened and
              // forms never submitted. The eye now toggles element-selection
              // mode: OFF = a real browser (click, follow links, type, scroll),
              // ON = hover outlines + click picks. See `applySelectMode()`.
              '<button class="icon-btn bvp-eye" id="bvp-eye" type="button" ' +
                'aria-pressed="false" title="">' + BIC('eye', 14) + '</button>' +
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
      onKeyDoc: null,
      onResize: null
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
    function send(obj) {
      var ps = pickState;
      if (ps && ps.ws && ps.ws.readyState === WebSocket.OPEN) {
        try { ps.ws.send(JSON.stringify(obj)); } catch (e) {}
      }
    }
    function toPoint(ev) {
      var rect = canvas.getBoundingClientRect();
      var sx = canvas.width / rect.width || 1;
      var sy = canvas.height / rect.height || 1;
      return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
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
      switch (msg.t) {
        case 'frame': drawFrame(msg.data); break;
        case 'ready':
          setStatus(t('bv.connected'), 'ok');
          setSession(msg.signedIn);             // cookies restored, or anonymous?
          // Push the CURRENT mode rather than forcing the picker on. This line
          // used to be `send({ t: 'picker', on: true })`, which is what made the
          // window un-browsable from its very first frame.
          applySelectMode(pickState.selectMode, true);
          break;
        case 'session':
          setSession(msg.signedIn);
          if (msg.cleared) toast(t('bvp.forgotten'), 'success');
          break;
        case 'navigated': setStatus(t('bv.connected'), 'ok'); break;
        case 'hover':
          if (!pickState.locked) paint(msg, false);
          break;
        case 'pick': paint(msg, true); break;
        case 'verified': renderCount(msg.count); break;
        case 'expired': setStatus(t('bv.expired'), 'warn'); break;
        case 'error': setStatus(String(msg.message || 'error'), 'bad'); break;
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
      ws.onopen = function () { send({ t: 'navigate', url: url }); };
      ws.onmessage = function (m) { onMessage(m.data); };
      ws.onerror = function () { setStatus(t('bv.error'), 'bad'); };
      ws.onclose = function () { if (pickState) setStatus(t('bv.disconnected'), ''); };
    }

    // ---- wiring ---------------------------------------------------------
    var lastMove = 0;
    canvas.addEventListener('mousemove', function (ev) {
      var now = Date.now();
      if (now - lastMove < 70) return;   // ~14 moves/sec is plenty for a preview
      lastMove = now;
      var p = toPoint(ev);
      send({ t: 'move', x: p.x, y: p.y });
    });
    canvas.addEventListener('click', function (ev) {
      var p = toPoint(ev);
      send({ t: 'click', x: p.x, y: p.y });   // the page script converts it to a pick
    });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = toPoint(ev);
      send({ t: 'scroll', x: p.x, y: p.y, dy: ev.deltaY });
    }, { passive: false });
    // Keyboard on the focused stage. In SELECT mode the keys drive the picker:
    // Space locks the hovered element and ↑/↓ walk the DOM (they live here, not
    // only on the panel buttons, because walking the DOM is done while looking at
    // the page and moving the pointer to a button is what loses your place).
    //
    // In BROWSE mode the same keys have to mean what they mean in a browser —
    // Space scrolls, arrows scroll, and typing types — otherwise "it behaves like
    // a real browser" is false the moment you try to fill in a login form.
    var NAMED_KEYS = {
      Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
      Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space'
    };
    stage.addEventListener('keydown', function (ev) {
      if (pickState.selectMode) {
        if (ev.key === ' ' || ev.code === 'Space') {
          ev.preventDefault(); send({ t: 'key', key: 'Space' });
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault(); send({ t: 'pickStep', dir: 'up' });
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault(); send({ t: 'pickStep', dir: 'down' });
        }
        return;
      }
      // Never swallow the browser's own shortcuts (copy/paste/devtools): those
      // belong to the window the user is actually sitting in.
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (NAMED_KEYS[ev.key]) {
        ev.preventDefault();
        send({ t: 'key', key: NAMED_KEYS[ev.key] });
      } else if (ev.key && ev.key.length === 1) {
        ev.preventDefault();
        send({ t: 'type', text: ev.key });
      }
    });
    canvas.addEventListener('mousedown', function () { stage.focus(); });

    q('bvp-go').addEventListener('click', connect);
    urlIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
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
    q('bvp-back').addEventListener('click', function () { send({ t: 'back' }); });
    q('bvp-fwd').addEventListener('click', function () { send({ t: 'forward' }); });
    q('bvp-reload').addEventListener('click', function () { send({ t: 'reload' }); });
    q('bvp-tab-attrs').addEventListener('click', function () { setPane('attrs'); });
    q('bvp-tab-cands').addEventListener('click', function () { setPane('cands'); });
    // The persistent session must be resettable from the same window that created
    // it. Otherwise "sign in inside this modal" is a one-way door: the next user
    // of this browser profile inherits the previous account.
    q('bvp-forget').addEventListener('click', function () {
      send({ t: 'forgetSession' });
    });
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
    setSession(false);   // pessimistic until the server's `ready` says otherwise
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
