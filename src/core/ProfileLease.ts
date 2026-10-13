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
export const HOLD_PREFIX = 'profile:hold:';
export const RESV_PREFIX = 'profile:resv:';
export const GRANT_PREFIX = 'profile:grant:';

/** The lease id of a registry profile id ('default' stays 'default'). */
export function leaseIdOf(profileId: string): string {
  return profileId === 'default' ? 'default' : `named:${profileId}`;
}

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
  /**
   * Who the run works for: the saved workflow id, `schedule:<id>` for a raw
   * schedule, `job:<id>` for a one-off run. Holds and reservations of the SAME
   * owner are compatible with this run; any other owner's are not. Absent on
   * leases written before reservations existed (compatible with nobody).
   */
  owner?: string;
}

/**
 * The operator's claim: a profile's browser opened by hand for workflow
 * `owner` (Workflow Files drawer). Exclusive against OTHER owners like a lease,
 * but time-bounded: it ends at `expiresAt`, which is never later than the start
 * of the next foreign reservation. Closing the browser does NOT release it —
 * browser (core/BrowserSessions) and claim are different things.
 */
export interface HoldRecord {
  profileId: string;
  owner: string;
  token: string;
  instance: string;
  acquiredAt: number;
  expiresAt: number;
}

/** The reservation fields admission reads (core/ProfileReservations writes them). */
export interface ReservationLike {
  id: string;
  owner: string;
  ownerName?: string;
  scheduleId?: string;
  occurrence: number;
  start: number;
  end: number;
  state: 'planned' | 'fired' | 'settled' | 'missed';
  jobId?: string;
  settledAt?: number;
}

/** Why a claim was refused. Shown to the user, with the record that caused it. */
export type DenyReason = 'in_use' | 'held' | 'reserved' | 'reserved_soon';

export type AdmissionResult =
  | { ok: true; token: string; reentry?: boolean; expiresAt?: number }
  | { ok: false; reason: DenyReason; lease?: LeaseRecord | null; hold?: HoldRecord | null; reservation?: ReservationLike | null };

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


/**
 * ONE admission script for every way a profile is claimed (run lease,
 * operator hold, read-only check). Atomic inside Redis: the reads of lease,
 * hold, reservations and grants and the write of the new claim are a single
 * step, so two runs — or a run and the operator — can never both be admitted.
 *
 * KEYS: lease, hold, reservations (hash), grants (hash)
 * ARGV: mode ('lease'|'hold'|'check'), owner, jobId, recordJson, ttlMs, nowMs,
 *       instance, minHoldMs
 *
 * allowed(X): a claim of owner X does not conflict when X IS the requester,
 * or X explicitly granted the requester access (grants are only written by an
 * explicit API call — a user's selection never creates one).
 *
 * A reservation blocks other owners from its start:
 *   planned / fired  -> until it is settled (an ended window whose run never
 *                       settled stays blocking: unknown is never "free"; the
 *                       reservation sweep resolves it from the queue's state);
 *   settled          -> until max(end, settledAt): the margin after the
 *                       scheduled time is honoured, and so is a run that ran
 *                       past it;
 *   missed           -> never.
 */
