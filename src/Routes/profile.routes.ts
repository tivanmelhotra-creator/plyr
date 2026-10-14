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
 *   POST   /profiles/turn-off                                  close every browser Browser Profiles opened, except
 *                                                              one a workflow depends on (named in `keptOpen`)
 *   POST   /profiles/:id/restore           { workflowId }      reopen the tabs saved before the last automatic close
 *   GET    /profiles/launch-options                            presets, categorized options, rules for Custom Flags
 *   POST   /profiles/launch-settings/validate { launch }       the final argv + errors/warnings, without launching
 *
 * `open` accepts `launch: { preset, options, customFlags, acknowledgeRisk }`
 * (core/LaunchSettings). Invalid settings are refused BEFORE any claim or
 * launch (400 with the list), risky ones need `acknowledgeRisk` (409
 * needs_confirmation). Settings change how the process starts, never the
 * profile's id or data directory.
 *
 * Opening and creating are separate operations; the UI chains them after a
 * successful create. A failed open keeps the profile (and its hold is given
 * back), records the error on the profile, and can be retried.
 *
 * Owners: a hold is taken for the workflow open in the editor (`workflowId`),
 * or `operator` when none is given. Runs of that same workflow are compatible
 * with it; every other workflow is refused with the reason.
 */
import path from 'path';
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
import { BrowserWindowManager } from '../core/BrowserWindowManager';
import { runProfileIdOf } from '../core/NodeProfile';
import type { OverlapView, UnresolvedSchedule } from '../core/ProfileCoordinator';
import { readLastSession, restoreTabs } from '../core/BrowserStateSnapshot';
import { buildLaunchArgs, hasLaunchChoice, launchCatalogue, type LaunchSettingsInput, type ResolvedLaunch } from '../core/LaunchSettings';
import { launchProfilesOf } from '../core/NodeProfile';
import { scanBranch, type WorkflowUse } from '../core/BranchPolicy';
import { profileFailureReports } from '../core/ProfileFailureReports';
import { runningProfileOf } from '../core/BrowserSessions';
import { blockingUntil } from '../core/ProfileReservations';
import { defaultBaseDir, validateBaseDir } from '../core/BranchBase';
import { saveSetting } from '../core/PersistedSettings';

/** Pure: the launch-settings part of a request body, or null. */
export function launchInputOf(body: unknown): LaunchSettingsInput | null {
  const l = (body as { launch?: unknown } | null)?.launch;
  if (!l || typeof l !== 'object') return null;
  const o = l as Record<string, unknown>;
  const options: Record<string, boolean> = {};
  if (o.options && typeof o.options === 'object') {
    for (const [k, v] of Object.entries(o.options as Record<string, unknown>)) if (typeof v === 'boolean') options[k] = v;
  }
  return {
    preset: typeof o.preset === 'string' ? o.preset : undefined,
    options,
    customFlags: typeof o.customFlags === 'string' ? o.customFlags.slice(0, 40_000)
      : Array.isArray(o.customFlags) ? (o.customFlags as unknown[]).slice(0, 100).map((x) => String(x ?? '')) : undefined,
    acknowledgeRisk: o.acknowledgeRisk === true,
  };
}

/** What the client sees of a resolved launch (argv is shown: the user typed it; no paths in it). */
function launchView(r: ResolvedLaunch) {
  return { ok: r.ok, preset: r.presetId, options: r.options, custom: r.custom, args: r.args, errors: r.errors, warnings: r.warnings, needsConfirmation: r.needsConfirmation, hash: r.hash };
}

export interface ProfileRoutesDeps {
  connection: IORedis;
  access: ProfileAccess;
  profileManager: ProfileManager;
  /** Schedule-level facts the profile list shows (overlaps, schedules we cannot plan). Optional. */
  schedules?: {
    overlaps(): Promise<OverlapView[]>;
    unresolvedSchedules(): Promise<UnresolvedSchedule[]>;
    /** Workflow ids that have at least one schedule (a scheduled workflow is always active). */
    scheduledWorkflowIds?(): Promise<Set<string>>;
  };
}

/** Pure: one sentence for an overlap, with workflow names (never ids or paths). */
export function describeOverlap(o: OverlapView, nameOf: (owner: string) => string | undefined): string {
  const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + ' UTC';
  const a = o.a.ownerName || nameOf(o.a.owner) || 'another workflow';
  const b = o.b.ownerName || nameOf(o.b.owner) || 'another workflow';
  return `Schedules overlap: "${a}" (${hhmm(o.a.start)}–${hhmm(o.a.end)}) and "${b}" (${hhmm(o.b.start)}–${hhmm(o.b.end)}) reserve this profile at the same time; the later run waits until the earlier one releases it.`;
}

