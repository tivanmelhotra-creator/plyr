/* ============================================
   Live Run tab (/live/view/:userId/:jobId?share=...)

   Layout (docs/uiux/24-HANDOFF-live-run-redesign.md):
     top bar     Live Run · Workflow · Browser profile · Restart · Stop
     left        status strip (RUNNING · Step 4 of 8 · current step · elapsed)
                 the browser window (address bar + CDP screencast, view-only),
                 given all remaining height and sized to the page's own aspect
                 ratio, so a 1280x800 page is never squashed into a letterbox
     right       two tabs:
                   Execution steps (N): the planned chain, each row expandable
                                        into OUTPUT / DETAILS
                   Log: one line per event (filter, clear). It used to sit under
                                        the browser and cost it ~25% of the height
                                        for something read only when a run goes
                                        wrong; its badge counts errors/warnings
                                        so that moment is not missed.

   Streams and calls (all same-origin, no API key in any URL):
     /live/sse/...      run events             (share token)
     /live/frames/...   screencast frames      (share token)
     /live/plan/...     the planned steps      (share token, GET once)
     /me                is this viewer the owner?  (x-api-key header or dev loopback)
     /cancel/...        Stop                   (owner only)
     /live/restart/...  Restart                (owner only)
   A forwarded share link therefore watches, and never controls: Stop and
   Restart are not even shown unless /me answers 200.

   Standalone and CSP-safe: no inline handlers, no eval, no blob:. Every value
   that came from the run is written with textContent. Decisions live in
   LiveTab / RunState (pure, unit-tested); this file draws them.
   ============================================ */
