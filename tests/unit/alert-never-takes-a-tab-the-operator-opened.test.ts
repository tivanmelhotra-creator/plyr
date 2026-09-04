/**
 * THE PICKER ALERT MUST NOT COST THE OPERATOR A TAB.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT WAS WRONG
 * ------------------------------------------------
 * This file was called `landing-page-reuses-one-tab.test.ts`, and it pinned a
 * `RealChrome.landingPage()` that ended:
 *
 *     const last = existing[existing.length - 1];
 *     if (last) return last;
 *
 * One of its tests was literally named "navigates the page the operator is
 * looking at, not a hidden one", and it asserted that with two pages open the
 * Alert lands on the SECOND. That test passed. It was also the defect:
 *
 *   Tab 1 → Process A     Tab 2 → Process B     Tab 3 → Google
 *
 *   «اجرای Picker … باعث میشه Google ناپدید بشه و به Alert تبدیل بشه»
 *
 * The tab the operator opened for themselves was last in `pages[]`, so it was
 * the one navigated, so their page was gone. The tests were green throughout,
 * because they had encoded the wrong rule — a tab COUNT was being defended
 * while a tab's CONTENTS were being destroyed.
 *
 * The rule they should have been defending, stated by the operator after the
 * Google report:
 *
 *   «صفر Tab جدید برای Alert / صفر navigation برای Alert /
 *    صفر close برای Tabهای دیگر / صفر overwrite کردن Tabهای دیگر»
 *
 *   «Active Tab، Last Tab یا URL هرگز نباید معیار شناسایی Alert Tab باشند»
 *
 * WHY THAT IS EVEN POSSIBLE
 * -------------------------
 * Because the Alert was never a page. `extension/manifest.json` matches every
 * http and https URL, and `content/consent.js` polls `GET /inspector/consent`
 * and draws the Alert into a closed shadow root on whatever page it is running
 * in — pausing while `document.hidden`, so it surfaces on the tab the operator
 * is actually looking at. If the window holds one injectable page, the correct
 * server-side action is to do NOTHING. That is PRIORITY 1, and it is what most
 * of this file measures.
 *
 * ── AND THEN PRIORITY 2 WAS WITHDRAWN ──────────────────────────────────────
 * This file used to have a whole `describe` for a FALLBACK: when no injectable
 * page existed at all (a cold profile on `about:blank`), `alertTab()` opened one
 * and sent it to `/inspector/consent-host`. Eleven tests defended it, including
 * "claims a tab when the window has only about:blank" and a "one Alert Tab,
 * reused" contract.
 *
 * Those tests passed. They were also defending a design the operator has since
 * rejected outright, after measuring what the fallback actually cost:
 *
 *   «در اجرای فعلی Local Browser، حتی قبل از استفاده از Picker، چندین
 *    about:blank ساخته می‌شود؛ مثلاً ۵ یا بیشتر about:blank به‌علاوه یک
 *    consent-host. این رفتار قابل قبول نیست.»
 *
 *   «دیگر Priority 2 / fallback برای ساختن consent-host به عنوان Alert Tab
 *    نمی‌خواهیم … این concept باید از معماری حذف شود:
 *    `alertTab()`, `consent-host`, `dedicated alert page`»
 *
 * The reason a "reused, one-tab" fallback still accumulated pages is the part
 * worth recording, because removing `alertTab()` alone would NOT have fixed it:
 * the reuse was per-PROCESS, while the profile is per-DISK. Every page the
 * fallback ever created was written into the session by
 * `session.restore_on_startup = 5` plus `--restore-last-session`, and came back
 * on the NEXT launch. One tab per run became N tabs on disk. Measured:
 *
 *     stage      total  new  about:blank  consent-host
 *     launch         3    3            1             2   ← before ANY picker
 *
 * So there is no longer any state in which the Alert gets a page. `AlertSurface`
 * carries a COUNT and no `Page`, `alertTab()` is gone, and the static claim it
 * kept is gone with it. What remains to be tested is the absence: that no page
 * is created in the states which used to create one, and that a window with
 * nowhere to draw says so honestly instead of manufacturing a destination.
 *
 * HOW THESE TEST IT
 * -----------------
 * `alertSurface()` only consults the context's page list, so a fake context over
 * a MUTABLE list measures the real decision — mutable because the interesting
 * states (a blank page becoming a real one) only exist after a first call. The
 * fake still offers `newPage()`, and it is still counted: a fake that could not
 * open a page could not detect the regression these tests exist to prevent.
 * `getContext()` is stubbed: launching a headed Chromium is the browser tier's
 * job, and what is under test here is WHICH surface is chosen.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { RealChrome } from '../../src/core/RealChrome';
import type { BrowserContext, Page } from 'playwright';

/**
 * A page that knows its URL, whether it is closed, and who wants to hear about
 * its close — which is all `alertSurface()` and `alertTab()` ever read.
 */
