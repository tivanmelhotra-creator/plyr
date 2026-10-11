/**
 * executions-view.test.ts — the Executions view's pure model (no DOM).
 *
 * The view renders ONE normalised run model whatever the source (live stream
 * or stored job file). These tests pin the rules that keep it honest:
 *   - statuses come from the server, refined only by the steps themselves
 *     (a `completed` run with a failed step is `partial`, never `success`);
 *   - skipped steps (event triggers in a manual run, `{ skipped: true }`) are
 *     counted as skipped, not as successes;
 *   - log lines are categorised by the worker's `[TAG]` prefix;
 *   - every `xv.*` key the module uses exists in the dictionary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'public', 'js', 'executions-view.js'), 'utf8');
const I18N = readFileSync(join(ROOT, 'public', 'js', 'i18n.js'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

function load(): any {
  const sandbox: any = { window: {}, console };
  vm.runInNewContext(SRC, sandbox);
  return sandbox.window.ExecutionsView;
}

describe('ExecutionsView model', () => {
  const XV = load();

  it('exposes mount/unmount/refresh/onRunUpdate', () => {
    ['mount', 'unmount', 'refresh', 'onRunUpdate'].forEach((k) => expect(typeof XV[k]).toBe('function'));
  });

  it('normalises a stored successful run, counting skipped steps separately', () => {
    const run = XV.normalizeStored(
      { jobId: '7', state: 'completed', trigger: 'manual', startedAt: '2026-10-11T10:00:00Z', durationMs: 2100 },
      {
        state: 'completed',
        stepOutputs: [
          { step: 1, action: 'trigger_manual', success: true, durationMs: 2, timestamp: '2026-10-11T10:00:00.1Z' },
          { step: 2, action: 'navigate', success: true, durationMs: 50, timestamp: '2026-10-11T10:00:00.2Z' },
          { step: 3, action: 'trigger_webhook', success: true, durationMs: 1, timestamp: '2026-10-11T10:00:00.3Z' },
          { step: 4, action: 'attribute', success: true, result: { skipped: true }, timestamp: '2026-10-11T10:00:00.4Z' },
        ],
        runLog: [{ t: '2026-10-11T10:00:00Z', level: 'info', text: '[BROWSER] Launching profile' }],
        variables: { a: '1' },
        runMeta: { visibility: 'hidden', profile: 'Default' },
      },
    );
    expect(run.status).toBe('success');
    expect(XV.stepCounts(run.steps)).toMatchObject({ total: 4, success: 2, skipped: 2, error: 0 });
    expect(run.variables).toEqual({ a: '1' });
    expect(run.logs[0].source).toBe('browser');
    expect(run.logs[0].text).toBe('Launching profile');
    expect(run.logs.length).toBe(1 + 4);
  });

  it('a completed run with a failed step is partial, not success', () => {
    const run = XV.normalizeStored(
      { jobId: '8', state: 'completed' },
      { state: 'completed', stepOutputs: [
        { step: 1, action: 'click', success: false, error: 'boom' },
        { step: 2, action: 'delay', success: true },
      ] },
    );
    expect(run.status).toBe('partial');
  });

  it('a cancelled run reads as stopped and drops the CANCELLED_BY_USER marker', () => {
    const run = XV.normalizeStored(
      { jobId: '9', state: 'completed' },
      { state: 'completed', cancelledByUser: true, success: false, message: 'CANCELLED_BY_USER', stepOutputs: [] },
    );
    expect(run.status).toBe('stopped');
    expect(run.error).toBeNull();
  });

  it('normalises a live snapshot back into step order', () => {
    const run = XV.normalizeLive({
      phase: 'running', jobId: '10', startedAt: Date.now() - 1000,
      order: [3, 1, 2],
      steps: {
        1: { action: 'goto', status: 'success', durationMs: 5 },
        2: { action: 'click', status: 'error', error: 'nope' },
        3: { action: 'delay', status: 'running' },
      },
      log: [{ t: Date.now(), type: 'job.start', text: 'job started' }],
      variables: {},
    }, null);
    expect(run.live).toBe(true);
    expect(run.status).toBe('running');
    expect(run.steps.map((s: any) => s.n)).toEqual([1, 2, 3]);
    expect(run.variables).toBeNull();
  });

  it('categorises log lines by their [TAG] prefix and level by wording', () => {
    expect(XV.logSource('[HTTP] retrying')).toBe('network');
    expect(XV.logSource('[USER] hello')).toBe('user');
    expect(XV.logSource('[BROWSER] x')).toBe('browser');
    expect(XV.logSource('Started (manual run)')).toBe('system');
    expect(XV.logLevel('Failed: timeout')).toBe('error');
    expect(XV.logLevel('retrying (1/3)')).toBe('warn');
    expect(XV.logLevel('Completed')).toBe('info');
  });

  it('formats durations compactly', () => {
    expect(XV.fmtDuration(850)).toBe('850ms');
    expect(XV.fmtDuration(4200)).toBe('4.2s');
    expect(XV.fmtDuration(12000)).toBe('12s');
    expect(XV.fmtDuration(134000)).toBe('2m 14s');
    expect(XV.fmtDuration(null)).toBe('—');
  });

  it('types variable values for the Variables tab', () => {
    expect(XV.valueType('12400')).toBe('number');
    expect(XV.valueType('https://a.b')).toBe('url');
    expect(XV.valueType('[1,2]')).toBe('array');
    expect(XV.valueType('\u2022\u2022\u2022\u2022')).toBe('secret');
    expect(XV.valueType('true')).toBe('boolean');
    expect(XV.valueType('hello')).toBe('string');
  });
});

describe('ExecutionsView wiring', () => {
  it('every literal xv.* key exists in the dictionary', () => {
    const keys = new Set((SRC.match(/'xv\.[A-Za-z.]+[A-Za-z]'/g) || []).map((k) => k.slice(1, -1)));
    expect([...keys].filter((k) => !I18N.includes(`'${k}':`))).toEqual([]);
  });

  it('dynamic xv.lv / xv.src / xv.type keys exist', () => {
    const dyn = [
      ...['all', 'info', 'success', 'warn', 'error'].map((x) => 'xv.lv.' + x),
      ...['system', 'step', 'browser', 'network', 'user'].map((x) => 'xv.src.' + x),
      ...['string', 'number', 'boolean', 'array', 'object', 'url', 'secret', 'null', 'unset'].map((x) => 'xv.type.' + x),
    ];
    expect(dyn.filter((k) => !I18N.includes(`'${k}':`))).toEqual([]);
  });

  it('is loaded after run-panel.js and before views.js', () => {
    const rp = INDEX.indexOf('/js/run-panel.js');
    const xv = INDEX.indexOf('/js/executions-view.js');
    const vw = INDEX.indexOf('/js/views.js');
    expect(xv).toBeGreaterThan(rp);
    expect(vw).toBeGreaterThan(xv);
  });
});
