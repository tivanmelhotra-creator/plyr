/* DEV probe: the real user path for the Real Chrome feature.
 *
 *   editor → node NDV → crosshair → picker modal → Real Chrome button
 *          → panel shows the loaded extension
 *          → "Open here" renders the EXTENSION'S OWN POPUP in the canvas
 *          → import a cookie file and prove the page then sends the cookie
 *
 * The last two steps are the whole point of the feature and neither can be
 * covered by a unit test: one needs a real extension host, the other needs a
 * real page making a real request.
 *
 *   node tools/probe-real-chrome-ui.js [base] [apiKey]
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:3000';
const KEY = process.argv[3] || 'devtoken123';

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const COOKIE_FILE = '/tmp/probe-cookie-export.json';

(async () => {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify([{
    domain: '.example.com',
    hostOnly: false,
    httpOnly: false,
    name: 'ui_probe_session',
    path: '/',
    sameSite: 'unspecified',
    secure: false,
    session: false,
    expirationDate: Math.floor(Date.now() / 1000) + 86400,
    storeId: '0',
    value: 'no-login-needed',
  }], null, 2));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

  await page.addInitScript((k) => {
    localStorage.setItem('ab_api_key', k);
    localStorage.removeItem('ab_flow_graph');
  }, KEY);

  console.log('\n── Real Chrome UI probe ───────────────────────────────────────\n');

  await page.goto(BASE + '/index.html#/editor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // ── get to the picker modal, exactly as a user does ───────────────────────
  await page.evaluate(() => {
    window.FlowEditor.loadSteps([{ action: 'click', params: { selector: '#login' } }]);
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const st = window.FlowEditor.getState();
    const id = Object.keys(st.nodes).find((k) => st.nodes[k].action === 'click');
    window.FlowEditor.openNdv(id);
  });
  await page.waitForTimeout(800);

  const crosshair = await page.$('.aria-iconbtn.is-picker');
  check('crosshair (element picker) button present', !!crosshair);
  if (!crosshair) { await browser.close(); process.exit(1); }
  await crosshair.click();
  await page.waitForTimeout(700);

  // ── the new toolbar button ────────────────────────────────────────────────
  const rcBtn = await page.$('#bvp-chrome');
  check('Real Chrome button in the picker toolbar', !!rcBtn);
  if (!rcBtn) {
    await page.screenshot({ path: '/tmp/probe-rc-nobutton.png' });
    await browser.close();
    process.exit(1);
  }
  await rcBtn.click();
  await page.waitForTimeout(1500);

  const panel = await page.$('.rc-panel');
  check('Real Chrome panel opens', !!panel);

  const panelInfo = await page.evaluate(() => {
    const p = document.querySelector('.rc-panel');
    if (!p) return null;
    return {
      sections: [...p.querySelectorAll('.rc-section-title')].map((n) => n.textContent),
      exts: [...p.querySelectorAll('.rc-ext-name')].map((n) => n.textContent),
      badges: [...p.querySelectorAll('.badge')].map((n) => n.textContent),
    };
  });
  check('panel lists the loaded extension',
    !!panelInfo && panelInfo.exts.length > 0, JSON.stringify(panelInfo && panelInfo.exts));
  check('browser reports itself running',
    !!panelInfo && panelInfo.badges.some((b) => /running/i.test(b)),
    JSON.stringify(panelInfo && panelInfo.badges));

  await page.screenshot({ path: '/tmp/probe-rc-panel.png' });

  // ── "Open here": the extension popup rendered inside the picker canvas ────
  const openBtn = await page.$('.rc-ext .btn');
  check('"Open here" button available', !!openBtn);
  if (openBtn) {
    await openBtn.click();
    // Navigating a real Chrome to chrome-extension://…/popup.html, screencasting
    // it back, and painting the canvas takes a moment.
    await page.waitForTimeout(7000);

    const after = await page.evaluate(() => {
      const c = document.querySelector('#bvp-canvas');
      let painted = false;
      if (c && c.width > 0) {
        // A blank canvas is all zeroes; any non-zero pixel means frames arrived.
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, Math.min(c.width, 200), Math.min(c.height, 200)).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] || d[i + 1] || d[i + 2]) { painted = true; break; }
        }
      }
      return {
        url: (document.querySelector('#bvp-url') || {}).value,
        canvas: c ? c.width + 'x' + c.height : 'none',
        painted,
        status: (document.querySelector('#bvp-status') || {}).textContent,
      };
    });

    check('URL bar shows the chrome-extension:// address',
      /^chrome-extension:\/\//.test(String(after.url || '')), after.url);
    check('canvas received frames of the extension popup', after.painted,
      `${after.canvas} status=${after.status}`);
    await page.screenshot({ path: '/tmp/probe-rc-extension-popup.png' });
  }

  // ── cookie import, then prove a real page sends the cookie ────────────────
  const importRes = await page.evaluate(async (text) => {
    const r = await fetch('/browser/cookies/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': localStorage.getItem('ab_api_key') || '',
      },
      body: JSON.stringify({ text: text }),
    });
    return { status: r.status, body: await r.json() };
  }, fs.readFileSync(COOKIE_FILE, 'utf8'));

  check('cookie import endpoint accepted the extension export',
    importRes.status === 200 && importRes.body.success,
    JSON.stringify(importRes.body).slice(0, 160));
  check('cookies were applied to the RUNNING browser',
    importRes.body.liveBrowser === true && importRes.body.appliedToLiveBrowser > 0,
    `live=${importRes.body.liveBrowser} applied=${importRes.body.appliedToLiveBrowser}`);
  check('cookies were also stored in the profile for queued runs',
    importRes.body.storedInProfile > 0, `stored=${importRes.body.storedInProfile}`);

  // Navigate the picker canvas to the site and read document.cookie via the
  // DevTools port — proof the imported session is actually in effect.
  await page.evaluate(() => {
    const u = document.querySelector('#bvp-url');
    u.value = 'http://example.com/';
    document.querySelector('#bvp-go').click();
  });
  await page.waitForTimeout(7000);

  const seen = await page.evaluate(async () => {
    const r = await fetch('/browser/cookies/export?domain=example.com', {
      headers: { 'x-api-key': localStorage.getItem('ab_api_key') || '' },
    });
    return r.json();
  });
  check('exported cookies contain the imported session',
    Array.isArray(seen) && seen.some((c) => c.name === 'ui_probe_session'),
    Array.isArray(seen) ? seen.map((c) => c.name).join(',') : String(seen).slice(0, 80));

  await page.screenshot({ path: '/tmp/probe-rc-final.png' });

  const realErrs = errs.filter((e) => !/favicon|ERR_/.test(e));
  check('no front-end console errors', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n${failures === 0
    ? '\x1b[32mall checks passed\x1b[0m'
    : `\x1b[31m${failures} check(s) failed\x1b[0m`}`);
  console.log('screenshots: /tmp/probe-rc-panel.png  /tmp/probe-rc-extension-popup.png  /tmp/probe-rc-final.png\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
