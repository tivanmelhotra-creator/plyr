/**
 * Phase 1, item 2 — the profile infrastructure with a REAL Chromium on a REAL
 * X display (Xvfb + openbox + wmctrl). Skips (announced) when Chromium or the
 * display tools are missing.
 *
 *   - branch model (core/BranchRegistry): a profile created in a NEW branch is
 *     a VISIBLE Chromium on THAT branch's root (--user-data-dir) with its own
 *     folder (--profile-directory=profile-NNN); one browser process per branch
 *   - two profiles of ONE branch: the second open is refused (branch_busy,
 *     the running profile named) and no second Chromium process is started
 *   - two profiles open side by side; opening one again brings ITS window to
 *     the front (BrowserWindowManager.focusByUserDataDir), without a 2nd launch
 *   - a manual run on a named profile is visible, an automatic (scheduled)
 *     run on the same profile is hidden (core/RunPolicy), same user-data-dir
 *   - closing saves the tabs into the profile's own folder (core/BrowserStateSnapshot)
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
import { buildLaunchArgs } from '../../src/core/LaunchSettings';
import { readChromiumProfileName } from '../../src/core/ChromiumProfileName';
import { summarize, closeContextBounded } from '../../src/core/SharedBrowsers';
import { resolveChromiumProfile, PIN_FILE } from '../../src/core/ChromiumProfileLocation';
import { chromium } from 'playwright';

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
  // Chromium may still be flushing files of a just-closed profile.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* tmp dir, best-effort */ }
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
    /** What the /profiles/:id/open route passes (src/Routes/profile.routes.ts). */
    const openInput = (p: { id: string; name: string; folder: string }, owner: string, extra: Record<string, unknown> = {}) => ({
      leaseId: leaseIdOf(p.id), userId, userDataDir: reg.dirOf(userId, p.id), owner,
      profileDirectory: p.folder, profileId: p.id, displayName: p.name, ...extra,
    });

    it('two created profiles open as two visible browsers; re-opening one raises ITS window', async () => {
      const a = await reg.create(userId, 'Shop A');
      const b = await reg.create(userId, 'Shop B');
      const dirA = reg.dirOf(userId, a.id); const dirB = reg.dirOf(userId, b.id);
      expect(dirA).not.toBe(dirB); // a new profile without a branch gets a NEW branch
      expect(a.folder).toBe('profile-001');
      const ra = await openProfileBrowser(pm, openInput(a, 'wf_aaaaaa'));
      const rb = await openProfileBrowser(pm, openInput(b, 'wf_aaaaaa'));
      expect(ra).toMatchObject({ reused: false, visibility: 'visible', settingsApplied: true });
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
      const again = await openProfileBrowser(pm, openInput(a, 'wf_aaaaaa'));
      expect(again.reused).toBe(true);
      // Close: tabs are saved into the profile first.
      for (const p of [a, b]) {
        const r = await closeProfileBrowser(pm, leaseIdOf(p.id), operatorDependent('wf_aaaaaa'));
        expect(r.closed).toBe(true);
        const snap = await readLastSession(reg.profilePathOf(userId, p.id));
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
      // The run's browser selected the profile's root + pinned directory (same rule as Local Browser / Browser Profiles).
      const runCtx = pm.getVipContext(ref.id)!.context;
      const vp = await runCtx.newPage(); await vp.goto('chrome://version');
      expect(ref.profileDirectory).toBe(p.folder);
      expect((await vp.locator('#profile_path').innerText()).trim()).toBe(path.join(ref.userDataDir!, p.folder));
      await vp.close();
      expect(manual).toMatch(/Profile data: profile-001 \(registry\)/);
      const auto = await runOnce('automatic', 'job-auto');
      // Visibility differs -> the browser is relaunched hidden on the same profile directory.
      expect(auto).toMatch(/hidden browser/);
      await sleep(800);
      expect(await BrowserWindowManager.focusByUserDataDir(ref.userDataDir!)).toBeNull();
      const entry = pm.getVipContext(ref.id);
      await entry?.context.close().catch(() => {});
    }, 120_000);
  
    it('phase 1: name 22 in Chromium, presets/custom flags in the real argv, independent data, close one keeps the other', async () => {
      const a = await reg.create(userId, '22');
      const b = await reg.create(userId, 'Second');
      const dirA = reg.dirOf(userId, a.id); const dirB = reg.dirOf(userId, b.id);
      expect(dirA).not.toBe(dirB);
      const auto = buildLaunchArgs({ preset: 'automation', customFlags: '--lang=fa' });
      expect(auto.ok).toBe(true);
      await openProfileBrowser(pm, openInput(a, 'wf_bbbbbb', { launch: { args: auto.args, hash: auto.hash, explicit: true } }));
      await openProfileBrowser(pm, openInput(b, 'wf_bbbbbb'));
      // The name Chromium itself uses for the profile (its folder in the branch root).
      expect(await readChromiumProfileName(dirA, a.folder)).toBe('22');
      expect(await readChromiumProfileName(dirB, b.folder)).toBe('Second');
      // The real process arguments: A has the preset + custom flag, B (Standard) does not; each its own dir.
      const argvOf = (dir: string): string[] => {
        for (const pidS of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
          let cmd = '';
          try { cmd = fs.readFileSync(`/proc/${pidS}/cmdline`, 'utf8'); } catch { continue; }
          const args = cmd.split('\0');
          if (args.includes(`--user-data-dir=${dir}`) && !args.some((x) => x.startsWith('--type='))) return args;
        }
        return [];
      };
      const argA = argvOf(dirA); const argB = argvOf(dirB);
      expect(argA).toContain('--lang=fa');
      expect(argA).toContain('--no-first-run');
      expect(argA.some((x) => x === '--headless' || x.startsWith('--headless='))).toBe(false);
      expect(argB).not.toContain('--lang=fa');
      // Independent data: a cookie set in A is not in B; it survives A's close + reopen.
      const ctxA = pm.getVipContext(leaseIdOf(a.id))!.context;
      const ctxB = pm.getVipContext(leaseIdOf(b.id))!.context;
      await ctxA.pages()[0]!.goto(`${url}/a`);
      await ctxB.pages()[0]!.goto(`${url}/b`);
      await ctxA.addCookies([{ name: 'who', value: 'A', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      expect((await ctxB.cookies(url)).some((c) => c.name === 'who')).toBe(false);
      // The shared session view lists both, by registry name.
      expect(summarize(browserSessions().list(), (id) => ({ [a.id]: '22', [b.id]: 'Second' } as Record<string, string>)[id]).map((x) => x.name).sort()).toEqual(['22', 'Second']);
      // Task View labels the windows with the registry names.
      BrowserWindowManager.setProfileResolver(async (d) => (path.resolve(d) === path.resolve(dirA) ? { id: a.id, name: '22' } : path.resolve(d) === path.resolve(dirB) ? { id: b.id, name: 'Second' } : null));
      await sleep(1000);
      const names = (await BrowserWindowManager.list()).filter((w) => w.source === 'x11').map((w) => w.profileName);
      expect(names).toEqual(expect.arrayContaining(['22', 'Second']));
      BrowserWindowManager.setProfileResolver(null);
      // Close A: B keeps working.
      expect((await closeProfileBrowser(pm, leaseIdOf(a.id), operatorDependent('wf_bbbbbb'))).closed).toBe(true);
      await ctxB.pages()[0]!.goto(`${url}/b2`);
      expect(ctxB.pages()[0]!.url()).toContain('/b2');
      // Reopen A: its cookie (persistent data) is still there.
      await openProfileBrowser(pm, openInput(a, 'wf_bbbbbb'));
      const ctxA2 = pm.getVipContext(leaseIdOf(a.id))!.context;
      expect((await ctxA2.cookies(url)).find((c) => c.name === 'who')?.value).toBe('A');
      for (const id of [a.id, b.id]) {
        const e = pm.getVipContext(leaseIdOf(id));
        if (e) await closeContextBounded(e.context);
        browserSessions().closed(leaseIdOf(id));
      }
    }, 120_000);
    /** What chrome://version says this context really opened. */
    const profilePathOf = async (ctx: import('playwright').BrowserContext): Promise<string> => {
      const pg = await ctx.newPage();
      try { await pg.goto('chrome://version'); return (await pg.locator('#profile_path').innerText()).trim(); } finally { await pg.close().catch(() => {}); }
    };
    /** The real browser process' argv for a root (not a renderer/GPU child). */
    const argvOfRoot = (dir: string): string[] => {
      for (const pidS of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${pidS}/cmdline`, 'utf8'); } catch { continue; }
        const args = cmd.split('\0');
        if (args.includes(`--user-data-dir=${dir}`) && !args.some((x) => x.startsWith('--type='))) return args;
      }
      return [];
    };

    it('selection: branch root + explicit --profile-directory (registry folder); chrome://version Profile Path is the intended one; data persists; two at once', async () => {
      const a = await reg.create(userId, 'Sel A');
      const b = await reg.create(userId, 'Sel B');
      const dirA = reg.dirOf(userId, a.id); const dirB = reg.dirOf(userId, b.id);
      await openProfileBrowser(pm, openInput(a, 'wf_cccccc'));
      await openProfileBrowser(pm, openInput(b, 'wf_cccccc'));
      const ctxA = pm.getVipContext(leaseIdOf(a.id))!.context;
      const ctxB = pm.getVipContext(leaseIdOf(b.id))!.context;
      // Actual Profile Path, from Chromium itself.
      expect(await profilePathOf(ctxA)).toBe(path.join(dirA, a.folder));
      expect(await profilePathOf(ctxB)).toBe(path.join(dirB, b.folder));
      expect(reg.profilePathOf(userId, a.id)).toBe(path.join(dirA, a.folder));
      // Real argv: own root, exactly one --profile-directory, two separate processes at the same time.
      const argA = argvOfRoot(dirA); const argB = argvOfRoot(dirB);
      expect(argA.filter((x) => x.startsWith('--profile-directory=')).length).toBe(1);
      expect(argA).toContain(`--profile-directory=${a.folder}`);
      expect(argB).toContain(`--profile-directory=${b.folder}`);
      expect(argA.some((x) => x.startsWith('--user-data-dir=') && x.endsWith(a.folder))).toBe(false); // a folder is never a root
      // The registry names the folder: no pin file, Local State not consulted.
      expect(fs.existsSync(path.join(dirA, PIN_FILE))).toBe(false);
      // Independent data, persisted across close + reopen.
      await ctxA.addCookies([{ name: 'sel', value: 'A', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      expect((await ctxB.cookies(url)).some((c) => c.name === 'sel')).toBe(false);
      expect((await closeProfileBrowser(pm, leaseIdOf(a.id), operatorDependent('wf_cccccc'))).closed).toBe(true);
      // Chromium's own last_used is changed behind our back (e.g. its profile menu): the explicit folder still wins.
      fs.mkdirSync(path.join(dirA, 'Profile 7'), { recursive: true });
      const lsFile = path.join(dirA, 'Local State');
      const ls = JSON.parse(fs.readFileSync(lsFile, 'utf8')); ls.profile.last_used = 'Profile 7'; fs.writeFileSync(lsFile, JSON.stringify(ls));
      await openProfileBrowser(pm, openInput(a, 'wf_cccccc'));
      const ctxA2 = pm.getVipContext(leaseIdOf(a.id))!.context;
      expect(await profilePathOf(ctxA2)).toBe(path.join(dirA, a.folder));
      expect((await ctxA2.cookies(url)).find((c) => c.name === 'sel')?.value).toBe('A');
      for (const id of [a.id, b.id]) {
        const e = pm.getVipContext(leaseIdOf(id));
        if (e) await closeContextBounded(e.context);
        browserSessions().closed(leaseIdOf(id));
      }
    }, 120_000);

    it('branch model: two profiles of ONE branch share the root; the 2nd open is refused (branch_busy names the running one), no 2nd process; after close the 2nd opens its own folder', async () => {
      const a = await reg.create(userId, 'Same A');
      const b = await reg.create(userId, 'Same B', { branchId: a.branchId });
      expect(b.branchId).toBe(a.branchId);
      expect(b.folder).toBe('profile-002');
      const root = reg.dirOf(userId, a.id);
      expect(reg.dirOf(userId, b.id)).toBe(root);
      expect(leaseIdOf(b.id)).toBe(leaseIdOf(a.id)); // one lock per branch
      const procsOf = (dir: string) => fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).filter((pid) => {
        try { const a2 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); return a2.includes(`--user-data-dir=${dir}`) && !a2.some((x) => x.startsWith('--type=')); } catch { return false; }
      }).length;
      await openProfileBrowser(pm, openInput(a, 'wf_eeeeee'));
      expect(procsOf(root)).toBe(1);
      let err: any = null;
      try { await openProfileBrowser(pm, openInput(b, 'wf_eeeeee')); } catch (e) { err = e; }
      expect(err?.code).toBe('branch_busy');
      expect(err?.runningProfileId).toBe(a.id);
      expect(procsOf(root)).toBe(1); // nothing new was launched
      // Opening the running profile again reuses it (no second process).
      expect((await openProfileBrowser(pm, openInput(a, 'wf_eeeeee'))).reused).toBe(true);
      expect(procsOf(root)).toBe(1);
      const ctxA = pm.getVipContext(leaseIdOf(a.id))!.context;
      expect(await profilePathOf(ctxA)).toBe(path.join(root, a.folder));
      await ctxA.addCookies([{ name: 'branch', value: 'A', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      expect((await closeProfileBrowser(pm, leaseIdOf(a.id), operatorDependent('wf_eeeeee'))).closed).toBe(true);
      // Now B may run: same root, its OWN folder, its own (empty) cookies.
      await openProfileBrowser(pm, openInput(b, 'wf_eeeeee'));
      const ctxB = pm.getVipContext(leaseIdOf(b.id))!.context;
      expect(await profilePathOf(ctxB)).toBe(path.join(root, b.folder));
      expect((await ctxB.cookies(url)).some((c) => c.name === 'branch')).toBe(false);
      expect(argvOfRoot(root)).toContain(`--profile-directory=${b.folder}`);
      await closeContextBounded(ctxB);
      browserSessions().closed(leaseIdOf(b.id));
    }, 120_000);

    it('a NEW profile has the project extension (Element Inspector) loaded, like the Local Browser', async () => {
      const prevExt = config.REAL_CHROME_EXTENSIONS_DIR;
      (config as any).REAL_CHROME_EXTENSIONS_DIR = path.join(tmp, 'extensions');
      try {
        const p = await reg.create(userId, 'With extension');
        await openProfileBrowser(pm, openInput(p, 'wf_ffffff'));
        const ctx = pm.getVipContext(leaseIdOf(p.id))!.context;
        expect(argvOfRoot(reg.dirOf(userId, p.id)).some((a) => a.startsWith('--load-extension=') && a.includes('ab-inspector'))).toBe(true);
        expect(argvOfRoot(reg.dirOf(userId, p.id))).not.toContain('--disable-extensions');
        // Chromium itself: the extension's service worker runs in this profile.
        const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))
          || await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
        expect(sw?.url()).toMatch(/^chrome-extension:\/\//);
        await closeContextBounded(ctx);
        browserSessions().closed(leaseIdOf(p.id));
      } finally { (config as any).REAL_CHROME_EXTENSIONS_DIR = prevExt; }
    }, 120_000);

    it('an existing root that used another profile directory is adopted as it is: same data, nothing moved', async () => {
      // A pre-existing user-data root (as an older Local Browser / profile could have left it):
      // its data lives in "Profile 1" and Chromium's last_used points there.
      const legacy = path.join(tmp, 'legacy-root');
      const seed = await chromium.launchPersistentContext(legacy, { headless: false, args: ['--no-sandbox', '--profile-directory=Profile 1'], env: { ...process.env, DISPLAY } });
      await seed.addCookies([{ name: 'legacy', value: 'kept', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      await seed.close();
      expect(fs.existsSync(path.join(legacy, PIN_FILE))).toBe(false);
      const before = fs.readdirSync(legacy).sort();
      const loc = await resolveChromiumProfile(legacy);
      expect(loc).toMatchObject({ profileDirectory: 'Profile 1', source: 'adopted-last-used' });
      await openProfileBrowser(pm, { leaseId: 'named:legacy-root', userId, userDataDir: legacy, owner: 'wf_dddddd' });
      const ctx = pm.getVipContext('named:legacy-root')!.context;
      expect(await profilePathOf(ctx)).toBe(path.join(legacy, 'Profile 1'));
      expect((await ctx.cookies(url)).find((c) => c.name === 'legacy')?.value).toBe('kept');
      // Nothing deleted or relocated: every entry that was there is still there.
      for (const n of before) expect(fs.existsSync(path.join(legacy, n))).toBe(true);
      await closeContextBounded(ctx);
      browserSessions().closed('named:legacy-root');
    }, 120_000);

    it('why one root per BRANCH runs one profile at a time: Chromium allows ONE process per root, a 2nd profile on it cannot be launched separately', async () => {
      const shared = path.join(tmp, 'shared-root');
      const env = { ...process.env, DISPLAY };
      const first = await chromium.launchPersistentContext(shared, { headless: false, args: ['--no-sandbox', '--profile-directory=Profile A'], env });
      let err = '';
      try {
        const second = await chromium.launchPersistentContext(shared, { headless: false, timeout: 20_000, args: ['--no-sandbox', '--profile-directory=Profile B'], env });
        await second.close();
      } catch (e) { err = (e as Error).message; }
      expect(err).toMatch(/ProcessSingleton|already in use/i);
      // The first browser is unaffected and still usable.
      const pg = await first.newPage();
      expect(pg.url()).toBe('about:blank');
      await first.close();
    }, 90_000);
  });
