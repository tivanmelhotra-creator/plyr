/**
 * Live Run redesign (docs/uiux/24-HANDOFF-live-run-redesign.md), server side:
 *  - core/LiveRunPlan: what a SHARE-LINK viewer may learn about a run up front
 *  - Routes/live-control: GET /live/plan (share token) and POST /live/restart
 *    (owner credential only — a share token must never start a run)
 *  - core/JobScreencast.pageUrl: the address bar never shows a query string
 */
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import { buildLivePlan, safeUrl, targetOf, restartJobData } from '../../src/core/LiveRunPlan';
import { createLiveControlRouter, type LiveControlDeps, type LiveJobLike } from '../../src/Routes/live-control.routes';
import { pageUrl } from '../../src/core/JobScreencast';

describe('LiveRunPlan — the steps a viewer may see', () => {
  it('lists the enabled top-level chain in order, with one short target each', () => {
    const plan = buildLivePlan([
      { action: 'launch', params: { url: '' } },
      { action: 'goto', params: { url: 'https://www.amazon.com/?tag=SECRET#x' } },
      { action: 'wait', params: { ms: 1000 } },
      { action: 'click', params: { selector: '#add-to-cart-button' } },
      { action: 'fill', params: { selector: 'input[name=q]', value: 'my password' } },
      { action: 'screenshot', params: {} },
      { action: 'code', disabled: true, params: { code: 'x' } },
      { action: 'close-browser' },
    ]);
    expect(plan.steps).toEqual([
      { action: 'launch', target: '' },
      { action: 'goto', target: 'https://www.amazon.com' },
      { action: 'wait', target: '1000ms' },
      { action: 'click', target: '#add-to-cart-button' },
      { action: 'fill', target: 'input[name=q]' },
      { action: 'screenshot', target: '' },
      { action: 'close-browser', target: '' },
    ]);
  });

  it('never copies a secret: typed values, headers, bodies, tokens, code, messages, queries', () => {
    const plan = buildLivePlan([
      { action: 'fill', params: { selector: '#pw', value: 'hunter2' } },
      { action: 'http-request', params: { url: 'https://api.x.test/v1/items?key=SECRET', headers: '{"Authorization":"Bearer SECRET"}', body: 'SECRET' } },
      { action: 'trigger_telegram', params: { botToken: '123:SECRET' } },
      { action: 'code', params: { code: 'SECRET' } },
      { action: 'log', params: { message: 'SECRET' } },
      { action: 'cookie', params: { name: 'sid', value: 'SECRET' } },
      { action: 'if', then: [{ action: 'fill', params: { value: 'SECRET' } }] },
    ]);
    const s = JSON.stringify(plan);
    expect(s).not.toMatch(/SECRET|hunter2/);
    expect(plan.steps[1].target).toBe('https://api.x.test/v1/items');
    expect(plan.steps).toHaveLength(7); // nested steps are not planned
  });

  it('URLs: only http(s), origin + path; expressions shown as written; junk dropped', () => {
    expect(safeUrl('https://user:pw@shop.test/a/b?x=1')).toBe('https://shop.test/a/b');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('file:///etc/passwd')).toBe('');
    expect(safeUrl('{{ $json.url }}')).toBe('{{ $json.url }}');
    expect(safeUrl('not a url')).toBe('');
    expect(safeUrl(42)).toBe('');
  });

  it('targets are clipped and tolerant of odd params', () => {
    expect(targetOf({ action: 'click', params: { selector: 'a'.repeat(500) } }).length).toBeLessThanOrEqual(160);
    expect(targetOf({ action: 'click', params: 'nope' as any })).toBe('');
    expect(targetOf({ action: 'delay', params: { ms: 'x' } })).toBe('');
    expect(targetOf({ action: 'wait', params: { selector: '#ready' } })).toBe('#ready');
    expect(buildLivePlan('nope' as any).steps).toEqual([]);
    expect(buildLivePlan([null, 3, { params: {} }, { action: 'goto' }]).steps).toEqual([{ action: 'goto', target: '' }]);
  });

  it('restartJobData: same work, fresh bookkeeping, a manual run', () => {
    const next = restartJobData({
      userId: 'local', steps: [1], __origin: 'automatic', __cancelledByUser: true, __waitingFor: 'p',
      __scheduled: true, __scheduleName: 's', __scheduleWorkflowId: 'w', __workspace: { owner: 'local', workflowId: 'w' },
      profileId: 'shopA',
    }, 'job-7');
    expect(next).toEqual({ userId: 'local', steps: [1], __origin: 'manual', __restartOf: 'job-7',
      __workspace: { owner: 'local', workflowId: 'w' }, profileId: 'shopA' });
  });
});

describe('pageUrl — the address bar', () => {
  const page = (u: string | (() => string)) => ({ isClosed: () => false, context: () => ({} as any), url: typeof u === 'function' ? u : () => u });
  it('drops query and hash', () => {
    expect(pageUrl(page('https://www.amazon.com/dp/B0?session=SECRET#top'))).toBe('https://www.amazon.com/dp/B0');
    expect(pageUrl(page('https://www.amazon.com/'))).toBe('https://www.amazon.com');
  });
  it('non-http pages show scheme + host; failures show nothing', () => {
    expect(pageUrl(page('about:blank'))).toBe('about:');
    expect(pageUrl(page('chrome-extension://abc/popup.html?x=1'))).toBe('chrome-extension://abc');
    expect(pageUrl(page(() => { throw new Error('closed'); }))).toBe('');
    expect(pageUrl({ isClosed: () => false, context: () => ({} as any) })).toBe('');
  });
});

