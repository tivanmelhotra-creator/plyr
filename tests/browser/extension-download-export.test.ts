/**
 * Extension Download/Export, end to end, in a REAL Chromium with a REAL
 * unpacked MV3 extension — launched the way RealChrome launches the Local
 * Browser (persistent context, acceptDownloads, downloadsPath, Playwright's
 * --disable-extensions removed, --load-extension).
 *
 * The contract under test is the one the operator stated:
 *
 *   Browser Download -> Download Handler -> Workflow Workspace -> downloads/
 *
 * for an extension export EXACTLY as for a normal HTML page. Before the fix the
 * service-worker export case below produced 0 `page.on('download')` events and
 * a nameless GUID in DOWNLOADS_DIR that never reached the workflow.
 *
 * Skips (with the reason printed) where no Chromium that can load extensions
 * is installed; `npm run test:browser` in CI installs one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import https from 'https';
import { execFileSync } from 'child_process';
import { createHash, createPublicKey } from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import type { BrowserContext, Worker } from 'playwright';

import { config } from '../../src/config';
import { RealChromeShelf, REAL_CHROME_SHELF_USER, type ShelfEntry } from '../../src/core/RealChromeShelf';
import { ExtensionDownloadBridge } from '../../src/core/ExtensionDownloads';
import { attachBindingStore, bindRealChrome, resetRealChromeBindingForTests } from '../../src/core/WorkflowBinding';

const WF = { userId: 'local', workflowId: 'wf_ext_e2e' };

const MANIFEST = {
  manifest_version: 3,
  name: 'plyr export fixture',
  version: '1.0.0',
  permissions: ['downloads'],
  background: { service_worker: 'sw.js' },
  action: { default_popup: 'popup.html' },
};
// The two ways a real extension exports: from its service worker (a cookie
// manager's background "Export"), and from its own page opened as a tab.
const SW = `self.exportFile = (name, body) => new Promise((res) => chrome.downloads.download(
  { url: 'data:application/json;base64,' + btoa(body), filename: name },
  (id) => res({ id, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : '' })));
self.exportUrl = (url, name) => new Promise((res) => chrome.downloads.download({ url, filename: name }, (id) => res(id)));`;
const POPUP_HTML = '<!doctype html><html><body><script src="popup.js"></script></body></html>';
const POPUP_JS = `window.exportFromTab = (name, body) => new Promise((res) => chrome.downloads.download(
  { url: URL.createObjectURL(new Blob([body], { type: 'application/json' })), filename: name }, (id) => res(id)));
window.exportUrlFromTab = (url, name) => new Promise((res) => chrome.downloads.download({ url, filename: name }, (id) => res(id)));`;

let root = '';
let ctx: BrowserContext | null = null;
let shelf: RealChromeShelf;
let worker: Worker | null = null;
let extId = '';
let server: http.Server | null = null;
let base = '';
let tlsServer: https.Server | null = null;
let tlsBase = '';
let tlsUnavailable = '';
/** Chrome flag that trusts ONLY the fixture's certificate, like a real, validly signed site. */
let tlsTrustArg: string[] = [];
let unavailable = '';
type Cfg = { DOWNLOADS_DIR: string; DOWNLOADS_TMP_DIR: string; WORKFLOW_STORAGE_ROOT: string };
let saved: Cfg;

