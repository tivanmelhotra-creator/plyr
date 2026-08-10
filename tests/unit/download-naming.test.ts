/**
 * download-naming.test.ts — a downloaded file must keep the name and the format
 * the SITE chose, and the page's right-click menu must offer what a real
 * browser offers.
 *
 * THE REPORT
 * ----------
 * «اسم فایل رو به download تغییر داده بود و هیچ فرمتی نداشت … فرض کن یه سری
 * دیتا و فایل هایی قراره دانلود کنم که اسم خاص دارند و این مورد مشکل میشه»
 *
 * and, widening it past images:
 *
 * «اسم تصویر باید موقع دانلود خودش باشه همونی که [سایت] خودش در نظر گرفته و
 * فرمتشم همینطور … منظورم فقط تصویر نیست هر چیزی که ذانلود میشه»
 * «و یادت نره راست کلیک مرورگر رو هم اپشن هاشو»
 *
 * TWO INDEPENDENT CAUSES, BOTH MEASURED
 * -------------------------------------
 * Cause A — the process locale. Chromium builds a download's filename with
 * `base::FilePath`, a BYTE string on POSIX, converting the server's UTF-16 name
 * through the C library's locale encoding. With no `LANG`/`LC_ALL` glibc reports
 * "C" (ANSI_X3.4-1968, i.e. ASCII), every non-ASCII character fails to convert,
 * and Chromium discards the ENTIRE name — extension included — for its
 * hardcoded fallback, the literal string `download`:
 *
 *     no LANG           ->  "download"     <- the reported bug, reproduced
 *     LANG=C.UTF-8      ->  "صفحه.png"     <- the name survives intact
 *     LANG=en_US.UTF-8  ->  "download"     <- still broken: not generated here
 *
 * That last line is why the value is `C.UTF-8`: an ungenerated locale does not
 * fall back to UTF-8, glibc silently drops to "C", and the bug returns. §1
 * re-measures this with the real `locale` binary rather than trusting a string.
 *
 * Cause B — the site sent no name at all, which no locale can fix. Measured
 * WITH a correct locale:
 *
 *     GET /api/export    octet-stream  ->  "export"       (no extension)
 *     GET /files/        octet-stream  ->  "download"     (no extension)
 *     GET /f/9f2c4d18-…  octet-stream  ->  "9f2c4d18-…"   (no extension)
 *
 * Also measured: a Playwright `Download` exposes exactly `page, url,
 * suggestedFilename, path, saveAs, failure, createReadStream, cancel, delete`,
 * so the response's Content-Type is NOT reachable and the bytes are the only
 * remaining honest signal. Hence the magic-number rescue in §3.
 *
 * End-to-end against the compiled build, all seven passing:
 *
 *     ordinary png              chrome="photo.png"           final="photo.png"
 *     NON-ASCII name (the bug)  chrome="صفحه.png"            final="صفحه.png"
 *     nameless octet-stream     chrome="export"              final="export.png"
 *     path is a directory       chrome="download"            final="download.zip"
 *     bare UUID name            chrome="9f2c4d18-77aa-4e1b"  final="….pdf"
 *     ascii name + query        chrome="p2.png"              final="p2.png"
 *     CD name wins over path    chrome="report.pdf"          final="report.pdf"
 *
 * For the menu, the mechanism was chosen by measurement too — a cross-origin
 * image, right-clicked:
 *
 *     A  <a download>       ->  NO DOWNLOAD (Chrome navigated instead)
 *     B  in-page fetch()    ->  TypeError: Failed to fetch   (CORS)
 *     C  ctx.request.get()  ->  status=200 bytes=70  ✓  (shares the cookie jar)
 *
 * WHY THESE ARE BEHAVIOUR TESTS AND NOT STRING CHECKS
 * ---------------------------------------------------
 * The standing rule here: «تست‌ها باید رفتار را بسنجند نه وجود رشته در سورس».
 * A grep for `C.UTF-8` would pass against code that computes the value and then
 * never hands it to Chromium — which is the bug, one layer up. So §1 runs the
 * real `locale` binary under the env the helper produces, §3 writes real files
 * to a real temp dir and renames them, §5/§6 lift the shipped client functions
 * out of public/js by brace balance and EXECUTE them (a menu entry counts as
 * present only when clicking it actually sends something), and §7 calls the
 * real WebSocket dispatcher and the real session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const browserView = read('public/js/browser-view.js');

/**
 * Lift one `function name(...) { … }` out of a source file by balancing braces.
 * Regex cannot do this: the bodies contain nested functions and `}` in strings.
 */
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

