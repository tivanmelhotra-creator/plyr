/**
 * /browser/workflow-files/:workflowId — route-level tests.
 *
 * Real router, real WorkflowStorage on a temp directory, in-memory Redis stub
 * for WorkflowService (the same stub pattern as workflows.test.ts). The chooser
 * bridges (RealChrome, the live session) are faked so the `/use` hand-over can
 * be asserted without a browser: what matters here is WHICH path reaches
 * `setFiles`, and that it is one the server resolved.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-routes-'));

vi.mock('../../src/config', () => ({
  config: {
    IS_SINGLE_USER: false,
    WORKFLOW_MAX_VERSIONS: 20,
    WORKFLOW_STORAGE_ROOT: tmpRoot,
  },
}));

// The Local Browser bridge. Records what it was handed.
const realChrome = {
  pathsGiven: [] as string[][],
  idsGiven: [] as string[],
  pending: true,
};
vi.mock('../../src/core/RealChrome', () => {
  class RealChromeError extends Error {}
  return {
    RealChromeError,
    RealChrome: {
      acceptChooserPaths: vi.fn(async (id: string, paths: string[]) => {
        if (!realChrome.pending) throw new RealChromeError('The remote browser is not running, so no page is asking for a file.');
        realChrome.idsGiven.push(id);
        realChrome.pathsGiven.push(paths);
        return { count: paths.length };
      }),
    },
  };
});

// The canvas bridge: one fake live session per user.
const live = {
  sessions: new Map<string, { pending: boolean; given: string[][] }>(),
};
vi.mock('../../src/core/LiveSessions', () => ({
  liveBrowserSessions: {
    forUser: (userId: string) => {
      const s = live.sessions.get(userId);
      if (!s) return null;
      return {
        hasPendingFileChooser: () => s.pending,
        acceptFilePaths: async (paths: string[]) => { s.given.push(paths); s.pending = false; return { count: paths.length }; },
      };
    },
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
    async sadd(k: string, v: string) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k)!.add(String(v)); return 1; },
    async srem(k: string, v: string) { return sets.get(k)?.delete(String(v)) ? 1 : 0; },
    async smembers(k: string) { return Array.from(sets.get(k) ?? []); },
  };
}

let app: Express;
let wfAlice = '';
let wfBob = '';
let connection: ReturnType<typeof makeConnection>;

/** Pretend the auth middleware resolved this key owner. */
function asUser(userId: string) {
  return (req: express.Request & { apiKeyUserId?: string }, _res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-user']) req.apiKeyUserId = String(req.headers['x-test-user']);
    else req.apiKeyUserId = userId;
    next();
  };
}

beforeAll(async () => {
  const { createWorkflowFilesRoutes } = await import('../../src/Routes/workflow-files.routes');
  const { WorkflowService } = await import('../../src/services/workflow.service');
  connection = makeConnection();
  const svc = new WorkflowService(connection as never);
  wfAlice = (await svc.create('alice', { name: 'A', steps: [] })).id;
  wfBob = (await svc.create('bob', { name: 'B', steps: [] })).id;

  app = express();
  app.use(express.json());
  app.use(asUser('alice'));
  app.use('/', createWorkflowFilesRoutes({ connection: connection as never }));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  realChrome.pathsGiven = [];
  realChrome.idsGiven = [];
  realChrome.pending = true;
  live.sessions.clear();
});

const base = () => `/browser/workflow-files/${wfAlice}`;

/** Names in a listing WITHOUT the two system folders every workspace carries. */
const userNames = (r: request.Response) =>
  (r.body.entries as Array<{ name: string; system?: boolean }>)
    .filter((e) => !e.system)
    .map((e) => e.name);
const systemNames = (r: request.Response) =>
  (r.body.entries as Array<{ name: string; system?: boolean; type: string }>)
    .filter((e) => e.system)
    .map((e) => e.name)
    .sort();

