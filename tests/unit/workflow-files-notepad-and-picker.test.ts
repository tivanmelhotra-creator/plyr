/**
 * workflow-files-notepad-and-picker.test.ts — two things the drawer owed the
 * operator.
 *
 *   1. THE NOTEPAD. Clicking a text file (.txt, .md, .json ...) in the workflow
 *      editor's drawer opens it in an editor, as it already did in the Local
 *      Browser view. It reads through GET .../file and writes through PUT
 *      .../file; a binary file never reaches it; opening it never disturbs the
 *      selection; a draft is not thrown away by one stray click.
 *
 *   2. THE MOVE / COPY DESTINATION PICKER. It used to list only the folders
 *      that had been expanded on screen and it filtered out the two system
 *      folders, so "Move" offered the root and a folder called "test" and
 *      nothing else -- no uploads/, no downloads/, nothing nested. It now offers
 *      the root and EVERY folder, never a folder as its own destination, and
 *      draws names as text. The Local Browser view's copy gets the same rule.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { chromeViewHtml } from '../../src/core/ChromeView';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const moduleSrc = read('public/js/workflow-files.js');
const chromeViewSrc = read('src/core/ChromeView.ts');
const css = read('public/css/styles.css');
const i18n = read('public/js/i18n.js');

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number; system?: boolean };

const dir = (path: string, system = false): Entry =>
  ({ name: path.split('/').pop()!, path, type: 'dir', size: 0, ...(system ? { system: true } : {}) });
const file = (path: string, size = 5): Entry => ({ name: path.split('/').pop()!, path, type: 'file', size });

/** A workspace with the two system folders and folders nested where nobody has expanded. */
const TREE: Record<string, Entry[]> = {
  '': [dir('uploads', true), dir('downloads', true), dir('test'), file('notes.md'), file('logo.png', 9)],
  uploads: [dir('uploads/staged')],
  downloads: [],
  test: [dir('test/deep')],
  'test/deep': [dir('test/deep/x')],
  'test/deep/x': [],
  'uploads/staged': [],
};

interface Call { url: string; method: string; body: any }

function boot(tree: Record<string, Entry[]> = TREE) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window as unknown as Record<string, any>;
  const calls: Call[] = [];
  const contents: Record<string, string> = { 'notes.md': '# hello\nworld' };

  // The module draws its in-drawer picker only when `prompt` is the browser's
  // own (a native function); jsdom's is not, which would select the typed-path
  // fallback. A bound function stringifies as native code.
  w.prompt = (() => null).bind(null);
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.FlowEditor = { getCurrentWorkflow: () => ({ id: 'wf_abc123' }) };
  w.fetch = (url: string, init: any) => {
    const method = (init && init.method) || 'GET';
    let body: any = init && init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    calls.push({ url, method, body });
    const route = url.split('?')[0].replace(/\/browser\/workflow-files\/[^/?]+/, '');
    const q = /[?&]path=([^&]*)/.exec(url);
    const rel = q ? decodeURIComponent(q[1]) : '';
    let answer: any = { success: true };
    if (method === 'GET' && route === '') {
      answer = { success: true, path: rel, parent: rel ? '' : null, entries: tree[rel] || [] };
    } else if (method === 'GET' && route === '/file') {
      answer = { success: true, entry: file(rel), content: contents[rel] ?? '' };
    } else if (method === 'PUT' && route === '/file') {
      contents[body.path] = body.content;
      answer = { success: true, entry: file(body.path) };
    } else if (route === '/move' || route === '/copy') {
      answer = { success: true, count: (body.paths || []).length };
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(answer)) });
  };
  dom.window.eval(moduleSrc);

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { await tick(); await tick(); await tick(); };
  const stage = dom.window.document.getElementById('stage')!;
  const row = (path: string) => stage.querySelector(`li[data-path="${path}"]`) as HTMLElement;
  return { dom, w, calls, contents, tick, settle, stage, row };
}

let b: ReturnType<typeof boot>;
afterEach(() => { try { b?.w.WorkflowFiles.close(); } catch { /* already gone */ } });

const pickTargets = () =>
  [...b.stage.querySelectorAll('.wfm-folder-modal .wfm-modal-tree-item[data-path]')]
    .map((li) => li.getAttribute('data-path'));
const check = (path: string) => (b.row(path).querySelector('.wfm-check') as HTMLInputElement).click();
const press = (cls: string) => (b.stage.querySelector(cls) as HTMLElement).click();
const okButton = () => b.stage.querySelector('.wfm-folder-modal .btn-primary') as HTMLElement;

