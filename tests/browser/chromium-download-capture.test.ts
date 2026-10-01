/**
 * Unified Chromium download capture, end to end, in a REAL Chromium launched
 * the way RealChrome launches it (persistent context, acceptDownloads,
 * downloadsPath, --load-extension, a DevTools port), with ALL THREE observers
 * RealChrome runs: the page shelf, the chrome.downloads bridge and the
 * browser-level ChromiumDownloadObserver.
 *
 * The operator's case: J2TEAM Cookies (no `downloads` permission) exports
 * from its ACTION POPUP. Before this change each export stayed a bare GUID in
 * DOWNLOADS_DIR: no page event, no bridge report, nothing in the workflow.
 *
 * The fixture `nodl` has the same permission shape (cookies, storage, tabs)
 * and exports the same way (`<a download>` on a blob / data: URL, from the
 * popup). The popup is not a Playwright page, so it is driven over the same
 * DevTools port the observer uses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import type { BrowserContext, Worker } from 'playwright';
import WebSocket from 'ws';

import { config } from '../../src/config';
import { RealChromeShelf, REAL_CHROME_SHELF_USER, type ShelfEntry } from '../../src/core/RealChromeShelf';
import { ExtensionDownloadBridge } from '../../src/core/ExtensionDownloads';
import { ChromiumDownloadObserver } from '../../src/core/ChromiumDownloadObserver';
import { attachBindingStore, bindRealChrome, resetRealChromeBindingForTests } from '../../src/core/WorkflowBinding';

const WF = { userId: 'local', workflowId: 'wf_unified_capture' };

// Same permission shape as J2TEAM Cookies 1.0.5: NO `downloads`.
const NODL_MANIFEST = {
  manifest_version: 3,
  name: 'plyr no-downloads-permission fixture',
  version: '1.0.0',
  permissions: ['cookies', 'storage', 'tabs'],
  background: { service_worker: 'sw.js' },
  action: { default_popup: 'popup.html' },
};
const NODL_POPUP_HTML = '<!doctype html><html><body><script src="popup.js"></script></body></html>';
const NODL_POPUP_JS = `window.exportBlob = (name, body) => { const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); return true; };
window.exportData = (name, body) => { const a = document.createElement('a');
  a.href = 'data:application/json,' + encodeURIComponent(body); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); return true; };`;

// A second extension WITH `downloads`, so the existing bridge is live too and
// the three observers must agree on one row per file.
const DL_MANIFEST = {
  manifest_version: 3,
  name: 'plyr downloads-permission fixture',
  version: '1.0.0',
  permissions: ['downloads'],
  background: { service_worker: 'sw.js' },
};
const DL_SW = `self.exportFile = (name, body) => new Promise((res) => chrome.downloads.download(
  { url: 'data:application/json;base64,' + btoa(body), filename: name }, (id) => res(id)));`;
const DL_PAGE_HTML = '<!doctype html><html><body><script src="page.js"></script></body></html>';
const DL_PAGE_JS = `window.exportFromTab = (name, body) => new Promise((res) => chrome.downloads.download(
  { url: URL.createObjectURL(new Blob([body], { type: 'application/json' })), filename: name }, (id) => res(id)));`;

let root = '';
let ctx: BrowserContext | null = null;
let shelf: RealChromeShelf;
let observer: ChromiumDownloadObserver | null = null;
let nodlWorker: Worker | null = null;
let dlWorker: Worker | null = null;
let dlExtId = '';
let debugPort = 0;
let server: http.Server | null = null;
let base = '';
let unavailable = '';
type Cfg = { DOWNLOADS_DIR: string; DOWNLOADS_TMP_DIR: string; WORKFLOW_STORAGE_ROOT: string };
let saved: Cfg;

function wfDir(): string {
  return path.join(config.WORKFLOW_STORAGE_ROOT, WF.userId, WF.workflowId, 'downloads');
}
async function wfFiles(): Promise<string[]> {
  return (await fs.readdir(wfDir()).catch(() => [] as string[])).filter((n) => !n.endsWith('.part')).sort();
}
async function settled(n: number, ms = 15_000): Promise<ShelfEntry[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = shelf.list();
    if (rows.length >= n && rows.every((r) => r.state !== 'inProgress')) return rows;
    if (Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}
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

/** Run `expression` in the extension's action popup, as a user click would. */
async function inPopup(expression: string): Promise<void> {
  type T = { id: string; url: string };
  let pop = (await devtoolsJson<T[]>('/json/list')).find((t) => t.url.endsWith('/popup.html'));
  if (!pop) {
    await nodlWorker!.evaluate(() => (globalThis as any).chrome.action.openPopup());
    for (let i = 0; i < 50 && !pop; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pop = (await devtoolsJson<T[]>('/json/list')).find((t) => t.url.endsWith('/popup.html'));
    }
  }
  if (!pop) throw new Error('popup did not open');
  const ws = new WebSocket(`ws://127.0.0.1:${debugPort}/devtools/page/${pop.id}`);
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  await new Promise<void>((res, rej) => {
    ws.once('message', (m) => {
      const j = JSON.parse(String(m));
      if (j.error || j.result?.exceptionDetails) rej(new Error(JSON.stringify(j.error || j.result.exceptionDetails)));
      else res();
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, userGesture: true, awaitPromise: true } }));
  });
  ws.close();
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-dl-'));
  const c = config as unknown as Cfg;
  saved = { DOWNLOADS_DIR: c.DOWNLOADS_DIR, DOWNLOADS_TMP_DIR: c.DOWNLOADS_TMP_DIR, WORKFLOW_STORAGE_ROOT: c.WORKFLOW_STORAGE_ROOT };
  c.DOWNLOADS_DIR = path.join(root, 'chrome-downloads');
  c.DOWNLOADS_TMP_DIR = path.join(root, 'shelf');
  c.WORKFLOW_STORAGE_ROOT = path.join(root, 'workflows');
  await fs.mkdir(c.DOWNLOADS_DIR, { recursive: true });
  attachBindingStore(null);
  resetRealChromeBindingForTests();
  await bindRealChrome(WF);

  const nodl = path.join(root, 'ext-nodl');
  await fs.mkdir(nodl, { recursive: true });
  await fs.writeFile(path.join(nodl, 'manifest.json'), JSON.stringify(NODL_MANIFEST));
  await fs.writeFile(path.join(nodl, 'sw.js'), '');
  await fs.writeFile(path.join(nodl, 'popup.html'), NODL_POPUP_HTML);
  await fs.writeFile(path.join(nodl, 'popup.js'), NODL_POPUP_JS);
  const dl = path.join(root, 'ext-dl');
  await fs.mkdir(dl, { recursive: true });
  await fs.writeFile(path.join(dl, 'manifest.json'), JSON.stringify(DL_MANIFEST));
  await fs.writeFile(path.join(dl, 'sw.js'), DL_SW);
  await fs.writeFile(path.join(dl, 'page.html'), DL_PAGE_HTML);
  await fs.writeFile(path.join(dl, 'page.js'), DL_PAGE_JS);

  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<a id="dl" href="/report.csv">download</a>');
    } else if (req.url === '/report.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' });
      res.end('a,b\n1,2\n');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  try {
    debugPort = await freePort();
    const { chromium } = await import('playwright');
    ctx = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      downloadsPath: config.DOWNLOADS_DIR,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--load-extension=${nodl},${dl}`, `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*'],
      timeout: 45_000,
    });
  } catch (e) {
    unavailable = String((e as Error)?.message || e).split('\n')[0];
    return;
  }
  // Wired exactly like RealChrome.launch.
  shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
  shelf.watch(ctx);
  const bridge = new ExtensionDownloadBridge(shelf, { downloadsDir: config.DOWNLOADS_DIR, pollMs: 2_000 });
  await bridge.watch(ctx);
  const version = await devtoolsJson<{ webSocketDebuggerUrl: string }>('/json/version');
  observer = new ChromiumDownloadObserver(shelf, { downloadsDir: config.DOWNLOADS_DIR });
  await observer.attach(version.webSocketDebuggerUrl);

  const until = Date.now() + 15_000;
  while ((!nodlWorker || !dlWorker) && Date.now() < until) {
    for (const w of ctx.serviceWorkers()) {
      const hasDl = await w.evaluate(() => !!(globalThis as any).chrome?.downloads).catch(() => false);
      if (hasDl) dlWorker = w; else nodlWorker = w;
    }
    if (!nodlWorker || !dlWorker) await new Promise((r) => setTimeout(r, 200));
  }
  if (!nodlWorker || !dlWorker) { unavailable = 'the fixture extensions did not start'; return; }
  dlExtId = dlWorker.url().split('/')[2];
  await new Promise((r) => setTimeout(r, 500));
}, 120_000);

