/**
 * RealChromeShelf — downloads for the REAL Chromium view.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator asked for the features the simulated browser already had, on the
 * new real-Chromium view:
 *
 *   «ما قبلا روی مرورگر شبیه سازی شده چند تا مورد رو پیاده کرده بودیم عبارتند
 *    از: الف) کپی/پیست ریموت ب) دانلود/آپلود یا امپورت/اکسپورت ریموت ...
 *    ما مشکلاتی مثل اسم و فرمت فایل های دانلود شده داشتیم که برطرف کرده بودیم
 *    الان میخام روی اینم اینا رو اجرا کنیم»
 *
 * The simulator solved the name/format problem in LiveBrowser.trackDownload.
 * The real-Chromium view had NO download handling at all, and the consequence
 * is not a cosmetic difference. MEASURED against Playwright's own
 * `launchPersistentContext(..., { acceptDownloads: true, downloadsPath })`,
 * which is exactly how RealChrome launches, serving a file as `report.png`:
 *
 *   DOWNLOAD_EVENT_FIRED  = true
 *   FILES_ON_DISK         = [{"rel":"19e8fe9b-3f65-4353-bad1-2ea627bc6549","size":67}]
 *   ANY_NAMED_report_png  = false
 *   AFTER_CLOSE_ENTRIES   = []
 *
 * So the file arrived as a bare GUID with NO NAME and NO EXTENSION — precisely
 * the «اسم و فرمت» complaint — and was then DELETED when the context closed,
 * because Playwright treats an unclaimed download as temporary. Three failures,
 * one cause: nobody was listening for the download.
 *
 * WHAT THIS DOES
 * --------------
 * Attaches the SAME pipeline the simulator uses, so both views produce
 * identical names and formats and share one fetch route:
 *
 *   safeFileName           the suggested name is a remote server's string
 *   downloadPathFor        one token = one directory = one file
 *   saveAs                 claims the bytes, so they survive the context closing
 *   ensureUsableExtension  names the FORMAT from the bytes when Chrome could not
 *
 * CLIPBOARD IS NOT HERE, ON PURPOSE
 * ---------------------------------
 * Remote copy/paste needs no server code. x11vnc already exchanges the X
 * CLIPBOARD and PRIMARY selections with the VNC client in BOTH directions by
 * default — the `-nosel`, `-noclipboard` and `-nosetclipboard` flags exist to
 * turn that off and we deliberately pass none of them — and noVNC exposes both
 * ends: a `clipboard` event for remote→local and `clipboardPasteFrom()` for
 * local→remote. The bridge to the operator's own clipboard is therefore a few
 * lines in the view itself; see ChromeView.ts.
 */

import path from 'path';
import { promises as fs } from 'fs';
import type { BrowserContext, Download, Page } from 'playwright';

import {
  downloadPathFor,
  ensureUsableExtension,
  mintDownloadToken,
  sweepDownloads,
  discardDownload,
  MAX_DOWNLOAD_BYTES,
} from './RemoteDownloads';
import { safeFileName } from './RemoteUploads';

/** One row of the shelf, as the view renders it. */
export interface ShelfEntry {
  /** Opaque, server-minted; the fetch URL is /browser/downloads/<token>. */
  token: string;
  /** The name on disk, on the shelf and in Content-Disposition — all one name. */
  name: string;
  url: string;
  state: 'inProgress' | 'completed' | 'failed';
  size: number;
  error: string;
  /** Epoch ms, so the view can show newest first. */
  at: number;
}

/** Newest-first, capped: a page in a download loop must not grow this forever. */
const MAX_ROWS = 40;

/**
 * Who owns the real Chromium's downloads.
 *
 * The real Chromium is ONE process-wide browser with ONE persistent profile,
 * shared by every caller (see RealChrome). It is single-tenant by construction,
 * so its shelf has exactly one owner; deriving the owner per-request instead
 * would write a file under one identity and then look for it under another,
 * which is the failure mode already documented on /browser/uploads ("Import
 * still does nothing" — a bare ENOENT at the hand-over). A fixed id keeps the
 * write and the read in the same directory in every deployment mode.
 */
export const REAL_CHROME_SHELF_USER = 'local';

/**
 * Decide the final name for a file that has just been written.
 *
 * Split out from the download handler because it is the part that was WRONG
 * before (a GUID with no extension) and therefore the part a test must be able
 * to drive directly, with real bytes on a real disk and no browser involved.
 */
export async function finalizeDownloadName(
  savedPath: string,
  url: string,
  contentType = '',
): Promise<{ name: string; path: string; size: number }> {
  const name = await ensureUsableExtension(savedPath, url, contentType);
  const full = path.join(path.dirname(savedPath), name);
  let size = 0;
  try {
    size = (await fs.stat(full)).size;
  } catch {
    /* size is a nicety; a missing stat must not fail the download */
  }
  return { name, path: full, size };
}

