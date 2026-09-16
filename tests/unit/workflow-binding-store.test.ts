/**
 * WorkflowBinding — the Local Browser's binding survives the process (S16).
 *
 * REPORTED: the Workflow Files drawer said "not opened from a saved workflow"
 * after the browser had plainly been opened from one, and downloads made
 * afterwards were not filed under the workflow.
 *
 * ROOT CAUSE: the binding was a `let` in the module — process memory. A pm2
 * restart emptied it while the Chrome profile on disk survived; and with four
 * cluster workers, the /bind landed on one and the GET / the transfer ran on
 * another. Three out of four said "nothing bound".
 *
 * These tests drive the module against a fake store (the three ioredis
 * commands it uses) and show:
 *   - a write goes to memory AND the store, awaited;
 *   - a fresh process (memory wiped) reads the binding back from the store;
 *   - a transfer ALWAYS re-reads the store, so a re-bind elsewhere is honoured;
 *   - a store outage never unbinds — the last memory value stands;
 *   - without a store the module is exactly the memory-only thing it was.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  attachBindingStore,
  bindRealChrome,
  realChromeWorkflow,
  realChromeWorkflowForTransfer,
  refreshRealChromeBinding,
  resetRealChromeBindingForTests,
  REAL_CHROME_BINDING_KEY,
  type BindingStore,
} from '../../src/core/WorkflowBinding';

/** The store as the module sees it, plus a log of what was asked of it. */
function fakeStore() {
  const kv = new Map<string, string>();
  const calls: string[] = [];
  const s: BindingStore & { kv: Map<string, string>; calls: string[] } = {
    kv,
    calls,
    async get(k) { calls.push(`get ${k}`); return kv.has(k) ? kv.get(k)! : null; },
    async set(k, v) { calls.push(`set ${k}`); kv.set(k, v); return 'OK'; },
    async del(k) { calls.push(`del ${k}`); return kv.delete(k) ? 1 : 0; },
  };
  return s;
}

const ALICE = { userId: 'alice', workflowId: 'wf_a' };
const BOB = { userId: 'bob', workflowId: 'wf_b' };

beforeEach(() => {
  attachBindingStore(null);
  resetRealChromeBindingForTests();
});
afterEach(() => {
  attachBindingStore(null);
  resetRealChromeBindingForTests();
  vi.restoreAllMocks();
});

describe('WorkflowBinding without a store (unit tests, memory only)', () => {
  it('binds and reads back synchronously', async () => {
    await bindRealChrome(ALICE);
    expect(realChromeWorkflow()).toEqual(ALICE);
    expect(await refreshRealChromeBinding()).toEqual(ALICE);
    expect(await realChromeWorkflowForTransfer()).toEqual(ALICE);
  });

  it('null unbinds', async () => {
    await bindRealChrome(ALICE);
    await bindRealChrome(null);
    expect(realChromeWorkflow()).toBeNull();
  });

  it('a half-formed ref binds nothing', async () => {
    await bindRealChrome({ userId: 'alice', workflowId: '' });
    expect(realChromeWorkflow()).toBeNull();
    await bindRealChrome({ userId: '', workflowId: 'wf' });
    expect(realChromeWorkflow()).toBeNull();
  });

  it('coerces ids to strings and returns a copy, not the live record', async () => {
    await bindRealChrome({ userId: 7 as unknown as string, workflowId: 9 as unknown as string });
    const a = realChromeWorkflow();
    expect(a).toEqual({ userId: '7', workflowId: '9' });
    a!.workflowId = 'tampered';
    expect(realChromeWorkflow()).toEqual({ userId: '7', workflowId: '9' });
  });
});

describe('WorkflowBinding with a store (the server)', () => {
  it('a write goes to memory AND the store, under the fixed key, before the promise resolves', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);
    expect(realChromeWorkflow()).toEqual(ALICE);
    expect(s.kv.get(REAL_CHROME_BINDING_KEY)).toBe(JSON.stringify(ALICE));
    expect(s.calls).toEqual([`set ${REAL_CHROME_BINDING_KEY}`]);
  });

  it('unbinding deletes the record', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);
    await bindRealChrome(null);
    expect(s.kv.has(REAL_CHROME_BINDING_KEY)).toBe(false);
    expect(realChromeWorkflow()).toBeNull();
  });

  it('a FRESH PROCESS (memory wiped) reads the binding back from the store', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);

    resetRealChromeBindingForTests();                 // restart / other pm2 worker
    expect(realChromeWorkflow()).toBeNull();          // memory alone: nothing

    expect(await refreshRealChromeBinding()).toEqual(ALICE);
    expect(realChromeWorkflow()).toEqual(ALICE);      // and memory is reconciled
  });

  it('a transfer ALWAYS re-reads the store, so a re-bind on another worker is honoured', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);
    expect(realChromeWorkflow()).toEqual(ALICE);

    // "Another worker" re-binds: only the store changes.
    s.kv.set(REAL_CHROME_BINDING_KEY, JSON.stringify(BOB));

    expect(await realChromeWorkflowForTransfer()).toEqual(BOB);
    expect(realChromeWorkflow()).toEqual(BOB);
  });

  it('a transfer after another worker UNBOUND files nowhere', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);
    s.kv.delete(REAL_CHROME_BINDING_KEY);
    expect(await realChromeWorkflowForTransfer()).toBeNull();
  });

  it('a corrupt record in the store reads as nothing, and does not throw', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    s.kv.set(REAL_CHROME_BINDING_KEY, '{not json');
    expect(await refreshRealChromeBinding()).toBeNull();
    s.kv.set(REAL_CHROME_BINDING_KEY, JSON.stringify({ userId: 'alice' }));
    expect(await refreshRealChromeBinding()).toBeNull();
  });

  it('a store WRITE failure is logged, never thrown, and the binding still holds in this process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = fakeStore();
    s.set = async () => { throw new Error('READONLY You can\'t write against a read only replica.'); };
    attachBindingStore(s);
    await expect(bindRealChrome(ALICE)).resolves.toBeUndefined();
    expect(realChromeWorkflow()).toEqual(ALICE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[WorkflowBinding]');
  });

  it('a store READ failure keeps the last memory value rather than unbinding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);
    s.get = async () => { throw new Error('ECONNREFUSED'); };
    expect(await refreshRealChromeBinding()).toEqual(ALICE);
    expect(await realChromeWorkflowForTransfer()).toEqual(ALICE);
    expect(warn).toHaveBeenCalled();
  });

  it('detaching the store (null) returns the module to memory-only behaviour', async () => {
    const s = fakeStore();
    attachBindingStore(s);
    await bindRealChrome(ALICE);
    attachBindingStore(null);
    s.kv.set(REAL_CHROME_BINDING_KEY, JSON.stringify(BOB)); // ignored: no store
    expect(await refreshRealChromeBinding()).toEqual(ALICE);
    await bindRealChrome(BOB);
    expect(s.calls.filter((c) => c.startsWith('set'))).toHaveLength(1); // only the first write reached it
  });

  it('memory is written BEFORE the store round trip completes (a reader in this process never sees a gap)', async () => {
    const s = fakeStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    s.set = async (k, v) => { await gate; s.kv.set(k, v); return 'OK'; };
    attachBindingStore(s);

    const p = bindRealChrome(ALICE);
    expect(realChromeWorkflow()).toEqual(ALICE);   // visible while Redis is still "slow"
    expect(s.kv.has(REAL_CHROME_BINDING_KEY)).toBe(false);
    release();
    await p;
    expect(s.kv.get(REAL_CHROME_BINDING_KEY)).toBe(JSON.stringify(ALICE));
  });
});
