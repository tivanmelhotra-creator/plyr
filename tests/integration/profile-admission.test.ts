/**
 * Profile admission against REAL Redis: lease, operator hold, reservations and
 * grants are decided by ONE atomic script. Self-skips without Redis.
 *
 *   concurrency: N simultaneous claimants -> exactly one wins
 *   reservations block runs AND manual opens of other workflows, with the reason
 *   the real end of a run is honoured (a 10:00 run that lasts to 10:20)
 *   sweep resolves reservations from evidence only
 *   recovery: holds of a dead incarnation are released; unknown owners block
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { ProfileLeases, INSTANCE_ID, HOLD_PREFIX, RESV_PREFIX, GRANT_PREFIX } from '../../src/core/ProfileLease';
import { ProfileReservations, type Reservation } from '../../src/core/ProfileReservations';

let redis: IORedis | null = null;
let up = false;
beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
});
afterAll(async () => { if (redis) redis.disconnect(); });

const P = 'named:adm_test';
const KEYS = [`profile:lease:${P}`, HOLD_PREFIX + P, RESV_PREFIX + P, GRANT_PREFIX + P];
beforeEach(async () => { if (up) await redis!.del(...KEYS); });

const MIN = 60_000;
const W = { beforeMs: 10 * MIN, afterMs: 10 * MIN };

/** A planned reservation, stored under its canonical id. */
async function putResv(r: Partial<Reservation> & { owner: string; start: number; end: number }): Promise<Reservation> {
  const occurrence = r.occurrence ?? r.start + 10 * MIN;
  const rec = { scheduleId: 's', state: 'planned', ...r, occurrence, id: ProfileReservations.idOf('s', occurrence) } as Reservation;
  await redis!.hset(RESV_PREFIX + P, rec.id, JSON.stringify(rec));
  return rec;
}