// ---- routes ---------------------------------------------------------------

function job(over: Partial<LiveJobLike> & { state?: string } = {}): LiveJobLike {
  const state = over.state ?? 'active';
  return {
    id: 'job-1', processedOn: Date.UTC(2026, 0, 1, 10, 0, 0),
    data: { userId: 'local', steps: [{ action: 'goto', params: { url: 'https://a.test/x?k=SECRET' } }], __workspace: { owner: 'local', workflowId: 'wf1' } },
    getState: async () => state,
    ...over,
  };
}

function serve(over: Partial<LiveControlDeps> = {}) {
  const deps: LiveControlDeps = {
    // share "GOOD" is bound to job-1; "x-api-key: OWNER" is the owner.
    authorize: vi.fn(async (key, _u, o) => {
      if (o?.share === 'GOOD' && (!o.jobId || o.jobId === 'job-1')) return { ok: true };
      if (key === 'OWNER') return { ok: true };
      return { ok: false, reason: key ? 'invalid_api_key' : 'missing_api_key' };
    }),
    getJob: vi.fn(async (id) => (id === 'job-1' ? job() : null)),
    workflowName: vi.fn(async () => 'Product Scraper'),
    cancel: vi.fn(async () => {}),
    enqueue: vi.fn(async () => 'job-2'),
    shareToken: vi.fn(() => 'NEWTOKEN'),
    ...over,
  };
  const app = express();
  app.use(createLiveControlRouter(deps));
  const server = http.createServer(app);
  return new Promise<{ base: string; deps: LiveControlDeps; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as any;
      resolve({ base: `http://127.0.0.1:${port}`, deps, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function req(base: string, method: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers });
  return { status: r.status, body: await r.json() as any };
}

describe('GET /live/plan', () => {
  it('a share token for THIS job reads the plan: names, targets, start time — no params', async () => {
    const s = await serve();
    try {
      const r = await req(s.base, 'GET', '/live/plan/local/job-1?share=GOOD');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ known: true, state: 'active', workflow: { id: 'wf1', name: 'Product Scraper' },
        steps: [{ action: 'goto', target: 'https://a.test/x' }], startedAt: '2026-01-01T10:00:00.000Z' });
      expect(JSON.stringify(r.body)).not.toMatch(/SECRET|params/);
    } finally { await s.close(); }
  });

  it('no / wrong / other-job credential is refused', async () => {
    const s = await serve();
    try {
      expect((await req(s.base, 'GET', '/live/plan/local/job-1')).status).toBe(401);
      expect((await req(s.base, 'GET', '/live/plan/local/job-1?share=BAD')).status).toBe(401);
      expect((await req(s.base, 'GET', '/live/plan/local/job-9?share=GOOD')).status).toBe(401);
    } finally { await s.close(); }
  });

  it('an unknown job or another user\'s job answers known:false with nothing in it', async () => {
    const s = await serve({ getJob: async () => job({ data: { userId: 'someone-else', steps: [{ action: 'goto' }] } }) });
    try {
      const r = await req(s.base, 'GET', '/live/plan/local/job-1?share=GOOD');
      expect(r.body).toEqual({ success: true, known: false, steps: [], workflow: null, startedAt: null, state: null });
    } finally { await s.close(); }
  });
});

describe('POST /live/restart', () => {
  it('a SHARE TOKEN cannot restart (it is view-only), and nothing is queued', async () => {
    const s = await serve();
    try {
      const r = await req(s.base, 'POST', '/live/restart/local/job-1?share=GOOD');
      expect(r.status).toBe(401);
      expect(s.deps.enqueue).not.toHaveBeenCalled();
      expect(s.deps.cancel).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('the owner restarts: the running job is stopped, the same work is queued, a new live link comes back', async () => {
    const s = await serve();
    try {
      const r = await req(s.base, 'POST', '/live/restart/local/job-1', { 'x-api-key': 'OWNER' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true, jobId: 'job-2', previousJobId: 'job-1', stopped: true,
        url: '/live/view/local/job-2?share=NEWTOKEN' });
      expect(s.deps.cancel).toHaveBeenCalledTimes(1);
      const data = (s.deps.enqueue as any).mock.calls[0][0];
      expect(data).toMatchObject({ userId: 'local', __origin: 'manual', __restartOf: 'job-1' });
    } finally { await s.close(); }
  });

  it('a finished run is restarted without a cancel', async () => {
    const s = await serve({ getJob: async () => job({ state: 'completed' }) });
    try {
      const r = await req(s.base, 'POST', '/live/restart/local/job-1', { 'x-api-key': 'OWNER' });
      expect(r.body.stopped).toBe(false);
      expect(s.deps.cancel).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('a gone run is 404, a single-node test is 409', async () => {
    const s = await serve();
    try {
      expect((await req(s.base, 'POST', '/live/restart/local/job-9', { 'x-api-key': 'OWNER' })).status).toBe(404);
    } finally { await s.close(); }
    const s2 = await serve({ getJob: async () => job({ data: { userId: 'local', steps: [], __runNode: true } }) });
    try {
      expect((await req(s2.base, 'POST', '/live/restart/local/job-1', { 'x-api-key': 'OWNER' })).status).toBe(409);
    } finally { await s2.close(); }
  });
});
