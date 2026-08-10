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

// ─────────────────────────────────────────────────────────────────────────────
// Rescuing a name the browser could not supply
//
// REPORTED, then MEASURED (2026-08-10): a user downloaded a PNG through the
// live browser and received a file called `download` with no suffix at all.
// The bytes were perfect — renaming it to `.png` by hand opened a valid image.
//
// The primary cause was the process locale, fixed at the launch sites (see
// withUtf8Locale in core/BrowserProfile). But there is a SECOND, independent
// way to end up with no extension, which no locale can fix: the site never
// sent a name. Measured, WITH a correct UTF-8 locale:
//
//     GET /api/export     octet-stream  ->  suggestedFilename() === "export"
//     GET /files/         octet-stream  ->  suggestedFilename() === "download"
//     GET /f/9f2c4d18-…   octet-stream  ->  suggestedFilename() === "9f2c4d18-…"
//
// Each of those is a real file the user's OS then refuses to open, because on
// Windows and macOS the suffix — not the content — chooses the application.
//
// We can do better than Chrome here, because by the time the file is named we
// have something Chrome did not have at the moment the download began: THE
// BYTES. Also measured — a Playwright Download exposes exactly `page, url,
// suggestedFilename, path, saveAs, failure, createReadStream, cancel, delete`,
// so the response's Content-Type is NOT reachable; the bytes are the only
// remaining honest signal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File signatures, chosen for being unambiguous at a fixed offset.
 *
 * Deliberately a SHORT list. A wrong extension is worse than a missing one — a
 * `.png` that is really something else is a lie the user's OS will act on — so
 * only formats with a distinctive magic number appear here, and anything not
 * recognised gets no extension at all.
 */
