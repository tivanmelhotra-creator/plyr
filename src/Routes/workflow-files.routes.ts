/**
 * Workflow Files — the HTTP face of core/WorkflowStorage.
 *
 *   GET    /browser/workflow-files/:workflowId?path=                 list a folder
 *   POST   /browser/workflow-files/:workflowId/mkdir                 { path, name }
 *   POST   /browser/workflow-files/:workflowId/file                  { path, name, content? }  (New File)
 *   POST   /browser/workflow-files/:workflowId/upload?path=&name=    raw bytes
 *   PATCH  /browser/workflow-files/:workflowId/rename                { path, name }
 *   DELETE /browser/workflow-files/:workflowId?path=&recursive=1
 *   POST   /browser/workflow-files/:workflowId/use                   { path, paths?, chooserId?, userId? }
 *   POST   /browser/workflow-files/:workflowId/bind                  { target: 'local'|'live', userId? }
 *
 * `/bind` is what connects the REAL transfers to the workspace: after it, the
 * Local Browser's (target 'local') or the caller's live session's (target
 * 'live') completed downloads are filed under `downloads/` and files sent
 * with "Upload from Computer" under `uploads/` (core/WorkflowBinding). The
 * caller must own the workflow -- the same `open()` gate as every other verb
 * -- so a client can only ever bind a browser to a workspace it may see.
 *
 * Every workspace carries the two SYSTEM folders `uploads/` and `downloads/`
 * (core/WorkflowStorage SYSTEM_FOLDERS). They are created on first contact,
 * listed with `system: true`, and refuse rename/delete with a 400.
 * `?path=` defaults to the root; an `upload` with no `path` lands in the ROOT,
 * and the UI's "Upload" toolbar button targets `uploads/` explicitly.
 *
 * THREE RULES, ENFORCED HERE AND NOWHERE ELSE
 * -------------------------------------------
 * 1. WORKFLOW-RELATIVE PATHS ONLY. Every `path`/`name` is handed to
 *    WorkflowStorage, which rejects anything that is not a plain relative path
 *    inside the workflow's own directory (traversal, absolute, encoded,
 *    symlink). No request parameter is ever joined onto a filesystem path here.
 *
 * 2. THE OWNER COMES FROM THE KEY. `resolveOwner()` uses the API key's user
 *    (or 'local' in single-user mode). The workflow must EXIST for that owner
 *    (WorkflowService.get) before any filesystem operation runs, so knowing
 *    another user's workflow id buys nothing: it does not exist under yours.
 *    An `env_root` (admin) key may name `?userId=` explicitly, as the other
 *    /browser routes allow, because the UI runs on the admin key in
 *    multi-user mode and would otherwise see an empty list.
 *
 * 3. THE BROWSER GETS THE PATH, THE CLIENT NEVER DOES. `/use` resolves the
 *    selected file to a canonical absolute path and hands it in-process to the
 *    existing chooser bridge (RealChrome for the Local Browser view, the user's
 *    LiveBrowserSession for the canvas views). The response carries the count
 *    and the file's NAME, never its location.
 *
 * This router is mounted under the same auth as the rest of /browser
 * (index.ts), so every handler runs behind a validated API key.
 *
 * THE `endpoint not found` INCIDENT
 * --------------------------------
 * MEASURED in the running server (not the test app): New Folder, New File and
 * Upload from the Local Browser view all answered `{"error":"Endpoint not
 * found"}`. Every one of those handlers exists and is mounted; the request
 * simply never reached them, because the view had been opened WITHOUT
 * `?workflowId=` and built its URLs from an empty id:
 *
 *     POST /browser/workflow-files//mkdir      <- two slashes, no id
 *     POST /browser/workflow-files//file
 *     POST /browser/workflow-files//upload?path=uploads&name=x
 *
 * Express's `:workflowId` needs at least one character, so nothing here
 * matched and the request fell through to index.ts's generic 404 -- a message
 * that names the wrong problem. The client no longer sends these (it will
 * not build a URL without an id), and `missingId` below makes sure that if
 * anything ever does, the answer names the REAL cause with a 400.
 */

