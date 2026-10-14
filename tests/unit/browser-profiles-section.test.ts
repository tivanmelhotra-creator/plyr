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
 *   - Turn on with NOTHING selected opens the default profile, through the
 *     same /profiles/:id/open as Open (no /browser/real/open);
 *   - Turn on with a selection opens exactly the selected profiles;
 *   - Turn off calls POST /profiles/turn-off and shows, on screen, what closed
 *     and which profile stayed open for which workflow;
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
    { id: 'default', name: 'Default', builtIn: true, status: 'free', available: true, branchId: 'branch-001', branchLabel: 'Default', browser: { open: true }, usedBy: [] },
    { id: 'prf_a', name: 'Shop', status: 'free', available: true, branchId: 'branch-002', branchLabel: 'branch-002', browser: { open: false }, usedBy: [] },
  ];
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.FlowEditor = { getCurrentWorkflow: () => ({ id: 'wf_abc123' }) };
  w.BrowserView = { openRealBrowser: () => { calls.push({ url: 'openRealBrowser', method: 'JS', body: null }); return Promise.resolve({}); } };
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

  it('is titled "Browser Profiles", the list is labelled "Branches", Turn on / Turn off present', async () => {
    await open();
    expect(q('.pm-title').textContent).toBe('Browser Profiles');
    expect(q('.pm-list-label').textContent).toBe('Branches');
    expect(q('.pm-turn-on').textContent).toBe('Turn on');
    expect(q('.pm-turn-off').textContent).toBe('Turn off');
    // A branch header shows the branch itself, without a "Branch:" prefix.
    expect(q('.pm-branch-label').textContent).toBe('Default (branch-001)');
  });

  it('Turn on with nothing selected opens the DEFAULT profile through the Open path', async () => {
    await open();
    q('.pm-turn-on').click();
    await b.settle();
    expect(opens()).toEqual(['/profiles/default/open']);
    expect(b.calls.some((c) => c.url === 'openRealBrowser' || c.url === '/browser/real/open')).toBe(false);
  });

  it('Turn on with a selection opens exactly the selected profiles', async () => {
    await open();
    const box = b.stage.querySelector('.pm-row[data-id="prf_a"] .pm-check') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new b.w.Event('change'));
    expect(q('.pm-turn-on').textContent).toBe('Turn on (1)');
    q('.pm-turn-on').click();
    await b.settle();
    expect(opens()).toEqual(['/profiles/prf_a/open']);
  });

  it('Turn off asks the server and shows what closed and which profile a workflow keeps open', async () => {
    await open();
    q('.pm-turn-off').click();
    await b.settle();
    expect(b.calls.some((c) => c.method === 'POST' && c.url === '/profiles/turn-off')).toBe(true);
    expect(b.calls.some((c) => c.url === '/browser/real/close' || c.url === '/browser/close')).toBe(false);
    const res = q('.pm-off-result');
    expect(res.hidden).toBe(false);
    expect(res.querySelector('.is-closed')!.textContent).toContain('Shop');
    const kept = res.querySelector('.is-kept')!.textContent!;
    expect(kept).toContain('Default');
    expect(kept).toContain('Nightly import');
  });
});

describe('wiring', () => {
  it('every new key exists; the removed switch keys are gone', () => {
    for (const k of ['pm.title', 'pm.branches', 'pm.turnOn', 'pm.turnOff', 'pm.offKept', 'pm.offUsedBy', 'pm.offClosed']) expect(i18n).toContain(`'${k}'`);
    expect(i18n).not.toMatch(/'wfm\.browser[A-Za-z]*'/);
    expect(i18n).toContain("'pm.title': 'Browser Profiles'");
  });

  it('styles: the branch menu follows the dark theme; the form is a grid; the old row styles are gone', () => {
    expect(css).toMatch(/\.pm-branch-select \{[^}]*color-scheme: dark/);
    expect(css).toMatch(/\.pm-form \{[^}]*display: grid/);
    expect(css).not.toMatch(/\.wfm-browser\b/);
    expect(css).toMatch(/\.pm-power \{/);
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
