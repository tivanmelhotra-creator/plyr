/**
 * ProfileReservations — scheduled runs protect their profile in time.
 *
 * A schedule bound to a profile reserves that profile around every planned
 * occurrence: [t - before, t + after] (defaults 10 / 10 minutes, Settings →
 * Workflow Runs). During that window no OTHER owner (workflow) can take the
 * profile: not a run (ProfileLeases.acquire), not the operator opening its
 * browser by hand (ProfileLeases.hold). The admission script reads these
 * records atomically with the lease and the hold.
 *
 * A reservation is NOT a browser and NOT a lease: it exists whether or not a
 * browser is open, it never starts/closes a browser, and the run itself still
 * takes a lease (one run per profile).
 *
 * LIFECYCLE of one occurrence (id `<scheduleId>@<occurrenceMs>`):
 *   planned  created ahead of time by sync() (rolling horizon)
 *   fired    the worker started that occurrence (markFired)
 *   settled  the run ended by any path (markSettled). Still blocking until
 *            max(end, settledAt): a 10:00 run ending 10:20 keeps the profile
 *            until 10:20; one ending 10:02 still honours the margin to 10:10.
 *   missed   the occurrence will not run (inactive workflow, removed schedule,
 *            no job ever appeared). Not blocking.
 *
 * UNKNOWN IS NEVER FREE. A `fired` reservation whose run is not proven ended
 * stays blocking past its window. sweep() resolves it only from evidence.
 */
import type IORedis from 'ioredis';
import { parseExpression } from 'cron-parser';
import { RESV_PREFIX, type ReservationLike } from './ProfileLease';

export type Reservation = ReservationLike;

export interface ScheduleBinding {
  scheduleId: string;
  /** Owner of the runs: workflow id, or `schedule:<id>` for a raw schedule. */
  owner: string;
  ownerName?: string;
  /** Lease id the runs will take (`default`, `named:<id>`, `realchrome`). */
  leaseId: string;
  cron: string;
  tz?: string | null;
}

export interface ReservationWindow { beforeMs: number; afterMs: number }

export interface Overlap { leaseId: string; a: Reservation; b: Reservation }

/** Occurrences of a cron pattern in [from, to). Pure. */
export function occurrences(cron: string, from: number, to: number, opts: { tz?: string | null; max?: number } = {}): number[] {
  const out: number[] = [];
  const max = opts.max ?? 50;
  let it;
  try {
    it = parseExpression(cron, { currentDate: new Date(from - 1), endDate: new Date(to), ...(opts.tz ? { tz: opts.tz } : {}) });
  } catch {
    return out;
  }
  while (out.length < max) {
    try {
      const t = it.next().getTime();
      if (t >= to) break;
      if (t >= from) out.push(t);
    } catch {
      break; // iterator exhausted
    }
  }
  return out;
}

/** The reservation window of one occurrence. Pure. */
export function windowOf(occurrence: number, w: ReservationWindow): { start: number; end: number } {
  return { start: occurrence - Math.max(0, w.beforeMs), end: occurrence + Math.max(0, w.afterMs) };
}

/** Until when does a reservation block other owners? Pure; mirrors the admission script. */
export function blockingUntil(r: Reservation): number {
  if (r.state === 'missed') return 0;
  if (r.state === 'settled') return Math.max(r.end, r.settledAt ?? 0);
  return Number.POSITIVE_INFINITY; // planned / fired: until evidence settles it
}

/** Does `r` block `owner` at `now`? Pure; mirrors the admission script. */
export function blocks(r: Reservation, owner: string, now: number): boolean {
  if (r.owner === owner) return false;
  return r.start <= now && now < blockingUntil(r);
}

/** Reservations of DIFFERENT owners whose windows overlap on one profile. Pure. */
export function findOverlaps(byLease: Map<string, Reservation[]>): Overlap[] {
  const out: Overlap[] = [];
  for (const [leaseId, list] of byLease) {
    const live = list.filter((r) => r.state !== 'missed').sort((x, y) => x.start - y.start);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!; const b = live[j]!;
        const aEnd = Math.min(Math.max(a.end, a.settledAt ?? 0), blockingUntil(a));
        if (b.start >= aEnd) break;
        if (a.owner !== b.owner) out.push({ leaseId, a, b });
      }
    }
  }
  return out;
}

