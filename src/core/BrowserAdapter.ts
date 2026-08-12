'use strict';

/**
 * BrowserAdapter — the ONE place that knows there are two browser modes.
 *
 * WHY A SEAM AND NOT A SECOND ENGINE
 * ----------------------------------
 * The tempting shape for local mode is a small automation engine that runs on
 * the user's machine. It is the wrong shape, for three reasons that all bite:
 *
 *   - It would re-implement ~40 node actions. Every one of them is a chance to
 *     behave differently from the server's version.
 *   - It would lose Playwright's auto-waiting, locator engine, frame handling
 *     and `page.evaluate` — the things that make the existing nodes reliable.
 *   - The first bug fixed on one side and not the other permanently splits the
 *     product into two automations that disagree.
 *
 * So local mode changes exactly one thing: WHICH browser Playwright is attached
 * to. Playwright still runs on the server, still drives everything, and reaches
 * the user's Chrome through the reverse tunnel in LocalBridge. Both modes hand
 * back a plain `BrowserContext`, which is why the ~3100 lines of node logic in
 * pipeline.ts contain no mode checks at all.
 *
 * That is also the honest reading of the requirement "no separate Automation
 * Engine for Local": there is one engine, and it grew a second attachment point.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

import { config } from '../config';
import { GlobalBrowser } from './GlobalBrowser';
import { browserModes, type BrowserModeName } from './BrowserMode';
import { localBridges } from './LocalBridge';

export interface AcquiredContext {
  context: BrowserContext;
  mode: BrowserModeName;
  /**
   * True when the context belongs to the USER, not to us.
   *
   * This single flag is what stops the most damaging possible regression. Every
   * existing cleanup path closes `context.browserContext` when a run ends — in
   * local mode that is the user's own browser, with their tabs and their work in
   * it. Callers must treat `shared: true` as "never close this".
   */
  shared: boolean;
  /** Human-readable, for the run log. */
  detail: string;
}

/**
 * Live CDP connections to users' browsers, keyed by userId.
 *
 * Cached because `connectOverCDP` is not cheap (a version probe plus a socket
 * per target) and a user runs many jobs against the same browser. Module-level
 * rather than per-call so successive nodes in a workflow reuse one attachment.
 */
const localConnections = new Map<string, Browser>();

/** Drop a cached connection (the bridge died, or the browser was closed). */
export function forgetLocalConnection(userId: string): void {
  const browser = localConnections.get(userId);
  localConnections.delete(userId);
  if (browser) {
    // `close()` on a CDP-attached browser DETACHES; it does not close the user's
    // Chrome. Still guarded: a throw here must not mask the original failure.
    try { void browser.close().catch(() => {}); } catch { /* ignore */ }
  }
}

/**
 * Attach Playwright to the user's local Chrome through the tunnel.
 *
 * The endpoint is always `http://127.0.0.1:<ephemeral>` — a loopback listener
 * owned by LocalBridge, not the user's machine. Playwright cannot tell the
 * difference, which is exactly the point.
 */
async function connectLocal(userId: string): Promise<Browser> {
  const cached = localConnections.get(userId);
  if (cached && cached.isConnected()) return cached;
  if (cached) forgetLocalConnection(userId);

  const endpoint = await localBridges.cdpEndpoint(userId);
  if (!endpoint) {
    throw new Error(
      'No local browser is connected. Start the Local Browser Agent on your '
      + 'machine and keep it running, then switch to Local Browser again.',
    );
  }

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, {
      timeout: config.LOCAL_BROWSER_CONNECT_TIMEOUT_MS,
    });
  } catch (e) {
    // The failure the user can actually act on is almost always the same one:
    // Chrome is running, but not with a debugging port. Name the port from
    // config so the message matches their own setup rather than a guess.
    const why = (e as Error)?.message || 'unknown error';
    throw new Error(
      `Could not attach to your local Chrome (${why}). Make sure Chrome was `
      + `started with --remote-debugging-port=${config.LOCAL_BROWSER_CDP_PORT} `
      + 'and that the Local Browser Agent is still connected.',
    );
  }

  // If the attachment drops later (user quit Chrome), do not keep serving a
  // dead handle to the next node.
  browser.on('disconnected', () => {
    if (localConnections.get(userId) === browser) localConnections.delete(userId);
  });

  localConnections.set(userId, browser);
  return browser;
}

/**
 * Get a browser context for this user, in whichever mode they are in.
 *
 * `interactive` distinguishes a human at the keyboard (picker, live view — wants
 * their own cookies and a stable fingerprint) from a queued run.
 */
export async function acquireContext(
  userId: string,
  opts: {
    viewport?: { width: number; height: number };
    interactive?: boolean;
  } = {},
): Promise<AcquiredContext> {
  const mode = browserModes.modeOf(userId);

  if (mode === 'local') {
    try {
      const browser = await connectLocal(userId);

      // ── Adopt the EXISTING context; never create one ──────────────────────
      // `newContext()` on a CDP-attached Chrome produces an INCOGNITO context:
      // no cookies, no extensions, no logins. Those three things are the entire
      // reason a user chose local mode, so creating a context would silently
      // deliver the opposite of what they asked for.
      const contexts = browser.contexts();
      const context = contexts[0];
      if (!context) {
        throw new Error(
          'Your local Chrome reported no open window. Open a tab in Chrome and try again.',
        );
      }

      const info = localBridges.info(userId);
      return {
        context,
        mode: 'local',
        shared: true,
        detail: info
          ? `local browser (${info.browser} on ${info.platform})`
          : 'local browser',
      };
    } catch (e) {
      // Local just failed. Put the user back in remote before rethrowing, so
      // their NEXT action works instead of failing the same way: being stuck in
      // a mode that cannot serve a command is worse than a single failed run.
      browserModes.fallbackToRemote(userId);
      forgetLocalConnection(userId);
      throw e;
    }
  }

  // ── REMOTE: unchanged behaviour, deliberately ───────────────────────────────
  const context = opts.interactive
    ? await GlobalBrowser.getInteractiveContext(userId, opts.viewport)
    : await GlobalBrowser.getContext();

  return {
    context,
    mode: 'remote',
    shared: false,
    detail: 'remote browser (server)',
  };
}

/**
 * Give back a context acquired above.
 *
 * The whole value of this function is the first branch: a shared context is the
 * user's own browser and closing it would take their tabs with it. Everything
 * else keeps the existing remote semantics (save state for an interactive
 * session, plain close otherwise).
 */
export async function releaseContext(
  acquired: AcquiredContext,
  userId: string,
  opts: { interactive?: boolean } = {},
): Promise<void> {
  if (acquired.shared) return; // the user's browser: not ours to close

  try {
    if (opts.interactive) await GlobalBrowser.saveAndCloseContext(acquired.context, userId);
    else await GlobalBrowser.closeContext(acquired.context);
  } catch { /* releasing must never throw over the caller's own result */ }
}

/** Could this user use this mode right now? Used by the UI and the routes. */
export function canUseMode(userId: string, mode: BrowserModeName): boolean {
  if (mode === 'remote') return true; // remote is the floor; it always works
  return localBridges.isConnected(userId);
}

/** Called when a user's bridge drops: forget the connection built on it. */
export function onLocalBridgeLost(userId: string): void {
  forgetLocalConnection(userId);
}

/** Test/shutdown helper: drop every cached local attachment. */
export function resetLocalConnections(): void {
  for (const userId of [...localConnections.keys()]) forgetLocalConnection(userId);
}
