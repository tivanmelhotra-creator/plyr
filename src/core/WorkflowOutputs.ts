/**
 * WorkflowOutputs — where a NODE's output files go: into the Workflow's own
 * file workspace, never into an anonymous per-job directory.
 *
 * THE CONTRACT
 * ------------
 * A saved Workflow owns a workspace (core/WorkflowStorage) with two system
 * folders. `downloads/` is the OUTPUT side: what a run brought back or made.
 * A node that produces a file (screenshot, download, export-data) files it at
 *
 *     <workspace>/downloads/<node-folder>/<file>
 *
 * where `<node-folder>` is ONE folder per node, e.g. `04-screenshot`. The
 * folder is created the first time the node runs and REUSED afterwards -- a
 * second run adds a file next to the first, it does not make a second folder.
 * Files are never overwritten: WorkflowStorage numbers a clash (`a (2).png`).
 *
 * WHY THE WORKSPACE AND NOT JobArtifacts
 * --------------------------------------
 * The workspace is the unit of access control. It is keyed on
 * (owner, workflowId), every path goes through WorkflowStorage.resolve (no
 * traversal, no symlinks, no escaping the root), and the operator can browse,
 * download, rename and delete it in the Workflow Files drawer. A job-id
 * directory offers none of that, and nobody could find it.
 *
 * WHO DECIDES THE WORKFLOW
 * ------------------------
 * Never the page being automated and never an expression: the route that
 * enqueued the job verified that the caller owns the workflow and stamped
 * `job.data.__workspace = { owner, workflowId }`. The pipeline only reads it
 * back through `workspaceOf()`, which re-validates the shape.
 *
 * A run with no saved workflow (an unsaved canvas, an ad-hoc API call) has no
 * workspace; callers then fall back to JobArtifacts, exactly as before.
 *
 * Pure fs + path logic, no Express and no Redis: unit-testable.
 */

import { WorkflowStorage, DOWNLOADS_FOLDER, type WorkflowEntry } from './WorkflowStorage';
import { isValidWorkflowId } from '../utils/redis-keys';

/** Who owns the workspace a job writes into. Stamped by the route, not the client. */
export interface JobWorkspace {
  owner: string;
  workflowId: string;
}

/** What a step puts in its output item so the UI can find (and show) the file. */
export interface NodeFileRef {
  workflowId: string;
  /** Workflow-relative, POSIX: `downloads/04-screenshot/shot.png`. */
  path: string;
  /** The folder this node writes into: `downloads/04-screenshot`. */
  folder: string;
  name: string;
  size: number;
  mimeType: string;
  /** Relative URL that serves the bytes behind the normal API-key auth. */
  url: string;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
  csv: 'text/csv',
};

export function mimeForName(name: string): string {
  const ext = String(name || '').split('.').pop()!.toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * Read the workspace a job may write to out of its data, or null.
 * Anything that is not exactly `{ owner, workflowId }` of valid ids is ignored
 * rather than trusted -- the field travels through Redis.
 */
export function workspaceOf(jobData: unknown): JobWorkspace | null {
  const ws = (jobData as { __workspace?: unknown } | null | undefined)?.__workspace;
  if (!ws || typeof ws !== 'object') return null;
  const { owner, workflowId } = ws as Record<string, unknown>;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) return null;
  if (typeof workflowId !== 'string' || !isValidWorkflowId(workflowId)) return null;
  return { owner, workflowId };
}

/**
 * The folder name of ONE node: `<step number, 2+ digits>-<action>`.
 * The number is the step's position in the run, so the same node lands in the
 * same folder on every run and two nodes of the same kind never share one.
 * The action is reduced to `[a-z0-9_-]` so it is a valid path segment.
 */
export function nodeFolderName(stepNumber: number, action: string): string {
  const n = Math.max(0, Math.floor(Number(stepNumber) || 0));
  const act = String(action || 'node')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'node';
  return `${String(n).padStart(2, '0')}-${act}`;
}

/** `YYYYMMDD-HHmmss` in UTC: sortable, and a legal file-name fragment. */
export function fileStamp(now: Date = new Date()): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * URL the UI fetches a workspace file from. It is the EXISTING Workflow Files
 * download route, so the same ownership gate and path checks apply -- there is
 * no second way in.
 */
export function workspaceFileUrl(owner: string, workflowId: string, relPath: string): string {
  return (
    `/browser/workflow-files/${encodeURIComponent(workflowId)}/download` +
    `?path=${encodeURIComponent(relPath)}&userId=${encodeURIComponent(owner)}`
  );
}

/**
 * Make sure `downloads/<folder>` exists, creating it only when missing.
 * Returns the workflow-relative path of the folder.
 */
export async function ensureNodeFolder(store: WorkflowStorage, folder: string): Promise<string> {
  await store.ensureRoot();
  const rel = `${DOWNLOADS_FOLDER}/${folder}`;
  const probe = await store.resolve(rel, { mustExist: false });
  if (!probe.stat) {
    await store.mkdir(DOWNLOADS_FOLDER, folder);
  } else if (!probe.stat.isDirectory()) {
    throw new Error(`"${rel}" exists and is not a folder.`);
  }
  return rel;
}

function toRef(ws: JobWorkspace, folderRel: string, entry: WorkflowEntry): NodeFileRef {
  return {
    workflowId: ws.workflowId,
    path: entry.path,
    folder: folderRel,
    name: entry.name,
    size: entry.size,
    mimeType: mimeForName(entry.name),
    url: workspaceFileUrl(ws.owner, ws.workflowId, entry.path),
  };
}

/** Write bytes a node produced into its folder. */
export async function saveNodeBytes(
  ws: JobWorkspace,
  node: { stepNumber: number; action: string },
  fileName: string,
  bytes: Buffer,
): Promise<NodeFileRef> {
  const store = new WorkflowStorage(ws.owner, ws.workflowId);
  const folderRel = await ensureNodeFolder(store, nodeFolderName(node.stepNumber, node.action));
  const entry = await store.writeFile(folderRel, fileName, bytes);
  return toRef(ws, folderRel, entry);
}

/** Copy a file the SERVER already holds (e.g. a Playwright download) into the node's folder. */
export async function saveNodeFileFrom(
  ws: JobWorkspace,
  node: { stepNumber: number; action: string },
  fileName: string,
  sourceAbsolute: string,
): Promise<NodeFileRef> {
  const store = new WorkflowStorage(ws.owner, ws.workflowId);
  const folderRel = await ensureNodeFolder(store, nodeFolderName(node.stepNumber, node.action));
  const entry = await store.importFile(folderRel, fileName, sourceAbsolute);
  return toRef(ws, folderRel, entry);
}
