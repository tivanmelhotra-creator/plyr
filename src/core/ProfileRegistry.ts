/**
 * ProfileRegistry — the ONE list of browser profiles (identity + display name).
 *
 * Four concepts are kept apart in this codebase:
 *
 *   PROFILE      durable browser identity (a user-data-dir: cookies, logins)  <- this file
 *   SESSION      a live browser on a profile                                   core/BrowserSessions
 *   RUN          one execution of a workflow                                   BullMQ job
 *   RESERVATION  a time-bounded claim on a profile                             core/ProfileLease (+Reservations)
 *
 * STABLE ID, SEPARATE NAME. Before this module a profile WAS its name (the
 * string typed in Workflow Settings was the directory and the lock name), so
 * a rename was impossible without breaking every workflow pointing at it. Now
 * the `id` never changes (directory + lock name) and the display `name` lives
 * in a small meta file INSIDE the profile directory, so identity and data can
 * never drift apart and no database is needed (works with both drivers).
 *
 * Legacy references (a workflow that stored `shop`) are ADOPTED: the old value
 * becomes the id unchanged, so stored references keep working; the display
 * name starts equal to it and can be renamed. New profiles get `prf_<hex>`.
 * `default` always exists; it can be renamed, never deleted.
 *
 * A profile whose meta file is unreadable is listed with `problem` set (status
 * "needs review"), never hidden and never silently rewritten.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { sanitizeProfileId } from './ProfileLease';

export const DEFAULT_PROFILE_ID = 'default';
export const META_FILE = '.plyr-profile.json';
const NAME_MAX = 60;

export interface ProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  builtIn: boolean;
  /** Set when the profile cannot be read reliably (=> "needs review"). */
  problem?: string | null;
  /** Last failure to start this profile's browser; cleared by a successful open. */
  lastOpenError?: { at: string; message: string } | null;
}

export type RegistryErrorCode = 'invalid_name' | 'duplicate_name' | 'not_found' | 'builtin' | 'io' | 'invalid_id';

export class ProfileRegistryError extends Error {
  constructor(message: string, readonly code: RegistryErrorCode) {
    super(message);
    this.name = 'ProfileRegistryError';
  }
}

export function normalizeProfileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ProfileRegistryError('Profile name is required', 'invalid_name');
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!v) throw new ProfileRegistryError('Profile name cannot be empty', 'invalid_name');
  if (v.length > NAME_MAX) throw new ProfileRegistryError(`Profile name must be at most ${NAME_MAX} characters`, 'invalid_name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ProfileRegistryError('Profile name contains control characters', 'invalid_name');
  return v;
}

export function newProfileId(): string {
  return `prf_${randomBytes(6).toString('hex')}`;
}

