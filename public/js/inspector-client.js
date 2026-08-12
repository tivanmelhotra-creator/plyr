/**
 * inspector-client.js — the dashboard's half of the Element Inspector.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The Chrome extension picks an element on a real page. This file is what
 * RECEIVES that pick and drops it into the node the user is editing, so that
 * the requirement "the user must not have to copy/paste by hand" is actually
 * met end to end. Nothing here inspects a DOM: the extension does the looking,
 * this does the landing.
 *
 * THE THREE THINGS IT OWNS
 * ------------------------
 *   1. A SESSION ID, so a pick cannot land in the wrong node.
 *   2. A LISTENER (WebSocket, with an HTTP poll as the fallback) for deliveries.
 *   3. The MODE state (remote / local) that the toolbar switch renders.
 *
 * WHY THE SESSION ID LIVES IN sessionStorage AND NOT localStorage
 * --------------------------------------------------------------
 * sessionStorage is per-TAB. Two tabs open on the editor are two different
 * editing sessions, and a user who picks an element while tab B is focused
 * means tab B's node — not whichever tab claimed most recently. localStorage
 * is shared across tabs and would make the two indistinguishable, which is
 * exactly the mis-delivery the hub's session handshake exists to prevent.
 * A reload keeps the same tab's id, so the claim survives an F5.
 *
 * WHY BOTH A SOCKET AND A POLL
 * ----------------------------
 * The socket is how a pick appears instantly. The poll is how a pick still
 * appears for a user behind a proxy that breaks WebSocket upgrades. The poll
 * only runs while the socket is down (see startPolling/stopPolling), so the
 * normal case costs no extra requests.
 *
 * WHY DELIVERIES ARE ACKED
 * ------------------------
 * The server keeps a small inbox so a pick made during a page reload is not
 * lost. Anything left in it would be re-applied on the next drain, so applying
 * a delivery ends with POST /inspector/ack. Applying then acking (rather than
 * acking then applying) is deliberate: a crash between the two costs a
 * duplicate, while the other order costs the user's pick.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /**
   * Translate, with a real fallback.
   *
   * I18N.t() returns the KEY itself when a dictionary has no entry, which would
   * put "inspector.waiting" in front of a user. Anything this file shows has a
   * plain-English fallback so a missing key degrades to a sentence.
   */
  function T(key, fallback) {
    try {
      if (window.I18N && typeof window.I18N.t === 'function') {
        var v = window.I18N.t(key);
        if (v && v !== key) return v;
      }
    } catch (e) { /* i18n not loaded yet */ }
    return fallback;
  }

  function toast(msg, kind) {
    if (!msg) return;
    try {
      if (window.AppUtil && typeof window.AppUtil.toast === 'function') {
        window.AppUtil.toast(msg, kind || 'info');
        return;
      }
    } catch (e) { /* fall through */ }
    // No toast host yet (very early boot). The console is better than silence.
    try { console.info('[inspector] ' + msg); } catch (e2) {}
  }

  function apiKey() {
    try {
      return (window.API && typeof window.API.getKey === 'function')
        ? (window.API.getKey() || '')
        : '';
    } catch (e) { return ''; }
  }

  function userId() {
    try {
      return (window.API && typeof window.API.getUserId === 'function')
        ? (window.API.getUserId() || '')
        : '';
    } catch (e) { return ''; }
  }

  function get(path) {
    if (!window.API || typeof window.API.get !== 'function') {
      return Promise.reject(new Error('API not ready'));
    }
    return window.API.get(path);
  }

  function post(path, body) {
    if (!window.API || typeof window.API.post !== 'function') {
      return Promise.reject(new Error('API not ready'));
    }
    return window.API.post(path, body || {});
  }

  // ---------------------------------------------------------------------------
  // Session identity (requirement: the active node must be session-based)
  // ---------------------------------------------------------------------------

  var SESSION_STORAGE = 'ab_inspector_session';

  function makeSessionId() {
    var rand = Math.random().toString(36).slice(2, 10);
    return 'ui-' + Date.now().toString(36) + '-' + rand;
  }

  var sessionId = (function () {
    try {
      var existing = sessionStorage.getItem(SESSION_STORAGE);
      if (existing) return existing;
      var fresh = makeSessionId();
      sessionStorage.setItem(SESSION_STORAGE, fresh);
      return fresh;
    } catch (e) {
      // Private-mode storage refusal must not disable the feature; an in-memory
      // id still identifies this page for as long as it lives.
      return makeSessionId();
    }
  })();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = {
    ws: null,
    /** 'remote' | 'local' — which browser runs this user's automation. */
    mode: 'remote',
    /** The full registry from the server, for rendering the switch. */
    modes: [],
    /** Is local mode turned on for this SERVER at all (env flag)? */
    localEnabled: false,
    /** Is a local browser actually connected RIGHT NOW? */
    localAvailable: false,
    /** 'default' | 'user' | 'fallback' — why the mode is what it is. */
    reason: 'default',
    bridge: null,
    /** The node this tab has claimed, as the SERVER sees it. */
    activeNode: null,
    connected: false,
    retryMs: 1000,
    pollTimer: null,
    retryTimer: null,
    started: false,
    listeners: [],
  };

  function snapshot() {
    return {
      mode: state.mode,
      modes: state.modes,
      localEnabled: state.localEnabled,
      localAvailable: state.localAvailable,
      reason: state.reason,
      bridge: state.bridge,
      activeNode: state.activeNode,
      connected: state.connected,
      sessionId: sessionId,
    };
  }

  function emit() {
    var snap = snapshot();
    for (var i = 0; i < state.listeners.length; i++) {
      try { state.listeners[i](snap); } catch (e) { /* one bad listener is not fatal */ }
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    state.listeners.push(fn);
    try { fn(snapshot()); } catch (e) {}
    return function unsubscribe() {
      var i = state.listeners.indexOf(fn);
      if (i !== -1) state.listeners.splice(i, 1);
    };
  }

  /**
   * How many picks are waiting, from either shape the server uses.
   *
   * The socket's `hello` carries the deliveries themselves (an array); the
   * `/inspector/session` route carries a count (a number). Normalising here
   * means callers never have to know which one they are holding.
   */
  function pendingCount(pending) {
    if (Array.isArray(pending)) return pending.length;
    if (typeof pending === 'number') return pending;
    return 0;
  }

  /** Absorb the mode-shaped part of any server payload, then notify. */
  function absorb(msg) {
    if (!msg) return;
    if (typeof msg.mode === 'string') state.mode = msg.mode;
    if (Array.isArray(msg.modes)) state.modes = msg.modes;
    if (typeof msg.localEnabled === 'boolean') state.localEnabled = msg.localEnabled;
    if (typeof msg.localAvailable === 'boolean') state.localAvailable = msg.localAvailable;
    if (typeof msg.reason === 'string') state.reason = msg.reason;
    if (msg.bridge !== undefined) state.bridge = msg.bridge;
    if (msg.activeNode !== undefined) state.activeNode = msg.activeNode;
    emit();
  }

  // ---------------------------------------------------------------------------
  // Claim / release — "this session is editing this node"
  // ---------------------------------------------------------------------------

  /**
   * Tell the server which node is waiting for an element.
   *
   * Fire-and-forget on purpose: the caller is a UI action (opening a node), and
   * a failed claim must not block the editor from opening. The consequence of a
   * lost claim is a refusal the user can see and retry, which is strictly better
   * than an editor that will not open because a background POST failed.
   */
  function claim(nodeId, opts) {
    if (!nodeId) return Promise.resolve(null);
    var o = opts || {};
    return post('/inspector/claim', {
      sessionId: sessionId,
      nodeId: nodeId,
      action: o.action,
      workflowId: o.workflowId,
      field: o.field,
      label: o.label,
    }).then(function (res) {
      if (res && res.activeNode) {
        state.activeNode = res.activeNode;
        if (typeof res.mode === 'string') state.mode = res.mode;
        emit();
      }
      return res && res.activeNode ? res.activeNode : null;
    }).catch(function () { return null; });
  }

  /**
   * Stop waiting for an element.
   *
   * The local state is cleared whether or not the request succeeds: this runs
   * when a node closes, and a UI that keeps showing "node X is waiting" after
   * X is gone is worse than one that is briefly out of step with the server
   * (the next hello/refresh corrects it).
   */
  function release() {
    var had = state.activeNode;
    state.activeNode = null;
    if (had) emit();
    return post('/inspector/release', { sessionId: sessionId })
      .then(function (res) {
        if (res && res.activeNode !== undefined) {
          state.activeNode = res.activeNode;
          emit();
        }
        return true;
      })
      .catch(function () { return false; });
  }

  // ---------------------------------------------------------------------------
  // Browser mode
  // ---------------------------------------------------------------------------

  function refreshMode() {
    return get('/browser-mode').then(function (res) {
      absorb(res);
      return snapshot();
    }).catch(function () { return snapshot(); });
  }

  /**
   * Switch mode.
   *
   * A refusal (409) resolves rather than rejects, carrying the server's reason
   * key. The caller is a toggle in a toolbar; it needs to render "no local
   * browser is connected" next to the control, not catch an exception.
   */
  function setMode(mode) {
    return post('/browser-mode', { mode: mode })
      .then(function (res) {
        absorb(res);
        return { ok: true, mode: state.mode, note: (res && res.note) || '', changed: !!(res && res.changed) };
      })
      .catch(function (err) {
        var body = (err && err.body) || {};
        absorb(body);
        return {
          ok: false,
          mode: state.mode,
          note: body.note || '',
          error: (err && err.message) || 'Could not switch browser mode.',
        };
      });
  }

  // ---------------------------------------------------------------------------
  // Applying a delivery to the node
  // ---------------------------------------------------------------------------

  /**
   * Which of the hub's field keys this node action can actually accept.
   *
   * The hub maps a selection to a generous set of fields (selector, xpath,
   * text, value, name, attribute...). Writing all of them into every node
   * would invent parameters a node does not declare — and GraphSerialize only
   * persists declared keys, so those would be silently dropped on save,
   * producing a node that looks configured in the editor and runs unconfigured.
   * Filtering here keeps the editor honest about what was applied.
   */
  function acceptedFields(action) {
    var act = String(action || '');
    // Navigation takes a URL, not a selector: an element's selector in the
    // `value` slot is the closest honest mapping (a picked <a> carries href).
    if (act === 'goto' || act === 'navigate') return ['value'];
    return ['selector', 'selectorType', 'xpath', 'text', 'value', 'name', 'attribute'];
  }

  /**
   * Land one delivery in the node that asked for it, then acknowledge it.
   */
  function applyDelivery(delivery) {
    if (!delivery || !delivery.session || !delivery.fields) return false;

    var target = delivery.session;

    // Belt and braces. The server already refuses a stale session, but this
    // page may have re-claimed since the pick was queued, and applying a
    // delivery addressed to an older claim is precisely the mis-delivery the
    // whole handshake exists to stop.
    if (target.sessionId && target.sessionId !== sessionId) return false;

    var editor = window.FlowEditor;
    if (!editor || typeof editor.applyInspectorFields !== 'function') {
      toast(T('inspector.noEditor', 'Open the workflow editor to receive picked elements.'), 'error');
      return false;
    }

    var allowed = acceptedFields(target.action);
    var fields = {};
    var count = 0;
    for (var k in delivery.fields) {
      if (!Object.prototype.hasOwnProperty.call(delivery.fields, k)) continue;
      if (allowed.indexOf(k) === -1) continue;
      fields[k] = delivery.fields[k];
      count++;
    }

    if (!count) {
      toast(T('inspector.nothingToApply', 'The picked attributes do not fit this node.'), 'error');
      return false;
    }

    var applied = false;
    try {
      applied = editor.applyInspectorFields(target.nodeId, fields) === true;
    } catch (e) {
      applied = false;
    }

    if (!applied) {
      toast(T('inspector.applyFailed', 'That node is no longer open — pick again.'), 'error');
    } else {
      toast(
        T('inspector.applied', 'Element added to the node') +
          (delivery.summary ? ': ' + delivery.summary : ''),
        'success'
      );
    }

    // Ack even on a failed apply: the delivery is spent either way, and leaving
    // it queued would replay the same failure on every later poll.
    if (delivery.id) {
      post('/inspector/ack', { id: delivery.id }).catch(function () {});
    }
    return applied;
  }

  /**
   * Pull everything waiting and apply it.
   *
   * `drain=1` because this caller commits to applying what it receives (and
   * acks each one anyway).
   */
  function drainInbox() {
    return get('/inspector/inbox?drain=1').then(function (res) {
      var items = (res && res.items) || [];
      for (var i = 0; i < items.length; i++) applyDelivery(items[i]);
      return items.length;
    }).catch(function () { return 0; });
  }

  // ---------------------------------------------------------------------------
  // The socket
  // ---------------------------------------------------------------------------

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var qs = 'api_key=' + encodeURIComponent(apiKey());
    var uid = userId();
    if (uid) qs += '&userId=' + encodeURIComponent(uid);
    qs += '&sessionId=' + encodeURIComponent(sessionId);
    return proto + '//' + location.host + '/inspector/ws?' + qs;
  }

  function connect() {
    if (!apiKey()) return;                 // not logged in yet
    if (state.ws) return;                  // already connected or connecting
    if (typeof WebSocket === 'undefined') { startPolling(); return; }

    var ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      startPolling();
      scheduleRetry();
      return;
    }
    state.ws = ws;

    ws.onopen = function () {
      state.connected = true;
      state.retryMs = 1000;               // a good connection forgets the backoff
      stopPolling();
      emit();
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'hello') {
        absorb(msg);
        // The hub held picks while this page was away (a reload, a re-login).
        //
        // `pending` arrives as an ARRAY of deliveries here (InspectorSocket
        // sends peek(), not a count) — hence the length test. An empty array is
        // truthy, so a bare `if (msg.pending)` would fire a pointless drain on
        // every single connect. The /inspector/session route sends a NUMBER for
        // the same field, so both shapes are accepted.
        if (pendingCount(msg.pending) > 0) drainInbox();
        return;
      }
      if (msg.t === 'mode') { absorb(msg); return; }
      // The agent connecting or dropping changes whether Local Browser is even
      // selectable, so the toolbar has to hear about it.
      if (msg.t === 'bridge.connected' || msg.t === 'bridge.lost') { absorb(msg); return; }
      if (msg.t === 'element') {
        if (msg.delivery) applyDelivery(msg.delivery);
        return;
      }
      if (msg.t === 'ping') {
        try { ws.send(JSON.stringify({ t: 'pong' })); } catch (e) {}
        return;
      }
    };

    ws.onerror = function () { /* onclose always follows; handle it there */ };

    ws.onclose = function () {
      state.ws = null;
      state.connected = false;
      emit();
      // Picks must keep arriving while the socket is down.
      startPolling();
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (state.retryTimer) return;
    var wait = state.retryMs;
    state.retryMs = Math.min(state.retryMs * 2, 30000);
    state.retryTimer = setTimeout(function () {
      state.retryTimer = null;
      if (state.started) connect();
    }, wait);
  }

  // ---------------------------------------------------------------------------
  // The HTTP fallback
  // ---------------------------------------------------------------------------

  function startPolling() {
    if (state.pollTimer || !state.started) return;
    state.pollTimer = setInterval(function () {
      if (!apiKey()) return;
      drainInbox();
    }, 3000);
  }

  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start() {
    if (state.started) return;
    state.started = true;
    connect();
    refreshMode();
  }

  function stop() {
    state.started = false;
    stopPolling();
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    var ws = state.ws;
    state.ws = null;
    state.connected = false;
    if (ws) { try { ws.close(); } catch (e) {} }
    emit();
  }

  /**
   * Release the claim as the tab goes away.
   *
   * sendBeacon, not fetch: a fetch started in `beforeunload` is routinely
   * cancelled when the document is torn down, whereas a beacon is handed to the
   * browser to deliver after the page is gone. The key rides in the query
   * string because a beacon cannot set headers. Leaving the claim behind would
   * make the NEXT pick land in a node from a closed tab, which is the exact
   * failure the session handshake exists to prevent.
   */
  window.addEventListener('beforeunload', function () {
    if (!state.activeNode) return;
    var key = apiKey();
    if (!key) return;
    try {
      var url = '/inspector/release?api_key=' + encodeURIComponent(key);
      var blob = new Blob([JSON.stringify({ sessionId: sessionId })], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
    } catch (e) { /* the claim TTL cleans up whatever this misses */ }
  });

  window.InspectorClient = {
    start: start,
    stop: stop,
    claim: claim,
    release: release,
    refreshMode: refreshMode,
    setMode: setMode,
    onChange: onChange,
    state: snapshot,
    sessionId: function () { return sessionId; },
    drainInbox: drainInbox,
    applyDelivery: applyDelivery,
    acceptedFields: acceptedFields,
  };
})();
