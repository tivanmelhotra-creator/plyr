import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import { InspectorHub } from '../../src/core/InspectorHub';

// ════════════════════════════════════════════════════════════════
// THE SESSION HAND-OFF — extension/background.js  ⇄  InspectorHub
//
// WHY THIS FILE EXISTS
// --------------------
// «Confirm & Add to Node» was completely dead, and every existing test passed.
// The reason is worth stating precisely, because it is the shape of bug this
// file is built to catch:
//
//   • the DASHBOARD claims a node under a per-tab id it mints itself
//     (public/js/inspector-client.js -> "ui-…")
//   • the EXTENSION used to submit a picked element under an id IT minted
//     (background.js getSessionId() -> "ext-…")
//   • InspectorHub.submit compares the two for equality:
//         if (!sessionId || sessionId !== session.sessionId) -> 'stale_session'
//
// Two independently generated strings are never equal, so EVERY pick was
// refused. Nothing caught it because inspector-hub.test.ts claims and submits
// with ids it chose itself, and the extension tests never talk to the hub. The
// bug lived exactly in the SEAM, so the test has to span the seam.
//
// WHAT MAKES THIS TEST TRUSTWORTHY
// --------------------------------
// It re-implements neither side. The real `extension/background.js` is executed
// in a `vm` sandbox (the approach already used by extension-selector.test.ts and
// extension-inspect.test.ts — there is no jsdom here), its `fetch` is routed
// into a REAL `InspectorHub` behind the same two endpoints
// src/Routes/mode.routes.ts exposes, and the pick is driven through the real
// `chrome.runtime.onMessage` handler with the real message name
// content/inspector.js sends.
//
// VERIFIED TO FAIL ON THE OLD CODE: reverting `submitElement` to
// `getSessionId()` turns four of these green assertions red — the id-shape
// assertion, the moved-claim assertion, the delivery assertion, and the
// no_active_node refusal.
// ════════════════════════════════════════════════════════════════

const USER = 'local';
const BASE = 'http://127.0.0.1:9999';

type Msg = Record<string, unknown>;
type Listener = (msg: Msg, sender: unknown, respond: (r: unknown) => void) => unknown;

interface Harness {
  /** Send a message the way the popup / content script does, and await the reply. */
  send(msg: Msg): Promise<Record<string, unknown>>;
  /** Every request background.js actually made, in order. */
  requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }>;
  /** What was POSTed to /inspector/element, in order. */
  posted: Array<Record<string, unknown>>;
  storage: Record<string, unknown>;
  hub: InspectorHub;
}

/**
 * Load the real service worker with a fake `chrome` and a `fetch` wired to a
 * real hub.
 *
 * The fake endpoints deliberately mirror mode.routes.ts rather than being
 * convenient: `/inspector/session` answers `{ activeNode }` (which is what
 * `claimedSessionId` reads), and `/inspector/element` answers 409 with
 * `{ reason }` on refusal (which is what the popup renders).
 */
