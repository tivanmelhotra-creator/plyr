/**
 * MEASUREMENT 2: pin down (a) when suggestedFilename() loses the real name,
 * and (b) whether the response headers are observable for EVERY way a real
 * site starts a download (anchor click, navigation, target=_blank, form POST).
 */
const http = require('http');
const { chromium } = require('playwright');

const FA = '%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx';           // فاکتور.xlsx
const CASES = [
  { id: 'star-only',      cd: `attachment; filename*=UTF-8''${FA}` },
  { id: 'ascii+star',     cd: `attachment; filename="_____.xlsx"; filename*=UTF-8''${FA}` },
  { id: 'star-ascii-name',cd: `attachment; filename*=UTF-8''report_final.pdf` },
  // A server that puts raw UTF-8 bytes in the header. Node cannot hold those in
  // a JS string it will send verbatim, so the bytes are expressed as latin1 --
  // which is exactly what goes on the wire.
  { id: 'raw-utf8-name',  cd: Buffer.from('attachment; filename="فاکتور.xlsx"', 'utf8').toString('latin1') },
  { id: 'ascii-only',     cd: 'attachment; filename="invoice_2026.xlsx"' },
];
const TRIGGERS = ['anchor', 'navigate', 'blank', 'form'];

(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>host page</body></html>');
    }
    const c = CASES.find((x) => x.id === u.searchParams.get('c'));
    if (!c) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': c.cd });
    res.end(Buffer.from('BYTES-WITH-NO-MAGIC-NUMBER'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-dl-profile2', {
    headless: true, acceptDownloads: true, downloadsPath: '/tmp/probe-dl2',
  });

  const cdByUrl = new Map();
  // Attached at CONTEXT level for responses; the question is whether it sees them.
  const attach = (page) => page.on('response', (r) => {
    const cd = r.headers()['content-disposition'];
    if (cd) cdByUrl.set(r.url(), cd);
  });
  ctx.on('page', attach);
  const page = await ctx.newPage(); attach(page);
  await page.goto(`${base}/page`);

  const rows = [];
  for (const c of CASES) {
    for (const trig of TRIGGERS) {
      const url = `${base}/dl?c=${c.id}&t=${trig}`;
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
        page.evaluate(([u, t]) => {
          if (t === 'anchor') { const a = document.createElement('a'); a.href = u; document.body.appendChild(a); a.click(); }
          else if (t === 'navigate') { window.location.href = u; }
          else if (t === 'blank') { const a = document.createElement('a'); a.href = u; a.target = '_blank'; document.body.appendChild(a); a.click(); }
          else { const f = document.createElement('form'); f.method = 'POST'; f.action = u; document.body.appendChild(f); f.submit(); }
        }, [url, trig]).catch(() => {}),
      ]);
      rows.push({
        case: c.id, trigger: trig,
        suggested: dl ? dl.suggestedFilename() : '(NO EVENT)',
        headerSeen: cdByUrl.get(url) || '(NOT OBSERVED)',
      });
      if (dl) await dl.saveAs(`/tmp/probe-dl2/k-${Math.random().toString(16).slice(2)}`).catch(() => {});
    }
  }
  console.log(JSON.stringify(rows, null, 1));
  const lost = rows.filter((r) => !/xlsx|pdf/.test(r.suggested));
  const unseen = rows.filter((r) => r.headerSeen === '(NOT OBSERVED)');
  console.log('SUGGESTED_LOST_THE_EXTENSION =', lost.length, '/', rows.length);
  console.log('HEADER_NOT_OBSERVED          =', unseen.length, '/', rows.length);
  await ctx.close(); server.close();
})();
