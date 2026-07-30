/* ============================================================
   tools/ui-shot.js — headless UI screenshotter (DEV ONLY)

   Why this exists: every UI change in this repo has to be checked
   against docs/uiux/*.webp, and the sandbox has no display. This
   drives the real static build in Chromium, seeds the API key so the
   login gate is bypassed, and writes PNGs plus a console-error report.

   The system libs Chromium needs are NOT present in a fresh sandbox:
       sudo apt-get update -qq && sudo npx playwright install-deps chromium

   Usage:
       node tools/ui-preview-server.js 8788 &
       node tools/ui-shot.js '#/editor' /tmp/editor.png
       node tools/ui-shot.js '#/editor' /tmp/small.png 1280x700
       node tools/ui-shot.js '#/editor' /tmp/x.png 1672x941 '.flow-node-kebab'

   The 5th argument is a comma-separated list of interaction steps, applied in
   order before the shot:
       '.some-btn'         click it
       'dbl:.flow-node'    double-click it (this is how the NDV opens)
       'key:Escape'        press a key

   Env:
       UI_LANG=en|fa   language to render in (default: whatever i18n defaults to;
                       the locked images are LTR English, the product default is fa)
       UI_SEED=<id>    load a REAL template graph into the canvas before shooting,
                       e.g. UI_SEED=login-form. The steps come from
                       public/js/templates.js and are pushed through the product's
                       own FlowEditor.loadSteps(), so the render shows the real
                       serializer output — never a hand-drawn mock. `UI_SEED=list`
                       prints the available ids.
       UI_WAIT=<ms>    extra settle time before the shot (default 1200)
   ============================================================ */
'use strict';

const { chromium } = require('playwright');

const route = process.argv[2] || '#/editor';
const out = process.argv[3] || '/tmp/ui.png';
const size = (process.argv[4] || '1672x941').split('x').map(Number);
const base = process.env.UI_BASE || 'http://localhost:8788/index.html';
const clicks = (process.argv[5] || '').split(',').filter(Boolean);
const lang = process.env.UI_LANG || '';
const seed = process.env.UI_SEED || '';
const wait = parseInt(process.env.UI_WAIT, 10) || 1200;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

  // Seed the API key before any script runs, so app.js does not show the gate.
  await page.addInitScript(([lg]) => {
    localStorage.setItem('ab_api_key', 'dev-preview-key');
    localStorage.setItem('ab_user_id', 'dev-preview');
    if (lg) localStorage.setItem('ab_lang', lg);
    // A shot must be reproducible: drop any graph a previous run left behind.
    localStorage.removeItem('ab_flow_graph');
  }, [lang]);

  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);

  // Populate the canvas from a REAL template through the product's own loader,
  // so what gets compared against docs/uiux/*.webp is the actual serializer
  // layout. Without this the editor renders its (correct) empty state, which
  // says nothing about node cards, ports, connectors or the minimap.
  if (seed) {
    const info = await page.evaluate((id) => {
      const T = window.TEMPLATES;
      const FE = window.FlowEditor;
      if (!T) return { error: 'window.TEMPLATES missing' };
      if (id === 'list') return { ids: T.ids() };
      if (!FE || !FE.loadSteps) return { error: 'FlowEditor.loadSteps missing' };
      const tpl = T.byId(id);
      if (!tpl) return { error: 'no such template: ' + id, ids: T.ids() };
      FE.loadSteps(tpl.steps);
      if (FE.fitToScreen) FE.fitToScreen();
      return { loaded: id, steps: tpl.steps.length };
    }, seed);
    console.log('seed   :', JSON.stringify(info));
    if (info && info.error) errors.push('SEED ' + info.error);
    await page.waitForTimeout(600);
  }

  // A step may be `selector`, `dbl:selector` (the NDV opens on double-click) or
  // `key:Escape`. Anything that fails is reported rather than swallowed: a shot
  // of a panel that never opened looks exactly like a shot of a broken panel.
  for (const step of clicks) {
    try {
      if (step.startsWith('dbl:')) {
        await page.dblclick(step.slice(4), { timeout: 2000 });
      } else if (step.startsWith('key:')) {
        await page.keyboard.press(step.slice(4));
      } else {
        await page.click(step, { timeout: 2000 });
      }
      await page.waitForTimeout(500);
    } catch (e) {
      errors.push('STEP FAILED ' + step + ' — ' + e.message.split('\n')[0]);
    }
  }
  await page.screenshot({ path: out });
  console.log('shot   :', out, size.join('x'), route);
  console.log('errors :', errors.length ? JSON.stringify(errors, null, 1) : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
