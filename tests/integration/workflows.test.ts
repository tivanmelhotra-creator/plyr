import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Workflow Storage (Step 17, G2) route test ─────────────────────────────
// Exercises the real /workflows CRUD + re-run handlers wired into the user
// router. WorkflowService runs against an in-memory Redis stub (no real Redis),
// and heavy collaborators (plan lookup, deep step validation, the on-disk job
// reader) are mocked so the control flow can be asserted precisely.

vi.mock('../../src/core/UserManager', () => ({
  UserManager: {
    getUserPlan: vi.fn(async () => ({
      quota: 0, maxTabs: 2, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0,
    })),
  },
}));

vi.mock('../../src/validation', () => ({
  sanitizeUserId: (id: unknown) => String(id),
  validateSteps: (s: unknown) => s as unknown[],
  validateWebhookUrl: (u: unknown) => (u ? String(u) : null),
  validateHeadless: () => true,
  validateBackgroundHeadless: () => true,
}));

const jobFiles = new Map<string, unknown>();
vi.mock('../../src/services/job.service', () => ({
  readJobFile: vi.fn(async (_userId: string, jobId: string) => jobFiles.get(jobId) ?? null),
  readPartialJobFile: vi.fn(async () => null),
}));

vi.mock('../../src/config', () => ({
  config: {
    DEFAULT_HEADLESS: true,
    MAX_QUEUED_JOBS_PER_USER: 50,
    VIP_PRIORITY_THRESHOLD: 100,
    RUN_WAIT_MAX_MS: 300,
    RUN_WAIT_POLL_MS: 20,
    IDEMPOTENCY_TTL_SECONDS: 86400,
    WORKFLOW_MAX_VERSIONS: 20,
  },
}));

// In-memory Redis stub supporting kv + set ops used by route + WorkflowService.
function makeConnection() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async get(k: string) { return kv.has(k) ? kv.get(k)! : null; },
    async set(k: string, v: string) { kv.set(k, String(v)); return 'OK'; },
    async del(k: string) { const a = kv.delete(k); const b = sets.delete(k); return a || b ? 1 : 0; },
    async exists(k: string) { return kv.has(k) || sets.has(k) ? 1 : 0; },
    async scard(k: string) { return sets.get(k)?.size ?? 0; },
    async sadd(k: string, v: string) {
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k)!.add(String(v)); return 1;
    },
    async srem(k: string, v: string) { return sets.get(k)?.delete(String(v)) ? 1 : 0; },
    async smembers(k: string) { return Array.from(sets.get(k) ?? []); },
    async expire() { return 1; },
  };
}

function makeQueue() {
  let nextId = 1;
  const states = new Map<string, string>();
  return {
    addCalls: 0,
    lastData: null as any,
    setState(id: string, st: string) { states.set(id, st); },
    async add(_name: string, data: any) {
      const id = String(nextId++);
      this.addCalls++;
      this.lastData = data;
      states.set(id, 'waiting');
      return { id };
    },
    async getJob(id: string) {
      if (!states.has(id)) return null;
      return { id, getState: async () => states.get(id)! };
    },
    async getJobs() { return []; },
  };
}

let app: Express;
let queue: ReturnType<typeof makeQueue>;

beforeAll(async () => {
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  queue = makeQueue();
  const connection = makeConnection();
  const router = createUserRoutes({
    queue: queue as any,
    connection: connection as any,
    profileManager: {} as any,
    quotaManager: {
      hasQuotaRemaining: async () => true,
      getUsage: async () => ({ usedSeconds: 0, date: '2026-06-04' }),
    } as any,
  });
  app = express();
  app.use(express.json());
  app.use('/', router);
});

const wfBody = {
  name: 'My Flow',
  steps: [{ action: 'goto', params: { url: 'https://e.com' } }],
};

describe('Workflow CRUD (G2)', () => {
  let createdId = '';

  it('POST /workflows/:userId creates a workflow (201, version 1)', async () => {
    const res = await request(app).post('/workflows/u1').send(wfBody);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.workflow.id).toMatch(/^wf_/);
    expect(res.body.workflow.version).toBe(1);
    expect(res.body.workflow.userId).toBe('u1');
    createdId = res.body.workflow.id;
  });

  it('rejects an empty name with 400', async () => {
    const res = await request(app).post('/workflows/u1').send({ name: '', steps: wfBody.steps });
    expect(res.status).toBe(400);
  });

  it('GET /workflows/:userId lists the user workflows', async () => {
    const res = await request(app).get('/workflows/u1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.workflows.map((w: any) => w.id)).toContain(createdId);
  });

  it('GET /workflows/:userId/:id fetches one', async () => {
    const res = await request(app).get(`/workflows/u1/${createdId}`);
    expect(res.status).toBe(200);
    expect(res.body.workflow.id).toBe(createdId);
  });

  it('returns 400 on an invalid workflow id', async () => {
    const res = await request(app).get('/workflows/u1/bad id!');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown workflow', async () => {
    const res = await request(app).get('/workflows/u1/wf_doesnotexist');
    expect(res.status).toBe(404);
  });

  it('PUT bumps version and records history', async () => {
    const res = await request(app)
      .put(`/workflows/u1/${createdId}`)
      .send({ name: 'My Flow v2', steps: wfBody.steps });
    expect(res.status).toBe(200);
    expect(res.body.workflow.version).toBe(2);
    expect(res.body.workflow.name).toBe('My Flow v2');

    const hist = await request(app).get(`/workflows/u1/${createdId}/versions`);
    expect(hist.status).toBe(200);
    expect(hist.body.count).toBe(2);
    expect(hist.body.versions.map((v: any) => v.version)).toEqual([2, 1]);
  });

  it('POST /workflows/:userId/:id/run enqueues a job tagged with the workflow', async () => {
    const before = queue.addCalls;
    const res = await request(app).post(`/workflows/u1/${createdId}/run`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.workflowId).toBe(createdId);
    expect(queue.addCalls).toBe(before + 1);
    expect(queue.lastData.__workflowId).toBe(createdId);
  });

  it('returns 404 when running an unknown workflow', async () => {
    const res = await request(app).post('/workflows/u1/wf_missing/run').send({});
    expect(res.status).toBe(404);
  });

  it('DELETE removes the workflow', async () => {
    const del = await request(app).delete(`/workflows/u1/${createdId}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const gone = await request(app).get(`/workflows/u1/${createdId}`);
    expect(gone.status).toBe(404);
  });
});
