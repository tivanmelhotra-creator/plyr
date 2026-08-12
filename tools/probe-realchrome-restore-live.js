/**
 * probe-realchrome-restore-live.js — prove the fix through the PRODUCT code.
 *
 * tools/probe-realchrome-tab-loss.js measured the browser behaviour with its own
 * replica of the launch path. That is how the cause was found, but it proves
 * nothing about `RealChrome` itself: a fix can be measured correct in a replica
 * and still be wired up wrong in the class that ships.
 *
 * So this script drives the REAL `RealChrome`:
 *
 *   1. RealChrome.getContext()  — the product launch, extensions and all
 *   2. open three tabs
 *   3. SIGKILL the browser tree  — "it froze so I closed it"
 *   4. RealChrome.getContext()  — the product relaunch
 *   5. count the tabs that came back, via RealChrome.tabs()
 *
 * It also exercises the wedged-browser path (isResponsive / recycleIfWedged),
 * because "the browser object exists" and "the browser answers" are the two
 * states the operator's report is about.
 *
 * Run (needs a display; extensions require a headed Chrome):
 *   Xvfb :99 -screen 0 1280x800x24 &
 *   DISPLAY=:99 REAL_CHROME_ENABLED=true \
 *     REAL_CHROME_USER_DATA_DIR=/tmp/live-profile \
 *     npx tsx tools/probe-realchrome-restore-live.js
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const URLS = [
  'data:text/html,<title>ALPHA</title><h1>alpha</h1>',
  'data:text/html,<title>BETA</title><h1>beta</h1>',
  'data:text/html,<title>GAMMA</title><h1>gamma</h1>',
];

function chromePids(userDataDir) {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(`--user-data-dir=${userDataDir}`))
      .map((l) => parseInt(l.trim().split(/\s+/)[0], 10))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // tsx compiles the TS on import, so the product code runs as written.
  const { RealChrome } = require('../src/core/RealChrome.ts');
  const { config } = require('../src/config.ts');

  const dir = config.REAL_CHROME_USER_DATA_DIR;
  const out = {
    profile: dir,
    restoreTabsSetting: config.REAL_CHROME_RESTORE_TABS,
    headless: config.REAL_CHROME_HEADLESS,
  };

  // ── 1-2. product launch, three tabs ──────────────────────────────────
  const ctx = await RealChrome.getContext();
  for (let i = 0; i < URLS.length; i++) {
    const pages = ctx.pages();
    const page = i === 0 && pages[0] ? pages[0] : await ctx.newPage();
    await page.goto(URLS[i]);
  }
  await sleep(2000); // Chrome flushes its session file lazily.

  out.beforeTabs = (await RealChrome.tabs()).map((t) => t.title).filter(Boolean);
  out.beforeResponsive = await RealChrome.isResponsive();

  // ── 3. the crash ─────────────────────────────────────────────────────
  const pids = chromePids(dir);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  out.killedPids = pids.length;
  await sleep(2500);

  // A SIGKILLed browser DOES close its context, so Playwright notices and
  // RealChrome's own close handler clears the reference. Record what the class
  // believes, because "running" lying is the other half of the report.
  out.isRunningAfterKill = RealChrome.isRunning();
  out.isResponsiveAfterKill = await RealChrome.isResponsive();

  // ── 4-5. product relaunch, count what came back ──────────────────────
  await RealChrome.getContext();
  await sleep(3000);
  out.afterTabs = (await RealChrome.tabs()).map((t) => t.title).filter(Boolean);
  out.afterResponsive = await RealChrome.isResponsive();

  // ── the wedged path: recycling a HEALTHY browser must be a no-op ──────
  out.recycleWhenHealthy = await RealChrome.recycleIfWedged();

  const restored = URLS
    .map((u) => decodeURIComponent(u).match(/<title>([^<]+)</)[1])
    .filter((title) => out.afterTabs.includes(title));
  out.restoredTitles = restored;

  console.log(JSON.stringify(out, null, 2));
  console.log('\n=== VERDICT ===');
  console.log(`tabs before crash : ${out.beforeTabs.length}`);
  console.log(`tabs after relaunch: ${out.afterTabs.length}`);
  console.log(`RESTORED_THROUGH_PRODUCT_CODE=${restored.length === URLS.length}`);
  console.log(`HEALTHY_BROWSER_NOT_RECYCLED=${out.recycleWhenHealthy.action === 'none'}`);

  await RealChrome.stop();
  for (const pid of chromePids(dir)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
