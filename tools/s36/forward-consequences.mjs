/**
 * G.1 consequences of a forwarded 2nd profile (manual) in a branch whose 1st profile runs
 * under Playwright (as Browser Profiles launches it: ignoreDefaultArgs incl. --enable-automation):
 *   a) context.pages() / 'page' event: does automation SEE the 2nd profile's tabs?
 *   b) does the 2nd profile's tab share cookies with the 1st (it must not: separate profiles)?
 *   c) closing the Playwright context: is the 2nd profile's window closed too? (one process)
 *   d) the 2nd profile's window closed by the user: does the 1st session survive?
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':77' };
const exe = chromium.executablePath();
const wins = () => { try { return execFileSync('wmctrl', ['-l'], { env }).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); if (q.url === '/set') s.setHeader('set-cookie', 'who=first; Path=/'); s.end(`<title>${q.url}</title><pre id=c></pre><script>c.textContent=document.cookie</script>`); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const B = `http://127.0.0.1:${srv.address().port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's36c-'));
const out = {};
const ctx = await chromium.launchPersistentContext(root, { headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'], args: ['--no-sandbox', '--profile-directory=profile-001'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(B + '/set');
const seenNew = []; ctx.on('page', (p) => seenNew.push(p.url()));
const second = spawn(exe, [`--user-data-dir=${root}`, '--profile-directory=profile-002', '--no-sandbox', '--no-first-run', B + '/second'], { stdio: 'ignore', env });
await sleep(5000);
const secondPage = ctx.pages().find((p) => p.url().endsWith('/second'));
out.a_automationSeesSecondProfileTab = { pageEvent: seenNew, inContextPages: !!secondPage };
out.b_secondProfileCookie = secondPage ? await secondPage.evaluate(() => document.cookie) : 'n/a';
out.b_firstProfileCookie = await page.evaluate(() => document.cookie);
// d) user closes the 2nd profile's window
const w2 = wins().find((l) => l.includes('/second'));
if (w2) execFileSync('wmctrl', ['-i', '-c', w2.split(/\s+/)[0]], { env });
await sleep(2000);
let alive = false; try { await page.goto(B + '/again', { timeout: 8000 }); alive = (await page.title()) === '/again'; } catch {}
out.d_firstAliveAfterSecondWindowClosed = alive;
// c) re-open the 2nd, then close the Playwright context
spawn(exe, [`--user-data-dir=${root}`, '--profile-directory=profile-002', '--no-sandbox', '--no-first-run', B + '/second2'], { stdio: 'ignore', env });
await sleep(4000);
const before = wins().length;
await ctx.close(); await sleep(2500);
out.c_closingPlaywrightContext = { windowsBefore: before, windowsAfter: wins().length };
console.log('RESULT ' + JSON.stringify(out, null, 1));
srv.close(); fs.rmSync(root, { recursive: true, force: true });
