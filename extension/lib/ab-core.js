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
  // the server-side base-URL normalization.
  function normalizeBase(url) {
    var u = String(url == null ? '' : url).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
  }

  // Build the URL to run a SAVED, versioned workflow (Model B contract, shared
  // across API clients): POST /workflows/:userId/:workflowId/run  (+?wait).
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

  // ══════════════════════════════════════════════════════════════════════
  // Remote -> Local handoff (Step: one automation session, two browsers)
  // ══════════════════════════════════════════════════════════════════════

  // Build the handoff URLs. Same normalizeBase treatment as everything else so
  // a user who typed "localhost:3000" in the popup is not a special case.
  function buildPairUrl(baseUrl) {
    return normalizeBase(baseUrl) + '/browser-mode/handoff/pair';
  }
  function buildPullUrl(baseUrl, opts) {
    var u = normalizeBase(baseUrl) + '/browser-mode/handoff/pull';
    if (opts && opts.drain) u += '?drain=1';
    return u;
  }
  function buildCompleteUrl(baseUrl) {
    return normalizeBase(baseUrl) + '/browser-mode/handoff/complete';
  }

  // Accept a pairing code the way a human will actually type it: lower case,
  // with the display dash, with a stray space. MIRRORS the server's
  // normalizePairingCode -- if these two ever disagree, a user reading a code
  // off the screen gets "not recognised" for a code that is perfectly correct,
  // which is indistinguishable from a broken feature.
  function normalizePairingCode(input) {
    return String(input == null ? '' : input)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 16);
  }

  // Is this a plausible code, before we spend a request on it?
  // 8 chars from the server's unambiguous alphabet (no 0/O/1/I/L).
  function looksLikePairingCode(input) {
    var c = normalizePairingCode(input);
    return c.length === 8 && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(c);
  }

  // Schemes this extension is willing to open in the user's own browser.
  // Kept deliberately in step with the server's BrowserTabs.ALLOWED so that a
  // snapshot the server considered safe to save is the same set this considers
  // safe to restore -- and so a change on one side is visible as a change here.
  var RESTORABLE_URL = /^(https?:\/\/|chrome-extension:\/\/)/i;

  // Turn a snapshot into an ORDERED plan of tabs to open.
  //
  // THIS IS THE FUNCTION THAT KEEPS THE PROMISE. The requirement was that the
  // moved browser show the same URLs in the same ORDER with the same tab in
  // front. Three things make that true and each is a bug that would otherwise
  // happen:
  //
  //   - order is preserved exactly as received; the server already sent the tab
  //     strip in its real order, so the only job here is not to disturb it.
  //     (Sorting, de-duping into a Set, or opening in parallel and letting
  //     whichever resolves first land where it likes would all silently break
  //     it -- Chrome assigns tab positions in creation order.)
  //   - exactly one tab is marked active, so `focusIndex` is always a real
  //     index. A snapshot with no active flag would otherwise focus nothing and
  //     leave the user staring at whichever tab Chrome happened to pick.
  //   - `active:false` is set on EVERY tab at creation time. Chrome focuses a
  //     newly created tab by default, so creating N tabs normally means the
  //     LAST one wins -- the user's active tab would be whatever happened to be
  //     at the end of the list. We create them all unfocused and then focus the
  //     right one once.
  function planTabRestore(snapshot) {
    var tabs = (snapshot && Array.isArray(snapshot.tabs)) ? snapshot.tabs : [];
    var plan = [];
    var focusIndex = -1;
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i] || {};
      var url = String(t.url == null ? '' : t.url).trim();
      if (!url) continue;
      // Re-check the scheme even though the server already sanitised it.
      //
      // This is not redundant defence, it is defence at the point where the
      // consequence lands: the server's copy protects a container it owns, this
      // copy protects the USER'S OWN machine, where `file://` reads their real
      // disk and `javascript:` runs in whatever tab it opens. The plan is built
      // from a network response, so trusting the sender to have filtered it
      // means one server bug becomes local file disclosure. Filtering here
      // costs a regex and removes that entire class of outcome.
      if (!RESTORABLE_URL.test(url)) continue;
      if (t.active && focusIndex < 0) focusIndex = plan.length;
      plan.push({ url: url, title: strOrEmpty(t.title), active: false });
    }
    // No active flag survived: the first tab is the honest default -- it is
    // what the server's own sanitizeTabs would have chosen.
    if (plan.length && focusIndex < 0) focusIndex = 0;
    return { tabs: plan, focusIndex: focusIndex, count: plan.length };
  }

  // Describe what did NOT come across, in one sentence the popup can show.
  //
  // Exists so the extension repeats the SERVER's honesty instead of inventing
  // its own reassurance. An empty string means "everything moved", and the
  // caller shows nothing at all rather than a needless warning.
  function describeHandoffLimits(limits) {
    if (!limits || !Array.isArray(limits.notes) || !limits.notes.length) return '';
    var parts = [];
    for (var i = 0; i < limits.notes.length; i++) {
      var n = limits.notes[i];
      if (n === 'tabs_capped') {
        parts.push(limits.tabsDropped + ' tab(s) could not be moved (limit reached)');
      } else if (n === 'storage_unavailable') {
        parts.push('you may need to sign in again on some sites');
      } else if (n === 'no_tabs') {
        parts.push('there were no open tabs to move');
      }
    }
    return parts.join('; ');
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
    extractJobId: extractJobId,
    buildPairUrl: buildPairUrl,
    buildPullUrl: buildPullUrl,
    buildCompleteUrl: buildCompleteUrl,
    normalizePairingCode: normalizePairingCode,
    looksLikePairingCode: looksLikePairingCode,
    planTabRestore: planTabRestore,
    describeHandoffLimits: describeHandoffLimits
  };
});
