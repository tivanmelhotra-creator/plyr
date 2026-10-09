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
  nameFromUrl,
} from './RemoteDownloads';
import { safeFileName, extensionOf } from './RemoteUploads';
import { DownloadHeaderIndex } from './DownloadHeaders';
import { persistDownload, realChromeWorkflowForTransfer } from './WorkflowBinding';

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
  /** Where the workflow's own copy went (`downloads/<name>`), when bound. */
  workflowPath?: string;
  /**
   * Set when the browser WAS bound to a workflow but the copy into
   * `<workflow>/downloads/` failed. The shelf copy is still safe, but a row
   * that silently lacked its workflow copy is exactly the "downloaded, yet not
   * in the workspace" report, so the failure is now visible on the row.
   */
  workflowError?: string;
  /**
   * `extension` for a file an EXTENSION produced (see core/ExtensionDownloads);
   * absent for an ordinary page download. Informational only: both kinds go
   * through the same naming, cap and workflow-persist steps below.
   *
   * `browser` for a download core/ChromiumDownloadObserver filed that no page
   * reported and that did not come from an extension frame.
   */
  source?: 'extension' | 'browser';
}

/**
 * A finished download that reached the shelf WITHOUT a Playwright `Download`
 * object — i.e. one Chrome performed on behalf of an extension's service
 * worker, which has no page and therefore never emits `page.on('download')`.
 * See core/ExtensionDownloads for the measurement.
 */
export interface AdoptedDownload {
  /** Where Chrome itself wrote the bytes (a bare GUID under DOWNLOADS_DIR). */
  sourcePath: string;
  url: string;
  /** The `filename` the extension passed to `chrome.downloads.download`. */
  requestedName: string;
  /** Chrome's own `DownloadItem.mime`. */
  contentType: string;
  /** Non-empty when Chrome reported the download as interrupted. */
  error: string;
  /** Row label; defaults to `extension` (the original adopt() caller). */
  source?: 'extension' | 'browser';
}

/**
 * A download `track()` took, remembered so the extension bridge does not adopt
 * it again. Its Chrome file is resolved lazily through `path`.
 */
interface TrackedClaim {
  key: string;
  at: number;
  /** claimBytes failed: no file exists, only an interrupted report can match. */
  failed: boolean;
  /** Set once `path` has been asked; '' until then. */
  resolvedPath: string;
  /** Resolves when claimBytes has succeeded or failed. */
  settled: Promise<void>;
  settle: () => void;
  path: () => Promise<string>;
}

/**
 * `dl.path()`, called at most once however many parties ask (claimBytes'
 * fallback and the extension bridge's de-duplication share it). Resolves to ''
 * for no artifact, never rejects.
 */
