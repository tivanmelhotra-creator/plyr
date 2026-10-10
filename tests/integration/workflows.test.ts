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

// Test hook: when set, validateSteps rejects with this message (simulates an invalid design).
const stepValidation = { rejectWith: null as string | null };

vi.mock('../../src/validation', () => ({
  sanitizeUserId: (id: unknown) => String(id),
  // Mirrors the real validateSteps rule for an empty design (allowEmpty is
  // only passed by save/restore, never by activation).
  validateSteps: (s: unknown, _plan?: unknown, opts: { allowEmpty?: boolean } = {}) => {
    if (stepValidation.rejectWith) throw new Error(stepValidation.rejectWith);
    if (Array.isArray(s) && s.length === 0 && !opts.allowEmpty) {
      throw new Error('Steps cannot be empty');
    }
    return s as unknown[];
  },
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
    async getRepeatableJobs() { return []; },
  };
}

let app: Express;
let queue: ReturnType<typeof makeQueue>;
let conn: ReturnType<typeof makeConnection>;

beforeAll(async () => {
  const { createUserRoutes } = await import('../../src/Routes/user.routes');
  queue = makeQueue();
  const connection = makeConnection();
  conn = connection;
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

  it('PUT (autosave) updates the current state without adding history entries', async () => {
    const before = await request(app).get(`/workflows/u1/${createdId}/versions`);
    const res = await request(app)
      .put(`/workflows/u1/${createdId}`)
      .send({ name: 'My Flow v2', steps: wfBody.steps });
    expect(res.status).toBe(200);
    expect(res.body.workflow.version).toBe(2);
    expect(res.body.workflow.name).toBe('My Flow v2');

    const hist = await request(app).get(`/workflows/u1/${createdId}/versions`);
    expect(hist.status).toBe(200);
    expect(hist.body.count).toBe(before.body.count); // no new entry per edit
    expect(hist.body.versions.every((v: any) => v.kind !== 'manual')).toBe(true);
  });

  it('a thousand autosaves keep a single history entry (no per-edit versions)', async () => {
    const id = createdId;
    const before = await request(app).get(`/workflows/u1/${id}/versions`);
    for (let i = 0; i < 1000; i++) {
      const r = await request(app).put(`/workflows/u1/${id}`).send({ name: `n${i}`, steps: wfBody.steps });
      if (r.status !== 200) throw new Error(`autosave ${i} failed: ${r.status}`);
    }
    const after = await request(app).get(`/workflows/u1/${id}/versions`);
    expect(after.body.count).toBe(before.body.count);
    // ...and nothing was written underneath either: storage still holds only
    // the creation snapshot, whatever the number of edits.
    const { WorkflowService } = await import('../../src/services/workflow.service');
    expect((await new WorkflowService(conn as any).listAllVersions('u1', id)).length).toBe(1);
    const cur = await request(app).get(`/workflows/u1/${id}`);
    expect(cur.body.workflow.name).toBe('n999');
  }, 60_000);

  it('a new workflow is inactive: a background run is refused until it is activated', async () => {
    const off = await request(app).post(`/workflows/u1/${createdId}/run`).send({});
    expect(off.status).toBe(409);
    const on = await request(app).patch(`/workflows/u1/${createdId}/state`).send({ active: true });
    expect(on.status).toBe(200);
    expect(on.body.workflow.active).toBe(true);
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

describe('Active isolation and manual versions (HTTP)', () => {
  const stepsA = [{ action: 'goto', params: { url: 'https://a.example' } }];
  const stepsB = [{ action: 'goto', params: { url: 'https://b.example' } }];
  let wfId = '';

  beforeAll(() => { stepValidation.rejectWith = null; });

  it('activation freezes the design; editing afterwards does not change runs', async () => {
    const created = await request(app).post('/workflows/iso1').send({ name: 'Iso', steps: stepsA });
    wfId = created.body.workflow.id;

    const on = await request(app).patch(`/workflows/iso1/${wfId}/state`).send({ active: true });
    expect(on.status).toBe(200);
    expect(on.body.workflow.activeSnapshot.steps).toEqual(stepsA);

    // Editor change after activation.
    const edited = await request(app).put(`/workflows/iso1/${wfId}`).send({ name: 'Iso', steps: stepsB });
    expect(edited.status).toBe(200);
    expect(edited.body.workflow.steps).toEqual(stepsB);

    // A background run uses the frozen design, not the live one.
    queue.lastData = null;
    const run = await request(app).post(`/workflows/iso1/${wfId}/run`).send({});
    expect(run.status).toBe(200);
    expect(queue.lastData.steps).toEqual(stepsA);
    expect(run.body.workflowVersion).toBe(on.body.workflow.activeSnapshot.version);
  });

  it('re-activation with an invalid design is refused and the old snapshot is kept', async () => {
    stepValidation.rejectWith = 'Step 1: unknown action';
    try {
      const res = await request(app).patch(`/workflows/iso1/${wfId}/state`).send({ active: true });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('activation_invalid');
      expect(res.body.details[0]).toContain('unknown action');

      const read = await request(app).get(`/workflows/iso1/${wfId}`);
      expect(read.body.workflow.activeSnapshot.steps).toEqual(stepsA);
    } finally {
      stepValidation.rejectWith = null;
    }
  });

  it('re-activation with a valid design replaces the snapshot', async () => {
    const res = await request(app).patch(`/workflows/iso1/${wfId}/state`).send({ active: true });
    expect(res.status).toBe(200);
    expect(res.body.workflow.activeSnapshot.steps).toEqual(stepsB);
  });

  it('manual save creates a manual version that is listed and does not overwrite autosave history', async () => {
    const before = await request(app).get(`/workflows/iso1/${wfId}/versions`);
    const autoCountBefore = before.body.versions.filter((v: any) => v.kind !== 'manual').length;

    const saved = await request(app).post(`/workflows/iso1/${wfId}/save`).send({ label: '  before refactor  ' });
    expect(saved.status).toBe(201);
    expect(saved.body.version.kind).toBe('manual');
    expect(saved.body.version.label).toBe('before refactor');

    const after = await request(app).get(`/workflows/iso1/${wfId}/versions`);
    const manual = after.body.versions.filter((v: any) => v.kind === 'manual');
    const autoCountAfter = after.body.versions.filter((v: any) => v.kind !== 'manual').length;
    expect(manual.length).toBe(1);
    expect(autoCountAfter).toBe(autoCountBefore); // no autosave entry lost
  });

  it('restore brings back an earlier design, keeps other versions, and keeps Active intact', async () => {
    const versions = await request(app).get(`/workflows/iso1/${wfId}/versions`);
    const first = versions.body.versions.find((v: any) => v.kind !== 'manual' && v.steps[0].params.url === 'https://a.example');
    expect(first).toBeTruthy();
    const countBefore = versions.body.versions.length;

    const res = await request(app).post(`/workflows/iso1/${wfId}/versions/${first.version}/restore`).send({});
    expect(res.status).toBe(200);
    expect(res.body.workflow.steps).toEqual(stepsA);
    expect(res.body.workflow.active).toBe(true);
    expect(res.body.workflow.activeSnapshot.steps).toEqual(stepsB); // Active untouched

    const after = await request(app).get(`/workflows/iso1/${wfId}/versions`);
    expect(after.body.versions.length).toBe(countBefore); // restore writes no history entry
    expect(after.body.versions.some((v: any) => v.kind === 'manual')).toBe(true);
  });

  it('restore of an unknown version returns 404', async () => {
    const res = await request(app).post(`/workflows/iso1/${wfId}/versions/999999/restore`).send({});
    expect(res.status).toBe(404);
  });

  it('schedule bound to an inactive workflow is refused with 409', async () => {
    const created = await request(app).post('/workflows/iso1').send({ name: 'Off', steps: stepsA });
    const offId = created.body.workflow.id;
    // New workflows default to active; deactivate it explicitly (the real Workspace switch).
    const off = await request(app).patch(`/workflows/iso1/${offId}/state`).send({ active: false });
    expect(off.status).toBe(200);
    const res = await request(app).post('/schedule').send({
      userId: 'iso1', cron: '0 9 * * *', name: 'off', workflowId: offId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Workflow is inactive');
  });

  it('activating an empty workflow is refused with the reason, and nothing is frozen', async () => {
    const created = await request(app).post('/workflows/iso1').send({ name: 'Empty', steps: [] });
    const emptyId = created.body.workflow.id;
    const res = await request(app).patch(`/workflows/iso1/${emptyId}/state`).send({ active: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('activation_invalid');
    expect(res.body.details[0]).toBe('Steps cannot be empty');
    const read = await request(app).get(`/workflows/iso1/${emptyId}`);
    expect(read.body.workflow.activeSnapshot ?? null).toBeNull();
  });
});

describe('Phase-1 completion: activation errors, versions, import, schedules', () => {
  beforeAll(() => { stepValidation.rejectWith = null; });

  it('activation lists EVERY blocking error (unknown action, missing params) and is refused', async () => {
    const created = await request(app).post('/workflows/ph1').send({
      name: 'Broken',
      steps: [
        { action: 'goto', params: {} },
        { action: 'does-not-exist', params: {} },
        { action: 'click', params: { selector: '' } },
        { action: 'click', params: {}, disabled: true }, // disabled: never runs, not an error
      ],
    });
    const id = created.body.workflow.id;
    const res = await request(app).patch(`/workflows/ph1/${id}/state`).send({ active: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('activation_invalid');
    expect(res.body.details).toEqual([
      'Node 1 (goto) needs a URL',
      'Node 2 (does-not-exist) uses an unknown action "does-not-exist"',
      'Node 3 (click) needs a selector',
    ]);
    const read = await request(app).get(`/workflows/ph1/${id}`);
    expect(read.body.workflow.active).toBe(false);
    expect(read.body.workflow.activeSnapshot ?? null).toBeNull();
  });

  it('valid -> active, deactivate, add a broken node, re-activate refused, fix, re-activate replaces the snapshot', async () => {
    const good = [{ action: 'goto', params: { url: 'https://ok.example' } }];
    const created = await request(app).post('/workflows/ph1').send({ name: 'Cycle', steps: good });
    const id = created.body.workflow.id;
    expect((await request(app).patch(`/workflows/ph1/${id}/state`).send({ active: true })).status).toBe(200);
    expect((await request(app).patch(`/workflows/ph1/${id}/state`).send({ active: false })).status).toBe(200);

    const broken = [...good, { action: 'fill', params: { text: 'x' } }];
    await request(app).put(`/workflows/ph1/${id}`).send({ name: 'Cycle', steps: broken });
    const refused = await request(app).patch(`/workflows/ph1/${id}/state`).send({ active: true });
    expect(refused.status).toBe(422);
    expect(refused.body.details).toEqual(['Node 2 (fill) needs a selector']);
    const mid = await request(app).get(`/workflows/ph1/${id}`);
    expect(mid.body.workflow.active).toBe(false);
    expect(mid.body.workflow.activeSnapshot.steps).toEqual(good); // previous snapshot untouched

    const fixed = [...good, { action: 'fill', params: { selector: '#q', text: 'x' } }];
    await request(app).put(`/workflows/ph1/${id}`).send({ name: 'Cycle', steps: fixed });
    const ok = await request(app).patch(`/workflows/ph1/${id}/state`).send({ active: true });
    expect(ok.status).toBe(200);
    expect(ok.body.workflow.activeSnapshot.steps).toEqual(fixed);
  });

  it('an invalid edit on an ACTIVE workflow never reaches its frozen snapshot', async () => {
    const good = [{ action: 'goto', params: { url: 'https://live.example' } }];
    const created = await request(app).post('/workflows/ph1').send({ name: 'Live', steps: good });
    const id = created.body.workflow.id;
    await request(app).patch(`/workflows/ph1/${id}/state`).send({ active: true });
    await request(app).put(`/workflows/ph1/${id}`).send({ name: 'Live', steps: [{ action: 'nope', params: {} }] });
    queue.lastData = null;
    const run = await request(app).post(`/workflows/ph1/${id}/run`).send({});
    expect(run.status).toBe(200);
    expect(queue.lastData.steps).toEqual(good);
  });

  it('the versions list offers only the initial version and manual saves, numbered apart', async () => {
    const created = await request(app).post('/workflows/ph1').send({ name: 'Ver', steps: [{ action: 'log', params: {} }] });
    const id = created.body.workflow.id;
    for (let i = 0; i < 5; i++) await request(app).put(`/workflows/ph1/${id}`).send({ name: 'Ver', steps: [{ action: 'log', params: { message: String(i) } }] });
    await request(app).post(`/workflows/ph1/${id}/save`).send({ label: 'one' });
    await request(app).post(`/workflows/ph1/${id}/save`).send({ label: 'two' });
    const list = await request(app).get(`/workflows/ph1/${id}/versions`);
    expect(list.body.versions.map((v: any) => [v.kind, v.label ?? null])).toEqual([
      ['manual', 'two'], ['manual', 'one'], ['initial', null],
    ]);
  });

  it('legacy per-edit autosave rows are pruned safely: manual and initial kept, restore of a pruned row is 404', async () => {
    const { WorkflowService } = await import('../../src/services/workflow.service');
    const svc = new WorkflowService(conn as any);
    const created = await request(app).post('/workflows/ph1').send({ name: 'Legacy', steps: [{ action: 'log', params: {} }] });
    const id = created.body.workflow.id;
    // Simulate an old build: untagged per-edit rows v2..v4 + the initial row untagged.
    const repo: any = (svc as any).repo;
    const init = (await repo.listVersions('ph1', id))[0];
    await repo.saveVersion('ph1', id, { ...init, kind: undefined });
    for (const v of [2, 3, 4]) await repo.saveVersion('ph1', id, { ...init, version: v, kind: undefined });
    await request(app).post(`/workflows/ph1/${id}/save`).send({ label: 'keep me' }); // also prunes
    const all = await svc.listAllVersions('ph1', id);
    expect(all.map((s: any) => s.kind).sort()).toEqual(['initial', 'manual']);
    expect((await request(app).post(`/workflows/ph1/${id}/versions/3/restore`).send({})).status).toBe(404);
  });

  it('import never overwrites: a duplicate name gets a predictable " (2)" suffix and starts inactive', async () => {
    const file = { format: 'plyr-workflow', version: 1, workflow: { name: 'Dup', steps: [{ action: 'log', params: {} }] } };
    const a = await request(app).post('/workflows/ph2/import').send(file);
    const b = await request(app).post('/workflows/ph2/import').send(file);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.workflow.name).toBe('Dup');
    expect(b.body.workflow.name).toBe('Dup (2)');
    expect(b.body.renamedFrom).toBe('Dup');
    expect(b.body.workflow.active).toBe(false);
    expect(b.body.workflow.id).not.toBe(a.body.workflow.id);
  });

  it('a schedule bound to a workflow is resolved at FIRE time (inactive -> skipped, active -> frozen design)', async () => {
    const { WorkflowService, resolveScheduledWorkflow } = await import('../../src/services/workflow.service');
    const svc = new WorkflowService(conn as any);
    const steps = [{ action: 'goto', params: { url: 'https://sched.example' } }];
    const created = await request(app).post('/workflows/ph3').send({ name: 'Sched', steps });
    const id = created.body.workflow.id;
    await request(app).patch(`/workflows/ph3/${id}/state`).send({ active: true });
    const sched = await request(app).post('/schedule').send({ userId: 'ph3', cron: '0 9 * * *', name: 's', workflowId: id });
    expect(sched.status).toBe(200);
    expect(queue.lastData.__scheduleWorkflowId).toBe(id);

    await request(app).put(`/workflows/ph3/${id}`).send({ name: 'Sched', steps: [{ action: 'log', params: {} }] });
    const live = await resolveScheduledWorkflow(svc, 'ph3', id);
    expect('steps' in live && live.steps).toEqual(steps);

    await request(app).patch(`/workflows/ph3/${id}/state`).send({ active: false });
    expect(await resolveScheduledWorkflow(svc, 'ph3', id)).toEqual({ skip: 'bound workflow is inactive' });
  });
});
