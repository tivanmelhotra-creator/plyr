/**
 * ProfileLease — a browser profile is used by ONE run at a time.
 *
 * A Chromium profile is an exclusive resource, like an employee who can work
 * one task at a time: two runs in the same user-data-dir would share cookies,
 * tabs and extension state, and Chromium itself refuses a second process on a
 * locked profile. So instead of a global "concurrent runs" number, every run
 * names the profile it needs and takes a LEASE on it:
 *
 *   - free profile      -> the run takes it and starts immediately;
 *   - profile in use    -> the run waits in the queue (the worker moves the job
 *                          back to BullMQ's delayed set and retries; it does
 *                          not occupy a worker slot while waiting);
 *   - different free profiles run independently, in parallel.
 *
 * Release happens on EVERY exit path of the worker (success, failure, cancel)
 * from its `finally` block. Release is compare-and-delete on a per-lease
 * token, so a run can never free a lease another run holds.
 *
 * CRASH RECOVERY. A lease records the PID-less `instance` id of the process
 * that took it. At boot, `releaseOrphaned()` drops every lease taken by an
 * earlier incarnation of this server (they cannot still be running: the
 * browser died with the process). While running, a lease also carries a TTL
 * equal to the hard run ceiling (MAX_JOB_DURATION_MINUTES), refreshed by the
 * holder, so a lease survives a long run but cannot outlive a lost holder.
 * That TTL is the existing run ceiling, not a new queue policy.
 *
 * NOT DECIDED HERE (deliberately — see the final report): how long a run may
 * wait for a busy profile, whether waiting runs are reordered, and whether a
 * waiting run expires. Today a waiting run waits until the profile is free,
 * in arrival order as BullMQ's delayed set provides.
 */
import { randomUUID } from 'crypto';
import path from 'path';
import type IORedis from 'ioredis';

/** One process incarnation; leases from any other incarnation are orphans. */
export const INSTANCE_ID = randomUUID();

const KEY_PREFIX = 'profile:lease:';

/** The profile a run needs. */
export interface ProfileRef {
  /** Stable id, used as the lock name. */
  id: string;
  /** Human label for logs / the Workspace. */
  label: string;
  /** The Chromium user-data-dir, when the run owns one (not for Real Chrome). */
  userDataDir?: string;
  kind: 'realchrome' | 'run' | 'named' | 'local' | 'ephemeral';
}

export interface LeaseRecord {
  profileId: string;
  jobId: string;
  token: string;
  instance: string;
  acquiredAt: number;
}

/** Profile ids are path segments and lock names: keep them boring. */
export function sanitizeProfileId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) return null;
  return v;
}

/**
 * Which profile a run needs. Pure: the pipeline decides the browser tier, this
 * names the resource that tier will lock.
 *
 *   uses extensions          -> Real Chrome's profile (one browser, one profile)
 *   local mode               -> the operator's own Chrome (not ours to lock;
 *                               reported as `local`, never leased)
 *   workflow names a profile -> that named profile
 *   otherwise                -> the instance's default run profile
 */
export function resolveRunProfile(input: {
  userId: string;
  profileId?: string | null;
  usesExtensions: boolean;
  localMode: boolean;
  profilesDir: string;
  realChromeDir: string;
}): ProfileRef {
  if (input.localMode) return { id: 'local', label: 'Your local Chrome', kind: 'local' };
  if (input.usesExtensions) {
    return { id: 'realchrome', label: 'Real Chrome (extensions)', userDataDir: input.realChromeDir, kind: 'realchrome' };
  }
  const named = sanitizeProfileId(input.profileId);
  if (named && named !== 'default') {
    return {
      id: `named:${named}`,
      label: named,
      userDataDir: path.join(input.profilesDir, input.userId, 'browser-profiles', named),
      kind: 'named',
    };
  }
  return {
    id: 'default',
    label: 'Default',
    userDataDir: path.join(input.profilesDir, input.userId, 'chrome-profile'),
    kind: 'run',
  };
}

/** Does this profile need a lease? The operator's own browser is not ours. */
export function needsLease(ref: ProfileRef): boolean {
  return ref.kind !== 'local' && ref.kind !== 'ephemeral';
}

// Atomic compare-and-delete / compare-and-refresh on the token.
const RELEASE_LUA = `
local v = redis.call('get', KEYS[1])
if not v then return 0 end
local ok, rec = pcall(cjson.decode, v)
if ok and rec.token == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`;
const REFRESH_LUA = `
local v = redis.call('get', KEYS[1])
if not v then return 0 end
local ok, rec = pcall(cjson.decode, v)
if ok and rec.token == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end
return 0`;

export class ProfileLeases {
  constructor(private readonly redis: IORedis, private readonly ttlSec: number) {}

  private key(profileId: string): string { return KEY_PREFIX + profileId; }

  /** Take the lease, or return the record of the run holding it. */
  async acquire(profileId: string, jobId: string): Promise<{ ok: true; token: string } | { ok: false; holder: LeaseRecord | null }> {
    const rec: LeaseRecord = { profileId, jobId, token: randomUUID(), instance: INSTANCE_ID, acquiredAt: Date.now() };
    const set = await this.redis.set(this.key(profileId), JSON.stringify(rec), 'EX', Math.max(60, this.ttlSec), 'NX');
    if (set === 'OK') return { ok: true, token: rec.token };
    const holder = await this.holder(profileId);
    // Re-entry by the SAME job (a retry of a step, or a job moved back from
    // delayed while its earlier attempt already holds it) is not a conflict.
    if (holder && holder.jobId === jobId && holder.instance === INSTANCE_ID) return { ok: true, token: holder.token };
    return { ok: false, holder };
  }

  async release(profileId: string, token: string | null | undefined): Promise<boolean> {
    if (!token) return false; // never blindly delete someone else's lease
    const n = await this.redis.eval(RELEASE_LUA, 1, this.key(profileId), token);
    return Number(n) === 1;
  }

  async refresh(profileId: string, token: string): Promise<boolean> {
    const n = await this.redis.eval(REFRESH_LUA, 1, this.key(profileId), token, String(Math.max(60, this.ttlSec)));
    return Number(n) === 1;
  }

  async holder(profileId: string): Promise<LeaseRecord | null> {
    const raw = await this.redis.get(this.key(profileId));
    if (!raw) return null;
    try { return JSON.parse(raw) as LeaseRecord; } catch { return null; }
  }

  /** Every lease currently held. SCAN, never KEYS. */
  async list(): Promise<LeaseRecord[]> {
    const out: LeaseRecord[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const raw = await this.redis.get(k);
        if (!raw) continue;
        try { out.push(JSON.parse(raw) as LeaseRecord); } catch { /* corrupt: ignored */ }
      }
    } while (cursor !== '0');
    return out;
  }

  /**
   * Drop leases taken by an earlier incarnation of this server. Called once at
   * boot, before the worker starts: a run cannot survive the process that ran
   * its browser, so such a lease is a profile stuck "busy" forever otherwise.
   */
  async releaseOrphaned(): Promise<string[]> {
    const freed: string[] = [];
    for (const rec of await this.list()) {
      if (rec.instance !== INSTANCE_ID) {
        await this.redis.eval(RELEASE_LUA, 1, this.key(rec.profileId), rec.token);
        freed.push(rec.profileId);
      }
    }
    return freed;
  }
}
