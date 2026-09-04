/**
 * ONE ALERT, OWNED BY THE ACTIVE TAB — MEASURED IN A REAL CHROME.
 *
 * THE REPORTED BUG
 * ----------------
 *   «Alert در تمام Tabها نمایش داده می‌شود» — Tab 1 / Tab 2 / Tab 3 all drew
 *   the consent <dialog>. Required: exactly ONE alert, in the ACTIVE tab; on a
 *   tab switch it MOVES (Tab 2 → 0, Tab 3 → 1), it is not duplicated.
 *
 *   And BUG 2: the dialog was a full-height sheet (measured 310×660). It must
 *   be a compact, content-sized confirm box (max-width ≈ 400–460px).
 *
 * WHAT IS MEASURED, AND HOW
 * -------------------------
 *   Pages are enumerated over CDP (`/json/list`), tracked by TARGET ID so a
 *   page created + a page closed cannot hide as "count unchanged". Dialogs are
 *   read two ways per page: the host's mirrored census (`data-ab-open`,
 *   `data-ab-owner`) and a `DOM.getDocument({pierce:true})` walk that crosses
 *   the CLOSED shadow root and yields the real `<dialog open>` elements and
 *   their text — so "0 dialogs" is a fact about the DOM, not an attribute.
 *
 *   Tabs are activated with `Page.bringToFront` — the same thing the operator
 *   clicking a tab does at the browser level — and the dialog's rendered box is
 *   measured with getBoundingClientRect() through the extension's own host, plus
 *   a real `Page.captureScreenshot` saved to artifacts/probe-shots/.
 *
 * THE TESTS (verbatim from the mission)
 *   1  one tab            → pages=1, dialogs=1
 *   2  three tabs, tab2 active → 0 / 1 / 0
 *   3  switch to tab3     → tab2=0, tab3=1 (moved, not duplicated)
 *   4  Picker ×3          → still ONE dialog, no new page
 *   5  Picker, Retry, Retry → ONE dialog, no new tab
 *   6  replace, not stack → the dialog shows the NEWEST question only
 *
 * Run: node tools/probe-active-tab.mjs
 * Requires: server on :3000, Local Browser open, REAL_CHROME_DEBUG_PORT=9222.
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3000';
const CDP = 'http://127.0.0.1:9222';
const H = { 'Content-Type': 'application/json', 'X-API-Key': 'admin123' };
const SHOTS = path.resolve('artifacts/probe-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body) {
  try {
    const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: { error: String(e.message || e) } }; }
}

async function pages() {
  const r = await fetch(`${CDP}/json/list`);
  const all = await r.json().catch(() => []);
  return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url, ws: t.webSocketDebuggerUrl }));
}

async function browserWs() {
  const r = await fetch(`${CDP}/json/version`);
  return (await r.json()).webSocketDebuggerUrl;
}

/** Several CDP calls on one socket, in order; resolves with a map id→reply. */
function cdp(wsUrl, calls, timeout = 10000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    const out = {}; let seen = 0; let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(out); } };
    const timer = setTimeout(finish, timeout);
    ws.on('open', () => calls.forEach((c, i) => ws.send(JSON.stringify({ id: i + 1, method: c.method, params: c.params || {} }))));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m.id) return;
      out[m.id] = m; seen++;
      if (seen >= calls.length) { clearTimeout(timer); finish(); }
    });
    ws.on('error', () => { clearTimeout(timer); finish(); });
  });
}

async function evaluate(p, expression) {
  const r = await cdp(p.ws, [{ method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }]);
  return r[1]?.result?.result?.value ?? null;
}

/**
 * Open a tab the way the OPERATOR does (a new tab in the same window), via the
 * browser target. This is the probe's fixture, not the code under test — the
 * assertion is that the PICKER and RETRY create none.
 */
async function openOperatorTab(url) {
  const r = await cdp(await browserWs(), [{ method: 'Target.createTarget', params: { url, newWindow: false } }]);
  await sleep(2500);
  return r[1]?.result?.targetId || null;
}

/** Click on the tab, at browser level. */
async function activate(p) {
  await cdp(p.ws, [{ method: 'Page.bringToFront' }]);
  await sleep(1800);
}

