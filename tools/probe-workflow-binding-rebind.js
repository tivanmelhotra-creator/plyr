/**
 * LIVE PROOF for PR #32 — the Workflow Files drawer follows the Local Browser's
 * CURRENT binding, on the REAL stack (dist/ + Redis + real Chrome on Xvfb).
 *
 * Reported: a viewer opened WITHOUT ?workflowId (the noTab / Retry path never
 * opens one with it) kept listing workflow A after Retry had bound the shared
 * browser to workflow B. Downloads and uploads then went to the wrong workflow.
 *
 * What it asserts, in order:
 *   1. Library -> Edit A -> reload keeps the saved identity.
 *   2. Picker -> Local Browser opens a viewer pinned to A (URL) listing A.
 *   3. A viewer without a URL id derives A from GET /browser/workflow-files-binding.
 *   4. BrowserView.openRealBrowser(noTab, workflowId: B) opens NO tab, and the
 *      derived viewer now lists B only, with A's selection cleared.
 *   5. Toolbar Upload files under B/uploads only (not A).
 *   6. Download returns the exact uploaded bytes.
 *   7. The ?workflowId=A viewer stays pinned to A.
 *   8. Deleting B clears the binding; the derived drawer says "not opened from a saved workflow".
 *   9. A later bind is picked up by the same still-open viewer.
 *  10. No page errors in any tab.
 *
 * Run:   node tools/probe-workflow-binding-rebind.js
 * Env:   PLYR_BASE (default http://127.0.0.1:3000)
 *        PLYR_API_KEY, or PLYR_TOKEN_FILE (default artifacts/runtime/token)
 *        PLYR_OUT (default artifacts/runtime) — screenshot + downloaded file
 * Needs: server running with REAL_CHROME_ENABLED, REDIS_URL, Xvfb on REAL_CHROME_DISPLAY.
 * Exits non-zero on any failure.
 */
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

