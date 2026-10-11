/**
 * The live run tab's two extra routes (docs/uiux/24-HANDOFF-live-run-redesign.md).
 *
 *   GET  /live/plan/:userId/:jobId     -> what the run is going to do
 *        Gate: authorizeLive with the share token (same as /live/sse). Returns
 *        only what core/LiveRunPlan allows: action ids + one non-secret target,
 *        the workflow's NAME and the run's start time. Never the steps' params.
 *
 *   POST /live/restart/:userId/:jobId  -> stop this run and start it again
 *        Gate: the OWNER's credential (x-api-key header, or development's
 *        keyless loopback). A share token is NOT enough: a share link can be
 *        forwarded and is documented as view-only, so it must never start a run.
 *        Returns the new job id plus a fresh share link for it.
 *
 * Stop needs no new route: the page calls the existing DELETE /cancel with the
 * same owner credential.
 *
 * Everything outside Express is injected, so the routes are tested without
 * Redis or a browser (tests/unit/live-run-plan.test.ts).
 */
import { Router, type Request, type Response } from 'express';
import { buildLivePlan, restartJobData } from '../core/LiveRunPlan';
import type { LiveAuthFn } from './live-frames.routes';

export interface LiveJobLike {
  id?: string | null;
  data: Record<string, any>;
  processedOn?: number | null;
  timestamp?: number;
  finishedOn?: number | null;
  getState(): Promise<string>;
}

export interface LiveControlDeps {
  authorize: LiveAuthFn;
  getJob(jobId: string): Promise<LiveJobLike | null | undefined>;
  /** Name of a saved workflow, or null. */
  workflowName(owner: string, workflowId: string): Promise<string | null>;
  /** Signal the running job to stop (the same steps DELETE /cancel takes). */
  cancel(job: LiveJobLike): Promise<void>;
  /** Queue a job with this data; resolves its id. */
  enqueue(data: Record<string, unknown>): Promise<string>;
  /** Mint a share token for (userId, jobId); null when sharing is not configured. */
  shareToken(userId: string, jobId: string): string | null;
}

const UNFINISHED = new Set(['active', 'waiting', 'delayed', 'prioritized']);

function apiKeyOf(req: Request): string | undefined {
  return (req.headers['x-api-key'] as string | undefined) || undefined;
}

export function createLiveControlRouter(deps: LiveControlDeps): Router {
  const router = Router();

  router.get('/live/plan/:userId/:jobId', async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    const jobId = String(req.params.jobId);
    const share = req.query.share ? String(req.query.share) : undefined;
    let auth: { ok: boolean; reason?: string };
    try { auth = await deps.authorize(apiKeyOf(req), userId, { share, jobId, req }); }
    catch { auth = { ok: false, reason: 'auth_unavailable' }; }
    if (!auth.ok) {
      res.status(auth.reason === 'missing_api_key' ? 401 : 403).json({ success: false, error: 'Live access denied', reason: auth.reason });
      return;
    }

    let job: LiveJobLike | null | undefined = null;
    try { job = await deps.getJob(jobId); } catch { job = null; }
    if (!job || String(job.data?.userId) !== userId) {
      // Evicted / unknown: the page still works from its event stream alone.
      res.json({ success: true, known: false, steps: [], workflow: null, startedAt: null, state: null });
      return;
    }

    let state: string | null = null;
    try { state = await job.getState(); } catch { state = null; }
    const ws = job.data.__workspace;
    let workflow: { id: string; name: string } | null = null;
    if (ws && typeof ws.workflowId === 'string') {
      let name: string | null = null;
      try { name = await deps.workflowName(String(ws.owner || userId), ws.workflowId); } catch { name = null; }
      workflow = { id: ws.workflowId, name: name || '' };
    }
    res.json({
      success: true,
      known: true,
      steps: buildLivePlan(job.data.steps).steps,
      workflow,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      state,
      restartOf: typeof job.data.__restartOf === 'string' ? job.data.__restartOf : null,
    });
  });

  router.post('/live/restart/:userId/:jobId', async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    const jobId = String(req.params.jobId);
    let auth: { ok: boolean; reason?: string };
    // No `share`: a share token never controls a run.
    try { auth = await deps.authorize(apiKeyOf(req), userId, { req }); }
    catch { auth = { ok: false, reason: 'auth_unavailable' }; }
    if (!auth.ok) {
      res.status(auth.reason === 'missing_api_key' ? 401 : 403).json({ success: false, error: 'Only the owner can restart this run', reason: auth.reason });
      return;
    }
    let job: LiveJobLike | null | undefined = null;
    try { job = await deps.getJob(jobId); } catch { job = null; }
    if (!job || String(job.data?.userId) !== userId || !Array.isArray(job.data.steps)) {
      res.status(404).json({ success: false, error: 'This run is no longer available to restart' });
      return;
    }
    if (job.data.__runNode) {
      res.status(409).json({ success: false, error: 'A single-node test cannot be restarted from here' });
      return;
    }

    let state = '';
    try { state = await job.getState(); } catch { state = ''; }
    const stopped = UNFINISHED.has(state);
    if (stopped) {
      try { await deps.cancel(job); } catch { /* the new run still starts; the old one stops at its next check */ }
    }

    let newId: string;
    try { newId = await deps.enqueue(restartJobData(job.data, jobId)); }
    catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message || 'Could not start the run again' });
      return;
    }
    const token = deps.shareToken(userId, newId);
    res.json({
      success: true,
      jobId: newId,
      previousJobId: jobId,
      stopped,
      url: token ? `/live/view/${encodeURIComponent(userId)}/${encodeURIComponent(newId)}?share=${encodeURIComponent(token)}` : null,
    });
  });

  return router;
}
