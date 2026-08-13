#!/usr/bin/env node
/**
 * probe-session-handoff.js — drive the Remote <-> Local switch over real HTTP.
 *
 * WHY THIS EXISTS
 * ---------------
 * The unit tests cover the registry and the client's decisions, but neither of
 * them proves that the ROUTES wire up: that a code issued by /handoff/start can
 * actually be redeemed by /handoff/pair from an UNAUTHENTICATED caller (the
 * extension has no API key), that /handoff/pull serves the tabs in order with
 * one active, that the mode flips only at /handoff/complete, and that the same
 * automation session id survives a full round trip Remote -> Local -> Remote.
 *
 * So this boots the real Express router in-process, talks to it with real
 * fetch() calls over a real socket, and plays BOTH parties: the app (API key)
 * and the extension (bearer token only). Nothing about the handoff is stubbed —
 * only the browser underneath it, because the point here is the protocol.
 *
 * Prints VERDICT=PASS/FAIL and exits non-zero on failure so it can gate a
 * release.
 */
'use strict';

process.env.DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'single';
process.env.BROWSER_MODE_DEFAULT = process.env.BROWSER_MODE_DEFAULT || 'remote';
process.env.LOCAL_BROWSER_ENABLED = 'true';

const path = require('path');

// tsx lets us require the TypeScript sources directly, so the probe tests the
// code that ships rather than a stale dist/ build.
require('tsx/cjs');

const express = require('express');

const ROOT = path.join(__dirname, '..');
const { createModeRoutes } = require(path.join(ROOT, 'src/Routes/mode.routes.ts'));
const { sessionHandoff, buildSnapshot } = require(path.join(ROOT, 'src/core/SessionHandoff.ts'));
const { setLiveSessionProvider } = require(path.join(ROOT, 'src/core/LiveSessions.ts'));
const {
  BROWSER_MODES,
  setLocalAvailabilityProbe,
  isLocalModeEnabled,
} = require(path.join(ROOT, 'src/core/BrowserMode.ts'));

const USER = 'probe-user';
const API_KEY = 'PROBE-KEY';

const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  if (!ok) failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail == null ? '' : ' -> ' + detail));
}

/**
 * The tabs a "remote browser" is holding when the user clicks switch.
 * Deliberately includes a file:// URL and more entries than the cap so the
 * sanitising and the cap are exercised by the probe, not just by unit tests.
 */
const REMOTE_TABS = [
  { url: 'https://example.test/one', title: 'One' },
  { url: 'https://example.test/two', title: 'Two', active: true },
  { url: 'file:///etc/passwd', title: 'should not travel' },
  { url: 'https://example.test/three', title: 'Three' },
];

const LOCAL_TABS = [
  { url: 'https://local.test/a', title: 'A', active: true },
  { url: 'https://local.test/b', title: 'B' },
];

let liveTabs = REMOTE_TABS;

