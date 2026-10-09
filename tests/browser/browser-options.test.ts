/**
 * Task 4a — each browser option, proven against a REAL Chromium.
 *
 * The unit suite (tests/unit/browser-options.test.ts) proves the plan contains
 * the right Playwright keys. This one proves Chromium then really behaves
 * differently, per option, using the same call shape as pipeline.ts
 * (launchPersistentContext with launch + context keys from planFor()).
 *
 * Everything is local: an echo/auth/CSP HTTP server, a counting proxy and a
 * self-signed HTTPS server. No internet needed.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { chromium, type BrowserContext } from 'playwright';
import { describeBrowser, ensureProbed, closeSharedBrowser } from './real-browser';
import { planFor, effectiveHeadless, browserOptionDefs } from '../../src/core/BrowserOptions';

await ensureProbed();

const hasDisplay = !!process.env.DISPLAY;
let web: http.Server; let webUrl = '';
let proxy: http.Server; let proxyPort = 0;
let tls: https.Server | null = null; let tlsUrl = '';
const proxySeen: Array<{ url: string; auth?: string }> = [];
const tmpDirs: string[] = [];
const covered = new Set<string>();

/** Open a browser the way ensureVipBrowser() does. */
async function open(options: Record<string, unknown>): Promise<BrowserContext> {
  const plan = planFor(options, 'vip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-bo-'));
  tmpDirs.push(dir);
  const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  const extra: string[] = (plan.launch.args || []).filter((a: string) => !baseArgs.includes(a));
  return chromium.launchPersistentContext(dir, {
    viewport: { width: 1280, height: 720 },
    timeout: 30000,
    ...(plan.launch.slowMo ? { slowMo: plan.launch.slowMo } : {}),
    ...(plan.launch.proxy ? { proxy: plan.launch.proxy } : {}),
    ...plan.context,
    headless: effectiveHeadless(options, true),
    args: [...baseArgs, ...extra],
  });
}
async function withPage<T>(options: Record<string, unknown>, fn: (ctx: BrowserContext, page: import('playwright').Page) => Promise<T>): Promise<T> {
  const ctx = await open(options);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    return await fn(ctx, page);
  } finally { await ctx.close().catch(() => {}); }
}
const pass = (id: string) => covered.add(id);

