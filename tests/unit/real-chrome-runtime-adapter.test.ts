import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealChrome } from '../../src/core/RealChrome';
import { RealChromeRuntimeAdapter } from '../../src/core/RealChromeRuntimeAdapter';

function contextWithPages(pages: any[]) {
  return { pages: () => pages } as any;
}

describe('RealChromeRuntimeAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the same runtime id when context is requested repeatedly', async () => {
    const page = { url: () => 'https://example.test/' } as any;
    const context = contextWithPages([page]);
    vi.spyOn(RealChrome, 'getContext').mockResolvedValue(context);
    vi.spyOn(RealChrome, 'status').mockResolvedValue({
      runtimeId: 'realchrome:r1', enabled: true, running: true, extensions: [],
      installedCount: 0, restartRequired: false, userDataDir: '', extensionsDir: '',
      headless: true, display: '', debugPort: 0, debugBind: '127.0.0.1', debugUrl: '',
      browserVersion: '', webSocketDebuggerUrl: '', lastError: '',
    });
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(true);

    const runtime = new RealChromeRuntimeAdapter('p1');
    await runtime.context();
    const first = runtime.runtimeId;
    await runtime.context();

    expect(first).toBe('realchrome:r1');
    expect(runtime.runtimeId).toBe(first);
    expect(runtime.currentPages()).toHaveLength(1);
  });

  it('invalidates old pages and adopts the new incarnation after restart', async () => {
    const oldPage = { url: () => 'https://old.test/' } as any;
    const newPage = { url: () => 'https://new.test/' } as any;
    const contexts = [contextWithPages([oldPage]), contextWithPages([newPage])];
    let index = 0;
    let runtimeId = 'realchrome:r1';
    vi.spyOn(RealChrome, 'getContext').mockImplementation(async () => contexts[index]);
    vi.spyOn(RealChrome, 'status').mockImplementation(async () => ({
      runtimeId, enabled: true, running: true, extensions: [], installedCount: 0,
      restartRequired: false, userDataDir: '', extensionsDir: '', headless: true,
      display: '', debugPort: 0, debugBind: '127.0.0.1', debugUrl: '', browserVersion: '',
      webSocketDebuggerUrl: '', lastError: '',
    }));
    vi.spyOn(RealChrome, 'restart').mockImplementation(async () => {
      index = 1;
      runtimeId = 'realchrome:r2';
      return await RealChrome.status();
    });
    vi.spyOn(RealChrome, 'isRunning').mockReturnValue(true);

    const runtime = new RealChromeRuntimeAdapter('p1');
    await runtime.start();
    const oldRef = runtime.currentPages()[0];
    await runtime.restart();
    const pages = runtime.currentPages();

    expect(runtime.runtimeId).toBe('realchrome:r2');
    expect(oldRef.runtimeId).toBe('realchrome:r1');
    expect(oldRef.invalidatedAt).toBeDefined();
    expect(pages).toHaveLength(1);
    expect(pages[0].runtimeId).toBe('realchrome:r2');
    expect(pages[0].pageId).not.toBe(oldRef.pageId);
  });
});
