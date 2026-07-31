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
    if (ps.overlay && ps.overlay.parentNode) ps.overlay.parentNode.removeChild(ps.overlay);
  }

  function pickerMarkup() {
    return '' +
      '<div class="bvp-shell" role="dialog" aria-modal="true">' +
        '<div class="bvp-bar">' +
          '<span class="bvp-bar-title">' + BIC('target', 15) + ' ' + esc(t('bvp.title')) + '</span>' +
          '<input class="field-input bvp-url" id="bvp-url" type="text" ' +
            'placeholder="https://example.com" autocomplete="off" spellcheck="false">' +
          '<button class="btn btn-primary btn-sm" id="bvp-go">' + esc(t('bv.go')) + '</button>' +
          '<span class="badge bvp-status" id="bvp-status">—</span>' +
          '<button class="icon-btn bvp-close" id="bvp-close" type="button" ' +
            'title="' + esc(t('bvp.cancel')) + '" aria-label="' + esc(t('bvp.cancel')) + '">' +
            BIC('x', 15) + '</button>' +
        '</div>' +
        '<div class="bvp-stage" id="bvp-stage" tabindex="0">' +
          '<canvas class="bvp-canvas" id="bvp-canvas"></canvas>' +
          '<div class="bvp-empty" id="bvp-empty">' + esc(t('bvp.needUrl')) + '</div>' +
          '<div class="bvp-panel" id="bvp-panel">' +
            '<div class="bvp-panel-head" id="bvp-drag">' +
              '<span class="bvp-panel-title">' + esc(t('bvp.title')) + '</span>' +
              '<button class="icon-btn" id="bvp-ghost" type="button" ' +
                'title="' + esc(t('bvp.seeThrough')) + '">' + BIC('eye', 14) + '</button>' +
            '</div>' +
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
              '<input class="field-input bvp-sel" id="bvp-sel" type="text" ' +
                'spellcheck="false" autocomplete="off" ' +
                'placeholder="' + esc(t('bvp.selPlaceholder')) + '">' +
              '<button class="icon-btn" id="bvp-verify" type="button" ' +
                'title="' + esc(t('bvp.verify')) + '">' + BIC('check', 14) + '</button>' +
              '<button class="icon-btn" id="bvp-copy" type="button" ' +
                'title="' + esc(t('bvp.copy')) + '">' + BIC('copy', 14) + '</button>' +
            '</div>' +
            '<div class="bvp-count" id="bvp-count"></div>' +
            '<div class="bvp-panel-sub">' + esc(t('bvp.attributes')) + '</div>' +
            '<div class="bvp-attrs" id="bvp-attrs"></div>' +
            '<div class="bvp-panel-foot">' +
              '<button class="btn btn-primary btn-sm" id="bvp-use">' +
                esc(t('bvp.use')) + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<p class="bvp-hint">' + esc(t('bvp.hint')) + '</p>' +
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
    var ctx = canvas.getContext('2d');

    pickState = {
      ws: null, overlay: overlay, onPicked: onPicked,
      last: null,      // last payload (hover or pick)
      locked: false,   // a click/traversal happened → stop following the pointer
      edited: false,   // the user typed in the field → stop overwriting it
      mode: (o.mode === 'xpath' ? 'xpath' : 'css'),
      onKeyDoc: null
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
    function renderAttrs(list) {
      attrsEl.innerHTML = '';
      if (!list || !list.length) {
        attrsEl.appendChild(rowEl('muted bvp-attr-empty', t('bvp.noAttrs'), ''));
        return;
      }
      list.forEach(function (a) {
        attrsEl.appendChild(rowEl('bvp-attr', a.name, a.value));
      });
    }
    function rowEl(cls, name, value) {
      var d = document.createElement('div');
      d.className = cls;
      if (!value && !name) return d;
      var k = document.createElement('span');
      k.className = 'bvp-attr-name';
      k.textContent = name;
      d.appendChild(k);
      if (value !== '') {
        var v = document.createElement('span');
        v.className = 'bvp-attr-value';
        v.textContent = value;
        d.appendChild(v);
      }
      return d;
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
          send({ t: 'picker', on: true });      // the picker IS the point here
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
    stage.addEventListener('keydown', function (ev) {
      if (ev.key === ' ' || ev.code === 'Space') { ev.preventDefault(); send({ t: 'key', key: 'Space' }); }
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
    q('bvp-ghost').addEventListener('click', function () {
      panel.classList.toggle('is-ghost');
    });
    q('bvp-use').addEventListener('click', function () {
      var val = (selIn.value || '').trim();
      if (!val) { selIn.focus(); return; }
      var cb = pickState.onPicked;
      closePick();
      cb(val);
    });

    // Drag the panel out of the way (it sits over the page image).
    var drag = null;
    q('bvp-drag').addEventListener('mousedown', function (ev) {
      var r = panel.getBoundingClientRect();
      var s = stage.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, s: s };
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!drag || !pickState) return;
      panel.style.left = Math.max(0, Math.min(drag.s.width - 40, ev.clientX - drag.s.left - drag.dx)) + 'px';
      panel.style.top = Math.max(0, Math.min(drag.s.height - 40, ev.clientY - drag.s.top - drag.dy)) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { drag = null; });

    pickState.onKeyDoc = function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); closePick(); }
    };
    document.addEventListener('keydown', pickState.onKeyDoc, true);

    setStatus(t('bv.disconnected'), '');
    renderAttrs(null);
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

  function stop() {
    if (state && state.ws) { try { state.ws.close(); } catch (e) {} }
    state = null;
    closePick();
  }

  window.BrowserView = { render: render, stop: stop, requestPick: requestPick };
})();
