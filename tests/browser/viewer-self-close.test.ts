/**
 * The shared viewer (/desktop/chrome) and its self-close rule, with REAL
 * Chromium on Linux (Xvfb + openbox):
 *
 *   - profile browsers are real Chromium processes opened through the REAL
 *     POST /profiles/:id/open, and closed FROM OUTSIDE Aria (the window is
 *     closed through the window manager: wmctrl -c);
 *   - the viewer is the REAL page (chromeViewHtml) loaded in a second, real
 *     Chromium (the operator's browser) and polling the REAL GET
 *     /browser/sessions. Only noVNC is replaced: /desktop/core/rfb.js is a
 *     tiny fake that reports "connect" (there is no VNC server here).
 *
 *   a. one profile, its window closed from outside -> the viewer tab closes
 *      itself within ~5 s (it was opened by a script: window.open)
 *   b. two profiles, one closed from outside -> the viewer stays, the other
 *      profile stays, no dialog
 *   c. a failed /browser/sessions probe (500) + a false /browser/real/health
 *      + ONE false "zero" answer -> the viewer does NOT close
 *   d. viewer opened by hand (not by a script), last browser closed ->
 *      window.close() is refused, the tab goes to the app's main page (S34:
 *      before, a BLACK empty page stayed: brief 2.2)
 *   e. viewer opened by script WITHOUT an opener reference ('noopener'),
 *      and f. by script whose opener tab was closed: both close themselves
 *      (S34: before, both stayed BLACK because window.opener was null)
 *   plus: the rendered DOM of the viewer and of the Browser Profiles panel
 *   contains none of "Turn on", "Turn off", "Chromium Session Closed",
 *   "Close Tab", "Relaunch".
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import IORedis from 'ioredis';
import { chromium, type Browser, type Page } from 'playwright';
import { describeBrowser, ensureProbed } from './real-browser';
import { config } from '../../src/config';
import { ProfileManager } from '../../src/core/ProfileManager';
import { ProfileRegistry } from '../../src/core/ProfileRegistry';
import { ProfileLeases } from '../../src/core/ProfileLease';
import { ProfileReservations } from '../../src/core/ProfileReservations';
import { ProfileAccess, registerProfileAccess } from '../../src/core/ProfileAccess';
import { BrowserSessions, registerBrowserSessions, browserSessions } from '../../src/core/BrowserSessions';
import { closeContextBounded } from '../../src/core/SharedBrowsers';
import { createProfileRoutes } from '../../src/Routes/profile.routes';
import { chromeViewHtml } from '../../src/core/ChromeView';

await ensureProbed();

const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const toolsOk = has('Xvfb') && has('openbox') && has('wmctrl');
const DISPLAY = ':94';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-vw-'));
let xvfb: ChildProcess | null = null;
let wm: ChildProcess | null = null;
let redis: IORedis | null = null;
let redisUp = false;
let app: express.Express;
let server: http.Server;
let base = '';
let pm: ProfileManager;
let registry: ProfileRegistry;
let operator: Browser | null = null;
const prev = { display: process.env.DISPLAY, profiles: config.PROFILES_DIR, base: config.BRANCH_BASE_DIR, ext: config.REAL_CHROME_EXTENSIONS_DIR };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'local';
const FORBIDDEN = ['Turn on', 'Turn off', 'Chromium Session Closed', 'Close Tab', 'Relaunch'];

/** Fake noVNC: reports "connect" once, like a working desktop stream. */
const FAKE_RFB = `export default class FakeRFB {
  constructor(el) { this._l = {}; this.el = el; setTimeout(() => this._emit('connect', {}), 50); }
  addEventListener(n, f) { (this._l[n] = this._l[n] || []).push(f); }
  _emit(n, d) { (this._l[n] || []).forEach((f) => f({ detail: d })); }
  disconnect() { window.__rfbDisconnected = (window.__rfbDisconnected || 0) + 1; }
  clipboardPasteFrom() {}
}`;

function browserPidOn(root: string): number {
  for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      if (a.includes(`--user-data-dir=${root}`) && !a.some((x) => x.startsWith('--type='))) return Number(p);
    } catch { /* gone */ }
  }
  return 0;
}

