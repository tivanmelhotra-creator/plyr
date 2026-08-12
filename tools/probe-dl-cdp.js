/**
 * MEASUREMENT 3: does CHROME ITSELF know the real name?
 *
 * Playwright's suggestedFilename() lost 12/20 names (measured). But Chrome's own
 * download UI shows the right name, so Chrome must compute it. Browser.downloadWillBegin
 * carries a `suggestedFilename` field. If that is correct, it is a GENERIC source
 * that needs no header interception at all and covers new-tab downloads too.
 */
const http = require('http');
const { chromium } = require('playwright');

const FA = '%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx';
const CASES = [
  { id: 'star-only',       cd: `attachment; filename*=UTF-8''${FA}`,                            want: 'فاکتور.xlsx' },
  { id: 'ascii+star',      cd: `attachment; filename="_____.xlsx"; filename*=UTF-8''${FA}`,     want: 'فاکتور.xlsx' },
  { id: 'raw-utf8',        cd: Buffer.from('attachment; filename="فاکتور.xlsx"','utf8').toString('latin1'), want: 'فاکتور.xlsx' },
  { id: 'ascii-only',      cd: 'attachment; filename="invoice_2026.xlsx"',                      want: 'invoice_2026.xlsx' },
  { id: 'name-with-space', cd: 'attachment; filename="Annual Report 2026.docx"',                want: 'Annual Report 2026.docx' },
  { id: 'no-cd-typed',     cd: '', ct: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', want: '(from type/url)' },
];
const TRIGGERS = ['anchor', 'blank', 'form'];

(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>host</body></html>');
    }
    const c = CASES.find((x) => x.id === u.searchParams.get('c'));
    if (!c) { res.writeHead(404); return res.end('no'); }
    const h = { 'Content-Type': c.ct || 'application/octet-stream' };
    if (c.cd) h['Content-Disposition'] = c.cd;
    res.writeHead(200, h);
    res.end(Buffer.from('BYTES-NO-MAGIC'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-dl-profile3', {
    headless: true, acceptDownloads: true, downloadsPath: '/tmp/probe-dl3',
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/page`);

  // Browser-level CDP: one session, sees downloads from EVERY tab including new ones.
  const cdp = await ctx.newCDPSession(page);
  const cdpNames = [];
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName', downloadPath: '/tmp/probe-dl3', eventsEnabled: true,
  }).catch((e) => console.log('setDownloadBehavior FAILED:', e.message));
  cdp.on('Browser.downloadWillBegin', (e) => {
    cdpNames.push({ url: e.url, suggestedFilename: e.suggestedFilename, guid: e.guid });
  });

  const rows = [];
  for (const c of CASES) {
    for (const trig of TRIGGERS) {
      const url = `${base}/dl?c=${c.id}&t=${trig}`;
      cdpNames.length = 0;
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 6000 }).catch(() => null),
        page.evaluate(([u, t]) => {
          const a = document.createElement('a'); a.href = u;
          if (t === 'blank') a.target = '_blank';
          if (t === 'form') { const f = document.createElement('form'); f.method='POST'; f.action=u; document.body.appendChild(f); return f.submit(); }
          document.body.appendChild(a); a.click();
        }, [url, trig]).catch(() => {}),
      ]);
      await new Promise((r) => setTimeout(r, 350));
      const hit = cdpNames.find((n) => n.url === url) || cdpNames[0];
      rows.push({
        case: c.id, trigger: trig, want: c.want,
        playwright: dl ? dl.suggestedFilename() : '(NO EVENT)',
        cdp: hit ? hit.suggestedFilename : '(NO CDP EVENT)',
      });
      if (dl) await dl.saveAs(`/tmp/probe-dl3/k-${Math.random().toString(16).slice(2)}`).catch(() => {});
    }
  }
  console.table(rows);
  const cdpOk = rows.filter((r) => r.want !== '(from type/url)' && r.cdp === r.want).length;
  const pwOk  = rows.filter((r) => r.want !== '(from type/url)' && r.playwright === r.want).length;
  const total = rows.filter((r) => r.want !== '(from type/url)').length;
  console.log(`CDP_CORRECT_NAMES         = ${cdpOk}/${total}`);
  console.log(`PLAYWRIGHT_CORRECT_NAMES  = ${pwOk}/${total}`);
  await ctx.close(); server.close();
})();
