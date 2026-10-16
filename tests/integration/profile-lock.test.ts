/**
 * Owner brief section 6 — profile lock ROUTES (real Redis, real registry, fake launcher):
 *   lock / unlock rules (6.2, 6.3), the atomic lock under two simultaneous
 *   requests (one wins), delete profile / delete branch blocked while locked
 *   (6.6), lock follows the workflow id across a rename (6.4/6.6), persists
 *   in a new registry instance (restart, 6.6).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileLeases, HOLD_PREFIX, RESV_PREFIX, leaseIdOf } from '../../src/core/ProfileLease';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { BrowserSessions, registerBrowserSessions, jobDependent } from '../../src/core/BrowserSessions';
import { ProfileAccess } from '../../src/core/ProfileAccess';
import { ProfileManager } from '../../src/core/ProfileManager';
import { setProfileLauncherForTests } from '../../src/core/ProfileBrowser';
import { createProfileRoutes } from '../../src/Routes/profile.routes';
import { WorkflowService } from '../../src/services/workflow.service';
import { workflowStoreFor } from '../../src/services/storage';
import { config } from '../../src/config';

let redis: IORedis | null = null;
let up = false;
let dir = '';
let base = '';
let app: express.Express;
let sessions: BrowserSessions;
let pm: ProfileManager;
let leases: ProfileLeases;
let registry: ProfileRegistry;
let launches: Array<{ root: string; args: string[] }> = [];
let scheduled = new Set<string>();
const USER = 'local';

class FakeContext {
  closed = false;
  private handlers: Array<() => void> = [];
  _pages: any[] = [{ url: () => 'about:blank', title: async () => '' }];
  pages() { if (this.closed) throw new Error('closed'); return this._pages; }
  async newPage() { const p: any = { url: () => 'about:blank', title: async () => '' }; this._pages.push(p); return p; }
  async storageState() { return { cookies: [], origins: [] }; }
  on(ev: string, fn: () => void) { if (ev === 'close') this.handlers.push(fn); }
  async close() { this.closed = true; this.handlers.forEach((h) => h()); }
}

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
});
afterAll(async () => { if (redis) redis.disconnect(); setProfileLauncherForTests(null); });

beforeEach(async () => {
  if (!up) return;
  for (const pre of ['profile:lease:', HOLD_PREFIX, RESV_PREFIX, 'profile:grant:', 'profile:session:']) {
    const keys = await redis!.keys(`${pre}*`);
    if (keys.length) await redis!.del(...keys);
  }
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-lock-'));
  base = path.join(dir, 'base-a');
  launches = [];
  scheduled = new Set();
  setProfileLauncherForTests(async (root: string, args: string[]) => { launches.push({ root, args }); return new FakeContext() as any; });
  sessions = new BrowserSessions(redis!);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  leases = new ProfileLeases(redis!, 120);
  registry = new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => base });
  const access = new ProfileAccess(registry, leases, new ProfileReservations(redis!), sessions);
  app = express();
  app.use(express.json());
  app.use(createProfileRoutes({
    connection: redis!, access, profileManager: pm,
    schedules: { overlaps: async () => [], unresolvedSchedules: async () => [], scheduledWorkflowIds: async () => scheduled },
  }));
});

const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } };
const wfs = () => new WorkflowService(workflowStoreFor(redis!));
async function makeWorkflow(name: string, profileId: string, active = false) {
  const wf = await wfs().create(USER, { name, steps: [{ action: 'goto', params: { url: 'https://example.com' } }], profileId });
  if (active) await wfs().setState(USER, wf.id, { active: true, activeSnapshot: WorkflowService.buildActiveSnapshot(wf) });
  return wf;
}
const folderArg = (args: string[]) => args.filter((a) => a.startsWith('--profile-directory='));

describe('profile lock routes (section 6)', () => {
  afterAll(cleanup);

  it('lock to a workflow; the profile view shows it; a second owner is refused', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Shop', branchId: 'new' }).expect(201)).body.profile;
    const a = await makeWorkflow('Orders', p.id);
    const b = await makeWorkflow('Reports', 'default');
    const r = await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: a.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lockedTo).toMatchObject({ workflowId: a.id, name: 'Orders' });
    expect((await registry.get(USER, p.id))!.lockedTo!.workflowId).toBe(a.id);
    // Same owner again: unchanged, 200.
    expect((await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: a.id })).status).toBe(200);
    const r2 = await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: b.id });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('already_locked');
    expect(r2.body.error).toContain('Orders');
  });

  it('unknown workflow -> 404; another ACTIVE workflow using the profile blocks the lock and is listed; an inactive one does not', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Mail', branchId: 'new' }).expect(201)).body.profile;
    const owner = await makeWorkflow('Owner', p.id);
    expect((await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: 'wf_doesnotexist' })).status).toBe(404);
    await makeWorkflow('Sleeping user', p.id, false);
    const busy = await makeWorkflow('Active user', p.id, true);
    const r = await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: owner.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('referenced_by_others');
    expect(r.body.blocking.map((x: any) => x.name)).toEqual(['Active user']);
    expect(r.body.blocking[0].workflowId).toBe(busy.id);
    // A scheduled one blocks too.
    await wfs().setState(USER, busy.id, { active: false });
    scheduled.add(busy.id);
    expect((await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: owner.id })).body.code).toBe('referenced_by_others');
    scheduled.delete(busy.id);
    expect((await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: owner.id })).status).toBe(200);
  });

  it('ATOMIC: two simultaneous lock requests for different workflows -> exactly one wins, the other gets a clear 409', async () => {
    if (!up) return;
    for (let round = 0; round < 5; round++) {
      const p = (await request(app).post('/profiles').send({ name: `Race ${round}`, branchId: 'new' }).expect(201)).body.profile;
      const a = await makeWorkflow(`A${round}`, 'default');
      const b = await makeWorkflow(`B${round}`, 'default');
      const [ra, rb] = await Promise.all([
        request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: a.id }),
        request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: b.id }),
      ]);
      const codes = [ra.status, rb.status].sort();
      expect(codes, JSON.stringify([ra.body, rb.body])).toEqual([200, 409]);
      const loser = ra.status === 409 ? ra : rb;
      expect(['locked', 'already_locked']).toContain(loser.body.code);
      expect(loser.body.error).toMatch(/already locked/);
      const winner = ra.status === 200 ? a : b;
      expect((await registry.get(USER, p.id))!.lockedTo!.workflowId).toBe(winner.id);
    }
  });

  it('unlock: inactive owner -> free; active owner -> 428 naming it, then confirm; running owner -> 409 stop it first', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Unlock me', branchId: 'new' }).expect(201)).body.profile;
    const w = await makeWorkflow('Owner U', p.id);
    await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: w.id }).expect(200);
    expect((await request(app).post(`/profiles/${p.id}/unlock`).send({})).body).toMatchObject({ unlocked: true, was: { workflowId: w.id, name: 'Owner U' } });
    expect((await request(app).post(`/profiles/${p.id}/unlock`).send({})).body).toMatchObject({ unlocked: false, reason: 'not_locked' });

    await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: w.id }).expect(200);
    await wfs().setState(USER, w.id, { active: true, activeSnapshot: WorkflowService.buildActiveSnapshot((await wfs().get(USER, w.id))!) });
    const c = await request(app).post(`/profiles/${p.id}/unlock`).send({});
    expect(c.status).toBe(428);
    expect(c.body.error).toContain('Owner U');
    expect((await registry.get(USER, p.id))!.lockedTo).toBeTruthy();
    expect((await request(app).post(`/profiles/${p.id}/unlock`).send({ confirm: true })).status).toBe(200);
    // Its own reference stays valid.
    expect((await wfs().get(USER, w.id))!.profileId).toBe(p.id);

    // Running owner: a run lease held by the owner on the branch.
    await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: w.id }).expect(200);
    const leaseId = leaseIdOf(p.id);
    const got = await leases.acquire(leaseId, 'job-1', { owner: w.id });
    expect(got.ok, JSON.stringify(got)).toBe(true);
    sessions.opened(leaseId, { userId: USER, visibility: 'hidden', createdBy: jobDependent('job-1') });
    const run = await request(app).post(`/profiles/${p.id}/unlock`).send({ confirm: true });
    expect(run.status, JSON.stringify(run.body)).toBe(409);
    expect(run.body.code).toBe('owner_running');
    expect(run.body.error).toMatch(/Owner U.*Stop it first/);
    sessions.closed(leaseId);
    await leases.release(leaseId, got.ok ? got.token : null);
  });

  it('delete profile / delete branch are blocked while locked and name the owner; after unlock they work', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Keep', branchId: 'new' }).expect(201)).body.profile;
    const w = await makeWorkflow('Keeper', 'default');
    await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: w.id }).expect(200);
    const d = await request(app).delete(`/profiles/${p.id}`);
    expect(d.status).toBe(409);
    expect(d.body.error).toContain('locked to "Keeper"');
    const scan = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan.deletable).toBe(false);
    expect(scan.lockedProfiles).toEqual([expect.objectContaining({ profileId: p.id, name: 'Keep', workflowName: 'Keeper' })]);
    expect((await request(app).delete(`/profiles/branches/${p.branchId}`)).status).toBe(409);
    // The registry refuses too (defence in depth).
    await expect(registry.remove(USER, p.id)).rejects.toThrow(/locked/);
    await request(app).post(`/profiles/${p.id}/unlock`).send({}).expect(200);
    expect((await request(app).delete(`/profiles/${p.id}`)).status).toBe(200);
  });

  it('the lock follows the workflow ID across a rename, and persists in a fresh registry (server restart)', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Sticky', branchId: 'new' }).expect(201)).body.profile;
    const w = await makeWorkflow('Old name', 'default');
    await request(app).post(`/profiles/${p.id}/lock`).send({ workflowId: w.id }).expect(200);
    const cur = (await wfs().get(USER, w.id))!;
    await wfs().update(USER, w.id, { name: 'New name', description: null, steps: cur.steps, headless: null, webhookUrl: null });
    const d = await request(app).delete(`/profiles/${p.id}`);
    expect(d.body.error).toContain('locked to "New name"');
    const fresh = new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => base });
    expect((await fresh.get(USER, p.id))!.lockedTo!.workflowId).toBe(w.id);
  });
});
