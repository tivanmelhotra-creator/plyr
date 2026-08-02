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
import { Desktop, DesktopError } from '../core/Desktop';
import {
  installExtensionArchive,
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
import { SINGLE_USER_ID, type AuthenticatedRequest } from '../middleware/auth';

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

function fail(res: Response, status: number, error: string, hint = ''): void {
  res.status(status).json({ success: false, error, ...(hint ? { hint } : {}) });
}

/** Map our typed errors onto sensible HTTP codes instead of a blanket 500. */
function sendError(res: Response, e: unknown): void {
  if (e instanceof CookieImportError || e instanceof ExtensionError) {
    return fail(res, 400, e.message);
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
      res.json({ success: true, realChrome, desktop });
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
      return fail(
        res, 409,
        'Real Chrome is disabled.',
        'Set REAL_CHROME_ENABLED=true in .env and restart the server.',
      );
    }
    try {
      if (!config.REAL_CHROME_HEADLESS) {
        const desktop = await Desktop.status();
        if (!desktop.running && desktop.missing.length === 0) {
          await Desktop.start().catch(() => { /* reported by RealChrome below */ });
        }
      }
      await RealChrome.getContext();
      res.json({ success: true, realChrome: await RealChrome.status() });
    } catch (e) { sendError(res, e); }
  });

  router.post('/browser/stop', async (_req, res) => {
    try {
      await RealChrome.stop();
      res.json({ success: true, realChrome: await RealChrome.status() });
    } catch (e) { sendError(res, e); }
  });

  /** The only way to load newly uploaded extensions: Chrome reads them at launch. */
  router.post('/browser/restart', async (_req, res) => {
    try {
      res.json({ success: true, realChrome: await RealChrome.restart() });
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
        res.json({
          success: true,
          extension: ext,
          restartRequired: RealChrome.isRunning(),
          message: RealChrome.isRunning()
            ? 'Installed. Restart the browser to load it — Chrome only reads extensions at launch.'
            : 'Installed. It will load the next time the browser starts.',
        });
      } catch (e) { sendError(res, e); }
    },
  );

  router.delete('/browser/extensions/:id', async (req, res) => {
    try {
      const removed = await removeExtension(config.REAL_CHROME_EXTENSIONS_DIR, req.params.id);
      if (!removed) return fail(res, 404, 'No such extension.');
      res.json({ success: true, restartRequired: RealChrome.isRunning() });
    } catch (e) { sendError(res, e); }
  });

  /**
   * The chrome-extension:// URL to open for an extension.
   *
   * The picker canvas can navigate to this and render the extension's own popup
   * UI, with full extension privileges — which is how you drive a cookie
   * extension without a remote desktop.
   */
  router.get('/browser/extensions/:id/url', (req, res) => {
    const url = RealChrome.extensionPageUrl(req.params.id);
    if (!url) {
      return fail(
        res, 404,
        'That extension is not loaded in the running browser.',
        'Upload it, then POST /browser/restart.',
      );
    }
    res.json({ success: true, url });
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
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="cookies-${domainFilter || 'all'}.json"`,
      );
      res.send(JSON.stringify(out, null, 2));
    } catch (e) { sendError(res, e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Remote desktop
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/browser/desktop/status', async (_req, res) => {
    try {
      res.json({ success: true, desktop: await Desktop.status() });
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

  return router;
};
