#!/usr/bin/env node
/**
 * probe-remote-browser-retry.js — why "Retry" spun forever.
 *
 * THE REPORT
 *   «اولین مشکلی که مواجه شدم موقعه ای که میخام مرورگر ریموت رو بالا بیارم اینو
 *    میاره: The remote browser did not start / Missing: Xvfb …
 *    بعد من همین Retry رو میزنم شروع میکنه به starting cromium... ولی باز فقط
 *    میچرخه و چیزی بالا نمیاد»
 *
 * Three defects hide behind that one sentence, and only the FIRST is about
 * missing packages:
 *
 *   1. The packages really were absent, and that message is correct. But it is
 *      not RETRYABLE: no amount of pressing a button installs a package, so the
 *      page has to say what to run instead of implying that trying again helps.
 *
 *   2. The failure page's "Retry" pointed at `/desktop/chrome` — the VIEWER.
 *      Nothing on that path started a display or a browser, so Retry could not
 *      recover: it navigated from a page saying "did not start" to a page that
 *      waits for something already started. It relocated the dead end. The only
 *      endpoint that starts anything is POST /browser/real/open.
 *
 *   3. The viewer then spun FOREVER instead of reporting the failure. Its status
 *      only changed from RFB's own 'disconnect'/'securityfailure' events, and
 *      when the desktop is down there is no RFB at all: `import RFB from
 *      './core/rfb.js'` is proxied to websockify, which is not running, so the
 *      module 503s. A STATIC top-level import makes that fatal to the whole
 *      module — the body never executes, so the handlers that would have shown
 *      an error are inside the thing that failed to load.
 *
 * MEASURED before the fix, against a real Chromium:
 *   t≈2s   msg="Starting Chromium…"  spinner=true  retryBtn=false
 *   t≈8s   msg="Starting Chromium…"  spinner=true  retryBtn=false
 *   t≈20s  msg="Starting Chromium…"  spinner=true  retryBtn=false
 * with exactly one line in the page console: a 503.
 *
 * All three fail SILENTLY — no exception reaches the operator, the UI simply
 * lies about being busy. A regression here looks like "it is just slow", which
 * is indistinguishable from working, which is why this probe is committed.
 *
 * A NOTE ON THE FIX'S OWN FIRST BUG, also measured here: /browser/* is not
 * covered by the desktop session cookie (scoped Path=/desktop), so the first
 * version of the start call answered 401 and the page honestly reported the
 * wrong problem. Check 2.4 pins the credential so that cannot come back.
 *
 * USAGE
 *   node dist/index.js &                       # the app, any desktop state
 *   node tools/probe-remote-browser-retry.js   # -> N/N checks, VERDICT=PASS
 *
 * The probe drives the desktop itself (stops it to create the cold state), so
 * it needs the API token: PROBE_BASE and API_TOKEN override the defaults.
 */

'use strict';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3000';
const TOKEN = process.env.API_TOKEN || 'admin123';

let pass = 0;
let fail = 0;

function check(name, got, want, why) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (why) console.log(`        ${why}`);
}

const api = (path, init) => fetch(BASE + path, {
  ...init,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...(init && init.headers),
  },
});

async function desktopRunning() {
  try {
    const r = await api('/browser/desktop/status');
    const j = await r.json();
    return !!(j && j.desktop && j.desktop.running);
  } catch { return false; }
}