describe('one claim per profile, atomically', () => {
  it('50 simultaneous runs of different workflows: exactly one gets the profile', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => L.acquire(P, `job${i}`, { owner: `wf_${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'in_use')).toBe(true);
  });

  it('a run and the operator of another workflow racing: never both (20 rounds)', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    for (let round = 0; round < 20; round++) {
      await redis!.del(...KEYS);
      const [run, hold] = await Promise.all([L.acquire(P, 'jobX', { owner: 'wf_a' }), L.hold(P, 'wf_b', 10 * MIN)]);
      expect(Number(run.ok) + Number(hold.ok)).toBe(1);
    }
  });

  it("the workflow's own run is admitted under its operator hold; another workflow's is not", async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    expect((await L.hold(P, 'wf_a', 10 * MIN)).ok).toBe(true);
    const other = await L.acquire(P, 'j1', { owner: 'wf_b' });
    expect(!other.ok && other.reason).toBe('held');
    expect((await L.acquire(P, 'j2', { owner: 'wf_a' })).ok).toBe(true);
  });

  it('the same workflow may open its running profile; another workflow may not', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    expect((await L.acquire(P, 'j1', { owner: 'wf_a' })).ok).toBe(true);
    expect((await L.hold(P, 'wf_a', 10 * MIN)).ok).toBe(true);
    const b = await L.hold(P, 'wf_b', 10 * MIN);
    expect(!b.ok && b.reason).toBe('in_use');
  });

  it('a hold is released by its owner only, and that never touches the lease', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    await L.acquire(P, 'j1', { owner: 'wf_a' });
    await L.hold(P, 'wf_a', 10 * MIN);
    expect(await L.releaseHold(P, { owner: 'wf_b' })).toBe(false);
    expect(await L.releaseHold(P, { owner: 'wf_a' })).toBe(true);
    expect((await L.holder(P))?.jobId).toBe('j1');
  });

  it('a re-entering job keeps its token (retry / moved back from delayed)', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const a = await L.acquire(P, 'j1', { owner: 'wf_a' });
    const b = await L.acquire(P, 'j1', { owner: 'wf_a' });
    expect(a.ok && b.ok && a.token === b.token).toBe(true);
  });
});

describe('scheduled reservations', () => {
  it("another workflow's reservation blocks runs AND manual opens, naming the workflow", async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const now = Date.now();
    await putResv({ owner: 'wf_sched', ownerName: 'Nightly', start: now - MIN, end: now + 10 * MIN });
    const run = await L.acquire(P, 'j1', { owner: 'wf_other' });
    expect(!run.ok && run.reason).toBe('reserved');
    expect(!run.ok && run.reservation?.ownerName).toBe('Nightly');
    const hold = await L.hold(P, 'wf_other', 10 * MIN);
    expect(!hold.ok && hold.reason).toBe('reserved');
    expect((await L.acquire(P, 'j2', { owner: 'wf_sched' })).ok).toBe(true);
  });

  it('a manual hold ends at the start of the next foreign reservation', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const now = Date.now();
    await putResv({ owner: 'wf_sched', start: now + 20 * MIN, end: now + 40 * MIN });
    const h = await L.hold(P, 'wf_other', 60 * MIN);
    expect(h.ok && h.expiresAt! <= now + 20 * MIN + 1000).toBe(true);
    expect(await redis!.pttl(HOLD_PREFIX + P)).toBeLessThanOrEqual(20 * MIN + 1000);
  });

  it('a hold that would last under a minute before a reservation is refused (reserved_soon)', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    await putResv({ owner: 'wf_sched', start: Date.now() + 20_000, end: Date.now() + 20 * MIN });
    const h = await L.hold(P, 'wf_other', 60 * MIN);
    expect(!h.ok && h.reason).toBe('reserved_soon');
  });

  it('10:00 run lasting to 10:20 is not freed at 10:10 (fired blocks until settled)', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const R = new ProfileReservations(redis!);
    const now = Date.now();
    const occ = now - 15 * MIN; // window [occ-10, occ+10] ended 5 minutes ago
    await R.markFired(P, { scheduleId: 's', owner: 'wf_sched' }, occ, 'jobS', W);
    const blocked = await L.acquire(P, 'j1', { owner: 'wf_other' });
    expect(!blocked.ok && blocked.reason).toBe('reserved');
    expect(await R.markSettled(P, 's', occ, 'jobS', now - 1)).toBe(true);
    expect((await L.acquire(P, 'j1', { owner: 'wf_other' })).ok).toBe(true);
  });

  it('a run ending early still honours the margin after the scheduled time', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const R = new ProfileReservations(redis!);
    const now = Date.now();
    const occ = now - 2 * MIN; // window ends in 8 minutes
    await R.markFired(P, { scheduleId: 's', owner: 'wf_sched' }, occ, 'jobS', W);
    await R.markSettled(P, 's', occ, 'jobS', now);
    const r = await L.acquire(P, 'j1', { owner: 'wf_other' });
    expect(!r.ok && r.reason).toBe('reserved');
  });

  it('only the run that fired an occurrence may settle it', async () => {
    if (!up) return;
    const R = new ProfileReservations(redis!);
    const occ = Date.now();
    await R.markFired(P, { scheduleId: 's', owner: 'wf' }, occ, 'jobS', W);
    expect(await R.markSettled(P, 's', occ, 'someone-else')).toBe(false);
    expect(await R.markSettled(P, 's', occ, 'jobS')).toBe(true);
  });

  it('a missed occurrence stops blocking; a fired one cannot be marked missed', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const R = new ProfileReservations(redis!);
    const now = Date.now();
    const r = await putResv({ owner: 'wf_sched', start: now - MIN, end: now + MIN, occurrence: now });
    expect(await R.markMissed(P, 's', r.occurrence)).toBe(true);
    expect((await L.acquire(P, 'j1', { owner: 'wf_other' })).ok).toBe(true);
    await R.markFired(P, { scheduleId: 's', owner: 'wf_sched' }, now + 5 * MIN, 'jx', W);
    expect(await R.markMissed(P, 's', now + 5 * MIN)).toBe(false);
  });

  it('an EXPLICIT grant (never implicit) lets another workflow in during a reservation', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const now = Date.now();
    await putResv({ owner: 'wf_sched', start: now - MIN, end: now + 10 * MIN });
    expect((await L.acquire(P, 'j1', { owner: 'wf_next' })).ok).toBe(false);
    await L.grant(P, 'wf_sched', 'wf_next', 5 * MIN);
    expect((await L.acquire(P, 'j1', { owner: 'wf_next' })).ok).toBe(true);
    await L.release(P, (await L.holder(P))!.token);
    await L.revokeGrant(P, 'wf_sched', 'wf_next');
    expect((await L.acquire(P, 'j2', { owner: 'wf_next' })).ok).toBe(false);
  });

  it('sync plans 09:50-10:10 for a 10:00 schedule and reports overlaps between workflows', async () => {
    if (!up) return;
    const R = new ProfileReservations(redis!);
    const base = Date.UTC(2030, 0, 1, 9, 0, 0);
    const out = await R.sync([
      { scheduleId: 'sA', owner: 'wf_a', leaseId: P, cron: '0 10 * * *', tz: 'UTC' },
      { scheduleId: 'sB', owner: 'wf_b', leaseId: P, cron: '5 10 * * *', tz: 'UTC' },
    ], W, { now: base, horizonMs: 3 * 3600_000 });
    expect(out.created).toBe(2);
    const a = (await R.list(P)).find((r) => r.scheduleId === 'sA')!;
    expect(new Date(a.start).toISOString()).toBe('2030-01-01T09:50:00.000Z');
    expect(new Date(a.end).toISOString()).toBe('2030-01-01T10:10:00.000Z');
    expect(out.overlaps).toHaveLength(1);
    // Changing the margins re-plans the planned windows; nothing is duplicated.
    const again = await R.sync([{ scheduleId: 'sA', owner: 'wf_a', leaseId: P, cron: '0 10 * * *', tz: 'UTC' }],
      { beforeMs: 5 * MIN, afterMs: 15 * MIN }, { now: base, horizonMs: 3 * 3600_000 });
    expect(again.dropped).toBe(2);
    const list = await R.list(P);
    expect(list).toHaveLength(1);
    expect(new Date(list[0]!.start).toISOString()).toBe('2030-01-01T09:55:00.000Z');
  });

  it('sync never drops evidence of a run (fired / settled records)', async () => {
    if (!up) return;
    const R = new ProfileReservations(redis!);
    const occ = Date.now() + 30 * MIN;
    await R.markFired(P, { scheduleId: 'sGone', owner: 'wf' }, occ, 'j', W);
    await R.sync([], W);
    expect((await R.list(P))[0]?.state).toBe('fired');
  });
});

describe('sweep resolves from evidence, never by guessing', () => {
  const probe = (states: Record<string, string>, pending = false, here: string[] = []) => ({
    jobState: async (id: string) => ({ state: states[id] ?? 'missing', finishedOn: Date.now() - 1000 }),
    occurrencePending: async () => pending,
    runningHere: (id: string) => here.includes(id),
  });

  it('fired + job active elsewhere, or running here: stays blocking past its window', async () => {
    if (!up) return;
    const R = new ProfileReservations(redis!);
    const occ = Date.now() - 60 * MIN;
    await R.markFired(P, { scheduleId: 's', owner: 'wf' }, occ, 'j', W);
    await R.sweep(probe({ j: 'active' }));
    expect((await R.list(P))[0]!.state).toBe('fired');
    await R.sweep(probe({}, false, ['j']));
    expect((await R.list(P))[0]!.state).toBe('fired');
  });

  it('fired + job completed / failed / gone: settled', async () => {
    if (!up) return;
    const R = new ProfileReservations(redis!);
    const occ = Date.now() - 60 * MIN;
    await R.markFired(P, { scheduleId: 's', owner: 'wf' }, occ, 'j', W);
    expect((await R.sweep(probe({ j: 'failed' }))).settled).toBe(1);
    expect((await R.list(P))[0]!.state).toBe('settled');
  });

  it('planned and over: kept while a job is pending for it, missed when none is', async () => {
    if (!up) return;
    const R = new ProfileReservations(redis!);
    const now = Date.now();
    await putResv({ owner: 'wf', start: now - 60 * MIN, end: now - 30 * MIN });
    await R.sweep(probe({}, true));
    expect((await R.list(P))[0]!.state).toBe('planned');
    await R.sweep(probe({}, false));
    expect((await R.list(P))[0]!.state).toBe('missed');
  });
});

describe('recovery', () => {
  it('holds of an earlier incarnation are released at boot; current ones are kept', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    await redis!.set(HOLD_PREFIX + P, JSON.stringify({ profileId: P, owner: 'wf', token: 't', instance: 'dead', acquiredAt: 0, expiresAt: Date.now() + MIN }), 'PX', MIN);
    expect(await L.releaseOrphanedHolds()).toEqual([P]);
    await L.hold(P, 'wf', 5 * MIN);
    expect(await L.releaseOrphanedHolds()).toEqual([]);
    expect((await L.holdOf(P))?.instance).toBe(INSTANCE_ID);
  });

  it('a lease without an owner (written before owners existed) is compatible with nobody', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    await redis!.set(`profile:lease:${P}`, JSON.stringify({ profileId: P, jobId: 'old', token: 't', instance: INSTANCE_ID, acquiredAt: 0 }), 'EX', 60);
    const h = await L.hold(P, 'wf_a', 5 * MIN);
    expect(!h.ok && h.reason).toBe('in_use');
  });
});
