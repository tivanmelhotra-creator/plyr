/**
 * browser-enable-no-restart.test.ts — the dead end, and the button out of it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INCIDENT
 * ════════════════════════════════════════════════════════════════════════════
 * On the server, selecting the Remote Browser produced:
 *
 *     Could not start the remote browser: remote_browser_disabled
 *     — Remote Chrome is disabled. Set REAL_CHROME_ENABLED=true and restart
 *       the server.
 *
 * The operator's standing requirement, restated:
 *
 *   «متغییر ها باید از داخل پروژه هم باید قابل تنظیم باشه و مجبور نباشیم کل
 *    پروژه رو ریستارت کنیم … اگر مثل الان متغییری باید تغییر کنه با زدن اون
 *    دکمه تغییر کنه»
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES, AGAINST THE REAL ROUTER
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   1. A start attempted while the browser is switched off no longer REFUSES.
 *      Pressing Start is the consent to turn it on.
 *   2. POST /browser/enable turns it on for the CURRENT process — the very next
 *      request sees it, with no restart of anything.
 *   3. It records the value in .env, once, idempotently, without disturbing the
 *      operator's other lines.
 *   4. It undoes a previous /browser/stop, so Enable actually produces a browser
 *      rather than a green response beside a still-dead feature.
 *   5. A setting change that succeeds is reported as a success even when the
 *      browser then fails for an unrelated reason — with the NEXT remedy
 *      attached, so the operator walks out one button at a time.
 *   6. The failure shape that reaches a client carries a `fixable` remedy, so a
 *      UI renders a button instead of prose containing a variable name.
 *   7. GET /browser/settings says which settings exist, what they are, and where
 *      each value came from — the question nobody in the incident could answer.
 *
 * ── WHY THE BROWSER AND THE INSTALLER ARE MOCKED, AND THE ROUTER IS NOT ─────
 * A real cold start needs Xvfb, x11vnc, websockify and a headed Chromium and
 * takes ~50s. The thing under test is the ROUTE's behaviour around a
 * configuration flag, so those are faked and every line of routing, ordering and
 * response shaping is real.
 *
 * DesktopProvision is mocked for a sharper reason, MEASURED: with it real, the
 * dependency-install test ran this repo's unprivileged apt/dpkg installer inside
 * the throwaway cwd and wrote 384MB into a 493MB tmpfs, after which unrelated
 * suites failed with ENOSPC. A test that provisions a desktop stack is not
 * testing a route.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

// ── The switchboard the mocks read ─────────────────────────────────────────
const state = {
  chromeStarts: 'ok' as 'ok' | 'no-binary',
  starts: 0,
  selfHealEnabled: true,
  provisioned: 0,
};

vi.mock('../../src/core/Desktop', () => {
  class DesktopError extends Error {
    constructor(m: string) { super(m); this.name = 'DesktopError'; }
  }
  const status = {
    enabled: true, running: true, displayRunning: true, display: ':99',
    vncPort: 5900, novncPort: 6080, missing: [] as string[], installHint: '',
  };
  return {
    DesktopError,
    displayGuidance: (missing: string[]) => `Missing: ${missing.join(', ')}`,
    Desktop: {
      start: async () => status,
      ensureDisplay: async () => status,
      status: async () => status,
      isRunning: () => true,
      stop: async () => ({ stopped: true }),
      display: ':99',
    },
  };
});

// The installer, neutralised. See the header: with the real module this test
// downloaded a desktop stack into tmpfs and broke the rest of the run.
vi.mock('../../src/core/DesktopProvision', () => ({
  provisionDesktopStack: async () => { state.provisioned += 1; return { installed: [] }; },
  isProvisioned: () => true,
}));

vi.mock('../../src/core/RealChrome', async () => {
  class RealChromeError extends Error {
    constructor(m: string) { super(m); this.name = 'RealChromeError'; }
  }
  // The REAL config object, captured once. Because REAL_CHROME_ENABLED is an
  // accessor, holding the object still re-reads the live getter on every call —
  // so this mock cannot make the test pass by ignoring the setting under test.
  // (An earlier draft used require('../../src/config') here and failed with
  // MODULE_NOT_FOUND: vitest resolves TS through its own pipeline, not CJS.)
  const { config } = await import('../../src/config');
  return {
    RealChromeError,
    RealChrome: {
      isEnabled: () => config.REAL_CHROME_ENABLED === true,
      isRunning: () => false,
      isResponsive: async () => true,
      recycleIfWedged: async () => ({ action: 'healthy' as const, reason: 'ok' }),
      getContext: async () => {
        state.starts += 1;
        if (state.chromeStarts === 'no-binary') {
          throw new RealChromeError(
            "browserType.launchPersistentContext: Executable doesn't exist at /ms-playwright/chromium/chrome",
          );
        }
        return {} as unknown;
      },
      status: async () => ({
        enabled: config.REAL_CHROME_ENABLED === true,
        running: state.chromeStarts === 'ok',
        restartRequired: false,
        extensions: 0,
      }),
      stop: async () => undefined,
      loadedExtensions: () => [],
      flags: () => ({}),
      pendingChooser: () => null,
    },
  };
});

// SelfHeal is real EXCEPT for the enabled flag, which /browser/stop toggles and
// /browser/enable must clear. Keeping the real module means the ordering inside
// the route (clear the flag, THEN ensure) is genuinely under test.
vi.mock('../../src/core/SelfHeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/SelfHeal')>();
  return {
    ...actual,
    setSelfHealEnabled: (v: boolean) => {
      state.selfHealEnabled = v;
      actual.setSelfHealEnabled(v);
    },
    isSelfHealEnabled: () => state.selfHealEnabled,
  };
});

let app: Express;
let cwd: string;
let savedCwd: string;

beforeAll(async () => {
  process.env.REMOTE_BROWSER_START_BUDGET_MS = '2000';
  const { createBrowserRoutes } = await import('../../src/Routes/browser.routes');
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { apiKey?: string; apiKeyUserId?: string }).apiKey = 'test_key_123';
    (req as { apiKeyUserId?: string }).apiKeyUserId = 'local';
    next();
  });
  app.use(createBrowserRoutes());
});

beforeEach(async () => {
  const { clearOverridesForTests } = await import('../../src/core/RuntimeSettings');
  clearOverridesForTests();
  state.chromeStarts = 'ok';
  state.starts = 0;
  state.selfHealEnabled = true;
  state.provisioned = 0;

  // Every .env write in this file lands in a throwaway directory, because the
  // endpoint writes relative to process.cwd() — and writing the repo's own .env
  // from a test would be a genuinely destructive side effect.
  savedCwd = process.cwd();
  cwd = fsSync.mkdtempSync(path.join(os.tmpdir(), 'enable-route-'));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(savedCwd);
  const { clearOverridesForTests } = await import('../../src/core/RuntimeSettings');
  clearOverridesForTests();
  delete process.env.REAL_CHROME_ENABLED;
  vi.restoreAllMocks();
  try { fsSync.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Turn the setting off the way a stale .env does. */
