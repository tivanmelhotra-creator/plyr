/**
 * tools/probe-cdp2.js — the three remaining design questions, measured:
 *   1. downloads: does Browser.setDownloadBehavior + downloadProgress work on a
 *      page-level CDP session (we have no browser session for a persistent ctx)?
 *      And what does Playwright's context.on('download') give us in parallel?
 *   2. basic auth: does Fetch.authRequired fire without pausing every request?
 *   3. tab loss: what does Playwright report when a page is REPLACED the way a
 *      cookie extension replaces it (chrome.tabs.update / location swap)?
 *
 * Run: node tools/probe-cdp2.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const results = [];
const ok = (name, val, note) => { results.push({ name, pass: !!val, note: note || '' }); };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/big.bin') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="probe-payload.bin"',
          'content-length': String(40 * 1024 * 12),
        });
        let n = 0;
        const chunk = Buffer.alloc(40 * 1024, 0x41);
        const tick = () => {
          if (n >= 12) { res.end(); return; }
          n += 1;
          res.write(chunk);
          setTimeout(tick, 60);
        };
        tick();
        return;
      }
      if (url.pathname === '/protected') {
        const h = req.headers.authorization || '';
        if (!h.startsWith('Basic ')) {
          res.writeHead(401, {
            'www-authenticate': 'Basic realm="probe zone"',
            'content-type': 'text/plain',
          });
          res.end('need auth');
          return;
        }
        const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('authed as ' + dec);
        return;
      }
      if (url.pathname === '/other') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h1 id=other>OTHER PAGE</h1></body></html>');
        return;
      }
      if (url.pathname === '/dl') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><a id=go href="/big.bin">download</a></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1 id=home>HOME</h1><p>start</p></body></html>');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-dl-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-prof-'));

  // persistent context: exactly the shape RealChrome uses
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true,
    viewport: { width: 1000, height: 700 },
    acceptDownloads: true,
  });

  // ---------- 1. DOWNLOADS ----------
  const pwDownloads = [];
  ctx.on('download', (d) => {
    pwDownloads.push(d);
  });

  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  // Can we set download behavior from a PAGE-level session?
  let behaviorSet = false;
  let behaviorErr = '';
  try {
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dlDir,
      eventsEnabled: true,
    });
    behaviorSet = true;
  } catch (e) { behaviorErr = String(e.message || e).slice(0, 120); }
  ok('Browser.setDownloadBehavior on page-level CDP session', behaviorSet, behaviorErr);

  const willBegin = [];
  const progress = [];
  cdp.on('Browser.downloadWillBegin', (e) => willBegin.push(e));
  cdp.on('Browser.downloadProgress', (e) => progress.push(e));

  await page.goto(base + '/dl');
  const dlWait = ctx.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.click('#go');
  const pwDl = await dlWait;

  // let progress events accumulate
  await new Promise((r) => setTimeout(r, 2500));

  ok('Browser.downloadWillBegin fired', willBegin.length > 0,
     willBegin.length ? `guid=${willBegin[0].guid} name=${willBegin[0].suggestedFilename}` : 'none');
  ok('Browser.downloadProgress fired', progress.length > 0,
     `${progress.length} events, states=${[...new Set(progress.map((p) => p.state))].join('/')}`);
  const doneEv = progress.filter((p) => p.state === 'completed');
  ok('downloadProgress reports completed + byte counts', doneEv.length > 0,
     doneEv.length ? `received=${doneEv[0].receivedBytes} total=${doneEv[0].totalBytes}` : 'no completed state');
  const hasIntermediate = progress.some((p) => p.state === 'inProgress' && p.receivedBytes > 0 && p.receivedBytes < p.totalBytes);
  ok('downloadProgress gives INTERMEDIATE progress (for a shelf bar)', hasIntermediate,
     hasIntermediate ? 'yes — can render a % bar' : 'only start/end — bar would jump 0->100');

  ok('Playwright context.on(download) fired too', !!pwDl,
     pwDl ? `suggested=${pwDl.suggestedFilename()}` : 'none');
  let savedPath = '';
  let savedSize = -1;
  if (pwDl) {
    try {
      savedPath = path.join(dlDir, 'via-playwright-' + pwDl.suggestedFilename());
      await pwDl.saveAs(savedPath);
      savedSize = fs.statSync(savedPath).size;
    } catch (e) { savedPath = 'ERR ' + String(e.message || e).slice(0, 100); }
  }
  ok('download.saveAs() writes a real file on the server', savedSize > 0,
     `size=${savedSize} at ${savedPath}`);

  // does CDP also drop the file into downloadPath?
  let dirList = [];
  try { dirList = fs.readdirSync(dlDir); } catch (_) {}
  ok('CDP downloadPath also received the file', dirList.some((f) => f.includes('probe-payload')),
     'dir=' + JSON.stringify(dirList));

  // ---------- 2. BASIC AUTH ----------
  const page2 = await ctx.newPage();
  const cdp2 = await ctx.newCDPSession(page2);

  const authEvents = [];
  const pausedEvents = [];
  cdp2.on('Fetch.authRequired', async (e) => {
    authEvents.push(e);
    try {
      await cdp2.send('Fetch.continueWithAuth', {
        requestId: e.requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username: 'joe', password: 's3cret' },
      });
    } catch (_) {}
  });
  cdp2.on('Fetch.requestPaused', async (e) => {
    pausedEvents.push(e);
    try { await cdp2.send('Fetch.continueRequest', { requestId: e.requestId }); } catch (_) {}
  });

  // NARROW pattern that does NOT match our request: does authRequired still fire?
  await cdp2.send('Fetch.enable', {
    handleAuthRequests: true,
    patterns: [{ urlPattern: 'https://never.example.invalid/*' }],
  });

  let body = '';
  try {
    await page2.goto(base + '/protected', { waitUntil: 'domcontentloaded', timeout: 10000 });
    body = (await page2.textContent('body')) || '';
  } catch (e) { body = 'ERR ' + String(e.message || e).slice(0, 100); }

  ok('Fetch.authRequired fires with a NON-matching url pattern', authEvents.length > 0,
     authEvents.length
       ? `realm=${authEvents[0].authChallenge && authEvents[0].authChallenge.realm} origin=${authEvents[0].authChallenge && authEvents[0].authChallenge.origin}`
       : 'NO — patterns must match, so auth costs a request-pause');
  ok('continueWithAuth actually logged in', /authed as joe:s3cret/.test(body), 'body=' + body.slice(0, 60));
  ok('non-matching pattern means ZERO requestPaused overhead', pausedEvents.length === 0,
     `requestPaused count=${pausedEvents.length}`);
  await cdp2.send('Fetch.disable').catch(() => {});

  // ---------- 3. TAB REPLACEMENT / "we never lose a tab" ----------
  const page3 = await ctx.newPage();
  await page3.goto(base + '/');
  const sameObjBefore = page3;
  let closedFired = false;
  page3.on('close', () => { closedFired = true; });
  const frameNavs = [];
  page3.on('framenavigated', (f) => { if (f === page3.mainFrame()) frameNavs.push(f.url()); });

  // (a) location swap — what a cookie extension's chrome.tabs.update does
  await page3.evaluate((u) => { window.location.href = u; }, base + '/other');
  await page3.waitForLoadState('domcontentloaded').catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  let stillAlive = false;
  let titleAfter = '';
  try { titleAfter = await page3.title(); stillAlive = true; } catch (e) { titleAfter = 'ERR ' + e.message.slice(0, 60); }
  ok('location.href swap keeps the SAME Playwright Page object alive', stillAlive && !closedFired,
     `alive=${stillAlive} closeEvent=${closedFired} url=${page3.url()}`);
  ok('framenavigated fires on the swap (so we can re-sync url/title)', frameNavs.length > 0,
     JSON.stringify(frameNavs));
  ok('page object identity unchanged after swap', sameObjBefore === page3, '');

  // (b) reload the way chrome.tabs.reload does
  const navsBefore = frameNavs.length;
  await page3.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  let aliveAfterReload = false;
  try { await page3.title(); aliveAfterReload = true; } catch (_) {}
  ok('chrome.tabs.reload-style reload keeps the Page alive', aliveAfterReload,
     `framenavigated delta=${frameNavs.length - navsBefore}`);

  // (c) an ORPHAN page (what chrome.tabs.create from an extension produces)
  const orphan = await ctx.newPage();
  await orphan.goto(base + '/other');
  const openerVal = await orphan.opener();
  ok('orphan page (extension-created) has opener()===null', openerVal === null,
     `opener=${openerVal === null ? 'null' : 'a Page'} — so "adopt only if opener is owned" DROPS extension tabs`);

  // (d) can we still recover a page whose context lost the CDP session?
  const cdp3 = await ctx.newCDPSession(page3);
  await cdp3.detach().catch(() => {});
  let usableAfterDetach = false;
  try { await page3.title(); usableAfterDetach = true; } catch (_) {}
  ok('page usable after its CDP session is detached (need FRESH session)', usableAfterDetach, '');
  let rebindOk = false;
  try {
    const cdp4 = await ctx.newCDPSession(page3);
    await cdp4.send('Page.enable');
    rebindOk = true;
  } catch (e) { rebindOk = false; }
  ok('can re-bind a fresh CDP session to the same page', rebindOk, '');

  // ---------- report ----------
  await ctx.close().catch(() => {});
  srv.close();

  console.log('\n=== probe-cdp2: downloads / basic-auth / tab-replacement ===\n');
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '\n        ' + r.note : ''}`);
    if (r.pass) pass += 1;
  }
  console.log(`\nscore: ${pass}/${results.length}\n`);
  process.exit(0);
})().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
