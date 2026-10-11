// @vitest-environment jsdom
/**
 * The Live Run tab (public/live-view.html + live-view.js), redesigned per
 * docs/uiux/24-HANDOFF-live-run-redesign.md, driven in jsdom with a fake
 * EventSource and a fake fetch.
 *
 * Kept from Task 4b: share token only (no API key in any URL), view-only for a
 * share-link viewer, replay after reconnect never doubles anything, output is
 * text (no markup injection), an expired link stops retrying.
 * New: the planned step list, "Step N of M", address bar, execution log, the
 * OUTPUT / DETAILS panel, and owner-only Stop / Restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUB = join(__dirname, '..', '..', 'public');
const html = readFileSync(join(PUB, 'live-view.html'), 'utf8');

class FakeES {
  static all: FakeES[] = [];
  url: string; closed = false; listeners: Record<string, Array<(m: any) => void>> = {};
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((m: any) => void) | null = null;
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  addEventListener(n: string, fn: (m: any) => void) { (this.listeners[n] ||= []).push(fn); }
  close() { this.closed = true; }
  open() { this.onopen && this.onopen(); }
  msg(o: unknown) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
  named(n: string, o: unknown) { (this.listeners[n] || []).forEach((f) => f({ data: JSON.stringify(o) })); }
  fail() { this.onerror && this.onerror(); }
}
const events = () => FakeES.all.filter((e) => e.url.startsWith('/live/sse/')).slice(-1)[0];
const frames = () => FakeES.all.filter((e) => e.url.startsWith('/live/frames/')).slice(-1)[0];
const $ = (id: string) => document.getElementById(id) as HTMLElement;

type Call = { url: string; method: string; headers: Record<string, string> };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => { status: number; body: any }> = {};

function fakeFetch(url: string, init?: any) {
  const c: Call = { url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {} };
  calls.push(c);
  const key = Object.keys(routes).find((k) => url.startsWith(k.split(' ')[1]) && c.method === k.split(' ')[0]);
  const r = key ? routes[key](c) : { status: 404, body: {} };
  return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
}

const PLAN = {
  success: true, known: true, state: 'active', startedAt: null,
  workflow: { id: 'wf1', name: 'Product Scraper' },
  steps: [
    { action: 'launch', target: '' },
    { action: 'goto', target: 'https://www.amazon.com' },
    { action: 'click', target: '#add-to-cart-button' },
    { action: 'screenshot', target: '' },
  ],
};

function boot(path = '/live/view/local/job-1', search = '?share=TOK', opts: { owner?: boolean; plan?: any } = {}) {
  FakeES.all = []; calls = [];
  routes = {
    'GET /live/plan/': () => ({ status: 200, body: opts.plan === undefined ? PLAN : opts.plan }),
    'GET /me': () => (opts.owner ? { status: 200, body: { success: true } } : { status: 401, body: { error: 'auth' } }),
    'DELETE /cancel/': () => ({ status: 200, body: { success: true } }),
    'POST /live/restart/': () => ({ status: 200, body: { success: true, jobId: 'job-2', url: '/live/view/local/job-2?share=NEW' } }),
  };
  const bodyHtml = html.replace(/^[\s\S]*<body[^>]*>/i, '').replace(/<script[\s\S]*$/i, '');
  document.body.innerHTML = bodyHtml;
  const w = window as any;
  w.EventSource = FakeES as any;
  w.fetch = vi.fn(fakeFetch);
  history.replaceState({}, '', path + search);
  for (const f of ['icons.js', 'run-state.js', 'live-tab.js', 'live-view.js']) {
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(join(PUB, 'js', f), 'utf8')).call(w);
  }
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
const stepStart = (seq: number, index: number, action: string, top?: number) =>
  ({ type: 'step.start', seq, ts: ts(seq), jobId: 'job-1', data: { index, action, ...(top != null ? { top } : {}) } });
const stepDone = (seq: number, index: number, action: string, sample: unknown, durationMs = 450) =>
  ({ type: 'step.done', seq, ts: ts(seq), jobId: 'job-1', data: { index, action, success: true, durationMs, outputItemCount: 1, outputSample: sample } });
const rowsEls = () => [...document.querySelectorAll('#lv-steps .lr-step')] as HTMLElement[];
const toggle = (key: string) => (document.querySelector(`[data-toggle="${key}"]`) as HTMLElement).click();

describe('Live Run tab — streams and access', () => {
  it('opens both read-only streams with the SHARE token and never an api key', async () => {
    localStorage.setItem('ab_api_key', 'SECRET-KEY');
    boot(); await settle();
    expect(events().url).toBe('/live/sse/local/job-1?share=TOK');
    expect(frames().url).toBe('/live/frames/local/job-1?share=TOK');
    for (const e of FakeES.all) expect(e.url).not.toMatch(/api_key|apikey|SECRET/i);
    for (const c of calls) expect(c.url).not.toMatch(/api_key|SECRET/);
    expect(calls.some((c) => c.url === '/live/plan/local/job-1?share=TOK')).toBe(true);
  });

  it('is view-only for a share-link viewer: no form controls, no Stop / Restart', async () => {
    boot(); await settle();
    expect(document.querySelectorAll('input, textarea, select, form, [contenteditable]').length).toBe(0);
    expect(html).not.toMatch(/<script>(?!\s*<)|onclick=|javascript:/i); // CSP-safe
    expect($('lv-readonly').textContent).toMatch(/View only/i);
    expect(($('lr-actions') as any).hidden).toBe(true);
    expect(($('lr-stop') as HTMLButtonElement).disabled).toBe(true);
    expect(readFileSync(join(PUB, 'css', 'styles.css'), 'utf8')).toMatch(/\.lv-frame\s*\{[^}]*pointer-events:\s*none/);
  });

  it('the owner gets Stop and Restart; the key goes in a HEADER, never the URL', async () => {
    localStorage.setItem('ab_api_key', 'SECRET-KEY');
    boot(undefined, undefined, { owner: true }); await settle();
    events().open(); events().msg({ type: 'job.start', seq: 1, ts: ts(0), jobId: 'job-1', data: { profile: 'Default Profile' } });
    expect(($('lr-actions') as any).hidden).toBe(false);
    expect(($('lr-stop') as HTMLButtonElement).disabled).toBe(false);
    $('lr-stop').click(); await settle();
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toBe('/cancel/local/job-1');
    expect(del.headers['x-api-key']).toBe('SECRET-KEY');
    expect(del.url).not.toMatch(/SECRET/);
  });

  it('Restart asks the server and moves this tab to the NEW run', async () => {
    boot(undefined, undefined, { owner: true }); await settle();
    const replace = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'location')!;
    Object.defineProperty(window, 'location', { value: { ...window.location, replace, pathname: location.pathname, search: location.search }, configurable: true });
    try {
      $('lr-restart').click(); await settle();
      expect(calls.find((c) => c.method === 'POST')!.url).toBe('/live/restart/local/job-1');
      expect(replace).toHaveBeenCalledWith('/live/view/local/job-2?share=NEW');
    } finally {
      Object.defineProperty(window, 'location', original);
    }
  });
});

describe('Live Run tab — the step list', () => {
  it('draws the whole PLAN before anything runs: Execution steps (4), all waiting', async () => {
    boot(); await settle(); events().open();
    expect($('lv-steps-title').textContent).toBe('Execution steps (4)');
    expect(rowsEls().map((r) => r.className)).toEqual(Array(4).fill('lr-step is-pending'));
    expect(rowsEls()[3].textContent).toMatch(/Screenshot.*Waiting to capture the page/);
    expect($('lr-workflow').textContent).toBe('Product Scraper');
  });

  it('fills the plan as steps run: status strip, current step, durations, profile', async () => {
    boot(); await settle(); events().open();
    events().msg({ type: 'job.start', seq: 1, ts: ts(0), jobId: 'job-1', data: { profile: 'Default Profile', visibility: 'visible' } });
    events().msg(stepStart(2, 1, 'launch', 0));
    events().msg(stepDone(3, 1, 'launch', { status: 'success', browser: 'Chrome' }, 450));
    events().msg(stepStart(4, 2, 'goto', 1));
    events().msg(stepDone(5, 2, 'goto', { url: 'https://www.amazon.com' }, 1280));
    events().msg(stepStart(6, 3, 'click', 2));
    expect($('lv-status-text').textContent).toBe('Running');
    expect($('lr-progress').textContent).toBe('Step 3 of 4');
    expect($('lr-current').textContent).toBe('Click Element \u00b7 #add-to-cart-button');
    expect($('lr-profile').textContent).toBe('Default Profile');
    const r = rowsEls();
    expect(r.map((x) => x.className.match(/is-(pending|running|success|error)/)![1])).toEqual(['success', 'success', 'running', 'pending']);
    expect(r[0].querySelector('.lr-step-dur')!.textContent).toBe('0.45s');
    expect(r[1].querySelector('.lr-step-sub')!.textContent).toBe('Opened https://www.amazon.com');
    expect(r[2].querySelector('.lr-step-sub')!.textContent).toBe('Clicking #add-to-cart-button');
    expect(r[2].getAttribute('aria-current')).toBe('step');
  });

  it('follows the newest finished step; a click pins another; Follow latest releases it', async () => {
    boot(); await settle(); events().open();
    events().msg(stepStart(1, 1, 'launch', 0));
    events().msg(stepDone(2, 1, 'launch', { status: 'success' }));
    events().msg(stepStart(3, 2, 'goto', 1));
    events().msg(stepDone(4, 2, 'goto', { url: 'https://a.test' }));
    expect($('lv-output').textContent).toContain('https://a.test');   // follows

    toggle('i1');
    expect($('lv-output').textContent).toContain('"success"');
    expect($('lv-output').textContent).not.toContain('https://a.test');
    events().msg(stepStart(5, 3, 'click', 2));
    events().msg(stepDone(6, 3, 'click', { clicked: '#go' }));
    expect($('lv-output').textContent).toContain('"success"');         // pinned stays

    ($('lv-follow') as HTMLElement).click();
    expect($('lv-output').textContent).toContain('#go');
    expect(($('lv-follow') as any).hidden).toBe(true);
  });

  it('OUTPUT is coloured JSON built from text; DETAILS lists the step facts', async () => {
    boot(); await settle(); events().open();
    events().msg(stepStart(1, 1, 'launch', 0));
    events().msg(stepDone(2, 1, 'launch', { status: 'success', n: 2 }, 450));
    const pre = $('lv-output');
    expect(pre.querySelector('.j-key')!.textContent).toBe('"status"');
    expect(pre.querySelector('.j-str')!.textContent).toBe('"success"');
    expect(pre.querySelector('.j-num')!.textContent).toBe('2');
    (document.querySelector('[data-tab="details"]') as HTMLElement).click();
    const dl = document.querySelector('.lr-details')!.textContent!;
    expect(dl).toMatch(/Launch Browser \(launch\)/);
    expect(dl).toMatch(/Succeeded/);
    expect(dl).toMatch(/0\.45s/);
  });

  it('output is rendered as TEXT (a hostile sample cannot inject markup)', async () => {
    boot(); await settle(); events().open();
    events().msg(stepStart(1, 1, 'extract', 0));
    events().msg(stepDone(2, 1, 'extract', { x: '<img src=x onerror=alert(1)>' }));
    expect($('lv-output').querySelector('img')).toBeNull();
    expect($('lv-output').textContent).toContain('<img src=x');
  });

  it('without a plan (older server / evicted job) the rows are the live steps', async () => {
    boot(undefined, undefined, { plan: { success: true, known: false, steps: [], workflow: null } }); await settle(); events().open();
    events().msg(stepStart(1, 1, 'goto'));
    events().msg(stepStart(2, 2, 'click'));
    expect(rowsEls().length).toBe(2);
    expect($('lv-steps-title').textContent).toBe('Execution steps (2)');
  });

  it('steps that never ran are marked "Did not run" when the run ends', async () => {
    boot(); await settle(); events().open();
    events().msg(stepStart(1, 1, 'launch', 0));
    events().msg({ type: 'job.error', seq: 2, ts: ts(2), jobId: 'job-1', data: { message: 'boom' } });
    expect($('lv-status-text').textContent).toBe('Failed');
    expect(rowsEls()[3].className).toContain('is-skipped');
  });
});

describe('Live Run tab — status, log, browser', () => {
  it('a reconnect that replays the buffer does not double anything (steps or log)', async () => {
    boot(); await settle(); events().open();
    const evs = [stepStart(1, 1, 'launch', 0), stepDone(2, 1, 'launch', { a: 1 })];
    evs.forEach((e) => events().msg(e));
    const logCount = document.querySelectorAll('.lr-log-line').length;
    events().fail();
    expect($('lv-status-text').textContent).toMatch(/Reconnecting/);
    vi.advanceTimersByTime(600);
    expect(FakeES.all.filter((e) => e.url.startsWith('/live/sse/')).length).toBe(2);
    events().open();
    evs.forEach((e) => events().msg(e));   // server replays its buffer
    expect(document.querySelectorAll('.lr-log-line').length).toBe(logCount);
    events().msg(stepStart(3, 2, 'goto', 1));
    expect(rowsEls().filter((r) => !r.className.includes('is-pending')).length).toBe(2);
  });

  it('the execution log shows one line per event with server time and step number; filter and clear work', async () => {
    boot(); await settle(); events().open();
    events().msg(stepStart(1, 1, 'launch', 0));
    events().msg(stepDone(2, 1, 'launch', {}));
    events().msg({ type: 'log', seq: 3, ts: ts(3), jobId: 'job-1', data: { message: '[BROWSER] something failed' } });
    const lines = [...document.querySelectorAll('.lr-log-line')];
    expect(lines.length).toBe(3);
    expect(lines[0].textContent).toMatch(/Launch Browser started/);
    expect(lines[0].querySelector('.lr-log-step')!.textContent).toBe('Step 01');
    expect(lines[1].className).toContain('is-success');
    expect(lines[2].className).toContain('is-error');

    $('lr-tab-log').click();
    $('lr-filter').click();
    (document.querySelector('[data-filter="errors"]') as HTMLElement).click();
    expect(document.querySelectorAll('.lr-log-line').length).toBe(1);
    expect($('lr-filter').textContent).toMatch(/Errors/);

    (document.querySelector('#lr-filter') as HTMLElement).click();
    (document.querySelector('[data-filter="all"]') as HTMLElement).click();
    $('lr-clear').click();
    expect(document.querySelectorAll('.lr-log-line').length).toBe(0);
    events().msg(stepStart(4, 2, 'goto', 1));
    expect(document.querySelectorAll('.lr-log-line').length).toBe(1); // new events still arrive
  });

  it('the log is a TAB of the side card (not a panel under the browser); it starts hidden', async () => {
    boot(); await settle(); events().open();
    expect(($('lr-log') as any).hidden).toBe(true);
    expect(($('lv-steps') as any).hidden).toBe(false);
    expect($('lr-stage').contains($('lr-log'))).toBe(false);          // nothing under the browser
    $('lr-tab-log').click();
    expect(($('lr-log') as any).hidden).toBe(false);
    expect(($('lv-steps') as any).hidden).toBe(true);
    expect($('lr-tab-log').getAttribute('aria-selected')).toBe('true');
    $('lr-tab-steps').click();
    expect(($('lv-steps') as any).hidden).toBe(false);
  });

  it('the Log tab badge counts NEW errors/warnings and clears once the log is opened', async () => {
    boot(); await settle(); events().open();
    expect(($('lr-log-count') as any).hidden).toBe(true);
    events().msg(stepStart(1, 1, 'click', 0));
    events().msg({ type: 'step.retry', seq: 2, ts: ts(2), jobId: 'job-1', data: { index: 1, action: 'click', attempt: 1, maxTries: 3 } });
    expect(($('lr-log-count') as any).hidden).toBe(false);
    expect($('lr-log-count').textContent).toBe('1');
    expect($('lr-log-count').className).toContain('is-warn');
    events().msg({ type: 'step.error', seq: 3, ts: ts(3), jobId: 'job-1', data: { index: 1, action: 'click', error: 'Timeout' } });
    expect($('lr-log-count').textContent).toBe('2');
    expect($('lr-log-count').className).toContain('is-error');
    $('lr-tab-log').click();
    expect(($('lr-log-count') as any).hidden).toBe(true);
    $('lr-tab-steps').click();
    expect(($('lr-log-count') as any).hidden).toBe(true);             // already seen
  });

  it('the browser window takes the page\'s real proportions from the frame size', async () => {
    boot(); await settle(); events().open();
    frames().named('status', { status: 'live' });
    frames().named('frame', { data: 'QUJD', width: 1280, height: 800, ts: 1 });
    expect($('lr-window').style.getPropertyValue('--lr-ar')).toBe('1.6');
    expect($('lr-size').textContent).toBe('1280 \u00d7 800');
    frames().named('frame', { data: 'QUJD', width: 1000, height: 1000, ts: 2 });
    expect($('lr-window').style.getPropertyValue('--lr-ar')).toBe('1');
  });

  it('long step lines keep their full text as a tooltip', async () => {
    boot(); await settle(); events().open();
    const sub = rowsEls()[2].querySelector('.lr-step-sub') as HTMLElement;
    expect(sub.title).toBe(sub.textContent);
  });

  it('elapsed time comes from the server timestamps, not the tab clock', async () => {
    boot(); await settle(); events().open();
    events().msg({ type: 'job.start', seq: 1, ts: ts(0), jobId: 'job-1', data: {} });
    events().msg({ type: 'job.done', seq: 2, ts: ts(24), jobId: 'job-1', data: { durationMs: 24000 } });
    expect($('lr-elapsed').textContent).toBe('00:00:24');
    expect($('lv-status-text').textContent).toBe('Completed');
  });

  it('draws frames, shows the page address (no query), keeps the last picture after the run', async () => {
    boot(); await settle(); events().open();
    expect($('lv-browser-msg').textContent).toMatch(/Waiting for the browser/);
    frames().named('status', { status: 'live' });
    frames().named('frame', { data: 'QUJD', width: 800, height: 600, ts: 1, url: 'https://www.amazon.com/dp/B0' });
    const img = $('lv-frame') as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,QUJD');
    expect(img.hidden).toBe(false);
    expect($('lv-browser-msg').hidden).toBe(true);
    expect($('lr-url').textContent).toBe('https://www.amazon.com/dp/B0');
    frames().named('status', { status: 'ended' });
    events().msg({ type: 'job.done', seq: 1, jobId: 'job-1', data: {} });
    expect(img.hidden).toBe(false);
  });

  it('explains when the browser view is full', async () => {
    boot(); await settle(); events().open();
    frames().named('status', { status: 'busy' });
    expect($('lv-browser-msg').textContent).toMatch(/Too many people/);
  });

  it('an invalid/expired link (stream never opens) becomes a clear message, not an endless retry', async () => {
    boot(); await settle();
    for (let i = 0; i < 3; i++) { events().fail(); vi.advanceTimersByTime(20000); }
    expect($('lv-status-text').textContent).toMatch(/invalid or has expired/);
    const n = FakeES.all.length;
    vi.advanceTimersByTime(60000);
    expect(FakeES.all.length).toBe(n);
  });

  it('an address without a share token opens nothing and says so', () => {
    boot('/live/view/local/job-1', '');
    expect(FakeES.all.length).toBe(0);
    expect($('lv-error').hidden).toBe(false);
  });

  it('stays English LTR even if a stale `ab_lang = fa` is stored', async () => {
    localStorage.setItem('ab_lang', 'fa');
    boot(); await settle();
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.body.textContent).not.toMatch(/[\u0600-\u06FF]/);
  });
});

describe('Live Run tab — leaves nothing behind when its page is replaced', () => {
  // CI regression (PR #75): every test file shares ONE jsdom document (pool:
  // forks, singleFork). The page put click/keydown listeners on `document`
  // that looked `#lr-filter-list` up by id, so after the next file swapped the
  // body, every click there threw "Cannot read properties of null (reading
  // 'hidden')" — 184 unhandled errors in browser-options-ui.test.ts.
  it('a click or Escape on a different page after this one is gone throws nothing', async () => {
    boot(); await settle();
    document.body.innerHTML = '<button id="other">another page</button>';
    const errors: unknown[] = [];
    const onErr = (e: ErrorEvent) => { errors.push(e.error || e.message); e.preventDefault(); };
    window.addEventListener('error', onErr);
    try {
      (document.getElementById('other') as HTMLElement).click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      (document.getElementById('other') as HTMLElement).click();
      vi.advanceTimersByTime(3000);      // the elapsed clock must not draw into the new page either
    } finally {
      window.removeEventListener('error', onErr);
    }
    expect(errors).toEqual([]);
  });

  it('the filter menu still closes on an outside click while the page is up', async () => {
    boot(); await settle(); events().open();
    $('lr-tab-log').click();
    $('lr-filter').click();
    expect(($('lr-filter-list') as any).hidden).toBe(false);
    document.body.click();
    expect(($('lr-filter-list') as any).hidden).toBe(true);
    $('lr-filter').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(($('lr-filter-list') as any).hidden).toBe(true);
  });
});
