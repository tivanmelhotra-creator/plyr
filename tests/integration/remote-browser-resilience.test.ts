import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';

// ════════════════════════════════════════════════════════════════════════════
// REMOTE BROWSER FAILURE MUST NOT KILL THE APPLICATION
//
// THE INCIDENT
// ------------
// Selecting REMOTE BROWSER produced:
//
//     Could not start the remote browser: HTTP 502
//
// and then, in the reporter's words:
//
//   «بعد از این خطا، پروسه/سرور/پورت مربوط به Remote Browser یا بخشی از
//    اپلیکیشن terminate می‌شود و بعد از refresh کل پروژه بالا نمی‌آید.»
//
// i.e. the failure did not stay in the request. It took the process, the
// listening port and the whole application with it.
//
// THE REQUIRED BEHAVIOUR, VERBATIM
// --------------------------------
//     Remote Browser start -> FAIL -> controlled error
//                          -> main application stays alive -> user can retry
//
// WHAT THIS FILE PROVES
// ---------------------
// The five acceptance points, in order, against a REAL HTTP server on a REAL
// port with the REAL router:
//
//   1. Remote Browser startup is deliberately made to fail.
//   2. The endpoint answers with a CONTROLLED error (4xx/5xx JSON, never a
//      dangling socket and never a 502).
//   3. The main process is still alive afterwards.
//   4. /health still responds.
//   5. A subsequent request can start the browser again (retry works).
//
// WHY IT BINDS A REAL PORT. supertest alone would not detect the actual
// regression: `process.exit()` and a released listening socket are process- and
// OS-level effects, invisible to an in-memory app object. Asserting that the
// SAME port still accepts a connection after the failure is the only way to
// show the reported symptom ("after refresh the whole project no longer comes
// up") cannot recur.
//
// WHY THE FAULTS ARE INJECTED, NOT AWAITED. A genuine cold start takes ~50s on
// a clean box and needs Xvfb, x11vnc, websockify and a headed Chromium — none
// of which exist in CI. Mocking the two modules the route depends on lets us
// reproduce every failure shape that was reported (a throw, a bare rejection, a
// hang, and an upstream 502/503/504) deterministically and in milliseconds.
// ════════════════════════════════════════════════════════════════════════════

// ── Fault injection switchboard ────────────────────────────────────────────
// Flipped per test; the mocked modules below read it on every call.
const behaviour = {
  desktop: 'ok' as 'ok' | 'throw' | 'hang',
  chrome: 'ok' as 'ok' | 'throw' | 'reject-plain' | 'hang',
};

const never = () => new Promise<never>(() => { /* deliberately never settles */ });

vi.mock('../../src/core/Desktop', () => {
  class DesktopError extends Error {
    constructor(message: string) { super(message); this.name = 'DesktopError'; }
  }
  const status = {
    enabled: true, running: true, displayRunning: true, display: ':99',
    vncPort: 5900, novncPort: 6080, missing: [] as string[],
  };
  return {
    DesktopError,
    Desktop: {
      start: async () => {
        if (behaviour.desktop === 'throw') {
          throw new DesktopError('xvfb: could not start the remote desktop');
        }
        if (behaviour.desktop === 'hang') return never();
        return status;
      },
      status: async () => status,
      isRunning: () => true,
      stop: async () => ({ stopped: true }),
      displayUp: async () => true,
      missingBinaries: async () => [],
      provisionState: () => ({ state: 'ready' }),
      display: ':99',
    },
  };
});

