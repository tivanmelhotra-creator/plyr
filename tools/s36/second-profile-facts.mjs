/**
 * Owner brief 2 / G.1: is "a second profile of the SAME user-data-dir while the first
 * runs under Playwright" a real Chromium limit or an artifact of how it was launched?
 * First profile: Playwright launchPersistentContext(root, --profile-directory=profile-001), headed.
 * Then, each case on its own:
 *   P1  plain chrome --user-data-dir=root --profile-directory=profile-002 (same flags a user would get)
 *   P2  P1 + the switches Playwright adds to the FIRST browser (--remote-debugging-pipe, --no-startup-window …)
 *       absent -> does a plain second invocation FORWARD into the running process?
 *   P3  SingletonLock inspection: hostname-pid it points to, our hostname, pid namespace (does the
 *       first browser's pid exist in OUR namespace?), SingletonSocket present?
 *   P4  same plain launch with the first browser started WITHOUT Playwright (plain chrome) ->
 *       does Chromium forward then? (separates "Chromium limit" from "Playwright-started browser")
 * For every case: exit code, stderr head, did a window for profile-002 appear (wmctrl), is the
 * first session still alive (Playwright navigates), processes on the root.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISPLAY = process.env.DISPLAY || ':77';
const exe = chromium.executablePath();
const wins = () => { try { return execFileSync('wmctrl', ['-l', '-p'], { env: { ...process.env, DISPLAY } }).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const procsOn = (root) => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type=')); } catch { return false; } });
function plain(root, dir, extra = []) {
  return new Promise((resolve) => {
    const c = spawn(exe, [`--user-data-dir=${root}`, `--profile-directory=${dir}`, '--no-sandbox', '--no-first-run', '--no-default-browser-check', ...extra, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISPLAY } });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.on('data', (d) => { err += d; });
    let code = null; c.on('exit', (x) => { code = x; });
    setTimeout(() => resolve({ child: c, code, stderr: err.split('\n').filter((l) => /ERROR|Opening in existing|ProcessSingleton|SingletonLock/.test(l)).slice(0, 3).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 220)) }), 7000);
  });
}
async function lockFacts(root) {
  let target = null; try { target = fs.readlinkSync(path.join(root, 'SingletonLock')); } catch {}
  const [host, pid] = target ? [target.slice(0, target.lastIndexOf('-')), Number(target.slice(target.lastIndexOf('-') + 1))] : [null, null];
  return { lockTarget: target, ourHostname: os.hostname(), hostMatches: host === os.hostname(), lockPidAliveHere: pid ? fs.existsSync(`/proc/${pid}`) : null,
    socket: fs.existsSync(path.join(root, 'SingletonSocket')), cookie: fs.existsSync(path.join(root, 'SingletonCookie')) };
}
const out = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's36-'));
// ── First profile under Playwright ──
const rootA = path.join(tmp, 'branch-A'); fs.mkdirSync(rootA);
const ctx = await chromium.launchPersistentContext(rootA, { headless: false, viewport: null, args: ['--no-sandbox', '--profile-directory=profile-001'] });
const page = ctx.pages()[0] || await ctx.newPage(); await page.goto('data:text/html,<title>first</title>');
await sleep(1500);
out.firstUnderPlaywright = { argvHasPipe: fs.readFileSync(`/proc/${procsOn(rootA)[0]}/cmdline`, 'utf8').includes('--remote-debugging-pipe'), windowsBefore: wins().length, lock: await lockFacts(rootA) };
const w0 = wins().length;
const p1 = await plain(rootA, 'profile-002');
let alive = true; try { await page.goto('data:text/html,<title>still</title>', { timeout: 8000 }); alive = (await page.title()) === 'still'; } catch { alive = false; }
out.P1_plainSecondWhilePlaywright = { exitCode: p1.code, stderr: p1.stderr, newWindows: wins().length - w0, profile002Created: fs.existsSync(path.join(rootA, 'profile-002')), firstSessionAlive: alive, processesOnRoot: procsOn(rootA).length, pagesSeenByPlaywright: ctx.pages().length };
try { p1.child.kill(); } catch {}
await ctx.close(); await sleep(1500);
// ── P4: first browser started WITHOUT Playwright ──
const rootB = path.join(tmp, 'branch-B'); fs.mkdirSync(rootB);
const first = spawn(exe, [`--user-data-dir=${rootB}`, '--profile-directory=profile-001', '--no-sandbox', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', env: { ...process.env, DISPLAY } });
await sleep(5000);
out.P4_firstPlain_lock = await lockFacts(rootB);
const w1 = wins().length;
const p4 = await plain(rootB, 'profile-002');
out.P4_plainSecondWhilePlain = { exitCode: p4.code, stderr: p4.stderr, newWindows: wins().length - w1, profile002Created: fs.existsSync(path.join(rootB, 'profile-002')), firstAlive: first.exitCode === null, processesOnRoot: procsOn(rootB).length };
try { p4.child.kill(); } catch {} try { first.kill(); } catch {}
await sleep(1500);
console.log('RESULT ' + JSON.stringify(out, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
