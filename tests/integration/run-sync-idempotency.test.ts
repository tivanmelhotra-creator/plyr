import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── POST /run — synchronous + idempotent submission ───────────────────────
// Exercises the real POST /run handler wiring for the three API-client features
// any external caller (HTTP client, scheduler, browser extension) relies on:
//   1. Idempotency-Key dedupe (same key -> original jobId, no second enqueue)
//   2. ?wait=true sync mode returning the persisted result inline
//   3. ?wait=true timeout -> HTTP 202 with a pollUrl
//
// Heavy collaborators (UserManager plan lookup, deep step validation, the
// on-disk job file reader) are mocked so we can run without Redis / Playwright
// and assert the control-flow precisely. The Redis `connection` is a tiny
// in-memory stub implementing only the methods the handler touches.

// Mock plan lookup (no Redis).
vi.mock('../../src/core/UserManager', () => ({
  UserManager: {
    getUserPlan: vi.fn(async () => ({
      quota: 0, maxTabs: 2, maxSteps: 100, priority: 1, maxSchedules: 5, runLimit: 0,
    })),
  },
}));

// Mock validation so we don't need full step sanitization here.
vi.mock('../../src/validation', () => ({
  sanitizeUserId: (id: unknown) => String(id),
  validateSteps: (s: unknown) => s as unknown[],
  validateWebhookUrl: (u: unknown) => (u ? String(u) : null),
  validateHeadless: () => true,
}));

// Control what the "persisted job file" returns per test.
const jobFiles = new Map<string, unknown>();
vi.mock('../../src/services/job.service', () => ({
  readJobFile: vi.fn(async (_userId: string, jobId: string) => jobFiles.get(jobId) ?? null),
  readPartialJobFile: vi.fn(async () => null),
}));

// Make config deterministic + fast (short wait window/poll).
vi.mock('../../src/config', () => ({
  config: {
    DEFAULT_HEADLESS: true,
    MAX_QUEUED_JOBS_PER_USER: 50,
    VIP_PRIORITY_THRESHOLD: 100,
    RUN_WAIT_MAX_MS: 300,
    RUN_WAIT_POLL_MS: 20,
    IDEMPOTENCY_TTL_SECONDS: 86400,
  },
}));

// In-memory Redis stub.
function makeConnection() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store: kv,
    async get(k: string) { return kv.has(k) ? kv.get(k)! : null; },
    async set(k: string, v: string) { kv.set(k, String(v)); return 'OK'; },
    async scard(k: string) { return sets.get(k)?.size ?? 0; },
    async sadd(k: string, v: string) {
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k)!.add(String(v)); return 1;
    },
    async expire() { return 1; },
  };
}

// Queue stub: counts add() calls and serves getJob() with a controllable state.
function makeQueue() {
  let nextId = 1;
  const states = new Map<string, string>();
  return {
    addCalls: 0,
    setState(id: string, st: string) { states.set(id, st); },
    async add() {
      const id = String(nextId++);
      this.addCalls++;
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
let connection: ReturnType<typeof makeConnection>;

beforeAll(async () => {
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  queue = makeQueue();
  connection = makeConnection();
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

const validBody = { userId: 'u1', steps: [{ action: 'goto', params: { url: 'https://e.com' } }] };

describe('POST /run — async (default)', () => {
  it('enqueues and returns a jobId', async () => {
    const res = await request(app).post('/run').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBeTruthy();
  });
});

describe('POST /run — Idempotency-Key (F3)', () => {
  it('rejects a malformed key with 400', async () => {
    const res = await request(app).post('/run').set('Idempotency-Key', 'bad key!').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
  });

  it('dedupes: same key returns the original job without a second enqueue', async () => {
    const before = queue.addCalls;
    const first = await request(app).post('/run').set('Idempotency-Key', 'order-123').send(validBody);
    expect(first.status).toBe(200);
    const firstJobId = first.body.jobId;
    expect(queue.addCalls).toBe(before + 1);

    const second = await request(app).post('/run').set('Idempotency-Key', 'order-123').send(validBody);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.jobId).toBe(firstJobId);
    // No new job was enqueued.
    expect(queue.addCalls).toBe(before + 1);
  });
});

describe('POST /run?wait=true — sync mode (F3)', () => {
  it('returns the persisted result inline once the job completes', async () => {
    // Pre-seed: when a job is created, mark it completed and provide a file.
    const res = await new Promise<request.Response>((resolve, reject) => {
      const reqp = request(app).post('/run?wait=true').send(validBody);
      // Flip the (about-to-be-created) job to completed shortly after submit.
      setTimeout(() => {
        const id = String(queue.addCalls); // last created id
        jobFiles.set(id, { success: true, jobId: id, state: 'completed', durationMs: 5, stepOutputs: [] });
        queue.setState(id, 'completed');
      }, 40);
      reqp.then(resolve).catch(reject);
    });
    expect(res.status).toBe(200);
    expect(res.body.waited).toBe(true);
    expect(res.body.state).toBe('completed');
    expect(res.body.success).toBe(true);
  });

  it('returns 202 with a pollUrl when the job is still running at the deadline', async () => {
    // Do NOT complete the job; it stays "waiting" so wait times out (~300ms).
    const res = await request(app).post('/run?wait=true').send(validBody);
    expect(res.status).toBe(202);
    expect(res.body.completed).toBe(false);
    expect(res.body.waited).toBe(true);
    expect(res.body.pollUrl).toMatch(/^\/job\/u1\//);
  });
});
