/**
 * G.1 decisive case: FIRST profile under Playwright launched WITHOUT --enable-automation
 * (ignoreDefaultArgs), then a plain second launch of profile-002 on the same root.
 * Checks: second opens (window + folder), forwarded into the SAME process, the first
 * Playwright session still works, what Playwright sees of the second profile's pages,
 * navigator.webdriver in the Playwright page, and what happens to the second
 * profile's window when the Playwright context is closed.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':77' };
const exe = chromium.executablePath();
const wins = () => { try { return execFileSync('wmctrl', ['-l'], { env }).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const procsOn = (root) => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type=')); } catch { return false; } });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's36f-'));
const out = {};
const ctx = await chromium.launchPersistentContext(root, { headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation'], args: ['--no-sandbox', '--profile-directory=profile-001'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('data:text/html,<title>first</title>');
out.webdriver = await page.evaluate(() => navigator.webdriver);
const w0 = wins().length; const pidsBefore = procsOn(root);
const second = spawn(exe, [`--user-data-dir=${root}`, '--profile-directory=profile-002', '--no-sandbox', '--no-first-run', 'data:text/html,<title>second-profile</title>'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let err = ''; second.stderr.on('data', (d) => { err += d; });
const code = await new Promise((r) => { second.on('exit', r); setTimeout(() => r('still-running'), 8000); });
await sleep(2000);
out.second = { exitCode: code, stderrHead: err.split('\n').filter((l) => /ERROR|existing/.test(l)).slice(0, 2).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 160)),
  newWindows: wins().length - w0, windowTitles: wins().map((l) => l.split(/\s+/).slice(3).join(' ')), profile002Created: fs.existsSync(path.join(root, 'profile-002')),
  browserProcessesOnRoot: procsOn(root).length, sameProcess: JSON.stringify(procsOn(root)) === JSON.stringify(pidsBefore) };
let alive = false; try { await page.goto('data:text/html,<title>still</title>', { timeout: 8000 }); alive = (await page.title()) === 'still'; } catch {}
const np = await ctx.newPage().then(async (p) => { await p.goto('data:text/html,<title>new-tab</title>'); return true; }).catch((e) => String(e).slice(0, 100));
out.firstSession = { alive, newPageWorks: np, pagesPlaywrightSees: ctx.pages().map((p) => p.url().slice(0, 50)) };
// A run on this branch now: is the 2nd profile visible to automation? (it must not be used)
out.secondVisibleToPlaywright = ctx.pages().some((p) => p.url().includes('second-profile'));
const w1 = wins().length;
await ctx.close(); await sleep(2500);
out.afterPlaywrightClose = { windowsLeft: wins().length, windowsClosed: w1 - wins().length, browserProcessesOnRoot: procsOn(root).length };
console.log('RESULT ' + JSON.stringify(out, null, 1));
fs.rmSync(root, { recursive: true, force: true });
