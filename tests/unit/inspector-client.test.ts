import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

/**
 * public/js/inspector-client.js — the dashboard half of the Element Inspector.
 *
 * WHY THIS RUNS IN A vm SANDBOX AND NOT jsdom
 * -------------------------------------------
 * The repo has no jsdom, and the tests are offline. The client only touches a
 * handful of browser globals (window, WebSocket, fetch via window.API,
 * navigator.sendBeacon), so a hand-built sandbox exercises the REAL file rather
 * than a re-implementation of it. Every assertion below runs the shipped source.
 *
 * WHAT IS WORTH TESTING HERE
 * --------------------------
 * Not "does it call fetch". The load-bearing behaviours are the ones where a
 * plausible implementation silently loses or misroutes a user's pick:
 *   - a field registers under a key the ACTION declares, never a free string
 *   - closing one node releases only ITS fields
 *   - a delivery lands in the field the server resolved, not one re-derived here
 *   - a delivery is acked even when applying it fails, or it replays forever
 *   - `pending` arrives as an array from the socket and a number from HTTP
 *
 * The per-tab `ui-…` session id this file used to mint is gone; see the header
 * of inspector-client.js for why it never worked.
 */

const SRC = readFileSync(resolve(__dirname, '../../public/js/inspector-client.js'), 'utf8');

interface Harness {
  client: any;
  applied: Array<{ nodeId: string; fields: Record<string, string> }>;
  posts: Array<{ path: string; body: any }>;
  gets: string[];
  toasts: Array<{ msg: string; kind: string }>;
  applyResult: { value: boolean };
  beacons: Array<{ url: string; body: any }>;
  /** What POST replies with, so a test can model a server refusal. */
  reply: { value: (path: string, body: any) => any };
}

/**
 * Boot the real file with a controllable environment.
 *
 * `applyResult.value` lets FlowEditor.applyInspectorFields report failure, which
 * is the only way to check the "ack anyway" rule. `reply.value` lets a test make
 * the server refuse a registration.
 */
function boot(opts: { noEditor?: boolean } = {}): Harness {
  const posts: Harness['posts'] = [];
  const gets: string[] = [];
  const applied: Harness['applied'] = [];
  const toasts: Harness['toasts'] = [];
  const beacons: Harness['beacons'] = [];
  const applyResult = { value: true };

  // Default: echo back a target the way /inspector/target does.
  const reply = {
    value: (path: string, body: any): any => {
      if (path === '/inspector/target') {
        return {
          success: true,
          target: {
            targetFieldId: `node_${body.nodeId}__${body.fieldKey}__abcd`,
            nodeId: body.nodeId,
            fieldKey: body.fieldKey,
            action: body.action,
            label: body.label,
          },
        };
      }
      if (path === '/inspector/target/release') return { success: true, released: true };
      return { success: true };
    },
  };

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
    // No WebSocket on purpose: connect() then falls back to the HTTP path, which
    // keeps these tests about delivery logic rather than socket plumbing.
    location: { protocol: 'https:', host: 'example.test' },
    navigator: {
      sendBeacon: vi.fn((url: string, blob: any) => {
        let body: any = null;
        try { body = JSON.parse(String(blob?.parts?.[0] ?? '')); } catch { body = null; }
        beacons.push({ url, body });
        return true;
      }),
    },
    Blob: class { constructor(public parts: unknown[], public opts: unknown) {} },
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
        return Promise.resolve(reply.value(path, body));
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

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const client = (sandbox.window as any).InspectorClient;
  return {
    client,
    applied,
    posts,
    gets,
    toasts,
    applyResult,
    beacons,
    reply,
    // Exposed so a test can fire beforeunload the way the browser would.
    ...({ fire: (evt: string) => (listeners[evt] || []).forEach((f) => f()) } as any),
  } as Harness & { fire: (evt: string) => void };
}

/**
 * A delivery shaped exactly like InspectorHub.InspectorDelivery.
 *
 * `target` (a resolved TargetField), not `session` — and `fields` carries
 * exactly ONE entry, because the hub sends one radio-selected value.
 */
