/**
 * DesktopProxy — serve the noVNC desktop through the APPLICATION's own port.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Desktop.ts` starts websockify on its own port (default 6080) and the UI
 * used to send the operator to `http://<host>:6080/vnc.html`. That works on a
 * laptop, where every port on the box is reachable. It does NOT work anywhere
 * the app is reached through a single published port — a sandbox, a Cloud Run
 * / Fly / Render deployment, a reverse proxy, or an SSH tunnel that forwarded
 * only one port. MEASURED here: the app is published at
 * `https://3000-<id>.sandbox.novita.ai`; port 6080 has no hostname at all, so
 * "Open desktop" opened a dead tab.
 *
 * That is a hard blocker for the whole "use the REAL browser" feature: if the
 * operator cannot see the desktop, a real Chrome with real extensions is
 * useless to them.
 *
 * WHAT THIS DOES
 * --------------
 * Mounts the desktop under the app's own origin, so exactly one port is ever
 * needed:
 *
 *   GET  /desktop/*            -> static noVNC client (HTML/JS/CSS), proxied
 *                                 from websockify's web root
 *   WS   /desktop/websockify   -> the VNC byte stream itself
 *
 * Both are plain byte-for-byte pipes to 127.0.0.1:<novncPort>. We deliberately
 * do NOT re-implement VNC or RFB; websockify already does that correctly, and
 * a proxy that only moves bytes cannot corrupt a protocol it does not parse.
 *
 * WHY A HAND-ROLLED PROXY AND NOT http-proxy
 * ------------------------------------------
 * `http-proxy` is not a dependency of this project and adding one for ~120
 * lines of `pipe()` is a poor trade. Node's own `http.request` and a raw
 * socket upgrade cover both cases with no new supply chain.
 *
 * SECURITY
 * --------
 * This widens exposure: the desktop is now reachable wherever the app is. The
 * X display holds a Chrome with every cookie the user imported, so it is as
 * sensitive as a shell. Therefore access is gated by the SAME auth as the rest
 * of the API (`authorizeLive`), and the gate is applied to BOTH the HTTP and
 * the WebSocket path — a proxy that authenticated only the HTML page while
 * leaving the socket open would be no gate at all. Setting DESKTOP_VNC_PASSWORD
 * remains strongly recommended as defence in depth.
 */

