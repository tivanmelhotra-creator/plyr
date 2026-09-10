/**
 * Workflow Files — the HTTP face of core/WorkflowStorage.
 *
 *   GET    /browser/workflow-files/:workflowId?path=                 list a folder
 *   POST   /browser/workflow-files/:workflowId/mkdir                 { path, name }
 *   POST   /browser/workflow-files/:workflowId/upload?path=&name=    raw bytes
 *   PATCH  /browser/workflow-files/:workflowId/rename                { path, name }
 *   DELETE /browser/workflow-files/:workflowId?path=&recursive=1
 *   POST   /browser/workflow-files/:workflowId/use                   { path, chooserId?, userId? }
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
      const body = (req.body ?? {}) as { path?: unknown; chooserId?: unknown; userId?: unknown };
      const file = await store.resolveForBrowser(String(body.path ?? ''));

      const chooserId = body.chooserId === undefined || body.chooserId === null
        ? ''
        : String(body.chooserId);
      if (chooserId) {
        const done = await RealChrome.acceptChooserPaths(chooserId, [file.absolutePath]);
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
      const done = await session.acceptFilePaths([file.absolutePath]);
      res.json({ success: true, name: file.name, size: file.size, ...done });
    } catch (e) { sendError(res, e); }
  });

  return router;
};
