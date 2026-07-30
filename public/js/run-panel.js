/*
 * run-panel.js — collapsible bottom run/log drawer + live wiring (Step 26).
 *
 * Connects a running job's live event stream (window.LiveClient) to the DOM-free
 * run-state reducer (window.RunState) and:
 *   - renders a collapsible bottom drawer: a step timeline + connection status,
 *   - paints each graph node in the visual editor as running/success/error and
 *     feeds its INPUT/OUTPUT items into the NDV (window.FlowEditor),
 *   - persists the "last run" per workflow so it survives a reload,
 *   - supports PINNING a node's output (dev convenience: reuse without re-running).
 *
 * CSP-safe: no inline handlers, no eval. DOM-heavy by nature, so it is covered by
 * the browser smoke test; the pure reducer it builds on is unit-tested separately
 * (tests/unit/run-state.test.ts). LF line endings.
 *
 * Exposes window.RunPanel = {
 *   mount(refs), unmount(), open(), close(), toggle(),
 *   startJob({ userId, jobId, apiKey }), stop(),
 *   loadLastRun(workflowId), pin(nodeIndex0), unpin(nodeIndex0), getPins()
 * }
 */
(function () {
  'use strict';

  function U() { return window.AppUtil; }
  function t(k) { return U() ? U().t(k) : k; }
  function esc(s) { return U() ? U().esc(s) : String(s == null ? '' : s); }

  // Inline SVG icons (public/js/icons.js) — emoji rendered as empty boxes.
  function RIC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 14 }) : '';
  }

  var RS = window.RunState;
  var dom = null;       // { drawer, body, timeline, statusBadge, title, toggleBtn }
  var client = null;    // active LiveClient
  var state = null;     // RunState object
  var currentWfId = null;
  var pins = {};        // { nodeIndex0: { output, input } }  pinned node outputs
  var LAST_RUN_KEY = 'ab_last_run';   // localStorage prefix

  // ---- ACTIVITY LOG view state ----------------------------------------------
  // FOUR tabs, locked by the refreshed `docs/uiux/state-empty-canvas.webp`
  // (Runs · Execution · Variables · Logs). The older launcher-menu image showed
  // three and `04-HANDOFF` § 6.1 recorded that; the newer image wins, and
  // `Execution` is the tab it opens on.
  var AL_TABS = ['runs', 'execution', 'variables', 'logs'];
  var alTab = 'execution';
  var alAutoScroll = true;
  var alRuns = [];        // real jobs from API.listJobs — never mock rows
  var alFilter = '';      // '' = All Runs, else a jobId
  var subscribers = [];   // shell surfaces that mirror run state

  function emitUpdate() {
    subscribers.slice().forEach(function (fn) {
      try { fn(); } catch (e) { /* one bad subscriber must not stop the rest */ }
    });
  }

  // ---- node painting bridge -------------------------------------------------
  function FE() { return window.FlowEditor; }

  // Push the reducer's per-node status + items into the editor.
  function paintNodes() {
    var fe = FE();
    if (!fe || !state) return;
    var map = RS.nodeStatusMap(state);  // { nodeIndex0: status }
    Object.keys(map).forEach(function (i0) {
      if (fe.setNodeStatus) fe.setNodeStatus(Number(i0), map[i0]);
    });
    // feed NDV INPUT/OUTPUT per step (sample items) + badge meta
    state.order.forEach(function (idx1) {
      var s = state.steps[String(idx1)];
      if (!s) return;
      var nodeIndex0 = idx1 - 1;
      if (fe.setNodeResultsByIndex) {
        fe.setNodeResultsByIndex(nodeIndex0, {
          output: Array.isArray(s.outputSample) ? s.outputSample : (s.outputSample ? [s.outputSample] : []),
          meta: { outputItemCount: s.outputItemCount, inputItemCount: s.inputItemCount,
                  durationMs: s.durationMs, status: s.status, error: s.error },
        });
      }
    });
  }

  // ---- timeline rendering ---------------------------------------------------
  function statusIcon(st) {
    return RIC(st === 'success' ? 'check' : st === 'error' ? 'x'
      : st === 'running' ? 'clock' : 'dot', 13);
  }

  function renderTimeline() {
    if (!dom || !dom.timeline) return;
    var box = dom.timeline;
    box.innerHTML = '';
    if (!state || !state.order.length) {
      box.innerHTML = '<div class="muted small rp-empty">' + esc(t('rp.empty')) + '</div>';
      return;
    }
    state.order.forEach(function (idx1) {
      var s = state.steps[String(idx1)];
      if (!s) return;
      var idx0 = idx1 - 1;
      var row = document.createElement('div');
      row.className = 'rp-step rp-' + s.status;
      var isPinned = !!pins[idx0];
      var meta = [];
      if (s.outputItemCount != null) meta.push(s.outputItemCount + ' ' + t('rp.items'));
      if (s.durationMs != null) meta.push(s.durationMs + 'ms');
      var metaStr = meta.length ? ' · ' + meta.join(' · ') : '';
      var errStr = (s.status === 'error' && s.error) ? (' — ' + s.error) : '';
      row.innerHTML =
        '<span class="rp-step-icon">' + statusIcon(s.status) + '</span>' +
        '<span class="rp-step-idx">#' + idx1 + '</span>' +
        '<span class="rp-step-action">' + esc(s.action) + '</span>' +
        '<span class="rp-step-meta">' + esc(metaStr + errStr) + '</span>' +
        '<button class="rp-pin' + (isPinned ? ' on' : '') + '" title="' +
          esc(t('rp.pin')) + '">' + RIC('pin', 12) + '</button>';
      row.setAttribute('data-step', String(idx1));
      row.addEventListener('click', function () {
        var fe = FE();
        if (fe && fe.selectByChainIndex) fe.selectByChainIndex(idx0);
      });
      var pinBtn = row.querySelector('.rp-pin');
      if (pinBtn) pinBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (pins[idx0]) unpin(idx0); else pin(idx0);
      });
      box.appendChild(row);
    });
  }

  function renderHeader() {
    if (!dom) return;
    var c = state ? RS.counts(state) : { total: 0, running: 0, success: 0, error: 0 };
    var phase = state ? state.phase : 'idle';
    // `dom.title` is now the STATIC "ACTIVITY LOG" label the image shows, so the
    // run tally moved to its own sibling element instead of being concatenated
    // into the panel name (which used to read `Run — 3 ok / 0 err / 3`).
    if (dom.counts) {
      if (!c.total) {
        dom.counts.textContent = '';
      } else {
        var dur = (state && state.durationMs != null) ? (' · ' + state.durationMs + 'ms') : '';
        dom.counts.textContent = c.success + ' ok / ' + c.error + ' err / ' + c.total + dur;
      }
    }
    if (dom.statusBadge) {
      var cls = 'badge', label = t('rp.idle');
      if (phase === 'running') { cls = 'badge warn'; label = t('rp.running'); }
      else if (phase === 'done') { cls = 'badge ok'; label = t('rp.done'); }
      else if (phase === 'error') { cls = 'badge bad'; label = t('rp.error'); }
      dom.statusBadge.className = cls;
      dom.statusBadge.textContent = label;
    }
  }

  // ---- ACTIVITY LOG rendering (item E) --------------------------------------
  // Locked shape (`state-empty-canvas.webp` + `shell-editor-launcher-menu.webp`):
  //
  //   ACTIVITY LOG                                    Auto-scroll ●  [⤓] [⌃⌄]
  //   Runs | Execution | Variables | Logs
  //   [ All Runs ▾ ]  [ Clear ]
  //   Status │ Run ID │ Workflow │ Trigger │ Duration │ Finished At
  //
  // `Runs` is the 6-column table, `Execution` is the per-step event list of the
  // CURRENT run (that is what the image's timestamped lines are), `Variables`
  // lists the run's variables, `Logs` is the raw event log.
  function alTone(st) {
    if (st === 'completed' || st === 'success') return 'green';
    if (st === 'failed' || st === 'error') return 'red';
    if (st === 'active' || st === 'waiting' || st === 'delayed' || st === 'running') return 'amber';
    return 'muted';
  }
  function alWord(st) {
    if (st === 'completed' || st === 'success') return t('ndv.statusSuccess');
    if (st === 'failed' || st === 'error') return t('ndv.statusError');
    if (st === 'active' || st === 'running') return t('ndv.statusRunning');
    return t('ndv.statusIdle');
  }
  /** `12.45s` — seconds with two decimals, exactly as the image shows. */
  function alDuration(ms) {
    if (ms == null) return '—';
    return (ms / 1000).toFixed(2) + 's';
  }
  var AL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** `May 12, 2025 10:24:31 AM` — absolute, never the relative "2 min ago". */
  function alStamp(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var h = d.getHours(), ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return AL_MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() +
      ' ' + h + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + ' ' + ampm;
  }
  /** `10:24:31` — the Execution tab's per-event clock. */
  function alClock(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '--:--:--';
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  function renderTabs() {
    if (!dom || !dom.tabs) return;
    dom.tabs.innerHTML = AL_TABS.map(function (id) {
      return '<button type="button" role="tab" class="al-tab' +
        (alTab === id ? ' is-active' : '') + '" data-al-tab="' + id + '"' +
        ' aria-selected="' + (alTab === id ? 'true' : 'false') + '">' +
        esc(t('al.' + id)) + '</button>';
    }).join('');
    dom.tabs.querySelectorAll('[data-al-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        alTab = b.getAttribute('data-al-tab');
        renderTabs();
        renderBody();
      });
    });
  }

  /** The 6-column Runs table — real jobs only. */
  function renderRunsTable() {
    var cols = ['colStatus', 'colRunId', 'colWorkflow', 'colTrigger', 'colDuration', 'colFinishedAt'];
    var head = '<tr>' + cols.map(function (c) {
      return '<th scope="col">' + esc(t('al.' + c)) + '</th>';
    }).join('') + '</tr>';
    var rows = alRuns.filter(function (j) {
      return !alFilter || String(j.jobId) === alFilter;
    });
    if (!rows.length) {
      return '<div class="al-empty">' + esc(t('al.noRuns')) + '</div>';
    }
    var body = rows.map(function (j) {
      return '<tr>' +
        '<td><span class="al-st"><span class="al-dot tone-' + alTone(j.state) + '"></span>' +
          '<span class="al-st-word tone-' + alTone(j.state) + '">' + esc(alWord(j.state)) + '</span></span></td>' +
        '<td class="mono al-id">#' + esc(String(j.jobId)) + '</td>' +
        '<td>' + esc(j.workflowName || j.workflowId || '—') + '</td>' +
        '<td>' + esc(j.trigger || 'manual') + '</td>' +
        '<td class="mono">' + esc(alDuration(j.durationMs)) + '</td>' +
        '<td class="al-when">' + esc(alStamp(j.finishedAt || j.startedAt || j.timestamp)) + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="al-tablewrap"><table class="al-table">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  /** Per-step events of the CURRENT run: `10:24:31  Trigger — Webhook received`. */
  function renderExecutionList() {
    if (!state || !state.order.length) {
      return '<div class="al-empty">' + esc(t('al.noLogs')) + '</div>';
    }
    return '<div class="al-events">' + state.order.map(function (idx1) {
      var s = state.steps[String(idx1)];
      if (!s) return '';
      var detail = s.error ? s.error
        : (s.outputItemCount != null ? s.outputItemCount + ' ' + t('rp.items') : '');
      return '<div class="al-ev al-' + s.status + '">' +
        '<span class="al-ev-ic tone-' + alTone(s.status) + '">' + statusIcon(s.status) + '</span>' +
        '<span class="al-ev-time mono">' + esc(alClock(s.finishedAt || s.startedAt)) + '</span>' +
        '<span class="al-ev-action">' + esc(s.action) + '</span>' +
        (detail ? '<span class="al-ev-sep">—</span><span class="al-ev-detail">' + esc(detail) + '</span>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  /**
   * The workflow's variables.
   *
   * `RunState` deliberately has NO `variables` bag — the reducer only tracks
   * per-step status/items, and inventing one would mean storing derived state
   * twice. The truthful source is the graph itself: every `variable` action
   * declares a name, so the set of variables IS the set of those nodes. The
   * runtime value, when a run has produced one, comes from that step's output
   * sample; until then the value column honestly reads `—`.
   *
   * Returns `[{ name, value, source }]`, ordered by chain position.
   */
  function alVariables() {
    var fe = FE();
    var gs = fe && fe.getState ? fe.getState() : null;
    if (!gs || !gs.nodes) return [];
    var out = [];
    var seen = {};
    Object.keys(gs.nodes).forEach(function (id) {
      var n = gs.nodes[id];
      if (!n || n.action !== 'variable') return;
      var name = (n.params && n.params.name) || '';
      if (!name || seen[name]) return;
      seen[name] = true;
      // Value: prefer the recorded run output for this node, else unknown.
      var value = null;
      if (state) {
        for (var k = 0; k < state.order.length; k += 1) {
          var s = state.steps[String(state.order[k])];
          if (s && s.action === 'variable' && s.outputSample) {
            var sample = Array.isArray(s.outputSample) ? s.outputSample[0] : s.outputSample;
            if (sample && Object.prototype.hasOwnProperty.call(sample, name)) {
              value = sample[name];
              break;
            }
          }
        }
      }
      out.push({
        name: name,
        value: value,
        source: (fe.nodeLabel ? fe.nodeLabel(id) : null) || n.action,
      });
    });
    return out;
  }

  function renderVariables() {
    var vars = alVariables();
    if (!vars.length) return '<div class="al-empty">' + esc(t('al.noVars')) + '</div>';
    return '<div class="al-tablewrap"><table class="al-table">' +
      '<thead><tr><th scope="col">' + esc(t('al.varName')) + '</th>' +
      '<th scope="col">' + esc(t('al.varValue')) + '</th>' +
      '<th scope="col">' + esc(t('al.varSource')) + '</th></tr></thead><tbody>' +
      vars.map(function (v) {
        var shown = v.value == null ? '—'
          : (typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value));
        return '<tr><td class="mono">' + esc(v.name) + '</td>' +
          '<td class="mono">' + esc(shown) + '</td>' +
          '<td>' + esc(v.source) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderBody() {
    if (!dom || !dom.panelBody) return;
    if (alTab === 'runs') dom.panelBody.innerHTML = renderRunsTable();
    else if (alTab === 'execution') dom.panelBody.innerHTML = renderExecutionList();
    else if (alTab === 'variables') dom.panelBody.innerHTML = renderVariables();
    else {
      // `Logs` keeps the existing step timeline (clickable, pinnable) — it is
      // the raw view the editor already had.
      dom.panelBody.innerHTML = '<div class="rp-timeline" id="rp-timeline"></div>';
      dom.timeline = dom.panelBody.querySelector('#rp-timeline');
      renderTimeline();
    }
    if (alAutoScroll && dom.panelBody) dom.panelBody.scrollTop = dom.panelBody.scrollHeight;
  }

  function renderFilterRow() {
    if (!dom || !dom.filterRow) return;
    var opts = '<option value="">' + esc(t('al.allRuns')) + '</option>' +
      alRuns.map(function (j) {
        return '<option value="' + esc(String(j.jobId)) + '"' +
          (alFilter === String(j.jobId) ? ' selected' : '') + '>#' + esc(String(j.jobId)) + '</option>';
      }).join('');
    dom.filterRow.innerHTML =
      '<select class="al-select" id="al-flt" aria-label="' + esc(t('al.allRuns')) + '">' + opts + '</select>' +
      '<button type="button" class="al-btn" id="al-clear">' + esc(t('al.clear')) + '</button>';
    var sel = dom.filterRow.querySelector('#al-flt');
    if (sel) sel.addEventListener('change', function () { alFilter = sel.value; renderBody(); });
    var clr = dom.filterRow.querySelector('#al-clear');
    if (clr) clr.addEventListener('click', clearLog);
  }

  function renderAutoScroll() {
    if (!dom || !dom.autoBtn) return;
    dom.autoBtn.setAttribute('aria-pressed', alAutoScroll ? 'true' : 'false');
    dom.autoBtn.classList.toggle('on', alAutoScroll);
  }

  /** Load the REAL run history for the open workflow (no fabricated rows). */
  function refreshRuns() {
    var API = window.API;
    if (!API || !API.listJobs) return;
    var uid = API.getUserId ? API.getUserId() : null;
    if (!uid) {
      alRuns = [];
      if (dom && alTab === 'runs') {
        dom.panelBody.innerHTML = '<div class="al-empty">' + esc(t('al.needUser')) + '</div>';
      }
      return;
    }
    API.listJobs(uid, 20, currentWfId || undefined)
      .then(function (data) {
        alRuns = (data && data.jobs) || [];
        renderFilterRow();
        if (alTab === 'runs') renderBody();
      })
      .catch(function () { /* offline — the empty state already tells the truth */ });
  }

  function clearLog() {
    stop();
    state = RS.create();
    var fe = FE();
    if (fe && fe.clearStatuses) fe.clearStatuses();
    if (fe && fe.clearResults) fe.clearResults();
    renderAll();
  }

  function renderAll() {
    renderHeader();
    renderTabs();
    renderAutoScroll();
    renderBody();
    paintNodes();
    emitUpdate();
  }

  // ---- live wiring ----------------------------------------------------------
  function onEvent(ev) {
    state = RS.applyEvent(state, ev);
    renderAll();
    if (RS.isTerminal(state)) {
      persistLastRun();
    }
  }
  function onStatus(status) {
    if (!dom || !dom.connBadge) return;
    var cls = 'badge', label = status;
    if (status === 'connecting') { cls = 'badge warn'; label = t('live.connecting'); }
    else if (status === 'open') { cls = 'badge ok'; label = t('live.connected'); }
    else if (status === 'error') { cls = 'badge bad'; label = t('live.error'); }
    else if (status === 'closed') { cls = 'badge'; label = t('live.disconnected'); }
    dom.connBadge.className = cls;
    dom.connBadge.textContent = label;
  }

  function startJob(opts) {
    stop();
    state = RS.create();
    state.jobId = String(opts.jobId);
    var fe = FE();
    if (fe && fe.clearStatuses) fe.clearStatuses();
    if (fe && fe.clearResults) fe.clearResults();
    open();
    renderAll();
    if (!window.LiveClient) { onStatus('error'); return; }
    client = new window.LiveClient({
      userId: opts.userId,
      jobId: opts.jobId,
      apiKey: opts.apiKey || (window.API && window.API.getKey ? window.API.getKey() : ''),
      onEvent: onEvent,
      onStatus: onStatus,
    });
    client.connect();
  }

  function stop() {
    if (client && client.close) { try { client.close(); } catch (e) {} }
    client = null;
    // Aborting a live run must leave a TERMINAL phase, otherwise the top-bar
    // slot would stay latched on "Stop" forever with nothing left to stop.
    // (`startJob`/`clearLog` also call stop() first, but both immediately
    // replace `state` with a fresh one, so this is inert for them.)
    if (state && state.phase === 'running') {
      state.phase = 'done';
      if (state.finishedAt == null) state.finishedAt = Date.now();
      if (state.durationMs == null && state.startedAt != null) {
        state.durationMs = state.finishedAt - state.startedAt;
      }
      renderHeader();
    }
    emitUpdate();
  }

  // ---- last-run persistence -------------------------------------------------
  function persistLastRun() {
    if (!state) return;
    try {
      var key = LAST_RUN_KEY + ':' + (currentWfId || '_local');
      // Strip the (potentially large) log; keep steps + phase for restore.
      var slim = {
        phase: state.phase, jobId: state.jobId, durationMs: state.durationMs,
        error: state.error, steps: state.steps, order: state.order,
      };
      localStorage.setItem(key, JSON.stringify(slim));
    } catch (e) { /* quota / serialization — non-fatal */ }
  }

  function loadLastRun(workflowId) {
    currentWfId = workflowId || null;
    try {
      var key = LAST_RUN_KEY + ':' + (currentWfId || '_local');
      var raw = localStorage.getItem(key);
      if (!raw) return false;
      var slim = JSON.parse(raw);
      state = RS.create();
      state.phase = slim.phase || 'idle';
      state.jobId = slim.jobId || null;
      state.durationMs = slim.durationMs != null ? slim.durationMs : null;
      state.error = slim.error || null;
      state.steps = slim.steps || {};
      state.order = slim.order || [];
      renderAll();
      return true;
    } catch (e) { return false; }
  }

  // ---- pinning --------------------------------------------------------------
  function pin(nodeIndex0) {
    if (!state) return;
    var s = state.steps[String(nodeIndex0 + 1)];
    if (!s) return;
    pins[nodeIndex0] = {
      output: Array.isArray(s.outputSample) ? s.outputSample : (s.outputSample ? [s.outputSample] : []),
    };
    var fe = FE();
    if (fe && fe.pinByIndex) fe.pinByIndex(nodeIndex0, true);
    renderTimeline();
  }
  function unpin(nodeIndex0) {
    delete pins[nodeIndex0];
    var fe = FE();
    if (fe && fe.pinByIndex) fe.pinByIndex(nodeIndex0, false);
    renderTimeline();
  }
  function getPins() { return pins; }

  // ---- drawer mount/teardown ------------------------------------------------
  // ---- open/closed state, sticky across reloads (G6) -------------------------
  // The refreshed `docs/uiux/state-empty-canvas.webp` shows the ACTIVITY LOG
  // **open** on the `Execution` tab, so that is the default. It is a preference,
  // not a constant: the user may collapse it, and that choice must survive a
  // route change and a reload — the drawer is unmounted/remounted on every
  // editor mount (`views.js#renderEditor`), so without persistence a collapse
  // silently reverted a moment later.
  //
  // Stored in the ONE namespaced blob `localStorage['ab_ui_prefs']` via
  // AppUtil.pref, exactly like `fePaletteCollapsed` / `feOutlineOpen`.
  var DOCK_PREF = 'feDockOpen';

  function dockPref(fallback) {
    var u = U();
    return u && u.pref ? !!u.pref(DOCK_PREF, fallback) : fallback;
  }
  function rememberDock(openState) {
    var u = U();
    if (u && u.setPref) u.setPref(DOCK_PREF, !!openState);
  }

  /**
   * @param {boolean} [remember=true] pass `false` for the restore pass in
   *   `mount()`: re-applying a stored value is not a fresh user choice, and
   *   writing it back would make the pref un-resettable from outside.
   */
  function open(remember) {
    if (!dom || !dom.drawer) return;
    dom.drawer.classList.add('open');
    if (dom.toggleBtn) dom.toggleBtn.innerHTML = RIC('chevron-down', 13);
    if (remember !== false) rememberDock(true);
  }
  function close(remember) {
    if (!dom || !dom.drawer) return;
    dom.drawer.classList.remove('open');
    if (dom.toggleBtn) dom.toggleBtn.innerHTML = RIC('chevron-right', 13);
    if (remember !== false) rememberDock(false);
  }
  function toggle() { if (dom && dom.drawer) { dom.drawer.classList.contains('open') ? close() : open(); } }

  /**
   * Open the drawer on a specific tab.
   *
   * Exists because other chrome needs to point AT a tab: the blocks palette's
   * `Variables` footer entry has no route of its own — the workflow's variables
   * live in this panel — so instead of inventing a dead `#/variables` hash it
   * calls `RunPanel.showTab('variables')`. Unknown ids are ignored rather than
   * silently landing the user on some other tab.
   */
  function showTab(id) {
    if (AL_TABS.indexOf(id) === -1) return false;
    if (!dom) return false;
    alTab = id;
    renderTabs();
    renderBody();
    open();
    return true;
  }

  function mount() {
    if (dom) return;            // already mounted (singleton drawer)
    var drawer = document.createElement('div');
    drawer.className = 'run-panel';
    drawer.id = 'run-panel';
    // ACTIVITY LOG dock (item E). The title row carries the panel name plus the
    // Auto-scroll switch, a download button and the collapse control; the tab
    // strip sits below it, then the All Runs / Clear filter row, then the body.
    drawer.innerHTML =
      '<div class="rp-head al-head" id="rp-head">' +
        '<span class="al-title" id="rp-title">' + esc(t('al.title')) + '</span>' +
        '<span class="al-counts mono small muted" id="al-counts"></span>' +
        '<span class="rp-badges">' +
          '<span class="badge" id="rp-status">' + esc(t('rp.idle')) + '</span>' +
          '<span class="badge" id="rp-conn">—</span>' +
        '</span>' +
        '<button type="button" class="al-switch" id="al-auto" role="switch" aria-checked="true"' +
          ' aria-pressed="true" title="' + esc(t('al.autoScroll')) + '">' +
          '<span class="al-sw-label">' + esc(t('al.autoScroll')) + '</span>' +
          '<span class="al-sw" aria-hidden="true"><i></i></span>' +
        '</button>' +
        '<button type="button" class="al-icobtn" id="al-dl" title="' + esc(t('al.download')) + '"' +
          ' aria-label="' + esc(t('al.download')) + '">' + RIC('download', 13) + '</button>' +
        '<button type="button" class="al-icobtn rp-toggle" id="rp-toggle" title="' + esc(t('al.collapse')) + '"' +
          ' aria-label="' + esc(t('al.collapse')) + '">' + RIC('arrows-vertical', 13) + '</button>' +
      '</div>' +
      '<div class="al-tabs" id="al-tabs" role="tablist" aria-label="' + esc(t('al.title')) + '"></div>' +
      '<div class="al-filter" id="al-filter"></div>' +
      '<div class="rp-body al-body" id="rp-body"></div>';
    document.body.appendChild(drawer);

    dom = {
      drawer: drawer,
      body: drawer.querySelector('#rp-body'),
      panelBody: drawer.querySelector('#rp-body'),
      timeline: null,               // created by the `Logs` tab on demand
      tabs: drawer.querySelector('#al-tabs'),
      filterRow: drawer.querySelector('#al-filter'),
      autoBtn: drawer.querySelector('#al-auto'),
      title: drawer.querySelector('#rp-title'),
      counts: drawer.querySelector('#al-counts'),
      statusBadge: drawer.querySelector('#rp-status'),
      connBadge: drawer.querySelector('#rp-conn'),
      toggleBtn: drawer.querySelector('#rp-toggle'),
    };
    drawer.querySelector('#rp-toggle').addEventListener('click', toggle);
    drawer.querySelector('#rp-head').addEventListener('click', function (ev) {
      // clicking the head (but not a control) toggles too
      if (ev.target && ev.target.id === 'rp-head') toggle();
    });
    dom.autoBtn.addEventListener('click', function () {
      alAutoScroll = !alAutoScroll;
      dom.autoBtn.setAttribute('aria-checked', alAutoScroll ? 'true' : 'false');
      renderAutoScroll();
      if (alAutoScroll && dom.panelBody) dom.panelBody.scrollTop = dom.panelBody.scrollHeight;
    });
    // Download exports whatever the log actually holds — no placeholder file.
    drawer.querySelector('#al-dl').addEventListener('click', function () {
      var payload = {
        workflowId: currentWfId || null,
        phase: state ? state.phase : 'idle',
        jobId: state ? state.jobId : null,
        steps: state ? state.steps : {},
        runs: alRuns,
      };
      try {
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'activity-log-' + (currentWfId || 'draft') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) { /* no Blob support — non-fatal */ }
    });
    renderFilterRow();
    renderAll();
    refreshRuns();

    // G6: restore the sticky open/closed state (default OPEN, per the locked
    // image) WITHOUT recording the restore as a user choice.
    if (dockPref(true)) open(false); else close(false);
  }

  function unmount() {
    stop();
    if (dom && dom.drawer && dom.drawer.parentNode) dom.drawer.parentNode.removeChild(dom.drawer);
    dom = null;
  }

  // ---- shell bridge (item A/E) ----------------------------------------------
  /**
   * A read-only snapshot of the current run for shell surfaces (the canvas
   * run-info strip and the Run/Stop slot in the top bar).
   *
   * Returns a fresh plain object every call — the caller must never be handed a
   * live reference into `state`, or the "derived state, never stored" rule would
   * be broken by aliasing.
   */
  function getSummary() {
    var c = state ? RS.counts(state) : { total: 0, running: 0, success: 0, error: 0 };
    return {
      phase: state ? state.phase : 'idle',
      jobId: state ? state.jobId : null,
      total: c.total,
      running: c.running,
      success: c.success,
      error: c.error,
      durationMs: state ? state.durationMs : null,
      startedAt: state ? state.startedAt : null,
      finishedAt: state ? state.finishedAt : null,
      // A COUNT, not the bag: the strip only shows "Variables  3".
      variables: alVariables().length,
    };
  }

  /**
   * Subscribe to run-state republications. Mirrors `FlowEditor.onChange()`:
   * returns an unsubscribe function so the editor view can tear its listener
   * down on re-render (language switch / route change) instead of stacking up.
   */
  function onUpdate(fn) {
    if (typeof fn !== 'function') return function () {};
    subscribers.push(fn);
    return function () {
      var i = subscribers.indexOf(fn);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  window.RunPanel = {
    mount: mount,
    unmount: unmount,
    open: open,
    close: close,
    toggle: toggle,
    showTab: showTab,
    startJob: startJob,
    stop: stop,
    loadLastRun: loadLastRun,
    pin: pin,
    unpin: unpin,
    getPins: getPins,
    getSummary: getSummary,
    onUpdate: onUpdate,
    refreshRuns: refreshRuns,
  };
})();
