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
 * WHERE THE LOCAL BROWSER'S BINDING LIVES
 * ---------------------------------------
 * REPORTED (S16): the drawer said "not opened from a saved workflow" again
 * after the browser had plainly been opened from one -- and downloads made
 * afterwards were not filed under the workflow.
 *
 * ROOT CAUSE. The binding was a `let` in this module: PROCESS MEMORY.
 *
 *   1. A server restart (pm2 restart, a deploy, `max_memory_restart`, the
 *      self-heal that recycles a wedged browser process alongside the app)
 *      emptied it. The Local Browser's Chrome profile survives a restart --
 *      REAL_CHROME_USER_DATA_DIR is on disk -- so the operator saw the SAME
 *      browser, now bound to nothing.
 *   2. ecosystem.config.js runs 4 cluster workers. POST /bind landed on one
 *      worker; GET /browser/workflow-files-binding and the download/upload
 *      persist ran on whichever worker the balancer picked next. Three out
 *      of four answered "nothing bound".
 *
 * So the binding is now KEPT IN REDIS -- the same store the workflow itself
 * lives in, so it is exactly as durable as the thing it points at -- and
 * mirrored in a process-local cache so the hot readers (shelf, chooser)
 * stay synchronous and never wait on a round trip in the transfer path.
 *
 *   write  -> memory, then Redis (awaited by the route so the answer is true)
 *   read   -> memory; `refreshRealChromeBinding()` re-reads Redis and is
 *             called by the routes that ANSWER the client (GET binding) and by
 *             the transfer paths before they persist, so a worker that did
 *             not take the /bind still files into the right workflow.
 *
 * Without a store attached (unit tests, the routes' own supertest apps) the
 * module behaves exactly as before: memory only.
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

/**
 * The three Redis commands this module needs. Typed as a slice of ioredis so
 * the routes' tests can hand in their in-memory stand-in, and so nothing here
 * depends on the client class itself.
 */
export interface BindingStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * ONE key, not per-user: RealChrome is single-tenant (one profile directory,
 * one SingletonLock), so there is exactly one Local Browser per deployment
 * and exactly one workflow it can work for. Prefixed like the workflow keys
 * (`wf:...`) so it is found next to the thing it points at.
 */
export const REAL_CHROME_BINDING_KEY = 'wf:binding:realchrome';

let store: BindingStore | null = null;
let realChrome: WorkflowRef | null = null;

/**
 * Give this module its store. Called once, by the router that owns the Redis
 * connection (workflow-files.routes.ts). `null` detaches, which is what the
 * unit tests use to get the memory-only behaviour back.
 */
export function attachBindingStore(s: BindingStore | null): void {
  store = s;
}

function normalise(ref: WorkflowRef | null | undefined): WorkflowRef | null {
  if (!ref || !ref.userId || !ref.workflowId) return null;
  return { userId: String(ref.userId), workflowId: String(ref.workflowId) };
}

function parse(raw: string | null): WorkflowRef | null {
  if (!raw) return null;
  try {
    return normalise(JSON.parse(raw) as WorkflowRef);
  } catch {
    return null;
  }
}

/**
 * Bind (or, with null, unbind) the process-wide Local Browser.
 *
 * Memory is written FIRST and synchronously, so a reader in this process sees
 * the new binding even if Redis is slow or down; the store is then written and
 * awaited, so the route's `bound: true` is only said once it is durable. A
 * store failure is logged and swallowed: the binding still holds for this
 * process, which is the pre-Redis behaviour, and the next /bind retries.
 */
export async function bindRealChrome(ref: WorkflowRef | null): Promise<void> {
  realChrome = normalise(ref);
  if (!store) return;
  try {
    if (realChrome) await store.set(REAL_CHROME_BINDING_KEY, JSON.stringify(realChrome));
    else await store.del(REAL_CHROME_BINDING_KEY);
  } catch (e) {
    console.warn(
      '[WorkflowBinding] could not write the Local Browser binding to the store:',
      (e as Error)?.message || e,
    );
  }
}

/**
 * The workflow the Local Browser currently works for, if any -- as THIS
 * PROCESS last saw it. Synchronous on purpose (the shelf and the chooser call
 * it in the transfer path); callers that can afford a round trip and want the
 * cross-worker / post-restart truth call `refreshRealChromeBinding()` first.
 */
export function realChromeWorkflow(): WorkflowRef | null {
  return realChrome ? { ...realChrome } : null;
}

/**
 * Re-read the binding from the store, reconcile memory with it, and return it.
 *
 * This is the line that survives a restart and crosses pm2 workers: whatever
 * this process remembers, the store is the record. Without a store it simply
 * answers from memory. A store error keeps the last memory value rather than
 * unbinding -- Redis being briefly unreachable must not unfile a download.
 */
export async function refreshRealChromeBinding(): Promise<WorkflowRef | null> {
  if (!store) return realChromeWorkflow();
  try {
    realChrome = parse(await store.get(REAL_CHROME_BINDING_KEY));
  } catch (e) {
    console.warn(
      '[WorkflowBinding] could not read the Local Browser binding from the store:',
      (e as Error)?.message || e,
    );
  }
  return realChromeWorkflow();
}

/**
 * The binding for a TRANSFER. Transfers are rare and already asynchronous (a
 * download has just finished writing; an upload is being handed to a page),
 * so they can afford the round trip -- and they MUST take it: a /bind that
 * landed on another worker, or a re-bind to a different workflow since this
 * process last looked, would otherwise file the transfer in the wrong place.
 * Memory-only (no store) answers synchronously as before.
 */
export function realChromeWorkflowForTransfer(): Promise<WorkflowRef | null> {
  return refreshRealChromeBinding();
}

/** Test seam: forget everything, as a fresh process would. */
export function resetRealChromeBindingForTests(): void {
  realChrome = null;
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
