/**
 * BranchBase — WHERE new browser branches are created (the base directory).
 *
 * One base directory per OS, in global settings (`BRANCH_BASE_DIR`). The user
 * never types a branch path: a new branch is `<base>/branch-NNN`.
 *
 * DEFAULTS (owner's constraints: writable by a normal user without admin
 * rights; not Chromium's own "User Data" folder; not inside a cloud-synced
 * folder; no spaces / non-ASCII in the parts we choose):
 *
 *   Windows  %LOCALAPPDATA%\AriaBrowser\branches
 *            LOCALAPPDATA (C:\Users\<u>\AppData\Local) is per-user, writable
 *            without elevation, and NON-roaming: OneDrive "Known Folder Move"
 *            redirects Desktop / Documents / Pictures, never AppData\Local,
 *            and roaming profiles do not sync it. Chromium's own data is
 *            AppData\Local\Chromium\User Data (or Google\Chrome\User Data), a
 *            different subtree, so personal browser data is never touched.
 *   Linux    $XDG_DATA_HOME/aria-browser/branches  (default ~/.local/share/...)
 *            The XDG place for per-user application data: user-writable, not
 *            ~/.config/chromium (Chromium's own), not a sync folder.
 *   Docker / servers set BRANCH_BASE_DIR to a mounted volume (like PROFILES_DIR).
 *
 * Changing the base never moves, copies or deletes anything: it only decides
 * where the NEXT branch is created (each branch stores its absolute root).
 */
import { promises as fs, constants as fsc } from 'fs';
import path from 'path';
import os from 'os';

export type Platform = NodeJS.Platform | string;

/** Pure: the default base directory for a platform and an environment. */
export function defaultBaseDir(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
      || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, 'AppData', 'Local') : path.win32.join(home, 'AppData', 'Local'));
    return path.win32.join(local, 'AriaBrowser', 'branches');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'AriaBrowser', 'branches');
  const xdg = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share');
  return path.posix.join(xdg, 'aria-browser', 'branches');
}

/** Places a branch base must never be inside (personal browser data, sync clients). */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /[\\/]User Data([\\/]|$)/i, why: 'it is inside a Chromium/Chrome "User Data" folder (personal browser data)' },
  { re: /[\\/]\.config[\\/](chromium|google-chrome|BraveSoftware)([\\/]|$)/i, why: 'it is inside a personal Chromium/Chrome profile folder' },
  { re: /[\\/](OneDrive|Dropbox|Google Drive|iCloud Drive|iCloudDrive|Box Sync|MEGA)[^\\/]*([\\/]|$)/i, why: 'it is inside a cloud-synced folder; sync corrupts locked browser files' },
];

export interface BaseCheck { ok: boolean; path: string; errors: string[]; warnings: string[] }

/** Pure part of the validation (no disk). */
export function checkBasePathShape(raw: string, platform: Platform = process.platform): BaseCheck {
  const p = String(raw || '').trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  const isAbs = platform === 'win32' ? /^[A-Za-z]:[\\/]|^\\\\[^\\]+\\/.test(p) : path.posix.isAbsolute(p);
  if (!p) errors.push('Enter a folder.');
  else if (!isAbs) errors.push('Use a full (absolute) path.');
  if (p) {
    for (const f of FORBIDDEN) if (f.re.test(p)) errors.push(`Not allowed: ${f.why}.`);
    if (platform === 'win32' && /^[A-Za-z]:[\\/]?$/.test(p)) errors.push('A drive root is not allowed (usually not writable without administrator rights).');
    if (platform !== 'win32' && p === '/') errors.push('The filesystem root is not allowed.');
    if (/\s/.test(p)) warnings.push('The path contains spaces; it works, but a path without spaces is safer for tools and scripts.');
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(p)) warnings.push('The path contains non-ASCII characters; a plain ASCII path is safer.');
  }
  return { ok: errors.length === 0, path: p, errors, warnings };
}

/**
 * Full validation: shape + exists or can be created + writable + not itself
 * a Chromium data folder (a running or former browser owns it).
 */
export async function validateBaseDir(raw: string, platform: Platform = process.platform): Promise<BaseCheck> {
  const r = checkBasePathShape(raw, platform);
  if (!r.ok) return r;
  for (const f of ['SingletonLock', 'SingletonSocket', 'Local State']) {
    if (await fs.lstat(path.join(r.path, f)).then(() => true, () => false)) {
      r.errors.push('This folder is itself a Chromium data folder (a browser uses or used it); choose an empty or new folder.');
      r.ok = false;
      return r;
    }
  }
  try {
    await fs.mkdir(r.path, { recursive: true });
    await fs.access(r.path, fsc.W_OK);
    const probe = path.join(r.path, `.aria-write-test-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
  } catch (e) {
    r.errors.push(`The folder cannot be created or written: ${(e as Error).message.split('\n')[0]}`);
  }
  r.ok = r.errors.length === 0;
  return r;
}
