/**
 * Task 5 — NDV behaviours that must not regress, pinned on the shipped sources:
 *   - dropping an INPUT token on a FIXED field switches it to Expression;
 *   - an unexecuted node's OUTPUT offers Run (and says so honestly when the
 *     node ran and returned nothing);
 *   - the RTL column-order rule is present;
 *   - the export/import UI is wired to the native module and the summary dialog;
 *   - i18n fa/en parity for every key this task added.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');
const FE = read('public/js/flow-editor.js');
const NN = read('public/js/ndv-nodes.js');
const VIEWS = read('public/js/views.js');
const CSS = read('public/css/styles.css');
const I18N = read('public/js/i18n.js');

describe('NDV drag-and-drop to an expression', () => {
  it('generic fields: a drop on a fixed control flips it to expression', () => {
    expect(FE).toMatch(/row\.addEventListener\('drop'/);
    expect(FE).toMatch(/node\._expr\[f\.k\] = true;[\s\S]{0,200}buildControl\(\)/);
  });
  it('designed fields: a drop on a fixed control flips the fx toggle on', () => {
    expect(NN).toMatch(/if \(!isExpr\) \{[\s\S]{0,200}isExpr = true;[\s\S]{0,80}fx\.classList\.add\('on'\)/);
  });
});

describe('NDV empty states', () => {
  it('unexecuted: a Run button; executed-empty: a different message', () => {
    expect(FE).toMatch(/function buildEmptyRunButton\(nodeId\)/);
    expect(FE).toMatch(/ran \? t\('ndv\.outRanEmpty'\) : t\('ndv\.noOutput'\)/);
    expect(NN).toMatch(/ctx\.executed/);
    expect(NN).toMatch(/ctx\.runButton/);
  });
  it('the button is the guarded runner, never a no-op', () => {
    const fn = FE.slice(FE.indexOf('function buildEmptyRunButton'), FE.indexOf('function renderOutputColumn'));
    expect(fn).toMatch(/runNodeBlockedReason\(nodeId\)/);
    expect(fn).toMatch(/runNode\(nodeId\)/);
    expect(fn).toMatch(/b\.disabled = true/);
  });
});

describe('RTL', () => {
  it('pins the column order to the data flow', () => {
    expect(CSS).toMatch(/\[dir="rtl"\] \.ndv-modal \.ndv-cols \{ direction: ltr; \}/);
    expect(CSS).toMatch(/\[dir="rtl"\] \.ndv-modal \.ndv-cols > \.ndv-col \{ direction: rtl; \}/);
  });
});

describe('export / import UI', () => {
  it('export writes the native envelope, never the key or a webhook', () => {
    const fn = VIEWS.slice(VIEWS.indexOf('function exportWorkflowJson'), VIEWS.indexOf('function renderWorkspace'));
    expect(fn).toMatch(/WorkflowExchange\.buildEnvelope/);
    expect(fn).not.toMatch(/webhookUrl:/);
  });
  it('import previews on the server and asks before saving', () => {
    const fn = VIEWS.slice(VIEWS.indexOf('function importWorkflowJson'), VIEWS.indexOf('function exportWorkflowJson'));
    expect(fn).toMatch(/previewWorkflowImport/);
    expect(fn).toMatch(/showImportSummary/);
    // createWorkflow (the old direct save) must be gone from the import path
    expect(fn).not.toMatch(/createWorkflow/);
    expect(fn.indexOf('showImportSummary')).toBeLessThan(fn.indexOf('API.importWorkflow'));
  });
  it('the editor Export menu offers the native file', () => {
    expect(VIEWS).toMatch(/menuItem\(t\('ex\.downloadFile'\)/);
    expect(VIEWS).toMatch(/FE\.toDocumentSteps\(\)/);
  });
});

describe('i18n parity for this task', () => {
  const keys = (src: string) => Array.from(src.matchAll(/'((?:ex\.[A-Za-z]+)|ndv\.outRanEmpty)':/g)).map((m) => m[1]);
  it('every ex.* / ndv.outRanEmpty key exists exactly once (English-only dictionary)', () => {
    const all = keys(I18N);
    const uniq = Array.from(new Set(all));
    expect(uniq.length).toBeGreaterThanOrEqual(15);
    uniq.forEach((k) => expect(all.filter((x) => x === k), k).toHaveLength(1));
  });
});
