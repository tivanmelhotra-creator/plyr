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
 *
 * SYSTEM FOLDERS: THE CONTRACT WITH AUTOMATION
 * --------------------------------------------
 * Every workspace is initialised with two folders whose names are fixed and
 * which automation nodes may rely on:
 *
 *     <root>/<userId>/<workflowId>/
 *     ├── uploads/     files staged as INPUT — what a page's <input type=file>
 *     │                is answered with, and where "Upload from Computer"
 *     │                persists its copy when the browser belongs to a workflow
 *     └── downloads/   what the browser DOWNLOADED from a site while running
 *                      for this workflow (finalised here from the ephemeral
 *                      DOWNLOADS_DIR shelf)
 *
 * They are ordinary directories on disk — listed like any other, browsable,
 * and files inside them may be renamed or deleted — but the folders themselves
 * cannot be renamed or deleted, and they are recreated on every ensureRoot().
 * Listings flag them with `system: true` so a UI can draw them apart.
 */

import { promises as fs, createReadStream, createWriteStream, type Dirent, type Stats } from 'fs';
import path from 'path';

import { config } from '../config';
import { isValidWorkflowId } from '../utils/redis-keys';
import { ZipStream } from './ZipStream';
import { ZipArchiveError, readZipArchive, isZipFileName, archiveStem } from './ZipArchive';

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
  /** True for the fixed `uploads/` and `downloads/` folders at the root. */
  system?: boolean;
}

/** The folder names every workspace is born with. Order is display order. */
export const SYSTEM_FOLDERS = ['uploads', 'downloads'] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];
export const UPLOADS_FOLDER: SystemFolder = 'uploads';
export const DOWNLOADS_FOLDER: SystemFolder = 'downloads';

