/**
 * Schedule-level facts of the profile infrastructure, with a REAL BullMQ queue
 * and Redis (self-skips without Redis).
 *
 *   - overlapping schedules of two workflows on one profile are reported by
 *     GET /profiles on THAT profile (not only logged at boot)
 *   - a schedule whose data no queued job carries (legacy / lost template) is
 *     reported as "unknown", never silently treated as reserving nothing
 *   - BullMQ 5 repeatables carry no `id`: our schedule ids are recovered from
 *     the next job (scheduleIdsByKey), so /schedules lists them again
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileLeases, HOLD_PREFIX, RESV_PREFIX } from '../../src/core/ProfileLease';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { BrowserSessions, SESSION_PREFIX, registerBrowserSessions } from '../../src/core/BrowserSessions';
import { ProfileAccess } from '../../src/core/ProfileAccess';
import { ProfileManager } from '../../src/core/ProfileManager';
import { ProfileCoordinator, scheduleIdsByKey, scheduleNameOf } from '../../src/core/ProfileCoordinator';
import { createProfileRoutes, describeOverlap } from '../../src/Routes/profile.routes';

let redis: IORedis | null = null;
let up = false;
let queue: Queue | null = null;
const QNAME = 'profile-schedules-test';
let dir = '';

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: null });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
  if (up) queue = new Queue(QNAME, { connection: redis });
});
afterAll(async () => {
  if (queue) { await queue.obliterate({ force: true }).catch(() => {}); await queue.close(); }
  if (redis) redis.disconnect();
});
beforeEach(async () => {
  if (!up) return;
  await queue!.obliterate({ force: true }).catch(() => {});
  for (const pre of ['profile:lease:', HOLD_PREFIX, RESV_PREFIX, SESSION_PREFIX, 'profile:grant:']) {
    const keys = await redis!.keys(`${pre}*`);
    if (keys.length) await redis!.del(...keys);
  }
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-ps-'));
});

const WF: Record<string, { name: string; profileId: string }> = {
  wf_a: { name: 'Morning A', profileId: 'shop' },
  wf_b: { name: 'Morning B', profileId: 'shop' },
};

function setup() {
  const leases = new ProfileLeases(redis!, 120);
  const reservations = new ProfileReservations(redis!);
  const sessions = new BrowserSessions(redis!);
  registerBrowserSessions(sessions);
  const coord = new ProfileCoordinator(queue!, leases, reservations, sessions,
    async (_u, id) => (WF[id] ? { ...WF[id], active: true, steps: [{ action: 'goto' }] } : null),
    () => false);
  const access = new ProfileAccess(new ProfileRegistry(dir), leases, reservations, sessions);
  const app = express();
  app.use(express.json());
  app.use(createProfileRoutes({ connection: redis!, access, profileManager: new ProfileManager(), schedules: coord }));
  return { coord, app, access };
}

async function schedule(id: string, cron: string, wf: string) {
  await queue!.add('run', { userId: 'local', steps: [{ action: 'goto' }], __scheduled: true, __scheduleId: id, __scheduleWorkflowId: wf, __workflowId: wf },
    { repeat: { pattern: cron, tz: 'UTC' }, jobId: id });
}

describe('overlapping schedules are shown on the profile', () => {
  it('two workflows reserving one profile at the same time -> an overlap on that profile in GET /profiles', async () => {
    if (!up) return;
    await schedule('sched:local:1:a', '0 * * * *', 'wf_a');
    await schedule('sched:local:2:b', '5 * * * *', 'wf_b');
    const { coord, app, access } = setup();
    await access.registry.ensure('local', 'shop');
    const s = await coord.syncReservations({ horizonMs: 3 * 3600_000 });
    expect(s.overlaps.length).toBeGreaterThan(0);
    const views = await coord.overlaps();
    expect(views[0]).toMatchObject({ leaseId: 'named:shop' });

    const r = await request(app).get('/profiles').expect(200);
    const shop = r.body.profiles.find((p: any) => p.id === 'shop');
    expect(shop).toBeTruthy();
    // One entry per PAIR of schedules, not one per occurrence.
    expect(r.body.overlaps.length).toBe(1);
    expect(shop.overlaps.length).toBe(1);
    expect(shop.overlaps[0].message).toMatch(/Schedules overlap: "Morning A" .* and "Morning B"/);
    // Nothing else is flagged.
    expect(r.body.profiles.find((p: any) => p.id === 'default').overlaps).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('schedules of ONE workflow never overlap with themselves', async () => {
    if (!up) return;
    await schedule('sched:local:1:a', '0 * * * *', 'wf_a');
    await schedule('sched:local:3:a2', '5 * * * *', 'wf_a');
    const { coord, app } = setup();
    await coord.syncReservations({ horizonMs: 3 * 3600_000 });
    expect(await coord.overlaps()).toEqual([]);
    const r = await request(app).get('/profiles').expect(200);
    expect(r.body.overlaps).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('describeOverlap names both workflows and both windows, nothing else', () => {
    const msg = describeOverlap({ leaseId: 'named:x', a: { owner: 'wf_a', start: 0, end: 600_000 }, b: { owner: 'wf_b', ownerName: 'B', start: 300_000, end: 900_000 } },
      (o) => (o === 'wf_a' ? 'A' : undefined));
    expect(msg).toBe('Schedules overlap: "A" (00:00 UTC–00:10 UTC) and "B" (00:05 UTC–00:15 UTC) reserve this profile at the same time; the later run waits until the earlier one releases it.');
    expect(msg).not.toMatch(/named:|\//);
  });
});

describe('schedules whose profile cannot be known', () => {
  it('a repeat with no job carrying its data is reported as unknown (not silently skipped)', async () => {
    if (!up) return;
    await schedule('sched:local:9:legacy', '0 3 * * *', 'wf_a');
    // Simulate the legacy / lost template: the delayed job is gone, the repeat stays.
    // (BullMQ refuses job.remove() for a scheduler's job, so the keys are dropped directly.)
    for (const j of await queue!.getJobs(['delayed'])) {
      await redis!.zrem(`bull:${QNAME}:delayed`, j.id!);
      await redis!.del(`bull:${QNAME}:${j.id}`);
    }
    const { coord, app } = setup();
    expect(await coord.bindings()).toEqual([]);
    const u = await coord.unresolvedSchedules();
    expect(u).toEqual([expect.objectContaining({ cron: '0 3 * * *', reason: 'no_template' })]);
    const r = await request(app).get('/profiles').expect(200);
    expect(r.body.unknownSchedules.length).toBe(1);
    expect(r.body.unknownSchedules[0].message).toMatch(/unknown until its next run is queued/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a normal schedule is NOT reported as unknown', async () => {
    if (!up) return;
    await schedule('sched:local:10:ok', '0 3 * * *', 'wf_a');
    const { coord } = setup();
    expect(await coord.unresolvedSchedules()).toEqual([]);
    expect((await coord.bindings()).length).toBe(1);
  });
});

describe('our schedule ids, recovered from BullMQ 5', () => {
  it('scheduleIdsByKey maps every repeatable key to the sched:<user>:… id of its next job', async () => {
    if (!up) return;
    await schedule('sched:local:11:x', '*/10 * * * *', 'wf_a');
    const reps = await queue!.getRepeatableJobs();
    expect((reps[0] as any).id).toBeUndefined(); // the BullMQ 5 behaviour this works around
    const ids = await scheduleIdsByKey(queue!, reps as any);
    expect(ids.get(reps[0]!.key)).toBe('sched:local:11:x');
    expect(scheduleNameOf('sched:local:11:x')).toBe('x');
    expect(scheduleNameOf('other')).toBeNull();
  });
});

