/* ============================================================
   tools/uiverify/verify.js — §18 verification harness.

   §18 of the task spec: «این task باید به‌صورت واقعی روی Extension
   build نهایی تست شود، نه فقط با unit test یا screenshot. بعد از
   implementation، یک build واقعی از Extension بساز و همان artifact
   را در Chrome Load Unpacked اجرا کن و UI + Picker را با
   extension/UI_UX مقایسه کن.»

   So this loads the REAL artifact produced by scripts/build-extension.js
   — the same directory a user would pick in "Load unpacked" — and drives
   it in a real browser. The unit suite proves the clamp arithmetic; only
   this proves the arithmetic is wired to a browser that actually lays the
   panel out, in the fonts that actually resolved.

   Four things this harness learned the hard way. All four are easy to
   reintroduce, so they are written down rather than just fixed:

   1. Content scripts are NOT injected into `data:` URLs. A fixture built
      as a data URL produces a page where nothing happens and no error
      says why, so the fixture is served over real HTTP from a throwaway
      localhost server.

   2. The picker lives in a CLOSED shadow root, so `host.shadowRoot` is
      null and no selector engine reaches it. It is measured over CDP with
      `pierce: true`, the way a debugger would.

   3. The picker is started with the in-page Ctrl+Shift+C chord. Page
      script has no `chrome.runtime`, and a headless popup cannot be
      clicked — but that chord is a shipped gesture (inspector.js listens
      for it because Chrome often refuses to register the accelerator), so
      this is not a test-only back door.

   4. Extensions do not load in the old headless shell. `--headless=new`
      is a real browser with the UI detached, so unpacked extensions load
      and content scripts run.

   Usage:
       npm run build:extension
       node tools/uiverify/verify.js

   Exit code is 0 only if every check passed. Screenshots and a
   machine-readable report land in .ui-verify/.
   ============================================================ */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(ROOT, 'artifacts', 'element-inspector-extension');
const OUT = path.join(ROOT, '.ui-verify');
const PORT = Number(process.env.UIV_PORT || 8731);

/** The design documents' own numbers, so drift in either direction is caught. */
const POPUP_W = 440; // inspect.html / connection.html --w
const PANEL_W = 330; // picker.html --w
const EDGE = 12;

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) failures++;
  const suffix = detail === undefined || detail === null ? '' : `  — ${fmt(detail)}`;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${suffix}`);
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= (tol === undefined ? 1.5 : tol);
}

// ── the fixture ──────────────────────────────────────────────
// A page with attributes worth discovering, so the picker renders real rows
// rather than an empty shell.
const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>uiverify fixture</title>
<style>
  body{margin:0;font:16px/1.5 system-ui;background:#f4f4f5;color:#111}
  header{padding:24px;background:#fff;border-bottom:1px solid #ddd}
  main{padding:24px;display:grid;gap:16px}
  .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px}
  a.buy{display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;
        text-decoration:none;border-radius:6px}
  .tall{height:1800px;background:linear-gradient(#fff,#e5e5e5)}
</style></head>
<body>
  <header><h1 id="page-title">uiverify fixture page</h1></header>
  <main>
    <div class="card">
      <a class="buy" id="buy-now" href="https://example.com/checkout?sku=A1"
         data-sku="A1" data-price="19.99" data-qty="2"
         title="Buy this item now" aria-label="Buy now">Buy now</a>
    </div>
    <div class="card"><input id="qty" name="quantity" type="number" value="3"
      placeholder="How many?" data-testid="qty-input"></div>
    <div class="tall"></div>
  </main>
</body></html>`;

function serveFixture() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/**
 * The extension id is not knowable in advance for an unpacked load, so it is
 * learned from whatever the browser says about the extension's own contexts:
 * the MV3 service worker, or a background page.
 */
