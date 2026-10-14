/**
 * Section 9, last point (owner's brief): a profile folder removed OUTSIDE Aria
 * after its workflow was already active. The next run must detect it BEFORE
 * launching, fail cleanly, record a `profile_broken` report, notify the user,
 * and never create an empty folder in its place.
 *
 *   - worker check (core/BranchPolicy.preRunProfileCheck, called by src/index.ts
 *     before the lease and the launch): report + notification, nothing created
 *   - the pipeline's last line of defence (runPipeline on the same profile):
 *     the run fails with PROFILE_BROKEN, no browser is launched, no folder made
 *   - a healthy profile passes the check
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileFailureReports } from '../../src/core/ProfileFailureReports';
import { preRunProfileCheck } from '../../src/core/BranchPolicy';
import { resolveRunProfile } from '../../src/core/ProfileLease';
import { runPipeline } from '../../src/pipeline';
import { validateSteps } from '../../src/validation';
import { config } from '../../src/config';

let redis: IORedis | null = null;
let up = false;
let dir = '';
const USER = `rpb${Date.now() % 100000}`;

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); up = true; } catch { up = false; }
  dir = mkdtempSync(path.join(tmpdir(), 'plyr-rpb-'));
});
afterAll(async () => {
  if (redis) { await redis.del(`profile:failures:${USER}`).catch(() => {}); redis.disconnect(); }
  rmSync(dir, { recursive: true, force: true });
});

describe('a profile folder removed outside Aria, then the workflow runs', () => {
  it('the worker check fails the run before launch, records profile_broken, notifies, creates nothing', async () => {
    if (!up) return;
    const reg = new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => path.join(dir, 'base') });
    const reports = new ProfileFailureReports(redis!);
    const p = await reg.create(USER, 'Shop');
    const folder = path.join(reg.dirOf(USER, p.id), p.folder);
    expect(existsSync(folder)).toBe(true);

    const ref = resolveRunProfile({ userId: USER, profileId: p.id, usesExtensions: false, localMode: false, profilesDir: path.join(dir, 'profiles'), realChromeDir: '' });
    const notes: string[] = [];
    const ok = await preRunProfileCheck({
      registry: reg, userId: USER, profile: ref, workflowId: 'wf_x', workflowName: 'Nightly', jobId: 'job-1',
      record: (u, r) => reports.record(u, r), notify: (m) => notes.push(m),
    });
    expect(ok).toBeNull(); // healthy
    expect(notes).toEqual([]);

    rmSync(folder, { recursive: true, force: true }); // removed outside Aria
    const broken = await preRunProfileCheck({
      registry: reg, userId: USER, profile: ref, workflowId: 'wf_x', workflowName: 'Nightly', jobId: 'job-2',
      record: (u, r) => reports.record(u, r), notify: (m) => notes.push(m),
    });
    expect(broken).toMatchObject({ reason: 'profile_broken', detail: 'folder_missing' });
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/Shop/);
    const list = await reports.list(USER);
    expect(list[0]).toMatchObject({ reason: 'profile_broken', detail: 'folder_missing', stage: 'run', workflowId: 'wf_x', profileId: p.id, jobId: 'job-2' });
    expect(existsSync(folder)).toBe(false); // never recreated
  });

  it('the pipeline itself refuses too (last line of defence): no launch, no empty folder', async () => {
    const reg = new ProfileRegistry(path.join(dir, 'profiles2'), { baseDir: () => path.join(dir, 'base2') });
    const p = await reg.create(USER, 'Gone');
    const folder = path.join(reg.dirOf(USER, p.id), p.folder);
    // The root once held a browser (Local State), then the profile folder vanished.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(reg.dirOf(USER, p.id), 'Local State'), '{}');
    rmSync(folder, { recursive: true, force: true });
    const ref = resolveRunProfile({ userId: USER, profileId: p.id, usesExtensions: false, localMode: false, profilesDir: path.join(dir, 'profiles2'), realChromeDir: '' });
    expect(ref.profileDirectory).toBe(p.folder);
    // The real manager: anything that reached a launch would show up as a context.
    const { ProfileManager } = await import('../../src/core/ProfileManager');
    const pm = new ProfileManager();
    const logs: string[] = [];
    const plan = { quota: 0, maxTabs: 5, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0 } as never;
    const quota = { hasQuotaRemaining: async () => true, consumeQuota: async () => true } as never;
    const res: any = await runPipeline({
      userId: USER, steps: validateSteps([{ action: 'launch', params: { url: 'about:blank' } }] as never, config.FULL_ACCESS_PLAN) as never,
      headless: true, origin: 'automatic', profile: ref, log: (m: string) => logs.push(m), jobId: 'job-3', profileManager: pm, userPlan: plan, quotaManager: quota,
    } as never).catch((e: Error) => ({ error: e.message }));
    const text = JSON.stringify(res) + logs.join('\n');
    expect(text).toMatch(/PROFILE_BROKEN: the folder of browser profile \\"Gone\\" is missing on disk; it was not recreated/);
    expect(pm.getVipContext(ref.id)).toBeUndefined(); // no browser was launched
    expect(existsSync(folder)).toBe(false);
  });
});
