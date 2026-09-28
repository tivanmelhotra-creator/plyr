/**
 * BrowserWindowManager — Task View backend for the Remote Browser desktop.
 *
 * The Xvfb desktop has no taskbar, so the viewer's Task View is the ONLY way an
 * operator can see and get back to browser windows once more than one is open
 * (several Chromium profiles side by side) or once one has been minimized.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * The first version kept ONE synthetic "default" session and pinned at most one
 * X11 window to it, so two live profiles showed up as a single card. It also
 * depended on wmctrl / xdotool / xprop, none of which the runtime image
 * installed, so inside Docker every X11 call failed silently.
 *
 * Now every managed, top-level Chromium window on the display is its own entry,
 * labelled with the profile it belongs to and reported as active or minimized
 * straight from the window manager. The Dockerfile installs the tools.
 *
 * Out of scope on purpose (for now): split screen, grids, multi-browser views.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config';
import { RealChrome } from './RealChrome';
import { Desktop } from './Desktop';

const execFileAsync = promisify(execFile);

export type WindowState = 'active' | 'minimized' | 'closed';

export interface BrowserWindowInfo {
  id: string;
  profileId: string;
  profileName: string;
  title: string;
  state: WindowState;
  windowId?: string;
  pid?: number;
  /** True for the window that currently has input focus. */
  focused?: boolean;
  /** 'x11' entries are rebuilt from the window manager on every list(). */
  source?: 'x11' | 'registered';
  updatedAt?: number;
}

export interface X11WindowRow {
  windowId: string;
  pid: number;
  wmClass: string;
  title: string;
}

export interface WindowProps {
  hidden: boolean;
  skipTaskbar: boolean;
  normal: boolean;
}

export interface ChromeProfileEntry {
  dir: string;
  name: string;
}

/** Shown when we know a browser runs but cannot see its windows. */
const PLACEHOLDER_ID = 'default';
const DEFAULT_PROFILE_LABEL = 'Default Profile';
const APP_NAMES = ['Chromium', 'Google Chrome', 'Google Chrome for Testing', 'Chrome'];

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ───────────────────────────────────────────────────────────────────────────

/** wmctrl pads ids (0x02400003), xprop does not (0x2400003): compare one form. */
export function normalizeWindowId(id: string): string {
  const raw = String(id || '').trim().toLowerCase();
  if (!raw) return '';
  const n = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return '0x' + n.toString(16);
}

/** Parse `wmctrl -l -p -x`: <id> <desktop> <pid> <class> <host> <title...> */
export function parseWmctrlList(stdout: string): X11WindowRow[] {
  const rows: X11WindowRow[] = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const windowId = normalizeWindowId(m[1]);
    if (!windowId) continue;
    rows.push({
      windowId,
      pid: parseInt(m[3], 10) || 0,
      wmClass: m[4],
      title: (m[6] || '').trim(),
    });
  }
  return rows;
}

export function isBrowserWindowClass(wmClass: string): boolean {
  return /chrom(e|ium)/i.test(String(wmClass || ''));
}

/** Parse `xprop -id W _NET_WM_STATE _NET_WM_WINDOW_TYPE`. */
export function parseWindowProps(stdout: string): WindowProps {
  const text = String(stdout || '');
  const typeLine = text.split('\n').find((l) => l.startsWith('_NET_WM_WINDOW_TYPE(')) || '';
  return {
    hidden: text.includes('_NET_WM_STATE_HIDDEN'),
    skipTaskbar: text.includes('_NET_WM_STATE_SKIP_TASKBAR'),
    // No type published means a plain top-level window.
    normal: !typeLine || typeLine.includes('_NET_WM_WINDOW_TYPE_NORMAL'),
  };
}

/**
 * Split a Chromium window title into the page title and, when Chromium shows
 * one (it does once more than one profile exists), the profile name.
 * Handles both "Page - Chromium - Work" and "Page - Work - Chromium".
 */
export function parseBrowserTitle(
  raw: string,
  profileNames: string[] = [],
): { page: string; profileName: string | null } {
  const original = String(raw || '').trim();
  let segs = original.split(' - ');
  let profileName: string | null = null;

  let appIdx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (APP_NAMES.includes(segs[i].trim())) { appIdx = i; break; }
  }
  if (appIdx >= 0) {
    const after = segs.slice(appIdx + 1).join(' - ').trim();
    if (after) profileName = after;
    segs = segs.slice(0, appIdx);
  }
  if (!profileName && segs.length > 1) {
    const last = segs[segs.length - 1].trim();
    if (profileNames.includes(last)) {
      profileName = last;
      segs = segs.slice(0, -1);
    }
  }
  const page = segs.join(' - ').trim() || original || 'Chromium';
  return { page, profileName };
}

