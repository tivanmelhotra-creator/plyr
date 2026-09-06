/**
 * THE LOCAL BROWSER'S INITIAL TAB BECOMES THE PROJECT PAGE — AND NOTHING ELSE
 * MOVES.
 *
 * THE REPORT (after the previous merge, measured in real Chrome)
 * --------------------------------------------------------------
 *   «Picker → Local Browser → viewer tab opens → Local Browser loads →
 *    127.0.0.1:3000 is displayed → ❌ NO Picker Alert»
 *
 * MEASURED, cold launch, the two requests the dashboard sends:
 *
 *   POST /inspector/targeting/begin → consent pending
 *   POST /browser/real/open         → tabs=[about:blank] alertSurface.pages=0
 *   CDP                             → dialogs=0
 *
 * The manifest injects `content/consent.js` into http/https pages only, so a
 * window whose only page is `about:blank` (or `chrome://new-tab-page/`) has NO
 * content script, NO poll, and NO `showPickerAlert()`. The previous fix removed
 * the Alert Tab — correctly — and put nothing in its place.
 *
 * THE RULE
 * --------
 *   «launchPersistentContext() → initial/reusable page → navigate that SAME
 *    page to http://127.0.0.1:3000»
 *   «The initial page itself should become the project page.»
 *
 * and, unchanged from before:
 *
 *   «Alert must NEVER create a new tab/page inside Local Browser»
 *   «صفر overwrite کردن Tabهای دیگر»
 *
 * So `projectPage()` navigates ONLY a tab `isInitialPage()` accepts, never
 * calls `newPage()`, and returns an existing project page untouched. These
 * tests drive it with a fake context over a mutable page list, exactly as the
 * sibling `alert-never-takes-a-tab-the-operator-opened.test.ts` does.
 *
 * THE OTHER HALF — the extra about:blank per launch
 * -------------------------------------------------
 * MEASURED in the running browser over three restarts: Playwright's
 * `launchPersistentContext` appends a positional `about:blank` argument, and
 * with session restore on each restored blank plus the fresh argument adds one
 * more blank tab per launch. The argument is now on `ignoreDefaultArgs`.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RealChrome,
  isInitialPage,
  isProjectPage,
  projectUrl,
  POSITIONAL_BLANK_ARG,
} from '../../src/core/RealChrome';
import { config } from '../../src/config';
import type { BrowserContext, Page } from 'playwright';

function makePage(url: string) {
  let current = url;
  let front = 0;
  const gotos: string[] = [];
  const obj = {
    url: () => current,
    isClosed: () => false,
    once: () => undefined,
    goto: async (to: string) => { gotos.push(to); current = to; return null; },
    bringToFront: async () => { front++; },
  } as unknown as Page;
  return { obj, gotos, get front() { return front; } };
}

function contextWith(urls: string[]) {
  const pages = urls.map(makePage);
  let opened = 0;
  const ctx = {
    pages: () => pages.map((p) => p.obj),
    newPage: async () => {
      opened++;
      const p = makePage('about:blank');
      pages.push(p);
      return p.obj;
    },
  } as unknown as BrowserContext;
  vi.spyOn(RealChrome, 'getContext').mockResolvedValue(ctx);
  return {
    at: (i: number) => pages[i]!,
    get count() { return pages.length; },
    get opened() { return opened; },
    urls: () => pages.map((p) => p.obj.url()),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe('which tabs count as the initial, reusable one', () => {
  it('about:blank and an empty URL — Playwright\'s positional argument and a page not yet committed', () => {
    expect(isInitialPage('about:blank')).toBe(true);
    expect(isInitialPage('')).toBe(true);
  });

  it('Chrome\'s own start page, which is what appears once the positional argument is gone', () => {
    // MEASURED: fresh profile, no `about:blank` argument → `chrome://new-tab-page/`.
    expect(isInitialPage('chrome://new-tab-page/')).toBe(true);
    expect(isInitialPage('chrome://newtab/')).toBe(true);
    expect(isInitialPage('chrome://new-tab-page')).toBe(true);
  });

  it('NOT an operator\'s page, NOT another chrome:// page, NOT an extension page', () => {
    expect(isInitialPage('https://www.google.com/')).toBe(false);
    expect(isInitialPage('http://127.0.0.1:3000/')).toBe(false);
    expect(isInitialPage('chrome://extensions/')).toBe(false);
    expect(isInitialPage('chrome://settings/')).toBe(false);
    expect(isInitialPage('chrome-extension://abc/popup.html')).toBe(false);
    // The consent host is a stale Alert page, not a blank — the sweep owns it.
    expect(isInitialPage('http://127.0.0.1:3000/inspector/consent-host')).toBe(false);
  });
});

describe('the canonical project URL', () => {
  it('is loopback on the port this server listens on — the same address the extension is seeded with', () => {
    expect(projectUrl()).toBe(`http://127.0.0.1:${config.PORT}/`);
    expect(projectUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('recognises any path on that origin as the project page, and nothing else', () => {
    expect(isProjectPage(projectUrl())).toBe(true);
    expect(isProjectPage(`http://127.0.0.1:${config.PORT}/live-view.html`)).toBe(true);
    expect(isProjectPage(`http://127.0.0.1:${config.PORT + 1}/`)).toBe(false);
    expect(isProjectPage('https://www.google.com/')).toBe(false);
    expect(isProjectPage('about:blank')).toBe(false);
    expect(isProjectPage('not a url')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('projectPage() — a cold browser', () => {
  it('navigates the SAME initial about:blank to the project URL — Test A', async () => {
    const ctx = contextWith(['about:blank']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('navigated');
    expect(r.page).toBe(ctx.at(0).obj);
    expect(ctx.at(0).gotos).toEqual([projectUrl()]);
    // Exactly one page, and it IS the project page. Not [about:blank, project].
    expect(ctx.count).toBe(1);
    expect(ctx.opened).toBe(0);
    expect(ctx.urls()).toEqual([projectUrl()]);
    expect(r.pages).toBe(1);
  });

  it('navigates Chrome\'s new-tab page the same way — the post-fix launch state', async () => {
    const ctx = contextWith(['chrome://new-tab-page/']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('navigated');
    expect(ctx.urls()).toEqual([projectUrl()]);
    expect(ctx.opened).toBe(0);
  });

  it('brings the navigated page to the front, so it is the ACTIVE tab the Alert is owned by', async () => {
    const ctx = contextWith(['about:blank']);
    await RealChrome.projectPage();
    expect(ctx.at(0).front).toBe(1);
  });

  it('never calls newPage(), even when there is nothing at all to reuse', async () => {
    const ctx = contextWith([]);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('none');
    expect(r.page).toBeNull();
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(0);
  });

  it('survives a goto() that throws — the Picker is not failed over a slow load', async () => {
    const ctx = contextWith(['about:blank']);
    (ctx.at(0).obj as unknown as { goto: () => Promise<never> }).goto = async () => {
      throw new Error('Timeout 15000ms exceeded');
    };
    const r = await RealChrome.projectPage();
    expect(r.reason).toBe('navigated');
    expect(r.page).toBe(ctx.at(0).obj);
    expect(ctx.opened).toBe(0);
  });
});

describe('projectPage() — a running browser', () => {
  it('returns an existing project page untouched: nothing navigated, nothing opened — Test B', async () => {
    const ctx = contextWith([projectUrl()]);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('exists');
    expect(r.page).toBe(ctx.at(0).obj);
    expect(ctx.at(0).gotos).toEqual([]);
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(1);
  });

  it('does NOT steal focus back when the project page already exists — the operator may be on another tab', async () => {
    const ctx = contextWith([projectUrl(), 'https://www.google.com/']);
    await RealChrome.projectPage();
    expect(ctx.at(0).front).toBe(0);
    expect(ctx.at(1).front).toBe(0);
  });

  it('is idempotent across Picker ×3 — Test D', async () => {
    const ctx = contextWith(['about:blank']);
    const a = await RealChrome.projectPage();
    const b = await RealChrome.projectPage();
    const c = await RealChrome.projectPage();

    expect([a.reason, b.reason, c.reason]).toEqual(['navigated', 'exists', 'exists']);
    expect(ctx.count).toBe(1);
    expect(ctx.opened).toBe(0);
    expect(ctx.at(0).gotos).toEqual([projectUrl()]);   // once, not three times
  });

  it('any path on the project origin counts as the project page — a live-view tab is not "missing"', async () => {
    const ctx = contextWith([`http://127.0.0.1:${config.PORT}/live-view.html`, 'about:blank']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('exists');
    expect(r.page).toBe(ctx.at(0).obj);
    // The blank is left alone: there was already somewhere for the Alert.
    expect(ctx.at(1).gotos).toEqual([]);
    expect(ctx.urls()).toEqual([`http://127.0.0.1:${config.PORT}/live-view.html`, 'about:blank']);
  });
});

describe('projectPage() — the operator\'s tabs are never touched (the Google report)', () => {
  it('Google, YouTube, a blank: only the blank is navigated', async () => {
    const ctx = contextWith(['https://www.google.com/', 'https://www.youtube.com/', 'about:blank']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('navigated');
    expect(r.page).toBe(ctx.at(2).obj);
    expect(ctx.urls()).toEqual(['https://www.google.com/', 'https://www.youtube.com/', projectUrl()]);
    expect(ctx.at(0).gotos).toEqual([]);
    expect(ctx.at(1).gotos).toEqual([]);
    expect(ctx.opened).toBe(0);
  });

  it('Google alone, no blank: NOTHING is navigated and NOTHING is opened — the last tab is not hijacked', async () => {
    const ctx = contextWith(['https://www.google.com/']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('none');
    expect(r.page).toBeNull();
    expect(ctx.urls()).toEqual(['https://www.google.com/']);
    expect(ctx.at(0).gotos).toEqual([]);
    expect(ctx.opened).toBe(0);
  });

  it('chrome://extensions and an extension popup are not blanks either', async () => {
    const ctx = contextWith(['chrome://extensions/', 'chrome-extension://abc/popup.html']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('none');
    expect(ctx.at(0).gotos).toEqual([]);
    expect(ctx.at(1).gotos).toEqual([]);
    expect(ctx.opened).toBe(0);
  });

  it('two blanks (an older profile): exactly ONE is navigated, the other is left alone, none is closed', async () => {
    const ctx = contextWith(['about:blank', 'about:blank']);
    const r = await RealChrome.projectPage();

    expect(r.reason).toBe('navigated');
    expect(ctx.urls()).toEqual([projectUrl(), 'about:blank']);
    expect(ctx.count).toBe(2);
    expect(ctx.opened).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the source itself — what must and must not be there', () => {
  const realChrome = fs.readFileSync(path.resolve(__dirname, '../../src/core/RealChrome.ts'), 'utf8');
  const routes = fs.readFileSync(path.resolve(__dirname, '../../src/Routes/browser.routes.ts'), 'utf8');

  it('drops Playwright\'s positional about:blank via ignoreDefaultArgs — the measured source of the per-launch blank', () => {
    expect(POSITIONAL_BLANK_ARG).toBe('about:blank');
    expect(realChrome).toMatch(/ignoreDefaultArgs:\s*\[\.\.\.IGNORED_DEFAULT_ARGS,\s*POSITIONAL_BLANK_ARG\]/);
  });

  it('projectPage() contains no newPage() call', () => {
    const start = realChrome.indexOf('static async projectPage(');
    const end = realChrome.indexOf('\n  }\n', start);
    const body = realChrome.slice(start, end);
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain('newPage(');
    expect(body).not.toContain('consent-host');
    expect(body).not.toContain('consentHostUrl');
  });

  it('the picker route calls projectPage() BEFORE reporting the alert surface', () => {
    const open = routes.indexOf('async function openRealBrowser(');
    const body = routes.slice(open, routes.indexOf('\n  }\n', open));
    const p = body.indexOf('RealChrome.projectPage()');
    const s = body.indexOf('RealChrome.alertSurface()');
    expect(p).toBeGreaterThan(-1);
    expect(s).toBeGreaterThan(p);
    // And still nothing that could reintroduce the Alert Tab.
    expect(body).not.toContain('alertTab');
    expect(body).not.toContain('consentHostUrl');
    expect(body).not.toContain('surface.page');
  });

  it('the trace names every step the operator asked for', () => {
    for (const s of ['page created', 'launch census', 'navigating initial page', 'project page ready', 'project page exists', 'alert surface']) {
      expect(realChrome).toContain(s);
    }
    expect(routes).toContain('picker open: project=');
  });
});
