/**
 * Behaviour tests for the desktop session cookie.
 *
 * WHAT BUG THESE GUARD
 * --------------------
 * The bare Chromium view sat on "Starting Chromium…" forever. Root cause,
 * MEASURED with a request-logging server and a real browser: a query string on
 * an `import()` specifier is NOT inherited by that module's own relative
 * imports —
 *
 *   REQUESTS=["/","/parent.js?api_key=SECRET","/child.js"]
 *   PARENT_HAS_KEY=true
 *   CHILD_HAS_KEY=false
 *
 * so `core/rfb.js`'s 41 dependencies were fetched with no credential, the gate
 * answered 401 to each, the module graph never instantiated, and the page's
 * top-level await never resolved. The fix authenticates the SESSION with a
 * signed cookie, which the browser attaches to subresources and to the
 * WebSocket handshake automatically.
 *
 * These tests drive the real functions and assert on BEHAVIOUR (does this token
 * open the gate? does a forged one?), never on the presence of strings in the
 * source.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  DESKTOP_COOKIE,
  DESKTOP_SESSION_TTL_MS,
  desktopCookieHeader,
  issueDesktopToken,
  readCookie,
  requestHasDesktopSession,
  verifyDesktopToken,
} from '../../src/core/DesktopSession';

/** A minimal request shape; only what the functions actually read. */
function reqWith(cookie?: string, headers: Record<string, unknown> = {}) {
  return { headers: { ...(cookie ? { cookie } : {}), ...headers } } as never;
}

/** The attributes of a Set-Cookie value, trimmed. */
function attrsOf(header: string): string[] {
  return header.split(';').map((s) => s.trim());
}

describe('desktop session token', () => {
  it('accepts a token it just issued', () => {
    expect(verifyDesktopToken(issueDesktopToken())).toBe(true);
  });

  it('refuses a token whose expiry has passed', () => {
    const now = 1_000_000_000_000;
    const token = issueDesktopToken(now);
    // Valid a moment before the deadline, so the failure after it is genuinely
    // the expiry and not a broken signature.
    expect(verifyDesktopToken(token, now + DESKTOP_SESSION_TTL_MS - 1)).toBe(true);
    expect(verifyDesktopToken(token, now + DESKTOP_SESSION_TTL_MS + 1)).toBe(false);
  });

  it('refuses a token whose expiry was edited to last longer', () => {
    // The whole point of signing the expiry rather than storing it beside the
    // signature: a client that extends its own session must be rejected.
    const now = Date.now();
    const token = issueDesktopToken(now);
    const mac = token.slice(token.indexOf('.') + 1);
    const forged = `${now + 10 * DESKTOP_SESSION_TTL_MS}.${mac}`;
    expect(verifyDesktopToken(forged, now)).toBe(false);
  });

  it('refuses a token with a wrong signature', () => {
    const token = issueDesktopToken();
    const exp = token.slice(0, token.indexOf('.'));
    expect(verifyDesktopToken(`${exp}.notarealsignature`)).toBe(false);
  });

  it('refuses a signature that is right except for one character', () => {
    // Guards against a comparison that only checks length, or a prefix match.
    const token = issueDesktopToken();
    const dot = token.indexOf('.');
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
    expect(flipped).not.toBe(mac);
    expect(verifyDesktopToken(`${exp}.${flipped}`)).toBe(false);
  });

  it('refuses a signature that is a valid PREFIX of the real one', () => {
    // MUTATION-DRIVEN. Replacing the constant-time compare with
    // `expected.startsWith(mac)` survived the rest of this suite: flipping a
    // character is caught, but TRUNCATING is not, and a prefix check would
    // accept a one-character signature — i.e. trivially forgeable. So assert
    // that shortening a genuine signature invalidates it, at every length.
    const token = issueDesktopToken();
    const dot = token.indexOf('.');
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    expect(verifyDesktopToken(`${exp}.${mac}`)).toBe(true); // control

    for (const len of [1, 2, 8, mac.length - 1]) {
      expect(
        verifyDesktopToken(`${exp}.${mac.slice(0, len)}`),
        `a ${len}-character prefix of the signature was accepted`,
      ).toBe(false);
    }
  });

  it('refuses a signature that merely CONTAINS the real one', () => {
    // The mirror image of the prefix hole: padding must not be ignored either.
    const token = issueDesktopToken();
    const dot = token.indexOf('.');
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    expect(verifyDesktopToken(`${exp}.${mac}extra`)).toBe(false);
    expect(verifyDesktopToken(`${exp}.pre${mac}`)).toBe(false);
  });

  it('refuses malformed and empty input instead of throwing', () => {
    for (const bad of ['', '.', 'nodot', '.onlysig', '123.', 'abc.def', 'x'.repeat(200)]) {
      expect(verifyDesktopToken(bad)).toBe(false);
    }
  });

  it('refuses a non-numeric expiry', () => {
    expect(verifyDesktopToken('notanumber.whatever')).toBe(false);
  });
});

