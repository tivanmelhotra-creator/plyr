/**
 * DesktopSession — a short-lived cookie that authenticates a WHOLE desktop
 * page load, instead of authenticating one URL at a time.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bare Chromium view (`ChromeView.ts`) is served at `/desktop/chrome` and
 * it loads noVNC's RFB client as an ES module. Every request under `/desktop/`
 * passes through `desktopAuthOk()`, which only ever accepted a credential in
 * a header or in `?api_key=`. A browser opening a URL in a new tab cannot set
 * headers, so the page URL carries `?api_key=`. That is fine for the PAGE.
 * It is NOT fine for what the page then loads, and this is the exact bug the
 * user hit — the view sat on "Starting Chromium…" forever:
 *
 *   «من این صفحه اومدم تا کرومیوم بالا بیاد ولی فقط اینو مینویسه و میچرخه
 *    هر چقدرم وایسم بالا نمیاد شاید الان 10 دقیقس که هنوز چیزی بالا نیومده»
 *
 * MEASURED (Playwright + a request-logging server, two ES modules where the
 * parent is imported WITH a query string and imports one relative child):
 *
 *   REQUESTS=["/","/parent.js?api_key=SECRET","/child.js"]
 *   PARENT_HAS_KEY=true
 *   CHILD_HAS_KEY=false
 *
 * A query string on an `import()` specifier is part of THAT module's URL only.
 * It is not inherited by the module's own relative imports, because each
 * specifier is resolved against the importer's URL *path* — the search string
 * is dropped. `core/rfb.js` has 20 direct relative imports and 42 module files
 * in its graph, so once rfb.js loaded, its dependencies were requested with no
 * credential at all, the gate answered 401 to each, the module graph never
 * finished instantiating, and the page's top-level `await import(...)` never
 * resolved. Nothing after it ran — including the code that would have created
 * the RFB connection. Hence a spinner that spins forever with no error: the
 * page was not waiting on Chromium, it was waiting on a module that could
 * never load.
 *
 * Also MEASURED against the running server, before and after:
 *   GET /desktop/core/util/events.js                      -> 401   (the bug)
 *   GET /desktop/core/util/events.js  + session cookie    -> 503   (past the gate)
 *   GET /desktop/core/util/events.js  + FORGED cookie     -> 401   (still refused)
 *
 * Patching this by appending `?api_key=` to every one of those 42 URLs is not
 * possible from our side (they are inside noVNC's own source), and rewriting
 * noVNC's source in the proxy would mean parsing JavaScript to move bytes —
 * exactly what DesktopProxy exists to avoid.
 *
 * THE FIX
 * -------
 * Authenticate the SESSION. When a request proves it holds a valid credential,
 * the response also sets a cookie; `desktopAuthOk()` accepts that cookie.
 * Cookies are sent automatically with subresource requests AND with the
 * WebSocket handshake, so all 42 module fetches and the RFB socket authenticate
 * with no URL rewriting anywhere.
 *
 * WHY IT IS SAFE
 * --------------
 * - The token is HMAC-signed with the server's own API token, so a client
 *   cannot mint one. Verification is `timingSafeEqual` on the digest.
 * - It carries an absolute expiry INSIDE the signed payload, so extending the
 *   lifetime requires the secret; deleting the cookie's own Max-Age does not.
 * - `HttpOnly` keeps it away from page scripts, `SameSite=Lax` keeps it off
 *   cross-site requests, `Path=/desktop` keeps it off the rest of the API.
 * - It only ever grants what the caller ALREADY proved: the cookie is issued
 *   after `authorizeLive` said yes, and grants exactly the desktop paths.
 * - Secret rotation invalidates every outstanding token for free, because the
 *   secret IS the signing key.
 */

import crypto from 'crypto';
import type { IncomingMessage } from 'http';

import { config } from '../config';

/** Cookie name. Prefixed to make its scope obvious in devtools. */
export const DESKTOP_COOKIE = 'ab_desktop';

/**
 * How long a desktop session lasts.
 *
 * Long enough that an operator can watch a browser automation run without
 * being logged out mid-task, short enough that a token copied out of a log is
 * worthless by the time anyone reads it. The page is trivially re-openable, so
 * a short life costs the user nothing.
 */
