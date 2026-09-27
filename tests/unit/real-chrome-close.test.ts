import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { clearTabSessions, RealChrome } from '../../src/core/RealChrome';
import { config } from '../../src/config';

describe('RealChrome close & session clear', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'realchrome-close-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    (RealChrome as unknown as { context: unknown }).context = null;
  });

  it('clearTabSessions deletes Session_* and Tabs_* files but preserves other profile files', async () => {
    const sessionsDir = path.join(tmpDir, 'Default', 'Sessions');
    const networkDir = path.join(tmpDir, 'Default', 'Network');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(networkDir, { recursive: true });

    // Seed session files and cookie/profile files
    await fs.writeFile(path.join(sessionsDir, 'Session_1334567890'), 'session-data');
    await fs.writeFile(path.join(sessionsDir, 'Tabs_1334567890'), 'tabs-data');
    await fs.writeFile(path.join(networkDir, 'Cookies'), 'cookie-data');
    await fs.writeFile(path.join(tmpDir, 'Default', 'Preferences'), '{"profile":{}}');

    await clearTabSessions(tmpDir);

    // Verify session files were cleared
    const remainingSessions = await fs.readdir(sessionsDir);
    expect(remainingSessions).toEqual([]);

    // Verify cookies and preferences were NOT touched
    expect(await fs.readFile(path.join(networkDir, 'Cookies'), 'utf8')).toBe('cookie-data');
    expect(await fs.readFile(path.join(tmpDir, 'Default', 'Preferences'), 'utf8')).toBe('{"profile":{}}');
  });

  it('closeBrowser closes all open pages, stops RealChrome, and clears tab sessions', async () => {
    const sessionsDir = path.join(tmpDir, 'Default', 'Sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 'Tabs_999'), 'stale-tabs');

    const origUserDataDir = config.REAL_CHROME_USER_DATA_DIR;
    (config as { REAL_CHROME_USER_DATA_DIR: string }).REAL_CHROME_USER_DATA_DIR = tmpDir;

    let pageClosed = false;
    let contextClosed = false;

    const fakePage = {
      close: async () => { pageClosed = true; },
      isClosed: () => pageClosed,
    };

    const fakeContext = {
      pages: () => [fakePage],
      close: async () => { contextClosed = true; },
    };

    (RealChrome as unknown as { context: unknown }).context = fakeContext;

    try {
      await RealChrome.closeBrowser(1000);

      expect(pageClosed).toBe(true);
      expect(contextClosed).toBe(true);
      expect(RealChrome.isRunning()).toBe(false);

      const remaining = await fs.readdir(sessionsDir);
      expect(remaining).toEqual([]);
    } finally {
      (config as { REAL_CHROME_USER_DATA_DIR: string }).REAL_CHROME_USER_DATA_DIR = origUserDataDir;
    }
  });
});
