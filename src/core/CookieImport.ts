/**
 * CookieImport — read a cookie file exported by a browser extension and turn it
 * into cookies Playwright can inject.
 *
 * WHY THIS EXISTS
 * ---------------
 * The workflow people actually have is: log in once in their own Chrome, click
 * a cookie extension ("Cookie-Editor", "EditThisCookie", "Get cookies.txt"),
 * export to a file, then import that file into a fresh/incognito profile and be
 * logged in without touching a login form. Automation needs exactly the same
 * escape hatch, otherwise every run starts at a login wall — and a login wall
 * is where 2FA, CAPTCHA and device checks live.
 *
 * Doing this natively (server side) is strictly better than doing it through
 * the extension UI when all you want is the session:
 *   - no clicking inside a remote desktop,
 *   - it works headless,
 *   - the result is a plain Playwright storageState, so a queued job gets the
 *     session too, not just the interactive picker.
 *
 * The extension route is still supported (see RealChrome) because some people
 * want the extension's own UI. This module is the shortcut, not a replacement.
 *
 * FORMATS ACCEPTED
 * ----------------
 *   1. Cookie-Editor / EditThisCookie JSON  → a bare array of cookie objects
 *      with `expirationDate` (seconds, float) and `sameSite` as
 *      "no_restriction" | "lax" | "strict" | "unspecified".
 *   2. `{ "cookies": [ ... ] }`             → the same array under a key.
 *   3. Playwright / Puppeteer storageState  → `{ cookies: [...], origins: [...] }`,
 *      already in the right shape; `origins` (localStorage) is preserved.
 *   4. Netscape `cookies.txt`               → the tab-separated curl/wget format
 *      emitted by "Get cookies.txt LOCALLY".
 *
 * Everything is defensive: a single malformed row must not throw away a file
 * that contains a valid session. Bad rows are counted and reported, not fatal.
 */

export type SameSite = 'Strict' | 'Lax' | 'None';

/** A cookie in the shape `BrowserContext.addCookies()` wants. */
export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // unix seconds, -1 === session cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

/** localStorage/sessionStorage carried by a Playwright storageState file. */
export interface ImportedOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface CookieImportResult {
  cookies: ImportedCookie[];
  origins: ImportedOrigin[];
  /** Which of the four shapes above we recognised. */
  format: 'cookie-editor' | 'storage-state' | 'netscape' | 'unknown';
  /** Rows that were present but unusable (missing name, unparseable line, …). */
  skipped: number;
  /** Distinct domains represented, for the "what did I just import?" summary. */
  domains: string[];
}

export class CookieImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieImportError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Field normalisation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Chrome's extension API spells sameSite in snake_case and has a fourth value,
 * "unspecified", that Playwright does not accept.
 *
 * "unspecified" is mapped to Lax rather than None on purpose: Lax is what Chrome
 * itself applies when a Set-Cookie header omits SameSite, so it reproduces the
 * browser the cookie was exported from. Mapping it to None would silently widen
 * the cookie to cross-site requests it was never sent on.
 */
export function normalizeSameSite(input: unknown): SameSite {
  const raw = String(input ?? '').trim().toLowerCase();
  switch (raw) {
    case 'no_restriction':
    case 'none':
      return 'None';
    case 'strict':
      return 'Strict';
    case 'lax':
    case 'unspecified':
    case '':
      return 'Lax';
    default:
      return 'Lax';
  }
}

/**
 * Expiry to unix SECONDS, or -1 for a session cookie.
 *
 * Exports are inconsistent here: Cookie-Editor writes float seconds, some tools
 * write milliseconds, and session cookies appear as `null`, `0`, or a missing
 * key together with `"session": true`. A millisecond value fed to Playwright as
 * seconds lands in the year 55000 — harmless-looking, but some sites reject a
 * cookie with an absurd Max-Age, so the magnitude check matters.
 */
export function normalizeExpiry(input: unknown, isSession?: unknown): number {
  if (isSession === true) return -1;
  if (input === null || input === undefined || input === '') return -1;

  const n = typeof input === 'number' ? input : Number(String(input).trim());
  if (!Number.isFinite(n) || n <= 0) return -1;

  // 1e11 seconds is the year 5138; anything above it was certainly milliseconds.
  const seconds = n > 1e11 ? n / 1000 : n;
  return Math.floor(seconds);
}

