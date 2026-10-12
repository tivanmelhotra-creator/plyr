/**
 * /profiles — the ONE HTTP face of the browser-profile infrastructure.
 *
 *   GET    /profiles?workflowId=           list + status of every profile, as seen by that workflow
 *   POST   /profiles                       { name }            create (does NOT open a browser)
 *   PATCH  /profiles/:id                   { name }            rename (id and references unchanged)
 *   DELETE /profiles/:id                                       delete, refused while anything depends on it
 *   POST   /profiles/:id/open              { workflowId }      take the operator hold, then open the browser
 *   POST   /profiles/:id/hold              { workflowId }      refresh the hold (the open drawer does this)
 *   POST   /profiles/:id/release           { workflowId }      release the hold (does NOT close the browser)
 *   POST   /profiles/:id/close             { workflowId }      close the browser (does NOT release the hold)
 *
 * Opening and creating are separate operations; the UI chains them after a
 * successful create. A failed open keeps the profile (and its hold is given
 * back), records the error on the profile, and can be retried.
 *
 * Owners: a hold is taken for the workflow open in the editor (`workflowId`),
 * or `operator` when none is given. Runs of that same workflow are compatible
 * with it; every other workflow is refused with the reason.
 */
import { Router, type Response } from 'express';
import type IORedis from 'ioredis';
import { config } from '../config';
import { SINGLE_USER_ID, type AuthenticatedRequest } from '../middleware/auth';
import { WorkflowService } from '../services/workflow.service';
import { workflowStoreFor } from '../services/storage';
import { isValidWorkflowId } from '../utils/redis-keys';
import type { ProfileManager } from '../core/ProfileManager';
import { leaseIdOf, sanitizeProfileId } from '../core/ProfileLease';
import { ProfileRegistryError, DEFAULT_PROFILE_ID } from '../core/ProfileRegistry';
import { explainDenial, type ProfileAccess, type WorkflowRef } from '../core/ProfileAccess';
import { openProfileBrowser, closeProfileBrowser, ProfileBrowserError } from '../core/ProfileBrowser';
import { browserSessions, operatorDependent } from '../core/BrowserSessions';
import { withStartBudget } from '../core/RemoteBrowserStart';

export interface ProfileRoutesDeps {
  connection: IORedis;
  access: ProfileAccess;
  profileManager: ProfileManager;
}

const OPERATOR = 'operator';

function userOf(req: AuthenticatedRequest): string {
  if (config.IS_SINGLE_USER) return SINGLE_USER_ID;
  return req.apiKeyUserId || SINGLE_USER_ID;
}

function ownerOf(raw: unknown): string {
  return typeof raw === 'string' && isValidWorkflowId(raw) ? raw : OPERATOR;
}

function fail(res: Response, e: unknown): void {
  if (e instanceof ProfileRegistryError) {
    const status = e.code === 'not_found' ? 404 : e.code === 'duplicate_name' ? 409 : e.code === 'io' ? 500 : 400;
    res.status(status).json({ success: false, error: e.message, code: e.code });
    return;
  }
  res.status(500).json({ success: false, error: (e as Error)?.message || 'Profile operation failed' });
}

