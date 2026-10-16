/**
 * BranchRegistry — branches (Chromium user-data roots) and the profiles in them.
 *
 *   BRANCH   one Chromium --user-data-dir. Internal id `branch-NNN` from a
 *            counter that only grows (never reused, even after deletion);
 *            an editable LABEL (display only). One Chromium process per
 *            branch, so at most one of its profiles runs at a time.
 *   PROFILE  one Chromium profile folder inside a branch, selected with
 *            --profile-directory=<folder>. Stable Aria id (`prf_<hex>`),
 *            system folder name (`profile-NNN`, unique in the branch, never
 *            `Default` for a new one), renamable display name (not unique).
 *
 * FOUR IDENTITIES, never interchangeable: Aria profile id, branch id,
 * Chromium folder name, display name.
 *
 * STORAGE: `<PROFILES_DIR>/<userId>/branches.json` (Aria's metadata; it does
 * not move when the base directory changes). Each branch stores its absolute
 * root, so changing the base directory (core/BranchBase) moves nothing.
 *
 * LOCK KEY (`leaseKey`). Leases, holds, reservations and the live session are
 * keyed by BRANCH, so "one running profile per branch" is enforced by the
 * existing atomic admission (core/ProfileLease). Legacy branches keep the key
 * their profile always had (`default`, `named:<id>`, `realchrome`), so live
 * Redis records stay valid across the upgrade.
 *
 * ONE KIND OF BRANCH (S34, owner brief 1.3 / 2.1). There is no "legacy",
 * "built-in", "Local Browser" or "external" branch any more: every branch is
 * listed, renamable and deletable under the same rules.
 *   - The Local Browser root (REAL_CHROME_USER_DATA_DIR) is NOT a branch. It
 *     belongs to core/RealChrome (internal session `realchrome`). Before S34
 *     it was adopted as a hidden branch: that hidden record took branch-001
 *     and was filtered out of the UI (bug 2.1). A stored record of it is now
 *     dropped from the registry on load; its folder is left untouched.
 *   - Pre-branch roots (`<PROFILES_DIR>/<user>/chrome-profile`,
 *     `browser-profiles/<id>`) are adopted IN PLACE as normal branches only
 *     when they hold user data (a Chromium profile or Local State); an empty
 *     one is not a branch. Nothing is moved, copied or deleted.
 *   - INVARIANT under BRANCH_BASE_DIR: the registry, the list the UI shows
 *     and the `branch-NNN` folders on disk are the same set. At load an
 *     unlisted `branch-NNN` folder without user data is removed; one WITH
 *     data is listed as a normal branch ("Branch N"); nothing is destroyed
 *     silently (both are logged). Branch ids are never reused.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { resolveChromiumProfile, isValidProfileDirectory } from './ChromiumProfileLocation';
import { sanitizeProfileId } from './ProfileLease';
import { indexedProfile, replaceIndexFor, type IndexEntry } from './ProfileIndex';

export { indexedProfile, indexedByLeaseKey } from './ProfileIndex';

export const DEFAULT_PROFILE_ID = 'default';
/** The id the pre-S34 registry gave the adopted Local Browser root. Only used to drop that record. */
const OLD_LOCAL_BROWSER_PROFILE_ID = 'local-browser';
export const REGISTRY_FILE = 'branches.json';
/**
 * Display-name rules (owner brief 3.1), enforced ONLY on create and rename:
 * trimmed, runs of whitespace collapsed, not empty, at most NAME_MAX
 * characters (Unicode code points, so Persian / emoji count as one each).
 * Branch names are unique per user, profile names unique inside their
 * branch, both case-insensitive (locale-independent). Existing data that
 * breaks a rule still loads and is never renamed silently.
 */
export const NAME_MAX = 24;

export interface BranchRecord {
  id: string;
  label: string;
  root: string;
  leaseKey: string;
  createdAt: string;
  updatedAt: string;
  nextProfile: number;
}

export interface ProfileRecord {
  id: string;
  branchId: string;
  folder: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastOpenError?: { at: string; message: string } | null;
}

