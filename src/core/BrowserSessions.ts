/**
 * BrowserSessions — who depends on a LIVE browser, and may it be closed.
 *
 * A SESSION is a running browser on one profile (tabs, in-memory cookies, the
 * page a run is on). It is not the profile (core/ProfileRegistry), not a run,
 * and not a claim (core/ProfileLease). The Playwright context itself stays
 * where it always lived (ProfileManager's per-profile map); this registry only
 * records the facts every close decision needs:
 *
 *   dependents   runs (`job:<id>`) and operator views (`operator:<owner>`)
 *                using the browser now. A browser with a dependent other than
 *                the requester is NEVER closed — not by a run's Close Browser
 *                node, not by "close after run", not by the idle collector,
 *                not by the operator's Close.
 *   createdBy    who launched it (informational: a shared browser has no
 *                exclusive owner, so launching it grants no right to close it).
 *   visibility   how it was launched (visible / hidden).
 *   lastActivity the idle clock. A session with ANY dependent is never idle:
 *                a run sitting in a deliberate Wait node is still a dependent,
 *                so a long wait cannot be mistaken for an unused browser.
 *
 * CLOSING A BROWSER NEVER RELEASES A CLAIM. Leases, holds and reservations are
 * released only by their own owners. Conversely a claim ending never closes a
 * browser by itself; the idle collector closes only sessions nobody depends on.
 *
 * PERSISTENCE. Each record is mirrored to Redis with this process's instance
 * id, so after a restart the sessions of the previous incarnation are found
 * (`stale()`): their browsers died with that process, and recovery reports them
 * instead of silently assuming nothing was there. Mirror writes are
 * best-effort; the in-memory record is the truth for this process.
 */
import { forgetManual } from './ManualProfiles';
import type IORedis from 'ioredis';
import { INSTANCE_ID } from './ProfileLease';

export const SESSION_PREFIX = 'profile:session:';

export type Visibility = 'visible' | 'hidden';

export interface SessionRecord {
  /** Lease id of the profile (`default`, `named:<id>`). One session per profile. */
  leaseId: string;
  userId: string;
  visibility: Visibility;
  createdBy: string;
  startedAt: number;
  lastActivity: number;
  dependents: string[];
  instance: string;
}

// Where each live session's profile lives on disk, so an automatic close
// (idle collector, GC) can save its state first. Kept in memory only: a path
// is never mirrored to Redis or shown in the UI.
const dataDirs = new Map<string, string>();
export function setSessionDataDir(leaseId: string, dir: string | null | undefined): void {
  if (dir) dataDirs.set(leaseId, dir); else dataDirs.delete(leaseId);
}
export function sessionDataDir(leaseId: string): string | null { return dataDirs.get(leaseId) || null; }

// WHICH profile of the branch the live browser runs (core/BranchRegistry: one
// Chromium process per branch root, so one running profile per branch).
// In memory, like the data dir: decided by whoever launched the browser.
const runningProfiles = new Map<string, string>();
export function setRunningProfile(leaseId: string, profileId: string | null | undefined): void {
  if (profileId) runningProfiles.set(leaseId, profileId); else runningProfiles.delete(leaseId);
}
export function runningProfileOf(leaseId: string): string | null { return runningProfiles.get(leaseId) || null; }

export type CloseDecision =
  | { ok: true }
  | { ok: false; reason: 'in_use'; dependents: string[] }
  | { ok: false; reason: 'not_open' };

export const jobDependent = (jobId: string | number): string => `job:${jobId}`;
export const operatorDependent = (owner: string): string => `operator:${owner}`;

/** May `requester` close a session with these dependents? Pure. */
export function decideClose(rec: SessionRecord | null | undefined, requester: string): CloseDecision {
  if (!rec) return { ok: false, reason: 'not_open' };
  const others = rec.dependents.filter((d) => d !== requester);
  return others.length ? { ok: false, reason: 'in_use', dependents: others } : { ok: true };
}

/** Is this session idle long enough to be collected? Pure. `idleMs <= 0` = never. */
export function isIdle(rec: SessionRecord, now: number, idleMs: number): boolean {
  if (idleMs <= 0) return false;
  if (rec.dependents.length) return false;
  return now - rec.lastActivity >= idleMs;
}

