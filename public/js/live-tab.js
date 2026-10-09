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
    return {
      get state() { return state; },
      push: function (ev) {
        if (!ev || !ev.type) return false;
        if (typeof ev.seq === 'number') {
          if (seen[ev.seq]) return false;
          seen[ev.seq] = 1; order.push(ev.seq);
          if (order.length > cap) delete seen[order.shift()];
        }
        if (ev.jobId && !state.jobId) state.jobId = ev.jobId;
        RunState.applyEvent(state, ev);
        return true;
      },
      replace: function () { state = RunState.create(); seen = {}; order = []; },
    };
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
  };
  root.LiveTab = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
