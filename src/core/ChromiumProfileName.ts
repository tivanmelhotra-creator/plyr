/**
 * ChromiumProfileName — make Chromium's OWN name for a profile match the name
 * chosen in Browser Profiles (instead of the generic "Your Chromium").
 *
 * Each registry profile owns a whole user-data-dir and uses Chromium's single
 * inner profile `Default` inside it (never `--profile-directory`; see
 * core/LaunchSettings APP_CONTROLLED). Chromium keeps the display name of an
 * inner profile in two places, and reads them at startup:
 *
 *   <dir>/Local State          profile.info_cache.Default.{name, is_using_default_name}
 *   <dir>/Default/Preferences  profile.{name, using_default_name}
 *
 * Rules (the files belong to Chromium):
 *   - written ONLY while no browser runs on the directory (the caller launches
 *     right after); a running Chromium rewrites both files on exit;
 *   - a file that exists but is not valid JSON is NOT touched (reported);
 *   - only the name keys are set; every other key is preserved (merge);
 *   - atomic write (tmp + rename), 0600 like Chromium's own files.
 * Best-effort: a failure never blocks the launch, the caller logs it.
 */
import { promises as fs } from 'fs';
import path from 'path';

type Json = Record<string, any>;

async function readJson(file: string): Promise<{ data: Json | null; exists: boolean; corrupt: boolean }> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return { data: null, exists: false, corrupt: false }; }
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && !Array.isArray(d) ? { data: d, exists: true, corrupt: false } : { data: null, exists: true, corrupt: true };
  } catch { return { data: null, exists: true, corrupt: true }; }
}

async function writeJson(file: string, data: Json): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.plyr-${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Pure: Local State with the name of inner profile `Default` set. */
export function withLocalStateName(state: Json | null, name: string): Json {
  const s: Json = state ? { ...state } : {};
  const profile: Json = { ...(s.profile || {}) };
  const cache: Json = { ...(profile.info_cache || {}) };
  cache.Default = { ...(cache.Default || {}), name, is_using_default_name: false };
  profile.info_cache = cache;
  s.profile = profile;
  return s;
}

/** Pure: Preferences with the profile name set. */
export function withPreferencesName(prefs: Json | null, name: string): Json {
  const p: Json = prefs ? { ...prefs } : {};
  p.profile = { ...(p.profile || {}), name, using_default_name: false };
  return p;
}

/** The name Chromium currently has for inner profile `Default`, or null. */
export async function readChromiumProfileName(userDataDir: string): Promise<string | null> {
  const ls = await readJson(path.join(userDataDir, 'Local State'));
  const n = ls.data?.profile?.info_cache?.Default?.name;
  return typeof n === 'string' ? n : null;
}

/**
 * Set the Chromium display name of the profile in `userDataDir`.
 * Returns what happened, never throws.
 */
export async function applyChromiumProfileName(userDataDir: string, name: string):
  Promise<{ ok: boolean; changed: boolean; skipped?: string }> {
  try {
    const lsFile = path.join(userDataDir, 'Local State');
    const prFile = path.join(userDataDir, 'Default', 'Preferences');
    const [ls, pr] = await Promise.all([readJson(lsFile), readJson(prFile)]);
    if (ls.corrupt || pr.corrupt) return { ok: false, changed: false, skipped: 'Chromium profile files are unreadable; left untouched' };
    const lsName = ls.data?.profile?.info_cache?.Default?.name;
    const prName = pr.data?.profile?.name;
    const lsDefault = ls.data?.profile?.info_cache?.Default?.is_using_default_name;
    const prDefault = pr.data?.profile?.using_default_name;
    if (lsName === name && prName === name && lsDefault === false && prDefault === false) return { ok: true, changed: false };
    await writeJson(lsFile, withLocalStateName(ls.data, name));
    await writeJson(prFile, withPreferencesName(pr.data, name));
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, skipped: (e as Error).message.split('\n')[0] };
  }
}
