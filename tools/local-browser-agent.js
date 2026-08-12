#!/usr/bin/env node
/* ============================================================
   local-browser-agent.js — the Local Browser Mode agent.

   Runs on the USER'S machine (Windows, macOS or Linux). It starts — or
   attaches to — their real Chrome/Chromium with remote debugging enabled, dials
   ONE outbound WebSocket to the project, and copies bytes between that socket
   and the browser's CDP port.

   Result: the automation runs against the browser on the user's desk. Rendering,
   mouse and keyboard are local; only automation commands and data cross the
   network. The server-side Playwright is unchanged — there is no second
   automation engine.

   WHY IT DIALS OUT INSTEAD OF LISTENING
   ------------------------------------
   The alternative is exposing CDP port 9222 to the network. CDP has NO
   authentication of any kind: whoever reaches that port controls a browser
   that is signed into the user's email and bank. Add that most home
   connections are behind NAT/CGNAT and cannot accept inbound connections at
   all, and dialling out is the only design that is both safe and workable.

   Everything here therefore stays loopback-only:
     - Chrome is launched with --remote-debugging-address=127.0.0.1
     - the agent connects to 127.0.0.1:<port>
     - nothing on this machine listens on a public interface

   NO DEPENDENCIES ON PURPOSE
   --------------------------
   One file, Node built-ins only, including a hand-rolled RFC-6455 client. A
   user installing this on their own machine should not need npm install, a
   lockfile, or trust in a transitive dependency tree to let a remote service
   drive their browser. `node local-browser-agent.js` is the whole install.

   USAGE
     node local-browser-agent.js --server https://your-project --key YOUR_API_KEY
     node local-browser-agent.js --server ... --key ... --user 42 --port 9222
     node local-browser-agent.js --server ... --key ... --attach

   OPTIONS
     --server <url>   project base URL (http/https; ws/wss are derived)
     --key <apiKey>   the same API key the dashboard uses
     --user <id>      user id (default "local", matching single-user mode)
     --port <n>       CDP port (default 9222)
     --chrome <path>  explicit browser executable
     --profile <dir>  user-data-dir (default: ~/.ab-local-browser)
     --attach         do NOT launch; a debuggable Chrome is already running
     --headless       launch headless (for testing; defeats the point otherwise)
     --verbose        log every stream open/close
   ============================================================ */
'use strict';

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ════════════════════════════════════════════════════════════════
// Wire format — must match src/core/LocalBridge.ts exactly.
// [uint8 opcode][uint32BE streamId][payload...]
// ════════════════════════════════════════════════════════════════
const OP_OPEN = 0x01;
const OP_DATA = 0x02;
const OP_CLOSE = 0x03;
const OP_ERROR = 0x04;
const HEADER = 5;

function encodeFrame(op, streamId, payload) {
  const body = payload && payload.length ? payload : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(HEADER + body.length);
  out.writeUInt8(op & 0xff, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  if (body.length) body.copy(out, HEADER);
  return out;
}

function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER) return null;
  return {
    op: buf.readUInt8(0),
    streamId: buf.readUInt32BE(1),
    payload: buf.subarray(HEADER)
  };
}

// ════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const out = {
    server: '', key: '', user: 'local', port: 9222,
    chrome: '', profile: '', attach: false, headless: false, verbose: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--server' || a === '-s') out.server = next();
    else if (a === '--key' || a === '-k') out.key = next();
    else if (a === '--user' || a === '-u') out.user = next();
    else if (a === '--port' || a === '-p') out.port = parseInt(next(), 10) || 9222;
    else if (a === '--chrome') out.chrome = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--attach') out.attach = true;
    else if (a === '--headless') out.headless = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  // Env fallbacks so the agent can run as a service without the key appearing
  // in the command line, which is readable by every process on the machine.
  out.server = out.server || process.env.AB_SERVER || '';
  out.key = out.key || process.env.AB_API_KEY || '';
  out.user = out.user || process.env.AB_USER_ID || 'local';
  return out;
}

