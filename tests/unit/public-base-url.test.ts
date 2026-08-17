/**
 * public-base-url.test.ts — which address the operator is told to type in.
 *
 * WHAT IS AT STAKE
 * ----------------
 * Pairing needs the Authorization Code AND the Base URL. The code was always
 * shown; the address was left to be guessed, and the failure it produces is the
 * confusing kind: the extension reports that it cannot connect while the panel
 * insists a valid code is waiting. Nothing is broken — the two halves never met.
 *
 * So the value under test is a STRING THE OPERATOR WILL RETYPE INTO ANOTHER
 * APPLICATION. The dangerous outcome is not a crash, it is a plausible-looking
 * address that is wrong: `https://example.com:3000` when the domain is behind a
 * proxy on 443, `http://169.254.x.x:3000` from an interface whose DHCP failed,
 * or `http://localhost:3000` handed to an extension running on another machine.
 * Every test here pins one of those.
 *
 * Interfaces are injected rather than read from the host, because a test that
 * calls os.networkInterfaces() asserts the CI runner's network and would pass or
 * fail for reasons unrelated to the code.
 */
import { describe, it, expect, vi } from 'vitest';
import type os from 'os';
import {
  resolveBaseUrl,
  normalizeConfiguredDomain,
  detectLanAddress,
  isLoopbackHost,
  requestHints,
} from '../../src/core/PublicBaseUrl';

/** Build the shape os.networkInterfaces() returns, with only the fields read. */
function ifaces(
  entries: Array<{ name: string; address: string; family?: string; internal?: boolean }>,
): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  const out: Record<string, os.NetworkInterfaceInfo[]> = {};
  for (const e of entries) {
    (out[e.name] ||= []).push({
      address: e.address,
      family: (e.family || 'IPv4') as 'IPv4',
      internal: !!e.internal,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: null,
    } as os.NetworkInterfaceInfo);
  }
  return out;
}

const NO_IFACES = ifaces([]);

describe('PUBLIC_DOMAIN: whatever the operator typed becomes an origin', () => {
  it('accepts a bare host and assumes https', () => {
    // Operators write what is in their DNS panel, which has no scheme. Rejecting
    // it would make a correctly-configured domain look broken.
    expect(normalizeConfiguredDomain('example.com')).toBe('https://example.com');
  });

  it('keeps an explicit http:// rather than upgrading it', () => {
    // Guessing https for someone who deliberately wrote http would advertise a
    // port that is not listening.
    expect(normalizeConfiguredDomain('http://box.lan:8080')).toBe('http://box.lan:8080');
  });

  it('keeps an explicit port', () => {
    expect(normalizeConfiguredDomain('https://example.com:8443')).toBe('https://example.com:8443');
  });

  it('drops the default port so the address stays readable', () => {
    // https://example.com:443 is correct and looks like a mistake; the operator
    // then "fixes" it and breaks it.
    expect(normalizeConfiguredDomain('https://example.com:443')).toBe('https://example.com');
    expect(normalizeConfiguredDomain('http://example.com:80')).toBe('http://example.com');
  });

  it('discards a path, query and fragment', () => {
    // The extension wants an ORIGIN. A pasted panel URL is the likeliest input,
    // and `https://example.com/dashboard` as a Base URL yields 404s on every
    // API call — a failure that looks nothing like its cause.
    expect(normalizeConfiguredDomain('https://example.com/dashboard?x=1#y'))
      .toBe('https://example.com');
  });

  it('tolerates surrounding whitespace and a trailing slash', () => {
    expect(normalizeConfiguredDomain('  https://example.com/  ')).toBe('https://example.com');
  });

  it('treats empty, blank and undefined as "not configured"', () => {
    expect(normalizeConfiguredDomain('')).toBe('');
    expect(normalizeConfiguredDomain('   ')).toBe('');
    expect(normalizeConfiguredDomain(undefined)).toBe('');
    expect(normalizeConfiguredDomain(null)).toBe('');
  });

  it('refuses a scheme the extension cannot use', () => {
    // Falling through to detection is right: an address the extension can never
    // reach is worse than one it might.
    expect(normalizeConfiguredDomain('ftp://example.com')).toBe('');
    expect(normalizeConfiguredDomain('ws://example.com')).toBe('');
  });

  it('refuses unparseable junk instead of advertising it', () => {
    expect(normalizeConfiguredDomain('https://')).toBe('');
    expect(normalizeConfiguredDomain('://')).toBe('');
  });

  it('handles an IPv6 literal', () => {
    expect(normalizeConfiguredDomain('http://[2001:db8::1]:3000'))
      .toBe('http://[2001:db8::1]:3000');
  });
});

