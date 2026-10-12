/*
 * live-tab.js — the pure logic behind "Test Workflow opens a live tab".
 *
 * DOM-free and CSP-safe (no eval, no inline script, no blob:). It touches only
 * what it is handed (a `win` with open(), an `api` with two functions), so every
 * decision is unit-tested under node:vm / jsdom, like run-state.js.
 *
 * THE ONE RULE THAT SHAPES THE WHOLE FILE
 * ---------------------------------------
 * `window.open` only escapes the popup blocker when it runs synchronously inside
 * the user's click. The run has to be queued (an await) and a share link minted
 * (another await) before we know the URL. So the tab is opened FIRST, blank,
 * and navigated afterwards. `launch()` therefore calls `win.open` before it
 * calls anything that returns a promise.
 *
 * NO API KEY IN A URL
 * -------------------
 * The new tab is addressed with a signed SHARE token minted by
 * POST /live/share/:userId/:jobId (authenticated by the x-api-key HEADER). The
 * token is bound to one job and expires; the API key never reaches a URL, a
 * history entry or a proxy log.
 *
 * Exposes window.LiveTab (and module.exports for node).
 */
(function (root) {
  'use strict';

  // ---- should we open a tab at all? ---------------------------------------

  var LAUNCH_ACTIONS = { 'launch': 1, 'launch-browser': 1, 'launch_browser': 1 };
  var CHILD_KEYS = ['then', 'else', 'steps', 'catch', 'finally', 'fallback'];

  function walk(steps, visit) {
    if (!Array.isArray(steps)) return false;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (!s || typeof s !== 'object') continue;
      if (visit(s) === true) return true;
      for (var k = 0; k < CHILD_KEYS.length; k++) if (walk(s[CHILD_KEYS[k]], visit)) return true;
      if (s.cases && typeof s.cases === 'object') {
        for (var c in s.cases) if (Object.prototype.hasOwnProperty.call(s.cases, c) && walk(s.cases[c], visit)) return true;
      }
      if (Array.isArray(s.paths)) {
        for (var p = 0; p < s.paths.length; p++) if (s.paths[p] && walk(s.paths[p].steps, visit)) return true;
      }
    }
    return false;
  }

  function parseOptions(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        var v = JSON.parse(raw);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch (e) { /* not JSON: no options */ }
    }
    return null;
  }

  /** Options of the FIRST Launch Browser step that carries any (same rule as the server). */
  function launchOptionsOf(steps) {
    var found = null;
    walk(steps, function (s) {
      if (!LAUNCH_ACTIONS[String(s.action)]) return false;
      var o = parseOptions(s.params && s.params.browserOptions);
      if (o && Object.keys(o).length) { found = o; return true; }
      return false;
    });
    return found;
  }

  /**
   * Will this run use a VISIBLE browser? Same rule as the server's
   * effectiveHeadless: the Launch node's own `headless` option beats the run
   * switch, and the run switch defaults to headless.
   */
  function effectiveHeadless(options, runHeadless) {
    if (options && typeof options.headless === 'boolean') return options.headless;
    return runHeadless !== false;
  }

  /** Test Run + visible browser. Anything else (saved run, node test, headless) opens nothing. */
  function wantsLiveTab(o) {
    o = o || {};
    if (o.isTestRun !== true) return false;
    return effectiveHeadless(launchOptionsOf(o.steps), o.runHeadless) === false;
  }

  // ---- addresses -----------------------------------------------------------

  function enc(s) { return encodeURIComponent(String(s)); }

  /** Same-origin, relative: never depends on what host the server believes it has. */
  function viewPath(userId, jobId, token) {
    return '/live/view/' + enc(userId) + '/' + enc(jobId) + '?share=' + enc(token);
  }
  function eventsPath(userId, jobId, token) {
    return '/live/sse/' + enc(userId) + '/' + enc(jobId) + '?share=' + enc(token);
  }
  function framesPath(userId, jobId, token) {
    return '/live/frames/' + enc(userId) + '/' + enc(jobId) + '?share=' + enc(token);
  }

  /** Read {userId, jobId, share} from /live/view/:u/:j?share=... */
  function parseViewLocation(pathname, search) {
    var parts = String(pathname || '').split('/').filter(Boolean);
    var out = { userId: '', jobId: '', share: '' };
    if (parts.length >= 4 && parts[0] === 'live' && parts[1] === 'view') {
      try { out.userId = decodeURIComponent(parts[2]); out.jobId = decodeURIComponent(parts[3]); }
      catch (e) { out.userId = ''; out.jobId = ''; }
    }
    var m = /[?&]share=([^&]*)/.exec(String(search || ''));
    if (m) { try { out.share = decodeURIComponent(m[1]); } catch (e) { out.share = ''; } }
    return out;
  }

  // ---- opening the tab -----------------------------------------------------

  function paintPlaceholder(handle, title, text) {
    try {
      handle.document.title = title || '';
      if (handle.document.body) handle.document.body.textContent = text || '';
    } catch (e) { /* a navigated / closed window: nothing to paint */ }
  }

  function isOpen(handle) {
    try { return !!handle && handle.closed !== true; } catch (e) { return false; }
  }

  /**
   * Start a Test Run and (when it applies) open its live tab.
   *
   * opts:
   *   win        object with open(url, target)           (window)
   *   isTestRun  true only for the editor's Test Workflow button
   *   runHeadless  the run's headless switch (true unless "Live browser" is on)
   *   steps      the steps about to run (for the Launch node's own option)
   *   userId
   *   start()    -> Promise<{ jobId }>   queues the run (API.runFlow)
   *   share(userId, jobId) -> Promise<{ token }>   mints the share token
   *   labels     { title, loading, failed }  already-translated strings
   *
   * Returns { opened, run, tab }:
   *   opened   boolean, known synchronously (false = no tab wanted OR blocked)
   *   blocked  boolean, true when a tab was wanted but the browser refused it
   *   run      the promise from start() — resolve/reject exactly as start() does
   *   tab      Promise<{status, url?, error?}> with status one of
   *            'not-wanted' | 'blocked' | 'navigated' | 'closed' | 'share-failed' | 'run-failed'
   *            ('blocked' and 'share-failed' carry `url` when it is known, so
   *            the caller can show a plain link the user can click themselves)
   */
  function launch(opts) {
    var wanted = wantsLiveTab(opts);
    var labels = opts.labels || {};
    var handle = null;

    // SYNCHRONOUS, before start(): see the header comment.
    if (wanted) {
      try { handle = opts.win.open('', '_blank'); } catch (e) { handle = null; }
      if (handle) {
        try { handle.opener = null; } catch (e) { /* cannot cut it: harmless, same origin */ }
        paintPlaceholder(handle, labels.title, labels.loading);
      }
    }
    var blocked = wanted && !handle;

    var run = Promise.resolve().then(function () { return opts.start(); });

    var tab = run.then(function (data) {
      if (!wanted) return { status: 'not-wanted' };
      var jobId = data && data.jobId;
      if (!jobId) {
        if (isOpen(handle)) { try { handle.close(); } catch (e) { /* gone */ } }
        return { status: 'run-failed' };
      }
      return Promise.resolve().then(function () { return opts.share(opts.userId, jobId); }).then(function (r) {
        var token = r && r.token;
        if (!token) throw new Error('no share token');
        var url = viewPath(opts.userId, jobId, token);
        if (blocked) return { status: 'blocked', url: url };
        if (!isOpen(handle)) return { status: 'closed', url: url };
        try { handle.location.replace(url); } catch (e) { return { status: 'blocked', url: url }; }
        return { status: 'navigated', url: url };
      }).catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        if (isOpen(handle)) paintPlaceholder(handle, labels.title, (labels.failed || '') + ' ' + msg);
        return { status: 'share-failed', error: msg };
      });
    }, function () {
      // The run was refused (validation, quota...). An empty tab helps nobody.
      if (isOpen(handle)) { try { handle.close(); } catch (e) { /* gone */ } }
      return { status: wanted ? 'run-failed' : 'not-wanted' };
    });

    return { opened: !!handle, blocked: blocked, run: run, tab: tab };
  }

  // ---- the live page: event feed -------------------------------------------

  /**
   * An event feed with replay de-duplication.
   *
   * On every (re)connect the server replays its buffer before the live events,
   * so the same event arrives again. RunState is idempotent for steps, but its
   * LOG is not, and a reconnect must not double it. Events carry a per-job
   * `seq`; a Set (not "highest so far") tolerates the mild reordering of
   * fire-and-forget publishes. Events without a seq are applied.
   */
  function createFeed(RunState, maxSeen) {
    var cap = maxSeen || 5000;
    var seen = {};
    var order = [];
    var state = RunState.create();
    // What the redesigned page needs beyond RunState (docs/uiux/24-HANDOFF):
    //   meta[index]  { top, depth } from step.start — places a live step in the plan
    //   events       bounded raw list (server time + type + data) for the log panel
    //   firstTs/endTs server timestamps, so the elapsed clock is right after a replay
    //   job          the job.start payload (origin, visibility, profile)
    var meta = {}; var events = []; var firstTs = null; var endTs = null; var job = null;
    function tsOf(ev) { var n = ev && ev.ts ? Date.parse(ev.ts) : NaN; return isNaN(n) ? null : n; }
    return {
      get state() { return state; },
      get meta() { return meta; },
      get events() { return events; },
      get firstTs() { return firstTs; },
      get endTs() { return endTs; },
      get job() { return job; },
      push: function (ev) {
        if (!ev || !ev.type) return false;
        if (typeof ev.seq === 'number' && ev.seq > 0) {
          if (seen[ev.seq]) return false;
          seen[ev.seq] = 1; order.push(ev.seq);
          if (order.length > cap) delete seen[order.shift()];
        }
        if (ev.jobId && !state.jobId) state.jobId = ev.jobId;
        RunState.applyEvent(state, ev);
        var d = ev.data || {};
        var ts = tsOf(ev);
        if (ts != null && (firstTs == null || ts < firstTs)) firstTs = ts;
        if (ev.type === 'job.start') { job = d; endTs = null; }
        if (ev.type === 'job.done' || ev.type === 'job.error') endTs = ts != null ? ts : Date.now();
        // A container (if / loop / try) and its FIRST child share one index in
        // the pipeline's numbering, so the first announcement (the container,
        // `top: k`) is kept: the child must not move the row out of the plan.
        if (ev.type === 'step.start' && d.index != null && !(meta[String(d.index)] && typeof meta[String(d.index)].top === 'number')) {
          meta[String(d.index)] = {
            top: typeof d.top === 'number' ? d.top : null,
            depth: typeof d.depth === 'number' ? d.depth : (typeof d.top === 'number' ? 0 : null),
          };
        }
        events.push({ t: ts != null ? ts : Date.now(), type: ev.type, data: d });
        if (events.length > 500) events.splice(0, events.length - 500);
        return true;
      },
      replace: function () {
        state = RunState.create(); seen = {}; order = [];
        meta = {}; events = []; firstTs = null; endTs = null; job = null;
      },
    };
  }

  // ---- the live page: names and phrases ------------------------------------

  // Product names of the actions (same words as the editor's NODE_DISPLAY_NAMES
  // -> i18n; tests/unit/live-tab.test.ts pins that they do not drift). The live
  // page loads neither flow-editor.js nor i18n.js, so it carries its own copy.
  var ACTION_NAMES = {
    goto: 'Open URL', 'open-extension': 'Open Extension', wait: 'Wait', launch: 'Launch Browser',
    'wait-element': 'Wait Element', delay: 'Delay', 'switch-frame': 'Switch Frame', 'switch-tab': 'Switch Tab',
    'close-tab': 'Close Tab', 'close-browser': 'Close Browser', 'handle-dialog': 'Handle Dialog',
    click: 'Click Element', dblclick: 'Double Click', hover: 'Hover', focus: 'Focus Element',
    'mouse-move': 'Move Mouse', 'drag-drop': 'Drag & Drop', scroll: 'Scroll Page', fill: 'Type Text',
    type: 'Type Keystrokes', press: 'Press Key', select: 'Select Option', check: 'Check Box',
    uncheck: 'Uncheck Box', upload: 'Upload File', 'remove-element': 'Remove Element', 'add-style': 'Inject CSS',
    extract: 'Extract Text', 'extract-data': 'Extract Data', 'parse-json': 'Parse JSON', code: 'Code (JavaScript)',
    'export-data': 'Export Data', screenshot: 'Screenshot', download: 'Download File', attribute: 'Read Attribute',
    variable: 'Set Variable', cookie: 'Cookies', clipboard: 'Clipboard', notification: 'Notification',
    log: 'Log Message', 'http-request': 'HTTP Request', if: 'Condition', switch: 'Switch', router: 'Router',
    loop: 'Loop', foreach: 'For Each', while: 'While Loop', try: 'Try / Catch', stop_and_error: 'Stop and Error',
    trigger_manual: 'Manual Trigger', trigger_webhook: 'Webhook Trigger', trigger_schedule: 'Schedule Trigger',
    trigger_telegram: 'Telegram Trigger',
  };
  function actionName(action) {
    var a = String(action || '');
    return ACTION_NAMES[a] || a || 'Step';
  }

  // [running, done, pending, takesTarget]. Only what the step DOES; the target
  // (URL / selector / wait) comes from the server's plan, never invented here.
  var VERBS = {
    launch: ['Launching the browser', 'Browser launched', 'Waiting to launch the browser', false],
    goto: ['Opening', 'Opened', 'Waiting to open', true],
    'open-extension': ['Opening extension', 'Opened extension', 'Waiting to open extension', true],
    wait: ['Waiting', 'Waited', 'Waiting to pause', true],
    delay: ['Waiting', 'Waited', 'Waiting to pause', true],
    'wait-element': ['Waiting for', 'Found', 'Waiting to look for', true],
    click: ['Clicking', 'Clicked', 'Waiting to click', true],
    dblclick: ['Double-clicking', 'Double-clicked', 'Waiting to double-click', true],
    hover: ['Hovering over', 'Hovered over', 'Waiting to hover over', true],
    focus: ['Focusing', 'Focused', 'Waiting to focus', true],
    fill: ['Typing into', 'Typed into', 'Waiting to type into', true],
    type: ['Typing into', 'Typed into', 'Waiting to type into', true],
    press: ['Pressing a key', 'Key pressed', 'Waiting to press a key', false],
    select: ['Selecting in', 'Selected in', 'Waiting to select in', true],
    check: ['Checking', 'Checked', 'Waiting to check', true],
    uncheck: ['Unchecking', 'Unchecked', 'Waiting to uncheck', true],
    upload: ['Uploading to', 'Uploaded to', 'Waiting to upload to', true],
    scroll: ['Scrolling the page', 'Page scrolled', 'Waiting to scroll', false],
    extract: ['Extracting from', 'Extracted from', 'Waiting to extract from', true],
    'extract-data': ['Extracting from', 'Extracted from', 'Waiting to extract from', true],
    attribute: ['Reading', 'Read', 'Waiting to read', true],
    screenshot: ['Capturing the page', 'Page captured', 'Waiting to capture the page', false],
    download: ['Downloading from', 'Downloaded from', 'Waiting to download from', true],
    'http-request': ['Requesting', 'Requested', 'Waiting to request', true],
    'close-browser': ['Closing the browser', 'Browser closed', 'Waiting to close the session', false],
    'close-tab': ['Closing the tab', 'Tab closed', 'Waiting to close the tab', false],
    'remove-element': ['Removing', 'Removed', 'Waiting to remove', true],
    'switch-frame': ['Switching to', 'Switched to', 'Waiting to switch to', true],
  };

  /**
   * The grey line under a step's name. `row` = { action, target, status, error }.
   *   running  "Clicking #add-to-cart-button"
   *   success  "Opened https://www.amazon.com"  /  "Browser launched successfully"
   *   pending  "Waiting to capture the page"
   */
  function stepPhrase(row) {
    var st = row.status;
    var tgt = row.target ? String(row.target) : '';
    if (st === 'error') return row.error ? String(row.error) : 'Failed';
    if (st === 'stopped') return 'Stopped before it finished';
    if (st === 'skipped') return 'Did not run';
    var v = VERBS[row.action];
    var i = st === 'running' ? 0 : st === 'pending' ? 2 : 1;
    if (v) {
      if (v[3] && tgt) return v[i] + ' ' + tgt;
      if (v[3]) return i === 0 ? 'Running\u2026' : i === 2 ? 'Waiting to run' : 'Completed successfully';
      return i === 1 ? v[1] + ' successfully' : v[i];
    }
    if (st === 'running') return tgt ? 'Running \u00b7 ' + tgt : 'Running\u2026';
    if (st === 'pending') return tgt ? 'Waiting \u00b7 ' + tgt : 'Waiting to run';
    return tgt || 'Completed successfully';
  }

  // ---- the live page: plan + live events -> one list -----------------------

  /**
   * The rows of "Execution steps (N)".
   *
   * `plan` (from GET /live/plan) lists the top-level chain before it runs. A
   * live step that announced `top: k` IS plan row k. Steps inside branches and
   * loops (`depth > 0`) are not promised by the plan; they are inserted under
   * the top-level row that was running when they started. Without a plan (an
   * older server, an evicted job) the rows are simply the live steps.
   *
   * Row: { key, num, index (live 1-based, or null), action, target, depth,
   *        status: pending|running|success|error|stopped|skipped, durationMs,
   *        error, inputItemCount, outputItemCount }
   */
  function mergePlan(plan, feedLike) {
    var st = feedLike && feedLike.state ? feedLike.state : null;
    var meta = (feedLike && feedLike.meta) || {};
    var planSteps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    var terminal = !!st && (st.phase === 'done' || st.phase === 'error' || st.phase === 'stopped');
    var live = st ? st.order.slice().sort(function (a, b) { return a - b; }) : [];

    function fromLive(i, target, depth) {
      var s = st.steps[String(i)];
      return {
        key: 'i' + i, index: i, action: s.action || '', target: target || '', depth: depth || 0,
        status: s.status, durationMs: s.durationMs, error: s.error,
        inputItemCount: s.inputItemCount, outputItemCount: s.outputItemCount,
      };
    }

    var out = [];
    if (!planSteps.length) {
      live.forEach(function (i) {
        var m = meta[String(i)] || {};
        out.push(fromLive(i, '', m.depth || 0));
      });
    } else {
      var byTop = {}; var nested = []; var extraTop = [];
      live.forEach(function (i) {
        var m = meta[String(i)] || {};
        if (typeof m.top === 'number' && m.top < planSteps.length && byTop[m.top] == null) byTop[m.top] = i;
        else if (m.depth > 0) nested.push(i);
        else extraTop.push(i);
      });
      planSteps.forEach(function (p, pos) {
        var i = byTop[pos];
        if (i != null) out.push(fromLive(i, p.target, 0));
        else out.push({ key: 'p' + pos, index: null, action: p.action, target: p.target || '', depth: 0,
          status: terminal ? 'skipped' : 'pending', durationMs: null, error: null,
          inputItemCount: null, outputItemCount: null });
        // nested steps that started after this top-level step and before the next one
        if (i != null) {
          var next = null;
          for (var k = pos + 1; k < planSteps.length; k++) if (byTop[k] != null) { next = byTop[k]; break; }
          nested.forEach(function (n) {
            if (n > i && (next == null || n < next)) out.push(fromLive(n, '', (meta[String(n)] || {}).depth || 1));
          });
        }
      });
      extraTop.forEach(function (i) { out.push(fromLive(i, '', 0)); });
    }
    out.forEach(function (r, n) { r.num = n + 1; });
    return out;
  }

  /** "Step 4 of 8": the running row, else the last row that ran. */
  function progress(rows) {
    var cur = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].status === 'running') { cur = rows[i]; break; }
    if (!cur) for (var j = rows.length - 1; j >= 0; j--) if (rows[j].index != null) { cur = rows[j]; break; }
    return { current: cur, at: cur ? cur.num : 0, total: rows.length };
  }

  /** 00:00:24 from two ms timestamps (end = now while the run is going). */
  function formatElapsed(startMs, endMs) {
    if (startMs == null || endMs == null) return '00:00:00';
    var s = Math.max(0, Math.floor((endMs - startMs) / 1000));
    var h = Math.floor(s / 3600); var m = Math.floor((s % 3600) / 60); var sec = s % 60;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(h) + ':' + p2(m) + ':' + p2(sec);
  }

  /** 0.45s / 1.28s / 12.3s / 2m 05s */
  function formatDuration(ms) {
    if (ms == null || !isFinite(ms)) return '';
    if (ms < 10000) return (ms / 1000).toFixed(2) + 's';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    var m = Math.floor(ms / 60000); var s = Math.floor((ms % 60000) / 1000);
    return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
  }

  /** 12:42:10.214 (local time of the event, as the server stamped it). */
  function formatClock(ms) {
    var d = new Date(ms);
    function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3);
  }

  /**
   * The Execution log panel: one readable line per event.
   * Line: { t, level: success|running|error|warn|info, text, step (row num or null) }
   * `rows` (from mergePlan) give each live index its displayed number and target.
   */
  function logLines(feedLike, rows) {
    var evs = (feedLike && feedLike.events) || [];
    var byIndex = {};
    (rows || []).forEach(function (r) { if (r.index != null) byIndex[String(r.index)] = r; });
    var out = [];
    evs.forEach(function (e) {
      var d = e.data || {};
      var r = d.index != null ? byIndex[String(d.index)] : null;
      var name = actionName(d.action);
      var tgt = r && r.target ? ' \u2014 ' + r.target : '';
      var num = r ? r.num : null;
      var line = null;
      switch (e.type) {
        case 'job.start': line = { level: 'info', text: 'Run started' + (d.profile ? ' (profile "' + d.profile + '"' + (d.visibility ? ', ' + d.visibility + ' browser' : '') + ')' : '') }; break;
        case 'step.start': line = { level: 'running', text: name + ' started' + tgt }; break;
        case 'step.done': line = d.success === false
          ? { level: 'error', text: name + ' failed' + (d.error ? ': ' + d.error : '') }
          : { level: 'success', text: name + ' finished' + (d.durationMs != null ? ' in ' + formatDuration(d.durationMs) : '') }; break;
        case 'step.error': line = { level: 'error', text: name + ' failed: ' + (d.error || d.message || 'error') }; break;
        case 'step.retry': line = { level: 'warn', text: name + ' retry ' + (d.attempt || '?') + '/' + (d.maxTries || '?') + (d.error ? ': ' + d.error : '') }; break;
        case 'step.path': line = { level: 'info', text: name + ' took path ' + (d.name || d.path || '') }; break;
        case 'job.done': line = { level: 'success', text: 'Run finished' + (d.durationMs != null ? ' in ' + formatDuration(d.durationMs) : '') }; break;
        case 'job.error': line = d.reason === 'cancelled'
          ? { level: 'warn', text: 'Run stopped' }
          : { level: 'error', text: 'Run failed: ' + (d.message || d.reason || 'error') }; break;
        case 'log': {
          var msg = String(d.message != null ? d.message : '');
          if (!msg) return;
          var lv = /\b(fail|error|exception)/i.test(msg) ? 'error' : /\b(warn|retry|skip|timeout|waiting)/i.test(msg) ? 'warn' : 'info';
          line = { level: lv, text: msg };
          break;
        }
        default: return;
      }
      line.t = e.t; line.step = num; line.type = e.type;
      out.push(line);
    });
    return out;
  }

  /** Log filter buckets for the "All events" menu. */
  var LOG_FILTERS = ['all', 'steps', 'errors', 'messages'];
  function filterLog(lines, f) {
    if (!f || f === 'all') return lines;
    return lines.filter(function (l) {
      if (f === 'errors') return l.level === 'error' || l.level === 'warn';
      if (f === 'steps') return l.type && l.type.indexOf('step.') === 0;
      if (f === 'messages') return l.type === 'log';
      return true;
    });
  }

  function planPath(userId, jobId, token) {
    return '/live/plan/' + enc(userId) + '/' + enc(jobId) + '?share=' + enc(token);
  }
  function restartPath(userId, jobId) {
    return '/live/restart/' + enc(userId) + '/' + enc(jobId);
  }
  function cancelPath(userId, jobId) {
    return '/cancel/' + enc(userId) + '/' + enc(jobId);
  }

  /** Reconnect delay: 0.5s, 1s, 2s, 4s ... capped, never zero. */
  function backoffMs(attempt) {
    var n = Math.max(0, Math.floor(Number(attempt) || 0));
    return Math.min(500 * Math.pow(2, n), 15000);
  }

  /**
   * Which step's output does the right-hand pane show?
   * A step the user clicked stays selected (pinned); otherwise follow the
   * newest step so a watcher sees what is happening now.
   */
  function pickSelected(state, pinned) {
    if (!state || !state.order.length) return null;
    if (pinned != null && state.steps[String(pinned)]) return pinned;
    return state.order[state.order.length - 1];
  }

  /** Timeline rows in step order. */
  function rows(state) {
    if (!state) return [];
    return state.order.slice().sort(function (a, b) { return a - b; }).map(function (i) {
      var s = state.steps[String(i)];
      return {
        index: i, action: s.action || '', status: s.status,
        durationMs: s.durationMs, error: s.error,
        inputItemCount: s.inputItemCount, outputItemCount: s.outputItemCount,
      };
    });
  }

  /** What the output pane shows for one step. Never throws on odd samples. */
  function stepDetail(state, index) {
    var s = state && state.steps[String(index)];
    if (!s) return null;
    var text = '';
    if (s.outputSample != null) {
      try { text = JSON.stringify(s.outputSample, null, 2); } catch (e) { text = String(s.outputSample); }
    }
    return {
      index: s.index, action: s.action, status: s.status, error: s.error,
      durationMs: s.durationMs, inputItemCount: s.inputItemCount,
      outputItemCount: s.outputItemCount, truncated: !!s.outputTruncated,
      outputText: text, consoleLogs: s.consoleLogs || [],
    };
  }

  /**
   * What the browser pane says, given the frame stream's status and the run's
   * phase. Returns a key the page translates; null means "just show the frame".
   */
  function paneMessage(frameStatus, phase, hasFrame) {
    if (frameStatus === 'busy') return 'lv.busy';
    if (frameStatus === 'error') return 'lv.frameError';
    if (frameStatus === 'live') return null;
    var terminal = phase === 'done' || phase === 'error' || phase === 'stopped';
    if (hasFrame) return null; // last picture stays up after the run
    if (terminal) return 'lv.noBrowser';
    return 'lv.waitingBrowser';
  }

  var api = {
    launchOptionsOf: launchOptionsOf, effectiveHeadless: effectiveHeadless, wantsLiveTab: wantsLiveTab,
    viewPath: viewPath, eventsPath: eventsPath, framesPath: framesPath,
    parseViewLocation: parseViewLocation, launch: launch,
    createFeed: createFeed, backoffMs: backoffMs, pickSelected: pickSelected,
    rows: rows, stepDetail: stepDetail, paneMessage: paneMessage,
    ACTION_NAMES: ACTION_NAMES, actionName: actionName, stepPhrase: stepPhrase, mergePlan: mergePlan,
    progress: progress, formatElapsed: formatElapsed, formatDuration: formatDuration, formatClock: formatClock,
    logLines: logLines, LOG_FILTERS: LOG_FILTERS, filterLog: filterLog,
    planPath: planPath, restartPath: restartPath, cancelPath: cancelPath,
  };
  root.LiveTab = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
