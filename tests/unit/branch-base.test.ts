/**
 * Default base directory per OS and its validation (owner's brief, section 3).
 * Pure checks run for both Windows and Linux path shapes on any OS; the
 * on-disk checks run on the OS the test runs on, as a normal user.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultBaseDir, checkBasePathShape, validateBaseDir } from '../../src/core/BranchBase';
import { parseWindowsCimProcesses, findOrphans, reapOrphans, lockedRootsUnder } from '../../src/core/OrphanBrowsers';

describe('default base directory', () => {
  it('simulated Windows: %LOCALAPPDATA%\\AriaBrowser\\branches (per-user, no admin, not roaming/OneDrive, not Chromium "User Data")', () => {
    const d = defaultBaseDir('win32', { LOCALAPPDATA: 'C:\\Users\\ali\\AppData\\Local' }, 'C:\\Users\\ali');
    expect(d).toBe('C:\\Users\\ali\\AppData\\Local\\AriaBrowser\\branches');
    expect(d).not.toMatch(/User Data/i);
    expect(d).not.toMatch(/OneDrive/i);
    expect(checkBasePathShape(d, 'win32')).toMatchObject({ ok: true, warnings: [] });
  });

  it('simulated Windows: without LOCALAPPDATA falls back to USERPROFILE\\AppData\\Local', () => {
    expect(defaultBaseDir('win32', { USERPROFILE: 'C:\\Users\\ali' }, 'C:\\x')).toBe('C:\\Users\\ali\\AppData\\Local\\AriaBrowser\\branches');
    expect(defaultBaseDir('win32', {}, 'C:\\Users\\ali')).toBe('C:\\Users\\ali\\AppData\\Local\\AriaBrowser\\branches');
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
    ['win32', 'C:/', /drive root/],
    ['win32', 'D:', /absolute|drive root/],
    ['win32', 'relative\\dir', /absolute/],
    ['win32', 'C:\\Users\\ali\\AppData\\Local\\Google\\Chrome\\User Data', /User Data/],
    ['win32', 'c:\\users\\ali\\appdata\\local\\google\\chrome\\user data\\sub', /User Data/],
    ['win32', 'C:\\Users\\ali\\AppData\\Local\\Chromium\\User Data', /User Data/],
    ['win32', 'C:\\Users\\ali\\OneDrive\\Aria', /cloud-synced/],
    ['win32', 'C:\\Users\\ali\\onedrive\\aria', /cloud-synced/],
    ['win32', 'C:\\Users\\ali\\OneDrive - Contoso\\Aria', /cloud-synced/],
    ['win32', 'C:\\Users\\ali\\Dropbox\\Aria', /cloud-synced/],
    ['win32', 'C:\\Users\\ali\\dropbox (business)\\Aria', /cloud-synced/],
    ['linux', '/', /root/],
    ['linux', 'relative/dir', /absolute/],
    ['linux', '/home/ali/.config/chromium/branches', /personal/],
    ['linux', '/home/ali/Dropbox/aria', /cloud-synced/],
    ['linux', '', /Enter a folder/],
  ];
  for (const [platform, p, re] of bad) {
    const tag = platform === 'win32' ? 'simulated Windows' : platform;
    it(`${tag}: refuses ${JSON.stringify(p)}`, () => {
      const r = checkBasePathShape(p, platform);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(re);
    });
  }

  it('simulated Windows: spaces and non-ASCII are allowed with a warning', () => {
    const r = checkBasePathShape('C:\\Aria Data\\شاخه', 'win32');
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/spaces/);
    expect(r.warnings.join(' ')).toMatch(/non-ASCII/);
  });
});

describe('simulated Windows: OrphanBrowsers CIM output parsing and case-insensitive areas', () => {
  // Recorded PowerShell `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress` sample
  const recordedCimJson = JSON.stringify([
    {
      ProcessId: 4,
      ParentProcessId: 0,
      CommandLine: null,
    },
    {
      ProcessId: 4120,
      ParentProcessId: 1080,
      CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Aria\\dist\\index.js"',
    },
    {
      ProcessId: 5200,
      ParentProcessId: 4120,
      CommandLine: '"C:\\Users\\user\\AppData\\Local\\ms-playwright\\chromium-1194\\chrome-win\\chrome.exe" --user-data-dir="C:\\Users\\user\\AppData\\Local\\AriaBrowser\\branches\\branch-001" --profile-directory=profile-001 --no-first-run',
    },
    {
      ProcessId: 6300,
      ParentProcessId: 888, // dead parent (re-parented or orphaned)
      CommandLine: '"C:\\Users\\user\\AppData\\Local\\ms-playwright\\chromium-1194\\chrome-win\\chrome.exe" "--user-data-dir=C:\\Users\\user\\AppData\\Local\\ariabrowser\\Branches\\branch-002" --profile-directory=profile-001',
    },
    {
      ProcessId: 6301,
      ParentProcessId: 6300,
      CommandLine: '"C:\\Users\\user\\AppData\\Local\\ms-playwright\\chromium-1194\\chrome-win\\chrome.exe" --type=renderer "--user-data-dir=C:\\Users\\user\\AppData\\Local\\ariabrowser\\Branches\\branch-002"',
    },
    {
      ProcessId: 7400,
      ParentProcessId: 888,
      CommandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data"',
    },
  ]);

  it('simulated Windows: parses recorded Get-CimInstance JSON (array and single-object output) and identifies only the unowned Aria browser', () => {
    const procs = parseWindowsCimProcesses(recordedCimJson);
    expect(procs.map((p) => p.pid)).toEqual([4120, 5200, 6300, 6301, 7400]);
    // Single-object JSON (when PowerShell returns 1 row without array wrapper)
    const single = parseWindowsCimProcesses(JSON.stringify({ ProcessId: 10, ParentProcessId: 1, CommandLine: 'chrome.exe --user-data-dir="C:\\a\\b"' }));
    expect(single).toEqual([{ pid: 10, ppid: 1, args: ['chrome.exe', '--user-data-dir=C:\\a\\b'] }]);

    // Case-insensitive & backslash matching on Windows:
    // pid 5200 is owned by live node.exe (4120); pid 6300 is orphaned inside AriaBrowser\branches (even with different casing);
    // pid 6301 is a renderer child; pid 7400 is personal Chrome outside Aria.
    const orphans = findOrphans(
      procs,
      ['C:\\Users\\USER\\AppData\\Local\\AriaBrowser\\branches'],
      9999,
      'win32',
    );
    expect(orphans).toEqual([
      {
        pid: 6300,
        userDataDir: 'C:\\Users\\user\\AppData\\Local\\ariabrowser\\Branches\\branch-002',
      },
    ]);
  });

  it('simulated Windows: listing failed kills nothing and unlocks nothing', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'aria-win-fail-'));
    try {
      writeFileSync(path.join(d, 'lockfile'), '');
      const res = await reapOrphans([d], {
        roots: [d],
        list: async () => { throw new Error('powershell.exe failed'); },
      });
      expect(res.killed).toEqual([]);
      expect(res.unlocked).toEqual([]);
      expect(res.skipped).toMatch(/nothing was killed or unlocked/);
      expect(existsSync(path.join(d, 'lockfile'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('simulated Windows: lock file (lockfile vs SingletonLock symlink)', () => {
  it('simulated Windows: both Windows lockfile and Linux dangling SingletonLock symlink are recognised everywhere a lock is read', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'aria-locks-'));
    const winRoot = path.join(d, 'win-branch');
    const linRoot = path.join(d, 'lin-branch');
    mkdirSync(path.join(winRoot, 'Default'), { recursive: true });
    mkdirSync(path.join(linRoot, 'Default'), { recursive: true });
    writeFileSync(path.join(winRoot, 'Local State'), '{}');
    writeFileSync(path.join(winRoot, 'Default', 'Preferences'), '{}');
    writeFileSync(path.join(linRoot, 'Local State'), '{}');
    writeFileSync(path.join(linRoot, 'Default', 'Preferences'), '{}');

    // Windows lockfile (regular file) + Linux SingletonLock (dangling symlink read via lstat)
    writeFileSync(path.join(winRoot, 'lockfile'), '');
    symlinkSync('hostname-999999', path.join(linRoot, 'SingletonLock'));

    try {
      // 1. BranchBase.validateBaseDir refuses both
      expect((await validateBaseDir(winRoot)).ok).toBe(false);
      expect((await validateBaseDir(linRoot)).ok).toBe(false);

      // 2. OrphanBrowsers.lockedRootsUnder & reapOrphans find and unlock both when no live browser holds them
      const found = await lockedRootsUnder(d);
      expect(found.sort()).toEqual([linRoot, winRoot].sort());
      const reaped = await reapOrphans([d], { roots: found, list: async () => [] });
      expect(reaped.unlocked.sort()).toEqual([linRoot, winRoot].sort());
      expect(existsSync(path.join(winRoot, 'lockfile'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
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

  it('a folder a Chromium uses or used (Local State / SingletonLock / lockfile) is refused, and left untouched', async () => {
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
