'use strict';

/**
 * LocalBridge — a reverse CDP tunnel to the Chrome on the user's own machine.
 *
 * THE PROBLEM
 * -----------
 * Playwright drives a browser over the Chrome DevTools Protocol, and
 * `chromium.connectOverCDP(url)` needs to make ordinary TCP connections to
 * that url. The user's Chrome is behind a home router: it has no public
 * address, and nothing the server does can dial into it.
 *
 * The two obvious answers are both wrong:
 *
 *   1. Have the agent expose port 9222 publicly. CDP has no authentication
 *      whatsoever — anyone who reaches that port owns a browser that is logged
 *      into the user's email. This is not a hardening problem, it is a
 *      disqualification.
 *   2. Ask the user to port-forward. Most cannot (CGNAT), the rest should not
 *      have to, and it still leaves (1)'s open port.
 *
 * THE ANSWER: DIAL OUT, THEN RUN CDP BACKWARDS
 * --------------------------------------------
 * The agent on the user's machine opens ONE outbound WebSocket to this server
 * (`/local-browser/ws`, port 443, indistinguishable from any other web
 * traffic). No firewall change, no forwarded port, nothing listening on the
 * public internet.
 *
 * The server then hands Playwright a `http://127.0.0.1:<ephemeral>` endpoint
 * backed by a `net.Server` bound to LOOPBACK ONLY. Every TCP connection
 * Playwright makes to it becomes a multiplexed stream inside the agent's
 * WebSocket; the agent dials 127.0.0.1:9222 on its side and copies bytes.
 *
 * WHY MULTIPLEXING IS NOT OPTIONAL
 * --------------------------------
 * MEASURED: `connectOverCDP` does not open one connection. It opens an HTTP
 * request for /json/version, then a WebSocket to the browser endpoint, then a
 * further WebSocket per attached target (each tab). A single pre-opened socket
 * therefore cannot stand in for it — the second connection would have nowhere
 * to go. Hence stream ids and a frame header.
 *
 * WHY THE BYTES ARE NEVER PARSED
 * ------------------------------
 * This file copies bytes and never looks inside them. A proxy that understood
 * CDP would need to be updated for every Chrome and Playwright release, and
 * would break in the field on a message shape it had never seen. A dumb pipe
 * has no opinion to be wrong about: it works with whatever protocol version
 * the two ends negotiate, including ones written after this code.
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import * as net from 'net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { URL } from 'url';

import { config } from '../config';
import { authorizeLive } from './LiveServer';
import {
  browserModes,
  isLocalModeEnabled,
  setLocalAvailabilityProbe,
} from './BrowserMode';

// ════════════════════════════════════════════════════════════════
// Wire format
// ----------------------------------------------------------------
// [uint8 opcode][uint32BE streamId][payload...]
//
// Binary, not JSON: CDP traffic is large (screenshots, DOM snapshots) and
// base64-in-JSON would inflate every byte by a third and force a parse of data
// this layer has no business reading. Five bytes of header is the whole cost.
// ════════════════════════════════════════════════════════════════

export const BRIDGE_OP = {
  /** Server → agent: dial the local CDP port for this new stream. */
  OPEN: 0x01,
  /** Either way: raw bytes for a stream. */
  DATA: 0x02,
  /** Either way: this stream ended cleanly. */
  CLOSE: 0x03,
  /** Agent → server: this stream failed (payload is a utf-8 reason). */
  ERROR: 0x04,
} as const;

export type BridgeOp = (typeof BRIDGE_OP)[keyof typeof BRIDGE_OP];

export const BRIDGE_HEADER_BYTES = 5;

export interface BridgeFrame {
  op: number;
  streamId: number;
  payload: Buffer;
}

