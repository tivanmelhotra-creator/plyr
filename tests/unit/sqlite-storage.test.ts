/**
 * SQLite storage (core/SqliteStore + services/{workflow,execution}.repository
 * + services/storage import + cli/storage backup/restore), on temp files.
 * No Redis: the import is fed by a small in-memory SCAN/GET fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  openSqlite, migrate, schemaVersionOf, SCHEMA_VERSION, backupSqlite, inspectSqliteFile, getMeta,
} from '../../src/core/SqliteStore';
import { SqliteWorkflowRepository, RedisWorkflowRepository } from '../../src/services/workflow.repository';
import { ExecutionRepository, summarizeSteps } from '../../src/services/execution.repository';
import { importWorkflowsFromRedis, REDIS_IMPORT_MARKER } from '../../src/services/storage';
import { WorkflowService } from '../../src/services/workflow.service';
import { config } from '../../src/config';

let dir = '';
const tmp = (name: string) => path.join(dir, name);
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-sqlite-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('SqliteStore', () => {
  it('creates the file in WAL mode at the current schema version', () => {
    const db = openSqlite(tmp('a/b/plyr.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(schemaVersionOf(db)).toBe(SCHEMA_VERSION);
    db.close();
    expect(fs.existsSync(tmp('a/b/plyr.db'))).toBe(true);
  });

  it('migrate is idempotent', () => {
    const db = openSqlite(tmp('x.db'));
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('refuses a database from a newer build', () => {
    const raw = new Database(tmp('new.db'));
    raw.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => openSqlite(tmp('new.db'))).toThrow(/newer than this build/);
  });
});

function wf(id: string, version = 1, updatedAt = '2026-10-01T00:00:00.000Z') {
  return { id, userId: 'local', name: id, steps: [{ action: 'log' }], version, createdAt: updatedAt, updatedAt, active: true, liveBrowser: false };
}

describe('SqliteWorkflowRepository', () => {
  it('save / get / list / delete, scoped per user', async () => {
    const repo = new SqliteWorkflowRepository(openSqlite(tmp('w.db')));
    await repo.save(wf('wf_aaaaaaaaaaaaaaaa'));
    await repo.save({ ...wf('wf_bbbbbbbbbbbbbbbb'), userId: 'other' });
    expect((await repo.get('local', 'wf_aaaaaaaaaaaaaaaa'))?.name).toBe('wf_aaaaaaaaaaaaaaaa');
    expect(await repo.get('local', 'wf_bbbbbbbbbbbbbbbb')).toBeNull();
    expect((await repo.list('local')).map((w) => w.id)).toEqual(['wf_aaaaaaaaaaaaaaaa']);
    await repo.saveVersion('local', 'wf_aaaaaaaaaaaaaaaa', { version: 1, name: 'x', steps: [], savedAt: 't' });
    expect(await repo.delete('local', 'wf_aaaaaaaaaaaaaaaa')).toBe(true);
    expect(await repo.delete('local', 'wf_aaaaaaaaaaaaaaaa')).toBe(false);
    expect(await repo.listVersions('local', 'wf_aaaaaaaaaaaaaaaa')).toEqual([]);
  });

  it('versions come back newest first and trim keeps the newest N', async () => {
    const repo = new SqliteWorkflowRepository(openSqlite(tmp('v.db')));
    for (let v = 1; v <= 5; v++) await repo.saveVersion('local', 'wf_x', { version: v, name: `v${v}`, steps: [], savedAt: `t${v}` });
    await repo.trimVersions('local', 'wf_x', 2);
    expect((await repo.listVersions('local', 'wf_x')).map((s) => s.version)).toEqual([5, 4]);
    await repo.trimVersions('local', 'wf_x', 0); // 0 = keep all
    expect((await repo.listVersions('local', 'wf_x'))).toHaveLength(2);
  });

  it('WorkflowService keeps its rules on top of SQLite (version bump, state switch, history cap)', async () => {
    const svc = new WorkflowService(new SqliteWorkflowRepository(openSqlite(tmp('s.db'))));
    expect(svc.driver).toBe('sqlite');
    const created = await svc.create('local', { name: 'A', steps: [{ action: 'log' }] });
    expect(created.version).toBe(1);
    const upd = await svc.update('local', created.id, { name: 'B', steps: [] });
    expect(upd?.version).toBe(2);
    const st = await svc.setState('local', created.id, { active: false });
    expect(st?.version).toBe(2);
    expect(st?.active).toBe(false);
    // a design save never re-enables a workflow the user switched off
    expect((await svc.update('local', created.id, { name: 'C', steps: [] }))?.active).toBe(false);
    const max = config.WORKFLOW_MAX_VERSIONS;
    for (let i = 0; i < max + 3; i++) await svc.update('local', created.id, { name: `n${i}`, steps: [] });
    const versions = await svc.listVersions('local', created.id);
    expect(versions).toHaveLength(max);
    expect(versions[0].version).toBe(3 + max + 3 - 0);
    expect((await svc.list('local')).map((w) => w.id)).toEqual([created.id]);
    expect(await svc.remove('local', created.id)).toBe(true);
    expect(await svc.get('local', created.id)).toBeNull();
  });
});

describe('ExecutionRepository', () => {
  const rec = (jobId: string, finishedAt: string, extra: Record<string, unknown> = {}) => ({
    jobId, userId: 'local', status: 'success' as const, finishedAt, steps: [], ...extra,
  });

  it('records, lists newest first, filters by workflow and returns steps on get', () => {
    const repo = new ExecutionRepository(openSqlite(tmp('e.db')), { days: 0, maxRows: 0 });
    repo.record(rec('1', '2026-10-01T00:00:00Z', { workflowId: 'wf_a' }));
    repo.record(rec('2', '2026-10-02T00:00:00Z', {
      workflowId: 'wf_b', status: 'error', error: 'boom',
      steps: [{ step: 1, action: 'code', success: false, error: 'boom', outputSample: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] }],
    }));
    expect(repo.list('local').map((e) => e.jobId)).toEqual(['2', '1']);
    expect(repo.list('local', { workflowId: 'wf_a' }).map((e) => e.jobId)).toEqual(['1']);
    expect(repo.list('other')).toEqual([]);
    const two = repo.get('local', '2')!;
    expect(two.status).toBe('error');
    expect(two.error).toBe('boom');
    expect(two.steps[0].outputSample).toHaveLength(3); // capped sample
    expect(repo.list('local')[0].steps).toEqual([]);    // list rows omit steps
  });

  it('prunes by age and by row cap', () => {
    const repo = new ExecutionRepository(openSqlite(tmp('p.db')), { days: 7, maxRows: 2 });
    const now = new Date('2026-10-10T00:00:00Z');
    repo.record(rec('old', '2026-09-01T00:00:00Z'));
    for (const d of ['05', '06', '07']) repo.record(rec(d, `2026-10-${d}T00:00:00Z`));
    expect(repo.prune(now)).toBe(2);
    expect(repo.list('local').map((e) => e.jobId)).toEqual(['07', '06']);
  });

  it('summarizeSteps marks an oversized sample as truncated', () => {
    const big = [{ s: 'x'.repeat(5000) }];
    expect(summarizeSteps([{ step: 1, action: 'a', success: true, outputSample: big }])[0].outputSample).toEqual([{ truncated: true }]);
  });
});

/** Just enough of IORedis for the importer: SCAN with MATCH + GET. */
function fakeRedis(data: Record<string, string>) {
  const keys = Object.keys(data);
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return {
    async scan(_c: string, _m: string, pattern: string) { return ['0', keys.filter((k) => glob(pattern).test(k))]; },
    async get(k: string) { return data[k] ?? null; },
  } as never;
}

