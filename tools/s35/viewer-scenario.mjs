/**
 * Owner brief 2 / A: the SAME scenario on any ref, against the REAL app running on :3000.
 *   1. The operator's browser loads the app (/), opens the Workflow Files drawer
 *      (window.WorkflowFiles.open, browseOnly, as the editor does) and presses that
 *      ref's open action: main = Local Browser "Turn on" (.wfm-br-btn);
 *      branch = Browser Profiles: tick a profile + Open (.pm-check, .pm-open).
 *   2. The viewer tab appears; wait until it is connected (#burger visible).
 *   3. Close the browser FROM INSIDE THE TAB:
 *        drawer = the viewer drawer's "Close browser" item (#dclosebrowser);
 *        window = the Chromium window on the remote desktop is closed (wmctrl -c),
 *                 as when the user clicks the window's X inside the tab.
 *   4. Record: did the tab close, after how long, which probes the viewer saw,
 *      and how many browser processes are left.
 * Usage (from a tree): node <this> <label> <drawer|window>
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const [label, mode] = [process.argv[2] || '?', process.argv[3] || 'drawer'];
const BASE = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromes = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
  try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.some((x) => x.startsWith('--user-data-dir=/tmp/s35-')) && !a.some((x) => x.startsWith('--type=')); } catch { return false; }
}).length;
const out = { ref: label, mode };
const op = await chromium.launch({ headless: true });
const ctx = await op.newContext({ viewport: { width: 1400, height: 900 } });
const app = await ctx.newPage();
app.on('dialog', (d) => d.accept());
await app.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await app.waitForFunction(() => !!window.WorkflowFiles, null, { timeout: 30000 });
const wf = await app.evaluate(async () => {
  const r = await fetch('/workflows/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'viewer probe', steps: [] }) });
  const j = await r.json(); return (j.workflow && j.workflow.id) || null;
});
const hasProfiles = await app.evaluate(async () => (await fetch('/profiles')).ok);
if (hasProfiles) await app.evaluate(async () => { await fetch('/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Probe', branchId: 'new' }) }); });
await app.evaluate((id) => { const d = document.createElement('div'); d.id = 'probe-host'; d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#111'; document.body.appendChild(d); window.WorkflowFiles.open({ host: d, workflowId: id, browseOnly: true }); }, wf);
await sleep(3000);
const popupP = ctx.waitForEvent('page', { timeout: 90000 });
if (await app.locator('.pm-check').count()) {
  out.openAction = 'Browser Profiles: tick + Open';
  await app.locator('.pm-check').first().click();
  await app.locator('.pm-open').first().click();
} else if (await app.locator('.wfm-br-btn').count()) {
  out.openAction = 'Local Browser: Turn on';
  await app.locator('.wfm-br-btn').first().click();
} else { out.openAction = 'NONE FOUND'; console.log('RESULT ' + JSON.stringify(out)); process.exit(2); }
const viewer = await popupP;
out.viewerOpener = await viewer.evaluate(() => !!window.opener).catch(() => 'n/a');
await viewer.waitForFunction(() => { const b = document.getElementById('burger'); return b && !b.hidden; }, null, { timeout: 120000 });
out.viewerPath = new URL(viewer.url()).pathname + new URL(viewer.url()).search.replace(/api_key=[^&]*/, 'api_key=…');
const probes = [];
viewer.on('response', async (r) => { const u = r.url(); if (/browser\/(real\/health|sessions)|profiles\/[^/]+\/close|browser\/real\/close/.test(u)) { try { probes.push({ t: Date.now(), u: u.replace(BASE, '').split('?')[0], s: r.status(), b: (await r.text()).replace(/"(lastActivity|startedAt)":\d+,?/g, '').slice(0, 150) }); } catch {} } });
await sleep(3000);
out.browsersBefore = chromes();
out.closedBeforeAction = viewer.isClosed();
const t0 = Date.now();
if (mode === 'drawer') {
  viewer.on('dialog', (d) => d.accept());
  await viewer.evaluate(() => document.getElementById('dclosebrowser').click());
} else {
  const rows = execFileSync('wmctrl', ['-l'], { env: { ...process.env, DISPLAY: ':99' } }).toString().split('\n').filter(Boolean);
  out.windowsClosed = rows.length;
  for (const l of rows) execFileSync('wmctrl', ['-i', '-c', l.split(/\s+/)[0]], { env: { ...process.env, DISPLAY: ':99' } });
}
let closed = false;
try { await viewer.waitForEvent('close', { timeout: 15000 }); closed = true; } catch { closed = viewer.isClosed(); }
out.viewerClosed = closed;
out.msToClose = closed ? Date.now() - t0 : null;
await sleep(500);
out.browsersAfter = chromes();
if (!closed) out.viewerState = await viewer.evaluate(() => ({ path: location.pathname, viewerGone: document.body.classList.contains('viewer-gone'), endedDialog: !!(document.getElementById('ended') && !document.getElementById('ended').hidden), text: document.body.innerText.trim().slice(0, 100) })).catch((e) => String(e).slice(0, 80));
out.requestsAfterAction = probes.filter((p) => p.t >= t0).slice(-4).map((p) => `${p.u} ${p.s} -> ${p.b}`);
console.log('RESULT ' + JSON.stringify(out, null, 1));
await op.close();
