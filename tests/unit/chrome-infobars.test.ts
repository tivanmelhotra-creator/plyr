/**
 * The two infobars that greeted the user in the REAL Chrome window.
 *
 * Both were reported as "cosmetic" and both turned out to be real defects:
 *
 *   1. "Chrome is being controlled by automated test software."
 *      The code passed `--exclude-switches=enable-automation` to suppress it.
 *      MEASURED by reading Chrome's own /proc/<pid>/cmdline: the flag survived
 *      anyway, because --exclude-switches is a ChromeDriver *capability*, not a
 *      Chrome switch. Chrome ignores it silently. The only thing that removes
 *      the switch is Playwright's ignoreDefaultArgs.
 *
 *   2. "Restore pages? Chromium didn't shut down correctly."
 *      MEASURED on this repo's live profile: profile.exit_type === "Crashed".
 *      Chrome writes that whenever it is killed rather than closed, which on a
 *      server is the ordinary case (container stop, OOM, systemd SIGKILL). The
 *      bubble is focused, swallows clicks meant for the page, and its "Restore"
 *      button silently reopens the previous session's tabs — changing the tab
 *      set automation is working with.
 *
 * These tests measure BEHAVIOUR. The exit-state tests run the real function
 * against real files on disk and assert what Chrome would read back. The
 * argument test asserts the shape of what is handed to Playwright, because the
 * whole bug was that an argument list *looked* right while doing nothing — so
 * the interesting property is "the switch is in the remove-list", which is the
 * only mechanism measured to work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { ANTI_AUTOMATION_ARGS, IGNORED_DEFAULT_ARGS } from '../../src/core/BrowserProfile';
import { clearCrashedExitState } from '../../src/core/RealChrome';

// ───────────────────────────────────────────────────────────────────────────
// 1. The automation bar
// ───────────────────────────────────────────────────────────────────────────

describe('automation infobar suppression', () => {
  it('removes --enable-automation instead of trying to counter it', () => {
    // Measured: countering does nothing, removing works.
    expect(IGNORED_DEFAULT_ARGS).toContain('--enable-automation');
  });

  it('still removes --disable-extensions, or --load-extension is a no-op', () => {
    expect(IGNORED_DEFAULT_ARGS).toContain('--disable-extensions');
  });

  it('no longer passes the switch that Chrome silently ignores', () => {
    // --exclude-switches is a webdriver capability. Shipping it as an argument
    // gave false confidence: the intent read correctly and the effect was nil.
    for (const arg of ANTI_AUTOMATION_ARGS) {
      expect(arg.startsWith('--exclude-switches')).toBe(false);
    }
  });

  it('keeps the flag that actually hides navigator.webdriver', () => {
    expect(ANTI_AUTOMATION_ARGS).toContain('--disable-blink-features=AutomationControlled');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The "Restore pages?" bubble
// ───────────────────────────────────────────────────────────────────────────

describe('clearCrashedExitState', () => {
  let dir = '';

  const prefsPath = () => path.join(dir, 'Default', 'Preferences');

  const writePrefs = async (obj: unknown) => {
    await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
    await fs.writeFile(prefsPath(), JSON.stringify(obj), 'utf8');
  };

  const readPrefs = async () =>
    JSON.parse(await fs.readFile(prefsPath(), 'utf8')) as Record<string, any>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-crash-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('turns a crashed profile into a clean one, so no bubble appears', async () => {
    await writePrefs({ profile: { exit_type: 'Crashed' } });

    await clearCrashedExitState(dir);

    const after = await readPrefs();
    expect(after.profile.exit_type).toBe('Normal');
    expect(after.profile.exited_cleanly).toBe(true);
  });

  it('clears the SessionEnd state too (SIGTERM from a container stop)', async () => {
    // Chrome uses "SessionEnd" when the OS is shutting it down. It produces the
    // same restore prompt, so it must be treated the same way.
    await writePrefs({ profile: { exit_type: 'SessionEnd', exited_cleanly: false } });

    await clearCrashedExitState(dir);

    expect((await readPrefs()).profile.exit_type).toBe('Normal');
  });

  it('preserves every other preference — this is the user profile, not ours', async () => {
    await writePrefs({
      profile: { exit_type: 'Crashed', name: 'Person 1', content_settings: { x: 1 } },
      extensions: { settings: { abc: { state: 1 } } },
      bookmark_bar: { show_on_all_tabs: true },
    });

    await clearCrashedExitState(dir);

    const after = await readPrefs();
    expect(after.profile.name).toBe('Person 1');
    expect(after.profile.content_settings).toEqual({ x: 1 });
    expect(after.extensions).toEqual({ settings: { abc: { state: 1 } } });
    expect(after.bookmark_bar).toEqual({ show_on_all_tabs: true });
  });

  it('does not rewrite an already-clean profile at all', async () => {
    // The bytes must be ones that a rewrite could not reproduce, or this test
    // passes even when the skip is gone: JSON.stringify of the parsed object
    // returns the identical string, so comparing compact JSON to compact JSON
    // proves nothing. (A mutation that deleted the early return survived
    // exactly that way.) Indentation is chosen because re-serialising drops it.
    const original = JSON.stringify(
      { profile: { exit_type: 'Normal', exited_cleanly: true, name: 'A' } },
      null,
      2,
    );
    await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
    await fs.writeFile(prefsPath(), original, 'utf8');

    await clearCrashedExitState(dir);

    expect(await fs.readFile(prefsPath(), 'utf8')).toBe(original);
  });

  it('does not create a Preferences file for a brand-new profile', async () => {
    await clearCrashedExitState(dir);
    await expect(fs.readFile(prefsPath(), 'utf8')).rejects.toThrow();
  });

  it('never throws when Preferences is corrupt — a launch must not be blocked', async () => {
    await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
    await fs.writeFile(prefsPath(), '{ this is not json', 'utf8');

    await expect(clearCrashedExitState(dir)).resolves.toBeUndefined();
    // And it must not have destroyed the file it could not understand.
    expect(await fs.readFile(prefsPath(), 'utf8')).toBe('{ this is not json');
  });

  it('never throws when the directory does not exist at all', async () => {
    await expect(
      clearCrashedExitState(path.join(dir, 'nope', 'still-nope')),
    ).resolves.toBeUndefined();
  });

  it('tolerates a Preferences file with no profile section', async () => {
    await writePrefs({ something_else: true });
    await expect(clearCrashedExitState(dir)).resolves.toBeUndefined();
    expect((await readPrefs()).something_else).toBe(true);
  });

  it('leaves no temp file behind, so the profile dir stays clean', async () => {
    await writePrefs({ profile: { exit_type: 'Crashed' } });

    await clearCrashedExitState(dir);

    const entries = await fs.readdir(path.join(dir, 'Default'));
    expect(entries).toEqual(['Preferences']);
  });

  it('is idempotent: running twice is the same as running once', async () => {
    await writePrefs({ profile: { exit_type: 'Crashed', name: 'A' } });

    await clearCrashedExitState(dir);
    const once = await fs.readFile(prefsPath(), 'utf8');
    await clearCrashedExitState(dir);
    const twice = await fs.readFile(prefsPath(), 'utf8');

    expect(twice).toBe(once);
  });
});
