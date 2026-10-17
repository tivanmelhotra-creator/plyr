/**
 * Owner brief 2 / A, hypothesis (a): does the viewer tab keep window.opener, and can it
 * close itself? Real app on :3000. Both open styles the app uses:
 *   named = window.open('', 'aria-browser-viewer') then .location = …   (branch, profile-manager.js)
 *   blank = window.open('', '_blank') then .location.href = …            (main, browser-view.js)
 */
import { chromium } from 'playwright';
const op = await chromium.launch({ headless: true });
const ctx = await op.newContext();
const a = await ctx.newPage();
await a.goto('http://127.0.0.1:3000/');
const coop = async (u) => (await fetch('http://127.0.0.1:3000' + u)).headers.get('cross-origin-opener-policy') || '(none)';
console.log('COOP of /:', await coop('/'), '| COOP of /desktop/chrome:', await coop('/desktop/chrome?attach=1'));
for (const [name, target] of [['named', 'aria-browser-viewer'], ['blank', '_blank']]) {
  const pP = ctx.waitForEvent('page');
  await a.evaluate((tg) => { const t = window.open('', tg); t.location.href = '/desktop/chrome?attach=1'; }, target);
  const p = await pP;
  await p.waitForURL(/desktop\/chrome/); await p.waitForLoadState('domcontentloaded');
  const f = await p.evaluate(() => ({ opener: !!window.opener, historyLength: history.length }));
  const closedP = p.waitForEvent('close', { timeout: 3000 }).then(() => true, () => false);
  await p.evaluate(() => window.close()).catch(() => {});
  console.log(`${name}: opener=${f.opener} history.length=${f.historyLength} window.close() closes it=${await closedP}`);
}
await op.close();
