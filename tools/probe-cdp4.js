/**
 * tools/probe-cdp4.js — settle the two failures from probe-cdp3:
 *   E. downloads: why did context.on('download') never fire in a PERSISTENT
 *      context? Compare: persistent vs normal context, context.on vs page.on,
 *      and whether an in-page <a download> click behaves differently.
 *   F. basic auth with NO interception: what event does Playwright actually
 *      give us (response? requestfailed? dialog?) and can we pause only
 *      DOCUMENT requests instead of all 8 subresources?
 *
 * Run: node tools/probe-cdp4.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const results = [];
const ok = (n, v, note) => {
  results.push({ name: n, pass: !!v, note: note || '' });
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${note ? '\n        ' + note : ''}`);
};
const withTimeout = (p, ms, label) => Promise.race([
  Promise.resolve(p).catch((e) => 'ERR:' + String(e.message || e).slice(0, 90)),
  new Promise((r) => setTimeout(() => r('TIMEOUT:' + label), ms)),
]);

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/big.bin') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="p4.bin"',
        });
        res.end(Buffer.alloc(90 * 1024, 0x43));
        return;
      }
      if (u.pathname === '/dl') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<a id=go href="/big.bin">dl</a> <a id=go2 href="/plain.txt" download="named.txt">dl2</a>');
        return;
      }
      if (u.pathname === '/plain.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello download');
        return;
      }
      if (u.pathname === '/protected') {
        const h = req.headers.authorization || '';
        if (!h.startsWith('Basic ')) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="probe zone"', 'content-type': 'text/plain' });
          res.end('need auth body');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('authed as ' + Buffer.from(h.slice(6), 'base64').toString('utf8'));
        return;
      }
      if (u.pathname === '/heavy') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><link rel=stylesheet href="/a.css"><link rel=stylesheet href="/b.css"></head>
          <body><img src="/a.png"><img src="/b.png"><img src="/c.png">
          <script src="/a.js"></script><script src="/b.js"></script></body></html>`);
        return;
      }
      if (u.pathname.endsWith('.css')) { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body{color:#111}'); return; }
      if (u.pathname.endsWith('.js')) { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('void 0;'); return; }
      if (u.pathname.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(64)); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1 id=home>HOME</h1>');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function downloadCase(label, ctx, base, useCdpBehavior, dlDir) {
  const ctxEvents = [];
  const pageEvents = [];
  ctx.on('download', (d) => ctxEvents.push(d));
  const page = await ctx.newPage();
  page.on('download', (d) => pageEvents.push(d));
  if (useCdpBehavior) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: dlDir, eventsEnabled: true,
    }).catch(() => {});
  }
  await page.goto(base + '/dl');
  await page.click('#go').catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  let savedSize = -1;
  const d = ctxEvents[0] || pageEvents[0];
  if (d) {
    const p = path.join(dlDir, label.replace(/\W+/g, '_') + '.bin');
    const r = await withTimeout(d.saveAs(p), 6000, 'saveAs');
    if (!String(r).startsWith('TIMEOUT') && !String(r).startsWith('ERR')) {
      try { savedSize = fs.statSync(p).size; } catch (_) {}
    } else { savedSize = -2; }
  }
  ok(`E ${label}: context.on(download)=${ctxEvents.length} page.on(download)=${pageEvents.length}`,
     ctxEvents.length > 0 || pageEvents.length > 0,
     `saveAs size=${savedSize}`);
  await page.close().catch(() => {});
  return { ctxEvents: ctxEvents.length, pageEvents: pageEvents.length, savedSize };
}

(async () => {
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4dl-'));

  // ---- E1 persistent context, NO cdp behavior ----
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p4a-'));
  const ctxA = await chromium.launchPersistentContext(dirA, { headless: true, acceptDownloads: true });
  const rA = await downloadCase('persistent + acceptDownloads, no CDP', ctxA, base, false, dlDir);
  await ctxA.close().catch(() => {});

  // ---- E2 persistent context, WITH cdp behavior ----
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-'));
  const ctxB = await chromium.launchPersistentContext(dirB, { headless: true, acceptDownloads: true });
  const rB = await downloadCase('persistent + CDP setDownloadBehavior', ctxB, base, true, dlDir);
  await ctxB.close().catch(() => {});

  // ---- E3 normal (non-persistent) context for contrast ----
  const browser = await chromium.launch({ headless: true });
  const ctxC = await browser.newContext({ acceptDownloads: true });
  const rC = await downloadCase('normal context, no CDP', ctxC, base, false, dlDir);
  await ctxC.close().catch(() => {});
  await browser.close().catch(() => {});

  ok('E4 VERDICT: Playwright download events usable in persistent ctx?',
     rA.ctxEvents + rA.pageEvents > 0,
     `persistent-noCDP=${rA.ctxEvents}/${rA.pageEvents} persistent-CDP=${rB.ctxEvents}/${rB.pageEvents} normal=${rC.ctxEvents}/${rC.pageEvents}` +
     (rA.ctxEvents + rA.pageEvents === 0 ? ' => MUST use CDP Browser.download* events' : ''));

  // ---- F. basic auth with no interception ----
  const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'p4d-'));
  const ctxD = await chromium.launchPersistentContext(dirD, { headless: true });
  const pD = await ctxD.newPage();
  const ev = { response: [], requestfailed: [], dialog: [] };
  pD.on('response', (r) => ev.response.push(r.status() + ' ' + r.url().split('/').pop()));
  pD.on('requestfailed', (r) => ev.requestfailed.push((r.failure() || {}).errorText + ' ' + r.url().split('/').pop()));
  pD.on('dialog', async (d) => { ev.dialog.push(d.type()); await d.dismiss().catch(() => {}); });
  const gotoRes = await withTimeout(pD.goto(base + '/protected', { waitUntil: 'domcontentloaded' }), 10000, 'goto-protected');
  const bodyD = await withTimeout(pD.textContent('body'), 4000, 'body');
  ok('F1 what happens with NO interception on a 401',
     true,
     `goto=${String(gotoRes).slice(0, 40)} response=${JSON.stringify(ev.response)} failed=${JSON.stringify(ev.requestfailed)} dialog=${JSON.stringify(ev.dialog)} body=${JSON.stringify(String(bodyD).slice(0, 40))}`);
  ok('F2 a 401 IS observable without Fetch (response or requestfailed)',
     ev.response.some((s) => s.startsWith('401')) || ev.requestfailed.length > 0,
     ev.response.some((s) => s.startsWith('401')) ? 'via page.on(response) 401' : (ev.requestfailed.length ? 'via requestfailed only' : 'INVISIBLE'));
  await pD.close().catch(() => {});

  // ---- F3 cheap Fetch: Document-only pattern ----
  const pE = await ctxD.newPage();
  const cdpE = await ctxD.newCDPSession(pE);
  const paused = [];
  const authed = [];
  cdpE.on('Fetch.requestPaused', async (e) => {
    paused.push(e.request.url.split('/').pop());
    await cdpE.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
  });
  cdpE.on('Fetch.authRequired', async (e) => {
    authed.push(e.authChallenge.realm);
    await cdpE.send('Fetch.continueWithAuth', {
      requestId: e.requestId,
      authChallengeResponse: { response: 'ProvideCredentials', username: 'joe', password: 's3cret' },
    }).catch(() => {});
  });
  await cdpE.send('Fetch.enable', {
    handleAuthRequests: true,
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
  const t0 = Date.now();
  await withTimeout(pE.goto(base + '/heavy', { waitUntil: 'load' }), 10000, 'heavy');
  const heavyMs = Date.now() - t0;
  const pausedHeavy = paused.length;
  const bodyE = await withTimeout(
    pE.goto(base + '/protected', { waitUntil: 'domcontentloaded' }).then(() => pE.textContent('body')),
    10000, 'protected');
  ok('F3 Document-only Fetch pattern pauses ONLY the document', pausedHeavy <= 2,
     `pauses=${pausedHeavy} (${JSON.stringify(paused)}) heavy load=${heavyMs}ms`);
  ok('F4 auth still works with a Document-only pattern', /authed as joe:s3cret/.test(String(bodyE)),
     'body=' + String(bodyE).slice(0, 50));
  ok('F5 authRequired delivered under Document-only pattern', authed.length > 0, JSON.stringify(authed));
  await cdpE.send('Fetch.disable').catch(() => {});

  // ---- F6 can Fetch be enabled LAZILY (after we see a 401) and then retried? ----
  const pF = await ctxD.newPage();
  const cdpF = await ctxD.newCDPSession(pF);
  let saw401 = false;
  pF.on('response', (r) => { if (r.status() === 401) saw401 = true; });
  await withTimeout(pF.goto(base + '/protected', { waitUntil: 'domcontentloaded' }), 8000, 'lazy-1');
  const authed2 = [];
  cdpF.on('Fetch.authRequired', async (e) => {
    authed2.push(e.authChallenge.realm);
    await cdpF.send('Fetch.continueWithAuth', {
      requestId: e.requestId,
      authChallengeResponse: { response: 'ProvideCredentials', username: 'joe', password: 's3cret' },
    }).catch(() => {});
  });
  cdpF.on('Fetch.requestPaused', async (e) => {
    await cdpF.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
  });
  await cdpF.send('Fetch.enable', {
    handleAuthRequests: true,
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
  const bodyF = await withTimeout(pF.reload({ waitUntil: 'domcontentloaded' }).then(() => pF.textContent('body')), 10000, 'lazy-2');
  ok('F6 LAZY strategy works: see 401 -> enable Fetch -> reload -> authenticated',
     saw401 && /authed as joe:s3cret/.test(String(bodyF)),
     `saw401=${saw401} authRequired=${authed2.length} body=${String(bodyF).slice(0, 45)}`);
  await cdpF.send('Fetch.disable').catch(() => {});

  await ctxD.close().catch(() => {});
  srv.close();
  let pass = 0;
  for (const r of results) if (r.pass) pass++;
  console.log(`\n=== probe-cdp4 summary: ${pass}/${results.length} ===\n`);
  process.exit(0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
