/* ============================================
   Shareable live-view page.

   Standalone and CSP-safe (no inline handlers, no eval, no blob:). It is opened
   in its OWN tab by Test Workflow, addressed by a signed share token
   (/live/view/:userId/:jobId?share=...), so no API key is ever in the URL.

   Two read-only streams, both server -> client only:
     /live/sse/...     run events (LiveBus; the server replays its buffer on
                       every connect, so a reconnect catches up by itself)
     /live/frames/...  CDP screencast of the page the run is driving

   All decisions live in LiveTab / RunState (pure, unit-tested); this file only
   draws them.
   ============================================ */
(function () {
  'use strict';

  var LT = window.LiveTab;
  var RS = window.RunState;

  var STR = {
    en: {
      title: 'Live run view', steps: 'Steps', output: 'Output', readonly: 'View only. You cannot control the browser from here.',
      connecting: 'Connecting\u2026', connected: 'Connected', reconnecting: 'Reconnecting\u2026',
      running: 'Running\u2026', done: 'Run completed', partial: 'Completed with step errors', failed: 'Run failed', stopped: 'Run stopped',
      denied: 'This link is invalid or has expired. Open the run again from the editor.',
      missing: 'This address is missing the run it should show.',
      noSteps: 'Waiting for the first step\u2026', pickStep: 'Select a step to see its output.',
      noOutput: 'This step produced no output sample.', step: 'Step', items: 'items', in: 'in', out: 'out',
      follow: 'Following the latest step', pinned: 'Showing the step you picked', followBtn: 'Follow latest',
      truncated: 'Output was shortened.', browser: 'Browser',
      'lv.waitingBrowser': 'Waiting for the browser to open\u2026',
      'lv.noBrowser': 'No browser view was available for this run.',
      'lv.busy': 'Too many people are watching this run.',
      'lv.frameError': 'The browser view is unavailable.',
      'lv.ended': 'The browser has closed.',
    },
  };

  var lang = 'en';   // English only (2026-10)
  function t(k) { return (STR[lang] && STR[lang][k]) || STR.en[k] || k; }

  function IC(name, size) { return window.Icons ? window.Icons.svg(name, { size: size || 14 }) : ''; }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  var ctx = LT.parseViewLocation(location.pathname, location.search);
  var feed = LT.createFeed(RS);
  var pinned = null;
  var frameStatus = 'waiting';
  var hasFrame = false;
  var connState = 'connecting';
  var gotAnyEvent = false;
  var denied = false;

  // ---- drawing -------------------------------------------------------------

  var STATUS_ICON = { running: 'clock', success: 'check', error: 'x', stopped: 'x' };
  var STATUS_CLASS = { running: 'lv-step-running', success: 'lv-step-done', error: 'lv-step-error', stopped: 'lv-step-error' };

  function fmtMs(ms) { return ms == null ? '' : (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'); }

  function drawStatus() {
    var st = feed.state;
    var dot = 'connecting'; var text = t('connecting');
    if (denied) { dot = 'error'; text = t('denied'); }
    else if (RS.isTerminal(st)) {
      var o = RS.outcome(st);
      dot = o === 'success' ? 'done' : (o === 'stopped' ? 'done' : 'error');
      text = o === 'success' ? t('done') : o === 'partial' ? t('partial') : o === 'stopped' ? t('stopped') : t('failed');
      if (o === 'partial') dot = 'done';
    } else if (connState === 'reconnecting') { dot = 'connecting'; text = t('reconnecting'); }
    else if (connState === 'open') { dot = 'open'; text = st.phase === 'running' ? t('running') : t('connected'); }
    $('lv-status-dot').className = 'lv-dot lv-dot-' + dot;
    $('lv-status-text').textContent = text;
  }

  function drawTimeline() {
    var list = $('lv-steps');
    var rows = LT.rows(feed.state);
    var sel = LT.pickSelected(feed.state, pinned);
    list.textContent = '';
    if (!rows.length) {
      list.appendChild(el('li', 'lv-empty', denied ? '' : t('noSteps')));
      return;
    }
    rows.forEach(function (r) {
      var li = el('li', 'lv-stepitem');
      var b = el('button', 'lv-step ' + (STATUS_CLASS[r.status] || 'lv-step-pending') + (r.index === sel ? ' is-selected' : ''));
      b.type = 'button';
      b.setAttribute('data-step', String(r.index));
      b.setAttribute('aria-current', r.index === sel ? 'true' : 'false');
      var head = el('span', 'lv-step-head');
      head.appendChild(el('span', 'lv-step-idx', r.index));
      head.appendChild(el('span', 'lv-step-action', r.action));
      var state = el('span', 'lv-step-state');
      state.innerHTML = IC(STATUS_ICON[r.status] || 'clock', 13);
      head.appendChild(state);
      b.appendChild(head);
      if (r.durationMs != null) b.appendChild(el('span', 'lv-step-dur', fmtMs(r.durationMs)));
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function drawOutput() {
    var sel = LT.pickSelected(feed.state, pinned);
    var head = $('lv-output-head'); var pre = $('lv-output'); var err = $('lv-output-err');
    head.textContent = ''; err.hidden = true;
    var d = sel == null ? null : LT.stepDetail(feed.state, sel);
    if (!d) { pre.textContent = t('pickStep'); return; }

    head.appendChild(el('span', 'lv-chip', t('step') + ' ' + d.index + ' \u00b7 ' + d.action));
    if (d.inputItemCount != null) head.appendChild(el('span', 'lv-chip', t('in') + ': ' + d.inputItemCount));
    if (d.outputItemCount != null) head.appendChild(el('span', 'lv-chip', t('out') + ': ' + d.outputItemCount));
    if (d.durationMs != null) head.appendChild(el('span', 'lv-chip', fmtMs(d.durationMs)));
    if (pinned != null) {
      var f = el('button', 'lv-follow', t('followBtn'));
      f.type = 'button'; f.id = 'lv-follow';
      head.appendChild(f);
    }
    pre.textContent = d.outputText || (d.status === 'running' ? '' : t('noOutput'));
    if (d.truncated) pre.appendChild(el('span', 'lv-trunc', '\n\u2026 ' + t('truncated')));
    if (d.error) { err.textContent = d.error; err.hidden = false; }
  }

  function drawPane() {
    var key = LT.paneMessage(frameStatus, feed.state.phase, hasFrame);
    var msg = $('lv-browser-msg');
    if (!key && frameStatus === 'ended' && hasFrame) key = null;
    msg.textContent = key ? t(key) : '';
    msg.hidden = !key;
    $('lv-browser').className = 'lv-browser' + (hasFrame ? ' has-frame' : '');
  }

  function drawAll() { drawStatus(); drawTimeline(); drawOutput(); drawPane(); }

  // ---- transports ----------------------------------------------------------

  function Stream(url, handlers) {
    var es = null; var attempt = 0; var timer = null; var closed = false; var everOpened = false; var failures = 0;
    function open() {
      if (closed) return;
      try { es = new window.EventSource(url); } catch (e) { handlers.fatal && handlers.fatal(); return; }
      es.onopen = function () { attempt = 0; failures = 0; everOpened = true; handlers.open && handlers.open(); };
      handlers.bind(es);
      es.onerror = function () {
        // EventSource gives no status code. A link that was rejected (403/401)
        // never opens; after a few tries that is "invalid or expired", not
        // "network blip", and retrying forever would just hammer the server.
        try { es.close(); } catch (e) { /* closed */ }
        es = null;
        failures += 1;
        if (!everOpened && failures >= 3) { handlers.fatal && handlers.fatal(); return; }
        handlers.lost && handlers.lost();
        timer = setTimeout(open, LT.backoffMs(attempt++));
      };
    }
    open();
    return { close: function () { closed = true; clearTimeout(timer); if (es) { try { es.close(); } catch (e) { /* closed */ } } } };
  }

  var evStream = null; var frStream = null;

  function connect() {
    if (!window.EventSource) { $('lv-error').textContent = t('denied'); $('lv-error').hidden = false; return; }
    evStream = Stream(LT.eventsPath(ctx.userId, ctx.jobId, ctx.share), {
      open: function () { connState = 'open'; drawStatus(); },
      lost: function () { connState = 'reconnecting'; drawStatus(); },
      fatal: function () { denied = true; drawAll(); if (frStream) frStream.close(); },
      bind: function (es) {
        es.onmessage = function (m) {
          var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
          gotAnyEvent = true;
          if (feed.push(ev)) {
            if (ev.type === 'job.start') $('lv-meta').textContent = 'job ' + (ev.jobId || ctx.jobId);
            drawAll();
          }
        };
      },
    });
    frStream = Stream(LT.framesPath(ctx.userId, ctx.jobId, ctx.share), {
      open: function () { /* status event follows */ },
      lost: function () { /* the event stream owns the connection badge */ },
      fatal: function () { frameStatus = 'error'; drawPane(); },
      bind: function (es) {
        es.addEventListener('status', function (m) {
          try { frameStatus = JSON.parse(m.data).status || 'waiting'; } catch (e) { return; }
          drawPane();
        });
        es.addEventListener('frame', function (m) {
          var f; try { f = JSON.parse(m.data); } catch (e) { return; }
          if (!f || typeof f.data !== 'string') return;
          var img = $('lv-frame');
          img.src = 'data:image/jpeg;base64,' + f.data;
          if (f.width && f.height) img.setAttribute('data-size', f.width + 'x' + f.height);
          img.hidden = false; hasFrame = true;
          drawPane();
        });
      },
    });
  }

  // ---- boot ----------------------------------------------------------------

  function boot() {
    document.documentElement.lang = lang;
    document.documentElement.dir = 'ltr';
    document.title = t('title');
    $('lv-logo').innerHTML = IC('eye', 26);
    $('lv-title').textContent = t('title');
    $('lv-steps-title').textContent = t('steps');
    $('lv-output-title').textContent = t('output');
    $('lv-readonly').textContent = t('readonly');
    $('lv-frame').alt = t('browser');
    $('lv-status-text').textContent = t('connecting');

    $('lv-steps').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-step]') : null;
      if (!b) return;
      pinned = Number(b.getAttribute('data-step'));
      drawTimeline(); drawOutput();
    });
    $('lv-output-head').addEventListener('click', function (e) {
      if (e.target && e.target.id === 'lv-follow') { pinned = null; drawTimeline(); drawOutput(); }
    });

    if (!ctx.userId || !ctx.jobId || !ctx.share) {
      denied = true;
      $('lv-error').textContent = (!ctx.userId || !ctx.jobId) ? t('missing') : t('denied');
      $('lv-error').hidden = false;
      drawAll();
      return;
    }
    $('lv-meta').textContent = 'job ' + ctx.jobId;
    drawAll();
    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
