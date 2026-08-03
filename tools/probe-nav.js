/** tools/probe-nav.js — do Back / Forward / Reload / + actually work? */
'use strict';
const { connect } = require('./bvclient');

function tail(c, m) {
  return c.events.slice(m).filter((e) => e.t !== 'frame')
    .map((e) => e.t + (e.url ? '(' + e.url + ')' : '') + (e.message ? '!' + String(e.message).slice(0, 60) : ''))
    .join(' | ');
}

(async () => {
  const c = await connect({ userId: 'probe-nav' });
  await c.waitFor('ready', 60000);
  console.log('ready');

  for (const u of ['https://example.com', 'https://www.iana.org/help/example-domains']) {
    const m = c.mark();
    await c.send({ t: 'navigate', url: u });
    await c.sleep(6000);
    console.log('nav ' + u + ' =>', tail(c, m));
  }

  for (const cmd of ['back', 'forward', 'reload']) {
    const m = c.mark();
    await c.send({ t: cmd });
    await c.sleep(6000);
    console.log(cmd + ' =>', tail(c, m));
  }

  // Past the start of history: Chrome greys the button out, it is not an error.
  let m = c.mark();
  await c.send({ t: 'back' });
  await c.sleep(4000);
  await c.send({ t: 'back' });
  await c.sleep(4000);
  await c.send({ t: 'back' });
  await c.sleep(4000);
  console.log('3x back =>', tail(c, m));

  // Does anything ever tell the client whether Back is even possible?
  const hasCanGo = c.events.some((e) => 'canGoBack' in e || 'canGoForward' in e);
  console.log('canGoBack/canGoForward ever reported:', hasCanGo);

  await c.close();
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
