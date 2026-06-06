/**
 * run-state.test.ts — Step 26
 *
 * Tests the browser-side, DOM-free live-execution reducer
 * (public/js/run-state.js). The reducer turns the WS/SSE event stream
 * (job.start / step.start / step.done / step.error / job.done / job.error / log)
 * into a render-ready run-state, and maps each backend 1-based step index to the
 * 0-based graph-chain node index the editor paints.
 *
 * DOM-free, like action-catalog / graph-serialize / expression tests: the module
 * only touches `window`, so a tiny shim under node:vm is enough — no jsdom.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type Ev = { type: string; data?: Record<string, unknown> };
interface Step {
  index: number; action: string; status: string;
  inputItemCount: number | null; outputItemCount: number | null;
  outputSample: unknown; outputTruncated: boolean;
  durationMs: number | null; error: string | null;
}
interface State {
  phase: string; jobId: string | null; durationMs: number | null; error: string | null;
  steps: Record<string, Step>; order: number[];
  log: Array<{ type: string; text: string }>;
}
interface RunState {
  create: () => State;
  reset: (s: State) => State;
  applyEvent: (s: State, ev: Ev) => State;
  stepAt: (s: State, i: number) => Step | null;
  stepStatus: (s: State, i: number) => string;
  nodeStatusMap: (s: State) => Record<string, string>;
  counts: (s: State) => { total: number; running: number; success: number; error: number };
  isTerminal: (s: State) => boolean;
}

let R: RunState;

beforeAll(() => {
  const file = join(__dirname, '..', '..', 'public', 'js', 'run-state.js');
  const code = readFileSync(file, 'utf8');
  const sandbox: { window: { RunState?: RunState } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'run-state.js' });
  if (!sandbox.window.RunState) throw new Error('run-state.js did not expose window.RunState');
  R = sandbox.window.RunState;
});

function feed(events: Ev[]): State {
  let s = R.create();
  events.forEach((ev) => { s = R.applyEvent(s, ev); });
  return s;
}

describe('run-state reducer — lifecycle', () => {
  it('create() yields an idle empty state', () => {
    const s = R.create();
    expect(s.phase).toBe('idle');
    expect(s.order).toEqual([]);
    expect(R.isTerminal(s)).toBe(false);
  });

  it('job.start moves to running', () => {
    const s = feed([{ type: 'job.start', data: {} }]);
    expect(s.phase).toBe('running');
  });

  it('a full happy run ends in done with per-step success', () => {
    const s = feed([
      { type: 'job.start', data: {} },
      { type: 'step.start', data: { index: 1, action: 'goto' } },
      { type: 'step.done', data: { index: 1, action: 'goto', success: true, durationMs: 42, outputItemCount: 1 } },
      { type: 'step.start', data: { index: 2, action: 'extract' } },
      { type: 'step.done', data: { index: 2, action: 'extract', success: true, durationMs: 10, outputItemCount: 5, inputItemCount: 1 } },
      { type: 'job.done', data: { durationMs: 60 } },
    ]);
    expect(s.phase).toBe('done');
    expect(R.isTerminal(s)).toBe(true);
    expect(s.durationMs).toBe(60);
    expect(R.stepStatus(s, 1)).toBe('success');
    expect(R.stepStatus(s, 2)).toBe('success');
    const c = R.counts(s);
    expect(c).toEqual({ total: 2, running: 0, success: 2, error: 0 });
  });

  it('captures item counts, sample and timing on step.done', () => {
    const s = feed([
      { type: 'step.start', data: { index: 1, action: 'extract' } },
      { type: 'step.done', data: { index: 1, action: 'extract', success: true, durationMs: 33, inputItemCount: 2, outputItemCount: 7, outputSample: [{ a: 1 }], outputTruncated: true } },
    ]);
    const st = R.stepAt(s, 1)!;
    expect(st.inputItemCount).toBe(2);
    expect(st.outputItemCount).toBe(7);
    expect(st.outputSample).toEqual([{ a: 1 }]);
    expect(st.outputTruncated).toBe(true);
    expect(st.durationMs).toBe(33);
    expect(st.status).toBe('success');
  });
});

describe('run-state reducer — errors', () => {
  it('step.error marks the step failed with a message', () => {
    const s = feed([
      { type: 'step.start', data: { index: 1, action: 'click' } },
      { type: 'step.error', data: { index: 1, action: 'click', error: 'selector not found' } },
    ]);
    const st = R.stepAt(s, 1)!;
    expect(st.status).toBe('error');
    expect(st.error).toBe('selector not found');
  });

  it('step.done with success:false is treated as error', () => {
    const s = feed([
      { type: 'step.done', data: { index: 1, action: 'click', success: false, error: 'timeout' } },
    ]);
    expect(R.stepStatus(s, 1)).toBe('error');
    expect(R.stepAt(s, 1)!.error).toBe('timeout');
  });

  it('falls back to data.message when error is absent (live.js path)', () => {
    const s = feed([
      { type: 'step.error', data: { index: 2, action: 'fill', message: 'boom' } },
    ]);
    expect(R.stepAt(s, 2)!.error).toBe('boom');
  });

  it('job.error sets phase=error and a top-level message', () => {
    const s = feed([
      { type: 'job.start', data: {} },
      { type: 'job.error', data: { message: 'crashed' } },
    ]);
    expect(s.phase).toBe('error');
    expect(s.error).toBe('crashed');
    expect(R.isTerminal(s)).toBe(true);
  });
});

describe('run-state reducer — robustness', () => {
  it('ignores null / typeless events without throwing', () => {
    let s = R.create();
    expect(() => { s = R.applyEvent(s, null as unknown as Ev); }).not.toThrow();
    expect(() => { s = R.applyEvent(s, {} as Ev); }).not.toThrow();
    expect(s.phase).toBe('idle');
  });

  it('tolerates out-of-order events (step.done before step.start)', () => {
    const s = feed([
      { type: 'step.done', data: { index: 1, action: 'goto', success: true } },
      { type: 'step.start', data: { index: 1, action: 'goto' } },
    ]);
    // last event wins for status; step still exists exactly once
    expect(s.order).toEqual([1]);
    expect(R.stepStatus(s, 1)).toBe('running');
  });

  it('does not duplicate a step seen multiple times', () => {
    const s = feed([
      { type: 'step.start', data: { index: 1, action: 'goto' } },
      { type: 'step.start', data: { index: 1, action: 'goto' } },
      { type: 'step.done', data: { index: 1, action: 'goto', success: true } },
    ]);
    expect(s.order).toEqual([1]);
    expect(Object.keys(s.steps)).toEqual(['1']);
  });

  it('caps the log to avoid unbounded growth', () => {
    let s = R.create();
    for (let i = 0; i < 1200; i++) s = R.applyEvent(s, { type: 'log', data: { message: 'x' + i } });
    expect(s.log.length).toBeLessThanOrEqual(500);
    // most recent entry preserved
    expect(s.log[s.log.length - 1].text).toBe('x1199');
  });

  it('reset() clears steps but keeps the jobId', () => {
    let s = feed([
      { type: 'step.start', data: { index: 1, action: 'goto' } },
      { type: 'job.done', data: {} },
    ]);
    s.jobId = 'job_42';
    const r = R.reset(s);
    expect(r.jobId).toBe('job_42');
    expect(r.order).toEqual([]);
    expect(r.phase).toBe('idle');
  });
});

describe('run-state reducer — node mapping', () => {
  it('maps 1-based backend index to 0-based chain node index', () => {
    const s = feed([
      { type: 'step.start', data: { index: 1, action: 'goto' } },
      { type: 'step.done', data: { index: 1, action: 'goto', success: true } },
      { type: 'step.start', data: { index: 2, action: 'click' } },
      { type: 'step.error', data: { index: 2, action: 'click', error: 'x' } },
    ]);
    const map = R.nodeStatusMap(s);
    expect(map['0']).toBe('success'); // step 1 -> node[0]
    expect(map['1']).toBe('error');   // step 2 -> node[1]
  });
});