interface RegistryFile { version: 1; nextBranch: number; branches: BranchRecord[]; profiles: ProfileRecord[] }

/** What callers see of one profile (a superset of the former ProfileEntry). */
export interface ProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  problem?: string | null;
  lastOpenError?: { at: string; message: string } | null;
  branchId: string;
  branchLabel: string;
  folder: string;
}

export type RegistryErrorCode = 'invalid_name' | 'duplicate_name' | 'not_found' | 'builtin' | 'io' | 'invalid_id' | 'branch_not_found';

export class ProfileRegistryError extends Error {
  constructor(message: string, readonly code: RegistryErrorCode) { super(message); this.name = 'ProfileRegistryError'; }
}

export function normalizeName(raw: unknown, what = 'Profile name'): string {
  if (typeof raw !== 'string') throw new ProfileRegistryError(`${what} is required`, 'invalid_name');
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!v) throw new ProfileRegistryError(`${what} cannot be empty`, 'invalid_name');
  if (Array.from(v).length > NAME_MAX) throw new ProfileRegistryError(`${what} must be at most ${NAME_MAX} characters`, 'invalid_name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ProfileRegistryError(`${what} contains control characters`, 'invalid_name');
  return v;
}
export const normalizeProfileName = (raw: unknown): string => normalizeName(raw);

/** Comparison key for uniqueness: case-insensitive, Unicode-normalized, locale-independent. */
export function nameKey(v: string): string {
  return v.normalize('NFKC').toLowerCase();
}

function displayLabel(b: { id: string; label: string }): string { return b.label || b.id; }

/** "Branch N" (N from the id), or the next free "Branch N" if a user already named one so. */
function freeBranchName(f: { branches: Array<{ id: string; label: string }> }, id: string): string {
  const taken = new Set(f.branches.map((x) => nameKey(displayLabel(x))));
  let n = Number((/(\d+)$/.exec(id) || [])[1]) || f.branches.length + 1;
  while (taken.has(nameKey(`Branch ${n}`))) n++;
  return `Branch ${n}`;
}

function assertBranchNameFree(f: { branches: Array<{ id: string; label: string }> }, label: string, selfId: string | null): void {
  const k = nameKey(label);
  const clash = f.branches.find((x) => x.id !== selfId && nameKey(displayLabel(x)) === k);
  if (clash) throw new ProfileRegistryError(`A branch named "${displayLabel(clash)}" already exists`, 'duplicate_name');
}

function assertProfileNameFree(f: { profiles: Array<{ id: string; branchId: string; name: string }> }, b: { id: string }, name: string, selfId: string | null): void {
  const k = nameKey(name);
  const clash = f.profiles.find((x) => x.branchId === b.id && x.id !== selfId && nameKey(x.name) === k);
  if (clash) throw new ProfileRegistryError(`A profile named "${clash.name}" already exists in this branch`, 'duplicate_name');
}

export const branchIdOf = (n: number): string => `branch-${String(n).padStart(3, '0')}`;
export const profileFolderOf = (n: number): string => `profile-${String(n).padStart(3, '0')}`;
export const isBranchId = (v: unknown): v is string => typeof v === 'string' && /^branch-\d{3,}$/.test(v);
export function newProfileId(): string { return `prf_${randomBytes(6).toString('hex')}`; }

/** Legacy profile root (the rule runs always used before branches). */
export function legacyProfileDir(profilesDir: string, userId: string, id: string): string {
  return id === DEFAULT_PROFILE_ID
    ? path.join(profilesDir, userId, 'chrome-profile')
    : path.join(profilesDir, userId, 'browser-profiles', id);
}
export const profileDirFor = legacyProfileDir;
export function legacyLeaseKey(id: string): string { return id === DEFAULT_PROFILE_ID ? 'default' : `named:${id}`; }

