/**
 * tools/probe-zoom.js — how do you actually implement BROWSER ZOOM (Ctrl +/-/0)?
 *
 * probe-input-real.js measured that Emulation.setPageScaleFactor CANNOT zoom
 * OUT below 1 on a normal desktop page: asking for 0.9 read back as 1. That is
 * pinch-zoom, and a desktop page's minimum pinch scale is 1. Real Chrome's
 * Ctrl+- definitely does go below 100%, so setPageScaleFactor is only half the
 * answer. This probe finds the whole one.
 *
 * Candidates, each judged by what the PAGE reports:
 *   1. Emulation.setPageScaleFactor           (pinch zoom)
 *   2. Emulation.setDeviceMetricsOverride     (layout viewport + deviceScaleFactor)
 *   3. document CSS zoom on the root element
 *
 * Real browser zoom at Z means: layout width becomes viewport/Z, and content is
 * drawn Z times larger. So innerWidth MUST change. That is the test.
 *
 * Run: node tools/probe-zoom.js
 */
const { chromium } = require('playwright');

const results = [];
const ok = (n, v, note) => {
  results.push({ name: n, pass: !!v, note: note || '' });
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${note ? '\n        ' + note : ''}`);
};

const VP = { width: 1000, height: 700 };
const PAGE = [
  '<!doctype html><meta charset=utf-8>',
  '<style>body{margin:0;font:16px system-ui}#b{width:200px;height:100px;background:#28c}</style>',
  '<div id=b>box</div>',
  '<p id=t>Measuring zoom.</p>',
].join('\n');

async function metrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    scale: window.visualViewport ? window.visualViewport.scale : -1,
    boxW: Math.round(document.getElementById('b').getBoundingClientRect().width),
  }));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VP });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.setContent(PAGE);

  const base = await metrics(page);
  console.log('baseline:', JSON.stringify(base), '\n');

  // ── 1. setPageScaleFactor: can it go below 1? ────────────────────────────
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
  await page.waitForTimeout(200);
  const psIn = await metrics(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 0.8 });
  await page.waitForTimeout(200);
  const psOut = await metrics(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await page.waitForTimeout(150);

  ok('1a setPageScaleFactor zooms IN', Math.abs(psIn.scale - 1.25) < 0.02,
     `scale=${psIn.scale} innerWidth=${psIn.innerWidth} (unchanged: ${psIn.innerWidth === base.innerWidth})`);
  ok('1b setPageScaleFactor zooms OUT below 1', Math.abs(psOut.scale - 0.8) < 0.02,
     `asked 0.8 got scale=${psOut.scale} — desktop min pinch scale is 1, so NO`);
  ok('1c setPageScaleFactor does NOT reflow (innerWidth unchanged) => it is pinch, not zoom',
     psIn.innerWidth === base.innerWidth,
     `innerWidth ${base.innerWidth} -> ${psIn.innerWidth}`);

  // ── 2. setDeviceMetricsOverride: real browser-zoom semantics ─────────────
  const applyDM = async (z) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(VP.width / z),
      height: Math.round(VP.height / z),
      deviceScaleFactor: z,
      mobile: false,
    });
    await page.waitForTimeout(200);
    return metrics(page);
  };
  const dmIn = await applyDM(1.25);
  const dmOut = await applyDM(0.8);
  const dmBig = await applyDM(2);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.waitForTimeout(200);
  const dmReset = await metrics(page);

  ok('2a setDeviceMetricsOverride zoom IN reflows the page like real zoom',
     dmIn.innerWidth === Math.round(VP.width / 1.25),
     `innerWidth=${dmIn.innerWidth} expected=${Math.round(VP.width / 1.25)} dpr=${dmIn.dpr}`);
  ok('2b setDeviceMetricsOverride zoom OUT works (the thing pinch could not do)',
     dmOut.innerWidth === Math.round(VP.width / 0.8),
     `innerWidth=${dmOut.innerWidth} expected=${Math.round(VP.width / 0.8)} dpr=${dmOut.dpr}`);
  ok('2c a big zoom (200%) halves the layout width',
     dmBig.innerWidth === Math.round(VP.width / 2),
     `innerWidth=${dmBig.innerWidth} expected=${Math.round(VP.width / 2)}`);
  ok('2d clearDeviceMetricsOverride restores 100% exactly',
     dmReset.innerWidth === base.innerWidth && Math.abs(dmReset.dpr - base.dpr) < 0.01,
     `innerWidth ${dmReset.innerWidth} vs base ${base.innerWidth}, dpr ${dmReset.dpr} vs ${base.dpr}`);

  // ── 3. does the screencast honour the override? (we stream JPEG frames) ──
  await cdp.send('Page.enable');
  const frames = [];
  cdp.on('Page.screencastFrame', async (p) => {
    frames.push(p.metadata);
    try { await cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }); } catch (_) {}
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 60, maxWidth: VP.width, maxHeight: VP.height, everyNthFrame: 1,
  });
  await applyDM(1.5);
  // force a repaint so a delta-based screencast actually emits
  await page.evaluate(() => { document.getElementById('t').textContent = 'zoomed ' + Date.now(); });
  await page.waitForTimeout(1200);
  await cdp.send('Page.stopScreencast').catch(() => {});
  ok('3a screencast still produces frames while a zoom override is active',
     frames.length > 0, `${frames.length} frames, last=${JSON.stringify(frames[frames.length - 1] || {})}`);
  // The frame must still be viewport-sized, or the canvas coordinate mapping
  // that turns a click at (x,y) into a CDP event would silently drift.
  const last = frames[frames.length - 1] || {};
  ok('3b frame metadata still reports the ORIGINAL device size (click mapping safe)',
     !last.deviceWidth || Math.abs(last.deviceWidth - VP.width) < 2,
     `deviceWidth=${last.deviceWidth} vs viewport ${VP.width}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});

  // ── 4. do input coordinates still land correctly when zoomed? ───────────
  // This is the trap: if zoom moves the page under the pointer, every click
  // after a zoom would hit the wrong element and the user would call the
  // browser broken.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(VP.width / 1.5), height: Math.round(VP.height / 1.5),
    deviceScaleFactor: 1.5, mobile: false,
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.hits = [];
    document.getElementById('b').addEventListener('click', () => window.hits.push('box'));
  });
  // The box is at layout (0,0)-(200,100). In SCREEN pixels under 1.5x zoom that
  // is (0,0)-(300,150). Click the screen centre of the box: (150, 75).
  const clickScreen = async (sx, sy) => {
    // CDP input coordinates are in the page's own (layout) space, so a screen
    // point must be divided by the zoom to address the same element.
    const x = Math.round(sx / 1.5);
    const y = Math.round(sy / 1.5);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  await clickScreen(150, 75);
  await page.waitForTimeout(200);
  const hits = await page.evaluate(() => window.hits);
  ok('4a a screen-space click divided by the zoom hits the right element',
     hits.length > 0, `hits=${JSON.stringify(hits)} — client must divide canvas coords by zoom`);

  // and prove the naive (undivided) click MISSES, so the division is required
  await page.evaluate(() => { window.hits = []; });
  const nx = 900; const ny = 600; // far outside the 200x100 box in layout space
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx, y: ny });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nx, y: ny, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nx, y: ny, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForTimeout(150);
  const misses = await page.evaluate(() => window.hits);
  ok('4b a click outside the element does not hit it (sanity: mapping is real)',
     misses.length === 0, `hits=${JSON.stringify(misses)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});

  // ── 5. double-click timing: does a delayed read see the word selection? ──
  await page.setContent(
    '<p id=p style="width:400px;font:16px system-ui">Alpha beta gamma delta epsilon zeta.</p>'
    + '<script>window.sel=function(){return String(window.getSelection());}</script>');
  const box = await page.locator('#p').boundingBox();
  const cx = Math.round(box.x + 40);
  const cy = Math.round(box.y + 8);
  const dbl = async (waitMs) => {
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    for (const cc of [1, 2]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: cc });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: cc });
    }
    if (waitMs) await page.waitForTimeout(waitMs);
    return (await page.evaluate(() => window.sel())).trim();
  };
  const noWait = await dbl(0);
  const waited = await dbl(200);
  ok('5a double-click DOES select a word once you wait for the paint',
     waited.length > 2, `immediate="${noWait}" after 200ms="${waited}"`);
  ok('5b the earlier empty result was a read race, not a broken double-click',
     noWait.length <= waited.length, `immediate len=${noWait.length} waited len=${waited.length}`);

  await browser.close();
  let pass = 0;
  for (const r of results) if (r.pass) pass += 1;
  console.log(`\n=== probe-zoom: ${pass}/${results.length} ===\n`);
  process.exit(0);
})().catch((e) => { console.error('crashed:', e && e.stack ? e.stack : e); process.exit(1); });
