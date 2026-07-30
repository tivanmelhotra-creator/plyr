/* ============================================================
   tools/ui-shot.js — headless UI screenshotter (DEV ONLY)

   Why this exists: every UI change in this repo has to be checked
   against docs/uiux/*.webp, and the sandbox has no display. This
   drives the real static build in Chromium, seeds the API key so the
   login gate is bypassed, and writes PNGs plus a console-error report.

   The system libs Chromium needs are NOT present in a fresh sandbox:
       sudo apt-get update -qq && sudo npx playwright install-deps chromium

   Usage:
       cd public && python3 -m http.server 8788 &
       node tools/ui-shot.js '#/editor' /tmp/editor.png
       node tools/ui-shot.js '#/editor' /tmp/small.png 1280x700
   ============================================================ */
'use strict';

const { chromium } = require('playwright');

const route = process.argv[2] || '#/editor';
const out = process.argv[3] || '/tmp/ui.png';
const size = (process.argv[4] || '1672x941').split('x').map(Number);
const base = process.env.UI_BASE || 'http://localhost:8788/index.html';
const clicks = (process.argv[5] || '').split(',').filter(Boolean);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

  // Seed the API key before any script runs, so app.js does not show the gate.
  await page.addInitScript(() => {
    localStorage.setItem('ab_api_key', 'dev-preview-key');
    localStorage.setItem('ab_user_id', 'dev-preview');
  });

  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  for (const sel of clicks) {
    try { await page.click(sel, { timeout: 2000 }); await page.waitForTimeout(500); }
    catch (e) { errors.push('CLICK FAILED ' + sel + ' — ' + e.message.split('\n')[0]); }
  }
  await page.screenshot({ path: out });
  console.log('shot   :', out, size.join('x'), route);
  console.log('errors :', errors.length ? JSON.stringify(errors, null, 1) : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
