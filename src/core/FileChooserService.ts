import type { BrowserContext, Page } from 'playwright';
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

  watch(context: BrowserContext): void {
    if (this.watchedContext === context) return;
    this.watchedContext = context;
    for (const page of context.pages()) this.watchPage(page);
    context.on('page', (page) => this.watchPage(page));
  }

  pendingForPage(pageId: string): FileChooserNotice | null {
    const chooser = this.choosers.get(pageId);
    const pending = chooser?.pending();
    return pending ? this.notice(pageId, pending) : null;
  }

  pendingAny(): FileChooserNotice | null {
    for (const pageId of this.choosers.keys()) {
      const pending = this.pendingForPage(pageId);
      if (pending) return pending;
    }
    return null;
  }

  async accept(pageId: string, id: string, tokens: string[]) {
    const chooser = this.requireChooser(pageId);
    return chooser.accept(this.localId(pageId, id), tokens);
  }

  async acceptPaths(pageId: string, id: string, paths: string[]) {
    const chooser = this.requireChooser(pageId);
    return chooser.acceptPaths(this.localId(pageId, id), paths);
  }

  async cancel(pageId: string, id = ''): Promise<boolean> {
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
    const ref = this.pages.idFor(page)
      ? this.pages.get(this.pages.idFor(page)!)
      : this.pages.register(page, { kind: kindFor(page) });
    if (!ref || this.choosers.has(ref.pageId)) return;

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
    return {
      ...pending,
      id: `${pageId}:${pending.id}`,
      pageId,
      profileId: this.profileId,
      runtimeId: this.runtimeId,
    };
  }

  private localId(pageId: string, id: string): string {
    const prefix = `${pageId}:`;
    return String(id).startsWith(prefix) ? String(id).slice(prefix.length) : String(id);
  }

  private pageIdForId(id: string): string | null {
    const value = String(id || '');
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
