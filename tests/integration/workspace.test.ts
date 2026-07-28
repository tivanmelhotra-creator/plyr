import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Workspace route tests ─────────────────────────────────────────────────────
// Covers the three endpoints added by the locked 6-area architecture change
// (docs/uiux/02-HANDOFF-workspace-architecture.md section 4.1):
//
//   1. PATCH /workflows/:userId/:workflowId/state   — the two row switches
//   2. POST  /workflows/:userId/:workflowId/run     — the 409 inactive gate
//   3. GET   /workspace/:userId/stats               — the seven-card aggregate
//
// Same harness shape as tests/integration/workflows.test.ts: the REAL router is
// built by createUserRoutes() against an in-memory Redis stub, so WorkflowService
// persistence semantics are exercised for real while nothing external is needed.
//
// The one non-obvious requirement: the stats route calls
// profileManager.getActiveBrowserCount(). The sibling suite mocks profileManager
// as `{}`, which would throw here — so this harness stubs that single method.

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
}));

vi.mock('../../src/services/job.service', () => ({
  readJobFile: vi.fn(async () => null),
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

// In-memory Redis stub: kv + set ops, which is everything the route and
// WorkflowService touch.
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

// Fake BullMQ queue. `seedJob` / `seedRepeatable` let a test compose the exact
// queue contents the stats aggregate should summarise.
type FakeJob = {
  id: string;
  data: Record<string, unknown>;
  timestamp: number;
  getState: () => Promise<string>;
};

function makeQueue() {
  let nextId = 1;
  const states = new Map<string, string>();
  const jobs: FakeJob[] = [];
  const repeatables: { id: string; name: string }[] = [];
  return {
    addCalls: 0,
    lastData: null as any,
    jobs,
    repeatables,
    reset() {
      this.addCalls = 0;
      this.lastData = null;
      jobs.length = 0;
      repeatables.length = 0;
      states.clear();
    },
    seedJob(state: string, data: Record<string, unknown>, timestamp = Date.now()) {
      const id = `seed_${jobs.length + 1}`;
      const job: FakeJob = { id, data, timestamp, getState: async () => state };
      jobs.push(job);
      return job;
    },
    seedRepeatable(id: string, name = 'run') {
      repeatables.push({ id, name });
    },
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
    // The stats route asks for a specific state list; honour it so a test can
    // prove that a filtered-out job is genuinely not counted.
    async getJobs(wanted?: string[]) {
      if (!wanted || !wanted.length) return jobs;
      const out: FakeJob[] = [];
      for (const j of jobs) if (wanted.includes(await j.getState())) out.push(j);
      return out;
    },
    async getRepeatableJobs() { return repeatables; },
  };
}

let app: Express;
let queue: ReturnType<typeof makeQueue>;
let browserCount = 0;

// Create a workflow through the real route and return its id.
async function createWorkflow(name: string, userId = 'u1'): Promise<string> {
  const res = await request(app)
    .post(`/workflows/${userId}`)
    .send({ name, steps: [{ action: 'goto', params: { url: 'https://e.com' } }] });
  expect(res.status).toBe(201);
  return res.body.workflow.id as string;
}

beforeAll(async () => {
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  queue = makeQueue();
  const connection = makeConnection();
  const router = createUserRoutes({
    queue: queue as any,
    connection: connection as any,
    // The stats route calls this — mocking profileManager as `{}` (as the
    // sibling suite does) makes GET /workspace/:userId/stats throw a 500.
    profileManager: { getActiveBrowserCount: () => browserCount } as any,
    quotaManager: {
      hasQuotaRemaining: async () => true,
      getUsage: async () => ({ usedSeconds: 0, date: '2026-07-28' }),
    } as any,
  });
  app = express();
  app.use(express.json());
  app.use('/', router);
});

beforeEach(() => {
  queue.reset();
  browserCount = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /workflows/:userId/:workflowId/state', () => {
  it('creates workflows runnable-but-not-streamed by default', async () => {
    const id = await createWorkflow('Defaults Flow');
    const res = await request(app).get(`/workflows/u1/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.workflow.active).toBe(true);
    expect(res.body.workflow.liveBrowser).toBe(false);
  });

  it('turns a workflow inactive without bumping the version', async () => {
    const id = await createWorkflow('Deactivate Me');
    const before = await request(app).get(`/workflows/u1/${id}`);
    const versionBefore = before.body.workflow.version;

    const res = await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.workflow.active).toBe(false);
    // A toggle is not a new design of the automation: no version bump.
    expect(res.body.workflow.version).toBe(versionBefore);
    // Nothing to watch on a flow that never runs.
    expect(res.body.liveBrowserViewable).toBe(false);
  });

  it('reports liveBrowserViewable=true when the flow is active and streamed', async () => {
    const id = await createWorkflow('Watchable Flow');
    const res = await request(app).patch(`/workflows/u1/${id}/state`).send({ liveBrowser: true });
    expect(res.status).toBe(200);
    expect(res.body.workflow.active).toBe(true);
    expect(res.body.workflow.liveBrowser).toBe(true);
    expect(res.body.liveBrowserViewable).toBe(true);
  });

  it('keeps liveBrowser intent but reports viewable=false on an inactive flow', async () => {
    // Middle row of the truth table (docs/uiux/workspace-overview.md section 4),
    // asserted SERVER side: intent is preserved, viewability is denied.
    const id = await createWorkflow('Intent Kept');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });

    const res = await request(app).patch(`/workflows/u1/${id}/state`).send({ liveBrowser: true });
    expect(res.status).toBe(200);
    expect(res.body.workflow.liveBrowser).toBe(true);
    expect(res.body.workflow.active).toBe(false);
    expect(res.body.liveBrowserViewable).toBe(false);
  });

  it('leaves the sibling flag untouched on a partial patch', async () => {
    const id = await createWorkflow('Partial Patch');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ liveBrowser: true });

    const res = await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.workflow.liveBrowser).toBe(true); // survived
    expect(res.body.workflow.active).toBe(false);
  });

  it('persists the flags so a later GET reads them back', async () => {
    const id = await createWorkflow('Persisted Flags');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false, liveBrowser: true });

    const res = await request(app).get(`/workflows/u1/${id}`);
    expect(res.body.workflow.active).toBe(false);
    expect(res.body.workflow.liveBrowser).toBe(true);
  });

  it('rejects an empty body (400) — at least one switch is required', async () => {
    const id = await createWorkflow('Empty Body');
    const res = await request(app).patch(`/workflows/u1/${id}/state`).send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/active/);
  });

  it('rejects unknown keys (400) so a mis-sent design is never silently dropped', async () => {
    const id = await createWorkflow('Strict Body');
    const res = await request(app)
      .patch(`/workflows/u1/${id}/state`)
      .send({ steps: [{ action: 'goto', params: { url: 'https://x.com' } }] });
    expect(res.status).toBe(400);

    // Proof the strict rejection was not a partial write: the design is intact.
    const after = await request(app).get(`/workflows/u1/${id}`);
    expect(after.body.workflow.steps).toHaveLength(1);
    expect(after.body.workflow.version).toBe(1);
  });

  it('rejects a non-boolean switch (400)', async () => {
    const id = await createWorkflow('Typed Body');
    const res = await request(app).patch(`/workflows/u1/${id}/state`).send({ active: 'yes' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/boolean/i);
  });

  it('returns 404 for an unknown workflow id', async () => {
    const res = await request(app).patch('/workflows/u1/wf_nope/state').send({ active: false });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed workflow id', async () => {
    const res = await request(app).patch('/workflows/u1/bad id!/state').send({ active: false });
    expect(res.status).toBe(400);
  });

  it('does not touch another user\'s workflow', async () => {
    const id = await createWorkflow('Owned By u1');
    const res = await request(app).patch(`/workflows/u2/${id}/state`).send({ active: false });
    expect(res.status).toBe(404);

    const mine = await request(app).get(`/workflows/u1/${id}`);
    expect(mine.body.workflow.active).toBe(true);
  });

  it('writes no version history — the no-snapshot guarantee at route level', async () => {
    const id = await createWorkflow('No History');
    const before = await request(app).get(`/workflows/u1/${id}/versions`);
    const countBefore = before.body.count;

    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });
    await request(app).patch(`/workflows/u1/${id}/state`).send({ liveBrowser: true });

    const after = await request(app).get(`/workflows/u1/${id}/versions`);
    expect(after.body.count).toBe(countBefore);
  });

  it('PUT preserves the flags and ignores them if sent in the update body', async () => {
    const id = await createWorkflow('Editor Save');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false, liveBrowser: true });

    const res = await request(app).put(`/workflows/u1/${id}`).send({
      name: 'Editor Save v2',
      steps: [{ action: 'goto', params: { url: 'https://e.com' } }],
      // A client sending these here must NOT be able to re-enable the flow.
      active: true,
      liveBrowser: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.workflow.version).toBe(2);
    expect(res.body.workflow.active).toBe(false);
    expect(res.body.workflow.liveBrowser).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /workflows/:userId/:workflowId/run — inactive gate', () => {
  it('refuses to run an inactive workflow with 409 and enqueues nothing', async () => {
    const id = await createWorkflow('Gated Flow');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });

    const before = queue.addCalls;
    const res = await request(app).post(`/workflows/u1/${id}/run`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Workflow is inactive');
    expect(res.body.active).toBe(false);
    expect(res.body.workflowId).toBe(id);
    // The gate is only real if no Job was created.
    expect(queue.addCalls).toBe(before);
  });

  it('runs again once the workflow is re-activated', async () => {
    const id = await createWorkflow('Reactivated Flow');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });
    await request(app).post(`/workflows/u1/${id}/run`).send({}).expect(409);

    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: true });
    const before = queue.addCalls;
    const res = await request(app).post(`/workflows/u1/${id}/run`).send({});
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBeTruthy();
    expect(queue.addCalls).toBe(before + 1);
    expect(queue.lastData.__workflowId).toBe(id);
  });

  it('gates before the quota/queue checks — 409 wins over any body override', async () => {
    const id = await createWorkflow('Gate Precedence');
    await request(app).patch(`/workflows/u1/${id}/state`).send({ active: false });

    const res = await request(app)
      .post(`/workflows/u1/${id}/run`)
      .send({ headless: false, webhookUrl: 'https://hook.example.com/x' });
    expect(res.status).toBe(409);
    expect(queue.addCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /workspace/:userId/stats', () => {
  const STAT_KEYS = [
    'activeSchedules', 'totalFlows', 'activeFlows',
    'successRate', 'failures', 'activeJobs', 'liveBrowsers',
  ];

  it('returns all seven stat keys and a perWorkflow array', async () => {
    await createWorkflow('Stats Flow A');
    const res = await request(app).get('/workspace/u1/stats');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.userId).toBe('u1');
    for (const k of STAT_KEYS) expect(res.body.stats).toHaveProperty(k);
    expect(Object.keys(res.body.stats).sort()).toEqual([...STAT_KEYS].sort());
    expect(Array.isArray(res.body.perWorkflow)).toBe(true);
  });

  it('reports successRate=null (never 0) when nothing has run', async () => {
    await createWorkflow('Never Ran');
    const res = await request(app).get('/workspace/u1/stats');
    expect(res.body.stats.successRate).toBeNull();
    const row = res.body.perWorkflow.find((r: any) => r.successRate !== undefined);
    expect(row.successRate).toBeNull();
    expect(row.lastRunAt).toBeNull();
    expect(row.lastRunState).toBeNull();
  });

  it('counts terminal runs only when computing the success rate', async () => {
    const id = await createWorkflow('Terminal Only');
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('failed', { userId: 'u1', __workflowId: id });
    // In-flight work must not drag the percentage.
    queue.seedJob('active', { userId: 'u1', __workflowId: id });
    queue.seedJob('waiting', { userId: 'u1', __workflowId: id });

    const res = await request(app).get('/workspace/u1/stats');
    expect(res.body.stats.successRate).toBe(75);
    expect(res.body.stats.failures).toBe(1);
    expect(res.body.stats.activeJobs).toBe(2);

    const row = res.body.perWorkflow.find((r: any) => r.workflowId === id);
    expect(row.completed).toBe(3);
    expect(row.failed).toBe(1);
    expect(row.successRate).toBe(75);
  });

  it('rounds the success rate to one decimal', async () => {
    const id = await createWorkflow('Rounding');
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('failed', { userId: 'u1', __workflowId: id });

    const res = await request(app).get('/workspace/u1/stats');
    // 2/3 → 66.7, not 66.66666…
    expect(res.body.stats.successRate).toBe(66.7);
  });

  it('ignores jobs belonging to another user', async () => {
    const id = await createWorkflow('Mine');
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('failed', { userId: 'u2', __workflowId: 'wf_theirs' });

    const res = await request(app).get('/workspace/u1/stats');
    expect(res.body.stats.successRate).toBe(100);
    expect(res.body.stats.failures).toBe(0);
  });

  it('counts untagged ad-hoc jobs globally but attributes them to no row', async () => {
    const id = await createWorkflow('Tagged');
    queue.seedJob('completed', { userId: 'u1', __workflowId: id });
    queue.seedJob('failed', { userId: 'u1' }); // ad-hoc /run, no workflow tag

    const res = await request(app).get('/workspace/u1/stats');
    expect(res.body.stats.failures).toBe(1);
    expect(res.body.stats.successRate).toBe(50);

    const row = res.body.perWorkflow.find((r: any) => r.workflowId === id);
    expect(row.completed).toBe(1);
    expect(row.failed).toBe(0); // the untagged failure did not land on the row
    expect(row.successRate).toBe(100);
  });

  it('reports the newest run as lastRunAt / lastRunState', async () => {
    const id = await createWorkflow('Last Run');
    const older = Date.UTC(2026, 0, 1, 10, 0, 0);
    const newer = Date.UTC(2026, 0, 2, 10, 0, 0);
    queue.seedJob('completed', { userId: 'u1', __workflowId: id }, older);
    queue.seedJob('failed', { userId: 'u1', __workflowId: id }, newer);

    const res = await request(app).get('/workspace/u1/stats');
    const row = res.body.perWorkflow.find((r: any) => r.workflowId === id);
    expect(row.lastRunState).toBe('failed');
    expect(row.lastRunAt).toBe(new Date(newer).toISOString());
  });

  it('counts this user\'s repeatable jobs as activeSchedules and per-row', async () => {
    const id = await createWorkflow('Nightly');
    queue.seedRepeatable('sched:u1:1750000000000:nightly');
    queue.seedRepeatable('sched:u1:1750000000001:nightly');
    queue.seedRepeatable('sched:u2:1750000000002:nightly'); // other user
    queue.seedRepeatable('sched:u1:1750000000003:other');

    const res = await request(app).get('/workspace/u1/stats');
    expect(res.body.stats.activeSchedules).toBe(3);

    const row = res.body.perWorkflow.find((r: any) => r.workflowId === id);
    // Schedules are attributed by name segment, case-insensitively.
    expect(row.scheduleCount).toBe(2);
  });

  it('separates totalFlows from activeFlows', async () => {
    // Dedicated user: the in-memory store is shared across this file, so
    // counting flows needs its own namespace to stay deterministic.
    const u = 'u_counts';
    const a = await createWorkflow('Flow A', u);
    await createWorkflow('Flow B', u);
    await createWorkflow('Flow C', u);
    await request(app).patch(`/workflows/${u}/${a}/state`).send({ active: false });

    const res = await request(app).get(`/workspace/${u}/stats`);
    expect(res.body.stats.totalFlows).toBe(3);
    expect(res.body.stats.activeFlows).toBe(2);
  });

  it('surfaces the live browser count from profileManager', async () => {
    browserCount = 4;
    const res = await request(app).get('/workspace/u1/stats');
    expect(res.body.stats.liveBrowsers).toBe(4);
  });

  it('returns empty aggregates for a user with no workflows', async () => {
    const res = await request(app).get('/workspace/u_empty/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats.totalFlows).toBe(0);
    expect(res.body.stats.activeFlows).toBe(0);
    expect(res.body.stats.activeSchedules).toBe(0);
    expect(res.body.stats.successRate).toBeNull();
    expect(res.body.perWorkflow).toEqual([]);
  });

  it('emits one perWorkflow row per workflow with the documented shape', async () => {
    await createWorkflow('Shape Check');
    const res = await request(app).get('/workspace/u1/stats');
    for (const row of res.body.perWorkflow) {
      expect(Object.keys(row).sort()).toEqual([
        'completed', 'failed', 'lastRunAt', 'lastRunState',
        'scheduleCount', 'successRate', 'workflowId',
      ]);
    }
  });
});
