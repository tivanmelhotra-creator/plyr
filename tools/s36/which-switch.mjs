/**
 * G.1 follow-up: WHICH of Playwright's launch switches makes the running browser refuse
 * the ProcessSingleton forward (exit 21)? Start the FIRST browser plainly with Playwright's
 * exact argv minus one group at a time, then a plain second --profile-directory launch.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = chromium.executablePath();
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':77' };
// 1. Capture Playwright's real argv.
const t0 = fs.mkdtempSync(path.join(os.tmpdir(), 's36w-'));
const ctx = await chromium.launchPersistentContext(t0, { headless: false, viewport: null, args: ['--no-sandbox'] });
await sleep(1000);
const pid = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).find((p) => { try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.includes(`--user-data-dir=${t0}`) && !a.some((x) => x.startsWith('--type=')); } catch { return false; } });
const pwArgs = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(1).filter(Boolean).filter((a) => !a.startsWith('--user-data-dir=') && a !== 'about:blank');
await ctx.close();
console.log('PLAYWRIGHT_ARGV ' + JSON.stringify(pwArgs));
async function trial(label, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's36t-'));
  const first = spawn(exe, [`--user-data-dir=${root}`, '--profile-directory=profile-001', ...args.filter((a) => a !== '--remote-debugging-pipe'), ...(args.includes('--remote-debugging-pipe') ? ['--remote-debugging-pipe'] : []), 'about:blank'],
    { stdio: args.includes('--remote-debugging-pipe') ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore', env });
  await sleep(4000);
  const second = spawn(exe, [`--user-data-dir=${root}`, '--profile-directory=profile-002', '--no-sandbox', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let err = ''; second.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => { second.on('exit', r); setTimeout(() => r('still-running'), 8000); });
  const forwarded = /Opening in existing browser session/.test(err);
  console.log(`TRIAL ${label}: second exit=${code} forwarded=${forwarded} profile-002 created=${fs.existsSync(path.join(root, 'profile-002'))}`);
  try { second.kill(); } catch {} try { first.kill('SIGKILL'); } catch {}
  await sleep(1000); fs.rmSync(root, { recursive: true, force: true });
}
await trial('all playwright switches', pwArgs);
await trial('without --remote-debugging-pipe', pwArgs.filter((a) => a !== '--remote-debugging-pipe'));
await trial('without --no-startup-window', pwArgs.filter((a) => a !== '--no-startup-window'));
await trial('without --enable-automation', pwArgs.filter((a) => a !== '--enable-automation'));
await trial('only --remote-debugging-pipe + --no-sandbox', ['--remote-debugging-pipe', '--no-sandbox']);
await trial('only --no-sandbox (plain)', ['--no-sandbox']);
fs.rmSync(t0, { recursive: true, force: true });
