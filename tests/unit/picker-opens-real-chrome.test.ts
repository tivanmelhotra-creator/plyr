/**
 * The crosshair must open the REAL Chromium, not the canvas simulator.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The operator asked for the simulator to be gone, and specifically for the
 * crosshair itself to be what brings up the remote browser:
 *
 *   «من گفتم کلا شبیه ساز رو حذف کن و به جاش وقتی روی ایکن هدف گیری یا پیکره
 *    چیه همون کلیک میشه باید به جای شبیه ساز یه تب جدید خود جوش باز بشه رو
 *    مرورگرم و کرومیوم ریموت رو بالا بیاره»
 *
 * A previous round satisfied the letter of that by adding a button INSIDE the
 * simulator, which is not what was asked. These tests pin the behaviour so it
 * cannot quietly slide back.
 *
 * HOW THEY TEST IT
 * ----------------
 * browser-view.js is a browser IIFE that touches `window`, `document` and
 * `WebSocket` at load, and this repo deliberately has no jsdom (vitest runs
 * `environment: 'node'`; see the note in ab-core.test.ts). So rather than
 * import it, each test EXECUTES the one function under test in isolation with
 * fakes for the handful of globals it uses, and asserts on what that function
 * DID — which tab it opened, which endpoint it called, where it navigated.
 * That is behaviour, not a grep for a string in the source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'public/js/browser-view.js'), 'utf8');

/** Cut one top-level `function name(...) { ... }` out of the file by brace depth. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * Return the BODY of the click handler registered for `q('<id>')`.
 *
 * An earlier version of this file matched the handler with a regex carrying a
 * `{0,200}` character budget. That is brittle for a reason worth naming: it
 * silently stops matching as soon as anyone adds a comment or a line to the
 * handler, and the resulting failure ("expected null not to be null") points at
 * the test rather than at the code. Scanning braces instead makes the helper
 * indifferent to length and formatting.
 */
function extractClickHandlerBody(src: string, id: string): string {
  const anchor = `q('${id}').addEventListener('click'`;
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`no click handler registered for ${id}`);
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error(`click handler for ${id} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in the ${id} click handler`);
}

/**
 * The functions `openRealBrowser` depends on, in the order they must be defined.
 *
 * WHY THIS LIST EXISTS. The harness used to inject `openRealBrowser` alone, and
 * when the blank-tab placeholder was added the sandbox started throwing
 * `ReferenceError: tabPlaceholder is not defined` — eleven tests failing on a
 * missing fake rather than on the behaviour they describe. A single list keeps
 * the harness honest: add a dependency to the source and it is declared here,
 * not discovered by a confusing failure.
 */
const OPEN_REAL_BROWSER_DEPS = ['tabPlaceholder', 'directViewHref'] as const;

function openRealBrowserSource(): string {
  return [
    ...OPEN_REAL_BROWSER_DEPS.map((n) => extractFunction(SRC, n)),
    extractFunction(SRC, 'openRealBrowser'),
  ].join('\n');
}

type Recorder = {
  opened: Array<{ url: string; target: string }>;
  navigated: string[];
  closed: number;
  posted: Array<{ path: string; body: unknown }>;
  toasts: string[];
  /** Every document.write() the placeholder performed into the new tab. */
  wrote: string[];
  /** What was put in the `.e` error slot, via textContent (never markup). */
  errors: string[];
  /** href set on the self-service links, keyed by element id. */
  links: Record<string, string>;
  /** Interleaved trace: 'write' / 'post' / 'navigate' / 'close'. */
  order: string[];
};

/**
 * A document just real enough for `tabPlaceholder`.
 *
 * It is not a DOM: it records the written markup and exposes only the two
 * lookups the placeholder performs (`.e` for the error text, `#direct` /
 * `#again` for the self-service links). Anything richer would be fidelity we do
 * not need and cannot verify.
 */
