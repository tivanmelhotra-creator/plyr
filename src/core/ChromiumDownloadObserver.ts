/**
 * ChromiumDownloadObserver — every download Chromium itself performs, from
 * whatever started it, enters the ONE existing shelf pipeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shelf hears about downloads through Playwright's `page.on('download')`,
 * and core/ExtensionDownloads adds the ones an extension's service worker makes
 * through `chrome.downloads`. Both depend on something OTHER than the browser:
 * Playwright only reports downloads of pages it owns, and the bridge only works
 * inside an extension that holds the `downloads` permission.
 *
 * The operator's real case falls through both. J2TEAM Cookies (permissions:
 * cookies, storage, tabs; no `downloads`) exports from its ACTION POPUP with an
 * `<a download>` click. MEASURED (Playwright 1.58, Chromium 145, a fixture with
 * the same manifest shape, three exports in a row):
 *
 *   context.pages()                    ['about:blank']      the popup is not a page
 *   page.on('download')                0 of 3 exports
 *   chrome.downloads observers         none (no extension may use the API)
 *   DOWNLOADS_DIR                      3 new bare GUID files, never adopted
 *   Browser.downloadWillBegin (CDP)    3 of 3, suggestedFilename 'cookies.json'
 *   Browser.downloadProgress           3 × completed, with the GUID file path
 *
 * So the browser's own download manager is the one layer that sees every
 * download whatever its source, and it already knows the real filename.
 *
 * HOW
 * ---
 * One browser-level DevTools session on the debug port RealChrome already
 * opens. `Browser.setDownloadBehavior` is sent with EXACTLY the parameters
 * Playwright itself uses for this context (allowAndName, the same
 * downloadsPath, events on), so nothing about where or how Chrome saves
 * changes; it only makes Chrome send this session the download events too.
 *
 * For each completed download:
 *
 *   a page download Playwright reported   -> skipped; `track()` owns it
 *                                            (RealChromeShelf.claimedByPage)
 *   anything else                         -> RealChromeShelf.adopt(), the same
 *                                            naming, (2)/(3) numbering,
 *                                            workflow copy and delivery feed
 *
 * WHY NOT A DIRECTORY WATCHER
 * ---------------------------
 * Playwright's own page downloads land in DOWNLOADS_DIR as GUIDs too, so a
 * watcher cannot tell them apart without guessing, and a file on disk carries
 * no name: every export would become `download.json`. The directory is still
 * what the adopted bytes are read from; the events only say which file is
 * which and what it is called.
 *
 * KNOWN LIMITS
 * ------------
 *  - A `chrome.downloads.download()` call from a service worker has no frame,
 *    and Chrome sends no DevTools download event for it (MEASURED). Only an
 *    extension WITH the `downloads` permission can do that, and
 *    core/ExtensionDownloads already covers exactly that case.
 *  - If this session drops, Chrome reverts the download behaviour it set
 *    (MEASURED: the next page download went to ~/Downloads and Playwright's
 *    path() pointed at a missing file). So the session reconnects at once and
 *    re-sends the same behaviour; the gap is the reconnect time.
 *  - A download that STARTED before this session was listening has no
 *    `downloadWillBegin` here and is left alone, rather than risk filing a
 *    page download twice.
 */

import path from 'path';
import { promises as fs } from 'fs';
import WebSocket from 'ws';

import type { AdoptedDownload, RealChromeShelf, ShelfEntry } from './RealChromeShelf';

export interface ChromiumDownloadObserverOptions {
  /** The context's `downloadsPath`. Must be the same one Playwright was given. */
  downloadsDir: string;
  /**
   * Pause before deciding whether a page download owns a file, so
   * `page.on('download')` -> `track()` has registered its claim.
   */
  graceMs?: number;
  /** How long to wait for the file to be visible after `completed`. */
  fileWaitMs?: number;
  /** Delays between reconnect attempts; the last one repeats. */
  reconnectDelaysMs?: number[];
}

/** What `downloadWillBegin` said about one download. */
interface Begun {
  url: string;
  suggestedFilename: string;
  frameId: string;
  at: number;
  /** URL of the frame that started it, when Chrome could tell (diagnostics + source). */
  frameUrl: string;
}

export interface ChromiumDownloadObserverStatus {
  connected: boolean;
  /** Times the session had to be re-established. */
  reconnects: number;
  begun: number;
  completed: number;
  adopted: number;
  skippedPage: number;
  skippedUnknown: number;
  lastError: string;
}