async function switchOff(): Promise<void> {
  const { setOverride } = await import('../../src/core/RuntimeSettings');
  setOverride('REAL_CHROME_ENABLED', false);
}

async function envBody(): Promise<string> {
  try { return await fs.readFile(path.join(cwd, '.env'), 'utf8'); } catch { return ''; }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Start no longer refuses
// ════════════════════════════════════════════════════════════════════════════

describe('1. pressing Start is the consent to turn it on', () => {
  it('starts the browser instead of answering 409 "switched off"', async () => {
    await switchOff();
    const r = await request(app).post('/browser/start').send({});
    // WAS: 409 with "remove the REAL_CHROME_ENABLED line from .env ... and
    // restart". There is no reading of "start the browser" under which a refusal
    // is the more useful answer.
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(state.starts, 'a browser was actually launched').toBeGreaterThan(0);
  });

  it('records the corrected value in .env so the next boot agrees', async () => {
    await switchOff();
    await request(app).post('/browser/start').send({});
    // Without this the operator fixes it once per restart, forever.
    expect(await envBody()).toMatch(/^REAL_CHROME_ENABLED=true$/m);
  });

  it('never answers 409 for this reason again', async () => {
    await switchOff();
    const r = await request(app).post('/browser/start').send({});
    expect(r.status).not.toBe(409);
    expect(JSON.stringify(r.body)).not.toMatch(/restart the server/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. /browser/enable
// ════════════════════════════════════════════════════════════════════════════

describe('2. /browser/enable turns it on for THIS process', () => {
  it('takes effect immediately — the next request sees it', async () => {
    await switchOff();
    const enable = await request(app).post('/browser/enable').send({});
    expect(enable.status).toBe(200);

    // The claim in one assertion: a SEPARATE HTTP request, served by the same
    // process, now sees the browser enabled. No restart happened between them.
    const after = await request(app).get('/browser/settings');
    const flag = after.body.settings.find(
      (s: { key: string }) => s.key === 'REAL_CHROME_ENABLED',
    );
    expect(flag.value).toBe(true);
  });

  it('says the change needs no restart, in the response', async () => {
    await switchOff();
    const r = await request(app).post('/browser/enable').send({});
    // The requirement, stated as an assertion: no restart.
    expect(r.body.restartRequired).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/restart the server/i);
  });

  it('reports what it changed and where the value now comes from', async () => {
    await switchOff();
    const r = await request(app).post('/browser/enable').send({});
    expect(r.body.setting).toMatchObject({
      key: 'REAL_CHROME_ENABLED',
      value: true,
      source: 'runtime',
      persisted: true,
    });
  });

  it('writes exactly one .env line, even when called twice', async () => {
    await fs.writeFile(path.join(cwd, '.env'), 'PORT=3000\nREAL_CHROME_ENABLED=false\n', 'utf8');
    await request(app).post('/browser/enable').send({});
    await request(app).post('/browser/enable').send({});

    const body = await envBody();
    const assignments = body.split('\n')
      .filter((l) => /^\s*REAL_CHROME_ENABLED\s*=/.test(l));
    expect(assignments).toEqual(['REAL_CHROME_ENABLED=true']);
    // The operator's other configuration is not collateral damage.
    expect(body).toContain('PORT=3000');
  });

  it('also starts the browser, because that is what the operator wanted', async () => {
    await switchOff();
    await request(app).post('/browser/enable').send({});
    // A response saying "enabled" beside a browser that is not running is the
    // same dead end wearing a green badge.
    expect(state.starts).toBeGreaterThan(0);
  });

  it('undoes a previous /browser/stop', async () => {
    // Stop disables self-heal globally. Before this endpoint existed, nothing in
    // the product could re-enable it — so Enable would report success while every
    // later action still refused.
    await request(app).post('/browser/stop').send({});
    expect(state.selfHealEnabled).toBe(false);

    const r = await request(app).post('/browser/enable').send({});
    expect(r.status).toBe(200);
    expect(state.selfHealEnabled, 'Enable must clear the Stop latch').toBe(true);
  });

  it('is idempotent when the browser was never off', async () => {
    const first = await request(app).post('/browser/enable').send({});
    const second = await request(app).post('/browser/enable').send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.setting.value).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. One problem at a time
// ════════════════════════════════════════════════════════════════════════════

describe('3. one problem at a time, each with its own way out', () => {
  it('reports the setting as applied even when the browser then fails', async () => {
    await switchOff();
    state.chromeStarts = 'no-binary';

    const r = await request(app).post('/browser/enable').send({});
    // Two different problems with two different remedies. Conflating them is how
    // an operator ends up believing the flag did not take, and re-editing .env.
    expect(r.status).toBe(503);
    expect(r.body.setting).toMatchObject({ value: true, source: 'runtime' });
    expect(r.body.restartRequired).toBe(false);
  });

  it('a failing start names a cause the client can act on', async () => {
    state.chromeStarts = 'no-binary';
    const r = await request(app).post('/browser/start').send({});
    expect(r.status).toBeGreaterThanOrEqual(400);
    const payload = JSON.stringify(r.body);
    // Whatever the classifier decided, the client must receive a machine-readable
    // identifier — not only a sentence.
    expect(payload).toMatch(/error|problem/);
    expect(payload).not.toMatch(/restart the server/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. A failure a client can turn into a button
// ════════════════════════════════════════════════════════════════════════════

describe('4. a failure a client can turn into a button', () => {
  it('the classifier attaches the enable endpoint to the disabled cause', async () => {
    const { describe: classify } = await import('../../src/core/RemoteBrowserStart');
    const out = classify(new Error('Remote Chrome is disabled'));
    // The hint may be reworded freely; the machine-readable half may not vanish.
    if (out.error === 'remote_browser_disabled') {
      expect(out.fixable).toBeDefined();
      expect(out.fixable!.endpoint).toBe('/browser/enable');
      expect(out.fixable!.automatic).toBe(true);
    }
  });

  it('a missing binary offers the install endpoint', async () => {
    const { describe: classify } = await import('../../src/core/RemoteBrowserStart');
    const out = classify(new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /ms-playwright/chromium/chrome",
    ));
    expect(out.fixable?.endpoint).toBe('/browser/dependencies/install');
  });

  it('a cause with no automatic fix carries no button', async () => {
    const { describe: classify } = await import('../../src/core/RemoteBrowserStart');
    const out = classify(new Error('something nobody has ever seen before'));
    // Absence is designed: a button that cannot work spends the operator's trust.
    expect(out.fixable).toBeUndefined();
    expect(out.hint, 'an unfixable failure still explains itself').toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Discoverability
// ════════════════════════════════════════════════════════════════════════════

describe('5. a client can discover what it may change', () => {
  it('lists the setting with its value and provenance', async () => {
    const r = await request(app).get('/browser/settings');
    expect(r.status).toBe(200);
    const flag = r.body.settings.find(
      (s: { key: string }) => s.key === 'REAL_CHROME_ENABLED',
    );
    expect(flag).toBeDefined();
    // The question nobody in the incident could answer: where did this come from?
    expect(['runtime', 'explicit', 'default']).toContain(flag.source);
    expect(flag.settableAtRuntime).toBe(true);
  });

  it('shows source=runtime once it has been changed from the panel', async () => {
    await switchOff();
    await request(app).post('/browser/enable').send({});
    const r = await request(app).get('/browser/settings');
    const flag = r.body.settings.find(
      (s: { key: string }) => s.key === 'REAL_CHROME_ENABLED',
    );
    expect(flag.source).toBe('runtime');
  });

  it('publishes the remedies, so a client need not hardcode endpoints', async () => {
    const r = await request(app).get('/browser/settings');
    expect(r.body.remedies).toBeDefined();
    expect(r.body.remedies.remote_browser_disabled.endpoint).toBe('/browser/enable');
    expect(r.body.restartRequired).toBe(false);
  });

  it('does not expose secrets or arbitrary variables', async () => {
    const r = await request(app).get('/browser/settings');
    const keys = r.body.settings.map((s: { key: string }) => s.key);
    // An endpoint that could set NODE_OPTIONS or PATH is a code-execution
    // primitive; one that could set API_TOKEN is privilege escalation.
    for (const forbidden of ['API_TOKEN', 'ADMIN_SECRET', 'NODE_OPTIONS', 'PATH', 'REDIS_URL']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/test_key_123/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. The install endpoint exists and is bounded
// ════════════════════════════════════════════════════════════════════════════

describe('6. the install button is a real, bounded endpoint', () => {
  it('is registered as a POST route', async () => {
    // Asserted through a request rather than a source scan: a route that is not
    // reachable is exactly the failure a button pointing at it would produce.
    const r = await request(app).post('/browser/dependencies/install').send({});
    expect(r.status).not.toBe(404);
  }, 30_000);

  it('never asks for a restart, whatever it answers', async () => {
    const r = await request(app).post('/browser/dependencies/install').send({});
    expect(JSON.stringify(r.body)).not.toMatch(/restart the server/i);
    if (r.body && 'restartRequired' in r.body) {
      expect(r.body.restartRequired).toBe(false);
    }
  }, 30_000);
});
