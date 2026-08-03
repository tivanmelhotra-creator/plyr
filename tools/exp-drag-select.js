#!/usr/bin/env node
/**
 * EXPERIMENT (handoff §4.1, hypothesis 3): does a mouse drag select text at all
 * in this environment?
 *
 * The live parity probe has exactly one failure left: `mousedown→move→up selects
 * a text range` reports an empty selection, even though the SAME `drag()`
 * primitive successfully moves a range slider. That rules out "the events never
 * arrive". So either Blink needs something extra for a *selection* drag that it
 * does not need for a slider drag, or selection-by-drag simply does not happen
 * in headless Chromium under Xvfb.
 *
 * This script settles it by driving the identical gesture three ways against the
 * identical fixture, in a browser this repo's own code never touches:
 *
 *   A. Playwright's own page.mouse.down/move/up      — the reference gesture
 *   B. raw CDP, paced 16ms apart, button:'left'      — exactly LiveBrowser.drag()
 *   C. raw CDP, no pacing                            — the pre-fix behaviour
 *
 * Read the result like this:
 *   A fails too  → environmental. Nothing in this repo can fix it; stop.
 *   A passes, B fails → the fault is in our event shape; the diff tells us where.
 *   A and B pass → the fault is upstream of drag() (overlay, hover suppression).
 *
 * Run:  DISPLAY=:99 node tools/exp-drag-select.js
 */
'use strict';

const { chromium } = require('playwright');
const fixtures = require('./fixture-server');

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Where the text GLYPHS actually are.
 *
 * MEASURED 2026-08-03: the obvious version of this — `p.getClientRects()[0]`
 * plus a small offset — is WRONG, and wrong in a way that silently fakes a
 * failure. `getClientRects()` on the <p> returns its BORDER box, and the fixture
 * styles the paragraph `padding:40px`. So `top + 26` / `left + 12` land in the
 * padding, several pixels clear of any character, and a perfectly good drag
 * selects nothing because it began on empty space. The first run of this
 * experiment "proved" that even Playwright's own page.mouse cannot select text
 * here; it had only proved that you cannot select padding.
 *
 * Measuring a Range over the text NODE gives the glyph boxes themselves.
 */
async function textSpan(page) {
  return page.evaluate(() => {
    const node = document.getElementById('p').firstChild;
    const r = document.createRange();
    // First line box: a range over the first few characters.
    r.setStart(node, 0);
    r.setEnd(node, 4);
    const head = r.getClientRects()[0];
    // Somewhere well along the same line.
    r.setStart(node, 20);
    r.setEnd(node, 24);
    const tail = r.getClientRects()[0];
    return {
      y: Math.round(head.top + head.height / 2),
      x1: Math.round(head.left + 2),
      x2: Math.round(tail.right - 2),
      sameLine: Math.abs(head.top - tail.top) < 2,
    };
  });
}

async function selection(page) {
  return page.evaluate(() => String(document.getSelection() || ''));
}

async function clearSelection(page) {
  await page.evaluate(() => { const s = document.getSelection(); if (s) s.removeAllRanges(); });
}

async function main() {
  const fx = await fixtures.start(3117);
  const url = fx.base + '/select';
  const results = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await wait(400);
  const span = await textSpan(page);
  console.log('fixture ready; glyphs at y=' + span.y + ', x ' + span.x1 + '→' + span.x2
    + ' (same line: ' + span.sameLine + ')');

  // ---------- A. Playwright's own mouse ----------
  await clearSelection(page);
  await page.mouse.move(span.x1, span.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(span.x1 + ((span.x2 - span.x1) * i) / 12, span.y);
    await wait(16);
  }
  await page.mouse.up();
  await wait(400);
  results.push(['A playwright page.mouse', await selection(page)]);

  // ---------- B. raw CDP, paced, button:'left' (LiveBrowser.drag) ----------
  await clearSelection(page);
  const cdp = await page.context().newCDPSession(page);
  const dispatch = (o) => cdp.send('Input.dispatchMouseEvent', o);
  await dispatch({ type: 'mouseMoved', x: span.x1, y: span.y, modifiers: 0, buttons: 0 });
  await dispatch({
    type: 'mousePressed', x: span.x1, y: span.y, button: 'left',
    buttons: 1, clickCount: 1, modifiers: 0,
  });
  await wait(24);
  for (let i = 1; i <= 12; i += 1) {
    await dispatch({
      type: 'mouseMoved',
      x: Math.round(span.x1 + ((span.x2 - span.x1) * i) / 12),
      y: span.y, button: 'left', buttons: 1, modifiers: 0,
    });
    await wait(16);
  }
  await wait(16);
  await dispatch({
    type: 'mouseReleased', x: span.x2, y: span.y, button: 'left',
    buttons: 0, clickCount: 1, modifiers: 0,
  });
  await wait(400);
  results.push(['B raw CDP paced, button=left', await selection(page)]);

  // ---------- C. raw CDP with clickCount on the moves ----------
  // A selection drag in Chrome is really "press, then extend"; DevTools sends
  // clickCount:1 on the press only. Try carrying it on the moves too, which is
  // the one shape we have not measured.
  await clearSelection(page);
  await dispatch({ type: 'mouseMoved', x: span.x1, y: span.y, modifiers: 0, buttons: 0 });
  await dispatch({
    type: 'mousePressed', x: span.x1, y: span.y, button: 'left',
    buttons: 1, clickCount: 1, modifiers: 0,
  });
  await wait(24);
  for (let i = 1; i <= 12; i += 1) {
    await dispatch({
      type: 'mouseMoved',
      x: Math.round(span.x1 + ((span.x2 - span.x1) * i) / 12),
      y: span.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
    });
    await wait(16);
  }
  await dispatch({
    type: 'mouseReleased', x: span.x2, y: span.y, button: 'left',
    buttons: 0, clickCount: 1, modifiers: 0,
  });
  await wait(400);
  results.push(['C raw CDP paced + clickCount on moves', await selection(page)]);

  await browser.close();
  await fx.close();

  console.log('\n=== RESULT ===');
  let anyPass = false;
  for (const [name, sel] of results) {
    const words = sel.trim().split(/\s+/).filter(Boolean).length;
    const pass = words >= 2;
    if (pass) anyPass = true;
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + '  → ' + JSON.stringify(sel.slice(0, 80)));
  }
  console.log('\nVERDICT: ' + (anyPass
    ? 'drag-selection IS possible here; the winning shape above is the fix.'
    : 'drag-selection is NOT possible in headless Chromium under Xvfb — environmental.'));
  process.exit(anyPass ? 0 : 3);
}

main().catch((e) => { console.error('experiment blew up:', e); process.exit(1); });
