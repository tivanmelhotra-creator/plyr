/**
 * editor-workflow-files.test.ts — the Workflow Files hamburger in the editor.
 *
 * The drawer (public/js/workflow-files.js) used to be reachable only from the
 * Live Browser View, i.e. only while a browser was running. The editor's top
 * bar now carries its own hamburger, beside the account avatar, which opens the
 * SAME drawer for the open workflow with no browser at all.
 *
 *   1. the button sits in the top bar's right-hand actions, after the avatar
 *      (the avatar stays: Language and Logout live in it on this route)
 *   2. the drawer is hosted by `.fe-layout`, never by the canvas, and is opened
 *      browse-only
 *   3. a browse-only drawer has no Select and cannot call /use
 *   4. the drawer follows the open workflow and never outlives the editor
 *   5. wiring: both languages carry the new sentence, CSS docks the drawer
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const VIEWS = read('public/js/views.js');
const MODULE = read('public/js/workflow-files.js');
const CSS = read('public/css/styles.css');
const I18N = read('public/js/i18n.js');

// ─────────────────────────────────────────────────────────────────────────
describe('the hamburger in the editor top bar', () => {
  const bar = VIEWS.slice(
    VIEWS.indexOf("'<header class=\"fe-topbar\">'"),
    VIEWS.indexOf("'<div class=\"fe-layout\">'"),
  );

  // Focused top bar (docs/uiux/new ui.md §3): the hamburger is a VISIBLE
  // control in the end section (Active · Save · Extract · hamburger), the
  // outermost one. The avatar no longer sits in the visible bar; it is kept,
  // inert, in the hidden legacy host so its listeners still find their ids.
  it('is emitted in the visible end section, as its outermost control', () => {
    expect(bar).toContain('id="fe-files"');
    const end = bar.slice(bar.indexOf('class="fe-tb-end"'), bar.indexOf('class="fe-legacy-host"'));
    expect(end.indexOf('id="fe-files"')).toBeGreaterThan(-1);
    expect(end.indexOf('id="fe-files"')).toBeGreaterThan(end.indexOf('id="fe-extract"'));
    expect(end.indexOf('id="fe-files"')).toBeGreaterThan(end.indexOf('id="fe-savenow"'));
  });

  it('does NOT replace the avatar: Language and Logout are reached through it', () => {
    expect(bar).toContain('id="fe-avatar"');
    expect(bar).toContain('id="fe-acct-menu"');
  });

  it('is a labelled dialog trigger, titled like the browser view\'s hamburger', () => {
    const btn = bar.slice(bar.indexOf('id="fe-files"') - 80, bar.indexOf('id="fe-files"') + 360);
    expect(btn).toContain('aria-haspopup="dialog"');
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain("t('rio.filesMenu')");
    expect(btn).toContain("IC('menu'");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('how the editor opens the drawer', () => {
  const wiring = VIEWS.slice(
    VIEWS.indexOf('// ---- Workflow Files (hamburger)'),
    VIEWS.indexOf('// ---- Workflow tab strip'),
  );

  it('hosts it in .fe-layout (a sibling of the canvas), browse-only', () => {
    expect(wiring).toContain("root.querySelector('.fe-layout')");
    expect(wiring).not.toContain("querySelector('#fe-canvas')");
    expect(wiring).toContain('browseOnly: true');
    expect(wiring).toContain('workflowId: String(cur.id)');
  });

  it('refuses a draft with a sentence instead of opening an empty bucket', () => {
    expect(wiring).toContain("t('fe.filesNeedSave')");
    expect(wiring.indexOf("t('fe.filesNeedSave')")).toBeLessThan(wiring.indexOf('W.open('));
  });

  it('toggles: a second press closes the drawer THIS editor opened', () => {
    expect(wiring).toContain("W.close('toggled')");
    expect(wiring).toContain('filesMine && W.isOpen()');
  });

  it('follows the workflow: tab switch / New Workflow / first autosave', () => {
    // refreshWfLabel runs after every one of those, so reconciling from there
    // covers them without a second set of hooks.
    const refresh = VIEWS.slice(
      VIEWS.indexOf('function refreshWfLabel()'),
      VIEWS.indexOf('refreshWfLabel();', VIEWS.indexOf('function refreshWfLabel()') + 40),
    );
    expect(refresh).toContain('reconcileFiles()');
    expect(wiring).toContain('id === W.workflowId()');
    expect(wiring).toContain("W.close('workflow-changed')");
  });

  it('closes on every route change, so the next view\'s hamburger opens, not closes', () => {
    const stopAll = VIEWS.slice(VIEWS.indexOf('function stopAll()'), VIEWS.indexOf('function t(k)'));
    expect(stopAll).toContain("window.WorkflowFiles.close('route')");
  });
});

// ─────────────────────────────────────────────────────────────────────────
function boot(workflow: { id: string } | null = { id: 'wf_abc123' }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="layout"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window as unknown as Record<string, any>;
  const calls: { url: string; method: string }[] = [];
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.FlowEditor = { getCurrentWorkflow: () => workflow };
  w.fetch = (url: string, init: any) => {
    calls.push({ url, method: (init && init.method) || 'GET' });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        success: true, path: '', parent: null,
        entries: [{ name: 'cookies.json', path: 'cookies.json', type: 'file', size: 12 }],
      })),
    });
  };
  dom.window.eval(MODULE);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { w, calls, tick, host: dom.window.document.getElementById('layout')! };
}

describe('a browse-only drawer', () => {
  it('is marked is-browse, so its Select button is hidden by CSS', async () => {
    const { w, host, tick } = boot();
    expect(w.WorkflowFiles.open({ host, browseOnly: true })).toBe(true);
    await tick();
    const drawer = host.querySelector('.wfm-drawer')!;
    expect(drawer.classList.contains('is-browse')).toBe(true);
    expect(CSS).toMatch(/\.wfm-drawer\.is-browse \.wfm-select\s*\{\s*display:\s*none/);
    w.WorkflowFiles.close();
  });

  it('a normal (browser-view) drawer is NOT browse-only: Select stays', async () => {
    const { w, host, tick } = boot();
    w.WorkflowFiles.open({ host });
    await tick();
    expect(host.querySelector('.wfm-drawer')!.classList.contains('is-browse')).toBe(false);
    w.WorkflowFiles.close();
  });

  it('never calls /use, even if Select is somehow triggered', async () => {
    const { w, host, calls, tick } = boot();
    w.WorkflowFiles.open({ host, browseOnly: true });
    await tick();
    (host.querySelector('.wfm-check') as HTMLInputElement).click();
    const select = host.querySelector('.wfm-select') as HTMLButtonElement;
    select.disabled = false;
    select.click();
    await tick();
    expect(calls.filter((c) => c.url.includes('/use'))).toHaveLength(0);
    w.WorkflowFiles.close();
  });

  it('still lists the workflow\'s files with no browser involved', async () => {
    const { w, host, calls, tick } = boot();
    w.WorkflowFiles.open({ host, browseOnly: true });
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/browser/workflow-files/wf_abc123?path=');
    expect([...host.querySelectorAll('.wfm-name')].map((n) => n.textContent)).toEqual(['cookies.json']);
    w.WorkflowFiles.close();
  });
});

describe('WorkflowFiles.workflowId()', () => {
  it('names the workflow on screen, and is empty once the drawer is closed', async () => {
    const { w, host, tick } = boot();
    expect(w.WorkflowFiles.workflowId()).toBe('');
    w.WorkflowFiles.open({ host, workflowId: 'wf_other', browseOnly: true });
    await tick();
    expect(w.WorkflowFiles.workflowId()).toBe('wf_other');
    w.WorkflowFiles.close();
    expect(w.WorkflowFiles.workflowId()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('wiring', () => {
  it('the dictionary carries the "save first" sentence', () => {
    expect(I18N.match(/'fe\.filesNeedSave':/g)).toHaveLength(1);
  });

  it('docks the drawer to the layout, which is therefore positioned', () => {
    const rule = CSS.slice(CSS.indexOf('.fe-layout {'), CSS.indexOf('}', CSS.indexOf('.fe-layout {')));
    expect(rule).toMatch(/position:\s*relative/);
  });

  it('documents browseOnly where the options are described', () => {
    expect(MODULE).toContain('browseOnly:');
  });
});
