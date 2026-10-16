/**
 * Owner brief 2 / G.2 — the UI of "open a second profile by hand in a running
 * branch" (public/js/profile-manager.js):
 *   - Play on a closed profile while another browser of its branch is open:
 *     409 branch_busy + manualOpenPossible -> an INSET alert in the panel
 *     (title, the four points a-d, Cancel, hold-to-confirm "I understand");
 *     nothing is launched and no viewer tab stays open;
 *   - "I understand" must be held exactly 3 s (pointer, touch, Enter, Space);
 *     2.9 s does nothing, release resets; 3 s calls
 *     POST /profiles/:id/open-manual { confirm: 'manual-only' } once;
 *   - the confirmation is for that one launch: the next Play asks again;
 *   - Stop on a manual row calls /close-manual, a normal row /close;
 *   - no native alert / confirm / prompt is ever called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..');
const pmSrc = readFileSync(join(ROOT, 'public/js/profile-manager.js'), 'utf8');
const i18n = readFileSync(join(ROOT, 'public/js/i18n.js'), 'utf8');

interface World {
  w: any;
  host: HTMLElement;
  calls: Array<{ url: string; method: string; body: any }>;
  tabs: any[];
  natives: string[];
  pm: any;
  setManualOpen: (v: boolean) => void;
}

let W: World;

function boot(opts: { reducedMotion?: boolean } = {}): World {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window as any;
  w.setTimeout = setTimeout; w.clearTimeout = clearTimeout; w.setInterval = setInterval; w.clearInterval = clearInterval;
  w.requestAnimationFrame = (f: () => void) => setTimeout(f, 16);
  w.Date = Date;
  w.AppUtil = { t: (k: string) => k, toast: () => undefined };
  w.API = { getKey: () => 'K' };
  w.matchMedia = (q: string) => ({ matches: !!opts.reducedMotion && /reduce/.test(q), addListener() {}, removeListener() {} });
  const natives: string[] = [];
  w.alert = () => { natives.push('alert'); };
  w.confirm = () => { natives.push('confirm'); return true; };
  w.prompt = () => { natives.push('prompt'); return null; };
  const tabs: any[] = [];
  w.open = (url?: string, name?: string) => {
    const named = name ? tabs.find((x) => x.name === name && !x.closed) : undefined;
    if (named) { if (url) named.location = url; return named; }
    let loc = url || 'about:blank';
    const t: any = { closed: false, name, document: { title: '' }, history: [] as string[], close() { this.closed = true; }, focus() {} };
    Object.defineProperty(t, 'location', { get: () => (loc === 'about:blank' ? { href: 'about:blank', pathname: '', search: '' } : loc), set: (v: string) => { loc = String(v); t.history.push(loc); } });
    tabs.push(t);
    return t;
  };
  let manualOpen = false;
  const calls: World['calls'] = [];
  const profiles = () => [
    { id: 'prf_a', name: 'Alpha', branchId: 'branch-001', branchLabel: 'Work', status: 'free', available: true, hold: { mine: true }, browser: { open: true, dependents: 1 }, usedBy: [] },
    { id: 'prf_b', name: 'Beta', branchId: 'branch-001', branchLabel: 'Work', status: 'free', available: true, branchBusyWith: manualOpen ? undefined : { id: 'prf_a', name: 'Alpha' },
      browser: manualOpen ? { open: true, manual: true, dependents: 0 } : { open: false, dependents: 0 }, usedBy: [] },
  ];
  w.fetch = (url: string, init: any) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    let status = 200;
    let answer: any = { success: true };
    if (url === '/profiles/branches') answer = { success: true, branches: [{ id: 'branch-001', label: 'Work', profiles: ['prf_a', 'prf_b'] }] };
    else if (url.startsWith('/profiles') && method === 'GET') answer = { success: true, profiles: profiles(), unknownSchedules: [] };
    else if (url === '/profiles/prf_b/open') {
      status = 409;
      answer = { success: false, code: 'branch_busy', error: '"Alpha" is already running in this branch.', runningProfile: { id: 'prf_a', name: 'Alpha' }, manualOpenPossible: true, viewPath: '/desktop/chrome?profile=prf_a' };
    } else if (url === '/profiles/prf_b/open-manual') {
      if (!body || body.confirm !== 'manual-only') { status = 428; answer = { success: false, code: 'needs_confirmation', error: 'needs confirmation' }; }
      else { manualOpen = true; answer = { success: true, manual: true, viewPath: '/desktop/chrome?profile=prf_a' }; }
    } else if (url === '/profiles/prf_b/close-manual') { manualOpen = false; answer = { success: true, closed: true }; }
    return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(answer)) });
  };
  w.eval(pmSrc);
  const host = w.document.getElementById('host');
  const pm = w.ProfileManager.mount(host, { launchSettings: false, workflowId: 'wf_1' });
  return { w, host, calls, tabs, natives, pm, setManualOpen: (v) => { manualOpen = v; } };
}

async function settle() { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); }
const alertBox = () => W.host.querySelector('.pm-manual-alert') as HTMLElement;
const confirmBtn = () => W.host.querySelector('.pm-manual-confirm') as HTMLButtonElement;
const posts = () => W.calls.filter((c) => c.method === 'POST').map((c) => c.url);
function fire(el: Element, type: string, init: Record<string, unknown> = {}) {
  const Ctor = type.startsWith('key') ? W.w.KeyboardEvent : (W.w.PointerEvent || W.w.MouseEvent);
  el.dispatchEvent(new Ctor(type, { bubbles: true, button: 0, ...init }));
}
async function pressPlayOnBeta() {
  const box = W.host.querySelector('.pm-row[data-id="prf_b"] .pm-check') as HTMLInputElement;
  if (!box.checked) box.click();
  (W.host.querySelector('.pm-open') as HTMLButtonElement).click();
  await settle();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  W = boot();
  await settle();
});
afterEach(() => { try { W.pm.destroy(); } catch { /* gone */ } vi.useRealTimers(); });