/**
 * Playwright (and Chrome) reject `SameSite=None` unless `Secure` is also set.
 * Exports from an http:// origin routinely violate that, and the whole
 * `addCookies` call fails with one bad row. Downgrading to Lax keeps the cookie
 * usable on same-site navigation, which is what a login cookie needs anyway.
 */
function reconcileSecureSameSite(c: ImportedCookie): ImportedCookie {
  if (c.sameSite === 'None' && !c.secure) {
    return { ...c, sameSite: 'Lax' };
  }
  return c;
}

/**
 * A "hostOnly" cookie must NOT carry a leading dot; a domain cookie must.
 * Extensions store the flag separately from the domain string and the two
 * disagree often enough that trusting either alone loses cookies.
 */
function normalizeDomain(domain: unknown, hostOnly: unknown): string {
  let d = String(domain ?? '').trim().toLowerCase();
  if (!d) return '';
  if (hostOnly === true) {
    while (d.startsWith('.')) d = d.slice(1);
  }
  return d;
}

// ───────────────────────────────────────────────────────────────────────────
// Parsers
// ───────────────────────────────────────────────────────────────────────────

interface RawCookie {
  [key: string]: unknown;
}

function parseCookieObject(raw: RawCookie): ImportedCookie | null {
  const name = typeof raw.name === 'string' ? raw.name : '';
  // An empty NAME is meaningless; an empty VALUE is legal and common
  // (a cleared session cookie), so only the name is required.
  if (!name) return null;

  const domain = normalizeDomain(raw.domain, raw.hostOnly);
  if (!domain) return null;

  const cookie: ImportedCookie = {
    name,
    value: raw.value === undefined || raw.value === null ? '' : String(raw.value),
    domain,
    path: typeof raw.path === 'string' && raw.path ? raw.path : '/',
    expires: normalizeExpiry(
      raw.expirationDate ?? raw.expires ?? raw.expiry,
      raw.session,
    ),
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    sameSite: normalizeSameSite(raw.sameSite),
  };
  return reconcileSecureSameSite(cookie);
}

/**
 * Netscape cookies.txt:
 *
 *   domain  includeSubdomains  path  secure  expiry  name  value
 *
 * `#HttpOnly_` is a curl extension prefixed onto the domain field. Lines
 * starting with `#` are comments — except that one.
 */
export function parseNetscapeCookies(text: string): { cookies: ImportedCookie[]; skipped: number } {
  const cookies: ImportedCookie[] = [];
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let httpOnly = false;
    let body = trimmed;
    if (body.startsWith('#HttpOnly_')) {
      httpOnly = true;
      body = body.slice('#HttpOnly_'.length);
    } else if (body.startsWith('#')) {
      continue; // real comment
    }

    // Split on tabs when present (the spec), fall back to any whitespace for
    // files that have been through a text editor. The value is the remainder so
    // that a value containing spaces survives the fallback path.
    const parts = body.includes('\t') ? body.split('\t') : body.split(/\s+/);
    if (parts.length < 7) { skipped++; continue; }

    const [domainField, , pathField, secureField, expiryField, nameField] = parts;
    const value = parts.slice(6).join(body.includes('\t') ? '\t' : ' ');

    const cookie = parseCookieObject({
      name: nameField,
      value,
      domain: domainField,
      path: pathField,
      expires: expiryField,
      secure: String(secureField).toUpperCase() === 'TRUE',
      httpOnly,
      // A leading dot in this format means "include subdomains", i.e. NOT host-only.
      hostOnly: !String(domainField).startsWith('.'),
    });

    if (cookie) cookies.push(cookie); else skipped++;
  }

  return { cookies, skipped };
}

function parseOrigins(input: unknown): ImportedOrigin[] {
  if (!Array.isArray(input)) return [];
  const out: ImportedOrigin[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as RawCookie;
    const origin = typeof o.origin === 'string' ? o.origin : '';
    if (!origin) continue;
    const items = Array.isArray(o.localStorage) ? o.localStorage : [];
    out.push({
      origin,
      localStorage: items
        .filter((i): i is { name: string; value: string } =>
          !!i && typeof i === 'object' && typeof (i as RawCookie).name === 'string')
        .map((i) => ({ name: String(i.name), value: String(i.value ?? '') })),
    });
  }
  return out;
}

