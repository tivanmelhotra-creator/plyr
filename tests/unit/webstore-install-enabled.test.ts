/**
 * webstore-install.test.ts — "Installation is not enabled" was OUR bug.
 *
 * THE REPORT, VERBATIM
 * --------------------
 *   «نمیشه ریموت پلاگین نصب کرد و میگه انستالیشن نات اینیبل»
 * and then, correcting the first answer I gave:
 *   «الان کیخام وقتی از پلی استور پلاگین های کروم add extension رو میزنم
 *    اونجوری نصب بشه و ارور Installation is not enabled نیاد»
 *
 * So: routing the user to our own uploader was REJECTED. Pressing "Add to
 * Chrome" on a real Chrome Web Store page inside the remote browser has to
 * work.
 *
 * THE CAUSE, TRACED IN CHROMIUM `main`
 * ------------------------------------
 * The message is Chromium's, but the switch that produces it was thrown by us:
 *
 *   extension_util.cc:71-74      ExtensionsDisabledViaCommandLine() is TRUE for
 *                                --disable-extensions OR
 *                                --disable-extensions-except
 *   extension_util.cc:362-367    AreExtensionsDisabled() = that OR the profile
 *                                pref prefs::kDisableExtensions
 *   extension_registrar.cc:104-117  Init() then forces extensions_enabled=false
 *   crx_installer.cc:404-408     if (!extensions_enabled_) → CrxInstallError(
 *                                  DECLINED, INSTALL_NOT_ENABLED,
 *                                  IDS_EXTENSION_INSTALL_NOT_ENABLED)
 *   pref_names.h:1618            kDisableExtensions[] = "extensions.disabled"
 *
 * `--disable-extensions-except` does not mean "allow only these". To Chromium it
 * means EXTENSIONS ARE DISABLED for the whole profile: every install is refused,
 * and anything the user had added by hand goes quiet. Worse,
 * extension_service.cc:352-378 gates --load-extension on extensions_enabled()
 * while loading --disable-extensions-except unconditionally, so the flag was
 * also disabling its own sibling.
 *
 * There are therefore TWO independent gates, and both are covered here:
 *   §1  the command line  — extensionLaunchArgs must emit neither disable flag
 *   §2  the profile pref  — enableExtensionInstalls must clear extensions.disabled
 *   §3  the UI            — a store /detail/ page must offer a working install,
 *                           because Chrome's own confirmation window is a NATIVE
 *                           window that a CDP screencast can never draw.
 *
 * WHY BEHAVIOUR AND NOT GREP
 * --------------------------
 * The standing rule for this repo: «تست‌ها باید رفتار را بسنجند نه وجود رشته در
 * سورس». So the client functions are lifted out of public/js by brace balance
 * and EXECUTED against fake DOM elements and a fake API, and the profile helper
 * is run against a real temporary directory. Asserting that the string
 * `--disable-extensions-except` is absent from the source would pass against
 * code that builds the flag by concatenation.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const browserView = read('public/js/browser-view.js');

/** Lift one `function name(...) { … }` out of a source file by balancing braces. */
function grabFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in source`);
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(`no body for ${name}`);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

/** A DOM element with only the surface the store bar actually touches. */
class FakeEl {
  textContent = '';
  title = '';
  disabled = false;
  private classes = new Set<string>();
  constructor(...initial: string[]) {
    for (const c of initial) this.classes.add(c);
  }
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  get hidden(): boolean {
    return this.classes.has('is-off');
  }
}

type Toast = { text: string; kind: string };

interface Bar {
  storeIdFromUrl: (url: string) => string;
  syncStoreBar: (url: string) => void;
  installFromStorePage: () => void;
  bar: FakeEl;
  text: FakeEl;
  go: FakeEl;
  toasts: Toast[];
  posts: Array<{ path: string; body: unknown }>;
  /** Resolve or reject the next queued POST, the way the server would. */
  settle: (value: unknown, fail?: boolean) => Promise<void>;
}

/**
 * Build a live copy of the store-assist bar: the three shipped functions,
 * executed against fake elements, a fake `window.API` and a recording `toast`.
 */
function liftStoreBar(): Bar {
  const bar = new FakeEl('bvp-store', 'is-off');
  const text = new FakeEl();
  const go = new FakeEl();
  const toasts: Toast[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let resolveNext: ((v: unknown) => void) | null = null;
  let rejectNext: ((e: unknown) => void) | null = null;

  const sandbox: Record<string, unknown> = {
    storeBar: bar,
    storeText: text,
    storeGo: go,
    t: (k: string) => 'i18n:' + k,
    toast: (txt: string, kind: string) => void toasts.push({ text: txt, kind }),
    window: {
      API: {
        post: (path: string, body: unknown) => {
          posts.push({ path, body });
          return new Promise((res, rej) => {
            resolveNext = res;
            rejectNext = rej;
          });
        },
      },
    },
    String,
    RegExp,
  };

  const keys = Object.keys(sandbox);
  const body =
    'var storeId = "";\n' +
    grabFunction(browserView, 'storeIdFromUrl') + '\n' +
    grabFunction(browserView, 'syncStoreBar') + '\n' +
    grabFunction(browserView, 'installFromStorePage') + '\n' +
    'return { storeIdFromUrl: storeIdFromUrl, syncStoreBar: syncStoreBar,' +
    '  installFromStorePage: installFromStorePage };';

  const api = new Function(...keys, body)(...keys.map((k) => sandbox[k])) as {
    storeIdFromUrl: (url: string) => string;
    syncStoreBar: (url: string) => void;
    installFromStorePage: () => void;
  };

  return {
    ...api,
    bar,
    text,
    go,
    toasts,
    posts,
    settle: async (value: unknown, fail = false) => {
      if (fail) rejectNext?.(value);
      else resolveNext?.(value);
      // Let the promise chain inside the lifted function run to completion.
      await new Promise((r) => setImmediate(r));
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('§1 — the command line no longer says "extensions are disabled"', () => {
  const ext = (id: string, dir: string) => ({
    id,
    dir,
    name: id,
    version: '1.0',
    enabled: true,
    extensionId: '',
    storeId: '',
  });

  it('loads the extensions without ever disabling extensions', async () => {
    const { extensionLaunchArgs } = await import('../../src/core/ChromeExtensions');
    const args = extensionLaunchArgs([ext('a', '/p/a'), ext('b', '/p/b')]);

    // What we DO want: the two directories, on one flag, comma separated.
    expect(args).toEqual(['--load-extension=/p/a,/p/b']);

    // What must never appear again, by MEANING and not by spelling: any flag
    // whose presence makes AreExtensionsDisabled() true. Building it by
    // concatenation would still be caught here.
    const joined = args.join(' ');
    expect(/--disable-extensions(\b|-)/.test(joined)).toBe(false);
  });

  it('stays silent with nothing installed, rather than emitting an empty flag', async () => {
    const { extensionLaunchArgs } = await import('../../src/core/ChromeExtensions');
    // `--load-extension=` with no value is not harmless: Chrome treats the empty
    // path as a load failure and shows an error balloon on every start.
    expect(extensionLaunchArgs([])).toEqual([]);
  });

  it('offers no way for a user to switch extensions off by accident', async () => {
    const { FLAG_CATALOGUE } = await import('../../src/core/ChromeFlags');
    // The catalogue used to expose `disable-extensions` as a tick box. Ticking
    // it produced exactly the reported error, and Chrome got the blame. A flag
    // that can only break the product is not a choice worth offering.
    const disablers = FLAG_CATALOGUE.filter((f) =>
      /^disable-extensions/.test(f.flag),
    );
    expect(disablers).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§2 — the profile pref no longer says it either', () => {
  const tmpProfile = async () =>
    fs.mkdtemp(join(os.tmpdir(), 'ab-extpref-'));

  it('flips extensions.disabled from true to false', async () => {
    const { enableExtensionInstalls } = await import('../../src/core/RealChrome');
    const dir = await tmpProfile();
    const prefs = join(dir, 'Default', 'Preferences');
    await fs.mkdir(join(dir, 'Default'), { recursive: true });
    await fs.writeFile(
      prefs,
      JSON.stringify({ extensions: { disabled: true, settings: { keep: 1 } } }),
      'utf8',
    );

    const said = await enableExtensionInstalls(dir);
    expect(said).toBe('extensions.disabled true -> false');

    const after = JSON.parse(await fs.readFile(prefs, 'utf8'));
    expect(after.extensions.disabled).toBe(false);
    // Everything else in the profile must survive untouched: this pref file
    // holds the user's whole Chrome state, and rewriting it lossily would be a
    // far worse bug than the one being fixed.
    expect(after.extensions.settings).toEqual({ keep: 1 });
  });

  it('leaves an already-allowed profile completely alone', async () => {
    const { enableExtensionInstalls } = await import('../../src/core/RealChrome');
    const dir = await tmpProfile();
    const prefs = join(dir, 'Default', 'Preferences');
    await fs.mkdir(join(dir, 'Default'), { recursive: true });
    const original = JSON.stringify({ profile: { name: 'x' }, extensions: {} });
    await fs.writeFile(prefs, original, 'utf8');

    expect(await enableExtensionInstalls(dir)).toBe('already allowed');
    // Byte-identical, not merely equivalent: a needless rewrite on every launch
    // is a chance to corrupt the file for no gain.
    expect(await fs.readFile(prefs, 'utf8')).toBe(original);
  });

  it('does not invent a Preferences file for a fresh profile', async () => {
    const { enableExtensionInstalls } = await import('../../src/core/RealChrome');
    const dir = await tmpProfile();

    expect(await enableExtensionInstalls(dir)).toBe('no profile yet');
    // A fresh profile has nothing disabled, so there is nothing to clear.
    // Writing a half-built Preferences file here would make Chrome discard it.
    await expect(fs.access(join(dir, 'Default', 'Preferences'))).rejects.toThrow();
  });

  it('reports rather than throws when the pref file is not JSON', async () => {
    const { enableExtensionInstalls } = await import('../../src/core/RealChrome');
    const dir = await tmpProfile();
    await fs.mkdir(join(dir, 'Default'), { recursive: true });
    await fs.writeFile(join(dir, 'Default', 'Preferences'), 'not json{', 'utf8');

    // This runs on the launch path. Throwing would take the whole browser down
    // over a cosmetic pref, so the launcher gets a sentence for its log instead.
    const said = await enableExtensionInstalls(dir);
    expect(typeof said).toBe('string');
    expect(said.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§3 — a Web Store page offers an install that can actually finish', () => {
  it('recognises both store hosts', () => {
    const { storeIdFromUrl } = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    // The store moved host; old links are still everywhere, including in the
    // user's own bookmarks, so both have to be understood.
    expect(
      storeIdFromUrl('https://chromewebstore.google.com/detail/some-name/' + id),
    ).toBe(id);
    expect(
      storeIdFromUrl('https://chrome.google.com/webstore/detail/some-name/' + id),
    ).toBe(id);
    // A trailing path or query is normal when arriving from search results.
    expect(
      storeIdFromUrl('https://chromewebstore.google.com/detail/n/' + id + '?hl=fa'),
    ).toBe(id);
  });

  it('refuses pages that are not an offer to install anything', () => {
    const { storeIdFromUrl } = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    // Search and category pages list many extensions; claiming to install "the"
    // extension there would be a lie about the page on screen.
    expect(storeIdFromUrl('https://chromewebstore.google.com/search/vpn')).toBe('');
    expect(storeIdFromUrl('https://chromewebstore.google.com/category/extensions')).toBe('');
    // Any other site is not the store, however store-shaped its path looks.
    expect(storeIdFromUrl('https://evil.example/detail/x/' + id)).toBe('');
    expect(storeIdFromUrl('')).toBe('');
    expect(storeIdFromUrl('about:blank')).toBe('');
  });

  it('will not mistake part of a longer word for an id', () => {
    const { storeIdFromUrl } = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    // A 33rd letter means the run is not an id — store ids are exactly 32. Left
    // unchecked, this would post a wrong id and the server would 400.
    expect(
      storeIdFromUrl('https://chromewebstore.google.com/detail/n/' + id + 'q'),
    ).toBe('');
    expect(
      storeIdFromUrl('https://chromewebstore.google.com/detail/n/z' + id),
    ).toBe('');
  });

  it('shows the bar only on a store detail page, and hides it again', () => {
    const s = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';

    s.syncStoreBar('https://example.com/');
    expect(s.bar.hidden).toBe(true);

    s.syncStoreBar('https://chromewebstore.google.com/detail/n/' + id);
    expect(s.bar.hidden).toBe(false);
    expect(s.text.textContent).toBe('i18n:bvp.storeReady');
    expect(s.go.textContent).toBe('i18n:bvp.storeInstall');
    expect(s.go.disabled).toBe(false);

    // Navigating away must take the bar with it. A stale bar would offer to
    // install whatever extension the user last looked at.
    s.syncStoreBar('https://news.example/article');
    expect(s.bar.hidden).toBe(true);
  });

  it('posts the id of the page the user is looking at', async () => {
    const s = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    s.syncStoreBar('https://chromewebstore.google.com/detail/ublock/' + id);
    s.installFromStorePage();

    expect(s.posts).toEqual([
      { path: '/browser/extensions/store', body: { url: id } },
    ]);
    // Disabled while in flight: this install relaunches Chrome, and a second
    // click would race the relaunch.
    expect(s.go.disabled).toBe(true);
    expect(s.text.textContent).toBe('i18n:bvp.storeInstalling');

    await s.settle({ success: true, loaded: true });
    expect(s.toasts).toEqual([{ text: 'i18n:bvp.storeInstalled', kind: 'success' }]);
    expect(s.text.textContent).toBe('i18n:bvp.storeInstalled');
  });

  it('does nothing at all when there is no store page', () => {
    const s = liftStoreBar();
    s.syncStoreBar('https://example.com/');
    s.installFromStorePage();
    // No id means no request. Posting an empty id would surface a 400 that the
    // user did nothing to cause.
    expect(s.posts).toEqual([]);
  });

  it('repeats the server warning instead of claiming success', async () => {
    const s = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    s.syncStoreBar('https://chromewebstore.google.com/detail/n/' + id);
    s.installFromStorePage();

    // The route downloads the .crx and then relaunches Chrome to load it. When
    // the download worked but the load did not, it says so in `warning`. Saying
    // "installed" over that warning is exactly the confusion this fix exists to
    // remove — «گیج شدم».
    await s.settle({ success: true, loaded: false, warning: 'installed but not loaded' });
    expect(s.toasts).toEqual([{ text: 'installed but not loaded', kind: 'warn' }]);
  });

  it('re-arms the button when the install fails', async () => {
    const s = liftStoreBar();
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    s.syncStoreBar('https://chromewebstore.google.com/detail/n/' + id);
    s.installFromStorePage();

    await s.settle(new Error('network down'), true);
    expect(s.toasts[0].kind).toBe('error');
    expect(s.toasts[0].text).toContain('network down');
    // A dead button after a transient failure looks like the original bug all
    // over again, so the bar goes back to being an offer.
    expect(s.go.disabled).toBe(false);
    expect(s.text.textContent).toBe('i18n:bvp.storeReady');
  });

  it('re-syncs the bar on every event that can change the address', () => {
    // Structural, and deliberately so: these are `switch` branches inside the
    // PICKER's `handleMessage`, which cannot be lifted without its entire
    // closure. The behaviour of the function they call is covered above; what
    // matters here is that no path leaves a stale bar on screen.
    //
    // Scoped with lastIndexOf, not indexOf: this file ships TWO message
    // handlers. The first is the small embedded live widget (which has no tab
    // strip and no store bar); the picker overlay is the later, larger one. An
    // unscoped search finds the widget's `case 'navigated'` and reports a gap
    // that does not exist.
    const pickerFrom = browserView.indexOf('function pickerMarkup(');
    expect(pickerFrom, 'the picker must exist').toBeGreaterThan(0);
    const picker = browserView.slice(pickerFrom);

    for (const evt of ['navigated', 'tabOpened', 'recovered']) {
      const at = picker.indexOf(`case '${evt}':`);
      expect(at, `${evt} must be handled by the picker`).toBeGreaterThan(0);
      expect(
        picker.slice(at, at + 900),
        `${evt} must re-sync the store bar`,
      ).toContain('syncStoreBar');
    }
  });

  it('carries every store string in both languages', () => {
    const i18n = read('public/js/i18n.js');
    for (const key of [
      'bvp.storeReady',
      'bvp.storeInstall',
      'bvp.storeInstallHint',
      'bvp.storeInstalling',
      'bvp.storeInstalled',
      'bvp.storeFailed',
    ]) {
      const hits = i18n.split(`'${key}'`).length - 1;
      // Exactly two: the fa block and the en block. One means a user of the
      // other language sees a raw key, which the repo treats as a bug.
      expect(hits, `${key} must exist in fa and en`).toBe(2);
    }
  });
});
