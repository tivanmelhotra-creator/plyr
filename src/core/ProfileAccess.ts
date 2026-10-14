/**
 * ProfileAccess — one answer to "what is the state of this profile, and may
 * this requester use / delete it?", built from four separate records:
 *
 *   ProfileRegistry      identity + name                   (disk)
 *   ProfileLeases        run lease, operator hold, grants  (Redis, atomic)
 *   ProfileReservations  scheduled windows                 (Redis)
 *   BrowserSessions      live browser + its dependents     (memory, mirrored)
 *
 * Every surface (Workflow Files drawer, Workflow Settings, the worker's log)
 * asks HERE, so a profile never looks free in one place and busy in another.
 */
import { DEFAULT_PROFILE_ID, ProfileRegistry, type ProfileEntry } from './ProfileRegistry';
import {
  leaseIdOf, type DenyReason, type HoldRecord, type LeaseRecord, type ProfileLeases, type ReservationLike,
} from './ProfileLease';
import { blockingUntil, type ProfileReservations, type Reservation } from './ProfileReservations';
import { runningProfileOf, type BrowserSessions, type SessionRecord } from './BrowserSessions';

export type ProfileStatus = 'free' | 'reserved' | 'in_use' | 'needs_review';

export interface WorkflowRef { id: string; name: string; profileId: string }

export interface ProfileView {
  id: string;
  name: string;
  builtIn: boolean;
  /** The branch (Chromium root) this profile lives in (core/BranchRegistry). */
  branchId?: string;
  branchLabel?: string;
  /** Another profile of the SAME branch is running now: this one cannot open until it stops. */
  branchBusyWith?: { id: string; name: string } | null;
  status: ProfileStatus;
  /** Can the requesting owner claim it right now? */
  available: boolean;
  denyReason?: DenyReason | null;
  /** Human sentence for the UI. Never contains secrets or filesystem paths. */
  explanation?: string | null;
  lease?: { jobId: string; owner?: string; ownerName?: string; since: number } | null;
  hold?: { owner: string; ownerName?: string; until: number; mine: boolean } | null;
  reservation?: { owner: string; ownerName?: string; start: number; end: number; state: string; blockingUntil: number | null } | null;
  nextReservation?: { owner: string; ownerName?: string; start: number; end: number } | null;
  browser: { open: boolean; visibility?: string; dependents: number; startedAt?: number; lastActivity?: number };
  usedBy: Array<{ workflowId: string; name: string }>;
  problem?: string | null;
  lastOpenError?: { at: string; message: string } | null;
  /** Tabs saved before the last automatic close (count only), for "Restore tabs". */
  lastSession?: { savedAt: string; tabs: number; reason: string } | null;
  /** Schedules of different workflows whose reservations overlap on this profile (set by the route). */
  overlaps?: Array<{ message: string; a: { owner: string; ownerName?: string; start: number; end: number }; b: { owner: string; ownerName?: string; start: number; end: number } }>;
}