export function createProfileRoutes(deps: ProfileRoutesDeps): Router {
  const router = Router();
  const { access, profileManager } = deps;
  const workflows = new WorkflowService(workflowStoreFor(deps.connection));
  const holdMs = (): number => Math.max(5, config.OPERATOR_HOLD_MINUTES) * 60_000;

  /** Every workflow of the user with the profile its runs use (frozen design if active). */
  async function refs(userId: string): Promise<WorkflowRef[]> {
    const all = await workflows.list(userId).catch(() => []);
    return all.map((wf) => {
      const d = WorkflowService.executableDesign(wf);
      const live = wf.profileId || DEFAULT_PROFILE_ID;
      // Both the editable and the frozen profile count as references.
      return { id: wf.id, name: wf.name, profileId: (wf.active && d.profileId) ? d.profileId : live };
    });
  }

  async function idOrFail(userId: string, raw: string, res: Response): Promise<string | null> {
    const id = sanitizeProfileId(raw);
    if (!id || !(await access.registry.get(userId, id))) {
      res.status(404).json({ success: false, error: 'Profile not found' });
      return null;
    }
    return id;
  }

  router.get('/profiles', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const owner = ownerOf(req.query.workflowId);
      const wfs = await refs(userId);
      res.json({
        success: true,
        owner,
        profiles: await access.views(userId, owner, wfs),
        settings: {
          reserveBeforeMin: config.PROFILE_RESERVE_BEFORE_MIN,
          reserveAfterMin: config.PROFILE_RESERVE_AFTER_MIN,
          idleCloseMin: config.BROWSER_IDLE_CLOSE_MIN,
          holdMinutes: config.OPERATOR_HOLD_MINUTES,
        },
      });
    } catch (e) { fail(res, e); }
  });

  router.post('/profiles', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const p = await access.registry.create(userId, req.body?.name);
      const view = await access.view(userId, p.id, ownerOf(req.body?.workflowId), await refs(userId));
      res.status(201).json({ success: true, profile: view });
    } catch (e) { fail(res, e); }
  });

  router.patch('/profiles/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      await access.registry.rename(userId, id, req.body?.name);
      res.json({ success: true, profile: await access.view(userId, id, ownerOf(req.body?.workflowId), await refs(userId)) });
    } catch (e) { fail(res, e); }
  });

  router.delete('/profiles/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      const blockers = await access.deleteBlockers(id, await refs(userId));
      if (blockers.length) {
        res.status(409).json({ success: false, error: `This profile cannot be deleted: ${blockers.map((b) => b.detail).join(' ')}`, blockers });
        return;
      }
      await access.registry.remove(userId, id);
      res.json({ success: true, deleted: id });
    } catch (e) { fail(res, e); }
  });

  /**
   * Take the hold FIRST (atomic: refused when a run, another workflow's hold
   * or a reservation is in the way), THEN start the browser. A failed start
   * gives back a hold this request created, and keeps the profile.
   */
  router.post('/profiles/:id/open', async (req: AuthenticatedRequest, res) => {
    const userId = userOf(req);
    const owner = ownerOf(req.body?.workflowId);
    let id: string | null = null;
    let createdHold = false;
    try {
      id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      const entry = await access.registry.get(userId, id);
      if (entry?.problem) {
        res.status(409).json({ success: false, error: `Profile needs review: ${entry.problem}`, code: 'needs_review' });
        return;
      }
      const leaseId = leaseIdOf(id);
      const before = await access.leases.holdOf(leaseId);
      const h = await access.leases.hold(leaseId, owner, holdMs());
      if (!h.ok) {
        const wfs = await refs(userId);
        const nameOf = (o?: string) => wfs.find((w) => w.id === o)?.name;
        res.status(409).json({
          success: false,
          code: h.reason,
          error: explainDenial(h.reason, {
            lease: h.lease ? { ownerName: nameOf(h.lease.owner), jobId: h.lease.jobId } : null,
            hold: h.hold ? { ownerName: nameOf(h.hold.owner), until: h.hold.expiresAt } : null,
            reservation: h.reservation ? { ...h.reservation, ownerName: h.reservation.ownerName || nameOf(h.reservation.owner) } : null,
          }),
          reservation: h.reservation || null,
        });
        return;
      }
      createdHold = !before || before.owner !== owner;
      // The same bounded start the Local Browser uses (core/RemoteBrowserStart):
      // we always answer inside a budget that undercuts gateway timeouts. A cold
      // start that outlives it KEEPS GOING in the background and the answer is
      // a retryable 503; the retry joins the same launch (no second browser),
      // and the hold is kept meanwhile (the browser is being started for it).
      const profileId = id;
      let launchError: unknown = null;
      const started = await withStartBudget(() => openProfileBrowser(profileManager, {
        leaseId, userId, userDataDir: access.registry.dirOf(userId, profileId), owner,
      }).catch((e) => { launchError = e; throw e; }), {
        onLateSettle: (err) => {
          if (!err) { void access.registry.recordOpenError(userId, profileId, null); return; }
          void access.registry.recordOpenError(userId, profileId, (err as Error)?.message || 'open failed');
          if (createdHold) void access.leases.releaseHold(leaseId, { owner }).catch(() => {});
          browserSessions().detach(leaseId, operatorDependent(owner));
        },
      });
      if (started.outcome === 'starting') {
        res.status(503).json({ success: false, code: 'starting', retryable: true, error: started.error, hint: started.hint });
        return;
      }
      if (started.outcome === 'failed' || !started.value) {
        throw launchError || new ProfileBrowserError(`Could not start the browser: ${started.error || 'unknown error'}`, 'launch_failed');
      }
      const opened = started.value;
      await access.registry.recordOpenError(userId, id, null);
      res.json({
        success: true,
        profileId: id,
        reused: opened.reused,
        visibility: opened.visibility,
        holdUntil: h.expiresAt,
        // The existing remote view, pointed at this profile's window.
        viewPath: `/desktop/chrome?profile=${encodeURIComponent(id)}`,
      });
    } catch (e) {
      if (id) {
        const msg = (e as Error)?.message || 'open failed';
        await access.registry.recordOpenError(userId, id, msg).catch(() => {});
        if (createdHold) await access.leases.releaseHold(leaseIdOf(id), { owner }).catch(() => {});
        browserSessions().detach(leaseIdOf(id), operatorDependent(owner));
      }
      if (e instanceof ProfileBrowserError) {
        res.status(e.code === 'in_use_hidden' ? 409 : 503).json({ success: false, error: e.message, code: e.code, retryable: e.code === 'launch_failed' });
        return;
      }
      fail(res, e);
    }
  });

  router.post('/profiles/:id/hold', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      const owner = ownerOf(req.body?.workflowId);
      const cur = await access.leases.holdOf(leaseIdOf(id));
      if (!cur || cur.owner !== owner) { res.status(409).json({ success: false, error: 'No hold of yours on this profile', code: 'no_hold' }); return; }
      const h = await access.leases.hold(leaseIdOf(id), owner, holdMs());
      if (!h.ok) { res.status(409).json({ success: false, code: h.reason, error: explainDenial(h.reason, { reservation: h.reservation || null }) }); return; }
      res.json({ success: true, holdUntil: h.expiresAt });
    } catch (e) { fail(res, e); }
  });

  router.post('/profiles/:id/release', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      const owner = ownerOf(req.body?.workflowId);
      const released = await access.leases.releaseHold(leaseIdOf(id), { owner });
      // The operator view stops depending on the browser; the browser stays.
      browserSessions().detach(leaseIdOf(id), operatorDependent(owner));
      res.json({ success: true, released });
    } catch (e) { fail(res, e); }
  });

  router.post('/profiles/:id/close', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      const owner = ownerOf(req.body?.workflowId);
      const r = await closeProfileBrowser(profileManager, leaseIdOf(id), operatorDependent(owner));
      if (!r.closed && r.reason === 'in_use') {
        res.status(409).json({ success: false, code: 'in_use', error: 'The browser is in use by a run or another view and cannot be closed now.', dependents: r.dependents?.length || 0 });
        return;
      }
      // The hold is NOT released here (browser and claim are separate).
      res.json({ success: true, closed: r.closed, holdKept: !!(await access.leases.holdOf(leaseIdOf(id))) });
    } catch (e) { fail(res, e); }
  });

  return router;
}
