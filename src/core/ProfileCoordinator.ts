/**
 * ProfileCoordinator — glue between the queue (runs, schedules) and the
 * profile infrastructure. Kept out of index.ts so it can be tested against a
 * real Redis and a real BullMQ queue without starting the server.
 *
 *   ownerOfJob()        who a run works for (hold / reservation compatibility)
 *   occurrenceOf()      the planned time of a scheduled run (BullMQ prevMillis)
 *   bindings()          every schedule -> the profile its runs will lease
 *   syncReservations()  planned windows follow the schedules (rolling horizon)
 *   sweep()             settle / miss reservations from evidence; idle browsers
 *   recoverAtBoot()     what an earlier incarnation of the server left behind
 */
import type { Job, Queue } from 'bullmq';
import { config } from '../config';
import { resolveRunProfile, needsLease, type ProfileLeases } from './ProfileLease';
import { findOverlaps, occurrences, windowOf, type ProfileReservations, type ReservationWindow, type ScheduleBinding, type QueueProbe, type Overlap } from './ProfileReservations';
import type { BrowserSessions, SessionRecord } from './BrowserSessions';
import { stepsUseExtensions } from './ExtensionStep';
import { runProfileIdOf } from './NodeProfile';

export const SCHEDULE_PREFIX = 'sched';

/** Who a run works for. Same owner = compatible with its own holds / reservations. */
export function ownerOfJob(data: Record<string, any>, jobId: string | number): string {
  const wf = data?.__scheduleWorkflowId || data?.__workflowId || data?.__workspace?.workflowId || data?.__testOf?.workflowId;
  if (typeof wf === 'string' && wf) return wf;
  if (typeof data?.__scheduleId === 'string' && data.__scheduleId) return `schedule:${data.__scheduleId}`;
  return `job:${jobId}`;
}

/** The planned time of a scheduled run (BullMQ stores it as `prevMillis`). */
export function occurrenceOf(job: Pick<Job, 'opts'>): number | null {
  const pm = (job.opts as { prevMillis?: number } | undefined)?.prevMillis;
  return typeof pm === 'number' && pm > 0 ? pm : null;
}

export function reservationWindow(): ReservationWindow {
  return {
    beforeMs: Math.max(0, config.PROFILE_RESERVE_BEFORE_MIN) * 60_000,
    afterMs: Math.max(0, config.PROFILE_RESERVE_AFTER_MIN) * 60_000,
  };
}

/**
 * A repeatable schedule whose reservations cannot be planned: BullMQ knows the
 * repeat (cron), but no delayed job carries its data (typical for schedules
 * created before the profile infrastructure, or a template lost in a crash).
 * Such a schedule reserves NOTHING until its next job exists, so the UI must
 * say "unknown" instead of staying silent.
 */
export interface UnresolvedSchedule {
  key: string;
  /** Our `sched:<user>:<ts>:<name>` id when the repeat key still carries it (legacy keys). */
  scheduleId: string | null;
  name: string | null;
  cron: string;
  next: number | null;
  reason: 'no_template';
}

/** Overlap of two DIFFERENT workflows' reservations on one profile, for the UI. */
export interface OverlapView {
  leaseId: string;
  a: { owner: string; ownerName?: string; scheduleId?: string; start: number; end: number };
  b: { owner: string; ownerName?: string; scheduleId?: string; start: number; end: number };
}

export function overlapView(o: Overlap): OverlapView {
  const side = (r: Overlap['a']) => ({ owner: r.owner, ownerName: r.ownerName, scheduleId: r.scheduleId, start: r.start, end: r.end });
  return { leaseId: o.leaseId, a: side(o.a), b: side(o.b) };
}

/** Name segment of `sched:<user>:<ts>:<name>`. */
export function scheduleNameOf(id: string | null | undefined): string | null {
  const parts = String(id || '').split(':');
  return parts[0] === SCHEDULE_PREFIX && parts[3] ? parts.slice(3).join(':') : null;
}

/**
 * Which of OUR schedules is each repeatable? BullMQ 5.x no longer returns the
 * `jobId` we gave a repeatable (`sched:<user>:<ts>:<name>`) from
 * getRepeatableJobs(); the id survives only in the data of the schedule's next
 * job, linked by `repeatJobKey` = the repeatable's `key`. Older BullMQ (and
 * legacy keys) still carry `id`, which is used as the fallback.
 * Returns key -> schedule id; a repeatable with neither is absent.
 */
