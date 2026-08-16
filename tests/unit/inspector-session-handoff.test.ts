import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import { InspectorHub } from '../../src/core/InspectorHub';
import { TargetFieldRegistry } from '../../src/core/TargetFieldRegistry';
import { InspectorAuthorizationRegistry } from '../../src/core/InspectorAuthorization';

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
  requests: Array<{ method: string; path: string; body: Record<string, unknown> | null; key: string }>;
  /** What was POSTed to /inspector/element, in order. */
  posted: Array<Record<string, unknown>>;
  storage: Record<string, unknown>;
  hub: InspectorHub;
  registry: TargetFieldRegistry;
  auth: InspectorAuthorizationRegistry;
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
}

function loadWorker(opts: WorkerOpts = {}): Harness {
  const registry = opts.reuse?.registry ?? new TargetFieldRegistry();
  const auth = opts.reuse?.auth ?? new InspectorAuthorizationRegistry();
  const hub = opts.reuse?.hub ?? new InspectorHub(registry, auth);

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
    const path = url.replace(BASE, '');
    const headers = (opts.headers || {}) as Record<string, string>;
    // The route reads the key from the CREDENTIAL, never from the body. Captured
    // here so a test can prove the extension actually presented one.
    const key = headers['x-api-key'] || '';
    let body: Record<string, unknown> | null = null;
    if (opts.body) { try { body = JSON.parse(String(opts.body)); } catch { body = null; } }
    requests.push({ method, path, body, key });

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
    // normal case a hand-installed copy hits.
    importScripts: (file: string) => {
      if (file === 'bootstrap.config.js') throw new Error('not found');
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
    storage,
    requests,
    posted,
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