import http, { type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import net from 'net';

import { config } from '../config';
import { SINGLE_USER_ID } from '../middleware/auth';
import { authorizeLive } from './LiveServer';
import { chromeViewHtml } from './ChromeView';
import { desktopCookieHeader, requestHasDesktopSession } from './DesktopSession';

/** Where the noVNC client and the websockify socket actually live. */
function upstreamPort(): number {
  return config.DESKTOP_NOVNC_PORT;
}

/**
 * How long a single proxied desktop subresource may take before WE answer.
 *
 * Chosen to sit comfortably UNDER the shortest gateway timeout we can expect in
 * front of this app (nginx `proxy_read_timeout` defaults to 60s; Traefik,
 * Coolify and most PaaS ingresses use 30-60s). Whoever times out first owns the
 * error page — and a gateway's page is an HTML body the UI cannot parse, which
 * is how the operator ended up staring at a bare "HTTP 502". By answering at
 * 20s we guarantee the reply is always OUR JSON, with a cause and a next step.
 */
const PROXY_UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Is this request for the desktop?
 *
 * Kept as a method (not a bare string compare at the call site) so the prefix
 * lives in exactly one place and the upgrade multiplexer in index.ts can ask
 * the same question the HTTP layer asks.
 */
export function isDesktopPath(pathname: string): boolean {
  return pathname === '/desktop' || pathname.startsWith('/desktop/');
}

/**
 * Strip our mount prefix so websockify sees the path IT expects.
 *
 * `/desktop/vnc.html` -> `/vnc.html`, `/desktop` -> `/vnc.html` (a bare visit
 * to the mount point should show the client, not a 404 — the operator clicked
 * "Open desktop", they did not ask for a directory listing).
 */
export function upstreamPathFor(pathname: string, search = ''): string {
  if (pathname === '/desktop' || pathname === '/desktop/') return '/vnc.html' + search;
  return pathname.slice('/desktop'.length) + search;
}

/**
 * Is this the bare "just show me Chromium" page?
 *
 * Served by US, not proxied from websockify, because websockify only ships
 * noVNC's own full application (`vnc.html`, 64 UI elements incl. a connect
 * dialog and a control bar) and its `vnc_lite.html` still carries a status bar
 * and a Send-CtrlAltDel button. The user asked for Chromium in a new tab, not
 * for a VNC client to operate. See ChromeView.ts.
 *
 * `/desktop` with no sub-path resolves here too: someone who clicked "open the
 * real browser" wants the browser, not a protocol console.
 */
export function isChromeViewPath(pathname: string): boolean {
  return (
    pathname === '/desktop' ||
    pathname === '/desktop/' ||
    pathname === '/desktop/chrome' ||
    pathname === '/desktop/chrome/'
  );
}

/**
 * Check credentials for a desktop request.
 *
 * The desktop is not per-user (there is one X display), so this only asks "is
 * this caller allowed to drive this server at all". `authorizeLive` is reused
 * so the answer can never drift from the rest of the live surface.
 *
 * Credentials may arrive three ways, and all three are needed:
 *
 *  - a HEADER, for ordinary API calls;
 *  - `?api_key=`, because a browser opening a URL in a NEW TAB cannot set
 *    headers;
 *  - the desktop session COOKIE, because a PAGE cannot set headers on the
 *    subresources it loads either. MEASURED: `core/rfb.js` pulls in 41 further
 *    modules by relative specifier, and a query string on an `import()` is not
 *    inherited by them, so nothing but a cookie can authenticate that graph.
 *    See DesktopSession.ts.
 *
 * The cookie is checked FIRST because it is the cheapest (a local HMAC, no
 * store lookup) and by far the most frequent: one page load authenticates once
 * by key and then dozens of times by cookie.
 */
export async function desktopAuthOk(req: IncomingMessage): Promise<boolean> {
  if (requestHasDesktopSession(req)) return true;

  let url: URL;
  try {
    url = new URL(req.url || '', 'http://localhost');
  } catch {
    return false;
  }
  const headerKey =
    (req.headers['x-api-key'] as string | undefined) ||
    (typeof req.headers.authorization === 'string'
      ? req.headers.authorization.replace(/^Bearer\s+/i, '')
      : undefined);
  const key = headerKey || url.searchParams.get('api_key') || '';
  // One X display, not one per user: SINGLE_USER_ID keeps single-user installs
  // (the common case) working without the caller having to pass ?userId=.
  const userId = url.searchParams.get('userId') || SINGLE_USER_ID;
  try {
    const auth = await authorizeLive(key, userId);
    return auth.ok;
  } catch {
    return false;
  }
}

export class DesktopProxy {
  /**
   * Proxy an ordinary HTTP request (the noVNC HTML, JS, CSS, images).
   *
   * Returns true when it handled the request, so the caller can fall through
   * to the normal Express stack otherwise.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    let pathname = '';
    let search = '';
    try {
      const u = new URL(req.url || '', 'http://localhost');
      pathname = u.pathname;
      search = u.search;
    } catch {
      return false;
    }
    if (!isDesktopPath(pathname)) return false;

    // Claim the request synchronously (so the caller stops), then finish
    // asynchronously once auth resolves.
    //
    // THE .catch() IS LOad-BEARING. This used to be a bare `void this.forward(...)`.
    // Any rejection inside forward() — an auth backend blip, a stream that was
    // torn down under it — therefore escaped as an unhandledRejection, and
    // index.ts turned unhandledRejection into shutdown() -> process.exit(0).
    // A desktop subresource failing could take the ENTIRE SERVER AND ITS PORT
    // with it. A proxy for one optional feature must never be able to do that.
    this.forward(req, res, pathname, search).catch((e) => {
      console.error('[DESKTOP-PROXY] contained request fault:', (e as Error)?.message || e);
      this.failSafe(res, 500, 'desktop_proxy_error');
    });
    return true;
  }

  /**
   * Answer a still-open response without ever throwing.
   *
   * Called from catch blocks and error events, where a second throw would be
   * the unhandled one. Every branch is guarded because by the time we get here
   * the socket may already be gone.
   */
  private failSafe(res: ServerResponse, status: number, error: string, hint = ''): void {
    try {
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error, ...(hint ? { hint } : {}) }));
    } catch {
      try { res.destroy(); } catch { /* already gone */ }
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    search: string,
  ): Promise<void> {
    if (!(await desktopAuthOk(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
      return;
    }

    // Our own page, so there is nothing upstream to ask for. Served after the
    // auth check like everything else: the viewer is as sensitive as the
    // desktop it shows.
    if (isChromeViewPath(pathname)) {
      const body = chromeViewHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        // The page is generated per request and gates on a credential; a cached
        // copy in a shared proxy would outlive the session that earned it.
        'Cache-Control': 'no-store',
        // Hand the caller a session for everything this page is about to load.
        // Issued here, at the one place where a credential has just been proven
        // AND a document (something that can carry a cookie jar) is the reply.
        'Set-Cookie': desktopCookieHeader(req),
      });
      res.end(body);
      return;
    }

    const proxied = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort(),
        method: req.method,
        path: upstreamPathFor(pathname, search),
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort()}` },
      },
      (up) => {
        // UPSTREAM GATEWAY FAILURES ARE TRANSLATED, NOT FORWARDED.
        //
        // websockify answering 502/503/504 means the desktop stack behind it is
        // not ready. Passing that status straight through produced the reported
        // dead end: the UI's error path falls back to a bare `'HTTP ' + status`
        // whenever the body is not our JSON, so the operator was shown
        // "HTTP 502" with no cause and no next step. Replacing it with our own
        // JSON keeps the failure controlled AND keeps it explainable.
        const status = up.statusCode || 0;
        if (status === 502 || status === 503 || status === 504) {
          up.resume(); // drain, or the socket leaks
          this.failSafe(
            res,
            503,
            'desktop_upstream_unavailable',
            `The remote desktop answered ${status}. It is still starting or has stopped; ` +
              'retry, or restart it with POST /api/browser/desktop/start.',
          );
          return;
        }

        // An 'error' on the UPSTREAM RESPONSE has no default listener. Without
        // this, a websockify that dies mid-body raises an uncaughtException,
        // which used to mean process.exit(0).
        up.on('error', (e) => {
          console.error('[DESKTOP-PROXY] upstream stream error:', e.message);
          this.failSafe(res, 502, 'desktop_upstream_stream_error');
        });
        res.on('error', () => { try { up.destroy(); } catch { /* gone */ } });
        // The client hanging up mid-download must not leave the upstream
        // request draining into a dead socket.
        res.on('close', () => { if (!up.readableEnded) { try { up.destroy(); } catch { /* gone */ } } });

        try {
          res.writeHead(status || 502, up.headers);
        } catch (e) {
          this.failSafe(res, 502, 'desktop_upstream_bad_headers');
          try { up.destroy(); } catch { /* gone */ }
          return;
        }
        up.pipe(res);
      },
    );

    // A desktop that accepts the connection and then never answers must not
    // hold a request open until some reverse proxy in front of us gives up and
    // synthesises its own 502/504 HTML page — that page is precisely what the
    // UI cannot parse. We answer first, in our own format.
    proxied.setTimeout(PROXY_UPSTREAM_TIMEOUT_MS, () => {
      try { proxied.destroy(new Error('desktop upstream timeout')); } catch { /* gone */ }
      this.failSafe(
        res,
        504,
        'desktop_upstream_timeout',
        `The remote desktop did not answer within ${Math.round(PROXY_UPSTREAM_TIMEOUT_MS / 1000)}s.`,
      );
    });

    // The INBOUND body can fail independently of the outbound request.
    req.on('error', () => { try { proxied.destroy(); } catch { /* gone */ } });

    // The desktop not running is the COMMON case, not an exception: the
    // operator has to start it. Say so in a way the UI can show, instead of
    // letting an ECONNREFUSED crash the process.
    proxied.on('error', () => {
      this.failSafe(
        res,
        503,
        'desktop_not_running',
        'Start the remote desktop first (POST /api/browser/desktop/start).',
      );
    });

    req.pipe(proxied);
  }

  /** Does this upgrade belong to us? Mirrors BrowserStreamServer.matches(). */
  matches(pathname: string): boolean {
    return isDesktopPath(pathname);
  }

  /**
   * Proxy the WebSocket upgrade that carries the VNC stream.
   *
   * This is a raw TCP splice: we replay the client's upgrade request to
   * websockify verbatim and then join the two sockets. Because websockify
   * answers the handshake itself, the subprotocol negotiation ('binary') and
   * every RFB byte afterwards stay exactly as noVNC and websockify expect —
   * there is no place for this code to corrupt them.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '';
    let search = '';
    try {
      const u = new URL(req.url || '', 'http://localhost');
      pathname = u.pathname;
      search = u.search;
    } catch {
      socket.destroy();
      return;
    }

    // Sockets raise errors asynchronously and this one has no listener yet, so
    // attach before anything can fail. Without it, an upgrade that dies during
    // the auth round trip became an uncaughtException — i.e. a dead server.
    socket.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });

    // `.catch()` for the same reason as handleRequest(): a rejected auth check
    // on a fire-and-forget promise used to be a whole-process shutdown.
    desktopAuthOk(req)
      .then((ok) => {
        if (!ok) {
          try {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          } catch { /* gone */ }
          socket.destroy();
          return;
        }
        this.splice(req, socket, head, pathname, search);
      })
      .catch((e) => {
        console.error('[DESKTOP-PROXY] contained upgrade fault:', (e as Error)?.message || e);
        try {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        } catch { /* gone */ }
        try { socket.destroy(); } catch { /* gone */ }
      });
  }

  private splice(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pathname: string,
    search: string,
  ): void {
    const upstream = net.connect(upstreamPort(), '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      upstream.write(
        `GET ${upstreamPathFor(pathname, search)} HTTP/1.1\r\n${headers}\r\n\r\n`,
      );
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    // Either end dying must take the other with it, or we leak a half-open
    // pair per failed connect — and the operator retries a lot while getting
    // the desktop up.
    const bin = (): void => {
      try { upstream.destroy(); } catch { /* already gone */ }
      try { socket.destroy(); } catch { /* already gone */ }
    };
    upstream.on('error', bin);
    socket.on('error', bin);
    upstream.on('close', bin);
    socket.on('close', bin);
  }
}
