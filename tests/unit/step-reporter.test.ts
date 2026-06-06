import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  isStepEventType,
  buildStepWebhookPayload,
  shouldDeliverStepEvent,
  buildShareToken,
  verifyShareToken,
  STEP_EVENT_TYPES,
  DEFAULT_SHARE_TTL_SEC,
  MAX_SHARE_TTL_SEC,
} from '../../src/core/StepReporter';

const SECRET = 'top-secret-key';

describe('isStepEventType', () => {
  it('accepts the 4 per-step events', () => {
    for (const t of STEP_EVENT_TYPES) {
      expect(isStepEventType(t)).toBe(true);
    }
  });
  it('rejects job/log events and junk', () => {
    expect(isStepEventType('job.start')).toBe(false);
    expect(isStepEventType('job.done')).toBe(false);
    expect(isStepEventType('log')).toBe(false);
    expect(isStepEventType(undefined)).toBe(false);
    expect(isStepEventType('')).toBe(false);
    expect(isStepEventType('step.unknown')).toBe(false);
  });
});

describe('shouldDeliverStepEvent', () => {
  it('delivers all step events when no allow-list', () => {
    expect(shouldDeliverStepEvent('step.done')).toBe(true);
    expect(shouldDeliverStepEvent('step.error', [])).toBe(true);
    expect(shouldDeliverStepEvent('step.start', null)).toBe(true);
  });
  it('honors an allow-list', () => {
    expect(shouldDeliverStepEvent('step.done', ['step.done'])).toBe(true);
    expect(shouldDeliverStepEvent('step.start', ['step.done'])).toBe(false);
  });
  it('never delivers non-step events regardless of list', () => {
    expect(shouldDeliverStepEvent('job.done')).toBe(false);
    expect(shouldDeliverStepEvent('job.done', ['job.done'])).toBe(false);
    expect(shouldDeliverStepEvent('log', [])).toBe(false);
  });
});

describe('buildStepWebhookPayload', () => {
  const ts = '2026-06-06T00:00:00.000Z';

  it('returns null for non-step events', () => {
    expect(buildStepWebhookPayload({ type: 'job.start', jobId: 'j1', userId: 'u1' })).toBeNull();
    expect(buildStepWebhookPayload({ type: 'log', jobId: 'j1', userId: 'u1' })).toBeNull();
  });

  it('builds a flat step.start payload', () => {
    const p = buildStepWebhookPayload({
      type: 'step.start',
      jobId: 'j1',
      userId: 'u1',
      data: { index: 1, action: 'goto' },
      timestamp: ts,
    });
    expect(p).not.toBeNull();
    expect(p!.event).toBe('step.start');
    expect(p!.jobId).toBe('j1');
    expect(p!.userId).toBe('u1');
    expect(p!.index).toBe(1);
    expect(p!.action).toBe('goto');
    expect(p!.timestamp).toBe(ts);
    // start has no success/duration
    expect(p!.success).toBeUndefined();
    expect(p!.durationMs).toBeUndefined();
  });

  it('builds a rich step.done payload with item-flow summary', () => {
    const p = buildStepWebhookPayload({
      type: 'step.done',
      jobId: 'j2',
      userId: 'u2',
      data: {
        index: 3,
        action: 'extract',
        success: true,
        durationMs: 42,
        inputItemCount: 1,
        outputItemCount: 5,
        outputSample: [{ json: { a: 1 } }],
        outputTruncated: true,
      },
      timestamp: ts,
    });
    expect(p!.event).toBe('step.done');
    expect(p!.success).toBe(true);
    expect(p!.durationMs).toBe(42);
    expect(p!.inputItemCount).toBe(1);
    expect(p!.outputItemCount).toBe(5);
    expect(p!.outputSample).toEqual([{ json: { a: 1 } }]);
    expect(p!.outputTruncated).toBe(true);
  });

  it('builds a step.error payload with error string', () => {
    const p = buildStepWebhookPayload({
      type: 'step.error',
      jobId: 'j3',
      userId: 'u3',
      data: { index: 2, action: 'click', error: 'element not found' },
      timestamp: ts,
    });
    expect(p!.event).toBe('step.error');
    expect(p!.error).toBe('element not found');
    expect(p!.success).toBeUndefined();
  });

  it('builds a step.retry payload with attempt/maxTries', () => {
    const p = buildStepWebhookPayload({
      type: 'step.retry',
      jobId: 'j4',
      userId: 'u4',
      data: { index: 2, action: 'click', attempt: 2, maxTries: 3, error: 'timeout' },
      timestamp: ts,
    });
    expect(p!.event).toBe('step.retry');
    expect(p!.attempt).toBe(2);
    expect(p!.maxTries).toBe(3);
    expect(p!.error).toBe('timeout');
  });

  it('defaults action to null and index to 0 on missing data', () => {
    const p = buildStepWebhookPayload({ type: 'step.start', jobId: 'j', userId: 'u' });
    expect(p!.action).toBeNull();
    expect(p!.index).toBe(0);
    expect(typeof p!.timestamp).toBe('string');
  });
});

