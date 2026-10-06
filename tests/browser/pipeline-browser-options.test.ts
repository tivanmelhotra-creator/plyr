/**
 * Task 4a — the REAL runPipeline with a REAL Chromium: a Launch Browser node's
 * `browserOptions` must reach the browser, and a persistent (VIP) browser that
 * is reused across jobs must be relaunched when the options change (otherwise
 * the new option would be a control that changes nothing).
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeBrowser, ensureProbed, closeSharedBrowser } from './real-browser';
import { runPipeline } from '../../src/pipeline';
import { validateSteps } from '../../src/validation';
import { ProfileManager } from '../../src/core/ProfileManager';
import { browserModes } from '../../src/core/BrowserMode';
import { config } from '../../src/config';

await ensureProbed();

let web: http.Server; let url = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-pl-'));
const prevProfiles = config.PROFILES_DIR;

beforeAll(async () => {
  web = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<title>ok</title>'); });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/`;
  (config as any).PROFILES_DIR = tmp;
});
afterAll(async () => {
  (config as any).PROFILES_DIR = prevProfiles;
  await new Promise((r) => web.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
  await closeSharedBrowser();
});

const plan = { quota: 0, maxTabs: 5, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0 } as never; // priority 1 => VIP path
const quota = { hasQuotaRemaining: async () => true, consumeQuota: async () => true } as never;

async function run(pm: ProfileManager, jobId: string, steps: unknown[], headless = true) {
  const logs: string[] = [];
  const result = await runPipeline({
    userId: 'bo-user', steps: validateSteps(steps as never, config.FULL_ACCESS_PLAN) as never, headless,
    log: (m: string) => logs.push(m), jobId, profileManager: pm, userPlan: plan, quotaManager: quota,
  } as never);
  return { result, logs };
}
const probe = { action: 'evaluate', params: { code: 'return JSON.stringify({w: innerWidth, h: innerHeight, l: navigator.language, ua: navigator.userAgent})' }, saveAs: 'probe' };

describeBrowser('runPipeline applies Launch Browser options', () => {
  it('options reach the real browser, and changing them relaunches the reused VIP browser', async () => {
    (browserModes as any).modes?.delete?.('bo-user');
    const pm = new ProfileManager();
    const launch = (o: unknown) => ({ action: 'launch', params: { url, browserOptions: o } });
    const pageOf = () => pm.getVipContext('bo-user')?.context.pages()[0];
    const read = async () => JSON.parse(await pageOf()!.evaluate(() => JSON.stringify({ w: innerWidth, h: innerHeight, l: navigator.language, ua: navigator.userAgent })));

    // 1) options set -> applied
    const a = await run(pm, 'job-a', [launch({ viewportWidth: 800, viewportHeight: 600, locale: 'fa-IR', userAgent: 'PlyrOpt/1' }), { action: 'delay', params: { ms: 1 } }]);
    expect(a.logs.join('\n')).toMatch(/Applying browser options: .*viewportWidth=800/);
    let s = await read();
    expect(s).toMatchObject({ w: 800, h: 600, l: 'fa-IR', ua: 'PlyrOpt/1' });

    // 2) same options again -> the live browser is reused (no relaunch)
    const b = await run(pm, 'job-b', [launch({ viewportWidth: 800, viewportHeight: 600, locale: 'fa-IR', userAgent: 'PlyrOpt/1' })]);
    expect(b.logs.join('\n')).toMatch(/Reusing VIP browser/);
    expect(b.logs.join('\n')).not.toMatch(/options changed/);

    // 3) different options -> relaunched with the new ones
    const c = await run(pm, 'job-c', [launch({ viewportWidth: 1000, viewportHeight: 500, locale: 'en-US', userAgent: 'PlyrOpt/2' })]);
    expect(c.logs.join('\n')).toMatch(/Browser options changed - relaunching/);
    s = await read();
    expect(s).toMatchObject({ w: 1000, h: 500, l: 'en-US', ua: 'PlyrOpt/2' });

    // 4) options removed -> back to the defaults (1280x720), not stuck on the old ones
    const d = await run(pm, 'job-d', [launch(undefined)]);
    expect(d.logs.join('\n')).toMatch(/Browser options changed - relaunching/);
    s = await read();
    expect(s.w).toBe(1280); expect(s.h).toBe(720); expect(s.ua).not.toBe('PlyrOpt/2');

    await pm.getVipContext('bo-user')?.context.close().catch(() => {});
    void probe;
  }, 120_000);

  it('a bad option is refused before any browser opens', () => {
    expect(() => validateSteps([{ action: 'launch', params: { browserOptions: { viewportWidth: 1 } } }] as never, config.FULL_ACCESS_PLAN))
      .toThrow(/invalid browser options/);
  });
});
