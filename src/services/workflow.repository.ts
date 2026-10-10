/**
 * WorkflowRepository — raw persistence for saved workflows and their version
 * snapshots. No business rules live here (version bumps, defaults, history
 * trimming policy are WorkflowService's job); a repository only stores and
 * returns records, so both drivers stay interchangeable and small.
 *
 * Drivers:
 *   RedisWorkflowRepository  — the original key layout (utils/redis-keys.ts).
 *   SqliteWorkflowRepository — core/SqliteStore.ts, the default
 *                              (STORAGE_DRIVER=sqlite).
 */
import type IORedis from 'ioredis';
import type { Workflow, WorkflowVersionSnapshot } from '../types';
import type { SqliteDb } from '../core/SqliteStore';
import {
  getWorkflowKey,
  getUserWorkflowsKey,
  getWorkflowVersionKey,
  getWorkflowVersionIndexKey,
} from '../utils/redis-keys';

export interface WorkflowRepository {
  readonly driver: 'redis' | 'sqlite';
  get(userId: string, workflowId: string): Promise<Workflow | null>;
  list(userId: string): Promise<Workflow[]>;
  /** Insert or replace the current record. */
  save(wf: Workflow): Promise<void>;
  /** Remove the record AND its version history. True if it existed. */
  delete(userId: string, workflowId: string): Promise<boolean>;
  saveVersion(userId: string, workflowId: string, snap: WorkflowVersionSnapshot): Promise<void>;
  /** Newest first. */
  listVersions(userId: string, workflowId: string): Promise<WorkflowVersionSnapshot[]>;
  /**
   * Keep only the newest `max` AUTO versions (max <= 0 keeps all). Manual
   * snapshots are never removed here: they exist only because the user asked
   * for them, so the autosave history limit must not eat them.
   */
  trimVersions(userId: string, workflowId: string, max: number): Promise<void>;
  /** One snapshot by version number, or null. */
  getVersion(userId: string, workflowId: string, version: number): Promise<WorkflowVersionSnapshot | null>;
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
export class RedisWorkflowRepository implements WorkflowRepository {
  readonly driver = 'redis' as const;
  constructor(private readonly redis: IORedis) {}

  async get(userId: string, workflowId: string): Promise<Workflow | null> {
    return parse<Workflow>(await this.redis.get(getWorkflowKey(userId, workflowId)));
  }

  async list(userId: string): Promise<Workflow[]> {
    const ids = await this.redis.smembers(getUserWorkflowsKey(userId));
    const out: Workflow[] = [];
    for (const id of ids) {
      const wf = await this.get(userId, id);
      if (wf) out.push(wf);
      else await this.redis.srem(getUserWorkflowsKey(userId), id); // prune dangling id
    }
    return out;
  }

  async save(wf: Workflow): Promise<void> {
    await this.redis.set(getWorkflowKey(wf.userId, wf.id), JSON.stringify(wf));
    await this.redis.sadd(getUserWorkflowsKey(wf.userId), wf.id);
  }

  async delete(userId: string, workflowId: string): Promise<boolean> {
    const existed = await this.redis.exists(getWorkflowKey(userId, workflowId));
    const idxKey = getWorkflowVersionIndexKey(userId, workflowId);
    for (const v of await this.redis.smembers(idxKey)) {
      await this.redis.del(getWorkflowVersionKey(userId, workflowId, parseInt(v, 10)));
    }
    await this.redis.del(idxKey);
    await this.redis.del(getWorkflowKey(userId, workflowId));
    await this.redis.srem(getUserWorkflowsKey(userId), workflowId);
    return existed > 0;
  }

  async saveVersion(userId: string, workflowId: string, snap: WorkflowVersionSnapshot): Promise<void> {
    await this.redis.set(getWorkflowVersionKey(userId, workflowId, snap.version), JSON.stringify(snap));
    await this.redis.sadd(getWorkflowVersionIndexKey(userId, workflowId), String(snap.version));
  }

  private async versionNumbers(userId: string, workflowId: string): Promise<number[]> {
    return (await this.redis.smembers(getWorkflowVersionIndexKey(userId, workflowId)))
      .map((v) => parseInt(v, 10))
      .filter((n) => Number.isFinite(n));
  }

  async listVersions(userId: string, workflowId: string): Promise<WorkflowVersionSnapshot[]> {
    const versions = (await this.versionNumbers(userId, workflowId)).sort((a, b) => b - a);
    const out: WorkflowVersionSnapshot[] = [];
    for (const v of versions) {
      const snap = parse<WorkflowVersionSnapshot>(await this.redis.get(getWorkflowVersionKey(userId, workflowId, v)));
      if (snap) out.push(snap);
    }
    return out;
  }

