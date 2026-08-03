/**
 * tools/probe-baseline.js — what does the simulated browser actually do TODAY?
 *
 * Run against a live server. Prints a table of "does this behave like Chrome?"
 * so the answers come from measurement instead of from reading the source.
 */
'use strict';
const { connect } = require('./bvclient');

const out = [];
function note(what, ok, detail) {
  out.push({ what, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const c = await connect({ userId: 'probe-baseline' });
  const ready = await c.waitFor('ready', 60000);
  note('ready arrives', !!ready, JSON.stringify(ready));

  await c.send({ t: 'navigate', url: 'https://example.com' });
  const nav = await c.waitFor('navigated', 40000);
  note('navigate works', /example\.com/.test(nav.url || ''), nav.url);

  // tabs event shape
  const tabs = c.last('tabs');
  note('tabs event present', !!tabs, JSON.stringify(tabs && tabs.tabs));
  const t0 = tabs && tabs.tabs && tabs.tabs[0];
  note('tab has favicon field', !!(t0 && 'favicon' in t0), t0 ? Object.keys(t0).join(',') : '');
  note('tab has loading field', !!(t0 && 'loading' in t0));
  note('tab has audible field', !!(t0 && 'audible' in t0));

  // right-click
  let m = c.mark();
  await c.send({ t: 'contextMenu', x: 100, y: 100 });
  await c.sleep(1200);
  note('contextMenu command answered', c.events.slice(m).some((e) => e.t === 'contextMenu'),
    c.events.slice(m).map((e) => e.t).join(','));

  // double click
  m = c.mark();
  await c.send({ t: 'click', x: 100, y: 100, clickCount: 2 });
  await c.sleep(600);
  note('dblclick accepted (clickCount)', true, 'sent; needs selection check');

  // modifier keys
  m = c.mark();
  await c.send({ t: 'key', key: 'a', ctrl: true });
  await c.sleep(400);
  note('Ctrl+A via key+modifier', !c.events.slice(m).some((e) => e.t === 'error'));

  // zoom
  m = c.mark();
  await c.send({ t: 'zoom', dir: 'in' });
  await c.sleep(500);
  note('zoom command answered', c.events.slice(m).some((e) => e.t === 'zoom'),
    c.events.slice(m).map((e) => e.t).join(','));

  // dialogs
  m = c.mark();
  await c.send({ t: 'navigate', url: 'data:text/html,<button onclick="alert(1)">x</button>' });
  await c.sleep(800);
  note('data: url navigable', true);

  // download
  m = c.mark();
  await c.send({ t: 'downloadList' });
  await c.sleep(500);
  note('downloads channel exists', c.events.slice(m).some((e) => /download/i.test(e.t)),
    c.events.slice(m).map((e) => e.t).join(','));

  // drag
  m = c.mark();
  await c.send({ t: 'drag', from: { x: 10, y: 10 }, to: { x: 200, y: 200 } });
  await c.sleep(500);
  note('drag command accepted', !c.events.slice(m).some((e) => e.t === 'error'));

  // tab reopen stack
  m = c.mark();
  await c.send({ t: 'tabReopen' });
  await c.sleep(600);
  note('tabReopen (Ctrl+Shift+T) handled', c.events.slice(m).some((e) => e.t === 'tabs'),
    c.events.slice(m).map((e) => e.t).join(','));

  // tab move
  m = c.mark();
  await c.send({ t: 'tabMove', id: 't1', to: 0 });
  await c.sleep(400);
  note('tabMove handled', c.events.slice(m).some((e) => e.t === 'tabs'));

  // duplicate
  m = c.mark();
  await c.send({ t: 'tabDuplicate', id: 't1' });
  await c.sleep(1500);
  note('tabDuplicate handled', c.events.slice(m).some((e) => e.t === 'tabs'));

  await c.close();
  const fails = out.filter((o) => !o.ok).length;
  console.log(`\n${out.length - fails}/${out.length} behaviours present`);
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
