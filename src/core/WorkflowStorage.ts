/**
 * WorkflowStorage — the persistent file workspace that belongs to ONE Workflow.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * A Workflow (see services/workflow.service.ts, ids `wf_<hex>`) gets its own
 * isolated directory:
 *
 *     WORKFLOW_STORAGE_ROOT/<userId>/<workflowId>/<relativePath>
 *
 * The files in it are the operator's own working material for that automation:
 * a spreadsheet to upload, a reference image, a cookie export. They PERSIST —
 * unlike `UPLOADS_DIR` (temporary, TTL-swept, one directory per token) and
 * `DOWNLOADS_DIR` (ephemeral by default). This module is deliberately NOT a
 * rename of either of those: the temporary upload path stays exactly as it is
 * and is still used as the transport for "Upload from Computer".
 *
 * THE BOUNDARY IS THE WHOLE POINT
 * -------------------------------
 * The client never names a filesystem path. It names a `workflowId` plus a
 * workflow-RELATIVE path, and this module is the only place that turns those
 * into a real location. Every operation goes through `resolve()`, which enforces
 * in this order:
 *
 *   1. the workflow id matches the canonical pattern (redis-keys.isValidWorkflowId);
 *   2. the relative path has no absolute prefix, no drive letter, no `..`
 *      segment, no NUL/control characters, no backslashes, and every segment is
 *      a plain name (also after percent-decoding, so `%2e%2e` is not a bypass);
 *   3. the lexical result is inside the workflow root (path.relative check);
 *   4. the REAL path of the nearest existing ancestor is inside the REAL root,
 *      so a symlink planted inside the workspace cannot point out of it;
 *   5. the leaf itself is not a symlink (lstat), so `escape -> /etc` is refused
 *      rather than followed.
 *
 * Cross-workflow isolation is a consequence of (1)–(5): a request carries one
 * workflowId and can only ever reach that workflow's directory. Cross-USER
 * isolation is the route's job (the owner comes from the API key and the
 * workflow must exist for that owner) and is reinforced here by keying the root
 * on userId as well.
 */

import { promises as fs, type Dirent, type Stats } from 'fs';
import path from 'path';

import { config } from '../config';
import { isValidWorkflowId } from '../utils/redis-keys';

export class WorkflowStorageError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'WorkflowStorageError';
  }
}

/** One row in a listing. Paths are workflow-relative, POSIX-separated. */
export interface WorkflowEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: string;
}

export interface WorkflowListing {
  workflowId: string;
  path: string;
  parent: string | null;
  entries: WorkflowEntry[];
}

/** The file a browser dialog will receive. */
export interface ResolvedWorkflowFile {
  /** Absolute, canonical path on this server. Internal — never sent to a client. */
  absolutePath: string;
  name: string;
  size: number;
  relativePath: string;
}

/** Per-file cap. Generous, because a workspace may hold real assets. */
export const MAX_WORKFLOW_FILE_BYTES = 256 * 1024 * 1024;

/** Names beyond this are almost certainly hostile or a mistake. */
const MAX_SEGMENT_LENGTH = 200;
const MAX_RELATIVE_LENGTH = 1024;
const MAX_DEPTH = 32;

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A single path segment the operator may name.
 *
 * Letters, digits, space and a small punctuation set. No slashes of either
 * kind, no leading dot (no dotfiles, no `.`/`..`), no trailing dot or space
 * (Windows strips them, so `foo.` and `foo` would collide), no control
 * characters, no bidi overrides.
 */