/** Pure: the status the user sees. Unknown / broken never reads as free. */
export function deriveStatus(input: {
  problem?: string | null;
  lastOpenError?: unknown;
  lease?: LeaseRecord | null;
  hold?: HoldRecord | null;
  activeReservation?: Reservation | null;
  session?: SessionRecord | null;
}): ProfileStatus {
  if (input.problem) return 'needs_review';
  if (input.lease || input.hold) return 'in_use';
  if (input.session && input.session.dependents.length) return 'in_use';
  if (input.activeReservation) return 'reserved';
  if (input.lastOpenError) return 'needs_review';
  return 'free';
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + ' UTC';

/** Pure: why a profile is not available, in one sentence. */
export function explainDenial(reason: DenyReason | null | undefined, d: {
  lease?: { ownerName?: string; jobId?: string } | null;
  hold?: { ownerName?: string; until?: number } | null;
  reservation?: { ownerName?: string; start: number; end: number } | null;
}): string | null {
  switch (reason) {
    case 'in_use':
      return `In use by a run${d.lease?.ownerName ? ` of "${d.lease.ownerName}"` : ''}${d.lease?.jobId ? ` (run ${d.lease.jobId})` : ''}.`;
    case 'held':
      return `Opened by hand for "${d.hold?.ownerName || 'another workflow'}"${d.hold?.until ? ` until ${hhmm(d.hold.until)}` : ''}.`;
    case 'reserved':
      return d.reservation
        ? `Reserved for the scheduled run of "${d.reservation.ownerName || 'another workflow'}" (${hhmm(d.reservation.start)}–${hhmm(d.reservation.end)}, longer if that run is still going).`
        : 'Reserved for a scheduled run of another workflow.';
    case 'reserved_soon':
      return d.reservation
        ? `A scheduled run of "${d.reservation.ownerName || 'another workflow'}" reserves it from ${hhmm(d.reservation.start)}.`
        : 'A scheduled run of another workflow reserves it shortly.';
    default:
      return null;
  }
}

export interface DeleteBlocker { kind: 'lease' | 'hold' | 'browser' | 'reservation' | 'referenced' | 'builtin'; detail: string }

export class ProfileAccess {
  constructor(
    readonly registry: ProfileRegistry,
    readonly leases: ProfileLeases,
    readonly reservations: ProfileReservations,
    readonly sessions: BrowserSessions,
  ) {}

  /** Views of every profile for `owner`; adopts profiles referenced by workflows. */
  async views(userId: string, owner: string, workflows: WorkflowRef[]): Promise<ProfileView[]> {
    // Branch model: the registry adopts every pre-branch root ONCE, in place.
    // A workflow reference to an id that is not there is NOT silently created
    // (it is reported as missing by the activation check instead).
    const all = await this.registry.list(userId);
    const out: ProfileView[] = [];
    for (const p of all) out.push(await this.viewOf(p, owner, workflows, all));
    return out;
  }

  async view(userId: string, id: string, owner: string, workflows: WorkflowRef[]): Promise<ProfileView | null> {
    const p = await this.registry.get(userId, id);
    return p ? this.viewOf(p, owner, workflows) : null;
  }

  private async viewOf(p: ProfileEntry, owner: string, workflows: WorkflowRef[], all: ProfileEntry[] = []): Promise<ProfileView> {
    const names = new Map(workflows.map((w) => [w.id, w.name] as const));
    const nameOf = (o?: string | null): string | undefined => (o ? names.get(o) : undefined);
    const leaseId = leaseIdOf(p.id);
    const now = Date.now();
    const [lease, hold, resv, adm] = await Promise.all([
      this.leases.holder(leaseId), this.leases.holdOf(leaseId), this.reservations.list(leaseId), this.leases.check(leaseId, owner),
    ]);
    const session = this.sessions.get(leaseId);
    const active = resv.find((r) => r.state !== 'missed' && r.start <= now && now < blockingUntil(r)) || null;
    const next = resv.filter((r) => r.state === 'planned' && r.start > now)[0] || null;
    const denyReason = adm.ok ? null : adm.reason;
    const named = (r: ReservationLike | null | undefined) => (r ? { ...r, ownerName: r.ownerName || nameOf(r.owner) } : null);
    const runningId = session ? runningProfileOf(leaseId) : null;
    const busyWith = runningId && runningId !== p.id ? (all.find((x) => x.id === runningId) || { id: runningId, name: runningId }) : null;
    return {
      id: p.id,
      name: p.name,
      builtIn: p.builtIn,
      branchId: p.branchId,
      branchLabel: p.branchLabel,
      branchBusyWith: busyWith ? { id: busyWith.id, name: busyWith.name } : null,
      status: deriveStatus({ problem: p.problem, lastOpenError: p.lastOpenError, lease, hold, activeReservation: active, session }),
      available: adm.ok && !p.problem,
      denyReason: p.problem ? null : denyReason,
      explanation: p.problem
        ? `Needs review: ${p.problem}`
        : explainDenial(denyReason, {
          lease: lease ? { ownerName: nameOf(lease.owner), jobId: lease.jobId } : null,
          hold: hold ? { ownerName: nameOf(hold.owner), until: hold.expiresAt } : null,
          reservation: !adm.ok ? named(adm.reservation) : null,
        }),
      lease: lease ? { jobId: lease.jobId, owner: lease.owner, ownerName: nameOf(lease.owner), since: lease.acquiredAt } : null,
      hold: hold ? { owner: hold.owner, ownerName: nameOf(hold.owner), until: hold.expiresAt, mine: hold.owner === owner } : null,
      reservation: active ? {
        owner: active.owner, ownerName: active.ownerName || nameOf(active.owner), start: active.start, end: active.end, state: active.state,
        blockingUntil: Number.isFinite(blockingUntil(active)) ? blockingUntil(active) : null,
      } : null,
      nextReservation: next ? { owner: next.owner, ownerName: next.ownerName || nameOf(next.owner), start: next.start, end: next.end } : null,
      browser: session && !busyWith
        ? { open: true, visibility: session.visibility, dependents: session.dependents.length, startedAt: session.startedAt, lastActivity: session.lastActivity }
        : { open: false, dependents: 0 },
      usedBy: workflows.filter((w) => (w.profileId || DEFAULT_PROFILE_ID) === p.id).map((w) => ({ workflowId: w.id, name: w.name })),
      problem: p.problem ?? null,
      lastOpenError: p.lastOpenError ?? null,
    };
  }

  /** Everything that makes deleting a profile unsafe. Empty = may delete. */
  async deleteBlockers(id: string, workflows: WorkflowRef[]): Promise<DeleteBlocker[]> {
    const out: DeleteBlocker[] = [];
    if (id === DEFAULT_PROFILE_ID) out.push({ kind: 'builtin', detail: 'The default profile cannot be deleted.' });
    const leaseId = leaseIdOf(id);
    const lease = await this.leases.holder(leaseId);
    if (lease) out.push({ kind: 'lease', detail: `A run (${lease.jobId}) is using it.` });
    if (await this.leases.holdOf(leaseId)) out.push({ kind: 'hold', detail: 'It is opened by hand (release it first).' });
    if (this.sessions.get(leaseId)) out.push({ kind: 'browser', detail: 'Its browser is open (close it first).' });
    const pending = await this.reservations.pending(leaseId);
    if (pending.length) out.push({ kind: 'reservation', detail: `${pending.length} scheduled run(s) reserve it.` });
    const refs = workflows.filter((w) => w.profileId === id);
    if (refs.length) out.push({ kind: 'referenced', detail: `Used by: ${refs.map((r) => r.name).join(', ')}.` });
    return out;
  }
}

let active: ProfileAccess | null = null;
export function registerProfileAccess(a: ProfileAccess): void { active = a; }
export function profileAccess(): ProfileAccess | null { return active; }
