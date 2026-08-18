/**
 * The extension popup must be told WHICH page it is being opened for.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * "Open here" opens an extension's popup as a TAB. A popup normally runs beside
 * an active tab, and the way an extension learns which site to act on is
 * `chrome.tabs.query({active: true})` — which, once the popup IS the active tab,
 * returns the popup's own `chrome-extension://` page. That page has no cookies
 * and no site.
 *
 * Reported symptom, reproduced with the real J2TEAM Cookies extension in a
 * headed Chrome (transient probe, since deleted):
 *
 *   popup.html              → header "Cookies for this page", downloads: []
 *   popup.html?url=<base64> → header "Cookies for 127.0.0.1",
 *                             downloads: ["127.0.0.1_09-08-2026.json"]
 *
 * Import kept working throughout (it reads a file, so it needs no site), which is
 * exactly why the user saw "import works, export does nothing".
 *
 * WHAT THESE TESTS RUN
 * --------------------
 * The fix spans four places — a server helper, a client helper, the click
 * handler, and the picker that supplies the page — and a fix that is correct but
 * UNWIRED would look fine in review while the UI stayed broken. So nothing here
 * asserts on source text: every test executes real shipped code.
 *
 *   * the server helper is IMPORTED from src/core/RealChrome.ts,
 *   * the client helper, the "Open here" handler, the panel's `current` assembly
 *     and the picker's getter are EXTRACTED from the browser files and EXECUTED
 *     (browser files cannot be imported, and asserting a string exists is not a
 *     test this repo accepts),
 *   * and one test decodes the parameter the way the extension itself does, to
 *     prove client and server cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionPageUrlFor } from '../../src/core/RealChrome';

const POPUP = 'chrome-extension://ghmpbnkgbnbokjcohlejopmmockpjpfc/popup.html';

const RC = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'real-chrome.js'), 'utf8');
const VIEW = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'browser-view.js'), 'utf8');

/** Slice out a brace-balanced block starting at the first `{` at/after `from`. */
function block(src: string, from: number): { start: number; end: number; body: string } {
  const start = src.indexOf('{', from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { start, end: i, body: src.slice(start + 1, i) };
    }
  }
  throw new Error('unbalanced braces while extracting a block');
}

/**
 * Load the REAL browser-side helper, so these tests exercise the shipped code
 * rather than a restatement of its idea.
 */
function loadClientHelper(): (popupUrl: string, pageUrl: string) => string {
  const at = RC.indexOf('function pageUrlParam(');
  if (at < 0) throw new Error('pageUrlParam() not found in public/js/real-chrome.js');
  const { end } = block(RC, at);
  // btoa/atob/URL are browser globals; Node 22 provides all three with the same
  // semantics, including btoa throwing on code units > 0xff.
  return new Function(`${RC.slice(at, end + 1)}; return pageUrlParam;`)() as (
    p: string, u: string,
  ) => string;
}

const clientHelper = loadClientHelper();

/** Decode the parameter the way the extension does: atob, then new URL(). */
function decodeParam(url: string): string | null {
  const q = url.indexOf('?');
  if (q < 0) return null;
  const value = new URLSearchParams(url.slice(q + 1)).get('url');
  if (!value) return null;
  return Buffer.from(value, 'base64').toString('utf8');
}

