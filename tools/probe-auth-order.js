#!/usr/bin/env node
/**
 * tools/probe-auth-order.js — why does basic auth pass alone and fail in sequence?
 *
 * tools/probe-focus.js drives the auth group on a fresh session and it PASSES.
 * The full parity probe drives the identical group, with an identical fresh
 * nonce, and it FAILS with "no authRequired event". The only difference is what
 * happened before it, so this reproduces the full probe's ordering — the
 * beforeunload group, then soloTab(), then auth — and nothing else. Two minutes
 * of full-probe feedback becomes about twenty seconds.
 *
 * It asks auth TWICE: once after the beforeunload sequence and once after a
 * plain navigation. Whichever of those fails names the culprit.
 *
 *   DISPLAY=:99 node tools/probe-auth-order.js
 */
'use strict';

const { connect } = require('./bvclient');
const fixture = require('./fixture-server');

async function main() {
  const fx = await fixture.start(3111);
  const page = (p) => fx.base + p;
  console.log('fixture origin: ' + fx.base + '\n');

  const c = await connect({ userId: '0', key: 'devtoken123' });
  await c.waitFor('ready', 60000);

  const tabIds = () => (c.last('tabs') || { tabs: [] }).tabs.map(
    (t) => t.id + (t.active ? '*' : '') + (t.pinned ? '(pin)' : ''),
  ).join(',');

  /** Exactly the full probe's teardown between groups. */
  async function soloTab() {
    const list = (c.last('tabs') || { tabs: [] }).tabs;
    for (const t of list) {
      if (t.pinned) await c.send({ t: 'tabPin', id: t.id, pinned: false });
    }
    const keep = (list.find((x) => x.active) || list[0] || {}).id;
    if (!keep) return;
    for (const t of list) {
      if (t.id !== keep) await c.send({ t: 'tabClose', id: t.id, force: true });
    }
    await c.sleep(900);
    await c.send({ t: 'dialogAnswer', accept: true });
    await c.send({ t: 'tabSelect', id: keep });
    await c.sleep(400);
  }

  /** Ask for a 401 on a path this profile has never seen, and report honestly. */
  async function tryAuth(label) {
    const url = page('/secret/' + label + '-' + Date.now().toString(36));
    const m = c.mark();
    await c.send({ t: 'navigate', url });
    const areq = await c.waitFor('authRequired', 15000, m).catch(() => null);
    const nav = String((c.last('navState') || {}).url || '');
    const errs = c.events.slice(m).filter((e) => e.t === 'error')
      .map((e) => e.message).join('/');
    console.log((areq ? 'PASS  ' : 'FAIL  ') + label
      + '  challenge=' + (areq ? 'yes' : 'NO')
      + '  tabs=[' + tabIds() + ']'
      + '  navState=' + (nav || '(none)')
      + (errs ? '  errors=' + errs : ''));
    // What the SERVER saw for this request settles whether the browser was even
    // challenged, or answered from its credential cache without asking.
    console.log('        server saw: ' + (fx.report('secretHits') || '(no request reached /secret!)'));
    if (areq) {
      await c.send({ t: 'authAnswer', accept: true, username: 'probeuser', password: 'probepass' });
      await c.sleep(2500);
    }
    return !!areq;
  }

  console.log('tabs at start: [' + tabIds() + ']');

  // A: the control. Auth on a plain session, like probe-focus.js does.
  await soloTab();
  const a = await tryAuth('A-after-soloTab-only');

  // B: dialogs first (alert/prompt/confirm), as the full probe does.
  await c.send({ t: 'navigate', url: page('/confirm') });
  await c.sleep(1500);
  await c.send({ t: 'dialogAnswer', accept: false });
  await c.sleep(1200);
  await soloTab();
  const b = await tryAuth('B-after-a-confirm-dialog');

  // C: the full probe's beforeunload group verbatim, then auth.
  let m = c.mark();
  await c.send({ t: 'tabNew', url: page('/leave') });
  await c.sleep(2500);
  const tabsNow = c.last('tabs');
  const guarded = tabsNow && tabsNow.tabs[tabsNow.tabs.length - 1];
  if (guarded) {
    await c.send({ t: 'click', x: 100, y: 40, button: 'left', clickCount: 1, mods: {} });
    await c.sleep(300);
    m = c.mark();
    await c.send({ t: 'tabClose', id: guarded.id });
    await c.sleep(2500);
    if (c.events.slice(m).some((e) => e.t === 'dialog')) {
      await c.send({ t: 'dialogAnswer', accept: true });
      await c.sleep(800);
    }
  }
  await soloTab();
  const cc = await tryAuth('C-after-beforeunload-group');

  await c.close();
  await fx.close();
  const fails = [a, b, cc].filter((x) => !x).length;
  console.log('\n' + (3 - fails) + '/3 got a challenge');
  process.exit(fails);
}

main().catch((e) => { console.error('probe blew up:', e); process.exit(1); });
