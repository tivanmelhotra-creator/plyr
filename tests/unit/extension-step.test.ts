/**
 * core/ExtensionStep — naming, URL building, which runs need Real Chrome, the
 * one-at-a-time lock, the confined context view, and the step itself.
 *
 * The browser is faked at the Playwright surface the module actually uses, so
 * nothing here launches Chrome (extensions need a headed one).
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  EXT_BROWSER_FLAG,
  ExtensionStepError,
  closeOwnedPages,
  confineContextToOwnedPages,
  extensionSlug,
  extensionTargetUrl,
  findExtension,
  runOpenExtensionStep,
  stepsUseExtensions,
  trackOwnedPage,
  withExtensionRunLock,
  type LoadedExtension,
} from '../../src/core/ExtensionStep';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

function ext(over: Partial<LoadedExtension> & { name: string; runtimeId: string }): LoadedExtension {
  const base = `chrome-extension://${over.runtimeId}/`;
  return {
    id: over.runtimeId,
    url: base,
    popupUrl: base + 'popup.html',
    optionsUrl: '',
    ...over,
  };
}

const J2 = ext({ name: 'J2TEAM Cookies', runtimeId: ID_A, storeId: 'okpidcojinmlaakglciglbpcpajaibco' });
const OTHER = ext({ name: 'Other Tool', runtimeId: ID_B, optionsUrl: `chrome-extension://${ID_B}/options.html` });

// ── fakes ──────────────────────────────────────────────────────────────────
class FakePage extends EventEmitter {
  closed = false;
  currentUrl: string;
  openerPage: FakePage | null = null;
  gotoImpl: (url: string) => Promise<void> = async () => {};
  constructor(url = 'about:blank') { super(); this.currentUrl = url; }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
  async goto(url: string) { await this.gotoImpl(url); this.currentUrl = url; }
  async bringToFront() {}
  async opener() { return this.openerPage; }
}

class FakeContext extends EventEmitter {
  all: FakePage[] = [];
  cookiesCalls = 0;
  pages() { return this.all.filter((p) => !p.closed); }
  async newPage() { const p = new FakePage(); this.all.push(p); return p; }
  async cookies() { this.cookiesCalls++; return [{ name: 'x' }]; }
  off(ev: string, fn: (...a: any[]) => void) { return super.off(ev, fn); }
}

// ── naming ─────────────────────────────────────────────────────────────────
describe('extensionSlug', () => {
  it('turns the manifest name into a stable public slug', () => {
    expect(extensionSlug('J2TEAM Cookies')).toBe('j2team-cookies');
    expect(extensionSlug('  Cookie-Editor  (Pro)! ')).toBe('cookie-editor-pro');
  });
  it('keeps non-Latin names usable instead of producing an empty slug', () => {
    expect(extensionSlug('مدیریت کوکی')).toBe('مدیریت-کوکی');
  });
  it('is empty for nothing', () => {
    expect(extensionSlug('')).toBe('');
    expect(extensionSlug(undefined as unknown as string)).toBe('');
  });
});

describe('findExtension', () => {
  const list = [J2, OTHER];

  it('finds by slug however the name is cased or spaced', () => {
    expect(findExtension(list, 'j2team-cookies')).toBe(J2);
    expect(findExtension(list, 'J2TEAM Cookies')).toBe(J2);
    expect(findExtension(list, '  j2team   cookies ')).toBe(J2);
  });

  it('accepts a raw runtime id or store id as an escape hatch', () => {
    expect(findExtension(list, ID_B)).toBe(OTHER);
    expect(findExtension(list, 'okpidcojinmlaakglciglbpcpajaibco')).toBe(J2);
  });

  it('never guesses: a partial name is not a match, and the error lists what is installed', () => {
    expect(() => findExtension(list, 'j2team')).toThrow(ExtensionStepError);
    expect(() => findExtension(list, 'j2team')).toThrow(/j2team-cookies \("J2TEAM Cookies"\), other-tool/);
  });

  it('refuses an ambiguous name and names the candidates by id', () => {
    const dup = ext({ name: 'J2TEAM  cookies', runtimeId: ID_B });
    expect(() => findExtension([J2, dup], 'j2team-cookies')).toThrow(new RegExp(`${ID_A}.*${ID_B}`));
  });

  it('an empty query, or nothing installed, is a clear error', () => {
    expect(() => findExtension(list, '  ')).toThrow(/Extension is required/);
    expect(() => findExtension([], 'x')).toThrow(/No extension is loaded/);
  });
});

// ── url ────────────────────────────────────────────────────────────────────
describe('extensionTargetUrl', () => {
  it('defaults to the popup, falling back to options, then the root', () => {
    expect(extensionTargetUrl(J2, '', '')).toBe(`chrome-extension://${ID_A}/popup.html`);
    expect(extensionTargetUrl(J2, 'POPUP', '')).toBe(`chrome-extension://${ID_A}/popup.html`);
    expect(extensionTargetUrl(OTHER, '', '').endsWith('/popup.html')).toBe(true);
    const optionsOnly = ext({ name: 'O', runtimeId: ID_B, popupUrl: '', optionsUrl: `chrome-extension://${ID_B}/o.html` });
    expect(extensionTargetUrl(optionsOnly, '', '')).toBe(`chrome-extension://${ID_B}/o.html`);
    const rootOnly = ext({ name: 'R', runtimeId: ID_B, popupUrl: '' });
    expect(extensionTargetUrl(rootOnly, '', '')).toBe(`chrome-extension://${ID_B}/`);
  });

  it('options needs an options page', () => {
    expect(extensionTargetUrl(OTHER, 'options', '')).toBe(`chrome-extension://${ID_B}/options.html`);
    expect(() => extensionTargetUrl(J2, 'options', '')).toThrow(/no options page/);
  });

  it('opens a path inside the extension', () => {
    expect(extensionTargetUrl(J2, 'pages/main.html', '')).toBe(`chrome-extension://${ID_A}/pages/main.html`);
    expect(extensionTargetUrl(J2, '/pages/main.html?tab=1', '')).toBe(`chrome-extension://${ID_A}/pages/main.html?tab=1`);
  });

  it.each([
    '../x.html', 'a/../../x', 'https://evil.example/', 'javascript:alert(1)', '//evil.example/x',
    'data:text/html,hi', 'a\\b.html', 'chrome://settings',
  ])('refuses %s: only pages inside the extension are reachable', (bad) => {
    expect(() => extensionTargetUrl(J2, bad, '')).toThrow(ExtensionStepError);
  });

  it('adds the site the extension is opened for, so active-tab extensions do not read the popup tab', () => {
    const u = new URL(extensionTargetUrl(J2, '', 'https://example.com/a?b=1'));
    // (not u.origin: that is the opaque string "null" for chrome-extension://)
    expect(u.href.split('?')[0]).toBe(`chrome-extension://${ID_A}/popup.html`);
    const decoded = Buffer.from(decodeURIComponent(u.searchParams.get('url')!), 'base64').toString();
    expect(decoded).toBe('https://example.com/a?b=1');
  });

  it('ignores a site that is not http(s)', () => {
    expect(extensionTargetUrl(J2, '', 'about:blank')).toBe(`chrome-extension://${ID_A}/popup.html`);
  });
});

// ── which runs need Real Chrome ────────────────────────────────────────────
describe('stepsUseExtensions', () => {
  it('is false for an ordinary workflow, so it takes the normal path', () => {
    expect(stepsUseExtensions([{ action: 'goto', params: { url: 'https://x.test' } }, { action: 'click' }])).toBe(false);
    expect(stepsUseExtensions([])).toBe(false);
    expect(stepsUseExtensions(undefined)).toBe(false);
    expect(stepsUseExtensions('open-extension')).toBe(false);
  });

  it('finds the step at the top level, in either spelling', () => {
    expect(stepsUseExtensions([{ action: 'open-extension' }])).toBe(true);
    expect(stepsUseExtensions([{ action: 'goto' }, { action: 'open_extension' }])).toBe(true);
  });

  it('finds it inside nested branches', () => {
    expect(stepsUseExtensions([{ action: 'if', then: [{ action: 'loop', steps: [{ action: 'open-extension' }] }] }])).toBe(true);
    expect(stepsUseExtensions([{ action: 'try', catch: [{ action: 'x' }], finally: [{ action: 'open-extension' }] }])).toBe(true);
    expect(stepsUseExtensions([{ action: 'switch', cases: [{ steps: [{ action: 'open-extension' }] }] }])).toBe(true);
  });

  it('does not look inside params: data that mentions the word must not change the browser', () => {
    expect(stepsUseExtensions([{ action: 'http-request', params: { body: { action: 'open-extension' } } }])).toBe(false);
  });

  it('survives a cyclic or enormous tree', () => {
    const a: Record<string, unknown> = { action: 'x' };
    a.steps = [a];
    expect(stepsUseExtensions([a])).toBe(false);
    const wide = Array.from({ length: 50_000 }, () => ({ action: 'x', steps: [{ action: 'y' }] }));
    expect(stepsUseExtensions(wide)).toBe(false);
  });
});

// ── lock ───────────────────────────────────────────────────────────────────
describe('withExtensionRunLock', () => {
  it('runs extension workflows one after another, in order', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => withExtensionRunLock(async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    });
    const results = await Promise.all([slow('a', 40), slow('b', 5), slow('c', 5)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a failing run still lets the next one go', async () => {
    const first = withExtensionRunLock(async () => { throw new Error('boom'); });
    await expect(first).rejects.toThrow('boom');
    await expect(withExtensionRunLock(async () => 'ok')).resolves.toBe('ok');
  });

  it('tells the log it is waiting, and gives up after the timeout without blocking those behind it', async () => {
    const log = vi.fn();
    let release!: () => void;
    const holder = withExtensionRunLock(() => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 5));

    await expect(withExtensionRunLock(async () => 'never', { log, timeoutMs: 30 })).rejects.toThrow(/Timed out waiting/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('waiting'));

    const after = withExtensionRunLock(async () => 'after');
    release();
    await holder;
    await expect(after).resolves.toBe('after');
  });
});

// ── confined context ───────────────────────────────────────────────────────
describe('confineContextToOwnedPages', () => {
  it('shows a run only its own tabs, never the operator\'s', async () => {
    const real = new FakeContext();
    const operatorTab = await real.newPage();
    operatorTab.currentUrl = 'https://site.test/the-operators-work';
    const data: Record<string, any> = {};
    const view = confineContextToOwnedPages(real as never, data);

    expect(view.pages()).toEqual([]);
    const mine = await view.newPage();
    expect(view.pages()).toEqual([mine]);
    expect(real.pages()).toHaveLength(2); // the real browser has both
    expect(view.pages()).not.toContain(operatorTab);
  });

  it('adopts a popup opened by one of its own tabs, and ignores one opened by anyone else', async () => {
    const real = new FakeContext();
    const data: Record<string, any> = {};
    const view = confineContextToOwnedPages(real as never, data);
    const mine = await view.newPage() as unknown as FakePage;

    const popup = new FakePage('https://popup.test');
    popup.openerPage = mine;
    real.all.push(popup);
    real.emit('page', popup);

    const stranger = new FakePage('https://other.test');
    real.all.push(stranger);
    real.emit('page', stranger);

    await vi.waitFor(() => expect(view.pages()).toContain(popup));
    expect(view.pages()).not.toContain(stranger);
  });

  it('passes every other call straight through to the real context', async () => {
    const real = new FakeContext();
    const view = confineContextToOwnedPages(real as never, {});
    expect(await (view as unknown as FakeContext).cookies()).toEqual([{ name: 'x' }]);
    expect(real.cookiesCalls).toBe(1);
  });

  it('closeOwnedPages closes this run\'s tabs only, and stops listening', async () => {
    const real = new FakeContext();
    const operatorTab = await real.newPage();
    const data: Record<string, any> = {};
    const view = confineContextToOwnedPages(real as never, data);
    const a = await view.newPage() as unknown as FakePage;
    const b = await view.newPage() as unknown as FakePage;

    await closeOwnedPages(data);

    expect(a.closed && b.closed).toBe(true);
    expect(operatorTab.closed).toBe(false);
    expect(real.listenerCount('page')).toBe(0);
    await expect(closeOwnedPages(data)).resolves.toBeUndefined(); // idempotent
  });
});

// ── the step ───────────────────────────────────────────────────────────────
describe('runOpenExtensionStep', () => {
  function setup(currentUrl = 'https://site.test/login') {
    const real = new FakeContext();
    const data: Record<string, any> = { [EXT_BROWSER_FLAG]: true };
    const browserContext = confineContextToOwnedPages(real as never, data);
    const sitePage = new FakePage(currentUrl);
    real.all.push(sitePage);
    trackOwnedPage(data, sitePage as never);
    const ctx = { browserContext, page: sitePage as never, data } as { browserContext: any; page: any; data: Record<string, any> };
    return { real, data, ctx, sitePage };
  }
  const deps = { listExtensions: () => [J2, OTHER] };

  it('refuses to run anywhere but Real Chrome, and says why', async () => {
    const { ctx } = setup();
    delete ctx.data[EXT_BROWSER_FLAG];
    await expect(runOpenExtensionStep(ctx, { extension: 'j2team-cookies' }, deps))
      .rejects.toThrow(/only in the server's Real Chrome/);
  });

  it('opens the popup in a NEW tab, for the site the run is on, and makes it the current page', async () => {
    const { ctx, sitePage, real } = setup();
    const out = await runOpenExtensionStep(ctx, { extension: 'J2TEAM Cookies' }, deps);

    expect(out).toMatchObject({ extension: 'J2TEAM Cookies', extensionId: ID_A, newTab: true, forSite: 'https://site.test/login' });
    expect(out.url.startsWith(`chrome-extension://${ID_A}/popup.html?url=`)).toBe(true);
    expect(ctx.page).not.toBe(sitePage);
    expect(ctx.page.url()).toBe(out.url);
    expect(sitePage.closed).toBe(false); // the site tab is still there to come back to
    expect(real.pages()).toHaveLength(2);
  });

  it('an explicit forSite wins over the current page; a non-http current page adds none', async () => {
    const a = setup();
    const withSite = await runOpenExtensionStep(a.ctx, { extension: 'j2team-cookies', forSite: 'https://chosen.test/' }, deps);
    expect(withSite.forSite).toBe('https://chosen.test/');

    const b = setup('about:blank');
    const without = await runOpenExtensionStep(b.ctx, { extension: 'j2team-cookies' }, deps);
    expect(without.forSite).toBeUndefined();
    expect(without.url).toBe(`chrome-extension://${ID_A}/popup.html`);
  });

  it('sameTab navigates the current tab instead of opening one', async () => {
    const { ctx, sitePage, real } = setup();
    const out = await runOpenExtensionStep(ctx, { extension: 'j2team-cookies', sameTab: true }, deps);
    expect(out.newTab).toBe(false);
    expect(ctx.page).toBe(sitePage);
    expect(real.pages()).toHaveLength(1);
  });

  it('opens a chosen page and honours the options page', async () => {
    const { ctx } = setup();
    const out = await runOpenExtensionStep(ctx, { extension: 'other-tool', page: 'options' }, deps);
    expect(out.url.startsWith(`chrome-extension://${ID_B}/options.html`)).toBe(true);
  });

  it('a page that will not open closes the tab it made and explains', async () => {
    const { ctx, real, sitePage } = setup();
    const original = real.newPage.bind(real);
    real.newPage = async () => {
      const p = await original();
      p.gotoImpl = async () => { throw new Error('net::ERR_BLOCKED_BY_CLIENT'); };
      return p;
    };
    await expect(runOpenExtensionStep(ctx, { extension: 'j2team-cookies' }, deps))
      .rejects.toThrow(/Could not open "J2TEAM Cookies".*ERR_BLOCKED_BY_CLIENT.*enabled in Real Chrome/);
    expect(ctx.page).toBe(sitePage); // still on the page it was on
    expect(real.all.filter((p) => p !== sitePage).every((p) => p.closed)).toBe(true);
  });

  it('an unknown extension fails before any tab is opened', async () => {
    const { ctx, real } = setup();
    await expect(runOpenExtensionStep(ctx, { extension: 'nope' }, deps)).rejects.toThrow(/No installed extension matches "nope"/);
    expect(real.pages()).toHaveLength(1);
  });
});
