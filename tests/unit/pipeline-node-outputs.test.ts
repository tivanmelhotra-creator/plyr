/**
 * Phase 2 — a node's Success / Error / Timeout outputs and its retry policy,
 * in the REAL pipeline (only the browser is faked; Code nodes produce the
 * failures, so no page is needed).
 *
 *   - success continues down the chain; the Error output does not run
 *   - an error runs the Error output with the failure as its item, then the
 *     group is LEFT (the success chain after the node does not run)
 *   - a timeout takes the Timeout output, or the Error output when there is none
 *   - retryOn: 'timeout' does not retry an error; backoff modes
 *   - fatal control flow (Stop-and-error is NOT fatal; cancel is) never routes
 *   - the new fields survive validateSteps and nested steps are validated
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
      log: (m: string) => logs.push(m), jobId: 'job-outputs', profileManager: profileManager(),
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

const code = (c: string, extra: Record<string, unknown> = {}) => ({ action: 'code', params: { code: c }, ...extra });
const log = (m: string) => ({ action: 'log', params: { message: m } });
const userLines = (logs: string[]) => logs.filter((l) => l.startsWith('[USER] ')).map((l) => l.slice(7));

describe('Success / Error / Timeout outputs', () => {
  it('success goes on down the chain; the Error output does not run', async () => {
    const { result, logs } = await run([code('return { ok: 1 };', { errorSteps: [log('ERR')] }), log('AFTER')]);
    expect(result.success).toBe(true);
    expect(userLines(logs)).toEqual(['AFTER']);
  });

  it('an error runs the Error output with the failure as its item, and the success chain does not run', async () => {
    const { result, logs, events } = await run([
      code('throw new Error("boom\\nsecond line")', { errorSteps: [code('$vars.e = $json.error + \"|\" + $json.kind + \"|\" + $json.node; return $json;'), log('ERR {{e}}')] }),
      log('AFTER'),
    ]);
    expect(result.success).toBe(true);
    const lines = userLines(logs);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('ERR');
    expect(lines[0]).toContain('boom');
    expect(lines[0]).not.toContain('second line');
    expect(lines[0]).toContain('|error|code');
    expect(events.some((e) => e.type === 'step.path' && e.data.path === 'error')).toBe(true);
  });

  it('a timeout takes the Timeout output; without one it takes the Error output', async () => {
    const t1 = await run([code('throw new Error("Timeout 50ms exceeded")', { timeoutSteps: [log('TIMEOUT')], errorSteps: [log('ERR')] }), log('AFTER')]);
    expect(userLines(t1.logs)).toEqual(['TIMEOUT']);
    const t2 = await run([code('throw new Error("Timeout 50ms exceeded")', { errorSteps: [log('ERR')] })]);
    expect(userLines(t2.logs)).toEqual(['ERR']);
    // An error never takes the Timeout output.
    const t3 = await run([code('throw new Error("plain")', { timeoutSteps: [log('TIMEOUT')] }), log('AFTER')]);
    expect(t3.error || t3.result?.success === false).toBeTruthy();
    expect(userLines(t3.logs)).toEqual([]);
  });

  it('a node without failure outputs keeps the old behaviour (the run fails)', async () => {
    const { result, error, logs } = await run([code('throw new Error("x")'), log('AFTER')]);
    expect(error || result?.success === false).toBeTruthy();
    expect(userLines(logs)).toEqual([]);
  });

  it('the Error output runs after the retries are used up', async () => {
    const { logs } = await run([
      code('$vars.n = Number($vars.n || 0) + 1; throw new Error("fail")', { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 0, errorSteps: [log('ERR {{n}}')] }),
    ]);
    expect(logs.filter((l) => l.startsWith('[RETRY]')).length).toBe(2);
    expect(userLines(logs)[0]).toMatch(/^ERR/);
  });

  it("retryOn 'timeout' does not retry a plain error", async () => {
    const { logs } = await run([code('throw new Error("plain")', { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 0, retryOn: 'timeout', errorSteps: [log('ERR')] })]);
    expect(logs.filter((l) => l.startsWith('[RETRY]')).length).toBe(0);
    expect(userLines(logs)).toEqual(['ERR']);
  });

  it('the new fields survive validation, and nested output steps are validated', () => {
    const v = validateSteps([code('return 1', { retryOn: 'error', retryBackoff: 'exponential', timeoutMs: 5000, errorSteps: [log('a')], timeoutSteps: [log('b')] })] as never, config.FULL_ACCESS_PLAN) as any[];
    expect(v[0]).toMatchObject({ retryOn: 'error', retryBackoff: 'exponential', timeoutMs: 5000 });
    expect(v[0].errorSteps[0].action).toBe('log');
    expect(v[0].timeoutSteps[0].action).toBe('log');
    expect(v[0].params.errorSteps).toBeUndefined();
    expect(() => validateSteps([code('1', { errorSteps: [{ action: '../../etc' }] })] as never, config.FULL_ACCESS_PLAN)).toThrow();
    // Garbage enumerations are dropped.
    const g = validateSteps([code('1', { retryOn: 'sometimes', retryBackoff: 'x', timeoutMs: -1 })] as never, config.FULL_ACCESS_PLAN) as any[];
    expect(g[0].retryOn).toBeUndefined();
    expect(g[0].retryBackoff).toBeUndefined();
    expect(g[0].timeoutMs).toBeUndefined();
  });
});
