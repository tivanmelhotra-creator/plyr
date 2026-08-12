/**
 * browser.routes — control the REAL Chrome: extensions, cookies, remote desktop.
 *
 * Everything here exists to serve one workflow that the canvas picker can never
 * serve on its own:
 *
 *   "I log in once in my own Chrome, export my cookies with an extension, and
 *    import that file anywhere instead of logging in again."
 *
 * There are two ways to satisfy it and this router exposes BOTH, because they
 * fail in different situations:
 *
 *   A. Native import  — POST /browser/cookies/import with the exported file.
 *      Works headless, works for queued jobs, no clicking. Use this unless the
 *      extension does something clever beyond cookies.
 *
 *   B. The extension itself — upload the .crx/.zip, restart Chrome, then either
 *      open the extension's popup as a tab inside the existing picker canvas, or
 *      look at the whole Chrome window over noVNC and click the toolbar button
 *      like you would locally.
 */

import { Router, type Response } from 'express';
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

import { config } from '../config';
import { RealChrome, RealChromeError } from '../core/RealChrome';
import { flagCatalogue } from '../core/ChromeFlags';
import { describeProfile, PROFILES } from '../core/EnvProfile';
// `displayGuidance` is no longer imported here: the "there is no screen" message
// belongs to SelfHeal now, because SelfHeal is what tries to make one first.
import { Desktop, DesktopError } from '../core/Desktop';
import {
  installExtensionArchive,
  installExtensionFromStore,
  webStoreIdFromInput,
  listExtensions,
  removeExtension,
  ExtensionError,
} from '../core/ChromeExtensions';
import {
  parseCookieFile,
  mergeIntoStorageState,
  CookieImportError,
  type CookieImportResult,
} from '../core/CookieImport';
import { sessionStatePath, loadStorageState } from '../core/BrowserProfile';
import { saveUpload, UploadError, MAX_UPLOAD_BYTES } from '../core/RemoteUploads';
import { FileChooserError } from '../core/RemoteFileChooser';
import {
  resolveDownload,
  DownloadError,
  contentDispositionAttachment,
} from '../core/RemoteDownloads';
import { SelfHeal, type HealStep } from '../core/SelfHeal';
// The same gate /browser/ws uses. Uploads must be scoped to the identity the
// socket runs as, so they must be authorized by the identical rule.
import { authorizeLive } from '../core/LiveServer';
import { SINGLE_USER_ID, type AuthenticatedRequest } from '../middleware/auth';

/**
 * "We never lose a tab" — the other half of it.
 *
 * Relaunching Chrome kills every page inside it, including the ones live picker
 * sessions are streaming. Nothing about their WebSockets changes, so the user is
 * left looking at a perfectly good last frame of a page whose browser no longer
 * exists: connected, unbroken-looking, and completely dead. There is nothing on
 * screen to tell them to act, which is the worst state this system can reach.
 *
 * `SelfHeal.reloadExtensions(report, onSwap)` already has a slot for this — it
 * calls `onSwap` in the window between stopping and starting Chrome. What was
 * missing was anyone filling it: every route passed no `onSwap`, so the hook
 * existed and did nothing.
 *
 * This router cannot import the manager (index.ts owns it, and importing it here
 * would be a cycle), so index.ts REGISTERS the rebuild instead. It defaults to a
 * no-op, which keeps the routes testable in isolation and keeps a mis-wired
 * bootstrap from crashing an extension install.
 */
let rebuildLiveSessions: () => Promise<void> = async () => {};

/** Called once at boot by index.ts, which owns the LiveBrowserManager. */
export function setLiveSessionRebuilder(fn: () => Promise<void>): void {
  rebuildLiveSessions = fn;
}

/**
 * The `onSwap` every relaunch passes. Never throws: a session that cannot come
 * back reports its own state over its own socket, and letting that failure
 * escape here would turn "one tab did not recover" into "the extension install
 * failed", which is a lie about a completely different thing.
 */
async function swapLiveSessions(): Promise<void> {
  try { await rebuildLiveSessions(); } catch { /* each session reports itself */ }
}

/**
 * Which profile do we write to?
 *
 * In single-user mode there is exactly one identity ('local'), and the picker
 * already uses it. In multi-user mode the API key decides — never a query
 * parameter, or user A could import cookies into user B's profile and then read
 * them back through the picker.
 */
function resolveUserId(req: AuthenticatedRequest): string {
  if (config.IS_SINGLE_USER) return SINGLE_USER_ID;
  return req.apiKeyUserId || SINGLE_USER_ID;
}

/**
 * The API key as the auth middleware accepted it.
 *
 * Repeated here rather than exported from the middleware because the middleware
 * consumes the key and keeps only the resolved user; the upload route needs the
 * key itself to re-run `authorizeLive` against a *different* userId. All three
 * accepted forms must be honoured, or the header-only clients would work and
 * the query-param ones (the picker's own socket URL style) would 403.
 */
function apiKeyOf(req: AuthenticatedRequest): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (req.query.api_key) return String(req.query.api_key);
  // token query is used by download links sent from the shelf so a native
  // <a> click (which cannot carry headers) still authenticates.
  if (req.query.token) return String(req.query.token);
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.substring(7).trim();
  return undefined;
}

