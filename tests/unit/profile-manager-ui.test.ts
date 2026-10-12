/**
 * The profile panel inside the Workflow Files drawer (public/js/profile-manager.js).
 *
 *   - the drawer mounts the ONE profile client (no second system, no new page)
 *   - multi-select + Open opens one viewer tab per profile, pointed at it
 *   - creating a profile automatically tries to open it; a failed open keeps it
 *   - a profile another workflow holds/reserves shows the reason and cannot be ticked
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
const html = read('public/index.html');

interface Opts { openFails?: boolean; blocked?: boolean; overlap?: boolean; unknown?: boolean }

function boot(o: Opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window as any;
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const tabs: Array<{ location: string; closed: boolean; document: any; close: () => void }> = [];
  let profiles: any[] = [
    { id: 'default', name: 'Default', builtIn: true, status: 'free', available: true, browser: { open: false, dependents: 0 }, usedBy: [] },
    o.blocked
      ? { id: 'prf_b', name: 'Busy', builtIn: false, status: 'reserved', available: false, denyReason: 'reserved', explanation: 'Reserved for the scheduled run of "Nightly".', browser: { open: false, dependents: 0 }, usedBy: [] }
      : { id: 'prf_b', name: 'Second', builtIn: false, status: 'free', available: true, browser: { open: false, dependents: 0 }, usedBy: [] },
  ];
  if (o.overlap) {
    profiles[1].overlaps = [{ message: 'x', a: { owner: 'wf_a', ownerName: 'Morning A', start: 0, end: 600000 }, b: { owner: 'wf_b', ownerName: 'Morning B', start: 300000, end: 900000 } }];
  }
  const unknownSchedules = o.unknown ? [{ key: 'k1', name: 'legacy', cron: '0 3 * * *', reason: 'no_template' }] : [];
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.FlowEditor = { getCurrentWorkflow: () => ({ id: 'wf_abc123' }) };
  w.BrowserView = { openRealBrowser: () => Promise.resolve({ success: true }) };
  w.confirm = () => true;
  w.open = () => { const t = { location: '', closed: false, document: { title: '' }, close() { this.closed = true; } }; tabs.push(t); return t; };
  w.fetch = (url: string, init: any) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    let status = 200;
    let answer: any = { success: true, entries: [] };
    if (url === '/browser/real/health') answer = { success: true, running: false };
    if (url.startsWith('/profiles') && method === 'GET') answer = { success: true, profiles, unknownSchedules };
    if (url === '/profiles' && method === 'POST') {
      const p = { id: 'prf_new', name: body.name, builtIn: false, status: 'free', available: true, browser: { open: false, dependents: 0 }, usedBy: [] };
      profiles = profiles.concat([p]);
      status = 201; answer = { success: true, profile: p };
    }
    const m = /^\/profiles\/([^/]+)\/open$/.exec(url);
    if (m && method === 'POST') {
      if (o.openFails) { status = 503; answer = { success: false, error: 'Could not start the browser: no display', retryable: true }; }
      else answer = { success: true, viewPath: `/desktop/chrome?profile=${m[1]}` };
    }
    return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(answer)) });
  };
  dom.window.eval(pmSrc);
  dom.window.eval(wfSrc);
  const stage = dom.window.document.getElementById('stage')!;
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { dom, w, calls, tabs, stage, settle };
}

let b: ReturnType<typeof boot>;
afterEach(() => { try { b?.w.WorkflowFiles.close(); } catch { /* gone */ } });

async function openDrawer(o: Opts = {}) {
  b = boot(o);
  b.w.WorkflowFiles.open({ host: b.stage, browseOnly: true });
  await b.settle();
}
const rows = () => Array.from(b.stage.querySelectorAll('.pm-row')) as HTMLElement[];
const boxOf = (id: string) => b.stage.querySelector(`.pm-row[data-id="${id}"] .pm-check`) as HTMLInputElement;
const openBtn = () => b.stage.querySelector('.pm-open') as HTMLButtonElement;
const note = () => (b.stage.querySelector('.wfm-note') as HTMLElement).textContent || '';

