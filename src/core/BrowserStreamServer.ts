'use strict';

import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { URL } from 'url';

import { LiveBrowserManager, LiveBrowserSession } from './LiveBrowser';
import { authorizeLive } from './LiveServer';

// ════════════════════════════════════════════════════════════════
// BrowserStreamServer (Step 12) — WebSocket endpoint /browser/ws.
// ----------------------------------------------------------------
// Each connection owns one interactive LiveBrowserSession. Outbound:
// JSON control events + binary-ish JSON screencast frames (base64).
// Inbound: JSON commands { t: 'navigate'|'click'|'move'|'type'|'key'|
// 'scroll'|'picker'|'pickStep'|'verify', ... } which are replayed on
// the server browser.
//
// Auth re-uses authorizeLive (same rules as the live event channel):
// env/admin key => full access; user key => must own the userId.
// This server does NOT register its own 'upgrade' listener; index.ts
// multiplexes /live/ws and /browser/ws through one handler and calls
// handleUpgrade() here. That avoids two listeners both destroying
// sockets they don't recognise.
// ════════════════════════════════════════════════════════════════

export class BrowserStreamServer {
  private wss: WebSocketServer;
  constructor(private readonly manager: LiveBrowserManager) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  // Does this upgrade request belong to us?
  matches(pathname: string): boolean {
    return pathname === '/browser/ws';
  }

  // Register an 'upgrade' listener that ONLY handles /browser/ws and
  // ignores (returns without destroying) any other path, so it can
  // coexist with LiveServer's own upgrade listener on the same server.
  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname = '';
      try { pathname = new URL(req.url || '', 'http://localhost').pathname; }
      catch { return; }
      if (!this.matches(pathname)) return; // not ours; LiveServer may handle it
      this.handleUpgrade(req, socket, head);
    });
  }

  // Called by the multiplexed upgrade handler in index.ts.
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let parsed: URL;
    try {
      parsed = new URL(req.url || '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const userId = parsed.searchParams.get('userId') || '';
    const apiKey = parsed.searchParams.get('api_key')
      || (req.headers['x-api-key'] as string | undefined);

    if (!userId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    authorizeLive(apiKey, userId).then((auth) => {
      if (!auth.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.onConnection(ws, userId);
      });
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  }

  private send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: type, ...data })); } catch { /* ignore */ }
    }
  }

  private async onConnection(ws: WebSocket, userId: string): Promise<void> {
    let session: LiveBrowserSession;
    try {
      session = this.manager.create(userId);
    } catch (e) {
      this.send(ws, 'error', { message: (e as Error).message });
      try { ws.close(1011, 'no_session'); } catch { /* ignore */ }
      return;
    }

    // Wire session output to this socket.
    session.setSinks(
      (frame) => this.send(ws, 'frame', { ...frame }),
      (type, data) => this.send(ws, type, data)
    );

    // Heartbeat.
    const sock = ws as WebSocket & { __alive?: boolean };
    sock.__alive = true;
    ws.on('pong', () => { sock.__alive = true; });

    const cleanup = async () => {
      await this.manager.destroy(session.id).catch(() => {});
    };
    ws.on('close', () => { void cleanup(); });
    ws.on('error', () => { /* close handler cleans up */ });

    // ════════════════════════════════════════════════════════════════
    // The message listener is attached BEFORE `session.start()`, and
    // anything that arrives while the browser is still booting is
    // QUEUED instead of dropped.
    //
    // WHY: `session.start()` launches a context + page + CDP screencast,
    // which takes ~300-900 ms. The client sends its first command from
    // `ws.onopen` — for the Element Picker window that command is the
    // `navigate` carrying the URL the user typed (browser-view.js
    // `connect()`). `ws` only delivers frames to listeners registered at
    // the time they arrive, so with the listener attached after `start()`
    // that first navigate was silently thrown away: the picker window
    // opened on `about:blank`, the address never loaded, and the only
    // symptom was a black stage — no error anywhere.
    // ════════════════════════════════════════════════════════════════
    let started = false;
    const pending: Array<{ t?: string; [k: string]: unknown }> = [];
    ws.on('message', (raw: RawData) => {
      let msg: { t?: string; [k: string]: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (!started) {
        // Cap the queue: a client that spams while we boot must not grow
        // an unbounded buffer. 50 is far more than a real open sends.
        if (pending.length < 50) pending.push(msg);
        return;
      }
      void this.handleCommand(session, msg);
    });

    // Start the browser session (creates context/page + screencast).
    try {
      await session.start();
    } catch (e) {
      this.send(ws, 'error', { message: 'browser_unavailable: ' + (e as Error).message });
      await cleanup();
      try { ws.close(1011, 'browser_unavailable'); } catch { /* ignore */ }
      return;
    }

    started = true;
    // Replay in arrival order, sequentially: `navigate` then `picker` must
    // not race, or the picker script is injected into the page we are
    // leaving.
    for (const msg of pending.splice(0)) {
      if (session.isClosed()) break;
      await this.handleCommand(session, msg).catch(() => {});
    }
  }

  private async handleCommand(
    session: LiveBrowserSession,
    msg: { t?: string; [k: string]: unknown }
  ): Promise<void> {
    if (session.isClosed()) return;
    const num = (v: unknown, d = 0): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    switch (msg.t) {
      case 'navigate':
        await session.navigate(String(msg.url || ''));
        break;
      // History. The picker window browses for real, so it needs the controls a
      // browser has; without Back, following a link into the wrong page left
      // retyping the URL as the only way out.
      case 'back':
        await session.back();
        break;
      case 'forward':
        await session.forward();
        break;
      case 'reload':
        await session.reload();
        break;
      case 'click':
        await session.click(num(msg.x), num(msg.y));
        break;
      case 'move':
        await session.move(num(msg.x), num(msg.y));
        break;
      case 'scroll':
        await session.scroll(num(msg.x), num(msg.y), num(msg.dy));
        break;
      case 'type':
        await session.type(String(msg.text || ''));
        break;
      case 'key':
        await session.key(String(msg.key || ''));
        break;
      case 'picker':
        await session.setPicker(!!msg.on);
        break;
      // Element-picker refinements (the ↑/↓ arrows and the double-check button
      // in the picker panel). Both answer on the picker's own channels.
      case 'pickStep':
        await session.pickStep(String(msg.dir || 'up'));
        break;
      case 'verify':
        await session.verifySelector(String(msg.selector || ''));
        break;
      // "Forget this browser session": deletes the saved cookies so the next
      // open starts anonymous again.
      case 'forgetSession':
        await session.forgetSession();
        break;
      default:
        // unknown command: ignore
        break;
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.wss.clients.forEach((ws) => { try { ws.close(1001, 'shutdown'); } catch { /* ignore */ } });
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    } catch { /* ignore */ }
    await this.manager.shutdown().catch(() => {});
  }
}