function usage() {
  console.log([
    '',
    'Local Browser Agent — run automation against the Chrome on THIS machine.',
    '',
    '  node local-browser-agent.js --server <url> --key <apiKey> [options]',
    '',
    '  --server <url>   project base URL, e.g. https://automation.example.com',
    '  --key <apiKey>   the same API key the dashboard uses',
    '  --user <id>      user id (default "local")',
    '  --port <n>       CDP port (default 9222)',
    '  --chrome <path>  explicit browser executable',
    '  --profile <dir>  user-data-dir for the launched browser',
    '  --attach         do not launch; attach to a Chrome already debuggable',
    '  --headless       launch headless (testing only)',
    '  --verbose        log every tunnelled stream',
    '',
    'Env fallbacks: AB_SERVER, AB_API_KEY, AB_USER_ID.',
    ''
  ].join('\n'));
}

const args = parseArgs(process.argv);

function log(...m) { console.log('[agent]', ...m); }
function warn(...m) { console.warn('[agent]', ...m); }
function vlog(...m) { if (args.verbose) console.log('[agent]', ...m); }

// ════════════════════════════════════════════════════════════════
// Find and launch the browser
// ════════════════════════════════════════════════════════════════
function candidatePaths() {
  const plat = process.platform;
  if (plat === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    return [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local ? path.join(local, 'Google\\Chrome\\Application\\chrome.exe') : '',
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Chromium\\Application\\chrome.exe')
    ].filter(Boolean);
  }
  if (plat === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'
  ];
}

function findChrome() {
  if (args.chrome) {
    if (!fs.existsSync(args.chrome)) throw new Error('No browser at ' + args.chrome);
    return args.chrome;
  }
  for (const p of candidatePaths()) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* keep looking */ }
  }
  throw new Error('Could not find Chrome/Chromium/Edge. Pass --chrome <path>.');
}

