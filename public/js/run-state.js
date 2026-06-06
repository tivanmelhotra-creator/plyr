/*
 * run-state.js — DOM-free reducer for live execution state (Step 26).
 *
 * The backend streams live events over WS/SSE (see live.js / src/core/LiveBus.ts):
 *   job.start  { isVip, lock, ... }
 *   step.start { index, action }                       // index is 1-based
 *   step.done  { index, action, success, durationMs,
 *                inputItemCount, outputItemCount, outputSample, outputTruncated }
 *   step.error { index, action, error }                // (message on some paths)
 *   job.done   { durationMs }
 *   job.error  { message | reason }
 *
 * This module turns that event stream into an immutable-ish run-state object the
 * UI can render directly, and that maps each step to its graph node (via the
 * 0-based chain order — backend `index` is 1-based, so node = index - 1).
 *
 * Pure + DOM-free so it is unit-testable under node:vm with a `window` shim
 * (the Step 23/24/25 lesson). No DOM, no framework, CSP-safe.
 *
 * Exposes window.RunState = {
 *   create(), applyEvent(state, ev), reset(state),
 *   stepStatus(state, index1), stepAt(state, index1),
 *   nodeStatusMap(state), counts(state), isTerminal(state)
 * }
 * `state` shape:
 *   {
 *     phase: 'idle'|'running'|'done'|'error',
 *     jobId: string|null,
 *     startedAt: number|null, finishedAt: number|null, durationMs: number|null,
 *     error: string|null,
 *     steps: { [index1]: {
 *        index, action, status:'running'|'success'|'error',
 *        inputItemCount, outputItemCount, outputSample, outputTruncated,
 *        durationMs, error, startedAt, finishedAt
 *     } },
 *     order: [index1, ...],   // first-seen order of steps
 *     log: [{ t, type, index?, action?, text }]   // capped timeline
 *   }
 */
(function () {
  'use strict';

  var LOG_CAP = 500;

  function now() { return Date.now(); }

  function create() {
    return {
      phase: 'idle',
      jobId: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      steps: {},
      order: [],
      log: [],
    };
  }

  function reset(state) {
    var s = create();
    if (state && state.jobId) s.jobId = state.jobId;
    return s;
  }

  function pushLog(state, entry) {
    entry.t = entry.t || now();
    state.log.push(entry);
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  }

  function ensureStep(state, index1, action) {
    var key = String(index1);
    if (!state.steps[key]) {
      state.steps[key] = {
        index: index1,
        action: action || '',
        status: 'running',
        inputItemCount: null,
        outputItemCount: null,
        outputSample: null,
        outputTruncated: false,
        durationMs: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      };
      state.order.push(index1);
    } else if (action && !state.steps[key].action) {
      state.steps[key].action = action;
    }
    return state.steps[key];
  }

  // Apply a single live event, returning the SAME (mutated) state object for
  // chaining. Unknown event types are logged but otherwise ignored. The reducer
  // is defensive: out-of-order or duplicate events never throw.
  function applyEvent(state, ev) {
    if (!state) state = create();
    if (!ev || !ev.type) return state;
    var d = ev.data || {};
    var type = ev.type;

    switch (type) {
      case 'job.start': {
        // Preserve any steps already recorded if a late job.start arrives, but a
        // fresh job.start normally begins a clean run.
        state.phase = 'running';
        state.startedAt = now();
        state.finishedAt = null;
        state.durationMs = null;
        state.error = null;
        pushLog(state, { type: type, text: 'job started' });
        break;
      }
      case 'step.start': {
        var st = ensureStep(state, d.index, d.action);
        st.status = 'running';
        st.startedAt = now();
        if (state.phase === 'idle') state.phase = 'running';
        pushLog(state, { type: type, index: d.index, action: d.action, text: 'step started' });
        break;
      }
      case 'step.done': {
        var sd = ensureStep(state, d.index, d.action);
        sd.status = (d.success === false) ? 'error' : 'success';
        sd.inputItemCount = (d.inputItemCount != null) ? d.inputItemCount : sd.inputItemCount;
        sd.outputItemCount = (d.outputItemCount != null) ? d.outputItemCount : sd.outputItemCount;
        sd.outputSample = (d.outputSample != null) ? d.outputSample : sd.outputSample;
        sd.outputTruncated = !!d.outputTruncated;
        sd.durationMs = (d.durationMs != null) ? d.durationMs : sd.durationMs;
        sd.finishedAt = now();
        if (sd.status === 'error' && !sd.error) sd.error = d.error || d.message || 'failed';
        pushLog(state, { type: type, index: d.index, action: d.action, text: 'step done' });
        break;
      }
      case 'step.error': {
        var se = ensureStep(state, d.index, d.action);
        se.status = 'error';
        se.error = d.error || d.message || 'failed';
        se.finishedAt = now();
        pushLog(state, { type: type, index: d.index, action: d.action, text: se.error });
        break;
      }
      case 'job.done': {
        state.phase = 'done';
        state.finishedAt = now();
        state.durationMs = (d.durationMs != null) ? d.durationMs
          : (state.startedAt ? state.finishedAt - state.startedAt : null);
        pushLog(state, { type: type, text: 'job done' });
        break;
      }
      case 'job.error': {
        state.phase = 'error';
        state.finishedAt = now();
        state.error = d.message || d.reason || 'failed';
        state.durationMs = (d.durationMs != null) ? d.durationMs
          : (state.startedAt ? state.finishedAt - state.startedAt : null);
        pushLog(state, { type: type, text: state.error });
        break;
      }
      case 'log': {
        pushLog(state, { type: type, text: String(d.message != null ? d.message : '') });
        break;
      }
      default: {
        pushLog(state, { type: type, text: '' });
        break;
      }
    }
    return state;
  }

  // ---- selectors ------------------------------------------------------------
  function stepAt(state, index1) {
    return (state && state.steps[String(index1)]) || null;
  }
  function stepStatus(state, index1) {
    var s = stepAt(state, index1);
    return s ? s.status : 'idle';
  }

  // Map backend 1-based step index -> 0-based chain node index, returning a plain
  // object { nodeIndex0: status } the editor can paint via setNodeStatus(i, st).
  function nodeStatusMap(state) {
    var out = {};
    if (!state) return out;
    state.order.forEach(function (idx1) {
      var s = state.steps[String(idx1)];
      if (s) out[idx1 - 1] = s.status; // 0-based for chainNodeIds()
    });
    return out;
  }

  function counts(state) {
    var c = { total: 0, running: 0, success: 0, error: 0 };
    if (!state) return c;
    state.order.forEach(function (idx1) {
      var s = state.steps[String(idx1)];
      if (!s) return;
      c.total += 1;
      if (s.status === 'running') c.running += 1;
      else if (s.status === 'success') c.success += 1;
      else if (s.status === 'error') c.error += 1;
    });
    return c;
  }

  function isTerminal(state) {
    return !!state && (state.phase === 'done' || state.phase === 'error');
  }

  window.RunState = {
    create: create,
    reset: reset,
    applyEvent: applyEvent,
    stepAt: stepAt,
    stepStatus: stepStatus,
    nodeStatusMap: nodeStatusMap,
    counts: counts,
    isTerminal: isTerminal,
  };
})();
