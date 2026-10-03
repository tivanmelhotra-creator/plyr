/**
 * The CDP half of FileChooserService: dialogs in targets Playwright does not
 * own (an extension's action popup).
 *
 * The fake DevTools endpoint below behaves like Chromium as MEASURED:
 *   - `Page.handleFileChooser` does not exist (-32601 "wasn't found");
 *   - `Page.fileChooserOpened` carries the <input>'s `backendNodeId`;
 *   - files are handed over with `DOM.setFileInputFiles` on that session.
 * So a regression to the old fire-and-forget `Page.handleFileChooser` makes
 * these tests fail the same way the real browser did: nothing is delivered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { WebSocketServer, type WebSocket as WS } from 'ws';

vi.mock('../../src/core/RemoteFileChooser', async (orig) => {
  const mod = await orig<typeof import('../../src/core/RemoteFileChooser')>();
  // Short enough to observe expiry, long enough not to race the other tests.
  return { ...mod, CHOOSER_TTL_MS: 400 };
});

vi.mock('../../src/core/WorkflowBinding', () => ({
  realChromeWorkflowForTransfer: vi.fn(async () => ({ userId: 'u', workflowId: 'w' })),
  persistUploads: vi.fn(async (_ref: unknown, paths: string[]) =>
    paths.map((p) => ({ path: `uploads/${path.basename(p)}` }))),
}));

import { FileChooserService, type FileChooserNotice } from '../../src/core/FileChooserService';
import { FileChooserError } from '../../src/core/RemoteFileChooser';
import { saveUpload } from '../../src/core/RemoteUploads';
import { persistUploads } from '../../src/core/WorkflowBinding';
import { config } from '../../src/config';

const USER = 'local';
const EXT_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html';

type Target = { targetId: string; type: string; url: string };
type Call = { method: string; params: Record<string, any>; sessionId?: string };

/** A minimal Chromium: browser-level socket, flattened sessions, file choosers. */
class FakeChromium {
  readonly wss: WebSocketServer;
  readonly calls: Call[] = [];
  readonly targets: Target[] = [];
  private sockets = new Set<WS>();
  private sessionSeq = 0;
  private sessionTarget = new Map<string, string>();
  /** Make the next DOM.setFileInputFiles fail with this message. */
  failSetFiles: string | null = null;
  inputAttributes: string[] = ['type', 'file', 'name', 'cookiefile', 'accept', '.json'];

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (data) => this.onMessage(ws, JSON.parse(String(data))));
    });
  }

  static async start(): Promise<FakeChromium> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    return new FakeChromium(wss);
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}`;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  addTarget(t: Target): void {
    this.targets.push(t);
    this.broadcast({ method: 'Target.targetCreated', params: { targetInfo: t } });
  }

  sessionFor(targetId: string): string {
    for (const [sid, tid] of this.sessionTarget) if (tid === targetId) return sid;
    throw new Error(`no session on ${targetId}`);
  }

  /** The page clicked its <input type=file>. */
  openChooser(targetId: string, opts: { backendNodeId?: number | null; mode?: string } = {}): void {
    const params: Record<string, unknown> = { frameId: 'F1', mode: opts.mode ?? 'selectSingle' };
    if (opts.backendNodeId !== null) params.backendNodeId = opts.backendNodeId ?? 7;
    this.broadcast({ method: 'Page.fileChooserOpened', params, sessionId: this.sessionFor(targetId) });
  }

  navigate(targetId: string, frame: { parentId?: string } = {}): void {
    this.broadcast({
      method: 'Page.frameNavigated',
      params: { frame: { id: 'F1', url: 'about:blank', ...frame } },
      sessionId: this.sessionFor(targetId),
    });
  }

  destroyTarget(targetId: string): void {
    this.broadcast({ method: 'Target.targetDestroyed', params: { targetId } });
  }

  private broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(msg));
  }

  private onMessage(ws: WS, msg: { id: number; method: string; params?: Record<string, any>; sessionId?: string }): void {
    this.calls.push({ method: msg.method, params: msg.params || {}, sessionId: msg.sessionId });
    const reply = (result: unknown = {}) => ws.send(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId }));
    const fail = (code: number, message: string) => ws.send(JSON.stringify({ id: msg.id, error: { code, message }, sessionId: msg.sessionId }));
    switch (msg.method) {
      case 'Target.setDiscoverTargets':
        reply();
        for (const t of this.targets) ws.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: t } }));
        return;
      case 'Target.getTargets':
        return reply({ targetInfos: this.targets });
      case 'Target.attachToTarget': {
        const sessionId = `S${++this.sessionSeq}`;
        this.sessionTarget.set(sessionId, msg.params!.targetId);
        reply({ sessionId });
        const t = this.targets.find((x) => x.targetId === msg.params!.targetId);
        ws.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: t, waitingForDebugger: false } }));
        return;
      }
      case 'Page.enable':
      case 'Page.setInterceptFileChooserDialog':
        return reply();
      case 'DOM.describeNode':
        return reply({ node: { attributes: this.inputAttributes } });
      case 'DOM.setFileInputFiles':
        if (this.failSetFiles) return fail(-32000, this.failSetFiles);
        return reply();
      default:
        return fail(-32601, `'${msg.method}' wasn't found`);
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise((r) => this.wss.close(r));
  }
}