export const DESKTOP_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * The signing key.
 *
 * Read at call time, never cached, so a rotated secret takes effect at once
 * rather than at the next restart.
 *
 * WHY NOT JUST API_TOKEN
 * ----------------------
 * MEASURED: `config.API_TOKEN` is `''` whenever DEPLOYMENT_MODE is 'multi',
 * because there each user has their own key and there is no single shared
 * token. Signing with it would therefore mint nothing at all on every
 * multi-tenant install, `verifyDesktopToken` would refuse the cookie it had
 * just issued, and the view would hang on "Starting Chromium…" forever — the
 * exact bug this module exists to fix, reintroduced for SaaS users only, where
 * it would have been much harder to find. This was caught by the behaviour test
 * "accepts a token it just issued" failing under the default test config.
 *
 * `LIVE_SHARE_SECRET` is the right key: it already exists for signing shareable
 * live-view tokens, and it is already defined as
 * `LIVE_SHARE_SECRET || WEBHOOK_SECRET || API_TOKEN`, i.e. the project's own
 * answer to "a secret that is always present in both deployment modes".
 */
function secret(): string {
  return config.LIVE_SHARE_SECRET || config.API_TOKEN || '';
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * Mint a token for a caller who has ALREADY been authorized.
 *
 * Format: `<expiryMs>.<hmac>`. The expiry is in the signed payload, not merely
 * alongside it, so it cannot be edited without the secret.
 */
export function issueDesktopToken(now: number = Date.now()): string {
  const exp = String(now + DESKTOP_SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

/** Is this token ours, and still valid? */
export function verifyDesktopToken(token: string, now: number = Date.now()): boolean {
  // An empty secret would make every signature forgeable by anyone who can
  // read this file, so refuse to verify at all rather than accept everything.
  if (!secret()) return false;
  if (typeof token !== 'string' || !token) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !mac) return false;

  const expected = sign(exp);
  // Same length is a precondition of timingSafeEqual, and an attacker learns
  // nothing from a length mismatch they caused themselves.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  return Number(exp) > now;
}

/**
 * Read one cookie out of a raw Cookie header.
 *
 * Hand-parsed rather than adding `cookie-parser` to the dependency tree for a
 * single lookup on one route family. Only `name=value` pairs split on `;` are
 * in play here — the token is base64url plus a dot, so there is nothing to
 * unescape.
 */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

/** Does this request already carry a valid desktop session? */
export function requestHasDesktopSession(
  req: Pick<IncomingMessage, 'headers'>,
  now: number = Date.now(),
): boolean {
  const raw = req.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join('; ') : raw;
  return verifyDesktopToken(readCookie(header, DESKTOP_COOKIE), now);
}

/**
 * The Set-Cookie value that installs a desktop session.
 *
 * `Secure` is decided by how the request actually arrived, not by NODE_ENV: the
 * sandbox and every PaaS publish this app over HTTPS through a proxy, where the
 * hop we see is plain HTTP but the browser's connection is not. A `Secure`
 * cookie on a genuinely-HTTP dev origin would be dropped silently and the view
 * would break in exactly the invisible way we are fixing, so trust
 * `x-forwarded-proto` when a proxy set it.
 */
export function desktopCookieHeader(
  req: Pick<IncomingMessage, 'headers'> & { socket?: unknown },
  token: string = issueDesktopToken(),
): string {
  const fwd = req.headers?.['x-forwarded-proto'];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim().toLowerCase();
  // `encrypted` exists on TLSSocket only, so it is absent from the base Socket
  // type; reading it defensively is how Node itself distinguishes the two.
  const tls = req.socket as { encrypted?: boolean } | undefined;
  const secure = proto === 'https' || Boolean(tls?.encrypted);

  const parts = [
    `${DESKTOP_COOKIE}=${token}`,
    // Scoped to the desktop mount: this credential must not ride along on
    // ordinary API calls, where it grants nothing but widens exposure.
    'Path=/desktop',
    'HttpOnly',
    // Lax, not Strict: the operator arrives here via a link opened from the
    // app in a NEW TAB, which Strict would treat as cross-site on first load.
    'SameSite=Lax',
    `Max-Age=${Math.floor(DESKTOP_SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
