#!/usr/bin/env node
/**
 * tools/probe-focus.js — the two still-failing groups, and nothing else.
 *
 * The full parity probe takes about two minutes because it drives 68 checks
 * through a real browser. That is the right price for a regression gate and the
 * wrong price for iterating on one bug, so this drives only the drag group and
 * the basic-auth group. Same harness, same server, same fixtures — it is a
 * subset of the truth, never a substitute for it. Re-run the full probe before
 * believing anything.
 *
 *   DISPLAY=:99 node tools/probe-focus.js
 */
'use strict';

const { connect } = require('./bvclient');
const fixture = require('./fixture-server');

const results = [];
function check(name, cond, detail) {
  results.push({ pass: !!cond, name, detail: detail || '' });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

async function main() {
  const fx = await fixture.start(3111);
  const page = (p) => fx.base + p;
  const said = (k) => String(fx.report(k) ?? '');
  console.log('fixture origin: ' + fx.base + '\n');

  const c = await connect({ userId: '0', key: 'devtoken123' });
  await c.waitFor('ready', 60000);

  // Print every error the server volunteers. BrowserStreamServer answers a
  // rejected command with {t:'error',message:'command_failed'}; if drag is
  // throwing server-side we would otherwise only see "the page reported
  // nothing" and go looking for the wrong bug.
  const errAt = () => c.events.filter((e) => e.t === 'error');
  let errSeen = 0;
  const drainErrors = (label) => {
    const all = errAt();
    for (const e of all.slice(errSeen)) {
      console.log('   [server error @' + label + '] ' + JSON.stringify(e).slice(0, 220));
    }
    errSeen = all.length;
  };

  // Collapse to one tab so nothing below measures the wrong page.
  {
    const list = (c.last('tabs') || { tabs: [] }).tabs;
    const keep = (list.find((x) => x.active) || list[0] || {}).id;
    for (const t of list) {
      if (t.pinned) await c.send({ t: 'tabPin', id: t.id, pinned: false });
      if (t.id !== keep) await c.send({ t: 'tabClose', id: t.id, force: true });
    }
    await c.sleep(900);
    await c.send({ t: 'dialogAnswer', accept: true });
    if (keep) await c.send({ t: 'tabSelect', id: keep });
    await c.sleep(400);
  }

  // ─── DRAG ────────────────────────────────────────────────────────────────
  await c.send({ t: 'navigate', url: page('/select') });
  await c.sleep(1800);

  // The page measures its own glyph box and reports it, so we aim at real
  // characters instead of at the paragraph's 40px padding.
  const geom = said('geom').split(',').map(Number);
  check('the text fixture reports its own glyph box',
    geom.length === 3 && Number.isFinite(geom[0]), 'y,x1,x2=' + said('geom'));
  const gy = Number.isFinite(geom[0]) ? geom[0] : 95;
  const gx1 = Number.isFinite(geom[1]) ? geom[1] : 50;
  const gx2 = Number.isFinite(geom[2]) ? geom[2] : 310;

  // A plain click first: if even a click cannot reach the glyphs, the problem is
  // coordinates or an overlay, not the drag primitive.
  fx.reset();
  await c.send({ t: 'click', x: gx1 + 20, y: gy, button: 'left', clickCount: 2, mods: {} });
  await c.sleep(900);
  check('double-click at the reported glyph box selects a word',
    said('sel').trim().length > 0, JSON.stringify(said('sel').slice(0, 60)));

  await c.send({ t: 'click', x: 900, y: 520, button: 'left', clickCount: 1, mods: {} });
  await c.sleep(300);
  fx.reset();
  await c.send({
    t: 'drag', from: { x: gx1, y: gy }, to: { x: gx2, y: gy }, button: 'left', mods: {},
  });
  await c.sleep(1200);
  drainErrors('drag-text');
  const dsel = said('sel').trim();
  check('mousedown→move→up selects a text range',
    dsel.split(/\s+/).filter(Boolean).length >= 2, JSON.stringify(dsel.slice(0, 60)));

  await c.send({ t: 'navigate', url: page('/slider') });
  await c.sleep(1800);
  fx.reset();
  await c.send({
    t: 'drag', from: { x: 70, y: 90 }, to: { x: 500, y: 90 }, button: 'left', mods: {},
  });
  await c.sleep(1200);
  drainErrors('drag-slider');
  const slid = Number(said('slider'));
  check('a drag moves a range slider', Number.isFinite(slid) && slid > 5,
    'value=' + said('slider'));

  // ─── BASIC AUTH ──────────────────────────────────────────────────────────
  let m = c.mark();
  // A brand-new ORIGIN. Measured: Chrome's basic-auth credential cache is keyed
  // by origin and outlives the persistent profile, so a fresh path or realm on
  // the usual port arrives already authenticated. See the '/secret' fixture note.
  const authFx = await fixture.start(fixture.freshPort());
  await c.send({ t: 'navigate', url: authFx.base + '/secret' });
  const areq = await c.waitFor('authRequired', 20000, m).catch(() => null);
  drainErrors('auth');
  check('a 401 raises an auth prompt', !!areq,
    areq ? JSON.stringify(areq).slice(0, 160) : 'no authRequired event');
  if (areq) {
    m = c.mark();
    await c.send({ t: 'authAnswer', accept: true, username: 'probeuser', password: 'probepass' });
    await c.sleep(3000);
    check('answering it is acknowledged',
      c.events.slice(m).some((e) => e.t === 'authDone'), '');
    check('the credentials get the protected page',
      /\/secret(\/|$)/.test(String((c.last('navState') || {}).url || '')),
      'url=' + String((c.last('navState') || {}).url || ''));
  }

  if (typeof authFx !== 'undefined' && authFx) {
    console.log('   server saw: ' + (authFx.report('secretHits') || '(nothing reached /secret)'));
    await authFx.close();
  }
  await c.close();
  await fx.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (results.length - failed) + '/' + results.length
    + ' passed, ' + failed + ' failed');
  process.exit(failed);
}

main().catch((e) => { console.error('probe blew up:', e); process.exit(1); });
