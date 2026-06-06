/* ============================================
   Shareable live-view page (Step 29).
   Standalone, CSP-safe (no inline handlers, no eval). Connects to a job's
   live event stream using a share token (or api_key) taken from the URL,
   then renders node-by-node progress + each step's output summary.

   URL shape: /live/view/:userId/:jobId?share=<token>  (or ?api_key=...)
   ============================================ */
(function () {
  'use strict';

  // ---- locate ids + auth from the path/query (no app login needed) ----
  function parseLocation() {
    var parts = location.pathname.split('/').filter(Boolean); // ["live","view",userId,jobId]
    var userId = parts.length >= 4 ? decodeURIComponent(parts[2]) : '';
    var jobId = parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
    var qs = new URLSearchParams(location.search);
    return {
      userId: userId,
      jobId: jobId,
      share: qs.get('share') || '',
      apiKey: qs.get('api_key') || ''
    };
  }

  var ctx = parseLocation();

  // ---- DOM helpers ----
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function setStatus(state, text) {
    var dot = $('lv-status-dot');
    var txt = $('lv-status-text');
    if (dot) dot.className = 'lv-dot lv-dot-' + state;
    if (txt && text) txt.textContent = text;
  }
  function showError(msg) {
    var e = $('lv-error');
    if (e) { e.textContent = msg; e.hidden = false; }
  }

  // ---- transport: WebSocket first, SSE fallback (share-token aware) ----
  function authQuery() {
    var q = '';
    if (ctx.share) q += '&share=' + encodeURIComponent(ctx.share);
    else if (ctx.apiKey) q += '&api_key=' + encodeURIComponent(ctx.apiKey);
    return q;
  }

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/live/ws?userId=' +
      encodeURIComponent(ctx.userId) + '&jobId=' + encodeURIComponent(ctx.jobId) +
      authQuery();
  }
  function sseUrl() {
    var u = '/live/sse/' + encodeURIComponent(ctx.userId) + '/' + encodeURIComponent(ctx.jobId);
    var q = authQuery();
    if (q) u += '?' + q.slice(1);
    return u;
  }

  var closed = false;
  function dispatch(raw) {
    var ev;
    try { ev = JSON.parse(raw); } catch (e) { return; }
    if (ev && ev.type) handleEvent(ev);
  }

  function connect() {
    setStatus('connecting');
    var WS = window.WebSocket;
    if (WS) {
      var ws;
      try { ws = new WS(wsUrl()); } catch (e) { ws = null; }
      if (ws) {
        ws.onopen = function () { setStatus('open', t('live.connected', 'متصل')); };
        ws.onmessage = function (m) { dispatch(m.data); };
        ws.onclose = function () { if (!closed) fallbackSSE(); };
        ws.onerror = function () { try { ws.close(); } catch (e) {} };
        return;
      }
    }
    fallbackSSE();
  }

  function fallbackSSE() {
    if (closed) return;
    var ES = window.EventSource;
    if (!ES) { setStatus('error', t('live.noTransport', 'اتصال زنده پشتیبانی نمی‌شود')); return; }
    var es = new ES(sseUrl());
    es.onopen = function () { setStatus('open', t('live.connected', 'متصل')); };
    es.onmessage = function (m) { dispatch(m.data); };
    es.onerror = function () { setStatus('error', t('live.connError', 'خطای اتصال')); };
  }

  // ---- minimal i18n (page is standalone; default fa, fall back to literal) ----
  var STR = {
    fa: {
      'live.connected': 'متصل',
      'live.connError': 'خطای اتصال — دسترسی نامعتبر یا منقضی‌شده',
      'live.noTransport': 'اتصال زنده پشتیبانی نمی‌شود',
      'live.done': 'اجرا کامل شد',
      'live.failed': 'اجرا ناموفق بود',
      'live.running': 'در حال اجرا…',
      'live.itemsIn': 'ورودی',
      'live.itemsOut': 'خروجی',
      'live.step': 'گام'
    }
  };
  function t(key, fallback) {
    var d = STR.fa;
    return (d && d[key]) || fallback || key;
  }

  // ---- per-step rendering ----
  var stepNodes = {}; // index -> row element

  function ensureRow(index, action) {
    if (stepNodes[index]) return stepNodes[index];
    var root = $('lv-steps');
    var row = el('div', 'lv-step lv-step-pending');
    var head = el('div', 'lv-step-head');
    head.appendChild(el('span', 'lv-step-idx', t('live.step', 'گام') + ' ' + index));
    head.appendChild(el('span', 'lv-step-action', action || ''));
    var state = el('span', 'lv-step-state', '…');
    head.appendChild(state);
    row.appendChild(head);
    var body = el('div', 'lv-step-body');
    row.appendChild(body);
    root.appendChild(row);
    var rec = { row: row, state: state, body: body, action: action };
    stepNodes[index] = rec;
    return rec;
  }

  function renderSample(body, ev) {
    body.textContent = '';
    var meta = el('div', 'lv-step-meta');
    if (typeof ev.inputItemCount === 'number') {
      meta.appendChild(el('span', 'lv-chip', t('live.itemsIn', 'ورودی') + ': ' + ev.inputItemCount));
    }
    if (typeof ev.outputItemCount === 'number') {
      meta.appendChild(el('span', 'lv-chip', t('live.itemsOut', 'خروجی') + ': ' + ev.outputItemCount));
    }
    if (typeof ev.durationMs === 'number') {
      meta.appendChild(el('span', 'lv-chip', ev.durationMs + 'ms'));
    }
    body.appendChild(meta);
    if (ev.outputSample !== undefined) {
      var pre = el('pre', 'lv-sample');
      try { pre.textContent = JSON.stringify(ev.outputSample, null, 2); }
      catch (e) { pre.textContent = String(ev.outputSample); }
      if (ev.outputTruncated) pre.appendChild(el('span', 'lv-trunc', ' …'));
      body.appendChild(pre);
    }
    if (ev.error) {
      body.appendChild(el('div', 'lv-step-err', ev.error));
    }
  }

  function handleEvent(ev) {
    var d = ev.data || {};
    switch (ev.type) {
      case 'job.start':
        $('lv-meta').textContent = 'job ' + (ev.jobId || ctx.jobId);
        setStatus('open', t('live.running', 'در حال اجرا…'));
        break;
      case 'step.start': {
        var rec = ensureRow(d.index, d.action);
        rec.row.className = 'lv-step lv-step-running';
        rec.state.textContent = '⏳';
        break;
      }
      case 'step.retry': {
        var r2 = ensureRow(d.index, d.action);
        r2.row.className = 'lv-step lv-step-running';
        r2.state.textContent = '↻ ' + (d.attempt || '') + '/' + (d.maxTries || '');
        if (d.error) renderSample(r2.body, d);
        break;
      }
      case 'step.done': {
        var r3 = ensureRow(d.index, d.action);
        r3.row.className = 'lv-step ' + (d.success === false ? 'lv-step-error' : 'lv-step-done');
        r3.state.textContent = d.success === false ? '✗' : '✓';
        renderSample(r3.body, d);
        break;
      }
      case 'step.error': {
        var r4 = ensureRow(d.index, d.action);
        r4.row.className = 'lv-step lv-step-error';
        r4.state.textContent = '✗';
        renderSample(r4.body, d);
        break;
      }
      case 'job.done':
        setStatus('done', t('live.done', 'اجرا کامل شد'));
        break;
      case 'job.error':
        setStatus('error', t('live.failed', 'اجرا ناموفق بود'));
        if (d.message) showError(String(d.message));
        break;
      default:
        break;
    }
  }

  // ---- boot ----
  function boot() {
    if (!ctx.userId || !ctx.jobId) {
      setStatus('error');
      showError('Missing userId/jobId in URL');
      return;
    }
    var meta = $('lv-meta');
    if (meta) meta.textContent = 'job ' + ctx.jobId;
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
