/**
 * runPipeline -> live step events: the CONTRACT between the pipeline and the UI.
 *
 * Bug this protects against: `step.start` was emitted for every step but
 * `step.done` only for the few handlers that fell out of the bottom of the loop.
 * ~39 built-in handlers leave through `continue stepLoop`, so a workflow made of
 * trigger/goto/wait/screenshot reported `job.done` (the panel said "Success")
 * with every node still showing the "running" clock and "0 ok / 0 err".
 *
 * The rule asserted here, for every kind of step: each `step.start` is closed by
 * exactly one `step.done` (or `step.error`) carrying the SAME index.
 *
 * The pipeline is the real one; only the browser is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

vi.mock('../../src/core/BrowserAdapter', async (orig) => {
  const mod = await orig<typeof import('../../src/core/BrowserAdapter')>();
  return { ...mod, acquireContext: vi.fn() };
});

import { runPipeline } from '../../src/pipeline';
import { browserModes } from '../../src/core/BrowserMode';
import { acquireContext } from '../../src/core/BrowserAdapter';
import { config } from '../../src/config';
import { resolveArtifact } from '../../src/core/JobArtifacts';

class FakePage extends EventEmitter {
  closed = false;
  currentUrl = 'about:blank';
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async goto(url: string) { this.currentUrl = url; }
  async reload() {}
  async bringToFront() {}
  async screenshot() { return Buffer.from('fake-png-bytes'); }
  async waitForSelector() {}
  locator() {
    return {
      first: () => ({ isVisible: async () => false, innerText: async () => '', getAttribute: async () => 'one' }),
      innerText: async () => '',
      evaluateAll: async () => ['a', 'b', 'c'],
    };
  }
}

class FakeContext extends EventEmitter {
  all: FakePage[] = [];
  pages() { return this.all.filter((p) => !p.closed); }
  async newPage() { const p = new FakePage(); this.all.push(p); return p; }
  async close() {}
}

const plan = { quota: 1000, maxTabs: 3, maxSteps: 100, priority: 99, maxSchedules: 5, runLimit: 0 } as never;
const quotaManager = { hasQuotaRemaining: async () => true, consumeQuota: vi.fn(async () => {}) } as never;

function profileManager() {
  const outputs: unknown[] = [];
  const base: Record<string, unknown> = {
    getJobOutputs: () => outputs,
    registerPage: vi.fn(),
    unregisterPage: vi.fn(),
    removeFreeContext: vi.fn(),
    removeVipContext: vi.fn(),
  };
  return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : vi.fn()) }) as never;
}

type Ev = { type: string; data: Record<string, any> };

// The REAL browser-side reducer (public/js/run-state.js): the thing that turns
// these events into the clock / tick / cross icons and the "N ok / N err" tally.
interface UiStep { status: string; action: string }
interface UiState { steps: Record<string, UiStep>; order: number[] }
interface UiReducer {
  create: () => UiState;
  applyEvent: (s: UiState, ev: { type: string; data?: unknown }) => UiState;
  counts: (s: UiState) => { total: number; running: number; success: number; error: number };
}
const RunState: UiReducer = (() => {
  const code = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'run-state.js'), 'utf8');
  const sandbox: { window: { RunState?: UiReducer } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'run-state.js' });
  return sandbox.window.RunState!;
})();

/** What the panel would show after the run: feed every event through the UI reducer. */
function uiAfter(events: Ev[]) {
  let st = RunState.create();
  for (const ev of events) st = RunState.applyEvent(st, ev);
  return { st, counts: RunState.counts(st) };
}

async function runAndCollect(steps: unknown[]) {
  const events: Ev[] = [];
  const result = await runPipeline({
    userId: 'tester',
    steps: steps as never,
    log: vi.fn(),
    jobId: 'job-events',
    profileManager: profileManager(),
    userPlan: plan,
    quotaManager,
    onEvent: (type: string, data?: Record<string, unknown>) => events.push({ type, data: (data || {}) as any }),
  } as never);
  return { result, events };
}

/**
 * The contract the UI depends on: after the run, NO step is left "running".
 * (Container steps - if/loop/try - have no output of their own, so their
 * `step.start` shares an index with their first child / the next step; what
 * matters is that every index ends up resolved.)
 */
