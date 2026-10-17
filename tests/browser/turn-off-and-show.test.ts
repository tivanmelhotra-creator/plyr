/**
 * Section 6 + 11 (owner's brief) with REAL Chromium on a real X display and
 * the REAL routes (browser.routes + profile.routes):
 *
 *   - Turn Off with the Local Browser and two profile browsers (two branches)
 *     open: answers (bounded), closes ONLY the Local Browser, names the
 *     profile browsers that stay open; they keep working
 *   - Turn Off when only profile browsers are open: still answers, nothing hangs
 *   - Show Browser after the display tab was closed: GET /browser/sessions
 *     (what the viewer and "Show browser" use, never a launch) still lists the
 *     SAME session (same process, same page); opening the profile again
 *     reuses it (reused=true, same pid)
 *   - two branches run two profiles at the same time; Playwright controls each
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { describeBrowser, ensureProbed } from './real-browser';
import { config } from '../../src/config';
import { RealChrome } from '../../src/core/RealChrome';
import { ProfileManager } from '../../src/core/ProfileManager';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileLeases, leaseIdOf } from '../../src/core/ProfileLease';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { ProfileAccess, registerProfileAccess } from '../../src/core/ProfileAccess';
import { BrowserSessions, registerBrowserSessions, browserSessions } from '../../src/core/BrowserSessions';
import { closeContextBounded } from '../../src/core/SharedBrowsers';
import { resolveRunProfile } from '../../src/core/ProfileLease';
import { runPipeline } from '../../src/pipeline';
import { validateSteps } from '../../src/validation';
import { jobDependent } from '../../src/core/BrowserSessions';
import { applyAfterRun, outcomeOfError } from '../../src/core/BrowserLifecycle';
import { saveBeforeClose, readLastSession } from '../../src/core/BrowserStateSnapshot';
import { sessionDataDir } from '../../src/core/BrowserSessions';
import { createProfileRoutes } from '../../src/Routes/profile.routes';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb');
const DISPLAY = ':92';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-off-'));
let xvfb: ChildProcess | null = null;
let redis: IORedis | null = null;
let redisUp = false;
let app: express.Express;
let pm: ProfileManager;
let registry: ProfileRegistry;
let web: http.Server; let url = '';
const prev = { udd: config.REAL_CHROME_USER_DATA_DIR, ext: config.REAL_CHROME_EXTENSIONS_DIR, enabled: config.REAL_CHROME_ENABLED, display: process.env.DISPLAY, profiles: config.PROFILES_DIR, base: config.BRANCH_BASE_DIR };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'local';

/** pid of the Chromium BROWSER process on a root (not a child). */
function pidOfRoot(root: string): number {
  for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      if (a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type='))) return Number(p);
    } catch { /* gone */ }
  }
  return 0;
}

