/**
 * SelfHeal — "no restart may ever be required".
 *
 * THE PROBLEM THIS EXISTS TO DELETE
 * ---------------------------------
 * The old flow for installing an extension ended in a sentence:
 *
 *     "Installed. Restart the browser to load it — Chrome only reads
 *      extensions at launch."
 *
 * Every word of that is true and the whole thing is a defect. It tells the
 * person what the SERVER needs, not what they should do, and it does not say
 * which restart is meant — the Chrome the extension loads into, the Node
 * process, or the machine. The reported experience was pressing the button that
 * looked most like it, watching nothing happen, and being left, in the user's
 * own words, گیج و منگ — dazed and confused. The same shape appeared for a
 * missing X display ("Start it with: bash scripts/desktop.sh start", to someone
 * who has no shell on that machine) and for an extension URL ("Upload it, then
 * POST /browser/restart", to someone who is holding a mouse).
 *
 * A message asking a user to do a thing the server can do itself is a bug
 * report the server is filing against its own user.
 *
 * WHAT REPLACES IT
 * ----------------
 * One entry point per intention, each of which DOES the work:
 *
 *   ensureBrowser()      — a live Chrome, whatever it takes: bring up the
 *                          virtual display, launch Chrome, verify it answers.
 *   reloadExtensions()   — Chrome genuinely does only read extensions at
 *                          launch, so this relaunches it. That fact is a fact
 *                          about Chrome; making the USER act on it was the
 *                          choice, and this is the other choice.
 *
 * WHY EVERY STEP REPORTS
 * ----------------------
 * The second half of the mandate: whenever the user waits, the UI must explain
 * who is doing what and roughly how long. So these are not silent
 * fire-and-forget helpers — each publishes a `HealStep` before it starts and
 * after it ends, carrying a stable `key` (so the client can translate it into
 * fa/en rather than displaying an English sentence from the server), a human
 * `detail`, and an `etaMs` that is an honest measured order of magnitude rather
 * than a spinner that means nothing.
 *
 * WHY IT STILL REPORTS FAILURE
 * ----------------------------
 * Self-healing is not the same as pretending. If Xvfb is genuinely not
 * installed, no amount of retrying installs it — and at that point the honest
 * answer names the missing package. The rule is not "never tell the user
 * anything", it is "never ask the user to do something we could have done".
 */

import { Desktop, DesktopError, displayGuidance } from './Desktop';
import { RealChrome, type RealChromeStatus } from './RealChrome';
import { listExtensions } from './ChromeExtensions';
import { config } from '../config';

/** One unit of work the user may be waiting on. */
export interface HealStep {
  /**
   * Stable identifier, translated by the client.
   *
   * Never a sentence: an English string invented here would arrive in a Persian
   * UI as English, and the UI is required to be both.
   */
  key:
  | 'checkingDisplay'
  | 'startingDisplay'
  | 'startingChrome'
  | 'stoppingChrome'
  | 'loadingExtensions'
  | 'verifying'
  | 'restoringTabs';
  state: 'running' | 'done' | 'failed';
  /** 1-based position and the total, so a progress bar can be a real fraction. */
  index: number;
  total: number;
  /**
   * A measured order of magnitude, in ms, for the CURRENT step.
   *
   * Present only for steps that actually take time. A number here is a promise
   * to the user, so it is deliberately generous: an estimate that is beaten
   * feels fast, one that is missed feels broken.
   */
  etaMs?: number;
  /** Free text that names a specific thing (an extension, a display, an error). */
  detail?: string;
}

export type HealReporter = (step: HealStep) => void;

export interface HealResult {
  ok: boolean;
  realChrome: RealChromeStatus;
  /** Populated only on failure, and only with something the user can act on. */
  problem?: string;
  hint?: string;
}

/**
 * Measured, not guessed.
 *
 * Xvfb reaches its lock file in well under a second on this box; a Chrome
 * launch with extensions took ~1.5-4s across the probe runs. These are the
 * numbers shown to the user, so they are rounded UP.
 */
