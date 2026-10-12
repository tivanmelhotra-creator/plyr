/**
 * ProfileCoordinator with a REAL BullMQ queue + Redis (self-skips without Redis).
 *
 *   - only profiles a schedule really uses are reserved
 *   - a schedule of an INACTIVE workflow reserves nothing
 *   - activation / deactivation never touches holds or open browsers
 *   - boot recovery: dead incarnation's leases / holds / sessions; reservations kept
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { ProfileLeases, HOLD_PREFIX, RESV_PREFIX } from '../../src/core/ProfileLease';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { BrowserSessions, SESSION_PREFIX } from '../../src/core/BrowserSessions';
import { ProfileCoordinator } from '../../src/core/ProfileCoordinator';

let redis: IORedis | null = null;
let up = false;
let queue: Queue | null = null;
const QNAME = 'profile-coordinator-test';
let wfActive = true;

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
  for (const pre of ['profile:lease:', HOLD_PREFIX, RESV_PREFIX, SESSION_PREFIX]) {
    const keys = await redis!.keys(`${pre}*`);
    if (keys.length) await redis!.del(...keys);
  }
  wfActive = true;
});

function coordinator(localMode = false) {
  const leases = new ProfileLeases(redis!, 120);
  return new ProfileCoordinator(queue!, leases, new ProfileReservations(redis!), new BrowserSessions(redis!),
    async () => ({ profileId: 'shop', name: 'Shop flow', active: wfActive, steps: [{ action: 'goto' }] }),
    () => localMode);
}

async function schedule(id: string, cron: string, data: Record<string, unknown>) {
  await queue!.add('run', { userId: 'local', steps: [{ action: 'goto' }], __scheduled: true, __scheduleId: id, ...data }, { repeat: { pattern: cron, tz: 'UTC' }, jobId: id });
}

describe('schedules -> reservations', () => {
  it('a schedule bound to a workflow reserves THAT workflow\'s profile, owned by the workflow', async () => {
    if (!up) return;
    await schedule('sched:local:1:a', '*/30 * * * *', { __scheduleWorkflowId: 'wf_shop', __workflowId: 'wf_shop' });
    const c = coordinator();
    const b = await c.bindings();
    expect(b).toEqual([expect.objectContaining({ leaseId: 'named:shop', owner: 'wf_shop', ownerName: 'Shop flow' })]);
    const s = await c.syncReservations({ horizonMs: 3600_000 });
    expect(s.created).toBeGreaterThan(0);
    const list = await c.reservations.list('named:shop');
    expect(list.every((r) => r.owner === 'wf_shop' && r.state === 'planned')).toBe(true);
    // Nothing else is reserved.
    expect([...(await c.reservations.all()).keys()]).toEqual(['named:shop']);
  });

  it('an inactive workflow reserves nothing, and deactivating drops its planned windows', async () => {
    if (!up) return;
    await schedule('sched:local:2:b', '*/30 * * * *', { __scheduleWorkflowId: 'wf_shop', __workflowId: 'wf_shop' });
    const c = coordinator();
    await c.syncReservations({ horizonMs: 3600_000 });
    expect((await c.reservations.list('named:shop')).length).toBeGreaterThan(0);
    // An operator hold of the same workflow exists meanwhile.
    expect((await c.leases.hold('named:shop', 'wf_shop', 3600_000, 0)).ok).toBe(true);
    wfActive = false;
    const s = await c.syncReservations({ horizonMs: 3600_000 });
    expect(s.dropped).toBeGreaterThan(0);
    expect(await c.reservations.list('named:shop')).toEqual([]);
    // Deactivation did not touch the operator's hold.
    expect((await c.leases.holdOf('named:shop'))?.owner).toBe('wf_shop');
  });

  it("local-mode runs use the operator's own Chrome: never reserved", async () => {
    if (!up) return;
    await schedule('sched:local:3:c', '*/30 * * * *', { profileId: 'x' });
    expect(await coordinator(true).bindings()).toEqual([]);
  });
});

describe('boot recovery', () => {
  it('frees what a dead incarnation held, forgets its sessions, and keeps reservations', async () => {
    if (!up) return;
    await redis!.set('profile:lease:named:z', JSON.stringify({ profileId: 'named:z', jobId: 'j', token: 't', instance: 'dead', acquiredAt: 0 }), 'EX', 100);
    await redis!.set(HOLD_PREFIX + 'named:z', JSON.stringify({ profileId: 'named:z', owner: 'wf', token: 'h', instance: 'dead', acquiredAt: 0, expiresAt: Date.now() + 60_000 }), 'PX', 60_000);
    await redis!.set(SESSION_PREFIX + 'named:z', JSON.stringify({ leaseId: 'named:z', instance: 'dead', dependents: ['job:j'] }));
    const c = coordinator();
    await c.reservations.markFired('named:z', { scheduleId: 's', owner: 'wf' }, Date.now(), 'j', { beforeMs: 0, afterMs: 0 });
    const r = await c.recoverAtBoot();
    expect(r).toEqual({ leases: ['named:z'], holds: ['named:z'], sessions: ['named:z'] });
    // The reservation is evidence about time: it stays until the queue proves the run ended.
    expect((await c.reservations.list('named:z'))[0]!.state).toBe('fired');
    // The job is unknown to the queue -> the sweep settles it.
    await c.sweep(() => false, async () => {});
    expect((await c.reservations.list('named:z'))[0]!.state).toBe('settled');
  });
});
