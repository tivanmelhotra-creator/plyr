/**
 * Owner brief 3.1 — display names (core/BranchRegistry), enforced on create
 * and rename only:
 *   - trim, collapse whitespace, reject empty; at most 24 characters counted
 *     as Unicode code points (Persian and emoji allowed);
 *   - branch names unique per user, profile names unique inside their branch,
 *     both case-insensitive; the same profile name in ANOTHER branch is fine;
 *   - renaming to the own name (other case) is allowed;
 *   - a new branch without a typed name gets "Branch N" (never branch-NNN);
 *   - existing data that breaks the rules still loads and is not renamed;
 *   - the routes answer 400 invalid_name / 409 duplicate_name with the
 *     owner's wording.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { normalizeName, nameKey, NAME_MAX, ProfileRegistryError } from '../../src/core/BranchRegistry';

const U = 'local';
let dir = '';
let reg: ProfileRegistry;
const mk = () => new ProfileRegistry(path.join(dir, 'profiles'), { baseDir: () => path.join(dir, 'base') });

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'plyr-names-')); reg = mk(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof ProfileRegistryError ? `${e.code}: ${e.message}` : String(e); }
}

describe('normalizeName (3.1)', () => {
  it('trims and collapses whitespace; rejects empty', () => {
    expect(normalizeName('  Work   Mail  ')).toBe('Work Mail');
    expect(() => normalizeName('   ')).toThrow(/cannot be empty/);
  });
  it('max is 24 characters, counted as code points (Persian / emoji)', () => {
    expect(NAME_MAX).toBe(24);
    expect(normalizeName('a'.repeat(24))).toHaveLength(24);
    expect(() => normalizeName('a'.repeat(25))).toThrow(/at most 24/);
    const fa = 'پروفایل کاری من برای فروش'; // 25 code points
    expect(Array.from(fa).length).toBe(25);
    expect(() => normalizeName(fa)).toThrow(/at most 24/);
    expect(normalizeName('پروفایل کاری من')).toBe('پروفایل کاری من');
    const emoji = '\u{1F600}'.repeat(24); // 48 UTF-16 units, 24 code points
    expect(normalizeName(emoji)).toBe(emoji);
  });
  it('case-insensitive key', () => {
    expect(nameKey('Work')).toBe(nameKey('WORK'));
    expect(nameKey('Ｗｏｒｋ')).toBe(nameKey('work')); // full-width folds (NFKC)
  });
});

describe('uniqueness (3.1)', () => {
  it('profile names are unique inside their branch, case-insensitive; another branch may reuse the name', async () => {
    const a = await reg.create(U, 'Shop');
    expect(await code(reg.create(U, 'shop', { branchId: a.branchId }))).toBe('duplicate_name: A profile named "Shop" already exists in this branch');
    expect(await code(reg.create(U, 'Shop', { branchId: 'new' }))).toBe('ok');
  });
  it('rename: to a sibling name is refused; to its own name in another case is allowed', async () => {
    const a = await reg.create(U, 'Shop');
    const b = await reg.create(U, 'Mail', { branchId: a.branchId });
    expect(await code(reg.rename(U, b.id, 'SHOP'))).toMatch(/^duplicate_name/);
    expect(await code(reg.rename(U, a.id, 'SHOP'))).toBe('ok');
  });
  it('branch names are unique per user, case-insensitive (create and rename)', async () => {
    const b1 = await reg.createBranch(U, 'Work');
    expect(await code(reg.createBranch(U, 'work'))).toBe('duplicate_name: A branch named "Work" already exists');
    const b2 = await reg.createBranch(U, 'Home');
    expect(await code(reg.renameBranch(U, b2.id, 'WORK'))).toMatch(/^duplicate_name/);
    expect(await code(reg.renameBranch(U, b1.id, 'WORK'))).toBe('ok');
  });
  it('a new branch without a name is "Branch N" (never branch-NNN) and skips a name the user took', async () => {
    const b1 = await reg.createBranch(U);
    expect(b1.id).toBe('branch-001');
    expect(b1.label).toBe('Branch 1');
    await reg.renameBranch(U, b1.id, 'Branch 2');
    const b2 = await reg.createBranch(U);
    expect(b2.id).toBe('branch-002');
    expect(b2.label).toBe('Branch 3');
  });
});

describe('existing data that breaks the rules (3.1)', () => {
  it('still loads unchanged; only a NEW create/rename is checked', async () => {
    const a = await reg.create(U, 'Seed');
    const file = path.join(dir, 'profiles', U, 'branches.json');
    const f = JSON.parse(readFileSync(file, 'utf8'));
    const long = 'A very long legacy profile name over the limit';
    f.profiles[0].name = long;
    f.profiles.push({ ...f.profiles[0], id: 'prf_aaaaaaaaaaaa', folder: 'profile-009', name: 'seed' });
    f.profiles.push({ ...f.profiles[0], id: 'prf_bbbbbbbbbbbb', folder: 'profile-010', name: 'SEED' });
    writeFileSync(file, JSON.stringify(f));
    const fresh = mk();
    const names = (await fresh.list(U)).map((p) => p.name).sort();
    expect(names).toEqual(['A very long legacy profile name over the limit', 'SEED', 'seed'].sort());
    // Unrelated rename works; the long name is not touched.
    expect(await code(fresh.rename(U, 'prf_aaaaaaaaaaaa', 'Other'))).toBe('ok');
    expect((await fresh.list(U)).find((p) => p.id === a.id)!.name).toBe(long);
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles.find((p: any) => p.id === a.id).name).toBe(long);
  });
});

describe('panel (jsdom): names in the UI (3.1, 1.2)', () => {
  it('maxlength 24, counter only from 20 chars, server error as a plain line under the input, branch display names only', async () => {
    const { JSDOM } = await import('jsdom');
    const src = readFileSync(path.join(__dirname, '..', '..', 'public/js/profile-manager.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><body><div id="h"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window as any;
    w.AppUtil = { t: (k: string) => k };
    w.API = { getKey: () => '' };
    w.open = () => ({ closed: false, location: { href: 'about:blank' }, document: {}, close() { this.closed = true; }, focus() {} });
    const profiles = [{ id: 'prf_a', name: 'A long name that is truncated', branchId: 'branch-002', branchLabel: 'branch-002', status: 'free', available: true, browser: { open: false }, usedBy: [] }];
    w.fetch = (url: string, init: any) => {
      const m = (init && init.method) || 'GET';
      let st = 200; let a: any = { success: true };
      if (url === '/profiles/branches') a = { success: true, branches: [{ id: 'branch-002', label: 'branch-002', profiles: ['prf_a'] }, { id: 'branch-003', label: 'Work', profiles: [] }] };
      else if (url.startsWith('/profiles') && m === 'GET') a = { success: true, profiles, unknownSchedules: [] };
      else if (url === '/profiles' && m === 'POST') { st = 409; a = { success: false, code: 'duplicate_name', error: 'A profile named "X" already exists in this branch' }; }
      return Promise.resolve({ ok: st < 400, status: st, text: () => Promise.resolve(JSON.stringify(a)) });
    };
    w.eval(src);
    w.ProfileManager.mount(w.document.getElementById('h'), { launchSettings: false });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    const q = (s: string) => w.document.querySelector(s);
    // Display names only: "Branch 2" for an old id-label, never branch-NNN.
    expect(q('.pm-branch-label').textContent).toBe('Branch 2');
    expect(w.document.body.textContent).not.toMatch(/branch-\d{3}|profile-\d{3}/);
    expect(q('.pm-name').title).toBe('A long name that is truncated');
    q('.pm-new').click();
    const opts = Array.from(q('.pm-branch-select').options).map((o: any) => o.textContent);
    expect(opts.join('|')).not.toMatch(/branch-\d{3}/);
    expect(opts.some((t: string) => t.startsWith('Work'))).toBe(true);
    const input = q('.pm-input');
    expect(input.maxLength).toBe(24);
    input.value = 'a'.repeat(19); input.dispatchEvent(new w.Event('input'));
    expect(q('.pm-name-count').hidden).toBe(true);
    input.value = 'a'.repeat(21); input.dispatchEvent(new w.Event('input'));
    expect(q('.pm-name-count').hidden).toBe(false);
    expect(q('.pm-name-count').textContent).toBe('21/24');
    q('.pm-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(q('.pm-form').hidden).toBe(false);
    expect(q('.pm-form-error').hidden).toBe(false);
    expect(q('.pm-form-error').textContent).toBe('A profile named "X" already exists in this branch');
  });
});
