/* ============================================================
   background.js — service worker (Step 13, extended in Step 31).
   - Performs the secure POST /run to the backend. Doing the fetch
     here (extension-privileged, with host_permissions) avoids the
     page-context CORS restrictions a content script would hit.
   - Step 31: makes the extension a thin client of the SAME backend the
     dashboard panel uses (Model A): it can list saved workflows
     (GET /workflows/:userId), run a saved workflow
     (POST /workflows/:userId/:workflowId/run), open the panel tab, and
     stream a job's live events over SSE — forwarding each event to the
     popup so it can paint per-node tick/error (mirroring Step 26).
   - Relays a few control messages from the popup to the active tab's
     content script (picker/recorder toggles).

   Settings (backend base URL, API key, userId) live in
   chrome.storage.local: ab_baseUrl, ab_apiKey, ab_userId.
   API key is never logged.

   Pure URL/parse/event logic is shared with the popup (and unit tests)
   via lib/ab-core.js — imported here as the global ABCore.
   ============================================================ */
'use strict';

// Service workers can pull in classic scripts synchronously. ab-core.js is a
// pure, DOM-free module that also runs in the popup and in vitest (one source
// of truth for URL building, list parsing and live-event mapping).
try { importScripts('lib/ab-core.js'); } catch (e) { /* ABCore optional fallback below */ }

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['ab_baseUrl', 'ab_apiKey', 'ab_userId'], function (s) {
      resolve({
        baseUrl: (s && s.ab_baseUrl) || '',
        apiKey: (s && s.ab_apiKey) || '',
        userId: (s && s.ab_userId) || 'local'
      });
    });
  });
}

// Prefer the shared ABCore.normalizeBase; keep a tiny local fallback so the
// worker still functions if importScripts ever fails.
function normalizeBase(url) {
  if (typeof ABCore !== 'undefined' && ABCore.normalizeBase) return ABCore.normalizeBase(url);
  var u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

// Small JSON fetch helper that always returns { ok, status, data, error? }.
async function apiFetch(url, opts, apiKey) {
  var headers = Object.assign(
    { 'Content-Type': 'application/json' },
    apiKey ? { 'x-api-key': apiKey } : {},
    (opts && opts.headers) || {}
  );
  try {
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    var text = await res.text();
    var data;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) return { ok: false, error: 'http_' + res.status, status: res.status, data: data };
    return { ok: true, status: res.status, data: data };
  } catch (e) {
    return { ok: false, error: 'network', message: String((e && e.message) || e) };
  }
}

// Send the recorded steps to the backend as an inline Flow (POST /run).
async function sendFlow(payload) {
  var cfg = await getSettings();
  var base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
  if (!cfg.apiKey) return { ok: false, error: 'no_api_key' };

  var steps = Array.isArray(payload && payload.steps) ? payload.steps : [];
  if (!steps.length) return { ok: false, error: 'no_steps' };

  var body = { userId: cfg.userId || 'local', steps: steps, headless: true };
  if (payload && payload.webhookUrl) body.webhookUrl = payload.webhookUrl;
  if (payload && typeof payload.headless === 'boolean') body.headless = payload.headless;

  var url = (typeof ABCore !== 'undefined' && ABCore.buildRunInlineUrl)
    ? ABCore.buildRunInlineUrl(base, { wait: !!(payload && payload.wait) })
    : base + '/run';
  return apiFetch(url, { method: 'POST', body: JSON.stringify(body) }, cfg.apiKey);
}

// Validate the API key / connectivity via GET /me. Returns data so the popup
// can resolve the canonical userId the key is bound to.
async function checkConnection() {
  var cfg = await getSettings();
  var base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
  if (!cfg.apiKey) return { ok: false, error: 'no_api_key' };
  return apiFetch(base + '/me', { method: 'GET' }, cfg.apiKey);
}

// Step 31: list the user's saved workflows — the SAME list the panel shows.
async function listWorkflows() {
  var cfg = await getSettings();
  var base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
  if (!cfg.apiKey) return { ok: false, error: 'no_api_key' };
  var userId = cfg.userId || 'local';
  var res = await apiFetch(base + '/workflows/' + encodeURIComponent(userId), { method: 'GET' }, cfg.apiKey);
  if (res.ok && typeof ABCore !== 'undefined' && ABCore.parseWorkflowList) {
    res.workflows = ABCore.parseWorkflowList(res.data);
  }
  return res;
}

// Step 31: run a saved, versioned workflow (Model B contract, shared with the
// n8n node) and return the jobId so the popup can subscribe to live events.
async function runSavedWorkflow(payload) {
  var cfg = await getSettings();
  var base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
  if (!cfg.apiKey) return { ok: false, error: 'no_api_key' };
  var workflowId = payload && payload.workflowId;
  if (!workflowId) return { ok: false, error: 'no_workflow_id' };

  var userId = cfg.userId || 'local';
  var url = (typeof ABCore !== 'undefined' && ABCore.buildRunSavedUrl)
    ? ABCore.buildRunSavedUrl(base, userId, workflowId, { wait: !!(payload && payload.wait) })
    : base + '/workflows/' + encodeURIComponent(userId) + '/' + encodeURIComponent(workflowId) + '/run';

  var body = {};
  if (payload && payload.triggerData) body.triggerData = payload.triggerData;
  if (payload && typeof payload.headless === 'boolean') body.headless = payload.headless;

  var res = await apiFetch(url, { method: 'POST', body: JSON.stringify(body) }, cfg.apiKey);
  if (res.ok && typeof ABCore !== 'undefined' && ABCore.extractJobId) {
    res.jobId = ABCore.extractJobId(res.data);
  }
  return res;
}