async function main() {
  const { chromium } = require('playwright');
  const { readFileSync } = require('fs');
  const path = require('path');

  console.log('=== 1. the source-level guarantees ===');
  const viewSrc = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'ChromeView.ts'), 'utf8');

  // A static import of rfb.js is THE defect-3 mechanism. It must never return.
  check('rfb.js is NOT imported statically at the top level',
    /^\s*import\s+RFB\s+from\s+'\.\/core\/rfb\.js'/m.test(viewSrc), false,
    'a static import that 503s kills the module that would have reported it');
  check('…it is loaded dynamically instead, inside a catch',
    /await import\('\.\/core\/rfb\.js'\)/.test(viewSrc), true);
  check('the view starts the stack rather than only connecting',
    /async function startThenConnect/.test(viewSrc), true,
    'this is what makes the failure page\'s Retry able to recover');
  check('…and the start call carries a credential',
    /headers: Object\.assign\(\{ 'Content-Type': 'application\/json' \}, authHeaders\(\)\)/
      .test(viewSrc), true,
    '/browser/* is not covered by the Path=/desktop session cookie -> 401');

  console.log('\n=== 2. the cold state the operator was in ===');
  await api('/browser/desktop/stop', { method: 'POST' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  check('the desktop is stopped, as it is on a fresh box', await desktopRunning(), false,
    'every check below describes THIS state');

  console.log('\n=== 3. what the operator sees on the view, cold ===');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status()); });
  await page.goto(`${BASE}/desktop/chrome?api_key=${encodeURIComponent(TOKEN)}`,
    { waitUntil: 'domcontentloaded' });

  const sample = async () => ({
    msg: ((await page.locator('#msg').textContent().catch(() => '')) || '').trim(),
    spinner: await page.locator('#spin').isVisible().catch(() => false),
    retry: await page.locator('#retry').isVisible().catch(() => false),
  });

  // The view now START the stack on load, so the honest outcome here is either
  // "it came up" (notice hidden) or "it failed and told me". Never a spinner
  // that outlives the attempt.
  let settled = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const s = await sample();
    const noticeGone = await page.locator('#note').isVisible().catch(() => true) === false;
    if (noticeGone) { settled = { ...s, connected: true }; break; }
    if (s.spinner === false) { settled = { ...s, connected: false }; break; }
  }
  check('the view stops claiming to be starting', settled !== null, true,
    `settled=${JSON.stringify(settled)} httpErrors=${JSON.stringify(bad)}`);
  if (settled && !settled.connected) {
    check('…and when it failed it offers an action instead of a spinner',
      settled.retry, true, 'a dead end with no button is what made this unrecoverable');
    // Deliberately NOT /start/i: "Starting Chromium…" contains it, so that
    // spelling would pass against the very message this probe exists to catch.
    check('…and names the real problem',
      /not running|could not|failed|unavailable/i.test(settled.msg), true,
      `msg=${JSON.stringify(settled.msg)}`);
  } else if (settled && settled.connected) {
    check('…because loading the view BROUGHT THE STACK UP by itself',
      await desktopRunning(), true,
      'this is the whole fix: arriving here means "I want the browser up"');
  }

  console.log('\n=== 4. the start endpoint, for contrast ===');
  const r = await api('/browser/real/open', { method: 'POST', body: JSON.stringify({ url: '' }) });
  const j = await r.json().catch(() => ({}));
  check('POST /browser/real/open starts the whole stack', [r.status, !!j.success], [200, true],
    'display + window manager + x11vnc + noVNC + a headed Chromium');
  check('…and the desktop is running afterwards', await desktopRunning(), true);

  console.log('\n=== 5. the view connects once the stack is up ===');
  const page2 = await browser.newPage();
  await page2.goto(`${BASE}/desktop/chrome?api_key=${encodeURIComponent(TOKEN)}`,
    { waitUntil: 'domcontentloaded' });
  let connected = false;
  for (let i = 0; i < 25; i++) {
    await page2.waitForTimeout(1000);
    if (await page2.locator('#note').isVisible().catch(() => true) === false) {
      connected = true; break;
    }
  }
  check('with the desktop up, the notice goes away and Chromium is shown', connected, true,
    'proving a spinner that never ends was a false report, not a slow success');

  await browser.close();

  console.log(`\n================ ${pass}/${pass + fail} checks passed ================`);
  console.log(fail === 0
    ? 'VERDICT=PASS — the view starts the stack, and a down desktop is reported, not spun on.'
    : 'VERDICT=FAIL');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
