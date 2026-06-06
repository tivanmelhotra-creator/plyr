import { describe, it, expect } from 'vitest';
import {
  normalizeErrorPolicy,
  shouldRetry,
  retryDelayMs,
  isStopAndError,
  buildErrorTriggerData,
  MAX_RETRY_TRIES,
  MAX_RETRY_WAIT_MS,
  DEFAULT_RETRY_WAIT_MS,
} from '../../src/core/ErrorPolicy';

const step = (over: Record<string, unknown> = {}) => ({ action: 'click', ...over } as any);

describe('normalizeErrorPolicy', () => {
  it('returns safe defaults for a plain step', () => {
    const p = normalizeErrorPolicy(step());
    expect(p.continueOnFail).toBe(false);
    expect(p.retryOnFail).toBe(false);
    expect(p.maxTries).toBe(1);
    expect(p.waitBetweenTriesMs).toBe(DEFAULT_RETRY_WAIT_MS);
  });

  it('accepts boolean true for continueOnFail / retryOnFail', () => {
    const p = normalizeErrorPolicy(step({ continueOnFail: true, retryOnFail: true }));
    expect(p.continueOnFail).toBe(true);
    expect(p.retryOnFail).toBe(true);
  });

  it('accepts string "true" / 1 / "1" forms', () => {
    expect(normalizeErrorPolicy(step({ continueOnFail: 'true' })).continueOnFail).toBe(true);
    expect(normalizeErrorPolicy(step({ continueOnFail: 1 })).continueOnFail).toBe(true);
    expect(normalizeErrorPolicy(step({ continueOnFail: '1' })).continueOnFail).toBe(true);
  });

  it('defaults maxTries to 3 when retryOnFail is on', () => {
    expect(normalizeErrorPolicy(step({ retryOnFail: true })).maxTries).toBe(3);
  });

  it('honors an explicit maxTries when retry is on', () => {
    expect(normalizeErrorPolicy(step({ retryOnFail: true, maxTries: 5 })).maxTries).toBe(5);
  });

  it('forces maxTries to 1 when retry is off (even if a value is given)', () => {
    expect(normalizeErrorPolicy(step({ retryOnFail: false, maxTries: 7 })).maxTries).toBe(1);
  });

  it('clamps maxTries to MAX_RETRY_TRIES', () => {
    expect(normalizeErrorPolicy(step({ retryOnFail: true, maxTries: 999 })).maxTries).toBe(MAX_RETRY_TRIES);
  });

  it('clamps zero/negative maxTries up to 1', () => {
    expect(normalizeErrorPolicy(step({ retryOnFail: true, maxTries: 0 })).maxTries).toBe(1);
    expect(normalizeErrorPolicy(step({ retryOnFail: true, maxTries: -4 })).maxTries).toBe(1);
  });

  it('clamps waitBetweenTriesMs to [0, MAX]', () => {
    expect(normalizeErrorPolicy(step({ waitBetweenTriesMs: -50 })).waitBetweenTriesMs).toBe(0);
    expect(normalizeErrorPolicy(step({ waitBetweenTriesMs: 999999999 })).waitBetweenTriesMs).toBe(MAX_RETRY_WAIT_MS);
  });

  it('tolerates null / garbage input', () => {
    expect(() => normalizeErrorPolicy(null)).not.toThrow();
    expect(() => normalizeErrorPolicy(undefined)).not.toThrow();
    const p = normalizeErrorPolicy(step({ maxTries: 'abc', waitBetweenTriesMs: 'xyz' }));
    expect(p.maxTries).toBe(1);
    expect(p.waitBetweenTriesMs).toBe(DEFAULT_RETRY_WAIT_MS);
  });
});

describe('shouldRetry', () => {
  it('returns true while attempt is below maxTries', () => {
    expect(shouldRetry(1, 3)).toBe(true);
    expect(shouldRetry(2, 3)).toBe(true);
  });

  it('returns false at maxTries', () => {
    expect(shouldRetry(3, 3)).toBe(false);
  });

  it('never retries when maxTries is 1', () => {
    expect(shouldRetry(1, 1)).toBe(false);
  });

  it('is safe with non-finite input', () => {
    expect(shouldRetry(NaN, 3)).toBe(false);
    expect(shouldRetry(1, NaN)).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('grows linearly with attempt', () => {
    expect(retryDelayMs(1, 1000)).toBe(1000);
    expect(retryDelayMs(2, 1000)).toBe(2000);
    expect(retryDelayMs(3, 1000)).toBe(3000);
  });

  it('treats attempt < 1 as 1', () => {
    expect(retryDelayMs(0, 1000)).toBe(1000);
    expect(retryDelayMs(-5, 1000)).toBe(1000);
  });

  it('clamps to MAX_RETRY_WAIT_MS', () => {
    expect(retryDelayMs(9999, 1000)).toBe(MAX_RETRY_WAIT_MS);
  });

  it('handles a zero base', () => {
    expect(retryDelayMs(5, 0)).toBe(0);
  });
});

describe('isStopAndError', () => {
  it('matches all stop-and-error aliases', () => {
    expect(isStopAndError(step({ action: 'stop_and_error' }))).toBe(true);
    expect(isStopAndError(step({ action: 'stop-and-error' }))).toBe(true);
    expect(isStopAndError(step({ action: 'stopAndError' }))).toBe(true);
  });

  it('does not match ordinary actions', () => {
    expect(isStopAndError(step({ action: 'click' }))).toBe(false);
    expect(isStopAndError(null)).toBe(false);
  });
});

describe('buildErrorTriggerData', () => {
  it('extracts message/stack/name from an Error', () => {
    const err = new TypeError('boom');
    const data = buildErrorTriggerData({ error: err, lastNodeExecuted: 'n1', workflowId: 'w1', workflowName: 'WF' });
    expect(data.execution.error.message).toBe('boom');
    expect(data.execution.error.name).toBe('TypeError');
    expect(typeof data.execution.error.stack).toBe('string');
    expect(data.execution.lastNodeExecuted).toBe('n1');
    expect(data.workflow.id).toBe('w1');
    expect(data.workflow.name).toBe('WF');
    expect(data.execution.mode).toBe('trigger');
  });

  it('handles a string error', () => {
    const data = buildErrorTriggerData({ error: 'just a string' });
    expect(data.execution.error.message).toBe('just a string');
  });

  it('falls back to "Unknown error" for null / undefined', () => {
    expect(buildErrorTriggerData({ error: null }).execution.error.message).toBe('Unknown error');
    expect(buildErrorTriggerData({ error: undefined }).execution.error.message).toBe('Unknown error');
  });

  it('reads fields from a non-Error object', () => {
    const data = buildErrorTriggerData({ error: { message: 'objmsg', name: 'CustomError' } });
    expect(data.execution.error.message).toBe('objmsg');
    expect(data.execution.error.name).toBe('CustomError');
  });

  it('honors a custom mode', () => {
    const data = buildErrorTriggerData({ error: new Error('x'), mode: 'manual' });
    expect(data.execution.mode).toBe('manual');
  });
});
