/* ============================================
   Live channel client + view (Step 16).
   - window.LiveClient: subscribe to a job's live events
     via WebSocket, with automatic SSE fallback.
   - window.LiveView: { render(root), stop() } — a small UI
     to enter a Job ID and watch events stream in.
   CSP-safe: no inline handlers, no eval.
   ============================================ */
(function () {
  'use strict';

  // Inline SVG icon helper (public/js/icons.js). Emoji glyphs were removed
  // project-wide: the target font stack has no emoji coverage, so they rendered
  // as empty boxes, and they could not be tinted with `currentColor`.
  function LIC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : '';
  }

  var API = window.API;

  // ---------------------------------------------
  // LiveClient — transport-agnostic subscriber.
  // opts: { userId, jobId, apiKey, onEvent(ev), onStatus(status, transport) }
  // status: 'connecting' | 'open' | 'closed' | 'error'
  // ---------------------------------------------
  function LiveClient(opts) {
    this.userId = String(opts.userId);
    this.jobId = String(opts.jobId);
    this.apiKey = opts.apiKey || '';
    this.onEvent = opts.onEvent || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.ws = null;
    this.sse = null;
    this.closed = false;
    this.transport = null;
  }

  LiveClient.prototype._wsUrl = function () {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var q =
      'userId=' + encodeURIComponent(this.userId) +
      '&jobId=' + encodeURIComponent(this.jobId);
    if (this.apiKey) q += '&api_key=' + encodeURIComponent(this.apiKey);
    return proto + '//' + location.host + '/live/ws?' + q;
  };

  LiveClient.prototype._sseUrl = function () {
    var u =
      '/live/sse/' + encodeURIComponent(this.userId) +
      '/' + encodeURIComponent(this.jobId);
    if (this.apiKey) u += '?api_key=' + encodeURIComponent(this.apiKey);
    return u;
  };

  LiveClient.prototype._dispatch = function (raw) {
    var ev;
    try { ev = JSON.parse(raw); } catch (e) { return; }
    if (ev && ev.type) this.onEvent(ev);
  };

  LiveClient.prototype.connect = function () {
    var self = this;
    self.closed = false;
    self.onStatus('connecting', null);

    // Try WebSocket first.
    var WS = window.WebSocket;
    if (!WS) { self._connectSse(); return; }

    var ws;
    try {
      ws = new WS(self._wsUrl());
    } catch (e) {
      self._connectSse();
      return;
    }
    self.ws = ws;
    self.transport = 'ws';

    var opened = false;
    ws.onopen = function () {
      opened = true;
      self.onStatus('open', 'ws');
    };
    ws.onmessage = function (m) { self._dispatch(m.data); };
    ws.onerror = function () {
      // If we never opened, fall back to SSE.
      if (!opened && !self.closed) {
        try { ws.close(); } catch (e) {}
        self.ws = null;
        self._connectSse();
      }
    };
    ws.onclose = function () {
      if (self.closed) return;
      if (!opened) {
        // never connected -> fallback
        self._connectSse();
      } else {
        self.onStatus('closed', 'ws');
      }
    };
  };

  LiveClient.prototype._connectSse = function () {
    var self = this;
    if (self.closed) return;
    var ES = window.EventSource;
    if (!ES) { self.onStatus('error', null); return; }
    self.onStatus('connecting', 'sse');
    var sse;
    try {
      sse = new ES(self._sseUrl());
    } catch (e) {
      self.onStatus('error', 'sse');
      return;
    }
    self.sse = sse;
    self.transport = 'sse';
    sse.onopen = function () { self.onStatus('open', 'sse'); };
    sse.onmessage = function (m) { self._dispatch(m.data); };
    sse.onerror = function () {
      if (self.closed) return;
      // EventSource auto-reconnects; surface a soft error status.
      self.onStatus('error', 'sse');
    };
  };

  LiveClient.prototype.close = function () {
    this.closed = true;
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.sse) { try { this.sse.close(); } catch (e) {} this.sse = null; }
    this.onStatus('closed', this.transport);
  };

  window.LiveClient = LiveClient;

  // ---------------------------------------------
  // LiveView — UI wrapper around LiveClient.
  // ---------------------------------------------
  var current = null; // active LiveClient for cleanup on navigation

  function t(k) {
    return (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
  }
  function esc(s) {
    if (window.AppUtil && window.AppUtil.esc) return window.AppUtil.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function effectiveUserId() {
    var uid = API.getUserId();
    if (!uid || uid === 'env_root') return '0';
    return uid;
  }

  var EVENT_META = {
    'job.start':  { i18n: 'live.evt.jobStart',  cls: 'live-info',  icon: 'rocket' },
    'job.done':   { i18n: 'live.evt.jobDone',   cls: 'live-ok',    icon: 'check-circle' },
    'job.error':  { i18n: 'live.evt.jobError',  cls: 'live-err',   icon: 'x-circle' },
    'step.start': { i18n: 'live.evt.stepStart', cls: 'live-step',  icon: 'play' },
    'step.done':  { i18n: 'live.evt.stepDone',  cls: 'live-ok',    icon: 'square-check' },
    'step.error': { i18n: 'live.evt.stepError', cls: 'live-err',   icon: 'alert-circle' },
    'log':        { i18n: 'live.evt.log',       cls: 'live-log',   icon: 'file-text' }
  };

  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString();
    } catch (e) { return ''; }
  }

  function eventSummary(ev) {
    var d = ev.data || {};
    if (ev.type === 'log') return String(d.message != null ? d.message : '');
    if (ev.type === 'step.start') {
      return '#' + (d.index != null ? d.index : '?') + ' · ' + (d.action || '');
    }
    if (ev.type === 'step.done') {
      var ok = d.success ? '+' : '-';
      var dur = d.durationMs != null ? (' · ' + d.durationMs + 'ms') : '';
      return '#' + (d.index != null ? d.index : '?') + ' · ' + (d.action || '') + ' ' + ok + dur;
    }
    if (ev.type === 'step.error') {
      return '#' + (d.index != null ? d.index : '?') + ' · ' + (d.action || '') + ' — ' + (d.message || '');
    }
    if (ev.type === 'job.done') {
      return d.durationMs != null ? (d.durationMs + 'ms') : '';
    }
    if (ev.type === 'job.error') {
      return String(d.message || d.reason || '');
    }
    if (ev.type === 'job.start') {
      return (d.isVip ? 'VIP' : 'Free') + (d.lock ? ' · lock' : '');
    }
    return '';
  }

  function render(root) {
    stop(); // ensure no stale connection

    var html =
      '<div class="card">' +
        '<h3 class="card-title">' + LIC('terminal') + ' ' + esc(t('live.title')) + '</h3>' +
        '<p class="muted">' + esc(t('live.subtitle')) + '</p>' +
        '<div class="form-row" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:180px;">' +
            '<label class="form-label" for="live-job">' + esc(t('live.jobId')) + '</label>' +
            '<input class="input" id="live-job" type="text" placeholder="123" autocomplete="off">' +
          '</div>' +
          '<button class="btn btn-primary" id="live-connect">' + esc(t('live.connect')) + '</button>' +
          '<button class="btn btn-ghost" id="live-disconnect" disabled>' + esc(t('live.disconnect')) + '</button>' +
          '<button class="btn btn-ghost" id="live-clear">' + esc(t('live.clear')) + '</button>' +
        '</div>' +
        '<div class="live-statusbar" id="live-status" style="margin-top:.75rem;">' +
          '<span class="badge" id="live-status-badge">—</span>' +
          '<span class="muted" id="live-transport" style="margin-inline-start:.5rem;"></span>' +
        '</div>' +
      '</div>' +
      '<div class="card" style="margin-top:1rem;">' +
        '<div class="live-feed" id="live-feed" role="log" aria-live="polite" ' +
          'style="max-height:420px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem;line-height:1.5;">' +
          '<div class="muted" id="live-empty">' + esc(t('live.enterJob')) + '</div>' +
        '</div>' +
      '</div>';

    root.innerHTML = html;

    var jobInput = root.querySelector('#live-job');
    var btnConnect = root.querySelector('#live-connect');
    var btnDisconnect = root.querySelector('#live-disconnect');
    var btnClear = root.querySelector('#live-clear');
    var feed = root.querySelector('#live-feed');
    var empty = root.querySelector('#live-empty');
    var badge = root.querySelector('#live-status-badge');
    var transportEl = root.querySelector('#live-transport');

    // Prefill from ?job= in hash if present.
    var m = (location.hash || '').match(/[?&]job=([^&]+)/);
    if (m) { try { jobInput.value = decodeURIComponent(m[1]); } catch (e) {} }

    function setStatus(status, transport) {
      var label = t('live.disconnected');
      var cls = 'badge';
      if (status === 'connecting') { label = t('live.connecting'); cls = 'badge warn'; }
      else if (status === 'open') { label = t('live.connected'); cls = 'badge ok'; }
      else if (status === 'error') { label = t('live.error'); cls = 'badge bad'; }
      else if (status === 'closed') { label = t('live.disconnected'); cls = 'badge'; }
      badge.className = cls;
      badge.textContent = label;
      if (transport) {
        transportEl.textContent = '(' + (transport === 'ws' ? t('live.transportWs') : t('live.transportSse')) + ')';
      } else {
        transportEl.textContent = '';
      }
    }

    function appendEvent(ev) {
      if (empty) { empty.remove(); empty = null; }
      var meta = EVENT_META[ev.type] || { i18n: ev.type, cls: 'live-info', icon: '•' };
      var row = document.createElement('div');
      row.className = 'live-row ' + meta.cls;
      row.style.padding = '.15rem 0';
      row.style.borderBottom = '1px solid rgba(127,127,127,.12)';

      var time = document.createElement('span');
      time.className = 'muted';
      time.style.marginInlineEnd = '.5rem';
      time.textContent = fmtTime(ev.ts);

      var icon = document.createElement('span');
      icon.style.marginInlineEnd = '.35rem';
      icon.innerHTML = LIC(meta.icon, 14);

      var label = document.createElement('strong');
      label.style.marginInlineEnd = '.5rem';
      label.textContent = t(meta.i18n);

      var summary = document.createElement('span');
      summary.textContent = eventSummary(ev);

      row.appendChild(time);
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(summary);
      feed.appendChild(row);
      // autoscroll
      feed.scrollTop = feed.scrollHeight;
    }

    function disconnect() {
      if (current) { current.close(); current = null; }
      btnConnect.disabled = false;
      btnDisconnect.disabled = true;
    }

    function connect() {
      var jobId = (jobInput.value || '').trim();
      if (!jobId) { jobInput.focus(); return; }
      disconnect();
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
      current = new LiveClient({
        userId: effectiveUserId(),
        jobId: jobId,
        apiKey: API.getKey(),
        onEvent: appendEvent,
        onStatus: setStatus
      });
      current.connect();
    }

    btnConnect.addEventListener('click', connect);
    btnDisconnect.addEventListener('click', disconnect);
    btnClear.addEventListener('click', function () {
      feed.innerHTML = '<div class="muted" id="live-empty">' + esc(t('live.waiting')) + '</div>';
      empty = feed.querySelector('#live-empty');
    });
    jobInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });

    setStatus('closed', null);
  }

  function stop() {
    if (current) { try { current.close(); } catch (e) {} current = null; }
  }

  window.LiveView = { render: render, stop: stop };
})();
