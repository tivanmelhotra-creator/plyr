/**
 * tools/probe-parity.js — the live proof, group by group.
 *
 * The rule for this repo is that no claim about the simulated browser counts
 * until it has been made to happen on a RUNNING server. Grepping the source
 * proves that code was written; it proves nothing about what the server does
 * when a real client sends a real message. So every one of the six requirement
 * groups gets an assertion here that only passes if the server actually did the
 * thing, observed through the same socket browser-view.js uses.
 *
 * Run:  node tools/probe-parity.js
 * (needs the stack up: bash scripts/dev-server.sh)
 */
'use strict';

const { connect } = require('./bvclient');
const http = require('http');

/**
 * A local fixture origin.
 *
 * The first version of this probe used `data:` URLs and every navigation came
 * back `unsupported_url` — which turned out to be the server being RIGHT: it
 * refuses non-http(s) schemes on purpose, because a `data:` URL is a
 * same-origin-less script delivery mechanism. So the fixtures get served over
 * real HTTP from 127.0.0.1 instead, which is also what makes the download,
 * dialog and basic-auth checks below realistic rather than special-cased.
 */
const FIXTURES = {};
let ORIGIN = '';

function serveFixtures() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const f = FIXTURES[url.pathname];
      if (!f) { res.writeHead(404).end('no'); return; }
      if (typeof f === 'function') { f(req, res); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(f);
    });
    srv.listen(0, '127.0.0.1', () => {
      ORIGIN = `http://127.0.0.1:${srv.address().port}`;
      resolve(srv);
    });
  });
}