const SEGMENT_RE = /^[^\s.][^\u0000-\u001f\u007f/\\:*?"<>|\u200e\u200f\u202a-\u202e]{0,199}$/;

function assertWorkflowId(workflowId: string): string {
  const id = String(workflowId || '');
  if (!isValidWorkflowId(id)) throw new WorkflowStorageError('Invalid workflow id.');
  return id;
}

function assertUserId(userId: string): string {
  const id = String(userId || '');
  if (!USER_ID_RE.test(id)) throw new WorkflowStorageError('Invalid user id.', 403);
  return id;
}

/**
 * Validate ONE segment (a new file/folder name). Exported so the route can
 * reject a bad `name` before it touches the disk.
 */
export function assertSegment(name: string): string {
  const s = String(name ?? '');
  if (!s || s.length > MAX_SEGMENT_LENGTH) {
    throw new WorkflowStorageError('Invalid name.');
  }
  if (s.endsWith('.') || s.endsWith(' ')) {
    throw new WorkflowStorageError('Names may not end with a dot or a space.');
  }
  if (!SEGMENT_RE.test(s)) {
    throw new WorkflowStorageError(
      'Names may not contain / \\ : * ? " < > | or control characters, or start with a dot.',
    );
  }
  return s;
}

/**
 * Normalise a workflow-relative path to POSIX segments, or throw.
 *
 * Percent-decoded FIRST: a client that sends `%2e%2e%2f` through a JSON body
 * reaches Node undecoded, and a naive check would pass it. Decoding here means
 * the encoded and the plain form are judged identically. A malformed encoding is
 * rejected outright rather than treated as literal text.
 */
export function normalizeRelativePath(input: unknown): string {
  let raw = String(input ?? '');
  if (raw.length > MAX_RELATIVE_LENGTH) throw new WorkflowStorageError('Path is too long.');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    throw new WorkflowStorageError('Path is not valid.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new WorkflowStorageError('Path contains control characters.');
  if (raw.includes('\\')) throw new WorkflowStorageError('Backslashes are not allowed in a path.');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('~')) {
    throw new WorkflowStorageError('Absolute paths are not allowed.');
  }
  const segments = raw.split('/').filter((s) => s !== '');
  if (segments.length > MAX_DEPTH) throw new WorkflowStorageError('Path is nested too deeply.');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new WorkflowStorageError('Path traversal is not allowed.');
    assertSegment(seg);
  }
  return segments.join('/');
}

/**
 * Reduce a filename the BROWSER reported (`file.name`) to a segment we accept.
 *
 * Uploads are the one place a name arrives without the operator typing it, so
 * it is cleaned rather than refused: `C:\\Users\\me\\report.pdf` from an old
 * IE-style client becomes `C__Users_me_report.pdf`, `..\\x` cannot traverse,
 * and a name that cleans down to nothing becomes `file`. Names the operator
 * TYPES (New Folder, Rename) still go through the strict assertSegment.
 */
export function sanitizeFileName(originalName: string): string {
  const base = path.posix.basename(String(originalName || '').replace(/\\/g, '/'));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, MAX_SEGMENT_LENGTH);
  return cleaned || 'file';
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * The workspace of one (user, workflow) pair.
 *
 * Instances are cheap and stateless; the route makes one per request. Nothing
 * here checks that the workflow EXISTS in Redis — that is the route's job,
 * because it is the route that knows who is asking.
 */
export class WorkflowStorage {
  readonly userId: string;
  readonly workflowId: string;
  private readonly root: string;

  constructor(userId: string, workflowId: string) {
    this.userId = assertUserId(userId);
    this.workflowId = assertWorkflowId(workflowId);
    this.root = path.resolve(config.WORKFLOW_STORAGE_ROOT, this.userId, this.workflowId);
  }

  /** Where this workflow's files live. Exposed for tests and diagnostics only. */
  rootDir(): string {
    return this.root;
  }