// ═══════════════════════════════════════════════════════════════════════════
describe('§1 — the Chromium process gets a locale that can spell the filename', () => {
  let mod: typeof import('../../src/core/BrowserProfile');
  beforeEach(async () => { mod = await import('../../src/core/BrowserProfile'); });

  it('supplies a locale when the environment has none — the reported bug', () => {
    // The exact environment the bug came from: a container exporting neither
    // variable, where glibc answers "C" and `صفحه.png` becomes `download`.
    const out = mod.withUtf8Locale({ PATH: '/usr/bin' });
    expect(String(out.LANG)).toMatch(/utf-?8/i);
  });

  it('the locale it picks REALLY yields UTF-8 on this machine, not just on paper', () => {
    // The point of the whole fix. `en_US.UTF-8` looks correct and is broken
    // here because the image never generated it — glibc then falls back to "C"
    // in silence. Asking the real `locale` binary is the only assertion that a
    // plausible-looking string cannot satisfy.
    let baseline = '';
    try {
      baseline = execFileSync('locale', ['charmap'], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        encoding: 'utf8',
      }).trim();
    } catch {
      return; // no `locale` binary (non-glibc): nothing to measure, nothing to claim
    }

    const env = mod.withUtf8Locale({ PATH: process.env.PATH || '/usr/bin:/bin' });
    const after = execFileSync('locale', ['charmap'], {
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],   // a bad locale warns on stderr
    }).trim();

    expect(after).toMatch(/UTF-?8/i);
    // …and it genuinely changed something, so the test cannot be vacuous.
    expect(baseline).not.toBe(after);
  });

  it('replaces a non-UTF-8 LANG, which is the same breakage under another name', () => {
    for (const bad of ['C', 'POSIX', 'en_US', 'en_US.ISO-8859-1', 'fa_IR.ISO-8859-6']) {
      const out = mod.withUtf8Locale({ LANG: bad });
      expect(String(out.LANG)).toMatch(/utf-?8/i);
      expect(out.LANG).not.toBe(bad);
    }
  });

  it("keeps an operator's own UTF-8 locale — theirs may carry rules ours does not", () => {
    for (const good of ['en_GB.UTF-8', 'fa_IR.UTF-8', 'de_DE.utf8', 'ja_JP.UTF-8']) {
      expect(mod.withUtf8Locale({ LANG: good }).LANG).toBe(good);
    }
  });

  it('removes an LC_ALL that would override our LANG, because LC_ALL outranks it', () => {
    // Setting LANG while LC_ALL=C is a no-op: LC_ALL wins and the download is
    // still called `download`. This is the case a naive one-line fix misses.
    const out = mod.withUtf8Locale({ LC_ALL: 'C', LANG: 'C' });
    expect(out.LC_ALL).toBeUndefined();
    expect(String(out.LANG)).toMatch(/utf-?8/i);
  });

  it('keeps a UTF-8 LC_ALL and then leaves LANG alone, since LC_ALL already decides', () => {
    const out = mod.withUtf8Locale({ LC_ALL: 'en_GB.UTF-8', LANG: 'C' });
    expect(out.LC_ALL).toBe('en_GB.UTF-8');
    expect(out.LANG).toBe('C');
  });

  it('does not mutate the environment it was handed', () => {
    // It is called with `process.env`. Editing that in place would change the
    // locale of the SERVER process, and of every child it later spawns.
    const src: NodeJS.ProcessEnv = { LC_ALL: 'C', LANG: 'C', KEEP: 'yes' };
    const out = mod.withUtf8Locale(src);
    expect(src.LC_ALL).toBe('C');
    expect(src.LANG).toBe('C');
    expect(out).not.toBe(src);
  });

  it('carries every other variable through untouched', () => {
    // Chromium is started with exactly this object: dropping DISPLAY, PATH or
    // HOME would trade a filename bug for a browser that will not start.
    const out = mod.withUtf8Locale({
      PATH: '/usr/bin', HOME: '/home/user', DISPLAY: ':99', TZ: 'UTC',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/user');
    expect(out.DISPLAY).toBe(':99');
    expect(out.TZ).toBe('UTC');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§2 — a file gets a usable extension even when the site sent none', () => {
  let dir = '';
  let mod: typeof import('../../src/core/RemoteDownloads');

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
  const GIF = Buffer.from('GIF89a...........', 'latin1');
  const WEBP = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '),
  ]);
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]);

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'abext-'));
    mod = await import('../../src/core/RemoteDownloads');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** Write `bytes` under `name`, run the rescue, report the name that resulted. */
  async function rescue(name: string, bytes: Buffer, url: string): Promise<string> {
    const p = join(dir, name);
    await fs.writeFile(p, bytes);
    const finalName = await mod.ensureUsableExtension(p, url);
    // The claim is about a file on DISK, not a returned string, so read it back.
    const listed = await fs.readdir(dir);
    expect(listed, `the returned name is not on disk: ${listed.join()}`).toContain(finalName);
    return finalName;
  }

  it('names the format from the bytes when neither the name nor the URL says', async () => {
    // The measured shape of the bug: `/api/export` served octet-stream and
    // Chrome called the file `export`, which no OS will open.
    expect(await rescue('export', PNG, 'https://x.test/api/export')).toBe('export.png');
    expect(await rescue('download', ZIP, 'https://x.test/files/')).toBe('download.zip');
    expect(await rescue('9f2c4d18-77aa-4e1b', PDF, 'https://x.test/f/9f2c4d18-77aa-4e1b'))
      .toBe('9f2c4d18-77aa-4e1b.pdf');
  });

  it('recognises each format it claims to, by content alone', () => {
    const cases: Array<[Buffer, string]> = [
      [PNG, '.png'], [JPG, '.jpg'], [PDF, '.pdf'], [ZIP, '.zip'],
      [GIF, '.gif'], [WEBP, '.webp'], [MP4, '.mp4'],
    ];
    for (const [bytes, ext] of cases) {
      expect(mod.extensionFromBytes(bytes)).toBe(ext);
    }
  });

  it('says nothing rather than guessing, because a WRONG suffix is worse', async () => {
    // A wrong extension is a lie the user's OS acts on. A missing one is
    // recoverable; `invoice.png` that is really a CSV is not.
    expect(mod.extensionFromBytes(Buffer.from('id,name\n1,a\n'))).toBe('');
    expect(mod.extensionFromBytes(Buffer.from('<html><body>hi'))).toBe('');
    expect(mod.extensionFromBytes(Buffer.alloc(0))).toBe('');
    expect(await rescue('mystery', Buffer.from('nothing familiar here'), 'https://x.test/dl'))
      .toBe('mystery');
  });

  it('does not read past the end of a file too short to hold a signature', () => {
    // `.webp` is checked at offset 8 and `.mp4` at offset 4; a 3-byte file must
    // not be read as though those offsets existed.
    for (const n of [0, 1, 2, 3, 5]) {
      expect(() => mod.extensionFromBytes(Buffer.alloc(n))).not.toThrow();
    }
    expect(mod.extensionFromBytes(Buffer.from([0x89, 0x50]))).toBe('');
  });

  it("prefers the site's own URL path over sniffing, because the site knows best", async () => {
    // `.docx` is a ZIP underneath. Sniffing would rename it `.zip` and Word
    // would stop opening it, so a suffix the site published always wins.
    expect(await rescue('report', ZIP, 'https://x.test/files/report.docx')).toBe('report.docx');
  });

  it('reads only the URL path, never the query string', () => {
    // `/dl?v=1.2` would otherwise produce `download.2`.
    expect(mod.extensionFromUrl('https://x.test/a/photo.png')).toBe('.png');
    expect(mod.extensionFromUrl('https://x.test/dl?file=photo.png')).toBe('');
    expect(mod.extensionFromUrl('https://x.test/dl?v=1.2')).toBe('');
    expect(mod.extensionFromUrl('https://x.test/a/photo.png?sig=abc.def')).toBe('.png');
    expect(mod.extensionFromUrl('https://x.test/files/')).toBe('');
    expect(mod.extensionFromUrl('not a url at all')).toBe('');
  });

  it('leaves a name that already has an extension completely alone', async () => {
    // Including the case the report is really about: a non-ASCII name that
    // arrived intact must not be touched a second time.
    expect(await rescue('photo.png', PNG, 'https://x.test/x.jpg')).toBe('photo.png');
    expect(await rescue('صفحه.png', PNG, 'https://x.test/x.jpg')).toBe('صفحه.png');
    expect(await rescue('報告書.pdf', PDF, 'https://x.test/z')).toBe('報告書.pdf');
  });

  it('keeps a non-ASCII name while ADDING the missing extension', async () => {
    // The two halves of the report meeting in one file: the name survives the
    // locale fix, and the suffix is supplied by the rescue.
    expect(await rescue('صفحه', PNG, 'https://x.test/f/1')).toBe('صفحه.png');
  });

  it('never lets a rescued name escape its own directory', async () => {
    // The extension is concatenated onto a name that ultimately came from a
    // remote server, so the sanitiser has to run again on the result.
    const p = join(dir, 'plain');
    await fs.writeFile(p, PNG);
    const out = await mod.ensureUsableExtension(p, 'https://x.test/a/..%2F..%2Fevil.png');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
    expect(out.startsWith('..')).toBe(false);
    expect(await fs.readdir(dir)).toContain(out);
  });

  it('re-sanitises the joined name, because the suffix is new input', async () => {
    // The extension is concatenated onto a name that came from a remote server,
    // so the result goes back through the one function that decides what a name
    // may contain. MEASURED: `report:v2` + `.pdf` must not keep the colon —
    // Windows treats it as a drive separator and refuses to write the file.
    expect(await rescue('report:v2', PDF, 'https://x.test/f/1')).toBe('report_v2.pdf');
    expect(await rescue('a|b', PNG, 'https://x.test/f/1')).toBe('a_b.png');
  });

  it('goes without a suffix rather than wear a TRUNCATED one', async () => {
    // MEASURED: safeFileName caps at 120 characters and cuts from the end, so a
    // 118-character name came back as `….pn` — a suffix that is not the format,
    // which is the exact outcome this function exists to prevent. Better to
    // return the long name unchanged.
    const long = 'a'.repeat(118);
    expect(await rescue(long, PNG, 'https://x.test/f/1')).toBe(long);
    // …while a name with room to spare still gets its extension.
    const short = 'b'.repeat(110);
    expect(await rescue(short, PNG, 'https://x.test/f/1')).toBe(short + '.png');
  });

  it('survives a file that has vanished, keeping the name it was given', async () => {
    const gone = join(dir, 'not-there');
    await expect(mod.ensureUsableExtension(gone, 'https://x.test/f/1')).resolves.toBe('not-there');
  });

  it('reports a name the caller can actually build a path from', async () => {
    // The shelf row, the Content-Disposition header and the file on disk all
    // take this one name. Three names for one file is how a download gets lost.
    const p = join(dir, 'thing');
    await fs.writeFile(p, PDF);
    const finalName = await mod.ensureUsableExtension(p, 'https://x.test/f/1');
    const finalPath = join(dirname(p), finalName);
    expect(basename(finalPath)).toBe(finalName);
    await expect(fs.readFile(finalPath)).resolves.toBeTruthy();
    // …and the old path is gone, not duplicated.
    await expect(fs.access(p)).rejects.toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§3 — the server reads a filename back out of Content-Disposition', () => {
  let mod: typeof import('../../src/core/RemoteDownloads');
  beforeEach(async () => { mod = await import('../../src/core/RemoteDownloads'); });

  it('prefers filename* over the lossy ASCII copy beside it', () => {
    // Both are usually present and they disagree on purpose: the ASCII one is a
    // deliberately mangled fallback (`_____.png`) for clients from 1999.
    const h = "attachment; filename=\"_____.png\"; filename*=UTF-8''%D8%B5%D9%81%D8%AD%D9%87.png";
    expect(mod.filenameFromContentDisposition(h)).toBe('صفحه.png');
  });

  it('reads the plain form when that is all there is', () => {
    expect(mod.filenameFromContentDisposition('attachment; filename="report.pdf"'))
      .toBe('report.pdf');
    expect(mod.filenameFromContentDisposition('attachment; filename=report.pdf'))
      .toBe('report.pdf');
    expect(mod.filenameFromContentDisposition('inline; filename= spaced.txt ; x=1'))
      .toBe('spaced.txt');
  });

  it('falls back to the ASCII copy when filename* is malformed', () => {
    // A truncated percent-escape makes decodeURIComponent throw. Losing the
    // whole header over it would be worse than using the lossy copy.
    const h = "attachment; filename=\"safe.png\"; filename*=UTF-8''%E0%A4%A";
    expect(mod.filenameFromContentDisposition(h)).toBe('safe.png');
  });

  it("returns '' when there is no name — the emptiness that caused a real bug", () => {
    // This MUST stay distinguishable at the call site: safeFileName('') returns
    // the placeholder `file`, which is truthy, so sanitising before testing
    // renamed every download to `file`. Pinned from the other end in §6.
    expect(mod.filenameFromContentDisposition('attachment')).toBe('');
    expect(mod.filenameFromContentDisposition('')).toBe('');
    expect(mod.filenameFromContentDisposition('inline')).toBe('');
  });

  it('is a true inverse of the header this server itself writes', () => {
    // The client fetches from our own route, so the two functions must agree —
    // a round trip is the only assertion that keeps them agreeing over time.
    for (const name of ['report.pdf', 'صفحه.png', 'Unicode (1).zip', "quote'd.txt"]) {
      const header = mod.contentDispositionAttachment(name);
      expect(mod.filenameFromContentDisposition(header)).toBe(name);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§4 — the browser tab obeys the same header, not its stale shelf row', () => {
  // The shelf row was named when the download STARTED; the server may have
  // improved on it since (extension rescue, Content-Disposition). The client
  // must prefer what the response says, or the rescue is undone on the last hop.
  const api = (() => {
    const src = [
      grabFunction(browserView, 'nameFromDisposition'),
      'return { nameFromDisposition: nameFromDisposition };',
    ].join('\n');
    return new Function(src)() as { nameFromDisposition: (cd: string | null) => string };
  })();

  it('decodes the UTF-8 form, which is how a non-ASCII name survives the wire', () => {
    expect(api.nameFromDisposition(
      "attachment; filename=\"_____.png\"; filename*=UTF-8''%D8%B5%D9%81%D8%AD%D9%87.png",
    )).toBe('صفحه.png');
  });

  it('reads the plain form, quoted or bare', () => {
    expect(api.nameFromDisposition('attachment; filename="a b.pdf"')).toBe('a b.pdf');
    expect(api.nameFromDisposition('attachment; filename=a.pdf')).toBe('a.pdf');
  });

  it("returns '' for a header with no name, and for no header at all", () => {
    // `fetch(...).headers.get()` returns null when the header is absent, and
    // the caller uses that emptiness to keep the shelf row's own name.
    expect(api.nameFromDisposition('attachment')).toBe('');
    expect(api.nameFromDisposition(null)).toBe('');
    expect(api.nameFromDisposition('')).toBe('');
  });

  it('agrees with the server parser on every case both can see', async () => {
    // Two parsers, one header. They drift the moment nobody checks.
    const server = await import('../../src/core/RemoteDownloads');
    for (const h of [
      'attachment; filename="report.pdf"',
      "attachment; filename=\"_____.png\"; filename*=UTF-8''%D8%B5%D9%81%D8%AD%D9%87.png",
      'attachment; filename=plain.txt',
      'attachment',
      '',
    ]) {
      expect(api.nameFromDisposition(h)).toBe(server.filenameFromContentDisposition(h));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 — the page's right-click menu, EXECUTED.
//
// The shipped `openPageMenu`, `saveUrlToShelf`, `openCtx` and `closeCtx` are
// lifted out of public/js/browser-view.js and run against DOM stand-ins. An
// entry counts as present only when clicking it actually calls something.
// ═══════════════════════════════════════════════════════════════════════════
interface MenuEntry { sep: boolean; label: string; disabled: boolean; click: () => void }
interface MenuRun {
  entries: MenuEntry[];
  labels: string[];
  sent: Array<Record<string, unknown>>;
  copied: string[];
  toasts: Array<{ msg: string; kind: string }>;
  selectMode: boolean[];
  click: (key: string) => void;
  has: (key: string) => boolean;
  enabled: (key: string) => boolean;
}

function buildMenu(
  info: Record<string, unknown>,
  pageUrl = 'https://site.test/page',
  nav: { canBack?: boolean; canFwd?: boolean } = {},
): MenuRun {
  const sent: Array<Record<string, unknown>> = [];
  const copied: string[] = [];
  const toasts: Array<{ msg: string; kind: string }> = [];
  const selectMode: boolean[] = [];
  const entries: MenuEntry[] = [];

  const makeEl = (tag: string) => {
    const el: Record<string, unknown> = {
      tag,
      children: [] as unknown[],
      className: '',
      textContent: '',
      innerHTML: '',
      style: {},
      disabled: false,
      _click: null as null | (() => void),
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild(c: unknown) { (el.children as unknown[]).push(c); },
      addEventListener(ev: string, fn: () => void) { if (ev === 'click') el._click = fn; },
      getBoundingClientRect: () => ({ width: 220, height: 320, top: 0, left: 0 }),
      remove() {},
    };
    return el;
  };

  // The menu host. `innerHTML = ''` must really empty it, because openCtx
  // rebuilds the menu from scratch on every open.
  const host = makeEl('div') as Record<string, unknown> & { children: unknown[] };
  Object.defineProperty(host, 'innerHTML', {
    get: () => '',
    set: () => { host.children.length = 0; },
  });

  const sandbox: Record<string, unknown> = {
    document: {
      createElement: (t: string) => makeEl(t),
      body: { appendChild() {}, removeChild() {} },
    },
    window: { innerWidth: 1440, innerHeight: 900, Icons: null },
    q: (id: string) => (id === 'bvp-ctx' ? host : null),
    BIC: () => '',
    t: (k: string) => 'i18n:' + k,
    // The address bar IS the client's copy of "where this tab is".
    urlIn: { value: pageUrl },
    canvas: {
      width: 1280,
      height: 720,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    },
    pickState: {
      zoom: 1,
      ctxOpen: false,
      rio: null,
      canBack: !!nav.canBack,
      canFwd: !!nav.canFwd,
    },
    send: (m: Record<string, unknown>) => { sent.push(m); },
    copyText: (s: string) => { copied.push(String(s)); },
    toast: (msg: string, kind: string) => { toasts.push({ msg, kind }); },
    applySelectMode: (on: boolean) => { selectMode.push(on); },
    pasteIntoPage: () => { sent.push({ t: '__paste' }); },
    encodeURIComponent,
    Number, String, Math, RegExp,
  };

  const src = [
    grabFunction(browserView, 'closeCtx'),
    grabFunction(browserView, 'openCtx'),
    grabFunction(browserView, 'saveUrlToShelf'),
    grabFunction(browserView, 'openPageMenu'),
    'return { openPageMenu: openPageMenu };',
  ].join('\n');

  const keys = Object.keys(sandbox);
  const api = new Function(...keys, src)(...keys.map((k) => sandbox[k])) as {
    openPageMenu: (i: Record<string, unknown>) => void;
  };
  api.openPageMenu(info);

  for (const raw of host.children as Array<Record<string, unknown>>) {
    if (raw.className === 'bvp-ctx-sep') {
      entries.push({ sep: true, label: '', disabled: false, click: () => {} });
      continue;
    }
    const label = ((raw.children as Array<Record<string, unknown>>)
      .find((c) => c.className === 'bvp-ctx-label')?.textContent as string) || '';
    entries.push({
      sep: false,
      label,
      disabled: !!raw.disabled,
      click: () => { (raw._click as () => void)(); },
    });
  }

  const labels = entries.map((e) => (e.sep ? '│' : e.label));
  const find = (key: string) => entries.find((e) => !e.sep && e.label === 'i18n:' + key);
  return {
    entries,
    labels,
    sent,
    copied,
    toasts,
    selectMode,
    has: (key: string) => !!find(key),
    enabled: (key: string) => { const e = find(key); return !!e && !e.disabled; },
    click: (key: string) => {
      const e = find(key);
      if (!e) throw new Error(`menu has no entry ${key}; it has: ${labels.join(' ')}`);
      e.click();
    },
  };
}

/**
 * The two rules `openPageMenu` cannot currently reach, exercised where they
 * actually live.
 *
 * MEASURED (tools/probe-seps-tmp.js, since deleted): with the separator-collapse
 * rule REMOVED, all nine menu shapes still rendered correctly — every section's
 * separator is itself conditional, so today nothing strands one. The same holds
 * for `saveUrlToShelf('')`: `canSave('')` is already false, so no menu entry can
 * pass it an empty URL.
 *
 * Both guards are therefore defensive, and a test that only drove the menu was
 * measured to pass with either one deleted. They are pinned here instead — at
 * `openCtx` and `saveUrlToShelf` themselves, which is the level their contract
 * is written at, and where the next conditional section added to the menu will
 * depend on them.
 */
describe('§5a — the two rules that keep the menu safe to extend', () => {
  function openCtxWith(items: Array<Record<string, unknown>>): string[] {
    const rendered: string[] = [];
    const mk = (tag: string) => {
      const el: Record<string, unknown> = {
        tag, children: [] as unknown[], className: '', textContent: '', style: {},
        disabled: false,
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        appendChild(c: unknown) { (el.children as unknown[]).push(c); },
        addEventListener() {},
        getBoundingClientRect: () => ({ width: 200, height: 300, top: 0, left: 0 }),
      };
      return el;
    };
    const host = mk('div') as Record<string, unknown> & { children: unknown[] };
    Object.defineProperty(host, 'innerHTML', {
      get: () => '', set: () => { host.children.length = 0; },
    });

    const sandbox: Record<string, unknown> = {
      document: { createElement: (t: string) => mk(t) },
      window: { innerWidth: 1440, innerHeight: 900 },
      q: (id: string) => (id === 'bvp-ctx' ? host : null),
      BIC: () => '',
      pickState: { ctxOpen: false },
      Math,
    };
    const src = [
      grabFunction(browserView, 'closeCtx'),
      grabFunction(browserView, 'openCtx'),
      'return openCtx;',
    ].join('\n');
    const keys = Object.keys(sandbox);
    const openCtx = new Function(...keys, src)(...keys.map((k) => sandbox[k])) as
      (x: number, y: number, items: unknown[]) => void;
    openCtx(10, 10, items);

    for (const c of host.children as Array<Record<string, unknown>>) {
      rendered.push(c.className === 'bvp-ctx-sep'
        ? '│'
        : (((c.children as Array<Record<string, unknown>>)
            .find((x) => x.className === 'bvp-ctx-label')?.textContent as string) || '?'));
    }
    return rendered;
  }

  it('collapses separators that lost the section they belonged to', () => {
    const item = (label: string, off = false) => ({ label, off, run() {} });
    // A leading rule, a doubled rule and a trailing rule — the three shapes a
    // conditional section leaves behind when it switches off.
    expect(openCtxWith([
      { sep: true },
      item('A'),
      { sep: true },
      { sep: true },
      item('B'),
      { sep: true },
    ])).toEqual(['A', '│', 'B']);

    // A whole section off in the middle must not leave two rules touching.
    expect(openCtxWith([
      item('A'), { sep: true },
      item('gone', true), { sep: true },
      item('B'),
    ])).toEqual(['A', '│', 'B']);

    // A menu that is nothing but rules renders nothing, not a stack of lines.
    expect(openCtxWith([{ sep: true }, { sep: true }])).toEqual([]);

    // …and a rule that still divides two live items is kept.
    expect(openCtxWith([item('A'), { sep: true }, item('B')])).toEqual(['A', '│', 'B']);
  });

  it('refuses to ask the server to save nothing', () => {
    // An empty URL would mint a shelf row, a token and a directory for a
    // download that can only ever fail.
    const sent: unknown[] = [];
    const toasts: unknown[] = [];
    const sandbox: Record<string, unknown> = {
      send: (m: unknown) => { sent.push(m); },
      toast: (m: unknown) => { toasts.push(m); },
      t: (k: string) => k,
    };
    const keys = Object.keys(sandbox);
    const saveUrlToShelf = new Function(
      ...keys,
      grabFunction(browserView, 'saveUrlToShelf') + '\nreturn saveUrlToShelf;',
    )(...keys.map((k) => sandbox[k])) as (u: string) => void;

    saveUrlToShelf('');
    expect(sent).toEqual([]);
    // …and no toast either: a message about a download that is not happening is
    // worse than silence.
    expect(toasts).toEqual([]);

    saveUrlToShelf('https://cdn.test/a.png');
    expect(sent).toEqual([{ t: 'saveUrl', url: 'https://cdn.test/a.png' }]);
    expect(toasts.length).toBe(1);
  });
});

describe('§5 — the right-click menu offers what a real browser offers', () => {
  const IMG = 'https://cdn.test/a/photo.png';
  const LINK = 'https://other.test/doc.pdf';
  const MEDIA = 'https://cdn.test/v/clip.mp4';

  it('right-clicking an image offers to SAVE it, and saving asks the server', () => {
    // The headline ask — «دانلود ایمیج» was named in the report, and Chrome's
    // own menu has it.
    const m = buildMenu({ x: 10, y: 20, imageUrl: IMG });
    expect(m.has('bvp.cmSaveImageAs')).toBe(true);

    m.click('bvp.cmSaveImageAs');
    // Measured: an injected cross-origin `<a download>` NAVIGATES instead of
    // downloading, and an in-page fetch() is refused by CORS. Only a
    // server-side fetch works, so the click must leave the browser.
    expect(m.sent).toContainEqual({ t: 'saveUrl', url: IMG });
    // …and say so, because the bytes travel to the server first and an item
    // that looks inert gets clicked again and again.
    expect(m.toasts.length).toBe(1);
  });

  it('offers to save a link target, a video/audio source and the page — «هر چیزی»', () => {
    const link = buildMenu({ x: 1, y: 1, linkUrl: LINK, linkText: 'The report' });
    link.click('bvp.cmSaveLinkAs');
    expect(link.sent).toContainEqual({ t: 'saveUrl', url: LINK });

    const media = buildMenu({ x: 1, y: 1, mediaUrl: MEDIA });
    media.click('bvp.cmSaveMediaAs');
    expect(media.sent).toContainEqual({ t: 'saveUrl', url: MEDIA });

    const page = buildMenu({ x: 1, y: 1 }, 'https://site.test/report');
    page.click('bvp.cmSavePageAs');
    expect(page.sent).toContainEqual({ t: 'saveUrl', url: 'https://site.test/report' });
  });

  it('hides "save" for a target the server could never fetch', () => {
    // A `blob:` or `data:` URL lives inside the renderer. Offering to save it
    // would be offering a button that always fails — worse than no button.
    for (const bad of ['blob:https://site.test/9f2c', 'data:image/png;base64,iVBOR']) {
      const m = buildMenu({ x: 1, y: 1, imageUrl: bad });
      expect(m.has('bvp.cmSaveImageAs')).toBe(false);
      // …but the address is still copyable, exactly as in Chrome.
      expect(m.has('bvp.cmCopyImage')).toBe(true);
      m.click('bvp.cmCopyImage');
      expect(m.copied).toContain(bad);
    }
  });

  it('never sends an empty save request', () => {
    // `saveUrlToShelf('')` would create a doomed shelf row out of nothing.
    const m = buildMenu({ x: 1, y: 1 }, '');
    expect(m.has('bvp.cmSavePageAs')).toBe(false);
    expect(m.sent.filter((s) => s.t === 'saveUrl').length).toBe(0);
  });

  it('shows only the sections that apply to what was clicked', () => {
    // A menu that always offered everything would be a menu where most entries
    // do nothing — Chrome varies its menu by target and so must this.
    const plain = buildMenu({ x: 1, y: 1 });
    for (const gone of [
      'bvp.cmOpenNewTab', 'bvp.cmSaveLinkAs', 'bvp.cmCopyLink', 'bvp.cmCopyLinkText',
      'bvp.cmOpenImage', 'bvp.cmSaveImageAs', 'bvp.cmCopyImage',
      'bvp.cmSaveMediaAs', 'bvp.cmCopyMedia', 'bvp.cmPaste', 'bvp.cmCut', 'bvp.cmSearchSel',
    ]) expect(plain.has(gone), `${gone} should be hidden on plain text`).toBe(false);

    for (const kept of [
      'bvp.cmBack', 'bvp.cmForward', 'bvp.cmReload', 'bvp.cmCopy', 'bvp.cmSelectAll',
      'bvp.cmSavePageAs', 'bvp.cmViewSource', 'bvp.cmCopyPageUrl', 'bvp.cmPrint',
      'bvp.cmInspect',
    ]) expect(plain.has(kept), `${kept} should always be offered`).toBe(true);
  });

  it('offers editing entries only inside an editable field', () => {
    const plain = buildMenu({ x: 1, y: 1, hasSelection: true });
    expect(plain.has('bvp.cmPaste')).toBe(false);
    expect(plain.has('bvp.cmCut')).toBe(false);

    const box = buildMenu({ x: 1, y: 1, editable: true, hasSelection: true });
    expect(box.has('bvp.cmPaste')).toBe(true);
    box.click('bvp.cmCut');
    // Cut is Copy+delete and BOTH halves must happen in the remote page, so it
    // goes through the key translator rather than being faked as two messages.
    expect(box.sent).toContainEqual({ t: 'key', key: 'x', mods: { ctrl: true } });
  });

  it('greys out Cut and Copy when nothing is selected, rather than hiding them', () => {
    // Chrome greys these; hiding them makes the menu jump around under the
    // pointer between two right-clicks in the same text box.
    const empty = buildMenu({ x: 1, y: 1, editable: true, hasSelection: false });
    expect(empty.has('bvp.cmCut')).toBe(true);
    expect(empty.enabled('bvp.cmCut')).toBe(false);
    expect(empty.enabled('bvp.cmCopy')).toBe(false);

    const some = buildMenu({ x: 1, y: 1, editable: true, hasSelection: true });
    expect(some.enabled('bvp.cmCut')).toBe(true);
    expect(some.enabled('bvp.cmCopy')).toBe(true);
  });

  it('greys Back and Forward to match the actual history', () => {
    const fresh = buildMenu({ x: 1, y: 1 }, 'https://site.test/', {});
    expect(fresh.enabled('bvp.cmBack')).toBe(false);
    expect(fresh.enabled('bvp.cmForward')).toBe(false);

    const deep = buildMenu({ x: 1, y: 1 }, 'https://site.test/', { canBack: true, canFwd: true });
    expect(deep.enabled('bvp.cmBack')).toBe(true);
    deep.click('bvp.cmBack');
    expect(deep.sent).toContainEqual({ t: 'back' });
  });

  it('searches a selection in a NEW tab, with the text escaped into the query', () => {
    const m = buildMenu({ x: 1, y: 1, hasSelection: true, selection: 'کد ملی & id=1' });
    m.click('bvp.cmSearchSel');
    const msg = m.sent.find((s) => s.t === 'tabNew');
    expect(msg, 'search did not open a tab').toBeTruthy();
    const u = String(msg!.url);
    expect(u.startsWith('https://')).toBe(true);
    // Escaped, or an ampersand in the selection would truncate the search.
    expect(u).toContain(encodeURIComponent('کد ملی & id=1'));
    expect(u).not.toContain('& id=1');
  });

  it('opens a link and an image in a NEW tab, never in the one being read', () => {
    const m = buildMenu({ x: 1, y: 1, linkUrl: LINK, imageUrl: IMG });
    m.click('bvp.cmOpenNewTab');
    expect(m.sent).toContainEqual({ t: 'tabNew', url: LINK });
    m.click('bvp.cmOpenImage');
    expect(m.sent).toContainEqual({ t: 'tabNew', url: IMG });
    expect(m.sent.some((s) => s.t === 'navigate')).toBe(false);
  });

  it("copies a link's address and its text as two separate things", () => {
    // Chrome has both, and they are different answers: one is where it goes,
    // the other is what it said.
    const m = buildMenu({ x: 1, y: 1, linkUrl: LINK, linkText: 'Q3 report' });
    m.click('bvp.cmCopyLink');
    m.click('bvp.cmCopyLinkText');
    expect(m.copied).toEqual([LINK, 'Q3 report']);

    // A link with no text (an image wrapped in an anchor) offers no "copy text".
    const bare = buildMenu({ x: 1, y: 1, linkUrl: LINK, imageUrl: IMG });
    expect(bare.has('bvp.cmCopyLinkText')).toBe(false);
  });

  it('views source and prints through the REMOTE browser, not this one', () => {
    const m = buildMenu({ x: 1, y: 1 }, 'https://site.test/a?b=1');
    m.click('bvp.cmViewSource');
    expect(m.sent).toContainEqual({ t: 'tabNew', url: 'view-source:https://site.test/a?b=1' });
    m.click('bvp.cmPrint');
    // Printing the canvas would print a picture of a browser; the remote Chrome
    // owns the page, so Ctrl+P has to happen over there.
    expect(m.sent).toContainEqual({ t: 'key', key: 'p', mods: { ctrl: true } });
  });

  it('copies the page address from the address bar, which cannot go stale', () => {
    const m = buildMenu({ x: 1, y: 1 }, 'https://site.test/deep/page?q=1');
    m.click('bvp.cmCopyPageUrl');
    expect(m.copied).toEqual(['https://site.test/deep/page?q=1']);
  });

  it('Inspect arms element selection and locks the element under the pointer', () => {
    const m = buildMenu({ x: 300, y: 150 });
    m.click('bvp.cmInspect');
    expect(m.selectMode).toEqual([true]);
    expect(m.sent).toContainEqual({ t: 'click', x: 300, y: 150 });
  });

  it('leaves no separator stranded, whatever the target is', () => {
    // The menu is built from many conditional sections, so switching one off
    // used to leave its rule behind — two rules with nothing between them, or a
    // rule at the very top or bottom, reads as a rendering bug.
    const shapes: Array<[string, Record<string, unknown>]> = [
      ['plain text', {}],
      ['a link', { linkUrl: LINK, linkText: 'x' }],
      ['a bare image', { imageUrl: IMG }],
      ['a linked image', { linkUrl: LINK, imageUrl: IMG }],
      ['a video', { mediaUrl: MEDIA }],
      ['a text box', { editable: true }],
      ['a text box with a selection', { editable: true, hasSelection: true, selection: 'hi' }],
      ['a selection in the page', { hasSelection: true, selection: 'hi' }],
      ['everything at once', {
        linkUrl: LINK, linkText: 'x', imageUrl: IMG, mediaUrl: MEDIA,
        editable: true, hasSelection: true, selection: 'hi',
      }],
    ];
    for (const [what, info] of shapes) {
      const m = buildMenu({ x: 1, y: 1, ...info });
      const seps = m.entries.map((e) => e.sep);
      expect(seps.length).toBeGreaterThan(0);
      expect(seps[0], `${what}: menu starts with a separator`).toBe(false);
      expect(seps[seps.length - 1], `${what}: menu ends with a separator`).toBe(false);
      for (let i = 1; i < seps.length; i++) {
        expect(seps[i] && seps[i - 1], `${what}: two separators in a row at ${i}`).toBe(false);
      }
    }
  });

  it('every entry it renders actually does something when clicked', () => {
    // The real content of "the menu has this option": not that a label exists,
    // but that pressing it reaches the server, the clipboard or the picker.
    const m = buildMenu({
      x: 5, y: 6,
      linkUrl: LINK, linkText: 'x', imageUrl: IMG, mediaUrl: MEDIA,
      editable: true, hasSelection: true, selection: 'hi',
    }, 'https://site.test/p');

    let acted = 0;
    for (const e of m.entries) {
      if (e.sep || e.disabled) continue;
      const before = m.sent.length + m.copied.length + m.selectMode.length;
      e.click();
      const after = m.sent.length + m.copied.length + m.selectMode.length;
      expect(after, `"${e.label}" did nothing at all`).toBeGreaterThan(before);
      acted++;
    }
    // The full-house menu is the biggest one there is; if it ever shrinks to a
    // handful of entries this loop would pass while proving nothing.
    expect(acted).toBeGreaterThanOrEqual(18);
  });

  it('every label it renders is a real translated string, in both languages', () => {
    // A missing key renders as the key itself — a literal `bvp.cmSaveImageAs`
    // in the menu — so the dictionary is checked for the keys the menu used.
    const i18n = read('public/js/i18n.js');
    const m = buildMenu({
      x: 1, y: 1,
      linkUrl: LINK, linkText: 'x', imageUrl: IMG, mediaUrl: MEDIA,
      editable: true, hasSelection: true, selection: 'hi',
    });
    const used = m.entries.filter((e) => !e.sep).map((e) => e.label.replace(/^i18n:/, ''));
    expect(used.length).toBeGreaterThan(15);

    // Execute the shipped dictionary rather than grepping it: this proves each
    // key resolves through the real lookup, in the real table, per language.
    const win: Record<string, unknown> = {};
    new Function('window', 'localStorage', 'document', i18n)(
      win,
      { getItem: () => null, setItem: () => {} },
      {
        documentElement: {}, body: null,
        querySelectorAll: () => [],
        dispatchEvent: () => {},
      },
    );
    const I18N = win.I18N as { t: (k: string) => string; setLang: (l: string) => void };
    for (const lang of ['en', 'fa']) {
      I18N.setLang(lang);
      for (const key of used) {
        expect(I18N.t(key), `${lang} is missing ${key}`).not.toBe(key);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§6 — the save request survives the trip to the server', () => {
  it('the WebSocket dispatcher routes saveUrl to the session that can do it', async () => {
    // The client can send a perfect message and the menu still does nothing if
    // the server has no case for it — measured once already on this very panel,
    // where a button sent `newTab` and the server only knew `tabNew`. So the
    // REAL dispatcher is called here, not a copy of it.
    const { BrowserStreamServer } = await import('../../src/core/BrowserStreamServer');
    const { LiveBrowserManager } = await import('../../src/core/LiveBrowser');

    const calls: Array<[string, string]> = [];
    const session = {
      isClosed: () => false,
      saveUrl: async (u: string, n: string) => { calls.push([u, n]); },
    };

    const server = new BrowserStreamServer(new LiveBrowserManager(1));
    const dispatch = (msg: Record<string, unknown>) =>
      (server as unknown as {
        handleCommand: (s: unknown, m: Record<string, unknown>) => Promise<void>;
      }).handleCommand(session, msg);

    await dispatch({ t: 'saveUrl', url: 'https://cdn.test/a/photo.png' });
    expect(calls).toEqual([['https://cdn.test/a/photo.png', '']]);

    // An unknown command is ignored, not misrouted into this one.
    await dispatch({ t: 'definitelyNotACommand', url: 'https://cdn.test/x' });
    expect(calls.length).toBe(1);
  });

  it('refuses a scheme the server has no business fetching, without throwing', async () => {
    // `saveUrl` is reachable from a socket, so a `file:` or `javascript:` URL
    // arriving here is an SSRF attempt, not a typo. It has to be rejected by
    // the session itself rather than relying on the menu having hidden the entry.
    const { LiveBrowserManager } = await import('../../src/core/LiveBrowser');
    const session = new LiveBrowserManager(2).create('u1');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    session.setSinks(() => {}, (type, data) => { events.push({ type, data }); });

    const bad = ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x', 'not a url', ''];
    for (const u of bad) {
      await expect(session.saveUrl(u)).resolves.toBeUndefined();
    }
    expect(events.length).toBe(bad.length);
    for (const e of events) {
      expect(e.type).toBe('downloadError');
      expect(String(e.data.error)).toMatch(/bad_url|unsupported_scheme/);
    }
    // Nothing was ever put on the shelf for any of them.
    expect(session.downloadList()).toEqual([]);
    await session.close().catch(() => {});
  });
});
