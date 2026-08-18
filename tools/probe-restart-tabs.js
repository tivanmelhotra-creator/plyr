/**
 * tools/probe-restart-tabs.js — LIVE proof for the report the user called
 * «مشکل بزرگیه»: installing an extension lost EVERY tab.
 *
 * Why a new instrument instead of extending probe-live-parity.js
 * ─────────────────────────────────────────────────────────────
 * The six-regressions bug report predicted this bug from the shape of
 * the coverage: the restart/recovery path had unit tests but had NEVER been
 * forced live end-to-end, and that is exactly where the bug lived. The parity
 * probe measures a session that is never yanked out from under itself; this one
 * exists to yank it. Keeping it separate matters because it is destructive by
 * design — it relaunches the shared Chrome, which every other session on the
 * box is attached to, so it must never run as a side effect of a parity check.
 *
 * What it asserts, in the user's own terms
 * ────────────────────────────────────────
 *   «نهایتش باید یه رفرش می‌شد ... ولی کل تب‌ها برای من گم شدن»
 *   At worst a reload. Never a lost tab.
 *
 *   1. three tabs, three distinguishable URLs, one of them NOT the active one
 *   2. relaunch Chrome the way an extension install does (POST /browser/restart)
 *   3. all three tabs must still be in the strip, with their URLs
 *   4. the tab that was active must still be active
 *   5. the on-disk list (profiles/sessions/*.tabs.json) must still hold three,
 *      because that is the backup that has to survive the failure it exists for
 *   6. clicking a restored background tab must materialize it — a chip that
 *      cannot come back is a lost tab wearing a label
 *
 *   node tools/probe-restart-tabs.js        # exit code == number of failures
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { connect } = require('./bvclient');
const fixture = require('./fixture-server');

const KEY = process.env.API_TOKEN || 'devtoken123';
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let BASE = '';
const results = [];

/** Stream results as they are known: a probe that goes silent cannot be diagnosed. */
function record(pass, name, detail) {
  results.push({ pass, name, detail: detail || '' });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
}
function check(name, cond, detail) { record(!!cond, name, detail); }
function group(label) { process.stdout.write('\n--- ' + label + ' ---\n'); }

function page(p) { return BASE + p; }

async function post(route, body) {
  const res = await fetch(BASE_URL + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the raw text for the message */ }
  return { status: res.status, json, text };
}

/**
 * Read the saved tab list straight off disk.
 *
 * The point of item 2b is that a failed recovery must not be able to overwrite
 * this file with a shrunken list, so the assertion has to look at the real file
 * rather than at what the server says about it.
 */
function savedTabsFile() {
  const dir = path.join(process.cwd(), 'profiles', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.tabs.json')); } catch { return null; }
  if (!names.length) return null;
  // Newest wins: a run against a box with several profiles must measure the one
  // this session just wrote.
  const best = names
    .map((n) => ({ n, at: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, best.n), 'utf8'));
    // The file is `{ v, savedAt, tabs: [...] }` (BrowserTabs.saveTabs). Accept a
    // bare array too, so this keeps reporting rather than crashing if that
    // envelope ever changes — a broken instrument that throws tells you less
    // than one that says "0 tabs".
    const tabs = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed && parsed.tabs) ? parsed.tabs : [];
    return { name: best.n, tabs };
  } catch { return null; }
}

/** Collapse to a single tab so a re-run starts from the same place. */
async function soloTab(c) {
  const list = (c.last('tabs') || { tabs: [] }).tabs;
  const keep = (list.find((x) => x.active) || list[0] || {}).id;
  if (!keep) return;
  for (const t of list) {
    if (t.pinned) await c.send({ t: 'tabPin', id: t.id, pinned: false });
  }
  for (const t of list) {
    if (t.id !== keep) await c.send({ t: 'tabClose', id: t.id, force: true });
  }
  await c.sleep(900);
  await c.send({ t: 'dialogAnswer', accept: true });
  await c.send({ t: 'tabSelect', id: keep });
  await c.sleep(400);
}

