/**
 * ExtensionStep — the `open-extension` workflow step: open an installed
 * extension's page (its popup, usually) as a normal tab, so every ordinary node
 * (click, fill, upload, wait...) can drive it like a web page.
 *
 * WHY A SEPARATE STEP AND NOT `goto`
 * ----------------------------------
 * `goto` runs the target through `normalizeUrl()`, which keeps only
 * `origin + pathname`. For a `chrome-extension://` URL the origin is the opaque
 * string "null" and the query is dropped, so with smartStay (the default) a
 * `goto` to one extension's `popup.html` can "switch" to ANOTHER extension's
 * open `popup.html`, and `popup.html?url=<site>` is treated as the page we are
 * already on. Both are silent wrong answers. This step never goes through that
 * path, and `goto` is not touched, so no existing workflow changes behaviour.
 *
 * HOW AN EXTENSION IS NAMED
 * -------------------------
 * By a public slug of its manifest name ("J2TEAM Cookies" -> "j2team-cookies"),
 * never by its Chrome id. An unpacked extension's id is derived from the
 * directory path, so it differs between machines and breaks the moment the
 * install path moves; the name is the same everywhere. A raw id (directory id,
 * runtime id or Web Store id) is still accepted, as an escape hatch.
 * Ambiguity and absence are errors that list what IS installed; nothing is
 * guessed.
 *
 * WHICH BROWSER
 * -------------
 * Extensions exist in exactly one browser here: Real Chrome (headed, one
 * persistent profile, extensions loaded). Queued runs normally use a headless
 * pool with `--disable-extensions`, so a run that contains this step is attached
 * to Real Chrome instead (see pipeline.ts), serialised by
 * `withExtensionRunLock`, and confined to tabs it opened itself: it never
 * touches, adopts or closes a tab the operator has open in the viewer.
 */

import type { BrowserContext, Page } from 'playwright';
import { RealChrome, extensionPageUrlFor } from './RealChrome';

/** Step names the pipeline accepts for this behaviour. */
export const OPEN_EXTENSION_ACTIONS = ['open-extension', 'open_extension'] as const;

/** Flag on `context.data` set once the run is attached to Real Chrome. */
export const EXT_BROWSER_FLAG = '__extensionBrowser';
/** Tabs this run opened (and therefore the only tabs it may close). */
export const EXT_PAGES_KEY = '__extensionPages';
/** Detaches the popup listener installed by confineContextToOwnedPages. */
const EXT_UNLISTEN_KEY = '__extensionUnlisten';

export class ExtensionStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionStepError';
  }
}