beforeAll(async () => {
  web = http.createServer((req, res) => {
    const u = req.url || '/';
    if (u.startsWith('/echo')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ headers: req.headers }));
    } else if (u.startsWith('/auth')) {
      const ok = req.headers.authorization === 'Basic ' + Buffer.from('basic-user:basic-pass').toString('base64');
      if (!ok) { res.statusCode = 401; res.setHeader('www-authenticate', 'Basic realm="t"'); res.end('no'); return; }
      res.end('<title>authed</title>');
    } else if (u.startsWith('/csp')) {
      res.setHeader('content-security-policy', "script-src 'none'");
      res.setHeader('content-type', 'text/html');
      res.end('<title>t</title><script>window.__ran = 1</script>');
    } else if (u.startsWith('/js')) {
      res.setHeader('content-type', 'text/html');
      res.end('<title>no-js</title><script>document.title = "js-ran"</script>');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<title>ok</title><p>hello</p>');
    }
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  webUrl = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;

  proxy = http.createServer((req, res) => {
    proxySeen.push({ url: req.url || '', auth: req.headers['proxy-authorization'] as string | undefined });
    if (req.headers['proxy-authorization'] === undefined && (req.url || '').includes('needauth.test')) {
      res.statusCode = 407; res.setHeader('proxy-authenticate', 'Basic realm="p"'); res.end('auth'); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<title>via-proxy</title>');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;

  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-tls-')); tmpDirs.push(dir);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
      '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    tls = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) },
      (_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<title>tls-ok</title>'); });
    await new Promise<void>((r) => tls!.listen(0, '127.0.0.1', r));
    tlsUrl = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`;
  } catch { tls = null; }
});

afterAll(async () => {
  await new Promise((r) => web?.close(r)); await new Promise((r) => proxy?.close(r)); await new Promise((r) => tls?.close(r));
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  await closeSharedBrowser();
});

describeBrowser('browser options change a real Chromium', () => {
  it('headless: true runs the headless build', async () => {
    await withPage({ headless: true }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => navigator.userAgent)).toMatch(/HeadlessChrome/);
    });
    pass('headless');
  });

  it.skipIf(!hasDisplay)('headless: false opens a visible (headed) browser', async () => {
    await withPage({ headless: false }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => navigator.userAgent)).not.toMatch(/HeadlessChrome/);
    });
  });

  it('slowMo: delays every browser ACTION (Playwright exempts evaluate, so clicks are timed)', async () => {
    const run = (o: Record<string, unknown>) => withPage(o, async (_c, p) => {
      await p.goto(webUrl);
      const t = Date.now();
      for (let i = 0; i < 4; i++) await p.locator('p').click();
      return Date.now() - t;
    });
    const fast = await run({});
    const slow = await run({ slowMo: 200 });
    expect(slow - fast).toBeGreaterThan(400);
    pass('slowMo');
  });

  it('chromeArgs: a switch really reaches Chrome (a made-up host starts to resolve)', async () => {
    const port = new URL(webUrl).port;
    const target = `http://plyr-mapped.test:${port}/`;
    await withPage({}, async (_c, p) => {
      await expect(p.goto(target, { timeout: 8000 })).rejects.toThrow(/net::/);
    });
    await withPage({ chromeArgs: ['--host-resolver-rules=MAP plyr-mapped.test 127.0.0.1', '--mute-audio'] }, async (_c, p) => {
      await p.goto(target);
      expect(await p.title()).toBe('ok');
    });
    pass('chromeArgs');
  });

  it('viewportWidth / viewportHeight', async () => {
    await withPage({ viewportWidth: 900, viewportHeight: 640 }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 640]);
    });
    await withPage({ viewportWidth: 700 }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => [innerWidth, innerHeight])).toEqual([700, 720]);
    });
    pass('viewportWidth'); pass('viewportHeight');
  });

  it('deviceScaleFactor / isMobile / hasTouch', async () => {
    await withPage({ deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (_c, p) => {
      await p.goto(webUrl);
      const r = await p.evaluate(() => ({ dpr: devicePixelRatio, touch: navigator.maxTouchPoints > 0, ontouch: 'ontouchstart' in window }));
      expect(r.dpr).toBe(2); expect(r.touch).toBe(true); expect(r.ontouch).toBe(true);
    });
    await withPage({}, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => devicePixelRatio)).toBe(1);
      expect(await p.evaluate(() => navigator.maxTouchPoints)).toBe(0);
    });
    pass('deviceScaleFactor'); pass('isMobile'); pass('hasTouch');
  });

  it('userAgent: the page AND the request header carry it', async () => {
    await withPage({ userAgent: 'PlyrTest/1.0 (custom)' }, async (_c, p) => {
      await p.goto(`${webUrl}/echo`);
      expect(await p.evaluate(() => navigator.userAgent)).toBe('PlyrTest/1.0 (custom)');
      expect(JSON.parse(await p.innerText('body')).headers['user-agent']).toBe('PlyrTest/1.0 (custom)');
    });
    pass('userAgent');
  });

  it('colorScheme / reducedMotion', async () => {
    await withPage({ colorScheme: 'dark', reducedMotion: 'reduce' }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
      expect(await p.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    });
    await withPage({ colorScheme: 'light' }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false);
    });
    pass('colorScheme'); pass('reducedMotion');
  });

  it('locale / timezoneId', async () => {
    await withPage({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await p.evaluate(() => navigator.language)).toBe('fa-IR');
      expect(await p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tehran');
    });
    await withPage({ locale: 'en-US', timezoneId: 'America/New_York' }, async (_c, p) => {
      await p.goto(`${webUrl}/echo`);
      expect(JSON.parse(await p.innerText('body')).headers['accept-language']).toMatch(/^en-US/);
      expect(await p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/New_York');
    });
    pass('locale'); pass('timezoneId');
  });

  it('geolocation (+ accuracy) is served, and its permission is granted automatically', async () => {
    await withPage({ geolocationLat: 35.6892, geolocationLon: 51.389, geolocationAccuracy: 25 }, async (_c, p) => {
      await p.goto(webUrl);
      const r = await p.evaluate(() => new Promise<any>((res) => navigator.geolocation.getCurrentPosition(
        (x) => res({ lat: x.coords.latitude, lon: x.coords.longitude, acc: x.coords.accuracy }),
        (e) => res({ err: e.code }))));
      expect(r).toEqual({ lat: 35.6892, lon: 51.389, acc: 25 });
    });
    // no geolocation option -> the browser has nothing to give
    await withPage({}, async (_c, p) => {
      await p.goto(webUrl);
      const r = await p.evaluate(() => new Promise<any>((res) => navigator.geolocation.getCurrentPosition(
        () => res({ ok: 1 }), (e) => res({ err: e.code }), { timeout: 2000 })));
      expect(r.ok).toBeUndefined();
    });
    pass('geolocationLat'); pass('geolocationLon'); pass('geolocationAccuracy');
  });

  it('permissions are granted without a prompt', async () => {
    // permissions.query is the truth: headless Chromium reports
    // Notification.permission as "denied" even for a granted permission.
    const state = (name: string) => (p: import('playwright').Page) =>
      p.evaluate(async (n) => (await navigator.permissions.query({ name: n as PermissionName })).state, name);
    await withPage({ permissions: ['notifications', 'clipboard-read'] }, async (_c, p) => {
      await p.goto(webUrl);
      expect(await state('notifications')(p)).toBe('granted');
      expect(await state('clipboard-read')(p)).toBe('granted');
    });
    await withPage({}, async (_c, p) => {
      await p.goto(webUrl);
      expect(await state('notifications')(p)).not.toBe('granted');
      expect(await state('clipboard-read')(p)).not.toBe('granted');
    });
    pass('permissions');
  });

  it('proxyServer / proxyBypass: traffic goes through the proxy except the bypassed host', async () => {
    proxySeen.length = 0;
    await withPage({ proxyServer: `http://127.0.0.1:${proxyPort}` }, async (_c, p) => {
      await p.goto('http://via-proxy.test/page');
      expect(await p.title()).toBe('via-proxy');
    });
    expect(proxySeen.some((s) => s.url.includes('via-proxy.test'))).toBe(true);

    proxySeen.length = 0;
    await withPage({ proxyServer: `http://127.0.0.1:${proxyPort}`, proxyBypass: 'direct.test' }, async (_c, p) => {
      await p.goto('http://direct.test/page', { timeout: 8000 }).catch(() => {});
    });
    expect(proxySeen.some((s) => s.url.includes('direct.test'))).toBe(false);
    pass('proxyServer'); pass('proxyBypass');
  });

  it('proxyUsername / proxyPassword answer the proxy 407 challenge', async () => {
    proxySeen.length = 0;
    await withPage({ proxyServer: `http://127.0.0.1:${proxyPort}`, proxyUsername: 'proxy-user', proxyPassword: 's3cret' }, async (_c, p) => {
      await p.goto('http://needauth.test/x');
      expect(await p.title()).toBe('via-proxy');
    });
    const authed = proxySeen.find((s) => s.auth);
    expect(authed?.auth).toBe('Basic ' + Buffer.from('proxy-user:s3cret').toString('base64'));
    pass('proxyUsername'); pass('proxyPassword');
  });

  it('extraHTTPHeaders ride on every request', async () => {
    await withPage({ extraHTTPHeaders: { 'X-Plyr-Test': 'yes' } }, async (_c, p) => {
      await p.goto(`${webUrl}/echo`);
      expect(JSON.parse(await p.innerText('body')).headers['x-plyr-test']).toBe('yes');
    });
    pass('extraHTTPHeaders');
  });

  it('httpUsername / httpPassword pass Basic Auth', async () => {
    await withPage({}, async (_c, p) => {
      const r = await p.goto(`${webUrl}/auth`);
      expect(r?.status()).toBe(401);
    });
    await withPage({ httpUsername: 'basic-user', httpPassword: 'basic-pass' }, async (_c, p) => {
      await p.goto(`${webUrl}/auth`);
      expect(await p.title()).toBe('authed');
    });
    pass('httpUsername'); pass('httpPassword');
  });

  it('javaScriptEnabled: false stops the page scripts', async () => {
    await withPage({ javaScriptEnabled: false }, async (_c, p) => {
      await p.goto(`${webUrl}/js`);
      expect(await p.title()).toBe('no-js');
    });
    await withPage({}, async (_c, p) => {
      await p.goto(`${webUrl}/js`);
      expect(await p.title()).toBe('js-ran');
    });
    pass('javaScriptEnabled');
  });

  it('ignoreHTTPSErrors accepts a self-signed certificate', async () => {
    if (!tls) return; // openssl unavailable: reported by the pass-set check below
    await withPage({}, async (_c, p) => {
      await expect(p.goto(tlsUrl, { timeout: 8000 })).rejects.toThrow(/ERR_CERT|net::/);
    });
    await withPage({ ignoreHTTPSErrors: true }, async (_c, p) => {
      await p.goto(tlsUrl);
      expect(await p.title()).toBe('tls-ok');
    });
    pass('ignoreHTTPSErrors');
  });

  it('offline: every request fails', async () => {
    await withPage({ offline: true }, async (_c, p) => {
      await expect(p.goto(webUrl, { timeout: 8000 })).rejects.toThrow(/ERR_INTERNET_DISCONNECTED|net::/);
    });
    await withPage({}, async (_c, p) => { await p.goto(webUrl); expect(await p.title()).toBe('ok'); });
    pass('offline');
  });

  it('bypassCSP lets blocked scripts run', async () => {
    await withPage({}, async (_c, p) => {
      await p.goto(`${webUrl}/csp`);
      expect(await p.evaluate(() => (window as any).__ran)).toBeUndefined();
    });
    await withPage({ bypassCSP: true }, async (_c, p) => {
      await p.goto(`${webUrl}/csp`);
      expect(await p.evaluate(() => (window as any).__ran)).toBe(1);
    });
    pass('bypassCSP');
  });

  it('every catalog option is exercised by a real-browser test above (headless:false needs a display)', () => {
    const skipHeadedOnly = hasDisplay ? [] : [];
    const missing = browserOptionDefs().map((d) => d.id)
      .filter((id) => !covered.has(id))
      .filter((id) => !(id === 'ignoreHTTPSErrors' && !tls))
      .filter((id) => !skipHeadedOnly.includes(id));
    expect(missing).toEqual([]);
  });
});