/**
 * The download shelf for one user's real-Chromium session.
 *
 * Deliberately NOT a singleton: the userId scopes where files are written, and
 * two users must never share a shelf or a directory.
 */
export class RealChromeShelf {
  private rows: ShelfEntry[] = [];
  private seen = new WeakSet<Page>();

  constructor(private readonly userId: string) {}

  /** Newest first — the file just downloaded is the one being looked for. */
  list(): ShelfEntry[] {
    return [...this.rows].reverse();
  }

  /**
   * Start watching a context for downloads.
   *
   * Per-PAGE, not per-context, and that is measured rather than stylistic:
   * LiveBrowser records (tools/probe-cdp4.js) that `context.on('download')`
   * NEVER fired in this setup while `page.on('download')` fired every time.
   * Existing pages are attached now and future ones as they appear, or a
   * download in a tab the user opened later would be silently dropped.
   */
  watch(ctx: BrowserContext): void {
    for (const p of ctx.pages()) this.watchPage(p);
    ctx.on('page', (p) => this.watchPage(p));
  }

  private watchPage(page: Page): void {
    // A context can emit 'page' for something already in pages(); attaching the
    // same listener twice would save every download twice, under two tokens.
    if (this.seen.has(page)) return;
    this.seen.add(page);
    page.on('download', (dl) => { void this.track(dl); });
  }

  /**
   * Claim a download, name it properly, and put it on the shelf.
   *
   * `saveAs` is what makes the bytes OURS. Without it Playwright deletes the
   * file when the context closes (MEASURED: AFTER_CLOSE_ENTRIES=[]), so even a
   * correctly named download would evaporate.
   */
  async track(dl: Download): Promise<ShelfEntry> {
    const url = (() => { try { return dl.url(); } catch { return ''; } })();
    // The suggested name comes from a remote server's Content-Disposition, so
    // it is sanitised BEFORE it reaches a filesystem or the UI: a name carrying
    // a bidi override can make `report.exe` read as `report.txt` on the shelf.
    const suggested = safeFileName(String(dl.suggestedFilename() || '')) || 'download';

    const entry: ShelfEntry = {
      token: mintDownloadToken(),
      name: suggested,
      url,
      state: 'inProgress',
      size: 0,
      error: '',
      at: Date.now(),
    };
    this.rows.push(entry);
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);

    try {
      const target = await downloadPathFor(this.userId, entry.token, suggested);
      await this.claimBytes(dl, target);

      // Chrome could not always name the FORMAT. A site that streams bytes with
      // no filename and no Content-Disposition leaves suggestedFilename() with
      // no extension at all — measured here as a bare GUID. The bytes are on
      // disk now, so the format can be identified from them.
      const done = await finalizeDownloadName(target, url);
      entry.name = done.name;
      entry.size = done.size;
      entry.state = 'completed';

      if (entry.size > MAX_DOWNLOAD_BYTES) {
        // Over the cap: delete it rather than silently keep a quarter-gigabyte
        // the user never agreed to store, and say why instead of offering a
        // link that will fail.
        await discardDownload(this.userId, entry.token).catch(() => {});
        entry.state = 'failed';
        entry.error = 'download_too_large';
      }

      void sweepDownloads(this.userId).catch(() => { /* best-effort housekeeping */ });
    } catch (e) {
      // A failed download must SAY so. A row stuck at "in progress" forever is
      // how a user ends up waiting for something that will never arrive.
      entry.state = 'failed';
      entry.error = (e as Error)?.message || 'download_failed';
    }
    return entry;
  }

  /**
   * Get the finished bytes to `target`, whatever it takes.
   *
   * `saveAs` is the right call and normally the only one needed. But it is a
   * MOVE of Playwright's temporary artifact, and that artifact can be gone by
   * the time we ask for it — MEASURED, with a second client attached to the same
   * browser:
   *
   *   download.saveAs: ENOENT: no such file or directory, copyfile
   *   '/home/user/webapp/downloads/31b1a110-...' -> '.../report.png'
   *
   * Whoever moved it first wins and the other client is left with nothing. Since
   * the real Chromium is a SHARED browser that anything may attach to, losing
   * the file to that race is not acceptable: the operator downloaded something
   * and it must appear on the shelf.
   *
   * So on failure we fall back to `path()`, which reports where the browser
   * itself put the file, and copy from there. Copy, not rename: the artifact may
   * still belong to another consumer.
   */
  private async claimBytes(dl: Download, target: string): Promise<void> {
    try {
      await dl.saveAs(target);
      return;
    } catch (primary) {
      let src = '';
      try {
        src = (await dl.path()) || '';
      } catch {
        /* no artifact to fall back to */
      }
      if (!src) throw primary;
      // Rethrow the ORIGINAL error if the fallback cannot help either: it names
      // the actual failure, whereas the copy error would only describe a
      // symptom of it.
      try {
        await fs.copyFile(src, target);
      } catch {
        throw primary;
      }
    }
  }
}
