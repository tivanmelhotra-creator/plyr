/**
 * File chooser lifecycle, end to end, in a REAL Chromium with a REAL unpacked
 * extension, wired like RealChrome wires it: `FileChooserService.watch(context)`
 * and `attachCDP()` on the browser's DevTools endpoint.
 *
 * THE BUG these pin (two reports, one cause):
 *
 *   1. Website uploads worked only every other attempt, from the operator's
 *      computer AND from Workflow Files.
 *   2. An extension's popup opened its file dialog, a file could be chosen,
 *      and the extension never received it.
 *
 * MEASURED on Chromium 145 before the fix: `attachCDP` enabled file-dialog
 * interception on EVERY page target, twice per target, next to Playwright's own
 * `filechooser`; one click produced three "pending" rows. Answering one of the
 * extra rows sent `Page.handleFileChooser`, a method the protocol does not have
 * (`-32601`), fire-and-forget, then dropped the row as done. The page got
 * nothing, and the view, finding another row, asked again. Popups (which
 * Playwright cannot see) therefore never received a file at all.
 *
 * The extension fixture has the same shape as a real import popup: an
 * <input type=file> in the ACTION POPUP, which is not a Playwright Page.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import type { BrowserContext, Page, Worker } from 'playwright';
import WebSocket from 'ws';

import { FileChooserService, type FileChooserNotice } from '../../src/core/FileChooserService';
import { saveUpload } from '../../src/core/RemoteUploads';

const USER = 'local';

const MANIFEST = {
  manifest_version: 3,
  name: 'plyr import popup fixture',
  version: '1.0.0',
  permissions: ['storage'],
  background: { service_worker: 'sw.js' },
  action: { default_popup: 'popup.html' },
};
const POPUP_HTML = '<!doctype html><html><body><input id="f" type="file" accept=".json"><div id="status">idle</div><script src="popup.js"></script></body></html>';
const POPUP_JS = `window.__got = [];
window.__imported = [];
document.getElementById('f').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const text = await f.text();
  const parsed = JSON.parse(text);
  window.__imported.push(parsed);
  window.__got.push({ name: f.name, text, parsed });
  document.getElementById('status').textContent = 'imported:' + f.name;
  e.target.value = '';
});
window.pick = () => { document.getElementById('f').click(); return true; };`;

const PAGE_HTML = `<!doctype html><input id="f" type="file"><button id="b">pick</button><script>
window.__got = [];
document.getElementById('b').onclick = () => document.getElementById('f').click();
document.getElementById('f').onchange = async (e) => { const f = e.target.files[0];
  window.__got.push({ name: f.name, text: await f.text() }); e.target.value = ''; };</script>`;

let root = '';
let ctx: BrowserContext | null = null;
let svc: FileChooserService;
let worker: Worker | null = null;
let page: Page;
let server: http.Server | null = null;
let base = '';
let debugPort = 0;
let unavailable = '';
const events: Array<{ type: string; id: string; reason?: string }> = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}
async function devtoolsJson<T>(p: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: debugPort, path: p }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** Evaluate in the extension's ACTION POPUP (not a Playwright page), opening it if needed. */
async function inPopup<T = unknown>(expression: string): Promise<T> {
  type Tgt = { id: string; url: string };
  const find = async () => (await devtoolsJson<Tgt[]>('/json/list')).find((t) => t.url.endsWith('/popup.html'));
  let pop = await find();
  if (!pop) {
    for (let i = 0; i < 20 && !pop; i++) {
      await worker!.evaluate(() => (globalThis as any).chrome.action.openPopup()).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      pop = await find();
    }
  }
  if (!pop) throw new Error('popup did not open');
  const sock = new WebSocket(`ws://127.0.0.1:${debugPort}/devtools/page/${pop.id}`);
  await new Promise<void>((res, rej) => { sock.once('open', () => res()); sock.once('error', rej); });
  const out = await new Promise<T>((res, rej) => {
    sock.once('message', (m) => {
      const j = JSON.parse(String(m));
      if (j.error || j.result?.exceptionDetails) rej(new Error(JSON.stringify(j.error || j.result.exceptionDetails)));
      else res(j.result.result.value as T);
    });
    sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression, userGesture: true, awaitPromise: true, returnByValue: true } }));
  });
  sock.close();
  return out;
}

