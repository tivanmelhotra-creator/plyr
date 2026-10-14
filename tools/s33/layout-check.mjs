// Layout check of the Browser Profiles section in the Workflow Files drawer,
// REAL Chromium, zoom 100% (deviceScaleFactor 1), widths 1440 / 900 / 360.
// Mocked server answers; a profile with an open browser, a hold of ours and
// saved tabs is selected so every remaining action is ENABLED. For each
// control: visible, inside the drawer horizontally, and reachable (scrolled
// into view, then the element at its centre is the control = not covered).
// Usage: node tools/s33/layout-check.mjs <outPrefix>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const out = process.argv[2] || '/tmp/s33';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${read('public/css/styles.css')}</style>
<style>body{margin:0;background:var(--bg)} #stage{position:relative;height:100vh;overflow:hidden}</style></head><body><div id="stage"></div></body></html>`;
const profiles = [
  { id: 'default', name: 'Default', builtIn: true, status: 'free', available: true, branchId: 'branch-001', branchLabel: 'Default', browser: { open: false }, usedBy: [] },
  { id: 'prf_a', name: 'Shop account', status: 'in_use', available: true, branchId: 'branch-003', branchLabel: 'branch-003', browser: { open: true }, hold: { mine: true, until: Date.now() + 600000 }, lastSession: { tabs: 3, savedAt: Date.now() }, usedBy: [] },
  { id: 'prf_b', name: 'Busy', status: 'reserved', available: false, explanation: 'Reserved for the scheduled run of "Nightly".', branchId: 'branch-003', branchLabel: 'branch-003', browser: { open: false }, usedBy: [] },
];
const branches = [{ id: 'branch-001', label: 'Default', builtIn: true, profiles: [{}] }, { id: 'branch-003', label: 'branch-003', profiles: [{}, {}] }];
const CONTROLS = { Open: '.pm-open', Close: '.pm-close', Release: '.pm-release', Rename: '.pm-row[data-id="prf_a"] .pm-ren', 'Restore tabs': '.pm-restore', 'Launch settings': '.pm-launch-sum', 'New profile': '.pm-new' };
const res = {};
const browser = await chromium.launch();
for (const w of [1440, 900, 360]) {
  const page = await browser.newPage({ viewport: { width: w, height: 800 }, deviceScaleFactor: 1 });
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    let body = { success: true };
    if (u.pathname === '/profiles/branches') body = { success: true, branches };
    else if (u.pathname === '/profiles/launch-options') body = { success: true, categories: [], options: [], presets: [{ id: 'standard', label: 'Standard', options: [], description: '' }], defaultPreset: 'standard' };
    else if (u.pathname === '/profiles' && r.request().method() === 'GET') body = { success: true, profiles, unknownSchedules: [] };
    else if (u.pathname.startsWith('/browser/workflow-files')) body = { success: true, entries: [] };
    if (u.hostname === 'x.test' && u.pathname === '/') return r.fulfill({ contentType: 'text/html', body: html });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://x.test/');
  await page.addScriptTag({ content: `window.AppUtil={t:function(k){return k},toast:function(){}};window.API={getKey:function(){return 'K'}};window.FlowEditor={getCurrentWorkflow:function(){return {id:'wf_abc123'}}};` });
  for (const f of ['public/js/icons.js', 'public/js/i18n.js']) { try { await page.addScriptTag({ content: read(f) }); } catch (e) { /* optional */ } }
  await page.addScriptTag({ content: read('public/js/profile-manager.js') });
  await page.addScriptTag({ content: read('public/js/workflow-files.js') });
  await page.evaluate(() => window.WorkflowFiles.open({ host: document.getElementById('stage'), browseOnly: true }));
  await page.waitForTimeout(400);
  await page.check('.pm-row[data-id="prf_a"] .pm-check');
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${out}-${w}.png` });
  const m = {};
  for (const [name, sel] of Object.entries(CONTROLS)) {
    const el = page.locator(sel).first();
    await el.scrollIntoViewIfNeeded();
    m[name] = await el.evaluate((e) => {
      const b = e.getBoundingClientRect();
      const d = document.querySelector('.wfm-drawer').getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return {
        visible: b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden',
        insideDrawer: b.left >= d.left - 1 && b.right <= d.right + 1,
        reachable: !!hit && (hit === e || e.contains(hit)),
        enabled: !e.disabled,
        box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
      };
    });
  }
  await page.evaluate(() => { const s = document.querySelector('.wfm-profiles'); if (s) s.scrollTop = 0; });
  await page.screenshot({ path: `${out}-${w}-top.png` });
  const panel = await page.evaluate(() => {
    const d = document.querySelector('.wfm-drawer').getBoundingClientRect();
    return {
      drawer: [Math.round(d.x), Math.round(d.width)],
      overflowX: [...document.querySelectorAll('.pm-panel *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > d.right + 1 || b.left < d.left - 1); }).map((e) => e.className).slice(0, 5),
      removedPresent: ['.pm-turn-on', '.pm-turn-off', '.pm-power', '.pm-off-result', '.wfm-browser'].filter((s) => document.querySelector(s)),
      forbiddenText: /Turn on|Turn off|Chromium Session Closed|Close Tab|Relaunch/.test(document.body.innerText),
    };
  });
  res[w] = { panel, controls: m };
  await page.close();
}
await browser.close();
console.log(JSON.stringify(res, null, 1));
