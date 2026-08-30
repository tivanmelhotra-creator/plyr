/* ============================================================
   consent.js — the "connect this browser to which field?" prompt.

   WHY THIS FILE EXISTS
   --------------------
   Reported: choosing REMOTE and skipping the Authorization Code left the picker
   unable to deliver anything —

     «فرق نداره چه لوکال رو انتخاب کنم یا ریموت رو انتخاب کنم اگر کد اتورایز رو
      وارد نکنم … ظاهرا نمدونه به کدوم فیلد باید ارسال بشه»
     Connection failed: network

   The browser that opens ON THE SERVER is, to this extension, an ordinary LOCAL
   browser: same code, same storage, and a submit addressed with
   `ab_targetFieldId`. The only writer of that value was redeeming a code — and
   REMOTE never issues one, by requirement. The server granted a binding; nothing
   ever told this side WHICH field it was for.

   THE FIX, IN THE OPERATOR'S OWN WORDS
   ------------------------------------
     «موقعی که کاربر مرورگر روی سرور بالا اومد توی همون صفحه مرورگر یه الرت بالا
      بیاد و از کاربر اجازه اتصال به نود/فیلد رو بگیره و وقتی کاربر اجازه داد
      پلاگین خودش کد اتواریزش جایگزین میشه و اتصالشو اکتیو میکنه»

   So: a prompt, in this page, naming the node and the field, with Allow and
   Deny. Allow is what stores the target — it replaces the code, it does not
   supplement it.

   AND THE REPEAT CASE
   -------------------
     «اگر حتی مرورگر بالا موند و فیلد عوض شد … مرورگر مجدد بالا نمیاد و فقط الرت
      بالا میاد در دفعات تکراری و توی اون الرت میگه که چه نودی، چه فیلدی تا کاربر
      با این اعلان مطمعن بشه که سیستم درست کار میکنه»

   That is why this polls instead of rendering once. The browser stays open, the
   operator opens a second node, and a NEW question appears in the page they are
   already looking at. Naming the node and field in every prompt is the point:
   it is how the operator confirms the system is aiming where they think.

   WHY THE PROMPT CANNOT JUST AUTO-ACCEPT
   --------------------------------------
   With two nodes open there is no single "current" target, so adopting the most
   recent one silently would land a pick in the node the operator is no longer
   looking at, WITH a success message — worse than the refusal it replaces,
   because a refusal is visible. The server therefore withholds the address until
   a human answers, and this file never sees a targetFieldId until then.

   WHY IT IS SCOPED TO REMOTE ONLY
   -------------------------------
   Reported afterwards: this Alert appeared in the operator's OWN Chrome during a
   LOCAL session, minutes after they had already authorized with a code. The
   contract it violated is:

     LOCAL  = API Key + Authorization Code      -> NO Remote Approval Alert
     REMOTE = no API Key, no Authorization Code -> Remote Approval Alert

   Three things combined to cause it, and the fix had to address the one that is
   actually this file's fault:

     1. manifest.json injects this script into EVERY http/https page, so it also
        runs in the user's personal Chrome. (Correct — the remote browser visits
        arbitrary pages, so the prompt must be able to appear on any of them.)
     2. GET /inspector/consent could only scope by account, and two browsers
        signed into the same account look identical to it. (Fixed server-side:
        prompts now carry an environment and are filtered.)
     3. THIS poll loop had no environment gate and rendered every prompt handed
        to it. That is the defect here.

   So the loop now asks which browser it is in FIRST and, in a local browser,
   never starts. The prompt itself is unchanged and is NOT removed: it remains
   exactly the mechanism REMOTE depends on, since REMOTE deliberately has no code
   to type. It is only prevented from appearing where it has no meaning.

   The delay in the report — "minutes later" — was POLL_MS/POLL_MS_IDLE backoff
   plus the visibilitychange pause below, playing against the server's 5-minute
   consent TTL: a prompt stayed claimable long after the operator had moved on,
   and surfaced whenever some background tab next became visible. Not starting
   the loop removes that whole window rather than shortening it.

   RENDERING RULES
   ---------------
   Closed shadow root, `all:initial`, textContent only — never innerHTML. This
   panel draws untrusted-ish strings (a node label the operator typed) onto an
   arbitrary third-party page, and it must be immune both to that page's CSS and
   to markup in its own inputs.
   ============================================================ */
