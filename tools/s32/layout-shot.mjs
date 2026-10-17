// Visual check of the Browser Profiles section inside the Workflow Files
// drawer, in REAL Chromium (zoom 100%, deviceScaleFactor 1), with mocked
// server answers (no app server needed).
// Usage: node tools/s32/layout-shot.mjs <outPrefix>
// Writes <outPrefix>-<w>-list.png / <outPrefix>-<w>.png (form open) and
// prints layout measurements as JSON.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const out = process.argv[2] || '/tmp/pm';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${read('public/css/styles.css')}</style>
<style>body{margin:0;background:var(--bg)} #stage{position:relative;height:100vh;overflow:hidden}</style></head>
<body><div id="stage"></div></body></html>`;
const profiles = [
  { id: 'default', name: 'Default', builtIn: true, status: 'free', available: true, branchId: 'branch-001', branchLabel: 'Default', browser: { open: true }, usedBy: [] },
  { id: 'prf_a', name: 'Shop account', status: 'in_use', available: true, branchId: 'branch-003', branchLabel: 'branch-003', browser: { open: false }, usedBy: [] },
  { id: 'prf_b', name: 'Busy', status: 'reserved', available: false, explanation: 'Reserved for the scheduled run of "Nightly".', branchId: 'branch-003', branchLabel: 'branch-003', browser: { open: false }, usedBy: [] },
];
const branches = [{ id: 'branch-001', label: 'Default', builtIn: true, profiles: [{}] }, { id: 'branch-003', label: 'branch-003', profiles: [{}, {}] }];
const res = {};
const browser = await chromium.launch();
for (const w of [1440, 900, 360]) {
  const page = await browser.newPage({ viewport: { width: w, height: 800 }, deviceScaleFactor: 1 });
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    const m = r.request().method();
    let body = { success: true };
    if (u.pathname === '/profiles/branches') body = { success: true, branches };
    else if (u.pathname === '/profiles/launch-options') body = { success: true, categories: [], options: [], presets: [{ id: 'standard', label: 'Standard', options: [], description: '' }], defaultPreset: 'standard' };
    else if (u.pathname === '/profiles' && m === 'GET') body = { success: true, profiles, unknownSchedules: [] };
    else if (u.pathname === '/profiles/turn-off') body = { success: true, closed: [{ profileId: 'default', name: 'Default' }], keptOpen: [{ profileId: 'prf_a', name: 'Shop account', reason: 'workflow', workflows: [{ workflowId: 'wf_n', name: 'Nightly import' }] }], notOpenedHere: [], failed: [] };
    else if (u.pathname.startsWith('/browser/workflow-files')) body = { success: true, entries: [] };
    if (u.hostname === 'x.test' && u.pathname === '/') return r.fulfill({ contentType: 'text/html', body: html });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://x.test/');
  await page.addScriptTag({ content: `window.AppUtil={t:function(k){return k},toast:function(){}};window.API={getKey:function(){return 'K'}};window.FlowEditor={getCurrentWorkflow:function(){return {id:'wf_abc123'}}};window.BrowserView={openRealBrowser:function(){return Promise.resolve({})}};` });
  for (const f of ['public/js/icons.js', 'public/js/i18n.js']) { try { await page.addScriptTag({ content: read(f) }); } catch (e) { /* optional */ } }
  await page.addScriptTag({ content: read('public/js/profile-manager.js') });
  await page.addScriptTag({ content: read('public/js/workflow-files.js') });
  await page.evaluate(() => window.WorkflowFiles.open({ host: document.getElementById('stage'), browseOnly: true }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}-${w}-list.png` });
  // Turn off result (mocked server answer) on screen.
  await page.click('.pm-turn-off');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}-${w}-off.png` });
  const offText = await page.evaluate(() => (document.querySelector('.pm-off-result') || {}).innerText || '');
  await page.click('.pm-new');
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const host = document.querySelector('.wfm-profiles');
    const hb = host.getBoundingClientRect();
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.top >= hb.top && b.bottom <= hb.bottom; };
    const sel = document.querySelector('.pm-branch-select');
    const d = document.querySelector('.wfm-drawer').getBoundingClientRect();
    return {
      drawer: r('.wfm-drawer'), form: r('.pm-form'), input: r('.pm-input'), select: r('.pm-branch-select'),
      hint: r('.pm-branch-hint'), ok: r('.pm-form-ok'),
      inputVisible: vis('.pm-input'), createVisible: vis('.pm-form-ok'),
      selectBg: getComputedStyle(sel).backgroundColor, selectScheme: getComputedStyle(sel).colorScheme,
      oldSwitch: !!document.querySelector('.wfm-browser'), title: (document.querySelector('.pm-title') || {}).textContent,
      listLabel: (document.querySelector('.pm-list-label') || {}).textContent,
      power: [...document.querySelectorAll('.pm-power button')].map((b) => b.textContent),
      localBrowserText: document.body.innerText.includes('Local Browser'),
      overflowX: [...document.querySelectorAll('.pm-panel *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > d.right + 1 || b.left < d.left - 1); }).map((e) => e.className).slice(0, 5),
    };
  });
  m.offText = offText;
  res[w] = m;
  await page.screenshot({ path: `${out}-${w}.png` });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(res, null, 1));
