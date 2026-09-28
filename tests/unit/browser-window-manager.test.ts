import { describe, it, expect, beforeEach } from 'vitest';
import {
  BrowserWindowManager,
  isBrowserWindowClass,
  normalizeWindowId,
  parseBrowserTitle,
  parseChromeCmdline,
  parseLocalState,
  parseWindowProps,
  parseWmctrlList,
} from '../../src/core/BrowserWindowManager';

describe('BrowserWindowManager', () => {
  beforeEach(() => {
    BrowserWindowManager.clear();
  });

  it('registers and retrieves a browser session', async () => {
    const session = BrowserWindowManager.register({
      id: 'session_1',
      profileId: 'profile_a',
      profileName: 'Account 1',
      title: 'GitHub',
      state: 'active',
    });

    expect(session.id).toBe('session_1');
    expect(session.profileId).toBe('profile_a');
    expect(session.profileName).toBe('Account 1');
    expect(session.title).toBe('GitHub');
    expect(session.state).toBe('active');

    const retrieved = BrowserWindowManager.get('session_1');
    expect(retrieved).toEqual(session);
  });

  it('lists registered active and minimized sessions', async () => {
    BrowserWindowManager.register({
      id: 'session_1',
      profileId: 'profile_a',
      profileName: 'Account 1',
      title: 'GitHub',
      state: 'active',
    });

    BrowserWindowManager.register({
      id: 'session_2',
      profileId: 'profile_b',
      profileName: 'Testing',
      title: 'Arena AI',
      state: 'minimized',
    });

    const list = await BrowserWindowManager.list();
    expect(list.length).toBe(2);
    expect(list.find((s) => s.id === 'session_1')?.state).toBe('active');
    expect(list.find((s) => s.id === 'session_2')?.state).toBe('minimized');
  });

  it('minimizes an active session', async () => {
    BrowserWindowManager.register({
      id: 'session_1',
      profileId: 'profile_a',
      profileName: 'Account 1',
      title: 'GitHub',
      state: 'active',
    });

    const minimized = await BrowserWindowManager.minimize('session_1');
    expect(minimized).not.toBeNull();
    expect(minimized?.state).toBe('minimized');

    const updated = BrowserWindowManager.get('session_1');
    expect(updated?.state).toBe('minimized');
  });

  it('restores a minimized session', async () => {
    BrowserWindowManager.register({
      id: 'session_1',
      profileId: 'profile_a',
      profileName: 'Account 1',
      title: 'GitHub',
      state: 'minimized',
    });

    const restored = await BrowserWindowManager.restore('session_1');
    expect(restored).not.toBeNull();
    expect(restored?.state).toBe('active');
    expect(restored?.focused).toBe(true);

    const updated = BrowserWindowManager.get('session_1');
    expect(updated?.state).toBe('active');
  });

  it('unregisters a session', async () => {
    BrowserWindowManager.register({
      id: 'session_1',
      profileId: 'profile_a',
      profileName: 'Account 1',
      title: 'GitHub',
      state: 'active',
    });

    expect(BrowserWindowManager.unregister('session_1')).toBe(true);
    expect(BrowserWindowManager.get('session_1')).toBeNull();
    const list = await BrowserWindowManager.list();
    expect(list.length).toBe(0);
  });

  it('returns null when minimizing or restoring non-existent session', async () => {
    expect(await BrowserWindowManager.minimize('unknown')).toBeNull();
    expect(await BrowserWindowManager.restore('unknown')).toBeNull();
  });
});

describe('X11 window discovery helpers', () => {
  it('normalizes wmctrl, xprop and decimal window ids to one form', () => {
    expect(normalizeWindowId('0x02400003')).toBe('0x2400003');
    expect(normalizeWindowId('0x2400003')).toBe('0x2400003');
    expect(normalizeWindowId('37748739')).toBe('0x2400003');
    expect(normalizeWindowId('')).toBe('');
  });

  it('lists EVERY Chromium window, not just the first one', () => {
    const out = [
      '0x02400003  0 812    chromium.Chromium     host GitHub - Chromium',
      '0x02600004  0 812    chromium.Chromium     host Arena - Chromium - Testing',
      '0x01200002  0 400    xterm.XTerm           host bash',
    ].join('\n');
    const rows = parseWmctrlList(out).filter((r) => isBrowserWindowClass(r.wmClass));
    expect(rows.map((r) => r.windowId)).toEqual(['0x2400003', '0x2600004']);
    expect(rows[0].pid).toBe(812);
    expect(rows[1].title).toBe('Arena - Chromium - Testing');
  });

  it('reads the profile name Chromium puts in the window title', () => {
    const names = ['Person 1', 'Testing'];
    expect(parseBrowserTitle('Arena - Chromium - Testing', names)).toEqual({ page: 'Arena', profileName: 'Testing' });
    expect(parseBrowserTitle('Arena - Testing - Chromium', names)).toEqual({ page: 'Arena', profileName: 'Testing' });
    expect(parseBrowserTitle('GitHub - Chromium', names)).toEqual({ page: 'GitHub', profileName: null });
    expect(parseBrowserTitle('A - B - Chromium', [])).toEqual({ page: 'A - B', profileName: null });
  });

  it('detects minimized windows and skips non-normal ones', () => {
    expect(
      parseWindowProps('_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n'),
    ).toEqual({ hidden: true, skipTaskbar: false, normal: true });
    expect(parseWindowProps('_NET_WM_STATE(ATOM) = \n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_POPUP_MENU\n').normal).toBe(false);
    expect(parseWindowProps('_NET_WM_STATE:  not found.\n_NET_WM_WINDOW_TYPE:  not found.\n')).toEqual({
      hidden: false,
      skipTaskbar: false,
      normal: true,
    });
  });

  it('reads profile names from Local State', () => {
    const json = JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Testing' } } } });
    expect(parseLocalState(json)).toEqual([
      { dir: 'Default', name: 'Person 1' },
      { dir: 'Profile 1', name: 'Testing' },
    ]);
    expect(parseLocalState('not json')).toEqual([]);
  });

  it('reads user-data-dir and profile-directory from a Chromium cmdline', () => {
    const cmd = ['/usr/bin/chromium', '--user-data-dir=/data/p2', '--profile-directory=Profile 1', ''].join('\0');
    expect(parseChromeCmdline(cmd)).toEqual({ userDataDir: '/data/p2', profileDirectory: 'Profile 1' });
  });
});
