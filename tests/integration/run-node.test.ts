import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── [Item N] POST /run-node — per-node test run ───────────────────────────────
//
// The contract under test (docs/uiux/09-HANDOFF-item-N-per-node-run.md § 2):
//
//   * the client sends the chain PREFIX, so the node under test is the LAST
//     step and its input is produced by really running its ancestors;
//   * a mismatched `nodeIndex` is a 400, never a silent "run something else";
//   * the queued job is tagged `__runNode` and carries NO `__workflowId`, so a
//     partial test run can never be counted as a workflow execution;
//   * GET /jobs reports it as `trigger: 'node'`, `partial: true`, and it is
//     excluded from a `?workflowId=` (Executions tab) query;
//   * quota and queue limits behave exactly like POST /run — a node test is not
//     a quota bypass.
//
// Same harness as workflows.test.ts: the real router, an in-memory Redis stub and
// a fake queue, so no Redis, no browser and no worker are needed.

vi.mock('../../src/core/UserManager', () => ({
  UserManager: {
    getUserPlan: vi.fn(async () => ({
      quota: 0, maxTabs: 2, maxSteps: 100, priority: 3, maxSchedules: 5, runLimit: 0,
    })),
  },
}));

vi.mock('../../src/validation', () => ({
  sanitizeUserId: (id: unknown) => String(id),
  // The real validateSteps strips UI-only annotation fields (09-HANDOFF § 3.3);
  // here it is a pass-through so the prefix arrives at the queue verbatim.
  validateSteps: (s: unknown) => s as unknown[],
  validateWebhookUrl: (u: unknown) => (u ? String(u) : null),
  validateHeadless: () => true,
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

/** Fake BullMQ queue that remembers every `add` and can list them back. */
function makeQueue() {
  let nextId = 1;
  const states = new Map<string, string>();
  const datas = new Map<string, any>();
  return {
    addCalls: 0,
    lastData: null as any,
    // The `?wait=true` tests must flip EXACTLY the job the handler is polling,
    // so the fake queue publishes the id it just minted rather than making the
    // test guess it from a call count.
    lastId: '',
    // Staging the result AFTER `add` resolves is a race with the handler's own
    // poll loop (and supertest does not even dispatch the request until it is
    // awaited). So the `?wait=true` happy path is armed BEFORE the call: the next
    // job minted lands already-completed with this file on "disk".
    completeNextWith: null as any,
    setState(id: string, st: string) { states.set(id, st); },
    async add(_name: string, data: any) {
      const id = String(nextId++);
      this.addCalls++;
      this.lastData = data;
      this.lastId = id;
      datas.set(id, data);
      if (this.completeNextWith) {
        states.set(id, 'completed');
        jobFiles.set(id, this.completeNextWith);
        this.completeNextWith = null;
      } else {
        states.set(id, 'waiting');
      }
      return { id };
    },
    async getJob(id: string) {
      if (!states.has(id)) return null;
      return { id, getState: async () => states.get(id)! };
    },
    // GET /jobs asks for the full list; GET /run's queue-limit check asks for
    // the active subset. One implementation serves both.
    async getJobs() {
      return Array.from(datas.entries()).map(([id, data]) => ({
        id,
        data,
        timestamp: 1000 + Number(id),
        progress: 0,
        failedReason: undefined,
        processedOn: null,
        finishedOn: null,
        getState: async () => states.get(id)!,
      }));
    },
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
      getUsage: async () => ({ usedSeconds: 0, date: '2026-07-30' }),
    } as any,
  });
  app = express();
  app.use(express.json());
  app.use('/', router);
});

// A three-step prefix: the node under test is `click`, the LAST step.
const prefix = [
  { action: 'launch', params: {} },
  { action: 'goto', params: { url: 'https://e.com' } },
  { action: 'click', params: { selector: '#next-button' } },
];

describe('POST /run-node', () => {
  it('queues the prefix and reports the node index + partial flag', async () => {
    const res = await request(app)
      .post('/run-node')
      .send({ userId: 'u1', steps: prefix, nodeIndex: 2 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.partial).toBe(true);
    expect(res.body.nodeIndex).toBe(prefix.length - 1);
    expect(res.body.stepCount).toBe(3);
    expect(res.body.jobId).toBeTruthy();
  });

  it('tags the job __runNode and never stamps __workflowId', async () => {
    await request(app).post('/run-node').send({ userId: 'u2', steps: prefix });
    expect(queue.lastData.__runNode).toBe(true);
    expect(queue.lastData.__nodeIndex).toBe(2);
    // The two fields that would make a partial run look like a real execution.
    expect(queue.lastData.__workflowId).toBeUndefined();
    expect(queue.lastData.webhookUrl).toBeUndefined();
    // The prefix is passed through verbatim — nothing is synthesised.
    expect(queue.lastData.steps).toHaveLength(3);
    expect(queue.lastData.steps[2].action).toBe('click');
  });

  it('rejects a nodeIndex that does not address the LAST step', async () => {
    const res = await request(app)
      .post('/run-node')
      .send({ userId: 'u1', steps: prefix, nodeIndex: 1 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toContain('LAST step');
  });

  it('rejects an empty prefix through the zod envelope', async () => {
    const res = await request(app).post('/run-node').send({ userId: 'u1', steps: [] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('requires userId', async () => {
    const res = await request(app).post('/run-node').send({ steps: prefix });
    expect(res.status).toBe(400);
  });

  it('?wait=true returns the finished result inline', async () => {
    queue.completeNextWith = { success: true, results: [{ action: 'click', ok: true }] };
    const res = await request(app)
      .post('/run-node?wait=true')
      .send({ userId: 'u3', steps: prefix });
    expect(res.status).toBe(200);
    expect(res.body.waited).toBe(true);
    expect(res.body.partial).toBe(true);
    expect(res.body.nodeIndex).toBe(2);
    expect(res.body.results).toHaveLength(1);
  });

  it('?wait=true returns 202 + pollUrl when the run outlives the deadline', async () => {
    const res = await request(app)
      .post('/run-node?wait=true')
      .send({ userId: 'u4', steps: prefix });
    expect(res.status).toBe(202);
    expect(res.body.completed).toBe(false);
    expect(res.body.partial).toBe(true);
    expect(String(res.body.pollUrl)).toContain('/job/u4/');
  });
});

describe('GET /jobs — a node test is never a workflow execution', () => {
  it('reports trigger "node" and partial true', async () => {
    await request(app).post('/run-node').send({ userId: 'u9', steps: prefix });
    const res = await request(app).get('/jobs/u9');
    expect(res.status).toBe(200);
    const row = res.body.jobs[0];
    expect(row.trigger).toBe('node');
    expect(row.partial).toBe(true);
    expect(row.nodeIndex).toBe(2);
    expect(row.workflowId).toBeNull();
  });

  it('is EXCLUDED from a ?workflowId= (Executions tab) query', async () => {
    await request(app).post('/run-node').send({ userId: 'u10', steps: prefix });
    const res = await request(app).get('/jobs/u10?workflowId=wf_anything');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
  });

  it('a plain /run job is still reported as "manual", not "node"', async () => {
    await request(app).post('/run').send({ userId: 'u11', steps: prefix });
    const res = await request(app).get('/jobs/u11');
    const row = res.body.jobs[0];
    expect(row.trigger).toBe('manual');
    expect(row.partial).toBe(false);
    expect(row.nodeIndex).toBeNull();
  });
});
