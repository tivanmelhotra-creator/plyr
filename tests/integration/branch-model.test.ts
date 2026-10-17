/**
 * Phase 1 branch model (core/BranchRegistry + Routes/profile.routes), real Redis.
 *
 *   - create a branch + profile; the open uses root=<base>/branch-NNN + --profile-directory=profile-NNN
 *   - two profiles of ONE branch: the second open is refused with the running profile named, no 2nd launch
 *   - two branches: two separate launches (separate roots)
 *   - opening an already-running profile reuses it (no launch)
 *   - branch ids are never reused after deletion
 *   - delete branch: blocked by an active workflow; blocked by a scheduled workflow; blocked while running;
 *     succeeds after reassignment; a profile started during the hold cancels the deletion (server rescan)
 *   - inactive workflows keep their definition; their profile reference is cleared
 *   - base directory: a change moves no data; new branches go to the new base; invalid bases are refused
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
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-br-'));
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

describe('branch model', () => {
  it('create -> open: root is <base>/branch-NNN, exactly one --profile-directory=profile-NNN', async () => {
    if (!up) return;
    const c = await request(app).post('/profiles').send({ name: 'Shop', branchId: 'new' }).expect(201);
    const p = c.body.profile;
    expect(p.branchId).toMatch(/^branch-\d{3}$/);
    await request(app).post(`/profiles/${p.id}/open`).send({}).expect(200);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.root).toBe(path.join(base, p.branchId));
    expect(folderArg(launches[0]!.args)).toEqual(['--profile-directory=profile-001']);
    expect(launches[0]!.args.some((a) => a.startsWith('--user-data-dir'))).toBe(false);
    // Opening it again while it runs: the same browser, no second launch.
    const again = await request(app).post(`/profiles/${p.id}/open`).send({}).expect(200);
    expect(again.body.reused).toBe(true);
    expect(launches).toHaveLength(1);
    cleanup();
  });

  it('two profiles of ONE branch: the second open is refused, names the running one, launches nothing', async () => {
    if (!up) return;
    const a = (await request(app).post('/profiles').send({ name: 'A', branchId: 'new' }).expect(201)).body.profile;
    const b = (await request(app).post('/profiles').send({ name: 'B', branchId: a.branchId }).expect(201)).body.profile;
    expect(b.branchId).toBe(a.branchId);
    expect(b.folder).toBe('profile-002');
    expect(leaseIdOf(a.id)).toBe(leaseIdOf(b.id)); // one lock per branch
    await request(app).post(`/profiles/${a.id}/open`).send({}).expect(200);
    const r = await request(app).post(`/profiles/${b.id}/open`).send({}).expect(409);
    expect(r.body.code).toBe('branch_busy');
    expect(r.body.runningProfile).toMatchObject({ id: a.id, name: 'A' });
    expect(r.body.viewPath).toBe(`/desktop/chrome?profile=${a.id}`);
    expect(launches).toHaveLength(1);
    // The list says why B waits.
    const list = await request(app).get('/profiles').expect(200);
    expect(list.body.profiles.find((x: any) => x.id === b.id).branchBusyWith).toMatchObject({ id: a.id });
    cleanup();
  });

  it('two branches run at the same time: two launches, two roots', async () => {
    if (!up) return;
    const a = (await request(app).post('/profiles').send({ name: 'A' }).expect(201)).body.profile;
    const b = (await request(app).post('/profiles').send({ name: 'B' }).expect(201)).body.profile;
    expect(a.branchId).not.toBe(b.branchId);
    await request(app).post(`/profiles/${a.id}/open`).send({}).expect(200);
    await request(app).post(`/profiles/${b.id}/open`).send({}).expect(200);
    expect(launches.map((l) => path.basename(l.root))).toEqual([a.branchId, b.branchId]);
    cleanup();
  });

  it('branch ids are never reused after deletion', async () => {
    if (!up) return;
    const a = (await request(app).post('/profiles').send({ name: 'A' }).expect(201)).body.profile;
    await request(app).delete(`/profiles/branches/${a.branchId}`).expect(200);
    expect(existsSync(path.join(base, a.branchId))).toBe(false);
    const b = (await request(app).post('/profiles').send({ name: 'B' }).expect(201)).body.profile;
    expect(Number(b.branchId.slice(7))).toBeGreaterThan(Number(a.branchId.slice(7)));
    // Even a fresh registry instance (restart) does not go back.
    const again = await new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => base }).createBranch(USER);
    expect(Number(again.id.slice(7))).toBeGreaterThan(Number(b.branchId.slice(7)));
    cleanup();
  });

  it('delete branch: blocked by an ACTIVE workflow, then by a SCHEDULED one; allowed after reassignment', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Shop' }).expect(201)).body.profile;
    const other = (await request(app).post('/profiles').send({ name: 'Other' }).expect(201)).body.profile;
    const wf = await makeWorkflow('Nightly', p.id, true);
    let scan = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan.deletable).toBe(false);
    expect(scan.blockingWorkflows).toEqual([expect.objectContaining({ workflowId: wf.id, name: 'Nightly', profileName: 'Shop', state: 'active' })]);
    expect((await request(app).delete(`/profiles/branches/${p.branchId}`).expect(409)).body.code).toBe('blocked');
    // Scheduled = always active (owner's rule), reported as scheduled.
    scheduled.add(wf.id);
    scan = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan.blockingWorkflows[0].state).toBe('scheduled');
    // Reassign the workflow (and its frozen snapshot) to a profile in another branch.
    const cur = (await wfs().get(USER, wf.id))!;
    await wfs().update(USER, wf.id, { name: cur.name, steps: cur.steps, profileId: other.id });
    await wfs().setState(USER, wf.id, { active: true, activeSnapshot: WorkflowService.buildActiveSnapshot((await wfs().get(USER, wf.id))!) });
    scheduled.clear();
    scan = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan.deletable).toBe(true);
    await request(app).delete(`/profiles/branches/${p.branchId}`).expect(200);
    expect(await registry.get(USER, p.id)).toBeNull();
    // Other branches are never touched.
    expect(await registry.get(USER, other.id)).toBeTruthy();
    cleanup();
  });

  it('a running profile blocks deletion; a profile started DURING the hold cancels it (server rescan)', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Shop' }).expect(201)).body.profile;
    const scan0 = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan0.deletable).toBe(true); // the dialog would show the hold button now
    // ...during the 3 s hold, the profile is started:
    await request(app).post(`/profiles/${p.id}/open`).send({}).expect(200);
    const r = await request(app).delete(`/profiles/branches/${p.branchId}`).expect(409);
    expect(r.body.scan.runningProfiles).toEqual([expect.objectContaining({ profileId: p.id, name: 'Shop' })]);
    expect(existsSync(path.join(base, p.branchId))).toBe(true);
    cleanup();
  });

  it('a running WORKFLOW (lease) blocks deletion and is named', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Shop' }).expect(201)).body.profile;
    const wf = await makeWorkflow('Runner', p.id, true);
    const got = await leases.acquire(leaseIdOf(p.id), '77', { owner: wf.id });
    expect(got.ok).toBe(true);
    sessions.opened(leaseIdOf(p.id), { userId: USER, visibility: 'hidden', createdBy: jobDependent('77') });
    const scan = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan.deletable).toBe(false);
    expect(scan.blockingWorkflows[0]).toMatchObject({ workflowId: wf.id, state: 'running' });
    cleanup();
  });

  it('inactive workflows keep their definition; their profile reference is cleared ("profile missing")', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Shop' }).expect(201)).body.profile;
    const wf = await makeWorkflow('Old', p.id, false);
    const scan = (await request(app).get(`/profiles/branches/${p.branchId}/deletion-scan`).expect(200)).body.scan;
    expect(scan.deletable).toBe(true);
    expect(scan.inactiveWorkflows).toEqual([expect.objectContaining({ workflowId: wf.id, name: 'Old' })]);
    const r = await request(app).delete(`/profiles/branches/${p.branchId}`).expect(200);
    expect(r.body.profileMissing).toEqual([wf.id]);
    const after = (await wfs().get(USER, wf.id))!;
    expect(after.steps).toEqual(wf.steps);
    expect(after.profileId || null).toBeNull();
    expect(after.profileMissing).toMatchObject({ profileId: p.id, profileName: 'Shop' });
    cleanup();
  });

  it('brief 2.1: a fresh install lists no branch; the first branch is branch-001; registry == UI list == folders on disk', async () => {
    if (!up) return;
    const { readdirSync } = await import('node:fs');
    expect((await request(app).get('/profiles/branches').expect(200)).body.branches).toEqual([]);
    const a = (await request(app).post('/profiles').send({ name: 'Shop A' }).expect(201)).body.profile;
    const b = (await request(app).post('/profiles').send({ name: 'Shop B' }).expect(201)).body.profile;
    expect([a.branchId, b.branchId]).toEqual(['branch-001', 'branch-002']);
    const ui = (await request(app).get('/profiles/branches').expect(200)).body.branches.map((x: any) => x.id).sort();
    const reg = (await registry.branches(USER)).map((x) => x.id).sort();
    const disk = readdirSync(base).filter((d) => /^branch-\d+$/.test(d)).sort();
    expect(ui).toEqual(['branch-001', 'branch-002']);
    expect(reg).toEqual(ui);
    expect(disk).toEqual(ui);
    // No retired flags reach the UI.
    for (const x of (await request(app).get('/profiles/branches')).body.branches) {
      expect(x).not.toHaveProperty('builtIn'); expect(x).not.toHaveProperty('legacy'); expect(x).not.toHaveProperty('external');
    }
    cleanup();
  });

  it('brief 2.1: an old registry with a hidden Local Browser branch is cleaned; its folder is kept; ids are never reused', async () => {
    if (!up) return;
    const { mkdirSync, readFileSync: rf } = await import('node:fs');
    const lbRoot = path.join(dir, 'chrome-profile');
    mkdirSync(path.join(lbRoot, 'Default'), { recursive: true });
    writeFileSync(path.join(lbRoot, 'Default', 'Cookies'), 'lb');
    const now = new Date().toISOString();
    const file = path.join(dir, 'profiles', USER, 'branches.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, nextBranch: 3, branches: [
      { id: 'branch-001', label: 'Local Browser', root: lbRoot, leaseKey: 'realchrome', createdAt: now, updatedAt: now, legacy: true, builtIn: true, kind: 'local-browser', nextProfile: 1 },
    ], profiles: [{ id: 'local-browser', branchId: 'branch-001', folder: 'Default', name: 'Local Browser', createdAt: now, updatedAt: now, builtIn: true }] }));
    registry.forget();
    expect((await request(app).get('/profiles/branches').expect(200)).body.branches).toEqual([]);
    const saved = JSON.parse(rf(file, 'utf8'));
    expect(saved.branches).toEqual([]);
    expect(saved.profiles).toEqual([]);
    expect(rf(path.join(lbRoot, 'Default', 'Cookies'), 'utf8')).toBe('lb'); // never deleted
    const p = (await request(app).post('/profiles').send({ name: 'New' }).expect(201)).body.profile;
    expect(p.branchId).toBe('branch-003'); // the counter is never lowered: no reuse
    cleanup();
  });

  it('brief 2.1: unlisted branch-NNN folders under the base: empty -> removed, with data -> listed as "Branch N" (data kept)', async () => {
    if (!up) return;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(base, 'branch-004'), { recursive: true }); // leftover, no data
    mkdirSync(path.join(base, 'branch-007', 'profile-001'), { recursive: true });
    writeFileSync(path.join(base, 'branch-007', 'profile-001', 'Preferences'), '{}');
    writeFileSync(path.join(base, 'branch-007', 'Local State'), JSON.stringify({ profile: { info_cache: { 'profile-001': { name: 'Recovered' } } } }));
    registry.forget();
    const list = (await request(app).get('/profiles/branches').expect(200)).body.branches;
    expect(list.map((b: any) => [b.id, b.label])).toEqual([['branch-007', 'Branch 7']]);
    expect(list[0].profiles.map((p: any) => [p.name, p.folder])).toEqual([['Recovered', 'profile-001']]);
    expect(existsSync(path.join(base, 'branch-004'))).toBe(false);
    expect(existsSync(path.join(base, 'branch-007', 'profile-001', 'Preferences'))).toBe(true);
    const n = (await request(app).post('/profiles').send({ name: 'Next' }).expect(201)).body.profile;
    expect(n.branchId).toBe('branch-008');
    cleanup();
  });

  it('every branch can be deleted (no built-in branch exists)', async () => {
    if (!up) return;
    const p = (await request(app).post('/profiles').send({ name: 'Solo' }).expect(201)).body.profile;
    await request(app).delete(`/profiles/branches/${p.branchId}`).expect(200);
    expect((await request(app).get('/profiles/branches').expect(200)).body.branches).toEqual([]);
    cleanup();
  });

  it('one profile of a branch with several can be deleted alone; the branch and its sibling stay; the folder number is not reused', async () => {
    if (!up) return;
    const a = (await request(app).post('/profiles').send({ name: 'A' }).expect(201)).body.profile;
    const b = (await request(app).post('/profiles').send({ name: 'B', branchId: a.branchId }).expect(201)).body.profile;
    expect(b.folder).toBe('profile-002');
    await request(app).delete(`/profiles/${b.id}`).expect(200);
    expect(existsSync(path.join(base, a.branchId, 'profile-002'))).toBe(false);
    expect(existsSync(path.join(base, a.branchId, 'profile-001'))).toBe(true);
    const c = (await request(app).post('/profiles').send({ name: 'C', branchId: a.branchId }).expect(201)).body.profile;
    expect(c.folder).toBe('profile-003');
    cleanup();
  });

  it('changing the base directory moves no data; new branches go to the new base', async () => {
    if (!up) return;
    const a = (await request(app).post('/profiles').send({ name: 'A' }).expect(201)).body.profile;
    const marker = path.join(base, a.branchId, 'profile-001', 'Cookies');
    writeFileSync(marker, 'keep-me');
    base = path.join(dir, 'base-b');
    const b = (await request(app).post('/profiles').send({ name: 'B' }).expect(201)).body.profile;
    expect(existsSync(path.join(dir, 'base-b', b.branchId, 'profile-001'))).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('keep-me');
    // The old branch still opens from its old root.
    await request(app).post(`/profiles/${a.id}/open`).send({}).expect(200);
    expect(launches[0]!.root).toBe(path.join(dir, 'base-a', a.branchId));
    cleanup();
  });

  it('PUT /profiles/base-dir validates on disk and refuses forbidden places', async () => {
    if (!up) return;
    const prev = config.BRANCH_BASE_DIR;
    try {
      const bad1 = await request(app).put('/profiles/base-dir').send({ baseDir: 'relative/path' }).expect(400);
      expect(bad1.body.error).toMatch(/absolute/);
      const bad2 = await request(app).put('/profiles/base-dir').send({ baseDir: path.join(dir, 'x', 'User Data', 'y') }).expect(400);
      expect(bad2.body.error).toMatch(/User Data/);
      const fakeChrome = path.join(dir, 'chromeish');
      await request(app).put('/profiles/base-dir').send({ baseDir: fakeChrome }).expect(200);
      writeFileSync(path.join(fakeChrome, 'Local State'), '{}');
      const bad3 = await request(app).put('/profiles/base-dir').send({ baseDir: fakeChrome }).expect(400);
      expect(bad3.body.error).toMatch(/Chromium data folder/);
      const ok = await request(app).put('/profiles/base-dir').send({ baseDir: path.join(dir, 'new-base') }).expect(200);
      expect(ok.body.baseDir).toBe(path.join(dir, 'new-base'));
      expect(existsSync(path.join(dir, 'new-base'))).toBe(true);
    } finally {
      config.BRANCH_BASE_DIR = prev;
    }
    cleanup();
  });

  it('brief 1.4: "Add an existing folder (outside Aria)" is gone: both routes answer 404 and nothing is registered', async () => {
    if (!up) return;
    const ext = path.join(dir, 'my-old-chrome');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(ext, 'Default'), { recursive: true });
    writeFileSync(path.join(ext, 'Local State'), '{}');
    await request(app).post('/profiles/branches/external/inspect').send({ root: ext }).expect(404);
    await request(app).post('/profiles/branches/external').send({ root: ext, confirm: ext }).expect(404);
    expect((await registry.branches(USER)).some((b) => b.root === ext)).toBe(false);
    cleanup();
  });
});
