/**
 * Browser Profiles with REAL Chromium on a real X display (Xvfb) and the REAL
 * /profiles routes:
 *
 *   Open
 *     - the Chromium browser process runs with --user-data-dir=<branch root>
 *       (never the profile folder) and exactly one
 *       --profile-directory=<registry folder> (read from /proc/<pid>/cmdline);
 *     - chrome://version reports Profile Path = <root>/<folder>;
 *     - a `last_used` in Local State pointing elsewhere is ignored;
 *     - Open again while it runs: reused, SAME pid, no second process.
 *   Turn off (POST /profiles/turn-off)
 *     - with two profile browsers (two branches) open, one of them used by a
 *       workflow's run: the free one's process is gone, the used one's keeps
 *       running and the answer names the workflow and the profile.
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
import { BrowserSessions, registerBrowserSessions, jobDependent } from '../../src/core/BrowserSessions';
import { closeContextBounded } from '../../src/core/SharedBrowsers';
import { createProfileRoutes } from '../../src/Routes/profile.routes';
import { WorkflowService } from '../../src/services/workflow.service';
import { workflowStoreFor } from '../../src/services/storage';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb');
const DISPLAY = ':93';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-ot-'));
let xvfb: ChildProcess | null = null;
let redis: IORedis | null = null;
let redisUp = false;
let app: express.Express;
let pm: ProfileManager;
let registry: ProfileRegistry;
let leases: ProfileLeases;
const prev = { display: process.env.DISPLAY, profiles: config.PROFILES_DIR, base: config.BRANCH_BASE_DIR, ext: config.REAL_CHROME_EXTENSIONS_DIR };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'local';

/** argv of the Chromium BROWSER process on `root` (not a renderer child), or null. */
function browserProc(root: string): { pid: number; args: string[] } | null {
  for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      if (a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type='))) return { pid: Number(p), args: a };
    } catch { /* gone */ }
  }
  return null;
}
function procsOn(root: string): number {
  return fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).filter((p) => {
    try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type=')); } catch { return false; }
  }).length;
}

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); redisUp = true; } catch { redisUp = false; }
  if (!toolsOk || !redisUp) return;
  for (const k of await redis.keys('profile:*')) await redis.del(k);
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await sleep(800);
  process.env.DISPLAY = DISPLAY;
  (config as any).PROFILES_DIR = path.join(tmp, 'profiles');
  (config as any).BRANCH_BASE_DIR = path.join(tmp, 'base');
  (config as any).REAL_CHROME_EXTENSIONS_DIR = path.join(tmp, 'extensions');
  const sessions = new BrowserSessions(null);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  registry = new ProfileRegistry(path.join(tmp, 'profiles'), { baseDir: () => path.join(tmp, 'base') });
  leases = new ProfileLeases(redis, 120);
  const access = new ProfileAccess(registry, leases, new ProfileReservations(redis), sessions);
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
  if (prev.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prev.display;
  xvfb?.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best-effort */ }
});

(toolsOk ? describeBrowser : (n: string, f: () => void) => describeBrowser(`${n} (SKIPPED: Xvfb missing)`, () => { it.skip('needs an X display', f as never); }))(
  'Browser Profiles Open / Turn off with real Chromium', () => {
    it('Open: --user-data-dir = branch root, one explicit --profile-directory, Local State last_used ignored, reopen reuses the process', async () => {
      if (!redisUp) return;
      const c = await request(app).post('/profiles').send({ name: 'Real open', branchId: 'new' }).expect(201);
      const id = c.body.profile.id;
      const loc = (await registry.locationOf(USER, id))!;
      // A Local State that would make an un-pinned Chromium open another profile.
      fs.writeFileSync(path.join(loc.root, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 7' } }));
      fs.mkdirSync(path.join(loc.root, 'Profile 7'), { recursive: true });
      const o1 = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_real' });
      expect(o1.status, JSON.stringify(o1.body)).toBe(200);
      const proc = browserProc(loc.root)!;
      expect(proc).not.toBeNull();
      expect(path.basename(loc.root)).toMatch(/^branch-\d{3}$/);
      expect(proc.args.filter((a) => a.startsWith('--user-data-dir='))).toEqual([`--user-data-dir=${loc.root}`]);
      expect(proc.args.filter((a) => a.startsWith('--profile-directory='))).toEqual([`--profile-directory=${loc.folder}`]);
      // What Chromium itself reports.
      const ctx = pm.getVipContext(leaseIdOf(id))!.context;
      const page = await ctx.newPage();
      await page.goto('chrome://version');
      const profilePath = (await page.locator('#profile_path').textContent())?.trim();
      expect(profilePath).toBe(path.join(loc.root, loc.folder));
      await page.close();
      // Open again: shown, not launched again.
      const o2 = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_real' }).expect(200);
      expect(o2.body.reused).toBe(true);
      expect(browserProc(loc.root)!.pid).toBe(proc.pid);
      expect(procsOn(loc.root)).toBe(1);
      console.log(`[open] root=${loc.root} folder=${loc.folder} pid=${proc.pid} profilePath=${profilePath} reused=${o2.body.reused}`);
      await request(app).post(`/profiles/${id}/close`).send({ workflowId: 'wf_real' }).expect(200);
      await request(app).post(`/profiles/${id}/release`).send({ workflowId: 'wf_real' });
    }, 120_000);

    it('Turn off: closes the free profile browser, keeps the one a workflow uses open and names the workflow', async () => {
      if (!redisUp) return;
      const wf = await new WorkflowService(workflowStoreFor(redis!)).create(USER, { name: 'Real nightly', steps: [{ action: 'goto', params: { url: 'about:blank' } }] });
      const a = (await request(app).post('/profiles').send({ name: 'Free real', branchId: 'new' }).expect(201)).body.profile.id;
      const b = (await request(app).post('/profiles').send({ name: 'Used real', branchId: 'new' }).expect(201)).body.profile.id;
      const ra = (await registry.locationOf(USER, a))!.root;
      const rb = (await registry.locationOf(USER, b))!.root;
      await request(app).post(`/profiles/${a}/open`).send({ workflowId: 'wf_op' }).expect(200);
      await request(app).post(`/profiles/${b}/open`).send({ workflowId: 'wf_op' }).expect(200);
      expect(procsOn(ra)).toBe(1);
      expect(procsOn(rb)).toBe(1);
      // A run of the workflow depends on b's browser.
      const lb = leaseIdOf(b);
      await leases.releaseHold(lb, { owner: 'wf_op' });
      expect((await leases.acquire(lb, '77', { owner: wf.id })).ok).toBe(true);
      (await import('../../src/core/BrowserSessions')).browserSessions().attach(lb, jobDependent('77'));

      const t0 = Date.now();
      const r = await request(app).post('/profiles/turn-off').send({}).expect(200);
      const ms = Date.now() - t0;
      console.log(`[turn-off] ${ms}ms ${JSON.stringify(r.body)}`);
      expect(r.body.closed.map((x: any) => x.name)).toEqual(['Free real']);
      expect(r.body.keptOpen).toEqual([{ profileId: b, name: 'Used real', reason: 'workflow', workflows: [{ workflowId: wf.id, name: 'Real nightly' }] }]);
      for (let i = 0; i < 20 && procsOn(ra); i++) await sleep(250);
      expect(procsOn(ra)).toBe(0);
      expect(procsOn(rb)).toBe(1);
      // The kept browser still works.
      const pg = pm.getVipContext(lb)!.context.pages()[0]!;
      await pg.goto('about:blank');
      expect(pg.url()).toBe('about:blank');
    }, 120_000);
  });
