/**
 * ExtensionPagePicker — the Inspector on another extension's page.
 *
 * Chrome will not let one extension script another's pages (measured; see the
 * module header), so the server injects the picker through CDP and forwards a
 * pick to the Inspector extension's own submitElement(). These tests pin the
 * parts that must not drift: the shim only the picker sees, the one message the
 * bridge forwards, and the refusal paths. No browser is launched.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import vm from 'vm';
import {
  ExtensionPickerError,
  INSPECTOR_MANIFEST_NAME,
  PICKER_FILES,
  SUBMIT_TYPE,
  armPickerOnPage,
  findInspectorWorker,
  sanitizeSubmit,
  wrapPickerSource,
} from '../../src/core/ExtensionPagePicker';

describe('sanitizeSubmit', () => {
  const good = { type: SUBMIT_TYPE, element: { tag: 'button' }, displayAttributes: ['id'], sendAttribute: { name: 'id', value: 'x' } };

  it('keeps the submit message and nothing else', () => {
    const out = sanitizeSubmit({ ...good, evil: 'rm -rf', extra: { a: 1 } });
    expect(out).toEqual(good);
  });

  it('drops every other message type and malformed input', () => {
    expect(sanitizeSubmit({ ...good, type: 'AB_INSPECTOR_PAIR' })).toBeNull();
    expect(sanitizeSubmit({ type: SUBMIT_TYPE })).toBeNull();
    expect(sanitizeSubmit(null)).toBeNull();
    expect(sanitizeSubmit('ab-inspector-submit')).toBeNull();
  });

  it('caps displayAttributes and ignores a non-array', () => {
    expect((sanitizeSubmit({ ...good, displayAttributes: new Array(500).fill('a') })!.displayAttributes as unknown[]).length).toBe(60);
    expect(sanitizeSubmit({ ...good, displayAttributes: 'id' })!.displayAttributes).toEqual([]);
  });
});

describe('wrapPickerSource', () => {
  /** Run the wrapped source against a fake window, the way the page would. */
  function run(files: string[], realChrome: unknown, bridge: (m: unknown) => Promise<unknown>) {
    const win: Record<string, unknown> = {
      chrome: realChrome,
      __ab_bridge_t: bridge,
      addEventListener() {},
    };
    const ctx = vm.createContext({ window: win, Reflect, Proxy, String, Promise, console });
    vm.runInContext(wrapPickerSource(files, '__ab_bridge_t'), ctx);
    return win;
  }

  it('gives the picker a shim and leaves the page its own chrome', () => {
    const real = { runtime: { id: 'REAL' }, cookies: {} };
    const seen: Record<string, unknown> = {};
    const win = run([
      `window.__seen = { id: window.chrome.runtime.id, hasCookies: !!window.chrome.cookies, bare: typeof chrome.runtime.sendMessage };`,
    ], real, async () => ({ ok: true }));
    Object.assign(seen, win.__seen as object);
    // The picker saw the SHIM (no id, no cookies, but a sendMessage)...
    expect(seen).toEqual({ id: undefined, hasCookies: false, bare: 'function' });
    // ...while the page's own object was never replaced.
    expect(win.chrome).toBe(real);
  });

  it('routes sendMessage to the bridge and reports a failure through lastError', async () => {
    const calls: unknown[] = [];
    const win = run([
      `window.__out = [];
       chrome.runtime.sendMessage({ type: 'ab-inspector-submit', n: 1 }, function (res) { window.__out.push(['ok', res]); });
       chrome.runtime.sendMessage({ type: 'ab-inspector-submit', n: 2 }, function (res) { window.__out.push(['err', res, chrome.runtime.lastError && chrome.runtime.lastError.message]); });`,
    ], {}, async (m: unknown) => {
      calls.push(m);
      if ((m as { n: number }).n === 2) throw new Error('boom');
      return { ok: true, field: 'Selector' };
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2);
    expect(win.__out).toEqual([['ok', { ok: true, field: 'Selector' }], ['err', undefined, 'boom']]);
  });

  it('has no getURL, so the picker skips loading fonts from the extension', () => {
    const win = run([`window.__u = typeof chrome.runtime.getURL;`], {}, async () => ({}));
    expect(win.__u).toBe('undefined');
  });

  it('wraps every picker file, in manifest order', () => {
    expect(PICKER_FILES).toEqual(['lib/ab-inspect.js', 'content/selector.js', 'content/inspector.js']);
    const src = wrapPickerSource(['/*A*/', '/*B*/', '/*C*/'], 'b');
    expect(src.indexOf('/*A*/')).toBeLessThan(src.indexOf('/*B*/'));
    expect(src.indexOf('/*B*/')).toBeLessThan(src.indexOf('/*C*/'));
  });
});

/* ---- fakes for the Playwright surface the module uses -------------------- */

