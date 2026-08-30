import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the BROWSER tier — `npm run test:browser`.
 *
 * Separate from vitest.config.ts so that `npm test` cannot collect these suites
 * by accident. See the header of vitest.config.ts for why the split exists at
 * all; in short, two suites that launch a real Chromium were living in
 * tests/unit/ and made `npm test` hang on any machine without the browser.
 *
 * The timeouts here are much larger than the unit/integration ones because they
 * are measuring a different thing: a cold Chromium launch on a throttled CI
 * runner, plus real page navigation and real downloads. They are still finite —
 * tests/browser/real-browser.ts bounds the launch itself, so an unavailable
 * browser produces a visible SKIP quickly rather than consuming these budgets.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/browser/**/*.test.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    // One browser is shared across these suites (see sharedBrowser()), which
    // only works if they run in the same process.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: 'default',
  },
});
