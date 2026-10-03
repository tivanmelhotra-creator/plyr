import type { BrowserContext, Page } from 'playwright';
import WebSocket from 'ws';
import { resolveUpload } from './RemoteUploads';
import { persistUploads, realChromeWorkflowForTransfer } from './WorkflowBinding';
import {
  BrowserPageRegistry,
  type BrowserPageKind,
  type BrowserPageRef,
} from './BrowserPageRegistry';
import {
  RemoteFileChooser,
  FileChooserError,
  CHOOSER_TTL_MS,
  type PendingChooser,
} from './RemoteFileChooser';

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

interface CdpChooser {
  id: string;
  sessionId: string;
  targetId: string;
  pageId: string;
  /** The <input type=file> Chrome says the dialog belongs to. */
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
  /**
   * File dialogs opened in a target PLAYWRIGHT DOES NOT OWN: an extension's
   * action popup. Keyed by chooser id. See `attachCDP` for why only those.
   */
  private readonly cdpChoosers = new Map<string, CdpChooser>();
  private cdpSeq = 0;
  /** Newest dialog sequence per target, so a slow describe cannot resurrect a stale one. */
  private readonly cdpLatest = new Map<string, number>();
  /** CDP target id -> is it one of Playwright's own pages. Filled lazily. */
  private readonly ownedTargets = new Map<string, boolean>();
  private cdpNextId = 1;
  private readonly cdpPending = new Map<number, (r: { result?: unknown; error?: { message?: string } }) => void>();

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
   * Intercept file dialogs in targets Playwright does NOT own.
   *
   * Interception is switched on for every page target (cheap, and a target
   * cannot be classified reliably at the moment it appears), but a dialog is
   * only REPORTED here when Playwright does not own the page: for the ones it
   * owns, `page.on('filechooser')` is the single source of truth.
   *
   * WHY ONLY THOSE. An extension's action popup is not a Playwright `Page`
   * (MEASURED: `context.pages()` stays `['about:blank']` while the popup is
   * open), so `page.on('filechooser')` never fires for it and the dialog
   * opened on the server's screen. This session covers exactly that gap.
   *
   * An earlier version attached to EVERY page target as well. MEASURED on
   * Chromium 145 with a plain website:
   *
   *   - one click produced TWO `Page.fileChooserOpened` (two sessions per
   *     target: auto-attach AND the explicit attach both ran), next to
   *     Playwright's own `filechooser`: three "pending" rows for one dialog;
   *   - answering one went through `Page.handleFileChooser`, a method that
   *     DOES NOT EXIST in the protocol (`-32601 wasn't found`). The send was
   *     fire-and-forget, so the error was never seen: the row was dropped as
   *     "done" and the page never got the file;
   *   - the shadow rows were listed before Playwright's real one, so the view
   *     answered a phantom first, was told nothing, and asked again. The
   *     answer that finally reached Playwright's chooser is the "every other
   *     attempt" that worked.
   *
   * Files are handed over the way Playwright itself does it: the event carries
   * the `backendNodeId` of the <input>, and `DOM.setFileInputFiles` on the
   * same session sets its files and fires input/change. The reply is awaited;
   * a failure is an error, not a silent "done".
   */
  attachCDP(wsUrl: string): void {
    if (!wsUrl || this.cdpWs) return;
    try {
      const ws = new WebSocket(wsUrl);
      this.cdpWs = ws;
      /** One session per target, never two. */
      const sessionByTarget = new Map<string, string>();
      const targetBySession = new Map<string, string>();
      const attaching = new Set<string>();

      const attach = async (t: { targetId: string; type: string; url?: string }): Promise<void> => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (t.type !== 'page' && t.type !== 'background_page' && t.type !== 'other') return;
        if (sessionByTarget.has(t.targetId) || attaching.has(t.targetId)) return;
        attaching.add(t.targetId);
        try {
          if (await this.isPlaywrightTarget(t.targetId)) return;
          const r = await this.cdpSend('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          const sessionId = (r.result as { sessionId?: string } | undefined)?.sessionId;
          if (!sessionId) return;
          sessionByTarget.set(t.targetId, sessionId);
          targetBySession.set(sessionId, t.targetId);
          await this.cdpSend('Page.enable', {}, sessionId);
          await this.cdpSend('DOM.enable', {}, sessionId);
          await this.cdpSend('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
        } finally {
          attaching.delete(t.targetId);
        }
      };

      const forget = (targetId: string, reason?: string): void => {
        const sessionId = sessionByTarget.get(targetId);
        sessionByTarget.delete(targetId);
        if (sessionId) targetBySession.delete(sessionId);
        this.ownedTargets.delete(targetId);
        this.cdpLatest.delete(targetId);
        for (const entry of [...this.cdpChoosers.values()]) {
          if (entry.targetId === targetId) this.dropCdp(entry, reason || 'closed');
        }
      };

      ws.on('open', () => {
        void this.cdpSend('Target.setDiscoverTargets', { discover: true });
        void this.cdpSend('Target.getTargets').then((r) => {
          const infos = (r.result as { targetInfos?: Array<{ targetId: string; type: string; url?: string }> } | undefined)?.targetInfos || [];
          for (const t of infos) void attach(t);
        });
      });

      ws.on('message', (data: WebSocket.Data) => {
        let msg: { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (typeof msg.id === 'number') {
          const cb = this.cdpPending.get(msg.id);
          if (cb) { this.cdpPending.delete(msg.id); cb(msg); }
          return;
        }
        const p = msg.params || {};
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
          const t = p.targetInfo as { targetId: string; type: string; url?: string } | undefined;
          if (t) void attach(t);
        } else if (msg.method === 'Target.targetDestroyed') {
          forget(String(p.targetId || ''));
        } else if (msg.method === 'Target.detachedFromTarget') {
          const targetId = targetBySession.get(String(p.sessionId || ''));
          if (targetId) forget(targetId);
        } else if (msg.method === 'Page.fileChooserOpened' && msg.sessionId) {
          const targetId = targetBySession.get(msg.sessionId);
          const sessionId = msg.sessionId;
          // Ownership is decided NOW, not when the target appeared: a page
          // Playwright opened announces itself over DevTools a moment BEFORE
          // Playwright has it in `context.pages()`, so an attach-time check
          // misjudges exactly the tabs the operator just opened (MEASURED
          // through LiveBrowser.newTab: one phantom row per click, and the
          // real one left pending after the phantom was answered, which
          // brought the "Add File" prompt back after a successful upload).
          // By the time a human clicks a file input the page is known.
          if (targetId) {
            void this.isPlaywrightTarget(targetId).then((owned) => {
              if (!owned) this.onCdpChooser(targetId, sessionId, p);
            });
          }
        }
      });

      ws.on('error', () => { /* quiet on error */ });
      ws.on('close', () => {
        if (this.cdpWs === ws) this.cdpWs = null;
        for (const [, cb] of this.cdpPending) cb({ error: { message: 'closed' } });
        this.cdpPending.clear();
        for (const entry of [...this.cdpChoosers.values()]) this.dropCdp(entry, 'closed');
      });
    } catch { /* ignored */ }
  }

  /** A CDP request whose reply is awaited. Never rejects. */
  private cdpSend(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<{ result?: unknown; error?: { message?: string } }> {
    const ws = this.cdpWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ error: { message: 'not connected' } });
    const id = this.cdpNextId++;
    return new Promise((resolve) => {
      this.cdpPending.set(id, resolve);
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (e) {
        this.cdpPending.delete(id);
        resolve({ error: { message: (e as Error)?.message || 'send failed' } });
      }
    });
  }