// Is something already answering CDP on the port? Also the readiness probe
// after launching: a browser process exists well before its port is listening.
function probeCdp(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs || 1000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function waitForCdp(port, totalMs) {
  const deadline = Date.now() + (totalMs || 20000);
  while (Date.now() < deadline) {
    const info = await probeCdp(port, 1000);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

let childBrowser = null;

async function ensureBrowser() {
  const existing = await probeCdp(args.port, 800);
  if (existing) {
    log('Attached to the browser already on port ' + args.port +
        ' (' + (existing.Browser || 'unknown') + ')');
    return existing;
  }
  if (args.attach) {
    throw new Error(
      '--attach was given but nothing is debuggable on port ' + args.port + '.\n' +
      '        Start Chrome with: chrome --remote-debugging-port=' + args.port
    );
  }

  const exe = findChrome();
  // A DEDICATED profile by default. Reusing the user's everyday profile means
  // Chrome refuses to start against a locked user-data-dir if their normal
  // browser is open, and automation would be writing into the profile they
  // browse with. A separate dir that persists across runs keeps logins between
  // sessions while staying out of the way.
  const profile = args.profile || path.join(os.homedir(), '.ab-local-browser');
  try { fs.mkdirSync(profile, { recursive: true }); } catch (e) { /* chrome will complain */ }

  const flags = [
    '--remote-debugging-port=' + args.port,
    // Loopback only. The whole security argument depends on this line.
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    'about:blank'
  ];
  if (args.headless) flags.unshift('--headless=new');

  log('Launching ' + path.basename(exe) + ' on CDP port ' + args.port);
  childBrowser = spawn(exe, flags, { detached: false, stdio: 'ignore' });
  childBrowser.on('exit', (code) => {
    log('Browser exited (' + code + ').');
    // A tunnel with no browser behind it is a tunnel to nothing; staying up
    // would keep the project believing Local mode is available.
    shutdown(0);
  });

  const info = await waitForCdp(args.port, 25000);
  if (!info) throw new Error('The browser did not open CDP port ' + args.port + ' in time.');
  log('Browser ready: ' + (info.Browser || 'unknown'));
  return info;
}

// ════════════════════════════════════════════════════════════════
// A minimal RFC-6455 client.
//
// Hand-rolled rather than `ws` so this file has zero dependencies (see the
// header). It implements exactly what the bridge uses: a client handshake,
// masked binary/text/pong frames out, and reassembly of fragmented frames in.
//
// This GUID is fixed by RFC 6455 §1.3 and is easy to mistype — the digest is
// the only thing proving the peer is a real WebSocket server, so a wrong
// constant produces a client that can never connect to anything.
// ════════════════════════════════════════════════════════════════
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptFor(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function connectWebSocket(url, headers, cb) {
  let u;
  try { u = new URL(url); } catch (e) { cb(new Error('bad url: ' + url)); return; }

  const secure = u.protocol === 'wss:';
  const port = u.port ? Number(u.port) : (secure ? 443 : 80);
  const key = crypto.randomBytes(16).toString('base64');
  const transport = secure ? require('https') : require('http');

  const req = transport.request({
    host: u.hostname,
    port,
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: Object.assign({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      Host: u.host
    }, headers || {})
  });

  req.on('upgrade', (res, socket, head) => {
    if (res.headers['sec-websocket-accept'] !== acceptFor(key)) {
      socket.destroy();
      cb(new Error('bad websocket accept — the peer is not a WebSocket server'));
      return;
    }
    socket.setNoDelay(true);
    cb(null, new WsConn(socket, head));
  });

  // A non-upgrade response means the server refused: 403 for a bad key, 400 for
  // a missing userId. Surfacing the code turns "it does not work" into "the key
  // is wrong".
  req.on('response', (res) => {
    res.resume();
    cb(new Error('server refused the tunnel: HTTP ' + res.statusCode));
  });
  req.on('error', (e) => cb(e));
  req.end();
}

class WsConn {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = (head && head.length) ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.handlers = { binary: null, text: null, close: null };
    // Continuation frames: a large CDP message (a screenshot) can arrive
    // fragmented, and treating each fragment as a whole message would hand the
    // stream half a payload.
    this.fragOp = 0;
    this.fragParts = [];

    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.drain();
    });
    socket.on('close', () => this.fireClose());
    socket.on('error', () => this.fireClose());
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }

  fireClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.handlers.close) this.handlers.close();
  }

  drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;

      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const hi = b.readUInt32BE(off);
        const lo = b.readUInt32BE(off + 4);
        // 4 GiB in one frame is not a CDP message, it is a broken peer.
        if (hi !== 0) { this.close(1009); return; }
        len = lo; off += 8;
      }
      // Servers must not mask (RFC 6455 §5.1); if one does, the payload we hand
      // upstream would be garbage, so refuse rather than corrupt a CDP stream.
      if (masked) { this.close(1002); return; }
      if (b.length < off + len) return;   // frame not fully arrived yet

      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);

      if (opcode === 0x8) { this.close(1000); return; }               // close
      if (opcode === 0x9) { this.sendRaw(0xa, payload); continue; }   // ping → pong
      if (opcode === 0xa) continue;                                   // pong

      if (opcode === 0x0) {                                           // continuation
        this.fragParts.push(Buffer.from(payload));
        if (!fin) continue;
        const whole = Buffer.concat(this.fragParts);
        const op = this.fragOp;
        this.fragParts = []; this.fragOp = 0;
        this.deliver(op, whole);
        continue;
      }
      if (!fin) {
        this.fragOp = opcode;
        this.fragParts = [Buffer.from(payload)];
        continue;
      }
      this.deliver(opcode, Buffer.from(payload));
    }
  }

  deliver(opcode, payload) {
    if (opcode === 0x2 && this.handlers.binary) this.handlers.binary(payload);
    else if (opcode === 0x1 && this.handlers.text) this.handlers.text(payload.toString('utf8'));
  }

  sendRaw(opcode, payload) {
    if (this.closed) return;
    const body = payload || Buffer.alloc(0);
    const len = body.length;
    let header;
    // Clients MUST mask (RFC 6455 §5.3); an unmasked client frame is dropped
    // by every compliant server.
    const mask = crypto.randomBytes(4);
    if (len < 126) {
      header = Buffer.allocUnsafe(6);
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.allocUnsafe(14);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
      mask.copy(header, 10);
    }
    header[0] = 0x80 | opcode;

    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i & 3];
    try {
      this.socket.write(header);
      if (len) this.socket.write(masked);
    } catch (e) { this.fireClose(); }
  }

  sendBinary(buf) { this.sendRaw(0x2, buf); }
  sendText(str) { this.sendRaw(0x1, Buffer.from(String(str), 'utf8')); }

  close(code) {
    if (this.closed) return;
    try { this.sendRaw(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])); } catch (e) { /* going away */ }
    try { this.socket.end(); } catch (e) { /* ignore */ }
    this.fireClose();
  }
}

