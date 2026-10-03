/**
 * Regression tests for the CDP half of FileChooserService — the extension
 * import path (chrome-extension:// popups, service workers) that the
 * Playwright-side tests in file-chooser-service.test.ts do not reach.
 *
 * They pin the four behaviours that made the reported bug:
 *
 *   1. A regular web tab's chooser is NOT registered a second time over CDP
 *      (double interception made the view prompt twice and swallow the first
 *      selection).
 *   2. A single-file CDP chooser is handed ONE file, never the whole list.
 *   3. When Chromium refuses Page.handleFileChooser because a Playwright
 *      twin owns the dialog, the answer falls through to the twin instead of
 *      failing the import.
 *   4. A successful CDP hand-over files the bytes under <workflow>/uploads/
 *      exactly like the Playwright path, so the drawer shows them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { config } from '../../src/config';
import { saveUpload } from '../../src/core/RemoteUploads';
import { resetRealChromeBindingForTests } from '../../src/core/WorkflowBinding';

const { FakeWs, bindingMock } = vi.hoisted(() => {
  /**
   * A `ws` stand-in with an auto-responder: every sent CDP command is answered
   * (success by default, or whatever `nextError` names), and the test can
   * push raw events through emit('message', ...).
   */
  class FakeWs {
    static instances: FakeWs[] = [];
    static readonly OPEN = 1;
    listeners = new Map<string, Array<(a?: unknown) => void>>();
    sent: any[] = [];
    readyState = 1; // OPEN
    /** When set, the next command whose method matches is answered with this error. */
    nextError: { method: string } | null = null;
    constructor(public url: string) {
      FakeWs.instances.push(this);
    }
    on(type: string, fn: (a?: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type)!.push(fn);
      return this;
    }
    emit(type: string, arg?: unknown) {
      (this.listeners.get(type) || []).forEach((f) => f(arg));
    }
    close() { /* nothing to close */ }
    send(data: string) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (this.nextError && msg.method === this.nextError.method) {
        this.nextError = null;
        queueMicrotask(() => this.emit('message', JSON.stringify({
          id: msg.id,
          error: { code: -32000, message: 'File chooser already handled.' },
        })));
        return;
      }
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: msg.id, result: {} })));
    }
  }
  const bindingMock = {
    persistCalls: [] as string[][],
    async persistUploads(_ref: unknown, absolutePaths: string[]) {
      bindingMock.persistCalls.push(absolutePaths);
      return [];
    },
    async realChromeWorkflowForTransfer() { return { userId: 'u1', workflowId: 'wf1' }; },
    bindRealChrome: vi.fn(),
    realChromeWorkflow: vi.fn(),
    refreshRealChromeBinding: vi.fn(),
    resetRealChromeBindingForTests: vi.fn(),
    persistDownload: vi.fn(),
    persistIntoWorkflow: vi.fn(),
  };
  return { FakeWs, bindingMock };
});

vi.mock('ws', () => ({ default: FakeWs }));
vi.mock('../../src/core/WorkflowBinding', () => bindingMock);

import { FileChooserService, type FileChooserNotice } from '../../src/core/FileChooserService';

const USER = 'local';

let dir = '';
let originalUploads = '';

beforeEach(async () => {
  FakeWs.instances = [];
  bindingMock.persistCalls = [];
  resetRealChromeBindingForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chooser-cdp-test-'));
  originalUploads = config.UPLOADS_DIR;
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = dir;
});

