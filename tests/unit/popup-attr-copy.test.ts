import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════
// extension/popup/popup.js — copying a value from the INSPECT TAB.
//
// WHY THIS EXISTS
//
// Attributes are rendered in TWO places, and only one of them could copy:
//
//   «کپی کردن رو فقط برای باکس پیکر پیاده کردی ولی attributes در دو جا نمایش
//    داده میشه، یکی باکس پیکر و یکی خود صفحه تب inspect افزونه ...
//    حیفه اونجام هم ایکن کپی کردن رو نداره»
//
// The in-page picker got per-row Copy in the previous delta. This popup did not
// — which is the wrong way round for the commoner case: the popup is where a
// user lands when they RE-OPEN the extension to read a pick they took earlier,
// and `.avalue` is `text-overflow: ellipsis`, so a long CSS selector was
// TRUNCATED on screen with no way to get the whole string out. The only recovery
// was to go back and pick the element again.
//
// WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
//
// Not "a button exists": that would pass for a button wired to the wrong row.
// What is pinned down is the behaviour a broken implementation gets wrong
// silently —
//
//   * the value copied belongs to the row whose button was pressed, still true
//     after a re-render has reordered the rows;
//   * §16/§23 are untouched: copying is READING, so it must not tick a checkbox
//     (display) or arm a radio (send). This is the one that a `<label>`-wrapped
//     button breaks by accident, since the label's own click toggles the row;
//   * the confirmation appears only AFTER the write resolves — a ✓ shown
//     optimistically is a lie on every origin where the clipboard is refused;
//   * there IS a fallback, because an extension popup loses focus the instant
//     anything else is clicked and `writeText()` then rejects;
//   * no textarea is left in the popup, even when the fallback fails, because a
//     stray one steals the next keystroke.
//
// HOW: the shipped popup.js runs in a `vm` sandbox against a fake DOM built from
// the ids in the shipped popup.html — the same approach as
// popup-inspector-pairing.test.ts. A pick is planted in chrome.storage.local
// exactly as content/inspector.js writes it, so the rows under test are the rows
// the real controller renders. Assertions read the RENDERED NODES and the
// CLIPBOARD, never popup.js internals.
// ════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'extension/popup/popup.html'), 'utf8');
const JS = readFileSync(resolve(ROOT, 'extension/popup/popup.js'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'extension/popup/popup.css'), 'utf8');
const CORE = readFileSync(resolve(ROOT, 'extension/lib/ab-core.js'), 'utf8');

class El {
  id: string;
  tagName = 'DIV';
  type = '';
  name = '';
  className = '';
  title = '';
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  /** Set by select(); execCommand('copy') copies the last-selected node. */
  selected = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  childNodes: El[] = [];
  parentNode: El | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(id = '') { this.id = id; }

  // Assignment REPLACES a node's contents, children included. A plain field
  // would leave stale children readable after `clear()`, so a row that was
  // supposed to be gone would still answer queries.
  private _text = '';
  get textContent(): string {
    if (this.childNodes.length) {
      return this._text + this.childNodes.map((c) => c.textContent).join('');
    }
    return this._text;
  }
  set textContent(v: string) {
    this._text = String(v == null ? '' : v);
    this.childNodes.length = 0;
  }

  get classList() {
    const self = this;
    const parts = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c: string) { if (parts().indexOf(c) < 0) self.className = parts().concat(c).join(' '); },
      remove(c: string) { self.className = parts().filter((p) => p !== c).join(' '); },
      contains(c: string) { return parts().indexOf(c) >= 0; },
      toggle(c: string, on?: boolean) {
        const want = on === undefined ? !this.contains(c) : !!on;
        if (want) this.add(c); else this.remove(c);
        return want;
      },
    };
  }

  appendChild(c: El) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c: El) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() { return this.childNodes[0] || null; }
  /** popup.js guards its revert with `isConnected`. */
  get isConnected() { return this.parentNode != null; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  focus() {}
  select() { this.selected = true; }
  setSelectionRange() {}
  click() { this.fire('click'); }
  fire(t: string, evt: Record<string, unknown> = {}) {
    (this.listeners[t] || []).slice().forEach((fn) => fn({
      preventDefault() {}, stopPropagation() {}, target: this, ...evt,
    }));
  }
}

