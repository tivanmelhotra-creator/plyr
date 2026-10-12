/**
 * BrowserLifecycle — what happens to a run's browser when the run ends.
 *
 * Workflow Settings → "After the run": `keep` (default, the existing
 * behaviour: the profile browser stays up for inspection and for the next run
 * on the same profile; the idle collector closes it later) or `close`.
 *
 *   outcome   policy=keep   policy=close
 *   success   keep          close, if safe
 *   error     keep          keep (the failure can be inspected; idle closes it)
 *   timeout   keep          keep (same reason)
 *   cancelled keep          close, if safe (the operator asked to stop)
 *
 * "If safe" = no dependent other than this run (core/BrowserSessions), and
 * the browser is the run's own (never local mode / Real Chrome). Closing
 * NEVER releases the lease, hold or reservation: those are released by their
 * own owners.
 *
 * Pure. The worker applies the decision.
 */
export type AfterRunPolicy = 'keep' | 'close';
export type RunOutcome = 'success' | 'error' | 'timeout' | 'cancelled';

export function afterRunPolicyOf(v: unknown): AfterRunPolicy {
  return v === 'close' ? 'close' : 'keep';
}

export interface AfterRunInput {
  policy: AfterRunPolicy;
  outcome: RunOutcome;
  /** The browser is ours (not the operator's local Chrome, not Real Chrome). */
  ownBrowser: boolean;
  /** Dependents of the session other than this run. */
  otherDependents: string[];
  sessionOpen: boolean;
}

export type AfterRunDecision =
  | { action: 'close' }
  | { action: 'keep'; why: 'policy' | 'inspect' | 'shared' | 'in_use' | 'not_open' };

export function decideAfterRun(i: AfterRunInput): AfterRunDecision {
  if (!i.sessionOpen) return { action: 'keep', why: 'not_open' };
  if (!i.ownBrowser) return { action: 'keep', why: 'shared' };
  if (i.policy === 'keep') return { action: 'keep', why: 'policy' };
  if (i.outcome === 'error' || i.outcome === 'timeout') return { action: 'keep', why: 'inspect' };
  if (i.otherDependents.length) return { action: 'keep', why: 'in_use' };
  return { action: 'close' };
}

/** Classify an error message from the pipeline into a run outcome. */
export function outcomeOfError(message: string, cancelled: boolean): RunOutcome {
  if (cancelled || message === 'CANCELLED_BY_USER') return 'cancelled';
  if (/timed? ?out|timeout|Safety Stop/i.test(message)) return 'timeout';
  return 'error';
}