  /**
   * Is this DevTools target one of Playwright's own pages? Those are already
   * covered by `page.on('filechooser')`, and covering them twice is the bug.
   */
  private async isPlaywrightTarget(targetId: string): Promise<boolean> {
    const known = this.ownedTargets.get(targetId);
    if (known !== undefined) return known;
    const ctx = this.watchedContext;
    let owned = false;
    if (ctx) {
      for (const page of ctx.pages()) {
        try {
          const cdp = await ctx.newCDPSession(page);
          try {
            const info = await cdp.send('Target.getTargetInfo');
            if (info.targetInfo.targetId === targetId) { owned = true; break; }
          } finally {
            await cdp.detach().catch(() => {});
          }
        } catch { /* page closing: it is not this one */ }
      }
    }
    if (owned) this.ownedTargets.set(targetId, true);
    return owned;
  }

  private onCdpChooser(targetId: string, sessionId: string, p: Record<string, unknown>): void {
    const backendNodeId = Number(p.backendNodeId);
    // One dialog per target: a new one supersedes the old (the page re-opened it).
    for (const old of [...this.cdpChoosers.values()]) {
      if (old.targetId === targetId) this.dropCdp(old, 'superseded');
    }
    if (!Number.isFinite(backendNodeId)) return;    // nothing to hand the file to
    const seq = ++this.cdpSeq;
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
      kind: 'extension',
    };
    // The input's own accept/name first, so the operator is offered the right
    // files, and the row is only visible (and answerable) once it is complete.
    void this.cdpSend('DOM.describeNode', { backendNodeId }, sessionId).then((r) => {
      // A newer dialog on this target, or a closed session, got here first.
      if (this.cdpLatest.get(targetId) !== seq || !this.cdpWs) return;
      const attrs = (r.result as { node?: { attributes?: string[] } } | undefined)?.node?.attributes || [];
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === 'accept') notice.accept = attrs[i + 1];
        if (attrs[i] === 'name') notice.name = attrs[i + 1] || 'file';
      }
      const entry: CdpChooser = { id: fullId, sessionId, targetId, pageId, backendNodeId, notice, expiry: null };
      entry.expiry = setTimeout(() => this.dropCdp(entry, 'expired'), CHOOSER_TTL_MS);
      if (typeof entry.expiry.unref === 'function') entry.expiry.unref();
      this.cdpChoosers.set(fullId, entry);
      this.emit({ type: 'pending', notice });
    });
    this.cdpLatest.set(targetId, seq);
  }

  private dropCdp(entry: CdpChooser, reason?: string): void {
    if (this.cdpChoosers.get(entry.id) !== entry) return;
    this.cdpChoosers.delete(entry.id);
    if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
    this.emit({ type: 'done', notice: entry.notice, ...(reason ? { reason } : {}) });
  }

  private findCdp(pageId: string, id: string): CdpChooser | undefined {
    const direct = id ? this.cdpChoosers.get(id) : undefined;
    if (direct) return direct;
    if (id) return undefined;
    return [...this.cdpChoosers.values()].find((c) => c.pageId === pageId);
  }

  /**
   * Hand files to a popup's <input> and only then forget the dialog. The
   * entry is removed BEFORE the request (one answer per dialog, like
   * RemoteFileChooser), and a failed hand-over is reported to the caller.
   */
  private async cdpSetFiles(entry: CdpChooser, paths: string[]): Promise<void> {
    this.dropCdp(entry, undefined);
    const use = entry.notice.multiple ? paths : paths.slice(0, 1);
    const r = await this.cdpSend('DOM.setFileInputFiles', { files: use, backendNodeId: entry.backendNodeId }, entry.sessionId);
    if (r.error) {
      throw new FileChooserError(`The extension did not accept the file: ${r.error.message || 'unknown error'}.`);
    }
  }

  dispose(): void {
    if (this.cdpWs) {
      try { this.cdpWs.close(); } catch { /* ignore */ }
      this.cdpWs = null;
    }
    for (const entry of this.cdpChoosers.values()) if (entry.expiry) clearTimeout(entry.expiry);
    this.cdpChoosers.clear();
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
      const paths: string[] = [];
      for (const t of (Array.isArray(tokens) ? tokens : []).slice(0, 10)) {
        try { paths.push(await resolveUpload(this.userId, String(t))); } catch { /* expired or foreign token */ }
      }
      if (!paths.length) {
        this.dropCdp(cdp, 'no_valid_files');
        throw new FileChooserError('None of those uploads are still available.');
      }
      await this.cdpSetFiles(cdp, paths);
      const used = cdp.notice.multiple ? paths : paths.slice(0, 1);
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
      const list = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 10);
      if (!list.length) {
        this.dropCdp(cdp, 'no_valid_files');
        throw new FileChooserError('No file was selected.');
      }
      await this.cdpSetFiles(cdp, list);
      return { count: cdp.notice.multiple ? list.length : 1 };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.acceptPaths(this.localId(pageId, id), paths);
  }

  async cancel(pageId: string, id = ''): Promise<boolean> {
    const cdp = this.findCdp(pageId, id);
    if (cdp) {
      // The dialog was intercepted, so nothing is open on the server's screen;
      // forgetting it is releasing it.
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
