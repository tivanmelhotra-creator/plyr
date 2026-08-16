import { describe, it, expect, vi } from 'vitest';
import { classifyFault, isOperationalFault, FaultReporter } from '../../src/core/ProcessGuard';

// ════════════════════════════════════════════════════════════════════════════
// WHICH FAULTS ARE ALLOWED TO KILL THE PROCESS
//
// index.ts used to answer "all of them": both `uncaughtException` and
// `unhandledRejection` called shutdown() -> process.exit(0). That is why a
// remote browser that would not start could release the listening port and
// leave the reporter with a project that "no longer comes up after refresh".
//
// classifyFault() is the whole of the new policy, so these tests are the
// specification of it. Two properties matter equally and pull in opposite
// directions:
//
//   SURVIVE  everything we KNOW is operational and locally scoped, so an
//            optional subsystem can never take the server down.
//   FATAL    everything else, because a guard that swallows the unknown is how
//            a half-dead process serves wrong answers for hours.
// ════════════════════════════════════════════════════════════════════════════

describe('classifyFault — operational faults keep the server up', () => {
  it('survives socket teardowns from a closed noVNC tab or a desktop that is not up', () => {
    // Each of these is reachable from ordinary desktop-proxy traffic and says
    // nothing whatsoever about the health of this process.
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED']) {
      const err = Object.assign(new Error(`socket ${code}`), { code });
      const v = classifyFault(err);
      expect(v.disposition, code).toBe('survive');
      expect(v.reason).toBe(`socket:${code}`);
    }
  });

  it('survives our own typed subsystem errors', () => {
    for (const name of ['RealChromeError', 'DesktopError', 'DesktopProvisionError']) {
      const err = Object.assign(new Error('nope'), { name });
      expect(classifyFault(err).disposition, name).toBe('survive');
    }
  });

  it('survives the bare Errors Playwright throws on a fresh box', () => {
    // These arrive as plain `Error` with no code and no useful name, which is
    // exactly why they used to fall all the way through to shutdown().
    const cases = [
      "browserType.launchPersistentContext: Executable doesn't exist at /ms-playwright/chrome",
      'Missing X server or $DISPLAY',
      'error while loading shared libraries: libatk-1.0.so.0',
      'Failed to create SingletonLock: ProcessSingleton',
      'Target page, context or browser has been closed',
    ];
    for (const message of cases) {
      const v = classifyFault(new Error(message));
      expect(v.disposition, message).toBe('survive');
      expect(['browser', 'desktop', 'unknown']).toContain(v.subsystem);
    }
  });

  it('survives a rejection with no reason at all', () => {
    // `void somePromise` with no .catch() produces these, and we have measurably
    // produced them ourselves from the desktop proxy.
    expect(classifyFault(undefined).disposition).toBe('survive');
    expect(classifyFault(null).disposition).toBe('survive');
  });
});

describe('classifyFault — genuinely broken states still exit', () => {
  it('keeps programmer errors fatal', () => {
    expect(classifyFault(new TypeError('x is not a function')).disposition).toBe('fatal');
    expect(classifyFault(new ReferenceError('y is not defined')).disposition).toBe('fatal');
    expect(classifyFault(new SyntaxError('bad')).disposition).toBe('fatal');
  });

  it('keeps out-of-memory fatal', () => {
    expect(classifyFault(new Error('JavaScript heap out of memory')).disposition).toBe('fatal');
  });

  it('keeps a failed port bind fatal — there is nothing left to serve', () => {
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    expect(classifyFault(err).disposition).toBe('fatal');
  });

  it('keeps anything unrecognised fatal', () => {
    const v = classifyFault(new Error('the database schema is corrupt'));
    expect(v.disposition).toBe('fatal');
    expect(v.reason).toContain('unclassified');
  });

  it('a browser-sounding message does NOT rescue a programmer error', () => {
    // Ordering matters: TypeError is judged before the message hints, so a real
    // bug in browser code is still reported as a bug rather than swallowed.
    const err = new TypeError('cannot read property launch of undefined');
    expect(classifyFault(err).disposition).toBe('fatal');
  });
});

describe('isOperationalFault', () => {
  it('is the boolean form of the same verdict', () => {
    expect(isOperationalFault(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isOperationalFault(new TypeError('x'))).toBe(false);
  });
});

describe('FaultReporter', () => {
  it('logs the first occurrence and collapses the flood that follows', () => {
    // A wedged desktop emits the same ECONNREFUSED on every poll. Logging each
    // one turns a recoverable condition into a disk-filling one.
    const log = vi.fn();
    const now = 0;
    const r = new FaultReporter(60_000, log, () => now);
    const verdict = { disposition: 'survive' as const, reason: 'socket:ECONNREFUSED' };

    expect(r.report(verdict, new Error('a'))).toBe(true);
    for (let i = 0; i < 100; i += 1) r.report(verdict, new Error('b'));

    expect(log).toHaveBeenCalledTimes(1);
    expect(r.countOf('socket:ECONNREFUSED')).toBe(101);
  });

  it('logs again once the window has passed, and says how many were suppressed', () => {
    const log = vi.fn();
    let now = 0;
    const r = new FaultReporter(1_000, log, () => now);
    const verdict = { disposition: 'survive' as const, reason: 'socket:EPIPE' };

    r.report(verdict, null);
    r.report(verdict, null);
    now = 5_000;
    expect(r.report(verdict, null)).toBe(true);

    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toContain('x3');
  });

  it('snapshot exposes the counts for diagnostics', () => {
    const r = new FaultReporter(60_000, () => { /* silent */ }, () => 0);
    r.report({ disposition: 'survive', reason: 'socket:EPIPE' }, null);
    expect(r.snapshot()).toEqual({ 'socket:EPIPE': 1 });
  });
});
