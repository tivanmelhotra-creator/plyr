/**
 * MEASUREMENT 6: the upload half.
 *
 * The handoff doc asserts upload CANNOT be automatic on the real-Chromium view,
 * because "Playwright is not holding its dialogs open" when the operator clicks
 * with their own mouse over VNC. That claim decides the whole design, so it is
 * measured rather than believed.
 *
 * A HEADED Chromium on a real Xvfb display, and the button is clicked with
 * xdotool -- a genuine X11 event from outside the browser, exactly what a VNC
 * client delivers. If page.on('filechooser') still fires, then the upload can be
 * fully automatic and the operator never sees the server's filesystem.
 */
const http = require('http');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');

const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, (e, so, se) => res({ e, so, se })));

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<html><body style="font:20px sans-serif">
        <h1>upload test</h1>
        <input id="f" type="file" style="width:400px;height:60px;font-size:20px">
        <div id="out">nothing</div>
        <script>
          document.getElementById('f').addEventListener('change', (e) => {
            const f = e.target.files[0];
            document.getElementById('out').textContent = f ? ('GOT:' + f.name + ':' + f.size) : 'empty';
          });
        </script></body></html>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  fs.writeFileSync('/tmp/probe-upload-src.txt', 'THE USER OWN FILE CONTENT');

  const ctx = await chromium.launchPersistentContext('/tmp/probe-up-profile', {
    headless: false,                       // headed, as the real view is
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    env: { ...process.env, DISPLAY: ':98', LANG: 'C.UTF-8' },
    args: ['--window-position=0,0', '--window-size=1280,800', '--no-first-run'],
  });

  let chooserFired = false;
  let chooserAnswered = false;
  const attach = (p) => p.on('filechooser', async (chooser) => {
    chooserFired = true;
    // This is what the server would do: hand over a path on ITS disk.
    try { await chooser.setFiles(['/tmp/probe-upload-src.txt']); chooserAnswered = true; } catch (e) {}
  });
  ctx.on('page', attach);
  const page = await ctx.newPage(); attach(page);
  await page.goto(base);
  await page.waitForTimeout(800);

  // Find the input's real screen position and click it with a REAL X11 event.
  const box = await page.locator('#f').boundingBox();
  const winId = (await sh('xdotool', ['search', '--onlyvisible', '--class', 'chrom'])).so.trim().split('\n').pop();
  // Chrome's window offset: the page starts below the tab strip + omnibox.
  const geo = (await sh('xdotool', ['getwindowgeometry', winId])).so;
  console.log('WINDOW:', winId, geo.replace(/\n/g, ' '));
  // Click via absolute screen coords. The browser window is at 0,0; add the
  // measured chrome height so the click lands on the input, not the toolbar.
  const CHROME_TOP = 74;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2) + CHROME_TOP;
  console.log('CLICK_AT:', x, y, 'input box:', JSON.stringify(box));
  await sh('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
  await page.waitForTimeout(2500);

  const out = await page.locator('#out').textContent().catch(() => '(unreadable)');
  // Was a native GTK dialog drawn instead? If Playwright intercepted, there is none.
  const wins = (await sh('xdotool', ['search', '--name', 'Open File'])).so.trim();

  console.log('FILECHOOSER_EVENT_FIRED   =', chooserFired);
  console.log('CHOOSER_ANSWERED_BY_SERVER=', chooserAnswered);
  console.log('PAGE_SEES_FILE            =', out);
  console.log('NATIVE_GTK_DIALOG_OPEN    =', wins ? 'YES ' + wins : 'no');
  await ctx.close(); server.close();
})();
