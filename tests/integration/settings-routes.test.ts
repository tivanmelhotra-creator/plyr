/**
 * settings-routes.test.ts — the Settings page API against the real router and
 * the real requireApiKey middleware (single-user mode). No Redis needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-settings-routes-'));
const file = path.join(dir, 'settings.env');
const BOOT_TOKEN = 'boot_token_abcdefghijklmn';
const ENV_KEYS = ['DEPLOYMENT_MODE', 'APP_ENV', 'NODE_ENV', 'AUTH_MODE', 'API_TOKEN', 'SETTINGS_FILE', 'ALLOW_OPEN_AUTH'];

let app: Express;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, {
    DEPLOYMENT_MODE: 'single', APP_ENV: 'development', AUTH_MODE: 'open',
    API_TOKEN: BOOT_TOKEN, SETTINGS_FILE: file,
  });
  vi.resetModules();
  const { createSettingsRoutes } = await import('../../src/Routes/settings.routes');
  const { requireApiKey } = await import('../../src/middleware/auth');
  app = express();
  app.use(express.json());
  // Let a test choose the peer address, as the socket would report it.
  app.use((req, _res, next) => {
    const peer = req.headers['x-test-peer'];
    if (typeof peer === 'string') Object.defineProperty(req, 'socket', { value: { remoteAddress: peer }, configurable: true });
    next();
  });
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    requireApiKey(req as never, res, next).catch(next);
  };
  app.use('/settings', auth);
  app.get('/me', auth, (_req, res) => { res.json({ ok: true }); });
  const r = createSettingsRoutes();
  app.use('/', r.publicRouter);
  app.use('/', r.router);
});

afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

const LOCAL = { 'x-test-peer': '127.0.0.1' };
const LAN = { 'x-test-peer': '192.168.1.20', 'x-forwarded-for': '127.0.0.1' };

describe('open login (development)', () => {
  it('signs a local browser in and hands it the token', async () => {
    const r = await request(app).get('/auth/mode').set(LOCAL);
    expect(r.body.mode).toBe('open');
    expect(r.body.token).toBe(BOOT_TOKEN);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('still asks a LAN peer for the token, even with a forged X-Forwarded-For', async () => {
    const r = await request(app).get('/auth/mode').set(LAN);
    expect(r.body.mode).toBe('token');
    expect(r.body.token).toBeUndefined();
    expect(r.body.openRefused).toBe('not_local');
    expect((await request(app).get('/settings').set(LAN)).status).toBe(401);
    expect((await request(app).get('/settings').set(LOCAL)).status).toBe(200);
  });
});

describe('GET /settings', () => {
  it('masks secrets and reports where each value came from', async () => {
    const r = await request(app).get('/settings').set(LOCAL);
    const tok = r.body.settings.find((s: { key: string }) => s.key === 'API_TOKEN');
    expect(tok.source).toBe('env');
    expect(JSON.stringify(r.body)).not.toContain(BOOT_TOKEN);
    expect(r.body.openAllowed).toBe(true);
  });
});

describe('PUT /settings', () => {
  it('rejects the whole change set when any value is invalid', async () => {
    const r = await request(app).put('/settings').set(LOCAL).send({ changes: { STEP_TIMEOUT_MS: '60000', MAX_CONCURRENT: '7' } });
    expect(r.status).toBe(400);
    expect(r.body.errors.MAX_CONCURRENT.errorFa).toBeTruthy();
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').not.toContain('STEP_TIMEOUT_MS');
  });

  it('no longer offers the dead "versions kept" limit (manual versions are never trimmed)', async () => {
    const g = await request(app).get('/settings').set(LOCAL);
    expect(g.body.settings.map((x: { key: string }) => x.key)).not.toContain('WORKFLOW_MAX_VERSIONS');
    const r = await request(app).put('/settings').set(LOCAL).send({ changes: { WORKFLOW_MAX_VERSIONS: '20' } });
    expect(r.status).toBe(400);
    expect(r.body.errors.WORKFLOW_MAX_VERSIONS.error).toBe('Unknown setting');
  });

  it('applies and persists valid choices, telling which need a restart', async () => {
    const r = await request(app).put('/settings').set(LOCAL).send({ changes: { STEP_TIMEOUT_MS: '60000', MAX_CONCURRENT: '2' } });
    expect(r.status).toBe(200);
    expect(r.body.restartNeeded).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toMatch(/^STEP_TIMEOUT_MS=60000$/m);
    expect(body).toMatch(/^MAX_CONCURRENT=2$/m);
    const mc = r.body.settings.find((s: { key: string }) => s.key === 'MAX_CONCURRENT');
    expect(mc.value).toBe('2');
    expect(mc.pendingRestart).toBe(true);
    const { config } = await import('../../src/config');
    expect(config.STEP_TIMEOUT_MS).toBe(60000);
  });

  it('refuses to switch to a server profile while the token is admin123', async () => {
    await request(app).put('/settings').set(LOCAL).send({ changes: { API_TOKEN: 'admin123' } }).expect(200);
    const r = await request(app).put('/settings').set(LOCAL).send({ changes: { APP_ENV: 'server' } });
    expect(r.status).toBe(400);
    expect(r.body.errors.APP_ENV).toBeTruthy();
  });

  it('switching to server also turns login back on', async () => {
    const r = await request(app).put('/settings').set(LOCAL)
      .send({ changes: { APP_ENV: 'server', API_TOKEN: 'my_own_token_1234567890' } });
    expect(r.status).toBe(200);
    expect(r.body.newApiToken).toBe('my_own_token_1234567890');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toMatch(/^AUTH_MODE=token$/m);
    expect(body).toMatch(/^APP_ENV=server$/m);
    // In force at once: open login is gone even for this machine.
    expect((await request(app).get('/auth/mode').set(LOCAL)).body.mode).toBe('token');
    // Back to development for the remaining tests.
    await request(app).put('/settings').set({ ...LOCAL, 'x-api-key': 'my_own_token_1234567890' })
      .send({ changes: { APP_ENV: 'development', AUTH_MODE: 'open' } }).expect(200);
  });
});

describe('token generation', () => {
  it('generates a token the server uses at once; the old one stops working', async () => {
    const before = (await request(app).post('/settings/reveal').set(LOCAL).send({ key: 'API_TOKEN' })).body.value;
    const g = await request(app).post('/settings/generate').set(LOCAL).send({ key: 'API_TOKEN' });
    expect(g.status).toBe(200);
    expect(g.body.value).toMatch(/^[0-9a-f]{48}$/);
    expect(g.body.newApiToken).toBe(g.body.value);
    expect((await request(app).get('/me').set({ ...LAN, 'x-api-key': before })).status).toBe(403);
    expect((await request(app).get('/me').set({ ...LAN, 'x-api-key': g.body.value })).status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toContain(`API_TOKEN=${g.body.value}`);
  });

  it('only generates and reveals secrets', async () => {
    expect((await request(app).post('/settings/generate').set(LOCAL).send({ key: 'APP_ENV' })).status).toBe(400);
    expect((await request(app).post('/settings/reveal').set(LOCAL).send({ key: 'APP_ENV' })).status).toBe(400);
  });
});
