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
import { inflateRawSync } from 'zlib';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-routes-'));

vi.mock('../../src/config', () => ({
  config: {
    IS_SINGLE_USER: false,
    WORKFLOW_MAX_VERSIONS: 20,
    WORKFLOW_STORAGE_ROOT: tmpRoot,
    WORKFLOW_ZIP_MAX_INPUT_BYTES: 512 * 1024 * 1024,
    WORKFLOW_ZIP_MAX_TOTAL_BYTES: 1024 * 1024 * 1024,
    WORKFLOW_ZIP_MAX_FILES: 10000,
    WORKFLOW_ZIP_MAX_ENTRIES: 10000,
    WORKFLOW_BULK_MAX_PATHS: 500,
  },
}));

// The Local Browser bridge. Records what it was handed.
const realChrome = {
  pathsGiven: [] as string[][],
  idsGiven: [] as string[],
  pending: true,
  /** What GET /browser/real/chooser would report: the waiting dialog, if any. */
  chooser: null as null | { id: string; multiple: boolean },
};
vi.mock('../../src/core/RealChrome', () => {
  class RealChromeError extends Error {}
  return {
    RealChromeError,
    RealChrome: {
      pendingChooser: vi.fn(() => (realChrome.chooser
        ? { id: realChrome.chooser.id, multiple: realChrome.chooser.multiple, accept: '', name: '', at: Date.now() }
        : null)),
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
  sessions: new Map<string, { pending: boolean; given: string[][]; multiple?: boolean }>(),
};
vi.mock('../../src/core/LiveSessions', () => ({
  liveBrowserSessions: {
    forUser: (userId: string) => {
      const s = live.sessions.get(userId);
      if (!s) return null;
      return {
        hasPendingFileChooser: () => s.pending,
        pendingFileChooserMultiple: () => (s.pending ? !!s.multiple : null),
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
  // The same limit index.ts gives the real app (MAX_REQUEST_BODY_SIZE), so a
  // 2 MB editor PUT reaches the ROUTE's own refusal rather than the parser's.
  app.use(express.json({ limit: '20mb' }));
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
  realChrome.chooser = null;
  live.sessions.clear();
});

const base = () => `/browser/workflow-files/${wfAlice}`;

function rawStoreZip(name: string, data: Buffer): Buffer {
  const n = Buffer.from(name, 'utf8');
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) { let c = i; for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[i] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30 + n.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(1 << 11, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26); n.copy(local, 30);
  const central = Buffer.alloc(46 + n.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(1 << 11, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0o100644 << 16 >>> 0, 38); n.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

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

/**
 * The editor's content pair — GET/PUT .../file — against the REAL storage.
 *
 * What the drawer's editor does is: open → GET → edit → PUT → close → reopen
 * → GET. The unit harness proves the view sends those requests; this proves
 * the bytes land where the contract says, `<root>/<user>/<workflowId>/<rel>`,
 * and come back unchanged. Disk is read directly for the write, so a PUT that
 * answered 200 and stored nothing would fail here.
 */
describe('workflow files: the editor\'s content pair (GET/PUT .../file) persists through WorkflowStorage', () => {
  const onDisk = (rel: string) => path.join(tmpRoot, 'alice', wfAlice, rel);

  it('open → GET (real content) → edit → PUT → reopen → GET: the text persisted, on disk and over HTTP', async () => {
    // A file the operator already has: seeded THROUGH the storage's own upload
    // route, not by hand, so the read is of a file the workspace knows. In a
    // folder of its own so the sibling check below sees only this test's work.
    let r = await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'ed' });
    expect(r.status).toBe(201);
    r = await request(app)
      .post(`${base()}/upload?path=ed&name=${encodeURIComponent('notes.txt')}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('first draft', 'utf8'));
    expect(r.status).toBe(201);

    // open → GET
    r = await request(app).get(`${base()}/file?path=ed/notes.txt`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, content: 'first draft' });
    expect(r.body.entry).toMatchObject({ name: 'notes.txt', path: 'ed/notes.txt', type: 'file', size: 11 });
    expect(JSON.stringify(r.body)).not.toContain(tmpRoot);

    // edit → PUT
    const edited = 'second draft\nwith a second line, and UTF-8: سلام — ✓';
    r = await request(app).put(`${base()}/file`).send({ path: 'ed/notes.txt', content: edited });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.entry).toMatchObject({ name: 'notes.txt', path: 'ed/notes.txt', type: 'file' });
    expect(r.body.entry.size).toBe(Buffer.byteLength(edited, 'utf8'));
    // The bytes are on disk, at exactly <root>/<user>/<workflowId>/<relativePath>.
    expect(await fs.readFile(onDisk('ed/notes.txt'), 'utf8')).toBe(edited);
    // No sibling was made: overwrite is IN PLACE, not "notes (2).txt".
    expect(await fs.readdir(onDisk('ed'))).toEqual(['notes.txt']);

    // close → reopen → GET: what was written is what is read.
    r = await request(app).get(`${base()}/file?path=ed/notes.txt`);
    expect(r.status).toBe(200);
    expect(r.body.content).toBe(edited);
    // And the tree agrees about the size.
    r = await request(app).get(`${base()}?path=ed`);
    expect(r.body.entries.find((e: { name: string }) => e.name === 'notes.txt').size).toBe(Buffer.byteLength(edited, 'utf8'));

    await request(app).delete(`${base()}?path=ed&recursive=1`);
  });

  it('New File → POST → open → GET (empty) → type → PUT → reopen → GET: a made file is a real, editable file', async () => {
    let r = await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'docs' });
    expect(r.status).toBe(201);
    r = await request(app).post(`${base()}/file`).send({ path: 'docs', name: 'todo.md' });
    expect(r.status).toBe(201);
    expect(r.body.entry).toMatchObject({ name: 'todo.md', path: 'docs/todo.md', type: 'file', size: 0 });
    // Genuinely empty on disk (not a one-byte newline).
    expect((await fs.stat(onDisk('docs/todo.md'))).size).toBe(0);

    r = await request(app).get(`${base()}/file?path=docs/todo.md`);
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('');

    r = await request(app).put(`${base()}/file`).send({ path: 'docs/todo.md', content: '# todo\n- [ ] one' });
    expect(r.status).toBe(200);
    expect(await fs.readFile(onDisk('docs/todo.md'), 'utf8')).toBe('# todo\n- [ ] one');

    r = await request(app).get(`${base()}/file?path=docs/todo.md`);
    expect(r.body.content).toBe('# todo\n- [ ] one');

    // Saving EMPTY is a real write of nothing, not a refusal.
    r = await request(app).put(`${base()}/file`).send({ path: 'docs/todo.md', content: '' });
    expect(r.status).toBe(200);
    expect((await fs.stat(onDisk('docs/todo.md'))).size).toBe(0);

    await request(app).delete(`${base()}?path=docs&recursive=1`);
  });

  it('PUT to a path with no file yet CREATES it at that relative path (the editor never names an absolute path)', async () => {
    const r = await request(app).put(`${base()}/file`).send({ path: 'fresh.txt', content: 'made by PUT' });
    expect(r.status).toBe(200);
    expect(await fs.readFile(onDisk('fresh.txt'), 'utf8')).toBe('made by PUT');
    await request(app).delete(`${base()}?path=fresh.txt`);
  });

  it('refuses what every other verb refuses: traversal, absolute, a folder, a stranger\'s workflow, a missing name', async () => {
    expect((await request(app).get(`${base()}/file?path=../secret`)).status).toBe(400);
    expect((await request(app).put(`${base()}/file`).send({ path: '../secret', content: 'x' })).status).toBe(400);
    expect((await request(app).put(`${base()}/file`).send({ path: '/etc/passwd', content: 'x' })).status).toBe(400);
    expect((await request(app).put(`${base()}/file`).send({ content: 'x' })).status).toBe(400);
    expect((await request(app).get(`${base()}/file?path=uploads`)).status).toBe(400); // a folder is not a file
    expect((await request(app).get(`${base()}/file?path=nope.txt`)).status).toBe(404);
    expect((await request(app).get(`/browser/workflow-files/${wfBob}/file?path=a.txt`)).status).toBe(404);
    expect((await request(app).put(`/browser/workflow-files/${wfBob}/file`).send({ path: 'a.txt', content: 'x' })).status).toBe(404);
    // Nothing of that landed anywhere.
    expect(await fs.readdir(tmpRoot).then((d) => d.sort())).toEqual(['alice'].concat(
      (await fs.readdir(tmpRoot)).includes('bob') ? ['bob'] : []).sort());
  });

  it('a symlink planted in the workspace is refused by both halves of the pair', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    const root = onDisk('');
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'), 'file');
    try {
      expect((await request(app).get(`${base()}/file?path=leak.txt`)).status).toBe(403);
      expect((await request(app).put(`${base()}/file`).send({ path: 'leak.txt', content: 'overwritten' })).status).toBe(403);
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    } finally {
      await fs.unlink(path.join(root, 'leak.txt'));
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('caps the editor at 2 MB in both directions, in words', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    let r = await request(app).put(`${base()}/file`).send({ path: 'big.txt', content: big });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/too much text/);
    await fs.writeFile(onDisk('huge.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    r = await request(app).get(`${base()}/file?path=huge.log`);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/too large to open/);
    await fs.unlink(onDisk('huge.log'));
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

describe('workflow files: /use refuses several files for a single-file page', () => {
  beforeEach(async () => {
    for (const n of ['a.txt', 'b.txt', 'c.txt']) {
      await request(app).post(`${base()}/upload?path=&name=${n}`).set('Content-Type', 'application/octet-stream').send(Buffer.from(n));
    }
  });

  it('Local Browser view: 409 with the one-file sentence when the dialog is not `multiple`; nothing is handed over', async () => {
    realChrome.chooser = { id: 'fc9', multiple: false };
    const r = await request(app).post(`${base()}/use`).send({ paths: ['a.txt', 'b.txt', 'c.txt'], chooserId: 'fc9' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ONE file/);
    expect(r.body.hint).toMatch(/Download or Delete/);
    expect(realChrome.pathsGiven).toEqual([]);
  });

  it('Local Browser view: all of them reach a `multiple` dialog, in the order picked', async () => {
    realChrome.chooser = { id: 'fc9', multiple: true };
    const r = await request(app).post(`${base()}/use`).send({ paths: ['c.txt', 'a.txt'], chooserId: 'fc9' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(realChrome.pathsGiven[0].map((p) => path.basename(p))).toEqual(['c.txt', 'a.txt']);
  });

  it('Local Browser view: one file is always fine, whatever the dialog takes', async () => {
    realChrome.chooser = { id: 'fc9', multiple: false };
    const r = await request(app).post(`${base()}/use`).send({ paths: ['b.txt'], chooserId: 'fc9' });
    expect(r.status).toBe(200);
    expect(realChrome.pathsGiven[0].map((p) => path.basename(p))).toEqual(['b.txt']);
  });

  it('canvas view: the live session is asked the same question', async () => {
    live.sessions.set('alice', { pending: true, given: [], multiple: false });
    let r = await request(app).post(`${base()}/use`).send({ paths: ['a.txt', 'b.txt'] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ONE file/);
    expect(live.sessions.get('alice')!.given).toEqual([]);

    live.sessions.set('alice', { pending: true, given: [], multiple: true });
    r = await request(app).post(`${base()}/use`).send({ paths: ['a.txt', 'b.txt'] });
    expect(r.status).toBe(200);
    expect(live.sessions.get('alice')!.given[0].map((p) => path.basename(p))).toEqual(['a.txt', 'b.txt']);
  });
});

/** Minimal ZIP reader: names + inflated contents, straight from the central directory. */
function readZip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** supertest hands binary bodies back as a Buffer when told to. */
const binary = (req: request.Test) => req.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('workflow files: /download gives the operator their own copy', () => {
  // Built ONCE: an upload of an existing name is kept as "name (2).ext", so a
  // per-test rebuild would grow the tree between tests.
  beforeAll(async () => {
    // A small tree: docs/{report.pdf, notes/ideas.md}, empty/, and one at the root.
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'docs' });
    await request(app).post(`${base()}/mkdir`).send({ path: 'docs', name: 'notes' });
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'empty' });
    await request(app).post(`${base()}/upload?path=docs&name=report.pdf`).set('Content-Type', 'application/octet-stream').send(Buffer.from('%PDF-1.4 report'));
    await request(app).post(`${base()}/upload?path=docs/notes&name=ideas.md`).set('Content-Type', 'application/octet-stream').send(Buffer.from('# ideas'));
    await request(app).post(`${base()}/upload?path=&name=${encodeURIComponent('گزارش.txt')}`).set('Content-Type', 'application/octet-stream').send(Buffer.from('سلام'));
  });
  afterAll(async () => {
    for (const p of ['docs', 'empty', 'گزارش.txt']) await request(app).delete(`${base()}?path=${encodeURIComponent(p)}`);
  });

  it('one file: as itself, named by Content-Disposition (UTF-8 form), with Content-Length', async () => {
    const r = await binary(request(app).get(`${base()}/download?path=docs/report.pdf`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-length']).toBe(String('%PDF-1.4 report'.length));
    expect(r.headers['content-disposition']).toContain('filename="report.pdf"');
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''report.pdf");
    expect(Buffer.from(r.body).toString()).toBe('%PDF-1.4 report');

    const fa = await binary(request(app).get(`${base()}/download?path=${encodeURIComponent('گزارش.txt')}`));
    expect(fa.status).toBe(200);
    expect(fa.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('گزارش.txt')}`);
    expect(Buffer.from(fa.body).toString()).toBe('سلام');
  });

  it('HEAD answers the same headers with no body (the client preflight)', async () => {
    const r = await request(app).head(`${base()}/download?path=docs/report.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('report.pdf');
    expect(r.headers['content-length']).toBe(String('%PDF-1.4 report'.length));
    const z = await request(app).head(`${base()}/download?path=docs`);
    expect(z.status).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    expect(z.headers['content-disposition']).toContain('docs.zip');
    const missing = await request(app).head(`${base()}/download?path=nope.txt`);
    expect(missing.status).toBe(404);
  });

  it('a folder: <name>.zip holding the tree UNDER a top-level folder of its own name, empty folders kept', async () => {
    const r = await binary(request(app).get(`${base()}/download?path=docs`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toContain('filename="docs.zip"');
    expect(r.headers['content-length']).toBeUndefined(); // streamed
    const entries = readZip(Buffer.from(r.body));
    expect(entries.map((e) => e.name)).toEqual(['docs/', 'docs/notes/', 'docs/notes/ideas.md', 'docs/report.pdf']);
    expect(entries.find((e) => e.name === 'docs/report.pdf')!.data.toString()).toBe('%PDF-1.4 report');
  });

  it('the root: <workflowId>.zip with the tree as the drawer shows it, system folders included', async () => {
    const r = await binary(request(app).get(`${base()}/download`));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain(`filename="${wfAlice}.zip"`);
    const names = readZip(Buffer.from(r.body)).map((e) => e.name);
    expect(names).toContain('docs/');
    expect(names).toContain('docs/notes/ideas.md');
    expect(names).toContain('empty/');
    expect(names).toContain('گزارش.txt');
    expect(names).toContain('uploads/');
    expect(names).toContain('downloads/');
  });

  it('POST with a picked SET: one file is sent as itself; several become one zip relative to the folder on screen', async () => {
    const one = await binary(request(app).post(`${base()}/download`).send({ paths: ['docs/report.pdf'], path: 'docs' }));
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toBe('application/octet-stream');
    expect(one.headers['content-disposition']).toContain('report.pdf');

    const several = await binary(request(app).post(`${base()}/download`).send({ paths: ['docs/report.pdf', 'docs/notes'], path: 'docs' }));
    expect(several.status).toBe(200);
    expect(several.headers['content-type']).toBe('application/zip');
    expect(several.headers['content-disposition']).toContain('filename="docs.zip"');
    expect(readZip(Buffer.from(several.body)).map((e) => e.name)).toEqual(['report.pdf', 'notes/', 'notes/ideas.md']);

    // From the root, with a name of the client's choosing.
    const named = await binary(request(app).post(`${base()}/download`).send({ paths: ['docs', 'گزارش.txt'], name: 'picked' }));
    expect(named.status).toBe(200);
    expect(named.headers['content-disposition']).toContain('filename="picked.zip"');
    expect(readZip(Buffer.from(named.body)).map((e) => e.name)).toEqual(['docs/', 'docs/notes/', 'docs/notes/ideas.md', 'docs/report.pdf', 'گزارش.txt']);
  });

  it('refuses before the first byte: no paths, a missing path, an escape, a stranger\'s workflow', async () => {
    expect((await request(app).post(`${base()}/download`).send({ paths: [] })).status).toBe(400);
    expect((await request(app).post(`${base()}/download`).send({ paths: ['docs/report.pdf', 'nope.txt'] })).status).toBe(404);
    expect((await request(app).get(`${base()}/download?path=../../etc`)).status).toBe(400);
    expect((await request(app).get(`${base()}/download?path=nope`)).status).toBe(404);
    expect((await request(app).get(`/browser/workflow-files/${wfBob}/download`)).status).toBe(404);
    const noId = await request(app).get('/browser/workflow-files//download');
    expect(noId.status).toBe(400);
    expect(noId.body.error).toMatch(/No workflow id/);
  });
});

describe('workflow files: utility operation routes', () => {
  async function upload(pathname: string, name: string, body: string | Buffer) {
    return request(app).post(`${base()}/upload?path=${encodeURIComponent(pathname)}&name=${encodeURIComponent(name)}`)
      .set('Content-Type', 'application/octet-stream').send(body);
  }

  it('moves one file, multiple files, and a folder through HTTP', async () => {
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'move-dest' });
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'move-folder' });
    await upload('', 'one.txt', 'one'); await upload('', 'two.txt', 'two');
    await upload('move-folder', 'nested.txt', 'nested');
    let r = await request(app).post(`${base()}/move`).send({ paths: ['one.txt', 'two.txt'], to: 'move-dest' });
    expect(r.status).toBe(200); expect(r.body.count).toBe(2);
    r = await request(app).post(`${base()}/move`).send({ paths: ['move-folder'], to: 'move-dest' });
    expect(r.status).toBe(200);
    expect((await request(app).get(`${base()}?path=move-dest/move-folder`)).body.entries.map((e: { name: string }) => e.name)).toContain('nested.txt');
  });

  it('rejects move conflicts and traversal without partial state', async () => {
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'conflict-dest' });
    await upload('', 'conflict.txt', 'source'); await upload('conflict-dest', 'conflict.txt', 'existing');
    expect((await request(app).post(`${base()}/move`).send({ paths: ['conflict.txt'], to: 'conflict-dest' })).status).toBe(409);
    expect((await request(app).get(`${base()}?path=conflict-dest`)).body.entries.map((e: { name: string }) => e.name)).toEqual(['conflict.txt']);
    expect((await request(app).post(`${base()}/move`).send({ paths: ['../outside'], to: '' })).status).toBe(400);
  });

  it('copies files and recursive folders, then duplicate names remain conflict-safe', async () => {
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'copy-dest' });
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'copy-tree' });
    await upload('copy-tree', 'deep.txt', 'deep'); await upload('', 'copy.txt', 'copy');
    let r = await request(app).post(`${base()}/copy`).send({ paths: ['copy-tree', 'copy.txt'], to: 'copy-dest' });
    expect(r.status).toBe(200); expect(r.body.count).toBe(2);
    r = await request(app).post(`${base()}/duplicate`).send({ path: 'copy.txt' });
    expect(r.status).toBe(201); expect(r.body.entry.name).toBe('copy copy.txt');
    expect((await request(app).get(`${base()}?path=copy-dest/copy-tree`)).body.entries.map((e: { name: string }) => e.name)).toContain('deep.txt');
  });

  it('compresses selected files and folders, numbers an existing archive, and extracts it', async () => {
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'archive-src' });
    await upload('archive-src', 'inside.txt', 'inside'); await upload('', 'archive-file.txt', 'file');
    let r = await request(app).post(`${base()}/compress`).send({ paths: ['archive-file.txt', 'archive-src'], name: 'bundle', path: '', to: '' });
    expect(r.status).toBe(201); expect(r.body.entry.path).toBe('bundle.zip');
    r = await request(app).post(`${base()}/compress`).send({ paths: ['archive-file.txt'], name: 'bundle', path: '', to: '' });
    expect(r.status).toBe(201); expect(r.body.entry.path).toBe('bundle (2).zip');
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'extract-target' });
    r = await request(app).post(`${base()}/extract`).send({ path: 'bundle.zip', into: 'extract-target' });
    expect(r.status).toBe(200); expect(r.body.files).toBeGreaterThan(0);
    expect((await request(app).get(`${base()}?path=extract-target/archive-src`)).status).toBe(200);
  });

  it('rejects unsafe archive entries and preserves the destination on conflict', async () => {
    let r = await upload('', 'unsafe.zip', rawStoreZip('../escape.txt', Buffer.from('escape')));
    expect(r.status).toBe(201);
    r = await request(app).post(`${base()}/extract`).send({ path: 'unsafe.zip', into: 'extract-target' });
    expect(r.status).toBe(400);
    await request(app).post(`${base()}/mkdir`).send({ path: '', name: 'extract-conflict-target' });
    await upload('extract-conflict-target', 'archive-file.txt', 'keep');
    const valid = await request(app).post(`${base()}/compress`).send({ paths: ['archive-file.txt'], name: 'conflict-archive', path: '', to: '' });
    expect(valid.status).toBe(201);
    r = await request(app).post(`${base()}/extract`).send({ path: 'conflict-archive.zip', into: 'extract-conflict-target' });
    expect(r.status).toBe(409);
    expect((await request(app).get(`${base()}?path=extract-conflict-target`)).body.entries.map((e: { name: string }) => e.name)).toEqual(['archive-file.txt']);
  });

  it('enforces an extraction file-count limit at the route boundary', async () => {
    const { config } = await import('../../src/config');
    const old = config.WORKFLOW_ZIP_MAX_FILES;
    (config as { WORKFLOW_ZIP_MAX_FILES: number }).WORKFLOW_ZIP_MAX_FILES = 0;
    try {
      await upload('', 'limited.zip', rawStoreZip('one.txt', Buffer.from('one')));
      expect((await request(app).post(`${base()}/extract`).send({ path: 'limited.zip', into: 'limited-target' })).status).toBe(413);
    } finally {
      (config as { WORKFLOW_ZIP_MAX_FILES: number }).WORKFLOW_ZIP_MAX_FILES = old;
    }
  });

  it('cannot access another workflow through the utility routes', async () => {
    await upload('', 'isolation.txt', 'alice');
    expect((await request(app).post(`/browser/workflow-files/${wfBob}/copy`).send({ paths: ['isolation.txt'], to: '' })).status).toBe(404);
    expect((await request(app).get(`/browser/workflow-files/${wfBob}?path=isolation.txt`)).status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE LOCAL BROWSER'S BINDING LIVES IN REDIS, NOT IN THE PROCESS (S16)
//
// REPORTED: after a restart the drawer said "not opened from a saved workflow"
// for a browser plainly opened from one. The binding was process memory; the
// Chrome profile on disk was not. These tests bind through the real route,
// then FORGET PROCESS MEMORY (as a restart or another pm2 worker would) and
// show the route still answers from the same Redis the workflow lives in.
// ════════════════════════════════════════════════════════════════════════════
describe('workflow files: the Local Browser binding survives a restart', () => {
  let binding: typeof import('../../src/core/WorkflowBinding');
  beforeAll(async () => { binding = await import('../../src/core/WorkflowBinding'); });
  beforeEach(async () => { await binding.bindRealChrome(null); binding.resetRealChromeBindingForTests(); });

  it('POST /bind {local} answers bound:true and GET /workflow-files-binding names it', async () => {
    const b = await request(app).post(`${base()}/bind`).send({ target: 'local' });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ success: true, target: 'local', workflowId: wfAlice, bound: true });
    const g = await request(app).get('/browser/workflow-files-binding');
    expect(g.status).toBe(200);
    expect(g.body.local).toEqual({ workflowId: wfAlice });
  });

  it('the record is in the SAME store as the workflow, under the fixed key', async () => {
    await request(app).post(`${base()}/bind`).send({ target: 'local' });
    const raw = await connection.get(binding.REAL_CHROME_BINDING_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ userId: 'alice', workflowId: wfAlice });
  });

  it('after the process forgets everything, GET still answers the bound workflow', async () => {
    await request(app).post(`${base()}/bind`).send({ target: 'local' });
    binding.resetRealChromeBindingForTests();           // pm2 restart / other worker
    expect(binding.realChromeWorkflow()).toBeNull();    // memory: nothing
    const g = await request(app).get('/browser/workflow-files-binding');
    expect(g.body.local).toEqual({ workflowId: wfAlice }); // route: the truth
  });

  it('a transfer on a fresh process files into the bound workflow', async () => {
    await request(app).post(`${base()}/bind`).send({ target: 'local' });
    binding.resetRealChromeBindingForTests();
    expect(await binding.realChromeWorkflowForTransfer()).toEqual({ userId: 'alice', workflowId: wfAlice });
  });

  it('a binding to a workflow that no longer exists is cleared, not handed out', async () => {
    await connection.set(binding.REAL_CHROME_BINDING_KEY, JSON.stringify({ userId: 'alice', workflowId: 'wf_gone' }));
    const g = await request(app).get('/browser/workflow-files-binding');
    expect(g.body.local).toBeNull();
    expect(await connection.get(binding.REAL_CHROME_BINDING_KEY)).toBeNull();
  });

  it("another user's binding is not named to this caller", async () => {
    await request(app).post(`/browser/workflow-files/${wfBob}/bind`).set('x-test-user', 'bob').send({ target: 'local' });
    const asBob = await request(app).get('/browser/workflow-files-binding').set('x-test-user', 'bob');
    expect(asBob.body.local).toEqual({ workflowId: wfBob });
    const asAlice = await request(app).get('/browser/workflow-files-binding');
    expect(asAlice.body.local).toBeNull();
  });

  it('a re-bind to another workflow replaces the first, durably', async () => {
    await request(app).post(`${base()}/bind`).send({ target: 'local' });
    await request(app).post(`/browser/workflow-files/${wfBob}/bind`).set('x-test-user', 'bob').send({ target: 'local' });
    binding.resetRealChromeBindingForTests();
    const g = await request(app).get('/browser/workflow-files-binding').set('x-test-user', 'bob');
    expect(g.body.local).toEqual({ workflowId: wfBob });
  });
});