const MAGIC: ReadonlyArray<{ ext: string; at: number; bytes: number[] }> = [
  { ext: '.png', at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: '.jpg', at: 0, bytes: [0xff, 0xd8, 0xff] },
  { ext: '.gif', at: 0, bytes: [0x47, 0x49, 0x46, 0x38] },           // GIF8
  { ext: '.pdf', at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },     // %PDF-
  { ext: '.webp', at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },          // ....WEBP
  { ext: '.zip', at: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },           // PK..
  { ext: '.gz', at: 0, bytes: [0x1f, 0x8b] },
  { ext: '.mp4', at: 4, bytes: [0x66, 0x74, 0x79, 0x70] },           // ....ftyp
  { ext: '.ico', at: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
  { ext: '.bmp', at: 0, bytes: [0x42, 0x4d] },                       // BM
];

/**
 * Name the format these bytes are in, or `''` when unsure.
 *
 * `''` on doubt is the whole contract: guessing would attach a suffix that
 * tells the user's OS to open the file with the wrong application, which is a
 * worse outcome than the missing suffix this sets out to fix.
 */
export function extensionFromBytes(head: Buffer): string {
  for (const sig of MAGIC) {
    if (head.length < sig.at + sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (head[sig.at + i] !== sig.bytes[i]) { ok = false; break; }
    }
    if (ok) return sig.ext;
  }
  return '';
}

/**
 * The extension implied by a download URL's own path, if it has one.
 *
 * Only the PATH is read. A query string sometimes carries a filename
 * (`/dl?file=photo.png`) but far more often carries `?v=1.2` or `?sig=…`, and
 * treating those as a suffix produces names like `download.2`.
 */
export function extensionFromUrl(url: string): string {
  try {
    return extensionOf(path.basename(new URL(String(url || '')).pathname));
  } catch {
    return '';
  }
}

/**
 * Give a saved download a usable name when the browser could not.
 *
 * Sources in order of trustworthiness, stopping at the first answer:
 *   1. the name already HAS an extension     → keep it untouched
 *   2. the URL path ends in one              → the site's own choice
 *   3. the bytes identify the format         → the only truth left
 *   4. nothing is certain                    → change nothing
 *
 * Step 4 is not a failure. A name with no suffix is inconvenient; a name with
 * the WRONG suffix actively misleads, so silence beats a guess.
 *
 * Renames in place and returns the final basename, so the shelf row, the
 * `Content-Disposition` header and the file on disk cannot drift apart — three
 * names for one file is how a download becomes unreachable.
 */
export async function ensureUsableExtension(filePath: string, url: string): Promise<string> {
  const current = path.basename(filePath);
  if (extensionOf(current)) return current;

  let ext = extensionFromUrl(url);
  if (!ext) {
    // Only the first bytes: enough for every signature above, and it must not
    // read a 250MB file into memory to look at 12 of them.
    let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      fh = await fs.open(filePath, 'r');
      const head = Buffer.alloc(16);
      const { bytesRead } = await fh.read(head, 0, 16, 0);
      ext = extensionFromBytes(head.subarray(0, bytesRead));
    } catch {
      ext = '';                      // unreadable: keep the name we have
    } finally {
      if (fh) await fh.close().catch(() => { /* nothing better to do */ });
    }
  }
  if (!ext) return current;

  // Re-run the sanitiser: the suffix is new input joining a trusted name, and
  // safeFileName is the single place that decides what a name may contain.
  const renamed = safeFileName(current + ext);
  if (!renamed || renamed === current) return current;
  // MEASURED: safeFileName caps a name at 120 characters, and it cuts from the
  // END — so a 118-character name gained `.pn` instead of `.png`. That is the
  // one outcome this whole function exists to prevent: a suffix that is not the
  // format, which sends the user's OS to the wrong application. A name too long
  // to carry its own extension keeps the name and goes without.
  if (!renamed.endsWith(ext)) return current;
  try {
    await fs.rename(filePath, path.join(path.dirname(filePath), renamed));
  } catch {
    return current;                  // rename failed: the bytes still matter more
  }
  return renamed;
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

/**
 * Build a `Content-Disposition` value that Node will actually accept.
 *
 * WHY THIS EXISTS — MEASURED, and it is the whole of a reported bug.
 * -----------------------------------------------------------------
 * An HTTP header is a latin1 field. Node enforces that: `res.setHeader` THROWS
 * `Invalid character in header content ["Content-Disposition"]` for any byte
 * above 0xff. The download route used to interpolate the raw filename into the
 * `filename="…"` parameter, so a file whose name is not ASCII made the whole
 * response die — the throw happened before any bytes were sent, Express turned
 * it into a 500, and the user (who had, entirely reasonably, downloaded a file
 * with a Persian name) got a download that failed on every attempt.
 *
 * MEASURED against this server, same fixture, only the name changed:
 *
 *     GET /browser/downloads/dl_…  "report.pdf"                -> 200
 *     GET /browser/downloads/dl_…  "seedream-5.0-pro_a_مهدی.png" -> 500
 *       {"success":false,
 *        "error":"Invalid character in header content [\"Content-Disposition\"]"}
 *
 * That 500 is the message the user reported verbatim. It was NOT a browser
 * problem and not a CSP problem: the server refused to build the header.
 *
 * THE FIX, and why it keeps the real name
 * ---------------------------------------
 * RFC 6266 already answers this, and both halves matter:
 *
 *   filename="…"      MUST be ASCII. Non-representable characters are replaced
 *                     with `_`. This is the fallback for ancient clients.
 *   filename*=UTF-8'' MUST be percent-encoded ASCII, and carries the REAL name.
 *
 * Every browser in use today prefers `filename*`, so the user still receives
 * `seedream-5.0-pro_a_مهدی.png` — the ASCII copy is never the name they see.
 * Percent-encoding is what makes the second parameter safe: `encodeURIComponent`
 * cannot emit a high byte, a quote, a CR or an LF, so it cannot throw here and
 * cannot inject a header either.
 *
 * Control characters are stripped from the ASCII half for a second reason: a CR
 * or LF in a header value is response splitting, and the name originates in a
 * remote server's own `Content-Disposition` (see the module header above), i.e.
 * it is hostile input.
 */
export function contentDispositionAttachment(filename: string): string {
  const raw = String(filename == null ? '' : filename);
  // Anything outside printable ASCII becomes `_`, then quotes/backslashes too,
  // so the quoted-string cannot be terminated early.
  // eslint-disable-next-line no-control-regex
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim();
  const fallback = ascii || 'download';
  return `attachment; filename="${fallback}"; `
    + `filename*=UTF-8''${encodeURIComponent(raw || fallback)}`;
}

/**
 * Read a filename back OUT of a remote server's `Content-Disposition`.
 *
 * The inverse of the function above, and needed because "Save image as" fetches
 * a URL server-side: the response's own header is the same one Chrome would
 * have obeyed, so honouring it is what makes the saved name match what a real
 * browser would have produced.
 *
 * `filename*` wins when both are present, exactly as RFC 6266 requires and as
 * every current browser does — the ASCII `filename` is a deliberately lossy
 * copy in which `صفحه.png` may appear as `_____.png`.
 *
 * The result is NOT trusted as a path: it is a remote server's string, so the
 * caller passes it through `safeFileName` before it reaches a filesystem.
 */
export function filenameFromContentDisposition(header: string): string {
  const s = String(header || '');
  // RFC 5987 ext-value: charset'language'percent-encoded-value.
  const star = /filename\*\s*=\s*([^;]+)/i.exec(s);
  if (star) {
    const v = star[1].trim();
    const m = /^([\w-]*)'[^']*'(.*)$/.exec(v);
    if (m) {
      try {
        const decoded = decodeURIComponent(m[2]);
        if (decoded.trim()) return decoded.trim();
      } catch { /* malformed percent-encoding: fall through to the ASCII copy */ }
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(s) || /filename\s*=\s*([^;]+)/i.exec(s);
  return plain ? plain[1].trim() : '';
}