  /** Create the workflow directory if it is not there yet. */
  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    // If the root itself were replaced by a symlink pointing elsewhere, every
    // later check would be relative to the wrong place. Refuse to operate.
    const st = await fs.lstat(this.root);
    if (st.isSymbolicLink()) {
      throw new WorkflowStorageError('The workflow storage directory is not usable.', 500);
    }
  }

  /**
   * Turn a workflow-relative path into a checked absolute path.
   *
   * `mustExist: false` is for targets about to be created: then the PARENT must
   * exist and be inside the root, and the leaf must not already be a symlink.
   */
  async resolve(
    relative: unknown,
    opts: { mustExist?: boolean } = {},
  ): Promise<{ absolute: string; relative: string; stat: Stats | null }> {
    const rel = normalizeRelativePath(relative);
    await this.ensureRoot();

    // Lexical containment first — cheap, and independent of what is on disk.
    const absolute = rel ? path.resolve(this.root, ...rel.split('/')) : this.root;
    const lexical = path.relative(this.root, absolute);
    if (lexical.startsWith('..') || path.isAbsolute(lexical)) {
      throw new WorkflowStorageError('Path escapes the workflow storage.', 403);
    }

    // Physical containment: the REAL location of the nearest existing ancestor
    // must be inside the REAL root. This is what defeats `assets -> /etc`.
    const realRoot = await fs.realpath(this.root);
    let probe = absolute;
    let realProbe: string | null = null;
    while (true) {
      realProbe = await realpathOrNull(probe);
      if (realProbe !== null) break;
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    if (realProbe === null) {
      throw new WorkflowStorageError('Path escapes the workflow storage.', 403);
    }
    const physical = path.relative(realRoot, realProbe);
    if (physical.startsWith('..') || path.isAbsolute(physical)) {
      throw new WorkflowStorageError('Path escapes the workflow storage.', 403);
    }

    // The leaf, and every component under the root, must not be a symlink.
    // Checked component by component: a symlinked DIRECTORY in the middle that
    // happens to point back inside the root is still refused, because the
    // workspace must be plain files a rename/delete can reason about.
    if (rel) {
      let cur = this.root;
      for (const seg of rel.split('/')) {
        cur = path.join(cur, seg);
        let st: Stats;
        try {
          st = await fs.lstat(cur);
        } catch {
          // Not there. Fine for a creation target's leaf; otherwise it is a 404.
          if (opts.mustExist !== false) {
            throw new WorkflowStorageError('No such file or folder.', 404);
          }
          return { absolute, relative: rel, stat: null };
        }
        if (st.isSymbolicLink()) {
          throw new WorkflowStorageError('Symbolic links are not allowed in a workflow workspace.', 403);
        }
        if (cur === absolute) return { absolute, relative: rel, stat: st };
        if (!st.isDirectory()) {
          throw new WorkflowStorageError('No such file or folder.', 404);
        }
      }
    }
    const st = await fs.lstat(absolute);
    return { absolute, relative: rel, stat: st };
  }

  private async entryOf(dirAbs: string, dirRel: string, d: Dirent): Promise<WorkflowEntry | null> {
    const abs = path.join(dirAbs, d.name);
    let st: Stats;
    try {
      st = await fs.lstat(abs);
    } catch {
      return null;
    }
    // Symlinks and specials are not shown at all: a row the operator cannot
    // open, rename or delete through this API is a row that lies.
    if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) return null;
    return {
      name: d.name,
      path: dirRel ? `${dirRel}/${d.name}` : d.name,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      modifiedAt: st.mtime.toISOString(),
    };
  }

  /** List a folder. Folders first, then files, both alphabetical. */
  async list(relative: unknown = ''): Promise<WorkflowListing> {
    const { absolute, relative: rel, stat } = await this.resolve(relative);
    if (!stat || !stat.isDirectory()) throw new WorkflowStorageError('Not a folder.', 400);
    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    const rows: WorkflowEntry[] = [];
    for (const d of dirents) {
      const e = await this.entryOf(absolute, rel, d);
      if (e) rows.push(e);
    }
    rows.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    const parent = rel ? toPosix(path.posix.dirname(rel)).replace(/^\.$/, '') : null;
    return { workflowId: this.workflowId, path: rel, parent, entries: rows };
  }

  /** Create a folder inside `parentRelative`. */
  async mkdir(parentRelative: unknown, name: string): Promise<WorkflowEntry> {
    const seg = assertSegment(name);
    const parent = await this.resolve(parentRelative);
    if (!parent.stat || !parent.stat.isDirectory()) throw new WorkflowStorageError('Not a folder.', 400);
    const rel = parent.relative ? `${parent.relative}/${seg}` : seg;
    const target = await this.resolve(rel, { mustExist: false });
    if (target.stat) throw new WorkflowStorageError('Something with that name already exists.', 409);
    await fs.mkdir(target.absolute);
    const st = await fs.lstat(target.absolute);
    return { name: seg, path: rel, type: 'dir', size: 0, modifiedAt: st.mtime.toISOString() };
  }

  /**
   * Write a file into `parentRelative`.
   *
   * `overwrite: false` is the default: uploading `a.txt` twice yields `a (2).txt`
   * rather than silently replacing the first.
   */
  async writeFile(
    parentRelative: unknown,
    name: string,
    bytes: Buffer,
    opts: { overwrite?: boolean } = {},
  ): Promise<WorkflowEntry> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new WorkflowStorageError('The uploaded file was empty.');
    }
    if (bytes.length > MAX_WORKFLOW_FILE_BYTES) {
      throw new WorkflowStorageError(
        `File is too large (${bytes.length} bytes). The limit is ${MAX_WORKFLOW_FILE_BYTES} bytes.`,
      );
    }
    const seg = assertSegment(sanitizeFileName(name));
    const parent = await this.resolve(parentRelative);
    if (!parent.stat || !parent.stat.isDirectory()) throw new WorkflowStorageError('Not a folder.', 400);

    let finalName = seg;
    if (!opts.overwrite) {
      const ext = path.extname(seg);
      const stem = ext ? seg.slice(0, -ext.length) : seg;
      for (let n = 2; ; n += 1) {
        const rel = parent.relative ? `${parent.relative}/${finalName}` : finalName;
        const probe = await this.resolve(rel, { mustExist: false });
        if (!probe.stat) break;
        if (n > 1000) throw new WorkflowStorageError('Too many files with that name.', 409);
        finalName = `${stem} (${n})${ext}`;
      }
    }
    const rel = parent.relative ? `${parent.relative}/${finalName}` : finalName;
    const target = await this.resolve(rel, { mustExist: false });
    if (target.stat && target.stat.isDirectory()) {
      throw new WorkflowStorageError('A folder with that name already exists.', 409);
    }
    // write-then-rename so a crash mid-write never leaves a truncated file the
    // operator would later upload to a site believing it whole.
    const tmp = `${target.absolute}.${process.pid}.${Date.now()}.part`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, target.absolute);
    const st = await fs.lstat(target.absolute);
    return { name: finalName, path: rel, type: 'file', size: st.size, modifiedAt: st.mtime.toISOString() };
  }

  /** Rename a file or folder IN PLACE (same parent). */
  async rename(relative: unknown, newName: string): Promise<WorkflowEntry> {
    const seg = assertSegment(newName);
    const src = await this.resolve(relative);
    if (!src.relative) throw new WorkflowStorageError('The workspace root cannot be renamed.', 400);
    const parentRel = path.posix.dirname(src.relative).replace(/^\.$/, '');
    const dstRel = parentRel ? `${parentRel}/${seg}` : seg;
    if (dstRel === src.relative) {
      return this.describe(src.relative);
    }
    const dst = await this.resolve(dstRel, { mustExist: false });
    if (dst.stat) throw new WorkflowStorageError('Something with that name already exists.', 409);
    await fs.rename(src.absolute, dst.absolute);
    return this.describe(dstRel);
  }

  /**
   * Delete a file, or a folder.
   *
   * A non-empty folder needs `recursive: true` — the UI asks for an explicit
   * confirmation before sending it, and the API refuses without it so a stray
   * DELETE cannot wipe a tree by accident.
   */
  async remove(relative: unknown, opts: { recursive?: boolean } = {}): Promise<void> {
    const target = await this.resolve(relative);
    if (!target.relative) throw new WorkflowStorageError('The workspace root cannot be deleted.', 400);
    if (target.stat && target.stat.isDirectory()) {
      const inside = await fs.readdir(target.absolute);
      if (inside.length && !opts.recursive) {
        throw new WorkflowStorageError('The folder is not empty.', 409);
      }
      await fs.rm(target.absolute, { recursive: true, force: false });
      return;
    }
    await fs.unlink(target.absolute);
  }

  /** Stat one entry. */
  async describe(relative: unknown): Promise<WorkflowEntry> {
    const { absolute, relative: rel, stat } = await this.resolve(relative);
    if (!stat) throw new WorkflowStorageError('No such file or folder.', 404);
    return {
      name: rel ? path.posix.basename(rel) : '',
      path: rel,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  /**
   * The file a browser file dialog should be handed.
   *
   * Only a regular FILE resolves: a folder cannot go into an `<input type=file>`
   * and a symlink was already refused by resolve(). The absolute path returned
   * here is for `FileChooser.setFiles()` and must never be sent to a client.
   */
  async resolveForBrowser(relative: unknown): Promise<ResolvedWorkflowFile> {
    const { absolute, relative: rel, stat } = await this.resolve(relative);
    if (!stat || !stat.isFile()) throw new WorkflowStorageError('Only a file can be selected.', 400);
    void absolute;
    return {
      absolutePath: await fs.realpath(absolute),
      name: path.posix.basename(rel),
      size: stat.size,
      relativePath: rel,
    };
  }
}
