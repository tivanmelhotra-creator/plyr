/**
 * Simulates what happens when the user clicks Execute Workflow and the run
 * succeeds: the worker stores a green `lastTest` with the fingerprint of the
 * design that ran (src/index.ts recordTestOutcome). Activation tests call this
 * before activating, because activation requires a passed test of the current
 * design (src/core/TestRunGate.ts).
 */
import { WorkflowService } from '../../src/services/workflow.service';
import { designFingerprint, type WorkflowTestResult } from '../../src/core/TestRunGate';

export async function markTested(
  store: any,
  userId: string,
  workflowId: string,
  status: WorkflowTestResult['status'] = 'success',
  extra: Partial<WorkflowTestResult> = {},
): Promise<void> {
  const svc = new WorkflowService(store);
  const wf = await svc.get(userId, workflowId);
  if (!wf) throw new Error(`markTested: no workflow ${userId}/${workflowId}`);
  await svc.recordTestResult(userId, workflowId, {
    status,
    fingerprint: designFingerprint(wf.steps),
    jobId: 'test-job',
    finishedAt: new Date().toISOString(),
    ...extra,
  });
}