describe('G.2 UI: Play while another browser of the branch is open', () => {
  it('shows the inset alert with title, a-d, Cancel and "I understand"; nothing launched; the blank tab is closed', async () => {
    await pressPlayOnBeta();
    const a = alertBox();
    expect(a.hidden).toBe(false);
    expect(a.getAttribute('role')).toBe('alertdialog');
    const text = a.textContent || '';
    // The owner's wording (t() falls back to the English text).
    for (const k of ['Another browser is open in this branch', 'only ONE browser per branch', 'manual use only; workflows cannot use it',
      'also closes this one', 'Better: keep this profile in a different branch, so both can run at the same time.']) expect(text).toContain(k);
    expect(text).toContain('Alpha');
    expect(a.querySelector('.pm-manual-cancel')).toBeTruthy();
    expect(confirmBtn().textContent).toBe('I understand');
    expect(posts()).toEqual(['/profiles/prf_b/open']);
    expect(W.tabs.every((t) => t.closed)).toBe(true);
    expect(W.natives).toEqual([]);
  });

  it('Cancel closes the alert and launches nothing', async () => {
    await pressPlayOnBeta();
    (W.host.querySelector('.pm-manual-cancel') as HTMLButtonElement).click();
    expect(alertBox().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts()).not.toContain('/profiles/prf_b/open-manual');
  });

  it('pointer: release at 2.9 s does nothing and resets the bar; a full 3 s hold calls open-manual once with the confirmation', async () => {
    await pressPlayOnBeta();
    fire(confirmBtn(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(2900);
    expect(Number(confirmBtn().getAttribute('data-progress'))).toBeGreaterThan(90);
    fire(confirmBtn(), 'pointerup');
    expect(confirmBtn().getAttribute('data-progress')).toBe('0');
    await vi.advanceTimersByTimeAsync(3000);
    expect(posts()).not.toContain('/profiles/prf_b/open-manual');

    fire(confirmBtn(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(2999);
    expect(posts()).not.toContain('/profiles/prf_b/open-manual');
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    const m = W.calls.filter((c) => c.url === '/profiles/prf_b/open-manual');
    expect(m).toHaveLength(1);
    expect(m[0]!.body).toMatchObject({ confirm: 'manual-only', workflowId: 'wf_1' });
    expect(alertBox().hidden).toBe(true);
    // The shared viewer shows the branch's desktop.
    expect(W.tabs.some((t) => !t.closed && String(t.location).includes('/desktop/chrome?profile=prf_a'))).toBe(true);
    expect(W.natives).toEqual([]);
  });

  it('touch: leaving the button / pointercancel resets; a 3 s touch hold confirms', async () => {
    await pressPlayOnBeta();
    fire(confirmBtn(), 'pointerdown', { pointerType: 'touch' });
    await vi.advanceTimersByTimeAsync(1500);
    fire(confirmBtn(), 'pointercancel', { pointerType: 'touch' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(posts()).not.toContain('/profiles/prf_b/open-manual');
    // The long-press context menu is suppressed.
    const ev = new W.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    confirmBtn().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    fire(confirmBtn(), 'pointerdown', { pointerType: 'touch' });
    await vi.advanceTimersByTimeAsync(3001);
    await settle();
    expect(posts().filter((u) => u.endsWith('/open-manual'))).toHaveLength(1);
  });

  it('keyboard: Enter and Space must be held 3 s; releasing at 2.9 s does nothing; key repeat does not restart', async () => {
    for (const key of ['Enter', ' ']) {
      W.setManualOpen(false);
      await W.pm.refresh();
      await pressPlayOnBeta();
      const before = posts().filter((u) => u.endsWith('/open-manual')).length;
      fire(confirmBtn(), 'keydown', { key });
      await vi.advanceTimersByTimeAsync(2900);
      fire(confirmBtn(), 'keyup', { key });
      await vi.advanceTimersByTimeAsync(3000);
      expect(posts().filter((u) => u.endsWith('/open-manual')).length, key).toBe(before);
      fire(confirmBtn(), 'keydown', { key });
      await vi.advanceTimersByTimeAsync(1500);
      fire(confirmBtn(), 'keydown', { key, repeat: true });
      await vi.advanceTimersByTimeAsync(1501);
      await settle();
      expect(posts().filter((u) => u.endsWith('/open-manual')).length, key).toBe(before + 1);
    }
  });

  it('a click alone never confirms', async () => {
    await pressPlayOnBeta();
    confirmBtn().click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts()).not.toContain('/profiles/prf_b/open-manual');
  });

  it('the confirmation is for ONE launch: after the manual browser is closed, the next Play asks again', async () => {
    await pressPlayOnBeta();
    fire(confirmBtn(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(3001);
    await settle();
    expect(posts().filter((u) => u.endsWith('/open-manual'))).toHaveLength(1);
    W.setManualOpen(false);
    await W.pm.refresh();
    await pressPlayOnBeta();
    expect(alertBox().hidden).toBe(false);
    expect(posts().filter((u) => u.endsWith('/open-manual'))).toHaveLength(1);
  });

  it('Stop on the manual row calls /close-manual (only its windows), never /close', async () => {
    W.setManualOpen(true);
    await W.pm.refresh();
    const row = W.host.querySelector('.pm-row[data-id="prf_b"]') as HTMLElement;
    expect(row.textContent).toContain('manual use only');
    const box = row.querySelector('.pm-check') as HTMLInputElement;
    box.click();
    (W.host.querySelector('.pm-close') as HTMLButtonElement).click();
    await settle();
    expect(posts()).toContain('/profiles/prf_b/close-manual');
    expect(posts()).not.toContain('/profiles/prf_b/close');
  });

  it('reduced motion: the bar moves in whole-second steps, the 3 s rule is unchanged', async () => {
    W.pm.destroy();
    W = boot({ reducedMotion: true });
    await settle();
    await pressPlayOnBeta();
    expect(confirmBtn().getAttribute('data-reduced-motion')).toBe('true');
    const bar = confirmBtn().querySelector('.pm-hold-bar') as HTMLElement;
    fire(confirmBtn(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(1500);
    expect(bar.style.width).toBe('33.3%');
    await vi.advanceTimersByTimeAsync(1400);
    expect(bar.style.width).toBe('66.7%');
    expect(posts()).not.toContain('/profiles/prf_b/open-manual');
    await vi.advanceTimersByTimeAsync(101);
    await settle();
    expect(posts().filter((u) => u.endsWith('/open-manual'))).toHaveLength(1);
  });

  it('every new key exists in i18n exactly once', () => {
    for (const k of ['pm.manualTitle', 'pm.manualRunning', 'pm.manualA', 'pm.manualB', 'pm.manualC', 'pm.manualD', 'pm.manualHoldHint', 'pm.manualHold', 'pm.manualOpened', 'pm.manualOpen']) {
      expect(i18n.split(`'${k}':`).length - 1, k).toBe(1);
    }
    expect(W.w.ProfileManager.MANUAL_HOLD_MS).toBe(3000);
  });
});