function makePage(url: string) {
  let current = url;
  let closed = false;
  const closeHandlers: Array<() => void> = [];
  const obj = {
    url: () => current,
    isClosed: () => closed,
    once: (ev: string, fn: () => void) => { if (ev === 'close') closeHandlers.push(fn); },
    goto: async () => undefined,
  } as unknown as Page;
  return {
    obj,
    navigate(to: string) { current = to; },
    /** Close it the way the operator does: with the browser's event firing. */
    close() { closed = true; closeHandlers.forEach((f) => f()); },
  };
}

function contextWith(urls: string[]) {
  const pages = urls.map(makePage);
  let opened = 0;

  const ctx = {
    pages: () => pages.filter((p) => !p.obj.isClosed()).map((p) => p.obj),
    newPage: () => {
      opened++;
      const p = makePage('about:blank');
      pages.push(p);
      return Promise.resolve(p.obj);
    },
  } as unknown as BrowserContext;

  vi.spyOn(RealChrome, 'getContext').mockResolvedValue(ctx);

  return {
    /** Brand-new tabs opened. THE number in the report. */
    get opened() { return opened; },
    get count() { return pages.filter((p) => !p.obj.isClosed()).length; },
    at(i: number) { return pages[i]; },
    find(p: Page) {
      const f = pages.find((x) => x.obj === p);
      if (!f) throw new Error('page not in this context');
      return f;
    },
  };
}

/**
 * There is NOTHING to forget between tests any more, and that is an assertion
 * rather than a gap.
 *
 * This used to clear `RealChrome.alertPage` — a `private static` holding the
 * claimed Alert Tab, which survived between tests exactly as it survived
 * between requests. Cross-test leakage through it was real: a claim made by one
 * test would be reused by the next, so the helper had to run in both
 * `beforeEach` and `afterEach`.
 *
 * The field is gone with the fallback, so the hook is kept as a TRIPWIRE: if a
 * static page claim is ever reintroduced, this fails immediately and names the
 * requirement, instead of the suite quietly going order-dependent again.
 */
function forgetClaim() {
  const held = (RealChrome as unknown as { alertPage?: unknown }).alertPage;
  if (held !== undefined) {
    throw new Error(
      'RealChrome.alertPage is back: the Alert must hold no page of its own '
      + '(«Alert نباید page جدید داشته باشد»)',
    );
  }
}

beforeEach(forgetClaim);
afterEach(() => { vi.restoreAllMocks(); forgetClaim(); });

describe('PRIORITY 1 — the Alert is an overlay, so nothing is opened or navigated', () => {
  it('asks for no tab at all when one ordinary page is open', async () => {
    const ctx = contextWith(['https://shop.example/p/1']);
    const surface = await RealChrome.alertSurface();

    expect(surface.kind).toBe('overlay');
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(1);
  });

  it('LEAVES THE GOOGLE TAB ALONE — the report, as a test', async () => {
    // The exact scenario that was reported. The old code returned pages[2] here
    // and the caller navigated it, so Google became the Alert. Nothing may be
    // handed back that could be navigated at all.
    const ctx = contextWith([
      'https://app.example/process-a',
      'https://app.example/process-b',
      'https://www.google.com/',
    ]);

    const surface = await RealChrome.alertSurface();

    expect(surface.kind).toBe('overlay');
    // No page is returned, so there is nothing the caller COULD overwrite. This
    // is stronger than checking which page was chosen: it removes the choice.
    expect(surface).not.toHaveProperty('page');
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(3);
    expect(ctx.at(2).obj.url()).toBe('https://www.google.com/');
  });

  it('closes nothing, however many tabs are open', async () => {
    const ctx = contextWith([
      'https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/',
    ]);
    await RealChrome.alertSurface();
    expect(ctx.count).toBe(4);
  });

  it('stays an overlay across many picks — six presses, zero tabs', async () => {
    // The operator targets a field per node, so "correct on the first press"
    // is not the contract. The previous implementation degraded on the SECOND
    // call, which is why repetition is measured rather than assumed.
    const ctx = contextWith(['https://shop.example/p/1']);
    for (let i = 0; i < 6; i++) {
      const s = await RealChrome.alertSurface();
      expect(s.kind).toBe('overlay');
    }
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(1);
  });

  it('does not care which tab is active, because it never picks one', async () => {
    // «حتی اگر من قبل از اجرای Picker، روی Tab اول کلیک کرده باشم، باز هم سیستم
    //  نباید بر اساس اینکه کدام Tab Active است تصمیم بگیره»
    //
    // Nothing in the fake context models activeness, and that is the assertion:
    // if the decision depended on it, this could not compile a passing test.
    // consent.js resolves the active tab in the browser, where the answer lives.
    const ctx = contextWith(['https://first.example/', 'https://second.example/']);
    const surface = await RealChrome.alertSurface();
    expect(surface.kind).toBe('overlay');
    expect(ctx.opened).toBe(0);
  });

  it('counts https and http alike, since the manifest matches both', async () => {
    const ctx = contextWith(['http://127.0.0.1:3000/inspector/consent-host']);
    expect((await RealChrome.alertSurface()).kind).toBe('overlay');
    expect(ctx.opened).toBe(0);
  });
});