async function nextPending(ms = 8_000): Promise<FileChooserNotice> {
  const until = Date.now() + ms;
  for (;;) {
    const n = svc.pendingAny();
    if (n) return n;
    if (Date.now() > until) throw new Error('no file dialog was reported');
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const sitePending = () => events.filter((e) => e.type === 'pending').length;

type Got = Array<{ name: string; text: string }>;
const siteGot = () => page.evaluate(() => (window as any).__got as Got);
const popupGot = () => inPopup<Got>('window.__got');

/** Press the control that opens the dialog, like the operator does. */
async function openSite(): Promise<void> { await page.click('#b'); }
async function openPopupDialog(): Promise<void> { await inPopup('window.pick()'); }

/** The two ways a file reaches the view's answer: an upload token, or a Workflow Files path. */
async function answerLocal(n: FileChooserNotice, name: string, body: string): Promise<void> {
  const stored = await saveUpload(USER, name, Buffer.from(body));
  await svc.acceptAny(n.id, [stored.token]);
}
async function answerWorkspace(n: FileChooserNotice, name: string, body: string): Promise<void> {
  const file = path.join(root, 'workflow-files', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  await svc.acceptPathsAny(n.id, [file]);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chooser-e2e-'));
  const extDir = path.join(root, 'ext');
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(extDir, 'sw.js'), '');
  await fs.writeFile(path.join(extDir, 'popup.html'), POPUP_HTML);
  await fs.writeFile(path.join(extDir, 'popup.js'), POPUP_JS);

  server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE_HTML); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  try {
    debugPort = await freePort();
    const { chromium } = await import('playwright');
    ctx = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--no-sandbox', `--load-extension=${extDir}`, `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*'],
      timeout: 45_000,
    });
  } catch (e) {
    unavailable = String((e as Error)?.message || e).split('\n')[0];
    return;
  }
  // Wired exactly like RealChrome.launch: watch(context), then attachCDP(ws).
  svc = new FileChooserService(USER, 'default', 'rt-e2e');
  svc.subscribe((e) => events.push({ type: e.type, id: e.notice.id, ...(e.reason ? { reason: e.reason } : {}) }));
  svc.watch(ctx);
  const version = await devtoolsJson<{ webSocketDebuggerUrl: string }>('/json/version');
  svc.attachCDP(version.webSocketDebuggerUrl);
  worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
  if (!worker) { unavailable = 'the fixture extension did not start'; return; }
  page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(base);
  await new Promise((r) => setTimeout(r, 800));       // let the DevTools session attach
}, 120_000);

