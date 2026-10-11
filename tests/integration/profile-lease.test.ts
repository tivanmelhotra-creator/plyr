import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { ProfileLeases, resolveRunProfile, needsLease } from '../../src/core/ProfileLease';

// A browser profile is used by ONE run at a time (real Redis; self-skips without it).
let redis: IORedis | null = null;
let up = false;
beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
});
afterAll(async () => { if (redis) redis.disconnect(); });
const KEYS = ['default', 'named:a', 'named:z'].map((k) => `profile:lease:${k}`);
beforeEach(async () => { if (up) await redis!.del(...KEYS); });

describe('ProfileLeases (exclusive per profile)', () => {
  it('a busy profile refuses a second run, a different profile does not', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const a = await L.acquire('default', 'job1');
    expect(a.ok).toBe(true);
    const b = await L.acquire('default', 'job2');
    expect(b.ok).toBe(false);
    expect(!b.ok && b.holder?.jobId).toBe('job1');
    expect((await L.acquire('named:a', 'job3')).ok).toBe(true);
  });

  it('only the holder can release (a stale or foreign token frees nothing)', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const a = await L.acquire('default', 'job1');
    expect(await L.release('default', 'not-the-token')).toBe(false);
    expect(await L.release('default', null)).toBe(false);
    expect((await L.holder('default'))?.jobId).toBe('job1');
    expect(await L.release('default', a.ok ? a.token : '')).toBe(true);
    expect((await L.acquire('default', 'job2')).ok).toBe(true);
  });

  it('the same job re-entering its own lease is not a conflict', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    const a = await L.acquire('default', 'job1');
    const again = await L.acquire('default', 'job1');
    expect(again.ok).toBe(true);
    expect(again.ok && a.ok && again.token).toBe(a.ok ? a.token : '');
  });

  it('boot recovery frees leases of an earlier server incarnation only', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 120);
    await L.acquire('named:a', 'mine');
    await redis!.set('profile:lease:named:z', JSON.stringify({ profileId: 'named:z', jobId: 'x', token: 't', instance: 'old-process', acquiredAt: 0 }), 'EX', 100);
    const freed = await L.releaseOrphaned();
    expect(freed).toEqual(['named:z']);
    expect((await L.holder('named:a'))?.jobId).toBe('mine');
  });

  it('a lease cannot outlive a lost holder (TTL = the run ceiling)', async () => {
    if (!up) return;
    const L = new ProfileLeases(redis!, 90);
    await L.acquire('default', 'job1');
    const ttl = await redis!.ttl('profile:lease:default');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });
});

describe('resolveRunProfile', () => {
  const base = { userId: 'local', profilesDir: '/p', realChromeDir: '/rc', localMode: false, usesExtensions: false };
  it('extensions -> Real Chrome profile; named -> its own; otherwise default', () => {
    expect(resolveRunProfile({ ...base, usesExtensions: true }).id).toBe('realchrome');
    expect(resolveRunProfile({ ...base, profileId: 'shop' }).id).toBe('named:shop');
    expect(resolveRunProfile({ ...base }).id).toBe('default');
    expect(resolveRunProfile({ ...base, profileId: '../evil' }).id).toBe('default');
  });
  it("the operator's own local Chrome is never leased", () => {
    expect(needsLease(resolveRunProfile({ ...base, localMode: true }))).toBe(false);
  });
});
