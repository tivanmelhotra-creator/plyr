/**
 * /profiles over HTTP, with real Redis and a fake browser launcher (no
 * Chromium needed). Self-skips without Redis.
 *
 * Acceptance criteria covered:
 *   1  create / list / rename / delete from the workspace API
 *   2  create, then open (the UI chains them); a failed open keeps the profile
 *      and can be retried
 *   5  a reservation of another workflow refuses the manual open, with a reason
 *   7  close browser and release hold are independent
 *   8  the browser cannot be closed while a run depends on it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
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

let redis: IORedis | null = null;
let up = false;
let dir = '';
let app: express.Express;
let sessions: BrowserSessions;
let pm: ProfileManager;
let launches = 0;
let failLaunch = '';

class FakeContext {
  closed = false;
  private handlers: Array<() => void> = [];
  private _pages: unknown[] = [{}];
  pages() { if (this.closed) throw new Error('closed'); return this._pages; }
  async newPage() { return {}; }
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
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-pr-'));
  launches = 0; failLaunch = '';
  setProfileLauncherForTests(async () => {
    launches++;
    if (failLaunch) throw new Error(failLaunch);
    return new FakeContext() as any;
  });
  sessions = new BrowserSessions(redis!);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  const access = new ProfileAccess(new ProfileRegistry(dir), new ProfileLeases(redis!, 120), new ProfileReservations(redis!), sessions);
  app = express();
  app.use(express.json());
  app.use(createProfileRoutes({ connection: redis!, access, profileManager: pm }));
});

const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } };

describe('/profiles', () => {
  it('lists the default profile with its status and the reservation settings', async () => {
    if (!up) return;
    const r = await request(app).get('/profiles').expect(200);
    expect(r.body.profiles.map((p: any) => p.id)).toEqual(['default']);
    expect(r.body.profiles[0].status).toBe('free');
    expect(r.body.settings).toMatchObject({ reserveBeforeMin: expect.any(Number), reserveAfterMin: expect.any(Number) });
    cleanup();
  });

  it('create -> open (as the UI chains it) -> rename keeps the id -> delete refused while open', async () => {
    if (!up) return;
    const c = await request(app).post('/profiles').send({ name: 'Shop' }).expect(201);
    const id = c.body.profile.id;
    expect(launches).toBe(0); // creating never opens
    const o = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    expect(o.body.viewPath).toBe(`/desktop/chrome?profile=${id}`);
    expect(launches).toBe(1);
    // A second press reuses the running browser: no duplicate session.
    const o2 = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    expect(o2.body.reused).toBe(true);
    expect(launches).toBe(1);
    const rn = await request(app).patch(`/profiles/${id}`).send({ name: 'Shop 2' }).expect(200);
    expect(rn.body.profile.id).toBe(id);
    expect(rn.body.profile.name).toBe('Shop 2');
    const del = await request(app).delete(`/profiles/${id}`).expect(409);
    expect(del.body.blockers.map((b: any) => b.kind)).toEqual(expect.arrayContaining(['hold', 'browser']));
    cleanup();
  });

  it('concurrent opens of one profile start ONE browser', async () => {
    if (!up) return;
    const id = (await request(app).post('/profiles').send({ name: 'Par' })).body.profile.id;
    await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' })));
    expect(launches).toBe(1);
    cleanup();
  });

  it('a failed open keeps the profile, records the reason, gives the hold back, and can be retried', async () => {
    if (!up) return;
    const id = (await request(app).post('/profiles').send({ name: 'Flaky' })).body.profile.id;
    failLaunch = 'Missing X server';
    const f = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' }).expect(503);
    expect(f.body.retryable).toBe(true);
    const list = (await request(app).get('/profiles?workflowId=wf_a')).body.profiles;
    const p = list.find((x: any) => x.id === id);
    expect(p).toBeTruthy();
    expect(p.status).toBe('needs_review');
    expect(p.lastOpenError.message).toContain('Missing X server');
    expect(await redis!.get(HOLD_PREFIX + leaseIdOf(id))).toBeNull();
    failLaunch = '';
    await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    const after = (await request(app).get('/profiles?workflowId=wf_a')).body.profiles.find((x: any) => x.id === id);
    expect(after.lastOpenError).toBeNull();
    cleanup();
  });

  it("another workflow cannot open a profile this workflow holds; it is told why", async () => {
    if (!up) return;
    const id = (await request(app).post('/profiles').send({ name: 'Mine' })).body.profile.id;
    await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    const b = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_b' }).expect(409);
    expect(b.body.code).toBe('held');
    const view = (await request(app).get('/profiles?workflowId=wf_b')).body.profiles.find((x: any) => x.id === id);
    expect(view.available).toBe(false);
    expect(view.explanation).toMatch(/Opened by hand/);
    cleanup();
  });

  it("a reservation of another workflow refuses the manual open, naming it and its window", async () => {
    if (!up) return;
    const id = (await request(app).post('/profiles').send({ name: 'Sched' })).body.profile.id;
    const now = Date.now();
    await redis!.hset(RESV_PREFIX + leaseIdOf(id), 'x', JSON.stringify({ id: 'x', owner: 'wf_s', ownerName: 'Nightly', scheduleId: 's', occurrence: now, start: now - 60_000, end: now + 600_000, state: 'planned' }));
    const r = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_b' }).expect(409);
    expect(r.body.code).toBe('reserved');
    expect(r.body.error).toContain('Nightly');
    expect(launches).toBe(0);
    // The reserving workflow itself may open it.
    await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_s' }).expect(200);
    cleanup();
  });

  it('close and release are independent; a browser a run depends on cannot be closed', async () => {
    if (!up) return;
    const id = (await request(app).post('/profiles').send({ name: 'Life' })).body.profile.id;
    await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_a' }).expect(200);
    // A run of the same workflow now also depends on this browser.
    sessions.attach(leaseIdOf(id), jobDependent('run1'));
    const c1 = await request(app).post(`/profiles/${id}/close`).send({ workflowId: 'wf_a' }).expect(409);
    expect(c1.body.code).toBe('in_use');
    sessions.detach(leaseIdOf(id), jobDependent('run1'));
    const c2 = await request(app).post(`/profiles/${id}/close`).send({ workflowId: 'wf_a' }).expect(200);
    expect(c2.body.closed).toBe(true);
    expect(c2.body.holdKept).toBe(true); // closing did NOT release the claim
    expect(await redis!.get(HOLD_PREFIX + leaseIdOf(id))).not.toBeNull();
    const rel = await request(app).post(`/profiles/${id}/release`).send({ workflowId: 'wf_a' }).expect(200);
    expect(rel.body.released).toBe(true);
    // Now nothing depends on it: it can be deleted.
    await request(app).delete(`/profiles/${id}`).expect(200);
    cleanup();
  });

  it('rejects bad names and unknown ids', async () => {
    if (!up) return;
    await request(app).post('/profiles').send({ name: '' }).expect(400);
    await request(app).post('/profiles').send({ name: 'Dup' }).expect(201);
    await request(app).post('/profiles').send({ name: 'dup' }).expect(409);
    await request(app).patch('/profiles/nope').send({ name: 'x' }).expect(404);
    await request(app).delete('/profiles/default').expect(409);
    cleanup();
  });
});
