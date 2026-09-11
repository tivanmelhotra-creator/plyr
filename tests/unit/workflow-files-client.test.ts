/**
 * workflow-files-client.test.ts — the Workflow Files drawer for the canvas views.
 *
 * public/js/workflow-files.js is the second source of "Add File" in the picker
 * modal and the Live Browser View: instead of uploading from the operator's
 * computer, it browses the saved workflow's own persistent files on the server
 * and asks the server to hand one to the page (POST /use). The Local Browser
 * view (/desktop/chrome) has its own copy of the panel inside ChromeView.ts.
 *
 * These tests drive the REAL shipped module in jsdom, with `fetch` recorded:
 *
 *   1. the id rule agrees with the server's (utils/redis-keys.ts)
 *   2. nothing is browsed without a saved workflow — no bucket is invented
 *   3. every request names the workflow id and a workflow-RELATIVE path the
 *      server itself returned; the API key rides in a header, never a URL
 *   4. /use carries the socket's identity and NO chooserId (the canvas views'
 *      dialog belongs to the LiveBrowserSession), and reports name, not path
 *   5. the accept-filter is applied before /use, like RemoteIO does before an
 *      upload
 *   6. RemoteIO's file prompt offers the button only when the module is
 *      present, and the two are wired (index.html order, i18n, CSS)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { isValidWorkflowId } from '../../src/utils/redis-keys';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const moduleSrc = read('public/js/workflow-files.js');
const remoteIoSrc = read('public/js/remote-io.js');
const browserView = read('public/js/browser-view.js');
const indexHtml = read('public/index.html');
const i18n = read('public/js/i18n.js');
const css = read('public/css/styles.css');
const chromeView = read('src/core/ChromeView.ts');

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function boot(opts: { workflow?: { id: string } | null; answers?: Record<string, unknown> } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window as unknown as Record<string, any>;
  const calls: Call[] = [];
  const toasts: string[] = [];

  w.AppUtil = { t: (k: string) => k, toast: (m: string) => toasts.push(m) };
  w.API = { getKey: () => 'THE-KEY' };
  w.FlowEditor = { getCurrentWorkflow: () => (opts.workflow === undefined ? { id: 'wf_abc123' } : opts.workflow) };
  w.fetch = (url: string, init: any) => {
    const method = (init && init.method) || 'GET';
    let body: unknown = init && init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    calls.push({ url, method, headers: (init && init.headers) || {}, body });
    const key = `${method} ${url.split('?')[0].replace(/\/browser\/workflow-files\/[^/?]+/, '/wf')}`;
    // The default listing answers EVERY folder with the same two names, but
    // with paths under the folder that was asked for -- as the real server
    // does. A fake that returned `docs` as a child of `docs` made the tree
    // recurse into itself forever (MEASURED: "Maximum call stack size
    // exceeded" as an unhandled rejection under every run of this file).
    const qm = /[?&]path=([^&]*)/.exec(url);
    const folder = method === 'GET' && qm ? decodeURIComponent(qm[1]) : '';
    const under = (name: string) => (folder ? `${folder}/${name}` : name);
    const answer = (opts.answers && opts.answers[key]) || {
      success: true, path: folder, parent: folder ? '' : null, entries: [
        { name: 'docs', path: under('docs'), type: 'dir', size: 0 },
        { name: 'cookies.json', path: under('cookies.json'), type: 'file', size: 12 },
      ],
    };
    const status = typeof (answer as any).__status === 'number' ? (answer as any).__status : 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(answer)),
    });
  };

  // Load remote-io.js first so acceptsFile is available, then the manager —
  // the reverse of index.html on purpose: remote-io reads window.WorkflowFiles
  // lazily, at prompt time, so the order only matters for the button (tested
  // separately against index.html below).
  dom.window.eval(remoteIoSrc);
  dom.window.eval(moduleSrc);

  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { dom, w, calls, toasts, tick, stage: dom.window.document.getElementById('stage')! };
}

// ─────────────────────────────────────────────────────────────────────────
describe('WorkflowFiles: which workflow', () => {
  it('uses the same id rule as the server', () => {
    const { w } = boot();
    const RE: RegExp = w.WorkflowFiles.WORKFLOW_ID_RE;
    for (const id of ['wf_abc', 'A-b_1', 'x'.repeat(64)]) {
      expect(RE.test(id), id).toBe(isValidWorkflowId(id));
      expect(RE.test(id), id).toBe(true);
    }
    for (const id of ['', 'x'.repeat(65), 'wf/1', '../x', 'wf 1', 'wf%2f']) {
      expect(RE.test(id), id).toBe(isValidWorkflowId(id));
      expect(RE.test(id), id).toBe(false);
    }
  });

  it('prefers the explicit id, falls back to the editor, never invents one', () => {
    const { w } = boot();
    expect(w.WorkflowFiles.currentWorkflowId('wf_explicit')).toBe('wf_explicit');
    expect(w.WorkflowFiles.currentWorkflowId('')).toBe('wf_abc123');
    expect(w.WorkflowFiles.currentWorkflowId('../etc')).toBe('');
    const none = boot({ workflow: null });
    expect(none.w.WorkflowFiles.currentWorkflowId()).toBe('');
  });

  it('opens NOTHING without a saved workflow, and says so', async () => {
    const { w, calls, toasts, stage } = boot({ workflow: null });
    let closedWith = '';
    const ok = w.WorkflowFiles.open({ host: stage, onClose: (r: string) => { closedWith = r; } });
    expect(ok).toBe(false);
    expect(w.WorkflowFiles.isOpen()).toBe(false);
    expect(stage.querySelector('.wfm-drawer')).toBeNull();
    expect(calls).toHaveLength(0);
    // t() falls back to the English sentence when the key is untranslated in
    // this harness; the point is that the operator is TOLD, once.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/saved workflow/i);
    expect(closedWith).toBe('no-workflow');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('WorkflowFiles: the panel and its requests', () => {
  let b: ReturnType<typeof boot>;
  beforeEach(() => { b = boot(); });
  afterEach(() => { b.w.WorkflowFiles.close(); });

  it('lists the workflow root with the key in a HEADER, not the URL', async () => {
    expect(b.w.WorkflowFiles.open({ host: b.stage })).toBe(true);
    await b.tick();
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].url).toBe('/browser/workflow-files/wf_abc123?path=');
    expect(b.calls[0].url).not.toContain('THE-KEY');
    expect(b.calls[0].headers['x-api-key']).toBe('THE-KEY');
    const names = [...b.stage.querySelectorAll('.wfm-name')].map((n) => n.textContent);
    expect(names).toEqual(['docs', 'cookies.json']);
  });

  it('renders names as TEXT, never markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>.json';
    b = boot({ answers: { 'GET /wf': { success: true, path: '', parent: null, entries: [
      { name: hostile, path: hostile, type: 'file', size: 1 },
    ] } } });
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    expect(b.stage.querySelector('.wfm-name')!.textContent).toBe(hostile);
    expect(b.stage.querySelector('.wfm-list img')).toBeNull();
  });

  it('walks into a folder by the path the SERVER returned', async () => {
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    (b.stage.querySelector('li.wfm-dir') as HTMLElement).click();
    await b.tick();
    expect(b.calls[1].url).toBe('/browser/workflow-files/wf_abc123?path=docs');
  });

  it('selects only files, and Select is disabled until one is picked', async () => {
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    const select = b.stage.querySelector('.wfm-select') as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    (b.stage.querySelector('li.wfm-file') as HTMLElement).click();
    expect(select.disabled).toBe(false);
    expect(b.stage.querySelector('li.sel')!.textContent).toContain('cookies.json');
  });

  it('/use names the relative path and the socket identity, NO chooserId, and reports the NAME', async () => {
    const used: unknown[] = [];
    let closedWith = '';
    b = boot({ answers: { 'POST /wf/use': { success: true, name: 'cookies.json', size: 12, count: 1 } } });
    b.w.WorkflowFiles.open({
      host: b.stage,
      userId: () => 'u-42',
      onUsed: (d: unknown) => used.push(d),
      onClose: (r: string) => { closedWith = r; },
    });
    await b.tick();
    (b.stage.querySelector('li.wfm-file') as HTMLElement).click();
    (b.stage.querySelector('.wfm-select') as HTMLElement).click();
    await b.tick();
    const use = b.calls.find((c) => c.url.endsWith('/use'))!;
    expect(use.method).toBe('POST');
    expect(use.url).toBe('/browser/workflow-files/wf_abc123/use');
    expect(use.body).toEqual({ path: 'cookies.json', userId: 'u-42' });
    expect(use.body).not.toHaveProperty('chooserId');
    expect(use.headers['x-api-key']).toBe('THE-KEY');
    expect(used).toEqual([{ name: 'cookies.json', size: 12 }]);
    expect(closedWith).toBe('used');
    expect(b.w.WorkflowFiles.isOpen()).toBe(false);
  });

  it('refuses a file the page would reject BEFORE asking the server', async () => {
    b.w.WorkflowFiles.open({ host: b.stage, accept: '.csv' });
    await b.tick();
    (b.stage.querySelector('li.wfm-file') as HTMLElement).click();
    (b.stage.querySelector('.wfm-select') as HTMLElement).click();
    await b.tick();
    expect(b.calls.some((c) => c.url.endsWith('/use'))).toBe(false);
    expect(b.stage.querySelector('.wfm-note')!.className).toContain('err');
    expect(b.w.WorkflowFiles.isOpen()).toBe(true);
  });

  it('shows the server\u2019s refusal in its own words and stays open', async () => {
    b = boot({ answers: { 'POST /wf/use': { success: false, error: 'The page is not asking for a file any more.', __status: 409 } } });
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    (b.stage.querySelector('li.wfm-file') as HTMLElement).click();
    (b.stage.querySelector('.wfm-select') as HTMLElement).click();
    await b.tick();
    expect(b.stage.querySelector('.wfm-note')!.textContent).toBe('The page is not asking for a file any more.');
    expect(b.w.WorkflowFiles.isOpen()).toBe(true);
    expect((b.stage.querySelector('.wfm-select') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the toolbar\u2019s Upload lands in uploads/ from the workspace root, as raw bytes with the name in the query', async () => {
    // uploads/ is the folder the contract says staged INPUT lives in; a file
    // dropped in the root would still hand over, but a node looking for
    // inputs would not find it.
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    (b.stage.querySelector('.wfm-upload') as HTMLElement).click();
    const input = b.stage.querySelector('.wfm-input') as HTMLInputElement;
    const file = new b.w.File(['a,b'], 'rows.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new b.w.Event('change'));
    await b.tick(); await b.tick(); await b.tick();
    const up = b.calls.find((c) => c.url.indexOf('/upload?') >= 0)!;
    expect(up).toBeTruthy();
    expect(up.method).toBe('POST');
    expect(up.url).toBe('/browser/workflow-files/wf_abc123/upload?path=uploads&name=rows.csv');
    expect(up.headers['Content-Type']).toBe('application/octet-stream');
    expect(up.body).toBe(file);
  });

  it('Upload Here on a folder lands in THAT folder', async () => {
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    const dir = b.stage.querySelector('li.wfm-dir') as HTMLElement;
    dir.dispatchEvent(new b.w.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    const item = [...b.stage.querySelectorAll('.wfm-menu button')].find((x) => x.textContent === 'Upload Here') as HTMLElement;
    expect(item).toBeTruthy();
    item.click();
    const input = b.stage.querySelector('.wfm-input') as HTMLInputElement;
    const file = new b.w.File(['x'], 'n.txt');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new b.w.Event('change'));
    await b.tick(); await b.tick(); await b.tick();
    const up = b.calls.find((c) => c.url.indexOf('/upload?') >= 0)!;
    expect(up.url).toBe('/browser/workflow-files/wf_abc123/upload?path=docs&name=n.txt');
  });

  it('New File goes through POST /file with a JSON body, never a one-byte upload', async () => {
    b.w.prompt = () => 'notes.md';
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    (b.stage.querySelector('.wfm-mkfile') as HTMLElement).click();
    await b.tick(); await b.tick();
    const mk = b.calls.find((c) => c.url.endsWith('/file'))!;
    expect(mk).toBeTruthy();
    expect(mk.method).toBe('POST');
    expect(mk.headers['Content-Type']).toBe('application/json');
    expect(mk.body).toEqual({ path: '', name: 'notes.md' });
    expect(b.calls.some((c) => c.url.indexOf('/upload') >= 0)).toBe(false);
  });

  describe('the breadcrumb: going INTO a folder and back', () => {
    const deep = {
      'GET /wf': {
        success: true, path: '', parent: null, entries: [
          { name: 'docs', path: 'docs', type: 'dir', size: 0 },
          { name: 'cookies.json', path: 'cookies.json', type: 'file', size: 12 },
        ],
      },
    };
    const crumbs = () => [...b.stage.querySelectorAll('.wfm-crumbs .wfm-crumb:not(.wfm-back)')].map((c) => c.textContent);

    it('starts at the workspace with no Back arrow; double-clicking a folder roots the tree there', async () => {
      b = boot({ answers: deep });
      b.w.WorkflowFiles.open({ host: b.stage });
      await b.tick();
      expect(crumbs()).toEqual(['Workflow']);
      expect(b.stage.querySelector('.wfm-back')).toBeNull();
      expect(b.stage.querySelector('.wfm-crumb.on')!.getAttribute('aria-current')).toBe('location');

      (b.stage.querySelector('li.wfm-dir') as HTMLElement).dispatchEvent(new b.w.MouseEvent('dblclick', { bubbles: true }));
      await b.tick(); await b.tick();
      expect(crumbs()).toEqual(['Workflow', 'docs']);
      expect(b.stage.querySelector('.wfm-back')).toBeTruthy();
      expect(b.calls.some((c) => c.url === '/browser/workflow-files/wf_abc123?path=docs')).toBe(true);
      // The fake answers every folder with the same two entries, so the rows
      // now on screen are docs' children at depth 0.
      const rows = [...b.stage.querySelectorAll('.wfm-list li[data-path]')] as HTMLElement[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].style.getPropertyValue('--wfm-depth')).toBe('0');
    });

    it('Back goes up one level and the folder just left stays expanded in place', async () => {
      b = boot({ answers: deep });
      b.w.WorkflowFiles.open({ host: b.stage });
      await b.tick();
      (b.stage.querySelector('li.wfm-dir') as HTMLElement).dispatchEvent(new b.w.MouseEvent('dblclick', { bubbles: true }));
      await b.tick(); await b.tick();
      (b.stage.querySelector('.wfm-back') as HTMLElement).click();
      await b.tick(); await b.tick();
      expect(crumbs()).toEqual(['Workflow']);
      const docs = b.stage.querySelector('li[data-path="docs"]')!;
      expect(docs.getAttribute('aria-expanded')).toBe('true');
    });

    it('the menu\u2019s Open goes into the folder; the toolbar then acts on THAT folder', async () => {
      b = boot({ answers: deep });
      b.w.prompt = () => 'sub';
      b.w.WorkflowFiles.open({ host: b.stage });
      await b.tick();
      const dir = b.stage.querySelector('li.wfm-dir') as HTMLElement;
      dir.dispatchEvent(new b.w.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
      const open = [...b.stage.querySelectorAll('.wfm-menu button')].find((x) => x.textContent === 'Open') as HTMLElement;
      open.click();
      await b.tick(); await b.tick();
      expect(crumbs()).toEqual(['Workflow', 'docs']);
      (b.stage.querySelector('.wfm-mkdir') as HTMLElement).click();
      await b.tick();
      const mk = b.calls.find((c) => c.url.endsWith('/mkdir'))!;
      expect(mk.body).toEqual({ path: 'docs', name: 'sub' });
    });
  });

  describe('the system folders uploads/ and downloads/', () => {
    const withSystem = {
      'GET /wf': {
        success: true, path: '', parent: null, entries: [
          { name: 'uploads', path: 'uploads', type: 'dir', size: 0, system: true },
          { name: 'downloads', path: 'downloads', type: 'dir', size: 0, system: true },
          { name: 'docs', path: 'docs', type: 'dir', size: 0 },
          { name: 'cookies.json', path: 'cookies.json', type: 'file', size: 12 },
        ],
      },
    };
    const labels = () => [...b.stage.querySelectorAll('.wfm-menu button')].map((x) => x.textContent);

    it('are drawn apart with a tag saying what each is for', async () => {
      b = boot({ answers: withSystem });
      b.w.WorkflowFiles.open({ host: b.stage });
      await b.tick();
      const up = b.stage.querySelector('li[data-path="uploads"]')!;
      const down = b.stage.querySelector('li[data-path="downloads"]')!;
      expect(up.className).toContain('wfm-sys');
      expect(up.getAttribute('data-system')).toBe('true');
      expect(up.querySelector('.wfm-sys-tag')!.textContent).toBe('input');
      expect(down.querySelector('.wfm-sys-tag')!.textContent).toBe('output');
      expect(b.stage.querySelector('li[data-path="docs"] .wfm-sys-tag')).toBeNull();
    });

    it('offer no Rename or Delete in their menu, but everything that puts files INTO them', async () => {
      b = boot({ answers: withSystem });
      b.w.WorkflowFiles.open({ host: b.stage });
      await b.tick();
      (b.stage.querySelector('li[data-path="uploads"]') as HTMLElement).dispatchEvent(new b.w.MouseEvent('contextmenu', { bubbles: true }));
      expect(labels()).toEqual(['Open', 'New File', 'New Folder', 'Upload Here']);
      (b.stage.querySelector('li[data-path="docs"]') as HTMLElement).dispatchEvent(new b.w.MouseEvent('contextmenu', { bubbles: true }));
      expect(labels()).toEqual(['Open', 'New File', 'New Folder', 'Upload Here', 'Rename', 'Delete']);
    });
  });

  it('bind() POSTs /bind with target live and the socket identity, and resolves what the server said', async () => {
    b = boot({ answers: { 'POST /wf/bind': { success: true, target: 'live', workflowId: 'wf_abc123', bound: true } } });
    const bound = await b.w.WorkflowFiles.bind({ userId: () => 'u-42' });
    expect(bound).toBe(true);
    const c = b.calls.find((x) => x.url.endsWith('/bind'))!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/browser/workflow-files/wf_abc123/bind');
    expect(c.body).toEqual({ target: 'live', userId: 'u-42' });
    expect(c.headers['x-api-key']).toBe('THE-KEY');
  });

  it('bind() resolves false -- and sends nothing -- without a saved workflow; false, not a throw, on a refusal', async () => {
    const none = boot({ workflow: null });
    expect(await none.w.WorkflowFiles.bind({ userId: 'u' })).toBe(false);
    expect(none.calls).toHaveLength(0);
    b = boot({ answers: { 'POST /wf/bind': { success: false, error: 'nope', __status: 403 } } });
    expect(await b.w.WorkflowFiles.bind({ userId: 'u' })).toBe(false);
  });

  it('a second open() replaces the first; close() removes the drawer', () => {
    b.w.WorkflowFiles.open({ host: b.stage });
    b.w.WorkflowFiles.open({ host: b.stage });
    expect(b.stage.querySelectorAll('.wfm-drawer')).toHaveLength(1);
    b.w.WorkflowFiles.close();
    expect(b.stage.querySelector('.wfm-drawer')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('RemoteIO offers Workflow Files as the second source', () => {
  it('shows the button only when the module is present, and opens it with the socket identity', async () => {
    const b = boot();
    const sent: unknown[] = [];
    const rio = b.w.RemoteIO.attach({
      stage: b.stage, host: b.stage, send: (m: unknown) => sent.push(m),
      userId: () => 'u-42', workflowId: () => 'wf_explicit',
    });
    expect(rio.onMessage({ t: 'filechooser', accept: '.json', multiple: false })).toBe(true);
    const bar = b.stage.querySelector('.rio-filebar')!;
    expect(bar.querySelector('.rio-choose')!.textContent).toBe('Upload from Computer');
    expect(bar.querySelector('.rio-workflow')!.textContent).toBe('Choose from Workflow Files');
    expect(bar.querySelector('.rio-cancel')).toBeTruthy();

    (bar.querySelector('.rio-workflow') as HTMLElement).click();
    await b.tick();
    expect(b.w.WorkflowFiles.isOpen()).toBe(true);
    // The explicit id from the surface, not the editor's.
    expect(b.calls[0].url).toBe('/browser/workflow-files/wf_explicit?path=');
    // The bar's own buttons stand down while the panel is up …
    expect((bar.querySelector('.rio-choose') as HTMLButtonElement).disabled).toBe(true);
    // … and come back when it is dismissed without a hand-over.
    (b.stage.querySelector('.wfm-close') as HTMLElement).click();
    expect(b.w.WorkflowFiles.isOpen()).toBe(false);
    expect((bar.querySelector('.rio-choose') as HTMLButtonElement).disabled).toBe(false);
    // Nothing went over the socket: the hand-over is the SERVER's, in-process.
    expect(sent).toEqual([]);
    rio.detach();
  });

  it('the socket\u2019s fileChooserDone closes both the bar and the panel', async () => {
    const b = boot();
    const rio = b.w.RemoteIO.attach({ stage: b.stage, host: b.stage, send: () => {}, userId: 'u-42' });
    rio.onMessage({ t: 'filechooser', accept: '', multiple: false });
    (b.stage.querySelector('.rio-workflow') as HTMLElement).click();
    await b.tick();
    expect(b.w.WorkflowFiles.isOpen()).toBe(true);
    rio.onMessage({ t: 'fileChooserDone', ok: true });
    expect(b.stage.querySelector('.rio-filebar')).toBeNull();
    expect(b.w.WorkflowFiles.isOpen()).toBe(false);
    expect(rio.hasPendingFile()).toBe(false);
  });

  it('binds the live session to the workflow when the socket says ready, and again on every ready', async () => {
    const b = boot({ answers: { 'POST /wf/bind': { success: true, bound: true } } });
    const rio = b.w.RemoteIO.attach({
      stage: b.stage, host: b.stage, send: () => {},
      userId: () => 'u-42', workflowId: () => 'wf_explicit',
    });
    // 'ready' is observed, not consumed: the view still gets to act on it.
    expect(rio.onMessage({ t: 'ready', url: 'about:blank' })).toBe(false);
    await b.tick();
    const binds = b.calls.filter((c) => c.url.endsWith('/bind'));
    expect(binds).toHaveLength(1);
    expect(binds[0].url).toBe('/browser/workflow-files/wf_explicit/bind');
    expect(binds[0].body).toEqual({ target: 'live', userId: 'u-42' });
    // A reconnect says 'ready' again: bind again (a re-bind replaces on the server).
    rio.onMessage({ t: 'ready' });
    await b.tick();
    expect(b.calls.filter((c) => c.url.endsWith('/bind'))).toHaveLength(2);
    rio.detach();
  });

  it('does not bind when there is no saved workflow, and survives the module being absent', async () => {
    const b = boot({ workflow: null });
    const rio = b.w.RemoteIO.attach({ stage: b.stage, host: b.stage, send: () => {}, userId: 'u' });
    expect(rio.onMessage({ t: 'ready' })).toBe(false);
    await b.tick();
    expect(b.calls).toHaveLength(0);
    // No WorkflowFiles at all: still not an error.
    const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', { runScripts: 'outside-only' });
    const w = dom.window as unknown as Record<string, any>;
    w.AppUtil = { t: (k: string) => k, toast: () => {} };
    dom.window.eval(remoteIoSrc);
    const stage = dom.window.document.getElementById('stage')!;
    const bare = w.RemoteIO.attach({ stage, host: stage, send: () => {}, userId: 'u' });
    expect(bare.onMessage({ t: 'ready' })).toBe(false);
  });

  it('without the module, the prompt is exactly what it was: upload + cancel', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', { runScripts: 'outside-only' });
    const w = dom.window as unknown as Record<string, any>;
    w.AppUtil = { t: (k: string) => k, toast: () => {} };
    dom.window.eval(remoteIoSrc);
    const stage = dom.window.document.getElementById('stage')!;
    const rio = w.RemoteIO.attach({ stage, host: stage, send: () => {}, userId: 'u' });
    rio.onMessage({ t: 'filechooser', accept: '', multiple: false });
    expect(stage.querySelector('.rio-workflow')).toBeNull();
    expect(stage.querySelector('.rio-choose')).toBeTruthy();
    expect(stage.querySelector('.rio-cancel')).toBeTruthy();
    expect(stage.querySelector('.rio-input')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the wiring', () => {
  it('index.html loads workflow-files.js BEFORE remote-io.js', () => {
    const a = indexHtml.indexOf('/js/workflow-files.js');
    const b = indexHtml.indexOf('/js/remote-io.js');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  it('both RemoteIO surfaces pass the saved workflow id through workflowIdFor()', () => {
    const attaches = browserView.match(/RemoteIO\.attach\(\{[\s\S]*?\}\);/g) || [];
    expect(attaches).toHaveLength(2);
    for (const a of attaches) expect(a).toMatch(/workflowId:\s*function\s*\(\)\s*\{\s*return workflowIdFor\(/);
  });

  it('every wfm.* and rio.* key the client asks for exists in both languages', () => {
    const keys = new Set(
      [...(moduleSrc + remoteIoSrc).matchAll(/t\(\s*'((?:wfm|rio)\.[a-zA-Z]+)'/g)].map((m) => m[1]),
    );
    expect(keys.size).toBeGreaterThanOrEqual(20);
    for (const key of keys) {
      const hits = i18n.split(`'${key}':`).length - 1;
      expect(hits, `${key} should be defined twice (fa + en), found ${hits}`).toBe(2);
    }
  });

  it('the breadcrumb, the system-folder tag and the two new icons are all present', () => {
    expect(css).toContain('.wfm-crumbs');
    expect(css).toContain('.wfm-sys-tag');
    const icons = read('public/js/icons.js');
    expect(icons).toContain("'arrow-left'");
    expect(icons).toContain("'folder-open'");
  });

  it('the drawer is styled, sits above the file prompt, and its raw input is hidden', () => {
    expect(css).toContain('.wfm-drawer');
    expect(css).toMatch(/\.wfm-input\s*\{[^}]*display:\s*none/s);
    const bar = /\.rio-filebar\s*\{[^}]*z-index:\s*(\d+)/s.exec(css);
    const drawer = /\.wfm-drawer\s*\{[^}]*z-index:\s*(\d+)/s.exec(css);
    expect(bar && drawer).toBeTruthy();
    expect(Number(drawer![1])).toBeGreaterThan(Number(bar![1]));
    // The hamburger is the ONE permanent control, and it goes away while the
    // drawer it opens is up.
    expect(css).toContain('.bvp-hamburger');
    expect(css).toMatch(/\.bvp-hamburger\.is-off\s*\{[^}]*display:\s*none/s);
  });

  it('the Local Browser view has its own copy that names the chooser instead of a userId', () => {
    // ChromeView polls GET /browser/real/chooser and answers a specific dialog,
    // so its /use carries chooserId; the canvas views carry the socket's userId.
    expect(chromeView).toContain("'/browser/workflow-files/' + encodeURIComponent(workflowId)");
    expect(chromeView).toMatch(/\{\s*path:\s*chosen\[0\]\.path,\s*chooserId:\s*id\s*\}/);
    // The canvas module's /use body never carries a chooserId (code, not comments).
    const code = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('chooserId');
  });

  it('the client never sends or receives a filesystem path', () => {
    expect(moduleSrc).not.toMatch(/absolutePath|\/home\/|C:\\\\/);
    // The only path words are workflow-RELATIVE ones the server returned.
    expect(moduleSrc).toContain('path: chosen[0].path');
  });
});