describe('cookie parsing', () => {
  it('finds the desktop cookie among others', () => {
    expect(readCookie(`theme=dark; ${DESKTOP_COOKIE}=abc.def; other=1`, DESKTOP_COOKIE))
      .toBe('abc.def');
  });

  it('tolerates the spacing browsers actually send', () => {
    expect(readCookie(`a=1;${DESKTOP_COOKIE}=v1;b=2`, DESKTOP_COOKIE)).toBe('v1');
    expect(readCookie(`a=1;   ${DESKTOP_COOKIE}=v2   ; b=2`, DESKTOP_COOKIE)).toBe('v2');
  });

  it('does not confuse a cookie whose name merely ends with ours', () => {
    // A suffix match here would let `not_ab_desktop` impersonate the real name.
    expect(readCookie(`not_${DESKTOP_COOKIE}=evil`, DESKTOP_COOKIE)).toBe('');
  });

  it('returns empty for a missing cookie or absent header', () => {
    expect(readCookie(undefined, DESKTOP_COOKIE)).toBe('');
    expect(readCookie('a=1; b=2', DESKTOP_COOKIE)).toBe('');
  });

  it('keeps a value containing base64url characters intact', () => {
    const token = issueDesktopToken();
    expect(readCookie(`x=1; ${DESKTOP_COOKIE}=${token}`, DESKTOP_COOKIE)).toBe(token);
  });
});

describe('requestHasDesktopSession', () => {
  it('is true for a request carrying a valid cookie', () => {
    expect(requestHasDesktopSession(reqWith(`${DESKTOP_COOKIE}=${issueDesktopToken()}`)))
      .toBe(true);
  });

  it('is false for a request with no cookie at all', () => {
    expect(requestHasDesktopSession(reqWith())).toBe(false);
  });

  it('is false for a request carrying a forged cookie', () => {
    expect(requestHasDesktopSession(reqWith(`${DESKTOP_COOKIE}=9999999999999.deadbeef`)))
      .toBe(false);
  });

  it('is false when a valid-looking token sits under the wrong cookie name', () => {
    expect(requestHasDesktopSession(reqWith(`something_else=${issueDesktopToken()}`)))
      .toBe(false);
  });
});

