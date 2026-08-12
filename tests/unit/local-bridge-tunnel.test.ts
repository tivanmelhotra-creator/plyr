import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'http';
import { createServer as createTcpServer, type Server as TcpServer } from 'net';
import { WebSocketServer } from 'ws';
import { createHash } from 'crypto';
import { resolve } from 'path';

import {
  BRIDGE_OP,
  BRIDGE_HEADER_BYTES,
  encodeFrame,
  decodeFrame,
} from '../../src/core/LocalBridge';

/**
 * Local Browser Mode — the tunnel, end to end.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The agent (tools/local-browser-agent.js) contains a hand-rolled RFC-6455
 * client so that a user installing it on their own machine needs no npm install.
 * Hand-rolled means the usual guarantee — "the library handles it" — does not
 * apply, and a protocol constant that is one character wrong produces a client
 * that connects to nothing while looking completely correct on the page.
 *
 * That is not hypothetical. The first version of the agent had the WebSocket
 * GUID as ...95CA-5AB0DC85B11F instead of the RFC's ...95CA-C5AB0DC85B11 — one
 * transposed character — and could never have completed a handshake with any
 * server. Reading the code did not reveal it; running it against a real `ws`
 * server did, immediately.
 *
 * So these tests run the REAL agent module against the REAL `ws` server the
 * bridge uses, over loopback TCP. No Chrome and no network required: a plain
 * echo server stands in for the CDP port, because the tunnel's contract is that
 * it copies bytes without understanding them.
 */

// The agent is a plain CommonJS script with no side effects on require()
// (main() is guarded by require.main === module).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const agent = require(resolve(__dirname, '../../tools/local-browser-agent.js'));

const AGENT_PATH = resolve(__dirname, '../../tools/local-browser-agent.js');