/** Every node in a subtree, so a rendered row can be inspected by class. */
function walk(root: El): El[] {
  const out: El[] = [];
  const visit = (n: El) => { out.push(n); n.childNodes.forEach(visit); };
  root.childNodes.forEach(visit);
  return out;
}
const byClass = (root: El, cls: string) =>
  walk(root).filter((n) => n.className.split(/\s+/).indexOf(cls) >= 0);

/** One attribute row as the panel rendered it. */
interface Row {
  node: El;
  name: string;
  value: string;
  copy: El;
  checkbox: El;
  radio: El;
  sending: boolean;
}

interface Harness {
  el(id: string): El;
  /** ATTRIBUTES rows, in panel order. */
  attrRows(): Row[];
  attrRow(name: string): Row;
  /** SELECTED ELEMENT rows, in panel order. */
  selRows(): Array<{ node: El; key: string; value: string; copy: El | null }>;
  /** Tick or untick a row the way a click does: set state, THEN fire change. */
  tick(name: string, on: boolean): Promise<void>;
  /** Arm a row's send radio the way a click does. */
  arm(name: string): Promise<void>;
  /** Everything that reached the clipboard, tagged with the path taken. */
  clipboard: Array<{ text: string; via: 'api' | 'exec' }>;
  /** Textareas still parented to <body>: the fallback must clean up. */
  strayNodes(): El[];
  /** Break the clipboard the way a real browser does. */
  breakClipboard(how: { noClipboardApi?: boolean; clipboardFails?: boolean; execFails?: boolean }): void;
  /** Run every pending timer once — the confirmation reverts on one. */
  runTimers(): void;
  pendingTimers(): number;
  settle(): Promise<void>;
}

function htmlIds(): string[] {
  return Array.from(new Set(
    (HTML.match(/\sid="([A-Za-z0-9_-]+)"/g) || []).map((m) => m.replace(/\sid="|"$/g, '')),
  ));
}

/**
 * A pick in the shape content/inspector.js stores it.
 *
 * `reversed` carries no value on purpose: §14 keeps genuinely absent attributes
 * out of the list, so an empty row that DOES reach here is a boolean attribute —
 * worth seeing, with nothing to put on a clipboard.
 */
function pickFixture(over: Record<string, unknown> = {}) {
  return {
    element: { tag: 'a', selector: 'body > main > a.buy', text: 'Buy now' },
    rows: [
      { key: 'selector', label: 'Selector', value: 'body > main > a.buy', group: 'core' },
      { key: 'href', label: 'href', value: 'https://shop.test/checkout?id=42&ref=abc', group: 'core' },
      { key: 'data-sku', label: 'data-sku', value: 'SKU-99', group: 'data' },
      { key: 'reversed', label: 'reversed', value: '', group: 'core' },
    ],
    display: ['selector', 'href'],
    sendKey: 'href',
    at: Date.now(),
    ...over,
  };
}

