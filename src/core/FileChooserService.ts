import type { BrowserContext, Page } from 'playwright';
import WebSocket from 'ws';
import { resolveUpload } from './RemoteUploads';
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
    notice: FileChooserNotice;
  }>();
  private cdpSeq = 0;

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
      let nextId = 1;
      const targetSessions = new Map<string, { sessionId: string; targetInfo: { targetId: string; type: string; url: string; title: string } }>();

      ws.on('open', () => {
        ws.send(JSON.stringify({ id: nextId++, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
        ws.send(JSON.stringify({ id: nextId++, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(String(data));
          if (msg.method === 'Target.attachedToTarget') {
            const { sessionId, targetInfo } = msg.params;
            targetSessions.set(sessionId, { sessionId, targetInfo });
            ws.send(JSON.stringify({ id: nextId++, sessionId, method: 'Page.enable' }));
            ws.send(JSON.stringify({ id: nextId++, sessionId, method: 'Page.setInterceptFileChooserDialog', params: { enabled: true } }));
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
            const isExtension = target?.targetInfo.url?.startsWith('chrome-extension://') || target?.targetInfo.type === 'other';
            const extId = target?.targetInfo.url?.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
            const chooserSeq = ++this.cdpSeq;
            const localId = `cdp${chooserSeq}`;
            const pageId = `cdp:${target?.targetInfo.targetId || sessionId}`;
            const fullId = `${pageId}:${localId}`;
            const multiple = msg.params.mode === 'selectMultiple';
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
              notice,
            });
            this.emit({ type: 'pending', notice });
          }
        } catch { /* ignore parse errors */ }
      });

      ws.on('error', () => { /* quiet on error */ });
      ws.on('close', () => {
        this.cdpWs = null;
      });
    } catch { /* ignored */ }
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
    if (cdp && this.cdpWs && this.cdpWs.readyState === WebSocket.OPEN) {
      const paths = await Promise.all(tokens.map((t) => resolveUpload(this.userId, t)));
      this.cdpWs.send(JSON.stringify({
        id: Date.now(),
        sessionId: cdp.sessionId,
        method: 'Page.handleFileChooser',
        params: { action: 'accept', files: paths },
      }));
      this.cdpChoosers.delete(cdp.id);
      this.emit({ type: 'done', notice: cdp.notice });
      return { count: paths.length, persisted: [] };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.accept(this.localId(pageId, id), tokens);
  }

  async acceptPaths(pageId: string, id: string, paths: string[]): Promise<{ count: number }> {
    const cdp = this.cdpChoosers.get(id) || Array.from(this.cdpChoosers.values()).find((c) => c.id === id || c.pageId === pageId);
    if (cdp && this.cdpWs && this.cdpWs.readyState === WebSocket.OPEN) {
      this.cdpWs.send(JSON.stringify({
        id: Date.now(),
        sessionId: cdp.sessionId,
        method: 'Page.handleFileChooser',
        params: { action: 'accept', files: paths },
      }));
      this.cdpChoosers.delete(cdp.id);
      this.emit({ type: 'done', notice: cdp.notice });
      return { count: paths.length };
    }
    const chooser = this.requireChooser(pageId);
    return chooser.acceptPaths(this.localId(pageId, id), paths);
  }

  async cancel(pageId: string, id = ''): Promise<boolean> {
    const cdp = id ? this.cdpChoosers.get(id) : Array.from(this.cdpChoosers.values()).find((c) => c.pageId === pageId);
    if (cdp && this.cdpWs && this.cdpWs.readyState === WebSocket.OPEN) {
      this.cdpWs.send(JSON.stringify({
        id: Date.now(),
        sessionId: cdp.sessionId,
        method: 'Page.handleFileChooser',
        params: { action: 'cancel' },
      }));
      this.cdpChoosers.delete(cdp.id);
      this.emit({ type: 'done', notice: cdp.notice, reason: 'cancelled' });
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
