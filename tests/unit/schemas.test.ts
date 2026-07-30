import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import {
  runBodySchema,
  runNodeBodySchema,
  scheduleBodySchema,
  formatZodError,
  parseBody,
} from '../../src/schemas';

// Minimal Express Response stub that records status + json payload.
function makeRes() {
  const rec: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { rec.status = code; return this; },
    json(payload: unknown) { rec.body = payload; return this; },
  } as unknown as Response;
  return { res, rec };
}

const validSteps = [{ action: 'goto', params: { url: 'https://example.com' } }];

describe('runBodySchema', () => {
  it('accepts a valid body (string or number userId)', () => {
    expect(runBodySchema.safeParse({ userId: 'u1', steps: validSteps }).success).toBe(true);
    expect(runBodySchema.safeParse({ userId: 42, steps: validSteps }).success).toBe(true);
  });
  it('accepts optional headless (bool/string/number) and webhookUrl', () => {
    const r = runBodySchema.safeParse({ userId: 'u1', steps: validSteps, headless: 'false', webhookUrl: 'https://h.com/x' });
    expect(r.success).toBe(true);
  });
  it('rejects missing userId', () => {
    const r = runBodySchema.safeParse({ steps: validSteps });
    expect(r.success).toBe(false);
  });
  it('rejects empty / non-array steps', () => {
    expect(runBodySchema.safeParse({ userId: 'u1', steps: [] }).success).toBe(false);
    expect(runBodySchema.safeParse({ userId: 'u1', steps: 'nope' }).success).toBe(false);
  });
  it('rejects an invalid webhookUrl', () => {
    expect(runBodySchema.safeParse({ userId: 'u1', steps: validSteps, webhookUrl: 'not-a-url' }).success).toBe(false);
  });
});

describe('scheduleBodySchema', () => {
  it('accepts a valid 5-field cron', () => {
    const r = scheduleBodySchema.safeParse({ userId: 'u1', steps: validSteps, cron: '*/5 * * * *' });
    expect(r.success).toBe(true);
  });
  it('accepts a 6-field cron', () => {
    const r = scheduleBodySchema.safeParse({ userId: 'u1', steps: validSteps, cron: '0 */5 * * * *' });
    expect(r.success).toBe(true);
  });
  it('rejects empty cron and wrong field counts', () => {
    expect(scheduleBodySchema.safeParse({ userId: 'u1', steps: validSteps, cron: '' }).success).toBe(false);
    expect(scheduleBodySchema.safeParse({ userId: 'u1', steps: validSteps, cron: '* * *' }).success).toBe(false);
    expect(scheduleBodySchema.safeParse({ userId: 'u1', steps: validSteps, cron: '* * * * * * *' }).success).toBe(false);
  });
  it('rejects an over-long name', () => {
    const r = scheduleBodySchema.safeParse({ userId: 'u1', steps: validSteps, cron: '* * * * *', name: 'n'.repeat(121) });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [Item N] POST /run-node — the per-node test-run envelope.
// ---------------------------------------------------------------------------
describe('runNodeBodySchema', () => {
  it('accepts a minimal prefix body', () => {
    const r = runNodeBodySchema.safeParse({ userId: 'u1', steps: validSteps });
    expect(r.success).toBe(true);
  });
  it('accepts nodeIndex 0 (the trigger is a legal node to test)', () => {
    const r = runNodeBodySchema.safeParse({ userId: 'u1', steps: validSteps, nodeIndex: 0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nodeIndex).toBe(0);
  });
  it('requires userId', () => {
    expect(runNodeBodySchema.safeParse({ steps: validSteps }).success).toBe(false);
  });
  it('rejects empty or non-array steps — there is no prefix to run', () => {
    expect(runNodeBodySchema.safeParse({ userId: 'u1', steps: [] }).success).toBe(false);
    expect(runNodeBodySchema.safeParse({ userId: 'u1', steps: 'goto' }).success).toBe(false);
  });
  it('rejects a negative or fractional nodeIndex', () => {
    expect(runNodeBodySchema.safeParse({ userId: 'u1', steps: validSteps, nodeIndex: -1 }).success).toBe(false);
    expect(runNodeBodySchema.safeParse({ userId: 'u1', steps: validSteps, nodeIndex: 1.5 }).success).toBe(false);
  });
  it('carries NO webhookUrl and NO workflowId — a node test must not fire a webhook or be attributed', () => {
    // The schema is non-strict like its siblings, so unknown keys are dropped
    // rather than rejected; what matters is that they never reach the handler.
    const r = runNodeBodySchema.safeParse({
      userId: 'u1', steps: validSteps,
      webhookUrl: 'https://example.com/hook', workflowId: 'wf_1',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('webhookUrl');
      expect(r.data).not.toHaveProperty('workflowId');
    }
  });
  it('accepts triggerData so the prefix can be seeded like a real run', () => {
    const r = runNodeBodySchema.safeParse({
      userId: 'u1', steps: validSteps, triggerData: { source: 'webhook', body: { a: 1 } },
    });
    expect(r.success).toBe(true);
  });
});

describe('formatZodError', () => {
  it('produces a flat error + structured details', () => {
    const r = runBodySchema.safeParse({ steps: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const out = formatZodError(r.error);
      expect(typeof out.error).toBe('string');
      expect(Array.isArray(out.details)).toBe(true);
      expect(out.details.length).toBeGreaterThan(0);
      expect(out.details[0]).toHaveProperty('path');
      expect(out.details[0]).toHaveProperty('message');
    }
  });
});

describe('parseBody', () => {
  it('returns parsed data on success and does not touch res', () => {
    const { res, rec } = makeRes();
    const data = parseBody(runBodySchema, { userId: 'u1', steps: validSteps }, res);
    expect(data).not.toBeNull();
    expect(data?.userId).toBe('u1');
    expect(rec.status).toBeUndefined();
  });
  it('writes a 400 JSON error and returns null on failure', () => {
    const { res, rec } = makeRes();
    const data = parseBody(runBodySchema, { steps: [] }, res);
    expect(data).toBeNull();
    expect(rec.status).toBe(400);
    expect(rec.body).toMatchObject({ success: false });
    expect(rec.body).toHaveProperty('details');
  });
});
