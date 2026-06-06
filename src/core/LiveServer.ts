'use strict';

import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import IORedis from 'ioredis';
import { URL } from 'url';

import { config } from '../config';
import { LiveBus } from './LiveBus';
import { getApiKeyManager } from '../middleware/auth';
import { getLiveChannel } from '../utils/redis-keys';
import { verifyShareToken } from './StepReporter';

// ================================================================
// LiveServer (Step 16) - WebSocket fan-out for live job events.
// ----------------------------------------------------------------
// One Redis subscriber connection (psubscribe on "live:ch:*") feeds
// every connected WebSocket. Each socket is authenticated by API key
// (query param) and bound to a single (userId, jobId) channel. On
// connect we replay the recent buffer so late subscribers catch up.
// This design is PM2-cluster safe: the worker publishes to Redis and
// any web instance fans out to its own sockets.
// ================================================================

interface LiveClient {
  ws: WebSocket;
  userId: string;
  jobId: string;
  channel: string;
}

// Validate an API key + ensure it owns the requested userId (or is admin).
export interface LiveAuthResult {
  ok: boolean;
  reason?: string;
}

export const authorizeLive = async (
  apiKey: string | undefined,
  userId: string,
  opts?: { share?: string | undefined; jobId?: string | undefined }
): Promise<LiveAuthResult> => {
  // Step 29: a valid signed share token grants read-only live access to
  // exactly the (userId, jobId) it was minted for — no API key required.
  // This is what makes the live-view link shareable.
  if (opts?.share && config.LIVE_SHARE_SECRET) {
    const v = verifyShareToken(opts.share, config.LIVE_SHARE_SECRET);
    if (v.ok && v.parts
        && String(v.parts.userId) === String(userId)
        && (!opts.jobId || String(v.parts.jobId) === String(opts.jobId))) {
      return { ok: true };
    }
    // A share token was supplied but did not check out: fall through to
    // API-key auth so a legitimate owner can still connect.
  }
  // If auth is globally disabled, allow (dev/self-hosted convenience).
  if (!config.API_KEYS_ENABLED) {
    return { ok: true };
  }
  if (!apiKey) {
    return { ok: false, reason: 'missing_api_key' };
  }
  // Env (admin) key: full access.
  if (config.API_KEYS.has(apiKey)) {
    return { ok: true };
  }
  const mgr = getApiKeyManager();
  if (!mgr) {
    return { ok: false, reason: 'auth_unavailable' };
  }
  const res = await mgr.validateAndGetOwner(apiKey);
  if (!res.valid) {
    return { ok: false, reason: 'invalid_api_key' };
  }
  if (res.isEnvKey) {
    return { ok: true };
  }
  // Strict owner binding: key owner must match requested userId.
  if (res.userId && String(res.userId) === String(userId)) {
    return { ok: true };
  }
  return { ok: false, reason: 'forbidden_user' };
};

export class LiveServer {
  private wss: WebSocketServer;
  private subscriber: IORedis;
  // channel -> set of clients
  private clients = new Map<string, Set<LiveClient>>();

  constructor(
    private readonly bus: LiveBus,
    redis: IORedis
  ) {
    // Dedicated subscriber connection (a subscriber cannot run normal commands).
    this.subscriber = redis.duplicate();
    this.wss = new WebSocketServer({ noServer: true });
    this.setupSubscriber();
    this.setupHeartbeat();
  }

  // Subscribe once to all live channels and route messages to sockets.
  private setupSubscriber(): void {
    this.subscriber.on('error', (err) => {
      console.error('[LIVE] Subscriber error:', err.message);
    });
    this.subscriber.psubscribe('live:ch:*').then(() => {
      console.log('[LIVE] Subscribed to live:ch:* for WebSocket fan-out');
    }).catch((e) => {
      console.error('[LIVE] psubscribe failed:', e);
    });

    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      const set = this.clients.get(channel);
      if (!set || set.size === 0) return;
      for (const client of set) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.send(message); } catch { /* best-effort */ }
        }
      }
    });
  }

  // Periodic ping to drop dead sockets.
  private setupHeartbeat(): void {
    const t = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const sock = ws as WebSocket & { __alive?: boolean };
        if (sock.__alive === false) {
          try { ws.terminate(); } catch { /* ignore */ }
          return;
        }
        sock.__alive = false;
        try { ws.ping(); } catch { /* ignore */ }
      });
    }, 30000);
    if (typeof t.unref === 'function') t.unref();
  }

  // Hook this into the HTTP server "upgrade" event.
  // Expected path: /live/ws?userId=...&jobId=...&api_key=...
  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let parsed: URL;
      try {
        parsed = new URL(req.url || '', 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      if (parsed.pathname !== '/live/ws') {
        // Not ours; let other handlers (if any) deal with it, else close.
        return;
      }
      const userId = parsed.searchParams.get('userId') || '';
      const jobId = parsed.searchParams.get('jobId') || '';
      const apiKey = parsed.searchParams.get('api_key')
        || (req.headers['x-api-key'] as string | undefined);
      // Step 29: optional shareable-link token (read-only access).
      const share = parsed.searchParams.get('share') || undefined;

      if (!userId || !jobId) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      authorizeLive(apiKey, userId, { share, jobId }).then((auth) => {
        if (!auth.ok) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.onConnection(ws, userId, jobId);
        });
      }).catch(() => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      });
    });
  }

  private async onConnection(ws: WebSocket, userId: string, jobId: string): Promise<void> {
    const channel = getLiveChannel(userId, jobId);
    const client: LiveClient = { ws, userId, jobId, channel };

    let set = this.clients.get(channel);
    if (!set) {
      set = new Set();
      this.clients.set(channel, set);
    }
    set.add(client);

    const sock = ws as WebSocket & { __alive?: boolean };
    sock.__alive = true;
    ws.on('pong', () => { sock.__alive = true; });

    ws.on('close', () => {
      const s = this.clients.get(channel);
      if (s) {
        s.delete(client);
        if (s.size === 0) this.clients.delete(channel);
      }
    });
    ws.on('error', () => { /* swallow; close handler does cleanup */ });

    // Replay recent buffer so a late subscriber catches up.
    try {
      const buffer = await this.bus.getBuffer(userId, jobId);
      if (ws.readyState === WebSocket.OPEN) {
        for (const ev of buffer) {
          ws.send(JSON.stringify(ev));
        }
      }
    } catch { /* best-effort */ }
  }

  async shutdown(): Promise<void> {
    try {
      this.wss.clients.forEach((ws) => { try { ws.close(1001, 'shutdown'); } catch { /* ignore */ } });
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    } catch { /* ignore */ }
    try {
      await this.subscriber.punsubscribe('live:ch:*');
      await this.subscriber.quit();
    } catch { /* ignore */ }
  }
}
