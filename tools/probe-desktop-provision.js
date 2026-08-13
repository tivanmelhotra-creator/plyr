/**
 * probe-desktop-provision.js — prove Remote Browser can actually run here.
 *
 * WHY A PROBE AND NOT A UNIT TEST. The bug being fixed was that the product
 * SAID the stack was missing and offered a remedy the user could not perform.
 * A unit test with a mocked `which` would have passed happily against the
 * broken code, because the broken code was internally consistent — what it got
 * wrong was its relationship with the real machine. So this asks the OPERATING
 * SYSTEM, not the code:
 *
 *   - is there an X display?          -> X's own /tmp/.X<n>-lock file
 *   - is VNC exported?                -> TCP connect to the RFB port
 *   - is noVNC being served?          -> HTTP GET /vnc.html, expect 200
 *
 * Every line it prints is KEY=value so a regression is a diff, and it ends in
 * VERDICT=PASS or VERDICT=FAIL with a non-zero exit so it can gate a change.
 *
 * Run: node tools/probe-desktop-provision.js
 */

'use strict';

require('tsx/cjs');

const net = require('net');
const http = require('http');
const { promises: fs } = require('fs');
const { execFile } = require('child_process');

// High, unlikely-to-collide ports and display so the probe never fights a real
// session that may already be running on the defaults.
process.env.DESKTOP_AUTO_PROVISION = 'true';
process.env.REAL_CHROME_DISPLAY = ':91';
process.env.DESKTOP_VNC_PORT = '5991';
process.env.DESKTOP_NOVNC_PORT = '6091';
process.env.DESKTOP_ENABLED = 'true';

const VNC_PORT = 5991;
const NOVNC_PORT = 6091;
const DISPLAY_NUM = '91';

const out = [];
function say(key, value) {
  const line = `${key}=${value}`;
  out.push(line);
  console.log(line);
}

function tcpOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function httpStatus(port, path_, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: path_, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.once('error', () => resolve(0));
    req.once('timeout', () => { req.destroy(); resolve(0); });
  });
}

function sh(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function main() {
  const { Desktop } = require('../src/core/Desktop.ts');
  const { isProvisioned, layoutFor, resolveXkbDataDir } = require('../src/core/DesktopProvision.ts');

  // ── The precondition that made the original bug unfixable by the user ──
  const sudo = await sh('sh', ['-c', 'command -v sudo || true']);
  const id = await sh('id', ['-u']);
  say('SUDO_AND_UID', `${sudo.stdout.trim() || 'none'} ${id.stdout.trim()}`);
  const sudoNP = await sh('sudo', ['-n', 'true'], 5000);
  say('PASSWORDLESS_SUDO', sudoNP.ok);
  const usrWritable = await sh('sh', ['-c', 'touch /usr/bin/__probe 2>&1 && rm -f /usr/bin/__probe && echo yes || echo no']);
  say('USR_BIN_WRITABLE', usrWritable.stdout.trim().includes('yes'));

  say('MISSING_BEFORE', (await Desktop.missingBinaries()).join(',') || 'none');

  // ── The thing the user actually presses ──
  const t0 = Date.now();
  let startError = '';
  try {
    await Desktop.start();
  } catch (e) {
    startError = e && e.message ? e.message : String(e);
  }
  say('START_SECONDS', Math.round((Date.now() - t0) / 1000));
  say('START_ERROR', startError || 'none');

  const steps = Desktop.provisionState().steps;
  for (const s of steps) console.log(`STEP ${s}`);

  say('MISSING_AFTER', (await Desktop.missingBinaries()).join(',') || 'none');

  const layout = layoutFor();
  say('PROVISIONED_TREE', await isProvisioned(layout));
  say('XKB_DATA_DIR', (await resolveXkbDataDir(layout)) || 'none(system default)');

  // ── Ask the OS, not the code ──
  const lock = await fs.stat(`/tmp/.X${DISPLAY_NUM}-lock`).then(() => true).catch(() => false);
  const sock = await fs.stat(`/tmp/.X11-unix/X${DISPLAY_NUM}`).then(() => true).catch(() => false);
  say('DISPLAY_RUNNING', lock || sock);

  say('VNC_LISTENING', await tcpOpen(VNC_PORT));
  say('NOVNC_LISTENING', await tcpOpen(NOVNC_PORT));
  say('NOVNC_HTTP_VNC_HTML', await httpStatus(NOVNC_PORT, '/vnc.html'));

  const st = await Desktop.status();
  say('STATUS_RUNNING', st.running);
  say('STATUS_DISPLAY_RUNNING', st.displayRunning);

  // ── The claim that matters: can a HEADED browser draw on it? ──
  let windowSeen = 'skipped';
  if (lock || sock) {
    const xwin = await sh('xwininfo', ['-display', `:${DISPLAY_NUM}`, '-root'], 8000);
    windowSeen = xwin.ok ? 'root window queryable' : `xwininfo failed: ${xwin.stderr.trim().split('\n')[0]}`;
  }
  say('X_ROOT_WINDOW', windowSeen);

  const pass =
    (lock || sock) &&
    (await tcpOpen(VNC_PORT)) &&
    (await tcpOpen(NOVNC_PORT)) &&
    (await httpStatus(NOVNC_PORT, '/vnc.html')) === 200;

  say('VERDICT', pass ? 'PASS' : 'FAIL');

  await Desktop.stop().catch(() => {});
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  say('PROBE_CRASH', e && e.stack ? e.stack.split('\n')[0] : String(e));
  say('VERDICT', 'FAIL');
  process.exit(1);
});