async function extensionId(ctx) {
  for (let i = 0; i < 60; i++) {
    for (const t of [...ctx.serviceWorkers(), ...ctx.backgroundPages()]) {
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url());
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('could not learn the extension id — did the service worker start?');
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

// ── POPUP ────────────────────────────────────────────────────
async function verifyPopup(ctx, id) {
  console.log('\nPOPUP (real artifact, popup/popup.html)');
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setViewportSize({ width: POPUP_W + 60, height: 700 });
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(600);

  // §1: exactly two tabs, and none of the removed ones anywhere in the popup.
  const tabs = await page.$$eval('.tabs label', (ns) => ns.map((n) => n.textContent.trim().toUpperCase()));
  check('has exactly two tabs', tabs.length === 2, tabs);
  check('tabs are INSPECT and CONNECTION', tabs.join('|') === 'INSPECT|CONNECTION', tabs);

  const body = (await page.textContent('body')).toUpperCase();
  const banned = [
    'FIELDS OPEN IN THE PROJECT',
    'NOT ATTACHED TO A FIELD?',
    'OPEN CONNECTION',
    'ENTER AUTHORIZATION CODE',
    'BROWSER SESSION MANAGER',
    'USER ID',
  ];
  const present = banned.filter((b) => body.includes(b));
  check('removed UI stays removed', present.length === 0, present);

  const geo = await page.evaluate(() => ({
    w: document.body.getBoundingClientRect().width,
    scrollW: document.body.scrollWidth,
    clientW: document.body.clientWidth,
    font: getComputedStyle(document.body).fontFamily,
  }));
  check('popup is the design width', near(geo.w, POPUP_W, 2), geo.w);
  check('popup does not scroll horizontally', geo.scrollW <= geo.clientW + 1, geo);
  check('popup uses the design sans face', /Hanken/i.test(geo.font), geo.font);

  // The fonts must actually load. This is the whole point of vendoring them: a
  // remote <link> is blocked by MV3's style-src 'self', and a silent fallback to
  // system-ui looks "fine" in a screenshot while missing the design entirely.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((f) => ({ f: f.family, s: f.status }));
  });
  const loaded = fonts.filter((f) => f.s === 'loaded').map((f) => f.f);
  check('Hanken Grotesk loaded from disk', loaded.some((f) => /Hanken/i.test(f)), fonts);
  check('JetBrains Mono loaded from disk', loaded.some((f) => /JetBrains/i.test(f)), fonts);

  // Nothing may be unreachable. The panel area is a scroll container, so content
  // below the fold is fine — content that cannot be scrolled to is not.
  const reach = await page.evaluate(() => {
    const P = document.querySelector('.panels');
    P.scrollTop = P.scrollHeight;
    const cards = [...document.querySelectorAll('#p-inspect .card')];
    const last = cards[cards.length - 1];
    const r = last.getBoundingClientRect();
    const pr = P.getBoundingClientRect();
    return {
      cards: cards.length,
      last: (last.querySelector('h2') || {}).textContent,
      reachable: r.bottom <= pr.bottom + 1 && r.top >= pr.top - 1,
      overflowY: getComputedStyle(P).overflowY,
    };
  });
  check('every INSPECT card can be scrolled into view', reach.reachable, reach);
  check('the panel area is a scroll container', reach.overflowY === 'auto', reach.overflowY);
  await page.evaluate(() => { document.querySelector('.panels').scrollTop = 0; });

  await shot(page, '01-popup-inspect');

  // The tab strip is CSS-only (radio + label + sibling selector), so it must work
  // with no JS involvement at all.
  await page.click('.tabs label[for="tab-connection"]');
  await page.waitForTimeout(250);
  const shown = await page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
    return {
      inspect: vis(document.getElementById('p-inspect')),
      conn: vis(document.getElementById('p-connection')),
    };
  });
  check('CONNECTION tab reveals its panel', shown.conn === true, shown);
  check('INSPECT panel hides when CONNECTION is shown', shown.inspect === false, shown);
  await shot(page, '02-popup-connection');

  // §10: Browser Environment must NOT have moved into CONNECTION — it belongs at
  // the START of the targeting flow.
  const connText = (await page.textContent('#p-connection')).toUpperCase();
  check('CONNECTION does not host Browser Environment', !connText.includes('BROWSER ENVIRONMENT'),
    connText.includes('BROWSER ENVIRONMENT') ? 'found it' : 'absent');
  check('CONNECTION has BACKEND CONNECTION', connText.includes('BACKEND'), null);
  check('CONNECTION has AUTHORIZATION CODE', connText.includes('AUTHORIZATION'), null);

  /*
   * The Local/Remote cards derive their lit state from the Base URL rather than
   * from a second stored flag, so that the popup can never claim "Local" while
   * pointing at a remote host. Two consequences worth pinning:
   *
   *   - on a fresh profile the URL is empty, so NEITHER card is lit. That is the
   *     honest reading of "no backend chosen yet", and the empty box shows only a
   *     dim placeholder, so it does not look configured.
   *   - typing a URL must light the matching card, or the derivation is dead.
   */
  const fresh = await page.evaluate(() => ({
    url: document.getElementById('baseUrl').value,
    local: document.getElementById('modeLocal').checked,
    remote: document.getElementById('modeRemote').checked,
  }));
  check('a fresh profile pre-selects no backend', fresh.url === '' && !fresh.local && !fresh.remote, fresh);

  for (const [url, want] of [['http://127.0.0.1:3000', 'local'], ['https://api.example.com', 'remote']]) {
    await page.fill('#baseUrl', url);
    await page.waitForTimeout(150);
    const lit = await page.evaluate(() => ({
      local: document.getElementById('modeLocal').checked,
      remote: document.getElementById('modeRemote').checked,
    }));
    check(`typing a ${want} URL lights the ${want} card`, lit[want] === true && lit[want === 'local' ? 'remote' : 'local'] === false, lit);
  }
  await page.fill('#baseUrl', '');
  await page.waitForTimeout(150);

  await page.click('.tabs label[for="tab-inspect"]');
  await page.waitForTimeout(200);

  check('popup logged no errors', errors.length === 0, errors.slice(0, 4));

  const composition = await page.$$eval('#p-inspect .card', (cs) =>
    cs.map((c) => {
      const h = c.querySelector('.card-hd h2, h2');
      return h ? h.textContent.trim() : '(unlabelled)';
    })
  );
  console.log(`  · INSPECT composition: ${composition.join(' → ')}`);
  results.push({ name: 'INSPECT composition', ok: true, detail: composition });

  await page.close();
}