function fakeTabDocument(rec: Recorder) {
  const slots: Record<string, { setAttribute(n: string, v: string): void }> = {};
  return {
    open() { /* starts a new document */ },
    write(html: string) {
      rec.wrote.push(html);
      rec.order.push('write');
    },
    close() { /* ends it */ },
    querySelector(sel: string) {
      if (sel !== '.e') return null;
      // Only present on the failure page, which is the page that has an error.
      if (!/class="e"/.test(rec.wrote[rec.wrote.length - 1] || '')) return null;
      return { set textContent(v: string) { rec.errors.push(v); } };
    },
    getElementById(id: string) {
      const last = rec.wrote[rec.wrote.length - 1] || '';
      if (!new RegExp(`id="${id}"`).test(last)) return null;
      if (!slots[id]) {
        slots[id] = {
          setAttribute(name: string, value: string) {
            if (name === 'href') rec.links[id] = value;
          },
        };
      }
      return slots[id];
    },
  };
}

function newRecorder(): Recorder {
  return {
    opened: [], navigated: [], closed: 0, posted: [], toasts: [],
    wrote: [], errors: [], links: {}, order: [],
  };
}

/** The fakes `openRealBrowser` runs against, wired to one recorder. */
function sandboxFor(
  rec: Recorder,
  postResult: { ok: true; viewPath: string } | { ok: false; error: string },
) {
  const fakeTab = {
    document: fakeTabDocument(rec),
    set location(href: string) { rec.navigated.push(href); rec.order.push('navigate'); },
    close() { rec.closed++; rec.order.push('close'); },
  };

  return {
    window: {
      open(url: string, target: string) {
        rec.opened.push({ url, target });
        rec.order.push('open');
        return fakeTab;
      },
    },
    API: {
      getKey: () => 'THE-KEY',
      post: (path: string, body: unknown) => {
        rec.posted.push({ path, body });
        rec.order.push('post');
        return postResult.ok
          ? Promise.resolve({ success: true, viewPath: postResult.viewPath })
          : Promise.resolve({ success: false, error: postResult.error });
      },
    },
    t: (k: string) => k,
    toast: (m: string) => { rec.toasts.push(m); },
  };
}

/**
 * Run `requestPick` (and the `openRealBrowser` it delegates to) against fakes,
 * and report everything they did.
 *
 * `postResult` lets a test choose whether the server call succeeds or fails.
 */
