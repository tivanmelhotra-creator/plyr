// @vitest-environment jsdom
/**
 * Task 4b — the standalone live page (public/live-view.html + live-view.js),
 * driven in jsdom with a fake EventSource: timeline, click-a-step -> its
 * output, follow/pin, replay after reconnect (no doubled events), a bad link,
 * and "view only" (no input controls, no API key anywhere).
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

function boot(path = '/live/view/local/job-1', search = '?share=TOK') {
  FakeES.all = [];
  const bodyHtml = html.replace(/^[\s\S]*<body[^>]*>/i, '').replace(/<script[\s\S]*$/i, '');
  document.body.innerHTML = bodyHtml;
  const w = window as any;
  w.EventSource = FakeES as any;
  history.replaceState({}, '', path + search);
  for (const f of ['icons.js', 'run-state.js', 'live-tab.js', 'live-view.js']) {
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(join(PUB, 'js', f), 'utf8')).call(w);
  }
}

beforeEach(() => { vi.useFakeTimers(); localStorage.setItem('ab_lang', 'en'); });
afterEach(() => { vi.useRealTimers(); });

const stepStart = (seq: number, index: number, action: string) => ({ type: 'step.start', seq, jobId: 'job-1', data: { index, action } });
const stepDone = (seq: number, index: number, action: string, sample: unknown) =>
  ({ type: 'step.done', seq, jobId: 'job-1', data: { index, action, success: true, durationMs: 30, outputItemCount: 1, outputSample: sample } });

describe('live view page', () => {
  it('opens both read-only streams with the SHARE token and never an api key', () => {
    boot();
    expect(events().url).toBe('/live/sse/local/job-1?share=TOK');
    expect(frames().url).toBe('/live/frames/local/job-1?share=TOK');
    for (const e of FakeES.all) expect(e.url).not.toMatch(/api_key|apikey/i);
  });

  it('is view-only: no input, textarea, select or form on the page; the frame image ignores the pointer', () => {
    boot();
    expect(document.querySelectorAll('input, textarea, select, form, [contenteditable]').length).toBe(0);
    expect(html).not.toMatch(/<script>(?!\s*<)|onclick=|javascript:/i); // CSP-safe: no inline script / handler
    expect($('lv-readonly').textContent).toMatch(/View only/i);
    expect(readFileSync(join(PUB, 'css', 'styles.css'), 'utf8')).toMatch(/\.lv-frame\s*\{[^}]*pointer-events:\s*none/);
  });

  it('shows a timeline that fills as steps arrive and follows the newest step', () => {
    boot(); events().open();
    expect($('lv-steps').textContent).toMatch(/Waiting for the first step/);
    events().msg(stepStart(1, 1, 'goto'));
    events().msg(stepDone(2, 1, 'goto', { url: 'https://a.test' }));
    events().msg(stepStart(3, 2, 'click'));
    const items = document.querySelectorAll('#lv-steps [data-step]');
    expect(items.length).toBe(2);
    expect(items[1].getAttribute('aria-current')).toBe('true'); // follows newest
    expect($('lv-output-head').textContent).toMatch(/click/);
  });

  it('clicking a step shows ITS output and pins it; Follow latest unpins', () => {
    boot(); events().open();
    events().msg(stepStart(1, 1, 'goto'));
    events().msg(stepDone(2, 1, 'goto', { url: 'https://a.test' }));
    events().msg(stepStart(3, 2, 'click'));
    events().msg(stepDone(4, 2, 'click', { clicked: '#go' }));

    (document.querySelector('[data-step="1"]') as HTMLElement).click();
    expect($('lv-output').textContent).toContain('https://a.test');
    expect($('lv-output').textContent).not.toContain('#go');

    // a newer step arrives: the pinned one stays on screen
    events().msg(stepStart(5, 3, 'type'));
    expect($('lv-output').textContent).toContain('https://a.test');

    ($('lv-follow') as HTMLElement).click();
    expect(document.querySelector('[data-step="3"]')!.getAttribute('aria-current')).toBe('true');
    expect(document.getElementById('lv-follow')).toBeNull();
  });

  it('output is rendered as TEXT (a hostile sample cannot inject markup)', () => {
    boot(); events().open();
    events().msg(stepStart(1, 1, 'extract'));
    events().msg(stepDone(2, 1, 'extract', { x: '<img src=x onerror=alert(1)>' }));
    expect($('lv-output').querySelector('img')).toBeNull();
    expect($('lv-output').textContent).toContain('<img src=x');
  });

  it('a reconnect that replays the buffer does not double anything', () => {
    boot(); events().open();
    const evs = [stepStart(1, 1, 'goto'), stepDone(2, 1, 'goto', { a: 1 })];
    evs.forEach((e) => events().msg(e));
    events().fail();                       // connection drops
    expect($('lv-status-text').textContent).toMatch(/Reconnecting/);
    vi.advanceTimersByTime(600);           // backoff elapses -> new EventSource
    expect(FakeES.all.filter((e) => e.url.startsWith('/live/sse/')).length).toBe(2);
    events().open();
    evs.forEach((e) => events().msg(e));   // server replays its buffer
    events().msg(stepStart(3, 2, 'click'));
    expect(document.querySelectorAll('#lv-steps [data-step]').length).toBe(2);
    expect($('lv-status-text').textContent).toMatch(/Running|Connected/);
  });

  it('shows the outcome when the run finishes', () => {
    boot(); events().open();
    events().msg(stepStart(1, 1, 'goto'));
    events().msg(stepDone(2, 1, 'goto', {}));
    events().msg({ type: 'job.done', seq: 3, jobId: 'job-1', data: { durationMs: 100 } });
    expect($('lv-status-text').textContent).toMatch(/Run completed/);
  });

  it('draws browser frames, shows the waiting message first, and keeps the last picture after the run', () => {
    boot(); events().open();
    expect($('lv-browser-msg').textContent).toMatch(/Waiting for the browser/);
    frames().named('status', { status: 'live' });
    frames().named('frame', { data: 'QUJD', width: 800, height: 600, ts: 1 });
    const img = $('lv-frame') as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,QUJD');
    expect(img.hidden).toBe(false);
    expect($('lv-browser-msg').hidden).toBe(true);
    frames().named('status', { status: 'ended' });
    events().msg({ type: 'job.done', seq: 1, jobId: 'job-1', data: {} });
    expect(img.hidden).toBe(false);
  });

  it('explains when the browser view is full / unavailable', () => {
    boot(); events().open();
    frames().named('status', { status: 'busy' });
    expect($('lv-browser-msg').textContent).toMatch(/Too many people/);
  });

  it('an invalid/expired link (stream never opens) becomes a clear message, not an endless retry', () => {
    boot();
    for (let i = 0; i < 3; i++) { events().fail(); vi.advanceTimersByTime(20000); }
    expect($('lv-status-text').textContent).toMatch(/invalid or has expired/);
    const n = FakeES.all.length;
    vi.advanceTimersByTime(60000);
    expect(FakeES.all.length).toBe(n); // gave up
  });

  it('an address without a share token opens nothing and says so', () => {
    boot('/live/view/local/job-1', '');
    expect(FakeES.all.length).toBe(0);
    expect($('lv-error').hidden).toBe(false);
  });

  it('stays English LTR even if a stale `ab_lang = fa` is stored (English-only UI)', () => {
    localStorage.setItem('ab_lang', 'fa');
    boot();
    expect(document.documentElement.dir).toBe('ltr');
    expect($('lv-readonly').textContent).not.toMatch(/[\u0600-\u06FF]/);
  });
});
