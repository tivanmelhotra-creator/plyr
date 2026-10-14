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
 * MIGRATION WITHOUT MOVING DATA. On first use every pre-existing profile root
 * (registry `default`, `browser-profiles/<id>`, the Local Browser root) is
 * adopted as a LEGACY branch AT ITS CURRENT PATH, with the folder Chromium
 * already used (core/ChromiumProfileLocation adoption). Ids stay, so every
 * workflow reference keeps working. Nothing is copied, renamed or deleted.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { resolveChromiumProfile, isValidProfileDirectory, PIN_FILE } from './ChromiumProfileLocation';
import { sanitizeProfileId } from './ProfileLease';
import { indexedProfile, replaceIndexFor, type IndexEntry } from './ProfileIndex';

export { indexedProfile, indexedByLeaseKey } from './ProfileIndex';

export const DEFAULT_PROFILE_ID = 'default';
export const LOCAL_BROWSER_PROFILE_ID = 'local-browser';
export const REGISTRY_FILE = 'branches.json';
const NAME_MAX = 60;

export interface BranchRecord {
  id: string;
  label: string;
  root: string;
  leaseKey: string;
  createdAt: string;
  updatedAt: string;
  legacy?: boolean;
  builtIn?: boolean;
  kind?: 'local-browser' | 'profiles';
  nextProfile: number;
  /**
   * Added from OUTSIDE Aria (an existing Chromium data folder the user chose,
   * after a warning and a separate confirmation). Aria never deletes such a
   * folder: deleting the branch only forgets it.
   */
  external?: boolean;
}

/** What Aria found in an existing folder before the user confirms adding it. Read-only. */
export interface ExternalInspection {
  root: string;
  /** Chromium profile folders found (Default, Profile 1, ...), with Chromium's display name. */
  profiles: Array<{ folder: string; chromiumName: string | null }>;
  /** A browser seems to use it right now (SingletonLock / Windows lockfile present). */
  inUse: boolean;
  /** It looks like a personal browser's default data folder. */
  personal: boolean;
  /** Already registered (as a branch root or inside one). */
  alreadyRegistered: string | null;
  warnings: string[];
  errors: string[];
}

export interface ProfileRecord {
  id: string;
  branchId: string;
  folder: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
  lastOpenError?: { at: string; message: string } | null;
}

interface RegistryFile { version: 1; nextBranch: number; branches: BranchRecord[]; profiles: ProfileRecord[] }

/** What callers see of one profile (a superset of the former ProfileEntry). */
export interface ProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  builtIn: boolean;
  problem?: string | null;
  lastOpenError?: { at: string; message: string } | null;
  branchId: string;
  branchLabel: string;
  folder: string;
  kind: 'local-browser' | 'profiles';
}

export type RegistryErrorCode = 'invalid_name' | 'duplicate_name' | 'not_found' | 'builtin' | 'io' | 'invalid_id' | 'branch_not_found';

export class ProfileRegistryError extends Error {
  constructor(message: string, readonly code: RegistryErrorCode) { super(message); this.name = 'ProfileRegistryError'; }
}

