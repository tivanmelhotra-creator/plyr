/**
 * Extension Download/Export reaches the Workflow Workspace — through the SAME
 * pipeline as a web page's download.
 *
 * REPORTED: Download/Export from a normal website lands in
 * `<workflow>/downloads/`; Export from a Chrome EXTENSION makes the browser say
 * "downloaded", the file may be on the server, and the workflow never gets it.
 *
 * ROOT CAUSE (measured, see core/ExtensionDownloads): an extension's service
 * worker calling `chrome.downloads.download()` has no page, so
 * `page.on('download')` — the only trigger of RealChromeShelf.track() and so of
 * persistDownload() — never fires. Chrome writes a bare GUID into
 * DOWNLOADS_DIR and nobody claims it.
 *
 * These tests drive the bridge's decision (`handle`) and the shelf's adoption
 * with REAL files on a REAL disk and a real bound workflow, no browser; the
 * in-extension observer is executed against a fake `chrome.downloads`. The
 * real-Chromium end-to-end version is tests/browser/extension-download-export.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { config } from '../../src/config';
import { RealChromeShelf, REAL_CHROME_SHELF_USER, downloadUrlKey } from '../../src/core/RealChromeShelf';
import {
  ExtensionDownloadBridge,
  installExtensionDownloadObserver,
  isExtensionProduced,
  type ExtensionDownloadReport,
} from '../../src/core/ExtensionDownloads';
import {
  attachBindingStore,
  bindRealChrome,
  resetRealChromeBindingForTests,
} from '../../src/core/WorkflowBinding';
import { resolveDownload } from '../../src/core/RemoteDownloads';

const EXT = 'eoadhilpcfkcpjdidbhlfjlbdfphebhj';
const WF = { userId: 'local', workflowId: 'wf_extension_exports' };

type Cfg = { DOWNLOADS_DIR: string; DOWNLOADS_TMP_DIR: string; WORKFLOW_STORAGE_ROOT: string };
let saved: Cfg;
let root = '';
let chromeDir = '';   // the context's downloadsPath: where Chrome writes GUIDs
let seq = 0;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-dl-'));
  chromeDir = path.join(root, 'chrome-downloads');
  await fs.mkdir(chromeDir, { recursive: true });
  const c = config as unknown as Cfg;
  saved = { DOWNLOADS_DIR: c.DOWNLOADS_DIR, DOWNLOADS_TMP_DIR: c.DOWNLOADS_TMP_DIR, WORKFLOW_STORAGE_ROOT: c.WORKFLOW_STORAGE_ROOT };
  c.DOWNLOADS_DIR = path.join(root, 'shelf');
  c.DOWNLOADS_TMP_DIR = path.join(root, 'shelf');
  c.WORKFLOW_STORAGE_ROOT = path.join(root, 'workflows');
  attachBindingStore(null);
  resetRealChromeBindingForTests();
  await bindRealChrome(WF);
});

afterEach(async () => {
  Object.assign(config as unknown as Cfg, saved);
  attachBindingStore(null);
  resetRealChromeBindingForTests();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Chrome's own GUID file, as it is left behind by a service-worker export. */
async function chromeWrote(body: string | Buffer): Promise<string> {
  seq += 1;
  const p = path.join(chromeDir, `5d7e717c-979a-4954-9a96-${String(seq).padStart(12, '0')}`);
  await fs.writeFile(p, body);
  return p;
}

function report(over: Partial<ExtensionDownloadReport>): ExtensionDownloadReport {
  seq += 1;
  return {
    id: 1000 + seq,
    url: 'data:application/json;base64,eyJhIjoxfQ==',
    finalUrl: 'data:application/json;base64,eyJhIjoxfQ==',
    filePath: '',
    mime: 'application/json',
    state: 'complete',
    error: '',
    byExtensionId: EXT,
    requestedName: '',
    ...over,
  };
}

async function workflowDownloads(): Promise<string[]> {
  const dir = path.join(config.WORKFLOW_STORAGE_ROOT, WF.userId, WF.workflowId, 'downloads');
  return (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => !n.endsWith('.part')).sort();
}

function bridge(shelf: RealChromeShelf): ExtensionDownloadBridge {
  return new ExtensionDownloadBridge(shelf, { downloadsDir: chromeDir, graceMs: 0 });
}

