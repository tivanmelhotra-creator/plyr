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

  var RS = window.RunState;
  var dom = null;       // { drawer, body, timeline, statusBadge, title, toggleBtn }
  var client = null;    // active LiveClient
  var state = null;     // RunState object
  var currentWfId = null;
  var pins = {};        // { nodeIndex0: { output, input } }  pinned node outputs
  var LAST_RUN_KEY = 'ab_last_run';   // localStorage prefix

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
    return st === 'success' ? '✓' : st === 'error' ? '✕' : st === 'running' ? '◴' : '·';
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
          esc(t('rp.pin')) + '">📌</button>';
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
    if (dom.title) {
      var dur = (state && state.durationMs != null) ? (' · ' + state.durationMs + 'ms') : '';
      dom.title.textContent = t('rp.title') + ' — ' +
        c.success + '✓ ' + c.error + '✕ / ' + c.total + dur;
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

  function renderAll() {
    renderHeader();
    renderTimeline();
    paintNodes();
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
  function open() { if (dom && dom.drawer) { dom.drawer.classList.add('open'); if (dom.toggleBtn) dom.toggleBtn.textContent = '▾'; } }
  function close() { if (dom && dom.drawer) { dom.drawer.classList.remove('open'); if (dom.toggleBtn) dom.toggleBtn.textContent = '▸'; } }
  function toggle() { if (dom && dom.drawer) { dom.drawer.classList.contains('open') ? close() : open(); } }

  function mount() {
    if (dom) return;            // already mounted (singleton drawer)
    var drawer = document.createElement('div');
    drawer.className = 'run-panel';
    drawer.id = 'run-panel';
    drawer.innerHTML =
      '<div class="rp-head" id="rp-head">' +
        '<button class="btn btn-ghost btn-sm rp-toggle" id="rp-toggle" title="' + esc(t('rp.toggle')) + '">▸</button>' +
        '<span class="rp-title" id="rp-title">' + esc(t('rp.title')) + '</span>' +
        '<span class="rp-badges">' +
          '<span class="badge" id="rp-status">' + esc(t('rp.idle')) + '</span>' +
          '<span class="badge" id="rp-conn">—</span>' +
        '</span>' +
        '<button class="btn btn-ghost btn-sm rp-clear" id="rp-clear">' + esc(t('rp.clear')) + '</button>' +
      '</div>' +
      '<div class="rp-body" id="rp-body">' +
        '<div class="rp-timeline" id="rp-timeline"></div>' +
      '</div>';
    document.body.appendChild(drawer);

    dom = {
      drawer: drawer,
      body: drawer.querySelector('#rp-body'),
      timeline: drawer.querySelector('#rp-timeline'),
      title: drawer.querySelector('#rp-title'),
      statusBadge: drawer.querySelector('#rp-status'),
      connBadge: drawer.querySelector('#rp-conn'),
      toggleBtn: drawer.querySelector('#rp-toggle'),
    };
    drawer.querySelector('#rp-toggle').addEventListener('click', toggle);
    drawer.querySelector('#rp-head').addEventListener('click', function (ev) {
      // clicking the head (but not a button) toggles too
      if (ev.target && ev.target.id === 'rp-head') toggle();
    });
    drawer.querySelector('#rp-clear').addEventListener('click', function () {
      stop();
      state = RS.create();
      var fe = FE();
      if (fe && fe.clearStatuses) fe.clearStatuses();
      if (fe && fe.clearResults) fe.clearResults();
      renderAll();
    });
    renderAll();
  }

  function unmount() {
    stop();
    if (dom && dom.drawer && dom.drawer.parentNode) dom.drawer.parentNode.removeChild(dom.drawer);
    dom = null;
  }

  window.RunPanel = {
    mount: mount,
    unmount: unmount,
    open: open,
    close: close,
    toggle: toggle,
    startJob: startJob,
    stop: stop,
    loadLastRun: loadLastRun,
    pin: pin,
    unpin: unpin,
    getPins: getPins,
  };
})();
