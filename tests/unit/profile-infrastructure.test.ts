/**
 * Phase-1 profile infrastructure, pure parts + the on-disk registry.
 *
 *   ProfileRegistry   stable id, rename keeps id/dir/references, legacy adoption,
 *                     unreadable metadata = needs review (never hidden / rewritten)
 *   BrowserSessions   dependents decide every close; waits are not idleness
 *   BrowserLifecycle  keep / close after a run, never under another dependent
 *   ProfileAccess     status + denial sentences
 *   RunPolicy         visibility follows how the run started, not the environment
 *   ProfileCoordinator owner of a job, occurrence of a scheduled run
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileRegistry, ProfileRegistryError, profileDirFor } from '../../src/core/ProfileRegistry';
import { BrowserSessions, decideClose, isIdle, jobDependent, operatorDependent } from '../../src/core/BrowserSessions';
import { decideAfterRun, outcomeOfError, afterRunPolicyOf } from '../../src/core/BrowserLifecycle';
import { deriveStatus, explainDenial } from '../../src/core/ProfileAccess';
import { blockingUntil, blocks, findOverlaps, occurrences, windowOf } from '../../src/core/ProfileReservations';
import { headlessFor, runOriginOf } from '../../src/core/RunPolicy';
import { ownerOfJob, occurrenceOf } from '../../src/core/ProfileCoordinator';
import { leaseIdOf, resolveRunProfile } from '../../src/core/ProfileLease';

let dir = '';
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'plyr-prof-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ProfileRegistry', () => {
  it('a fresh registry lists NOTHING: no automatic Default branch or profile (brief 1.5 / 2.1)', async () => {
    const R = new ProfileRegistry(dir);
    expect(await R.list('local')).toEqual([]);
    expect(await R.branches('local')).toEqual([]);
    // An EMPTY pre-branch Default root is not data: still nothing listed.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(dir, 'local', 'chrome-profile'), { recursive: true });
    R.forget();
    expect(await R.list('local')).toEqual([]);
  });

  it('create gives a stable prf_ id in a new branch-NNN with folder profile-NNN; names are not keys', async () => {
    const R = new ProfileRegistry(dir);
    const p = await R.create('local', '  Shop   Account ');
    expect(p.id).toMatch(/^prf_[0-9a-f]{12}$/);
    expect(p.name).toBe('Shop Account');
    expect(p.branchId).toMatch(/^branch-\d{3}$/);
    expect(p.folder).toBe('profile-001');
    expect(existsSync(path.join(R.dirOf('local', p.id), 'profile-001'))).toBe(true);
    // Display names are not unique keys (owner's model).
    const twin = await R.create('local', 'shop account');
    expect(twin.id).not.toBe(p.id);
    await expect(R.create('local', '')).rejects.toBeInstanceOf(ProfileRegistryError);
  });

  it('rename changes only the name: id, directory and data stay', async () => {
    const R = new ProfileRegistry(dir);
    const p = await R.create('local', 'A');
    const cookie = path.join(R.dirOf('local', p.id), 'Cookies');
    writeFileSync(cookie, 'data');
    const r = await R.rename('local', p.id, 'B');
    expect(r.id).toBe(p.id);
    expect(readFileSync(cookie, 'utf8')).toBe('data');
    expect((await R.get('local', p.id))!.name).toBe('B');
  });

  it('no profile is special: an adopted pre-branch Default can be renamed AND deleted like any other', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(dir, 'local', 'chrome-profile', 'Default'), { recursive: true });
    writeFileSync(path.join(dir, 'local', 'chrome-profile', 'Default', 'Preferences'), '{}');
    const R = new ProfileRegistry(dir);
    expect((await R.list('local')).map((p) => p.id)).toEqual(['default']);
    await R.rename('local', 'default', 'Main');
    expect((await R.list('local'))[0]!.name).toBe('Main');
    await R.remove('local', 'default');
    expect(await R.list('local')).toEqual([]);
  });

  it('adopts a pre-branch named root WITH data unchanged (the old name stays the id, the lock name too)', async () => {
    const { mkdirSync } = await import('node:fs');
    const root = profileDirFor(dir, 'local', 'shop');
    mkdirSync(path.join(root, 'Default'), { recursive: true });
    writeFileSync(path.join(root, 'Default', 'Preferences'), '{}');
    const R = new ProfileRegistry(dir);
    const e = await R.get('local', 'shop');
    expect(e!.id).toBe('shop');
    expect(R.dirOf('local', 'shop')).toBe(root);
    const ref = resolveRunProfile({ userId: 'local', profileId: 'shop', usesExtensions: false, localMode: false, profilesDir: dir, realChromeDir: '/rc' });
    expect(ref.id).toBe(leaseIdOf('shop'));
    expect(ref.userDataDir).toBe(R.dirOf('local', 'shop'));
  });

  it('an unreadable registry file is never overwritten; operations refuse with io', async () => {
    const R = new ProfileRegistry(dir);
    await R.create('local', 'X');
    const file = path.join(dir, 'local', 'branches.json');
    writeFileSync(file, '{broken');
    const R2 = new ProfileRegistry(dir);
    await expect(R2.list('local')).rejects.toMatchObject({ code: 'io' });
    await expect(R2.create('local', 'Y')).rejects.toMatchObject({ code: 'io' });
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('a failed open is remembered for the user and cleared by a successful one', async () => {
    const R = new ProfileRegistry(dir);
    const p = await R.create('local', 'Z');
    await R.recordOpenError('local', p.id, 'no display');
    expect((await R.get('local', p.id))!.lastOpenError!.message).toBe('no display');
    await R.recordOpenError('local', p.id, null);
    expect((await R.get('local', p.id))!.lastOpenError).toBeNull();
  });

  it('concurrent creates are serialised: distinct ids, branches and folders, ids never reused', async () => {
    const R = new ProfileRegistry(dir);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => R.create('local', `P${i}`)));
    expect(new Set(res.map((r) => r.id)).size).toBe(6);
    expect(new Set(res.map((r) => r.branchId)).size).toBe(6);
  });

  it('refuses ids that are not plain path segments', async () => {
    const R = new ProfileRegistry(dir);
    expect(await R.get('local', '../etc')).toBeNull();
    await expect(R.remove('local', '../x')).rejects.toMatchObject({ code: 'invalid_id' });
  });
  it("pre-branch migration with temp fixtures (old Default, old named profile, last_used pointing elsewhere): adopted in place, nothing moved, registry folder used, last_used ignored; the Local Browser root is NOT a branch", async () => {
    const { mkdirSync } = await import("node:fs");
    const { resolveChromiumProfile, withProfileSelection } = await import("../../src/core/ChromiumProfileLocation");

    const profilesDir = path.join(dir, "profiles");
    const baseDir = path.join(dir, "branches-base");
    const localBrowserRoot = path.join(profilesDir, "chrome-profile"); // REAL_CHROME_USER_DATA_DIR default shape
    const defaultRoot = path.join(profilesDir, "local", "chrome-profile");
    const namedRoot = path.join(profilesDir, "local", "browser-profiles", "shop-legacy");

    // 1. The Local Browser root (RealChrome's): with data, but never a branch
    mkdirSync(path.join(localBrowserRoot, "Profile 2"), { recursive: true });
    writeFileSync(path.join(localBrowserRoot, "Profile 2", "Cookies"), "lb-cookie");
    writeFileSync(path.join(localBrowserRoot, "Local State"), JSON.stringify({ profile: { last_used: "Profile 2" } }));

    // 2. Old Default root where Default folder has cookies
    mkdirSync(path.join(defaultRoot, "Default"), { recursive: true });
    writeFileSync(path.join(defaultRoot, "Default", "Cookies"), "def-cookie");
    writeFileSync(path.join(defaultRoot, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }));

    // 3. Old named profile with .plyr-profile.json and Profile 1 active
    mkdirSync(path.join(namedRoot, "Profile 1"), { recursive: true });
    writeFileSync(path.join(namedRoot, "Profile 1", "Cookies"), "shop-cookie");
    writeFileSync(path.join(namedRoot, ".plyr-profile.json"), JSON.stringify({ name: "My Legacy Shop" }));
    writeFileSync(path.join(namedRoot, "Local State"), JSON.stringify({ profile: { last_used: "Profile 1" } }));

    const R = new ProfileRegistry(profilesDir, { baseDir: () => baseDir });

    const list = await R.list("local");
    const branches = await R.branches("local");
    expect(list.map((p) => p.id).sort()).toEqual(["default", "shop-legacy"].sort());
    // The numbering starts at branch-001 and every branch is listed (bug 2.1).
    expect(branches.map((b) => b.id)).toEqual(["branch-001", "branch-002"]);
    expect(branches.some((b) => path.resolve(b.root) === localBrowserRoot)).toBe(false);

    // Adopted in place: roots are the exact original temp directories, and baseDir was not even created.
    expect(R.dirOf("local", "default")).toBe(defaultRoot);
    expect(R.dirOf("local", "shop-legacy")).toBe(namedRoot);
    expect(existsSync(baseDir)).toBe(false);
    for (const b of branches) expect(Object.keys(b).sort()).toEqual(["createdAt", "id", "label", "leaseKey", "nextProfile", "root", "updatedAt"]);

    // Nothing moved or deleted: original files are intact in place.
    expect(readFileSync(path.join(localBrowserRoot, "Profile 2", "Cookies"), "utf8")).toBe("lb-cookie");
    expect(readFileSync(path.join(defaultRoot, "Default", "Cookies"), "utf8")).toBe("def-cookie");
    expect(readFileSync(path.join(namedRoot, "Profile 1", "Cookies"), "utf8")).toBe("shop-cookie");

    // Registry folders recorded from initial adoption:
    expect(R.folderOf("default")).toBe("Default");
    expect(R.folderOf("shop-legacy")).toBe("Profile 1");
    expect((await R.get("local", "shop-legacy"))!.name).toBe("My Legacy Shop");

    // Now mutate Local State.profile.last_used in every root to point elsewhere (e.g. Profile 99):
    for (const r of [defaultRoot, namedRoot]) {
      mkdirSync(path.join(r, "Profile 99"), { recursive: true });
      writeFileSync(path.join(r, "Local State"), JSON.stringify({ profile: { last_used: "Profile 99" } }));
    }

    // Launching uses the registry folder explicitly and ignores last_used:
    for (const [id, expectedRoot, expectedFolder] of [
      ["default", defaultRoot, "Default"],
      ["shop-legacy", namedRoot, "Profile 1"],
    ] as const) {
      const loc = await resolveChromiumProfile(R.dirOf("local", id), R.folderOf(id));
      expect(loc).toMatchObject({
        userDataRoot: expectedRoot,
        profileDirectory: expectedFolder,
        profilePath: path.join(expectedRoot, expectedFolder),
        source: "registry",
      });
      expect(withProfileSelection([], loc)).toEqual([`--profile-directory=${expectedFolder}`]);
    }
  });
});

describe('BrowserSessions: dependents decide every close', () => {
  it('a browser another run depends on cannot be closed by a run that is not its exclusive owner', () => {
    const S = new BrowserSessions(null);
    S.opened('named:a', { userId: 'local', visibility: 'visible', createdBy: jobDependent(1) });
    S.attach('named:a', jobDependent(1));
    S.attach('named:a', operatorDependent('wf_x'));
    const d = S.canClose('named:a', jobDependent(1));
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason === 'in_use' && d.dependents).toEqual([operatorDependent('wf_x')]);
    S.detach('named:a', operatorDependent('wf_x'));
    expect(S.canClose('named:a', jobDependent(1)).ok).toBe(true);
  });

  it('launching a browser grants no right to close it once shared', () => {
    const S = new BrowserSessions(null);
    S.opened('k', { userId: 'u', visibility: 'visible', createdBy: operatorDependent('wf') });
    S.attach('k', jobDependent(9));
    expect(S.canClose('k', operatorDependent('wf')).ok).toBe(false);
  });

  it('a deliberate Wait is not idleness: any dependent keeps the browser alive', () => {
    const rec = { leaseId: 'k', userId: 'u', visibility: 'hidden' as const, createdBy: 'x', startedAt: 0, lastActivity: 0, dependents: [jobDependent(1)], instance: 'i' };
    expect(isIdle(rec, 10 * 3600_000, 10 * 60_000)).toBe(false);
    expect(isIdle({ ...rec, dependents: [] }, 10 * 3600_000, 10 * 60_000)).toBe(true);
    expect(isIdle({ ...rec, dependents: [] }, 10 * 3600_000, 0)).toBe(false); // "never"
  });

  it('dependents survive a relaunch of the same profile; close forgets them', () => {
    const S = new BrowserSessions(null);
    S.opened('k', { userId: 'u', visibility: 'hidden', createdBy: 'a' });
    S.attach('k', jobDependent(1));
    S.opened('k', { userId: 'u', visibility: 'visible', createdBy: 'a' });
    expect(S.get('k')!.dependents).toEqual([jobDependent(1)]);
    S.closed('k');
    expect(decideClose(S.get('k'), 'x')).toEqual({ ok: false, reason: 'not_open' });
  });
});

describe('BrowserLifecycle: after the run', () => {
  const base = { ownBrowser: true, otherDependents: [] as string[], sessionOpen: true };
  it('close is the default; keep is honoured after success', () => {
    expect(afterRunPolicyOf(undefined)).toBe('close');
    expect(afterRunPolicyOf('keep')).toBe('keep');
    expect(decideAfterRun({ ...base, policy: 'keep', outcome: 'success' })).toEqual({ action: 'keep', why: 'policy' });
    expect(decideAfterRun({ ...base, policy: 'keep', outcome: 'cancelled' })).toEqual({ action: 'keep', why: 'policy' });
  });
  it('close closes after success / cancel, only when no one else depends on it', () => {
    expect(decideAfterRun({ ...base, policy: 'close', outcome: 'success' })).toEqual({ action: 'close' });
    expect(decideAfterRun({ ...base, policy: 'close', outcome: 'cancelled' })).toEqual({ action: 'close' });
    expect(decideAfterRun({ ...base, policy: 'close', outcome: 'success', otherDependents: ['operator:wf'] })).toEqual({ action: 'keep', why: 'in_use' });
  });
  it('errors and timeouts close the browser (state saved first by the worker); keep is ignored then', () => {
    for (const policy of ['close', 'keep'] as const) {
      expect(decideAfterRun({ ...base, policy, outcome: 'error' })).toEqual({ action: 'close' });
      expect(decideAfterRun({ ...base, policy, outcome: 'timeout' })).toEqual({ action: 'close' });
    }
    // ...but never a browser somebody else depends on.
    expect(decideAfterRun({ ...base, policy: 'keep', outcome: 'error', otherDependents: ['operator:wf'] })).toEqual({ action: 'keep', why: 'in_use' });
  });
  it("never closes a browser that is not the run's own (local mode, Real Chrome)", () => {
    expect(decideAfterRun({ ...base, ownBrowser: false, policy: 'close', outcome: 'success' })).toEqual({ action: 'keep', why: 'shared' });
  });
  it('classifies outcomes', () => {
    expect(outcomeOfError('CANCELLED_BY_USER', false)).toBe('cancelled');
    expect(outcomeOfError('Step 3 timed out after 30000ms', false)).toBe('timeout');
    expect(outcomeOfError('boom', false)).toBe('error');
  });
});

describe('status and reasons', () => {
  it('unknown / broken never reads as free', () => {
    expect(deriveStatus({ problem: 'x' })).toBe('needs_review');
    expect(deriveStatus({ lastOpenError: { at: '', message: 'x' } })).toBe('needs_review');
    expect(deriveStatus({ lease: { profileId: 'p', jobId: 'j', token: 't', instance: 'i', acquiredAt: 0 } })).toBe('in_use');
    expect(deriveStatus({ activeReservation: { id: 'r', owner: 'w', occurrence: 0, start: 0, end: 1, state: 'planned' } })).toBe('reserved');
    expect(deriveStatus({})).toBe('free');
  });
  it('a refusal names the workflow and the window', () => {
    const msg = explainDenial('reserved', { reservation: { ownerName: 'Nightly', start: Date.UTC(2030, 0, 1, 9, 50), end: Date.UTC(2030, 0, 1, 10, 10) } })!;
    expect(msg).toContain('Nightly');
    expect(msg).toContain('09:50');
    expect(msg).toContain('10:10');
  });
});

describe('reservation windows (pure)', () => {
  it('a 10:00 schedule with 10/10 margins reserves 09:50-10:10', () => {
    const t = Date.UTC(2030, 0, 1, 10, 0);
    const w = windowOf(t, { beforeMs: 600_000, afterMs: 600_000 });
    expect(new Date(w.start).toISOString().slice(11, 16)).toBe('09:50');
    expect(new Date(w.end).toISOString().slice(11, 16)).toBe('10:10');
  });
  it('blocking ends at max(window end, real end); missed never blocks; own owner is never blocked', () => {
    const r = { id: 'r', owner: 'a', occurrence: 0, start: 0, end: 100, state: 'settled' as const, settledAt: 250 };
    expect(blockingUntil(r)).toBe(250);
    expect(blockingUntil({ ...r, settledAt: 10 })).toBe(100);
    expect(blockingUntil({ ...r, state: 'fired' })).toBe(Infinity);
    expect(blockingUntil({ ...r, state: 'missed' })).toBe(0);
    expect(blocks(r, 'b', 200)).toBe(true);
    expect(blocks(r, 'a', 200)).toBe(false);
  });
  it('occurrences follow the cron in its timezone', () => {
    const from = Date.UTC(2030, 0, 1, 0, 0);
    const occ = occurrences('0 10 * * *', from, from + 2 * 86_400_000, { tz: 'UTC' });
    expect(occ.map((t) => new Date(t).toISOString())).toEqual(['2030-01-01T10:00:00.000Z', '2030-01-02T10:00:00.000Z']);
    expect(occurrences('not a cron', from, from + 1)).toEqual([]);
  });
  it('overlaps are only reported between different owners', () => {
    const mk = (owner: string, s: number, e: number) => ({ id: owner + s, owner, occurrence: s, start: s, end: e, state: 'planned' as const });
    const m = new Map([['p', [mk('a', 0, 10), mk('a', 5, 15), mk('b', 12, 20), mk('c', 30, 40)]]]);
    const o = findOverlaps(m);
    expect(o.map((x) => [x.a.owner, x.b.owner])).toEqual([['a', 'b']]);
  });
});

describe('visibility follows how the run started (not the environment)', () => {
  it('manual = visible, everything else = hidden', () => {
    expect(headlessFor(runOriginOf('manual'))).toBe(false);
    expect(headlessFor(runOriginOf('automatic'))).toBe(true);
    expect(headlessFor(runOriginOf(undefined))).toBe(true);
    expect(headlessFor(runOriginOf('production'))).toBe(true);
  });
});

describe('ProfileCoordinator helpers', () => {
  it('the owner of a run is its workflow; raw schedules and one-off runs own themselves', () => {
    expect(ownerOfJob({ __workflowId: 'wf_1' }, 5)).toBe('wf_1');
    expect(ownerOfJob({ __scheduleWorkflowId: 'wf_2', __workflowId: 'wf_2' }, 5)).toBe('wf_2');
    expect(ownerOfJob({ __workspace: { workflowId: 'wf_3' } }, 5)).toBe('wf_3');
    expect(ownerOfJob({ __scheduleId: 'sched:local:1:x' }, 5)).toBe('schedule:sched:local:1:x');
    expect(ownerOfJob({}, 5)).toBe('job:5');
  });
  it('a scheduled run knows its planned time (BullMQ prevMillis)', () => {
    expect(occurrenceOf({ opts: { prevMillis: 123 } } as any)).toBe(123);
    expect(occurrenceOf({ opts: {} } as any)).toBeNull();
  });
});
