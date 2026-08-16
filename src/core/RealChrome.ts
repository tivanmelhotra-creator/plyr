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
import {
  IGNORED_DEFAULT_ARGS,
  realisticUserAgent,
  withUtf8Locale,
} from './BrowserProfile';
import {
  listExtensions,
  extensionLaunchArgs,
  type InstalledExtension,
} from './ChromeExtensions';
import { resolveFlags, type ResolveFlagsInput, type ResolvedFlags } from './ChromeFlags';
import { seedInspectorExtension } from './InspectorExtension';
import { Desktop, displayGuidance } from './Desktop';
import {
  RealChromeShelf,
  REAL_CHROME_SHELF_USER,
  type ShelfEntry,
} from './RealChromeShelf';
import { RemoteFileChooser, type PendingChooser } from './RemoteFileChooser';
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

/**
 * Tell an extension page WHICH site it is being opened for.
 *
 * WHY THIS EXISTS — measured, not guessed (tools/probe-j2team-tmp.js).
 *
 * A toolbar popup normally runs next to an active tab, and the way an extension
 * learns which site it should act on is `chrome.tabs.query({active: true})`. We
 * open the popup AS A TAB (see extensionPageUrl), so that query returns the
 * popup itself — a `chrome-extension://` page, which has no cookies and no
 * site. The extension then has nothing to work with.
 *
 * What that looks like to a user is the bug that was reported: with J2TEAM
 * Cookies, Import worked (it reads a file, so it needs no site) while Export did
 * nothing at all — no error, button still enabled, because the handler simply
 * `return`s when it cannot resolve a URL.
 *
 * Extensions that support being opened as a tab solve this with a query
 * parameter, and J2TEAM's own "open in tab" helper builds exactly this:
 *
 *   popup.html?url=<base64 of the page URL>
 *
 * Measured with the real extension, cookie `sess=abc123` on a local site:
 *
 *   popup.html                → header "Cookies for this page", downloads: []
 *   popup.html?url=<base64>   → header "Cookies for 127.0.0.1",
 *                               downloads: ["127.0.0.1_09-08-2026.json"]
 *
 * TWO RULES, both measured (tools/probe-b64-tmp.js):
 *
 *  1. Encode `new URL(u).href`, never the raw string. The decoder on the other
 *     side is the browser's `atob`, and its encoder `btoa` THROWS
 *     InvalidCharacterError on any code unit > 0xff — so a Persian or IDN URL
 *     like `https://مهدی.com/` would break the very feature it is meant to
 *     enable. `href` normalises to pure ASCII (IDN → punycode, path →
 *     percent-encoded) for every case tested, and the extension's own
 *     `new URL(atob(x)).origin` still round-trips to the right origin.
 *  2. Only http(s). `about:blank` and `chrome-extension://` normalise fine but
 *     produce origin `null`, which is not a site any cookie belongs to; passing
 *     one would replace a harmless "no site" with a confusing wrong answer.
 *
 * Returns '' when there is nothing useful to attach, so callers can treat this
 * as "append if non-empty" and behaviour is unchanged for every other extension.
 */
