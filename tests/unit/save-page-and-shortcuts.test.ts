/**
 * save-page-and-shortcuts.test.ts — the three defects reported against the
 * remote browser's INPUT and its DOWNLOADS, pinned by behaviour.
 *
 * THE REPORT, VERBATIM
 * --------------------
 *   «وقتی با راست کلیک میخام سیو از رو میزنم تا کل صفحه html ذخیره بشه هیچ
 *    اتفاقی نمیوفته یعنی برام دانلود نمیشه»
 *   «ایا این فایل ها توی سرور موقت هستند یا ذخیره میشن؟ … وقت باشن یعنی tmp
 *    باشند خوبه تا دائمی چون کاربردش فقط همون لحظه هستند»
 *   «مشکل کپی / پیست و کار نکردن کلید های میانبر مثل کنرتل a یا کنترل c/v»
 *
 * THREE CAUSES, EACH TESTED HERE
 * ------------------------------
 *   §1 SILENCE. `saveUrl` reports a refusal as a `downloadError` event, and no
 *      client listened for it. So a save that could not happen produced no row,
 *      no toast and no error — literally nothing, which is why the button looked
 *      dead. The client now has a handler AND a translator from the server's
 *      machine codes to sentences.
 *
 *   §2 THE WRONG BYTES. "Save page as" re-FETCHED the URL server-side. For a
 *      page behind a login, a POST or a bot check that is a 403; for a
 *      client-rendered app it is the pre-JavaScript shell. The page on screen is
 *      now serialised from the live DOM instead, which is what Chrome's own
 *      "Save page as (HTML only)" does.
 *
 *   §3 DROPPED KEYS. The Live Browser View's stage handler had a nine-key
 *      whitelist and `!ev.ctrlKey && !ev.metaKey` on its printable branch, so
 *      every modified keystroke was discarded before it reached the wire. The
 *      server side (BrowserInput's CDP edit `commands`) had been correct all
 *      along.
 *
 * WHY BEHAVIOUR AND NOT GREP
 * --------------------------
 * The standing rule for this repo: «تست‌ها باید رفتار را بسنجند نه وجود رشته در
 * سورس». So the shipped client functions are lifted out of public/js by brace
 * balance and EXECUTED against fake globals, the config helpers are called for
 * real, and the storage helpers touch a real temp directory. A grep for
 * `page.content()` would pass against code that computes the HTML and then
 * throws it away.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const browserView = read('public/js/browser-view.js');
const liveBrowser = read('src/core/LiveBrowser.ts');

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

/** Run one lifted client function with `t`/`tf` stand-ins that echo their keys. */
function liftMessenger(): (code: string, subject?: string) => string {
  const sandbox: Record<string, unknown> = {
    t: (k: string) => 'i18n:' + k,
    tf: (k: string, vars: Record<string, string>) =>
      'i18n:' + k + ':' + JSON.stringify(vars),
    String, RegExp,
  };
  const keys = Object.keys(sandbox);
  return new Function(
    ...keys,
    grabFunction(browserView, 'saveFailureMessage') + '\nreturn saveFailureMessage;',
  )(...keys.map((k) => sandbox[k])) as (code: string, subject?: string) => string;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('§1 — a save that cannot happen SAYS so', () => {
  it('translates every failure the server can report into its own message', () => {
    const msg = liftMessenger();
    // Each of these was previously either total silence (`downloadError`) or a
    // raw machine code in a toast. The mapping is the whole fix: the user has to
    // learn what happened and what to do next.
    expect(msg('bad_url')).toBe('i18n:bvp.dlBadTarget');
    expect(msg('unsupported_scheme')).toBe('i18n:bvp.dlBadTarget');
    expect(msg('download_too_large')).toBe('i18n:bvp.dlTooLarge');
    // 401/403 is the common "Save page as did nothing" cause: a page behind a
    // login, re-fetched without the session that made it visible.
    expect(msg('http_401')).toBe('i18n:bvp.dlNeedsLogin');
    expect(msg('http_403')).toBe('i18n:bvp.dlNeedsLogin');
    expect(msg('http_404')).toBe('i18n:bvp.dlNotFound');
    expect(msg('http_500')).toBe('i18n:bvp.dlSiteError');
    expect(msg('http_503')).toBe('i18n:bvp.dlSiteError');
    // The user's own guess — «ممکنه دانولد طولانی بوده» — is a real case, and
    // Playwright words it as a timeout.
    expect(msg('Timeout 60000ms exceeded')).toBe('i18n:bvp.dlTimeout');
  });

  it('never swallows a code it does not recognise', () => {
    const msg = liftMessenger();
    // The point of a fallback is that a NEW server-side failure still reaches
    // the user. Dropping it would recreate the exact bug this fixes.
    const out = msg('some_new_failure', 'report.html');
    expect(out).toContain('bvp.dlFailed');
    expect(out).toContain('some_new_failure');
    expect(out).toContain('report.html');
  });

  it('the client actually handles the downloadError event', () => {
    // The event existed and was emitted by the server for a long time; what was
    // missing was any listener at all. Asserted structurally because the switch
    // cannot be lifted out of `handleMessage` without its whole closure — but
    // the message mapping above is what carries the behaviour.
    const idx = browserView.indexOf("case 'downloadError':");
    expect(idx, 'the picker must handle downloadError').toBeGreaterThan(0);
    const branch = browserView.slice(idx, idx + 400);
    expect(branch).toContain('saveFailureMessage');
    expect(branch).toContain('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§2 — "Save page as" saves the page that is on screen', () => {
  it('recognises the active document, ignoring only the fragment', async () => {
    // `sameDocument` is what chooses between "serialise the live DOM" and
    // "fetch this URL". Getting it wrong in either direction is a real bug: too
    // loose and a link save would save the wrong page, too strict and the
    // reported failure comes straight back.
    const mod = await import('../../src/core/LiveBrowser');
    const same = (mod as unknown as {
      __test?: unknown;
    });
    // Not exported (it is a module-local helper), so it is lifted and run.
    const fn = new Function(
      'URL', 'String',
      grabFunction(liveBrowser, 'sameDocument')
        .replace(/: string/g, '').replace(/: boolean/g, '')
        + '\nreturn sameDocument;',
    )(URL, String) as (a: string, b: string) => boolean;
    expect(same).toBeTruthy(); // the module still imports cleanly

    expect(fn('https://site.test/a', 'https://site.test/a')).toBe(true);
    // A person who saves while scrolled to an anchor still means "this page".
    expect(fn('https://site.test/a#part2', 'https://site.test/a')).toBe(true);
    expect(fn('https://site.test/a?id=1', 'https://site.test/a?id=2')).toBe(false);
    expect(fn('https://site.test/a', 'https://other.test/a')).toBe(false);
    expect(fn('', 'https://site.test/a')).toBe(false);
    expect(fn('', '')).toBe(false);
  });

  it('names a saved page .html whatever the URL path ended in', () => {
    // A page at `/report.php` saved as `report.php` is a file the user's OS
    // opens in an editor. The bytes are HTML, so the name must say HTML.
    const strip = new Function(
      'String',
      grabFunction(liveBrowser, 'stripExtension')
        .replace(/: string/g, '') + '\nreturn stripExtension;',
    )(String) as (s: string) => string;

    expect(strip('report.php')).toBe('report');
    expect(strip('index.html')).toBe('index');
    // A TITLE is not a filename with an extension, and truncating one would
    // name the saved file after a fragment of its own title.
    expect(strip('The Quarterly Report')).toBe('The Quarterly Report');
    expect(strip('گزارش سه‌ماهه')).toBe('گزارش سه‌ماهه');
    expect(strip('')).toBe('');
  });

  it('refuses a scheme the server has no business fetching, and says why', async () => {
    const { LiveBrowserManager } = await import('../../src/core/LiveBrowser');
    const session = new LiveBrowserManager(2).create('u_save');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    session.setSinks(() => {}, (type, data) => { events.push({ type, data }); });

    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      await expect(session.saveUrl(bad)).resolves.toBeUndefined();
    }
    expect(events.every((e) => e.type === 'downloadError')).toBe(true);
    // The client now turns each of these into a sentence (see §1), so the event
    // must keep carrying a code it can map.
    const msg = liftMessenger();
    for (const e of events) {
      expect(msg(String(e.data.error))).toBe('i18n:bvp.dlBadTarget');
    }
    await session.close().catch(() => {});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§3 — the downloaded bytes are TEMPORARY', () => {
  let dir = '';
  let cfg: typeof import('../../src/config');
  let mod: typeof import('../../src/core/RemoteDownloads');

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'abtmp-'));
    cfg = await import('../../src/config');
    mod = await import('../../src/core/RemoteDownloads');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('defaults to the temp root, and honours an operator who wants durable storage', () => {
    const c = cfg.config as unknown as Record<string, unknown>;
    const durable = String(c.DOWNLOADS_DIR);
    const temp = join(dir, 'tmp');
    const before = { eph: c.DOWNLOADS_EPHEMERAL, tmp: c.DOWNLOADS_TMP_DIR };
    try {
      c.DOWNLOADS_TMP_DIR = temp;

      // The answer to the owner's question, as behaviour: by default the bytes
      // are NOT under the durable ./downloads tree.
      c.DOWNLOADS_EPHEMERAL = true;
      expect(mod.downloadDirFor('u1').startsWith(temp)).toBe(true);
      expect(mod.downloadDirFor('u1').startsWith(durable)).toBe(false);

      // …and an operator who needs an audit trail can still have one. This is
      // the only reason the flag exists, so it must really change the root.
      c.DOWNLOADS_EPHEMERAL = false;
      expect(mod.downloadDirFor('u1').startsWith(durable)).toBe(true);
    } finally {
      c.DOWNLOADS_EPHEMERAL = before.eph;
      c.DOWNLOADS_TMP_DIR = before.tmp;
    }
  });

  it('keeps files for MINUTES, configurably, not a day', () => {
    const c = cfg.config as unknown as Record<string, unknown>;
    const before = c.DOWNLOAD_TTL_MINUTES;
    try {
      // Read at CALL time on purpose: a module-level constant would freeze
      // whatever the environment said at import and ignore the setting.
      c.DOWNLOAD_TTL_MINUTES = 30;
      expect(mod.downloadTtlMs()).toBe(30 * 60 * 1000);
      c.DOWNLOAD_TTL_MINUTES = 5;
      expect(mod.downloadTtlMs()).toBe(5 * 60 * 1000);
      // A nonsense value must not become "keep forever".
      c.DOWNLOAD_TTL_MINUTES = 0;
      expect(mod.downloadTtlMs()).toBe(30 * 60 * 1000);
      c.DOWNLOAD_TTL_MINUTES = -1;
      expect(mod.downloadTtlMs()).toBe(30 * 60 * 1000);
      // Far below the old 24-hour retention, which is the whole requirement.
      c.DOWNLOAD_TTL_MINUTES = before;
      expect(mod.downloadTtlMs()).toBeLessThan(24 * 60 * 60 * 1000);
    } finally {
      c.DOWNLOAD_TTL_MINUTES = before;
    }
  });

  it('a session deletes its own downloads when it closes', async () => {
    // The TTL is a ceiling, not a policy. What makes storage genuinely momentary
    // is that closing the window removes the files — so this asserts the real
    // filesystem effect of `close()`, not the presence of a call.
    const c = cfg.config as unknown as Record<string, unknown>;
    const before = { eph: c.DOWNLOADS_EPHEMERAL, tmp: c.DOWNLOADS_TMP_DIR };
    c.DOWNLOADS_EPHEMERAL = true;
    c.DOWNLOADS_TMP_DIR = dir;
    try {
      const { LiveBrowserManager } = await import('../../src/core/LiveBrowser');
      const session = new LiveBrowserManager(2).create('u_tmp');
      const token = mod.mintDownloadToken();
      const file = await mod.downloadPathFor('u_tmp', token, 'secret.csv');
      await fs.writeFile(file, 'a,b\n1,2\n');
      // Put it on the session's shelf the way a real download would be.
      (session as unknown as { downloads: unknown[] }).downloads = [{
        id: 'd1', token, name: 'secret.csv', url: 'https://site.test/x.csv',
        tabId: 't1', state: 'completed', received: 8, total: 8, path: file, error: '',
      }];

      await expect(fs.stat(file)).resolves.toBeTruthy();
      await session.close().catch(() => {});
      // Gone, and gone from the shelf too.
      await expect(fs.stat(file)).rejects.toThrow();
      expect(session.downloadList()).toEqual([]);
    } finally {
      c.DOWNLOADS_EPHEMERAL = before.eph;
      c.DOWNLOADS_TMP_DIR = before.tmp;
    }
  });

  it('an operator who asked for durable storage keeps their files', async () => {
    // The mirror case, and the reason the flag is checked rather than assumed:
    // deleting an audit trail somebody configured would be worse than keeping
    // bytes they did not want.
    const c = cfg.config as unknown as Record<string, unknown>;
    const before = { eph: c.DOWNLOADS_EPHEMERAL, durable: c.DOWNLOADS_DIR };
    c.DOWNLOADS_EPHEMERAL = false;
    c.DOWNLOADS_DIR = dir;
    try {
      const { LiveBrowserManager } = await import('../../src/core/LiveBrowser');
      const session = new LiveBrowserManager(2).create('u_keep');
      const token = mod.mintDownloadToken();
      const file = await mod.downloadPathFor('u_keep', token, 'ledger.csv');
      await fs.writeFile(file, 'x');
      (session as unknown as { downloads: unknown[] }).downloads = [{
        id: 'd1', token, name: 'ledger.csv', url: 'https://site.test/l.csv',
        tabId: 't1', state: 'completed', received: 1, total: 1, path: file, error: '',
      }];

      await session.close().catch(() => {});
      await expect(fs.stat(file)).resolves.toBeTruthy();
    } finally {
      c.DOWNLOADS_EPHEMERAL = before.eph;
      c.DOWNLOADS_DIR = before.durable;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§4 — the Live Browser View forwards keyboard shortcuts', () => {
  interface Run { sent: Array<Record<string, unknown>>; prevented: number; toasts: string[] }

  /**
   * Run the shipped `onStageKey` against a fake event.
   *
   * `rio` decides which of the two paths is under test: with RemoteIO present
   * (the normal case) the clipboard keys are ITS business and must not be
   * forwarded twice; without it the handler does what it still can on its own.
   */
  function press(ev: Record<string, unknown>, opts: { rio?: boolean } = {}): Run {
    const sent: Array<Record<string, unknown>> = [];
    const toasts: string[] = [];
    let prevented = 0;
    const sandbox: Record<string, unknown> = {
      state: { ws: {} },
      rio: opts.rio === false ? null : {},
      send: (m: Record<string, unknown>) => { sent.push(m); },
      toast: (m: string) => { toasts.push(String(m)); },
      t: (k: string) => 'i18n:' + k,
      navigator: {},
      String, Boolean,
    };
    const keys = Object.keys(sandbox);
    const fn = new Function(
      ...keys,
      grabFunction(browserView, 'stageMods') + '\n'
      + grabFunction(browserView, 'onStageKey') + '\nreturn onStageKey;',
    )(...keys.map((k) => sandbox[k])) as (e: Record<string, unknown>) => void;

    fn({
      key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      repeat: false, preventDefault: () => { prevented += 1; },
      ...ev,
    });
    return { sent, prevented, toasts };
  }

  it('sends a modified keystroke instead of dropping it — the reported bug', () => {
    // THE BUG: `!ev.ctrlKey && !ev.metaKey` meant every combination died here.
    // Ctrl+Z / Ctrl+Y / Ctrl+F are the ones RemoteIO does NOT claim, so they
    // prove the general path rather than the clipboard special case.
    const undo = press({ key: 'z', ctrlKey: true });
    expect(undo.sent).toEqual([{
      t: 'key', key: 'z',
      mods: { ctrl: true, shift: false, alt: false, meta: false },
      autoRepeat: false,
    }]);
    expect(undo.prevented).toBe(1);

    const find = press({ key: 'f', ctrlKey: true });
    expect(find.sent[0]).toMatchObject({ t: 'key', key: 'f' });

    const redo = press({ key: 'y', ctrlKey: true });
    expect(redo.sent[0]).toMatchObject({ t: 'key', key: 'y' });

    // Shift+Ctrl and Meta (macOS) travel with their flags intact, or the page's
    // own handlers cannot tell which combination was pressed.
    expect(press({ key: 'z', ctrlKey: true, shiftKey: true }).sent[0]).toMatchObject({
      mods: { ctrl: true, shift: true, alt: false, meta: false },
    });
    expect(press({ key: 'a', metaKey: true, altKey: true }).sent[0]).toMatchObject({
      mods: { ctrl: false, shift: false, alt: true, meta: true },
    });
  });

  it('sends function keys and named keys, which the nine-key whitelist dropped', () => {
    for (const key of ['F1', 'F2', 'F3', 'F6', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']) {
      expect(press({ key }).sent[0], `${key} must reach the page`).toMatchObject({ t: 'key', key });
    }
    // The nine that DID work must keep working.
    for (const key of ['Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown',
      'ArrowLeft', 'ArrowRight', 'Delete', 'Escape']) {
      expect(press({ key }).sent[0]).toMatchObject({ t: 'key', key });
    }
    // A BARE space is a printable character and must insert one — a space typed
    // into a search box has to arrive as a space, not as a scroll.
    expect(press({ key: ' ' }).sent).toEqual([{ t: 'type', text: ' ' }]);
    // A MODIFIED space is a key event, and is renamed on the wire to the name
    // the server's key table uses (BrowserInput maps both ' ' and 'Space', but
    // sending the name keeps this identical to the picker shell).
    expect(press({ key: ' ', ctrlKey: true }).sent[0]).toMatchObject({
      t: 'key', key: 'Space',
    });
  });

  it('inserts a bare printable character as TEXT, so non-Latin input works', () => {
    // `Input.insertText` is what handles a composed character no keycode can
    // describe — the difference between typing Persian and typing nothing.
    expect(press({ key: 'a' }).sent).toEqual([{ t: 'type', text: 'a' }]);
    expect(press({ key: 'ش' }).sent).toEqual([{ t: 'type', text: 'ش' }]);
    expect(press({ key: 'é' }).sent).toEqual([{ t: 'type', text: 'é' }]);
    // Shift alone is still "printable": Shift+A is the letter A.
    expect(press({ key: 'A', shiftKey: true }).sent).toEqual([{ t: 'type', text: 'A' }]);
  });

  it('leaves the clipboard keys to RemoteIO rather than doing them twice', () => {
    // RemoteIO listens in the CAPTURE phase: it has already sent {t:'copy'} /
    // {t:'selectAll'} and, for paste, is waiting for the browser's own `paste`
    // event. Forwarding here as well would copy twice and race two texts into
    // the page.
    for (const key of ['c', 'x', 'a', 'v']) {
      const run = press({ key, ctrlKey: true });
      expect(run.sent, `Ctrl+${key} is RemoteIO's`).toEqual([]);
      expect(run.prevented, `Ctrl+${key} must not be swallowed`).toBe(0);
    }
  });

  it('still pastes when RemoteIO is not on the page', () => {
    // Without the module the keys would otherwise be dropped again. Paste is the
    // one that needs the local clipboard, so it takes the async API — and says
    // so when the browser refuses.
    const run = press({ key: 'v', ctrlKey: true }, { rio: false });
    expect(run.prevented).toBe(1);
    expect(run.toasts).toEqual(['i18n:bv.pasteDenied']);
  });

  it('turns F5 and Ctrl+R into a real reload, hard when Shift is held', () => {
    expect(press({ key: 'F5' }).sent).toEqual([{ t: 'reload', hard: false }]);
    expect(press({ key: 'r', ctrlKey: true }).sent).toEqual([{ t: 'reload', hard: false }]);
    // Chrome's cache-bypassing reload is a genuinely different action, and it is
    // the one reached for when a page keeps serving a stale script.
    expect(press({ key: 'r', ctrlKey: true, shiftKey: true }).sent).toEqual([
      { t: 'reload', hard: true },
    ]);
  });

  it('maps Alt+Left / Alt+Right onto Back and Forward', () => {
    expect(press({ key: 'ArrowLeft', altKey: true }).sent).toEqual([{ t: 'back' }]);
    expect(press({ key: 'ArrowRight', altKey: true }).sent).toEqual([{ t: 'forward' }]);
  });

  it('does not eat the shortcuts this view cannot honour', () => {
    // Ctrl+T/W/N and Ctrl+Tab belong to the HOST browser, and this view has no
    // tab strip to offer instead. Swallowing them would leave the user with
    // nothing at all, which is worse than the host's own behaviour.
    for (const ev of [
      { key: 't', ctrlKey: true }, { key: 'w', ctrlKey: true },
      { key: 'n', ctrlKey: true }, { key: 'Tab', ctrlKey: true },
      { key: 'F11' }, { key: 'F12' },
    ]) {
      const run = press(ev);
      expect(run.sent, `${ev.key} must be left alone`).toEqual([]);
      expect(run.prevented).toBe(0);
    }
  });

  it('does nothing at all when there is no session', () => {
    // A keystroke on a disconnected stage must not fabricate traffic.
    const sandbox: Record<string, unknown> = {
      state: null, rio: {}, send: () => { throw new Error('must not send'); },
      toast: () => {}, t: (k: string) => k, navigator: {}, String, Boolean,
    };
    const keys = Object.keys(sandbox);
    const fn = new Function(
      ...keys,
      grabFunction(browserView, 'stageMods') + '\n'
      + grabFunction(browserView, 'onStageKey') + '\nreturn onStageKey;',
    )(...keys.map((k) => sandbox[k])) as (e: Record<string, unknown>) => void;
    expect(() => fn({ key: 'a', preventDefault: () => {} })).not.toThrow();
  });
});
