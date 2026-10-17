/**
 * Delete branch confirm button (owner's brief, section 8): press-and-hold for
 * 3 seconds, pointer OR Enter/Space. Releasing earlier cancels and resets the
 * progress; a click alone never deletes. (public/js/profile-manager.js holdButton)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const src = readFileSync(join(__dirname, '..', '..', 'public/js/profile-manager.js'), 'utf8');

let w: any;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame'] });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  w = dom.window;
  // The page's timers are the test's fake timers.
  w.setTimeout = setTimeout; w.clearTimeout = clearTimeout; w.setInterval = setInterval; w.clearInterval = clearInterval;
  w.requestAnimationFrame = (f: () => void) => setTimeout(f, 16);
  w.Date = Date;
  w.AppUtil = { t: (_k: string, d: string) => d, toast: () => undefined };
  w.eval(src);
});
afterEach(() => { vi.useRealTimers(); });

function make() {
  let deleted = 0;
  const hb = w.ProfileManager.holdButton('Hold to delete', w.ProfileManager.DELETE_HOLD_MS, () => { deleted++; });
  w.document.body.appendChild(hb.el);
  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const Ctor = type.startsWith('key') ? w.KeyboardEvent : (w.PointerEvent || w.MouseEvent);
    hb.el.dispatchEvent(new Ctor(type, { bubbles: true, button: 0, ...init }));
  };
  return { hb, fire, deleted: () => deleted, progress: () => Number(hb.el.getAttribute('data-progress') || 0) };
}

describe('Delete branch: 3-second press-and-hold', () => {
  it('the hold is 3 seconds', () => {
    expect(w.ProfileManager.DELETE_HOLD_MS).toBe(3000);
  });

  it('a 2.5-second pointer hold does nothing and the progress resets on release', () => {
    const b = make();
    b.fire('pointerdown');
    vi.advanceTimersByTime(2500);
    expect(b.deleted()).toBe(0);
    expect(b.progress()).toBeGreaterThan(70); // the indicator filled during the hold
    b.fire('pointerup');
    expect(b.progress()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(b.deleted()).toBe(0);
  });

  it('a full 3-second pointer hold confirms exactly once', () => {
    const b = make();
    b.fire('pointerdown');
    vi.advanceTimersByTime(2999);
    expect(b.deleted()).toBe(0);
    vi.advanceTimersByTime(2);
    expect(b.deleted()).toBe(1);
    b.fire('pointerup');
    vi.advanceTimersByTime(5000);
    expect(b.deleted()).toBe(1);
  });

  it('leaving the button cancels the hold', () => {
    const b = make();
    b.fire('pointerdown');
    vi.advanceTimersByTime(1500);
    b.fire('pointerleave');
    vi.advanceTimersByTime(3000);
    expect(b.deleted()).toBe(0);
  });

  it('keyboard: holding Enter or Space for 3 seconds confirms; releasing earlier cancels; key repeat does not restart', () => {
    for (const key of ['Enter', ' ']) {
      const b = make();
      b.fire('keydown', { key });
      vi.advanceTimersByTime(1000);
      b.fire('keydown', { key, repeat: true }); // auto-repeat while held
      vi.advanceTimersByTime(1000);
      b.fire('keyup', { key });
      vi.advanceTimersByTime(3000);
      expect(b.deleted()).toBe(0);
      b.fire('keydown', { key });
      vi.advanceTimersByTime(3001);
      expect(b.deleted()).toBe(1);
      b.fire('keyup', { key });
    }
  });

  it('a click alone never deletes', () => {
    const b = make();
    b.fire('click');
    vi.advanceTimersByTime(5000);
    expect(b.deleted()).toBe(0);
  });
});