function delivery(over: Record<string, unknown> = {}) {
  return {
    id: 'insp_abc_1',
    ts: Date.now(),
    mode: 'remote',
    target: {
      targetFieldId: 'node_n3__selector__abcd',
      nodeId: 'n3',
      fieldKey: 'selector',
      action: 'click',
      label: 'Click Buy → selector',
      registeredAt: Date.now(),
    },
    element: { tag: 'button', id: 'buy', classes: ['btn'], css: '#buy', xpath: '//button' },
    displayAttributes: ['css', 'id'],
    attribute: 'css',
    value: '#buy',
    fields: { selector: '#buy' },
    summary: 'button#buy — css → Click Buy → selector',
    ...over,
  };
}

describe('the session id is gone', () => {
  it('exposes no session id and stores none', () => {
    const h = boot();
    // Two independently minted ids could never match, which is why every pick
    // was refused. There is nothing left to keep in sync.
    expect(h.client.sessionId).toBeUndefined();
    expect(JSON.stringify(h.client.state())).not.toContain('ui-');
  });

  it('does not put a session id on the socket URL', () => {
    // The socket is a per-USER channel now; which FIELD a pick belongs to
    // travels with the delivery itself.
    expect(SRC).not.toMatch(/sessionId=/);
  });
});

describe('registering a Target Field', () => {
  it('sends the node, the field key and the action', async () => {
    const h = boot();
    const t = await h.client.registerTarget('n7', 'selector', { action: 'click', label: 'Click Buy → selector' });

    const post = h.posts.find((p) => p.path === '/inspector/target');
    expect(post).toBeTruthy();
    expect(post!.body.nodeId).toBe('n7');
    // The field key is what makes the delivery land in the right slot; without
    // it the server would have to guess between a node's several fields.
    expect(post!.body.fieldKey).toBe('selector');
    expect(post!.body.action).toBe('click');
    // The id is the SERVER's, echoed back — never invented here.
    expect(t.targetFieldId).toBe('node_n7__selector__abcd');
  });

  it('never invents a targetFieldId of its own', async () => {
    const h = boot();
    await h.client.registerTarget('n7', 'selector', { action: 'click' });
    // A client-chosen suffix could revive a destination the user had closed,
    // which is the stale delivery the suffix exists to prevent.
    expect(h.posts[0]!.body.targetFieldId).toBeUndefined();
  });

  it('refuses to register without a field key', async () => {
    const h = boot();
    const t = await h.client.registerTarget('n7', '', { action: 'click' });
    expect(t).toBeNull();
    expect(h.posts).toHaveLength(0);
  });

  it('survives a server refusal without throwing', async () => {
    const h = boot();
    h.reply.value = () => ({ success: false, reason: 'undeclared_field' });
    const t = await h.client.registerTarget('n7', 'nope', { action: 'click' });
    // A failed registration must not stop the editor from opening the node.
    expect(t).toBeNull();
    expect(h.client.myTargets()).toHaveLength(0);
  });

  it('tracks several open fields at once', async () => {
    const h = boot();
    await h.client.registerTarget('n1', 'selector', { action: 'click' });
    await h.client.registerTarget('n1', 'text', { action: 'type' });
    await h.client.registerTarget('n2', 'url', { action: 'goto' });

    // A single-valued "active node" could not express this, and would have to
    // silently drop all but one.
    expect(h.client.myTargets()).toHaveLength(3);
  });
});

