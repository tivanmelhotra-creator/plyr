/**
 * auth-store.test.ts — the owner password: policy, hashing, persistence,
 * sessions. Real scrypt, real files in a temp dir (no mocks: the thing under
 * test IS what lands on disk).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AuthStore, passwordProblems, hashPassword, verifyHash, PASSWORD_POLICY, SESSION_TTL_MS,
} from '../../src/core/AuthStore';

let dir: string;
let file: string;
const store = () => new AuthStore({ AUTH_FILE: file } as NodeJS.ProcessEnv);
const GOOD = 'Correct-Horse-9';

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-auth-')); file = path.join(dir, 'auth.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('password policy (the single copy of the rules)', () => {
  const codes = (pw: unknown) => passwordProblems(pw).map((p) => p.code);

  it('accepts upper + lower + digit at the minimum length, with no fixed cap below 512', () => {
    expect(codes('Abcdefgh12')).toEqual([]);
    expect(codes('Aa1' + 'x'.repeat(200))).toEqual([]);
    expect(PASSWORD_POLICY.minLength).toBeGreaterThanOrEqual(10);
  });

  it('names every broken rule', () => {
    expect(codes('Ab1')).toContain('too_short');
    expect(codes('abcdefghij1')).toContain('no_upper');
    expect(codes('ABCDEFGHIJ1')).toContain('no_lower');
    expect(codes('Abcdefghijk')).toContain('no_digit');
    expect(codes('')).toEqual(expect.arrayContaining(['too_short', 'no_upper', 'no_lower', 'no_digit']));
  });

  it('only counts ENGLISH letters (a Persian/accented letter is not an A-Z)', () => {
    expect(codes('پسوردخیلیقوی123')).toEqual(expect.arrayContaining(['no_upper', 'no_lower']));
    expect(codes('éÉéÉéÉéÉ12')).toEqual(expect.arrayContaining(['no_upper', 'no_lower']));
  });

  it('rejects non-strings and absurd lengths (scrypt DoS guard)', () => {
    expect(codes(undefined)).not.toEqual([]);
    expect(codes(12345678901 as unknown)).not.toEqual([]);
    expect(codes('Aa1' + 'x'.repeat(PASSWORD_POLICY.maxLength))).toContain('too_long');
  });
});

describe('hashing', () => {
  it('is salted scrypt, verifies, and never contains the password', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(a).not.toBe(b);                               // random salt
    expect(a).not.toContain(GOOD);
    expect(await verifyHash(GOOD, a)).toBe(true);
    expect(await verifyHash(GOOD + 'x', a)).toBe(false);
    expect(await verifyHash(GOOD, 'garbage')).toBe(false);
  });

  it('refuses a stored hash with absurd cost parameters instead of allocating for it', async () => {
    expect(await verifyHash(GOOD, 'scrypt$1073741824$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA==')).toBe(false);
  });
});

describe('first-run setup and persistence', () => {
  it('starts unset, sets once, then refuses a second setup', async () => {
    const s = store();
    expect(s.state()).toBe('unset');
    expect((await s.setInitialPassword(GOOD)).ok).toBe(true);
    expect(s.state()).toBe('set');
    const again = await s.setInitialPassword('Another-Pass-77');
    expect(again).toMatchObject({ ok: false, reason: 'already_set' });
    expect(await s.verifyPassword(GOOD)).toBe(true);     // first one still wins
  });

  it('rejects a weak password server-side with the reasons, and stays unset', async () => {
    const s = store();
    const r = await s.setInitialPassword('weakpass');
    expect(r).toMatchObject({ ok: false, reason: 'weak' });
    expect((r as { problems: unknown[] }).problems.length).toBeGreaterThan(0);
    expect(s.state()).toBe('unset');
  });

  it('two simultaneous setups: exactly one wins', async () => {
    const s = store();
    const [a, b] = await Promise.all([s.setInitialPassword(GOOD), s.setInitialPassword('Second-Pass-12')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('persists to auth.json: mode 0600, hash only, no plaintext anywhere', async () => {
    const s = store();
    await s.setInitialPassword(GOOD);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(GOOD);
    expect(raw).toContain('scrypt$');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // nothing else was left behind in the directory (no tmp file, no copy)
    expect(fs.readdirSync(dir)).toEqual(['auth.json']);
  });

  it('survives a restart: a new instance reads the same state and password', async () => {
    const s1 = store();
    await s1.setInitialPassword(GOOD);
    const session = s1.issueSession().token;
    const svc = s1.serviceToken();
    const s2 = store();                                   // "process restart"
    expect(s2.state()).toBe('set');
    expect(await s2.verifyPassword(GOOD)).toBe(true);
    expect(await s2.verifyPassword('Wrong-Pass-1')).toBe(false);
    expect(s2.verifySession(session)).toBe(true);
    expect(s2.serviceToken()).toBe(svc);
    expect((await s2.setInitialPassword('Hijack-Pass-9')).ok).toBe(false);
  });

  it('a missing file is "unset" and creates the secret at once (so restarts keep sessions stable)', () => {
    const s = store();
    expect(s.state()).toBe('unset');
    expect(fs.existsSync(file)).toBe(true);
    expect(store().serviceToken()).toBe(s.serviceToken());
  });

  it('FAILS CLOSED on a corrupt file: unavailable, no setup, no login, never silently reset', async () => {
    fs.writeFileSync(file, '{ not json');
    const s = store();
    expect(s.state()).toBe('unavailable');
    expect(s.unavailableReason()).toBeTruthy();
    expect(await s.setInitialPassword(GOOD)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await s.verifyPassword(GOOD)).toBe(false);
    expect(() => s.issueSession()).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');   // untouched
  });

  it('an unreadable/invalid structure is also unavailable (not "unset")', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, passwordHash: 42 }));
    expect(store().state()).toBe('unavailable');
  });
});

describe('sessions', () => {
  it('verify, expire, and reject tampering', async () => {
    const s = store();
    await s.setInitialPassword(GOOD);
    const now = Date.now();
    const { token, expiresAt } = s.issueSession(now);
    expect(expiresAt - now).toBe(SESSION_TTL_MS);
    expect(s.verifySession(token, now + 1000)).toBe(true);
    expect(s.verifySession(token, expiresAt + 1)).toBe(false);
    const [p, exp, mac] = token.split('.');
    expect(s.verifySession(`${p}.${Number(exp) + 999999}.${mac}`, now)).toBe(false);
    expect(s.verifySession(`${p}.${exp}.${mac.slice(0, -2)}xx`, now)).toBe(false);
    expect(s.verifySession('s1.1.2', now)).toBe(false);
    expect(s.verifySession('', now)).toBe(false);
  });

  it('a session from another install (other secret) is refused', async () => {
    const s = store();
    await s.setInitialPassword(GOOD);
    const other = new AuthStore({ AUTH_FILE: path.join(dir, 'other.json') } as NodeJS.ProcessEnv);
    await other.setInitialPassword(GOOD);
    expect(s.verifySession(other.issueSession().token)).toBe(false);
  });

  it('changing the password ends every session and keeps the file free of plaintext', async () => {
    const s = store();
    await s.setInitialPassword(GOOD);
    const old = s.issueSession().token;
    expect(await s.changePassword('Wrong-Pass-1', 'Brand-New-Pass-5')).toMatchObject({ ok: false, reason: 'wrong_password' });
    expect(await s.changePassword(GOOD, 'weak')).toMatchObject({ ok: false, reason: 'weak' });
    expect(await s.changePassword(GOOD, GOOD)).toMatchObject({ ok: false, reason: 'same' });
    expect(s.verifySession(old)).toBe(true);              // failed attempts changed nothing
    expect((await s.changePassword(GOOD, 'Brand-New-Pass-5')).ok).toBe(true);
    expect(s.verifySession(old)).toBe(false);
    expect(await s.verifyPassword(GOOD)).toBe(false);
    expect(await s.verifyPassword('Brand-New-Pass-5')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/Brand-New-Pass-5|Correct-Horse-9/);
    expect(s.verifySession(s.issueSession().token)).toBe(true);
  });
});

describe('internal credentials are separate from the password', () => {
  it('service token and derived secrets are stable, distinct, and never the password', async () => {
    const s = store();
    await s.setInitialPassword(GOOD);
    expect(s.serviceToken()).toMatch(/^svc_/);
    expect(s.serviceToken()).not.toContain(GOOD);
    expect(s.derive('a')).not.toBe(s.derive('b'));
    expect(s.derive('a')).toBe(store().derive('a'));
    expect(s.isServiceToken(s.serviceToken())).toBe(true);
    expect(s.isServiceToken(GOOD)).toBe(false);
    expect(s.isServiceToken(s.issueSession().token)).toBe(false);
  });

  it('the service token does NOT change when the password changes (the extension keeps working)', async () => {
    const s = store();
    await s.setInitialPassword(GOOD);
    const before = s.serviceToken();
    await s.changePassword(GOOD, 'Brand-New-Pass-5');
    expect(s.serviceToken()).toBe(before);
  });
});
