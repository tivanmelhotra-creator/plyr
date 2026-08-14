'use strict';

/**
 * InspectorSocketServer — the push channel that makes a pick feel instant.
 *
 * WHY PUSH AND NOT POLLING
 * ------------------------
 * The user's hands are on the extension: hover, click, tick two attributes,
 * Confirm. Then they look back at the workflow tab and expect the fields to be
 * filled. With polling, "expect" becomes "wait up to the poll interval", which
 * on a 2s poll is long enough to make the user click Confirm a second time and
 * wonder which one landed.
 *
 * A socket also carries the two other things that change without the user
 * doing anything in this tab: their local browser agent connecting or dropping,
 * and a mode fallback. Both are events, and both look like bugs when discovered
 * late ("why did it run on the server? I chose local").
 *
 * The HTTP routes in mode.routes.ts stay as the fallback: a user behind a proxy
 * that eats WebSockets still gets their picks via `GET /inspector/inbox`. This
 * socket makes it fast, it is not the only way through — which is why the
 * inbox in InspectorHub is a real queue and not just a socket buffer.
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { URL } from 'url';

import { authorizeLive } from './LiveServer';
import { reportBrowserMode } from './BrowserMode';
import { inspectorHub, type InspectorDelivery } from './InspectorHub';
import { targetFields } from './TargetFieldRegistry';
import { localBridges } from './LocalBridge';

interface InspectorClient {
  ws: WebSocket;
  userId: string;
}

export class InspectorSocketServer {
  private wss: WebSocketServer;
  private clients = new Set<InspectorClient>();
  private unsubscribeHub: (() => void) | null = null;
  private unsubscribeBridge: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });

    // ONE subscription for the whole server, not one per socket. A per-socket
    // subscription would fan the same delivery out N times and leak a listener
    // for every socket that closed badly.
    this.unsubscribeHub = inspectorHub.subscribe((userId, delivery) => {
      this.sendTo(userId, 'element', { delivery });
    });

    // The agent connecting or dropping is news for a tab that is not doing
    // anything: it changes whether "Local Browser" is even selectable.
    this.unsubscribeBridge = localBridges.onChange((userId, connected) => {
      this.sendTo(userId, connected ? 'bridge.connected' : 'bridge.lost', {
        bridge: localBridges.info(userId),
        ...reportBrowserMode(userId),
      });
    });

    this.setupHeartbeat();
  }

  matches(pathname: string): boolean {
    return pathname === '/inspector/ws';
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname = '';
      try { pathname = new URL(req.url || '', 'http://localhost').pathname; }
      catch { return; }
      // Not ours: return WITHOUT destroying. Destroying here would kill
      // /live/ws, /browser/ws and the agent tunnel, all of which share this port.
      if (!this.matches(pathname)) return;
      this.handleUpgrade(req, socket, head);
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let parsed: URL;
    try { parsed = new URL(req.url || '', 'http://localhost'); }
    catch { socket.destroy(); return; }

    const userId = parsed.searchParams.get('userId') || '';
    const apiKey = parsed.searchParams.get('api_key')
      || (req.headers['x-api-key'] as string | undefined);

    if (!userId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Same gate as every other socket here. This channel carries picked element
    // data — including values read off a logged-in page — so it is not a place
    // for a weaker check.
    authorizeLive(apiKey, userId).then((auth) => {
      if (!auth.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, userId);
      });
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  }

  private send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ t: type, ...data })); } catch { /* ignore */ }
  }

  /** Everything this user has open — a workflow tab and a second window both count. */
  sendTo(userId: string, type: string, data: Record<string, unknown>): void {
    for (const c of this.clients) {
      if (c.userId === userId) this.send(c.ws, type, data);
    }
  }

  private onConnection(ws: WebSocket, userId: string): void {
    const client: InspectorClient = { ws, userId };
    this.clients.add(client);

    // The hello carries the full current state, so a freshly opened (or
    // reconnected) tab renders correctly without a follow-up request — and
    // `pending` replays picks made while it was away, which is what stops a
    // reload from silently eating the element the user just confirmed.
    this.send(ws, 'hello', {
      ...reportBrowserMode(userId),
      bridge: localBridges.info(userId),
      // Every live destination, not one "current" node: several Target Fields
      // coexist, so a single-valued field here would misdescribe the state and
      // the tab would render the wrong one as authoritative.
      targets: targetFields.list(userId),
      pending: inspectorHub.peek(userId),
    });

    const sock = ws as WebSocket & { __alive?: boolean };
    sock.__alive = true;
    ws.on('pong', () => { sock.__alive = true; });

    ws.on('message', (data: RawData) => {
      // Inbound is deliberately tiny: keepalive and acknowledgement. Claiming a
      // node and submitting an element go through the authenticated HTTP routes,
      // so there is exactly one code path that can change routing state.
      let msg: { t?: string; id?: string };
      try { msg = JSON.parse(String(data)) as { t?: string; id?: string }; }
      catch { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'ping') { this.send(ws, 'pong', {}); return; }
      if (msg.t === 'ack' && typeof msg.id === 'string') {
        const ok = inspectorHub.ack(userId, msg.id);
        this.send(ws, 'acked', { id: msg.id, ok });
      }
    });

    const drop = () => { this.clients.delete(client); };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  /**
   * Ping every 30s and terminate anything that did not answer the last one.
   *
   * A half-open socket (laptop lid closed, network changed) stays `OPEN` to Node
   * forever. Without this, deliveries would be written into a socket nobody is
   * reading and the user would conclude the Inspector is broken.
   */
  private setupHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      for (const c of [...this.clients]) {
        const sock = c.ws as WebSocket & { __alive?: boolean };
        if (sock.__alive === false) {
          this.clients.delete(c);
          try { c.ws.terminate(); } catch { /* ignore */ }
          continue;
        }
        sock.__alive = false;
        try { c.ws.ping(); } catch { /* ignore */ }
      }
    }, 30_000);
    // A keepalive timer must never be the reason the process refuses to exit.
    this.heartbeat.unref?.();
  }

  clientCount(userId?: string): number {
    if (!userId) return this.clients.size;
    let n = 0;
    for (const c of this.clients) if (c.userId === userId) n++;
    return n;
  }

  shutdown(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.unsubscribeHub) { this.unsubscribeHub(); this.unsubscribeHub = null; }
    if (this.unsubscribeBridge) { this.unsubscribeBridge(); this.unsubscribeBridge = null; }
    for (const c of [...this.clients]) {
      this.clients.delete(c);
      try { c.ws.close(1001, 'server_shutdown'); } catch { /* ignore */ }
    }
    try { this.wss.close(); } catch { /* ignore */ }
  }
}

/**
 * Tell a user's tabs that their mode changed.
 *
 * Called from the route that performs a switch, so a second window showing the
 * same account does not keep claiming the old mode. A UI that disagrees with the
 * server about which browser will run the next job is a UI that lies.
 */
export function announceModeChange(
  sockets: InspectorSocketServer | null,
  userId: string,
): void {
  if (!sockets) return;
  sockets.sendTo(userId, 'mode', {
    ...reportBrowserMode(userId),
    bridge: localBridges.info(userId),
  });
}

export type { InspectorDelivery };
