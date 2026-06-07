import { describe, it, expect, vi } from 'vitest';

// ── n8n community node — payload contract test (Step 30) ────────────────────
//
// Asserts that the AutomationBackend node shapes its HTTP requests to match the
// documented backend endpoints — without booting n8n. The genuine
// `n8n-workflow` package (with native isolated-vm deps) is NOT installed in
// CI/sandbox, so we mock just the two error classes the node imports. The
// request-building logic lives in a pure exported function so the contract can
// be verified here, mirroring the real backend routes:
//   - Run Saved Workflow  -> POST /workflows/:userId/:workflowId/run
//   - Run Inline Workflow -> POST /run
//   - Create Schedule     -> POST /schedule
//   - Get Job Result      -> GET  /job/:userId/:jobId
//   - Cancel Job          -> DELETE /cancel/:userId/:jobId
// plus the shared ?wait=true (sync) + Idempotency-Key header contract.

vi.mock('n8n-workflow', () => ({
  NodeOperationError: class NodeOperationError extends Error {},
  NodeApiError: class NodeApiError extends Error {},
}));

import {
  buildRequestOptions,
  parseTriggerData,
  normalizeBase,
} from '../../n8n-node/nodes/AutomationBackend/AutomationBackend.node';

const BASE = 'https://automation.example.com';

describe('normalizeBase', () => {
  it('strips trailing slashes and trims', () => {
    expect(normalizeBase('  https://x.com/  ')).toBe('https://x.com');
    expect(normalizeBase('https://x.com///')).toBe('https://x.com');
    expect(normalizeBase('')).toBe('');
  });
});

describe('parseTriggerData', () => {
  it('returns undefined for empty / blank / {}', () => {
    expect(parseTriggerData(undefined)).toBeUndefined();
    expect(parseTriggerData(null)).toBeUndefined();
    expect(parseTriggerData('')).toBeUndefined();
    expect(parseTriggerData('   ')).toBeUndefined();
    expect(parseTriggerData('{}')).toBeUndefined();
    expect(parseTriggerData({})).toBeUndefined();
  });

  it('parses a JSON string object', () => {
    expect(parseTriggerData('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('passes through an already-parsed object', () => {
    expect(parseTriggerData({ a: 1 })).toEqual({ a: 1 });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTriggerData('{not json')).toThrow(/valid JSON object/);
  });

  it('throws on a non-object (array / scalar)', () => {
    expect(() => parseTriggerData('[1,2,3]')).toThrow(/must be a JSON object/);
    expect(() => parseTriggerData('42')).toThrow(/must be a JSON object/);
  });
});

describe('buildRequestOptions — Run Saved Workflow (Model B)', () => {
  it('POSTs to /workflows/:userId/:workflowId/run', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'runSaved',
      userId: 'local',
      workflowId: 'wf_abc123',
    });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/workflows/local/wf_abc123/run`);
    // No overrides -> empty body (backend uses stored headless/webhookUrl).
    expect(r.body).toEqual({});
    expect(r.qs).toEqual({});
    expect(r.headers).toEqual({});
  });

  it('url-encodes userId and workflowId', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'runSaved',
      userId: 'a b',
      workflowId: 'wf/x',
    });
    expect(r.url).toBe(`${BASE}/workflows/a%20b/wf%2Fx/run`);
  });

  it('injects triggerData + headless override into the body', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'runSaved',
      userId: 'local',
      workflowId: 'wf_abc123',
      headless: false,
      triggerData: { searchTerm: 'laptop' },
    });
    expect(r.body).toEqual({ headless: false, triggerData: { searchTerm: 'laptop' } });
  });

  it('honours ?wait=true and Idempotency-Key (same contract as /run)', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'runSaved',
      userId: 'local',
      workflowId: 'wf_abc123',
      wait: true,
      idempotencyKey: 'run-2026-06-06',
    });
    expect(r.qs.wait).toBe('true');
    expect(r.headers['Idempotency-Key']).toBe('run-2026-06-06');
  });

  it('adds webhookUrl override only when provided', () => {
    const withUrl = buildRequestOptions(BASE, {
      operation: 'runSaved', userId: 'local', workflowId: 'wf_1', webhookUrl: 'https://n8n/wh',
    });
    expect(withUrl.body).toEqual({ webhookUrl: 'https://n8n/wh' });

    const withoutUrl = buildRequestOptions(BASE, {
      operation: 'runSaved', userId: 'local', workflowId: 'wf_1', webhookUrl: '',
    });
    expect(withoutUrl.body).toEqual({});
  });
});

describe('buildRequestOptions — Run Inline Workflow', () => {
  const steps = [{ action: 'goto', params: { url: 'https://e.com' } }];

  it('POSTs steps to /run with headless default true', () => {
    const r = buildRequestOptions(BASE, { operation: 'run', userId: 'u1', steps });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/run`);
    expect(r.body).toEqual({ userId: 'u1', steps, headless: true });
  });

  it('honours wait + idempotency + webhookUrl', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'run', userId: 'u1', steps, headless: false,
      wait: true, idempotencyKey: 'k1', webhookUrl: 'https://n8n/wh',
    });
    expect(r.body).toEqual({ userId: 'u1', steps, headless: false, webhookUrl: 'https://n8n/wh' });
    expect(r.qs.wait).toBe('true');
    expect(r.headers['Idempotency-Key']).toBe('k1');
  });
});

describe('buildRequestOptions — Create Schedule', () => {
  const steps = [{ action: 'goto', params: { url: 'https://e.com' } }];

  it('POSTs steps + cron to /schedule', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'schedule', userId: 'u1', steps, headless: true,
      cron: '0 9 * * *', scheduleName: 'Daily',
    });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/schedule`);
    expect(r.body).toEqual({ userId: 'u1', steps, headless: true, cron: '0 9 * * *', name: 'Daily' });
  });

  it('omits name when blank', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'schedule', userId: 'u1', steps, headless: true, cron: '* * * * *',
    });
    expect((r.body as Record<string, unknown>).name).toBeUndefined();
  });
});

describe('buildRequestOptions — Get Job / Cancel', () => {
  it('GETs /job/:userId/:jobId', () => {
    const r = buildRequestOptions(BASE, { operation: 'getJob', userId: 'u1', jobId: 'j7' });
    expect(r.method).toBe('GET');
    expect(r.url).toBe(`${BASE}/job/u1/j7`);
    expect(r.body).toBeUndefined();
  });

  it('DELETEs /cancel/:userId/:jobId with close flags as query', () => {
    const r = buildRequestOptions(BASE, {
      operation: 'cancel', userId: 'u1', jobId: 'j7', closeBrowser: true, closeTab: true,
    });
    expect(r.method).toBe('DELETE');
    expect(r.url).toBe(`${BASE}/cancel/u1/j7`);
    expect(r.qs).toEqual({ closeBrowser: 'true', closeTab: 'true' });
  });

  it('omits close flags when false', () => {
    const r = buildRequestOptions(BASE, { operation: 'cancel', userId: 'u1', jobId: 'j7' });
    expect(r.qs).toEqual({});
  });
});

describe('buildRequestOptions — unknown operation', () => {
  it('throws', () => {
    expect(() => buildRequestOptions(BASE, { operation: 'bogus', userId: 'u1' })).toThrow(/Unknown operation/);
  });
});