/** The <dialog open> elements of a page, read through the closed shadow root. */
async function dialogsIn(p) {
  const res = await cdp(p.ws, [{ method: 'DOM.getDocument', params: { depth: -1, pierce: true } }]);
  const root = res[1]?.result?.root;
  const found = [];
  if (!root) return found;
  (function walk(n) {
    if (!n) return;
    if (n.localName === 'dialog') {
      const attrs = {};
      for (let i = 0; n.attributes && i < n.attributes.length; i += 2) attrs[n.attributes[i]] = n.attributes[i + 1];
      if ('open' in attrs) {
        let text = '';
        (function tx(m) { if (m.nodeType === 3) text += m.nodeValue + ' '; (m.children || []).forEach(tx); })(n);
        found.push({ text: text.replace(/\s+/g, ' ').trim() });
      }
    }
    (n.children || []).forEach(walk);
    (n.shadowRoots || []).forEach(walk);
  })(root);
  return found;
}

/** Full census per page. */
async function census(list) {
  const rows = [];
  for (const p of list) {
    const row = { id: p.id.slice(0, 8), url: p.url.replace(BASE, ''), vis: '-', open: 0, mirrored: null, owner: null, text: '' };
    if (p.ws && /^https?:/i.test(p.url)) {
      const got = await evaluate(p, `(() => {
        const h = document.getElementById('ab-consent-host');
        return JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(),
          mirrored: h ? Number(h.getAttribute('data-ab-open') || 0) : null,
          owner: h ? h.getAttribute('data-ab-owner') : null });
      })()`);
      try { Object.assign(row, JSON.parse(got)); } catch {}
      const ds = await dialogsIn(p);
      row.open = ds.length;
      row.text = ds.map((d) => d.text).join(' | ');
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Raise a REAL prompt the way the picker does. fieldKey must be a DECLARED
 * click field (selector / waitForSelector / timeout) or the route says 400.
 */
async function raisePrompt(nodeId, fieldKey, label) {
  const res = await post('/inspector/targeting/begin', {
    environment: 'local', nodeId, fieldKey, action: 'click', workflowId: 'wf-probe', label,
  });
  return { consentId: res.body?.consent?.consentId || null, status: res.status };
}

async function screenshot(p, name) {
  const r = await cdp(p.ws, [{ method: 'Page.captureScreenshot', params: { format: 'png' } }], 15000);
  const data = r[1]?.result?.data;
  if (!data) return null;
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** The dialog's rendered box, via the extension host's own shadow root (closed → measured from inside via CDP DOM). */
async function dialogBox(p) {
  // nodeIds are scoped to ONE CDP session, so the document walk and the box
  // read must share a socket — a second connection would not know the id.
  return new Promise((resolve) => {
    const ws = new WebSocket(p.ws, { maxPayload: 64 * 1024 * 1024 });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish(null), 15000);
    let vp = null;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({w:innerWidth,h:innerHeight})', returnByValue: true } }));
      ws.send(JSON.stringify({ id: 2, method: 'DOM.getDocument', params: { depth: -1, pierce: true } }));
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id === 1) { try { vp = JSON.parse(m.result?.result?.value || '{}'); } catch {} }
      if (m.id === 2) {
        let nodeId = null;
        (function walk(n) {
          if (!n || nodeId) return;
          if (n.localName === 'dialog') { nodeId = n.nodeId; return; }
          (n.children || []).forEach(walk);
          (n.shadowRoots || []).forEach(walk);
        })(m.result?.root);
        if (!nodeId) { clearTimeout(timer); finish(null); return; }
        ws.send(JSON.stringify({ id: 3, method: 'DOM.getBoxModel', params: { nodeId } }));
      }
      if (m.id === 3) {
        clearTimeout(timer);
        const model = m.result?.model;
        finish(model ? { width: model.width, height: model.height, viewport: vp || {} } : null);
      }
    });
    ws.on('error', () => { clearTimeout(timer); finish(null); });
  });
}

// ─────────────────────────────────────────────────────────────────
const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
}
function table(rows) {
  rows.forEach((r, i) => console.log(`      tab${i + 1} ${r.id} ${r.url.padEnd(24)} vis=${r.vis} focus=${r.focus} open=${r.open} owner=${r.owner} ${r.text ? '"' + r.text.slice(0, 60) + '"' : ''}`));
}
const openOf = (rows) => rows.map((r) => r.open);
const totalOpen = (rows) => rows.reduce((a, r) => a + r.open, 0);

const report = {};

