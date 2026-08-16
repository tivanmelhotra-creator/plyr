/**
 * ProcessGuard — decide which faults are allowed to kill this process.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE INCIDENT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Reported verbatim:
 *
 *   «بعد از این خطا، پروسه/سرور/پورت مربوط به Remote Browser یا بخشی از
 *    اپلیکیشن terminate می‌شود و بعد از refresh کل پروژه بالا نمی‌آید.»
 *
 * The mechanism was NOT in the browser code. There is no `process.exit()`
 * anywhere in Desktop.ts / RealChrome.ts / DesktopProxy.ts, and the desktop's
 * children are spawned `detached: true` + `unref()` with both 'exit' and
 * 'error' handled, so no child signal reaches the parent.
 *
 * The mechanism was in index.ts, and it was global:
 *
 *     process.on('unhandledRejection', () => shutdown(...));   // -> process.exit(0)
 *     process.on('uncaughtException',  () => shutdown(...));   // -> process.exit(0)
 *
 * Every asynchronous fault in the process — including one raised by a
 * fire-and-forget `void this.forward(...)` in the desktop proxy, or an 'error'
 * event on an upstream response stream that had no listener attached — was
 * therefore promoted to "tear the whole server down, release the port".
 *
 * That is the correct policy for a corrupted process. It is the WRONG policy
 * for "the remote browser could not start", which is an ordinary, recoverable,
 * user-facing outcome that the operator is expected to retry.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE RULE
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   OPERATIONAL fault  -> log loudly, keep serving, let the user retry.
 *   FATAL fault        -> shut down gracefully, let the supervisor restart.
 *
 * "Operational" is deliberately a CLOSED LIST of things we know are recoverable
 * and locally scoped — socket teardowns, a refused connection to websockify, a
 * browser that would not launch. Anything unrecognised stays fatal, because a
 * guard that swallows the unknown is how a half-dead process serves wrong
 * answers for hours. We widen this list only with evidence.
 *
 * This module is pure: it takes a value, it returns a classification. Nothing
 * here touches the process, so it is trivially testable and cannot itself
 * become the reason the server dies.
 */

/** How the process should react to a fault that reached the global handlers. */
export type FaultDisposition = 'survive' | 'fatal';

export interface FaultVerdict {
  /** What to do about it. */
  disposition: FaultDisposition;
  /** Short machine-readable reason, for logs and tests. */
  reason: string;
  /** The subsystem we attributed it to, when we could name one. */
  subsystem?: 'desktop' | 'browser' | 'proxy' | 'network' | 'unknown';
}

/**
 * Node error codes that mean "a socket went away", nothing more.
 *
 * Every one of these is reachable from ordinary desktop-proxy traffic: the
 * operator closes the noVNC tab mid-stream (EPIPE / ECONNRESET), websockify is
 * not up yet because the desktop is still provisioning (ECONNREFUSED), the
 * upstream host entry is momentarily unavailable (EAI_AGAIN). None of them says
 * anything about the health of THIS process.
 */
const RECOVERABLE_SOCKET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_HTTP_HEADERS_SENT',
  'ERR_HTTP_REQUEST_TIMEOUT',
  'ERR_SOCKET_CLOSED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * Error class names owned by the recoverable subsystems.
 *
 * Matched by NAME rather than by `instanceof` on purpose. Importing
 * RealChrome/Desktop here would drag the entire browser stack into a module
 * that index.ts loads before anything else, and — worse — an error that has
 * crossed a serialization boundary (a worker, a structured clone) loses its
 * prototype but keeps its name. Name matching survives both.
 */
const RECOVERABLE_ERROR_NAMES = new Set([
  'RealChromeError',
  'DesktopError',
  'DesktopProvisionError',
  'BrowserStartError',
  'TimeoutError', // Playwright's launch/navigation timeout
]);

/**
 * Message fragments that identify a browser- or desktop-layer fault even when
 * the error arrived as a bare `Error` with no useful code or name.
 *
 * Playwright throws plain `Error`s for the two most common remote-browser
 * failures on a fresh box — a missing shared library and a dead X display — and
 * both used to take the whole server with them.
 */
const RECOVERABLE_MESSAGE_HINTS = [
  'browsertype.launch',
  'launchpersistentcontext',
  "executable doesn't exist",
  'error while loading shared libraries',
  'missing x server or $display',
  'cannot open display',
  'target page, context or browser has been closed',
  'browser has been closed',
  'websockify',
  'x11vnc',
  'xvfb',
  'processsingleton',
  'singletonlock',
  'the remote desktop',
  'desktop_not_running',
];

