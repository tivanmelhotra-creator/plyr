/**
 * Owner brief 2 / G.2 with REAL Chromium on Xvfb and the REAL /profiles routes:
 * a second profile of a RUNNING branch opened BY HAND (manual-only).
 *
 *   1. A opens normally (Play). B (same branch) Play -> 409 branch_busy with
 *      manualOpenPossible.
 *   2. open-manual without the confirmation -> 428, nothing launched.
 *   3. open-manual with confirm 'manual-only' -> B's window opens INSIDE A's
 *      process (one browser process on the root), folder created, B's view
 *      reports browser.manual; A's Playwright session still works.
 *   4. Automation never uses B's tabs: ownPages() contains A's tabs only.
 *   5. Stop B (close-manual): only B's window closes; A stays.
 *   6. Open B again, then Stop A: both go (one process), B is no longer open.
 *   7. Each confirmation is for ONE launch: a second open-manual without it -> 428.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
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
import { ownPages, isManualProfileOpen } from '../../src/core/ManualProfiles';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb') && has('openbox') && has('wmctrl');
const DISPLAY = ':92';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-man-'));
let xvfb: ChildProcess | null = null;
let wm: ChildProcess | null = null;
let redis: IORedis | null = null;
let redisUp = false;
let app: express.Express;
let pm: ProfileManager;
let registry: ProfileRegistry;
const prev = { display: process.env.DISPLAY, profiles: config.PROFILES_DIR, base: config.BRANCH_BASE_DIR, ext: config.REAL_CHROME_EXTENSIONS_DIR, nosb: process.env.PLYR_CHROME_NO_SANDBOX };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'local';
const WF = 'wf_manual';

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
  app.use(createProfileRoutes({ connection: redis, access, profileManager: pm, schedules: { overlaps: async () => [], unresolvedSchedules: async () => [], scheduledWorkflowIds: async () => new Set() } }));
}, 60_000);

afterAll(async () => {
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
  'a second profile of a running branch, opened by hand (G.2)', () => {
    it('opens inside the running process after the explicit confirmation, manual-only, Stop closes only it, Stop of the first closes both', async () => {
      if (!redisUp) return;
      const a = (await request(app).post('/profiles').send({ name: 'First', branchId: 'new' }).expect(201)).body.profile;
      const b = (await request(app).post('/profiles').send({ name: 'Second', branchId: a.branchId }).expect(201)).body.profile;
      const root = (await registry.locationOf(USER, a.id))!.root;
      const leaseId = leaseIdOf(a.id);
      expect(leaseIdOf(b.id)).toBe(leaseId);

      // 1. A opens; Play on B is refused with the running one named and a manual path offered.
      await request(app).post(`/profiles/${a.id}/open`).send({ workflowId: WF }).expect(200);
      const ctx = pm.getVipContext(leaseId)!.context;
      await ctx.pages()[0]!.goto('data:text/html,<title>first-own</title>');
      const busy = await request(app).post(`/profiles/${b.id}/open`).send({ workflowId: WF });
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ code: 'branch_busy', manualOpenPossible: true, runningProfile: { id: a.id } });

      // 2. Without the confirmation: refused, nothing launched.
      const w0 = windows().length;
      expect((await request(app).post(`/profiles/${b.id}/open-manual`).send({})).status).toBe(428);
      await sleep(1000);
      expect(windows().length).toBe(w0);
      expect(fs.existsSync(path.join(root, b.folder, 'Preferences'))).toBe(false);

      // 3. With it: B's window inside A's process.
      const ok = await request(app).post(`/profiles/${b.id}/open-manual`).send({ confirm: 'manual-only' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ manual: true, reused: false, windowOpened: true });
      await sleep(1000);
      expect(procsOn(root)).toBe(1);
      expect(windows().length).toBe(w0 + 1);
      expect(fs.existsSync(path.join(root, b.folder))).toBe(true);
      expect(isManualProfileOpen(leaseId, b.id)).toBe(true);
      const views = (await request(app).get(`/profiles?workflowId=${WF}`).expect(200)).body.profiles;
      expect(views.find((v: any) => v.id === b.id).browser).toMatchObject({ open: true, manual: true });
      expect(views.find((v: any) => v.id === a.id).browser).toMatchObject({ open: true });
      await ctx.pages()[0]!.goto('data:text/html,<title>first-still</title>');
      expect(await ctx.pages()[0]!.title()).toBe('first-still');

      // 4. Automation never sees B's tabs.
      const own = await ownPages(leaseId, ctx);
      const titles = await Promise.all(own.map((p) => p.title().catch(() => '')));
      expect(ctx.pages().length).toBeGreaterThan(own.length);
      expect(titles).toContain('first-still');
      console.log(`[G.2] context pages=${ctx.pages().length} own(automation may use)=${own.length} titles=${JSON.stringify(titles)} windows=${windows().length} processes=${procsOn(root)}`);

      // 7. The confirmation is per launch: reopening B needs it again (it is open -> reused only WITH it).
      expect((await request(app).post(`/profiles/${b.id}/open-manual`).send({})).status).toBe(428);

      // 5. Stop B: only its window.
      const st = await request(app).post(`/profiles/${b.id}/close-manual`).send({}).expect(200);
      expect(st.body.closed).toBe(true);
      await sleep(1500);
      expect(windows().length).toBe(w0);
      expect(procsOn(root)).toBe(1);
      expect(isManualProfileOpen(leaseId, b.id)).toBe(false);
      await ctx.pages()[0]!.goto('data:text/html,<title>after-stop-b</title>');
      expect(await ctx.pages()[0]!.title()).toBe('after-stop-b');

      // 6. B again, then Stop A: one process, both go; B is no longer open.
      await request(app).post(`/profiles/${b.id}/open-manual`).send({ confirm: 'manual-only' }).expect(200);
      await sleep(1000);
      expect(windows().length).toBe(w0 + 1);
      await request(app).post(`/profiles/${a.id}/close`).send({ workflowId: WF }).expect(200);
      await sleep(2000);
      expect(procsOn(root)).toBe(0);
      expect(windows().length).toBe(0);
      expect(isManualProfileOpen(leaseId, b.id)).toBe(false);
      const after = (await request(app).get(`/profiles?workflowId=${WF}`).expect(200)).body.profiles;
      expect(after.find((v: any) => v.id === b.id).browser.open).toBe(false);
      await request(app).post(`/profiles/${a.id}/release`).send({ workflowId: WF });
    }, 120_000);

    it('open-manual when the branch is not running -> 409 not_running (use Play)', async () => {
      if (!redisUp) return;
      const a = (await request(app).post('/profiles').send({ name: 'Idle', branchId: 'new' }).expect(201)).body.profile;
      const b = (await request(app).post('/profiles').send({ name: 'Idle 2', branchId: a.branchId }).expect(201)).body.profile;
      const r = await request(app).post(`/profiles/${b.id}/open-manual`).send({ confirm: 'manual-only' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('not_running');
    }, 60_000);
  });