function wfDir(): string {
  return path.join(config.WORKFLOW_STORAGE_ROOT, WF.userId, WF.workflowId, 'downloads');
}
async function wfFiles(): Promise<string[]> {
  return (await fs.readdir(wfDir()).catch(() => [] as string[])).filter((n) => !n.endsWith('.part')).sort();
}
/** Wait until `n` shelf rows are settled (not inProgress). */
async function settled(n: number, ms = 15_000): Promise<ShelfEntry[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = shelf.list();
    if (rows.length >= n && rows.every((r) => r.state !== 'inProgress')) return rows;
    if (Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-e2e-'));
  const c = config as unknown as Cfg;
  saved = { DOWNLOADS_DIR: c.DOWNLOADS_DIR, DOWNLOADS_TMP_DIR: c.DOWNLOADS_TMP_DIR, WORKFLOW_STORAGE_ROOT: c.WORKFLOW_STORAGE_ROOT };
  c.DOWNLOADS_DIR = path.join(root, 'chrome-downloads');
  c.DOWNLOADS_TMP_DIR = path.join(root, 'shelf');
  c.WORKFLOW_STORAGE_ROOT = path.join(root, 'workflows');
  await fs.mkdir(c.DOWNLOADS_DIR, { recursive: true });
  attachBindingStore(null);
  resetRealChromeBindingForTests();
  await bindRealChrome(WF);

  const extDir = path.join(root, 'ext');
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(extDir, 'sw.js'), SW);
  await fs.writeFile(path.join(extDir, 'popup.html'), POPUP_HTML);
  await fs.writeFile(path.join(extDir, 'popup.js'), POPUP_JS);

  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<a id="dl" href="/report.csv">download</a>');
    } else if (req.url === '/report.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' });
      res.end('a,b\n1,2\n');
    } else if (req.url === '/export.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"http":true}');
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  // An https origin too, with a throwaway self-signed certificate: RealChrome
  // launches with ignoreHTTPSErrors, and so does this fixture.
  try {
    const key = path.join(root, 'tls.key');
    const crt = path.join(root, 'tls.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt,
      '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    tlsServer = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(crt) }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"https":true}');
    });
    await new Promise<void>((r) => tlsServer!.listen(0, '127.0.0.1', () => r()));
    tlsBase = `https://127.0.0.1:${(tlsServer!.address() as AddressInfo).port}`;
    // ignoreHTTPSErrors covers PAGES; a service worker's own download is made
    // by the browser and rejects a self-signed certificate (NETWORK_FAILED,
    // MEASURED). Pinning this one key makes the fixture behave like a real
    // https site with a valid certificate, which is what is under test.
    const spki = createPublicKey(await fs.readFile(crt)).export({ type: 'spki', format: 'der' });
    tlsTrustArg = [`--ignore-certificate-errors-spki-list=${createHash('sha256').update(spki).digest('base64')}`];
  } catch (e) {
    tlsUnavailable = `no openssl to mint a test certificate: ${String((e as Error)?.message || e).split('\n')[0]}`;
  }

  try {
    const { chromium } = await import('playwright');
    ctx = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      // Full Chromium: the headless shell cannot load extensions.
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      downloadsPath: config.DOWNLOADS_DIR,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--load-extension=${extDir}`, ...tlsTrustArg],
      timeout: 45_000,
    });
  } catch (e) {
    unavailable = String((e as Error)?.message || e).split('\n')[0];
    return;
  }
  shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
  shelf.watch(ctx);
  const bridge = new ExtensionDownloadBridge(shelf, { downloadsDir: config.DOWNLOADS_DIR, pollMs: 2_000 });
  await bridge.watch(ctx);
  worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
  if (!worker) { unavailable = 'the fixture extension did not start'; return; }
  extId = worker.url().split('/')[2];
  // Let the bridge finish installing its observer in the worker.
  await new Promise((r) => setTimeout(r, 500));
}, 120_000);

afterAll(async () => {
  await ctx?.close().catch(() => {});
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await new Promise<void>((r) => (tlsServer ? tlsServer.close(() => r()) : r()));
  Object.assign(config as unknown as Cfg, saved);
  resetRealChromeBindingForTests();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Skip VISIBLY (vitest's own per-test skip) when no usable Chromium exists. */
function skipIfUnavailable(t: { skip: (note?: string) => void }): void {
  if (unavailable) t.skip(`no Chromium that can load extensions: ${unavailable}`);
}

describe('Extension Download/Export reaches the Workflow Workspace', () => {
  it('1. a normal HTML page download still reaches <workflow>/downloads/', async (t) => {
    skipIfUnavailable(t);
    const page = await ctx!.newPage();
    await page.goto(`${base}/`);
    await page.click('#dl');
    const rows = await settled(1);
    expect(rows[0].state).toBe('completed');
    expect(rows[0].name).toBe('report.csv');
    expect(rows[0].source).toBeUndefined();          // the page pipeline, untouched
    expect(await wfFiles()).toEqual(['report.csv']);
    await page.close();
  });

  it('2. a service-worker export reaches the SAME workspace, with its own name', async (t) => {
    skipIfUnavailable(t);
    const r = await worker!.evaluate(() => (self as any).exportFile('cookies_site.json', '{"c":1}'));
    expect(r.err).toBe('');
    const rows = await settled(2);
    const row = rows.find((x) => x.name === 'cookies_site.json');
    expect(row?.state).toBe('completed');
    expect(row?.source).toBe('extension');
    expect(row?.workflowPath).toBe('downloads/cookies_site.json');
    expect(await fs.readFile(path.join(wfDir(), 'cookies_site.json'), 'utf8')).toBe('{"c":1}');
  });

  it('3. several extension exports with different names each arrive once', async (t) => {
    skipIfUnavailable(t);
    for (const n of ['a.json', 'b.json', 'c.json']) {
      await worker!.evaluate((name) => (self as any).exportFile(name, `{"n":"${name}"}`), n);
    }
    await settled(5);
    const files = await wfFiles();
    for (const n of ['a.json', 'b.json', 'c.json']) expect(files.filter((f) => f === n)).toHaveLength(1);
  });

  it('4. repeated exports with the SAME filename are all kept, numbered', async (t) => {
    skipIfUnavailable(t);
    for (let i = 1; i <= 3; i++) {
      await worker!.evaluate((n) => (self as any).exportFile('same.json', `{"i":${n}}`), i);
    }
    await settled(8);
    const files = (await wfFiles()).filter((f) => f.startsWith('same'));
    expect(files).toEqual(['same (2).json', 'same (3).json', 'same.json']);
    const bodies = await Promise.all(files.map((f) => fs.readFile(path.join(wfDir(), f), 'utf8')));
    expect(new Set(bodies).size).toBe(3);
  });

  it('5. an export from an extension TAB keeps the requested name and is filed once', async (t) => {
    skipIfUnavailable(t);
    const tab = await ctx!.newPage();
    await tab.goto(`chrome-extension://${extId}/popup.html`);
    await tab.evaluate(() => (window as any).exportFromTab('from_tab.json', '{"tab":1}'));
    await settled(9);
    await new Promise((r) => setTimeout(r, 1500));   // let any duplicate report arrive
    expect((await wfFiles()).filter((f) => f.startsWith('from_tab'))).toEqual(['from_tab.json']);
    expect(shelf.list().filter((x) => x.name.startsWith('from_tab'))).toHaveLength(1);
    await tab.close();
  });

  it('5b. a service-worker export of an http(s) URL reaches the SAME workspace', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    const id = await worker!.evaluate((u) => (self as any).exportUrl(u, 'from_http.json'), `${base}/export.json`);
    expect(typeof id).toBe('number');
    const rows = await settled(before + 1);
    const row = rows.find((x) => x.name === 'from_http.json');
    expect(row?.state).toBe('completed');
    expect(row?.source).toBe('extension');
    expect(row?.workflowPath).toBe('downloads/from_http.json');
    expect(await fs.readFile(path.join(wfDir(), 'from_http.json'), 'utf8')).toBe('{"http":true}');
  });

  it('5c. a service-worker export of an http URL a WEB PAGE already downloaded is not dropped', async (t) => {
    skipIfUnavailable(t);
    // Test 1 downloaded ${base}/report.csv through page.on('download'). The
    // extension now exports the very same URL from its service worker.
    const before = shelf.list().length;
    await worker!.evaluate((u) => (self as any).exportUrl(u, 'ext_report.csv'), `${base}/report.csv`);
    const rows = await settled(before + 1);
    const row = rows.find((x) => x.name === 'ext_report.csv');
    expect(row?.state).toBe('completed');
    expect(row?.source).toBe('extension');
    expect(await fs.readFile(path.join(wfDir(), 'ext_report.csv'), 'utf8')).toBe('a,b\n1,2\n');
  });

  it('5d. repeated http exports with the SAME filename are all kept, numbered', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    for (let i = 0; i < 3; i++) {
      await worker!.evaluate((u) => (self as any).exportUrl(u, 'http_same.json'), `${base}/export.json`);
    }
    const rows = await settled(before + 3);
    expect(rows.filter((x) => x.name.startsWith('http_same')).every((x) => x.state === 'completed')).toBe(true);
    expect((await wfFiles()).filter((f) => f.startsWith('http_same')))
      .toEqual(['http_same (2).json', 'http_same (3).json', 'http_same.json']);
  });

  it('5e. an http export from an extension TAB is filed once, under its requested name', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    const tab = await ctx!.newPage();
    await tab.goto(`chrome-extension://${extId}/popup.html`);
    await tab.evaluate((u) => (window as any).exportUrlFromTab(u, 'tab_http.json'), `${base}/export.json`);
    await settled(before + 1);
    await new Promise((r) => setTimeout(r, 1500));   // let any duplicate report arrive
    expect((await wfFiles()).filter((f) => f.startsWith('tab_http'))).toEqual(['tab_http.json']);
    expect(shelf.list().filter((x) => x.name.startsWith('tab_http'))).toHaveLength(1);
    expect(await fs.readFile(path.join(wfDir(), 'tab_http.json'), 'utf8')).toBe('{"http":true}');
    await tab.close();
  });

  it('5f. a service-worker export of an https URL reaches the SAME workspace', async (t) => {
    skipIfUnavailable(t);
    if (tlsUnavailable) t.skip(tlsUnavailable);
    const before = shelf.list().length;
    await worker!.evaluate((u) => (self as any).exportUrl(u, 'from_https.json'), `${tlsBase}/export.json`);
    const rows = await settled(before + 1);
    const row = rows.find((x) => x.name === 'from_https.json');
    expect(row?.state).toBe('completed');
    expect(row?.source).toBe('extension');
    expect(await fs.readFile(path.join(wfDir(), 'from_https.json'), 'utf8')).toBe('{"https":true}');
  });

  // ── PR #52 regression: the FIRST export arrived, the next ones did not. ──
  // The bridge here polls every 2 s (pollMs). Each export below is preceded by
  // a quiet gap LONGER than one poll: that is what left stale waiters in the
  // worker, and the next onChanged then lost its report to one of them. So
  // before every export the REAL service worker is asked how many waiters it
  // holds (one open poll = at most one), and the export must then reach the
  // shelf and the workflow.
  async function arrivesLive(name: string, fire: () => Promise<unknown>): Promise<ShelfEntry> {
    await new Promise((r) => setTimeout(r, 2_600));   // > one quiet poll
    const waiters = await worker!.evaluate(() => ((self as any).__plyrExtDl?.waiters || []).length);
    expect(waiters).toBeLessThanOrEqual(1);
    const known = new Set(shelf.list().map((x) => x.token));
    const stem = name.replace(/\.[^.]+$/, '');
    const t0 = Date.now();
    await fire();
    for (;;) {
      const row = shelf.list().find((x) => !known.has(x.token) && x.state !== 'inProgress' && x.name.startsWith(stem));
      if (row) return row;
      if (Date.now() - t0 > 10_000) throw new Error(`${name} never reached the shelf`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('8. THREE consecutive service-worker exports, same filename, each arrives live', async (t) => {
    skipIfUnavailable(t);
    for (let i = 1; i <= 3; i++) {
      const row = await arrivesLive('live_same.json',
        () => worker!.evaluate((n) => (self as any).exportFile('live_same.json', `{"live":${n}}`), i));
      expect(row.state).toBe('completed');
      expect(row.source).toBe('extension');
    }
    expect((await wfFiles()).filter((f) => f.startsWith('live_same')))
      .toEqual(['live_same (2).json', 'live_same (3).json', 'live_same.json']);
  }, 60_000);

  it('9. THREE consecutive service-worker exports of the SAME http URL each arrive live', async (t) => {
    skipIfUnavailable(t);
    for (let i = 0; i < 3; i++) {
      const row = await arrivesLive('live_http.json',
        () => worker!.evaluate((u) => (self as any).exportUrl(u, 'live_http.json'), `${base}/export.json`));
      expect(row.state).toBe('completed');
    }
    expect((await wfFiles()).filter((f) => f.startsWith('live_http')))
      .toEqual(['live_http (2).json', 'live_http (3).json', 'live_http.json']);
  }, 60_000);

  it('10. THREE consecutive extension-TAB exports, same filename, each filed exactly once', async (t) => {
    skipIfUnavailable(t);
    const tab = await ctx!.newPage();
    await tab.goto(`chrome-extension://${extId}/popup.html`);
    for (let i = 1; i <= 3; i++) {
      await arrivesLive('live_tab.json',
        () => tab.evaluate((n) => (window as any).exportFromTab('live_tab.json', `{"tab":${n}}`), i));
    }
    await new Promise((r) => setTimeout(r, 2_500));   // let any duplicate report arrive
    expect((await wfFiles()).filter((f) => f.startsWith('live_tab')))
      .toEqual(['live_tab (2).json', 'live_tab (3).json', 'live_tab.json']);
    expect(shelf.list().filter((x) => x.name.startsWith('live_tab'))).toHaveLength(3);
    await tab.close();
  }, 60_000);

  it('6. nothing is duplicated and no nameless GUID is left behind', async (t) => {
    skipIfUnavailable(t);
    await new Promise((r) => setTimeout(r, 2500));   // one more poll cycle + sweep
    const files = await wfFiles();
    const expected = [
      'a.json', 'b.json', 'c.json', 'cookies_site.json', 'ext_report.csv', 'from_http.json',
      ...(tlsUnavailable ? [] : ['from_https.json']),
      'from_tab.json', 'http_same (2).json', 'http_same (3).json', 'http_same.json',
      'report.csv', 'same (2).json', 'same (3).json', 'same.json', 'tab_http.json',
      'live_same.json', 'live_same (2).json', 'live_same (3).json',
      'live_http.json', 'live_http (2).json', 'live_http (3).json',
      'live_tab.json', 'live_tab (2).json', 'live_tab (3).json',
    ].sort();
    expect(files).toEqual(expected);
    expect(shelf.list()).toHaveLength(expected.length);
    // Every service-worker GUID was MOVED to the shelf, not left to pile up.
    const left = await fs.readdir(config.DOWNLOADS_DIR);
    const unclaimedSw = left.length - 6;   // the page + five tab downloads are Playwright's artifacts
    expect(unclaimedSw).toBe(0);
  });

  it('7. a failed extension download is reported as FAILED, not lost', async (t) => {
    skipIfUnavailable(t);
    const before = shelf.list().length;
    await worker!.evaluate(() => (self as any).exportUrl('http://127.0.0.1:9/nothing.json', 'broken.json'));
    const rows = await settled(before + 1, 20_000);
    const row = rows.find((x) => x.name === 'broken.json');
    expect(row?.state).toBe('failed');
    expect(row?.error).toContain('extension_download_interrupted');
    expect((await wfFiles()).includes('broken.json')).toBe(false);
  });
});