vi.mock('../../src/core/RealChrome', () => {
  class RealChromeError extends Error {
    constructor(message: string) { super(message); this.name = 'RealChromeError'; }
  }
  const guard = async <T>(value: T): Promise<T> => {
    if (behaviour.chrome === 'throw') {
      throw new RealChromeError(
        "browserType.launchPersistentContext: Executable doesn't exist at /ms-playwright/chromium/chrome",
      );
    }
    if (behaviour.chrome === 'reject-plain') {
      // A BARE Error, the shape Playwright actually throws for the two most
      // common failures on a fresh box. It carries no typed class for
      // sendError() to match, which is exactly why it used to fall through.
      throw new Error('Missing X server or $DISPLAY');
    }
    if (behaviour.chrome === 'hang') return never();
    return value;
  };
  return {
    RealChromeError,
    RealChrome: {
      isEnabled: () => true,
      isRunning: () => false,
      isResponsive: async () => guard(true),
      recycleIfWedged: async () => guard({ action: 'healthy' as const, reason: 'ok' }),
      getContext: async () => guard({} as unknown),
      newPage: async () => guard({ goto: async () => undefined } as unknown),
      // MUST be stubbed alongside newPage, and the reason is worth recording.
      //
      // The launcher used to navigate only when the request carried a `url`.
      // Every test in this file posts `{}` — which is exactly what the dashboard
      // sends, since ctx.url is '' until a goto node supplies a literal address
      // — so the page-allocating call was NEVER reached here, and a mock missing
      // it stayed green.
      //
      // It is reached unconditionally now: the window must land somewhere the
      // extension's content script is actually injected, or the consent Alert
      // has nowhere to render. Omitting this stub therefore turned every launch
      // into a TypeError surfacing as a 503 — and it was the DOUBLE that was
      // incomplete, not the route.
      //
      // ── RENAMED, BECAUSE THE ROUTE NO LONGER ASKS FOR A PAGE ───────────────
      // This was `landingPage()`, which always handed back a page for the route
      // to navigate — and when no page was blank it handed back the LAST one,
      // which is how an unrelated Google tab got overwritten by the Alert. That
      // function is gone; the route now asks WHERE the Alert should appear.
      //
      // The default answer here is `overlay`, and it deliberately carries NO
      // page: the browser already holds an injectable page, so content/consent.js
      // draws the Alert itself and the route must navigate nothing. That is the
      // wanted path, so it is the one the resilience tests exercise — a double
      // returning `tab` would quietly test the fallback instead.
      //
      // Routed through the same `guard` as its neighbours for consistency, not
      // because this file needs it: MEASURED by removing the guard, all 9 tests
      // stayed green, because every injected fault is raised earlier in the
      // chain (getContext / recycleIfWedged) and the route never gets this far.
      // Recorded so the next reader does not mistake the guard for load-bearing
      // coverage.
      alertSurface: async () => guard({ kind: 'overlay' as const, pages: 1 } as unknown),
      // `alertTab` USED TO BE DOUBLED HERE, and its removal is deliberate.
      //
      // It was justified as "present so a test that forces the fallback has
      // something to reach", but there is no fallback left to force — the
      // method is gone from RealChrome along with the dedicated Alert page:
      //
      //   «این concept باید از معماری حذف شود: alertTab(), consent-host,
      //    dedicated alert page»
      //
      // Leaving the double in place would be actively harmful in a file whose
      // whole purpose is fault injection: a double for a method the real class
      // no longer has means the route could start calling it again and these
      // tests would keep passing, because the DOUBLE would answer. Removing it
      // makes any such call a TypeError here, which is what it would be in
      // production.
      tabs: async () => guard([] as unknown[]),
      status: async () => guard({ running: true, extensions: 1 }),
      stop: async () => undefined,
      restart: async () => guard({ ok: true }),
      flags: () => ({}),
    },
  };
});

let app: Express;
let server: http.Server;
let port: number;
/** Faults that reached the process-level handlers during the whole file. */
const escapedFaults: unknown[] = [];