// ════════════════════════════════════════════════════════════════
// The tunnel
//
// OPEN(id)  → dial 127.0.0.1:<cdpPort>, remember the socket under that id
// DATA(id)  → write the bytes into that socket (or buffer if still connecting)
// CLOSE(id) → destroy it
//
// Bytes are copied, never parsed. A CDP-aware proxy would need updating for
// every Chrome and Playwright release and would break in the field on a message
// shape it had never seen; a dumb pipe has no opinion that can be wrong.
// ════════════════════════════════════════════════════════════════
function makeTunnel(conn, cdpPort) {
  const streams = new Map();

  function closeStream(id, notifyServer, reason) {
    const st = streams.get(id);
    if (!st) return;
    streams.delete(id);
    try { st.socket.destroy(); } catch (e) { /* ignore */ }
    if (notifyServer) {
      conn.sendBinary(encodeFrame(
        reason ? OP_ERROR : OP_CLOSE, id,
        reason ? Buffer.from(String(reason), 'utf8') : null
      ));
    }
    vlog('stream ' + id + ' closed' + (reason ? ' (' + reason + ')' : ''));
  }

  function openStream(id) {
    if (streams.has(id)) return;              // duplicate OPEN: never double-dial
    vlog('stream ' + id + ' \u2192 127.0.0.1:' + cdpPort);

    const socket = net.connect({ host: '127.0.0.1', port: cdpPort });
    // CDP is a chatty request/response protocol; Nagle would add ~40ms to small
    // messages and make every automation step feel sluggish.
    socket.setNoDelay(true);

    const st = { socket, connected: false, pending: [] };
    streams.set(id, st);

    socket.on('connect', () => {
      st.connected = true;
      // DATA can arrive before the local TCP handshake finishes; those bytes
      // were buffered rather than dropped, which is the difference between a
      // working first request and a mysterious hang.
      for (const chunk of st.pending) {
        try { socket.write(chunk); } catch (e) { /* the error handler cleans up */ }
      }
      st.pending = [];
    });
    socket.on('data', (chunk) => {
      conn.sendBinary(encodeFrame(OP_DATA, id, chunk));
    });
    socket.on('end', () => closeStream(id, true, null));
    socket.on('close', () => closeStream(id, true, null));
    socket.on('error', (e) => {
      // ECONNREFUSED here means the browser died or the port changed. Reporting
      // the reason lets the server fail the run with something readable instead
      // of a timeout.
      closeStream(id, true, (e && e.code) || 'local_connect_failed');
    });
  }

  conn.on('binary', (buf) => {
    const frame = decodeFrame(buf);
    if (!frame) return;                        // a malformed frame drops, never throws

    if (frame.op === OP_OPEN) { openStream(frame.streamId); return; }

    if (frame.op === OP_DATA) {
      const st = streams.get(frame.streamId);
      if (!st) return;                         // data for a stream we already closed
      if (!frame.payload.length) return;
      if (st.connected) {
        try { st.socket.write(frame.payload); }
        catch (e) { closeStream(frame.streamId, true, 'write_failed'); }
      } else {
        st.pending.push(Buffer.from(frame.payload));
      }
      return;
    }

    if (frame.op === OP_CLOSE || frame.op === OP_ERROR) {
      // The server initiated this, so it does not need to be told.
      closeStream(frame.streamId, false, null);
    }
  });

  conn.on('text', (str) => {
    let msg = null;
    try { msg = JSON.parse(str); } catch (e) { return; }
    if (msg && msg.t === 'pong') vlog('pong');
  });

  return {
    streamCount: () => streams.size,
    disposeAll: () => {
      for (const id of [...streams.keys()]) closeStream(id, false, null);
    }
  };
}

