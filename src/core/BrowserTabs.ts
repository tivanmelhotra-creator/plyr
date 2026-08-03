/**
 * BrowserTabs.ts — the open-tab list of an interactive browser session, per user.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `BrowserProfile` already persists a user's *cookies* (storageState), so a
 * login done inside the picker survives. What it does NOT persist is WHERE the
 * user was: every open of the picker window started on one blank tab, and the
 * three pages they had lined up — the extension popup, the admin panel they
 * were logged into, the page they were picking selectors from — were gone.
 *
 * A browser that forgets its tabs on every open is not a browser, it is a
 * viewport. So the tab list is written out alongside the session state and
 * restored on the next open, exactly the way Chrome's own session restore
 * works: the ACTIVE tab is loaded immediately, the rest come back as tabs that
 * only fetch their page when you click them (see `LiveBrowserSession.activate`).
 *
 * Only URLs and titles are stored. Nothing here holds a live handle, so a
 * corrupt or stale file can never do worse than "you start with one blank tab".
 */
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';

export interface SavedTab {
  url: string;
  title?: string;
  /** Which one was in front. Exactly one entry should carry it. */
  active?: boolean;
}

/** How many tabs are worth restoring. Chrome restores all; we cap for sanity. */
export const MAX_SAVED_TABS = 12;

/**
 * Schemes we are willing to reopen.
 *
 * `file://` is deliberately absent for the same reason `LiveBrowserSession.
 * navigate` refuses it: this list is replayed automatically at session start,
 * so a poisoned file would turn into an unattended read of the server's disk.
 */
const ALLOWED = /^(https?:\/\/|chrome-extension:\/\/)/i;

/** Per-user tab-list file, next to the storage state it belongs with. */
export function tabsStatePath(userId: string): string {
  const safe = String(userId || 'anon').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'anon';
  return path.join(config.PROFILES_DIR, 'sessions', `${safe}.tabs.json`);
}

/** Drop anything we would refuse to reopen, and cap the list. */
export function sanitizeTabs(input: unknown): SavedTab[] {
  if (!Array.isArray(input)) return [];
  const out: SavedTab[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const url = String((raw as SavedTab).url || '').trim();
    if (!url || !ALLOWED.test(url)) continue;      // about:blank included: nothing to restore
    if (url.length > 2048) continue;
    if (seen.has(url)) continue;                   // two identical tabs restore as one
    seen.add(url);
    out.push({
      url,
      title: String((raw as SavedTab).title || '').slice(0, 200),
      ...((raw as SavedTab).active ? { active: true } : {}),
    });
    if (out.length >= MAX_SAVED_TABS) break;
  }
  // Exactly one active tab, or the restore has no idea what to show first.
  if (out.length && !out.some((t) => t.active)) out[0].active = true;
  let first = true;
  for (const t of out) {
    if (t.active && first) { first = false; continue; }
    if (t.active) delete t.active;
  }
  return out;
}

/** Read the saved tab list. Never throws: a bad file means "no tabs". */
export async function loadTabs(userId: string): Promise<SavedTab[]> {
  try {
    const raw = await fs.readFile(tabsStatePath(userId), 'utf8');
    const parsed = JSON.parse(raw);
    return sanitizeTabs(parsed && parsed.tabs ? parsed.tabs : parsed);
  } catch { return []; }
}

/**
 * Persist the tab list. Write-then-rename, like the storage state: a crash
 * mid-write must not leave a truncated file that silently loses every tab.
 */
export async function saveTabs(userId: string, tabs: SavedTab[]): Promise<boolean> {
  try {
    const list = sanitizeTabs(tabs);
    const file = tabsStatePath(userId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), tabs: list }), 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch { return false; }
}

/** Forget the tab list (part of "forget this browser session"). */
export async function clearTabs(userId: string): Promise<boolean> {
  try { await fs.unlink(tabsStatePath(userId)); return true; }
  catch { return false; }
}
