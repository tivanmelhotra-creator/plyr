// Same double-click test, but HEADED on Xvfb — which is how real-Chrome mode runs.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 500 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.setContent('<p id=p style="width:420px;font:16px/1.5 system-ui;margin:20px">'
    + 'Alpha beta gamma delta epsilon zeta eta theta.</p>'
    + '<script>window.sel=function(){return String(window.getSelection());}</script>');
  const box = await page.locator('#p').boundingBox();
  const cx = Math.round(box.x + 45), cy = Math.round(box.y + 10);
  const press = (cc) => cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:cx, y:cy, button:'left', buttons:1, clickCount:cc });
  const release = (cc) => cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:cx, y:cy, button:'left', buttons:0, clickCount:cc });
  const run = async (counts) => {
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:cx, y:cy });
    for (const cc of counts) { await press(cc); await release(cc); }
    await page.waitForTimeout(250);
    return (await page.evaluate(() => window.sel())).trim();
  };
  const dbl = await run([1,2]);
  const trip = await run([1,2,3]);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(250);
  const pwDbl = (await page.evaluate(() => window.sel())).trim();
  console.log('HEADED cc=[1,2]      ->', JSON.stringify(dbl));
  console.log('HEADED cc=[1,2,3]    ->', JSON.stringify(trip));
  console.log('HEADED pw.dblclick   ->', JSON.stringify(pwDbl));
  console.log(dbl.length > 2 ? 'VERDICT: double-click WORKS headed' : 'VERDICT: still fails headed');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
