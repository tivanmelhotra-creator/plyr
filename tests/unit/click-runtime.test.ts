/**
 * click-runtime.test.ts
 *
 * The Click Element NDV (docs/uiux/ndv-click-element-final.md § 5) added a large
 * parameter surface that the UI stores but that only matters if the RUNTIME
 * honours it. These tests pin down the pure runtime helpers the click branch in
 * src/pipeline.ts delegates to:
 *
 *   buildEngineSelector  <- `Selector type` (CSS / XPath / Text)
 *   clickModifiers       <- `Optional modifiers` (Alt / Ctrl-Cmd / Shift)
 *   clickPosition        <- `Offset X / Y (px)` (center-relative -> Playwright)
 *   waitForStableBox     <- `Stable for (ms)` ("wait until element stops moving")
 *
 * They are exported from pipeline.ts purely so this contract can be asserted
 * without booting Redis or a browser.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildEngineSelector,
  clickModifiers,
  clickPosition,
  waitForStableBox,
} from '../../src/pipeline';

describe('buildEngineSelector — Selector type dropdown', () => {
  it('leaves CSS selectors untouched (and treats a missing type as CSS)', () => {
    expect(buildEngineSelector('#next-button', 'css')).toBe('#next-button');
    expect(buildEngineSelector('#next-button', undefined)).toBe('#next-button');
    expect(buildEngineSelector('.row > a', '')).toBe('.row > a');
  });

  it('prefixes XPath and Text selectors with the Playwright engine', () => {
    expect(buildEngineSelector('//button[@id="ok"]', 'xpath')).toBe('xpath=//button[@id="ok"]');
    expect(buildEngineSelector('Continue', 'text')).toBe('text=Continue');
  });

  it('does not double-prefix an already-qualified selector', () => {
    expect(buildEngineSelector('xpath=//a', 'xpath')).toBe('xpath=//a');
    expect(buildEngineSelector('text=Continue', 'text')).toBe('text=Continue');
  });

  it('is case-insensitive about the selector type', () => {
    expect(buildEngineSelector('//a', 'XPath')).toBe('xpath=//a');
    expect(buildEngineSelector('Go', 'TEXT')).toBe('text=Go');
  });

  it('still enforces the selector security filter', () => {
    expect(() => buildEngineSelector('javascript:alert(1)', 'css')).toThrow();
    expect(() => buildEngineSelector('data:text/html,x', 'text')).toThrow();
  });
});

describe('clickModifiers — Optional modifiers checkboxes', () => {
  it('returns an empty list when nothing is checked', () => {
    expect(clickModifiers({})).toEqual([]);
    expect(clickModifiers({ modAlt: false, modCtrl: false, modShift: false })).toEqual([]);
  });

  it('maps Ctrl/Cmd to ControlOrMeta so one workflow runs on macOS and Linux', () => {
    expect(clickModifiers({ modCtrl: true })).toEqual(['ControlOrMeta']);
  });

  it('accepts the string form the editor persists', () => {
    expect(clickModifiers({ modAlt: 'true', modShift: '1' })).toEqual(['Alt', 'Shift']);
  });

  it('keeps a stable Alt / Ctrl / Shift order', () => {
    expect(clickModifiers({ modShift: true, modCtrl: true, modAlt: true }))
      .toEqual(['Alt', 'ControlOrMeta', 'Shift']);
  });
});

describe('clickPosition — Offset X / Y are center-relative in the design', () => {
  function elWithBox(box: { x: number; y: number; width: number; height: number } | null) {
    return { boundingBox: vi.fn(async () => box) };
  }

  it('returns undefined for the default 0/0 offset (no `position` sent at all)', async () => {
    const el = elWithBox({ x: 10, y: 20, width: 100, height: 40 });
    expect(await clickPosition(el, 0, 0)).toBeUndefined();
    // The fast path must not even measure the element.
    expect(el.boundingBox).not.toHaveBeenCalled();
  });

  it('converts a center-relative offset into Playwright top-left coordinates', async () => {
    const el = elWithBox({ x: 10, y: 20, width: 100, height: 40 });
    expect(await clickPosition(el, 5, -4)).toEqual({ x: 55, y: 16 });
  });

  it('falls back to the raw offset when the element has no box', async () => {
    expect(await clickPosition(elWithBox(null), 7, 9)).toEqual({ x: 7, y: 9 });
  });

  it('falls back to the raw offset when measuring throws', async () => {
    const el = { boundingBox: vi.fn(async () => { throw new Error('detached'); }) };
    expect(await clickPosition(el, 3, 3)).toEqual({ x: 3, y: 3 });
  });
});

describe('waitForStableBox — Stable for (ms)', () => {
  it('is a no-op when the stability window is 0 (the default)', async () => {
    const el = { boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1 })) };
    await waitForStableBox(el, 0, 1000);
    expect(el.boundingBox).not.toHaveBeenCalled();
  });

  it('returns once the box has been unchanged for the requested window', async () => {
    const el = { boundingBox: vi.fn(async () => ({ x: 5, y: 5, width: 20, height: 10 })) };
    const started = Date.now();
    await waitForStableBox(el, 60, 2000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(el.boundingBox.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps polling while the element is still moving, then gives up at the deadline', async () => {
    let n = 0;
    // Never settles: a new position on every poll.
    const el = { boundingBox: vi.fn(async () => ({ x: n++, y: 0, width: 10, height: 10 })) };
    const started = Date.now();
    await waitForStableBox(el, 40, 200);
    // Bounded by the deadline (max(timeout, stableForMs)) instead of hanging.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(el.boundingBox.mock.calls.length).toBeGreaterThan(1);
  });
});
