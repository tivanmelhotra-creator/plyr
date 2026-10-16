/**
 * Owner brief 2 / B (and brief 4.5 / 2.6) with REAL Chromium on Xvfb, the REAL
 * /profiles routes and the REAL panel (public/js/profile-manager.js) in a
 * second, real Chromium (the operator's browser):
 *
 *   - Play on a CLOSED profile launches its browser AND opens ONE viewer tab;
 *   - on a RUNNING profile Play does not exist; the external-link icon takes
 *     its place. It never launches or relaunches (no POST /open, the browser
 *     process keeps its pid); clicking it twice keeps ONE browser process,
 *     ONE session and ONE viewer tab (focused, not duplicated);
 *   - close the viewer tab, click the link -> a NEW viewer tab shows the SAME
 *     browser (same pid);
 *   - a Play double click launches once.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { chromium, type Browser } from 'playwright';
import request from 'supertest';
import IORedis from 'ioredis';
import { describeBrowser, ensureProbed } from './real-browser';
import { config } from '../../src/config';
import { ProfileManager } from '../../src/core/ProfileManager';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileLeases, leaseIdOf } from '../../src/core/ProfileLease';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { ProfileAccess, registerProfileAccess } from '../../src/core/ProfileAccess';
import { BrowserSessions, registerBrowserSessions } from '../../src/core/BrowserSessions';
import { closeContextBounded } from '../../src/core/SharedBrowsers';
import { createProfileRoutes } from '../../src/Routes/profile.routes';
import { browserSessions } from '../../src/core/BrowserSessions';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb') && has('openbox') && has('wmctrl');
const DISPLAY = ':93';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-link-'));
let xvfb: ChildProcess | null = null;
let wm: ChildProcess | null = null;
let redis: IORedis | null = null;
let redisUp = false;
let app: express.Express;
let server: http.Server | null = null;
let base = '';
let operator: Browser | null = null;
let pm: ProfileManager;
let registry: ProfileRegistry;
const prev = { display: process.env.DISPLAY, profiles: config.PROFILES_DIR, base: config.BRANCH_BASE_DIR, ext: config.REAL_CHROME_EXTENSIONS_DIR, nosb: process.env.PLYR_CHROME_NO_SANDBOX };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'local';
const WF = 'wf_link';

function procsOn(root: string): number {
  return fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).filter((p) => {
    try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type=')); } catch { return false; }
  }).length;
}
const windows = (): string[] => { try { return execFileSync('wmctrl', ['-l'], { env: { ...process.env, DISPLAY } }).toString().trim().split('\n').filter(Boolean); } catch { return []; } };

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); redisUp = true; } catch { redisUp = false; }
  if (!toolsOk || !redisUp) return;
  for (const k of await redis.keys('profile:*')) await redis.del(k);
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await sleep(800);
  wm = spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY } });
  await sleep(800);
  process.env.DISPLAY = DISPLAY;
  process.env.PLYR_CHROME_NO_SANDBOX = '1';
  (config as any).PROFILES_DIR = path.join(tmp, 'profiles');
  (config as any).BRANCH_BASE_DIR = path.join(tmp, 'base');
  (config as any).REAL_CHROME_EXTENSIONS_DIR = path.join(tmp, 'extensions');
  const sessions = new BrowserSessions(null);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  registry = new ProfileRegistry(path.join(tmp, 'profiles'), { baseDir: () => path.join(tmp, 'base') });
  const access = new ProfileAccess(registry, new ProfileLeases(redis, 120), new ProfileReservations(redis), sessions);
  registerProfileAccess(access);
  app = express();
  app.use(express.json());
  // The real panel (public/js/profile-manager.js) for the UI case.
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  app.get('/panel', (_q, s) => {
    s.type('html').send('<!doctype html><html><head><style>' + read('public/css/styles.css') + '</style></head><body><div id="host"></div>' +
      '<script>window.AppUtil={t:function(k){return k},toast:function(){}};window.API={getKey:function(){return ""}};<' + '/script>' +
      '<script src="/js/i18n.js"><' + '/script><script src="/js/profile-manager.js"><' + '/script>' +
      '<script>window.__pm=window.ProfileManager.mount(document.getElementById("host"),{workflowId:"' + WF + '",launchSettings:false});<' + '/script></body></html>');
  });
  app.get('/js/:f', (q, s) => { s.type('application/javascript').send(read('public/js/' + path.basename(q.params.f))); });
  // Stand-in viewer page: the real one needs a VNC server. What is tested is
  // WHICH tab shows WHICH browser, and that nothing launches a browser.
  app.get('/desktop/chrome', (q, s) => { s.type('html').send('<!doctype html><title>viewer ' + String(q.query.profile || '') + '</title>'); });
  app.use(createProfileRoutes({ connection: redis, access, profileManager: pm, schedules: { overlaps: async () => [], unresolvedSchedules: async () => [], scheduledWorkflowIds: async () => new Set() } }));
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  operator = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await operator?.close().catch(() => {});
  if (server) await new Promise((r) => server!.close(r));
  if (pm) for (const [, e] of (pm as any).vipContexts || []) await closeContextBounded(e.context).catch(() => {});
  if (redis) { for (const k of await redis.keys('profile:*').catch(() => [] as string[])) await redis.del(k).catch(() => 0); redis.disconnect(); }
  (config as any).PROFILES_DIR = prev.profiles;
  (config as any).BRANCH_BASE_DIR = prev.base;
  (config as any).REAL_CHROME_EXTENSIONS_DIR = prev.ext;
  if (prev.nosb === undefined) delete process.env.PLYR_CHROME_NO_SANDBOX; else process.env.PLYR_CHROME_NO_SANDBOX = prev.nosb;
  if (prev.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prev.display;
  wm?.kill(); xvfb?.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best-effort */ }
});

