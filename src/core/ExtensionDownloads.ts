/**
 * ExtensionDownloads — Extension Download/Export into the SAME pipeline as a
 * web page's download.
 *
 * THE REPORT
 * ----------
 * Download/Export from a normal website reaches `<workflow>/downloads/`.
 * Export from a Chrome EXTENSION (a cookie manager's "Export", for example)
 * makes the browser say "downloaded", the file may even be sitting in the
 * server's download directory, and yet it never reaches the workflow.
 *
 * ROOT CAUSE — MEASURED, Chromium 145 / Playwright persistent context with
 * `acceptDownloads: true, downloadsPath`, exactly as RealChrome launches:
 *
 *   how the extension downloads                      page.on   bytes on disk
 *   ---------------------------------------------------------------------------
 *   chrome.downloads.download() in its SERVICE WORKER   NO     GUID, unnamed,
 *                                                                never claimed
 *   chrome.downloads.download() in an extension TAB     yes    name = GUID.json
 *                                                                (filename lost)
 *   <a download> click in an extension tab              yes    correct
 *   <a download> click on a website                     yes    correct
 *
 * The whole Local Browser download pipeline (RealChromeShelf.track → name →
 * cap → persistDownload → `<workflow>/downloads/`) is driven by
 * `page.on('download')`. A service worker is not a page, so Playwright has
 * nowhere to emit the event: MEASURED, 0 events, while Chrome wrote the bytes
 * to DOWNLOADS_DIR under a bare GUID and reported success to the extension.
 * Nothing ever claimed that file, so nothing named it or filed it. `context
 * .on('download')` does not exist in this setup (docs/MEASURED-DECISIONS.md)
 * and a passive browser-level CDP session receives no `Browser.download*`
 * events either (MEASURED: []); taking over `Browser.setDownloadBehavior` is
 * already known to SUPPRESS Playwright's own page events, which would break
 * the working HTML path.
 *
 * WHAT THIS DOES
 * --------------
 * It asks the one party that DOES see every download: the extension itself.
 * For each extension service worker that has the `downloads` API, a tiny
 * observer is installed with `worker.evaluate` that
 *
 *   1. wraps `chrome.downloads.download` to remember the `filename` the
 *      extension asked for (Chrome discards it under Playwright's
 *      allowAndName policy — `onDeterminingFilename` never fires, MEASURED);
 *   2. listens to `chrome.downloads.onChanged` and reports each download that
 *      reaches `complete` or `interrupted`, with Chrome's own file path.
 *
 * Node long-polls those reports, and for each one that did NOT already arrive
 * through `page.on('download')` it calls `RealChromeShelf.adopt()` — which
 * moves the GUID into a token directory and then runs the very same
 * name/cap/persist tail as a page download. There is one pipeline, not two.
 *
 * The same wrapper is installed into extension PAGES with an init script, so
 * the case where Playwright does fire (an extension tab) also gets the name the
 * extension asked for instead of a GUID.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 * -----------------------------------
 * Ordinary website downloads. `chrome.downloads` sees those too, so a report
 * is only a candidate when an extension produced it (`byExtensionId`, or a
 * `blob:chrome-extension://` URL), and even then it is dropped when the shelf
 * already claimed it — matched by Chrome's own file path, which Playwright's
 * `Download.path()` shares, never by URL alone. Website downloads keep flowing
 * through `track()` only.
 */

import path from 'path';
import { promises as fs } from 'fs';
import type { BrowserContext, Worker } from 'playwright';

import { downloadUrlKey, type RealChromeShelf, type ShelfEntry } from './RealChromeShelf';

/** One finished download, as an extension's service worker saw it. */
export interface ExtensionDownloadReport {
  /** Chrome's download id — unique across the whole profile. */
  id: number;
  url: string;
  finalUrl: string;
  /** Absolute path Chrome wrote (a GUID under the context's downloadsPath). */
  filePath: string;
  mime: string;
  state: 'complete' | 'interrupted';
  /** Chrome's interrupt reason, e.g. `NETWORK_FAILED`. */
  error: string;
  /** Set by Chrome when an extension called `chrome.downloads.download`. */
  byExtensionId: string;
  /** The `filename` the extension asked for, when this worker saw the call. */
  requestedName: string;
}

