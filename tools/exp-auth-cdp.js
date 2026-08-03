#!/usr/bin/env node
/**
 * EXPERIMENT: does `Fetch.authRequired` fire at all for a 401 in THIS setup?
 *
 * The live probe says a 401 produces no prompt, but reports no failure from
 * `Fetch.enable` either, and the navigation itself succeeds. Three things could
 * explain that and they need separating before any code is changed:
 *
 *   1. the fixture never actually sends a 401 (probe's fault),
 *   2. `Fetch.authRequired` does not fire for this pattern (our CDP options),
 *   3. it fires but our handler/emit path drops it (LiveBrowser's fault).
 *
 * So: bypass LiveBrowser entirely. Launch a browser, enable Fetch exactly the
 * way installAuthHandler() does, navigate to the fixture's 401, and print every
 * Fetch event that arrives. Also fetch the URL with plain HTTP first, so claim 1
 * is settled independently of any browser.
 *
 * Run with --persistent to use the same launchPersistentContext mode RealChrome
 * uses, which is the mode the live server actually runs in.
 *
 *   DISPLAY=:99 node tools/exp-auth-cdp.js
 *   DISPLAY=:99 node tools/exp-auth-cdp.js --persistent
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const fixtures = require('./fixture-server');

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Claim 1: ask the fixture over plain HTTP, with no browser involved. */
function rawGet(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      res.resume();
      resolve({ status: res.statusCode, wwwAuth: res.headers['www-authenticate'] || '' });
    }).on('error', (e) => resolve({ status: 0, wwwAuth: 'ERR ' + e.message }));
  });
}

async function main() {
  const persistent = process.argv.includes('--persistent');
  const fx = await fixtures.start(3119);
  const url = fx.base + '/secret/exp-' + Date.now().toString(36);

  const raw = await rawGet(url);
  console.log('plain HTTP  → status=' + raw.status + '  www-authenticate=' + JSON.stringify(raw.wwwAuth));
  console.log('browser mode → ' + (persistent ? 'launchPersistentContext' : 'launch + newContext') + '\n');

  let context;
  let browser = null;
  if (persistent) {
    const dir = path.join(os.tmpdir(), 'exp-auth-profile-' + Date.now());
    context = await chromium.launchPersistentContext(dir, { headless: true });
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  }
  const page = context.pages()[0] || await context.newPage();

  // Exactly what installAuthHandler() does.
  const cdp = await context.newCDPSession(page);
  const seen = [];
  cdp.on('Fetch.requestPaused', (ev) => {
    seen.push('requestPaused ' + ev.request.url + ' status=' + (ev.responseStatusCode ?? '-'));
    void cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
  });
  cdp.on('Fetch.authRequired', (ev) => {
    seen.push('authRequired ' + JSON.stringify(ev.authChallenge));
    void cdp.send('Fetch.continueWithAuth', {
      requestId: ev.requestId,
      authChallengeResponse: {
        response: 'ProvideCredentials', username: 'probeuser', password: 'probepass',
      },
    }).catch((e) => seen.push('continueWithAuth FAILED ' + e.message));
  });
  await cdp.send('Fetch.enable', {
    handleAuthRequests: true,
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
  console.log('Fetch.enable OK (handleAuthRequests, Document-only, requestStage=Request)');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(
    (e) => console.log('goto threw: ' + e.message.split('\n')[0]),
  );
  await wait(1500);

  const body = await page.evaluate(() => document.body.innerText.slice(0, 60)).catch(() => '?');
  console.log('\nCDP events observed:');
  if (!seen.length) console.log('  (none)');
  for (const s of seen) console.log('  ' + s);
  console.log('\npage body → ' + JSON.stringify(body));

  const gotChallenge = seen.some((s) => s.startsWith('authRequired'));
  console.log('\nVERDICT: ' + (gotChallenge
    ? 'Fetch.authRequired DOES fire here — the fault is in LiveBrowser\'s path.'
    : 'Fetch.authRequired never fires with these options — the CDP options are wrong.'));

  if (browser) await browser.close(); else await context.close();
  await fx.close();
  process.exit(gotChallenge ? 0 : 3);
}

main().catch((e) => { console.error('experiment blew up:', e); process.exit(1); });
