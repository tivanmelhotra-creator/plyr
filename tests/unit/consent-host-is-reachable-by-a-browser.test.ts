/**
 * consent-host-is-reachable-by-a-browser.test.ts
 *
 * THE GAP THIS FILE EXISTS TO CLOSE
 * ─────────────────────────────────
 * `GET /inspector/consent-host` already had five integration tests, and they all
 * passed while the real server answered **401 «Authentication required»**. The
 * page was unreachable in production and the suite was green.
 *
 * The reason is a mounting difference, not a logic error. Those tests build an
 * Express app and mount the router DIRECTLY:
 *
 *     app.use(modeRoutes(deps))          // tests
 *     app.use('/inspector', inspectorAuthMiddleware); app.use(modeRoutes(deps))
 *                                        // src/index.ts — the real server
 *
 * so every request in the integration tier skips the auth middleware entirely.
 * A route can be perfectly written, fully tested, and still be *fronted* by a
 * gate that rejects it. Nothing in the router's own file can observe that, which
 * is exactly why the defect survived to live testing.
 *
 * WHY THE EXEMPTION IS THE POINT, NOT AN OPTIMISATION
 * ───────────────────────────────────────────────────
 * This route is the one URL in the subsystem that a BROWSER navigates to, rather
 * than something `fetch()` calls. A top-level navigation cannot carry an
 * `x-api-key` header — there is no API to attach one with. So gating it does not
 * mean "the caller must authenticate", it means "this page can never load":
 * Chromium receives a 401 JSON body, the extension's content script has no http
 * document to be injected into, and the consent Alert has nowhere to render. The
 * whole LOCAL-mode Alert chain terminates here.
 *
 * WHY THESE ARE STATIC ASSERTIONS
 * ───────────────────────────────
 * The live proof is the primary evidence and has been taken: with the fix the
 * server answers 200 / text/html / no key, and the Alert was then observed
 * rendering (div#ab-consent-host, with the correct node and field inside its
 * closed shadow root) in the server-seeded browser. What a test adds is that the
 * exemption cannot be quietly deleted later — and this is a WIRING fact (which
 * branch of a middleware runs, and in what order) rather than a computation,
 * which is the same class of thing `restart-tab-loss.test.ts` pins this way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const index = read('src/index.ts');
const modeRoutes = read('src/Routes/mode.routes.ts');

/** The body of `inspectorAuthMiddleware`, bounded by the next declaration. */
function middlewareBody(): string {
  const at = index.indexOf('const inspectorAuthMiddleware = (');
  expect(at, 'inspectorAuthMiddleware must exist — it is the /inspector gate').toBeGreaterThan(0);
  const end = index.indexOf("app.use('/inspector', inspectorAuthMiddleware)", at);
  return index.slice(at, end > at ? end : at + 12000);
}

describe('the consent host page is reachable by a browser that has authenticated nothing', () => {
  it('is exempted from the /inspector auth middleware', () => {
    const body = middlewareBody();
    expect(
      /if\s*\(\s*sub\s*===\s*'\/consent-host'\s*\)\s*return next\(\)/.test(body),
      'GET /inspector/consent-host must bypass the auth gate: a top-level browser '
        + 'navigation cannot send x-api-key, so gating it makes the page — and therefore '
        + 'the consent Alert that can only be injected into it — permanently unreachable',
    ).toBe(true);
  });

  it('is exempted BEFORE any branch that can reject the request', () => {
    const body = middlewareBody();
    const exemption = body.indexOf("sub === '/consent-host'");
    const pair = body.indexOf("sub === '/pair'");
    const tokenPaths = body.indexOf('inspectorTokenPaths.has(sub)');

    expect(exemption, 'the exemption must be present').toBeGreaterThan(0);
    // Order is the whole substance of a middleware: an exemption placed after a
    // branch that has already sent a 401 never runs.
    expect(exemption).toBeLessThan(pair);
    expect(exemption).toBeLessThan(tokenPaths);
  });

  it('exempts the page WITHOUT widening the gate for real consent data', () => {
    const body = middlewareBody();
    // The prompt's contents are still fetched authenticated from
    // GET /inspector/consent. Only the empty canvas is public. If '/consent'
    // itself ever gained a bare `return next()`, every pending prompt — node
    // names, field keys, labels — would be world-readable from loopback.
    expect(/if\s*\(\s*sub\s*===\s*'\/consent'\s*\)\s*return next\(\)/.test(body)).toBe(false);
    expect(/if\s*\(\s*sub\s*===\s*'\/element'\s*\)\s*return next\(\)/.test(body)).toBe(false);
  });

  it('the route it exempts actually exists, and serves html', () => {
    // Guards against the halves drifting apart: an exemption for a path that no
    // longer exists is dead code, and a renamed route would silently become
    // gated again — which is the original defect, returning by another road.
    const at = modeRoutes.indexOf("router.get('/inspector/consent-host'");
    expect(at, 'the consent-host route must exist in mode.routes.ts').toBeGreaterThan(0);
    expect(modeRoutes.slice(at, at + 300)).toMatch(/res\.type\('html'\)\.send\(consentHostPage\(\)\)/);
  });

  it('is the ONLY html-serving inspector route, so the exemption stays this narrow', () => {
    // If a second navigable page is ever added it will need the same treatment,
    // and this test is where that decision must be made deliberately rather
    // than discovered in production the way the 401 was.
    const htmlRoutes = modeRoutes.match(/res\.type\('html'\)/g) || [];
    expect(htmlRoutes.length).toBe(1);
  });
});