/** Schedules of `userId` (by their `sched:<user>:…` id). An id-less legacy entry counts only in single-user mode. */
function ownsSchedule(s: UnresolvedSchedule, userId: string): boolean {
  if (s.scheduleId) return s.scheduleId.split(':')[1] === userId;
  return config.IS_SINGLE_USER;
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
    const status = e.code === 'not_found' || e.code === 'branch_not_found' ? 404 : e.code === 'duplicate_name' || e.code === 'builtin' ? 409 : e.code === 'io' ? 500 : 400;
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
      // A Launch Browser node may name its own profile (core/NodeProfile);
      // that is the profile the runs take, so it is the reference.
      const live = runProfileIdOf(wf.steps, wf.profileId) || DEFAULT_PROFILE_ID;
      const frozen = wf.active ? runProfileIdOf(d.steps, d.profileId) : null;
      return { id: wf.id, name: wf.name, profileId: frozen || live };
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
      const views = await access.views(userId, owner, wfs);
      // What can be recovered (count + time only; URLs are never sent here).
      for (const v of views) {
        const snap = await readLastSession(access.registry.profilePathOf(userId, v.id));
        v.lastSession = snap && snap.tabs.length ? { savedAt: snap.savedAt, tabs: snap.tabs.length, reason: snap.reason } : null;
      }
      const nameOf = (o: string) => wfs.find((w) => w.id === o)?.name;
      // Overlapping schedules on one profile, attached to that profile (the
      // later run waits; the operator should know before it happens).
      const overlaps: Array<OverlapView & { profileId: string; message: string }> = [];
      let unknownSchedules: Array<UnresolvedSchedule & { message: string }> = [];
      if (deps.schedules) {
        const byLease = new Map(views.map((v) => [leaseIdOf(v.id), v] as const));
        const all = await deps.schedules.overlaps().catch(() => [] as OverlapView[]);
        // One entry per pair of schedules (the first overlapping occurrence).
        const seen = new Set<string>();
        for (const o of all) {
          const v = byLease.get(o.leaseId);
          if (!v) continue;
          const pair = [o.leaseId, o.a.scheduleId || o.a.owner, o.b.scheduleId || o.b.owner].sort().join('|');
          if (seen.has(pair)) continue;
          seen.add(pair);
          const msg = describeOverlap(o, nameOf);
          overlaps.push({ ...o, profileId: v.id, message: msg });
          v.overlaps = [...(v.overlaps || []), { message: msg, a: o.a, b: o.b }];
        }
        unknownSchedules = (await deps.schedules.unresolvedSchedules().catch(() => [] as UnresolvedSchedule[]))
          .filter((s) => ownsSchedule(s, userId))
          .map((s) => ({ ...s, message: `Schedule "${s.name || s.key}" (${s.cron}): its profile is unknown until its next run is queued, so nothing is reserved for it yet. Re-save the schedule to reserve its profile.` }));
      }
      res.json({
        success: true,
        owner,
        profiles: views,
        overlaps,
        unknownSchedules,
        settings: {
          reserveBeforeMin: config.PROFILE_RESERVE_BEFORE_MIN,
          reserveAfterMin: config.PROFILE_RESERVE_AFTER_MIN,
          idleCloseMin: config.BROWSER_IDLE_CLOSE_MIN,
          holdMinutes: config.OPERATOR_HOLD_MINUTES,
        },
      });
    } catch (e) { fail(res, e); }
  });

  /** Every workflow with its state and every profile its runs may use (branch deletion scan). */
  async function uses(userId: string): Promise<WorkflowUse[]> {
    const all = await workflows.list(userId).catch(() => []);
    const scheduled = (await deps.schedules?.scheduledWorkflowIds?.().catch(() => new Set<string>())) || new Set<string>();
    const running = new Set<string>();
    for (const r of browserSessions().list()) {
      for (const d of r.dependents) if (d.startsWith('job:')) running.add(d);
    }
    const leaseOwners = new Set<string>();
    for (const r of browserSessions().list()) {
      const lease = await access.leases.holder(r.leaseId).catch(() => null);
      if (lease?.owner) leaseOwners.add(lease.owner);
    }
    return all.map((wf) => {
      const d = WorkflowService.executableDesign(wf);
      const ids = new Set<string>();
      for (const src of [{ steps: wf.steps, pid: wf.profileId }, ...(wf.active ? [{ steps: d.steps, pid: d.profileId }] : [])]) {
        ids.add(src.pid || DEFAULT_PROFILE_ID);
        for (const x of launchProfilesOf(src.steps)) ids.add(x);
      }
      return {
        workflowId: wf.id, name: wf.name, active: !!wf.active,
        scheduled: scheduled.has(wf.id), running: leaseOwners.has(wf.id),
        profileIds: [...ids],
      };
    });
  }

  /** The full dependency scan of one branch (section 8). Re-run at the end of the hold. */
  async function branchScan(userId: string, branchId: string) {
    const b = await access.registry.branch(userId, branchId);
    if (!b) return null;
    const profiles = await access.registry.profilesOf(userId, branchId);
    const lease = await access.leases.holder(b.leaseKey).catch(() => null);
    const hold = await access.leases.holdOf(b.leaseKey).catch(() => null);
    const session = browserSessions().get(b.leaseKey);
    const now = Date.now();
    const resv = await access.reservations.list(b.leaseKey).catch(() => []);
    const reserved = resv.some((r) => r.state !== 'missed' && r.start <= now && now < blockingUntil(r));
    const scan = scanBranch({
      branchId: b.id, label: b.label, builtIn: !!b.builtIn, profiles,
      workflows: await uses(userId),
      branchRunning: !!(lease || session || profileManager.getVipContext(b.leaseKey)),
      runningProfileId: runningProfileOf(b.leaseKey),
      branchReserved: reserved,
    });
    return { ...scan, held: !!hold };
  }

  router.get('/profiles/branches', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const list = await access.registry.branches(userId);
      const profiles = await access.registry.list(userId, { includeLocalBrowser: true });
      res.json({
        success: true,
        baseDir: config.BRANCH_BASE_DIR,
        branches: list.filter((b) => b.kind !== 'local-browser').map((b) => ({
          id: b.id, label: b.label, legacy: !!b.legacy, builtIn: !!b.builtIn, external: !!b.external,
          running: !!browserSessions().get(b.leaseKey),
          runningProfileId: runningProfileOf(b.leaseKey),
          profiles: profiles.filter((p) => p.branchId === b.id).map((p) => ({ id: p.id, name: p.name, folder: p.folder })),
        })),
      });
    } catch (e) { fail(res, e); }
  });

  router.post('/profiles/branches', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const b = await access.registry.createBranch(userId, req.body?.label);
      res.status(201).json({ success: true, branch: { id: b.id, label: b.label } });
    } catch (e) { fail(res, e); }
  });

  /**
   * Add an EXISTING folder from outside Aria (section 4). Two steps, never one:
   *   1. POST /profiles/branches/external/inspect { root } -> read-only report
   *      (profile folders, in use, personal-browser warning). Nothing changes.
   *   2. POST /profiles/branches/external { root, confirm: <same root> } ->
   *      registered. Without the separate, exact confirmation: 428, nothing done.
   * The folder is never moved, copied or deleted (deleting the branch forgets it).
   */
  router.post('/profiles/branches/external/inspect', async (req: AuthenticatedRequest, res) => {
    try {
      res.json({ success: true, inspection: await access.registry.inspectExternal(userOf(req), req.body?.root) });
    } catch (e) { fail(res, e); }
  });

  router.post('/profiles/branches/external', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const ins = await access.registry.inspectExternal(userId, req.body?.root);
      if (ins.errors.length) { res.status(400).json({ success: false, code: 'not_addable', error: ins.errors.join(' '), inspection: ins }); return; }
      const confirm = typeof req.body?.confirm === 'string' && req.body.confirm.trim() ? path.resolve(req.body.confirm.trim()) : '';
      if (confirm !== ins.root) {
        res.status(428).json({ success: false, code: 'needs_confirmation', error: 'Adding a folder from outside Aria needs a separate confirmation of that exact folder.', inspection: ins });
        return;
      }
      const r = await access.registry.addExternalBranch(userId, ins.root, req.body?.label);
      res.status(201).json({ success: true, branch: { id: r.branch.id, label: r.branch.label, external: true }, profiles: r.profiles.map((p) => ({ id: p.id, name: p.name, folder: p.folder })), warnings: ins.warnings });
    } catch (e) { fail(res, e); }
  });

  router.patch('/profiles/branches/:branchId', async (req: AuthenticatedRequest, res) => {
    try {
      const b = await access.registry.renameBranch(userOf(req), String(req.params.branchId), req.body?.label);
      res.json({ success: true, branch: { id: b.id, label: b.label } });
    } catch (e) { fail(res, e); }
  });

  router.get('/profiles/branches/:branchId/deletion-scan', async (req: AuthenticatedRequest, res) => {
    try {
      const scan = await branchScan(userOf(req), String(req.params.branchId));
      if (!scan) { res.status(404).json({ success: false, error: 'Branch not found', code: 'branch_not_found' }); return; }
      res.json({ success: true, scan });
    } catch (e) { fail(res, e); }
  });

  /**
   * Delete a branch. The client calls this ONLY at the end of a 3-second
   * press-and-hold; the scan is run AGAIN here, so anything that started
   * during the hold cancels the deletion (409 with the fresh scan).
   * Inactive workflows keep their definition; their reference is cleared.
   */
  router.delete('/profiles/branches/:branchId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const branchId = String(req.params.branchId);
      const scan = await branchScan(userId, branchId);
      if (!scan) { res.status(404).json({ success: false, error: 'Branch not found', code: 'branch_not_found' }); return; }
      if (scan.builtIn) { res.status(409).json({ success: false, code: 'builtin', error: 'This branch is built in and cannot be deleted.', scan }); return; }
      if (!scan.deletable || scan.held) {
        res.status(409).json({ success: false, code: 'blocked', error: 'The branch cannot be deleted now: it is in use or referenced by an active or scheduled workflow.', scan });
        return;
      }
      const ids = new Set(scan.profiles.map((p) => p.profileId));
      const { removedProfiles, keptFolder } = await access.registry.removeBranch(userId, branchId);
      // Inactive workflows: clear the reference (state "profile missing").
      const cleared: string[] = [];
      for (const w of scan.inactiveWorkflows) {
        const wf = await workflows.get(userId, w.workflowId).catch(() => null);
        if (!wf || wf.active) continue;
        const pid = wf.profileId || DEFAULT_PROFILE_ID;
        if (ids.has(pid)) {
          const name = scan.profiles.find((x) => x.profileId === pid)?.name ?? null;
          await workflows.update(userId, wf.id, {
            name: wf.name, description: wf.description ?? null, steps: wf.steps, headless: wf.headless ?? null, webhookUrl: wf.webhookUrl ?? null,
            profileId: null, profileMissing: { profileId: pid, profileName: name, at: new Date().toISOString() },
          }).then(() => cleared.push(wf.id)).catch(() => {});
        }
      }
      res.json({ success: true, deleted: branchId, removedProfiles, ...(keptFolder ? { keptFolder } : {}), clearedWorkflows: cleared, profileMissing: scan.inactiveWorkflows.map((w) => w.workflowId) });
    } catch (e) { fail(res, e); }
  });

  /** Failure reports (profile_missing / profile_broken), newest first. */
  router.get('/profiles/reports', async (req: AuthenticatedRequest, res) => {
    try {
      res.json({ success: true, reports: await profileFailureReports().list(userOf(req)) });
    } catch (e) { fail(res, e); }
  });

  /** The base directory for NEW branches (one per OS). Changing it moves nothing. */
  router.get('/profiles/base-dir', (_req, res) => {
    res.json({ success: true, baseDir: config.BRANCH_BASE_DIR, default: defaultBaseDir(), platform: process.platform });
  });

  router.put('/profiles/base-dir', async (req: AuthenticatedRequest, res) => {
    try {
      const raw = typeof req.body?.baseDir === 'string' ? req.body.baseDir : '';
      const check = await validateBaseDir(raw);
      if (!check.ok) { res.status(400).json({ success: false, code: 'invalid_base_dir', error: check.errors.join(' '), check }); return; }
      saveSetting('BRANCH_BASE_DIR', check.path);
      res.json({ success: true, baseDir: config.BRANCH_BASE_DIR, warnings: check.warnings, note: 'Existing branches stay where they are; only new branches are created here.' });
    } catch (e) { fail(res, e); }
  });

  router.get('/profiles/launch-options', (_req, res) => {
    res.json({ success: true, ...launchCatalogue() });
  });

  router.post('/profiles/launch-settings/validate', (req, res) => {
    const input = launchInputOf(req.body) || {};
    res.json({ success: true, launch: launchView(buildLaunchArgs(input)) });
  });

  router.post('/profiles', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const p = await access.registry.create(userId, req.body?.name, {
        branchId: typeof req.body?.branchId === 'string' ? req.body.branchId : null,
        branchLabel: req.body?.branchLabel,
      });
      const view = await access.view(userId, p.id, ownerOf(req.body?.workflowId), await refs(userId));
      res.status(201).json({ success: true, profile: { ...view, branchId: p.branchId, branchLabel: p.branchLabel, folder: p.folder } });
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
      // Launch settings are checked BEFORE anything is claimed or started: a
      // refused setting must leave no hold, no session and no half launch.
      const launchIn = launchInputOf(req.body);
      const resolved = buildLaunchArgs(launchIn || {});
      if (resolved.errors.length) {
        res.status(400).json({ success: false, code: 'invalid_launch_settings', error: `Launch settings refused: ${resolved.errors.map((e) => (e.flag ? `${e.flag} — ` : '') + e.message).join(' ')}`, launch: launchView(resolved) });
        return;
      }
      if (resolved.needsConfirmation) {
        res.status(409).json({ success: false, code: 'needs_confirmation', error: `Confirm these launch flags first: ${resolved.warnings.map((w) => w.message).join(' ')}`, launch: launchView(resolved) });
        return;
      }
      const entry = await access.registry.get(userId, id);
      if (entry?.problem) {
        res.status(409).json({ success: false, error: `Profile needs review: ${entry.problem}`, code: 'needs_review' });
        return;
      }
      // Branch model, from the registry ONLY: root = the branch
      // (--user-data-dir), folder = this profile (--profile-directory). The
      // former path used `dirOf()`, which silently fell back to the legacy
      // one-root-per-profile formula, and `entry?.folder`, whose absence made
      // ChromiumProfileLocation read Local State / the pin file. Neither is
      // allowed for a registry profile: refused before any hold or launch.
      const loc = await access.registry.locationOf(userId, id);
      if (!loc) {
        res.status(409).json({ success: false, code: 'needs_review', error: 'Profile needs review: its branch folder or profile folder is not known in the registry.' });
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
        leaseId, userId, userDataDir: loc.root, owner,
        // Branch model: root = the branch, folder = this profile (--profile-directory).
        profileDirectory: loc.folder, profileId,
        displayName: entry?.name,
        launch: { args: resolved.args, hash: resolved.hash, explicit: hasLaunchChoice(launchIn) },
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
      // Several profile browsers share one desktop: raise THIS profile's
      // window so the view opened next shows it (best-effort, bounded).
      const focused = await Promise.race([
        BrowserWindowManager.focusByUserDataDir(loc.root).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]);
      res.json({
        success: true,
        profileId: id,
        reused: opened.reused,
        visibility: opened.visibility,
        focused: !!focused,
        holdUntil: h.expiresAt,
        relaunched: !!opened.relaunched,
        // Whether the running browser was started with the requested launch
        // settings (false: an open browser in use was reused as it was).
        settingsApplied: opened.settingsApplied,
        launch: launchView(resolved),
        // The ONE shared viewer (one desktop, every window on it). `profile`
        // tells the view which window to raise and which session it watches.
        viewPath: `/desktop/chrome?profile=${encodeURIComponent(id)}`,
      });
    } catch (e) {
      if (id) {
        const msg = (e as Error)?.message || 'open failed';
        const busy = e instanceof ProfileBrowserError && e.code === 'branch_busy';
        if (!busy) await access.registry.recordOpenError(userId, id, msg).catch(() => {});
        if (createdHold) await access.leases.releaseHold(leaseIdOf(id), { owner }).catch(() => {});
        browserSessions().detach(leaseIdOf(id), operatorDependent(owner));
      }
      if (e instanceof ProfileBrowserError && e.code === 'branch_busy') {
        // One running profile per branch: name the running one, offer to show it.
        const running = e.runningProfileId ? await access.registry.get(userId, e.runningProfileId).catch(() => null) : null;
        const name = running?.name || 'another profile';
        res.status(409).json({
          success: false, code: 'branch_busy',
          error: `"${name}" is already running in this branch. Only one profile of a branch can run at a time. Close it first, or bring it to the front.`,
          runningProfile: running ? { id: running.id, name: running.name } : null,
          viewPath: running ? `/desktop/chrome?profile=${encodeURIComponent(running.id)}` : null,
        });
        return;
      }
      if (e instanceof ProfileBrowserError) {
        res.status(e.code === 'launch_failed' ? 503 : 409).json({ success: false, error: e.message, code: e.code, retryable: e.code === 'launch_failed' });
        return;
      }
      fail(res, e);
    }
  });

  /**
   * TURN OFF (Browser Profiles panel): close every browser that Browser
   * Profiles opened (session created by an operator view, `operator:<owner>`),
   * EXCEPT one a workflow depends on now (a run `job:<id>` or a continuation
   * grant `grant:<owner>`): that one stays open and is reported with the
   * workflow and profile names. Operator views are this panel's own, so they
   * do not keep a browser open. Holds are NOT released (same as Close).
   * Browsers this panel did not open (the RealChrome session, a run's own
   * browser) are listed under `notOpenedHere` and left alone.
   * Every close is bounded (closeContextBounded); the answer always comes.
   */
  router.post('/profiles/turn-off', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const sessions = browserSessions();
      const wfs = await refs(userId);
      const wfName = (o?: string | null) => (o ? wfs.find((w) => w.id === o)?.name : undefined);
      const names = new Map((await access.registry.list(userId, { includeLocalBrowser: true }).catch(() => [])).map((p) => [p.id, p.name] as const));
      const closed: Array<{ profileId: string | null; name: string; timedOut?: boolean }> = [];
      const keptOpen: Array<{ profileId: string | null; name: string; reason: 'workflow'; workflows: Array<{ workflowId: string | null; name: string }> }> = [];
      const notOpenedHere: Array<{ sessionId: string; name: string }> = [];
      const failed: Array<{ profileId: string | null; name: string; error: string }> = [];
      for (const rec of sessions.list()) {
        const pid = runningProfileOf(rec.leaseId);
        const name = (pid && names.get(pid)) || pid || rec.leaseId;
        const ours = rec.createdBy.startsWith('operator:') && rec.createdBy !== 'operator:local-browser';
        if (!ours) { notOpenedHere.push({ sessionId: rec.leaseId, name: rec.leaseId === 'realchrome' ? 'realchrome' : name }); continue; }
        const blocking = rec.dependents.filter((d) => d.startsWith('job:') || d.startsWith('grant:'));
        if (blocking.length) {
          const lease = await access.leases.holder(rec.leaseId).catch(() => null);
          const list: Array<{ workflowId: string | null; name: string }> = [];
          for (const d of blocking) {
            const owner = d.startsWith('grant:') ? d.slice('grant:'.length) : (lease?.owner || null);
            const wid = owner && isValidWorkflowId(owner) ? owner : null;
            const item = { workflowId: wid, name: wfName(wid) || owner || d };
            if (!list.some((x) => x.name === item.name)) list.push(item);
          }
          keptOpen.push({ profileId: pid, name, reason: 'workflow', workflows: list });
          continue;
        }
        // Only this panel's own views depend on it: they stop depending, then it closes.
        for (const d of rec.dependents) if (d.startsWith('operator:')) sessions.detach(rec.leaseId, d);
        try {
          const r = await closeProfileBrowser(profileManager, rec.leaseId, operatorDependent(OPERATOR));
          if (r.closed || r.reason === 'not_open') closed.push({ profileId: pid, name, ...(r.timedOut ? { timedOut: true } : {}) });
          else failed.push({ profileId: pid, name, error: 'in use' });
        } catch (e) {
          failed.push({ profileId: pid, name, error: (e as Error)?.message || 'close failed' });
        }
      }
      res.json({ success: true, closed, keptOpen, notOpenedHere, failed });
    } catch (e) { fail(res, e); }
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

  /**
   * Recovery: reopen the tabs that were saved before the browser was last
   * closed (core/BrowserStateSnapshot). Only into a browser the caller has
   * opened (their hold + an open session); never opens a browser by itself
   * and never touches another workflow's claim.
   */
  router.post('/profiles/:id/restore', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = userOf(req);
      const id = await idOrFail(userId, req.params.id, res);
      if (!id) return;
      const owner = ownerOf(req.body?.workflowId);
      const leaseId = leaseIdOf(id);
      const hold = await access.leases.holdOf(leaseId);
      if (!hold || hold.owner !== owner) { res.status(409).json({ success: false, code: 'no_hold', error: 'Open the profile\'s browser first.' }); return; }
      const entry = profileManager.getVipContext(leaseId);
      if (!entry) { res.status(409).json({ success: false, code: 'not_open', error: 'The browser of this profile is not open.' }); return; }
      const snap = await readLastSession(access.registry.profilePathOf(userId, id));
      const opened = await restoreTabs(entry.context as any, snap);
      res.json({ success: true, restored: opened, savedAt: snap?.savedAt || null });
    } catch (e) { fail(res, e); }
  });

  return router;
}
