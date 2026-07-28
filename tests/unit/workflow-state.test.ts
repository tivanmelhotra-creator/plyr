import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * workflow-state.test.ts — the `active` / `liveBrowser` flags behind the
 * Workspace row switches (docs/uiux/workspace-overview.md § 4 and § 6).
 *
 * The behaviour that MUST NOT regress:
 *
 *  1. `setState()` does not bump `Workflow.version` and writes no history
 *     snapshot. Flipping a switch is not a new design of the automation, and if
 *     it counted as one, a user who toggled a flow twice would silently push
 *     their real revisions out of the pruned version history.
 *  2. `update()` (the real editor save) PRESERVES the flags. A save must never
 *     resurrect a workflow the user deliberately deactivated.
 *  3. Workflows written before these fields existed hydrate to the documented
 *     defaults (`active: true`, `liveBrowser: false`) on read, so no Redis
 *     migration is needed.
 *  4. Only the named keys are writable, and a partial patch leaves the other
 *     flag untouched.
 */

// Deterministic, small history cap so we can assert that setState() adds nothing.
vi.mock('../../src/config', () => ({
  config: { WORKFLOW_MAX_VERSIONS: 3 },
}));

import { WorkflowService } from '../../src/services/workflow.service';
import { getWorkflowKey } from '../../src/utils/redis-keys';

/** Minimal in-memory Redis stub — same shape as workflow-service.test.ts. */
function makeRedis() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    kv,
    sets,
    async get(k: string) {
      return kv.has(k) ? kv.get(k)! : null;
    },
    async set(k: string, v: string) {
      kv.set(k, String(v));
      return 'OK';
    },
    async del(k: string) {
      const had = kv.delete(k);
      const hadSet = sets.delete(k);
      return had || hadSet ? 1 : 0;
    },
    async exists(k: string) {
      return kv.has(k) || sets.has(k) ? 1 : 0;
    },
    async sadd(k: string, v: string) {
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k)!.add(String(v));
      return 1;
    },
    async srem(k: string, v: string) {
      return sets.get(k)?.delete(String(v)) ? 1 : 0;
    },
    async smembers(k: string) {
      return Array.from(sets.get(k) ?? []);
    },
  };
}

let redis: ReturnType<typeof makeRedis>;
let svc: WorkflowService;

beforeEach(() => {
  redis = makeRedis();
  svc = new WorkflowService(redis as any);
});

const sampleInput = (over: Record<string, unknown> = {}) => ({
  name: 'Login flow',
  description: 'desc',
  steps: [{ action: 'goto', params: { url: 'https://e.com' } }],
  headless: true,
  webhookUrl: null,
  ...over,
});

describe('Workflow.active / .liveBrowser — defaults', () => {
  it('a freshly created workflow is Active with Live Browser OFF', async () => {
    const wf = await svc.create('u1', sampleInput());
    // Active by default: a workflow you just built should be runnable without a
    // second action. Streaming is opt-in because it costs a visible browser.
    expect(wf.active).toBe(true);
    expect(wf.liveBrowser).toBe(false);
  });

  it('honours explicit flags passed at create time', async () => {
    const wf = await svc.create('u1', sampleInput({ active: false, liveBrowser: true }));
    expect(wf.active).toBe(false);
    expect(wf.liveBrowser).toBe(true);
  });

  it('hydrates legacy records that predate the fields (no migration needed)', async () => {
    const wf = await svc.create('u1', sampleInput());

    // Simulate a record written by an older build: strip both flags.
    const key = getWorkflowKey('u1', wf.id);
    const legacy = JSON.parse(redis.kv.get(key)!);
    delete legacy.active;
    delete legacy.liveBrowser;
    redis.kv.set(key, JSON.stringify(legacy));

    const read = await svc.get('u1', wf.id);
    expect(read?.active).toBe(true);
    expect(read?.liveBrowser).toBe(false);

    // ...and through list() as well, which is what the Workspace table reads.
    const listed = await svc.list('u1');
    expect(listed[0].active).toBe(true);
    expect(listed[0].liveBrowser).toBe(false);
  });
});

