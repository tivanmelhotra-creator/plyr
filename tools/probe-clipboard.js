/**
 * probe-clipboard.js — LIVE proof for §4, "remote copy/paste is broken".
 *
 * The report (docs/HANDOFF-SIX-REGRESSIONS.md §4):
 *
 *   «قبلاً می‌تونستم ریموت کپی یا پیست کنم ولی اینم خراب شده»
 *   — I used to be able to copy or paste remotely, but this broke too.
 *
 * "copy or paste" is ambiguous, and the handoff says so: copy-from-remote and
 * paste-into-remote are different code paths with different constraints. So this
 * probe does NOT assume a direction — it exercises both and names whichever fails.
 *
 * The leading hypothesis (§4b) is what makes this probe's SHAPE matter:
 *
 *   `LiveBrowser.recover()` grants clipboard permissions only inside the
 *   `isContextDead` branch, so a recovery that REUSES the context comes back
 *   subtly less capable than it started — which would explain "it used to work"
 *   with no clipboard code having changed, and would tie this item to the
 *   extension install / restart of §1 and §2.
 *
 * So each direction is tested on a fresh session, after a `resync` (recovery
 * WITHOUT a rebuild — the case the hypothesis predicts fails), and after a real
 * /browser/restart (recovery WITH a rebuild). The middle case is the one that
 * would never be caught by testing a fresh session, which is why the bug survived.
 *
 * The permission itself has no getter, so it is measured through its EFFECT: the
 * fixture page calls navigator.clipboard and reports the promise outcome
 * (`wrote` / `ERR:NotAllowedError`). That is the only direct witness to whether
 * the grant is in place, and it is what distinguishes "refused" from "empty".
 *
 *   DISPLAY=:99 node tools/probe-clipboard.js
 */
'use strict';

const { connect } = require('./bvclient');
const fixture = require('./fixture-server');