describe('THE WITHDRAWN FALLBACK — the states that used to open a tab open nothing', () => {
  /*
   * Each test here names the PRIORITY 2 test it replaces, because the point is
   * not that these states are uninteresting — they are the exact states the old
   * fallback fired in. The assertion has been inverted, deliberately, and the
   * inversion is the requirement:
   *
   *   «Alert نباید Tab جدید بسازد» / «Picker نباید برای Alert صفحه جدید بسازد»
   */

  it('opens NOTHING when the window has only about:blank', async () => {
    // Replaces "claims a tab when the window has only about:blank".
    //
    // Chrome injects no content script into about:blank, so the Alert genuinely
    // cannot render here. The old code treated that as a reason to build a page.
    // It is now reported instead: `pages: 0` is the honest answer, and the
    // caller's correct response is to leave the browser alone. The operator sees
    // the Alert as soon as anything real is loaded — which the picker flow does
    // anyway — and in exchange the profile stops growing a consent-host per run.
    const ctx = contextWith(['about:blank']);
    const surface = await RealChrome.alertSurface();

    expect(surface.kind).toBe('overlay');
    expect(surface.pages).toBe(0);
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(1);
    // And the blank page is left blank — not navigated to a consent host.
    expect(ctx.at(0).obj.url()).toBe('about:blank');
  });

  it('opens NOTHING when the window has no pages at all', async () => {
    // Replaces "claims a tab when the window has no pages at all".
    const ctx = contextWith([]);
    const surface = await RealChrome.alertSurface();

    expect(surface.kind).toBe('overlay');
    expect(surface.pages).toBe(0);
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(0);
  });

  it('opens NOTHING for a window holding only chrome:// and extension pages', async () => {
    // Replaces "never counts a chrome:// or extension page as an overlay
    // surface". The classification is UNCHANGED and still matters — these are
    // correctly not counted, so `pages` is 0 rather than 2 — but a zero count no
    // longer triggers a page.
    const ctx = contextWith(['chrome://extensions/', 'chrome-extension://abc/popup.html']);
    const surface = await RealChrome.alertSurface();

    expect(surface.kind).toBe('overlay');
    expect(surface.pages).toBe(0);
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(2);
  });

  it('opens nothing across SIX presses on a blank window — the accumulation case', async () => {
    // Replaces "REUSES the one Alert Tab instead of opening a second — six
    // presses, one tab". Six presses now cost ZERO tabs rather than one, and
    // zero is the only number that cannot accumulate through session restore:
    // a tab that is never created cannot be restored on the next launch.
    const ctx = contextWith(['about:blank']);
    for (let i = 0; i < 6; i++) {
      const s = await RealChrome.alertSurface();
      expect(s.kind).toBe('overlay');
      expect(s.pages).toBe(0);
    }
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(1);
  });

  it('has no concept of an Alert page left to hand out', async () => {
    // The structural half. `AlertSurface` used to be a two-member union whose
    // `tab` member carried a `Page`, and it was that property which made the
    // Google report POSSIBLE: a caller holding a page will eventually navigate
    // it. Nothing is handed back that could be navigated, in any state.
    for (const urls of [[], ['about:blank'], ['chrome://extensions/'], ['https://a.example/']]) {
      const ctx = contextWith(urls);
      const surface = await RealChrome.alertSurface();

      expect(surface).not.toHaveProperty('page');
      expect(surface).not.toHaveProperty('reused');
      expect(surface.kind).toBe('overlay');
      expect(ctx.opened).toBe(0);

      vi.restoreAllMocks();
    }
  });

  it('no longer exposes alertTab() at all', () => {
    // «این concept باید از معماری حذف شود: alertTab(), consent-host,
    //  dedicated alert page»
    //
    // Asserted on the class rather than the source text: a method that still
    // existed but was never called would satisfy a grep for its call sites
    // while leaving the page-creating code one call away from returning.
    expect((RealChrome as unknown as Record<string, unknown>).alertTab).toBeUndefined();
  });

  it('keeps no static page claim between calls', async () => {
    // The claim was a `private static alertPage: Page | null` that outlived
    // every request and had to be unclaimed on close, checked for `isClosed()`,
    // and nulled in three places. Holding no page means none of that can rot.
    const ctx = contextWith(['about:blank']);
    await RealChrome.alertSurface();
    await RealChrome.alertSurface();

    expect((RealChrome as unknown as { alertPage?: unknown }).alertPage).toBeUndefined();
    expect(ctx.opened).toBe(0);
  });
});

