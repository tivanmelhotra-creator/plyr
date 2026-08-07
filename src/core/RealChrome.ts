/**
 * RealChrome — one long-lived, REAL Chrome with a persistent profile and real
 * extensions, shared by the interactive picker and (optionally) automation.
 *
 * WHY THIS EXISTS
 * ---------------
 * The canvas "browser" in the picker modal is a CDP screencast of a page. It is
 * a genuine Chromium rendering a genuine page, but it is deliberately a *page*
 * view, and that is a hard ceiling:
 *
 *   - no extensions are loaded at all (Playwright launches with
 *     --disable-extensions, and a headless shell has no extension host),
 *   - a toolbar popup is not part of the page, so it could never be streamed,
 *   - the profile is thrown away, so anything an extension stored is gone.
 *
 * People do not want "a browser-shaped thing". They want THEIR Chrome, with the
 * cookie extension they already use, so they can import an exported cookie file
 * and skip the login — including the logins that are impossible to automate
 * (2FA, device approval, CAPTCHA).
 *
 * This class provides that:
 *
 *   1. `launchPersistentContext` on a real user-data-dir → cookies, localStorage,
 *      IndexedDB and extension storage all survive restarts.
 *   2. `--load-extension` for every extension in the extensions dir, with
 *      `--disable-extensions-except` so Playwright's own --disable-extensions
 *      cannot silently win.
 *   3. `--remote-debugging-port` so the browser is literally reachable on a
 *      port: attach any CDP client, or `chrome://inspect` from your own Chrome.
 *   4. `extensionPageUrl()` so an extension's popup can be opened *as a tab*
 *      inside the existing canvas picker — the popup UI with full extension
 *      privileges, no remote desktop needed.
 *
 * The X-server requirement is not incidental. Extensions only work in a HEADED
 * Chrome, so on a server this needs Xvfb (scripts/desktop.sh) — which is also
 * what makes the noVNC view possible.
 */

import { chromium } from 'playwright-extra';
import type { BrowserContext, Page } from 'playwright';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';

import { config } from '../config';
import { ANTI_AUTOMATION_ARGS, realisticUserAgent } from './BrowserProfile';
import {
  listExtensions,
  extensionLaunchArgs,
  type InstalledExtension,
} from './ChromeExtensions';
import { Desktop, displayGuidance } from './Desktop';
import {
  parseCookieFile,
  type CookieImportResult,
  type ImportedCookie,
} from './CookieImport';

export interface RealChromeTab {
  url: string;
  title: string;
  active: boolean;
}

export interface RealChromeStatus {
  enabled: boolean;
  running: boolean;
  /** Extensions Chrome was launched with (a restart is needed to change them). */
  extensions: Array<InstalledExtension & { url: string; popupUrl: string; optionsUrl: string }>;
  /** Extensions on disk right now; differs from `extensions` after an upload. */
  installedCount: number;
  restartRequired: boolean;
  userDataDir: string;
  extensionsDir: string;
  headless: boolean;
  display: string;
  debugPort: number;
  debugBind: string;
  /** http://host:port — only set when a debug port was configured. */
  debugUrl: string;
  /** Chrome's own reported version, proof the port is really answering. */
  browserVersion: string;
  webSocketDebuggerUrl: string;
  lastError: string;
}

export class RealChromeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealChromeError';
  }
}

/**
 * Chrome's extension id for an UNPACKED extension is deterministic: it is the
 * SHA-256 of the absolute directory path, first 16 bytes, with each hex nibble
 * mapped 0→a … f→p. Knowing it without asking Chrome is what lets us build a
 * `chrome-extension://…/popup.html` URL before the extension has ever run.
 */
export function unpackedExtensionId(absDir: string): string {
  const hash = createHash('sha256').update(absDir, 'utf8').digest('hex').slice(0, 32);
  let id = '';
  for (const ch of hash) {
    id += String.fromCharCode('a'.charCodeAt(0) + parseInt(ch, 16));
  }
  return id;
}