/** Where a profile's user-data-dir lives (same rule as ProfileLease.resolveRunProfile). */
export function profileDirFor(profilesDir: string, userId: string, id: string): string {
  return id === DEFAULT_PROFILE_ID
    ? path.join(profilesDir, userId, 'chrome-profile')
    : path.join(profilesDir, userId, 'browser-profiles', id);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

export class ProfileRegistry {
  /** Writes are check-then-write: one chain per user keeps them serial. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(readonly profilesDir: string) {}

  dirOf(userId: string, id: string): string {
    return profileDirFor(this.profilesDir, userId, id);
  }

  private serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(userId) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(userId, next.catch(() => undefined));
    return next;
  }

  private async readEntry(userId: string, id: string): Promise<ProfileEntry | null> {
    const dir = this.dirOf(userId, id);
    const builtIn = id === DEFAULT_PROFILE_ID;
    let raw: string | null = null;
    try { raw = await fs.readFile(path.join(dir, META_FILE), 'utf8'); } catch { raw = null; }
    if (raw === null) {
      if (!builtIn && !(await exists(dir))) return null;
      const now = new Date(0).toISOString();
      return { id, name: builtIn ? 'Default' : id, createdAt: now, updatedAt: now, builtIn, problem: null };
    }
    try {
      const m = JSON.parse(raw) as Partial<ProfileEntry>;
      return {
        id,
        name: typeof m.name === 'string' && m.name.trim() ? m.name : id,
        createdAt: m.createdAt || new Date(0).toISOString(),
        updatedAt: m.updatedAt || m.createdAt || new Date(0).toISOString(),
        builtIn,
        problem: null,
        lastOpenError: m.lastOpenError ?? null,
      };
    } catch (e) {
      return {
        id, name: id, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), builtIn,
        problem: `profile metadata is unreadable (${(e as Error).message.slice(0, 120)})`,
      };
    }
  }

  private async writeEntry(userId: string, e: ProfileEntry): Promise<void> {
    const dir = this.dirOf(userId, e.id);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, META_FILE), {
      id: e.id, name: e.name, createdAt: e.createdAt, updatedAt: e.updatedAt,
      ...(e.lastOpenError ? { lastOpenError: e.lastOpenError } : {}),
    });
  }

  /** Every profile: the default first, then by display name. */
  async list(userId: string): Promise<ProfileEntry[]> {
    const def = await this.readEntry(userId, DEFAULT_PROFILE_ID);
    const rest: ProfileEntry[] = [];
    let names: string[] = [];
    try {
      names = (await fs.readdir(path.join(this.profilesDir, userId, 'browser-profiles'), { withFileTypes: true }))
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { names = []; }
    for (const n of names) {
      if (!sanitizeProfileId(n) || n === DEFAULT_PROFILE_ID) continue;
      const e = await this.readEntry(userId, n);
      if (e) rest.push(e);
    }
    rest.sort((a, b) => a.name.localeCompare(b.name));
    return def ? [def, ...rest] : rest;
  }

  async get(userId: string, id: string): Promise<ProfileEntry | null> {
    const sid = sanitizeProfileId(id);
    return sid ? this.readEntry(userId, sid) : null;
  }

  /** Register a profile referenced by a workflow (legacy adoption). Idempotent. */
  async ensure(userId: string, id: string): Promise<ProfileEntry | null> {
    const sid = sanitizeProfileId(id);
    if (!sid) return null;
    return this.serial(userId, async () => {
      const cur = await this.readEntry(userId, sid);
      if (cur?.problem) return cur; // never overwrite an unreadable record
      if (cur && (await exists(path.join(this.dirOf(userId, sid), META_FILE)))) return cur;
      const now = new Date().toISOString();
      const e: ProfileEntry = { id: sid, name: cur?.name || sid, createdAt: now, updatedAt: now, builtIn: sid === DEFAULT_PROFILE_ID, problem: null };
      await this.writeEntry(userId, e);
      return e;
    });
  }

  private assertUnique(all: ProfileEntry[], name: string, exceptId?: string): void {
    const n = name.toLocaleLowerCase();
    const dup = all.find((p) => p.id !== exceptId && p.name.toLocaleLowerCase() === n);
    if (dup) throw new ProfileRegistryError(`A profile named "${dup.name}" already exists`, 'duplicate_name');
  }

  /** Create a profile. Never starts a browser: opening is a separate operation. */
  async create(userId: string, rawName: unknown): Promise<ProfileEntry> {
    const name = normalizeProfileName(rawName);
    return this.serial(userId, async () => {
      this.assertUnique(await this.list(userId), name);
      let id = newProfileId();
      while (await exists(this.dirOf(userId, id))) id = newProfileId();
      const now = new Date().toISOString();
      const e: ProfileEntry = { id, name, createdAt: now, updatedAt: now, builtIn: false, problem: null };
      try {
        await this.writeEntry(userId, e);
      } catch (err) {
        await fs.rm(this.dirOf(userId, id), { recursive: true, force: true }).catch(() => {});
        throw new ProfileRegistryError(`Could not create the profile: ${(err as Error).message}`, 'io');
      }
      return e;
    });
  }

  /** Only the display name changes; id, directory and every reference stay. */
  async rename(userId: string, id: string, rawName: unknown): Promise<ProfileEntry> {
    const name = normalizeProfileName(rawName);
    const sid = sanitizeProfileId(id);
    if (!sid) throw new ProfileRegistryError('Invalid profile id', 'invalid_id');
    return this.serial(userId, async () => {
      const cur = await this.readEntry(userId, sid);
      if (!cur) throw new ProfileRegistryError('Profile not found', 'not_found');
      if (cur.problem) throw new ProfileRegistryError(`Profile needs review: ${cur.problem}`, 'io');
      this.assertUnique(await this.list(userId), name, sid);
      const next: ProfileEntry = { ...cur, name, updatedAt: new Date().toISOString() };
      await this.writeEntry(userId, next);
      return next;
    });
  }

  async recordOpenError(userId: string, id: string, message: string | null): Promise<void> {
    const sid = sanitizeProfileId(id);
    if (!sid) return;
    await this.serial(userId, async () => {
      const cur = await this.readEntry(userId, sid);
      if (!cur || cur.problem) return;
      if (!message && !cur.lastOpenError) return;
      const next: ProfileEntry = { ...cur, lastOpenError: message ? { at: new Date().toISOString(), message: message.slice(0, 500) } : null };
      await this.writeEntry(userId, next).catch(() => {});
    });
  }

  /** Delete a profile + its data. The CALLER decides safety (ProfileAccess.deleteBlockers). */
  async remove(userId: string, id: string): Promise<void> {
    const sid = sanitizeProfileId(id);
    if (!sid) throw new ProfileRegistryError('Invalid profile id', 'invalid_id');
    if (sid === DEFAULT_PROFILE_ID) throw new ProfileRegistryError('The default profile cannot be deleted', 'builtin');
    return this.serial(userId, async () => {
      const cur = await this.readEntry(userId, sid);
      if (!cur) throw new ProfileRegistryError('Profile not found', 'not_found');
      await fs.rm(this.dirOf(userId, sid), { recursive: true, force: true });
    });
  }
}
