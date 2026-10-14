/**
 * Crash cleanup (owner's brief, section 7) with REAL Chromium processes:
 *
 *   - a leftover Chromium on an Aria root whose server died (re-parented,
 *     no Node ancestor) is stopped and its stale SingletonLock removed
 *   - a Chromium launched by THIS process (an active run / profile browser)
 *     is never killed and its lock is kept
 *   - a Chromium outside Aria's areas (a personal browser) is never touched
 *   - pure rules: renderer children, other Node owners, areas
 */
import { it, expect, describe, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { describeBrowser, ensureProbed } from './real-browser';
import { findOrphans, reapOrphans, lockedRootsUnder } from '../../src/core/OrphanBrowsers';

await ensureProbed();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-orphan-'));
const area = path.join(tmp, 'aria');
const outside = path.join(tmp, 'personal');
// SingletonLock is a SYMLINK to "<host>-<pid>": existsSync follows it and says false.
const locked = (root: string) => { try { fs.lstatSync(path.join(root, 'SingletonLock')); return true; } catch { return false; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const killLater: number[] = [];
// Headed, like production: a HEADLESS Chromium takes no SingletonLock at all.
const DISPLAY = ':95';
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1024x768x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
xvfb.on('error', () => { /* missing Xvfb: the launches below fail and say so */ });
const env = { ...process.env, DISPLAY };
afterAll(() => {
  xvfb.kill();
  for (const p of killLater) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('orphan rules (pure)', () => {
  const exe = '/opt/chromium/chrome';
  it('a browser inside an area with no Node ancestor is an orphan; children, owned and outside ones are not', () => {
    const procs = [
      { pid: 1, ppid: 0, args: ['/sbin/init'] },
      { pid: 10, ppid: 1, args: [exe, '--user-data-dir=/a/branch-001'] },                 // orphan
      { pid: 11, ppid: 10, args: [exe, '--type=renderer', '--user-data-dir=/a/branch-001'] }, // its child
      { pid: 20, ppid: 1, args: ['/usr/bin/node', 'dist/index.js'] },                     // another server
      { pid: 21, ppid: 20, args: [exe, '--user-data-dir=/a/branch-002'] },                // owned by it
      { pid: 30, ppid: 99, args: [exe, '--user-data-dir=/a/branch-003'] },                // child of self
      { pid: 99, ppid: 1, args: ['self'] },
      { pid: 40, ppid: 1, args: [exe, '--user-data-dir=/home/u/.config/chromium'] },      // personal
      { pid: 50, ppid: 1, args: [exe, '--user-data-dir=/a2/x'] },                         // prefix trap
    ];
    expect(findOrphans(procs, ['/a'], 99)).toEqual([{ pid: 10, userDataDir: path.resolve('/a/branch-001') }]);
  });
  it('a listing failure kills nothing and unlocks nothing', async () => {
    const r = await reapOrphans([area], { list: async () => { throw new Error('no ps'); } });
    expect(r).toMatchObject({ killed: [], unlocked: [] });
    expect(r.skipped).toMatch(/nothing was killed/);
  });
});

describeBrowser('orphan cleanup with real Chromium', () => {
  it('stops the leftover of a dead server, keeps our own browser and a personal one, unlocks only the dead root', async () => {
    const exe = chromium.executablePath();
    const orphanRoot = path.join(area, 'branch-001');
    const personalRoot = path.join(outside, 'User Data');
    const ownRoot = path.join(area, 'branch-002');
    for (const d of [orphanRoot, personalRoot, ownRoot]) fs.mkdirSync(d, { recursive: true });
    await sleep(800);
    const args = (root: string) => ['--no-sandbox', '--no-first-run', `--user-data-dir=${root}`, '--profile-directory=profile-001', 'about:blank'];
    // A dead server's browser: started through a shell that exits at once,
    // so Chromium is re-parented (no Node ancestor) — like after a crash.
    const sh = (root: string) => spawn('sh', ['-c', `setsid "${exe}" ${args(root).map((a) => `'${a}'`).join(' ')} </dev/null >/dev/null 2>&1 & echo $!`], { stdio: ['ignore', 'pipe', 'ignore'], env });
    const pidOf = (p: ReturnType<typeof sh>) => new Promise<number>((r) => { let o = ''; p.stdout!.on('data', (d) => (o += d)); p.on('close', () => r(Number(o.trim()))); });
    const orphanPid = await pidOf(sh(orphanRoot));
    const personalPid = await pidOf(sh(personalRoot));
    killLater.push(orphanPid, personalPid);
    // Our own (an active run): a Playwright child of this process.
    const own = await chromium.launchPersistentContext(ownRoot, { headless: false, env, args: ['--no-sandbox', '--profile-directory=profile-001'] });
    await sleep(2500);
    expect(alive(orphanPid)).toBe(true);
    expect(locked(orphanRoot)).toBe(true);
    expect(locked(ownRoot)).toBe(true);

    const roots = await lockedRootsUnder(area);
    expect(roots.sort()).toEqual([orphanRoot, ownRoot].sort());
    const r = await reapOrphans([area], { roots, graceMs: 5000 });

    expect(r.killed.map((k) => k.pid)).toEqual([orphanPid]);
    expect(alive(orphanPid)).toBe(false);
    expect(alive(personalPid)).toBe(true);              // outside Aria: untouched
    expect(r.unlocked).toEqual([orphanRoot]);
    expect(locked(orphanRoot)).toBe(false);
    expect(locked(ownRoot)).toBe(true); // still held by our live browser
    // Our browser still works.
    const pg = await own.newPage();
    expect(pg.url()).toBe('about:blank');
    await own.close();
    // The dead root opens again (no "profile in use").
    const again = await chromium.launchPersistentContext(orphanRoot, { headless: false, env, timeout: 20_000, args: ['--no-sandbox', '--profile-directory=profile-001'] });
    await again.close();
  }, 90_000);
});
