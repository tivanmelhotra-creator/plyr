#!/usr/bin/env node
/**
 * tools/probe-open-timing.js — how long does opening the window actually take,
 * and does `ready` arrive AT ALL when the saved tab points somewhere hopeless?
 *
 * WHY: a full parity-probe run hung indefinitely after printing only its first
 * line. The saved-tab file held `http://127.0.0.1:45070/secret` — an origin that
 * no longer exists, because the auth group deliberately uses a throwaway port
 * and that port dies with the run. So the next open tries to restore a tab whose
 * host is gone.
 *
 * That is exactly the shape the GLOBAL MANDATE forbids: the user opens their
 * browser, the socket connects, and nothing ever appears. `RESTORE_BUDGET_MS`
 * exists to prevent it, so either the budget is not being applied on this path
 * or the hang is somewhere else entirely. This measures it instead of reasoning
 * about it: it prints a timestamp for every event until `ready`, and gives up
 * loudly rather than hanging.
 *
 *   DISPLAY=:99 node tools/probe-open-timing.js
 *   DISPLAY=:99 node tools/probe-open-timing.js --poison   (plant a dead origin first)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { connect } = require('./bvclient');

const TABS = path.join(__dirname, '..', 'profiles', 'sessions', '0.tabs.json');

async function main() {
  if (process.argv.includes('--poison')) {
    // A port nothing is listening on: connect() will hang, not refuse, only if
    // the host blackholes — on loopback it refuses fast, which is itself worth
    // measuring, so also try a routable-but-dead address.
    const url = process.argv.includes('--blackhole')
      ? 'http://10.255.255.1:8080/dead'
      : 'http://127.0.0.1:45070/secret';
    fs.mkdirSync(path.dirname(TABS), { recursive: true });
    fs.writeFileSync(TABS, JSON.stringify({
      v: 1, savedAt: Date.now(), tabs: [{ url, title: url, active: true }],
    }));
    console.log('planted saved tab → ' + url);
  }

  console.log('saved tabs now: ' + (fs.existsSync(TABS) ? fs.readFileSync(TABS, 'utf8') : '(none)'));

  const t0 = Date.now();
  const at = () => String(Date.now() - t0).padStart(6) + 'ms';

  const c = await connect({ userId: '0', key: 'devtoken123' });
  console.log(at() + '  socket open');

  let readyAt = 0;
  const seen = [];
  const stop = setInterval(() => {
    for (const e of c.events.slice(seen.length)) {
      seen.push(e);
      const d = e.t === 'error' ? ' ' + JSON.stringify(e).slice(0, 140) : '';
      if (e.t !== 'frame') console.log(at() + '  ' + e.t + d);
      if (e.t === 'ready' && !readyAt) readyAt = Date.now() - t0;
    }
  }, 100);

  // Deliberately longer than RESTORE_BUDGET_MS (12s) so a budget that works is
  // visible as a pass, and a budget that does not is visible as a timeout.
  const deadline = 45000;
  while (!readyAt && Date.now() - t0 < deadline) await new Promise((r) => setTimeout(r, 200));
  clearInterval(stop);

  if (readyAt) {
    console.log('\nPASS  ready arrived after ' + readyAt + 'ms'
      + (readyAt < 20000 ? ' (within the restore budget + launch)' : ' — SLOW'));
  } else {
    console.log('\nFAIL  no `ready` in ' + deadline + 'ms — the window never opens.');
    console.log('      This is the "dead but connected" state the mandate forbids.');
  }
  await c.close();
  process.exit(readyAt ? 0 : 3);
}

main().catch((e) => { console.error('probe blew up:', e); process.exit(1); });
