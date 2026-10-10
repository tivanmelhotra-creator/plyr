/**
 * RunPolicy — how a run's browser is shown, decided by WHO started the run.
 *
 * One rule, no setting, no per-workflow switch:
 *
 *   manual      the operator clicked Run / Execute Workflow / Run node in the
 *               editor. Visible browser, so the automation can be watched
 *               while it is built, tested and debugged.
 *   automatic   anything not caused by a direct click: a schedule, a trigger,
 *               an API call to a saved workflow, an integration's POST /run.
 *               Hidden (background) browser.
 *
 * WHY NOT `active` / a "Live browser" switch / the environment
 * -----------------------------------------------------------
 * `active` says whether triggers may start a workflow; it says nothing about a
 * given run (an active workflow is still tested by hand, visibly). The old
 * per-workflow `liveBrowser` switch and the global "Browser during runs" choice
 * asked the operator something the system already knows. The environment
 * (development/production) describes the install, not the run.
 *
 * HIDDEN STILL MEANS EXTENSIONS WORK
 * ----------------------------------
 * Playwright's default `headless: true` launches the *headless shell*, which
 * has no extension host (MEASURED, playwright 1.56.1 / chromium-1194: 0
 * extension service workers). Chromium's NEW headless mode — the full browser
 * binary, selected with `channel: 'chromium'` — loads them (MEASURED: 1
 * extension service worker). So every hidden launch goes through
 * `hiddenLaunchOptions()`. See tests/browser/run-visibility-extensions.test.ts.
 *
 * The Launch Browser node's own `headless` option still wins
 * (core/BrowserOptions.effectiveHeadless): that is a per-NODE choice the
 * workflow author made explicitly, not a global toggle.
 */

export type RunOrigin = 'manual' | 'automatic';

/** Normalise whatever a route or a stored job says into an origin. */
export function runOriginOf(value: unknown): RunOrigin {
  return value === 'manual' ? 'manual' : 'automatic';
}

/** `headless` for the run, from its origin. Manual = visible. */
export function headlessFor(origin: RunOrigin): boolean {
  return origin !== 'manual';
}

/**
 * Launch options that make a hidden browser keep its extensions: the full
 * Chromium binary in new-headless mode instead of the extension-less headless
 * shell. Not needed when a system Chrome is pinned (CHROME_EXE): its
 * `--headless` is already the new mode.
 */
export function hiddenLaunchOptions(headless: boolean, chromeExe?: string): { channel?: string } {
  if (!headless || chromeExe) return {};
  return { channel: 'chromium' };
}

/** Label for logs and the live view. */
export function describeVisibility(headless: boolean): 'visible' | 'hidden' {
  return headless ? 'hidden' : 'visible';
}
