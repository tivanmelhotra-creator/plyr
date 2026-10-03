import type { BrowserContext, Page } from 'playwright';
import WebSocket from 'ws';
import { resolveUpload } from './RemoteUploads';
import {
  BrowserPageRegistry,
  type BrowserPageKind,
  type BrowserPageRef,
} from './BrowserPageRegistry';
import {
  CHOOSER_TTL_MS,
  FileChooserError,
  RemoteFileChooser,
  type PendingChooser,
} from './RemoteFileChooser';
import { persistUploads, realChromeWorkflowForTransfer } from './WorkflowBinding';

export interface FileChooserNotice extends PendingChooser {
  pageId: string;
  profileId: string;
  runtimeId: string;
  kind?: BrowserPageKind;
  extensionId?: string;
}

export type FileChooserListener = (event: {
  type: 'pending' | 'done';
  notice: FileChooserNotice;
  reason?: string;
}) => void;

function kindFor(page: Page): BrowserPageKind {
  let url = '';
  try { url = page.url(); } catch { /* page is closing */ }
  if (url.startsWith('chrome-extension://')) return 'extension';
  if (url.startsWith('https://accounts.') || url.includes('/oauth')) return 'oauth';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'tab';
  return 'other';
}

function extensionIdFor(page: Page): string | undefined {
  try {
    const url = page.url();
    const match = url.match(/^chrome-extension:\/\/([^/]+)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Answering with more than this many files at once is a bug or an attack. */
const MAX_FILES = 10;

/** A DevTools request that gets no reply must not hang the HTTP route that awaits it. */
const CDP_TIMEOUT_MS = 10_000;

/** Longest we wait to learn which DevTools target a Playwright page is. */
const OWNERSHIP_LOOKUP_MS = 3_000;

type CdpReply = { result?: unknown; error?: { code?: number; message?: string } };

type CdpTargetInfo = { targetId: string; type: string; url?: string };

/**
 * A file dialog held open in a DevTools target that Playwright does not own
 * (in practice: an extension's action popup).
 */
interface CdpChooser {
  id: string;
  sessionId: string;
  targetId: string;
  pageId: string;
  /** The clicked <input type=file>. Files are handed to THIS node. */
  backendNodeId: number;
  notice: FileChooserNotice;
  expiry: ReturnType<typeof setTimeout> | null;
}

/**
 * Runtime/page-scoped owner for intercepted file choosers.
 *
 * There is intentionally no runtime-wide pending chooser slot here. Every Page
 * gets its own RemoteFileChooser, while the registry supplies the canonical
 * PageId used by routes, LiveBrowser, and automation scopes.
 */
export class FileChooserService {
  private readonly choosers = new Map<string, RemoteFileChooser>();
  private readonly listeners = new Set<FileChooserListener>();
  private watchedContext: BrowserContext | null = null;
  private cdpWs: WebSocket | null = null;
  private readonly cdpChoosers = new Map<string, CdpChooser>();
  /** Newest dialog number per target, so a slow `describeNode` cannot resurrect a superseded one. */
  private readonly cdpLatest = new Map<string, number>();
  private readonly cdpPending = new Map<number, (reply: CdpReply) => void>();
  private readonly pageTargetIds = new WeakMap<Page, string>();
  private cdpSeq = 0;
  private cdpNextId = 1;

  constructor(
    private readonly userId: string,
    readonly profileId: string,
    readonly runtimeId: string,
    private readonly pages = new BrowserPageRegistry(profileId, runtimeId),
  ) {}

  registry(): BrowserPageRegistry {
    return this.pages;
  }

  subscribe(listener: FileChooserListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Intercept file dialogs in DevTools targets Playwright does NOT own.
   *
   * WHY THIS EXISTS. An extension's action popup is not a Playwright `Page`
   * (MEASURED, see core/ChromiumDownloadObserver: `context.pages()` stays
   * `['about:blank']` while the popup is open), so `page.on('filechooser')`
   * never fires for it. Its "Import" button — a cookie importer's, say — would
   * open a native dialog on the SERVER's screen. This session covers exactly
   * that gap, over the browser-level DevTools socket RealChrome already opens.
   *
   * WHAT WAS WRONG HERE BEFORE (all MEASURED on Chromium 131 against a real
   * `<input type=file>`; the first also on Chromium 145 by an earlier session):
   *
   *   1. FILES WERE NEVER DELIVERED. The hand-over was
   *      `Page.handleFileChooser`, a method that DOES NOT EXIST in the
   *      protocol: `-32601 'Page.handleFileChooser' wasn't found`. It was sent
   *      fire-and-forget, so nobody saw the error; the row was dropped as
   *      "done", the route answered `success: true`, the view printed "Sent to
   *      the site", and the popup received nothing. That is the "I picked the
   *      file and nothing was imported" report — for BOTH sources (the
   *      operator's computer and the workflow's files), because both end here.
   *   2. ONE CLICK PRODUCED SEVERAL ROWS. `Target.setAutoAttach` AND an
   *      explicit `Target.attachToTarget` per target gave two or three sessions
   *      on the same page, and every session that asked for interception gets
   *      its own `Page.fileChooserOpened` (3 events for 1 click). The view
   *      answered one row and was asked again for the others.
   *
   * HOW IT WORKS NOW. Exactly one session per target, interception on it, and
   * files handed over the way Playwright itself does it: the event carries the
   * `backendNodeId` of the <input>, and `DOM.setFileInputFiles` on that session
   * sets the files and fires input/change. The reply is AWAITED, so a refusal is
   * an error the view can show, not a silent "done".
   *
   * OWNERSHIP IS DECIDED WHEN THE DIALOG OPENS, not when the target appears: a
   * page Playwright opened announces itself over DevTools a moment before
   * Playwright lists it in `context.pages()`, so an attach-time check misjudges
   * exactly the tabs the operator just opened. By the time a human clicks a file
   * input the page is known. Pages Playwright owns stay with
   * `watchPage() -> page.on('filechooser')`; answering them here as well is how
   * a dialog got answered twice.
   */
  attachCDP(wsUrl: string): void {
    if (!wsUrl || this.cdpWs) return;
    try {
      const ws = new WebSocket(wsUrl);
      this.cdpWs = ws;
      /** One session per target, never two. */
      const sessionByTarget = new Map<string, string>();
      const targetBySession = new Map<string, string>();
      const infoByTarget = new Map<string, CdpTargetInfo>();
      const attaching = new Set<string>();

      const attach = async (t: CdpTargetInfo): Promise<void> => {
        if (this.cdpWs !== ws || ws.readyState !== WebSocket.OPEN) return;
        infoByTarget.set(t.targetId, t);
        if (t.type !== 'page' && t.type !== 'background_page' && t.type !== 'other') return;
        if (sessionByTarget.has(t.targetId) || attaching.has(t.targetId)) return;
        attaching.add(t.targetId);
        try {
          const r = await this.cdpSend('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          const sessionId = (r.result as { sessionId?: string } | undefined)?.sessionId;
          if (!sessionId) return;
          sessionByTarget.set(t.targetId, sessionId);
          targetBySession.set(sessionId, t.targetId);
          await this.cdpSend('Page.enable', {}, sessionId);
          await this.cdpSend('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
        } finally {
          attaching.delete(t.targetId);
        }
      };

      const forget = (targetId: string, reason: string): void => {
        const sessionId = sessionByTarget.get(targetId);
        sessionByTarget.delete(targetId);
        if (sessionId) targetBySession.delete(sessionId);
        infoByTarget.delete(targetId);
        this.cdpLatest.delete(targetId);
        for (const entry of [...this.cdpChoosers.values()]) {
          if (entry.targetId === targetId) this.dropCdp(entry, reason);
        }
      };

      ws.on('open', () => {
        void this.cdpSend('Target.setDiscoverTargets', { discover: true });
        void this.cdpSend('Target.getTargets', {}).then((r) => {
          const infos = (r.result as { targetInfos?: CdpTargetInfo[] } | undefined)?.targetInfos || [];
          for (const t of infos) void attach(t);
        });
      });

      ws.on('message', (data: WebSocket.Data) => {
        let msg: {
          id?: number;
          method?: string;
          sessionId?: string;
          params?: Record<string, unknown>;
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        try { msg = JSON.parse(String(data)); } catch { return; }

        // A reply to something we asked.
        if (typeof msg.id === 'number') {
          const cb = this.cdpPending.get(msg.id);
          if (cb) { this.cdpPending.delete(msg.id); cb({ result: msg.result, error: msg.error }); }
          return;
        }

        const p = msg.params || {};
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
          const t = p.targetInfo as CdpTargetInfo | undefined;
          if (t) void attach(t);
        } else if (msg.method === 'Target.attachedToTarget') {
          // Our own explicit attach announces itself here too; only remember
          // what the target is. Never open a second session for it.
          const t = p.targetInfo as CdpTargetInfo | undefined;
          if (t) infoByTarget.set(t.targetId, t);
        } else if (msg.method === 'Target.targetDestroyed') {
          forget(String(p.targetId || ''), 'closed');
        } else if (msg.method === 'Target.detachedFromTarget') {
          const targetId = targetBySession.get(String(p.sessionId || ''));
          if (targetId) forget(targetId, 'closed');
        } else if (msg.method === 'Page.frameNavigated' && msg.sessionId) {
          // The document that asked for a file is gone. Chromium does NOT
          // refuse a stale `backendNodeId` (MEASURED: DOM.setFileInputFiles on
          // the old <input> after a navigation answers `{}`), so an answer
          // would be reported as delivered to a page that never saw it. Drop
          // the row instead. Sub-frames (parentId set) do not count.
          const frame = p.frame as { parentId?: string } | undefined;
          const targetId = targetBySession.get(msg.sessionId);
          if (targetId && frame && !frame.parentId) {
            for (const entry of [...this.cdpChoosers.values()]) {
              if (entry.targetId === targetId) this.dropCdp(entry, 'navigated');
            }
          }
        } else if (msg.method === 'Page.fileChooserOpened' && msg.sessionId) {
          const sessionId = msg.sessionId;
          const targetId = targetBySession.get(sessionId);
          if (!targetId) return;
          void this.isPlaywrightTarget(targetId).then((owned) => {
            if (owned) return; // Playwright's own `filechooser` is the single source of truth.
            this.onCdpChooser(targetId, sessionId, p, infoByTarget.get(targetId));
          });
        }
      });

      ws.on('error', () => { /* quiet on error */ });
      ws.on('close', () => {
        if (this.cdpWs === ws) this.cdpWs = null;
        for (const [, cb] of this.cdpPending) cb({ error: { message: 'closed' } });
        this.cdpPending.clear();
        for (const entry of [...this.cdpChoosers.values()]) this.dropCdp(entry, 'closed');
        this.cdpLatest.clear();
      });
    } catch { /* ignored */ }
  }

  /** A DevTools request whose reply is awaited. Never rejects. */
  private cdpSend(method: string, params: Record<string, unknown>, sessionId?: string): Promise<CdpReply> {
    const ws = this.cdpWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ error: { message: 'not connected' } });
    const id = this.cdpNextId++;
    return new Promise<CdpReply>((resolve) => {
      const timer = setTimeout(() => {
        if (this.cdpPending.delete(id)) resolve({ error: { message: `${method} timed out` } });
      }, CDP_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.cdpPending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (e) {
        clearTimeout(timer);
        this.cdpPending.delete(id);
        resolve({ error: { message: (e as Error)?.message || 'send failed' } });
      }
    });
  }

  /**
   * Is this DevTools target one of Playwright's own pages? Those are covered by
   * `page.on('filechooser')`, and covering them twice is the bug this guards.
   * Page -> targetId is cached per Page, so only the first dialog pays for it.
   */
  private async isPlaywrightTarget(targetId: string): Promise<boolean> {
    const ctx = this.watchedContext;
    if (!ctx) return false;
    let pages: Page[] = [];
    try { pages = ctx.pages(); } catch { return false; }
    for (const page of pages) {
      let id = this.pageTargetIds.get(page);
      if (!id) {
        try {
          // Bounded: one wedged tab must not hold back the row for the popup
          // the operator is actually waiting on.
          id = await Promise.race([
            (async () => {
              const cdp = await ctx.newCDPSession(page);
              try {
                const info = await cdp.send('Target.getTargetInfo');
                return info.targetInfo.targetId;
              } finally {
                await cdp.detach().catch(() => { /* page closing */ });
              }
            })(),
            new Promise<undefined>((resolve) => {
              const t = setTimeout(() => resolve(undefined), OWNERSHIP_LOOKUP_MS);
              if (typeof t.unref === 'function') t.unref();
            }),
          ]);
        } catch { continue; /* page closing: it is not this one */ }
        if (id) this.pageTargetIds.set(page, id);
      }
      if (id === targetId) return true;
    }
    return false;
  }

  private onCdpChooser(
    targetId: string,
    sessionId: string,
    p: Record<string, unknown>,
    info: CdpTargetInfo | undefined,
  ): void {
    // A dialog on this target replaces the one before it: the page asked again.
    for (const old of [...this.cdpChoosers.values()]) {
      if (old.targetId === targetId) this.dropCdp(old, 'superseded');
    }
    const backendNodeId = Number(p.backendNodeId);
    // `showOpenFilePicker()` has no <input>, hence nothing to hand a file to.
    if (!Number.isFinite(backendNodeId)) return;

    const url = info?.url || '';
    const isExtension = url.startsWith('chrome-extension://') || info?.type === 'other';
    const extId = url.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    const seq = ++this.cdpSeq;
    this.cdpLatest.set(targetId, seq);
    const pageId = `cdp:${targetId}`;
    const fullId = `${pageId}:cdp${seq}`;
    const notice: FileChooserNotice = {
      id: fullId,
      pageId,
      profileId: this.profileId,
      runtimeId: this.runtimeId,
      multiple: p.mode === 'selectMultiple',
      accept: '',
      name: 'file',
      at: Date.now(),
      kind: isExtension ? 'extension' : 'other',
      ...(extId ? { extensionId: extId } : {}),
    };

    // The input's own `accept`/`name` first, so the operator's picker filters
    // like the page's and a .png is not offered to a cookie importer that only
    // takes .json. The row is published only once complete; a failed lookup
    // still publishes it (the dialog itself stands).
    void this.cdpSend('DOM.describeNode', { backendNodeId }, sessionId).then((r) => {
      // A newer dialog on this target, or a closed socket, got here first.
      if (this.cdpLatest.get(targetId) !== seq || !this.cdpWs) return;
      const attrs = (r.result as { node?: { attributes?: string[] } } | undefined)?.node?.attributes || [];
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === 'accept') notice.accept = attrs[i + 1];
        if (attrs[i] === 'name' && attrs[i + 1]) notice.name = attrs[i + 1];
      }
      const entry: CdpChooser = { id: fullId, sessionId, targetId, pageId, backendNodeId, notice, expiry: null };
      // Same patience as the Playwright path; a row nobody answers must not
      // sit in front of every other request forever (pendingAny lists CDP first).
      entry.expiry = setTimeout(() => this.dropCdp(entry, 'expired'), CHOOSER_TTL_MS);
      if (typeof entry.expiry.unref === 'function') entry.expiry.unref();
      this.cdpChoosers.set(fullId, entry);
      this.emit({ type: 'pending', notice });
    });
  }

  /** Forget a held dialog and tell listeners. Idempotent per entry. */
  private dropCdp(entry: CdpChooser, reason?: string): void {
    if (!this.takeCdp(entry)) return;
    this.emit({ type: 'done', notice: entry.notice, ...(reason ? { reason } : {}) });
  }

  /** Remove an entry without announcing it. False if it was already gone. */
  private takeCdp(entry: CdpChooser): boolean {
    if (this.cdpChoosers.get(entry.id) !== entry) return false;
    this.cdpChoosers.delete(entry.id);
    if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
    return true;
  }

  /**
   * The held dialog an answer is meant for. An id that names a CDP dialog which
   * is gone is REFUSED, never redirected to whatever newer dialog the same page
   * opened since (the Playwright path refuses a stale id for the same reason: a
   * file going to a request the operator did not choose is worse than an error).
   */
  private findCdp(pageId: string, id: string): CdpChooser | undefined {
    if (id) {
      const direct = this.cdpChoosers.get(id);
      if (direct) return direct;
      if (String(id).startsWith('cdp:')) {
        throw new FileChooserError('That file request is no longer the current one.');
      }
      return undefined;
    }
    return [...this.cdpChoosers.values()].find((c) => c.pageId === pageId);
  }

  /**
   * Hand files to the popup's <input> and only then report the dialog done.
   * The entry is taken BEFORE the request (one answer per dialog), and a
   * refusal is thrown to the caller instead of being reported as success.
   */
  private async cdpSetFiles(entry: CdpChooser, paths: string[]): Promise<string[]> {
    if (!this.takeCdp(entry)) throw new FileChooserError('That file request is no longer the current one.');
    // A single-file input refuses several files wholesale; hand it the first,
    // as the Playwright path does.
    const use = entry.notice.multiple ? paths.slice(0, MAX_FILES) : paths.slice(0, 1);
    const r = await this.cdpSend(
      'DOM.setFileInputFiles',
      { files: use, backendNodeId: entry.backendNodeId },
      entry.sessionId,
    );
    if (r.error) {
      this.emit({ type: 'done', notice: entry.notice, reason: 'failed' });
      throw new FileChooserError(`The extension did not accept the file: ${r.error.message || 'unknown error'}.`);
    }
    this.emit({ type: 'done', notice: entry.notice });
    return use;
  }

  dispose(): void {
    if (this.cdpWs) {
      try { this.cdpWs.close(); } catch { /* ignore */ }
      this.cdpWs = null;
    }
    for (const cb of this.cdpPending.values()) cb({ error: { message: 'closed' } });
    this.cdpPending.clear();
    for (const entry of this.cdpChoosers.values()) {
      if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
    }
    this.cdpChoosers.clear();
    this.cdpLatest.clear();
  }

  watch(context: BrowserContext): void {
    if (this.watchedContext === context) return;
    this.watchedContext = context;
    for (const page of context.pages()) this.watchPage(page);
    context.on('page', (page) => this.watchPage(page));
    const anyCtx = context as unknown as {
      backgroundPages?: () => Page[];
      on: (event: string, listener: (arg: unknown) => void) => void;
    };
    if (typeof anyCtx.backgroundPages === 'function') {
      try {
        for (const page of anyCtx.backgroundPages()) this.watchPage(page);
      } catch { /* context closing */ }
    }
    if (typeof anyCtx.on === 'function') {
      anyCtx.on('backgroundpage', (page: unknown) => this.watchPage(page as Page));
    }
  }

  pendingForPage(pageId: string): FileChooserNotice | null {
    for (const entry of this.cdpChoosers.values()) {
      if (entry.pageId === pageId) return entry.notice;
    }
    const chooser = this.choosers.get(pageId);
    const pending = chooser?.pending();
    return pending ? this.notice(pageId, pending) : null;
  }

  pendingAny(): FileChooserNotice | null {
    if (this.cdpChoosers.size > 0) {
      const first = this.cdpChoosers.values().next().value;
      if (first) return first.notice;
    }
    for (const pageId of this.choosers.keys()) {
      const pending = this.pendingForPage(pageId);
      if (pending) return pending;
    }
    return null;
  }

  async accept(pageId: string, id: string, tokens: string[]): Promise<{ count: number; persisted: string[] }> {
    const cdp = this.findCdp(pageId, id);
    if (cdp) {
      // Tokens, never paths: same rule as RemoteFileChooser.accept().
      const paths: string[] = [];
      for (const t of (Array.isArray(tokens) ? tokens : []).slice(0, MAX_FILES)) {
        try { paths.push(await resolveUpload(this.userId, String(t))); } catch { /* expired or foreign token */ }
      }
      if (!paths.length) {
        this.dropCdp(cdp, 'no_valid_files');
        throw new FileChooserError('None of those uploads are still available.');
      }
      const used = await this.cdpSetFiles(cdp, paths);
      // The same bytes, filed under `<workflow>/uploads/` like the Playwright
      // path does after setFiles. Without this an import that worked never
      // showed up in the workspace's Uploads folder. After the hand-over so the
      // popup is never kept waiting on a copy; never fatal.
      let persisted: string[] = [];
      try {
        persisted = (await persistUploads(await realChromeWorkflowForTransfer(), used)).map((e) => e.path);
      } catch { /* logged inside persistUploads */ }
      return { count: used.length, persisted };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.accept(this.localId(pageId, id), tokens);
  }

  async acceptPaths(pageId: string, id: string, paths: string[]): Promise<{ count: number }> {
    const cdp = this.findCdp(pageId, id);
    if (cdp) {
      // Paths arrive from the ROUTE (WorkflowStorage.resolveForBrowser), never
      // from a client; see RemoteFileChooser.acceptPaths.
      const list = (Array.isArray(paths) ? paths : [])
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .slice(0, MAX_FILES);
      if (!list.length) {
        this.dropCdp(cdp, 'no_valid_files');
        throw new FileChooserError('No file was selected.');
      }
      const used = await this.cdpSetFiles(cdp, list);
      return { count: used.length };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.acceptPaths(this.localId(pageId, id), paths);
  }

  async cancel(pageId: string, id = ''): Promise<boolean> {
    let cdp: CdpChooser | undefined;
    try { cdp = this.findCdp(pageId, id); } catch { return false; /* already gone */ }
    if (cdp) {
      // With interception on there is no native dialog to dismiss: forgetting
      // the request IS the cancel (the input simply stays empty).
      this.dropCdp(cdp, 'cancelled');
      return true;
    }
    const chooser = this.choosers.get(pageId);
    if (!chooser) return false;
    return chooser.cancel(id ? this.localId(pageId, id) : '');
  }

  async acceptAny(id: string, tokens: string[]) {
    const pageId = this.pageIdForId(id);
    if (!pageId) throw new Error('That file request is no longer current.');
    return this.accept(pageId, id, tokens);
  }

  async acceptPathsAny(id: string, paths: string[]) {
    const pageId = this.pageIdForId(id);
    if (!pageId) throw new Error('That file request is no longer current.');
    return this.acceptPaths(pageId, id, paths);
  }

  async cancelAny(id = ''): Promise<boolean> {
    if (!id) {
      const pending = this.pendingAny();
      return pending ? this.cancel(pending.pageId, pending.id) : false;
    }
    const pageId = this.pageIdForId(id);
    return pageId ? this.cancel(pageId, id) : false;
  }

  private watchPage(page: Page): void {
    const extId = extensionIdFor(page);
    const initialKind = kindFor(page);
    const ref = this.pages.idFor(page)
      ? this.pages.get(this.pages.idFor(page)!)
      : this.pages.register(page, { kind: initialKind, ...(extId ? { extensionId: extId } : {}) });
    if (!ref || this.choosers.has(ref.pageId)) return;

    const updateKind = () => {
      const currentRef = this.pages.get(ref.pageId);
      if (currentRef) {
        const k = kindFor(page);
        if (k !== 'other' || currentRef.kind === 'other') currentRef.kind = k;
        const eid = extensionIdFor(page);
        if (eid) currentRef.extensionId = eid;
      }
    };
    page.on('domcontentloaded', updateKind);
    page.on('framenavigated', updateKind);

    const chooser = new RemoteFileChooser(
      this.userId,
      {
        onPending: (pending) => this.emit({ type: 'pending', notice: this.notice(ref.pageId, pending) }),
        onDone: (pending, reason) => this.emit({
          type: 'done',
          notice: this.notice(ref.pageId, pending),
          ...(reason ? { reason } : {}),
        }),
      },
    );
    this.choosers.set(ref.pageId, chooser);
    chooser.watchPage(page);
    page.once('close', () => {
      this.choosers.delete(ref.pageId);
      this.pages.invalidate(ref.pageId);
    });
  }

  private requireChooser(pageId: string): RemoteFileChooser {
    const chooser = this.choosers.get(pageId);
    if (!chooser) throw new Error(`No file chooser owner for page ${pageId}.`);
    return chooser;
  }

  private notice(pageId: string, pending: PendingChooser): FileChooserNotice {
    const pageRef = this.pages.get(pageId);
    if (pageRef && pageRef.page) {
      const k = kindFor(pageRef.page);
      if (k !== 'other' || pageRef.kind === 'other') pageRef.kind = k;
      const eid = extensionIdFor(pageRef.page);
      if (eid) pageRef.extensionId = eid;
    }
    return {
      ...pending,
      id: `${pageId}:${pending.id}`,
      pageId,
      profileId: this.profileId,
      runtimeId: this.runtimeId,
      ...(pageRef?.kind ? { kind: pageRef.kind } : {}),
      ...(pageRef?.extensionId ? { extensionId: pageRef.extensionId } : {}),
    };
  }

  private localId(pageId: string, id: string): string {
    const prefix = `${pageId}:`;
    return String(id).startsWith(prefix) ? String(id).slice(prefix.length) : String(id);
  }

  private pageIdForId(id: string): string | null {
    const value = String(id || '');
    if (this.cdpChoosers.has(value)) {
      return this.cdpChoosers.get(value)!.pageId;
    }
    for (const [key, cdp] of this.cdpChoosers.entries()) {
      if (value.startsWith(`${cdp.pageId}:`) || key === value) return cdp.pageId;
    }
    for (const pageId of this.choosers.keys()) {
      if (value.startsWith(`${pageId}:`)) return pageId;
      const pending = this.pendingForPage(pageId);
      if (pending && pending.id === value) return pageId;
    }
    return null;
  }

  private emit(event: { type: 'pending' | 'done'; notice: FileChooserNotice; reason?: string }): void {
    for (const listener of this.listeners) listener(event);
  }
}