let dir = '';
let originalUploads = '';
let chromium: FakeChromium;
let svc: FileChooserService;
let events: Array<{ type: string; reason?: string; notice: FileChooserNotice }>;

const settle = () => new Promise((r) => setTimeout(r, 60));
const pendingRows = () => events.filter((e) => e.type === 'pending').map((e) => e.notice);

async function connect(targets: Target[] = [{ targetId: 'T1', type: 'page', url: EXT_URL }]) {
  for (const t of targets) chromium.targets.push(t);
  svc.attachCDP(chromium.url);
  await vi.waitFor(() => expect(chromium.count('Page.setInterceptFileChooserDialog')).toBeGreaterThanOrEqual(targets.length));
}

/** Click the input and wait for the row to be published. */
async function click(targetId = 'T1', opts: Parameters<FakeChromium['openChooser']>[1] = {}) {
  const before = pendingRows().length;
  chromium.openChooser(targetId, opts);
  await vi.waitFor(() => expect(pendingRows().length).toBe(before + 1));
  return pendingRows()[pendingRows().length - 1];
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chooser-cdp-test-'));
  originalUploads = config.UPLOADS_DIR;
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = dir;
  chromium = await FakeChromium.start();
  svc = new FileChooserService(USER, 'default', 'rt-test');
  events = [];
  svc.subscribe((e) => events.push(e));
  vi.mocked(persistUploads).mockClear();
});

