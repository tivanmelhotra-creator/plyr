import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Workflow Storage service (Step 17, G2) ─────────────────────────────────
// Exercises the CRUD + versioning logic of WorkflowService against a tiny
// in-memory Redis stub (no real Redis). Asserts: create assigns id/version,
// list is per-user and newest-first, update bumps version + snapshots history,
// history pruning honours WORKFLOW_MAX_VERSIONS, and delete clears everything.

// Deterministic, small history cap so we can assert pruning behaviour.
vi.mock('../../src/config', () => ({
  config: { WORKFLOW_MAX_VERSIONS: 3 },
}));

import { WorkflowService } from '../../src/services/workflow.service';

// Minimal in-memory Redis stub implementing only what WorkflowService touches.
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
  name: 'Daily scrape',
  description: 'desc',
  steps: [{ action: 'goto', params: { url: 'https://e.com' } }],
  headless: true,
  webhookUrl: null,
  ...over,
});

describe('WorkflowService.create', () => {
  it('assigns a server id, version 1 and timestamps', async () => {
    const wf = await svc.create('u1', sampleInput());
    expect(wf.id).toMatch(/^wf_[0-9a-f]{16}$/);
    expect(wf.userId).toBe('u1');
    expect(wf.version).toBe(1);
    expect(wf.name).toBe('Daily scrape');
    expect(wf.createdAt).toBeTruthy();
    expect(wf.updatedAt).toBe(wf.createdAt);

    // It is retrievable and indexed under the user.
    const fetched = await svc.get('u1', wf.id);
    expect(fetched?.id).toBe(wf.id);
    const list = await svc.list('u1');
    expect(list.map((w) => w.id)).toContain(wf.id);
  });

  it('records the first version in history', async () => {
    const wf = await svc.create('u1', sampleInput());
    const versions = await svc.listVersions('u1', wf.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
  });
});

describe('WorkflowService.list', () => {
  it('is scoped per user and returns newest-updated first', async () => {
    const a = await svc.create('u1', sampleInput({ name: 'A' }));
    // Force a later updatedAt for b by updating it.
    const b = await svc.create('u1', sampleInput({ name: 'B' }));
    await new Promise((r) => setTimeout(r, 5));
    await svc.update('u1', a.id, sampleInput({ name: 'A2' }));

    const other = await svc.create('u2', sampleInput({ name: 'OTHER' }));

    const u1 = await svc.list('u1');
    expect(u1.map((w) => w.name)).toEqual(['A2', 'B']); // A just updated -> first
    expect(u1.map((w) => w.id)).not.toContain(other.id);

    const u2 = await svc.list('u2');
    expect(u2).toHaveLength(1);
    expect(u2[0].id).toBe(other.id);
    expect(b).toBeTruthy();
  });

  it('returns an empty array for a user with no workflows', async () => {
    expect(await svc.list('ghost')).toEqual([]);
  });
});

describe('WorkflowService.update', () => {
  it('bumps the version and keeps one current state (autosave writes no history)', async () => {
    const wf = await svc.create('u1', sampleInput({ name: 'v1' }));
    const u2 = await svc.update('u1', wf.id, sampleInput({ name: 'v2' }));
    expect(u2?.version).toBe(2);
    expect(u2?.name).toBe('v2');
    expect(u2?.createdAt).toBe(wf.createdAt); // createdAt preserved

    // Only the creation entry exists; the edit replaced the current state.
    const versions = await svc.listVersions('u1', wf.id);
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect((await svc.get('u1', wf.id))?.name).toBe('v2');
  });

  it('returns null for an unknown workflow', async () => {
    expect(await svc.update('u1', 'wf_missing', sampleInput())).toBeNull();
  });

  it('many autosaves never grow history; manual saves are never pruned', async () => {
    const wf = await svc.create('u1', sampleInput({ name: 'v1' }));
    await svc.saveManual('u1', wf.id, 'keep me');
    for (let i = 2; i <= 40; i++) await svc.update('u1', wf.id, sampleInput({ name: `v${i}` }));

    const versions = await svc.listVersions('u1', wf.id);
    expect(versions.filter((v) => v.kind === 'manual')).toHaveLength(1);
    expect(versions.filter((v) => v.kind !== 'manual')).toHaveLength(1); // creation only
    expect((await svc.get('u1', wf.id))?.version).toBe(40);
  });
});

describe('WorkflowService.remove', () => {
  it('deletes the workflow, its index entry and its version history', async () => {
    const wf = await svc.create('u1', sampleInput());
    await svc.update('u1', wf.id, sampleInput({ name: 'v2' }));

    expect(await svc.remove('u1', wf.id)).toBe(true);
    expect(await svc.get('u1', wf.id)).toBeNull();
    expect((await svc.list('u1')).map((w) => w.id)).not.toContain(wf.id);
    expect(await svc.listVersions('u1', wf.id)).toEqual([]);
  });

  it('returns false when removing a non-existent workflow', async () => {
    expect(await svc.remove('u1', 'wf_nope')).toBe(false);
  });
});
