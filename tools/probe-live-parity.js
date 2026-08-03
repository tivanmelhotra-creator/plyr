/**
 * tools/probe-live-parity.js — LIVE proof, against a RUNNING server, that the
 * simulated browser behaves like real Chromium.
 *
 * The rule in this repo is that a claim is only true if it was measured. Unit
 * tests read source; this reads BEHAVIOUR. Every check below drives the same
 * WebSocket protocol public/js/browser-view.js drives, and then asserts on what
 * the server actually sent back — not on what the code says it would send.
 *
 *   node tools/probe-live-parity.js
 *
 * Exit code is the number of failures, so CI can gate on it.
 */
'use strict';

const { connect } = require('./bvclient');
const fixture = require('./fixture-server');

/** Set by main() once the fixture origin is listening. */
let BASE = '';

const results = [];

/**
 * Print each result the moment it is known, as well as collecting it.
 *
 * MEASURED 2026-08-03: this probe used to buffer everything and print only in
 * its summary at the end. A run then hung, and the log contained exactly one
 * line — the fixture's origin. There was no way to tell WHICH of 68 checks it
 * had stopped on, so diagnosing it meant bisecting a two-minute run by hand.
 * A tool that measures a browser's liveness must not itself go silent while it
 * works; that is the same "dead but connected" failure the product is forbidden
 * from having. Streaming also means a run killed by a timeout still reports
 * everything it managed to prove.
 */
function record(pass, name, detail) {
  results.push({ pass, name, detail: detail || '' });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
}
function ok(name, detail) { record(true, name, detail); }
function bad(name, detail) { record(false, name, detail); }
function check(name, cond, detail) { record(!!cond, name, detail); }

/** Announce which group is starting, so a hang names the group it hung in. */
function group(label) { process.stdout.write('\n--- ' + label + ' ---\n'); }

/**
 * MEASURED 2026-08-03: Chrome refuses a TOP-LEVEL navigation to a `data:` URL.
 * An earlier version of this probe used data: pages and every one of them landed
 * on `chrome-error://chromewebdata/`, so ~20 checks were measuring an error page
 * and blaming the product. Real browsers get tested against a real origin.
 */
function page(path) { return BASE + path; }

/** Read what the fixture page reported about itself. */
let FX = null;
function said(key) { return FX ? String(FX.report(key) ?? '') : ''; }

/**
 * Collapse the session back to ONE tab, and make that tab the active one.
 *
 * MEASURED 2026-08-03: without this, three checks failed for reasons that had
 * nothing to do with the thing being checked. The beforeunload group leaves an
 * extra guarded tab behind, so the basic-auth group afterwards was answering
 * `navState` for `/leave` instead of `/secret`, and the download click was
 * landing on whichever tab happened to be active. That is state pollution in
 * the PROBE, not a product bug — a probe that measures the wrong tab reports
 * fiction in both directions.
 */
async function soloTab(c) {
  const list = (c.last('tabs') || { tabs: [] }).tabs;
  for (const t of list) {
    if (t.pinned) await c.send({ t: 'tabPin', id: t.id, pinned: false });
  }
  const keep = (list.find((x) => x.active) || list[0] || {}).id;
  if (!keep) return;
  // force: this is teardown, so a beforeunload guard must not be able to veto it.
  for (const t of list) {
    if (t.id !== keep) await c.send({ t: 'tabClose', id: t.id, force: true });
  }
  await c.sleep(900);
  // A guard can still have raised a dialog; answer it so the tab is not left locked.
  await c.send({ t: 'dialogAnswer', accept: true });
  await c.send({ t: 'tabSelect', id: keep });
  await c.sleep(400);
}