async function main() {
  const fx = await fixture.start(3111);
  BASE = fx.base;
  console.log('fixture origin: ' + BASE);

  const c = await connect({ userId: '0', key: KEY, port: PORT });
  await c.waitFor('ready', 60000);
  await soloTab(c);

  // ── 1. build a three-tab strip we can recognise afterwards ────────────────
  group('given: three tabs, and the user is NOT on the last one');
  await c.send({ t: 'navigate', url: page('/one') });
  await c.waitFor('navigated', 30000).catch(() => null);

  let m = c.mark();
  await c.send({ t: 'tabNew', url: page('/two') });
  await c.waitFor('tabs', 15000, m).catch(() => null);
  await c.sleep(1200);

  m = c.mark();
  await c.send({ t: 'tabNew', url: page('/three') });
  await c.waitFor('tabs', 15000, m).catch(() => null);
  await c.sleep(1200);

  let strip = (c.last('tabs') || { tabs: [] }).tabs;
  check('three tabs are open before the relaunch', strip.length === 3,
    strip.length + ' tab(s): ' + strip.map((t) => t.url.replace(BASE, '')).join(' | '));

  // Deliberately select the MIDDLE tab. If recovery only ever restores "the
  // active one" the difference between restoring a set and restoring a single
  // page is invisible when the active tab is also the last one.
  const wanted = strip[1];
  if (wanted) {
    m = c.mark();
    await c.send({ t: 'tabSelect', id: wanted.id });
    await c.waitFor('tabs', 15000, m).catch(() => null);
    await c.sleep(800);
  }
  strip = (c.last('tabs') || { tabs: [] }).tabs;
  const activeBefore = strip.find((t) => t.active) || null;
  check('the middle tab is the active one', !!activeBefore && activeBefore.id === wanted.id,
    activeBefore ? activeBefore.url.replace(BASE, '') : 'none active');

  const urlsBefore = strip.map((t) => t.url).sort();
  const savedBefore = savedTabsFile();
  check('the strip was written to disk before the relaunch',
    !!savedBefore && savedBefore.tabs.length === 3,
    savedBefore ? `${savedBefore.name}: ${savedBefore.tabs.length} tab(s)` : 'no file');

  // ── 2. relaunch Chrome exactly the way an extension install does ──────────
  group('when: Chrome is relaunched (what an extension install does)');
  m = c.mark();
  const started = Date.now();
  const r = await post('/browser/restart', {});
  check('the restart route answered', r.status === 200 && r.json && r.json.success !== false,
    `HTTP ${r.status} ${r.json ? JSON.stringify(r.json).slice(0, 120) : r.text.slice(0, 120)}`);

  // The session narrates its own repair; that is the contract index.ts states.
  const recovering = await c.waitFor('recovering', 30000, m).catch(() => null);
  check('the session announced it was recovering (never dead-but-connected)',
    !!recovering, recovering ? 'reason=' + recovering.reason : 'no recovering event');
  const recovered = await c.waitFor('recovered', 90000, m).catch(() => null);
  check('the session announced it had recovered', !!recovered,
    recovered ? `reason=${recovered.reason} in ${Date.now() - started}ms` : 'no recovered event');

  // Give the strip time to settle: `tabs` is emitted from focus(), which lands
  // after materialize().
  await c.sleep(2500);

  // ── 3. THE reported bug: did the tabs survive? ────────────────────────────
  group('then: every tab is still there ("نهایتش باید یه رفرش می‌شد")');
  const after = (c.last('tabs') || { tabs: [] }).tabs;
  check('all three tabs came back', after.length === 3,
    after.length + ' tab(s): ' + after.map((t) => t.url.replace(BASE, '')).join(' | '));

  const urlsAfter = after.map((t) => t.url).sort();
  check('the tabs came back with the SAME urls',
    urlsAfter.length === urlsBefore.length
      && urlsAfter.every((u, i) => u === urlsBefore[i]),
    'before=' + urlsBefore.map((u) => u.replace(BASE, '')).join(',')
      + ' after=' + urlsAfter.map((u) => u.replace(BASE, '')).join(','));

  const activeAfter = after.find((t) => t.active) || null;
  check('the tab that was active is still the active one',
    !!activeAfter && !!activeBefore && activeAfter.url === activeBefore.url,
    activeAfter ? activeAfter.url.replace(BASE, '') : 'none active');

  const savedAfter = savedTabsFile();
  check('the SAVED list still holds three (a failure must not shrink the backup)',
    !!savedAfter && savedAfter.tabs.length === 3,
    savedAfter ? `${savedAfter.name}: ${savedAfter.tabs.length} tab(s) → `
      + savedAfter.tabs.map((t) => String(t.url || '').replace(BASE, '')).join(' | ') : 'no file');

  // ── 4. a restored chip has to be a real tab, not a label ─────────────────
  group('then: a restored background tab can actually be opened again');
  const other = after.find((t) => !t.active);
  if (other) {
    m = c.mark();
    await c.send({ t: 'tabSelect', id: other.id });
    const nav = await c.waitFor('navigated', 40000, m).catch(() => null);
    await c.sleep(1200);
    const now = (c.last('tabs') || { tabs: [] }).tabs;
    const nowActive = now.find((t) => t.active) || null;
    check('clicking a restored tab materializes it and streams it',
      !!nowActive && nowActive.id === other.id,
      nav ? 'navigated → ' + String(nav.url).replace(BASE, '') : 'no navigated event');
    check('materializing a restored tab did not cost another tab', now.length === 3,
      now.length + ' tab(s)');
  } else {
    check('clicking a restored tab materializes it and streams it', false,
      'no background tab survived to click');
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  group('cleanup: leave the session as we found it');
  await soloTab(c);
  const end = (c.last('tabs') || { tabs: [] }).tabs;
  check('back to a single tab', end.length === 1, 'tabs=' + end.length);

  await c.close();
  // `close()`, not `stop()`: it also drops Chrome's idle keep-alive sockets,
  // without which the teardown hangs forever (see fixture-server.js).
  await fx.close();

  const failed = results.filter((x) => !x.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('\nfailures:\n');
    failed.forEach((f) => process.stdout.write('  ✗ ' + f.name + (f.detail ? '  — ' + f.detail : '') + '\n'));
  }
  process.exit(failed.length);
}

main().catch((e) => {
  console.error('probe crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(99);
});
