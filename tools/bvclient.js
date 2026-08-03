/**
 * tools/bvclient.js — a scriptable /browser/ws client for LIVE verification.
 *
 * Every claim about the simulated browser in this repo is supposed to be proved
 * against a RUNNING server, not by grepping the source. This is the thing that
 * does the proving: it speaks the same protocol browser-view.js speaks, records
 * every event, and lets a probe script say "click here, then tell me what the
 * server sent back".
 *
 *   const c = await connect({ userId: '0', key: 'devtoken123' });
 *   await c.send({ t: 'navigate', url: 'https://example.com' });
 *   await c.waitFor('navigated');
 *   c.events           // everything, in order
 *   await c.close();
 */
'use strict';

const WebSocket = require('ws');

function connect(opts = {}) {
  const userId = opts.userId || '0';
  const key = opts.key || process.env.API_TOKEN || 'devtoken123';
  const port = opts.port || 3000;
  const url = `ws://127.0.0.1:${port}/browser/ws?userId=${encodeURIComponent(userId)}`
    + `&api_key=${encodeURIComponent(key)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [];
    let frames = 0;
    let lastFrameAt = 0;
    const waiters = [];

    const api = {
      ws,
      events,
      get frames() { return frames; },
      get lastFrameAt() { return lastFrameAt; },
      send(obj) {
        ws.send(JSON.stringify(obj));
        return new Promise((r) => setTimeout(r, 30));
      },
      /** Wait for the next event of type `t` (or one already seen since `from`). */
      waitFor(t, timeoutMs = 15000, from = 0) {
        const existing = events.slice(from).find((e) => e.t === t);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`timeout waiting for "${t}" (saw: ${
              events.map((e) => e.t).filter((x, k, a) => a.indexOf(x) === k).join(',')})`));
          }, timeoutMs);
          const w = { t, res, timer };
          waiters.push(w);
        });
      },
      /** Every event of a type, in arrival order. */
      all(t) { return events.filter((e) => e.t === t); },
      last(t) { const a = api.all(t); return a[a.length - 1] || null; },
      mark() { return events.length; },
      sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
      close() {
        return new Promise((r) => {
          if (ws.readyState !== WebSocket.OPEN) { r(); return; }
          ws.once('close', () => r());
          ws.close();
          setTimeout(r, 2000);
        });
      },
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === 'frame') {
        frames += 1;
        lastFrameAt = Date.now();
        // Frames are huge; keep a stub so the log stays readable.
        events.push({ t: 'frame', width: msg.width, height: msg.height, bytes: (msg.data || '').length });
      } else {
        events.push(msg);
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].t === msg.t) {
          clearTimeout(waiters[i].timer);
          waiters[i].res(events[events.length - 1]);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on('open', () => resolve(api));
    ws.on('error', (e) => reject(e));
  });
}

module.exports = { connect };
