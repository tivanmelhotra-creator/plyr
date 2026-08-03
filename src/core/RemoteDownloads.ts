/**
 * RemoteDownloads — the other half of "the remote browser is not my computer".
 *
 * THE PROBLEM
 * -----------
 * `RemoteUploads` solves getting the user's bytes ONTO the server so a page's
 * file chooser can read them. This module solves the mirror image: a page on the
 * server downloads a file, and in real Chrome that file lands in the user's
 * Downloads folder with a shelf at the bottom of the window showing its name,
 * its size and a progress bar. Here the file lands on the SERVER's disk, so
 * without a way to fetch it a "download" is a file the user can neither see nor
 * reach — which is exactly what the session did before: nothing at all.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 *   1. `page.on('download')` fires (measured: the only Playwright download
 *      event that fires in this setup at all — `context.on('download')` never
 *      did, see docs/MEASURED-DECISIONS.md),
 *   2. the bytes are saved under a per-user, per-download directory here,
 *   3. the shelf row the client receives carries an opaque TOKEN, never a path,
 *   4. GET /browser/downloads/:token turns the token back into a path — via the
 *      session's own in-memory record, so a client can never name a file.
 *
 * WHY A DIRECTORY PER DOWNLOAD
 * ----------------------------
 * Same reason as uploads: the remote server chose the filename (it comes out of
 * a `Content-Disposition` header), so it is hostile input. Giving each download
 * its own token-named directory means the user's filename is only ever a NAME —
 * it cannot select a different file, because inside that directory it selects
 * nothing at all. It also means two downloads called `cookies.json` do not
 * silently overwrite each other, which is what Chrome avoids with its
 * `cookies (1).json` dance.
 */

import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

import { config } from '../config';
import { safeSegment, safeFileName, extensionOf } from './RemoteUploads';

/** Server-minted handle for one stored download. Never a filesystem path. */
export const DOWNLOAD_TOKEN_RE = /^dl_[a-f0-9]{24}$/;

/**
 * Downloads older than this are swept.
 *
 * Longer than the upload TTL on purpose: an upload is consumed within seconds
 * of being made, while a download is something the user may want to fetch after
 * reading the rest of the page. An hour was too short to be honest about the
 * shelf still working; a day is long enough to not be a lie and short enough to
 * not be a disk leak.
 */
export const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-download cap.
 *
 * A download is streamed to disk by Playwright, so this is not a memory bound —
 * it is a "do not let one page fill the server's disk" bound. Enforced by the
 * session after the fact (the size is only known once the bytes have landed),
 * which is why it lives here next to the paths rather than in the caller.
 */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export function mintDownloadToken(): string {
  return `dl_${randomBytes(12).toString('hex')}`;
}

/** Where one user's downloads live. */
export function downloadDirFor(userId: string): string {
  return path.join(config.DOWNLOADS_DIR, 'live', safeSegment(userId));
}

/**
 * Resolve a token to the directory that holds one download, or throw.
 *
 * Two independent checks, exactly as in `RemoteUploads.resolveUploadDir`: the
 * pattern rejects anything we did not mint, and the containment check rejects
 * anything that escapes the user's directory even if the pattern were ever
 * loosened. Belt and braces, because the cost of being wrong here is reading
 * arbitrary server files.
 */
export function resolveDownloadDir(userId: string, token: string): string {
  if (!DOWNLOAD_TOKEN_RE.test(String(token || ''))) {
    throw new DownloadError('Invalid download token.');
  }
  const dir = downloadDirFor(userId);
  const full = path.resolve(dir, token);
  const rel = path.relative(path.resolve(dir), full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DownloadError('Invalid download token.');
  }
  return full;
}

/**
 * Pick the absolute path a download should be saved to, creating its directory.
 *
 * `suggestedName` is the remote server's filename and is reduced by
 * `safeFileName` to a basename with nothing that can traverse, terminate or
 * reverse a path. If it survives as nothing at all (a name that was pure
 * punctuation, or empty) we fall back to `download` plus whatever extension the
 * original had, because the extension is not cosmetic: it is what decides
 * whether the user's own OS can open the file once they fetch it.
 */
export async function downloadPathFor(
  userId: string,
  token: string,
  suggestedName: string,
): Promise<string> {
  const dir = resolveDownloadDir(userId, token);
  const name = safeFileName(suggestedName) || `download${extensionOf(suggestedName)}`;
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * Resolve a token to the file the user asked to fetch.
 *
 * One download = one directory = one file, so the lookup never has to trust a
 * name. Returns both the path and the name, because the fetch route needs the
 * name for `Content-Disposition` — the user chose to download `report.pdf` and
 * should receive `report.pdf`, not `dl_9f2c…`.
 */
export async function resolveDownload(
  userId: string,
  token: string,
): Promise<{ path: string; name: string; size: number }> {
  const dir = resolveDownloadDir(userId, token);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new DownloadError('That download is no longer available.');
  }
  const name = entries[0];
  if (!name) throw new DownloadError('That download is no longer available.');
  const full = path.join(dir, name);
  let size = 0;
  try {
    size = (await fs.stat(full)).size;
  } catch {
    throw new DownloadError('That download is no longer available.');
  }
  return { path: full, name, size };
}

/** Delete this user's stored downloads older than `maxAgeMs`. */
export async function sweepDownloads(
  userId: string,
  maxAgeMs = DOWNLOAD_TTL_MS,
): Promise<number> {
  const dir = downloadDirFor(userId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  let removed = 0;
  for (const name of names) {
    if (!DOWNLOAD_TOKEN_RE.test(name)) continue;
    const slot = path.join(dir, name);
    try {
      const st = await fs.stat(slot);
      if (st.mtimeMs < cutoff) {
        await fs.rm(slot, { recursive: true, force: true });
        removed += 1;
      }
    } catch { /* raced with another sweep; nothing to do */ }
  }
  return removed;
}

/** Forget one stored download — the little x on a shelf row means gone. */
export async function discardDownload(userId: string, token: string): Promise<void> {
  let dir: string;
  try {
    dir = resolveDownloadDir(userId, token);
  } catch {
    return; // not a token we minted: there is nothing of ours to delete
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* already gone */ });
}
