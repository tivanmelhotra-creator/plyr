/* ============================================================
   tools/picker-probe2.js — DEV ONLY. The two geometry cases
   HANDOFF 15 § 6.0.2 predicted but could not check statically:

     A. a 1280x720 frame inside a SHORT window — does the page
        image get clipped by `.bvp-shell { max-height: 96vh }`,
        i.e. can the user still see/click the bottom of the page?
     B. the panel is dragged, THEN the window shrinks — the inline
        left/top are absolute px and nothing re-clamps them, so the
        panel can end up outside the stage (`overflow: hidden`),
        taking the selector field and "Use" button with it.

   Usage: node tools/ui-preview-server.js 8788 &
          node tools/picker-probe2.js
   ============================================================ */
'use strict';

const { chromium } = require('playwright');
const base = process.env.UI_BASE || 'http://localhost:8788/index.html';

async function openPicker(page) {
  await page.evaluate(() => {
    window.BrowserView.requestPick(function () {},
      { value: '.btn-primary', url: 'http://localhost:8788/index.html', mode: 'css' });
  });
  await page.waitForTimeout(300);
  // Simulate the first real screencast frame (1280x720), exactly as drawFrame does.
  await page.evaluate(() => {
    const c = document.getElementById('bvp-canvas');
    c.width = 1280; c.height = 720;
    document.getElementById('bvp-empty').style.display = 'none';
  });
  await page.waitForTimeout(150);
}

function geom() {
  const c = document.getElementById('bvp-canvas');
  const s = document.getElementById('bvp-stage');
  const sh = document.querySelector('.bvp-shell');
  const cb = c.getBoundingClientRect(), sb = s.getBoundingClientRect(), hb = sh.getBoundingClientRect();
  return {
    viewport: window.innerWidth + 'x' + window.innerHeight,
    canvasCSS: Math.round(cb.width) + 'x' + Math.round(cb.height),
    stageCSS: Math.round(sb.width) + 'x' + Math.round(sb.height),
    shellH: Math.round(hb.height),
    // The number that matters: page pixels the user cannot see or click.
    canvasClippedPx: Math.max(0, Math.round(cb.bottom - sb.bottom)),
    hintVisible: Math.round(hb.bottom) <= window.innerHeight + 1,
  };
}

(async () => {
  const browser = await chromium.launch();
  const out = {};

  // ---- A. short windows -------------------------------------------------
  out.A_shortWindows = [];
  for (const vp of [[1672, 941], [1440, 800], [1366, 700], [1280, 620], [1200, 560]]) {
    const page = await browser.newPage({ viewport: { width: vp[0], height: vp[1] } });
    await page.addInitScript(() => {
      localStorage.setItem('ab_api_key', 'dev-preview-key');
      localStorage.setItem('ab_user_id', 'dev-preview');
      localStorage.setItem('ab_lang', 'en');
      localStorage.removeItem('ab_flow_graph');
      localStorage.removeItem('abPickerUrl');
    });
    await page.goto(base + '#/editor', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await openPicker(page);
    out.A_shortWindows.push(await page.evaluate(geom));
    await page.close();
  }

  // ---- B. drag then shrink ---------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
  await page.addInitScript(() => {
    localStorage.setItem('ab_api_key', 'dev-preview-key');
    localStorage.setItem('ab_user_id', 'dev-preview');
    localStorage.setItem('ab_lang', 'en');
    localStorage.removeItem('ab_flow_graph');
    localStorage.removeItem('abPickerUrl');
  });
  await page.goto(base + '#/editor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await openPicker(page);

  // Drag the panel to the far bottom-right of a wide stage.
  const head = await page.$('#bvp-drag');
  const hb = await head.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 1400, hb.y + 560, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const probeB = () => {
    const p = document.getElementById('bvp-panel');
    const s = document.getElementById('bvp-stage');
    const pb = p.getBoundingClientRect(), sb = s.getBoundingClientRect();
    const useBtn = document.getElementById('bvp-use').getBoundingClientRect();
    return {
      viewport: window.innerWidth + 'x' + window.innerHeight,
      inline: { left: p.style.left, top: p.style.top },
      stage: Math.round(sb.width) + 'x' + Math.round(sb.height),
      panel: { x: Math.round(pb.left), y: Math.round(pb.top), r: Math.round(pb.right), b: Math.round(pb.bottom) },
      // px of the panel that sit outside the stage (overflow:hidden clips them)
      hiddenRight: Math.max(0, Math.round(pb.right - sb.right)),
      hiddenBottom: Math.max(0, Math.round(pb.bottom - sb.bottom)),
      // is the primary action still on screen and inside the stage?
      useBtnReachable: useBtn.right <= sb.right + 1 && useBtn.bottom <= sb.bottom + 1
        && useBtn.width > 0 && useBtn.left >= sb.left - 1,
    };
  };
  out.B_afterDrag = await page.evaluate(probeB);
  await page.setViewportSize({ width: 1150, height: 700 });
  await page.waitForTimeout(400);
  out.B_afterShrink = await page.evaluate(probeB);
  await page.setViewportSize({ width: 900, height: 620 });
  await page.waitForTimeout(400);
  out.B_afterShrinkMore = await page.evaluate(probeB);

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
