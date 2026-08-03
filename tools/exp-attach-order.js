#!/usr/bin/env node
/**
 * EXPERIMENT: does attachPage() actually REACH installAuthHandler()?
 *
 * Measured so far: the fixture really sends a 401, and `Fetch.authRequired`
 * really fires for LiveBrowser's exact CDP options in both plain and persistent
 * modes (tools/exp-auth-cdp.js). So the challenge is being lost inside
 * LiveBrowser. `installAuthHandler` has exactly one caller — the LAST await in
 * `attachPage` — and several of the awaits before it are not individually
 * guarded. If any of them rejects, `attachPage` rejects, and auth interception
 * is silently never installed for that page while everything else about the tab
 * looks fine.
 *
 * This runs the same pre-steps against a real page and reports which of them
 * throws, so the answer is measured instead of reasoned about.
 *
 *   DISPLAY=:99 node tools/exp-attach-order.js
 */
'use strict';

const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const fixtures = require('./fixture-server');

async function step(label, fn) {
  try {
    await fn();
    console.log('  ok    ' + label);
    return true;
  } catch (e) {
    console.log('  THROW ' + label + '  → ' + String((e && e.message) || e).split('\n')[0]);
    return false;
  }
}

async function main() {
  const fx = await fixtures.start(3121);
  const dir = path.join(os.tmpdir(), 'exp-attach-' + Date.now());
  // Persistent + the extension args, i.e. what RealChrome actually launches.
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    acceptDownloads: true,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(fx.base + '/one', { waitUntil: 'domcontentloaded' });

  console.log('replaying attachPage() pre-steps on a real page:');

  await step('setViewportSize', () => page.setViewportSize({ width: 1280, height: 720 }));

  // The consent auto-dismiss is an addInitScript in this repo. Awaited in
  // attachPage WITHOUT a per-call catch, unlike its neighbours.
  await step('addInitScript (consent auto-dismiss stand-in)',
    () => page.addInitScript(() => { /* no-op */ }));

  await step('exposeBinding __abReportPick',
    () => page.exposeBinding('__abReportPick', () => {}));

  // THE INTERESTING ONE: attachPage runs on pages that may already have been
  // attached once (materialize/adopt/openTab all call it). A second
  // exposeBinding with the same name REJECTS.
  const second = await step('exposeBinding __abReportPick AGAIN (re-attach)',
    () => page.exposeBinding('__abReportPick', () => {}));

  await step('newCDPSession + Fetch.enable (installAuthHandler)', async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', {
      handleAuthRequests: true,
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  });

  console.log('\nNOTE: in attachPage the exposeBinding call has `.catch()`, so a');
  console.log('re-attach does not by itself abort. What matters is whether any');
  console.log('UNGUARDED await before installAuthHandler can reject.');
  console.log('\nsecond exposeBinding rejected: ' + (second ? 'no' : 'YES'));

  await context.close();
  await fx.close();
}

main().catch((e) => { console.error('experiment blew up:', e); process.exit(1); });