(function () {
  'use strict';

  var LT = window.LiveTab;
  var RS = window.RunState;

  var STR = {
    title: 'Live Run', steps: 'Execution steps', readonly: 'View only: the browser cannot be controlled from here.',
    workflow: 'Workflow', profile: 'Browser profile', unsaved: 'Unsaved workflow', elapsed: 'Elapsed Time',
    connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', waiting: 'Queued',
    running: 'Running', done: 'Completed', partial: 'Completed with errors', failed: 'Failed', stopped: 'Stopped',
    denied: 'This link is invalid or has expired. Open the run again from the editor.',
    missing: 'This address is missing the run it should show.',
    noSteps: 'Waiting for the first step\u2026', stepOf: 'Step {a} of {b}', noStepYet: 'Starting\u2026',
    output: 'Output', details: 'Details', noOutput: 'This step produced no output sample.',
    runningOut: 'The output appears when the step finishes.', pendingOut: 'This step has not run yet.',
    skippedOut: 'This step did not run.', truncated: 'Output was shortened.', copy: 'Copy output', copied: 'Copied',
    followBtn: 'Follow latest', log: 'Log', clear: 'Clear', logEmpty: 'No events yet.',
    'f.all': 'All events', 'f.steps': 'Steps', 'f.errors': 'Errors & warnings', 'f.messages': 'Messages',
    restart: 'Restart', stop: 'Stop', stopping: 'Stopping\u2026', restarting: 'Restarting\u2026',
    stopFailed: 'Could not stop the run: ', restartFailed: 'Could not restart the run: ',
    fullscreen: 'Full screen', browser: 'Browser',
    'd.step': 'Step', 'd.action': 'Action', 'd.status': 'Status', 'd.duration': 'Duration',
    'd.in': 'Input items', 'd.out': 'Output items', 'd.error': 'Error', 'd.target': 'Target',
    'st.pending': 'Waiting', 'st.running': 'Running', 'st.success': 'Succeeded', 'st.error': 'Failed',
    'st.stopped': 'Stopped', 'st.skipped': 'Did not run',
    'lv.waitingBrowser': 'Waiting for the browser to open\u2026',
    'lv.noBrowser': 'No browser view was available for this run.',
    'lv.busy': 'Too many people are watching this run.',
    'lv.frameError': 'The browser view is unavailable.',
    'lv.ended': 'The browser has closed.',
  };
  function t(k, vars) {
    var s = STR[k] != null ? STR[k] : k;
    if (vars) for (var v in vars) if (Object.prototype.hasOwnProperty.call(vars, v)) s = s.replace('{' + v + '}', String(vars[v]));
    return s;
  }

  function IC(name, size) { return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : ''; }
  function ACT(action, size) { return window.Icons && window.Icons.action ? window.Icons.action(action, { size: size || 16 }) : ''; }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var ctx = LT.parseViewLocation(location.pathname, location.search);
  var feed = LT.createFeed(RS);
  var plan = null;            // { steps, workflow, startedAt, known }
  var open = null;            // row key the user expanded (null = follow)
  var closed = {};            // row keys the user collapsed on purpose
  var tabOf = {};             // row key -> 'output' | 'details'
  var frameStatus = 'waiting';
  var hasFrame = false;
  var pageAddr = '';
  var connState = 'connecting';
  var denied = false;
  var owner = false;
  var busy = '';              // '' | 'stopping' | 'restarting'
  var logFilter = 'all';
  var logClearedAt = 0;       // events before this count are hidden by Clear
  var sideTab = 'steps';      // 'steps' | 'log'
  var seenProblems = 0;       // errors/warnings already seen on the Log tab
  var tick = null;

  // ---- derived -------------------------------------------------------------

  function rows() { return LT.mergePlan(plan, feed); }

  /** The row whose panel is open: the one the user picked, else follow. */
  function openKey(rs) {
    if (open != null) {
      for (var i = 0; i < rs.length; i++) if (rs[i].key === open) return open;
    }
    // Follow: the newest step that has finished (its output is the newest
    // thing worth reading); before any finished, the running one.
    for (var j = rs.length - 1; j >= 0; j--) {
      var r = rs[j];
      if ((r.status === 'success' || r.status === 'error') && !closed[r.key]) return r.key;
    }
    for (var k = 0; k < rs.length; k++) if (rs[k].status === 'running' && !closed[rs[k].key]) return rs[k].key;
    return null;
  }

  function startMs() {
    if (plan && plan.startedAt) { var p = Date.parse(plan.startedAt); if (!isNaN(p)) return p; }
    return feed.firstTs;
  }

  // ---- drawing -------------------------------------------------------------

  function phaseKey() {
    var st = feed.state;
    if (denied) return 'failed';
    if (RS.isTerminal(st)) {
      var o = RS.outcome(st);
      return o === 'success' ? 'done' : o === 'partial' ? 'partial' : o === 'stopped' ? 'stopped' : 'failed';
    }
    if (connState === 'reconnecting') return 'reconnecting';
    if (st.phase === 'running') return 'running';
    if (connState === 'open') return plan && plan.state === 'delayed' ? 'waiting' : 'connected';
    return 'connecting';
  }

  function drawStatus(rs) {
    var k = phaseKey();
    $('lr-badge').className = 'lr-badge is-' + k;
    $('lv-status-dot').className = 'lr-dot lr-dot-' + k;
    $('lv-status-text').textContent = denied ? t('denied') : t(k);
    var p = LT.progress(rs);
    $('lr-progress').textContent = rs.length ? (p.at ? t('stepOf', { a: p.at, b: p.total }) : t('stepOf', { a: 0, b: p.total })) : '';
    var cur = p.current;
    $('lr-current').textContent = cur ? LT.actionName(cur.action) + (cur.target ? ' \u00b7 ' + cur.target : '') : (rs.length && !denied ? t('noStepYet') : '');
    $('lr-current').className = 'lr-current' + (cur && cur.status === 'running' ? ' is-running' : '');
    drawElapsed();
    document.title = (k === 'running' ? '\u25cf ' : '') + t('title') + (plan && plan.workflow && plan.workflow.name ? ' \u00b7 ' + plan.workflow.name : '');
  }

  function drawElapsed() {
    var s = startMs();
    var end = feed.endTs != null ? feed.endTs : (RS.isTerminal(feed.state) ? (feed.state.finishedAt || Date.now()) : Date.now());
    $('lr-elapsed').textContent = s == null ? '00:00:00' : LT.formatElapsed(s, end);
  }

  function drawFacts() {
    var wf = plan && plan.workflow;
    $('lr-workflow').textContent = wf ? (wf.name || t('unsaved')) : (plan && plan.known ? t('unsaved') : '\u2014');
    var job = feed.job;
    $('lr-profile').textContent = job && job.profile ? String(job.profile) : '\u2014';
  }

  var STATUS_ICON = { pending: 'clock', running: 'loader', success: 'check-circle', error: 'x-circle', stopped: 'stop-circle', skipped: 'minus' };

  function drawSteps(rs) {
    var list = $('lv-steps');
    $('lv-steps-title').textContent = t('steps') + (rs.length ? ' (' + rs.length + ')' : '');
    list.textContent = '';
    if (!rs.length) { list.appendChild(el('li', 'lr-empty', denied ? '' : t('noSteps'))); $('lv-follow').hidden = true; return; }
    var ok = openKey(rs);
    rs.forEach(function (r) {
      var isOpen = r.key === ok;
      var li = el('li', 'lr-step is-' + r.status + (isOpen ? ' is-open' : '') + (r.depth ? ' is-nested' : ''));
      li.setAttribute('data-key', r.key);
      if (r.index != null) li.setAttribute('data-step', String(r.index));
      if (r.status === 'running') li.setAttribute('aria-current', 'step');

      var b = el('button', 'lr-step-row');
      b.type = 'button';
      b.setAttribute('data-toggle', r.key);
      b.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      b.appendChild(el('span', 'lr-step-num', r.num));
      var ic = el('span', 'lr-step-ic'); ic.innerHTML = ACT(r.action, 17); b.appendChild(ic);
      var txt = el('span', 'lr-step-txt');
      var nm = el('span', 'lr-step-name', LT.actionName(r.action));
      var sub = el('span', 'lr-step-sub', LT.stepPhrase(r));
      sub.title = sub.textContent;   // clipped with an ellipsis; the full line on hover
      txt.appendChild(nm); txt.appendChild(sub);
      b.appendChild(txt);
      b.appendChild(el('span', 'lr-step-dur', r.durationMs != null ? LT.formatDuration(r.durationMs) : (r.status === 'pending' || r.status === 'skipped' ? '\u2013' : '')));
      var si = el('span', 'lr-step-state'); si.innerHTML = IC(STATUS_ICON[r.status] || 'clock', 20);
      si.setAttribute('aria-label', t('st.' + r.status)); si.setAttribute('role', 'img');
      b.appendChild(si);
      var cv = el('span', 'lr-step-chev'); cv.innerHTML = IC(isOpen ? 'chevron-up' : 'chevron-down', 16); b.appendChild(cv);
      li.appendChild(b);
      if (isOpen) li.appendChild(drawPanel(r));
      list.appendChild(li);
    });
    $('lv-follow').hidden = open == null || sideTab !== 'steps';
  }

  function drawPanel(r) {
    var tab = tabOf[r.key] || 'output';
    var panel = el('div', 'lr-panel');
    var tabs = el('div', 'lr-tabs'); tabs.setAttribute('role', 'tablist');
    ['output', 'details'].forEach(function (k) {
      var tb = el('button', 'lr-tabbtn' + (tab === k ? ' is-on' : ''), t(k));
      tb.type = 'button'; tb.setAttribute('role', 'tab');
      tb.setAttribute('aria-selected', tab === k ? 'true' : 'false');
      tb.setAttribute('data-tab', k); tb.setAttribute('data-for', r.key);
      tabs.appendChild(tb);
    });
    panel.appendChild(tabs);

    var body = el('div', 'lr-code-wrap');
    var d = r.index != null ? LT.stepDetail(feed.state, r.index) : null;
    if (tab === 'output') {
      var pre = el('pre', 'lr-code'); pre.id = 'lv-output'; pre.tabIndex = 0;
      if (d && d.outputText) { highlightJson(pre, d.outputText); }
      else pre.textContent = r.status === 'running' ? t('runningOut') : r.status === 'pending' ? t('pendingOut')
        : r.status === 'skipped' ? t('skippedOut') : t('noOutput');
      if (d && d.truncated) pre.appendChild(el('span', 'lr-trunc', '\n\u2026 ' + t('truncated')));
      body.appendChild(pre);
      if (d && d.outputText) {
        var cp = el('button', 'lr-copy'); cp.type = 'button'; cp.setAttribute('data-copy', r.key);
        cp.title = t('copy'); cp.setAttribute('aria-label', t('copy')); cp.innerHTML = IC('copy', 16);
        body.appendChild(cp);
      }
      if (d && d.error) body.appendChild(el('div', 'lr-step-err', d.error));
    } else {
      var dl = el('dl', 'lr-details');
      function row(k, v) { if (v == null || v === '') return; dl.appendChild(el('dt', null, t(k))); dl.appendChild(el('dd', null, v)); }
      row('d.step', String(r.num));
      row('d.action', LT.actionName(r.action) + ' (' + r.action + ')');
      row('d.target', r.target);
      row('d.status', t('st.' + r.status));
      row('d.duration', r.durationMs != null ? LT.formatDuration(r.durationMs) : null);
      row('d.in', r.inputItemCount != null ? String(r.inputItemCount) : null);
      row('d.out', r.outputItemCount != null ? String(r.outputItemCount) : null);
      row('d.error', r.error);
      body.appendChild(dl);
    }
    panel.appendChild(body);
    return panel;
  }

  /** JSON with keys and strings coloured, built from text nodes only. */
  function highlightJson(pre, text) {
    pre.textContent = '';
    var re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    var last = 0; var m;
    while ((m = re.exec(text))) {
      if (m.index > last) pre.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) {
        pre.appendChild(el('span', m[2] ? 'j-key' : 'j-str', m[1]));
        if (m[2]) pre.appendChild(document.createTextNode(m[2]));
      } else if (m[3]) pre.appendChild(el('span', 'j-lit', m[3]));
      else pre.appendChild(el('span', 'j-num', m[4]));
      last = re.lastIndex;
    }
    if (last < text.length) pre.appendChild(document.createTextNode(text.slice(last)));
  }

  function drawLog(rs) {
    var list = $('lr-log-list');
    var stick = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    var all = LT.logLines(feed, rs);
    var lines = LT.filterLog(all.slice(logClearedAt), logFilter);
    list.textContent = '';
    if (!lines.length) { list.appendChild(el('li', 'lr-log-empty', t('logEmpty'))); }
    lines.forEach(function (l) {
      var li = el('li', 'lr-log-line is-' + l.level);
      li.appendChild(el('span', 'lr-log-dot'));
      li.appendChild(el('time', 'lr-log-time', LT.formatClock(l.t)));
      var msg = el('span', 'lr-log-msg', l.text); msg.title = l.text; li.appendChild(msg);
      li.appendChild(el('span', 'lr-log-step', l.step != null ? 'Step ' + pad2(l.step) : ''));
      list.appendChild(li);
    });
    if (stick) list.scrollTop = list.scrollHeight;
    drawLogCount(all.slice(logClearedAt));
    $('lr-filter').innerHTML = '';
    $('lr-filter').appendChild(el('span', null, t('f.' + logFilter)));
    var cv = el('span', 'lr-tool-ic'); cv.innerHTML = IC('chevron-down', 14); $('lr-filter').appendChild(cv);
  }

  /** Badge on the Log tab: how many problems arrived that were not yet looked at. */
  function drawLogCount(lines) {
    var problems = 0; var errors = 0;
    lines.forEach(function (l) { if (l.level === 'error' || l.level === 'warn') problems++; if (l.level === 'error') errors++; });
    if (sideTab === 'log') seenProblems = problems;
    var fresh = Math.max(0, problems - seenProblems);
    var c = $('lr-log-count');
    c.hidden = fresh === 0;
    c.textContent = fresh > 99 ? '99+' : String(fresh);
    c.className = 'lr-count' + (errors ? ' is-error' : ' is-warn');
    c.setAttribute('aria-label', fresh + ' new problem' + (fresh === 1 ? '' : 's'));
  }

  function setSideTab(tab) {
    sideTab = tab === 'log' ? 'log' : 'steps';
    var onSteps = sideTab === 'steps';
    $('lr-tab-steps').className = 'lr-side-tab' + (onSteps ? ' is-on' : '');
    $('lr-tab-log').className = 'lr-side-tab' + (onSteps ? '' : ' is-on');
    $('lr-tab-steps').setAttribute('aria-selected', onSteps ? 'true' : 'false');
    $('lr-tab-log').setAttribute('aria-selected', onSteps ? 'false' : 'true');
    $('lv-steps').hidden = !onSteps;
    $('lr-log').hidden = onSteps;
    var rs = rows();
    drawSteps(rs); drawLog(rs);
    if (!onSteps) { var l = $('lr-log-list'); l.scrollTop = l.scrollHeight; }
  }

  function drawActions() {
    var term = RS.isTerminal(feed.state);
    $('lr-actions').hidden = !owner;
    var stop = $('lr-stop'); var rst = $('lr-restart');
    stop.disabled = !owner || term || denied || busy !== '';
    rst.disabled = !owner || denied || busy !== '' || !(plan && plan.known);
    setBtn(stop, 'square', busy === 'stopping' ? t('stopping') : t('stop'));
    setBtn(rst, 'rotate-ccw', busy === 'restarting' ? t('restarting') : t('restart'));
  }
  function setBtn(b, icon, label) {
    b.textContent = '';
    var i = el('span', 'lr-btn-ic'); i.innerHTML = IC(icon, 16); b.appendChild(i);
    b.appendChild(el('span', null, label));
  }

  function drawPane() {
    var key = LT.paneMessage(frameStatus, feed.state.phase, hasFrame);
    var msg = $('lv-browser-msg');
    msg.textContent = key ? t(key) : '';
    msg.hidden = !key;
    $('lv-browser').className = 'lv-browser lr-browser' + (hasFrame ? ' has-frame' : '');
    $('lr-url').textContent = pageAddr || '\u2014';
    $('lr-lock').innerHTML = IC(/^https:/.test(pageAddr) ? 'lock' : 'globe', 14);
  }

  function drawAll() {
    var rs = rows();
    drawStatus(rs); drawFacts(); drawSteps(rs); drawLog(rs); drawActions(); drawPane();
  }

  function showError(msg) {
    var e = $('lv-error');
    e.textContent = msg || ''; e.hidden = !msg;
  }

  // ---- transports ----------------------------------------------------------

  function Stream(url, handlers) {
    var es = null; var attempt = 0; var timer = null; var isClosed = false; var everOpened = false; var failures = 0;
    function connect() {
      if (isClosed) return;
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
        timer = setTimeout(connect, LT.backoffMs(attempt++));
      };
    }
    connect();
    return { close: function () { isClosed = true; clearTimeout(timer); if (es) { try { es.close(); } catch (e) { /* closed */ } } } };
  }

  var evStream = null; var frStream = null;

  function ownerHeaders() {
    var h = { Accept: 'application/json' };
    var key = '';
    try { key = window.localStorage.getItem('ab_api_key') || ''; } catch (e) { key = ''; }
    if (key) h['x-api-key'] = key;   // a HEADER, never the URL
    return h;
  }

  function call(method, path) {
    if (!window.fetch) return Promise.reject(new Error('fetch unavailable'));
    return window.fetch(path, { method: method, headers: ownerHeaders(), credentials: 'same-origin' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) { var err = new Error((body && body.error) || ('HTTP ' + res.status)); err.status = res.status; throw err; }
        return body;
      });
    });
  }

  function loadPlan(retry) {
    if (!window.fetch) return;
    window.fetch(LT.planPath(ctx.userId, ctx.jobId, ctx.share), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (p && p.success) { plan = p; drawAll(); }
        else if (!retry) setTimeout(function () { loadPlan(true); }, 1500);
      })
      .catch(function () { if (!retry) setTimeout(function () { loadPlan(true); }, 1500); });
  }

  function probeOwner() {
    call('GET', '/me').then(function () { owner = true; drawActions(); }, function () { owner = false; drawActions(); });
  }

  function connect() {
    if (!window.EventSource) { showError(t('denied')); return; }
    evStream = Stream(LT.eventsPath(ctx.userId, ctx.jobId, ctx.share), {
      open: function () { connState = 'open'; drawAll(); },
      lost: function () { connState = 'reconnecting'; drawAll(); },
      fatal: function () { denied = true; stopTick(); drawAll(); if (frStream) frStream.close(); },
      bind: function (es) {
        es.onmessage = function (m) {
          var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
          if (feed.push(ev)) {
            if (ev.type === 'job.start' && !plan) loadPlan(true);
            if (RS.isTerminal(feed.state)) { busy = busy === 'stopping' ? '' : busy; stopTick(); }
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
          if (f.width && f.height) {
            img.setAttribute('data-size', f.width + 'x' + f.height);
            setAspect(f.width, f.height);
          }
          if (typeof f.url === 'string') pageAddr = f.url;
          img.hidden = false; hasFrame = true;
          drawPane();
        });
      },
    });
  }

  /**
   * The browser window takes the page's own proportions (CSS reads --lr-ar),
   * so the picture fills it edge to edge instead of floating in black bars.
   * Only redrawn when the size really changes (a new tab, a resized viewport).
   */
  var lastAspect = '';
  function setAspect(w, h) {
    var key = w + 'x' + h;
    if (key === lastAspect) return;
    lastAspect = key;
    $('lr-window').style.setProperty('--lr-ar', String(w / h));
    $('lr-size').textContent = w + ' \u00d7 ' + h;
  }

  function startTick() {
    if (tick) return;
    // Bound to THIS page's root: once it leaves the document the clock stops
    // (a later page with the same ids must not be drawn by an old one).
    var page = $('lv-root');
    tick = setInterval(function () {
      if (!page || !page.isConnected) { clearInterval(tick); tick = null; return; }
      if (!RS.isTerminal(feed.state)) drawElapsed();
    }, 1000);
  }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } drawElapsed(); }

  // ---- owner actions -------------------------------------------------------

  function doStop() {
    if (!owner || busy) return;
    busy = 'stopping'; showError(''); drawActions();
    call('DELETE', LT.cancelPath(ctx.userId, ctx.jobId)).then(function () {
      // The run reports its own end (job.error reason=cancelled). A run still
      // waiting in the queue is removed and never reports: mark it here.
      setTimeout(function () {
        if (!RS.isTerminal(feed.state)) { RS.markStopped(feed.state); stopTick(); }
        busy = ''; drawAll();
      }, 4000);
    }, function (e) {
      busy = ''; showError(t('stopFailed') + e.message); drawActions();
    });
  }

  function doRestart() {
    if (!owner || busy) return;
    busy = 'restarting'; showError(''); drawActions();
    call('POST', LT.restartPath(ctx.userId, ctx.jobId)).then(function (r) {
      if (r && r.url) { location.replace(r.url); return; }
      busy = ''; showError(t('restartFailed') + 'no live link for the new run'); drawActions();
    }, function (e) {
      busy = ''; showError(t('restartFailed') + e.message); drawActions();
    });
  }

  // ---- events --------------------------------------------------------------

  function onStepsClick(e) {
    var target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    var tb = target.closest('[data-tab]');
    if (tb) { tabOf[tb.getAttribute('data-for')] = tb.getAttribute('data-tab'); drawSteps(rows()); return; }
    var cp = target.closest('[data-copy]');
    if (cp) { copyOutput(cp); return; }
    var tg = target.closest('[data-toggle]');
    if (!tg) return;
    var key = tg.getAttribute('data-toggle');
    var rs = rows();
    if (openKey(rs) === key) { open = '__none__'; closed[key] = true; }
    else { open = key; delete closed[key]; }
    drawSteps(rs);
  }

  function copyOutput(btn) {
    var pre = $('lv-output');
    var text = pre ? pre.textContent : '';
    var done = function () { btn.innerHTML = IC('check', 16); btn.title = t('copied'); setTimeout(function () { btn.innerHTML = IC('copy', 16); btn.title = t('copy'); }, 1200); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { /* blocked */ });
    } catch (e) { /* no clipboard */ }
  }

  function buildFilterMenu() {
    var ul = $('lr-filter-list');
    ul.textContent = '';
    LT.LOG_FILTERS.forEach(function (f) {
      var li = el('li'); li.setAttribute('role', 'none');
      var b = el('button', 'lr-menu-item' + (f === logFilter ? ' is-on' : ''), t('f.' + f));
      b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', f === logFilter ? 'true' : 'false');
      b.setAttribute('data-filter', f);
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function toggleMenu(show) {
    var ul = $('lr-filter-list');
    var on = show != null ? show : ul.hidden;
    if (on) buildFilterMenu();
    ul.hidden = !on;
    $('lr-filter').setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  // ---- boot ----------------------------------------------------------------

  function boot() {
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
    document.title = t('title');
    $('lr-tab-ic').innerHTML = IC('activity', 18);
    $('lr-wf-ic').innerHTML = IC('sitemap', 20);
    $('lr-pf-ic').innerHTML = IC('user', 18);
    $('lv-title').textContent = t('title');
    $('lr-wf-k').textContent = t('workflow');
    $('lr-pf-k').textContent = t('profile');
    $('lr-elapsed-k').textContent = t('elapsed');
    $('lv-steps-title').textContent = t('steps');
    $('lr-log-title').textContent = t('log');
    $('lv-readonly').textContent = t('readonly');
    $('lv-frame').alt = t('browser');
    $('lv-follow').textContent = t('followBtn');
    var fs = $('lr-fullscreen'); fs.innerHTML = IC('maximize', 16); fs.title = t('fullscreen'); fs.setAttribute('aria-label', t('fullscreen'));
    var cl = $('lr-clear'); cl.textContent = ''; var ci = el('span', 'lr-tool-ic'); ci.innerHTML = IC('trash', 14); cl.appendChild(ci); cl.appendChild(el('span', null, t('clear')));
    $('lv-status-text').textContent = t('connecting');

    $('lv-steps').addEventListener('click', onStepsClick);
    $('lv-follow').addEventListener('click', function () { open = null; closed = {}; drawSteps(rows()); });
    $('lr-tab-steps').addEventListener('click', function () { setSideTab('steps'); });
    $('lr-tab-log').addEventListener('click', function () { setSideTab('log'); });
    $('lr-stop').addEventListener('click', doStop);
    $('lr-restart').addEventListener('click', doRestart);
    $('lr-clear').addEventListener('click', function () { logClearedAt = LT.logLines(feed, rows()).length; drawLog(rows()); });
    $('lr-filter').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
    $('lr-filter-list').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-filter]') : null;
      if (!b) return;
      logFilter = b.getAttribute('data-filter'); toggleMenu(false); drawLog(rows());
    });
    // Close the filter menu on an outside click / Escape. These two are the only
    // listeners on `document`, which outlives this page's DOM (a test harness
    // swaps the body; one jsdom document is shared by every test file). They
    // hold the menu they were made for and remove themselves once it is gone,
    // instead of looking an id up in whatever page is there now.
    var menu = $('lr-filter-list');
    var root = $('lv-root');
    function onDocClick() { if (!alive()) return; if (!menu.hidden) toggleMenu(false); }
    function onDocKey(e) { if (!alive()) return; if (e.key === 'Escape' && !menu.hidden) toggleMenu(false); }
    function alive() {
      if (root && root.isConnected && menu.isConnected) return true;
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      if (tick) { clearInterval(tick); tick = null; }
      return false;
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
    fs.addEventListener('click', function () {
      var fig = $('lv-browser');
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (fig.requestFullscreen) fig.requestFullscreen();
      } catch (e) { /* not allowed */ }
    });

    if (!ctx.userId || !ctx.jobId || !ctx.share) {
      denied = true;
      showError((!ctx.userId || !ctx.jobId) ? t('missing') : t('denied'));
      drawAll();
      return;
    }
    $('lv-meta').textContent = 'Run ' + ctx.jobId;
    drawAll();
    connect();
    loadPlan(false);
    probeOwner();
    startTick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
