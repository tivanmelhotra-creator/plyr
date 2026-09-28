import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserWindowManager } from '../../src/core/BrowserWindowManager';

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