export function extensionPageUrlFor(pageUrl: string, popupUrl: string): string {
  if (!popupUrl) return '';
  let href: string;
  try {
    const u = new URL(String(pageUrl || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return popupUrl;
    href = u.href;
  } catch {
    return popupUrl; // not a URL at all (empty field, half-typed host)
  }
  // Never clobber a parameter the extension page already carries.
  if (popupUrl.includes('?url=') || popupUrl.includes('&url=')) return popupUrl;
  const b64 = Buffer.from(href, 'utf8').toString('base64');
  const sep = popupUrl.includes('?') ? '&' : '?';
  return `${popupUrl}${sep}url=${encodeURIComponent(b64)}`;
}

/**
 * The window geometry flags Chrome is launched with.
 *
 * FILL THE SCREEN. The operator reported:
 *   «از ۱۰۰ در ۱۰۰ صفحه فقط شاید ۶۰ درصدش رو مرورگر گرفته بود بقیه جاها الکی
 *    مشکی بودن باید مثل مرورگر واقعی کل صفحه رو بگیره»
 *
 * MEASURED cause -- the window was simply smaller than the screen:
 *   BEFORE: screen 1600x900, window 1288x811+10+10  ->  COVERAGE 72.5%
 *   AFTER : screen 1600x900, window 1599x899+0+0    ->  COVERAGE 99.8%
 * The 27.5% difference is bare X root window, and the root window is black.
 *
 * The size came from REAL_CHROME_WINDOW_* (default 1280x800) while the screen
 * only follows those settings when Desktop itself started Xvfb. Any externally
 * started Xvfb -- which is the normal case -- leaves the two disagreeing.
 *
 * `screen` is whatever X actually reported, or null when there is nothing to
 * ask (headless, or xdpyinfo missing), in which case the configured size is the
 * only information available and is used as the fallback.
 */
export function windowArgs(screen: { width: number; height: number } | null): string[] {
  const w = screen?.width || config.REAL_CHROME_WINDOW_WIDTH;
  const h = screen?.height || config.REAL_CHROME_WINDOW_HEIGHT;
  return [
    `--window-size=${w},${h}`,
    // Top-left, or a window sized to the whole screen still hangs off the
    // bottom-right corner by however far it was offset (it was at +10+10).
    '--window-position=0,0',
  ];
}

/**
 * Make Chrome reopen the tabs it had when it last went away.
 *
 * THE REPORT (HANDOFF-REMOTE-BROWSER.md §3.2)
 * -------------------------------------------
 *   «مرورگر ریموت رو بالا اوردم ولی وقتی وبگردی میکردم هنگ کرد و بعدش دیگه فریز
 *    شد منم بستم مجدد باز کنم کلا نرفت به اون ادرس … موقعی که مجدد میزنم یکی
 *    جدید بالا میاره که همه تب ها گم شدن»
 *
 * WHAT WAS ACTUALLY MEASURED (tools/probe-realchrome-tab-loss.js, headed on
 * Xvfb, three data: tabs titled ONE/TWO/THREE, one scenario per process):
 *
 *   scenario                                   tabs back
 *   ─────────────────────────────────────────  ─────────
 *   clean close, then reopen                     0 of 3
 *   SIGKILL, exit-state wiped, then reopen       0 of 3
 *   SIGKILL, exit-state KEPT, then reopen        0 of 3   ← control
 *   SIGKILL + --restore-last-session             0 of 3
 *   restore_on_startup=5 only, no flag           0 of 3   ← lever A alone
 *   --restore-last-session only, no pref         0 of 3   ← lever B alone
 *   BOTH the pref and the flag                   3 of 3   ← the fix
 *
 * THREE CONCLUSIONS, none of them the one the handoff expected:
 *
 *  1. `clearCrashedExitState()` is INNOCENT. It was the prime suspect — wiping
 *     the crash flag is exactly what would discard the previous session — but
 *     the control run that skips it loses the tabs just the same. Do not
 *     "fix" it; it solves a real and separate problem (the restore bubble
 *     eating clicks) and reverting it would bring that back.
 *  2. The loss is NOT crash-specific. A clean close loses them too, so this was
 *     never about crash handling: Chrome was simply never asked to restore
 *     anything. That also means it reproduces on every ordinary restart, which
 *     is why the operator hit it so easily.
 *  3. NEITHER lever works alone, and that is the non-obvious part. The pref
 *     tells Chrome what "startup" means; the flag tells it that this launch IS
 *     a startup to restore rather than a fresh window. Ship both or ship
 *     nothing — half of this fix measures identically to no fix at all.
 *
 * WHY WE WRITE A PREFERENCE FILE AT ALL
 * -------------------------------------
 * Because there is no command line for it. `restore_on_startup` lives only in
 * the profile, and MEASURED on a fresh profile Chrome writes no Preferences file
 * until it has run once — so seeding it before the first launch is the only way
 * a first-run profile gets the setting. Verified in the probe: the key survived
 * Chrome's own rewrite of that file during the session, and survived the crash.
 *
 * Like clearCrashedExitState, this touches ONLY its own key and leaves the rest
 * of the user's profile byte for byte alone, writes via a same-directory temp +
 * rename so an interrupted write cannot truncate the profile, and never blocks
 * a launch on failure — a browser with the wrong startup mode is a great deal
 * better than no browser.
 *
 * Returns a short description of what it did, for the log and for tests.
 */
export async function enableSessionRestore(userDataDir: string): Promise<string> {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  // 5 = "continue where you left off". 1 is the new-tab page and 4 is a fixed
  // URL list; both would silently discard the session we are trying to keep.
  const CONTINUE_WHERE_YOU_LEFT_OFF = 5;
  try {
    await fs.mkdir(path.dirname(prefsPath), { recursive: true });

    let prefs: { session?: Record<string, unknown> } = {};
    try {
      prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
    } catch {
      // No Preferences yet. MEASURED: that is the state of a fresh profile, and
      // seeding the file here is the only way the FIRST session gets restored.
      prefs = {};
    }

    const session = (prefs.session || {}) as Record<string, unknown>;
    if (session.restore_on_startup === CONTINUE_WHERE_YOU_LEFT_OFF) {
      return 'already set';
    }
    const was = session.restore_on_startup;
    session.restore_on_startup = CONTINUE_WHERE_YOU_LEFT_OFF;
    prefs.session = session;

    const tmp = `${prefsPath}.abtmp`;
    await fs.writeFile(tmp, JSON.stringify(prefs), 'utf8');
    await fs.rename(tmp, prefsPath);
    return `restore_on_startup ${was === undefined ? 'unset' : String(was)} -> 5`;
  } catch (e) {
    return `could not set (${(e as Error).message})`;
  }
}

/**
 * Clear the profile pref that ALSO answers "Installation is not enabled".
 *
 * Dropping `--disable-extensions-except` from the command line (see
 * `extensionLaunchArgs`) fixes the flag half of the bug. There is a second,
 * independent half, from the same Chromium function:
 *
 *   extension_util.cc:362-367
 *     bool AreExtensionsDisabled(command_line, context) {
 *       return ExtensionsDisabledViaCommandLine(command_line) ||
 *              profile->GetPrefs()->GetBoolean(prefs::kDisableExtensions);
 *     }
 *
 * `prefs::kDisableExtensions` is the string `"extensions.disabled"`
 * (chrome/common/pref_names.h:1618) and it lives in the PROFILE, not the command
 * line. Either source being true forces `extensions_enabled = false`, and then
 * `crx_installer.cc:404` declines every install with INSTALL_NOT_ENABLED.
 *
 * This matters here for a concrete reason rather than a theoretical one: a
 * profile that was ever launched WITH the old flag set can have the disabled
 * state persisted into it. Fixing only the command line would then leave the
 * user with the identical error message and no way to tell that anything had
 * changed — the worst possible outcome of a bug fix.
 *
 * Same discipline as `enableSessionRestore` and `clearCrashedExitState`: touch
 * only this one key, leave the rest of the user's profile byte for byte alone,
 * write via a same-directory temp + rename so an interrupted write cannot
 * truncate the profile, and NEVER block a launch on failure — a browser that
 * might refuse an install is still far better than no browser.
 *
 * Returns a short description of what it did, for the log and for tests.
 */
export async function enableExtensionInstalls(userDataDir: string): Promise<string> {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  try {
    let prefs: { extensions?: Record<string, unknown> } = {};
    try {
      prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
    } catch {
      // No Preferences file at all is the normal state of a fresh profile, and
      // it means nothing has disabled extensions. Creating the file just to
      // write `false` would be inventing state we do not need.
      return 'no profile yet';
    }
    if (!prefs || typeof prefs !== 'object') return 'unreadable';

    const extensions = (prefs.extensions || {}) as Record<string, unknown>;
    if (extensions.disabled !== true) return 'already allowed';

    extensions.disabled = false;
    prefs.extensions = extensions;

    await fs.mkdir(path.dirname(prefsPath), { recursive: true });
    const tmp = `${prefsPath}.abtmp`;
    await fs.writeFile(tmp, JSON.stringify(prefs), 'utf8');
    await fs.rename(tmp, prefsPath);
    return 'extensions.disabled true -> false';
  } catch (e) {
    return `could not clear (${(e as Error).message})`;
  }
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
  /**
   * The download shelf for this browser.
   *
   * Not optional. Without a 'download' listener Playwright treats every
   * download as temporary: MEASURED, a file served as `report.png` landed as a
   * bare GUID with no extension and was DELETED when the context closed. See
   * core/RealChromeShelf.
   */
  private static shelf: RealChromeShelf | null = null;

  /**
   * The file dialogs this browser opens.
   *
   * Also not optional, and for the mirror-image reason. Without an interceptor
   * the page's "Choose file" opens a native GTK dialog that browses the SERVER's
   * disk — so the operator was told to upload to the server first and then type
   * the name into a dialog on the screen. MEASURED
   * (tools/probe-upload-vnc.js) that a real X11 click IS intercepted, which is
   * what makes «کاربر نباید مجبور باشد ابتدا فایل را دستی روی سرور Upload کند»
   * achievable. See core/RemoteFileChooser.
   */
  private static chooser: RemoteFileChooser | null = null;

  static isEnabled(): boolean {
    return config.REAL_CHROME_ENABLED === true;
  }

  /**
   * Why the Remote Browser is off, and what to actually do about it.
   *
   * REPLACES: "Real Chrome is disabled. Set REAL_CHROME_ENABLED=true to use
   * extensions." — the exact string the operator reported, and a bad one for a
   * reason worth recording so it is not reintroduced.
   *
   * `REAL_CHROME_ENABLED` DEFAULTS TO TRUE (config.ts). So on a clean checkout
   * this branch is unreachable, and every operator who ever saw that message
   * was already in the one state the message cannot be explained by: someone
   * wrote `false` down somewhere. Telling them to "set it to true" without
   * saying WHERE the false came from sends them to edit a file that, in the
   * reported incident, was a `.env` inherited from a pre-35e6ed0 `.env.example`
   * — a file the installer deliberately never overwrites. They cannot find it
   * by guessing, and the message gave them nothing else to go on.
   *
   * So: name the mechanism, name the likely file, and give the check that
   * proves it. `npm run doctor` prints the resolved value with its provenance.
   */
  private static disabledExplanation(): string {
    return (
      'The Remote Browser is switched OFF by configuration: REAL_CHROME_ENABLED=false. '
      + 'Extensions and the Element Inspector cannot run while it is off.\n'
      + 'Note the default is TRUE, so something set it explicitly — usually a stale .env '
      + 'copied from an older release (the installer never overwrites an existing .env).\n'
      + 'To fix: delete the REAL_CHROME_ENABLED line from your .env, or set it to true, then restart.\n'
      + 'To see where the current value came from: npm run doctor'
    );
  }

  /**
   * The file dialog the remote page is waiting on, if any.
   *
   * Null when the browser is not running, because a dialog belongs to a live
   * page: reporting one for a browser that no longer exists would make the view
   * prompt for a file nothing can receive.
   */
  static pendingChooser(): PendingChooser | null {
    return this.chooser ? this.chooser.pending() : null;
  }

  /** Answer that dialog with files already uploaded under `downloadOwner()`. */
  static async acceptChooserFiles(id: string, tokens: string[]): Promise<{ count: number }> {
    if (!this.chooser) {
      throw new RealChromeError('The remote browser is not running, so no page is asking for a file.');
    }
    return this.chooser.accept(id, tokens);
  }

  /** Dismiss it. An empty id cancels whatever is pending. */
  static async cancelChooser(id = ''): Promise<boolean> {
    return this.chooser ? this.chooser.cancel(id) : false;
  }

  /**
   * Files this browser has downloaded, newest first.
   *
   * Empty when the browser is not running: the shelf belongs to a live context,
   * and reporting rows for a browser that no longer exists would offer links
   * whose provenance we can no longer vouch for. The FILES stay fetchable by
   * token either way, because saveAs already claimed them.
   */
  static downloads(): ShelfEntry[] {
    return this.shelf ? this.shelf.list() : [];
  }

  /** The identity the shelf's files are stored under — the fetch route needs it. */
  static downloadOwner(): string {
    return REAL_CHROME_SHELF_USER;
  }

  /**
   * Delete one downloaded file and drop it from the shelf.
   *
   * `false` when there is no shelf (the browser is not up) or the token is not
   * on it, so the route can answer 404 rather than report a success it did not
   * perform.
   */
  static async forgetDownload(token: string): Promise<boolean> {
    return this.shelf ? this.shelf.forget(token) : false;
  }

  static isRunning(): boolean {
    return this.context !== null;
  }

  /**
   * Is the browser actually ANSWERING, not merely present?
   *
   * `isRunning()` reports on an object reference, and the operator's other §3.2
   * symptom is precisely the case where that reference lies:
   *
   *   «وقتی وبگردی میکردم هنگ کرد و بعدش دیگه فریز شد … مجدد باز کنم کلا نرفت
   *    به اون ادرس»
   *
   * A wedged renderer does not close the context, so `this.context` stays
   * non-null and `isRunning()` keeps saying true while nothing responds. Every
   * caller that reuses the context on that basis then hands the operator a view
   * onto a corpse — the reported dead end.
   *
   * A trivial round trip is the only honest test: ask a page to evaluate 1+1
   * (or, if there are no pages, ask the context for its pages, which still
   * crosses the process boundary). `timeoutMs` is deliberately short: this runs
   * on a user-facing path and a wedged browser will never answer, so waiting
   * longer only makes the operator wait longer for the same verdict.
   */
  static async isResponsive(timeoutMs = 2000): Promise<boolean> {
    const ctx = this.context;
    if (!ctx) return false;

    const probe = (async () => {
      const pages = ctx.pages();
      // A context with no pages is idle, not wedged; there is nothing to ask.
      if (pages.length === 0) return true;
      // The FIRST page that answers is enough — one hung tab does not make the
      // browser unusable, and killing a whole Chrome over it would itself be
      // the tab loss this change exists to prevent.
      const answers = pages.map((p) => p.evaluate('1+1').then(() => true));
      return Promise.any(answers).then(() => true).catch(() => false);
    })();

    return Promise.race([
      probe.catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  /**
   * Recycle a wedged browser WITHOUT losing the operator's tabs.
   *
   * This is the recovery the operator did by hand and lost their work to. The
   * profile is preserved (it is a directory on disk, not process state) and,
   * with REAL_CHROME_RESTORE_TABS on, the relaunch reopens the same tabs —
   * MEASURED 3 of 3 in tools/probe-realchrome-tab-loss.js.
   *
   * Returns what it decided, so the caller can tell the operator whether
   * anything was actually wrong. Deliberately a no-op when the browser is
   * healthy: recycling a working browser to "be safe" would throw away live
   * pages for nothing.
   */
  static async recycleIfWedged(probeTimeoutMs = 2000): Promise<{
    action: 'none' | 'not-running' | 'recycled';
    reason: string;
  }> {
    if (!this.context) return { action: 'not-running', reason: 'no browser to check' };
    if (await this.isResponsive(probeTimeoutMs)) {
      return { action: 'none', reason: 'browser is responsive' };
    }
    // stop() tolerates a context whose close() hangs, and the profile — cookies,
    // extension storage and the session file the restore reads — is on disk.
    await this.stop();
    await this.getContext();
    return {
      action: 'recycled',
      reason: 'browser stopped answering; relaunched with the same profile',
    };
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
   * The flag selection the NEXT launch will use.
   *
   * Held here rather than passed through `getContext()` because the browser is a
   * shared singleton: the picker, the routes and the desktop all call
   * `getContext()` and only one of them is the operator expressing a preference.
   * A flag choice therefore has to outlive the request that made it.
   *
   * Null means "nothing chosen" — resolveFlags() then applies the recommended
   * preset, which reproduces exactly what shipped before this existed.
   */
  private static flagChoice: ResolveFlagsInput | null = null;
  private static launchedWith: ResolvedFlags | null = null;

  /**
   * Choose the flags for the next launch.
   *
   * Returns what WOULD be used, including anything unknown or forced, so the
   * caller can show the operator the consequences before restarting. Does not
   * touch a running browser: Chrome reads these only at startup, and pretending
   * otherwise would be the same silent lie as a dropped flag.
   */
  static setFlagChoice(input: ResolveFlagsInput | null): ResolvedFlags {
    this.flagChoice = input;
    return resolveFlags(input ?? {});
  }

  /** The selection queued for the next launch (not necessarily the live one). */
  static currentFlagChoice(): ResolvedFlags {
    return resolveFlags(this.flagChoice ?? {});
  }

  /**
   * What the RUNNING browser was actually started with.
   *
   * Distinct from `currentFlagChoice()` on purpose: after changing the
   * selection the two disagree until a restart, and that gap is exactly what
   * the UI must be able to point at ("restart to apply").
   */
  static activeFlags(): ResolvedFlags | null {
    return this.launchedWith;
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
      throw new RealChromeError(this.disabledExplanation());
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
    await clearCrashedExitState(userDataDir);
    // The second half of the "Installation is not enabled" fix. The first half
    // is NOT emitting --disable-extensions-except (see extensionLaunchArgs); this
    // clears the same condition's other source, the profile's own
    // `extensions.disabled` pref, which a profile launched under the old flag can
    // have persisted. Both, or the user sees the identical error and cannot tell
    // that anything was fixed.
    const installsSaid = await enableExtensionInstalls(userDataDir);
    // Both of these, or neither: MEASURED, the pref alone and the flag alone
    // each restore ZERO tabs. See enableSessionRestore for the table.
    const restoreTabs = config.REAL_CHROME_RESTORE_TABS === true;
    const restoreSaid = restoreTabs ? await enableSessionRestore(userDataDir) : 'disabled';

    // The Element Inspector this repository SHIPS, made present before the
    // extension list is read.
    //
    // The spec forbids a second Inspector («نباید دو Inspector جداگانه ساخته
    // شود») and requires the one Inspector to serve BOTH modes. Local mode gets
    // it for free — it is installed in the user's own Chrome. REMOTE mode did
    // not: this launcher only side-loads what is already in `extensionsDir`, and
    // nothing ever put `extension/` there, so on a fresh checkout that directory
    // did not exist and the remote Chromium started with no Inspector at all.
    // Seeding here (and not, say, at server start) is deliberate: this is the
    // one place that decides what THIS Chromium loads, so the install cannot be
    // missed by a launch that took another path.
    const seeded = await seedInspectorExtension(extensionsDir);
    if (seeded.reason === 'failed') {
      // Degrade, do not fail. A browser that will not start is worse than a
      // browser without the Inspector, and the message says which happened.
      console.warn(`[REAL-CHROME] Inspector extension not seeded: ${seeded.error}`);
    } else if (seeded.seeded) {
      console.log(
        `[REAL-CHROME] 🔍 Element Inspector ${seeded.reason} `
        + `(v${seeded.version || '?'}) → ${seeded.dir}`,
      );
    }

    const extensions = await listExtensions(extensionsDir);
    const headless = config.REAL_CHROME_HEADLESS === true;
    const vp = this.viewport();

    // FILL THE SCREEN. The operator saw the browser occupying part of the tab
    // with the rest black. MEASURED: screen 1600x900 but window 1288x811+10+10,
    // i.e. COVERAGE 72.5% -- the remaining 27.5% is bare X root window, and the
    // root window is black. That happens whenever the display was not started
    // by us (so it does not follow REAL_CHROME_WINDOW_*), which is the normal
    // case. Ask X how big the screen really is and match it; fall back to the
    // configured size when there is no display to ask (headless, no xdpyinfo).
    const screen = headless ? null : await Desktop.screenSize();

    // The switches now come from the CATALOGUE (src/core/ChromeFlags.ts) rather
    // than from a hard-coded array here, so the operator can pick them from a
    // form instead of reading this source and searching the web for what each
    // one does. The default selection is byte-identical to the array this
    // replaced, minus one accidental duplicate of --no-default-browser-check
    // (it was listed here AND in ANTI_AUTOMATION_ARGS) -- pinned by the
    // `reproduces the previously hard-coded arg list` test.
    //
    // REAL_CHROME_RESTORE_TABS still wins over the selection: it is the
    // documented kill switch for the tab-restore feature, and a preset quietly
    // re-enabling something the operator turned off in .env would be the exact
    // betrayal EnvProfile.ts refuses to commit.
    const chosen = resolveFlags({
      ...(this.flagChoice ?? {}),
      overrides: {
        ...(this.flagChoice?.overrides ?? {}),
        'restore-last-session': restoreTabs,
      },
    });
    this.launchedWith = chosen;

    const args = [
      ...chosen.args,
      ...windowArgs(screen),
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
    // A UTF-8 locale, or a download named `صفحه.png` arrives called `download`
    // with no extension at all — see withUtf8Locale for the measurement.
    const env: NodeJS.ProcessEnv = withUtf8Locale(process.env);
    if (!headless && !env.DISPLAY && config.REAL_CHROME_DISPLAY) {
      env.DISPLAY = config.REAL_CHROME_DISPLAY;
    }

    const ua = realisticUserAgent(null);

    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        timeout: Math.max(config.BROWSER_LAUNCH_TIMEOUT_MS, 60_000),
        ...(config.CHROME_EXE ? { executablePath: config.CHROME_EXE } : {}),
        // Playwright's defaults contain --disable-extensions (which would make
        // --load-extension a silent no-op) and --enable-automation (which shows
        // the yellow "controlled by automated test software" bar and disables
        // the password manager). Both must be REMOVED here; countering them
        // with extra args does not work. See IGNORED_DEFAULT_ARGS for the
        // measurement.
        ignoreDefaultArgs: [...IGNORED_DEFAULT_ARGS],
        args,
        env,
        // null lets the PAGE follow the real window instead of being pinned to
        // a fixed box inside it. With a fixed viewport, growing the window to
        // the screen would leave the page rendering at the old size with dead
        // space around it -- trading a black margin for a white one. The picker
        // maps clicks through the page's own coordinate space, so it follows.
        viewport: screen ? null : vp,
        ...(ua ? { userAgent: ua } : {}),
        locale: 'en-US',
        timezoneId: 'UTC',
        acceptDownloads: true,
        ignoreHTTPSErrors: true,
        downloadsPath: config.DOWNLOADS_DIR,
      });

      this.loaded = extensions;

      // Start watching for downloads BEFORE anyone can navigate. A download
      // that fires before the listener is attached is one Playwright throws
      // away when the context closes, which is the bug this fixes.
      this.shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
      this.shelf.watch(context);

      // And for the same reason, before anyone can press a page's "Choose file":
      // an un-intercepted chooser opens a native dialog onto the SERVER's disk,
      // which is the manual round trip the operator explicitly rejected. Sharing
      // the shelf's identity is deliberate — the bytes are written under
      // REAL_CHROME_SHELF_USER by /browser/uploads and must be looked for under
      // the same id, which is the documented ENOENT hand-over bug.
      this.chooser = new RemoteFileChooser(REAL_CHROME_SHELF_USER);
      this.chooser.watch(context);

      context.on('close', () => {
        this.context = null;
        this.loaded = [];
        this.debugInfo = { version: '', ws: '' };
        // The shelf ROWS are dropped with the browser, but the FILES are not:
        // they were claimed with saveAs into the user's download directory and
        // are fetched by token, so a link already handed out keeps working.
        this.shelf = null;
        // A pending dialog, by contrast, cannot outlive its browser: the page
        // that asked is gone, so keeping the row would have the view prompting
        // for a file with nowhere to put it.
        this.chooser = null;
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
        `profile=${userDataDir}, tab-restore=${restoreSaid}, installs=${installsSaid}` +
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
   *
   * `forPageUrl` is the page the extension is being opened FOR. Opening the
   * popup as a tab makes the popup itself the active tab, so an extension that
   * asks Chrome "which site am I on?" gets the wrong answer; passing the page
   * URL along fixes that. See extensionPageUrlFor for the measurements.
   */
  static extensionPageUrl(id: string, forPageUrl = ''): string {
    const found = this.loadedExtensions().find(
      (e) => e.id === id || e.name === id || e.runtimeId === id || e.storeId === id,
    );
    if (!found) return '';
    const base = found.popupUrl || found.optionsUrl || found.url;
    return forPageUrl ? extensionPageUrlFor(forPageUrl, base) : base;
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

  /**
   * Stop Chrome. Cookies live in the profile directory, so nothing is lost.
   *
   * The close is time-bounded, and that bound is load-bearing rather than
   * defensive: `context.close()` asks the browser to shut down cleanly, and a
   * WEDGED browser is by definition one that does not answer such requests. The
   * caller that needs stop() most is recycleIfWedged(), so an unbounded await
   * here would hang the very recovery path that exists to escape the hang —
   * the operator's dead end, reimplemented on the server.
   *
   * The internal state is cleared BEFORE the await either way, so a close that
   * never returns cannot leave a dead context being handed to new callers.
   */
  static async stop(timeoutMs = 10_000): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.loaded = [];
    this.debugInfo = { version: '', ws: '' };
    if (!ctx) return;
    await Promise.race([
      ctx.close().catch(() => { /* already gone */ }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Stop and start again — the only way to pick up newly installed extensions. */
  static async restart(): Promise<RealChromeStatus> {
    await this.stop();
    await this.getContext();
    return this.status();
  }
}

/**
 * Tell the profile it exited cleanly, so Chrome does not open with the
 * "Restore pages? Chromium didn't shut down correctly." bubble.
 *
 * MEASURED (2026-08-11) on this repo's own live profile, after the browser had
 * been killed rather than closed:
 *
 *   profiles/chrome-profile/Default/Preferences
 *     → profile.exit_type === "Crashed"
 *
 * and the next launch showed the restore bubble over the page.
 *
 * WHY THIS IS NOT COSMETIC, AND NOT A ONE-OFF
 * -------------------------------------------
 * Chrome writes exit_type="Crashed" whenever the process does not get to run
 * its clean-shutdown path. On a server that is the NORMAL case, not the
 * exceptional one: the container is stopped, the box runs out of memory and the
 * OOM killer fires, the dev server is restarted, or systemd sends SIGKILL after
 * its stop timeout. So the bubble would greet the user on a large share of
 * ordinary restarts, through no fault of theirs.
 *
 * It matters because this browser is driven by automation. The bubble is a
 * focused overlay: it eats clicks aimed at the page underneath, and if the user
 * ever presses "Restore", Chrome reopens every tab from the previous session —
 * silently changing the tab set that the automation and the tab list are
 * working with. A stale confirmation prompt deciding what tabs exist is a
 * correctness problem, not a decoration.
 *
 * We only ever rewrite the two exit-state keys, and only when the recorded
 * state is not already clean. Everything else in Preferences — extension
 * settings, site permissions, passwords — is left byte-for-byte alone, because
 * this file is the user's profile and not ours to normalise. Failure is
 * deliberately ignored: a missing or unparseable Preferences file means a fresh
 * profile, which has no crash to clear, and must never block the launch.
 */
export async function clearCrashedExitState(userDataDir: string): Promise<void> {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  try {
    const raw = await fs.readFile(prefsPath, 'utf8');
    const prefs = JSON.parse(raw) as { profile?: Record<string, unknown> };
    const profile = prefs.profile;
    if (!profile) return;
    if (profile.exit_type === 'Normal' && profile.exited_cleanly === true) return;

    profile.exit_type = 'Normal';
    profile.exited_cleanly = true;
    // Same-directory temp + rename, so a crash midway through this write cannot
    // leave a truncated Preferences behind — that would lose the real profile.
    const tmp = `${prefsPath}.abtmp`;
    await fs.writeFile(tmp, JSON.stringify(prefs), 'utf8');
    await fs.rename(tmp, prefsPath);
  } catch {
    /* no profile yet, or unreadable — nothing to clear, never block the launch */
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