import { Router, type Response } from 'express';
import express from 'express';
import type IORedis from 'ioredis';

import { config } from '../config';
import { SINGLE_USER_ID, type AuthenticatedRequest } from '../middleware/auth';
import { WorkflowService } from '../services/workflow.service';
import { isValidWorkflowId } from '../utils/redis-keys';
import {
  WorkflowStorage,
  WorkflowStorageError,
  MAX_WORKFLOW_FILE_BYTES,
} from '../core/WorkflowStorage';
import { RealChrome, RealChromeError } from '../core/RealChrome';
import { FileChooserError } from '../core/RemoteFileChooser';
import { liveBrowserSessions } from '../core/LiveSessions';
import { bindRealChrome, realChromeWorkflow } from '../core/WorkflowBinding';

interface Deps {
  connection: IORedis;
}

function fail(res: Response, status: number, error: string, hint = ''): void {
  res.status(status).json({ success: false, error, ...(hint ? { hint } : {}) });
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof WorkflowStorageError) return fail(res, e.status, e.message);
  if (e instanceof FileChooserError) return fail(res, 409, e.message);
  if (e instanceof RealChromeError) return fail(res, 503, e.message);
  fail(res, 500, (e as Error)?.message || 'Unexpected error');
}

/**
 * Whose workspace? The key decides. `env_root` is the admin identity and owns no
 * workflows of its own, so for it — and only for it — an explicit `userId` is
 * honoured. Any other key that names a different user is refused: that is the
 * strict-binding rule the auth middleware already applies to body/param ids,
 * repeated for the query form this router reads.
 */
function resolveOwner(req: AuthenticatedRequest): string | null {
  if (config.IS_SINGLE_USER) return SINGLE_USER_ID;
  const keyUser = req.apiKeyUserId || '';
  const asked = String(req.query.userId || '').trim();
  if (!asked || asked === keyUser) return keyUser || null;
  if (keyUser === 'env_root') return asked;
  return null;
}

