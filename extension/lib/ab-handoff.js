/* ============================================================
   ab-handoff.js — the Local half of the Remote ⇄ Local handoff.

   WHAT THIS DOES
   --------------
   The user pressed "Switch to Local" in the app. The server froze what their
   remote browser was showing — tab URLs in order, which tab was in front, and
   the cookies that make those tabs logged in — and showed them a pairing code.
   This file is what turns that into their own Chrome actually showing it:

       pairWithCode()  code  ->  session token (stored)
       applyHandoff()  token ->  tabs opened, in order, right one focused
                                 then tells the server the switch is complete

   WHY A PAIRING CODE AND NOT THE API KEY
   --------------------------------------
   The API key grants full control of the whole instance. An extension is the
   most-attacked surface on a user's machine, and anything in chrome.storage is
   reachable by a compromised extension update. A pairing code is single-use,
   expires in five minutes, and is scoped to one session — so the worst case is
   one session instead of the entire server. The token we store in its place is
   revocable on its own.

   WHY THE SERVER IS TOLD LAST
   ---------------------------
   `applyHandoff` opens the tabs FIRST and only then calls /handoff/complete.
   The mode flip lives on the server side of that call, so until the tabs really
   exist the user stays in a mode that works. Reversing the order would mean a
   user whose restore failed halfway is now "in local mode" with a browser that
   never opened their pages — the exact broken state this ordering prevents.

   NOTE ON COOKIES
   ---------------
   We do NOT try to inject cookies via chrome.cookies: that would need a much
   broader permission set than this extension asks for, and HttpOnly cookies for
   sites the browser has not visited cannot be set meaningfully anyway. Instead
   the server reports `limits.storage_unavailable` and the popup says plainly
   that some sites may need signing in again. Overpromising here would be worse
   than the limitation itself.
   ============================================================ */
'use strict';