describe('interface detection: a guess worth showing, or none', () => {
  it('returns an external IPv4 address', () => {
    expect(detectLanAddress(ifaces([
      { name: 'lo', address: '127.0.0.1', internal: true },
      { name: 'eth0', address: '192.168.1.50' },
    ]))).toBe('192.168.1.50');
  });

  it('never returns loopback, because nobody else can reach it', () => {
    expect(detectLanAddress(ifaces([
      { name: 'lo', address: '127.0.0.1', internal: true },
    ]))).toBe('');
  });

  it('skips a link-local address from a failed DHCP lease', () => {
    // 169.254/16 means "no network configuration succeeded". Advertising it
    // sends the operator to an address that cannot work, and looks
    // authoritative while doing it.
    expect(detectLanAddress(ifaces([
      { name: 'eth0', address: '169.254.9.9' },
    ]))).toBe('');
  });

  it('prefers IPv4 over IPv6, because it gets retyped by hand', () => {
    expect(detectLanAddress(ifaces([
      { name: 'eth0', address: '2001:db8::5', family: 'IPv6' },
      { name: 'eth1', address: '10.0.0.7' },
    ]))).toBe('10.0.0.7');
  });

  it('returns nothing rather than something unusable on a host with no NIC', () => {
    expect(detectLanAddress(NO_IFACES)).toBe('');
  });
});

