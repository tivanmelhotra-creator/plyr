/**
 * MEASUREMENT 4: can a CONTEXT-level response listener see the real
 * Content-Disposition for every kind of download, including one that opens in a
 * new tab (where a per-page listener attached too late and missed 8/20)?
 *
 * No CDP here: measurement 3 showed Browser.setDownloadBehavior makes Playwright
 * lose the download event altogether.
 */
const http = require('http');
const { chromium } = require('playwright');

const FA = '%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx';
const CASES = [
  { id: 'star-only',       cd: `attachment; filename*=UTF-8''${FA}`,                        want: 'فاکتور.xlsx' },
  { id: 'ascii+star',      cd: `attachment; filename="_____.xlsx"; filename*=UTF-8''${FA}`, want: 'فاکتور.xlsx' },
  { id: 'raw-utf8',        cd: Buffer.from('attachment; filename="فاکتور.xlsx"','utf8').toString('latin1'), want: 'فاکتور.xlsx' },
  { id: 'ascii-only',      cd: 'attachment; filename="invoice_2026.xlsx"',                  want: 'invoice_2026.xlsx' },
  { id: 'name-with-space', cd: 'attachment; filename="Annual Report 2026.docx"',            want: 'Annual Report 2026.docx' },
  { id: 'rfc-plus',        cd: `attachment; filename="report final (v2).pdf"`,              want: 'report final (v2).pdf' },
];
const TRIGGERS = ['anchor', 'navigate', 'blank', 'form', 'window-open'];

(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>host</body></html>');
    }
    const c = CASES.find((x) => x.id === u.searchParams.get('c'));
    if (!c) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': c.cd });
    res.end(Buffer.from('BYTES-NO-MAGIC'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-dl-profile4', {
    headless: true, acceptDownloads: true, downloadsPath: '/tmp/probe-dl4',
  });

  // ONE listener, attached to the context before anything navigates.
  const cdByUrl = new Map();
  ctx.on('response', (r) => {
    const cd = r.headers()['content-disposition'];
    if (cd) cdByUrl.set(r.url(), cd);
  });

  const page = await ctx.newPage();
  await page.goto(`${base}/page`);

  const rows = [];
  for (const c of CASES) {
    for (const trig of TRIGGERS) {
      const url = `${base}/dl?c=${c.id}&t=${trig}`;
      const [dl] = await Promise.all([
        ctx.waitForEvent('download', { timeout: 6000 }).catch(() => null),
        page.evaluate(([u, t]) => {
          if (t === 'navigate') { window.location.href = u; return; }
          if (t === 'window-open') { window.open(u, '_blank'); return; }
          if (t === 'form') { const f = document.createElement('form'); f.method='POST'; f.action=u; document.body.appendChild(f); f.submit(); return; }
          const a = document.createElement('a'); a.href = u;
          if (t === 'blank') a.target = '_blank';
          document.body.appendChild(a); a.click();
        }, [url, trig]).catch(() => {}),
      ]);
      // Give the response event a moment; it can arrive just after the download.
      await new Promise((r) => setTimeout(r, 200));
      rows.push({
        case: c.id, trigger: trig,
        playwright: dl ? dl.suggestedFilename() : '(NO EVENT)',
        headerSeen: cdByUrl.get(url) || '(NOT OBSERVED)',
        want: c.want,
      });
      if (dl) await dl.saveAs(`/tmp/probe-dl4/k-${Math.random().toString(16).slice(2)}`).catch(() => {});
    }
  }
  const unseen = rows.filter((r) => r.headerSeen === '(NOT OBSERVED)');
  const noEvent = rows.filter((r) => r.playwright === '(NO EVENT)');
  const pwWrong = rows.filter((r) => r.playwright !== r.want);
  console.log(JSON.stringify(rows.filter((r) => r.headerSeen === '(NOT OBSERVED)' || r.playwright === '(NO EVENT)'), null, 1));
  console.log('TOTAL                        =', rows.length);
  console.log('HEADER_NOT_OBSERVED          =', unseen.length, unseen.map((r)=>r.case+'/'+r.trigger).join(','));
  console.log('NO_DOWNLOAD_EVENT            =', noEvent.length, noEvent.map((r)=>r.case+'/'+r.trigger).join(','));
  console.log('PLAYWRIGHT_NAME_WRONG        =', pwWrong.length);
  await ctx.close(); server.close();
})();
