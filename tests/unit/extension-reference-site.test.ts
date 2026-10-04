/**
 * "Open here" must open an extension FOR the site the operator is working on.
 * Reported: it produced `Cookies for 127.0.0.1` (this app's own tab) instead of
 * `Cookies for arena.ai`, so a cookie extension had no real site to import or
 * export for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { RealChrome, isOwnAppUrl } from '../../src/core/RealChrome';
import { chromeViewHtml } from '../../src/core/ChromeView';

describe('isOwnAppUrl', () => {
  it('flags the app on loopback at its own port, and the host the request used', () => {
    expect(isOwnAppUrl('http://127.0.0.1:3000/', [], 3000)).toBe(true);
    expect(isOwnAppUrl('http://localhost:3000/desktop/chrome', [], 3000)).toBe(true);
    expect(isOwnAppUrl('https://plyr.example.com/x', ['plyr.example.com'], 3000)).toBe(true);
  });

  it('never flags a real site, another local port, or a non-http page', () => {
    expect(isOwnAppUrl('https://arena.ai/', [], 3000)).toBe(false);
    expect(isOwnAppUrl('http://127.0.0.1:8080/', [], 3000)).toBe(false);
    expect(isOwnAppUrl('chrome-extension://abc/popup.html', [], 3000)).toBe(false);
    expect(isOwnAppUrl('not a url', [], 3000)).toBe(false);
  });
});

function fakePage(url: string, visible: boolean, focused: boolean, title = '') {
  return {
    url: () => url,
    title: async () => title,
    evaluate: async () => ({ visible, focused }),
  };
}

describe('siteTabs / activeSiteUrl', () => {
  const R = RealChrome as unknown as { context: unknown };
  afterEach(() => { R.context = null; });

  it('skips this app and picks the focused site tab', async () => {
    R.context = {
      pages: () => [
        fakePage('http://127.0.0.1:3000/', true, false),          // the app itself, visible
        fakePage('https://example.org/', false, false),            // background
        fakePage('https://arena.ai/', true, true, 'Arena'),        // the one in front
        fakePage('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html', true, true),
        fakePage('about:blank', true, true),
      ],
    };
    const tabs = await RealChrome.siteTabs();
    expect(tabs.map((t) => t.url)).toEqual(['https://arena.ai/', 'https://example.org/']);
    expect(await RealChrome.activeSiteUrl()).toBe('https://arena.ai/');
  });

  it('answers "" rather than guessing a hidden background tab', async () => {
    R.context = { pages: () => [fakePage('https://example.org/', false, false)] };
    expect(await RealChrome.activeSiteUrl()).toBe('');
    expect((await RealChrome.siteTabs()).map((t) => t.url)).toEqual(['https://example.org/']);
  });

  it('falls back to a visible tab when the window has lost focus', async () => {
    R.context = { pages: () => [fakePage('https://arena.ai/', true, false)] };
    expect(await RealChrome.activeSiteUrl()).toBe('https://arena.ai/');
  });
});

describe('the Extensions panel in ChromeView', () => {
  it('has a site picker and sends the chosen site when opening', () => {
    const html = chromeViewHtml();
    expect(html).toContain('id="ext-site"');
    expect(html).toContain('/browser/extensions/sites');
    expect(html).toContain('for: extSite ? extSite.value');
  });
});