/** Close a profile's browser window FROM OUTSIDE Aria: through the window manager. */
function closeFromOutside(root: string): void {
  const pid = browserPidOn(root);
  expect(pid).toBeGreaterThan(0);
  const rows = execFileSync('wmctrl', ['-l', '-p'], { env: { ...process.env, DISPLAY } }).toString().split('\n').filter(Boolean);
  const mine = rows.map((l) => l.trim().split(/\s+/)).filter((c) => Number(c[2]) === pid).map((c) => c[0]!);
  expect(mine.length).toBeGreaterThan(0);
  for (const w of mine) execFileSync('wmctrl', ['-i', '-c', w], { env: { ...process.env, DISPLAY } });
}

async function newOpenProfile(name: string): Promise<{ id: string; root: string }> {
  const c = await request(app).post('/profiles').send({ name, branchId: 'new' }).expect(201);
  const id = c.body.profile.id as string;
  const o = await request(app).post(`/profiles/${id}/open`).send({ workflowId: 'wf_view' });
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  const root = (await registry.locationOf(USER, id))!.root;
  for (let i = 0; i < 40 && !browserPidOn(root); i++) await sleep(100);
  return { id, root };
}

async function waitSessions(n: number): Promise<void> {
  for (let i = 0; i < 60 && browserSessions().list().length !== n; i++) await sleep(100);
  expect(browserSessions().list().length).toBe(n);
}

/** The opener page + a viewer popup opened by SCRIPT, as Browser Profiles does. */
async function viewerByScript(profileId: string): Promise<{ opener: Page; viewer: Page }> {
  const ctx = await operator!.newContext();
  const opener = await ctx.newPage();
  await opener.goto(`${base}/blank`);
  const popupP = opener.waitForEvent('popup');
  await opener.evaluate((href) => {
    // profile-manager.js claimViewer(): a NAMED window, then navigated.
    const t = window.open('', 'aria-browser-viewer');
    t!.location.href = href;
  }, `/desktop/chrome?profile=${encodeURIComponent(profileId)}&workflowId=wf_view`);
  const viewer = await popupP;
  await viewer.waitForLoadState('domcontentloaded');
  await viewer.waitForFunction(() => document.querySelector('#burger') && !(document.querySelector('#burger') as HTMLElement).hidden, null, { timeout: 15_000 });
  return { opener, viewer };
}

async function visibleTexts(p: Page): Promise<string> {
  return p.evaluate(() => document.body.innerText + ' ' + Array.from(document.querySelectorAll('button')).filter((b) => (b as HTMLElement).offsetParent !== null).map((b) => b.textContent).join(' '));
}