export function normalizeName(raw: unknown, what = 'Profile name'): string {
  if (typeof raw !== 'string') throw new ProfileRegistryError(`${what} is required`, 'invalid_name');
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!v) throw new ProfileRegistryError(`${what} cannot be empty`, 'invalid_name');
  if (v.length > NAME_MAX) throw new ProfileRegistryError(`${what} must be at most ${NAME_MAX} characters`, 'invalid_name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ProfileRegistryError(`${what} contains control characters`, 'invalid_name');
  return v;
}
export const normalizeProfileName = (raw: unknown): string => normalizeName(raw);

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
  /** The Local Browser's root (REAL_CHROME_USER_DATA_DIR), adopted as a built-in branch. */
  localBrowserRoot?: () => string | null;
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
    const changed = await this.adoptLegacy(userId, f);
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

  private async adoptLegacy(userId: string, f: RegistryFile): Promise<boolean> {
    let changed = false;
    const now = new Date().toISOString();
    const known = new Set(f.profiles.map((p) => p.id));
    const adopt = async (id: string, root: string, label: string, leaseKey: string, extra: Partial<BranchRecord>, name: string) => {
      if (known.has(id)) return;
      const loc = await resolveChromiumProfile(root); // pins the folder Chromium already used; moves nothing
      const bid = await this.allocBranch(f);
      f.branches.push({ id: bid, label, root: path.resolve(root), leaseKey, createdAt: now, updatedAt: now, legacy: true, nextProfile: 1, kind: 'profiles', ...extra });
      f.profiles.push({ id, branchId: bid, folder: loc.profileDirectory, name, createdAt: now, updatedAt: now, ...(extra.builtIn ? { builtIn: true } : {}) });
      known.add(id);
      changed = true;
    };
    const lb = this.opts.localBrowserRoot?.();
    if (lb) await adopt(LOCAL_BROWSER_PROFILE_ID, lb, 'Local Browser', 'realchrome', { builtIn: true, kind: 'local-browser' }, 'Local Browser');
    const defRoot = legacyProfileDir(this.opts.profilesDir, userId, DEFAULT_PROFILE_ID);
    await adopt(DEFAULT_PROFILE_ID, defRoot, 'Default', legacyLeaseKey(DEFAULT_PROFILE_ID), { builtIn: true }, (await readMetaName(defRoot)) || 'Default');
    let names: string[] = [];
    try {
      names = (await fs.readdir(path.join(this.opts.profilesDir, userId, 'browser-profiles'), { withFileTypes: true }))
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { names = []; }
    for (const n of names.sort()) {
      if (!sanitizeProfileId(n) || n === DEFAULT_PROFILE_ID) continue;
      const dir = path.join(this.opts.profilesDir, userId, 'browser-profiles', n);
      const name = (await readMetaName(dir)) || n;
      await adopt(n, dir, name, legacyLeaseKey(n), {}, name);
    }
    return changed;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  private entryOf(f: RegistryFile, p: ProfileRecord): ProfileEntry {
    const b = f.branches.find((x) => x.id === p.branchId);
    return {
      id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
      builtIn: !!p.builtIn, problem: b ? null : 'its branch is missing from the registry',
      lastOpenError: p.lastOpenError ?? null,
      branchId: p.branchId, branchLabel: b?.label || p.branchId, folder: p.folder,
      kind: b?.kind === 'local-browser' ? 'local-browser' : 'profiles',
    };
  }

  /** Every profile: Default first, then by branch, then by name. The Local Browser only when asked. */
  async list(userId: string, opts: { includeLocalBrowser?: boolean } = {}): Promise<ProfileEntry[]> {
    const f = await this.serial(userId, () => this.load(userId));
    const order = (p: ProfileRecord) => (p.id === DEFAULT_PROFILE_ID ? 0 : p.id === LOCAL_BROWSER_PROFILE_ID ? 1 : 2);
    return f.profiles
      .filter((p) => opts.includeLocalBrowser || p.id !== LOCAL_BROWSER_PROFILE_ID)
      .slice().sort((a, b) => order(a) - order(b) || a.branchId.localeCompare(b.branchId) || a.name.localeCompare(b.name))
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
    return (await this.list(userId, { includeLocalBrowser: true })).filter((p) => p.branchId === branchId);
  }

  /** The branch root (Chromium --user-data-dir) of a profile; legacy formula when unknown. */
  dirOf(userId: string, id: string): string {
    return indexedProfile(id)?.root || legacyProfileDir(this.opts.profilesDir, userId, id);
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
      const label = rawLabel === undefined || rawLabel === null || rawLabel === '' ? id : normalizeName(rawLabel, 'Branch name');
      const root = path.resolve(this.opts.baseDir(), id);
      if (await exists(root)) throw new ProfileRegistryError(`The folder for ${id} already exists; a new branch is never created on existing data.`, 'io');
      try { await fs.mkdir(root, { recursive: true }); } catch (e) { throw new ProfileRegistryError(`Could not create the branch folder: ${(e as Error).message}`, 'io'); }
      const now = new Date().toISOString();
      const b: BranchRecord = { id, label, root, leaseKey: `branch:${userId}/${id}`, createdAt: now, updatedAt: now, nextProfile: 1, kind: 'profiles' };
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
      if (b.kind === 'local-browser') throw new ProfileRegistryError('Profiles cannot be added to the Local Browser branch.', 'builtin');
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

  /**
   * Read-only look at an existing folder (section 4): nothing is opened,
   * changed or written. The caller shows the warnings and asks for a SEPARATE
   * confirmation before `addExternalBranch`.
   */
  async inspectExternal(userId: string, rawRoot: unknown): Promise<ExternalInspection> {
    const root = typeof rawRoot === 'string' && rawRoot.trim() ? path.resolve(rawRoot.trim()) : '';
    const out: ExternalInspection = { root, profiles: [], inUse: false, personal: false, alreadyRegistered: null, warnings: [], errors: [] };
    if (!root || !path.isAbsolute(String(rawRoot).trim())) { out.errors.push('Use the full (absolute) path of an existing folder.'); return out; }
    if (!(await isDir(root))) { out.errors.push('The folder does not exist.'); return out; }
    const f = await this.serial(userId, () => this.load(userId));
    const reg = f.branches.find((b) => {
      const r = path.resolve(b.root);
      return r === root || root.startsWith(r + path.sep) || r.startsWith(root + path.sep);
    });
    if (reg) { out.alreadyRegistered = reg.id; out.errors.push(`This folder is already used by ${reg.id} ("${reg.label}").`); }
    let ls: any = null;
    try { ls = JSON.parse(await fs.readFile(path.join(root, 'Local State'), 'utf8')); } catch { ls = null; }
    const cache = (ls?.profile?.info_cache || {}) as Record<string, { name?: string }>;
    let names: string[] = [];
    try { names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { names = []; }
    for (const n of names.sort()) {
      if (!isValidProfileDirectory(n)) continue;
      if (!(await exists(path.join(root, n, 'Preferences')))) continue;
      out.profiles.push({ folder: n, chromiumName: typeof cache[n]?.name === 'string' ? cache[n]!.name! : null });
    }
    if (!ls && !out.profiles.length) out.errors.push('This is not a Chromium data folder (no "Local State" and no profile folders).');
    // Linux/macOS: SingletonLock (a symlink); Windows: lockfile.
    for (const f of ['SingletonLock', 'lockfile']) if (await fs.lstat(path.join(root, f)).then(() => true, () => false)) out.inUse = true;
    if (out.inUse) out.errors.push('A browser is using this folder right now. Close it first.');
    out.personal = /[\\/](User Data|\.config[\\/](chromium|google-chrome[^\\/]*|BraveSoftware[^\\/]*))$/i.test(root);
    if (out.personal) out.warnings.push('This looks like the data folder of your PERSONAL browser. Aria would open and change it (cookies, logins, history). Use a copy instead.');
    out.warnings.push('Aria will open this folder with its own browser and may change its data. Aria will NEVER delete it: deleting the branch only removes it from Aria.');
    return out;
  }

  /** Register an existing folder as an external branch. Nothing is moved, copied or deleted. */
  async addExternalBranch(userId: string, rawRoot: unknown, rawLabel?: unknown): Promise<{ branch: BranchRecord; profiles: ProfileEntry[] }> {
    const ins = await this.inspectExternal(userId, rawRoot);
    if (ins.errors.length) throw new ProfileRegistryError(ins.errors.join(' '), 'io');
    const label = rawLabel === undefined || rawLabel === null || rawLabel === '' ? path.basename(ins.root) : normalizeName(rawLabel, 'Branch name');
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const id = await this.allocBranch(f);
      const now = new Date().toISOString();
      const b: BranchRecord = { id, label, root: ins.root, leaseKey: `branch:${userId}/${id}`, createdAt: now, updatedAt: now, nextProfile: 1, kind: 'profiles', external: true };
      f.branches.push(b);
      const folders = ins.profiles.length ? ins.profiles : [{ folder: 'Default', chromiumName: null }];
      const added: ProfileRecord[] = [];
      for (const p of folders) {
        let pid = newProfileId();
        while (f.profiles.some((x) => x.id === pid)) pid = newProfileId();
        const rec: ProfileRecord = { id: pid, branchId: id, folder: p.folder, name: p.chromiumName || p.folder, createdAt: now, updatedAt: now };
        f.profiles.push(rec); added.push(rec);
      }
      await this.save(userId, f);
      return { branch: { ...b }, profiles: added.map((r) => this.entryOf(f, r)) };
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
      p.name = name; p.updatedAt = new Date().toISOString();
      await this.save(userId, f);
      return this.entryOf(f, p);
    });
  }

  /** Explicitly adopt a legacy profile id (creates its legacy root). Used by tools and tests only. */
  async ensure(userId: string, id: string): Promise<ProfileEntry | null> {
    const sid = sanitizeProfileId(id);
    if (!sid) return null;
    const cur = await this.get(userId, sid);
    if (cur) return cur;
    await fs.mkdir(legacyProfileDir(this.opts.profilesDir, userId, sid), { recursive: true });
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      if (await this.adoptLegacy(userId, f)) await this.save(userId, f);
      const p = f.profiles.find((x) => x.id === sid);
      return p ? this.entryOf(f, p) : null;
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

  /** Delete a whole branch (folder + profile records). Safety is the CALLER's (core/BranchDeletion). */
  async removeBranch(userId: string, branchId: string): Promise<{ removedProfiles: string[]; keptFolder?: string }> {
    return this.serial(userId, async () => {
      const f = await this.load(userId);
      const b = f.branches.find((x) => x.id === branchId);
      if (!b) throw new ProfileRegistryError('Branch not found', 'branch_not_found');
      if (b.builtIn) throw new ProfileRegistryError('This branch is built in and cannot be deleted.', 'builtin');
      const removed = f.profiles.filter((p) => p.branchId === b.id).map((p) => p.id);
      // A folder added from outside Aria is the user's: forget it, never delete it.
      if (!b.external) await fs.rm(b.root, { recursive: true, force: true });
      f.branches = f.branches.filter((x) => x.id !== b.id);
      f.profiles = f.profiles.filter((p) => p.branchId !== b.id);
      await this.save(userId, f); // nextBranch is untouched: the id is never reused
      return { removedProfiles: removed, ...(b.external ? { keptFolder: b.root } : {}) };
    });
  }

  /** A single profile is deleted by deleting its branch, and only when it is alone in it. */
  async remove(userId: string, id: string): Promise<void> {
    if (!sanitizeProfileId(id)) throw new ProfileRegistryError('Invalid profile id', 'invalid_id');
    const e = await this.get(userId, id);
    if (!e) throw new ProfileRegistryError('Profile not found', 'not_found');
    if (e.builtIn) throw new ProfileRegistryError('The default profile cannot be deleted', 'builtin');
    const siblings = (await this.profilesOf(userId, e.branchId)).filter((p) => p.id !== id);
    if (siblings.length) throw new ProfileRegistryError('This profile shares its branch with other profiles; delete the branch instead.', 'builtin');
    await this.removeBranch(userId, e.branchId);
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
      // A legacy built-in root whose browser never started has no profile folder yet: not breakage.
      const untouched = !!b.legacy && !(await exists(path.join(b.root, 'Local State')))
        && (await fs.readdir(b.root).then((xs) => xs.every((x) => x === PIN_FILE || x.startsWith('.plyr')), () => true));
      if (!untouched) return { ok: false, reason: 'folder_missing', detail: `the profile folder of "${p.name}" is missing on disk` };
    }
    return { ok: true, root: b.root, folder: p.folder };
  }

  /** Drop the in-memory cache (tests, or after an external change). */
  forget(userId?: string): void { if (userId) this.cache.delete(userId); else this.cache.clear(); }
}