/** Is this workflow-relative path one of the system folders themselves? */
export function isSystemFolder(rel: string): rel is SystemFolder {
  return (SYSTEM_FOLDERS as readonly string[]).includes(String(rel || ''));
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

  /**
   * Create the workflow directory — and its system folders — if not there yet.
   *
   * Idempotent and cheap (two mkdirs that usually do nothing), so it is safe
   * to call on every request; that is also what makes the contract hold for a
   * workspace created by an older version, or one whose `uploads/` the
   * operator deleted from a shell: the next request brings it back.
   */
  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    // If the root itself were replaced by a symlink pointing elsewhere, every
    // later check would be relative to the wrong place. Refuse to operate.
    const st = await fs.lstat(this.root);
    if (st.isSymbolicLink()) {
      throw new WorkflowStorageError('The workflow storage directory is not usable.', 500);
    }
    for (const name of SYSTEM_FOLDERS) {
      const p = path.join(this.root, name);
      let s: Stats | null = null;
      try { s = await fs.lstat(p); } catch { /* absent: create below */ }
      if (s && s.isSymbolicLink()) {
        throw new WorkflowStorageError(`The ${name} folder is not usable.`, 500);
      }
      if (s && !s.isDirectory()) {
        // A FILE squatting on the name would silently break every automation
        // node that writes into the folder. Move it aside rather than lose it.
        await fs.rename(p, `${p}.file`).catch(() => {});
        s = null;
      }
      if (!s) await fs.mkdir(p, { recursive: true });
    }
  }

  /** The workflow-relative path of a system folder — for callers that write into it. */
  systemFolder(which: SystemFolder): string {
    return which;
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
    const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
    const system = !dirRel && st.isDirectory() && isSystemFolder(rel);
    return {
      name: d.name,
      path: rel,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      modifiedAt: st.mtime.toISOString(),
      ...(system ? { system: true } : {}),
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
      // System folders first, in their declared order, so `uploads/` and
      // `downloads/` are always where the operator (and a node) expects them.
      const sa = a.system ? (SYSTEM_FOLDERS as readonly string[]).indexOf(a.name) : -1;
      const sb = b.system ? (SYSTEM_FOLDERS as readonly string[]).indexOf(b.name) : -1;
      if ((sa >= 0) !== (sb >= 0)) return sa >= 0 ? -1 : 1;
      if (sa >= 0 && sb >= 0) return sa - sb;
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
    opts: { overwrite?: boolean; allowEmpty?: boolean } = {},
  ): Promise<WorkflowEntry> {
    if (!Buffer.isBuffer(bytes) || (bytes.length === 0 && !opts.allowEmpty)) {
      throw new WorkflowStorageError('The uploaded file was empty.');
    }
    if (bytes.length > MAX_WORKFLOW_FILE_BYTES) {
      throw new WorkflowStorageError(
        `File is too large (${bytes.length} bytes). The limit is ${MAX_WORKFLOW_FILE_BYTES} bytes.`,
      );
    }
    const target = await this.claimTarget(parentRelative, name, !!opts.overwrite);
    // write-then-rename so a crash mid-write never leaves a truncated file the
    // operator would later upload to a site believing it whole.
    const tmp = `${target.absolute}.${process.pid}.${Date.now()}.part`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, target.absolute);
    return this.describe(target.rel);
  }

  /**
   * Create an EMPTY file — "New File" in the UI.
   *
   * Separate from writeFile because an empty UPLOAD is almost always a failed
   * transfer and is refused, whereas an empty new file is exactly what was
   * asked for. The name is the operator's own typing, so the strict rule.
   */
  async createFile(parentRelative: unknown, name: string, content = ''): Promise<WorkflowEntry> {
    const seg = assertSegment(name);
    return this.writeFile(parentRelative, seg, Buffer.from(String(content ?? ''), 'utf8'), { allowEmpty: true });
  }

  /**
   * Bring a file that already exists ON THIS SERVER into the workspace.
   *
   * This is how a browser download is finalised into `downloads/` and how an
   * "Upload from Computer" that went through the temporary transport is
   * persisted into `uploads/`. `sourceAbsolute` is a path the SERVER produced
   * (RemoteDownloads / RemoteUploads), never one a client sent. Copy, not
   * rename: the source may still be serving a token the operator's machine is
   * about to fetch, and the ephemeral sweeper owns its lifetime.
   */
  async importFile(
    parentRelative: unknown,
    name: string,
    sourceAbsolute: string,
  ): Promise<WorkflowEntry> {
    let src: Stats;
    try {
      src = await fs.stat(String(sourceAbsolute || ''));
    } catch {
      throw new WorkflowStorageError('The source file does not exist.', 404);
    }
    if (!src.isFile()) throw new WorkflowStorageError('The source is not a file.', 400);
    if (src.size > MAX_WORKFLOW_FILE_BYTES) {
      throw new WorkflowStorageError(
        `File is too large (${src.size} bytes). The limit is ${MAX_WORKFLOW_FILE_BYTES} bytes.`,
      );
    }
    const target = await this.claimTarget(parentRelative, name, false);
    const tmp = `${target.absolute}.${process.pid}.${Date.now()}.part`;
    await fs.copyFile(String(sourceAbsolute), tmp);
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, target.absolute);
    return this.describe(target.rel);
  }

  /**
   * Decide WHERE a new file goes: sanitised name, existing parent folder, and
   * — unless overwriting — a numbered name when the plain one is taken, so
   * uploading `a.txt` twice yields `a (2).txt` rather than replacing the first.
   */
  private async claimTarget(
    parentRelative: unknown,
    name: string,
    overwrite: boolean,
  ): Promise<{ absolute: string; rel: string }> {
    const seg = assertSegment(sanitizeFileName(name));
    const parent = await this.resolve(parentRelative);
    if (!parent.stat || !parent.stat.isDirectory()) throw new WorkflowStorageError('Not a folder.', 400);

    let finalName = seg;
    if (!overwrite) {
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
    return { absolute: target.absolute, rel };
  }

  /** Rename a file or folder IN PLACE (same parent). */
  async rename(relative: unknown, newName: string): Promise<WorkflowEntry> {
    const seg = assertSegment(newName);
    const src = await this.resolve(relative);
    if (!src.relative) throw new WorkflowStorageError('The workspace root cannot be renamed.', 400);
    if (isSystemFolder(src.relative)) {
      throw new WorkflowStorageError(`The ${src.relative} folder is part of the workflow and cannot be renamed.`, 400);
    }
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
    if (isSystemFolder(target.relative)) {
      throw new WorkflowStorageError(`The ${target.relative} folder is part of the workflow and cannot be deleted.`, 400);
    }
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
    const system = stat.isDirectory() && isSystemFolder(rel);
    return {
      name: rel ? path.posix.basename(rel) : '',
      path: rel,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ...(system ? { system: true } : {}),
    };
  }

  /**
   * Every entry UNDER a folder, depth-first, folders before their contents.
   *
   * This is what "Download folder" / "Download workspace" archive. Paths are
   * workflow-relative, so the caller can turn them into archive entry names
   * with nothing but the prefix stripped. Symlinks and specials are skipped
   * exactly as in list(): an archive must not carry a row the tree does not
   * show. Empty folders ARE included, so the archive preserves them.
   */
  async walk(relative: unknown = ''): Promise<WorkflowEntry[]> {
    const { absolute, relative: rel, stat } = await this.resolve(relative);
    if (!stat || !stat.isDirectory()) throw new WorkflowStorageError('Not a folder.', 400);
    const out: WorkflowEntry[] = [];
    const visit = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
      for (const d of dirents) {
        const e = await this.entryOf(dirAbs, dirRel, d);
        if (!e) continue;
        out.push(e);
        if (e.type === 'dir') await visit(path.join(dirAbs, d.name), e.path, depth + 1);
      }
    };
    await visit(absolute, rel, 0);
    return out;
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

  // ── Organise: Move ─────────────────────────────────────────────────────────
  //
  // `destinationRelativePath` is always a FOLDER inside the SAME workflow. Every
  // source is resolved by the same resolve() as everything else, so traversal,
  // absolute paths and symlinks are refused before a rename is attempted, and a
  // destination the resolve() would not accept is refused the same way. This is
  // a real filesystem move (fs.rename), never a download+re-upload: the bytes
  // never leave the disk.
  //
  // Conflicts are REFUSED, never overwritten: moving `a.txt` onto an existing
  // `a.txt` is a 409 the operator can act on, not a silent data loss. All
  // sources are validated before the first rename, so a bulk move that would
  // conflict half-way changes nothing at all.

  /** Move every path into `destDir` (a folder relative path; '' is the root). */
  async moveMany(paths: unknown[], destDir: unknown): Promise<WorkflowEntry[]> {
    const rels = this.cleanBulk(paths);
    const dest = await this.resolve(destDir);
    if (!dest.stat || !dest.stat.isDirectory()) throw new WorkflowStorageError('The destination is not a folder.', 400);

    type Pair = { srcRel: string; srcAbs: string; dstRel: string; dstAbs: string };
    const pairs: Pair[] = [];
    const seen = new Set<string>();
    for (const rel of rels) {
      const src = await this.resolve(rel);
      if (!src.relative) throw new WorkflowStorageError('The workspace root cannot be moved.', 400);
      if (isSystemFolder(src.relative)) {
        throw new WorkflowStorageError(`The ${src.relative} folder is part of the workflow and cannot be moved.`, 400);
      }
      if (seen.has(src.relative)) continue;
      seen.add(src.relative);

      const leaf = path.posix.basename(src.relative);
      const dstRel = dest.relative ? `${dest.relative}/${leaf}` : leaf;
      if (dstRel === src.relative) {
        throw new WorkflowStorageError(`“${src.relative}” is already in that folder.`, 409);
      }
      if (src.stat && src.stat.isDirectory()
        && (dest.relative === src.relative || dest.relative.startsWith(`${src.relative}/`))) {
        throw new WorkflowStorageError('A folder cannot be moved inside itself.', 400);
      }
      const dst = await this.resolve(dstRel, { mustExist: false });
      if (dst.stat) throw new WorkflowStorageError(`Something named “${leaf}” is already in that folder.`, 409);
      pairs.push({ srcRel: src.relative, srcAbs: src.absolute, dstRel, dstAbs: dst.absolute });
    }
    if (!pairs.length) throw new WorkflowStorageError('No paths were given.', 400);

    const out: WorkflowEntry[] = [];
    for (const p of pairs) {
      await fs.rename(p.srcAbs, p.dstAbs);
      out.push(await this.describe(p.dstRel));
    }
    return out;
  }

  // ── Organise: Copy / Duplicate ─────────────────────────────────────────────
  //
  // Server-side, inside WorkflowStorage: the client sends only relative paths,
  // and the tree is walked HERE. Folders are copied recursively and their
  // structure is preserved. A copied name NEVER overwrites an existing one:
  //
  //   Copy       `a.txt` into a folder that has one -> `a (2).txt`  (numbered,
  //              the same convention an upload uses — see claimTarget)
  //   Duplicate  `config.json` beside itself        -> `config copy.json`
  //
  // Symlinks are skipped as the listing skips them, so a copy cannot carry a
  // link out of the workspace, and a copy into the source's own subtree is
  // refused rather than allowed to recurse forever.

  /**
   * Copy each path into `destDir`. `style` decides the name when it is taken.
   */
  async copyMany(
    paths: unknown[],
    destDir: unknown,
    opts: { style?: 'numbered' | 'copy' } = {},
  ): Promise<WorkflowEntry[]> {
    const rels = this.cleanBulk(paths);
    const style = opts.style === 'copy' ? 'copy' : 'numbered';
    const dest = await this.resolve(destDir);
    if (!dest.stat || !dest.stat.isDirectory()) throw new WorkflowStorageError('The destination is not a folder.', 400);

    type Pair = { srcAbs: string; srcRel: string; dstRel: string; dstAbs: string; isDir: boolean };
    const pairs: Pair[] = [];
    const seen = new Set<string>();
    for (const rel of rels) {
      const src = await this.resolve(rel);
      if (!src.relative) throw new WorkflowStorageError('The workspace root cannot be copied.', 400);
      if (seen.has(src.relative)) continue;
      seen.add(src.relative);

      const isDir = !!(src.stat && src.stat.isDirectory());
      if (isDir && (dest.relative === src.relative || dest.relative.startsWith(`${src.relative}/`))) {
        throw new WorkflowStorageError('A folder cannot be copied inside itself.', 400);
      }
      const leaf = path.posix.basename(src.relative);
      const dstLeaf = await this.freeLeaf(dest.relative, leaf, style);
      const dstRel = dest.relative ? `${dest.relative}/${dstLeaf}` : dstLeaf;
      const dst = await this.resolve(dstRel, { mustExist: false });
      pairs.push({ srcAbs: src.absolute, srcRel: src.relative, dstRel, dstAbs: dst.absolute, isDir });
    }
    if (!pairs.length) throw new WorkflowStorageError('No paths were given.', 400);

    // Stage the complete operation outside the workspace tree. A failed walk,
    // read, or entry budget can therefore never leave a partial destination.
    const stageRoot = await fs.mkdtemp(path.join(this.root, '.workflow-copy-'));
    const committed: string[] = [];
    try {
      const budget = { left: config.WORKFLOW_ZIP_MAX_ENTRIES };
      for (const p of pairs) {
        const staged = path.join(stageRoot, path.posix.basename(p.dstRel));
        if (p.isDir) await this.copyTree(p.srcAbs, staged, budget);
        else await this.copyFile(p.srcAbs, staged);
      }
      for (const p of pairs) {
        const staged = path.join(stageRoot, path.posix.basename(p.dstRel));
        await fs.rename(staged, p.dstAbs);
        committed.push(p.dstAbs);
      }
      const out: WorkflowEntry[] = [];
      for (const p of pairs) out.push(await this.describe(p.dstRel));
      await fs.rm(stageRoot, { recursive: true, force: true });
      return out;
    } catch (e) {
      for (const abs of committed.reverse()) await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
      await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /**
   * Duplicate ONE entry beside itself: `config.json` -> `config copy.json`,
   * `config copy.json` if taken. Folders are copied recursively.
   */
  async duplicate(relative: unknown): Promise<WorkflowEntry> {
    const src = await this.resolve(relative);
    if (!src.relative) throw new WorkflowStorageError('The workspace root cannot be duplicated.', 400);
    const parentRel = path.posix.dirname(src.relative).replace(/^\.$/, '');
    const leaf = path.posix.basename(src.relative);
    const name = await this.freeLeaf(parentRel, leaf, 'copy');
    const dstRel = parentRel ? `${parentRel}/${name}` : name;
    const dst = await this.resolve(dstRel, { mustExist: false });
    if (dst.stat) throw new WorkflowStorageError('Something with that name already exists.', 409);
    // Duplicate uses the same staged, operation-level atomic path as Copy.
    const [entry] = await this.copyMany([src.relative], parentRel, { style: 'copy' });
    if (entry.path !== dstRel) {
      throw new WorkflowStorageError('The duplicate destination changed during the operation.', 409);
    }
    return entry;
  }

  /** Recursively copy a directory. Symlinks and specials are SKIPPED. */
  private async copyTree(srcAbs: string, dstAbs: string, budget: { left: number }): Promise<void> {
    await fs.mkdir(dstAbs, { mode: 0o700 });
    const dirents = await fs.readdir(srcAbs, { withFileTypes: true });
    for (const d of dirents) {
      if (budget.left <= 0) {
        throw new WorkflowStorageError(`The copy is larger than the ${config.WORKFLOW_ZIP_MAX_ENTRIES} entries allowed.`, 413);
      }
      budget.left -= 1;
      const from = path.join(srcAbs, d.name);
      const to = path.join(dstAbs, d.name);
      let st: Stats;
      try { st = await fs.lstat(from); } catch { continue; }
      // A link the tree does not show must not appear in a copy either.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await this.copyTree(from, to, budget);
      else if (st.isFile()) await this.copyFile(from, to);
    }
  }

  /** One file, copied byte for byte with the workspace's own permissions. */
  private async copyFile(srcAbs: string, dstAbs: string): Promise<void> {
    const tmp = `${dstAbs}.${process.pid}.${Date.now()}.part`;
    await fs.copyFile(srcAbs, tmp);
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, dstAbs);
  }

  /** A leaf name that does not exist under `parentRel`, in the requested style. */
  private async freeLeaf(parentRel: string, name: string, style: 'numbered' | 'copy'): Promise<string> {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const candidate = (n: number): string => {
      if (style === 'copy') return `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
      return n <= 1 ? name : `${stem} (${n})${ext}`;
    };
    const start = style === 'copy' ? 1 : 1;
    for (let n = start; n <= 1000; n += 1) {
      const leaf = candidate(n);
      const rel = parentRel ? `${parentRel}/${leaf}` : leaf;
      const probe = await this.resolve(rel, { mustExist: false });
      if (!probe.stat) return leaf;
    }
    throw new WorkflowStorageError('Too many files with that name.', 409);
  }

  // ── Archive: Compress -> ZIP ───────────────────────────────────────────────
  //
  // Build ONE .zip FROM the selected workspace items, INTO the same workspace.
  // The client sends relative paths only; every one is resolved here, and the
  // output is created through the same resolve()+claim path as any other new
  // file, so it cannot land outside the workflow root. Entry names are the
  // selected paths relative to `base` (the folder on screen), exactly as the
  // download ZIP names them, so an archive made here extracts to what was seen.
  //
  // Compression is streaming (core/ZipStream) and the archive is written to a
  // `.part` file then RENAMED into place, so a crash mid-archive never leaves a
  // half-written .zip the operator would later try to open.

  /** Archive `paths` (relative to `base`) into `<destDir>/<name>.zip`. */
  async compress(
    paths: unknown[],
    opts: { base?: unknown; destDir?: unknown; name?: unknown } = {},
  ): Promise<WorkflowEntry> {
    const rels = this.cleanBulk(paths);
    const base = normalizeRelativePath(opts.base ?? '');
    const destDir = opts.destDir === undefined ? base : normalizeRelativePath(opts.destDir);
    const dest = await this.resolve(destDir);
    if (!dest.stat || !dest.stat.isDirectory()) throw new WorkflowStorageError('The destination is not a folder.', 400);

    // Collect every archive entry BEFORE anything is written: a bad path must
    // be a clean 4xx, not a truncated archive with an error glued to its tail.
    const strip = base ? `${base}/` : '';
    const entryName = (rel: string) => (strip && rel.startsWith(strip) ? rel.slice(strip.length) : rel);

    type Job = { name: string; isDir: boolean; abs: string; mtime: Date };
    const jobs: Job[] = [];
    const seen = new Set<string>();
    for (const rel of rels) {
      const r = await this.resolve(rel);
      if (!r.stat) throw new WorkflowStorageError('No such file or folder.', 404);
      if (seen.has(r.relative)) continue;
      seen.add(r.relative);
      if (r.stat.isDirectory()) {
        if (r.relative && r.relative !== base) {
          jobs.push({ name: entryName(r.relative), isDir: true, abs: '', mtime: r.stat.mtime });
        }
        for (const e of await this.walk(r.relative)) {
          if (e.type === 'dir') {
            jobs.push({ name: entryName(e.path), isDir: true, abs: '', mtime: new Date(e.modifiedAt) });
          } else {
            const rf = await this.resolveForBrowser(e.path);
            jobs.push({ name: entryName(e.path), isDir: false, abs: rf.absolutePath, mtime: new Date(e.modifiedAt) });
          }
        }
      } else {
        const rf = await this.resolveForBrowser(r.relative);
        jobs.push({ name: entryName(r.relative), isDir: false, abs: rf.absolutePath, mtime: r.stat.mtime });
      }
      if (jobs.length > config.WORKFLOW_ZIP_MAX_ENTRIES) {
        throw new WorkflowStorageError(`At most ${config.WORKFLOW_ZIP_MAX_ENTRIES} entries per archive.`, 413);
      }
    }
    if (!jobs.some((j) => !j.isDir)) {
      throw new WorkflowStorageError('There is nothing to compress.', 400);
    }

    const fallback = `${base ? path.posix.basename(base) : this.workflowId}.zip`;
    let wanted = String(opts.name ?? '').trim() || fallback;
    if (!wanted.toLowerCase().endsWith('.zip')) wanted = `${wanted}.zip`;
    const seg = assertSegment(wanted);
    const leaf = await this.freeLeaf(dest.relative, seg, 'numbered');
    const rel = dest.relative ? `${dest.relative}/${leaf}` : leaf;
    const target = await this.resolve(rel, { mustExist: false });

    await this.writeZip(target.absolute, jobs);
    return this.describe(rel);
  }

  /** Stream `jobs` into a ZIP at `destAbs` via a `.part` file, then rename. */
  private async writeZip(destAbs: string, jobs: Array<{ name: string; isDir: boolean; abs: string; mtime: Date }>): Promise<void> {
    const tmp = `${destAbs}.${process.pid}.${Date.now()}.part`;
    const out = createWriteStream(tmp, { mode: 0o600 });
    try {
      const zip = new ZipStream(out);
      for (const j of jobs) {
        if (j.isDir) await zip.addDirectory(j.name, { mtime: j.mtime });
        else await zip.addFile(j.name, createReadStream(j.abs), { mtime: j.mtime });
      }
      await zip.finish();
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject);
        out.end(() => resolve());
      });
    } catch (e) {
      out.destroy();
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
    await fs.rename(tmp, destAbs);
  }

  // ── Archive: Extract <- ZIP ────────────────────────────────────────────────
  //
  // Unpack a `.zip` that is IN the workspace into the workspace. The archive is
  // parsed by core/ZipArchive, which refuses absolute names, backslash names and
  // any `.`/`..` segment outright — a zip-slip cannot even be represented. Every
  // surviving entry is then resolved by THIS class's resolve() before a byte is
  // written, so the final destination is proven to be inside the workflow root,
  // and an existing symlink in the way is refused. Nothing is ever created as a
  // symlink.
  //
  // Pathological archives are bounded before decompression: config caps the
  // input size, the declared total expansion and the entry count, and zlib is
  // given a hard output cap per entry, so a header that understates its size
  // cannot defeat the limit. Conflicts are REFUSED (409) and nothing is written
  // when any destination file already exists, so an extract never clobbers.

  /** Extract a `.zip` into `into`, or beside itself / into a new folder. */
  async extractZip(
    relative: unknown,
    opts: { into?: unknown; mode?: 'here' | 'folder' } = {},
  ): Promise<WorkflowExtractResult> {
    const file = await this.resolveForBrowser(relative);
    if (!isZipFileName(file.name)) {
      throw new WorkflowStorageError('Only a .zip file can be extracted.', 400);
    }
    if (file.size > config.WORKFLOW_ZIP_MAX_INPUT_BYTES) {
      throw new WorkflowStorageError(
        `That archive is too large to extract (${file.size} bytes). The limit is ${config.WORKFLOW_ZIP_MAX_INPUT_BYTES} bytes.`,
        413,
      );
    }

    const buffer = await fs.readFile(file.absolutePath);
    let entries;
    try {
      entries = readZipArchive(buffer, {
        maxEntries: config.WORKFLOW_ZIP_MAX_ENTRIES,
        maxTotalUncompressedBytes: config.WORKFLOW_ZIP_MAX_TOTAL_BYTES,
        maxEntryUncompressedBytes: config.WORKFLOW_ZIP_MAX_TOTAL_BYTES,
      });
    } catch (e) {
      if (e instanceof ZipArchiveError) throw new WorkflowStorageError(e.message, e.status);
      throw e;
    }
    const filesIn = entries.filter((e) => !e.isDirectory && e.name).length;
    if (filesIn > config.WORKFLOW_ZIP_MAX_FILES) {
      throw new WorkflowStorageError(
        `The archive holds ${filesIn} files, more than the ${config.WORKFLOW_ZIP_MAX_FILES} allowed.`, 413,
      );
    }

    const parentRel = path.posix.dirname(file.relativePath).replace(/^\.$/, '');

    // Where does it go?  `into` is explicit and wins; otherwise the mode picks
    // "beside the archive" or "a new folder named after the archive".
    let intoRel: string;
    if (opts.into !== undefined && opts.into !== null && String(opts.into) !== '') {
      intoRel = normalizeRelativePath(opts.into);
      const probe = await this.resolve(intoRel, { mustExist: false });
      if (probe.stat && !probe.stat.isDirectory()) {
        throw new WorkflowStorageError('A file is in the way of that folder name.', 409);
      }
    } else if (opts.mode === 'folder') {
      const stem = await this.freeLeaf(parentRel, archiveStem(file.name), 'numbered');
      intoRel = parentRel ? `${parentRel}/${stem}` : stem;
      const probe = await this.resolve(intoRel, { mustExist: false });
      if (probe.stat && !probe.stat.isDirectory()) {
        throw new WorkflowStorageError('A file is in the way of that folder name.', 409);
      }
    } else {
      intoRel = parentRel;
      const probe = await this.resolve(intoRel, { mustExist: false });
      if (probe.stat && !probe.stat.isDirectory()) {
        throw new WorkflowStorageError('A file is in the way of that folder name.', 409);
      }
    }

    // Validate EVERY entry before writing anything. The archive bytes are still
    // bounded by ZipArchive; only after validation do we stage the files.
    type Plan = { dstRel: string; dstAbs: string; data: Buffer; isDir: boolean };
    const plans: Plan[] = [];
    let directories = 0;
    for (const e of entries) {
      if (!e.name) continue;
      const dstRel = intoRel ? `${intoRel}/${e.name}` : e.name;
      const dst = await this.resolve(dstRel, { mustExist: false });
      if (dst.stat) {
        if (dst.stat.isDirectory() && e.isDirectory) { directories += 1; continue; }
        throw new WorkflowStorageError(`“${e.name}” already exists in the destination.`, 409);
      }
      if (e.isDirectory) { directories += 1; plans.push({ dstRel, dstAbs: dst.absolute, data: Buffer.alloc(0), isDir: true }); continue; }
      plans.push({ dstRel, dstAbs: dst.absolute, data: e.data, isDir: false });
    }

    const stageRoot = await fs.mkdtemp(path.join(this.root, '.workflow-extract-'));
    const committedFiles: string[] = [];
    const createdDirs: string[] = [];
    const ensureParent = async (abs: string): Promise<void> => {
      const parts: string[] = [];
      let cursor = path.dirname(abs);
      while (cursor !== this.root && cursor.startsWith(`${this.root}${path.sep}`)) {
        parts.unshift(cursor);
        cursor = path.dirname(cursor);
      }
      for (const dir of parts) {
        try { await fs.lstat(dir); }
        catch { await fs.mkdir(dir, { mode: 0o700 }); createdDirs.push(dir); }
      }
    };
    try {
      for (const p of plans) {
        if (p.isDir) await fs.mkdir(path.join(stageRoot, p.dstRel), { recursive: true, mode: 0o700 });
        else {
          const staged = path.join(stageRoot, p.dstRel);
          await fs.mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
          await fs.writeFile(staged, p.data, { mode: 0o600 });
        }
      }
      for (const p of plans) {
        const staged = path.join(stageRoot, p.dstRel);
        if (p.isDir) {
          await ensureParent(p.dstAbs);
          try { await fs.lstat(p.dstAbs); } catch { await fs.mkdir(p.dstAbs, { mode: 0o700 }); createdDirs.push(p.dstAbs); }
        } else {
          await ensureParent(p.dstAbs);
          await fs.rename(staged, p.dstAbs);
          committedFiles.push(p.dstAbs);
        }
      }
      await fs.rm(stageRoot, { recursive: true, force: true });
    } catch (e) {
      for (const abs of committedFiles.reverse()) await fs.rm(abs, { force: true }).catch(() => {});
      for (const abs of createdDirs.reverse()) await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
      await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      throw e;
    }

    return {
      workflowId: this.workflowId,
      folder: intoRel,
      files: plans.filter((p) => !p.isDir).length,
      directories,
      skipped: entries.length - plans.length,
    };
  }

  /** A bulk request's paths: non-empty, deduped later, and bounded in count. */
  private cleanBulk(paths: unknown[]): string[] {
    if (!Array.isArray(paths)) throw new WorkflowStorageError('Paths must be a list.', 400);
    const rels = paths.map((p) => String(p ?? '')).filter((p) => p.length > 0);
    if (!rels.length) throw new WorkflowStorageError('No paths were given.', 400);
    if (rels.length > config.WORKFLOW_BULK_MAX_PATHS) {
      throw new WorkflowStorageError(`At most ${config.WORKFLOW_BULK_MAX_PATHS} paths per request.`, 400);
    }
    return rels;
  }
}

/** What extractZip produced. Paths are workflow-relative. */
export interface WorkflowExtractResult {
  workflowId: string;
  /** The folder the archive was unpacked into ('' is the root). */
  folder: string;
  /** Files written. */
  files: number;
  /** Directories created or already present. */
  directories: number;
  /** Archive entries that were the archive's own root and so not written. */
  skipped: number;
}
