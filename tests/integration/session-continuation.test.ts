/**
 * Continue Session (phase 2) with REAL Redis — only through
 * ProfileLeases.grant + BrowserSessions (self-skips without Redis).
 *
 *   - only the run that holds the lease (its token) can grant; a stale token,
 *     another job or a missing browser is refused with a reason
 *   - the grant lets the TARGET workflow through the source's hold /
 *     reservation (atomic admission), and nobody else
 *   - the browser is kept (grant dependent) until the target ran; then the
 *     grant is consumed and the browser is closable again
 *   - an expired grant gives no access and its dependent is swept
 *   - nothing implicit: without the node, the target is refused
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { ProfileLeases, HOLD_PREFIX, RESV_PREFIX, GRANT_PREFIX } from '../../src/core/ProfileLease';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { BrowserSessions, jobDependent } from '../../src/core/BrowserSessions';
import { continueSession, endContinuation, sweepExpiredGrants, grantDependent, clampTtl, MIN_TTL_MS, MAX_TTL_MS } from '../../src/core/SessionContinuation';
import { isValidWorkflowId } from '../../src/utils/redis-keys';

let redis: IORedis | null = null;
let up = false;
const P = 'named:cont_test';
beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
});
afterAll(async () => { if (redis) redis.disconnect(); });
beforeEach(async () => {
  if (!up) return;
  await redis!.del(`profile:lease:${P}`, HOLD_PREFIX + P, RESV_PREFIX + P, GRANT_PREFIX + P);
});

const A = 'wf_source01';
const B = 'wf_target01';
const C = 'wf_other001';

function setup() {
  const leases = new ProfileLeases(redis!, 120);
  const sessions = new BrowserSessions(null);
  const deps = { leases, sessions, workflowExists: async (_u: string, id: string) => id === B || id === C, isValidWorkflowId };
  return { leases, sessions, deps };
}

async function runOfA(leases: ProfileLeases, sessions: BrowserSessions, jobId = 'jobA') {
  const got = await leases.acquire(P, jobId, { owner: A });
  if (!got.ok) throw new Error('lease');
  sessions.opened(P, { userId: 'u', visibility: 'hidden', createdBy: jobDependent(jobId) });
  sessions.attach(P, jobDependent(jobId));
  return got.token;
}

describe('Continue Session', () => {
  it('only the lease holder can grant; reasons for every refusal', async () => {
    if (!up) return;
    const { leases, sessions, deps } = setup();
    const token = await runOfA(leases, sessions);
    const base = { userId: 'u', leaseId: P, leaseToken: token, jobId: 'jobA', fromOwner: A, toWorkflowId: B, ttlMs: 60_000 };
    expect(await continueSession(deps, { ...base, leaseToken: 'stolen' })).toMatchObject({ ok: false, reason: 'no_lease' });
    expect(await continueSession(deps, { ...base, jobId: 'jobX' })).toMatchObject({ ok: false, reason: 'no_lease' });
    expect(await continueSession(deps, { ...base, toWorkflowId: A })).toMatchObject({ ok: false, reason: 'same_workflow' });
    expect(await continueSession(deps, { ...base, toWorkflowId: 'wf_nope0001' })).toMatchObject({ ok: false, reason: 'unknown_workflow' });
    expect(await continueSession(deps, { ...base, toWorkflowId: '../x' })).toMatchObject({ ok: false, reason: 'invalid_target' });
    expect(await continueSession(deps, { ...base, leaseId: null, leaseToken: null })).toMatchObject({ ok: false, reason: 'not_profile' });
    const ok = await continueSession(deps, base);
    expect(ok).toMatchObject({ ok: true, to: B });
    expect(sessions.get(P)!.dependents).toContain(grantDependent(B));
  });

  it('the grant lets the TARGET through the source\'s hold and reservation — and only the target', async () => {
    if (!up) return;
    const { leases, sessions, deps } = setup();
    const token = await runOfA(leases, sessions);
    // Workflow A also reserves the profile for a scheduled run, and holds it.
    const now = Date.now();
    await new ProfileReservations(redis!).markFired(P, { scheduleId: 's1', owner: A }, now, 'jobA', { beforeMs: 60_000, afterMs: 60_000 });
    // Without the node: B is refused (nothing implicit).
    expect((await leases.check(P, B)).ok).toBe(false);
    await continueSession(deps, { userId: 'u', leaseId: P, leaseToken: token, jobId: 'jobA', fromOwner: A, toWorkflowId: B, ttlMs: 120_000 });
    // A's run ends: its lease goes, the reservation (owned by A) and the grant stay.
    await leases.release(P, token);
    sessions.detach(P, jobDependent('jobA'));
    expect((await leases.check(P, B)).ok).toBe(true);
    expect((await leases.check(P, C)).ok).toBe(false);
    const b = await leases.acquire(P, 'jobB', { owner: B });
    expect(b.ok).toBe(true);
    // The browser was kept for B (grant dependent) — not idle, not closable by A's after-run.
    expect(sessions.canClose(P, jobDependent('jobA')).ok).toBe(false);
    // B's run ends: the grant is consumed; the browser is closable again.
    expect(await endContinuation(deps, P, B)).toBe(1);
    expect(await leases.grants(P)).toEqual([]);
    expect(sessions.canClose(P, '').ok).toBe(true);
    if (b.ok) await leases.release(P, b.token);
    expect((await leases.check(P, B)).ok).toBe(false); // consumed: no second free pass
  });

  it('an expired grant gives no access, and its dependent is swept', async () => {
    if (!up) return;
    const { leases, sessions, deps } = setup();
    const token = await runOfA(leases, sessions);
    await continueSession(deps, { userId: 'u', leaseId: P, leaseToken: token, jobId: 'jobA', fromOwner: A, toWorkflowId: B, ttlMs: 60_000 });
    // Expire it by hand.
    await redis!.hset(GRANT_PREFIX + P, `${A}>${B}`, String(Date.now() - 1));
    expect(await sweepExpiredGrants(deps)).toBe(1);
    expect(sessions.get(P)!.dependents).not.toContain(grantDependent(B));
  });

  it('ttl is clamped', () => {
    expect(clampTtl(1)).toBe(MIN_TTL_MS);
    expect(clampTtl(10 * MAX_TTL_MS)).toBe(MAX_TTL_MS);
    expect(clampTtl('x')).toBeGreaterThanOrEqual(MIN_TTL_MS);
  });
});
