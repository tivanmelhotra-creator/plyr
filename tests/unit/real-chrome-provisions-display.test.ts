/**
 * A headed Chrome must PROVISION its display, not just complain about it.
 *
 * THE REPORT
 * ----------
 *   «پروفایل `development` مرورگر headed اجرا می‌کند و به Xvfb نیاز دارد.»
 *   -- the `development` profile runs a headed browser and needs Xvfb.
 *
 * On a server with no X server, that made the browser unstartable until a human
 * went and started one by hand.
 *
 * WHAT WAS ACTUALLY WRONG
 * -----------------------
 * The capability already existed. `Desktop.ensureDisplay()` finds a live display
 * and, failing that, installs Xvfb and starts one. But NOTHING ON THE LAUNCH
 * PATH CALLED IT. Measured before the fix:
 *
 *     $ grep -rn "ensureDisplay" src/
 *     src/core/Desktop.ts:507:  static async ensureDisplay()      <- the definition
 *     src/core/Desktop.ts:630:    await this.ensureDisplay();      <- Desktop.start()
 *     src/core/SelfHeal.ts:284:  catch { await Desktop.ensureDisplay(); }
 *
 * SelfHeal runs AFTER a crash. So a first headed launch on a fresh box could
 * only fail — and `RealChrome.launch()`'s catch block, which produces a very
 * good message naming the missing packages, could only ever EXPLAIN the failure,
 * never prevent it. The fix is one call, on the launch path, before the launch.
 *
 * WHY THESE THREE TESTS AND NOT A GREP
 * ------------------------------------
 * Each drives the REAL `RealChrome.getContext()`. `playwright-extra` is mocked
 * so that `launchPersistentContext` records the environment it was handed and
 * then throws, which is exactly what a real Chrome does with no display -- so
 * the assertions below are about observed ORDER and observed FALLOUT, not about
 * the presence of a line of source. Deleting the call fails test 1; making it
 * fatal fails test 2; provisioning in headless mode fails test 3.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted: the mock factory below runs before the imports are evaluated.
const launches = vi.hoisted(() => ({
  calls: [] as Array<{ display: string | undefined; headless: boolean }>,
  error: new Error('Missing X server or $DISPLAY'),
}));

vi.mock('playwright-extra', () => ({
  chromium: {
    use: vi.fn(),
    launchPersistentContext: vi.fn(async (_dir: string, opts: Record<string, unknown>) => {
      const env = (opts.env ?? {}) as Record<string, string | undefined>;
      launches.calls.push({ display: env.DISPLAY, headless: opts.headless === true });
      throw launches.error;
    }),
  },
}));

// Nothing here may touch apt, spawn an X server, or seed an extension.
vi.mock('../../src/core/InspectorExtension', () => ({
  seedInspectorExtension: vi.fn(async () => ({ seeded: false, reason: 'skipped' as const })),
}));

const { RealChrome } = await import('../../src/core/RealChrome');
const { Desktop } = await import('../../src/core/Desktop');
const { config } = await import('../../src/config');

/** The order in which the launcher took its two irreversible steps. */
const order: string[] = [];

let headlessWas: boolean;

beforeEach(() => {
  launches.calls.length = 0;
  launches.error = new Error('Missing X server or $DISPLAY');
  order.length = 0;
  headlessWas = config.REAL_CHROME_HEADLESS;

  // Reset the launcher's memoised context/in-flight promise between cases, or
  // the second test would be handed the first test's rejection.
  const priv = RealChrome as unknown as Record<string, unknown>;
  priv.context = null;
  priv.starting = null;

  vi.spyOn(Desktop, 'screenSize').mockImplementation(async () => {
    order.push('screenSize');
    return null;
  });
  vi.spyOn(Desktop, 'missingBinaries').mockResolvedValue(['Xvfb']);
});

afterEach(() => {
  (config as unknown as Record<string, unknown>).REAL_CHROME_HEADLESS = headlessWas;
  vi.restoreAllMocks();
});

/** Run a launch we expect to fail, and hand back the error message. */
async function launchAndCatch(): Promise<string> {
  try {
    await RealChrome.getContext();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('a headed launch provisions its own X display', () => {
  it('calls ensureDisplay BEFORE trying to start Chrome', async () => {
    (config as unknown as Record<string, unknown>).REAL_CHROME_HEADLESS = false;

    const ensure = vi.spyOn(Desktop, 'ensureDisplay').mockImplementation(async () => {
      order.push('ensureDisplay');
      // A real provisioner exports the display it just brought up.
      process.env.DISPLAY = ':99';
    });

    await launchAndCatch();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(launches.calls).toHaveLength(1);

    // ORDER IS THE WHOLE POINT. Provisioning after the launch attempt would be
    // useless, and provisioning after screenSize() would measure a display that
    // did not exist yet -- the black-margin bug desktop-fills-screen.test.ts
    // pins. So: provision, then measure, then launch.
    expect(order).toEqual(['ensureDisplay', 'screenSize']);

    // And the display it provisioned is the one Chrome was actually handed.
    expect(launches.calls[0].display).toBe(':99');
  });

  it('still attempts the launch when provisioning is impossible', async () => {
    (config as unknown as Record<string, unknown>).REAL_CHROME_HEADLESS = false;

    // The box has no apt privilege, or no network. Desktop throws.
    vi.spyOn(Desktop, 'ensureDisplay').mockRejectedValue(
      new Error('Missing: Xvfb (and it could not be installed)'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const msg = await launchAndCatch();

    // DEGRADE, NEVER THROW. A display may already exist by some other means
    // (a real desktop, a sidecar container, an operator's own Xvfb), so the
    // launch must still be tried.
    expect(launches.calls).toHaveLength(1);

    // If it then fails for want of a display, the user must get the SPECIFIC,
    // actionable message that names the package -- not the provisioner's
    // internal complaint. Rethrowing above would have destroyed this.
    expect(msg).toContain('Xvfb');
    expect(msg).not.toContain('could not be installed');

    // The provisioning failure is still recorded, just not fatally.
    expect(warn.mock.calls.flat().join(' ')).toContain('could not provision');
  });

  it('does not provision anything in headless mode', async () => {
    (config as unknown as Record<string, unknown>).REAL_CHROME_HEADLESS = true;

    const ensure = vi.spyOn(Desktop, 'ensureDisplay').mockResolvedValue(undefined);

    await launchAndCatch();

    // Headless Chrome needs no X server, so installing and starting one would
    // be a pure cost -- an apt call and a stray process on every server that
    // deliberately runs without a desktop.
    expect(ensure).not.toHaveBeenCalled();
    expect(order).not.toContain('screenSize');
    expect(launches.calls[0].headless).toBe(true);
  });
});
