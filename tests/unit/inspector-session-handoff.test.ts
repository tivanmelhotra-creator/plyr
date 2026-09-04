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
  /**
   * Deliver a message to the worker as a CONTENT SCRIPT would. A content script
   * always arrives with `sender.tab`; by default this models the ACTIVE tab
   * (id 1 — the one `chrome.tabs.query({active:true})` answers with), because
   * the consent poll is now answered by ownership: only the active tab is told
   * the pending prompts. Pass another sender to model a background tab.
   */
  send(msg: Msg, sender?: unknown): Promise<Record<string, unknown>>;
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
  /**
   * Bind this extension's API key to a field the way the SERVER now does.
   *
   * REPLACES codeFor(). There is no Authorization Code to mint: both browsers
   * belong to this server, so `/inspector/targeting/begin` calls
   * `inspectorAuth.grant()` itself (`plan.serverMayGrant`, true for LOCAL as
   * well as REMOTE) the moment the crosshair is used. This helper performs that
   * same grant, against the same registry, so a fixture cannot claim an
   * authority the real route would not have created.
   *
   * Returns the durable pairing key, because that — not the address — is what
   * the grant is filed under.
   */
  grantFor(targetFieldId: string): string;
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

    // ── THE REMOTE CREDENTIAL PATH ──────────────────────────────────
    //
    // `/inspector/pair` IS SERVED AGAIN, and `/inspector/authorize` is STILL not.
    // That asymmetry is deliberate on the server, so the fake reproduces it.
    //
    // This file previously served NEITHER and asserted that the extension called
    // neither, which was correct while the project believed no environment needed
    // a code. It only ever half-believed it — the premise «no code anywhere» was
    // reached by reasoning that BOTH environments were the server's own browser,
    // and one of them is not:
    //
    //   «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند … پس ما هم به یک اتورایز
    //    نیاز داریم»
    //
    // REMOTE is a browser on the operator's own machine. This server has no
    // channel into it, so it cannot raise a prompt there and cannot vouch for it
    // — a carried credential is the only handshake available. So `/inspector/pair`
    // is back, mirrored here through the REAL auth.redeem() so a redemption in
    // this file creates authority the same way the route does.
    //
    // `/inspector/authorize` stays absent, and that is the guard worth keeping:
    // minting now happens INSIDE `/inspector/targeting/begin`, after the field is
    // registered, so a code cannot exist that names no field. A standalone mint
    // route is exactly how one could — which is how the operator ended up holding
    // a code while Target stayed empty.
    if (method === 'POST' && path === '/inspector/pair') {
      const result = auth.redeem(key, String(body?.code || ''));
      if (!result.ok) {
        // 403 with a §27 reason, as the route answers: the request was
        // well-formed and the credential was not accepted.
        return reply(403, {
          success: false,
          reason: result.reason || 'INVALID_AUTHORIZATION_CODE',
          error: 'That authorization code was not accepted.',
        });
      }
      // The destination comes off the BINDING the server just created, never off
      // anything the caller sent — §8, on the one path where the extension does
      // speak first.
      return reply(200, {
        success: true,
        paired: true,
        environment: 'remote',
        targetFieldId: result.binding.targetFieldId,
        userId: result.binding.userId,
      });
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
    grantFor(targetFieldId: string) {
      // Granted against the target's STABLE pairing key, not just its address —
      // the same argument order `/inspector/targeting/begin` uses. Filing a
      // fixture's authority under an address instead would make the harness
      // disagree with the server about what "paired" means, and the
      // durable-pairing tests below would then fail against correct code: a
      // fixture lying rather than a defect found.
      const target = registry.resolve(USER, targetFieldId);
      if (!target) throw new Error('fixture target missing');
      const binding = auth.grant(API_KEY, USER, targetFieldId, target.pairingKey);
      if (!binding) throw new Error('fixture grant refused');
      return target.pairingKey;
    },
    send(msg: Msg, sender: unknown = { tab: { id: 1, windowId: 1 } }) {
      return new Promise<Record<string, unknown>>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no reply to ${String(msg.type)}`)), 5000);
        const ok = (listener as Listener)(msg, sender, (r) => {
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

/**
 * Put the worker in the state the crosshair leaves it in, and return the id.
 *
 * WHAT THIS USED TO DO, AND WHY IT CANNOT ANY MORE
 * -----------------------------------------------
 * It sent `AB_INSPECTOR_PAIR` with a minted code, and the worker's reply is what
 * wrote `ab_targetFieldId`. Both halves of that are gone: the message is not
 * handled, and the route it posted to is deleted.
 *
 * The state it produced is still exactly the state the tests need, so it is now
 * reached the way production reaches it, in the same two parts:
 *
 *   1. THE SERVER grants the authority — `/inspector/targeting/begin` does this
 *      itself for both environments now, which is the whole correction.
 *   2. THE BROWSER learns the destination — for REMOTE by approving the consent
 *      prompt (consentDecide, exercised end-to-end in the last describe below);
 *      for LOCAL the server-launched browser is handed it the same way.
 *
 * Part 2 is written straight into storage here rather than driven through a
 * message, and that is deliberate: this helper is a FIXTURE for the tests about
 * what happens AFTER a binding exists. Driving consent through the worker for
 * every one of them would make thirty tests depend on the consent path, so a
 * single consent regression would fail all thirty and localise nothing. The
 * consent path has its own describe that drives it properly and asserts these
 * same two keys, which is what keeps this shortcut honest.
 */
async function pairTo(h: Harness, opts: Parameters<Harness['openField']>[0] = {}) {
  const id = h.openField(opts);
  const pairingKey = h.grantFor(id);
  h.storage.ab_targetFieldId = id;
  h.storage.ab_pairingKey = pairingKey;
  const target = h.registry.resolve(USER, id);
  if (target?.environment) h.storage.ab_targetEnvironment = target.environment;
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
  it('registers through the real registry and binds through the real grant', async () => {
    const id = h.openField();
    expect(id).toMatch(/^node_/);
    // The id is minted by the SERVER, and carries the field it points at.
    expect(id).toContain('selector');

    const before = h.auth.bindingsFor(API_KEY);
    expect(before).toHaveLength(0);

    // The authority is created by the SERVER, exactly as the targeting route
    // creates it. Asserted against the registry rather than against a reply the
    // worker composed, so the fixture cannot fake being authorized.
    const pairingKey = h.grantFor(id);
    expect(pairingKey).toBe('tf:-:node-7:selector');
    expect(h.auth.isAuthorized(API_KEY, USER, id)).toBe(true);
  });

  it('reaches for no code route on the paths a bound field drives', async () => {
    // Re-aimed, not weakened. It used to assert that NO path in the extension
    // ever touches a code route, which stopped being true when `/inspector/pair`
    // came back for REMOTE. What must still hold is that the ROUTINE lifecycle
    // — submitting, reporting, releasing — never reaches for a credential: those
    // paths run identically in both environments, and a code fetched from one of
    // them would be a code the operator never asked for.
    //
    // The pairing here is a GRANT, i.e. the LOCAL shape: the server bound the
    // field, and nothing was redeemed to get there.
    await pairTo(h);
    await h.send(submitMsg());
    await h.send({ type: 'AB_INSPECTOR_SESSION' });
    await h.send({ type: 'AB_INSPECTOR_UNPAIR' });

    const codePaths = h.requests.filter(
      (r) => r.path === '/inspector/pair' || r.path === '/inspector/authorize',
    );
    expect(codePaths).toEqual([]);
    // And it did real work, so the emptiness above is not "made no requests".
    expect(h.requests.length).toBeGreaterThan(0);
  });

  it('still asks for no MINT route, even on the path that does redeem', async () => {
    // `/inspector/authorize` is the one that stays gone, and this is the test
    // that keeps it gone. Minting lives inside `/inspector/targeting/begin`,
    // after the field is registered, so a code always names a field. A separate
    // mint route is how a code could exist naming none — which is the state the
    // operator described: holding a code, with Target still empty.
    const id = h.openField();
    const target = h.registry.resolve(USER, id);
    const offer = h.auth.issue(USER, id, Date.now(), target!.pairingKey);
    const res = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: offer!.code } });

    expect(res.ok).toBe(true);
    expect(h.requests.some((r) => r.path === '/inspector/pair')).toBe(true);
    expect(h.requests.some((r) => r.path === '/inspector/authorize')).toBe(false);
  });

  it('handles AB_INSPECTOR_PAIR, and binds the field the CODE named', async () => {
    // The inverse of what this test asserted. It required the dispatcher not even
    // to RECOGNISE the message, on the premise that no environment needs a code
    // — and the premise was half right: LOCAL does not. REMOTE is a browser on
    // another machine, and a carried code is the only handshake this server can
    // complete with one.
    //
    // Driven through the real redemption, so the assertion is about authority the
    // server created rather than about a string the worker stored.
    const id = h.openField({ nodeId: 'search-box' });
    const target = h.registry.resolve(USER, id);
    const offer = h.auth.issue(USER, id, Date.now(), target!.pairingKey);

    const res = await h.send({
      type: 'AB_INSPECTOR_PAIR',
      payload: { code: offer!.code, baseUrl: BASE },
    });

    expect(res.ok).toBe(true);
    expect(res.paired).toBe(true);
    // Stamped REMOTE by the SERVER, which is the only party that knows: a code
    // is only ever issued on the remote branch of the begin route.
    expect(res.environment).toBe('remote');
    // The destination is the one the code named — the extension never chose it.
    expect(h.storage.ab_targetFieldId).toBe(id);
    expect(h.auth.isAuthorized(API_KEY, USER, id)).toBe(true);
  });

  it('refuses a code the server never issued, and attaches nothing', async () => {
    // The failure has to stay a failure: this is the only message that accepts
    // operator-typed input, so a permissive fallback here would be a way to
    // arrive at a destination without the server having agreed to one.
    const h2 = loadWorker();
    h2.storage.ab_baseUrl = BASE;
    h2.storage.ab_apiKey = API_KEY;
    h2.storage.ab_userId = USER;
    h2.openField();

    const res = await h2.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: 'ZZZZ-9999' } });

    expect(res.ok).toBe(false);
    expect(h2.storage.ab_targetFieldId).toBeFalsy();
  });

  it('asks for a code before making any request at all', async () => {
    // An empty submission must not become a request: the server would answer 403
    // and the operator would read a rejection where the real message is "you have
    // not pasted it yet".
    const res = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: '  ' } });
    expect(res.ok).toBe(false);
    expect(h.requests.some((r) => r.path === '/inspector/pair')).toBe(false);
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

  it('never names a destination in anything it sends — §8, the SERVER decides', async () => {
    // «The Extension must NEVER be able to choose an arbitrary Target Field.»
    //
    // This used to be checked on the pairing body: the id must not travel with
    // the code, or a caller could swap it and bind itself to a field it was never
    // offered. There is no pairing request left, so the property is checked where
    // it now lives — across EVERY request the worker makes while acquiring a
    // destination. The only place a targetFieldId may legitimately appear is the
    // submit, which is addressed TO the field the server already granted.
    const h2 = loadWorker({ managed: true });
    h2.storage.ab_baseUrl = BASE;
    h2.storage.ab_apiKey = API_KEY;
    h2.storage.ab_userId = USER;

    const id = h2.openField();
    const consentId = h2.askFor(id);
    await h2.send({ type: 'AB_CONSENT_LIST' });
    await h2.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });

    // The destination arrived, so the acquisition really happened…
    expect(h2.storage.ab_targetFieldId).toBe(id);
    // …and it was never uttered by this side. Every request up to this point
    // carries no field id of any kind, so there was nothing to substitute.
    for (const r of h2.requests) {
      expect(JSON.stringify(r.body || {})).not.toContain(id);
    }
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
    // The fix must be NAMED, so the user knows what to do about it — and the
    // name changed with the architecture. It used to say "Enter an Authorization
    // Code first", which now points at a control that exists nowhere: the action
    // is in the PROJECT, and for the remote browser it is followed by an
    // approval. A refusal that names a deleted remedy is worse than a generic
    // one, because it sends the user looking.
    expect(String(res.error)).toMatch(/crosshair/i);
    expect(String(res.error)).toMatch(/approve/i);
    expect(String(res.error)).not.toMatch(/Authorization Code/i);
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

  it('does NOT refuse merely because no API key is stored', async () => {
    // THE INVERSION THAT MATTERS MOST IN THIS FILE.
    //
    // This test used to assert `no_api_key`, and that refusal was the engine of
    // the entire reported defect: the popup rendered it as "set the API Key
    // first", which is the only reason it HAD an API key box. Every credential
    // control in the extension existed to satisfy it.
    //
    // A key is now passed through when known and OMITTED when not, never
    // demanded — a server-local request without one is a request the BACKEND is
    // entitled to judge. So an absent key must not stop the work; the binding
    // state decides, exactly as it does with a key present.
    delete h.storage.ab_apiKey;
    const res = await h.send(submitMsg());

    expect(res.ok).toBe(false);
    // Refused for the REAL reason — nothing is bound yet — not for a missing
    // credential.
    expect(res.reason).toBe('TARGET_NOT_AUTHORIZED');
    expect(res.error).not.toBe('no_api_key');
    expect(String(res.error)).not.toMatch(/api key/i);
  });

  it('sends without a key rather than refusing, once a field IS bound', async () => {
    // The other half: with a destination in place and no key stored, the request
    // must actually be MADE. Refusing here is what the credential form existed
    // to prevent, so proving the request travels is proving the form is
    // unnecessary.
    await pairTo(h);
    delete h.storage.ab_apiKey;

    await h.send(submitMsg());

    const post = h.requests.filter((r) => r.path === '/inspector/element')[0];
    expect(post).toBeTruthy();
    // apiFetch sends no x-api-key header for an empty value — it does not invent
    // one, and it does not withhold the request.
    expect(post!.key).toBe('');
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
    // Unchanged in purpose, moved to a refusal that still exists. It used to
    // check INVALID_AUTHORIZATION_CODE from a redeem; the property is that a
    // SPECIFIC, actionable reason survives the trip back to the caller rather
    // than being flattened into "failed", because "not authorized for that
    // field" and "that field is closed" call for different actions.
    const id = await pairTo(h);
    h.registry.unregister(USER, id);

    const res = await h.send(submitMsg());

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TARGET_FIELD_NOT_FOUND');
    // The surviving destinations travel with it, which is what the popup shows
    // instead of leaving the user with a dead end.
    expect(res).toHaveProperty('targets');
  });

  it('judges no code itself — only the server can say what it issued', async () => {
    // Re-aimed. This asserted that the extension contains no code handling at
    // all, which held while the project believed no environment needed a code.
    // REMOTE does. What must NOT come back is the part that was actually wrong:
    // the extension deciding LOCALLY whether a code is acceptable.
    //
    // A client-side verdict is unfalsifiable by definition — only the server
    // knows what it minted, to whom, for which field, and whether it is spent —
    // so a local check can only ever produce a confident wrong answer. That is
    // the shape of the report: apparently connected, Target still empty.
    const bgSrc = readFileSync(resolve(__dirname, '../../extension/background.js'), 'utf8');
    const code = bgSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // No shape/checksum validator, and no locally MANUFACTURED verdict: the
    // reason string may only ever be one the server sent back.
    expect(code).not.toMatch(/isValidPairingCode|validatePairingCode/);
    expect(code).not.toMatch(/reason:\s*'INVALID_AUTHORIZATION_CODE'/);

    // The only two refusals it produces by itself are about EMPTINESS, which is
    // a fact it can actually observe — no address typed, or no code typed.
    const empty = await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: '' } });
    expect(empty.ok).toBe(false);
    expect(h.requests.some((r) => r.path === '/inspector/pair')).toBe(false);

    // Anything else goes to the server and the server's own words come back.
    const id = h.openField();
    await h.send({ type: 'AB_INSPECTOR_PAIR', payload: { code: 'ABCD-1234' } });
    expect(h.requests.some((r) => r.path === '/inspector/pair')).toBe(true);
    expect(id).toBeTruthy();

    // And the refusal on the BOUND-FIELD path still mentions no code, because
    // that path belongs to both environments and LOCAL never has one.
    const res = await h.send(submitMsg());
    expect(String(res.error)).not.toMatch(/code/i);
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

  it('an approval cannot be replayed — the consent replaces the one-time code', async () => {
    // The single-use property is not lost with the code, it MOVED. A consent is
    // the same security object: one-time, server-issued, expiring, single-target,
    // completable only by a person. Proving it cannot be answered twice is what
    // keeps that claim true — a replayable approval would be a strictly weaker
    // object than the code it replaced.
    const w = loadWorker({ managed: true });
    w.storage.ab_baseUrl = BASE;
    w.storage.ab_apiKey = API_KEY;
    w.storage.ab_userId = USER;

    const consentId = w.askFor(w.openField());

    const first = await w.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(first.ok).toBe(true);
    expect(first.approved).toBe(true);

    const second = await w.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(second.ok).toBe(false);
  });
});

describe('unpairing is local, and touches nothing else', () => {
  it('forgets the destination without revoking the server binding', async () => {
    const id = await pairTo(h);

    const res = await h.send({ type: 'AB_INSPECTOR_UNPAIR' });
    expect(res.ok).toBe(true);
    expect(h.storage.ab_targetFieldId).toBeFalsy();

    // The server keeps its binding until the field itself closes, so the user
    // can re-aim at it without asking for a brand new code.
    expect(h.auth.isAuthorized(API_KEY, USER, id)).toBe(true);
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
    // Somebody else was granted this field. (Granted directly, the way the
    // server does it now — there is no code for another party to redeem.)
    const target = h.registry.resolve(USER, id)!;
    h.auth.grant('someone-elses-key', USER, id, target.pairingKey);
    // This extension merely remembers the id, without ever having been granted.
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
    h.grantFor(id);
    h.storage.ab_targetFieldId = id;
    h.storage.ab_pairingKey = reg.target!.pairingKey;

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
// THE IN-PAGE APPROVAL HANDSHAKE, ACROSS THE SEAM
//
// WHOSE HANDSHAKE THIS IS
// -----------------------
// The server's OWN browser: the one this process launches and side-loads the
// extension into. Every worker in this block is built with `managed: true`,
// which is `AB_BOOTSTRAP.managed` — a value only the server can seed, and
// therefore unforgeable proof that the server created this browser.
//
// The block was titled REMOTE while building exactly that browser, and the
// contradiction is the inversion itself, in one place:
//
//   «وقتی لوکال می‌زنم باید مرورگر لوکال سرور بالا بیاد ولی برعکسه»
//
// Read from the PROJECT's point of view, a browser on this server is LOCAL.
// It is also the only browser this server can raise a dialog inside, so the
// approval prompt is LOCAL's handshake and could never have been REMOTE's:
// there is no channel from here into a browser on somebody else's desktop.
//
// THE BUG THESE EXIST TO CATCH
// ----------------------------
// A submit is addressed with `ab_targetFieldId`. The only writer of that value
// was inspectorPair() — redeeming an Authorization Code — and this environment
// deliberately issues none. So the value stayed empty, submitElement() refused
// locally with TARGET_NOT_AUTHORIZED before any HTTP request was made, and the
// operator saw:
//
//   «ظاهرا نمدونه به کدوم فیلد باید ارسال بشه» — Connection failed: network
//
// Note what the OLD tests could not have caught: they pair with a CODE, so
// `ab_targetFieldId` was always written and the seam always looked healthy. The
// gap was a path with no code in it at all, so it needs tests with no code in
// them at all — which is why every test below asserts zero codes were minted.
// ════════════════════════════════════════════════════════════════

describe('LOCAL approval — the extension learns its destination without a code', () => {
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
    // server launched and side-loaded the extension into, i.e. the LOCAL one.
    // That is the only browser the approval handshake is for, and background.js
    // refuses to list or answer prompts anywhere else (the reported defect was
    // this Alert appearing in the operator's own Chrome, where approving it
    // would bind a destination from the wrong machine).
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

  it('tells the question to the ACTIVE tab only — a background tab is answered owner:false, empty', async () => {
    // «Alert در تمام Tabها نمایش داده می‌شود»: every tab's content script polls
    // the same worker, and the worker used to answer them all identically. Now
    // it decides ownership from `sender.tab.id` against
    // `chrome.tabs.query({active:true})` (the fake's active tab is id 1). The
    // page cannot decide this itself — three tabs of one window all report
    // `visibilityState === 'visible'` — so the verdict has to come from here.
    const h = worker();
    const id = h.openField({ nodeId: 'search-box', label: 'Click → Selector' });
    h.askFor(id);

    const active = await h.send({ type: 'AB_CONSENT_LIST' }, { tab: { id: 1, windowId: 1 } });
    expect(active.ok).toBe(true);
    expect(active.owner).toBe(true);
    expect(active.requests).toHaveLength(1);

    const background = await h.send({ type: 'AB_CONSENT_LIST' }, { tab: { id: 2, windowId: 1 } });
    expect(background.ok).toBe(true);
    expect(background.owner).toBe(false);
    expect(background.requests).toHaveLength(0);
    expect(background.skipped).toBe('not_active_tab');

    // A sender with no tab at all (popup, another worker) owns nothing either.
    const noTab = await h.send({ type: 'AB_CONSENT_LIST' }, null);
    expect(noTab.owner).toBe(false);
    expect(noTab.requests).toHaveLength(0);
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
     Chrome. That is the REMOTE browser, and it is where the Alert was reported
     appearing minutes after they had already authorized with a code.

     Why the browser, and not the account, is what decides: both extensions poll
     the SAME endpoint with the SAME api key, because it is one operator with one
     project. Nothing on the wire distinguishes them except what they declare
     themselves to be — so the declaration is the whole mechanism, and it is
     checked on both sides.
     -------------------------------------------------------------------------- */

  /** A REMOTE browser: no server-seeded bootstrap, so no `AB_BOOTSTRAP.managed`. */
  function remoteWorker(opts: WorkerOpts = {}): Harness {
    const w = loadWorker({ ...opts, managed: false });
    w.storage.ab_baseUrl = BASE;
    w.storage.ab_apiKey = API_KEY;
    w.storage.ab_userId = USER;
    return w;
  }

  it('a REMOTE browser is told nothing is pending, and asks the server nothing', async () => {
    const h = remoteWorker();
    h.askFor(h.openField());

    const res = await h.send({ type: 'AB_CONSENT_LIST' });
    // `ok` with an empty list, not an error: "nothing is pending for you" is the
    // TRUTH in a browser on the operator's own machine, which binds by redeeming
    // an Authorization Code. An error would make the caller back off and retry as
    // if the server were broken.
    expect(res.ok).toBe(true);
    expect(res.requests).toEqual([]);
    expect(res.count).toBe(0);
    // The request is never made at all, so even a server that forgot to filter
    // could not produce an Alert here.
    expect(h.requests.some((r) => r.path === '/inspector/consent')).toBe(false);
  });

  it('a REMOTE browser cannot complete the approval even holding a valid handle', async () => {
    // Gating only the LIST would leave the write to `ab_targetFieldId` reachable
    // from a stale card left in a tab by an earlier session — and this is the
    // gate that was inverted in background.js: consentList() admitted `local`
    // while consentDecide() admitted `remote`, so the server's own browser could
    // SEE the Alert and then be refused `wrong_environment` on pressing Allow.
    // The two now agree, and this test and the next one pin them together.
    const h = remoteWorker();
    const consentId = h.askFor(h.openField());

    const res = await h.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('wrong_environment');
    // And it names the way FORWARD rather than just refusing, because a remote
    // operator seeing this has a real path: a code from the dashboard.
    expect(String(res.error)).toMatch(/authorization code/i);
    // Nothing attached, and nothing even asked of the server.
    expect(h.storage.ab_targetFieldId).toBeFalsy();
    expect(h.requests.some((r) => r.path === '/inspector/consent/decide')).toBe(false);
  });

  it('the same prompt is still there for the SERVER\'s browser', async () => {
    // Proves the refusal above is SCOPING and not destruction: a remote browser
    // declining to look must not consume or expire the question the server's own
    // browser still has to answer.
    //
    // This is also the regression test for the gate contradiction: while the two
    // gates disagreed, the second half of this test — the server's own browser
    // pressing Allow — was the exact call that returned `wrong_environment`.
    const shared = worker();
    const consentId = shared.askFor(shared.openField());

    const remote = remoteWorker({ reuse: shared });
    await remote.send({ type: 'AB_CONSENT_LIST' });
    await remote.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });

    const list = await shared.send({ type: 'AB_CONSENT_LIST' });
    expect(list.count).toBe(1);
    const ok = await shared.send({ type: 'AB_CONSENT_DECIDE', payload: { consentId, approve: true } });
    expect(ok.ok).toBe(true);
    expect(ok.approved).toBe(true);
  });

  it('declares its environment on the wire when it does ask', async () => {
    // The server filters on the DECLARED environment, so the declaration has to
    // reach it. Asserted on the REQUEST rather than on the outcome: a worker that
    // declared nothing would still be served these prompts (pendingFor() treats
    // an empty declaration as the server's browser, for older side-loaded
    // builds), so every assertion in this block would pass while the wire went
    // silent — and the operator's own Chrome, which relies on the same filter,
    // would start seeing prompts again.
    const h = worker();
    h.askFor(h.openField());
    await h.send({ type: 'AB_CONSENT_LIST' });

    const asked = h.requests.filter((r) => r.path === '/inspector/consent');
    expect(asked).toHaveLength(1);
    // Both ways, as background.js sends them: the query is what a server log
    // shows when diagnosing this, the header survives a proxy that rewrites
    // query strings.
    expect(asked[0].query).toBe('local');
    expect(asked[0].declaredEnv).toBe('local');
  });
});
