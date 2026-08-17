/**
 * PublicBaseUrl — the address the operator should type into the extension.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Pairing needs TWO facts, and until now the dialog only showed one. The
 * Authorization Code was displayed prominently; the Base URL — the thing the
 * code is useless without — was left for the operator to work out. On a laptop
 * that guess is `http://localhost:3000` and usually right. On a VPS, behind
 * Cloudflare, in Docker or in a Codespace it is none of those, and the operator
 * gets an extension that reports "cannot connect" while the server insists a
 * valid code is waiting. Nothing is broken; the two halves simply never met.
 *
 * The owner's requirement, verbatim: «در کنار کد اتورایز بیس یو ار ال هم اگر
 * قبلا دامین ست کرده اونو میایس و قابل کپی نمایش میدیم یا ایپی و پورت اربر رو»
 * — beside the authorize code, show the configured domain if there is one, and
 * otherwise the server's IP and port.
 *
 * WHY A SEPARATE MODULE RATHER THAN A FEW LINES IN THE ROUTE
 * ---------------------------------------------------------
 * Because "which address" has an order of precedence, and precedence is exactly
 * the kind of logic that rots when it is inlined at two call sites (this repo
 * already issues codes from two routes). Kept here it is one testable function,
 * and both routes are guaranteed to advertise the same address.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not call out to an external "what is my IP" service. That would be a
 * silent network dependency inside a request the operator is waiting on, it
 * fails closed on an air-gapped or firewalled host, and it would report the
 * NAT's address — which is frequently not where the server is reachable. A
 * detected LAN address that the operator can visibly correct is more honest
 * than a public address that looks authoritative and is wrong. That is why the
 * result carries `source`.
 */
import os from 'os';

/** Where the advertised address came from — surfaced so the UI can qualify it. */
export type BaseUrlSource =
  /** The operator configured PUBLIC_DOMAIN / BASE_URL. Trustworthy. */
  | 'configured'
  /** Derived from the request's own Host header — the address that reached us. */
  | 'request'
  /** A network interface on this host. A good guess, not a promise. */
  | 'detected'
  /** Nothing better was available. */
  | 'loopback';

export interface BaseUrlResult {
  /** The full origin, with scheme and without a trailing slash. */
  baseUrl: string;
  source: BaseUrlSource;
}

/**
 * The shape of an incoming request this module needs. Kept minimal so the
 * resolver can be unit-tested without constructing an Express request.
 */
export interface RequestHints {
  /** The Host header as received (may include a port). */
  host?: string | undefined;
  /** X-Forwarded-Host, if a proxy set it. */
  forwardedHost?: string | undefined;
  /** X-Forwarded-Proto, if a proxy set it. */
  forwardedProto?: string | undefined;
  /** Whether the connection itself was TLS. */
  encrypted?: boolean | undefined;
}

/**
 * Turn whatever the operator typed into an origin.
 *
 * Operators write `example.com`, `https://example.com`, `example.com/`, and
 * occasionally `https://example.com/panel`. All four mean the same server, and
 * refusing three of them would make a correctly-configured domain look broken.
 * A bare host is assumed https:// — a custom domain served over plain http is
 * rare enough that guessing the secure scheme is right far more often, and an
 * operator who needs http can say so explicitly.
 */
export function normalizeConfiguredDomain(raw: string | undefined | null): string {
  const value = (raw || '').trim();
  if (!value) return '';

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    // Unparseable. Returning '' means "not configured", so resolution falls
    // through to detection rather than advertising a broken address.
    return '';
  }
  if (!url.hostname) return '';
  // Only http(s) can be typed into the extension's Base URL field.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  // `origin` drops any path, query and fragment, and omits the default port —
  // which is what we want: https://example.com, never https://example.com:443/x.
  return url.origin;
}

/**
 * A LAN address for this host, or '' if none could be found.
 *
 * Prefers IPv4: it is what an operator can retype without mistakes, and the
 * extension's Base URL field is typed by hand. IPv6 link-local addresses carry
 * a zone index (`%eth0`) that is meaningless on the client machine anyway.
 */
export function detectLanAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const candidates: string[] = [];
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const net of list) {
      if (net.internal) continue;              // loopback is not reachable from elsewhere
      // Node has reported `family` as both the string 'IPv4' and the number 4
      // across versions; accepting either avoids a silent "no address found"
      // on whichever runtime the operator happens to have.
      if (net.family !== 'IPv4' && net.family !== (4 as unknown as string)) continue;
      if (!net.address) continue;
      // 169.254/16 is what an interface gets when DHCP failed. It is not an
      // address anyone can reach us on, so advertising it would be worse than
      // admitting we do not know.
      if (net.address.startsWith('169.254.')) continue;
      candidates.push(net.address);
    }
  }
  return candidates[0] || '';
}