describe('an extension export reaches <workflow>/downloads/', () => {
  it('adopts a service-worker export under the name the extension asked for', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const guid = await chromeWrote('{"a":1}');

    const entry = await bridge(shelf).handle(report({ filePath: guid, requestedName: 'cookies_127.0.0.1.json' }));

    expect(entry).not.toBeNull();
    expect(entry!.state).toBe('completed');
    expect(entry!.name).toBe('cookies_127.0.0.1.json');
    expect(entry!.source).toBe('extension');
    expect(entry!.workflowPath).toBe('downloads/cookies_127.0.0.1.json');
    expect(await workflowDownloads()).toEqual(['cookies_127.0.0.1.json']);
    // Same bytes in the workspace as the extension produced.
    const wfFile = path.join(config.WORKFLOW_STORAGE_ROOT, WF.userId, WF.workflowId, 'downloads', 'cookies_127.0.0.1.json');
    expect(await fs.readFile(wfFile, 'utf8')).toBe('{"a":1}');
    // And on the shelf, fetchable by token like any page download.
    const r = await resolveDownload(REAL_CHROME_SHELF_USER, entry!.token);
    expect(r.name).toBe('cookies_127.0.0.1.json');
    // The nameless GUID does not stay behind in the browser's download dir.
    expect(await fs.readdir(chromeDir)).toEqual([]);
  });

  it('uses the workflow the browser is bound to at the moment of the export', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    await bindRealChrome({ userId: 'local', workflowId: 'wf_other' });
    const entry = await bridge(shelf).handle(report({ filePath: await chromeWrote('x'), requestedName: 'x.json' }));
    expect(entry!.workflowPath).toBe('downloads/x.json');
    const other = path.join(config.WORKFLOW_STORAGE_ROOT, 'local', 'wf_other', 'downloads', 'x.json');
    await expect(fs.stat(other)).resolves.toBeTruthy();
    expect(await workflowDownloads()).toEqual([]);   // not the previous workflow
  });

  it('files several exports with different names, each once', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const b = bridge(shelf);
    for (const n of ['a.json', 'b.json', 'c.txt']) {
      const e = await b.handle(report({ filePath: await chromeWrote(n), requestedName: n }));
      expect(e!.state).toBe('completed');
    }
    expect(await workflowDownloads()).toEqual(['a.json', 'b.json', 'c.txt']);
    expect(shelf.list()).toHaveLength(3);
  });

  it('keeps every export of the SAME filename, numbered, even when they finish together', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const b = bridge(shelf);
    const reports = await Promise.all([1, 2, 3].map(async (i) => report({
      filePath: await chromeWrote(`{"n":${i}}`),
      requestedName: 'cookies.json',
    })));
    const entries = await Promise.all(reports.map((r) => b.handle(r)));

    expect(entries.every((e) => e && e.state === 'completed')).toBe(true);
    expect(await workflowDownloads()).toEqual(['cookies (2).json', 'cookies (3).json', 'cookies.json']);
    const dir = path.join(config.WORKFLOW_STORAGE_ROOT, WF.userId, WF.workflowId, 'downloads');
    const bodies = await Promise.all((await workflowDownloads()).map((n) => fs.readFile(path.join(dir, n), 'utf8')));
    // Three distinct files: nothing overwritten, nothing lost.
    expect(new Set(bodies).size).toBe(3);
  });

  it('names a nameless export from Chrome\'s MIME type, never `file`', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const e = await bridge(shelf).handle(report({ filePath: await chromeWrote('{}'), requestedName: '' }));
    expect(e!.name).toBe('download.json');
  });

  it('reduces a requested path to a safe basename', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const e = await bridge(shelf).handle(report({ filePath: await chromeWrote('{}'), requestedName: '../../exports/../evil.json' }));
    expect(e!.name).toBe('evil.json');
    expect(e!.workflowPath).toBe('downloads/evil.json');
  });
});

