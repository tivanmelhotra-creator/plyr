/**
 * Storage wiring: picks the workflow repository from STORAGE_DRIVER and owns
 * the one-time Redis -> SQLite import.
 *
 *   STORAGE_DRIVER=sqlite (default)  workflows + versions + execution history
 *                                    in SQLITE_PATH (WAL)
 *   STORAGE_DRIVER=redis             the previous behaviour; no execution history
 *
 * Boot migration: if the SQLite file holds no workflow yet AND the import has
 * not been recorded as done, every `wf:meta:*` record (and its `wf:ver:*`
 * snapshots) is copied from Redis. Redis is NOT modified, so switching back to
 * STORAGE_DRIVER=redis still finds everything that existed before the switch.
 * A marker in `meta` makes this run once per database file, even if the user
 * later deletes all their workflows.
 */
import type IORedis from 'ioredis';
import { config } from '../config';
import type { Workflow, WorkflowVersionSnapshot } from '../types';
import { getMeta, setMeta, sharedSqlite, type SqliteDb } from '../core/SqliteStore';
import {
  RedisWorkflowRepository,
  SqliteWorkflowRepository,
  type WorkflowRepository,
} from './workflow.repository';
import { ExecutionRepository } from './execution.repository';

export interface StorageHandles {
  driver: 'sqlite' | 'redis';
  workflows: WorkflowRepository;
  executions: ExecutionRepository | null;
  db: SqliteDb | null;
}

let handles: StorageHandles | null = null;

/** Build (once per process) the repositories the routes and the worker share. */
export function getStorage(redis: IORedis): StorageHandles {
  if (handles) return handles;
  if (config.STORAGE_DRIVER === 'redis') {
    handles = { driver: 'redis', workflows: new RedisWorkflowRepository(redis), executions: null, db: null };
    return handles;
  }
  const db = sharedSqlite(config.SQLITE_PATH);
  handles = {
    driver: 'sqlite',
    workflows: new SqliteWorkflowRepository(db),
    executions: new ExecutionRepository(db, {
      days: config.EXECUTION_RETENTION_DAYS,
      maxRows: config.EXECUTION_MAX_ROWS,
    }),
    db,
  };
  return handles;
}

/**
 * The workflow store a route module should use. Only an explicit
 * `STORAGE_DRIVER=sqlite` opens the database; anything else (including a
 * mocked config in route tests) keeps the given Redis connection.
 */
export function workflowStoreFor(redis: IORedis): IORedis | WorkflowRepository {
  return config.STORAGE_DRIVER === 'sqlite' ? getStorage(redis).workflows : redis;
}

/** The execution history, or null when the driver has none. */
export function executionsFor(redis: IORedis): ExecutionRepository | null {
  return config.STORAGE_DRIVER === 'sqlite' ? getStorage(redis).executions : null;
}

/** Tests only. */
export function resetStorageForTests(): void {
  handles = null;
}

export const REDIS_IMPORT_MARKER = 'redis_import_done';

export interface ImportReport {
  skipped?: string;
  workflows: number;
  versions: number;
  errors: string[];
}