function boot(pick: unknown = pickFixture()): Harness {
  const nodes = new Map<string, El>();
  htmlIds().forEach((id) => nodes.set(id, new El(id)));

  const body = new El('body');
  body.tagName = 'BODY';
  const clipboard: Harness['clipboard'] = [];
  const broken = { noClipboardApi: false, clipboardFails: false, execFails: false };
  // Timers are captured, not scheduled: the confirmation reverts on a ~1.1s
  // timer, and a test that waited for real time would be slow AND flaky.
  const timers: Array<{ fn: () => void; id: number }> = [];
  let timerId = 1;

  const documentFake: Record<string, unknown> = {
    getElementById: (id: string) => nodes.get(id) || null,
    createElement: (tag: string) => { const e = new El(); e.tagName = tag.toUpperCase(); return e; },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [] as El[],
    querySelector: () => null,
    body,
    // A browser copies what is SELECTED. Reading the last-selected textarea is
    // what catches a fallback that appends a node but forgets the value.
    execCommand: (cmd: string) => {
      if (String(cmd).toLowerCase() !== 'copy') return false;
      if (broken.execFails) return false;
      const ta = body.childNodes.filter((c) => c.selected).pop();
      if (!ta) return false;
      clipboard.push({ text: ta.value, via: 'exec' });
      return true;
    },
  };

  const storage: Record<string, unknown> = { ab_lastPick: pick };
  const chromeFake = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: { type?: string }, cb?: (r: unknown) => void) => {
        if (cb) cb({ ok: false, error: 'no_base_url' });
        void msg;
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: (_keys: unknown, cb: (v: Record<string, unknown>) => void) => cb(storage),
        set: (obj: Record<string, unknown>, cb?: () => void) => {
          Object.assign(storage, obj);
          if (cb) cb();
        },
      },
    },
    tabs: {
      query: (_q: unknown, cb: (t: unknown[]) => void) => cb([{ id: 1, url: 'https://shop.test/' }]),
      sendMessage: (_id: number, _m: unknown, cb?: (r: unknown) => void) => { if (cb) cb({ ok: true }); },
      create: (_o: unknown, cb?: (t: unknown) => void) => { if (cb) cb({ id: 2 }); },
    },
    scripting: { executeScript: (_o: unknown, cb?: () => void) => { if (cb) cb(); } },
  };

  const navigatorFake: Record<string, unknown> = {};
  // A getter, so a test can remove the whole API AFTER boot — which is the
  // plain-http case: navigator.clipboard is simply not there.
  Object.defineProperty(navigatorFake, 'clipboard', {
    configurable: true,
    get() {
      if (broken.noClipboardApi) return undefined;
      return {
        writeText: (text: string) => {
          if (broken.clipboardFails) return Promise.reject(new Error('not focused'));
          clipboard.push({ text: String(text), via: 'api' });
          return Promise.resolve();
        },
      };
    },
  });

  const windowFake: Record<string, unknown> = { close: () => {} };
  const sandbox: Record<string, unknown> = {
    window: windowFake,
    document: documentFake,
    chrome: chromeFake,
    location: { href: 'chrome-extension://x/popup.html' },
    navigator: navigatorFake,
    setTimeout: (fn: () => void) => {
      const id = timerId++;
      timers.push({ fn, id });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console,
    Promise,
  };
  sandbox.globalThis = sandbox;
  windowFake.window = windowFake;
  windowFake.document = documentFake;
  windowFake.chrome = chromeFake;
  windowFake.navigator = navigatorFake;

  vm.createContext(sandbox);
  vm.runInContext(CORE, sandbox);
  vm.runInContext(JS, sandbox);

  const el = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw new Error(`popup.html declares no id "${id}"`);
    return n;
  };

  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  const attrRows = (): Row[] => el('attrList').childNodes.map((node) => ({
    node,
    name: byClass(node, 'aname')[0]?.textContent || '',
    value: byClass(node, 'avalue')[0]?.textContent || '',
    copy: byClass(node, 'cp')[0] as El,
    checkbox: walk(node).filter((n) => n.type === 'checkbox')[0] as El,
    radio: walk(node).filter((n) => n.type === 'radio')[0] as El,
    sending: node.className.split(/\s+/).indexOf('sending') >= 0,
  }));

  const attrRow = (name: string) => {
    const found = attrRows().filter((r) => r.name === name)[0];
    if (!found) {
      throw new Error(`no attribute row named "${name}" (have: ` +
        attrRows().map((r) => r.name).join(', ') + ')');
    }
    return found;
  };

  return {
    el,
    attrRows,
    attrRow,
    // A browser sets `.checked` and THEN dispatches `change`; the controller
    // reads `cb.checked`, so a bare fire() would look like a no-op tick.
    tick: async (name: string, on: boolean) => {
      const cb = attrRow(name).checkbox;
      cb.checked = on;
      cb.fire('change');
      await settle();
    },
    arm: async (name: string) => {
      const rd = attrRow(name).radio;
      rd.checked = true;
      rd.fire('change');
      await settle();
    },
    selRows: () => el('selList').childNodes.map((node) => ({
      node,
      key: byClass(node, 'k')[0]?.textContent || '',
      value: byClass(node, 'v')[0]?.textContent || '',
      copy: (byClass(node, 'cp')[0] as El) || null,
    })),
    clipboard,
    strayNodes: () => body.childNodes.filter((c) => c.tagName === 'TEXTAREA'),
    breakClipboard: (how) => { Object.assign(broken, how); },
    runTimers: () => {
      timers.splice(0, timers.length).forEach((t) => t.fn());
    },
    pendingTimers: () => timers.length,
    settle,
  };
}

