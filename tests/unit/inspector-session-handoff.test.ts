import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import { InspectorHub } from '../../src/core/InspectorHub';
import { TargetFieldRegistry } from '../../src/core/TargetFieldRegistry';
import { InspectorAuthorizationRegistry } from '../../src/core/InspectorAuthorization';
import { RemoteTargetConsentRegistry } from '../../src/core/RemoteTargetConsent';

// ════════════════════════════════════════════════════════════════
// THE EXTENSION ⇄ BACKEND SEAM — extension/background.js ⇄ InspectorHub
//
// WHY THIS FILE EXISTS
// --------------------
// «Confirm & Add to Node» was completely dead, and every existing test passed.
// The reason is the shape of bug this file is built to catch:
//
//   • the DASHBOARD claimed a node under a per-tab id it minted itself ("ui-…")
//   • the EXTENSION submitted a pick under an id IT minted        ("ext-…")
//   • the hub compared the two for equality
//
// Two independently generated strings are never equal, so EVERY pick was
// refused. Nothing caught it because the hub tests claimed and submitted with
// ids they chose themselves, and the extension tests never talked to the hub.
// The bug lived exactly in the SEAM, so the test has to span the seam.
//
// WHAT REPLACED THE SESSION ID
// ----------------------------
// The destination is now a Target Field the PROJECT registers, addressed by a
// server-minted `targetFieldId`, and the extension is bound to it ONCE with an
// Authorization Code. There is no id to keep in sync, so the class of bug above
// cannot recur — but three new ones become possible, and this file exists to
// catch those instead:
//
//   1. the extension choosing its own destination (§8 forbids it)
//   2. a send landing in a field this API key was never authorized for
//   3. unpairing the Inspector tearing down the unrelated Handoff pairing
//
// WHAT MAKES THIS TEST TRUSTWORTHY
// --------------------------------
// It re-implements neither side. The real `extension/background.js` runs in a
// `vm` sandbox (the approach already used by extension-selector.test.ts and
// extension-inspect.test.ts — there is no jsdom here), its `fetch` is routed
// into a REAL InspectorHub + TargetFieldRegistry + InspectorAuthorizationRegistry
// behind the same endpoints src/Routes/mode.routes.ts exposes, and the pick is
// driven through the real `chrome.runtime.onMessage` handler using the real
// message names content/inspector.js and the popup send.
//
// The endpoint stubs mirror mode.routes.ts deliberately rather than
// conveniently: `/inspector/pair` answers 403 with a §27 reason, and
// `/inspector/element` answers 409 with a §27 reason plus the surviving
// `targets` — which is what the popup renders.
// ════════════════════════════════════════════════════════════════

const USER = 'local';
const BASE = 'http://127.0.0.1:9999';
const API_KEY = 'test-key';

type Msg = Record<string, unknown>;
type Listener = (msg: Msg, sender: unknown, respond: (r: unknown) => void) => unknown;

interface Harness {
  /** Send a message the way the popup / content script does, and await the reply. */
  send(msg: Msg): Promise<Record<string, unknown>>;
  /** Every request background.js actually made, in order. */
  requests: Array<{
    method: string;
    path: string;
    body: Record<string, unknown> | null;
    key: string;
    /** `?environment=` — how the caller declared which browser it is. */
    query: string;
    /** The `x-browser-environment` header, sent alongside the query. */
    declaredEnv: string;
  }>;
  /** What was POSTed to /inspector/element, in order. */
  posted: Array<Record<string, unknown>>;
  storage: Record<string, unknown>;
  hub: InspectorHub;
  registry: TargetFieldRegistry;
  auth: InspectorAuthorizationRegistry;
  consent: RemoteTargetConsentRegistry;
  /**
   * Raise a consent prompt the way the REMOTE branch of
   * /inspector/targeting/begin does, and return its handle.
   *
   * Deliberately mints NO Authorization Code, because that is the whole point of
   * the REMOTE path — «برای REMOTE BROWSER نیازی به Authorization Code نیست» —
   * and it is precisely why nothing used to write the destination.
   */
  askFor(targetFieldId: string): string;
  /** Register a destination the way the workflow UI does, and return its id. */
  openField(opts?: { nodeId?: string; fieldKey?: string; action?: string; label?: string }): string;
  /** Mint the Authorization Code the project would show the user. */
  codeFor(targetFieldId: string): string;
}

/**
 * Load the real service worker with a fake `chrome` and a `fetch` wired to real
 * registries.
 *
 * The registries are constructor-injected into the hub rather than reached
 * through their singletons, because `resolveUserId` collapses every caller to
 * 'local' in single-user mode — shared module state would let one test's
 * pairing leak into the next and quietly turn a red assertion green.
 */
interface WorkerOpts {
  /** Reuse another harness's backend + profile, to model an MV3 worker restart. */
  reuse?: Harness;
  /**
   * Model the copy the SERVER side-loads into the REMOTE browser.
   *
   * That copy — and only that copy — carries a generated `bootstrap.config.js`
   * defining `AB_BOOTSTRAP` with `managed: true` (see
   * src/core/InspectorExtension.ts). background.js uses exactly that to answer
   * "which browser am I in?", because a user's own Chrome cannot obtain the file
   * by configuring anything, which is what makes 'remote' unforgeable from the
   * user side.
   *
   * It matters here because the remote-consent handshake is REMOTE-only by
   * contract:
   *
   *   LOCAL  = API Key + Authorization Code      -> NO Remote Approval Alert
   *   REMOTE = no API Key, no Authorization Code -> Remote Approval Alert
   *
   * A worker without this flag is a LOCAL browser and correctly refuses to list
   * or answer consent at all, so the REMOTE tests below must opt in. Leaving it
   * off by default keeps every other test in this file describing the ordinary
   * hand-installed extension.
   */
  managed?: boolean;
}