/** Promise helper: resolve on the next tick of the event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('local browser agent — frame codec parity with the server', () => {
  it('encodes frames the server can decode, byte for byte', () => {
    const payload = Buffer.from('CDP goes here');
    const fromAgent: Buffer = agent.encodeFrame(BRIDGE_OP.DATA, 42, payload);
    const fromServer = encodeFrame(BRIDGE_OP.DATA, 42, payload);

    // Identical bytes on the wire is the whole point: two implementations of
    // one format that disagree by a byte fail in production, not here.
    expect(fromAgent.equals(fromServer)).toBe(true);

    const decoded = decodeFrame(fromAgent);
    expect(decoded).not.toBeNull();
    expect(decoded!.op).toBe(BRIDGE_OP.DATA);
    expect(decoded!.streamId).toBe(42);
    expect(decoded!.payload.toString()).toBe('CDP goes here');
  });

  it('decodes what the server encodes, including empty payloads', () => {
    const open = encodeFrame(BRIDGE_OP.OPEN, 7);
    const decoded = agent.decodeFrame(open);
    expect(decoded.op).toBe(BRIDGE_OP.OPEN);
    expect(decoded.streamId).toBe(7);
    expect(decoded.payload.length).toBe(0);
  });

  it('agrees with the server on the header size and opcodes', () => {
    // Drift here would corrupt every stream, so the constants are asserted
    // rather than assumed to have been copied correctly.
    expect(agent.HEADER).toBe(BRIDGE_HEADER_BYTES);
    expect(agent.OP_OPEN).toBe(BRIDGE_OP.OPEN);
    expect(agent.OP_DATA).toBe(BRIDGE_OP.DATA);
    expect(agent.OP_CLOSE).toBe(BRIDGE_OP.CLOSE);
    expect(agent.OP_ERROR).toBe(BRIDGE_OP.ERROR);
  });

  it('survives a truncated frame instead of throwing', () => {
    // Frames arrive from a program on someone else's machine, possibly an older
    // agent. A short read must drop a frame, not crash the process.
    expect(agent.decodeFrame(Buffer.alloc(3))).toBeNull();
    expect(agent.decodeFrame(Buffer.alloc(0))).toBeNull();
  });

  it('handles a 4-byte stream id without sign errors', () => {
    // streamId is uint32; a naive readInt32 would turn a high id negative and
    // route data to a stream that does not exist.
    const frame = agent.encodeFrame(BRIDGE_OP.DATA, 0xfffffff0, Buffer.from('x'));
    expect(agent.decodeFrame(frame).streamId).toBe(0xfffffff0);
    expect(decodeFrame(frame)!.streamId).toBe(0xfffffff0);
  });
});

describe('local browser agent — the RFC 6455 handshake', () => {
  it('computes the accept digest for the RFC published example', () => {
    // RFC 6455 §1.3 gives this exact key/accept pair. Pinning it means a
    // future retype of the GUID fails a test instead of shipping an agent that
    // silently cannot connect — which is precisely what happened once.
    expect(agent.acceptFor('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('uses the exact GUID from the specification', () => {
    expect(agent.WS_GUID).toBe('258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  });

  it('derives the same digest as an independent implementation', () => {
    const key = 'AQIDBAUGBwgJCgsMDQ4PEC==';
    const independent = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    expect(agent.acceptFor(key)).toBe(independent);
  });
});

describe('local browser agent — tunnelling against a real ws server', () => {
  /**
   * Stand up: a loopback echo server (the stand-in for Chrome's CDP port), and
   * an http+ws server that speaks the bridge's frame format. Then let the real
   * agent connect and prove bytes survive the trip.
   */
  async function withTunnel(
    run: (ctx: {
      openStream: (id: number, data?: Buffer) => void;
      closeStream: (id: number) => void;
      sendRawBytes: (buf: Buffer) => void;
      received: Map<number, Buffer>;
      closes: number[];
      texts: string[];
      sendText: (s: string) => void;
    }) => Promise<void>,
    opts: { endAfterReply?: boolean } = {}
  ): Promise<void> {
    const cdp: TcpServer = createTcpServer((sock) => {
      sock.setNoDelay(true);
      sock.on('data', (d) => {
        try {
          sock.write(d);
          // For the close test: hang up right after replying, so the agent has a
          // genuinely ended local socket to report rather than a synthetic one.
          if (opts.endAfterReply) sock.end();
        } catch { /* closing */ }
      });
      sock.on('error', () => { /* the agent may hang up first */ });
    });
    const http: Server = createServer();
    const wss = new WebSocketServer({ noServer: true });

    const received = new Map<number, Buffer>();
    const closes: number[] = [];
    const texts: string[] = [];
    let ws: import('ws').WebSocket | null = null;

    try {
      await new Promise<void>((r) => cdp.listen(0, '127.0.0.1', () => r()));
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
      const cdpPort = (cdp.address() as { port: number }).port;
      const wsPort = (http.address() as { port: number }).port;

      const connected = new Promise<void>((resolveConn) => {
        http.on('upgrade', (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (client) => {
            ws = client;
            client.on('message', (data, isBinary) => {
              if (!isBinary) { texts.push(String(data)); return; }
              const frame = decodeFrame(data as Buffer);
              if (!frame) return;
              if (frame.op === BRIDGE_OP.DATA) {
                const prev = received.get(frame.streamId) || Buffer.alloc(0);
                received.set(frame.streamId, Buffer.concat([prev, frame.payload]));
              } else if (frame.op === BRIDGE_OP.CLOSE || frame.op === BRIDGE_OP.ERROR) {
                closes.push(frame.streamId);
              }
            });
            resolveConn();
          });
        });
      });

      const conn = await new Promise<any>((resolveWs, rejectWs) => {
        agent.connectWebSocket(
          'ws://127.0.0.1:' + wsPort + '/local-browser/ws?userId=local',
          {},
          (err: Error | null, c: unknown) => (err ? rejectWs(err) : resolveWs(c))
        );
      });
      agent.makeTunnel(conn, cdpPort);
      await connected;

      await run({
        openStream: (id, data) => {
          ws!.send(encodeFrame(BRIDGE_OP.OPEN, id));
          if (data) ws!.send(encodeFrame(BRIDGE_OP.DATA, id, data));
        },
        closeStream: (id) => ws!.send(encodeFrame(BRIDGE_OP.CLOSE, id)),
        sendRawBytes: (buf: Buffer) => ws!.send(buf),
        received,
        closes,
        texts,
        sendText: (s) => conn.sendText(s),
      });

      try { conn.close(1000); } catch { /* already gone */ }
    } finally {
      // Teardown order and forcefulness both matter here, and getting it wrong
      // cost a debugging round: `http.close(cb)` does NOT invoke its callback
      // while an upgraded (WebSocket) socket is still open, because an upgraded
      // socket is no longer tracked as an idle HTTP connection. Awaiting that
      // callback hangs until the test times out — which looked exactly like a
      // broken tunnel, even though the tunnel had already delivered the bytes.
      //
      // So: destroy the sockets first, then close without awaiting.
      try { ws?.terminate(); } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
      try { http.closeAllConnections?.(); } catch { /* older node */ }
      try { http.close(); } catch { /* ignore */ }
      try { cdp.close(); } catch { /* ignore */ }
    }
  }

  /** Poll until a predicate holds, so tests do not depend on fixed sleeps. */
  async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fn()) return true;
      await delay(20);
    }
    return fn();
  }

  it('completes the handshake with the real ws server', async () => {
    // The regression test for the transposed-GUID bug: if the digest is wrong,
    // connectWebSocket rejects and this fails before any framing is exercised.
    await withTunnel(async () => { /* connecting at all is the assertion */ });
  });

  it('carries bytes to the local port and back', async () => {
    await withTunnel(async ({ openStream, received }) => {
      openStream(1, Buffer.from('hello-one'));
      const ok = await until(() => (received.get(1)?.length || 0) >= 9);
      expect(ok).toBe(true);
      expect(received.get(1)!.toString()).toBe('hello-one');
    });
  });

  it('buffers data that arrives before the local socket has connected', async () => {
    // The server writes OPEN and DATA back to back. The local TCP handshake has
    // not finished at that point, so an implementation that wrote immediately
    // would drop the first bytes — a hang with no error, the worst failure mode.
    await withTunnel(async ({ openStream, received }) => {
      openStream(5, Buffer.from('immediately-after-open'));
      const ok = await until(() => (received.get(5)?.length || 0) >= 22);
      expect(ok).toBe(true);
      expect(received.get(5)!.toString()).toBe('immediately-after-open');
    });
  });

  it('multiplexes concurrent streams without mixing them up', async () => {
    // connectOverCDP opens several connections (version probe, browser socket,
    // one per target). If stream ids leaked into each other, CDP conversations
    // would interleave and Playwright would see corrupt replies.
    await withTunnel(async ({ openStream, received }) => {
      openStream(11, Buffer.from('AAAA'));
      openStream(12, Buffer.from('BBBB'));
      openStream(13, Buffer.from('CCCC'));
      const ok = await until(() =>
        (received.get(11)?.length || 0) >= 4 &&
        (received.get(12)?.length || 0) >= 4 &&
        (received.get(13)?.length || 0) >= 4);
      expect(ok).toBe(true);
      expect(received.get(11)!.toString()).toBe('AAAA');
      expect(received.get(12)!.toString()).toBe('BBBB');
      expect(received.get(13)!.toString()).toBe('CCCC');
    });
  });

  it('round-trips a payload far larger than one WebSocket frame', async () => {
    // 300KB exercises the 64-bit length path on the way out and fragment
    // reassembly on the way in — the code paths a screenshot or DOM snapshot
    // hits. A truncation here would corrupt exactly the big CDP replies.
    const BIG = 300_000;
    await withTunnel(async ({ openStream, received }) => {
      openStream(21, Buffer.alloc(BIG, 0x42));
      const ok = await until(() => (received.get(21)?.length || 0) >= BIG, 8000);
      expect(ok).toBe(true);
      const back = received.get(21)!;
      expect(back.length).toBe(BIG);
      expect(back.every((b) => b === 0x42)).toBe(true);
    });
  });

  it('reports a stream that the local side ended', async () => {
    // The local endpoint hangs up after replying. The agent must tell the server
    // the stream is gone; otherwise the server waits for data that will never
    // arrive and the run stalls instead of failing.
    await withTunnel(async ({ openStream, closes }) => {
      openStream(31, Buffer.from('bye'));
      const ok = await until(() => closes.includes(31));
      expect(ok).toBe(true);
    }, { endAfterReply: true });
  });

  it('ignores a malformed binary frame and keeps serving other streams', async () => {
    await withTunnel(async ({ openStream, sendRawBytes, received }) => {
      // A 3-byte "frame" is shorter than the 5-byte header. An older or buggy
      // peer can produce this, and it must drop the frame rather than take down
      // the agent — which would end the tunnel for a healthy stream too.
      sendRawBytes(Buffer.from([0x02, 0x00, 0x01]));
      // Also an unknown opcode, which a future protocol version might add.
      sendRawBytes(encodeFrame(0x7f, 999, Buffer.from('unknown op')));

      openStream(41, Buffer.from('still-works'));
      const ok = await until(() => (received.get(41)?.length || 0) >= 11);
      expect(ok).toBe(true);
      expect(received.get(41)!.toString()).toBe('still-works');
    });
  });
});

