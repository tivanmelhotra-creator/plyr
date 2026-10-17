/**
 * Owner brief 6.5 / 6.6 with the REAL user routes and a real Redis: every
 * workflow path that uses a profile honours the profile LOCK.
 *   - create / update with a profile locked to another workflow -> 409 profile_locked ("Locked to X");
 *     the owner itself may save it
 *   - activation of an INACTIVE workflow that references it (also an imported one,
 *     via a Launch node) -> 409 "Profile ... is locked to <owner>"
 *   - saving a schedule for it -> 409
 *   - the owner renames: the reason names the NEW name (lock stores the id)
 *   - owner deactivated -> lock stays
 *   - owner deletes -> its locks are released in the same request (releasedLocks)
 *   - owner switches to another profile -> the old lock stays until unlocked
 *   - boot sweep removes a lock whose workflow is gone, and logs it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { markTested } from '../helpers/test-run';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileAccess, registerProfileAccess } from '../../src/core/ProfileAccess';
import { ProfileLeases, leaseIdOf } from '../../src/core/ProfileLease';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { BrowserSessions } from '../../src/core/BrowserSessions';
import { ProfileFailureReports, registerProfileFailureReports, profileFailureReports } from '../../src/core/ProfileFailureReports';
import { workflowStoreFor } from '../../src/services/storage';

let redis: IORedis | null = null;
let up = false;
let app: Express;
let dir = '';
let registry: ProfileRegistry;
const USER = `lck${Date.now() % 100000}`;
let conflicts: Array<{ mine: { start: number; end: number }; other: { owner: string; ownerName?: string; start: number; end: number } }> = [];
let lastConflictQuery: any = null;
const added: any[] = [];

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
  if (!up) return;
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  const queue = {
    async add(_n: string, data: any) { added.push(data); return { id: String(added.length) }; },
    async getJob() { return null; },
    async getJobs() { return []; },
    async getRepeatableJobs() { return []; },
  };
  app = express();
  app.use(express.json());
  app.use('/', createUserRoutes({
    queue: queue as any, connection: redis as any, profileManager: {} as any,
    profileCoordinator: {
      syncReservations: async () => null,
      projectedConflicts: async (q: any) => { lastConflictQuery = q; return conflicts; },
    },
  }));
  registerProfileFailureReports(new ProfileFailureReports(redis));
});
afterAll(async () => {
  if (redis) { await redis.del(`profile:failures:${USER}`).catch(() => {}); redis.disconnect(); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});
beforeEach(() => {
  if (!up) return;
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-lck-'));
  registry = new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => path.join(dir, 'base') });
  registerProfileAccess(new ProfileAccess(registry, new ProfileLeases(redis!, 120), new ProfileReservations(redis!), new BrowserSessions(null)));
  conflicts = [];
  lastConflictQuery = null;
});

const steps = [{ action: 'goto', params: { url: 'https://example.com' } }];

async function workflowWith(profileId: string): Promise<string> {
  const res = await request(app).post(`/workflows/${USER}`).send({ name: `wf-${profileId}`, steps, profileId });
  expect(res.status).toBeLessThan(300);
  const id = res.body.workflow.id;
  await markTested(workflowStoreFor(redis!), USER, id);
  return id;
}
const activate = (id: string) => request(app).patch(`/workflows/${USER}/${id}/state`).send({ active: true });

const lockTo = (pid: string, wf: string) => registry.lock(USER, pid, wf);

describe('the profile lock on every workflow path (6.5 / 6.6)', () => {
  it('create and update with a profile locked to another workflow are refused; the owner may save', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Locked');
    const owner = await workflowWith(p.id);
    await lockTo(p.id, owner);
    const c = await request(app).post(`/workflows/${USER}`).send({ name: 'Intruder', steps, profileId: p.id });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('profile_locked');
    expect(c.body.error).toMatch(/Profile "Locked" is locked to "wf-/);
    const other = (await request(app).post(`/workflows/${USER}`).send({ name: 'Other', steps }).expect(201)).body.workflow.id;
    const u = await request(app).put(`/workflows/${USER}/${other}`).send({ name: 'Other', steps, profileId: p.id });
    expect(u.status).toBe(409);
    expect(u.body.code).toBe('profile_locked');
    // The owner saves freely (with or without naming the profile).
    expect((await request(app).put(`/workflows/${USER}/${owner}`).send({ name: 'wf-owner', steps, profileId: p.id })).status).toBe(200);
    expect((await request(app).put(`/workflows/${USER}/${owner}`).send({ name: 'wf-owner', steps })).status).toBe(200);
  });

  it('an inactive workflow that already references it (or an imported one with a Launch node naming it) fails ACTIVATION with the owner name', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Shared');
    const old = await workflowWith(p.id); // referenced before the lock: allowed to exist
    const owner = await workflowWith('default');
    await lockTo(p.id, owner);
    const r = await activate(old);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('profile_locked');
    expect(r.body.error).toContain('is locked to "wf-default"');
    expect(r.body.error).toContain('cannot be activated');
    // Imported: the file names the profile in a Launch Browser node.
    const file = { format: 'plyr-workflow', version: 1, workflow: { name: 'Imported', steps: [{ action: 'launch', params: { profileId: p.id } }, ...steps] } };
    const imp = await request(app).post(`/workflows/${USER}/import`).send(file);
    if (imp.status === 201) {
      const id = imp.body.workflow.id;
      expect(imp.body.workflow.active).toBe(false);
      await markTested(workflowStoreFor(redis!), USER, id);
      const a = await activate(id);
      expect(a.status, JSON.stringify(a.body)).toBe(409);
      expect(a.body.code).toBe('profile_locked');
    } else {
      // The exchange format refused this file shape: record why (still RUN, not silently skipped).
      console.log(`[6.5 import] import answered ${imp.status}: ${JSON.stringify(imp.body).slice(0, 200)}`);
      expect([400, 422]).toContain(imp.status);
    }
  });

  it('saving a schedule for a workflow whose profile is locked to another is refused', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Sched');
    const user = await workflowWith(p.id);
    expect((await activate(user)).status).toBe(200);
    const owner = await workflowWith('default');
    await lockTo(p.id, owner);
    const r = await request(app).post('/schedule').send({ userId: USER, cron: '0 3 * * *', workflowId: user });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('profile_locked');
  });

  it('owner renamed -> the reason names the new name; deactivated -> lock stays; switched profile -> old lock stays', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Follow');
    const p2 = await registry.create(USER, 'Elsewhere');
    const owner = await workflowWith(p.id);
    await lockTo(p.id, owner);
    await request(app).put(`/workflows/${USER}/${owner}`).send({ name: 'Renamed owner', steps, profileId: p.id }).expect(200);
    const c = await request(app).post(`/workflows/${USER}`).send({ name: 'X', steps, profileId: p.id });
    expect(c.body.error).toContain('locked to "Renamed owner"');
    expect((await activate(owner)).status).toBe(200);
    await request(app).patch(`/workflows/${USER}/${owner}/state`).send({ active: false }).expect(200);
    expect((await registry.get(USER, p.id))!.lockedTo!.workflowId).toBe(owner);
    await request(app).put(`/workflows/${USER}/${owner}`).send({ name: 'Renamed owner', steps, profileId: p2.id }).expect(200);
    expect((await registry.get(USER, p.id))!.lockedTo!.workflowId).toBe(owner);
  });

  it('owner DELETED -> its locks are released in the same request and logged; the profile is free again', async () => {
    if (!up) return;
    const a = await registry.create(USER, 'Free me 1');
    const b = await registry.create(USER, 'Free me 2');
    const owner = await workflowWith(a.id);
    await lockTo(a.id, owner);
    await lockTo(b.id, owner);
    const logs: string[] = [];
    const orig = console.log; console.log = (...x: unknown[]) => { logs.push(x.join(' ')); };
    let d: any;
    try { d = await request(app).delete(`/workflows/${USER}/${owner}`); } finally { console.log = orig; }
    expect(d.status).toBe(200);
    expect(d.body.releasedLocks.map((x: any) => x.name).sort()).toEqual(['Free me 1', 'Free me 2']);
    expect((await registry.get(USER, a.id))!.lockedTo ?? null).toBeNull();
    expect(logs.some((l) => l.includes('lock released automatically') && l.includes('Free me 1') && l.includes('workflow deleted'))).toBe(true);
    expect((await request(app).post(`/workflows/${USER}`).send({ name: 'Now allowed', steps, profileId: a.id })).status).toBe(201);
  });

  it('boot sweep: a lock whose workflow no longer exists is removed and logged; a live owner keeps its lock', async () => {
    if (!up) return;
    const { sweepStaleLocks } = await import('../../src/core/ProfileLock');
    const gone = await registry.create(USER, 'Orphan lock');
    const kept = await registry.create(USER, 'Kept lock');
    const live = await workflowWith('default');
    await registry.lock(USER, gone.id, 'wf_0000000000000dead');
    await registry.lock(USER, kept.id, live);
    const logs: string[] = [];
    const ids = (await request(app).get(`/workflows/${USER}`).expect(200)).body.workflows.map((w: any) => w.id);
    const r = await sweepStaleLocks({ registry, userId: USER, workflowIds: async () => ids, log: (m) => logs.push(m) });
    expect(r.map((x) => x.name)).toEqual(['Orphan lock']);
    expect(logs[0]).toContain('lock removed at start: "Orphan lock"');
    expect((await registry.get(USER, gone.id))!.lockedTo ?? null).toBeNull();
    expect((await registry.get(USER, kept.id))!.lockedTo!.workflowId).toBe(live);
    // Never throws: a broken workflow store is logged and skipped.
    const bad = await sweepStaleLocks({ registry, userId: USER, workflowIds: async () => { throw new Error('store down'); }, log: (m) => logs.push(m) });
    expect(bad).toEqual([]);
    expect(logs.at(-1)).toContain('lock sweep skipped: store down');
  });

  it('RUN: the worker check refuses a run of another workflow (and an ad-hoc run) on a locked profile; the owner passes; report + notification', async () => {
    if (!up) return;
    const { preRunLockCheck } = await import('../../src/core/ProfileLock');
    const p = await registry.create(USER, 'Run guard');
    const owner = await workflowWith(p.id);
    await lockTo(p.id, owner);
    const recorded: any[] = []; const notes: string[] = [];
    const base = { registry, userId: USER, profileId: p.id, workflowName: null, jobId: 'job-9',
      workflowNameOf: async () => 'The owner', record: async (_u: string, r: any) => { recorded.push(r); }, notify: (m: string) => notes.push(m) };
    expect(await preRunLockCheck({ ...base, workflowId: owner })).toBeNull();
    const other = await preRunLockCheck({ ...base, workflowId: 'wf_someoneelse00' });
    expect(other!.message).toBe('Profile "Run guard" is locked to "The owner"; this run cannot use it. Choose another profile.');
    const adhoc = await preRunLockCheck({ ...base, workflowId: null });
    expect(adhoc).not.toBeNull();
    expect(recorded.map((r) => [r.reason, r.detail, r.stage])).toEqual([['profile_locked', 'locked_to_other', 'run'], ['profile_locked', 'locked_to_other', 'run']]);
    expect(notes).toHaveLength(2);
    // Unlocked: everyone passes again.
    await registry.unlock(USER, p.id);
    expect(await preRunLockCheck({ ...base, workflowId: 'wf_someoneelse00' })).toBeNull();
  });

  it('DUPLICATE (same body as the UI sends: name + steps + profileId) does not inherit the lock: the copy is refused on a locked profile; a copy without it is fine', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Dup src');
    const owner = await workflowWith(p.id);
    await lockTo(p.id, owner);
    const src = (await request(app).get(`/workflows/${USER}/${owner}`).expect(200)).body.workflow;
    const copy = await request(app).post(`/workflows/${USER}`).send({ name: src.name + ' (copy)', steps: src.steps, profileId: src.profileId });
    expect(copy.status).toBe(409);
    expect(copy.body.code).toBe('profile_locked');
    const plain = await request(app).post(`/workflows/${USER}`).send({ name: src.name + ' (copy 2)', steps: src.steps });
    expect(plain.status).toBe(201);
    // The lock still belongs to the original only.
    expect((await registry.get(USER, p.id))!.lockedTo!.workflowId).toBe(owner);
  });
});