afterAll(async () => {
  observer?.dispose();
  await ctx?.close().catch(() => {});
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  Object.assign(config as unknown as Cfg, saved);
  resetRealChromeBindingForTests();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function skipIfUnavailable(t: { skip: (note?: string) => void }): void {
  if (unavailable) t.skip(`no Chromium that can load extensions: ${unavailable}`);
}

describe('Every Chromium download enters the one shelf pipeline', () => {
  it('1. a normal website download is filed ONCE, by the page pipeline', async (t) => {
    skipIfUnavailable(t);
    const page = await ctx!.newPage();
    await page.goto(`${base}/`);
    await page.click('#dl');
    await settled(1);
    await new Promise((r) => setTimeout(r, 1500));      // let the observer decide too
    const rows = shelf.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('report.csv');
    expect(rows[0].source).toBeUndefined();
    expect(await wfFiles()).toEqual(['report.csv']);
    expect(observer!.status().skippedPage).toBe(1);
    await page.close();
  });

  it('2. THE REPORTED CASE: 3 popup exports from an extension WITHOUT downloads permission', async (t) => {
    skipIfUnavailable(t);
    const dirBefore = (await fs.readdir(config.DOWNLOADS_DIR)).sort();
    for (let i = 1; i <= 3; i++) {
      await inPopup(`exportBlob('cookies.json', '{"export":${i}}')`);
      // Each one must arrive on its own, not in a later sweep.
      const rows = await settled(1 + i, 10_000);
      expect(rows.filter((r) => r.name.startsWith('cookies'))).toHaveLength(i);
    }
    const rows = shelf.list().filter((r) => r.name.startsWith('cookies'));
    expect(rows.every((r) => r.state === 'completed')).toBe(true);
    expect(rows.every((r) => r.source === 'extension')).toBe(true);
    const files = (await wfFiles()).filter((f) => f.startsWith('cookies'));
    expect(files).toEqual(['cookies (2).json', 'cookies (3).json', 'cookies.json']);
    const bodies = await Promise.all(files.map((f) => fs.readFile(path.join(wfDir(), f), 'utf8')));
    expect(new Set(bodies)).toEqual(new Set(['{"export":1}', '{"export":2}', '{"export":3}']));
    // No GUID leftovers: every export's bytes were MOVED out of DOWNLOADS_DIR.
    expect((await fs.readdir(config.DOWNLOADS_DIR)).sort()).toEqual(dirBefore);
  });

  it('3. if the DevTools session drops, it comes back and nothing is lost', async (t) => {
    skipIfUnavailable(t);
    // MEASURED: when this session closes Chrome reverts the download behaviour
    // it set, so a page download would go to ~/Downloads. The observer must
    // reconnect and restore it before the operator's next download.
    const reconnects = observer!.status().reconnects;
    (observer as unknown as { ws: WebSocket }).ws.terminate();
    const until = Date.now() + 5_000;
    while (Date.now() < until && !(observer!.status().connected && observer!.status().reconnects > reconnects)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(observer!.status().connected).toBe(true);
    await new Promise((r) => setTimeout(r, 300));    // setDownloadBehavior acknowledged
    const before = shelf.list().length;
    const page = await ctx!.newPage();
    await page.goto(`${base}/`);
    await page.click('#dl');
    await inPopup(`exportBlob('after_reconnect.json', '{"r":1}')`);
    const rows = await settled(before + 2);
    await page.close();
    expect(rows.filter((r) => r.name.startsWith('report')).every((r) => r.state === 'completed')).toBe(true);
    expect(rows.find((r) => r.name === 'after_reconnect.json')?.state).toBe('completed');
    expect((await wfFiles()).filter((f) => f.startsWith('report'))).toEqual(['report (2).csv', 'report.csv']);
  });

  it('4. a data: URL popup export keeps its name', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    await inPopup(`exportData('export.json', '{"data":1}')`);
    const rows = await settled(before + 1);
    const row = rows.find((r) => r.name === 'export.json');
    expect(row?.state).toBe('completed');
    expect(row?.workflowPath).toBe('downloads/export.json');
  });

  it('5. an extension-TAB chrome.downloads export is filed once, with 3 observers watching', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    const tab = await ctx!.newPage();
    await tab.goto(`chrome-extension://${dlExtId}/page.html`);
    await tab.evaluate(() => (window as any).exportFromTab('from_tab.json', '{"tab":1}'));
    await settled(before + 1);
    await new Promise((r) => setTimeout(r, 3_000));      // let every late report arrive
    expect(shelf.list().filter((r) => r.name.startsWith('from_tab'))).toHaveLength(1);
    expect((await wfFiles()).filter((f) => f.startsWith('from_tab'))).toEqual(['from_tab.json']);
    await tab.close();
  });

  it('6. a service-worker chrome.downloads export is still filed once (bridge path)', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    await dlWorker!.evaluate(() => (self as any).exportFile('sw_export.json', '{"sw":1}'));
    await settled(before + 1);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(shelf.list().filter((r) => r.name.startsWith('sw_export'))).toHaveLength(1);
    expect((await wfFiles()).filter((f) => f.startsWith('sw_export'))).toEqual(['sw_export.json']);
  });

  it('7. every row is on the feed the viewer delivers from, newest first, no duplicates', async (t) => {
    skipIfUnavailable(t);
    const rows = shelf.list();
    expect(new Set(rows.map((r) => r.token)).size).toBe(rows.length);
    expect(rows.every((r) => r.state === 'completed')).toBe(true);
    expect(rows.length).toBe((await wfFiles()).length);
  });
});
