/**
 * THE PICKER FLOW, MEASURED IN A REAL CHROME — Tests A to E from the spec.
 *
 * WHAT IT PROVES
 *   A  fresh launch  : Local Browser pages=1, URL=127.0.0.1:PORT, active, dialogs=1
 *   B  running       : Picker again -> page count unchanged, 1 Alert on the active page
 *   C  three tabs    : tab2 active -> 0/1/0 ; switch to tab3 -> 0/0/1 (moved, not copied)
 *   D  Picker x3     : dialogs=1, no new Local Browser page
 *   E  Picker+Retry2 : dialogs=1, no new Local Browser page
 *   R  restart x2    : no about:blank accumulation (the positional-arg leak)
 *
 * HOW
 *   Pages are read over CDP (/json/list, REAL_CHROME_DEBUG_PORT=9222). Dialogs
 *   are counted by a `DOM.getDocument({pierce:true})` walk that crosses the
 *   closed shadow root and yields the actual `<dialog open>` elements — a DOM
 *   fact, not an attribute. Tabs are activated with `Page.bringToFront`, which
 *   is what clicking a tab does at the browser level. A screenshot of the
 *   final state is written to artifacts/probe-shots/.
 *
 *   "Retry" here is what the dashboard's Retry does server-side: the same
 *   /inspector/targeting/begin for the SAME node+field (the server answers
 *   `reused:true`) followed by /browser/real/open. The viewer-tab difference
 *   (Picker opens one, Retry does not) lives in the dashboard page and is
 *   pinned by tests/unit/picker-retry-repeats-the-last-pick-without-a-new-tab.
 *
 * Run: node tools/probe-initial-page.mjs        (server on :3000, API key admin123,
 *      Local Browser NOT yet running so Test A is a genuine cold start)
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const CDP = 'http://127.0.0.1:9222';
const H = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_TOKEN || 'admin123' };
const SHOTS = path.resolve('artifacts/probe-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function pages() {
  const all = await (await fetch(`${CDP}/json/list`)).json().catch(() => []);
  return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url, ws: t.webSocketDebuggerUrl }));
}
function cdp(wsUrl, calls, timeout = 15000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    const out = {}; let seen = 0; let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(out); } };
    const timer = setTimeout(finish, timeout);
    ws.on('open', () => calls.forEach((c, i) => ws.send(JSON.stringify({ id: i + 1, method: c.method, params: c.params || {} }))));
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (!m.id) return; out[m.id] = m; if (++seen >= calls.length) { clearTimeout(timer); finish(); } });
    ws.on('error', () => { clearTimeout(timer); finish(); });
  });
}
async function openDialogs(p) {
  if (!/^https?:/i.test(p.url)) return { open: 0, owner: null, text: '' };
  const r = await cdp(p.ws, [
    { method: 'Runtime.evaluate', params: { expression: `(()=>{const h=document.getElementById('ab-consent-host');return h?h.getAttribute('data-ab-owner'):null})()`, returnByValue: true } },
    { method: 'DOM.getDocument', params: { depth: -1, pierce: true } },
  ]);
  let open = 0; let text = '';
  (function walk(n) {
    if (!n) return;
    if (n.localName === 'dialog') {
      const a = {}; for (let i = 0; n.attributes && i < n.attributes.length; i += 2) a[n.attributes[i]] = n.attributes[i + 1];
      if ('open' in a) { open++; (function tx(m) { if (m.nodeType === 3) text += m.nodeValue + ' '; (m.children || []).forEach(tx); })(n); }
    }
    (n.children || []).forEach(walk); (n.shadowRoots || []).forEach(walk);
  })(r[2]?.result?.root);
  return { open, owner: r[1]?.result?.result?.value ?? null, text: text.replace(/\s+/g, ' ').trim() };
}
async function census(label) {
  const list = await pages();
  const rows = [];
  for (const p of list) rows.push({ id: p.id.slice(0, 8), url: p.url.replace(BASE, '') || p.url, ...(await openDialogs(p)) });
  console.log(`  ${label}: pages=${list.length}`);
  rows.forEach((r) => console.log(`     ${r.id} ${r.url.padEnd(28)} dialogs=${r.open} owner=${r.owner}${r.text ? '  "' + r.text.slice(0, 60) + '"' : ''}`));
  return { list, rows, total: rows.reduce((a, r) => a + r.open, 0) };
}
async function activate(p) { await cdp(p.ws, [{ method: 'Page.bringToFront' }]); }
async function openOperatorTab(url) {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const r = await cdp(v.webSocketDebuggerUrl, [{ method: 'Target.createTarget', params: { url, newWindow: false } }]);
  await sleep(2500);
  return r[1]?.result?.targetId;
}
async function picker(nodeId, fieldKey, label) {
  const b = await post('/inspector/targeting/begin', { environment: 'local', nodeId, fieldKey, action: 'click', workflowId: 'wf-probe', label });
  const o = await post('/browser/real/open', { url: '' });
  return { consent: b.body?.consent || null, open: o.body || {} };
}
async function screenshot(p, name) {
  const r = await cdp(p.ws, [{ method: 'Page.captureScreenshot', params: { format: 'png' } }]);
  const data = r[1]?.result?.data; if (!data) return null;
  const f = path.join(SHOTS, name); fs.writeFileSync(f, Buffer.from(data, 'base64')); return f;
}

const failures = [];
const check = (label, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures.push(label); };
const report = {};

(async () => {
  console.log('\nTEST A — fresh Picker -> Local Browser');
  const wasRunning = (await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false));
  if (wasRunning) console.log('  (note: Local Browser already running — Test A is measuring a warm browser)');
  const a = await picker('node_a', 'selector', 'Search box');
  await sleep(6000);
  let c = await census('after Picker');
  const proj = c.list.find((p) => p.url === `${BASE}/`);
  check('picker minted a consent', !!a.consent?.consentId, a.consent?.consentId);
  check('server: initial tab handled', ['navigated', 'exists'].includes(a.open.projectPage?.reason), `projectPage=${a.open.projectPage?.reason}`);
  check('Local Browser pages = 1', c.list.length === 1, `pages=${c.list.length}: ${c.list.map((p) => p.url).join(', ')}`);
  check(`initial tab URL = ${BASE}/`, !!proj, c.list.map((p) => p.url).join(', '));
  check('dialogs = 1', c.total === 1, `total=${c.total}`);
  check('the dialog is on the project page', c.rows.find((r) => r.url === '/')?.open === 1);
  report.A = { pages: c.list.length, url: proj?.url, dialogs: c.total, projectPage: a.open.projectPage, alertSurface: a.open.alertSurface, coldStart: !wasRunning };
  if (proj) report.screenshot = await screenshot(proj, 'picker-alert-on-project-page.png');

  console.log('\nTEST B — browser already running, Picker again (another node)');
  const before = c.list.map((p) => p.id);
  const b = await picker('node_b', 'selector', 'Login button');
  await sleep(5500);
  c = await census('after 2nd Picker');
  check('page count unchanged', c.list.length === before.length && c.list.every((p) => before.includes(p.id)), `${before.length} -> ${c.list.length}`);
  check('server reused the project page', b.open.projectPage?.reason === 'exists', b.open.projectPage?.reason);
  check('dialogs = 1', c.total === 1, `total=${c.total}`);
  check('alert shows the NEW request (replace, not stack)', /Login button/.test(c.rows.map((r) => r.text).join(' ')));
  report.B = { pages: c.list.length, dialogs: c.total };

  console.log('\nTEST C — three tabs, tab2 active');
  const t2 = await openOperatorTab(`${BASE}/live-view.html`);
  const t3 = await openOperatorTab(`${BASE}/remote-upload.html`);
  const list = await pages();
  const tab1 = list.find((p) => p.url === `${BASE}/`); const tab2 = list.find((p) => p.id === t2); const tab3 = list.find((p) => p.id === t3);
  await activate(tab2); await sleep(5500);
  c = await census('tab2 active');
  const by = (t) => c.rows.find((r) => r.id === t.id.slice(0, 8));
  check('tab1 = 0 / tab2 = 1 / tab3 = 0', by(tab1)?.open === 0 && by(tab2)?.open === 1 && by(tab3)?.open === 0, `${by(tab1)?.open}/${by(tab2)?.open}/${by(tab3)?.open}`);
  check('exactly one dialog in the whole browser', c.total === 1, `total=${c.total}`);
  report.C_tab2_active = [by(tab1)?.open, by(tab2)?.open, by(tab3)?.open];

  console.log('\nTEST C2 — switch to tab3 (Alert must MOVE, not duplicate)');
  await activate(tab3); await sleep(1200);
  c = await census('right after the switch (push, before any poll)');
  const imm = [by(tab1)?.open, by(tab2)?.open, by(tab3)?.open];
  await sleep(4500);
  c = await census('after a poll tick');
  check('tab2 = 0 / tab3 = 1 immediately (push)', imm[1] === 0 && imm[2] === 1, imm.join('/'));
  check('tab1 = 0 / tab2 = 0 / tab3 = 1 after a poll', by(tab1)?.open === 0 && by(tab2)?.open === 0 && by(tab3)?.open === 1, `${by(tab1)?.open}/${by(tab2)?.open}/${by(tab3)?.open}`);
  check('total = 1', c.total === 1, `total=${c.total}`);
  report.C_switched_to_tab3 = [by(tab1)?.open, by(tab2)?.open, by(tab3)?.open];

  console.log('\nTEST D — Picker x3');
  const beforeD = (await pages()).map((p) => p.id);
  const d = [await picker('node_d', 'selector', 'Field A'), await picker('node_d', 'waitForSelector', 'Field B'), await picker('node_d', 'timeout', 'Field C')];
  await sleep(5500);
  c = await census('after Picker x3');
  check('no new Local Browser page', c.list.length === beforeD.length && c.list.every((p) => beforeD.includes(p.id)), `${beforeD.length} -> ${c.list.length}`);
  check('server never navigated (all "exists")', d.every((x) => x.open.projectPage?.reason === 'exists'), d.map((x) => x.open.projectPage?.reason).join(','));
  check('dialogs = 1', c.total === 1, `total=${c.total}`);
  check('the dialog is on the active tab (tab3) and shows the LAST request', by(tab3)?.open === 1 && /Field C/.test(by(tab3)?.text || ''), (by(tab3)?.text || '').slice(0, 40));
  report.D = { pages: c.list.length, dialogs: c.total };

  console.log('\nTEST E — Picker, Retry, Retry (same target: node_d/timeout)');
  const beforeE = (await pages()).map((p) => p.id);
  const e1 = await picker('node_d', 'timeout', 'Field C'); const e2 = await picker('node_d', 'timeout', 'Field C');
  await sleep(5000);
  c = await census('after Retry x2');
  check('server reused the pending request (reused:true)', e1.consent?.reused === true && e2.consent?.reused === true);
  check('no new Local Browser page', c.list.length === beforeE.length && c.list.every((p) => beforeE.includes(p.id)), `${beforeE.length} -> ${c.list.length}`);
  check('dialogs = 1', c.total === 1, `total=${c.total}`);
  report.E = { pages: c.list.length, dialogs: c.total };

  console.log('\nTEST R — restart x2: no about:blank accumulation');
  const n0 = (await pages()).length;
  for (let i = 1; i <= 2; i++) {
    await post('/browser/restart', {});
    await sleep(9000);
    const l = await pages();
    const blanks = l.filter((p) => p.url === 'about:blank').length;
    console.log(`  after restart ${i}: pages=${l.length} about:blank=${blanks}  [${l.map((p) => p.url.replace(BASE, '')).join(', ')}]`);
    check(`restart ${i}: page count unchanged (${n0})`, l.length === n0, `pages=${l.length}`);
    check(`restart ${i}: zero about:blank`, blanks === 0, `blanks=${blanks}`);
  }
  report.R = { pagesBefore: n0, pagesAfter: (await pages()).length };

  console.log('\n──────── FINAL REPORT ────────');
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length ? `\n${failures.length} FAILED:\n  - ${failures.join('\n  - ')}` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
