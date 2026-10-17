/**
 * G.2 design fact: can the server tell WHICH Chromium profile a tab belongs to, in a
 * forwarded 2nd profile? (needed so automation never uses its tabs and Stop closes
 * exactly its windows, including tabs the user opened with Ctrl+T)
 *   - CDP Target.getTargets browserContextId per tab (profile-001 vs profile-002)
 *   - a tab opened LATER in the 2nd profile's window (Ctrl+T through xdotool)
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':77' };
const exe = chromium.executablePath();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's36i-'));
const ctx = await chromium.launchPersistentContext(root, { headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'], args: ['--no-sandbox', '--profile-directory=profile-001'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('data:text/html,<title>P1</title>');
spawn(exe, [`--user-data-dir=${root}`, '--profile-directory=profile-002', '--no-sandbox', '--no-first-run', 'data:text/html,<title>P2-first</title>'], { stdio: 'ignore', env });
await sleep(4000);
// Ctrl+T in the 2nd profile's window
const w = execFileSync('wmctrl', ['-l'], { env }).toString().split('\n').find((l) => l.includes('P2-first'));
if (w) { const id = w.split(/\s+/)[0]; execFileSync('wmctrl', ['-i', '-a', id], { env }); await sleep(500); execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+t'], { env }); await sleep(2000); }
const cdp = await ctx.newCDPSession(page);
const { targetInfos } = await cdp.send('Target.getTargets');
const tabs = targetInfos.filter((t) => t.type === 'page').map((t) => ({ title: t.title, url: t.url.slice(0, 40), ctx: t.browserContextId }));
console.log('RESULT ' + JSON.stringify({ tabs, contexts: [...new Set(tabs.map((t) => t.ctx))].length, playwrightPages: ctx.pages().map((p) => p.url().slice(0, 40)) }, null, 1));
await ctx.close(); fs.rmSync(root, { recursive: true, force: true });
