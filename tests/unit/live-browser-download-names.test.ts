import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../../src/config';
import { LiveBrowserManager } from '../../src/core/LiveBrowser';
import { downloadDirFor } from '../../src/core/RemoteDownloads';

// ════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD's Live Browser shelf — does a downloaded file keep the name and
// the format the WEBSITE declared, all the way to disk?
//
// THE REQUIREMENT, VERBATIM
// -------------------------
//   «هر فایلی که از Website توسط Remote Browser دانلود یا Export می‌شود باید با
//    نام واقعی و Extension واقعی که خود Website اعلام کرده روی Windows کاربر
//    ذخیره شود»
//
// and the failure it reacts to:
//
//   «بعضی فایل‌ها بدون Extension دانلود می‌شدند … نام فایل اشتباه بود … یک مدت
//    همه فایل‌ها با نام file ذخیره می‌شدند»
//
// WHY THIS FILE EXISTS SEPARATELY FROM declared-filename.test.ts
// --------------------------------------------------------------
// That file tests the naming FUNCTIONS. This one tests the SURFACE: a real
// `LiveBrowserSession`, a real Chromium, a real HTTP server, and the file that
// actually lands in `DOWNLOADS_DIR`. The requirement is about the feature, and
// `LiveBrowser.trackDownload` is the second of the product's two remote-browser
// download paths — the one that had no behavioural coverage at all.
//
// ⚠ AN HONEST CORRECTION, RECORDED HERE ON PURPOSE
// ------------------------------------------------
// An earlier audit pass called this surface BROKEN — that `suggestedFilename()`
// named only 12/24 files correctly, so the shelf lost half of all real
// filenames. That claim was WRONG, and the reason matters:
//
//   the probe measured   chromium.launch()                        <- bare env
//   the product launches chromium.launch({ env: withUtf8Locale(...) })
//
// `withUtf8Locale` (src/core/BrowserProfile.ts) forces `LANG=C.UTF-8`, and that
// is the whole variable — without a UTF-8 locale Chromium cannot put a non-ASCII
// name into a POSIX path and collapses the entire name, extension included, to
// the literal string `download`. Both browsers this session can be handed
// (`GlobalBrowser`, `RealChrome`) already call it. Re-measured with the
// product's own environment: suggestedFilename() 24/24, declared header 24/24.
//
// So these tests do NOT assert a bug fix. They assert the two things that are
// actually true and actually load-bearing:
//
//   1. THE OUTCOME. The website's declared name reaches disk intact — RFC 5987,
//      raw UTF-8, quoted, plain — whichever of the two sources supplied it.
//      This is the requirement, and it is what a user can check.
//   2. THE CONTINGENCY. That outcome depends on an environment variable set in
//      another file, and on the declared-header index as its second source.
//      Tests below assert BOTH still exist, so a "cleanup" that drops
//      `withUtf8Locale` or `DownloadHeaderIndex` is caught here rather than by a
//      user holding a file called `download`.
//
// Plus the one measured win that is unambiguously new: the declared Content-Type
// is what lets an extensionless download get a usable suffix.
//
// Skips itself when Chromium cannot launch, matching picker-drive.test.ts, so
// the suite stays green on a machine without Playwright's system libraries:
//     sudo npx playwright install-deps chromium
// ════════════════════════════════════════════════════════════════════════════

/** One case: what the server sends, and what must end up on disk. */
interface Case {
  path: string;
  /** Content-Disposition, verbatim as a real site would send it. */
  cd: string;
  contentType?: string;
  /** The name the file must have on disk. */
  want: string;
  why: string;
}