describe('the surface REPORTS what it found, so the caller cannot be misled', () => {
  it('counts every injectable page, and only those', async () => {
    // The count is the whole return value now, so it has to be right: it is how
    // a caller (and the operator, through the route's response) can tell "the
    // Alert will appear" from "there is nowhere for it to draw yet".
    const ctx = contextWith([
      'https://a.example/',
      'http://b.example/',
      'about:blank',
      'chrome://extensions/',
      'chrome-extension://abc/popup.html',
      'https://www.google.com/',
    ]);
    const surface = await RealChrome.alertSurface();

    expect(surface.pages).toBe(3);
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(6);
  });

  it('http and https both count, since the manifest matches both', async () => {
    const ctx = contextWith([
      'http://127.0.0.1:3000/inspector/consent-host',
      'https://shop.example/p/1',
    ]);
    expect((await RealChrome.alertSurface()).pages).toBe(2);
    expect(ctx.opened).toBe(0);
  });

  it('follows the window as a blank page becomes a real one', async () => {
    // Replaces "an overlay becomes available again once the operator opens a
    // real page". Same transition, but now it moves a COUNT from 0 to 1 rather
    // than switching between two kinds of surface.
    const ctx = contextWith(['about:blank']);
    expect((await RealChrome.alertSurface()).pages).toBe(0);

    ctx.at(0).navigate('https://shop.example/p/1');

    const after = await RealChrome.alertSurface();
    expect(after.pages).toBe(1);
    expect(ctx.opened).toBe(0);
    expect(ctx.count).toBe(1);
  });

  it('ignores a page the operator has closed', async () => {
    // A closed page is not a surface, and counting one would report an Alert
    // that renders nowhere — silently, which is the worst version of this bug.
    const ctx = contextWith(['https://a.example/', 'https://b.example/']);
    expect((await RealChrome.alertSurface()).pages).toBe(2);

    ctx.at(1).close();

    expect((await RealChrome.alertSurface()).pages).toBe(1);
    expect(ctx.opened).toBe(0);
  });

  it('never navigates a page it counted — Google survives being counted', async () => {
    // The original report, restated for the surviving code path. Counting a
    // page must be a read: the fake's URLs are checked afterwards because a
    // count that mutated what it counted would still return the right number.
    const ctx = contextWith([
      'https://app.example/process-a',
      'https://app.example/process-b',
      'https://www.google.com/',
    ]);

    for (let i = 0; i < 3; i++) await RealChrome.alertSurface();

    expect(ctx.at(0).obj.url()).toBe('https://app.example/process-a');
    expect(ctx.at(1).obj.url()).toBe('https://app.example/process-b');
    expect(ctx.at(2).obj.url()).toBe('https://www.google.com/');
    expect(ctx.count).toBe(3);
    expect(ctx.opened).toBe(0);
  });
});

describe('newPage stays a SCRATCH allocator — the intents remain distinct', () => {
  it('opens a new tab when no page is blank', async () => {
    // Pinned as CORRECT for newPage, not as a bug. A caller that wants an
    // additional page must keep getting one; the fix was to stop the ALERT
    // from using a page-grabbing helper, not to change this one.
    const ctx = contextWith(['https://shop.example/p/1']);
    await RealChrome.newPage();
    expect(ctx.opened).toBe(1);
    expect(ctx.count).toBe(2);
  });

  it('and the Alert path opens nothing in that same state', async () => {
    // The one comparison that would have caught the original regression: same
    // context contents, different question, different answer.
    const a = contextWith(['https://shop.example/p/1']);
    await RealChrome.newPage();
    const scratchOpened = a.opened;
    vi.restoreAllMocks();
    forgetClaim();

    const b = contextWith(['https://shop.example/p/1']);
    await RealChrome.alertSurface();

    expect(scratchOpened).toBe(1);
    expect(b.opened).toBe(0);
  });
});

