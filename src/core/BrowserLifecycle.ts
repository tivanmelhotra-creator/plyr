/**
 * BrowserLifecycle — what happens to a run's browser when the run ends.
 *
 * Workflow setting "Keep browser open after completion" (`afterRun`):
 * `close` is the DEFAULT (owner's decision, phase 1), `keep` keeps it.
 *
 *   outcome   afterRun=close (default)   afterRun=keep
 *   success   close, if safe             keep
 *   cancelled close, if safe             keep
 *   error     close, if safe             close, if safe
 *   timeout   close, if safe             close, if safe
 *
 * Error / timeout: the run's status and the state needed for diagnosis
 * (tabs + storage, core/BrowserStateSnapshot) are recorded first by the
 * worker, then the browser is closed, so no orphan process is left. "Keep"
 * is honoured only after success / cancel.
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
  return v === 'keep' ? 'keep' : 'close';
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
  | { action: 'keep'; why: 'policy' | 'shared' | 'in_use' | 'not_open' };

export function decideAfterRun(i: AfterRunInput): AfterRunDecision {
  if (!i.sessionOpen) return { action: 'keep', why: 'not_open' };
  if (!i.ownBrowser) return { action: 'keep', why: 'shared' };
  if (i.otherDependents.length) return { action: 'keep', why: 'in_use' };
  const failed = i.outcome === 'error' || i.outcome === 'timeout';
  if (i.policy === 'keep' && !failed) return { action: 'keep', why: 'policy' };
  return { action: 'close' };
}

/** Classify an error message from the pipeline into a run outcome. */
export function outcomeOfError(message: string, cancelled: boolean): RunOutcome {
  if (cancelled || message === 'CANCELLED_BY_USER') return 'cancelled';
  if (/timed? ?out|timeout|Safety Stop/i.test(message)) return 'timeout';
  return 'error';
}