describe('an extension popup opened as a tab is told which page it is for', () => {
  it('carries the page URL, so an "export this site" action has a site', () => {
    const out = extensionPageUrlFor('https://example.com/', POPUP);
    // The extension resolves the site from this parameter; without it, its
    // handler returns early and the click does nothing at all.
    expect(decodeParam(out)).toBe('https://example.com/');
  });

  it('the decoded value yields the origin the extension will read cookies for', () => {
    const out = extensionPageUrlFor('https://shop.example.com/cart?id=7#top', POPUP);
    expect(new URL(decodeParam(out)!).origin).toBe('https://shop.example.com');
  });

  it('keeps the popup path intact — the URL still points at the popup page', () => {
    const out = extensionPageUrlFor('https://example.com/', POPUP);
    expect(out.startsWith(`${POPUP}?`)).toBe(true);
    expect(new URL(out).pathname).toBe('/popup.html');
  });

  // ── The non-ASCII trap. btoa() throws above 0xff, and this repo has already
  // shipped one bug of that exact shape. A Persian URL must not break the
  // feature it is meant to enable. ──────────────────────────────────────────
  it('survives an IDN host, encoding punycode rather than throwing', () => {
    const decoded = decodeParam(extensionPageUrlFor('https://مهدی.com/', POPUP))!;
    expect(new URL(decoded).origin).toBe('https://xn--ugb7bg74c.com');
    // ASCII-only, or the browser's own btoa could not have produced it.
    expect(/^[\x00-\x7F]*$/.test(decoded)).toBe(true);
  });

  it('survives a unicode path and query', () => {
    const decoded = decodeParam(
      extensionPageUrlFor('https://example.com/مسیر?q=مهدی', POPUP),
    )!;
    expect(/^[\x00-\x7F]*$/.test(decoded)).toBe(true);
    expect(new URL(decoded).origin).toBe('https://example.com');
  });

  it('the client helper does not throw on a Persian URL either', () => {
    // btoa() on the raw string WOULD throw; this asserts the shipped client code
    // normalises first, because a throw here would break "Open here" entirely.
    expect(() => clientHelper(POPUP, 'https://مهدی.com/')).not.toThrow();
    const decoded = decodeParam(clientHelper(POPUP, 'https://مهدی.com/'))!;
    expect(new URL(decoded).origin).toBe('https://xn--ugb7bg74c.com');
  });

  // ── Cases where adding the parameter would be wrong ───────────────────────
  it('adds nothing for a page that has no site (about:blank)', () => {
    // origin would be `null` — not a site any cookie belongs to. Better to leave
    // the extension showing "this page" than to hand it a bogus answer.
    expect(extensionPageUrlFor('about:blank', POPUP)).toBe(POPUP);
  });

  it('adds nothing when the current page is itself an extension page', () => {
    // Reopening the panel after "Open here" must not feed the popup its own URL.
    expect(extensionPageUrlFor(`${POPUP}?url=abc`, POPUP)).toBe(POPUP);
  });

  it('adds nothing for an empty or half-typed URL field', () => {
    expect(extensionPageUrlFor('', POPUP)).toBe(POPUP);
    expect(extensionPageUrlFor('exa', POPUP)).toBe(POPUP);
  });

  it('never overwrites a url parameter the page already carries', () => {
    const already = `${POPUP}?url=ZXhpc3Rpbmc%3D`;
    expect(extensionPageUrlFor('https://example.com/', already)).toBe(already);
  });

  it('appends with & when the popup URL already has a query string', () => {
    const withQuery = `${POPUP}?theme=dark`;
    const out = extensionPageUrlFor('https://example.com/', withQuery);
    expect(new URLSearchParams(out.slice(out.indexOf('?') + 1)).get('theme')).toBe('dark');
    expect(decodeParam(out)).toBe('https://example.com/');
  });

  it('an empty popup URL stays empty (nothing to open, nothing to annotate)', () => {
    expect(extensionPageUrlFor('https://example.com/', '')).toBe('');
  });

  // ── The two implementations must not drift ────────────────────────────────
  it('client and server build the identical URL', () => {
    for (const page of [
      'https://example.com/',
      'http://127.0.0.1:8080/x?a=1',
      'https://مهدی.com/',
      'https://example.com/مسیر?q=مهدی',
      'about:blank',
      '',
      'exa',
    ]) {
      expect(clientHelper(POPUP, page), `page=${page}`)
        .toBe(extensionPageUrlFor(page, POPUP));
    }
  });
});

/**
 * The helper being correct is not enough: if nothing supplies the page URL, the
 * UI stays exactly as broken as it was. These execute the REAL click handler, the
 * REAL panel state assembly and the REAL picker getter, so an unwired fix — at
 * any one of the three joints — fails here.
 */
