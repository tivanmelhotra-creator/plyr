/* DEV probe: the exact user path — editor → node NDV → crosshair → simulated
   browser window → type a URL → Go. Screenshots the result.
   Usage: node tools/probe-picker-ui.js [url] [base] [apiKey]
*/
'use strict';
const { chromium } = require('playwright');

const TARGET = process.argv[2] || 'example.com';
const BASE = process.argv[3] || 'http://localhost:3000';
const KEY = process.argv[4] || 'devtoken123';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

  await page.addInitScript((k) => {
    localStorage.setItem('ab_api_key', k);
    localStorage.removeItem('ab_flow_graph');
  }, KEY);

  await page.goto(BASE + '/index.html#/editor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    window.FlowEditor.loadSteps([{ action: 'click', params: { selector: '#login' } }]);
    window.FlowEditor.fitToScreen && window.FlowEditor.fitToScreen();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const st = window.FlowEditor.getState();
    const id = Object.keys(st.nodes).find((k) => st.nodes[k].action === 'click');
    window.FlowEditor.openNdv(id);
  });
  await page.waitForTimeout(800);

  const picker = await page.$('.aria-iconbtn.is-picker');
  console.log('crosshair btn:', !!picker);
  if (!picker) { await page.screenshot({ path: '/tmp/probe-ndv.png' }); await browser.close(); return; }
  await picker.click();
  await page.waitForTimeout(600);
  console.log('picker modal :', await page.evaluate(() => !!document.querySelector('.bvp-backdrop')));

  await page.fill('#bvp-url', TARGET);
  await page.click('#bvp-go');
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const c = document.querySelector('#bvp-canvas');
    return {
      status: (document.querySelector('#bvp-status') || {}).textContent,
      canvas: c ? c.width + 'x' + c.height : 'none',
      emptyVisible: (document.querySelector('#bvp-empty') || {}).style ? document.querySelector('#bvp-empty').style.display : '?',
    };
  });
  console.log('after Go     :', JSON.stringify(info));
  await page.screenshot({ path: '/tmp/probe-picker.png' });

  // Type into the page through the stage, like a user would: click the search
  // field, type, press Enter.
  const cx = Number(process.env.CLICK_X || 0);
  const cy = Number(process.env.CLICK_Y || 0);
  const text = process.env.TYPE_TEXT || '';
  if (text) {
    const c = await page.$('#bvp-canvas');
    const b = await c.boundingBox();
    await page.mouse.click(b.x + b.width * cx, b.y + b.height * cy);
    await page.waitForTimeout(500);
    await page.keyboard.type(text, { delay: 60 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: '/tmp/probe-picker-typed.png' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/probe-picker-search.png' });
  }
  console.log('errors :', errs.length ? JSON.stringify(errs.slice(0, 8), null, 1) : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