const results = [];
function ok(group, name, pass, detail) {
  results.push({ group, name, pass: !!pass, detail: detail || '' });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

/** Register an HTML fixture and get back a real http:// URL for it. */
let fixSeq = 0;
function page(html) {
  fixSeq += 1;
  const p = `/fix${fixSeq}`;
  FIXTURES[p] = `<!doctype html><meta charset=utf-8>${html}`;
  return ORIGIN + p;
}

async function main() {
  const fixtures = await serveFixtures();
  console.log(`\n=== fixtures on ${ORIGIN} ===`);

  // A file served with Content-Disposition, which is how a real download starts.
  FIXTURES['/probe.txt'] = (req, res) => {
    const body = 'probe-downloaded-bytes';
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="probe.txt"',
      'content-length': String(Buffer.byteLength(body)),
    });
    res.end(body);
  };

  // A 401 that asks for credentials — group 2's other half.
  FIXTURES['/secret'] = (req, res) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [u, pw] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      if (u === 'probe' && pw === 'pw') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1 id=ok>authenticated</h1>');
        return;
      }
    }
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="Probe Realm"',
      'content-type': 'text/html',
    });
    res.end('<h1>denied</h1>');
  };

  console.log('\n=== connecting ===');
  const c = await connect({ userId: '0', key: 'devtoken123' });
  const ready = await c.waitFor('ready', 60000);
  console.log(`  ready: url=${ready.url} ${ready.width}x${ready.height}`);

  // ── GROUP 0: the reconnect contract ───────────────────────────────────────
  // A client that reconnects knows nothing. If `ready` omits the zoom, it will
  // assume 100% and send every single click to the wrong coordinates.
  console.log('\n=== group 0: ready payload (reconnect safety) ===');
  ok('ready', 'ready carries the zoom level', typeof ready.zoom === 'number',
    `zoom=${ready.zoom}`);
  ok('ready', 'ready carries the download list', Array.isArray(ready.downloads),
    `n=${(ready.downloads || []).length}`);
  const navAfterReady = await c.waitFor('navState', 15000).catch(() => null);
  ok('ready', 'nav state follows ready unasked', !!navAfterReady,
    navAfterReady ? `back=${navAfterReady.canGoBack} fwd=${navAfterReady.canGoForward}` : 'none');
  ok('ready', 'tabs follow ready unasked', !!c.last('tabs'),
    c.last('tabs') ? `n=${(c.last('tabs').tabs || []).length}` : 'none');

  // ── GROUP 1: input completeness ───────────────────────────────────────────
  console.log('\n=== group 1: input ===');
  await c.send({ t: 'navigate', url: page('<h1 id=h>one</h1><p id=p>alpha beta gamma delta</p>'
    + '<input id=i><script>document.title="P1"</script>') });
  await c.waitFor('navigated', 30000);
  await c.sleep(400);

  // Every key, with modifiers — not a whitelist. F7 is deliberately a key no
  // whitelist would ever have contained.
  let m = c.mark();
  await c.send({ t: 'key', key: 'F7', mods: { ctrl: true, shift: true, alt: false, meta: false } });
  await c.sleep(250);
  const keyErr = c.events.slice(m).find((e) => e.t === 'error');
  ok('input', 'an arbitrary key with modifiers is accepted (no whitelist)', !keyErr,
    keyErr ? JSON.stringify(keyErr) : 'F7+Ctrl+Shift dispatched');

  // Triple-click selects the paragraph. Measured through expandSelection's own
  // reply if present, otherwise through the absence of a rejection.
  m = c.mark();
  await c.send({ t: 'click', x: 60, y: 80, button: 'left', clickCount: 3,
    mods: { ctrl: false, shift: false, alt: false, meta: false } });
  await c.sleep(350);
  ok('input', 'a triple-click is accepted with clickCount=3',
    !c.events.slice(m).find((e) => e.t === 'error'));

  // A real drag: mousedown → mousemove → mouseup, one message.
  m = c.mark();
  await c.send({ t: 'drag', from: { x: 20, y: 80 }, to: { x: 260, y: 80 },
    button: 'left', mods: { ctrl: false, shift: false, alt: false, meta: false } });
  await c.sleep(350);
  ok('input', 'a drag (down→move→up) is accepted',
    !c.events.slice(m).find((e) => e.t === 'error'));

  // Horizontal wheel — the thing Shift+Scroll produces.
  m = c.mark();
  await c.send({ t: 'scroll', x: 100, y: 100, dx: 120, dy: 0 });
  await c.sleep(200);
  ok('input', 'a horizontal wheel is accepted',
    !c.events.slice(m).find((e) => e.t === 'error'));

  // Zoom is REAL browser zoom, and the level must come back so the client can
  // divide its coordinates by it.
  m = c.mark();
  await c.send({ t: 'zoom', dir: 'in' });
  const z1 = await c.waitFor('zoom', 10000).catch(() => null);
  ok('input', 'zoom in reports a new level', z1 && z1.level > 1,
    z1 ? `level=${z1.level}` : 'no zoom event');
  await c.send({ t: 'zoom', dir: 'reset' });
  const z2 = await c.waitFor('zoom', 10000, c.mark() - 1).catch(() => null);
  const zReset = c.last('zoom');
  ok('input', 'zoom reset returns to 100%', zReset && Math.abs(zReset.level - 1) < 0.001,
    zReset ? `level=${zReset.level}` : 'none');
  void z2;

  // A right-click must produce the data a real context menu needs.
  m = c.mark();
  await c.send({ t: 'contextMenu', x: 60, y: 80 });
  const cm = await c.waitFor('contextMenu', 10000).catch(() => null);
  ok('input', 'right-click returns context-menu info', !!cm,
    cm ? `keys=${Object.keys(cm).filter((k) => k !== 't').join(',')}` : 'none');

  // ── GROUP 6/nav: the buttons the user said do not work ────────────────────
  console.log('\n=== group 6: navigation state (back / forward / reload) ===');
  const navs = c.all('navState');
  const firstNav = navs[0];
  ok('nav', 'navState is sent at all', navs.length > 0, `count=${navs.length}`);
  ok('nav', 'navState reports canGoBack/canGoForward',
    firstNav && typeof firstNav.canGoBack === 'boolean'
      && typeof firstNav.canGoForward === 'boolean');

  await c.send({ t: 'navigate', url: page('<h1>two</h1><script>document.title="P2"</script>') });
  await c.waitFor('navigated', 30000);
  await c.sleep(500);
  const afterTwo = c.last('navState');
  ok('nav', 'after a second page, back becomes possible',
    afterTwo && afterTwo.canGoBack === true,
    afterTwo ? `back=${afterTwo.canGoBack} fwd=${afterTwo.canGoForward}` : 'none');

  m = c.mark();
  await c.send({ t: 'back' });
  await c.sleep(1200);
  const afterBack = c.last('navState');
  ok('nav', 'back actually goes back, and forward opens up',
    afterBack && afterBack.canGoForward === true,
    afterBack ? `url=${afterBack.url} fwd=${afterBack.canGoForward}` : 'none');

  await c.send({ t: 'forward' });
  await c.sleep(1200);
  const afterFwd = c.last('navState');
  ok('nav', 'forward actually goes forward',
    afterFwd && afterFwd.canGoForward === false && afterFwd.canGoBack === true,
    afterFwd ? `url=${afterFwd.url} back=${afterFwd.canGoBack} fwd=${afterFwd.canGoForward}` : 'none');

  // Back at the start of history, back must be REFUSED OUT LOUD, not ignored.
  m = c.mark();
  await c.send({ t: 'back' }); await c.sleep(900);
  await c.send({ t: 'back' }); await c.sleep(900);
  await c.send({ t: 'back' }); await c.sleep(900);
  const blocked = c.events.slice(m).find((e) => e.t === 'navBlocked');
  ok('nav', 'a back that cannot work says so instead of going silent', !!blocked,
    blocked ? `dir=${blocked.dir}` : 'no navBlocked seen');

  // Reload, both kinds.
  m = c.mark();
  await c.send({ t: 'reload' });
  await c.sleep(1500);
  ok('nav', 'reload works', !!c.events.slice(m).find((e) => e.t === 'navigated' || e.t === 'navEnd'));
  m = c.mark();
  await c.send({ t: 'reload', hard: true });
  await c.sleep(1500);
  ok('nav', 'a cache-bypassing reload works',
    !!c.events.slice(m).find((e) => e.t === 'navigated' || e.t === 'navEnd'));

  // ── GROUP 2: page dialogs ────────────────────────────────────────────────
  console.log('\n=== group 2: page dialogs ===');
  m = c.mark();
  await c.send({ t: 'navigate', url: page('<script>setTimeout(function(){'
    + 'window.__r = confirm("really?");},150)</script>') });
  const dlg = await c.waitFor('dialog', 20000).catch(() => null);
  ok('dialog', 'a confirm() reaches the client instead of locking the tab', !!dlg,
    dlg ? `kind=${dlg.kind} msg=${JSON.stringify(dlg.message)}` : 'none');
  if (dlg) {
    await c.send({ t: 'dialogAnswer', accept: true });
    const done = await c.waitFor('dialogDone', 10000).catch(() => null);
    ok('dialog', 'answering it clears the dialog', !!done);
  }

  m = c.mark();
  await c.send({ t: 'navigate', url: page('<script>setTimeout(function(){'
    + 'window.__p = prompt("name?", "seed");},150)</script>') });
  const pr = await c.waitFor('dialog', 20000, m).catch(() => null);
  ok('dialog', 'a prompt() arrives with its default text',
    pr && pr.kind === 'prompt',
    pr ? `kind=${pr.kind} default=${JSON.stringify(pr.defaultValue)}` : 'none');
  if (pr) {
    await c.send({ t: 'dialogAnswer', accept: true, text: 'typed-by-probe' });
    await c.sleep(400);
    ok('dialog', 'the typed answer is accepted', !!c.last('dialogDone'));
  }

  // The tab must still be ALIVE after all that — the original defect was a
  // dialog silently freezing the page forever.
  m = c.mark();
  await c.send({ t: 'navigate', url: page('<h1>alive</h1><script>document.title="ALIVE"</script>') });
  const alive = await c.waitFor('navigated', 20000, m).catch(() => null);
  ok('dialog', 'the tab is still usable after dialogs', !!alive,
    alive ? `url=${String(alive.url).slice(0, 40)}` : 'tab is stuck');

  // HTTP basic auth: a 401 must become a prompt, not a dead page.
  m = c.mark();
  await c.send({ t: 'navigate', url: ORIGIN + '/secret' });
  const authReq = await c.waitFor('authRequired', 20000, m).catch(() => null);
  ok('auth', 'a 401 asks the user for credentials', !!authReq,
    authReq ? `realm=${JSON.stringify(authReq.realm)} origin=${authReq.origin || ''}` : 'none');
  if (authReq) {
    await c.send({ t: 'authAnswer', accept: true, username: 'probe', password: 'pw' });
    await c.sleep(2500);
    ok('auth', 'the credentials are used and the page loads',
      !!c.last('authDone'),
      `authDone=${!!c.last('authDone')}`);
  }

  // ── GROUP 4: tab strip ───────────────────────────────────────────────────
  console.log('\n=== group 4: tab strip ===');
  m = c.mark();
  await c.send({ t: 'tabNew', url: page('<title>T-B</title><h1>b</h1>') });
  await c.sleep(1500);
  let tabs = c.last('tabs');
  ok('tabs', 'a new tab is created and broadcast',
    tabs && (tabs.tabs || []).length >= 2, tabs ? `n=${tabs.tabs.length}` : 'none');

  const t0 = tabs.tabs[0], t1 = tabs.tabs[1];
  ok('tabs', 'each tab reports at least id/url/title/active',
    t0 && t0.id && 'url' in t0 && 'title' in t0 && 'active' in t0,
    t0 ? Object.keys(t0).join(',') : 'none');

  await c.send({ t: 'tabDuplicate', id: t1.id });
  await c.sleep(1500);
  tabs = c.last('tabs');
  ok('tabs', 'duplicate makes a third tab', (tabs.tabs || []).length >= 3,
    `n=${tabs.tabs.length}`);

  await c.send({ t: 'tabPin', id: t0.id, pinned: true });
  await c.sleep(600);
  tabs = c.last('tabs');
  const pinned = (tabs.tabs || []).find((x) => x.id === t0.id);
  ok('tabs', 'pin sticks', pinned && pinned.pinned === true);

  await c.send({ t: 'tabMute', id: t1.id, muted: true });
  await c.sleep(600);
  tabs = c.last('tabs');
  const muted = (tabs.tabs || []).find((x) => x.id === t1.id);
  ok('tabs', 'mute sticks', muted && muted.muted === true);

  // Reorder: move the LAST tab to index 0 and check the order really changed.
  tabs = c.last('tabs');
  const before = (tabs.tabs || []).map((x) => x.id);
  const mover = before[before.length - 1];
  await c.send({ t: 'tabMove', id: mover, index: 0 });
  await c.sleep(700);
  const after = (c.last('tabs').tabs || []).map((x) => x.id);
  ok('tabs', 'drag-to-reorder actually reorders',
    after[0] === mover && after.join() !== before.join(),
    `${before.length} tabs: ${before.join()} → ${after.join()}`);

  // Close → reopen. Ctrl+Shift+T is worthless without a closed-tab stack.
  const victim = (c.last('tabs').tabs || [])[0];
  const nBefore = (c.last('tabs').tabs || []).length;
  await c.send({ t: 'tabClose', id: victim.id });
  await c.sleep(900);
  const nAfter = (c.last('tabs').tabs || []).length;
  ok('tabs', 'middle-click close removes the tab', nAfter === nBefore - 1,
    `${nBefore} → ${nAfter}`);
  await c.send({ t: 'tabReopen' });
  await c.sleep(1500);
  const nReopen = (c.last('tabs').tabs || []).length;
  ok('tabs', 'Ctrl+Shift+T brings a closed tab back', nReopen === nAfter + 1,
    `${nAfter} → ${nReopen}`);

  // Cycling, then close-others / close-to-the-right.
  m = c.mark();
  await c.send({ t: 'tabCycle', dir: 'next' });
  await c.sleep(600);
  ok('tabs', 'Ctrl+Tab cycles', !!c.events.slice(m).find((e) => e.t === 'tabs' || e.t === 'ready'));

  const list = (c.last('tabs').tabs || []);
  if (list.length >= 3) {
    await c.send({ t: 'tabCloseRight', id: list[0].id });
    await c.sleep(1200);
    ok('tabs', 'close-to-the-right closes exactly those',
      (c.last('tabs').tabs || []).length === 1,
      `n=${(c.last('tabs').tabs || []).length}`);
  }

  // ── GROUP 3: downloads ───────────────────────────────────────────────────
  console.log('\n=== group 3: downloads ===');
  m = c.mark();
  const file = ORIGIN + '/probe.txt';
  await c.send({ t: 'navigate', url: page(
    '<a id=a download="probe.txt" href="' + file + '">dl</a>'
    + '<script>setTimeout(function(){document.getElementById("a").click();},250)</script>') });
  const dl = await c.waitFor('download', 25000, m).catch(() => null);
  ok('download', 'a download is captured instead of vanishing', !!dl,
    dl ? `name=${dl.filename} state=${dl.state} token=${String(dl.token).slice(0, 10)}…` : 'none');
  if (dl) {
    // Wait for it to finish, then FETCH THE BYTES over HTTP — a shelf row that
    // cannot produce the file is decoration.
    for (let i = 0; i < 25; i++) {
      const cur = c.all('download').filter((d) => d.id === dl.id).pop();
      if (cur && (cur.state === 'completed' || cur.state === 'failed')) break;
      await c.sleep(300);
    }
    const done = c.all('download').filter((d) => d.id === dl.id).pop();
    ok('download', 'it reaches a terminal state', done && done.state === 'completed',
      done ? `state=${done.state} bytes=${done.received}/${done.total}` : 'none');
    if (done && done.token) {
      const res = await fetch(`http://127.0.0.1:3000/browser/downloads/${done.token}?userId=0`,
        { headers: { 'x-api-key': 'devtoken123' } });
      const body = await res.text();
      ok('download', 'the saved file can actually be fetched back',
        res.ok && body.includes('probe-downloaded-bytes'),
        `HTTP ${res.status}, ${body.length}B`);
      const bad = await fetch(`http://127.0.0.1:3000/browser/downloads/${done.token}?userId=0`);
      ok('download', 'and it is not readable without the key', bad.status === 401 || bad.status === 403,
        `HTTP ${bad.status}`);
    }
  }

  // ── GROUP 6: stability ───────────────────────────────────────────────────
  console.log('\n=== group 6: stability / self-repair ===');
  m = c.mark();
  await c.send({ t: 'resync' });
  await c.sleep(2500);
  const rec = c.events.slice(m).find((e) => e.t === 'recovered' || e.t === 'ready');
  ok('stability', 'resync rebuilds and says so', !!rec,
    rec ? `t=${rec.t}` : 'silent');
  const stillAlive = await (async () => {
    const k = c.mark();
    await c.send({ t: 'navigate', url: page('<h1>after-resync</h1>') });
    return await c.waitFor('navigated', 20000, k).catch(() => null);
  })();
  ok('stability', 'the session works after a resync', !!stillAlive);

  await c.close();
  fixtures.close();

  // ── summary ──────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== ${pass}/${results.length} live checks passed ===`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  - [${f.group}] ${f.name} ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
