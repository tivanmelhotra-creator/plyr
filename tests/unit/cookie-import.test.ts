/**
 * Cookie import — the parser that turns a browser-extension export into
 * cookies Playwright can inject.
 *
 * These tests are written around the ways a REAL export file differs from the
 * shape Playwright wants, because every one of those differences has the same
 * failure mode in production: `addCookies` throws on the whole array and the
 * user sees "0 cookies imported" with no explanation.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCookieFile,
  parseNetscapeCookies,
  normalizeSameSite,
  normalizeExpiry,
  mergeIntoStorageState,
  CookieImportError,
} from '../../src/core/CookieImport';

const cookieEditorExport = JSON.stringify([
  {
    domain: '.example.com',
    expirationDate: 1893456000.123456,
    hostOnly: false,
    httpOnly: true,
    name: 'sessionid',
    path: '/',
    sameSite: 'no_restriction',
    secure: true,
    session: false,
    storeId: '0',
    value: 'abc123',
  },
  {
    domain: 'app.example.com',
    hostOnly: true,
    httpOnly: false,
    name: 'csrftoken',
    path: '/',
    sameSite: 'unspecified',
    secure: false,
    session: true,
    storeId: '0',
    value: 'xyz789',
  },
]);

describe('normalizeSameSite', () => {
  it('maps Chrome extension spellings onto Playwright values', () => {
    expect(normalizeSameSite('no_restriction')).toBe('None');
    expect(normalizeSameSite('strict')).toBe('Strict');
    expect(normalizeSameSite('lax')).toBe('Lax');
  });

  it('maps "unspecified" to Lax, not None', () => {
    // Chrome's own default for a Set-Cookie with no SameSite is Lax. Mapping
    // "unspecified" to None would silently widen the cookie to cross-site
    // requests it was never sent on.
    expect(normalizeSameSite('unspecified')).toBe('Lax');
    expect(normalizeSameSite('')).toBe('Lax');
    expect(normalizeSameSite(undefined)).toBe('Lax');
    expect(normalizeSameSite('nonsense')).toBe('Lax');
  });
});

describe('normalizeExpiry', () => {
  it('floors the fractional seconds Cookie-Editor writes', () => {
    expect(normalizeExpiry(1893456000.987)).toBe(1893456000);
  });

  it('detects millisecond timestamps and converts them', () => {
    // 1893456000000 ms = 1893456000 s. Passed through as seconds it would be
    // the year 55000, and some servers reject an absurd Max-Age outright.
    expect(normalizeExpiry(1893456000000)).toBe(1893456000);
  });

  it('treats session cookies as -1 however they are spelled', () => {
    expect(normalizeExpiry(undefined)).toBe(-1);
    expect(normalizeExpiry(null)).toBe(-1);
    expect(normalizeExpiry(0)).toBe(-1);
    expect(normalizeExpiry('')).toBe(-1);
    expect(normalizeExpiry(1893456000, true)).toBe(-1);
  });
});

describe('parseCookieFile — Cookie-Editor / EditThisCookie JSON', () => {
  it('parses a realistic export', () => {
    const r = parseCookieFile(cookieEditorExport);
    expect(r.format).toBe('cookie-editor');
    expect(r.cookies).toHaveLength(2);
    expect(r.skipped).toBe(0);
    expect(r.domains).toEqual(['app.example.com', 'example.com']);
  });

  it('keeps the leading dot only for non-hostOnly cookies', () => {
    const r = parseCookieFile(cookieEditorExport);
    expect(r.cookies[0].domain).toBe('.example.com');
    expect(r.cookies[1].domain).toBe('app.example.com');
  });

  it('downgrades SameSite=None to Lax when the cookie is not Secure', () => {
    // Playwright (and Chrome) reject None without Secure, and one such row
    // fails the entire addCookies() call.
    const r = parseCookieFile(JSON.stringify([{
      name: 'a', value: '1', domain: 'x.com', path: '/',
      sameSite: 'no_restriction', secure: false,
    }]));
    expect(r.cookies[0].sameSite).toBe('Lax');
  });

  it('keeps None when the cookie IS Secure', () => {
    const r = parseCookieFile(JSON.stringify([{
      name: 'a', value: '1', domain: 'x.com', path: '/',
      sameSite: 'no_restriction', secure: true,
    }]));
    expect(r.cookies[0].sameSite).toBe('None');
  });

  it('skips unusable rows instead of failing the whole file', () => {
    const r = parseCookieFile(JSON.stringify([
      { name: 'good', value: '1', domain: 'x.com' },
      { value: 'no name', domain: 'x.com' },
      { name: 'no domain', value: '1' },
      'not an object',
    ]));
    expect(r.cookies).toHaveLength(1);
    expect(r.skipped).toBe(3);
  });

  it('accepts an empty VALUE but never an empty NAME', () => {
    const r = parseCookieFile(JSON.stringify([
      { name: 'cleared', value: '', domain: 'x.com' },
    ]));
    expect(r.cookies).toHaveLength(1);
    expect(r.cookies[0].value).toBe('');
  });

  it('accepts the { cookies: [...] } wrapper', () => {
    const r = parseCookieFile(JSON.stringify({
      cookies: [{ name: 'a', value: '1', domain: 'x.com' }],
    }));
    expect(r.cookies).toHaveLength(1);
  });
});

describe('parseCookieFile — Playwright storageState', () => {
  it('recognises the format and preserves localStorage origins', () => {
    const r = parseCookieFile(JSON.stringify({
      cookies: [{ name: 'a', value: '1', domain: 'x.com', path: '/', expires: -1 }],
      origins: [{ origin: 'https://x.com', localStorage: [{ name: 'tok', value: 'v' }] }],
    }));
    expect(r.format).toBe('storage-state');
    expect(r.origins).toHaveLength(1);
    expect(r.origins[0].localStorage[0].name).toBe('tok');
  });
});

describe('parseNetscapeCookies — cookies.txt', () => {
  const txt = [
    '# Netscape HTTP Cookie File',
    '# This is a generated file!  Do not edit.',
    '',
    '.example.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tabc123',
    '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\thttponly_one\tv2',
    'app.example.com\tFALSE\t/app\tFALSE\t0\tplain\tv3',
    'garbage line without enough fields',
  ].join('\n');

  it('parses tab-separated rows', () => {
    const { cookies, skipped } = parseNetscapeCookies(txt);
    expect(cookies).toHaveLength(3);
    expect(skipped).toBe(1);
  });

  it('honours the #HttpOnly_ prefix instead of treating it as a comment', () => {
    const { cookies } = parseNetscapeCookies(txt);
    const httpOnly = cookies.find((c) => c.name === 'httponly_one');
    expect(httpOnly?.httpOnly).toBe(true);
    expect(httpOnly?.domain).toBe('.example.com');
  });

  it('treats a 0 expiry as a session cookie', () => {
    const { cookies } = parseNetscapeCookies(txt);
    expect(cookies.find((c) => c.name === 'plain')?.expires).toBe(-1);
  });

  it('is selected automatically by parseCookieFile', () => {
    const r = parseCookieFile(txt);
    expect(r.format).toBe('netscape');
  });
});

describe('parseCookieFile — failure messages', () => {
  it('rejects an empty file', () => {
    expect(() => parseCookieFile('   ')).toThrow(CookieImportError);
  });

  it('explains malformed JSON rather than falling through to cookies.txt', () => {
    expect(() => parseCookieFile('{ "cookies": [ ')).toThrow(/could not be parsed/i);
  });

  it('explains a JSON file with no usable cookies', () => {
    expect(() => parseCookieFile('[{"value":"x"}]')).toThrow(/no usable cookies/i);
  });

  it('explains an unrecognised text file', () => {
    expect(() => parseCookieFile('hello world')).toThrow(/Unrecognised file/i);
  });
});

describe('mergeIntoStorageState', () => {
  const imported = parseCookieFile(JSON.stringify([
    { name: 'sessionid', value: 'NEW', domain: '.example.com', path: '/' },
  ]));

  it('keeps cookies from other sites', () => {
    // Importing Instagram cookies must not sign you out of Google in the same
    // profile.
    const merged = mergeIntoStorageState({
      cookies: [{ name: 'other', value: '1', domain: '.google.com', path: '/' }],
      origins: [],
    }, imported);
    expect(merged.cookies.map((c) => c.name).sort()).toEqual(['other', 'sessionid']);
  });

  it('overwrites a stale cookie with the same name+domain+path', () => {
    const merged = mergeIntoStorageState({
      cookies: [{ name: 'sessionid', value: 'OLD', domain: '.example.com', path: '/' }],
      origins: [],
    }, imported);
    expect(merged.cookies).toHaveLength(1);
    expect(merged.cookies[0].value).toBe('NEW');
  });

  it('treats a different path as a different cookie', () => {
    const merged = mergeIntoStorageState({
      cookies: [{ name: 'sessionid', value: 'OLD', domain: '.example.com', path: '/admin' }],
      origins: [],
    }, imported);
    expect(merged.cookies).toHaveLength(2);
  });

  it('survives a missing / malformed existing state', () => {
    expect(mergeIntoStorageState(undefined, imported).cookies).toHaveLength(1);
    expect(mergeIntoStorageState({}, imported).cookies).toHaveLength(1);
    expect(
      mergeIntoStorageState({ cookies: 'nope' as unknown }, imported).cookies,
    ).toHaveLength(1);
  });
});
