/**
 * chrome-tab-restore.test.ts — the §3.2 regression the operator called the
 * biggest one left.
 *
 * THE REPORT
 * ----------
 *   «مرورگر ریموت رو بالا اوردم ولی وقتی وبگردی میکردم هنگ کرد و بعدش دیگه فریز
 *    شد منم بستم مجدد باز کنم کلا نرفت به اون ادرس … موقعی که مجدد میزنم یکی
 *    جدید بالا میاره که همه تب ها گم شدن یا بسته شدن با همون مرورگر کرش شده»
 *
 * WHAT WAS MEASURED, and why these tests assert what they assert
 * -------------------------------------------------------------
 * tools/probe-realchrome-tab-loss.js, headed on Xvfb, three tabs in every run:
 *
 *   clean close, reopen ................................. 0 of 3 tabs back
 *   SIGKILL, exit-state wiped, reopen ................... 0 of 3
 *   SIGKILL, exit-state KEPT, reopen (control) .......... 0 of 3
 *   restore_on_startup=5 alone, no CLI flag ............. 0 of 3
 *   --restore-last-session alone, no pref ............... 0 of 3
 *   BOTH .................................................. 3 of 3
 *
 * and then through the PRODUCT class, tools/probe-realchrome-restore-live.js:
 *
 *   RESTORED_THROUGH_PRODUCT_CODE=true    (fix on,  3 of 3)
 *   RESTORED_THROUGH_PRODUCT_CODE=false   (fix off, 0 of 3)
 *
 * Three findings drive the tests below:
 *
 *  1. `clearCrashedExitState()` was the handoff's prime suspect and is INNOCENT
 *     — the control run that skips it loses the tabs identically. So there is a
 *     test here that it is still called, to stop a future reader "fixing" it.
 *  2. Neither lever works alone. That is the fragile part of this fix: half of
 *     it measures exactly like no fix, so both halves are pinned together.
 *  3. A wedged browser leaves `isRunning()` true while nothing answers, which is
 *     the "dead end" half of the report. `isResponsive()` is the honest check.
 *
 * The pref tests run the real function against real files in a temp dir and
 * assert what Chrome would read back. The argument tests assert the shape of
 * what is handed to Playwright — the whole bug was an argument list that looked
 * right and did nothing, so "is the switch actually present" is the property
 * that matters. The responsiveness tests drive the real class with fake page
 * objects, because a hang is a timing behaviour and cannot be grepped for.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { enableSessionRestore, RealChrome } from '../../src/core/RealChrome';
import { config } from '../../src/config';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabrestore-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  // Never leave a stubbed context behind for another test file to inherit.
  (RealChrome as unknown as { context: unknown }).context = null;
});

const prefsPath = () => path.join(dir, 'Default', 'Preferences');
const readPrefs = async () => JSON.parse(await fs.readFile(prefsPath(), 'utf8'));
const writePrefs = async (o: unknown) => {
  await fs.mkdir(path.dirname(prefsPath()), { recursive: true });
  await fs.writeFile(prefsPath(), JSON.stringify(o), 'utf8');
};

// ══════════════════════════════════════════════════════════════════════════
// A. The preference — half the fix, and useless alone (MEASURED)
// ══════════════════════════════════════════════════════════════════════════

describe('enableSessionRestore', () => {
  it('seeds the pref on a profile Chrome has never run', async () => {
    // MEASURED: a fresh profile has NO Preferences file at all, so writing one
    // is the only way the very first session can be restored. Without this the
    // first crash after setup loses everything.
    const said = await enableSessionRestore(dir);
    expect((await readPrefs()).session.restore_on_startup).toBe(5);
    expect(said).toContain('unset -> 5');
  });

  it('uses 5 — "continue where you left off" — not 1 or 4', async () => {
    // 1 is the new tab page and 4 is a fixed URL list. Both would discard the
    // session this whole change exists to keep, while looking configured.
    await enableSessionRestore(dir);
    expect((await readPrefs()).session.restore_on_startup).toBe(5);
  });

  it('leaves the rest of the profile byte for byte alone', async () => {
    // This file is the USER's profile: their passwords, site permissions and
    // extension settings live in it. It is not ours to normalise.
    await writePrefs({
      profile: { name: 'Person 1', exit_type: 'Normal' },
      extensions: { settings: { abc: { state: 1 } } },
      session: { restore_on_startup: 1, other_key: 'keep me' },
    });
    await enableSessionRestore(dir);
    const p = await readPrefs();
    expect(p.profile).toEqual({ name: 'Person 1', exit_type: 'Normal' });
    expect(p.extensions).toEqual({ settings: { abc: { state: 1 } } });
    // Sibling keys inside `session` survive too — the object is merged, not
    // replaced.
    expect(p.session.other_key).toBe('keep me');
    expect(p.session.restore_on_startup).toBe(5);
  });

  it('is idempotent and says so, instead of rewriting on every launch', async () => {
    await enableSessionRestore(dir);
    const before = await fs.readFile(prefsPath(), 'utf8');
    const said = await enableSessionRestore(dir);
    expect(said).toBe('already set');
    // Byte-identical: an unnecessary rewrite of the profile on every single
    // launch is a chance to corrupt it for no benefit.
    expect(await fs.readFile(prefsPath(), 'utf8')).toBe(before);
  });

  it('leaves no temp file behind', async () => {
    await writePrefs({ session: { restore_on_startup: 1 }, keep: true });
    await enableSessionRestore(dir);
    const entries = await fs.readdir(path.dirname(prefsPath()));
    expect(entries.filter((e) => e.endsWith('.abtmp'))).toEqual([]);
    expect((await readPrefs()).keep).toBe(true);
  });

  it('writes ATOMICALLY: a temp file in the same dir, then a rename', async () => {
    // This assertion is deliberately about the MECHANISM, and an earlier
    // version of this test was not — it only checked that no .abtmp was left
    // over and that a sibling key survived, both of which a plain
    // `writeFile(prefsPath)` also satisfies. The mutation run caught that: the
    // "write directly instead of temp+rename" mutant SURVIVED.
    //
    // Why the mechanism is worth pinning: Preferences holds the user's cookies
    // metadata, passwords and extension settings. A direct write truncates the
    // file before the new bytes land, so a crash in that window destroys the
    // profile this browser exists to preserve. The only way to observe the
    // difference is to watch which paths are written and in what order.
    await writePrefs({ session: { restore_on_startup: 1 } });

    const calls: string[] = [];
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(
      (async (p: string) => { calls.push(`write:${p}`); }) as never,
    );
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(
      (async (from: string, to: string) => { calls.push(`rename:${from}->${to}`); }) as never,
    );
    try {
      await enableSessionRestore(dir);
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(calls.length, 'expected exactly one write and one rename').toBe(2);
    // The real Preferences path must never be the write target.
    expect(calls[0]).not.toBe(`write:${prefsPath()}`);
    expect(calls[0]).toMatch(/write:.*\.abtmp$/);
    // Same directory, or `rename` is a cross-device copy and stops being atomic.
    const tmp = calls[0].slice('write:'.length);
    expect(path.dirname(tmp)).toBe(path.dirname(prefsPath()));
    expect(calls[1]).toBe(`rename:${tmp}->${prefsPath()}`);
  });

  it('reads the existing Preferences before rewriting them', async () => {
    // If the file is not read first, the "merge" is really a replace and every
    // launch silently discards the profile. Measured via a key that only
    // survives if the original contents were loaded.
    await writePrefs({ session: { restore_on_startup: 1 }, passwords: { saved: 7 } });
    await enableSessionRestore(dir);
    expect((await readPrefs()).passwords).toEqual({ saved: 7 });
  });

  it('reports rather than throws when the profile cannot be written', async () => {
    // A browser with the wrong startup mode beats no browser. This must never
    // be able to block a launch.
    const said = await enableSessionRestore(path.join(dir, 'nope', '\0bad'));
    expect(said).toMatch(/could not set/);
  });

  it('survives a Preferences file that is not valid JSON', async () => {
    // Chrome can be killed mid-write. Treating an unparseable file as "no
    // settings yet" is right: the alternative is refusing to launch.
    await fs.mkdir(path.dirname(prefsPath()), { recursive: true });
    await fs.writeFile(prefsPath(), '{"session": {"restore', 'utf8');
    await enableSessionRestore(dir);
    expect((await readPrefs()).session.restore_on_startup).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. The CLI flag — the other half, equally useless alone (MEASURED)
// ══════════════════════════════════════════════════════════════════════════

describe('the launch arguments', () => {
  const launchSource = () => fs.readFile(
    path.join(__dirname, '..', '..', 'src', 'core', 'RealChrome.ts'),
    'utf8',
  );

  it('passes --restore-last-session, without which the pref does nothing', async () => {
    // MEASURED: pref alone restored 0 of 3 tabs. The pref says what "startup"
    // means; the flag says this launch IS such a startup.
    expect(await launchSource()).toContain("'--restore-last-session'");
  });

  it('gates the flag and the pref on the SAME setting', async () => {
    // If these two could ever disagree, the product would ship the measured
    // no-op: one lever on, one off, zero tabs restored, and a config flag that
    // appears to be working.
    const src = await launchSource();
    const flagLine = src.split('\n').find((l) => l.includes("'--restore-last-session'"));
    expect(flagLine, 'the CLI flag must be conditional on restoreTabs')
      .toMatch(/restoreTabs/);
    // The CALL, not the `export async function` declaration — matching the
    // declaration is what an earlier version of this test did, and it failed
    // for the wrong reason.
    const prefCall = src.split('\n').find(
      (l) => l.includes('enableSessionRestore(') && !l.includes('function'),
    );
    expect(prefCall, 'the pref write must be conditional on the same flag')
      .toMatch(/restoreTabs/);
  });

  it('still clears the crashed exit state — the innocent suspect', async () => {
    // The handoff nominated clearCrashedExitState() as the cause. MEASURED
    // control run: skipping it loses the tabs just the same, so it is innocent
    // AND load-bearing for a different defect (the "Restore pages?" bubble is
    // focused and eats clicks aimed at the page). Removing it would reintroduce
    // that without helping this.
    expect(await launchSource()).toContain('await clearCrashedExitState(userDataDir)');
  });

  it('is on by default, because losing the tabs was the reported bug', () => {
    expect(config.REAL_CHROME_RESTORE_TABS).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C. The wedged browser — "isRunning() said yes and nothing answered"
// ══════════════════════════════════════════════════════════════════════════

/** Install a fake context on the class. Returns a restore function. */
function stubContext(pages: Array<{ evaluate: () => Promise<unknown> }>) {
  const target = RealChrome as unknown as { context: unknown };
  target.context = { pages: () => pages };
}