describe('local browser agent — safety properties of the source', () => {
  // These are read off the source text because they are claims about what the
  // agent must NEVER do; an assertion is cheaper than a code review that has to
  // be repeated every time the file changes.
  const src = require('fs').readFileSync(AGENT_PATH, 'utf8') as string;

  it('binds the browser debugger to loopback only', () => {
    // The entire security argument for Local mode rests on this flag. Without
    // it, the agent would expose an unauthenticated CDP port to the network.
    expect(src).toContain('--remote-debugging-address=127.0.0.1');
  });

  it('only ever dials 127.0.0.1 for CDP', () => {
    expect(src).toContain("net.connect({ host: '127.0.0.1'");
    // No listening socket anywhere: the agent is a client on both sides.
    expect(src).not.toContain('net.createServer');
  });

  it('does not log the connect URL with its query string', () => {
    // The API key travels in the query string, so logging the full URL would
    // write a credential into the user's terminal and any log file.
    expect(src).toContain("url.split('?')[0]");
  });

  it('accepts the API key from the environment', () => {
    // argv is world-readable in the process list on a shared machine.
    expect(src).toContain('AB_API_KEY');
  });

  it('does not run main() when required as a module', () => {
    // Without this guard, importing the agent in a test would launch a browser.
    expect(src).toContain('if (require.main === module) main();');
  });
});
