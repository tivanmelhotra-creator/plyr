/**
 * ChromiumProfileName — make Chromium's OWN name for a profile match the name
 * chosen in Browser Profiles (instead of the generic "Your Chromium").
 *
 * Each registry profile owns a user-data root and ONE pinned profile directory
 * inside it (core/ChromiumProfileLocation, selected with `--profile-directory`;
 * `Default` unless an existing root was adopted with another one). Chromium
 * keeps the display name of a profile directory in two places, and reads them
 * at startup:
 *
 *   <root>/Local State                profile.info_cache.<dir>.{name, is_using_default_name}
 *   <root>/<dir>/Preferences          profile.{name, using_default_name}
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

/** Pure: Local State with the name of profile directory `dir` (default `Default`) set. */
export function withLocalStateName(state: Json | null, name: string, dir = 'Default'): Json {
  const s: Json = state ? { ...state } : {};
  const profile: Json = { ...(s.profile || {}) };
  const cache: Json = { ...(profile.info_cache || {}) };
  cache[dir] = { ...(cache[dir] || {}), name, is_using_default_name: false };
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

/** The name Chromium currently has for profile directory `dir`, or null. */
export async function readChromiumProfileName(userDataDir: string, dir = 'Default'): Promise<string | null> {
  const ls = await readJson(path.join(userDataDir, 'Local State'));
  const n = ls.data?.profile?.info_cache?.[dir]?.name;
  return typeof n === 'string' ? n : null;
}

/**
 * Set the Chromium display name of the profile in `userDataDir`.
 * Returns what happened, never throws.
 */
export async function applyChromiumProfileName(userDataDir: string, name: string, dir = 'Default'):
  Promise<{ ok: boolean; changed: boolean; skipped?: string }> {
  try {
    const lsFile = path.join(userDataDir, 'Local State');
    const prFile = path.join(userDataDir, dir, 'Preferences');
    const [ls, pr] = await Promise.all([readJson(lsFile), readJson(prFile)]);
    if (ls.corrupt || pr.corrupt) return { ok: false, changed: false, skipped: 'Chromium profile files are unreadable; left untouched' };
    const lsName = ls.data?.profile?.info_cache?.[dir]?.name;
    const prName = pr.data?.profile?.name;
    const lsDefault = ls.data?.profile?.info_cache?.[dir]?.is_using_default_name;
    const prDefault = pr.data?.profile?.using_default_name;
    if (lsName === name && prName === name && lsDefault === false && prDefault === false) return { ok: true, changed: false };
    await writeJson(lsFile, withLocalStateName(ls.data, name, dir));
    await writeJson(prFile, withPreferencesName(pr.data, name));
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, skipped: (e as Error).message.split('\n')[0] };
  }
}

/**
 * A distinct look per profile (owner's brief, section 1: "the color and icon
 * of profiles are not verified"). Before, every new profile got Chromium's
 * same default avatar (IDR_PROFILE_AVATAR_26) and the same highlight color
 * (MEASURED, Chromium 1194), so two profiles of one branch looked identical.
 *
 * Deterministic from the profile folder number (profile-001 -> slot 0 ...),
 * so the same profile always has the same look; the panel shows the same color.
 * Written like the name: merge, atomic, only while no browser runs, never on
 * an unreadable file; a look the user picked in Chromium itself is kept.
 */
export const PROFILE_COLORS: readonly string[] = ['#1a73e8', '#d93025', '#188038', '#f29900', '#9334e6', '#e52592', '#12b5cb', '#e8710a'];
const AVATARS = [27, 28, 29, 30, 31, 32, 33, 34];

/** Pure: the look of a profile folder. */
export function profileLookOf(folder: string): { color: string; argb: number; avatarIndex: number } {
  const m = /(\d+)$/.exec(folder || '');
  const slot = m ? (Number(m[1]) - 1 + PROFILE_COLORS.length * 1000) % PROFILE_COLORS.length : 0;
  const hex = PROFILE_COLORS[slot]!;
  const rgb = parseInt(hex.slice(1), 16);
  // Chromium stores SkColor as a signed 32-bit ARGB int.
  const argb = ((0xff000000 | rgb) >> 0);
  return { color: hex, argb, avatarIndex: AVATARS[slot]! };
}

export async function applyChromiumProfileLook(userDataDir: string, dir: string):
  Promise<{ ok: boolean; changed: boolean; skipped?: string }> {
  try {
    const look = profileLookOf(dir);
    const lsFile = path.join(userDataDir, 'Local State');
    const prFile = path.join(userDataDir, dir, 'Preferences');
    const [ls, pr] = await Promise.all([readJson(lsFile), readJson(prFile)]);
    if (ls.corrupt || pr.corrupt) return { ok: false, changed: false, skipped: 'Chromium profile files are unreadable; left untouched' };
    const cache = ls.data?.profile?.info_cache?.[dir];
    // The user chose an avatar in Chromium itself: keep it.
    if (cache && cache.is_using_default_avatar === false && pr.data?.profile?.avatar_index !== undefined && pr.data?.plyr_look !== look.avatarIndex) {
      return { ok: true, changed: false, skipped: 'look chosen in Chromium kept' };
    }
    if (pr.data?.plyr_look === look.avatarIndex && cache?.avatar_icon === `chrome://theme/IDR_PROFILE_AVATAR_${look.avatarIndex}`) return { ok: true, changed: false };
    const st: Json = ls.data ? { ...ls.data } : {};
    const profile: Json = { ...(st.profile || {}) };
    const ic: Json = { ...(profile.info_cache || {}) };
    ic[dir] = { ...(ic[dir] || {}), avatar_icon: `chrome://theme/IDR_PROFILE_AVATAR_${look.avatarIndex}`, is_using_default_avatar: false };
    profile.info_cache = ic; st.profile = profile;
    const p: Json = pr.data ? { ...pr.data } : {};
    p.profile = { ...(p.profile || {}), avatar_index: look.avatarIndex, using_default_avatar: false };
    p.browser = { ...(p.browser || {}), theme: { ...((p.browser || {}).theme || {}), user_color: look.argb } };
    p.plyr_look = look.avatarIndex;
    await writeJson(lsFile, st);
    await writeJson(prFile, p);
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, skipped: (e as Error).message.split('\n')[0] };
  }
}
