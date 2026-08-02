/**
 * remote-io.test.ts — crossing the local/remote boundary with clipboard + files.
 *
 * The picker canvas is a JPEG stream of a Chrome running on the SERVER, and
 * three everyday actions silently do nothing across that boundary:
 *
 *   Ctrl+V   pastes into the LOCAL browser, which is showing an image
 *   Ctrl+C   copies the local (empty) selection; worse, an extension's
 *            "Export" writes to the SERVER's clipboard, unreachable
 *   Import   opens a native dialog drawn by the server, browsing the
 *            server's disk — the button looks broken
 *
 * The fix spans five files, and any one of them going quiet re-breaks the whole
 * thing with no error anywhere. These tests pin the seams:
 *
 *   1. the upload store never turns client input into an arbitrary path
 *   2. the extension survives the round trip (an `accept=".json"` page rejects
 *      an extensionless file, so this is load-bearing, not cosmetic)
 *   3. the client's accept-filter agrees with what the HTML spec allows
 *   4. every command the client sends is handled by BrowserStreamServer, and
 *      every message it listens for is emitted by LiveBrowser
 *   5. the module is actually loaded, attached, and translated
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const remoteIoSrc = read('public/js/remote-io.js');
const browserView = read('public/js/browser-view.js');
const streamServer = read('src/core/BrowserStreamServer.ts');
const liveBrowser = read('src/core/LiveBrowser.ts');
const routes = read('src/Routes/browser.routes.ts');
const indexHtml = read('public/index.html');
const i18n = read('public/js/i18n.js');
const css = read('public/css/styles.css');

// ─────────────────────────────────────────────────────────────────────────
// 1. The upload store
// ─────────────────────────────────────────────────────────────────────────
describe('RemoteUploads: a token is not a path', () => {
  let dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-uploads-'));
    process.env.UPLOADS_DIR = dir;
    mod = await import('../../src/core/RemoteUploads');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a real upload and keeps the extension', async () => {
    const saved = await mod.saveUpload('u1', 'cookies.json', Buffer.from('[]'));
    expect(saved.token).toMatch(mod.TOKEN_RE);
    expect(saved.token.endsWith('.json')).toBe(true);
    expect(saved.name).toBe('cookies.json');
    expect(saved.size).toBe(2);
    expect(existsSync(await mod.resolveUpload('u1', saved.token))).toBe(true);
  });

  it('the PAGE sees the user\u2019s filename, not the token', async () => {
    // An extension shows `file.name` in its UI and sometimes checks it before
    // importing; handing it `up_3394\u2026json` works and looks broken.
    const saved = await mod.saveUpload('u1', 'cookies.json', Buffer.from('[]'));
    expect(basename(await mod.resolveUpload('u1', saved.token))).toBe('cookies.json');
  });

  it('the stored file lives under the user\u2019s own directory', async () => {
    const saved = await mod.saveUpload('u1', 'a.txt', Buffer.from('x'));
    expect(await mod.resolveUpload('u1', saved.token))
      .toContain(join('remote', 'u1'));
  });

  it('a hostile filename cannot traverse, hide or reverse itself', () => {
    expect(mod.safeFileName('../../etc/passwd')).toBe('passwd');
    expect(mod.safeFileName('..')).toBe('file');
    expect(mod.safeFileName('.bashrc')).toBe('bashrc');
    expect(mod.safeFileName('a/b/c.json')).toBe('c.json');
    expect(mod.safeFileName('evil\u202egpj.exe')).not.toContain('\u202e');
    expect(mod.safeFileName('')).toBe('file');
    expect(mod.safeFileName('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });

  it('rejects traversal, absolute paths and anything not minted here', () => {
    const evil = [
      '../../../etc/shadow',
      '/etc/shadow',
      'up_../../etc/shadow',
      '..%2F..%2Fetc%2Fshadow',
      'etc/shadow',
      'up_ZZZZ',                              // not hex
      'up_' + 'a'.repeat(23),                 // wrong length
      'up_' + 'a'.repeat(24) + '.js/../../x', // extension used as a smuggler
      '',
    ];
    for (const token of evil) {
      expect(() => mod.resolveUploadDir('u1', token), token).toThrow(mod.UploadError);
    }
  });

  it('a user id cannot escape its directory either', () => {
    expect(mod.safeSegment('../../root')).not.toContain('..');
    expect(mod.safeSegment('../../root')).not.toContain('/');
    expect(mod.safeSegment('')).toBe('anon');
  });

  it('drops a hostile original name but keeps a plain extension', () => {
    expect(mod.extensionOf('../../etc/passwd')).toBe('');
    expect(mod.extensionOf('x.JSON')).toBe('.json');
    expect(mod.extensionOf('no-extension')).toBe('');
    // The one that matters: nothing from the user's name reaches the disk.
    expect(mod.mintToken('../../etc/evil.json')).toMatch(mod.TOKEN_RE);
  });

  it('refuses an empty body and a body over the cap', async () => {
    await expect(mod.saveUpload('u1', 'a.txt', Buffer.alloc(0)))
      .rejects.toThrow(mod.UploadError);
    await expect(
      mod.saveUpload('u1', 'a.txt', Buffer.alloc(mod.MAX_UPLOAD_BYTES + 1)),
    ).rejects.toThrow(/too large/i);
  });

  it('sweeps stale uploads but leaves fresh ones alone', async () => {
    const stale = await mod.saveUpload('u2', 'old.json', Buffer.from('1'));
    const fresh = await mod.saveUpload('u2', 'new.json', Buffer.from('1'));
    // saveUpload kicks off a background sweep; let it finish before ageing the
    // file, or it races this one for the deletion and steals the count.
    await new Promise((r) => setTimeout(r, 50));
    const stalePath = mod.resolveUploadDir('u2', stale.token);
    const old = new Date(Date.now() - 2 * mod.UPLOAD_TTL_MS);
    utimesSync(stalePath, old, old);

    expect(await mod.sweepUploads('u2')).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(mod.resolveUploadDir('u2', fresh.token))).toBe(true);
  });

  it('discardUploads swallows a bad token instead of throwing at close()', async () => {
    // Called from LiveBrowser.close(); a throw there would leak the session.
    await expect(mod.discardUploads('u1', ['../../etc/shadow', 'nope']))
      .resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The client's accept filter
// ─────────────────────────────────────────────────────────────────────────
describe('RemoteIO.acceptsFile', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let RemoteIO: any;

  beforeAll(() => {
    // The module is a browser IIFE. Give it just enough of a window to run;
    // acceptsFile is deliberately pure so it needs no DOM.
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    sandbox.navigator = {};
    sandbox.document = {};
    vm.createContext(sandbox);
    vm.runInContext(remoteIoSrc, sandbox);
    RemoteIO = (sandbox.window as Record<string, unknown>).RemoteIO;
  });

  const f = (name: string, type = '') => ({ name, type });

  it('an empty accept accepts anything', () => {
    expect(RemoteIO.acceptsFile('', f('x.exe'))).toBe(true);
    expect(RemoteIO.acceptsFile(undefined, f('x.exe'))).toBe(true);
  });

  it('matches the J2TEAM Cookies accept list case-insensitively', () => {
    const accept = '.txt, .json';
    expect(RemoteIO.acceptsFile(accept, f('cookies.json'))).toBe(true);
    expect(RemoteIO.acceptsFile(accept, f('COOKIES.JSON'))).toBe(true);
    expect(RemoteIO.acceptsFile(accept, f('notes.txt'))).toBe(true);
    expect(RemoteIO.acceptsFile(accept, f('shot.png'))).toBe(false);
  });

  it('matches MIME types and wildcards', () => {
    expect(RemoteIO.acceptsFile('application/json', f('a', 'application/json'))).toBe(true);
    expect(RemoteIO.acceptsFile('image/*', f('a.png', 'image/png'))).toBe(true);
    expect(RemoteIO.acceptsFile('image/*', f('a.json', 'application/json'))).toBe(false);
  });

  it('does not treat a substring as an extension match', () => {
    // "notjson" ends with "json" but not with ".json".
    expect(RemoteIO.acceptsFile('.json', f('notjson'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Client ↔ server vocabulary
// ─────────────────────────────────────────────────────────────────────────
describe('the clipboard/file protocol is handled end to end', () => {
  it('every command remote-io.js sends has a case in BrowserStreamServer', () => {
    // Only real call sites: the header comment documents the inbound
    // vocabulary too, and those are LiveBrowser events, not commands.
    const sent = new Set(
      Array.from(remoteIoSrc.matchAll(/send\(\{\s*t:\s*'([a-zA-Z]+)'/g)).map((m) => m[1]),
    );
    expect(sent.size).toBeGreaterThan(0);
    for (const cmd of sent) {
      expect(streamServer, `command '${cmd}'`).toContain(`case '${cmd}'`);
    }
  });

  it('every message remote-io.js listens for is emitted by LiveBrowser', () => {
    for (const evt of ['filechooser', 'fileChooserDone', 'clipboard']) {
      expect(remoteIoSrc).toContain(`case '${evt}'`);
      expect(liveBrowser, `event '${evt}'`).toMatch(
        new RegExp(`emit\\(\\s*'${evt}'`),
      );
    }
  });

  it('BrowserStreamServer forwards the five commands to the session', () => {
    for (const [cmd, method] of [
      ['paste', 'paste'],
      ['copy', 'readClipboard'],
      ['selectAll', 'selectAll'],
      ['fileAccept', 'acceptFiles'],
      ['fileCancel', 'cancelFileChooser'],
    ] as const) {
      expect(streamServer, cmd).toContain(`case '${cmd}'`);
      expect(streamServer, method).toContain(`${method}(`);
    }
  });

  it('LiveBrowser intercepts the native dialog rather than letting it open', () => {
    // A native chooser is drawn by the window manager, never by the page, so it
    // can never appear in a Page.startScreencast frame. Interception is the
    // ONLY way the button can work.
    expect(liveBrowser).toMatch(/page\.on\(\s*'filechooser'/);
    expect(liveBrowser).toContain('setFiles');
    expect(liveBrowser).toMatch(/grantPermissions\(\[[^\]]*'clipboard-read'/);
  });

  it('the socket resolves tokens itself and never accepts a path', () => {
    expect(liveBrowser).toContain('resolveUpload');
    expect(streamServer).not.toMatch(/msg\.(path|paths|filePath)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. The upload endpoint
// ─────────────────────────────────────────────────────────────────────────
describe('POST /browser/uploads', () => {
  it('exists, takes a raw body and is capped', () => {
    expect(routes).toContain("'/browser/uploads'");
    expect(routes).toContain('express.raw');
    expect(routes).toContain('MAX_UPLOAD_BYTES');
  });

  it('scopes the file to the identity the SOCKET runs as, behind the socket\u2019s own gate', () => {
    // Using resolveUserId(req) here — the rule the cookie routes use — put the
    // bytes under `local` while the session looked for them under its own id,
    // and the hand-over died with a bare ENOENT that read as "Import still
    // does nothing". The id may be supplied, but only if the key owns it.
    expect(routes).toMatch(/const asked = String\(req\.query\.userId/);
    expect(routes).toMatch(/authorizeLive\(apiKeyOf\(req\), asked\)/);
    expect(routes).toMatch(/saveUpload\(\s*owner,/);
    // …and an unowned id is refused, not silently downgraded.
    expect(routes).toContain('may not upload for that user');
  });

  it('the client sends that same id with the API key', () => {
    expect(remoteIoSrc).toContain("'/browser/uploads'");
    expect(remoteIoSrc).toContain("'&userId='");
    expect(remoteIoSrc).toContain('x-api-key');
    // Both surfaces must pass one, or the picker uploads as the wrong user.
    expect(browserView.match(/userId:\s*(uid|effectiveUserId)/g) || []).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Wiring, loading, translating
// ─────────────────────────────────────────────────────────────────────────
describe('RemoteIO is loaded and attached on both surfaces', () => {
  it('index.html loads remote-io.js BEFORE browser-view.js', () => {
    const a = indexHtml.indexOf('/js/remote-io.js');
    const b = indexHtml.indexOf('/js/browser-view.js');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  it('both the picker and the live view attach, route and detach', () => {
    // Two attach sites (live view + picker modal) …
    expect(browserView.match(/RemoteIO\.attach\(/g) || []).toHaveLength(2);
    // … two message routers …
    expect(browserView.match(/rio\.onMessage\(msg\)/g) || []).toHaveLength(2);
    // … and a teardown for each, or a half-answered file prompt outlives its
    // socket and uploads to a session that no longer exists.
    expect(browserView).toMatch(/ps\.rio\.detach\(\)/);
    expect(browserView).toMatch(/rio\.detach\(\)/);
  });

  it('the picker stands its shortcuts down while the crosshair is armed', () => {
    expect(browserView).toMatch(/isBusy:\s*function[^}]*selectMode/s);
  });

  it('there is a button for the clipboard an extension wrote with no keystroke', () => {
    expect(browserView).toContain('bvp-clip');
    expect(browserView).toContain('pullClipboard');
  });

  it('every rio.* string the client asks for exists in both languages', () => {
    const keys = new Set(
      Array.from(
        (remoteIoSrc + browserView).matchAll(/t\(\s*'(rio\.[a-zA-Z]+)'/g),
      ).map((m) => m[1]),
    );
    expect(keys.size).toBeGreaterThanOrEqual(8);
    for (const key of keys) {
      // Once per language block.
      const hits = i18n.split(`'${key}':`).length - 1;
      expect(hits, `${key} should be defined twice (fa + en), found ${hits}`).toBe(2);
    }
  });

  it('the file prompt is styled and its raw input stays hidden', () => {
    expect(css).toContain('.rio-filebar');
    expect(css).toMatch(/\.rio-input\s*\{[^}]*display:\s*none/s);
    expect(css).toContain('rio-dropping');
  });
});
