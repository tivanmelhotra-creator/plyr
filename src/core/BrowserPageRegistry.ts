import type { Page } from 'playwright';

export type BrowserPageKind =
  | 'tab'
  | 'extension'
  | 'popup'
  | 'options'
  | 'oauth'
  | 'other';

export type PageLeaseOwner =
  | { kind: 'automation'; scopeId: string }
  | { kind: 'human'; sessionId: string };

export interface BrowserPageRef {
  pageId: string;
  profileId: string;
  runtimeId: string;
  page: Page;
  kind: BrowserPageKind;
  extensionId?: string;
  openerPageId?: string;
  lease?: PageLeaseOwner;
  invalidatedAt?: number;
}

export class PageRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRegistryError';
  }
}

/**
 * Canonical identity and ownership registry for pages inside one runtime.
 *
 * The registry deliberately does not infer identity from the UI active tab.
 * Page ids remain stable for the life of a Page object and are invalidated
 * explicitly when Chromium closes or replaces that object.
 */
export class BrowserPageRegistry {
  private readonly pagesById = new Map<string, BrowserPageRef>();
  private readonly idsByPage = new WeakMap<Page, string>();
  private sequence = 0;

  constructor(
    private readonly profileId: string,
    private readonly runtimeId: string,
  ) {}

  register(
    page: Page,
    input: Omit<BrowserPageRef, 'pageId' | 'profileId' | 'runtimeId' | 'page'> & { pageId?: string },
  ): BrowserPageRef {
    const existingId = this.idsByPage.get(page);
    if (existingId) {
      const existing = this.pagesById.get(existingId);
      if (existing) return existing;
    }

    const pageId = input.pageId || `${this.runtimeId}:p${++this.sequence}`;
    if (this.pagesById.has(pageId)) {
      throw new PageRegistryError(`Page id is already registered: ${pageId}`);
    }

    const ref: BrowserPageRef = {
      pageId,
      profileId: this.profileId,
      runtimeId: this.runtimeId,
      page,
      kind: input.kind,
      ...(input.extensionId ? { extensionId: input.extensionId } : {}),
      ...(input.openerPageId ? { openerPageId: input.openerPageId } : {}),
      ...(input.lease ? { lease: input.lease } : {}),
    };
    this.pagesById.set(pageId, ref);
    this.idsByPage.set(page, pageId);
    return ref;
  }

  get(pageId: string): BrowserPageRef | undefined {
    return this.pagesById.get(pageId);
  }

  idFor(page: Page): string | undefined {
    return this.idsByPage.get(page);
  }

  list(): BrowserPageRef[] {
    return [...this.pagesById.values()];
  }

  invalidate(pageId: string): boolean {
    const ref = this.pagesById.get(pageId);
    if (!ref) return false;
    ref.invalidatedAt = Date.now();
    ref.lease = undefined;
    return true;
  }

  remove(pageId: string): boolean {
    return this.pagesById.delete(pageId);
  }

  acquireLease(
    pageId: string,
    owner: PageLeaseOwner,
    mode: 'exclusive' | 'observe' | 'manual_override' = 'exclusive',
  ): BrowserPageRef {
    const ref = this.requireLive(pageId);
    const current = ref.lease;
    if (!current || mode === 'observe') {
      if (mode !== 'observe') ref.lease = owner;
      return ref;
    }
    if (current.kind === owner.kind &&
        ((current.kind === 'automation' && owner.kind === 'automation' && current.scopeId === owner.scopeId) ||
         (current.kind === 'human' && owner.kind === 'human' && current.sessionId === owner.sessionId))) {
      return ref;
    }
    if (mode === 'manual_override' && owner.kind === 'human') {
      ref.lease = owner;
      return ref;
    }
    throw new PageRegistryError(`Page ${pageId} is leased by another owner.`);
  }

  releaseLease(pageId: string, owner: PageLeaseOwner): boolean {
    const ref = this.pagesById.get(pageId);
    if (!ref || !ref.lease) return false;
    const same = ref.lease.kind === owner.kind &&
      (owner.kind === 'automation'
        ? ref.lease.kind === 'automation' && ref.lease.scopeId === owner.scopeId
        : ref.lease.kind === 'human' && ref.lease.sessionId === owner.sessionId);
    if (!same) return false;
    ref.lease = undefined;
    return true;
  }

  private requireLive(pageId: string): BrowserPageRef {
    const ref = this.pagesById.get(pageId);
    if (!ref || ref.invalidatedAt) {
      throw new PageRegistryError(`Page ${pageId} is not live.`);
    }
    return ref;
  }
}
