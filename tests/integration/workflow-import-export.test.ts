import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// The native workflow file over HTTP, with the REAL validation (so the
// `disabled` flag is proven to survive validateSteps) and the real router.

vi.mock('../../src/core/UserManager', () => ({
  UserManager: { getUserPlan: vi.fn(async () => ({ quota: 0, maxTabs: 2, maxSteps: 100, priority: 3, maxSchedules: 5, runLimit: 0 })) },
}));
vi.mock('../../src/services/job.service', () => ({
  readJobFile: vi.fn(async () => null),
  readPartialJobFile: vi.fn(async () => null),
}));

function makeConnection() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async get(k: string) { return kv.has(k) ? kv.get(k)! : null; },
    async set(k: string, v: string) { kv.set(k, String(v)); return 'OK'; },
    async del(k: string) { return kv.delete(k) || sets.delete(k) ? 1 : 0; },
    async exists(k: string) { return kv.has(k) || sets.has(k) ? 1 : 0; },
    async scard(k: string) { return sets.get(k)?.size ?? 0; },
    async sadd(k: string, v: string) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k)!.add(String(v)); return 1; },
    async srem(k: string, v: string) { return sets.get(k)?.delete(String(v)) ? 1 : 0; },
    async smembers(k: string) { return Array.from(sets.get(k) ?? []); },
    async expire() { return 1; },
  };
}

let app: Express;
beforeAll(async () => {
  const { config } = await import('../../src/config');
  (config as any).WORKFLOW_STORAGE_ROOT = require('node:path').join(require('node:os').tmpdir(), 'wf-import-test');
  (config as any).CODE_NODE_ENABLED = true;
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  app = express();
  app.use(express.json());
  app.use('/', createUserRoutes({
    queue: { async add() { return { id: '1' }; }, async getJob() { return null; }, async getJobs() { return []; }, async getRepeatableJobs() { return []; } } as any,
    connection: makeConnection() as any, profileManager: {} as any,
    quotaManager: { hasQuotaRemaining: async () => true, getUsage: async () => ({ usedSeconds: 0 }) } as any,
  }));
});

const file = (steps: unknown[], extra: any = {}) => ({
  format: 'plyr-workflow', version: 1, workflow: { name: 'Imported', steps, ...extra },
});
const codeStep = (extra: any = {}) => ({ action: 'code', params: { code: 'return 1' }, ...extra });
const goto = { action: 'goto', params: { url: 'https://example.com' } };

describe('POST /workflows/:u/import/preview', () => {
  it('summarises and stores nothing', async () => {
    const res = await request(app).post('/workflows/alice/import/preview').send(file([goto, codeStep()]));
    expect(res.status).toBe(200);
    expect(res.body.summary.nodeCount).toBe(2);
    expect(res.body.summary.codeNodes).toBe(1);
    expect(res.body.codeDisabled).toBe(1);
    expect(res.body.startsInactive).toBe(true);
    const list = await request(app).get('/workflows/alice');
    expect(list.body.count).toBe(0);
  });

  it.each([
    [{ format: 'other', version: 1 }, 'format'],
    [{ format: 'plyr-workflow', version: 7, workflow: { name: 'x', steps: [{ action: 'goto' }] } }, 'version'],
    [{ format: 'plyr-workflow', version: 1, workflow: { name: 'x' } }, 'shape'],
  ])('refuses %j', async (body, code) => {
    const res = await request(app).post('/workflows/alice/import/preview').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  it('refuses a file whose steps fail the real validation', async () => {
    const tooMany = Array.from({ length: 101 }, () => goto); // plan allows 100
    const res = await request(app).post('/workflows/alice/import/preview').send(file(tooMany));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('steps');
  });
});

describe('POST /workflows/:u/import', () => {
  it('saves Code nodes DISABLED (even nested) and the workflow INACTIVE, with no webhook', async () => {
    const steps = [goto, codeStep({ disabled: false }), { action: 'if', condition: { left: 'a', operator: 'equals', right: 'a' }, then: [codeStep()], else: [] }];
    const res = await request(app).post('/workflows/bob/import').send(file(steps, { webhookUrl: 'https://evil.test/hook' }));
    expect(res.status).toBe(201);
    const wf = res.body.workflow;
    expect(wf.active).toBe(false);
    expect(wf.webhookUrl ?? null).toBeNull();
    expect(wf.steps[1].disabled).toBe(true);
    expect(wf.steps[2].then[0].disabled).toBe(true);
    expect(wf.steps[0].disabled).toBeUndefined();
    // and it is what was persisted
    const got = await request(app).get(`/workflows/bob/${wf.id}`);
    expect(got.body.workflow.steps[1].disabled).toBe(true);
  });

  it('an old plyr export still imports (wrapped), also with Code disabled', async () => {
    const res = await request(app).post('/workflows/carol/import').send({ name: 'Old', steps: [codeStep()] });
    expect(res.status).toBe(201);
    expect(res.body.workflow.steps[0].disabled).toBe(true);
  });

  it('the plain create/update path keeps `disabled` (editor autosave must not drop it)', async () => {
    const res = await request(app).post('/workflows/dave').send({ name: 'W', steps: [goto, codeStep({ disabled: true })] });
    expect(res.status).toBe(201);
    const id = res.body.workflow.id;
    const put = await request(app).put(`/workflows/dave/${id}`).send({ name: 'W', steps: [goto, codeStep({ disabled: true })] });
    expect(put.body.workflow.steps[1].disabled).toBe(true);
  });
});

describe('GET /workflows/:u/:id/export?format=native', () => {
  it('returns the native envelope with secrets blanked', async () => {
    const res = await request(app).post('/workflows/erin').send({ name: 'Ex', steps: [goto] });
    const id = res.body.workflow.id;
    const out = await request(app).get(`/workflows/erin/${id}/export?format=native`);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.text);
    expect(body.format).toBe('plyr-workflow');
    expect(body.version).toBe(1);
    expect(body.workflow.steps).toEqual([goto]);
    expect(body.workflow.webhookUrl).toBeUndefined();
  });

  it('without ?format the stored record is returned unchanged (API/CLI users)', async () => {
    const res = await request(app).post('/workflows/frank').send({ name: 'Ex', steps: [goto] });
    const out = await request(app).get(`/workflows/frank/${res.body.workflow.id}/export`);
    expect(JSON.parse(out.text).format).toBeUndefined();
  });
});