/** SCAN, not KEYS: never block a live Redis. */
async function scanKeys(redis: IORedis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

export async function importWorkflowsFromRedis(redis: IORedis, db: SqliteDb): Promise<ImportReport> {
  const report: ImportReport = { workflows: 0, versions: 0, errors: [] };
  if (getMeta(db, REDIS_IMPORT_MARKER)) return { ...report, skipped: 'already imported' };
  const target = new SqliteWorkflowRepository(db);
  if (target.count() > 0) {
    setMeta(db, REDIS_IMPORT_MARKER, new Date().toISOString());
    return { ...report, skipped: 'database already has workflows' };
  }

  const metaKeys = await scanKeys(redis, 'wf:meta:*');
  for (const key of metaKeys) {
    try {
      const raw = await redis.get(key);
      if (!raw) continue;
      const wf = JSON.parse(raw) as Workflow;
      if (!wf || typeof wf.id !== 'string' || typeof wf.userId !== 'string') {
        report.errors.push(`${key}: not a workflow record`);
        continue;
      }
      await target.save(wf);
      report.workflows++;
      const verKeys = await scanKeys(redis, `wf:ver:${wf.userId}:${wf.id}:*`);
      for (const vk of verKeys) {
        const vraw = await redis.get(vk);
        if (!vraw) continue;
        try {
          const snap = JSON.parse(vraw) as WorkflowVersionSnapshot;
          if (typeof snap.version !== 'number') continue;
          await target.saveVersion(wf.userId, wf.id, snap);
          report.versions++;
        } catch (e) {
          report.errors.push(`${vk}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      report.errors.push(`${key}: ${(e as Error).message}`);
    }
  }
  setMeta(db, REDIS_IMPORT_MARKER, new Date().toISOString());
  return report;
}

export const LEGACY_AUTOSAVE_PRUNE_MARKER = 'legacy_autosave_pruned';

/**
 * One-time cleanup of the per-edit autosave history older builds wrote (one
 * row per edit). Autosave no longer writes history, so these rows are dead
 * weight that the Versions list would otherwise offer as restore points.
 *
 * Kept, always: every `manual` row, every `initial` row, and for a workflow
 * without an `initial` row its OLDEST row (the creation snapshot, or the
 * oldest state the old history limit left), re-tagged `initial`. Removed:
 * every other non-manual row. One transaction;
 * a marker in `meta` makes it run once per database file.
 */
export function pruneLegacyAutosavesOnce(db: SqliteDb): number {
  if (getMeta(db, LEGACY_AUTOSAVE_PRUNE_MARKER)) return 0;
  let removed = 0;
  db.transaction(() => {
    const kindOf = "COALESCE(json_extract(data, '$.kind'), 'auto')";
    // Tag the legacy creation snapshot of workflows that have no `initial` row.
    db.prepare(`
      UPDATE workflow_versions SET data = json_set(data, '$.kind', 'initial')
      WHERE ${kindOf} = 'auto' AND version = (
        SELECT MIN(w3.version) FROM workflow_versions w3 WHERE w3.user_id = workflow_versions.user_id
          AND w3.workflow_id = workflow_versions.workflow_id
          AND COALESCE(json_extract(w3.data, '$.kind'), 'auto') = 'auto')
      AND NOT EXISTS (
        SELECT 1 FROM workflow_versions w2 WHERE w2.user_id = workflow_versions.user_id
          AND w2.workflow_id = workflow_versions.workflow_id
          AND COALESCE(json_extract(w2.data, '$.kind'), 'auto') = 'initial')
    `).run();
    removed = db.prepare(`DELETE FROM workflow_versions WHERE ${kindOf} = 'auto'`).run().changes;
    setMeta(db, LEGACY_AUTOSAVE_PRUNE_MARKER, new Date().toISOString());
  })();
  return removed;
}

/** Called once at boot. Never throws: a failed import must not stop the server. */
export async function initStorage(redis: IORedis, log: (m: string) => void = console.log): Promise<StorageHandles> {
  const h = getStorage(redis);
  if (h.driver !== 'sqlite' || !h.db) {
    log('[STORAGE] driver=redis (workflows in Redis; execution history disabled)');
    return h;
  }
  log(`[STORAGE] driver=sqlite file=${config.SQLITE_PATH}`);
  try {
    const rep = await importWorkflowsFromRedis(redis, h.db);
    if (!rep.skipped) {
      log(`[STORAGE] imported ${rep.workflows} workflow(s) and ${rep.versions} version(s) from Redis (Redis left untouched)`);
    }
    for (const e of rep.errors.slice(0, 20)) log(`[STORAGE] import warning: ${e}`);
  } catch (e) {
    log(`[STORAGE] Redis import failed (will retry next boot): ${(e as Error).message}`);
  }
  try {
    const pruned = pruneLegacyAutosavesOnce(h.db);
    if (pruned > 0) log(`[STORAGE] removed ${pruned} legacy autosave history entr${pruned === 1 ? 'y' : 'ies'} (manual and initial versions kept)`);
  } catch (e) {
    log(`[STORAGE] legacy autosave cleanup skipped: ${(e as Error).message}`);
  }
  try {
    const n = h.executions?.prune() ?? 0;
    if (n > 0) log(`[STORAGE] pruned ${n} old execution(s)`);
  } catch { /* best-effort */ }
  return h;
}
