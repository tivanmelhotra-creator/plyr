import type { BrowserContext, Page } from 'playwright';
import { BrowserPageRegistry, type BrowserPageKind, type BrowserPageRef } from './BrowserPageRegistry';
import type { BrowserProfileRuntime } from './BrowserProfileRuntime';
import { RealChrome } from './RealChrome';

function pageKind(page: Page): BrowserPageKind {
  let url = '';
  try { url = page.url(); } catch { /* page is closing */ }
  if (url.startsWith('chrome-extension://')) return 'extension';
  if (url.startsWith('https://accounts.') || url.includes('/oauth')) return 'oauth';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'tab';
  return 'other';
}

/**
 * The first BrowserProfileRuntime implementation. It delegates browser
 * ownership to the existing RealChrome singleton; it never launches a second
 * browser. The adapter only adds stable Profile identity, replaceable runtime
 * identity, and canonical Page discovery around that implementation.
 */
export class RealChromeRuntimeAdapter implements BrowserProfileRuntime {
  public readonly profileId: string;
  private currentRuntimeId = '';
  private contextRef: BrowserContext | null = null;
  private registry: BrowserPageRegistry | null = null;

  constructor(profileId = 'default') {
    this.profileId = profileId;
  }

  get runtimeId(): string {
    return this.currentRuntimeId;
  }

  async start(): Promise<void> {
    const context = await RealChrome.getContext();
    await this.syncIdentity(context);
  }

  async stop(): Promise<void> {
    await RealChrome.stop();
    this.invalidatePages();
    this.contextRef = null;
    this.currentRuntimeId = '';
    this.registry = null;
  }

  async restart(): Promise<void> {
    const context = await RealChrome.restart().then(() => RealChrome.getContext());
    await this.syncIdentity(context);
  }

  async recover(): Promise<void> {
    // Recovery is a controlled replacement of the current incarnation. The
    // Profile identity remains this.profileId; RealChrome creates the new one.
    await this.restart();
  }

  isRunning(): boolean {
    return RealChrome.isRunning() && this.currentRuntimeId.length > 0;
  }

  isResponsive(): Promise<boolean> {
    return RealChrome.isResponsive();
  }

  async context(): Promise<BrowserContext> {
    const context = await RealChrome.getContext();
    await this.syncIdentity(context);
    return context;
  }

  currentPages(): BrowserPageRef[] {
    const context = this.contextRef;
    if (!context || !this.registry || !this.currentRuntimeId) return [];
    const live = new Set(context.pages());
    for (const ref of this.registry.list()) {
      if (!live.has(ref.page)) this.registry.invalidate(ref.pageId);
    }
    return this.registry.list().filter((ref) => !ref.invalidatedAt);
  }

  private async syncIdentity(context: BrowserContext): Promise<void> {
    const status = await RealChrome.status();
    if (!status.runtimeId) throw new Error('RealChrome did not expose a runtime incarnation.');

    if (this.currentRuntimeId && this.currentRuntimeId !== status.runtimeId) {
      this.invalidatePages();
    }
    this.currentRuntimeId = status.runtimeId;
    this.contextRef = context;
    const chooserRegistry = RealChrome.getFileChooserService()?.registry();
    if (chooserRegistry && chooserRegistry.list().every((ref) => ref.runtimeId === this.currentRuntimeId)) {
      this.registry = chooserRegistry;
    } else if (!this.registry || this.registry.list().some((ref) => ref.runtimeId !== this.currentRuntimeId)) {
      this.registry = new BrowserPageRegistry(this.profileId, this.currentRuntimeId);
    }
    for (const page of context.pages()) {
      if (!this.registry.idFor(page)) {
        this.registry.register(page, { kind: pageKind(page) });
      }
    }
  }

  private invalidatePages(): void {
    for (const ref of this.registry?.list() || []) this.registry?.invalidate(ref.pageId);
  }
}
