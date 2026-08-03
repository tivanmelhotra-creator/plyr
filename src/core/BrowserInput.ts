// ════════════════════════════════════════════════════════════════
// BrowserInput — translate a browser-side input event into the CDP
// event Chromium actually expects.
//
// This file exists because the old client shipped a NINE-KEY
// ALLOWLIST (Enter, Backspace, Tab, four arrows, Delete, Escape)
// and dropped everything that carried Ctrl/Alt/Meta. That is not a
// browser: Ctrl+L, Ctrl+K, F6, Home, Ctrl+Shift+Delete, typing a `#`
// on a layout where it needs AltGr — all silently nothing.
//
// The rule here is the inverse of an allowlist: EVERY key is
// forwarded, and the table below exists only to supply the extra
// fields Chromium needs (a virtual key code, a `code`, and the
// editing `command` that a modifier combination implies). A key the
// table does not know still goes through, derived from its name.
//
// Measured (tools/probe-cdp.js) on the Chromium this server
// launches: `Input.dispatchKeyEvent` with `modifiers:2` and
// `commands:['selectAll']` selects the document, `clickCount:2`
// selects a word and `:3` a paragraph, a `mouseWheel` with `deltaX`
// scrolls horizontally, and `Input.synthesizePinchGesture` zooms.
// None of that needed a whitelist; it needed the right fields.
// ════════════════════════════════════════════════════════════════

/** CDP's modifier bitmask. Alt=1, Ctrl=2, Meta=4, Shift=8. */
export interface Mods {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export function modifierMask(m: Mods | undefined | null): number {
  if (!m) return 0;
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

/**
 * Keys whose `key` name differs from the physical `code`, plus their
 * Windows virtual key code. Chromium uses the VK code for shortcut
 * matching, so omitting it is why "Ctrl+A did nothing" is a classic
 * CDP bug — the event arrives, but no accelerator matches it.
 */
const KEY_TABLE: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9, text: '\t' },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Insert: { code: 'Insert', vk: 45 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  Space: { code: 'Space', vk: 32, text: ' ' },
  Shift: { code: 'ShiftLeft', vk: 16 },
  Control: { code: 'ControlLeft', vk: 17 },
  Alt: { code: 'AltLeft', vk: 18 },
  Meta: { code: 'MetaLeft', vk: 91 },
  CapsLock: { code: 'CapsLock', vk: 20 },
  ContextMenu: { code: 'ContextMenu', vk: 93 },
  // Function keys. F5 and F12 are handled by the CLIENT (reload / devtools),
  // but F1-F4 and F6-F11 are the page's business and must reach it.
  F1: { code: 'F1', vk: 112 },
  F2: { code: 'F2', vk: 113 },
  F3: { code: 'F3', vk: 114 },
  F4: { code: 'F4', vk: 115 },
  F5: { code: 'F5', vk: 116 },
  F6: { code: 'F6', vk: 117 },
  F7: { code: 'F7', vk: 118 },
  F8: { code: 'F8', vk: 119 },
  F9: { code: 'F9', vk: 120 },
  F10: { code: 'F10', vk: 121 },
  F11: { code: 'F11', vk: 122 },
  F12: { code: 'F12', vk: 123 },
};

/** Punctuation → physical `code`, so shifted symbols report the right key. */
const PUNCT_CODE: Record<string, string> = {
  '`': 'Backquote', '~': 'Backquote',
  '-': 'Minus', '_': 'Minus',
  '=': 'Equal', '+': 'Equal',
  '[': 'BracketLeft', '{': 'BracketLeft',
  ']': 'BracketRight', '}': 'BracketRight',
  '\\': 'Backslash', '|': 'Backslash',
  ';': 'Semicolon', ':': 'Semicolon',
  "'": 'Quote', '"': 'Quote',
  ',': 'Comma', '<': 'Comma',
  '.': 'Period', '>': 'Period',
  '/': 'Slash', '?': 'Slash',
};

/** Punctuation → Windows VK, for the same accelerator-matching reason. */
const PUNCT_VK: Record<string, number> = {
  Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
  Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191,
};

/**
 * The editing command a Ctrl/Meta combination means.
 *
 * Chromium will NOT perform a clipboard or undo operation from a
 * synthesised key event unless the event names the command — measured:
 * Ctrl+A alone changed nothing, Ctrl+A with `commands:['selectAll']`
 * selected the document. This is the single most load-bearing detail in
 * this file.
 */
const EDIT_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
  y: 'redo',
};

/**
 * One `Input.dispatchKeyEvent` payload. `type` is required by CDP, so it is
 * required here too — the compiler should not have to be told twice.
 */
export interface KeyEventPayload extends Record<string, unknown> {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp' | 'char';
}

export interface KeyEventSpec {
  /** Which CDP key events to send, in order. */
  events: KeyEventPayload[];
  /** True when the combination is an editing command we named explicitly. */
  command?: string;
}

/**
 * Build the CDP key events for one keystroke.
 *
 * `key` is the DOM `KeyboardEvent.key` value, verbatim from the client —
 * no filtering, no allowlist. A single printable character also carries
 * `text`, which is what makes it actually type; a named key does not.
 */