const ADMIT_LUA = `
local mode = ARGV[1]
local owner = ARGV[2]
local jobId = ARGV[3]
local now = tonumber(ARGV[6])
local instance = ARGV[7]
local function dec(v) if not v then return nil end local ok, r = pcall(cjson.decode, v) if ok and type(r) == 'table' then return r end return nil end
local function allowed(x)
  if x == nil or x == false or x == cjson.null then return false end
  x = tostring(x)
  if x == owner then return true end
  local g = redis.call('hget', KEYS[4], x .. '>' .. owner)
  if g and tonumber(g) and tonumber(g) > now then return true end
  return false
end
local lease = dec(redis.call('get', KEYS[1]))
if lease then
  if mode == 'lease' and lease.jobId == jobId and lease.instance == instance then
    return cjson.encode({ ok = true, token = lease.token, reentry = true })
  end
  if not ((mode == 'hold' or mode == 'check') and allowed(lease.owner)) then
    return cjson.encode({ ok = false, reason = 'in_use', lease = lease })
  end
end
local hold = dec(redis.call('get', KEYS[2]))
if hold and not allowed(hold.owner) then
  return cjson.encode({ ok = false, reason = 'held', hold = hold })
end
local cap = now + tonumber(ARGV[5])
local capRec = nil
local flat = redis.call('hgetall', KEYS[3])
for i = 1, #flat, 2 do
  local r = dec(flat[i + 1])
  if r and r.state ~= 'missed' and not allowed(r.owner) then
    local st = tonumber(r.start) or 0
    local blocking = false
    if st <= now then
      if r.state == 'settled' then
        local e = math.max(tonumber(r['end']) or 0, tonumber(r.settledAt) or 0)
        blocking = now < e
      else
        blocking = true
      end
    end
    if blocking then
      return cjson.encode({ ok = false, reason = 'reserved', reservation = r })
    end
    if st > now and st < cap and r.state ~= 'settled' then
      cap = st
      capRec = r
    end
  end
end
if mode == 'check' then
  return cjson.encode({ ok = true, expiresAt = cap })
end
local rec = cjson.decode(ARGV[4])
rec.owner = owner
if mode == 'lease' then
  redis.call('set', KEYS[1], cjson.encode(rec), 'PX', tonumber(ARGV[5]))
  return cjson.encode({ ok = true, token = rec.token })
end
if cap - now < tonumber(ARGV[8]) then
  return cjson.encode({ ok = false, reason = 'reserved_soon', reservation = capRec })
end
if hold and hold.owner == owner then
  rec.token = hold.token
  rec.acquiredAt = hold.acquiredAt
end
rec.expiresAt = cap
redis.call('set', KEYS[2], cjson.encode(rec), 'PX', cap - now)
return cjson.encode({ ok = true, token = rec.token, expiresAt = cap })`;

const RELEASE_HOLD_LUA = `
local v = redis.call('get', KEYS[1])
if not v then return 0 end
local ok, rec = pcall(cjson.decode, v)
if ok and ((ARGV[1] ~= '' and rec.token == ARGV[1]) or (ARGV[2] ~= '' and rec.owner == ARGV[2])) then return redis.call('del', KEYS[1]) end
return 0`;

export class ProfileLeases {
  constructor(private readonly redis: IORedis, private readonly ttlSec: number) {}

  private key(profileId: string): string { return KEY_PREFIX + profileId; }

  private keysOf(profileId: string): string[] {
    return [this.key(profileId), HOLD_PREFIX + profileId, RESV_PREFIX + profileId, GRANT_PREFIX + profileId];
  }

  private async admit(mode: 'lease' | 'hold' | 'check', profileId: string, owner: string, jobId: string,
    rec: object, ttlMs: number, minHoldMs = 0): Promise<AdmissionResult> {
    const raw = await this.redis.eval(ADMIT_LUA, 4, ...this.keysOf(profileId),
      mode, owner, jobId, JSON.stringify(rec), String(Math.max(1000, Math.floor(ttlMs))),
      String(Date.now()), INSTANCE_ID, String(Math.max(0, Math.floor(minHoldMs))));
    const out = JSON.parse(String(raw)) as AdmissionResult;
    return out;
  }

  /**
   * Take the lease for a run, or say why not. Atomic against other leases, the
   * operator's hold, and active reservations of other owners. `owner` defaults
   * to the job itself (compatible with nobody else).
   */
  async acquire(profileId: string, jobId: string, opts: { owner?: string } = {}): Promise<
    | { ok: true; token: string }
    | { ok: false; holder: LeaseRecord | null; reason: DenyReason; hold?: HoldRecord | null; reservation?: ReservationLike | null }> {
    const owner = opts.owner || `job:${jobId}`;
    const rec: LeaseRecord = { profileId, jobId, token: randomUUID(), instance: INSTANCE_ID, acquiredAt: Date.now(), owner };
    const r = await this.admit('lease', profileId, owner, jobId, rec, Math.max(60, this.ttlSec) * 1000);
    if (r.ok) return { ok: true, token: r.token };
    return { ok: false, holder: r.lease || null, reason: r.reason, hold: r.hold || null, reservation: r.reservation || null };
  }

  /** Could `owner` claim this profile now? Read-only, same rules as acquire / hold. */
  async check(profileId: string, owner: string): Promise<AdmissionResult> {
    return this.admit('check', profileId, owner, '', {}, 24 * 3600_000);
  }