const ETA = {
  display: 3_000,
  chromeStart: 6_000,
  chromeStop: 2_000,
  verify: 1_500,
} as const;

export class SelfHeal {
  /**
   * Serialise every heal. Two concurrent heals would fight over one
   * user-data-dir, which Chrome resolves by refusing to start the second — a
   * self-inflicted failure in the code whose entire job is to not have any.
   */
  private static chain: Promise<unknown> = Promise.resolve();

  private static queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Keep the chain alive after a rejection: one failed heal must not poison
    // every later attempt.
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * A working Chrome, or an honest explanation.
   *
   * Idempotent and cheap when everything is already up: the common case is one
   * status check and no work at all, which matters because this is called on
   * every action that needs a browser rather than only on an explicit "start".
   */
  static ensureBrowser(report: HealReporter = () => {}): Promise<HealResult> {
    return this.queue(() => this.doEnsureBrowser(report));
  }

  private static async doEnsureBrowser(report: HealReporter): Promise<HealResult> {
    const total = 3;
    if (!RealChrome.isEnabled()) {
      // Not a healable condition: it is a deliberate configuration choice, and
      // guessing that the operator wanted it on would be worse than saying so.
      return {
        ok: false,
        realChrome: await RealChrome.status(),
        problem: 'realChromeDisabled',
        hint: 'REAL_CHROME_ENABLED=true',
      };
    }

    // ── 1. A screen to draw on ──────────────────────────────────────────────
    // Extensions only load in a HEADED Chrome, so on a server this means a
    // virtual X display. This used to be a message; it is now an action.
    report({ key: 'checkingDisplay', state: 'running', index: 1, total });
    if (!config.REAL_CHROME_HEADLESS) {
      const before = await Desktop.status();
      if (!before.displayRunning) {
        report({
          key: 'startingDisplay', state: 'running', index: 1, total,
          etaMs: ETA.display, detail: before.display,
        });
        try {
          // The full stack first (a display AND a way to watch it), but never
          // let a missing VIEWER block the BROWSER: x11vnc/websockify are how a
          // human looks at the screen, Xvfb *is* the screen.
          try { await Desktop.start(); }
          catch { await Desktop.ensureDisplay(); }
        } catch (e) {
          const st = await Desktop.status();
          if (!st.displayRunning) {
            report({
              key: 'startingDisplay', state: 'failed', index: 1, total,
              detail: e instanceof DesktopError ? e.message : String((e as Error).message || e),
            });
            // The one case where the user really is the only one who can act:
            // the package is not on the machine. Name it and the command.
            return {
              ok: false,
              realChrome: await RealChrome.status(),
              problem: displayGuidance(st.missing, st.display),
              hint: st.installHint,
            };
          }
        }
        report({ key: 'startingDisplay', state: 'done', index: 1, total, detail: before.display });
      }
    }
    report({ key: 'checkingDisplay', state: 'done', index: 1, total });

    // ── 2. Chrome itself ────────────────────────────────────────────────────
    report({
      key: 'startingChrome', state: 'running', index: 2, total,
      etaMs: RealChrome.isRunning() ? 0 : ETA.chromeStart,
    });
    try {
      await RealChrome.getContext();
    } catch (e) {
      report({
        key: 'startingChrome', state: 'failed', index: 2, total,
        detail: String((e as Error).message || e),
      });
      return {
        ok: false,
        realChrome: await RealChrome.status(),
        problem: String((e as Error).message || e),
      };
    }
    report({ key: 'startingChrome', state: 'done', index: 2, total });

    // ── 3. Say so only once it is TRUE ──────────────────────────────────────
    // `isRunning()` is "we hold a context object", which is not the same as
    // "Chrome answers". Reporting success on the weaker claim is how a UI ends
    // up green while the browser is dead — the exact "dead but connected" state
    // the stability requirement forbids.
    report({ key: 'verifying', state: 'running', index: 3, total, etaMs: ETA.verify });
    const status = await RealChrome.status();
    report({ key: 'verifying', state: status.running ? 'done' : 'failed', index: 3, total });
    return { ok: !!status.running, realChrome: status };
  }

