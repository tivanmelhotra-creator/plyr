/**
 * workflow-files-browser-switch.test.ts -- the Local Browser switch in the
 * workflow editor's Workflow Files drawer.
 *
 * One button: OFF by default ("Turn on"), ON when the server says the Local
 * Browser is running ("Turn off"). Turning it on opens the same remote view the
 * element picker opens, but through openRealBrowser() -- never requestPick() --
 * so no field request exists and the extension's "Connect this browser to a
 * field?" alert has nothing to show. Turning it off closes the browser with
 * POST /browser/real/close (NOT /browser/stop, which also disables self-heal and
 * would make the next "Turn on" refuse).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const moduleSrc = read('public/js/workflow-files.js');
const css = read('public/css/styles.css');
const i18n = read('public/js/i18n.js');

interface Call { url: string; method: string; body: any }
interface Opts { browserView?: boolean; running?: boolean; openFails?: string }

function boot(o: Opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window as unknown as Record<string, any>;
  const calls: Call[] = [];
  const opened: Array<{ url: string; target: unknown; opts: any }> = [];
  const server = { running: !!o.running };

  w.prompt = (() => null).bind(null);
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.FlowEditor = { getCurrentWorkflow: () => ({ id: 'wf_abc123' }) };
  if (o.browserView !== false) {
    w.BrowserView = {
      openRealBrowser: (url: string, target: unknown, opts: any) => {
        opened.push({ url, target, opts });
        if (o.openFails) return Promise.reject(new Error(o.openFails));
        server.running = true;
        return Promise.resolve({ success: true });
      },
    };
  }
  w.fetch = (url: string, init: any) => {
    const method = (init && init.method) || 'GET';
    let body: any = init && init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    calls.push({ url, method, body });
    let answer: any = { success: true, entries: [] };
    if (url === '/browser/real/health') answer = { success: true, enabled: true, running: server.running, responsive: server.running };
    if (url === '/browser/real/close' && method === 'POST') { server.running = false; answer = { success: true }; }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(answer)) });
  };
  dom.window.eval(moduleSrc);

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { await tick(); await tick(); await tick(); };
  const stage = dom.window.document.getElementById('stage')!;
  return { dom, w, calls, opened, server, settle, stage };
}

let b: ReturnType<typeof boot>;
afterEach(() => { try { b?.w.WorkflowFiles.close(); } catch { /* already gone */ } });

const rowEl = () => b.stage.querySelector('.wfm-browser') as HTMLElement | null;
const btn = () => b.stage.querySelector('.wfm-br-btn') as HTMLButtonElement;
const label = () => (b.stage.querySelector('.wfm-br-label') as HTMLElement).textContent;
const openEditorDrawer = async (o: Opts = {}) => {
  b = boot(o);
  b.w.WorkflowFiles.open({ host: b.stage, browseOnly: true });
  await b.settle();
};

describe('the Local Browser switch', () => {
  it('is OFF by default, offers "Turn on", and asks the server rather than assuming', async () => {
    await openEditorDrawer();
    expect(rowEl()!.classList.contains('is-off')).toBe(true);
    expect(label()).toBe('Local Browser \u00b7 Off');
    expect(btn().textContent).toBe('Turn on');
    expect(b.calls.some((c) => c.method === 'GET' && c.url === '/browser/real/health')).toBe(true);
    // Nothing is started until it is pressed.
    expect(b.opened).toHaveLength(0);
  });

  it('shows "Turn off" when the server says the browser is already running', async () => {
    await openEditorDrawer({ running: true });
    expect(rowEl()!.classList.contains('is-on')).toBe(true);
    expect(label()).toBe('Local Browser \u00b7 Running');
    expect(btn().textContent).toBe('Turn off');
  });

  it('Turn on opens the viewer through openRealBrowser for THIS workflow, with no field request', async () => {
    await openEditorDrawer();
    btn().click();
    // Busy at once, so a second press cannot start a second launch.
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toBe('Starting\u2026');
    await b.settle();
    expect(b.opened).toEqual([{ url: '', target: null, opts: { workflowId: 'wf_abc123' } }]);
    expect(label()).toBe('Local Browser \u00b7 Running');
    expect(btn().textContent).toBe('Turn off');
    // No pick was begun, so there is no consent for the extension to draw.
    expect(b.calls.some((c) => /inspector|targeting|consent/.test(c.url))).toBe(false);
  });

  it('Turn off closes with POST /browser/real/close, never /browser/stop', async () => {
    await openEditorDrawer({ running: true });
    btn().click();
    expect(btn().textContent).toBe('Stopping\u2026');
    await b.settle();
    expect(b.calls.some((c) => c.method === 'POST' && c.url === '/browser/real/close')).toBe(true);
    expect(b.calls.some((c) => c.url.includes('/browser/stop'))).toBe(false);
    expect(label()).toBe('Local Browser \u00b7 Off');
    expect(btn().textContent).toBe('Turn on');
  });

  it('a failed start says why in the drawer and goes back to "Turn on"', async () => {
    await openEditorDrawer({ openFails: 'remote_browser_starting' });
    btn().click();
    await b.settle();
    const note = b.stage.querySelector('.wfm-note') as HTMLElement;
    expect(note.textContent).toBe('remote_browser_starting');
    expect(note.classList.contains('err')).toBe(true);
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).toBe('Turn on');
  });

  it('is not offered where the page cannot open the viewer, nor in the file-picker drawer', async () => {
    await openEditorDrawer({ browserView: false });
    expect(rowEl()).toBeNull();
    b.w.WorkflowFiles.close();

    b = boot();
    b.w.WorkflowFiles.open({ host: b.stage }); // a page is waiting for a file
    await b.settle();
    expect(rowEl()).toBeNull();
    expect(b.calls.some((c) => c.url === '/browser/real/health')).toBe(false);
  });
});

describe('wiring', () => {
  it('both languages carry every key the switch asks for', () => {
    for (const k of ['wfm.browserLabel', 'wfm.browserOn', 'wfm.browserOff', 'wfm.browserStart',
      'wfm.browserStop', 'wfm.browserStarting', 'wfm.browserStopping', 'wfm.browserFailed']) {
      expect(moduleSrc.includes(`'${k}'`), `${k} is asked for`).toBe(true);
      expect(i18n.split(`'${k}':`).length - 1, k).toBe(2);
    }
  });

  it('the row is styled and steps aside while a file is open in the notepad', () => {
    expect(css).toContain('.wfm-browser');
    expect(css).toMatch(/\.wfm-drawer\.is-editing \.wfm-browser\s*\{[^}]*display:\s*none/s);
  });
});
