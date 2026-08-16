/**
 * RemoteBrowserStart — bring the remote browser up WITHIN A TIME BUDGET.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE MEASUREMENT THIS IS BUILT ON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `POST /browser/real/open` on a clean box, instrumented:
 *
 *     OPEN   status=200   ms=50341        <- fifty seconds
 *     HEALTH after open: 200
 *     fatal seen: none
 *
 * The endpoint SUCCEEDS. It is simply slow, because a cold start does real
 * work: DesktopProvision may `apt-get download` + `dpkg-deb -x` an entire
 * desktop stack into a private prefix, then Xvfb, then x11vnc, then websockify,
 * and only then a headed Chromium whose own launch timeout is 60s.
 *
 * Nothing in that chain had ANY overall deadline. And that is the whole story
 * behind the reported error:
 *
 *     «Could not start the remote browser: HTTP 502»
 *
 * No endpoint in this codebase emits 502 for that route — sendError() only ever
 * produces 400/409/500/503 with a JSON `{success,error}` body, and the UI would
 * have printed that `error` text. The bare "HTTP 502" is the UI's fallback for
 * a response whose body is NOT our JSON (ChromeView's
 * `(j && j.error) || ('HTTP ' + r.status)`). In other words the answer came
 * from something IN FRONT of this app: a reverse proxy that hit its own read
 * timeout (nginx 60s, Traefik/Coolify 30-60s, Cloudflare 100s) and synthesised
 * an HTML 502/504 page of its own.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FIX
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Whoever answers first owns the error page. So we answer first — always,
 * within a budget chosen to undercut the shortest gateway timeout we can expect
 * — and we answer in our own JSON, with a cause and a next step.
 *
 * Crucially, a budget expiring does NOT cancel the work. The desktop and the
 * browser keep starting in the background; the operator simply gets an
 * immediate, honest "still starting, retry in a moment" instead of a hung
 * request. The next call finds the work already done and returns success. That
 * is what makes Retry meaningful rather than a way to start a second cold boot.
 *
 * And every fault is contained HERE, in request scope. Nothing in this module
 * is allowed to escape as an unhandled rejection, because index.ts treats an
 * unhandled rejection as grounds to shut the process down.
 */

import { config } from '../config';

/** Why a start attempt ended the way it did. */
export type StartOutcome = 'ready' | 'starting' | 'failed';

export interface StartResult<T> {
  outcome: StartOutcome;
  /** Present only when outcome === 'ready'. */
  value?: T;
  /** Machine-readable cause; present when not ready. */
  error?: string;
  /** Human next step; present when not ready. */
  hint?: string;
  /** Milliseconds actually spent inside the budget. */
  elapsedMs: number;
}

/**
 * The overall budget for one `/browser/real/open` call.
 *
 * DEFAULT 25s. The constraint is not "how long does Chrome need" — the measured
 * cold start needs ~50s — it is "how long before something in front of us
 * invents its own error page". Every common ingress default is >= 30s, so 25s
 * guarantees our JSON wins the race on the first attempt, and the second
 * attempt (by which time the slow work has finished) returns a real success.
 *
 * Configurable because a private deployment behind a generous proxy may prefer
 * to just wait, and a very aggressive gateway may need less.
 */
export function startBudgetMs(): number {
  const raw = Number(process.env.REMOTE_BROWSER_START_BUDGET_MS);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000) return raw;
  return 25_000;
}

/** A promise that resolves (never rejects) after `ms`. */
function sleep(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let t: NodeJS.Timeout;
  const promise = new Promise<'timeout'>((resolve) => {
    t = setTimeout(() => resolve('timeout'), ms);
    // Do not hold the event loop open on a pending budget: a test or a CLI
    // must be able to exit while one is outstanding.
    if (typeof t.unref === 'function') t.unref();
  });
  return { promise, cancel: () => clearTimeout(t) };
}

/**
 * Race a startup task against the budget, containing every failure mode.
 *
 * Returns — never throws. Three outcomes, and all three are controlled:
 *
 *   ready    the task finished inside the budget
 *   starting the budget expired; the task is STILL RUNNING in the background
 *   failed   the task rejected; classified into a caller-facing error string
 *
 * The still-running task keeps a `.catch()` attached for its whole life, which
 * is what stops a late failure (Chrome dying 40s after we already answered)
 * from surfacing as an unhandledRejection and tearing down the server.
 */
