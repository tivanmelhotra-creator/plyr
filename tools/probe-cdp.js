/**
 * tools/probe-cdp.js — which CDP calls actually do the job on THIS Chrome?
 * Answers the design questions instead of guessing them:
 *   - does Emulation.setPageScaleFactor zoom a normal desktop page?
 *   - does Input.dispatchKeyEvent with a modifier bitmask trigger Ctrl+A?
 *   - does Input.dispatchMouseEvent clickCount:2/3 select a word/paragraph?
 *   - does mouseWheel deltaX scroll horizontally?
 *   - does Fetch.authRequired let us answer a 401 without context credentials?
 *   - does Input.synthesizePinchGesture exist?
 */
'use strict';
const { chromium } = require('playwright');

const HTML = `data:text/html,<style>body{margin:0;font:16px/1.6 system-ui}
#p{width:300px}#wide{width:3000px;height:40px;background:linear-gradient(90deg,red,blue)}</style>
<input id="i" value="hello world">
<p id="p">First paragraph has several words in it. Second sentence too.</p>
<div id="wide"></div>
<a id="lnk" href="https://example.com/x">a link</a>`;

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  // setContent, not a data: URL — `#` in inline CSS is a fragment delimiter and
  // silently truncates the document, which cost one probe run.
  await page.setContent(HTML.replace(/^data:text\/html,/, ''));
  const cdp = await ctx.newCDPSession(page);

  const say = (k, v) => console.log(k.padEnd(38), v);

  // ── zoom via Emulation.setPageScaleFactor ────────────────────────────────
  try {
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
    const vv = await page.evaluate(() => ({ s: visualViewport.scale, w: visualViewport.width }));
    say('Emulation.setPageScaleFactor', JSON.stringify(vv));
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  } catch (e) { say('Emulation.setPageScaleFactor', 'ERR ' + e.message.slice(0, 80)); }

  // ── browser-style zoom via deviceMetricsOverride ──────────────────────────
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 800, height: 600, deviceScaleFactor: 0, mobile: false, scale: 1.25,
    });
    const w = await page.evaluate(() => innerWidth);
    say('setDeviceMetricsOverride scale', 'innerWidth=' + w);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  } catch (e) { say('setDeviceMetricsOverride', 'ERR ' + e.message.slice(0, 80)); }

  // ── Ctrl+A via a modifier bitmask ─────────────────────────────────────────
  await page.click('#i');
  try {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: '', commands: ['selectAll'],
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
    });
    const sel = await page.evaluate(() => {
      const i = document.getElementById('i');
      return i.value.slice(i.selectionStart, i.selectionEnd);
    });
    say('Ctrl+A (commands:[selectAll])', JSON.stringify(sel));
  } catch (e) { say('Ctrl+A', 'ERR ' + e.message.slice(0, 90)); }

  // ── double / triple click selection ───────────────────────────────────────
  const box = await page.locator('#p').boundingBox();
  const px = Math.round(box.x + 40), py = Math.round(box.y + 8);
  for (const n of [2, 3]) {
    await page.evaluate(() => getSelection().removeAllRanges());
    for (let i = 1; i <= n; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: i });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: i });
    }
    const s = await page.evaluate(() => String(getSelection()));
    say(`clickCount up to ${n} selects`, JSON.stringify(s.slice(0, 60)));
  }

  // ── drag-select ───────────────────────────────────────────────────────────
  await page.evaluate(() => getSelection().removeAllRanges());
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 2, y: py });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 2, y: py, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: box.x + 2 + i * 25, y: py, button: 'left', buttons: 1,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 202, y: py, button: 'left', clickCount: 1 });
  say('drag selects text', JSON.stringify(String(await page.evaluate(() => String(getSelection()))).slice(0, 60)));

  // ── horizontal wheel ──────────────────────────────────────────────────────
  await page.evaluate(() => { document.body.style.width = '3000px'; });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 400, y: 300, deltaX: 250, deltaY: 0,
  });
  await page.waitForTimeout(300);
  say('mouseWheel deltaX scrolls', 'scrollX=' + await page.evaluate(() => scrollX));

  // ── pinch ─────────────────────────────────────────────────────────────────
  try {
    await cdp.send('Input.synthesizePinchGesture', { x: 400, y: 300, scaleFactor: 1.5 });
    say('Input.synthesizePinchGesture', 'ok');
  } catch (e) { say('Input.synthesizePinchGesture', 'ERR ' + e.message.slice(0, 70)); }

  // ── what is under the cursor (context menu payload) ───────────────────────
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const hit = await cdp.send('DOM.getNodeForLocation', { x: 400, y: 300, includeUserAgentShadowDOM: false });
    say('DOM.getNodeForLocation', JSON.stringify({ root: !!root, nodeId: hit.nodeId }));
  } catch (e) { say('DOM.getNodeForLocation', 'ERR ' + e.message.slice(0, 70)); }

  // ── does the browser even send Input.dispatchMouseEvent button:'right'? ───
  let ctxMenuSeen = false;
  await page.evaluate(() => {
    window.__ctx = false;
    document.addEventListener('contextmenu', () => { window.__ctx = true; }, true);
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 300, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300, button: 'right', clickCount: 1 });
  await page.waitForTimeout(300);
  ctxMenuSeen = await page.evaluate(() => window.__ctx);
  say('right-click fires contextmenu', ctxMenuSeen);

  // ── Fetch.authRequired for HTTP basic auth ────────────────────────────────
  try {
    await cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
    say('Fetch.enable handleAuthRequests', 'ok');
    await cdp.send('Fetch.disable');
  } catch (e) { say('Fetch.enable', 'ERR ' + e.message.slice(0, 70)); }

  // ── favicon discovery ─────────────────────────────────────────────────────
  await page.goto('https://example.com').catch(() => {});
  const fav = await page.evaluate(() => {
    const l = document.querySelector('link[rel~="icon" i]');
    return l ? l.href : new URL('/favicon.ico', location.href).href;
  }).catch(() => '');
  say('favicon resolvable', fav);

  await b.close();
  process.exit(0);
})().catch((e) => { console.error('probe error', e); process.exit(1); });