describe('Set-Cookie header', () => {
  it('carries a token that then opens the gate', () => {
    // End to end: whatever the header says, feeding it back as a Cookie must
    // authenticate. This is the property the 41 module fetches depend on.
    const value = desktopCookieHeader(reqWith()).split(';')[0];
    expect(requestHasDesktopSession(reqWith(value))).toBe(true);
  });

  it('is scoped to /desktop so it never rides along on other API calls', () => {
    expect(attrsOf(desktopCookieHeader(reqWith()))).toContain('Path=/desktop');
  });

  it('is HttpOnly and SameSite=Lax', () => {
    const attrs = attrsOf(desktopCookieHeader(reqWith()));
    // HttpOnly: page scripts must not be able to read a desktop credential.
    expect(attrs).toContain('HttpOnly');
    // Lax, not Strict: the operator arrives via a link opened in a NEW TAB,
    // which Strict would treat as cross-site and drop on that first load —
    // reintroducing the very "nothing loads" symptom being fixed.
    expect(attrs).toContain('SameSite=Lax');
  });

  it('expires on its own, so a leaked cookie does not last forever', () => {
    const maxAge = attrsOf(desktopCookieHeader(reqWith())).find((a) => a.startsWith('Max-Age='));
    expect(maxAge).toBeDefined();
    expect(Number(maxAge!.slice('Max-Age='.length)))
      .toBe(Math.floor(DESKTOP_SESSION_TTL_MS / 1000));
  });

  it('is Secure when the browser reached us over https through a proxy', () => {
    // The sandbox and every PaaS publish this app over https while the hop we
    // see is plain http, so x-forwarded-proto is the only available signal.
    const h = desktopCookieHeader(reqWith(undefined, { 'x-forwarded-proto': 'https' }));
    expect(attrsOf(h)).toContain('Secure');
  });

  it('reads only the first hop of a chained x-forwarded-proto', () => {
    const secure = desktopCookieHeader(reqWith(undefined, { 'x-forwarded-proto': 'https, http' }));
    expect(attrsOf(secure)).toContain('Secure');
    const plain = desktopCookieHeader(reqWith(undefined, { 'x-forwarded-proto': 'http, https' }));
    expect(attrsOf(plain)).not.toContain('Secure');
  });

  it('is NOT Secure on a plain http dev origin', () => {
    // A Secure cookie on http://localhost is dropped silently by the browser,
    // which would break the view in exactly the invisible way we are fixing.
    expect(attrsOf(desktopCookieHeader(reqWith()))).not.toContain('Secure');
  });

  it('is Secure on a direct TLS connection with no proxy header', () => {
    const req = { headers: {}, socket: { encrypted: true } } as never;
    expect(attrsOf(desktopCookieHeader(req))).toContain('Secure');
  });
});

describe('secret handling', () => {
  it('signs with a secret that exists in BOTH deployment modes', async () => {
    // REGRESSION GUARD, and the bug this test suite actually found. Signing
    // with `API_TOKEN` alone looks obviously right and is not: MEASURED that
    // API_TOKEN is '' whenever DEPLOYMENT_MODE is 'multi', so on every
    // multi-tenant install the cookie would be refused the instant after it
    // was issued and the Chromium view would hang forever again — for SaaS
    // users only, where it would be far harder to spot.
    vi.resetModules();
    vi.doMock('../../src/config', () => ({
      config: { LIVE_SHARE_SECRET: 'shared-secret-present-in-multi', API_TOKEN: '' },
    }));
    const mod = await import('../../src/core/DesktopSession');
    expect(mod.verifyDesktopToken(mod.issueDesktopToken())).toBe(true);
    vi.doUnmock('../../src/config');
    vi.resetModules();
  });

  it('refuses every token when no secret is configured', async () => {
    // An empty signing key would make each signature reproducible by anyone,
    // so the safe answer is "no", not "yes to everything".
    const token = issueDesktopToken();
    vi.resetModules();
    vi.doMock('../../src/config', () => ({
      config: { LIVE_SHARE_SECRET: '', API_TOKEN: '' },
    }));
    const mod = await import('../../src/core/DesktopSession');
    expect(mod.verifyDesktopToken(token)).toBe(false);
    // ...and it cannot be rescued by issuing a fresh one either: with no key
    // there is no such thing as a valid token.
    expect(mod.verifyDesktopToken(mod.issueDesktopToken())).toBe(false);
    vi.doUnmock('../../src/config');
    vi.resetModules();
  });

  it('invalidates outstanding tokens when the secret changes', async () => {
    const token = issueDesktopToken();
    vi.resetModules();
    vi.doMock('../../src/config', () => ({
      config: { LIVE_SHARE_SECRET: 'a-completely-different-secret' },
    }));
    const mod = await import('../../src/core/DesktopSession');
    expect(mod.verifyDesktopToken(token)).toBe(false);
    // ...but the rotated secret still issues working tokens of its own.
    expect(mod.verifyDesktopToken(mod.issueDesktopToken())).toBe(true);
    vi.doUnmock('../../src/config');
    vi.resetModules();
  });
});
