/**
 * ProfileLock — the decisions of the PROFILE LOCK (owner brief section 6), in
 * ONE pure place. The routes (lock / unlock, profile and branch delete) and
 * every workflow path that uses a profile (save, activation, scheduling,
 * import, duplicate, run) call these, so the rules cannot drift apart.
 *
 * WHAT THE LOCK IS, AND WHAT IT IS NOT (6.7; the owner decided: keep separate)
 *   lock          persistent, explicit, stored with the profile in the
 *                 registry (core/BranchRegistry `lockedTo`), survives restarts.
 *                 "This profile belongs to workflow W; nobody else may use it."
 *   run lease     Redis, while a run executes (core/ProfileLease).
 *   reservation   Redis, a time window around a scheduled run (core/ProfileReservations).
 *   operator hold Redis, a profile opened by hand in the panel.
 *   grant         Redis, explicit continuation of a session (phase 2).
 * They do not replace each other. How they interact:
 *   - a lock never creates, releases or extends a lease / reservation / hold;
 *   - a workflow that is NOT the owner is refused before it can take a lease
 *     or a reservation (save / activation / schedule / run all check here);
 *   - a manual open of a locked profile stays allowed, and the EXISTING
 *     reservation/lease rules decide (owner's run in progress or inside its
 *     reservation window -> refused by them, unchanged) — 6.6 "Manual open".
 */

export interface LockWorkflowView {
  workflowId: string;
  name: string;
  state: 'inactive' | 'active' | 'scheduled' | 'running';
  /** Every profile id the workflow's runs may use (setting + Launch nodes). */
  profileIds: string[];
}

export interface LockedProfileView { id: string; name: string; lockedTo?: { workflowId: string } | null }

export type LockDecision =
  | { ok: true }
  | { ok: false; code: 'workflow_not_found' | 'already_locked' | 'referenced_by_others'; message: string;
      blocking?: Array<{ workflowId: string; name: string; state: LockWorkflowView['state'] }> };

/**
 * 6.2: may `profile` be locked to `owner`? Blocked while OTHER active or
 * scheduled (or running) workflows reference it — they are listed by name so
 * the UI can offer "Reassign to…". Inactive references are allowed (they fail
 * at activation with "profile locked to <workflow>").
 */
export function canLock(profile: LockedProfileView, ownerId: string, workflows: LockWorkflowView[]): LockDecision {
  const owner = workflows.find((w) => w.workflowId === ownerId);
  if (!owner) return { ok: false, code: 'workflow_not_found', message: 'That workflow does not exist.' };
  const cur = profile.lockedTo?.workflowId;
  if (cur && cur !== ownerId) {
    const other = workflows.find((w) => w.workflowId === cur);
    return { ok: false, code: 'already_locked', message: `"${profile.name}" is already locked to "${other?.name || cur}".` };
  }
  const blocking = workflows
    .filter((w) => w.workflowId !== ownerId && w.state !== 'inactive' && w.profileIds.includes(profile.id))
    .map((w) => ({ workflowId: w.workflowId, name: w.name, state: w.state }));
  if (blocking.length) {
    return { ok: false, code: 'referenced_by_others', blocking,
      message: `"${profile.name}" is used by ${blocking.map((b) => `"${b.name}" (${b.state})`).join(', ')}. Reassign them to another profile first.` };
  }
  return { ok: true };
}

export type UnlockDecision =
  | { ok: true; needsConfirmation: false }
  | { ok: true; needsConfirmation: true; owner: { workflowId: string; name: string; state: LockWorkflowView['state'] }; message: string }
  | { ok: false; code: 'owner_running'; message: string };

/**
 * 6.3: unlocking. Owner running -> blocked ("stop it first"). Owner active or
 * scheduled -> a plain confirmation naming it. Otherwise (inactive, or the
 * owner no longer exists) -> free.
 */
export function canUnlock(profile: LockedProfileView, workflows: LockWorkflowView[]): UnlockDecision {
  const cur = profile.lockedTo?.workflowId;
  if (!cur) return { ok: true, needsConfirmation: false };
  const owner = workflows.find((w) => w.workflowId === cur);
  if (!owner || owner.state === 'inactive') return { ok: true, needsConfirmation: false };
  if (owner.state === 'running') return { ok: false, code: 'owner_running', message: `"${owner.name}" is running and owns this lock. Stop it first.` };
  return { ok: true, needsConfirmation: true, owner: { workflowId: owner.workflowId, name: owner.name, state: owner.state },
    message: `"${profile.name}" is locked to "${owner.name}" (${owner.state}). Unlock it?` };
}

export interface LockViolation { profileId: string; profileName: string; ownerId: string; ownerName: string; message: string }

/**
 * 6.5: the one check for "may workflow `workflowId` use these profiles?" —
 * used by save, activation, scheduling, import, duplicate and run. A profile
 * locked to ANOTHER workflow is a violation ("profile locked to <workflow>").
 * `workflowId` null = a run that is not a saved workflow (ad-hoc /run): any
 * locked profile is a violation.
 */
export function lockViolations(
  workflowId: string | null,
  profileIds: string[],
  profiles: LockedProfileView[],
  nameOfWorkflow: (id: string) => string | undefined,
): LockViolation[] {
  const out: LockViolation[] = [];
  for (const id of new Set(profileIds)) {
    const p = profiles.find((x) => x.id === id);
    const owner = p?.lockedTo?.workflowId;
    if (!p || !owner || owner === workflowId) continue;
    const ownerName = nameOfWorkflow(owner) || owner;
    out.push({ profileId: p.id, profileName: p.name, ownerId: owner, ownerName,
      message: `Profile "${p.name}" is locked to "${ownerName}"` });
  }
  return out;
}

/** Error carrying the violations; routes answer 409 code 'profile_locked'. */
export class ProfileLockedError extends Error {
  readonly code = 'profile_locked';
  constructor(readonly violations: LockViolation[]) {
    super(violations.map((v) => v.message).join('; ') + '.');
    this.name = 'ProfileLockedError';
  }
}