  /**
   * Load newly installed extensions — by relaunching Chrome, here, now.
   *
   * Chrome reads `--load-extension` at launch and there is no CDP or DevTools
   * call that adds an unpacked extension to a running instance. That constraint
   * is real. What was NOT real was the conclusion that the user therefore has to
   * press a button: the server can do exactly the same restart, and it knows
   * when it is needed.
   *
   * `onSwap` runs between stop and start. That is where live sessions rebuild
   * themselves, and it is the mechanism behind "we never lose a tab": the strip
   * is already persisted, so a session that recovers onto the new Chrome comes
   * back with the same tabs instead of a blank window.
   */
  static reloadExtensions(
    report: HealReporter = () => {},
    onSwap: () => Promise<void> = async () => {},
  ): Promise<HealResult> {
    return this.queue(() => this.doReloadExtensions(report, onSwap));
  }

  private static async doReloadExtensions(
    report: HealReporter,
    onSwap: () => Promise<void>,
  ): Promise<HealResult> {
    const total = 4;
    if (!RealChrome.isEnabled()) {
      return {
        ok: false,
        realChrome: await RealChrome.status(),
        problem: 'realChromeDisabled',
        hint: 'REAL_CHROME_ENABLED=true',
      };
    }

    // Name what is being loaded. "Restarting…" tells the user nothing they can
    // check; "Loading J2TEAM Cookies…" tells them whether the thing they just
    // installed is the thing that is happening.
    let names = '';
    try {
      const installed = await listExtensions(config.REAL_CHROME_EXTENSIONS_DIR);
      names = installed.map((x) => x.name).filter(Boolean).join(', ');
    } catch { /* the name is a nicety; the reload is not */ }

    report({
      key: 'loadingExtensions', state: 'running', index: 1, total,
      etaMs: ETA.chromeStop + ETA.chromeStart, detail: names,
    });

    // ── Stop ────────────────────────────────────────────────────────────────
    report({ key: 'stoppingChrome', state: 'running', index: 2, total, etaMs: ETA.chromeStop });
    try {
      await RealChrome.stop();
    } catch (e) {
      // A stop that fails still leaves us wanting a fresh Chrome, so this is
      // reported and then ignored rather than aborting the heal.
      report({
        key: 'stoppingChrome', state: 'failed', index: 2, total,
        detail: String((e as Error).message || e),
      });
    }
    report({ key: 'stoppingChrome', state: 'done', index: 2, total });

    // ── Start again, display included ───────────────────────────────────────
    // Through `doEnsureBrowser`, not `RealChrome.getContext()`, so a display
    // that died along with Chrome is brought back too. Already inside the
    // queue, hence the private method: calling the public one would deadlock on
    // its own chain.
    const started = await this.doEnsureBrowser((s) =>
      // Re-index onto this operation's step count so the client's progress bar
      // does not jump backwards mid-heal.
      report({ ...s, index: 3, total }));
    if (!started.ok) {
      report({ key: 'loadingExtensions', state: 'failed', index: 1, total, detail: names });
      return started;
    }

    // ── Put the user's tabs back ────────────────────────────────────────────
    report({ key: 'restoringTabs', state: 'running', index: 4, total, etaMs: ETA.verify });
    try { await onSwap(); }
    catch { /* a session that cannot rebuild reports its own state over its own socket */ }
    report({ key: 'restoringTabs', state: 'done', index: 4, total });

    const status = await RealChrome.status();
    report({ key: 'loadingExtensions', state: 'done', index: 1, total, detail: names });
    return { ok: !!status.running, realChrome: status };
  }
}
