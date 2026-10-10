/**
 * TestRunGate — activation needs PROOF that the design runs, not only that its
 * fields are filled in.
 *
 * The static ActivationCheck catches what is readable from the step tree (a
 * missing selector, an unknown action, a malformed URL). It cannot know that a
 * page never shows the element, that a login fails or that a site rejects the
 * request. Only a real run can. So, like n8n's publish step (and a deploy
 * pipeline that ships only a build whose tests passed), a workflow may be
 * activated only when its LAST Execute Workflow (test) run:
 *
 *   1. finished successfully, and
 *   2. ran exactly the design that is being activated (same fingerprint).
 *
 * Editing the workflow after a green test makes the result stale; the user
 * runs it again. A failed test is reported with its real error.
 *
 * The fingerprint is taken over the RUNNABLE design: disabled nodes are
 * dropped (with everything nested under them), exactly as the editor drops
 * them from a test run, so the saved document form and the run form of one
 * canvas hash the same.
 */
import { createHash } from 'node:crypto';

const NESTED = ['then', 'else', 'steps', 'catch', 'finally', 'fallback'] as const;

/** The design as it RUNS: disabled nodes removed, recursively. */
export function runnableSteps(steps: unknown): unknown[] {
  if (!Array.isArray(steps)) return [];
  const out: unknown[] = [];
  for (const raw of steps) {
    if (!raw || typeof raw !== 'object') { out.push(raw); continue; }
    const step = raw as Record<string, unknown>;
    if (step.disabled === true) continue;
    const copy: Record<string, unknown> = { ...step };
    delete copy.disabled;
    for (const k of NESTED) {
      if (Array.isArray(copy[k])) copy[k] = runnableSteps(copy[k]);
    }
    if (copy.cases && typeof copy.cases === 'object' && !Array.isArray(copy.cases)) {
      const cases: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(copy.cases as Record<string, unknown>)) cases[ck] = runnableSteps(cv);
      copy.cases = cases;
    }
    if (Array.isArray(copy.paths)) {
      copy.paths = (copy.paths as unknown[]).map((p) => {
        if (!p || typeof p !== 'object') return p;
        const pp = { ...(p as Record<string, unknown>) };
        if (Array.isArray(pp.steps)) pp.steps = runnableSteps(pp.steps);
        return pp;
      });
    }
    out.push(copy);
  }
  return out;
}

/** JSON with sorted keys and without undefined / empty-string noise. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== '').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

/** Identity of a runnable design. Same canvas -> same fingerprint. */
export function designFingerprint(steps: unknown): string {
  return createHash('sha256').update(stable(runnableSteps(steps))).digest('hex').slice(0, 32);
}

/** What is stored on the workflow after each test run. */
export interface WorkflowTestResult {
  status: 'success' | 'error' | 'cancelled';
  fingerprint: string;
  jobId: string;
  finishedAt: string;
  /** The run's error (failed runs only). */
  error?: string | null;
  /** The first failed step, when the runtime reported one. */
  failedStep?: { step: number; action: string; error?: string } | null;
}

/**
 * Why `lastTest` does not allow activating `steps`, or null when it does.
 * The messages are shown to the user as-is.
 */
export function testGateProblem(steps: unknown, lastTest: WorkflowTestResult | null | undefined): string | null {
  const how = 'Click Execute Workflow, make sure the run succeeds, then activate.';
  if (!lastTest) return `This workflow has never been tested. ${how}`;
  if (lastTest.fingerprint !== designFingerprint(steps)) {
    return `The workflow changed after its last test run. ${how}`;
  }
  if (lastTest.status === 'cancelled') return `The last test run was stopped before it finished. ${how}`;
  if (lastTest.status !== 'success') {
    const where = lastTest.failedStep
      ? `step ${lastTest.failedStep.step} (${lastTest.failedStep.action})`
      : 'the run';
    const why = (lastTest.failedStep && lastTest.failedStep.error) || lastTest.error || 'unknown error';
    return `The last test run failed at ${where}: ${String(why).split('\n')[0].slice(0, 300).replace(/[.\s]+$/, '')}. Fix it, then run Execute Workflow again.`;
  }
  return null;
}