/** Ask a DevTools port who it is. Used purely to prove the port is live. */
function fetchDebugVersion(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<{ Browser?: string; webSocketDebuggerUrl?: string } | null> {
  return new Promise((resolve) => {
    // 0.0.0.0 is a bind address, not a connect address.
    const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const req = http.get(
      { host: target, port, path: '/json/version', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export class RealChrome {
  private static context: BrowserContext | null = null;
  private static starting: Promise<BrowserContext> | null = null;
  private static loaded: InstalledExtension[] = [];
  private static lastError = '';
  private static debugInfo: { version: string; ws: string } = { version: '', ws: '' };

  static isEnabled(): boolean {
    return config.REAL_CHROME_ENABLED === true;
  }

  static isRunning(): boolean {
    return this.context !== null;
  }

  /** True when `ctx` is the shared persistent context, which must never be closed. */
  static isSharedContext(ctx: BrowserContext | null | undefined): boolean {
    return !!ctx && ctx === this.context;
  }

  static viewport(): { width: number; height: number } {
    return {
      width: Math.max(320, config.REAL_CHROME_WINDOW_WIDTH || 1280),
      // Subtract Chrome's tab strip + omnibox so the PAGE gets the size the
      // caller asked for. Otherwise every screencast is ~120px shorter than the
      // coordinate space the picker maps clicks into, and clicks land high.
      height: Math.max(240, (config.REAL_CHROME_WINDOW_HEIGHT || 800) - 120),
    };
  }

  /**
   * Start (or return) the shared Chrome.
   *
   * Concurrent callers share one in-flight launch: the picker opening twice in
   * quick succession must not race two Chromes onto the same user-data-dir,
   * which Chrome resolves by refusing to start the second one.
   */
  static async getContext(): Promise<BrowserContext> {
    if (!this.isEnabled()) {
      throw new RealChromeError(
        'Real Chrome is disabled. Set REAL_CHROME_ENABLED=true to use extensions.',
      );
    }
    if (this.context) return this.context;
    if (this.starting) return this.starting;

    this.starting = this.launch()
      .then((ctx) => { this.context = ctx; this.lastError = ''; return ctx; })
      .catch((e: Error) => { this.lastError = e.message; throw e; })
      .finally(() => { this.starting = null; });

    return this.starting;
  }

  private static async launch(): Promise<BrowserContext> {
    const userDataDir = config.REAL_CHROME_USER_DATA_DIR;
    const extensionsDir = config.REAL_CHROME_EXTENSIONS_DIR;
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    const extensions = await listExtensions(extensionsDir);
    const headless = config.REAL_CHROME_HEADLESS === true;
    const vp = this.viewport();

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      `--window-size=${config.REAL_CHROME_WINDOW_WIDTH},${config.REAL_CHROME_WINDOW_HEIGHT}`,
      ...ANTI_AUTOMATION_ARGS,
      ...extensionLaunchArgs(extensions),
    ];

    if (config.REAL_CHROME_DEBUG_PORT > 0) {
      args.push(`--remote-debugging-port=${config.REAL_CHROME_DEBUG_PORT}`);
      args.push(`--remote-debugging-address=${config.REAL_CHROME_DEBUG_BIND}`);
      // Without this, a DevTools client connecting from any other origin is
      // rejected by Chrome's origin check and the port looks broken.
      args.push('--remote-allow-origins=*');
    }

    // Xvfb display. An explicit DISPLAY in the environment wins, because the
    // operator who exported it knows better than a default.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!headless && !env.DISPLAY && config.REAL_CHROME_DISPLAY) {
      env.DISPLAY = config.REAL_CHROME_DISPLAY;
    }

    const ua = realisticUserAgent(null);

    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        timeout: Math.max(config.BROWSER_LAUNCH_TIMEOUT_MS, 60_000),
        ...(config.CHROME_EXE ? { executablePath: config.CHROME_EXE } : {}),
        // Playwright's defaults contain --disable-extensions. Keeping it would
        // make --load-extension a no-op with no error anywhere: the single most
        // confusing failure mode in this whole feature.
        ignoreDefaultArgs: ['--disable-extensions'],
        args,
        env,
        viewport: vp,
        ...(ua ? { userAgent: ua } : {}),
        locale: 'en-US',
        timezoneId: 'UTC',
        acceptDownloads: true,
        ignoreHTTPSErrors: true,
        downloadsPath: config.DOWNLOADS_DIR,
      });

      this.loaded = extensions;

      context.on('close', () => {
        this.context = null;
        this.loaded = [];
        this.debugInfo = { version: '', ws: '' };
      });

      if (config.REAL_CHROME_DEBUG_PORT > 0) {
        const info = await fetchDebugVersion(
          config.REAL_CHROME_DEBUG_BIND,
          config.REAL_CHROME_DEBUG_PORT,
        );
        this.debugInfo = {
          version: info?.Browser || '',
          ws: info?.webSocketDebuggerUrl || '',
        };
      }

      console.log(
        `[RealChrome] ✓ persistent Chrome up — ${extensions.length} extension(s), ` +
        `profile=${userDataDir}` +
        (config.REAL_CHROME_DEBUG_PORT > 0
          ? `, devtools=${config.REAL_CHROME_DEBUG_BIND}:${config.REAL_CHROME_DEBUG_PORT}`
          : ''),
      );

      return context;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // The single most common failure on a server, and the raw message
      // ("Target page, context or browser has been closed" / "Missing X server")
      // tells the user nothing about what to do.
      if (/X server|DISPLAY|cannot open display/i.test(msg)) {
        // Name the package, not just the script. "Run scripts/desktop.sh start"
        // is a circle for the (very common) case where the script itself then
        // says `Xvfb: command not found`.
        throw new RealChromeError(
          `${displayGuidance(await Desktop.missingBinaries(), env.DISPLAY || 'unset')}`,
        );
      }
      if (/ProcessSingleton|already running|SingletonLock/i.test(msg)) {
        throw new RealChromeError(
          `Another Chrome is already using the profile at ${userDataDir}. ` +
          'Close it, or point REAL_CHROME_USER_DATA_DIR at a different directory.',
        );
      }
      throw new RealChromeError(`Could not start real Chrome: ${msg}`);
    }
  }

  /**
   * A page to drive. Reuses the profile's existing about:blank tab the first
   * time so the window does not accumulate a dead first tab.
   */
  static async newPage(): Promise<Page> {
    const ctx = await this.getContext();
    const existing = ctx.pages();
    const blank = existing.find((p) => {
      const u = p.url();
      return u === 'about:blank' || u === '';
    });
    if (blank) return blank;
    return ctx.newPage();
  }

  /** Extensions Chrome is currently running with, plus their chrome-extension URLs. */
  static loadedExtensions(): Array<InstalledExtension & {
    url: string; popupUrl: string; optionsUrl: string; runtimeId: string;
  }> {
    return this.loaded.map((e) => {
      // A manifest `key` overrides the path-derived id, and store installs pin
      // one deliberately. Guessing the path id for those would build
      // chrome-extension:// URLs that resolve to nothing at all.
      const id = e.extensionId || unpackedExtensionId(e.dir);
      const base = `chrome-extension://${id}/`;
      return {
        ...e,
        runtimeId: id,
        url: base,
        popupUrl: e.popup ? base + e.popup : '',
        optionsUrl: e.optionsPage ? base + e.optionsPage : '',
      };
    });
  }

  /**
   * Best URL to open for an extension inside the canvas picker.
   *
   * Preference order is popup → options → root, because the popup is what the
   * toolbar button shows and therefore what the user recognises. Opening it as
   * a tab works: an extension page has the same privileges wherever it renders.
   */
  static extensionPageUrl(id: string): string {
    const found = this.loadedExtensions().find(
      (e) => e.id === id || e.name === id || e.runtimeId === id || e.storeId === id,
    );
    if (!found) return '';
    return found.popupUrl || found.optionsUrl || found.url;
  }

  /**
   * List the open tabs in the shared Chrome.
   *
   * The point is diagnosis from the Live Browser View: when the picker canvas
   * is wedged or showing a stale frame, the operator wants to see whether the
   * real browser still has the pages they were working with. Page objects also
   * expose close() — the route below mirrors that as POST /browser/tabs/close
   * so a hung tab can be killed without restarting Chrome.
   */
  static async tabs(): Promise<RealChromeTab[]> {
    const ctx = this.context;
    if (!ctx) return [];
    const pages = ctx.pages();
    const out: RealChromeTab[] = [];
    for (const p of pages) {
      try {
        out.push({
          url: p.url(),
          title: await p.title().catch(() => ''),
          active: false,
        });
      } catch {
        // A page that throws on url() has gone away mid-iteration. Skip it
        // rather than failing the whole list — the diagnosis still helps.
      }
    }
    return out;
  }

  /**
   * Close a tab by URL prefix. Returns true if a tab was closed.
   *
   * URL prefix (not full URL) because Playwright Page objects do not expose a
   * stable id across calls — only the URL is reliable, and operators will
   * naturally pick the unique tail of the URL they want gone.
   */
  static async closeTab(urlPrefix: string): Promise<boolean> {
    const ctx = this.context;
    if (!ctx) return false;
    for (const p of ctx.pages()) {
      if (p.url().startsWith(urlPrefix)) {
        await p.close().catch(() => {});
        return true;
      }
    }
    return false;
  }

  static async status(): Promise<RealChromeStatus> {
    const installed = await listExtensions(config.REAL_CHROME_EXTENSIONS_DIR).catch(() => []);
    const loaded = this.loadedExtensions();
    const debugPort = config.REAL_CHROME_DEBUG_PORT;

    return {
      enabled: this.isEnabled(),
      running: this.isRunning(),
      extensions: loaded,
      installedCount: installed.length,
      // Chrome reads --load-extension once, at launch. An extension uploaded
      // afterwards is on disk but not in the browser, and pretending otherwise
      // produces a "my extension isn't there" bug report.
      restartRequired: this.isRunning() && installed.length !== loaded.length,
      userDataDir: config.REAL_CHROME_USER_DATA_DIR,
      extensionsDir: config.REAL_CHROME_EXTENSIONS_DIR,
      headless: config.REAL_CHROME_HEADLESS === true,
      display: process.env.DISPLAY || config.REAL_CHROME_DISPLAY,
      debugPort,
      debugBind: config.REAL_CHROME_DEBUG_BIND,
      debugUrl: debugPort > 0 ? `http://${config.REAL_CHROME_DEBUG_BIND}:${debugPort}` : '',
      browserVersion: this.debugInfo.version,
      webSocketDebuggerUrl: this.debugInfo.ws,
      lastError: this.lastError,
    };
  }

  /**
   * Inject cookies from an extension export straight into the live profile.
   *
   * This is the "I just want to be logged in" path: it does in one HTTP call
   * what the user otherwise does by opening the extension popup and clicking
   * Import, and unlike that route it also works when Chrome is headless.
   */
  static async importCookies(fileText: string): Promise<{
    result: CookieImportResult;
    applied: number;
    rejected: Array<{ cookie: string; reason: string }>;
  }> {
    const result = parseCookieFile(fileText);
    const ctx = await this.getContext();
    return { ...(await applyCookies(ctx, result.cookies)), result };
  }

  /** Stop Chrome. Cookies live in the profile directory, so nothing is lost. */
  static async stop(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.loaded = [];
    this.debugInfo = { version: '', ws: '' };
    if (ctx) {
      try { await ctx.close(); } catch { /* already gone */ }
    }
  }

  /** Stop and start again — the only way to pick up newly installed extensions. */
  static async restart(): Promise<RealChromeStatus> {
    await this.stop();
    await this.getContext();
    return this.status();
  }
}

/**
 * Add cookies one batch, then retry the failures individually.
 *
 * `addCookies` is all-or-nothing: one cookie with a domain Chrome dislikes
 * rejects the entire array. An export of 400 cookies containing 3 bad rows would
 * therefore import ZERO — and report success-shaped failure. The fallback keeps
 * the 397 that are fine and tells the caller exactly which 3 were dropped.
 */
async function applyCookies(
  ctx: BrowserContext,
  cookies: ImportedCookie[],
): Promise<{ applied: number; rejected: Array<{ cookie: string; reason: string }> }> {
  if (cookies.length === 0) return { applied: 0, rejected: [] };

  try {
    await ctx.addCookies(cookies);
    return { applied: cookies.length, rejected: [] };
  } catch {
    // fall through to one-by-one
  }

  let applied = 0;
  const rejected: Array<{ cookie: string; reason: string }> = [];
  for (const c of cookies) {
    try {
      await ctx.addCookies([c]);
      applied++;
    } catch (e) {
      rejected.push({
        cookie: `${c.name}@${c.domain}${c.path}`,
        reason: (e as Error).message.split('\n')[0].slice(0, 200),
      });
    }
  }
  return { applied, rejected };
}

export { applyCookies };

/** Absolute path helper used by the routes when reporting the extensions dir. */
export function extensionsDirDisplay(): string {
  return path.resolve(config.REAL_CHROME_EXTENSIONS_DIR);
}