export async function withStartBudget<T>(
  task: () => Promise<T>,
  opts: {
    budgetMs?: number;
    /** Called when a task that outlived its budget eventually settles. */
    onLateSettle?: (err: unknown | null) => void;
  } = {},
): Promise<StartResult<T>> {
  const budget = opts.budgetMs ?? startBudgetMs();
  const began = Date.now();

  let work: Promise<T>;
  try {
    work = task();
  } catch (e) {
    // A task that throws SYNCHRONOUSLY never produced a promise.
    return { outcome: 'failed', elapsedMs: Date.now() - began, ...describe(e) };
  }

  // Attached immediately and permanently. Even after we return 'starting', this
  // handler is the reason a late rejection cannot become a process-level fault.
  const guarded = work.then(
    (v) => { if (opts.onLateSettle) opts.onLateSettle(null); return v; },
    (e) => { if (opts.onLateSettle) opts.onLateSettle(e); throw e; },
  );
  // Second, independent subscription purely to neutralise the rejection. Without
  // it, `guarded` rethrowing after the race has moved on is itself unhandled.
  guarded.catch(() => { /* contained: reported through onLateSettle */ });

  const timer = sleep(budget);
  try {
    const winner = await Promise.race([
      guarded.then((v) => ({ kind: 'value' as const, v })),
      timer.promise.then(() => ({ kind: 'timeout' as const })),
    ]);

    if (winner.kind === 'value') {
      return { outcome: 'ready', value: winner.v, elapsedMs: Date.now() - began };
    }

    return {
      outcome: 'starting',
      elapsedMs: Date.now() - began,
      error: 'remote_browser_starting',
      hint:
        `The remote browser is still starting (over ${Math.round(budget / 1000)}s so far). ` +
        'A first-ever start also provisions the desktop stack and can take a minute. ' +
        'Nothing failed and nothing was cancelled — it keeps starting in the background, ' +
        'so press Retry in a few seconds.',
    };
  } catch (e) {
    return { outcome: 'failed', elapsedMs: Date.now() - began, ...describe(e) };
  } finally {
    timer.cancel();
  }
}

/**
 * Turn any thrown value into a stable, caller-facing error + hint.
 *
 * The hints are the actionable half. "HTTP 502" told the operator nothing; a
 * missing shared library, a dead display and a stale singleton lock each have a
 * different and specific remedy, and this is where they get said out loud.
 */
export function describe(e: unknown): { error: string; hint: string } {
  const msg = (e as Error)?.message || String(e ?? 'unknown error');
  const m = msg.toLowerCase();

  if (m.includes('missing x server') || m.includes('cannot open display')) {
    return {
      error: 'display_unavailable',
      hint:
        'The X display is not up, so a headed browser cannot start. ' +
        'Start it with POST /api/browser/desktop/start, or check Xvfb in GET /api/browser/real/health.',
    };
  }
  if (m.includes('error while loading shared libraries') || m.includes('cannot open shared object')) {
    return {
      error: 'browser_libraries_missing',
      hint:
        'Chromium is installed but cannot link its system libraries. ' +
        'Run: npx playwright install --with-deps chromium (see GET /api/health/browser for the exact list).',
    };
  }
  if (m.includes("executable doesn't exist") || m.includes('executable path')) {
    return {
      error: 'browser_not_installed',
      hint: 'No Chromium binary was found. Run: npx playwright install chromium',
    };
  }
  if (m.includes('processsingleton') || m.includes('singletonlock')) {
    return {
      error: 'browser_profile_locked',
      hint:
        'A previous Chrome still holds the profile lock. ' +
        'Recover it with POST /api/browser/real/recover — the main server does not need restarting.',
    };
  }
  if (m.includes('timeout') || m.includes('timed out')) {
    return {
      error: 'remote_browser_timeout',
      hint: 'The browser did not become ready in time. Retry; if it repeats, check GET /api/browser/real/health.',
    };
  }
  if (m.includes('websockify') || m.includes('x11vnc') || m.includes('xvfb')) {
    return {
      error: 'desktop_stack_failed',
      hint:
        'A desktop component (Xvfb / x11vnc / websockify) did not come up. ' +
        'See GET /api/browser/desktop/status for which one, then POST /api/browser/desktop/start.',
    };
  }
  if (!config.REAL_CHROME_ENABLED) {
    return {
      error: 'remote_browser_disabled',
      hint: 'Remote Chrome is disabled. Set REAL_CHROME_ENABLED=true and restart the server.',
    };
  }
  return {
    error: 'remote_browser_failed',
    // The raw message is appended rather than shown alone: it is often a
    // multi-line Playwright dump, and the operator needs the summary first.
    hint: `The remote browser could not start. Details: ${msg.split('\n')[0]}`,
  };
}

/**
 * HTTP status for a non-ready outcome.
 *
 * 503 for both, deliberately. "Still starting" and "failed to start" are both
 * "this service is not available right now, the request itself was fine" — and
 * 503 is the one status a client can safely treat as retryable. We never emit
 * 502 ourselves; that code, in this system, only ever meant a gateway invented
 * an answer we did not send.
 */
export function statusForOutcome(outcome: StartOutcome): number {
  return outcome === 'ready' ? 200 : 503;
}