describe('Redis -> SQLite import', () => {
  it('copies workflows and versions once, and never touches Redis', async () => {
    const w = wf('wf_cccccccccccccccc', 2);
    const data: Record<string, string> = {
      'wf:meta:local:wf_cccccccccccccccc': JSON.stringify(w),
      'wf:ver:local:wf_cccccccccccccccc:1': JSON.stringify({ version: 1, name: 'v1', steps: [], savedAt: 'a' }),
      'wf:ver:local:wf_cccccccccccccccc:2': JSON.stringify({ version: 2, name: 'v2', steps: [], savedAt: 'b' }),
      'wf:meta:local:broken': '{not json',
    };
    const before = JSON.stringify(data);
    const db = openSqlite(tmp('i.db'));
    const rep = await importWorkflowsFromRedis(fakeRedis(data), db);
    expect(rep.workflows).toBe(1);
    expect(rep.versions).toBe(2);
    expect(rep.errors.length).toBe(1);
    expect(JSON.stringify(data)).toBe(before);
    expect(getMeta(db, REDIS_IMPORT_MARKER)).toBeTruthy();
    const repo = new SqliteWorkflowRepository(db);
    expect((await repo.get('local', 'wf_cccccccccccccccc'))?.version).toBe(2);
    // second boot: skipped, even after the user deletes everything
    await repo.delete('local', 'wf_cccccccccccccccc');
    expect((await importWorkflowsFromRedis(fakeRedis(data), db)).skipped).toBe('already imported');
    expect(await repo.get('local', 'wf_cccccccccccccccc')).toBeNull();
  });

  it('is skipped when the database already has workflows', async () => {
    const db = openSqlite(tmp('j.db'));
    await new SqliteWorkflowRepository(db).save(wf('wf_dddddddddddddddd'));
    const rep = await importWorkflowsFromRedis(fakeRedis({ 'wf:meta:local:wf_e': JSON.stringify(wf('wf_e')) }), db);
    expect(rep.skipped).toMatch(/already has workflows/);
  });
});

