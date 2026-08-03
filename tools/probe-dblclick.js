/**
 * tools/probe-dblclick.js — why does clickCount:2 not select a word?
 *
 * probe-input-real measured that clickCount 1,2 selects nothing while 1,2,3
 * selects the paragraph. That makes no sense for a "clickCount is all you need"
 * theory, so this tries the variants until the page reports a word selection.
 *
 * Variants:
 *   A. press/release cc=1 then press/release cc=2                (what failed)
 *   B. press/release cc=2 only
 *   C. A, but with a small delay between the two clicks
 *   D. A, but WITHOUT the leading mouseMoved
 *   E. Playwright's own page.dblclick() — the reference implementation
 *   F. Playwright's mouse.click(x,y,{clickCount:2})
 *
 * Whatever E/F do that we don't is the answer.
 *
 * Run: node tools/probe-dblclick.js
 */
const { chromium } = require('playwright');

const results = [];
const ok = (n, v, note) => {
  results.push({ name: n, pass: !!v, note: note || '' });
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${note ? '\n        ' + note : ''}`);
};

const PAGE = '<!doctype html><meta charset=utf-8>'
  + '<p id=p style="width:420px;font:16px/1.5 system-ui;margin:20px">'
  + 'Alpha beta gamma delta epsilon zeta eta theta.</p>'
  + '<script>window.sel=function(){return String(window.getSelection());};'
  + 'window.evs=[];'
  + 'for (const t of ["mousedown","mouseup","click","dblclick"]) {'
  + '  window.addEventListener(t, function(e){'
  + '    window.evs.push(t+":"+e.detail);'
  + '  }, true);'
  + '}</script>';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 500 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.setContent(PAGE);

  const box = await page.locator('#p').boundingBox();
  const cx = Math.round(box.x + 45);
  const cy = Math.round(box.y + 10);

  const reset = async () => {
    await page.evaluate(() => { window.getSelection().removeAllRanges(); window.evs = []; });
  };
  const read = async (waitMs) => {
    if (waitMs) await page.waitForTimeout(waitMs);
    return page.evaluate(() => ({ sel: String(window.getSelection()).trim(), evs: window.evs }));
  };
  const press = (extra) => cdp.send('Input.dispatchMouseEvent', Object.assign({
    type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1,
  }, extra || {}));
  const release = (extra) => cdp.send('Input.dispatchMouseEvent', Object.assign({
    type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1,
  }, extra || {}));

  // A. what we currently do
  await reset();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await press({ clickCount: 1 }); await release({ clickCount: 1 });
  await press({ clickCount: 2 }); await release({ clickCount: 2 });
  const A = await read(250);
  ok('A cc=1 then cc=2 (current impl) selects a word', A.sel.length > 2,
     `sel="${A.sel}" events=${JSON.stringify(A.evs)}`);

  // B. only cc=2
  await reset();
  await press({ clickCount: 2 }); await release({ clickCount: 2 });
  const B = await read(250);
  ok('B a single cc=2 press/release selects a word', B.sel.length > 2,
     `sel="${B.sel}" events=${JSON.stringify(B.evs)}`);

  // C. with a delay between clicks
  await reset();
  await press({ clickCount: 1 }); await release({ clickCount: 1 });
  await page.waitForTimeout(40);
  await press({ clickCount: 2 }); await release({ clickCount: 2 });
  const C = await read(250);
  ok('C cc=1, 40ms, cc=2 selects a word', C.sel.length > 2,
     `sel="${C.sel}" events=${JSON.stringify(C.evs)}`);

  // D. no leading mouseMoved
  await reset();
  await press({ clickCount: 1 }); await release({ clickCount: 1 });
  await press({ clickCount: 2 }); await release({ clickCount: 2 });
  const D = await read(250);
  ok('D without a leading mouseMoved', D.sel.length > 2, `sel="${D.sel}"`);

  // E. Playwright's own dblclick — the reference
  await reset();
  await page.mouse.move(cx, cy);
  await page.mouse.dblclick(cx, cy);
  const E = await read(250);
  ok('E Playwright page.mouse.dblclick selects a word', E.sel.length > 2,
     `sel="${E.sel}" events=${JSON.stringify(E.evs)}`);

  // F. Playwright click with clickCount 2
  await reset();
  await page.mouse.click(cx, cy, { clickCount: 2 });
  const F = await read(250);
  ok('F Playwright mouse.click({clickCount:2}) selects a word', F.sel.length > 2,
     `sel="${F.sel}" events=${JSON.stringify(F.evs)}`);

  // G. Does the page even see detail=2 in our CDP version?
  ok('G our CDP clicks produce a dblclick event with detail=2',
     (A.evs || []).some((e) => e.indexOf('dblclick') === 0),
     `A events=${JSON.stringify(A.evs)}`);

  // H. Try the full Chrome-like sequence: move, then two complete clicks where
  //    BOTH press and release of the 2nd carry cc=2 AND a pointerType is given.
  await reset();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, pointerType: 'mouse' });
  await press({ clickCount: 1, pointerType: 'mouse' });
  await release({ clickCount: 1, pointerType: 'mouse' });
  await press({ clickCount: 2, pointerType: 'mouse' });
  await release({ clickCount: 2, pointerType: 'mouse' });
  const H = await read(250);
  ok('H with explicit pointerType:mouse', H.sel.length > 2, `sel="${H.sel}"`);

  // I. triple click for contrast (this DID work before)
  await reset();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  for (const cc of [1, 2, 3]) { await press({ clickCount: cc }); await release({ clickCount: cc }); }
  const I = await read(250);
  ok('I triple click selects the paragraph (control)', I.sel.length > 20,
     `sel len=${I.sel.length} events=${JSON.stringify(I.evs)}`);

  await browser.close();
  let pass = 0;
  for (const r of results) if (r.pass) pass += 1;
  console.log(`\n=== probe-dblclick: ${pass}/${results.length} ===\n`);
  process.exit(0);
})().catch((e) => { console.error('crashed:', e && e.stack ? e.stack : e); process.exit(1); });
