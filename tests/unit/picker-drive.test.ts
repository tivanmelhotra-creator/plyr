/**
 * picker-drive.test.ts — DRIVE the Element Picker against a real page.
 *
 * HANDOFF 15 § 6.0 closed with: "the picker modal has never been rendered. No
 * screenshot, no live socket test. Everything above is statically verified
 * only." `element-picker.test.ts` greps the four layers for agreement, which
 * catches drift but proves nothing about behaviour: a `cssPath` that returns a
 * selector matching the wrong node passes every regex in that file.
 *
 * So this suite injects the REAL `PICKER_SCRIPT` (imported, not copied) into a
 * real Chromium page and drives it the way the modal does — move the pointer,
 * click, walk the DOM, verify a typed selector — then asserts the payloads that
 * come back through the `__abReportPick` binding.
 *
 * The four claims under test are the ones the product actually rests on:
 *   1. hovering reports a selector that resolves back to the hovered element
 *   2. clicking locks, and does NOT fire the page's own handlers or navigate
 *      (the whole point of capture + preventDefault; if this broke, picking a
 *       link would navigate away and the picker would be unusable)
 *   3. ↑/↓ traversal moves to the parent / first child
 *   4. the reported match count is the truth, including "not unique" and
 *      "invalid selector" (-1), because that number is the only defence against
 *      a selector that silently matches 40 nodes
 *
 * Skips itself (rather than failing) when Chromium cannot launch, so the suite
 * stays green on machines without Playwright's system libraries:
 *     sudo npx playwright install-deps chromium
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PICKER_SCRIPT } from '../../src/core/LiveBrowser';

type Payload = {
  k: string; css: string; xpath: string; tag?: string; text?: string;
  attrs?: { name: string; value: string }[];
  count: number; hasParent?: boolean; hasChild?: boolean;
};

// A fixture with the shapes that break naive selector generators: an id, a
// repeated class (so a count > 1 is provable), nested structure for traversal,
// and a link whose click must NOT navigate.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px system-ui; }
  .row { height: 60px; padding: 10px; }
  #hero { height: 80px; background: #eee; }
  a { display: block; height: 40px; }
</style></head><body>
  <div id="hero"><span class="badge" data-testid="hero-badge">Hero</span></div>
  <div class="row" id="r1"><button class="btn go" name="first">One</button></div>
  <div class="row" id="r2"><button class="btn go" name="second">Two</button></div>
  <div class="row" id="r3"><a href="/navigated.html" id="link">Link</a></div>
</body></html>`;

let browser: any = null;
let available = false;

beforeAll(async () => {
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    available = true;
  } catch {
    available = false;   // no browser deps in this environment → skip below
  }
}, 60_000);

afterAll(async () => { if (browser) await browser.close(); });

/**
 * Fresh page with the fixture loaded, the picker injected, and the binding
 * collecting every payload the script emits — i.e. exactly the wiring
 * LiveBrowserSession.start() + setPicker(true) set up in production.
 */
async function armedPage() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const seen: Payload[] = [];
  await page.exposeBinding('__abReportPick', (_src: unknown, data: Payload) => {
    seen.push(data);
  });
  await page.setContent(FIXTURE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(PICKER_SCRIPT);
  const last = (kind?: string) => {
    const list = kind ? seen.filter((p) => p.k === kind) : seen;
    return list[list.length - 1];
  };
  return { page, seen, last };
}

// `it` that becomes a skip when Chromium is unavailable.
const browserIt = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(name, async () => {
    if (!available) { expect(available).toBe(false); return; }   // skipped
    await fn();
  }, timeout);

describe('picker drive: hover previews the element under the pointer', () => {
  browserIt('reports a css selector that resolves back to the hovered element', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('#r2 button').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction('window.__abPickHover !== undefined');
    await page.waitForTimeout(150);

    const p = last('hover');
    expect(p, 'a hover payload must arrive').toBeTruthy();
    expect(p.tag).toBe('button');
    // The real test: does the produced selector point back at the same node?
    const resolvesToSame = await page.evaluate((css: string) => {
      const el = document.querySelector(css);
      return !!el && el === document.querySelector('#r2 button');
    }, p.css);
    expect(resolvesToSame, `css was ${p.css}`).toBe(true);
  });

  browserIt('carries the attributes the panel renders, capped and stringified', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('[data-testid="hero-badge"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);

    const p = last('hover');
    expect(p.attrs!.length).toBeLessThanOrEqual(12);
    const names = p.attrs!.map((a) => a.name);
    expect(names).toContain('data-testid');
    expect(p.attrs!.find((a) => a.name === 'data-testid')!.value).toBe('hero-badge');
    expect(p.text).toBe('Hero');
  });
});