describe('loopback recognition', () => {
  it('knows the names that only mean anything locally', () => {
    for (const h of [
      'localhost', 'localhost:3000', 'app.localhost',
      '127.0.0.1', '127.0.0.1:3000', '127.0.0.2',
      '[::1]:3000', '::1', '0.0.0.0', '0.0.0.0:3000', '',
    ]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('does not mistake a real host for loopback', () => {
    for (const h of [
      'example.com', 'example.com:3000', '192.168.1.5:3000',
      '10.0.0.1', '[2001:db8::1]:3000', 'my-localhost-app.com',
    ]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('does not treat 127-lookalikes as loopback', () => {
    // A `startsWith('127.')` test would swallow this perfectly ordinary
    // hostname, discarding a working Host header in favour of a detected guess.
    expect(isLoopbackHost('127.example.com')).toBe(false);
    expect(isLoopbackHost('12.7.0.1')).toBe(false);
  });

  it('does not read the tail of a bare IPv6 address as a port', () => {
    // `::1` ends in `:1`, which looks exactly like a port and is not one.
    // Splitting there leaves `:` and the address stops being recognised.
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackHost('2001:db8::1')).toBe(false);
  });
});

describe('resolveBaseUrl: precedence', () => {
  it('prefers the configured domain over everything it could detect', () => {
    // The case that matters most: a Cloudflare domain is unguessable from
    // inside the container, so being told must beat every detection.
    const r = resolveBaseUrl({
      configuredDomain: 'panel.example.com',
      port: 3000,
      request: { host: '10.0.0.9:3000' },
      interfaces: ifaces([{ name: 'eth0', address: '10.0.0.9' }]),
    });
    expect(r.baseUrl).toBe('https://panel.example.com');
    expect(r.source).toBe('configured');
  });

  it('does not append the listening port to a configured domain', () => {
    // Behind a proxy the domain answers on 443 while the app listens on 3000.
    // `https://example.com:3000` is the single most plausible wrong answer here.
    const r = resolveBaseUrl({ configuredDomain: 'example.com', port: 3000 });
    expect(r.baseUrl).toBe('https://example.com');
  });

  it('falls back to the Host the panel was actually reached on', () => {
    // If the operator's browser reached us there, their extension probably can
    // too — and it accounts for proxies and port mappings we cannot see.
    const r = resolveBaseUrl({
      port: 3000,
      request: { host: 'panel.example.com' },
      interfaces: ifaces([{ name: 'eth0', address: '10.0.0.9' }]),
    });
    expect(r.baseUrl).toBe('http://panel.example.com');
    expect(r.source).toBe('request');
  });

  it('keeps the port that came in the Host header, without doubling it', () => {
    const r = resolveBaseUrl({ port: 3000, request: { host: 'box.lan:8080' } });
    expect(r.baseUrl).toBe('http://box.lan:8080');
  });

  it('honours a proxy that terminated TLS', () => {
    // X-Forwarded-Proto is the only evidence available: the hop to us is plain
    // http, so guessing from the socket would advertise http:// for an
    // https-only domain and every request would be redirected or refused.
    const r = resolveBaseUrl({
      port: 3000,
      request: { host: 'panel.example.com', forwardedProto: 'https' },
    });
    expect(r.baseUrl).toBe('https://panel.example.com');
  });

  it('prefers X-Forwarded-Host over the internal upstream Host', () => {
    // Behind a reverse proxy, Host is frequently 127.0.0.1:3000 while the
    // forwarded value is the name the operator typed.
    const r = resolveBaseUrl({
      port: 3000,
      request: {
        host: '127.0.0.1:3000',
        forwardedHost: 'panel.example.com',
        forwardedProto: 'https',
      },
    });
    expect(r.baseUrl).toBe('https://panel.example.com');
    expect(r.source).toBe('request');
  });

  it('takes the client-facing entry from a chain of proxies', () => {
    const r = resolveBaseUrl({
      port: 3000,
      request: {
        forwardedHost: 'panel.example.com, internal.svc',
        forwardedProto: 'https, http',
      },
    });
    expect(r.baseUrl).toBe('https://panel.example.com');
  });

  it('uses https when the connection itself was TLS', () => {
    const r = resolveBaseUrl({
      port: 3000,
      request: { host: 'panel.example.com', encrypted: true },
    });
    expect(r.baseUrl).toBe('https://panel.example.com');
  });

  it('ignores a loopback Host and detects an address instead', () => {
    // THE CENTRAL CASE. The panel open at localhost:3000 says nothing about
    // where the extension — in a different browser, often on a different
    // machine — should send the code. "localhost" there means the extension's
    // own machine.
    const r = resolveBaseUrl({
      port: 3000,
      request: { host: 'localhost:3000' },
      interfaces: ifaces([
        { name: 'lo', address: '127.0.0.1', internal: true },
        { name: 'eth0', address: '192.168.1.50' },
      ]),
    });
    expect(r.baseUrl).toBe('http://192.168.1.50:3000');
    expect(r.source).toBe('detected');
  });

  it('advertises the port the server is actually listening on', () => {
    // Detected addresses carry no port of their own, so this is where a
    // hard-coded 3000 would silently produce an unreachable address.
    const r = resolveBaseUrl({
      port: 8123,
      interfaces: ifaces([{ name: 'eth0', address: '192.168.1.50' }]),
    });
    expect(r.baseUrl).toBe('http://192.168.1.50:8123');
  });

  it('falls back to loopback, labelled as such', () => {
    // Correct on a laptop, and the label is what stops it looking like a
    // server-wide address.
    const r = resolveBaseUrl({ port: 3000, interfaces: NO_IFACES });
    expect(r.baseUrl).toBe('http://localhost:3000');
    expect(r.source).toBe('loopback');
  });

  it('never returns an empty or trailing-slash address', () => {
    // Both would be pasted straight into the extension. A trailing slash makes
    // every joined path a double slash.
    const cases = [
      { configuredDomain: 'example.com/', port: 3000 },
      { port: 3000, request: { host: 'box.lan' } },
      { port: 3000, interfaces: ifaces([{ name: 'eth0', address: '10.1.2.3' }]) },
      { port: 3000, interfaces: NO_IFACES },
    ];
    for (const c of cases) {
      const r = resolveBaseUrl(c);
      expect(r.baseUrl).toBeTruthy();
      expect(r.baseUrl.endsWith('/')).toBe(false);
      expect(r.baseUrl).toMatch(/^https?:\/\/.+/);
    }
  });

  it('reports a source for every branch, so the UI can qualify the address', () => {
    expect(resolveBaseUrl({ configuredDomain: 'e.com', port: 1 }).source).toBe('configured');
    expect(resolveBaseUrl({ port: 1, request: { host: 'e.com' } }).source).toBe('request');
    expect(resolveBaseUrl({
      port: 1, interfaces: ifaces([{ name: 'eth0', address: '10.0.0.1' }]),
    }).source).toBe('detected');
    expect(resolveBaseUrl({ port: 1, interfaces: NO_IFACES }).source).toBe('loopback');
  });
});

describe('requestHints: reading an Express request safely', () => {
  it('pulls the headers it needs', () => {
    const h = requestHints({
      headers: { host: 'a.com', 'x-forwarded-host': 'b.com', 'x-forwarded-proto': 'https' },
      socket: { encrypted: true },
    });
    expect(h).toEqual({
      host: 'a.com', forwardedHost: 'b.com', forwardedProto: 'https', encrypted: true,
    });
  });

  it('survives a request with no headers or socket at all', () => {
    // Never throw inside code-issuance: an exception here would turn a working
    // pairing into a 500 for the sake of a display string.
    expect(() => requestHints({})).not.toThrow();
    const h = requestHints({});
    expect(h.host).toBeUndefined();
    expect(h.encrypted).toBe(false);
  });

  it('takes the first value when a header arrived more than once', () => {
    const h = requestHints({ headers: { host: ['a.com', 'b.com'] } });
    expect(h.host).toBe('a.com');
  });

  it('ignores a non-string header value', () => {
    const h = requestHints({ headers: { host: 42 } });
    expect(h.host).toBeUndefined();
  });
});

describe('config: PUBLIC_DOMAIN and its synonym', () => {
  /**
   * Load a pristine config under a controlled environment.
   *
   * Reads the REAL module rather than mocking it, because the thing under test
   * IS the resolution of process.env into config — a mock would assert my own
   * stub. The variables are saved and restored so a value in the developer's
   * own shell cannot make this pass or fail.
   */
  async function loadConfig(env: Record<string, string | undefined>) {
    vi.resetModules();
    const keys = ['PUBLIC_DOMAIN', 'BASE_URL'];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
      return (await import('../../src/config')).config;
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
      vi.resetModules();
    }
  }

  it('is empty when the operator set nothing', async () => {
    // Empty must mean "detect for me", not the literal string "undefined".
    const c = await loadConfig({});
    expect(c.PUBLIC_DOMAIN).toBe('');
  });

  it('reads PUBLIC_DOMAIN', async () => {
    const c = await loadConfig({ PUBLIC_DOMAIN: 'https://panel.example.com' });
    expect(c.PUBLIC_DOMAIN).toBe('https://panel.example.com');
  });

  it('accepts BASE_URL as a synonym', async () => {
    // That is the name on the extension's own field, so it is the word an
    // operator reaches for after reading it there.
    const c = await loadConfig({ BASE_URL: 'https://panel.example.com' });
    expect(c.PUBLIC_DOMAIN).toBe('https://panel.example.com');
  });

  it('lets PUBLIC_DOMAIN win when both are set', async () => {
    const c = await loadConfig({
      PUBLIC_DOMAIN: 'https://a.example.com',
      BASE_URL: 'https://b.example.com',
    });
    expect(c.PUBLIC_DOMAIN).toBe('https://a.example.com');
  });

  it('strips a trailing comment, as every other variable here does', async () => {
    const c = await loadConfig({ PUBLIC_DOMAIN: 'https://a.example.com  # my domain' });
    expect(c.PUBLIC_DOMAIN).toBe('https://a.example.com');
  });
});
