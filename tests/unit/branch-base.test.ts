/**
 * Default base directory per OS and its validation (owner's brief, section 3).
 * Pure checks run for both Windows and Linux path shapes on any OS; the
 * on-disk checks run on the OS the test runs on, as a normal user.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultBaseDir, checkBasePathShape, validateBaseDir } from '../../src/core/BranchBase';

describe('default base directory', () => {
  it('Windows: %LOCALAPPDATA%\\AriaBrowser\\branches (per-user, no admin, not roaming/OneDrive, not Chromium "User Data")', () => {
    const d = defaultBaseDir('win32', { LOCALAPPDATA: 'C:\\Users\\ali\\AppData\\Local' }, 'C:\\Users\\ali');
    expect(d).toBe('C:\\Users\\ali\\AppData\\Local\\AriaBrowser\\branches');
    expect(d).not.toMatch(/User Data/i);
    expect(d).not.toMatch(/OneDrive/i);
    expect(checkBasePathShape(d, 'win32')).toMatchObject({ ok: true, warnings: [] });
  });

  it('Windows without LOCALAPPDATA falls back to USERPROFILE\\AppData\\Local', () => {
    expect(defaultBaseDir('win32', { USERPROFILE: 'C:\\Users\\ali' }, 'C:\\x')).toBe('C:\\Users\\ali\\AppData\\Local\\AriaBrowser\\branches');
  });

  it('Linux: $XDG_DATA_HOME/aria-browser/branches, default ~/.local/share/aria-browser/branches', () => {
    expect(defaultBaseDir('linux', {}, '/home/ali')).toBe('/home/ali/.local/share/aria-browser/branches');
    expect(defaultBaseDir('linux', { XDG_DATA_HOME: '/data/xdg' }, '/home/ali')).toBe('/data/xdg/aria-browser/branches');
    // A relative XDG_DATA_HOME is invalid per the spec and ignored.
    expect(defaultBaseDir('linux', { XDG_DATA_HOME: 'rel' }, '/home/ali')).toBe('/home/ali/.local/share/aria-browser/branches');
    expect(checkBasePathShape(defaultBaseDir('linux', {}, '/home/ali'), 'linux')).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('base directory validation (shape)', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['win32', 'C:\\', /drive root/],
    ['win32', 'D:', /absolute|drive root/],
    ['win32', 'relative\\dir', /absolute/],
    ['win32', 'C:\\Users\\ali\\AppData\\Local\\Google\\Chrome\\User Data', /User Data/],
    ['win32', 'C:\\Users\\ali\\OneDrive\\Aria', /cloud-synced/],
    ['win32', 'C:\\Users\\ali\\OneDrive - Contoso\\Aria', /cloud-synced/],
    ['linux', '/', /root/],
    ['linux', 'relative/dir', /absolute/],
    ['linux', '/home/ali/.config/chromium/branches', /personal/],
    ['linux', '/home/ali/Dropbox/aria', /cloud-synced/],
    ['linux', '', /Enter a folder/],
  ];
  for (const [platform, p, re] of bad) {
    it(`${platform}: refuses ${JSON.stringify(p)}`, () => {
      const r = checkBasePathShape(p, platform);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(re);
    });
  }

  it('spaces and non-ASCII are allowed with a warning', () => {
    const r = checkBasePathShape('C:\\Aria Data\\شاخه', 'win32');
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/spaces/);
    expect(r.warnings.join(' ')).toMatch(/non-ASCII/);
  });
});

describe(`base directory validation on disk (${process.platform}, normal user)`, () => {
  it('the default for this OS can be created and written by this user', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'aria-home-'));
    try {
      const d = defaultBaseDir(process.platform, process.platform === 'win32' ? { LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}, home);
      const r = await validateBaseDir(d);
      expect(r).toMatchObject({ ok: true, errors: [] });
      expect(existsSync(d)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a folder a Chromium uses or used (Local State / SingletonLock) is refused, and left untouched', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'aria-owned-'));
    try {
      writeFileSync(path.join(d, 'Local State'), '{}');
      const r = await validateBaseDir(d);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Chromium data folder/);
      expect(existsSync(path.join(d, 'Local State'))).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('a folder that cannot be created is refused with the reason', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'aria-file-'));
    try {
      const file = path.join(d, 'a-file');
      writeFileSync(file, 'x');
      const r = await validateBaseDir(path.join(file, 'sub')); // parent is a file
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/cannot be created or written/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only folder is refused (not writable)', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'aria-ro-'));
    const ro = path.join(d, 'ro');
    mkdirSync(ro, { mode: 0o555 });
    try {
      const r = await validateBaseDir(path.join(ro, 'base'));
      expect(r.ok).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