/** Every piece of text the page RENDERS or can render (hidden elements included), never <script>/<style> source. */
async function renderedText(p: Page): Promise<string> {
  return p.evaluate(() => {
    const out: string[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === 1 && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test((n as Element).tagName)) return;
      if (n.nodeType === 3) out.push(n.nodeValue || '');
      if (n.nodeType === 1) { const e = n as HTMLElement; for (const a of ['title', 'aria-label', 'placeholder', 'value']) { const v = e.getAttribute(a); if (v) out.push(v); } }
      n.childNodes.forEach(walk);
    };
    walk(document.body);
    return out.join(' ');
  });
}

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await redis.connect(); await redis.ping(); redisUp = true; } catch { redisUp = false; }
  if (!toolsOk || !redisUp) return;
  for (const k of await redis.keys('profile:*')) await redis.del(k);
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await sleep(800);
  wm = spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY } });
  await sleep(800);
  process.env.DISPLAY = DISPLAY;
  (config as any).PROFILES_DIR = path.join(tmp, 'profiles');
  (config as any).BRANCH_BASE_DIR = path.join(tmp, 'base');
  (config as any).REAL_CHROME_EXTENSIONS_DIR = path.join(tmp, 'extensions');
  const sessions = new BrowserSessions(null);
  registerBrowserSessions(sessions);
  pm = new ProfileManager();
  registry = new ProfileRegistry(path.join(tmp, 'profiles'), { baseDir: () => path.join(tmp, 'base') });
  const access = new ProfileAccess(registry, new ProfileLeases(redis, 120), new ProfileReservations(redis), sessions);
  registerProfileAccess(access);
  const { createBrowserRoutes } = await import('../../src/Routes/browser.routes');
  app = express();
  app.use(express.json());
  app.get('/blank', (_q, s) => { s.type('html').send('<!doctype html><title>opener</title>'); });
  app.get('/', (_q, s) => { s.type('html').send('<!doctype html><title>Aria main</title><main id="app-main">main</main>'); });
  app.get('/desktop/chrome', (_q, s) => { s.type('html').send(chromeViewHtml()); });
  app.get('/desktop/core/rfb.js', (_q, s) => { s.type('application/javascript').send(FAKE_RFB); });
  // The desktop stack (Xvfb/x11vnc/noVNC) is not what is tested here.
  app.post('/browser/desktop/start', (_q, s) => { s.json({ success: true }); });
  app.use(createProfileRoutes({ connection: redis, access, profileManager: pm, schedules: { overlaps: async () => [], unresolvedSchedules: async () => [], scheduledWorkflowIds: async () => new Set() } }));
  app.use(createBrowserRoutes());
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The OPERATOR's browser (where the viewer tab lives): headless is fine.
  operator = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await operator?.close().catch(() => {});
  if (pm) for (const [, e] of (pm as any).vipContexts || []) await closeContextBounded(e.context).catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (redis) { for (const k of await redis.keys('profile:*').catch(() => [] as string[])) await redis.del(k).catch(() => 0); redis.disconnect(); }
  (config as any).PROFILES_DIR = prev.profiles;
  (config as any).BRANCH_BASE_DIR = prev.base;
  (config as any).REAL_CHROME_EXTENSIONS_DIR = prev.ext;
  if (prev.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prev.display;
  wm?.kill(); xvfb?.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best-effort */ }
});