// Delete a field only while it is still `planned` (never drop evidence of a run).
const DEL_IF_PLANNED_LUA = `
local v = redis.call('hget', KEYS[1], ARGV[1])
if not v then return 0 end
local ok, r = pcall(cjson.decode, v)
if ok and r.state == 'planned' then return redis.call('hdel', KEYS[1], ARGV[1]) end
return 0`;
// ARGV: field, toState, jobId, nowMs, fallbackJson ('' = do not create)
const TRANSITION_LUA = `
local v = redis.call('hget', KEYS[1], ARGV[1])
local r
if v then
  local ok, d = pcall(cjson.decode, v)
  if ok then r = d end
end
if not r then
  if ARGV[5] == '' then return 0 end
  r = cjson.decode(ARGV[5])
end
local to = ARGV[2]
if to == 'fired' then
  if r.state == 'settled' then return 0 end
  r.state = 'fired'
  if ARGV[3] ~= '' then r.jobId = ARGV[3] end
elseif to == 'settled' then
  if r.state == 'settled' then return 0 end
  if ARGV[3] ~= '' and r.jobId and r.jobId ~= ARGV[3] then return 0 end
  r.state = 'settled'
  r.settledAt = tonumber(ARGV[4])
elseif to == 'missed' then
  if r.state ~= 'planned' then return 0 end
  r.state = 'missed'
  r.settledAt = tonumber(ARGV[4])
end
redis.call('hset', KEYS[1], ARGV[1], cjson.encode(r))
return 1`;

export interface QueueProbe {
  /** 'completed' | 'failed' | 'active' | 'waiting' | 'delayed' | 'missing' | ... */
  jobState(jobId: string): Promise<{ state: string; finishedOn?: number | null }>;
  /** Is a job for this occurrence waiting / delayed / active? */
  occurrencePending(scheduleId: string, occurrence: number): Promise<boolean>;
  /** Is this job executing in THIS process right now? */
  runningHere(jobId: string): boolean;
}

export class ProfileReservations {
  constructor(private readonly redis: IORedis) {}

  key(leaseId: string): string { return RESV_PREFIX + leaseId; }

  static idOf(scheduleId: string, occurrence: number): string { return `${scheduleId}@${occurrence}`; }

