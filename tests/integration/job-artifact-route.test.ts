import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import path from 'path';

// GET /job/:userId/:jobId/artifact/:file - serves the screenshots a run saved.
// The router is the real one; the mocks only remove Redis / queue concerns.

vi.mock('../../src/core/UserManager', () => ({ UserManager: { getUserPlan: vi.fn(async () => ({})) } }));
vi.mock('../../src/validation', () => ({
  sanitizeUserId: (id: unknown) => String(id),
  validateSteps: (s: unknown) => s as unknown[],
  validateWebhookUrl: (u: unknown) => (u ? String(u) : null),
  validateHeadless: () => true,
}));
vi.mock('../../src/services/job.service', () => ({
  readJobFile: vi.fn(async () => null),
  readPartialJobFile: vi.fn(async () => null),
}));

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const tmp = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'), os = require('os'), path = require('path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-route-')) as string;
});

vi.mock('../../src/config', () => ({
  config: {
    PROFILES_DIR: tmp, ARTIFACT_MAX_AGE_HOURS: 168, ARTIFACT_MAX_BYTES: 15 * 1024 * 1024,
    DEFAULT_HEADLESS: true, MAX_QUEUED_JOBS_PER_USER: 50, VIP_PRIORITY_THRESHOLD: 100,
    RUN_WAIT_MAX_MS: 300, RUN_WAIT_POLL_MS: 20, IDEMPOTENCY_TTL_SECONDS: 86400, WORKFLOW_MAX_VERSIONS: 20,
  },
}));

let app: Express;

beforeAll(async () => {
  const { saveArtifact } = await import('../../src/core/JobArtifacts');
  await saveArtifact('alice', '7', 'step-2.png', PNG);
  await fs.mkdir(path.join(tmp, 'alice', 'jobs'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'alice', 'jobs', '7.json'), '{"secret":true}');

  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  app = express();
  app.use('/', createUserRoutes({
    queue: {} as any, connection: {} as any, profileManager: {} as any, quotaManager: {} as any,
  }));
});

afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

describe('GET /job/:userId/:jobId/artifact/:file', () => {
  it('serves the saved image with safe headers', async () => {
    const res = await request(app).get('/job/alice/7/artifact/step-2.png').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toMatch(/^private/);
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('404s for a missing artifact', async () => {
    const res = await request(app).get('/job/alice/7/artifact/step-9.png');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('404s for another user\'s job', async () => {
    expect((await request(app).get('/job/bob/7/artifact/step-2.png')).status).toBe(404);
  });

  it.each([
    '/job/alice/7/artifact/..%2f..%2f7.json',
    '/job/alice/7/artifact/step-2.png%00.html',
    '/job/alice/..%2f7/artifact/step-2.png',
    '/job/alice/7/artifact/step-2.svg',
    '/job/alice/7/artifact/7.json',
  ])('never serves %s', async (url) => {
    const res = await request(app).get(url);
    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
