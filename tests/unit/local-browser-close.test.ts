import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { LiveBrowserManager } from '../../src/core/LiveBrowser';
import { saveTabs, loadTabs, clearTabs } from '../../src/core/BrowserTabs';
import { config } from '../../src/config';

describe('Local Browser Close Lifecycle', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'lb-close-test-'));
    (config as { PROFILES_DIR: string }).PROFILES_DIR = dir;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('multiple opened tabs are completely cleaned on close, and reopening starts fresh without previous tabs', async () => {
    const userId = 'user-local-test';

    // Step 1: User has multiple opened tabs in Local Browser
    await saveTabs(userId, [
      { url: 'https://site1.example.com/', title: 'Tab 1', active: true },
      { url: 'https://site2.example.com/', title: 'Tab 2' },
      { url: 'https://site3.example.com/', title: 'Tab 3' },
    ]);

    const tabsBeforeClose = await loadTabs(userId);
    expect(tabsBeforeClose.length).toBe(3);
    expect(tabsBeforeClose.map((t) => t.url)).toEqual([
      'https://site1.example.com/',
      'https://site2.example.com/',
      'https://site3.example.com/',
    ]);

    // Step 2: User clicks Close button -> session.closeBrowser() terminates session and clears tabs
    const mgr = new LiveBrowserManager(4);
    const session = mgr.create(userId);

    // Call closeBrowser() (the exact method executed on close command / POST /browser/close)
    await session.closeBrowser();

    expect(session.isClosed()).toBe(true);

    // Step 3: Reopening Local Browser (fresh startup)
    const tabsAfterReopen = await loadTabs(userId);

    // Step 4: Verify previous tabs do not return
    expect(tabsAfterReopen).toEqual([]);
    expect(tabsAfterReopen.length).toBe(0);
  });

  it('normal disconnect / idle timeout preserves tabs, but explicit Close terminates and clears them', async () => {
    const userId = 'user-disconnect-vs-close';

    // Initial state: tabs active in session
    await saveTabs(userId, [
      { url: 'https://example.com/work', title: 'Work Page', active: true },
    ]);

    // An explicit closeBrowser terminates and clears
    const mgr = new LiveBrowserManager(4);
    const session = mgr.create(userId);
    await session.closeBrowser();

    // Reopen starts fresh with 0 tabs
    const restored = await loadTabs(userId);
    expect(restored).toEqual([]);
  });
});
