import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════
// BROWSER RUNTIME RECOVERY
//
// WHAT WENT WRONG, AND WHY A MODULE EXISTS TO FIX IT
// ---------------------------------------------------------------------------
// Choosing REMOTE BROWSER from the targeting crosshair surfaced
//
//     remote_browser_disabled
//     The Remote Browser is switched off for this instance
//
// and stopped the work, with no way forward that did not involve the user
// hand-editing `REAL_CHROME_ENABLED=true` on the server. The requirement is
// blunt about that being unacceptable:
//
//     «کاربر نباید بداند REAL_CHROME_ENABLED چیست»
//
// `POST /browser/start` and `POST /browser/enable` already self-enabled the
// setting; `POST /browser/real/open` — the ONLY endpoint the crosshair reaches —
// did not. `ensureRuntimeReady()` closes that gap.
//
// WHY THE FIRST DESCRIBE BLOCK READS SOURCE TEXT
// ---------------------------------------------------------------------------
// The module's own header promises this file enforces an invariant:
//
//     «اگر فقط Browser نیاز به restart دارد، فقط Browser را restart کن —
//      اپلیکیشن اصلی هرگز نباید kill/restart شود»
//
// That is a promise about code that must NEVER run, so no behavioural test can
// establish it: a `process.exit` reachable only on some rare branch would leave
// every behavioural test green and take the whole application down in
// production — dropping /health, every in-flight run and every open dashboard
// socket, to fix a browser. Reading the source is the only check that covers
// branches the tests never enter, so it is deliberate here rather than lazy.
// ════════════════════════════════════════════════════════════════

