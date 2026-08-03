import { describe, it, expect } from 'vitest';
import {
  modifierMask, buildKeyEvents, buttonsMask, normalizeButton,
  normalizeClickCount, nextZoom, ZOOM_STEPS,
} from '../../src/core/BrowserInput';

// These tests assert BEHAVIOUR of the translation, not the presence of any
// string in the source. Each expectation matches something measured against
// real Chromium in tools/probe-cdp.js.

describe('modifierMask', () => {
  it('uses CDP bit values Alt=1 Ctrl=2 Meta=4 Shift=8', () => {
    expect(modifierMask({})).toBe(0);
    expect(modifierMask({ alt: true })).toBe(1);
    expect(modifierMask({ ctrl: true })).toBe(2);
    expect(modifierMask({ meta: true })).toBe(4);
    expect(modifierMask({ shift: true })).toBe(8);
    expect(modifierMask({ ctrl: true, shift: true })).toBe(10);
    expect(modifierMask({ alt: true, ctrl: true, meta: true, shift: true })).toBe(15);
  });
  it('treats null/undefined as no modifiers', () => {
    expect(modifierMask(null)).toBe(0);
    expect(modifierMask(undefined)).toBe(0);
  });
});

describe('buildKeyEvents — no whitelist', () => {
  // The regression this whole module exists to prevent: the old client
  // forwarded nine key names and dropped everything else.
  const OLD_WHITELIST = ['Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Delete', 'Escape'];

  it('forwards keys that the old 9-item whitelist dropped', () => {
    const dropped = ['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'F6', 'F11',
      'ContextMenu', 'CapsLock', 'a', 'Z', '7', '#', '[', 'é', '中'];
    for (const k of dropped) {
      const spec = buildKeyEvents(k);
      expect(spec.events.length, `key ${k} produced no events`).toBeGreaterThan(0);
    }
  });

  it('still handles every key the old whitelist did', () => {
    for (const k of OLD_WHITELIST) {
      expect(buildKeyEvents(k).events.length).toBeGreaterThan(0);
    }
  });

  it('drops only the empty key', () => {
    expect(buildKeyEvents('').events).toHaveLength(0);
  });

  it('forwards an unknown named key rather than swallowing it', () => {
    const spec = buildKeyEvents('MediaPlayPause');
    expect(spec.events.length).toBeGreaterThan(0);
    expect(spec.events[0].key).toBe('MediaPlayPause');
  });
});

describe('buildKeyEvents — modifiers reach the page', () => {
  it('passes ctrl through as a modifier bit, not by dropping the event', () => {
    const spec = buildKeyEvents('a', { ctrl: true });
    expect(spec.events.length).toBeGreaterThan(0);
    expect(spec.events[0].modifiers).toBe(2);
  });

  it('names the editing command for Ctrl+A/C/V/X/Z (Chromium ignores it otherwise)', () => {
    expect(buildKeyEvents('a', { ctrl: true }).command).toBe('selectAll');
    expect(buildKeyEvents('c', { ctrl: true }).command).toBe('copy');
    expect(buildKeyEvents('v', { ctrl: true }).command).toBe('paste');
    expect(buildKeyEvents('x', { ctrl: true }).command).toBe('cut');
    expect(buildKeyEvents('z', { ctrl: true }).command).toBe('undo');
  });

  it('maps Ctrl+Shift+Z to redo', () => {
    expect(buildKeyEvents('z', { ctrl: true, shift: true }).command).toBe('redo');
  });

  it('works with Meta as well as Ctrl (macOS clients)', () => {
    expect(buildKeyEvents('a', { meta: true }).command).toBe('selectAll');
    expect(buildKeyEvents('a', { meta: true }).events[0].modifiers).toBe(4);
  });

  it('does NOT treat Ctrl+letter as text — a shortcut must not type', () => {
    const spec = buildKeyEvents('v', { ctrl: true });
    for (const ev of spec.events) expect(ev.text).toBeUndefined();
  });

  it('AltGr-style Alt+char still types (it is text on many layouts)', () => {
    const spec = buildKeyEvents('#', { alt: true });
    expect(spec.events[0].text).toBe('#');
  });

  it('Ctrl+Enter does not insert a carriage return', () => {
    const spec = buildKeyEvents('Enter', { ctrl: true });
    for (const ev of spec.events) expect(ev.text).toBeUndefined();
  });
});

