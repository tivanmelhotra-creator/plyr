import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// Step 31 — verify the extension's shared, pure core module
// (extension/lib/ab-core.js → window.ABCore) builds the right backend URLs,
// parses the workflow list / GET /me response, and maps live events to
// per-step status deltas. This is the "Model A" glue that the popup and the
// background service worker both consume, so we lock its contract here.
//
// We load it through the same `vm` + fake-`window` sandbox pattern used by
// extension-selector.test.ts (no jsdom dependency, no chrome/DOM access).

interface ABCoreApi {
  normalizeBase: (url: unknown) => string;
  buildRunSavedUrl: (base: string, userId: string, wfId: string, opts?: { wait?: boolean }) => string;
  buildRunInlineUrl: (base: string, opts?: { wait?: boolean }) => string;
  buildSseUrl: (base: string, userId: string, jobId: string, apiKey?: string) => string;
  buildPanelUrl: (base: string) => string;
  parseWorkflowList: (resp: unknown) => Array<{ id: string; name: string; version: number | null; description: string; stepCount: number | null }>;
  resolveUserId: (me: unknown, fallback?: string) => string;
  mapLiveEventToStatus: (ev: unknown) => Record<string, unknown> | null;
  isTerminalEvent: (ev: unknown) => boolean;
  stepLabel: (s: unknown) => string;
  extractJobId: (data: unknown) => string | null;
}

let ABCore: ABCoreApi;

beforeAll(() => {
  const code = readFileSync(resolve(__dirname, '../../extension/lib/ab-core.js'), 'utf8');
  const sandbox: Record<string, unknown> = { window: {} as Record<string, unknown> };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  ABCore = (sandbox.window as Record<string, unknown>).ABCore as ABCoreApi;
});

describe('ABCore.normalizeBase', () => {
  it('adds http:// when scheme is missing', () => {
    expect(ABCore.normalizeBase('localhost:3000')).toBe('http://localhost:3000');
  });
  it('keeps https:// and strips trailing slashes', () => {
    expect(ABCore.normalizeBase('https://api.example.com/')).toBe('https://api.example.com');
    expect(ABCore.normalizeBase('https://api.example.com///')).toBe('https://api.example.com');
  });
  it('trims whitespace and handles empty/null', () => {
    expect(ABCore.normalizeBase('  http://x  ')).toBe('http://x');
    expect(ABCore.normalizeBase('')).toBe('');
    expect(ABCore.normalizeBase(null)).toBe('');
    expect(ABCore.normalizeBase(undefined)).toBe('');
  });
});