'use strict';

(function () {
  if (!document || !document.documentElement) return;
  if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) return;

  var HOST_ID = 'ab-consent-host';

  // How often to ask. 4s is a compromise: fast enough that pressing the picker
  // in the dashboard feels like it opened a prompt here, slow enough that an
  // idle server browser is not making 20 requests a minute forever.
  var POLL_MS = 4000;

  // Backs off when the extension is not configured or the server is unreachable,
  // so a browser parked on a page with no backend does not poll a dead endpoint
  // at full rate for hours.
  var POLL_MS_IDLE = 20000;

  var state = {
    shadow: null,
    list: null,
    // consentId -> true, for prompts already on screen. Keyed on the id so the
    // server refreshing a prompt (same field, new address) replaces rather than
    // duplicates — see `reused` in RemoteTargetConsent.request().
    shown: {},
    timer: null,
    stopped: false,
    // Has the environment gate at the bottom of this file confirmed that this is
    // the SERVER's own browser (environment 'local')?
    //
    // Starts false and is the ONLY thing that may set it true. It exists because
    // the gate is asynchronous (a sendMessage round-trip) while the
    // visibilitychange listener is not: a tab that loads hidden and is revealed
    // before the gate answers would otherwise find `stopped === false` and
    // `timer === null` and start polling — reintroducing the Alert in the
    // operator's OWN browser through the exact timing path that made the
    // original report say "minutes later". `stopped` cannot serve this purpose
    // because "not yet decided" and "decided: not ours" must not look the same.
    armed: false,
  };

  /* ----------------------------------------------------------
     THE PANEL
     ---------------------------------------------------------- */

  function ensurePanel() {
    if (state.shadow) return state.shadow;

    var host = document.createElement('div');
    host.id = HOST_ID;
    // `all:initial` on the host too: a page with `div{position:absolute}` would
    // otherwise drag the whole prompt off-screen.
    host.setAttribute('style', 'all:initial;position:static;');

    var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    if (!shadow) return null;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      // Top-centre, not a corner. The operator's eyes are on the page they were
      // sent to inspect, and a corner toast is the classic thing people miss —
      // then report as "it did nothing".
      '.wrap{position:fixed;top:16px;left:50%;transform:translateX(-50%);',
      'z-index:2147483647;display:flex;flex-direction:column;gap:8px;',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
      'max-width:min(520px,calc(100vw - 32px))}',
      '.card{background:#1e1e22;color:#f4f4f5;border:1px solid #3a3a40;',
      'border-left:3px solid #ff6600;border-radius:8px;padding:12px 14px;',
      'box-shadow:0 8px 28px rgba(0,0,0,.45);box-sizing:border-box}',
      '.q{font-size:13px;line-height:1.45;margin:0 0 4px}',
      // The node and field are the whole reason the prompt exists, so they are
      // the most legible thing in it.
      '.what{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      'font-size:12px;color:#ffb27a;word-break:break-all;margin:0 0 10px}',
      '.meta{font-size:11px;color:#a1a1aa;margin:0 0 10px}',
      '.row{display:flex;gap:8px;flex-wrap:wrap}',
      'button{font:inherit;font-size:12px;padding:6px 14px;border-radius:6px;',
      'border:1px solid #52525b;background:#2a2a30;color:#f4f4f5;cursor:pointer}',
      'button:hover{background:#35353c}',
      '.ok{background:#ff6600;border-color:#ff6600;color:#1a1a1a;font-weight:600}',
      '.ok:hover{background:#ff7a1f}',
      'button[disabled]{opacity:.55;cursor:default}',
      '.msg{font-size:11px;margin:8px 0 0}',
      '.msg.ok{color:#4ade80}',
      '.msg.err{color:#f87171}',
    ].join('');

    var list = document.createElement('div');
    list.className = 'wrap';

    shadow.appendChild(style);
    shadow.appendChild(list);
    document.documentElement.appendChild(host);

    state.shadow = shadow;
    state.list = list;
    return shadow;
  }

  /** A human sentence for "Click → Selector on node search-box". */
  function describe(req) {
    var node = req.label || req.nodeId || 'a node';
    var field = req.fieldKey || 'a field';
    var action = req.action ? (' (' + req.action + ')') : '';
    return node + action + '  →  ' + field;
  }

  function render(req) {
    if (!ensurePanel()) return;
    if (state.shown[req.consentId]) return;
    state.shown[req.consentId] = true;

    var card = document.createElement('div');
    card.className = 'card';

    var q = document.createElement('p');
    q.className = 'q';
    // textContent, always. A node label is operator-supplied text.
    q.textContent = 'Connect this browser to a field?';

    var what = document.createElement('p');
    what.className = 'what';
    what.textContent = describe(req);

    var meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = 'The next element you pick will be sent to this field.';

    var row = document.createElement('div');
    row.className = 'row';

    var allow = document.createElement('button');
    allow.className = 'ok';
    allow.textContent = 'Allow';

    var deny = document.createElement('button');
    deny.textContent = 'Not now';

    var msg = document.createElement('p');
    msg.className = 'msg';

    function answer(approve) {
      allow.disabled = true;
      deny.disabled = true;
      msg.className = 'msg';
      msg.textContent = approve ? 'Connecting\u2026' : 'Declining\u2026';

      chrome.runtime.sendMessage(
        { type: 'AB_CONSENT_DECIDE', payload: { consentId: req.consentId, approve: approve } },
        function (res) {
          var err = chrome.runtime.lastError;
          if (err || !res || !res.ok) {
            // Re-enable: a failed answer must stay answerable, otherwise a
            // transient network blip strands the prompt and the operator is back
            // to "it did nothing".
            allow.disabled = false;
            deny.disabled = false;
            msg.className = 'msg err';
            msg.textContent = (err && err.message)
              || (res && (res.error || res.reason))
              || 'Could not answer. Try again.';
            return;
          }

          if (res.approved) {
            msg.className = 'msg ok';
            // Names the field again in the confirmation, on purpose:
            // «تا کاربر با این اعلان مطمعن بشه که سیستم درست کار میکنه».
            msg.textContent = 'Connected \u2014 picks now go to ' + describe(req);
            dismiss(card, 2600);
          } else {
            msg.className = 'msg';
            msg.textContent = 'Declined. Nothing was connected.';
            dismiss(card, 1800);
          }
        }
      );
    }

    allow.addEventListener('click', function () { answer(true); });
    deny.addEventListener('click', function () { answer(false); });

    row.appendChild(allow);
    row.appendChild(deny);
    card.appendChild(q);
    card.appendChild(what);
    card.appendChild(meta);
    card.appendChild(row);
    card.appendChild(msg);
    state.list.appendChild(card);
  }

  function dismiss(card, delay) {
    setTimeout(function () {
      if (card && card.parentNode) card.parentNode.removeChild(card);
    }, delay);
  }

  /* ----------------------------------------------------------
     THE POLL
     ---------------------------------------------------------- */

  function poll() {
    if (state.stopped) return;

    chrome.runtime.sendMessage({ type: 'AB_CONSENT_LIST' }, function (res) {
      var wait = POLL_MS;
      var err = chrome.runtime.lastError;

      if (err) {
        // The service worker was asleep or the extension was reloaded. Not an
        // error worth showing anyone; just ask again later.
        wait = POLL_MS_IDLE;
      } else if (!res || !res.ok) {
        // Unconfigured (no base URL / no key) or the server refused. Back off
        // rather than hammering.
        wait = POLL_MS_IDLE;
      } else {
        var requests = res.requests || [];
        for (var i = 0; i < requests.length; i++) {
          if (requests[i] && requests[i].consentId) render(requests[i]);
        }
      }

      state.timer = setTimeout(poll, wait);
    });
  }

  // A tab that is not visible is not a tab anyone can answer a prompt in, and
  // the server expires prompts on its own. Pausing while hidden keeps a parked
  // background tab from polling forever.
  //
  // `state.armed` is checked as well as `state.stopped`: becoming visible must
  // not be able to START the loop in a browser the gate has not yet cleared as
  // REMOTE (see the comment on `armed`).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    } else if (state.armed && !state.timer && !state.stopped) {
      poll();
    }
  });

  /* ----------------------------------------------------------
     THE ENVIRONMENT GATE

     Nothing above this point has run any network traffic or drawn anything: the
     poll is what starts the whole mechanism, so gating its START is what scopes
     the Alert to REMOTE.

     Asked once per page load rather than re-checked each tick. The answer is a
     property of WHICH BROWSER this is, which cannot change while a page is
     loaded — re-asking every 4 seconds would add a message round-trip per tick
     for a value that is fixed.

     Any failure to get an answer means NO POLLING. If the service worker is
     asleep, the extension was just reloaded, or the message errors, the safe
     result is silence: a missing prompt in a remote browser is recoverable from
     the dashboard, whereas a prompt in a local browser is the reported bug. The
     next page load asks again, so this is not a permanent state.
     ---------------------------------------------------------- */
  try {
    chrome.runtime.sendMessage({ type: 'AB_ENVIRONMENT' }, function (res) {
      var err = chrome.runtime.lastError;
      if (err || !res || !res.ok || res.environment !== 'local') {
        // ── THE COMPARISON THAT WAS INVERTED ──────────────────────────────
        //
        // REPORTED: «در حالت لوکال هیچ الرتی نیومد … ارتباط رو کانکت زده بود در
        // حالت لوکال پیش‌فرض ولی هیچ الرتی نمیومد و … اسم نود و فیلد هم خالی
        // بودند».
        //
        // This read `!== 'remote'`, so it started the poll ONLY in a browser
        // that answered 'remote'. But `consentList()` in background.js — the
        // very function this poll calls — returns an empty list unless the
        // environment is 'local', and the server stamps every LOCAL consent
        // with `environment: 'local'` and filters on it. So the two gates were
        // exact opposites and could never both pass: in the server's browser
        // this file refused to poll, and in the operator's own browser the poll
        // was answered with nothing. The Alert was unreachable in every
        // environment, which is precisely what was observed.
        //
        // WHICH ONE WAS WRONG IS NOT A COIN FLIP. The prompt belongs to the
        // SERVER's browser and nowhere else:
        //   - it is the single shared window that outlives one targeting run, so
        //     it is the only browser that can be holding a previous field's
        //     address and therefore the only one that has to be asked;
        //   - REMOTE acquires its target by redeeming a code that named exactly
        //     one field, so there is nothing left to ask there;
        //   - browserEnvironment() answers 'local' for exactly the browser the
        //     server launched (AB_BOOTSTRAP.managed === true).
        // The server, background.js and this file now all agree on 'local'.
        //
        // Any failure to get an answer still means NO POLLING: an unanswerable
        // gate is treated as "not ours", so a missing prompt stays recoverable
        // from the dashboard rather than a prompt appearing where it has no
        // meaning.
        state.stopped = true;
        return;
      }
      // Confirmed to be the server's own browser: only now may the loop run,
      // here or from the visibilitychange listener above.
      state.armed = true;
      if (!document.hidden) poll();
    });
  } catch (e) {
    // Never let this take down the sibling content scripts in the same bundle.
    state.stopped = true;
  }
})();
