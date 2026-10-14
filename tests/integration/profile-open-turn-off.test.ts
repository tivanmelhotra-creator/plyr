/**
 * Browser Profiles: the Open path (branch model) and Turn off, over HTTP with
 * real Redis and a fake launcher. Self-skips without Redis.
 *
 *   Open
 *     - launches with root = the BRANCH root (never the profile folder) and
 *       exactly one explicit --profile-directory=<registry folder>;
 *     - Local State is never read for a registry profile (a `last_used`
 *       pointing elsewhere changes nothing);
 *     - a running profile is reused: no second launch, same session;
 *     - a profile the registry cannot locate is refused before any launch.
 *   Turn off (POST /profiles/turn-off)
 *     - closes every browser Browser Profiles opened that no workflow uses;
 *     - keeps a browser a workflow depends on open and names the workflow and
 *       the profile;
 *     - never touches a session it did not open (realchrome).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileLeases, HOLD_PREFIX, RESV_PREFIX, leaseIdOf } from '../../src/core/ProfileLease';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { BrowserSessions, registerBrowserSessions, jobDependent } from '../../src/core/BrowserSessions';
import { ProfileAccess } from '../../src/core/ProfileAccess';
import { ProfileManager } from '../../src/core/ProfileManager';
import { setProfileLauncherForTests, assertBranchLaunch } from '../../src/core/ProfileBrowser';
import { createProfileRoutes } from '../../src/Routes/profile.routes';
import { WorkflowService } from '../../src/services/workflow.service';
import { workflowStoreFor } from '../../src/services/storage';

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
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-ot-'));
  base = path.join(dir, 'base');
  launches = [];
  setProfileLauncherForTests(async (root: string, args: string[]) => { launches.push({ root, args }); return new FakeContext() as any; });
  sessions = new BrowserSessions(redis!);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  leases = new ProfileLeases(redis!, 120);
  registry = new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => base });
  const access = new ProfileAccess(registry, leases, new ProfileReservations(redis!), sessions);
  app = express();
  app.use(express.json());
  app.use(createProfileRoutes({ connection: redis!, access, profileManager: pm }));
});

const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } };
const folderArgs = (args: string[]) => args.filter((a) => a.startsWith('--profile-directory'));

async function newProfile(name: string, branchId = 'new') {
  const r = await request(app).post('/profiles').send({ name, branchId }).expect(201);
  return r.body.profile as { id: string; branchId: string; folder: string };
}

describe('Open (branch model)', () => {
  it('root = branch root, explicit --profile-directory = registry folder; never the profile folder as root', async () => {
    if (!up) return;
    const p = await newProfile('Shop');
    await request(app).post(`/profiles/${p.id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    expect(launches).toHaveLength(1);
    const { root, args } = launches[0]!;
    expect(path.basename(root)).toMatch(/^branch-\d{3}$/);
    expect(path.dirname(root)).toBe(base);
    expect(folderArgs(args)).toEqual(['--profile-directory=profile-001']);
    expect(path.basename(root)).not.toBe('profile-001');
    expect(args.some((a) => a.startsWith('--user-data-dir'))).toBe(false); // Playwright adds the root itself
    cleanup();
  });

  it('a second profile in the same branch gets its own folder in the same root', async () => {
    if (!up) return;
    const a = await newProfile('A');
    const b = await newProfile('B', a.branchId);
    await request(app).post(`/profiles/${a.id}/open`).send({}).expect(200);
    await request(app).post(`/profiles/${a.id}/close`).send({}).expect(200);
    await request(app).post(`/profiles/${a.id}/release`).send({});
    await request(app).post(`/profiles/${b.id}/open`).send({}).expect(200);
    expect(launches.map((l) => l.root)).toEqual([launches[0]!.root, launches[0]!.root]);
    expect(launches.map((l) => folderArgs(l.args)[0])).toEqual(['--profile-directory=profile-001', '--profile-directory=profile-002']);
    cleanup();
  });

  it('Local State is not read for a registry profile: last_used elsewhere changes nothing', async () => {
    if (!up) return;
    const p = await newProfile('Pinned');
    const root = (await registry.locationOf(USER, p.id))!.root;
    writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 9' } }));
    await request(app).post(`/profiles/${p.id}/open`).send({}).expect(200);
    expect(folderArgs(launches[0]!.args)).toEqual(['--profile-directory=profile-001']);
    expect(existsSync(path.join(root, '.plyr-chromium-profile.json'))).toBe(false); // no pin written either
    cleanup();
  });

  it('a running profile is shown again, never launched twice', async () => {
    if (!up) return;
    const p = await newProfile('Twice');
    const o1 = await request(app).post(`/profiles/${p.id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    const o2 = await request(app).post(`/profiles/${p.id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    expect(o1.body.reused).toBe(false);
    expect(o2.body.reused).toBe(true);
    expect(o2.body.viewPath).toBe(`/desktop/chrome?profile=${p.id}`);
    expect(launches).toHaveLength(1);
    expect(sessions.list()).toHaveLength(1);
    cleanup();
  });

  it('a profile the registry cannot locate is refused before any hold or launch', async () => {
    if (!up) return;
    const p = await newProfile('Ghost');
    const orig = registry.locationOf.bind(registry);
    (registry as any).locationOf = async () => null;
    const r = await request(app).post(`/profiles/${p.id}/open`).send({}).expect(409);
    expect(r.body.code).toBe('needs_review');
    expect(launches).toHaveLength(0);
    expect(await leases.holdOf(leaseIdOf(p.id))).toBeNull();
    (registry as any).locationOf = orig;
    cleanup();
  });

  it('assertBranchLaunch refuses the profile folder as the data directory', () => {
    expect(() => assertBranchLaunch('/x/branch-001/profile-001', 'profile-001')).toThrow(/profile folder itself/);
    expect(() => assertBranchLaunch('/x/branch-001', '../evil')).toThrow(/Invalid profile folder/);
    expect(() => assertBranchLaunch('/x/branch-001', 'profile-001')).not.toThrow();
  });
});

describe('Turn off (POST /profiles/turn-off)', () => {
  it('closes the profile browsers nobody uses; keeps the one a workflow depends on and names it', async () => {
    if (!up) return;
    const wf = await new WorkflowService(workflowStoreFor(redis!)).create(USER, { name: 'Nightly import', steps: [{ action: 'goto', params: { url: 'https://example.com' } }] });
    const free = await newProfile('Free one');
    const busy = await newProfile('Busy one');
    await request(app).post(`/profiles/${free.id}/open`).send({ workflowId: 'wf_x' }).expect(200);
    await request(app).post(`/profiles/${busy.id}/open`).send({ workflowId: 'wf_x' }).expect(200);
    // A run of the workflow now depends on the busy profile's browser.
    const busyLease = leaseIdOf(busy.id);
    sessions.attach(busyLease, jobDependent('42'));
    await leases.releaseHold(busyLease, { owner: 'wf_x' });
    const acq = await leases.acquire(busyLease, '42', { owner: wf.id });
    expect(acq.ok).toBe(true);
    // A session this panel did not open (the RealChrome one) is left alone.
    sessions.opened('realchrome', { userId: USER, visibility: 'visible', createdBy: 'operator:local-browser' });

    const r = await request(app).post('/profiles/turn-off').send({}).expect(200);
    expect(r.body.closed.map((x: any) => x.name)).toEqual(['Free one']);
    expect(r.body.keptOpen).toEqual([{ profileId: busy.id, name: 'Busy one', reason: 'workflow', workflows: [{ workflowId: wf.id, name: 'Nightly import' }] }]);
    expect(r.body.notOpenedHere.map((x: any) => x.sessionId)).toEqual(['realchrome']);
    expect(r.body.failed).toEqual([]);
    expect(pm.getVipContext(leaseIdOf(free.id))).toBeFalsy();
    expect(pm.getVipContext(busyLease)).toBeTruthy();
    expect(sessions.get('realchrome')).not.toBeNull();
    cleanup();
  });

  it('with nothing open it answers with empty lists', async () => {
    if (!up) return;
    const r = await request(app).post('/profiles/turn-off').send({}).expect(200);
    expect(r.body).toMatchObject({ success: true, closed: [], keptOpen: [], failed: [] });
    cleanup();
  });
});