describe('releasing fields is precise', () => {
  it('releases one field without disturbing the others', async () => {
    const h = boot();
    const a = await h.client.registerTarget('n1', 'selector', { action: 'click' });
    await h.client.registerTarget('n1', 'text', { action: 'type' });

    await h.client.releaseTarget(a.targetFieldId);

    const left = h.client.myTargets();
    expect(left).toHaveLength(1);
    expect(left[0].fieldKey).toBe('text');
    const rel = h.posts.find((p) => p.path === '/inspector/target/release');
    expect(rel!.body.targetFieldId).toBe(a.targetFieldId);
  });

  it('releases every field of ONE node, and only that node', async () => {
    const h = boot();
    await h.client.registerTarget('n1', 'selector', { action: 'click' });
    await h.client.registerTarget('n1', 'text', { action: 'type' });
    const other = await h.client.registerTarget('n2', 'url', { action: 'goto' });

    const n = await h.client.releaseNode('n1');

    expect(n).toBe(2);
    // Closing one node must not disconnect a field another node still has open.
    const left = h.client.myTargets();
    expect(left).toHaveLength(1);
    expect(left[0].targetFieldId).toBe(other.targetFieldId);
  });

  it('drops the field locally even when the server call fails', async () => {
    const h = boot();
    const a = await h.client.registerTarget('n1', 'selector', { action: 'click' });
    // A rejected promise, the way a real offline POST fails.
    h.reply.value = () => Promise.reject(new Error('offline'));

    await h.client.releaseTarget(a.targetFieldId);

    // A UI still listing a field the user just closed is worse than one briefly
    // out of step with the server.
    expect(h.client.myTargets()).toHaveLength(0);
  });

  it('beacons a release for each open field as the tab closes', async () => {
    const h = boot() as Harness & { fire: (e: string) => void };
    await h.client.registerTarget('n1', 'selector', { action: 'click' });
    await h.client.registerTarget('n2', 'url', { action: 'goto' });

    h.fire('beforeunload');

    // One beacon per field: release takes one id, and the server cannot tell
    // "this tab's fields" from "this user's fields".
    expect(h.beacons).toHaveLength(2);
    expect(h.beacons[0]!.url).toContain('/inspector/target/release');
    // A beacon cannot set headers, so the key has to ride in the query string.
    expect(h.beacons[0]!.url).toContain('api_key=');
    const ids = h.beacons.map((b) => b.body.targetFieldId).sort();
    expect(ids).toEqual(['node_n1__selector__abcd', 'node_n2__url__abcd']);
  });
});

describe('applying a delivery', () => {
  it('writes the delivered field into the node the SERVER resolved', () => {
    const h = boot();
    expect(h.client.applyDelivery(delivery())).toBe(true);

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.nodeId).toBe('n3');
    // Exactly one field: the server sends one radio-selected value, so there is
    // nothing to filter and nothing to guess.
    expect(h.applied[0]!.fields).toEqual({ selector: '#buy' });
  });

  it('writes into a DIFFERENT field when the delivery names one', () => {
    const h = boot();
    h.client.applyDelivery(delivery({
      target: { targetFieldId: 'node_n3__text__abcd', nodeId: 'n3', fieldKey: 'text', action: 'type' },
      fields: { text: 'Buy now' },
    }));
    // Field-level targeting: same node, same element, different slot.
    expect(h.applied[0]!.fields).toEqual({ text: 'Buy now' });
  });

  it('does not re-derive the destination or drop an unfamiliar field key', () => {
    const h = boot();
    // The old code filtered against a hard-coded whitelist and would have
    // dropped this. The server already validated it against the action's
    // declared params, so second-guessing it here only loses the user's pick.
    h.client.applyDelivery(delivery({
      target: { targetFieldId: 'node_n9__apiUrl__abcd', nodeId: 'n9', fieldKey: 'apiUrl', action: 'http' },
      fields: { apiUrl: 'https://example.test/checkout' },
    }));
    expect(h.applied[0]!.fields).toEqual({ apiUrl: 'https://example.test/checkout' });
  });

  it('refuses a delivery with no resolved target', () => {
    const h = boot();
    expect(h.client.applyDelivery(delivery({ target: null }))).toBe(false);
    expect(h.applied).toHaveLength(0);
  });

  it('refuses a delivery whose only value is empty', () => {
    const h = boot();
    expect(h.client.applyDelivery(delivery({ fields: { selector: '' } }))).toBe(false);
    // The fake I18N echoes the key back, so T() falls through to its English
    // fallback — which is the string a user without a dictionary entry sees.
    expect(h.toasts.some((t) => /do not fit this node/.test(t.msg))).toBe(true);
  });

  it('acks even when applying fails, so it does not replay forever', () => {
    const h = boot();
    h.applyResult.value = false;

    expect(h.client.applyDelivery(delivery())).toBe(false);

    // The delivery is spent either way; leaving it queued replays the same
    // failure on every later poll.
    const ack = h.posts.find((p) => p.path === '/inspector/ack');
    expect(ack!.body.id).toBe('insp_abc_1');
    expect(h.toasts.some((t) => /no longer open/.test(t.msg))).toBe(true);
  });

  it('tells the user to open the editor when there is none', () => {
    const h = boot({ noEditor: true });
    expect(h.client.applyDelivery(delivery())).toBe(false);
    expect(h.toasts.some((t) => /Open the workflow editor/.test(t.msg))).toBe(true);
  });

  it('reports the destination in the success toast', () => {
    const h = boot();
    h.client.applyDelivery(delivery());
    // Naming where the value went is what proves it did not go elsewhere.
    expect(h.toasts.some((t) => t.kind === 'success' && /Click Buy/.test(t.msg))).toBe(true);
  });
});