describe('workflow files: CRUD over HTTP', () => {
  it('lists a fresh workspace: only the two SYSTEM folders uploads/ and downloads/', async () => {
    const r = await request(app).get(base());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, workflowId: wfAlice, path: '', parent: null });
    expect(systemNames(r)).toEqual(['downloads', 'uploads']);
    expect(userNames(r)).toEqual([]);
    for (const e of r.body.entries) expect(e.type).toBe('dir');
  });

  it('the system folders refuse rename and delete (they are the workflow contract)', async () => {
    for (const name of ['uploads', 'downloads']) {
      let r = await request(app).patch(`${base()}/rename`).send({ path: name, name: 'x' });
      expect(r.status, `rename ${name}`).toBe(400);
      r = await request(app).delete(`${base()}?path=${name}&recursive=1`);
      expect(r.status, `delete ${name}`).toBe(400);
    }
    const r = await request(app).get(base());
    expect(systemNames(r)).toEqual(['downloads', 'uploads']);
  });

  it('creates folders, uploads, renames, lists nested, deletes', async () => {
    let r = await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'assets' });
    expect(r.status).toBe(201);
    expect(r.body.entry).toMatchObject({ name: 'assets', path: 'assets', type: 'dir' });

    r = await request(app)
      .post(`${base()}/upload?path=assets&name=${encodeURIComponent('pic.png')}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('PNGDATA'));
    expect(r.status).toBe(201);
    expect(r.body.entry).toMatchObject({ name: 'pic.png', path: 'assets/pic.png', type: 'file', size: 7 });

    r = await request(app).get(`${base()}?path=assets`);
    expect(r.status).toBe(200);
    expect(r.body.parent).toBe('');
    expect(r.body.entries.map((e: { name: string }) => e.name)).toEqual(['pic.png']);
    // No absolute path anywhere in a listing.
    expect(JSON.stringify(r.body)).not.toContain(tmpRoot);

    r = await request(app).patch(`${base()}/rename`).send({ path: 'assets/pic.png', name: 'logo.png' });
    expect(r.status).toBe(200);
    expect(r.body.entry.path).toBe('assets/logo.png');

    r = await request(app).delete(`${base()}?path=assets`);
    expect(r.status).toBe(409); // not empty, no recursive flag

    r = await request(app).delete(`${base()}?path=assets&recursive=1`);
    expect(r.status).toBe(200);
    r = await request(app).get(base());
    expect(userNames(r)).toEqual([]);
    expect(systemNames(r)).toEqual(['downloads', 'uploads']);
  });

  it('refuses an empty upload and a bad name', async () => {
    let r = await request(app).post(`${base()}/upload?path=&name=x.txt`).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(0));
    expect(r.status).toBe(400);
    r = await request(app).post(`${base()}/mkdir`).send({ path: '', name: '../evil' });
    expect(r.status).toBe(400);
    r = await request(app).post(`${base()}/mkdir`).send({ path: '', name: '.git' });
    expect(r.status).toBe(400);
  });
});

describe('workflow files: the boundary over HTTP', () => {
  it('rejects traversal, absolute and encoded paths with 4xx and touches nothing', async () => {
    for (const bad of ['..', '../', '../../etc/passwd', '%2e%2e%2f', '/etc/passwd', '/tmp', 'C:\\Windows']) {
      const r = await request(app).get(`${base()}?path=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBeGreaterThanOrEqual(400);
      expect(r.status, bad).toBeLessThan(500);
      expect(r.body.success).toBe(false);
    }
  });

  it('rejects an invalid workflow id before touching Redis or disk', async () => {
    const r = await request(app).get('/browser/workflow-files/..%2F..%2Fx');
    expect([400, 404]).toContain(r.status);
  });

  // REGRESSION — the `endpoint not found` incident. A view opened without
  // ?workflowId= built `/browser/workflow-files//mkdir` (empty id); Express's
  // `:workflowId` cannot match an empty segment, so the request fell through to
  // the app-wide 404 and the operator read "Endpoint not found" for a problem
  // that was really "no workflow". The router must now answer these itself,
  // with a 400 that names the real cause, for EVERY verb the UI sends.
  it('an EMPTY workflow id (two slashes) is a 400 naming the cause, never the generic 404', async () => {
    const generic404 = express();
    generic404.use(express.json());
    generic404.use(asUser('alice'));
    const { createWorkflowFilesRoutes } = await import('../../src/Routes/workflow-files.routes');
    generic404.use('/', createWorkflowFilesRoutes({ connection: connection as never }));
    generic404.use((_req, res) => { res.status(404).json({ success: false, error: 'Endpoint not found' }); });

    const shapes: Array<[string, string, object | Buffer | undefined]> = [
      ['get',    '/browser/workflow-files/?path=', undefined],
      ['get',    '/browser/workflow-files//?path=', undefined],
      ['post',   '/browser/workflow-files//mkdir', { path: '', name: 'x' }],
      ['post',   '/browser/workflow-files//file', { path: '', name: 'x.txt' }],
      ['post',   '/browser/workflow-files//upload?path=uploads&name=x.txt', Buffer.from('x')],
      ['patch',  '/browser/workflow-files//rename', { path: 'a', name: 'b' }],
      ['delete', '/browser/workflow-files//?path=a', undefined],
      ['post',   '/browser/workflow-files//use', { path: 'a' }],
      ['post',   '/browser/workflow-files//bind', { target: 'local' }],
    ];
    for (const [method, url, body] of shapes) {
      let req = (request(generic404) as unknown as Record<string, (u: string) => request.Test>)[method](url);
      if (Buffer.isBuffer(body)) req = req.set('content-type', 'application/octet-stream').send(body);
      else if (body) req = req.send(body);
      const r = await req;
      expect(r.status, `${method} ${url}`).toBe(400);
      expect(r.body.success, `${method} ${url}`).toBe(false);
      expect(r.body.error, `${method} ${url}`).not.toMatch(/endpoint not found/i);
      expect(r.body.error, `${method} ${url}`).toMatch(/workflow id/i);
      expect(r.body.hint, `${method} ${url}`).toMatch(/saved workflow|save the workflow/i);
    }
  });

  it('a REAL id is never mistaken for a missing one', async () => {
    const r = await request(app).get(`${base()}?path=`);
    expect(r.status).toBe(200);
    const m = await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'real-id-ok' });
    expect(m.status).toBe(201);
  });

  it('cannot see another user\'s workflow even with its exact id (404, not the files)', async () => {
    // Bob puts a file in his workflow.
    let r = await request(app)
      .post(`/browser/workflow-files/${wfBob}/upload?path=&name=bob.txt`)
      .set('x-test-user', 'bob')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('B'));
    expect(r.status).toBe(201);
    // Alice knows Bob's id.
    r = await request(app).get(`/browser/workflow-files/${wfBob}`);
    expect(r.status).toBe(404);
    r = await request(app).delete(`/browser/workflow-files/${wfBob}?path=bob.txt`);
    expect(r.status).toBe(404);
    r = await request(app).post(`/browser/workflow-files/${wfBob}/use`).send({ path: 'bob.txt', chooserId: 'fc1' });
    expect(r.status).toBe(404);
    expect(realChrome.pathsGiven).toEqual([]);
    // Bob still has his file.
    r = await request(app).get(`/browser/workflow-files/${wfBob}`).set('x-test-user', 'bob');
    expect(userNames(r)).toEqual(['bob.txt']);
  });

  it('a non-admin key may not name another userId in the query', async () => {
    const r = await request(app).get(`/browser/workflow-files/${wfBob}?userId=bob`);
    expect(r.status).toBe(403);
  });

  it('an admin key may act for an explicit userId', async () => {
    const r = await request(app).get(`/browser/workflow-files/${wfBob}?userId=bob`).set('x-test-user', 'env_root');
    expect(r.status).toBe(200);
    expect(userNames(r)).toEqual(['bob.txt']);
  });

  it('refuses a symlink planted in the workspace through every verb', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-outside-'));
    await fs.writeFile(path.join(outside, 'secret'), 's');
    const root = path.join(tmpRoot, 'alice', wfAlice);
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, 'escape'), 'dir');
    try {
      expect((await request(app).get(`${base()}?path=escape`)).status).toBe(403);
      expect((await request(app).post(`${base()}/use`).send({ path: 'escape/secret', chooserId: 'fc1' })).status).toBe(403);
      expect((await request(app).delete(`${base()}?path=escape/secret`)).status).toBe(403);
      expect(realChrome.pathsGiven).toEqual([]);
      expect(await fs.readdir(outside)).toEqual(['secret']);
      // And the listing hides it.
      const r = await request(app).get(base());
      expect(r.body.entries.find((e: { name: string }) => e.name === 'escape')).toBeUndefined();
    } finally {
      await fs.unlink(path.join(root, 'escape'));
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('workflow files: /use hands the SERVER-resolved file to the chooser', () => {
  beforeEach(async () => {
    await request(app).post(`${base()}/upload?path=&name=doc.pdf`).set('Content-Type', 'application/octet-stream').send(Buffer.from('%PDF'));
  });

  it('Local Browser view: names the chooser id and passes a canonical path inside the workflow root', async () => {
    const r = await request(app).post(`${base()}/use`).send({ path: 'doc.pdf', chooserId: 'fc7' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, name: 'doc.pdf', count: 1 });
    // The response never carries the location.
    expect(JSON.stringify(r.body)).not.toContain(tmpRoot);
    expect(realChrome.idsGiven).toEqual(['fc7']);
    expect(realChrome.pathsGiven).toHaveLength(1);
    const given = realChrome.pathsGiven[0][0];
    expect(given).toBe(await fs.realpath(path.join(tmpRoot, 'alice', wfAlice, 'doc.pdf')));
  });

  it('refuses to select a folder', async () => {
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'd' });
    const r = await request(app).post(`${base()}/use`).send({ path: 'd', chooserId: 'fc7' });
    expect(r.status).toBe(400);
    expect(realChrome.pathsGiven).toEqual([]);
  });

  it('reports 503 when the Local Browser is not running', async () => {
    realChrome.pending = false;
    const r = await request(app).post(`${base()}/use`).send({ path: 'doc.pdf', chooserId: 'fc7' });
    expect(r.status).toBe(503);
  });

  it('canvas view: routes to the caller\'s live session when there is no chooserId', async () => {
    live.sessions.set('alice', { pending: true, given: [] });
    const r = await request(app).post(`${base()}/use`).send({ path: 'doc.pdf' });
    expect(r.status).toBe(200);
    expect(live.sessions.get('alice')!.given[0][0]).toContain(path.join('alice', wfAlice, 'doc.pdf'));
    expect(realChrome.pathsGiven).toEqual([]);
  });

  it('canvas view: 409 when there is no live session or no pending dialog', async () => {
    let r = await request(app).post(`${base()}/use`).send({ path: 'doc.pdf' });
    expect(r.status).toBe(409);
    live.sessions.set('alice', { pending: false, given: [] });
    r = await request(app).post(`${base()}/use`).send({ path: 'doc.pdf' });
    expect(r.status).toBe(409);
  });
});
