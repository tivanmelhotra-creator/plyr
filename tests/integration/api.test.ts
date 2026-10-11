import { describe, it, expect, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// NOTE: tests/integration/setup.ts (wired via vitest setupFiles) forces a
// deterministic env BEFORE the middleware modules import src/config.ts:
//   API_TOKEN=test_key_123 (the ONE instance access token; no admin, no accounts)
//
// These integration tests intentionally DO NOT import src/index.ts, because
// index.ts calls startServer() at module load (GlobalBrowser.initialize +
// app.listen) which has heavy side-effects. Instead we mount the real auth
// middleware on a fresh, lightweight Express app.

// Imports are deferred to a beforeAll so the setup file has already run and
// config.ts reads the forced env values.
let app: Express;

beforeAll(async () => {
  const { requireApiKey } = await import('../../src/middleware/auth');

  app = express();
  app.use(express.json());

  // Public health route — no auth.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '40.0.0' });
  });

  // Protected route — requires a valid API key (env key or Redis-backed key).
  app.get('/protected', requireApiKey, (req, res) => {
    res.json({ ok: true, userId: (req as any).apiKeyUserId });
  });

  // Protected route that echoes a body userId (exercises strict user-binding).
  app.post('/run', requireApiKey, (req, res) => {
    res.json({ ok: true, userId: (req as any).apiKeyUserId, body: req.body });
  });

});

describe('health route', () => {
  it('returns 200 and status ok without any auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('requireApiKey — the instance access token', () => {
  it('401 when no API key is provided', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/authentication required/i);
  });

  it('403 when an invalid API key is provided', async () => {
    const res = await request(app).get('/protected').set('x-api-key', 'totally_wrong_key');
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid api token/i);
  });

  it('200 and the owner identity when the instance token is provided', async () => {
    const res = await request(app).get('/protected').set('x-api-key', 'test_key_123');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe('local');
  });

  it('accepts the env key via Bearer Authorization header', async () => {
    const res = await request(app)
      .get('/protected')
      .set('authorization', 'Bearer test_key_123');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('local');
  });

  it('accepts the env key via api_key query param', async () => {
    const res = await request(app).get('/protected?api_key=test_key_123');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('local');
  });

  it('the token is instance-wide: any body userId is the same owner', async () => {
    const res = await request(app)
      .post('/run')
      .set('x-api-key', 'test_key_123')
      .send({ userId: 'someone_else', steps: [] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe('local');
  });
});

describe('no admin surface exists', () => {
  it('the auth module exports no admin middleware and no per-user key manager', async () => {
    const auth = await import('../../src/middleware/auth') as Record<string, unknown>;
    expect(auth.requireAdminApiKey).toBeUndefined();
    expect(auth.getApiKeyManager).toBeUndefined();
    expect(auth.initApiKeyManager).toBeUndefined();
  });
});
