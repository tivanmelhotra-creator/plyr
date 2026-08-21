/* ============================================================
   popup.js — the Element Inspector popup controller.

   WHAT THIS FILE IS
   -----------------
   One product with one job, and two tabs to match:

     INSPECT     — the Target Field, the picker, the picked element, its real
                   attributes, the destination, and the send
     CONNECTION  — where the backend is, the credentials, and the resulting state

   The presentation is the approved design in extension/UI_UX. The BEHAVIOUR is
   the behaviour that was already here and in the PRs before it — mapped into the
   new UI, not simplified to fit it:

     * the target is bound by the SERVER, and the server decides the field (§8)
     * neither environment needs an Authorization Code, an API Key or a Base URL
     * REMOTE BROWSER binds on the user APPROVING the Remote Approval prompt
     * LOCAL BROWSER binds with no prompt at all — it is the browser runtime on
       the same server as the application, so the context is already internal
     * the same extension + the same Target Field never re-binds
     * Browser Environment, Session/Handoff and targetFieldId stay three
       separate concepts, and only the first and third are visible here
     * CHECKBOX = what appears in SELECTED ELEMENT (many)
       RADIO    = the ONE value that is sent (exactly one)

   WHAT DELIBERATELY DOES NOT EXIST
   --------------------------------
   No Base URL field, no API Key field, no Authorization Code field, and no
   Connect button. This is the substance of the change, not a simplification of
   it: the server that launched this browser is the party that knows its own
   address and token, and it seeds them into this extension itself
   (src/core/InspectorExtension.ts → bootstrap.config.js →
   background.js applyBootstrapDefaults). A form here could only ask the user to
   re-supply, by hand and from inside a browser they may not be able to read them
   from, values that were already present and already correct.

   With them gone, so is everything that existed only to serve them: modeOf(),
   syncModeCards(), chooseMode(), applySettings(), loadSettings(),
   saveSettings(), togglePeek(), connect(), onCodeInput() and the LOCAL_URL /
   REMOTE_URL defaults. What remains of "connection" is a READING of the state
   the server resolved — see paintConnection().

   No User ID field. Identity comes from backend authentication, and a user-typed
   identity would be a second, contradictable source of truth.
   §25: «There is NO: username, user ID, password, login form.»

   No session id. The destination is a real, server-minted Target Field —
   `node_<nodeId>__<fieldKey>__<uniqueSuffix>` — which survives session changes
   and Local/Remote switches precisely because it is not a session.

   THERE IS a Browser Environment CHOOSER, and there has to be. It was reported
   missing — «UI فعلی دیگر هیچ انتخابی برای LOCAL BROWSER / REMOTE BROWSER
   ندارد» — and the correction is explicit that the choice belongs at the START
   of Target This Field: «این انتخاب باید در ابتدای Target This Field وجود داشته
   باشد و state واقعی Browser Environment را تعیین کند.»

   An earlier revision of this file argued the choice lived only in the web app's
   own dialog (public/js/targeting-flow.js renderChooser) and that this popup
   should merely REPORT the outcome. That was wrong in one specific way: this
   popup is the surface reached from inside the browser being targeted, so
   reporting-only left the operator with no way to make the choice at all from
   where they actually are. Both surfaces now offer it, through the SAME two
   server routes (/inspector/targeting/options and /inspector/targeting/begin),
   which is what keeps them from disagreeing — see paintEnvironment().

   It is NOT the Backend Connection: «این را با Backend Connection اشتباه نکن.»
   The environment says WHICH BROWSER picks; the backend says WHERE THE SERVER IS
   and is resolved by the server, never chosen. Choosing an environment adds NO
   credential control of any kind — no Base URL, no API key, no Authorization
   Code. Those were correctly deleted and are not coming back.

   WHERE THE PICKER LIVES, AND WHY THE PANEL IS IN BOTH PLACES
   ----------------------------------------------------------
   An extension popup closes the moment focus leaves it, and the picker's first
   act is moving the mouse onto the page — so the live picking UI must be in the
   page (content/inspector.js). But the approved design also shows SELECTED
   ELEMENT / ATTRIBUTES / DESTINATION in the popup, and that is not a
   contradiction: the picker WRITES its pick to chrome.storage.local, and this
   controller reads it back when the popup is re-opened. The user can pick in the
   page, or re-open the popup and adjust the ticks and the radio there, and both
   views drive the same two states.

   CSP-safe: external script, no inline handlers, no innerHTML. Every value that
   originates on an arbitrary page is written with textContent.
   ============================================================ */