  async list(leaseId: string): Promise<Reservation[]> {
    const flat = await this.redis.hgetall(this.key(leaseId));
    const out: Reservation[] = [];
    for (const v of Object.values(flat)) {
      try { out.push(JSON.parse(v) as Reservation); } catch { /* corrupt: ignored */ }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Every profile with reservations. SCAN, never KEYS. */
  async all(): Promise<Map<string, Reservation[]>> {
    const out = new Map<string, Reservation[]>();
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${RESV_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const leaseId = k.slice(RESV_PREFIX.length);
        out.set(leaseId, await this.list(leaseId));
      }
    } while (cursor !== '0');
    return out;
  }

  /**
   * Bring PLANNED reservations in line with the schedules: create occurrences
   * in the rolling horizon, drop planned ones no schedule wants any more (or
   * whose window / owner changed). Fired / settled records are evidence of a
   * run and are never touched here. Returns the overlaps found.
   */
  async sync(bindings: ScheduleBinding[], w: ReservationWindow, opts: { now?: number; horizonMs?: number; perSchedule?: number } = {}):
    Promise<{ created: number; dropped: number; overlaps: Overlap[] }> {
    const now = opts.now ?? Date.now();
    const horizon = opts.horizonMs ?? 24 * 3600_000;
    const desired = new Map<string, Map<string, Reservation>>();
    for (const b of bindings) {
      const occ = occurrences(b.cron, now - w.afterMs, now + horizon + w.beforeMs, { tz: b.tz, max: opts.perSchedule ?? 48 });
      for (const t of occ) {
        const { start, end } = windowOf(t, w);
        const id = ProfileReservations.idOf(b.scheduleId, t);
        if (!desired.has(b.leaseId)) desired.set(b.leaseId, new Map());
        desired.get(b.leaseId)!.set(id, { id, owner: b.owner, ownerName: b.ownerName, scheduleId: b.scheduleId, occurrence: t, start, end, state: 'planned' });
      }
    }
    let created = 0;
    let dropped = 0;
    for (const [leaseId, list] of await this.all()) {
      const want = desired.get(leaseId);
      for (const r of list) {
        if (r.state !== 'planned') continue;
        const d = want?.get(r.id);
        if (!d || d.start !== r.start || d.end !== r.end || d.owner !== r.owner) {
          dropped += Number(await this.redis.eval(DEL_IF_PLANNED_LUA, 1, this.key(leaseId), r.id));
        }
      }
    }
    for (const [leaseId, recs] of desired) {
      for (const [id, rec] of recs) created += await this.redis.hsetnx(this.key(leaseId), id, JSON.stringify(rec));
    }
    return { created, dropped, overlaps: findOverlaps(await this.all()) };
  }

  /** The worker started an occurrence. Creates the record if sync() has not yet. */
  async markFired(leaseId: string, b: { scheduleId: string; owner: string; ownerName?: string }, occurrence: number, jobId: string, w: ReservationWindow): Promise<void> {
    const id = ProfileReservations.idOf(b.scheduleId, occurrence);
    const { start, end } = windowOf(occurrence, w);
    const fallback: Reservation = { id, owner: b.owner, ownerName: b.ownerName, scheduleId: b.scheduleId, occurrence, start, end, state: 'fired', jobId };
    await this.redis.eval(TRANSITION_LUA, 1, this.key(leaseId), id, 'fired', jobId, String(Date.now()), JSON.stringify(fallback));
  }

  /** The run of an occurrence ended (any outcome). Only the run that fired it may settle it. */
  async markSettled(leaseId: string, scheduleId: string, occurrence: number, jobId: string, at = Date.now()): Promise<boolean> {
    const n = await this.redis.eval(TRANSITION_LUA, 1, this.key(leaseId), ProfileReservations.idOf(scheduleId, occurrence), 'settled', jobId, String(at), '');
    return Number(n) === 1;
  }

  /** The occurrence will not run. Only a still-planned reservation can be missed. */
  async markMissed(leaseId: string, scheduleId: string, occurrence: number, at = Date.now()): Promise<boolean> {
    const n = await this.redis.eval(TRANSITION_LUA, 1, this.key(leaseId), ProfileReservations.idOf(scheduleId, occurrence), 'missed', '', String(at), '');
    return Number(n) === 1;
  }

  /** Mark every reservation of an occurrence missed, on whichever profile it is. */
  async markOccurrenceMissed(scheduleId: string, occurrence: number): Promise<number> {
    let n = 0;
    for (const [leaseId, list] of await this.all()) {
      if (list.some((r) => r.scheduleId === scheduleId && r.occurrence === occurrence)) {
        if (await this.markMissed(leaseId, scheduleId, occurrence)) n++;
      }
    }
    return n;
  }

  /**
   * Resolve reservations from EVIDENCE, and prune old ones.
   *   fired + job terminal / missing     -> settled (at the job's finish time)
   *   fired + running / pending / unknown-> unchanged (still blocking)
   *   planned + window over + no job     -> missed
   *   settled / missed long ago          -> deleted
   */
  async sweep(probe: QueueProbe, opts: { now?: number; graceMs?: number; keepMs?: number } = {}): Promise<{ settled: number; missed: number; pruned: number }> {
    const now = opts.now ?? Date.now();
    const grace = opts.graceMs ?? 5 * 60_000;
    const keep = opts.keepMs ?? 6 * 3600_000;
    let settled = 0; let missed = 0; let pruned = 0;
    for (const [leaseId, list] of await this.all()) {
      for (const r of list) {
        if (r.state === 'fired' && r.jobId) {
          if (probe.runningHere(r.jobId)) continue;
          const st = await probe.jobState(r.jobId).catch(() => ({ state: 'unknown', finishedOn: null as number | null }));
          if (st.state === 'completed' || st.state === 'failed' || st.state === 'missing') {
            if (await this.markSettled(leaseId, r.scheduleId || '', r.occurrence, r.jobId, st.finishedOn || now)) settled++;
          }
          continue;
        }
        if (r.state === 'planned' && now > r.end + grace) {
          const pending = await probe.occurrencePending(r.scheduleId || '', r.occurrence).catch(() => true);
          if (!pending && await this.markMissed(leaseId, r.scheduleId || '', r.occurrence, now)) missed++;
          continue;
        }
        if ((r.state === 'settled' || r.state === 'missed') && Math.max(r.end, r.settledAt ?? 0) + keep < now) {
          pruned += await this.redis.hdel(this.key(leaseId), r.id);
        }
      }
    }
    return { settled, missed, pruned };
  }

  /** Reservations that still matter for a profile (blocks deletion). */
  async pending(leaseId: string, now = Date.now()): Promise<Reservation[]> {
    return (await this.list(leaseId)).filter((r) => r.state === 'planned' || r.state === 'fired' || (r.state === 'settled' && blockingUntil(r) > now));
  }
}