(async () => {
  // ── Baseline: one tab, the project UI, as the Local Browser launched it ──
  let list = await pages();
  const launchIds = new Set(list.map((p) => p.id));
  console.log(`\nLaunch: ${list.length} page(s): ${list.map((p) => p.url).join(', ')}`);
  let tab1 = list[0];
  if (!/^https?:/i.test(tab1.url)) {
    // The seeded first tab is the project UI; a bare about:blank means the
    // profile restored nothing — navigate the SAME tab (not a new one).
    await cdp(tab1.ws, [{ method: 'Page.navigate', params: { url: `${BASE}/` } }]);
    await sleep(2500);
    list = await pages(); tab1 = list.find((p) => p.id === tab1.id) || list[0];
  }
  check('first Local Browser tab shows the project UI (127.0.0.1:3000)', /127\.0\.0\.1:3000/.test(tab1.url), tab1.url);

  // ── TEST 1: one tab → pages=1, dialogs=1 ─────────────────────────
  console.log('\nTEST 1 — one tab, Picker → pages=1, dialogs=1');
  await activate(tab1);
  const pagesBeforePick = (await pages()).length;
  const pick1 = await raisePrompt('node_t1', 'selector', 'Search box');
  await sleep(5500);                                   // > POLL_MS
  list = await pages();
  let rows = await census(list);
  table(rows);
  report.pagesAtPicker = list.length;
  report.newPagesByPicker = list.filter((p) => !launchIds.has(p.id)).length;
  report.activeAtPicker = rows[0].url;
  check('picker minted a consent', pick1.status === 200 && !!pick1.consentId, `status=${pick1.status}`);
  check('pages = 1', list.length === 1, `pages=${list.length}`);
  check('dialogs = 1', totalOpen(rows) === 1, `open=${openOf(rows)}`);
  check('Picker created no page', list.length === pagesBeforePick, `${pagesBeforePick}→${list.length}`);

  // Size + screenshot (BUG 2)
  const box = await dialogBox(tab1);
  console.log(`      dialog box: ${box ? `${Math.round(box.width)}×${Math.round(box.height)}px in ${box.viewport.w}×${box.viewport.h}` : 'n/a'}`);
  report.dialogBox = box;
  check('dialog is compact: width ≤ 460px', !!box && box.width <= 460, box && `${Math.round(box.width)}px`);
  check('dialog is content-sized: height < 60% of viewport', !!box && box.height < box.viewport.h * 0.6, box && `${Math.round(box.height)}px`);
  const shot = await screenshot(tab1, 'alert-tab1.png');
  console.log(`      screenshot: ${shot}`);
  report.screenshot = shot;

  // ── TEST 2: three tabs, tab2 active → 0 / 1 / 0 ─────────────────
  console.log('\nTEST 2 — three tabs, tab2 active → 0 / 1 / 0');
  const t2 = await openOperatorTab(`${BASE}/live-view.html`);
  const t3 = await openOperatorTab(`${BASE}/remote-upload.html`);
  list = await pages();
  const byId = (id) => list.find((p) => p.id === id);
  let tab2 = byId(t2); let tab3 = byId(t3);
  const ordered = [tab1, tab2, tab3].map((t) => byId(t.id));
  await activate(tab2);
  await sleep(5000);
  rows = await census(ordered);
  table(rows);
  report.test2 = openOf(rows);
  check('three tabs exist', ordered.every(Boolean) && list.length === 3, `pages=${list.length}`);
  check('tab1 = 0', rows[0].open === 0);
  check('tab2 = 1 (active)', rows[1].open === 1);
  check('tab3 = 0', rows[2].open === 0);
  check('exactly one dialog in the whole browser', totalOpen(rows) === 1, `total=${totalOpen(rows)}`);
  check('alert owner is the active tab (data-ab-owner=1 there only)',
    rows[1].owner === '1' && rows[0].owner !== '1' && rows[2].owner !== '1', `owners=${rows.map((r) => r.owner)}`);
  report.ownerTest2 = `tab2 ${rows[1].url}`;
  const shot2 = await screenshot(tab2, 'alert-tab2.png');
  console.log(`      screenshot: ${shot2}`);

  // ── TEST 3: switch to tab3 → tab2=0, tab3=1 ─────────────────────
  console.log('\nTEST 3 — switch to tab3 → tab2=0, tab3=1 (moved, not duplicated)');
  await activate(tab3);
  await sleep(1200);                                   // push, not poll
  rows = await census(ordered);
  console.log('    right after the switch (before any poll tick):');
  table(rows);
  const immediate = openOf(rows);
  await sleep(4500);
  rows = await census(ordered);
  console.log('    after a poll tick:');
  table(rows);
  report.test3 = openOf(rows);
  report.test3Immediate = immediate;
  check('tab2 = 0 (left)', rows[1].open === 0);
  check('tab3 = 1 (arrived)', rows[2].open === 1);
  check('tab1 = 0', rows[0].open === 0);
  check('moved, not duplicated: total = 1', totalOpen(rows) === 1, `total=${totalOpen(rows)}`);
  check('the move happened by push (≤ ~1s), not by waiting for the poll',
    immediate[1] === 0 && immediate[2] === 1, `immediate=${immediate}`);
  report.ownerTest3 = `tab3 ${rows[2].url}`;

  // ── TEST 4: Picker ×3 → ONE dialog, no new page ─────────────────
  console.log('\nTEST 4 — Picker ×3 → one dialog, no new page');
  const before4 = (await pages()).map((p) => p.id);
  await raisePrompt('node_t4a', 'selector', 'Field A');
  await raisePrompt('node_t4b', 'waitForSelector', 'Field B');
  await raisePrompt('node_t4c', 'timeout', 'Field C');
  await sleep(5500);
  list = await pages();
  rows = await census([tab1, tab2, tab3].map((t) => list.find((p) => p.id === t.id)));
  table(rows);
  const newBy4 = list.filter((p) => !before4.includes(p.id)).length;
  report.newPagesByPicker += newBy4;
  check('Picker ×3 created no page', newBy4 === 0, `new=${newBy4}`);
  check('one dialog only', totalOpen(rows) === 1, `total=${totalOpen(rows)}`);
  check('… and it is in the active tab (tab3)', rows[2].open === 1);

  // ── TEST 5: Picker, Retry, Retry → ONE dialog, no new tab ───────
  console.log('\nTEST 5 — Picker, Retry, Retry → one dialog, no new tab');
  const before5 = (await pages()).map((p) => p.id);
  await raisePrompt('node_t5', 'selector', 'Field R');
  const r1 = await post('/browser/real/open', { noTab: true });
  const r2 = await post('/browser/real/open', { noTab: true });
  await sleep(5500);
  list = await pages();
  rows = await census([tab1, tab2, tab3].map((t) => list.find((p) => p.id === t.id)));
  table(rows);
  const newBy5 = list.filter((p) => !before5.includes(p.id)).length;
  report.newPagesByRetry = newBy5;
  check('Retry answered ok', r1.status === 200 && r2.status === 200, `${r1.status},${r2.status}`);
  check('Retry ×2 created no tab', newBy5 === 0, `new=${newBy5}`);
  check('one dialog only', totalOpen(rows) === 1, `total=${totalOpen(rows)}`);
  check('total pages unchanged (3)', list.length === 3, `pages=${list.length}`);

  // ── TEST 6: replace, not stack ──────────────────────────────────
  console.log('\nTEST 6 — replace, not stack: the dialog shows the NEWEST question');
  await raisePrompt('node_t6', 'selector', 'ZZ-newest-field');
  await sleep(5500);
  list = await pages();
  rows = await census([tab1, tab2, tab3].map((t) => list.find((p) => p.id === t.id)));
  table(rows);
  check('one dialog only', totalOpen(rows) === 1, `total=${totalOpen(rows)}`);
  check('dialog text names the newest question', /ZZ-newest-field/.test(rows[2].text), rows[2].text.slice(0, 80));
  check('… and not the previous one', !/Field R/.test(rows[2].text));
  const shot3 = await screenshot(tab3, 'alert-tab3-final.png');
  console.log(`      screenshot: ${shot3}`);

  // ── REPORT ───────────────────────────────────────────────────────
  list = await pages();
  rows = await census(list);
  const hidden = rows.reduce((a, r) => a + ((r.mirrored || 0) - r.open > 0 ? 1 : 0), 0);
  console.log('\n══════════════ REPORT ══════════════');
  console.log(`Number of Local Browser pages : ${list.length}`);
  console.log(`Active dialogs (browser-wide)  : ${totalOpen(rows)}`);
  console.log(`Hidden dialogs                 : ${hidden}`);
  console.log(`New pages by Picker            : ${report.newPagesByPicker}`);
  console.log(`New pages by Retry             : ${report.newPagesByRetry}`);
  console.log(`Active page at Picker          : ${report.activeAtPicker}`);
  console.log(`Alert owner page (test 2)      : ${report.ownerTest2}`);
  console.log(`Alert owner page (test 3)      : ${report.ownerTest3}`);
  console.log(`Test 2  tab1/tab2/tab3 dialogs : ${report.test2.join(' / ')}`);
  console.log(`Test 3  tab1/tab2/tab3 dialogs : ${report.test3.join(' / ')}   (immediately after switch: ${report.test3Immediate.join(' / ')})`);
  console.log(`Dialog box                     : ${report.dialogBox ? `${Math.round(report.dialogBox.width)}×${Math.round(report.dialogBox.height)}px in ${report.dialogBox.viewport.w}×${report.dialogBox.viewport.h}` : 'n/a'}`);
  console.log(`Screenshot                     : ${report.screenshot}`);
  console.log(`\n${failures.length ? `FAILED (${failures.length}):\n  - ${failures.join('\n  - ')}` : 'ALL CHECKS PASSED'}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