describe('picker drive: a click locks without letting the page act', () => {
  browserIt('emits kind "pick" and does not navigate away from the page', async () => {
    const { page, last } = await armedPage();
    const before = page.url();
    const box = (await page.locator('#link').boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 10, box.y + 10);
    await page.waitForTimeout(200);

    const p = last('pick');
    expect(p, 'clicking must produce a pick payload').toBeTruthy();
    expect(p.tag).toBe('a');
    // If capture+preventDefault ever regressed, the picker would follow the
    // link and the user would lose the page they were picking from.
    expect(page.url()).toBe(before);
  });

  browserIt('does not fire the element own click handler', async () => {
    const { page, last } = await armedPage();
    await page.evaluate(() => {
      (window as any).__fired = 0;
      document.getElementById('r1')!.querySelector('button')!
        .addEventListener('click', () => { (window as any).__fired++; });
    });
    const box = (await page.locator('#r1 button').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(200);

    expect(last('pick')).toBeTruthy();
    expect(await page.evaluate(() => (window as any).__fired)).toBe(0);
  });
});

describe('picker drive: DOM traversal', () => {
  browserIt('walks up to the parent and back down to the first child', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('#r2 button').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(150);
    expect(last('pick').tag).toBe('button');

    expect(await page.evaluate(() => (window as any).__abPickStep('up'))).toBe(true);
    await page.waitForTimeout(120);
    const up = last('pick');
    expect(up.tag).toBe('div');
    // #r2 has an id, so cssPath must short-circuit to it.
    expect(up.css).toBe('#r2');
    expect(up.hasChild).toBe(true);

    expect(await page.evaluate(() => (window as any).__abPickStep('down'))).toBe(true);
    await page.waitForTimeout(120);
    expect(last('pick').tag).toBe('button');
  });

  browserIt('refuses to walk above <body> and reports it', async () => {
    const { page } = await armedPage();
    const box = (await page.locator('#hero').boundingBox())!;
    await page.mouse.move(box.x + 300, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 300, box.y + 5);
    await page.waitForTimeout(150);
    // #hero → body → (html is refused)
    expect(await page.evaluate(() => (window as any).__abPickStep('up'))).toBe(true);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__abPickStep('up'))).toBe(false);
  });
});

describe('picker drive: the match count is the truth', () => {
  browserIt('counts a unique selector as 1 and a shared class as many', async () => {
    const { page, last } = await armedPage();
    expect(await page.evaluate(() => (window as any).__abVerify('#r2 button'))).toBe(1);
    await page.waitForTimeout(80);
    expect(last('verify').count).toBe(1);

    // Two buttons share `.btn.go` — this is the "silently matches N nodes"
    // case the count exists to expose.
    expect(await page.evaluate(() => (window as any).__abVerify('.btn.go'))).toBe(2);
    await page.waitForTimeout(80);
    expect(last('verify').count).toBe(2);
  });

  browserIt('reports 0 for no match and -1 for an invalid selector', async () => {
    const { page, last } = await armedPage();
    expect(await page.evaluate(() => (window as any).__abVerify('.nope'))).toBe(0);
    await page.waitForTimeout(80);
    expect(last('verify').count).toBe(0);

    expect(await page.evaluate(() => (window as any).__abVerify('div[['))).toBe(-1);
    await page.waitForTimeout(80);
    expect(last('verify').count).toBe(-1);
  });

  browserIt('counts XPath through document.evaluate, like locator() does', async () => {
    const { page } = await armedPage();
    // Same sniffing rule as matchCount(): a leading / or ( means XPath.
    expect(await page.evaluate(() => (window as any).__abVerify('//button'))).toBe(2);
    expect(await page.evaluate(() => (window as any).__abVerify('//*[@id="r2"]'))).toBe(1);
  });

  browserIt('the xpath it generates resolves to the element it picked', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('#r3 a').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(150);

    const p = last('pick');
    expect(p.xpath).toBeTruthy();
    const same = await page.evaluate((xp: string) => {
      const r = document.evaluate(xp, document, null, 7, null);
      return r.snapshotLength === 1 && r.snapshotItem(0) === document.getElementById('link');
    }, p.xpath);
    expect(same, `xpath was ${p.xpath}`).toBe(true);
  });
});