/**
 * THE ROUTE MUST ACTUALLY BEHAVE THIS WAY.
 *
 * Everything above proves `alertSurface()` decides correctly. None of it proves
 * the caller OBEYS the decision — and a route that asked for the surface and
 * then navigated a page anyway would leave every test above green while
 * reproducing the Google report exactly. That is not hypothetical: navigating
 * unconditionally is precisely what this route used to do.
 *
 * Asserted on the extracted function body, so an unrelated `goto` elsewhere in
 * browser.routes.ts cannot mask a regression at this call site.
 */
describe('the real-browser launcher obeys the surface it was given', () => {
  const src = (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    return readFileSync(join(__dirname, '..', '..', 'src/Routes/browser.routes.ts'), 'utf8');
  })();

  /** The body of `openRealBrowser`, by brace depth — comment- and length-proof. */
  const openRealBrowserSrc = (() => {
    const start = src.indexOf('async function openRealBrowser(');
    if (start < 0) throw new Error('openRealBrowser not found in browser.routes.ts');
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces in openRealBrowser');
  })();

  /** Code only, so a quoted defect in a comment cannot pass for the defect. */
  const code = openRealBrowserSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('asks RealChrome where the Alert goes instead of assuming', () => {
    expect(code).toContain('RealChrome.alertSurface()');
  });

  it('no longer reaches for a landing page to navigate', () => {
    // The removed helper, and the reason it was removed. Named explicitly so
    // that reintroducing it fails here rather than in a live report.
    expect(code).not.toContain('landingPage');
    expect(code).not.toContain('length - 1');
  });

  it('navigates for the EXPLICIT URL and for nothing else', () => {
    // The heart of it, and the assertion that changed most. It used to require
    // `surface.kind === 'tab'` — a branch that no longer exists, because there
    // is no second kind to branch on. The rule is now simpler and stricter:
    // the ONLY `goto` in this function is the one an operator asked for by
    // sending a `url`, and it is guarded by `if (url)`.
    const gotoLines = code.split('\n').filter((l) => l.includes('.goto('));

    // Exactly one navigation site. Two would mean the Alert reacquired one.
    expect(gotoLines.length).toBe(1);
    expect(gotoLines[0]).toContain('target.goto(');

    // And it is inside the `if (url)` block — checked by position rather than
    // by trusting the layout, so an accidental de-indent cannot pass.
    const urlBranch = code.indexOf('if (url)');
    expect(urlBranch).toBeGreaterThan(-1);
    expect(code.indexOf('.goto(')).toBeGreaterThan(urlBranch);
  });

  it('still honours an explicit url, by REUSING the window\'s blank page', () => {
    // «اگر همان about:blank موجود است، همان را reuse کن.»
    //
    // An operator who asked to be taken somewhere gets taken there — that is a
    // navigation they initiated. It goes through `newPage()`, which adopts the
    // profile's existing blank tab when there is one, so the ordinary case
    // costs no tab at all.
    expect(code).toMatch(/if \(url\)/);
    expect(code).toContain('RealChrome.newPage()');
  });

  it('no longer builds a consent-host destination for the Alert', () => {
    // «این concept باید از معماری حذف شود: alertTab(), consent-host,
    //  dedicated alert page»
    //
    // NOTE ON SCOPE, so this is not "fixed" by deleting the wrong thing: the
    // ROUTE `GET /inspector/consent-host` in mode.routes.ts is deliberately
    // KEPT, and has its own test. It is a scriptless static page that answers
    // "do content scripts inject here at all?" — a diagnostic worth having.
    // What is asserted here is only that this launcher never navigates to it.
    expect(code).not.toContain('consentHostUrl');
    expect(code).not.toContain('consent-host');
    expect(code).not.toContain('alertTab');
  });

  it('asks for the surface but is handed no page to navigate', () => {
    // The two halves that make the Google report unreproducible: the route
    // consults `alertSurface()`, and what comes back has no `.page`, so there
    // is no expression in this function that could navigate the operator's tab.
    expect(code).toContain('RealChrome.alertSurface()');
    expect(code).not.toContain('surface.page');
    expect(code).not.toContain('.kind ===');
  });
});
