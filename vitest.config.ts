import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * THREE TIERS, AND WHY THE THIRD ONE HAD TO BE SPLIT OUT
 * -----------------------------------------------------
 * - tests/unit/**        pure. They import src modules directly and touch
 *                        nothing outside the process. src/config.ts only reads
 *                        env (no Redis, no network), so importing the
 *                        validation/helpers/condition/schemas modules has no
 *                        side-effects.
 *
 * - tests/integration/** spin up a lightweight Express app and talk to a live
 *                        Redis; they self-skip when Redis is unavailable.
 *
 * - tests/browser/**     launch a REAL Chromium. NOT collected by `npm test`.
 *
 * The third tier used to live in tests/unit/, and that was the reported defect:
 *
 *   «npm test هنگ می‌کند — tests/unit/picker-drive.test.ts مرورگر واقعی اجرا
 *    می‌کند. یک unit test نباید این کار را بکند»
 *
 * Two files (picker-drive, live-browser-download-names) needed a ~400 MB browser
 * download plus system libraries, while sitting in the directory whose whole
 * promise is "fast and hermetic". `npm test` is the command a contributor runs in
 * a loop, so the slowest and least portable suites in the project were attached
 * to the one command that must never hang.
 *
 * WHY EXCLUDED RATHER THAN GUARDED IN PLACE
 * -----------------------------------------
 * Each of those files already had a try/catch around `chromium.launch()`, so
 * they DID degrade to a skip — and the suite still took a launch timeout per
 * file to discover that, every run, on every machine without a browser. A guard
 * cannot make an absent dependency cheap; only not reaching for it can.
 *
 * They are not deleted and not weakened: `npm run test:browser` runs them, CI
 * installs Chromium and runs them there (.github/workflows/ci.yml), and
 * tests/browser/real-browser.ts bounds the launch so even that path cannot hang.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // `tests/browser/**` is deliberately absent. Adding it back re-attaches a
    // real browser download to `npm test`.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Force a deterministic test env (API keys, admin secret, CORS) BEFORE any
    // src module imports src/config.ts.
    setupFiles: ['./tests/integration/setup.ts'],
    // Run serially to avoid Redis key collisions across integration suites.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15000,
    hookTimeout: 20000,
    reporters: 'default',
  },
});
