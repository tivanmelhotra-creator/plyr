/**
 * Extensions must work in BOTH run modes (core/RunPolicy):
 *   manual run    -> visible browser (headless: false, needs a display)
 *   automatic run -> hidden browser via hiddenLaunchOptions(): Chromium's NEW
 *                    headless mode (full binary, channel 'chromium')
 * and the old headless SHELL (plain `headless: true`) is the thing we avoid,
 * because it has no extension host.
 *
 * Measured with a minimal MV3 extension: does its service worker start?
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type BrowserContext } from 'playwright';
import { hiddenLaunchOptions, headlessFor } from '../../src/core/RunPolicy';
import { describeBrowser, ensureProbed } from './real-browser';

await ensureProbed();

let extDir = '';
beforeAll(() => {
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'probe', version: '1.0', background: { service_worker: 'sw.js' },
  }));
  fs.writeFileSync(path.join(extDir, 'sw.js'), "self.addEventListener('install', () => {});");
});
afterAll(() => { try { fs.rmSync(extDir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function workersWith(headless: boolean, extra: Record<string, unknown>): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      headless,
      ...extra,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
      timeout: 60_000,
    });
    let sw = ctx.serviceWorkers();
    if (!sw.length) await ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
    sw = ctx.serviceWorkers();
    return sw.filter((w) => w.url().startsWith('chrome-extension://')).length;
  } finally {
    await ctx?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describeBrowser('run visibility keeps extensions', () => {
  it('automatic (hidden) run: new-headless loads the extension', async () => {
    const headless = headlessFor('automatic');
    expect(headless).toBe(true);
    expect(await workersWith(headless, hiddenLaunchOptions(headless))).toBe(1);
  }, 90_000);

  it('the old headless shell (what we avoid) loads none', async () => {
    expect(await workersWith(true, {})).toBe(0);
  }, 90_000);

  it.runIf(!!process.env.DISPLAY)('manual (visible) run loads the extension', async () => {
    const headless = headlessFor('manual');
    expect(headless).toBe(false);
    expect(await workersWith(headless, hiddenLaunchOptions(headless))).toBe(1);
  }, 90_000);
});
