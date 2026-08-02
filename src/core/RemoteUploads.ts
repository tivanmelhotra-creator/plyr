/**
 * RemoteUploads — the file half of "the remote browser is not my computer".
 *
 * THE PROBLEM
 * -----------
 * The picker canvas is a screencast of a page running on the SERVER. When that
 * page opens a file dialog — a cookie extension's "Import" button, an avatar
 * upload, any `<input type="file">` — the dialog is drawn by the server's
 * Chrome, browses the SERVER's disk, and the user's own file is on a laptop
 * hundreds of kilometres away. Clicking Import therefore did nothing at all
 * that a user could see: no dialog in the canvas (a native dialog is not part
 * of the page and can never be screencast), and no way to reach their file.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 * Playwright intercepts the dialog (`page.on('filechooser')`), so instead of a
 * native window we get a promise waiting for a list of PATHS ON THE SERVER. The
 * missing piece is getting the user's bytes to a server path, which is what
 * this module owns:
 *
 *   1. the browser POSTs the file to /browser/uploads,
 *   2. we store it under a per-user directory with a server-generated name,
 *   3. the client gets back an opaque TOKEN, never a path,
 *   4. the WebSocket session turns the token back into a path and hands it to
 *      the waiting file chooser.
 *
 * WHY TOKENS AND NOT PATHS
 * ------------------------
 * The obvious design — client posts a file, gets `/tmp/x/y.json`, sends that
 * back over the socket — is an arbitrary-file-read: nothing stops a client from
 * skipping step 1 and sending `/etc/shadow`, or `../../../etc/shadow`, and the
 * page it uploads to may be attacker-chosen. So the socket never accepts a
 * path. It accepts a token matching a strict pattern, resolves it inside the
 * user's own directory, and re-checks containment after resolution.
 */

import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

import { config } from '../config';

/** Server-minted handle for one uploaded file. Never a filesystem path. */
export const TOKEN_RE = /^up_[a-f0-9]{24}(\.[A-Za-z0-9]{1,12})?$/;

/** Uploads older than this are swept: a paste-and-forget file is still a file. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Per-request cap. Cookie exports are kilobytes; this is room for a rich page. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * A user id is used as a directory name, so it gets the same treatment as a
 * filename: nothing but the safe alphabet survives. `..` collapses to `__`
 * rather than being rejected, because a rejection here would surface as a
 * mystery 500 on a legitimate-looking id.
 */
export function safeSegment(input: string): string {
  const s = String(input || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return s.slice(0, 64) || 'anon';
}

/** Where one user's uploads live. */
export function uploadDirFor(userId: string): string {
  return path.join(config.UPLOADS_DIR, 'remote', safeSegment(userId));
}

/**
 * Keep the extension and nothing else.
 *
 * The extension is not cosmetic: an `<input accept=".json">` and the page's own
 * validation both look at the name, so a cookie export that arrives as
 * `up_ab12cd…` with no suffix is rejected by the very extension we are trying
 * to feed. Everything before the dot is dropped — the original name is the
 * user's, and it is the part that can carry `..`, a NUL, or an RTL override.
 */
export function extensionOf(originalName: string): string {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

export function mintToken(originalName: string): string {
  return `up_${randomBytes(12).toString('hex')}${extensionOf(originalName)}`;
}

/**
 * The name the PAGE will see, derived from the user's own filename.
 *
 * The page reads `file.name`, and for a cookie-manager extension that name is
 * shown in its UI and sometimes checked before the import runs. Handing it
 * `up_3394762305982ec94dcfd115.json` technically works and looks broken — the user
 * chose `cookies.json` and has no idea what the other string is. So the name
 * survives, but only as a name: it is reduced to a basename, stripped of
 * everything that can traverse, terminate or reverse a path, and capped.
 */
export function safeFileName(originalName: string): string {
  const base = path.basename(String(originalName || '')).replace(/\\/g, '/');
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')     // control chars, incl. NUL
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '') // bidi overrides ("gpj.exe")
    .replace(/[/\\:*?"<>|]/g, '_')             // path + Windows-reserved
    .replace(/^\.+/, '')                       // no dotfiles, no "..", no "."
    .trim()
    .slice(0, 120);
  return cleaned || `file${extensionOf(originalName) || ''}`;
}

/**
 * Resolve a token to the DIRECTORY that holds one upload, or throw.
 *
 * Two independent checks, because either one alone has been enough to make this
 * class of bug in other projects: the pattern rejects anything that is not a
 * token we minted, and the containment check rejects anything that escapes the
 * directory even if the pattern were ever loosened.
 */
export function resolveUploadDir(userId: string, token: string): string {
  if (!TOKEN_RE.test(String(token || ''))) {
    throw new UploadError('Invalid upload token.');
  }
  const dir = uploadDirFor(userId);
  const full = path.resolve(dir, token);
  const rel = path.relative(path.resolve(dir), full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UploadError('Invalid upload token.');
  }
  return full;
}

/**
 * Resolve a token to the file the page should receive.
 *
 * One upload = one directory = one file, so the user's filename can be kept
 * without it ever being part of the lookup: the token alone decides WHICH
 * directory, and the directory has exactly one entry. A hostile name therefore
 * cannot select a different file, because it selects nothing at all.
 */
export async function resolveUpload(userId: string, token: string): Promise<string> {
  const dir = resolveUploadDir(userId, token);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new UploadError('That upload is no longer available.');
  }
  const name = entries[0];
  if (!name) throw new UploadError('That upload is no longer available.');
  return path.join(dir, name);
}

export interface StoredUpload {
  token: string;
  /** The name the user's browser reported, kept only to show it back to them. */
  name: string;
  size: number;
}

export async function saveUpload(
  userId: string,
  originalName: string,
  bytes: Buffer,
): Promise<StoredUpload> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new UploadError('The uploaded file was empty.');
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `File is too large (${bytes.length} bytes). The limit is ${MAX_UPLOAD_BYTES} bytes.`,
    );
  }
  const token = mintToken(originalName);
  const name = safeFileName(originalName);
  // One directory per upload: the token names the directory, the user's own
  // filename names the file inside it. That is what lets `file.name` in the
  // page read `cookies.json` while the lookup still goes through a token.
  const slot = path.join(uploadDirFor(userId), token);
  await fs.mkdir(slot, { recursive: true });
  await fs.writeFile(path.join(slot, name), bytes, { mode: 0o600 });
  // Opportunistic, never blocking the upload it was triggered by.
  void sweepUploads(userId).catch(() => { /* best-effort housekeeping */ });
  return { token, name, size: bytes.length };
}

/** Delete this user's uploads older than `maxAgeMs`. */
export async function sweepUploads(
  userId: string,
  maxAgeMs = UPLOAD_TTL_MS,
): Promise<number> {
  const dir = uploadDirFor(userId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!TOKEN_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        // Recursive: an upload is a directory holding one file.
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch { /* raced with another sweep */ }
  }
  return removed;
}

/** Remove specific uploads (a chooser consumed them, or the session ended). */
export async function discardUploads(userId: string, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      // resolveUploadDir, not resolveUpload: this must still clean up a slot
      // whose file has already vanished, and it must not throw at close().
      await fs.rm(resolveUploadDir(userId, token), { recursive: true, force: true });
    } catch { /* already gone, or never a valid token */ }
  }
}
