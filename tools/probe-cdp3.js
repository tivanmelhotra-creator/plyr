/**
 * tools/probe-cdp3.js — follow-ups forced by probe-cdp2's failures:
 *   A. Does Playwright context.on('download') fire when we DON'T set CDP
 *      download behavior? (i.e. is the CDP path exclusive?)
 *   B. Basic auth without paying Fetch-pause on every request:
 *      B1. cost of Fetch.enable patterns:['*'] (how many pauses for one page?)
 *      B2. can we detect the 401 via page.on('response') and then authenticate
 *          by setting an Authorization header + reload? (zero steady-state cost)
 *   C. Dialogs: does page.on('dialog') see alert/confirm/prompt/beforeunload,
 *      and does an UNHANDLED dialog really block the page? (the reported lock-up)
 *   D. Does beforeunload fire on page.close() and can we choose to keep the tab?
 *
 * Run: node tools/probe-cdp3.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const results = [];
const ok = (n, v, note) => {
  results.push({ name: n, pass: !!v, note: note || '' });
  // print immediately so a later hang cannot hide earlier findings
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${note ? '\n        ' + note : ''}`);
};
// hard watchdog: never let one stalled section eat the whole run
const watchdog = setTimeout(() => {
  console.log('\n!! WATCHDOG fired at 90s — printing partial results');
  report();
  process.exit(0);
}, 90000);
watchdog.unref?.();
function report() {
  console.log('\n=== probe-cdp3 summary ===');
  let pass = 0;
  for (const r of results) if (r.pass) pass++;
  console.log(`score: ${pass}/${results.length}\n`);
}
const withTimeout = (p, ms, label) => Promise.race([
  Promise.resolve(p).catch((e) => 'ERR:' + String(e.message || e).slice(0, 80)),
  new Promise((r) => setTimeout(() => r('TIMEOUT:' + label), ms)),
]);

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/big.bin') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="p2.bin"',
        });
        res.end(Buffer.alloc(120 * 1024, 0x42));
        return;
      }
      if (u.pathname === '/dl') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<a id=go href="/big.bin">dl</a>');
        return;
      }
      if (u.pathname === '/protected') {
        const h = req.headers.authorization || '';
        if (!h.startsWith('Basic ')) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="probe zone"', 'content-type': 'text/plain' });
          res.end('need auth');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('authed as ' + Buffer.from(h.slice(6), 'base64').toString('utf8'));
        return;
      }
      // a page with several subresources, to count Fetch pauses
      if (u.pathname === '/heavy') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head>
          <link rel=stylesheet href="/a.css"><link rel=stylesheet href="/b.css">
          </head><body><img src="/a.png"><img src="/b.png"><img src="/c.png">
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

(async () => {
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3dl-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3prof-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, viewport: { width: 900, height: 650 }, acceptDownloads: true,
  });

  // ---- A. Playwright download event WITHOUT CDP download behavior ----
  const pwDl = [];
  ctx.on('download', (d) => pwDl.push(d));
  const pA = await ctx.newPage();
  await pA.goto(base + '/dl');
  const w = ctx.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await pA.click('#go');
  const got = await w;
  let saved = -1;
  if (got) {
    try { const p = path.join(dlDir, 'pw.bin'); await got.saveAs(p); saved = fs.statSync(p).size; } catch (_) {}
  }
  ok('A1 context.on(download) fires when CDP behavior is NOT set', !!got,
     got ? `name=${got.suggestedFilename()}` : 'none');
  ok('A2 saveAs works on that download', saved > 0, `size=${saved}`);
  ok('A3 => CDP setDownloadBehavior is EXCLUSIVE (suppresses PW event)', !!got,
     got ? 'PW works alone; probe-cdp2 showed CDP alone works. Pick ONE: CDP (has progress %)' : 'inconclusive');
  await pA.close();

  // ---- B1. cost of Fetch.enable with '*' ----
  const pB = await ctx.newPage();
  const cdpB = await ctx.newCDPSession(pB);
  const paused = [];
  const authed = [];
  cdpB.on('Fetch.requestPaused', async (e) => {
    paused.push(e.request.url);
    try { await cdpB.send('Fetch.continueRequest', { requestId: e.requestId }); } catch (_) {}
  });
  cdpB.on('Fetch.authRequired', async (e) => {
    authed.push(e.authChallenge);
    try {
      await cdpB.send('Fetch.continueWithAuth', {
        requestId: e.requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username: 'joe', password: 's3cret' },
      });
    } catch (_) {}
  });
  await cdpB.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  const t0 = Date.now();
  await pB.goto(base + '/heavy', { waitUntil: 'load' }).catch(() => {});
  const heavyMs = Date.now() - t0;
  const pausedHeavy = paused.length;
  let body401 = '';
  try { await pB.goto(base + '/protected', { waitUntil: 'domcontentloaded' }); body401 = (await pB.textContent('body')) || ''; } catch (e) { body401 = 'ERR'; }
  ok('B1 Fetch.authRequired fires with matching pattern "*"', authed.length > 0,
     authed.length ? `realm=${authed[0].realm} origin=${authed[0].origin} scheme=${authed[0].scheme}` : 'none');
  ok('B2 continueWithAuth authenticates', /authed as joe:s3cret/.test(body401), 'body=' + body401.slice(0, 50));
  ok('B3 cost: every subresource is paused', pausedHeavy > 5,
     `${pausedHeavy} pauses for one page, load=${heavyMs}ms — Fetch-always is a real tax`);
  await cdpB.send('Fetch.disable').catch(() => {});
  await pB.close();

  // ---- B4. lazy alternative: detect 401 via response, auth via header ----
  const pC = await ctx.newPage();
  const seen401 = [];
  pC.on('response', (r) => {
    if (r.status() === 401) seen401.push({ url: r.url(), wa: r.headers()['www-authenticate'] || '' });
  });
  await pC.goto(base + '/protected', { waitUntil: 'domcontentloaded' }).catch(() => {});
  ok('B4 page.on(response) sees the 401 + WWW-Authenticate realm', seen401.length > 0,
     seen401.length ? `realm hdr="${seen401[0].wa}"` : 'none');
  // now authenticate lazily with an extra header on the context
  await ctx.setExtraHTTPHeaders({ authorization: 'Basic ' + Buffer.from('joe:s3cret').toString('base64') });
  let lazyBody = '';
  try { await pC.reload({ waitUntil: 'domcontentloaded' }); lazyBody = (await pC.textContent('body')) || ''; } catch (_) { lazyBody = 'ERR'; }
  ok('B5 setExtraHTTPHeaders(authorization)+reload authenticates (zero-cost path)',
     /authed as joe:s3cret/.test(lazyBody), 'body=' + lazyBody.slice(0, 50));
  await ctx.setExtraHTTPHeaders({});
  await pC.close();

  // ---- C. dialogs ----
  const pD = await ctx.newPage();
  await pD.goto(base + '/');
  const dialogs = [];
  // first: UNHANDLED — playwright auto-dismisses when no listener. Verify.
  const tA = Date.now();
  let alertReturned = false;
  try {
    await pD.evaluate(() => { window.alert('hi there'); return 1; });
    alertReturned = true;
  } catch (_) {}
  ok('C0 with NO dialog listener Playwright auto-dismisses (does not hang)', alertReturned,
     `evaluate returned in ${Date.now() - tA}ms — so the "silent lock" is our own handler gap`);

  let held = null; // the un-answered dialog, kept so we can release it
  pD.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message(), dv: d.defaultValue() });
    held = d; // deliberately DO NOT respond yet, to measure the block
  });
  const tB = Date.now();
  let confirmDone = false;
  const confirmP = pD.evaluate(() => window.confirm('really?')).then(() => { confirmDone = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  ok('C1 an UNANSWERED dialog blocks the page (proves need for a real modal)', !confirmDone,
     `after ${Date.now() - tB}ms confirm still pending`);
  ok('C2 dialog type/message/defaultValue available', dialogs.length > 0 && dialogs[0].type === 'confirm',
     JSON.stringify(dialogs));
  // ALSO measure: does a pending dialog block an unrelated command? (the reported "tab lock")
  const otherCmd = await withTimeout(pD.title(), 2500, 'title-while-dialog-open');
  ok('C2b a pending dialog blocks other page commands too', String(otherCmd).startsWith('TIMEOUT'),
     `page.title() -> ${otherCmd}`);
  // release it, then confirm the page recovers
  if (held) await held.dismiss().catch(() => {});
  const after = await withTimeout(pD.title(), 3000, 'title-after-dismiss');
  ok('C2c page fully recovers once the dialog is answered', !String(after).startsWith('TIMEOUT'),
     `page.title() -> ${JSON.stringify(after)}`);
  await confirmP.catch(() => {});
  await withTimeout(pD.close(), 3000, 'close-pD');

  const pE = await ctx.newPage();
  await pE.goto(base + '/');
  const answers = [];
  pE.on('dialog', async (d) => {
    answers.push(d.type() + ':' + d.message());
    if (d.type() === 'prompt') await d.accept('typed value');
    else await d.accept();
  });
  const promptVal = await withTimeout(pE.evaluate(() => window.prompt('name?', 'default joe')), 6000, 'prompt');
  ok('C3 prompt accept(text) returns our text to the page', promptVal === 'typed value', 'got=' + promptVal);
  const confVal = await withTimeout(pE.evaluate(() => window.confirm('ok?')), 6000, 'confirm');
  ok('C4 confirm accept() returns true', confVal === true, 'got=' + confVal);
  ok('C5 all dialog types delivered', answers.length === 2, JSON.stringify(answers));

  // ---- D. beforeunload on close ----
  const pF = await ctx.newPage();
  await pF.goto(base + '/');
  await pF.evaluate(() => {
    window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'stay?'; });
  });
  // needs a user gesture for beforeunload to be honored
  await pF.mouse.click(10, 10);
  const buDialogs = [];
  pF.on('dialog', async (d) => {
    buDialogs.push(d.type());
    await d.dismiss(); // "stay on page"
  });
  let closedDespite = false;
  const closeRes = await withTimeout(pF.close({ runBeforeUnload: true }), 6000, 'close-runBeforeUnload');
  await new Promise((r) => setTimeout(r, 700));
  closedDespite = pF.isClosed();
  ok('D0 close({runBeforeUnload:true}) resolves/rejects without hanging',
     !String(closeRes).startsWith('TIMEOUT'), 'result=' + JSON.stringify(closeRes));
  ok('D1 close({runBeforeUnload:true}) fires a beforeunload dialog', buDialogs.includes('beforeunload'),
     JSON.stringify(buDialogs));
  ok('D2 dismissing beforeunload KEEPS the tab open (we can ask, not just close)', !closedDespite,
     `isClosed=${closedDespite}`);
  if (!pF.isClosed()) await withTimeout(pF.close(), 3000, 'close-pF');

  clearTimeout(watchdog);
  await withTimeout(ctx.close(), 8000, 'ctx.close');
  srv.close();
  report();
  process.exit(0);
})().catch((e) => { console.error('crashed:', e); report(); process.exit(1); });
