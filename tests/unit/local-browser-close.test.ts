import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { LiveBrowserManager } from '../../src/core/LiveBrowser';
import { loadTabs } from '../../src/core/BrowserTabs';
import { loadStorageState } from '../../src/core/BrowserProfile';
import { GlobalBrowser } from '../../src/core/GlobalBrowser';
import { config } from '../../src/config';

describe('Local Browser Close Lifecycle', () => {
  let dir = '';

  beforeEach(async () => {
    (GlobalBrowser as unknown as { isShuttingDown: boolean }).isShuttingDown = false;
    dir = await fs.mkdtemp(join(os.tmpdir(), 'lb-close-test-'));
    (config as { PROFILES_DIR: string }).PROFILES_DIR = dir;
    (config as { REAL_CHROME_ENABLED: boolean }).REAL_CHROME_ENABLED = false;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  afterAll(async () => {
    await GlobalBrowser.shutdown().catch(() => {});
  });

  it('explicit closeBrowser() terminates session, closes all live pages, clears saved tabs, but preserves cookies/storage state', async () => {
    const userId = 'user-local-close-real';
    const mgr = new LiveBrowserManager(4);

    // 1. Start a real Local Browser session
    const session = mgr.create(userId);
    await session.start();

    // 2. Create multiple real tabs/pages
    await session.newTab('about:blank');
    const ctx = (session as unknown as { context: { pages: () => Array<{ isClosed: () => boolean }>; addCookies: (cookies: unknown[]) => Promise<void>; cookies: () => Promise<Array<{ name: string }>> } }).context;
    const pages = ctx.pages();

    // 3. Confirm the pages actually exist
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) {
      expect(p.isClosed()).toBe(false);
    }

    // Set a cookie to verify persistence across sessions
    await ctx.addCookies([
      { name: 'session_auth', value: 'token_xyz_123', domain: 'localhost', path: '/' },
    ]);

    // 4. Call closeBrowser()
    await session.closeBrowser();

    // 5. Verify every real page is actually closed
    expect(session.isClosed()).toBe(true);
    for (const p of pages) {
      expect(p.isClosed()).toBe(true);
    }

    // 6. Verify the saved tab list is empty
    const savedTabs = await loadTabs(userId);
    expect(savedTabs).toEqual([]);

    // 7. Reopen a fresh session
    const session2 = mgr.create(userId);
    await session2.start();

    // 8. Verify the previous tabs are NOT restored (starts fresh with 1 about:blank tab)
    const s2Tabs = session2.tabList();
    expect(s2Tabs.length).toBe(1);
    expect(s2Tabs[0].url).toBe('about:blank');

    // 9. Verify cookies / storageState / profile data were NOT deleted by Close
    const s2Ctx = (session2 as unknown as { context: { cookies: () => Promise<Array<{ name: string }>> } }).context;
    const s2Cookies = await s2Ctx.cookies();
    expect(s2Cookies.some((c) => c.name === 'session_auth')).toBe(true);

    const onDiskStorage = (await loadStorageState(userId)) as { cookies?: Array<{ name: string }> } | null;
    expect(onDiskStorage).not.toBeNull();
    expect(onDiskStorage?.cookies?.some((c) => c.name === 'session_auth')).toBe(true);

    await session2.closeBrowser();
  }, 30000);

  it('normal disconnect / idle timeout preserves tabs, but explicit Close terminates and clears them', async () => {
    const userId = 'user-disconnect-vs-close';
    const mgr = new LiveBrowserManager(4);

    // 1. Session with multiple real pages/tabs
    const session = mgr.create(userId);
    await session.start();
    await session.newTab('https://example.com/work');
    await session.newTab('https://example.com/docs');

    expect(session.tabList().length).toBeGreaterThanOrEqual(3);

    // 2. Normal disconnect / idle timeout triggers session.close(), NOT closeBrowser()
    await session.close();
    expect(session.isClosed()).toBe(true);

    // 3. Normal disconnect must PRESERVE saved tabs on disk
    const savedAfterDisconnect = await loadTabs(userId);
    expect(savedAfterDisconnect.length).toBeGreaterThanOrEqual(2);
    expect(savedAfterDisconnect.some((t) => t.url === 'https://example.com/work')).toBe(true);
    expect(savedAfterDisconnect.some((t) => t.url === 'https://example.com/docs')).toBe(true);

    // 4. Reopening after normal disconnect restores the tabs
    const session2 = mgr.create(userId);
    await session2.start();
    expect(session2.tabList().length).toBe(savedAfterDisconnect.length);

    // 5. Explicit Close terminates and CLEARS saved tabs
    await session2.closeBrowser();
    expect(session2.isClosed()).toBe(true);

    const savedAfterExplicitClose = await loadTabs(userId);
    expect(savedAfterExplicitClose).toEqual([]);

    // 6. Next open starts fresh without previous tabs
    const session3 = mgr.create(userId);
    await session3.start();
    expect(session3.tabList().length).toBe(1);
    expect(session3.tabList()[0].url).toBe('about:blank');
    await session3.closeBrowser();
  }, 30000);
});
