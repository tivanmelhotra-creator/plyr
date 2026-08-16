/* ============================================================
   popup.js — the Element Inspector popup controller.

   WHAT THIS FILE IS NOW
   ---------------------
   The extension is no longer a multi-purpose Automation Helper. It is one
   product with one job, and the popup has exactly two tabs to match:

     INSPECT     — which Target Field am I attached to, and arm the picker
     CONNECTION  — where the backend is, the credentials, and the resulting state

   WHAT LEFT, AND WHAT THAT DOES NOT MEAN
   --------------------------------------
   The saved-workflow list, the recorded-step list, the live SSE run view and
   the Session Handoff pairing box are no longer driven from here. None of that
   capability was deleted:

     * extension/background.js still handles AB_SEND_FLOW, AB_RUN_SAVED,
       AB_LIST_WORKFLOWS, AB_LIVE_START/STOP, AB_MODE_GET/SET, AB_RELAY,
       AB_OPEN_PANEL and every AB_HANDOFF_* message, unchanged.
     * extension/lib/ab-handoff.js is untouched, and so is every
       /browser-mode/handoff/* route.
     * The web app owns its own Handoff UI (public/js/browser-handoff.js,
       mounted at public/index.html), which is where a user switches a session
       between Remote and Local. That flow never needed this popup.

   So this is a RE-SCOPE of the popup, not a removal of features from the
   project. What was removed here was duplicate or out-of-scope UI.

   WHAT DELIBERATELY DOES NOT EXIST
   --------------------------------
   No User ID field. Identity comes from backend authentication (the API key),
   and a user-typed identity in the popup would be a second, contradictable
   source of truth. §25: «There is NO: username, user ID, password, login form.»

   No session id. The Inspector's destination is a real, server-minted
   Target Field — `node_<nodeId>__<fieldKey>__<uniqueSuffix>` — which survives
   session changes and Local/Remote switches precisely because it is not a
   session.

   The popup also does NOT host the picker UI: an extension popup closes the
   moment focus leaves it, and the picker's first act is moving the mouse onto
   the page. The attribute table with its checkboxes and radio lives in the page
   (content/inspector.js). This controller's job is to say where a pick will
   land, and to arm the picker.

   CSP-safe: external script, no inline handlers. Pure URL/parse/label logic is
   shared via ../lib/ab-core.js (window.ABCore), the same module the background
   worker and the unit tests use.
   ============================================================ */
