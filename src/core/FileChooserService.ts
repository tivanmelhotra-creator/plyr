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
  private readonly cdpChoosers = new Map<string, {
    id: string;
    sessionId: string;
    pageId: string;
    /** DOM.BackendNodeId of the clicked <input type=file>, from Page.fileChooserOpened. */
    backendNodeId?: number;
    /** The target's URL when the chooser opened — matches a Playwright-tracked twin. */
    targetUrl?: string;
    notice: FileChooserNotice;
  }>();
  private cdpSeq = 0;
  private cdpMsgId = 0;
  private readonly cdpPending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();

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

  attachCDP(wsUrl: string): void {
    if (!wsUrl || this.cdpWs) return;
    try {
      const ws = new WebSocket(wsUrl);
      this.cdpWs = ws;
      const targetSessions = new Map<string, { sessionId: string; targetInfo: { targetId: string; type: string; url: string; title: string } }>();

      ws.on('open', () => {
        this.sendCdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
          .catch((e) => this.cdpError('Target.setAutoAttach', e));
        this.sendCdp('Target.setDiscoverTargets', { discover: true })
          .catch((e) => this.cdpError('Target.setDiscoverTargets', e));
        this.sendCdp('Target.getTargets', {})
          .catch((e) => this.cdpError('Target.getTargets', e));
      });

      ws.on('message', (data: WebSocket.Data) => {
        let msg: any;
        try { msg = JSON.parse(String(data)); } catch { return; }

        // ── Command responses / errors ──────────────────────────────────
        // A response carries an id and no method; an event the reverse. The id
        // is correlated back to its send so a failure is thrown and logged
        // instead of vanishing — the missing visibility behind "the extension
        // import silently did nothing".
        if (msg && typeof msg.id === 'number') {
          const pending = this.cdpPending.get(msg.id);
          if (pending) {
            this.cdpPending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`${msg.error.message || 'CDP error'} (code ${msg.error.code ?? '?'})`));
            } else {
              pending.resolve(msg.result);
              // getTargets doubles as the initial attach sweep: its result names
              // the targets that already existed before auto-attach was on.
              if (msg.result && Array.isArray(msg.result.targetInfos)) {
                for (const t of msg.result.targetInfos) {
                  if (t.type === 'page' || t.type === 'other' || t.type === 'service_worker' || t.type === 'background_page') {
                    this.sendCdp('Target.attachToTarget', { targetId: t.targetId, flatten: true })
                      .catch((e) => this.cdpError('Target.attachToTarget', e));
                  }
                }
              }
            }
          } else if (msg.error) {
            console.error(`[CDP] command #${msg.id} failed: ${msg.error.message} (code ${msg.error.code ?? '?'})`);
          }
          return;
        }

        try {
          if (msg.method === 'Target.attachedToTarget') {
            const { sessionId, targetInfo } = msg.params;
            targetSessions.set(sessionId, { sessionId, targetInfo });
            // Tracked (not raw send) so a target that refuses Page.* — e.g.
            // some worker/background sessions — logs instead of silently
            // leaving file-chooser interception off.
            this.sendCdp('Page.enable', {}, sessionId)
              .catch((e) => this.cdpError('Page.enable', e, sessionId));
            this.sendCdp('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)
              .catch((e) => this.cdpError('Page.setInterceptFileChooserDialog', e, sessionId));
          } else if (msg.method === 'Target.detachedFromTarget') {
            const { sessionId } = msg.params;
            targetSessions.delete(sessionId);
            for (const [key, entry] of this.cdpChoosers.entries()) {
              if (entry.sessionId === sessionId) {
                this.cdpChoosers.delete(key);
                this.emit({ type: 'done', notice: entry.notice, reason: 'closed' });
              }
            }
          } else if (msg.method === 'Page.fileChooserOpened') {
            const sessionId = msg.sessionId;
            const target = targetSessions.get(sessionId);
            const targetType = target?.targetInfo.type;
            const isExtension = target?.targetInfo.url?.startsWith('chrome-extension://') || targetType === 'other';
            // Regular web tabs are ALREADY intercepted by the Playwright side
            // (watch() -> page.on('filechooser')). Registering the same dialog
            // here too creates a SECOND pending entry per click, which is what
            // makes "Add File" prompt twice and swallows the first selection
            // (the view answers the CDP entry, then re-asks for the stale
            // Playwright entry). Only targets Playwright does not surface as a
            // Page — extension views, service workers, background pages — need
            // the raw CDP path.
            if (targetType === 'page' && !isExtension) return;
            const extId = target?.targetInfo.url?.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
            const chooserSeq = ++this.cdpSeq;
            const localId = `cdp${chooserSeq}`;
            const pageId = `cdp:${target?.targetInfo.targetId || sessionId}`;
            const fullId = `${pageId}:${localId}`;
            const multiple = msg.params.mode === 'selectMultiple';
            // The clicked <input type=file>'s backend node id. handleFileChooser
            // must echo it back to target THIS chooser; without it Chromium falls
            // back to "the currently open chooser", which is unreliable inside
            // extension popups / service workers — the silent extension-import
            // failure. JSON.stringify drops it when undefined, preserving the
            // old "currently open chooser" behaviour for targets that lack it.
            const backendNodeId = msg.params.backendNodeId as number | undefined;
            // Trace line: names the target and whether Chromium reported a
            // backendNodeId — the two facts that decide whether handleFileChooser
            // can address the extension's own <input>.
            console.log(
              `[CDP] fileChooserOpened session=${sessionId} target=${target?.targetInfo.type || '?'} `
              + `url=${target?.targetInfo.url || '?'} mode=${msg.params?.mode} `
              + `backendNodeId=${msg.params?.backendNodeId ?? 'MISSING'}`,
            );
            const notice: FileChooserNotice = {
              id: fullId,
              pageId,
              profileId: this.profileId,
              runtimeId: this.runtimeId,
              multiple,
              accept: '',
              name: 'file',
              at: Date.now(),
              kind: isExtension ? 'extension' : 'other',
              ...(extId ? { extensionId: extId } : {}),
            };
            this.cdpChoosers.set(fullId, {
              id: fullId,
              sessionId,
              pageId,
              ...(backendNodeId !== undefined ? { backendNodeId } : {}),
              ...(target?.targetInfo.url ? { targetUrl: target.targetInfo.url } : {}),
              notice,
            });
            this.emit({ type: 'pending', notice });
          }
        } catch { /* ignore event-handling errors */ }
      });

      ws.on('error', () => { /* quiet on error */ });
      ws.on('close', () => {
        this.cdpWs = null;
      });
    } catch { /* ignored */ }
  }

  /**
   * Send one CDP command and settle on its response. Every command gets a
   * unique id and its response/error is correlated back, so a failure is an
   * Error here instead of a silently swallowed message — the previous
   * fire-and-forget `handleFileChooser` hid the real reason an extension
   * import did nothing.
   */
  private sendCdp(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs = 10_000): Promise<unknown> {
    if (!this.cdpWs || this.cdpWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP transport is not open (${method}).`));
    }
    const id = ++this.cdpMsgId;
    const payload: Record<string, unknown> = { id, method };
    if (params && Object.keys(params).length) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.cdpPending.delete(id)) {
          reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);
      this.cdpPending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.cdpWs!.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.cdpPending.delete(id);
        reject(e as Error);
      }
    });
  }

  private cdpError(method: string, err: unknown, sessionId?: string): void {
    const text = err instanceof Error ? err.message : String(err);
    console.error(`[CDP] ${method} failed${sessionId ? ` (session ${sessionId})` : ''}: ${text}`);
  }

  dispose(): void {
    if (this.cdpWs) {
      try { this.cdpWs.close(); } catch { /* ignore */ }
      this.cdpWs = null;
    }
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
    const cdp = this.cdpChoosers.get(id) || Array.from(this.cdpChoosers.values()).find((c) => c.id === id || c.pageId === pageId);
    if (cdp) {
      // Resolve like the Playwright path: drop tokens that no longer resolve
      // rather than letting ONE bad token reject the whole batch (Promise.all
      // here was the one divergent call site).
      const paths: string[] = [];
      for (const token of (Array.isArray(tokens) ? tokens : [])) {
        try { paths.push(await resolveUpload(this.userId, String(token))); } catch { /* dropped */ }
      }
      if (!paths.length) {
        this.cdpChoosers.delete(cdp.id);
        this.emit({ type: 'done', notice: cdp.notice, reason: 'no_valid_files' });
        throw new Error('None of those uploads are still available.');
      }
      // A single-file input is handed ONE file, not the first of five. The
      // Playwright path truncates (multiple ? paths : [paths[0]]); the CDP path
      // not doing so hands Chromium a list it rejects wholesale — an import
      // that "succeeded" and did nothing.
      const use = cdp.notice.multiple ? paths : [paths[0]];
      try {
        await this.handleCdpChooser(cdp, { action: 'accept', files: use });
      } catch (e) {
        // The Playwright twin may hold the real dialog. This happens when BOTH
        // channels see the same chooser — an extension popup that Playwright
        // DOES surface as a Page, for instance — and Chromium refuses a second
        // handler because the first (Playwright's) owns it. Releasing the CDP
        // entry and answering through the twin completes the import instead of
        // failing it.
        const twin = this.playwrightTwinFor(cdp);
        this.cdpChoosers.delete(cdp.id);
        if (twin) {
          try {
            const done = await twin.chooser.accept(twin.pendingId, tokens);
            this.emit({ type: 'done', notice: cdp.notice });
            return done;
          } catch { /* fall through to the loud failure below */ }
        }
        this.emit({ type: 'done', notice: cdp.notice, reason: 'failed' });
        throw e;
      }
      this.cdpChoosers.delete(cdp.id);
      this.emit({ type: 'done', notice: cdp.notice });
      // Success, but the same dialog may ALSO be held by a Playwright twin.
      // Its FileChooser promise never settles now that Chromium closed the
      // dialog through our session, so without this the twin stays pending for
      // its full TTL and the view re-prompts for a request just answered —
      // the double-prompt symptom. cancel() on a closed chooser is harmless.
      const twin = this.playwrightTwinFor(cdp);
      if (twin) {
        try { await twin.chooser.cancel(twin.pendingId); } catch { /* already gone */ }
      }
      // File the bytes under <workflow>/uploads/ exactly as the Playwright
      // path does (RemoteFileChooser.accept -> persistUploads). Without this
      // the CDP path reported success while the drawer's uploads/ stayed
      // empty — the reported "the upload never appeared in the workspace".
      // After the hand-over (the page never waits on a copy) and never fatal.
      let persisted: string[] = [];
      try {
        persisted = (await persistUploads(await realChromeWorkflowForTransfer(), use)).map((e) => e.path);
      } catch { /* logged inside persistUploads */ }
      return { count: use.length, persisted };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.accept(this.localId(pageId, id), tokens);
  }

  async acceptPaths(pageId: string, id: string, paths: string[]): Promise<{ count: number }> {
    const cdp = this.cdpChoosers.get(id) || Array.from(this.cdpChoosers.values()).find((c) => c.id === id || c.pageId === pageId);
    if (cdp) {
      const list = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (!list.length) {
        this.cdpChoosers.delete(cdp.id);
        this.emit({ type: 'done', notice: cdp.notice, reason: 'no_valid_files' });
        throw new Error('No file was selected.');
      }
      // Same single-file discipline as accept(): one file to a single-file
      // input, never a list Chromium will refuse.
      const use = cdp.notice.multiple ? list : [list[0]];
      try {
        await this.handleCdpChooser(cdp, { action: 'accept', files: use });
      } catch (e) {
        const twin = this.playwrightTwinFor(cdp);
        this.cdpChoosers.delete(cdp.id);
        if (twin) {
          try {
            const done = await twin.chooser.acceptPaths(twin.pendingId, use);
            this.emit({ type: 'done', notice: cdp.notice });
            return done;
          } catch { /* fall through to the loud failure below */ }
        }
        this.emit({ type: 'done', notice: cdp.notice, reason: 'failed' });
        throw e;
      }
      this.cdpChoosers.delete(cdp.id);
      this.emit({ type: 'done', notice: cdp.notice });
      // Same twin release as accept(): a chooser the CDP side just answered
      // must not stay pending on the Playwright side too.
      const twin = this.playwrightTwinFor(cdp);
      if (twin) {
        try { await twin.chooser.cancel(twin.pendingId); } catch { /* already gone */ }
      }
      return { count: use.length };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.acceptPaths(this.localId(pageId, id), paths);
  }

  async cancel(pageId: string, id = ''): Promise<boolean> {
    const cdp = id ? this.cdpChoosers.get(id) : Array.from(this.cdpChoosers.values()).find((c) => c.pageId === pageId);
    if (cdp) {
      try {
        await this.sendCdp('Page.handleFileChooser', { action: 'cancel' }, cdp.sessionId);
      } catch (e) {
        this.cdpError('Page.handleFileChooser (cancel)', e, cdp.sessionId);
      }
      this.cdpChoosers.delete(cdp.id);
      // The same dialog can also be held by a Playwright twin (see
      // playwrightTwinFor). Cancelling only the CDP entry would leave the twin
      // pending, so the view re-prompts for a request the operator just
      // refused — the "it asks twice" symptom. Cancel both; a no-op on an
      // already-released chooser is swallowed inside cancel().
      const twin = this.playwrightTwinFor(cdp);
      if (twin) {
        try { await twin.chooser.cancel(twin.pendingId); } catch { /* already gone */ }
      }
      this.emit({ type: 'done', notice: cdp.notice, reason: 'cancelled' });
      return true;
    }
    const chooser = this.choosers.get(pageId);
    if (!chooser) return false;
    return chooser.cancel(id ? this.localId(pageId, id) : '');
  }

  /**
   * Deliver a file to a CDP-held chooser and fail LOUDLY when Chromium refuses
   * it. Fire-and-forget made an extension import look like it worked while the
   * command was rejected; now the rejection propagates to the route, which
   * tells the operator why.
   *
   * A captured backendNodeId is echoed (the only way to target the extension's
   * own <input>); when there is none, Chromium falls back to the currently-open
   * chooser on the session.
   */
  private async handleCdpChooser(
    cdp: { id: string; sessionId: string; pageId: string; backendNodeId?: number; notice: FileChooserNotice },
    params: Record<string, unknown>,
  ): Promise<void> {
    const withNode = {
      ...params,
      ...(cdp.backendNodeId !== undefined ? { backendNodeId: cdp.backendNodeId } : {}),
    };
    try {
      await this.sendCdp('Page.handleFileChooser', withNode, cdp.sessionId);
    } catch (e) {
      this.cdpError('Page.handleFileChooser', e, cdp.sessionId);
      throw new Error(`The page did not accept the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The Playwright-side chooser that holds the SAME dialog as a CDP entry.
   *
   * An extension popup is a target Playwright DOES surface as a Page, so the
   * same click can register on both channels: the CDP entry here, and a
   * page.on('filechooser') hold in `choosers`. Chromium answers one handler;
   * whichever loses races with "file chooser already handled". The twin is
   * matched by the target's URL — the extension page URL is unique per view —
   * and only a chooser with a live pending dialog qualifies.
   */
  private playwrightTwinFor(cdp: {
    notice: FileChooserNotice;
    targetUrl?: string;
  }): { chooser: RemoteFileChooser; pageId: string; pendingId: string } | null {
    if (!cdp.targetUrl) return null;
    for (const [pageId, chooser] of this.choosers.entries()) {
      const pending = chooser.pending();
      if (!pending) continue;
      const ref = this.pages.get(pageId);
      let url = '';
      try { url = ref?.page.url() || ''; } catch { /* page closing */ }
      if (url && url === cdp.targetUrl) {
        return { chooser, pageId, pendingId: pending.id };
      }
    }
    return null;
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
