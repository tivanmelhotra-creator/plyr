/**
 * DownloadHeaders — remembers what the WEBSITE said a file is called.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator's requirement is absolute: a file downloaded in the remote
 * browser must reach their machine with «نام واقعی و Extension واقعی که خود
 * Website اعلام کرده» — the real name and real extension the website itself
 * declared — generically, for every format, with no per-format special cases.
 *
 * The shelf used to take that name from Playwright's `download.suggestedFilename()`.
 * MEASURED (tools/probe-dl-final.js), 40 cases = 8 real `Content-Disposition`
 * shapes × 5 ways a site starts a download (anchor, same-tab navigation,
 * `target=_blank`, form POST, `window.open`):
 *
 *     download.suggestedFilename()       25/40 correct  (63%)
 *     the response's Content-Disposition  40/40 correct (100%)
 *
 * `suggestedFilename()` returns the literal string `download` for EVERY name
 * carried in RFC 5987 form (`filename*=UTF-8''…`) and for every raw-UTF-8
 * header — 15 of the 40 — so `فاکتور.xlsx` arrived as `download`, with no name
 * and no extension. That is the reported bug at its source: by the time
 * Playwright hands the name over the real one is already gone, so no amount of
 * downstream rescuing can recover it.
 *
 * This class is the missing source. It watches responses, keeps the
 * `Content-Disposition` and `Content-Type` of anything that looks like a file,
 * and lets the shelf ask by URL when a download starts.
 *
 * WHY `context.on('response')` AND NOT `page.on('response')`
 * ---------------------------------------------------------
 * MEASURED (tools/probe-dl-names2.js): a per-page listener missed 8/20
 * downloads, and every miss was a download that opens a NEW TAB — the page did
 * not exist when the listener was attached, so its response was never seen. A
 * context-level listener sees all of them.
 *
 * WHY NOT CDP
 * -----------
 * `Browser.downloadWillBegin` carries a `suggestedFilename` and looked like the
 * authoritative answer. MEASURED (tools/probe-dl-cdp.js) it is strictly worse:
 * 4/15 correct, AND enabling `Browser.setDownloadBehavior{eventsEnabled:true}`
 * SUPPRESSED Playwright's own `download` event, which is what claims the bytes.
 * It would have broken a working shelf to get worse names. Rejected on evidence.
 */

import type { BrowserContext, Response } from 'playwright';

import { filenameFromContentDisposition } from './RemoteDownloads';

/** What a website declared about one response. */
export interface DeclaredFile {
  /** The name from `Content-Disposition`, already RFC 6266-decoded. `''` if none. */
  name: string;
  /** The response's own `Content-Type`, parameters included. `''` if none. */
  contentType: string;
}

/**
 * How many responses to remember.
 *
 * Only responses that actually declare a filename, or are marked as an
 * attachment, are kept (see `record`) — so this is not "every request on the
 * page". A long session must still not grow without bound; oldest go first.
 */
const MAX_REMEMBERED = 200;

/**
 * A URL-keyed memory of what each response said it was.
 *
 * Keyed by URL because that is the only identifier shared between a `response`
 * event and the `download` event that follows it — a Playwright `Download`
 * exposes `url()` and nothing else that could be correlated.
 */
export class DownloadHeaderIndex {
  private byUrl = new Map<string, DeclaredFile>();

  /**
   * Start remembering declarations from every page in this context.
   *
   * Called once per browser, at launch, before anything can navigate: attaching
   * late is the measured way to miss a download's headers entirely.
   */
  watch(ctx: BrowserContext): void {
    ctx.on('response', (res: Response) => {
      try {
        this.record(res.url(), res.headers());
      } catch {
        // A response whose headers cannot be read tells us nothing, and must
        // never break the navigation it belongs to.
      }
    });
  }

  /**
   * Remember one response, if it says anything worth remembering.
   *
   * Split from `watch` so it can be driven directly by a test with plain data —
   * no browser, no network — because the mapping from headers to a remembered
   * name is the part that was wrong before.
   */
  record(url: string, headers: Record<string, string>): void {
    const key = String(url || '');
    if (!key) return;

    // Header names arrive lower-cased from Playwright, but a hand-built map (in
    // a test, or from another caller) may not be, and a case-sensitive lookup
    // would silently find nothing — the exact class of silent failure this
    // module exists to remove.
    const get = (want: string): string => {
      const direct = headers ? headers[want] : '';
      if (typeof direct === 'string') return direct;
      for (const k of Object.keys(headers || {})) {
        if (k.toLowerCase() === want) return String(headers[k] ?? '');
      }
      return '';
    };

    const disposition = get('content-disposition');
    const contentType = get('content-type');
    const name = filenameFromContentDisposition(disposition);

    // Keep a response only when it can actually help name a file: it either
    // declared a filename, or it is an `attachment` (a download whose name must
    // then come from its type). Remembering every HTML page and every image on
    // every site would be a leak with no benefit — the shelf only ever asks
    // about URLs that became downloads.
    const isAttachment = /^\s*attachment\b/i.test(disposition);
    if (!name && !isAttachment) return;

    // Re-inserting moves the entry to the end, so "oldest first" eviction stays
    // true for a URL that is downloaded repeatedly.
    if (this.byUrl.has(key)) this.byUrl.delete(key);
    this.byUrl.set(key, { name, contentType });

    while (this.byUrl.size > MAX_REMEMBERED) {
      const oldest = this.byUrl.keys().next();
      if (oldest.done) break;
      this.byUrl.delete(oldest.value);
    }
  }

  /** What the website declared for this URL, or `null` if it said nothing. */
  lookup(url: string): DeclaredFile | null {
    return this.byUrl.get(String(url || '')) || null;
  }

  /**
   * Forget one URL's declaration.
   *
   * Called once a download has been named, so a page that serves a DIFFERENT
   * file from the same URL later cannot inherit the first file's name. Without
   * this, an endpoint like `/export` — which legitimately returns a new report
   * every time — would keep handing out the first report's filename.
   */
  forget(url: string): void {
    this.byUrl.delete(String(url || ''));
  }

  /** How many declarations are held. For tests and diagnostics. */
  size(): number {
    return this.byUrl.size;
  }
}