const KEY = process.env.API_TOKEN || 'devtoken123';
const results = [];
function record(pass, name, detail) {
  results.push({ pass, name, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
}
function check(name, cond, detail) { record(!!cond, name, detail); }
function group(name) { process.stdout.write(`\n--- ${name} ---\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const fx = await fixture.start(3111);
  process.stdout.write(`fixture origin: ${fx.base}\n`);
  const c = await connect({ userId: '0', key: KEY });

  /** Land on the clipboard fixture with a clean slate. */
  async function reset() {
    fx.reset();
    await c.send({ t: 'navigate', url: `${fx.base}/clip` });
    await c.waitFor('navigated', 25000, c.events.length).catch(() => {});
    await sleep(600);
  }

  /** Wait for the page to report a key, so a slow round-trip is not a failure. */
  async function reported(key, timeoutMs = 6000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = fx.report(key);
      if (v !== undefined && v !== '') return v;
      await sleep(100);
    }
    return fx.report(key);
  }

  /** Ask the server to read the remote clipboard; returns the answer event. */
  async function copyFromRemote() {
    const from = c.events.length;
    await c.send({ t: 'copy' });
    return c.waitFor('clipboard', 15000, from).catch(() => null);
  }

  /** Click the field, type, select all — the "Ctrl+C" setup. */
  async function typeIntoField(text) {
    await c.send({ t: 'click', x: 60, y: 22 });
    await sleep(200);
    await c.send({ t: 'type', text });
    await sleep(350);
  }

  /**
   * Exercise the PERMISSION, via the page's own clipboard calls.
   * Returns { write, read } exactly as the page reported them.
   */
  async function pagePermission(marker) {
    await typeIntoField(marker);
    await c.send({ t: 'click', x: 40, y: 78 });     // "copy" button
    const write = await reported('write');
    await c.send({ t: 'click', x: 130, y: 78 });    // "read" button
    const read = await reported('read');
    return { write: String(write || ''), read: String(read || '') };
  }

  /** The three lifecycle states this bug hides in. */
  async function phase(label, marker) {
    // ── paste INTO the remote page ────────────────────────────────────────
    await reset();
    await c.send({ t: 'click', x: 60, y: 22 });
    await sleep(200);
    const pasteMark = 'p' + marker;
    await c.send({ t: 'paste', text: pasteMark });
    const landed = await reported('field');
    check(`${label}: pasted text lands in the focused field`,
      String(landed || '').indexOf(pasteMark) >= 0,
      'field=' + JSON.stringify(String(landed || '')));

    // ── copy a SELECTION out of the remote page ───────────────────────────
    await reset();
    const selMark = 's' + marker;
    await typeIntoField(selMark);
    await c.send({ t: 'selectAll' });
    await sleep(250);
    const sel = await copyFromRemote();
    check(`${label}: the server answers a copy at all`, !!sel,
      sel ? `source=${sel.source}` : 'NO clipboard EVENT');
    check(`${label}: a selection is copied out of the page`,
      !!sel && String(sel.text || '').indexOf(selMark) >= 0,
      sel ? `source=${sel.source} text=${JSON.stringify(String(sel.text).slice(0, 30))}` : '');

    // ── the PERMISSION-dependent half ────────────────────────────────────
    // This is the one §4b is about. An extension's "Export" is a
    // navigator.clipboard.writeText on the server, and "Load from clipboard" is
    // a readText — both need the grant that recover() only makes conditionally.
    await reset();
    const perm = await pagePermission('c' + marker);
    check(`${label}: the page may WRITE its own clipboard (grant present)`,
      perm.write === 'wrote', 'page reported: ' + JSON.stringify(perm.write));
    check(`${label}: the page may READ its own clipboard (grant present)`,
      perm.read.startsWith('ok:'), 'page reported: ' + JSON.stringify(perm.read));
    check(`${label}: the value read back is the value written`,
      perm.read.indexOf('c' + marker) >= 0, 'read=' + JSON.stringify(perm.read.slice(0, 40)));
  }

  try {
    group('a fresh session (the baseline — this is what testing usually covers)');
    await phase('fresh', '1' + Date.now());

    // ══════════════════════════════════════════════════════════════════════
    // THE HYPOTHESIS: a recovery that reuses the context skips the grant.
    // ══════════════════════════════════════════════════════════════════════
    group('after a resync — recovery WITHOUT a context rebuild (the suspect)');
    await c.send({ t: 'resync' });
    await c.waitFor('ready', 30000, c.events.length).catch(() => {});
    await sleep(900);
    await phase('after resync', '2' + Date.now());

    group('after a real restart — recovery WITH a context rebuild');
    const res = await fetch('http://127.0.0.1:3000/browser/restart', {
      method: 'POST', headers: { 'x-api-key': KEY },
    }).then((r) => r.json()).catch((e) => ({ success: false, error: String(e) }));
    check('the restart itself succeeded', res && res.success !== false,
      res && res.error ? String(res.error) : 'ok');
    await sleep(1500);
    await c.send({ t: 'resync' });
    await c.waitFor('ready', 30000, c.events.length).catch(() => {});
    await sleep(1200);
    await phase('after restart', '3' + Date.now());

    // ── An empty clipboard must be an ANSWER, not silence ─────────────────
    group('nothing to copy is reported, not swallowed');
    await reset();
    const empty = await copyFromRemote();
    // The UI must be able to say "there was nothing to copy"; doing nothing at
    // all is indistinguishable from a broken button.
    check('an empty copy still produces a clipboard event', !!empty,
      empty ? `text=${JSON.stringify(String(empty.text))} source=${empty.source}`
        : 'NO EVENT — the UI cannot explain itself');
  } catch (e) {
    record(false, 'probe reached the end without throwing',
      String(e && e.message ? e.message : e));
  } finally {
    await c.close().catch(() => {});
    await fx.close();
  }

  const failed = results.filter((x) => !x.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('\nfailures:\n');
    failed.forEach((f) => process.stdout.write('  ✗ ' + f.name + (f.detail ? '  — ' + f.detail : '') + '\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => { process.stdout.write('FATAL ' + e.stack + '\n'); process.exitCode = 1; });