const MAX_TRACKED = 500;

function traceOn(): boolean {
  return process.env.PLYR_TRACE_DOWNLOADS === '1' || process.env.PLYR_TRACE_EXT_DOWNLOADS === '1';
}
function trace(stage: string, guid: string, detail: Record<string, unknown> = {}): void {
  if (!traceOn()) return;
  console.log(`[ChromiumDownloads][trace] ${stage} guid=${guid} ${JSON.stringify(detail)}`);
}

/** Is `p` inside `dir`? Paths come from the browser; trust nothing. */
function isInside(dir: string, p: string): boolean {
  if (!dir || !p) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A Chrome download GUID. It becomes a file name, so it is checked. */
function isGuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
}

export class ChromiumDownloadObserver {
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private disposed = false;
  private nextId = 1;
  private readonly pending = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>();
  private readonly begun = new Map<string, Begun>();
  private readonly handled = new Set<string>();
  private readonly handledOrder: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private readonly graceMs: number;
  private readonly fileWaitMs: number;
  private readonly delays: number[];
  private readonly downloadsDir: string;
  private readonly stats: ChromiumDownloadObserverStatus = {
    connected: false, reconnects: 0, begun: 0, completed: 0, adopted: 0,
    skippedPage: 0, skippedUnknown: 0, lastError: '',
  };
  /** Resolves once the first setDownloadBehavior has been acknowledged (or failed). */
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;

  constructor(
    private readonly shelf: RealChromeShelf,
    opts: ChromiumDownloadObserverOptions,
  ) {
    this.downloadsDir = path.resolve(opts.downloadsDir);
    this.graceMs = Math.max(0, opts.graceMs ?? 750);
    this.fileWaitMs = Math.max(0, opts.fileWaitMs ?? 3_000);
    this.delays = opts.reconnectDelaysMs && opts.reconnectDelaysMs.length
      ? opts.reconnectDelaysMs : [0, 250, 1_000, 2_000, 5_000];
    this.ready = new Promise<void>((res) => { this.readyResolve = res; });
  }

  /** Connect to the browser's DevTools endpoint (`webSocketDebuggerUrl`). */
  attach(wsUrl: string): Promise<void> {
    if (!wsUrl || this.disposed) { this.readyResolve?.(); return this.ready; }
    this.wsUrl = wsUrl;
    this.connect();
    return this.ready;
  }

  status(): ChromiumDownloadObserverStatus {
    return { ...this.stats };
  }