(function () {
  'use strict';

  var Core = (typeof window !== 'undefined' && window.ABCore) ? window.ABCore : null;

  // LOCAL_URL / REMOTE_URL are gone with the mode cards they filled in. A
  // placeholder like 'https://your-server.com' was only ever meaningful as a
  // prompt for someone about to type over it, and nobody types here now. The
  // real address is resolved by the server and REPORTED through res.baseUrl.
  //
  // Where content/inspector.js leaves the last pick. Storage, not a message: the
  // popup is CLOSED at the moment of the pick, so there is nobody to message.
  var PICK_KEY = 'ab_lastPick';

  var $ = function (id) { return document.getElementById(id); };
  // Resolved eagerly, once, with no null guards — which is exactly why
  // popup-tabs.test.ts asserts every one of these ids exists in the document.
  // A single missing id throws here and blanks the whole popup.
  var els = {
    conn: $('conn'), status: $('status'),
    // ── Connection tab — READ-ONLY. The six credential ids that used to be
    // resolved here (modeLocal, modeRemote, modeLocalUrl, modeRemoteUrl,
    // baseUrl, apiKey, apiKeyPeek, inspCode, connect, inspPairStatus) are gone
    // from the document, so they are gone from this map too: the map has no null
    // guards, and a stale entry would throw on load and blank the whole popup.
    connState: $('connState'), connBackend: $('connBackend'), connAuth: $('connAuth'),
    ctNode: $('ctNode'), ctField: $('ctField'), ctFieldId: $('ctFieldId'),
    // Browser Environment and the durable pairing — the two facts the address
    // in ctFieldId cannot express. See paintTarget() for why both are needed.
    ctEnv: $('ctEnv'), ctPairing: $('ctPairing'),
    ctState: $('ctState'), inspUnpair: $('inspUnpair'),
    // The design's "● Connection Active" pill in the CONNECTED TO TARGET
    // heading. Written from the SAME verdict as ctState — see paintTarget() —
    // so the heading and the rows under it cannot disagree.
    ctLive: $('ctLive'),
    // ── Inspect tab: target
    inspNodeName: $('inspNodeName'), inspFieldName: $('inspFieldName'),
    inspFieldId: $('inspFieldId'), inspEnv: $('inspEnv'),
    inspTarget: $('inspTarget'), inspNode: $('inspNode'), inspNodeRow: $('inspNodeRow'),
    inspect: $('inspect'), inspRefresh: $('inspRefresh'), inspStatus: $('inspStatus'),
    // ── Inspect tab: the Browser Environment chooser (LOCAL / REMOTE) ──────
    // The FIRST step of targeting. Cards are built at runtime from the server's
    // own option list, so nothing here hard-codes which browsers exist.
    envCard: $('envCard'), envGrid: $('envGrid'), envStatus: $('envStatus'),
    // REMOTE-only credential form. See paintAuthorization().
    authCard: $('authCard'), authBase: $('authBase'), authCode: $('authCode'),
    authConnect: $('authConnect'), authHint: $('authHint'), authStatus: $('authStatus'),
    authPaste: $('authPaste'),
    // ── Inspect tab: the pick
    selList: $('selList'), selEmpty: $('selEmpty'),
    attrList: $('attrList'), attrEmpty: $('attrEmpty'), attrTools: $('attrTools'),
    attrAll: $('attrAll'), attrNone: $('attrNone'), attrCount: $('attrCount'),
    destNode: $('destNode'), destField: $('destField'), destFieldId: $('destFieldId'),
    destAttr: $('destAttr'), destValue: $('destValue'), destState: $('destState'),
    sendAttr: $('sendAttr'), sendStatus: $('sendStatus')
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
  // setPairStatus() is removed with #inspPairStatus: it reported the outcome of
  // redeeming an Authorization Code, and there is no code to redeem. Anything
  // still worth saying about the connection is said by paintConnection() from
  // the server's own answer, not by this popup narrating its own attempt.
  function setSendStatus(text, kind) { write(els.sendStatus, text, kind); }

  // A value line: one place that decides the tint, so "unknown" never renders as
  // though it were a real answer.
  function value(el, text, tone) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'ivalue' + (tone ? ' ' + tone : '');
  }
  function strongValue(el, text, tone) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'ivalue strong' + (tone ? ' ' + tone : '');
  }
  function monoValue(el, text, tone) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'ivalue mono' + (tone ? ' ' + tone : '');
  }
  /**
   * A state line: a coloured dot, then a sentence.
   *
   * ── WHY THE GLYPH IS STRIPPED HERE ─────────────────────────────
   * THE DOT IS DRAWN BY CSS — `.tfstate::before` is a 7px disc that the tone
   * class recolours (green for ok, orange for warn, grey otherwise). Several call
   * sites ALSO began their text with a literal ● or ○, and the two mechanisms
   * are additive: the built artifact rendered "● ● Connected", two bullets side
   * by side, where both reference images show exactly one.
   *
   * Stripped centrally rather than at each call site, because there are seven of
   * them and a fix applied six times is a fix that comes back. The CSS disc is the
   * survivor for a concrete reason: a glyph baked into a string cannot be
   * recoloured by state, so the tone classes would have no visible effect on it.
   *
   * Screenshotting the built artifact is what found this. Every assertion in the
   * suite was green, because the markup and the stylesheet were each correct on
   * their own — the defect existed only in their sum.
   */
  function stateLine(el, text, tone) {
    var t = String(text == null ? '' : text).replace(/^[\u25cf\u25cb\u25cb\u25aa]\s*/, '');
    el.textContent = t;
    el.className = 'tfstate' + (tone ? ' ' + tone : '');
  }
  // The DESTINATION card's rows, which are `.v` rather than `.ivalue`.
  function destValue(el, text, extra) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'v' + (extra ? ' ' + extra : '') + (text ? '' : ' none');
  }

  /* ============================================================
     CONNECTION — a READING of what the server resolved.

     WHAT THIS SECTION USED TO BE
     ----------------------------
     Nine functions serving three inputs and a button: modeOf() /
     syncModeCards() / chooseMode() kept a Local-vs-Remote backend radio pair in
     step with a Base URL box, applySettings() / loadSettings() / saveSettings()
     persisted the address and the API key to chrome.storage.local on every
     keystroke, togglePeek() unmasked the key, onCodeInput() reformatted the
     Authorization Code as it was typed, and connect() redeemed that code through
     AB_INSPECTOR_PAIR.

     WHY ALL OF IT IS GONE
     ---------------------
     Every one of those values is something the SERVER already holds. It is the
     party that launched this browser, seeded this extension, and minted the
     target — so the address, the token and the binding are all known before the
     popup opens. Asking for them here inverted that: the user had to read a
     credential out of a dashboard and retype it into a browser that had been
     given it already.

     The backend context is now resolved inside background.js
     (inspectorContext()), from the bootstrap the server wrote, and the binding
     is made by the server when the crosshair is used — automatically for LOCAL,
     and on the user approving the Remote Approval prompt for REMOTE.

     So this file no longer HAS a connection procedure. It has one function that
     paints what the worker reports, and nothing on the panel it paints can be
     typed into.
     ============================================================ */

  /**
   * Re-read the state, on demand.
   *
   * All that survives of the old Connect button. It carries no credential and
   * takes no argument: the only reason a user presses anything on the Connection
   * tab now is to ask again after fixing something on the server side.
   */
  async function testConnection() {
    setStatus('Checking\u2026', 'warn');
    var r = await bg({ type: 'AB_CHECK' });
    if (r && r.ok) {
      // No identity is read out of this. It proves the resolved backend answers;
      // who the token belongs to is the backend's business.
      setStatus('Connected.', 'ok');
    } else {
      setStatus('Cannot reach the backend: ' + reason(r), 'bad');
    }
    // NOT quiet. This is the one refresh a human asked for by name -- the button
    // is titled "Re-read status", and a status re-read that prints nothing is
    // just a dead control. The quiet flag exists for the three refreshes that
    // ride along with something else (first paint, after a pick is sent, after
    // a release), where each already has its own message and a second one
    // would overwrite it. Collapsing Connect and Refresh into a single button
    // accidentally left this call on the quiet path, which made every branch of
    // refreshInspector's status block unreachable.
    await refreshInspector(false);
  }

  /**
   * A worker error, as something the user can act on.
   *
   * `no_base_url` / `no_api_key` are deliberately absent. They used to be the
   * two commonest answers here, and both meant "you have not filled the form
   * in" — a form that no longer exists, and a diagnosis that would now be
   * actively wrong: if the context cannot be resolved it is the SERVER's
   * bootstrap that is missing, which is not something the user can fix by
   * typing. background.js reports that case as `runtime_context_unavailable`.
   */
  function reason(r) {
    if (!r) return 'unknown';
    if (r.error === 'runtime_context_unavailable') {
      return 'the server has not provided a backend context to this browser yet';
    }
    return r.error || ('http_' + r.status) || 'unknown';
  }

  /**
   * Release the binding to the current field.
   *
   * Kept, unlike everything else on this panel, because it is the one action
   * whose meaning does not depend on a credential: a binding aimed at a field
   * the user has finished with is exactly the state in which the next pick lands
   * somewhere surprising. What changed is the follow-up — there is no code to
   * enter afterwards, so the message says how a target is really established.
   */
  async function unpairInspector() {
    await bg({ type: 'AB_INSPECTOR_UNPAIR' });
    setStatus('Released. Use the crosshair on a field in the project to target again.', '');
    await refreshInspector(true);
  }

  /* ============================================================
     THE TARGET FIELD — the one thing both tabs are about.

     `node_<nodeId>__<fieldKey>__<uniqueSuffix>` is the real destination. It is
     minted by the server, it is field-level rather than node-level, and it is
     NOT a session: changing session, or switching the browser between Local and
     Remote, leaves it valid.
     ============================================================ */

  // Name the destination the way the user chose it: the node, then the field. An
  // opaque `node_…__url__a1b2c3d4` is correct and useless — it names nothing the
  // user can match against what they are looking at in the project.
  function targetName(target) {
    if (!target) return '';
    if (target.label) return target.label;
    var node = target.nodeName || target.action || target.nodeId || 'node';
    var field = target.fieldName || target.fieldKey;
    return field ? node + ' \u2192 ' + field : node;
  }
  function nodeNameOf(t) { return (t && (t.nodeName || t.action || t.nodeId)) || ''; }
  function fieldNameOf(t) { return (t && (t.fieldName || t.fieldKey)) || ''; }

  // The live view of the destination, kept so the send path and the DESTINATION
  // card agree with the TARGET FIELD card without re-asking the backend.
  var current = { live: false, paired: false, nodeName: '', fieldName: '', fieldId: '' };

  // Destination and state come from the backend, never from a local guess: the
  // backend is the only thing that knows which fields are live and which of them
  // this extension may write to, and a wrong guess would be shown as fact.
  async function refreshInspector(quiet) {
    var res = await bg({ type: 'AB_INSPECTOR_SESSION' });

    // Three distinct states, because they need three different actions from the
    // user: connected (pick away), connected-to-something-now-gone (target it
    // again), and never connected (use the crosshair in the project). Collapsing
    // the middle one into "not connected" would hide the reason a pick just
    // started failing. None of the three asks for a code -- there is none.
    var paired = !!(res && res.targetFieldId);
    var live = !!(res && res.authorized && res.target);
    var target = (res && res.target) || null;

    paintTarget(paired, live, target, res);
    // Seeds the cached session; the AUTHORITATIVE paint happens after
    // paintEnvironment() below, once envState.current is settled. Called here
    // anyway so the card is never momentarily empty on a cold popup.
    paintConnection(res, paired, live, target);
    paintDestination();
    // The Browser Environment chooser — the FIRST step of Target This Field.
    // Painted from the same answer as everything else, so the card that shows as
    // chosen is the one the SERVER has on record. Awaited so a caller that
    // re-reads after choosing sees the settled state.
    await paintEnvironment(target, res);
    // AFTER paintEnvironment, never before: it is what settles envState.current,
    // and this form's visibility is a function of that. Painting first would show
    // (or hide) the REMOTE inputs based on the previous answer for one frame —
    // and on the frame where the operator has just switched environments, that is
    // exactly the frame they are looking at.
    paintAuthorization();
    // ── ORDER IS THE BUG, NOT AN OPTIMISATION ─────────────────────────
    // CONNECTION STATUS is now scoped to the chosen browser, and the thing that
    // settles which browser is chosen is paintEnvironment() — which runs above,
    // asynchronously, and only THEN assigns envState.current. Painting the card
    // before that point read the PREVIOUS environment every single time, so on the
    // very frame the operator switched to REMOTE the card still answered for
    // LOCAL and printed the loopback address as the remote backend.
    //
    // Repainted here with no argument, so it reuses the same session answer rather
    // than issuing a second request for a fact it already has.
    paintConnection(undefined, paired, live, target);

    if (!res || !res.ok) {
      value(els.inspNode, '', 'none');
      els.inspNodeRow.hidden = false;
      if (!quiet) setInspStatus(unreachableText(res), 'bad');
      return;
    }

    var data = res.data || {};

    // How many fields are open across the project, which is not the same
    // question as which one THIS extension is connected to. Both are shown
    // because "nothing is open" and "I am not connected to what is open" need
    // different fixes, and one line cannot say which applies.
    //
    // Hidden once a live target exists: the approved design shows the connected
    // Target Field card with nothing below its status line, and a count of other
    // open fields is noise at the moment the answer is "this one".
    var targets = data.targets || [];
    if (!targets.length) {
      // Names the real entry point. It used to say "press Connect Inspector on a
      // field", which was the button that minted an Authorization Code — a
      // control that no longer exists anywhere in the project.
      value(els.inspNode, 'no fields open \u2014 use the crosshair on a field', 'none');
    } else if (targets.length === 1) {
      value(els.inspNode, targetName(targets[0]));
    } else {
      value(els.inspNode, targets.length + ' fields open');
    }
    els.inspNodeRow.hidden = live;

    if (!quiet) {
      if (!targets.length) {
        setInspStatus('No field is waiting. Open a node in the project and use the crosshair on a field.', 'warn');
      } else if (!paired) {
        // The action is in the PROJECT, not in this popup. Saying "enter an
        // Authorization Code in Connection" sent the user to a tab that no longer
        // has anything to enter.
        setInspStatus('Not bound to a field yet \u2014 use the crosshair on the field in the project.', 'warn');
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
    // Not "Set the Base URL first" / "Set the API Key first" — there is nowhere
    // to set either, and telling the user to do the impossible is worse than
    // naming the real condition.
    if (err === 'runtime_context_unavailable') {
      return 'Waiting for the server to provide this browser with a backend context.';
    }
    return 'Cannot reach the project (' + err + ').';
  }

  // The Target Field card, painted identically on both tabs so the two never
  // disagree about where a pick would land.
  function paintTarget(paired, live, target, res) {
    var nodeName = nodeNameOf(target);
    var fieldName = fieldNameOf(target);
    var fieldId = (target && target.targetFieldId) || (res && res.targetFieldId) || '';

    current.live = live;
    current.paired = paired;
    current.nodeName = nodeName;
    current.fieldName = fieldName;
    current.fieldId = fieldId;

    strongValue(els.inspNodeName, nodeName, nodeName ? '' : 'none');
    strongValue(els.inspFieldName, fieldName, fieldName ? '' : 'none');
    monoValue(els.inspFieldId, fieldId, fieldId ? '' : 'none');
    strongValue(els.ctNode, nodeName, nodeName ? '' : 'none');
    strongValue(els.ctField, fieldName, fieldName ? '' : 'none');
    monoValue(els.ctFieldId, fieldId, fieldId ? '' : 'none');

    // ── Browser Environment ─────────────────────────────────────────────────
    //
    // Which browser the operator chose to target this field in, taken from the
    // SERVER's target record (background.js reads target.environment; the
    // extension never asserts it). That choice is made at the START of the
    // targeting flow in the web app, which is why there is no chooser here.
    //
    // Named in full — "Local Browser" / "Remote Browser" — rather than shown as
    // a bare "local"/"remote", because the Connection tab uses those same two
    // words for an unrelated fact: where the BACKEND lives. Spelling out
    // "Browser" is what stops the two being read as one setting.
    var env = (res && res.environment) || (target && target.environment) || '';
    var envText = env === 'local' ? 'Local Browser'
      : env === 'remote' ? 'Remote Browser' : '';
    value(els.inspEnv, envText, envText ? '' : 'none');
    value(els.ctEnv, envText, envText ? '' : 'none');

    // ── The durable binding ─────────────────────────────────────────────────
    //
    // Deliberately reported separately from "Connected", which tracks the
    // ADDRESS and therefore goes false every time the node is re-opened. This
    // line stays true across those re-opens, which is the whole substance of the
    // persistence requirement.
    //
    // It no longer promises "no code needed next time", because no code is ever
    // needed: LOCAL binds silently and REMOTE binds on an approval. What the
    // line reports is whether the binding is still in place — i.e. whether
    // returning to this field is a no-op or needs the crosshair again.
    var durable = !!(res && res.paired);
    // ── WHY THIS ROW STAYS A SENTENCE, AGAINST THE MOCKUP'S OWN TEXT ────
    // Both reference images print this row as a bare value — image 1 reads
    // `Active`, image 2 an em-dash — and I did transcribe them that way. That was
    // wrong, and the operator's own precedence rule is what makes it wrong:
    // Layout and card order come from the references, but «منطق فنی و State را از
    // اسپک قبلی بگیر، نه از متن‌های داخل Mockup» — and `Active` is a TEXT
    // inside the mockup, in direct contradiction with the final logic.
    //
    // The logic it contradicts is load-bearing. This row is the ONLY place that
    // reports the DURABLE pairing, which stays true across NDV re-opens while
    // "Connected" — which tracks the live ADDRESS — goes false on every one of
    // them. `Active` cannot carry that: it is indistinguishable from the address
    // being up, which is the exact misreading that made the operator ask for a
    // separate line. And when NOTHING is bound, an em-dash names no next action,
    // whereas the action that binds it differs by environment.
    //
    // So the row keeps its sentence. Its bullet stays too: `value()` renders
    // `.ivalue`, which — unlike `.tfstate` — has NO ::before disc, so this glyph
    // is the row's only dot and not a duplicate of a CSS one.
    var pairText = durable
      ? '\u25cf Bound \u2014 this field stays targeted'
      : env === 'remote'
        ? '\u25cb Not bound \u2014 approve the request in the project'
        : '\u25cb Not bound \u2014 use the crosshair on the field';
    value(els.ctPairing, pairText, durable ? 'ok' : 'none');

    // ── THE ADDRESS LINE, WHICH IS NOT THE PAIRING LINE ─────────────
    // This line reports the LIVE address; the BINDING row above reports the
    // DURABLE pairing. Keeping them separate is the entire point of the split, so
    // the stale case below must stay honest — "no longer open" — and must NOT
    // borrow the pairing's good news, or a re-opened node reads as fully wired.
    //
    // I briefly moved the pairing's environment-specific guidance onto this line
    // when the BINDING row went terse. That collapsed the two facts into one and
    // is reverted: `stays targeted` belongs to the pairing, `no longer open` to
    // the address, and neither may speak for the other.
    //
    // The leading glyphs here are stripped by stateLine(), because `.tfstate`
    // draws its own dot in CSS. They are kept in the strings only so each state
    // reads completely at its call site.
    var text = live
      ? '\u25cf Connected to this Field'
      : paired
        ? '\u25cf Bound, but that field is no longer open'
        : '\u25cb Not bound \u2014 target the field from the project';
    var tone = live ? 'ok' : paired ? 'warn' : 'none';
    stateLine(els.inspTarget, text, tone);

    // ── THIS LINE IS FOR THE NEWS THE PILL CANNOT CARRY ─────────
    // It used to read '\u25cf Connection active' whenever `live` was true, which is
    // the SAME fact the pill above already states, in the SAME card, two lines
    // apart — visible in the render as "Connection Active" at the top-right and
    // "Connection active" at the bottom-left. Both reference images print that
    // fact exactly once, in the pill.
    //
    // Blanked instead of reworded, because `.tfstate:empty` is display:none: when
    // there is nothing to add, the line is ABSENT rather than sitting there
    // paraphrasing the pill. That is what makes it legible when it does speak —
    // and it must still speak, so the stale case below is unchanged and stays
    // pinned by 'survives the address going stale' in popup-inspector-pairing.
    stateLine(els.ctState, live ? '' : text, live ? '' : tone);

    // ── THE HEADING'S OWN VERDICT ───────────────────────────────
    // The pill the supplied design puts at the top-right of this card. Driven by
    // `live` — the same boolean as the state line above — rather than by anything
    // of its own, because two independent readings of "is this connected" is
    // exactly how a heading ends up contradicting the rows beneath it.
    //
    // Blanked rather than reworded when nothing is bound: `.hdstate:empty` is
    // display:none, so the pill is absent instead of sitting there greyed out
    // claiming a connection that has never existed.
    els.ctLive.textContent = live ? 'Connection Active' : '';
    els.ctLive.className = 'hdstate' + (live ? ' ok' : '');

    // Release is offered whenever a binding exists, including a stale one:
    // clearing a binding that points at a closed field is a thing to be able to
    // do, not a dead end.
    els.inspUnpair.hidden = !paired;
  }

  /* ============================================================
     BROWSER ENVIRONMENT — THE LOCAL / REMOTE CHOOSER

     The FIRST step of Target This Field, restored here after being reported
     missing from this UI. The flow the correction specifies, in full:

         Target This Field
                 |
         Choose Browser Environment
                 |
         [ LOCAL BROWSER ] [ REMOTE BROWSER ]
                 |
         run that environment's flow

     WHAT EACH CARD DOES WHEN PRESSED
     --------------------------------
     LOCAL   POST /inspector/targeting/begin { environment: 'local' }. The server
             binds the field before it answers and reports runtime 'server-local'.
             No Base URL, no API key, no Authorization Code, no approval prompt —
             the connection is internal and automatic, and the worker stores the
             target the server returned.
     REMOTE  the same route with 'remote'. The server raises a Remote Approval
             prompt in the remote browser and returns it. The target is NOT
             stored here: it arrives when the human presses Allow, which is what
             binds that browser to THIS field and what allows an already-running
             remote browser to be reused for the next one.

     WHY THE OPTIONS ARE FETCHED RATHER THAN HARD-CODED
     --------------------------------------------------
     The two cards come from the server's own environmentOptions(), the same list
     the dashboard chooser renders. So an operator who has switched Local
     targeting off sees that card disabled WITH the server's reason, instead of
     pressing it and receiving a 409 — and this popup can never offer a browser
     the server would refuse.

     WHY RADIOS, AFTER ALL
     ---------------------
     This was a `<button>` pair, on the reasoning that "choosing registers a
     destination on the server, and a radio implies an inert setting". The
     reasoning was half right and the conclusion was wrong, for two reasons that
     only became visible once the control was actually on screen.

     First, the operator asked for a radio in so many words:

       «اصلا اینپوت ردیو کجاست که انتخاب کنم ریموت یا لوکالشو؟»

     Second — and this is the part the old comment had backwards — the choice
     genuinely DOES sit there. It is re-read from the server on every repaint and
     shown as the one in force, which is precisely the semantics of a radio group
     and precisely not those of a button. A button that stays visibly pressed
     forever is a radio denied the right markup, and the denial cost the control
     its keyboard behaviour: arrow-key movement within a group is free with radios
     and impossible with buttons.

     WHAT CHANGES BECAUSE OF THE TAG — each one a real defect found by switching:

       · `card.disabled` does not exist on a <label>. Setting it there was a
         silent no-op, so an unavailable browser stayed pressable. Unavailability
         now lives on the inner radio, which the browser itself refuses to check,
         plus `aria-disabled` on the label for assistive tech.
       · the handler must listen for `change` ON THE RADIO, not `click` on the
         label. A click listener works for the mouse and silently drops keyboard
         selection — the one capability the radio was adopted for.
       · `:disabled` / `:focus-visible` no longer match the label, so popup.css
         asks `:has(.envradio:checked)` / `:has(.envradio:focus-visible)` instead.
     ============================================================ */

  // Which environment the server has on record for the field, so a re-opened
  // popup shows the choice already in force rather than an unanswered question.
  var envState = { current: '', busy: false, nodeId: '', fieldKey: '', action: '', workflowId: '', authorization: null };

  function envCardEl(opt, chosen) {
    var isLocal = opt && opt.id === 'local';
    var available = !!(opt && opt.available);

    // A <label> wrapping a real radio, so the whole card is the hit target while
    // the browser — not this code — owns checking, un-checking the sibling and
    // arrow-key movement within the group.
    var card = document.createElement('label');
    card.className = 'envcard'
      + (available ? '' : ' is-off')
      + (chosen ? ' is-on' : '');
    // Read by the tests and by anything that needs to find a specific card
    // without matching on human-readable text.
    card.setAttribute('data-env', (opt && opt.id) || '');

    // THE CONTROL THE OPERATOR ASKED FOR, BY NAME:
    //   «اصلا اینپوت ردیو کجاست که انتخاب کنم ریموت یا لوکالشو؟»
    // One shared `name`, which is what makes the two mutually exclusive without a
    // single line of script.
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'abenv';
    radio.className = 'envradio';
    radio.value = (opt && opt.id) || '';
    radio.checked = !!chosen;
    // `disabled` belongs HERE and not on the label — see the block above.
    radio.disabled = !available;
    card.appendChild(radio);

    var name = document.createElement('span');
    name.className = 'envname';
    // Spelled with "Browser" on purpose: the Connection tab uses the bare words
    // "local"/"remote" for where the BACKEND is, and these two must not be read as
    // the same setting.
    name.textContent = isLocal ? 'Local Browser' : 'Remote Browser';
    card.appendChild(name);

    // ── LINE 2 OF THE SUPPLIED DESIGN: the readiness dot ────────────────
    // The mockups put a small green "● Ready" directly under each name. It answers
    // exactly one question — may this browser be chosen at all — and the answer is
    // the server's (`available`), never an assumption made here.
    var state = document.createElement('span');
    state.className = 'envstate ' + (available ? 'is-ok' : 'is-warn');
    state.textContent = available ? '\u25cf Ready' : '\u25cb Unavailable';
    card.appendChild(state);

    var desc = document.createElement('span');
    desc.className = 'envdesc';
    // ── THE WORDING FOLLOWS THE MEANING, NOT THE MOCKUP ───────────────
    // The supplied mockups print "Server browser" under REMOTE. That label is a
    // survivor of the inverted UI the operator themselves reported — «وقتی لوکال
    // می‌زنم باید مرورگر لوکال سرور بالا بیاد ولی برعکسه» — so copying it would
    // re-introduce the very bug that was fixed, and it contradicts the LOCAL card
    // beside it, which the same mockup labels "Connected automatically". Under the
    // ruling that followed, LOCAL is the browser ON THE SERVER (local to the
    // project) and REMOTE is a browser on the OPERATOR'S OWN machine.
    //
    // So the mockup's LAYOUT is followed exactly — name, dot, one sub-line — and
    // its LOCAL sub-line is kept verbatim in substance ("connected automatically"),
    // while REMOTE's names whose machine it actually is. Each line also carries
    // what the card will ASK OF THE OPERATOR, stated before it is chosen, so nobody
    // commits to a browser and is then surprised by a form.
    if (!available) {
      desc.textContent = opt && opt.note === 'local_disabled'
        ? 'The server browser is switched off for this instance.'
        : 'Not available right now.';
    } else if (isLocal) {
      // "connected automatically" is the mockup's own LOCAL sub-line and is kept.
      // The approval is appended because dropping it was a real regression: the
      // previous card said "Automatic \u2014 just approve it in that browser", and
      // LOCAL genuinely does wait for an in-page approval. Saying only
      // "automatically" would promise a binding that then silently waits, so the
      // one thing LOCAL asks of the operator would go unannounced. Driven off the
      // server's own flag rather than off `isLocal`, so if LOCAL ever stops
      // needing the approval this line stops claiming it.
      // Both halves are load-bearing and neither may be dropped:
      //   "nothing to enter"  → the credential surface is EMPTY. No Base URL, no
      //                          API key, no Authorization Code, ever.
      //   "just approve it"   → the one action LOCAL does ask for, stated up front
      //                          so the binding is not seen to hang unexplained.
      // Dropping the second half was a real regression; dropping the first would
      // read as though LOCAL might ask for a credential after all.
      desc.textContent = opt && opt.needsInPageApproval
        ? 'On the server \u2014 connects automatically, nothing to enter, just approve it there.'
        : 'On the server \u2014 connected automatically, nothing to enter.';
    } else {
      desc.textContent = 'Your own machine \u2014 needs a Base URL and a code.';
    }
    card.appendChild(desc);

    if (!available) {
      // The label cannot be disabled, so say so to assistive tech and leave the
      // refusal itself to the radio, which the browser will not check.
      card.setAttribute('aria-disabled', 'true');
    } else {
      radio.addEventListener('change', function () {
        if (radio.checked) chooseEnvironment(opt.id);
      });
    }
    return card;
  }

  /**
   * Render the LOCAL / REMOTE chooser.
   *
   * ALWAYS SHOWN. Choosing a browser is the FIRST step of targeting:
   *
   *   «وقتی کاربر روی آیکن Picker کنار یک Field کلیک می‌کند، پنجره‌ای نمایش داده
   *    می‌شود که کاربر می‌تواند انتخاب کند: Local Browser / Remote Browser»
   *
   * The previous rule — "hidden entirely when there is no field" — inverted
   * cause and effect. The choice is what PRODUCES a binding, so requiring a
   * binding before the choice may be seen makes it unreachable exactly when it
   * is needed, and the operator is left with one card reading `127.0.0.1:3000`
   * and no choice at all:
   *
   *   «توی تب کانکشن ها فقط یک بخش وجود داره که نوشته 127.0.0.1:3000 و هیچ حق
   *    انتخابی نذاشته برام که لوکال باشه یا ریموت»
   *
   * A field is still needed to REGISTER a destination, but that belongs to the
   * press, not to the render: pressing a card with nothing open reports what is
   * missing (see chooseEnvironment) instead of the card being absent with no
   * explanation. Visibility here is a UI-design decision and is deliberately NOT
   * a function of the Authorization logic — «Connection UI ≠ Authorization UI».
   */
  async function paintEnvironment(target, res) {
    // FALLING BACK TO THE OPEN FIELD IS THE WHOLE POINT, not a convenience.
    //
    // `target` is only non-null once this extension is already BOUND to a field
    // (background.js matches the stored ab_targetFieldId against the server's
    // list). But the moment the chooser is most needed is the moment BEFORE any
    // binding exists — the operator has opened a node in the project and now has
    // to say which browser will do the picking. Keying the chooser off `target`
    // alone would hide it exactly then, and leave the choice unreachable again.
    //
    // So when there is no binding, the single open field is used instead. Only
    // when there is exactly ONE: with several open, which of them a card press
    // should register is genuinely ambiguous, and guessing would bind a field the
    // operator never named.
    var t = target || null;
    if (!t) {
      // `res.targets`, NOT `res.data.targets`. inspectorSession() in
      // background.js copies the server's fields onto the response object
      // itself and never builds a `data` envelope, so the old path read
      // undefined every single time and the fallback below could never fire.
      // That is a second, independent reason the chooser stayed invisible — and
      // it survived because the popup suites only ever grepped the source text.
      var open = (res && res.targets) || [];
      if (open.length === 1) t = open[0];
    }
    var nodeId = (t && t.nodeId) || '';
    var fieldKey = (t && t.fieldKey) || '';

    // `|| envState.current` is load-bearing. With no field open there is nothing on
    // the server to read a choice back from, so a repaint blanked the radio the
    // operator had just ticked and the selection appeared to bounce back on its
    // own. Server truth still WINS wherever it exists — it is simply no longer
    // allowed to erase a local choice with an empty string.
    envState.current = (res && res.environment) || (t && t.environment) || envState.current || '';
    envState.nodeId = nodeId;
    envState.fieldKey = fieldKey;
    envState.action = (t && t.action) || '';
    envState.workflowId = (t && t.workflowId) || '';

    // The card stays visible whether or not a field is open. What CHANGES with
    // no field is only the sentence underneath: the cards still render, so the
    // operator can see the two browsers exist and which one is current.
    els.envCard.hidden = false;

    var opts = await bg({
      type: 'AB_TARGETING_OPTIONS',
      payload: { nodeId: nodeId, fieldKey: fieldKey, workflowId: envState.workflowId }
    });

    els.envGrid.textContent = '';
    var list = (opts && opts.options) || [];
    if (!opts || !opts.ok || !list.length) {
      // Never silently blank: an empty chooser is indistinguishable from a
      // chooser that failed to load, which is the very complaint being fixed.
      write(els.envStatus, (opts && opts.error) || 'Could not load the browser choices.', 'bad');
      return;
    }
    for (var i = 0; i < list.length; i++) {
      els.envGrid.appendChild(envCardEl(list[i], list[i].id === envState.current));
    }
    // Four sentences, because there are four genuinely different situations and
    // collapsing any two of them hides what the operator has to do next. The
    // no-field case is the one the old code could not express at all: it hid the
    // whole card instead, which reads as "this feature is missing" rather than
    // "target a field first".
    var msg;
    var kind;
    if (!nodeId || !fieldKey) {
      msg = 'No field is being targeted yet \u2014 use the crosshair on the field in the project.';
      kind = 'warn';
    } else if (envState.current === 'local') {
      msg = 'Targeting in the Local Browser.';
      kind = 'ok';
    } else if (envState.current === 'remote') {
      msg = 'Targeting in the Remote Browser.';
      kind = 'ok';
    } else {
      msg = 'Choose a browser to target this field in.';
      kind = '';
    }
    write(els.envStatus, msg, kind);
  }

  /**
   * The operator pressed a card.
   *
   * Delegates the whole decision to the server through the worker and then
   * re-reads the state, so what is displayed afterwards is the server's record
   * and never this popup's assumption about what it just asked for.
   */
  async function chooseEnvironment(env) {
    if (envState.busy) return;
    if (!envState.nodeId || !envState.fieldKey) {
      // ── A CHOICE WITH NO FIELD IS RECORDED, NOT REFUSED ──────────────
      // This used to `return` on the spot, which left the radios inert on a cold
      // popup: the operator could tick REMOTE and nothing whatsoever happened —
      // including the two inputs they were asking for.
      //
      // The rule being protected is real — NEVER bind a field the operator did not
      // name — and it is untouched: no AB_TARGETING_BEGIN is sent, so no
      // destination and no pairing is minted. What changes is that the choice is
      // remembered LOCALLY, which is enough to reveal the REMOTE form so the Base
      // URL and the code can be filled in up front, and to say what is still
      // missing instead of saying nothing at all.
      envState.current = env;
      paintAuthorization();
      // The CONNECTION STATUS card reports a DIFFERENT SUBJECT for each browser
      // (see paintConnection), so changing the browser changes what that card is
      // even about. Repainted from the cached session rather than by re-asking
      // the server: switching a radio is not a network event, and a card left
      // showing the other environment's answer is precisely how the project's own
      // loopback address came to be labelled as the remote backend.
      paintConnection(undefined, current.paired, current.live, null);
      write(els.envStatus, env === 'remote'
        ? 'Remote Browser selected. Fill in the connection below, then use the crosshair on the field in the project.'
        : 'Local Browser selected. Use the crosshair on the field in the project to target it.', 'warn');
      return;
    }
    envState.busy = true;
    write(els.envStatus, env === 'local'
      ? 'Opening the browser on the server\u2026'
      : 'Getting an authorization code\u2026', '');

    var res = await bg({
      type: 'AB_TARGETING_BEGIN',
      payload: {
        environment: env,
        nodeId: envState.nodeId,
        fieldKey: envState.fieldKey,
        action: envState.action,
        workflowId: envState.workflowId
      }
    });
    envState.busy = false;

    if (!res || !res.ok) {
      write(els.envStatus, (res && res.error) || 'That browser could not be selected.', 'bad');
      return;
    }

    // REMOTE hands back a code and an address. Keep them so the form below can
    // pre-fill the Base URL and show which field the code is for — the operator
    // should never have to retype something the server already told us.
    envState.authorization = (env === 'remote' && res.authorization) || null;

    // RE-READ FIRST, THEN REPORT — and the order is load-bearing.
    //
    // refreshInspector() re-paints every card from the server's answer, this
    // chooser included, which is what makes the card marked `is-on` the one the
    // SERVER has on record rather than the one this popup just asked for. But
    // that repaint also rewrites #envStatus with the steady-state line ("Choose
    // a browser…" / "Targeting in the …"). Reporting the outcome before the
    // refresh therefore published a message that was overwritten microseconds
    // later, and the operator saw no confirmation that their click did anything.
    await refreshInspector(true);

    if (env === 'local') {
      // The server opened (or reused) its own browser and raised a prompt there.
      // Answering it is the whole of the remaining work, and it happens in that
      // window, not this one.
      write(els.envStatus, res.consent
        ? 'Approve the request in the server\u2019s browser to bind this field.'
        : 'Connected to the target \u2014 ready to send.', res.consent ? 'warn' : 'ok');
    } else {
      // REMOTE. There is a real setup step here, and this popup is where it is
      // done — the operator is sitting in the very browser that needs pairing.
      write(els.envStatus, 'Enter the code below to connect this browser.', 'warn');
    }
  }

  /**
   * The REMOTE credential form: Base URL + Authorization Code.
   *
   * ── WHY THIS EXISTS, WHEN REMOVING IT WAS PREVIOUSLY CORRECT ───────────────
   * A previous revision deleted every credential control from this popup, and
   * for the browser it was thinking of that was right: the browser on the server
   * shares one machine with the server, so a code there is ceremony.
   *
   * But REMOTE is the other case, and it is a genuinely different situation:
   *
   *   «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند … پس ما هم به یک اتورایز
   *    نیاز داریم تا تایید بشه که فرد خودش است و هم به یک بیس یو ار ال»
   *
   * Two machines, no way for the server to reach in. So exactly two fields, and
   * ONLY on the REMOTE path:
   *
   *   Base URL             where this browser can reach the server. Pre-filled
   *                        from the server's own answer when it knows it, so it
   *                        is usually a confirmation rather than a typing job.
   *   Authorization Code   proof this operator is who they say. Minted per field,
   *                        which is what keeps a far-away browser following the
   *                        operator from field to field.
   *
   * There is deliberately NO API key box and NO password. Those were removed for
   * a reason that still holds — the extension already authenticates with its own
   * key — and this restores only the two things the two-machine case cannot do
   * without.
   */
  function paintAuthorization() {
    var auth = envState.authorization;

    // ── THE DEADLOCK THIS GATE USED TO CREATE ───────────────────────
    // The condition was `envState.current === 'remote' && !!auth`, i.e. the card
    // appeared only once the server had already handed back a code. But a code can
    // only come back from a request that REACHED the server, and Base URL is the
    // field that says where the server is. The one input needed to obtain the code
    // was hidden until the code arrived — a closed loop — so on a fresh install the
    // operator asked, correctly:
    //
    //   «کجاس فیلد اتورایزشن؟»  /  «این کجاشه فیلد های بخش ریموت؟»
    //
    // The gate is now the environment alone. `auth` still decides whether the hint
    // can name a field and whether Base URL can be pre-filled — it is enrichment,
    // never the price of admission.
    //
    // LOCAL IS UNCHANGED AND STAYS UNCHANGED: the whole card is hidden, so that
    // path has no authorization surface at all, ever. That is the invariant this
    // edit is most at risk of breaking, and it is asserted on directly.
    var showing = envState.current === 'remote';
    els.authCard.hidden = !showing;
    if (!showing) return;

    // Pre-fill rather than demand. The server resolved its own public address
    // (see PublicBaseUrl); asking the operator to retype it would invite a typo
    // in the one field that cannot be validated locally.
    // Null-safe now, because this runs before any code exists.
    if (auth && auth.baseUrl && !els.authBase.value) els.authBase.value = auth.baseUrl;

    var which = (auth && (auth.label || auth.fieldKey)) || '';
    write(els.authHint, which
      ? 'This code is for \u201c' + which + '\u201d.'
      : 'Get this code from your server \u2014 Target This Field \u2192 Remote Browser.', '');
  }

  /**
   * Fill the code box from the clipboard.
   *
   * A CONVENIENCE THAT IS ALSO A CORRECTNESS MEASURE. The code is single-use and
   * short-lived, so the only two outcomes of typing it by hand are "it worked"
   * and "it failed and I do not know whether I misread a character or the code
   * expired". Pasting removes the first of those two explanations entirely,
   * which is what makes the failure message believable when it does appear.
   *
   * Trimmed on the way in, because a value copied out of the dashboard's code
   * row frequently arrives with a trailing newline that is invisible in the box
   * and fatal to an exact-match comparison.
   *
   * DOES NOT SUBMIT. Paste puts the value where the operator can see it and
   * leaves Connect to them: a clipboard holding something else entirely would
   * otherwise spend a real attempt against a single-use code, and there is no
   * second one.
   */
  async function pasteAuthorization() {
    try {
      var text = await navigator.clipboard.readText();
      var code = String(text || '').trim();
      if (!code) { write(els.authStatus, 'Clipboard is empty.', 'warn'); return; }
      els.authCode.value = code;
      els.authCode.focus();
      write(els.authStatus, '', '');
    } catch (e) {
      // Clipboard read can be refused outright by permissions policy, and a
      // silent no-op on a pressed button is indistinguishable from a broken
      // one. Naming the fallback is the whole value of catching this.
      write(els.authStatus, 'Could not read the clipboard \u2014 paste into the box instead.', 'warn');
    }
  }

  async function submitAuthorization() {
    var code = String(els.authCode.value || '').trim();
    var base = String(els.authBase.value || '').trim();
    if (!code) { write(els.authStatus, 'Enter the authorization code.', 'warn'); return; }

    write(els.authStatus, 'Connecting\u2026', '');
    var res = await bg({ type: 'AB_INSPECTOR_PAIR', payload: { code: code, baseUrl: base } });

    if (!res || !res.ok) {
      write(els.authStatus, (res && res.error) || 'That code was not accepted.', 'bad');
      return;
    }

    // The code is single-use and now spent; leaving it on screen invites a
    // second attempt that can only fail.
    els.authCode.value = '';
    envState.authorization = null;
    await refreshInspector(true);
    write(els.authStatus, 'Connected \u2014 this browser is bound to the field.', 'ok');
  }

  /**
   * The last session answer, kept so the CONNECTION STATUS card can be repainted
   * when the *environment* changes without re-asking the server. The card reports
   * two different subjects depending on which browser is chosen, and switching
   * browsers is not a reason to go back over the network.
   */
  var lastSession = null;

  function paintConnection(res, paired, live, target) {
    if (res !== undefined) lastSession = res;
    res = lastSession;

    // ── WHOSE CONNECTION IS THIS CARD ABOUT? ─────────────────────────
    // It used to be about exactly one thing — the server this extension talks to
    // — and that was wrong for half of the panel's states. The session answer
    // below always comes from the SERVER-LOCAL context (see inspectorContext():
    // storage, then the seeded bootstrap, then loopback). It proves the PROJECT
    // is up. It says nothing whatever about a browser on the operator's own
    // machine.
    //
    // So under REMOTE the old code printed the project's own loopback address in
    // a row headed BACKEND, on a card headed CONNECTION STATUS, directly above
    // the empty Base URL box that the remote address is supposed to go in. The
    // report was exact:
    //
    //   «هیچ 127.0.0.1:3000 یا Backend Local نباید به‌عنوان Remote Backend
    //    نمایش داده شود.»
    //
    // Worse than unhelpful: it is FALSE, and it is false in the direction that
    // hides a misconfiguration. An operator who has not yet entered an address
    // reads "Connected — 127.0.0.1:3000" and concludes the remote browser is
    // wired up, when nothing remote exists at all.
    //
    // The row is therefore scoped to the environment it is true of:
    //
    //   LOCAL  — the server's own browser on the server's own loopback. The
    //            session answer IS the subject. Printed, as before.
    //   REMOTE — the operator's machine. The subject is whatever address they
    //            have given, and until they give one there is no answer to show.
    var isRemote = envState.current === 'remote';
    var typedBase = isRemote ? String((els.authBase && els.authBase.value) || '').trim() : '';

    // The REMOTE connection is real only once this browser is actually bound to a
    // field through it. `live` is that fact, and it comes from the server.
    var reachable = isRemote ? !!(res && res.ok && live) : !!(res && res.ok);
    var url = isRemote ? typedBase : ((res && res.baseUrl) || '');

    if (reachable) {
      stateLine(els.connState, '\u25cf Connected', 'ok');
      els.conn.textContent = '\u25cf online';
      els.conn.className = 'conn ok';
    } else if (isRemote) {
      // Named for what it is, and never as a failure: nothing has gone wrong
      // when an address has simply not been typed yet. «Connection UI ≠
      // Authorization UI» — showing the card is not a claim that a new
      // authorization is owed, so this line does not ask for one either.
      stateLine(els.connState, typedBase
        ? '\u25cb Not connected yet'
        : '\u25cb Waiting for a base URL', 'none');
      els.conn.textContent = '\u25cf offline';
      els.conn.className = 'conn bad';
    } else {
      stateLine(els.connState, '\u25cb ' + shortError(res), 'none');
      els.conn.textContent = '\u25cf offline';
      els.conn.className = 'conn bad';
    }
    // An em-dash, never a blank: a blank row is indistinguishable from a row that
    // failed to render, which is the same class of defect as printing a raw error
    // token where a sentence belongs.
    monoValue(els.connBackend, url, url ? '' : 'none');

    // "Reachable" and "may write to the field I am pointed at" are different
    // failures with different fixes, so they get different lines. A backend that
    // answers but refuses this field is the case that a single "Connected" would
    // hide until the first send failed.
    // FIELD ACCESS answers a different question from BACKEND — "may I write to the
    // field I am pointed at" rather than "can I reach the server" — which is why
    // it is a separate row. A backend that answers but refuses this field is the
    // case a single "Connected" would hide until the first send failed.
    if (isRemote && !typedBase) value(els.connAuth, '\u2014', 'none');
    else if (!reachable) value(els.connAuth, 'unknown', 'none');
    else if (live) value(els.connAuth, 'Allowed', 'ok');
    else if (paired) value(els.connAuth, 'Field no longer open', 'warn');
    else value(els.connAuth, 'No field bound yet', 'none');

    void target;
  }

  function shortError(res) {
    var err = (res && res.error) || 'unreachable';
    // 'No Base URL' / 'No API Key' are removed: both named a missing input, and
    // an absent context is now the server's to supply rather than the user's.
    if (err === 'runtime_context_unavailable') return 'Waiting for the server';
    return 'Not connected';
  }

  /* ============================================================
     THE PICK — SELECTED ELEMENT, ATTRIBUTES, DESTINATION.

     §16 / §23 — TWO INDEPENDENT STATES, deliberately not one.

       `display` is the set of ticked CHECKBOXES: which attributes the user wants
       to LOOK AT, in SELECTED ELEMENT.
       `sendKey` is the single selected RADIO: the one attribute whose value is
       actually SENT to the Target Field.

     Collapsing these into one collection is the obvious simplification and it is
     wrong: the user needs to compare several candidates on screen before
     committing to one, and "what I am reading" is not "what I am sending".
     Keeping them apart is also what makes the outbound value unambiguous — with
     a single set, sending would have to pick a winner by position, which is a
     rule nobody can see.
     ============================================================ */
  var pick = {
    element: null,   // the ab-inspect describeElement result
    rows: [],        // attributeRows, in panel order
    display: {},     // key -> true for ticked rows (VIEW ONLY)
    sendKey: ''      // the ONE key whose value is sent (§21)
  };

  function rowByKey(key) {
    for (var i = 0; i < pick.rows.length; i++) {
      if (pick.rows[i].key === key) return pick.rows[i];
    }
    return null;
  }

  /**
   * Load whatever content/inspector.js last picked.
   *
   * The picker writes BOTH states, so re-opening the popup shows the ticks and
   * the radio the user left in the page rather than resetting them — the popup
   * and the in-page panel are two views of one pick, not two pickers.
   */
  function applyPick(s) {
    var saved = s && s[PICK_KEY];
    if (!saved || !saved.element || !Array.isArray(saved.rows) || !saved.rows.length) {
      pick.element = null;
      pick.rows = [];
      pick.display = {};
      pick.sendKey = '';
      return;
    }
    pick.element = saved.element;
    pick.rows = saved.rows;
    pick.display = {};
    (saved.display || []).forEach(function (k) { pick.display[k] = true; });
    // A radio armed on a row that no longer exists, or that has no value, would
    // arm a guaranteed refusal. Dropped rather than carried.
    var armed = rowByKey(saved.sendKey || '');
    pick.sendKey = (armed && armed.value) ? armed.key : '';
  }

  async function loadPick() {
    applyPick(await get([PICK_KEY]));
  }

  async function savePick() {
    if (!pick.element) { await set({ ab_lastPick: null }); return; }
    await set({
      ab_lastPick: {
        element: pick.element,
        rows: pick.rows,
        // Stored in PANEL ORDER rather than object key order, so what is restored
        // matches what the user saw.
        display: pick.rows.filter(function (r) { return !!pick.display[r.key]; })
          .map(function (r) { return r.key; }),
        sendKey: pick.sendKey,
        at: Date.now()
      }
    });
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  /* ============================================================
     COPYING A VALUE — the same affordance the in-page picker has.

     «کپی کردن رو فقط برای باکس پیکر پیاده کردی ولی attributes در دو جا نمایش
      داده میشه ... حیفه اونجام هم ایکن کپی کردن رو نداره»

     Attributes are rendered in TWO places — the picker panel in the page, and
     this popup's Inspect tab — and only the first could copy. Which is the wrong
     way round for the commoner case: the popup is where a user lands after
     re-opening it to read a pick they took a minute ago, and a long selector
     shown there was un-copyable, so they had to re-pick just to get the text.

     Deliberately a re-implementation rather than a shared import: the picker
     lives in a closed shadow root inside an arbitrary page and this file is an
     extension page with its own CSP; they share no module scope, and a `lib/`
     round-trip for ~20 lines would add a load-order dependency to the popup's
     boot for no behavioural gain. What IS shared is the CONTRACT, asserted by
     tests on both sides: resolve-then-confirm, an execCommand fallback, and a
     per-row confirmation that reverts.
     ============================================================ */

  /** The ⧉ used on both surfaces, so the control reads the same in both. */
  var COPY_GLYPH = '\u29c9';

  /** Live confirmation timers, keyed by row, so two rows cannot cancel each other. */
  var copyTimers = {};

  /**
   * Put `text` on the clipboard, resolving true/false.
   *
   * Two paths, because one is not enough. `navigator.clipboard.writeText` needs a
   * secure context AND a focused document; an extension popup loses focus the
   * instant anything else is clicked, and then it REJECTS. The off-screen
   * textarea still works there.
   *
   * The node is removed in a `finally`: a stray textarea left in the popup steals
   * the next keystroke, and cleanup that only runs on success leaks precisely
   * when something already went wrong.
   */
  function writeClipboard(text) {
    var s = String(text == null ? '' : text);
    if (!s) return Promise.resolve(false);

    function legacy() {
      var ta = null;
      try {
        if (!document.body || typeof document.execCommand !== 'function') return false;
        ta = document.createElement('textarea');
        ta.value = s;
        // Off-screen, not display:none — a hidden field is not selectable, and a
        // visible one would flash across the panel.
        ta.setAttribute('style',
          'position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none;');
        ta.setAttribute('aria-hidden', 'true');
        document.body.appendChild(ta);
        if (ta.select) ta.select();
        if (ta.setSelectionRange) ta.setSelectionRange(0, s.length);
        return !!document.execCommand('copy');
      } catch (e) {
        return false;
      } finally {
        if (ta && ta.parentNode) {
          try { ta.parentNode.removeChild(ta); } catch (e2) { /* nothing to do */ }
        }
      }
    }

    try {
      var nav = (typeof navigator !== 'undefined') ? navigator : null;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        var p = nav.clipboard.writeText(s);
        if (p && p.then) {
          return p.then(function () { return true; }, function () { return legacy(); });
        }
        return Promise.resolve(true);
      }
    } catch (e) { /* fall through to the legacy path */ }

    return Promise.resolve(legacy());
  }

  /** The short-lived label on one copy button. */
  function flashCopy(key, button, glyph, title) {
    if (!button) return;
    button.textContent = glyph;
    button.title = title;
    if (button.classList) button.classList.add('done');

    // `hasOwnProperty`, not truthiness: a timer handle may legitimately be 0, and
    // a falsy-but-real handle would sail past an `if (timers[key])` guard and
    // leave a live timer behind to clear this label early.
    if (Object.prototype.hasOwnProperty.call(copyTimers, key)) {
      try { clearTimeout(copyTimers[key]); } catch (e) { /* not fatal */ }
      delete copyTimers[key];
    }
    copyTimers[key] = setTimeout(function () {
      delete copyTimers[key];
      // The button may have been discarded by a re-render (a new pick, a tick);
      // writing to a detached node is harmless, but the guard says so out loud.
      if (!button.isConnected && button.parentNode == null) return;
      button.textContent = COPY_GLYPH;
      button.title = 'Copy this value';
      if (button.classList) button.classList.remove('done');
    }, 1100);
  }

  /**
   * One copy button, for ONE row's value.
   *
   * `key` is captured in the closure, which is what makes it impossible for a
   * button to produce a different row's value after a re-render reorders things.
   *
   * The click is stopped from propagating because in ATTRIBUTES this button sits
   * in a row whose controls toggle DISPLAY and arm the SEND — an action for
   * READING a value must not change what the panel shows or what it will send.
   */
  function copyButton(key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp';
    b.textContent = COPY_GLYPH;
    b.title = 'Copy this value';
    // Named for its row: a column of identical glyphs is just "button, button,
    // button" to a screen reader otherwise.
    b.setAttribute('aria-label', 'Copy ' + key);
    b.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      var row = rowByKey(key);
      var text = row ? row.value : '';
      if (!text) {
        // A boolean attribute (`<ol reversed>`) has nothing to put on a
        // clipboard. Said on the button, because silently doing nothing reads as
        // the button being broken.
        flashCopy(key, b, '\u2014', 'No value to copy');
        return;
      }
      // Confirmed only AFTER the write resolves — a ✓ shown optimistically is a
      // lie on every origin where the clipboard is refused.
      writeClipboard(text).then(function (ok) {
        if (ok) flashCopy(key, b, '\u2713', 'Copied');
        else flashCopy(key, b, '!', 'Copy failed — select the value and press Ctrl+C');
      });
    });
    return b;
  }

  /**
   * SELECTED ELEMENT — §17: reflects the CHECKBOX state, and nothing else.
   *
   * It must NOT show every property automatically. Ticking `aria-label` makes it
   * appear; un-ticking `Class` makes it disappear; and that happens here, on
   * every change, rather than once at render time.
   */
  function renderSelected() {
    clear(els.selList);
    var shown = pick.rows.filter(function (r) { return !!pick.display[r.key]; });
    els.selEmpty.hidden = !!(pick.element && shown.length);
    if (!pick.element) {
      els.selEmpty.textContent = 'No element picked yet. Only checked properties appear here.';
      return;
    }
    if (!shown.length) {
      els.selEmpty.textContent = 'Nothing ticked. Check a row below to show it here.';
      return;
    }
    shown.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'kv';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = r.label || r.key;
      var v = document.createElement('span');
      // textContent, always: these strings are attribute values from an
      // arbitrary page, and one innerHTML with `<img onerror=…>` would give that
      // page script execution inside our UI.
      if (r.value) {
        v.className = 'v';
        v.textContent = r.value;
      } else {
        v.className = 'v none';
        v.textContent = '(not set)';
      }
      row.appendChild(k);
      row.appendChild(v);
      // Copyable here too: this is the section a user reads a ticked value OUT
      // of, so it is the likeliest place for them to want the text itself.
      row.appendChild(copyButton(r.key));
      els.selList.appendChild(row);
    });
  }

  /**
   * ATTRIBUTES — §11/§18: one row per property ACTUALLY discovered on the
   * selected element, each with the two controls:
   *
   *     [checkbox] [radio] name    value
   *
   * The rows come from lib/ab-inspect.js `attributeRows`, which is the same
   * function the in-page panel uses, so the two views can never disagree about
   * what the element carries.
   */
  function renderAttrs() {
    clear(els.attrList);
    var any = !!(pick.element && pick.rows.length);
    els.attrEmpty.hidden = any;
    els.attrTools.hidden = !any;
    if (!any) return;

    pick.rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'arow' + (pick.sendKey === r.key ? ' sending' : '');

      // ---- The checkbox: DISPLAY only. Ticking it sends nothing. -----------
      var cbWrap = document.createElement('label');
      cbWrap.className = 'ctl check';
      cbWrap.title = 'Show this property in Selected element';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!pick.display[r.key];
      var cbMark = document.createElement('span');
      cbMark.className = 'mark';
      cb.addEventListener('change', function () {
        if (cb.checked) pick.display[r.key] = true;
        else delete pick.display[r.key];
        // Deliberately does NOT touch pick.sendKey: un-ticking the row you are
        // sending would silently disarm the send, and the button would refuse for
        // a reason the user could not see.
        renderSelected();
        renderCount();
        savePick();
      });
      cbWrap.appendChild(cb);
      cbWrap.appendChild(cbMark);

      // ---- The radio: the ONE value that will be sent. ---------------------
      var rdWrap = document.createElement('label');
      rdWrap.className = 'ctl radio';
      var rd = document.createElement('input');
      rd.type = 'radio';
      // A shared name is what makes the browser enforce "exactly one" for us,
      // rather than us having to un-check siblings by hand.
      rd.name = 'ab-send';
      rd.checked = pick.sendKey === r.key;
      // A row with no value cannot be sent, so it cannot be armed either. §14
      // keeps genuinely absent attributes out of the list entirely; what reaches
      // here empty is a boolean attribute like `reversed`, which is worth SEEING
      // but has no value to deliver.
      rd.disabled = !r.value;
      rdWrap.title = r.value ? 'Send this value (only one)' : 'This property has no value to send';
      var rdMark = document.createElement('span');
      rdMark.className = 'mark';
      rd.addEventListener('change', function () {
        if (!rd.checked) return;
        pick.sendKey = r.key;
        // Choosing to send something implies wanting to see it, but the reverse
        // is not true — which is exactly why the two states differ.
        pick.display[r.key] = true;
        renderAttrs();
        renderSelected();
        paintDestination();
        renderCount();
        savePick();
      });
      rdWrap.appendChild(rd);
      rdWrap.appendChild(rdMark);

      var name = document.createElement('span');
      // data-* rows are tinted so a user scanning a long list can see at a glance
      // which values are the site's own data hooks.
      name.className = 'aname' + (r.group === 'data' ? ' data' : '');
      name.textContent = r.label || r.key;

      var val = document.createElement('span');
      if (r.value) {
        val.className = 'avalue';
        val.textContent = r.value;
        val.title = r.value;
      } else {
        val.className = 'avalue empty';
        val.textContent = '(not set)';
      }

      row.appendChild(cbWrap);
      row.appendChild(rdWrap);
      row.appendChild(name);
      row.appendChild(val);
      // The value column is `text-overflow: ellipsis`, so a long selector is
      // TRUNCATED on screen. Without this the full text was simply unreachable
      // from the popup — the one place it is most often needed.
      row.appendChild(copyButton(r.key));
      els.attrList.appendChild(row);
    });
    renderCount();
  }

  function renderCount() {
    var ticked = pick.rows.filter(function (r) { return !!pick.display[r.key]; }).length;
    els.attrCount.textContent = pick.rows.length
      ? ticked + ' of ' + pick.rows.length + ' shown'
      : '';
  }

  /**
   * §19 — Select all / Clear affect CHECKBOXES ONLY.
   *
   * They must not modify the Radio selection: the outbound value is a separate
   * decision, and a "clear" that silently disarmed the send would leave the
   * button refusing for an invisible reason.
   */
  function tickAll(on) {
    pick.display = {};
    if (on) pick.rows.forEach(function (r) { pick.display[r.key] = true; });
    renderAttrs();
    renderSelected();
    savePick();
  }

  /**
   * DESTINATION — §20: the authorized target, restated beside the value that is
   * about to travel to it.
   */
  function paintDestination() {
    destValue(els.destNode, current.nodeName);
    destValue(els.destField, current.fieldName);
    destValue(els.destFieldId, current.fieldId, 'mono');

    var row = rowByKey(pick.sendKey);
    destValue(els.destAttr, row ? (row.label || row.key) : '', 'accent');
    destValue(els.destValue, row ? row.value : '', 'mono wrap');

    if (!current.live) {
      stateLine(els.destState, current.paired
        ? '\u25cf Bound, but that field is no longer open'
        : '\u25cb Not bound \u2014 target the field from the project',
      current.paired ? 'warn' : 'none');
    } else if (!row) {
      stateLine(els.destState, 'Select one attribute to send.', 'none');
    } else {
      stateLine(els.destState, '\u25cf Connected to this Field', 'ok');
    }

    // §22: the send is refused BEFORE it is attempted whenever any of its
    // preconditions is missing, and the button says so by being disabled.
    els.sendAttr.disabled = !(current.live && row && row.value);
  }

  /* ----------------------------------------------------------
     SEND — §21: exactly ONE value goes out, and it is the radio's.

     The popup cannot talk to the project directly for the same reason the
     content script cannot: host permissions and CORS live in the background
     worker. It gets the payload; we surface what it reports back.
     ---------------------------------------------------------- */
  async function sendSelected() {
    if (!pick.element) { setSendStatus('Pick an element first.', 'bad'); return; }

    var row = rowByKey(pick.sendKey);
    if (!row) { setSendStatus('Select one attribute to send.', 'bad'); return; }
    if (!row.value) { setSendStatus('That attribute has no value to send \u2014 choose another.', 'bad'); return; }
    if (!current.live) {
      setSendStatus(current.paired
        ? 'The bound field is no longer open. Target it again from the project.'
        : 'This Inspector is not bound to a Field. Use the crosshair on the field in the project.', 'bad');
      return;
    }

    // Preserve PANEL ORDER rather than object key order, so what travels matches
    // what the user saw.
    var ordered = pick.rows
      .filter(function (r) { return !!pick.display[r.key]; })
      .map(function (r) { return r.key; });

    els.sendAttr.disabled = true;
    setSendStatus('Sending\u2026', '');

    var res = await bg({
      type: 'ab-inspector-submit',
      element: pick.element,
      // The ticked boxes: what the user is looking at. Carried so the project can
      // show the same view, but none of these becomes a value.
      displayAttributes: ordered,
      // The radio: the single value that lands in the Target Field. The server
      // re-derives it from the element, so this is advisory.
      sendAttribute: { name: row.key, value: row.value }
    });

    els.sendAttr.disabled = false;

    if (!res || !res.ok) {
      // The backend refuses with an actionable §27 reason ("this Inspector is not
      // authorized for that Field"). Showing it verbatim is the difference
      // between the user knowing to re-target the field from the project and the
      // user thinking it is broken.
      setSendStatus((res && (res.error || res.reason)) || 'Unable to send attribute. Retry the send operation.', 'bad');
      return;
    }

    // §24: name the FIELD, the attribute and the value — that is what proves the
    // value did not quietly go somewhere else.
    var where = res.field || current.fieldName || '';
    setSendStatus('\u2713 Sent' + (where ? ' to ' + where : '') +
      (res.attribute ? ' (' + res.attribute + ')' : '') + '.', 'ok');
    await refreshInspector(true);
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
  //
  // Most of the old Connection-tab listeners are still gone, and their absence is
  // still the point: the API key input, the show/hide eye, and the two backend
  // MODE cards that rewrote the Base URL for you. Those asked for facts the
  // server already holds.
  //
  // Two are back, on the REMOTE path only, because a browser on the operator's
  // own machine is the one case where the server cannot hand anything over —
  // there is a real network in between. So #authConnect submits, and Enter in
  // either input does the same thing, since a two-field form that ignores Enter
  // reads as broken to anyone who types the code rather than pasting it.
  els.authConnect.addEventListener('click', function () { submitAuthorization(); });
  els.authPaste.addEventListener('click', function () { pasteAuthorization(); });
  var authSubmitOnEnter = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitAuthorization(); }
  };
  // The one field the operator can set in REMOTE, and the BACKEND row is where
  // they confirm it took effect. Without this the address they typed had no
  // visible consequence anywhere on the panel until a connect attempt succeeded,
  // which made a typo indistinguishable from a refused code.
  els.authBase.addEventListener('input', function () {
    paintConnection(undefined, current.paired, current.live, null);
  });
  els.authBase.addEventListener('keydown', authSubmitOnEnter);
  els.authCode.addEventListener('keydown', authSubmitOnEnter);

  els.inspUnpair.addEventListener('click', unpairInspector);
  els.inspect.addEventListener('click', startInspector);
  // Refresh now does BOTH jobs the old pair of buttons did: re-read the target
  // AND re-probe the backend. They were only ever separate because one of them
  // was reached through Connect, and pressing Connect meant "try the credentials
  // I just typed". Nothing is typed now, so "ask again" is a single action.
  els.inspRefresh.addEventListener('click', function () { testConnection(); });
  els.attrAll.addEventListener('click', function () { tickAll(true); });
  els.attrNone.addEventListener('click', function () { tickAll(false); });
  els.sendAttr.addEventListener('click', sendSelected);

  /* ----------------------------------------------------------
     INIT

     Quiet on open: the popup should show its state, not a red error at a user who
     has nothing to act on.

     Only the last pick is read from storage now. `ab_baseUrl` and `ab_apiKey`
     were read here to fill the two inputs that no longer exist — and reading them
     into this page at all is worth NOT doing: the address and the token belong to
     the background worker, which is the only thing that makes requests with them.
     A popup that holds a copy of a token it never uses is a copy that can leak
     through a screenshot of an open dev-tools panel, for no benefit.

     Still ONE storage call, for the reason it always was: a popup is opened by a
     click and judged on whether it appears filled in or appears blank and then
     fills in.
     ---------------------------------------------------------- */
  get([PICK_KEY]).then(function (s) {
    applyPick(s);
    renderAttrs();
    renderSelected();
    return refreshInspector(true);
  });
})();
