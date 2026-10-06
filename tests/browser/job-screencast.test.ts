/**
 * Task 4b — the screencast hub against REAL Chromium: frames really arrive,
 * they really show the page, and the CDP session is released afterwards.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeBrowser, ensureProbed, sharedBrowser, closeSharedBrowser } from './real-browser';
import { JobScreencastHub, type ScreencastFrame } from '../../src/core/JobScreencast';

await ensureProbed();

let web: http.Server; let url = '';
beforeAll(async () => {
  web = http.createServer((_q, s) => {
    s.setHeader('content-type', 'text/html');
    s.end('<body style="margin:0;background:#ff0000"><h1 id=t>hello</h1></body>');
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/`;
});
afterAll(async () => { await new Promise((r) => web.close(r)); await closeSharedBrowser(); });

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

describeBrowser('JobScreencastHub + real Chromium', () => {
  it('streams real JPEG frames of the job page, and releases the session', async () => {
    const browser = await sharedBrowser();
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const page = await ctx.newPage();
    await page.goto(url);

    const hub = new JobScreencastHub({ getPage: () => page as any, pollMs: 200, minIntervalMs: 0 });
    const frames: ScreencastFrame[] = []; const status: string[] = [];
    const stop = hub.subscribe('u', 'job-1', { frame: (f) => frames.push(f), status: (s) => status.push(s) });

    expect(await until(() => frames.length > 0)).toBe(true);
    expect(status).toContain('live');
    const f = frames[0];
    const bytes = Buffer.from(f.data, 'base64');
    expect(bytes[0]).toBe(0xff); expect(bytes[1]).toBe(0xd8); // JPEG magic
    expect(f.width).toBeGreaterThan(0);

    // The picture follows the page: change it and a NEW frame arrives.
    const before = frames.length;
    await page.evaluate(() => { document.body.style.background = '#00ff00'; });
    expect(await until(() => frames.length > before)).toBe(true);

    // The page closing is reported as "ended", not left hanging.
    await page.close();
    expect(await until(() => status.includes('ended'))).toBe(true);

    stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.activeJobs()).toBe(0);
    await ctx.close();
  });
});
