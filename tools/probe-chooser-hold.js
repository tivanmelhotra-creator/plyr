/**
 * MEASUREMENT 7: how long may a file chooser stay unanswered?
 *
 * The design has the SERVER hold the dialog open while the operator's own OS
 * file picker is open on their machine, then answer it with the uploaded bytes.
 * That only works if an unanswered chooser survives a human-scale delay
 * (finding a file takes tens of seconds). If Playwright or Chrome times it out,
 * the whole approach collapses, so the hold time is measured.
 */
const http = require('http');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');
const sh = (c, a) => new Promise((r) => execFile(c, a, (e, so, se) => r({ e, so, se })));
const HOLD_MS = Number(process.argv[2] || 45000);

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="font:20px sans-serif"><input id="f" type="file"
      style="width:420px;height:60px;font-size:20px"><div id="out">nothing</div>
      <script>document.getElementById('f').addEventListener('change',e=>{
        const f=e.target.files[0];
        document.getElementById('out').textContent=f?('GOT:'+f.name+':'+f.size):'empty';});
      </script></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync('/tmp/probe-hold-src.bin', Buffer.alloc(4096, 7));

  const ctx = await chromium.launchPersistentContext('/tmp/probe-hold-profile', {
    headless: false, acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    env: { ...process.env, DISPLAY: ':98', LANG: 'C.UTF-8' },
    args: ['--window-position=0,0', '--window-size=1280,800', '--no-first-run'],
  });

  let chooser = null, firedAt = 0;
  const attach = (p) => p.on('filechooser', (c) => { chooser = c; firedAt = Date.now(); });
  ctx.on('page', attach);
  const page = await ctx.newPage(); attach(page);
  await page.goto(base);
  await page.waitForTimeout(700);

  const box = await page.locator('#f').boundingBox();
  await sh('xdotool', ['mousemove', String(Math.round(box.x + box.width/2)),
    String(Math.round(box.y + box.height/2) + 74), 'click', '1']);
  await page.waitForTimeout(1500);
  if (!chooser) { console.log('NO_CHOOSER'); await ctx.close(); server.close(); return; }

  // The operator is browsing their own machine for a file. Do nothing at all.
  console.log('holding the dialog unanswered for', HOLD_MS, 'ms ...');
  await new Promise((r) => setTimeout(r, HOLD_MS));

  // Is the page still responsive while its dialog is pending? (If Chrome blocks
  // the renderer, the view would look frozen to the operator -- worth knowing.)
  let responsive = false;
  try { responsive = (await page.evaluate(() => 1 + 1, { timeout: 4000 })) === 2; } catch (e) {}

  let answered = false, err = '';
  try { await chooser.setFiles(['/tmp/probe-hold-src.bin']); answered = true; }
  catch (e) { err = e.message.split('\n')[0]; }
  await page.waitForTimeout(1200);
  const out = await page.locator('#out').textContent().catch(() => '(unreadable)');

  console.log('HELD_MS                     =', Date.now() - firedAt);
  console.log('RENDERER_RESPONSIVE_WHILE_PENDING =', responsive);
  console.log('SET_FILES_AFTER_DELAY_OK    =', answered, err ? '| ' + err : '');
  console.log('PAGE_SEES_FILE              =', out);
  await ctx.close(); server.close();
})();
