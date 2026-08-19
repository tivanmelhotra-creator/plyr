/**
 * BrowserRuntimeRecovery — make the REMOTE browser runtime ready by itself.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The measured defect: clicking the crosshair and choosing REMOTE BROWSER
 * surfaced
 *
 *     remote_browser_disabled
 *     The Remote Browser is switched off for this instance
 *
 * and stopped the work. Tracing it end to end:
 *
 *   1. `config.REAL_CHROME_ENABLED` is a getter over
 *      `RuntimeSettings.settingValue('REAL_CHROME_ENABLED')`, whose fallback is
 *      `true`. A `false` therefore only ever comes from an explicit `.env` /
 *      environment value on the instance.
 *   2. When it is false `RealChrome.getContext()` throws
 *      `disabledExplanation()`, and `RemoteBrowserStart.describe()` converts
 *      that throw into `{ error: 'remote_browser_disabled', … }` + HTTP 503.
 *   3. `SelfHeal.ensureBrowser()` deliberately refuses to flip the flag: it
 *      reports `problem: 'realChromeDisabled'` and gives up.
 *   4. THE DECISIVE GAP: `POST /browser/start` (browser.routes.ts:343) and
 *      `POST /browser/enable` (browser.routes.ts:417) both self-enable the
 *      setting before starting — but `POST /browser/real/open`, which is the
 *      ONLY endpoint the targeting crosshair reaches, did not. So the one path
 *      a user actually walks was the one path with no repair.
 *
 * The contract this module implements: a targeting request may not be refused
 * for a reason the server is able to fix itself. The user must never be told to
 * hand-edit `REAL_CHROME_ENABLED=true`.
 *
 * HARD INVARIANT — NEVER RESTART THE APPLICATION
 * ---------------------------------------------------------------------------
 * Recovery may restart the *browser* process and nothing else. This file must
 * never contain `process.exit`, `process.kill`, `execSync`, a pm2 call, or any
 * other instruction that would take down the main application: killing the app
 * to fix a browser would drop `/health`, every in-flight run and every open
 * dashboard socket — a far worse outcome than the error being repaired.
 *
 * `tests/unit/browser-runtime-recovery.test.ts` reads this file's own source
 * and fails if any of those tokens ever appear, so the invariant is enforced by
 * the suite rather than by convention.
 */

import { config } from '../config';
import { applySetting } from './RuntimeSettings';
import { RealChrome } from './RealChrome';

/** One recorded action, so the caller can show *what* was repaired. */
export interface RecoveryStep {
  /**
   * `enable`   — the REAL_CHROME_ENABLED runtime setting.
   * `selfheal` — the self-heal supervisor that keeps the browser alive.
   * `browser`  — the Chrome/Chromium process itself.
   */
  id: 'enable' | 'selfheal' | 'browser';
  /**
   * `ok`      — already in the desired state, nothing done.
   * `changed` — this step repaired something.
   * `failed`  — this step could not reach the desired state.
   * `skipped` — not applicable on this request.
   */
  state: 'ok' | 'changed' | 'failed' | 'skipped';
  detail: string;
}

export interface RuntimeReadyResult {
  /** False only when the runtime genuinely cannot be made ready. */
  ok: boolean;
  /** True when at least one step had to change something. */
  repaired: boolean;
  steps: RecoveryStep[];
  /** Present only when `ok` is false. */
  problem?: 'enable_failed';
  hint?: string;
}

/**
 * Turn the REMOTE browser runtime on if it is off.
 *
 * `applySetting` writes three places at once — the in-memory override, the
 * `process.env` value that child processes inherit, and an idempotent `.env`
 * rewrite — so the repair survives a later restart instead of having to happen
 * again on every request. A failed `.env` write is NOT fatal: the in-memory
 * override is already in force, which is all this request needs.
 */
