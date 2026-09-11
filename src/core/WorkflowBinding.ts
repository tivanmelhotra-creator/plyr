/**
 * WorkflowBinding — which Workflow a running browser is working FOR.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Workflow's file workspace (core/WorkflowStorage) has two system folders
 * with a fixed contract:
 *
 *     uploads/     what goes INTO a page's <input type="file">
 *     downloads/   what the browser brought BACK from a site
 *
 * Showing those folders is the easy half. For the contract to mean anything,
 * the real transfers have to land in them:
 *
 *   * a download the Local Browser (RealChrome) or a canvas Live Browser
 *     session completes is FINALISED into `<workflow>/downloads/`;
 *   * a file the operator sent with "Upload from Computer" — which travels
 *     through the temporary, TTL-swept UPLOADS_DIR transport — is PERSISTED
 *     into `<workflow>/uploads/` at the moment it is handed to the page.
 *
 * Neither the shelf nor the transport changes: the shelf still delivers the
 * file to the operator's machine by token, the transport still hands the page
 * its temporary copy. This module adds ONE copy into the workspace, and only
 * when the browser is bound to a workflow.
 *
 * HOW A BROWSER GETS BOUND
 * ------------------------
 * The client that opened the browser knows the saved workflow id: the Local
 * Browser view receives `?workflowId=` from browser-view.js, the canvas views
 * ask FlowEditor. Each POSTs `/browser/workflow-files/:workflowId/bind`, and
 * that route — which has already verified the caller OWNS the workflow —
 * calls into here. A client never binds by naming a directory; it names a
 * workflow it is allowed to see, and the server decides the rest.
 *
 *   Local Browser  ->  ONE process-wide binding (RealChrome is single-tenant)
 *   Live Browser   ->  per LiveBrowserSession (`session.bindWorkflow`)
 *
 * FAILURE IS LOGGED, NEVER PROPAGATED
 * -----------------------------------
 * The copy into the workspace is a side effect of a transfer that has
 * ALREADY succeeded. A full disk or a vanished workspace must not turn a
 * completed download into a failed one, so every persist here catches and
 * warns. `WorkflowStorage` still enforces every boundary rule on the way in.
 */

import path from 'path';

import {
  WorkflowStorage,
  DOWNLOADS_FOLDER,
  UPLOADS_FOLDER,
  type SystemFolder,
  type WorkflowEntry,
} from './WorkflowStorage';

/** A workflow, as the storage layer keys it. */
export interface WorkflowRef {
  userId: string;
  workflowId: string;
}

let realChrome: WorkflowRef | null = null;

/** Bind (or, with null, unbind) the process-wide Local Browser. */
export function bindRealChrome(ref: WorkflowRef | null): void {
  realChrome = ref ? { userId: String(ref.userId), workflowId: String(ref.workflowId) } : null;
}

/** The workflow the Local Browser currently works for, if any. */
export function realChromeWorkflow(): WorkflowRef | null {
  return realChrome ? { ...realChrome } : null;
}

/**
 * Copy a file that exists on this server into one of the workflow's system
 * folders. Returns the new entry, or null when there is nothing to do or the
 * copy failed (already logged).
 */
export async function persistIntoWorkflow(
  ref: WorkflowRef | null,
  folder: SystemFolder,
  name: string,
  absolutePath: string,
): Promise<WorkflowEntry | null> {
  if (!ref || !absolutePath) return null;
  try {
    const store = new WorkflowStorage(ref.userId, ref.workflowId);
    return await store.importFile(folder, name || path.basename(absolutePath), absolutePath);
  } catch (e) {
    console.warn(
      `[WorkflowBinding] could not persist ${folder}/${name} into workflow ${ref.workflowId}:`,
      (e as Error)?.message || e,
    );
    return null;
  }
}

/** A finished browser download -> `<workflow>/downloads/<name>`. */
export function persistDownload(
  ref: WorkflowRef | null,
  name: string,
  absolutePath: string,
): Promise<WorkflowEntry | null> {
  return persistIntoWorkflow(ref, DOWNLOADS_FOLDER, name, absolutePath);
}

/**
 * Files handed to a page from the temporary upload transport ->
 * `<workflow>/uploads/<their own names>`. Sequential: several large files on
 * a box that is also running a browser should not all copy at once.
 */
export async function persistUploads(
  ref: WorkflowRef | null,
  absolutePaths: string[],
): Promise<WorkflowEntry[]> {
  const out: WorkflowEntry[] = [];
  if (!ref) return out;
  for (const p of absolutePaths) {
    const e = await persistIntoWorkflow(ref, UPLOADS_FOLDER, path.basename(p), p);
    if (e) out.push(e);
  }
  return out;
}