/**
 * Does this host string already carry an explicit port?
 *
 * The subtlety is the BARE IPv6 literal. `[::1]:3000` is unambiguous, but a
 * Host header or a config value can also arrive as plain `::1`, where the
 * trailing `:1` looks exactly like a port and is not one. So an unbracketed
 * host is only treated as having a port when it contains a SINGLE colon —
 * anything with more is an IPv6 address, which must never be split.
 */
function hasPort(host: string): boolean {
  // IPv6 literals are bracketed, so a colon inside brackets is not a port.
  if (host.startsWith('[')) return /\]:\d+$/.test(host);
  if (host.split(':').length > 2) return false;   // bare IPv6, no port
  return /:\d+$/.test(host);
}

/**
 * Decide the Base URL to advertise.
 *
 * PRECEDENCE, and why it is this way round:
 *
 *   1. PUBLIC_DOMAIN / BASE_URL — the operator told us. Nothing we can detect
 *      beats being told, and this is the case that matters most: a Cloudflare
 *      domain is unguessable from inside the container.
 *   2. The request's own Host — the panel is being served from an address the
 *      operator's browser demonstrably reached. If they can reach it, their
 *      extension probably can too, and it already accounts for reverse proxies,
 *      port mappings and tunnels that no amount of interface-sniffing would
 *      reveal. Skipped when the panel is on localhost, because "localhost"
 *      means something different in the extension's browser on another machine.
 *   3. A detected LAN address plus the listening port — the classic
 *      «IP و پورت سرور» case.
 *   4. Loopback, plainly labelled. Correct for a laptop, and honest everywhere.
 */
export function resolveBaseUrl(opts: {
  configuredDomain?: string | undefined;
  port: number;
  request?: RequestHints | undefined;
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]> | undefined;
}): BaseUrlResult {
  const configured = normalizeConfiguredDomain(opts.configuredDomain);
  if (configured) return { baseUrl: configured, source: 'configured' };

  const req = opts.request;
  if (req) {
    // A proxy's X-Forwarded-Host is preferred over Host, because behind a
    // reverse proxy Host is often the internal upstream (127.0.0.1:3000) while
    // the forwarded value is the name the operator actually used.
    const rawHost = (req.forwardedHost || req.host || '').trim();
    // A comma-separated chain means several proxies appended to it; the first
    // entry is the client-facing name.
    const host = rawHost.split(',')[0]!.trim();
    if (host && !isLoopbackHost(host)) {
      const proto = (req.forwardedProto || '').split(',')[0]!.trim().toLowerCase()
        || (req.encrypted ? 'https' : 'http');
      const scheme = proto === 'https' ? 'https' : 'http';
      // The Host header carries its own port when there is one, so appending
      // opts.port here would produce `example.com:3000:3000`.
      return { baseUrl: scheme + '://' + host, source: 'request' };
    }
  }

  const lan = detectLanAddress(opts.interfaces);
  if (lan) return { baseUrl: 'http://' + lan + ':' + opts.port, source: 'detected' };

  return { baseUrl: 'http://localhost:' + opts.port, source: 'loopback' };
}

/** Is this host name one that only means anything on the machine itself? */
export function isLoopbackHost(hostWithPort: string): boolean {
  let host = hostWithPort.trim().toLowerCase();
  if (!host) return true;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    host = close > 0 ? host.slice(1, close) : host.slice(1);
  } else if (hasPort(host)) {
    host = host.slice(0, host.lastIndexOf(':'));
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // The whole 127/8 block, not just 127.0.0.1: dev setups use 127.0.0.2 and
  // similar, and they are just as unreachable from another machine.
  //
  // Anchored to a full dotted-quad rather than a `127.` prefix, because
  // `127.example.com` is a perfectly ordinary hostname and a prefix test would
  // silently discard it — sending the operator to a detected LAN address when
  // the real, working one was right there in the Host header.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 0.0.0.0 is a bind address, never a destination.
  if (host === '0.0.0.0' || host === '::') return true;
  return false;
}

/** Pull the hints this module needs out of an Express-shaped request. */
export function requestHints(req: {
  headers?: Record<string, unknown>;
  socket?: { encrypted?: boolean };
}): RequestHints {
  const h = req.headers || {};
  const one = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
  return {
    host: one(h['host']),
    forwardedHost: one(h['x-forwarded-host']),
    forwardedProto: one(h['x-forwarded-proto']),
    encrypted: !!(req.socket && req.socket.encrypted),
  };
}
