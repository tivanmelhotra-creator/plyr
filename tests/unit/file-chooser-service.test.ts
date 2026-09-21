import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { FileChooserService, type FileChooserNotice } from '../../src/core/FileChooserService';
import { saveUpload } from '../../src/core/RemoteUploads';
import { config } from '../../src/config';

const USER = 'local';

let dir = '';
let originalUploads = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chooser-service-test-'));
  originalUploads = config.UPLOADS_DIR;
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = dir;
});

afterEach(async () => {
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function fakeChooser(opts: { multiple?: boolean; accept?: string; name?: string } = {}) {
  const given: string[][] = [];
  return {
    given,
    isMultiple: () => !!opts.multiple,
    element: () => ({
      getAttribute: async (k: string) =>
        (k === 'accept' ? opts.accept : opts.name) ?? null,
    }),
    setFiles: async (files: string | string[]) => {
      given.push(Array.isArray(files) ? files : [files]);
    },
  };
}

function fakePage(initialUrl = 'https://site.test/upload') {
  let currentUrl = initialUrl;
  const handlers = new Map<string, Array<(a: unknown) => void>>();
  const onceHandlers = new Map<string, Array<() => void>>();
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
      if (!onceHandlers.has(type)) onceHandlers.set(type, []);
      onceHandlers.get(type)!.push(fn);
      return this;
    },
    emit(type: string, arg?: unknown) {
      (handlers.get(type) || []).forEach((f) => f(arg));
      const once = onceHandlers.get(type) || [];
      onceHandlers.delete(type);
      once.forEach((f) => f());
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
    addPage(p: ReturnType<typeof fakePage>) {
      pages.push(p);
      (handlers.get('page') || []).forEach((f) => f(p));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function upload(name: string, body = 'test-data'): Promise<string> {
  const stored = await saveUpload(USER, name, Buffer.from(body));
  return stored.token;
}

describe('FileChooserService', () => {
  it('supports concurrent multi-page choosers without crosstalk', async () => {
    const pageA = fakePage('https://site-a.test/upload');
    const pageB = fakePage('https://site-b.test/upload');
    const ctx = fakeContext([pageA, pageB]);

    const service = new FileChooserService(USER, 'profile-1', 'runtime-1');
    service.watch(ctx as any);

    const events: Array<{ type: string; notice: FileChooserNotice }> = [];
    service.subscribe((e) => events.push(e));

    const chooserA = fakeChooser({ multiple: false });
    const chooserB = fakeChooser({ multiple: true });

    pageA.emit('filechooser', chooserA);
    pageB.emit('filechooser', chooserB);
    await settle();

    expect(events).toHaveLength(2);
    const noticeA = events[0].notice;
    const noticeB = events[1].notice;

    expect(noticeA.pageId).not.toBe(noticeB.pageId);
    expect(noticeA.runtimeId).toBe('runtime-1');
    expect(noticeB.runtimeId).toBe('runtime-1');
    expect(noticeA.multiple).toBe(false);
    expect(noticeB.multiple).toBe(true);

    // Both pages have independent pending choosers
    expect(service.pendingForPage(noticeA.pageId)).not.toBeNull();
    expect(service.pendingForPage(noticeB.pageId)).not.toBeNull();

    // Answer page A
    const tokenA = await upload('fileA.txt', 'hello A');
    const resA = await service.accept(noticeA.pageId, noticeA.id, [tokenA]);
    expect(resA.count).toBe(1);
    expect(chooserA.given).toHaveLength(1);
    expect(chooserA.given[0][0]).toContain('fileA.txt');

    // Page A is done, but Page B is still pending!
    expect(service.pendingForPage(noticeA.pageId)).toBeNull();
    expect(service.pendingForPage(noticeB.pageId)).not.toBeNull();
    expect(chooserB.given).toHaveLength(0);

    // Answer page B with paths
    const resB = await service.acceptPaths(noticeB.pageId, noticeB.id, ['/tmp/fileB1.txt', '/tmp/fileB2.txt']);
    expect(resB.count).toBe(2);
    expect(chooserB.given).toHaveLength(1);
    expect(chooserB.given[0]).toEqual(['/tmp/fileB1.txt', '/tmp/fileB2.txt']);

    expect(service.pendingForPage(noticeB.pageId)).toBeNull();
  });

  it('correctly classifies extension pages and captures extensionId in notices', async () => {
    const extPage = fakePage('chrome-extension://abcdefghijklmno/popup.html');
    const ctx = fakeContext([extPage]);

    const service = new FileChooserService(USER, 'profile-1', 'runtime-1');
    service.watch(ctx as any);

    const ref = service.registry().list()[0];
    expect(ref.kind).toBe('extension');
    expect(ref.extensionId).toBe('abcdefghijklmno');

    let receivedNotice: FileChooserNotice | null = null;
    service.subscribe((e) => {
      if (e.type === 'pending') receivedNotice = e.notice;
    });

    const chooser = fakeChooser({ multiple: false });
    extPage.emit('filechooser', chooser);
    await settle();

    expect(receivedNotice).not.toBeNull();
    expect(receivedNotice!.kind).toBe('extension');
    expect(receivedNotice!.extensionId).toBe('abcdefghijklmno');

    const token = await upload('cookies.json', '{}');
    const res = await service.accept(receivedNotice!.pageId, receivedNotice!.id, [token]);
    expect(res.count).toBe(1);
    expect(chooser.given).toHaveLength(1);
    expect(chooser.given[0][0]).toContain('cookies.json');
  });

  it('updates page classification dynamically on navigation', async () => {
    const page = fakePage('about:blank');
    const ctx = fakeContext([page]);

    const service = new FileChooserService(USER, 'profile-1', 'runtime-1');
    service.watch(ctx as any);

    const ref = service.registry().list()[0];
    expect(ref.kind).toBe('other');

    // Page navigates to an extension options page
    page.setUrl('chrome-extension://my-extension-id/options.html');
    page.emit('domcontentloaded');

    expect(ref.kind).toBe('extension');
    expect(ref.extensionId).toBe('my-extension-id');

    let notice: FileChooserNotice | null = null;
    service.subscribe((e) => {
      if (e.type === 'pending') notice = e.notice;
    });

    const chooser = fakeChooser({ multiple: false });
    page.emit('filechooser', chooser);
    await settle();

    expect(notice).not.toBeNull();
    expect(notice!.kind).toBe('extension');
    expect(notice!.extensionId).toBe('my-extension-id');
  });

  it('cancels specific page chooser without touching others', async () => {
    const pageA = fakePage('https://a.test/');
    const pageB = fakePage('https://b.test/');
    const ctx = fakeContext([pageA, pageB]);

    const service = new FileChooserService(USER, 'profile-1', 'runtime-1');
    service.watch(ctx as any);

    const chooserA = fakeChooser();
    const chooserB = fakeChooser();

    pageA.emit('filechooser', chooserA);
    pageB.emit('filechooser', chooserB);
    await settle();

    const noticeA = service.pendingForPage(service.registry().idFor(pageA as any)!)!;
    const noticeB = service.pendingForPage(service.registry().idFor(pageB as any)!)!;

    const cancelled = await service.cancel(noticeA.pageId, noticeA.id);
    expect(cancelled).toBe(true);
    expect(chooserA.given).toEqual([[]]); // Playwright cancel = setFiles([])

    // Page B is still pending
    expect(service.pendingForPage(noticeB.pageId)).not.toBeNull();
    expect(chooserB.given).toHaveLength(0);
  });
});