describe('GET /schedules and DELETE /schedule with a real BullMQ 5 queue', () => {
  it('lists our schedules again, marks an unknown one, and deletes it (no 403)', async () => {
    if (!up) return;
    const { createUserRoutes } = await import('../../src/Routes/user.routes');
    await schedule('sched:local:20:good', '0 4 * * *', 'wf_a');
    await schedule('sched:local:21:lost', '0 5 * * *', 'wf_a');
    // Lose the template of the second one.
    const lost = (await queue!.getJobs(['delayed'])).find((j) => j.data.__scheduleId === 'sched:local:21:lost')!;
    await redis!.zrem(`bull:${QNAME}:delayed`, lost.id!);
    await redis!.del(`bull:${QNAME}:${lost.id}`);
    const { coord } = setup();
    const app = express();
    app.use(express.json());
    app.use(createUserRoutes({ queue: queue!, connection: redis!, profileManager: new ProfileManager(), profileCoordinator: coord }));
    const r = await request(app).get('/schedules/local').expect(200);
    expect(r.body.count).toBe(2);
    const good = r.body.schedules.find((s: any) => s.name === 'good');
    expect(good).toMatchObject({ scheduleId: 'sched:local:20:good', reservation: 'planned' });
    const unknown = r.body.schedules.find((s: any) => s.reservation === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.reservationNote).toMatch(/unknown/);
    // The unknown one can still be deleted (single-user attribution).
    await request(app).delete(`/schedule/local/${encodeURIComponent(unknown.key)}`).expect(200);
    await request(app).delete(`/schedule/local/${encodeURIComponent(good.key)}`).expect(200);
    expect(await queue!.getRepeatableJobs()).toEqual([]);
  });
});
