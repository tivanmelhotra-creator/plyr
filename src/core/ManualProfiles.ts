/**
 * ManualProfiles — a SECOND profile opened BY HAND in a branch whose browser is
 * already running (owner brief 2 / G.2).
 *
 * MEASURED (handoffs/2026-10-16_S36_G1-second-profile-facts.txt): Chromium
 * allows one process per user-data root, but a plain second invocation with
 * another --profile-directory is FORWARDED into the running process and opens a
 * window of that profile there. That works because Browser-Profiles browsers
 * are launched WITHOUT --enable-automation (core/BrowserProfile
 * IGNORED_DEFAULT_ARGS); with it Chromium refuses the forward (exit 21).
 * Consequences, all measured:
 *   a) the branch's Playwright context SEES the second profile's tabs
 *      (context.pages(), the 'page' event) -> automation must never use them;
 *   b) the profiles stay separate (cookies, storage);
 *   c) closing the branch's browser (Stop of the first, end of a run that owns
 *      it, idle close) closes the second profile's windows too (one process);
 *   d) closing the second profile's windows leaves the first working;
 *   e) every tab carries its profile's CDP browserContextId, so its tabs can
 *      be told apart and closed precisely.
 *
 * MANUAL-ONLY. Such a profile is never leased, never resolved for a run, and
 * never gets the branch's session: it is a set of windows inside a browser
 * that belongs to another profile. Automation that runs on the branch owns
 * the branch's browser (lease + session, unchanged) and must skip the pages
 * returned by `isManualPage`.
 *
 * LIFETIME. In memory, per branch lease key. Cleared when the branch's browser
 * closes (every window goes with it) or when its last tab closes.
 */
import type { BrowserContext, Page, CDPSession } from 'playwright';

interface Entry {
  profileId: string;
  folder: string;
  /** CDP browserContextId of this profile's tabs (learned from its first tab). */
  cdpContextId: string | null;
  openedAt: number;
}

const byBranch = new Map<string, Map<string, Entry>>();
// The CDP session used to read target info, one per branch context.
const cdpOf = new WeakMap<BrowserContext, Promise<CDPSession | null>>();

export function manualProfilesOf(leaseKey: string): string[] {
  return [...(byBranch.get(leaseKey)?.keys() || [])];
}

export function isManualProfileOpen(leaseKey: string, profileId: string): boolean {
  return !!byBranch.get(leaseKey)?.has(profileId);
}

/** Every branch with a manual profile open (for /browser/sessions). */
export function allManualProfiles(): Array<{ leaseKey: string; profileId: string; openedAt: number }> {
  const out: Array<{ leaseKey: string; profileId: string; openedAt: number }> = [];
  for (const [leaseKey, m] of byBranch) for (const e of m.values()) out.push({ leaseKey, profileId: e.profileId, openedAt: e.openedAt });
  return out;
}

export function markManualOpen(leaseKey: string, profileId: string, folder: string): void {
  let m = byBranch.get(leaseKey);
  if (!m) { m = new Map(); byBranch.set(leaseKey, m); }
  if (!m.has(profileId)) m.set(profileId, { profileId, folder, cdpContextId: null, openedAt: Date.now() });
}

export function forgetManual(leaseKey: string, profileId?: string): void {
  if (!profileId) { byBranch.delete(leaseKey); return; }
  const m = byBranch.get(leaseKey);
  if (!m) return;
  m.delete(profileId);
  if (!m.size) byBranch.delete(leaseKey);
}

/** Tests only. */
export function clearManualProfiles(): void { byBranch.clear(); }

async function cdp(ctx: BrowserContext): Promise<CDPSession | null> {
  let p = cdpOf.get(ctx);
  if (!p) {
    p = (async () => {
      const page = ctx.pages()[0];
      if (!page) return null;
      try { return await ctx.newCDPSession(page); } catch { return null; }
    })();
    cdpOf.set(ctx, p);
  }
  return p;
}

interface TargetInfo { targetId: string; type: string; url: string; browserContextId?: string }

/** The CDP page targets of the branch's browser, with their browserContextId. */
async function targets(ctx: BrowserContext): Promise<TargetInfo[]> {
  const s = await cdp(ctx);
  if (!s) return [];
  try {
    const r = await s.send('Target.getTargets') as { targetInfos: TargetInfo[] };
    return r.targetInfos.filter((t) => t.type === 'page');
  } catch { cdpOf.delete(ctx); return []; }
}