describe('"Open here" is actually wired to the current page', () => {
  /** Run the real click handler with a fake `current`, capturing the navigation. */
  function runOpenHereHandler(opts: { pageUrl?: () => string; extUrl?: string }) {
    const marker = "openBtn.addEventListener('click', function () {";
    const at = RC.indexOf(marker);
    if (at < 0) throw new Error('the "Open here" click handler moved');
    const { body } = block(RC, at + marker.length - 1);

    const navigated: string[] = [];
    const ext = { popupUrl: opts.extUrl ?? POPUP, optionsUrl: '', url: '' };
    const current = {
      onNavigate: (u: string) => { navigated.push(u); },
      pageUrl: opts.pageUrl,
    };
    // The handler also calls close(); give it a harmless one.
    new Function('ext', 'current', 'pageUrlParam', 'close', body)(
      ext, current, clientHelper, () => {},
    );
    return navigated;
  }

  it('sends the popup URL annotated with the page the canvas is on', () => {
    const [url] = runOpenHereHandler({ pageUrl: () => 'https://example.com/login' });
    expect(decodeParam(url)).toBe('https://example.com/login');
  });

  it('reads the page URL AT CLICK TIME, not when the panel opened', () => {
    // The panel can sit open while the canvas navigates; the extension must be
    // told about the page the user is looking at now.
    let live = 'https://first.example/';
    expect(decodeParam(runOpenHereHandler({ pageUrl: () => live })[0]))
      .toBe('https://first.example/');
    live = 'https://second.example/';
    expect(decodeParam(runOpenHereHandler({ pageUrl: () => live })[0]))
      .toBe('https://second.example/');
  });

  it('still opens the popup when no page getter is supplied', () => {
    // Older callers, and the panel opened outside the picker, must not break.
    expect(runOpenHereHandler({})[0]).toBe(POPUP);
  });

  it('still opens the popup if the page getter throws', () => {
    expect(runOpenHereHandler({ pageUrl: () => { throw new Error('boom'); } })[0])
      .toBe(POPUP);
  });

  it('the panel keeps the caller\'s page getter reachable from the handler', () => {
    // The joint between openPanel() and the click handler: run the real
    // `current = {...}` assignment and check the handler can still call through.
    // Without this, dropping `pageUrl` while storing state would silently undo
    // the whole fix and every other test here would still pass.
    const at = RC.indexOf('current = {');
    expect(at, 'the panel no longer builds `current` as an object literal')
      .toBeGreaterThan(-1);
    const { start, end } = block(RC, at);
    const getter = () => 'https://wired.example/';
    const built = new Function(
      'opts', 'root', `return ${RC.slice(start, end + 1)};`,
    )({ pageUrl: getter, onNavigate: () => {} }, {}) as { pageUrl?: () => string };
    expect(typeof built.pageUrl).toBe('function');
    expect(built.pageUrl!()).toBe('https://wired.example/');
  });

  it('the picker supplies a pageUrl getter that follows its URL field', () => {
    // browser-view.js is the caller. Run its getter to prove it returns the live
    // value of the URL input rather than a constant captured once.
    const at = VIEW.indexOf('pageUrl: function ()');
    expect(at, 'browser-view.js no longer passes pageUrl to the panel')
      .toBeGreaterThan(-1);
    const { start, end } = block(VIEW, at);
    const urlIn = { value: '  https://live.example/page  ' };
    const getter = new Function(
      'urlIn', `return function () ${VIEW.slice(start, end + 1)}`,
    )(urlIn) as () => string;
    expect(getter()).toBe('https://live.example/page');
    urlIn.value = 'https://changed.example/';
    expect(getter()).toBe('https://changed.example/');
  });
});

describe('RealChrome.extensionPageUrl passes the page through', () => {
  it('is unchanged when no page is supplied, so other callers keep working', async () => {
    const { RealChrome } = await import('../../src/core/RealChrome');
    // No extensions are loaded in a unit test, so both calls resolve to ''. The
    // point is that supplying the extra argument cannot make it throw or differ.
    expect(RealChrome.extensionPageUrl('nope')).toBe('');
    expect(RealChrome.extensionPageUrl('nope', 'https://example.com/')).toBe('');
  });
});