export function encodeFrame(op: number, streamId: number, payload?: Buffer): Buffer {
  const body = payload && payload.length ? payload : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(BRIDGE_HEADER_BYTES + body.length);
  out.writeUInt8(op & 0xff, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  if (body.length) body.copy(out, BRIDGE_HEADER_BYTES);
  return out;
}

/**
 * Parse a frame, returning null instead of throwing on anything malformed.
 *
 * Total on purpose: this runs on bytes from a client program on someone else's
 * machine, possibly an old version of the agent. A truncated frame must drop a
 * frame, not take down the process that is also serving every other user.
 */
export function decodeFrame(data: Buffer | ArrayBuffer | Uint8Array): BridgeFrame | null {
  let buf: Buffer;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (data && typeof (data as Uint8Array).byteLength === 'number') {
    const u = data as Uint8Array;
    buf = Buffer.from(u.buffer, u.byteOffset, u.byteLength);
  } else return null;

  if (buf.length < BRIDGE_HEADER_BYTES) return null;
  const op = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const payload = buf.length > BRIDGE_HEADER_BYTES
    ? buf.subarray(BRIDGE_HEADER_BYTES)
    : Buffer.alloc(0);
  return { op, streamId, payload };
}

/** What the agent tells us about itself when it connects. */
export interface BridgeHello {
  agent: string;
  browser: string;
  platform: string;
  cdpPort: number;
}

/** What the UI is shown about a connected local browser. */
export interface BridgeInfo extends BridgeHello {
  connectedAt: number;
  streams: number;
}

/**
 * How long an unused loopback listener stays up. Playwright reconnects on its
 * own schedule, so tearing the listener down the instant the last stream
 * closes would race a legitimate reconnect; a minute is long enough to be
 * invisible and short enough that a dead session does not hold a port.
 */
export const ENDPOINT_IDLE_MS = 60_000;

/**
 * Ceiling on concurrent streams per bridge. `connectOverCDP` uses one per
 * target, so a user with many tabs legitimately needs a few dozen; 64 leaves
 * room for that while making a runaway loop (or a hostile agent) hit a wall
 * instead of exhausting the server's file descriptors.
 */
export const MAX_STREAMS_PER_BRIDGE = 64;

interface PendingStream {
  socket: net.Socket;
  /**
   * Bytes Playwright wrote before the agent confirmed the dial. TCP does not
   * wait for us: without this buffer the first CDP request — the one that
   * decides whether the connection works at all — would be dropped.
   */
  buffered: Buffer[];
  opened: boolean;
}

/**
 * One connected agent: its socket, its loopback listener, and its streams.
 */
class Bridge {
  readonly connectedAt = Date.now();
  private streams = new Map<number, PendingStream>();
  private nextStreamId = 1;
  private server: net.Server | null = null;
  private endpoint = '';
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    readonly userId: string,
    readonly ws: WebSocket,
    readonly hello: BridgeHello,
  ) {}

  info(): BridgeInfo {
    return {
      ...this.hello,
      connectedAt: this.connectedAt,
      streams: this.streams.size,
    };
  }

  streamCount(): number {
    return this.streams.size;
  }

  /**
   * The `http://127.0.0.1:<port>` Playwright should connect to, starting the
   * loopback listener on first call.
   *
   * Bound to 127.0.0.1 explicitly, and to port 0 (let the OS choose). Loopback
   * because this endpoint is an unauthenticated door to the user's browser and
   * must be reachable only by this process; port 0 because a fixed port would
   * collide the moment two users are in local mode at once.
   */
  async cdpEndpoint(): Promise<string> {
    if (this.disposed) throw new Error('local browser bridge is closed');
    if (this.endpoint) {
      this.touch();
      return this.endpoint;
    }

    const server = net.createServer((socket) => this.adoptSocket(socket));
    server.on('error', () => { /* a dead listener surfaces as a connect failure */ });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      try { server.close(); } catch { /* ignore */ }
      throw new Error('could not open a local CDP endpoint');
    }

    this.server = server;
    this.endpoint = `http://127.0.0.1:${addr.port}`;
    this.touch();
    return this.endpoint;
  }

  /** Restart the idle countdown for the loopback listener. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.streams.size === 0) this.closeListener();
    }, ENDPOINT_IDLE_MS);
    // Never hold the process open for a timer that only frees a port.
    this.idleTimer.unref?.();
  }

  private closeListener(): void {
    const server = this.server;
    this.server = null;
    this.endpoint = '';
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (server) {
      try { server.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Take a TCP connection Playwright just made and turn it into a stream.
   *
   * The stream id is allocated HERE, on the server, and never by the agent.
   * One allocator means ids cannot collide, and a buggy or hostile agent
   * cannot name a stream that belongs to someone else's traffic.
   */
  private adoptSocket(socket: net.Socket): void {
    if (this.disposed || this.ws.readyState !== WebSocket.OPEN) {
      socket.destroy();
      return;
    }
    if (this.streams.size >= MAX_STREAMS_PER_BRIDGE) {
      socket.destroy();
      return;
    }

    const streamId = this.nextStreamId++;
    // CDP is a request/response chat: Nagle would sit on small messages waiting
    // for company and add latency to every single command.
    socket.setNoDelay(true);

    const entry: PendingStream = { socket, buffered: [], opened: false };
    this.streams.set(streamId, entry);
    this.touch();

    socket.on('data', (chunk: Buffer) => {
      if (entry.opened) this.sendFrame(BRIDGE_OP.DATA, streamId, chunk);
      else entry.buffered.push(chunk);
    });
    socket.on('end', () => this.endStream(streamId, true));
    socket.on('close', () => this.endStream(streamId, true));
    socket.on('error', () => this.endStream(streamId, true));

    this.sendFrame(BRIDGE_OP.OPEN, streamId, Buffer.alloc(0));
    // OPEN is enough for the agent to start dialling; the buffered bytes go out
    // as soon as it says the dial succeeded, in the order they arrived.
    entry.opened = true;
    for (const chunk of entry.buffered) {
      this.sendFrame(BRIDGE_OP.DATA, streamId, chunk);
    }
    entry.buffered = [];
  }

  private sendFrame(op: number, streamId: number, payload: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(encodeFrame(op, streamId, payload)); }
    catch { /* the close handler disposes the bridge */ }
  }

  private endStream(streamId: number, notifyAgent: boolean): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    this.streams.delete(streamId);
    try { entry.socket.destroy(); } catch { /* ignore */ }
    if (notifyAgent) this.sendFrame(BRIDGE_OP.CLOSE, streamId, Buffer.alloc(0));
    if (this.streams.size === 0) this.touch();
  }

  /**
   * A frame arrived from the agent.
   *
   * Text frames are ignored outright: control chatter (`ping`, `hello`) is
   * handled by the socket owner, and a text frame can never be stream data, so
   * treating one as data would corrupt a CDP conversation.
   */
  onMessage(data: RawData, isBinary: boolean): void {
    if (!isBinary) return;
    const frame = decodeFrame(data as Buffer);
    if (!frame) return;

    const entry = this.streams.get(frame.streamId);
    if (!entry) return;

    if (frame.op === BRIDGE_OP.DATA) {
      if (frame.payload.length) {
        try { entry.socket.write(frame.payload); } catch { this.endStream(frame.streamId, false); }
      }
      return;
    }
    if (frame.op === BRIDGE_OP.CLOSE || frame.op === BRIDGE_OP.ERROR) {
      // The agent already knows this stream is finished — telling it again
      // would be noise, so notifyAgent is false.
      this.endStream(frame.streamId, false);
    }
  }

  /**
   * Tear everything down, in an order that matters:
   * streams first (so nothing writes to a closing listener), then the
   * listener (so nothing new is adopted), then the socket.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const streamId of [...this.streams.keys()]) {
      this.endStream(streamId, false);
    }
    this.closeListener();
    try { this.ws.close(1001, 'bridge_closed'); } catch { /* ignore */ }
    try { this.ws.terminate(); } catch { /* ignore */ }
  }
}

