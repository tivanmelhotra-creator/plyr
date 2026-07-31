/* ============================================================
   tools/picker-probe.js — DEV ONLY measurement probe for the
   Element Picker modal (BrowserView.requestPick).

   HANDOFF 15 § 6.0 asked for the modal to be *rendered and driven*
   before any further picker work, because it had only ever been
   verified statically. A screenshot proves it paints; it does not
   prove the geometry contract holds once a real 1280x720 frame
   lands on the canvas, nor that the drag clamp survives a resize.
   This probe measures those things and prints numbers.

   Usage:
       node tools/ui-preview-server.js 8788 &
       UI_LANG=en node tools/picker-probe.js
       UI_LANG=fa node tools/picker-probe.js
   ============================================================ */
'use strict';

const { chromium } = require('playwright');

const base = process.env.UI_BASE || 'http://localhost:8788/index.html';
const lang = process.env.UI_LANG || 'en';
const size = (process.env.UI_SIZE || '1672x941').split('x').map(Number);

// A real screencast frame is a 1280x720 JPEG. We only need the <img> to have
// those intrinsic dimensions, so a 1280x720 PNG data URL drawn by the page
// itself is an honest stand-in for `drawFrame`.
const FRAME_W = 1280;
const FRAME_H = 720;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

  await page.addInitScript(([lg]) => {
    localStorage.setItem('ab_api_key', 'dev-preview-key');
    localStorage.setItem('ab_user_id', 'dev-preview');
    if (lg) localStorage.setItem('ab_lang', lg);
    localStorage.removeItem('ab_flow_graph');
    localStorage.removeItem('abPickerUrl');
  }, [lang]);

  await page.goto(base + '#/editor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // Open the picker directly through its public entry point. No canvas
  // hit-testing, no NDV dependency: this is the seam the crosshair calls.
  await page.evaluate(() => {
    window.__picked = null;
    window.BrowserView.requestPick(function (v) { window.__picked = v; },
      { value: '.btn-primary', url: 'http://localhost:8788/index.html', mode: 'css' });
  });
  await page.waitForTimeout(400);

  const report = { lang: lang, viewport: size.join('x') };

  // ---- 1. computed layout of the pieces the spec pins down ---------------
  report.layout = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const cs = (el, p) => el ? getComputedStyle(el)[p] : null;
    return {
      shell: r(document.querySelector('.bvp-shell')),
      bar: r(document.querySelector('.bvp-bar')),
      stage: r(g('bvp-stage')),
      canvas: r(g('bvp-canvas')),
      panel: r(g('bvp-panel')),
      hint: r(document.querySelector('.bvp-hint')),
      modeSelect: r(g('bvp-mode')),
      modeFlex: cs(g('bvp-mode'), 'flex'),
      modeWidth: cs(g('bvp-mode'), 'width'),
      emptyPointerEvents: cs(g('bvp-empty'), 'pointerEvents'),
      selDir: cs(g('bvp-sel'), 'direction'),
      urlDir: cs(g('bvp-url'), 'direction'),
      selTextAlign: cs(g('bvp-sel'), 'textAlign'),
      docDir: document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction,
      backdropZ: cs(document.querySelector('.bvp-backdrop'), 'zIndex'),
    };
  });

  // ---- 2. what happens when a real 1280x720 frame arrives ---------------
  report.afterFrame = await page.evaluate(([w, h]) => {
    const canvas = document.getElementById('bvp-canvas');
    const stage = document.getElementById('bvp-stage');
    const empty = document.getElementById('bvp-empty');
    // Exactly what drawFrame() does with a frame of this size.
    canvas.width = w; canvas.height = h;
    empty.style.display = 'none';
    const cb = canvas.getBoundingClientRect();
    const sb = stage.getBoundingClientRect();
    const shell = document.querySelector('.bvp-shell').getBoundingClientRect();
    return {
      canvas: { w: Math.round(cb.width), h: Math.round(cb.height), y: Math.round(cb.top) },
      stage: { w: Math.round(sb.width), h: Math.round(sb.height), y: Math.round(sb.top) },
      shell: { h: Math.round(shell.height), bottom: Math.round(shell.bottom) },
      viewportH: window.innerHeight,
      // The honest question: can the user SEE and REACH the bottom of the page?
      canvasClippedBy: Math.max(0, Math.round(cb.bottom - sb.bottom)),
      shellOverflowsViewport: Math.max(0, Math.round(shell.bottom - window.innerHeight)),
    };
  }, [FRAME_W, FRAME_H]);

  // ---- 3. does the canvas->page coordinate mapping stay true? -----------
  // toPoint() scales by canvas.width / rect.width. If the canvas is letterboxed
  // the mapping must still land on the same page pixel.
  report.mapping = await page.evaluate(([w, h]) => {
    const canvas = document.getElementById('bvp-canvas');
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width || 1;
    const sy = canvas.height / rect.height || 1;
    const mid = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    return {
      scaleX: Number(sx.toFixed(4)),
      scaleY: Number(sy.toFixed(4)),
      centerMapsTo: {
        x: Math.round((mid.clientX - rect.left) * sx),
        y: Math.round((mid.clientY - rect.top) * sy),
      },
      expectedCenter: { x: w / 2, y: h / 2 },
    };
  }, [FRAME_W, FRAME_H]);

  // ---- 4. the drag clamp, before and after a viewport resize ------------
  // requestPick captures the stage rect at mousedown and reuses it for the
  // whole gesture; HANDOFF 15 § 6.0.2 flagged this as wrong after a resize.
  const dragHead = await page.$('#bvp-drag');
  const hb = await dragHead.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 300, hb.y + hb.height / 2 + 160, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  report.dragged = await page.evaluate(() => {
    const p = document.getElementById('bvp-panel');
    const s = document.getElementById('bvp-stage');
    const pb = p.getBoundingClientRect(), sb = s.getBoundingClientRect();
    return {
      inlineLeft: p.style.left || '(unset)',
      inlineTop: p.style.top || '(unset)',
      inlineRight: p.style.right || '(unset)',
      insetInlineEnd: getComputedStyle(p).insetInlineEnd,
      // Did the panel actually end up inside the stage?
      escapesStageLeft: Math.round(sb.left - pb.left),
      escapesStageTop: Math.round(sb.top - pb.top),
      movedFromDefault: p.style.left !== '' || p.style.top !== '',
    };
  });

  // Resize, then drag again with the stale-rect bug in play.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(300);
  const dh2 = await page.$('#bvp-drag');
  const hb2 = await dh2.boundingBox();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb2.x + hb2.width / 2 + 900, hb2.y + hb2.height / 2 + 900, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  report.dragAfterResize = await page.evaluate(() => {
    const p = document.getElementById('bvp-panel');
    const s = document.getElementById('bvp-stage');
    const pb = p.getBoundingClientRect(), sb = s.getBoundingClientRect();
    return {
      inlineLeft: p.style.left, inlineTop: p.style.top,
      stage: { w: Math.round(sb.width), h: Math.round(sb.height) },
      panel: { x: Math.round(pb.left), y: Math.round(pb.top), w: Math.round(pb.width) },
      // >0 means the panel's grab handle is now unreachable: dragged out of view.
      overflowRight: Math.max(0, Math.round(pb.left - sb.right + 40)),
      overflowBottom: Math.max(0, Math.round(pb.top - sb.bottom + 40)),
    };
  });

  report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
