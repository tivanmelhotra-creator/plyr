/* ============================================================
   tools/uiverify/verify-baseurl.js — real-browser verification of the
   Base URL shown beside the Authorization Code.

   Task 3 of the spec: «در کنار کد اتورایز بیس یو ار ال هم اگر قبلا دامین
   ست کرده اونو میایس و قابل کپی نمایش میدیم یا ایپی و پورت سرور رو»

   src/core/PublicBaseUrl.ts has 41 unit tests, and every one of them
   stops at the resolver's return value. None of them prove:

     - that the value reaches the screen at all,
     - that it lands beside the pairing code rather than on some other step,
     - that the row's own Copy button copies the URL and not the code,
     - that the UI is DATA-BOUND to the server instead of quietly printing
       its own window.location.

   That last one is the reason this file exists as a browser harness rather
   than another unit test. In every ordinary run the resolved address is
   `http://localhost:<port>`, which is character-for-character what
   `location.origin` would produce — so a UI that ignored the server
   completely would pass a naive DOM assertion. Part 2 below rewrites the
   /begin response in flight to a sentinel the browser could not possibly
   derive locally, which is the only way to tell the two apart.

   Five things this harness learned the hard way, written down because each
   one cost a debugging cycle and all are easy to reintroduce:

   1. The panel authenticates from `localStorage['ab_api_key']` (see
      public/js/api.js), NOT from a `?token=` query parameter. Passing a
      token in the URL leaves the page on the sign-in wall and every API
      call 401s, with the dialog never appearing and nothing saying why.

   2. `#login-screen` is always present in index.html and is merely
      display:none'd once a key is accepted. A textContent search for its
      wording therefore matches even when signed in — it must be probed by
      its rendered box instead.

   3. `window.TargetingFlow` exposes only `start` / `close` / `isOpen`.
      `renderAuthorize` is internal, so the dialog has to be produced the
      way a click produces it: start(), then click the LOCAL card.

   4. The environment cards are `.tgt-grid button`, and their handler calls
      onChoose() directly — no separate "Continue" is interposed. Searching
      every <button> on the page instead hits a decoy first.

   5. LOCAL is the only branch that issues a pairing code, so it is the
      only branch a Base URL is meaningful for.

   Usage:
       # a server must be listening, with an API token this harness can use
       AB_BASE=http://127.0.0.1:3111 AB_TOKEN=testtoken123 \
         node tools/uiverify/verify-baseurl.js

   Exit code is 0 only if every check passed.
   ============================================================ */

'use strict';

const { chromium } = require('playwright');

const BASE = process.env.AB_BASE || 'http://127.0.0.1:3111';
const TOKEN = process.env.AB_TOKEN || 'testtoken123';

