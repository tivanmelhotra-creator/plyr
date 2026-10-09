/**
 * SqliteStore — the durable half of Plyr's storage.
 *
 * Split of responsibilities (deliberate):
 *   Redis  -> queue (BullMQ), Pub/Sub live fan-out, idempotency keys, cron.
 *             Fast, ephemeral-ish, needed by several moving parts at once.
 *   SQLite -> what must survive a Redis flush: saved workflows + their version
 *             history, and the execution history. One file, WAL mode.
 *
 * Driver: better-sqlite3. `node:sqlite` is still experimental on Node 22 (it
 * prints an ExperimentalWarning at import) and does not exist on Node 20,
 * which package.json `engines` still allows. better-sqlite3 is synchronous
 * (no interleaving between read-modify-write steps inside one process), ships
 * prebuilt binaries, and exposes SQLite's online backup API used by
 * `./plyr backup`.
 *
 * ONE PROCESS ONLY. WAL lets readers run beside one writer, but the version
 * counter and the Redis->SQLite boot migration assume a single Plyr process
 * owns the file (PM2 cluster / instances > 1 is not supported — the Remote
 * Browser profile lock already forbids it).
 *
 * Schema changes go through MIGRATIONS (append-only, numbered). `user_version`
 * records how far a file has been migrated, so an older file is upgraded in
 * place on open and a newer one is refused instead of being misread.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDb = Database.Database;

/** Append-only. Never edit a shipped entry; add a new one. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workflows (
        user_id     TEXT NOT NULL,
        id          TEXT NOT NULL,
        version     INTEGER NOT NULL,
        updated_at  TEXT NOT NULL,
        data        TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX workflows_by_user ON workflows (user_id, updated_at DESC);

      CREATE TABLE workflow_versions (
        user_id     TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        version     INTEGER NOT NULL,
        saved_at    TEXT NOT NULL,
        data        TEXT NOT NULL,
        PRIMARY KEY (user_id, workflow_id, version)
      );

      CREATE TABLE executions (
        job_id       TEXT NOT NULL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        workflow_id  TEXT,
        workflow_version INTEGER,
        trigger      TEXT,
        status       TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT NOT NULL,
        duration_ms  INTEGER,
        error        TEXT,
        steps        TEXT NOT NULL
      );
      CREATE INDEX executions_by_user ON executions (user_id, finished_at DESC);
      CREATE INDEX executions_by_workflow ON executions (user_id, workflow_id, finished_at DESC);

      CREATE TABLE meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function schemaVersionOf(db: SqliteDb): number {
  return Number(db.pragma('user_version', { simple: true }) || 0);
}

/** Apply every migration newer than the file, each in its own transaction. */
export function migrate(db: SqliteDb): number {
  const current = schemaVersionOf(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `SQLite database schema v${current} is newer than this build supports (v${SCHEMA_VERSION}). ` +
      'Upgrade Plyr or restore a matching backup.'
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return schemaVersionOf(db);
}

/**
 * better-sqlite3 is a native addon. When its compiled binding is missing
 * (`npm ci --ignore-scripts`, a Node upgrade, copying node_modules between
 * machines) the raw error is a 30-line "Could not locate the bindings file"
 * trace that names neither the feature nor the fix.
 */
export function describeOpenError(e: unknown, file: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/bindings file|NODE_MODULE_VERSION|was compiled against a different Node|invalid ELF|better_sqlite3\.node/i.test(msg)) {
    return 'SQLite storage is unavailable: the native better-sqlite3 binding is missing or was built for another '
      + `Node.js (${process.version}). Fix: run \`npm rebuild better-sqlite3\` (Docker: rebuild the image), `
      + 'or set STORAGE_DRIVER=redis to keep the previous Redis-only storage. '
      + `Original error: ${msg.split('\n')[0]}`;
  }
  return `Could not open the SQLite database at ${file}: ${msg}`;
}

/** Open (creating if needed) the DB file in WAL mode and migrate it. */
export function openSqlite(file: string): SqliteDb {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  let db: SqliteDb;
  try {
    db = new Database(file);
  } catch (e) {
    throw new Error(describeOpenError(e, file));
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function getMeta(db: SqliteDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: SqliteDb, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/**
 * Consistent copy of a live database (online backup API: safe while the
 * server is writing). Refuses to overwrite an existing file.
 */
export async function backupSqlite(db: SqliteDb, dest: string): Promise<void> {
  if (fs.existsSync(dest)) throw new Error(`Backup target already exists: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await db.backup(dest);
  // A backup should be ONE self-contained file: switch the copy out of WAL so
  // no -wal/-shm siblings are needed (or created when it is inspected).
  const copy = new Database(dest);
  try { copy.pragma('journal_mode = DELETE'); } finally { copy.close(); }
}

/** Open a file read-only and make sure it is a Plyr database this build can read. */
export function inspectSqliteFile(file: string): { schemaVersion: number; workflows: number; executions: number } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ok = db.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') throw new Error(`integrity_check failed: ${String(ok)}`);
    const v = schemaVersionOf(db);
    if (v < 1) throw new Error('not a Plyr database (schema version 0)');
    if (v > SCHEMA_VERSION) throw new Error(`schema v${v} is newer than this build (v${SCHEMA_VERSION})`);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { schemaVersion: v, workflows: count('workflows'), executions: count('executions') };
  } finally {
    db.close();
  }
}

// ── Process-wide handle ─────────────────────────────────────────────────────
let shared: { file: string; db: SqliteDb } | null = null;

/** The server's single connection (opened on first use). */
export function sharedSqlite(file: string): SqliteDb {
  if (shared && shared.file === file && shared.db.open) return shared.db;
  if (shared && shared.db.open) shared.db.close();
  shared = { file, db: openSqlite(file) };
  return shared.db;
}

export function closeSharedSqlite(): void {
  if (shared && shared.db.open) {
    try { shared.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    shared.db.close();
  }
  shared = null;
}