export interface ExtensionDownloadBridgeOptions {
  /** The context's `downloadsPath`: the only place a report may point into. */
  downloadsDir: string;
  /**
   * How long a report waits for `page.on('download')` to claim it first.
   * The page event fires when a download BEGINS and a report only when it
   * COMPLETES, so this is a safety margin, not the normal ordering.
   */
  graceMs?: number;
  /** How long one long-poll waits inside the worker before re-checking. */
  pollMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code that runs INSIDE the extension (service worker or page).
//
// Self-contained on purpose: Playwright serialises the function source, so it
// may not reference anything from this module.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install the recorder (and, in a worker, the reporter). Idempotent.
 *
 * Returns whether this context has a `chrome.downloads` to observe, plus the
 * extension id, so Node knows which worker speaks for which extension.
 */
export function installExtensionDownloadObserver(isWorker: boolean): { ok: boolean; extensionId: string } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g: any = globalThis as any;
  const chromeApi = g.chrome;
  const extensionId = (chromeApi && chromeApi.runtime && chromeApi.runtime.id) || '';
  const api = chromeApi && chromeApi.downloads;
  if (!api || typeof api.download !== 'function') return { ok: false, extensionId };

  if (!g.__plyrExtDl) {
    const rec: any = { byUrl: {}, byId: {}, idOrder: [], queue: [], waiters: [], reporting: false };
    g.__plyrExtDl = rec;
    const original = api.download;
    const wrapped = function (this: unknown, options: any, callback?: any): any {
      const o = options || {};
      const name = typeof o.filename === 'string' ? o.filename : '';
      const url = typeof o.url === 'string' ? o.url : '';
      if (name && url && !isWorker) {
        // Page side: the shelf asks by URL (it has the Playwright Download,
        // whose url() is this same string).
        const list = rec.byUrl[url] || (rec.byUrl[url] = []);
        list.push(name);
        if (list.length > 20) list.shift();
      }
      const note = function (id: unknown): void {
        if (typeof id !== 'number' || !name) return;
        rec.byId[id] = name;
        rec.idOrder.push(id);
        if (rec.idOrder.length > 200) delete rec.byId[rec.idOrder.shift()];
      };
      if (typeof callback === 'function') {
        return original.call(this, options, function (this: unknown, id: unknown) {
          note(id);
          // eslint-disable-next-line prefer-rest-params
          return callback.apply(this, arguments as any);
        });
      }
      const r = original.call(this, options);
      if (r && typeof r.then === 'function') r.then(note, function () { /* the caller sees it */ });
      return r;
    };
    try { api.download = wrapped; } catch { /* frozen API: names fall back to Chrome's */ }
  }