  async getVersion(userId: string, workflowId: string, version: number): Promise<WorkflowVersionSnapshot | null> {
    return parse<WorkflowVersionSnapshot>(await this.redis.get(getWorkflowVersionKey(userId, workflowId, version)));
  }

  async trimVersions(userId: string, workflowId: string, max: number): Promise<void> {
    if (max <= 0) return;
    const all = await this.listVersions(userId, workflowId); // newest first
    const autos = all.filter((s) => s.kind !== 'manual').map((s) => s.version).sort((a, b) => a - b);
    const excess = autos.length - max;
    if (excess <= 0) return;
    const idxKey = getWorkflowVersionIndexKey(userId, workflowId);
    for (const v of autos.slice(0, excess)) {
      await this.redis.del(getWorkflowVersionKey(userId, workflowId, v));
      await this.redis.srem(idxKey, String(v));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export class SqliteWorkflowRepository implements WorkflowRepository {
  readonly driver = 'sqlite' as const;
  constructor(private readonly db: SqliteDb) {}

  async get(userId: string, workflowId: string): Promise<Workflow | null> {
    const row = this.db.prepare('SELECT data FROM workflows WHERE user_id = ? AND id = ?')
      .get(userId, workflowId) as { data: string } | undefined;
    return parse<Workflow>(row?.data);
  }

  async list(userId: string): Promise<Workflow[]> {
    const rows = this.db.prepare('SELECT data FROM workflows WHERE user_id = ?').all(userId) as { data: string }[];
    return rows.map((r) => parse<Workflow>(r.data)).filter((w): w is Workflow => !!w);
  }

  async save(wf: Workflow): Promise<void> {
    this.db.prepare(`
      INSERT INTO workflows (user_id, id, version, updated_at, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        version = excluded.version, updated_at = excluded.updated_at, data = excluded.data
    `).run(wf.userId, wf.id, wf.version, wf.updatedAt, JSON.stringify(wf));
  }

  async delete(userId: string, workflowId: string): Promise<boolean> {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_versions WHERE user_id = ? AND workflow_id = ?').run(userId, workflowId);
      return this.db.prepare('DELETE FROM workflows WHERE user_id = ? AND id = ?').run(userId, workflowId).changes > 0;
    })();
  }

  async saveVersion(userId: string, workflowId: string, snap: WorkflowVersionSnapshot): Promise<void> {
    this.db.prepare(`
      INSERT INTO workflow_versions (user_id, workflow_id, version, saved_at, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, workflow_id, version) DO UPDATE SET saved_at = excluded.saved_at, data = excluded.data
    `).run(userId, workflowId, snap.version, snap.savedAt || '', JSON.stringify(snap));
  }

  async listVersions(userId: string, workflowId: string): Promise<WorkflowVersionSnapshot[]> {
    const rows = this.db.prepare(
      'SELECT data FROM workflow_versions WHERE user_id = ? AND workflow_id = ? ORDER BY version DESC'
    ).all(userId, workflowId) as { data: string }[];
    return rows.map((r) => parse<WorkflowVersionSnapshot>(r.data)).filter((s): s is WorkflowVersionSnapshot => !!s);
  }

  async getVersion(userId: string, workflowId: string, version: number): Promise<WorkflowVersionSnapshot | null> {
    const row = this.db.prepare(
      'SELECT data FROM workflow_versions WHERE user_id = ? AND workflow_id = ? AND version = ?'
    ).get(userId, workflowId, version) as { data: string } | undefined;
    return parse<WorkflowVersionSnapshot>(row?.data);
  }

  async trimVersions(userId: string, workflowId: string, max: number): Promise<void> {
    if (max <= 0) return;
    // Only auto entries count toward (and are removed by) the history limit.
    this.db.prepare(`
      DELETE FROM workflow_versions WHERE user_id = ? AND workflow_id = ? AND COALESCE(json_extract(data, '$.kind'), 'auto') = 'auto' AND version NOT IN (
        SELECT version FROM workflow_versions WHERE user_id = ? AND workflow_id = ? AND COALESCE(json_extract(data, '$.kind'), 'auto') = 'auto'
        ORDER BY version DESC LIMIT ?
      )
    `).run(userId, workflowId, userId, workflowId, max);
  }

  /** Used by the boot migration: does this DB hold any workflow at all? */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM workflows').get() as { n: number }).n;
  }
}
