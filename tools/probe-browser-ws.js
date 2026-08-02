/* DEV probe: drive /browser/ws like the UI does and report what comes back.
   Usage: node tools/probe-browser-ws.js [url] [wsBase] [apiKey] [userId]
*/
'use strict';
const WebSocket = require('ws');

const TARGET = process.argv[2] || 'google.com';
const BASE = process.argv[3] || 'ws://localhost:3000';
const KEY = process.argv[4] || 'devtoken123';
const UID = process.argv[5] || '0';

const ws = new WebSocket(`${BASE}/browser/ws?userId=${encodeURIComponent(UID)}&api_key=${encodeURIComponent(KEY)}`);
let frames = 0;
let lastFrame = null;
const t0 = Date.now();
const log = (...a) => console.log(`+${String(Date.now() - t0).padStart(6)}ms`, ...a);

ws.on('open', () => {
  log('open');
  ws.send(JSON.stringify({ t: 'navigate', url: TARGET }));
});
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.t === 'frame') { lastFrame = m.data; frames++; if (frames <= 3 || frames % 25 === 0) log('frame', frames, m.width + 'x' + m.height, 'bytes=' + (m.data || '').length); return; }
  log('event', JSON.stringify(m).slice(0, 300));
});
ws.on('error', (e) => log('ERROR', e.message));
ws.on('close', (c, r) => log('close', c, String(r)));

setTimeout(() => { log('typing into the page (search box test)'); ws.send(JSON.stringify({ t: 'click', x: 640, y: 340 })); }, 8000);
setTimeout(() => { ws.send(JSON.stringify({ t: 'type', text: 'hello world' })); }, 9000);
setTimeout(() => { ws.send(JSON.stringify({ t: 'key', key: 'Enter' })); }, 10000);
setTimeout(() => {
  log('total frames', frames);
  if (lastFrame) {
    require('fs').writeFileSync('/tmp/ws-last-frame.jpg', Buffer.from(lastFrame, 'base64'));
    log('wrote /tmp/ws-last-frame.jpg');
  }
  ws.close();
  process.exit(0);
}, 16000);
