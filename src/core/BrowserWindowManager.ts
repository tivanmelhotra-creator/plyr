/**
 * BrowserWindowManager — Internal Window Manager for Remote Browser sessions.
 *
 * Tracks active and minimized browser sessions/profiles inside Docker/Xvfb without
 * requiring an OS taskbar (like tint2 or lxpanel). Provides listing, minimize, and
 * restore capabilities for the remote desktop environment.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
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
  updatedAt?: number;
}

export class BrowserWindowManager {
  private static sessions = new Map<string, BrowserWindowInfo>();

  /**
   * Register or update a browser session.
   */
  static register(info: Partial<BrowserWindowInfo> & { id: string }): BrowserWindowInfo {
    const existing = this.sessions.get(info.id);
    const updated: BrowserWindowInfo = {
      id: info.id,
      profileId: info.profileId || existing?.profileId || 'default',
      profileName: info.profileName || existing?.profileName || 'Default Profile',
      title: info.title || existing?.title || 'Chromium',
      state: info.state || existing?.state || 'active',
      windowId: info.windowId || existing?.windowId,
      pid: info.pid || existing?.pid,
      updatedAt: Date.now(),
    };
    this.sessions.set(info.id, updated);
    return updated;
  }

  /**
   * Remove a session when closed.
   */
  static unregister(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * Get a single window session by id.
   */
  static get(id: string): BrowserWindowInfo | null {
    return this.sessions.get(id) || null;
  }

  /**
   * Query X11 for window IDs belonging to Chromium/Chrome on the current DISPLAY.
   */
  private static async findX11Windows(display?: string): Promise<Array<{ id: string; pid: number; title: string; minimized: boolean }>> {
    const disp = display || Desktop.display;
    const env = { ...process.env, DISPLAY: disp };
    const results: Array<{ id: string; pid: number; title: string; minimized: boolean }> = [];

    try {
      // wmctrl -l -p -x gives: <win_id> <desktop> <pid> <class> <client> <title>
      const { stdout } = await execFileAsync('wmctrl', ['-l', '-p', '-x'], { env, timeout: 2000 });
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const winId = parts[0];
        const pid = parseInt(parts[2], 10);
        const winClass = (parts[3] || '').toLowerCase();
        const title = parts.slice(5).join(' ');

        if (winClass.includes('chromium') || winClass.includes('chrome') || winClass.includes('google-chrome')) {
          let minimized = false;
          try {
            const { stdout: xpropOut } = await execFileAsync('xprop', ['-id', winId, '_NET_WM_STATE'], { env, timeout: 1000 });
            if (xpropOut.includes('_NET_WM_STATE_HIDDEN')) {
              minimized = true;
            }
          } catch {
            // xprop failed, assume visible
          }
          results.push({ id: winId, pid, title, minimized });
        }
      }
    } catch {
      // wmctrl not installed or X server unavailable
    }

    return results;
  }

  /**
   * List all known browser windows, auto-syncing with RealChrome and X11 if available.
   */
  static async list(): Promise<BrowserWindowInfo[]> {
    // 1. Sync from RealChrome if active
    if (RealChrome.isRunning()) {
      let pageTitle = 'Chromium';
      try {
        const tabs = await RealChrome.tabs();
        if (tabs.length > 0 && tabs[0].title) {
          pageTitle = tabs[0].title;
        }
      } catch {
        // use default title
      }

      const defaultSession = this.sessions.get('default') || this.sessions.get('session_default');
      if (!defaultSession) {
        this.register({
          id: 'default',
          profileId: 'default',
          profileName: 'Default Profile',
          title: pageTitle,
          state: 'active',
        });
      } else {
        defaultSession.title = pageTitle;
      }
    }

    // 2. Sync states with X11 windows if on live desktop
    const x11Windows = await this.findX11Windows().catch(() => []);
    if (x11Windows.length > 0) {
      for (const win of x11Windows) {
        let matched = false;
        for (const session of this.sessions.values()) {
          if (session.windowId === win.id || (session.pid && session.pid === win.pid)) {
            session.windowId = win.id;
            session.state = win.minimized ? 'minimized' : 'active';
            if (win.title && !session.title) session.title = win.title;
            matched = true;
            break;
          }
        }
        if (!matched && this.sessions.size > 0) {
          const first = Array.from(this.sessions.values())[0];
          if (!first.windowId) {
            first.windowId = win.id;
            first.state = win.minimized ? 'minimized' : 'active';
            matched = true;
          }
        }
      }
    }

    return Array.from(this.sessions.values()).filter((s) => s.state !== 'closed');
  }

  /**
   * Minimize a browser window by ID.
   */
  static async minimize(id: string): Promise<BrowserWindowInfo | null> {
    const session = this.sessions.get(id);
    if (!session) return null;

    const env = { ...process.env, DISPLAY: Desktop.display };
    if (session.windowId) {
      try {
        await execFileAsync('xdotool', ['windowminimize', session.windowId], { env, timeout: 2000 });
      } catch {
        try {
          await execFileAsync('wmctrl', ['-i', '-r', session.windowId, '-b', 'add,hidden'], { env, timeout: 2000 });
        } catch {
          // Fallback if xdotool/wmctrl not present
        }
      }
    }

    session.state = 'minimized';
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * Restore and focus a browser window by ID.
   */
  static async restore(id: string): Promise<BrowserWindowInfo | null> {
    const session = this.sessions.get(id);
    if (!session) return null;

    const env = { ...process.env, DISPLAY: Desktop.display };
    if (session.windowId) {
      try {
        // wmctrl -i -a <winId> un-minimizes (un-iconifies) and raises + focuses in Openbox
        await execFileAsync('wmctrl', ['-i', '-a', session.windowId], { env, timeout: 2000 });
      } catch {
        try {
          await execFileAsync('xdotool', ['windowactivate', session.windowId], { env, timeout: 2000 });
        } catch {
          // Fallback
        }
      }
    }

    session.state = 'active';
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * Reset in-memory session state (primarily for unit tests).
   */
  static clear(): void {
    this.sessions.clear();
  }
}
