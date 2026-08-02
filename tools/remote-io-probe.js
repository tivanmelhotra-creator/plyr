/**
 * remote-io-probe.js — does the remote clipboard / file bridge actually work?
 *
 * Unit tests pin the seams; this drives the real thing. It serves a page with
 * exactly the two controls the user's extension has — an "Import" button in
 * front of a hidden `<input type="file" accept=".json">`, and an "Export"
 * button that calls navigator.clipboard.writeText() — then, over a real
 * WebSocket session against a running server, checks that:
 *
 *   1. clicking Import raises a `filechooser` message instead of a native
 *      dialog that nobody outside the server could ever see,
 *   2. a file POSTed to /browser/uploads comes back as an opaque token,
 *   3. `fileAccept` with that token makes the PAGE actually receive the bytes,
 *   4. `paste` lands text in the focused field of the remote page,
 *   5. `copy` returns text the remote page put on its own clipboard — the
 *      "extension Export button" case, which has no keystroke at all and is
 *      therefore the one that used to be completely unreachable.
 *
 * The page reports what it received by writing to its OWN clipboard, so the
 * verification uses only commands that already exist.
 *
 * Usage: node tools/remote-io-probe.js [baseUrl] [apiKey]
 */
'use strict';

const http = require('http');
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://localhost:3000';
const KEY = process.argv[3] || process.env.API_TOKEN || 'tok_localtest';
const USER = 'probe-remote-io';
const FIXTURE_PORT = 3907;

// Absolute positions so the probe can click without a DOM query: the canvas is
// a picture, and clicking is done in page coordinates.
const HIT = {
  text: { x: 240, y: 60 },
  import: { x: 140, y: 145 },
  export: { x: 140, y: 225 },
  blank: { x: 900, y: 500 },
};

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>
  body { font: 16px system-ui; margin: 0; background: #fff; }
  #text   { position: absolute; left: 40px; top: 40px;  width: 400px; height: 40px; font-size: 18px; }
  #import { position: absolute; left: 40px; top: 120px; width: 200px; height: 50px; font-size: 18px; }
  #export { position: absolute; left: 40px; top: 200px; width: 200px; height: 50px; font-size: 18px; }
  #got    { position: absolute; left: 40px; top: 280px; }
</style></head><body>
  <input id="text" placeholder="paste here">
  <button id="import">Import</button>
  <input id="file" type="file" accept=".json" style="display:none">
  <button id="export">Export</button>
  <pre id="got">(no file)</pre>
<script>
  document.getElementById('import').onclick = function () {
    document.getElementById('file').click();
  };
  document.getElementById('file').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      var line = 'GOT:' + f.name + ':' + f.size + ':' + r.result;
      document.getElementById('got').textContent = line;
      // Report through the page's own clipboard so the probe can read it back
      // with the very command it is testing.
      if (navigator.clipboard) navigator.clipboard.writeText(line);
    };
    r.readAsText(f);
  };
  document.getElementById('export').onclick = function () {
    navigator.clipboard.writeText('EXPORTED-BY-THE-PAGE');
  };
</script></body></html>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '\n         ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadFile(name, body) {
  // `userId` must match the socket's, or the bytes land in a directory the
  // session never looks in and the hand-over dies with a bare ENOENT.
  const q = `?name=${encodeURIComponent(name)}&userId=${encodeURIComponent(USER)}`;
  const res = await fetch(`${BASE}/browser/uploads${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-api-key': KEY },
    body: Buffer.from(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(`upload failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

function connect() {
  const url = `${BASE.replace(/^http/, 'ws')}/browser/ws`
    + `?userId=${encodeURIComponent(USER)}&api_key=${encodeURIComponent(KEY)}`;
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'frame') return;                          // noise
    if (msg.t === 'error') console.log('   [server error]', msg.message);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });

  return {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    /** Wait for a message; anything already received counts. */
    wait: (pred, ms = 20000) => {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting for message')); }
        }, ms);
      });
    },
    /** Drop history so the next wait() cannot match a stale reply. */
    forget: () => { inbox.length = 0; },
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
  };
}

