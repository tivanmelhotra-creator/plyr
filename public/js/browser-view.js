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

  function stop() {
    if (state && state.ws) { try { state.ws.close(); } catch (e) {} }
    state = null;
  }

  window.BrowserView = { render: render, stop: stop };
})();