describe('ABCore URL builders', () => {
  it('buildRunSavedUrl builds /workflows/:userId/:workflowId/run', () => {
    expect(ABCore.buildRunSavedUrl('http://localhost:3000', 'local', 'wf_1'))
      .toBe('http://localhost:3000/workflows/local/wf_1/run');
  });
  it('buildRunSavedUrl appends ?wait=true when opts.wait', () => {
    expect(ABCore.buildRunSavedUrl('localhost:3000', 'local', 'wf_1', { wait: true }))
      .toBe('http://localhost:3000/workflows/local/wf_1/run?wait=true');
  });
  it('buildRunSavedUrl url-encodes ids', () => {
    expect(ABCore.buildRunSavedUrl('http://h', 'a/b', 'c d'))
      .toBe('http://h/workflows/a%2Fb/c%20d/run');
  });
  it('buildRunInlineUrl builds /run (+?wait)', () => {
    expect(ABCore.buildRunInlineUrl('http://h')).toBe('http://h/run');
    expect(ABCore.buildRunInlineUrl('http://h', { wait: true })).toBe('http://h/run?wait=true');
  });
  it('buildSseUrl builds /live/sse/:userId/:jobId with api_key query', () => {
    expect(ABCore.buildSseUrl('http://h', 'local', 'job7', 'secret'))
      .toBe('http://h/live/sse/local/job7?api_key=secret');
  });
  it('buildSseUrl omits api_key when not provided', () => {
    expect(ABCore.buildSseUrl('http://h', 'local', 'job7'))
      .toBe('http://h/live/sse/local/job7');
  });
  it('buildSseUrl url-encodes the api key', () => {
    expect(ABCore.buildSseUrl('http://h', 'u', 'j', 'a b&c'))
      .toBe('http://h/live/sse/u/j?api_key=a%20b%26c');
  });
  it('buildPanelUrl returns base + /', () => {
    expect(ABCore.buildPanelUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(ABCore.buildPanelUrl('localhost:3000')).toBe('http://localhost:3000/');
  });
});

describe('ABCore.parseWorkflowList', () => {
  it('parses { workflows: [...] }', () => {
    const out = ABCore.parseWorkflowList({
      workflows: [
        { id: 'a', name: 'Alpha', version: 3, description: 'd', steps: [{}, {}] },
      ],
    });
    expect(out).toEqual([
      { id: 'a', name: 'Alpha', version: 3, description: 'd', stepCount: 2 },
    ]);
  });
  it('parses a bare array', () => {
    const out = ABCore.parseWorkflowList([{ id: 'b' }]);
    expect(out).toEqual([
      { id: 'b', name: 'b', version: null, description: '', stepCount: null },
    ]);
  });
  it('falls back name→id and tolerates missing fields', () => {
    const out = ABCore.parseWorkflowList([{ id: 'c', steps: [{}] }]);
    expect(out[0].name).toBe('c');
    expect(out[0].version).toBeNull();
    expect(out[0].stepCount).toBe(1);
  });
  it('skips entries without a string id', () => {
    const out = ABCore.parseWorkflowList([{ name: 'no-id' }, null, { id: 5 }, { id: 'ok' }]);
    expect(out.map((w) => w.id)).toEqual(['ok']);
  });
  it('returns [] for junk input', () => {
    expect(ABCore.parseWorkflowList(null)).toEqual([]);
    expect(ABCore.parseWorkflowList({})).toEqual([]);
    expect(ABCore.parseWorkflowList(42)).toEqual([]);
  });
});

describe('ABCore.resolveUserId', () => {
  it('prefers meResponse.userId', () => {
    expect(ABCore.resolveUserId({ userId: 'local' }, 'typed')).toBe('local');
  });
  it('uses fallback when me has no userId', () => {
    expect(ABCore.resolveUserId({}, 'typed')).toBe('typed');
    expect(ABCore.resolveUserId(null, '  typed  ')).toBe('typed');
  });
  it('defaults to "local" when nothing is available', () => {
    expect(ABCore.resolveUserId(null, '')).toBe('local');
    expect(ABCore.resolveUserId(null)).toBe('local');
  });
});

describe('ABCore.mapLiveEventToStatus', () => {
  it('maps job.start/done/error', () => {
    expect(ABCore.mapLiveEventToStatus({ type: 'job.start' }))
      .toEqual({ kind: 'job', state: 'running' });
    expect(ABCore.mapLiveEventToStatus({ type: 'job.done', data: { durationMs: 120 } }))
      .toEqual({ kind: 'job', state: 'done', durationMs: 120 });
    expect(ABCore.mapLiveEventToStatus({ type: 'job.error', data: { message: 'boom' } }))
      .toEqual({ kind: 'job', state: 'error', message: 'boom' });
  });
  it('maps step.start', () => {
    expect(ABCore.mapLiveEventToStatus({ type: 'step.start', data: { index: 2, action: 'click' } }))
      .toEqual({ kind: 'step', index: 2, action: 'click', state: 'running' });
  });
  it('maps step.done success and failure', () => {
    expect(ABCore.mapLiveEventToStatus({ type: 'step.done', data: { index: 1, action: 'goto', success: true, durationMs: 50, outputItemCount: 1 } }))
      .toEqual({ kind: 'step', index: 1, action: 'goto', state: 'success', durationMs: 50, outputItemCount: 1, error: '' });
    expect(ABCore.mapLiveEventToStatus({ type: 'step.done', data: { index: 1, action: 'goto', success: false, error: 'nope' } }))
      .toMatchObject({ kind: 'step', index: 1, state: 'error', error: 'nope' });
  });
  it('maps step.error and step.retry', () => {
    expect(ABCore.mapLiveEventToStatus({ type: 'step.error', data: { index: 3, action: 'fill', error: 'x' } }))
      .toEqual({ kind: 'step', index: 3, action: 'fill', state: 'error', error: 'x' });
    expect(ABCore.mapLiveEventToStatus({ type: 'step.retry', data: { index: 3, action: 'fill', attempt: 2, maxTries: 3 } }))
      .toEqual({ kind: 'step', index: 3, action: 'fill', state: 'retry', attempt: 2, maxTries: 3 });
  });
  it('supports flat events (no data wrapper)', () => {
    expect(ABCore.mapLiveEventToStatus({ type: 'step.start', index: 0, action: 'goto' }))
      .toEqual({ kind: 'step', index: 0, action: 'goto', state: 'running' });
  });
  it('returns null for logs / unknown / junk', () => {
    expect(ABCore.mapLiveEventToStatus({ type: 'log', data: { line: 'hi' } })).toBeNull();
    expect(ABCore.mapLiveEventToStatus({ type: 'mystery' })).toBeNull();
    expect(ABCore.mapLiveEventToStatus(null)).toBeNull();
    expect(ABCore.mapLiveEventToStatus({})).toBeNull();
  });
});

describe('ABCore.isTerminalEvent', () => {
  it('true for job.done / job.error only', () => {
    expect(ABCore.isTerminalEvent({ type: 'job.done' })).toBe(true);
    expect(ABCore.isTerminalEvent({ type: 'job.error' })).toBe(true);
    expect(ABCore.isTerminalEvent({ type: 'job.start' })).toBe(false);
    expect(ABCore.isTerminalEvent({ type: 'step.done' })).toBe(false);
    expect(ABCore.isTerminalEvent(null)).toBe(false);
  });
});

describe('ABCore.stepLabel', () => {
  it('labels each known action', () => {
    expect(ABCore.stepLabel({ action: 'goto', params: { url: 'http://x' } })).toBe('goto http://x');
    expect(ABCore.stepLabel({ action: 'click', params: { selector: '#go' } })).toBe('click #go');
    expect(ABCore.stepLabel({ action: 'fill', params: { selector: '#q', text: 'hi' } })).toBe('fill #q = hi');
    expect(ABCore.stepLabel({ action: 'press', params: { text: 'Enter' } })).toBe('press Enter');
    expect(ABCore.stepLabel({ action: 'extract', params: { selector: '.p', name: 'price' } })).toBe('extract .p -> price');
  });
  it('extract defaults name to "value"', () => {
    expect(ABCore.stepLabel({ action: 'extract', params: { selector: '.p' } })).toBe('extract .p -> value');
  });
  it('falls back to action + JSON for unknown actions', () => {
    expect(ABCore.stepLabel({ action: 'wait', params: { ms: 100 } })).toBe('wait {"ms":100}');
  });
  it('returns empty string for junk', () => {
    expect(ABCore.stepLabel(null)).toBe('');
    expect(ABCore.stepLabel({})).toBe('');
  });
});

describe('ABCore.extractJobId', () => {
  it('reads jobId / id / job.id, tolerant of shapes', () => {
    expect(ABCore.extractJobId({ jobId: 'j1' })).toBe('j1');
    expect(ABCore.extractJobId({ id: 'j2' })).toBe('j2');
    expect(ABCore.extractJobId({ job: { id: 'j3' } })).toBe('j3');
    expect(ABCore.extractJobId({ jobId: 7 })).toBe('7');
  });
  it('returns null when nothing matches', () => {
    expect(ABCore.extractJobId({})).toBeNull();
    expect(ABCore.extractJobId(null)).toBeNull();
  });
});