(async () => {
  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise((r) => fixture.listen(FIXTURE_PORT, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${FIXTURE_PORT}/`;
  console.log(`\u2192 ${BASE} as ${USER}, page ${pageUrl}\n`);

  const c = connect();
  await c.open();
  await c.wait((m) => m.t === 'ready');
  c.send({ t: 'navigate', url: pageUrl });
  await c.wait((m) => m.t === 'navigated');
  await sleep(900);
  console.log('  page loaded\n');

  // ── 1. the native dialog is intercepted ────────────────────────────────
  c.send({ t: 'click', x: HIT.import.x, y: HIT.import.y });
  const chooser = await c.wait((m) => m.t === 'filechooser', 10000);
  check('clicking Import raises a filechooser instead of a native dialog', !!chooser);
  check('the page\u2019s accept list reaches the client', chooser.accept === '.json',
    `accept=${JSON.stringify(chooser.accept)}`);
  check('a single-file input is reported as single', chooser.multiple === false);

  // ── 2. upload → token ──────────────────────────────────────────────────
  const payload = JSON.stringify([{ name: 'sid', value: 'abc123' }]);
  const up = await uploadFile('cookies.json', payload);
  check('POST /browser/uploads returns an opaque token, not a path',
    /^up_[a-f0-9]{24}\.json$/.test(up.token), up.token);
  check('the extension survives, so an accept=".json" page will take it',
    up.token.endsWith('.json'));
  check('the original filename comes back for display only', up.name === 'cookies.json');

  // ── 3. the PAGE receives the bytes ─────────────────────────────────────
  c.forget();
  c.send({ t: 'fileAccept', tokens: [up.token] });
  const done = await c.wait((m) => m.t === 'fileChooserDone', 15000);
  check('the server confirms the hand-over', done.ok === true, JSON.stringify(done));

  await sleep(1200);
  c.forget();
  c.send({ t: 'click', x: HIT.blank.x, y: HIT.blank.y });   // deselect everything
  await sleep(200);
  c.send({ t: 'copy' });
  const got = await c.wait((m) => m.t === 'clipboard', 10000);
  const line = String(got.text || '');
  check('the PAGE really received the file (name, size and bytes)',
    line.startsWith('GOT:cookies.json:') && line.includes('"sid"'),
    line.slice(0, 120));
  check('an extension\u2019s clipboard write is now reachable from here',
    got.source === 'clipboard' || line.length > 0, JSON.stringify(got.source));

  // ── 4. paste from "my computer" into the remote field ──────────────────
  c.forget();
  c.send({ t: 'click', x: HIT.text.x, y: HIT.text.y });
  await sleep(300);
  c.send({ t: 'paste', text: 'HELLO-FROM-MY-LAPTOP' });
  await sleep(600);
  c.send({ t: 'selectAll' });
  await sleep(300);
  c.send({ t: 'copy' });
  const clip = await c.wait((m) => m.t === 'clipboard', 10000);
  check('paste reaches the focused remote field, and Ctrl+C reads it back',
    String(clip.text || '').includes('HELLO-FROM-MY-LAPTOP'), JSON.stringify(clip));

  // ── 5. the Export case: the page writes, we pull ───────────────────────
  c.forget();
  c.send({ t: 'click', x: HIT.export.x, y: HIT.export.y });
  await sleep(800);
  c.send({ t: 'click', x: HIT.blank.x, y: HIT.blank.y });   // nothing selected
  await sleep(300);
  c.send({ t: 'copy' });
  const clip2 = await c.wait((m) => m.t === 'clipboard', 10000);
  check('an Export button\u2019s clipboard write can be pulled with no selection',
    String(clip2.text || '') === 'EXPORTED-BY-THE-PAGE', JSON.stringify(clip2));

  // ── 6. cancelling is clean ─────────────────────────────────────────────
  c.forget();
  c.send({ t: 'click', x: HIT.import.x, y: HIT.import.y });
  await c.wait((m) => m.t === 'filechooser', 10000);
  c.send({ t: 'fileCancel' });
  const cancelled = await c.wait((m) => m.t === 'fileChooserDone', 10000);
  check('cancelling closes the prompt without an error', cancelled.ok === true
    || cancelled.reason === 'cancelled', JSON.stringify(cancelled));

  // ── 7. the socket refuses a path where a token belongs ─────────────────
  c.forget();
  c.send({ t: 'click', x: HIT.import.x, y: HIT.import.y });
  await c.wait((m) => m.t === 'filechooser', 10000);
  c.send({ t: 'fileAccept', tokens: ['../../../etc/passwd'] });
  const refused = await c.wait((m) => m.t === 'fileChooserDone', 10000);
  check('a traversal token is refused instead of read', refused.ok === false,
    JSON.stringify(refused));
  c.send({ t: 'fileCancel' });

  c.ws.close();
  // `close()` alone waits for keep-alive sockets the remote Chrome is still
  // holding, so the probe used to finish its checks and then hang until the
  // outer timeout killed it — and never printed the summary line.
  if (fixture.closeAllConnections) fixture.closeAllConnections();
  fixture.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => {
  console.error('\nprobe crashed:', e.message);
  process.exit(2);
});