describe('the profile panel in the Workflow Files drawer', () => {
  it('is mounted in the editor drawer, from the shared registry, for this workflow', async () => {
    await openDrawer();
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual(['default', 'prf_b']);
    expect(b.calls.some((c) => c.url === '/profiles?workflowId=wf_abc123')).toBe(true);
  });

  it('is not mounted in the file-picker drawer', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    expect(b.stage.querySelector('.pm-panel')).toBeNull();
  });

  it('several selected profiles open one viewer tab each, each pointed at its profile', async () => {
    await openDrawer();
    boxOf('default').click();
    boxOf('prf_b').click();
    expect(openBtn().disabled).toBe(false);
    openBtn().click();
    await b.settle();
    const opens = b.calls.filter((c) => /\/open$/.test(c.url));
    expect(opens.map((c) => c.url)).toEqual(['/profiles/default/open', '/profiles/prf_b/open']);
    expect(opens.every((c) => c.body.workflowId === 'wf_abc123')).toBe(true);
    expect(b.tabs.map((t) => t.location)).toEqual([
      '/desktop/chrome?profile=default&api_key=K&workflowId=wf_abc123',
      '/desktop/chrome?profile=prf_b&api_key=K&workflowId=wf_abc123',
    ]);
  });

  it('creating a profile then opens it automatically', async () => {
    await openDrawer();
    (b.stage.querySelector('.pm-new') as HTMLButtonElement).click();
    (b.stage.querySelector('.pm-input') as HTMLInputElement).value = 'Fresh';
    (b.stage.querySelector('.pm-form') as HTMLFormElement).dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.settle();
    const seq = b.calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(seq).toEqual(['/profiles', '/profiles/prf_new/open']);
    expect(b.tabs).toHaveLength(1);
    expect(b.tabs[0]!.location).toContain('profile=prf_new');
  });

  it('a failed open after create keeps the profile and says Open can be pressed again', async () => {
    await openDrawer({ openFails: true });
    (b.stage.querySelector('.pm-new') as HTMLButtonElement).click();
    (b.stage.querySelector('.pm-input') as HTMLInputElement).value = 'Fresh';
    (b.stage.querySelector('.pm-form') as HTMLFormElement).dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.settle();
    expect(rows().some((r) => r.getAttribute('data-id') === 'prf_new')).toBe(true);
    expect(b.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(note()).toContain('no display');
    expect(b.tabs[0]!.closed).toBe(true);
    // Still selected: one press on Open retries.
    expect(boxOf('prf_new').checked).toBe(true);
    expect(openBtn().disabled).toBe(false);
  });

  it('a profile reserved by another workflow shows why and cannot be selected', async () => {
    await openDrawer({ blocked: true });
    const row = b.stage.querySelector('.pm-row[data-id="prf_b"]') as HTMLElement;
    expect(row.textContent).toContain('Nightly');
    expect(boxOf('prf_b').disabled).toBe(true);
  });

  it('overlapping schedules are shown on the profile they share, with both workflow names', async () => {
    await openDrawer({ overlap: true });
    const w = b.stage.querySelector('.pm-row[data-id="prf_b"] .pm-overlap') as HTMLElement;
    expect(w).toBeTruthy();
    expect(w.textContent).toContain('Morning A');
    expect(w.textContent).toContain('Morning B');
    expect(w.getAttribute('role')).toBe('note');
    expect(b.stage.querySelector('.pm-row[data-id="default"] .pm-overlap')).toBeNull();
  });

  it('a schedule whose profile is unknown is reported, not hidden', async () => {
    await openDrawer({ unknown: true });
    const notes = b.stage.querySelector('.pm-notes') as HTMLElement;
    expect(notes.hidden).toBe(false);
    expect(notes.textContent).toContain('legacy');
    expect(notes.textContent).toContain('0 3 * * *');
  });

  it('without such warnings the notes list stays hidden', async () => {
    await openDrawer();
    expect((b.stage.querySelector('.pm-notes') as HTMLElement).hidden).toBe(true);
  });
});

describe('wiring', () => {
  it('the page loads the profile client before the drawer, and every key exists once', () => {
    expect(html.indexOf('/js/profile-manager.js')).toBeGreaterThan(0);
    expect(html.indexOf('/js/profile-manager.js')).toBeLessThan(html.indexOf('/js/workflow-files.js'));
    const keys = Array.from(new Set((pmSrc.match(/t\('pm\.[A-Za-z]+'/g) || []).map((s) => s.slice(3, -1))));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(i18n.split(`'${k}':`).length - 1, k).toBe(1);
  });
  it('Workflow Settings picks the profile from the registry and offers the after-run policy', () => {
    const views = read('public/js/views.js');
    expect(views).toContain('ProfileManager.api.list');
    expect(views).toContain('wfs-afterrun');
    expect(views).toMatch(/afterRun: dlg\.querySelector\('#wfs-afterrun'\)/);
  });
});
