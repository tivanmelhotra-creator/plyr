/**
 * AuthStore — the owner's password and everything derived from it.
 *
 * ONE install, ONE owner. In production the owner chooses a password on first
 * run (POST /auth/setup); it is stored ONLY as a salted scrypt hash in
 * `auth.json` next to the database (mode 0600, atomic write). Nothing about the
 * password is ever logged, returned or kept in plaintext.
 *
 * The password is NOT an API credential. It is exchanged once (POST /auth/login)
 * for a stateless SESSION `s1.<expiry>.<mac>`. The mac is keyed to a random
 * install secret AND an `epoch` that is bumped whenever the password is set or
 * changed, so changing the password ends every older session.
 *
 * Separate from both, the server has an INTERNAL service credential (`svc_…`)
 * for its own side-loaded extension / Inspector, and `derive(purpose)` for other
 * subsystems that need a stable secret. None of these is ever shown to a user.
 *
 * FAIL CLOSED: an `auth.json` that exists but cannot be read or parsed is state
 * `unavailable` — setup and login are refused. It is never silently replaced,
 * because that would re-open first-run setup to whoever asks first.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

type Env = Record<string, string | undefined>;

interface AuthData {
  version: 1;
  /** Random install secret (base64). Keys sessions, the service token, derive(). */
  secret: string;
  /** Bumped when the password is set/changed: ends every older session. */
  epoch: number;
  createdAt: string;
  passwordHash?: string;
  passwordSetAt?: string;
}

// ── Password policy ─────────────────────────────────────────────────────────

export const PASSWORD_POLICY = {
  minLength: 10,
  // Not a product limit: a guard so a request cannot make scrypt hash megabytes.
  maxLength: 512,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
} as const;

export type PasswordProblemCode = 'too_short' | 'too_long' | 'no_upper' | 'no_lower' | 'no_digit';
export interface PasswordProblem { code: PasswordProblemCode; message: string }

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblemCode, string> = {
  too_short: `Use at least ${PASSWORD_POLICY.minLength} characters.`,
  too_long: `Use at most ${PASSWORD_POLICY.maxLength} characters.`,
  no_upper: 'Include at least one uppercase English letter (A-Z).',
  no_lower: 'Include at least one lowercase English letter (a-z).',
  no_digit: 'Include at least one digit (0-9).',
};

/** Every rule the password breaks ([] = acceptable). The ONLY place rules live. */
export function passwordProblems(pw: unknown): PasswordProblem[] {
  const out: PasswordProblem[] = [];
  const add = (code: PasswordProblemCode): void => { out.push({ code, message: PASSWORD_PROBLEM_TEXT[code] }); };
  if (typeof pw !== 'string') {
    add('too_short'); add('no_upper'); add('no_lower'); add('no_digit');
    return out;
  }
  if (pw.length < PASSWORD_POLICY.minLength) add('too_short');
  if (pw.length > PASSWORD_POLICY.maxLength) add('too_long');
  if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(pw)) add('no_upper');
  if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(pw)) add('no_lower');
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(pw)) add('no_digit');
  return out;
}

// ── Hashing (scrypt, salted, format: scrypt$N$r$p$saltB64$hashB64) ───────────

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
// scrypt needs ~128*N*r bytes; Node's default cap (32 MiB) is exactly N=32768,r=8.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