function expectNothingLeftRunning(events: Ev[]) {
  const starts = events.filter((e) => e.type === 'step.start');
  expect(starts.length).toBeGreaterThan(0);
  const { counts } = uiAfter(events);
  expect(counts.running, 'steps still showing the running clock').toBe(0);
  // ...and every index that started was closed by a done/error that came AFTER it.
  for (const s of starts) {
    const after = events
      .slice(events.indexOf(s) + 1)
      .some((e) => (e.type === 'step.done' || e.type === 'step.error') && e.data.index === s.data.index);
    expect(after, `step #${s.data.index} (${s.data.action}) was never closed`).toBe(true);
  }
}

beforeEach(() => {
  const page = new FakePage();
  const ctx = new FakeContext();
  ctx.all.push(page);
  vi.spyOn(browserModes, 'modeOf').mockReturnValue('local');
  vi.mocked(acquireContext).mockReset();
  vi.mocked(acquireContext).mockResolvedValue({ context: ctx, mode: 'remote', shared: true, detail: 'test' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPipeline — every started step is reported as finished', () => {
  it('the "Scheduled screenshot" template: trigger, goto, wait, screenshot', async () => {
    const { result, events } = await runAndCollect([
      { action: 'trigger_schedule', params: { cron: '0 9 * * *', timezone: 'UTC' } },
      { action: 'goto', params: { url: 'https://example.com' } },
      { action: 'wait', params: { ms: '10' } },
      { action: 'screenshot', params: {} },
    ]);

    expect(result.success).toBe(true);
    expectNothingLeftRunning(events);

    const done = events.filter((e) => e.type === 'step.done');
    expect(done.map((e) => e.data.action)).toEqual(['trigger_schedule', 'navigate', 'wait', 'screenshot']);
    expect(done.every((e) => e.data.success === true)).toBe(true);

    // What the user sees: 4 ok / 0 err / 4 - not "0 ok / 0 err / 4".
    expect(uiAfter(events).counts).toEqual({ total: 4, running: 0, success: 4, error: 0 });
  });

  it('log, set_variable and a variable node (handlers that used to be silent)', async () => {
    const { result, events } = await runAndCollect([
      { action: 'log', params: { message: 'hello' } },
      { action: 'set_variable', params: { name: 'x', value: '1' } },
      { action: 'variable', params: { op: 'set', name: 'y', value: '2' } },
    ]);
    expect(result.success).toBe(true);
    expectNothingLeftRunning(events);
  });

  it('a container step with no matching branch still closes (nothing left spinning)', async () => {
    const { result, events } = await runAndCollect([
      { action: 'log', params: { message: 'before' } },
      { action: 'if', condition: { type: 'variable', name: 'nope', operator: 'equals', value: 'x' }, then: [
        { action: 'log', params: { message: 'inside' } },
      ] },
      { action: 'log', params: { message: 'after' } },
    ]);
    expect(result.success).toBe(true);
    expectNothingLeftRunning(events);
  });

  it('a loop and its inner steps all resolve', async () => {
    const { result, events } = await runAndCollect([
      { action: 'loop', params: { count: '2' }, steps: [{ action: 'log', params: { message: 'tick' } }] },
      { action: 'log', params: { message: 'after' } },
    ]);
    expect(result.success).toBe(true);
    expectNothingLeftRunning(events);
    expect(uiAfter(events).counts.error).toBe(0);
  });

  it('a failing step reports exactly one step.error and no step.done for that index', async () => {
    const events: Ev[] = [];
    await runPipeline({
      userId: 'tester',
      steps: [{ action: 'log', params: { message: 'ok' } }, { action: 'goto', params: {} }] as never,
      log: vi.fn(),
      jobId: 'job-err',
      profileManager: profileManager(),
      userPlan: plan,
      quotaManager,
      onEvent: (type: string, data?: Record<string, unknown>) => events.push({ type, data: (data || {}) as any }),
    } as never).catch(() => {});

    const errs = events.filter((e) => e.type === 'step.error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.data.index).toBe(2);
    expect(events.filter((e) => e.type === 'step.done' && e.data.index === 2)).toHaveLength(0);
    // The step before it did finish.
    expect(events.filter((e) => e.type === 'step.done' && e.data.index === 1)).toHaveLength(1);
  });

  it('step.start and step.error agree on the index (they used to be off by one)', async () => {
    const events: Ev[] = [];
    await runPipeline({
      userId: 'tester',
      steps: [{ action: 'goto', params: {} }] as never,
      log: vi.fn(),
      jobId: 'job-idx',
      profileManager: profileManager(),
      userPlan: plan,
      quotaManager,
      onEvent: (type: string, data?: Record<string, unknown>) => events.push({ type, data: (data || {}) as any }),
    } as never).catch(() => {});
    const start = events.find((e) => e.type === 'step.start')!;
    const err = events.find((e) => e.type === 'step.error')!;
    expect(err.data.index).toBe(start.data.index);
  });

  it('retry-on-fail: the retries stay invisible: one start, one step.done, no step.error', async () => {
    let calls = 0;
    const page = (await (vi.mocked(acquireContext).getMockImplementation()!)('x' as never) as any).context.all[0] as FakePage;
    page.goto = async (url: string) => { calls++; if (calls < 2) throw new Error('flaky'); page.currentUrl = url; };
    const { result, events } = await runAndCollect([
      { action: 'goto', params: { url: 'https://example.com/retry' }, retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 1 },
    ]);
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === 'step.start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.done')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.error')).toHaveLength(0);
  });

  it('continue-on-fail: the failure is shown once as an error and the run goes on', async () => {
    const { result, events } = await runAndCollect([
      { action: 'goto', params: {}, continueOnFail: true }, // "URL required", swallowed
      { action: 'log', params: { message: 'still running' } },
    ]);
    expect(result.success).toBe(true);
    expectNothingLeftRunning(events);
    expect(events.filter((e) => e.type === 'step.error')).toHaveLength(1);
    expect(uiAfter(events).counts).toEqual({ total: 2, running: 0, success: 1, error: 1 });
  });
});

describe('runPipeline — item flow reaches the panel for built-in steps (not just modules)', () => {
  const doneBy = (events: Ev[], action: string) =>
    events.find((e) => e.type === 'step.done' && e.data.action === action)!.data;

  it('every built-in step reports input/output counts and a sample', async () => {
    const { events } = await runAndCollect([
      { action: 'trigger_schedule', params: { cron: '0 9 * * *' } },
      { action: 'goto', params: { url: 'https://example.com/a' } },
      { action: 'wait', params: { ms: '5' } },
      { action: 'screenshot', params: {} },
    ]);
    for (const e of events.filter((x) => x.type === 'step.done')) {
      expect(e.data.inputItemCount, `${e.data.action} input`).toBe(1);
      expect(e.data.outputItemCount, `${e.data.action} output`).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(e.data.outputSample), `${e.data.action} sample`).toBe(true);
    }
    expect(doneBy(events, 'navigate').outputSample[0]).toMatchObject({ url: 'https://example.com/a' });
    expect(doneBy(events, 'wait').outputSample[0]).toMatchObject({ type: 'time', ms: 5 });
    expect(doneBy(events, 'screenshot').outputSample[0]).toMatchObject({ type: 'png' });
  });

  it('a trigger forwards the stream it was given untouched', async () => {
    const events: Ev[] = [];
    await runPipeline({
      userId: 'tester',
      steps: [{ action: 'trigger_webhook', params: {} }] as never,
      log: vi.fn(),
      jobId: 'job-trigger',
      profileManager: profileManager(),
      userPlan: plan,
      quotaManager,
      initialItems: [{ json: { order: 7 } }, { json: { order: 8 } }],
      onEvent: (type: string, data?: Record<string, unknown>) => events.push({ type, data: (data || {}) as any }),
    } as never);
    const d = events.find((e) => e.type === 'step.done')!.data;
    expect(d.inputItemCount).toBe(2);
    expect(d.outputItemCount).toBe(2);
    expect(d.outputSample).toEqual([{ order: 7 }, { order: 8 }]);
  });

  it('extract-data turns a list into one item per element (not one { count, data } blob)', async () => {
    const { events } = await runAndCollect([
      { action: 'extract-data', params: { selector: '.row', attribute: 'href' } },
    ]);
    const d = doneBy(events, 'extract-data');
    expect(d.outputItemCount).toBe(3);
    expect(d.outputSample).toEqual([{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
  });

  it('log shows what it logged', async () => {
    const { events } = await runAndCollect([{ action: 'log', params: { message: 'hello' } }]);
    expect(doneBy(events, 'log').outputSample).toEqual([{ message: 'hello' }]);
  });

  it('the item count flows from step to step', async () => {
    const { events } = await runAndCollect([
      { action: 'log', params: { message: 'a' } },
      { action: 'log', params: { message: 'b' } },
    ]);
    const done = events.filter((e) => e.type === 'step.done');
    expect(done[1]!.data.inputItemCount).toBe(done[0]!.data.outputItemCount);
  });

  it('a failed step has no item flow (nothing was produced)', async () => {
    const { events } = await runAndCollect([{ action: 'goto', params: {}, continueOnFail: true }]);
    expect(events.filter((e) => e.type === 'step.done')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.error')).toHaveLength(1);
  });

  it('a retried step reports its flow once, from the attempt that succeeded', async () => {
    let calls = 0;
    const page = (await (vi.mocked(acquireContext).getMockImplementation()!)('x' as never) as any).context.all[0] as FakePage;
    page.goto = async (url: string) => { calls++; if (calls < 2) throw new Error('flaky'); page.currentUrl = url; };
    const { events } = await runAndCollect([
      { action: 'goto', params: { url: 'https://example.com/r' }, retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 1 },
      { action: 'log', params: { message: 'next' } },
    ]);
    const done = events.filter((e) => e.type === 'step.done');
    expect(done).toHaveLength(2);
    expect(done[0]!.data.inputItemCount).toBe(1);
    expect(done[1]!.data.inputItemCount).toBe(done[0]!.data.outputItemCount); // not double-counted
  });
});

describe('runPipeline — a screenshot is kept so the panel can show it', () => {
  let tmp = '';
  let origProfiles = '';
  let origMax = 0;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-shot-'));
    origProfiles = config.PROFILES_DIR;
    origMax = config.ARTIFACT_MAX_BYTES;
    (config as { PROFILES_DIR: string }).PROFILES_DIR = tmp;
  });
  afterEach(async () => {
    (config as { PROFILES_DIR: string }).PROFILES_DIR = origProfiles;
    (config as { ARTIFACT_MAX_BYTES: number }).ARTIFACT_MAX_BYTES = origMax;
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const shot = (events: Ev[]) => events.find((e) => e.type === 'step.done' && e.data.action === 'screenshot')!.data;

  it('saves the image and hands the panel a reference, never the bytes', async () => {
    const { events } = await runAndCollect([{ action: 'screenshot', params: {} }]);
    const sample = shot(events).outputSample[0];

    expect(sample.image).toMatchObject({ mimeType: 'image/png', size: Buffer.from('fake-png-bytes').length });
    expect(sample.image.url).toBe('/job/tester/job-events/artifact/step-1.png');
    // The event stays small: no base64 of the picture anywhere in it.
    expect(JSON.stringify(shot(events))).not.toContain(Buffer.from('fake-png-bytes').toString('base64'));

    const file = await resolveArtifact('tester', 'job-events', 'step-1.png');
    expect(file).not.toBeNull();
    expect(await fsp.readFile(file!.path, 'utf8')).toBe('fake-png-bytes');
  });

  it('names the file after the step, so two screenshots never overwrite each other', async () => {
    const { events } = await runAndCollect([
      { action: 'screenshot', params: {} },
      { action: 'log', params: { message: 'between' } },
      { action: 'screenshot', params: {} },
    ]);
    const urls = events.filter((e) => e.type === 'step.done' && e.data.action === 'screenshot')
      .map((e) => e.data.outputSample[0].image.url);
    expect(urls).toEqual([
      '/job/tester/job-events/artifact/step-1.png',
      '/job/tester/job-events/artifact/step-3.png',
    ]);
  });

  it('still succeeds when the image cannot be kept (disk problem): no image, no failure', async () => {
    // PROFILES_DIR is a FILE, so creating the artifacts dir under it fails.
    const blocker = path.join(tmp, 'blocker');
    await fsp.writeFile(blocker, 'x');
    (config as { PROFILES_DIR: string }).PROFILES_DIR = blocker;

    const { result, events } = await runAndCollect([{ action: 'screenshot', params: {} }]);
    expect(result.success).toBe(true);
    expect(shot(events).success).toBe(true);
    expect(shot(events).outputSample[0].image).toBeUndefined();
    expect(shot(events).outputSample[0]).toMatchObject({ type: 'png' });
  });

  it('does not keep an oversized capture, but the step still succeeds', async () => {
    (config as { ARTIFACT_MAX_BYTES: number }).ARTIFACT_MAX_BYTES = 4;
    const { result, events } = await runAndCollect([{ action: 'screenshot', params: {} }]);
    expect(result.success).toBe(true);
    expect(shot(events).outputSample[0].image).toBeUndefined();
    expect(await resolveArtifact('tester', 'job-events', 'step-1.png')).toBeNull();
  });
});