function fail(res: Response, status: number, error: string, hint = ''): void {
  res.status(status).json({ success: false, error, ...(hint ? { hint } : {}) });
}

/** Map our typed errors onto sensible HTTP codes instead of a blanket 500. */
function sendError(res: Response, e: unknown): void {
  if (e instanceof CookieImportError || e instanceof ExtensionError) {
    return fail(res, 400, e.message);
  }
  if (e instanceof UploadError || e instanceof FileChooserError) {
    // 409, not 500: the request was well formed, the dialog it named has simply
    // moved on. The view retries by re-reading the pending row, and a 500 would
    // have it reporting a server fault for an ordinary race.
    return fail(res, e instanceof FileChooserError ? 409 : 400, e.message);
  }
  if (e instanceof RealChromeError) {
    // 503: the request was fine, the browser is not available *yet*.
    return fail(res, 503, e.message);
  }
  if (e instanceof DesktopError) {
    return fail(res, 503, e.message);
  }
  return fail(res, 500, (e as Error)?.message || 'Unexpected error');
}

/**
 * Merge imported cookies into the user's on-disk storageState.
 *
 * This is what makes an import useful to AUTOMATION and not only to the
 * interactive window: queued jobs build a fresh context from this file, so a
 * session imported here survives a Chrome restart and is picked up by every
 * future run.
 */
