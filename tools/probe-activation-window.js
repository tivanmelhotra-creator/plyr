/**
 * MEASUREMENT 8: may the VIEWER page open the operator's own file picker by
 * itself, or must the operator click a second time?
 *
 * The flow: the operator clicks "Browse" inside the remote page. That click is a
 * real gesture on OUR canvas. The server then reports a pending dialog, and the
 * viewer calls input.click() to raise the operator's LOCAL picker. Chrome gates
 * showPicker/file-input clicks behind TRANSIENT USER ACTIVATION, so the question
 * is how much delay that activation tolerates -- the poll round trip.
 *
 * Measured by clicking a div with xdotool and then calling input.click() after a
 * delay, watching for the chooser. Reports the largest delay that still worked.
 */
const http = require('http');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const sh = (c, a) => new Promise((r) => execFile(c, a, (e, so, se) => r({ e, so, se })));

const DELAYS = [0, 300, 600, 1000, 2000, 4000, 4900, 6000, 10000];

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="margin:0">
      <div id="canvas" style="width:1200px;height:400px;background:#245">click me</div>
      <input id="up" type="file" style="display:none">
      <div id="log"></div>
      <script>
        window.opened = 0;
        // Same shape as the real viewer: a gesture happens, then LATER we ask
        // for the picker because the server said a dialog is pending.
        document.getElementById('canvas').addEventListener('mousedown', () => {
          const d = Number(document.title || 0);
          setTimeout(() => {
            try { document.getElementById('up').click(); window.clicked = true; }
            catch (e) { window.clickErr = String(e); }
          }, d);
        });
      </script></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/probe-act-profile', {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    env: { ...process.env, DISPLAY: ':98', LANG: 'C.UTF-8' },
    args: ['--window-position=0,0', '--window-size=1280,800', '--no-first-run'],
  });
  const page = await ctx.newPage();

  const results = [];
  for (const delay of DELAYS) {
    await page.goto(base);
    await page.evaluate((d) => { document.title = String(d); }, delay);
    await page.waitForTimeout(400);

    let fired = false;
    const onChooser = (c) => { fired = true; c.setFiles([]).catch(() => {}); };
    page.on('filechooser', onChooser);

    // A real X11 click on the canvas: the operator's gesture.
    await sh('xdotool', ['mousemove', '400', String(150 + 74), 'click', '1']);
    await page.waitForTimeout(delay + 2500);
    page.off('filechooser', onChooser);

    const st = await page.evaluate(() => ({ clicked: !!window.clicked, err: window.clickErr || '' }));
    results.push({ delayMs: delay, pickerOpened: fired, clickCalled: st.clicked, error: st.err });
    // Close any native dialog that may have been drawn, so the next case is clean.
    await sh('xdotool', ['key', 'Escape']);
    await page.waitForTimeout(200);
  }
  console.table(results);
  const ok = results.filter((r) => r.pickerOpened).map((r) => r.delayMs);
  console.log('DELAYS_THAT_OPENED_THE_PICKER =', JSON.stringify(ok));
  console.log('MAX_WORKING_DELAY_MS          =', ok.length ? Math.max(...ok) : 'NONE');
  await ctx.close(); server.close();
})();