/** Profiles Chromium knows about, from `<user-data-dir>/Local State`. */
export function parseLocalState(json: string): ChromeProfileEntry[] {
  try {
    const state = JSON.parse(json) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    const cache = state?.profile?.info_cache || {};
    return Object.keys(cache).map((dir) => ({ dir, name: String(cache[dir]?.name || dir) }));
  } catch {
    return [];
  }
}

/** Pull --user-data-dir / --profile-directory out of /proc/<pid>/cmdline. */
export function parseChromeCmdline(cmdline: string): { userDataDir?: string; profileDirectory?: string } {
  const out: { userDataDir?: string; profileDirectory?: string } = {};
  const unquote = (v: string) => v.replace(/^"|"$/g, '');
  for (const arg of String(cmdline || '').split('\0')) {
    if (arg.startsWith('--user-data-dir=')) out.userDataDir = unquote(arg.slice('--user-data-dir='.length));
    else if (arg.startsWith('--profile-directory=')) out.profileDirectory = unquote(arg.slice('--profile-directory='.length));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Manager
// ───────────────────────────────────────────────────────────────────────────

export class BrowserWindowManager {
  private static sessions = new Map<string, BrowserWindowInfo>();

  /** Register or update a browser session (used by callers that own one). */
  static register(info: Partial<BrowserWindowInfo> & { id: string }): BrowserWindowInfo {
    const existing = this.sessions.get(info.id);
    const updated: BrowserWindowInfo = {
      id: info.id,
      profileId: info.profileId || existing?.profileId || 'default',
      profileName: info.profileName || existing?.profileName || DEFAULT_PROFILE_LABEL,
      title: info.title || existing?.title || 'Chromium',
      state: info.state || existing?.state || 'active',
      windowId: info.windowId || existing?.windowId,
      pid: info.pid || existing?.pid,
      focused: info.focused ?? existing?.focused,
      source: info.source || existing?.source || 'registered',
      updatedAt: Date.now(),
    };
    this.sessions.set(info.id, updated);
    return updated;
  }

  static unregister(id: string): boolean {
    return this.sessions.delete(id);
  }

  static get(id: string): BrowserWindowInfo | null {
    return this.sessions.get(id) || null;
  }

  private static env(): NodeJS.ProcessEnv {
    return { ...process.env, DISPLAY: Desktop.display };
  }

  private static async run(cmd: string, args: string[], timeout = 2000): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(cmd, args, { env: this.env(), timeout });
      return String(stdout);
    } catch {
      return null;
    }
  }

  private static async activeWindowId(): Promise<string> {
    const out = await this.run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], 1000);
    const m = out ? out.match(/#\s*(0x[0-9a-fA-F]+)/) : null;
    return m ? normalizeWindowId(m[1]) : '';
  }

  private static async windowProps(windowId: string): Promise<WindowProps> {
    const out = await this.run('xprop', ['-id', windowId, '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE'], 1000);
    return out === null ? { hidden: false, skipTaskbar: false, normal: true } : parseWindowProps(out);
  }

  private static async readCmdline(pid: number): Promise<{ userDataDir?: string; profileDirectory?: string }> {
    if (!pid) return {};
    try {
      return parseChromeCmdline(await fs.readFile(`/proc/${pid}/cmdline`, 'utf8'));
    } catch {
      return {};
    }
  }

  private static async readProfiles(userDataDir: string): Promise<ChromeProfileEntry[]> {
    try {
      return parseLocalState(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8'));
    } catch {
      return [];
    }
  }

  /**
   * Every managed top-level browser window on the display, or null when the
   * window tools / X server are not available.
   */
  private static async scanX11(): Promise<BrowserWindowInfo[] | null> {
    const listing = await this.run('wmctrl', ['-l', '-p', '-x']);
    if (listing === null) return null;

    const rows = parseWmctrlList(listing).filter((r) => isBrowserWindowClass(r.wmClass));
    const active = await this.activeWindowId();
    const defaultDir = config.REAL_CHROME_USER_DATA_DIR ? path.resolve(config.REAL_CHROME_USER_DATA_DIR) : '';
    const profileCache = new Map<string, ChromeProfileEntry[]>();
    const out: BrowserWindowInfo[] = [];

    for (const row of rows) {
      const props = await this.windowProps(row.windowId);
      if (!props.normal || props.skipTaskbar) continue; // menus, bubbles, popups

      const cmd = await this.readCmdline(row.pid);
      const udd = cmd.userDataDir ? path.resolve(cmd.userDataDir) : defaultDir;
      let profiles = profileCache.get(udd);
      if (!profiles) {
        profiles = udd ? await this.readProfiles(udd) : [];
        profileCache.set(udd, profiles);
      }

      const parsed = parseBrowserTitle(row.title, profiles.map((p) => p.name));
      const separateInstance = !!(udd && defaultDir && udd !== defaultDir);
      const instancePrefix = separateInstance ? `${path.basename(udd)}/` : '';

      let dir = 'Default';
      let label = '';
      if (parsed.profileName) {
        const hit = profiles.find((p) => p.name === parsed.profileName);
        dir = hit?.dir || parsed.profileName;
        label = parsed.profileName;
      } else if (cmd.profileDirectory) {
        dir = cmd.profileDirectory;
        label = profiles.find((p) => p.dir === dir)?.name || dir;
      }
      if (dir === 'Default') label = DEFAULT_PROFILE_LABEL;
      if (separateInstance) label = `${path.basename(udd)} · ${label}`;

      out.push({
        id: row.windowId,
        windowId: row.windowId,
        pid: row.pid || undefined,
        profileId: instancePrefix + dir,
        profileName: label,
        title: parsed.page,
        state: props.hidden ? 'minimized' : 'active',
        focused: !props.hidden && active === row.windowId,
        source: 'x11',
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  /**
   * All open browser windows for Task View: one entry per window, across every
   * profile, each marked active or minimized.
   */
  static async list(): Promise<BrowserWindowInfo[]> {
    const x11 = await this.scanX11().catch(() => null);

    // Windows are re-read every time: one that is gone has been closed.
    for (const [id, s] of Array.from(this.sessions.entries())) {
      if (s.source === 'x11') this.sessions.delete(id);
    }

    if (x11 && x11.length > 0) {
      this.sessions.delete(PLACEHOLDER_ID);
      for (const w of x11) this.sessions.set(w.id, w);
    } else if (RealChrome.isRunning()) {
      // Browser is up but its windows are not visible to us (no window tools,
      // or headless). Show one honest card rather than nothing.
      let pageTitle = 'Chromium';
      try {
        const tabs = await RealChrome.tabs();
        if (tabs.length > 0 && tabs[0].title) pageTitle = tabs[0].title;
      } catch {
        // keep default title
      }
      this.register({ id: PLACEHOLDER_ID, profileId: 'default', profileName: DEFAULT_PROFILE_LABEL, title: pageTitle });
    } else {
      this.sessions.delete(PLACEHOLDER_ID);
    }

    const isDefault = (s: BrowserWindowInfo) => (s.profileId === 'Default' || s.profileId === 'default' ? 0 : 1);
    return Array.from(this.sessions.values())
      .filter((s) => s.state !== 'closed')
      .sort((a, b) => isDefault(a) - isDefault(b) || a.profileName.localeCompare(b.profileName) || a.id.localeCompare(b.id));
  }

  private static async resolve(id: string): Promise<BrowserWindowInfo | null> {
    const key = normalizeWindowId(id) && id.startsWith('0x') ? normalizeWindowId(id) : id;
    let session = this.sessions.get(key) || null;
    if (!session || session.source === 'x11') {
      await this.list();
      session = this.sessions.get(key) || null;
    }
    return session;
  }

  /** Minimize (iconify) a browser window. */
  static async minimize(id: string): Promise<BrowserWindowInfo | null> {
    const session = await this.resolve(id);
    if (!session) return null;

    if (session.windowId) {
      const ok = (await this.run('xdotool', ['windowminimize', session.windowId])) !== null;
      if (!ok) throw new Error('Could not minimize the window: xdotool is not available on this display.');
    }
    session.state = 'minimized';
    session.focused = false;
    session.updatedAt = Date.now();
    return session;
  }

  /** Restore (un-minimize), raise and focus a browser window. */
  static async restore(id: string): Promise<BrowserWindowInfo | null> {
    const session = await this.resolve(id);
    if (!session) return null;

    if (session.windowId) {
      // wmctrl -a de-iconifies, raises and focuses; xdotool is the fallback.
      const ok =
        (await this.run('wmctrl', ['-i', '-a', session.windowId])) !== null ||
        (await this.run('xdotool', ['windowactivate', session.windowId])) !== null;
      if (!ok) throw new Error('Could not restore the window: wmctrl/xdotool are not available on this display.');
    }
    for (const s of this.sessions.values()) s.focused = false;
    session.state = 'active';
    session.focused = true;
    session.updatedAt = Date.now();
    return session;
  }

  /** Reset in-memory state (primarily for unit tests). */
  static clear(): void {
    this.sessions.clear();
  }
}