describe('picker drive: candidate selectors (§ 6.5)', () => {
  browserIt('offers stable hooks before the brittle nth-of-type path', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('[data-testid="hero-badge"]').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(200);

    const p = last('pick') as Payload & { candidates?: { sel: string; count: number }[] };
    const cands = p.candidates || [];
    expect(cands.length, 'a pick must carry candidates').toBeGreaterThan(0);
    // Every candidate must actually match something — never offer a miss.
    for (const c of cands) expect(c.count).toBeGreaterThan(0);
    // The data-testid hook must be present and must be preferred over a path
    // built from :nth-of-type.
    const testid = cands.findIndex((c) => c.sel.indexOf('data-testid') >= 0);
    expect(testid, 'data-testid must be offered').toBeGreaterThanOrEqual(0);
    const nth = cands.findIndex((c) => c.sel.indexOf(':nth-of-type') >= 0);
    if (nth >= 0) expect(testid).toBeLessThan(nth);
    // And the winner has to be unique.
    expect(cands[0].count).toBe(1);
  });

  browserIt('prefers a unique candidate over a shorter ambiguous one', async () => {
    const { page, last } = await armedPage();
    // `.btn.go` matches 2 buttons; `[name="second"]` matches 1.
    const box = (await page.locator('#r2 button').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(200);

    const cands = (last('pick') as any).candidates as { sel: string; count: number }[];
    expect(cands[0].count).toBe(1);
    expect(cands.some((c) => c.sel.indexOf('name="second"') >= 0)).toBe(true);
  });

  browserIt('reports which match the picked element is (#N of count)', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('#r2 button').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(200);
    const p = last('pick') as Payload & { index?: number };
    // cssPath here resolves through #r2, so it is unique → #1 of 1.
    expect(p.count).toBe(1);
    expect(p.index).toBe(1);
  });

  browserIt('hover stays cheap: no candidates on the hover channel', async () => {
    const { page, last } = await armedPage();
    const box = (await page.locator('#r1 button').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(200);
    const cands = (last('hover') as any).candidates;
    expect(Array.isArray(cands) ? cands.length : 0).toBe(0);
  });
});

describe('picker drive: programmatic clicks are not picks', () => {
  // The cookie-consent auto-dismisser calls el.click() while the picker is
  // armed. If the picker swallowed that (capture + preventDefault) the consent
  // wall would never close, and the picker would also hijack any click the page
  // makes on itself.
  browserIt('el.click() neither picks nor gets preventDefaulted', async () => {
    const { page, seen } = await armedPage();
    const picksBefore = seen.filter((p) => p.k === 'pick').length;
    const defaultRan = await page.evaluate(() => {
      let ran = 0;
      const b = document.querySelector('#r1 button') as HTMLElement;
      b.addEventListener('click', () => { ran++; });
      b.click();
      return ran;
    });
    await page.waitForTimeout(200);
    // the page's own handler ran…
    expect(defaultRan).toBe(1);
    // …and the picker did not treat it as a pick
    expect(seen.filter((p) => p.k === 'pick').length).toBe(picksBefore);
  });
});

describe('picker drive: teardown', () => {
  browserIt('__abStopPicker removes the overlay and stops reporting', async () => {
    const { page, seen } = await armedPage();
    await page.evaluate(() => (window as any).__abStopPicker());
    const countAfterStop = seen.length;
    const box = (await page.locator('#r1 button').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(200);
    expect(seen.length).toBe(countAfterStop);
    expect(await page.evaluate(() => (window as any).__abPickerActive)).toBe(false);
  });
});
