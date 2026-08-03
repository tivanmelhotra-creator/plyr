/**
 * tools/probe-dbl2.js — double-click word selection, hypothesis by hypothesis.
 *
 * Known so far: cc=[1,2] selects nothing, cc=[1,2,3] selects the paragraph,
 * headless AND headed, and Playwright's own dblclick behaves identically. So
 * the sequence is not the problem. In Blink, clickCount 2 selects the closest
 * word on mousePRESSED, so the selection should exist mid-sequence.
 *
 * H1. The word IS selected on mousePressed(cc=2) and then cleared by something.
 * H2. Identical timestamps make Blink reject the double-click.
 * H3. The point must be strictly inside a text node (not the padding/line-gap).
 * H4. clickCount must keep rising on the SAME coordinates without a move.
 * H5. Selection needs the document to be focused / body clickable.
 *
 * Run: node tools/probe-dbl2.js
 */
const { chromium } = require('playwright');

const out = [];
const log = (label, val) => { out.push([label, val]); console.log(label.padEnd(52), JSON.stringify(val)); };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 500 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.setContent(
    '<!doctype html><meta charset=utf-8>'
    + '<p id=p style="width:420px;font:16px/1.5 system-ui;margin:20px">'
    + 'Alpha beta gamma delta epsilon zeta eta theta.</p>'
    + '<script>window.sel=function(){return String(window.getSelection()).trim();}</script>');

  // Aim at the exact centre of the word "gamma" using a Range rect, so H3
  // (clicking the line gap instead of the glyphs) cannot be the explanation.
  const rect = await page.evaluate(() => {
    const t = document.getElementById('p').firstChild;
    const i = t.textContent.indexOf('gamma');
    const r = document.createRange();
    r.setStart(t, i); r.setEnd(t, i + 5);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  });
  const cx = Math.round(rect.x);
  const cy = Math.round(rect.y);
  log('target rect for the word "gamma"', rect);

  const reset = () => page.evaluate(() => window.getSelection().removeAllRanges());
  const sel = () => page.evaluate(() => window.sel());
  const ev = (type, extra) => cdp.send('Input.dispatchMouseEvent',
    Object.assign({ type, x: cx, y: cy, button: 'left' }, extra || {}));

  // ── H1: read the selection between each event of the sequence ────────────
  await reset();
  await ev('mouseMoved', { buttons: 0 });
  await ev('mousePressed', { buttons: 1, clickCount: 1 });
  const s1d = await sel();
  await ev('mouseReleased', { buttons: 0, clickCount: 1 });
  const s1u = await sel();
  await ev('mousePressed', { buttons: 1, clickCount: 2 });
  const s2d = await sel();   // <-- Blink should have selected the word HERE
  await ev('mouseReleased', { buttons: 0, clickCount: 2 });
  const s2u = await sel();
  log('H1 after press cc=1', s1d);
  log('H1 after release cc=1', s1u);
  log('H1 after press cc=2  (word expected here)', s2d);
  log('H1 after release cc=2', s2u);

  // ── H2: strictly increasing timestamps ──────────────────────────────────
  await reset();
  const t0 = Date.now() / 1000;
  await ev('mouseMoved', { buttons: 0, timestamp: t0 });
  await ev('mousePressed', { buttons: 1, clickCount: 1, timestamp: t0 + 0.01 });
  await ev('mouseReleased', { buttons: 0, clickCount: 1, timestamp: t0 + 0.02 });
  await ev('mousePressed', { buttons: 1, clickCount: 2, timestamp: t0 + 0.08 });
  const h2mid = await sel();
  await ev('mouseReleased', { buttons: 0, clickCount: 2, timestamp: t0 + 0.09 });
  await page.waitForTimeout(200);
  log('H2 explicit rising timestamps (mid)', h2mid);
  log('H2 explicit rising timestamps (end)', await sel());

  // ── H4: cc=2 press only, no preceding cc=1 at all ───────────────────────
  await reset();
  await ev('mousePressed', { buttons: 1, clickCount: 2 });
  const h4 = await sel();
  await ev('mouseReleased', { buttons: 0, clickCount: 2 });
  log('H4 bare press cc=2 (mid)', h4);
  log('H4 bare press cc=2 (end)', await sel());

  // ── H5: does the DOM double-click handler see it, and can JS select? ─────
  await reset();
  const domSelectable = await page.evaluate(() => {
    const t = document.getElementById('p').firstChild;
    const i = t.textContent.indexOf('gamma');
    const r = document.createRange();
    r.setStart(t, i); r.setEnd(t, i + 5);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    return String(s).trim();
  });
  log('H5 JS-driven selection works at all', domSelectable);

  // ── Does Chromium think a double click happened? (detail on dblclick) ────
  await reset();
  await page.evaluate(() => {
    window.dbl = null;
    document.addEventListener('dblclick', (e) => {
      window.dbl = { detail: e.detail, x: e.clientX, y: e.clientY,
                     selAtEvent: String(window.getSelection()).trim() };
    }, true);
  });
  await ev('mouseMoved', { buttons: 0 });
  await ev('mousePressed', { buttons: 1, clickCount: 1 });
  await ev('mouseReleased', { buttons: 0, clickCount: 1 });
  await ev('mousePressed', { buttons: 1, clickCount: 2 });
  await ev('mouseReleased', { buttons: 0, clickCount: 2 });
  await page.waitForTimeout(200);
  log('dblclick event as the page saw it', await page.evaluate(() => window.dbl));

  // ── WORKAROUND CANDIDATE: does Blink select a word if we ALSO send the
  //    selectWord editing command / or use Runtime to extend the selection? ─
  await reset();
  await ev('mouseMoved', { buttons: 0 });
  await ev('mousePressed', { buttons: 1, clickCount: 1 });
  await ev('mouseReleased', { buttons: 0, clickCount: 1 });
  // caret is now placed inside "gamma"; ask Blink to grow it to a word
  const grown = await page.evaluate(() => {
    const s = window.getSelection();
    if (!s.rangeCount) return 'NO-CARET';
    // modify() is the standard, Blink-native way to expand to word boundaries
    s.modify('move', 'backward', 'word');
    s.modify('extend', 'forward', 'word');
    return String(s).trim();
  });
  log('WORKAROUND caret + Selection.modify(word)', grown);

  // and the same for a paragraph, to show the pattern generalises
  await reset();
  await ev('mousePressed', { buttons: 1, clickCount: 1 });
  await ev('mouseReleased', { buttons: 0, clickCount: 1 });
  const grownPara = await page.evaluate(() => {
    const s = window.getSelection();
    if (!s.rangeCount) return 'NO-CARET';
    s.modify('move', 'backward', 'paragraph');
    s.modify('extend', 'forward', 'paragraph');
    return String(s).trim();
  });
  log('WORKAROUND caret + Selection.modify(paragraph)', grownPara);

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('crashed:', e && e.stack ? e.stack : e); process.exit(1); });
