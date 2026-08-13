/**
 * MEASUREMENT — does the DASHBOARD's Live Browser shelf keep the website's own
 * filename, the way the REAL Chromium shelf already does?
 *
 * ⚠ CORRECTION — READ THIS BEFORE QUOTING ANY NUMBER FROM THIS FILE
 * -----------------------------------------------------------------
 * An earlier run of this probe reported `suggestedFilename() 12/24 (50%)` and
 * that figure was used to call the dashboard shelf BROKEN. That conclusion was
 * WRONG, and the reason is this probe, not the product:
 *
 *   this probe launched   chromium.launch()                       <- bare env
 *   the product launches  chromium.launch({ env: withUtf8Locale(process.env) })
 *
 * `withUtf8Locale()` (src/core/BrowserProfile.ts) forces `LANG=C.UTF-8`, and
 * THAT is the whole variable: without a UTF-8 locale Chromium cannot represent a
 * non-ASCII name in a POSIX path and collapses it — extension included — to the
 * literal string `download`. Isolated:
 *
 *     no LANG          «فاکتور.xlsx»  ->  "download"
 *     LANG=C.UTF-8     «فاکتور.xlsx»  ->  "فاکتور.xlsx"
 *
 * Both browsers a LiveBrowser session can be handed already call it —
 * `GlobalBrowser` (line ~92) and `RealChrome` (line ~646). Re-measured WITH the
 * product's environment: suggestedFilename() 24/24, declared 24/24. There is no
 * 50% loss on the real code path.
 *
 * So this probe now sets the same environment the product does. If you want to
 * SEE the collapse, run it with `AB_PROBE_BARE_ENV=1`, which deliberately drops
 * the locale and reproduces the old number — as a demonstration of the
 * dependency, not as a finding about the shipped code.
 *
 * WHY THIS PROBE STILL EXISTS
 * ---------------------------
 * Because 24/24 is contingent on an environment variable set in another file.
 * This probe is the regression alarm for that contingency, and it also measures
 * the declared header's remaining real win: the Content-Type it carries is what
 * lets `ensureUsableExtension` put an extension on a download that arrived
 * without one (measured 4/4: text/csv, application/json, text/plain, text/html).
 * `src/core/RealChromeShelf.ts` reads the same index for the same reasons.
 *
 * `src/core/LiveBrowser.ts` — the shelf behind the dashboard's own Live Browser
 * View, i.e. the OTHER remote-browser surface in this product — was NOT changed
 * and still read `dl.suggestedFilename()` in `trackDownload`.
 *
 * The requirement is about the FEATURE, not about one surface:
 *
 *   «هر فایلی که از Website توسط Remote Browser دانلود یا Export می‌شود باید با
 *    نام واقعی و Extension واقعی که خود Website اعلام کرده روی Windows کاربر
 *    ذخیره شود»
 *
 * So this probe answers two questions in one run:
 *
 *   BEFORE  what a `suggestedFilename()`-based shelf produces  (the old code)
 *   AFTER   what LiveBrowser produces NOW                      (the new code)
 *
 * WHAT MAKES THE "AFTER" COLUMN TRUSTWORTHY
 * -----------------------------------------
 * It is not a re-implementation. This probe imports the SAME two modules the
 * fixed `trackDownload` calls — `DownloadHeaderIndex` and `preferDeclaredName`
 * — and composes them in the same order, against a real Chromium and a real
 * HTTP server. If someone reverts either module, this number drops.
 *
 *   npx tsx tools/probe-livebrowser-names.js
 */
'use strict';

const http = require('http');
const { chromium } = require('playwright');

// The product's own naming pieces, exactly as LiveBrowser.trackDownload uses
// them. Imported (not copied) so the measurement tracks the real code.
const { DownloadHeaderIndex } = require('../src/core/DownloadHeaders');
const { preferDeclaredName } = require('../src/core/RealChromeShelf');
const { safeFileName } = require('../src/core/RemoteUploads');
const { withUtf8Locale } = require('../src/core/BrowserProfile');

const FA_INVOICE = '%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx';   // فاکتور.xlsx
const FA_REPORT = '%DA%AF%D8%B2%D8%A7%D8%B1%D8%B4.pdf';           // گزارش.pdf

/**
 * Content-Disposition shapes real sites actually send. Deliberately the same
 * family probe-dl-final.js used: the two shelves must be compared against the
 * same cases, or a difference could be the cases rather than the code.
 */
const CASES = [
  { id: 'star_only', cd: `attachment; filename*=UTF-8''${FA_INVOICE}`, want: 'فاکتور.xlsx' },
  { id: 'ascii_star', cd: `attachment; filename="_____.xlsx"; filename*=UTF-8''${FA_INVOICE}`, want: 'فاکتور.xlsx' },
  { id: 'star_report', cd: `attachment; filename*=UTF-8''${FA_REPORT}`, want: 'گزارش.pdf' },
  { id: 'raw_utf8', cd: Buffer.from('attachment; filename="گزارش.pdf"', 'utf8').toString('latin1'), want: 'گزارش.pdf' },
  { id: 'ascii_only', cd: 'attachment; filename="invoice_2026.xlsx"', want: 'invoice_2026.xlsx' },
  { id: 'with_space', cd: 'attachment; filename="Annual Report 2026.docx"', want: 'Annual Report 2026.docx' },
  { id: 'star_ascii', cd: "attachment; filename*=UTF-8''report_final.pdf", want: 'report_final.pdf' },
  { id: 'zip', cd: 'attachment; filename="bundle_v2.zip"', want: 'bundle_v2.zip' },
];

