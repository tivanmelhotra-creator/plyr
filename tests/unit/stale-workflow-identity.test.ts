/**
 * stale-workflow-identity.test.ts — the "Workflow Files" loop, closed.
 *
 * REPORTED (many sessions): «هربار که به ایجنت میگم پروژه رو بالا بیاره با این
 * مشکل مواجه میشم» — every time the project is brought up, the Local Browser's
 * Workflow Files drawer is unusable for the workflow the editor shows.
 *
 * MEASURED with tools/probe-viewer-workflow-id.mjs (PROBE_MODE=stale):
 * localStorage kept `ab_flow_workflow` = wf_e6f57f… from an earlier server
 * (Redis reset / restore from backup / fresh machine). After a reload the
 * editor's status bar said "v3 · Workflow ID wf_e6f57f…", "Save changes"
 * toasted "Workflow saved." (a localStorage write), the picker put that id on
 * the viewer URL, POST /browser/workflow-files/wf_e6f57f…/bind -> 404
 * "Workflow not found.", and the drawer painted "This folder is empty. Upload
 * a file or create a folder." above that note. Nothing told the editor, so
 * the dead id came back on every reload — the loop.
 *
 * THE FIX, in two places, both pinned here at SOURCE level (views.js and the
 * ChromeView page script are DOM-bound; see editor-shell.test.ts for the
 * convention):
 *
 *   1. views.js renderEditor(): a restored identity is VERIFIED against the
 *      server once (GET /workflows/:uid/:id). 404 -> FE.setCurrentWorkflow(null)
 *      + toast 'fe.workflowGone'. Other failures change nothing. A PUT that
 *      404s drops the identity the same way.
 *   2. ChromeView.ts: a 404 on the workflow's listing marks it GONE, paints
 *      one explicit row (not an "empty folder"), and wfmRequire() refuses
 *      every mutation with the same words, so no request is built for it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromeViewHtml } from '../../src/core/ChromeView';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const VIEWS = read('public/js/views.js');
const I18N = read('public/js/i18n.js');
const VIEW = chromeViewHtml();

function body(src: string, fnName: string): string {
  const i = src.indexOf(`function ${fnName}(`);
  if (i < 0) throw new Error(`${fnName} not found`);
  return src.slice(i, i + 2500);
}

describe('editor: a restored workflow identity is verified against the server', () => {
  it('asks GET /workflows/:uid/:id once on mount when nothing was handed over from the Workflows view', () => {
    const fn = body(VIEWS, 'verifyRestoredWorkflow');
    expect(fn).toMatch(/API\.getWorkflow\(uid,\s*claimed\)/);
    // Runs only on the reload path: an explicit openWorkflow() is fresh data.
    const mount = VIEWS.slice(VIEWS.indexOf('if (pendingWorkflowToOpen) {'), VIEWS.indexOf('function verifyRestoredWorkflow'));
    expect(mount).toMatch(/\} else \{[\s\S]*verifyRestoredWorkflow\(\);/);
  });

  it('drops the identity ONLY on 404, and only if that id is still the one open', () => {
    const verify = body(VIEWS, 'verifyRestoredWorkflow');
    expect(verify).toMatch(/err\.status !== 404\) return;/);
    const forget = body(VIEWS, 'forgetDeadWorkflow');
    expect(forget).toMatch(/String\(now\.id\) !== String\(deadId\)\) return false;/);
    expect(forget).toMatch(/FE\.setCurrentWorkflow\(null\)/);
    expect(forget).toMatch(/refreshWfLabel\(\)/);
    expect(forget).toMatch(/t\('fe\.workflowGone'\)/);
  });

  it('a version-bumping PUT that 404s also forgets the dead id instead of failing forever', () => {
    const i = VIEWS.indexOf("root.querySelector('#fe-save-server').addEventListener");
    const save = VIEWS.slice(i, i + 2500);
    expect(save).toMatch(/API\.updateWorkflow\(uid,\s*cur\.id/);
    expect(save).toMatch(/err\.status === 404 && forgetDeadWorkflow\(cur\.id\)\) return;/);
  });

  it('the toast key exists in BOTH dictionaries (t() falls back to English silently)', () => {
    const fa = I18N.slice(I18N.indexOf('    fa: {'), I18N.indexOf('    en: {'));
    const en = I18N.slice(I18N.indexOf('    en: {'));
    expect(fa).toMatch(/'fe\.workflowGone':/);
    expect(en).toMatch(/'fe\.workflowGone':/);
  });
});

describe('viewer: a workflow the server no longer has is named, not painted as an empty folder', () => {
  it('carries the HTTP status on the drawer\u2019s errors so a 404 can be told apart', () => {
    const fn = body(VIEW, 'wfmJson');
    expect(fn).toMatch(/\{ status: r\.status \}/);
  });

  it('a 404 on the listing marks the workspace GONE and says so in the note', () => {
    const fn = body(VIEW, 'wfmFetchFolder');
    expect(fn).toMatch(/e\.status === 404\)\s*\{[\s\S]*wfmGone = true;[\s\S]*wfmSay\(GONE_WORKFLOW_TEXT, true\)/);
  });

  it('paints the GONE text as the only row, never the "empty folder, upload" invitation', () => {
    const fn = body(VIEW, 'wfmPaint');
    const gone = fn.indexOf('if (wfmGone && depth === 0)');
    const empty = fn.indexOf('This folder is empty');
    expect(gone).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(gone);
  });

  it('every mutation is refused through wfmRequire() with the same words, so no request is built', () => {
    const fn = body(VIEW, 'wfmRequire');
    expect(fn).toMatch(/if \(workflowId && !wfmGone\) return true;/);
    expect(fn).toMatch(/wfmGone \? GONE_WORKFLOW_TEXT : NO_WORKFLOW_TEXT/);
  });

  it('the GONE flag is reset when the resolved workflow changes (drawer follows the binding)', () => {
    const fn = body(VIEW, 'resolveWorkflowId');
    expect(fn).toMatch(/workflowId = nextId;\s*wfmGone = false;/);
  });

  it('the text tells the operator the one action that ends the loop: save again, then reopen', () => {
    expect(VIEW).toMatch(/GONE_WORKFLOW_TEXT = 'This workflow no longer exists on the server[^']*save the workflow again[^']*open the browser from it\.'/);
  });
});
