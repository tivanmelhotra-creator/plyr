/**
 * auth-routes.test.ts — /auth/status, /auth/setup, /auth/login,
 * /auth/change-password against the real router + real requireApiKey, in both
 * profiles. The store is a real file in a temp dir so persistence is exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KEYS = ['APP_ENV', 'NODE_ENV', 'API_TOKEN', 'AUTH_FILE', 'ALLOW_OPEN_AUTH'];
const GOOD = 'Correct-Horse-9';
const saved: Record<string, string | undefined> = {};
let dir: string;
let authFile: string;

async function boot(env: 'development' | 'production'): Promise<{ app: Express }> {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { APP_ENV: env, NODE_ENV: 'test', AUTH_FILE: authFile });
  vi.resetModules();
  const { createAuthRoutes, resetAuthLimiterForTests } = await import('../../src/Routes/auth.routes');
  const { requireApiKey } = await import('../../src/middleware/auth');
  resetAuthLimiterForTests();
  const app = express();
  app.use(express.json());
  app.use('/', createAuthRoutes());
  app.get('/me', requireApiKey as never, (_q, r) => { r.json({ success: true }); });
  return { app };
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-auth-routes-'));
  authFile = path.join(dir, 'auth.json');
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe('development: no login, no password, no token', () => {
  it('status is "open" for this machine; setup/login/change answer 409 not_needed', async () => {
    const { app } = await boot('development');
    const st = await request(app).get('/auth/status');
    expect(st.body.mode).toBe('open');
    expect(JSON.stringify(st.body)).not.toMatch(/token/i);
    for (const [p, b] of [['/auth/setup', { password: GOOD }], ['/auth/login', { password: GOOD }]] as const) {
      const r = await request(app).post(p).send(b);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('not_needed');
    }
    expect((await request(app).get('/me')).status).toBe(200);          // no credential at all
    expect(fs.existsSync(authFile) && fs.readFileSync(authFile, 'utf8').includes('scrypt$')).toBe(false);
  });

  it('a request that comes through a proxy is not "open"', async () => {
    const { app } = await boot('development');
    const st = await request(app).get('/auth/status').set('x-forwarded-for', '203.0.113.5');
    expect(st.body.mode).toBe('local_only');
    expect((await request(app).get('/me').set('x-forwarded-for', '203.0.113.5')).status).toBe(401);
  });
});

describe('production: first run, setup page', () => {
  it('status says "setup" and publishes the policy; every protected route says setup_required', async () => {
    const { app } = await boot('production');
    const st = await request(app).get('/auth/status');
    expect(st.body.mode).toBe('setup');
    expect(st.body.policy).toMatchObject({ requireUpper: true, requireLower: true, requireDigit: true });
    expect(st.body.policy.minLength).toBeGreaterThanOrEqual(10);
    expect(st.headers['cache-control']).toBe('no-store');
    const me = await request(app).get('/me');
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('setup_required');
    // login before setup is not a way in
    expect((await request(app).post('/auth/login').send({ password: GOOD })).status).toBe(409);
  });

  it('REJECTS invalid passwords on the server (short / no upper / no lower / no digit / missing)', async () => {
    const { app } = await boot('production');
    for (const bad of ['Ab1', 'alllowercase1x', 'ALLUPPERCASE1X', 'NoDigitsHereAtAll']) {
      const r = await request(app).post('/auth/setup').send({ password: bad });
      expect(r.status, bad).toBe(400);
      expect(r.body.code).toBe('weak_password');
      expect(r.body.problems.length).toBeGreaterThan(0);
      expect(r.body.token).toBeUndefined();
    }
    expect((await request(app).post('/auth/setup').send({})).status).toBe(400);
    expect((await request(app).post('/auth/setup').send({ password: 123456789012 })).status).toBe(400);
    expect((await request(app).get('/auth/status')).body.mode).toBe('setup');   // still not configured
    expect((await request(app).get('/me')).status).toBe(401);
  });

  it('accepts a valid password, returns a session (never the password), lets the owner in', async () => {
    const { app } = await boot('production');
    const r = await request(app).post('/auth/setup').send({ password: GOOD });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^s1\./);
    expect(JSON.stringify(r.body)).not.toContain(GOOD);
    for (const h of [{ 'x-api-key': r.body.token }, { authorization: `Bearer ${r.body.token}` }]) {
      expect((await request(app).get('/me').set(h)).status).toBe(200);
    }
    expect((await request(app).get('/me')).status).toBe(401);
  });

  it('the password itself is NOT a credential for API calls', async () => {
    const { app } = await boot('production');
    await request(app).post('/auth/setup').send({ password: GOOD });
    expect((await request(app).get('/me').set('x-api-key', GOOD)).status).toBe(403);
  });
});

describe('production: later runs', () => {
  it('shows login (never setup) and refuses a second setup; auth config survives a restart', async () => {
    let { app } = await boot('production');
    expect((await request(app).post('/auth/setup').send({ password: GOOD })).status).toBe(200);
    const raw = fs.readFileSync(authFile, 'utf8');
    expect(raw).not.toContain(GOOD);
    if (process.platform !== 'win32') expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);

    ({ app } = await boot('production'));                                // restart: modules reloaded, file re-read
    expect((await request(app).get('/auth/status')).body.mode).toBe('login');
    const again = await request(app).post('/auth/setup').send({ password: 'Attacker-Pass-1' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_set');
    const login = await request(app).post('/auth/login').send({ password: GOOD });
    expect(login.status).toBe(200);
    expect((await request(app).get('/me').set('x-api-key', login.body.token)).status).toBe(200);
  });

  it('wrong password / missing / non-string: 401 invalid_password, no session', async () => {
    const { app } = await boot('production');
    await request(app).post('/auth/setup').send({ password: GOOD });
    for (const body of [{ password: 'Wrong-Pass-1' }, {}, { password: 42 }, { password: '' }]) {
      const r = await request(app).post('/auth/login').send(body);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_password');
      expect(r.body.token).toBeUndefined();
    }
  });

  it('brute force: 429 + Retry-After after repeated failures, and even the right password waits', async () => {
    const { app } = await boot('production');
    await request(app).post('/auth/setup').send({ password: GOOD });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post('/auth/login').send({ password: `Wrong-Pass-${i}` })).status;
    expect(last).toBe(429);
    const r = await request(app).post('/auth/login').send({ password: GOOD });
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a corrupt auth file fails closed: status "unavailable", setup and login refused', async () => {
    fs.writeFileSync(authFile, '{ broken');
    const { app } = await boot('production');
    expect((await request(app).get('/auth/status')).body.mode).toBe('unavailable');
    expect((await request(app).post('/auth/setup').send({ password: GOOD })).status).toBe(503);
    expect((await request(app).post('/auth/login').send({ password: GOOD })).status).toBe(503);
    expect((await request(app).get('/me')).status).toBe(503);
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{ broken');
  });
});

describe('production: change password', () => {
  async function signedIn() {
    const { app } = await boot('production');
    const s = await request(app).post('/auth/setup').send({ password: GOOD });
    return { app, token: s.body.token as string };
  }

  it('requires a session', async () => {
    const { app } = await signedIn();
    const r = await request(app).post('/auth/change-password').send({ current: GOOD, next: 'Brand-New-Pass-5' });
    expect(r.status).toBe(401);
  });

  it('validates the new password server-side and the current one', async () => {
    const { app, token } = await signedIn();
    const post = (b: object) => request(app).post('/auth/change-password').set('x-api-key', token).send(b);
    expect((await post({ current: GOOD, next: 'weak' })).body.code).toBe('weak_password');
    expect((await post({ current: 'Wrong-Pass-1', next: 'Brand-New-Pass-5' })).body.code).toBe('invalid_password');
    expect((await post({ current: GOOD, next: GOOD })).body.code).toBe('same_password');
    expect((await post({ next: 'Brand-New-Pass-5' })).status).toBe(400);
  });

  it('SUCCESS: new password works, old password and old sessions stop, a fresh session is returned, persists', async () => {
    const { app, token } = await signedIn();
    const r = await request(app).post('/auth/change-password').set('x-api-key', token)
      .send({ current: GOOD, next: 'Brand-New-Pass-5' });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^s1\./);
    expect(r.body.token).not.toBe(token);
    expect((await request(app).get('/me').set('x-api-key', token)).status).toBe(403);          // old session dead
    expect((await request(app).get('/me').set('x-api-key', r.body.token)).status).toBe(200);   // new one works
    expect((await request(app).post('/auth/login').send({ password: GOOD })).status).toBe(401);
    expect((await request(app).post('/auth/login').send({ password: 'Brand-New-Pass-5' })).status).toBe(200);
    expect(fs.readFileSync(authFile, 'utf8')).not.toMatch(/Brand-New-Pass-5|Correct-Horse-9/);
    // …and after a restart
    const again = await boot('production');
    expect((await request(again.app).post('/auth/login').send({ password: 'Brand-New-Pass-5' })).status).toBe(200);
  });

  it('in development it is not needed (409)', async () => {
    const { app } = await boot('development');
    const r = await request(app).post('/auth/change-password').send({ current: GOOD, next: 'Brand-New-Pass-5' });
    expect(r.status).toBe(409);
  });
});
