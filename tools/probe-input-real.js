/**
 * tools/probe-input-real.js — prove BrowserInput's translation against REAL
 * Chromium, not against my own unit test's expectations.
 *
 * Every case feeds buildKeyEvents()/mouse specs straight into
 * Input.dispatchKeyEvent / Input.dispatchMouseEvent and then ASKS THE PAGE
 * what happened. If Chromium disagrees with my table, this fails.
 *
 * Run: node tools/probe-input-real.js        (needs `npm run build` first)
 *      node tools/probe-input-real.js keys   (only the keyboard half)
 *      node tools/probe-input-real.js mouse  (only the mouse/zoom half)
 */
const { chromium } = require('playwright');
const {
  buildKeyEvents, modifierMask, buttonsMask, normalizeClickCount, nextZoom,
} = require('../dist/core/BrowserInput');

const only = process.argv[2] || 'all';
const results = [];
const ok = (n, v, note) => {
  results.push({ name: n, pass: !!v, note: note || '' });
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${note ? '\n        ' + note : ''}`);
};

const PAGE = [
  '<!doctype html><meta charset=utf-8>',
  '<style>body{font:16px system-ui;margin:0;padding:12px}',
  '#ta{width:400px;height:70px}p#para{width:420px}',
  '#big{height:1600px;width:2400px;background:#ddd}</style>',
  '<input id=inp value="seed">',
  '<textarea id=ta></textarea>',
  '<p id=para>Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.</p>',
  '<div id=big></div>',
  '<script>',
  'window.keys=[];window.ctxMenus=[];window.mids=[];',
  'for (const type of ["keydown","keyup","keypress"]) {',
  '  window.addEventListener(type, function(e){',
  '    window.keys.push({t:type,key:e.key,code:e.code,ctrl:e.ctrlKey,',
  '      shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,repeat:e.repeat});',
  '  }, true);',
  '}',
  'window.addEventListener("contextmenu", function(e){',
  '  window.ctxMenus.push({x:e.clientX,y:e.clientY,',
  '    target:e.target.id||e.target.tagName});',
  '  e.preventDefault();',
  '}, true);',
  'window.addEventListener("auxclick", function(e){ window.mids.push(e.button); }, true);',
  'window.sel=function(){ return String(window.getSelection()); };',
  'window.inpSel=function(){ var a=document.getElementById("inp");',
  '  return a.value.slice(a.selectionStart, a.selectionEnd); };',
  '</script>',
].join('\n');

async function sendKey(cdp, key, mods, opts) {
  const spec = buildKeyEvents(key, mods || {}, opts || {});
  for (const ev of spec.events) await cdp.send('Input.dispatchKeyEvent', ev);
  return spec;
}

async function keyboardChecks(page, cdp, ctx) {
  // 1. printable characters actually TYPE
  await page.click('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = ''; });
  for (const ch of ['h', 'i', ' ', 'ب', '7', '#', '?']) await sendKey(cdp, ch);
  const typed = await page.inputValue('#ta');
  ok('printable chars type (incl. non-latin & punctuation)', typed === 'hi ب7#?', 'textarea="' + typed + '"');

  // 2. keys the OLD 9-item whitelist dropped now reach the page
  await page.evaluate(() => { window.keys = []; });
  const dropped = ['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'F6', 'F11', 'ContextMenu'];
  for (const k of dropped) await sendKey(cdp, k);
  const seen = await page.evaluate(() => window.keys.filter((k) => k.t === 'keydown').map((k) => k.key));
  const missing = dropped.filter((k) => !seen.includes(k));
  ok('keys dropped by the old whitelist now arrive in the page', missing.length === 0,
     'arrived=' + JSON.stringify(seen) + ' missing=' + JSON.stringify(missing));

  // 3. modifiers arrive AS modifiers
  await page.evaluate(() => { window.keys = []; });
  await sendKey(cdp, 'k', { ctrl: true, shift: true, alt: true });
  const modEv = await page.evaluate(() => window.keys.find((k) => k.t === 'keydown'));
  ok('ctrl+shift+alt all arrive true on the DOM event',
     !!modEv && modEv.ctrl && modEv.shift && modEv.alt, JSON.stringify(modEv));

  // 4. Ctrl+A really selects (the `commands` field)
  await page.click('#inp');
  await sendKey(cdp, 'a', { ctrl: true });
  const inpSel = await page.evaluate(() => window.inpSel());
  ok('Ctrl+A selects the input contents (commands:[selectAll])', inpSel === 'seed', 'selection="' + inpSel + '"');

  // 5. Ctrl+C / Ctrl+V round-trip
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await sendKey(cdp, 'c', { ctrl: true });
  await page.click('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = ''; });
  await sendKey(cdp, 'a', { ctrl: true });
  await sendKey(cdp, 'v', { ctrl: true });
  await page.waitForTimeout(250);
  const pasted = await page.inputValue('#ta');
  ok('Ctrl+C then Ctrl+V moves text between fields', pasted === 'seed', 'textarea="' + pasted + '"');

  // 6. Ctrl+Z undoes
  await page.click('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = ''; });
  for (const ch of ['a', 'b', 'c']) await sendKey(cdp, ch);
  const beforeUndo = await page.inputValue('#ta');
  await sendKey(cdp, 'z', { ctrl: true });
  await page.waitForTimeout(200);
  const afterUndo = await page.inputValue('#ta');
  ok('Ctrl+Z undoes typing', afterUndo !== beforeUndo, 'before="' + beforeUndo + '" after="' + afterUndo + '"');

  // 7. Ctrl+letter must NOT type the letter
  await page.click('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = ''; });
  await sendKey(cdp, 'v', {});
  const plainV = await page.inputValue('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = ''; });
  await sendKey(cdp, 'b', { ctrl: true });
  const ctrlB = await page.inputValue('#ta');
  ok('plain letter types but Ctrl+letter inserts nothing',
     plainV === 'v' && ctrlB === '', 'plain="' + plainV + '" ctrl="' + ctrlB + '"');

  // 8. autoRepeat
  await page.click('#ta');
  await page.evaluate(() => { window.keys = []; });
  await sendKey(cdp, 'q', {}, { autoRepeat: true });
  const rep = await page.evaluate(() => window.keys.find((k) => k.t === 'keydown'));
  ok('autoRepeat surfaces as event.repeat === true', !!rep && rep.repeat === true, JSON.stringify(rep));

  // 9. shifted punctuation reports right key AND code
  await page.evaluate(() => { window.keys = []; });
  await sendKey(cdp, '?', { shift: true });
  const q = await page.evaluate(() => window.keys.find((k) => k.t === 'keydown'));
  ok('shifted punctuation: key="?" with code="Slash"',
     !!q && q.key === '?' && q.code === 'Slash', JSON.stringify(q));
}

async function mouseChecks(page, cdp) {
  const box = await page.locator('#para').boundingBox();
  // Aim at the CENTRE OF A WORD, computed from a Range rect.
  //
  // The first version of this probe used `box.x + 40`, which landed on the
  // SPACE between "Alpha" and "beta". Chromium dutifully double-click-selected
  // that space, `.trim()` turned it into "", and the probe reported
  // "double-click is broken" — sending me off to test headed Chrome and
  // Playwright's own dblclick, both of which "failed" for the same reason.
  // Measure the coordinate, do not eyeball it.
  const wordRect = await page.evaluate(() => {
    const t = document.getElementById('para').firstChild;
    const i = t.textContent.indexOf('gamma');
    const r = document.createRange();
    r.setStart(t, i); r.setEnd(t, i + 5);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  const cx = Math.round(wordRect.x);
  const cy = Math.round(wordRect.y);

  const clickAt = async (count) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    for (let i = 1; i <= count; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: cx, y: cy, button: 'left',
        buttons: buttonsMask('left'), clickCount: normalizeClickCount(i),
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: cx, y: cy, button: 'left',
        buttons: 0, clickCount: normalizeClickCount(i),
      });
    }
  };

  // 10/11. double + triple click selection
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await clickAt(2);
  const wordSel = (await page.evaluate(() => window.sel())).trim();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await clickAt(3);
  const paraSel = (await page.evaluate(() => window.sel())).trim();
  ok('double-click selects the word under the pointer',
     wordSel === 'gamma', 'word="' + wordSel + '" (expected "gamma")');
  ok('triple-click selects the whole paragraph', paraSel.length > wordSel.length + 10,
     'para len=' + paraSel.length + ' word len=' + wordSel.length);

  // 12. drag selection
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const x0 = Math.round(box.x + 2);
  const y0 = Math.round(box.y + 8);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: buttonsMask('left'), clickCount: 1,
  });
  for (let i = 1; i <= 10; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x0 + i * 20, y: y0, button: 'left', buttons: buttonsMask('left'),
    });
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x0 + 200, y: y0, button: 'left', buttons: 0, clickCount: 1,
  });
  const dragSel = (await page.evaluate(() => window.sel())).trim();
  ok('drag (down->moves->up) selects a text range', dragSel.length > 5,
     'selected="' + dragSel.slice(0, 50) + '"');

  // 13. right click -> contextmenu at the right target
  await page.evaluate(() => { window.ctxMenus = []; });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cx, y: cy, button: 'right', buttons: buttonsMask('right'), clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cx, y: cy, button: 'right', buttons: 0, clickCount: 1,
  });
  await page.waitForTimeout(200);
  const menus = await page.evaluate(() => window.ctxMenus);
  ok('right-click produces contextmenu at the right target/coords',
     menus.length > 0 && menus[0].target === 'para', JSON.stringify(menus));

  // 14. horizontal wheel
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 300, y: 300, deltaX: 260, deltaY: 0,
    modifiers: modifierMask({ shift: true }),
  });
  await page.waitForTimeout(300);
  const sx = await page.evaluate(() => window.scrollX);
  ok('deltaX wheel scrolls horizontally', sx > 100, 'scrollX=' + sx);

  // 15. vertical wheel
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: 400,
  });
  await page.waitForTimeout(300);
  const sy = await page.evaluate(() => window.scrollY);
  ok('deltaY wheel scrolls vertically', sy > 100, 'scrollY=' + sy);

  // 16. zoom ladder via Emulation.setDeviceMetricsOverride.
  // NOT setPageScaleFactor: tools/probe-zoom.js measured that it cannot go
  // below 100% (that is pinch zoom; a desktop page's minimum pinch scale is 1)
  // and does not reflow the page at all. Real zoom changes the layout width.
  const VPW = 900;
  const VPH = 600;
  const applyZoom = async (z) => {
    if (Math.abs(z - 1) < 1e-6) {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    } else {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(VPW / z), height: Math.round(VPH / z),
        deviceScaleFactor: z, mobile: false,
      });
    }
    await page.waitForTimeout(220);
    return page.evaluate(() => window.innerWidth);
  };
  const zIn = nextZoom(1, 'in');
  const wIn = await applyZoom(zIn);
  const zOut = nextZoom(1, 'out');
  const wOut = await applyZoom(zOut);
  const wReset = await applyZoom(1);
  ok('zoom IN reflows the page (layout width shrinks by the zoom)',
     wIn === Math.round(VPW / zIn), 'z=' + zIn + ' innerWidth=' + wIn + ' expected=' + Math.round(VPW / zIn));
  ok('zoom OUT below 100% works (what setPageScaleFactor could not do)',
     wOut === Math.round(VPW / zOut), 'z=' + zOut + ' innerWidth=' + wOut + ' expected=' + Math.round(VPW / zOut));
  ok('zoom reset restores exactly 100%', wReset === VPW, 'innerWidth=' + wReset + ' expected=' + VPW);

  // 17. middle click reaches the page as button 1
  await page.evaluate(() => { window.mids = []; });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cx, y: cy, button: 'middle', buttons: buttonsMask('middle'), clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cx, y: cy, button: 'middle', buttons: 0, clickCount: 1,
  });
  await page.waitForTimeout(200);
  const mids = await page.evaluate(() => window.mids);
  ok('middle click reaches the page as button 1', mids.indexOf(1) >= 0, JSON.stringify(mids));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.setContent(PAGE);

  if (only === 'all' || only === 'keys') await keyboardChecks(page, cdp, ctx);
  if (only === 'all' || only === 'mouse') await mouseChecks(page, cdp);

  await browser.close();
  let pass = 0;
  for (const r of results) if (r.pass) pass += 1;
  console.log('\n=== probe-input-real (' + only + '): ' + pass + '/' + results.length + ' ===\n');
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('crashed:', e && e.stack ? e.stack : e); process.exit(1); });
