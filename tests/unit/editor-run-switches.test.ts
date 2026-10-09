/**
 * Editor header switches (Active / Live browser) and the trigger note.
 *
 * views.js / flow-editor.js are DOM-bound IIFEs, so (like editor-shell.test.ts)
 * they are asserted at the SOURCE level. The server side they rely on
 * (PATCH /workflows/:u/:id/state, headless on /run) has its own tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUB = join(__dirname, '..', '..', 'public');
const VIEWS = readFileSync(join(PUB, 'js', 'views.js'), 'utf8');
const FE = readFileSync(join(PUB, 'js', 'flow-editor.js'), 'utf8');
const I18N = readFileSync(join(PUB, 'js', 'i18n.js'), 'utf8');
const PIPE = readFileSync(join(__dirname, '..', '..', 'src', 'pipeline.ts'), 'utf8');

// English-only dictionary (docs/uiux/new ui.md §2): one `en` block.
const enAt = I18N.indexOf('en: {');
const EN = I18N.slice(enAt);
const inBoth = (k: string) => {
  expect(enAt, 'en block').toBeGreaterThan(-1);
  expect(EN.includes(`'${k}':`), `en missing ${k}`).toBe(true);
};

describe('editor header: Active switch', () => {
  it('exists, is a real switch, and flips the server flag through PATCH /state', () => {
    expect(VIEWS).toContain('id="fe-active"');
    expect(VIEWS).toMatch(/id="fe-active" role="switch"/);
    expect(VIEWS).toMatch(/API\.setWorkflowState\(uid, cur\.id, patch\)/);
    expect(VIEWS).toMatch(/flipState\(\{ active: !\(cur\.active !== false\) \}\)/);
  });
  it('is disabled with a reason for an unsaved draft (no record to flip)', () => {
    expect(VIEWS).toMatch(/paintSwitch\(activeBtn, cur \? cur\.active !== false : false, !cur \|\| busy/);
    expect(VIEWS).toContain("'fe.needSaved'");
  });
  it('legacy records without the field read as active (default true)', () => {
    expect(VIEWS).toContain('cur.active !== false');
  });
  it('keeps the server answer on the open workflow without dirtying the graph', () => {
    expect(FE).toContain('patchCurrentWorkflow: function');
    const fn = FE.slice(FE.indexOf('patchCurrentWorkflow: function'), FE.indexOf('patchCurrentWorkflow: function') + 400);
    expect(fn).not.toMatch(/autosave\.dirty|scheduleAutosave|pushHistory/);
  });
  it('active/liveBrowser survive openWorkflow and a reload (identity cache)', () => {
    const open = FE.slice(FE.indexOf('openWorkflow: function'), FE.indexOf('openWorkflow: function') + 700);
    expect(open).toContain('active: meta.active');
    expect(open).toContain('liveBrowser: meta.liveBrowser');
    const load = FE.slice(FE.indexOf('function loadWorkflowIdentity'), FE.indexOf('function loadWorkflowIdentity') + 600);
    expect(load).toContain('active: meta.active');
    expect(load).toContain('liveBrowser: meta.liveBrowser');
  });
});

describe('editor header: Live browser switch', () => {
  it('Test Workflow sends headless = !live instead of a hard-coded true', () => {
    expect(VIEWS).toContain('headless: !wantLiveBrowser()');
    expect(VIEWS).not.toMatch(/API\.runFlow\(\{ userId: uid, steps: steps, headless: true \}\)/);
  });
  // docs/uiux/new ui.md §9: `Execute Workflow` (a test run) is ALWAYS observed
  // in the read-only Live view; only Active/background runs go hidden, and that
  // decision is made server-side (tests/unit/background-headless.test.ts).
  it('a test run is always observed live (new ui §9)', () => {
    expect(VIEWS).toMatch(/function wantLiveBrowser\(\) \{[\s\S]{0,400}?return true;\s*\}/);
  });
  it('the pipeline prepares a display for a headed launch and never throws on failure', () => {
    expect(PIPE).toMatch(/if \(!headless\) \{\s*try \{\s*await Desktop\.ensureDisplay\(\)/);
    expect(PIPE).toContain('no display could be prepared automatically');
  });
  it('tells the user when the free-tier shared pool cannot honour the choice', () => {
    expect(PIPE).toContain('Live browser is not available on this plan');
  });
});

describe('trigger nodes skipped in a manual run say so', () => {
  it('schedule, webhook and telegram triggers get a note; manual does not', () => {
    const m = /var EVENT_TRIGGERS = \{([\s\S]*?)\};/.exec(FE);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('trigger_schedule');
    expect(m![1]).toContain('trigger_webhook');
    expect(m![1]).toContain('trigger_telegram');
    expect(m![1]).not.toContain('trigger_manual');
    expect(FE).toContain('if (EVENT_TRIGGERS[node.action])');
  });
});

describe('i18n for the new controls', () => {
  it.each([
    'fe.activeLabel', 'fe.liveLabel', 'fe.activeOnHint', 'fe.activeOffHint', 'fe.needSaved', 'fe.liveHint',
    'ndv.trigNoteSchedule', 'ndv.trigNoteWebhook', 'ndv.trigNoteTelegram',
  ])('%s', inBoth);
});
