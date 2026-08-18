/* ============================================================
   popup.js — the Element Inspector popup controller.

   WHAT THIS FILE IS
   -----------------
   One product with one job, and two tabs to match:

     INSPECT     — the Target Field, the picker, the picked element, its real
                   attributes, the destination, and the send
     CONNECTION  — READ-ONLY connection state, and Disconnect

   The presentation is the approved design in extension/UI_UX. The BEHAVIOUR is
   the corrected LOCAL/REMOTE contract:

     * the connection is INTERNAL and AUTOMATIC for BOTH environments. LOCAL
       BROWSER is the SERVER-LOCAL browser runtime — the browser runs on the
       same server/infrastructure as Plyr, which seeds this extension
       (bootstrap.config.js) with the loopback Base URL and its own token.
       No code is ever issued or typed; the server grants the binding and the
       worker adopts it (§8 still holds: the SERVER decides the field, never
       this popup)
     * REMOTE BROWSER is the same seeded copy inside the server-run Chromium
     * the same extension + the same Target Field never asks twice
     * Browser Environment, Session/Handoff and targetFieldId stay three
       separate concepts, and only the first and third are visible here
     * CHECKBOX = what appears in SELECTED ELEMENT (many)
       RADIO    = the ONE value that is sent (exactly one)

   WHAT DELIBERATELY DOES NOT EXIST
   --------------------------------
   No User ID field. Identity comes from backend authentication (the API key),
   and a user-typed identity would be a second, contradictable source of truth.
   §25: «There is NO: username, user ID, password, login form.»

   No session id. The destination is a real, server-minted Target Field —
   `node_<nodeId>__<fieldKey>__<uniqueSuffix>` — which survives session changes
   and Local/Remote switches precisely because it is not a session.

   No Browser Environment CHOOSER. That choice is the FIRST step of the targeting
   flow in the web app (public/js/targeting-flow.js → /inspector/targeting/*),
   not a setting in this popup. This popup only REPORTS which environment the
   server recorded for the field.

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

  // Where content/inspector.js leaves the last pick. Storage, not a message: the
  // popup is CLOSED at the moment of the pick, so there is nobody to message.
  var PICK_KEY = 'ab_lastPick';

  var $ = function (id) { return document.getElementById(id); };
  // Resolved eagerly, once, with no null guards — which is exactly why
  // popup-tabs.test.ts asserts every one of these ids exists in the document.
  // A single missing id throws here and blanks the whole popup.
  var els = {
    conn: $('conn'), status: $('status'),
    // ── Connection tab — READ-ONLY STATE ONLY. There are deliberately no
    //    credential ids here: no Base URL, no API Key, no Authorization Code,
    //    no mode chooser. «LOCAL UI نباید این موارد را داشته باشد … و کاربر
    //    نباید هیچ‌کدام را وارد کند.» popup-tabs.test.ts pins their ABSENCE.
    connState: $('connState'), connBackend: $('connBackend'), connAuth: $('connAuth'),
    ctNode: $('ctNode'), ctField: $('ctField'), ctFieldId: $('ctFieldId'),
    // Browser Environment and the durable pairing — the two facts the address
    // in ctFieldId cannot express. See paintTarget() for why both are needed.
    ctEnv: $('ctEnv'), ctPairing: $('ctPairing'),
    ctState: $('ctState'), inspUnpair: $('inspUnpair'),
    // ── Inspect tab: target
    inspNodeName: $('inspNodeName'), inspFieldName: $('inspFieldName'),
    inspFieldId: $('inspFieldId'), inspEnv: $('inspEnv'),
    inspTarget: $('inspTarget'), inspNode: $('inspNode'), inspNodeRow: $('inspNodeRow'),
    inspect: $('inspect'), inspRefresh: $('inspRefresh'), inspStatus: $('inspStatus'),
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
  function stateLine(el, text, tone) {
    el.textContent = text || '';
    el.className = 'tfstate' + (tone ? ' ' + tone : '');
  }
  // The DESTINATION card's rows, which are `.v` rather than `.ivalue`.
  function destValue(el, text, extra) {
    el.textContent = text == null || text === '' ? '\u2014' : String(text);
    el.className = 'v' + (extra ? ' ' + extra : '') + (text ? '' : ' none');
  }

  /* ============================================================
     CONNECTION — READ-ONLY STATE. There is nothing to type and no Connect
     button, because the connection is INTERNAL and AUTOMATIC:

       LOCAL BROWSER  = the SERVER-LOCAL browser runtime. The browser runs on
                        the SAME server/infrastructure as Plyr, which side-loads
                        this extension and seeds it (bootstrap.config.js) with
                        the loopback Base URL and its own token. Target This
                        Field → LOCAL BROWSER → the server grants the binding →
                        the worker adopts it (background.js inspectorSession) →
                        Connected to Target. No Base URL, no API Key, no
                        Authorization Code is ever asked for.
       REMOTE BROWSER = the same seeded copy, inside the server-run Chromium.

     What this tab shows is the RESULT of that: is it ready, and which Target
     Field is it bound to. The status is refreshed as the popup opens, not
     behind a button.
     ============================================================ */

  // Disconnected is the one ACTION left: it drops the server-side pairing (the
  // worker posts /inspector/targeting/unpair) so the automatic binding cannot
  // silently re-attach it, then clears the local copy.
  async function unpairInspector() {
    setStatus('Disconnecting\u2026', 'warn');
    await bg({ type: 'AB_INSPECTOR_UNPAIR' });
    setStatus('Disconnected.', '');
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
    // user: connected (pick away), connected-to-something-now-gone (re-connect),
    // and never connected (enter a code). Collapsing the middle one into "not
    // connected" would hide the reason a pick just started failing.
    var paired = !!(res && res.targetFieldId);
    var live = !!(res && res.authorized && res.target);
    var target = (res && res.target) || null;

    paintTarget(paired, live, target, res);
    paintConnection(res, paired, live, target);
    paintDestination();

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
      value(els.inspNode, 'no fields open \u2014 press Connect Inspector on a field', 'none');
    } else if (targets.length === 1) {
      value(els.inspNode, targetName(targets[0]));
    } else {
      value(els.inspNode, targets.length + ' fields open');
    }
    els.inspNodeRow.hidden = live;

    if (!quiet) {
      if (!targets.length) {
        setInspStatus('No field is waiting. Open a node in the project, then connect.', 'warn');
      } else if (!paired) {
        // No code, no credential: the connection is automatic. The only thing
        // the user can do from here is start it — Target This Field in the app.
        setInspStatus('Not connected yet \u2014 press Target This Field in the project.', 'warn');
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
    // There is no Base URL or API Key field to point at anymore — those are
    // seeded by the server runtime (bootstrap.config.js). If they are missing,
    // this is a hand-installed copy, and the fix is the server-seeded copy.
    if (err === 'no_base_url' || err === 'no_api_key') return 'Waiting for the server runtime to seed this extension.';
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
    var envText = env === 'local' ? 'LOCAL BROWSER'
      : env === 'remote' ? 'REMOTE BROWSER' : '';
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
    // A REMOTE field shows "not required" rather than "paired": no code was ever
    // issued for it, and claiming a pairing that does not exist would be as
    // misleading as hiding one that does.
    // "Ready to Send" — no code is ever requested, so the answer to "will I be
    // asked for anything?" is always no. The durable pairing still outlives the
    // address: re-opening the node re-mints the address and the server re-points
    // the same pairing at it, which is why the same field never asks twice.
    var durable = !!(res && res.paired);
    var pairText = durable
      ? '\u25cf Ready to Send'
      : env === 'remote'
        ? 'Not required for Remote Browser'
        : '\u25cb Not connected to a target yet';
    value(els.ctPairing, pairText, durable ? 'ok' : env === 'remote' ? '' : 'none');

    var text = live
      ? '\u25cf Connected to Target'
      : paired
        ? '\u25cf Connected, but that field is no longer open'
        : '\u25cb Not connected to a target yet';
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
    // The Backend row is READ-ONLY and reported by the worker — the popup holds
    // no settings of its own anymore.
    var url = (res && res.baseUrl) || '';

    if (reachable) {
      // The headline the contract asks for: «LOCAL BROWSER ● Ready» / «●
      // Connected». Automatic is not a state the user can toggle, it is the
      // way the connection is made — so that is what the line says.
      stateLine(els.connState, live ? '\u25cf Connected' : '\u25cf Ready \u2014 automatic', 'ok');
      els.conn.textContent = '\u25cf online';
      els.conn.className = 'conn ok';
    } else {
      stateLine(els.connState, '\u25cb ' + shortError(res), 'none');
      els.conn.textContent = '\u25cf offline';
      els.conn.className = 'conn bad';
    }
    monoValue(els.connBackend, url, url ? '' : 'none');

    // "Reachable" and "bound to the field I am pointed at" are different
    // states, so they get different lines. Authorization is internal now — the
    // server granted the binding and the worker adopted it — so a live target
    // reads "Internal", never "enter a key".
    if (!reachable) value(els.connAuth, 'unknown', 'none');
    else if (live) value(els.connAuth, 'Internal \u2014 granted', 'ok');
    else if (paired) value(els.connAuth, 'Field no longer open', 'warn');
    else value(els.connAuth, 'Waiting for a Target Field', 'none');

    void target;
  }

  function shortError(res) {
    var err = (res && res.error) || 'unreachable';
    // A hand-installed copy with no seeded context and no saved settings is the
    // only way these fire, and there is no field here to fix them in — the fix
    // is the server-seeded copy. Say that, not "set the Base URL".
    if (err === 'no_base_url' || err === 'no_api_key') return 'Waiting for the server runtime';
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
        ? '\u25cf Connected, but that field is no longer open'
        : '\u25cb Not connected to a target yet',
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
        ? 'The connected field is no longer open. Target it again from the project.'
        : 'This Inspector is not connected to a Field. Press Target This Field in the project first.', 'bad');
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
      // between the user knowing to re-target the field and the user
      // thinking it is broken.
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
  els.inspUnpair.addEventListener('click', unpairInspector);
  els.inspect.addEventListener('click', startInspector);
  els.inspRefresh.addEventListener('click', function () { refreshInspector(false); });
  els.attrAll.addEventListener('click', function () { tickAll(true); });
  els.attrNone.addEventListener('click', function () { tickAll(false); });
  els.sendAttr.addEventListener('click', sendSelected);

  /* ----------------------------------------------------------
     INIT

     Quiet on open: an unconfigured extension should show its state, not a red
     error the user cannot yet act on.

     Settings and the last pick are read in ONE storage call rather than two.
     They are independent facts, so the obvious shape is two awaits — but a popup
     is opened by a click and judged on whether it appears filled in or appears
     blank and then fills in. Every extra round trip to storage before the first
     paint is a frame the user spends looking at dashes. One read also means the
     two cannot land in either order, so there is no window where the attribute
     rows are on screen and the destination they would be sent to is not.
     ---------------------------------------------------------- */
  get([PICK_KEY]).then(function (s) {
    applyPick(s);
    renderAttrs();
    renderSelected();
    // Quiet on open: the state appears as the runtime reports it, with no red
    // error and no credential prompt — there is nothing to configure.
    return refreshInspector(true);
  });
})();
