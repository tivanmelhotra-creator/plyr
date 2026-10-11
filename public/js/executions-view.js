/*
 * executions-view.js — the editor's Executions mode (Aria Automate, 2026-10).
 *
 * Layout (locked by the 2026-10 Executions reference image):
 *
 *   [ Executions list ] [ hero: status, Execution #id, Started, Duration, status pill, Auto-scroll, Download, more ]
 *   [ All/Success/... ] [ stat cards: Total steps . Successful . Failed . Skipped                                  ]
 *   [ search          ] [ tabs: Execution . Variables . Logs                                                       ]
 *   [ #1042 Success > ] [ step timeline (expandable rows)              ] [ Execution Details card ]                ]
 *
 * ONE normalised run model feeds every surface, whatever its source:
 *   - the LIVE run of this session      -> RunPanel.getSnapshot() (event stream)
 *   - an active run of another session  -> GET /job (stepOutputs so far)
 *   - a finished run                    -> GET /job (job file: stepOutputs,
 *                                          runLog, variables, runMeta)
 * Nothing is invented: a value the server did not report renders as `—`, and
 * a step the run never reached is shown as "Not run", never as a success.
 *
 * CSP-safe: no inline handlers, no eval; delegated click/key/input listeners.
 * Exposes window.ExecutionsView = { mount(host, ctx), unmount(), refresh(),
 *   onRunUpdate(), normalizeStored, normalizeLive, logSource, fmtDuration, ... }.
 */
