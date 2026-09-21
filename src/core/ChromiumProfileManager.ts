import { randomUUID } from 'crypto';

export type ProfileStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'deleting';
export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed' | 'error';

export interface ChromiumProfile {
  id: string;
  name: string;
  chromeUserDataDir: string;
  extensions: string[];
  status: ProfileStatus;
  runtimeId?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface RuntimeHandle {
  runtimeId: string;
  profileId: string;
  status: RuntimeStatus;
  startedAt: number;
  pid?: number;
  cdpPort?: number;
  stop: () => Promise<void>;
}

export interface RuntimeFactory {
  start(profile: ChromiumProfile, runtimeId: string): Promise<RuntimeHandle>;
}

export class ChromiumProfileManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromiumProfileManagerError';
  }
}

/**
 * Owns durable Profile identity and replaceable Chromium runtime incarnations.
 *
 * This manager intentionally does not expose BrowserContext or Page objects to
 * workflow nodes. A runtime factory owns those implementation details, while
 * this class enforces one live incarnation per profile and isolates recovery to
 * the affected profile.
 */
export class ChromiumProfileManager {
  private readonly profiles = new Map<string, ChromiumProfile>();
  private readonly runtimes = new Map<string, RuntimeHandle>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly factory: RuntimeFactory) {}

  createProfile(input: { id?: string; name: string; chromeUserDataDir: string; extensions?: string[] }): ChromiumProfile {
    const id = String(input.id || `profile_${randomUUID()}`).trim();
    if (!id || this.profiles.has(id)) throw new ChromiumProfileManagerError(`Profile already exists: ${id}`);
    const now = Date.now();
    const profile: ChromiumProfile = {
      id,
      name: String(input.name || id).trim() || id,
      chromeUserDataDir: input.chromeUserDataDir,
      extensions: [...new Set(input.extensions || [])],
      status: 'stopped',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    this.profiles.set(id, profile);
    return { ...profile, extensions: [...profile.extensions] };
  }

  listProfiles(): ChromiumProfile[] {
    return [...this.profiles.values()].map((profile) => ({ ...profile, extensions: [...profile.extensions] }));
  }

  getProfile(profileId: string): ChromiumProfile | undefined {
    const profile = this.profiles.get(profileId);
    return profile ? { ...profile, extensions: [...profile.extensions] } : undefined;
  }

  currentRuntime(profileId: string): RuntimeHandle | undefined {
    const profile = this.requireProfile(profileId);
    return profile.runtimeId ? this.runtimes.get(profile.runtimeId) : undefined;
  }

  async start(profileId: string): Promise<RuntimeHandle> {
    return this.withProfileLock(profileId, async () => {
      const profile = this.requireProfile(profileId);
      const existing = this.currentRuntime(profileId);
      if (existing && existing.status === 'running') return existing;

      profile.status = 'starting';
      profile.updatedAt = Date.now();
      const runtimeId = `${profileId}:runtime:${randomUUID()}`;
      try {
        const runtime = await this.factory.start({ ...profile, extensions: [...profile.extensions] }, runtimeId);
        if (runtime.profileId !== profileId || runtime.runtimeId !== runtimeId) {
          throw new ChromiumProfileManagerError('Runtime factory returned an invalid identity.');
        }
        this.runtimes.set(runtimeId, runtime);
        profile.runtimeId = runtimeId;
        profile.status = 'running';
        profile.lastUsedAt = Date.now();
        profile.updatedAt = Date.now();
        return runtime;
      } catch (error) {
        profile.status = 'error';
        profile.updatedAt = Date.now();
        throw error;
      }
    });
  }

  async stop(profileId: string): Promise<void> {
    await this.withProfileLock(profileId, async () => {
      const profile = this.requireProfile(profileId);
      const runtime = this.currentRuntime(profileId);
      if (!runtime) {
        profile.status = 'stopped';
        profile.updatedAt = Date.now();
        return;
      }
      profile.status = 'stopping';
      profile.updatedAt = Date.now();
      try {
        await runtime.stop();
        runtime.status = 'stopped';
        this.runtimes.delete(runtime.runtimeId);
        profile.runtimeId = undefined;
        profile.status = 'stopped';
        profile.updatedAt = Date.now();
      } catch (error) {
        profile.status = 'error';
        profile.updatedAt = Date.now();
        throw error;
      }
    });
  }

  async restart(profileId: string): Promise<RuntimeHandle> {
    await this.stop(profileId);
    return this.start(profileId);
  }

  /** Recover only this profile; a new runtime incarnation is always created. */
  async recover(profileId: string): Promise<RuntimeHandle> {
    await this.stop(profileId).catch(() => undefined);
    return this.start(profileId);
  }

  async delete(profileId: string): Promise<void> {
    await this.withProfileLock(profileId, async () => {
      const profile = this.requireProfile(profileId);
      if (profile.runtimeId) throw new ChromiumProfileManagerError('Stop the profile before deleting it.');
      profile.status = 'deleting';
      this.profiles.delete(profileId);
    });
  }

  markRuntimeCrashed(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return;
    runtime.status = 'crashed';
    const profile = this.profiles.get(runtime.profileId);
    if (profile && profile.runtimeId === runtimeId) {
      profile.status = 'error';
      profile.updatedAt = Date.now();
    }
  }

  private requireProfile(profileId: string): ChromiumProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new ChromiumProfileManagerError(`Unknown profile: ${profileId}`);
    return profile;
  }

  private async withProfileLock<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(profileId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(profileId, previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(profileId) === current) this.locks.delete(profileId);
    }
  }
}