function fakeWorker(name = INSPECTOR_MANIFEST_NAME, hasSubmit = true) {
  const received: unknown[] = [];
  return {
    received,
    url: () => 'chrome-extension://abc/background.js',
    // Stands in for the in-worker probe and the submitElement call.
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (arg === INSPECTOR_MANIFEST_NAME) return name === INSPECTOR_MANIFEST_NAME && hasSubmit;
      received.push(arg);
      return { ok: true, field: 'Selector' };
    },
  };
}

function fakePage(url: string) {
  const exposed: Record<string, (raw: unknown) => Promise<unknown>> = {};
  let injected = 0;
  return {
    exposed,
    get injected() { return injected; },
    url: () => url,
    exposeFunction: async (n: string, fn: (raw: unknown) => Promise<unknown>) => { exposed[n] = fn; },
    bringToFront: async () => {},
    evaluate: async (arg: unknown) => {
      if (typeof arg === 'string') { injected += 1; return undefined; }
      const src = String(arg);
      if (src.includes('start()')) return true;       // api.start(); return true
      return injected > 0;                              // the "already armed?" probe
    },
  };
}

describe('findInspectorWorker', () => {
  it('finds the project extension by manifest name and skips others', async () => {
    const other = fakeWorker('Some Cookie Tool');
    const ours = fakeWorker();
    const ctx = { serviceWorkers: () => [other, ours] };
    expect(await findInspectorWorker(ctx as never)).toBe(ours);
    expect(await findInspectorWorker({ serviceWorkers: () => [other] } as never)).toBeNull();
  });

  it('ignores a website worker', async () => {
    const w = { ...fakeWorker(), url: () => 'https://example.com/sw.js' };
    expect(await findInspectorWorker({ serviceWorkers: () => [w] } as never)).toBeNull();
  });
});

describe('armPickerOnPage', () => {
  // The repo's real extension/ directory. Vitest runs from the repo root, the
  // same assumption the file reads at the bottom of this suite already make.
  const SRC = path.resolve(process.cwd(), 'extension');

  it('refuses a page that is not an extension page', async () => {
    const ctx = { serviceWorkers: () => [fakeWorker()] };
    await expect(armPickerOnPage(ctx as never, fakePage('https://example.com/') as never, SRC))
      .rejects.toMatchObject({ code: 'not_extension_page' });
  });

  it('refuses when the Inspector extension is not running', async () => {
    const ctx = { serviceWorkers: () => [] };
    await expect(armPickerOnPage(ctx as never, fakePage('chrome-extension://zzz/popup.html') as never, SRC))
      .rejects.toBeInstanceOf(ExtensionPickerError);
  });

  it('injects once, starts the picker, and forwards only a sanitised pick to the worker', async () => {
    const worker = fakeWorker();
    const ctx = { serviceWorkers: () => [worker] };
    const page = fakePage('chrome-extension://zzz/popup.html');

    const r = await armPickerOnPage(ctx as never, page as never, SRC);
    expect(r.url).toBe('chrome-extension://zzz/popup.html');
    expect(page.injected).toBe(1);

    // A second arm on the same load neither re-injects nor re-registers the bridge.
    await armPickerOnPage(ctx as never, page as never, SRC);
    expect(page.injected).toBe(1);
    expect(Object.keys(page.exposed)).toHaveLength(1);

    const bridge = Object.values(page.exposed)[0];
    // Anything but the submit message is refused without touching the worker.
    expect(await bridge({ type: 'AB_INSPECTOR_PAIR', code: '123' })).toEqual({ ok: false, error: 'unsupported_message' });
    expect(worker.received).toHaveLength(0);

    const res = await bridge({ type: SUBMIT_TYPE, element: { tag: 'button' }, sendAttribute: { name: 'id', value: 'x' }, extra: 1 });
    expect(res).toEqual({ ok: true, field: 'Selector' });
    expect(worker.received).toEqual([{
      type: SUBMIT_TYPE, element: { tag: 'button' }, displayAttributes: [], sendAttribute: { name: 'id', value: 'x' },
    }]);
  });
});

describe('the extension side of the hand-off', () => {
  const fs = require('fs') as typeof import('fs');
  const bg = fs.readFileSync('extension/background.js', 'utf8');
  const popup = fs.readFileSync('extension/popup/popup.js', 'utf8');

  it('asks the server, not Chrome, when the active tab is another extension\'s page', () => {
    expect(bg).toContain('isOtherExtensionPage(tab.url)');
    expect(bg).toContain('/browser/inspector/extension-page');
    // The branch must come BEFORE the scripting attempt that Chrome refuses.
    expect(bg.indexOf('isOtherExtensionPage(tab.url)')).toBeLessThan(bg.indexOf("files: ['lib/ab-inspect.js'"));
  });

  it('shows the server\'s sentence instead of "browser-internal pages are off limits"', () => {
    expect(popup).toContain("err.indexOf('extension_page_') === 0");
  });
});