async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }
async function isDir(p: string): Promise<boolean> { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

async function readMetaName(dir: string): Promise<string | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, '.plyr-profile.json'), 'utf8'));
    return typeof m.name === 'string' && m.name.trim() ? m.name : null;
  } catch { return null; }
}

export interface BranchRegistryOptions {
  profilesDir: string;
  /** Where NEW branches are created (core/BranchBase). Read at each create. */
  baseDir: () => string;
  /**
   * Reconcile `branch-NNN` folders under the base directory that no registry
   * lists (see the header). Default true. Multi-user servers share one base
   * directory, so a folder listed by ANY user's registry is never touched.
   */
  reconcileBase?: boolean;
  /** Log sink for reconcile / migration events (default console). */
  log?: (line: string) => void;
}

/** Does `root` hold Chromium user data (Local State, or a profile folder with Preferences)? Read-only. */
export async function holdsUserData(root: string): Promise<boolean> {
  if (await exists(path.join(root, 'Local State'))) return true;
  let names: string[] = [];
  try { names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return false; }
  for (const n of names) if (await exists(path.join(root, n, 'Preferences'))) return true;
  return false;
}

/** Profile folders Chromium created in `root` (a folder with Preferences), with Chromium's display name. Read-only. */
async function chromiumProfilesIn(root: string): Promise<Array<{ folder: string; chromiumName: string | null }>> {
  let ls: any = null;
  try { ls = JSON.parse(await fs.readFile(path.join(root, 'Local State'), 'utf8')); } catch { ls = null; }
  const cache = (ls?.profile?.info_cache || {}) as Record<string, { name?: string }>;
  let names: string[] = [];
  try { names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { names = []; }
  const out: Array<{ folder: string; chromiumName: string | null }> = [];
  for (const n of names.sort()) {
    if (!isValidProfileDirectory(n)) continue;
    if (!(await exists(path.join(root, n, 'Preferences')))) continue;
    const cn = cache[n]?.name;
    out.push({ folder: n, chromiumName: typeof cn === 'string' && cn.trim() ? cn.trim() : null });
  }
  return out;
}

export class BranchRegistry {
  private chains = new Map<string, Promise<unknown>>();
  private cache = new Map<string, RegistryFile>();
  readonly profilesDir: string;

  constructor(readonly opts: BranchRegistryOptions) { this.profilesDir = opts.profilesDir; }

  private file(userId: string): string { return path.join(this.opts.profilesDir, userId, REGISTRY_FILE); }

  private serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(userId) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(userId, next.catch(() => undefined));
    return next;
  }

  private reindex(userId: string, f: RegistryFile): void {
    const out: IndexEntry[] = [];
    for (const p of f.profiles) {
      const b = f.branches.find((x) => x.id === p.branchId);
      if (b) out.push({ userId, profileId: p.id, branchId: b.id, leaseKey: b.leaseKey, root: b.root, folder: p.folder, name: p.name });
    }
    replaceIndexFor(userId, out);
  }

  private async save(userId: string, f: RegistryFile): Promise<void> {
    await writeJsonAtomic(this.file(userId), f);
    this.cache.set(userId, f);
    this.reindex(userId, f);
  }

  private async load(userId: string): Promise<RegistryFile> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    let f: RegistryFile | null = null;
    if (await exists(this.file(userId))) {
      try {
        const raw = JSON.parse(await fs.readFile(this.file(userId), 'utf8'));
        if (!raw || raw.version !== 1 || !Array.isArray(raw.branches) || !Array.isArray(raw.profiles)) throw new Error('unknown format');
        f = raw as RegistryFile;
      } catch (e) {
        // Never overwrite a registry we cannot read.
        throw new ProfileRegistryError(`The profile registry ${REGISTRY_FILE} is unreadable (${(e as Error).message.slice(0, 120)}); it was left untouched.`, 'io');
      }
    }
    const fresh = !f;
    if (!f) f = { version: 1, nextBranch: 1, branches: [], profiles: [] };
    let changed = this.dropRetiredRecords(f);
    if (await this.adoptPreBranchRoots(userId, f)) changed = true;
    if (this.opts.reconcileBase !== false && await this.reconcileBase(userId, f)) changed = true;
    if (fresh || changed) await this.save(userId, f);
    else { this.cache.set(userId, f); this.reindex(userId, f); }
    return f;
  }

  /** Next branch id: above the counter AND every branch-NNN seen in the file or on disk. Never reused. */
  private async allocBranch(f: RegistryFile): Promise<string> {
    let n = Math.max(1, f.nextBranch || 1);
    for (const b of f.branches) { const m = /^branch-(\d+)$/.exec(b.id); if (m) n = Math.max(n, Number(m[1]) + 1); }
    try {
      for (const d of await fs.readdir(this.opts.baseDir())) { const m = /^branch-(\d+)$/.exec(d); if (m) n = Math.max(n, Number(m[1]) + 1); }
    } catch { /* base not created yet */ }
    f.nextBranch = n + 1;
    return branchIdOf(n);
  }

  private log(line: string): void { (this.opts.log || ((l: string) => console.log(l)))(line); }

  /**
   * Records the pre-S34 registry stored that no longer exist as concepts:
   *   - the Local Browser branch (profile `local-browser`, kind
   *     'local-browser'): the root is RealChrome's, not a branch. It held
   *     branch-001 hidden from the UI (bug 2.1);
   *   - branches added "from outside Aria" (`external`): that feature is
   *     removed (brief 1.4). The record is forgotten, the folder is the
   *     user's and is NEVER deleted.
   * Every remaining record loses the retired flags (legacy / builtIn / kind).
   */
  private dropRetiredRecords(f: RegistryFile): boolean {
    let changed = false;
    const retired = new Set<string>();
    for (const b of f.branches as Array<BranchRecord & Record<string, unknown>>) {
      if (b.kind === 'local-browser' || b.external === true || f.profiles.some((p) => p.branchId === b.id && p.id === OLD_LOCAL_BROWSER_PROFILE_ID)) {
        retired.add(b.id);
        this.log(`[PROFILES] registry: dropped retired ${b.kind === 'local-browser' ? 'Local Browser' : 'outside-Aria'} branch record ${b.id} ("${b.label}"); its folder ${b.root} was left untouched`);
      }
    }
    if (retired.size) {
      f.branches = f.branches.filter((b) => !retired.has(b.id));
      f.profiles = f.profiles.filter((p) => !retired.has(p.branchId) && p.id !== OLD_LOCAL_BROWSER_PROFILE_ID);
      changed = true;
    }
    for (const b of f.branches as Array<BranchRecord & Record<string, unknown>>) {
      for (const k of ['legacy', 'builtIn', 'kind', 'external']) if (k in b) { delete b[k]; changed = true; }
    }
    for (const p of f.profiles as Array<ProfileRecord & Record<string, unknown>>) {
      if ('builtIn' in p) { delete p.builtIn; changed = true; }
    }
    return changed;
  }

  /**
   * Profile roots from before branches existed (`<PROFILES_DIR>/<user>/chrome-profile`
   * = profile `default`, `browser-profiles/<id>`), adopted IN PLACE as normal
   * branches, but only when they hold user data. An empty root is not a
   * branch (it used to become a hidden/empty "Default"). The folder is the
   * one Chromium already used (core/ChromiumProfileLocation); the lock key
   * stays the one the profile always had, so live Redis records stay valid.
   */
  private async adoptPreBranchRoots(userId: string, f: RegistryFile): Promise<boolean> {
    let changed = false;
    const now = new Date().toISOString();
    const known = new Set(f.profiles.map((p) => p.id));
    const knownRoots = new Set(f.branches.map((b) => path.resolve(b.root)));
    const adopt = async (id: string, root: string, name: string) => {
      if (known.has(id) || knownRoots.has(path.resolve(root))) return;
      if (!(await isDir(root)) || !(await holdsUserData(root))) return;
      const loc = await resolveChromiumProfile(root); // pins the folder Chromium already used; moves nothing
      const bid = await this.allocBranch(f);
      f.branches.push({ id: bid, label: name, root: path.resolve(root), leaseKey: legacyLeaseKey(id), createdAt: now, updatedAt: now, nextProfile: 1 });
      f.profiles.push({ id, branchId: bid, folder: loc.profileDirectory, name, createdAt: now, updatedAt: now });
      known.add(id); knownRoots.add(path.resolve(root));
      this.log(`[PROFILES] registry: adopted the existing profile root ${root} in place as ${bid} ("${name}")`);
      changed = true;
    };
    const defRoot = legacyProfileDir(this.opts.profilesDir, userId, DEFAULT_PROFILE_ID);
    await adopt(DEFAULT_PROFILE_ID, defRoot, (await readMetaName(defRoot)) || 'Default');
    let names: string[] = [];
    try {
      names = (await fs.readdir(path.join(this.opts.profilesDir, userId, 'browser-profiles'), { withFileTypes: true }))
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { names = []; }
    for (const n of names.sort()) {
      if (!sanitizeProfileId(n) || n === DEFAULT_PROFILE_ID) continue;
      const dir = path.join(this.opts.profilesDir, userId, 'browser-profiles', n);
      await adopt(n, dir, (await readMetaName(dir)) || n);
    }
    return changed;
  }

  /** Every branch root listed by ANY user's registry file (the base directory is shared). */
  private async rootsListedAnywhere(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const f of this.cache.values()) for (const b of f.branches) out.add(path.resolve(b.root));
    let users: string[] = [];
    try { users = (await fs.readdir(this.opts.profilesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { users = []; }
    for (const u of users) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.opts.profilesDir, u, REGISTRY_FILE), 'utf8'));
        for (const b of Array.isArray(raw?.branches) ? raw.branches : []) if (typeof b?.root === 'string') out.add(path.resolve(b.root));
      } catch { /* no or unreadable registry: nothing listed there */ }
    }
    return out;
  }

  /**
   * INVARIANT registry == disk under the base directory (brief 2.1). A
   * `branch-NNN` folder no registry lists is:
   *   - without user data -> removed (a leftover of an interrupted create);
   *   - with user data    -> listed as a normal branch "Branch N", its
   *     Chromium profile folders as profiles. Never destroyed.
   * Either way the counter moves past N, so the id is never reused.
   */
  private async reconcileBase(userId: string, f: RegistryFile): Promise<boolean> {
    let base: string;
    try { base = path.resolve(this.opts.baseDir()); } catch { return false; }
    let dirs: string[] = [];
    try { dirs = (await fs.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory() && /^branch-\d{3,}$/.test(d.name)).map((d) => d.name); } catch { return false; }
    if (!dirs.length) return false;
    const listed = await this.rootsListedAnywhere();
    for (const b of f.branches) listed.add(path.resolve(b.root));
    let changed = false;
    const now = new Date().toISOString();
    for (const d of dirs.sort()) {
      const root = path.join(base, d);
      if (listed.has(root)) continue;
      const n = Number(/^branch-(\d+)$/.exec(d)![1]);
      if (n + 1 > (f.nextBranch || 1)) { f.nextBranch = n + 1; changed = true; }
      if (!(await holdsUserData(root))) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          this.log(`[PROFILES] registry: removed ${root} (no registry lists it and it holds no user data)`);
        } catch (e) { this.log(`[PROFILES] registry: could not remove the empty unlisted folder ${root}: ${(e as Error).message}`); }
        continue;
      }
      if (f.branches.some((b) => b.id === d)) continue; // id taken by a branch elsewhere: leave the folder, never overwrite
      const found = await chromiumProfilesIn(root);
      f.branches.push({ id: d, label: `Branch ${n}`, root, leaseKey: `branch:${userId}/${d}`, createdAt: now, updatedAt: now, nextProfile: 1 });
      let i = 0;
      for (const p of found) {
        i++;
        let pid = newProfileId();
        while (f.profiles.some((x) => x.id === pid)) pid = newProfileId();
        f.profiles.push({ id: pid, branchId: d, folder: p.folder, name: p.chromiumName || `Profile ${i}`, createdAt: now, updatedAt: now });
      }
      this.log(`[PROFILES] registry: listed the unlisted folder ${root} as "Branch ${n}" (${found.length} profile(s)); its data was kept`);
      changed = true;
    }
    return changed;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  private entryOf(f: RegistryFile, p: ProfileRecord): ProfileEntry {
    const b = f.branches.find((x) => x.id === p.branchId);
    return {
      id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
      problem: b ? null : 'its branch is missing from the registry',
      lastOpenError: p.lastOpenError ?? null,
      branchId: p.branchId, branchLabel: b?.label || p.branchId, folder: p.folder,
    };
  }

  /** Every profile, by branch, then by name. Nothing is hidden. */
  async list(userId: string): Promise<ProfileEntry[]> {
    const f = await this.serial(userId, () => this.load(userId));
    return f.profiles
      .slice().sort((a, b) => a.branchId.localeCompare(b.branchId) || a.name.localeCompare(b.name))
      .map((p) => this.entryOf(f, p));
  }

  async get(userId: string, id: string): Promise<ProfileEntry | null> {
    const sid = sanitizeProfileId(id);
    if (!sid) return null;
    const f = await this.serial(userId, () => this.load(userId));
    const p = f.profiles.find((x) => x.id === sid);
    return p ? this.entryOf(f, p) : null;
  }

  async branches(userId: string): Promise<BranchRecord[]> {
    const f = await this.serial(userId, () => this.load(userId));
    return f.branches.map((b) => ({ ...b }));
  }

  async branch(userId: string, branchId: string): Promise<BranchRecord | null> {
    return (await this.branches(userId)).find((b) => b.id === branchId) || null;
  }

  async profilesOf(userId: string, branchId: string): Promise<ProfileEntry[]> {
    return (await this.list(userId)).filter((p) => p.branchId === branchId);
  }

  /** The branch root (Chromium --user-data-dir) of a profile; legacy formula when unknown. */
  dirOf(userId: string, id: string): string {
    return indexedProfile(id)?.root || legacyProfileDir(this.opts.profilesDir, userId, id);
  }

  /**
   * Where a REGISTRY profile is launched: its branch root (--user-data-dir)
   * and its folder (--profile-directory), read from the registry file itself.
   * No legacy fallback and no Local State: null when the registry does not
   * know both. Used by the manual Open path (POST /profiles/:id/open).
   */
  async locationOf(userId: string, id: string): Promise<{ root: string; folder: string } | null> {
    const sid = sanitizeProfileId(id);
    if (!sid) return null;
    const f = await this.serial(userId, () => this.load(userId));
    const p = f.profiles.find((x) => x.id === sid);
    const b = p ? f.branches.find((x) => x.id === p.branchId) : undefined;
    if (!p || !b || !isValidProfileDirectory(p.folder)) return null;
    return { root: path.resolve(b.root), folder: p.folder };
  }

  /** The profile's Chromium folder name (--profile-directory), or undefined when unknown. */
  folderOf(id: string): string | undefined { return indexedProfile(id)?.folder; }

  /** `<root>/<folder>`: where this profile's own state lives (snapshots, Profile Path). */
  profilePathOf(userId: string, id: string): string {
    const e = indexedProfile(id);
    return e ? path.join(e.root, e.folder) : path.join(legacyProfileDir(this.opts.profilesDir, userId, id), 'Default');
  }

  /** Load the registry (and its lock-key index) for `userId`: boot, before runs resolve profiles. */
  async warm(userId: string): Promise<void> { await this.serial(userId, () => this.load(userId)); }

  // ── writes ───────────────────────────────────────────────────────────────

  /** A new branch at `<base>/branch-NNN`. The user never types the path. */
  async createBranch(userId: string, rawLabel?: unknown): Promise<BranchRecord> {
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const id = await this.allocBranch(f);
      // No name typed: the system picks a unique display name "Branch N"
      // (owner brief 1.2 / 4.5: the UI never shows branch-NNN). Renameable.
      const label = rawLabel === undefined || rawLabel === null || rawLabel === '' ? freeBranchName(f, id) : normalizeName(rawLabel, 'Branch name');
      assertBranchNameFree(f, label, null);
      const root = path.resolve(this.opts.baseDir(), id);
      if (await exists(root)) throw new ProfileRegistryError(`The folder for ${id} already exists; a new branch is never created on existing data.`, 'io');
      try { await fs.mkdir(root, { recursive: true }); } catch (e) { throw new ProfileRegistryError(`Could not create the branch folder: ${(e as Error).message}`, 'io'); }
      const now = new Date().toISOString();
      const b: BranchRecord = { id, label, root, leaseKey: `branch:${userId}/${id}`, createdAt: now, updatedAt: now, nextProfile: 1 };
      f.branches.push(b);
      await this.save(userId, f);
      return { ...b };
    });
  }

  async renameBranch(userId: string, branchId: string, rawLabel: unknown): Promise<BranchRecord> {
    const label = normalizeName(rawLabel, 'Branch name');
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const b = f.branches.find((x) => x.id === branchId);
      if (!b) throw new ProfileRegistryError('Branch not found', 'branch_not_found');
      assertBranchNameFree(f, label, b.id);
      b.label = label; b.updatedAt = new Date().toISOString();
      await this.save(userId, f);
      return { ...b };
    });
  }

  /**
   * Create a profile in `branchId`, or in a NEW branch when it is 'new' or
   * absent. The folder `<root>/profile-NNN` is created now, so a missing
   * folder later means it was removed outside Aria.
   */
  async create(userId: string, rawName: unknown, opts: { branchId?: string | null; branchLabel?: unknown } = {}): Promise<ProfileEntry> {
    const name = normalizeName(rawName);
    let branchId = opts.branchId && opts.branchId !== 'new' ? opts.branchId : null;
    if (!branchId) branchId = (await this.createBranch(userId, opts.branchLabel)).id;
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const b = f.branches.find((x) => x.id === branchId);
      if (!b) throw new ProfileRegistryError('Branch not found', 'branch_not_found');
      assertProfileNameFree(f, b, name, null);
      let n = Math.max(1, b.nextProfile || 1);
      const used = new Set(f.profiles.filter((p) => p.branchId === b.id).map((p) => p.folder));
      let folder = profileFolderOf(n);
      while (used.has(folder) || await exists(path.join(b.root, folder))) { n++; folder = profileFolderOf(n); }
      b.nextProfile = n + 1;
      let id = newProfileId();
      while (f.profiles.some((p) => p.id === id)) id = newProfileId();
      try { await fs.mkdir(path.join(b.root, folder), { recursive: true }); } catch (e) { throw new ProfileRegistryError(`Could not create the profile folder: ${(e as Error).message}`, 'io'); }
      const now = new Date().toISOString();
      const rec: ProfileRecord = { id, branchId: b.id, folder, name, createdAt: now, updatedAt: now };
      f.profiles.push(rec);
      b.updatedAt = now;
      await this.save(userId, f);
      return this.entryOf(f, rec);
    });
  }

  /** Only the display name changes; id, branch, folder and references stay. */
  async rename(userId: string, id: string, rawName: unknown): Promise<ProfileEntry> {
    const name = normalizeName(rawName);
    if (!sanitizeProfileId(id)) throw new ProfileRegistryError('Invalid profile id', 'invalid_id');
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const p = f.profiles.find((x) => x.id === id);
      if (!p) throw new ProfileRegistryError('Profile not found', 'not_found');
      const b = f.branches.find((x) => x.id === p.branchId);
      if (b) assertProfileNameFree(f, b, name, p.id);
      p.name = name; p.updatedAt = new Date().toISOString();
      await this.save(userId, f);
      return this.entryOf(f, p);
    });
  }

  async recordOpenError(userId: string, id: string, message: string | null): Promise<void> {
    await this.serial(userId, async () => {
      const f = await this.load(userId);
      const p = f.profiles.find((x) => x.id === id);
      if (!p) return;
      if (!message && !p.lastOpenError) return;
      p.lastOpenError = message ? { at: new Date().toISOString(), message: message.slice(0, 500) } : null;
      await this.save(userId, f).catch(() => {});
    }).catch(() => {});
  }

  /** Delete a whole branch (folder + profile records). Safety is the CALLER's (routes: dependency scan). */
  async removeBranch(userId: string, branchId: string): Promise<{ removedProfiles: string[] }> {
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const b = f.branches.find((x) => x.id === branchId);
      if (!b) throw new ProfileRegistryError('Branch not found', 'branch_not_found');
      const removed = f.profiles.filter((p) => p.branchId === b.id).map((p) => p.id);
      await fs.rm(b.root, { recursive: true, force: true });
      f.branches = f.branches.filter((x) => x.id !== b.id);
      f.profiles = f.profiles.filter((p) => p.branchId !== b.id);
      // The counter must stay above this id even if it was the highest one.
      const m = /^branch-(\d+)$/.exec(b.id);
      if (m) f.nextBranch = Math.max(f.nextBranch || 1, Number(m[1]) + 1);
      await this.save(userId, f);
      return { removedProfiles: removed };
    });
  }

  /**
   * Delete ONE profile: its folder inside the branch and its record. The
   * branch stays (it may become empty). Safety is the CALLER's (routes:
   * deleteBlockers). The folder number is never reused (nextProfile).
   */
  async remove(userId: string, id: string): Promise<void> {
    if (!sanitizeProfileId(id)) throw new ProfileRegistryError('Invalid profile id', 'invalid_id');
    await this.serial(userId, async () => {
      const f = await this.load(userId);
      const p = f.profiles.find((x) => x.id === id);
      if (!p) throw new ProfileRegistryError('Profile not found', 'not_found');
      const b = f.branches.find((x) => x.id === p.branchId);
      if (b && isValidProfileDirectory(p.folder)) {
        const dir = path.join(path.resolve(b.root), p.folder);
        if (path.dirname(dir) === path.resolve(b.root)) await fs.rm(dir, { recursive: true, force: true });
        const m = /^profile-(\d+)$/.exec(p.folder);
        if (m) b.nextProfile = Math.max(b.nextProfile || 1, Number(m[1]) + 1);
        b.updatedAt = new Date().toISOString();
      }
      f.profiles = f.profiles.filter((x) => x.id !== id);
      await this.save(userId, f);
    });
  }

  /** Is the profile usable? Read-only: no folder is ever created here. */
  async check(userId: string, id: string): Promise<
    { ok: true; root: string; folder: string } | { ok: false; reason: 'record_missing' | 'branch_missing' | 'folder_missing'; detail: string }> {
    const sid = sanitizeProfileId(id);
    const f = await this.serial(userId, () => this.load(userId));
    const p = sid ? f.profiles.find((x) => x.id === sid) : undefined;
    if (!p) return { ok: false, reason: 'record_missing', detail: `profile "${id}" is not in the registry` };
    const b = f.branches.find((x) => x.id === p.branchId);
    if (!b) return { ok: false, reason: 'branch_missing', detail: `its branch ${p.branchId} is missing from the registry` };
    if (!(await isDir(b.root))) return { ok: false, reason: 'branch_missing', detail: `the folder of branch "${b.label}" is missing on disk` };
    if (!isValidProfileDirectory(p.folder) || !(await isDir(path.join(b.root, p.folder)))) {
      return { ok: false, reason: 'folder_missing', detail: `the profile folder of "${p.name}" is missing on disk` };
    }
    return { ok: true, root: b.root, folder: p.folder };
  }

  /** Drop the in-memory cache (tests, or after an external change). */
  forget(userId?: string): void { if (userId) this.cache.delete(userId); else this.cache.clear(); }
}
