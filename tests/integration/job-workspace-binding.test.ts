import { describe, it, expect, beforeAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';

// A run is bound to a workflow workspace ONLY if the caller owns that workflow.
// The binding (`__workspace`) is what lets the worker file a node's output files
// under <workflow>/downloads/<node>/, so it must never be forgeable from the
// request body: naming someone else's workflow, a missing one, or a malformed id
// has to yield NO workspace (the run still works, outputs stay in the job store).

vi.mock('../../src/core/UserManager', () => ({
  UserManager: { getUserPlan: vi.fn(async () => ({ quota: 0, maxTabs: 2, maxSteps: 100, priority: 3, maxSchedules: 5, runLimit: 0 })) },
}));
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
vi.mock('../../src/config', () => ({
  config: {
    DEFAULT_HEADLESS: true, MAX_QUEUED_JOBS_PER_USER: 50, VIP_PRIORITY_THRESHOLD: 100,
    RUN_WAIT_MAX_MS: 300, RUN_WAIT_POLL_MS: 20, IDEMPOTENCY_TTL_SECONDS: 86400, WORKFLOW_MAX_VERSIONS: 20,
    IS_SINGLE_USER: false,
    WORKFLOW_STORAGE_ROOT: path.join(os.tmpdir(), 'wf-binding-test'),
  },
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
let lastData: any;
const added: any[] = [];

beforeAll(async () => {
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  const queue = {
    async add(_n: string, data: any) { lastData = data; added.push(data); return { id: String(added.length) }; },
    async getJob() { return null },
    async getJobs() { return []; },
    async getRepeatableJobs() { return []; },
  };
  app = express();
  app.use(express.json());
  app.use('/', createUserRoutes({
    queue: queue as any, connection: makeConnection() as any, profileManager: {} as any,
    quotaManager: { hasQuotaRemaining: async () => true, getUsage: async () => ({ usedSeconds: 0 }) } as any,
  }));
});

const steps = [{ action: 'goto', params: { url: 'https://e.com' } }, { action: 'screenshot', params: {} }];

async function saveWorkflow(userId: string): Promise<string> {
  const res = await request(app).post(`/workflows/${userId}`).send({ name: 'Scheduled screenshot', steps });
  expect(res.status).toBeLessThan(300);
  return res.body.workflow?.id ?? res.body.id;
}

describe('workflow workspace binding on a run', () => {
  it('POST /workflows/:u/:id/run always binds the run to that workflow', async () => {
    const id = await saveWorkflow('alice');
    const res = await request(app).post(`/workflows/alice/${id}/run`).send({});
    expect(res.status).toBe(200);
    expect(lastData.__workflowId).toBe(id);
    expect(lastData.__workspace).toEqual({ owner: 'alice', workflowId: id });
  });

  it('POST /run with the caller\'s own workflowId binds it', async () => {
    const id = await saveWorkflow('alice');
    await request(app).post('/run').send({ userId: 'alice', steps, workflowId: id });
    expect(lastData.__workspace).toEqual({ owner: 'alice', workflowId: id });
  });

  it('POST /run with SOMEONE ELSE\'s workflowId binds nothing', async () => {
    const bobs = await saveWorkflow('bob');
    const res = await request(app).post('/run').send({ userId: 'alice', steps, workflowId: bobs });
    expect(res.status).toBe(200); // the run itself is fine
    expect(lastData.__workspace).toBeUndefined();
  });

  it.each(['wf_doesnotexist0001', '../../etc', 'a/b', '', 'x'.repeat(65)])(
    'POST /run with workflowId %j binds nothing', async (bad) => {
      await request(app).post('/run').send({ userId: 'alice', steps, workflowId: bad });
      expect(lastData.__workspace).toBeUndefined();
    });

  it('POST /run without a workflowId (unsaved canvas) binds nothing', async () => {
    await request(app).post('/run').send({ userId: 'alice', steps });
    expect(lastData.__workspace).toBeUndefined();
  });

  it('POST /run-node binds the workspace but still is NOT a workflow execution', async () => {
    const id = await saveWorkflow('alice');
    await request(app).post('/run-node').send({ userId: 'alice', steps, workflowId: id });
    expect(lastData.__runNode).toBe(true);
    expect(lastData.__workspace).toEqual({ owner: 'alice', workflowId: id });
    expect(lastData.__workflowId).toBeUndefined();
  });

  it('POST /run-node with a foreign workflowId binds nothing', async () => {
    const bobs = await saveWorkflow('bob');
    await request(app).post('/run-node').send({ userId: 'alice', steps, workflowId: bobs });
    expect(lastData.__workspace).toBeUndefined();
  });
});