const SOURCE_PATH = join(process.cwd(), 'src/core/BrowserRuntimeRecovery.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

/**
 * Strip comments before searching for forbidden tokens.
 *
 * Without this the test would fail on its own subject module: the header
 * explains the invariant by NAMING the calls it forbids, so a naive grep finds
 * `process.exit` in the very prose that promises never to call it.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = code(SOURCE);

describe('the never-restart-the-application invariant', () => {
  // Each entry is a way of taking down the parent process rather than the
  // browser. `process.kill` is included even though killing a CHILD is
  // legitimate, because this module has no business holding child pids at all —
  // RealChrome owns process lifetime, and recovery should go through it.
  const FORBIDDEN: Array<[string, string]> = [
    ['process.exit', 'terminates the application'],
    ['process.abort', 'terminates the application'],
    ['process.kill', 'may signal the application itself'],
    ['execSync', 'can shell out to a restart command'],
    ['spawnSync', 'can shell out to a restart command'],
    ['child_process', 'the only way to invoke a process manager'],
    ['pm2', 'restarting via the process manager restarts the app'],
    ['supervisorctl', 'restarting via the process manager restarts the app'],
  ];

  it.each(FORBIDDEN)('never calls %s (%s)', (token) => {
    expect(CODE).not.toContain(token);
  });

  it('restarts the browser ONLY through RealChrome, and only when wedged', () => {
    // The one restart this module may perform. Asserted positively so that
    // deleting the recovery entirely — which would also satisfy every
    // prohibition above — cannot pass as compliance.
    expect(CODE).toContain('RealChrome.recycleIfWedged');
    expect(CODE).toContain('RealChrome.isRunning');
  });

  it('leaves a browser that is not running alone, rather than racing the caller', () => {
    // `/browser/real/open` starts the browser immediately after calling this.
    // Starting one here too would produce two launches for one click.
    const step = SOURCE.slice(SOURCE.indexOf('RealChrome.isRunning'));
    expect(step).toContain("state: 'skipped'");
    expect(step).toMatch(/the caller will start one/);
  });
});

describe('ensureRuntimeEnabled', () => {
  let mod: typeof import('../../src/core/BrowserRuntimeRecovery');
  let settings: typeof import('../../src/core/RuntimeSettings');
  let config: typeof import('../../src/config')['config'];
  let originalEnv: string | undefined;

  beforeEach(async () => {
    mod = await import('../../src/core/BrowserRuntimeRecovery');
    settings = await import('../../src/core/RuntimeSettings');
    ({ config } = await import('../../src/config'));
    originalEnv = process.env.REAL_CHROME_ENABLED;
    settings.clearOverridesForTests();
  });

  afterEach(() => {
    settings.clearOverridesForTests();
    if (originalEnv === undefined) delete process.env.REAL_CHROME_ENABLED;
    else process.env.REAL_CHROME_ENABLED = originalEnv;
  });

  it('does nothing when the runtime is already on', async () => {
    settings.setOverride('REAL_CHROME_ENABLED', true);
    const res = await mod.ensureRuntimeEnabled();

    expect(res.ok).toBe(true);
    // `changed:false` is the interesting half: a recovery that reported a repair
    // on every request would make the dashboard claim it fixed something each
    // time the user targeted a field.
    expect(res.changed).toBe(false);
    expect(res.step.state).toBe('ok');
  });

  it('turns the runtime on when it is explicitly off — the reported defect', async () => {
    // Reproduces the precondition exactly: an instance where the setting was
    // explicitly false is the ONLY way `remote_browser_disabled` can occur,
    // because the default is true.
    settings.setOverride('REAL_CHROME_ENABLED', false);
    expect(config.REAL_CHROME_ENABLED).toBe(false);

    const res = await mod.ensureRuntimeEnabled();

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.step.state).toBe('changed');
    // Read back through config, not through the return value: the point is that
    // the thing RealChrome.getContext() consults has actually changed, not that
    // this function is willing to say so.
    expect(config.REAL_CHROME_ENABLED).toBe(true);
  });

  it('is idempotent — a second targeting request repairs nothing', async () => {
    settings.setOverride('REAL_CHROME_ENABLED', false);
    expect((await mod.ensureRuntimeEnabled()).changed).toBe(true);
    expect((await mod.ensureRuntimeEnabled()).changed).toBe(false);
  });

  it('explains itself in words an operator can act on', async () => {
    // This detail string reaches a log line and, on failure, the HTTP response.
    // It must not leak the setting name as an instruction, since the whole point
    // is that the user never learns REAL_CHROME_ENABLED exists.
    settings.setOverride('REAL_CHROME_ENABLED', false);
    const res = await mod.ensureRuntimeEnabled();
    expect(res.step.detail).toMatch(/browser runtime/i);
    expect(res.step.detail).not.toContain('REAL_CHROME_ENABLED');
  });
});

describe('ensureRuntimeReady', () => {
  let mod: typeof import('../../src/core/BrowserRuntimeRecovery');
  let settings: typeof import('../../src/core/RuntimeSettings');
  let selfHeal: typeof import('../../src/core/SelfHeal');
  let originalEnv: string | undefined;

  beforeEach(async () => {
    mod = await import('../../src/core/BrowserRuntimeRecovery');
    settings = await import('../../src/core/RuntimeSettings');
    selfHeal = await import('../../src/core/SelfHeal');
    originalEnv = process.env.REAL_CHROME_ENABLED;
    settings.clearOverridesForTests();
  });

  afterEach(() => {
    settings.clearOverridesForTests();
    selfHeal.setSelfHealEnabled(true);
    if (originalEnv === undefined) delete process.env.REAL_CHROME_ENABLED;
    else process.env.REAL_CHROME_ENABLED = originalEnv;
  });

  it('reports ready, with the enable step first', async () => {
    settings.setOverride('REAL_CHROME_ENABLED', true);
    const res = await mod.ensureRuntimeReady();

    expect(res.ok).toBe(true);
    // Order is a correctness property, not presentation: both later steps are
    // no-ops while the runtime is switched off, so enabling has to come first.
    expect(res.steps[0].id).toBe('enable');
    expect(res.steps.map((s) => s.id)).toEqual(['enable', 'selfheal', 'browser']);
  });

  it('recovers a fully switched-off instance in one call', async () => {
    settings.setOverride('REAL_CHROME_ENABLED', false);
    selfHeal.setSelfHealEnabled(false);

    const res = await mod.ensureRuntimeReady();

    expect(res.ok).toBe(true);
    expect(res.repaired).toBe(true);
    const byId = Object.fromEntries(res.steps.map((s) => [s.id, s]));
    expect(byId.enable.state).toBe('changed');
    expect(byId.selfheal.state).toBe('changed');
    expect(selfHeal.isSelfHealEnabled()).toBe(true);
  });

  it('never reports a problem the caller must show the user when it succeeded', async () => {
    // `problem` and `hint` are what `/browser/real/open` turns into a 503 —
    // exactly the surface `remote_browser_disabled` used to appear on. They must
    // be absent on the success path, or the fix would replace one unexplained
    // error with another.
    settings.setOverride('REAL_CHROME_ENABLED', false);
    const res = await mod.ensureRuntimeReady();

    expect(res.ok).toBe(true);
    expect(res.problem).toBeUndefined();
    expect(res.hint).toBeUndefined();
  });

  it('leaves a wedged-browser check to RealChrome and survives its refusal', async () => {
    // No real browser runs in the unit environment, so this asserts the shape of
    // the answer rather than a restart: recovery must complete even when the
    // browser layer cannot be consulted, because the caller's own start attempt
    // is still ahead and has its own error reporting.
    settings.setOverride('REAL_CHROME_ENABLED', true);
    const res = await mod.ensureRuntimeReady();
    const browser = res.steps.find((s) => s.id === 'browser');

    expect(browser).toBeDefined();
    expect(['ok', 'skipped', 'failed']).toContain(browser?.state);
    expect(res.ok).toBe(true);
  });
});

describe('the route that used to surface the error', () => {
  const ROUTES = readFileSync(join(process.cwd(), 'src/Routes/browser.routes.ts'), 'utf8');

  it('repairs the runtime before /browser/real/open starts anything', () => {
    expect(ROUTES).toContain("from '../core/BrowserRuntimeRecovery'");

    // Position matters, and is the entire fix: calling recovery AFTER the start
    // attempt would let the disabled error be produced first, which is precisely
    // the behaviour being removed.
    const handler = ROUTES.slice(ROUTES.indexOf("'/browser/real/open'"));
    const repairAt = handler.indexOf('ensureRuntimeReady');
    const startAt = handler.indexOf('withStartBudget');
    expect(repairAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(repairAt).toBeLessThan(startAt);
  });

  it('marks the unrecoverable case retryable rather than final', () => {
    const handler = ROUTES.slice(ROUTES.indexOf("'/browser/real/open'"));
    const guard = handler.slice(handler.indexOf('ensureRuntimeReady'));
    expect(guard).toContain('retryable');
  });
});