/**
 * Parse any supported cookie export.
 *
 * Throws CookieImportError only when nothing usable could be found — a caller
 * showing that message to a user should be able to say "this file is not a
 * cookie export", and never "0 cookies imported, no idea why".
 */
export function parseCookieFile(text: string): CookieImportResult {
  const trimmed = text.trim();
  if (!trimmed) throw new CookieImportError('The file is empty.');

  // JSON first: every extension export is JSON except cookies.txt.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new CookieImportError(
        `The file looks like JSON but could not be parsed: ${(e as Error).message}`,
      );
    }

    let list: unknown = parsed;
    let origins: ImportedOrigin[] = [];
    let format: CookieImportResult['format'] = 'cookie-editor';

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as RawCookie;
      list = obj.cookies;
      origins = parseOrigins(obj.origins);
      // storageState is the only shape that carries `origins`.
      if (Array.isArray(obj.origins)) format = 'storage-state';
    }

    if (!Array.isArray(list)) {
      throw new CookieImportError(
        'No cookie array found. Expected a Cookie-Editor/EditThisCookie export, ' +
        'or a Playwright storageState file with a "cookies" array.',
      );
    }

    const cookies: ImportedCookie[] = [];
    let skipped = 0;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') { skipped++; continue; }
      const c = parseCookieObject(entry as RawCookie);
      if (c) cookies.push(c); else skipped++;
    }

    if (cookies.length === 0) {
      throw new CookieImportError(
        `The file was read but contained no usable cookies (${skipped} entries skipped). ` +
        'Every cookie needs at least a "name" and a "domain".',
      );
    }

    return { cookies, origins, format, skipped, domains: distinctDomains(cookies) };
  }

  // Otherwise: Netscape cookies.txt.
  const { cookies, skipped } = parseNetscapeCookies(trimmed);
  if (cookies.length === 0) {
    throw new CookieImportError(
      'Unrecognised file. Supported: Cookie-Editor / EditThisCookie JSON, ' +
      'Playwright storageState JSON, or Netscape cookies.txt.',
    );
  }
  return {
    cookies,
    origins: [],
    format: 'netscape',
    skipped,
    domains: distinctDomains(cookies),
  };
}

function distinctDomains(cookies: ImportedCookie[]): string[] {
  const set = new Set<string>();
  for (const c of cookies) set.add(c.domain.replace(/^\./, ''));
  return [...set].sort();
}

/**
 * Merge imported cookies into an existing storageState.
 *
 * Merge, not replace: a user importing their Instagram cookies must not lose the
 * Google session they built up in the same profile last week. Identity of a
 * cookie is (name, domain, path) — that is what the browser itself uses, so an
 * import of a refreshed session overwrites the stale one instead of duplicating.
 */
export function mergeIntoStorageState(
  existing: { cookies?: unknown; origins?: unknown } | undefined,
  imported: CookieImportResult,
): { cookies: ImportedCookie[]; origins: ImportedOrigin[] } {
  const key = (c: { name: string; domain: string; path: string }) =>
    `${c.name}\u0000${c.domain}\u0000${c.path}`;

  const byKey = new Map<string, ImportedCookie>();

  if (existing && Array.isArray(existing.cookies)) {
    for (const raw of existing.cookies) {
      if (!raw || typeof raw !== 'object') continue;
      const c = parseCookieObject(raw as RawCookie);
      if (c) byKey.set(key(c), c);
    }
  }
  for (const c of imported.cookies) byKey.set(key(c), c);

  const originByUrl = new Map<string, ImportedOrigin>();
  if (existing && Array.isArray(existing.origins)) {
    for (const o of parseOrigins(existing.origins)) originByUrl.set(o.origin, o);
  }
  for (const o of imported.origins) originByUrl.set(o.origin, o);

  return { cookies: [...byKey.values()], origins: [...originByUrl.values()] };
}
