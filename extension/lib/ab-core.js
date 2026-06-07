/* ============================================================
   ab-core.js — shared, pure helpers for the extension (Step 31).

   This is the "Model A" glue between the extension and the backend.
   It contains NO DOM / chrome API access — only pure functions — so the
   popup, the background service worker, and the unit tests can all reuse
   the exact same logic (one source of truth, mirroring the dashboard panel's
   client contract).

   Dual-export: attaches window.ABCore in the browser AND module.exports in
   Node/vitest (loaded via `vm` with a fake `window`, like selector.js).
   ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ABCore = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Strip a trailing slash and add a scheme if missing, so callers can paste
  // "localhost:3000" and we still build a valid URL. Mirrors background.js /
  // the n8n node's normalizeBase().
  function normalizeBase(url) {
    var u = String(url == null ? '' : url).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
  }

  // Build the URL to run a SAVED, versioned workflow (Model B contract, shared
  // with the n8n node): POST /workflows/:userId/:workflowId/run  (+?wait).
  function buildRunSavedUrl(baseUrl, userId, workflowId, opts) {
    var base = normalizeBase(baseUrl);
    var u = base + '/workflows/' + encodeURIComponent(String(userId)) +
      '/' + encodeURIComponent(String(workflowId)) + '/run';
    if (opts && opts.wait) u += '?wait=true';
    return u;
  }

  // Build the inline-run URL: POST /run (+?wait). Used when sending recorded
  // steps directly.
  function buildRunInlineUrl(baseUrl, opts) {
    var base = normalizeBase(baseUrl);
    return base + '/run' + (opts && opts.wait ? '?wait=true' : '');
  }

  // Build the SSE live-stream URL for a job. The backend accepts the API key
  // either as the x-api-key header or as an ?api_key query param; EventSource
  // cannot set headers, so we pass it on the query string.
  function buildSseUrl(baseUrl, userId, jobId, apiKey) {
    var base = normalizeBase(baseUrl);
    var u = base + '/live/sse/' + encodeURIComponent(String(userId)) +
      '/' + encodeURIComponent(String(jobId));
    if (apiKey) u += '?api_key=' + encodeURIComponent(String(apiKey));
    return u;
  }

  // Build the dashboard panel URL (so "Open Panel" deep-links to the SAME UI
  // the extension is a thin client of — not a parallel copy).
  function buildPanelUrl(baseUrl) {
    return normalizeBase(baseUrl) + '/';
  }

  // Normalise the GET /workflows/:userId response into a flat, render-ready
  // list of { id, name, version, description, stepCount }. Tolerant of either
  // { workflows: [...] } or a bare array, and of missing fields.
  function parseWorkflowList(response) {
    var raw = null;
    if (Array.isArray(response)) raw = response;
    else if (response && Array.isArray(response.workflows)) raw = response.workflows;
    else raw = [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var wf = raw[i];
      if (!wf || typeof wf.id !== 'string') continue;
      out.push({
        id: wf.id,
        name: (wf.name && String(wf.name)) || wf.id,
        version: (typeof wf.version === 'number') ? wf.version : null,
        description: (wf.description && String(wf.description)) || '',
        stepCount: Array.isArray(wf.steps) ? wf.steps.length : null
      });
    }
    return out;
  }

  // The userId the backend bound this API key to. In single-user mode GET /me
  // returns { userId: "local", ... }; in multi mode it is the key's owner. We
  // prefer this over a user-typed value so the extension and the panel agree.
  function resolveUserId(meResponse, fallback) {
    if (meResponse && typeof meResponse.userId === 'string' && meResponse.userId) {
      return meResponse.userId;
    }
    var fb = String(fallback == null ? '' : fallback).trim();
    return fb || 'local';
  }

  // Map a single live event (same shape as public/js/run-state.js) to a tiny
  // per-step status delta the popup can paint as a tick/error on a row. This is
  // the extension-side mirror of the dashboard's Step-26 node states.
  //   returns one of:
  //     { kind:'job', state:'running'|'done'|'error', message? }
  //     { kind:'step', index, action, state:'running'|'success'|'error'|'retry',
  //       durationMs?, outputItemCount?, error?, attempt?, maxTries? }
  //     null  (event we don't visualise, e.g. plain logs)
  function mapLiveEventToStatus(ev) {
    if (!ev || !ev.type) return null;
    var t = ev.type;
    var d = ev.data || ev; // events may be flat or wrapped in {type,data}
    switch (t) {
      case 'job.start':
        return { kind: 'job', state: 'running' };
      case 'job.done':
        return { kind: 'job', state: 'done', durationMs: numOrNull(d.durationMs) };
      case 'job.error':
        return { kind: 'job', state: 'error', message: strOrEmpty(d.message || d.reason || d.error) };
      case 'step.start':
        return { kind: 'step', index: numOrNull(d.index), action: strOrEmpty(d.action), state: 'running' };
      case 'step.done':
        return {
          kind: 'step', index: numOrNull(d.index), action: strOrEmpty(d.action),
          state: (d.success === false) ? 'error' : 'success',
          durationMs: numOrNull(d.durationMs),
          outputItemCount: numOrNull(d.outputItemCount),
          error: d.success === false ? strOrEmpty(d.error) : ''
        };
      case 'step.error':
        return {
          kind: 'step', index: numOrNull(d.index), action: strOrEmpty(d.action),
          state: 'error', error: strOrEmpty(d.error || d.message)
        };
      case 'step.retry':
        return {
          kind: 'step', index: numOrNull(d.index), action: strOrEmpty(d.action),
          state: 'retry', attempt: numOrNull(d.attempt), maxTries: numOrNull(d.maxTries)
        };
      default:
        return null; // 'log' and unknown types are not painted on rows
    }
  }

  // True for live events that mean the job has reached a terminal state, so the
  // popup can close the SSE stream.
  function isTerminalEvent(ev) {
    return !!(ev && (ev.type === 'job.done' || ev.type === 'job.error'));
  }

  // Human-readable one-line label for a recorded/automation step. Shared with
  // the popup step list (keeps labels consistent with the dashboard).
  function stepLabel(s) {
    if (!s || !s.action) return '';
    var p = s.params || {};
    switch (s.action) {
      case 'goto': return 'goto ' + (p.url || '');
      case 'click': return 'click ' + (p.selector || '');
      case 'fill': return 'fill ' + (p.selector || '') + ' = ' + (p.text || '');
      case 'press': return 'press ' + (p.text || p.key || '');
      case 'extract': return 'extract ' + (p.selector || '') + ' -> ' + (p.name || 'value');
      default: return s.action + ' ' + safeJson(p);
    }
  }

  // Extract a jobId from a /run or /workflows/:id/run response (tolerant of the
  // several shapes the backend / job file uses).
  function extractJobId(data) {
    if (!data) return null;
    if (data.jobId != null) return String(data.jobId);
    if (data.id != null) return String(data.id);
    if (data.job && data.job.id != null) return String(data.job.id);
    return null;
  }

  // ---- tiny internal helpers ----
  function numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function strOrEmpty(v) { return (v == null) ? '' : String(v); }
  function safeJson(v) { try { return JSON.stringify(v); } catch (e) { return '[object]'; } }

  return {
    normalizeBase: normalizeBase,
    buildRunSavedUrl: buildRunSavedUrl,
    buildRunInlineUrl: buildRunInlineUrl,
    buildSseUrl: buildSseUrl,
    buildPanelUrl: buildPanelUrl,
    parseWorkflowList: parseWorkflowList,
    resolveUserId: resolveUserId,
    mapLiveEventToStatus: mapLiveEventToStatus,
    isTerminalEvent: isTerminalEvent,
    stepLabel: stepLabel,
    extractJobId: extractJobId
  };
});