function memoisedPath(dl: Download): () => Promise<string> {
  let memo: Promise<string> | null = null;
  return () => {
    if (!memo) {
      memo = (async () => {
        try { return (await dl.path()) || ''; } catch { return ''; }
      })();
    }
    return memo;
  };
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
/**
 * The name the WEBSITE declared, preferred over the one Chrome guessed.
 *
 * WHY THE ORDER IS THIS WAY — MEASURED, and it is the whole reported bug.
 * ----------------------------------------------------------------------
 * The requirement is «نام واقعی و Extension واقعی که خود Website اعلام کرده» —
 * whatever the website itself declared. MEASURED (tools/probe-dl-final.js) over
 * 40 cases (8 `Content-Disposition` shapes × 5 ways a site starts a download):
 *
 *     download.suggestedFilename()       25/40 correct  (63%)
 *     the response's Content-Disposition  40/40 correct (100%)
 *
 * `suggestedFilename()` returns the literal `download` for every RFC 5987
 * (`filename*=UTF-8''…`) and raw-UTF-8 name — 15 of the 40, `فاکتور.xlsx`
 * among them. So the header comes FIRST and Chrome's guess is the fallback.
 *
 * The declared name is still only a NAME: it came from a remote server, so the
 * caller sanitises it before it touches a filesystem.
 */
export function preferDeclaredName(declared: string, suggested: string): string {
  const fromSite = String(declared || '').trim();
  const fromChrome = String(suggested || '').trim();
  if (!fromSite) return fromChrome;

  // A declared name that already carries an extension is the best answer
  // available, full stop.
  if (extensionOf(fromSite)) return fromSite;

  // The site named the file but gave no suffix, while Chrome's guess has one
  // (Chrome derives one from the response type: MEASURED, `application/rtf`
  // with no filename became `rtf.rtf`). Keep the SITE's name and borrow only
  // the suffix, so `export` + `export.xlsx` becomes `export.xlsx` instead of
  // discarding either half.
  const ext = extensionOf(fromChrome);
  if (ext) {
    const stem = fromChrome.slice(0, fromChrome.length - ext.length);
    // Only when Chrome was talking about the same file. If the two names
    // disagree, the site's own name wins untouched and `ensureUsableExtension`
    // decides the suffix from the bytes or the type — inventing a pairing here
    // could staple a `.pdf` onto an unrelated name.
    if (!stem || stem === fromSite) return fromSite + ext;
  }
  return fromSite;
}

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

  /**
   * What each website declared its files are called.
   *
   * The single most important input to naming a download correctly — see
   * `preferDeclaredName` for the 63% vs 100% measurement.
   */
  private readonly headers = new DownloadHeaderIndex();

  /**
   * Downloads Playwright handed us, so a second observer does not file them
   * twice.
   *
   * WHY THIS EXISTS: core/ExtensionDownloads watches `chrome.downloads` from
   * inside the extensions, and that API sees EVERY download in the profile.
   * A download an extension TAB starts arrives here through
   * `page.on('download')` AND is later reported by the bridge; it must be
   * filed once.
   *
   * WHY BY FILE AND NOT BY URL: a URL is not the identity of a download. The
   * first version of this spent one "credit" per URL, and a website download
   * of `https://host/export.json` left a credit that nobody ever spent (the
   * bridge ignores website downloads). A service-worker export of the SAME
   * http(s) URL a few seconds later then looked "already claimed" and was
   * dropped: bytes finished on disk under a GUID, and never reached the
   * workflow. data:/blob: exports hid the bug because their URL is new every
   * time. MEASURED: Chrome's `DownloadItem.filename` and Playwright's
   * `Download.path()` are the SAME absolute path (`<downloadsPath>/<guid>`),
   * so that path is the identity used here.
   */
  private readonly tracked = new Map<string, TrackedClaim[]>();

  /**
   * Chrome files a PAGE download already owns, remembered after the first
   * `claimedByPage` match.
   *
   * WHY: two observers now ask. core/ExtensionDownloads (chrome.downloads) and
   * core/ChromiumDownloadObserver (the browser's own download events) can both
   * report the same extension-tab download. The first match spends the claim;
   * without this the second would find no claim left and adopt the file a
   * second time. Bounded like `tracked`.
   */
  private readonly pageFiles = new Set<string>();

  /**
   * Chrome files already adopted (or being adopted), so two observers that
   * report the same file produce ONE row. Keyed by Chrome's own path.
   */
  private readonly adoptedSources = new Map<string, ShelfEntry>();
  static readonly CLAIM_TTL_MS = 10 * 60 * 1000;
  /** How long `claimedByPage` waits for a tracked download to settle. */
  static readonly CLAIM_WAIT_MS = 5_000;

  /**
   * Was this finished download already taken by `track()`? Spends the claim
   * when it was.
   *
   * Only tracked downloads of the SAME URL are candidates, and each one's
   * Chrome file is resolved LAZILY, here, through the download's shared
   * memoised `path()`. `track()`'s own happy path never calls `path()` (the
   * documented saveAs -> path() fallback order in claimBytes); only an
   * extension report that could be a duplicate of a page download asks.
   * Waits (bounded) for those candidates to settle first, so the answer does
   * not depend on which observer heard about completion first.
   */
  async claimedByPage(
    report: { filePath: string; urls: string[]; interrupted: boolean },
    waitMs = RealChromeShelf.CLAIM_WAIT_MS,
  ): Promise<boolean> {
    this.pruneClaims();
    const own = report.filePath && !report.interrupted ? path.resolve(report.filePath) : '';
    if (own && this.pageFiles.has(own)) return true;
    const keys = [...new Set(report.urls.filter(Boolean).map(downloadUrlKey))];
    const candidates = keys.flatMap((k) => this.tracked.get(k) || []);
    if (!candidates.length) return false;
    await Promise.race([
      Promise.allSettled(candidates.map((c) => c.settled)),
      new Promise((res) => setTimeout(res, waitMs)),
    ]);

    if (report.interrupted) {
      // A failed download has no file; only a FAILED tracked one can match.
      const hit = candidates.find((c) => c.failed);
      if (hit) { this.dropClaim(hit); return true; }
      return false;
    }

    const file = report.filePath ? path.resolve(report.filePath) : '';
    if (!file) return false;
    for (const c of candidates) {
      if (c.failed) continue;
      const p = await Promise.race([
        c.path(),
        new Promise<string>((res) => setTimeout(() => res(''), waitMs)),
      ]);
      if (p && path.resolve(p) === file) {
        this.dropClaim(c);
        this.rememberPageFile(file);
        return true;
      }
    }
    return false;
  }

  /**
   * Forget a WEBSITE download's claim once the bridge has seen it finish.
   * Never calls `path()`: a claim whose file was not already resolved simply
   * ages out (CLAIM_TTL_MS). Removing the whole URL's claims here would be
   * wrong — another tracked download of that URL may still be in flight.
   */
  releaseClaim(filePath: string, urls: string[] = []): void {
    const file = filePath ? path.resolve(filePath) : '';
    for (const k of new Set(urls.filter(Boolean).map(downloadUrlKey))) {
      for (const c of [...(this.tracked.get(k) || [])]) {
        if (file && c.resolvedPath && path.resolve(c.resolvedPath) === file) this.dropClaim(c);
      }
    }
  }

  /** Spend one FAILED tracked claim for any of these URL keys. */
  spendFailedClaim(keys: string[]): boolean {
    for (const k of keys) {
      const hit = (this.tracked.get(k) || []).find((c) => c.failed);
      if (hit) { this.dropClaim(hit); return true; }
    }
    return false;
  }

  private rememberPageFile(file: string): void {
    this.pageFiles.add(file);
    while (this.pageFiles.size > 2000) {
      const oldest = this.pageFiles.values().next().value;
      if (oldest === undefined) break;
      this.pageFiles.delete(oldest);
    }
  }

  private dropClaim(c: TrackedClaim): void {
    const list = this.tracked.get(c.key);
    if (!list) return;
    const i = list.indexOf(c);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.tracked.delete(c.key);
  }

  private pruneClaims(): void {
    const now = Date.now();
    let total = 0;
    for (const [k, list] of this.tracked) {
      const live = list.filter((c) => now - c.at < RealChromeShelf.CLAIM_TTL_MS);
      if (live.length) { this.tracked.set(k, live); total += live.length; } else this.tracked.delete(k);
    }
    // Bounded: a page in a download loop must not grow this forever.
    while (total > 2000) {
      const oldestKey = this.tracked.keys().next().value;
      if (oldestKey === undefined) break;
      total -= (this.tracked.get(oldestKey) || []).length;
      this.tracked.delete(oldestKey);
    }
  }

  /**
   * Remember a tracked download so the extension bridge does not adopt it a
   * second time. Deliberately does NOT call `dl.path()`: it stores the
   * download's memoised path resolver, shared with claimBytes' fallback, so
   * `path()` is called at most once per download and never on the happy path
   * of `track()` itself.
   */
  private registerClaim(url: string, pathOf: () => Promise<string>): TrackedClaim {
    const key = downloadUrlKey(url || '');
    let settle: () => void = () => {};
    const settled = new Promise<void>((res) => { settle = res; });
    const claim: TrackedClaim = {
      key,
      at: Date.now(),
      failed: false,
      resolvedPath: '',
      settled,
      settle: () => settle(),
      path: async () => {
        const p = await pathOf();
        claim.resolvedPath = p;
        return p;
      },
    };
    const list = this.tracked.get(key) || [];
    list.push(claim);
    this.tracked.set(key, list);
    this.pruneClaims();
    return claim;
  }

  /**
   * One workflow persist at a time.
   *
   * `WorkflowStorage.importFile` picks `name (2).ext` when `name.ext` exists,
   * but that is check-then-rename: two exports of the same filename finishing
   * together could both see the name as free and the second would replace the
   * first. Serialising the (fast, local) copy makes "same filename, several
   * times" deterministic: `a.json`, `a (2).json`, `a (3).json`.
   */
  private persistChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly userId: string) {}

  /** Declarations remembered so far. For tests and diagnostics. */
  declaredCount(): number {
    return this.headers.size();
  }

  /** Newest first — the file just downloaded is the one being looked for. */
  list(): ShelfEntry[] {
    return [...this.rows].reverse();
  }

  /**
   * Drop one row AND its bytes.
   *
   * The operator asked for «کنترل بیشتر» over this panel, and the only honest
   * answer is a control that changes the server: hiding a row while the file
   * stayed on disk would be a button that lies. So this deletes the directory
   * `discardDownload` owns and then forgets the row, in that order — a row that
   * is still listed after a failed delete is recoverable, whereas a forgotten
   * row whose bytes survived is a file nobody can reach or remove.
   *
   * Returns whether a row was actually removed, so the route can answer 404
   * instead of pretending it deleted something that was never here.
   */
  async forget(token: string): Promise<boolean> {
    const at = this.rows.findIndex((r) => r.token === token);
    if (at < 0) return false;
    await discardDownload(this.userId, token);
    this.rows.splice(at, 1);
    return true;
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
    // Responses FIRST, and at the context level. This is what learns the real
    // filename, and it must be listening before anything can navigate: MEASURED
    // (tools/probe-dl-names2.js) a per-page listener missed 8/20 downloads —
    // every one of them a download that opened a new tab, whose page did not
    // exist yet when a per-page listener would have been attached.
    this.headers.watch(ctx);
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

    // Claimed from the very first moment, so the extension bridge — which only
    // hears about a download when it COMPLETES — never adopts it a second time.
    // By Chrome's own file, not by URL (see `tracked`), resolved lazily: one
    // memoised `path()` shared with claimBytes' fallback, never called here.
    const pathOf = memoisedPath(dl);
    const claim = this.registerClaim(url, pathOf);

    // What the WEBSITE said this file is called, which is the answer whenever it
    // exists: 40/40 correct against suggestedFilename()'s 25/40. Chrome's guess
    // is only the fallback — it reports the literal string `download` for every
    // RFC 5987 and raw-UTF-8 name, which is the reported bug.
    const declared = this.headers.lookup(url);
    // An EXTENSION page (a popup opened as a tab) that exports through
    // `chrome.downloads.download({ url: blob:…, filename })` does reach
    // `page.on('download')`, but MEASURED the filename it asked for is lost:
    // suggestedFilename() is `b473cc79-….json`, a GUID. The extension's own
    // request is recorded by core/ExtensionDownloads and wins when present.
    const requested = await requestedNameFromExtensionPage(dl, url);
    const chosen = requested
      || preferDeclaredName(declared?.name || '', String(dl.suggestedFilename() || ''));
    // Sanitised BEFORE it reaches a filesystem or the UI, wherever it came from:
    // a name carrying a bidi override can make `report.exe` read as `report.txt`
    // on the shelf.
    const suggested = safeFileName(chosen) || 'download';

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
      try {
        await this.claimBytes(dl, target, pathOf);
      } catch (e) {
        // No bytes were claimed: this download can only match an INTERRUPTED
        // report, by URL.
        claim.failed = true;
        throw e;
      } finally {
        claim.settle();
      }
      await this.complete(entry, target, url, declared?.contentType || '');
    } catch (e) {
      // A failed download must SAY so. A row stuck at "in progress" forever is
      // how a user ends up waiting for something that will never arrive.
      entry.state = 'failed';
      entry.error = (e as Error)?.message || 'download_failed';
      claim.settle();
    }
    // The declaration has been used, so drop it. An endpoint like `/export`
    // legitimately returns a DIFFERENT file every time it is called, and keeping
    // the first response's name would make the second download inherit it.
    // Done after the try/catch so a failed download does not leave a stale name
    // behind for the retry either.
    this.headers.forget(url);
    return entry;
  }

  /**
   * Put a download Playwright never reported onto the shelf — through the SAME
   * steps `track()` uses.
   *
   * This is the Extension Download/Export path. MEASURED (see
   * core/ExtensionDownloads): `chrome.downloads.download()` called from an
   * extension's service worker writes the bytes to DOWNLOADS_DIR as a bare GUID
   * and emits NO `page.on('download')`, because a service worker is not a page.
   * The browser says "downloaded", the GUID sits on the server's disk, and the
   * workflow's `downloads/` never hears of it.
   *
   * Not a second download system: the bytes are MOVED into a token directory
   * exactly like a claimed Playwright download, and then `complete()` names,
   * caps and files them into `<workflow>/downloads/` identically.
   */
  async adopt(input: AdoptedDownload): Promise<ShelfEntry> {
    // One Chrome file, one row, however many observers report it.
    const sourceKey = input.sourcePath ? path.resolve(input.sourcePath) : '';
    const already = sourceKey ? this.adoptedSources.get(sourceKey) : undefined;
    if (already) return already;
    const url = String(input.url || '');
    const requested = String(input.requestedName || '');
    // `safeFileName('')` is the placeholder `file`, never '' — so an empty
    // request must not reach it (the Ask #13 bug, by a different road).
    const suggested = (requested && safeFileName(requested))
      || (isOpaqueUrl(url) ? 'download' : nameFromUrl(url));
    const entry: ShelfEntry = {
      token: mintDownloadToken(),
      name: suggested,
      url: displayUrl(url),
      state: 'inProgress',
      size: 0,
      error: '',
      at: Date.now(),
      source: input.source || 'extension',
    };
    if (sourceKey) {
      this.adoptedSources.set(sourceKey, entry);
      while (this.adoptedSources.size > 2000) {
        const oldest = this.adoptedSources.keys().next().value;
        if (oldest === undefined) break;
        this.adoptedSources.delete(oldest);
      }
    }
    this.rows.push(entry);
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);

    try {
      if (input.error) throw new Error(`extension_download_interrupted: ${input.error}`);
      if (!input.sourcePath) throw new Error('extension_download_missing_file');
      const target = await downloadPathFor(this.userId, entry.token, suggested);
      await moveFile(input.sourcePath, target);
      // A data:/blob: URL has no path to borrow a suffix from — and worse,
      // `extensionFromUrl('data:application/json;base64,…')` would read the
      // payload as a path. Chrome's own MIME type is the honest evidence.
      await this.complete(entry, target, isOpaqueUrl(url) ? '' : url, input.contentType || '');
    } catch (e) {
      entry.state = 'failed';
      entry.error = (e as Error)?.message || 'download_failed';
      // An interrupted download may still have left a partial GUID behind.
      if (input.sourcePath) await fs.rm(input.sourcePath, { force: true }).catch(() => {});
    }
    return entry;
  }

  /**
   * The shared tail of every download: name the format, enforce the cap, file
   * the workflow copy. One implementation, so a page download and an extension
   * export can never disagree about any of the three.
   */
  private async complete(entry: ShelfEntry, target: string, url: string, contentType: string): Promise<void> {
    // Chrome could not always name the FORMAT. A site that streams bytes with
    // no filename and no Content-Disposition leaves suggestedFilename() with
    // no extension at all — measured here as a bare GUID. The bytes are on
    // disk now, so the format can be identified from them, and the response's
    // own Content-Type is passed as the last resort below that: for a format
    // with no magic number (an .xlsx served as octet-stream, a .csv, an .rtf)
    // the header is the ONLY evidence that exists.
    const done = await finalizeDownloadName(target, url, contentType);
    entry.name = done.name;
    entry.size = done.size;
    // NOT 'completed' yet. The row is polled (the UI, nodes waiting for a
    // download, the browser tests' settled()). Flipping it here, before the
    // workflow copy below exists, let a reader see "completed" and then find
    // nothing in <workflow>/downloads/. REPRODUCED under CPU load: a missing
    // "x (3).json" and an ENOENT in the extension-download-export browser test.
    // The state changes only once BOTH copies are in place.

    if (entry.size > MAX_DOWNLOAD_BYTES) {
      // Over the cap: delete it rather than silently keep a quarter-gigabyte
      // the user never agreed to store, and say why instead of offering a
      // link that will fail.
      await discardDownload(this.userId, entry.token).catch(() => {});
      entry.state = 'failed';
      entry.error = 'download_too_large';
    } else {
      // THE WORKFLOW'S OWN COPY. The shelf is ephemeral (DOWNLOADS_DIR, TTL);
      // a browser bound to a saved workflow also files the download under
      // `<workflow>/downloads/`, which is the folder automation nodes read.
      // Awaited so the row is only reported complete once both copies exist,
      // but never fatal: the shelf copy is already safe. The binding is
      // re-read from the store here (S16): after a restart, or on a pm2
      // worker that did not take the /bind, memory alone says "nothing".
      const run = this.persistChain.then(async () => {
        const ref = await realChromeWorkflowForTransfer();
        const persisted = await persistDownload(ref, entry.name, done.path);
        if (persisted) entry.workflowPath = persisted.path;
        else if (ref) entry.workflowError = 'workflow_persist_failed';
      });
      this.persistChain = run.catch(() => { /* keep the chain alive */ });
      await run;
      entry.state = 'completed';
    }

    void sweepDownloads(this.userId).catch(() => { /* best-effort housekeeping */ });
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
  private async claimBytes(
    dl: Download,
    target: string,
    pathOf: () => Promise<string> = memoisedPath(dl),
  ): Promise<void> {
    try {
      await dl.saveAs(target);
      return;
    } catch (primary) {
      let src = '';
      try {
        src = (await pathOf()) || '';
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for extension-produced downloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The identity of a download URL for de-duplication, bounded in size.
 *
 * A `data:` URL IS the file and can be megabytes long; the extension bridge
 * reports it from inside the browser, so it is shortened there by the SAME
 * rule (installExtensionDownloadObserver) and both sides must agree exactly.
 * Short URLs are themselves; long ones keep a prefix, their length and a
 * 32-bit FNV-1a of the whole string.
 */
export function downloadUrlKey(u: string): string {
  const s = String(u || '');
  if (s.length <= 4096) return s;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return s.slice(0, 2048) + '#len=' + s.length + '#fnv=' + h.toString(16);
}

/** `data:` and `blob:` URLs carry no path a filename or suffix may come from. */
function isOpaqueUrl(url: string): boolean {
  return /^(data|blob):/i.test(String(url || ''));
}

/**
 * A `data:` URL is the whole file, and can be megabytes long. The shelf row
 * only needs to say where the file came from, so it keeps the scheme and type.
 */
function displayUrl(url: string): string {
  const s = String(url || '');
  if (/^data:/i.test(s)) return s.slice(0, s.indexOf(',') > 0 ? s.indexOf(',') : 64).slice(0, 128);
  return s.length > 2048 ? s.slice(0, 2048) : s;
}

/**
 * MOVE Chrome's GUID file into its token directory.
 *
 * A move and not a copy: nobody else owns this file (Playwright never saw the
 * download, so it will not clean it up), and leaving it would accumulate
 * nameless files in DOWNLOADS_DIR forever. `rename` first; across filesystems
 * (DOWNLOADS_TMP_DIR may live elsewhere) fall back to copy + unlink.
 */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e;
    await fs.copyFile(src, dest);
    await fs.rm(src, { force: true }).catch(() => {});
  }
}

/**
 * The filename an extension PAGE asked `chrome.downloads.download` for, if the
 * download came from one. Recorded in the page by the init script installed by
 * core/ExtensionDownloads; '' for every ordinary website download, which is
 * never even asked (the page check is synchronous and first).
 */
async function requestedNameFromExtensionPage(dl: Download, url: string): Promise<string> {
  let page: Page | null = null;
  try { page = dl.page(); } catch { page = null; }
  let pageUrl = '';
  try { pageUrl = page ? page.url() : ''; } catch { pageUrl = ''; }
  if (!page || !pageUrl.startsWith('chrome-extension://')) return '';
  try {
    const name = await Promise.race([
      page.evaluate(takeRequestedNameInPage, url),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 1500)),
    ]);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/** Runs INSIDE the extension page. Kept free of closures for `evaluate`. */
function takeRequestedNameInPage(u: string): string {
  const g = globalThis as unknown as {
    __plyrExtDl?: { byUrl?: Record<string, string[]> };
  };
  const list = g.__plyrExtDl && g.__plyrExtDl.byUrl && g.__plyrExtDl.byUrl[u];
  if (!list || !list.length) return '';
  return String(list.shift() || '');
}
