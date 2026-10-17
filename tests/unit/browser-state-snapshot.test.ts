/**
 * core/BrowserStateSnapshot — state saved before an automatic close.
 *   - tabs (http/https only) + storageState written into the profile, 0600
 *   - an empty / crashed context never overwrites a good snapshot
 *   - a hung storageState cannot block the close beyond the budget
 *   - restoreTabs reopens only tabs not already open
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveBeforeClose, readLastSession, restoreTabs, restorableUrl, STATE_DIR, SESSION_FILE, STORAGE_FILE } from '../../src/core/BrowserStateSnapshot';

const page = (url: string, title = 't') => ({ url: () => url, title: async () => title, isClosed: () => false });
const ctxOf = (urls: string[], storage: unknown = { cookies: [{ name: 'sid', value: 'secret' }], origins: [] }) => ({
  pages: () => urls.map((u) => page(u)),
  storageState: async () => storage,
});

describe('saveBeforeClose', () => {
  it('writes restorable tabs and the storage state inside the profile, private', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    const r = await saveBeforeClose(ctxOf(['https://a.example/x', 'about:blank', 'chrome://settings', 'http://b.example/']), dir, 'after_run');
    expect(r).toEqual({ tabs: 2, storage: true });
    const snap = await readLastSession(dir);
    expect(snap!.tabs.map((t) => t.url)).toEqual(['https://a.example/x', 'http://b.example/']);
    expect(snap!.reason).toBe('after_run');
    const f1 = path.join(dir, STATE_DIR, SESSION_FILE); const f2 = path.join(dir, STATE_DIR, STORAGE_FILE);
    expect(statSync(f1).mode & 0o777).toBe(0o600);
    expect(statSync(f2).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f2, 'utf8')).cookies[0].name).toBe('sid');
  });

  it('an empty or crashed context never overwrites a good snapshot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    await saveBeforeClose(ctxOf(['https://keep.example/']), dir, 'idle');
    await saveBeforeClose({ pages: () => { throw new Error('closed'); } }, dir, 'gc');
    await saveBeforeClose(ctxOf([]), dir, 'gc');
    expect((await readLastSession(dir))!.tabs[0]!.url).toBe('https://keep.example/');
  });

  it('a hung storageState is abandoned within the budget (the close is never blocked)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    const t0 = Date.now();
    const r = await saveBeforeClose({ pages: () => [page('https://h.example/')], storageState: () => new Promise(() => {}) }, dir, 'idle');
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r).toBeNull();
    // The tabs were still written before the hang.
    expect((await readLastSession(dir))!.tabs.length).toBe(1);
  }, 10000);

  it('no context / no directory = nothing to do, no throw', async () => {
    expect(await saveBeforeClose(null, '/tmp/x', 'gc')).toBeNull();
    expect(await saveBeforeClose(ctxOf(['https://a/']), null, 'gc')).toBeNull();
    expect(await readLastSession(path.join(tmpdir(), 'does-not-exist-' + Date.now()))).toBeNull();
    expect(existsSync('/tmp/x/.plyr-state')).toBe(false);
  });
});

describe('restoreTabs', () => {
  it('reopens saved tabs that are not already open', async () => {
    const opened: string[] = [];
    const ctx = { pages: () => [page('https://a.example/')], newPage: async () => ({ goto: async (u: string) => { opened.push(u); } }) };
    const n = await restoreTabs(ctx, { version: 1, savedAt: '', reason: 'idle', tabs: [{ url: 'https://a.example/', title: '' }, { url: 'https://b.example/', title: '' }] });
    expect(n).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toEqual(['https://b.example/']);
  });
  it('only http(s) is restorable', () => {
    expect(restorableUrl('https://x')).toBe(true);
    expect(restorableUrl('javascript:alert(1)')).toBe(false);
    expect(restorableUrl('file:///etc/passwd')).toBe(false);
  });
});