// A value the client could not invent: a scheme, host and port that appear
// nowhere in the sandbox and differ from location.origin in all three parts.
const SENTINEL = 'https://sentinel.example.test:8443';

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  const suffix = detail !== undefined ? `  — ${JSON.stringify(detail)}` : '';
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${suffix}`);
}

/** Sign in the way the app does, and confirm the gate is really gone. */
async function signIn(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => localStorage.setItem('ab_api_key', tok), TOKEN);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  return page.evaluate(() => {
    const gate = document.getElementById('login-screen');
    if (!gate) return { signedIn: true, reason: 'no login screen in DOM' };
    const r = gate.getBoundingClientRect();
    const vis = getComputedStyle(gate);
    const onScreen = r.width > 0 && r.height > 0
      && vis.display !== 'none' && vis.visibility !== 'hidden';
    return {
      signedIn: !onScreen,
      display: vis.display,
      box: { w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
}

/**
 * Drive the shipped flow to the authorize step.
 * Resolves to { chose, arrived } — `arrived` false means the row never came,
 * which is a product failure and not harness impatience, because the wait is
 * on the selector rather than a fixed sleep.
 */
async function openAuthorize(page, nodeId) {
  const started = await page.evaluate((id) => window.TargetingFlow
    && window.TargetingFlow.start({
      nodeId: id, fieldKey: 'url', action: 'goto', label: 'URL',
    }), nodeId);
  await page.waitForTimeout(1200);

  const chose = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tgt-grid button')];
    const hit = cards.find((n) => /local/i.test(n.textContent || ''));
    if (!hit) {
      return { ok: false, seen: cards.map((n) => (n.textContent || '').trim().slice(0, 26)) };
    }
    hit.click();
    return { ok: true, clicked: (hit.textContent || '').trim().slice(0, 40) };
  });

  let arrived = true;
  try {
    await page.waitForSelector('.tgt-base', { state: 'attached', timeout: 12000 });
  } catch (e) {
    arrived = false;
  }
  return { started, chose, arrived };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ── Part 1 — the row renders, reads correctly, and copies the right thing ──
  console.log('\nPart 1 — the Base URL row in the real Authorize dialog');
  const ctx1 = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx1.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const gate = await signIn(page);
  check('the panel is signed in (login gate not on screen)', gate.signedIn === true, gate);

  const flow = await openAuthorize(page, 'ui-real-1');
  check('TargetingFlow.start() opened the dialog', flow.started === true, flow.started);
  check('the LOCAL environment card was clickable', flow.chose.ok === true, flow.chose);
  check('the Base URL row arrived after the pairing round trip', flow.arrived);

  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const row = q('.tgt-base');
    const url = q('.tgt-base-url');
    const copy = q('.tgt-base-copy');
    const codeEl = q('.tgt-code');
    const rect = row ? row.getBoundingClientRect() : null;
    const panel = q('.tgt-panel');
    const pRect = panel ? panel.getBoundingClientRect() : null;
    return {
      hasRow: !!row,
      urlText: url ? url.textContent.trim() : null,
      urlTag: url ? url.tagName : null,
      hasCopy: !!copy,
      copyText: copy ? copy.textContent.trim() : null,
      labelText: q('.tgt-base-label') ? q('.tgt-base-label').textContent.trim() : null,
      srcText: q('.tgt-base-src') ? q('.tgt-base-src').textContent.trim() : null,
      visible: rect ? rect.width > 0 && rect.height > 0 : false,
      rect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      codeShown: codeEl ? codeEl.textContent.trim() : null,
      // Inside the dialog, not spilling out of it: a row that renders but
      // overflows the panel is not usable even though it exists.
      insidePanel: !!(rect && pRect
        && rect.top >= pRect.top - 1 && rect.bottom <= pRect.bottom + 1
        && rect.left >= pRect.left - 1 && rect.right <= pRect.right + 1),
    };
  });

  check('the Base URL row rendered in the real dialog', dom.hasRow, dom.hasRow || dom);
  if (dom.hasRow) {
    check('the row is visible with real layout size', dom.visible, dom.rect);
    check('the row sits inside the dialog panel', dom.insidePanel, dom.rect);
    check('it shows a resolved http(s) Base URL', /^https?:\/\/[^\s]+$/.test(dom.urlText || ''), dom.urlText);
    check('the URL is a <code> element (monospace, per the design)', dom.urlTag === 'CODE', dom.urlTag);
    check('the row carries its own Copy button', dom.hasCopy, dom.copyText);
    check('the row is labelled for the operator', !!dom.labelText, dom.labelText);
    check('the address source is qualified', !!dom.srcText, dom.srcText);
    check('the pairing code is shown alongside it', !!dom.codeShown, dom.codeShown);
    check('the Base URL is not the pairing code', dom.urlText !== dom.codeShown, {
      url: dom.urlText, code: dom.codeShown,
    });

    // The single most likely silent failure: the row's Copy button reaching
    // for the code (the value every other button here copies) instead of the
    // URL. It would still say "Copied", so only the clipboard reveals it.
    const copied = await page.evaluate(async () => {
      const btn = document.querySelector('.tgt-base-copy');
      const url = document.querySelector('.tgt-base-url').textContent.trim();
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      let clip = 'unreadable';
      try { clip = await navigator.clipboard.readText(); } catch (e) { /* ignore */ }
      return { clip, label: btn.textContent.trim(), url };
    });
    check('Copy puts the BASE URL on the clipboard (not the code)',
      copied.clip === copied.url, { clipboard: copied.clip, expected: copied.url });
    check('Copy confirms itself on the button', /copied|کپی/i.test(copied.label), copied.label);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3));

  try {
    await page.screenshot({ path: '.ui-verify/baseurl-authorize.png' });
  } catch (e) { /* the screenshot is evidence, not a check */ }
  await ctx1.close();

  // ── Part 2 — the row is data-bound to the server, not to location.origin ──
  console.log('\nPart 2 — the value comes from the SERVER, not the client');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();

  let rewrote = false;
  await page2.route('**/inspector/targeting/begin*', async (route) => {
    const resp = await route.fetch();
    let body;
    try { body = await resp.json(); } catch (e) { return route.fulfill({ response: resp }); }
    if (body && body.baseUrl) {
      body.baseUrl = SENTINEL;
      body.baseUrlSource = 'configured';
      rewrote = true;
    }
    return route.fulfill({ response: resp, body: JSON.stringify(body), contentType: 'application/json' });
  });

  await signIn(page2);
  const flow2 = await openAuthorize(page2, 'bind-1');
  check('the server response carried a baseUrl to rewrite', rewrote, rewrote);
  check('the dialog reached the authorize step', flow2.arrived);

  if (flow2.arrived) {
    const shown = await page2.evaluate(() => ({
      url: document.querySelector('.tgt-base-url').textContent.trim(),
      src: document.querySelector('.tgt-base-src')
        ? document.querySelector('.tgt-base-src').textContent.trim() : null,
      origin: location.origin,
    }));
    check('the UI shows the SERVER value, not its own origin',
      shown.url === SENTINEL, shown);
    check('the shown value really differs from location.origin',
      shown.url !== shown.origin, shown);
    // baseUrlSource drives the qualifier. If the label ignored it, an operator
    // would be told a guessed LAN address is a configured domain.
    check('the source label followed the server too',
      /configured|domain|دامین/i.test(shown.src || ''), shown.src);
  }
  await ctx2.close();

  await browser.close();
  console.log(`\n${fail === 0 ? '\u2713' : '\u2717'} ${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR:', e && e.message ? e.message : e);
  process.exit(2);
});
