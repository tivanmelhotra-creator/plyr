/**
 * self-heal.test.ts — "no restart may ever be required".
 *
 * WHAT IS BEING DEFENDED
 * ----------------------
 * The user's mandate was global and unambiguous: every place the code said
 * "restart the server" or "restart the browser" must instead FIX THE PROBLEM
 * ITSELF. The reported experience was installing an extension, being told a
 * restart was required, pressing the button that looked most like it, watching
 * nothing happen, and being left گیج و منگ — dazed and confused. He said
 * explicitly that this loop had exhausted him.
 *
 * A regression here would not look like a crash. It would look like a helpful
 * sentence. That is exactly why it needs a test: nothing else in a build fails
 * when a message reappears.
 *
 * HOW THESE TESTS WORK
 * --------------------
 * `SelfHeal` is deliberately a thin coordinator over `Desktop` and `RealChrome`,
 * so its behaviour is testable by substituting those two: the tests below drive
 * the real `SelfHeal` code with stubbed collaborators and assert on what it DID
 * (which calls, in which order, reported how) rather than on what its source
 * contains. The one exception is the guard-rail scan at the bottom, which is a
 * deliberate source assertion because the thing being forbidden IS a string.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('SelfHeal: the server fixes it, the user is never asked to', () => {
  let SelfHeal: typeof import('../../src/core/SelfHeal').SelfHeal;
  let Desktop: typeof import('../../src/core/Desktop').Desktop;
  let RealChrome: typeof import('../../src/core/RealChrome').RealChrome;
  let cfg: typeof import('../../src/config');
  let steps: Array<{ key: string; state: string }>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    steps = [];
    cfg = await import('../../src/config');
    ({ SelfHeal } = await import('../../src/core/SelfHeal'));
    ({ Desktop } = await import('../../src/core/Desktop'));
    ({ RealChrome } = await import('../../src/core/RealChrome'));
    (cfg.config as { REAL_CHROME_ENABLED: boolean }).REAL_CHROME_ENABLED = true;
    (cfg.config as { REAL_CHROME_HEADLESS: boolean }).REAL_CHROME_HEADLESS = false;
  });

  /** A Chrome that is up, and a display that is up. The boring, common case. */
  const allUp = () => {
    vi.spyOn(Desktop, 'status').mockResolvedValue({
      displayRunning: true, running: true, display: ':99', missing: [], installHint: '',
    } as unknown as Awaited<ReturnType<typeof Desktop.status>>);
    vi.spyOn(Desktop, 'start').mockResolvedValue({} as never);
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(true);
    vi.spyOn(RealChrome, 'getContext').mockResolvedValue({} as never);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: true, running: true, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);
  };

  const record = (s: { key: string; state: string }) => { steps.push({ key: s.key, state: s.state }); };

  // ──────────────────────────────────────────────────────────────────────────
  // The display: an action, not a message
  // ──────────────────────────────────────────────────────────────────────────

  it('brings the virtual display UP instead of telling the user to run a script', async () => {
    // This used to answer "Start it with: bash scripts/desktop.sh start" — to
    // someone who has no shell on that machine.
    let displayStarted = false;
    vi.spyOn(Desktop, 'status').mockImplementation(async () => ({
      displayRunning: displayStarted, running: displayStarted,
      display: ':99', missing: [], installHint: '',
    } as unknown as Awaited<ReturnType<typeof Desktop.status>>));
    vi.spyOn(Desktop, 'start').mockImplementation(async () => {
      displayStarted = true;
      return {} as never;
    });
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(false);
    vi.spyOn(RealChrome, 'getContext').mockResolvedValue({} as never);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: true, running: true, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);

    const res = await SelfHeal.ensureBrowser(record);

    expect(Desktop.start, 'the display must be STARTED, not described').toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.problem).toBeUndefined();
  });

  it('falls back to the display alone when only the VIEWER packages are missing', async () => {
    // x11vnc/websockify are how a human WATCHES the screen; Xvfb *is* the screen.
    // A missing viewer must never block the browser: the difference is
    // "extensions work, you just cannot watch them" versus a dead end.
    vi.spyOn(Desktop, 'status').mockResolvedValue({
      displayRunning: false, running: false, display: ':99',
      missing: ['x11vnc'], installHint: 'apt-get install x11vnc',
    } as unknown as Awaited<ReturnType<typeof Desktop.status>>);
    vi.spyOn(Desktop, 'start').mockRejectedValue(new Error('Missing: x11vnc'));
    const ensure = vi.spyOn(Desktop, 'ensureDisplay').mockResolvedValue(undefined);
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(false);
    vi.spyOn(RealChrome, 'getContext').mockResolvedValue({} as never);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: true, running: true, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);

    await SelfHeal.ensureBrowser(record);
    expect(ensure, 'must fall back to Xvfb alone').toHaveBeenCalled();
  });

  it('does no work at all when everything is already up', async () => {
    // Called on every action that needs a browser, so the common path must be
    // one status check and nothing else.
    allUp();
    const res = await SelfHeal.ensureBrowser(record);
    expect(res.ok).toBe(true);
    expect(Desktop.start).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Extensions: the reported case
  // ──────────────────────────────────────────────────────────────────────────

  it('relaunches Chrome ITSELF so a new extension loads with no button press', async () => {
    // Chrome genuinely only reads extensions at launch. That fact is a fact about
    // Chrome; making the USER act on it was the choice, and this is the other
    // choice.
    allUp();
    const stop = vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);

    const res = await SelfHeal.reloadExtensions(record);

    expect(stop, 'Chrome must be stopped by US').toHaveBeenCalled();
    expect(RealChrome.getContext, 'and started again by US').toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('restores the user\'s tabs after the relaunch — "we never lose a tab"', async () => {
    allUp();
    vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);
    let restored = false;
    await SelfHeal.reloadExtensions(record, async () => { restored = true; });
    expect(restored, 'live sessions must be given the chance to rebuild').toBe(true);
  });

  it('runs the tab restore AFTER Chrome is back, never before', async () => {
    // Restoring into a Chrome that is still down would lose exactly the tabs the
    // restore exists to save.
    const order: string[] = [];
    allUp();
    vi.spyOn(RealChrome, 'stop').mockImplementation(async () => { order.push('stop'); });
    vi.spyOn(RealChrome, 'getContext').mockImplementation(async () => {
      order.push('start');
      return {} as never;
    });
    await SelfHeal.reloadExtensions(record, async () => { order.push('restore'); });
    expect(order.indexOf('restore')).toBeGreaterThan(order.indexOf('start'));
    expect(order.indexOf('start')).toBeGreaterThan(order.indexOf('stop'));
  });

  it('survives a failing stop and still brings Chrome back', async () => {
    // A stop that throws still leaves us wanting a fresh Chrome. Aborting here
    // would turn a recoverable hiccup into the dead state this module deletes.
    allUp();
    vi.spyOn(RealChrome, 'stop').mockRejectedValue(new Error('close timed out'));
    const res = await SelfHeal.reloadExtensions(record);
    expect(RealChrome.getContext).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // The waiting/UX mandate: the user must know who is doing what, and for how long
  // ──────────────────────────────────────────────────────────────────────────

  it('reports every step it takes, with a start and an end', async () => {
    allUp();
    vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);
    await SelfHeal.reloadExtensions(record);

    expect(steps.length, 'a silent wait is the bug being fixed').toBeGreaterThan(2);
    // Every step that starts must also finish (or fail): a step left "running"
    // is a spinner that never stops, which is what left the user confused.
    const running = steps.filter((s) => s.state === 'running').map((s) => s.key);
    const settled = steps.filter((s) => s.state !== 'running').map((s) => s.key);
    for (const key of new Set(running)) {
      expect(settled, `step ${key} started but never settled`).toContain(key);
    }
  });

  it('gives an ETA for the steps that actually take time', async () => {
    // "How long?" is part of the mandate. A spinner with no number is a promise
    // of nothing.
    const seen: Array<{ key: string; etaMs?: number }> = [];
    allUp();
    vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);
    await SelfHeal.reloadExtensions((s) => seen.push({ key: s.key, etaMs: s.etaMs }));
    const withEta = seen.filter((s) => typeof s.etaMs === 'number' && (s.etaMs as number) > 0);
    expect(withEta.length).toBeGreaterThan(0);
  });

  it('uses stable keys, never English sentences, so the UI can be Persian', async () => {
    // A sentence invented on the server arrives in a Persian UI as English.
    allUp();
    vi.spyOn(RealChrome, 'stop').mockResolvedValue(undefined);
    await SelfHeal.reloadExtensions(record);
    for (const s of steps) {
      expect(s.key, `${s.key} looks like prose`).toMatch(/^[a-zA-Z]+$/);
      expect(s.key.length).toBeLessThan(40);
    }
  });

  it('serialises heals so two never fight over one user-data-dir', async () => {
    // Chrome resolves two instances on one profile by refusing to start the
    // second — a self-inflicted failure in the code whose whole job is to not
    // have any.
    allUp();
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.spyOn(RealChrome, 'stop').mockImplementation(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
    });
    await Promise.all([
      SelfHeal.reloadExtensions(() => {}),
      SelfHeal.reloadExtensions(() => {}),
      SelfHeal.reloadExtensions(() => {}),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it('keeps working after a heal fails', async () => {
    // One failed heal must not poison every later attempt: the queue has to
    // survive a rejection.
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(false);
    vi.spyOn(Desktop, 'status').mockResolvedValue({
      displayRunning: true, running: true, display: ':99', missing: [], installHint: '',
    } as unknown as Awaited<ReturnType<typeof Desktop.status>>);
    const getContext = vi.spyOn(RealChrome, 'getContext')
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockResolvedValue({} as never);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: true, running: true, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);

    const first = await SelfHeal.ensureBrowser(record);
    expect(first.ok).toBe(false);
    expect(first.problem, 'a real failure must still be reported').toBeTruthy();

    const second = await SelfHeal.ensureBrowser(record);
    expect(second.ok, 'the next attempt must not be poisoned').toBe(true);
    expect(getContext).toHaveBeenCalledTimes(2);
  });

  it('will not claim success on "we hold a context" alone', async () => {
    // `isRunning()` means we hold an object, which is not the same as Chrome
    // answering. Reporting green on the weaker claim is how a UI ends up
    // "dead but connected" — the state the stability requirement forbids.
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(true);
    vi.spyOn(Desktop, 'status').mockResolvedValue({
      displayRunning: true, running: true, display: ':99', missing: [], installHint: '',
    } as unknown as Awaited<ReturnType<typeof Desktop.status>>);
    vi.spyOn(RealChrome, 'getContext').mockResolvedValue({} as never);
    // The verify step disagrees with isRunning():
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: true, running: false, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);

    const res = await SelfHeal.ensureBrowser(record);
    expect(res.ok, 'verification must beat optimism').toBe(false);
  });

  it('says so honestly when the machine genuinely lacks Xvfb', async () => {
    // Self-healing is not the same as pretending. No amount of retrying installs
    // a package — and at that point the honest answer NAMES it. The rule is
    // "never ask the user to do something we could have done", not "never tell
    // the user anything".
    vi.spyOn(Desktop, 'status').mockResolvedValue({
      displayRunning: false, running: false, display: ':99',
      missing: ['Xvfb'], installHint: 'sudo apt-get install -y xvfb',
    } as unknown as Awaited<ReturnType<typeof Desktop.status>>);
    vi.spyOn(Desktop, 'start').mockRejectedValue(new Error('Missing: Xvfb'));
    vi.spyOn(Desktop, 'ensureDisplay').mockRejectedValue(new Error('Missing: Xvfb'));
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(true);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: true, running: false, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);

    const res = await SelfHeal.ensureBrowser(record);
    expect(res.ok).toBe(false);
    expect(res.problem).toBeTruthy();
    expect(res.hint, 'name the package').toMatch(/xvfb/i);
    // Crucially: it must NOT be a restart instruction.
    expect(String(res.problem) + String(res.hint)).not.toMatch(/restart the server/i);
  });

  it('does not silently enable a disabled Real Chrome', async () => {
    // REAL_CHROME_ENABLED=false is a deliberate operator choice. Overriding it
    // would be helping the user by disobeying the operator.
    vi.spyOn(RealChrome, 'isEnabled').mockReturnValue(false);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      enabled: false, running: false, restartRequired: false,
    } as unknown as Awaited<ReturnType<typeof RealChrome.status>>);
    const res = await SelfHeal.ensureBrowser(record);
    expect(res.ok).toBe(false);
    expect(res.problem).toBe('realChromeDisabled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The guard rail.
//
// A deliberate source assertion, because the thing being forbidden IS a string.
// Nothing else in a build fails when a helpful-sounding sentence reappears.
// ════════════════════════════════════════════════════════════════════════════

describe('no route may ask the user to restart anything', () => {
  const routes = read('src/Routes/browser.routes.ts');

  /**
   * Comments are stripped before the scan.
   *
   * The history of WHY this rule exists is worth keeping in the source — the
   * old message is quoted in a comment right where it used to be returned, so
   * that anyone tempted to reintroduce it reads the reason first. A comment is
   * not something a user ever sees, so it cannot be the defect.
   */
  const code = routes
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('never tells the user to restart the server', () => {
    expect(code).not.toMatch(/restart the server/i);
    expect(code).not.toMatch(/Restart the browser to load it/i);
    expect(code, 'an HTTP verb is not an instruction for someone holding a mouse')
      .not.toMatch(/POST \/browser\/restart/);
  });

  it('never claims a restart is required', () => {
    // `restartRequired` survives as an API field for compatibility, but it must
    // always be false now: there is nothing left for the caller to restart.
    const claims = code.match(/restartRequired:\s*[^,\n]+/g) || [];
    expect(claims.length, 'the field should still exist for compatibility')
      .toBeGreaterThan(0);
    for (const c of claims) {
      expect(c, `still claims a restart: ${c}`).toMatch(/restartRequired:\s*false/);
    }
  });

  it('heals on install rather than reporting a pending restart', () => {
    // The reported case: installing a cookie extension must load it, here, now.
    expect(code).toContain('SelfHeal.reloadExtensions');
    // Both install paths — an uploaded archive and a Web Store link.
    const installs = code.match(/SelfHeal\.reloadExtensions/g) || [];
    expect(installs.length).toBeGreaterThanOrEqual(2);
  });

  it('starts the browser through the healer, so the display comes up too', () => {
    expect(code).toContain('SelfHeal.ensureBrowser');
  });

  /**
   * The hook that existed and did nothing.
   *
   * `reloadExtensions(report, onSwap)` calls `onSwap` in the window between
   * stopping and starting Chrome, precisely so live sessions can be rebuilt onto
   * the new browser. Every call site passed no `onSwap`, so relaunching Chrome to
   * load a newly installed extension silently killed every streaming page and
   * left the user's canvas showing a stale frame of a browser that was gone.
   *
   * An optional parameter that nobody passes is indistinguishable from a missing
   * feature, and nothing fails when it is forgotten — so it gets a test.
   */
  it('hands every heal a way to rebuild the live sessions', () => {
    const calls = code.match(/SelfHeal\.reloadExtensions\([^)]*\)/g) || [];
    expect(calls.length, 'the heal call sites should still be here')
      .toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c, `this heal would silently kill every live tab: ${c}`)
        .toMatch(/,\s*swapLiveSessions\s*\)/);
    }
  });

  it('lets a bootstrap that forgot to register the rebuilder still install', () => {
    // Default must be a no-op, not a throw: the routes have to work in isolation
    // (and in tests), and a mis-wired boot must not break extension installs.
    const decl = code.slice(code.indexOf('let rebuildLiveSessions'));
    expect(decl.slice(0, 120)).toMatch(/=\s*async\s*\(\)\s*=>\s*\{\s*\};/);
    expect(code).toContain('export function setLiveSessionRebuilder');
  });

  it('never lets a stubborn tab be reported as a failed install', () => {
    // swapLiveSessions must swallow: "one tab did not recover" and "the
    // extension failed to install" are different facts, and reporting the
    // second when the first happened is the confusing-message defect again.
    const fn = code.slice(code.indexOf('async function swapLiveSessions'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(body).toContain('try');
    expect(body).toContain('catch');
  });
});

describe('the bootstrap actually registers the rebuilder', () => {
  /**
   * `setLiveSessionRebuilder` defaulting to a no-op is what keeps the routes
   * testable — and also what would let a missing registration go unnoticed
   * forever, because everything would still "work" while quietly losing tabs.
   * index.ts owns the LiveBrowserManager, so index.ts is the only place that can
   * do this, and this is the only test that can catch it not happening.
   */
  const boot = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('calls setLiveSessionRebuilder at boot', () => {
    expect(boot).toContain('setLiveSessionRebuilder');
  });

  it('rebuilds through the manager it owns', () => {
    const call = boot.slice(boot.indexOf('setLiveSessionRebuilder('));
    expect(call.slice(0, 240)).toMatch(/liveBrowserManager\.rebuildAll\(\)/);
  });
});
