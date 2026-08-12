/**
 * MEASUREMENT: where does the real filename come from, and can we see it?
 * Serves a matrix of download responses and records, for each:
 *   - download.suggestedFilename()
 *   - whether page.on('response') can see the response (i.e. its headers)
 *   - the raw Content-Disposition we'd want to honour
 */
const http = require('http');
const { chromium } = require('playwright');

const CASES = [
  { path: '/a', cd: 'attachment; filename="report_final.pdf"', ct: 'application/pdf', want: 'report_final.pdf' },
  { path: '/b', cd: "attachment; filename=\"_____.xlsx\"; filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx", ct: 'application/octet-stream', want: 'فاکتور.xlsx' },
  { path: '/invoice_2026.xlsx', cd: '', ct: 'application/octet-stream', want: 'invoice_2026.xlsx' },
  // No name anywhere; only the CONTENT-TYPE says what it is. Chrome must guess.
  { path: '/export', cd: 'attachment', ct: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', want: '?.xlsx' },
  { path: '/gen', cd: 'attachment', ct: 'application/x-7z-compressed', want: '?.7z' },
  { path: '/rtf', cd: 'attachment', ct: 'application/rtf', want: '?.rtf' },
];

(async () => {
  const server = http.createServer((req, res) => {
    const c = CASES.find((x) => x.path === req.url.split('?')[0]);
    if (!c) { res.writeHead(404); return res.end('no'); }
    const h = { 'Content-Type': c.ct };
    if (c.cd) h['Content-Disposition'] = c.cd;
    res.writeHead(200, h);
    res.end(Buffer.from('PAYLOAD-BYTES-NOT-A-KNOWN-MAGIC-NUMBER'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-dl-profile', {
    headless: true, acceptDownloads: true, downloadsPath: '/tmp/probe-dl',
  });
  const page = await ctx.newPage();

  const seenResponses = [];
  page.on('response', (r) => {
    seenResponses.push({ url: r.url(), cd: r.headers()['content-disposition'] || '', ct: r.headers()['content-type'] || '' });
  });

  const out = [];
  for (const c of CASES) {
    const url = `http://127.0.0.1:${port}${c.path}`;
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
      page.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.click(); }, url).catch(() => {}),
    ]);
    const resp = seenResponses.find((r) => r.url === url);
    out.push({
      path: c.path,
      sentCD: c.cd || '(none)',
      sentCT: c.ct,
      suggested: dl ? dl.suggestedFilename() : '(NO DOWNLOAD EVENT)',
      wanted: c.want,
      responseVisibleToPage: !!resp,
      cdSeenByPage: resp ? resp.cd : '(response not observed)',
    });
    if (dl) await dl.saveAs(`/tmp/probe-dl/keep-${Math.random().toString(16).slice(2)}`).catch(() => {});
  }
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
  server.close();
})();