(async () => {
  const base = process.env.PLYR_BASE || 'http://127.0.0.1:3000';
  const key = process.env.PLYR_API_KEY
    || fs.readFileSync(process.env.PLYR_TOKEN_FILE || 'artifacts/runtime/token', 'utf8').trim();
  const out = process.env.PLYR_OUT || 'artifacts/runtime';
  fs.mkdirSync(out, { recursive: true });
  const api = async (p, m = 'GET', body) => {
    const r = await fetch(base + p, {
      method: m,
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    assert(r.ok && j.success !== false, p + ' -> ' + JSON.stringify(j));
    return j;
  };

  const ids = [];
  for (const n of ['A', 'B']) {
    const j = await api('/workflows/local', 'POST', {
      name: 'Verification ' + n,
      steps: [{ action: 'goto', url: 'https://example.com' }, { action: 'click', params: { selector: 'h1' } }],
    });
    const id = j.workflow?.id || j.id;
    assert(id, JSON.stringify(j));
    ids.push(id);
    await api('/browser/workflow-files/' + id + '/file', 'POST', { name: 'only-' + n + '.txt', content: 'bytes for ' + n });
  }
  fs.writeFileSync(path.join(out, 'verification-ids.json'), JSON.stringify(ids));
  console.log('created workflows', ids);

  const b = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const c = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    // Only same-origin frames have storage; an opaque-origin frame (about:blank
    // popup before navigation, sandboxed iframe) throws on access. The guard
    // keeps the HARNESS from being the source of a page error.
    await c.addInitScript((k) => {
      try { localStorage.setItem('ab_api_key', k); localStorage.setItem('ab_lang', 'en'); } catch (e) { /* opaque origin */ }
    }, key);
    const errors = [];
    c.on('page', (p) => p.on('pageerror', (err) => errors.push(p.url() + ' :: ' + err.message + '\n' + (err.stack || ''))));

    // 1. Library -> Edit A -> reload keeps identity.
    const e = await c.newPage();
    await e.goto(base + '/#/workflows');
    await e.locator('.wf-card').filter({ hasText: 'Verification A' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await e.waitForFunction((id) => FlowEditor.getCurrentWorkflow()?.id === id, ids[0]);
    await e.reload();
    await e.waitForFunction((id) => FlowEditor.getCurrentWorkflow()?.id === id, ids[0]);
    console.log('PASS saved workflow identity survives reload');

    // 2. Picker -> Local Browser opens a viewer pinned to A and lists A's files.
    await e.evaluate(() => FlowEditor.openNdv(Object.values(FlowEditor.getState().nodes).find((n) => n.action === 'click').id));
    await e.locator('button.is-picker').first().click();
    const pp = c.waitForEvent('page');
    await e.locator('[data-env="local"]').click();
    const pinned = await pp;
    await pinned.waitForURL('**/desktop/chrome*', { timeout: 60000 });
    await pinned.locator('#burger').click();
    await pinned.locator('[data-name="only-A.txt"]').waitFor({ timeout: 30000 });
    assert.equal(new URL(pinned.url()).searchParams.get('workflowId'), ids[0]);
    console.log('PASS library -> reload -> picker -> correct workflow A');

    // 3. A viewer WITHOUT workflowId derives A from the server binding.
    const p = await c.newPage();
    await p.goto(base + '/desktop/chrome?api_key=' + key);
    await p.locator('#burger').click();
    await p.locator('[data-name="only-A.txt"]').waitFor({ timeout: 30000 });
    await p.locator('#dall').click();
    assert.notEqual(await p.locator('#dcount').innerText(), '');
    await p.locator('#dclose').click();

    // 4. noTab rebind A -> B (the Retry path) must not open a tab and the
    //    derived viewer must now list B only, with selection cleared.
    const pages = c.pages().length;
    await e.evaluate(async (id) => BrowserView.openRealBrowser('', null, { noTab: true, workflowId: id }), ids[1]);
    for (let i = 0; i < 100; i++) {
      if ((await api('/browser/workflow-files-binding')).local?.workflowId === ids[1]) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await api('/browser/workflow-files-binding')).local.workflowId, ids[1]);
    assert.equal(c.pages().length, pages);
    await p.locator('#burger').click();
    await p.locator('[data-name="only-B.txt"]').waitFor({ timeout: 30000 });
    assert.equal(await p.locator('[data-name="only-A.txt"]').count(), 0);
    assert.equal(await p.locator('#dcount').innerText(), '');
    console.log('PASS noTab A -> B rebind clears old files and selection');

    // 5. Upload through the UI lands under B only.
    // The operator's path: toolbar Upload button -> native chooser. The button
    // is what targets uploads/ at the workspace root; the bare input has no target.
    const chooserPromise = p.waitForEvent('filechooser');
    await p.locator('#wfmupload').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'uploaded-B.txt', mimeType: 'text/plain', buffer: Buffer.from('exact upload bytes\n') });
    await p.locator('[data-path="uploads/uploaded-B.txt"]').waitFor({ timeout: 30000 });
    assert((await api('/browser/workflow-files/' + ids[1] + '?path=uploads')).entries.some((x) => x.name === 'uploaded-B.txt'));
    assert(!(await api('/browser/workflow-files/' + ids[0] + '?path=uploads')).entries.some((x) => x.name === 'uploaded-B.txt'));
    console.log('PASS UI upload filed under B only');

    // 6. Download returns exact bytes.
    await p.locator('[data-path="uploads/uploaded-B.txt"]').click();
    const dp = p.waitForEvent('download');
    await p.locator('#ddownsel').click();
    const dl = await dp;
    const saved = path.join(out, 'downloaded-B.txt');
    await dl.saveAs(saved);
    assert.equal(fs.readFileSync(saved, 'utf8'), 'exact upload bytes\n');
    console.log('PASS UI download exact bytes');
    await p.screenshot({ path: path.join(out, 'workflow-B-verified.png') });

    // 7. Explicit-URL viewer stays pinned to A.
    await pinned.locator('#dclose').click();
    await pinned.locator('#burger').click();
    await pinned.locator('[data-name="only-A.txt"]').waitFor({ timeout: 30000 });
    assert.equal(await pinned.locator('[data-name="only-B.txt"]').count(), 0);
    console.log('PASS explicit URL identity stays pinned to A');

    // 8. Deleting B clears the binding and the derived drawer.
    await api('/workflows/local/' + ids[1], 'DELETE');
    await p.locator('#dclose').click();
    await p.locator('#burger').click();
    await p.waitForFunction(() => document.querySelector('#wfmlist').textContent.includes('not opened from a saved workflow'), null, { timeout: 30000 });
    assert.equal((await api('/browser/workflow-files-binding')).local, null);
    console.log('PASS deletion clears binding and workspace');

    // 9. A later bind is picked up by the same (still open) viewer.
    await api('/browser/workflow-files/' + ids[0] + '/bind', 'POST', { target: 'local' });
    await p.locator('#dclose').click();
    await p.locator('#burger').click();
    await p.locator('[data-name="only-A.txt"]').waitFor({ timeout: 30000 });
    console.log('PASS viewer recovers after later binding');

    assert.deepEqual(errors, []);
    console.log('LIVE E2E PASSED; no browser JavaScript errors');
  } finally {
    await b.close();
  }
})().catch((e) => { console.error('LIVE E2E FAILED'); console.error(e); process.exitCode = 1; });
