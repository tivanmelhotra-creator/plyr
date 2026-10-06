/**
 * job-screencast.test.ts — Task 4b
 *
 * JobScreencastHub (fan-out of a CDP screencast, view-only) and the
 * /live/frames route (same auth gate as /live/sse, server -> client only).
 * Everything is injected, so a fake CDP session stands in for Chromium.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { JobScreencastHub, TooManyViewersError, type PageLike } from '../../src/core/JobScreencast';
import { createLiveFramesRouter } from '../../src/Routes/live-frames.routes';

function fakePage() {
  const handlers: Record<string, (p: any) => void> = {};
  const sent: Array<[string, any]> = [];
  const cdp: any = {
    send: vi.fn(async (m: string, p?: any) => { sent.push([m, p]); return {}; }),
    on: vi.fn((e: string, fn: any) => { handlers[e] = fn; }),
    detach: vi.fn(async () => {}),
  };
  const page: any = { closed: false, isClosed() { return this.closed; }, context: () => ({ newCDPSession: vi.fn(async () => cdp) }) };
  const emit = (data: string, sessionId = 1) =>
    handlers['Page.screencastFrame']?.({ data, sessionId, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  return { page: page as PageLike & { closed: boolean }, cdp, sent, emit };
}

const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

afterEach(() => { vi.useRealTimers(); });

describe('JobScreencastHub', () => {
  it('starts nothing until someone watches, then attaches ONE session for many viewers', async () => {
    const f = fakePage();
    const getPage = vi.fn(() => f.page);
    const hub = new JobScreencastHub({ getPage, pollMs: 10_000, minIntervalMs: 0 });
    expect(hub.activeJobs()).toBe(0);
    expect(getPage).not.toHaveBeenCalled();

    const a: any[] = []; const b: any[] = [];
    hub.subscribe('u', 'j', { frame: x => a.push(x), status: () => {} });
    hub.subscribe('u', 'j', { frame: x => b.push(x), status: () => {} });
    await flush();
    expect(f.sent.filter(s => s[0] === 'Page.startScreencast')).toHaveLength(1);

    f.emit('AAA');
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0]).toMatchObject({ data: 'AAA', width: 800, height: 600 });
    await hub.shutdown();
  });

  it('acks every frame, even a throttled one (otherwise Chromium stalls)', async () => {
    const f = fakePage();
    let t = 1000;
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, minIntervalMs: 500, now: () => t });
    const got: any[] = [];
    hub.subscribe('u', 'j', { frame: x => got.push(x), status: () => {} });
    await flush();
    f.emit('1', 11); t += 10; f.emit('2', 12); t += 10; f.emit('3', 13);
    expect(got).toHaveLength(1); // two were throttled away
    const acks = f.sent.filter(s => s[0] === 'Page.screencastFrameAck').map(s => s[1].sessionId);
    expect(acks).toEqual([11, 12, 13]);
    t += 600; f.emit('4', 14);
    expect(got).toHaveLength(2);
    await hub.shutdown();
  });

  it('a late joiner immediately gets the current status and the last frame', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, minIntervalMs: 0 });
    hub.subscribe('u', 'j', { frame: () => {}, status: () => {} });
    await flush();
    f.emit('LAST');
    const st: string[] = []; const fr: string[] = [];
    hub.subscribe('u', 'j', { frame: x => fr.push(x.data), status: s => st.push(s) });
    expect(st).toEqual(['live']);
    expect(fr).toEqual(['LAST']);
    await hub.shutdown();
  });

  it('detaches the CDP session when the last viewer leaves', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, minIntervalMs: 0 });
    const u1 = hub.subscribe('u', 'j', { frame: () => {}, status: () => {} });
    const u2 = hub.subscribe('u', 'j', { frame: () => {}, status: () => {} });
    await flush();
    u1();
    expect(f.cdp.detach).not.toHaveBeenCalled();
    u2();
    await flush();
    expect(f.sent.some(s => s[0] === 'Page.stopScreencast')).toBe(true);
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    expect(hub.activeJobs()).toBe(0);
    u2(); // idempotent
  });

  it('caps viewers per job', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, maxViewersPerJob: 2 });
    hub.subscribe('u', 'j', { frame: () => {}, status: () => {} });
    hub.subscribe('u', 'j', { frame: () => {}, status: () => {} });
    expect(hub.hasRoom('u', 'j')).toBe(false);
    expect(() => hub.subscribe('u', 'j', { frame: () => {}, status: () => {} })).toThrow(TooManyViewersError);
    expect(hub.hasRoom('u', 'other')).toBe(true);
    await hub.shutdown();
  });

  it('is per (user, job): another user cannot join someone else s room by job id', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000 });
    hub.subscribe('alice', 'j', { frame: () => {}, status: () => {} });
    expect(hub.viewers('alice', 'j')).toBe(1);
    expect(hub.viewers('bob', 'j')).toBe(0);
    await hub.shutdown();
  });

  it('reports waiting while there is no page, then live, then ended when the page closes', async () => {
    vi.useFakeTimers();
    const f = fakePage();
    let page: any;
    const hub = new JobScreencastHub({ getPage: () => page, pollMs: 100, minIntervalMs: 0 });
    const st: string[] = [];
    hub.subscribe('u', 'j', { frame: () => {}, status: s => st.push(s) });
    await vi.advanceTimersByTimeAsync(250);
    expect(st).toEqual(['waiting']);
    page = f.page;
    await vi.advanceTimersByTimeAsync(250);
    expect(st).toEqual(['waiting', 'live']);
    f.page.closed = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(st).toEqual(['waiting', 'live', 'ended']);
    expect(f.cdp.detach).toHaveBeenCalled();
    await hub.shutdown();
  });

  it('re-attaches when the job moves to a new page', async () => {
    vi.useFakeTimers();
    const a = fakePage(); const b = fakePage();
    let page: any = a.page;
    const hub = new JobScreencastHub({ getPage: () => page, pollMs: 100, minIntervalMs: 0 });
    const got: string[] = [];
    hub.subscribe('u', 'j', { frame: x => got.push(x.data), status: () => {} });
    await vi.advanceTimersByTimeAsync(150);
    a.emit('from-a');
    page = b.page;
    await vi.advanceTimersByTimeAsync(250);
    expect(a.cdp.detach).toHaveBeenCalled();
    b.emit('from-b');
    expect(got).toEqual(['from-a', 'from-b']);
    await hub.shutdown();
  });

  it('a frame from a detached session is ignored', async () => {
    vi.useFakeTimers();
    const a = fakePage(); const b = fakePage();
    let page: any = a.page;
    const hub = new JobScreencastHub({ getPage: () => page, pollMs: 100, minIntervalMs: 0 });
    const got: string[] = [];
    hub.subscribe('u', 'j', { frame: x => got.push(x.data), status: () => {} });
    await vi.advanceTimersByTimeAsync(150);
    page = b.page;
    await vi.advanceTimersByTimeAsync(250);
    a.emit('stale');
    expect(got).toEqual([]);
    await hub.shutdown();
  });

  it('one throwing listener does not break the others', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, minIntervalMs: 0 });
    const ok: string[] = [];
    hub.subscribe('u', 'j', { frame: () => { throw new Error('boom'); }, status: () => { throw new Error('boom'); } });
    hub.subscribe('u', 'j', { frame: x => ok.push(x.data), status: () => {} });
    await flush();
    f.emit('X');
    expect(ok).toEqual(['X']);
    await hub.shutdown();
  });

  it('survives a page that dies during attach', async () => {
    const bad: any = { isClosed: () => false, context: () => ({ newCDPSession: async () => { throw new Error('Target closed'); } }) };
    const hub = new JobScreencastHub({ getPage: () => bad, pollMs: 10_000 });
    const st: string[] = [];
    hub.subscribe('u', 'j', { frame: () => {}, status: s => st.push(s) });
    await flush();
    expect(st).toEqual(['waiting']);
    await hub.shutdown();
  });
});

// ---- the route ---------------------------------------------------------

interface Served { url: string; close: () => Promise<void>; hub: JobScreencastHub; authCalls: any[] }

async function serve(authorize: (key: any, user: string, o: any) => Promise<{ ok: boolean; reason?: string }>, hub: JobScreencastHub): Promise<Served> {
  const authCalls: any[] = [];
  const app = express();
  app.use('/live/frames', createLiveFramesRouter({
    hub, heartbeatMs: 60_000,
    authorize: async (k, u, o) => { authCalls.push({ k, u, o }); return authorize(k, u, o); },
  }));
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, hub, authCalls, close: () => new Promise<void>(r => { (server as any).closeAllConnections?.(); server.close(() => r()); }) };
}

function readSse(url: string, headers: Record<string, string> = {}): Promise<{ status: number; ctype: string; text: () => string; abort: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      resolve({ status: res.statusCode || 0, ctype: String(res.headers['content-type'] || ''), text: () => buf, abort: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

describe('GET /live/frames/:userId/:jobId', () => {
  it('denies without a valid share token / key, and says why', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000 });
    const s = await serve(async () => ({ ok: false, reason: 'invalid_share' }), hub);
    const r = await readSse(`${s.url}/live/frames/u/j?share=bad`);
    expect(r.status).toBe(403);
    expect(hub.activeJobs()).toBe(0); // a rejected request never attaches CDP
    r.abort(); await s.close(); await hub.shutdown();
  });

  it('401 when the key is missing', async () => {
    const hub = new JobScreencastHub({ getPage: () => undefined, pollMs: 10_000 });
    const s = await serve(async () => ({ ok: false, reason: 'missing_api_key' }), hub);
    const r = await readSse(`${s.url}/live/frames/u/j`);
    expect(r.status).toBe(401);
    r.abort(); await s.close(); await hub.shutdown();
  });

  it('a throwing authorizer is a denial, not a 500', async () => {
    const hub = new JobScreencastHub({ getPage: () => undefined, pollMs: 10_000 });
    const s = await serve(async () => { throw new Error('redis down'); }, hub);
    const r = await readSse(`${s.url}/live/frames/u/j`);
    expect(r.status).toBe(403);
    r.abort(); await s.close(); await hub.shutdown();
  });

  it('passes the share token and the JOB ID to the gate (token is bound to the job)', async () => {
    const hub = new JobScreencastHub({ getPage: () => undefined, pollMs: 10_000 });
    const s = await serve(async () => ({ ok: true }), hub);
    const r = await readSse(`${s.url}/live/frames/alice/job-9?share=TOK`);
    expect(s.authCalls[0].u).toBe('alice');
    expect(s.authCalls[0].o).toEqual({ share: 'TOK', jobId: 'job-9' });
    r.abort(); await s.close(); await hub.shutdown();
  });

  it('streams status then frames as server-sent events', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, minIntervalMs: 0 });
    const s = await serve(async () => ({ ok: true }), hub);
    const r = await readSse(`${s.url}/live/frames/u/j?share=t`);
    expect(r.status).toBe(200);
    expect(r.ctype).toContain('text/event-stream');
    await new Promise(res => setTimeout(res, 100));
    f.emit('PIC');
    await new Promise(res => setTimeout(res, 100));
    const body = r.text();
    expect(body).toContain('event: status');
    expect(body).toContain('"status":"live"');
    expect(body).toContain('event: frame');
    expect(body).toContain('"data":"PIC"');
    r.abort();
    await new Promise(res => setTimeout(res, 150));
    expect(hub.viewers('u', 'j')).toBe(0); // client gone -> unsubscribed
    await s.close(); await hub.shutdown();
  });

  it('429 when the room is full', async () => {
    const f = fakePage();
    const hub = new JobScreencastHub({ getPage: () => f.page, pollMs: 10_000, maxViewersPerJob: 1 });
    const s = await serve(async () => ({ ok: true }), hub);
    const a = await readSse(`${s.url}/live/frames/u/j`);
    await new Promise(res => setTimeout(res, 80));
    const b = await readSse(`${s.url}/live/frames/u/j`);
    expect(b.status).toBe(429);
    a.abort(); b.abort(); await s.close(); await hub.shutdown();
  });

  it('is view-only: the route accepts no input (POST is not routed)', async () => {
    const hub = new JobScreencastHub({ getPage: () => undefined, pollMs: 10_000 });
    const s = await serve(async () => ({ ok: true }), hub);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${s.url}/live/frames/u/j`, { method: 'POST' }, res => { res.resume(); resolve(res.statusCode || 0); });
      req.on('error', reject); req.end('{"x":1}');
    });
    expect(status).toBe(404);
    await s.close(); await hub.shutdown();
  });
});
