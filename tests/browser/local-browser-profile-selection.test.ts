/**
 * The Local Browser (core/RealChrome) — the launch baseline Browser Profiles
 * follow — selects its data with root + pinned `--profile-directory`
 * (core/ChromiumProfileLocation). Real Chromium on a real X display.
 *
 *   - a fresh REAL_CHROME_USER_DATA_DIR opens `<root>/Default` (chrome://version)
 *   - an existing root whose data is in another profile directory is ADOPTED:
 *     same data, nothing moved, the pref fixes go to THAT directory
 *   - a Browser Profile and the Local Browser run at the same time, each its own process
 */
import { it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { describeBrowser, ensureProbed } from './real-browser';
import { config } from '../../src/config';
import { RealChrome } from '../../src/core/RealChrome';
import { PIN_FILE } from '../../src/core/ChromiumProfileLocation';
import { ProfileManager } from '../../src/core/ProfileManager';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { openProfileBrowser } from '../../src/core/ProfileBrowser';
import { BrowserSessions, registerBrowserSessions, browserSessions } from '../../src/core/BrowserSessions';
import { leaseIdOf } from '../../src/core/ProfileLease';
import { closeContextBounded } from '../../src/core/SharedBrowsers';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb');
const DISPLAY = ':96';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-lb-'));
let xvfb: ChildProcess | null = null;
const prev = {
  udd: config.REAL_CHROME_USER_DATA_DIR, ext: config.REAL_CHROME_EXTENSIONS_DIR,
  enabled: config.REAL_CHROME_ENABLED, display: process.env.DISPLAY, profiles: config.PROFILES_DIR,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!toolsOk) return;
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await sleep(800);
  process.env.DISPLAY = DISPLAY;
  (config as any).REAL_CHROME_EXTENSIONS_DIR = path.join(tmp, 'extensions');
  (config as any).PROFILES_DIR = path.join(tmp, 'profiles');
  config.REAL_CHROME_ENABLED = true;
  registerBrowserSessions(new BrowserSessions(null));
}, 30_000);

afterAll(async () => {
  await RealChrome.stop().catch(() => {});
  (config as any).REAL_CHROME_USER_DATA_DIR = prev.udd;
  (config as any).REAL_CHROME_EXTENSIONS_DIR = prev.ext;
  (config as any).PROFILES_DIR = prev.profiles;
  config.REAL_CHROME_ENABLED = prev.enabled;
  if (prev.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prev.display;
  xvfb?.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best-effort */ }
});

// A failed assertion must not leave this Local Browser running into the next test.
afterEach(async () => { await RealChrome.stop().catch(() => {}); });

async function profilePath(ctx: import('playwright').BrowserContext): Promise<string> {
  const pg = await ctx.newPage();
  try { await pg.goto('chrome://version'); return (await pg.locator('#profile_path').innerText()).trim(); } finally { await pg.close().catch(() => {}); }
}

(toolsOk ? describeBrowser : (n: string, f: () => void) => describeBrowser(`${n} (SKIPPED: Xvfb missing)`, () => { it.skip('needs an X display', f as never); }))(
  'Local Browser: root + pinned --profile-directory', () => {
    it('a fresh root opens <root>/Default and pins it', async () => {
      const root = path.join(tmp, 'fresh-root');
      (config as any).REAL_CHROME_USER_DATA_DIR = root;
      const ctx = await RealChrome.getContext();
      expect(await profilePath(ctx)).toBe(path.join(root, 'Default'));
      expect(RealChrome.profileLocation()).toMatchObject({ userDataRoot: root, profileDirectory: 'Default' });
      expect(JSON.parse(fs.readFileSync(path.join(root, PIN_FILE), 'utf8')).profileDirectory).toBe('Default');
      // Simultaneous use: a Browser Profile opens next to the Local Browser, own root, own process.
      const reg = new ProfileRegistry(config.PROFILES_DIR);
      const p = await reg.create('local', 'Beside');
      const pm = new ProfileManager();
      await openProfileBrowser(pm, { leaseId: leaseIdOf(p.id), userId: 'local', userDataDir: reg.dirOf('local', p.id), owner: 'wf_eeeeee', displayName: 'Beside' });
      const pctx = pm.getVipContext(leaseIdOf(p.id))!.context;
      expect(await profilePath(pctx)).toBe(path.join(reg.dirOf('local', p.id), 'Default'));
      expect(await profilePath(ctx)).toBe(path.join(root, 'Default')); // the Local Browser is untouched
      expect(browserSessions().list().map((s) => s.leaseId)).toEqual(expect.arrayContaining(['realchrome', leaseIdOf(p.id)]));
      await closeContextBounded(pctx);
      browserSessions().closed(leaseIdOf(p.id));
      await RealChrome.stop();
    }, 120_000);

    it('an existing root with data in another profile directory is adopted, nothing moved', async () => {
      const root = path.join(tmp, 'existing-root');
      const url = 'https://example.com/';
      const seed = await chromium.launchPersistentContext(root, { headless: false, args: ['--no-sandbox', '--profile-directory=Profile 2'], env: { ...process.env, DISPLAY } });
      await seed.addCookies([{ name: 'mine', value: 'kept', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      await seed.close();
      const before = fs.readdirSync(root);
      (config as any).REAL_CHROME_USER_DATA_DIR = root;
      const ctx = await RealChrome.getContext();
      expect(await profilePath(ctx)).toBe(path.join(root, 'Profile 2'));
      expect(RealChrome.profileLocation()).toMatchObject({ profileDirectory: 'Profile 2', source: 'adopted-last-used' });
      expect((await ctx.cookies(url)).find((c) => c.name === 'mine')?.value).toBe('kept');
      // The pref fixes went to the directory in use, and no empty Default was created next to it.
      const prefs = JSON.parse(fs.readFileSync(path.join(root, 'Profile 2', 'Preferences'), 'utf8'));
      expect(prefs.browser?.custom_chrome_frame).toBe(false);
      expect(fs.existsSync(path.join(root, 'Default'))).toBe(false);
      for (const n of before) expect(fs.existsSync(path.join(root, n))).toBe(true);
      await RealChrome.stop();
    }, 120_000);
  });
