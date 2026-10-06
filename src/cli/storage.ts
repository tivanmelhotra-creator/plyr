/**
 * `./plyr backup [dir]` / `./plyr restore <file>` / storage `info`.
 *
 * backup  — SQLite online backup API: a consistent snapshot even while the
 *           server is writing. Writes <dir>/plyr-<timestamp>.db (default dir:
 *           ./backups). Never overwrites an existing file.
 * restore — refuses while the server is running (the live connection would
 *           keep writing into the replaced file's old inode). Validates the
 *           source (integrity_check + schema version), keeps the current file
 *           as <db>.pre-restore-<timestamp>, then copies the backup in and
 *           removes stale -wal/-shm files.
 * info    — schema version and row counts, for doctor and humans.
 *
 * Exit codes: 0 ok, 1 refused/failed, 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config } from '../config';
import { backupSqlite, inspectSqliteFile, openSqlite, SCHEMA_VERSION } from '../core/SqliteStore';

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

export async function backup(dirArg?: string): Promise<number> {
  const dir = path.resolve(dirArg || './backups');
  if (!fs.existsSync(config.SQLITE_PATH)) {
    console.error(`[backup] no database at ${config.SQLITE_PATH} (STORAGE_DRIVER=${config.STORAGE_DRIVER})`);
    return 1;
  }
  const db = openSqlite(config.SQLITE_PATH);
  try {
    const dest = path.join(dir, `plyr-${stamp()}.db`);
    await backupSqlite(db, dest);
    const info = inspectSqliteFile(dest);
    console.log(`[backup] wrote ${dest}`);
    console.log(`[backup] schema v${info.schemaVersion}, ${info.workflows} workflow(s), ${info.executions} execution(s)`);
    return 0;
  } finally {
    db.close();
  }
}

export async function restore(file?: string, force = false): Promise<number> {
  if (!file) { console.error('usage: ./plyr restore <backup.db>'); return 2; }
  const src = path.resolve(file);
  if (!fs.existsSync(src)) { console.error(`[restore] not found: ${src}`); return 1; }
  if (!force && await portInUse(config.PORT)) {
    console.error(`[restore] something is listening on port ${config.PORT}. Stop Plyr first (./plyr stop), then retry.`);
    return 1;
  }
  let info;
  try {
    info = inspectSqliteFile(src);
  } catch (e) {
    console.error(`[restore] refused: ${(e as Error).message}`);
    return 1;
  }
  const dest = config.SQLITE_PATH;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    // Fold any WAL content into the main file before keeping it aside.
    try { const cur = openSqlite(dest); cur.pragma('wal_checkpoint(TRUNCATE)'); cur.close(); } catch { /* keep going */ }
    const keep = `${dest}.pre-restore-${stamp()}`;
    fs.renameSync(dest, keep);
    console.log(`[restore] previous database kept as ${keep}`);
  }
  for (const ext of ['-wal', '-shm']) fs.rmSync(dest + ext, { force: true });
  fs.copyFileSync(src, dest);
  console.log(`[restore] restored ${src} -> ${dest}`);
  console.log(`[restore] schema v${info.schemaVersion}, ${info.workflows} workflow(s), ${info.executions} execution(s)`);
  return 0;
}

export function dbInfo(): number {
  if (!fs.existsSync(config.SQLITE_PATH)) {
    console.log(`no database at ${config.SQLITE_PATH} (will be created on first start)`);
    return 0;
  }
  const info = inspectSqliteFile(config.SQLITE_PATH);
  console.log(`file=${config.SQLITE_PATH} schema=v${info.schemaVersion}/${SCHEMA_VERSION} workflows=${info.workflows} executions=${info.executions}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'backup') return backup(rest[0]);
  if (cmd === 'restore') return restore(rest.find((a) => !a.startsWith('--')), rest.includes('--force'));
  if (cmd === 'info') return dbInfo();
  console.error('usage: storage <backup [dir] | restore <file> [--force] | info>');
  return 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