beforeAll(async () => {
  web = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<title>page ${q.url}</title>`); });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); redisUp = true; } catch { redisUp = false; }
  if (!toolsOk || !redisUp) return;
  for (const k of await redis.keys('profile:*')) await redis.del(k);
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await sleep(800);
  process.env.DISPLAY = DISPLAY;
  (config as any).REAL_CHROME_USER_DATA_DIR = path.join(tmp, 'local-browser');
  (config as any).REAL_CHROME_EXTENSIONS_DIR = path.join(tmp, 'extensions');
  (config as any).PROFILES_DIR = path.join(tmp, 'profiles');
  (config as any).BRANCH_BASE_DIR = path.join(tmp, 'base');
  config.REAL_CHROME_ENABLED = true;
  const sessions = new BrowserSessions(null);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  registry = new ProfileRegistry(path.join(tmp, 'profiles'), { baseDir: () => path.join(tmp, 'base') });
  const access = new ProfileAccess(registry, new ProfileLeases(redis, 120), new ProfileReservations(redis), sessions);
  registerProfileAccess(access);
  const { createBrowserRoutes } = await import('../../src/Routes/browser.routes');
  app = express();
  app.use(express.json());
  app.use(createProfileRoutes({ connection: redis, access, profileManager: pm, schedules: { overlaps: async () => [], unresolvedSchedules: async () => [], scheduledWorkflowIds: async () => new Set() } }));
  app.use(createBrowserRoutes());
}, 60_000);

afterAll(async () => {
  await RealChrome.stop().catch(() => {});
  for (const id of [...(pm ? ['x'] : [])]) void id;
  if (redis) { for (const k of await redis.keys('profile:*').catch(() => [] as string[])) await redis.del(k).catch(() => 0); redis.disconnect(); }
  (config as any).REAL_CHROME_USER_DATA_DIR = prev.udd;
  (config as any).REAL_CHROME_EXTENSIONS_DIR = prev.ext;
  (config as any).PROFILES_DIR = prev.profiles;
  (config as any).BRANCH_BASE_DIR = prev.base;
  config.REAL_CHROME_ENABLED = prev.enabled;
  if (prev.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prev.display;
  xvfb?.kill();
  await new Promise((r) => web.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best-effort */ }
});

(toolsOk ? describeBrowser : (n: string, f: () => void) => describeBrowser(`${n} (SKIPPED: Xvfb missing)`, () => { it.skip('needs an X display', f as never); }))(
  'Turn Off / Show Browser with real Chromium', () => {
    it('Turn Off closes ONLY the Local Browser, answers, names the profile browsers; they keep running and Show Browser finds the same session', async () => {
      if (!redisUp) return;
      // Two profiles in two branches, opened through the real route.
      const a = (await request(app).post('/profiles').send({ name: 'Shop A', branchId: 'new' }).expect(201)).body.profile;
      const b = (await request(app).post('/profiles').send({ name: 'Shop B', branchId: 'new' }).expect(201)).body.profile;
      expect(a.branchId).not.toBe(b.branchId);
      await request(app).post(`/profiles/${a.id}/open`).send({ workflowId: 'wf_off' }).expect(200);
      await request(app).post(`/profiles/${b.id}/open`).send({ workflowId: 'wf_off' }).expect(200);
      const rootA = registry.dirOf(USER, a.id); const rootB = registry.dirOf(USER, b.id);
      const pidA = pidOfRoot(rootA); const pidB = pidOfRoot(rootB);
      expect(pidA).toBeGreaterThan(0); expect(pidB).toBeGreaterThan(0); expect(pidA).not.toBe(pidB);
      // Two branches at the same time, each controlled separately.
      const ctxA = pm.getVipContext(leaseIdOf(a.id))!.context; const ctxB = pm.getVipContext(leaseIdOf(b.id))!.context;
      await ctxA.pages()[0]!.goto(`${url}/a`); await ctxB.pages()[0]!.goto(`${url}/b`);
      expect(await ctxA.pages()[0]!.title()).toBe('page /a');
      expect(await ctxB.pages()[0]!.title()).toBe('page /b');

      // The Local Browser too (Turn on).
      await RealChrome.getContext();
      expect(RealChrome.isRunning()).toBe(true);
      const sessionsBefore = (await request(app).get('/browser/sessions').expect(200)).body;
      expect(sessionsBefore.localBrowser.running).toBe(true);
      expect(sessionsBefore.sessions.map((s: any) => s.name).sort()).toEqual(['Local Browser', 'Shop A', 'Shop B']);

      // TURN OFF: bounded, answers, closes only the Local Browser, names the others.
      const t0 = Date.now();
      const off = await request(app).post('/browser/real/close').send({}).expect(200);
      expect(Date.now() - t0).toBeLessThan(25_000);
      expect(off.body.success).toBe(true);
      expect(off.body.running).toBe(false);
      expect(RealChrome.isRunning()).toBe(false);
      expect(off.body.otherSessions.map((s: any) => s.name).sort()).toEqual(['Shop A', 'Shop B']);
      // The profile browsers are the SAME processes and still work.
      expect(pidOfRoot(rootA)).toBe(pidA); expect(pidOfRoot(rootB)).toBe(pidB);
      await ctxA.pages()[0]!.goto(`${url}/a2`);
      expect(await ctxA.pages()[0]!.title()).toBe('page /a2');

      // Turn Off again with only profile browsers open: still answers, changes nothing.
      const off2 = await request(app).post('/browser/real/close').send({}).expect(200);
      expect(off2.body.otherSessions.length).toBe(2);
      expect(pidOfRoot(rootA)).toBe(pidA);

      // The display tab is closed (the viewer detaches; nothing on the server
      // ends). SHOW BROWSER = the viewer's attach: /browser/sessions still
      // lists the same session; re-opening the profile reuses it.
      const after = (await request(app).get('/browser/sessions').expect(200)).body;
      expect(after.sessions.map((s: any) => s.name).sort()).toEqual(['Shop A', 'Shop B']);
      const again = await request(app).post(`/profiles/${a.id}/open`).send({ workflowId: 'wf_off' }).expect(200);
      expect(again.body.reused).toBe(true);
      expect(pidOfRoot(rootA)).toBe(pidA);
      expect(pm.getVipContext(leaseIdOf(a.id))!.context.pages()[0]!.url()).toContain('/a2'); // same session, same page

      for (const p of [a, b]) {
        const e = pm.getVipContext(leaseIdOf(p.id));
        if (e) await closeContextBounded(e.context);
        browserSessions().closed(leaseIdOf(p.id));
        await request(app).post(`/profiles/${p.id}/release`).send({ workflowId: 'wf_off' });
      }
    }, 180_000);
  
    it('two scheduled runs on two profiles of ONE branch: the later one WAITS (no parallel Chromium), then runs on its own folder', async () => {
      if (!redisUp) return;
      const leases = new ProfileLeases(redis!, 120);
      const a = await registry.create(USER, 'Nightly A');
      const b = await registry.create(USER, 'Nightly B', { branchId: a.branchId });
      const refA = resolveRunProfile({ userId: USER, profileId: a.id, usesExtensions: false, localMode: false, profilesDir: config.PROFILES_DIR, realChromeDir: '' });
      const refB = resolveRunProfile({ userId: USER, profileId: b.id, usesExtensions: false, localMode: false, profilesDir: config.PROFILES_DIR, realChromeDir: '' });
      expect(refA.id).toBe(refB.id); // one lock per branch
      const plan = { quota: 0, maxTabs: 5, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0 } as never;
      const quota = { hasQuotaRemaining: async () => true, consumeQuota: async () => true } as never;
      // What the worker does per job (src/index.ts): lease first; denied -> wait (moveToDelayed); else run.
      const events: string[] = [];
      const worker = async (ref: typeof refA, jobId: string, owner: string, holdMs: number) => {
        let got = await leases.acquire(ref.id, jobId, { owner });
        let waited = 0;
        while (!got.ok) { if (!waited) events.push(`${jobId}:waiting(${got.reason})`); waited++; await sleep(300); got = await leases.acquire(ref.id, jobId, { owner }); }
        events.push(`${jobId}:start`);
        const procs = pidOfRoot(ref.userDataDir!);
        events.push(`${jobId}:procsBefore=${procs ? 1 : 0}`);
        await runPipeline({
          userId: USER, steps: validateSteps([{ action: 'launch', params: { url: `${url}/${jobId}` } }, { action: 'delay', params: { ms: holdMs } }] as never, config.FULL_ACCESS_PLAN) as never,
          headless: true, origin: 'automatic', profile: ref, log: () => {}, jobId, profileManager: pm, userPlan: plan, quotaManager: quota,
        } as never);
        const ctx = pm.getVipContext(ref.id)!.context;
        const pg = await ctx.newPage(); await pg.goto('chrome://version');
        events.push(`${jobId}:path=${path.basename((await pg.locator('#profile_path').innerText()).trim())}`);
        await pg.close();
        // after-run (default close), then the lease is released (worker finally)
        browserSessions().detach(ref.id, jobDependent(jobId));
        await closeContextBounded(ctx); pm.removeVipContext(ref.id); browserSessions().closed(ref.id);
        await leases.release(ref.id, got.token);
        events.push(`${jobId}:end`);
      };
      const first = worker(refA, 'job-A', 'wf_nightly_a', 1500);
      await sleep(200);
      const second = worker(refB, 'job-B', 'wf_nightly_b', 10);
      await Promise.all([first, second]);
      const iA = events.indexOf('job-A:end'); const iB = events.indexOf('job-B:start');
      expect(events).toContain('job-B:waiting(in_use)');
      expect(iB).toBeGreaterThan(iA); // B started only after A ended
      expect(events).toContain('job-B:procsBefore=0'); // never two Chromium on the root
      expect(events).toContain('job-A:path=profile-001');
      expect(events).toContain('job-B:path=profile-002');
    }, 120_000);
  
    it('"Keep browser open": honoured after success, ignored after error (state saved first, no process left)', async () => {
      const p = await registry.create(USER, 'Keep');
      const ref = resolveRunProfile({ userId: USER, profileId: p.id, usesExtensions: false, localMode: false, profilesDir: config.PROFILES_DIR, realChromeDir: '' });
      const plan = { quota: 0, maxTabs: 5, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0 } as never;
      const quota = { hasQuotaRemaining: async () => true, consumeQuota: async () => true } as never;
      const run = async (jobId: string, steps: unknown[]) => {
        let message = '';
        try {
          const r: any = await runPipeline({ userId: USER, steps: validateSteps(steps as never, config.FULL_ACCESS_PLAN) as never, headless: true, origin: 'automatic', profile: ref, log: () => {}, jobId, profileManager: pm, userPlan: plan, quotaManager: quota } as never);
          if (r && r.success === false) message = String(r.message || r.error || 'failed');
        } catch (e) { message = (e as Error).message; }
        return message ? outcomeOfError(message, false) : 'success';
      };
      const apply = (jobId: string, outcome: any, policy: 'keep' | 'close') => applyAfterRun({
        sessionId: ref.id, dependent: jobDependent(jobId), policy, outcome, ownBrowser: true,
        sessions: browserSessions(), manager: pm,
        save: (ctx) => saveBeforeClose(ctx as never, sessionDataDir(ref.id) || ref.userDataDir, 'after_run'),
      });
      // success + keep -> stays open
      expect(await run('job-k1', [{ action: 'launch', params: { url: `${url}/ok` } }])).toBe('success');
      const pid1 = pidOfRoot(ref.userDataDir!);
      expect(pid1).toBeGreaterThan(0);
      expect(await apply('job-k1', 'success', 'keep')).toMatchObject({ action: 'keep', why: 'policy', closed: false });
      expect(pidOfRoot(ref.userDataDir!)).toBe(pid1);
      // error + keep -> closed, tabs saved first, no process left
      const out = await run('job-k2', [{ action: 'launch', params: { url: `${url}/err` } }, { action: 'click', params: { selector: '#does-not-exist', timeout: 500 } }]);
      expect(out).not.toBe('success');
      expect(await apply('job-k2', out, 'keep')).toMatchObject({ action: 'close', closed: true });
      await sleep(1500);
      expect(pidOfRoot(ref.userDataDir!)).toBe(0);
      const snap = await readLastSession(registry.profilePathOf(USER, p.id));
      expect(snap?.reason).toBe('after_run');
      expect(snap!.tabs.some((t) => t.url.includes('/err'))).toBe(true);
      // success + default (close) -> closed
      expect(await run('job-k3', [{ action: 'launch', params: { url: `${url}/ok2` } }])).toBe('success');
      expect(await apply('job-k3', 'success', 'close')).toMatchObject({ action: 'close', closed: true });
      await sleep(1500);
      expect(pidOfRoot(ref.userDataDir!)).toBe(0);
    }, 120_000);
  });
