/**
 * ChromiumProfileLocation — WHICH Chromium data directory a launch selects.
 *
 * Used by every launcher of a persistent Chromium (core/RealChrome = Local
 * Browser, core/ProfileBrowser = Browser Profiles, pipeline.ensureProfileBrowser
 * = runs). It is not a launcher itself. It is the one rule all three apply, so
 * the profile a browser opens is chosen by the application, never by chance.
 *
 * FOUR IDENTITIES, NEVER INTERCHANGEABLE
 * -------------------------------------
 *   profile id         Aria's persistent id (`default`, `prf_<hex>`, legacy names)  core/ProfileRegistry
 *   user-data root     Chromium's `--user-data-dir` (one per profile, see below)   ProfileRegistry.dirOf / REAL_CHROME_USER_DATA_DIR
 *   profile directory  Chromium's `--profile-directory` inside that root           THIS file (pinned per root)
 *   display name       what Chromium shows (`Local State` info_cache[dir].name)    core/ChromiumProfileName
 *
 * Renaming changes only the display name. The id names the root. The profile
 * directory is PINNED in `<root>/.plyr-chromium-profile.json`.
 *
 * WHY `--profile-directory` IS ALWAYS PASSED (measured, Chromium 1194)
 * -------------------------------------------------------------------
 * Without it Chromium opens `Local State` -> `profile.last_used`. After someone
 * picked another profile in Chromium's own profile menu once, an unpinned launch
 * opened THAT profile's data (`chrome://version` -> `<root>/Profile 1`) while
 * the application believed it was on `Default`. With the switch it opens
 * exactly `<root>/<profile-directory>`.
 *
 * WHY ONE ROOT PER PROFILE, NOT ONE SHARED ROOT (measured, Chromium 1194)
 * ----------------------------------------------------------------------
 * Chromium allows ONE browser process per user-data root (ProcessSingleton):
 *   - a 2nd Playwright launch on the same root with another
 *     `--profile-directory` fails: "Failed to create a ProcessSingleton";
 *   - a plain 2nd invocation is FORWARDED into the running process. It opens
 *     the other profile there, but Playwright cannot see that profile, and it
 *     shares the first process's lifetime, launch flags and visibility.
 * Browser Profiles need simultaneous, independently leased, independently
 * closed profiles, and a hidden scheduled run next to a visible manual one.
 * That needs a separate process, so each profile needs its own root. Inside
 * each root the selection is the same as for the Local Browser: the root plus
 * a pinned `--profile-directory`.
 *
 * EXISTING DATA IS NEVER MOVED
 * ---------------------------
 * A root with no pin file is ADOPTED. It keeps the directory Chromium would
 * have opened anyway (`last_used`, if that directory exists), otherwise
 * `Default`. That value is pinned, and from then on a change of `last_used`
 * can no longer switch the data. Nothing is copied, renamed or deleted. A pin
 * file that exists but is unreadable is left untouched, and the adopted value
 * is used for this launch only.
 */
import { promises as fs } from 'fs';
import path from 'path';

export const PIN_FILE = '.plyr-chromium-profile.json';
export const DEFAULT_PROFILE_DIRECTORY = 'Default';

/** Switches this layer owns. A caller's argv must never carry its own copy. */
const OWNED_SWITCHES = ['--user-data-dir', '--profile-directory'];

export type ProfileDirectorySource = 'pinned' | 'adopted-last-used' | 'adopted-default' | 'unreadable-pin';

export interface ChromiumProfileLocation {
  /** Chromium's --user-data-dir (absolute). */
  userDataRoot: string;
  /** Chromium's --profile-directory: a directory name INSIDE the root. */
  profileDirectory: string;
  /** `<root>/<profileDirectory>`, what `chrome://version` reports as "Profile Path". */
  profilePath: string;
  /** How the profile directory was decided (for logs / tests). */
  source: ProfileDirectorySource;
}

/** A name Chromium accepts as a profile directory and that cannot escape the root. */
export function isValidProfileDirectory(v: unknown): v is string {
  return typeof v === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(v)
    && !v.includes('..');
}

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function readJson(file: string): Promise<{ data: any; exists: boolean; corrupt: boolean }> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return { data: null, exists: false, corrupt: false }; }
  try { return { data: JSON.parse(raw), exists: true, corrupt: false }; } catch { return { data: null, exists: true, corrupt: true }; }
}

/** Which profile directory Chromium WOULD open in `root` without the switch. Read-only. */
export async function adoptableProfileDirectory(root: string): Promise<{ dir: string; source: 'adopted-last-used' | 'adopted-default' }> {
  const ls = await readJson(path.join(root, 'Local State'));
  const last = ls.data?.profile?.last_used;
  if (isValidProfileDirectory(last) && await isDir(path.join(root, last))) return { dir: last, source: 'adopted-last-used' };
  return { dir: DEFAULT_PROFILE_DIRECTORY, source: 'adopted-default' };
}

/** Pure: read a pin file's content. */
export function pinnedDirectoryOf(data: unknown): string | null {
  const v = (data as { profileDirectory?: unknown } | null)?.profileDirectory;
  return isValidProfileDirectory(v) ? v : null;
}

/**
 * Resolve (and on first use, pin) the Chromium profile directory of `root`.
 * Call it only while no browser runs on the root: the callers do so right
 * before launching, under the profile's lease or launch lock.
 */
export async function resolveChromiumProfile(root: string): Promise<ChromiumProfileLocation> {
  const userDataRoot = path.resolve(root);
  await fs.mkdir(userDataRoot, { recursive: true });
  const pinFile = path.join(userDataRoot, PIN_FILE);
  const pin = await readJson(pinFile);
  const pinned = pinnedDirectoryOf(pin.data);
  if (pinned) return at(userDataRoot, pinned, 'pinned');

  const adopted = await adoptableProfileDirectory(userDataRoot);
  if (pin.exists) {
    // Not ours to repair: use what Chromium would open, change nothing.
    console.warn(`[PROFILES] ${pinFile} is unreadable; using "${adopted.dir}" for this launch, file left untouched`);
    return at(userDataRoot, adopted.dir, 'unreadable-pin');
  }
  const tmp = `${pinFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ profileDirectory: adopted.dir, source: adopted.source, pinnedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, pinFile);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    console.warn(`[PROFILES] could not pin the profile directory in ${userDataRoot}: ${(e as Error).message}`);
  }
  return at(userDataRoot, adopted.dir, adopted.source);
}

function at(userDataRoot: string, profileDirectory: string, source: ProfileDirectorySource): ChromiumProfileLocation {
  return { userDataRoot, profileDirectory, profilePath: path.join(userDataRoot, profileDirectory), source };
}

/** Pure: `args` without any user-data-dir / profile-directory switch, plus the location's `--profile-directory`. */
export function withProfileSelection(args: readonly string[], loc: Pick<ChromiumProfileLocation, 'profileDirectory'>): string[] {
  const kept = args.filter((a) => !OWNED_SWITCHES.some((s) => a === s || a.startsWith(`${s}=`)));
  // The root goes through launchPersistentContext(root) (Playwright adds
  // --user-data-dir itself); the inner directory is chosen here.
  return [...kept, `--profile-directory=${loc.profileDirectory}`];
}

/**
 * After launch: did Chromium open the intended directory? Chromium creates
 * `<root>/<profileDirectory>` when it opens a profile. Returns false (and the
 * caller logs it) when it is missing. That is never fatal.
 */
export async function verifyProfileSelected(loc: ChromiumProfileLocation): Promise<boolean> {
  return isDir(loc.profilePath);
}