(toolsOk ? describeBrowser : (n: string, f: () => void) => describeBrowser(`${n} (SKIPPED: Xvfb/openbox/wmctrl missing)`, () => { it.skip('needs an X display', f as never); }))(
  'Play / link semantics (brief 2 B)', () => {
    function pidOn(root: string): number {
      for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); if (a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type='))) return Number(p); } catch { /* gone */ }
      }
      return 0;
    }

    it('Play launches + one viewer tab; link twice -> one process, one session, one tab, no /open; close tab + link -> new tab, same browser; Play double click launches once', async () => {
      if (!redisUp) return;
      const a = (await request(app).post('/profiles').send({ name: 'Link A', branchId: 'new' }).expect(201)).body.profile;
      const root = (await registry.locationOf(USER, a.id))!.root;
      const leaseId = leaseIdOf(a.id);

      const ctx = await operator!.newContext({ viewport: { width: 900, height: 900 } });
      const page = await ctx.newPage();
      const dialogs: string[] = [];
      page.on('dialog', (d) => { dialogs.push(d.type()); void d.dismiss(); });
      const posted: string[] = [];
      page.on('request', (r) => { if (r.method() === 'POST') posted.push(new URL(r.url()).pathname); });
      await page.goto(`${base}/panel`);
      const row = `.pm-row[data-id="${a.id}"]`;
      await page.waitForSelector(`${row} .pm-play`);
      // Closed: Play exists, link and Stop do not.
      expect(await page.locator(`${row} .pm-link`).count()).toBe(0);
      expect(await page.locator(`${row} .pm-stop`).count()).toBe(0);

      const viewers = () => ctx.pages().filter((p) => p !== page && !p.isClosed());

      // Play (double click): ONE launch, ONE viewer tab.
      await page.locator(`${row} .pm-play`).dblclick();
      await page.waitForFunction(() => !(window as any).__pm.state.busy, null, { timeout: 60_000 });
      await page.waitForSelector(`${row} .pm-link`, { timeout: 20_000 });
      const opens1 = posted.filter((u) => u === `/profiles/${a.id}/open`).length;
      const pid1 = pidOn(root);
      expect(pid1).toBeGreaterThan(0);
      expect(opens1).toBe(1);
      await sleep(500);
      expect(viewers()).toHaveLength(1);
      expect(await viewers()[0]!.title()).toBe(`viewer ${a.id}`);
      // Running: Play does not exist; link + Stop do.
      expect(await page.locator(`${row} .pm-play`).count()).toBe(0);
      expect(await page.locator(`${row} .pm-stop`).count()).toBe(1);
      expect(browserSessions().list().filter((r) => r.leaseId === leaseId)).toHaveLength(1);

      // Link twice: nothing launched, same process, same session, one tab.
      await page.locator(`${row} .pm-link`).click();
      await sleep(800);
      await page.locator(`${row} .pm-link`).click();
      await sleep(800);
      expect(posted.filter((u) => u.endsWith('/open'))).toHaveLength(1);
      expect(pidOn(root)).toBe(pid1);
      expect(browserSessions().list().filter((r) => r.leaseId === leaseId)).toHaveLength(1);
      expect(viewers()).toHaveLength(1);
      console.log(`[B] Play dblclick -> /open x${opens1}, pid ${pid1}, viewer tabs ${viewers().length}; link x2 -> /open total ${posted.filter((u) => u.endsWith('/open')).length}, pid ${pidOn(root)}, tabs ${viewers().length}`);

      // Close the viewer tab; the link opens a NEW tab showing the SAME browser.
      await viewers()[0]!.close();
      expect(viewers()).toHaveLength(0);
      const popup = page.waitForEvent('popup');
      await page.locator(`${row} .pm-link`).click();
      const v2 = await popup;
      await v2.waitForLoadState('domcontentloaded');
      await sleep(500);
      expect(viewers()).toHaveLength(1);
      expect(await v2.title()).toBe(`viewer ${a.id}`);
      expect(pidOn(root)).toBe(pid1);
      expect(posted.filter((u) => u.endsWith('/open'))).toHaveLength(1);
      console.log(`[B] viewer tab closed, link -> new tab "${await v2.title()}", pid ${pidOn(root)} (same: ${pidOn(root) === pid1}), /open total ${posted.filter((u) => u.endsWith('/open')).length}`);

      // Stop on the row closes it; Play is back.
      await page.locator(`${row} .pm-stop`).click();
      await page.waitForSelector(`${row} .pm-play`, { timeout: 20_000 });
      for (let i = 0; i < 30 && pidOn(root); i++) await sleep(200);
      expect(pidOn(root)).toBe(0);
      expect(dialogs).toEqual([]);
      await request(app).post(`/profiles/${a.id}/release`).send({ workflowId: WF });
      await ctx.close();
    }, 150_000);
  });
