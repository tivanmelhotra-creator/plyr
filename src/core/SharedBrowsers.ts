/**
 * SharedBrowsers — the ONE view of every live browser on the remote desktop,
 * for both entry points of the Workflow Files drawer:
 *
 *   Local Browser   (Turn on / Turn off / Show browser)   RealChrome singleton
 *   Browser Profiles (Open / Close / Release / Restore)   core/ProfileBrowser
 *
 * Before this module the two had separate truths: the Local Browser row (and
 * the viewer tab's liveness check) asked `RealChrome.isRunning()` only, the
 * profile panel asked core/BrowserSessions only. A viewer opened for a profile
 * therefore saw "no browser" and closed itself; Turn off knew nothing about
 * profile browsers; the UI showed contradictory states.
 *
 * Now RealChrome registers its browser in core/BrowserSessions as the session
 * `realchrome` (the same id its run lease uses), with the permanent dependent
 * `operator:local-browser` while it is up. Everything that asks "what is open,
 * who depends on it, may it be closed" asks BrowserSessions.
 *
 * Also here: closeContextBounded(), the one close used by Turn off, Close
 * browser and shutdown — every page close and the context close have a
 * deadline, so a page stuck on a dialog can never leave a request (and the UI
 * waiting on it) hanging.
 */
import type { BrowserContext } from 'playwright';
import { browserSessions, runningProfileOf, type SessionRecord, type Visibility } from './BrowserSessions';

export const LOCAL_BROWSER_SESSION = 'realchrome';
export const LOCAL_BROWSER_DEPENDENT = 'operator:local-browser';

export function localBrowserOpened(visibility: Visibility): void {
  const s = browserSessions();
  s.opened(LOCAL_BROWSER_SESSION, { userId: 'local', visibility, createdBy: LOCAL_BROWSER_DEPENDENT });
  s.attach(LOCAL_BROWSER_SESSION, LOCAL_BROWSER_DEPENDENT);
}

export function localBrowserClosed(): void {
  browserSessions().closed(LOCAL_BROWSER_SESSION);
}

export interface SessionSummary {
  /** Session id (`realchrome`, `default`, `named:<id>`). */
  id: string;
  kind: 'local-browser' | 'profile';
  /** Registry profile id (null for the Local Browser). */
  profileId: string | null;
  name: string;
  visibility: Visibility;
  runs: number;
  views: number;
  startedAt: number;
}

/** Registry profile id of a session id, or null. Pure. */
export function profileIdOfSession(id: string): string | null {
  if (id === LOCAL_BROWSER_SESSION) return null;
  // Branch sessions (`branch:<user>/branch-NNN`, core/BranchRegistry) carry no
  // profile id in their key: the branch runs ONE profile, recorded at launch.
  const running = runningProfileOf(id);
  if (running) return running;
  if (id === 'default') return 'default';
  return id.startsWith('named:') ? id.slice('named:'.length) : null;
}

/** Pure: what the UI may know about the open sessions (no paths, no URLs). */
export function summarize(list: SessionRecord[], nameOf: (profileId: string) => string | undefined): SessionSummary[] {
  return list.map((r) => {
    const pid = profileIdOfSession(r.leaseId);
    const local = r.leaseId === LOCAL_BROWSER_SESSION;
    return {
      id: r.leaseId,
      kind: local ? 'local-browser' : 'profile',
      profileId: pid,
      name: local ? 'Local Browser' : (pid && nameOf(pid)) || pid || r.leaseId,
      visibility: r.visibility,
      runs: r.dependents.filter((d) => d.startsWith('job:') || d.startsWith('grant:')).length,
      views: r.dependents.filter((d) => d.startsWith('operator:') && d !== LOCAL_BROWSER_DEPENDENT).length,
      startedAt: r.startedAt,
    } as SessionSummary;
  }).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'local-browser' ? -1 : 1));
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => { const t = setTimeout(() => r('timeout'), ms); if (typeof t.unref === 'function') t.unref(); })]);
}

/**
 * Close a context with deadlines: each page `pageMs`, the context `contextMs`.
 * Returns whether the context's close completed in time. Never throws.
 */
export async function closeContextBounded(ctx: BrowserContext | null | undefined,
  opts: { closePages?: boolean; pagesOnly?: boolean; pageMs?: number; contextMs?: number } = {}): Promise<{ closed: boolean; timedOut: boolean }> {
  if (!ctx) return { closed: true, timedOut: false };
  const pageMs = opts.pageMs ?? 2000;
  const contextMs = opts.contextMs ?? 8000;
  if (opts.closePages) {
    let pages: ReturnType<BrowserContext['pages']> = [];
    try { pages = ctx.pages(); } catch { pages = []; }
    // In parallel: one page stuck on a dialog must not delay the others.
    await Promise.all(pages.map((p) => within(p.close({ runBeforeUnload: false }).catch(() => undefined), pageMs)));
  }
  if (opts.pagesOnly) return { closed: false, timedOut: false };
  const r = await within(ctx.close().then(() => 'ok' as const).catch(() => 'ok' as const), contextMs);
  return { closed: r !== 'timeout', timedOut: r === 'timeout' };
}