// ─────────────────────────────────────────────────────────────────────────
describe('Move / Copy destination picker', () => {
  it('offers the root and EVERY folder: system folders and nested ones nobody expanded', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    check('notes.md');
    press('.wfm-movesel');
    await b.settle();
    expect(pickTargets()).toEqual([
      '', 'downloads', 'test', 'test/deep', 'test/deep/x', 'uploads', 'uploads/staged',
    ]);
    // The "Loading folders..." row is gone once the tree is complete.
    expect(b.stage.querySelector('.wfm-folder-modal .wfm-hint')).toBeNull();
  });

  it('moves into a folder that was never expanded, naming it by its relative path', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    check('notes.md');
    press('.wfm-movesel');
    await b.settle();
    (b.stage.querySelector('.wfm-folder-modal [data-path="uploads/staged"]') as HTMLElement).click();
    okButton().click();
    await b.settle();
    const mv = b.calls.find((c) => c.method === 'POST' && c.url.endsWith('/move'))!;
    expect(mv.body).toEqual({ paths: ['notes.md'], to: 'uploads/staged' });
  });

  it('Copy offers the same tree, system folders included', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    check('notes.md');
    press('.wfm-copysel');
    await b.settle();
    expect(pickTargets()).toContain('downloads');
    (b.stage.querySelector('.wfm-folder-modal [data-path="downloads"]') as HTMLElement).click();
    okButton().click();
    await b.settle();
    const cp = b.calls.find((c) => c.method === 'POST' && c.url.endsWith('/copy'))!;
    expect(cp.body).toMatchObject({ paths: ['notes.md'], to: 'downloads' });
  });

  it('never offers a folder as its own destination, nor anything below it', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    check('test');
    press('.wfm-movesel');
    await b.settle();
    expect(pickTargets()).toEqual(['', 'downloads', 'uploads', 'uploads/staged']);
  });

  it('draws a folder name as TEXT, never markup', async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    b = boot({ '': [{ name: evil, path: evil, type: 'dir', size: 0 }, file('notes.md')], [evil]: [] });
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    check('notes.md');
    press('.wfm-movesel');
    await b.settle();
    const modal = b.stage.querySelector('.wfm-folder-modal')!;
    expect(modal.querySelector('img')).toBeNull();
    expect([...modal.querySelectorAll('.wfm-modal-tree-item')].map((li) => li.textContent))
      .toContain(evil);
    expect(b.w.__xss).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the notepad in the workflow editor (browse-only drawer)', () => {
  const open = async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage, browseOnly: true });
    await b.settle();
  };
  const text = () => b.stage.querySelector('.wfm-ed-text') as HTMLTextAreaElement;
  const status = () => b.stage.querySelector('.wfm-ed-status') as HTMLElement;
  const drawer = () => b.stage.querySelector('.wfm-drawer') as HTMLElement;
  const type = (v: string) => {
    text().value = v;
    text().dispatchEvent(new b.w.Event('input', { bubbles: true }));
  };

  it('clicking a text file opens it, reading GET .../file with its relative path', async () => {
    await open();
    b.row('notes.md').click();
    await b.settle();
    const get = b.calls.find((c) => c.method === 'GET' && c.url.includes('/file?'))!;
    expect(get.url).toBe('/browser/workflow-files/wf_abc123/file?path=notes.md');
    expect(drawer().classList.contains('is-editing')).toBe(true);
    expect((b.stage.querySelector('.wfm-editor') as HTMLElement).hidden).toBe(false);
    expect(text().value).toBe('# hello\nworld');
    expect(text().disabled).toBe(false);
    expect(b.stage.querySelector('.wfm-ed-name')!.textContent).toBe('notes.md');
    expect(b.stage.querySelector('.wfm-ed-gutter')!.textContent).toBe('1\n2\n');
  });

  it('opening a file leaves the selection alone, and a double-click does not select or send it', async () => {
    await open();
    b.row('notes.md').click();
    b.row('notes.md').dispatchEvent(new b.w.MouseEvent('dblclick', { bubbles: true }));
    await b.settle();
    expect(b.stage.querySelectorAll('li.sel')).toHaveLength(0);
    expect(b.calls.filter((c) => c.url.includes('/use'))).toHaveLength(0);
  });

  it('Ctrl+S saves with PUT .../file { path, content } to the SAME relative path', async () => {
    await open();
    b.row('notes.md').click();
    await b.settle();
    type('changed text');
    expect(status().classList.contains('dirty')).toBe(true);
    text().dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await b.settle();
    const put = b.calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/browser/workflow-files/wf_abc123/file');
    expect(put.body).toEqual({ path: 'notes.md', content: 'changed text' });
    expect(b.contents['notes.md']).toBe('changed text');
    expect(status().textContent).toBe('Saved');
    expect(status().classList.contains('dirty')).toBe(false);
  });

  it('Close does not throw an unsaved draft away on the first press', async () => {
    await open();
    b.row('notes.md').click();
    await b.settle();
    type('typed but not saved');
    press('.wfm-ed-close');
    expect(drawer().classList.contains('is-editing')).toBe(true);
    expect(status().textContent).toContain('Unsaved changes');
    press('.wfm-ed-close');
    expect(drawer().classList.contains('is-editing')).toBe(false);
    expect((b.stage.querySelector('.wfm-editor') as HTMLElement).hidden).toBe(true);
    expect(b.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a clean file closes at once, back to the tree', async () => {
    await open();
    b.row('notes.md').click();
    await b.settle();
    press('.wfm-ed-close');
    expect(drawer().classList.contains('is-editing')).toBe(false);
    expect(b.row('notes.md')).toBeTruthy();
  });

  it('a binary file never reaches the notepad: no read, it selects as before', async () => {
    await open();
    b.row('logo.png').click();
    await b.settle();
    expect(b.calls.some((c) => c.url.includes('/file?'))).toBe(false);
    expect(drawer().classList.contains('is-editing')).toBe(false);
    expect(b.stage.querySelectorAll('li.sel')).toHaveLength(1);
  });

  it('a refused read is shown in the status line, with Save left off', async () => {
    await open();
    const real = b.w.fetch;
    b.w.fetch = (url: string, init: any) => url.includes('/file?')
      ? Promise.resolve({ ok: false, status: 413, text: () => Promise.resolve(JSON.stringify({ success: false, error: 'Too large for the editor.' })) })
      : real(url, init);
    b.row('notes.md').click();
    await b.settle();
    expect(status().textContent).toBe('Too large for the editor.');
    expect((b.stage.querySelector('.wfm-ed-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the notepad in the file-picker drawer (a page is waiting for a file)', () => {
  it('a click still SELECTS, because that is how a page\u2019s input is answered; Edit is in the row menu', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    b.row('notes.md').click();
    expect(b.stage.querySelectorAll('li.sel')).toHaveLength(1);
    expect(b.calls.some((c) => c.url.includes('/file?'))).toBe(false);
    b.row('notes.md').dispatchEvent(new b.w.MouseEvent('contextmenu', { bubbles: true }));
    const labels = [...b.stage.querySelectorAll('.wfm-menu button')].map((x) => x.textContent);
    expect(labels).toContain('Edit');
    (b.stage.querySelector('.wfm-menu button:nth-child(2)') as HTMLElement).click();
    await b.settle();
    expect(b.stage.querySelector('.wfm-drawer')!.classList.contains('is-editing')).toBe(true);
    expect((b.stage.querySelector('.wfm-ed-text') as HTMLTextAreaElement).value).toBe('# hello\nworld');
  });

  it('the menu offers Edit for a text file only', async () => {
    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage });
    await b.settle();
    b.row('logo.png').dispatchEvent(new b.w.MouseEvent('contextmenu', { bubbles: true }));
    const labels = [...b.stage.querySelectorAll('.wfm-menu button')].map((x) => x.textContent);
    expect(labels).not.toContain('Edit');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('wiring', () => {
  it('both languages carry every new wfm.* key', () => {
    const keys = new Set([...moduleSrc.matchAll(/t\(\s*'(wfm\.[a-zA-Z]+)'/g)].map((m) => m[1]));
    for (const k of ['wfm.edit', 'wfm.save', 'wfm.saved', 'wfm.unsavedClose', 'wfm.notText', 'wfm.loadingFolders']) {
      expect(keys.has(k), `${k} is asked for`).toBe(true);
    }
    for (const k of keys) expect(i18n.split(`'${k}':`).length - 1, k).toBe(1);
  });

  it('the notepad is styled, left-to-right, and hides the tree while a file is open', () => {
    expect(css).toContain('.wfm-editor');
    expect(css).toMatch(/\.wfm-drawer\.is-editing \.wfm-list/);
    expect(css).toMatch(/\.wfm-ed-body\s*\{[^}]*direction:\s*ltr/s);
  });

  it('neither copy of the picker filters the system folders out any more', () => {
    const wf = moduleSrc.slice(moduleSrc.indexOf('function pickFolder('), moduleSrc.indexOf('function movePaths('));
    const cv = chromeViewSrc.slice(chromeViewSrc.indexOf('function wfmPickFolder('), chromeViewSrc.indexOf('function wfmNewFolder('));
    for (const body of [wf, cv]) {
      expect(body).not.toMatch(/!\s*e\.system/);
      expect(body).not.toContain('innerHTML = \'<span class="wfm-ico">');
    }
    expect(cv).toContain('wfmLoadAllFolders()');
    expect(wf).toContain('loadAllFolders()');
  });

  it('Move and Copy tell the picker what is being moved, in both copies', () => {
    expect(moduleSrc.match(/\},\s*paths\);/g) || []).toHaveLength(2);
    expect(chromeViewSrc.match(/\},\s*paths\);/g) || []).toHaveLength(2);
  });

  it('the Local Browser page still parses as a module (ChromeView.ts is ONE template literal)', () => {
    const html = chromeViewHtml();
    const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
    expect(m).toBeTruthy();
    // The script has no static import/export (only a dynamic import()), so it
    // parses as an async function body: top-level await included. A stray
    // backtick or `${` in the TypeScript source would fail HERE, not in a
    // browser that is already running.
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor;
    expect(() => new AsyncFunction(m![1])).not.toThrow();
    expect(html).toContain('wfmLoadAllFolders');
  });
});