export async function ensureRuntimeEnabled(): Promise<{
  ok: boolean;
  changed: boolean;
  step: RecoveryStep;
}> {
  if (config.REAL_CHROME_ENABLED === true) {
    return {
      ok: true,
      changed: false,
      step: { id: 'enable', state: 'ok', detail: 'the browser runtime was already enabled' },
    };
  }

  let persistError: string | undefined;
  try {
    const applied = await applySetting('REAL_CHROME_ENABLED', true);
    persistError = applied.persistError;
  } catch (err) {
    return {
      ok: false,
      changed: false,
      step: {
        id: 'enable',
        state: 'failed',
        detail: `the browser runtime could not be enabled: ${(err as Error).message}`,
      },
    };
  }

  // Re-read through an alias that TypeScript will not narrow. The early return
  // above taught the compiler that this value is `false` on this branch, so
  // reading `config.REAL_CHROME_ENABLED` directly would be flagged as an
  // impossible comparison (TS2367) even though the getter's answer has just
  // changed underneath us. The alias asks the getter again for real.
  const liveConfig = config as { REAL_CHROME_ENABLED: boolean };
  if (liveConfig.REAL_CHROME_ENABLED !== true) {
    return {
      ok: false,
      changed: false,
      step: {
        id: 'enable',
        state: 'failed',
        detail: 'the browser runtime setting did not take effect',
      },
    };
  }

  // eslint-disable-next-line no-console
  console.log(
    '[BROWSER-RUNTIME] enabled automatically for a targeting request' +
      (persistError ? ` (in memory only — .env write failed: ${persistError})` : ''),
  );

  return {
    ok: true,
    changed: true,
    step: {
      id: 'enable',
      state: 'changed',
      detail: persistError
        ? 'enabled the browser runtime for this process (.env could not be written)'
        : 'enabled the browser runtime',
    },
  };
}

/**
 * Make the runtime ready to start a real browser, repairing what can be
 * repaired. Called by `POST /browser/real/open` before it starts anything.
 *
 * Ordering matters: enabling the setting has to come first, because both later
 * steps are no-ops while the runtime is switched off.
 */
export async function ensureRuntimeReady(): Promise<RuntimeReadyResult> {
  const steps: RecoveryStep[] = [];
  let repaired = false;

  // 1. The setting that `RealChrome.getContext()` checks.
  const enabled = await ensureRuntimeEnabled();
  steps.push(enabled.step);
  if (enabled.changed) repaired = true;
  if (!enabled.ok) {
    return {
      ok: false,
      repaired,
      steps,
      problem: 'enable_failed',
      hint:
        'The browser runtime could not be switched on automatically. ' +
        'Check that the server process may write its own configuration.',
    };
  }

  // 2. The supervisor that keeps the browser alive. Imported lazily: SelfHeal
  //    pulls in the whole browser stack, and this module is imported by a route
  //    file that must stay cheap to load.
  try {
    const { isSelfHealEnabled, setSelfHealEnabled } = await import('./SelfHeal');
    if (!isSelfHealEnabled()) {
      setSelfHealEnabled(true);
      repaired = true;
      steps.push({ id: 'selfheal', state: 'changed', detail: 're-enabled browser self-healing' });
    } else {
      steps.push({ id: 'selfheal', state: 'ok', detail: 'browser self-healing was already on' });
    }
  } catch (err) {
    // Not fatal — the browser can still be started without the supervisor.
    steps.push({
      id: 'selfheal',
      state: 'failed',
      detail: `browser self-healing could not be re-enabled: ${(err as Error).message}`,
    });
  }

  // 3. The browser process. ONLY a browser that is running but no longer
  //    answering is recycled. A browser that is not running is left alone: the
  //    caller is about to start one, and starting it here would race with that.
  //    This is the only process this module is ever allowed to restart.
  try {
    if (RealChrome.isRunning()) {
      const recycled = await RealChrome.recycleIfWedged();
      if (recycled.action === 'recycled') {
        repaired = true;
        steps.push({
          id: 'browser',
          state: 'changed',
          detail: `restarted the unresponsive browser process (${recycled.reason})`,
        });
      } else {
        steps.push({ id: 'browser', state: 'ok', detail: recycled.reason });
      }
    } else {
      steps.push({
        id: 'browser',
        state: 'skipped',
        detail: 'no browser running yet — the caller will start one',
      });
    }
  } catch (err) {
    // A failed recycle is not fatal either: the caller's own start attempt is
    // still ahead, and it has its own error reporting.
    steps.push({
      id: 'browser',
      state: 'failed',
      detail: `the browser process could not be checked: ${(err as Error).message}`,
    });
  }

  return { ok: true, repaired, steps };
}