describe('no duplicates, no lost files', () => {
  it('reports of the same download from two extensions file it once', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const b = bridge(shelf);
    const r = report({ filePath: await chromeWrote('{}'), requestedName: 'one.json' });
    const [first, second] = await Promise.all([b.handle(r), b.handle({ ...r })]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await workflowDownloads()).toEqual(['one.json']);
  });

  it('leaves an ordinary website download to the page pipeline', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const guid = await chromeWrote('<html></html>');
    const e = await bridge(shelf).handle(report({
      url: 'https://example.com/report.html',
      finalUrl: 'https://example.com/report.html',
      byExtensionId: '',
      filePath: guid,
    }));
    expect(e).toBeNull();
    expect(shelf.list()).toHaveLength(0);
    // Untouched: it belongs to Playwright's page download.
    await expect(fs.stat(guid)).resolves.toBeTruthy();
  });

  it('does not adopt an extension-tab download page.on(\'download\') already tracked', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const url = `blob:chrome-extension://${EXT}/1f263890-d6d3-4cae-a2f2-28b699042a52`;
    const artifact = await chromeWrote('{"b":2}');
    const tracked = await shelf.track({
      url: () => url,
      suggestedFilename: () => 'tab.json',
      saveAs: async (dest: string) => { await fs.copyFile(artifact, dest); },
      path: async () => artifact,
    } as never);
    expect(tracked.state).toBe('completed');

    const e = await bridge(shelf).handle(report({ url, finalUrl: url, filePath: artifact, byExtensionId: EXT }));
    expect(e).toBeNull();
    expect(shelf.list()).toHaveLength(1);
    expect(await workflowDownloads()).toEqual(['tab.json']);
  });

  it('two page downloads of one URL suppress exactly their own two reports, not a third', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const url = 'data:application/json;base64,e30=';
    const fake = (name: string, artifact: string) => ({
      url: () => url,
      suggestedFilename: () => name,
      saveAs: async (dest: string) => { await fs.copyFile(artifact, dest); },
      path: async () => artifact,
    });
    const a1 = await chromeWrote('{}');
    const a2 = await chromeWrote('{}');
    await shelf.track(fake('p1.json', a1) as never);
    await shelf.track(fake('p2.json', a2) as never);
    const b = bridge(shelf);
    expect(await b.handle(report({ url, finalUrl: url, filePath: a1 }))).toBeNull();
    expect(await b.handle(report({ url, finalUrl: url, filePath: a2 }))).toBeNull();
    const third = await b.handle(report({ url, finalUrl: url, filePath: await chromeWrote('{}'), requestedName: 'sw.json' }));
    expect(third!.state).toBe('completed');
    expect(third!.name).toBe('sw.json');
  });

  it('an http(s) URL a WEBSITE downloaded first does not hide a service-worker export of it', async () => {
    // The regression: claims used to be spent by URL, and a website download
    // left a claim the bridge never spent, so the export of the same URL was
    // dropped and its GUID left on disk, never reaching the workflow.
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const url = 'https://example.com/export.json';
    const siteArtifact = await chromeWrote('{"site":1}');
    const tracked = await shelf.track({
      url: () => url,
      suggestedFilename: () => 'export.json',
      saveAs: async (dest: string) => { await fs.copyFile(siteArtifact, dest); },
      path: async () => siteArtifact,
    } as never);
    expect(tracked.state).toBe('completed');

    const b = bridge(shelf);
    const swGuid = await chromeWrote('{"ext":1}');
    const e = await b.handle(report({ url, finalUrl: url, filePath: swGuid, byExtensionId: EXT, requestedName: 'ext_export.json', mime: 'application/json' }));
    expect(e?.state).toBe('completed');
    expect(e?.source).toBe('extension');
    expect(e?.workflowPath).toBe('downloads/ext_export.json');
    expect(await workflowDownloads()).toEqual(['export.json', 'ext_export.json']);
    // Moved, not left behind as a nameless GUID.
    await expect(fs.stat(swGuid)).rejects.toThrow();
  });

  it('matches a megabyte data: URL by its bounded key on both sides', () => {
    const big = `data:application/json;base64,${'A'.repeat(3 * 1024 * 1024)}`;
    const other = `${big.slice(0, -1)}B`;
    expect(downloadUrlKey(big).length).toBeLessThan(2200);
    expect(downloadUrlKey(big)).not.toBe(downloadUrlKey(other));
    expect(downloadUrlKey('data:,x')).toBe('data:,x');
  });
});

describe('failures are reported, not swallowed', () => {
  it('an interrupted extension download becomes a FAILED row with Chrome\'s reason', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const e = await bridge(shelf).handle(report({
      state: 'interrupted', error: 'NETWORK_FAILED', filePath: '', requestedName: 'cookies.json',
    }));
    expect(e!.state).toBe('failed');
    expect(e!.error).toContain('NETWORK_FAILED');
    expect(e!.name).toBe('cookies.json');
    expect(await workflowDownloads()).toEqual([]);
  });

  it('refuses a report that points outside the browser\'s download directory', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const outside = path.join(root, 'secret.txt');
    await fs.writeFile(outside, 'secret');
    const e = await bridge(shelf).handle(report({ filePath: outside, requestedName: 'x.json' }));
    expect(e!.state).toBe('failed');
    expect(e!.error).toContain('OUTSIDE_DOWNLOADS_DIR');
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('secret');   // not moved
    expect(await workflowDownloads()).toEqual([]);
  });

  it('a workflow copy that fails is visible on the row', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    // A FILE where the workflows root must be a directory: the copy cannot succeed.
    await fs.writeFile(config.WORKFLOW_STORAGE_ROOT, 'not a directory');
    const e = await bridge(shelf).handle(report({ filePath: await chromeWrote('{}'), requestedName: 'x.json' }));
    expect(e!.state).toBe('completed');              // the shelf copy is safe
    expect(e!.workflowPath).toBeUndefined();
    expect(e!.workflowError).toBe('workflow_persist_failed');
  });
});

