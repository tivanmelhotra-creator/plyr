/**
 * BranchPolicy — the decisions about branches that span several records:
 *
 *   profileProblems()   activation / schedule / run: is every referenced
 *                       profile usable? (record, branch, folder on disk)
 *   deletionScan()      deleting a branch: every profile in it, its state, and
 *                       every workflow that references it, with the verdict
 *   scheduleConflicts() saving a schedule: overlaps with schedules of OTHER
 *                       workflows on profiles of the SAME branch
 *
 * Pure decisions over inputs the routes collect (registry, leases,
 * reservations, sessions, workflows), so they are testable without Redis.
 *
 * Workflow state (owner's definition): "active" = enabled, whether manual or
 * scheduled. A workflow with a schedule is always active. Only inactive
 * workflows may keep a reference into a branch that is being deleted (their
 * reference is cleared, their state becomes "profile missing").
 */
import type { BranchRegistry, ProfileEntry } from './BranchRegistry';
import { reasonOf, type FailureDetail, type FailureReason } from './ProfileFailureReports';

export interface WorkflowUse {
  workflowId: string;
  name: string;
  active: boolean;
  scheduled: boolean;
  running: boolean;
  /** Every profile id the workflow's runs may use (workflow setting + Launch nodes). */
  profileIds: string[];
}

export interface ProfileProblem {
  profileId: string;
  profileName?: string | null;
  reason: FailureReason;
  detail: FailureDetail;
  message: string;
}

/** Every referenced profile that cannot be used. Never creates anything. */
export async function profileProblems(registry: BranchRegistry, userId: string, profileIds: string[]): Promise<ProfileProblem[]> {
  const out: ProfileProblem[] = [];
  for (const id of [...new Set(profileIds.filter(Boolean))]) {
    const c = await registry.check(userId, id);
    if (c.ok) continue;
    const entry = await registry.get(userId, id).catch(() => null);
    out.push({
      profileId: id, profileName: entry?.name ?? null,
      reason: reasonOf(c.reason), detail: c.reason,
      message: `Profile "${entry?.name || id}": ${c.detail}`,
    });
  }
  return out;
}

export type ProfileState = 'free' | 'reserved' | 'running';

export interface DeletionProfileRow {
  profileId: string;
  name: string;
  state: ProfileState;
  workflows: Array<{ workflowId: string; name: string; state: 'inactive' | 'active' | 'scheduled' | 'running' }>;
}

export interface DeletionScan {
  branchId: string;
  label: string;
  profiles: DeletionProfileRow[];
  /** Active / scheduled workflows that must be reassigned first. */
  blockingWorkflows: Array<{ workflowId: string; name: string; profileId: string; profileName: string; state: 'active' | 'scheduled' | 'running' }>;
  /** Profiles running right now (stop them first). */
  runningProfiles: Array<{ profileId: string; name: string }>;
  /** Inactive workflows whose reference will be cleared ("profile missing"). */
  inactiveWorkflows: Array<{ workflowId: string; name: string; profileId: string }>;
  builtIn: boolean;
  /** May the branch be deleted right now? */
  deletable: boolean;
}

export function workflowStateOf(w: WorkflowUse): 'inactive' | 'active' | 'scheduled' | 'running' {
  if (w.running) return 'running';
  if (w.scheduled) return 'scheduled';
  return w.active ? 'active' : 'inactive';
}

/**
 * Pure: the dependency scan of one branch. `running` = the branch has a live
 * browser or a run lease; `reserved` = a scheduled reservation is in force.
 */
export function scanBranch(input: {
  branchId: string; label: string; builtIn: boolean;
  profiles: ProfileEntry[];
  workflows: WorkflowUse[];
  branchRunning: boolean;
  runningProfileId: string | null;
  branchReserved: boolean;
}): DeletionScan {
  const rows: DeletionProfileRow[] = [];
  const blocking: DeletionScan['blockingWorkflows'] = [];
  const inactive: DeletionScan['inactiveWorkflows'] = [];
  const running: DeletionScan['runningProfiles'] = [];
  for (const p of input.profiles) {
    const isRunning = input.branchRunning && (!input.runningProfileId || input.runningProfileId === p.id);
    const users = input.workflows.filter((w) => w.profileIds.includes(p.id));
    const state: ProfileState = isRunning ? 'running' : input.branchReserved && users.some((w) => w.scheduled) ? 'reserved' : 'free';
    rows.push({ profileId: p.id, name: p.name, state, workflows: users.map((w) => ({ workflowId: w.workflowId, name: w.name, state: workflowStateOf(w) })) });
    if (isRunning) running.push({ profileId: p.id, name: p.name });
    for (const w of users) {
      const st = workflowStateOf(w);
      if (st === 'inactive') inactive.push({ workflowId: w.workflowId, name: w.name, profileId: p.id });
      else blocking.push({ workflowId: w.workflowId, name: w.name, profileId: p.id, profileName: p.name, state: st });
    }
  }
  return {
    branchId: input.branchId, label: input.label, profiles: rows,
    blockingWorkflows: blocking, runningProfiles: running, inactiveWorkflows: inactive,
    builtIn: input.builtIn,
    deletable: !input.builtIn && blocking.length === 0 && running.length === 0 && !input.branchRunning,
  };
}

export interface ScheduleWindow { owner: string; ownerName?: string; leaseKey: string; start: number; end: number }

/**
 * Pure: windows of a schedule being saved (`mine`) that overlap windows of
 * OTHER workflows on the SAME branch lock. Same-owner overlaps are its own
 * runs (they queue on the lease anyway).
 */
export function scheduleConflicts(mine: ScheduleWindow[], others: ScheduleWindow[]): Array<{ mine: ScheduleWindow; other: ScheduleWindow }> {
  const out: Array<{ mine: ScheduleWindow; other: ScheduleWindow }> = [];
  for (const a of mine) {
    for (const b of others) {
      if (b.owner === a.owner || b.leaseKey !== a.leaseKey) continue;
      if (a.start < b.end && b.start < a.end) out.push({ mine: a, other: b });
    }
  }
  return out;
}