async function main() {
  // A fake live session: the probe is about the handoff protocol, so the browser
  // underneath is the one thing stubbed. It still returns a realistic shape,
  // including a storageState, so cookie carry-over is observable.
  // The shape here is not invented: LiveBrowser.snapshotForHandoff() returns a
  // buildSnapshot() result, so the probe calls buildSnapshot() too. Hand-rolling
  // the object would let the probe pass against a shape the real browser never
  // produces, which is worse than not probing at all.
  setLiveSessionProvider({
    forUser() {
      return {
        snapshotForHandoff: async (sessionId) => buildSnapshot({
          sessionId,
          fromMode: 'remote',
          tabs: liveTabs,
          storage: {
            cookies: [{ name: 'sid', value: 'abc', domain: 'example.test', path: '/' }],
            origins: [],
          },
        }),
      };
    },
  });
  setLocalAvailabilityProbe(() => true);

  const app = express();
  app.use(express.json());
  // Stand in for the auth middleware: an API key identifies the app, and its
  // ABSENCE must still let /handoff/pair through, because the extension has no
  // key. That asymmetry is the thing worth probing.
  app.use((req, _res, next) => {
    if (req.headers['x-api-key'] === API_KEY) req.apiKeyUserId = USER;
    next();
  });
  app.use(createModeRoutes());

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const asApp = (p, init) => hit(base + p, init, API_KEY);
  const asExt = (p, init) => hit(base + p, init, null);

  try {
    console.log('== modes: ' + JSON.stringify(BROWSER_MODES) +
      ' local_enabled=' + isLocalModeEnabled() + ' ==');
    // Local mode must be on, or the whole probe would pass vacuously by never
    // being allowed to switch anywhere.
    check('local mode is enabled for this probe', isLocalModeEnabled() === true);
    sessionHandoff.reset();

    // ---- 1. the session id, before anything happens -----------------------
    const s0 = await asApp('/browser-mode/session');
    const sessionId = s0.body.sessionId;
    check('session route answers', s0.status === 200 && s0.body.success === true, s0.status);
    check('session id looks like as_<hex>', /^as_[0-9a-f]{24}$/.test(String(sessionId)), sessionId);
    check('starts in remote', s0.body.mode === 'remote', s0.body.mode);

    // ---- 2. REMOTE -> LOCAL ----------------------------------------------
    liveTabs = REMOTE_TABS;
    const start = await asApp('/browser-mode/handoff/start', { method: 'POST', body: { to: 'local' } });
    check('start(local) succeeds', start.status === 200 && start.body.success !== false, start.status);
    const pairing = start.body.pairing || {};
    check('a pairing code was issued', !!pairing.code, JSON.stringify(pairing).slice(0, 120));
    check('the code is grouped for typing', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(pairing.display || '')), pairing.display);
    check('the code excludes lookalike glyphs', !/[0O1IL]/.test(String(pairing.code || '')), pairing.code);
    check('an expiry travels with it', Number(pairing.expiresAt) > Date.now(), pairing.expiresAt);
    check('install instructions are offered', !!(start.body.extension && start.body.extension.downloadPath),
      JSON.stringify(start.body.extension || {}).slice(0, 140));

    // THE headline invariant: starting a switch must not mint a new session.
    check('start did NOT reissue the session id', start.body.sessionId === sessionId, start.body.sessionId);
    // And the mode must NOT have moved yet -- a user whose install fails here
    // has to still be in the mode that works.
    const midway = await asApp('/browser-mode/session');
    check('mode is still remote before the extension reports in', midway.body.mode === 'remote', midway.body.mode);
    check('the pending handoff is visible', !!midway.body.pendingHandoff, JSON.stringify(midway.body.pendingHandoff));

    // ---- 3. the extension pairs, with NO api key -------------------------
    const badPair = await asExt('/browser-mode/handoff/pair', { method: 'POST', body: { code: 'ZZZZ-ZZZZ' } });
    check('a wrong code is refused', badPair.body.ok === false || badPair.status >= 400, badPair.status + ' ' + JSON.stringify(badPair.body).slice(0, 90));

    const pair = await asExt('/browser-mode/handoff/pair', { method: 'POST', body: { code: pairing.display } });
    check('the extension pairs without an API key', pair.status === 200 && !!pair.body.token,
      pair.status + ' ' + JSON.stringify(pair.body).slice(0, 120));
    check('pairing reports the SAME session id', pair.body.sessionId === sessionId, pair.body.sessionId);
    const token = pair.body.token;

    // Replay: the code is single-use, and a spent one must say so specifically.
    const replay = await asExt('/browser-mode/handoff/pair', { method: 'POST', body: { code: pairing.display } });
    const replayReason = String(replay.body && (replay.body.reason || replay.body.error || ''));
    check('a replayed code is rejected', replay.body.ok !== true, JSON.stringify(replay.body).slice(0, 120));
    check('and it is reported as already_used, not as a typo', /already_used/.test(replayReason), replayReason);

    // ---- 4. the extension pulls the tabs --------------------------------
    const noAuth = await asExt('/browser-mode/handoff/pull');
    check('pull without the token is refused', noAuth.status === 401 || noAuth.body.success === false, noAuth.status);

    const pull = await asExt('/browser-mode/handoff/pull', { token });
    check('pull with the token succeeds', pull.status === 200 && pull.body.success !== false, pull.status);
    const tabs = (pull.body.snapshot && pull.body.snapshot.tabs) || pull.body.tabs || [];
    const urls = tabs.map((t) => t.url);
    check('the same URLs arrive, in the same order',
      JSON.stringify(urls) === JSON.stringify(['https://example.test/one', 'https://example.test/two', 'https://example.test/three']),
      JSON.stringify(urls));
    check('the file:// tab was dropped server-side', urls.every((u) => !/^file:/i.test(u)), JSON.stringify(urls));
    const actives = tabs.filter((t) => t.active);
    check('exactly one tab is active', actives.length === 1, actives.length);
    check('and it is the one that was active on remote', actives[0] && actives[0].url === 'https://example.test/two',
      actives[0] && actives[0].url);
    // `storage`, the field the route actually serves -- not `storageState`, which
    // is Playwright's own name for it and never crosses this wire.
    const storage = pull.body.snapshot && pull.body.snapshot.storage;
    check('cookies travel with the snapshot', !!(storage && storage.cookies && storage.cookies.length),
      JSON.stringify(storage || {}).slice(0, 100));

    // Pull is a PEEK by default: a crashed extension must be able to ask twice.
    const pull2 = await asExt('/browser-mode/handoff/pull', { token });
    const tabs2 = (pull2.body.snapshot && pull2.body.snapshot.tabs) || pull2.body.tabs || [];
    check('pull can be repeated (peek, not drain)', tabs2.length === tabs.length, tabs2.length + ' vs ' + tabs.length);

    // ---- 5. completion is what flips the mode ---------------------------
    const complete = await asExt('/browser-mode/handoff/complete', {
      token,
      method: 'POST',
      body: { to: 'local', restoredTabs: tabs.length, activeTabRestored: true },
    });
    check('complete succeeds', complete.status === 200 && complete.body.success !== false,
      complete.status + ' ' + JSON.stringify(complete.body).slice(0, 120));

    const afterLocal = await asApp('/browser-mode/session');
    check('the app now reports local', afterLocal.body.mode === 'local', afterLocal.body.mode);
    check('the session id is STILL the same one', afterLocal.body.sessionId === sessionId, afterLocal.body.sessionId);
    check('the pending handoff was cleared', !afterLocal.body.pendingHandoff, JSON.stringify(afterLocal.body.pendingHandoff));

    // ---- 6. LOCAL -> REMOTE, the reverse direction ----------------------
    liveTabs = LOCAL_TABS;
    const back = await asApp('/browser-mode/handoff/start', { method: 'POST', body: { to: 'remote' } });
    check('start(remote) succeeds', back.status === 200 && back.body.success !== false, back.status);
    // Going back needs no pairing at all: the server already has that browser.
    check('going back needs NO pairing code', !(back.body.pairing && back.body.pairing.code),
      JSON.stringify(back.body.pairing || null));
    const backCap = back.body.captured || {};
    check('the LOCAL tabs were captured before the flip', Number(backCap.tabCount) === 2, JSON.stringify(backCap).slice(0, 120));

    const doneBack = await asApp('/browser-mode/handoff/complete', {
      method: 'POST',
      body: { to: 'remote', restoredTabs: backCap.tabCount || 0, activeTabRestored: true },
    });
    check('complete(remote) succeeds', doneBack.status === 200 && doneBack.body.success !== false, doneBack.status);

    const roundTrip = await asApp('/browser-mode/session');
    check('back on remote', roundTrip.body.mode === 'remote', roundTrip.body.mode);
    check('ONE automation session survived the full round trip',
      roundTrip.body.sessionId === sessionId, roundTrip.body.sessionId + ' vs ' + sessionId);

    // ---- 7. a cancelled switch leaves nothing behind --------------------
    const s2 = await asApp('/browser-mode/handoff/start', { method: 'POST', body: { to: 'local' } });
    check('a second switch can be started', !!(s2.body.pairing && s2.body.pairing.code), s2.status);
    const cancelled = await asApp('/browser-mode/handoff/cancel', { method: 'POST', body: {} });
    check('cancel succeeds', cancelled.status === 200, cancelled.status);
    const afterCancel = await asApp('/browser-mode/session');
    check('cancel dropped the snapshot', !afterCancel.body.pendingHandoff, JSON.stringify(afterCancel.body.pendingHandoff));
    check('cancel did NOT change the mode', afterCancel.body.mode === 'remote', afterCancel.body.mode);
    check('cancel did NOT change the session id', afterCancel.body.sessionId === sessionId, afterCancel.body.sessionId);
    const deadCode = await asExt('/browser-mode/handoff/pair', { method: 'POST', body: { code: s2.body.pairing.display } });
    check('a cancelled code no longer pairs', deadCode.body.ok !== true, JSON.stringify(deadCode.body).slice(0, 120));

    // ---- 8. the extension download the UI advertises --------------------
    const inst = await asApp('/browser-mode/extension');
    check('install info is served', inst.status === 200 && !!inst.body, inst.status);
    const steps = (inst.body && (inst.body.install || inst.body).steps) || [];
    check('install steps are a list, not a blob', Array.isArray(steps) && steps.length > 0, JSON.stringify(steps).slice(0, 120));

    const dl = await asApp('/extension/download', { raw: true });
    check('the advertised download really exists (not a 404)', dl.status === 200, dl.status);
    check('it is a zip', /zip/i.test(String(dl.contentType || '')), dl.contentType);
    check('the zip is non-trivial', Number(dl.bytes) > 2000, dl.bytes + ' bytes');
    check('the seeded API key is NOT inside it', dl.hasBootstrap === false, 'bootstrap.config.js present=' + dl.hasBootstrap);
  } finally {
    server.close();
  }

  console.log('');
  console.log('CHECKS=' + results.length + ' FAILED=' + failed);
  console.log('VERDICT=' + (failed === 0 ? 'PASS' : 'FAIL'));
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * One HTTP call.
 *
 * The session token rides in `x-session-token`, which is the header the real
 * extension sends (extension/lib/ab-handoff.js). Probing with a different header
 * would test a protocol nothing speaks.
 */
async function hit(url, init, apiKey) {
  const o = init || {};
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  if (o.token) headers['x-session-token'] = o.token;
  if (o.body) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: o.method || 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });

  if (o.raw) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: buf.length,
      // Read the zip's central directory as text: enough to see whether the
      // generated bootstrap.config.js (which carries an API key) leaked in.
      hasBootstrap: buf.toString('latin1').includes('bootstrap.config.js'),
      body: null,
    };
  }

  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_e) { body = { _text: text.slice(0, 200) }; }
  return { status: res.status, body };
}

main().catch((err) => {
  console.error('probe crashed:', err && err.stack ? err.stack : err);
  console.log('VERDICT=FAIL');
  process.exit(1);
});