describe('the observer installed inside the extension', () => {
  /** A minimal `chrome.downloads`, recording what the extension really called. */
  function fakeChrome() {
    const listeners: Array<(d: unknown) => void> = [];
    let nextId = 1;
    const calls: unknown[] = [];
    const downloads = {
      download(opts: unknown, cb?: (id: number) => void) {
        calls.push(opts);
        const id = nextId++;
        if (cb) { cb(id); return undefined; }
        return Promise.resolve(id);
      },
      onChanged: { addListener: (f: (d: unknown) => void) => listeners.push(f) },
      search: (_q: unknown, cb: (items: unknown[]) => void) => cb([]),
    };
    return { chrome: { runtime: { id: EXT }, downloads }, calls, listeners };
  }

  /** Run `fn` with fake extension globals; restored after it SETTLES. */
  async function withGlobals(g: Record<string, unknown>, fn: () => unknown): Promise<void> {
    const G = globalThis as Record<string, unknown>;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(g)) { before[k] = G[k]; G[k] = g[k]; }
    try { await fn(); } finally {
      for (const k of Object.keys(g)) { if (before[k] === undefined) delete G[k]; else G[k] = before[k]; }
      delete G.__plyrExtDl;
    }
  }

  it('records the requested filename by id, and the extension still gets its callback', async () => {
    const f = fakeChrome();
    await withGlobals({ chrome: f.chrome }, async () => {
      expect(installExtensionDownloadObserver(true)).toEqual({ ok: true, extensionId: EXT });
      let gotId = 0;
      f.chrome.downloads.download({ url: 'data:,1', filename: 'cb.json' }, (id: number) => { gotId = id; });
      const pid = await (f.chrome.downloads.download({ url: 'data:,2', filename: 'promise.json' }) as unknown as Promise<number>);
      const rec = (globalThis as Record<string, any>).__plyrExtDl;
      expect(gotId).toBe(1);
      expect(pid).toBe(2);
      expect(rec.byId[1]).toBe('cb.json');
      expect(rec.byId[2]).toBe('promise.json');
      expect(f.calls).toHaveLength(2);          // the real API was still called
      // Installing twice (a worker re-attached) must not wrap twice.
      installExtensionDownloadObserver(true);
      f.chrome.downloads.download({ url: 'data:,3', filename: 'c.json' }, () => {});
      expect(f.calls).toHaveLength(3);
      expect(f.listeners).toHaveLength(1);
    });
  });

  it('records by URL in an extension PAGE, for the shelf to read back', async () => {
    const f = fakeChrome();
    await withGlobals({ chrome: f.chrome }, () => {
      installExtensionDownloadObserver(false);
      f.chrome.downloads.download({ url: 'blob:chrome-extension://x/1', filename: 'tab.json' }, () => {});
      const rec = (globalThis as Record<string, any>).__plyrExtDl;
      expect(rec.byUrl['blob:chrome-extension://x/1']).toEqual(['tab.json']);
      expect(f.listeners).toHaveLength(0);       // pages never report; workers do
    });
  });

  it('does nothing where there is no chrome.downloads (a website, or no permission)', async () => {
    await withGlobals({ chrome: { runtime: { id: EXT } } }, () => {
      expect(installExtensionDownloadObserver(true).ok).toBe(false);
    });
  });

  it('only extension-produced downloads are candidates', () => {
    expect(isExtensionProduced({ byExtensionId: EXT, url: 'data:,', finalUrl: '' })).toBe(true);
    expect(isExtensionProduced({ byExtensionId: '', url: `blob:chrome-extension://${EXT}/u`, finalUrl: '' })).toBe(true);
    expect(isExtensionProduced({ byExtensionId: '', url: 'https://example.com/a.pdf', finalUrl: '' })).toBe(false);
    expect(isExtensionProduced({ byExtensionId: '', url: 'blob:https://example.com/u', finalUrl: '' })).toBe(false);
  });
});
