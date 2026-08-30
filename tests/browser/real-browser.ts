/**
 * real-browser.ts — the ONE place that decides whether a real Chromium may be
 * launched from the test suite, and the only place allowed to launch one.
 *
 * ── WHY tests/browser/ EXISTS AT ALL ────────────────────────────────────────
 * REPORTED: «`npm test` هنگ می‌کند — tests/unit/picker-drive.test.ts مرورگر واقعی
 * اجرا می‌کند. یک unit test نباید این کار را بکند».
 *
 * That is correct, and it was correct for a second file too
 * (live-browser-download-names.test.ts, which boots a LiveBrowserManager and a
 * real HTTP server). Both used to sit in tests/unit/, where the name promises
 * the opposite of what they do:
 *
 *   - a unit test is expected to be fast, hermetic and dependency-free, so it is
 *     the one kind of test people run in a tight loop and in a pre-commit hook;
 *   - these two need a ~400 MB browser download plus system libraries, and each
 *     `chromium.launch()` that cannot connect burns its own timeout before it
 *     gives up.
 *
 * Two independent problems came out of that mislabelling, and this file exists
 * to fix the SECOND one — the first is fixed by the directory move itself:
 *
 *   1. CLASSIFICATION. They are not unit tests, so they now live in
 *      tests/browser/. `npm test` no longer collects them (see the `include` in
 *      vitest.config.ts); `npm run test:browser` runs them deliberately.
 *
 *   2. THE HANG. Each file previously carried its OWN try/catch around
 *      `chromium.launch()`, with no timeout and no shared budget. A launch that
 *      neither succeeds nor fails promptly — the usual shape when the executable
 *      is present but a shared library is missing, or when a sandboxed CI kills
 *      the child — sits there until vitest's hook timeout, per file, per attempt.
 *      That is the hang, and moving files does not cure it: it just moves it.
 *
 * So the launch decision is made ONCE, here, with three properties the old
 * per-file guards did not have:
 *
 *   * BOUNDED. `Promise.race` against a real timer, so an unresponsive launch is
 *     abandoned on a schedule instead of hanging until the framework intervenes.
 *
 *   * CACHED. One probe per process. Ten suites cannot pay ten timeouts, which
 *     is what made the failure mode scale with the size of the suite.
 *
 *   * HONEST. A skip announces itself with the reason. A guard that silently
 *     turns into a no-op is worse than no guard: `16 passed` while nothing ran
 *     is how a browser-dependent regression ships green. `describeBrowser` marks
 *     the whole block skipped through vitest's own mechanism, so the reporter
 *     says `skipped`, not `passed`.
 *
 * ── WHY NOT JUST INSTALL THE BROWSER IN CI ──────────────────────────────────
 * CI does now install it (`npx playwright install --with-deps chromium` in
 * .github/workflows/ci.yml), so on GitHub these suites really run. But the guard
 * is still required, because "the browser is missing" is the NORMAL state on a
 * contributor's laptop and inside the Docker build, where scripts/postinstall.js
 * is deliberately skipped with SKIP_BROWSER_INSTALL=1. A suite that fails there
 * teaches people to distrust the test suite; a suite that HANGS there teaches
 * them not to run it.
 */
import { describe } from 'vitest';
import type { Browser } from 'playwright';

/**
 * How long a launch may take before it is treated as unavailable.
 *
 * 45s is chosen against the slowest legitimate case — a cold, throttled CI
 * runner launching Chromium for the first time — not against a warm laptop
 * (~1s). Anything beyond it is not slow, it is stuck: the failures this bounds
 * (missing shared library, no sandbox permission, killed child) do not resolve
 * with more waiting.
 */
const LAUNCH_TIMEOUT_MS = 45_000;

export interface BrowserAvailability {
  available: boolean;
  /** Empty when available; a human-readable cause when not. */
  reason: string;
}

/**
 * The cached probe result. `null` = not probed yet.
 *
 * Module scope, so it is per worker process. vitest runs this project in a
 * single fork (see poolOptions), so in practice this is one probe per run.
 */