function loadWorker(): Harness {
  const hub = new InspectorHub();
  const storage: Record<string, unknown> = {};
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

  // The two endpoints the inspector path touches, answered by the REAL hub.
  async function fakeFetch(url: string, opts: Record<string, unknown> = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const path = url.replace(BASE, '');
    let body: Record<string, unknown> | null = null;
    if (opts.body) { try { body = JSON.parse(String(opts.body)); } catch { body = null; } }
    requests.push({ method, path, body });

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
        activeNode: hub.activeNode(USER),
        pending: hub.peek(USER).length,
      });
    }

    if (method === 'POST' && path === '/inspector/element') {
      posted.push(body || {});
      const result = hub.submit(USER, {
        sessionId: String(body?.sessionId || ''),
        element: body?.element as never,
        selected: (body?.selected as string[]) || [],
        mode: 'remote',
      });
      if (!result.ok) {
        return reply(409, {
          success: false,
          reason: result.reason,
          error: 'The element could not be delivered.',
          activeNode: hub.activeNode(USER),
        });
      }
      return reply(200, {
        success: true,
        delivery: result.delivery,
        activeNode: result.delivery?.session,
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
    storage,
    requests,
    posted,
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

let h: Harness;
beforeEach(() => {
  h = loadWorker();
  h.storage.ab_baseUrl = BASE;
  h.storage.ab_apiKey = 'test-key';
  h.storage.ab_userId = USER;
});

describe('the id a pick is submitted under', () => {
  it("submits under the PROJECT's claimed session, not one the extension minted", async () => {
    // The dashboard claims, with the per-tab id shape it really uses.
    h.hub.claim(USER, { sessionId: 'ui-abc123', nodeId: 'node-7', action: 'click' });

    const res = await h.send({
      type: 'ab-inspector-submit',
      element: pickedElement(),
      selected: ['css'],
    });

    expect(res.ok).toBe(true);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.sessionId).toBe('ui-abc123');
    // The regression guard: an id authored HERE can never match a claim made
    // THERE, and that is precisely how the feature died.
    expect(String(h.posted[0]!.sessionId)).not.toMatch(/^ext-/);
  });

  it('reads the session immediately before submitting, so a moved claim is honoured', async () => {
    // Arming the picker and confirming it are separated by however long the user
    // spends hunting for the element — long enough to open a different node.
    h.hub.claim(USER, { sessionId: 'ui-first', nodeId: 'node-1', action: 'click' });
    h.hub.claim(USER, { sessionId: 'ui-second', nodeId: 'node-2', action: 'type' });

    const res = await h.send({
      type: 'ab-inspector-submit',
      element: pickedElement(),
      selected: ['css'],
    });

    expect(res.ok).toBe(true);
    expect(h.posted[0]!.sessionId).toBe('ui-second');
    const inbox = h.hub.peek(USER);
    expect(inbox[0]!.session.nodeId).toBe('node-2');
  });
});

describe('the pick actually reaches the active node', () => {
  it('lands in the claimed node, with generic attributes intact', async () => {
    h.hub.claim(USER, {
      sessionId: 'ui-abc123', nodeId: 'node-7', action: 'click', label: 'Click #buy',
    });

    const res = await h.send({
      type: 'ab-inspector-submit',
      element: pickedElement(),
      // A data-* attribute nobody whitelisted, carried end to end.
      selected: ['css', 'data-sku'],
    });

    expect(res.ok).toBe(true);
    // The confirmation NAMES the destination — that is what proves it did not
    // quietly go somewhere else.
    expect(res.node).toBe('Click #buy');

    const inbox = h.hub.peek(USER);
    expect(inbox).toHaveLength(1);
    // nodeId lives under `session` in InspectorDelivery, not at the top level.
    expect(inbox[0]!.session.nodeId).toBe('node-7');
    expect(inbox[0]!.selected).toContain('data-sku');
    expect(Object.values(inbox[0]!.fields)).toContain('a#buy');
  });
});

describe('refusals stay explicit and local', () => {
  it('refuses with no_active_node when no node is open, without posting', async () => {
    const res = await h.send({
      type: 'ab-inspector-submit',
      element: pickedElement(),
      selected: ['css'],
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_active_node');
    // A request whose only possible answer is 409 is not worth a round trip,
    // and the message the user needs is the same either way.
    expect(h.posted).toHaveLength(0);
    // The fix must still be NAMED, so the user knows what to do about it.
    expect(String(res.error)).toMatch(/Open a node/i);
  });

  it('refuses an empty selection before touching the network', async () => {
    h.hub.claim(USER, { sessionId: 'ui-abc123', nodeId: 'node-7' });
    const res = await h.send({ type: 'ab-inspector-submit', element: pickedElement(), selected: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('empty_selection');
    expect(h.requests).toHaveLength(0);
  });

  it('refuses a submission with no element at all', async () => {
    h.hub.claim(USER, { sessionId: 'ui-abc123', nodeId: 'node-7' });
    const res = await h.send({ type: 'ab-inspector-submit', element: null, selected: ['css'] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_element');
    expect(h.requests).toHaveLength(0);
  });

  it('refuses when the extension has not been configured', async () => {
    delete h.storage.ab_apiKey;
    const res = await h.send({ type: 'ab-inspector-submit', element: pickedElement(), selected: ['css'] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_api_key');
  });
});

describe('what the popup is told about the session', () => {
  it("reports the CLAIM's session, and the installation id separately", async () => {
    h.hub.claim(USER, { sessionId: 'ui-abc123', nodeId: 'node-7', action: 'click' });

    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });

    expect(res.sessionId).toBe('ui-abc123');
    // Presenting the extension's own id as "the session" is what made the bug
    // invisible in the UI: the popup looked correctly wired while every pick
    // was being refused.
    expect(res.installId).toMatch(/^ext-/);
    expect(res.sessionId).not.toBe(res.installId);
  });

  it('reports an empty session when nothing is claimed, rather than inventing one', async () => {
    const res = await h.send({ type: 'AB_INSPECTOR_SESSION' });
    expect(res.sessionId).toBe('');
    expect((res.data as Record<string, unknown>).activeNode).toBeFalsy();
  });
});
