#!/usr/bin/env node
/**
 * probe-viewer-workflow-id.mjs — drive the REAL UI path and record what URL the
 * Local Browser viewer tab actually gets, and what its Workflow Files drawer
 * shows.
 *
 *   login → editor → new workflow → add a `click` node (wired to Start) →
 *   Save ▾ → Save as version (the UI's own name prompt) → [mode step] → open
 *   the node's NDV → press the crosshair → choose "Local Browser" → capture
 *   the tab the UI opened → read its URL → open the Workflow Files drawer
 *   inside it → read the listing.
 *
 * Nothing is built by hand: no /desktop/chrome navigation, no manual bind, no
 * localStorage surgery on the happy paths. Prints a JSON report and exits
 * non-zero when the outcome is not the one the mode expects.
 *
 *   node tools/probe-viewer-workflow-id.mjs [baseUrl] [apiKey]
 *
 *   PROBE_MODE=direct   (default) save, then pick in the same page
 *   PROBE_MODE=reload   Save changes + reload the editor between save and pick
 *                       (the operator's usual path: save, come back later, pick)
 *   PROBE_MODE=stale    THE LOOP. The browser remembers a workflow id the
 *                       server does not have (Redis reset / restore / fresh
 *                       machine). Expected AFTER the fix: the editor drops the
 *                       dead id on mount, so the pick either carries no id or
 *                       a freshly saved one -- never the dead one -- and the
 *                       viewer never paints a fake empty workspace for it.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const KEY = process.argv[3] || 'admin123';
const MODE = process.env.PROBE_MODE || (process.env.PROBE_RELOAD === '1' ? 'reload' : 'direct');
const DEAD_ID = 'wf_e6f57f105ef2ee33';

const report = { mode: MODE, steps: [] };
const log = (k, v) => {
  report.steps.push({ [k]: v });
  console.log(`[probe] ${k}:`, typeof v === 'string' ? v : JSON.stringify(v));
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  (pageerror)', e.message));
page.on('dialog', (d) => d.accept('Probe price scrape'));
const http4xx = [];
context.on('response', async (r) => {
  if (r.status() >= 400 && /workflow-files|\/workflows\//.test(r.url())) {
    http4xx.push({ status: r.status(), method: r.request().method(), url: r.url().replace(/api_key=[^&]*/, 'api_key=***') });
  }
});

const toasts = () => page.evaluate(() =>
  [...document.querySelectorAll('.toast, [class*="toast"]')].map((e) => e.textContent.trim()).filter(Boolean));

async function openEditor() {
  await page.evaluate(() => { location.hash = '#/editor'; });
  await page.waitForSelector('#fe-canvas', { timeout: 20000 });
  await page.waitForFunction(() =>
    window.FlowEditor && window.InspectorClient && window.TargetingFlow && window.BrowserView);
}
const clickNodeId = () => page.evaluate(() => {
  const s = window.FlowEditor.getState();
  return Object.keys(s.nodes).find((id) => s.nodes[id].action === 'click');
});
async function saveMenu(act) {
  await page.click('#fe-save-btn');
  await page.waitForSelector(`#fe-save-menu [data-act="${act}"]`, { state: 'visible', timeout: 5000 });
  await page.click(`#fe-save-menu [data-act="${act}"]`);
}
async function reloadEditor() {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-screen', { state: 'hidden', timeout: 20000 });
  await openEditor();
  await page.waitForTimeout(800);
}

