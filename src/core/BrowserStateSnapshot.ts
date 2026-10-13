/**
 * BrowserStateSnapshot — what a profile's browser looked like right before
 * WE closed it, so it can be brought back.
 *
 * Requirement (phase 1, item 7): before an automatic close (workflow
 * "after the run: close", the idle collector, the GC, a Close Browser node, the
 * operator's Close) the state needed for recovery is saved.
 *
 * The persistent user-data-dir already keeps cookies / logins / IndexedDB
 * across launches. What it does NOT keep is the set of open tabs (Chromium
 * restores the previous session only when it was not shut down cleanly) and a
 * portable copy of the storage. So two files are written INSIDE the profile
 * directory (identity and its data never drift apart, same rule as the
 * registry's meta file):
 *
 *   .plyr-state/last-session.json   { version, savedAt, reason, tabs:[{url,title}] }
 *   .plyr-state/storage-state.json  Playwright storageState (cookies + localStorage)
 *
 * Both are written 0600. Nothing about their CONTENT is ever logged: the log
 * says only how many tabs were saved (URLs can carry tokens).
 *
 * Saving is best-effort with a hard time budget: a hung page must never block
 * the close it precedes. A crashed context simply has nothing to save.
 */
import { promises as fs } from 'fs';
import path from 'path';

export const STATE_DIR = '.plyr-state';
export const SESSION_FILE = 'last-session.json';
export const STORAGE_FILE = 'storage-state.json';
const MAX_TABS = 50;
const SAVE_BUDGET_MS = 4000;

export type CloseReason = 'after_run' | 'idle' | 'gc' | 'node' | 'operator' | 'relaunch' | 'shutdown';

export interface TabSnapshot { url: string; title: string }
export interface SessionSnapshot { version: 1; savedAt: string; reason: CloseReason; tabs: TabSnapshot[] }

interface PageLike { url(): string; title(): Promise<string>; isClosed?(): boolean }
interface ContextLike {
  pages(): PageLike[];
  storageState?(opts?: { path?: string }): Promise<unknown>;
}

/** Only real pages are worth restoring (no about:blank, chrome://, devtools, data:). Pure. */
export function restorableUrl(url: string): boolean {
  return /^https?:\/\//i.test(String(url || ''));
}

/** The tabs of a context, as they should be restored. Pure apart from reading titles. */
export async function tabsOf(ctx: ContextLike): Promise<TabSnapshot[]> {
  const out: TabSnapshot[] = [];
  let pages: PageLike[] = [];
  try { pages = ctx.pages(); } catch { return out; }
  for (const p of pages) {
    if (out.length >= MAX_TABS) break;
    try {
      if (p.isClosed && p.isClosed()) continue;
      const url = p.url();
      if (!restorableUrl(url)) continue;
      const title = await Promise.race([p.title().catch(() => ''), new Promise<string>((r) => setTimeout(() => r(''), 500))]);
      out.push({ url, title: String(title || '').slice(0, 200) });
    } catch { /* page gone meanwhile */ }
  }
  return out;
}

async function writePrivate(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Save the tabs + storage of `ctx` into `<userDataDir>/.plyr-state/`.
 * Never throws; returns what was saved (null = nothing could be saved).
 */
export async function saveBeforeClose(ctx: ContextLike | null | undefined, userDataDir: string | null | undefined, reason: CloseReason):
  Promise<{ tabs: number; storage: boolean } | null> {
  if (!ctx || !userDataDir) return null;
  const work = (async () => {
    const dir = path.join(userDataDir, STATE_DIR);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tabs = await tabsOf(ctx);
    // An empty tab list (crashed context, every tab already closed) never
    // overwrites a previous snapshot that had something worth restoring.
    if (tabs.length) {
      const snap: SessionSnapshot = { version: 1, savedAt: new Date().toISOString(), reason, tabs };
      await writePrivate(path.join(dir, SESSION_FILE), JSON.stringify(snap));
    }
    let storage = false;
    if (typeof ctx.storageState === 'function') {
      try {
        const st = await ctx.storageState();
        await writePrivate(path.join(dir, STORAGE_FILE), JSON.stringify(st));
        storage = true;
      } catch { /* context closing / crashed: tabs are still saved */ }
    }
    return { tabs: tabs.length, storage };
  })();
  try {
    return await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), SAVE_BUDGET_MS))]);
  } catch {
    return null;
  }
}

/** The last saved session of a profile directory, or null. Never throws. */
export async function readLastSession(userDataDir: string | null | undefined): Promise<SessionSnapshot | null> {
  if (!userDataDir) return null;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, STATE_DIR, SESSION_FILE), 'utf8'));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.tabs)) return null;
    const tabs = (raw.tabs as unknown[])
      .filter((t): t is TabSnapshot => !!t && typeof (t as TabSnapshot).url === 'string' && restorableUrl((t as TabSnapshot).url))
      .slice(0, MAX_TABS)
      .map((t) => ({ url: t.url, title: String(t.title || '') }));
    return { version: 1, savedAt: String(raw.savedAt || ''), reason: raw.reason, tabs };
  } catch {
    return null;
  }
}

/** Reopen saved tabs in a context (the operator asked for it). Returns how many were opened. */
export async function restoreTabs(ctx: { newPage(): Promise<{ goto(url: string, o?: unknown): Promise<unknown> }> ; pages(): PageLike[] },
  snap: SessionSnapshot | null): Promise<number> {
  if (!snap || !snap.tabs.length) return 0;
  const already = new Set<string>();
  try { for (const p of ctx.pages()) already.add(p.url()); } catch { /* fine */ }
  let n = 0;
  for (const t of snap.tabs) {
    if (already.has(t.url)) continue;
    try {
      const pg = await ctx.newPage();
      void pg.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      n++;
    } catch { /* keep going */ }
  }
  return n;
}