beforeAll(async () => {
  // Keep the budget short so "still starting" is reachable in a unit-test
  // timeframe. In production it defaults to 25s, chosen to undercut gateway
  // read timeouts of 30-60s.
  process.env.REMOTE_BROWSER_START_BUDGET_MS = '1500';

  const { createBrowserRoutes } = await import('../../src/Routes/browser.routes');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const key = String(req.header('x-api-key') || 'test_key_123');
    (req as { apiKey?: string; apiKeyUserId?: string }).apiKey = key;
    (req as { apiKeyUserId?: string }).apiKeyUserId = 'local';
    next();
  });

  // The real /health is deliberately browser-INDEPENDENT (health.routes.ts
  // computes nothing from the browser), so a stand-in with the same contract is
  // enough here and keeps Redis out of the test.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.use(createBrowserRoutes());

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  // Record anything that escapes to process scope. Under the OLD policy these
  // handlers were `shutdown() -> process.exit(0)`; the assertion at the end of
  // this file is the regression guard for that.
  process.on('unhandledRejection', (r) => { escapedFaults.push(r); });
  process.on('uncaughtException', (e) => { escapedFaults.push(e); });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Is the ORIGINAL port still accepting connections? */
function portIsAlive(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http
      .get({ host: '127.0.0.1', port: p, path: '/health', timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      })
      .on('error', () => resolve(false))
      .on('timeout', () => { req.destroy(); resolve(false); });
  });
}

describe('remote browser startup failure is contained in request scope', () => {
  it('1-5: a typed launch failure returns a controlled error, the app survives, and retry works', async () => {
    // ── 1. Deliberately fail Remote Browser startup ───────────────────────
    behaviour.chrome = 'throw';

    // ── 2. The endpoint returns a CONTROLLED error ────────────────────────
    const failed = await request(app).post('/browser/real/open').send({});

    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.status).toBeLessThan(600);
    // Never 502. In this system 502 only ever meant "a gateway invented an
    // answer we did not send", and reproducing it here would recreate the
    // unparseable message the user actually saw.
    expect(failed.status).not.toBe(502);
    expect(failed.body).toMatchObject({ success: false });
    expect(typeof failed.body.error).toBe('string');
    expect(failed.body.error.length).toBeGreaterThan(0);
    // An actionable next step, not a bare status code.
    expect(typeof failed.body.hint).toBe('string');

    // ── 3. The main process is still alive ────────────────────────────────
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);

    // ── 4. /health still responds — over the real socket, on the real port ─
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(await portIsAlive(port)).toBe(true);

    // ── 5. A subsequent request can start the browser again ───────────────
    behaviour.chrome = 'ok';
    const ok = await request(app).post('/browser/real/open').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.viewPath).toBe('/desktop/chrome');
  });

  it('an UNTYPED launch error (bare Error from Playwright) is still controlled', async () => {
    // The shape that used to slip past sendError()'s instanceof chain and
    // become a 500 with a raw multi-line Playwright dump — or worse, an
    // unhandled rejection.
    behaviour.chrome = 'reject-plain';

    const res = await request(app).post('/browser/real/open').send({});
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('display_unavailable');
    expect(res.body.hint).toMatch(/desktop\/start|Xvfb/i);

    expect((await request(app).get('/health')).status).toBe(200);
    behaviour.chrome = 'ok';
  });

  it('a desktop-layer failure is controlled too, and does not disable the endpoint', async () => {
    behaviour.desktop = 'throw';

    const res = await request(app).post('/browser/real/open').send({});
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.retryable).toBe(true);

    behaviour.desktop = 'ok';
    const after = await request(app).post('/browser/real/open').send({});
    expect(after.status).toBe(200);
    expect(after.body.success).toBe(true);
  });

  it('a HANGING start answers inside the budget instead of letting a proxy invent a 502', async () => {
    // THE ACTUAL ROOT CAUSE, reproduced. Measured on a clean box the real route
    // returned 200 after 50.3 SECONDS with no deadline anywhere in the chain,
    // so whichever reverse proxy sat in front timed out first and served its
    // own HTML 502/504 — a body the UI cannot parse, which is why the message
    // degraded to the bare "HTTP 502".
    behaviour.chrome = 'hang';
    const began = Date.now();

    const res = await request(app).post('/browser/real/open').send({});
    const elapsed = Date.now() - began;

    // We answered, and we answered FIRST.
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('remote_browser_starting');
    expect(res.body.retryable).toBe(true);
    expect(elapsed).toBeLessThan(8000);

    // And the hung work did not poison the process.
    expect((await request(app).get('/health')).status).toBe(200);
    expect(await portIsAlive(port)).toBe(true);

    behaviour.chrome = 'ok';
  });

  it('repeated failures never escalate to process scope', async () => {
    behaviour.chrome = 'throw';
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/browser/real/open').send({});
      expect(res.body.success).toBe(false);
    }
    behaviour.chrome = 'ok';

    // Give any deferred rejection a turn on the microtask/macrotask queue.
    await new Promise((r) => setTimeout(r, 50));

    // THE REGRESSION GUARD. Every one of these used to be routed to
    // shutdown() -> process.exit(0), which is precisely how "the port dies and
    // the project never comes back" happened.
    expect(escapedFaults).toEqual([]);
    expect(await portIsAlive(port)).toBe(true);
  });
});