afterEach(async () => {
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function fakeChooser(opts: { multiple?: boolean } = {}) {
  const given: string[][] = [];
  return {
    given,
    isMultiple: () => !!opts.multiple,
    element: () => ({ getAttribute: async () => null }),
    setFiles: async (files: string | string[]) => {
      given.push(Array.isArray(files) ? files : [files]);
    },
  };
}

function fakePage(initialUrl = 'https://site.test/upload') {
  let currentUrl = initialUrl;
  const handlers = new Map<string, Array<(a: unknown) => void>>();
  return {
    setUrl(u: string) { currentUrl = u; },
    url: () => currentUrl,
    isClosed: () => false,
    on(type: string, fn: (a: unknown) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
      return this;
    },
    once(type: string, fn: () => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(() => {});
      handlers.get(type)!.push(fn as unknown as () => void);
      return this;
    },
    emit(type: string, arg?: unknown) {
      (handlers.get(type) || []).forEach((f) => f(arg));
    },
  };
}

function fakeContext(pages: Array<ReturnType<typeof fakePage>> = []) {
  const handlers = new Map<string, Array<(a: unknown) => void>>();
  return {
    pages: () => pages,
    on(type: string, fn: (a: unknown) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
      return this;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function upload(name: string, body = 'test-data'): Promise<string> {
  const stored = await saveUpload(USER, name, Buffer.from(body));
  return stored.token;
}

/** Attach a fake CDP transport and return the socket the service talks to. */
function attachFakeCdp(service: FileChooserService) {
  service.attachCDP('ws://fake-cdp');
  const ws = FakeWs.instances[FakeWs.instances.length - 1];
  ws.emit('open');
  return ws;
}

function cdpEvent(ws: InstanceType<typeof FakeWs>, obj: unknown) {
  ws.emit('message', JSON.stringify(obj));
}

describe('FileChooserService — CDP (extension) path', () => {
  it('does not register a regular web tab chooser over CDP (no double interception)', async () => {
    const service = new FileChooserService(USER, 'p', 'r');
    const ws = attachFakeCdp(service);

    cdpEvent(ws, {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S-web', targetInfo: { targetId: 'T-web', type: 'page', url: 'https://site.test/upload', title: '' } },
    });
    await settle();
    cdpEvent(ws, {
      method: 'Page.fileChooserOpened',
      sessionId: 'S-web',
      params: { mode: 'selectSingle' },
    });
    await settle();

    // No CDP entry: the Playwright side already owns regular tabs.
    expect(service.pendingAny()).toBeNull();
  });

  it('hands a single-file CDP chooser exactly one file', async () => {
    const service = new FileChooserService(USER, 'p', 'r');
    const ws = attachFakeCdp(service);

    cdpEvent(ws, {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S-ext', targetInfo: { targetId: 'T-ext', type: 'other', url: 'chrome-extension://abc/popup.html', title: '' } },
    });
    await settle();
    cdpEvent(ws, {
      method: 'Page.fileChooserOpened',
      sessionId: 'S-ext',
      params: { mode: 'selectSingle', backendNodeId: 42 },
    });
    await settle();

    const notice = service.pendingAny();
    expect(notice).not.toBeNull();
    expect(notice!.kind).toBe('extension');

    const t1 = await upload('cookies.json', '{}');
    const t2 = await upload('extra.txt', 'x');
    const done = await service.acceptAny(notice!.id, [t1, t2]);

    expect(done.count).toBe(1);
    const cmd = ws.sent.find((m) => m.method === 'Page.handleFileChooser');
    expect(cmd).toBeTruthy();
    expect(cmd.params.files).toHaveLength(1);
    expect(cmd.params.files[0]).toContain('cookies.json');
    expect(cmd.params.backendNodeId).toBe(42);
  });

  it('falls back to the Playwright twin when Chromium refuses the CDP answer', async () => {
    // The extension popup IS a Playwright Page, so both channels hold the same
    // dialog; Chromium answers one and refuses the other.
    const page = fakePage('chrome-extension://abc/popup.html');
    const ctx = fakeContext([page]);
    const service = new FileChooserService(USER, 'p', 'r');
    service.watch(ctx as any);

    const chooser = fakeChooser({ multiple: false });
    page.emit('filechooser', chooser);
    await settle();

    const ws = attachFakeCdp(service);
    cdpEvent(ws, {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S-ext', targetInfo: { targetId: 'T-ext', type: 'other', url: 'chrome-extension://abc/popup.html', title: '' } },
    });
    await settle();
    cdpEvent(ws, {
      method: 'Page.fileChooserOpened',
      sessionId: 'S-ext',
      params: { mode: 'selectSingle', backendNodeId: 7 },
    });
    await settle();

    const notice = service.pendingAny();
    expect(notice).not.toBeNull();
    expect(notice!.kind).toBe('extension');

    ws.nextError = { method: 'Page.handleFileChooser' };
    const token = await upload('cookies.json', '{}');
    const done = await service.acceptAny(notice!.id, [token]);

    // The twin delivered the file; the import completed instead of dying.
    expect(done.count).toBe(1);
    expect(chooser.given).toHaveLength(1);
    expect(chooser.given[0][0]).toContain('cookies.json');

    // Neither side is pending any more — the view will not re-prompt.
    expect(service.pendingAny()).toBeNull();
  });

  it('files a successful CDP hand-over under <workflow>/uploads/', async () => {
    const service = new FileChooserService(USER, 'p', 'r');
    const ws = attachFakeCdp(service);

    cdpEvent(ws, {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S-ext', targetInfo: { targetId: 'T-ext', type: 'other', url: 'chrome-extension://abc/popup.html', title: '' } },
    });
    await settle();
    cdpEvent(ws, {
      method: 'Page.fileChooserOpened',
      sessionId: 'S-ext',
      params: { mode: 'selectSingle', backendNodeId: 42 },
    });
    await settle();

    const notice = service.pendingAny();
    const token = await upload('cookies.json', '{}');
    await service.acceptAny(notice!.id, [token]);

    expect(bindingMock.persistCalls).toHaveLength(1);
    expect(bindingMock.persistCalls[0]).toHaveLength(1);
    expect(bindingMock.persistCalls[0][0]).toContain('cookies.json');
  });
});