export const createWorkflowFilesRoutes = ({ connection }: Deps): Router => {
  const router = Router();
  const workflows = new WorkflowService(connection);

  // A request under our prefix with NO workflow id. `:workflowId` cannot match
  // an empty segment, so these would otherwise fall out of this router
  // altogether and be answered by the app-wide 404 ("Endpoint not found").
  // Registered FIRST so the two-slash form is caught before anything else,
  // and only for the exact shapes an id-less client produces, so a real id
  // (`/browser/workflow-files/wf_x/...`) never lands here.
  const NO_ID_HINT = 'Open the browser from a saved workflow (the view carries ?workflowId=), or save the workflow first.';
  function missingId(_req: AuthenticatedRequest, res: Response): void {
    fail(res, 400, 'No workflow id was given.', NO_ID_HINT);
  }
  router.all('/browser/workflow-files', missingId);
  router.all('/browser/workflow-files/', missingId);
  router.all(/^\/browser\/workflow-files\/\/.*$/, missingId);

  /**
   * Validate the id, find the owner, confirm the workflow is theirs, and open its
   * storage. Answers the response itself on failure and returns null.
   */
  async function open(req: AuthenticatedRequest, res: Response): Promise<WorkflowStorage | null> {
    const workflowId = String(req.params.workflowId || '');
    if (!isValidWorkflowId(workflowId)) {
      fail(res, 400, 'Invalid workflow id.');
      return null;
    }
    const owner = resolveOwner(req);
    if (!owner) {
      fail(res, 403, "This API key may not access that user's workflow files.");
      return null;
    }
    const wf = await workflows.get(owner, workflowId);
    if (!wf) {
      // 404, not 403: whether the id exists for SOMEONE ELSE is not information
      // this API hands out.
      fail(res, 404, 'Workflow not found.', 'Save the workflow first; its files live with it.');
      return null;
    }
    try {
      return new WorkflowStorage(owner, workflowId);
    } catch (e) {
      sendError(res, e);
      return null;
    }
  }

  // ── list ──────────────────────────────────────────────────────────────────
  router.get('/browser/workflow-files/:workflowId', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      const listing = await store.list(String(req.query.path ?? ''));
      res.json({ success: true, ...listing });
    } catch (e) { sendError(res, e); }
  });

  // ── bind: this browser works for this workflow from now on ────────────────
  //
  //   target 'local'  -> the ONE process-wide Local Browser (RealChrome)
  //   target 'live'   -> the caller's LiveBrowserSession (`userId` = the
  //                      identity the socket was opened with, as for /use)
  //
  // Idempotent, and a re-bind to another workflow simply replaces the first:
  // the browser is shared, and whichever workflow the operator is working in
  // NOW is the one its transfers belong to. Answers with what is bound so the
  // client can show it; `bound: false` when no live session is open yet is not
  // an error -- the client binds again when its socket says 'ready'.
  router.post('/browser/workflow-files/:workflowId/bind', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      // Creating the workspace here is what makes `uploads/` and `downloads/`
      // exist BEFORE the first transfer, not after the first listing.
      await store.ensureRoot();
      const body = (req.body ?? {}) as { target?: unknown; userId?: unknown };
      const target = String(body.target || 'local');
      const ref = { userId: store.userId, workflowId: store.workflowId };
      if (target === 'local') {
        bindRealChrome(ref);
        return res.json({ success: true, target, workflowId: ref.workflowId, bound: true });
      }
      if (target === 'live') {
        const sessionUser = String(body.userId || req.apiKeyUserId || SINGLE_USER_ID);
        const session = liveBrowserSessions.forUser(sessionUser);
        if (!session) {
          return res.json({ success: true, target, workflowId: ref.workflowId, bound: false,
            hint: 'No live browser is open for this user yet; bind again once it is.' });
        }
        session.bindWorkflow(ref);
        return res.json({ success: true, target, workflowId: ref.workflowId, bound: true });
      }
      fail(res, 400, "target must be 'local' or 'live'.");
    } catch (e) { sendError(res, e); }
  });

  // What the Local Browser is bound to right now. Not under :workflowId on
  // purpose: the view asks before it knows whether ITS id is the bound one.
  router.get('/browser/workflow-files-binding', (_req: AuthenticatedRequest, res) => {
    const ref = realChromeWorkflow();
    res.json({ success: true, local: ref ? { workflowId: ref.workflowId } : null });
  });

  // ── mkdir ─────────────────────────────────────────────────────────────────
  router.post('/browser/workflow-files/:workflowId/mkdir', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      const body = (req.body ?? {}) as { path?: unknown; name?: unknown };
      const entry = await store.mkdir(String(body.path ?? ''), String(body.name ?? ''));
      res.status(201).json({ success: true, entry });
    } catch (e) { sendError(res, e); }
  });

  // ── new (empty) file ─────────────────────────────────────────────────────────
  //
  // "New File" used to be a one-byte upload because the storage refused an
  // empty upload. That was a workaround, not a feature: a real empty file is
  // what the operator asked for, and this endpoint makes one. `content` is
  // optional text for a small seed (a JSON skeleton, a header row).
  router.post('/browser/workflow-files/:workflowId/file', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      const body = (req.body ?? {}) as { path?: unknown; name?: unknown; content?: unknown };
      const content = typeof body.content === 'string' ? body.content : '';
      const entry = await store.createFile(String(body.path ?? ''), String(body.name ?? ''), content);
      res.status(201).json({ success: true, entry });
    } catch (e) { sendError(res, e); }
  });

  // ── upload (raw body, like /browser/uploads) ──────────────────────────────
  router.post(
    '/browser/workflow-files/:workflowId/upload',
    express.raw({ type: () => true, limit: MAX_WORKFLOW_FILE_BYTES }),
    async (req: AuthenticatedRequest, res) => {
      try {
        const store = await open(req, res);
        if (!store) return;
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return fail(res, 400, 'No file was uploaded.',
            'POST the file bytes as the raw request body, with ?name=<filename>&path=<folder>.');
        }
        const entry = await store.writeFile(
          String(req.query.path ?? ''),
          String(req.query.name || 'file'),
          body,
          { overwrite: String(req.query.overwrite || '') === '1' },
        );
        res.status(201).json({ success: true, entry });
      } catch (e) { sendError(res, e); }
    },
  );

  // ── rename ────────────────────────────────────────────────────────────────
  router.patch('/browser/workflow-files/:workflowId/rename', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      const body = (req.body ?? {}) as { path?: unknown; name?: unknown };
      const entry = await store.rename(String(body.path ?? ''), String(body.name ?? ''));
      res.json({ success: true, entry });
    } catch (e) { sendError(res, e); }
  });

  // ── delete ────────────────────────────────────────────────────────────────
  router.delete('/browser/workflow-files/:workflowId', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      const recursive = String(req.query.recursive || '') === '1';
      await store.remove(String(req.query.path ?? ''), { recursive });
      res.json({ success: true });
    } catch (e) { sendError(res, e); }
  });

  // ── use: hand the selected file to the page that is asking ────────────────
  //
  // Two bridges, chosen by what the client sends:
  //   * `chooserId` present  -> the Local Browser view (ChromeView). It polls
  //     GET /browser/real/chooser and names the dialog it is answering, exactly
  //     as it does with upload tokens.
  //   * otherwise            -> the canvas views (RemoteIO over the live
  //     socket). The dialog belongs to the user's LiveBrowserSession; `userId`
  //     is the identity the socket was opened with (effectiveUserId in the UI).
  router.post('/browser/workflow-files/:workflowId/use', async (req: AuthenticatedRequest, res) => {
    try {
      const store = await open(req, res);
      if (!store) return;
      const body = (req.body ?? {}) as { path?: unknown; paths?: unknown; chooserId?: unknown; userId?: unknown };
      // ONE request, however many files. Both chooser bridges answer a dialog
      // once and then forget it, so a client that wants a `multiple` input to
      // receive several files has to name them all here: `path` is the first
      // (and the only one a single-file client ever sends), `paths` the full
      // list. Every one is resolved by the store, so a stray entry cannot name
      // anything outside the workflow root.
      const wanted = Array.isArray(body.paths) && body.paths.length
        ? body.paths.map((p) => String(p ?? ''))
        : [String(body.path ?? '')];
      const files = [];
      for (const rel of wanted) files.push(await store.resolveForBrowser(rel));
      const file = files[0];
      const absolute = files.map((f) => f.absolutePath);

      const chooserId = body.chooserId === undefined || body.chooserId === null
        ? ''
        : String(body.chooserId);
      if (chooserId) {
        const done = await RealChrome.acceptChooserPaths(chooserId, absolute);
        return res.json({ success: true, name: file.name, size: file.size, ...done });
      }

      const sessionUser = String(body.userId || req.apiKeyUserId || SINGLE_USER_ID);
      const session = liveBrowserSessions.forUser(sessionUser);
      if (!session) {
        return fail(res, 409, 'No live browser is open for this user.',
          "Open the browser view first, then press the page's own Choose file button.");
      }
      if (!session.hasPendingFileChooser()) {
        return fail(res, 409, 'The page is not asking for a file any more.');
      }
      const done = await session.acceptFilePaths(absolute);
      res.json({ success: true, name: file.name, size: file.size, ...done });
    } catch (e) { sendError(res, e); }
  });

  return router;
};