/** The path the agent dials. Exported so the agent and docs cannot drift. */
export function agentConnectPath(): string {
  return '/local-browser/ws';
}

/** The CDP port the agent is expected to have started Chrome on. */
export function defaultAgentCdpPort(): number {
  return config.LOCAL_BROWSER_CDP_PORT;
}

type ChangeListener = (userId: string, connected: boolean) => void;

/**
 * The WebSocket endpoint agents connect to, and the registry of live bridges.
 *
 * Mirrors BrowserStreamServer deliberately: `matches()` + `handleUpgrade()`,
 * with `attach()` only for standalone use. index.ts multiplexes upgrades by
 * path, and a server that destroyed sockets it did not recognise would kill
 * the other channels sharing the port.
 */
export class LocalBridgeServer {
  private wss: WebSocketServer;
  private bridges = new Map<string, Bridge>();
  private listeners = new Set<ChangeListener>();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    // Teach BrowserMode how to answer "is local actually possible for this
    // user?" — injected rather than imported so BrowserMode stays
    // dependency-free and offline-testable.
    setLocalAvailabilityProbe((userId) => this.isConnected(userId));
  }

  matches(pathname: string): boolean {
    return pathname === agentConnectPath();
  }

  isConnected(userId: string): boolean {
    const b = this.bridges.get(userId);
    return !!b && b.ws.readyState === WebSocket.OPEN;
  }

  info(userId: string): BridgeInfo | null {
    const b = this.bridges.get(userId);
    return b ? b.info() : null;
  }

  /** How many agents are connected (all users). */
  get count(): number {
    return this.bridges.size;
  }

  /**
   * The loopback CDP endpoint for this user, or null if no agent is connected.
   * Async because the listener is opened lazily on first use.
   */
  async cdpEndpoint(userId: string): Promise<string | null> {
    const b = this.bridges.get(userId);
    if (!b || b.ws.readyState !== WebSocket.OPEN) return null;
    return b.cdpEndpoint();
  }

  /** Subscribe to connect/disconnect, for the UI push channel. */
  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emitChange(userId: string, connected: boolean): void {
    for (const fn of this.listeners) {
      try { fn(userId, connected); } catch { /* a bad listener is not fatal */ }
    }
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname = '';
      try { pathname = new URL(req.url || '', 'http://localhost').pathname; }
      catch { return; }
      if (!this.matches(pathname)) return; // not ours — someone else may want it
      this.handleUpgrade(req, socket, head);
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Refused at the door when the operator turned local mode off, so the
    // switch is genuinely unreachable rather than merely hidden in the UI.
    if (!isLocalModeEnabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

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

    const hello: BridgeHello = {
      agent: (parsed.searchParams.get('agent') || 'unknown').slice(0, 64),
      browser: (parsed.searchParams.get('browser') || 'chrome').slice(0, 64),
      platform: (parsed.searchParams.get('platform') || 'unknown').slice(0, 64),
      cdpPort: parseInt(parsed.searchParams.get('cdpPort') || '', 10) || defaultAgentCdpPort(),
    };

    // The same gate as every other socket on this port. A tunnel to a user's
    // browser is the most sensitive channel in the product; it gets no weaker
    // a check than the live event feed.
    authorizeLive(apiKey, userId).then((auth) => {
      if (!auth.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, userId, hello);
      });
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  }

  private onConnection(ws: WebSocket, userId: string, hello: BridgeHello): void {
    // One bridge per user. A second agent (the user restarted it, or opened it
    // on a second machine) REPLACES the first rather than joining it: two
    // bridges would mean commands landing in whichever browser won the race,
    // which is worse than unambiguously using the newest one.
    const previous = this.bridges.get(userId);
    if (previous) previous.dispose();

    const bridge = new Bridge(userId, ws, hello);
    this.bridges.set(userId, bridge);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        // Control chatter. Only 'ping' is honoured; everything else is ignored
        // so an agent cannot reach anything but its own keepalive.
        try {
          const msg = JSON.parse(String(data)) as { t?: string };
          if (msg && msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
        } catch { /* not JSON: ignore */ }
        return;
      }
      bridge.onMessage(data, true);
    });

    const onGone = () => {
      // Only clear the map if this bridge is still the current one — a replaced
      // bridge's late 'close' must not delete its successor.
      if (this.bridges.get(userId) === bridge) {
        this.bridges.delete(userId);
        bridge.dispose();
        // A user sitting in local mode whose browser just vanished cannot run a
        // single command. Move them back to remote — a mode that always works —
        // and let the UI say why instead of silently failing their next click.
        browserModes.fallbackToRemote(userId);
        this.emitChange(userId, false);
      } else {
        bridge.dispose();
      }
    };
    ws.on('close', onGone);
    ws.on('error', onGone);

    // Told after the map is populated, so an immediate mode switch from the
    // client finds the bridge already available.
    try {
      ws.send(JSON.stringify({
        t: 'ready',
        userId,
        cdpPort: hello.cdpPort,
        connectedAt: bridge.connectedAt,
      }));
    } catch { /* ignore */ }

    this.emitChange(userId, true);
  }

  /** Drop a user's agent on purpose (the UI's "Disconnect"). */
  disconnect(userId: string): boolean {
    const bridge = this.bridges.get(userId);
    if (!bridge) return false;
    this.bridges.delete(userId);
    bridge.dispose();
    browserModes.fallbackToRemote(userId);
    this.emitChange(userId, false);
    return true;
  }

  shutdown(): void {
    for (const [userId, bridge] of [...this.bridges]) {
      this.bridges.delete(userId);
      bridge.dispose();
    }
    this.listeners.clear();
    try { this.wss.close(); } catch { /* ignore */ }
  }
}

/**
 * Process-wide registry. Singleton for a physical reason, not a stylistic one:
 * a bridge IS a socket held by this process, so a second registry would
 * describe bridges it does not have.
 */
export const localBridges = new LocalBridgeServer();