  /**
   * The operator's claim for workflow `owner`. Re-entrant (a second call by the
   * same owner refreshes it, keeping its token). `ttlMs` is the most it may
   * last; the script shortens it to the next foreign reservation, and refuses
   * with `reserved_soon` when less than `minHoldMs` would remain.
   */
  async hold(profileId: string, owner: string, ttlMs: number, minHoldMs = 60_000): Promise<AdmissionResult> {
    const rec = { profileId, owner, token: randomUUID(), instance: INSTANCE_ID, acquiredAt: Date.now(), expiresAt: 0 };
    return this.admit('hold', profileId, owner, '', rec, ttlMs, minHoldMs);
  }

  async holdOf(profileId: string): Promise<HoldRecord | null> {
    const raw = await this.redis.get(HOLD_PREFIX + profileId);
    if (!raw) return null;
    try { return JSON.parse(raw) as HoldRecord; } catch { return null; }
  }

  /** Release a hold by its token, or by its owner (the operator ending their own claim). */
  async releaseHold(profileId: string, by: { token?: string; owner?: string }): Promise<boolean> {
    const n = await this.redis.eval(RELEASE_HOLD_LUA, 1, HOLD_PREFIX + profileId, by.token || '', by.owner || '');
    return Number(n) === 1;
  }

  /**
   * An EXPLICIT permission for owner `to` to use a profile while owner `from`
   * holds or reserves it — the controlled re-use path phase 2's "continue
   * session" node will call. Never created implicitly; expires by itself.
   */
  async grant(profileId: string, from: string, to: string, ttlMs: number): Promise<void> {
    const ms = Math.max(1000, Math.floor(ttlMs));
    await this.redis.hset(GRANT_PREFIX + profileId, `${from}>${to}`, String(Date.now() + ms));
    await this.redis.pexpire(GRANT_PREFIX + profileId, ms + 60_000);
  }

  async revokeGrant(profileId: string, from: string, to: string): Promise<void> {
    await this.redis.hdel(GRANT_PREFIX + profileId, `${from}>${to}`);
  }

  /** Every grant TO `to` on a profile (the continuation ended). Returns how many. */
  async revokeGrantsTo(profileId: string, to: string): Promise<number> {
    const all = await this.redis.hkeys(GRANT_PREFIX + profileId);
    const mine = all.filter((f) => f.endsWith(`>${to}`));
    if (!mine.length) return 0;
    return this.redis.hdel(GRANT_PREFIX + profileId, ...mine);
  }

  /** Live (unexpired) grants on a profile: [{ from, to, until }]. */
  async grants(profileId: string, now = Date.now()): Promise<Array<{ from: string; to: string; until: number }>> {
    const flat = await this.redis.hgetall(GRANT_PREFIX + profileId);
    return Object.entries(flat).map(([k, v]) => {
      const i = k.indexOf('>');
      return { from: k.slice(0, i), to: k.slice(i + 1), until: Number(v) };
    }).filter((g) => g.until > now);
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

  /** Every operator hold currently set. */
  async listHolds(): Promise<HoldRecord[]> {
    const out: HoldRecord[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${HOLD_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const raw = await this.redis.get(k);
        if (!raw) continue;
        try { out.push(JSON.parse(raw) as HoldRecord); } catch { /* corrupt: ignored */ }
      }
    } while (cursor !== '0');
    return out;
  }

  /**
   * Holds of an earlier incarnation: the operator's browser died with that
   * process, and nothing can refresh the hold any more. Released at boot so a
   * restarted server does not keep a profile claimed for a view that is gone.
   */
  async releaseOrphanedHolds(): Promise<string[]> {
    const freed: string[] = [];
    for (const h of await this.listHolds()) {
      if (h.instance !== INSTANCE_ID && await this.releaseHold(h.profileId, { token: h.token })) freed.push(h.profileId);
    }
    return freed;
  }
}

// ── Process-wide lookup, registered by index.ts (which owns the Redis client).
// Lets modules without Redis (e.g. Routes/browser.routes) ask "is a run using
// Real Chrome right now?" without importing index.ts (an import cycle).
let activeLeases: ProfileLeases | null = null;
export function registerProfileLeases(l: ProfileLeases): void { activeLeases = l; }
/** The process-wide leases (null in tests / tools that never registered one). */
export function profileLeasesRegistry(): ProfileLeases | null { return activeLeases; }
/** The run currently holding Real Chrome's profile, or null. */
export async function realChromeLeaseHolder(): Promise<LeaseRecord | null> {
  return activeLeases ? activeLeases.holder('realchrome') : null;
}