function scryptAsync(pw: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyHash(pw: string, stored: string): Promise<boolean> {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
    // A hostile/corrupt file must not make us allocate unbounded memory.
    if (!Number.isInteger(n) || n < 1024 || n > 1 << 20 || (n & (n - 1)) !== 0) return false;
    if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    if (salt.length < 8 || want.length < 16) return false;
    const got = await scryptAsync(pw, salt, n, r, p, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Constant-time string comparison (equal-length digests, so length does not leak). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type AuthState = 'unset' | 'set' | 'unavailable';

// ── The store ────────────────────────────────────────────────────────────────

export class AuthStore {
  private data: AuthData | null = null;
  private loaded = false;
  private loadError: string | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: Env = process.env) {}

  /** Where the hash lives; '' = in-memory only (tests). */
  filePath(): string {
    const explicit = (this.env.AUTH_FILE || '').trim();
    if (explicit) return path.resolve(explicit);
    if (this.env.VITEST || this.env.NODE_ENV === 'test') return '';
    const db = (this.env.SQLITE_PATH || '').trim() || './data/plyr.db';
    return path.join(path.dirname(path.resolve(db)), 'auth.json');
  }

  // -- loading / persistence --------------------------------------------------

  private fresh(): AuthData {
    return { version: 1, secret: randomBytes(32).toString('base64'), epoch: 1, createdAt: new Date().toISOString() };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadError = null;
    const file = this.filePath();
    if (!file) { this.data = this.fresh(); return; }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = this.fresh();
        // Persist the secret now so sessions/service credential survive a restart
        // even before a password exists. A failure here is not fatal: setup
        // re-tries the write and reports `not_saved` if it still cannot.
        this.persist(this.data);
        return;
      }
      this.data = null;
      this.loadError = `cannot read ${file}: ${(e as Error).message}`;
      return;
    }
    try {
      const j = JSON.parse(raw) as Partial<AuthData>;
      const okHash = j.passwordHash === undefined
        || (typeof j.passwordHash === 'string' && j.passwordHash.startsWith('scrypt$'));
      if (!j || j.version !== 1 || typeof j.secret !== 'string' || j.secret.length < 16
        || !Number.isInteger(j.epoch) || (j.epoch as number) < 1 || !okHash) {
        throw new Error('unexpected structure');
      }
      this.data = {
        version: 1,
        secret: j.secret,
        epoch: j.epoch as number,
        createdAt: typeof j.createdAt === 'string' ? j.createdAt : new Date().toISOString(),
        ...(j.passwordHash ? { passwordHash: j.passwordHash } : {}),
        ...(typeof j.passwordSetAt === 'string' ? { passwordSetAt: j.passwordSetAt } : {}),
      };
    } catch (e) {
      this.data = null;
      this.loadError = `${file} is not a valid auth file (${(e as Error).message})`;
    }
  }

  /** Atomic, owner-only write. Returns false when it could not be saved. */
  private persist(d: AuthData): boolean {
    const file = this.filePath();
    if (!file) return true; // memory-only
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* non-POSIX fs */ }
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.error(`[AUTH] could not write ${file}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Serialise mutations so two simultaneous setups cannot both succeed. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  // -- state --------------------------------------------------------------------

  unavailableReason(): string | null { this.load(); return this.loadError; }

  state(): AuthState {
    this.load();
    if (this.loadError || !this.data) return 'unavailable';
    return this.data.passwordHash ? 'set' : 'unset';
  }

  isConfigured(): boolean { return this.state() === 'set'; }

  // -- derived secrets ------------------------------------------------------------

  private key(label: string): Buffer | null {
    this.load();
    if (!this.data) return null;
    return createHmac('sha256', Buffer.from(this.data.secret, 'base64')).update(label).digest();
  }

  /** A stable secret for another subsystem (never the password). '' when unusable. */
  derive(purpose: string): string {
    const k = this.key(`derive:${purpose}`);
    return k ? k.toString('hex') : '';
  }

  /** INTERNAL credential (side-loaded extension, Inspector). Never shown to a user. */
  serviceToken(): string {
    const k = this.key('service-v1');
    return k ? `svc_${k.toString('base64url')}` : '';
  }

  isServiceToken(presented: string): boolean {
    const t = this.serviceToken();
    return !!t && typeof presented === 'string' && safeEqual(presented, t);
  }

  // -- password ---------------------------------------------------------------------

  async setInitialPassword(pw: string): Promise<{ ok: true } | { ok: false; reason: 'already_set' | 'unavailable' | 'weak' | 'not_saved'; problems?: PasswordProblem[] }> {
    if (this.state() === 'unavailable') return { ok: false, reason: 'unavailable' };
    const problems = passwordProblems(pw);
    if (problems.length) return { ok: false, reason: 'weak', problems };
    if (this.state() === 'set') return { ok: false, reason: 'already_set' };
    const hash = await hashPassword(pw);
    return this.serial(async () => {
      // Re-check: another request may have won while we were hashing.
      if (this.state() !== 'unset') return { ok: false as const, reason: 'already_set' as const };
      const d = this.data as AuthData;
      const next: AuthData = { ...d, passwordHash: hash, epoch: d.epoch + 1, passwordSetAt: new Date().toISOString() };
      if (!this.persist(next)) return { ok: false as const, reason: 'not_saved' as const };
      this.data = next;
      return { ok: true as const };
    });
  }

  async verifyPassword(pw: unknown): Promise<boolean> {
    if (this.state() !== 'set' || typeof pw !== 'string' || pw.length === 0 || pw.length > PASSWORD_POLICY.maxLength) return false;
    return verifyHash(pw, (this.data as AuthData).passwordHash as string);
  }

  async changePassword(current: string, next: string): Promise<{ ok: true } | { ok: false; reason: 'wrong_password' | 'weak' | 'unavailable' | 'not_set' | 'not_saved' | 'same'; problems?: PasswordProblem[] }> {
    const st = this.state();
    if (st === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (st !== 'set') return { ok: false, reason: 'not_set' };
    if (!(await this.verifyPassword(current))) return { ok: false, reason: 'wrong_password' };
    const problems = passwordProblems(next);
    if (problems.length) return { ok: false, reason: 'weak', problems };
    if (current === next) return { ok: false, reason: 'same' };
    const hash = await hashPassword(next);
    return this.serial(async () => {
      const d = this.data as AuthData;
      const upd: AuthData = { ...d, passwordHash: hash, epoch: d.epoch + 1, passwordSetAt: new Date().toISOString() };
      if (!this.persist(upd)) return { ok: false as const, reason: 'not_saved' as const };
      this.data = upd;
      return { ok: true as const };
    });
  }

  // -- sessions -----------------------------------------------------------------------

  private sessionMac(exp: string): string {
    const d = this.data as AuthData;
    return createHmac('sha256', Buffer.from(d.secret, 'base64')).update(`session:${d.epoch}:${exp}`).digest('base64url');
  }

  issueSession(now: number = Date.now()): { token: string; expiresAt: number } {
    if (this.state() !== 'set') throw new Error('no owner password is set');
    const expiresAt = now + SESSION_TTL_MS;
    const exp = String(expiresAt);
    return { token: `s1.${exp}.${this.sessionMac(exp)}`, expiresAt };
  }

  verifySession(token: string, now: number = Date.now()): boolean {
    if (typeof token !== 'string' || !token.startsWith('s1.') || this.state() !== 'set') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const exp = Number(parts[1]);
    if (!Number.isFinite(exp) || exp <= now || exp > now + SESSION_TTL_MS + 60_000) return false;
    return safeEqual(parts[2], this.sessionMac(parts[1]));
  }

  /** Tests only: forget the in-memory copy so the next call re-reads the file. */
  resetForTests(): void {
    this.data = null; this.loaded = false; this.loadError = null; this.busy = Promise.resolve();
  }
}

export const authStore = new AuthStore();
