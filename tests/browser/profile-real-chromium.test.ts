/**
 * Phase 1, item 2 — the profile infrastructure with a REAL Chromium on a REAL
 * X display (Xvfb + openbox + wmctrl). Skips (announced) when Chromium or the
 * display tools are missing.
 *
 *   - a created profile, opened by hand, is a VISIBLE Chromium on THAT
 *     profile's user-data-dir (one browser process per profile)
 *   - two profiles open side by side; opening one again brings ITS window to
 *     the front (BrowserWindowManager.focusByUserDataDir), without a 2nd launch
 *   - a manual run on a named profile is visible, an automatic (scheduled)
 *     run on the same profile is hidden (core/RunPolicy), same user-data-dir
 *   - closing saves the tabs into the profile (core/BrowserStateSnapshot)
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeBrowser, ensureProbed } from './real-browser';
import { ProfileManager } from '../../src/core/ProfileManager';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { openProfileBrowser, closeProfileBrowser } from '../../src/core/ProfileBrowser';
import { BrowserSessions, registerBrowserSessions, operatorDependent, browserSessions, jobDependent } from '../../src/core/BrowserSessions';
import { BrowserWindowManager } from '../../src/core/BrowserWindowManager';
import { leaseIdOf, resolveRunProfile } from '../../src/core/ProfileLease';
import { readLastSession } from '../../src/core/BrowserStateSnapshot';
import { headlessFor } from '../../src/core/RunPolicy';
import { runPipeline } from '../../src/pipeline';
import { validateSteps } from '../../src/validation';
import { browserModes } from '../../src/core/BrowserMode';
import { config } from '../../src/config';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb') && has('wmctrl') && has('openbox');
const DISPLAY = ':97';
let xvfb: ChildProcess | null = null; let wm: ChildProcess | null = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-real-'));
let web: http.Server; let url = '';
const prev = { profiles: config.PROFILES_DIR, display: process.env.DISPLAY };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  web = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<title>page ${q.url}</title>`); });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  if (!toolsOk) return;
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await sleep(800);
  process.env.DISPLAY = DISPLAY;
  wm = spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY } });
  await sleep(800);
  (config as any).PROFILES_DIR = tmp;
  registerBrowserSessions(new BrowserSessions(null));
}, 30_000);

afterAll(async () => {
  (config as any).PROFILES_DIR = prev.profiles;
  if (prev.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prev.display;
  wm?.kill(); xvfb?.kill();
  await new Promise((r) => web.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function activeUserDataDir(): Promise<string> {
  const out = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { env: { ...process.env, DISPLAY } }).toString();
  const id = (out.match(/#\s*(0x[0-9a-f]+)/i) || [])[1] || '';
  const list = execFileSync('wmctrl', ['-l', '-p'], { env: { ...process.env, DISPLAY } }).toString();
  const row = list.split('\n').find((l) => l.trim() && parseInt(l.split(/\s+/)[0]!, 16) === parseInt(id, 16));
  const pid = row ? Number(row.trim().split(/\s+/)[2]) : 0;
  const cmd = pid ? fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') : '';
  return (cmd.split('\0').find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length);
}

(toolsOk ? describeBrowser : (n: string, f: () => void) => describeBrowser(`${n} (SKIPPED: Xvfb/openbox/wmctrl missing)`, () => { it.skip('needs an X display', f as never); }))(
  'profiles on a real Chromium + X display', () => {
    const userId = 'real-user';
    const reg = new ProfileRegistry(tmp);
    const pm = new ProfileManager();

    it('two created profiles open as two visible browsers; re-opening one raises ITS window', async () => {
      const a = await reg.create(userId, 'Shop A');
      const b = await reg.create(userId, 'Shop B');
      const dirA = reg.dirOf(userId, a.id); const dirB = reg.dirOf(userId, b.id);
      const ra = await openProfileBrowser(pm, { leaseId: leaseIdOf(a.id), userId, userDataDir: dirA, owner: 'wf_aaaaaa' });
      const rb = await openProfileBrowser(pm, { leaseId: leaseIdOf(b.id), userId, userDataDir: dirB, owner: 'wf_aaaaaa' });
      expect(ra).toEqual({ reused: false, visibility: 'visible' });
      expect(rb.visibility).toBe('visible');
      await pm.getVipContext(leaseIdOf(a.id))!.context.pages()[0]!.goto(`${url}/a`);
      await pm.getVipContext(leaseIdOf(b.id))!.context.pages()[0]!.goto(`${url}/b`);
      await sleep(1500);
      // Two real windows on the display, one per profile directory.
      const wins = await BrowserWindowManager.list();
      expect(wins.filter((w) => w.source === 'x11').length).toBeGreaterThanOrEqual(2);
      // B was opened last; raising A puts A in front.
      const fa = await BrowserWindowManager.focusByUserDataDir(dirA);
      expect(fa).toBeTruthy();
      await sleep(500);
      expect(path.resolve(await activeUserDataDir())).toBe(path.resolve(dirA));
      const fb = await BrowserWindowManager.focusByUserDataDir(dirB);
      expect(fb).toBeTruthy();
      await sleep(500);
      expect(path.resolve(await activeUserDataDir())).toBe(path.resolve(dirB));
      // Opening A again reuses its browser (no second process).
      const again = await openProfileBrowser(pm, { leaseId: leaseIdOf(a.id), userId, userDataDir: dirA, owner: 'wf_aaaaaa' });
      expect(again.reused).toBe(true);
      // Close: tabs are saved into the profile first.
      for (const [p, d] of [[a, dirA], [b, dirB]] as const) {
        const r = await closeProfileBrowser(pm, leaseIdOf(p.id), operatorDependent('wf_aaaaaa'));
        expect(r.closed).toBe(true);
        const snap = await readLastSession(d);
        expect(snap!.tabs[0]!.url).toContain(url);
      }
    }, 90_000);

    it('manual run on a named profile = visible, scheduled run on the same profile = hidden', async () => {
      const p = await reg.create(userId, 'Runs');
      (browserModes as any).modes?.delete?.(userId);
      const ref = resolveRunProfile({ userId, profileId: p.id, usesExtensions: false, localMode: false, profilesDir: tmp, realChromeDir: '' });
      expect(ref.userDataDir).toBe(reg.dirOf(userId, p.id));
      const plan = { quota: 0, maxTabs: 5, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0 } as never;
      const quota = { hasQuotaRemaining: async () => true, consumeQuota: async () => true } as never;
      const runOnce = async (origin: 'manual' | 'automatic', jobId: string) => {
        const logs: string[] = [];
        await runPipeline({
          userId, steps: validateSteps([{ action: 'launch', params: { url: `${url}/${origin}` } }] as never, config.FULL_ACCESS_PLAN) as never,
          headless: headlessFor(origin), origin, profile: ref, log: (m: string) => logs.push(m), jobId, profileManager: pm, userPlan: plan, quotaManager: quota,
        } as never);
        // What the worker does when a run ends (src/index.ts finally): the run stops depending on the browser.
        browserSessions().detach(ref.id, jobDependent(jobId));
        return logs.join('\n');
      };
      const manual = await runOnce('manual', 'job-manual');
      expect(manual).toMatch(/visible browser/);
      await sleep(800);
      // The visible run put a real window of THIS profile on the display.
      expect(await BrowserWindowManager.focusByUserDataDir(ref.userDataDir!)).toBeTruthy();
      const auto = await runOnce('automatic', 'job-auto');
      // Visibility differs -> the browser is relaunched hidden on the same profile directory.
      expect(auto).toMatch(/hidden browser/);
      await sleep(800);
      expect(await BrowserWindowManager.focusByUserDataDir(ref.userDataDir!)).toBeNull();
      const entry = pm.getVipContext(ref.id);
      await entry?.context.close().catch(() => {});
    }, 120_000);
  });