// ---- Live (SSE) streaming -------------------------------------------------
// We stream a job's events here in the worker (host-privileged) and forward
// each mapped status delta to the popup via runtime messages, so the popup can
// paint tick/error per node even though EventSource cannot set headers.
var liveControllers = {}; // jobId -> AbortController

function broadcast(message) {
  try { chrome.runtime.sendMessage(message, function () { void chrome.runtime.lastError; }); } catch (e) { /* popup closed */ }
}

async function startLive(payload) {
  var cfg = await getSettings();
  var base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
  if (!cfg.apiKey) return { ok: false, error: 'no_api_key' };
  var jobId = payload && payload.jobId;
  if (!jobId) return { ok: false, error: 'no_job_id' };
  var userId = (payload && payload.userId) || cfg.userId || 'local';

  // stop a previous stream for the same job if any
  if (liveControllers[jobId]) { try { liveControllers[jobId].abort(); } catch (e) { /* noop */ } }
  var controller = new AbortController();
  liveControllers[jobId] = controller;

  var url = (typeof ABCore !== 'undefined' && ABCore.buildSseUrl)
    ? ABCore.buildSseUrl(base, userId, jobId, cfg.apiKey)
    : base + '/live/sse/' + encodeURIComponent(userId) + '/' + encodeURIComponent(jobId) + '?api_key=' + encodeURIComponent(cfg.apiKey);

  // Drive the SSE stream with fetch + ReadableStream (works in MV3 workers,
  // unlike EventSource which is unavailable there).
  (async function pump() {
    try {
      var res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!res.ok || !res.body) {
        broadcast({ type: 'AB_LIVE_ERROR', jobId: jobId, error: 'http_' + res.status });
        cleanupLive(jobId);
        return;
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var idx;
        // SSE frames are separated by a blank line.
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleSseFrame(jobId, frame);
        }
      }
      broadcast({ type: 'AB_LIVE_END', jobId: jobId });
    } catch (e) {
      if (!controller.signal.aborted) {
        broadcast({ type: 'AB_LIVE_ERROR', jobId: jobId, error: 'network', message: String((e && e.message) || e) });
      }
    } finally {
      cleanupLive(jobId);
    }
  })();

  return { ok: true, jobId: jobId };
}

function handleSseFrame(jobId, frame) {
  // Parse the "event:" and "data:" lines of one SSE frame.
  var lines = frame.split('\n');
  var dataLines = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return;
  var raw = dataLines.join('\n');
  var ev;
  try { ev = JSON.parse(raw); } catch (e) { return; }

  var status = (typeof ABCore !== 'undefined' && ABCore.mapLiveEventToStatus)
    ? ABCore.mapLiveEventToStatus(ev) : null;
  broadcast({ type: 'AB_LIVE_EVENT', jobId: jobId, event: ev, status: status });

  if (typeof ABCore !== 'undefined' && ABCore.isTerminalEvent && ABCore.isTerminalEvent(ev)) {
    var ctrl = liveControllers[jobId];
    if (ctrl) { try { ctrl.abort(); } catch (e) { /* noop */ } }
  }
}

function cleanupLive(jobId) {
  if (liveControllers[jobId]) { delete liveControllers[jobId]; }
}

function stopLive(payload) {
  var jobId = payload && payload.jobId;
  if (jobId && liveControllers[jobId]) {
    try { liveControllers[jobId].abort(); } catch (e) { /* noop */ }
    cleanupLive(jobId);
  }
  return { ok: true };
}

// Step 31: open (or focus) the dashboard panel — the SAME UI the extension is
// a thin client of.
async function openPanel() {
  var cfg = await getSettings();
  var base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
  var url = (typeof ABCore !== 'undefined' && ABCore.buildPanelUrl) ? ABCore.buildPanelUrl(base) : base + '/';
  return new Promise(function (resolve) {
    chrome.tabs.create({ url: url }, function (tab) {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: 'open_failed' }); return; }
      resolve({ ok: true, tabId: tab && tab.id });
    });
  });
}

// Relay a control message to the active tab's content script.
async function relayToActiveTab(message) {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) { resolve({ ok: false, error: 'no_active_tab' }); return; }
      chrome.tabs.sendMessage(tab.id, message, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'no_content_script' });
        } else {
          resolve(resp || { ok: true });
        }
      });
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'AB_SEND_FLOW':
      sendFlow(msg.payload).then(sendResponse);
      return true; // async
    case 'AB_CHECK':
      checkConnection().then(sendResponse);
      return true; // async
    case 'AB_LIST_WORKFLOWS':
      listWorkflows().then(sendResponse);
      return true; // async
    case 'AB_RUN_SAVED':
      runSavedWorkflow(msg.payload).then(sendResponse);
      return true; // async
    case 'AB_LIVE_START':
      startLive(msg.payload).then(sendResponse);
      return true; // async
    case 'AB_LIVE_STOP':
      sendResponse(stopLive(msg.payload));
      return false;
    case 'AB_OPEN_PANEL':
      openPanel().then(sendResponse);
      return true; // async
    case 'AB_RELAY':
      relayToActiveTab(msg.message).then(sendResponse);
      return true; // async
    default:
      return false;
  }
});