/* global chrome, ABCore */

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ABHandoff = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var core = (typeof ABCore !== 'undefined')
    ? ABCore
    : (typeof require === 'function' ? require('./ab-core.js') : null);

  var STORE_KEY = 'abHandoff';

  // ── storage ──────────────────────────────────────────────────────────────
  // Promise wrappers because MV3's callback style makes the sequencing below
  // unreadable, and the sequencing is the part that has to be right.

  function readState() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORE_KEY], function (got) {
          resolve((got && got[STORE_KEY]) || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  function writeState(patch) {
    return readState().then(function (cur) {
      var next = Object.assign({}, cur, patch);
      return new Promise(function (resolve) {
        try {
          var o = {}; o[STORE_KEY] = next;
          chrome.storage.local.set(o, function () { resolve(next); });
        } catch (e) { resolve(next); }
      });
    });
  }

  /** Forget the pairing (Unpair, or a token the server no longer accepts). */
  function clearPairing() {
    return writeState({ token: '', sessionId: '' });
  }

  // ── pairing ──────────────────────────────────────────────────────────────

  /**
   * Redeem a pairing code for a session token and remember it.
   *
   * Validates the shape locally first so an obvious typo costs no round trip and
   * gets an immediate, specific message. Every failure returns a `reason` rather
   * than a thrown error, because the popup has to tell the user which of the
   * three quite different things went wrong.
   */
  function pairWithCode(baseUrl, codeInput) {
    var code = core.normalizePairingCode(codeInput);
    if (!core.looksLikePairingCode(code)) {
      return Promise.resolve({
        ok: false,
        reason: 'malformed',
        error: 'That does not look like a pairing code. It is 8 characters, like ABCD-EFGH.'
      });
    }

    return fetch(core.buildPairUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data || {} };
        });
      })
      .then(function (r) {
        if (!r.data.success || !r.data.token) {
          return {
            ok: false,
            reason: r.data.reason || 'failed',
            error: r.data.error || 'Pairing failed. Press "Switch to Local" again for a new code.'
          };
        }
        return writeState({
          baseUrl: core.normalizeBase(baseUrl),
          token: r.data.token,
          sessionId: r.data.sessionId || '',
          pairedAt: Date.now()
        }).then(function () {
          return { ok: true, sessionId: r.data.sessionId || '' };
        });
      })
      .catch(function (e) {
        // A network error here is nearly always a wrong base URL or a server
        // that is not running — name both rather than print a DOMException.
        return {
          ok: false,
          reason: 'network',
          error: 'Could not reach the server at ' + core.normalizeBase(baseUrl)
            + '. Check the address and that it is running. (' + (e && e.message) + ')'
        };
      });
  }

  // ── restore ──────────────────────────────────────────────────────────────

  function createTab(props) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.create(props, function (tab) { resolve(tab || null); });
      } catch (e) { resolve(null); }
    });
  }

  function focusTab(tabId) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.update(tabId, { active: true }, function () { resolve(true); });
      } catch (e) { resolve(false); }
    });
  }

  /**
   * Fetch the snapshot and reproduce it in THIS browser.
   *
   * Tabs are created SEQUENTIALLY and every one with `active:false`. Both
   * details are load-bearing and both are easy to get wrong:
   *
   *   - sequential, because Chrome positions a new tab in creation order; firing
   *     them off in parallel would give the user their pages in a scrambled
   *     order, and "same order" was explicitly asked for.
   *   - `active:false`, because Chrome focuses a newly created tab by default,
   *     so the last one created would end up in front. We focus the correct tab
   *     once, at the end.
   *
   * PULLS WITHOUT DRAINING. If this function dies halfway — Chrome recycles the
   * service worker, the user closes the popup — the snapshot is still on the
   * server and pressing the button again resumes. Draining first would mean a
   * half-restored browser and no way to finish.
   */
  function applyHandoff(opts) {
    var options = opts || {};
    return readState().then(function (state) {
      var baseUrl = core.normalizeBase(options.baseUrl || state.baseUrl || '');
      var token = options.token || state.token || '';
      if (!token) {
        return {
          ok: false,
          reason: 'not_paired',
          error: 'This browser is not paired yet. Enter the pairing code from the app first.'
        };
      }

      return fetch(core.buildPullUrl(baseUrl), {
        headers: { 'x-session-token': token }
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { status: res.status, data: data || {} };
          });
        })
        .then(function (r) {
          if (r.status === 401) {
            // The token is no longer recognised: stop presenting it, so the user
            // is asked to pair rather than silently failing forever.
            return clearPairing().then(function () {
              return {
                ok: false,
                reason: 'unpaired',
                error: 'This browser is no longer paired. Press "Switch to Local" in the app again.'
              };
            });
          }
          if (!r.data.success) {
            return { ok: false, reason: 'failed', error: r.data.error || 'Could not read the session.' };
          }
          if (!r.data.snapshot) {
            return {
              ok: false,
              reason: 'expired',
              error: 'That handoff has expired. Press "Switch to Local" in the app again.'
            };
          }

          var snap = r.data.snapshot;
          var plan = core.planTabRestore(snap);
          if (!plan.count) {
            // Nothing to open is a real, valid outcome — complete the switch so
            // the user still ends up in local mode rather than in limbo.
            return finish(baseUrl, token, 0, false).then(function () {
              return {
                ok: true,
                restored: 0,
                activeTabRestored: false,
                limits: core.describeHandoffLimits(snap.limits),
                sessionId: r.data.sessionId || ''
              };
            });
          }

          var created = [];
          var chain = Promise.resolve();
          plan.tabs.forEach(function (t) {
            chain = chain.then(function () {
              return createTab({ url: t.url, active: false }).then(function (tab) {
                created.push(tab);
              });
            });
          });

          return chain.then(function () {
            var target = (plan.focusIndex >= 0) ? created[plan.focusIndex] : null;
            var focused = false;
            var p = (target && target.id != null)
              ? focusTab(target.id).then(function (v) { focused = v; })
              : Promise.resolve();

            return p.then(function () {
              var opened = created.filter(function (t) { return t && t.id != null; }).length;
              return finish(baseUrl, token, opened, focused).then(function () {
                return {
                  ok: true,
                  restored: opened,
                  activeTabRestored: focused,
                  limits: core.describeHandoffLimits(snap.limits),
                  sessionId: r.data.sessionId || ''
                };
              });
            });
          });
        })
        .catch(function (e) {
          return {
            ok: false,
            reason: 'network',
            error: 'Could not reach the server (' + (e && e.message) + ').'
          };
        });
    });
  }

  /**
   * Tell the server the local side is ready — this is what flips the mode.
   *
   * Deliberately never rejects. The tabs are already open at this point, so a
   * failure here must not be reported to the user as "the handoff failed": that
   * would be false, and it would send them looking for a problem in the half
   * that worked. The app's own polling of /browser-mode reconciles the state.
   */
  function finish(baseUrl, token, restoredTabs, activeTabRestored) {
    return fetch(core.buildCompleteUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({
        to: 'local',
        restoredTabs: restoredTabs,
        activeTabRestored: !!activeTabRestored
      })
    }).catch(function () { return null; });
  }

  /** Is this browser paired, and to which session? For the popup's header. */
  function status() {
    return readState().then(function (s) {
      return {
        paired: !!s.token,
        sessionId: s.sessionId || '',
        baseUrl: s.baseUrl || '',
        pairedAt: s.pairedAt || 0
      };
    });
  }

  return {
    STORE_KEY: STORE_KEY,
    readState: readState,
    writeState: writeState,
    clearPairing: clearPairing,
    pairWithCode: pairWithCode,
    applyHandoff: applyHandoff,
    status: status
  };
});