export async function scheduleIdsByKey(
  queue: Pick<Queue, 'getJobs'>,
  reps: Array<{ key: string; id?: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let jobs: Job[] = [];
  try { jobs = await queue.getJobs(['delayed', 'waiting', 'prioritized' as any, 'active'], 0, 1000); } catch { jobs = []; }
  for (const j of jobs || []) {
    const k = (j?.opts as { repeatJobKey?: string } | undefined)?.repeatJobKey || (j as unknown as { repeatJobKey?: string })?.repeatJobKey;
    const id = j?.data?.__scheduleId;
    if (k && typeof id === 'string' && id.startsWith(`${SCHEDULE_PREFIX}:`) && !out.has(k)) out.set(k, id);
  }
  for (const r of reps) {
    if (r.key && !out.has(r.key) && typeof r.id === 'string' && r.id.startsWith(`${SCHEDULE_PREFIX}:`)) out.set(r.key, r.id);
  }
  return out;
}

export type WorkflowLookup = (userId: string, workflowId: string) =>
  Promise<{ profileId?: string; name: string; active: boolean; steps: unknown[] } | null>;

export class ProfileCoordinator {
  constructor(
    private readonly queue: Queue,
    readonly leases: ProfileLeases,
    readonly reservations: ProfileReservations,
    readonly sessions: BrowserSessions,
    private readonly lookup: WorkflowLookup,
    private readonly localMode: (userId: string) => boolean,
  ) {}

  /** The lease id the runs of a schedule will take, or null (never leased). */
  leaseIdFor(userId: string, profileId: string | undefined, steps: unknown): string | null {
    const ref = resolveRunProfile({
      userId, profileId: runProfileIdOf(steps, profileId ?? null), usesExtensions: stepsUseExtensions(steps),
      localMode: this.localMode(userId), profilesDir: config.PROFILES_DIR, realChromeDir: config.REAL_CHROME_USER_DATA_DIR,
    });
    return needsLease(ref) ? ref.id : null;
  }

  /** Workflow ids with at least one schedule (a scheduled workflow is always active). */
  async scheduledWorkflowIds(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const b of await this.bindings().catch(() => [])) if (b.owner && !b.owner.startsWith('schedule:') && !b.owner.startsWith('job:')) out.add(b.owner);
    return out;
  }

  /** Every repeatable schedule -> the profile its runs will lease. Inactive workflows reserve nothing. */
  async bindings(): Promise<ScheduleBinding[]> {
    return (await this.scan()).bindings;
  }

  /**
   * Schedules that reserve nothing because their data cannot be found
   * (no delayed template job). Reported as "unknown", never as "free".
   */
  async unresolvedSchedules(): Promise<UnresolvedSchedule[]> {
    return (await this.scan()).unresolved;
  }

  /** Overlapping reservations of different workflows on one profile, right now. */
  async overlaps(): Promise<OverlapView[]> {
    return findOverlaps(await this.reservations.all()).map(overlapView);
  }

  private async scan(): Promise<{ bindings: ScheduleBinding[]; unresolved: UnresolvedSchedule[] }> {
    const out: ScheduleBinding[] = [];
    const unresolved: UnresolvedSchedule[] = [];
    const reps = await this.queue.getRepeatableJobs(0, -1);
    // The schedule's data lives on its next delayed job. BullMQ (5.x) links the
    // two by `repeatJobKey` = the repeatable's `key`; the repeatable entry no
    // longer carries the jobId we gave it, so our own `__scheduleId` in the
    // job data is what names the schedule.
    const templates = new Map<string, Job>();
    for (const j of await this.queue.getJobs(['delayed', 'waiting', 'prioritized' as any, 'active'], 0, 1000)) {
      const k = (j?.opts as { repeatJobKey?: string } | undefined)?.repeatJobKey || (j as unknown as { repeatJobKey?: string })?.repeatJobKey;
      if (k && !templates.has(k)) templates.set(k, j);
    }
    for (const r of reps) {
      if (!r.pattern) continue;
      const tpl = templates.get(r.key);
      const scheduleId = String(tpl?.data?.__scheduleId || r.id || '');
      if (!tpl) {
        // A repeat with no job carrying its data: we cannot know which
        // profile it will use, so nothing is reserved for it. Say so.
        const legacyId = r.id && String(r.id).startsWith(`${SCHEDULE_PREFIX}:`) ? String(r.id) : null;
        unresolved.push({ key: r.key, scheduleId: legacyId, name: scheduleNameOf(legacyId) || r.name || null, cron: r.pattern, next: r.next ?? null, reason: 'no_template' });
        continue;
      }
      if (!scheduleId.startsWith(`${SCHEDULE_PREFIX}:`)) continue;
      const userId = String(tpl.data?.userId || scheduleId.split(':')[1] || '');
      const data = tpl.data || {};
      let profileId: string | undefined = data.profileId;
      let steps: unknown = data.steps;
      let ownerName: string | undefined = data.__scheduleName;
      if (typeof data.__scheduleWorkflowId === 'string') {
        const wf = await this.lookup(userId, data.__scheduleWorkflowId).catch(() => null);
        if (!wf || !wf.active) continue;
        profileId = wf.profileId; steps = wf.steps; ownerName = wf.name;
      }
      const leaseId = this.leaseIdFor(userId, profileId, steps);
      if (!leaseId) continue;
      out.push({ scheduleId, owner: ownerOfJob(data, tpl.id || ''), ownerName, leaseId, cron: r.pattern, tz: r.tz || null });
    }
    return { bindings: out, unresolved };
  }

  /**
   * The reservation windows a cron WOULD create on `leaseId` within the
   * horizon, and the windows every OTHER schedule already reserves there.
   * Used before a schedule is saved, so a conflict is seen BEFORE run time.
   */
  async projectedConflicts(input: { owner: string; leaseId: string; cron: string; tz?: string | null; horizonMs?: number; now?: number }):
    Promise<Array<{ mine: { start: number; end: number }; other: { owner: string; ownerName?: string; start: number; end: number } }>> {
    const now = input.now ?? Date.now();
    const horizon = input.horizonMs ?? 24 * 3600_000;
    const w = reservationWindow();
    const mine = occurrences(input.cron, now, now + horizon, { tz: input.tz || null, max: 200 }).map((t) => windowOf(t, w));
    const others: Array<{ owner: string; ownerName?: string; start: number; end: number }> = [];
    for (const b of await this.bindings()) {
      if (b.leaseId !== input.leaseId || b.owner === input.owner) continue;
      for (const t of occurrences(b.cron, now - w.afterMs, now + horizon, { tz: b.tz || null, max: 200 })) {
        others.push({ owner: b.owner, ownerName: b.ownerName, ...windowOf(t, w) });
      }
    }
    const out: Array<{ mine: { start: number; end: number }; other: { owner: string; ownerName?: string; start: number; end: number } }> = [];
    for (const a of mine) for (const o of others) if (a.start < o.end && o.start < a.end) out.push({ mine: a, other: o });
    return out;
  }

  async syncReservations(opts: { now?: number; horizonMs?: number } = {}): Promise<{ created: number; dropped: number; overlaps: Overlap[] }> {
    return this.reservations.sync(await this.bindings(), reservationWindow(), opts);
  }

  probe(runningHere: (jobId: string) => boolean): QueueProbe {
    return {
      jobState: async (jobId) => {
        const j = await this.queue.getJob(jobId);
        if (!j) return { state: 'missing', finishedOn: null };
        return { state: await j.getState(), finishedOn: j.finishedOn ?? null };
      },
      occurrencePending: async (scheduleId, occurrence) => {
        for (const j of await this.queue.getJobs(['delayed', 'waiting', 'active', 'prioritized' as any], 0, 1000)) {
          if (j?.data?.__scheduleId === scheduleId && occurrenceOf(j) === occurrence) return true;
        }
        return false;
      },
      runningHere,
    };
  }

  /** Periodic: reservations from evidence, then browsers nobody depends on. */
  async sweep(runningHere: (jobId: string) => boolean, closeIdle: (s: SessionRecord) => Promise<void>, now = Date.now()) {
    await this.syncReservations({ now }).catch(() => null);
    const r = await this.reservations.sweep(this.probe(runningHere), { now });
    const idleMs = Math.max(0, config.BROWSER_IDLE_CLOSE_MIN) * 60_000;
    let idleClosed = 0;
    for (const s of this.sessions.idle(now, idleMs)) {
      if (!this.sessions.canClose(s.leaseId, '').ok) continue; // attached meanwhile
      await closeIdle(s).catch(() => {});
      idleClosed++;
    }
    return { ...r, idleClosed };
  }

  /**
   * Boot recovery (before the worker starts).
   *   leases / holds of an earlier incarnation: their browser died with it -> released.
   *   session records of an earlier incarnation: the browser is gone -> forgotten, reported.
   *   reservations are NOT touched: they are about time, not processes. A
   *   `fired` one is settled by sweep() only when the queue proves its run
   *   ended (BullMQ itself fails the stalled job of a dead worker).
   */
  async recoverAtBoot(): Promise<{ leases: string[]; holds: string[]; sessions: string[] }> {
    const leases = await this.leases.releaseOrphaned();
    const holds = await this.leases.releaseOrphanedHolds();
    const sessions: string[] = [];
    for (const s of await this.sessions.stale()) {
      await this.sessions.forgetStale(s.leaseId);
      sessions.push(s.leaseId);
    }
    return { leases, holds, sessions };
  }
}
