/**
 * browser-profiles-section.test.ts -- the ONE browser section of the workflow
 * editor's Workflow Files drawer.
 *
 * Replaces workflow-files-browser-switch.test.ts: the separate switch above
 * the profile panel (Turn on / Turn off / Show browser of the RealChrome
 * session) was removed on the owner's decision and merged into Browser
 * Profiles. Covered here:
 *   - the former switch row is gone; no UI text names it;
 *   - the section is titled "Browser Profiles" and its list "Branches";
 *   - NO Turn on / Turn off in the UI (owner, S33): profiles open by name
 *     through their own Open; nothing opens the default profile by itself;
 *     POST /profiles/turn-off stays on the server (integration tests);
 *   - the routes the switch used still exist on the server (they are used by
 *     other callers): nothing was removed there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pmSrc = read('public/js/profile-manager.js');
const wfSrc = read('public/js/workflow-files.js');
const i18n = read('public/js/i18n.js');
const css = read('public/css/styles.css');

function boot() {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window as any;
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const profiles = [
    { id: 'default', name: 'Default', status: 'free', available: true, branchId: 'branch-001', branchLabel: 'Default', browser: { open: true }, usedBy: [] },
    { id: 'prf_a', name: 'Shop', status: 'free', available: true, branchId: 'branch-002', branchLabel: 'branch-002', browser: { open: false }, usedBy: [] },
  ];
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.FlowEditor = { getCurrentWorkflow: () => ({ id: 'wf_abc123' }) };
  w.open = () => ({ closed: false, location: { href: 'about:blank' }, document: { title: '' }, close() { this.closed = true; }, focus() {} });
  w.fetch = (url: string, init: any) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    let answer: any = { success: true, entries: [] };
    if (url === '/profiles/branches') answer = { success: true, branches: [] };
    if (url === '/profiles/launch-options') answer = { success: true, categories: [], options: [], presets: [{ id: 'standard', label: 'Standard', options: [], description: '' }], defaultPreset: 'standard' };
    if (url.startsWith('/profiles?') || (url === '/profiles' && method === 'GET')) answer = { success: true, profiles, unknownSchedules: [] };
    const m = /^\/profiles\/([^/]+)\/open$/.exec(url);
    if (m) answer = { success: true, viewPath: `/desktop/chrome?profile=${m[1]}` };
    if (url === '/profiles/turn-off') answer = { success: true, closed: [{ profileId: 'prf_a', name: 'Shop' }], keptOpen: [{ profileId: 'default', name: 'Default', reason: 'workflow', workflows: [{ workflowId: 'wf_n', name: 'Nightly import' }] }], notOpenedHere: [], failed: [] };
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(answer)) });
  };
  dom.window.eval(pmSrc);
  dom.window.eval(wfSrc);
  const stage = dom.window.document.getElementById('stage')!;
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { dom, w, calls, stage, settle };
}

let b: ReturnType<typeof boot>;
afterEach(() => { try { b?.w.WorkflowFiles.close(); } catch { /* gone */ } });
async function open() { b = boot(); b.w.WorkflowFiles.open({ host: b.stage, browseOnly: true }); await b.settle(); }
const q = (s: string) => b.stage.querySelector(s) as HTMLElement;
const opens = () => b.calls.filter((c) => /\/profiles\/[^/]+\/open$/.test(c.url)).map((c) => c.url);

