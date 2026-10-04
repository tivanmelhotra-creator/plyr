/**
 * ExtensionPagePicker — let the Element Inspector pick elements on the page of
 * ANOTHER extension (an extension opened with "Open here", e.g. a cookie
 * extension's popup rendered as a tab).
 *
 * THE REPORTED ERROR
 * ------------------
 *   «Cannot inspect this page (browser-internal pages are off limits).»
 *
 * WHY THE EXTENSION CANNOT DO THIS ITSELF — measured, not assumed.
 * Against Chromium 141 with both extensions loaded:
 *
 *   chrome.scripting.executeScript on chrome-extension://<other>/popup.html
 *     no flag ........................ "Cannot access a chrome-extension:// URL
 *                                       of different extension"
 *     --extensions-on-chrome-urls ..... the message changes to "manifest must
 *                                       request permission to access this host"
 *   and adding `chrome-extension://*\/*` to host_permissions is silently
 *   dropped: chrome.permissions.getAll() lists chrome://*\/* (with the flag)
 *   but never chrome-extension://*\/*. Chrome offers no way for one extension
 *   to script another's pages. Content scripts cannot match that scheme either.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The server owns this browser and already drives it through CDP, which CAN
 * evaluate script inside an extension page. So the server injects the SAME
 * picker (lib/ab-inspect.js + content/selector.js + content/inspector.js) into
 * that page. Only the transport differs: where the content script would call
 * chrome.runtime.sendMessage, a shim hands the message to the server, which
 * passes it on to submitElement() inside OUR extension's service worker.
 *
 * That last hop is the point. The extension remains the single authority on
 * which Target Field this browser is bound to and which credential it sends
 * with; the server never learns a pairing key and never submits on its own. A
 * pick therefore passes exactly the checks a pick on an ordinary site does.
 *
 * SAFETY OF THE PAGE BEING INSPECTED
 * ----------------------------------
 * The picker runs in the page's main world, and an extension page has a real
 * `chrome` object of its own (cookies, downloads...). The bundle is therefore
 * wrapped so that ONLY the picker sees the shim: `chrome` and `window.chrome`
 * resolve to the shim inside the wrapper, while the extension's own scripts
 * keep their real API untouched.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { BrowserContext, Page, Worker } from 'playwright';

/** The picker's files, in the manifest's order: core and selectors before the UI. */
export const PICKER_FILES = ['lib/ab-inspect.js', 'content/selector.js', 'content/inspector.js'];

/** manifest.json "name" of the project's own extension; how its worker is recognised. */
export const INSPECTOR_MANIFEST_NAME = 'Automation Backend Helper';

/** The one message type the bridge forwards. Anything else is refused. */
export const SUBMIT_TYPE = 'ab-inspector-submit';

export class ExtensionPickerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ExtensionPickerError';
  }
}

/**
 * The source the page evaluates: the picker files inside a wrapper that
 * substitutes `chrome` / `window.chrome` for the picker only.
 *
 * `bridge` is the NAME of the page-level binding the shim calls.
 */
export function wrapPickerSource(files: string[], bridge: string): string {
  const shim = `
    var __ab_listeners = [];
    var __ab_shim = {
      runtime: {
        lastError: undefined,
        // No getURL on purpose: the picker uses it only to load fonts from the
        // extension, and a missing function makes it skip that step cleanly.
        sendMessage: function (msg, cb) {
          var done = typeof cb === 'function' ? cb : function () {};
          window[${JSON.stringify(bridge)}](msg).then(function (res) {
            __ab_shim.runtime.lastError = undefined;
            done(res);
          }, function (err) {
            __ab_shim.runtime.lastError = { message: String((err && err.message) || err) };
            try { done(undefined); } finally { __ab_shim.runtime.lastError = undefined; }
          });
        },
        onMessage: { addListener: function (fn) { __ab_listeners.push(fn); } }
      },
      // The picker caches its last pick here; there is nothing to cache into.
      storage: { local: { set: function () {} } }
    };
    var __ab_real = window;
    var __ab_window = new Proxy(__ab_real, {
      get: function (t, k) {
        if (k === 'chrome') return __ab_shim;
        var v = Reflect.get(t, k, t);
        // Methods need the real window as \`this\`; constructors (FontFace,
        // MutationObserver...) are left alone so \`new\` keeps working.
        return typeof v === 'function' && !/^[A-Z]/.test(String(k)) ? v.bind(t) : v;
      },
      set: function (t, k, v) { t[k] = v; return true; },
      has: function (t, k) { return k in t; }
    });
  `;
  const body = files.map((src) => `(function (window, chrome) {\n${src}\n}).call(__ab_real, __ab_window, __ab_shim);`).join('\n');
  return `(function () {\n${shim}\n${body}\n})();`;
}

