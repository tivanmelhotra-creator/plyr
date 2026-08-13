/* ============================================================
   browser-handoff.js — the app half of the Remote ⇄ Local switch.

   WHAT THE USER ASKED FOR
   -----------------------
   Clicking a node that needs a browser opens Remote. If Remote feels slow, one
   click moves the SAME session onto their own Windows machine — same tabs, same
   order, same active tab, still signed in — and one click moves it back. They
   should not have to understand any of the machinery to do it.

       «کاربر باید حس کند همان Remote Browser با یک کلیک از Server به
        Windows خودش منتقل شد.»

   THE ONE INVARIANT
   -----------------
   Remote and Local are NOT two sessions. Both attach to one automation session
   on the server, and the session id is the proof: it is issued once per user and
   is never reissued by a switch. This module therefore always DISPLAYS that id
   rather than deriving anything of its own — if the two sides ever disagreed,
   the screen would show it instead of hiding it.

   WHY THE MODE FLIPS LAST
   -----------------------
   The order is: snapshot → (install/pair) → tabs open → mode flips. The flip
   lives on the server, at /handoff/complete, and nothing here can move it
   earlier. A user whose extension install fails halfway therefore stays in the
   mode that still works, instead of being marked "local" with no local browser
   behind it. Going BACK to remote needs no pairing at all, because the server
   already holds that browser — so that direction is a single call.

   PURE LOGIC IS SEPARATED
   -----------------------
   Everything that decides *what to say* lives in pure functions exported on
   window.BrowserHandoff, so the wording and the state machine are unit-tested
   directly. The DOM work around them is deliberately thin.
   ============================================================ */