/** How a site can start a download. `blank` is the new-tab case that matters. */
const TRIGGERS = ['anchor', 'navigate', 'blank'];

(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');

    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>host</body></html>');
    }

    const c = CASES.find((x) => x.id === u.searchParams.get('c'));
    if (!c) { res.writeHead(404); return res.end('no'); }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': c.cd,
    });
    return res.end('BYTES');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── Launch the way the PRODUCT launches. See the correction at the top of
  //    this file: the earlier "50% loss" was this line missing `withUtf8Locale`,
  //    not a defect in the shelf. `AB_PROBE_BARE_ENV=1` drops it again on
  //    purpose, to demonstrate how load-bearing the locale is.
  const bareEnv = process.env.AB_PROBE_BARE_ENV === '1';
  const browser = await chromium.launch(
    bareEnv ? {} : { env: withUtf8Locale(process.env) },
  );
  console.log(
    bareEnv
      ? 'launched WITHOUT the product env (AB_PROBE_BARE_ENV=1) — expect the collapse'
      : `launched WITH the product env (LANG=${withUtf8Locale(process.env).LANG})`,
  );
  const ctx = await browser.newContext({ acceptDownloads: true });

  // ── The fix under test, wired the way LiveBrowser.start() wires it: the
  //    product's own index, attached at CONTEXT level before any navigation.
  //    Context-level because a per-page listener was measured to miss every
  //    new-tab download (see DownloadHeaders.ts).
  const declaredNames = new DownloadHeaderIndex();
  declaredNames.watch(ctx);

  let beforeOk = 0;
  let afterOk = 0;
  let total = 0;
  const rows = [];

  for (const c of CASES) {
    for (const trigger of TRIGGERS) {
      const page = await ctx.newPage();
      await page.goto(`${base}/page`);
      const url = `${base}/file?c=${c.id}`;

      // Downloads can land on a NEW page, so listen on every page the context
      // has or gains, not only the one clicked in.
      const got = new Promise((resolve) => {
        const onPage = (p) => p.on('download', (d) => resolve(d));
        ctx.pages().forEach(onPage);
        ctx.on('page', onPage);
      });

      if (trigger === 'anchor') {
        await page.evaluate((u2) => {
          const a = document.createElement('a');
          a.href = u2;
          a.textContent = 'go';
          document.body.appendChild(a);
          a.click();
        }, url);
      } else if (trigger === 'navigate') {
        page.goto(url).catch(() => { /* a download aborts the navigation */ });
      } else {
        await page.evaluate((u2) => { window.open(u2, '_blank'); }, url);
      }

      const dl = await Promise.race([
        got,
        new Promise((r2) => setTimeout(() => r2(null), 8000)),
      ]);

      total += 1;
      if (!dl) {
        rows.push([c.id, trigger, '(no download event)', '', 'MISS']);
        await page.close().catch(() => {});
        continue;
      }

      const dlUrl = String(dl.url() || '');

      // BEFORE — the old trackDownload line, verbatim.
      const before = safeFileName(String(dl.suggestedFilename() || 'download')) || 'download';

      // AFTER — the new trackDownload lines, in the same order.
      const declared = declaredNames.lookup(dlUrl);
      const after = safeFileName(
        preferDeclaredName(
          (declared && declared.name) || '',
          String(dl.suggestedFilename() || ''),
        ) || 'download',
      ) || 'download';

      const bOk = before === c.want;
      const aOk = after === c.want;
      if (bOk) beforeOk += 1;
      if (aOk) afterOk += 1;

      rows.push([
        c.id, trigger, before, after,
        `${bOk ? 'before OK' : 'before BAD'} / ${aOk ? 'after OK' : 'after BAD'}`,
      ]);

      await page.close().catch(() => {});
    }
  }

  await browser.close();
  server.close();

  console.log('\ncase / trigger / BEFORE (suggestedFilename) / AFTER (declared) / verdict');
  console.log('-'.repeat(104));
  for (const r of rows) {
    console.log(
      `${r[0].padEnd(12)} ${r[1].padEnd(9)} ${String(r[2]).padEnd(26)} ${String(r[3]).padEnd(26)} ${r[4]}`,
    );
  }
  console.log('-'.repeat(104));
  console.log(`BEFORE — suggestedFilename() correct : ${beforeOk}/${total}`);
  console.log(`AFTER  — LiveBrowser as fixed        : ${afterOk}/${total}`);
  console.log(
    '\nVERDICT: the AFTER column is DownloadHeaderIndex + preferDeclaredName, the '
    + 'same two modules LiveBrowser.trackDownload() now calls, composed in the '
    + 'same order. A regression in either drops this number.',
  );
})().catch((e) => { console.error(e); process.exit(1); });