describe('buildShareToken / verifyShareToken', () => {
  it('round-trips a token and recovers userId/jobId', () => {
    const tok = buildShareToken('user-1', 'job-abc', SECRET, 3600, 1000);
    const v = verifyShareToken(tok, SECRET, 1500);
    expect(v.ok).toBe(true);
    expect(v.parts!.userId).toBe('user-1');
    expect(v.parts!.jobId).toBe('job-abc');
    expect(v.parts!.exp).toBe(1000 + 3600);
  });

  it('handles ids containing dots and special chars (base64url)', () => {
    const tok = buildShareToken('u.s.e.r', 'job.with.dots', SECRET, 0, 0);
    const v = verifyShareToken(tok, SECRET, 999999);
    expect(v.ok).toBe(true);
    expect(v.parts!.userId).toBe('u.s.e.r');
    expect(v.parts!.jobId).toBe('job.with.dots');
    expect(v.parts!.exp).toBe(0); // never expires
  });

  it('rejects a token signed with a different secret', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 3600, 1000);
    const v = verifyShareToken(tok, 'other-secret', 1500);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('bad_signature');
  });

  it('rejects a tampered jobId (signature mismatch)', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 3600, 1000);
    const segs = tok.split('.');
    // swap the encoded jobId for a different one (re-encode 'j2')
    const fakeJob = Buffer.from('j2', 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    segs[1] = fakeJob;
    const v = verifyShareToken(segs.join('.'), SECRET, 1500);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 3600, 1000);
    const v = verifyShareToken(tok, SECRET, 1000 + 3600); // now == exp
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('expired');
  });

  it('accepts a token at one second before expiry', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 3600, 1000);
    const v = verifyShareToken(tok, SECRET, 1000 + 3599);
    expect(v.ok).toBe(true);
  });

  it('never-expiring token (ttl=0) stays valid far in the future', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 0, 1000);
    const v = verifyShareToken(tok, SECRET, 10_000_000_000);
    expect(v.ok).toBe(true);
  });

  it('reports malformed for junk / wrong segment count', () => {
    expect(verifyShareToken('', SECRET).reason).toBe('malformed');
    expect(verifyShareToken('a.b.c', SECRET).reason).toBe('malformed');
    expect(verifyShareToken('a.b.c.d.e', SECRET).reason).toBe('malformed');
    expect(verifyShareToken(undefined, SECRET).reason).toBe('malformed');
  });

  it('reports malformed when exp segment is not numeric', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 3600, 1000);
    const segs = tok.split('.');
    segs[2] = 'NaN';
    expect(verifyShareToken(segs.join('.'), SECRET).reason).toBe('malformed');
  });

  it('requires a secret to verify', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, 3600, 1000);
    expect(verifyShareToken(tok, '').reason).toBe('malformed');
  });

  it('clamps ttl above MAX_SHARE_TTL_SEC', () => {
    const tok = buildShareToken('u1', 'j1', SECRET, MAX_SHARE_TTL_SEC + 999999, 1000);
    const v = verifyShareToken(tok, SECRET, 1500);
    expect(v.ok).toBe(true);
    expect(v.parts!.exp).toBe(1000 + MAX_SHARE_TTL_SEC);
  });

  it('throws when minting without a secret', () => {
    expect(() => buildShareToken('u1', 'j1', '')).toThrow();
  });

  it('exposes a sane default TTL', () => {
    expect(DEFAULT_SHARE_TTL_SEC).toBe(24 * 60 * 60);
  });
});