(function () {
  'use strict';

  var Core = (typeof window !== 'undefined' && window.ABCore) ? window.ABCore : null;

  // The default backends the two mode cards offer. LOCAL is 127.0.0.1 rather
  // than "localhost" because that is what the spec prints and what a user will
  // compare against; the two are not always the same host in practice.
  var LOCAL_URL = 'http://127.0.0.1:3000';
  var REMOTE_URL = 'https://your-server.com';

  var $ = function (id) { return document.getElementById(id); };
  // Resolved eagerly, once, with no null guards — which is exactly why
  // popup-tabs.test.ts asserts every one of these ids exists in the document.
  // A single missing id throws here and blanks the whole popup.
  var els = {
    conn: $('conn'), status: $('status'),
    // Connection tab
    modeLocal: $('modeLocal'), modeRemote: $('modeRemote'),
    modeLocalUrl: $('modeLocalUrl'), modeRemoteUrl: $('modeRemoteUrl'),
    baseUrl: $('baseUrl'), apiKey: $('apiKey'),
    inspCode: $('inspCode'), connect: $('connect'), inspPairStatus: $('inspPairStatus'),
    connState: $('connState'), connBackend: $('connBackend'), connAuth: $('connAuth'),
    ctNode: $('ctNode'), ctField: $('ctField'), ctFieldId: $('ctFieldId'),
    // Browser Environment and the durable pairing — the two facts the address
    // in ctFieldId cannot express. See paintTarget() for why both are needed.
    ctEnv: $('ctEnv'), ctPairing: $('ctPairing'),
    ctState: $('ctState'), inspUnpair: $('inspUnpair'),
    // Inspect tab
    inspNodeName: $('inspNodeName'), inspFieldName: $('inspFieldName'),
    inspFieldId: $('inspFieldId'), inspEnv: $('inspEnv'),
    inspTarget: $('inspTarget'), inspNode: $('inspNode'),
    inspect: $('inspect'), inspRefresh: $('inspRefresh'), inspStatus: $('inspStatus')
  };

  function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, r); }); }
  function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }
  function bg(msg) {
    return new Promise(function (r) {
      chrome.runtime.sendMessage(msg, function (resp) { void chrome.runtime.lastError; r(resp || { ok: false }); });
    });
  }

  function write(el, text, kind) {
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function setStatus(text, kind) { write(els.status, text, kind); }
  function setInspStatus(text, kind) { write(els.inspStatus, text, kind); }
  function setPairStatus(text, kind) { write(els.inspPairStatus, text, kind); }

  // A value line: one place that decides the tint, so "unknown" never renders
  // as though it were a real answer.
  function value(el, text, tone) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'ivalue' + (tone ? ' ' + tone : '');
  }
  function monoValue(el, text, tone) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'ivalue mono' + (tone ? ' ' + tone : '');
  }
  function stateLine(el, text, tone) {
    el.textContent = text || '';
    el.className = 'tfstate' + (tone ? ' ' + tone : '');
  }

  /* ============================================================
     CONNECTION — backend location and credentials.

     Local vs Remote here is §1's distinction and ONLY that: where the backend
     lives. It says nothing about where the browser runs. The Remote Browser and
     the Session Handoff are a separate subsystem with its own UI in the web
     app, and conflating the two is what made the old popup confusing.
     ============================================================ */

  // Which card is lit is derived from the URL, never stored separately: two
  // sources for one fact drift, and then the popup claims "Local" while sending
  // to a remote host.
  function modeOf(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(u) ? 'local' : 'remote';
  }

  function syncModeCards() {
    var mode = modeOf(els.baseUrl.value);
    els.modeLocal.checked = mode === 'local';
    els.modeRemote.checked = mode === 'remote';
    // Each card shows the URL it would select, so the choice is legible before
    // it is made. Once a real URL is in the box, the matching card shows THAT
    // rather than the placeholder it started from.
    els.modeLocalUrl.textContent = mode === 'local' ? els.baseUrl.value.trim() : LOCAL_URL;
    els.modeRemoteUrl.textContent = mode === 'remote' ? els.baseUrl.value.trim() : REMOTE_URL;
  }

  // Picking a card fills the Base URL in, because a card that only sets a
  // hidden preference would leave the visible URL contradicting it.
  async function chooseMode(mode) {
    var current = els.baseUrl.value.trim();
    if (modeOf(current) === mode && current) { syncModeCards(); return; }
    els.baseUrl.value = mode === 'local' ? LOCAL_URL : (mode === 'remote' && current && modeOf(current) === 'remote' ? current : REMOTE_URL);
    syncModeCards();
    await saveSettings(true);
  }

  async function loadSettings() {
    var s = await get(['ab_baseUrl', 'ab_apiKey']);
    els.baseUrl.value = s.ab_baseUrl || '';
    els.apiKey.value = s.ab_apiKey || '';
    syncModeCards();
  }

  // Saved on every edit, not behind a Save button. The old popup had one, and a
  // user who typed a key and pressed Connect without pressing Save first got a
  // failure that blamed the key.
  async function saveSettings(quiet) {
    await set({ ab_baseUrl: els.baseUrl.value.trim(), ab_apiKey: els.apiKey.value });
    if (!quiet) setStatus('Saved.', 'ok');
  }

  /* ----------------------------------------------------------
     CONNECT — one button doing the two things the user means by it.

     Pressing Connect with a code in the box PAIRS: the code is redeemed by the
     backend, which decides the field. Nothing here names a target — an
     extension that could pick its own destination could aim a pick at a field
     the user never offered (§8), so the message body carries only the code.

     Pressing Connect with the box empty just re-tests the backend, which is
     what a user with an already-paired extension means by it.
     ---------------------------------------------------------- */
  async function connect() {
    await saveSettings(true);

    var code = els.inspCode.value.trim();
    if (!code) { await testConnection(); return; }

    if (Core && Core.looksLikePairingCode && !Core.looksLikePairingCode(code)) {
      setPairStatus('Enter the 8-character code shown on the field (like ABCD-EFGH).', 'bad');
      return;
    }

    els.connect.disabled = true;
    setPairStatus('Connecting\u2026', '');
    var res = await bg({ type: 'AB_INSPECTOR_PAIR', payload: { code: code } });
    els.connect.disabled = false;

    if (!res || !res.ok) {
      // The worker forwards the server's specific §27 reason. Showing it
      // verbatim is the difference between "check what you typed" and "ask for
      // a fresh code", which are different actions.
      setPairStatus((res && (res.error || res.reason)) || 'The code was refused.', 'bad');
      await refreshInspector(true);
      return;
    }

    // Name what was connected. A bare "connected" leaves the user to trust that
    // the code pointed where they thought it did.
    var name = targetName(res.target);
    setPairStatus('Connected' + (name ? ' to ' + name : '') + '.', 'ok');
    els.inspCode.value = '';
    await refreshInspector(true);
  }

  async function testConnection() {
    setStatus('Testing\u2026', 'warn');
    var r = await bg({ type: 'AB_CHECK' });
    if (r && r.ok) {
      // No identity is read out of this. GET /me proves the key works; who the
      // key belongs to is the backend's business, not something to echo into a
      // field the user could then edit.
      setStatus('Connected.', 'ok');
    } else {
      setStatus('Connection failed: ' + reason(r), 'bad');
    }
    await refreshInspector(true);
  }

  function reason(r) {
    if (!r) return 'unknown';
    if (r.error === 'no_base_url') return 'set the Base URL first';
    if (r.error === 'no_api_key') return 'set the API Key first';
    return r.error || ('http_' + r.status) || 'unknown';
  }

  async function unpairInspector() {
    await bg({ type: 'AB_INSPECTOR_UNPAIR' });
    setPairStatus('Disconnected. Enter a new code to connect again.', '');
    await refreshInspector(true);
  }

  // Cosmetic only — the server normalises separators away, so a dash the user
  // types, or does not type, changes nothing about whether the code works.
  function onCodeInput() {
    var raw = (Core && Core.normalizePairingCode)
      ? Core.normalizePairingCode(els.inspCode.value)
      : String(els.inspCode.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    els.inspCode.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4, 8) : raw;
  }

  /* ============================================================
     THE TARGET FIELD — the one thing both tabs are about.

     `node_<nodeId>__<fieldKey>__<uniqueSuffix>` is the real destination. It is
     minted by the server, it is field-level rather than node-level, and it is
     NOT a session: changing session, or switching the browser between Local and
     Remote, leaves it valid.
     ============================================================ */

  // Name the destination the way the user chose it: the node, then the field.
  // An opaque `node_…__url__a1b2c3d4` is correct and useless — it names nothing
  // the user can match against what they are looking at in the project.
  function targetName(target) {
    if (!target) return '';
    if (target.label) return target.label;
    var node = target.nodeName || target.action || target.nodeId || 'node';
    var field = target.fieldName || target.fieldKey;
    return field ? node + ' \u2192 ' + field : node;
  }
  function nodeNameOf(t) { return (t && (t.nodeName || t.action || t.nodeId)) || ''; }
  function fieldNameOf(t) { return (t && (t.fieldName || t.fieldKey)) || ''; }

  // Destination and state come from the backend, never from a local guess: the
  // backend is the only thing that knows which fields are live and which of
  // them this extension may write to, and a wrong guess would be shown as fact.
  async function refreshInspector(quiet) {
    var res = await bg({ type: 'AB_INSPECTOR_SESSION' });

    // Three distinct states, because they need three different actions from the
    // user: connected (pick away), connected-to-something-now-gone (re-connect),
    // and never connected (enter a code). Collapsing the middle one into "not
    // connected" would hide the reason a pick just started failing.
    var paired = !!(res && res.targetFieldId);
    var live = !!(res && res.authorized && res.target);
    var target = (res && res.target) || null;

    paintTarget(paired, live, target, res);
    paintConnection(res, paired, live, target);

    if (!res || !res.ok) {
      value(els.inspNode, '', 'none');
      if (!quiet) setInspStatus(unreachableText(res), 'bad');
      return;
    }

    var data = res.data || {};

    // How many fields are open across the project, which is not the same
    // question as which one THIS extension is connected to. Both are shown
    // because "nothing is open" and "I am not connected to what is open" need
    // different fixes, and one line cannot say which applies.
    var targets = data.targets || [];
    if (!targets.length) {
      value(els.inspNode, 'no fields open \u2014 press Connect Inspector on a field', 'none');
    } else if (targets.length === 1) {
      value(els.inspNode, targetName(targets[0]));
    } else {
      value(els.inspNode, targets.length + ' fields open');
    }

    if (!quiet) {
      if (!targets.length) {
        setInspStatus('No field is waiting. Open a node in the project, then connect.', 'warn');
      } else if (!paired) {
        setInspStatus('Not connected yet \u2014 enter an Authorization Code in Connection.', 'warn');
      } else if (!live) {
        // The pairing survived, the field did not. Saying "not connected" here
        // would send the user looking for the wrong problem.
        setInspStatus('The connected field is no longer open. Connect again.', 'warn');
      } else if (data.pending) {
        setInspStatus(data.pending + ' pick(s) waiting to be applied.', 'warn');
      } else {
        setInspStatus('Ready \u2014 picks go to ' + targetName(target) + '.', 'ok');
      }
    }
  }

  function unreachableText(res) {
    var err = (res && res.error) || 'unreachable';
    if (err === 'no_base_url') return 'Set the Base URL first.';
    if (err === 'no_api_key') return 'Set the API Key first.';
    return 'Cannot reach the project (' + err + ').';
  }

  // The Target Field card, painted identically on both tabs so the two never
  // disagree about where a pick would land.
  function paintTarget(paired, live, target, res) {
    var nodeName = nodeNameOf(target);
    var fieldName = fieldNameOf(target);
    var fieldId = (target && target.targetFieldId) || (res && res.targetFieldId) || '';

    value(els.inspNodeName, nodeName, nodeName ? '' : 'none');
    value(els.inspFieldName, fieldName, fieldName ? '' : 'none');
    monoValue(els.inspFieldId, fieldId, fieldId ? '' : 'none');
    value(els.ctNode, nodeName, nodeName ? '' : 'none');
    value(els.ctField, fieldName, fieldName ? '' : 'none');
    monoValue(els.ctFieldId, fieldId, fieldId ? '' : 'none');

    // ── Browser Environment ─────────────────────────────────────────────────
    //
    // Which browser the operator chose to target this field in, taken from the
    // SERVER's target record (background.js reads target.environment; the
    // extension never asserts it). Named in full — "Local Browser" / "Remote
    // Browser" — rather than shown as a bare "local"/"remote", because the
    // Connection tab immediately above uses those same two words for an
    // unrelated fact: where the BACKEND lives. Spelling out "Browser" is what
    // stops the two being read as one setting.
    var env = (res && res.environment) || (target && target.environment) || '';
    var envText = env === 'local' ? 'Local Browser'
      : env === 'remote' ? 'Remote Browser' : '';
    value(els.inspEnv, envText, envText ? '' : 'none');
    value(els.ctEnv, envText, envText ? '' : 'none');

    // ── The durable pairing ─────────────────────────────────────────────────
    //
    // Deliberately reported separately from "Connected", which tracks the
    // ADDRESS and therefore goes false every time the node is re-opened. This
    // line answers the question the operator is actually asking — will I be
    // asked for another code? — and it stays true across those re-opens, which
    // is the whole substance of the persistence requirement.
    //
    // A REMOTE field shows "not required" rather than "paired": no code was
    // ever issued for it, and claiming a pairing that does not exist would be
    // as misleading as hiding one that does.
    var durable = !!(res && res.paired);
    var pairText = durable
      ? '\u25cf Paired \u2014 no code needed next time'
      : env === 'remote'
        ? 'Not required for Remote Browser'
        : '\u25cb Not paired \u2014 a code will be requested';
    value(els.ctPairing, pairText, durable ? 'ok' : env === 'remote' ? '' : 'none');

    var text = live
      ? '\u25cf Connected to this Field'
      : paired
        ? '\u25cf Connected, but that field is no longer open'
        : '\u25cb Not connected \u2014 enter an Authorization Code';
    var tone = live ? 'ok' : paired ? 'warn' : 'none';
    stateLine(els.inspTarget, text, tone);
    stateLine(els.ctState, live ? '\u25cf Connection active' : text, tone);

    // Disconnect is offered whenever a pairing exists, including a stale one:
    // clearing a pairing that points at a closed field is a thing to be able to
    // do, not a dead end.
    els.inspUnpair.hidden = !paired;
  }

  function paintConnection(res, paired, live, target) {
    var reachable = !!(res && res.ok);
    var url = els.baseUrl.value.trim();

    if (reachable) {
      value(els.connState, '\u25cf Connected', 'ok');
      els.conn.textContent = '\u25cf online';
      els.conn.className = 'conn ok';
    } else {
      value(els.connState, '\u25cb ' + shortError(res), 'none');
      els.conn.textContent = '\u25cf offline';
      els.conn.className = 'conn bad';
    }
    monoValue(els.connBackend, url, url ? '' : 'none');

    // "Reachable" and "authorized for the field I am pointed at" are different
    // failures with different fixes, so they get different lines. A backend that
    // answers but refuses this field is the case that a single "Connected" would
    // hide until the first send failed.
    if (!reachable) value(els.connAuth, 'unknown', 'none');
    else if (live) value(els.connAuth, 'Valid', 'ok');
    else if (paired) value(els.connAuth, 'Field no longer open', 'warn');
    else value(els.connAuth, 'Not authorized yet', 'none');

    void target;
  }

  function shortError(res) {
    var err = (res && res.error) || 'unreachable';
    if (err === 'no_base_url') return 'No Base URL';
    if (err === 'no_api_key') return 'No API Key';
    return 'Not connected';
  }

  /* ============================================================
     ARMING THE PICKER
     ============================================================ */
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

  // ---- wire up ---------------------------------------------------------
  els.baseUrl.addEventListener('input', function () { syncModeCards(); });
  els.baseUrl.addEventListener('change', function () { saveSettings(true); });
  els.apiKey.addEventListener('change', function () { saveSettings(true); });
  els.modeLocal.addEventListener('change', function () { chooseMode('local'); });
  els.modeRemote.addEventListener('change', function () { chooseMode('remote'); });
  els.connect.addEventListener('click', connect);
  els.inspUnpair.addEventListener('click', unpairInspector);
  els.inspCode.addEventListener('input', onCodeInput);
  // Enter submits: the code is usually pasted, and it expires, so reaching for
  // the mouse afterwards is friction on a credential with a clock on it.
  els.inspCode.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); connect(); }
  });
  els.inspect.addEventListener('click', startInspector);
  els.inspRefresh.addEventListener('click', function () { refreshInspector(false); });

  // init — quiet on open: an unconfigured extension should show its state, not
  // a red error the user cannot yet act on.
  loadSettings().then(function () { return refreshInspector(true); });
})();