export class BrowserSessions {
  private readonly map = new Map<string, SessionRecord>();

  constructor(private readonly redis: IORedis | null = null) {}

  private mirror(rec: SessionRecord | null, leaseId: string): void {
    if (!this.redis) return;
    const k = SESSION_PREFIX + leaseId;
    const p = rec ? this.redis.set(k, JSON.stringify(rec)) : this.redis.del(k);
    void Promise.resolve(p).catch(() => { /* best-effort mirror */ });
  }

  get(leaseId: string): SessionRecord | null {
    const r = this.map.get(leaseId);
    return r ? { ...r, dependents: [...r.dependents] } : null;
  }

  list(): SessionRecord[] {
    return [...this.map.values()].map((r) => ({ ...r, dependents: [...r.dependents] }));
  }

  /** A browser was launched on this profile. Dependents carry over a relaunch. */
  opened(leaseId: string, info: { userId: string; visibility: Visibility; createdBy: string }): SessionRecord {
    const now = Date.now();
    const prev = this.map.get(leaseId);
    const rec: SessionRecord = {
      leaseId, userId: info.userId, visibility: info.visibility, createdBy: info.createdBy,
      startedAt: now, lastActivity: now,
      dependents: prev ? [...prev.dependents] : [],
      instance: INSTANCE_ID,
    };
    this.map.set(leaseId, rec);
    this.mirror(rec, leaseId);
    return { ...rec, dependents: [...rec.dependents] };
  }

  /** The browser is gone (closed, crashed). Dependents are forgotten with it. */
  closed(leaseId: string): void {
    this.map.delete(leaseId);
    runningProfiles.delete(leaseId);
    // Manual-only profiles opened inside this branch's browser (core/
    // ManualProfiles) had their windows in this process: they are gone too
    // (measured, S36 G.1 c).
    forgetManual(leaseId);
    this.mirror(null, leaseId);
  }

  attach(leaseId: string, dependent: string): boolean {
    const r = this.map.get(leaseId);
    if (!r) return false;
    if (!r.dependents.includes(dependent)) r.dependents.push(dependent);
    r.lastActivity = Date.now();
    this.mirror(r, leaseId);
    return true;
  }

  detach(leaseId: string, dependent: string): void {
    const r = this.map.get(leaseId);
    if (!r) return;
    r.dependents = r.dependents.filter((d) => d !== dependent);
    r.lastActivity = Date.now();
    this.mirror(r, leaseId);
  }

  detachEverywhere(dependent: string): void {
    for (const leaseId of this.map.keys()) this.detach(leaseId, dependent);
  }

  touch(leaseId: string): void {
    const r = this.map.get(leaseId);
    if (r) r.lastActivity = Date.now();
  }

  canClose(leaseId: string, requester: string): CloseDecision {
    return decideClose(this.map.get(leaseId), requester);
  }

  idle(now: number, idleMs: number): SessionRecord[] {
    return this.list().filter((r) => isIdle(r, now, idleMs));
  }

  /** Session records left by an EARLIER incarnation of this server. */
  async stale(): Promise<SessionRecord[]> {
    if (!this.redis) return [];
    const out: SessionRecord[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${SESSION_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const raw = await this.redis.get(k);
        if (!raw) continue;
        try {
          const r = JSON.parse(raw) as SessionRecord;
          if (r.instance !== INSTANCE_ID) out.push(r);
        } catch { /* corrupt: ignored */ }
      }
    } while (cursor !== '0');
    return out;
  }

  async forgetStale(leaseId: string): Promise<void> {
    if (!this.redis) return;
    const raw = await this.redis.get(SESSION_PREFIX + leaseId);
    if (!raw) return;
    try {
      if ((JSON.parse(raw) as SessionRecord).instance === INSTANCE_ID) return;
    } catch { /* corrupt: drop */ }
    await this.redis.del(SESSION_PREFIX + leaseId);
  }
}

// Process-wide instance, registered by index.ts (owner of the Redis client),
// so pipeline.ts and routes reach it without an import cycle.
let active: BrowserSessions = new BrowserSessions(null);
export function registerBrowserSessions(s: BrowserSessions): void { active = s; }
export function browserSessions(): BrowserSessions { return active; }