/** Read the picker's files from the authored extension directory. */
export async function readPickerFiles(srcDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of PICKER_FILES) {
    try {
      out.push(await fs.readFile(path.join(srcDir, rel), 'utf8'));
    } catch (e) {
      throw new ExtensionPickerError(
        `The Inspector's own files could not be read (${rel}): ${(e as Error).message}`,
        'picker_files_missing',
      );
    }
  }
  return out;
}

/** What the page may ask the server to do. Everything else is dropped. */
export function sanitizeSubmit(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== SUBMIT_TYPE) return null;
  if (!m.element || typeof m.element !== 'object') return null;
  return {
    type: SUBMIT_TYPE,
    element: m.element,
    displayAttributes: Array.isArray(m.displayAttributes) ? m.displayAttributes.slice(0, 60) : [],
    sendAttribute: m.sendAttribute && typeof m.sendAttribute === 'object' ? m.sendAttribute : null,
  };
}

/** Find OUR extension's service worker among the context's workers. */
export async function findInspectorWorker(ctx: BrowserContext): Promise<Worker | null> {
  for (const w of ctx.serviceWorkers()) {
    let url = '';
    try { url = w.url(); } catch { continue; }
    if (!url.startsWith('chrome-extension://')) continue;
    try {
      const ok = await w.evaluate(
        (name) => {
          const c = (globalThis as unknown as {
            chrome?: { runtime?: { getManifest?: () => { name?: string } } };
            submitElement?: unknown;
          });
          return c.chrome?.runtime?.getManifest?.().name === name && typeof c.submitElement === 'function';
        },
        INSPECTOR_MANIFEST_NAME,
      );
      if (ok) return w;
    } catch { /* a worker that died mid-iteration is not ours */ }
  }
  return null;
}

/** Pages already wired to a bridge, so a second arm does not register it twice. */
const wired = new WeakMap<Page, string>();

export interface ArmResult { ok: true; url: string; }

/**
 * Inject the picker into `page` and start it.
 *
 * Idempotent per page load: the bridge is registered once, and the picker is
 * injected only if this load of the page does not have it yet.
 */
export async function armPickerOnPage(
  ctx: BrowserContext,
  page: Page,
  srcDir: string,
): Promise<ArmResult> {
  const url = page.url();
  if (!/^chrome-extension:\/\//i.test(url)) {
    throw new ExtensionPickerError('That tab is not an extension page.', 'not_extension_page');
  }
  const worker = await findInspectorWorker(ctx);
  if (!worker) {
    throw new ExtensionPickerError(
      'The Inspector extension is not running in this browser, so there is nothing to send a pick to.',
      'inspector_not_running',
    );
  }

  let bridge = wired.get(page);
  if (!bridge) {
    bridge = `__ab_bridge_${randomBytes(6).toString('hex')}`;
    await page.exposeFunction(bridge, async (raw: unknown) => {
      const msg = sanitizeSubmit(raw);
      if (!msg) return { ok: false, error: 'unsupported_message' };
      const w = (await findInspectorWorker(ctx)) || worker;
      // The extension decides everything from here: the bound field, the
      // credential, the refusal wording. Its answer goes back untouched.
      return w.evaluate(
        (payload) => (globalThis as unknown as { submitElement: (p: unknown) => Promise<unknown> })
          .submitElement(payload),
        msg,
      );
    });
    wired.set(page, bridge);
  }

  const armed = await page.evaluate(() => !!(window as unknown as { ABInspector?: unknown }).ABInspector);
  if (!armed) {
    const source = wrapPickerSource(await readPickerFiles(srcDir), bridge);
    await page.evaluate(source);
  }
  const started = await page.evaluate(() => {
    const api = (window as unknown as { ABInspector?: { start: () => void } }).ABInspector;
    if (!api) return false;
    api.start();
    return true;
  });
  if (!started) {
    throw new ExtensionPickerError('The picker could not be started on that page.', 'start_failed');
  }
  await page.bringToFront().catch(() => {});
  return { ok: true, url };
}

/** Stop the picker on `page` if it is running. Never throws. */
export async function disarmPickerOnPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as { ABInspector?: { stop: () => void } }).ABInspector;
    if (api) api.stop();
  }).catch(() => {});
}