describe('WorkflowService.setState', () => {
  it('flips active without bumping the version or writing history', async () => {
    const wf = await svc.create('u1', sampleInput());
    const before = await svc.listVersions('u1', wf.id);

    const off = await svc.setState('u1', wf.id, { active: false });
    expect(off?.active).toBe(false);
    // THE point of the endpoint: a switch is not a revision.
    expect(off?.version).toBe(wf.version);

    const after = await svc.listVersions('u1', wf.id);
    expect(after).toHaveLength(before.length);
    expect(after.map((v) => v.version)).toEqual(before.map((v) => v.version));
  });

  it('flips liveBrowser without bumping the version', async () => {
    const wf = await svc.create('u1', sampleInput());
    const on = await svc.setState('u1', wf.id, { liveBrowser: true });
    expect(on?.liveBrowser).toBe(true);
    expect(on?.version).toBe(wf.version);
  });

  it('is a partial patch: the untouched flag keeps its value', async () => {
    const wf = await svc.create('u1', sampleInput({ liveBrowser: true }));

    const a = await svc.setState('u1', wf.id, { active: false });
    expect(a?.active).toBe(false);
    expect(a?.liveBrowser).toBe(true); // untouched

    const b = await svc.setState('u1', wf.id, { liveBrowser: false });
    expect(b?.liveBrowser).toBe(false);
    expect(b?.active).toBe(false); // still untouched
  });

  it('persists the change (a later read agrees)', async () => {
    const wf = await svc.create('u1', sampleInput());
    await svc.setState('u1', wf.id, { active: false, liveBrowser: true });
    const read = await svc.get('u1', wf.id);
    expect(read?.active).toBe(false);
    expect(read?.liveBrowser).toBe(true);
  });

  it('advances updatedAt so the Workspace "Last updated" sort stays honest', async () => {
    const wf = await svc.create('u1', sampleInput());
    await new Promise((r) => setTimeout(r, 5));
    const off = await svc.setState('u1', wf.id, { active: false });
    expect(Date.parse(off!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(wf.updatedAt));
  });

  it('touches nothing else about the workflow', async () => {
    const wf = await svc.create('u1', sampleInput());
    const off = await svc.setState('u1', wf.id, { active: false });
    expect(off?.name).toBe(wf.name);
    expect(off?.description).toBe(wf.description);
    expect(off?.steps).toEqual(wf.steps);
    expect(off?.headless).toBe(wf.headless);
    expect(off?.createdAt).toBe(wf.createdAt);
  });

  it('returns null for an unknown workflow instead of creating one', async () => {
    expect(await svc.setState('u1', 'wf_missing', { active: true })).toBeNull();
    expect(await svc.get('u1', 'wf_missing')).toBeNull();
  });

  it('is scoped per user: another user cannot flip your switch', async () => {
    const wf = await svc.create('u1', sampleInput());
    expect(await svc.setState('u2', wf.id, { active: false })).toBeNull();
    expect((await svc.get('u1', wf.id))?.active).toBe(true);
  });
});

describe('WorkflowService.update — flags survive an editor save', () => {
  it('preserves active/liveBrowser across a normal update', async () => {
    const wf = await svc.create('u1', sampleInput());
    await svc.setState('u1', wf.id, { active: false, liveBrowser: true });

    const saved = await svc.update('u1', wf.id, sampleInput({ name: 'renamed' }));
    expect(saved?.name).toBe('renamed');
    expect(saved?.version).toBe(2); // a real save DOES bump the version
    // ...but must not resurrect a workflow the user deliberately switched off.
    expect(saved?.active).toBe(false);
    expect(saved?.liveBrowser).toBe(true);
  });

  it('ignores flags supplied in an update body (only setState may change them)', async () => {
    const wf = await svc.create('u1', sampleInput());
    await svc.setState('u1', wf.id, { active: false });

    const saved = await svc.update('u1', wf.id, sampleInput({ active: true, liveBrowser: true }));
    expect(saved?.active).toBe(false);
    expect(saved?.liveBrowser).toBe(false);
  });

  it('snapshots the flags into version history', async () => {
    const wf = await svc.create('u1', sampleInput());
    await svc.setState('u1', wf.id, { active: false, liveBrowser: true });
    await svc.update('u1', wf.id, sampleInput({ name: 'v2' }));

    const versions = await svc.listVersions('u1', wf.id);
    const newest = versions[0];
    expect(newest.version).toBe(2);
    expect(newest.active).toBe(false);
    expect(newest.liveBrowser).toBe(true);
  });
});