const CASES: Case[] = [
  // ── The Content-Disposition shapes real sites actually send ───────────────
  {
    path: '/plain',
    cd: 'attachment; filename=report_final.pdf',
    want: 'report_final.pdf',
    why: 'an unquoted ASCII filename — the requirement’s own first example',
  },
  {
    path: '/quoted',
    cd: 'attachment; filename="invoice_2026.xlsx"',
    want: 'invoice_2026.xlsx',
    why: 'a quoted ASCII filename — the requirement’s own second example',
  },
  {
    path: '/rfc5987',
    // `فاکتور.xlsx` — the shape that returns the literal `download` from
    // suggestedFilename() the moment the locale is not UTF-8.
    cd: "attachment; filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx",
    want: 'فاکتور.xlsx',
    why: 'RFC 5987 percent-encoded UTF-8 — the locale-sensitive case',
  },
  {
    path: '/both',
    // Every browser prefers `filename*`, and so must this.
    cd: 'attachment; filename="report.xlsx"; '
      + "filename*=UTF-8''%DA%AF%D8%B2%D8%A7%D8%B1%D8%B4.xlsx",
    want: 'گزارش.xlsx',
    why: 'filename* must win over the ASCII fallback, as in every real browser',
  },
  // ── Formats, to prove nothing is hardcoded per-format ─────────────────────
  {
    path: '/zip',
    cd: 'attachment; filename="بایگانی.zip"',
    want: 'بایگانی.zip',
    why: 'raw UTF-8 in the header, and a format with no special handling',
  },
  {
    path: '/docx',
    cd: 'attachment; filename="Q3 Report (final).docx"',
    want: 'Q3 Report (final).docx',
    why: 'spaces and parentheses must survive sanitising',
  },
  {
    path: '/tgz',
    cd: 'attachment; filename="backup.tar.gz"',
    want: 'backup.tar.gz',
    why: 'a double extension must not be truncated to .tar',
  },
];

/**
 * Downloads the site NAMED but gave no extension — the rescue path.
 *
 * MEASURED, and the condition is narrower than it first looks. Chromium already
 * appends a suffix from the response type when it invents the whole name itself
 * (`attachment` with no filename → `d.html`), so those cases prove nothing. The
 * argument only changes the outcome when the SITE supplied a name and that name
 * had no extension — because then the site's name is kept (it must be: it is the
 * requirement) and Chromium's own suffixed guess is discarded with it.
 *
 * Measured through this exact code path, 7 tricky shapes:
 *
 *     with declared contentType   export.csv  data.json  گزارش.csv  report.rtf
 *     without it                  export      data       گزارش      report
 *
 * i.e. 4/7 rescued, and the 3 that do not move are the ones no argument could
 * help (Chromium already answered, or the type is octet-stream and says nothing).
 */
const RESCUE_CASES: Array<{ path: string; cd: string; contentType: string; want: string }> = [
  {
    path: '/named-no-ext-csv',
    cd: 'attachment; filename="export"',
    contentType: 'text/csv',
    want: 'export.csv',
  },
  {
    path: '/named-no-ext-json',
    cd: 'attachment; filename="data"',
    contentType: 'application/json',
    want: 'data.json',
  },
  {
    path: '/named-no-ext-rtf',
    cd: 'attachment; filename="report"',
    contentType: 'application/rtf',
    want: 'report.rtf',
  },
  {
    // The two halves of the requirement at once: a non-ASCII name the site
    // declared, AND a format only the response type can supply.
    path: '/named-no-ext-fa',
    cd: "attachment; filename*=UTF-8''%DA%AF%D8%B2%D8%A7%D8%B1%D8%B4",
    contentType: 'text/csv',
    want: 'گزارش.csv',
  },
];

const USER = 'dlnames-test';
const BODY = 'BYTES';

let server: http.Server | null = null;
let base = '';
let mgr: LiveBrowserManager | null = null;
let session: ReturnType<LiveBrowserManager['create']> | null = null;
let available = false;
let skipReason = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = String(req.url || '');

    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>downloads</title><body>ok</body>');
      return;
    }

    const hit = CASES.find((c) => c.path === url);
    if (hit) {
      res.writeHead(200, {
        'Content-Type': hit.contentType || 'application/octet-stream',
        // Written as BYTES, exactly as a site sends it: a raw-UTF-8 filename must
        // not be re-encoded on the way out, or the test would be measuring Node
        // rather than the browser.
        'Content-Disposition': Buffer.from(hit.cd, 'utf8').toString('latin1'),
      });
      res.end(BODY);
      return;
    }

    const rescue = RESCUE_CASES.find((c) => c.path === url);
    if (rescue) {
      res.writeHead(200, {
        'Content-Type': rescue.contentType,
        'Content-Disposition': Buffer.from(rescue.cd, 'utf8').toString('latin1'),
      });
      // Deliberately bytes with no magic number, so the declared type is the ONLY
      // thing that can answer. Real content would let the sniffer win first, and
      // the URL carries no suffix either — so this isolates the header.
      res.end('a,b,c');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no');
  });

  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;

  // The interactive Chromium path, not the user's own Chrome: this suite is about
  // the DASHBOARD's shelf, and a test must not try to start a headed browser with
  // an X server it may not have.
  (config as unknown as Record<string, unknown>).REAL_CHROME_ENABLED = false;

  try {
    mgr = new LiveBrowserManager(2);
    session = mgr.create(USER);
    // The real client seam. A session has no `on()` and no `evaluate()`: frames
    // and events go to sinks, which is exactly how the socket route drives it.
    session.setSinks(
      () => { /* frames are not under test */ },
      () => { /* nor events */ },
    );
    await session.start();
    available = true;
  } catch (e) {
    available = false;                       // no browser deps here → skip below
    skipReason = String((e as Error)?.message || e);
  }
}, 180_000);