async function main() {
  const fx = await fixture.start(3111);
  FX = fx;
  BASE = fx.base;
  console.log('fixture origin: ' + BASE);

  const c = await connect({ userId: '0', key: 'devtoken123' });
  const ready = await c.waitFor('ready', 60000);

  // ---- group 0: the handshake tells a reconnecting client everything ----
  check('ready carries the zoom level', typeof ready.zoom === 'number',
    'zoom=' + JSON.stringify(ready.zoom));
  check('ready carries the saved downloads', Array.isArray(ready.downloads),
    'downloads=' + JSON.stringify(ready.downloads));
  const firstNav = await c.waitFor('navState', 15000).catch(() => null);
  check('ready is followed by a navState', !!firstNav,
    firstNav ? JSON.stringify(firstNav) : 'never arrived');
  check('navState derives canGoBack/canGoForward',
    !!firstNav && typeof firstNav.canGoBack === 'boolean'
      && typeof firstNav.canGoForward === 'boolean',
    firstNav ? `canGoBack=${firstNav.canGoBack} canGoForward=${firstNav.canGoForward}` : '');
  const firstTabs = c.last('tabs');
  check('ready is followed by a tab list', !!firstTabs && Array.isArray(firstTabs.tabs),
    firstTabs ? firstTabs.tabs.length + ' tab(s)' : 'no tabs event');

  // ---- group 1: navigation actually navigates, and back/forward work ----
  let m = c.mark();
  await c.send({ t: 'navigate', url: page('/one') });
  const nav1 = await c.waitFor('navigated', 30000, m).catch(() => null);
  check('navigate reaches a page', !!nav1, nav1 ? nav1.url.slice(0, 40) : 'no navigated event');
  // navEnd lands in the `finally`, a moment after `navigated`. A spinner that
  // never stops is exactly the "dazed and confused" bug, so wait for it.
  await c.waitFor('navEnd', 15000, m).catch(() => null);
  const start1 = c.all('navStart').length;
  const end1 = c.all('navEnd').length;
  check('every navigation announces a start AND an end (no stuck spinner)',
    start1 > 0 && end1 > 0 && end1 >= start1 - 1,
    `navStart=${start1} navEnd=${end1}`);

  m = c.mark();
  await c.send({ t: 'navigate', url: page('/two') });
  await c.waitFor('navigated', 30000, m).catch(() => null);
  await c.sleep(400);
  const afterTwo = c.last('navState');
  check('canGoBack becomes true after a second page', !!afterTwo && afterTwo.canGoBack === true,
    afterTwo ? JSON.stringify(afterTwo) : '');

  m = c.mark();
  await c.send({ t: 'back' });
  await c.sleep(1500);
  const backNav = c.events.slice(m).filter((e) => e.t === 'navigated').pop();
  check('back actually goes back', !!backNav && /\/one$/.test(String(backNav.url || '')),
    backNav ? String(backNav.url).slice(0, 60) : 'no navigated after back');
  const stAfterBack = c.last('navState');
  check('canGoForward becomes true after going back',
    !!stAfterBack && stAfterBack.canGoForward === true,
    stAfterBack ? JSON.stringify(stAfterBack) : '');

  m = c.mark();
  await c.send({ t: 'forward' });
  await c.sleep(1500);
  const fwdNav = c.events.slice(m).filter((e) => e.t === 'navigated').pop();
  check('forward actually goes forward',
    !!fwdNav && /\/two$/.test(String(fwdNav.url || '')),
    fwdNav ? String(fwdNav.url).slice(0, 60) : 'no navigated after forward');

  m = c.mark();
  await c.send({ t: 'reload' });
  await c.sleep(1500);
  check('reload re-runs the page',
    c.events.slice(m).some((e) => e.t === 'navigated' || e.t === 'navEnd'),
    c.events.slice(m).map((e) => e.t).filter((x, i, a) => a.indexOf(x) === i).join(','));

  // ---- group 1b: zoom is real browser zoom ----
  m = c.mark();
  await c.send({ t: 'zoom', dir: 'in' });
  const z1 = await c.waitFor('zoom', 8000, m).catch(() => null);
  check('Ctrl+ zooms in', !!z1 && z1.level > 1, z1 ? 'level=' + z1.level : 'no zoom event');
  m = c.mark();
  await c.send({ t: 'zoom', dir: 'reset' });
  const z2 = await c.waitFor('zoom', 8000, m).catch(() => null);
  check('Ctrl+0 resets zoom', !!z2 && Math.abs(z2.level - 1) < 0.001,
    z2 ? 'level=' + z2.level : 'no zoom event');

  // ---- group 1c: the full keyboard, not a whitelist ----
  // A whitelist of 9 named keys used to be the whole keyboard. These are the
  // keys such a list would silently eat: F-keys, punctuation, navigation keys,
  // and anything wearing a modifier.
  await c.send({ t: 'navigate', url: page('/keys') });
  await c.sleep(1500);
  fx.reset();
  await c.send({ t: 'click', x: 200, y: 30, button: 'left', clickCount: 1, mods: {} });
  await c.sleep(300);
  const exotic = ['F7', 'Home', 'End', 'PageDown', 'Insert', ';', '[', '/', '`', 'F1', 'Delete'];
  for (const k of exotic) await c.send({ t: 'key', key: k, mods: {} });
  await c.send({ t: 'key', key: 'a', mods: { ctrl: true } });
  await c.send({ t: 'key', key: 'ArrowRight', mods: { shift: true, alt: true } });
  await c.send({ t: 'key', key: 'F5', mods: { ctrl: true, shift: true } });
  await c.sleep(1200);
  const seen = said('keys');
  check('function keys reach the page (F7, F1)', /F7/.test(seen) && /F1/.test(seen),
    seen.slice(0, 200));
  check('punctuation keys reach the page (; [ / `)',
    /;/.test(seen) && /\[/.test(seen) && seen.includes('/') && seen.includes('`'),
    seen.slice(0, 200));
  check('navigation keys reach the page (Home/End/PageDown/Insert/Delete)',
    /Home/.test(seen) && /End/.test(seen) && /PageDown/.test(seen)
      && /Insert/.test(seen) && /Delete/.test(seen),
    seen.slice(0, 200));
  check('Ctrl+letter arrives WITH its ctrl flag', /\bCa\b|\|Ca\||^Ca\|/.test('|' + seen + '|'),
    seen.slice(0, 200));
  check('a two-modifier combo arrives with BOTH flags',
    /CSF5|SCF5/.test(seen) || /SAArrowRight|ASArrowRight/.test(seen),
    seen.slice(0, 200));

  // ---- group 1d/1e: dblclick = word, triple = paragraph, drag = range ----
  // The page reports its OWN selection, so this measures what Chrome actually
  // selected rather than what we hoped clickCount would mean.
  await c.send({ t: 'navigate', url: page('/select') });
  await c.sleep(1500);

  // Ask the page where its glyphs are instead of guessing. See the long comment
  // on the '/select' fixture: a hard-coded y=55 aimed at the paragraph's 40px
  // padding, so a perfectly working drag selected nothing and looked like a bug
  // in drag() for far longer than it should have.
  const geom = (said('geom') || '').split(',').map(Number);
  const gy = Number.isFinite(geom[0]) && geom[0] > 0 ? geom[0] : 95;
  const gx1 = Number.isFinite(geom[1]) && geom[1] > 0 ? geom[1] : 50;
  const gx2 = Number.isFinite(geom[2]) && geom[2] > gx1 ? geom[2] : 310;
  check('the text fixture reports its own glyph box',
    Number.isFinite(geom[0]) && geom.length === 3, 'y,x1,x2=' + said('geom'));

  fx.reset();
  await c.send({ t: 'click', x: gx1 + 20, y: gy, button: 'left', clickCount: 2, mods: {} });
  await c.sleep(900);
  const dblSel = said('sel').trim();
  check('double-click selects exactly one word',
    dblSel.length > 0 && dblSel.split(/\s+/).length === 1, JSON.stringify(dblSel));

  fx.reset();
  await c.send({ t: 'click', x: gx1 + 20, y: gy, button: 'left', clickCount: 3, mods: {} });
  await c.sleep(900);
  const triSel = said('sel').trim();
  check('triple-click selects the whole paragraph',
    triSel.split(/\s+/).length > 3, JSON.stringify(triSel.slice(0, 90)));

  // Clear, then drag: mousedown → mousemove* → mouseup must extend a selection.
  await c.send({ t: 'click', x: 900, y: 500, button: 'left', clickCount: 1, mods: {} });
  await c.sleep(300);
  fx.reset();
  await c.send({
    t: 'drag', from: { x: gx1, y: gy }, to: { x: gx2, y: gy }, button: 'left', mods: {},
  });
  await c.sleep(900);
  const dragSel = said('sel').trim();
  check('mousedown→move→up selects a text range',
    dragSel.split(/\s+/).length >= 2, JSON.stringify(dragSel.slice(0, 90)));

  // A drag must also work a slider — the same primitive, a different widget.
  await c.send({ t: 'navigate', url: page('/slider') });
  await c.sleep(1400);
  fx.reset();
  await c.send({ t: 'drag', from: { x: 70, y: 90 }, to: { x: 500, y: 90 }, button: 'left', mods: {} });
  await c.sleep(900);
  const slid = Number(said('slider'));
  check('a drag moves a range slider', Number.isFinite(slid) && slid > 5,
    'value=' + said('slider'));

  // ---- group 1e2: wheel scrolls, Shift+wheel scrolls SIDEWAYS ----
  await c.send({ t: 'navigate', url: page('/scroll') });
  await c.sleep(1400);
  fx.reset();
  await c.send({ t: 'scroll', x: 200, y: 150, dy: 400, dx: 0 });
  await c.sleep(700);
  const vScroll = said('scroll');
  check('the wheel scrolls vertically',
    !!vScroll && Number(vScroll.split(',')[1]) > 0, 'scrollLeft,scrollTop=' + vScroll);
  fx.reset();
  await c.send({ t: 'scroll', x: 200, y: 150, dy: 0, dx: 400 });
  await c.sleep(700);
  const hScroll = said('scroll');
  check('Shift+wheel scrolls HORIZONTALLY (dx is honoured)',
    !!hScroll && Number(hScroll.split(',')[0]) > 0, 'scrollLeft,scrollTop=' + hScroll);

  // ---- group 1e3: zoom is REAL browser zoom, so the viewport shrinks ----
  await c.send({ t: 'zoom', dir: 'reset' });
  await c.sleep(400);
  await c.send({ t: 'navigate', url: page('/zoom') });
  await c.sleep(1400);
  const vw100 = Number(said('vw'));
  await c.send({ t: 'zoom', dir: 'in' });
  await c.send({ t: 'zoom', dir: 'in' });
  await c.send({ t: 'zoom', dir: 'in' });
  await c.sleep(1200);
  const vwZoom = Number(said('vw'));
  check('zooming in SHRINKS the CSS viewport (real zoom, not a fake scale)',
    Number.isFinite(vw100) && Number.isFinite(vwZoom) && vwZoom < vw100,
    `innerWidth ${vw100} → ${vwZoom}`);
  await c.send({ t: 'zoom', dir: 'reset' });
  await c.sleep(900);
  const vwBack = Number(said('vw'));
  check('Ctrl+0 restores the original viewport', Math.abs(vwBack - vw100) <= 2,
    `innerWidth ${vwZoom} → ${vwBack} (was ${vw100})`);

  // ---- group 1f: a real context menu, with a real hit target ----
  await c.send({ t: 'navigate', url: page('/link') });
  await c.sleep(1000);
  m = c.mark();
  await c.send({ t: 'contextMenu', x: 40, y: 30 });
  const cm = await c.waitFor('contextMenu', 10000, m).catch(() => null);
  check('right-click reports a context menu', !!cm, cm ? JSON.stringify(cm).slice(0, 200) : 'none');
  check('the context menu knows it hit a link',
    !!cm && /\/two/.test(JSON.stringify(cm)),
    cm ? JSON.stringify(cm).slice(0, 200) : '');

  // ---- group 2: page dialogs surface instead of locking the tab ----
  m = c.mark();
  await c.send({ t: 'navigate', url: page('/alert') });
  const dlg = await c.waitFor('dialog', 15000, m).catch(() => null);
  check('an alert() is reported, not swallowed', !!dlg,
    dlg ? JSON.stringify(dlg).slice(0, 160) : 'no dialog event');
  check('the dialog carries its kind and message',
    !!dlg && dlg.kind === 'alert' && /hello from the page/.test(String(dlg.message)),
    dlg ? `kind=${dlg.kind} msg=${dlg.message}` : '');
  if (dlg) {
    m = c.mark();
    await c.send({ t: 'dialogAnswer', accept: true });
    const done = await c.waitFor('dialogDone', 10000, m).catch(() => null);
    check('answering the dialog releases the tab', !!done, done ? 'dialogDone' : 'tab still locked');
  } else {
    bad('answering the dialog releases the tab', 'no dialog to answer');
  }

  // The tab must still be alive after a dialog — that was the original bug.
  m = c.mark();
  await c.send({ t: 'navigate', url: page('/three') });
  const alive = await c.waitFor('navigated', 20000, m).catch(() => null);
  check('the tab still navigates after a dialog', !!alive,
    alive ? 'navigated' : 'TAB LOCKED — the original bug is back');

  // prompt() must round-trip the typed text.
  m = c.mark();
  await c.send({ t: 'navigate', url: page('/prompt') });
  const pdlg = await c.waitFor('dialog', 15000, m).catch(() => null);
  check('a prompt() is reported as a prompt',
    !!pdlg && pdlg.kind === 'prompt', pdlg ? 'kind=' + pdlg.kind : 'none');
  if (pdlg) {
    fx.reset();
    await c.send({ t: 'dialogAnswer', accept: true, text: 'Kaveh' });
    await c.sleep(1400);
    check('the text typed into a prompt reaches the page', said('prompt') === 'Kaveh',
      JSON.stringify(said('prompt')));
  } else {
    bad('the text typed into a prompt reaches the page', 'no prompt dialog');
  }

  // confirm(): Cancel must return false, not undefined and not true.
  m = c.mark();
  fx.reset();
  await c.send({ t: 'navigate', url: page('/confirm') });
  const cdlg = await c.waitFor('dialog', 15000, m).catch(() => null);
  check('a confirm() is reported as a confirm', !!cdlg && cdlg.kind === 'confirm',
    cdlg ? 'kind=' + cdlg.kind : 'none');
  if (cdlg) {
    await c.send({ t: 'dialogAnswer', accept: false });
    await c.sleep(1400);
    check('pressing Cancel makes confirm() return false', said('confirm') === 'false',
      JSON.stringify(said('confirm')));
  } else {
    bad('pressing Cancel makes confirm() return false', 'no confirm dialog');
  }

  // ---- group 2b: beforeunload ASKS instead of silently closing ----
  m = c.mark();
  await c.send({ t: 'tabNew', url: page('/leave') });
  await c.sleep(2500);
  const tabsNow = c.last('tabs');
  const guarded = tabsNow && tabsNow.tabs[tabsNow.tabs.length - 1];
  check('a new tab opened for the beforeunload test', !!guarded && tabsNow.tabs.length >= 2,
    tabsNow ? tabsNow.tabs.length + ' tabs' : 'no tabs');
  if (guarded) {
    // Interact first: Chrome only honours beforeunload after a user gesture.
    await c.send({ t: 'click', x: 100, y: 40, button: 'left', clickCount: 1, mods: {} });
    await c.sleep(300);
    m = c.mark();
    await c.send({ t: 'tabClose', id: guarded.id });
    await c.sleep(2500);
    const asked = c.events.slice(m).find((e) => e.t === 'dialog' || e.t === 'tabCloseCancelled');
    const stillThere = (c.last('tabs') || { tabs: [] }).tabs.some((x) => x.id === guarded.id);
    check('closing a guarded tab asks first (or is reported), never silent',
      !!asked || stillThere,
      asked ? 'event=' + asked.t : (stillThere ? 'tab kept' : 'CLOSED SILENTLY'));
    // clean up whatever state we are in
    if (c.events.slice(m).some((e) => e.t === 'dialog')) {
      await c.send({ t: 'dialogAnswer', accept: true });
      await c.sleep(800);
    }
  }

  // ---- group 2c: HTTP basic auth (401) asks instead of showing a 401 page ----
  // Back to one tab first: the beforeunload group above deliberately leaves a
  // guarded tab open, and auth is a per-tab event.
  await soloTab(c);
  m = c.mark();
  // A brand-new ORIGIN, on a port this Chrome profile has never talked to.
  //
  // Not merely a new path or realm: measured, Chrome's basic-auth credential
  // cache is keyed by origin and survives a server restart because the profile
  // is persistent, so `/secret/<nonce>` on the usual port arrives already
  // authenticated and no challenge is ever issued. See the long note on the
  // '/secret' fixture handler. A second fixture on a random high port is the
  // only thing that reliably re-challenges.
  const authFx = await fixture.start(fixture.freshPort());
  await c.send({ t: 'navigate', url: authFx.base + '/secret' });
  const areq = await c.waitFor('authRequired', 20000, m).catch(() => null);
  check('a 401 raises an auth prompt instead of a bare error page', !!areq,
    areq ? JSON.stringify(areq).slice(0, 200) : 'no authRequired event');
  check('the auth prompt names the origin and the realm',
    !!areq && /127\.0\.0\.1/.test(JSON.stringify(areq)) && /Probe Realm/.test(JSON.stringify(areq)),
    areq ? JSON.stringify(areq).slice(0, 200) : '');
  if (areq) {
    m = c.mark();
    // The wire field names are `username`/`password` — what browser-view.js
    // sends. An earlier version of this probe said `user`/`pass` and then blamed
    // the product for not logging in.
    await c.send({
      t: 'authAnswer', accept: true, username: 'probeuser', password: 'probepass',
    });
    await c.sleep(3000);
    const adone = c.events.slice(m).find((e) => e.t === 'authDone');
    check('answering the auth prompt is acknowledged', !!adone, adone ? 'authDone' : 'silent');
    const url = String((c.last('navState') || {}).url || '');
    check('the correct credentials actually get the protected page',
      /\/secret(\/|$)/.test(url), 'url=' + url);
  } else {
    bad('answering the auth prompt is acknowledged', 'no authRequired');
    bad('the correct credentials actually get the protected page', 'no authRequired');
  }
  // Prove the challenge was genuine rather than a credential-cache hit. If this
  // ever says `pre-auth`, the four checks above are measuring nothing and the
  // fresh-origin trick has stopped working — not a product regression.
  check('the browser really was challenged (not answering from cache)',
    /anonymous/.test(String(authFx.report('secretHits') || '')),
    'server saw: ' + (authFx.report('secretHits') || '(no request reached /secret)'));

  // Leave the throwaway origin behind before closing it.
  //
  // MEASURED 2026-08-03: skipping this hung the NEXT run of this probe. The
  // session persists its tab strip, so the active tab was saved as
  // `http://127.0.0.1:<throwaway-port>/secret` — an origin that stops existing
  // the moment `authFx.close()` runs. The following run then restored a tab
  // pointing at a dead host. The product survives that correctly (measured with
  // tools/probe-open-timing.js: `ready` in 322ms, tab kept as pending), but the
  // probe does not get to leave landmines for itself: a test that poisons the
  // state it runs in reports fiction on its next run. Park on the durable
  // fixture instead.
  await c.send({ t: 'navigate', url: page('/one') });
  await c.sleep(1200);
  await authFx.close();

  // ---- group 3: downloads are captured and fetchable ----
  // `page.on('download')` is bound PER TAB, so the click has to happen on a tab
  // this session owns and is watching. One tab removes all doubt.
  await soloTab(c);
  m = c.mark();
  await c.send({ t: 'navigate', url: page('/download') });
  const dlEv = await c.waitFor('download', 20000, m).catch(() => null);
  check('a download is captured', !!dlEv, dlEv ? JSON.stringify(dlEv).slice(0, 200) : 'no download event');
  // Chrome reports inProgress first; the shelf needs the completed event with
  // its token. Poll rather than sleep a fixed amount.
  for (let i = 0; i < 40 && !c.all('download').some((e) => e.state === 'completed'); i += 1) {
    await c.sleep(250);
  }
  const dlEvents = c.all('download');
  const completed = dlEvents.filter((e) => e.state === 'completed').pop();
  check('the download reports a completed state', !!completed,
    dlEvents.map((e) => e.state).join('→') || 'none');
  check('the completed download has a fetch token',
    !!completed && typeof completed.token === 'string' && /^dl_/.test(completed.token),
    completed ? String(completed.token) : '');
  check('the download reports its file name',
    !!completed && /probe\.txt/.test(String(completed.name)),
    completed ? String(completed.name) : '');
  if (completed && completed.token) {
    const res = await fetch(
      `http://127.0.0.1:3000/browser/downloads/${encodeURIComponent(completed.token)}?userId=0`,
      { headers: { 'x-api-key': 'devtoken123' } },
    ).catch((e) => ({ ok: false, status: String(e) }));
    const body = res.ok ? await res.text() : '';
    check('the token really serves the bytes over HTTP',
      res.ok && /downloaded bytes/.test(body), `status=${res.status} body=${JSON.stringify(body.slice(0, 40))}`);
    const noKey = await fetch(
      `http://127.0.0.1:3000/browser/downloads/${encodeURIComponent(completed.token)}?userId=0`,
    ).catch(() => ({ status: 0 }));
    check('the download endpoint refuses an unauthenticated fetch',
      noKey.status === 401 || noKey.status === 403, 'status=' + noKey.status);
  } else {
    bad('the token really serves the bytes over HTTP', 'no token');
    bad('the download endpoint refuses an unauthenticated fetch', 'no token');
  }

  // ---- group 4: the tab strip has a real model behind it ----
  const before = (c.last('tabs') || { tabs: [] }).tabs.length;
  await c.send({ t: 'tabNew', url: page('/title-a') });
  await c.sleep(1800);
  await c.send({ t: 'tabNew', url: page('/title-b') });
  await c.sleep(1800);
  let ts = c.last('tabs');
  check('tabNew adds tabs', ts && ts.tabs.length >= before + 2,
    `${before} → ${ts ? ts.tabs.length : '?'}`);
  check('each tab reports a title', ts && ts.tabs.every((x) => 'title' in x),
    ts ? ts.tabs.map((x) => x.title).join(' | ').slice(0, 120) : '');
  // tabList() OMITS a falsy flag rather than sending `false` — a deliberate wire
  // saving, and the client reads `!!tab.loading`. So the check is that the strip
  // model can EXPRESS each state, proved by observing it set at least once.
  check('each tab has a stable id and an active flag',
    ts && ts.tabs.every((x) => typeof x.id === 'string' && 'active' in x),
    ts ? JSON.stringify(ts.tabs[0]) : '');
  check('exactly one tab is active', ts && ts.tabs.filter((x) => x.active).length === 1,
    ts ? ts.tabs.filter((x) => x.active).length + ' active' : '');
  const sawLoading = c.all('tabs').some((e) => e.tabs.some((x) => x.loading));
  check('the strip reports loading at some point (spinner has data)', sawLoading,
    sawLoading ? 'observed' : 'never observed a loading tab');
  const sawFav = c.all('tabs').some((e) => e.tabs.some((x) => x.favicon));
  check('the strip reports a favicon when the page has one', sawFav,
    sawFav ? 'observed' : 'no favicon seen (fixture has none — informational)');

  // reorder
  ts = c.last('tabs');
  if (ts && ts.tabs.length >= 3) {
    const moving = ts.tabs[ts.tabs.length - 1].id;
    await c.send({ t: 'tabMove', id: moving, index: 0 });
    await c.sleep(700);
    const after = c.last('tabs');
    check('tabMove reorders the strip', !!after && after.tabs[0].id === moving,
      after ? after.tabs.map((x) => x.id).join(',') : '');
  } else {
    bad('tabMove reorders the strip', 'not enough tabs');
  }

  // pin / duplicate / mute
  ts = c.last('tabs');
  const pinTarget = ts.tabs[ts.tabs.length - 1].id;
  await c.send({ t: 'tabPin', id: pinTarget, pinned: true });
  await c.sleep(600);
  let after = c.last('tabs');
  check('tabPin pins a tab', !!after && after.tabs.some((x) => x.id === pinTarget && x.pinned),
    after ? JSON.stringify(after.tabs.map((x) => [x.id, x.pinned])) : '');
  await c.send({ t: 'tabMute', id: pinTarget, muted: true });
  await c.sleep(600);
  after = c.last('tabs');
  check('tabMute mutes a tab', !!after && after.tabs.some((x) => x.id === pinTarget && x.muted), '');

  const nBeforeDup = c.last('tabs').tabs.length;
  await c.send({ t: 'tabDuplicate', id: pinTarget });
  await c.sleep(2000);
  check('tabDuplicate makes another tab', c.last('tabs').tabs.length > nBeforeDup,
    `${nBeforeDup} → ${c.last('tabs').tabs.length}`);

  // cycle
  const activeBefore = (c.last('tabs').tabs.find((x) => x.active) || {}).id;
  await c.send({ t: 'tabCycle', dir: 'next' });
  await c.sleep(700);
  const activeAfter = (c.last('tabs').tabs.find((x) => x.active) || {}).id;
  check('Ctrl+Tab moves the active tab', activeBefore !== activeAfter,
    `${activeBefore} → ${activeAfter}`);

  // closed-tab stack (Ctrl+Shift+T)
  ts = c.last('tabs');
  const victim = ts.tabs.find((x) => !x.pinned && !x.active) || ts.tabs[ts.tabs.length - 1];
  const nBeforeClose = ts.tabs.length;
  await c.send({ t: 'tabClose', id: victim.id, force: true });
  await c.sleep(1200);
  const closedTo = c.last('tabs').tabs.length;
  check('tabClose closes a tab', closedTo < nBeforeClose, `${nBeforeClose} → ${closedTo}`);
  await c.send({ t: 'tabReopen' });
  await c.sleep(2200);
  const reopened = c.last('tabs').tabs.length;
  check('Ctrl+Shift+T reopens the last closed tab', reopened > closedTo,
    `${closedTo} → ${reopened}`);

  // close others / close to the right
  // `tabReopen` above is asynchronous — the restored tab's page has to load
  // before the strip settles. Re-read the strip immediately before acting on it,
  // otherwise this closes a set that no longer matches what is on screen.
  await c.sleep(800);
  ts = c.last('tabs');
  if (ts.tabs.length >= 3) {
    const keep = ts.tabs[0].id;
    await c.send({ t: 'tabCloseOthers', id: keep });
    await c.sleep(2500);
    const left = c.last('tabs').tabs;
    // Chrome keeps pinned tabs when you say "Close other tabs" — that survivor is
    // correct behaviour, not a leak, so it is allowed here explicitly.
    check('Close other tabs leaves only that tab and the pinned ones',
      left.every((x) => x.id === keep || x.pinned) && left.some((x) => x.id === keep),
      left.map((x) => `${x.id}${x.pinned ? '(pin)' : ''}`).join(','));
  } else {
    bad('Close other tabs leaves only that tab and the pinned ones', 'not enough tabs');
  }

  // ---- group 6: stability — resync brings a session back, never "dead but connected"
  await soloTab(c);
  m = c.mark();
  await c.send({ t: 'resync' });
  // MEASURED: resync has two legal outcomes and BOTH are healthy. If the page is
  // alive and only the screencast died it rebinds CDP and emits `recovered`; if
  // the page is gone it runs a full `recover()`, which emits `recovering` and
  // then `recovered`. Demanding `recovered` alone made a correct fast path look
  // like a failure. What must never happen is silence — that is the
  // "dead but connected" state the user complained about.
  const rec = await c.waitFor('recovered', 60000, m).catch(() => null);
  const spoke = !!rec || c.events.slice(m).some((e) => e.t === 'recovering');
  check('resync always reports back (never dead-but-connected)', spoke,
    rec ? 'recovered' : (spoke ? 'recovering' : 'SILENT'));
  // The 'recovering' notice is what keeps the UI honest instead of "dead but
  // connected". It may be emitted synchronously with the command, so look at the
  // whole run rather than only after the mark.
  const sawRecovering = c.all('recovering').length > 0;
  check('recovery announces itself so the UI is never dead-but-connected',
    sawRecovering, c.all('recovering').length + ' recovering event(s)');
  m = c.mark();
  await c.send({ t: 'navigate', url: page('/one') });
  const post = await c.waitFor('navigated', 30000, m).catch(() => null);
  check('the session is usable after a resync', !!post, post ? 'navigated' : 'unusable');

  // ---- screencast is alive ----
  check('the screencast delivers frames', c.frames > 0, c.frames + ' frames');

  await c.close();
  await fx.close();

  // ---- report ----
  // Every line was already streamed as it happened, so the summary only needs
  // to repeat what went wrong and give the score.
  const fails = results.filter((r) => !r.pass);
  console.log('\n=== SUMMARY ===');
  for (const r of fails) {
    console.log(`FAIL  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - fails.length}/${results.length} passed, ${fails.length} failed`);
  process.exit(fails.length);
}

main().catch((e) => {
  console.error('PROBE CRASHED:', e && e.stack || e);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed before the crash`);
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`FAIL  ${r.name} — ${r.detail}`);
  }
  process.exit(99);
});
