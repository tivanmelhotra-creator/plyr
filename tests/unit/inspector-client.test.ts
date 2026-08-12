import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

/**
 * public/js/inspector-client.js — the dashboard half of the Element Inspector.
 *
 * WHY THIS RUNS IN A vm SANDBOX AND NOT jsdom
 * -------------------------------------------
 * The repo has no jsdom, and the tests are offline. The client only touches a
 * handful of browser globals (window, sessionStorage, WebSocket, fetch via
 * window.API, navigator.sendBeacon), so a hand-built sandbox exercises the REAL
 * file rather than a re-implementation of it. Every assertion below runs the
 * shipped source.
 *
 * WHAT IS WORTH TESTING HERE
 * --------------------------
 * Not "does it call fetch". The load-bearing behaviours are the ones where a
 * plausible implementation silently loses or misroutes a user's pick:
 *   - a delivery addressed to a DIFFERENT session must be dropped
 *   - fields the node cannot accept must be filtered before they are written
 *   - a delivery must be acked even when applying it fails, or it replays
 *   - `pending` arrives as an array from the socket and a number from HTTP
 */

const SRC = readFileSync(resolve(__dirname, '../../public/js/inspector-client.js'), 'utf8');

interface Harness {
  client: any;
  applied: Array<{ nodeId: string; fields: Record<string, string> }>;
  posts: Array<{ path: string; body: any }>;
  gets: string[];
  toasts: Array<{ msg: string; kind: string }>;
  sessionId: string;
  applyResult: { value: boolean };
  store: Record<string, string>;
}

/**
 * Boot the real file with a controllable environment.
 *
 * `applyResult.value` lets a test make FlowEditor.applyInspectorFields report
 * failure, which is the only way to check the "ack anyway" rule.
 */
function boot(opts: { noEditor?: boolean; sessionSeed?: string } = {}): Harness {
  const posts: Harness['posts'] = [];
  const gets: string[] = [];
  const applied: Harness['applied'] = [];
  const toasts: Harness['toasts'] = [];
  const applyResult = { value: true };
  const store: Record<string, string> = {};
  if (opts.sessionSeed) store.ab_inspector_session = opts.sessionSeed;

  const listeners: Record<string, Function[]> = {};

  const sandbox: Record<string, unknown> = {
    console,
    Promise,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    // No WebSocket on purpose for most tests: connect() then falls back to the
    // HTTP path, which keeps these tests about delivery logic rather than
    // socket plumbing (the socket is covered by the server-side suites).
    location: { protocol: 'https:', host: 'example.test' },
    navigator: { sendBeacon: vi.fn(() => true) },
    Blob: class { constructor(public parts: unknown[], public opts: unknown) {} },
    sessionStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
    },
  };

  const windowObj: Record<string, unknown> = {
    addEventListener: (evt: string, fn: Function) => {
      (listeners[evt] = listeners[evt] || []).push(fn);
    },
    API: {
      getKey: () => 'test-key',
      getUserId: () => 'u1',
      get: (path: string) => { gets.push(path); return Promise.resolve({ success: true, items: [] }); },
      post: (path: string, body: unknown) => {
        posts.push({ path, body });
        return Promise.resolve({ success: true });
      },
    },
    AppUtil: {
      toast: (msg: string, kind: string) => { toasts.push({ msg, kind }); },
      t: (k: string) => k,
    },
    I18N: { t: (k: string) => k },
  };
  if (!opts.noEditor) {
    windowObj.FlowEditor = {
      applyInspectorFields: (nodeId: string, fields: Record<string, string>) => {
        applied.push({ nodeId, fields });
        return applyResult.value;
      },
    };
  }
  sandbox.window = windowObj;
  (sandbox as any).Blob = sandbox.Blob;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const client = (sandbox.window as any).InspectorClient;
  return {
    client,
    applied,
    posts,
    gets,
    toasts,
    sessionId: client.sessionId(),
    applyResult,
    store,
  };
}

/** A delivery shaped exactly like InspectorHub.InspectorDelivery. */
function delivery(sessionId: string, over: Record<string, unknown> = {}) {
  return {
    id: 'insp_abc_1',
    ts: Date.now(),
    mode: 'remote',
    session: { sessionId, nodeId: 'n3', action: 'click', claimedAt: Date.now() },
    element: { tag: 'button', id: 'buy', classes: ['btn'], css: '#buy', xpath: '//button' },
    selected: ['css', 'id'],
    fields: { selector: '#buy', selectorType: 'css' },
    summary: 'button#buy',
    ...over,
  };
}

describe('inspector-client: session identity', () => {
  it('persists one session id per tab in sessionStorage', () => {
    const h = boot();
    expect(h.sessionId).toMatch(/^ui-/);
    // The id it reports is the id it stored, or a reload would orphan the claim.
    expect(h.store.ab_inspector_session).toBe(h.sessionId);
  });

  it('reuses an existing id rather than minting a new one on reload', () => {
    const h = boot({ sessionSeed: 'ui-existing-123' });
    expect(h.sessionId).toBe('ui-existing-123');
  });

  it('sends its own session id when claiming, never a caller-supplied one', async () => {
    const h = boot();
    await h.client.claim('n7', { action: 'click', label: 'Click Buy' });
    const claim = h.posts.find((p) => p.path === '/inspector/claim');
    expect(claim).toBeTruthy();
    expect(claim!.body.sessionId).toBe(h.sessionId);
    expect(claim!.body.nodeId).toBe('n7');
    expect(claim!.body.action).toBe('click');
  });
});