export function buildKeyEvents(key: string, mods: Mods = {}, opts: { autoRepeat?: boolean } = {}): KeyEventSpec {
  const name = String(key || '');
  if (!name) return { events: [] };

  const modifiers = modifierMask(mods);
  const known = KEY_TABLE[name];
  const printable = !known && Array.from(name).length === 1;

  let code = '';
  let vk = 0;
  let text = '';

  if (known) {
    code = known.code;
    vk = known.vk;
    // A named key only has text when it inserts something (Enter, Tab, Space),
    // and even then not while a non-shift modifier is held — Ctrl+Enter must
    // not type a carriage return.
    if (known.text && !mods.ctrl && !mods.meta && !mods.alt) text = known.text;
  } else if (printable) {
    const ch = name;
    const upper = ch.toUpperCase();
    if (/^[a-zA-Z]$/.test(ch)) {
      code = 'Key' + upper;
      vk = upper.charCodeAt(0);
    } else if (/^[0-9]$/.test(ch)) {
      code = 'Digit' + ch;
      vk = ch.charCodeAt(0);
    } else if (PUNCT_CODE[ch]) {
      code = PUNCT_CODE[ch];
      vk = PUNCT_VK[code] || 0;
    } else {
      // Any other single character — CJK, Cyrillic, an emoji the user pasted.
      // It has no virtual key code; it is pure text, and that is fine.
      code = '';
      vk = 0;
    }
    // Ctrl/Meta combinations are commands, not text. Alt+char on some layouts
    // IS text (AltGr), so alt alone does not suppress it.
    if (!mods.ctrl && !mods.meta) text = ch;
  } else {
    // An unknown named key (a media key, a layout-specific dead key). Forward
    // it by name rather than dropping it: the page may well listen for it.
    code = name;
    vk = 0;
  }

  const commands: string[] = [];
  if ((mods.ctrl || mods.meta) && !mods.alt && printable) {
    const cmd = EDIT_COMMANDS[name.toLowerCase()];
    // Ctrl+Shift+Z is redo on every platform that has it.
    if (cmd === 'undo' && mods.shift) commands.push('redo');
    else if (cmd) commands.push(cmd);
  }

  const base: Record<string, unknown> = {
    modifiers,
    key: name,
    ...(code ? { code } : {}),
    ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
    ...(opts.autoRepeat ? { autoRepeat: true } : {}),
    ...(commands.length ? { commands } : {}),
  };

  const events: KeyEventPayload[] = [];
  // `keyDown` when there is text, `rawKeyDown` when there is not: Chromium
  // only generates a `keypress` (and therefore only inserts a character) for
  // the former, and only routes an accelerator for the latter.
  //
  // MEASURED (tools/probe-input-real.js): a `keyDown` that carries `text`
  // ALREADY inserts the character. Adding the separate `char` event that the
  // CDP docs suggest made every keystroke type TWICE — the probe read back
  // "hhii  بب77##??" for the input "hi ب7#?". Two events per keystroke, not
  // three. This is precisely the kind of claim that cannot be verified by
  // reading the protocol docs, only by asking the browser.
  events.push({
    ...base,
    type: text ? 'keyDown' : 'rawKeyDown',
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  events.push({
    ...base,
    type: 'keyUp',
    ...(text ? { text, unmodifiedText: text } : {}),
  });

  return { events, ...(commands.length ? { command: commands[0] } : {}) };
}

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward' | 'none';

/** Which bit CDP wants in `buttons` while a drag is in progress. */
export function buttonsMask(button: MouseButton): number {
  switch (button) {
    case 'left': return 1;
    case 'right': return 2;
    case 'middle': return 4;
    case 'back': return 8;
    case 'forward': return 16;
    default: return 0;
  }
}

export function normalizeButton(b: unknown): MouseButton {
  const s = String(b || 'left');
  return (s === 'right' || s === 'middle' || s === 'back' || s === 'forward' || s === 'none')
    ? s as MouseButton
    : 'left';
}

/**
 * Clamp a click count into what Chromium treats as meaningful.
 *
 * 1 = click, 2 = word selection, 3 = paragraph selection (both measured).
 * Beyond 3 Chromium keeps counting but nothing new happens, and an
 * unbounded value from a client is not something to pass through.
 */
export function normalizeClickCount(n: unknown): number {
  const v = Math.round(Number(n) || 1);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, 3);
}

/** Zoom steps Chrome actually uses, so Ctrl+ / Ctrl- land on familiar values. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next zoom level in `dir`, snapped to Chrome's ladder. */
export function nextZoom(current: number, dir: 'in' | 'out' | 'reset'): number {
  if (dir === 'reset') return 1;
  const cur = Number(current) || 1;
  if (dir === 'in') {
    for (const s of ZOOM_STEPS) if (s > cur + 1e-6) return s;
    return ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i] < cur - 1e-6) return ZOOM_STEPS[i];
  }
  return ZOOM_STEPS[0];
}