let cached: BrowserAvailability | null = null;
let shared: Browser | null = null;

/** Reject after `ms`, so a stuck launch cannot outlive its budget. */
function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Chromium did not launch within ${ms}ms`)),
      ms,
    );
    // Do not hold the event loop open on this timer: if the launch wins the
    // race, an un-unref'd timer would keep the process alive for the full
    // budget after the tests have finished — which looks exactly like the hang
    // this file exists to remove.
    if (typeof t === 'object' && t && 'unref' in t) (t as NodeJS.Timeout).unref();
  });
}

/**
 * Probe once: can a real Chromium be launched here?
 *
 * Returns the reason rather than throwing, because the CALLER's correct
 * behaviour is to skip, and a thrown error would make an environment problem
 * look like a product failure.
 */
export async function browserAvailability(): Promise<BrowserAvailability> {
  if (cached) return cached;

  try {
    const { chromium } = await import('playwright');
    shared = await Promise.race([
      chromium.launch(),
      timeout(LAUNCH_TIMEOUT_MS),
    ]);
    cached = { available: true, reason: '' };
  } catch (e) {
    // First line only. Playwright's launch error is a long, boxed message with
    // install instructions; the first line is the diagnosis and the rest is
    // noise in a test reporter.
    const msg = String((e as Error)?.message || e).split('\n')[0].trim();
    cached = { available: false, reason: msg || 'Chromium is unavailable' };
  }

  return cached;
}

/**
 * The shared browser, launched at most once per process.
 *
 * Shared rather than per-file because launching Chromium is the expensive part
 * of these suites, and each file only needs isolated PAGES, which it gets from
 * `newPage()`/`newContext()` anyway.
 */
export async function sharedBrowser(): Promise<Browser> {
  const probe = await browserAvailability();
  if (!probe.available || !shared) {
    throw new Error(`Chromium is unavailable: ${probe.reason}`);
  }
  return shared;
}

export async function closeSharedBrowser(): Promise<void> {
  if (shared) {
    await shared.close().catch(() => { /* teardown is best-effort */ });
    shared = null;
    cached = null;
  }
}

/**
 * `describe` that becomes a real SKIP when no browser can be launched.
 *
 * Why the probe runs here, at collection time, rather than in a `beforeAll`:
 * vitest must know whether to mark the block skipped before it reports it. A
 * `beforeAll` that sets a flag can only produce tests that pass while asserting
 * nothing — the silent-no-op failure mode described in the header.
 */
export function describeBrowser(name: string, fn: () => void): void {
  const probe = await_(browserAvailability());
  if (probe.available) {
    describe(name, fn);
    return;
  }
  describe.skip(`${name} [skipped: ${probe.reason}]`, fn);
}

/**
 * Await a promise during module evaluation.
 *
 * vitest supports top-level await in test files, so this is only needed to keep
 * `describeBrowser` callable as an ordinary function from a non-async module
 * scope. The promise is the cached probe, so this resolves immediately on every
 * call after the first.
 */
function await_<T>(p: Promise<T>): T {
  // Deliberately NOT a busy-wait. The probe is kicked off by the FIRST caller
  // via `ensureProbed()` below, which the suites await at module scope; by the
  // time `describeBrowser` runs, `cached` is populated and this returns it.
  if (cached) return cached as unknown as T;
  throw new Error(
    'describeBrowser() was called before the availability probe resolved. '
    + 'Add `await ensureProbed();` at the top of the test file, above the '
    + 'first describeBrowser() call.',
  );
}

/**
 * Resolve the probe before any `describeBrowser` call.
 *
 * Called with a top-level `await` in each browser suite. This is what lets the
 * skip decision be made synchronously (and therefore visibly, as a skip rather
 * than as a fake pass) inside `describeBrowser`.
 */
export async function ensureProbed(): Promise<BrowserAvailability> {
  return browserAvailability();
}