const GLYPH = '\u29c9';
const TICK = '\u2713';
const DASH = '\u2014';

describe('popup Inspect tab: copying an attribute value', () => {
  let h: Harness;
  beforeEach(async () => {
    h = boot();
    await h.settle();
  });

  // ── the harness runs the real controller ──────────────────────
  describe('the harness renders the real panel', () => {
    it('renders one row per attribute the pick carried', () => {
      expect(h.attrRows().map((r) => r.name))
        .toEqual(['Selector', 'href', 'data-sku', 'reversed']);
    });

    it('renders SELECTED ELEMENT from the ticked rows only', () => {
      // Proves the §17 contract is intact in the harness before anything is
      // asserted about copying on top of it.
      expect(h.selRows().map((r) => r.key)).toEqual(['Selector', 'href']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // §10 — the Inspect tab can copy, like the picker can.
  // ══════════════════════════════════════════════════════════════
  describe('§10 — every attribute row offers Copy', () => {
    it('gives every row a Copy button, not just the ticked ones', () => {
      // The value a user wants is often on a row they have NOT ticked — that is
      // frequently why they are reading it.
      h.attrRows().forEach((r) => {
        expect(r.copy, r.name + ' has no Copy button').toBeTruthy();
      });
      expect(h.attrRows().length).toBe(4);
    });

    it('uses the same glyph as the in-page picker', () => {
      // The two surfaces show the same attributes; a different affordance in
      // each reads as two different features.
      expect(h.attrRow('href').copy.textContent).toBe(GLYPH);
    });

    it('names each button for its row, for a screen reader', () => {
      // A column of identical glyphs is "button, button, button" otherwise.
      expect(h.attrRow('href').copy.getAttribute('aria-label')).toBe('Copy href');
      expect(h.attrRow('data-sku').copy.getAttribute('aria-label')).toBe('Copy data-sku');
    });

    it('is a real button, so Enter and Space work', () => {
      expect(h.attrRow('href').copy.tagName).toBe('BUTTON');
      expect(h.attrRow('href').copy.type).toBe('button');
    });

    it('copies that row\'s value when pressed', async () => {
      h.attrRow('href').copy.fire('click');
      await h.settle();
      expect(h.clipboard).toEqual([
        { text: 'https://shop.test/checkout?id=42&ref=abc', via: 'api' },
      ]);
    });

    it('copies the WHOLE value, not the truncated text on screen', async () => {
      // `.avalue` is `text-overflow: ellipsis`, which is the entire reason this
      // button had to exist: the full string is otherwise unreachable.
      expect(CSS).toContain('text-overflow: ellipsis');
      h.attrRow('Selector').copy.fire('click');
      await h.settle();
      expect(h.clipboard[0]!.text).toBe('body > main > a.buy');
    });

    it('copies the pressed row\'s value and no other', async () => {
      h.attrRow('data-sku').copy.fire('click');
      await h.settle();
      // The key is captured in the closure; an index would drift on re-render.
      expect(h.clipboard.map((c) => c.text)).toEqual(['SKU-99']);
    });

    it('still copies the right value after the panel re-renders', async () => {
      // Ticking re-renders SELECTED ELEMENT and arming re-renders ATTRIBUTES.
      await h.tick('data-sku', true);
      await h.arm('data-sku');
      h.attrRow('data-sku').copy.fire('click');
      await h.settle();
      expect(h.clipboard.map((c) => c.text)).toEqual(['SKU-99']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // §16/§23 — copying is READING. It changes neither state.
  //
  // The trap: this button sits in a row whose other controls are inside
  // <label>s. A click that propagates would toggle the row, so "copy this
  // value" would also change what the panel shows, or what it sends.
  // ══════════════════════════════════════════════════════════════
  describe('§16/§23 — copying changes neither of the two states', () => {
    it('does not tick the row it copied', async () => {
      expect(h.attrRow('data-sku').checkbox.checked).toBe(false);
      h.attrRow('data-sku').copy.fire('click');
      await h.settle();
      expect(h.attrRow('data-sku').checkbox.checked).toBe(false);
      // And SELECTED ELEMENT is unchanged, which is what the user would see.
      expect(h.selRows().map((r) => r.key)).toEqual(['Selector', 'href']);
    });

    it('does not un-tick a row that was already ticked', async () => {
      expect(h.attrRow('Selector').checkbox.checked).toBe(true);
      h.attrRow('Selector').copy.fire('click');
      await h.settle();
      expect(h.attrRow('Selector').checkbox.checked).toBe(true);
      expect(h.selRows().map((r) => r.key)).toEqual(['Selector', 'href']);
    });

    it('does not arm the send on the row it copied', async () => {
      h.attrRow('data-sku').copy.fire('click');
      await h.settle();
      // The outbound value is a separate decision (§21). Copying is not it.
      expect(h.attrRow('href').sending).toBe(true);
      expect(h.attrRow('data-sku').sending).toBe(false);
      expect(h.attrRow('data-sku').radio.checked).toBe(false);
    });

    it('does not disarm the send when the armed row is copied', async () => {
      h.attrRow('href').copy.fire('click');
      await h.settle();
      expect(h.attrRow('href').sending).toBe(true);
    });

    it('leaves Select all / Clear untouched', async () => {
      // Explicit instruction from the earlier delta: do NOT touch Select All.
      h.el('attrAll').fire('click');
      await h.settle();
      const before = h.attrRows().map((r) => r.checkbox.checked);
      h.attrRow('href').copy.fire('click');
      await h.settle();
      expect(h.attrRows().map((r) => r.checkbox.checked)).toEqual(before);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // The confirmation: local, honest, and self-reverting.
  // ══════════════════════════════════════════════════════════════
  describe('the confirmation on the button', () => {
    it('shows a tick once the write has resolved', async () => {
      const b = h.attrRow('href').copy;
      b.fire('click');
      await h.settle();
      expect(b.textContent).toBe(TICK);
      expect(b.className.split(/\s+/)).toContain('done');
      expect(b.title).toBe('Copied');
    });

    it('does not claim success before the write resolves', () => {
      const b = h.attrRow('href').copy;
      b.fire('click');
      // Synchronously after the click the promise has not settled. A ✓ here
      // would be a lie on every origin where the clipboard is refused.
      expect(b.textContent).toBe(GLYPH);
      expect(b.className.split(/\s+/)).not.toContain('done');
    });

    it('reverts on its own', async () => {
      const b = h.attrRow('href').copy;
      b.fire('click');
      await h.settle();
      expect(b.textContent).toBe(TICK);
      h.runTimers();
      // A permanent ✓ would say "copied" about a clipboard that has since been
      // overwritten by something else.
      expect(b.textContent).toBe(GLYPH);
      expect(b.className.split(/\s+/)).not.toContain('done');
      expect(b.title).toBe('Copy this value');
    });

    it('confirms on the row that was pressed, and only there', async () => {
      h.attrRow('href').copy.fire('click');
      await h.settle();
      expect(h.attrRow('href').copy.textContent).toBe(TICK);
      expect(h.attrRow('data-sku').copy.textContent).toBe(GLYPH);
      expect(h.attrRow('Selector').copy.textContent).toBe(GLYPH);
    });

    it('gives two rows their own confirmations at once', async () => {
      h.attrRow('href').copy.fire('click');
      await h.settle();
      h.attrRow('data-sku').copy.fire('click');
      await h.settle();
      // Timers are keyed by row, so the second copy does not cancel the first
      // row's tick and leave it looking like nothing happened.
      expect(h.attrRow('href').copy.textContent).toBe(TICK);
      expect(h.attrRow('data-sku').copy.textContent).toBe(TICK);
      expect(h.pendingTimers()).toBe(2);
    });

    it('restarts one row\'s countdown rather than stacking timers', async () => {
      const b = h.attrRow('href').copy;
      b.fire('click');
      await h.settle();
      b.fire('click');
      await h.settle();
      // Two presses on the SAME row: the first timer is cleared, so the label
      // cannot be wiped early by a countdown that started a moment ago.
      expect(h.pendingTimers()).toBe(1);
      expect(b.textContent).toBe(TICK);
    });

    it('says so plainly when a row has no value to copy', async () => {
      const b = h.attrRow('reversed').copy;
      b.fire('click');
      await h.settle();
      // A boolean attribute has nothing to put on a clipboard. Silently doing
      // nothing reads as the button being broken.
      expect(b.textContent).toBe(DASH);
      expect(b.title).toBe('No value to copy');
      expect(h.clipboard).toEqual([]);
    });

    it('reports a genuine failure instead of a tick', async () => {
      h.breakClipboard({ noClipboardApi: true, execFails: true });
      const b = h.attrRow('href').copy;
      b.fire('click');
      await h.settle();
      expect(b.textContent).toBe('!');
      // And says what to do instead, rather than just failing.
      expect(b.title).toContain('Ctrl+C');
      expect(h.clipboard).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // The fallback. An extension popup loses focus the moment anything else is
  // clicked, and writeText() then REJECTS — so this is the routine path, not
  // an exotic one.
  // ══════════════════════════════════════════════════════════════
  describe('when the clipboard API cannot be used', () => {
    it('falls back to execCommand when writeText rejects', async () => {
      h.breakClipboard({ clipboardFails: true });
      const b = h.attrRow('href').copy;
      b.fire('click');
      await h.settle();
      expect(h.clipboard).toEqual([
        { text: 'https://shop.test/checkout?id=42&ref=abc', via: 'exec' },
      ]);
      // And the user is told it worked, because it did.
      expect(b.textContent).toBe(TICK);
    });

    it('falls back to execCommand when there is no clipboard API at all', async () => {
      h.breakClipboard({ noClipboardApi: true });
      h.attrRow('data-sku').copy.fire('click');
      await h.settle();
      expect(h.clipboard).toEqual([{ text: 'SKU-99', via: 'exec' }]);
    });

    it('copies the exact value through the fallback, not a mangled one', async () => {
      h.breakClipboard({ noClipboardApi: true });
      h.attrRow('href').copy.fire('click');
      await h.settle();
      // Read back off the selected textarea, so this catches a fallback that
      // appends a node but forgets to put the value in it.
      expect(h.clipboard[0]!.text).toBe('https://shop.test/checkout?id=42&ref=abc');
    });

    it('leaves no textarea behind', async () => {
      h.breakClipboard({ noClipboardApi: true });
      h.attrRow('href').copy.fire('click');
      await h.settle();
      // A stray off-screen textarea in the popup steals the next keystroke.
      expect(h.strayNodes()).toEqual([]);
    });

    it('leaves no textarea behind even when execCommand fails', async () => {
      h.breakClipboard({ noClipboardApi: true, execFails: true });
      h.attrRow('href').copy.fire('click');
      await h.settle();
      // Cleanup must not be conditional on success — it is needed most when
      // something already went wrong.
      expect(h.strayNodes()).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // SELECTED ELEMENT gets the same affordance: it is the section a user reads a
  // ticked value OUT of, so it is the likeliest place to want the text itself.
  // ══════════════════════════════════════════════════════════════
  describe('SELECTED ELEMENT rows can be copied too', () => {
    it('gives each shown row a Copy button', () => {
      h.selRows().forEach((r) => {
        expect(r.copy, r.key + ' has no Copy button').toBeTruthy();
      });
      expect(h.selRows().length).toBe(2);
    });

    it('copies the value of the row it belongs to', async () => {
      const row = h.selRows().filter((r) => r.key === 'href')[0]!;
      row.copy!.fire('click');
      await h.settle();
      expect(h.clipboard.map((c) => c.text))
        .toEqual(['https://shop.test/checkout?id=42&ref=abc']);
    });

    it('keeps the row on screen after copying it', async () => {
      const row = h.selRows().filter((r) => r.key === 'Selector')[0]!;
      row.copy!.fire('click');
      await h.settle();
      // Copying is reading: it must not un-tick the row and make it vanish
      // from under the cursor.
      expect(h.selRows().map((r) => r.key)).toEqual(['Selector', 'href']);
    });

    it('appears on a row that is added by ticking it', async () => {
      await h.tick('data-sku', true);
      const row = h.selRows().filter((r) => r.key === 'data-sku')[0]!;
      expect(row).toBeTruthy();
      expect(row.copy).toBeTruthy();
      row.copy!.fire('click');
      await h.settle();
      expect(h.clipboard.map((c) => c.text)).toEqual(['SKU-99']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // The layout has to make room, and the styling has to match.
  // ══════════════════════════════════════════════════════════════
  describe('the button has somewhere to sit and something to look like', () => {
    it('reserves a column for it in the attributes grid', () => {
      // `.arow` is a fixed grid. Without a fifth track the button would land in
      // the value cell and squash the text it exists to reveal.
      const arow = CSS.slice(CSS.indexOf('.arow {'), CSS.indexOf('.arow:last-child'));
      expect(arow).toContain('grid-template-columns: 18px 18px minmax(82px, 120px) minmax(0, 1fr) 18px');
    });

    it('reserves a column in SELECTED ELEMENT without touching DESTINATION', () => {
      // `.kv` is shared with DESTINATION, whose rows are static two-cell markup;
      // widening the base rule would leave a permanent empty gutter there.
      expect(CSS).toContain('#selList .kv { grid-template-columns: 110px minmax(0, 1fr) 18px; }');
      const base = CSS.slice(CSS.indexOf('.kv {'), CSS.indexOf('.kv:last-child'));
      expect(base).toContain('grid-template-columns: 110px minmax(0, 1fr);');
    });

    it('styles it with the same tokens as the picker', () => {
      const cp = CSS.slice(CSS.indexOf('.cp {'), CSS.indexOf('.cp.done'));
      // Fixed 18px square so a glyph swap cannot resize the value column.
      expect(cp).toContain('width: 18px; height: 18px;');
      expect(cp).toContain('flex: 0 0 auto;');
      expect(cp).toContain('var(--orange)');
      // A keyboard ring, but not one left behind after a mouse click.
      expect(CSS).toContain('.cp:focus-visible');
      // The confirmation uses the panel's success colour, as it does everywhere.
      expect(CSS).toContain('.cp.done { color: var(--green)');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Values come from an arbitrary page. They are never markup.
  // ══════════════════════════════════════════════════════════════
  describe('a hostile page cannot get script into the popup', () => {
    it('renders and copies an attribute containing markup as text', async () => {
      const hostile = boot(pickFixture({
        rows: [{ key: 'title', label: 'title', value: '<img src=x onerror=alert(1)>', group: 'core' }],
        display: ['title'],
        sendKey: '',
      }));
      await hostile.settle();
      expect(hostile.attrRow('title').value).toBe('<img src=x onerror=alert(1)>');
      hostile.attrRow('title').copy.fire('click');
      await hostile.settle();
      // Copied verbatim — escaping it would put the wrong string on the
      // clipboard, and the defence is textContent, not sanitising.
      expect(hostile.clipboard[0]!.text).toBe('<img src=x onerror=alert(1)>');
    });

    it('never assigns innerHTML anywhere in the controller', () => {
      // The file-level rule the whole popup depends on.
      expect(JS).not.toMatch(/\.innerHTML\s*=/);
    });
  });
});