describe('buildKeyEvents — event shape Chromium requires', () => {
  // MEASURED, and it corrected this very test: an extra `char` event on top of
  // a `keyDown` that already carries `text` types the character TWICE. The
  // live probe read back "hhii" for the input "hi". Exactly two events.
  it('sends keyDown+keyUp for a printable character (no duplicate char event)', () => {
    const types = buildKeyEvents('k').events.map((e) => e.type);
    expect(types).toEqual(['keyDown', 'keyUp']);
  });

  it('never emits a char event — it would double every keystroke', () => {
    for (const k of ['a', 'Z', '7', '#', 'ب', ' ', 'Enter', 'Tab']) {
      const types = buildKeyEvents(k).events.map((e) => e.type);
      expect(types, `key ${k}`).not.toContain('char');
      expect(types.length, `key ${k}`).toBe(2);
    }
  });

  it('sends rawKeyDown+keyUp for a non-text key so accelerators route', () => {
    const types = buildKeyEvents('ArrowLeft').events.map((e) => e.type);
    expect(types).toEqual(['rawKeyDown', 'keyUp']);
  });

  it('supplies a windowsVirtualKeyCode for keys that need accelerator matching', () => {
    expect(buildKeyEvents('a', { ctrl: true }).events[0].windowsVirtualKeyCode).toBe(65);
    expect(buildKeyEvents('Enter').events[0].windowsVirtualKeyCode).toBe(13);
    expect(buildKeyEvents('F5').events[0].windowsVirtualKeyCode).toBe(116);
  });

  it('supplies the physical code, including for shifted punctuation', () => {
    expect(buildKeyEvents('a').events[0].code).toBe('KeyA');
    expect(buildKeyEvents('A').events[0].code).toBe('KeyA');
    expect(buildKeyEvents('7').events[0].code).toBe('Digit7');
    expect(buildKeyEvents('/').events[0].code).toBe('Slash');
    expect(buildKeyEvents('?').events[0].code).toBe('Slash');
    expect(buildKeyEvents('{').events[0].code).toBe('BracketLeft');
  });

  it('typing a space inserts a space (Space is a real character)', () => {
    const spec = buildKeyEvents(' ');
    expect(spec.events[0].text).toBe(' ');
    expect(spec.events[0].code).toBe('Space');
  });

  it('a non-latin character is forwarded as text without a fake key code', () => {
    const spec = buildKeyEvents('ب');
    expect(spec.events[0].text).toBe('ب');
    expect(spec.events[0].windowsVirtualKeyCode).toBeUndefined();
  });

  it('marks autoRepeat when asked (held key)', () => {
    expect(buildKeyEvents('a', {}, { autoRepeat: true }).events[0].autoRepeat).toBe(true);
  });
});

describe('mouse helpers', () => {
  it('buttonsMask matches CDP bit values', () => {
    expect(buttonsMask('left')).toBe(1);
    expect(buttonsMask('right')).toBe(2);
    expect(buttonsMask('middle')).toBe(4);
    expect(buttonsMask('none')).toBe(0);
  });

  it('normalizeButton accepts real buttons and defaults the rest to left', () => {
    expect(normalizeButton('right')).toBe('right');
    expect(normalizeButton('middle')).toBe('middle');
    expect(normalizeButton('nonsense')).toBe('left');
    expect(normalizeButton(undefined)).toBe('left');
  });

  it('normalizeClickCount allows 1/2/3 (click, word, paragraph) and clamps', () => {
    expect(normalizeClickCount(1)).toBe(1);
    expect(normalizeClickCount(2)).toBe(2);
    expect(normalizeClickCount(3)).toBe(3);
    expect(normalizeClickCount(99)).toBe(3);
    expect(normalizeClickCount(0)).toBe(1);
    expect(normalizeClickCount('x')).toBe(1);
  });
});

describe('zoom ladder', () => {
  it('includes 1 and matches Chrome-familiar steps', () => {
    expect(ZOOM_STEPS).toContain(1);
    expect(ZOOM_STEPS).toContain(1.25);
    expect(ZOOM_STEPS).toContain(0.5);
  });

  it('steps in and out along the ladder', () => {
    expect(nextZoom(1, 'in')).toBe(1.1);
    expect(nextZoom(1.1, 'in')).toBe(1.25);
    expect(nextZoom(1, 'out')).toBe(0.9);
    expect(nextZoom(0.9, 'out')).toBe(0.8);
  });

  it('reset always returns 1', () => {
    expect(nextZoom(3, 'reset')).toBe(1);
    expect(nextZoom(0.25, 'reset')).toBe(1);
  });

  it('never runs off either end of the ladder', () => {
    expect(nextZoom(5, 'in')).toBe(5);
    expect(nextZoom(0.25, 'out')).toBe(0.25);
    expect(nextZoom(99, 'in')).toBe(5);
  });
});