describe('upstream 502 / 503 / 504 are handled as controlled errors', () => {
  // The desktop proxy is the only place in src/ that can see a 5xx from
  // something else (websockify). It used to forward that status verbatim, which
  // handed the UI a body it could not parse.
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamStatus = 502;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(upstreamStatus, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  for (const status of [502, 503, 504]) {
    it(`upstream ${status} becomes our own 503 JSON, not a forwarded ${status}`, async () => {
      upstreamStatus = status;

      const { config } = await import('../../src/config');
      const { DesktopProxy } = await import('../../src/core/DesktopProxy');
      const original = config.DESKTOP_NOVNC_PORT;
      (config as { DESKTOP_NOVNC_PORT: number }).DESKTOP_NOVNC_PORT = upstreamPort;

      const proxy = new DesktopProxy();
      const proxied = express();
      proxied.use((req, res, next) => {
        if (proxy.handleRequest(req, res)) return;
        next();
      });
      proxied.get('/health', (_req, res) => res.json({ status: 'ok' }));

      try {
        const res = await request(proxied)
          .get('/desktop/app/ui.js')
          .set('x-api-key', 'test_key_123');

        // Translated, not forwarded. The client gets JSON with a cause.
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('desktop_upstream_unavailable');
        expect(res.body.hint).toContain(String(status));

        // The app is untouched by an upstream gateway failure.
        expect((await request(proxied).get('/health')).status).toBe(200);
      } finally {
        (config as { DESKTOP_NOVNC_PORT: number }).DESKTOP_NOVNC_PORT = original;
      }
    });
  }

  it('an upstream that is not listening at all is a controlled 503, not a crash', async () => {
    const { config } = await import('../../src/config');
    const { DesktopProxy } = await import('../../src/core/DesktopProxy');
    const original = config.DESKTOP_NOVNC_PORT;
    // A port nothing is bound to: the ECONNREFUSED case, i.e. "the operator has
    // not started the desktop yet", which is the COMMON case rather than an
    // exceptional one.
    (config as { DESKTOP_NOVNC_PORT: number }).DESKTOP_NOVNC_PORT = 1;

    const proxy = new DesktopProxy();
    const proxied = express();
    proxied.use((req, res, next) => {
      if (proxy.handleRequest(req, res)) return;
      next();
    });
    proxied.get('/health', (_req, res) => res.json({ status: 'ok' }));

    try {
      const res = await request(proxied)
        .get('/desktop/app/ui.js')
        .set('x-api-key', 'test_key_123');

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('desktop_not_running');
      expect((await request(proxied).get('/health')).status).toBe(200);
    } finally {
      (config as { DESKTOP_NOVNC_PORT: number }).DESKTOP_NOVNC_PORT = original;
    }
  });
});