describe('the inbox', () => {
  it('drains with drain=1, because it commits to applying what it gets', async () => {
    const h = boot();
    await h.client.drainInbox();
    expect(h.gets.some((g) => g.indexOf('/inspector/inbox?drain=1') === 0)).toBe(true);
  });
});

describe('state reported to the UI', () => {
  it('exposes the open targets as a list', async () => {
    const h = boot();
    await h.client.registerTarget('n1', 'selector', { action: 'click' });
    const snap = h.client.state();
    expect(Array.isArray(snap.targets)).toBe(true);
    expect(snap.targets).toHaveLength(1);
    // No single-valued activeNode: several fields must be able to wait at once.
    expect(snap.activeNode).toBeUndefined();
  });

  it('notifies subscribers when a field opens', async () => {
    const h = boot();
    const seen: number[] = [];
    h.client.onChange((s: any) => seen.push(s.targets.length));
    await h.client.registerTarget('n1', 'selector', { action: 'click' });
    expect(seen[seen.length - 1]).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// THE AUTHORIZATION CODE CLIENT IS GONE — and this block records why.
//
// `authorizeTarget()` lived here and was covered by seven tests. It asked
// POST /inspector/authorize for an 8-character code scoped to one field, which
// the dashboard then displayed for the operator to retype into the extension.
// Both the method and the route are deleted, so the tests are replaced by the
// assertions that keep them deleted.
//
// The PROPERTY those seven tests protected is still protected, just not here:
// «the extension must never name its own destination». It now holds by
// construction rather than by scoping a code — the server resolves the target
// and binds it during /inspector/targeting/begin, and the extension is only ever
// told a `consentId`. tests/integration/targeting-routes.test.ts owns that.
// ════════════════════════════════════════════════════════════════
describe('the authorization code client is gone', () => {
  it('exposes no authorizeTarget method', async () => {
    const h = boot();
    expect((h.client as any).authorizeTarget).toBeUndefined();
  });

  it('never references the deleted route', async () => {
    // Source-level, because a call built from a string fragment would survive
    // the method check above while still hitting a route that no longer exists.
    const src = readFileSync(
      resolve(process.cwd(), 'public/js/inspector-client.js'),
      'utf8',
    );
    const body = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(body).not.toContain('/inspector/authorize');
    expect(body).not.toContain('authorizeTarget');
  });

  it('still registers a Target Field, which is what actually binds one', async () => {
    // The capability that replaced it, asserted so this block cannot be read as
    // "targeting was removed". Registering mints the destination server-side;
    // no code is involved and none is returned.
    const h = boot();
    const t = await h.client.registerTarget('n1', 'selector', { action: 'click' });
    expect(t.targetFieldId).toBeTruthy();
    expect((t as any).code).toBeUndefined();
    expect(h.client.state().targets).toHaveLength(1);
  });
});