describe('one Browser Profiles section', () => {
  it('the former separate switch is gone and no UI text names it', async () => {
    await open();
    expect(q('.wfm-browser')).toBeNull();
    expect(q('.wfm-br-btn')).toBeNull();
    expect(q('.wfm-br-show')).toBeNull();
    expect(b.stage.textContent).not.toMatch(/Local Browser/);
    // It does not poll the RealChrome state any more.
    expect(b.calls.some((c) => c.url === '/browser/real/health')).toBe(false);
  });

  it('is titled "Browser Profiles", the list is labelled "Branches"; NO Turn on / Turn off in the DOM', async () => {
    await open();
    expect(q('.pm-title').textContent).toBe('Browser Profiles');
    expect(q('.pm-list-label').textContent).toBe('Branches');
    // Display names only (brief 1.2): no branch-NNN in the UI.
    expect(q('.pm-branch-label').textContent).toBe('Default');
    // Owner: profiles open by name through their own Open; no bulk controls.
    expect(q('.pm-turn-on')).toBeNull();
    expect(q('.pm-turn-off')).toBeNull();
    expect(q('.pm-power')).toBeNull();
    expect(q('.pm-off-result')).toBeNull();
    expect(b.stage.textContent).not.toMatch(/Turn on|Turn off|Turned off|Still open:/);
    // The per-profile controls remain.
    for (const sel of ['.pm-open', '.pm-close', '.pm-release', '.pm-restore', '.pm-ren', '.pm-launch']) expect(q(sel)).not.toBeNull();
  });

  it('nothing in the panel opens the default profile by itself, and nothing calls /profiles/turn-off', async () => {
    await open();
    for (const btn of Array.from(b.stage.querySelectorAll('.pm-panel button')) as HTMLButtonElement[]) {
      if (btn.classList.contains('pm-hold') || btn.classList.contains('pm-branch-del')) continue;
      if (!btn.disabled) btn.click();
    }
    await b.settle();
    expect(opens()).toEqual([]); // Open needs a selection; nothing opens "default" on its own
    expect(b.calls.some((c) => c.url === '/profiles/turn-off')).toBe(false);
  });

  it('Open opens exactly the selected profile, by name', async () => {
    await open();
    const box = b.stage.querySelector('.pm-row[data-id="prf_a"] .pm-check') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new b.w.Event('change'));
    q('.pm-open').click();
    await b.settle();
    expect(opens()).toEqual(['/profiles/prf_a/open']);
  });
});

describe('wiring', () => {
  it('section keys exist; the removed switch and Turn on/off keys are gone', () => {
    for (const k of ['pm.title', 'pm.branches']) expect(i18n).toContain(`'${k}'`);
    expect(i18n).not.toMatch(/'wfm\.browser[A-Za-z]*'/);
    expect(i18n).not.toMatch(/'pm\.(turn[A-Za-z]*|off[A-Z][A-Za-z]*)'/);
    expect(i18n).toContain("'pm.title': 'Browser Profiles'");
  });

  it('1.1 (S37): no dead Local Browser / built-in / native-dialog code is left in the panel', () => {
    // removeProfile() was dead (never called) and used a native confirm();
    // `builtIn` branches no longer exist on the server (S34, 2.1).
    expect(pmSrc).not.toMatch(/removeProfile|builtIn|window\.confirm|window\.alert|window\.prompt/);
    for (const k of ['pm.delete', 'pm.branch', 'pm.deleteConfirm', 'pm.deleted']) expect(i18n, k).not.toContain(`'${k}':`);
    // Executable code only (block and line comments stripped).
    const code = (pmSrc + '\n' + wfSrc).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    expect(code).not.toMatch(/openRealBrowser|\/browser\/real\/|RealChrome|realchrome/);
    // No UI string of the panel or the drawer names the Local Browser.
    expect(code).not.toMatch(/Local Browser/i);
  });

  it('styles: the branch menu follows the dark theme; the form is a grid; the old row styles are gone', () => {
    expect(css).toMatch(/\.pm-branch-select \{[^}]*color-scheme: dark/);
    expect(css).toMatch(/\.pm-form \{[^}]*display: grid/);
    expect(css).not.toMatch(/\.wfm-browser\b/);
    expect(css).not.toMatch(/\.pm-power\b|\.pm-off-result\b|\.pm-off-line\b/);
  });

  it('the server routes the removed switch used are still there (other callers use them)', () => {
    const br = read('src/Routes/browser.routes.ts');
    expect(br).toContain("router.post(['/browser/close', '/browser/real/close']");
    expect(br).toContain("router.post('/browser/real/open'");
    expect(br).toContain("router.get('/browser/real/health'");
    expect(br).toContain("router.get('/browser/sessions'");
    expect(read('src/Routes/profile.routes.ts')).toContain("router.post('/profiles/turn-off'");
  });
});
