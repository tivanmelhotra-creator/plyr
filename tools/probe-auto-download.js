/**
 * MEASUREMENT 9: can the viewer save files to the operator's machine WITHOUT a
 * click each time?
 *
 * The requirement is that a download inside the remote page lands on the
 * operator's own machine with no extra step. The viewer must therefore trigger
 * the save itself. Chrome has a "multiple automatic downloads" gate, so the
 * question is how many un-gestured downloads actually get through -- if it is
 * one, the feature would silently work for the first file only.
 */
const http = require('http');
const { chromium } = require('playwright');

(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>viewer</body></html>');
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="auto_${u.searchParams.get('n')}.bin"`,
    });
    res.end(Buffer.alloc(64, 1));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-auto-profile', {
    headless: true, acceptDownloads: true, downloadsPath: '/tmp/probe-auto',
  });
  const page = await ctx.newPage();
  const got = [];
  page.on('download', (d) => { got.push(d.suggestedFilename()); d.saveAs(`/tmp/probe-auto/${Math.random()}`).catch(()=>{}); });
  await page.goto(base);

  // Blob route (what the viewer uses for small files): fetch then anchor-click.
  for (let n = 1; n <= 5; n++) {
    await page.evaluate(async ([b, i]) => {
      const r = await fetch(`${b}/f?n=${i}`);
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = /filename="([^"]+)"/.exec(cd);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : 'fallback.bin';
      document.body.appendChild(a); a.click(); a.remove();
    }, [base, n]).catch((e) => console.log('eval error', e.message));
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1200);
  console.log('BLOB_ANCHOR_DOWNLOADS_DELIVERED =', got.length, '/ 5');
  console.log('NAMES                           =', JSON.stringify(got));
  await ctx.close(); server.close();
})();