function lower(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function subsystemFor(name: string, message: string): FaultVerdict['subsystem'] {
  if (name === 'DesktopError' || name === 'DesktopProvisionError') return 'desktop';
  if (name === 'RealChromeError' || name === 'BrowserStartError') return 'browser';
  const m = lower(message);
  if (m.includes('xvfb') || m.includes('x11vnc') || m.includes('websockify') || m.includes('display')) {
    return 'desktop';
  }
  if (m.includes('launch') || m.includes('chrome') || m.includes('chromium') || m.includes('browser')) {
    return 'browser';
  }
  return 'unknown';
}

/**
 * Classify a value that reached `uncaughtException` / `unhandledRejection`.
 *
 * Never throws — a classifier that can itself fail would reintroduce exactly
 * the failure mode it is here to prevent, from inside the last-resort handler.
 */
export function classifyFault(err: unknown): FaultVerdict {
  try {
    if (err === null || err === undefined) {
      // A rejection with no reason carries no evidence of corruption, and we
      // have measurably produced these ourselves from `void`-ed promises.
      return { disposition: 'survive', reason: 'empty_rejection', subsystem: 'unknown' };
    }

    // Programmer errors that genuinely indicate a broken program. These stay
    // fatal even if their message happens to mention a browser.
    if (
      err instanceof RangeError ||
      err instanceof ReferenceError ||
      err instanceof SyntaxError ||
      err instanceof EvalError
    ) {
      return { disposition: 'fatal', reason: `programmer_error:${err.name}` };
    }

    const e = err as { code?: unknown; name?: unknown; message?: unknown; errno?: unknown };
    const code = typeof e.code === 'string' ? e.code : '';
    const name = typeof e.name === 'string' ? e.name : '';
    const message = typeof e.message === 'string' ? e.message : String(err);

    if (code === 'ERR_OUT_OF_MEMORY' || /heap out of memory/i.test(message)) {
      return { disposition: 'fatal', reason: 'out_of_memory' };
    }

    // EADDRINUSE at listen time is fatal — we never bound the port, so there is
    // nothing left to serve. It is handled at the listen site; if it ever
    // arrives here it still means the same thing.
    if (code === 'EADDRINUSE') {
      return { disposition: 'fatal', reason: 'address_in_use', subsystem: 'network' };
    }

    if (code && RECOVERABLE_SOCKET_CODES.has(code)) {
      return { disposition: 'survive', reason: `socket:${code}`, subsystem: 'network' };
    }

    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return {
        disposition: 'survive',
        reason: `subsystem_error:${name}`,
        subsystem: subsystemFor(name, message),
      };
    }

    // TypeError is checked AFTER the codes/names above, because Node attaches
    // TypeError to some stream misuse, but BEFORE the message hints, so that a
    // real bug in browser code is never rescued by the word "launch".
    if (err instanceof TypeError) {
      return { disposition: 'fatal', reason: 'programmer_error:TypeError' };
    }

    const m = lower(message);
    for (const hint of RECOVERABLE_MESSAGE_HINTS) {
      if (m.includes(hint)) {
        return {
          disposition: 'survive',
          reason: `browser_stack:${hint.replace(/[^a-z0-9]+/g, '_')}`,
          subsystem: subsystemFor(name, message),
        };
      }
    }

    return { disposition: 'fatal', reason: name ? `unclassified:${name}` : 'unclassified' };
  } catch {
    // If classification itself misbehaves, prefer the historical behaviour
    // (fatal) over silently surviving something we failed to inspect.
    return { disposition: 'fatal', reason: 'classifier_failed' };
  }
}

/** Convenience predicate for call sites that only need the boolean. */
export function isOperationalFault(err: unknown): boolean {
  return classifyFault(err).disposition === 'survive';
}

/**
 * Rate-limited reporter for surviving faults.
 *
 * A wedged desktop can emit the same ECONNREFUSED on every poll. Logging each
 * one turns a recoverable condition into a disk-filling one, so identical
 * reasons are collapsed and counted.
 */
export class FaultReporter {
  private readonly counts = new Map<string, number>();
  private readonly lastLoggedAt = new Map<string, number>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly log: (msg: string, err?: unknown) => void = (m, e) =>
      console.error(m, e ?? ''),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record a surviving fault; returns true when it was actually logged. */
  report(verdict: FaultVerdict, err: unknown): boolean {
    const key = verdict.reason;
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);

    const last = this.lastLoggedAt.get(key) || 0;
    const t = this.now();
    if (n > 1 && t - last < this.windowMs) return false;

    this.lastLoggedAt.set(key, t);
    const suffix = n > 1 ? ` (x${n} since start)` : '';
    this.log(
      `[CONTAINED] ${verdict.subsystem || 'unknown'} fault — server stays up: ${verdict.reason}${suffix}`,
      err,
    );
    return true;
  }

  /** Total times a given reason has been seen. Used by tests and /health. */
  countOf(reason: string): number {
    return this.counts.get(reason) || 0;
  }

  /** Snapshot for diagnostics endpoints. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