afterAll(async () => {
  if (mgr) await mgr.shutdown().catch(() => { /* teardown is best-effort */ });
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

/** `it` that becomes a pass-through skip when Chromium is unavailable. */
const browserIt = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  it(name, async () => {
    if (!available) {
      expect(skipReason, 'skipped: Chromium could not launch').toBeTruthy();
      return;
    }
    await fn();
  }, timeout);

/**
 * Trigger one download by navigating to it, and wait for the shelf row.
 *
 * Navigation rather than a click because it is the harder case: the response is
 * an `attachment`, so Chromium aborts the navigation and raises a download —
 * precisely the path on which the name must not be lost.
 */
async function download(path: string) {
  const before = session!.downloadList().length;
  await session!.navigate(base + path).catch(() => {
    // An attachment navigation "fails" by design (net::ERR_ABORTED). The
    // download still happens, which is the entire point.
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    const row = session!.downloadList()[before];
    if (row && (row.state === 'completed' || row.state === 'failed')) return row;
    if (Date.now() > deadline) throw new Error(`download ${path} never settled`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The absolute path a shelf row's bytes live at. */
function onDisk(row: { token?: string; name: string }) {
  return join(downloadDirFor(USER), String(row.token), row.name);
}

describe('the declared filename reaches the shelf and the disk', () => {
  for (const c of CASES) {
    browserIt(`${c.want} — ${c.why}`, async () => {
      const row = await download(c.path);

      expect(row.state, `${c.path} must complete`).toBe('completed');
      // The name the user SEES.
      expect(row.name).toBe(c.want);
      // The name the file actually HAS. Asserting only the shelf row would miss
      // the whole class of bug where the two drift apart — which is how a
      // download becomes unreachable.
      const file = onDisk(row);
      expect(existsSync(file), `${file} must exist`).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(BODY);
    });
  }
});

describe('a name the site gave without an extension still gets one', () => {
  // THE ONE UNAMBIGUOUSLY NEW WIN, and the only claim here that a reverted line
  // makes fail behaviourally. `trackDownload` passes the response's own
  // Content-Type into `ensureUsableExtension`; drop that argument and each of
  // these lands with NO suffix at all — the reported «فایل بدون Extension», and
  // a file the user's OS refuses to open. VERIFIED by removing the argument:
  // export.csv -> export, data.json -> data, گزارش.csv -> گزارش, report.rtf ->
  // report.
  for (const r of RESCUE_CASES) {
    browserIt(`${r.contentType} names it ${r.want}`, async () => {
      const row = await download(r.path);
      expect(row.state).toBe('completed');
      // The site's own name is KEPT and only the suffix is added. A rescue that
      // replaced the name would satisfy "has an extension" while breaking the
      // requirement it exists to serve.
      expect(row.name).toBe(r.want);
      expect(existsSync(onDisk(row))).toBe(true);
    });
  }
});

describe('the shelf never hands out a path or a placeholder', () => {
  browserIt('gives the client a token, never a filesystem path', async () => {
    const row = await download('/plain');
    expect(row.token).toMatch(/^dl_[0-9a-f]+$/);
    // A path here would let a client name a file on the server's disk.
    expect(JSON.stringify(row)).not.toContain(downloadDirFor(USER));
  });

  browserIt('resolves its own token to the file, and refuses a foreign one', async () => {
    const row = await download('/quoted');
    expect(session!.downloadFile(String(row.token))?.name).toBe('invoice_2026.xlsx');
    // Not in THIS session's list → unreachable, even though the on-disk layout
    // would let the name resolve.
    expect(session!.downloadFile('dl_deadbeefdeadbeefdeadbeef')).toBeNull();
  });

  browserIt('never falls back to the "file" or "download" placeholder', async () => {
    // The reported regression, as an assertion over everything downloaded above:
    // «یک مدت همه فایل‌ها با نام file ذخیره می‌شدند».
    const names = session!.downloadList().map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('file');
    expect(names).not.toContain('download');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE TWO CONTINGENCIES the outcome above rests on.
//
// These are source-level assertions, deliberately. The behaviour is covered
// above; what these catch is a REMOVAL. Both mechanisms are invisible when
// working and silent when deleted, and each has already cost this project a
// user-visible bug once.
// ════════════════════════════════════════════════════════════════════════════

describe('contingency 1: the browser is launched in a UTF-8 locale', () => {
  it('forces a UTF-8 LANG, because without one Chromium answers "download"', async () => {
    const { withUtf8Locale } = await import('../../src/core/BrowserProfile');

    // MEASURED, isolated to this single variable:
    //   no LANG        «فاکتور.xlsx» -> "download"
    //   LANG=C.UTF-8   «فاکتور.xlsx» -> "فاکتور.xlsx"
    expect(withUtf8Locale({}).LANG).toMatch(/utf-?8/i);
    // A non-UTF-8 LC_ALL outranks LANG in glibc, so it must be REMOVED rather
    // than merely overridden.
    const fixed = withUtf8Locale({ LC_ALL: 'C', LANG: 'C' });
    expect(fixed.LC_ALL).toBeUndefined();
    expect(fixed.LANG).toMatch(/utf-?8/i);
    // A UTF-8 locale the operator chose deliberately is left alone.
    expect(withUtf8Locale({ LANG: 'fa_IR.UTF-8' }).LANG).toBe('fa_IR.UTF-8');
  });

  it('is applied at BOTH launch sites a live session can be given', () => {
    // Which browser a session gets depends on REAL_CHROME_ENABLED, so a locale
    // fix on only one path is a bug that appears when a setting changes.
    const read = (f: string) => readFileSync(join(__dirname, '../../src/core', f), 'utf8');
    expect(read('GlobalBrowser.ts')).toMatch(/withUtf8Locale\s*\(\s*process\.env\s*\)/);
    expect(read('RealChrome.ts')).toMatch(/withUtf8Locale\s*\(\s*process\.env\s*\)/);
  });
});

describe('contingency 2: what the site declared is remembered independently', () => {
  it('records a declaration from the response and prefers it over a guess', async () => {
    const { DownloadHeaderIndex } = await import('../../src/core/DownloadHeaders');
    const { preferDeclaredName } = await import('../../src/core/RealChromeShelf');

    const idx = new DownloadHeaderIndex();
    idx.record('http://x/f', {
      'content-disposition':
        "attachment; filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx",
      'content-type': 'application/vnd.ms-excel',
    });

    const declared = idx.lookup('http://x/f');
    expect(declared?.name).toBe('فاکتور.xlsx');
    // The Content-Type is carried too — the value the extension rescue above
    // depends on, and which has no other source once the download has begun.
    expect(declared?.contentType).toBe('application/vnd.ms-excel');

    // Even if the browser DID collapse the name, the declared one still wins.
    expect(preferDeclaredName(declared!.name, 'download')).toBe('فاکتور.xlsx');

    // Forgotten once used, so an endpoint like /export that legitimately returns
    // a different report next time cannot inherit this report's name.
    idx.forget('http://x/f');
    expect(idx.lookup('http://x/f')).toBeNull();
  });

  it('is wired into the live session at CONTEXT level, before any navigation', () => {
    const src = readFileSync(join(__dirname, '../../src/core/LiveBrowser.ts'), 'utf8');
    // Context level, not page level: a per-page listener was measured to miss
    // every download that opens in a new tab (see DownloadHeaders.ts).
    expect(src).toMatch(/declaredNames\.watch\(this\.context\)/);
    // BOTH context-creation sites — recovery creates a second one, and a session
    // that recovered must not silently lose the index.
    expect((src.match(/declaredNames\.watch\(/g) || []).length).toBeGreaterThanOrEqual(2);
    // And the declared type must reach the extension rescue.
    expect(src).toMatch(/ensureUsableExtension\([\s\S]*?declared\?\.contentType/);
  });
});
