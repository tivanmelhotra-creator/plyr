/* ============================================================
   tools/ui-preview-server.js — DEV-ONLY preview harness

   Serves `public/` and answers the handful of API calls the shell
   makes on boot, so the UI can be screenshotted without Redis, a
   worker, or a real API key. It is NOT part of the product: nothing
   here is reachable from `src/`, and the shipped front end never
   depends on it.

   Why it exists: `python3 -m http.server` is not enough — `app.js#boot`
   validates the stored key against `/me`, and a 404 sends it back to
   the login gate, so every screenshot came out as the sign-in card.

   Stub responses are deliberately EMPTY (`items: []`, `total: 0`) so a
   screenshot can never show invented rows and be mistaken for real
   data — same rule the product UI follows.

   Usage:
       node tools/ui-preview-server.js 8788
       node tools/ui-shot.js '#/editor' /tmp/editor.png
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8788);
const ROOT = path.join(__dirname, '..', 'public');
const PKG = require(path.join(__dirname, '..', 'package.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function json(res, body, status) {
  const text = JSON.stringify(body);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Minimal stand-ins for the endpoints the shell touches on boot. */
function stub(pathname) {
  if (pathname === '/me') {
    return { success: true, userId: 'dev-preview', isAdmin: true, plan: 'vip' };
  }
  if (pathname === '/health') {
    return {
      status: 'ok',
      version: PKG.version,
      env: 'development',
      mode: 'multi',
      uptime: 42,
      timestamp: new Date().toISOString(),
      redis: 'connected',
      luaScripts: 'loaded',
      browsers: { vip: 0, free: 0, total: 0, registeredPages: 0 },
      features: {},
    };
  }
  if (/^\/(workflows|jobs|schedules|executions|connections|templates)/.test(pathname)) {
    return { success: true, items: [], workflows: [], jobs: [], total: 0 };
  }
  if (pathname.indexOf('/user/') === 0 || pathname.indexOf('/admin/') === 0) {
    return { success: true, items: [], total: 0 };
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  const body = stub(pathname);
  if (body) return json(res, body);

  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) return json(res, { error: 'forbidden' }, 403);

  fs.readFile(file, (err, buf) => {
    if (err) return json(res, { error: 'not found', path: pathname }, 404);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[ui-preview] http://localhost:' + PORT + '  root=' + ROOT);
});
