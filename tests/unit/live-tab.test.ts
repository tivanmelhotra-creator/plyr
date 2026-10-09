/**
 * live-tab.test.ts — Task 4b
 *
 * public/js/live-tab.js is the DOM-free decision logic behind "Test Workflow
 * opens a live tab". The rule that matters most: window.open runs
 * SYNCHRONOUSLY in the click, before anything that returns a promise (a popup
 * opened after an await is eaten by the blocker). The second rule: no API key
 * ever lands in a URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

let LT: any;
let RS: any;

function load(file: string, sandbox: any): void {
  const src = readFileSync(join(__dirname, '../../public/js', file), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: file });
}

beforeAll(() => {
  const win: any = {};
  const sandbox: any = { window: win, console, Date, JSON, Math, Object, Array, Number, String, Set, Promise, encodeURIComponent, decodeURIComponent, setTimeout };
  sandbox.module = { exports: {} };
  load('run-state.js', sandbox);
  RS = win.RunState;
  const sb2: any = { window: win, console, Date, JSON, Math, Object, Array, Number, String, Set, Promise, encodeURIComponent, decodeURIComponent, setTimeout, module: { exports: {} } };
  load('live-tab.js', sb2);
  LT = win.LiveTab;
});

const launchStep = (opts?: unknown) => ({ action: 'launch', params: opts === undefined ? {} : { browserOptions: opts } });

function fakeWin(opts: { block?: boolean; log?: string[] } = {}) {
  const log = opts.log ?? [];
  const handle: any = {
    closed: false, opener: 'x',
    document: { title: '', body: { textContent: '' } },
    location: { replace: (u: string) => { log.push('replace:' + u); handle.url = u; } },
    close: () => { handle.closed = true; log.push('close'); },
  };
  const win = { open: (u: string, t: string) => { log.push('open:' + u + ':' + t); return opts.block ? null : handle; } };
  return { win, handle, log };
}

describe('wantsLiveTab — when does a Test Run open a tab', () => {
  it('Test Run + visible browser (run switch) opens one', () => {
    expect(LT.wantsLiveTab({ isTestRun: true, runHeadless: false, steps: [launchStep()] })).toBe(true);
  });
  it('a headless Test Run opens nothing', () => {
    expect(LT.wantsLiveTab({ isTestRun: true, runHeadless: true, steps: [launchStep()] })).toBe(false);
  });
  it('a saved/other run (not a Test Run) opens nothing even if visible', () => {
    expect(LT.wantsLiveTab({ isTestRun: false, runHeadless: false, steps: [launchStep()] })).toBe(false);
  });
  it('the Launch node own `headless:false` option wins over a headless run switch', () => {
    expect(LT.wantsLiveTab({ isTestRun: true, runHeadless: true, steps: [launchStep({ headless: false })] })).toBe(true);
  });
  it('the Launch node own `headless:true` option wins over a visible run switch', () => {
    expect(LT.wantsLiveTab({ isTestRun: true, runHeadless: false, steps: [launchStep({ headless: true })] })).toBe(false);
  });
  it('options may be a JSON string (as the editor stores them)', () => {
    expect(LT.wantsLiveTab({ isTestRun: true, runHeadless: true, steps: [launchStep('{"headless":false}')] })).toBe(true);
  });
  it('garbage options are ignored, not thrown on', () => {
    expect(LT.wantsLiveTab({ isTestRun: true, runHeadless: false, steps: [launchStep('{nope')] })).toBe(true);
  });
  it('finds a Launch node nested in branches, loops, routers and switch cases', () => {
    const nested = [{ action: 'if', then: [{ action: 'loop', steps: [launchStep({ headless: false })] }] }];
    expect(LT.launchOptionsOf(nested)).toEqual({ headless: false });
    expect(LT.launchOptionsOf([{ action: 'router', paths: [{ steps: [launchStep({ headless: false })] }] }])).toEqual({ headless: false });
    expect(LT.launchOptionsOf([{ action: 'switch', cases: { a: [launchStep({ headless: false })] } }])).toEqual({ headless: false });
    expect(LT.launchOptionsOf([{ action: 'router', fallback: [launchStep({ headless: false })] }])).toEqual({ headless: false });
  });
  it('missing arguments never throw', () => {
    expect(LT.wantsLiveTab()).toBe(false);
    expect(LT.wantsLiveTab({ isTestRun: true })).toBe(false);
  });
});

describe('launch — the popup-blocker contract', () => {
  it('calls win.open BEFORE start() (synchronously in the click)', () => {
    const f = fakeWin();
    const order: string[] = [];
    const win = { open: (u: string, t: string) => { order.push('open'); return f.win.open(u, t); } };
    LT.launch({
      win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => { order.push('start'); return Promise.resolve({ jobId: 'j1' }); },
      share: () => Promise.resolve({ token: 't' }), labels: {},
    });
    // start() is deferred to a microtask: at the moment launch() returns only open ran.
    expect(order).toEqual(['open']);
  });

  it('opens a blank tab, cuts the opener, then navigates to the SHARE url', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'local',
      start: () => Promise.resolve({ jobId: 'job 1' }),
      share: (u: string, j: string) => { expect([u, j]).toEqual(['local', 'job 1']); return Promise.resolve({ token: 'tok/+=' }); },
      labels: { title: 'T', loading: 'Loading' },
    });
    expect(r.opened).toBe(true);
    expect(f.handle.opener).toBeNull();
    expect(f.handle.document.title).toBe('T');
    expect(f.handle.document.body.textContent).toBe('Loading');
    const tab = await r.tab;
    expect(tab.status).toBe('navigated');
    expect(f.handle.url).toBe('/live/view/local/job%201?share=tok%2F%2B%3D');
    expect(tab.url).toBe(f.handle.url);
  });

  it('never puts an API key in the URL', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({ jobId: 'j' }), share: () => Promise.resolve({ token: 'tok' }), labels: {},
    });
    const tab = await r.tab;
    expect(tab.url).not.toMatch(/api_key|apikey|x-api-key/i);
    expect(tab.url).toContain('share=');
  });

  it('a headless / non-test run opens no tab and does not even call share()', async () => {
    const f = fakeWin();
    let shared = 0;
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: true, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({ jobId: 'j' }), share: () => { shared++; return Promise.resolve({ token: 't' }); }, labels: {},
    });
    expect(r.opened).toBe(false);
    expect((await r.tab).status).toBe('not-wanted');
    expect(f.log).toEqual([]);
    expect(shared).toBe(0);
    expect((await r.run).jobId).toBe('j');
  });

  it('a blocked popup is reported with a plain url the user can click', async () => {
    const f = fakeWin({ block: true });
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({ jobId: 'j' }), share: () => Promise.resolve({ token: 'tok' }), labels: {},
    });
    expect(r.opened).toBe(false);
    expect(r.blocked).toBe(true);
    const tab = await r.tab;
    expect(tab.status).toBe('blocked');
    expect(tab.url).toBe('/live/view/u/j?share=tok');
  });

  it('a win.open that throws counts as blocked', async () => {
    const r = LT.launch({
      win: { open: () => { throw new Error('nope'); } }, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({ jobId: 'j' }), share: () => Promise.resolve({ token: 'tok' }), labels: {},
    });
    expect(r.blocked).toBe(true);
    expect((await r.tab).status).toBe('blocked');
  });

  it('closes the empty tab when the run is refused', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.reject(new Error('quota')), share: () => Promise.resolve({ token: 't' }), labels: {},
    });
    await expect(r.run).rejects.toThrow('quota');
    expect((await r.tab).status).toBe('run-failed');
    expect(f.handle.closed).toBe(true);
  });

  it('closes the tab when the run returns no job id', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({}), share: () => Promise.resolve({ token: 't' }), labels: {},
    });
    expect((await r.tab).status).toBe('run-failed');
    expect(f.handle.closed).toBe(true);
  });

  it('share failure leaves a readable message in the tab and reports it', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({ jobId: 'j' }), share: () => Promise.reject(new Error('503')), labels: { failed: 'Failed:' },
    });
    const tab = await r.tab;
    expect(tab.status).toBe('share-failed');
    expect(tab.error).toBe('503');
    expect(f.handle.document.body.textContent).toBe('Failed: 503');
  });

  it('an empty share token is a share failure, not a broken url', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => Promise.resolve({ jobId: 'j' }), share: () => Promise.resolve({}), labels: {},
    });
    expect((await r.tab).status).toBe('share-failed');
  });

  it('a tab the user closed meanwhile is not navigated', async () => {
    const f = fakeWin();
    const r = LT.launch({
      win: f.win, isTestRun: true, runHeadless: false, steps: [launchStep()], userId: 'u',
      start: () => { f.handle.closed = true; return Promise.resolve({ jobId: 'j' }); },
      share: () => Promise.resolve({ token: 't' }), labels: {},
    });
    const tab = await r.tab;
    expect(tab.status).toBe('closed');
    expect(f.log.some(l => l.startsWith('replace:'))).toBe(false);
  });
});

describe('addresses', () => {
  it('builds and parses the view location round-trip', () => {
    const p = LT.viewPath('us er', 'job/1', 'a+b');
    const [path, search] = p.split('?');
    expect(LT.parseViewLocation(path, '?' + search)).toEqual({ userId: 'us er', jobId: 'job/1', share: 'a+b' });
  });
  it('parse tolerates junk', () => {
    expect(LT.parseViewLocation('/nope', '')).toEqual({ userId: '', jobId: '', share: '' });
    expect(LT.parseViewLocation('/live/view/%E0%A4%A/j', '?share=%E0%A4%A').share).toBe('');
  });
  it('events and frames paths carry the same share token and no api key', () => {
    expect(LT.eventsPath('u', 'j', 't')).toBe('/live/sse/u/j?share=t');
    expect(LT.framesPath('u', 'j', 't')).toBe('/live/frames/u/j?share=t');
  });
});

describe('createFeed — replay de-duplication', () => {
  const ev = (type: string, seq?: number, data: any = {}) => ({ type, seq, data });
  it('ignores an event it already applied (replay after reconnect)', () => {
    const feed = LT.createFeed(RS);
    expect(feed.push(ev('step.start', 1, { index: 1, action: 'click' }))).toBe(true);
    expect(feed.push(ev('step.start', 1, { index: 1, action: 'click' }))).toBe(false);
    expect(feed.state.order).toEqual([1]);
  });
  it('tolerates out-of-order seq (a Set, not a high-water mark)', () => {
    const feed = LT.createFeed(RS);
    expect(feed.push(ev('step.start', 5, { index: 2, action: 'a' }))).toBe(true);
    expect(feed.push(ev('step.start', 4, { index: 1, action: 'b' }))).toBe(true);
    expect(feed.push(ev('step.start', 4, { index: 1, action: 'b' }))).toBe(false);
  });
  it('applies events without a seq every time', () => {
    const feed = LT.createFeed(RS);
    expect(feed.push(ev('step.start', undefined, { index: 1, action: 'a' }))).toBe(true);
    expect(feed.push(ev('step.start', undefined, { index: 1, action: 'a' }))).toBe(true);
  });
  it('rejects junk and bounds its memory', () => {
    const feed = LT.createFeed(RS, 3);
    expect(feed.push(null)).toBe(false);
    expect(feed.push({})).toBe(false);
    for (let i = 1; i <= 5; i++) feed.push(ev('step.start', i, { index: i, action: 'a' }));
    // seq 1 was evicted from the window, so it would be re-applied; seq 5 is still known
    expect(feed.push(ev('step.start', 5, { index: 5, action: 'a' }))).toBe(false);
    expect(feed.push(ev('step.start', 1, { index: 1, action: 'a' }))).toBe(true);
  });
  it('replace() starts clean', () => {
    const feed = LT.createFeed(RS);
    feed.push(ev('step.start', 1, { index: 1, action: 'a' }));
    feed.replace();
    expect(feed.state.order).toEqual([]);
    expect(feed.push(ev('step.start', 1, { index: 1, action: 'a' }))).toBe(true);
  });
});

describe('reconnect backoff', () => {
  it('doubles from 0.5s and is capped, never zero', () => {
    expect([0, 1, 2, 3].map(LT.backoffMs)).toEqual([500, 1000, 2000, 4000]);
    expect(LT.backoffMs(50)).toBe(15000);
    expect(LT.backoffMs(-3)).toBe(500);
    expect(LT.backoffMs(NaN)).toBe(500);
  });
});

describe('timeline + step output', () => {
  function stateWith() {
    const feed = LT.createFeed(RS);
    feed.push({ type: 'step.start', seq: 1, data: { index: 1, action: 'goto' } });
    feed.push({ type: 'step.done', seq: 2, data: { index: 1, action: 'goto', success: true, durationMs: 12, outputItemCount: 1, outputSample: [{ a: 1 }] } });
    feed.push({ type: 'step.start', seq: 3, data: { index: 2, action: 'click' } });
    return feed.state;
  }
  it('rows are in step order with status', () => {
    const rows = LT.rows(stateWith());
    expect(rows.map((r: any) => [r.index, r.action, r.status])).toEqual([[1, 'goto', 'success'], [2, 'click', 'running']]);
    expect(LT.rows(null)).toEqual([]);
  });
  it('follows the newest step unless the user pinned one', () => {
    const s = stateWith();
    expect(LT.pickSelected(s, null)).toBe(2);
    expect(LT.pickSelected(s, 1)).toBe(1);
    expect(LT.pickSelected(s, 99)).toBe(2); // pinned step does not exist (yet): follow
    expect(LT.pickSelected(LT.createFeed(RS).state, null)).toBeNull();
  });
  it('clicking a step shows ITS output', () => {
    const d = LT.stepDetail(stateWith(), 1);
    expect(d.action).toBe('goto');
    expect(JSON.parse(d.outputText)).toEqual([{ a: 1 }]);
    expect(LT.stepDetail(stateWith(), 2).outputText).toBe('');
    expect(LT.stepDetail(stateWith(), 77)).toBeNull();
  });
  it('never throws on an unserialisable sample', () => {
    const s = stateWith();
    const cyc: any = {}; cyc.self = cyc;
    s.steps['1'].outputSample = cyc;
    expect(() => LT.stepDetail(s, 1)).not.toThrow();
  });
});

describe('paneMessage — what the browser pane says', () => {
  it('maps frame status and run phase to a translation key', () => {
    expect(LT.paneMessage('busy', 'running', false)).toBe('lv.busy');
    expect(LT.paneMessage('error', 'running', false)).toBe('lv.frameError');
    expect(LT.paneMessage('live', 'running', true)).toBeNull();
    expect(LT.paneMessage('waiting', 'running', false)).toBe('lv.waitingBrowser');
    expect(LT.paneMessage('waiting', 'done', false)).toBe('lv.noBrowser');
    expect(LT.paneMessage('ended', 'done', true)).toBeNull(); // last picture stays
  });
});
