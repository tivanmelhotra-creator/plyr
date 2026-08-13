/**
 * LiveSessions — a one-question accessor for "the live browser this user is
 * looking at".
 *
 * WHY THIS TINY MODULE EXISTS
 * ---------------------------
 * `LiveBrowserManager` is constructed in index.ts as a local binding and handed
 * to the WebSocket server that creates sessions. That is the right owner: live
 * sessions exist per socket, and the socket server is what opens and closes
 * them.
 *
 * But the Remote ⇄ Local handoff arrives over a plain HTTP route, which knows
 * only WHO is asking. To snapshot the tabs the user can actually see, it has to
 * reach the manager — and there are only three ways to arrange that:
 *
 *   1. export the manager from index.ts — makes every route import the app's
 *      entry point, which is a circular-import generator and drags server
 *      bootstrap into unit tests;
 *   2. make LiveBrowserManager a module singleton — changes who owns session
 *      lifetime, for the benefit of one read-only lookup;
 *   3. let index.ts REGISTER the manager it already owns, and have readers ask
 *      here.
 *
 * (3) is what this is, and it mirrors the injection `BrowserMode` already uses
 * for its local-availability probe: the module stays dependency-free and
 * testable offline, and the default answer is the honest one for a process where
 * nothing has been registered — "no session".
 *
 * Deliberately read-only. Nothing here creates or destroys a session; a handoff
 * that could spawn a live browser as a side effect of asking about one would be
 * a surprising and expensive lookup.
 */

import type { LiveBrowserSession } from './LiveBrowser';

/** What a provider must be able to answer. Structural, so tests can fake it. */
export interface LiveSessionProvider {
  forUser(userId: string): LiveBrowserSession | null;
}

let provider: LiveSessionProvider | null = null;

/**
 * Called once from index.ts with the manager it already owns.
 *
 * Idempotent and last-wins: a re-register during a hot reload should replace the
 * stale manager rather than be ignored, which would leave lookups pointing at
 * sessions from a previous process generation.
 */
export function setLiveSessionProvider(p: LiveSessionProvider | null): void {
  provider = p && typeof p.forUser === 'function' ? p : null;
}

/**
 * The user's current live session, or null.
 *
 * Null is a completely normal answer — a user who never opened the live view has
 * no session — so callers must treat it as "nothing to snapshot" rather than an
 * error. Never throws: a handoff must not fail because the lookup was
 * unavailable, since there is a good fallback (the persisted tab list).
 */
export const liveBrowserSessions = {
  forUser(userId: string): LiveBrowserSession | null {
    if (!provider) return null;
    try {
      return provider.forUser(userId);
    } catch {
      return null;
    }
  },
};
