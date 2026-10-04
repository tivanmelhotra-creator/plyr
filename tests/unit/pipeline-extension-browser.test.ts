/**
 * runPipeline + the `open-extension` step.
 *
 * What this protects:
 *   - a workflow WITHOUT the step is untouched: no Real Chrome, no lock;
 *   - a workflow WITH it runs on Real Chrome, in a tab of its own, never sees
 *     the operator's tabs, never closes the shared browser, and closes only
 *     the tabs it opened, on success AND on failure;
 *   - two such runs never overlap;
 *   - on a user's own local browser it fails clearly instead of misbehaving.
 *
 * Real Chrome is faked (extensions need a headed browser); the pipeline itself
 * is the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/core/BrowserAdapter', async (orig) => {
  const mod = await orig<typeof import('../../src/core/BrowserAdapter')>();
  return { ...mod, acquireContext: vi.fn() };
});

import { runPipeline } from '../../src/pipeline';
import { RealChrome } from '../../src/core/RealChrome';
import { browserModes } from '../../src/core/BrowserMode';
import { acquireContext } from '../../src/core/BrowserAdapter';
import { config } from '../../src/config';

const ID = 'c'.repeat(32);
const EXTENSIONS = [{
  id: ID, runtimeId: ID, name: 'J2TEAM Cookies', storeId: undefined,
  url: `chrome-extension://${ID}/`, popupUrl: `chrome-extension://${ID}/popup.html`, optionsUrl: '',
}];

class FakePage extends EventEmitter {
  closed = false;
  constructor(public currentUrl = 'about:blank') { super(); }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
  async goto(url: string) { this.currentUrl = url; }
  async bringToFront() {}
  async opener() { return null; }
}

class FakeRealChrome extends EventEmitter {
  all: FakePage[] = [];
  closeCalls = 0;
  pages() { return this.all.filter((p) => !p.closed); }
  async newPage() { const p = new FakePage(); this.all.push(p); return p; }
  async close() { this.closeCalls++; }
}

const plan = { quota: 1000, maxTabs: 3, maxSteps: 100, priority: 99, maxSchedules: 5, runLimit: 0 } as never;
const quotaManager = { hasQuotaRemaining: async () => true, consumeQuota: vi.fn(async () => {}) } as never;

function profileManager() {
  const base: Record<string, unknown> = {
    getJobOutputs: () => [],
    registerPage: vi.fn(),
    unregisterPage: vi.fn(),
    removeFreeContext: vi.fn(),
    removeVipContext: vi.fn(),
  };
  return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : vi.fn()) }) as never;
}

function run(steps: unknown[], jobId = 'job-1', extra: Record<string, unknown> = {}) {
  return runPipeline({
    userId: 'tester',
    steps: steps as never,
    log: vi.fn(),
    jobId,
    profileManager: profileManager(),
    userPlan: plan,
    quotaManager,
    ...extra,
  } as never);
}

let real: FakeRealChrome;
let operatorTab: FakePage;
let tmp = '';
let originalProfiles = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-ext-'));
  originalProfiles = config.PROFILES_DIR;
  (config as { PROFILES_DIR: string }).PROFILES_DIR = tmp;

  real = new FakeRealChrome();
  operatorTab = await real.newPage();
  operatorTab.currentUrl = 'https://site.test/operator-is-here';

  vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
  vi.spyOn(RealChrome, 'getContext').mockResolvedValue(real as never);
  vi.spyOn(RealChrome, 'loadedExtensions').mockReturnValue(EXTENSIONS as never);
  vi.spyOn(browserModes, 'modeOf').mockReturnValue('remote');
  vi.mocked(acquireContext).mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  (config as { PROFILES_DIR: string }).PROFILES_DIR = originalProfiles;
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('runPipeline — workflows WITHOUT an extension step are untouched', () => {
  it('never starts Real Chrome and takes the browser it always did', async () => {
    const localPage = new FakePage('https://site.test/');
    const localContext = new FakeRealChrome();
    localContext.all.push(localPage);
    vi.mocked(acquireContext).mockResolvedValue({ context: localContext, mode: 'remote', shared: true, detail: 'test' } as never);
    vi.spyOn(browserModes, 'modeOf').mockReturnValue('local');

    const result = await run([{ action: 'goto', params: { url: 'https://site.test/' } }]);

    expect(result.success).toBe(true);
    expect(RealChrome.getContext).not.toHaveBeenCalled();
    expect(acquireContext).toHaveBeenCalledTimes(1);
  });
});

describe('runPipeline — workflows WITH an extension step', () => {
  it('run on Real Chrome in tabs of their own, and close only those', async () => {
    const result = await run([{ action: 'open-extension', params: { extension: 'j2team-cookies' } }]);

    expect(result.success).toBe(true);
    expect(RealChrome.getContext).toHaveBeenCalledTimes(1);

    // The run opened a start tab and the extension tab; both are gone again.
    const mine = real.all.filter((p) => p !== operatorTab);
    expect(mine).toHaveLength(2);
    expect(mine.every((p) => p.closed)).toBe(true);
    expect(mine.some((p) => p.currentUrl.startsWith(`chrome-extension://${ID}/popup.html`))).toBe(true);

    // The operator's tab and the shared browser are exactly as they were.
    expect(operatorTab.closed).toBe(false);
    expect(operatorTab.currentUrl).toBe('https://site.test/operator-is-here');
    expect(real.closeCalls).toBe(0);
  });

  it('are never handed the operator\'s tab: goto does not "switch" to a tab already on that URL', async () => {
    // Without confinement, smartStay would adopt the operator's tab (it is
    // already on this URL) and the run would automate whatever they are doing.
    const result = await run([
      { action: 'open-extension', params: { extension: 'j2team-cookies' } },
      { action: 'goto', params: { url: 'https://site.test/operator-is-here' } },
    ]);
    expect(result.success).toBe(true);

    const mine = real.all.filter((p) => p !== operatorTab);
    expect(mine.some((p) => p.currentUrl === 'https://site.test/operator-is-here')).toBe(true); // the run navigated ITS tab
    expect(operatorTab.closed).toBe(false);
  });

  it('close their tabs, and leave the browser alone, when the run fails', async () => {
    await expect(
      run([{ action: 'open-extension', params: { extension: 'no-such-extension' } }]),
    ).rejects.toThrow(/No installed extension matches "no-such-extension".*j2team-cookies/);

    const mine = real.all.filter((p) => p !== operatorTab);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((p) => p.closed)).toBe(true);
    expect(operatorTab.closed).toBe(false);
    expect(real.closeCalls).toBe(0);
  });

  it('say so plainly when Real Chrome is disabled', async () => {
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(false);
    await expect(run([{ action: 'open-extension', params: { extension: 'j2team-cookies' } }]))
      .rejects.toThrow(/Real Chrome is disabled/);
    expect(RealChrome.getContext).not.toHaveBeenCalled();
  });

  it('are found inside nested branches too', async () => {
    const result = await run([
      { action: 'try', params: {}, steps: [{ action: 'open-extension', params: { extension: 'j2team-cookies' } }] },
    ]);
    expect(result.success).toBe(true);
    expect(RealChrome.getContext).toHaveBeenCalledTimes(1);
    const mine = real.all.filter((p) => p !== operatorTab);
    expect(mine.some((p) => p.currentUrl.startsWith(`chrome-extension://${ID}/`))).toBe(true);
  });

  it('never overlap: the second waits for the first to finish', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    vi.spyOn(RealChrome, 'getContext').mockImplementation(async () => {
      events.push('attach');
      return real as never;
    });
    const gate = new Promise<void>((r) => { releaseFirst = r; });

    const first = run(
      [{ action: 'open-extension', params: { extension: 'j2team-cookies' } }],
      'job-a',
      { isCancelled: async () => { events.push('first-checking'); await gate; return false; } },
    );
    await vi.waitFor(() => expect(events).toContain('first-checking'));

    const second = run([{ action: 'open-extension', params: { extension: 'j2team-cookies' } }], 'job-b');
    await new Promise((r) => setTimeout(r, 40));
    expect(events.filter((e) => e === 'attach')).toHaveLength(0); // first is parked before attaching; second must not have attached either

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.success && b.success).toBe(true);
    expect(events.filter((e) => e === 'attach')).toHaveLength(2);
  });
});

describe('runPipeline — an extension step on the user\'s own local browser', () => {
  it('fails clearly instead of misbehaving, and does not touch Real Chrome', async () => {
    const localContext = new FakeRealChrome();
    const localPage = new FakePage('https://site.test/');
    localContext.all.push(localPage);
    vi.mocked(acquireContext).mockResolvedValue({ context: localContext, mode: 'local', shared: true, detail: 'test' } as never);
    vi.spyOn(browserModes, 'modeOf').mockReturnValue('local');

    await expect(run([{ action: 'open-extension', params: { extension: 'j2team-cookies' } }]))
      .rejects.toThrow(/only in the server's Real Chrome/);

    expect(RealChrome.getContext).not.toHaveBeenCalled();
    expect(localPage.closed).toBe(false); // their tab is theirs
  });
});