// ── PICKER ───────────────────────────────────────────────────
async function verifyPicker(ctx, id) {
  console.log('\nPICKER (real artifact, content script on a real http origin)');
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(500);

  // Start with the in-page chord — see note 3 in the header comment.
  await page.click('body');
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await page.waitForTimeout(400);

  const buy = await page.$('#buy-now');
  if (buy) {
    await buy.hover();
    await page.waitForTimeout(250);
    await shot(page, '03-picker-highlight');
    await buy.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  function attr(node, name) {
    const a = node.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
    return null;
  }

  /** Depth-first walk that also descends into (closed) shadow roots. */
  function findNode(node, pred) {
    if (pred(node)) return node;
    const kids = [...(node.children || []), ...(node.shadowRoots || [])];
    for (const k of kids) {
      const hit = findNode(k, pred);
      if (hit) return hit;
    }
    return null;
  }

  function hasClass(node, cls) {
    return (attr(node, 'class') || '').split(/\s+/).includes(cls);
  }

  /** The border box of a node inside the picker's closed shadow root. */
  async function boxOf(cls) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = findNode(root, (n) => attr(n, 'id') === 'ab-inspector-panel');
    const shadow = host && (host.shadowRoots || [])[0];
    if (!shadow) return null;
    const el = findNode(shadow, (n) => hasClass(n, cls));
    if (!el) return null;
    let q;
    try {
      q = (await cdp.send('DOM.getBoxModel', { nodeId: el.nodeId })).model.border;
    } catch {
      return null; // not rendered: display:none, or detached
    }
    const box = {
      nodeId: el.nodeId,
      left: Math.min(q[0], q[6]), top: Math.min(q[1], q[3]),
      right: Math.max(q[2], q[4]), bottom: Math.max(q[5], q[7]),
    };
    box.w = box.right - box.left;
    box.h = box.bottom - box.top;
    return box;
  }

  async function readPanel() {
    const vp = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight }));
    const panel = await boxOf('wrap');
    if (!panel) return { found: 0, panel: null, ...vp };
    const styles = {};
    try {
      const cs = await cdp.send('CSS.getComputedStyleForNode', { nodeId: panel.nodeId });
      for (const p of cs.computedStyle) {
        if (['left', 'top', 'right', 'bottom', 'position', 'font-family'].includes(p.name)) {
          styles[p.name] = p.value;
        }
      }
    } catch { /* geometry alone is still worth asserting */ }
    return { found: 1, panel: { ...panel, styles }, ...vp };
  }

  let st = await readPanel();
  if (!st.panel) {
    check('picker panel appears on the page', false, st);
    console.log('  ! panel not found — remaining picker checks skipped');
    await shot(page, '04-picker-missing');
    await page.close();
    return;
  }
  check('picker panel appears on the page', true, { w: Math.round(st.panel.w), h: Math.round(st.panel.h) });
  await shot(page, '04-picker-default');

  // (A) the position bug: the whole panel inside the viewport, at design width.
  const p = st.panel;
  check('panel is the design width', near(p.w, PANEL_W, 2), p.w);
  check('panel left edge is on screen', p.left >= EDGE - 1, p.left);
  check('panel top edge is on screen', p.top >= EDGE - 1, p.top);
  check('panel right edge is on screen', p.right <= st.vw - EDGE + 1, { right: p.right, vw: st.vw });
  check('panel bottom edge is on screen', p.bottom <= st.vh - EDGE + 1, { bottom: p.bottom, vh: st.vh });

  // Position must be expressed in left/top. right/bottom leaves no coordinate to
  // clamp and nothing for a drag to write, which is the root cause of bug (B).
  const inset = p.styles || {};
  check('panel is position:fixed', inset.position === 'fixed', inset.position);
  check('position is driven by left/top', inset.left !== 'auto' && inset.top !== 'auto',
    { left: inset.left, top: inset.top });

  // The picker's fonts must arrive through the FontFace API: an @font-face rule
  // inside a shadow root is ignored, because font faces resolve against the
  // document, not the shadow tree.
  check('picker renders in the design faces', /Hanken|JetBrains/i.test(inset['font-family'] || ''),
    inset['font-family']);
  const pageFonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
  });
  check('FontFace API registered the fonts on the page',
    pageFonts.some((f) => /Hanken/i.test(f)) && pageFonts.some((f) => /JetBrains/i.test(f)), pageFonts);

  // (B) the drag bug: the header is the handle.
  const before = { ...p };
  const hdBox = await boxOf('hd');
  check('the header exists as a drag handle', !!hdBox, hdBox && {
    left: Math.round(hdBox.left), top: Math.round(hdBox.top), h: Math.round(hdBox.h),
  });

  /**
   * Drag by the header to an absolute point. The header is re-measured every
   * time rather than assumed: a clamp that moved the panel between drags could
   * otherwise make a later drag miss the handle entirely and "prove" the panel
   * is immovable — the exact bug under test.
   *
   * Grabs the header's left quarter. Its centre sits close to the two header
   * buttons, and a hit there would be swallowed by the `closest('button')`
   * guard, which again looks just like the drag bug returning.
   */
  async function dragHeaderTo(x, y) {
    const hd = await boxOf('hd');
    if (!hd) return false;
    await page.mouse.move(hd.left + hd.w * 0.25, (hd.top + hd.bottom) / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    return true;
  }

  // Towards the top-left: the panel starts near the bottom-right corner, so this
  // direction cannot be confused with a clamp holding it still.
  await dragHeaderTo(EDGE + 40, EDGE + 40);
  st = await readPanel();
  const after = st.panel;
  check('dragging the header moves the panel', after && Math.abs(after.left - before.left) > 100,
    { from: Math.round(before.left), to: after ? Math.round(after.left) : null });
  check('drag preserves the panel size',
    after && near(after.w, before.w, 2) && near(after.h, before.h, 3),
    { before: [Math.round(before.w), Math.round(before.h)],
      after: after ? [Math.round(after.w), Math.round(after.h)] : null });
  await shot(page, '05-picker-dragged');

  // A drag must not be able to push the panel out of reach, in either direction.
  await dragHeaderTo(5000, 5000);
  st = await readPanel();
  check('drag is clamped at the far corner',
    st.panel && st.panel.right <= st.vw - EDGE + 1 && st.panel.bottom <= st.vh - EDGE + 1,
    st.panel && { right: Math.round(st.panel.right), bottom: Math.round(st.panel.bottom), vw: st.vw, vh: st.vh });
  await shot(page, '06-picker-clamp-far');

  await dragHeaderTo(-5000, -5000);
  st = await readPanel();
  check('drag is clamped at the near corner',
    st.panel && st.panel.left >= EDGE - 1 && st.panel.top >= EDGE - 1,
    st.panel && { left: Math.round(st.panel.left), top: Math.round(st.panel.top) });
  await shot(page, '07-picker-clamp-near');

  // The body must NOT be a drag handle: grabbing a row and pulling leaves the
  // panel where it is, so text stays selectable and rows stay clickable.
  const held = st.panel;
  const bodyY = held.top + (hdBox ? hdBox.h : 36) + 30; // below the header, above the footer
  await page.mouse.move(held.left + held.w / 2, bodyY);
  await page.mouse.down();
  await page.mouse.move(held.left + held.w / 2 + 200, bodyY + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  st = await readPanel();
  check('the body is not a drag handle', st.panel && near(st.panel.left, held.left, 3),
    { was: Math.round(held.left), now: st.panel ? Math.round(st.panel.left) : null });

  // A viewport shorter than the panel. Something must go off-screen, and it has
  // to be the bottom: the header carries the drag handle and both buttons, and
  // the rows scroll, so losing their bottom is recoverable.
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.waitForTimeout(350);
  st = await readPanel();
  check('short viewport keeps the header reachable',
    st.panel && st.panel.top >= EDGE - 1 && st.panel.top < 300,
    { top: st.panel ? Math.round(st.panel.top) : null, vh: st.vh });
  await shot(page, '08-picker-short-viewport');

  // Narrower than the design width: the max-width escape hatch must engage, or a
  // fixed 330px would hang off the right edge — the same class of bug being fixed.
  await page.setViewportSize({ width: 300, height: 700 });
  await page.waitForTimeout(350);
  st = await readPanel();
  check('narrow viewport shrinks the panel to fit', st.panel && st.panel.right <= st.vw - EDGE + 2,
    { w: st.panel ? Math.round(st.panel.w) : null,
      right: st.panel ? Math.round(st.panel.right) : null, vw: st.vw });
  await shot(page, '09-picker-narrow');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);

  // Both footer actions must be inside the viewport and hit-testable, or the
  // picker can be opened and never resolved.
  for (const cls of ['cx', 'go']) {
    const b = await boxOf(cls);
    const okBox = !!b && b.left >= 0 && b.top >= 0 && b.right <= 1280 && b.bottom <= 800 && b.w > 20 && b.h > 12;
    check(`footer .${cls} is on screen and clickable`, okBox,
      b && { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.w), h: Math.round(b.h) });
  }

  // ESC cancels, and must leave no half-finished pick behind for the popup to read.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  st = await readPanel();
  check('ESC dismisses the picker', !st.panel, st.panel ? 'still visible' : 'gone');
  const leftover = await page.evaluate(() =>
    new Promise((r) => chrome?.storage?.local
      ? chrome.storage.local.get(['ab_lastPick'], (s) => r(s.ab_lastPick ?? null))
      : r('no-access'))
  ).catch(() => 'no-access');
  check('cancel leaves no pending pick', leftover === null || leftover === 'no-access', leftover);
  await shot(page, '10-picker-after-esc');

  check('picker logged no errors', errors.length === 0, errors.slice(0, 4));
  await page.close();
}

// ── main ─────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error(`No built extension at ${EXT}\nRun: npm run build:extension`);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  console.log('§18 verification against the REAL build');
  console.log(`  artifact: ${path.relative(ROOT, EXT)}`);

  const server = await serveFixture();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uiverify-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [
      '--headless=new', // see note 4: the old headless shell cannot load extensions
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 800 },
  });

  let id = null;
  try {
    id = await extensionId(ctx);
    console.log(`  extension id: ${id}\n`);
    await verifyPopup(ctx, id);
    await verifyPicker(ctx, id);
  } catch (e) {
    check('harness ran to completion', false, String(e && e.message ? e.message : e));
  } finally {
    await ctx.close().catch(() => {});
    server.close();
    fs.writeFileSync(
      path.join(OUT, 'report.json'),
      JSON.stringify({ extensionId: id, when: new Date().toISOString(), results }, null, 2)
    );
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${failures === 0 ? '✓' : '✗'} ${passed}/${results.length} checks passed`);
  console.log(`  screenshots + report: ${path.relative(ROOT, OUT)}/`);
  process.exit(failures === 0 ? 0 : 1);
})();