describe('isResponsive', () => {
  it('is false when there is no browser at all', async () => {
    (RealChrome as unknown as { context: unknown }).context = null;
    expect(await RealChrome.isResponsive()).toBe(false);
  });

  it('is true when a page answers a trivial round trip', async () => {
    stubContext([{ evaluate: () => Promise.resolve(2) }]);
    expect(await RealChrome.isResponsive()).toBe(true);
  });

  it('is FALSE for a browser that never answers, even though it exists', async () => {
    // THE REPORTED CONDITION. isRunning() is true here — the object is right
    // there — and the operator gets a view onto a corpse. Only a round trip can
    // tell the difference, so this test uses a promise that never settles.
    stubContext([{ evaluate: () => new Promise(() => {}) }]);
    expect(RealChrome.isRunning()).toBe(true);   // the lie...
    expect(await RealChrome.isResponsive(150)).toBe(false); // ...and the truth
  });

  it('does not wait forever on a wedged browser', async () => {
    // The check runs on a user-facing path. A wedged browser will never answer,
    // so waiting longer only makes the operator wait longer for the same
    // verdict.
    stubContext([{ evaluate: () => new Promise(() => {}) }]);
    const started = Date.now();
    await RealChrome.isResponsive(120);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('one hung tab does not condemn the whole browser', async () => {
    // Recycling Chrome because a single tab is busy would itself cause the tab
    // loss this change exists to prevent. The first page that answers is enough.
    stubContext([
      { evaluate: () => new Promise(() => {}) },
      { evaluate: () => Promise.resolve(2) },
    ]);
    expect(await RealChrome.isResponsive(1000)).toBe(true);
  });

  it('treats a browser with no pages as idle, not wedged', async () => {
    // There is nothing to ask, and "no tabs open" is a normal state. Reporting
    // it as wedged would recycle a perfectly good browser on every quiet moment.
    stubContext([]);
    expect(await RealChrome.isResponsive()).toBe(true);
  });

  it('is false when the round trip rejects', async () => {
    stubContext([{ evaluate: () => Promise.reject(new Error('Target closed')) }]);
    expect(await RealChrome.isResponsive(500)).toBe(false);
  });
});

describe('recycleIfWedged', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('does nothing to a healthy browser', async () => {
    // Recycling "to be safe" would throw away the operator's live pages.
    stubContext([{ evaluate: () => Promise.resolve(2) }]);
    const stop = vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);
    const res = await RealChrome.recycleIfWedged();
    expect(res.action).toBe('none');
    expect(stop).not.toHaveBeenCalled();
  });

  it('says so when there is no browser, rather than starting one', async () => {
    // A caller asking "is it wedged?" has not asked for a browser to be
    // launched, and launching Chrome as a side effect of a health check would
    // be a surprising, slow and expensive answer.
    (RealChrome as unknown as { context: unknown }).context = null;
    const get = vi.spyOn(RealChrome, 'getContext');
    const res = await RealChrome.recycleIfWedged();
    expect(res.action).toBe('not-running');
    expect(get).not.toHaveBeenCalled();
  });

  it('relaunches a wedged browser, preserving the profile', async () => {
    stubContext([{ evaluate: () => new Promise(() => {}) }]);
    const stop = vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);
    const get = vi.spyOn(RealChrome, 'getContext')
      .mockResolvedValue({} as never);
    const res = await RealChrome.recycleIfWedged(100);
    expect(res.action).toBe('recycled');
    // Stop THEN start: the profile is a directory on disk, so the relaunch
    // reads back the same cookies, extensions and session file. That is what
    // makes the recovery non-destructive.
    expect(stop).toHaveBeenCalled();
    expect(get).toHaveBeenCalled();
    expect(stop.mock.invocationCallOrder[0])
      .toBeLessThan(get.mock.invocationCallOrder[0]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D. The route wiring — the dead end the operator actually hit
// ══════════════════════════════════════════════════════════════════════════

describe('the /browser/real/open route', () => {
  const routes = () => fs.readFile(
    path.join(__dirname, '..', '..', 'src', 'Routes', 'browser.routes.ts'),
    'utf8',
  );

  it('checks the browser is answering BEFORE reusing it', async () => {
    // «مجدد باز کنم کلا نرفت به اون ادرس». getContext() hands back the existing
    // context whenever one exists, and a frozen Chromium still has one — so
    // reopening the view returned the same dead browser. The check has to come
    // before the reuse or it changes nothing.
    const src = await routes();
    const open = src.slice(src.indexOf("router.post('/browser/real/open'"));
    const body = open.slice(0, open.indexOf('router.get('));
    const checkAt = body.indexOf('recycleIfWedged');
    const reuseAt = body.indexOf('RealChrome.getContext()');
    expect(checkAt, 'the open route must probe for a wedged browser')
      .toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(reuseAt);
  });

  it('does not probe on a cold start', async () => {
    // Nothing to recycle, and getContext() is about to launch anyway. Probing
    // first would only add a round trip to the slowest path there is.
    const src = await routes();
    expect(src).toMatch(/RealChrome\.isRunning\(\)\s*\?\s*await RealChrome\.recycleIfWedged\(\)/);
  });

  it('tells the client when a browser was recycled', async () => {
    // A SILENT relaunch is how "all my tabs are gone" became a mystery. The
    // tabs now come back, but the operator should still be told what happened.
    expect(await routes()).toContain('recovered: recovery.action === ');
  });

  it('exposes health and recovery as separate read and write routes', async () => {
    // GET reports, POST acts, so a caller can look before it leaps.
    const src = await routes();
    expect(src).toContain("router.get('/browser/real/health'");
    expect(src).toContain("router.post('/browser/real/recover'");
  });

  it('reports running and responsive as DIFFERENT fields', async () => {
    // Collapsing them would re-hide the bug: the whole defect is that a frozen
    // browser is "running" and not responsive.
    const src = await routes();
    const health = src.slice(src.indexOf("router.get('/browser/real/health'"));
    const body = health.slice(0, health.indexOf('router.post('));
    expect(body).toContain('running: RealChrome.isRunning()');
    expect(body).toContain('responsive: await RealChrome.isResponsive()');
  });
});

describe('stop()', () => {
  it('gives up on a close that never returns', async () => {
    // context.close() asks the browser to shut down cleanly, and a WEDGED
    // browser is by definition one that ignores such requests. recycleIfWedged
    // calls this, so an unbounded await would hang the recovery path itself —
    // the operator's dead end, reimplemented on the server.
    (RealChrome as unknown as { context: unknown }).context = {
      close: () => new Promise(() => {}),
    };
    const started = Date.now();
    await RealChrome.stop(100);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('clears the reference even when the close hangs', async () => {
    // Otherwise a dead context keeps being handed to new callers forever.
    (RealChrome as unknown as { context: unknown }).context = {
      close: () => new Promise(() => {}),
    };
    await RealChrome.stop(50);
    expect(RealChrome.isRunning()).toBe(false);
  });
});