/** The CDP target id of a Playwright page (Playwright exposes it through its own CDP session). */
async function targetIdOf(ctx: BrowserContext, page: Page): Promise<string | null> {
  try {
    const s = await ctx.newCDPSession(page);
    const r = await s.send('Target.getTargetInfo') as { targetInfo: TargetInfo };
    await s.detach().catch(() => {});
    return r.targetInfo?.targetId || null;
  } catch { return null; }
}

/**
 * The browserContextId of the branch's OWN profile (the one Playwright drives):
 * the context of the first page Playwright opened. Every other context in the
 * process is a forwarded manual profile.
 */
async function ownContextId(ctx: BrowserContext, all: TargetInfo[]): Promise<string | null> {
  for (const p of ctx.pages()) {
    const id = await targetIdOf(ctx, p);
    const t = id ? all.find((x) => x.targetId === id) : null;
    if (t?.browserContextId) return t.browserContextId;
  }
  return null;
}

/**
 * After a forward: learn the new profile's browserContextId (the context of
 * page targets that is neither the branch's own nor a known manual one).
 */
export async function learnManualContext(leaseKey: string, profileId: string, ctx: BrowserContext, waitMs = 8000): Promise<string | null> {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const all = await targets(ctx);
    const own = await ownContextId(ctx, all);
    const known = new Set([own, ...[...(byBranch.get(leaseKey)?.values() || [])].map((e) => e.cdpContextId)].filter(Boolean));
    const fresh = all.find((t) => t.browserContextId && !known.has(t.browserContextId));
    const e = byBranch.get(leaseKey)?.get(profileId);
    if (fresh && e) { e.cdpContextId = fresh.browserContextId!; return e.cdpContextId; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * Is `page` a tab of a manual profile? Automation on the branch must skip it.
 * True also for a page whose context cannot be determined while a manual
 * profile is open and the page is not the branch's own (safe side).
 */
export async function isManualPage(leaseKey: string, ctx: BrowserContext, page: Page): Promise<boolean> {
  const m = byBranch.get(leaseKey);
  if (!m || !m.size) return false;
  const all = await targets(ctx);
  const id = await targetIdOf(ctx, page);
  const t = id ? all.find((x) => x.targetId === id) : null;
  if (!t?.browserContextId) return true;
  return [...m.values()].some((e) => e.cdpContextId === t.browserContextId);
}

/** The pages of the branch context that belong to the branch's OWN profile (what automation may use). */
export async function ownPages(leaseKey: string, ctx: BrowserContext): Promise<Page[]> {
  const out: Page[] = [];
  for (const p of ctx.pages()) if (!(await isManualPage(leaseKey, ctx, p))) out.push(p);
  return out;
}

/**
 * Stop a manual profile: close ONLY its tabs (its windows go with them). The
 * branch's own browser and its profile stay. Returns how many tabs closed.
 */
export async function closeManualProfile(leaseKey: string, profileId: string, ctx: BrowserContext | null): Promise<number> {
  const e = byBranch.get(leaseKey)?.get(profileId);
  if (!e) return 0;
  let n = 0;
  if (ctx && e.cdpContextId) {
    const s = await cdp(ctx);
    for (const t of await targets(ctx)) {
      if (t.browserContextId !== e.cdpContextId) continue;
      try { await s?.send('Target.closeTarget', { targetId: t.targetId }); n++; } catch { /* already gone */ }
    }
  }
  forgetManual(leaseKey, profileId);
  return n;
}

/**
 * Drop manual profiles whose tabs are all gone (the user closed the window),
 * and every manual profile of a branch whose browser is gone. Cheap; called by
 * the status routes.
 */
export async function sweepManual(leaseKey: string, ctx: BrowserContext | null): Promise<void> {
  const m = byBranch.get(leaseKey);
  if (!m) return;
  if (!ctx) { byBranch.delete(leaseKey); return; }
  let alive = true;
  try { ctx.pages(); } catch { alive = false; }
  if (!alive) { byBranch.delete(leaseKey); return; }
  const live = new Set((await targets(ctx)).map((t) => t.browserContextId).filter(Boolean));
  for (const e of [...m.values()]) {
    // Not learned yet: give it the open window (learnManualContext runs right after the forward).
    if (!e.cdpContextId) { if (Date.now() - e.openedAt > 15_000) m.delete(e.profileId); continue; }
    if (!live.has(e.cdpContextId)) m.delete(e.profileId);
  }
  if (!m.size) byBranch.delete(leaseKey);
}
