/**
 * The Code node inside the REAL pipeline (only the browser is faked):
 * item flow between nodes, $vars write-back, console lines on step.done,
 * `{{ }}` left untouched inside the code, the error policy (continue-on-fail
 * reaching the runtime through validateSteps), and the useBrowser path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../src/core/BrowserAdapter', async (orig) => {
  const mod = await orig<typeof import('../../src/core/BrowserAdapter')>();
  return { ...mod, acquireContext: vi.fn() };
});

import { runPipeline } from '../../src/pipeline';
import { browserModes } from '../../src/core/BrowserMode';
import { acquireContext } from '../../src/core/BrowserAdapter';
import { validateSteps } from '../../src/validation';
import { config } from '../../src/config';

class FakePage extends EventEmitter {
  closed = false;
  url() { return 'https://fake.test/page'; }
  isClosed() { return this.closed; }
  async title() { return 'Fake Title'; }
}
class FakeContext extends EventEmitter {
  all: FakePage[] = [new FakePage()];
  pages() { return this.all; }
  async newPage() { const p = new FakePage(); this.all.push(p); return p; }
  async close() {}
}

const plan = { quota: 1000, maxTabs: 3, maxSteps: 100, priority: 99, maxSchedules: 5, runLimit: 0 } as never;
const quotaManager = { hasQuotaRemaining: async () => true, consumeQuota: vi.fn(async () => {}) } as never;
function profileManager() {
  const outputs: unknown[] = [];
  const base: Record<string, unknown> = { getJobOutputs: () => outputs };
  return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : vi.fn()) }) as never;
}

type Ev = { type: string; data: Record<string, any> };
async function run(steps: unknown[]) {
  const events: Ev[] = [];
  const logs: string[] = [];
  let result: any; let error: any;
  try {
    result = await runPipeline({
      userId: 'tester', steps: validateSteps(steps as never, config.FULL_ACCESS_PLAN) as never,
      log: (m: string) => logs.push(m), jobId: 'job-code', profileManager: profileManager(),
      userPlan: plan, quotaManager,
      onEvent: (type: string, data?: Record<string, unknown>) => events.push({ type, data: (data || {}) as any }),
    } as never);
  } catch (e) { error = e; }
  return { result, error, events, logs, done: events.filter((e) => e.type === 'step.done') };
}

// The test env pins DEPLOYMENT_MODE=multi, where the node is always off; the
// behaviour under test is the single-user one, so switch the gate on here.
let prevEnabled = false;
beforeEach(() => {
  prevEnabled = config.CODE_NODE_ENABLED;
  (config as any).CODE_NODE_ENABLED = true;
  vi.spyOn(browserModes, 'modeOf').mockReturnValue('local');
  vi.mocked(acquireContext).mockReset();
  vi.mocked(acquireContext).mockResolvedValue({ context: new FakeContext(), mode: 'remote', shared: true, detail: 't' } as never);
});
afterEach(() => { (config as any).CODE_NODE_ENABLED = prevEnabled; vi.restoreAllMocks(); });

describe('Code node in the pipeline', () => {
  it('items flow from one Code node to the next; $vars and console are reported', async () => {
    const { result, done, logs } = await run([
      { action: 'code', params: { code: 'console.log("make"); $vars.made = 3; return [{ n: 1 }, { n: 2 }, { n: 3 }];' } },
      { action: 'code', params: { mode: 'runOnceForEachItem', code: 'return { n: $json.n * 10, made: $vars.made };' } },
    ]);
    expect(result.success).toBe(true);
    expect(done).toHaveLength(2);
    expect(done[0].data.outputItemCount).toBe(3);
    expect(done[0].data.consoleLogs).toEqual(['[log] make']);
    expect(done[0].data.variables).toMatchObject({ made: '3' });
    expect(done[1].data.inputItemCount).toBe(3);
    expect(done[1].data.outputSample).toEqual([{ n: 10, made: 3 }, { n: 20, made: 3 }, { n: 30, made: 3 }]);
    expect(logs.some((l) => l.includes('[CODE] [log] make'))).toBe(true);
  });

  it('returning nothing yields zero items (no pass-through)', async () => {
    const { done } = await run([
      { action: 'code', params: { code: 'return [{ a: 1 }];' } },
      { action: 'code', params: { code: 'return [];' } },
    ]);
    expect(done[1].data.outputItemCount).toBe(0);
  });

  it('{{ }} inside the code is NOT treated as a workflow variable', async () => {
    const { done } = await run([
      { action: 'set_variable', params: { name: 'x', value: 'WRONG' } },
      { action: 'code', params: { code: 'return { s: "{{x}}" };' } },
    ]);
    expect(done[done.length - 1].data.outputSample).toEqual([{ s: '{{x}}' }]);
  });

  it('an error fails the run with the node message', async () => {
    const { error, events } = await run([{ action: 'code', params: { code: 'throw new Error("boom")' } }]);
    expect(String(error?.message)).toMatch(/Code node: boom/);
    expect(events.some((e) => e.type === 'step.error' && /boom/.test(e.data.error))).toBe(true);
  });

  it('Continue On Fail survives validateSteps and lets the run go on', async () => {
    const { result, done, events } = await run([
      { action: 'code', params: { code: 'throw new Error("boom")' }, continueOnFail: true },
      { action: 'code', params: { code: 'return { after: true };' } },
    ]);
    expect(result.success).toBe(true);
    expect(events.some((e) => e.type === 'step.error')).toBe(true);
    expect(done[done.length - 1].data.outputSample).toEqual([{ after: true }]);
  });

  it('Retry On Fail retries the node', async () => {
    const { result, events } = await run([
      { action: 'code', params: { code: '$vars.tries = ($vars.tries || 0) + 1; if ($vars.tries < 2) throw new Error("again"); return { ok: $vars.tries };' },
        retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 0 },
    ]);
    // $vars changes are only written back on success, so each attempt starts
    // from the same state: the node keeps failing and the retry is exhausted.
    expect(events.filter((e) => e.type === 'step.retry')).toHaveLength(2);
    expect(result).toBeUndefined();
  });

  it('a timeout in worker mode fails the step', async () => {
    const { error } = await run([{ action: 'code', params: { code: 'while(true){}', timeoutMs: 200 } }]);
    expect(String(error?.message)).toMatch(/timed out after 200ms/);
  });

  it('useBrowser hands the live page to the code', async () => {
    const { done } = await run([
      { action: 'code', params: { useBrowser: true, code: 'return { url: page.url(), title: await page.title() };' } },
    ]);
    expect(done[0].data.outputSample).toEqual([{ url: 'https://fake.test/page', title: 'Fake Title' }]);
  });

  it('refuses to run when the node is disabled by config', async () => {
    (config as any).CODE_NODE_ENABLED = false;
    const { error } = await run([{ action: 'code', params: { code: 'return {}' } }]);
    expect(String(error?.message)).toMatch(/disabled|not available/);
  });
});

describe('disabled steps (Task 5)', () => {
  it('a disabled Code node is skipped by the real pipeline, the rest runs', async () => {
    const { result, done, logs } = await run([
      { action: 'code', params: { code: 'console.log("RAN"); return [{ n: 1 }];' }, disabled: true },
      { action: 'code', params: { code: 'return [{ n: 2 }];' } },
    ]);
    expect(result.success).toBe(true);
    expect(done).toHaveLength(1);
    expect(done[0].data.outputSample).toEqual([{ n: 2 }]);
    expect(logs.some((l) => l.includes('RAN'))).toBe(false);
  });

  it('`disabled` survives validateSteps (only a literal true is kept)', () => {
    const out = validateSteps([
      { action: 'code', params: { code: 'x' }, disabled: true },
      { action: 'code', params: { code: 'x' }, disabled: 'yes' },
    ] as never, config.FULL_ACCESS_PLAN) as any[];
    expect(out[0].disabled).toBe(true);
    expect(out[1].disabled).toBeUndefined();
  });
});