// ════════════════════════════════════════════════════════════════
// Connect, and keep reconnecting
// ════════════════════════════════════════════════════════════════
function wsUrl() {
  const base = String(args.server || '').trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(base) ? base : 'http://' + base;
  const wsBase = withScheme.replace(/^http/i, 'ws');   // http→ws, https→wss
  const q = new URLSearchParams({
    userId: args.user,
    api_key: args.key,
    agent: 'local-browser-agent/1.0',
    browser: 'chrome',
    platform: process.platform,
    cdpPort: String(args.port)
  });
  return wsBase + '/local-browser/ws?' + q.toString();
}

let conn = null;
let tunnel = null;
let heartbeat = null;
let retryMs = 1000;
let stopping = false;

function connect() {
  if (stopping) return;
  const url = wsUrl();
  // Log only the path: the query string carries the API key.
  log('Connecting to ' + url.split('?')[0] + ' as user "' + args.user + '"\u2026');

  connectWebSocket(url, { 'x-api-key': args.key }, (err, c) => {
    if (err) {
      warn('Connection failed: ' + err.message);
      scheduleRetry();
      return;
    }
    conn = c;
    tunnel = makeTunnel(c, args.port);
    // Reset the backoff only on a SUCCESSFUL connection. Resetting per attempt
    // would turn a server that accepts then immediately drops into a hot loop.
    retryMs = 1000;

    log('Tunnel up. Local Browser Mode is now available in the project.');
    log('Switch the project to "Local Browser" and run a workflow — it will');
    log('drive the browser on this machine. Ctrl+C here to stop.');

    // The project answers {t:'pong'}. This keeps intermediaries (load balancers,
    // corporate proxies) from reaping what looks like an idle socket during a
    // long pause between automation steps.
    heartbeat = setInterval(() => {
      try { c.sendText(JSON.stringify({ t: 'ping' })); } catch (e) { /* close follows */ }
    }, 25000);

    c.on('close', () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (tunnel) { tunnel.disposeAll(); tunnel = null; }
      conn = null;
      if (stopping) return;
      warn('Tunnel closed. The project has fallen back to Remote mode.');
      scheduleRetry();
    });
  });
}

function scheduleRetry() {
  if (stopping) return;
  // Exponential backoff, capped at 30s: a laptop that sleeps overnight should
  // not have hammered the server thousands of times by morning, but should be
  // back within half a minute of waking.
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, 30000);
  log('Retrying in ' + Math.round(wait / 1000) + 's\u2026');
  const t = setTimeout(connect, wait);
  if (t.unref) t.unref();
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  if (tunnel) tunnel.disposeAll();
  if (conn) { try { conn.close(1000); } catch (e) { /* ignore */ } }
  // A browser WE launched is closed with the agent. One we merely attached to
  // (--attach, or an instance already running) is left alone: the user opened
  // it, and it is not ours to close.
  if (childBrowser) {
    try { childBrowser.kill(); } catch (e) { /* ignore */ }
  }
  const t = setTimeout(() => process.exit(code || 0), 150);
  if (t.unref) t.unref();
}

process.on('SIGINT', () => { log('Stopping\u2026'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

// Exported for the offline unit tests (frame codec + handshake digest). require()
// of this file is a no-op beyond the definitions; main() only runs as a script.
module.exports = {
  encodeFrame, decodeFrame, acceptFor, connectWebSocket, makeTunnel,
  WS_GUID, OP_OPEN, OP_DATA, OP_CLOSE, OP_ERROR, HEADER
};

// ════════════════════════════════════════════════════════════════
async function main() {
  if (args.help) { usage(); process.exit(0); }
  if (!args.server || !args.key) {
    usage();
    console.error('ERROR: --server and --key are required.\n');
    process.exit(1);
  }

  log('Local Browser Agent — ' + process.platform + ', node ' + process.version);
  try {
    await ensureBrowser();
  } catch (e) {
    console.error('\nERROR: ' + ((e && e.message) || e) + '\n');
    process.exit(1);
  }
  connect();
}

// Only when run directly, so `require()` from a test does not launch a browser.
if (require.main === module) main();