function loadWorker(opts: WorkerOpts = {}): Harness {
  const registry = opts.reuse?.registry ?? new TargetFieldRegistry();
  const auth = opts.reuse?.auth ?? new InspectorAuthorizationRegistry();
  const hub = opts.reuse?.hub ?? new InspectorHub(registry, auth);
  const consent = opts.reuse?.consent ?? new RemoteTargetConsentRegistry();

  // chrome.storage.local outlives the worker, which is the entire reason the
  // destination is persisted rather than re-derived.
  const storage: Record<string, unknown> = opts.reuse?.storage ?? {};
  const requests: Harness['requests'] = [];
  const posted: Array<Record<string, unknown>> = [];
  let listener: Listener | null = null;

  const chrome = {
    runtime: {
      lastError: undefined as unknown,
      onMessage: { addListener: (fn: Listener) => { listener = fn; } },
      onInstalled: { addListener: (_fn: () => void) => { /* fires on install only */ } },
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        get(keys: string[] | string, cb: (s: Record<string, unknown>) => void) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (storage[k] !== undefined) out[k] = storage[k];
          cb(out);
        },
        set(patch: Record<string, unknown>, cb?: () => void) {
          Object.assign(storage, patch);
          if (cb) cb();
        },
        remove(keys: string[] | string, cb?: () => void) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete storage[k];
          if (cb) cb();
        },
      },
    },
    tabs: {
      query: (_q: unknown, cb: (t: unknown[]) => void) => cb([{ id: 1 }]),
      sendMessage: (_id: number, _m: unknown, cb?: (r: unknown) => void) => { if (cb) cb({ ok: true }); },
      create: (_o: unknown, cb?: (t: unknown) => void) => { if (cb) cb({ id: 2 }); },
    },
    scripting: { executeScript: (_o: unknown, cb?: () => void) => { if (cb) cb(); } },
    commands: { onCommand: { addListener: (_fn: unknown) => { /* no shortcut in a test */ } } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };

  // The endpoints the inspector path touches, answered by the REAL registries.
  async function fakeFetch(url: string, opts: Record<string, unknown> = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    // Split the query off the way a real server does. background.js declares its
    // browser environment on GET /inspector/consent as `?environment=remote`
    // (and as an `x-browser-environment` header), so a fake that compared the
    // whole string against a bare path would 404 the request and make the REMOTE
    // consent tests fail for a reason that has nothing to do with consent.
    const raw = url.replace(BASE, '');
    const qmark = raw.indexOf('?');
    const path = qmark >= 0 ? raw.slice(0, qmark) : raw;
    const query = new URLSearchParams(qmark >= 0 ? raw.slice(qmark + 1) : '');
    const headers = (opts.headers || {}) as Record<string, string>;
    // The route reads the key from the CREDENTIAL, never from the body. Captured
    // here so a test can prove the extension actually presented one.
    const key = headers['x-api-key'] || '';
    let body: Record<string, unknown> | null = null;
    if (opts.body) { try { body = JSON.parse(String(opts.body)); } catch { body = null; } }
    requests.push({
      method,
      path,
      body,
      key,
      query: query.get('environment') || '',
      declaredEnv: headers['x-browser-environment'] || '',
    });

    const reply = (status: number, data: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
    });

    if (method === 'GET' && path === '/inspector/session') {
      return reply(200, {
        success: true,
        userId: USER,
        mode: 'remote',
        targets: registry.list(USER),
        authorized: auth.bindingsFor(key),
        // The DURABLE half, mirroring the real route. `authorized` lists
        // ADDRESSES, which are re-minted on every NDV open; `pairings` lists
        // the stable Extension⇄Field identities that survive that. Omitting it
        // here would make the fake disagree with the server and let a
        // regression in the persistence path pass unnoticed.
        pairings: auth.pairingsFor(key),
        pending: hub.peek(USER).length,
      });
    }

    if (method === 'POST' && path === '/inspector/pair') {
      const result = auth.redeem(key, String(body?.code || ''));
      if (!result.ok) {
        return reply(403, {
          success: false,
          reason: result.reason,
          error: 'The authorization code was refused.',
        });
      }
      return reply(200, {
        success: true,
        binding: result.binding,
        target: registry.resolve(result.binding.userId, result.binding.targetFieldId),
        mode: 'remote',
      });
    }

    // ── Disconnect, server side ────────────────────────────────────────────
    // Mirrors POST /inspector/targeting/unpair in mode.routes.ts, including
    // the two halves that matter most: `unpair` drops the DURABLE pairing, and
    // `unbindForUser` drops the LIVE bindings the extension's automatic
    // binding adoption reads. Omitting the second half would leave this fake
    // MORE permissive than the server — the next AB_INSPECTOR_SESSION would
    // silently re-adopt the connection the user just disconnected, and the
    // "Disconnect must actually disconnect" regression would pass unnoticed.
    if (method === 'POST' && path === '/inspector/targeting/unpair') {
      const pairingKey = String(body?.pairingKey || '');
      if (!auth.isPairedForUser(USER, pairingKey)) {
        return reply(200, { success: true, unpaired: 0, pairingKey });
      }
      consent.clearForPairing(USER, pairingKey);
      const unpaired = auth.unpair(pairingKey);
      auth.unbindForUser(USER, String(body?.targetFieldId || ''), pairingKey);
      return reply(200, { success: true, unpaired, pairingKey });
    }

    // ── The REMOTE consent handshake ──────────────────────────────────────
    // Mirrors mode.routes.ts, including the two properties that matter most:
    // the pending list withholds the address, and `decide` is the ONLY thing
    // that grants. A convenience fake that returned the target in the list, or
    // granted on GET, would let a broken extension pass.
    if (method === 'GET' && path === '/inspector/consent') {
      // The environment filter is passed through exactly as the real route does
      // (query first, then header), so this fake cannot serve a remote prompt to
      // a caller that declared itself local. Without it the fake would be MORE
      // permissive than the server and the scoping could regress unseen.
      const declared = String(
        query.get('environment') || headers['x-browser-environment'] || '',
      ).trim().toLowerCase();
      const filter = declared === 'local' ? 'local' : (declared === 'remote' ? 'remote' : '');
      const requestsOut = consent.pendingFor(USER, Date.now(), filter);
      return reply(200, { success: true, count: requestsOut.length, requests: requestsOut });
    }

    if (method === 'POST' && path === '/inspector/consent/decide') {
      const id = String(body?.consentId || '');
      const approve = body?.approve !== false;
      const current = consent.get(id);
      if (!current) {
        return reply(404, {
          success: false, reason: 'consent_not_found',
          error: 'That request is no longer waiting for an answer.',
        });
      }
      const decision = consent.decide(id, approve);
      if (!decision.ok) {
        return reply(decision.reason === 'expired' ? 410 : 409, {
          success: false, reason: decision.reason, error: 'That request could not be answered.',
        });
      }
      if (!approve) {
        return reply(200, { success: true, approved: false, consentId: id });
      }
      const req = decision.request!;
      // Authority is created HERE and nowhere else — the same grant a redeemed
      // code performs, which is what keeps "code" and "consent" one concept.
      const binding = auth.grant(key, req.userId, req.targetFieldId, req.pairingKey);
      return reply(200, {
        success: true,
        approved: true,
        consentId: id,
        targetFieldId: req.targetFieldId,
        pairingKey: req.pairingKey,
        binding,
        target: registry.resolve(req.userId, req.targetFieldId),
      });
    }

    if (method === 'POST' && path === '/inspector/element') {
      posted.push(body || {});
      const result = hub.submit(USER, {
        targetFieldId: String(body?.targetFieldId || ''),
        apiKey: key,
        element: body?.element as never,
        displayAttributes: (body?.displayAttributes as string[]) || [],
        sendAttribute: (body?.sendAttribute as never) || { name: '' },
        mode: 'remote',
      });
      if (!result.ok) {
        return reply(409, {
          success: false,
          reason: result.reason,
          error: 'The element could not be delivered.',
          targets: registry.list(USER),
        });
      }
      const d = result.delivery!;
      return reply(200, {
        success: true,
        targetFieldId: d.target.targetFieldId,
        nodeName: d.target.label || d.target.nodeId,
        fieldName: d.target.fieldKey,
        attribute: d.attribute,
        value: d.value,
        delivery: d,
      });
    }

    return reply(404, { success: false, error: 'not_found' });
  }

  const sandbox: Record<string, unknown> = {
    chrome,
    fetch: fakeFetch,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    // `bootstrap.config.js` is absent from the authored extension (it is written
    // only into the server-seeded copy), so this must throw for it — the same
    // normal case a hand-installed copy hits. With `managed: true` the harness
    // supplies it instead, exactly as the server-seeded REMOTE copy does.
    importScripts: (file: string) => {
      if (file === 'bootstrap.config.js') {
        if (!opts.managed) throw new Error('not found');
        // Field for field what bootstrapSource() emits in
        // src/core/InspectorExtension.ts — but carrying THIS harness's backend
        // rather than a literal 127.0.0.1:3000.
        //
        // applyBootstrapDefaults() writes these into empty storage keys, and the
        // worker is loaded BEFORE worker() assigns ab_baseUrl/ab_apiKey, so a
        // different address here would win the race and every request would go to
        // an origin the fake fetch does not serve (observed as http_404 on a
        // route that exists).
        vm.runInContext(
          `var AB_BOOTSTRAP = { baseUrl: ${JSON.stringify(BASE)},`
          + ` apiKey: ${JSON.stringify(API_KEY)},`
          + ` userId: ${JSON.stringify(USER)}, managed: true };`,
          sandbox as never,
          { filename: 'bootstrap.config.js' },
        );
        return;
      }
      const p = resolve(__dirname, '../../extension', file);
      vm.runInContext(readFileSync(p, 'utf8'), sandbox as never, { filename: file });
    },
    setTimeout,
    clearTimeout,
    EventSource: function EventSourceStub() { /* live events are not under test */ },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(resolve(__dirname, '../../extension/background.js'), 'utf8'),
    sandbox as never,
    { filename: 'background.js' },
  );

  if (!listener) throw new Error('background.js registered no onMessage listener');

  return {
    hub,
    registry,
    auth,
    consent,
    storage,
    requests,
    posted,
    askFor(targetFieldId: string) {
      const target = registry.resolve(USER, targetFieldId);
      if (!target) throw new Error('fixture target missing');
      const raised = consent.request({
        userId: USER,
        targetFieldId,
        pairingKey: target.pairingKey,
        nodeId: target.nodeId,
        fieldKey: target.fieldKey,
        label: target.label,
        action: target.action,
      });
      if (!raised) throw new Error('fixture consent not raised');
      return raised.request.consentId;
    },
    openField(opts = {}) {
      const reg = registry.register(USER, {
        nodeId: opts.nodeId ?? 'node-7',
        fieldKey: opts.fieldKey ?? 'selector',
        action: opts.action ?? 'click',
        label: opts.label,
      });
      if (!reg.ok || !reg.target) throw new Error(`fixture target rejected: ${reg.reason}`);
      return reg.target.targetFieldId;
    },
    codeFor(targetFieldId: string) {
      // Mint the code the way the ROUTE does — against the target's stable
      // pairing key, not just its address.
      //
      // `issue()` falls back to the targetFieldId when the key is omitted, so
      // omitting it here would file the fixture's pairing under an address and
      // make the harness disagree with the server about what "paired" means.
      // The durable-pairing tests below would then fail against correct code,
      // which is a fixture lying rather than a defect found.
      const target = registry.resolve(USER, targetFieldId);
      const offer = auth.issue(USER, targetFieldId, Date.now(), target?.pairingKey);
      if (!offer) throw new Error('fixture offer not issued');
      return offer.code;
    },
    send(msg: Msg) {
      return new Promise<Record<string, unknown>>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no reply to ${String(msg.type)}`)), 5000);
        const ok = (listener as Listener)(msg, null, (r) => {
          clearTimeout(t);
          res((r || {}) as Record<string, unknown>);
        });
        if (ok !== true) { clearTimeout(t); rej(new Error(`handler declined ${String(msg.type)}`)); }
      });
    },
  };
}

/** A picked element, in the shape content/inspector.js sends. */
function pickedElement() {
  return {
    tag: 'a',
    id: 'buy',
    classes: ['btn'],
    css: 'a#buy',
    xpath: '//*[@id="buy"]',
    text: 'Buy now',
    value: '',
    name: '',
    role: 'link',
    type: '',
    attrs: [
      { name: 'href', value: '/checkout' },
      { name: 'data-sku', value: 'SKU-1' },
    ],
  };
}

/** A confirmed pick: one radio-selected attribute plus some display ticks. */
function submitMsg(extra: Msg = {}): Msg {
  return {
    type: 'ab-inspector-submit',
    element: pickedElement(),
    displayAttributes: ['css', 'text'],
    sendAttribute: { name: 'css', value: 'a#buy' },
    ...extra,
  };
}

/** Pair the worker to a fresh field the way the user does, and return its id. */
async function pairTo(h: Harness, opts: Parameters<Harness['openField']>[0] = {}) {
  const id = h.openField(opts);
  const res = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: h.codeFor(id) } });
  if (!res.ok) throw new Error(`fixture pairing failed: ${JSON.stringify(res)}`);
  return id;
}

let h: Harness;
beforeEach(() => {
  h = loadWorker();
  h.storage.ab_baseUrl = BASE;
  h.storage.ab_apiKey = API_KEY;
  h.storage.ab_userId = USER;
});

// ── The fixtures must be real, or every assertion below is theatre ──────────
describe('the harness drives the real seam', () => {
  it('registers through the real registry and pairs through the real code', async () => {
    const id = h.openField();
    expect(id).toMatch(/^node_/);
    // The id is minted by the SERVER, and carries the field it points at.
    expect(id).toContain('selector');

    const before = h.auth.bindingsFor(API_KEY);
    expect(before).toHaveLength(0);

    const res = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: h.codeFor(id) } });
    expect(res.ok).toBe(true);
    // Proven against the registry, not against the reply the worker composed.
    expect(h.auth.isAuthorized(API_KEY, USER, id)).toBe(true);
  });
});

describe('the destination a pick is sent to', () => {
  it('sends the id the PROJECT minted, not one the extension invented', async () => {
    const id = await pairTo(h);

    const res = await h.send(submitMsg());

    expect(res.ok).toBe(true);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.targetFieldId).toBe(id);
    // The regression guard for the original bug: an id authored HERE could never
    // match a destination registered THERE, and that is how the feature died.
    expect(String(h.posted[0]!.targetFieldId)).not.toMatch(/^ext-/);
    expect(String(h.posted[0]!.targetFieldId)).not.toMatch(/^ui-/);
  });

  it('never sends a targetFieldId while pairing — §8, the code decides', async () => {
    const id = h.openField();
    await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: h.codeFor(id) } });

    const pair = h.requests.filter((r) => r.path === '/inspector/pair');
    expect(pair).toHaveLength(1);
    // «The Extension must NEVER be able to choose an arbitrary Target Field.»
    // If the id travelled in the pairing body, a caller could swap it for
    // another and bind itself to a field it was never offered.
    expect(Object.keys(pair[0]!.body || {})).toEqual(['code']);
  });

  it('presents the API key as a credential rather than in the body', async () => {
    await pairTo(h);
    await h.send(submitMsg());

    const post = h.requests.filter((r) => r.path === '/inspector/element')[0]!;
    expect(post.key).toBe(API_KEY);
    // A body-supplied key would let any caller claim another client's pairing.
    expect(post.body).not.toHaveProperty('apiKey');
  });

  it('keeps sending to the paired field after the worker is restarted', async () => {
    const id = await pairTo(h, { fieldKey: 'selector', label: 'Click #buy' });
    // MV3 kills the worker aggressively; the destination is a user CHOICE, so
    // re-deriving it would silently retarget the next pick.
    expect(h.storage.ab_targetFieldId).toBe(id);

    // Same profile, same backend, brand new worker — no in-memory state carried
    // across, exactly like a service worker that was torn down and respawned.
    const revived = loadWorker({ reuse: h });
    const res = await revived.send(submitMsg());

    expect(res.ok).toBe(true);
    expect(res.targetFieldId).toBe(id);
    // It did NOT have to be re-paired: no second trip to /inspector/pair.
    expect(revived.requests.filter((r) => r.path === '/inspector/pair')).toHaveLength(0);
    expect(revived.hub.peek(USER)[0]!.fields).toEqual({ selector: 'a#buy' });
  });
});

describe('the pick actually lands in the paired field', () => {
  it('writes into the registered field, and names it back to the user', async () => {
    const id = await pairTo(h, { nodeId: 'node-7', fieldKey: 'selector', label: 'Click #buy' });

    const res = await h.send(submitMsg());

    expect(res.ok).toBe(true);
    // §24: the confirmation NAMES the destination — that is what proves the
    // value did not quietly go somewhere else.
    expect(res.node).toBe('Click #buy');
    expect(res.field).toBe('selector');
    expect(res.attribute).toBe('css');
    expect(res.value).toBe('a#buy');
    expect(res.targetFieldId).toBe(id);

    const inbox = h.hub.peek(USER);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.target.nodeId).toBe('node-7');
    expect(inbox[0]!.fields).toEqual({ selector: 'a#buy' });
  });

  it('writes into a DIFFERENT field when a different field was paired', async () => {
    // The whole point of field-level targeting: same node, same element, and the
    // value must still land under the key that was actually registered.
    await pairTo(h, { nodeId: 'node-7', fieldKey: 'text', action: 'type', label: 'Type text' });

    const res = await h.send(submitMsg());

    expect(res.ok).toBe(true);
    expect(res.field).toBe('text');
    expect(h.hub.peek(USER)[0]!.fields).toEqual({ text: 'a#buy' });
  });

  it('sends exactly one value — checkboxes decide display, not what is sent', async () => {
    await pairTo(h);

    // Four ticked for display, one radio selected. §21: exactly ONE goes out.
    await h.send(submitMsg({
      displayAttributes: ['css', 'xpath', 'text', 'data-sku'],
      sendAttribute: { name: 'xpath', value: '//*[@id="buy"]' },
    }));

    const delivery = h.hub.peek(USER)[0]!;
    expect(Object.keys(delivery.fields)).toHaveLength(1);
    expect(delivery.attribute).toBe('xpath');
    expect(delivery.value).toBe('//*[@id="buy"]');
    // The display ticks travelled, but none of them became an outbound value.
    expect(delivery.displayAttributes).toContain('data-sku');
  });

  it('derives the value from the element, ignoring a client-supplied one', async () => {
    await pairTo(h);

    await h.send(submitMsg({
      sendAttribute: { name: 'css', value: 'a#SOMETHING-ELSE' },
    }));

    // A value the server did not compute is a value the user never saw
    // highlighted; the element is the source of truth.
    expect(h.hub.peek(USER)[0]!.value).toBe('a#buy');
  });
});

describe('refusals stay explicit, and name the fix', () => {
  it('refuses with TARGET_NOT_AUTHORIZED before pairing, without posting', async () => {
    const res = await h.send(submitMsg());

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TARGET_NOT_AUTHORIZED');
    // A request whose only possible answer is a refusal is not worth a round
    // trip, and the message the user needs is the same either way.
    expect(h.posted).toHaveLength(0);
    // The fix must be NAMED, so the user knows what to do about it.
    expect(String(res.error)).toMatch(/Authorization Code/i);
  });

  it('refuses when no attribute is radio-selected', async () => {
    await pairTo(h);
    const res = await h.send(submitMsg({ sendAttribute: null }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ATTRIBUTE_SEND_FAILED');
    expect(h.posted).toHaveLength(0);
  });

  it('refuses a submission with no element at all', async () => {
    await pairTo(h);
    const res = await h.send(submitMsg({ element: null }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_element');
    expect(h.posted).toHaveLength(0);
  });

  it('refuses when the extension has not been configured', async () => {
    delete h.storage.ab_apiKey;
    const res = await h.send(submitMsg());
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_api_key');
    expect(h.requests).toHaveLength(0);
  });

  it('reports TARGET_FIELD_NOT_FOUND once the field is closed, and says so', async () => {
    const id = await pairTo(h);
    // The user closed the node. The binding survives; the destination does not.
    h.registry.unregister(USER, id);

    const res = await h.send(submitMsg());

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TARGET_FIELD_NOT_FOUND');
    // It DID reach the server: the extension cannot know the field was closed.
    expect(h.posted).toHaveLength(1);
  });

  it('passes the §27 reason through instead of flattening it to a failure', async () => {
    const res = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: 'NOTACODE' } });

    expect(res.ok).toBe(false);
    // "check what you typed" and "ask for a new code" are different
    // instructions, so a single generic message would withhold the fix.
    expect(res.reason).toBe('INVALID_AUTHORIZATION_CODE');
    expect(h.storage.ab_targetFieldId).toBeFalsy();
  });

  it('refuses an empty code without asking the server', async () => {
    const res = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: '   ' } });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('INVALID_AUTHORIZATION_CODE');
    expect(h.requests.filter((r) => r.path === '/inspector/pair')).toHaveLength(0);
  });
});

describe('one code, one field — a pairing cannot be widened', () => {
  it('does not authorize a second field just because one was paired', async () => {
    await pairTo(h, { nodeId: 'node-1', fieldKey: 'selector' });
    const other = h.openField({ nodeId: 'node-2', fieldKey: 'url', action: 'goto' });

    // Same key, different field: the binding is per-FIELD, not per-extension.
    expect(h.auth.isAuthorized(API_KEY, USER, other)).toBe(false);
  });

  it('re-pairing moves the destination without disturbing the old binding', async () => {
    const first = await pairTo(h, { nodeId: 'node-1', fieldKey: 'selector' });
    const second = await pairTo(h, { nodeId: 'node-2', fieldKey: 'url', action: 'goto' });

    expect(h.storage.ab_targetFieldId).toBe(second);
    // Several destinations coexist; pairing to a new one is a change of AIM,
    // not a revocation of what came before.
    expect(h.auth.isAuthorized(API_KEY, USER, first)).toBe(true);
    expect(h.auth.isAuthorized(API_KEY, USER, second)).toBe(true);

    await h.send(submitMsg());
    expect(h.hub.peek(USER)[0]!.fields).toEqual({ url: 'a#buy' });
  });

  it('a code cannot be redeemed twice', async () => {
    const id = h.openField();
    const code = h.codeFor(id);

    const first = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code } });
    expect(first.ok).toBe(true);

    const second = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code } });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('INVALID_AUTHORIZATION_CODE');
  });
});

describe('unpairing disconnects BOTH halves, and touches nothing else', () => {
  it('forgets the destination AND drops the server binding', async () => {
    const id = await pairTo(h);

    const res = await h.send({ type: 'AB_INSPECTOR_UNPAIR' });
    expect(res.ok).toBe(true);
    expect(h.storage.ab_targetFieldId).toBeFalsy();

    // The binding is adopted AUTOMATICALLY from the server's grant on the next
    // session refresh — no code step remains to gate it. So if the server kept
    // the binding here, Disconnect would silently re-attach itself one refresh
    // later and be a button that does nothing. Disconnect must disconnect.
    expect(h.auth.isAuthorized(API_KEY, USER, id)).toBe(false);
    expect(h.auth.pairingsFor(API_KEY)).toHaveLength(0);
  });

  it('leaves the Handoff pairing completely alone', async () => {
    await pairTo(h);
    // The Remote/Local Handoff is a SEPARATE subsystem with its own code and its
    // own stored session. Unpairing the Inspector must not sign the user out of
    // the browser session they are driving.
    h.storage.abHandoff = { token: 'as_deadbeef', pairedAt: 1 };

    await h.send({ type: 'AB_INSPECTOR_UNPAIR' });

    expect(h.storage.abHandoff).toEqual({ token: 'as_deadbeef', pairedAt: 1 });
  });

  it('refuses to send once unpaired, rather than guessing a destination', async () => {
    await pairTo(h);
    await h.send({ type: 'AB_INSPECTOR_UNPAIR' });

    const res = await h.send(submitMsg());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TARGET_NOT_AUTHORIZED');
    expect(h.posted).toHaveLength(0);
  });
});

describe('what the popup is told about the connection', () => {
  it('reports the paired field, resolved to something a human can read', async () => {
    const id = await pairTo(h, { nodeId: 'node-7', fieldKey: 'selector', label: 'Click #buy' });

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    expect(res.targetFieldId).toBe(id);
    expect(res.authorized).toBe(true);
    // An opaque id tells the user nothing about where their next pick will go.
    expect((res.target as Record<string, unknown>).label).toBe('Click #buy');
    expect((res.target as Record<string, unknown>).fieldKey).toBe('selector');
  });

  it('reports no connection when nothing is paired, rather than inventing one', async () => {
    h.openField();

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    expect(res.targetFieldId).toBe('');
    expect(res.authorized).toBe(false);
    expect(res.target).toBeNull();
  });

  it('reports unauthorized when the paired field has been closed', async () => {
    const id = await pairTo(h);
    h.registry.unregister(USER, id);

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    // Still remembered locally, but honestly reported as unreachable — showing
    // "connected" here is what made the original bug invisible in the UI.
    expect(res.targetFieldId).toBe(id);
    expect(res.target).toBeNull();
  });

  it('does not present another API key\u2019s pairing as its own', async () => {
    const id = h.openField();
    // Somebody else redeemed a code for this field.
    h.auth.redeem('someone-elses-key', h.codeFor(id));
    // This extension merely remembers the id, without ever having paired.
    h.storage.ab_targetFieldId = id;

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    expect(res.authorized).toBe(false);
  });
});

// ── The durable half: an Extension remembers the FIELD, not the address ─────
//
// «دفعات بعد برای همان Extension و همان Target Field، دیگر نیازی به
// Authorization Code جدید نیست» — the next time round, for the SAME extension
// and the SAME Target Field, no new Authorization Code is needed.
//
// That promise cannot be kept by `ab_targetFieldId` alone. A targetFieldId is
// an ADDRESS: it is minted fresh every time the NDV registers the field, so it
// has already changed by the operator's "next time". If the extension only
// remembered the address, every re-open would look like a stranger and demand
// another code — which is exactly the behaviour being corrected.
//
// So the extension stores a second thing beside the address: `ab_pairingKey`,
// the stable tf:<workflow>:<node>:<field> IDENTITY. These tests hold the two
// apart, and prove the pairing is keyed to the identity: the address may go
// stale, the worker may be evicted, the field may be re-registered somewhere
// new — the answer to "will I be asked for a code?" must stay "no".
describe('the extension remembers the FIELD, not just the address', () => {
  it('stores the stable pairing key alongside the ephemeral address', async () => {
    const id = await pairTo(h, { nodeId: 'node-7', fieldKey: 'selector' });

    // The address, as before.
    expect(h.storage.ab_targetFieldId).toBe(id);

    // …and the identity, which is a different value of a different shape. The
    // literal is asserted rather than merely "truthy": the extension must file
    // the pairing under the key the SERVER derived, not one it invented, or
    // the two sides would disagree about what is paired.
    expect(h.storage.ab_pairingKey).toBe('tf:-:node-7:selector');
    expect(h.storage.ab_pairingKey).not.toBe(id);
  });

  it('reports itself paired against that identity, not against the address', async () => {
    await pairTo(h);

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    expect(res.paired).toBe(true);
    expect(res.pairingKey).toBe('tf:-:node-7:selector');
  });

  it('STAYS paired after the field is re-registered at a NEW address', async () => {
    const first = await pairTo(h, { nodeId: 'node-7', fieldKey: 'selector' });

    // The operator closes the NDV and opens the very same field again. The
    // project mints a new address for it — this is the ordinary case, not an
    // edge case, and it is what used to force a second code.
    h.registry.unregister(USER, first);
    const second = h.openField({ nodeId: 'node-7', fieldKey: 'selector' });
    expect(second).not.toBe(first);

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    // The address the extension holds is now stale: the registry no longer
    // resolves it, so there is no target record to show. (The old BINDING
    // lingers on its own TTL — bindings are not revoked by a field closing —
    // which is precisely why `authorized` is too weak a signal to build the
    // "no second code" promise on, and why the pairing key exists.)
    expect(res.target).toBeNull();
    expect(res.targetFieldId).toBe(first);
    expect(res.targetFieldId).not.toBe(second);
    // …but the PAIRING is untouched, because it never depended on the address.
    // This is the assertion the operator's requirement reduces to: no second
    // code for the same extension and the same Target Field.
    expect(res.paired).toBe(true);
    expect(res.pairingKey).toBe('tf:-:node-7:selector');
  });

  it('treats a DIFFERENT field as a different pairing, needing its own code', async () => {
    await pairTo(h, { nodeId: 'node-7', fieldKey: 'selector' });

    // «اگر کاربر یک Target Field جدید انتخاب کند، آن هدف جدید نیاز به
    // pairing/Authorization جدید دارد.» A pairing must not be a skeleton key:
    // being paired to one field may never imply being paired to the next.
    // `url` is a declared field of `goto`, not of `click` — the registry
    // rejects an undeclared pairing, which is the coerceParams() guard doing
    // its job rather than an inconvenience to route around.
    const other = h.openField({ nodeId: 'node-9', fieldKey: 'url', action: 'goto' });
    const otherKey = h.registry.resolve(USER, other)!.pairingKey;

    expect(otherKey).toBe('tf:-:node-9:url');
    expect(h.auth.isPaired(API_KEY, USER, otherKey)).toBe(false);
    // …while the original one is still good.
    expect(h.auth.isPaired(API_KEY, USER, 'tf:-:node-7:selector')).toBe(true);
  });

  it('survives an MV3 worker eviction, because it lives in storage', async () => {
    await pairTo(h);

    // MV3 tears the service worker down whenever it feels like it. Anything
    // held in a module-level variable is gone; only chrome.storage.local comes
    // back, which is why the key is written there rather than kept in memory.
    const revived = loadWorker({ reuse: h });
    expect(revived.storage.ab_pairingKey).toBe('tf:-:node-7:selector');

    const res = await revived.send({ type: 'AB_INSPECTOR_SESSION' });

    expect(res.paired).toBe(true);
  });

  it('takes the browser environment from the SERVER, never asserting its own', async () => {
    const reg = h.registry.register(USER, {
      nodeId: 'node-7',
      fieldKey: 'selector',
      action: 'click',
      environment: 'local',
    });
    const id = reg.target!.targetFieldId;
    await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: h.codeFor(id) } });

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    // The environment is a property of the TARGET, decided in the dashboard's
    // chooser. The extension reports what it was told; it does not get a vote,
    // for the same reason it does not get to choose its own Target Field.
    expect(res.environment).toBe('local');
    expect(h.storage.ab_targetEnvironment).toBe('local');
  });

  it('forgets the durable key on unpair, so a code is offered again', async () => {
    await pairTo(h);
    expect(h.storage.ab_pairingKey).toBe('tf:-:node-7:selector');

    await h.send({ type: 'AB_INSPECTOR_UNPAIR' });

    // Both halves must go. Leaving the identity behind would have the popup
    // announce "paired" for a field this extension has deliberately released,
    // and the operator would never be offered the code that reconnects it.
    expect(h.storage.ab_pairingKey).toBe('');
    expect(h.storage.ab_targetFieldId).toBe('');
    expect(h.storage.ab_targetEnvironment).toBe('');

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });
    expect(res.paired).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// THE REMOTE CONSENT HANDSHAKE, ACROSS THE SEAM
//
// THE BUG THESE EXIST TO CATCH
// ----------------------------
// The browser on the server is, to this extension, an ordinary LOCAL browser:
// same code, same storage, and a submit addressed with `ab_targetFieldId`. The
// only writer of that value was inspectorPair() — redeeming an Authorization
// Code — and REMOTE deliberately never issues one. So the value stayed empty,
// submitElement() refused locally with TARGET_NOT_AUTHORIZED before any HTTP
// request was made, and the operator saw:
//
//   «ظاهرا نمدونه به کدوم فیلد باید ارسال بشه» — Connection failed: network
//
// Note what the OLD tests could not have caught: they pair with a CODE, so
// `ab_targetFieldId` was always written and the seam always looked healthy. The
// gap was a path with no code in it at all, so it needs tests with no code in
// them at all — which is why every test below asserts zero codes were minted.
// ════════════════════════════════════════════════════════════════

describe('REMOTE consent — the extension learns its destination without a code', () => {
  /**
   * A configured worker.
   *
   * These tests each need their OWN worker (several boot two of them to model a
   * service-worker restart), so they cannot lean on the shared `beforeEach`
   * above — and an unconfigured worker fails inspectorContext() with
   * `no_base_url`, which would make every assertion below fail for a reason that
   * has nothing to do with consent.
   */
  function worker(opts: WorkerOpts = {}): Harness {
    // `managed: true` — every test in THIS block describes the browser the
    // server launched and side-loaded the extension into. That is the only
    // browser the consent handshake is for, and background.js now refuses to
    // list or answer prompts anywhere else (the reported defect was this Alert
    // appearing in the operator's own Chrome during a LOCAL session).
    const w = loadWorker({ managed: true, ...opts });
    w.storage.ab_baseUrl = BASE;
    w.storage.ab_apiKey = API_KEY;
    w.storage.ab_userId = USER;
    return w;
  }

  it('sees the question but NOT the address', async () => {
    // The security property that makes the handshake meaningful. If the address
    // were in the list, this extension could store it and submit without ever
    // asking anyone — «The Extension must NEVER be able to choose an arbitrary
    // Target Field», re-entered through the door built to enforce it.
    const h = worker();
    const id = h.openField({ nodeId: 'search-box', label: 'Click → Selector' });
    h.askFor(id);

    const res = await h.send({ type: 'AB_CONSENT_LIST' });
    expect(res.ok).toBe(true);
    const list = res.requests as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);

    // What a human needs in order to answer is present…
    expect(list[0].nodeId).toBe('search-box');
    expect(list[0].fieldKey).toBe('selector');
    expect(list[0].action).toBe('click');
    expect(typeof list[0].consentId).toBe('string');
    // …and what a machine needs in order to bypass the human is not.
    expect(list[0].targetFieldId).toBeUndefined();
    expect(list[0].pairingKey).toBeUndefined();
  });

  it('stores NOTHING while the prompt is merely listed', async () => {
    // Polling must not be the thing that connects. Only Allow may.
    const h = worker();
    h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_LIST' });
    expect(h.storage.ab_targetFieldId).toBeFalsy();
    expect(h.storage.ab_pairingKey).toBeFalsy();
  });

  it('Allow writes the destination — the line that was missing', async () => {
    const h = worker();
    const id = h.openField({ nodeId: 'search-box' });
    const consentId = h.askFor(id);

    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(res.ok).toBe(true);
    expect(res.approved).toBe(true);

    // THE FIX. This is the write that REMOTE never had.
    expect(h.storage.ab_targetFieldId).toBe(id);
    // And the DURABLE half, so the operator is not re-prompted on every NDV
    // open — otherwise we would have replaced "type a code every time" with
    // "click Allow every time", the same defect in a new spelling.
    expect(h.storage.ab_pairingKey).toBeTruthy();
    expect(h.storage.ab_targetEnvironment).toBeTruthy();
  });

  it('and a pick then actually LANDS — no code anywhere in the flow', async () => {
    // The end of the reported failure, measured through the real hub rather than
    // inferred from stored strings.
    const h = worker();
    const id = h.openField({ nodeId: 'search-box', label: 'Click → Selector' });
    const consentId = h.askFor(id);
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });

    const sent = await h.send(submitMsg());
    expect(sent.ok).toBe(true);

    const delivered = h.hub.peek(USER);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].target.targetFieldId).toBe(id);
    expect(delivered[0].value).toBe('a#buy');

    // Zero Authorization Codes were involved, which is the requirement.
    expect(h.auth.pendingCount()).toBe(0);
    expect(h.requests.some((r) => r.path === '/inspector/pair')).toBe(false);
  });

  it('addresses the submit with the id it was GIVEN, never one it chose', async () => {
    const h = worker();
    const id = h.openField();
    const consentId = h.askFor(id);
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    await h.send(submitMsg());

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].targetFieldId).toBe(id);
    // The decision request carried a handle and a boolean — never a target.
    const decide = h.requests.filter((r) => r.path === '/inspector/consent/decide')[0];
    expect(decide.body).toBeTruthy();
    expect(Object.keys(decide.body as object).sort()).toEqual(['approve', 'consentId']);
  });

  it('presents its own credential when answering', async () => {
    // The grant is made against the ANSWERING key, so a body-supplied key would
    // let any caller claim another client's pairing.
    const h = worker();
    const consentId = h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    const decide = h.requests.filter((r) => r.path === '/inspector/consent/decide')[0];
    expect(decide.key).toBe(API_KEY);
  });

  it('Deny attaches nothing', async () => {
    const h = worker();
    const consentId = h.askFor(h.openField());
    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: false } });
    expect(res.ok).toBe(true);
    expect(res.approved).toBe(false);
    expect(h.storage.ab_targetFieldId).toBeFalsy();
  });

  it('an undefined approve flag is NOT approval', async () => {
    // A malformed message must never be read as consent.
    const h = worker();
    const consentId = h.askFor(h.openField());
    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId } });
    expect(res.approved).toBeFalsy();
    expect(h.storage.ab_targetFieldId).toBeFalsy();
  });

  it('declining a NEW field does not disconnect the field already in use', async () => {
    // The operator is working in node A and waves away a prompt for node B.
    // Losing A's connection because they declined B would be a data-loss bug
    // dressed as a permission check.
    const h = worker();
    const a = h.openField({ nodeId: 'search-box' });
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId: h.askFor(a), approve: true } });
    expect(h.storage.ab_targetFieldId).toBe(a);

    const b = h.openField({ nodeId: 'submit-btn' });
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId: h.askFor(b), approve: false } });

    expect(h.storage.ab_targetFieldId).toBe(a);
    expect((await h.send(submitMsg())).ok).toBe(true);
  });

  it('two nodes, one browser: the APPROVED field receives the pick', async () => {
    // «دو تا فیلد با نودهای متفاوت … نمیدونه کدوم فیلد باید ارسال بشه»
    // Both prompts are live at once. Answering the SECOND must send there —
    // not to the first, and not to whichever the server happened to mint last.
    const h = worker();
    const a = h.openField({ nodeId: 'search-box' });
    const b = h.openField({ nodeId: 'submit-btn' });
    h.askFor(a);
    const consentB = h.askFor(b);

    const listed = (await h.send({ type: 'AB_CONSENT_LIST' })).requests as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(2);

    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId: consentB, approve: true } });
    await h.send(submitMsg());

    const delivered = h.hub.peek(USER);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].target.nodeId).toBe('submit-btn');
  });

  it('re-answering the same prompt is refused, not silently re-granted', async () => {
    const h = worker();
    const consentId = h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    const again = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('already_decided');
  });

  it('reports an unknown handle instead of pretending it worked', async () => {
    const h = worker();
    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId: 'cns_nope' } });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('consent_not_found');
    expect(h.storage.ab_targetFieldId).toBeFalsy();
  });

  it('refuses an empty handle without making a request at all', async () => {
    const h = worker();
    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId: '' } });
    expect(res.ok).toBe(false);
    expect(h.requests.some((r) => r.path === '/inspector/consent/decide')).toBe(false);
  });

  it('the answered prompt leaves the queue, so it is not asked twice', async () => {
    const h = worker();
    const consentId = h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect((await h.send({ type: 'AB_CONSENT_LIST' })).count).toBe(0);
  });

  it('the connection survives a service-worker restart', async () => {
    // MV3 kills workers aggressively. A consent-granted pairing has to be as
    // durable as a code-granted one or the operator is re-prompted at random.
    const first = worker();
    const id = first.openField();
    const consentId = first.askFor(id);
    await first.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });

    const restarted = worker({ reuse: first });
    expect(restarted.storage.ab_targetFieldId).toBe(id);
    expect((await restarted.send(submitMsg())).ok).toBe(true);
  });

  it('unpairing locally clears a consent-granted target too', async () => {
    // Otherwise the popup would keep reporting "paired" for a field the operator
    // deliberately let go of.
    const h = worker();
    const consentId = h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    await h.send({ type: 'AB_INSPECTOR_UNPAIR' });
    expect(h.storage.ab_targetFieldId).toBeFalsy();
    expect(h.storage.ab_pairingKey).toBeFalsy();
  });

  /* --------------------------------------------------------------------------
     ...AND NOT IN THE OPERATOR'S OWN BROWSER

     Same worker, same server, same pending prompt — only the browser differs.
     `managed: false` is a hand-installed extension, i.e. the operator's personal
     Chrome, which is where the Alert was reported appearing during a LOCAL
     session minutes after they had already authorized with a code.
     -------------------------------------------------------------------------- */

  /** A LOCAL browser: no server-seeded bootstrap, so no `AB_BOOTSTRAP.managed`. */
  function localWorker(opts: WorkerOpts = {}): Harness {
    const w = loadWorker({ ...opts, managed: false });
    w.storage.ab_baseUrl = BASE;
    w.storage.ab_apiKey = API_KEY;
    w.storage.ab_userId = USER;
    return w;
  }

  it('a LOCAL browser is told nothing is pending, and asks the server nothing', async () => {
    const h = localWorker();
    h.askFor(h.openField());

    const res = await h.send({ type: 'AB_CONSENT_LIST' });
    // `ok` with an empty list, not an error: "nothing is pending for you" is the
    // TRUTH in a local browser, which binds by redeeming an Authorization Code.
    // An error would make the caller back off and retry as if broken.
    expect(res.ok).toBe(true);
    expect(res.requests).toEqual([]);
    expect(res.count).toBe(0);
    // The request is never made at all, so even a server that forgot to filter
    // could not produce an Alert here.
    expect(h.requests.some((r) => r.path === '/inspector/consent')).toBe(false);
  });

  it('a LOCAL browser cannot complete a remote grant even holding a valid handle', async () => {
    // Gating only the LIST would leave the write to `ab_targetFieldId` reachable
    // from a stale card left in a tab by an earlier remote session.
    const h = localWorker();
    const consentId = h.askFor(h.openField());

    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('wrong_environment');
    // Nothing attached, and nothing even asked of the server.
    expect(h.storage.ab_targetFieldId).toBeFalsy();
    expect(h.requests.some((r) => r.path === '/inspector/consent/decide')).toBe(false);
  });

  it('the same prompt is still there for the REMOTE browser', async () => {
    // Proves the refusal above is SCOPING and not destruction: a local browser
    // declining to look must not consume or expire the question the server's
    // browser still has to answer.
    const shared = worker();
    const consentId = shared.askFor(shared.openField());

    const local = localWorker({ reuse: shared });
    await local.send({ type: 'AB_CONSENT_LIST' });
    await local.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });

    const list = await shared.send({ type: 'AB_CONSENT_LIST' });
    expect(list.count).toBe(1);
    const ok = await shared.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(ok.ok).toBe(true);
    expect(ok.approved).toBe(true);
  });

  it('declares its environment on the wire when it does ask', async () => {
    // The server filters on the DECLARED environment, so a client that polls
    // without declaring is served remote prompts for backward compatibility —
    // exactly the ungated behaviour that caused the report.
    const h = worker();
    h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_LIST' });

    const asked = h.requests.filter((r) => r.path === '/inspector/consent');
    expect(asked).toHaveLength(1);
    expect(asked[0].query).toBe('remote');
    expect(asked[0].declaredEnv).toBe('remote');
  });
});
