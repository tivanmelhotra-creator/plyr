import type { AutomationStep } from '../types';

/**
 * ErrorPolicy — pure, dependency-free error-handling core (n8n-grade).
 *
 * Mirrors n8n's per-node error settings:
 *   - Continue On Fail: swallow the error, push an error item, keep going.
 *   - Retry On Fail: re-run the node up to `maxTries` times with a wait.
 *   - Stop And Error: a dedicated node action that throws on purpose.
 *   - Error Trigger data shape: the payload an Error Trigger workflow receives.
 *
 * This module is intentionally free of Playwright / pipeline imports so it
 * can be unit-tested in a plain `node` environment.
 */

export const MAX_RETRY_TRIES = 10;
export const MAX_RETRY_WAIT_MS = 300000;
export const DEFAULT_RETRY_WAIT_MS = 1000;

export type RetryOn = 'any' | 'error' | 'timeout';
export type RetryBackoff = 'fixed' | 'linear' | 'exponential';
export type FailureKind = 'error' | 'timeout';

export interface ResolvedErrorPolicy {
  continueOnFail: boolean;
  retryOnFail: boolean;
  maxTries: number;
  waitBetweenTriesMs: number;
  /** Which failures are retried (phase 2: per-node retry policy). Default any. */
  retryOn: RetryOn;
  /** How the wait grows between tries. Default linear (the historical behaviour). */
  backoff: RetryBackoff;
  /** Per-node timeout in ms (0 = the server default STEP_TIMEOUT_MS / Playwright's). */
  timeoutMs: number;
}

export const MAX_NODE_TIMEOUT_MS = 30 * 60_000;

/**
 * Error or timeout? One rule for the retry policy, the Error / Timeout outputs
 * and the run outcome (core/BrowserLifecycle.outcomeOfError uses the same words).
 */
export function failureKindOf(err: unknown): FailureKind {
  const e = err as { name?: unknown; message?: unknown } | null;
  if (e && e.name === 'TimeoutError') return 'timeout';
  const msg = String((e && e.message) ?? err ?? '');
  return /timed? ?out|timeout|exceeded while waiting/i.test(msg) ? 'timeout' : 'error';
}

/** Does this policy retry a failure of this kind? */
export function retriesKind(policy: Pick<ResolvedErrorPolicy, 'retryOn'>, kind: FailureKind): boolean {
  return policy.retryOn === 'any' || policy.retryOn === kind;
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Resolve a step's raw error fields into a clean, clamped policy object.
 * Tolerates missing/garbage input.
 */
export function normalizeErrorPolicy(step: Partial<AutomationStep> | null | undefined): ResolvedErrorPolicy {
  const s = (step || {}) as AutomationStep;
  const retryOnFail = toBool(s.retryOnFail);

  let maxTries = toInt(s.maxTries, retryOnFail ? 3 : 1);
  if (maxTries < 1) maxTries = 1;
  maxTries = clamp(maxTries, 1, MAX_RETRY_TRIES);

  let waitBetweenTriesMs = toInt(s.waitBetweenTriesMs, DEFAULT_RETRY_WAIT_MS);
  if (waitBetweenTriesMs < 0) waitBetweenTriesMs = 0;
  waitBetweenTriesMs = clamp(waitBetweenTriesMs, 0, MAX_RETRY_WAIT_MS);

  const ro = (s as { retryOn?: unknown }).retryOn;
  const bo = (s as { retryBackoff?: unknown }).retryBackoff;
  let timeoutMs = toInt((s as { timeoutMs?: unknown }).timeoutMs, 0);
  if (timeoutMs < 0) timeoutMs = 0;
  timeoutMs = clamp(timeoutMs, 0, MAX_NODE_TIMEOUT_MS);

  return {
    continueOnFail: toBool(s.continueOnFail),
    retryOnFail,
    maxTries: retryOnFail ? maxTries : 1,
    waitBetweenTriesMs,
    retryOn: ro === 'error' || ro === 'timeout' ? ro : 'any',
    backoff: bo === 'fixed' || bo === 'exponential' ? bo : 'linear',
    timeoutMs,
  };
}

/** Wait before the next try, for a backoff mode. `attempt` is 1-based. */
export function backoffDelayMs(attempt: number, baseMs: number, mode: RetryBackoff): number {
  const a = Math.max(1, toInt(attempt, 1));
  const base = clamp(toInt(baseMs, DEFAULT_RETRY_WAIT_MS), 0, MAX_RETRY_WAIT_MS);
  if (mode === 'fixed') return base;
  if (mode === 'exponential') return clamp(base * Math.pow(2, a - 1), 0, MAX_RETRY_WAIT_MS);
  return retryDelayMs(a, base);
}

/**
 * Should we attempt another try? `attempt` is 1-based (1 = first run done).
 */
export function shouldRetry(attempt: number, maxTries: number): boolean {
  if (!Number.isFinite(attempt) || !Number.isFinite(maxTries)) return false;
  return attempt >= 1 && attempt < maxTries;
}

/**
 * Linear backoff: attempt * baseMs, clamped to [0, MAX_RETRY_WAIT_MS].
 */
export function retryDelayMs(attempt: number, baseMs: number): number {
  const a = Math.max(1, toInt(attempt, 1));
  const base = clamp(toInt(baseMs, DEFAULT_RETRY_WAIT_MS), 0, MAX_RETRY_WAIT_MS);
  return clamp(a * base, 0, MAX_RETRY_WAIT_MS);
}

/**
 * Is this step the dedicated Stop-And-Error node?
 */
export function isStopAndError(step: Partial<AutomationStep> | null | undefined): boolean {
  const a = (step && (step as AutomationStep).action) || '';
  return a === 'stop_and_error' || a === 'stop-and-error' || a === 'stopAndError';
}

export interface ErrorTriggerData {
  execution: {
    error: { message: string; stack?: string; name?: string };
    lastNodeExecuted: string;
    mode: string;
  };
  workflow: { id: string; name: string };
}

/**
 * Build the payload an Error Trigger workflow receives. Robust to Error
 * instances, string errors, null, and arbitrary non-Error objects.
 */
export function buildErrorTriggerData(args: {
  error: unknown;
  lastNodeExecuted?: string;
  mode?: string;
  workflowId?: string;
  workflowName?: string;
}): ErrorTriggerData {
  const e = args.error;
  let message = 'Unknown error';
  let stack: string | undefined;
  let name: string | undefined;

  if (e instanceof Error) {
    message = e.message || 'Unknown error';
    stack = e.stack;
    name = e.name;
  } else if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; stack?: unknown; name?: unknown };
    if (obj.message != null) message = String(obj.message);
    if (obj.stack != null) stack = String(obj.stack);
    if (obj.name != null) name = String(obj.name);
  } else if (e != null) {
    message = String(e);
  }

  const error = (name || stack) ? { message, stack, name } : { message };

  return {
    execution: {
      error,
      lastNodeExecuted: args.lastNodeExecuted || '',
      mode: args.mode || 'trigger',
    },
    workflow: {
      id: args.workflowId || '',
      name: args.workflowName || '',
    },
  };
}