(function () {
  'use strict';

  function t(k) {
    return (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
  }
  function tf(k, map) {
    return String(t(k)).replace(/\{(\w+)\}/g, function (m, name) {
      return map && map[name] != null ? String(map[name]) : m;
    });
  }

  // ── pure helpers ─────────────────────────────────────────────────────────

  /** The mode a switch button should target from where we are now. */
  function otherMode(mode) {
    return mode === 'local' ? 'remote' : 'local';
  }

  /**
   * What the switch button should say and whether it can be pressed.
   *
   * Returned as data rather than written straight to the DOM so the decisions
   * can be tested: "offer Local when no bridge exists" and "never offer a mode
   * the server says is unavailable" are rules, not rendering.
   */
  function switchButtonState(info) {
    var state = info || {};
    var mode = state.mode === 'local' ? 'local' : 'remote';
    var target = otherMode(mode);
    var modes = Array.isArray(state.modes) ? state.modes : [];

    // A single-mode server has nothing to switch to; showing a button that can
    // only ever fail is worse than showing none.
    if (modes.length && modes.indexOf(target) === -1) {
      return { visible: false, target: target, enabled: false, label: '', title: '' };
    }

    return {
      visible: true,
      target: target,
      enabled: true,
      label: target === 'local' ? t('ho.toLocal') : t('ho.toRemote'),
      title: target === 'local' ? t('ho.toLocalHint') : t('ho.toRemoteHint')
    };
  }

  /**
   * Turn the server's `limits` keys into one sentence.
   *
   * Reported, never swallowed. The cookie case is the one that matters: a user
   * who is silently signed out on the other side concludes the whole feature is
   * broken, whereas a user who was told expects it and moves on.
   */
  function describeLimits(limits) {
    if (!limits || !Array.isArray(limits.notes) || !limits.notes.length) return '';
    var parts = [];
    for (var i = 0; i < limits.notes.length; i++) {
      var n = limits.notes[i];
      if (n === 'tabs_capped') parts.push(tf('ho.limitTabs', { n: limits.tabsDropped }));
      else if (n === 'storage_unavailable') parts.push(t('ho.limitStorage'));
      else if (n === 'no_tabs') parts.push(t('ho.limitNoTabs'));
    }
    return parts.join(' ');
  }

  /** Whole seconds left on a pairing code, floored at zero. */
  function secondsLeft(expiresAt, now) {
    // `now == null ? Date.now() : now`, NOT `now || Date.now()`. The falsy form
    // silently ignores a caller who passes 0 and reads the real wall clock
    // instead, which makes the function impossible to test with an injected
    // clock and quietly wrong for any caller that computes a zero timestamp.
    // Defaulting must key on "was an argument given", not "is it truthy".
    var at = Number(expiresAt);
    if (isNaN(at)) at = 0;
    var t0 = (now == null || isNaN(Number(now))) ? Date.now() : Number(now);
    var ms = at - t0;
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  /** mm:ss for the countdown. */
  function formatCountdown(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /**
   * Is the extension installed in THIS browser?
   *
   * Reads the marker content/presence.js leaves on <html>. Deliberately a hint
   * only: it chooses between showing a pairing code and showing an install link,
   * and nothing is authorised on it — the code is still redeemed server-side.
   *
   * NOTE this answers for the browser running this page. That is the right
   * question when the app is open on the user's own machine (the normal case for
   * "move it here"), and it is why a false negative is harmless: the user is
   * shown an install link for something they have, and pairing still works.
   */
  function extensionPresent(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return false;
    return d.documentElement.getAttribute('data-ab-extension') === '1';
  }

  /**
   * Which screen does the local switch need?
   *
   * Three distinct outcomes, because they need three different things from the
   * user: install the extension, type the code, or nothing at all.
   */
  function planLocalSwitch(opts) {
    var o = opts || {};
    if (!o.pairing || !o.pairing.code) {
      // No code issued means the server did not think pairing was needed.
      return { step: 'error', reason: 'no_pairing' };
    }
    return {
      step: o.extensionInstalled ? 'pair' : 'install',
      code: o.pairing.display || o.pairing.code,
      expiresAt: o.pairing.expiresAt || 0,
      install: o.extension || null
    };
  }

  // ── the module ───────────────────────────────────────────────────────────

  var API = window.API;
  var state = { sessionId: '', mode: 'remote', modes: [], pollTimer: 0, tickTimer: 0 };

  function toast(msg, kind) {
    if (window.AppUtil && window.AppUtil.toast) window.AppUtil.toast(msg, kind);
  }

  /** Read the live session. Never throws: callers use it to render, not to act. */
  function readSession() {
    if (!API || !API.get) return Promise.resolve(null);
    return API.get('/browser-mode/session')
      .then(function (r) {
        if (!r || r.success === false) return null;
        state.sessionId = r.sessionId || state.sessionId;
        state.mode = r.mode || state.mode;
        state.modes = r.modes || state.modes;
        return r;
      })
      .catch(function () { return null; });
  }

  /**
   * Switch to remote. One call, no pairing.
   *
   * The server already has that browser, so there is nothing to prove and
   * nothing to install — which is why this direction is not the mirror image of
   * the local one. It still goes through /handoff/start first so the LOCAL tabs
   * are captured before the flip; skipping that would silently discard whatever
   * the user had open on their own machine.
   */
  function switchToRemote() {
    return API.post('/browser-mode/handoff/start', { to: 'remote' })
      .then(function (started) {
        var captured = (started && started.captured) || {};
        return API.post('/browser-mode/handoff/complete', {
          to: 'remote',
          restoredTabs: captured.tabCount || 0,
          activeTabRestored: true
        }).then(function (done) {
          if (!done || done.success === false) {
            throw new Error((done && (done.message || done.error)) || t('ho.failed'));
          }
          state.mode = done.mode || 'remote';
          var note = describeLimits(captured.limits);
          toast(t('ho.nowRemote') + (note ? ' ' + note : ''), 'success');
          return done;
        });
      });
  }

  /** Begin a switch to local: freeze the tabs and get a pairing code. */
  function startLocalSwitch() {
    return API.post('/browser-mode/handoff/start', { to: 'local' })
      .then(function (r) {
        if (!r || r.success === false) {
          throw new Error((r && (r.error || r.message)) || t('ho.failed'));
        }
        return {
          plan: planLocalSwitch({
            pairing: r.pairing,
            extension: r.extension,
            extensionInstalled: extensionPresent()
          }),
          captured: r.captured || {},
          sessionId: r.sessionId || state.sessionId
        };
      });
  }

  /** Abandon a switch. The snapshot and any unredeemed code are dropped. */
  function cancelSwitch() {
    return API.post('/browser-mode/handoff/cancel', {}).catch(function () { return null; });
  }

  /**
   * Watch for the extension completing the handoff.
   *
   * Polling, not a socket: the completing party is a browser extension that
   * talks to the server directly, so there is no event for this page to receive.
   * The poll stops itself on success and on a deadline, because a timer left
   * running behind a closed dialog is a leak that outlives the feature.
   */
  function watchForCompletion(opts) {
    var o = opts || {};
    var onDone = o.onDone || function () {};
    var onTick = o.onTick || function () {};
    var deadline = Date.now() + (o.timeoutMs || 6 * 60 * 1000);

    stopWatch();
    state.pollTimer = window.setInterval(function () {
      if (Date.now() > deadline) { stopWatch(); onDone({ timedOut: true }); return; }
      readSession().then(function (r) {
        if (!r) return;
        onTick(r);
        // The mode flipping to local IS the completion signal: the server only
        // flips it once the other browser reported its tabs were open.
        if (r.mode === 'local') { stopWatch(); onDone({ ok: true, session: r }); }
      });
    }, 1500);
  }

  function stopWatch() {
    if (state.pollTimer) { window.clearInterval(state.pollTimer); state.pollTimer = 0; }
  }

  window.BrowserHandoff = {
    // pure (unit-tested)
    otherMode: otherMode,
    switchButtonState: switchButtonState,
    describeLimits: describeLimits,
    secondsLeft: secondsLeft,
    formatCountdown: formatCountdown,
    extensionPresent: extensionPresent,
    planLocalSwitch: planLocalSwitch,
    // effectful
    readSession: readSession,
    switchToRemote: switchToRemote,
    startLocalSwitch: startLocalSwitch,
    cancelSwitch: cancelSwitch,
    watchForCompletion: watchForCompletion,
    stopWatch: stopWatch,
    state: state
  };

  // Also export for vitest, which requires this file directly to test the pure
  // half. Same dual-export shape as extension/lib/ab-core.js.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.BrowserHandoff;
  }
})();
