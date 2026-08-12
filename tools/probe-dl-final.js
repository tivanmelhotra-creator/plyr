/**
 * MEASUREMENT 5 (definitive). Two questions, one run:
 *
 *  Q1  How often is download.suggestedFilename() the name the SITE declared?
 *  Q2  Can a CONTEXT-level 'response' listener recover the real name in the
 *      cases where Q1 fails -- including downloads that open in a NEW TAB,
 *      which a per-page listener attached after the fact would miss?
 *
 * Fixes two bugs in earlier probes: case ids no longer contain '+' (which a
 * query string decodes to a space, so the server 404'd), and the download event
 * is taken from page.on('download') for EVERY page, because ctx.waitForEvent
 * ('download') was measured to never fire at all (30/30 misses).
 */
const http = require('http');
const { chromium } = require('playwright');

const FA = '%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx';                  // فاکتور.xlsx
const CASES = [
  { id: 'star_only',   cd: `attachment; filename*=UTF-8''${FA}`,                        want: 'فاکتور.xlsx' },
  { id: 'ascii_star',  cd: `attachment; filename="_____.xlsx"; filename*=UTF-8''${FA}`, want: 'فاکتور.xlsx' },
  { id: 'raw_utf8',    cd: Buffer.from('attachment; filename="فاکتور.xlsx"','utf8').toString('latin1'), want: 'فاکتور.xlsx' },
  { id: 'ascii_only',  cd: 'attachment; filename="invoice_2026.xlsx"',                  want: 'invoice_2026.xlsx' },
  { id: 'with_space',  cd: 'attachment; filename="Annual Report 2026.docx"',            want: 'Annual Report 2026.docx' },
  { id: 'parens',      cd: 'attachment; filename="report final (v2).pdf"',              want: 'report final (v2).pdf' },
  { id: 'star_ascii',  cd: "attachment; filename*=UTF-8''report_final.pdf",             want: 'report_final.pdf' },
  { id: 'sevenzip',    cd: 'attachment; filename="archive.7z"',                         want: 'archive.7z' },
];
const TRIGGERS = ['anchor', 'navigate', 'blank', 'form', 'window_open'];

/** The same RFC 6266 reader the server uses, inlined so the probe is standalone. */
function nameFromCD(header) {
  const s = String(header || '');
  const star = /filename\*\s*=\s*([^;]+)/i.exec(s);
  if (star) {
    const m = /^([\w-]*)'[^']*'(.*)$/.exec(star[1].trim());
    if (m) { try { const d = decodeURIComponent(m[2]); if (d.trim()) return d.trim(); } catch (e) {} }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(s) || /filename\s*=\s*([^;]+)/i.exec(s);
  return plain ? plain[1].trim() : '';
}

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
    res.end(Buffer.from('BYTES-NO-MAGIC-NUMBER-AT-ALL'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-dl-profile5', {
    headless: true, acceptDownloads: true, downloadsPath: '/tmp/probe-dl5',
  });

  // The candidate mechanism: ONE context-level response listener, attached
  // before anything navigates, recording the raw header per URL.
  const cdByUrl = new Map();
  ctx.on('response', (r) => {
    const cd = r.headers()['content-disposition'];
    if (cd) cdByUrl.set(r.url(), cd);
  });

  // page.on('download') for every page, present and future: the only event that fires.
  let pending = null;
  const attach = (p) => p.on('download', (dl) => { if (pending) pending(dl); });
  ctx.on('page', attach);
  const page = await ctx.newPage(); attach(page);
  await page.goto(`${base}/page`);

  const rows = [];
  for (const c of CASES) {
    for (const trig of TRIGGERS) {
      const url = `${base}/dl?c=${c.id}&t=${trig}`;
      const got = new Promise((resolve) => {
        pending = resolve; setTimeout(() => resolve(null), 5000);
      });
      await page.evaluate(([u, t]) => {
        if (t === 'navigate') { window.location.href = u; return; }
        if (t === 'window_open') { window.open(u, '_blank'); return; }
        if (t === 'form') { const f = document.createElement('form'); f.method='POST'; f.action=u; document.body.appendChild(f); f.submit(); return; }
        const a = document.createElement('a'); a.href = u;
        if (t === 'blank') a.target = '_blank';
        document.body.appendChild(a); a.click();
      }, [url, trig]).catch(() => {});
      const dl = await got;
      pending = null;
      await new Promise((r) => setTimeout(r, 150));
      const header = cdByUrl.get(url) || '';
      rows.push({
        case: c.id, trigger: trig, want: c.want,
        suggested: dl ? dl.suggestedFilename() : '(NO EVENT)',
        fromHeader: header ? nameFromCD(header) : '(NO HEADER)',
      });
      if (dl) await dl.saveAs(`/tmp/probe-dl5/k-${Math.random().toString(16).slice(2)}`).catch(() => {});
      if (trig === 'navigate') await page.goto(`${base}/page`).catch(() => {});
    }
  }

  const total = rows.length;
  const sugOk = rows.filter((r) => r.suggested === r.want).length;
  const hdrOk = rows.filter((r) => r.fromHeader === r.want).length;
  const combined = rows.filter((r) => (r.fromHeader === r.want) || (r.suggested === r.want)).length;
  const noEvent = rows.filter((r) => r.suggested === '(NO EVENT)').length;
  const noHeader = rows.filter((r) => r.fromHeader === '(NO HEADER)');
  console.table(rows.filter((r) => r.suggested !== r.want));
  console.log('TOTAL_CASES                       =', total);
  console.log('SUGGESTED_FILENAME_CORRECT        =', sugOk, `(${Math.round(sugOk/total*100)}%)`);
  console.log('CONTENT_DISPOSITION_CORRECT       =', hdrOk, `(${Math.round(hdrOk/total*100)}%)`);
  console.log('EITHER_SOURCE_CORRECT             =', combined, `(${Math.round(combined/total*100)}%)`);
  console.log('NO_DOWNLOAD_EVENT                 =', noEvent);
  console.log('HEADER_NOT_OBSERVED               =', noHeader.length, noHeader.map((r)=>r.case+'/'+r.trigger).join(','));
  await ctx.close(); server.close();
})();
