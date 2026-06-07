/* ============================================================
   popup.js — extension popup controller (Step 13, extended in Step 31).
   - Loads/saves backend settings (base URL, API key, userId).
   - Toggles picker / recorder in the active tab (via background relay).
   - Shows the recorded steps (chrome.storage.local.ab_steps).
   - Sends the inline Flow to the backend via the background service worker.
   - Step 31: lists the SAME saved workflows the dashboard panel shows
     (GET /workflows/:userId), runs a saved workflow, opens the panel, and
     paints a live tick/error per node by subscribing to the job's SSE stream
     (mirroring the dashboard's Step-26 node states).
   CSP-safe: external script, no inline handlers.

   Pure URL/parse/event/label logic is shared via ../lib/ab-core.js
   (window.ABCore), the same module the background worker and unit tests use.
   ============================================================ */
(function () {
  'use strict';

  var Core = (typeof window !== 'undefined' && window.ABCore) ? window.ABCore : null;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    conn: $('conn'),
    baseUrl: $('baseUrl'), apiKey: $('apiKey'), userId: $('userId'),
    saveCfg: $('saveCfg'), checkCfg: $('checkCfg'), openPanel: $('openPanel'),
    wflist: $('wflist'), wfCount: $('wfCount'), refreshWf: $('refreshWf'), runHeadful: $('runHeadful'),
    pick: $('pick'), record: $('record'),
    pickedBox: $('pickedBox'), pickedCss: $('pickedCss'), pickedXpath: $('pickedXpath'),
    addClick: $('addClick'), addExtract: $('addExtract'), copyCss: $('copyCss'),
    steps: $('steps'), stepCount: $('stepCount'),
    clearSteps: $('clearSteps'), sendFlow: $('sendFlow'), status: $('status'),
    liveCard: $('liveCard'), liveJob: $('liveJob'), livesteps: $('livesteps'), liveStatus: $('liveStatus')
  };

  var picking = false;
  var recording = false;
  var lastPick = null;
  var resolvedUserId = null;   // canonical userId from GET /me
  var liveJobId = null;        // currently-streamed job
  var liveRows = {};           // step index -> <li> element

  function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, r); }); }
  function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }
  function bg(msg) {
    return new Promise(function (r) {
      chrome.runtime.sendMessage(msg, function (resp) { void chrome.runtime.lastError; r(resp || { ok: false }); });
    });
  }
  function relay(message) { return bg({ type: 'AB_RELAY', message: message }); }

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }
  function setLiveStatus(text, kind) {
    els.liveStatus.textContent = text || '';
    els.liveStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Use the shared label so popup/n8n/dashboard stay consistent.
  function stepLabel(s) {
    if (Core && Core.stepLabel) return Core.stepLabel(s);
    var p = (s && s.params) || {};
    if (s && s.action === 'goto') return 'goto ' + (p.url || '');
    if (s && s.action === 'click') return 'click ' + (p.selector || '');
    return (s && s.action ? s.action : '') + ' ' + JSON.stringify(p);
  }

  function renderSteps(arr) {
    arr = arr || [];
    els.stepCount.textContent = String(arr.length);
    if (!arr.length) {
      els.steps.innerHTML = '<li class="empty">No steps yet. Pick an element or start recording.</li>';
      return;
    }
    els.steps.innerHTML = '';
    arr.forEach(function (s) {
      var li = document.createElement('li');
      li.textContent = stepLabel(s);
      els.steps.appendChild(li);
    });
  }

  async function loadSteps() {
    var s = await get(['ab_steps']);
    renderSteps(s.ab_steps);
  }

  async function appendStep(step) {
    var s = await get(['ab_steps']);
    var arr = Array.isArray(s.ab_steps) ? s.ab_steps : [];
    arr.push(step);
    await set({ ab_steps: arr });
    renderSteps(arr);
  }

  // ---- settings --------------------------------------------------------
  async function loadSettings() {
    var s = await get(['ab_baseUrl', 'ab_apiKey', 'ab_userId', 'ab_picker', 'ab_recording']);
    els.baseUrl.value = s.ab_baseUrl || '';
    els.apiKey.value = s.ab_apiKey || '';
    els.userId.value = s.ab_userId || 'local';
    picking = !!s.ab_picker;
    recording = !!s.ab_recording;
    syncToggleUi();
  }
  async function saveSettings() {
    await set({
      ab_baseUrl: els.baseUrl.value.trim(),
      ab_apiKey: els.apiKey.value,
      ab_userId: (els.userId.value.trim() || 'local')
    });
    setStatus('Saved.', 'ok');
  }

  async function checkConn() {
    setStatus('Testing…', 'warn');
    var r = await bg({ type: 'AB_CHECK' });
    if (r && r.ok) {
      els.conn.textContent = '● online';
      els.conn.className = 'conn ok';
      // Resolve the canonical userId the key is bound to (e.g. "local").
      resolvedUserId = Core ? Core.resolveUserId(r.data, els.userId.value) : (r.data && r.data.userId) || els.userId.value;
      if (resolvedUserId && resolvedUserId !== els.userId.value) {
        els.userId.value = resolvedUserId;
        await set({ ab_userId: resolvedUserId });
      }
      setStatus('Connected as "' + resolvedUserId + '".', 'ok');
      refreshWorkflows();
    } else {
      els.conn.textContent = '● offline';
      els.conn.className = 'conn bad';
      setStatus('Connection failed: ' + ((r && (r.error || ('http_' + r.status))) || 'unknown'), 'bad');
    }
  }

  async function openPanel() {
    var r = await bg({ type: 'AB_OPEN_PANEL' });
    if (!r || !r.ok) setStatus('Open panel failed: ' + ((r && r.error) || 'unknown') + '. Set a base URL first.', 'bad');
  }

  // ---- workflows (shared list with the dashboard panel) ----------------
  function renderWorkflows(list) {
    list = list || [];
    els.wfCount.textContent = String(list.length);
    els.wflist.innerHTML = '';
    if (!list.length) {
      els.wflist.innerHTML = '<li class="empty">No saved workflows for this user yet.</li>';
      return;
    }
    list.forEach(function (wf) {
      var li = document.createElement('li');
      li.className = 'wfitem';

      var meta = document.createElement('div');
      meta.className = 'wfmeta';
      var name = document.createElement('span');
      name.className = 'wfname';
      name.textContent = wf.name;
      var sub = document.createElement('span');
      sub.className = 'wfsub';
      var bits = [];
      if (wf.version != null) bits.push('v' + wf.version);
      if (wf.stepCount != null) bits.push(wf.stepCount + ' step' + (wf.stepCount === 1 ? '' : 's'));
      sub.textContent = bits.join(' · ');
      meta.appendChild(name);
      meta.appendChild(sub);

      var runBtn = document.createElement('button');
      runBtn.className = 'btn primary sm';
      runBtn.textContent = '▶ Run';
      runBtn.addEventListener('click', function () { runSaved(wf); });

      li.appendChild(meta);
      li.appendChild(runBtn);
      els.wflist.appendChild(li);
    });
  }

  async function refreshWorkflows() {
    var r = await bg({ type: 'AB_LIST_WORKFLOWS' });
    if (r && r.ok) {
      var list = r.workflows || (Core ? Core.parseWorkflowList(r.data) : []);
      renderWorkflows(list);
    } else {
      els.wflist.innerHTML = '<li class="empty">Could not load workflows: ' +
        ((r && (r.error || ('http_' + r.status))) || 'unknown') + '</li>';
      els.wfCount.textContent = '0';
    }
  }

  async function runSaved(wf) {
    setStatus('Running "' + wf.name + '"…', 'warn');
    var headless = !(els.runHeadful && els.runHeadful.checked);
    var r = await bg({ type: 'AB_RUN_SAVED', payload: { workflowId: wf.id, headless: headless } });
    if (r && r.ok) {
      var jobId = r.jobId || (Core ? Core.extractJobId(r.data) : null);
      setStatus('Queued "' + wf.name + '" ✓' + (jobId ? (' — Job ' + jobId) : ''), 'ok');
      if (jobId) startLive(jobId, wf);
    } else {
      var err = r && (r.error || ('http_' + r.status));
      var detail = r && r.data && r.data.error ? (' — ' + r.data.error) : '';
      setStatus('Run failed: ' + (err || 'unknown') + detail, 'bad');
    }
  }

  // ---- live (SSE) per-node tick/error ----------------------------------
  function resetLive(jobId, wf) {
    liveJobId = jobId;
    liveRows = {};
    els.liveCard.hidden = false;
    els.liveJob.textContent = (wf && wf.name ? wf.name + ' · ' : '') + jobId;
    els.livesteps.innerHTML = '<li class="empty">Waiting for events…</li>';
    setLiveStatus('Live…', 'warn');
  }

  function liveRow(index, action) {
    var key = (index == null) ? ('a' + Object.keys(liveRows).length) : String(index);
    if (liveRows[key]) return liveRows[key];
    // remove the placeholder on first real row
    var ph = els.livesteps.querySelector('.empty');
    if (ph) ph.remove();
    var li = document.createElement('li');
    li.className = 'liverow';
    var icon = document.createElement('span'); icon.className = 'liveicon'; icon.textContent = '•';
    var label = document.createElement('span'); label.className = 'livelabel';
    label.textContent = (index != null ? ('#' + index + ' ') : '') + (action || '');
    li.appendChild(icon); li.appendChild(label);
    els.livesteps.appendChild(li);
    liveRows[key] = li;
    return li;
  }

  function paintStatus(status) {
    if (!status) return;
    if (status.kind === 'job') {
      if (status.state === 'running') setLiveStatus('Running…', 'warn');
      else if (status.state === 'done') setLiveStatus('Done ✓' + (status.durationMs != null ? (' (' + status.durationMs + 'ms)') : ''), 'ok');
      else if (status.state === 'error') setLiveStatus('Failed: ' + (status.message || 'error'), 'bad');
      return;
    }
    if (status.kind === 'step') {
      var li = liveRow(status.index, status.action);
      var icon = li.querySelector('.liveicon');
      li.className = 'liverow ' + status.state;
      if (status.state === 'running') { icon.textContent = '…'; }
      else if (status.state === 'success') { icon.textContent = '✓'; li.title = (status.durationMs != null ? status.durationMs + 'ms' : ''); }
      else if (status.state === 'error') { icon.textContent = '✗'; li.title = status.error || 'error'; }
      else if (status.state === 'retry') { icon.textContent = '↻'; li.title = 'retry ' + (status.attempt || '') + '/' + (status.maxTries || ''); }
    }
  }

  function startLive(jobId, wf) {
    if (liveJobId && liveJobId !== jobId) bg({ type: 'AB_LIVE_STOP', payload: { jobId: liveJobId } });
    resetLive(jobId, wf);
    bg({ type: 'AB_LIVE_START', payload: { jobId: jobId, userId: resolvedUserId || els.userId.value } });
  }

  // ---- toggles ---------------------------------------------------------
  function syncToggleUi() {
    els.pick.classList.toggle('active', picking);
    els.pick.textContent = picking ? '🎯 Stop picking' : '🎯 Pick element';
    els.record.classList.toggle('active', recording);
    els.record.textContent = recording ? '⏹ Stop recording' : '⏺ Record';
  }

  async function togglePick() {
    picking = !picking;
    syncToggleUi();
    var r = await relay({ type: picking ? 'AB_PICK_START' : 'AB_PICK_STOP' });
    if (r && r.error === 'no_content_script') {
      setStatus('Open a normal web page (http/https), then try again.', 'warn');
      picking = false; syncToggleUi();
      await set({ ab_picker: false });
    } else {
      await set({ ab_picker: picking });
    }
  }

  async function toggleRecord() {
    recording = !recording;
    syncToggleUi();
    var r = await relay({ type: recording ? 'AB_REC_START' : 'AB_REC_STOP' });
    if (r && r.error === 'no_content_script') {
      setStatus('Open a normal web page (http/https), then try again.', 'warn');
      recording = false; syncToggleUi();
      await set({ ab_recording: false });
    } else {
      await set({ ab_recording: recording });
      if (recording) setStatus('Recording… interact with the page.', 'ok');
    }
  }

  function showPick(p) {
    lastPick = p;
    els.pickedBox.hidden = false;
    els.pickedCss.value = p.css || '';
    els.pickedXpath.value = p.xpath || '';
    setStatus('Picked <' + (p.tag || '?') + '>', 'ok');
  }

  function copyText(text) {
    try {
      navigator.clipboard.writeText(text);
      setStatus('Copied.', 'ok');
    } catch (e) { setStatus('Copy failed.', 'bad'); }
  }

  // ---- send inline flow ------------------------------------------------
  async function sendFlow() {
    var s = await get(['ab_steps']);
    var arr = Array.isArray(s.ab_steps) ? s.ab_steps : [];
    if (!arr.length) { setStatus('No steps to send.', 'warn'); return; }
    setStatus('Sending ' + arr.length + ' step(s)…', 'warn');
    var headless = !(els.runHeadful && els.runHeadful.checked);
    var r = await bg({ type: 'AB_SEND_FLOW', payload: { steps: arr, headless: headless } });
    if (r && r.ok) {
      var jid = r.jobId || (Core ? Core.extractJobId(r.data) : (r.data && r.data.jobId));
      setStatus('Queued ✓' + (jid != null ? (' — Job ' + jid) : ''), 'ok');
      if (jid) startLive(String(jid), { name: 'inline flow' });
    } else {
      var err = r && (r.error || ('http_' + r.status));
      var detail = r && r.data && r.data.error ? (' — ' + r.data.error) : '';
      setStatus('Send failed: ' + (err || 'unknown') + detail, 'bad');
    }
  }

  // ---- messages from content/background --------------------------------
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'AB_PICKED') {
      showPick(msg);
      picking = false; syncToggleUi();
      set({ ab_picker: false });
      relay({ type: 'AB_PICK_STOP' });
    } else if (msg.type === 'AB_STEP_RECORDED') {
      loadSteps();
    } else if (msg.type === 'AB_LIVE_EVENT') {
      if (!liveJobId || msg.jobId === liveJobId) paintStatus(msg.status);
    } else if (msg.type === 'AB_LIVE_END') {
      if (msg.jobId === liveJobId) setLiveStatus(els.liveStatus.textContent || 'Stream ended.', els.liveStatus.className.indexOf('bad') >= 0 ? 'bad' : 'ok');
    } else if (msg.type === 'AB_LIVE_ERROR') {
      if (msg.jobId === liveJobId) setLiveStatus('Live error: ' + (msg.error || 'unknown'), 'bad');
    }
  });

  // ---- wire up ---------------------------------------------------------
  els.saveCfg.addEventListener('click', saveSettings);
  els.checkCfg.addEventListener('click', checkConn);
  els.openPanel.addEventListener('click', openPanel);
  els.refreshWf.addEventListener('click', refreshWorkflows);
  els.pick.addEventListener('click', togglePick);
  els.record.addEventListener('click', toggleRecord);
  els.addClick.addEventListener('click', function () {
    if (lastPick && lastPick.css) appendStep({ action: 'click', params: { selector: lastPick.css } });
  });
  els.addExtract.addEventListener('click', function () {
    if (lastPick && lastPick.css) {
      var name = (window.prompt('Field name for extracted value:', 'value') || 'value').trim() || 'value';
      appendStep({ action: 'extract', params: { selector: lastPick.css, name: name } });
    }
  });
  els.copyCss.addEventListener('click', function () {
    if (lastPick && lastPick.css) copyText(lastPick.css);
  });
  els.clearSteps.addEventListener('click', async function () {
    await set({ ab_steps: [], ab_last_url: '' });
    renderSteps([]);
    setStatus('Cleared.', 'ok');
  });
  els.sendFlow.addEventListener('click', sendFlow);

  // init
  loadSettings();
  loadSteps();
})();