(toolsOk ? describeBrowser : (n: string, f: () => void) => describeBrowser(`${n} (SKIPPED: Xvfb/openbox/wmctrl missing)`, () => { it.skip('needs an X display', f as never); }))(
  'viewer self-close with real Chromium', () => {
    it('a. one profile closed from outside: the viewer tab (opened by script) closes itself within ~5 s', async () => {
      if (!redisUp) return;
      const p = await newOpenProfile('Solo');
      const { viewer } = await viewerByScript(p.id);
      expect(await viewer.evaluate(() => !!window.opener)).toBe(true);
      expect(await visibleTexts(viewer)).not.toMatch(/Chromium Session Closed|Close Tab|Relaunch|Turn on|Turn off/);
      await sleep(3000); // running normally: stays open
      expect(viewer.isClosed()).toBe(false);
      const t0 = Date.now();
      closeFromOutside(p.root);
      await waitSessions(0);
      await viewer.waitForEvent('close', { timeout: 8000 });
      const ms = Date.now() - t0;
      console.log(`[a] viewer closed itself ${ms} ms after the window was closed from outside`);
      expect(ms).toBeLessThan(6000);
    }, 60_000);

    it('b. two profiles, one closed from outside: viewer stays, the other remains, no dialog', async () => {
      if (!redisUp) return;
      const a = await newOpenProfile('Pair A');
      const b = await newOpenProfile('Pair B');
      const { opener, viewer } = await viewerByScript(a.id);
      // The second Open points the SAME named tab at profile B (set = [A, B]).
      await opener.evaluate((href) => { window.open(href, 'aria-browser-viewer'); }, `/desktop/chrome?profile=${encodeURIComponent(b.id)}&workflowId=wf_view`);
      await viewer.waitForURL((u) => u.search.includes(b.id));
      await viewer.waitForFunction(() => !(document.querySelector('#burger') as HTMLElement).hidden, null, { timeout: 15_000 });
      expect(await viewer.evaluate(() => JSON.parse(sessionStorage.getItem('aria.viewer.profiles') || '[]'))).toEqual([a.id, b.id]);
      closeFromOutside(a.root);
      await waitSessions(1);
      await sleep(6000);
      expect(viewer.isClosed()).toBe(false);
      expect(browserPidOn(b.root)).toBeGreaterThan(0);
      expect(browserPidOn(a.root)).toBe(0);
      const set = await viewer.evaluate(() => JSON.parse(sessionStorage.getItem('aria.viewer.profiles') || '[]'));
      expect(set).toEqual([b.id]); // the closed profile left the viewer's set
      expect(await viewer.evaluate(() => document.body.classList.contains('viewer-gone'))).toBe(false);
      expect(await visibleTexts(viewer)).not.toMatch(/Chromium Session Closed|Close Tab|Relaunch/);
      console.log(`[b] after closing "Pair A" from outside: viewer open=${!viewer.isClosed()}, set=${JSON.stringify(set)}, B pid=${browserPidOn(b.root)}`);
      // Clean up for the next cases: close B too and let the viewer end.
      closeFromOutside(b.root);
      await viewer.waitForEvent('close', { timeout: 8000 });
      await opener.context().close();
    }, 90_000);

    it('c. one failed probe, a false /browser/real/health and ONE false zero answer do NOT close the viewer', async () => {
      if (!redisUp) return;
      const p = await newOpenProfile('Flaky');
      const { opener, viewer } = await viewerByScript(p.id);
      let n = 0;
      const seen: string[] = [];
      await viewer.route('**/browser/sessions**', async (route) => {
        n++;
        if (n === 2) { seen.push('500'); return route.fulfill({ status: 500, body: 'boom' }); }
        if (n === 3) { seen.push('network-error'); return route.abort('failed'); }
        if (n === 4) { seen.push('zero'); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, sessions: [] }) }); }
        if (n === 5) { seen.push('malformed'); return route.fulfill({ contentType: 'application/json', body: '{"success":true}' }); }
        seen.push('real');
        return route.continue();
      });
      await viewer.route('**/browser/real/health**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, running: false, enabled: true }) }));
      await sleep(8000);
      console.log(`[c] probes: ${seen.slice(0, 8).join(', ')} … (${n} total); viewer open=${!viewer.isClosed()}`);
      expect(seen.slice(0, 5)).toEqual(['real', '500', 'network-error', 'zero', 'malformed']);
      expect(viewer.isClosed()).toBe(false);
      expect(await viewer.evaluate(() => document.body.classList.contains('viewer-gone'))).toBe(false);
      await viewer.unroute('**/browser/sessions**');
      closeFromOutside(p.root);
      await viewer.waitForEvent('close', { timeout: 8000 });
      await opener.context().close();
    }, 60_000);

    it('d. viewer opened by hand (address typed): close() is refused -> the tab goes to the app main page (owner, brief 2.2)', async () => {
      if (!redisUp) return;
      const p = await newOpenProfile('Manual');
      const ctx = await operator!.newContext();
      const viewer = await ctx.newPage(); // typed into the address bar: no opener
      await viewer.goto(`${base}/desktop/chrome?profile=${encodeURIComponent(p.id)}&workflowId=wf_view`);
      await viewer.waitForFunction(() => !(document.querySelector('#burger') as HTMLElement).hidden, null, { timeout: 15_000 });
      const t0 = Date.now();
      closeFromOutside(p.root);
      await waitSessions(0);
      await viewer.waitForURL((u) => u.pathname === '/', { timeout: 10_000 });
      const r = { url: new URL(viewer.url()).pathname, title: await viewer.title(), main: await viewer.locator('#app-main').count(), ms: Date.now() - t0 };
      console.log(`[d] typed-address viewer after the last browser closed: ${JSON.stringify(r)} closed=${viewer.isClosed()}`);
      expect(r.url).toBe('/');
      expect(r.main).toBe(1);
      await ctx.close();
    }, 60_000);

    it('g. REGRESSION (owner brief 2 / A): the viewer drawer\'s "Close browser" closes the PROFILE browser it shows, and the tab closes itself', async () => {
      if (!redisUp) return;
      const p = await newOpenProfile('FromInside');
      const { opener, viewer } = await viewerByScript(p.id);
      viewer.on('dialog', (d) => d.accept());
      const t0 = Date.now();
      await viewer.evaluate(() => (document.getElementById('dclosebrowser') as HTMLElement).click());
      await viewer.waitForEvent('close', { timeout: 10_000 });
      console.log(`[g] Close browser from inside the viewer: tab closed itself ${Date.now() - t0} ms later; profile process left: ${browserPidOn(p.root)}`);
      expect(browserPidOn(p.root)).toBe(0);
      await opener.context().close();
    }, 60_000);

    it('e. viewer opened by script with noopener (window.opener is null): closes itself', async () => {
      if (!redisUp) return;
      const p = await newOpenProfile('NoOpener');
      const ctx = await operator!.newContext();
      const opener = await ctx.newPage();
      await opener.goto(`${base}/blank`);
      const popupP = ctx.waitForEvent('page');
      await opener.evaluate((href) => { window.open(href, '_blank', 'noopener'); }, `/desktop/chrome?profile=${encodeURIComponent(p.id)}&workflowId=wf_view`);
      const viewer = await popupP;
      await viewer.waitForLoadState('domcontentloaded');
      await viewer.waitForFunction(() => !(document.querySelector('#burger') as HTMLElement).hidden, null, { timeout: 15_000 });
      expect(await viewer.evaluate(() => window.opener)).toBeNull();
      const t0 = Date.now();
      closeFromOutside(p.root);
      await waitSessions(0);
      await viewer.waitForEvent('close', { timeout: 8000 });
      console.log(`[e] noopener viewer closed itself ${Date.now() - t0} ms after the window was closed from outside`);
      await ctx.close();
    }, 60_000);

    it('f. viewer opened by script whose opener tab was closed: closes itself', async () => {
      if (!redisUp) return;
      const p = await newOpenProfile('OpenerGone');
      const { opener, viewer } = await viewerByScript(p.id);
      await opener.close();
      await sleep(300);
      const t0 = Date.now();
      closeFromOutside(p.root);
      await waitSessions(0);
      await viewer.waitForEvent('close', { timeout: 8000 });
      console.log(`[f] viewer whose opener was closed closed itself ${Date.now() - t0} ms after the window was closed from outside`);
      await viewer.context().close();
    }, 60_000);

    it('rendered DOM: no "Turn on", "Turn off", "Chromium Session Closed", "Close Tab", "Relaunch" in the viewer or the Browser Profiles panel', async () => {
      if (!redisUp) return;
      const ctx = await operator!.newContext({ viewport: { width: 1280, height: 800 } });
      // The viewer: every element's text, hidden ones included.
      const v = await ctx.newPage();
      await v.goto(`${base}/desktop/chrome?attach=1`);
      const viewerAll = await renderedText(v);
      // The Browser Profiles panel inside the Workflow Files drawer.
      const pg = await ctx.newPage();
      await pg.goto(`${base}/blank`);
      const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
      await pg.addStyleTag({ content: read('public/css/styles.css') });
      await pg.addScriptTag({ content: `window.AppUtil={t:function(k){return k},toast:function(){}};window.API={getKey:function(){return ''}};window.FlowEditor={getCurrentWorkflow:function(){return {id:'wf_view'}}};` });
      await pg.addScriptTag({ content: read('public/js/i18n.js') }).catch(() => {});
      await pg.addScriptTag({ content: read('public/js/profile-manager.js') });
      await pg.addScriptTag({ content: read('public/js/workflow-files.js') });
      await pg.evaluate(() => { const d = document.createElement('div'); d.id = 'stage'; d.style.cssText = 'position:relative;height:100vh'; document.body.appendChild(d); (window as any).WorkflowFiles.open({ host: d, browseOnly: true }); });
      await pg.waitForSelector('.pm-panel');
      await sleep(500);
      const panelAll = await renderedText(pg);
      for (const s of FORBIDDEN) {
        expect(viewerAll, `viewer contains "${s}"`).not.toContain(s);
        expect(panelAll, `panel contains "${s}"`).not.toContain(s);
      }
      expect(panelAll).toContain('Browser Profiles');
      console.log(`[dom] viewer ${viewerAll.length} chars, panel ${panelAll.length} chars: none of ${JSON.stringify(FORBIDDEN)}`);
      await ctx.close();
    }, 60_000);
  });