afterAll(async () => {
  svc?.dispose();
  await ctx?.close().catch(() => {});
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function skipIfUnavailable(t: { skip: (note?: string) => void }): void {
  if (unavailable) t.skip(`no Chromium that can load extensions: ${unavailable}`);
}

describe('File chooser lifecycle: website', () => {
  it('1. local-computer file: the FIRST attempt reaches the page', async (t) => {
    skipIfUnavailable(t);
    const before = sitePending();
    await openSite();
    const n = await nextPending();
    expect(n.id.startsWith('cdp:')).toBe(false);        // Playwright owns a website's dialog
    await answerLocal(n, 'first.json', '{"first":1}');
    const got = await waitFor(async () => { const g = await siteGot(); return g.length ? g : null; });
    expect(got).toEqual([{ name: 'first.json', text: '{"first":1}' }]);
    expect(sitePending() - before).toBe(1);             // ONE dialog, ONE notice: no shadow rows
    expect(svc.pendingAny()).toBeNull();
  });

  it('2. Workflow Files file: the FIRST attempt reaches the page', async (t) => {
    skipIfUnavailable(t);
    await page.evaluate(() => { (window as any).__got = []; });
    await openSite();
    const n = await nextPending();
    await answerWorkspace(n, 'ws.json', '{"ws":1}');
    const got = await waitFor(async () => { const g = await siteGot(); return g.length ? g : null; });
    expect(got).toEqual([{ name: 'ws.json', text: '{"ws":1}' }]);
    expect(svc.pendingAny()).toBeNull();
  });

  it('3. four consecutive uploads, both sources mixed: every one arrives', async (t) => {
    skipIfUnavailable(t);
    await page.evaluate(() => { (window as any).__got = []; });
    for (let i = 1; i <= 4; i++) {
      await openSite();
      const n = await nextPending();
      if (i % 2) await answerLocal(n, `r${i}.json`, `{"i":${i}}`);
      else await answerWorkspace(n, `r${i}.json`, `{"i":${i}}`);
      await waitFor(async () => (await siteGot()).length === i);
      expect(svc.pendingAny()).toBeNull();
    }
    expect((await siteGot()).map((g) => g.text)).toEqual(['{"i":1}', '{"i":2}', '{"i":3}', '{"i":4}']);
  });
});

describe('File chooser lifecycle: extension popup', () => {
  it('4. local-computer file: the FIRST import reaches the extension and is processed', async (t) => {
    skipIfUnavailable(t);
    await openPopupDialog();
    const n = await nextPending();
    expect(n.kind).toBe('extension');
    expect(n.accept).toBe('.json');                      // the popup input's own accept
    await answerLocal(n, 'import1.json', '{"imp":1}');
    const got = await waitFor(async () => { const g = await popupGot(); return g.length ? g : null; });
    expect(got).toEqual([{ name: 'import1.json', text: '{"imp":1}', parsed: { imp: 1 } }]);
    expect(await inPopup('document.getElementById("status").textContent')).toBe('imported:import1.json');
    expect(await inPopup('window.__imported')).toEqual([{ imp: 1 }]);
    expect(svc.pendingAny()).toBeNull();
  });

  it('5. Workflow Files file: the FIRST import reaches the extension and is processed', async (t) => {
    skipIfUnavailable(t);
    await inPopup('window.__got = []; window.__imported = []; document.getElementById("status").textContent = "idle"; true');
    await openPopupDialog();
    const n = await nextPending();
    await answerWorkspace(n, 'import2.json', '{"imp":2}');
    const got = await waitFor(async () => { const g = await popupGot(); return g.length ? g : null; });
    expect(got).toEqual([{ name: 'import2.json', text: '{"imp":2}', parsed: { imp: 2 } }]);
    expect(await inPopup('document.getElementById("status").textContent')).toBe('imported:import2.json');
    expect(await inPopup('window.__imported')).toEqual([{ imp: 2 }]);
    expect(svc.pendingAny()).toBeNull();
  });

  it('6. four consecutive imports, both sources mixed: every one arrives and is processed', async (t) => {
    skipIfUnavailable(t);
    await inPopup('window.__got = []; window.__imported = []; document.getElementById("status").textContent = "idle"; true');
    for (let i = 1; i <= 4; i++) {
      await openPopupDialog();
      const n = await nextPending();
      if (i % 2) await answerLocal(n, `m${i}.json`, `{"m":${i}}`);
      else await answerWorkspace(n, `m${i}.json`, `{"m":${i}}`);
      await waitFor(async () => (await popupGot()).length === i);
      expect(svc.pendingAny()).toBeNull();
    }
    expect((await popupGot()).map((g) => g.text)).toEqual(['{"m":1}', '{"m":2}', '{"m":3}', '{"m":4}']);
    expect(await inPopup('window.__imported')).toEqual([{ m: 1 }, { m: 2 }, { m: 3 }, { m: 4 }]);
  });
});

describe('File chooser lifecycle: state is reset between operations', () => {
  it('7. cancel releases the dialog, and the next one is a fresh request', async (t) => {
    skipIfUnavailable(t);
    await inPopup('window.__got = []; window.__imported = []; document.getElementById("status").textContent = "idle"; true');
    await openPopupDialog();
    const first = await nextPending();
    expect(await svc.cancelAny(first.id)).toBe(true);
    expect(svc.pendingAny()).toBeNull();
    await openPopupDialog();
    const second = await nextPending();
    expect(second.id).not.toBe(first.id);
    await answerLocal(second, 'after-cancel.json', '{"ok":1}');
    expect(await waitFor(async () => { const g = await popupGot(); return g.length ? g : null; }))
      .toEqual([{ name: 'after-cancel.json', text: '{"ok":1}', parsed: { ok: 1 } }]);
    expect(await inPopup('window.__imported')).toEqual([{ ok: 1 }]);
  });

  it('8. an answered request cannot be answered twice, and leaves no residue', async (t) => {
    skipIfUnavailable(t);
    await openSite();
    const n = await nextPending();
    await answerLocal(n, 'once.json', '{"once":1}');
    await expect(svc.acceptAny(n.id, [])).rejects.toThrow();
    expect(svc.pendingAny()).toBeNull();
    // Every notice that was raised was also closed: nothing is left dangling.
    const pending = events.filter((e) => e.type === 'pending').map((e) => e.id);
    const done = new Set(events.filter((e) => e.type === 'done').map((e) => e.id));
    expect(pending.filter((id) => !done.has(id))).toEqual([]);
  });

  it('9. a dialog raised twice by the page is reported once per dialog', async (t) => {
    skipIfUnavailable(t);
    const before = sitePending();
    await openSite();
    const n = await nextPending();
    await svc.cancelAny(n.id);
    await openSite();
    const m = await nextPending();
    await svc.cancelAny(m.id);
    expect(sitePending() - before).toBe(2);
  });

  it('10. a tab opened AFTER the DevTools session attached (LiveBrowser.newTab order): one notice, no prompt after the answer', async (t) => {
    skipIfUnavailable(t);
    // MEASURED through LiveBrowser.newTab: a page Playwright just opened
    // announces itself over DevTools BEFORE it is in context.pages(), so a
    // classification made when the target appears calls it "not ours", and the
    // dialog then shows up twice: once as a phantom, once as Playwright's real
    // one. Answering the phantom left the real one pending, and the view raised
    // "Add File" AGAIN after a successful upload.
    const fresh = await ctx!.newPage();
    await fresh.goto(base);
    await fresh.bringToFront();
    const before = events.length;
    await fresh.click('#b');
    const n = await nextPending();
    expect(n.id.startsWith('cdp:')).toBe(false);
    await answerLocal(n, 'late.json', '{"late":1}');
    await waitFor(async () => (await fresh.evaluate(() => (window as any).__got.length)) === 1);
    await new Promise((r) => setTimeout(r, 1200));      // a straggler would arrive by now
    const mine = events.slice(before);
    expect(mine.map((e) => e.type)).toEqual(['pending', 'done']);
    expect(svc.pendingAny()).toBeNull();
    await fresh.close();
  });
});
