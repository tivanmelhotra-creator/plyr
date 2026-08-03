import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

// Step 12 — LiveBrowserManager session bookkeeping (no real browser).
// create()/destroy() never launch Chromium (that happens in start()),
// so we can test the registry, id uniqueness and the cap purely.

import { LiveBrowserManager } from '../../src/core/LiveBrowser';

describe('LiveBrowserManager (no browser launch)', () => {
  it('creates sessions with unique ids and tracks the count', () => {
    const mgr = new LiveBrowserManager(4);
    expect(mgr.count()).toBe(0);
    const a = mgr.create('0');
    const b = mgr.create('0');
    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe('0');
    expect(mgr.count()).toBe(2);
    expect(a.isClosed()).toBe(false);
  });

  it('enforces the max-sessions cap', () => {
    const mgr = new LiveBrowserManager(2);
    mgr.create('u1');
    mgr.create('u1');
    expect(() => mgr.create('u1')).toThrowError(/too_many_sessions/);
    expect(mgr.count()).toBe(2);
  });

  it('destroy() removes the session and marks it closed', async () => {
    const mgr = new LiveBrowserManager(4);
    const s = mgr.create('7');
    await mgr.destroy(s.id);
    expect(mgr.count()).toBe(0);
    expect(s.isClosed()).toBe(true);
    // destroying a missing id is a no-op
    await mgr.destroy('does_not_exist');
    expect(mgr.count()).toBe(0);
  });

  it('shutdown() closes and clears every session', async () => {
    const mgr = new LiveBrowserManager(4);
    const s1 = mgr.create('a');
    const s2 = mgr.create('b');
    await mgr.shutdown();
    expect(mgr.count()).toBe(0);
    expect(s1.isClosed()).toBe(true);
    expect(s2.isClosed()).toBe(true);
  });

  /**
   * "We never lose a tab" — the manager half.
   *
   * Installing an extension makes SelfHeal stop and restart real Chrome. Every
   * page those sessions were streaming dies with it, and NOTHING about their
   * WebSockets changes: the user keeps looking at a last frame of a page whose
   * browser no longer exists. Connected, unbroken-looking, dead. That is the
   * state the whole mandate exists to abolish, so it needs a test that measures
   * the rebuild actually reaching every session — not that a method exists.
   *
   * `resync()` is stubbed rather than run because running it launches Chromium;
   * what is under test here is the fan-out and the failure isolation, which is
   * all this method is. `resync()` itself is exercised against a real browser.
   */
  it('rebuildAll() resyncs EVERY live session, so a Chrome relaunch loses none', async () => {
    const mgr = new LiveBrowserManager(4);
    const a = mgr.create('u1');
    const b = mgr.create('u2');
    const c = mgr.create('u3');
    const seen: string[] = [];
    for (const s of [a, b, c]) {
      (s as unknown as { resync: () => Promise<void> }).resync = async () => {
        seen.push(s.id);
      };
    }
    const healed = await mgr.rebuildAll();
    expect(healed, 'every session must be rebuilt, not just the first').toBe(3);
    expect(seen.sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('rebuildAll() isolates a session that refuses to come back', async () => {
    // One user's page that will not reload must not strand everyone else on a
    // dead browser — that would turn one broken tab into a broken deployment.
    const mgr = new LiveBrowserManager(4);
    const ok1 = mgr.create('u1');
    const bad = mgr.create('u2');
    const ok2 = mgr.create('u3');
    let reached = 0;
    for (const s of [ok1, ok2]) {
      (s as unknown as { resync: () => Promise<void> }).resync = async () => { reached += 1; };
    }
    (bad as unknown as { resync: () => Promise<void> }).resync = async () => {
      throw new Error('target closed');
    };
    // It must RESOLVE, never reject: the caller is an extension install, and a
    // rejection there would report "install failed" for an unrelated reason.
    const healed = await mgr.rebuildAll();
    expect(healed, 'the two healthy sessions still came back').toBe(2);
    expect(reached).toBe(2);
  });

  it('rebuildAll() on an idle server is a no-op, not an error', async () => {
    const mgr = new LiveBrowserManager(4);
    await expect(mgr.rebuildAll()).resolves.toBe(0);
  });
});

describe('BrowserStreamServer path matching', () => {
  it('only matches the /browser/ws upgrade path', async () => {
    const { BrowserStreamServer } = await import('../../src/core/BrowserStreamServer');
    const srv = new BrowserStreamServer(new LiveBrowserManager(1));
    expect(srv.matches('/browser/ws')).toBe(true);
    expect(srv.matches('/live/ws')).toBe(false);
    expect(srv.matches('/')).toBe(false);
    await srv.shutdown();
  });
});

/**
 * The single worst bug found in this whole effort, and it was found by a LIVE
 * probe rather than by any of the 1150 unit tests: one failing command took the
 * entire server process down.
 *
 * `ws.on('message')` cannot be an async function — the `ws` library ignores the
 * returned promise — so the dispatch is fire-and-forget. It was written as a
 * bare `void this.handleCommand(...)`, which means any rejection became an
 * unhandledRejection, and src/index.ts answers unhandledRejection with a
 * graceful shutdown. Measured consequence: opening a tab whose CDP target
 * vanished ("no object with guid page@…") shut down every session on the box and
 * left a manual restart as the only cure — the exact loop the user said had
 * exhausted him.
 *
 * These tests read source deliberately: the guarantee IS structural. There is no
 * runtime way to assert "this process did not exit" from inside itself.
 */
describe('a failing command can never take the server down', () => {
  const src = readFileSync(join(ROOT, 'src', 'core', 'BrowserStreamServer.ts'), 'utf8');

  it('never dispatches a command as an unguarded floating promise', () => {
    // Every `void this.handleCommand(` must be followed by a `.catch(`.
    const dispatches = src.match(/void this\.handleCommand\([\s\S]{0,400}?\)\s*;/g) || [];
    expect(dispatches.length, 'the hot dispatch path still exists').toBeGreaterThan(0);
    for (const d of dispatches) {
      expect(d, 'a rejected command must not escape as an unhandledRejection')
        .toMatch(/\.catch\s*\(/);
    }
  });

  it('tells the client which command failed instead of failing silently', () => {
    expect(src).toMatch(/command_failed/);
    expect(src).toMatch(/command:\s*msg\.t/);
  });

  it('binds a new tab\'s CDP stream defensively, so one bad tab is not fatal', () => {
    const live = readFileSync(join(ROOT, 'src', 'core', 'LiveBrowser.ts'), 'utf8');
    const openTab = live.slice(live.indexOf('private async openTab'));
    const body = openTab.slice(0, openTab.indexOf('\n  /** Persist the strip'));
    expect(body, 'bindCdp inside openTab must be inside a try').toMatch(
      /try\s*\{[\s\S]{0,200}await this\.bindCdp\(page\)/,
    );
    // …and the tab must be left in a recoverable state, not dropped.
    expect(body).toMatch(/tab\.pending\s*=\s*true/);
    expect(body).toMatch(/tab_stream_pending/);
    expect(body, 'a pending tab must be given a route back to live').toMatch(/this\.resync\(\)/);
  });
});
