/**
 * SessionContinuation — "continue this browser session in another workflow"
 * (phase 2, the Continue Session node). Built ONLY from the existing pieces:
 *
 *   ProfileLeases.grant(profile, fromOwner, toOwner, ttl)   the permission
 *   BrowserSessions dependent `grant:<toOwner>`             keeps the browser
 *
 * Nothing is transferred implicitly:
 *   - only the RUN that holds the profile's lease can grant (its lease token is
 *     the proof), and only from its own owner (its workflow id, decided by the
 *     worker — never by a node parameter);
 *   - the target must be another existing workflow of the SAME user;
 *   - the grant expires by itself (ttl) and is consumed (revoked) when the
 *     target's run on that profile ends; an unused one is dropped by the sweep;
 *   - the target only benefits if its run uses the SAME profile.
 *
 * While the grant lives the browser has the dependent `grant:<to>`, so the
 * after-run close and the idle collector leave it open: the target finds the
 * same tabs, cookies and page.
 */
import type { ProfileLeases } from './ProfileLease';
import type { BrowserSessions } from './BrowserSessions';

export const GRANT_DEPENDENT_PREFIX = 'grant:';
export const grantDependent = (toOwner: string): string => `${GRANT_DEPENDENT_PREFIX}${toOwner}`;

export const MIN_TTL_MS = 60_000;
export const MAX_TTL_MS = 6 * 3600_000;
export const DEFAULT_TTL_MS = 15 * 60_000;

export type ContinueResult =
  | { ok: true; to: string; until: number }
  | { ok: false; reason: 'no_lease' | 'same_workflow' | 'unknown_workflow' | 'invalid_target' | 'no_browser' | 'not_profile'; message: string };

export function clampTtl(ms: unknown): number {
  const n = typeof ms === 'number' ? ms : parseInt(String(ms ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(n)));
}

// Registered by index.ts (owner of the workflow store), so the pipeline can
// check a target workflow without importing the services layer.
let workflowLookup: ((userId: string, workflowId: string) => Promise<boolean>) | null = null;
export function registerWorkflowLookup(fn: (userId: string, workflowId: string) => Promise<boolean>): void { workflowLookup = fn; }
export function workflowExistsRegistered(userId: string, workflowId: string): Promise<boolean> {
  return workflowLookup ? workflowLookup(userId, workflowId).catch(() => false) : Promise.resolve(false);
}

export interface ContinueDeps {
  leases: ProfileLeases;
  sessions: BrowserSessions;
  workflowExists: (userId: string, workflowId: string) => Promise<boolean>;
  isValidWorkflowId: (id: string) => boolean;
}

export async function continueSession(deps: ContinueDeps, input: {
  userId: string;
  /** Lease id of the run's profile; null for local / Real Chrome / no lease. */
  leaseId: string | null;
  /** This run's lease token: proves the caller IS the run holding the profile. */
  leaseToken: string | null;
  jobId: string;
  /** The run's owner (its workflow id), from the worker. */
  fromOwner: string;
  toWorkflowId: unknown;
  ttlMs: unknown;
}): Promise<ContinueResult> {
  const to = typeof input.toWorkflowId === 'string' ? input.toWorkflowId.trim() : '';
  if (!input.leaseId || !input.leaseToken) {
    return { ok: false, reason: 'not_profile', message: 'This run has no browser profile of its own (local browser or Real Chrome); there is no session to continue.' };
  }
  if (!to || !deps.isValidWorkflowId(to)) return { ok: false, reason: 'invalid_target', message: 'Pick the workflow that should continue this session.' };
  if (to === input.fromOwner) return { ok: false, reason: 'same_workflow', message: 'A workflow already shares its own session; choose another workflow.' };
  const holder = await deps.leases.holder(input.leaseId);
  if (!holder || holder.token !== input.leaseToken || holder.jobId !== input.jobId) {
    return { ok: false, reason: 'no_lease', message: 'Only the run that holds the profile can hand its session over.' };
  }
  if (!(await deps.workflowExists(input.userId, to))) {
    return { ok: false, reason: 'unknown_workflow', message: 'The target workflow does not exist.' };
  }
  if (!deps.sessions.get(input.leaseId)) {
    return { ok: false, reason: 'no_browser', message: 'The browser of this profile is not open; launch it before continuing the session.' };
  }
  const ttl = clampTtl(input.ttlMs);
  await deps.leases.grant(input.leaseId, input.fromOwner, to, ttl);
  deps.sessions.attach(input.leaseId, grantDependent(to));
  return { ok: true, to, until: Date.now() + ttl };
}

/** The run of `owner` on `leaseId` ended: grants TO it are consumed; the browser stops waiting for it. */
export async function endContinuation(deps: Pick<ContinueDeps, 'leases' | 'sessions'>, leaseId: string, owner: string): Promise<number> {
  const n = await deps.leases.revokeGrantsTo(leaseId, owner).catch(() => 0);
  deps.sessions.detach(leaseId, grantDependent(owner));
  return n;
}

/** Sweep: `grant:<to>` dependents whose grant expired unused are detached. */
export async function sweepExpiredGrants(deps: Pick<ContinueDeps, 'leases' | 'sessions'>, now = Date.now()): Promise<number> {
  let n = 0;
  for (const s of deps.sessions.list()) {
    const grantDeps = s.dependents.filter((d) => d.startsWith(GRANT_DEPENDENT_PREFIX));
    if (!grantDeps.length) continue;
    const live = new Set((await deps.leases.grants(s.leaseId, now).catch(() => [])).map((g) => g.to));
    for (const d of grantDeps) {
      if (!live.has(d.slice(GRANT_DEPENDENT_PREFIX.length))) { deps.sessions.detach(s.leaseId, d); n++; }
    }
  }
  return n;
}
