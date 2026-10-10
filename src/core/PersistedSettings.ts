/**
 * PersistedSettings — the values an operator chose in the Settings page.
 *
 * WHY A SEPARATE FILE AND NOT `.env`
 * ----------------------------------
 * `.env` is the operator's hand-written file and, under Docker, it is not even
 * inside the container: Compose reads it once (`env_file:`) when the container
 * is created. A panel that wrote `/app/.env` would "work" until the next
 * `docker compose up` and then silently forget everything. The data directory
 * (`./data`, next to the SQLite database) is the one place every deployment
 * already persists, so the panel's choices live there:
 *
 *     <dirname(SQLITE_PATH)>/settings.env      (override with SETTINGS_FILE)
 *
 * Same `KEY=value` format as `.env`, so `./plyr setup` (bash) can read and
 * clear keys in it without a JSON parser.
 *
 * PRECEDENCE:  value saved in the panel  >  .env / environment  >  built-in default
 *
 * A human pressing Save in this instance is the most explicit signal there is
 * (same reasoning as RuntimeSettings). `./plyr setup` removes a key from this
 * file when it writes the same key to `.env`, so the two never disagree.
 *
 * HOW A CHANGE TAKES EFFECT WITHOUT A RESTART
 * -------------------------------------------
 * At boot the file is overlaid onto `process.env` BEFORE config.ts computes
 * anything (this module is imported first). After boot, a save updates an
 * in-memory map that config.ts's getters consult on every read. Keys whose
 * consumers only read them once at startup are marked `restart` in the catalog
 * and the UI says so — no pretending.
 *
 * This module imports NOTHING from config.ts (config imports it), so there is
 * no cycle.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseDotenv } from 'dotenv';
import 'dotenv/config';

/** Raw values saved in the panel during THIS process (after boot). */
const live = new Map<string, string | null>();
/** What the environment said for each overlaid key BEFORE the file was applied. */
const envBeforeOverlay: Record<string, string | undefined> = {};
/** Keys present in the settings file at boot. */
const bootFileKeys = new Set<string>();
let loaded = false;

/** Where the panel's settings are stored. */
export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.SETTINGS_FILE || '').split('#')[0].trim();
  if (explicit) return path.resolve(explicit);
  const sqlite = (env.SQLITE_PATH || '').split('#')[0].trim() || './data/plyr.db';
  return path.join(path.dirname(path.resolve(sqlite)), 'settings.env');
}

/**
 * Tests and tools must not pick up a developer's own ./data/settings.env, so
 * the overlay is skipped under vitest unless SETTINGS_FILE is set explicitly.
 */
function overlayEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.SETTINGS_FILE) return true;
  if (env.VITEST || env.NODE_ENV === 'test') return false;
  return true;
}

/** Read the settings file into a plain object ({} when absent/unreadable). */
export function readSettingsFile(file: string = settingsFilePath()): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Every key the panel may persist. Kept HERE (not in the catalog) so the boot
 * overlay can run before anything else is imported. A test asserts this list
 * equals the catalog's keys.
 */
export const PERSISTABLE_KEYS: readonly string[] = Object.freeze([
  'APP_ENV',
  'AUTH_MODE',
  'API_TOKEN',
  'WEBHOOK_SECRET',
  'LIVE_SHARE_TTL_SEC',
  'CODE_NODE_ENABLED',
  'PUBLIC_DOMAIN',
  'REAL_CHROME_ENABLED',
  'DEFAULT_HEADLESS',
  'STEP_TIMEOUT_MS',
  'MAX_CONCURRENT',
  'DOWNLOAD_TTL_MINUTES',
  'EXECUTION_RETENTION_DAYS',
]);

/**
 * Apply the settings file to process.env. Idempotent; runs on import.
 * Only keys listed in `allowed` are applied — the file is operator data, and
 * an entry like NODE_OPTIONS must never reach the process.
 */
export function loadPersistedSettings(
  allowed: readonly string[] = PERSISTABLE_KEYS,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env === process.env) {
    if (loaded) return [...bootFileKeys];
    loaded = true;
    // What .env / the environment said at boot, for every key — the value a
    // "reset to .env" falls back to, even if process.env is mutated later.
    for (const k of allowed) envBeforeOverlay[k] = env[k];
  }
  if (!overlayEnabled(env)) return [];
  const applied: string[] = [];
  const values = readSettingsFile(settingsFilePath(env));
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.includes(key)) continue;
    if (env === process.env) bootFileKeys.add(key);
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * The raw value saved in the panel during this process, if any.
 * `undefined` = not changed at runtime; `null` = reset to "not set by panel"
 * at runtime (the getter then falls back to the .env value).
 */
export function liveRaw(key: string): string | null | undefined {
  return live.has(key) ? live.get(key) : undefined;
}

/** The value .env/environment had, ignoring the panel. */
export function envValueOf(key: string): string | undefined {
  return key in envBeforeOverlay ? envBeforeOverlay[key] : process.env[key];
}

/** Where the current value came from. */
export function sourceOf(key: string): 'panel' | 'env' | 'default' {
  const fromEnv = (): 'env' | 'default' => {
    const v = envValueOf(key);
    return v !== undefined && v.trim() !== '' ? 'env' : 'default';
  };
  if (live.has(key)) return live.get(key) !== null ? 'panel' : fromEnv();
  if (bootFileKeys.has(key)) return 'panel';
  return fromEnv();
}

/** Rewrite one key in an env-format body: drop every assignment, append one. `null` removes it. */
export function rewriteKey(body: string, key: string, value: string | null): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const assign = new RegExp(`^\\s*${key}\\s*=`);
  const kept = body.split(/\r?\n/).filter((l) => !assign.test(l));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  if (value !== null) kept.push(`${key}=${value}`);
  return kept.length ? kept.join(eol) + eol : '';
}

const HEADER = '# Written by the Plyr Settings page. Values here OVERRIDE .env.\n'
  + '# Safe to edit by hand; `./plyr setup` removes a key here when it writes it to .env.\n';

/**
 * Save (or, with `null`, remove) a value: memory first, then disk.
 * Memory first so the change is in force even on a read-only filesystem; the
 * result says whether it will survive a restart.
 */
export function saveSetting(
  key: string,
  value: string | null,
  opts: { file?: string } = {},
): { persisted: boolean; file: string; error?: string } {
  if (!PERSISTABLE_KEYS.includes(key)) throw new Error(`Not a persistable setting: ${key}`);
  if (value !== null && /[\r\n]/.test(value)) throw new Error('A setting value cannot contain a line break');
  live.set(key, value);
  const file = opts.file || settingsFilePath();
  try {
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { body = HEADER; }
    const next = rewriteKey(body, key, value);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, next || HEADER, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* not all filesystems */ }
    return { persisted: true, file };
  } catch (e) {
    return { persisted: false, file, error: (e as Error)?.message || String(e) };
  }
}

/** For tests: forget runtime saves. */
export function resetLiveSettingsForTests(): void {
  live.clear();
}

// Runs on import — before config.ts computes a single value.
loadPersistedSettings();
