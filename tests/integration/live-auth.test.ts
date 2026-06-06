import { describe, it, expect } from 'vitest';

// Step 16 — authorizeLive() tests for the Live Channel (WS + SSE).
// setup.ts forces API_KEYS_ENABLED=true and API_KEYS=test_key_123 BEFORE
// config.ts loads, so the env-key path is exercised without Redis.

describe('authorizeLive (env-key path, no Redis required)', () => {
  it('denies when no API key is provided', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive(undefined, '0');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_api_key');
  });

  it('allows the env (admin) key for any userId', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive('test_key_123', 'any_user');
    expect(res.ok).toBe(true);
  });

  it('denies an unknown / invalid key', async () => {
    // initApiKeyManager must exist for the non-env path; the API key manager
    // is initialized lazily in index.ts. When it is not initialized we expect
    // a graceful denial rather than a throw.
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive('totally_wrong_key', '0');
    expect(res.ok).toBe(false);
    // reason is either invalid_api_key (manager present) or auth_unavailable.
    expect(['invalid_api_key', 'auth_unavailable']).toContain(res.reason);
  });
});

// Step 29 — shareable live-view token grants read-only access without an
// API key. setup.ts sets LIVE_SHARE_SECRET=test_live_share_secret.
describe('authorizeLive (Step 29 share token path)', () => {
  const SHARE_SECRET = 'test_live_share_secret';

  it('allows a valid share token for its (userId, jobId) without an API key', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const { buildShareToken } = await import('../../src/core/StepReporter');
    const token = buildShareToken('user-42', 'job-99', SHARE_SECRET, 3600);
    const res = await authorizeLive(undefined, 'user-42', { share: token, jobId: 'job-99' });
    expect(res.ok).toBe(true);
  });

  it('rejects a share token for a different userId (falls through to API-key auth)', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const { buildShareToken } = await import('../../src/core/StepReporter');
    const token = buildShareToken('user-42', 'job-99', SHARE_SECRET, 3600);
    // userId mismatch -> share rejected -> no api key -> missing_api_key.
    const res = await authorizeLive(undefined, 'user-OTHER', { share: token, jobId: 'job-99' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_api_key');
  });

  it('rejects a share token for a different jobId', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const { buildShareToken } = await import('../../src/core/StepReporter');
    const token = buildShareToken('user-42', 'job-99', SHARE_SECRET, 3600);
    const res = await authorizeLive(undefined, 'user-42', { share: token, jobId: 'job-DIFFERENT' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_api_key');
  });

  it('rejects a share token signed with the wrong secret', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const { buildShareToken } = await import('../../src/core/StepReporter');
    const token = buildShareToken('user-42', 'job-99', 'WRONG_SECRET', 3600);
    const res = await authorizeLive(undefined, 'user-42', { share: token, jobId: 'job-99' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_api_key');
  });

  it('still allows the env (admin) API key even with no share token', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive('test_key_123', 'user-42', { jobId: 'job-99' });
    expect(res.ok).toBe(true);
  });

  it('a valid share token wins even when an invalid API key is also present', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const { buildShareToken } = await import('../../src/core/StepReporter');
    const token = buildShareToken('user-42', 'job-99', SHARE_SECRET, 3600);
    const res = await authorizeLive('totally_wrong_key', 'user-42', { share: token, jobId: 'job-99' });
    expect(res.ok).toBe(true);
  });
});