async function runRequestPick(
  opts: unknown,
  postResult: { ok: true; viewPath: string } | { ok: false; error: string },
): Promise<Recorder> {
  const rec = newRecorder();
  const sandbox = sandboxFor(rec, postResult);

  const body = `
    ${openRealBrowserSource()}
    ${extractFunction(SRC, 'requestPick')}
    return requestPick(function () {}, OPTS);
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('window', 'API', 't', 'toast', 'OPTS', body);
  try {
    await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, opts);
  } catch { /* the failure path rethrows on purpose; the recorder is what matters */ }
  // Let the promise chain settle.
  await new Promise((r) => setTimeout(r, 0));
  return rec;
}

describe('clicking the crosshair', () => {
  it('opens a new tab', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.opened.length).toBe(1);
    expect(rec.opened[0].target).toBe('_blank');
  });

  it('opens that tab SYNCHRONOUSLY, before the server is asked', async () => {
    // THE POPUP-BLOCKER RULE. window.open() only survives inside the click
    // gesture; opening it after the await is silently blocked and the crosshair
    // appears to do nothing. Asserting the ORDER is what pins this — the tab
    // must already exist by the time the POST goes out.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.order.filter((s) => s === 'open' || s === 'post')).toEqual(['open', 'post']);
  });

  it('writes the placeholder into that tab BEFORE the server is asked', async () => {
    // §3.1 of the handoff. The blank tab is unavoidable (popup blockers), so the
    // fix is that it is never a mystery: it must be written into inside the same
    // gesture, not after the await, or the operator stares at about:blank while
    // Chrome boots and cannot tell "slow" from "dead".
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.order.slice(0, 3)).toEqual(['open', 'write', 'post']);
    expect(rec.wrote[0]).toContain('Starting the remote browser');
  });

  it('gives the waiting tab a link it can use itself', async () => {
    // «اصلا تغییر نمیکنه about:blank و در واقع نمی تونم به مرورگر ریموت دسترسی
    //  پیدا کنم» — if this page's own attempt to navigate the tab never lands,
    // the operator must still have a way in, with the api_key a freshly opened
    // tab cannot send as a header.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.links.direct).toBe('/desktop/chrome?api_key=THE-KEY');
  });

  it('navigates that tab to the BARE Chromium view, with the api key', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.navigated).toEqual(['/desktop/chrome?api_key=THE-KEY']);
  });

  it('never sends the operator to a noVNC client', async () => {
    // The complaint was «نمیخام به گزینه های مثل vnc یا novnc روبرو بشم».
    // vnc.html ships 64 noVNC UI elements; vnc_lite.html still has a status bar.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    for (const href of rec.navigated) {
      expect(href).not.toMatch(/vnc\.html|vnc_lite|novnc/i);
    }
  });

  it('asks the server to bring the real browser up', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.posted.map((p) => p.path)).toEqual(['/browser/real/open']);
  });

  it('carries the URL the caller seeded, so the tab lands on the right page', async () => {
    const rec = await runRequestPick(
      { url: 'https://example.com/login' },
      { ok: true, viewPath: '/desktop/chrome' },
    );
    expect(rec.posted[0].body).toEqual({ url: 'https://example.com/login' });
  });

  it('sends an empty url rather than undefined when nothing was seeded', async () => {
    // `{ url: undefined }` serialises to `{}` but a literal string 'undefined'
    // would be navigated to, so this is worth pinning.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.posted[0].body).toEqual({ url: '' });
  });

  it('respects a viewPath that already has a query string', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome?x=1' });
    expect(rec.navigated).toEqual(['/desktop/chrome?x=1&api_key=THE-KEY']);
  });

  it('KEEPS the tab on failure and explains itself inside it', async () => {
    // This test used to assert the opposite (`closed === 1`). Closing the tab
    // was meant to be tidy and measured badly: the new tab is in the FOREGROUND
    // while the page that opened it is not, so the operator saw a window vanish
    // and never read the toast that explained why — the failure was
    // indistinguishable from the hang this whole change exists to end.
    const rec = await runRequestPick({}, { ok: false, error: 'desktop_not_running' });
    expect(rec.closed).toBe(0);
    expect(rec.navigated).toEqual([]);
    expect(rec.wrote[rec.wrote.length - 1]).toContain('did not start');
    // The reason is put in via textContent, never markup: `detail` is a
    // server/proxy message and may itself BE an HTML document (the closed-port
    // error page is exactly that).
    expect(rec.errors).toEqual(['desktop_not_running']);
    // And a Retry the operator can press from the tab they are looking at.
    expect(rec.links.again).toBe('/desktop/chrome?api_key=THE-KEY');
  });

  it('still tells the operator via a toast as well', async () => {
    const rec = await runRequestPick({}, { ok: false, error: 'desktop_not_running' });
    expect(rec.toasts.join(' ')).toContain('desktop_not_running');
  });
});

describe('the canvas simulator is no longer the crosshair destination', () => {
  it('requestPick does not build the picker overlay', async () => {
    // The old implementation created a `.bvp-backdrop` div and appended it to
    // document.body. The fakes above provide NO document at all, so if
    // requestPick still touched it this would throw -- and, more directly,
    // nothing was appended anywhere.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.opened.length).toBe(1); // it opened a tab...
    expect(rec.posted.length).toBe(1); // ...and called the server, nothing else
  });

  it('requestPick contains no canvas/WebSocket streaming machinery', () => {
    const fn = extractFunction(SRC, 'requestPick');
    for (const token of ['bvp-canvas', 'bvp-backdrop', 'getContext', 'WebSocket', 'pickerMarkup']) {
      expect(fn, `requestPick still references ${token}`).not.toContain(token);
    }
  });

  it('keeps the canvas picker available under its own name', () => {
    // Renamed, not deleted: it is ~2000 lines of selector generation, and
    // removing it in the same change that redirects the crosshair would be two
    // risky edits at once.
    expect(SRC).toContain('function requestPickCanvas(');
    expect(SRC).toMatch(/window\.BrowserView\s*=\s*\{[\s\S]*requestPickCanvas/);
  });
});

describe('the crosshair wiring still lines up end to end', () => {
  const ndv = readFileSync(join(ROOT, 'public/js/ndv-nodes.js'), 'utf8');

  it('ndv-nodes.js calls the export browser-view.js provides', () => {
    expect(ndv).toContain('BrowserView.requestPick');
    expect(SRC).toMatch(/window\.BrowserView\s*=\s*\{[\s\S]*requestPick:/);
  });

  it('both entry points share one implementation', () => {
    // The in-panel button and the crosshair must not drift apart.
    expect(SRC).toContain('function openRealBrowser(');
    expect(extractClickHandlerBody(SRC, 'bvp-real')).toContain('openRealBrowser');
    expect(extractFunction(SRC, 'requestPick')).toContain('openRealBrowser');
  });
});

describe('a failed launch does not escape as an unhandled rejection', () => {
  /**
   * MEASURED, not assumed. `openRealBrowser` rethrows on purpose so that a
   * caller which awaits it can react. But the two call sites that actually
   * exist — the crosshair (`requestPick`) and the in-panel button — are
   * fire-and-forget. Running that exact shape in a real Chromium produced:
   *
   *   EVENTS=["TOAST_SHOWN","UNHANDLED:desktop_not_running"]
   *   RAISES_UNHANDLED=true
   *
   * i.e. the operator IS told what went wrong (good), and the rejection then
   * escapes anyway (bad) and trips page-level error reporting. The fix belongs
   * at the fire-and-forget call sites, not inside openRealBrowser — removing
   * the rethrow there would silently disarm every awaiting caller.
   *
   * Node reports the same condition as process 'unhandledRejection', so that
   * is what these tests listen for.
   */
  async function unhandledFrom(source: string): Promise<Error[]> {
    const caught: Error[] = [];
    const onUnhandled = (reason: unknown) => { caught.push(reason as Error); };

    // Take over rejection reporting for the duration of this test so vitest's
    // own handler does not also fire.
    const previous = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', onUnhandled);
    try {
      const rec = newRecorder();
      const sandbox = sandboxFor(rec, { ok: false, error: 'desktop_not_running' });
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('window', 'API', 't', 'toast', source);
      fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast);
      // Rejections are reported on a later turn; give the loop time to do it.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      for (const l of previous) {
        process.on('unhandledRejection', l as (r: unknown, p: Promise<unknown>) => void);
      }
    }
    return caught;
  }

  it('the crosshair swallows the rejection after the toast', async () => {
    const caught = await unhandledFrom(`
      ${openRealBrowserSource()}
      ${extractFunction(SRC, 'requestPick')}
      requestPick(function () {}, {});
    `);
    expect(
      caught.map((e) => e && e.message),
      'requestPick let a rejection escape; it must .catch() its own call',
    ).toEqual([]);
  });

  it('the in-panel button swallows it too', async () => {
    // Same shape as the bvp-real click handler: call, ignore the promise.
    const caught = await unhandledFrom(`
      ${openRealBrowserSource()}
      var urlIn = { value: 'https://example.com' };
      ${extractClickHandlerBody(SRC, 'bvp-real')}
    `);
    expect(
      caught.map((e) => e && e.message),
      'the bvp-real button let a rejection escape',
    ).toEqual([]);
  });

  it('openRealBrowser STILL rethrows, so awaiting callers can react', async () => {
    // The swallow must live at the call sites. If it migrated into
    // openRealBrowser, a future caller that awaits it would treat a failed
    // launch as a success.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', `
      ${openRealBrowserSource()}
      return openRealBrowser('');
    `);
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, { ok: false, error: 'desktop_not_running' });
    const p = fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast);
    await expect(p).rejects.toThrow('desktop_not_running');
  });
});
