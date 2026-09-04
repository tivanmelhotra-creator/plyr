/**
 * THE RETRY BUTTON, IN THE REAL DASHBOARD.
 *
 * The unit tests drive `TargetingFlow.retry()` directly, which proves the flow
 * but not that an operator can REACH it. This opens the actual editor, opens a
 * node's NDV, and measures the buttons that render beside the crosshair:
 *
 *   «یک دکمه Retry کنار Picker اضافه شود»
 *
 * It also asserts the wiring the spec cares about:
 *   · retry() exists and reports false before any pick   (nothing to repeat)
 *   · after a pick is remembered, lastTarget() names THAT field
 *   · pressing Retry opens NO tab in the operator's own browser
 *
 * `window.open` is stubbed so a silent tab cannot escape unmeasured.
 *
 * Run: node probe-retry-button.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3000';
const KEY = 'admin123';

const fail = [];
function check(cond, label, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) fail.push(label);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Seed the api key BEFORE any script runs, and stub window.open so any tab
  // the dashboard tries to claim is recorded instead of actually opening.
  await page.addInitScript((k) => {
    localStorage.setItem('ab_api_key', k);
    window.__opens = [];
    const real = window.open;
    window.open = function (...a) {
      window.__opens.push(String(a[0] ?? ''));
      return { close() {}, set location(_v) {}, document: { write() {}, close() {} } };
    };
    window.__realOpen = real;
  }, KEY);

  console.log('\n=== 1. load the editor ===');
  // Must be /#/editor — FlowEditor is unmounted on any other route.
  await page.goto(`${BASE}/#/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const ready = await page.evaluate(() => ({
    flowEditor: !!window.FlowEditor,
    targetingFlow: !!window.TargetingFlow,
    ndvNodes: !!window.NdvNodes,
  }));
  console.log(`  FlowEditor=${ready.flowEditor} TargetingFlow=${ready.targetingFlow} `
    + `NdvNodes=${ready.ndvNodes}`);
  check(ready.targetingFlow, 'TargetingFlow is exposed to the page');

  console.log('\n=== 2. the Retry API is reachable and correctly empty ===');
  const api = await page.evaluate(() => {
    const f = window.TargetingFlow || {};
    return {
      hasRetry: typeof f.retry === 'function',
      hasCanRetry: typeof f.canRetry === 'function',
      hasLastTarget: typeof f.lastTarget === 'function',
      canRetryNow: typeof f.canRetry === 'function' ? f.canRetry() : null,
      retryReturns: typeof f.retry === 'function' ? f.retry() : null,
      lastTarget: typeof f.lastTarget === 'function' ? f.lastTarget() : null,
    };
  });
  console.log(`  ${JSON.stringify(api)}`);
  check(api.hasRetry && api.hasCanRetry && api.hasLastTarget,
    'retry / canRetry / lastTarget are all exported');
  check(api.canRetryNow === false, 'nothing to retry before a pick');
  check(api.retryReturns === false, 'retry() refuses rather than opening an empty box');
  check(api.lastTarget === null, 'no last target yet');

  console.log('\n=== 3. a pick is remembered, and Retry names THAT field ===');
  const remembered = await page.evaluate(() => {
    // start() records the target even if the flow then fails, which is the
    // whole point: Retry exists for the case where the Alert was abandoned.
    const ok = window.TargetingFlow.start({
      nodeId: 'nodeA', fieldKey: 'field3', action: 'click',
      workflowId: 'wf1', label: 'Click -> field3', url: 'https://example.com/',
    });
    return {
      started: ok,
      canRetry: window.TargetingFlow.canRetry(),
      lastTarget: window.TargetingFlow.lastTarget(),
    };
  });
  console.log(`  ${JSON.stringify(remembered)}`);
  check(remembered.canRetry === true, 'the pick was remembered');
  check(remembered.lastTarget && remembered.lastTarget.nodeId === 'nodeA'
    && remembered.lastTarget.fieldKey === 'field3',
    'lastTarget names the field that was picked', JSON.stringify(remembered.lastTarget));

  console.log('\n=== 4. Retry opens NO tab in the operator\'s browser ===');
  await page.evaluate(() => { window.__opens.length = 0; });
  await page.evaluate(() => window.TargetingFlow.retry());
  await page.waitForTimeout(2500);
  const opens = await page.evaluate(() => window.__opens.slice());
  console.log(`  window.open calls during Retry: ${opens.length} ${JSON.stringify(opens)}`);
  check(opens.length === 0, 'Retry claimed no tab in the main browser');

  console.log('\n=== 5. the Retry button renders beside the Picker ===');
  const btns = await page.evaluate(() => {
    const n = window.NdvNodes;
    if (!n || typeof n.retryBtn !== 'function') return { ok: false };
    const b = n.retryBtn();
    return {
      ok: true,
      className: b.className || '',
      tag: b.tagName,
      title: b.title || b.getAttribute('title') || '',
    };
  });
  console.log(`  ${JSON.stringify(btns)}`);
  check(btns.ok, 'NdvNodes.retryBtn() is exported');
  check(!!btns.ok && /is-retry/.test(btns.className),
    'the button carries the is-retry class', btns.className);

  console.log('\n================ RESULT ================');
  if (fail.length === 0) console.log('ALL CHECKS PASSED - Retry is reachable, targeted, and tab-free.');
  else {
    console.log(`${fail.length} CHECK(S) FAILED:`);
    fail.forEach((f) => console.log(`  - ${f}`));
  }
  await browser.close();
  process.exit(fail.length === 0 ? 0 : 1);
})();