/** The slice of a loaded extension this step needs (see RealChrome.loadedExtensions). */
export interface LoadedExtension {
  id: string;
  name: string;
  runtimeId: string;
  storeId?: string;
  url: string;
  popupUrl: string;
  optionsUrl: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Naming
// ───────────────────────────────────────────────────────────────────────────

/**
 * The public, machine-independent name of an extension.
 * Unicode-aware, so a Persian or Chinese extension name still yields a usable
 * slug instead of an empty string.
 */
export function extensionSlug(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function describeInstalled(list: LoadedExtension[]): string {
  if (!list.length) return 'No extension is loaded in Real Chrome.';
  return 'Installed: ' + list.map((e) => `${extensionSlug(e.name) || e.id} ("${e.name}")`).join(', ') + '.';
}

/**
 * Resolve what the user typed to exactly one loaded extension.
 * Slug match first (the documented way), then a raw id. Never fuzzy.
 */
export function findExtension(list: LoadedExtension[], query: string): LoadedExtension {
  const q = String(query ?? '').trim();
  if (!q) {
    throw new ExtensionStepError(`Extension is required. ${describeInstalled(list)}`);
  }

  const slug = extensionSlug(q);
  const bySlug = slug ? list.filter((e) => extensionSlug(e.name) === slug) : [];
  if (bySlug.length === 1) return bySlug[0]!;
  if (bySlug.length > 1) {
    throw new ExtensionStepError(
      `More than one installed extension is called "${q}" (${bySlug.map((e) => e.runtimeId).join(', ')}). `
      + 'Use one of those ids instead.',
    );
  }

  const byId = list.filter((e) => [e.id, e.runtimeId, e.storeId].some((v) => v && v === q));
  if (byId.length === 1) return byId[0]!;

  throw new ExtensionStepError(`No installed extension matches "${q}". ${describeInstalled(list)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// URL
// ───────────────────────────────────────────────────────────────────────────

/** A relative path inside the extension: no scheme, no traversal, no host. */
function safeExtensionPath(raw: string): string {
  // "//host/x" looks like a network-path reference; refuse it outright rather
  // than quietly reading it as "a file called host inside the extension".
  if (raw.trim().startsWith('//')) {
    throw new ExtensionStepError(
      `"${raw}" is not a valid page inside the extension. Use "popup", "options", or a path like "pages/main.html".`,
    );
  }
  const p = raw.trim().replace(/^\/+/, '');
  if (
    !p
    || p.includes('..')
    || p.includes('\\')
    || p.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(p)
    || !/^[\w.\-/%~]+(\?[^#\s]*)?(#\S*)?$/.test(p)
  ) {
    throw new ExtensionStepError(
      `"${raw}" is not a valid page inside the extension. Use "popup", "options", or a path like "pages/main.html".`,
    );
  }
  return p;
}

/**
 * The URL to open.
 *   page ''|'popup'  -> popup, else options, else the extension root
 *   page 'options'   -> its options page (error if it has none)
 *   anything else    -> that path inside the extension
 * `forSite` (an http(s) URL) is appended the way extensions that open as a tab
 * expect it (`?url=<base64>`); see extensionPageUrlFor for why it matters.
 */
export function extensionTargetUrl(ext: LoadedExtension, page: string, forSite: string): string {
  const which = String(page ?? '').trim();
  const lower = which.toLowerCase();

  if (!which || lower === 'popup') {
    const base = ext.popupUrl || ext.optionsUrl || ext.url;
    return forSite ? extensionPageUrlFor(forSite, base) || base : base;
  }
  if (lower === 'options') {
    if (!ext.optionsUrl) {
      throw new ExtensionStepError(`"${ext.name}" has no options page. Try page "popup" or a path.`);
    }
    return forSite ? extensionPageUrlFor(forSite, ext.optionsUrl) || ext.optionsUrl : ext.optionsUrl;
  }
  return ext.url + safeExtensionPath(which);
}

// ───────────────────────────────────────────────────────────────────────────
// Which runs need Real Chrome
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does this step tree contain an `open-extension` node, at any depth
 * (if/loop/try branches nest steps)? `params` is skipped on purpose: a JSON
 * body that happens to contain the words must not move a run to another browser.
 */
export function stepsUseExtensions(steps: unknown): boolean {
  let budget = 20_000; // a hostile or cyclic tree must not hang the worker
  const walk = (node: unknown, depth: number): boolean => {
    if (budget-- <= 0 || depth > 24 || node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some((n) => walk(n, depth + 1));
    const obj = node as Record<string, unknown>;
    if (typeof obj.action === 'string' && (OPEN_EXTENSION_ACTIONS as readonly string[]).includes(obj.action)) {
      return true;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'params') continue;
      if (walk(value, depth + 1)) return true;
    }
    return false;
  };
  return walk(steps, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// One extension-using run at a time
// ───────────────────────────────────────────────────────────────────────────

let lockTail: Promise<void> = Promise.resolve();
/** Runs that hold the lock or are queued for it. */
let inLine = 0;

/**
 * Real Chrome is one browser with one profile. Two runs that both import
 * cookies or click inside an extension would trample each other's state, so
 * runs that use extensions go one after another. Runs that do not use
 * extensions never come here.
 */
export async function withExtensionRunLock<T>(
  fn: () => Promise<T>,
  opts: { log?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const previous = lockTail;
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  lockTail = previous.then(() => mine);

  const ahead = inLine++;
  if (ahead > 0) opts.log?.('[EXT] Another run is using the extension browser — waiting for it to finish');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ExtensionStepError('Timed out waiting for another run to finish using the extension browser.')),
          timeoutMs,
        );
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch (e) {
    inLine--;
    release(); // give our place in the chain back so it keeps moving
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    return await fn();
  } finally {
    inLine--;
    release();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Browser + step
// ───────────────────────────────────────────────────────────────────────────

/** Real Chrome's context, started if needed, with errors a user can act on. */
export async function acquireExtensionBrowser(): Promise<BrowserContext> {
  if (!RealChrome.isEnabled()) {
    throw new ExtensionStepError(
      'Real Chrome is disabled on this server (REAL_CHROME_ENABLED), so a run cannot use extensions.',
    );
  }
  try {
    return await RealChrome.getContext();
  } catch (e) {
    throw new ExtensionStepError(`Could not start the extension browser: ${(e as Error)?.message || e}`);
  }
}

/** The subset of the pipeline context this module reads and writes. */
export interface ExtensionStepContext {
  browserContext?: BrowserContext;
  page?: Page;
  data: Record<string, any>;
}

function ownedPages(data: Record<string, any>): Page[] {
  return Array.isArray(data[EXT_PAGES_KEY]) ? data[EXT_PAGES_KEY] : [];
}

/** Remember a tab this run opened, so it (and only it) is closed afterwards. */
export function trackOwnedPage(data: Record<string, any>, page: Page): void {
  const list = ownedPages(data);
  if (!list.includes(page)) list.push(page);
  data[EXT_PAGES_KEY] = list;
}

/**
 * A view of Real Chrome's context that only knows this run's own tabs.
 *
 * Real Chrome is shared with the operator's viewer, and the pipeline's own
 * steps enumerate `browserContext.pages()` freely: `goto` with smartStay
 * "switches" to ANY open tab on the target URL, `close-tab` can close by index
 * or "all except", `switch-tab` lists everything. On a pool context that is
 * harmless (every tab is the run's). Here it would let a run take over, or
 * close, a tab the operator is working in.
 *
 * Rather than patch each of those steps, hand the run a context whose
 * `pages()` is the run's own tabs and whose `newPage()` registers what it
 * opens. Popups a tab opens (window.open, target=_blank) are adopted through
 * their opener. Everything else passes straight through to the real context.
 */
export function confineContextToOwnedPages(real: BrowserContext, data: Record<string, any>): BrowserContext {
  const onPage = (popup: Page): void => {
    void popup.opener()
      .then((opener) => { if (opener && ownedPages(data).includes(opener)) trackOwnedPage(data, popup); })
      .catch(() => { /* popup died before we could ask */ });
  };
  real.on('page', onPage);
  data[EXT_UNLISTEN_KEY] = () => { try { real.off('page', onPage); } catch { /* context gone */ } };

  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'pages') {
        return (): Page[] => ownedPages(data).filter((p) => !p.isClosed());
      }
      if (prop === 'newPage') {
        return async (...args: unknown[]): Promise<Page> => {
          const page = await (target.newPage as (...a: unknown[]) => Promise<Page>).apply(target, args);
          trackOwnedPage(data, page);
          return page;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Close the tabs this run opened. Never throws; never touches any other tab. */
export async function closeOwnedPages(data: Record<string, any>): Promise<void> {
  const list = ownedPages(data);
  data[EXT_PAGES_KEY] = [];
  const unlisten = data[EXT_UNLISTEN_KEY];
  data[EXT_UNLISTEN_KEY] = undefined;
  if (typeof unlisten === 'function') unlisten();
  for (const page of list) {
    try { if (!page.isClosed()) await page.close(); } catch { /* already gone */ }
  }
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
}

function currentSiteUrl(page: Page | undefined): string {
  try {
    const u = page?.url() || '';
    return /^https?:\/\//i.test(u) ? u : '';
  } catch {
    return '';
  }
}

export interface OpenExtensionResult {
  extension: string;
  extensionId: string;
  url: string;
  newTab: boolean;
  forSite?: string;
}

/**
 * Execute one `open-extension` step.
 * `listExtensions` is injectable so the logic is testable without a browser.
 */
export async function runOpenExtensionStep(
  ctx: ExtensionStepContext,
  params: Record<string, any>,
  deps: { listExtensions?: () => LoadedExtension[]; log?: (msg: string) => void } = {},
): Promise<OpenExtensionResult> {
  if (!ctx.data[EXT_BROWSER_FLAG] || !ctx.browserContext) {
    throw new ExtensionStepError(
      'Extensions are available only in the server\'s Real Chrome. This run is not using it '
      + '(it is attached to your own local browser).',
    );
  }

  const list = (deps.listExtensions || (() => RealChrome.loadedExtensions() as LoadedExtension[]))();
  const ext = findExtension(list, String(params.extension ?? ''));

  const explicitSite = String(params.forSite ?? '').trim();
  const forSite = explicitSite || currentSiteUrl(ctx.page);
  const url = extensionTargetUrl(ext, String(params.page ?? ''), forSite);

  const timeout = parseInt(params.timeout, 10) || 30_000;
  const waitUntil = (['load', 'domcontentloaded', 'networkidle'].includes(params.waitUntil)
    ? params.waitUntil
    : 'domcontentloaded') as 'load' | 'domcontentloaded' | 'networkidle';
  // Off by default: a tab of its own, so the site tab is still there afterwards.
  const newTab = !asBool(params.sameTab, false);

  let page: Page;
  let opened = false;
  if (newTab || !ctx.page || ctx.page.isClosed()) {
    page = await ctx.browserContext.newPage();
    trackOwnedPage(ctx.data, page);
    opened = true;
  } else {
    page = ctx.page;
  }

  try {
    await page.goto(url, { waitUntil, timeout });
  } catch (e) {
    if (opened) await page.close().catch(() => { /* ignore */ });
    throw new ExtensionStepError(
      `Could not open "${ext.name}" (${url}): ${(e as Error)?.message || e}. `
      + 'Check that the extension is enabled in Real Chrome.',
    );
  }
  await page.bringToFront().catch(() => { /* not fatal */ });

  ctx.page = page;
  deps.log?.(`[EXT] Opened ${ext.name} (${page.url()})`);
  return {
    extension: ext.name,
    extensionId: ext.runtimeId,
    url: page.url(),
    newTab: opened,
    ...(forSite ? { forSite } : {}),
  };
}
