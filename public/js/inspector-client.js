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
 *   1. The REGISTERED TARGET FIELDS — which fields are open to receive a value.
 *   2. A LISTENER (WebSocket, with an HTTP poll as the fallback) for deliveries.
 *   3. The MODE state (remote / local) that the toolbar switch renders.
 *
 * WHY THERE IS NO LONGER A SESSION ID
 * -----------------------------------
 * This file used to mint a per-tab `ui-…` id and claim a node under it, while
 * the extension minted its own `ext-…` id and submitted under THAT. The server
 * compared the two for equality, so every pick was refused — two independently
 * generated strings are never equal. The id was then read back from the server
 * purely to satisfy the comparison, a round trip that carried no information.
 *
 * The destination is now a TARGET FIELD registered with the server, which mints
 * the `targetFieldId` (including a random suffix this page never chooses). That
 * id identifies a FIELD, not a tab, so:
 *   - two tabs are no longer indistinguishable — they hold different ids
 *   - several fields can be open at once, which a single-valued "active node"
 *     could not express
 *   - switching Remote/Local, or reconnecting, invalidates nothing
 *
 * The suffix is what makes a stale delivery impossible: re-opening the same
 * field mints a NEW id, so a pick queued against the previous one resolves to
 * nothing rather than landing in a field the user thought they had closed.
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
    /**
     * Every Target Field currently open, as the SERVER sees it.
     *
     * A LIST, not a single "active node": several fields must be able to wait
     * for a value at once, and a single-valued shape would have to silently
     * drop all but one of them.
     */
    targets: [],
    /**
     * targetFieldId -> { nodeId, fieldKey } for fields THIS page registered.
     *
     * Kept so closing a node can release exactly its own fields without
     * touching a field some other tab opened.
     */
    mine: {},
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
      targets: state.targets.slice(),
      connected: state.connected,
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
    if (Array.isArray(msg.targets)) state.targets = msg.targets;
    emit();
  }

  // ---------------------------------------------------------------------------
  // Target Fields — "this FIELD is waiting for a value"
  // ---------------------------------------------------------------------------

  /**
   * Open one field to receive a picked value.
   *
   * `fieldKey` is REQUIRED and must be a key the action really declares. The
   * server checks it against the action catalogue and refuses anything else,
   * because coerceParams() drops undeclared keys on save — a value written to
   * one would vanish silently and leave a node that looks configured in the
   * editor and runs unconfigured.
   *
   * The id is minted by the SERVER. If this page chose it, it could re-use a
   * suffix it had seen before and revive a destination the user had closed,
   * which is the stale delivery the suffix exists to prevent.
   *
   * Resolves to null rather than rejecting: the caller is a UI action, and a
   * failed registration must not stop a field from rendering. The user sees a
   * refusal they can retry instead of an editor that will not open.
   */
  function registerTarget(nodeId, fieldKey, opts) {
    if (!nodeId || !fieldKey) return Promise.resolve(null);
    var o = opts || {};
    return post('/inspector/target', {
      nodeId: nodeId,
      fieldKey: fieldKey,
      action: o.action,
      workflowId: o.workflowId,
      label: o.label,
    }).then(function (res) {
      var target = res && res.target;
      if (!target || !target.targetFieldId) return null;
      state.mine[target.targetFieldId] = { nodeId: nodeId, fieldKey: fieldKey };
      if (Array.isArray(res.targets)) state.targets = res.targets;
      else state.targets = state.targets.concat([target]);
      emit();
      return target;
    }).catch(function () { return null; });
  }

  /* authorizeTarget() IS REMOVED.
   *
   * It POSTed to /inspector/authorize and returned { code, display, baseUrl, … }
   * for the editor to render as an Authorization Code plus an address for the
   * operator to transcribe into the extension. The route is deleted server-side
   * (src/Routes/mode.routes.ts) and its only caller — the per-field "Connect
   * Inspector" row in flow-editor.js — is deleted too.
   *
   * Nothing replaces it on this client, because binding is no longer something
   * the page asks for and then displays. `targetingBegin()` below does the whole
   * job in one call:
   *
   *   LOCAL   the server rebinds the extension to the field internally and
   *           answers `paired: true`. There is nothing to show.
   *   REMOTE  the server raises a consent request; the remote browser answers it
   *           and receives the target directly.
   *
   * Keeping a code-minting wrapper here with no route behind it would only
   * invite a caller to be written for it. */

  // ---------------------------------------------------------------------------
  // TARGETING — the LOCAL / REMOTE step that now opens the flow
  //
  //   «وقتی کاربر روی آیکون 🎯 Target This Field کلیک می‌کند، اولین مرحله باید
  //    انتخاب Browser Environment باشد، نه Connection Mode.»
  //
  // These three wrap the server routes and add nothing of their own. That is
  // deliberate: the decision of whether a code is needed belongs to
  // BrowserEnvironment.planTargeting on the server, and a copy of that rule
  // here would be a second source of truth that could disagree with the first.
  // The dialog RENDERS what the server decided; it never decides.
  // ---------------------------------------------------------------------------

  /**
   * Which environments may this field be targeted with, and would either ask
   * for an Authorization Code?
   *
   * A READ. Merely opening a chooser the user may cancel must not mint a
   * destination or put a code on screen, so nothing is registered until they
   * actually pick — see targetingBegin.
   */
  function targetingOptions(nodeId, fieldKey, opts) {
    if (!nodeId || !fieldKey) return Promise.resolve(null);
    var o = opts || {};
    var q = '?nodeId=' + encodeURIComponent(nodeId)
      + '&fieldKey=' + encodeURIComponent(fieldKey);
    if (o.workflowId) q += '&workflowId=' + encodeURIComponent(o.workflowId);
    return get('/inspector/targeting/options' + q)
      .then(function (res) { return (res && res.success) ? res : null; })
      .catch(function () { return null; });
  }

  /**
   * The user chose an environment. Register the destination and find out what
   * happens next.
   *
   * Resolves to the server's plan. `step` is always 'targeting' now — there is
   * no 'authorize' step and no `code`, in either environment. The one difference
   * left between them is `plan.needsRemoteApproval`: LOCAL is attached by this
   * server before it answers, REMOTE asks the other browser for approval first.
   * Resolves to null on refusal rather than rejecting — the caller is a button,
   * and a failed request must leave the editor usable.
   */
  function targetingBegin(nodeId, fieldKey, environment, opts) {
    if (!nodeId || !fieldKey) return Promise.resolve(null);
    var o = opts || {};
    return post('/inspector/targeting/begin', {
      nodeId: nodeId,
      fieldKey: fieldKey,
      environment: environment,
      action: o.action,
      workflowId: o.workflowId,
      label: o.label,
    }).then(function (res) {
      if (!res || !res.success || !res.target) return res || null;
      // Tracked like any other registration so closing the node releases it.
      state.mine[res.target.targetFieldId] = { nodeId: nodeId, fieldKey: fieldKey };
      state.targets = state.targets.concat([res.target]);
      emit();
      return res;
    }).catch(function () { return null; });
  }

  /**
   * Is the Remote Browser already up and answering?
   *
   * Asked so the Targeting flow can DECLINE to relaunch a browser the operator
   * is already looking at:
   *
   *   «اگر کاربر مرورگر رو نبنده و برم نود بعدی رو باز کنه … گیج میشه که الان من
   *    مرورگرم بالا هست، آیا نیازه مجدد آیکون پیکر رو بزنم تا مرورگر بالا بیاد؟
   *    اگرم بیاد بهینه نیست»
   *
   * `running` and `responsive` are deliberately both required. A frozen Chromium
   * keeps `running` true while answering nothing, and treating that as "already
   * up" would skip the relaunch that would have fixed it — leaving the operator
   * staring at a dead tab with no way forward. So the answer is only "live" when
   * the process is there AND it replies.
   *
   * Resolves false on any failure. A probe that cannot answer must fall back to
   * the OLD behaviour (open the browser), because a spurious "already live" is
   * the one outcome that strands the flow.
   */
  function remoteBrowserLive() {
    return get('/browser/real/health')
      .then(function (res) {
        return !!(res && res.success && res.running && res.responsive);
      })
      .catch(function () { return false; });
  }

  /**
   * Is this Target Field attached to an Inspector yet?
   *
   * No longer "has the user typed the code" — nothing is typed. LOCAL comes back
   * attached, so this answers `paired:true` on the first poll. REMOTE genuinely
   * resolves later, once the approval prompt is answered inside the other
   * browser, and the server is the only party that sees both sides.
   */
  function targetingStatus(targetFieldId) {
    if (!targetFieldId) return Promise.resolve(null);
    return get('/inspector/targeting/status?targetFieldId='
      + encodeURIComponent(targetFieldId))
      .then(function (res) { return (res && res.success) ? res : null; })
      .catch(function () { return null; });
  }

  /**
   * Deliberately forget a pairing.
   *
   * The ONLY thing that makes the code come back. Closing a node, switching
   * modes and letting an address expire all leave the pairing alone — that
   * separation is what makes the persistence real rather than best-effort.
   */
  function targetingUnpair(nodeId, fieldKey, opts) {
    var o = opts || {};
    return post('/inspector/targeting/unpair', {
      nodeId: nodeId, fieldKey: fieldKey, workflowId: o.workflowId,
    }).then(function (res) { return !!(res && res.unpaired); })
      .catch(function () { return false; });
  }

  /** Close one field. Other fields — this node's or another node's — are untouched. */
  function releaseTarget(targetFieldId) {
    if (!targetFieldId) return Promise.resolve(false);
    // Dropped locally first: a UI that still lists a field the user just closed
    // is worse than one briefly out of step with the server, which the next
    // hello corrects anyway.
    delete state.mine[targetFieldId];
    state.targets = state.targets.filter(function (t) {
      return t && t.targetFieldId !== targetFieldId;
    });
    emit();
    return post('/inspector/target/release', { targetFieldId: targetFieldId })
      .then(function (res) {
        if (res && Array.isArray(res.targets)) { state.targets = res.targets; emit(); }
        return !!(res && res.released);
      })
      .catch(function () { return false; });
  }

  /**
   * Close every field this page opened for one node.
   *
   * Scoped to `nodeId` on purpose: closing a node must not disconnect fields
   * another node — or another tab — still has open.
   */
  function releaseNode(nodeId) {
    if (!nodeId) return Promise.resolve(0);
    var ids = [];
    for (var id in state.mine) {
      if (!Object.prototype.hasOwnProperty.call(state.mine, id)) continue;
      if (state.mine[id].nodeId === nodeId) ids.push(id);
    }
    if (!ids.length) return Promise.resolve(0);
    return Promise.all(ids.map(releaseTarget)).then(function () { return ids.length; });
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
   * Land one delivery in the FIELD that asked for it, then acknowledge it.
   *
   * The destination is `delivery.target`, which the server resolved from its own
   * registry — this page does not re-derive it, and there is no session id left
   * to compare. The delivery carries exactly one field (§21: one radio, one
   * outbound value), so there is nothing to filter: the server already refused
   * anything that could not be placed, rather than redirecting it somewhere it
   * would fit.
   */
  function applyDelivery(delivery) {
    if (!delivery || !delivery.target || !delivery.fields) return false;

    var target = delivery.target;
    if (!target.nodeId) return false;

    var editor = window.FlowEditor;
    if (!editor || typeof editor.applyInspectorFields !== 'function') {
      toast(T('inspector.noEditor', 'Open the workflow editor to receive picked elements.'), 'error');
      return false;
    }

    var fields = {};
    var count = 0;
    for (var k in delivery.fields) {
      if (!Object.prototype.hasOwnProperty.call(delivery.fields, k)) continue;
      if (delivery.fields[k] == null || delivery.fields[k] === '') continue;
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
    // No session id: the socket is a per-USER delivery channel now, and which
    // FIELD a pick belongs to travels with the delivery itself.
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
   * Release this tab's Target Fields as it goes away.
   *
   * sendBeacon, not fetch: a fetch started in `beforeunload` is routinely
   * cancelled when the document is torn down, whereas a beacon is handed to the
   * browser to deliver after the page is gone. The key rides in the query
   * string because a beacon cannot set headers.
   *
   * One beacon PER FIELD, because release takes one id: closing this tab must
   * not release a field another tab still has open, and the server has no way
   * to tell "all of this tab's fields" apart from "all of this user's fields".
   * Whatever a missed beacon leaves behind, the target TTL collects.
   */
  window.addEventListener('beforeunload', function () {
    var key = apiKey();
    if (!key) return;
    try {
      if (!navigator.sendBeacon) return;
      var url = '/inspector/target/release?api_key=' + encodeURIComponent(key);
      for (var id in state.mine) {
        if (!Object.prototype.hasOwnProperty.call(state.mine, id)) continue;
        var blob = new Blob([JSON.stringify({ targetFieldId: id })], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
      }
    } catch (e) { /* the target TTL cleans up whatever this misses */ }
  });

  window.InspectorClient = {
    start: start,
    stop: stop,
    registerTarget: registerTarget,
    // The LOCAL / REMOTE step at the top of the Targeting flow.
    targetingOptions: targetingOptions,
    targetingBegin: targetingBegin,
    targetingStatus: targetingStatus,
    /** Whether the server's browser is already up, so it need not be relaunched. */
    remoteBrowserLive: remoteBrowserLive,
    targetingUnpair: targetingUnpair,
    releaseTarget: releaseTarget,
    releaseNode: releaseNode,
    refreshMode: refreshMode,
    setMode: setMode,
    onChange: onChange,
    state: snapshot,
    drainInbox: drainInbox,
    applyDelivery: applyDelivery,
    /** Which fields this page has open, for the picker UI. */
    myTargets: function () {
      var out = [];
      for (var id in state.mine) {
        if (!Object.prototype.hasOwnProperty.call(state.mine, id)) continue;
        out.push({
          targetFieldId: id,
          nodeId: state.mine[id].nodeId,
          fieldKey: state.mine[id].fieldKey,
        });
      }
      return out;
    },
  };
})();