try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.fill('#api-key-input', KEY);
  await page.click('#login-btn');
  await page.waitForSelector('#login-screen', { state: 'hidden', timeout: 20000 });
  log('login', 'ok');

  await openEditor();
  await page.evaluate(() => window.FlowEditor.newWorkflow());
  // A node whose NDV has the crosshair (designed nodes: click / if / while),
  // wired to Start so toSteps() (what Save serialises) is non-empty.
  await page.evaluate(() => window.FlowEditor.loadSteps([{ action: 'click', params: { selector: 'h1' } }]));
  let nodeId = await clickNodeId();
  log('nodeAdded', nodeId);

  let saved = null;
  if (MODE !== 'stale') {
    await saveMenu('version');
    try {
      await page.waitForFunction(() => { const c = window.FlowEditor.getCurrentWorkflow(); return c && c.id; }, null, { timeout: 15000 });
    } catch (e) { log('save.toasts', await toasts()); throw e; }
    saved = await page.evaluate(() => window.FlowEditor.getCurrentWorkflow());
    log('savedWorkflow', { id: saved.id, name: saved.name, version: saved.version });
  }

  if (MODE === 'reload') {
    await saveMenu('save');
    await page.waitForTimeout(300);
    await reloadEditor();
    const cur = await page.evaluate(() => window.FlowEditor.getCurrentWorkflow());
    log('reloaded.currentWorkflow', cur && cur.id);
    nodeId = await clickNodeId();
  }

  if (MODE === 'stale') {
    // The one thing this mode fabricates: what a browser holds after the
    // server lost its data. Graph saved by the UI's own Save changes; the
    // identity record is then replaced by an id the server never issued.
    await saveMenu('save');
    await page.waitForTimeout(300);
    await page.evaluate((id) => {
      localStorage.setItem('ab_flow_workflow', JSON.stringify({ id, name: 'Old workflow', version: 3 }));
    }, DEAD_ID);
    await reloadEditor();
    await page.waitForTimeout(1500); // the verification GET is async
    const cur = await page.evaluate(() => window.FlowEditor.getCurrentWorkflow());
    log('stale.currentWorkflowAfterMount', cur && cur.id ? cur.id : null);
    log('stale.toasts', await toasts());
    log('stale.statusbar', await page.evaluate(() => (document.getElementById('fe-statusbar') || {}).textContent || ''));
    report.editorDroppedDeadId = !(cur && cur.id === DEAD_ID);
    nodeId = await clickNodeId();
  }

  await page.evaluate((id) => window.FlowEditor.openNdv(id), nodeId);
  await page.waitForSelector('.is-picker', { timeout: 10000 });

  await page.evaluate(() => {
    const bv = window.BrowserView; const orig = bv.openRealBrowser;
    window.__probeCalls = [];
    bv.openRealBrowser = function (url, tab, opts) {
      window.__probeCalls.push({ url, hasTab: !!tab, opts });
      return orig.apply(this, arguments);
    };
  });

  const popupPromise = context.waitForEvent('page', { timeout: 60000 });
  await page.locator('.is-picker').first().click();
  await page.waitForSelector('.tgt-card[data-env="local"]', { timeout: 15000 });
  await page.locator('.tgt-card[data-env="local"]').click();
  const viewer = await popupPromise;
  await page.waitForTimeout(1500);
  log('openRealBrowserCalls', await page.evaluate(() => window.__probeCalls));

  const deadline = Date.now() + 90000;
  let url = viewer.url();
  while (Date.now() < deadline && !/\/desktop\/chrome/.test(url)) { await viewer.waitForTimeout(1000); url = viewer.url(); }
  log('viewerUrl', url.replace(/api_key=[^&]*/, 'api_key=***'));
  const viewerWf = new URL(url).searchParams.get('workflowId');
  log('viewer.workflowId', viewerWf);

  await viewer.waitForLoadState('domcontentloaded');
  await viewer.waitForSelector('#burger', { state: 'visible', timeout: 60000 }).catch(() => {});
  await viewer.waitForTimeout(1000);
  await viewer.evaluate(() => { const b = document.getElementById('burger'); if (b) b.click(); });
  await viewer.waitForTimeout(2500);
  const files = await viewer.evaluate(() => ({
    note: (document.getElementById('wfmnote') || {}).textContent || '',
    list: [...document.querySelectorAll('#wfmlist li')].map((li) => li.textContent.trim().replace(/\s+/g, ' ')).slice(0, 10),
  }));
  log('viewer.workflowFiles', files);
  log('serverBinding', await page.evaluate(() => window.API.get('/browser/workflow-files-binding')));
  log('http4xx', http4xx);

  const listsWorkspace = files.list.some((s) => /uploads|downloads/.test(s));
  const paintsFakeEmpty = files.list.some((s) => /This folder is empty/.test(s));
  if (MODE === 'stale') {
    report.viewerCarriesDeadId = viewerWf === DEAD_ID;
    report.viewerPaintsFakeEmptyWorkspace = paintsFakeEmpty;
    report.ok = report.editorDroppedDeadId && !report.viewerCarriesDeadId && !paintsFakeEmpty;
  } else {
    report.viewerHasWorkflowId = viewerWf === saved.id;
    report.drawerListsWorkspace = listsWorkspace;
    report.ok = report.viewerHasWorkflowId && listsWorkspace;
  }
} catch (e) {
  log('ERROR', (e && e.stack) || String(e));
  report.error = String((e && e.message) || e);
  report.ok = false;
} finally {
  console.log('\n=== REPORT ===\n' + JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.ok ? 0 : 1);
}