describe('backup / restore', () => {
  it('backup is a consistent, readable copy and refuses to overwrite', async () => {
    const db = openSqlite(tmp('live.db'));
    await new SqliteWorkflowRepository(db).save(wf('wf_ffffffffffffffff'));
    await backupSqlite(db, tmp('bk/one.db'));
    expect(inspectSqliteFile(tmp('bk/one.db'))).toEqual({ schemaVersion: SCHEMA_VERSION, workflows: 1, executions: 0 });
    await expect(backupSqlite(db, tmp('bk/one.db'))).rejects.toThrow(/already exists/);
    db.close();
  });

  it('inspectSqliteFile rejects a non-Plyr or corrupt file', () => {
    const raw = new Database(tmp('plain.db')); raw.exec('CREATE TABLE t (x)'); raw.close();
    expect(() => inspectSqliteFile(tmp('plain.db'))).toThrow(/not a Plyr database/);
    fs.writeFileSync(tmp('junk.db'), 'this is not sqlite');
    expect(() => inspectSqliteFile(tmp('junk.db'))).toThrow();
  });

  it('cli restore keeps the previous file aside and installs the backup', async () => {
    const live = tmp('data/plyr.db');
    const db = openSqlite(live);
    const repo = new SqliteWorkflowRepository(db);
    await repo.save(wf('wf_1111111111111111'));
    await backupSqlite(db, tmp('bk.db'));
    await repo.save(wf('wf_2222222222222222'));
    db.close();

    const prev = { path: config.SQLITE_PATH, port: config.PORT };
    (config as any).SQLITE_PATH = live;
    (config as any).PORT = 1; // nothing listens there -> "server stopped"
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { restore } = await import('../../src/cli/storage');
      expect(await restore(tmp('bk.db'))).toBe(0);
      expect(inspectSqliteFile(live).workflows).toBe(1);
      expect(fs.readdirSync(path.dirname(live)).some((f) => f.includes('.pre-restore-'))).toBe(true);
      expect(await restore(tmp('missing.db'))).toBe(1);
    } finally {
      (config as any).SQLITE_PATH = prev.path;
      (config as any).PORT = prev.port;
      vi.restoreAllMocks();
    }
  });
});

describe('Redis repository still satisfies the same contract', () => {
  it('is what WorkflowService wraps when given a plain connection', () => {
    const svc = new WorkflowService({ get: async () => null } as never);
    expect(svc.driver).toBe('redis');
    expect(new RedisWorkflowRepository({} as never).driver).toBe('redis');
  });
});
