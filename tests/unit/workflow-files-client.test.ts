/**
 * workflow-files-client.test.ts — the Workflow File Manager for the canvas views.
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
    const answer = (opts.answers && opts.answers[key]) || {
      success: true, path: '', parent: null, entries: [
        { name: 'docs', path: 'docs', type: 'dir', size: 0 },
        { name: 'cookies.json', path: 'cookies.json', type: 'file', size: 12 },
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
    expect(stage.querySelector('.wfm-panel')).toBeNull();
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

  it('uploads INTO the current folder as raw bytes with the name in the query', async () => {
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.tick();
    const input = b.stage.querySelector('.wfm-input') as HTMLInputElement;
    const file = new b.w.File(['a,b'], 'rows.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new b.w.Event('change'));
    await b.tick(); await b.tick(); await b.tick();
    const up = b.calls.find((c) => c.url.indexOf('/upload?') >= 0)!;
    expect(up).toBeTruthy();
    expect(up.method).toBe('POST');
    expect(up.url).toBe('/browser/workflow-files/wf_abc123/upload?path=&name=rows.csv');
    expect(up.headers['Content-Type']).toBe('application/octet-stream');
    expect(up.body).toBe(file);
  });

  it('a second open() replaces the first; close() removes the panel', () => {
    b.w.WorkflowFiles.open({ host: b.stage });
    b.w.WorkflowFiles.open({ host: b.stage });
    expect(b.stage.querySelectorAll('.wfm-panel')).toHaveLength(1);
    b.w.WorkflowFiles.close();
    expect(b.stage.querySelector('.wfm-panel')).toBeNull();
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

  it('the panel is styled, sits above the file prompt, and its raw input is hidden', () => {
    expect(css).toContain('.wfm-panel');
    expect(css).toMatch(/\.wfm-input\s*\{[^}]*display:\s*none/s);
    const bar = /\.rio-filebar\s*\{[^}]*z-index:\s*(\d+)/s.exec(css);
    const panel = /\.wfm-panel\s*\{[^}]*z-index:\s*(\d+)/s.exec(css);
    expect(bar && panel).toBeTruthy();
    expect(Number(panel![1])).toBeGreaterThan(Number(bar![1]));
  });

  it('the Local Browser view has its own copy that names the chooser instead of a userId', () => {
    // ChromeView polls GET /browser/real/chooser and answers a specific dialog,
    // so its /use carries chooserId; the canvas views carry the socket's userId.
    expect(chromeView).toContain("'/browser/workflow-files/' + encodeURIComponent(workflowId)");
    expect(chromeView).toMatch(/JSON\.stringify\(\{\s*path:\s*chosen\.path,\s*chooserId:\s*id\s*\}\)/);
    // The canvas module's /use body never carries a chooserId (code, not comments).
    const code = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('chooserId');
  });

  it('the client never sends or receives a filesystem path', () => {
    expect(moduleSrc).not.toMatch(/absolutePath|\/home\/|C:\\\\/);
    // The only path words are workflow-RELATIVE ones the server returned.
    expect(moduleSrc).toContain('path: chosen.path');
  });
});
