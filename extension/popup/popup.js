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
    hoState: $('hoState'), hoSession: $('hoSession'), hoUnpair: $('hoUnpair'),
    hoCode: $('hoCode'), hoPair: $('hoPair'), hoApply: $('hoApply'), hoStatus: $('hoStatus'),
    inspMode: $('inspMode'), inspNode: $('inspNode'), inspTarget: $('inspTarget'),
    inspect: $('inspect'), inspRefresh: $('inspRefresh'), inspStatus: $('inspStatus'),
    modeSwitch: $('modeSwitch'),
    inspPairBox: $('inspPairBox'), inspCode: $('inspCode'), inspPair: $('inspPair'),
    inspPairStatus: $('inspPairStatus'), inspUnpair: $('inspUnpair'),
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

  /* ============================================================
     ELEMENT INSPECTOR

     The popup does NOT host the picker UI — an extension popup closes the
     moment focus leaves it, and the picker's first act is moving the mouse
     onto the page. The panel therefore lives in the page (content/inspector.js)
     and the popup's job here is only: report what we are attached to, and arm
     the picker.
     ============================================================ */

  var inspectorMode = '';
  var inspectorModes = [];

  function setInspStatus(text, kind) {
    els.inspStatus.textContent = text || '';
    els.inspStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Name the destination the way the user chose it: the node, then the field.
  // An opaque `node_…__url__a1b2c3d4` is correct and useless — it names nothing
  // the user can match against what they are looking at in the project.
  function targetName(target) {
    if (!target) return '';
    if (target.label) return target.label;
    var node = target.action || target.nodeId || 'node';
    return target.fieldKey ? node + ' \u2192 ' + target.fieldKey : node;
  }

  // Destination and mode come from the backend, never from a local guess: the
  // backend is the only thing that knows which fields are live and which of them
  // this extension may write to, and a wrong guess here would be shown as fact.
  async function refreshInspector(quiet) {
    var res = await bg({ type: 'AB_INSPECTOR_SESSION' });

    // Three distinct states, because they need three different actions from the
    // user: connected (pick away), connected-to-something-now-gone (re-connect),
    // and never connected (enter a code). Collapsing the middle one into "not
    // connected" would hide the reason a pick just started failing.
    var paired = !!(res && res.targetFieldId);
    var live = !!(res && res.authorized && res.target);
    if (live) {
      els.inspTarget.textContent = targetName(res.target);
      els.inspTarget.className = 'ivalue local';
    } else if (paired) {
      els.inspTarget.textContent = 'connected, but that field is no longer open';
      els.inspTarget.className = 'ivalue none';
    } else {
      els.inspTarget.textContent = 'not connected — enter an Authorization Code';
      els.inspTarget.className = 'ivalue none';
    }
    els.inspUnpair.hidden = !paired;
    // Once connected the code box is no longer the main action, but it stays
    // reachable: re-pairing to a different field is a normal thing to want.
    els.inspPairBox.hidden = false;
    els.inspPair.textContent = paired ? 'Connect to a different field' : 'Connect';

    if (!res || !res.ok) {
      var err = (res && res.error) || 'unreachable';
      els.inspMode.textContent = '—';
      els.inspMode.className = 'ivalue none';
      els.inspNode.textContent = '—';
      els.inspNode.className = 'ivalue none';
      els.modeSwitch.hidden = true;
      if (!quiet) {
        setInspStatus(
          err === 'no_base_url' ? 'Set the base URL first.'
            : err === 'no_api_key' ? 'Set the API key first.'
              : 'Cannot reach the project (' + err + ').',
          'bad'
        );
      }
      return;
    }

    var data = res.data || {};
    inspectorMode = data.mode || '';
    inspectorModes = data.modes || [];

    els.inspMode.textContent = inspectorMode === 'local'
      ? 'Local (your machine)'
      : inspectorMode === 'remote' ? 'Remote (server)' : '—';
    els.inspMode.className = 'ivalue ' + (inspectorMode || 'none');

    // The switch button offers the OTHER mode, and only when that mode can
    // actually be entered — offering "Local" with no agent connected would be
    // offering a button that can only fail.
    var other = inspectorMode === 'local' ? 'remote' : 'local';
    var canOther = other === 'remote' || data.localAvailable;
    els.modeSwitch.hidden = !(inspectorModes.length > 1 && canOther);
    els.modeSwitch.textContent = other === 'local' ? 'Use Local' : 'Use Remote';
    els.modeSwitch.dataset.target = other;

    // How many fields are open across the project, which is not the same
    // question as which one THIS extension is connected to. Both are shown
    // because "nothing is open" and "I am not connected to what is open" need
    // different fixes, and one line cannot say which applies.
    var targets = data.targets || [];
    if (!targets.length) {
      els.inspNode.textContent = 'no fields open — press Connect Inspector on a field';
      els.inspNode.className = 'ivalue none';
    } else if (targets.length === 1) {
      els.inspNode.textContent = targetName(targets[0]);
      els.inspNode.className = 'ivalue';
    } else {
      els.inspNode.textContent = targets.length + ' fields open';
      els.inspNode.className = 'ivalue';
    }

    if (!quiet) {
      if (!targets.length) {
        setInspStatus('No field is waiting. Open a node in the project, then connect.', 'warn');
      } else if (!paired) {
        setInspStatus('Not connected yet — enter an Authorization Code below.', 'warn');
      } else if (!live) {
        // The pairing survived, the field did not. Saying "not connected" here
        // would send the user looking for the wrong problem.
        setInspStatus('The connected field is no longer open. Connect again.', 'warn');
      } else if (data.pending) {
        setInspStatus(data.pending + ' pick(s) waiting to be applied.', 'warn');
      } else {
        setInspStatus('Ready \u2014 picks go to ' + targetName(res.target) + '.', 'ok');
      }
    }
  }

  /* ----------------------------------------------------------
     PAIRING — the one-time step that gives this extension a destination.

     The code is redeemed by the backend, which decides the field. Nothing here
     names a target: an extension that could pick its own destination could aim
     a pick at a field the user never offered.
     ---------------------------------------------------------- */
  function setPairStatus(text, kind) {
    els.inspPairStatus.textContent = text || '';
    els.inspPairStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Cosmetic only — the server normalises separators away, so a dash the user
  // types, or does not type, changes nothing about whether the code works.
  function onInspCodeInput() {
    var raw = (Core && Core.normalizePairingCode)
      ? Core.normalizePairingCode(els.inspCode.value)
      : String(els.inspCode.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    els.inspCode.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4, 8) : raw;
  }

  async function pairInspector() {
    var code = els.inspCode.value;
    if (Core && Core.looksLikePairingCode && !Core.looksLikePairingCode(code)) {
      setPairStatus('Enter the 8-character code shown on the field (like ABCD-EFGH).', 'bad');
      return;
    }

    els.inspPair.disabled = true;
    setPairStatus('Connecting\u2026', '');
    var res = await bg({ type: 'AB_INSPECTOR_PAIR', payload: { code: code } });
    els.inspPair.disabled = false;

    if (!res || !res.ok) {
      // The worker forwards the server's specific §27 reason. Showing it
      // verbatim is the difference between "check what you typed" and "ask for a
      // fresh code", which are different actions.
      setPairStatus((res && (res.error || res.reason)) || 'The code was refused.', 'bad');
      return;
    }

    // Name what was connected. A bare "connected" leaves the user to trust that
    // the code pointed where they thought it did.
    var name = targetName(res.target);
    setPairStatus('Connected' + (name ? ' to ' + name : '') + '.', 'ok');
    els.inspCode.value = '';
    await refreshInspector(true);
  }

  async function unpairInspector() {
    await bg({ type: 'AB_INSPECTOR_UNPAIR' });
    setPairStatus('Disconnected. Enter a new code to connect again.', '');
    await refreshInspector(true);
  }

  async function startInspector() {
    setInspStatus('Arming\u2026', '');
    var res = await bg({ type: 'AB_INSPECTOR_TOGGLE', desired: 'start' });
    if (!res || !res.ok) {
      var err = (res && res.error) || 'failed';
      setInspStatus(
        err === 'no_active_tab' ? 'No active tab.'
          : err === 'no_content_script' || err === 'inject_failed'
            ? 'Cannot inspect this page (browser-internal pages are off limits).'
            : 'Could not start the inspector (' + err + ').',
        'bad'
      );
      return;
    }
    setInspStatus('Hover an element and click it. Esc cancels.', 'ok');
    // The popup is about to close anyway (focus moves to the page); closing it
    // ourselves removes the dead window sitting over the page being inspected.
    window.close();
  }

  // ---- Remote -> Local handoff -----------------------------------------
  //
  // Every step is delegated to the background worker. The popup never opens the
  // tabs itself, because the popup dies the moment focus moves to a newly
  // created tab — which is the very first thing a restore does. Hosting the
  // sequence here would reliably kill it after tab one.

  function setHoStatus(text, kind) {
    els.hoStatus.textContent = text || '';
    els.hoStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function refreshHandoff() {
    var res = await bg({ type: 'AB_HANDOFF_STATUS' });
    var paired = !!(res && res.paired);

    els.hoState.textContent = paired ? 'yes' : 'not yet';
    els.hoState.className = 'ivalue ' + (paired ? 'local' : 'none');
    els.hoSession.textContent = (res && res.sessionId) ? res.sessionId : '—';
    els.hoUnpair.hidden = !paired;

    // Once paired, the code box is no longer the main action — restoring is. A
    // paired browser can be asked to pull again at any time, which is what makes
    // an interrupted restore recoverable instead of a dead end.
    els.hoApply.hidden = !paired;
    els.hoPair.textContent = paired ? 'Pair with a new code' : 'Pair & move my tabs';
    return paired;
  }

  // Format as the user types so what they see matches what the app showed them.
  // Purely cosmetic: the server normalises separators away, so a dash the user
  // types, or does not type, changes nothing about whether the code works.
  function onCodeInput() {
    var raw = (Core && Core.normalizePairingCode)
      ? Core.normalizePairingCode(els.hoCode.value)
      : String(els.hoCode.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    els.hoCode.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4, 8) : raw;
  }

  async function pairHandoff() {
    var code = els.hoCode.value;
    if (Core && Core.looksLikePairingCode && !Core.looksLikePairingCode(code)) {
      setHoStatus('Enter the 8-character code shown in the app (like ABCD-EFGH).', 'bad');
      return;
    }

    els.hoPair.disabled = true;
    setHoStatus('Pairing\u2026', '');
    var res = await bg({ type: 'AB_HANDOFF_PAIR', payload: { code: code } });
    if (!res || !res.ok) {
      els.hoPair.disabled = false;
      // The worker forwards the server's specific reason; showing it verbatim is
      // the difference between "try again" and "you need a fresh code", which
      // are different actions.
      setHoStatus((res && res.error) || 'Pairing failed.', 'bad');
      return;
    }

    // Paired: immediately do the thing the user actually wanted. Requiring a
    // second click here would be asking them to confirm the request they just
    // made.
    setHoStatus('Paired. Moving your tabs\u2026', 'ok');
    await refreshHandoff();
    els.hoCode.value = '';
    await applyHandoff(true);
    els.hoPair.disabled = false;
  }

  async function applyHandoff(chained) {
    els.hoApply.disabled = true;
    if (!chained) setHoStatus('Moving your tabs\u2026', '');

    var res = await bg({ type: 'AB_HANDOFF_APPLY' });
    els.hoApply.disabled = false;

    if (!res || !res.ok) {
      await refreshHandoff();
      setHoStatus((res && res.error) || 'Could not move the session.', 'bad');
      return;
    }

    var n = res.restored || 0;
    var msg = n === 0
      ? 'Session moved here. There were no tabs open to bring across.'
      : 'Moved ' + n + ' tab' + (n === 1 ? '' : 's') + ' here'
        + (res.activeTabRestored ? ', and focused the one you were on.' : '.');

    // Limits are reported, never hidden. Cookies in particular cannot always be
    // carried across, and a user who is silently signed out will conclude the
    // feature is broken; a user who was told will not.
    if (res.limits) msg += ' Note: ' + res.limits + '.';
    setHoStatus(msg, 'ok');
    await refreshHandoff();
    await refreshInspector(true);
  }

  async function unpairHandoff() {
    await bg({ type: 'AB_HANDOFF_UNPAIR' });
    await refreshHandoff();
    setHoStatus('This browser is no longer paired.', '');
  }

  async function switchMode() {
    var target = els.modeSwitch.dataset.target;
    if (!target) return;
    setInspStatus('Switching to ' + target + '\u2026', '');
    var res = await bg({ type: 'AB_MODE_SET', payload: { mode: target } });
    if (!res || !res.ok) {
      setInspStatus((res && res.error) || 'Could not switch mode.', 'bad');
      await refreshInspector(true);
      return;
    }
    await refreshInspector(true);
    setInspStatus('Now using ' + (inspectorMode || target) + '.', 'ok');
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
  els.inspect.addEventListener('click', startInspector);
  els.inspRefresh.addEventListener('click', function () { refreshInspector(false); });
  els.modeSwitch.addEventListener('click', switchMode);
  els.inspPair.addEventListener('click', pairInspector);
  els.inspUnpair.addEventListener('click', unpairInspector);
  els.inspCode.addEventListener('input', onInspCodeInput);
  // Enter submits, same reasoning as the handoff box: the code is usually
  // pasted, and it expires, so reaching for the mouse is pure friction.
  els.inspCode.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); pairInspector(); }
  });
  els.hoPair.addEventListener('click', pairHandoff);
  els.hoApply.addEventListener('click', function () { applyHandoff(false); });
  els.hoUnpair.addEventListener('click', unpairHandoff);
  els.hoCode.addEventListener('input', onCodeInput);
  // Enter submits: this box is usually reached by pasting a code, and reaching
  // for the mouse afterwards is friction on a credential that expires.
  els.hoCode.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); pairHandoff(); }
  });

  // init
  loadSettings();
  loadSteps();
  refreshHandoff();
  // Quiet on open: an unconfigured extension should show a settings prompt in
  // the Backend card, not a red inspector error the user cannot yet act on.
  refreshInspector(true);
})();