(function () {
  'use strict';

  function U() { return window.AppUtil; }
  function t(k) { return U() ? U().t(k) : k; }
  function esc(s) {
    if (U()) return U().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function IC(name, size) { return window.Icons ? window.Icons.svg(name, { size: size || 14 }) : ''; }
  function fill(str, map) {
    return String(str).replace(/\{(\w+)\}/g, function (m, k) { return map[k] == null ? m : String(map[k]); });
  }
  function FE() { return window.FlowEditor; }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function toDate(v) {
    if (v == null || v === '') return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  /** `Oct 11, 2026 16:24` */
  function fmtDate(v) {
    var d = toDate(v);
    if (!d) return '—';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  /** List rows: `Oct 11, 16:24` (the year only when it is not this year). */
  function fmtShort(v) {
    var d = toDate(v);
    if (!d) return '—';
    var y = d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear();
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + y + ', ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  /** `Oct 11, 2026 16:24:03` */
  function fmtDateSec(v) {
    var d = toDate(v);
    return d ? fmtDate(d) + ':' + p2(d.getSeconds()) : '—';
  }
  /** `16:24:03.120` — log clock */
  function fmtClock(v) {
    var d = toDate(v);
    if (!d) return '--:--:--';
    var ms = d.getMilliseconds();
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + (ms < 10 ? '00' : ms < 100 ? '0' : '') + ms;
  }
  /** `850ms` · `4.2s` · `12s` · `2m 14s` · `1h 3m` */
  function fmtDuration(ms) {
    if (ms == null || isNaN(ms)) return '—';
    ms = Math.max(0, Math.round(ms));
    if (ms < 1000) return ms + 'ms';
    if (ms < 10000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + p2(s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function itemsText(n) { return fill(t(n === 1 ? 'xv.item' : 'xv.items'), { n: n }); }
  function toMs(v) { var d = toDate(v); return d ? d.getTime() : null; }

  // ---------------------------------------------------------------------------
  // Status vocabulary — one place, so the list, the hero, the pills and the
  // stat cards can never disagree about what a word means.
  // ---------------------------------------------------------------------------
  var STATUS = {
    success: { tone: 'green', icon: 'check', label: 'xv.st.success' },
    partial: { tone: 'amber', icon: 'alert-triangle', label: 'xv.st.partial' },
    error: { tone: 'red', icon: 'x', label: 'xv.st.error' },
    running: { tone: 'orange', icon: 'loader', label: 'xv.st.running' },
    queued: { tone: 'blue', icon: 'hourglass', label: 'xv.st.queued' },
    stopped: { tone: 'muted', icon: 'stop-circle', label: 'xv.st.stopped' },
    skipped: { tone: 'orange', icon: 'more-horizontal', label: 'xv.st.skipped' },
    pending: { tone: 'muted', icon: 'minus', label: 'xv.st.notRun' },
    unknown: { tone: 'muted', icon: 'help-circle', label: 'xv.st.unknown' },
  };
  function st(s) { return STATUS[s] || STATUS.unknown; }
  function stateToStatus(state) {
    if (state === 'completed') return 'success';
    if (state === 'failed') return 'error';
    if (state === 'active') return 'running';
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') return 'queued';
    return 'unknown';
  }
  function statusPill(s, extra) {
    var d = st(s);
    return '<span class="xv-pill tone-' + d.tone + (extra ? ' ' + extra : '') + '">' +
      '<span class="xv-dot" aria-hidden="true"></span>' + esc(t(d.label)) + '</span>';
  }
  function statusBadge(s, size) {
    var d = st(s);
    return '<span class="xv-badge tone-' + d.tone + (s === 'running' ? ' is-spin' : '') +
      (size ? ' is-' + size : '') + '" aria-hidden="true">' + IC(d.icon, size === 'lg' ? 18 : 12) + '</span>';
  }
  var TRIGGER = {
    manual: 'xv.trig.manual', workflow: 'xv.trig.workflow', schedule: 'xv.trig.schedule',
    node: 'xv.trig.node', webhook: 'xv.trig.webhook',
  };
  function triggerLabel(tr) { return TRIGGER[tr] ? t(TRIGGER[tr]) : (tr ? String(tr) : '—'); }

  // ---------------------------------------------------------------------------
  // Log sources — the `[TAG]` prefix the worker writes decides the category.
  // ---------------------------------------------------------------------------
  var SOURCES = ['system', 'step', 'browser', 'network', 'user'];
  function logSource(text) {
    var m = /^\s*\[([A-Za-z][A-Za-z0-9_-]*)/.exec(String(text || ''));
    var tag = m ? m[1].toUpperCase() : '';
    if (tag === 'BROWSER' || tag === 'GLOBALBROWSER' || tag === 'REAL-CHROME' || tag === 'EXT') return 'browser';
    if (tag === 'HTTP' || tag === 'WEBHOOK' || tag === 'FETCH') return 'network';
    if (tag === 'USER' || tag === 'CONSOLE') return 'user';
    if (tag === 'STEP' || tag === 'CONTINUE-ON-FAIL' || tag === 'RETRY' || tag === 'LOOP' || tag === 'IF') return 'step';
    return 'system';
  }
  function logLevel(text, fallback) {
    var s = String(text || '');
    if (/\b(fail(ed|ure)?|error|exception|crash(ed)?)\b/i.test(s)) return 'error';
    if (/\b(warn(ing)?|retry(ing)?|skip(ped)?|timeout|ignored)\b/i.test(s)) return 'warn';
    return fallback || 'info';
  }
  function stripTag(text) { return String(text || '').replace(/^\s*\[[A-Za-z][A-Za-z0-9_-]*\]\s*/, ''); }

  // ---------------------------------------------------------------------------
  // Step identity: the graph names a step when the run's step lines up with
  // the CURRENT design (same action at the same position). Otherwise the
  // action's human name is used — an old run never borrows a new node's name.
  // ---------------------------------------------------------------------------
  var EVENT_TRIGGERS = { trigger_schedule: 1, trigger_webhook: 1, trigger_telegram: 1 };
  // The worker reports some steps under its own name (a `goto` node runs as
  // `navigate`). Map them back so they line up with the design and read with
  // the node's human name.
  var ENGINE_ALIAS = { navigate: 'goto', 'goto-url': 'goto' };
  function designAction(a) { return ENGINE_ALIAS[a] || a; }
  function planNodes() {
    var fe = FE();
    if (!fe || !fe.stepNodeIds || !fe.getState) return [];
    var gs = fe.getState();
    return fe.stepNodeIds().map(function (id) {
      var n = gs && gs.nodes ? gs.nodes[id] : null;
      return n ? {
        id: id, action: n.action,
        title: fe.nodeLabel ? fe.nodeLabel(id) : n.action,
        desc: fe.nodeSummary ? fe.nodeSummary(id) : '',
      } : null;
    }).filter(Boolean);
  }
  function actionName(action) {
    var fe = FE();
    var a = designAction(action);
    return fe && fe.actionLabel ? fe.actionLabel(a) : String(a || '');
  }
  function cleanDesc(d) { return d && d !== t('fe.noParams') ? d : ''; }
  function identify(step, plan) {
    var p = plan[step.n - 1];
    if (p && p.action === designAction(step.action)) {
      step.title = p.title || actionName(step.action);
      step.desc = cleanDesc(p.desc);
      step.nodeId = p.id;
    } else {
      step.title = actionName(step.action);
      step.desc = '';
      step.nodeId = null;
    }
    return step;
  }
  /** Steps the run never reached — only when every executed step matched the plan. */
  function appendNotRun(steps, plan, runStatus) {
    if (runStatus !== 'error' && runStatus !== 'stopped') return steps;
    if (!plan.length || steps.length >= plan.length) return steps;
    for (var i = 0; i < steps.length; i++) {
      if (!plan[i] || plan[i].action !== designAction(steps[i].action) || steps[i].n !== i + 1) return steps;
    }
    for (var k = steps.length; k < plan.length; k++) {
      steps.push({
        n: k + 1, action: plan[k].action, title: plan[k].title, desc: cleanDesc(plan[k].desc),
        nodeId: plan[k].id, status: 'pending', durationMs: null, notRun: true,
      });
    }
    return steps;
  }

  // ---------------------------------------------------------------------------
  // Normalisers
  // ---------------------------------------------------------------------------
  function stepLogLine(s, at) {
    var base = fill(t('xv.log.stepLine'), { n: s.n, name: s.title || s.action });
    var text, level = 'info';
    if (s.status === 'error') { text = base + ' — ' + t('xv.log.failed') + (s.error ? ': ' + s.error : ''); level = 'error'; }
    else if (s.status === 'skipped') { text = base + ' — ' + t('xv.log.skipped'); level = 'warn'; }
    else if (s.status === 'running') { text = base + ' — ' + t('xv.log.started'); }
    else {
      text = base + ' — ' + fill(t('xv.log.doneIn'), { d: fmtDuration(s.durationMs) }) +
        (s.outCount != null ? ' · ' + itemsText(s.outCount) : '');
      level = 'success';
    }
    return { t: at, level: level, source: 'step', text: text, step: s.n };
  }

  /**
   * A run from the job list (+ optional GET /job payload) -> the view model.
   * @param {object} job   row of GET /jobs
   * @param {object} [d]   GET /job payload (job file / live outputs)
   */
  function normalizeStored(job, d) {
    job = job || {};
    d = d || {};
    var plan = planNodes();
    var status = stateToStatus(d.state || job.state);
    if (d.cancelledByUser || d.userCancelled) status = 'stopped';
    var outs = Array.isArray(d.stepOutputs) ? d.stepOutputs : [];
    var startedAt = job.startedAt || (d.runMeta && d.runMeta.startedAt) || null;
    var steps = outs.map(function (o, i) {
      var r = o && o.result;
      var skipped = !!(r && typeof r === 'object' && r.skipped === true) ||
        (!!EVENT_TRIGGERS[o.action] && job.trigger !== 'schedule');
      var s = {
        n: Number(o.step) || i + 1,
        action: String(o.action || ''),
        status: o.success === false ? 'error' : (skipped ? 'skipped' : 'success'),
        durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
        at: toMs(o.timestamp),
        inCount: o.inputItemCount != null ? o.inputItemCount : null,
        outCount: o.outputItemCount != null ? o.outputItemCount : null,
        sample: o.outputSample != null ? o.outputSample
          : (r != null && typeof r === 'object' && !Array.isArray(r) ? [r] : null),
        truncated: !!o.outputTruncated,
        error: o.error || null,
        consoleLogs: Array.isArray(o.consoleLogs) ? o.consoleLogs : [],
      };
      return identify(s, plan);
    });
    if (status === 'success' && steps.some(function (s) { return s.status === 'error'; })) status = 'partial';
    steps = appendNotRun(steps, plan, status);

    // Logs = what the run said + one line per step outcome, in time order.
    var logs = [];
    (Array.isArray(d.runLog) ? d.runLog : []).forEach(function (l) {
      if (!l) return;
      logs.push({ t: toMs(l.t), level: l.level || logLevel(l.text), source: logSource(l.text), text: stripTag(l.text) });
    });
    steps.forEach(function (s) {
      if (s.notRun || s.at == null) return;
      logs.push(stepLogLine(s, s.at));
    });
    logs.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });

    var err = job.failedReason || (d.success === false ? (d.error || d.message) : null) || null;
    if (err === 'CANCELLED_BY_USER') err = null;
    return {
      jobId: String(job.jobId != null ? job.jobId : d.jobId),
      status: status,
      live: false,
      startedAt: startedAt,
      finishedAt: job.finishedAt || d.finishedOn || null,
      durationMs: job.durationMs != null ? job.durationMs : (d.durationMs != null ? d.durationMs : null),
      trigger: job.trigger || null,
      workflowVersion: job.workflowVersion != null ? job.workflowVersion : null,
      scheduleName: job.scheduleName || null,
      error: err,
      steps: steps,
      logs: logs,
      variables: d.variables && typeof d.variables === 'object' ? d.variables : null,
      meta: d.runMeta || null,
      detailLoaded: !!(d.stepOutputs || d.state),
    };
  }

  /** The LIVE run of this session (RunPanel snapshot) -> the view model. */
  function normalizeLive(snap, job) {
    job = job || {};
    var plan = planNodes();
    var map = { idle: 'unknown', running: 'running', done: 'success', error: 'error', stopped: 'stopped' };
    var status = map[snap.phase] || 'unknown';
    // Event order is first-SEEN order (a reconnect replays old events), so
    // the rows are put back into step order.
    var order = (snap.order || []).slice().sort(function (a, b) { return a - b; });
    var steps = order.map(function (idx1) {
      var x = snap.steps[String(idx1)] || {};
      return identify({
        n: idx1, action: x.action || '', status: x.status || 'running',
        durationMs: x.durationMs != null ? x.durationMs : null,
        at: x.finishedAt || x.startedAt || null,
        startedAt: x.startedAt || null,
        inCount: x.inputItemCount != null ? x.inputItemCount : null,
        outCount: x.outputItemCount != null ? x.outputItemCount : null,
        sample: x.outputSample != null ? x.outputSample : null, truncated: !!x.outputTruncated,
        error: x.error || null, consoleLogs: Array.isArray(x.consoleLogs) ? x.consoleLogs : [],
      }, plan);
    });
    steps.forEach(function (s) {
      if (s.status === 'success' && EVENT_TRIGGERS[s.action]) s.status = 'skipped';
    });
    if (status === 'success' && steps.some(function (s) { return s.status === 'error'; })) status = 'partial';
    steps = appendNotRun(steps, plan, status);
    function stepName(i, fallback) {
      var s = steps.filter(function (x) { return x.n === i; })[0];
      return s ? s.title : (fallback || '');
    }
    var logs = (snap.log || []).map(function (e) {
      var line = function (rest) { return fill(t('xv.log.stepLine'), { n: e.index, name: stepName(e.index, e.action) }) + ' — ' + rest; };
      if (e.type === 'log') return { t: e.t, level: logLevel(e.text), source: logSource(e.text), text: stripTag(e.text) };
      if (e.type === 'step.start') return { t: e.t, level: 'info', source: 'step', step: e.index, text: line(t('xv.log.started')) };
      if (e.type === 'step.done') {
        var s = steps.filter(function (x) { return x.n === e.index; })[0];
        return s ? stepLogLine(s, e.t) : { t: e.t, level: 'success', source: 'step', text: line(t('xv.log.done')) };
      }
      if (e.type === 'step.error') return { t: e.t, level: 'error', source: 'step', step: e.index, text: line(e.text || t('xv.log.failed')) };
      if (e.type === 'step.retry') return { t: e.t, level: 'warn', source: 'step', step: e.index, text: line(e.text) };
      if (e.type === 'step.path') return { t: e.t, level: 'info', source: 'step', step: e.index, text: line(e.text) };
      if (e.type === 'job.start') return { t: e.t, level: 'info', source: 'system', text: t('xv.log.jobStart') };
      if (e.type === 'job.done') return { t: e.t, level: 'success', source: 'system', text: t('xv.log.jobDone') };
      if (e.type === 'job.error') return { t: e.t, level: 'error', source: 'system', text: e.text || t('xv.st.error') };
      if (e.type === 'job.stopped') return { t: e.t, level: 'warn', source: 'system', text: t('xv.log.jobStopped') };
      return { t: e.t, level: 'info', source: 'system', text: e.type + (e.text ? ' ' + e.text : '') };
    });
    return {
      jobId: String(snap.jobId),
      status: status,
      live: true,
      startedAt: job.startedAt || (snap.startedAt ? new Date(snap.startedAt).toISOString() : null),
      finishedAt: job.finishedAt || (snap.finishedAt ? new Date(snap.finishedAt).toISOString() : null),
      durationMs: snap.durationMs != null ? snap.durationMs
        : (status === 'running' && snap.startedAt ? Date.now() - snap.startedAt
          : (job.durationMs != null ? job.durationMs : null)),
      trigger: job.trigger || 'manual',
      workflowVersion: job.workflowVersion != null ? job.workflowVersion : null,
      scheduleName: null,
      error: snap.error || job.failedReason || null,
      steps: steps,
      logs: logs,
      variables: snap.variables && Object.keys(snap.variables).length ? snap.variables : null,
      meta: null,
      detailLoaded: true,
    };
  }

  function stepCounts(steps) {
    var c = { total: 0, success: 0, error: 0, skipped: 0, running: 0, pending: 0 };
    (steps || []).forEach(function (s) {
      c.total++;
      if (s.status === 'success') c.success++;
      else if (s.status === 'error') c.error++;
      else if (s.status === 'skipped') c.skipped++;
      else if (s.status === 'running') c.running++;
      else c.pending++;
    });
    return c;
  }

  // ---------------------------------------------------------------------------
  // Variables: declared (graph) + runtime (run) -> grouped rows
  // ---------------------------------------------------------------------------
  var SYSTEM_VARS = { loop_index: 1, error_message: 1, last_error: 1 };
  var SAVE_AS_ACTIONS = { variable: 'name', extract: 'name', attribute: 'name', 'http-request': 'name' };
  function declaredVariables() {
    var fe = FE();
    var gs = fe && fe.getState ? fe.getState() : null;
    var out = {};
    if (!gs || !gs.nodes) return out;
    Object.keys(gs.nodes).forEach(function (id) {
      var n = gs.nodes[id];
      if (!n || n.disabled === true) return;
      var key = SAVE_AS_ACTIONS[n.action];
      var p = n.params || {};
      var name = (key && p[key]) || p.saveAs || '';
      if (n.action === 'foreach' && p.itemVar) name = p.itemVar;
      if (!name) return;
      name = String(name);
      if (!out[name]) out[name] = { node: fe.nodeLabel ? fe.nodeLabel(id) : n.action, nodeId: id };
    });
    return out;
  }
  function valueType(v) {
    if (v == null) return 'null';
    var s = String(v);
    if (/^\u2022+$/.test(s)) return 'secret';
    if (/^-?\d+(\.\d+)?$/.test(s)) return 'number';
    if (s === 'true' || s === 'false') return 'boolean';
    if (/^\s*\[/.test(s)) return 'array';
    if (/^\s*\{/.test(s)) return 'object';
    if (/^https?:\/\//i.test(s)) return 'url';
    return 'string';
  }
  function variableGroups(run) {
    var declared = declaredVariables();
    var rt = (run && run.variables) || {};
    var rows = { workflow: [], system: [] };
    var seen = {};
    Object.keys(declared).forEach(function (name) {
      seen[name] = true;
      var has = Object.prototype.hasOwnProperty.call(rt, name);
      rows.workflow.push({ name: name, value: has ? rt[name] : null, set: has, source: declared[name].node });
    });
    Object.keys(rt).forEach(function (name) {
      if (seen[name]) return;
      var sys = !!SYSTEM_VARS[name];
      (sys ? rows.system : rows.workflow).push({
        name: name, value: rt[name], set: true, source: t(sys ? 'xv.var.engine' : 'xv.var.runtime'),
      });
    });
    return rows;
  }

  // ---------------------------------------------------------------------------
  // View state
  // ---------------------------------------------------------------------------
  var host = null;
  var ctx = null;          // { userId(), workflowId(), workflowName(), environment(), openStep(i0), openEditor(), api }
  var runs = [];           // GET /jobs rows, newest first
  var details = {};        // jobId -> GET /job payload
  var inflight = {};
  var loading = false;
  var listError = '';
  var sel = null;          // selected jobId
  var filter = 'all';      // all | success | error | running
  var query = '';
  var tab = 'execution';   // execution | variables | logs
  var openSteps = {};      // `${jobId}:${n}` -> true
  var logLevelFilter = 'all';
  var logSourceOff = {};   // source -> true when hidden
  var logQuery = '';
  var logWrap = true;
  var varQuery = '';
  var menuOpen = false;
  var autoScroll = true;
  var pollTimer = null;
  var tickTimer = null;
  var lastWf = null;
  var lastLiveId = null;

  function pref(k, d) { return U() && U().pref ? U().pref(k, d) : d; }
  function setPref(k, v) { if (U() && U().setPref) U().setPref(k, v); }
  function api() { return (ctx && ctx.api) || window.API; }

  function liveSnap() {
    var RP = window.RunPanel;
    var s = RP && RP.getSnapshot ? RP.getSnapshot() : null;
    return s && s.jobId ? s : null;
  }
  function jobRow(id) {
    for (var i = 0; i < runs.length; i++) if (String(runs[i].jobId) === String(id)) return runs[i];
    return null;
  }
  /** The view model of a jobId (the live snapshot wins for this session's run). */
  function runModel(id) {
    if (!id) return null;
    var snap = liveSnap();
    var job = jobRow(id);
    var d = details[id];
    if (snap && String(snap.jobId) === String(id) && (snap.order || []).length) {
      // Once the run is over and its job file is loaded, the stored record is
      // the more complete one (runLog + run metadata).
      if (snap.phase !== 'running' && d && d.stepOutputs && d.state !== 'active') {
        return normalizeStored(job || { jobId: id }, d);
      }
      return normalizeLive(snap, job);
    }
    if (!job) return null;
    return normalizeStored(job, d);
  }
  /** Status of a list row: the detail refines `completed` into partial/stopped. */
  function rowStatus(j) {
    var id = String(j.jobId);
    var snap = liveSnap();
    if (snap && String(snap.jobId) === id && snap.phase === 'running') return 'running';
    if (details[id] && !details[id].__error) return runModel(id).status;
    return stateToStatus(j.state);
  }
  function filterMatch(s) {
    if (filter === 'success') return s === 'success';
    if (filter === 'error') return s === 'error' || s === 'partial' || s === 'stopped';
    if (filter === 'running') return s === 'running' || s === 'queued';
    return true;
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  function refresh() {
    if (!host || !ctx) return Promise.resolve();
    var wf = ctx.workflowId();
    var uid = ctx.userId();
    if (wf !== lastWf) { lastWf = wf; runs = []; details = {}; sel = null; openSteps = {}; }
    if (!wf || !uid || !api() || !api().listJobs) { runs = []; render(); return Promise.resolve(); }
    loading = !runs.length;
    if (loading) render();
    return api().listJobs(uid, 50, wf)
      .then(function (d) {
        listError = '';
        runs = ((d && d.jobs) || []).filter(function (j) { return !j.partial; });
      })
      .catch(function (e) { listError = (e && e.message) || String(e); })
      .then(function () {
        loading = false;
        var snap = liveSnap();
        if (snap && snap.phase === 'running' && !jobRow(snap.jobId)) {
          runs.unshift({ jobId: snap.jobId, state: 'active', trigger: 'manual', startedAt: null });
        }
        if (!sel || !jobRow(sel)) sel = runs.length ? String(runs[0].jobId) : null;
        // A detail fetched while the run was active is stale once it finished.
        runs.forEach(function (j) {
          var id = String(j.jobId), dd = details[id];
          if (dd && (dd.state === 'active' || dd.state === 'waiting' || dd.state === 'delayed') &&
              (j.state === 'completed' || j.state === 'failed')) delete details[id];
        });
        prefetch();
        render();
        schedulePoll();
      });
  }
  /** Details for the selection and the first rows (so their pills are exact). */
  function prefetch() {
    if (sel) loadDetail(sel);
    runs.slice(0, 15).forEach(function (j) {
      if (j.state === 'completed' || j.state === 'failed') loadDetail(String(j.jobId));
    });
  }
  function loadDetail(id, force) {
    if (!id || inflight[id] || !ctx) return;
    if (!force && details[id] && details[id].state !== 'active') return;
    var uid = ctx.userId();
    if (!uid || !api() || !api().getJob) return;
    inflight[id] = true;
    api().getJob(uid, id).then(function (d) {
      details[id] = d || {};
    }).catch(function (e) {
      details[id] = { __error: (e && e.message) || String(e) };
    }).then(function () {
      delete inflight[id];
      render();
    });
  }
  function anyActive() {
    var snap = liveSnap();
    if (snap && snap.phase === 'running') return true;
    return runs.some(function (j) { return j.state === 'active' || j.state === 'waiting' || j.state === 'delayed'; });
  }
  function schedulePoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (!host || !anyActive()) return;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      var j = sel && jobRow(sel);
      if (j && j.state === 'active') loadDetail(sel, true);
      refresh();
    }, 4000);
    // The clock of a live run ticks between events.
    tickTimer = setInterval(function () {
      var r = runModel(sel);
      if (r && r.status === 'running') paintHero();
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Rendering — list
  // ---------------------------------------------------------------------------
  function render() {
    if (!host) return;
    paintList();
    paintDetail();
  }

  function emptyBlock(icon, title, text) {
    return '<li class="xv-empty" role="note">' +
      '<span class="xv-empty-ic">' + IC(icon, 20) + '</span>' +
      '<b>' + esc(title) + '</b><span>' + esc(text) + '</span></li>';
  }
  function skeletonRows() {
    var r = '';
    for (var i = 0; i < 6; i++) r += '<li class="xv-skel" aria-hidden="true"><span></span><span></span><span></span></li>';
    return r;
  }

  function paintList() {
    var el = host.querySelector('#xv-list');
    if (!el) return;
    var counts = { all: runs.length, success: 0, error: 0, running: 0 };
    var statuses = {};
    runs.forEach(function (j) {
      var s = rowStatus(j);
      statuses[j.jobId] = s;
      if (s === 'success') counts.success++;
      else if (s === 'error' || s === 'partial' || s === 'stopped') counts.error++;
      else if (s === 'running' || s === 'queued') counts.running++;
    });
    var totalEl = host.querySelector('#xv-total');
    if (totalEl) totalEl.textContent = fill(t('xv.total'), { n: runs.length });
    var fdefs = [['all', 'xv.f.all', 'orange'], ['success', 'xv.f.success', 'green'],
      ['error', 'xv.f.error', 'red'], ['running', 'xv.f.running', 'amber']];
    host.querySelector('#xv-filters').innerHTML = fdefs.map(function (f) {
      var on = filter === f[0];
      return '<button type="button" role="radio" class="xv-chip tone-' + f[2] + (on ? ' is-on' : '') +
        '" aria-checked="' + on + '" data-xv-filter="' + f[0] + '">' +
        '<span class="xv-dot" aria-hidden="true"></span>' +
        '<span>' + esc(t(f[1])) + '</span><b>' + counts[f[0]] + '</b></button>';
    }).join('');

    if (!ctx.workflowId()) { el.innerHTML = emptyBlock('save', t('xv.empty.needSavedTitle'), t('xv.empty.needSaved')); return; }
    if (loading) { el.innerHTML = skeletonRows(); return; }
    if (listError) { el.innerHTML = emptyBlock('alert-triangle', t('xv.empty.loadFailed'), listError); return; }
    if (!runs.length) { el.innerHTML = emptyBlock('play-circle', t('xv.empty.noRunsTitle'), t('xv.empty.noRuns')); return; }
    var q = query.trim().toLowerCase().replace(/^#/, '');
    var rows = runs.filter(function (j) {
      if (!filterMatch(statuses[j.jobId])) return false;
      if (!q) return true;
      var hay = (j.jobId + ' ' + t(st(statuses[j.jobId]).label) + ' ' + triggerLabel(j.trigger) + ' ' +
        fmtDate(j.startedAt || j.timestamp)).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (!rows.length) { el.innerHTML = emptyBlock('search', t('xv.empty.noMatchTitle'), t('xv.empty.noMatch')); return; }
    el.innerHTML = rows.map(function (j) {
      var id = String(j.jobId);
      var s = statuses[j.jobId];
      var on = sel === id;
      var dur = j.durationMs;
      if (s === 'running') { var m = runModel(id); dur = m ? m.durationMs : null; }
      return '<li><button type="button" class="xv-run tone-' + st(s).tone + (on ? ' is-on' : '') +
        '" data-xv-run="' + esc(id) + '" aria-current="' + (on ? 'true' : 'false') + '">' +
        statusBadge(s) +
        '<span class="xv-run-main">' +
          '<span class="xv-run-id">#' + esc(id) + '</span>' +
          '<span class="xv-run-meta"><span>' + esc(fmtShort(j.startedAt || j.timestamp)) + '</span>' +
            '<i aria-hidden="true">·</i><span>' + esc(dur != null ? fmtDuration(dur) : '—') + '</span></span>' +
        '</span>' +
        statusPill(s, 'is-sm') +
        '<span class="xv-run-chev" aria-hidden="true">' + IC('chevron-right', 14) + '</span>' +
      '</button></li>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Rendering — detail
  // ---------------------------------------------------------------------------
  function paintDetail() {
    var el = host.querySelector('#xv-detail');
    if (!el) return;
    var run = runModel(sel);
    if (!run) {
      var hasWf = !!ctx.workflowId();
      el.removeAttribute('data-run');
      el.innerHTML = '<div class="xv-detail-empty">' +
        '<span class="xv-empty-ic is-lg">' + IC(hasWf ? 'history' : 'save', 26) + '</span>' +
        '<b>' + esc(t(hasWf ? (runs.length ? 'xv.empty.pickTitle' : 'xv.empty.noRunsTitle') : 'xv.empty.needSavedTitle')) + '</b>' +
        '<span>' + esc(t(hasWf ? (runs.length ? 'xv.empty.pick' : 'xv.empty.noRuns') : 'xv.empty.needSaved')) + '</span></div>';
      return;
    }
    var d = details[sel];
    if (!run.live && !run.detailLoaded && !(d && d.__error)) loadDetail(sel);
    // Keep scroll positions across re-renders (live events re-render often).
    var panel = el.querySelector('.xv-tabpanel');
    var keep = panel ? panel.scrollTop : 0;
    var logBox = el.querySelector('.xv-logs-body');
    var keepLog = logBox ? logBox.scrollTop : 0;
    var atBottom = logBox ? (logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24) : true;
    var sameRun = el.getAttribute('data-run') === run.jobId;

    el.setAttribute('data-run', run.jobId);
    el.innerHTML =
      '<header class="xv-hero" id="xv-hero">' + heroHtml(run) + '</header>' +
      '<section class="xv-stats" aria-label="' + esc(t('xv.statsLabel')) + '">' + statsHtml(run) + '</section>' +
      '<nav class="xv-tabs" role="tablist" aria-label="' + esc(t('xv.tabsLabel')) + '">' + tabsHtml(run) + '</nav>' +
      '<div class="xv-tabpanel" role="tabpanel">' + tabHtml(run, d) + '</div>';

    var np = el.querySelector('.xv-tabpanel');
    if (np && sameRun) np.scrollTop = keep;
    var nl = el.querySelector('.xv-logs-body');
    if (nl) nl.scrollTop = (autoScroll && (atBottom || !sameRun) && run.live) ? nl.scrollHeight : (sameRun ? keepLog : 0);
    if (run.live && autoScroll && run.status === 'running' && tab === 'execution') {
      var cur = el.querySelector('.xv-step.is-running');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  function paintHero() {
    var hero = host && host.querySelector('#xv-hero');
    var run = runModel(sel);
    if (hero && run) hero.innerHTML = heroHtml(run);
  }

  function heroHtml(run) {
    var name = ctx.workflowName() || t('fe.untitled');
    return '<div class="xv-hero-id">' +
        statusBadge(run.status, 'lg') +
        '<div class="xv-hero-title">' +
          '<h2><span>' + esc(fill(t('xv.execution'), { id: run.jobId })) + '</span>' +
            '<button type="button" class="xv-icobtn is-xs" data-xv-copy="' + esc(run.jobId) + '" title="' + esc(t('xv.copyId')) + '" aria-label="' + esc(t('xv.copyId')) + '">' + IC('copy', 13) + '</button></h2>' +
          '<span class="xv-hero-wf" title="' + esc(name) + '">' + esc(name) + '</span>' +
          '<span class="xv-hero-tags"><span class="xv-tag">' + esc(triggerLabel(run.trigger)) + '</span>' +
            (run.workflowVersion != null ? '<span class="xv-tag">v' + esc(run.workflowVersion) + '</span>' : '') +
            (run.live && run.status === 'running' ? '<span class="xv-tag tone-orange">' + esc(t('xv.thisSession')) + '</span>' : '') +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="xv-hero-facts">' +
        heroFact('calendar', t('xv.started'), fmtDate(run.startedAt)) +
        heroFact('clock', t('xv.duration'), run.status === 'queued' ? t('xv.st.queued') : fmtDuration(run.durationMs)) +
        '<div class="xv-fact is-status">' + statusPill(run.status, 'is-lg') + '</div>' +
      '</div>' +
      '<div class="xv-hero-actions">' +
        '<button type="button" class="al-switch xv-auto' + (autoScroll ? ' on' : '') + '" data-xv-auto role="switch" aria-checked="' + autoScroll + '" aria-pressed="' + autoScroll + '">' +
          '<span class="al-sw-label">' + esc(t('xv.autoScroll')) + '</span><span class="al-sw" aria-hidden="true"><i></i></span></button>' +
        '<button type="button" class="xv-btn" data-xv-download title="' + esc(t('xv.downloadHint')) + '">' + IC('download', 13) + '<span>' + esc(t('xv.download')) + '</span></button>' +
        '<div class="xv-menuwrap">' +
          '<button type="button" class="xv-icobtn" data-xv-menu aria-haspopup="menu" aria-expanded="' + menuOpen + '" title="' + esc(t('xv.more')) + '" aria-label="' + esc(t('xv.more')) + '">' + IC('more-horizontal', 15) + '</button>' +
          (menuOpen ? menuHtml(run) : '') +
        '</div>' +
      '</div>';
  }
  function heroFact(icon, label, value) {
    return '<div class="xv-fact"><span class="xv-fact-label">' + esc(label) + '</span>' +
      '<span class="xv-fact-val">' + IC(icon, 15) + '<span>' + esc(value) + '</span></span></div>';
  }
  function firstFail(run) {
    return run.steps.filter(function (s) { return s.status === 'error'; })[0] || null;
  }
  function menuHtml(run) {
    var items = [
      ['copy-id', 'copy', t('xv.copyId')],
      ['copy-json', 'braces', t('xv.copyJson')],
      ['dl-logs', 'file-text', t('xv.log.download')],
      ['open-editor', 'pencil', t('xv.openEditor')],
    ];
    var fail = firstFail(run);
    if (fail && fail.nodeId) items.push(['open-failed', 'target', fill(t('xv.openFailed'), { n: fail.n })]);
    if (run.status === 'running' || run.status === 'queued') items.push(['cancel', 'stop-circle', t('xv.cancelRun')]);
    return '<div class="xv-menu" role="menu">' + items.map(function (it) {
      return '<button type="button" role="menuitem" class="xv-menu-item' + (it[0] === 'cancel' ? ' is-danger' : '') +
        '" data-xv-act="' + it[0] + '">' + IC(it[1], 14) + '<span>' + esc(it[2]) + '</span></button>';
    }).join('') + '</div>';
  }

  function statsHtml(run) {
    var c = stepCounts(run.steps);
    var cards = [
      ['muted', 'file-text', t('xv.stat.total'), c.total,
        c.pending ? fill(t('xv.stat.notRun'), { n: c.pending }) : (c.running ? t('xv.st.running') : '')],
      ['green', 'check', t('xv.stat.success'), c.success, c.total ? Math.round((c.success / c.total) * 100) + '%' : ''],
      ['red', 'x', t('xv.stat.failed'), c.error, ''],
      ['orange', 'more-horizontal', t('xv.stat.skipped'), c.skipped, ''],
    ];
    return cards.map(function (k) {
      return '<article class="xv-stat tone-' + k[0] + (k[3] ? '' : ' is-zero') + '">' +
        '<span class="xv-stat-ic" aria-hidden="true">' + IC(k[1], 17) + '</span>' +
        '<span class="xv-stat-txt"><span class="xv-stat-label">' + esc(k[2]) + '</span>' +
        '<b class="xv-stat-val">' + k[3] + '</b></span>' +
        (k[4] ? '<span class="xv-stat-sub">' + esc(k[4]) + '</span>' : '') +
      '</article>';
    }).join('');
  }

  function tabsHtml(run) {
    var vars = variableGroups(run);
    var nVars = vars.workflow.length + vars.system.length;
    var nErr = run.logs.filter(function (l) { return l.level === 'error'; }).length;
    var defs = [
      ['execution', t('xv.tab.execution'), run.steps.length, ''],
      ['variables', t('xv.tab.variables'), nVars, ''],
      ['logs', t('xv.tab.logs'), nErr || run.logs.length, nErr ? 'red' : ''],
    ];
    return defs.map(function (d) {
      var on = tab === d[0];
      return '<button type="button" role="tab" class="xv-tab' + (on ? ' is-active' : '') + '" aria-selected="' + on + '" data-xv-tab="' + d[0] + '">' +
        '<span>' + esc(d[1]) + '</span>' + (d[2] ? '<b class="xv-tab-n' + (d[3] ? ' tone-' + d[3] : '') + '">' + d[2] + '</b>' : '') + '</button>';
    }).join('');
  }

  function tabHtml(run, d) {
    if (d && d.__error && !run.live) {
      return '<div class="xv-panel-empty is-tall">' + IC('alert-triangle', 20) + '<b>' + esc(t('xv.empty.loadFailed')) + '</b><span>' + esc(d.__error) + '</span></div>';
    }
    if (tab === 'variables') return variablesHtml(run);
    if (tab === 'logs') return logsHtml(run);
    return executionHtml(run);
  }

  // ---- Execution tab -------------------------------------------------------
  function allOpen(run) {
    var real = run.steps.filter(function (s) { return !s.notRun; });
    return real.length > 0 && real.every(function (s) { return openSteps[run.jobId + ':' + s.n]; });
  }
  function executionHtml(run) {
    var steps = run.steps;
    var list;
    if (!run.detailLoaded) {
      list = '<div class="xv-panel-empty">' + IC('loader', 16) + '<span>' + esc(t('xv.loading')) + '</span></div>';
    } else if (!steps.length) {
      list = '<div class="xv-panel-empty">' + IC(run.status === 'queued' ? 'hourglass' : 'info', 16) + '<span>' +
        esc(t(run.status === 'queued' ? 'xv.queuedHint' : 'xv.noSteps')) + '</span></div>';
    } else {
      list = '<ol class="xv-timeline">' + steps.map(function (s) { return stepHtml(run, s); }).join('') + '</ol>';
    }
    var fail = firstFail(run);
    var banner = run.error || fail
      ? '<div class="xv-banner tone-red" role="alert">' + IC('alert-triangle', 15) +
          '<div><b>' + esc(fail ? fill(t('xv.failedAt'), { n: fail.n, name: fail.title }) : t('xv.runFailed')) + '</b>' +
          '<span>' + esc(String(run.error || (fail && fail.error) || '')) + '</span></div>' +
          (fail && fail.nodeId ? '<button type="button" class="xv-btn is-sm" data-xv-open-step="' + fail.n + '">' + IC('target', 12) + '<span>' + esc(t('xv.showNode')) + '</span></button>' : '') +
        '</div>'
      : '';
    return '<div class="xv-exec-grid">' +
      '<section class="xv-card xv-steps-card" aria-label="' + esc(t('xv.stepsLabel')) + '">' +
        '<header class="xv-card-head"><h3>' + esc(t('xv.stepsLabel')) + '</h3>' +
          (steps.length ? '<span class="xv-card-sub">' + esc(fill(t('xv.stepsSub'), { n: steps.length })) + '</span>' +
            '<span class="xv-spacer"></span><button type="button" class="xv-link" data-xv-expand-all>' +
            esc(t(allOpen(run) ? 'xv.collapseAll' : 'xv.expandAll')) + '</button>' : '') +
        '</header>' + banner + list +
      '</section>' +
      '<aside class="xv-card xv-details" aria-label="' + esc(t('xv.detailsTitle')) + '">' + detailsHtml(run) + '</aside>' +
    '</div>';
  }

  function stepHtml(run, s) {
    var open = !!openSteps[run.jobId + ':' + s.n];
    var dur = s.status === 'running' && s.startedAt ? Date.now() - s.startedAt : s.durationMs;
    var expandable = !s.notRun;
    var desc = s.status === 'error' && s.error ? s.error : (s.desc || actionName(s.action));
    return '<li class="xv-step is-' + s.status + (open ? ' is-open' : '') + '">' +
      '<div class="xv-step-row"' + (expandable ? ' role="button" tabindex="0" aria-expanded="' + open + '" data-xv-step="' + s.n + '"' : '') + '>' +
        '<span class="xv-step-n">' + s.n + '.</span>' +
        '<span class="xv-step-rail">' + statusBadge(s.status) + '</span>' +
        '<span class="xv-step-main">' +
          '<span class="xv-step-title"><i>' + s.n + '</i>' + esc(s.title || s.action) + '</span>' +
          '<span class="xv-step-desc" title="' + esc(desc) + '">' + esc(desc) + '</span>' +
        '</span>' +
        '<span class="xv-step-items">' + (s.outCount != null && !s.notRun
          ? '<span title="' + esc(t('xv.itemsFlow')) + '">' + esc((s.inCount != null ? s.inCount : '–') + ' → ' + s.outCount) + '</span>' : '') + '</span>' +
        '<span class="xv-step-time">' + esc(s.notRun ? '—' : fmtDuration(dur)) + '</span>' +
        '<span class="xv-step-pill">' + statusPill(s.status, 'is-sm') + '</span>' +
        '<span class="xv-step-chev" aria-hidden="true">' + (expandable ? IC(open ? 'chevron-down' : 'chevron-right', 14) : '') + '</span>' +
      '</div>' +
      (open ? stepBodyHtml(s) : '') +
    '</li>';
  }

  function stepBodyHtml(s) {
    var json = '';
    if (s.sample != null) {
      try { json = JSON.stringify(s.sample, null, 2); } catch (e) { json = String(s.sample); }
      if (json.length > 6000) json = json.slice(0, 6000) + '\n…';
    }
    var facts = [
      [t('xv.sf.node'), actionName(s.action) + ' (' + designAction(s.action) + ')'],
      [t('xv.sf.duration'), fmtDuration(s.durationMs)],
      [t('xv.sf.input'), s.inCount != null ? itemsText(s.inCount) : '—'],
      [t('xv.sf.output'), s.outCount != null ? itemsText(s.outCount) + (s.truncated ? ' · ' + t('xv.truncated') : '') : '—'],
      [t('xv.sf.finished'), s.at ? fmtClock(s.at) : '—'],
    ];
    return '<div class="xv-step-body">' +
      '<dl class="xv-step-facts">' + facts.map(function (f) {
        return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>';
      }).join('') + '</dl>' +
      (s.error ? '<div class="xv-step-err">' + IC('alert-circle', 13) + '<span>' + esc(s.error) + '</span></div>' : '') +
      (s.consoleLogs && s.consoleLogs.length ? '<div class="xv-sub"><span class="xv-sub-title">' + esc(t('xv.console')) + '</span>' +
        '<pre class="xv-code">' + esc(s.consoleLogs.join('\n')) + '</pre></div>' : '') +
      (json ? '<div class="xv-sub"><span class="xv-sub-title">' + esc(t('xv.outputSample')) +
        '<button type="button" class="xv-link" data-xv-copy-text="' + esc(json) + '">' + IC('copy', 11) + '<span>' + esc(t('xv.copy')) + '</span></button></span>' +
        '<pre class="xv-code">' + esc(json) + '</pre></div>'
        : '<div class="xv-sub is-muted">' + esc(t('xv.noOutput')) + '</div>') +
      (s.nodeId ? '<div class="xv-step-actions"><button type="button" class="xv-btn is-sm" data-xv-open-step="' + s.n + '">' +
        IC('target', 12) + '<span>' + esc(t('xv.showNode')) + '</span></button></div>' : '') +
    '</div>';
  }

  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function detailsHtml(run) {
    var env = ctx.environment ? ctx.environment() : '';
    var meta = run.meta || {};
    var c = stepCounts(run.steps);
    function row(label, value, extra) {
      return '<div class="xv-kv"><dt>' + esc(label) + '</dt><dd>' + value + (extra || '') + '</dd></div>';
    }
    var summary;
    if (run.status === 'success') summary = c.skipped ? fill(t('xv.sum.successSkipped'), { n: c.skipped }) : t('xv.sum.success');
    else if (run.status === 'partial') summary = fill(t('xv.sum.partial'), { n: c.error });
    else if (run.status === 'error') summary = fill(t('xv.sum.error'), { ok: c.success, n: c.total });
    else if (run.status === 'stopped') summary = fill(t('xv.sum.stopped'), { ok: c.success });
    else if (run.status === 'running') summary = fill(t('xv.sum.running'), { ok: c.success });
    else if (run.status === 'queued') summary = t('xv.sum.queued');
    else summary = t('xv.sum.unknown');
    return '<h3 class="xv-card-title">' + esc(t('xv.detailsTitle')) + '</h3>' +
      '<dl class="xv-kvs">' +
        row(t('xv.d.workflow'), esc(ctx.workflowName() || t('fe.untitled'))) +
        row(t('xv.d.id'), '<span class="mono">#' + esc(run.jobId) + '</span>',
          '<button type="button" class="xv-icobtn is-xs" data-xv-copy="' + esc(run.jobId) + '" aria-label="' + esc(t('xv.copyId')) + '">' + IC('copy', 12) + '</button>') +
        row(t('xv.d.status'), statusPill(run.status, 'is-sm')) +
        row(t('xv.d.started'), esc(fmtDateSec(run.startedAt))) +
        row(t('xv.d.finished'), esc(run.status === 'running' || run.status === 'queued' ? '—' : fmtDateSec(run.finishedAt))) +
        row(t('xv.d.duration'), esc(fmtDuration(run.durationMs))) +
      '</dl>' +
      '<hr class="xv-sep" />' +
      '<dl class="xv-kvs">' +
        row(t('xv.d.environment'), env ? '<span class="xv-tag tone-blue">' + esc(env) + '</span>' : '—') +
        row(t('xv.d.trigger'), esc(triggerLabel(run.trigger)) + (run.scheduleName ? ' <span class="xv-muted">· ' + esc(run.scheduleName) + '</span>' : '')) +
        row(t('xv.d.browser'), esc(meta.visibility ? cap(meta.visibility) : '—')) +
        row(t('xv.d.profile'), esc(meta.profile || '—')) +
        row(t('xv.d.version'), esc(run.workflowVersion != null ? 'v' + run.workflowVersion : '—')) +
      '</dl>' +
      '<hr class="xv-sep" />' +
      '<h4 class="xv-card-title is-sm">' + esc(t('xv.d.summary')) + '</h4>' +
      '<p class="xv-summary">' + statusBadge(run.status) + '<span>' + esc(summary) + '</span></p>' +
      (c.total ? progressBar(c) : '');
  }
  function progressBar(c) {
    function seg(n, tone) {
      return n ? '<span class="xv-prog-seg tone-' + tone + '" style="flex-grow:' + n + '"></span>' : '';
    }
    function legend(n, tone, label) {
      return n ? '<li><span class="xv-dot tone-' + tone + '"></span><span>' + esc(label) + '</span><b>' + n + '</b></li>' : '';
    }
    return '<div class="xv-prog" aria-hidden="true">' +
      seg(c.success, 'green') + seg(c.skipped, 'orange') + seg(c.error, 'red') + seg(c.running, 'amber') + seg(c.pending, 'muted') + '</div>' +
      '<ul class="xv-legend">' +
        legend(c.success, 'green', t('xv.stat.success')) + legend(c.skipped, 'orange', t('xv.stat.skipped')) +
        legend(c.error, 'red', t('xv.stat.failed')) + legend(c.running, 'amber', t('xv.st.running')) +
        legend(c.pending, 'muted', t('xv.st.notRun')) +
      '</ul>';
  }

  // ---- Variables tab -------------------------------------------------------
  function variablesHtml(run) {
    var g = variableGroups(run);
    var q = varQuery.trim().toLowerCase();
    function match(r) {
      return !q || r.name.toLowerCase().indexOf(q) !== -1 ||
        String(r.value == null ? '' : r.value).toLowerCase().indexOf(q) !== -1;
    }
    var wf = g.workflow.filter(match), sys = g.system.filter(match);
    var total = g.workflow.length + g.system.length;
    var setN = g.workflow.filter(function (r) { return r.set; }).length + g.system.length;
    var head = '<div class="xv-toolbar">' +
      '<label class="xv-search is-inline">' + IC('search', 13) +
        '<input type="search" data-xv-varq value="' + esc(varQuery) + '" placeholder="' + esc(t('xv.var.search')) + '" aria-label="' + esc(t('xv.var.search')) + '" /></label>' +
      '<span class="xv-toolbar-note">' + esc(fill(t('xv.var.count'), { set: setN, n: total })) + '</span>' +
      '<span class="xv-spacer"></span>' +
      (run.variables ? '<button type="button" class="xv-btn is-sm" data-xv-copy-text="' + esc(JSON.stringify(run.variables, null, 2)) + '">' +
        IC('copy', 12) + '<span>' + esc(t('xv.var.copyAll')) + '</span></button>' : '') +
    '</div>';
    if (!total) {
      return head + '<div class="xv-panel-empty is-tall">' + IC('variable', 20) + '<b>' + esc(t('xv.var.emptyTitle')) + '</b><span>' + esc(t('xv.var.empty')) + '</span></div>';
    }
    var note = !run.variables && run.status !== 'running'
      ? '<div class="xv-note">' + IC('info', 13) + '<span>' + esc(t('xv.var.notRecorded')) + '</span></div>' : '';
    var body = varSection(t('xv.var.workflow'), t('xv.var.workflowHint'), 'variable', wf) +
      varSection(t('xv.var.system'), t('xv.var.systemHint'), 'settings', sys);
    if (!wf.length && !sys.length) body = '<div class="xv-panel-empty">' + IC('search', 16) + '<span>' + esc(t('xv.empty.noMatch')) + '</span></div>';
    return head + note + body;
  }
  function varSection(title, hint, icon, rows) {
    if (!rows.length) return '';
    return '<section class="xv-card xv-var-card">' +
      '<header class="xv-card-head"><span class="xv-card-ic">' + IC(icon, 14) + '</span><h3>' + esc(title) + '</h3>' +
        '<b class="xv-count">' + rows.length + '</b><span class="xv-card-sub">' + esc(hint) + '</span></header>' +
      '<div class="xv-tablewrap"><table class="xv-table">' +
        '<thead><tr><th scope="col">' + esc(t('xv.var.name')) + '</th><th scope="col">' + esc(t('xv.var.type')) + '</th>' +
        '<th scope="col">' + esc(t('xv.var.value')) + '</th><th scope="col">' + esc(t('xv.var.source')) + '</th>' +
        '<th scope="col"><span class="sr-only">' + esc(t('xv.copy')) + '</span></th></tr></thead>' +
        '<tbody>' + rows.map(function (r) {
          var type = r.set ? valueType(r.value) : 'unset';
          var shown = r.set ? String(r.value) : t('xv.var.notSet');
          return '<tr class="' + (r.set ? '' : 'is-unset') + '">' +
            '<td class="mono xv-var-name">' + esc(r.name) + '</td>' +
            '<td><span class="xv-type type-' + type + '">' + esc(t('xv.type.' + type)) + '</span></td>' +
            '<td class="xv-var-val"><code title="' + esc(shown) + '">' + esc(shown) + '</code></td>' +
            '<td class="xv-var-src">' + esc(r.source || '—') + '</td>' +
            '<td class="xv-var-act">' + (r.set && type !== 'secret'
              ? '<button type="button" class="xv-icobtn is-xs" data-xv-copy-text="' + esc(String(r.value)) + '" aria-label="' + esc(t('xv.copy')) + '">' + IC('copy', 12) + '</button>' : '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div></section>';
  }

  // ---- Logs tab ------------------------------------------------------------
  var LEVELS = ['all', 'info', 'success', 'warn', 'error'];
  function logsHtml(run) {
    var counts = { all: run.logs.length, info: 0, success: 0, warn: 0, error: 0 };
    var srcCounts = {};
    run.logs.forEach(function (l) {
      counts[l.level] = (counts[l.level] || 0) + 1;
      srcCounts[l.source] = (srcCounts[l.source] || 0) + 1;
    });
    var q = logQuery.trim().toLowerCase();
    var lines = run.logs.filter(function (l) {
      if (logLevelFilter !== 'all' && l.level !== logLevelFilter) return false;
      if (logSourceOff[l.source]) return false;
      return !q || String(l.text).toLowerCase().indexOf(q) !== -1;
    });
    var toolbar = '<div class="xv-toolbar is-logs">' +
      '<div class="xv-seg" role="radiogroup" aria-label="' + esc(t('xv.lv.label')) + '">' + LEVELS.map(function (lv) {
        var on = logLevelFilter === lv;
        return '<button type="button" role="radio" aria-checked="' + on + '" class="xv-seg-btn lv-' + lv + (on ? ' is-on' : '') + '" data-xv-level="' + lv + '">' +
          (lv !== 'all' ? '<span class="xv-dot" aria-hidden="true"></span>' : '') + '<span>' + esc(t('xv.lv.' + lv)) + '</span><b>' + (counts[lv] || 0) + '</b></button>';
      }).join('') + '</div>' +
      '<label class="xv-search is-inline">' + IC('search', 13) +
        '<input type="search" data-xv-logq value="' + esc(logQuery) + '" placeholder="' + esc(t('xv.log.search')) + '" aria-label="' + esc(t('xv.log.search')) + '" /></label>' +
      '<span class="xv-spacer"></span>' +
      '<button type="button" class="xv-icobtn' + (logWrap ? ' is-on' : '') + '" data-xv-wrap aria-pressed="' + logWrap + '" title="' + esc(t('xv.log.wrap')) + '" aria-label="' + esc(t('xv.log.wrap')) + '">' + IC('corner-down-left', 13) + '</button>' +
      '<button type="button" class="xv-icobtn" data-xv-copylogs title="' + esc(t('xv.log.copy')) + '" aria-label="' + esc(t('xv.log.copy')) + '">' + IC('copy', 13) + '</button>' +
      '<button type="button" class="xv-icobtn" data-xv-dllogs title="' + esc(t('xv.log.download')) + '" aria-label="' + esc(t('xv.log.download')) + '">' + IC('download', 13) + '</button>' +
    '</div>';
    var srcs = SOURCES.filter(function (s) { return srcCounts[s]; });
    var srcBar = srcs.length ? '<div class="xv-srcs" role="group" aria-label="' + esc(t('xv.src.label')) + '">' +
      '<span class="xv-srcs-label">' + esc(t('xv.src.label')) + '</span>' +
      srcs.map(function (s) {
        var on = !logSourceOff[s];
        return '<button type="button" class="xv-src src-' + s + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" data-xv-src="' + s + '">' +
          '<span>' + esc(t('xv.src.' + s)) + '</span><b>' + srcCounts[s] + '</b></button>';
      }).join('') + '</div>' : '';
    if (!run.logs.length) {
      return toolbar + '<div class="xv-panel-empty is-tall">' + IC('terminal', 20) + '<b>' + esc(t('xv.log.emptyTitle')) + '</b><span>' +
        esc(t(run.detailLoaded ? 'xv.log.empty' : 'xv.loading')) + '</span></div>';
    }
    var t0 = null;
    run.logs.forEach(function (l) { if (l.t != null && (t0 == null || l.t < t0)) t0 = l.t; });
    var body = lines.length ? lines.map(function (l) {
      var rel = (l.t != null && t0 != null) ? '+' + fmtDuration(l.t - t0) : '';
      return '<div class="xv-log lv-' + l.level + '">' +
        '<span class="xv-log-time mono" title="' + esc(fmtDateSec(l.t)) + '">' + esc(fmtClock(l.t)) + '</span>' +
        '<span class="xv-log-rel mono">' + esc(rel) + '</span>' +
        '<span class="xv-log-lv">' + esc(t('xv.lv.' + l.level)) + '</span>' +
        '<span class="xv-log-src src-' + l.source + '">' + esc(t('xv.src.' + l.source)) + '</span>' +
        '<span class="xv-log-msg">' + esc(l.text) + '</span>' +
      '</div>';
    }).join('') : '<div class="xv-panel-empty">' + IC('filter', 16) + '<span>' + esc(t('xv.log.noMatch')) + '</span></div>';
    return toolbar + srcBar +
      '<div class="xv-card xv-logs"><div class="xv-logs-body' + (logWrap ? ' is-wrap' : '') + '" role="log">' + body + '</div>' +
      '<footer class="xv-logs-foot"><span>' + esc(fill(t('xv.log.showing'), { n: lines.length, total: run.logs.length })) + '</span>' +
      (run.live && run.status === 'running' ? '<span class="xv-live">' + esc(t('xv.log.live')) + '</span>' : '') + '</footer></div>';
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function toast(msg, kind) { if (U() && U().toast) U().toast(msg, kind || 'ok'); }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = String(text); ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function copy(text) {
    var done = function () { toast(t('xv.copied'), 'ok'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text)).then(done, function () { if (legacyCopy(text)) done(); });
        return;
      }
    } catch (e) { /* fall through */ }
    if (legacyCopy(text)) done();
  }
  function download(name, text, type) {
    try {
      var blob = new Blob([text], { type: type || 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { toast(t('xv.downloadFailed'), 'error'); }
  }
  function exportRun(run) {
    return {
      execution: run.jobId, workflowId: ctx.workflowId(), workflow: ctx.workflowName(),
      status: run.status, trigger: run.trigger, startedAt: run.startedAt, finishedAt: run.finishedAt,
      durationMs: run.durationMs, error: run.error, meta: run.meta,
      steps: run.steps.map(function (s) {
        return { step: s.n, action: s.action, name: s.title, status: s.status, durationMs: s.durationMs,
          inputItemCount: s.inCount, outputItemCount: s.outCount, error: s.error, outputSample: s.sample };
      }),
      variables: run.variables,
      logs: run.logs.map(function (l) {
        return { t: l.t ? new Date(l.t).toISOString() : null, level: l.level, source: l.source, text: l.text };
      }),
    };
  }
  function logsText(run) {
    return run.logs.map(function (l) {
      return (l.t ? new Date(l.t).toISOString() : '-') + ' ' + l.level.toUpperCase() + ' [' + l.source + '] ' + l.text;
    }).join('\n') + '\n';
  }
  function openStep(n) { if (ctx && ctx.openStep) ctx.openStep(n - 1); }

  var CLICK_SEL = '[data-xv-run],[data-xv-filter],[data-xv-tab],[data-xv-step],[data-xv-copy],[data-xv-copy-text],' +
    '[data-xv-auto],[data-xv-download],[data-xv-menu],[data-xv-act],[data-xv-open-step],[data-xv-level],[data-xv-src],' +
    '[data-xv-wrap],[data-xv-copylogs],[data-xv-dllogs],[data-xv-expand-all],[data-xv-refresh]';

  function onClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest(CLICK_SEL) : null;
    if (!el || !host.contains(el)) return;
    var run = runModel(sel);
    if (el.hasAttribute('data-xv-run')) {
      sel = el.getAttribute('data-xv-run'); menuOpen = false;
      loadDetail(sel); render(); return;
    }
    if (el.hasAttribute('data-xv-refresh')) { details = {}; refresh(); return; }
    if (el.hasAttribute('data-xv-filter')) { filter = el.getAttribute('data-xv-filter'); paintList(); return; }
    if (el.hasAttribute('data-xv-tab')) { tab = el.getAttribute('data-xv-tab'); setPref('xvTab', tab); paintDetail(); return; }
    if (el.hasAttribute('data-xv-copy')) { copy(el.getAttribute('data-xv-copy')); return; }
    if (el.hasAttribute('data-xv-copy-text')) { copy(el.getAttribute('data-xv-copy-text')); return; }
    if (el.hasAttribute('data-xv-menu')) { menuOpen = !menuOpen; paintHero(); return; }
    if (el.hasAttribute('data-xv-open-step')) { ev.stopPropagation(); openStep(Number(el.getAttribute('data-xv-open-step'))); return; }
    if (!run) return;
    if (el.hasAttribute('data-xv-step')) {
      var n = el.getAttribute('data-xv-step');
      var k = run.jobId + ':' + n;
      if (openSteps[k]) delete openSteps[k]; else openSteps[k] = true;
      paintDetail();
      var again = host.querySelector('[data-xv-step="' + n + '"]');
      if (again) again.focus();
      return;
    }
    if (el.hasAttribute('data-xv-expand-all')) {
      var open = !allOpen(run);
      run.steps.forEach(function (s) {
        if (s.notRun) return;
        var kk = run.jobId + ':' + s.n;
        if (open) openSteps[kk] = true; else delete openSteps[kk];
      });
      paintDetail(); return;
    }
    if (el.hasAttribute('data-xv-auto')) { autoScroll = !autoScroll; setPref('xvAutoScroll', autoScroll); paintHero(); return; }
    if (el.hasAttribute('data-xv-download')) {
      download('execution-' + run.jobId + '.json', JSON.stringify(exportRun(run), null, 2)); return;
    }
    if (el.hasAttribute('data-xv-act')) {
      var act = el.getAttribute('data-xv-act');
      menuOpen = false; paintHero();
      if (act === 'copy-id') copy(run.jobId);
      else if (act === 'copy-json') copy(JSON.stringify(exportRun(run), null, 2));
      else if (act === 'dl-logs') download('execution-' + run.jobId + '.log', logsText(run), 'text/plain');
      else if (act === 'open-editor' && ctx.openEditor) ctx.openEditor();
      else if (act === 'open-failed') { var f = firstFail(run); if (f) openStep(f.n); }
      else if (act === 'cancel' && api().cancelJob) {
        api().cancelJob(ctx.userId(), run.jobId)
          .then(function () { toast(t('xv.cancelled'), 'ok'); refresh(); })
          .catch(function (e) { toast((e && e.message) || String(e), 'error'); });
      }
      return;
    }
    if (el.hasAttribute('data-xv-level')) { logLevelFilter = el.getAttribute('data-xv-level'); paintDetail(); return; }
    if (el.hasAttribute('data-xv-src')) {
      var s = el.getAttribute('data-xv-src');
      if (logSourceOff[s]) delete logSourceOff[s]; else logSourceOff[s] = true;
      paintDetail(); return;
    }
    if (el.hasAttribute('data-xv-wrap')) { logWrap = !logWrap; setPref('xvLogWrap', logWrap); paintDetail(); return; }
    if (el.hasAttribute('data-xv-copylogs')) { copy(logsText(run)); return; }
    if (el.hasAttribute('data-xv-dllogs')) download('execution-' + run.jobId + '.log', logsText(run), 'text/plain');
  }
  function onKey(ev) {
    var el = ev.target;
    if (!el || !el.hasAttribute) return;
    if ((ev.key === 'Enter' || ev.key === ' ') && el.hasAttribute('data-xv-step')) { ev.preventDefault(); el.click(); return; }
    if (ev.key === 'Escape' && menuOpen) { menuOpen = false; paintHero(); return; }
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && el.hasAttribute('data-xv-run')) {
      ev.preventDefault();
      var btns = Array.prototype.slice.call(host.querySelectorAll('[data-xv-run]'));
      var next = btns[btns.indexOf(el) + (ev.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      var id = next.getAttribute('data-xv-run');
      next.click();
      var nb = host.querySelector('[data-xv-run="' + id + '"]');
      if (nb) nb.focus();
    }
  }
  function onInput(ev) {
    var el = ev.target;
    if (!el || !el.hasAttribute) return;
    if (el.hasAttribute('data-xv-search')) { query = el.value; paintList(); return; }
    var refocus;
    if (el.hasAttribute('data-xv-varq')) { varQuery = el.value; refocus = '[data-xv-varq]'; }
    else if (el.hasAttribute('data-xv-logq')) { logQuery = el.value; refocus = '[data-xv-logq]'; }
    else return;
    var pos = el.selectionStart;
    paintDetail();
    var again = host.querySelector(refocus);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* not supported */ } }
  }
  function onDocClick(ev) {
    if (!menuOpen || !host) return;
    var wrap = host.querySelector('.xv-menuwrap');
    if (wrap && !wrap.contains(ev.target)) { menuOpen = false; paintHero(); }
  }

  // ---------------------------------------------------------------------------
  // Mount
  // ---------------------------------------------------------------------------
  function mount(el, context) {
    unmount();
    host = el;
    ctx = context || {};
    autoScroll = pref('xvAutoScroll', true) !== false;
    logWrap = pref('xvLogWrap', true) !== false;
    var savedTab = pref('xvTab', 'execution');
    tab = { execution: 1, variables: 1, logs: 1 }[savedTab] ? savedTab : 'execution';
    host.innerHTML =
      '<div class="xv">' +
        '<aside class="xv-side" aria-label="' + esc(t('xv.title')) + '">' +
          '<header class="xv-side-head">' +
            '<span class="xv-side-ic" aria-hidden="true">' + IC('play', 13) + '</span>' +
            '<span class="xv-side-titles"><h2>' + esc(t('xv.title')) + '</h2><span>' + esc(t('xv.subtitle')) + '</span></span>' +
            '<span class="xv-side-total" id="xv-total"></span>' +
            '<button type="button" class="xv-icobtn" data-xv-refresh title="' + esc(t('xv.refresh')) + '" aria-label="' + esc(t('xv.refresh')) + '">' + IC('rotate-cw', 14) + '</button>' +
          '</header>' +
          '<div class="xv-filters" id="xv-filters" role="radiogroup" aria-label="' + esc(t('xv.filterLabel')) + '"></div>' +
          '<label class="xv-search">' + IC('search', 13) +
            '<input type="search" data-xv-search value="' + esc(query) + '" placeholder="' + esc(t('xv.search')) + '" aria-label="' + esc(t('xv.search')) + '" /></label>' +
          '<ol class="xv-runs" id="xv-list"></ol>' +
        '</aside>' +
        '<section class="xv-detail" id="xv-detail"></section>' +
      '</div>';
    // Only runs that START after mounting are auto-selected.
    var s0 = liveSnap();
    lastLiveId = s0 ? s0.jobId : null;
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('input', onInput);
    document.addEventListener('click', onDocClick, true);
    render();
    return refresh();
  }
  function unmount() {
    if (pollTimer) clearTimeout(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = tickTimer = null;
    document.removeEventListener('click', onDocClick, true);
    if (host) {
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKey);
      host.removeEventListener('input', onInput);
      host.innerHTML = '';
    }
    host = null;
  }
  /** A live event landed: select a newly started run and re-render. */
  function onRunUpdate() {
    if (!host) return;
    var snap = liveSnap();
    // A run started in this session (new job id) is selected as soon as it
    // appears — its first snapshot may still read `idle` (before job.start).
    if (snap && snap.jobId !== lastLiveId) {
      lastLiveId = snap.jobId;
      if (snap.phase === 'running' || snap.phase === 'idle') {
        sel = String(snap.jobId);
        if (!jobRow(sel)) runs.unshift({ jobId: snap.jobId, state: 'active', trigger: 'manual', startedAt: new Date().toISOString() });
        schedulePoll();
      }
    }
    if (snap && snap.phase !== 'running' && details[snap.jobId] && details[snap.jobId].state === 'active') delete details[snap.jobId];
    render();
  }

  window.ExecutionsView = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    onRunUpdate: onRunUpdate,
    // pure helpers, exposed for unit tests
    normalizeStored: normalizeStored,
    normalizeLive: normalizeLive,
    logSource: logSource,
    logLevel: logLevel,
    fmtDuration: fmtDuration,
    valueType: valueType,
    stepCounts: stepCounts,
  };
})();