async function persistToProfile(userId: string, imported: CookieImportResult): Promise<number> {
  const existing = await loadStorageState(userId);
  const merged = mergeIntoStorageState(
    existing as { cookies?: unknown; origins?: unknown } | undefined,
    imported,
  );
  const file = sessionStatePath(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // write-then-rename: a crash mid-write must not truncate an existing session.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged), 'utf8');
  await fs.rename(tmp, file);
  return merged.cookies.length;
}

/**
 * Collect the heal steps so the RESPONSE can explain what happened.
 *
 * The mandate is that whenever the user waits, the UI says who did what and how
 * long it took. These routes are request/response rather than streaming, so the
 * steps are gathered and returned in one go: the client renders them as a
 * finished checklist ("display started ✓, Chrome relaunched ✓, extensions
 * loaded ✓") instead of the single opaque sentence it used to get.
 *
 * `key` is a stable identifier, never a sentence, because the UI must be able to
 * render it in Persian as well as English.
 */
function healCollector(): { steps: HealStep[]; report: (s: HealStep) => void } {
  const steps: HealStep[] = [];
  return {
    steps,
    report: (s) => {
      // Cap it: a pathological retry loop must not build an unbounded array on
      // its way to a JSON response.
      if (steps.length < 40) steps.push(s);
    },
  };
}

export const createBrowserRoutes = (): Router => {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // Status
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/status', async (_req, res) => {
    try {
      const [realChrome, desktop] = await Promise.all([
        RealChrome.status(),
        Desktop.status(),
      ]);
      // The live heal, if there is one. This is what lets a picker window that
      // was closed and reopened mid-restart show real progress instead of looking
      // dead — the reported "I reopened it and it was stuck the same way". `null`
      // when nothing is running, so the client shows nothing rather than a panel
      // about a heal that finished ten minutes ago.
      const heal = SelfHeal.currentHeal();
      res.json({ success: true, realChrome, desktop, heal });
    } catch (e) { sendError(res, e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tab inspection — §5 light remote mode.
  //
  // When the picker canvas wedges or lies, the operator wants to see whether
  // the real Chrome still has the tabs they were working with, and they want a
  // way to kill a hung tab without restarting the whole browser. These two
  // routes are the read and the write of that diagnostic.
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/tabs', async (_req, res) => {
    try {
      const tabs = await RealChrome.tabs();
      res.json({ success: true, tabs });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/tabs/close', async (req: AuthenticatedRequest, res) => {
    const prefix = String((req.body && (req.body as { url?: string }).url) || '').trim();
    if (!prefix) {
      return fail(res, 400, 'Missing "url" prefix.',
        'POST { "url": "https://example.com/path" } — the matching tab is closed.');
    }
    try {
      const closed = await RealChrome.closeTab(prefix);
      if (!closed) {
        return fail(res, 404, 'No tab matched that URL prefix.',
          'GET /browser/tabs to see what is currently open.');
      }
      // Sync LiveBrowser so screencast and UI list update immediately
      // Tab sync handled via LiveBrowserEvents internally
      res.json({ success: true, closed: prefix });
    } catch (e) { sendError(res, e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Real Chrome lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start the real Chrome, bringing the virtual display up first if it is not
   * already running. Doing the display implicitly matters: "start browser" that
   * fails with "no X server" is a dead end for anyone who has not read the docs.
   */
  router.post('/browser/start', async (_req, res) => {
    if (!RealChrome.isEnabled()) {
      // The one genuinely un-healable case: this is a deliberate configuration
      // choice, and turning it on by ourselves would be overriding the operator
      // rather than helping the user. Note it names the SETTING, and does not
      // ask for a restart — the setting is read per call.
      return fail(
        res, 409,
        'Real Chrome is disabled.',
        'Set REAL_CHROME_ENABLED=true in .env.',
      );
    }
    try {
      // Everything the old body did by hand — bring up the display, fall back to
      // Xvfb alone when the viewer packages are missing, then launch Chrome — now
      // lives in SelfHeal, so /browser/start, an extension install and a live
      // session all heal identically instead of each having its own partial
      // version of the same recovery.
      const { steps, report } = healCollector();
      const healed = await SelfHeal.ensureBrowser(report);
      if (!healed.ok) {
        return res.status(503).json({
          success: false,
          error: healed.problem || 'The browser could not be started.',
          ...(healed.hint ? { hint: healed.hint } : {}),
          steps,
          realChrome: healed.realChrome,
        });
      }
      res.json({ success: true, realChrome: healed.realChrome, steps });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/stop', async (_req, res) => {
    try {
      // غیرفعال‌سازی سراسری SelfHeal تا کروم رو دوباره راه نیندازه
      const { setSelfHealEnabled } = await import('../core/SelfHeal');
      setSelfHealEnabled(false);
      await RealChrome.stop();
      res.json({ success: true, realChrome: await RealChrome.status() });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/start', async (_req, res) => {
    try {
      const { SelfHeal, setSelfHealEnabled } = await import('../core/SelfHeal');
      setSelfHealEnabled(true);
      const { steps, report } = healCollector();
      const status = await (SelfHeal as any).heal({ report });
      res.json({ success: true, steps, realChrome: status.realChrome });
    } catch (e) { sendError(res, e); }
  });

  /**
   * Relaunch Chrome, reporting each step.
   *
   * Kept as a route because it is a legitimate thing to ASK for ("pick up the
   * extension I just installed", "give me a clean browser") — but it is no longer
   * something the user is TOLD to do. Installing an extension now performs this
   * itself, and every message that used to end in "restart the browser" has been
   * replaced by the server doing it.
   *
   * It goes through SelfHeal rather than `RealChrome.restart()` so a display that
   * died with Chrome is brought back too, and so the response can explain what
   * happened instead of returning a bare status object.
   */
  router.post('/browser/restart', async (_req, res) => {
    try {
      const { steps, report } = healCollector();
      const healed = await SelfHeal.reloadExtensions(report, swapLiveSessions);
      if (!healed.ok) {
        return res.status(503).json({
          success: false,
          error: healed.problem || 'The browser could not be restarted.',
          ...(healed.hint ? { hint: healed.hint } : {}),
          steps,
          realChrome: healed.realChrome,
        });
      }
      res.json({ success: true, realChrome: healed.realChrome, steps });
    } catch (e) { sendError(res, e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Extensions
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/extensions', async (_req, res) => {
    try {
      const installed = await listExtensions(config.REAL_CHROME_EXTENSIONS_DIR);
      const loaded = RealChrome.loadedExtensions();
      const loadedIds = new Set(loaded.map((e) => e.id));
      res.json({
        success: true,
        extensionsDir: config.REAL_CHROME_EXTENSIONS_DIR,
        // `loaded` tells the UI whether a restart is still pending for this one.
        extensions: installed.map((e) => ({
          ...e,
          loaded: loadedIds.has(e.id),
          ...(loaded.find((l) => l.id === e.id) || {}),
        })),
      });
    } catch (e) { sendError(res, e); }
  });

  /**
   * Upload a .crx or .zip.
   *
   * Raw body rather than multipart: no multer dependency, and the browser can
   * send the File object straight through `fetch(file)`. The name arrives as a
   * query parameter because a raw body has no filename.
   */
  router.post(
    '/browser/extensions',
    express.raw({ type: () => true, limit: '64mb' }),
    async (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return fail(res, 400, 'No file was uploaded.',
            'POST the .crx/.zip bytes as the raw request body.');
        }
        const name = String(req.query.name || 'extension.zip');
        const ext = await installExtensionArchive(
          config.REAL_CHROME_EXTENSIONS_DIR, name, body,
        );
        // ── THE REPORTED BUG, AND WHAT IT IS NOW ────────────────────────────
        // This used to answer:
        //   "Installed. Restart the browser to load it — Chrome only reads
        //    extensions at launch."
        // and set `restartRequired: true`. Both statements are true; the
        // response was still a defect. It named no button, and the button the
        // user did press appeared to do nothing, leaving them (their words)
        // گیج و منگ. Chrome genuinely only reads extensions at launch — so the
        // SERVER relaunches it, here, now, and reports every step it took.
        const { steps, report } = healCollector();
        const healed = await SelfHeal.reloadExtensions(report, swapLiveSessions);
        res.json({
          success: true,
          extension: ext,
          // Kept for API compatibility, and now always false: there is nothing
          // left for the caller to restart.
          restartRequired: false,
          loaded: !!healed.ok,
          steps,
          realChrome: healed.realChrome,
          ...(healed.ok ? {} : {
            // The extension IS installed even if the relaunch failed, so this is
            // a warning about the load, not a failed install.
            warning: healed.problem || 'Installed, but the browser could not be relaunched.',
            ...(healed.hint ? { hint: healed.hint } : {}),
          }),
        });
      } catch (e) { sendError(res, e); }
    },
  );

  /**
   * Install straight from a Chrome Web Store link.
   *
   * This is the whole point of the feature: the operator pastes the store URL
   * of, say, a cookie extension and the server fetches, unpacks and pins it —
   * no .crx hunting, and no remote desktop to click "Add to Chrome" in.
   */
  router.post('/browser/extensions/store', async (req, res) => {
    try {
      const input = String((req.body && (req.body.url ?? req.body.id)) || '').trim();
      if (!input) {
        return fail(res, 400, 'No Chrome Web Store link was provided.',
          'POST { "url": "https://chromewebstore.google.com/detail/<slug>/<id>" }.');
      }
      if (!webStoreIdFromInput(input)) {
        return fail(res, 400,
          'That does not look like a Chrome Web Store link.',
          'Open the extension in the Web Store and copy the address bar, or paste its 32-letter id.');
      }

      const ext = await installExtensionFromStore(config.REAL_CHROME_EXTENSIONS_DIR, input);
      // Same as the archive route above: install, then LOAD it, then say what
      // was done. This is the path the reported J2TEAM Cookies case takes.
      const { steps, report } = healCollector();
      const healed = await SelfHeal.reloadExtensions(report, swapLiveSessions);
      res.json({
        success: true,
        extension: ext,
        restartRequired: false,
        loaded: !!healed.ok,
        steps,
        realChrome: healed.realChrome,
        ...(healed.ok ? {} : {
          warning: healed.problem
            || `Installed ${ext.name} v${ext.version}, but the browser could not be relaunched.`,
          ...(healed.hint ? { hint: healed.hint } : {}),
        }),
      });
    } catch (e) { sendError(res, e); }
  });

  router.delete('/browser/extensions/:id', async (req, res) => {
    try {
      const removed = await removeExtension(config.REAL_CHROME_EXTENSIONS_DIR, req.params.id);
      if (!removed) return fail(res, 404, 'No such extension.');
      // Removing needs the same relaunch as installing: an extension whose files
      // are gone is still loaded in the running Chrome, so leaving it there means
      // the UI says "removed" while the extension keeps working — the same class
      // of lie as "restart required", just in the other direction.
      const { steps, report } = healCollector();
      const healed = await SelfHeal.reloadExtensions(report, swapLiveSessions);
      res.json({
        success: true,
        restartRequired: false,
        unloaded: !!healed.ok,
        steps,
        realChrome: healed.realChrome,
      });
    } catch (e) { sendError(res, e); }
  });

  /**
   * The chrome-extension:// URL to open for an extension.
   *
   * The picker canvas can navigate to this and render the extension's own popup
   * UI, with full extension privileges — which is how you drive a cookie
   * extension without a remote desktop.
   */
  router.get('/browser/extensions/:id/url', async (req, res) => {
    // `for` is the page the extension is being opened FOR. Opening a popup as a
    // tab makes the popup the active tab, so an extension that asks Chrome
    // "which site am I on?" gets itself — which is why J2TEAM's Export silently
    // did nothing. See RealChrome.extensionPageUrlFor for the measurements.
    const forPage = typeof req.query.for === 'string' ? req.query.for : '';
    let url = RealChrome.extensionPageUrl(req.params.id, forPage);
    const steps: HealStep[] = [];
    if (!url) {
      // It used to answer "Upload it, then POST /browser/restart" — an HTTP verb,
      // to someone holding a mouse. If the extension is installed on disk but not
      // loaded, the fix is a relaunch, and we can do that.
      const collector = healCollector();
      const installed = await listExtensions(config.REAL_CHROME_EXTENSIONS_DIR)
        .catch(() => []);
      if (installed.some((x) => x.id === req.params.id)) {
        await SelfHeal.reloadExtensions(collector.report, swapLiveSessions);
        steps.push(...collector.steps);
        url = RealChrome.extensionPageUrl(req.params.id, forPage);
      }
    }
    if (!url) {
      // Genuinely not installed — nothing to load. Now the message is about the
      // extension, not about a restart.
      return fail(
        res, 404,
        'That extension is not installed.',
        'Install it from a Chrome Web Store link or upload its .crx/.zip.',
      );
    }
    res.json({ success: true, url, ...(steps.length ? { steps } : {}) });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cookies
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Import an exported cookie file.
   *
   * Accepts the file as `{ text }` JSON (what the UI sends after FileReader) or
   * as a raw text body, so `curl --data-binary @cookies.json` also works.
   */
  router.post(
    '/browser/cookies/import',
    express.text({ type: ['text/*', 'application/octet-stream'], limit: '20mb' }),
    async (req: AuthenticatedRequest, res) => {
      const userId = resolveUserId(req);
      try {
        let text = '';
        if (typeof req.body === 'string') {
          text = req.body;
        } else if (req.body && typeof req.body === 'object') {
          const b = req.body as Record<string, unknown>;
          if (typeof b.text === 'string') text = b.text;
          // A UI that already parsed the JSON can post the array itself.
          else if (Array.isArray(b.cookies) || Array.isArray(b)) text = JSON.stringify(req.body);
        }
        if (!text.trim()) {
          return fail(res, 400, 'No cookie file content received.',
            'Send { "text": "<file contents>" } or the raw file as the body.');
        }

        const parsed = parseCookieFile(text);

        // Always persist: this is what makes the session available to queued
        // automation runs, not just to the window that is open right now.
        const totalStored = await persistToProfile(userId, parsed);

        // Additionally inject into the live browser when there is one, so the
        // user does not have to restart anything to see the effect.
        let applied = 0;
        let rejected: Array<{ cookie: string; reason: string }> = [];
        let live = false;
        if (RealChrome.isEnabled() && RealChrome.isRunning()) {
          const r = await RealChrome.importCookies(text);
          applied = r.applied;
          rejected = r.rejected;
          live = true;
        }

        res.json({
          success: true,
          format: parsed.format,
          parsed: parsed.cookies.length,
          skipped: parsed.skipped,
          domains: parsed.domains,
          storedInProfile: totalStored,
          appliedToLiveBrowser: applied,
          liveBrowser: live,
          rejected,
          message: live
            ? `Imported ${parsed.cookies.length} cookies for ${parsed.domains.length} domain(s); ${applied} applied to the running browser.`
            : `Imported ${parsed.cookies.length} cookies for ${parsed.domains.length} domain(s). They will be used the next time a browser starts.`,
        });
      } catch (e) { sendError(res, e); }
    },
  );

  /**
   * Export the saved session in Cookie-Editor's format.
   *
   * Symmetry with the import matters: whatever you can put in, you can take out
   * and load into your own Chrome with the same extension. It also makes the
   * import debuggable — you can see exactly what the server thinks it stored.
   */
  router.get('/browser/cookies/export', async (req: AuthenticatedRequest, res) => {
    const userId = resolveUserId(req);
    try {
      let cookies: unknown[] = [];

      // Prefer the LIVE browser: it has cookies set since the last save, which
      // is precisely the session you just created by logging in.
      if (RealChrome.isEnabled() && RealChrome.isRunning()) {
        const ctx = await RealChrome.getContext();
        cookies = await ctx.cookies();
      } else {
        const state = await loadStorageState(userId);
        const s = state as { cookies?: unknown[] } | undefined;
        cookies = Array.isArray(s?.cookies) ? s!.cookies! : [];
      }

      const domainFilter = String(req.query.domain || '').trim().toLowerCase();
      const filtered = domainFilter
        ? cookies.filter((c) => {
          const d = String((c as { domain?: string }).domain || '').replace(/^\./, '');
          return d === domainFilter || d.endsWith(`.${domainFilter}`);
        })
        : cookies;

      // Cookie-Editor shape: seconds in `expirationDate`, snake_case sameSite.
      const out = filtered.map((raw) => {
        const c = raw as {
          name?: string; value?: string; domain?: string; path?: string;
          expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string;
        };
        const expires = typeof c.expires === 'number' ? c.expires : -1;
        return {
          name: c.name || '',
          value: c.value || '',
          domain: c.domain || '',
          path: c.path || '/',
          secure: c.secure === true,
          httpOnly: c.httpOnly === true,
          hostOnly: !String(c.domain || '').startsWith('.'),
          session: expires < 0,
          ...(expires >= 0 ? { expirationDate: expires } : {}),
          sameSite: c.sameSite === 'None' ? 'no_restriction'
            : c.sameSite === 'Strict' ? 'strict' : 'lax',
          storeId: '0',
        };
      });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // `domainFilter` is a query parameter, so it can hold any character the
      // user can type — and an internationalised domain made this throw exactly
      // like the download route did. MEASURED: ?domain=مهدی.com -> 500,
      // ?domain=x.com -> 200. Same helper, same reason.
      res.setHeader(
        'Content-Disposition',
        contentDispositionAttachment(`cookies-${domainFilter || 'all'}.json`),
      );
      res.send(JSON.stringify(out, null, 2));
    } catch (e) { sendError(res, e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Remote file upload
  //
  // The counterpart of the picker's file-chooser prompt: the page asked for a
  // file, the file is on the USER's machine, and Chrome is on this one. The
  // bytes come here first; the WebSocket then hands the resulting token to the
  // waiting dialog. The client never learns a path — see core/RemoteUploads.
  //
  // WHY THIS TAKES ?userId AND THE COOKIE ROUTES ABOVE DO NOT
  // ---------------------------------------------------------
  // Uploads are stored per identity and resolved again by the SOCKET, and the
  // socket runs as the `userId` in its own query string (authorizeLive gates
  // it). Scoping the upload with `resolveUserId(req)` instead — the rule the
  // profile routes use — put the file under `local` while the session looked
  // for it under its own id, and the hand-over died with a bare ENOENT that
  // surfaced as "Import still does nothing". So the two must agree, and the
  // way to agree is to accept the same parameter behind the same gate: the key
  // must own the id, exactly as it must to open the socket at all.
  // ─────────────────────────────────────────────────────────────────────────

  router.post(
    '/browser/uploads',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req: AuthenticatedRequest, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return fail(res, 400, 'No file was uploaded.',
            'POST the file bytes as the raw request body, with ?name=<filename>.');
        }
        const asked = String(req.query.userId || '').trim();
        let owner = resolveUserId(req);
        if (asked && asked !== owner) {
          const auth = await authorizeLive(apiKeyOf(req), asked);
          if (!auth.ok) {
            return fail(res, 403, 'This API key may not upload for that user.',
              'Use the same userId the browser socket was opened with.');
          }
          owner = asked;
        }
        const stored = await saveUpload(
          owner,
          String(req.query.name || 'file'),
          body,
        );
        res.json({ success: true, ...stored });
      } catch (e) {
        if (e instanceof UploadError) return fail(res, 400, e.message);
        sendError(res, e);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Download shelf — the other half of "the remote browser is not my computer"
  //
  // When a page in the live view downloads a file, the bytes land on the
  // SERVER's disk. In real Chrome the shelf at the bottom of the window offers
  // the file; here it has to offer a URL, or a download is a file the user can
  // neither see nor reach. This is that URL.
  //
  // Same identity rule as /browser/uploads, and for the same reason: the shelf
  // rows are produced by the WebSocket session, which runs as the `userId` in
  // its own query string. Resolving the token under a different identity would
  // look in a directory the file was never written to.
  //
  // The token is opaque and server-minted (see core/RemoteDownloads): the path
  // is never exposed, the token pattern is checked, and containment is
  // re-checked after resolution — two independent guards, because the cost of
  // being wrong here is reading arbitrary files off the server.
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/downloads/:token', async (req: AuthenticatedRequest, res) => {
    try {
      const asked = String(req.query.userId || '').trim();
      let owner = resolveUserId(req);
      if (asked && asked !== owner) {
        const auth = await authorizeLive(apiKeyOf(req), asked);
        if (!auth.ok) {
          return fail(res, 403, 'This API key may not read downloads for that user.',
            'Use the same userId the browser socket was opened with.');
        }
        owner = asked;
      }
      const file = await resolveDownload(owner, String(req.params.token || ''));
      // `attachment` with the name the user actually saw on the shelf. Serving
      // it inline would let a downloaded .html run in this origin, which is a
      // stored-XSS hole with extra steps.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(file.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Built by a helper because a raw non-ASCII name here THROWS inside
      // res.setHeader and turns the download into a 500 — measured, and the
      // reported "Invalid character in header content" in full. See
      // contentDispositionAttachment in core/RemoteDownloads.
      res.setHeader('Content-Disposition', contentDispositionAttachment(file.name));
      res.sendFile(file.path);
    } catch (e) {
      if (e instanceof DownloadError) return fail(res, 404, e.message);
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Remote desktop
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/desktop/status', async (_req, res) => {
    try {
      res.json({ success: true, desktop: await Desktop.status() });
    } catch (e) { sendError(res, e); }
  });

  /**
   * Files the REAL Chromium has downloaded.
   *
   * The desktop shows the operator Chrome's own download shelf, but that shelf
   * points at paths on the SERVER's disk — clicking it opens a file manager the
   * operator cannot reach. This is the reachable half: each row carries the
   * token that `/browser/downloads/:token` serves, so the file arrives on the
   * operator's machine with the name it was given.
   *
   * `owner` is returned rather than assumed by the client. The real Chromium is
   * single-tenant so it is a constant today, but a client that hardcoded it
   * would silently fetch from the wrong directory the day that changes — the
   * exact ENOENT hand-over failure already documented on /browser/uploads.
   */
  router.get('/browser/real/downloads', async (_req, res) => {
    try {
      res.json({
        success: true,
        owner: RealChrome.downloadOwner(),
        downloads: RealChrome.downloads(),
      });
    } catch (e) { sendError(res, e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The file dialog handshake — «Windows کاربر → Backend/Server → Website»
  //
  // The operator presses a website's own "Choose file" INSIDE the remote
  // browser. Chromium hands that request to its automation client instead of
  // opening a native dialog (MEASURED even for a real X11 click — see
  // core/RemoteFileChooser), so the request waits on the server while the view
  // asks the operator's OWN machine for a file. Three endpoints:
  //
  //   GET    …/chooser   is a page asking for a file right now?
  //   POST   …/chooser   here are the uploads that answer it
  //   DELETE …/chooser   the operator cancelled; release the page
  //
  // The upload itself still goes through POST /browser/uploads, so there is
  // exactly ONE path that writes bytes onto this server and exactly one place
  // where its size cap and identity rule live.
  //
  // IDENTITY. The tokens were written by /browser/uploads under the id that
  // route resolved, and they are read here under RealChrome.downloadOwner().
  // Those must be the same id or the hand-over is a bare ENOENT — the failure
  // already documented on /browser/uploads as "Import still does nothing". The
  // real Chromium is single-tenant (see REAL_CHROME_SHELF_USER), which is what
  // makes them the same; the view is told the owner rather than assuming it, so
  // it uploads to the right place.
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/real/chooser', async (_req, res) => {
    try {
      res.json({
        success: true,
        owner: RealChrome.downloadOwner(),
        // null, not an error, when nothing is pending: the view polls this, and
        // "no dialog" is the ordinary answer, not a fault.
        chooser: RealChrome.pendingChooser(),
      });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/real/chooser', async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as { id?: unknown; tokens?: unknown };
      const id = String(body.id || '');
      // Strings only, and the chooser re-validates every one of them against the
      // token pattern before it resolves it. A path sent here resolves to
      // nothing rather than to a file: that is the whole point of tokens (see
      // core/RemoteUploads).
      const tokens = Array.isArray(body.tokens)
        ? body.tokens.filter((t): t is string => typeof t === 'string')
        : [];
      if (!id) {
        return fail(res, 400, 'Which file request is this answering?',
          'Send the id from GET /browser/real/chooser.');
      }
      if (!tokens.length) {
        return fail(res, 400, 'No uploads were named.',
          'Upload the file to POST /browser/uploads first, then send its token here.');
      }
      const done = await RealChrome.acceptChooserFiles(id, tokens);
      res.json({ success: true, ...done });
    } catch (e) { sendError(res, e); }
  });

  router.delete('/browser/real/chooser', async (req: AuthenticatedRequest, res) => {
    try {
      // An id is optional: cancelling "whatever is pending" is what the view
      // needs when the operator closed their own picker without choosing, and a
      // dialog left open blocks the page that opened it.
      const cancelled = await RealChrome.cancelChooser(String(req.query.id || ''));
      res.json({ success: true, cancelled });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/desktop/start', async (_req, res) => {
    try {
      res.json({ success: true, desktop: await Desktop.start() });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/desktop/stop', async (_req, res) => {
    try {
      await Desktop.stop();
      res.json({ success: true, desktop: await Desktop.status() });
    } catch (e) { sendError(res, e); }
  });

  /**
   * ONE call that hands back a usable real browser.
   *
   * WHY THIS EXISTS
   * ---------------
   * Everything needed to use the REAL Chrome already existed — Desktop.start(),
   * RealChrome.getContext(), the noVNC client — but the operator had to know to
   * do all three in the right order, and the crosshair button opened the
   * SIMULATED canvas instead. The user's verdict on that simulation, after
   * weeks of bugs in it: "به جای مرورگر شبیه سازی شده مرورگر واقعی … رو ریموت
   * کن تا هر کاری نیاز بود اونجا همه چیز اماده هست" — extensions install
   * normally, tabs are never lost, because it is just Chrome.
   *
   * So: start the screen, start Chrome on it, optionally open the URL the
   * operator is working on, and return the single link that shows it. Anything
   * already running is left alone (both calls are idempotent), which is what
   * makes this safe to call from a button the user may double-click.
   *
   * The returned path is RELATIVE and goes through this app's own port — see
   * DesktopProxy for why a :6080 URL is unusable behind a single published
   * port.
   */
  router.post('/browser/real/open', async (req, res) => {
    try {
      const desktop = await Desktop.start();

      // A WEDGED browser must not be handed back as if it were healthy.
      //
      //   «هنگ کرد و بعدش دیگه فریز شد منم بستم مجدد باز کنم کلا نرفت به اون
      //    ادرس»
      //
      // getContext() returns the existing context whenever `this.context` is
      // non-null, and a frozen Chromium does not close its context — so
      // reopening the view used to return the same dead browser, and the button
      // "went nowhere". Checking BEFORE reuse is what turns that dead end into a
      // recovery. It costs one round trip on an already-running browser and
      // nothing at all on a cold start.
      const recovery = RealChrome.isRunning()
        ? await RealChrome.recycleIfWedged()
        : { action: 'not-running' as const, reason: 'cold start' };

      // The screen must exist before Chrome starts: extensions only load in a
      // HEADED browser, and a headed browser needs an X display.
      const ctx = await RealChrome.getContext();

      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (url) {
        const page = await RealChrome.newPage();
        // Do not await the load: a slow site must not stall the button, and
        // the operator can watch it load on the desktop they are about to see.
        void page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => { /* visible on screen */ });
      }

      res.json({
        success: true,
        desktop,
        // The BARE Chromium view, not noVNC's own vnc.html. That file is the
        // whole noVNC application (measured: 64 UI elements, a connect dialog,
        // a control bar), so it handed the operator a VNC client to operate
        // when all they asked for was the browser. See ChromeView.ts.
        //
        // Relative on purpose: the client prefixes its own origin, so this
        // works on localhost, behind a proxy, and on a sandbox subdomain alike.
        viewPath: '/desktop/chrome',
        realChrome: await RealChrome.status(),
        tabs: ctx ? await RealChrome.tabs() : [],
        // Say it out loud when a browser was recycled. The operator's tabs come
        // back (REAL_CHROME_RESTORE_TABS), but a silent relaunch is how "all my
        // tabs are gone" became a mystery in the first place.
        recovered: recovery.action === 'recycled',
        recovery,
      });
    } catch (e) { sendError(res, e); }
  });

  /**
   * Is the real browser actually answering, and recycle it if not.
   *
   * WHY THIS IS A ROUTE. §3.2 of the handoff: the operator's Chromium froze,
   * and the only recovery they had was to close it by hand — which is what lost
   * the tabs. `GET` reports, `POST` acts, so a caller can look before it leaps.
   *
   * The recycle preserves the profile and, with REAL_CHROME_RESTORE_TABS on,
   * reopens the same tabs (MEASURED 3 of 3 in
   * tools/probe-realchrome-restore-live.js), which is the difference between
   * recovery and the data loss that was reported.
   */
  router.get('/browser/real/health', async (_req, res) => {
    try {
      res.json({
        success: true,
        enabled: RealChrome.isEnabled(),
        running: RealChrome.isRunning(),
        // The two are NOT the same thing, and that gap IS the bug: a frozen
        // Chromium keeps `running` true while answering nothing.
        responsive: await RealChrome.isResponsive(),
      });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/real/recover', async (_req, res) => {
    try {
      const recovery = await RealChrome.recycleIfWedged();
      res.json({
        success: true,
        recovery,
        running: RealChrome.isRunning(),
        tabs: await RealChrome.tabs(),
      });
    } catch (e) { sendError(res, e); }
  });

  /**
   * The launch-flag catalogue, and which flags are selected.
   *
   * WHY THIS IS A ROUTE. The operator's complaint: «به جای اینکه من بخوام دونه
   * دونه سرچ کنم تگ‌ها رو پیدا کنم» — instead of searching for switches one by
   * one, hand the UI the whole list with descriptions so it can render a form.
   *
   * The catalogue is served rather than duplicated in the front-end on purpose.
   * A copy in `public/js` would drift from the flags Chrome is really given, and
   * a settings screen that lies about the running configuration is worse than no
   * settings screen at all.
   */
  router.get('/browser/real/flags', (_req, res) => {
    try {
      const active = RealChrome.activeFlags();
      const selected = RealChrome.currentFlagChoice();
      res.json({
        success: true,
        ...flagCatalogue(),
        selected,
        active,
        // Whether the running browser is actually using the saved selection.
        // Reported as an OBSERVATION, not as a chore for the operator: POSTing a
        // selection applies it, so this can only be false transiently (for
        // instance if a heal failed) and the UI shows it as a state, never as an
        // instruction to go and restart something.
        inSync: active === null || active.ids.join(',') === selected.ids.join(','),
        // Kept for API compatibility, and always false: nothing is left for the
        // caller to restart. See the guard in tests/unit/self-heal.test.ts.
        restartRequired: false,
      });
    } catch (e) { sendError(res, e); }
  });

  /**
   * Choose the launch flags — and APPLY them, here, now.
   *
   * Returns the RESOLVED selection, including `unknown` ids that matched nothing
   * and `forced` ids that cannot be switched off. Both are reported instead of
   * being quietly dropped: a flag the operator believes they set and the browser
   * never received is the exact failure mode that cost this project days on the
   * tab-restore hunt.
   *
   * ── WHY THIS RELAUNCHES INSTEAD OF SAYING "RESTART TO APPLY" ──────────────
   *
   * The first version of this route saved the choice and answered
   * `restartRequired: true`. That was true and still a defect, and this codebase
   * had already learnt the lesson once, for extensions: the rule recorded in
   * SelfHeal.ts is «never ask the user to do something we could have done», and
   * tests/unit/self-heal.test.ts fails the build if a route asks again. It
   * caught me.
   *
   * Chrome reading its switches only at startup is a real constraint. The
   * conclusion that the OPERATOR must therefore press a button was not: the
   * server can relaunch, it knows exactly when the selection changed, and
   * `swapLiveSessions` rebuilds the live tabs across the swap — so applying
   * flags no longer costs the tabs, which is the same defect §3.2 was about.
   *
   * A browser that is not running is left alone: there is nothing to relaunch,
   * and starting one the operator never asked for would be a surprise, not a
   * courtesy.
   */
  router.post('/browser/real/flags', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        preset?: unknown;
        flags?: unknown;
        overrides?: unknown;
      };
      const flags = Array.isArray(body.flags)
        ? body.flags.filter((f): f is string => typeof f === 'string')
        : undefined;
      const overrides: Record<string, boolean> = {};
      if (body.overrides && typeof body.overrides === 'object') {
        for (const [k, v] of Object.entries(body.overrides as Record<string, unknown>)) {
          if (typeof v === 'boolean') overrides[k] = v;
        }
      }

      const before = RealChrome.activeFlags();
      const resolved = RealChrome.setFlagChoice({
        preset: typeof body.preset === 'string' ? body.preset : undefined,
        flags,
        overrides,
      });

      // Only relaunch when the switches genuinely changed. Restarting a browser
      // to apply an identical selection would throw away the operator's page for
      // no reason at all.
      const changed = before !== null && before.ids.join(',') !== resolved.ids.join(',');
      const shouldApply = changed && RealChrome.isRunning();

      if (!shouldApply) {
        return res.json({
          success: true,
          selected: resolved,
          applied: false,
          // Nothing changed, or there is no browser to change: either way the
          // next start uses this selection and nobody has to do anything.
          reason: changed ? 'not running' : 'no change',
          restartRequired: false,
        });
      }

      const { steps, report } = healCollector();
      const healed = await SelfHeal.reloadExtensions(report, swapLiveSessions);
      res.json({
        success: true,
        selected: resolved,
        applied: !!healed.ok,
        steps,
        realChrome: healed.realChrome,
        restartRequired: false,
        ...(healed.ok ? {} : {
          // Self-healing is not the same as pretending: when the relaunch really
          // failed, say so and name the cause.
          problem: healed.problem,
          ...(healed.hint ? { hint: healed.hint } : {}),
        }),
      });
    } catch (e) { sendError(res, e); }
  });

  /**
   * Which environment profile is active, and what it decided.
   *
   * WHY THIS IS A ROUTE. The complaint ends «کاربر گیج نمونه توی محیط توسعه» —
   * the user must not end up confused. Showing a resolved value alone would move
   * the confusion instead of removing it: `headless: false` does not say whether
   * the operator chose it or a profile did. Every row therefore carries its
   * provenance, and `overridden` marks the rows where an explicit value beat the
   * profile — so "you set this" and "development set this for you" never look
   * alike.
   */
  router.get('/config/profile', (_req, res) => {
    try {
      res.json({
        success: true,
        ...describeProfile(process.env),
        profiles: PROFILES,
      });
    } catch (e) { sendError(res, e); }
  });

  return router;
};
