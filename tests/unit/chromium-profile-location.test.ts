/**
 * core/ChromiumProfileLocation — which Chromium data a launch selects.
 *
 * The four identities stay apart (profile id / user-data root / profile
 * directory / display name); every launch pins `--profile-directory`; an
 * existing root is ADOPTED with the directory it already used and nothing is
 * moved, renamed or deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveChromiumProfile, withProfileSelection, isValidProfileDirectory, pinnedDirectoryOf,
  adoptableProfileDirectory, verifyProfileSelected, PIN_FILE, DEFAULT_PROFILE_DIRECTORY,
} from '../../src/core/ChromiumProfileLocation';
import { applyChromiumProfileName, readChromiumProfileName } from '../../src/core/ChromiumProfileName';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { leaseIdOf } from '../../src/core/ProfileLease';
import { buildLaunchArgs } from '../../src/core/LaunchSettings';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'plyr-loc-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const localState = (dir: string, data: unknown) => writeFileSync(path.join(dir, 'Local State'), JSON.stringify(data));

describe('resolveChromiumProfile', () => {
  it('a fresh root pins Default and creates nothing else', async () => {
    const loc = await resolveChromiumProfile(root);
    expect(loc).toMatchObject({ userDataRoot: path.resolve(root), profileDirectory: 'Default', profilePath: path.join(root, 'Default'), source: 'adopted-default' });
    expect(JSON.parse(readFileSync(path.join(root, PIN_FILE), 'utf8')).profileDirectory).toBe('Default');
    expect(readdirSync(root)).toEqual([PIN_FILE]);
  });

  it('adopts the directory an existing root already used (last_used), without moving data', async () => {
    mkdirSync(path.join(root, 'Default'));
    mkdirSync(path.join(root, 'Profile 1'));
    writeFileSync(path.join(root, 'Profile 1', 'Cookies'), 'p1-data');
    localState(root, { profile: { last_used: 'Profile 1' } });
    const loc = await resolveChromiumProfile(root);
    expect(loc.profileDirectory).toBe('Profile 1');
    expect(loc.source).toBe('adopted-last-used');
    // Data untouched, both directories still there.
    expect(readFileSync(path.join(root, 'Profile 1', 'Cookies'), 'utf8')).toBe('p1-data');
    expect(existsSync(path.join(root, 'Default'))).toBe(true);
  });

  it('once pinned, a later change of last_used can no longer switch the data', async () => {
    mkdirSync(path.join(root, 'Default'));
    localState(root, { profile: { last_used: 'Default' } });
    expect((await resolveChromiumProfile(root)).profileDirectory).toBe('Default');
    mkdirSync(path.join(root, 'Profile 3'));
    localState(root, { profile: { last_used: 'Profile 3' } }); // e.g. picked in Chromium's own menu
    const again = await resolveChromiumProfile(root);
    expect(again).toMatchObject({ profileDirectory: 'Default', source: 'pinned' });
  });

  it('last_used naming a directory that does not exist is not adopted', async () => {
    localState(root, { profile: { last_used: 'Profile 9' } });
    expect((await adoptableProfileDirectory(root)).dir).toBe('Default');
  });

  it('an unreadable pin file is left untouched; the adoptable directory is used for this launch', async () => {
    writeFileSync(path.join(root, PIN_FILE), '{not json');
    const loc = await resolveChromiumProfile(root);
    expect(loc).toMatchObject({ profileDirectory: 'Default', source: 'unreadable-pin' });
    expect(readFileSync(path.join(root, PIN_FILE), 'utf8')).toBe('{not json');
  });

  it('refuses path tricks in pinned / adopted values', async () => {
    for (const bad of ['..', '../x', 'a/b', '/abs', '', ' lead', 'a\\b', 'x'.repeat(65)]) expect(isValidProfileDirectory(bad)).toBe(false);
    for (const ok of ['Default', 'Profile 1', 'Profile_2', 'p.3']) expect(isValidProfileDirectory(ok)).toBe(true);
    expect(pinnedDirectoryOf({ profileDirectory: '../../etc' })).toBeNull();
    mkdirSync(path.join(root, 'Default'));
    localState(root, { profile: { last_used: '../outside' } });
    expect((await resolveChromiumProfile(root)).profileDirectory).toBe('Default');
  });

  it('verifyProfileSelected reports whether the intended profile path exists', async () => {
    const loc = await resolveChromiumProfile(root);
    expect(await verifyProfileSelected(loc)).toBe(false);
    mkdirSync(loc.profilePath);
    expect(await verifyProfileSelected(loc)).toBe(true);
  });
});

describe('withProfileSelection', () => {
  it('appends exactly one --profile-directory and strips any caller copy of the owned switches', () => {
    const out = withProfileSelection(['--a', '--profile-directory=Other', '--user-data-dir=/x', '--profile-directory', '--b'], { profileDirectory: 'Default' });
    expect(out).toEqual(['--a', '--b', '--profile-directory=Default']);
  });
  it('keeps the order of the caller arguments (launch settings, window, extensions)', () => {
    const std = buildLaunchArgs({ customFlags: '--lang=fa' });
    expect(std.ok).toBe(true);
    const out = withProfileSelection(std.args, { profileDirectory: 'Profile 1' });
    expect(out.slice(0, -1)).toEqual(std.args);
    expect(out[out.length - 1]).toBe('--profile-directory=Profile 1');
  });
  it('Custom Flags still cannot choose the profile directory (refused before any launch)', () => {
    const r = buildLaunchArgs({ customFlags: '--profile-directory=Other' });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.message).join(' ')).toMatch(/pinned per profile/);
  });
});

describe('the four identities stay separate', () => {
  it('id, root, profile directory and display name are independent; rename touches only the name', async () => {
    const reg = new ProfileRegistry(root);
    const p = await reg.create('u1', 'Shop');
    const dir = reg.dirOf('u1', p.id);
    const loc = await resolveChromiumProfile(dir);
    await applyChromiumProfileName(loc.userDataRoot, p.name, loc.profileDirectory);
    expect(p.id).toMatch(/^prf_[0-9a-f]{12}$/);            // Aria id
    expect(leaseIdOf(p.id)).toBe(`named:${p.id}`);         // lock name derived from the id
    expect(loc.userDataRoot).toBe(path.resolve(dir));      // Chromium root
    expect(loc.profileDirectory).toBe(DEFAULT_PROFILE_DIRECTORY); // Chromium profile directory
    expect(await readChromiumProfileName(dir, loc.profileDirectory)).toBe('Shop'); // displayed name
    const renamed = await reg.rename('u1', p.id, '22');
    expect(renamed.id).toBe(p.id);
    expect(reg.dirOf('u1', p.id)).toBe(dir);
    expect((await resolveChromiumProfile(dir)).profileDirectory).toBe('Default');
  });

  it('the display name is written for the PINNED directory, not a hard-coded Default', async () => {
    mkdirSync(path.join(root, 'Profile 1'));
    localState(root, { profile: { last_used: 'Profile 1', info_cache: { 'Profile 1': { name: 'Person 1' } } } });
    const loc = await resolveChromiumProfile(root);
    const r = await applyChromiumProfileName(root, '22', loc.profileDirectory);
    expect(r.ok).toBe(true);
    expect(await readChromiumProfileName(root, 'Profile 1')).toBe('22');
    expect(existsSync(path.join(root, 'Default'))).toBe(false);
    const ls = JSON.parse(readFileSync(path.join(root, 'Local State'), 'utf8'));
    expect(ls.profile.last_used).toBe('Profile 1'); // other keys preserved
  });
});
