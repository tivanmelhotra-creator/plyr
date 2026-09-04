/**
 * THE RETRY BUTTON, AS THE OPERATOR ACTUALLY SEES IT.
 *
 * `probe-retry-button.mjs` calls the `retryBtn()` factory, which proves the
 * button can be built. This proves something different and stronger: that a
 * Retry is actually RENDERED beside every crosshair inside a real node's NDV.
 *
 *   «یک دکمه Retry کنار Picker اضافه شود»
 *
 * MEASURED FACTS THIS RELIES ON
 *   · the dashboard must load at /#/editor, or FlowEditor is unmounted
 *   · loadSteps() REASSIGNS node ids to n1, n2, … so ids are read back
 *   · getState().nodes is a KEYED OBJECT, not an array
 *   · an `if` node renders 1 picker in its NDV; a `type` node renders 0
 *   · the picker selector is `button.is-picker`
 *
 * Run: node probe-ndv-retry.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3000';
const fail = [];
function check(cond, label, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) fail.push(label);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript((k) => { localStorage.setItem('ab_api_key', k); }, 'admin123');
  await page.goto(`${BASE}/#/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // `if` and `click` both declare a `selector`, so both render crosshairs;
  // `if` additionally renders condition ROWS, which is where the row-level
  // picker (and therefore a row-level Retry) has to appear.
  const nodes = await page.evaluate(() => {
    const FE = window.FlowEditor;
    FE.loadSteps([
      { action: 'if', params: { source: 'selector', selector: '.x', operator: 'equals', value: '1' } },
      { action: 'click', params: { selector: '.btn' } },
    ]);
    const st = FE.getState();
    // A KEYED OBJECT — Object.values, not .map.
    return Object.values(st.nodes)
      .filter((n) => n.action !== '__start__')
      .map((n) => ({ id: n.id, action: n.action }));
  });
  console.log(`\n  nodes: ${JSON.stringify(nodes)}`);
  check(nodes.length > 0, 'a workflow with pickable fields loaded');

  for (const n of nodes) {
    console.log(`\n=== NDV for ${n.id} (${n.action}) ===`);
    await page.evaluate((id) => {
      document.querySelectorAll('.ndv-backdrop, .ndv-modal').forEach((e) => e.remove());
      window.FlowEditor.openNdv(id);
    }, n.id);
    await page.waitForTimeout(2000);

    const counts = await page.evaluate(() => ({
      pickers: document.querySelectorAll('button.is-picker').length,
      retries: document.querySelectorAll('button.is-retry').length,
      retryTitles: [...document.querySelectorAll('button.is-retry')]
        .map((b) => b.title || '').slice(0, 2),
    }));
    console.log(`  pickers=${counts.pickers} retries=${counts.retries}`);
    if (counts.retryTitles.length) console.log(`  title: ${counts.retryTitles[0]}`);

    check(counts.pickers > 0, `${n.action}: renders at least one Picker`,
      `${counts.pickers}`);
    // The requirement is a Retry BESIDE the Picker, so the counts must match:
    // one crosshair with no Retry is a field the operator cannot repeat.
    check(counts.retries === counts.pickers,
      `${n.action}: a Retry sits beside EVERY Picker`,
      `pickers=${counts.pickers} retries=${counts.retries}`);
  }

  console.log('\n================ RESULT ================');
  if (fail.length === 0) console.log('ALL CHECKS PASSED - every crosshair has a Retry beside it.');
  else {
    console.log(`${fail.length} CHECK(S) FAILED:`);
    fail.forEach((f) => console.log(`  - ${f}`));
  }
  await browser.close();
  process.exit(fail.length === 0 ? 0 : 1);
})();
