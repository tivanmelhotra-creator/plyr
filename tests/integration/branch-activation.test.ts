/**
 * Section 9 (owner's brief) with the REAL user routes and a real Redis:
 *
 *   - enabling a workflow whose profile folder is missing is refused, the
 *     profile and the reason are named, a failure report is recorded
 *   - a profile record that does not exist is refused (profile_missing)
 *   - saving a schedule for a workflow with a missing profile is refused
 *   - an overlap with another workflow's schedule on the SAME branch is shown
 *     BEFORE saving (409 schedule_overlap, behaviour "wait"); acceptOverlap saves
 *   - a healthy profile activates
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
const USER = `act${Date.now() % 100000}`;
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
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-act-'));
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

describe('activation and schedules check the browser profile (section 9)', () => {
  it('a healthy profile activates', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Good');
    const id = await workflowWith(p.id);
    const r = await activate(id);
    expect(r.status).toBe(200);
    expect(r.body.workflow.active).toBe(true);
  });

  it('a missing profile FOLDER refuses activation, names it, records profile_broken', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Gone');
    rmSync(path.join(registry.dirOf(USER, p.id), p.folder), { recursive: true, force: true }); // removed outside Aria
    const id = await workflowWith(p.id);
    const r = await activate(id);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('profile_missing');
    expect(r.body.action).toBe('assign_profile');
    expect(r.body.profiles[0]).toMatchObject({ profileId: p.id, profileName: 'Gone', detail: 'folder_missing', reason: 'profile_broken' });
    const reports = await profileFailureReports().list(USER);
    expect(reports[0]).toMatchObject({ reason: 'profile_broken', detail: 'folder_missing', stage: 'activation', workflowId: id, profileId: p.id });
  });

  it('a missing BRANCH folder is branch_missing; an unknown profile record is profile_missing', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'NoBranch');
    rmSync(registry.dirOf(USER, p.id), { recursive: true, force: true });
    const r1 = await activate(await workflowWith(p.id));
    expect(r1.body.profiles[0]).toMatchObject({ detail: 'branch_missing', reason: 'profile_broken' });
    const r2 = await activate(await workflowWith('prf_doesnotexist'));
    expect(r2.status).toBe(422);
    expect(r2.body.profiles[0]).toMatchObject({ detail: 'record_missing', reason: 'profile_missing' });
  });

  it('saving a schedule for a workflow with a missing profile is refused', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Sched');
    const id = await workflowWith(p.id);
    expect((await activate(id)).status).toBe(200);
    rmSync(path.join(registry.dirOf(USER, p.id), p.folder), { recursive: true, force: true });
    const before = added.length;
    const r = await request(app).post('/schedule').send({ userId: USER, cron: '0 3 * * *', workflowId: id });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('profile_missing');
    expect(added.length).toBe(before); // nothing was queued
    expect((await profileFailureReports().list(USER))[0]).toMatchObject({ stage: 'schedule', profileId: p.id });
  });

  it('an overlap with another workflow on the SAME branch is shown before saving; acceptOverlap saves it', async () => {
    if (!up) return;
    const p = await registry.create(USER, 'Shared');
    const id = await workflowWith(p.id);
    expect((await activate(id)).status).toBe(200);
    conflicts = [{ mine: { start: Date.UTC(2026, 9, 15, 2, 50), end: Date.UTC(2026, 9, 15, 3, 10) }, other: { owner: 'wf_other1', ownerName: 'Nightly B', start: Date.UTC(2026, 9, 15, 2, 55), end: Date.UTC(2026, 9, 15, 3, 15) } }];
    const before = added.length;
    const r = await request(app).post('/schedule').send({ userId: USER, cron: '0 3 * * *', workflowId: id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('schedule_overlap');
    expect(r.body.behaviour).toBe('wait');
    expect(r.body.error).toMatch(/Nightly B/);
    expect(r.body.error).toMatch(/WAIT/);
    expect(lastConflictQuery).toMatchObject({ owner: id, leaseId: leaseIdOf(p.id), cron: '0 3 * * *' });
    expect(added.length).toBe(before);
    const ok = await request(app).post('/schedule').send({ userId: USER, cron: '0 3 * * *', workflowId: id, acceptOverlap: true });
    expect(ok.status).toBe(200);
    expect(added.length).toBe(before + 1);
  });
});