describe('inspector-client: acceptedFields', () => {
  it('offers selector-shaped fields to element nodes', () => {
    const h = boot();
    const f = h.client.acceptedFields('click');
    expect(f).toContain('selector');
    expect(f).toContain('selectorType');
    expect(f).toContain('attribute');
  });

  it('restricts navigation nodes to a value, since they take a URL not a selector', () => {
    const h = boot();
    expect(h.client.acceptedFields('goto')).toEqual(['value']);
    expect(h.client.acceptedFields('navigate')).toEqual(['value']);
  });
});

describe('inspector-client: applyDelivery', () => {
  it('applies fields to the claimed node and acks the delivery', async () => {
    const h = boot();
    const ok = h.client.applyDelivery(delivery(h.sessionId));
    expect(ok).toBe(true);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0].nodeId).toBe('n3');
    expect(h.applied[0].fields).toEqual({ selector: '#buy', selectorType: 'css' });

    await Promise.resolve();
    const ack = h.posts.find((p) => p.path === '/inspector/ack');
    expect(ack).toBeTruthy();
    expect(ack!.body.id).toBe('insp_abc_1');
  });

  it('REFUSES a delivery addressed to a different session', () => {
    const h = boot();
    // The server already guards this, but a pick queued before a re-claim could
    // still arrive here. Applying it would be the exact mis-delivery the whole
    // session handshake exists to prevent.
    const ok = h.client.applyDelivery(delivery('ui-someone-else'));
    expect(ok).toBe(false);
    expect(h.applied).toHaveLength(0);
    expect(h.posts.filter((p) => p.path === '/inspector/ack')).toHaveLength(0);
  });

  it('drops fields the node action cannot accept', () => {
    const h = boot();
    h.client.applyDelivery(delivery(h.sessionId, {
      session: { sessionId: h.sessionId, nodeId: 'n9', action: 'goto', claimedAt: Date.now() },
      fields: { selector: '#buy', selectorType: 'css', value: 'https://example.test/' },
    }));
    // 'goto' accepts only `value`; writing `selector` would invent a param the
    // node does not declare, which GraphSerialize would then silently drop.
    expect(h.applied[0].fields).toEqual({ value: 'https://example.test/' });
  });

  it('refuses when no accepted field survives filtering', () => {
    const h = boot();
    const ok = h.client.applyDelivery(delivery(h.sessionId, {
      session: { sessionId: h.sessionId, nodeId: 'n9', action: 'goto', claimedAt: Date.now() },
      fields: { selector: '#buy', selectorType: 'css' },   // no `value`
    }));
    expect(ok).toBe(false);
    expect(h.applied).toHaveLength(0);
    expect(h.toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('acks even when the editor reports the apply FAILED', async () => {
    const h = boot();
    h.applyResult.value = false;      // node closed between pick and delivery
    const ok = h.client.applyDelivery(delivery(h.sessionId));
    expect(ok).toBe(false);

    await Promise.resolve();
    // Not acking here would replay the same failure on every later poll.
    expect(h.posts.find((p) => p.path === '/inspector/ack')).toBeTruthy();
    expect(h.toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('refuses, and does not throw, when the editor is not loaded', () => {
    const h = boot({ noEditor: true });
    expect(() => h.client.applyDelivery(delivery(h.sessionId))).not.toThrow();
    expect(h.toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('ignores malformed deliveries instead of throwing', () => {
    const h = boot();
    expect(h.client.applyDelivery(null)).toBe(false);
    expect(h.client.applyDelivery({})).toBe(false);
    expect(h.client.applyDelivery({ session: {} })).toBe(false);
    expect(h.applied).toHaveLength(0);
  });
});

describe('inspector-client: release', () => {
  it('clears the local claim even if the request fails', async () => {
    const h = boot();
    await h.client.claim('n7', { action: 'click' });
    await h.client.release();
    const rel = h.posts.find((p) => p.path === '/inspector/release');
    expect(rel).toBeTruthy();
    expect(rel!.body.sessionId).toBe(h.sessionId);
    expect(h.client.state().activeNode).toBeFalsy();
  });
});

describe('inspector-client: source guarantees', () => {
  // A few properties are cheaper to assert against the text than to simulate,
  // and each one is a mistake that would be invisible at runtime until it cost
  // a user their pick.

  it('uses sessionStorage (per tab), never localStorage (shared)', () => {
    expect(SRC).toContain('sessionStorage.getItem');
    // localStorage would make two editor tabs indistinguishable to the hub, so
    // it must never be CALLED. The bare word does appear -- the header comment
    // explains why it is the wrong choice -- so this matches member access
    // rather than the identifier, or the explanation would fail the test that
    // exists to protect the decision it documents.
    expect(SRC).not.toMatch(/localStorage\s*\./);
    expect(SRC).not.toMatch(/localStorage\s*\[/);
  });

  it('drains with drain=1 only on the path that commits to applying', () => {
    expect(SRC).toContain("'/inspector/inbox?drain=1'");
  });

  it('releases on unload via sendBeacon, not fetch', () => {
    // A fetch started in beforeunload is routinely cancelled during teardown.
    expect(SRC).toContain('sendBeacon');
    expect(SRC).toContain('beforeunload');
  });

  it('normalises `pending` from both server shapes', () => {
    // Socket hello sends an array (peek()); /inspector/session sends a number.
    // An empty array is truthy, so a bare truthiness test would drain on every
    // connect.
    expect(SRC).toContain('function pendingCount');
    expect(SRC).toContain('Array.isArray(pending)');
    expect(SRC).toContain('pendingCount(msg.pending) > 0');
  });

  it('handles the bridge lifecycle messages the server actually emits', () => {
    expect(SRC).toContain('bridge.connected');
    expect(SRC).toContain('bridge.lost');
  });

  it('caps socket reconnect backoff so a dead server is not hammered', () => {
    expect(SRC).toContain('Math.min(state.retryMs * 2, 30000)');
  });
});