  /** The browser is going away. Closing the socket then is harmless. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
    this.readyResolve?.();
  }

  private connect(): void {
    if (this.disposed || !this.wsUrl) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
    } catch (e) {
      this.stats.lastError = (e as Error)?.message || String(e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.stats.connected = true;
      // EXACTLY what Playwright sends for this context (crBrowser.ts):
      // same behaviour, same path, events on. Only the events are new.
      void this.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: this.downloadsDir,
        eventsEnabled: true,
      }).then((r) => {
        if (r.error) {
          this.stats.lastError = `setDownloadBehavior: ${r.error.message || 'failed'}`;
          console.warn('[ChromiumDownloads] could not observe downloads:', this.stats.lastError);
        } else {
          trace('session.ready', '-', { downloadsDir: this.downloadsDir, reconnects: this.stats.reconnects });
        }
        this.readyResolve?.();
      });
    });
    ws.on('message', (data: WebSocket.Data) => this.onMessage(String(data)));
    ws.on('error', (e: Error) => { this.stats.lastError = e?.message || String(e); });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.stats.connected = false;
      for (const [, cb] of this.pending) cb({ error: { message: 'closed' } });
      this.pending.clear();
      if (!this.disposed) {
        console.warn('[ChromiumDownloads] DevTools session closed; reconnecting');
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stats.reconnects++;
      this.connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { message?: string } }> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ error: { message: 'not connected' } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try { ws.send(JSON.stringify({ id, method, params })); } catch (e) {
        this.pending.delete(id);
        resolve({ error: { message: (e as Error)?.message || 'send failed' } });
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const cb = this.pending.get(msg.id);
      if (cb) { this.pending.delete(msg.id); cb(msg); }
      return;
    }
    // Only this browser-level session's own events.
    if (msg.sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Browser.downloadWillBegin') this.onBegin(p);
    else if (msg.method === 'Browser.downloadProgress') this.onProgress(p);
  }

  private onBegin(p: Record<string, unknown>): void {
    const guid = String(p.guid || '');
    if (!isGuid(guid)) return;
    this.stats.begun++;
    const info: Begun = {
      url: String(p.url || ''),
      suggestedFilename: String(p.suggestedFilename || ''),
      frameId: String(p.frameId || ''),
      at: Date.now(),
      frameUrl: '',
    };
    this.begun.set(guid, info);
    while (this.begun.size > MAX_TRACKED) {
      const oldest = this.begun.keys().next().value;
      if (oldest === undefined) break;
      this.begun.delete(oldest);
    }
    // A main frame's id IS its target id, so this names the popup/page that
    // started the download. Best effort: a subframe has no target of its own.
    if (info.frameId) {
      void this.send('Target.getTargetInfo', { targetId: info.frameId }).then((r) => {
        const t = (r.result as { targetInfo?: { url?: string } } | undefined)?.targetInfo;
        if (t && t.url) info.frameUrl = String(t.url);
      });
    }
    trace('begin', guid, { url: info.url.slice(0, 300), suggestedFilename: info.suggestedFilename, frameId: info.frameId });
  }

  private onProgress(p: Record<string, unknown>): void {
    const guid = String(p.guid || '');
    if (!isGuid(guid)) return;
    const state = String(p.state || '');
    if (state === 'canceled') {
      trace('canceled', guid);
      this.begun.delete(guid);
      return;
    }
    if (state !== 'completed') return;
    this.stats.completed++;
    const filePath = String(p.filePath || '') || path.join(this.downloadsDir, guid);
    void this.handle(guid, filePath).catch((e) => {
      this.stats.lastError = (e as Error)?.message || String(e);
    });
  }

  /**
   * Decide one completed download. Public for tests; normally driven by the
   * DevTools events.
   */
  async handle(guid: string, filePath: string): Promise<ShelfEntry | null> {
    if (this.handled.has(guid)) { trace('skip:duplicate', guid); return null; }
    this.handled.add(guid);
    this.handledOrder.push(guid);
    if (this.handledOrder.length > 2000) this.handled.delete(this.handledOrder.shift()!);

    const info = this.begun.get(guid);
    this.begun.delete(guid);
    if (!info) {
      // Started before this session listened: it may well be a page download
      // `track()` is filing right now. Leave it alone rather than file twice.
      this.stats.skippedUnknown++;
      trace('skip:no-begin-event', guid, { filePath });
      return null;
    }
    if (!isInside(this.downloadsDir, filePath)) {
      this.stats.skippedUnknown++;
      trace('skip:outside-downloads-dir', guid, { filePath });
      return null;
    }

    if (this.graceMs) await new Promise((res) => setTimeout(res, this.graceMs));
    if (await this.shelf.claimedByPage({ filePath, urls: [info.url], interrupted: false })) {
      this.stats.skippedPage++;
      trace('skip:page-download', guid, { url: info.url.slice(0, 300) });
      return null;
    }

    if (!(await this.waitForFile(filePath))) {
      this.stats.skippedUnknown++;
      trace('skip:file-missing', guid, { filePath });
      return null;
    }

    const fromExtension = /^chrome-extension:\/\//i.test(info.frameUrl)
      || /^blob:chrome-extension:\/\//i.test(info.url);
    const input: AdoptedDownload = {
      sourcePath: filePath,
      url: info.url,
      requestedName: info.suggestedFilename,
      contentType: '',
      error: '',
      source: fromExtension ? 'extension' : 'browser',
    };
    const run = this.chain.then(() => this.shelf.adopt(input));
    this.chain = run.catch(() => { /* keep the chain alive */ });
    const entry = await run;
    this.stats.adopted++;
    trace('adopted', guid, {
      token: entry.token, name: entry.name, state: entry.state, source: entry.source,
      frameUrl: info.frameUrl.slice(0, 200), workflowPath: entry.workflowPath || '', error: entry.error,
    });
    if (entry.state === 'failed') {
      console.warn('[ChromiumDownloads] download could not be filed:', entry.error, 'name=', entry.name);
    }
    return entry;
  }

  /** `completed` can race the directory entry by a moment; wait a little. */
  private async waitForFile(p: string): Promise<boolean> {
    const until = Date.now() + this.fileWaitMs;
    for (;;) {
      try {
        const st = await fs.stat(p);
        if (st.isFile()) return true;
      } catch { /* not yet */ }
      if (Date.now() >= until) return false;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}
