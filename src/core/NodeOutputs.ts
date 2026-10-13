/**
 * NodeOutputs — a node's Success / Error / Timeout outputs (phase 2).
 *
 * NOT a second execution engine: a failed step whose node has an Error or
 * Timeout output is handled by the pipeline exactly like a taken `if` path —
 * the branch runs as a nested step group (`errorSteps` / `timeoutSteps`, same
 * validation and walkers as every other branch) and the group is then left, so
 * the success chain after the node does not run. Success is the node's normal
 * `next` port. A node with neither output keeps the old behaviour (stop the
 * run, or Continue On Fail).
 *
 *   failure kind   timeoutSteps?   errorSteps?   -> branch
 *   timeout        yes             any           timeout
 *   timeout        no              yes           error   (a timeout IS an error)
 *   error          any             yes           error
 *   otherwise                                    none (old behaviour)
 *
 * The branch receives ONE item describing the failure (first line of the
 * message only — Playwright's multi-line call log is not copied into data).
 * Pure.
 */
import type { AutomationStep } from '../types';
import type { FailureKind } from './ErrorPolicy';

export type OutputPort = 'error' | 'timeout';

/** Does this node have any failure output? */
export function hasFailureOutputs(step: Pick<AutomationStep, 'errorSteps' | 'timeoutSteps'>): boolean {
  return Array.isArray(step.errorSteps) || Array.isArray(step.timeoutSteps);
}

/** Which output a failure of `kind` leaves through, or null (no failure output). */
export function outputBranchFor(step: Pick<AutomationStep, 'errorSteps' | 'timeoutSteps'>, kind: FailureKind):
  { port: OutputPort; steps: AutomationStep[] } | null {
  if (kind === 'timeout' && Array.isArray(step.timeoutSteps)) return { port: 'timeout', steps: step.timeoutSteps };
  if (Array.isArray(step.errorSteps)) return { port: 'error', steps: step.errorSteps };
  return null;
}

const MAX_MESSAGE = 500;

/** The item a failure output carries. */
export function failureItem(step: Pick<AutomationStep, 'action'>, err: unknown, kind: FailureKind, attempts: number):
  { json: { error: string; kind: FailureKind; node: string; attempts: number } } {
  const raw = String((err as { message?: unknown } | null)?.message ?? err ?? 'Unknown error');
  const first = raw.split('\n')[0]!.slice(0, MAX_MESSAGE);
  return { json: { error: first, kind, node: step.action, attempts: Math.max(1, attempts) } };
}