afterEach(async () => {
  svc.dispose();
  await chromium.stop();
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('FileChooserService — CDP hand-over (extension popups)', () => {
  it('attaches ONE session per target, however often the target is announced', async () => {
    await connect();
    // Chromium announces the same target again (URL change, getTargets + created).
    chromium.addTarget({ targetId: 'T1', type: 'page', url: EXT_URL });
    chromium.addTarget({ targetId: 'T1', type: 'page', url: EXT_URL + '#x' });
    await settle();
    expect(chromium.count('Target.attachToTarget')).toBe(1);
    expect(chromium.count('Page.setInterceptFileChooserDialog')).toBe(1);
  });

  it('publishes ONE row per click, carrying the input\'s accept/name and the extension id', async () => {
    await connect();
    const row = await click();
    await settle();
    expect(pendingRows()).toHaveLength(1);
    expect(row).toMatchObject({
      accept: '.json',
      name: 'cookiefile',
      multiple: false,
      kind: 'extension',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    });
    expect(svc.pendingAny()?.id).toBe(row.id);
  });

  it('answers from the operator\'s computer with DOM.setFileInputFiles on the clicked <input>', async () => {
    await connect();
    const row = await click('T1', { backendNodeId: 42 });
    const up = await saveUpload(USER, 'cookies.json', Buffer.from('{"a":1}'));

    const done = await svc.acceptAny(row.id, [up.token]);

    const set = chromium.calls.filter((c) => c.method === 'DOM.setFileInputFiles');
    expect(set).toHaveLength(1);
    expect(set[0].params.backendNodeId).toBe(42);
    expect(set[0].sessionId).toBe(chromium.sessionFor('T1'));
    expect(set[0].params.files).toHaveLength(1);
    expect(path.basename(set[0].params.files[0])).toBe('cookies.json');
    // The method that does not exist must never be used again.
    expect(chromium.count('Page.handleFileChooser')).toBe(0);

    expect(done.count).toBe(1);
    // …and the bytes are filed under <workflow>/uploads/, like the Playwright path.
    expect(persistUploads).toHaveBeenCalledTimes(1);
    expect(done.persisted).toEqual(['uploads/cookies.json']);
    expect(events.map((e) => e.type)).toEqual(['pending', 'done']);
    expect(svc.pendingAny()).toBeNull();
  });

  it('answers from the workflow workspace with the same hand-over (no persist: it is already there)', async () => {
    await connect();
    const row = await click();
    const done = await svc.acceptPathsAny(row.id, ['/work/flow/uploads/cookies.json']);
    expect(done).toEqual({ count: 1 });
    expect(chromium.calls.find((c) => c.method === 'DOM.setFileInputFiles')!.params.files)
      .toEqual(['/work/flow/uploads/cookies.json']);
    expect(persistUploads).not.toHaveBeenCalled();
  });

  it('hands a single-file input ONE file and a multiple input all of them', async () => {
    await connect();
    const single = await click('T1', { mode: 'selectSingle' });
    await svc.acceptPathsAny(single.id, ['/a.json', '/b.json', '/c.json']);
    const multi = await click('T1', { mode: 'selectMultiple' });
    await svc.acceptPathsAny(multi.id, ['/a.json', '/b.json', '/c.json']);

    const sent = chromium.calls.filter((c) => c.method === 'DOM.setFileInputFiles').map((c) => c.params.files);
    expect(sent).toEqual([['/a.json'], ['/a.json', '/b.json', '/c.json']]);
  });

  it('REPORTS a refused hand-over instead of claiming success', async () => {
    await connect();
    const row = await click();
    chromium.failSetFiles = 'Not allowed';
    await expect(svc.acceptPathsAny(row.id, ['/a.json'])).rejects.toBeInstanceOf(FileChooserError);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'failed' });
    expect(svc.pendingAny()).toBeNull();
  });

  it('refuses a second answer to an already-answered dialog (no double import)', async () => {
    await connect();
    const row = await click();
    await svc.acceptPathsAny(row.id, ['/a.json']);
    await expect(svc.acceptPathsAny(row.id, ['/a.json'])).rejects.toThrow();
    expect(chromium.count('DOM.setFileInputFiles')).toBe(1);
  });

  it('a new dialog on the same target replaces the old one, and the old id is refused', async () => {
    await connect();
    const first = await click();
    const second = await click();
    expect(events.filter((e) => e.type === 'done').map((e) => e.reason)).toEqual(['superseded']);
    expect(svc.pendingAny()?.id).toBe(second.id);

    // Answering the stale id must NOT deliver the file to the newer dialog.
    await expect(svc.accept(first.pageId, first.id, [])).rejects.toBeInstanceOf(FileChooserError);
    expect(chromium.count('DOM.setFileInputFiles')).toBe(0);
  });

  it('drops the row when the page that asked navigates (Chromium would not refuse a stale node)', async () => {
    await connect();
    await click();
    chromium.navigate('T1', { parentId: 'sub-frame' }); // a sub-frame: the dialog stands
    await settle();
    expect(svc.pendingAny()).not.toBeNull();
    chromium.navigate('T1'); // the main frame
    await vi.waitFor(() => expect(svc.pendingAny()).toBeNull());
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'navigated' });
  });

  it('drops the row when its target closes', async () => {
    await connect();
    await click();
    chromium.destroyTarget('T1');
    await vi.waitFor(() => expect(svc.pendingAny()).toBeNull());
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'closed' });
  });

  it('releases a row nobody answers (TTL), so it cannot sit in front of every other request', async () => {
    await connect();
    await click();
    await vi.waitFor(() => expect(svc.pendingAny()).toBeNull(), { timeout: 2000 });
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'expired' });
  });

  it('cancel forgets the dialog once, and says so', async () => {
    await connect();
    const row = await click();
    expect(await svc.cancelAny(row.id)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'cancelled' });
    expect(await svc.cancelAny(row.id)).toBe(false);
    expect(chromium.count('DOM.setFileInputFiles')).toBe(0);
  });

  it('ignores a dialog with no <input> behind it (nothing to hand a file to)', async () => {
    await connect();
    chromium.openChooser('T1', { backendNodeId: null });
    await settle();
    expect(pendingRows()).toHaveLength(0);
  });

  it('leaves targets Playwright owns to Playwright (no second row, no double delivery)', async () => {
    const owned = { targetId: 'TAB', type: 'page', url: 'https://example.com/' };
    const popup = { targetId: 'POP', type: 'page', url: EXT_URL };
    // A Playwright context whose only page is TAB.
    const page = { url: () => owned.url, on: () => {}, once: () => {} };
    const ctx = {
      pages: () => [page],
      on: () => {},
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: owned.targetId } }),
        detach: async () => {},
      }),
    };
    svc.watch(ctx as never);
    await connect([owned, popup]);

    chromium.openChooser('TAB');
    await settle();
    expect(pendingRows()).toHaveLength(0);

    const row = await click('POP');
    expect(row.pageId).toBe('cdp:POP');
  });
});