  const rec = g.__plyrExtDl;
  if (isWorker && !rec.reporting && api.onChanged && typeof api.search === 'function') {
    rec.reporting = true;
    const key = function (u: string): string {
      // Mirrors downloadUrlKey() in RealChromeShelf: a data: URL can be the
      // whole file, megabytes long, and must not cross the wire every poll.
      if (u.length <= 4096) return u;
      let h = 0x811c9dc5;
      for (let i = 0; i < u.length; i++) { h ^= u.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return u.slice(0, 2048) + '#len=' + u.length + '#fnv=' + h.toString(16);
    };
    api.onChanged.addListener(function (delta: any) {
      const st = delta && delta.state && delta.state.current;
      if (st !== 'complete' && st !== 'interrupted') return;
      api.search({ id: delta.id }, function (items: any[]) {
        const it = items && items[0];
        if (!it) return;
        rec.queue.push({
          id: it.id,
          url: key(String(it.url || '')),
          finalUrl: key(String(it.finalUrl || '')),
          filePath: String(it.filename || ''),
          mime: String(it.mime || ''),
          state: st,
          error: String(it.error || ''),
          byExtensionId: String(it.byExtensionId || ''),
          requestedName: String(rec.byId[it.id] || ''),
        });
        if (rec.queue.length > 200) rec.queue.shift();
        const waiters = rec.waiters.splice(0);
        for (const w of waiters) { try { w(); } catch { /* one waiter only */ } }
      });
    });
  }
  return { ok: true, extensionId };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Wait (up to `arg.waitMs`) for reports, then drain them. On a quiet timeout
 * it also SWEEPS recent finished downloads, which is what recovers an export
 * that completed while this worker had been stopped and restarted (an MV3
 * worker sleeps after ~30s idle; a listener added by evaluate does not wake
 * it). Node de-duplicates by download id, so a sweep repeating a report is
 * harmless.
 */
export function nextExtensionDownloadReports(arg: { waitMs: number; since: number }): Promise<unknown[]> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g: any = globalThis as any;
  const rec = g.__plyrExtDl;
  const api = g.chrome && g.chrome.downloads;
  if (!rec || !api) return Promise.resolve([]);
  const drain = (): unknown[] => rec.queue.splice(0);
  const key = function (u: string): string {
    // Mirrors downloadUrlKey() in RealChromeShelf: a data: URL can be the
    // whole file, megabytes long, and must not cross the wire every poll.
    if (u.length <= 4096) return u;
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) { h ^= u.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return u.slice(0, 2048) + '#len=' + u.length + '#fnv=' + h.toString(16);
  };

  if (rec.queue.length) return Promise.resolve(drain());
  return new Promise<unknown[]>((resolve) => {
    let done = false;
    const finish = (out: unknown[]): void => { if (!done) { done = true; resolve(out); } };
    rec.waiters.push(() => finish(drain()));
    setTimeout(() => {
      if (done) return;
      try {
        api.search(
          { startedAfter: new Date(arg.since).toISOString(), orderBy: ['-startTime'], limit: 50 },
          (items: any[]) => {
            const out = (items || [])
              .filter((it) => it && (it.state === 'complete' || it.state === 'interrupted'))
              // Only what an extension produced: website downloads are the page
              // pipeline's, and sweeping them would only cost bandwidth.
              .filter((it) => !!it.byExtensionId
                || /^blob:chrome-extension:/i.test(String(it.url || ''))
                || /^blob:chrome-extension:/i.test(String(it.finalUrl || '')))
              .map((it) => ({
                id: it.id,
                url: key(String(it.url || '')),
                finalUrl: key(String(it.finalUrl || '')),
                filePath: String(it.filename || ''),
                mime: String(it.mime || ''),
                state: it.state,
                error: String(it.error || ''),
                byExtensionId: String(it.byExtensionId || ''),
                requestedName: String(rec.byId[it.id] || ''),
              }));
            finish(drain().concat(out));
          },
        );
      } catch {
        finish(drain());
      }
    }, Math.max(100, Number(arg.waitMs) || 0));
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Ask a worker for the name it recorded for one download id. */
function requestedNameInWorker(id: number): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rec = (globalThis as any).__plyrExtDl;
  return rec && rec.byId && rec.byId[id] ? String(rec.byId[id]) : '';
}

/**
 * The init script for extension PAGES. Only acts on `chrome-extension:` pages
 * — a website has no `chrome.downloads`, and must not be touched at all.
 */
export function extensionPageInitScript(): string {
  return `(() => { try { if (location.protocol !== 'chrome-extension:') return; `
    + `(${installExtensionDownloadObserver.toString()})(false); } catch (e) { /* never break the page */ } })();`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node side
// ─────────────────────────────────────────────────────────────────────────────

/** Did an extension produce this download (as opposed to a website)? */
export function isExtensionProduced(r: Pick<ExtensionDownloadReport, 'byExtensionId' | 'url' | 'finalUrl'>): boolean {
  if (r.byExtensionId) return true;
  return [r.url, r.finalUrl].some((u) => /^blob:chrome-extension:\/\//i.test(String(u || '')));
}

/** Is `p` inside `dir`? Reports come from inside the browser; trust nothing. */
function isInside(dir: string, p: string): boolean {
  if (!dir || !p) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function normaliseReport(raw: unknown): ExtensionDownloadReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isFinite(id)) return null;
  const state = r.state === 'interrupted' ? 'interrupted' : r.state === 'complete' ? 'complete' : null;
  if (!state) return null;
  return {
    id,
    url: String(r.url || ''),
    finalUrl: String(r.finalUrl || ''),
    filePath: String(r.filePath || ''),
    mime: String(r.mime || ''),
    state,
    error: String(r.error || ''),
    byExtensionId: String(r.byExtensionId || ''),
    requestedName: String(r.requestedName || ''),
  };
}

export class ExtensionDownloadBridge {
  private readonly handled = new Set<number>();
  private readonly handledOrder: number[] = [];
  private readonly attached = new WeakSet<Worker>();
  private readonly byExtension = new Map<string, Worker>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly since = Date.now();
  private readonly graceMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly shelf: RealChromeShelf,
    private readonly opts: ExtensionDownloadBridgeOptions,
  ) {
    this.graceMs = Math.max(0, opts.graceMs ?? 750);
    this.pollMs = Math.max(100, opts.pollMs ?? 15_000);
  }

  /**
   * Observe a context: extension pages via an init script, extension workers
   * as they appear. Awaited by RealChrome BEFORE anything can navigate, for the
   * same reason the shelf is attached first.
   */
  async watch(ctx: BrowserContext): Promise<void> {
    await ctx.addInitScript({ content: extensionPageInitScript() }).catch((e: unknown) => {
      console.warn('[ExtensionDownloads] could not install the page recorder:', (e as Error)?.message || e);
    });
    for (const w of ctx.serviceWorkers()) void this.attach(w);
    ctx.on('serviceworker', (w) => { void this.attach(w); });
    ctx.on('close', () => { this.closed = true; });
  }

  /** Stop polling (the context is going away). */
  dispose(): void {
    this.closed = true;
  }

  private async attach(worker: Worker): Promise<void> {
    let url = '';
    try { url = worker.url(); } catch { return; }
    if (!url.startsWith('chrome-extension://')) return;   // a website's worker
    if (this.attached.has(worker)) return;
    this.attached.add(worker);

    let info: { ok: boolean; extensionId: string };
    try {
      info = await worker.evaluate(installExtensionDownloadObserver, true);
    } catch {
      return;                                              // worker already gone
    }
    if (!info || !info.ok) return;                         // no `downloads` permission
    if (info.extensionId) this.byExtension.set(info.extensionId, worker);
    worker.on('close', () => {
      if (info.extensionId && this.byExtension.get(info.extensionId) === worker) {
        this.byExtension.delete(info.extensionId);
      }
    });

    while (!this.closed) {
      let batch: unknown[];
      try {
        batch = await worker.evaluate(nextExtensionDownloadReports, { waitMs: this.pollMs, since: this.since });
      } catch {
        return;   // worker stopped; a restart emits 'serviceworker' again
      }
      for (const raw of batch || []) {
        const r = normaliseReport(raw);
        if (r) void this.handle(r);
      }
    }
  }

  /**
   * Decide what to do with one report. Public so it can be driven directly by
   * a test with real files and no browser.
   *
   * Resolves to the shelf row it created, or null when the report was not an
   * extension download, was a duplicate, or was already claimed by the page
   * pipeline.
   */
  async handle(r: ExtensionDownloadReport): Promise<ShelfEntry | null> {
    // Every extension with the `downloads` permission reports every download,
    // and a sweep may repeat one: the id is the identity.
    if (this.handled.has(r.id)) return null;
    this.handled.add(r.id);
    this.handledOrder.push(r.id);
    if (this.handledOrder.length > 2000) this.handled.delete(this.handledOrder.shift()!);

    // A website download. It came through page.on('download'); only its claim
    // is released here, so the shelf's bookkeeping cannot grow or go stale.
    if (!isExtensionProduced(r)) {
      if (r.state === 'interrupted') this.shelf.spendFailedClaim([r.url, r.finalUrl].filter(Boolean).map(downloadUrlKey));
      else this.shelf.releaseClaim(r.filePath, [r.url, r.finalUrl]);
      return null;
    }

    // Give the page pipeline its chance first, then check whether it took THIS
    // download — matched by Chrome's own file, never by URL alone (the same
    // http(s) URL downloaded by a website first must not hide the export).
    if (this.graceMs) await new Promise((res) => setTimeout(res, this.graceMs));
    if (await this.shelf.claimedByPage({
      filePath: r.filePath,
      urls: [r.url, r.finalUrl],
      interrupted: r.state === 'interrupted',
    })) return null;

    // The reporter may not be the extension that asked for the download; the
    // one that did is the one whose wrapper saw the filename.
    let requestedName = r.requestedName;
    if (!requestedName && r.byExtensionId) {
      const owner = this.byExtension.get(r.byExtensionId);
      if (owner) {
        requestedName = await owner.evaluate(requestedNameInWorker, r.id).catch(() => '');
      }
    }

    let error = r.state === 'interrupted' ? (r.error || 'INTERRUPTED') : '';
    let sourcePath = r.filePath;
    if (!error) {
      if (!isInside(this.opts.downloadsDir, sourcePath)) {
        error = 'OUTSIDE_DOWNLOADS_DIR';
        sourcePath = '';
      } else {
        try {
          const st = await fs.stat(sourcePath);
          if (!st.isFile()) throw new Error('not a file');
        } catch {
          // Reported complete but not on disk: most often a sweep finding a
          // download some other consumer already took. Nothing to adopt, and
          // a failed row for it would be noise.
          if (r.state === 'complete') return null;
        }
      }
    } else if (!isInside(this.opts.downloadsDir, sourcePath)) {
      sourcePath = '';
    }

    // One adoption at a time, in report order.
    const run = this.chain.then(() => this.shelf.adopt({
      sourcePath,
      url: r.finalUrl || r.url,
      requestedName,
      contentType: r.mime,
      error,
    }));
    this.chain = run.catch(() => { /* keep the chain alive */ });
    const entry = await run;
    if (entry.state === 'failed') {
      console.warn('[ExtensionDownloads] extension download failed:', entry.error, 'name=', entry.name);
    }
    return entry;
  }
}
