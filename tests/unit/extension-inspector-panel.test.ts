import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════
// extension/content/inspector.js — the in-page panel.
//
// WHAT THESE TESTS DEFEND (§16 / §21 / §23)
//
// The panel carries TWO independent selections, and the whole design rests on
// them staying independent:
//
//   • checkboxes  -> `displayAttributes`  — what the user wants to LOOK AT.
//   • one radio   -> `sendAttribute`      — the single value that is SENT.
//
// Collapsing them into one collection is the obvious "simplification", it
// would pass a casual review, and it would break the contract silently: the
// outbound value would start depending on how many boxes happen to be ticked,
// and the server would receive a different value than the user chose. Nothing
// would throw. So the independence is asserted here in both directions, by
// name.
//
// HOW: the real source runs in a `vm` sandbox against a hand-rolled fake DOM,
// matching extension-inspect.test.ts / extension-selector.test.ts (there is no
// jsdom in this repo). Crucially the assertions are made against the RENDERED
// CONTROLS and the PAYLOAD HANDED TO chrome.runtime.sendMessage — never against
// the module's private `state`. That is what makes them behavioural: they
// describe what a user can do and what leaves the machine, so a refactor that
// renames or restructures the internals keeps passing, while one that changes
// the observable contract fails.
// ════════════════════════════════════════════════════════════════

/**
 * The picker's width, from `--w` in the supplied picker.html design document.
 *
 * The harness has no layout engine, so the fake box below has to be told a
 * width; using the design's number keeps the fake consistent with the real CSS
 * instead of quietly disagreeing with it. The assertion that the SHIPPED
 * stylesheet declares this width reads the stylesheet itself — see panelCss().
 */
const PANEL_W = 330;

/* ---------------------------------------------------------------
   A fake DOM, recording exactly the properties the panel sets.
   --------------------------------------------------------------- */
class FakeNode {
  tagName: string;
  id = '';
  className = '';
  title = '';
  type = '';
  name = '';
  checked = false;
  disabled = false;
  textContent = '';
  scrollTop = 0;
  /**
   * Only the clipboard's execCommand fallback uses this: it writes the value
   * into a throwaway <textarea>, selects it and asks the document to copy. It is
   * here so that path can be exercised at all — a page on http://, or one that
   * has just taken focus, is exactly where navigator.clipboard fails and this is
   * the only route left.
   */
  value = '';
  selected = false;
  select() { this.selected = true; }
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  childNodes: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  shadowRootFake: FakeNode | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); }

  /**
   * The size the panel measures itself at. Only the panel's own `.wrap` is ever
   * measured, so a single settable box is enough — and it has to be settable,
   * because the whole point of the clamp is that a TALL panel (a pick with many
   * attributes) is the one that used to fall off the bottom of the screen.
   */
  rect = { width: PANEL_W, height: 420 };
  getBoundingClientRect() {
    return {
      left: 0, top: 0, width: this.rect.width, height: this.rect.height,
      right: this.rect.width, bottom: this.rect.height,
    };
  }

  /** Pointer capture is a no-op here; the panel must not depend on it working. */
  capturedPointer: number | null = null;
  setPointerCapture(id: number) { this.capturedPointer = id; }
  releasePointerCapture() { this.capturedPointer = null; }

  get classList() {
    const self = this;
    const parts = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c: string) { if (parts().indexOf(c) < 0) self.className = parts().concat(c).join(' '); },
      remove(c: string) { self.className = parts().filter((p) => p !== c).join(' '); },
      contains(c: string) { return parts().indexOf(c) >= 0; },
    };
  }

  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  /**
   * The clipboard fallback removes its scratch textarea through
   * `ta.parentNode.removeChild(ta)`, so the fake needs the parentNode alias — a
   * missing one would silently leave the node in the page, which is the exact
   * litter the `finally` exists to prevent.
   */
  get parentNode(): FakeNode | null { return this.parentElement; }
  appendChild(c: FakeNode) { c.parentElement = this; this.childNodes.push(c); return c; }
  removeChild(c: FakeNode) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    return c;
  }
  get firstChild() { return this.childNodes[0] || null; }
  attachShadow() { this.shadowRootFake = new FakeNode('#shadow'); return this.shadowRootFake; }
  addEventListener(t: string, fn: (e: unknown) => void) {
    (this.listeners[t] ||= []).push(fn);
  }
  removeEventListener(t: string, fn: (e: unknown) => void) {
    const l = this.listeners[t];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** Fire a listener the way the browser would, on this node only. */
  fire(t: string, evt: Record<string, unknown> = {}) {
    (this.listeners[t] || []).slice().forEach((fn) => fn({
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      target: this, ...evt,
    }));
  }
}

/** A page element the inspector can describe — shaped for ab-inspect.js. */
class FakeEl {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  attrs: Record<string, string>;
  childrenArr: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  innerText = '';
  isConnected = true;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.nodeName = tag.toUpperCase();
    this.tagName = this.nodeName;
    this.attrs = attrs;
  }
  get id() { return this.attrs.id || ''; }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  get parentNode() { return this.parentElement; }
  get children() { return this.childrenArr; }
  get firstElementChild() { return this.childrenArr[0] || null; }
  get textContent(): string {
    return this.innerText || this.childrenArr.map((c) => c.textContent).join('');
  }
  get attributes() {
    return Object.keys(this.attrs).map((k) => ({ name: k, value: this.attrs[k]! }));
  }
  getBoundingClientRect() { return { left: 10, top: 40, width: 120, height: 36 }; }
}

/** Walk the fake tree, descending through shadow roots. */
function findAll(root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const visit = (n: FakeNode) => {
    if (pred(n)) out.push(n);
    n.childNodes.forEach(visit);
    if (n.shadowRootFake) visit(n.shadowRootFake);
  };
  visit(root);
  return out;
}

interface SentMessage {
  type?: string;
  element?: Record<string, unknown>;
  displayAttributes?: string[];
  sendAttribute?: { name: string; value: string };
}

interface RowControls {
  key: string;
  checkbox: FakeNode;
  radio: FakeNode;
  label: FakeNode;
  /** The row's own copy button — one per row, never shared. */
  copy: FakeNode;
}

interface Harness {
  /** Arm the picker, exactly as Ctrl+Shift+C or the popup does. */
  start(): void;
  stop(): void;
  isActive(): boolean;
  /** Click a page element while picking — freezes it and opens the panel. */
  pick(el: FakeEl): void;
  /**
   * Sweep the mouse over a page element WITHOUT clicking.
   *
   * The distinction from pick() is the whole of the eye toggle: with selection
   * on, a hover re-outlines and re-labels; with it off, a hover must change
   * nothing at all.
   */
  hover(el: FakeEl): void;
  /** The rendered rows, in panel order, with their two controls. */
  rows(): RowControls[];
  row(key: string): RowControls;
  /** Tick / untick a checkbox the way a user's pointer does. */
  tick(key: string): void;
  /** Arm a radio, emulating the browser's own "one per name" enforcement. */
  arm(key: string): void;
  /** Click the row's text label. */
  clickLabel(key: string): void;
  /** Press "Confirm & Add to Node". */
  confirm(): void;

  // ── The bulk display toolbar ───────────────────────────────────────────────
  /**
   * Reached by class, exactly as a user reaches them by reading the labels:
   * these are the panel's "Select all" / "Clear" buttons. `selectAll()` and
   * `clearAll()` refuse on a disabled button, because the browser does too —
   * a test that could "click" a greyed-out control would be able to assert
   * behaviour no user can ever reach.
   */
  toolsAll(): FakeNode;
  toolsNone(): FakeNode;
  selectAll(): void;
  clearAll(): void;
  /** The "N of M shown" counter, as text. */
  toolsCount(): string;
  /** Whether the toolbar is on screen at all. */
  toolsVisible(): boolean;
  /** The scrolling rows container — so tests can assert the list is not jumped. */
  list(): FakeNode;

  // ── SELECTED ELEMENT (§17) ────────────────────────────────────────────────
  /**
   * The readout section: the ticked rows with their values shown IN FULL.
   *
   * Read as the user reads it — key/value pairs off the rendered DOM — rather
   * than from the module's state, so these assertions describe what is on screen
   * and survive any refactor that keeps the screen the same.
   */
  selected(): Array<{ key: string; value: string; sending: boolean; empty: boolean }>;
  /** The section's own scroll container, for the reset and clamp assertions. */
  selBox(): FakeNode;
  /** Whether the section is on screen at all. */
  selVisible(): boolean;
  /** The "nothing ticked" message, or '' when values are being shown. */
  selEmptyText(): string;
  /**
   * The copy button belonging to one SELECTED ELEMENT entry.
   *
   * Separate from the row's, deliberately: the two are different renderings of
   * one row and each has to copy that row's value on its own, so a test that
   * could only reach one of them would leave the other untested.
   */
  selCopy(key: string): FakeNode;

  // ── The 👁 selection toggle ───────────────────────────────────────────────
  /** The header's eye button. */
  eye(): FakeNode;
  /** Press it, exactly as a pointer does. */
  clickEye(): void;
  /**
   * Whether element selection is live, read the way the USER reads it: off the
   * button's `aria-pressed`, not from the module's private state. A refactor of
   * the internals must not be able to make these tests lie.
   */
  selectionOn(): boolean;
  /** The "selection paused" notice: its text, or '' while it is hidden. */
  pausedText(): string;
  /** The highlight overlay's outline box and its label. */
  outline(): { visible: boolean; left: string; top: string; label: string };
  /** Press a key on the document, the way onKey receives it. */
  key(name: string, mods?: { ctrlKey?: boolean; shiftKey?: boolean }): void;
  /** Whether a page click was swallowed by the picker (preventDefault'd). */
  clickWasSwallowed(el: FakeEl): boolean;

  // ── The clipboard ─────────────────────────────────────────────────────────
  /** Everything written to navigator.clipboard, in order. */
  clipboard: string[];
  /** Make navigator.clipboard.writeText reject, forcing the legacy path. */
  failClipboard(on: boolean): void;
  /** Whether the execCommand fallback ran, and with what text. */
  legacyCopies: string[];
  /** Make document.execCommand('copy') report failure too. */
  failLegacy(on: boolean): void;
  /** Run every pending setTimeout callback — i.e. let the "✓" revert. */
  flushTimers(): void;
  /** Any scratch nodes the clipboard fallback left behind in the page. */
  strayNodes(): FakeNode[];
  /**
   * Let the clipboard's promise chain finish.
   *
   * The button deliberately does NOT say "Copied" the instant it is pressed — it
   * says so only once the write has actually resolved, because a tick that
   * appears before the copy succeeded is a lie the user only discovers when they
   * paste. That honesty costs a microtask (two, on the fallback path: the modern
   * rejection, then execCommand), so any test reading the CONFIRMATION has to
   * await this first. Tests reading only `clipboard` need not: the value is
   * handed over synchronously on the click.
   */
  settle(): Promise<void>;

  /** The status line the user reads. */
  status(): { text: string; kind: string };
  /** Everything handed to chrome.runtime.sendMessage. */
  sent: SentMessage[];
  /** What the background worker replies with; mutate before confirm(). */
  reply: { value: unknown };
  confirmButton(): FakeNode;
  timeouts: number;

  // ── Position and drag ──────────────────────────────────────────────────────
  /** The panel's outer box, i.e. the thing being positioned. */
  wrap(): FakeNode;
  /** The header strip — the drag handle. */
  header(): FakeNode;
  /** Where the panel is now, in viewport coordinates. */
  pos(): { left: number; top: number };
  size(): { w: number; h: number };
  /** Set the height the next pick's panel will measure at. */
  setPanelHeight(h: number): void;
  /** Resize the viewport (call fireResize() to notify the panel). */
  viewport(w: number, h: number): void;
  fireResize(): void;
  /** A complete drag: press at `from`, move through each point, release. */
  drag(from: { x: number; y: number }, ...to: Array<{ x: number; y: number }>): void;
  /** A drag that is begun but not finished, optionally pressed on another node. */
  dragStart(at: { x: number; y: number }, over?: FakeNode): void;
  dragMove(at: { x: number; y: number }): void;
  /** What the picker has left in chrome.storage.local for the popup. */
  stored: Record<string, unknown>;
}

const SOURCE = resolve(__dirname, '../../extension/content/inspector.js');
const INSPECT_LIB = resolve(__dirname, '../../extension/lib/ab-inspect.js');

/**
 * `selectors` mirrors the real window.ABSelector seam. Passing `null` models a
 * page where no selector could be generated — which is how a genuinely
 * un-armable panel arises (see the refusal tests).
 */
function boot(opts: { selectors?: boolean } = {}): Harness {
  const withSelectors = opts.selectors !== false;

  const documentEl = new FakeNode('html');
  const body = new FakeNode('body');
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};

  const sent: SentMessage[] = [];
  const reply: { value: unknown } = { value: { ok: true, node: 'HTTP Request', field: 'url', attribute: 'href', value: '/checkout' } };
  let timeouts = 0;

  /*
   * THE CLIPBOARD, BOTH PATHS.
   *
   * `clipboard` records what navigator.clipboard.writeText received; `legacyCopies`
   * records what the execCommand fallback selected. Both are needed because the
   * panel runs in an arbitrary page: on http://, or with the document unfocused,
   * the modern API rejects and the fallback is the only thing that copies. A test
   * suite that only knew about the first would call the feature covered while the
   * path most users on a plain http:// site actually take went unexercised.
   */
  const clipboard: string[] = [];
  const legacyCopies: string[] = [];
  const fail = { modern: false, legacy: false };
  /** Pending setTimeout callbacks, so the "✓ Copied" revert can be run on demand. */
  const pending: Array<() => void> = [];

  const documentFake = {
    documentElement: documentEl,
    body,
    title: 'Shop',
    createElement: (tag: string) => new FakeNode(tag),
    /**
     * The copy fallback's last step. It reports what the selected scratch node
     * held, which is how the tests assert the LEGACY path copied the right text
     * rather than merely that it ran.
     */
    execCommand: (cmd: string) => {
      if (cmd !== 'copy') return false;
      // Only a node that was actually selected can be copied — the same rule the
      // browser applies, and the reason the implementation calls select().
      const ta = body.childNodes.filter((n) => n.tagName === 'TEXTAREA' && n.selected)[0];
      if (!ta) return false;
      if (fail.legacy) return false;
      legacyCopies.push(ta.value);
      return true;
    },
    addEventListener: (t: string, fn: (e: unknown) => void) => { (docListeners[t] ||= []).push(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      const l = docListeners[t];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };

  // The panel binds scroll/resize on `window` to re-measure the outline, so the
  // fake needs the listener seam too.
  const winListeners: Record<string, Array<(e: unknown) => void>> = {};
  const windowFake: Record<string, unknown> = {
    // A real viewport, so the panel's placement can be checked against numbers
    // rather than merely asserted to exist. Mutable: shrinking these and firing
    // `resize` is how the "window got smaller after the panel opened" case — the
    // one that stranded the Confirm button off-screen — is reproduced.
    innerWidth: 1280,
    innerHeight: 800,
    // The modern clipboard, which is what a normal https:// page gives the panel.
    // `fail.modern` models the ordinary failures — an insecure context, or a
    // document that does not have focus — by rejecting, which is precisely what
    // the real API does there.
    navigator: {
      clipboard: {
        writeText: (s: string) => {
          if (fail.modern) return Promise.reject(new Error('not allowed'));
          clipboard.push(s);
          return Promise.resolve();
        },
      },
    },
    addEventListener: (t: string, fn: (e: unknown) => void) => { (winListeners[t] ||= []).push(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      const l = winListeners[t];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };
  // The picker leaves each pick in storage for the popup to read, because at the
  // moment of a pick the popup is closed and cannot be messaged.
  const stored: Record<string, unknown> = {};
  const chromeFake = {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      sendMessage: (msg: SentMessage, cb?: (r: unknown) => void) => {
        sent.push(msg);
        if (cb) cb(reply.value);
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        set: (obj: Record<string, unknown>, cb?: () => void) => {
          Object.assign(stored, obj);
          if (cb) cb();
        },
        get: (_k: unknown, cb: (v: Record<string, unknown>) => void) => cb(stored),
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    window: windowFake,
    document: documentFake,
    location: { href: 'https://shop.test/p/1' },
    chrome: chromeFake,
    /*
     * Counts as it always did — the auto-close-after-send assertions read
     * `timeouts` — but now also KEEPS the callback, because the copy feedback's
     * whole contract is that it reverts. A stub that dropped the callback could
     * only ever prove the "✓" appears, never that the button goes back to normal.
     *
     * Handles are 1-based so a real handle is never 0: the implementation clears a
     * pending revert before starting another, and a falsy handle is exactly the
     * case a truthiness check would miss.
     */
    setTimeout: (fn: () => void) => {
      timeouts += 1;
      pending.push(typeof fn === 'function' ? fn : () => {});
      return pending.length;
    },
    clearTimeout: (id: number) => {
      if (typeof id === 'number' && id >= 1 && pending[id - 1]) pending[id - 1] = () => {};
    },
    module: undefined,
  };
  sandbox.globalThis = sandbox;
  windowFake.window = windowFake;
  windowFake.document = documentFake;
  windowFake.chrome = chromeFake;
  windowFake.location = sandbox.location;

  vm.createContext(sandbox);

  // The real extraction library, so rows/labels/values/defaults are genuine and
  // not a guess about what the panel will be handed.
  vm.runInContext(readFileSync(INSPECT_LIB, 'utf8'), sandbox);
  if (!withSelectors) delete (windowFake as Record<string, unknown>).ABSelector;
  else {
    windowFake.ABSelector = {
      cssPath: (el: FakeEl) => (el.id ? `#${el.id}` : el.tagName.toLowerCase()),
      xPath: (el: FakeEl) => (el.id ? `//*[@id="${el.id}"]` : `/${el.tagName.toLowerCase()}[1]`),
    };
  }

  vm.runInContext(readFileSync(SOURCE, 'utf8'), sandbox);

  const api = windowFake.ABInspector as { start(): void; stop(): void; isActive(): boolean };

  function panelHost() {
    return findAll(documentEl, (n) => n.id === 'ab-inspector-panel')[0] || null;
  }

  function rows(): RowControls[] {
    const host = panelHost();
    if (!host) return [];
    return findAll(host, (n) => n.className === 'row').map((row) => {
      const inputs = row.childNodes.filter((c) => c.tagName === 'INPUT');
      const checkbox = inputs.filter((c) => c.type === 'checkbox')[0]!;
      const radio = inputs.filter((c) => c.type === 'radio')[0]!;
      const label = row.childNodes.filter((c) => c.tagName === 'LABEL')[0]!;
      /*
       * The copy button, found on the ROW rather than inside the label.
       *
       * That is not an incidental detail of the query: the label's own click
       * toggles DISPLAY, so a copy button nested inside it would tick or untick
       * the row on every copy. Reaching for it here — as a sibling of the label —
       * is what makes the test fail if it is ever moved back in.
       */
      const copy = row.childNodes.filter(
        (c) => c.tagName === 'BUTTON' && c.className.split(/\s+/).indexOf('cp') >= 0,
      )[0]!;
      // The row's identity as the USER sees it: the key column's text.
      const keyCell = label ? label.childNodes[0] : undefined;
      return { key: keyCell ? keyCell.textContent : '', checkbox, radio, label, copy };
    });
  }

  function row(key: string): RowControls {
    const found = rows().filter((r) => r.key === key)[0];
    if (!found) throw new Error(`no rendered row labelled "${key}" (have: ${rows().map((r) => r.key).join(', ')})`);
    return found;
  }

  function confirmButton(): FakeNode {
    const host = panelHost();
    return findAll(host!, (n) => n.className === 'go')[0]!;
  }

  /** The bulk-display toolbar and its three parts. */
  function tools(): FakeNode | null {
    const host = panelHost();
    if (!host) return null;
    return findAll(host, (n) => n.className === 'tools')[0] || null;
  }
  function toolButton(cls: string): FakeNode {
    const bar = tools();
    if (!bar) throw new Error('the panel rendered no display toolbar');
    const found = findAll(bar, (n) => n.tagName === 'BUTTON' && n.className === cls)[0];
    if (!found) throw new Error(`no toolbar button ".${cls}"`);
    return found;
  }
  /**
   * Click a toolbar button the way a pointer does — which means honouring
   * `disabled`. The browser fires no click on a disabled button, so neither do
   * we; otherwise a passing test could describe a path that is unreachable on
   * screen.
   */
  function clickTool(cls: string) {
    const btn = toolButton(cls);
    if (btn.disabled) return;
    btn.fire('click');
  }

  /** The panel's own outer box — the thing that gets positioned. */
  function wrap(): FakeNode {
    const host = panelHost();
    return findAll(host!, (n) => n.className === 'wrap')[0]!;
  }

  /** The header strip: the drag handle, and the only one. */
  function header(): FakeNode {
    const host = panelHost();
    return findAll(host!, (n) => n.className.indexOf('hd') === 0)[0]!;
  }

  /** Where the panel currently is, in viewport coordinates. */
  function pos(): { left: number; top: number } {
    const s = wrap().style;
    return { left: parseFloat(s.left || 'NaN'), top: parseFloat(s.top || 'NaN') };
  }

  /**
   * The stylesheet the panel actually ships into its shadow root.
   *
   * Needed because `size()` below reports the FAKE box — the harness has no
   * layout engine, so it hands back whatever `rect` was set to. That fake is the
   * right tool for the clamp tests (they need to control the panel's height in
   * order to test a panel taller than the viewport), but it makes the fake the
   * only authority on the panel's WIDTH, which is not a fact the harness should
   * get to invent. The declared width has to be read from the real CSS.
   */
  function panelCss(): string {
    const host = panelHost();
    const style = findAll(host!, (n) => n.tagName === 'STYLE')[0];
    return style ? style.textContent : '';
  }

  /** The SELECTED ELEMENT section, and the values it is rendering. */
  function selBox(): FakeNode {
    const host = panelHost();
    if (!host) throw new Error('the panel has not been built');
    const found = findAll(host, (n) => n.className === 'sel')[0];
    if (!found) throw new Error('the panel rendered no SELECTED ELEMENT section');
    return found;
  }

  /**
   * The header's eye button.
   *
   * Found by class, and asserted to be a real BUTTON: it has to be reachable by
   * keyboard and announceable as a control, which a clickable <div> is not.
   */
  function eye(): FakeNode {
    const host = panelHost();
    if (!host) throw new Error('the panel has not been built');
    const found = findAll(host, (n) => n.tagName === 'BUTTON'
      && n.className.split(/\s+/).indexOf('ey') >= 0)[0];
    if (!found) throw new Error('the panel header rendered no selection toggle');
    return found;
  }

  /** One SELECTED ELEMENT entry's own copy button. */
  function selCopyButton(key: string): FakeNode {
    const host = panelHost();
    if (!host) throw new Error('the panel has not been built');
    const items = findAll(host, (n) => n.className.split(/\s+/).indexOf('sitem') >= 0);
    for (const item of items) {
      const k = item.childNodes.filter((c) => c.className.indexOf('sk') === 0)[0];
      const label = k ? k.textContent.replace(/\s*\u2192 sending$/, '') : '';
      if (label !== key) continue;
      const btn = item.childNodes.filter(
        (c) => c.tagName === 'BUTTON' && c.className.split(/\s+/).indexOf('cp') >= 0,
      )[0];
      if (!btn) throw new Error(`SELECTED ELEMENT entry "${key}" has no copy button`);
      return btn;
    }
    throw new Error(`no SELECTED ELEMENT entry labelled "${key}"`);
  }

  function selected(): Array<{ key: string; value: string; sending: boolean; empty: boolean }> {
    const host = panelHost();
    if (!host) return [];
    return findAll(host, (n) => n.className.split(/\s+/).indexOf('sitem') >= 0).map((item) => {
      const k = item.childNodes.filter((c) => c.className.indexOf('sk') === 0)[0];
      const v = item.childNodes.filter((c) => c.className.indexOf('sv') === 0)[0];
      const keyText = k ? k.textContent : '';
      return {
        // The marker is part of the key's text, so it is stripped out of `key`
        // and reported as `sending` instead — a test should assert the fact, not
        // the punctuation carrying it.
        key: keyText.replace(/\s*\u2192 sending$/, ''),
        value: v ? v.textContent : '',
        sending: /\u2192 sending$/.test(keyText),
        empty: !!v && v.className.indexOf('empty') >= 0,
      };
    });
  }

  return {
    wrap,
    header,
    pos,
    panelCss,
    /** The panel's box as the code measures it, so tests and code agree. */
    size: () => ({ w: wrap().rect.width, h: wrap().rect.height }),
    /** Pretend the pick produced a panel of this height, before picking. */
    setPanelHeight(h: number) { FakeNode.prototype.rect = { width: PANEL_W, height: h }; },
    viewport(w: number, hh: number) {
      windowFake.innerWidth = w;
      windowFake.innerHeight = hh;
    },
    fireResize() { (winListeners.resize || []).slice().forEach((fn) => fn({})); },
    /** One complete header drag: press, move (possibly several), release. */
    drag(from: { x: number; y: number }, ...to: Array<{ x: number; y: number }>) {
      const hd = header();
      hd.fire('pointerdown', { button: 0, pointerId: 7, clientX: from.x, clientY: from.y });
      to.forEach((p) => hd.fire('pointermove', { pointerId: 7, clientX: p.x, clientY: p.y }));
      hd.fire('pointerup', { pointerId: 7 });
    },
    dragStart(at: { x: number; y: number }, over?: FakeNode) {
      (over || header()).fire('pointerdown', {
        button: 0, pointerId: 7, clientX: at.x, clientY: at.y,
      });
    },
    dragMove(at: { x: number; y: number }) {
      header().fire('pointermove', { pointerId: 7, clientX: at.x, clientY: at.y });
    },
    stored,
    start: () => api.start(),
    stop: () => api.stop(),
    isActive: () => api.isActive(),
    pick(el: FakeEl) {
      (docListeners.click || []).slice().forEach((fn) => fn({
        target: el, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      }));
    },
    /**
     * A hover, which is the OTHER half of the picking gesture.
     *
     * Both `mousemove` and `mouseover` are dispatched because the picker binds
     * onMove to both — a test that fired only one could pass against an
     * implementation that had stopped guarding the other.
     */
    hover(el: FakeEl) {
      ['mousemove', 'mouseover'].forEach((t) => {
        (docListeners[t] || []).slice().forEach((fn) => fn({
          target: el, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
        }));
      });
    },
    /**
     * Whether the picker SWALLOWED a page click.
     *
     * This is the observable difference between selection on and off for a click
     * that lands on the page: while picking, the click must not also activate the
     * page (clicking a link would navigate away and take the pick with it), but
     * once selection is paused the page must get its clicks back — otherwise the
     * page is inert with no visible cause, which reads as the tool having hung.
     */
    clickWasSwallowed(el: FakeEl) {
      let prevented = false;
      (docListeners.click || []).slice().forEach((fn) => fn({
        target: el,
        preventDefault() { prevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() {},
      }));
      return prevented;
    },
    /** A keypress on the document, as onKey receives it. */
    key(name: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
      (docListeners.keydown || []).slice().forEach((fn) => fn({
        key: name,
        ctrlKey: !!mods.ctrlKey,
        shiftKey: !!mods.shiftKey,
        preventDefault() {}, stopPropagation() {},
      }));
    },
    rows,
    row,
    tick(key: string) {
      const cb = row(key).checkbox;
      cb.checked = !cb.checked;           // the browser flips it, THEN fires change
      cb.fire('change');
    },
    arm(key: string) {
      const target = row(key).radio;
      // Emulate the browser's radio-group behaviour: siblings sharing `name`
      // are unchecked before `change` fires on the newly checked one.
      rows().forEach((r) => { if (r.radio.name === target.name) r.radio.checked = false; });
      target.checked = true;
      target.fire('change');
    },
    clickLabel(key: string) { row(key).label.fire('click'); },
    confirm() { confirmButton().fire('click'); },
    toolsAll: () => toolButton('all'),
    toolsNone: () => toolButton('none'),
    selectAll() { clickTool('all'); },
    clearAll() { clickTool('none'); },
    toolsCount() {
      const bar = tools();
      if (!bar) return '';
      const n = findAll(bar, (x) => x.className === 'n')[0];
      return n ? n.textContent : '';
    },
    toolsVisible() {
      const bar = tools();
      return !!bar && bar.style.display !== 'none';
    },
    list() {
      const host = panelHost();
      return findAll(host!, (n) => n.className === 'rows')[0]!;
    },
    selected,
    selBox,
    selVisible() {
      const host = panelHost();
      if (!host) return false;
      const box = findAll(host, (n) => n.className === 'sel')[0];
      return !!box && box.style.display !== 'none';
    },
    selEmptyText() {
      const host = panelHost();
      if (!host) return '';
      const msg = findAll(host, (n) => n.className === 'sempty')[0];
      return msg ? msg.textContent : '';
    },
    selCopy: selCopyButton,

    // ── The 👁 toggle ───────────────────────────────────────────────────────
    eye,
    clickEye() { eye().fire('click'); },
    /**
     * Read from `aria-pressed`, which is the state as it is PUBLISHED — to a
     * screen reader, and to anyone inspecting the control. Reading the module's
     * private flag instead would let an implementation that forgot to paint the
     * button still pass.
     */
    selectionOn() { return eye().getAttribute('aria-pressed') === 'true'; },
    pausedText() {
      const host = panelHost();
      if (!host) return '';
      const note = findAll(host, (n) => n.className === 'pz')[0];
      if (!note || note.style.display === 'none') return '';
      return note.textContent;
    },
    /**
     * The highlight overlay: whether it is drawn, where, and what it says.
     *
     * A separate shadow host from the panel, so it is found from the document
     * root. The label matters as much as the box — it names the element the
     * picker is pointing at, and "the selected element remains visible" means
     * both parts stay put.
     */
    outline() {
      const hl = findAll(documentEl, (n) => n.id === 'ab-inspector-highlight')[0];
      if (!hl) return { visible: false, left: '', top: '', label: '' };
      const box = findAll(hl, (n) => n.className === 'box')[0];
      const tip = findAll(hl, (n) => n.className === 'tip')[0];
      return {
        visible: !!box && box.style.display === 'block',
        left: box ? (box.style.left || '') : '',
        top: box ? (box.style.top || '') : '',
        label: tip && tip.style.display === 'block' ? tip.textContent : '',
      };
    },

    // ── The clipboard ─────────────────────────────────────────────────────────
    clipboard,
    legacyCopies,
    failClipboard(on: boolean) { fail.modern = !!on; },
    failLegacy(on: boolean) { fail.legacy = !!on; },
    /**
     * Run every pending timer callback.
     *
     * Drained rather than iterated, because a callback may schedule another; and
     * each is replaced with a no-op first so a second flush cannot run the same
     * revert twice.
     */
    flushTimers() {
      while (pending.length) {
        const fn = pending.shift()!;
        fn();
      }
    },
    /**
     * Anything the clipboard fallback left in the page.
     *
     * The scratch <textarea> is removed in a `finally`, so this must always come
     * back empty — a stray one would be litter in the user's own document, on a
     * page we do not own.
     */
    strayNodes() {
      return body.childNodes.filter((n) => n.tagName === 'TEXTAREA');
    },
    /**
     * Drain the microtask queue so the copy's confirmation has been applied.
     *
     * Several ticks rather than one: the modern path resolves, then `copyValue`'s
     * own `.then` runs; the fallback path adds the rejection handler and the
     * legacy write on top. Awaiting a fixed number of ticks would make these
     * tests sensitive to the number of links in that chain — which is an
     * implementation detail, not behaviour anyone can observe.
     */
    async settle() {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },

    status() {
      const host = panelHost();
      const st = findAll(host!, (n) => n.className.indexOf('st') === 0)[0]!;
      return { text: st.textContent, kind: st.className.replace(/^st\s*/, '') };
    },
    sent,
    reply,
    confirmButton,
    get timeouts() { return timeouts; },
  };
}

/** The everyday element: id, classes, href, a data hook and visible text. */
function buyLink() {
  const el = new FakeEl('a', {
    id: 'buy', class: 'btn primary', href: '/checkout', 'data-sku': 'W-9',
  });
  el.innerText = 'Buy now';
  return el;
}

let h: Harness;
beforeEach(() => {
  // The panel height is a prototype-level default so a test can change it before
  // picking; reset it, or a tall-panel test would silently set the size for every
  // test that ran afterwards.
  FakeNode.prototype.rect = { width: PANEL_W, height: 420 };
  h = boot();
});

describe('inspector panel: the harness runs the real source', () => {
  it('exposes the real lifecycle and reacts to it', () => {
    // Guard: if this file ever stops executing the shipped source, every
    // assertion below would be testing a mock of itself.
    expect(h.isActive()).toBe(false);
    h.start();
    expect(h.isActive()).toBe(true);
    h.stop();
    expect(h.isActive()).toBe(false);
  });

  it('renders one row per extracted attribute, in the library\'s order', () => {
    h.start();
    h.pick(buyLink());
    // These come from the real ab-inspect.js, not from a fixture in this file.
    expect(h.rows().map((r) => r.key)).toEqual([
      'Tag Name', 'ID', 'Class', 'CSS Selector', 'XPath', 'Text', 'Role', 'href', 'data-sku',
    ]);
  });
});

describe('inspector panel: every row offers BOTH controls (§16)', () => {
  it('gives each row a display checkbox and a send radio', () => {
    h.start();
    h.pick(buyLink());
    const all = h.rows();
    expect(all.length).toBeGreaterThan(3);
    all.forEach((r) => {
      expect(r.checkbox.type).toBe('checkbox');
      expect(r.radio.type).toBe('radio');
    });
  });

  it('puts every radio in ONE group, so the browser enforces "exactly one"', () => {
    h.start();
    h.pick(buyLink());
    const names = Array.from(new Set(h.rows().map((r) => r.radio.name)));
    expect(names).toHaveLength(1);
    expect(names[0]).toBeTruthy();
  });

  it('pre-arms exactly one radio, and pre-ticks the default rows', () => {
    h.start();
    h.pick(buyLink());
    const armed = h.rows().filter((r) => r.radio.checked);
    // More than one armed radio would make the outbound value ambiguous; none
    // would cost the user an extra click in the common case.
    expect(armed).toHaveLength(1);
    expect(h.rows().filter((r) => r.checkbox.checked).length).toBeGreaterThan(0);
  });

  it('never pre-arms a radio on a row that has no value', () => {
    h.start();
    h.pick(buyLink());
    h.rows().forEach((r) => {
      if (r.radio.checked) expect(r.radio.disabled).toBe(false);
    });
  });
});

describe('inspector panel: checkboxes control DISPLAY only (§23)', () => {
  it('ticking a checkbox does not change which value is sent', () => {
    h.start();
    h.pick(buyLink());
    // Establish the baseline by SENDING, because that is the only place the
    // outbound choice is observable. Asserting on the rendered radio would not
    // do: the panel does not re-render on a tick, so a corrupted internal
    // choice would leave the stale radio looking correct and the test green.
    h.confirm();
    const baseline = h.sent[0]!.sendAttribute!;

    const fresh = boot();
    fresh.start();
    fresh.pick(buyLink());
    fresh.tick('Text');            // tick rows that are NOT the armed one
    fresh.tick('data-sku');
    fresh.confirm();

    expect(fresh.sent[0]!.sendAttribute).toEqual(baseline);
  });

  it('UN-ticking the row being sent does not disarm the send', () => {
    // The trap: treating one collection as both states means un-ticking the
    // armed row silently cancels the send, and Confirm then refuses for a
    // reason invisible on screen.
    h.start();
    h.pick(buyLink());
    const armed = h.rows().filter((r) => r.radio.checked)[0]!;
    const key = armed.key;
    expect(armed.checkbox.checked).toBe(true);

    const shownValue = armed.label.childNodes[1]!.textContent;

    h.tick(key);                                   // untick it
    expect(h.row(key).checkbox.checked).toBe(false);
    expect(h.row(key).radio.checked).toBe(true);   // still armed

    h.confirm();
    expect(h.sent).toHaveLength(1);
    // Still the same row, identified by the value the user could read on it.
    expect(h.sent[0]!.sendAttribute!.value).toBe(shownValue);
    // ...and it is correctly absent from the display list.
    expect(h.sent[0]!.displayAttributes).not.toContain(h.sent[0]!.sendAttribute!.name);
  });

  it('clicking the row text toggles display without arming the send', () => {
    h.start();
    h.pick(buyLink());
    h.confirm();
    const baseline = h.sent[0]!.sendAttribute!;

    const fresh = boot();
    fresh.start();
    fresh.pick(buyLink());
    fresh.clickLabel('data-sku');
    expect(fresh.row('data-sku').checkbox.checked).toBe(true);
    expect(fresh.row('data-sku').radio.checked).toBe(false);
    // Reading the list must not change what is sent — otherwise merely
    // scanning the rows silently re-aims the value.
    fresh.confirm();
    expect(fresh.sent[0]!.sendAttribute).toEqual(baseline);
    expect(fresh.sent[0]!.displayAttributes).toContain('data-sku');

    fresh.clickLabel('data-sku');                   // and back off again
    expect(fresh.row('data-sku').checkbox.checked).toBe(false);
  });

  it('ticking many boxes still sends exactly one value', () => {
    h.start();
    h.pick(buyLink());
    h.rows().forEach((r) => { if (!r.checkbox.checked) h.tick(r.key); });

    h.confirm();
    const msg = h.sent[0]!;
    expect(msg.displayAttributes!.length).toBeGreaterThan(5);
    // One name, one value — regardless of how much is on screen.
    expect(Object.keys(msg.sendAttribute!).sort()).toEqual(['name', 'value']);
    expect(typeof msg.sendAttribute!.name).toBe('string');
  });
});

// ════════════════════════════════════════════════════════════════
// The bulk DISPLAY toolbar — "Select all" / "Clear".
//
// The popup has had these since §19; this floating panel offered only
// one-at-a-time ticking, so an element with twenty data-* attributes cost
// twenty clicks. The risk in adding them is precise, and it is the risk §19
// named for the popup: a bulk control that reaches for "the selection" finds
// TWO selections here, and the convenient implementation — rebuild everything
// from one collection — quietly re-aims or disarms the outbound value. Nothing
// throws; the server simply receives a different value than the user chose.
//
// So these assertions are made where the user and the server can see them: the
// rendered controls, the "N of M shown" counter, and the payload handed to
// chrome.runtime.sendMessage. Never against the module's private state.
// ════════════════════════════════════════════════════════════════
describe('inspector panel: Select all / Clear are BULK DISPLAY only (§19)', () => {
  it('offers the two bulk actions, labelled as the user reads them', () => {
    h.start();
    h.pick(buyLink());
    expect(h.toolsAll().textContent).toMatch(/select all/i);
    expect(h.toolsNone().textContent).toMatch(/clear/i);
    expect(h.toolsVisible()).toBe(true);
  });

  it('Select all shows every row the pick produced', () => {
    h.start();
    h.pick(buyLink());
    // The library's default shows one row of nine, so there is real work to do —
    // which is the whole complaint this toolbar answers.
    expect(h.rows().filter((r) => r.checkbox.checked).length).toBeLessThan(h.rows().length);

    h.selectAll();

    const rows = h.rows();
    expect(rows.length).toBe(9);
    for (const r of rows) {
      expect(r.checkbox.checked, `row "${r.key}" should be shown`).toBe(true);
    }
  });

  it('shows a valueless row in bulk without making it sendable', () => {
    // The distinction §14 left behind: a boolean attribute like `reversed` is
    // worth SEEING and has nothing to send. A bulk select that forgot the
    // difference would offer to send it.
    h.start();
    h.pick(new FakeEl('ol', { reversed: '' }));
    h.selectAll();

    const empty = h.rows().filter((r) => r.label.childNodes[1]!.className.indexOf('empty') >= 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const r of empty) {
      expect(r.checkbox.checked).toBe(true);        // visible…
      expect(r.radio.disabled).toBe(true);          // …but still unsendable
    }
  });

  it('Select all does not change which value is sent', () => {
    // Checked against the PAYLOAD, not the radio: the panel re-renders the rows,
    // so a corrupted outbound choice would still paint a plausible-looking radio.
    h.start();
    h.pick(buyLink());
    h.confirm();
    const baseline = h.sent[0]!.sendAttribute!;

    const fresh = boot();
    fresh.start();
    fresh.pick(buyLink());
    fresh.selectAll();
    fresh.confirm();

    expect(fresh.sent[0]!.sendAttribute).toEqual(baseline);
  });

  it('Select all leaves the armed radio exactly where the user put it', () => {
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');

    h.selectAll();

    const armed = h.rows().filter((r) => r.radio.checked);
    expect(armed).toHaveLength(1);                  // still exactly one…
    expect(armed[0]!.key).toBe('data-sku');         // …and still that one
    h.confirm();
    expect(h.sent[0]!.sendAttribute).toEqual({ name: 'data-sku', value: 'W-9' });
  });

  it('Clear hides everything when nothing is armed', () => {
    // Reachable for real: with no selector generator, css/xpath arrive empty and
    // nothing is armable, so "clear" has no row it must protect.
    const bare = boot({ selectors: false });
    bare.start();
    bare.pick(new FakeEl('div', { 'data-x': 'v' }));
    expect(bare.rows().filter((r) => r.radio.checked)).toHaveLength(0);

    bare.selectAll();
    bare.clearAll();

    expect(bare.rows().filter((r) => r.checkbox.checked)).toHaveLength(0);
  });

  it('Clear never disarms the send', () => {
    // §19's stated failure mode: a "clear" that cancelled the send would leave
    // Confirm refusing for a reason invisible on screen.
    h.start();
    h.pick(buyLink());
    h.arm('href');

    h.clearAll();

    const armed = h.rows().filter((r) => r.radio.checked);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.key).toBe('href');
    h.confirm();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.sendAttribute!.name).toBe('href');
  });

  it('Clear keeps the row being SENT visible, so the panel stays honest', () => {
    // Arming forces that row's checkbox on, because sending a value the user
    // cannot see is indefensible. If Clear could hide it, the panel would claim
    // to send an attribute that appears nowhere in its own list.
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');

    h.clearAll();

    const shown = h.rows().filter((r) => r.checkbox.checked);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.key).toBe('data-sku');
    // The payload agrees: the name being sent appears in the display list.
    h.confirm();
    expect(h.sent[0]!.displayAttributes).toContain(h.sent[0]!.sendAttribute!.name);
  });

  it('counts what is shown out of what was found', () => {
    h.start();
    h.pick(buyLink());

    h.selectAll();
    expect(h.toolsCount()).toBe('9 of 9 shown');

    h.clearAll();
    // One row survives: the pre-armed one. The count must say so rather than
    // claim a tidy zero.
    expect(h.toolsCount()).toBe('1 of 9 shown');
  });

  it('keeps the count truthful when single rows are ticked one at a time', () => {
    // The count is drawn by the toolbar, the tick by the row. If they do not
    // share one repaint the number drifts, and a stale "9 of 9" is worse than
    // showing no count at all.
    h.start();
    h.pick(buyLink());

    h.selectAll();
    h.tick('data-sku');                             // untick one, via the box
    expect(h.toolsCount()).toBe('8 of 9 shown');

    h.clickLabel('data-sku');                       // and back on, via the label
    expect(h.toolsCount()).toBe('9 of 9 shown');
  });

  it('updates the count when arming a radio pulls a hidden row into view', () => {
    h.start();
    h.pick(buyLink());
    h.clearAll();
    expect(h.toolsCount()).toBe('1 of 9 shown');

    h.arm('Text');                                  // hidden; arming shows it

    expect(h.row('Text').checkbox.checked).toBe(true);
    expect(h.toolsCount()).toBe('2 of 9 shown');
  });

  it('disables each action once it can do nothing more', () => {
    // This panel floats over the user's own page: a button that swallows a click
    // with no visible effect reads as the panel having frozen.
    h.start();
    h.pick(buyLink());

    h.selectAll();
    expect(h.toolsAll().disabled).toBe(true);        // everything already shown
    expect(h.toolsNone().disabled).toBe(false);

    h.clearAll();
    expect(h.toolsAll().disabled).toBe(false);
    // A radio is armed here, so one row survived Clear and there is nothing
    // left for it to hide.
    expect(h.toolsNone().disabled).toBe(true);
  });

  it('re-enables Select all as soon as one row is un-ticked', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();
    expect(h.toolsAll().disabled).toBe(true);

    h.tick('data-sku');

    expect(h.toolsAll().disabled).toBe(false);
  });

  it('does not scroll the list back to the top on a bulk change', () => {
    // The user may have scrolled down to the data-* rows. A display toggle
    // changes no row count and no panel height, so it must not move the view.
    h.start();
    h.pick(buyLink());
    h.list().scrollTop = 120;

    h.selectAll();
    expect(h.list().scrollTop).toBe(120);

    h.clearAll();
    expect(h.list().scrollTop).toBe(120);
  });

  it('does not move a panel the user has already placed', () => {
    h.start();
    h.pick(buyLink());
    // The panel opens bottom-right, so it must be dragged UP AND LEFT to reach
    // somewhere the default placement could not also produce. Dragging down-right
    // clamps straight back to the opening corner, and the assertion below would
    // then hold no matter what the bulk action did to the position.
    const opened = h.pos();
    h.drag({ x: 1000, y: 400 }, { x: 400, y: 150 });
    const placed = h.pos();
    expect(placed).not.toEqual(opened);

    h.selectAll();

    expect(h.pos()).toEqual(placed);
  });

  it('publishes the bulk change to the popup, in panel order', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();

    const saved = h.stored.ab_lastPick as { display: string[]; sendKey: string };
    // Every row is shown, so the published list is the list itself — in the
    // order the user read it, which is what the popup restores.
    expect(saved.display).toEqual(['tag', 'id', 'class', 'css', 'xpath', 'text', 'role', 'href', 'data-sku']);
    expect(saved.sendKey).toBe('css');              // untouched by the bulk edit
  });

  it('publishes a Clear as the one surviving row', () => {
    h.start();
    h.pick(buyLink());
    h.clearAll();

    const saved = h.stored.ab_lastPick as { display: string[]; sendKey: string };
    expect(saved.display).toEqual(['css']);
    expect(saved.sendKey).toBe('css');
  });

  it('starts each new pick from a fresh toolbar', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();
    expect(h.toolsAll().disabled).toBe(true);

    h.pick(new FakeEl('div', { 'data-y': 'z' }));

    // The second pick shows the library's default, not the first pick's
    // "everything" — otherwise the toolbar would look pressed for an element
    // the user never bulk-selected.
    expect(h.toolsAll().disabled).toBe(false);
    expect(h.rows().filter((r) => r.checkbox.checked)).toHaveLength(1);
  });

  it('draws the toolbar above the list, not inside it', () => {
    // It is a header FOR the rows; rendered as a row IN them it would scroll
    // away exactly when a long list makes it useful.
    h.start();
    h.pick(buyLink());
    const bar = h.toolsAll().parentElement!;
    expect(bar.className).toBe('tools');
    expect(bar.parentElement).toBe(h.wrap());
    expect(h.list().childNodes.filter((n) => n.className === 'tools')).toHaveLength(0);
    // …and before the list in document order.
    const kids = h.wrap().childNodes;
    expect(kids.indexOf(bar)).toBeLessThan(kids.indexOf(h.list()));
  });
});

// ════════════════════════════════════════════════════════════════
// SELECTED ELEMENT, IN THE PICKER (§17)
//
// THE REPORTED BUG
// ----------------
// The picker showed a ticked value only as a clipped, single-line preview:
// «چیزی که اونجا نمایش میده یه پیش نمایش نیم سطری هست». Every `.v` cell is
// nowrap + ellipsis by design (equal row heights are what keep a long list
// aligned and scannable), so at 330px a CSS Selector rendered as
// "div.bubble > div.desc:nth-of…" and an XPath as "/html[1]/body[1]/div[1]…".
// The full string lived only in a `title` tooltip.
//
// That is the wrong place for it. The value the user is committing to a node
// field has to be READABLE — comparable against the other candidates, and
// copyable — and the popup already renders exactly that, in full, in its
// SELECTED ELEMENT card. The picker lacking the section meant the two surfaces
// of one feature answered "what did I just select?" differently, and the
// picker's answer was the truncated one, on the surface the user is actually
// looking at while they tick.
//
// WHAT THESE TESTS PIN
// --------------------
// Not the CSS — that the section exists, is driven by the CHECKBOXES alone,
// renders values WHOLE and untruncated, and keeps §16/§23 intact: it must never
// become a view of the radio. The last part matters most, because "show the
// selected things" and "show the thing being sent" are one refactor apart, and
// collapsing them would silently redefine what the panel is claiming.
// ════════════════════════════════════════════════════════════════
describe('inspector panel: SELECTED ELEMENT shows ticked values in full (§17)', () => {
  it('renders a section for the pick, above the rows that edit it', () => {
    h.start();
    h.pick(buyLink());

    expect(h.selVisible()).toBe(true);
    // Above the toolbar and the list: the readable statement of the pick comes
    // first, the controls that change it follow. Below the scrolling list it
    // would be off-screen exactly when a long list makes the clipping bite.
    const kids = h.wrap().childNodes;
    expect(kids.indexOf(h.selBox())).toBeLessThan(kids.indexOf(h.list()));
    expect(kids.indexOf(h.selBox())).toBeLessThan(kids.indexOf(h.toolsAll().parentElement!));
  });

  it('shows nothing at all before an element has been picked', () => {
    // Arming the picker describes no element yet, so there is nothing to state.
    // An empty card above the rows would be furniture.
    h.start();
    expect(h.selVisible()).toBe(false);
  });

  it('starts by showing exactly the rows the pick pre-ticked', () => {
    h.start();
    h.pick(buyLink());

    // ab-inspect's defaultSelection for this element is ['css', 'href'] — the
    // same set the checkboxes open with, which is the whole contract: this
    // section is the checkbox column, made readable.
    expect(h.selected().map((s) => s.key)).toEqual(['CSS Selector', 'href']);
    expect(h.rows().filter((r) => r.checkbox.checked).map((r) => r.key))
      .toEqual(['CSS Selector', 'href']);
  });

  it('shows the WHOLE value, not the row\'s clipped preview', () => {
    /*
     * The point of the entire section. A selector long enough to be truncated in
     * a 330px row must appear here complete — that is the difference between a
     * user being able to verify what they are about to send and having to trust a
     * tooltip.
     */
    const long = new FakeEl('div', {
      class: 'bubble desc conversation-body streaming',
      'data-source-line': '1-1',
    });
    long.innerText = 'Unsere Konversation wird kommentiert und kann einige Minuten dauern...';

    h.start();
    h.pick(long);
    h.tick('Text');

    const text = h.selected().filter((s) => s.key === 'Text')[0]!;
    expect(text.value).toBe(
      'Unsere Konversation wird kommentiert und kann einige Minuten dauern...',
    );
    // Explicitly NOT the row's presentation: no ellipsis, and nothing lost.
    expect(text.value).not.toContain('\u2026');
    expect(text.value.length).toBeGreaterThan(40);
  });

  it('is the value the ROW carries, so the two views cannot disagree', () => {
    h.start();
    h.pick(buyLink());
    h.tick('XPath');

    // The row clips visually but its `title` holds the full value; the readout
    // must equal THAT, not some separately-derived string.
    const cell = h.row('XPath').label.childNodes[1]!;
    const shown = h.selected().filter((s) => s.key === 'XPath')[0]!;
    expect(shown.value).toBe(cell.title);
    expect(shown.value).toBe('//*[@id="buy"]');
  });

  it('follows the checkbox: ticking adds a value, un-ticking removes it', () => {
    h.start();
    h.pick(buyLink());

    h.tick('XPath');
    expect(h.selected().map((s) => s.key)).toContain('XPath');

    h.tick('XPath');
    expect(h.selected().map((s) => s.key)).not.toContain('XPath');

    // §17's own example, in miniature: it must happen dynamically, on each
    // change, rather than once when the panel opened.
    h.tick('Class');
    expect(h.selected().map((s) => s.key)).toContain('Class');
  });

  it('reacts to the row label too, which is the same checkbox', () => {
    h.start();
    h.pick(buyLink());
    h.clickLabel('ID');
    expect(h.selected().map((s) => s.key)).toContain('ID');
  });

  it('lists values in PANEL order, not in the order they were ticked', () => {
    h.start();
    h.pick(buyLink());
    h.clearAll();

    // Ticked bottom-up on purpose: tick order would render data-sku first.
    h.tick('data-sku');
    h.tick('Tag Name');

    // Panel order keeps the readout stable — a section that reshuffled itself on
    // every tick would be unreadable precisely while being edited.
    expect(h.selected().map((s) => s.key)).toEqual(['Tag Name', 'CSS Selector', 'data-sku']);
  });

  it('shows every row after Select all', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();

    expect(h.selected().map((s) => s.key)).toEqual([
      'Tag Name', 'ID', 'Class', 'CSS Selector', 'XPath', 'Text', 'Role', 'href', 'data-sku',
    ]);
  });

  it('explains itself when the user clears everything, rather than vanishing', () => {
    h.start();
    h.pick(buyLink());
    h.clearAll();

    // Clear keeps the ARMED row visible (see the bulk-display suite), so the
    // section still holds that one. Un-tick it and the readout is genuinely
    // empty — a state the user produced and can undo, so it stays on screen and
    // names the control that refills it.
    h.tick('CSS Selector');

    expect(h.selected()).toEqual([]);
    expect(h.selVisible()).toBe(true);
    expect(h.selEmptyText()).toMatch(/check a row/i);
  });

  it('renders a valueless row as empty instead of omitting it', () => {
    // A boolean attribute like `reversed` is worth SEEING even though it has no
    // value to send. Dropping it from the readout would make a ticked box
    // correspond to nothing on screen.
    h.start();
    h.pick(new FakeEl('ol', { reversed: '', id: 'list' }));
    h.selectAll();

    const rev = h.selected().filter((s) => s.key === 'reversed')[0];
    expect(rev, 'the valueless row must still appear').toBeTruthy();
    expect(rev!.empty).toBe(true);
  });

  it('marks which single value is actually being sent', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();
    h.arm('XPath');

    const sending = h.selected().filter((s) => s.sending);
    // Exactly one, and it is the armed row — the readout answers "which of these
    // travels?" without the user having to look back at the radio column.
    expect(sending.map((s) => s.key)).toEqual(['XPath']);
  });

  it('is NOT a view of the radio: every ticked value stays listed (§16/§23)', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();
    h.arm('XPath');

    // The obvious "simplification" is to show only what is being sent. That
    // would destroy the section's purpose: the user ticks several candidates in
    // order to COMPARE them before committing to one.
    expect(h.selected().length).toBe(9);
    expect(h.selected().map((s) => s.key)).toContain('href');
    expect(h.selected().map((s) => s.key)).toContain('Text');
  });

  it('arming a row pulls it into the readout, because sending implies seeing', () => {
    h.start();
    h.pick(buyLink());
    h.clearAll();
    h.tick('CSS Selector');            // now genuinely nothing is shown
    expect(h.selected()).toEqual([]);

    h.arm('data-sku');

    // The radio handler ticks the row it arms, so the value it is about to send
    // cannot be one the panel is hiding.
    const shown = h.selected();
    expect(shown.map((s) => s.key)).toEqual(['data-sku']);
    expect(shown[0]!.sending).toBe(true);
  });

  it('re-picking replaces the readout instead of accumulating picks', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();
    expect(h.selected().length).toBe(9);

    h.pick(new FakeEl('div', { 'data-y': 'z' }));

    // Nothing from the previous element may survive: a stale value here would be
    // a value the user believes belongs to the element they just picked.
    expect(h.selected().map((s) => s.key)).not.toContain('href');
    expect(h.selected().every((s) => s.value !== '/checkout')).toBe(true);
  });

  it('resets its own scroll on a new pick', () => {
    h.start();
    h.pick(buyLink());
    h.selBox().scrollTop = 90;

    h.pick(new FakeEl('div', { 'data-y': 'z' }));

    // The section scrolls independently of the rows, so it needs its own reset —
    // otherwise a new pick opens part-way into the first value.
    expect(h.selBox().scrollTop).toBe(0);
  });

  it('does not jump its scroll on a mere display toggle', () => {
    h.start();
    h.pick(buyLink());
    h.selBox().scrollTop = 40;

    h.tick('XPath');

    // Ticking a box while reading a long value must not throw away the reading
    // position: the tick is how you ask to read, so it cannot also scroll away.
    expect(h.selBox().scrollTop).toBe(40);
  });

  it('cannot grow tall enough to push the rows or the footer off screen', () => {
    h.start();
    h.pick(buyLink());

    /*
     * The section holds arbitrary page strings, so its natural height is
     * unbounded. Inside a 70vh panel that would crowd out the attribute rows and
     * the footer — reintroducing, by a different route, the exact "the Confirm
     * button is unreachable" bug the position suite exists to prevent.
     * A capped, independently scrolling box is what keeps it a readout.
     */
    const css = h.panelCss();
    const rule = /\.sel\{[^}]*\}/.exec(css);
    expect(rule, '.sel rule must exist in the picker stylesheet').not.toBeNull();
    expect(rule![0]).toMatch(/max-height:\d+vh/);
    expect(rule![0]).toContain('overflow:auto');
    // And it must not be a flex item that grows: `flex:0 0 auto` is what stops it
    // taking the space the rows need.
    expect(rule![0]).toContain('flex:0 0 auto');
  });

  it('wraps long values rather than clipping them, unlike the rows', () => {
    h.start();
    h.pick(buyLink());

    // The rows' `.v` is nowrap+ellipsis on purpose; this section is the place
    // that must NOT be, or it would merely repeat the preview it exists to fix.
    const css = h.panelCss();
    const rule = /\.sv\{[^}]*\}/.exec(css);
    expect(rule, '.sv rule must exist in the picker stylesheet').not.toBeNull();
    expect(rule![0]).toContain('overflow-wrap:anywhere');
    expect(rule![0]).not.toContain('white-space:nowrap');
    expect(rule![0]).not.toContain('text-overflow:ellipsis');
    // Selectable, because the reason to want a full value on screen is often to
    // copy it — and the header's `user-select:none` must not reach down here.
    expect(rule![0]).toContain('user-select:text');
  });

  it('renders values as text, never as markup', () => {
    /*
     * These strings come from an arbitrary page. The section is the one place
     * that prints them at full length, so it is the most tempting place for an
     * innerHTML "convenience" — and the one where it would hand the inspected
     * site script execution inside our own closed-shadow UI.
     */
    const hostile = new FakeEl('div', {
      'data-x': '<img src=x onerror=alert(1)>',
      id: 'q',
    });
    h.start();
    h.pick(hostile);
    h.selectAll();

    const shown = h.selected().filter((s) => s.key === 'data-x')[0]!;
    // Present verbatim as TEXT: not stripped, not parsed.
    expect(shown.value).toBe('<img src=x onerror=alert(1)>');
    expect(h.panelCss()).not.toContain('innerHTML');
  });

  it('never sends more because more is displayed', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();
    h.arm('href');
    h.confirm();

    // The readout is a view. Exactly one value still travels, and it is the
    // radio's — the guarantee that a bigger SELECTED ELEMENT never means a
    // bigger payload.
    const msg = h.sent[0]!;
    expect(msg.sendAttribute).toEqual({ name: 'href', value: '/checkout' });
    expect(msg.displayAttributes!.length).toBe(9);
  });
});

describe('inspector panel: the radio decides the ONE outbound value (§21)', () => {
  it('arming a radio changes the sent attribute', () => {
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');
    h.confirm();
    expect(h.sent[0]!.sendAttribute).toEqual({ name: 'data-sku', value: 'W-9' });
  });

  it('arming a radio also shows the row, because sending implies looking', () => {
    h.start();
    h.pick(buyLink());
    expect(h.row('Text').checkbox.checked).toBe(false);

    h.arm('Text');

    expect(h.row('Text').checkbox.checked).toBe(true);
    h.confirm();
    expect(h.sent[0]!.displayAttributes).toContain('text');
    expect(h.sent[0]!.sendAttribute!.name).toBe('text');
  });

  it('re-arming replaces the previous choice rather than adding to it', () => {
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');
    h.arm('XPath');
    h.confirm();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.sendAttribute!.name).toBe('xpath');
  });

  it('sends the value the user saw on the armed row', () => {
    h.start();
    h.pick(buyLink());
    h.arm('ID');
    h.confirm();
    // Not "some id", but exactly the string rendered in that row.
    expect(h.sent[0]!.sendAttribute).toEqual({ name: 'id', value: 'buy' });
  });
});

describe('inspector panel: a valueless row cannot be sent (§14 aftermath)', () => {
  it('disables the radio on a row whose value is empty', () => {
    // §14 keeps genuinely ABSENT attributes out of the list; what survives
    // empty is a boolean attribute like `reversed` — worth seeing, impossible
    // to send.
    h.start();
    const ol = new FakeEl('ol', { reversed: '' });
    h.pick(ol);
    const reversed = h.row('reversed');
    expect(reversed.radio.disabled).toBe(true);
    expect(reversed.radio.checked).toBe(false);
  });

  it('leaves the valued rows on the same element armable', () => {
    h.start();
    h.pick(new FakeEl('ol', { reversed: '' }));
    expect(h.row('CSS Selector').radio.disabled).toBe(false);
    // The empty row is still VISIBLE and tickable — it just cannot be sent.
    expect(h.row('reversed').checkbox.disabled).toBe(false);
  });
});

describe('inspector panel: submit refuses locally, without a round trip', () => {
  it('refuses when no radio is armed, and says which control to use', () => {
    // Reachable for real: with no selector generator available, css/xpath come
    // through present-but-empty, so nothing is armable by default.
    const bare = boot({ selectors: false });
    bare.start();
    bare.pick(new FakeEl('div'));
    expect(bare.rows().filter((r) => r.radio.checked)).toHaveLength(0);

    bare.confirm();

    expect(bare.sent).toHaveLength(0);           // nothing left the machine
    expect(bare.status().kind).toBe('err');
    expect(bare.status().text).toMatch(/choose the one attribute/i);
  });

  it('does not close the panel after refusing, so the user can fix it', () => {
    const bare = boot({ selectors: false });
    bare.start();
    bare.pick(new FakeEl('div'));
    bare.confirm();
    expect(bare.timeouts).toBe(0);               // no scheduled auto-close
    expect(bare.isActive()).toBe(true);
    expect(bare.rows().length).toBeGreaterThan(0);
  });

  it('lets the user recover by arming a row, then sends', () => {
    const bare = boot({ selectors: false });
    bare.start();
    bare.pick(new FakeEl('div', { 'data-x': 'v' }));
    bare.confirm();
    expect(bare.sent).toHaveLength(0);

    bare.arm('data-x');
    bare.confirm();
    expect(bare.sent).toHaveLength(1);
    expect(bare.sent[0]!.sendAttribute).toEqual({ name: 'data-x', value: 'v' });
  });
});

describe('inspector panel: the payload (§21/§23)', () => {
  it('carries display and send as two separate collections', () => {
    h.start();
    h.pick(buyLink());
    h.confirm();
    const msg = h.sent[0]!;
    expect(Array.isArray(msg.displayAttributes)).toBe(true);
    expect(msg.sendAttribute).toBeTruthy();
    // If these ever merge, the server can no longer tell "shown" from "sent".
    expect(msg.displayAttributes).not.toEqual(msg.sendAttribute);
  });

  it('lists displayAttributes in PANEL order, not click order', () => {
    h.start();
    h.pick(buyLink());
    // Start from a clean slate, then tick from the bottom up.
    h.rows().forEach((r) => { if (r.checkbox.checked) h.tick(r.key); });
    h.tick('data-sku');
    h.tick('Text');
    h.tick('ID');
    h.arm('ID');

    h.confirm();
    // Panel order is id → text → data-sku, the reverse of the click order.
    expect(h.sent[0]!.displayAttributes).toEqual(['id', 'text', 'data-sku']);
  });

  it('sends the described element alongside the two selections', () => {
    h.start();
    h.pick(buyLink());
    h.confirm();
    const msg = h.sent[0]!;
    expect(msg.type).toBe('ab-inspector-submit');
    expect(msg.element).toBeTruthy();
    expect((msg.element as Record<string, unknown>).url).toBe('https://shop.test/p/1');
  });

  it('never carries a target of its own choosing', () => {
    // §8: the destination is the extension's stored pairing, resolved by the
    // server. A targetFieldId invented in the page would be a way to aim at
    // someone else's field.
    h.start();
    h.pick(buyLink());
    h.confirm();
    const keys = Object.keys(h.sent[0]!).sort();
    expect(keys).toEqual(['displayAttributes', 'element', 'sendAttribute', 'type']);
  });
});

describe('inspector panel: what the user is told afterwards (§24)', () => {
  it('names the node AND the field the value landed in', () => {
    h.start();
    h.pick(buyLink());
    h.confirm();
    const st = h.status();
    expect(st.kind).toBe('ok');
    expect(st.text).toContain('HTTP Request');
    expect(st.text).toContain('url');
    expect(st.text).toContain('href');
  });

  it('shows the backend\'s refusal verbatim instead of a generic failure', () => {
    h.start();
    h.pick(buyLink());
    h.reply.value = {
      ok: false, reason: 'TARGET_NOT_AUTHORIZED',
      error: 'This Inspector is not authorized for that Field. Enter an Authorization Code first.',
    };
    h.confirm();
    // Knowing to enter a code is the difference between recovering and
    // concluding the feature is broken.
    expect(h.status().kind).toBe('err');
    expect(h.status().text).toMatch(/Authorization Code/);
  });

  it('re-enables Confirm after a refusal so the user can retry', () => {
    h.start();
    h.pick(buyLink());
    h.reply.value = { ok: false, reason: 'BACKEND_UNREACHABLE', error: 'Cannot reach the project.' };
    h.confirm();
    expect(h.confirmButton().disabled).toBe(false);
  });
});

describe('inspector panel: both states reset between picks', () => {
  // NOTE, recorded so the next reader does not mistake this for a gap: the
  // clearing inside stop() is defence-in-depth, not observable behaviour.
  // freezeOn() recomputes rows, display and sendKey from the newly picked
  // element on every pick, so deleting stop()'s resets changes no outcome these
  // tests can reach (verified by mutation — an equivalent mutant). What IS
  // observable, and is asserted, is the guarantee itself: no selection from a
  // previous pick may survive into the next one.
  it('carries no selection from a previous pick into the next one', () => {
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');
    h.stop();

    h.start();
    h.pick(buyLink());
    // A stale `data-sku` arming would send an attribute the user never chose
    // this time round.
    const armed = h.rows().filter((r) => r.radio.checked);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.key).toBe('CSS Selector');
  });

  it('re-picking a different element re-derives both selections', () => {
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');

    h.pick(new FakeEl('ol', { reversed: '' }));
    expect(h.rows().map((r) => r.key)).not.toContain('data-sku');
    const armed = h.rows().filter((r) => r.radio.checked);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.radio.disabled).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// WHERE THE PANEL OPENS
//
// The reported bug: the picker opened partly outside the viewport, so Cancel and
// Confirm — the only two ways to resolve a pick — could not be clicked. The panel
// was pinned with a hard-coded `right:16px; bottom:16px` in CSS and its real size
// was never compared against the window, so any viewport shorter than the panel
// pushed the footer below the fold.
//
// These tests are written against COORDINATES rather than against the CSS text,
// because the fix is arithmetic: the panel must be inside the viewport for panels
// of any height, in windows of any size. Asserting the stylesheet says "left"
// would pass for an implementation that computes the wrong left.
//
// The size is NOT asserted to have changed, and must not: the issue was never
// that the picker was too small or too large.
// ════════════════════════════════════════════════════════════════
describe('picker position: the whole panel is always on screen', () => {
  const EDGE = 12;

  /** Every corner of the panel, given where it is and how big it measures. */
  function box() {
    const p = h.pos();
    const s = h.size();
    return { left: p.left, top: p.top, right: p.left + s.w, bottom: p.top + s.h };
  }

  it('is positioned in left/top, which is what makes it clampable at all', () => {
    h.start();
    h.pick(buyLink());
    // right/bottom pinning was the root cause: it leaves no coordinate to
    // compare against the viewport and nothing for a drag to write.
    const s = h.wrap().style;
    expect(s.left).toMatch(/px$/);
    expect(s.top).toMatch(/px$/);
    expect(Number.isFinite(h.pos().left)).toBe(true);
    expect(Number.isFinite(h.pos().top)).toBe(true);
  });

  it('opens fully inside a normal viewport', () => {
    h.start();
    h.pick(buyLink());
    const b = box();
    expect(b.left).toBeGreaterThanOrEqual(EDGE);
    expect(b.top).toBeGreaterThanOrEqual(EDGE);
    expect(b.right).toBeLessThanOrEqual(1280 - EDGE);
    expect(b.bottom).toBeLessThanOrEqual(800 - EDGE);
  });

  it('keeps the footer on screen when the panel is TALLER than it is deep', () => {
    // The exact reported failure. A pick with many attributes makes a tall panel;
    // in a short window the old code left Confirm and Cancel below the bottom
    // edge, which is a dead end — the rows are visible and cannot be acted on.
    h.setPanelHeight(700);
    h.viewport(1280, 560);
    h.start();
    h.pick(buyLink());
    expect(h.pos().top).toBeGreaterThanOrEqual(EDGE);
    // Not off the top either: the header is the drag handle and the only way out
    // of a bad position, so it must never be the part that is lost.
    expect(h.pos().top).toBeLessThan(560);
  });

  it('never pushes the header off the top, even in an absurdly short window', () => {
    h.setPanelHeight(900);
    h.viewport(1280, 200);
    h.start();
    h.pick(buyLink());
    // Clamping only against the bottom edge would give a negative top here and
    // put the drag handle out of reach — losing the bottom of a scrollable list
    // is recoverable; losing the header is not.
    expect(h.pos().top).toBeGreaterThanOrEqual(EDGE);
    expect(h.pos().left).toBeGreaterThanOrEqual(EDGE);
  });

  it('fits itself into a narrow viewport rather than hanging off the right', () => {
    h.viewport(420, 800);
    h.start();
    h.pick(buyLink());
    expect(h.pos().left).toBeGreaterThanOrEqual(EDGE);
    expect(h.pos().left).toBeLessThan(420);
  });

  it('re-clamps when the window shrinks AFTER the panel opened', () => {
    h.start();
    h.pick(buyLink());
    const before = h.pos();
    expect(before.left).toBeGreaterThan(400);   // parked bottom-right by default

    // Smaller than the panel's default corner, but still big enough to hold it:
    // this is the ordinary "user narrowed the window" case, where nothing needs
    // to be sacrificed and so nothing may be.
    h.viewport(600, 600);
    h.fireResize();

    const b = box();
    expect(b.left).toBeGreaterThanOrEqual(EDGE);
    expect(b.top).toBeGreaterThanOrEqual(EDGE);
    expect(b.right).toBeLessThanOrEqual(600 - EDGE);
    expect(b.bottom).toBeLessThanOrEqual(600 - EDGE);
    // It genuinely moved — a no-op that happened to satisfy the bounds would be
    // indistinguishable from the bug otherwise.
    expect(b.left).toBeLessThan(before.left);
  });

  it('sacrifices the bottom, never the header, when it cannot fit at all', () => {
    h.start();
    h.pick(buyLink());
    // A viewport shorter than the panel. Something has to go off-screen; the rows
    // scroll, so losing their bottom is recoverable — losing the header takes the
    // drag handle and both header buttons with it.
    h.viewport(1280, 300);
    h.fireResize();
    expect(h.pos().top).toBe(EDGE);
    expect(h.pos().left).toBeGreaterThanOrEqual(EDGE);
  });

  it('is the width the design document specifies, and only that width', () => {
    h.start();
    h.pick(buyLink());
    // §16 forbids resizing the picker to work around the position bugs —
    // «resize یا افزایش ابعاد انجام نده» — and names one exception: «مگر اینکه
    // extension/UI_UX صراحتاً ابعاد دیگری برای Picker تعریف کرده باشد». The
    // supplied picker.html sets `--w:330px`, which is that exception: an explicit
    // dimension in the design, not a workaround for visibility. The two bugs were
    // fixed by clamping and dragging, which is what §16 is actually protecting.
    //
    // Pinned to an exact number for the same reason as before: so a future
    // attempt to "fix" an off-screen panel by shrinking or growing it fails here
    // instead of silently redesigning the tool.
    //
    // Read from the shipped stylesheet, not from h.size(): the harness's fake DOM
    // has no layout engine, so h.size() returns whatever `rect` was set to and
    // would agree with any number asked of it. The stylesheet is the only place
    // the width is actually decided.
    expect(h.panelCss()).toContain(`width:${PANEL_W}px`);
    // And it must still be allowed to shrink. A hard 330px in a 300px-wide window
    // would push the panel's own right edge off-screen — the exact class of bug
    // this suite exists to prevent — so the design's max-width escape hatch is
    // part of the requirement, not an optional extra.
    expect(h.panelCss()).toMatch(/max-width:calc\(100vw - \d+px\)/);
  });

  it('clips long attribute values to one line instead of wrapping them', () => {
    h.start();
    h.pick(buyLink());

    /*
     * Attribute values are arbitrary page strings: hrefs with query strings,
     * XPaths, long class lists. Letting them wrap seemed generous but produced
     * two visible faults at 330px — values broken mid-token ("…chec / kout?sku=A1")
     * and rows of differing heights, which destroyed the alignment of the key
     * column that makes a long list scannable.
     *
     * The design's own `.v` rule is nowrap + ellipsis, so this is also the
     * specified behaviour and not merely a preference.
     */
    const css = h.panelCss();
    const vRule = /\.v\{[^}]*\}/.exec(css);
    expect(vRule, '.v rule must exist in the picker stylesheet').not.toBeNull();
    expect(vRule![0]).toContain('white-space:nowrap');
    expect(vRule![0]).toContain('text-overflow:ellipsis');
    // break-all is what caused the mid-word breaks; its absence is the fix.
    expect(vRule![0]).not.toContain('word-break:break-all');

    /*
     * Clipping only stays acceptable while the whole value is still recoverable,
     * because the clipped tail is frequently the part being hunted (`?sku=A1`).
     * The tooltip is that escape hatch, so it is part of the requirement rather
     * than a nicety.
     */
    // Asserted on every non-empty row rather than on one hand-picked long value:
    // which value happens to be long is a property of the fixture, but the
    // tooltip has to be there for all of them, since any of them can be clipped
    // by a narrow viewport.
    const withValues = h.rows().filter((r) => {
      const cell = r.label.childNodes[1];
      return cell && cell.className === 'v';
    });
    expect(withValues.length, 'the fixture must render some non-empty rows').toBeGreaterThan(0);
    for (const r of withValues) {
      const cell = r.label.childNodes[1];
      expect(cell.title, `row "${r.key}" must carry its full value as a tooltip`)
        .toBe(cell.textContent);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// DRAGGING THE PANEL
//
// The second reported bug: the picker could not be moved at all, so when it
// covered the element being inspected there was nothing the user could do. There
// was no pointer handler on the header — and because position was expressed in
// right/bottom, writing `style.left` would not have moved it anyway.
//
// The rule being defended is narrow: the HEADER drags, the BODY does not. A
// draggable body would turn every attempt to tick a checkbox or select a value
// into a window move.
// ════════════════════════════════════════════════════════════════
describe('picker drag: the header moves it, the body does not', () => {
  const EDGE = 12;

  it('moves by exactly the pointer delta', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();

    // Press somewhere on the header, move 120 left and 90 up.
    h.drag({ x: from.left + 40, y: from.top + 10 },
           { x: from.left + 40 - 120, y: from.top + 10 - 90 });

    expect(h.pos().left).toBe(from.left - 120);
    expect(h.pos().top).toBe(from.top - 90);
  });

  it('does not jump under the cursor on the first frame', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    // Press and move by ZERO: the panel must not move. This is what the grab
    // offset is for — anchoring from the press point rather than from the
    // panel's corner, which would snap it to the cursor.
    h.drag({ x: from.left + 200, y: from.top + 15 },
           { x: from.left + 200, y: from.top + 15 });
    expect(h.pos()).toEqual(from);
  });

  it('cannot be dragged out of the viewport', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    // A hard throw at the top-left corner, well past it.
    h.drag({ x: from.left + 20, y: from.top + 10 }, { x: -4000, y: -4000 });
    expect(h.pos().left).toBeGreaterThanOrEqual(EDGE);
    expect(h.pos().top).toBeGreaterThanOrEqual(EDGE);

    // And at the bottom-right.
    const now = h.pos();
    h.drag({ x: now.left + 20, y: now.top + 10 }, { x: 9000, y: 9000 });
    const s = h.size();
    expect(h.pos().left + s.w).toBeLessThanOrEqual(1280 - EDGE + 1);
    expect(h.pos().top + s.h).toBeLessThanOrEqual(800 - EDGE + 1);
  });

  it('stays clamped DURING the drag, not merely once it ends', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    h.dragStart({ x: from.left + 20, y: from.top + 10 });
    // Mid-gesture, still held down, dragged off the top-left.
    h.dragMove({ x: -2000, y: -2000 });
    expect(h.pos().left).toBeGreaterThanOrEqual(EDGE);
    expect(h.pos().top).toBeGreaterThanOrEqual(EDGE);
  });

  it('suppresses the browser default so dragging selects no text', () => {
    h.start();
    h.pick(buyLink());
    let prevented = false;
    const hd = h.header();
    (hd.listeners.pointerdown || []).forEach((fn) => fn({
      button: 0, pointerId: 7, clientX: 100, clientY: 100,
      preventDefault() { prevented = true; }, stopPropagation() {}, target: hd,
    }));
    // Without this the press would begin a text selection that then follows the
    // cursor across the page for the whole gesture.
    expect(prevented).toBe(true);
  });

  it('ignores the right mouse button', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    const hd = h.header();
    hd.fire('pointerdown', { button: 2, pointerId: 7, clientX: from.left + 20, clientY: from.top + 10 });
    hd.fire('pointermove', { pointerId: 7, clientX: 0, clientY: 0 });
    // A right-click opens a context menu; it must not silently begin a move that
    // ends on the user's next click.
    expect(h.pos()).toEqual(from);
  });

  it('does not drag when the press lands on a header BUTTON', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    // "Pick again" / ✕ stop the gesture before it reaches the handle. Without
    // this a press that wanders a pixel — most presses — would move the panel and
    // swallow the click, exactly when the user is escaping a bad pick.
    const button = h.header().childNodes.filter((c) => c.tagName === 'BUTTON')[0]!;
    let stopped = false;
    (button.listeners.pointerdown || []).forEach((fn) => fn({
      button: 0, pointerId: 7, clientX: from.left + 300, clientY: from.top + 10,
      preventDefault() {}, stopPropagation() { stopped = true; }, target: button,
    }));
    expect(stopped).toBe(true);
  });

  it('the ROWS are not a drag handle', () => {
    h.start();
    h.pick(buyLink());
    // The body must stay inert: ticking a checkbox and selecting a value to copy
    // are both drags in the ordinary sense, and neither may move the window.
    const rowNode = h.row('href').label.parentElement!;
    expect(rowNode.listeners.pointerdown).toBeUndefined();
    expect(rowNode.listeners.mousedown).toBeUndefined();
  });

  it('keeps where the user put it across the next pick', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    h.drag({ x: from.left + 20, y: from.top + 10 }, { x: from.left + 20 - 200, y: from.top + 10 - 150 });
    const moved = h.pos();

    // Pick something else. Snapping back to the corner would undo a deliberate
    // action — and the reason people move the panel is that the corner covers
    // what they are inspecting, which is still true a moment later.
    h.pick(buyLink());
    expect(h.pos()).toEqual(moved);
  });

  it('releases the drag when the pointer is cancelled', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    h.dragStart({ x: from.left + 20, y: from.top + 10 });
    h.header().fire('pointercancel', { pointerId: 7 });
    // Nothing should follow the cursor with no button held.
    h.dragMove({ x: from.left + 500, y: from.top + 500 });
    expect(h.pos()).toEqual(from);
  });

  it('marks the header while dragging and unmarks it after', () => {
    h.start();
    h.pick(buyLink());
    const from = h.pos();
    h.dragStart({ x: from.left + 20, y: from.top + 10 });
    expect(h.header().className).toContain('dragging');
    h.header().fire('pointerup', { pointerId: 7 });
    expect(h.header().className).not.toContain('dragging');
  });
});

// ════════════════════════════════════════════════════════════════
// THE PICK REACHES THE POPUP
//
// The popup's SELECTED ELEMENT and ATTRIBUTES sections describe the same pick
// this panel shows. It cannot be handed over by a message: the picker's first
// action is moving the mouse onto the page, which closes the popup. So the pick
// is left in storage and read back when the popup opens.
// ════════════════════════════════════════════════════════════════
describe('picker → popup handoff', () => {
  function saved() {
    return h.stored.ab_lastPick as {
      element: Record<string, unknown>;
      rows: Array<{ key: string }>;
      display: string[];
      sendKey: string;
    } | null;
  }

  it('publishes the pick, its rows and both selection states', () => {
    h.start();
    h.pick(buyLink());
    const s = saved()!;
    expect(s).toBeTruthy();
    expect(s.element.tag).toBe('a');
    expect(s.rows.length).toBeGreaterThan(3);
    // Both states travel, separately — which is the whole point of their being
    // two: `display` is what to look at, `sendKey` is what leaves.
    expect(s.display).toContain('css');
    expect(s.sendKey).toBeTruthy();
  });

  it('records display keys in PANEL ORDER, not tick order', () => {
    h.start();
    h.pick(buyLink());
    h.tick('data-sku');          // late tick on an EARLY row…
    h.tick('Tag Name');          // …and one on the earliest row of all
    const order = saved()!.display;
    const rowOrder = h.rows().map((r) => r.key);
    const asRendered = rowOrder.filter((k) => {
      const row = h.row(k);
      return row.checkbox.checked;
    });
    // What the popup restores must be in the order the user read it in.
    expect(order.length).toBe(asRendered.length);
    expect(order[0]).toBe('tag');
  });

  it('follows the armed radio when the outbound choice changes', () => {
    h.start();
    h.pick(buyLink());
    h.arm('data-sku');
    expect(saved()!.sendKey).toBe('data-sku');
  });

  it('clears the published pick when the user cancels', () => {
    h.start();
    h.pick(buyLink());
    expect(saved()).toBeTruthy();
    h.stop();
    // Cancelling must mutate no target and leave no data. A pick left behind
    // would reappear in the popup as though it were still current — showing the
    // user a value they had explicitly walked away from.
    expect(saved()).toBeNull();
  });

  it('works on a browser with no storage available', () => {
    // The handoff is a convenience; the panel itself must not depend on it.
    expect(() => { h.start(); h.pick(buyLink()); }).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// THE 👁 SELECTION TOGGLE
//
// THE REPORTED BEHAVIOUR, AND WHAT WAS MISSING
// --------------------------------------------
// Picking an element FREEZES it and the panel then stays open until the user
// closes it. That is correct and is kept: closing on the first click would make
// it impossible to compare two candidates or to read a value before committing
// to it.
//
// The cost was that the picking GESTURE stayed armed over a page the user now
// wanted to read. Every mousemove re-outlined, every click was swallowed and
// re-aimed, the arrows walked the tree — and the only escape was ✕, which throws
// the pick away along with the ticks and the armed radio. So "let me look at the
// page again" and "discard my pick" were the same button.
//
// 👁 separates them. It pauses the gesture and NOTHING else.
//
// WHAT THESE TESTS PIN
// --------------------
// The two actions must stay distinct (✕ closes, 👁 pauses), the pause must be
// total (pointer AND keyboard), and — the part that makes it safe to press — the
// pick must survive it intact: the frozen element, its rows, the checkboxes, the
// radio and the outbound value. Asserted through the rendered controls, the
// published pick and the payload, never against the module's private state.
// ════════════════════════════════════════════════════════════════
describe('inspector panel: 👁 toggles element selection without closing (§16)', () => {
  it('offers the toggle in the header, as a real button, alongside ✕', () => {
    h.start();
    h.pick(buyLink());

    const eye = h.eye();
    // A BUTTON, not a clickable div: it must be tabbable and announceable.
    expect(eye.tagName).toBe('BUTTON');
    expect(eye.type).toBe('button');
    // In the header, which is where the picker's own controls live — not in the
    // footer beside Confirm/Cancel, which are about the PICK rather than the tool.
    expect(h.header().childNodes.indexOf(eye)).toBeGreaterThanOrEqual(0);
  });

  it('starts with selection ON, because that is what opening a picker means', () => {
    h.start();
    h.pick(buyLink());
    expect(h.selectionOn()).toBe(true);
    // And says so, rather than leaving the state to a colour alone.
    expect(h.eye().getAttribute('aria-pressed')).toBe('true');
  });

  it('shows no "paused" notice while selection is live', () => {
    h.start();
    h.pick(buyLink());
    // The notice explains a mode the user chose. In the default mode it would be
    // permanent furniture in a panel that is deliberately not allowed to grow.
    expect(h.pausedText()).toBe('');
  });

  it('keeps the picker OPEN when selection is switched off', () => {
    h.start();
    h.pick(buyLink());

    h.clickEye();

    // The whole point: this is not a second Close. `isActive()` is the picker's
    // own answer to "am I open?", and the panel is still on screen.
    expect(h.isActive()).toBe(true);
    expect(h.selectionOn()).toBe(false);
    expect(h.wrap().style.display).toBe('flex');
  });

  it('leaves the selected element visible and described after pausing', () => {
    h.start();
    h.pick(buyLink());
    const before = h.selected();
    const outlineBefore = h.outline();

    h.clickEye();

    // «currently selected element remains visible» — both the panel's readout of
    // it and the outline that points at it on the page.
    expect(h.selected()).toEqual(before);
    expect(h.outline().visible).toBe(true);
    expect(h.outline().left).toBe(outlineBefore.left);
    expect(h.outline().top).toBe(outlineBefore.top);
    expect(h.outline().label).toBe(outlineBefore.label);
  });

  it('states that selection is paused, so an inert page has a visible cause', () => {
    h.start();
    h.pick(buyLink());
    h.clickEye();

    // Without this the picker looks identical to one that has died: no outline
    // follows the mouse and no click picks. The notice is the difference between
    // a mode and a fault.
    expect(h.pausedText()).toMatch(/paus/i);
  });

  it('stops a HOVER from re-outlining another element', () => {
    h.start();
    h.pick(buyLink());
    const frozenOutline = h.outline();

    h.clickEye();
    h.hover(new FakeEl('footer', { id: 'somewhere-else' }));

    // The outline must still be on the PICKED element, not on whatever the cursor
    // crossed: «mouse movement/click does NOT select another element».
    expect(h.outline().visible).toBe(true);
    expect(h.outline().label).toBe(frozenOutline.label);
  });

  it('stops a CLICK from re-picking, leaving the pick exactly as it was', () => {
    h.start();
    h.pick(buyLink());
    const before = { rows: h.rows().map((r) => r.key), selected: h.selected() };

    h.clickEye();
    h.pick(new FakeEl('div', { id: 'other', 'data-nope': 'x' }));

    // Same element still described: same rows, same readout. A re-pick would have
    // replaced both.
    expect(h.rows().map((r) => r.key)).toEqual(before.rows);
    expect(h.selected()).toEqual(before.selected);
  });

  it('hands page clicks back to the page while paused', () => {
    h.start();
    h.pick(buyLink());

    // While picking, a click is swallowed so that clicking a link cannot navigate
    // away and take the pick with it.
    expect(h.clickWasSwallowed(new FakeEl('a', { href: '/x' }))).toBe(true);

    h.clickEye();

    // Paused, there is no gesture left to protect — and the reason to pause is to
    // use the page again. A picker that still ate every click would leave the page
    // dead with no visible cause.
    expect(h.clickWasSwallowed(new FakeEl('a', { href: '/x' }))).toBe(false);
  });

  it('pauses the ARROW KEYS too, not merely the mouse', () => {
    h.start();
    h.pick(buyLink());
    const before = h.rows().map((r) => r.key);

    h.clickEye();
    h.key('ArrowUp');
    h.key('ArrowDown');

    // Arrow-walking IS element selection, reached by keyboard. If it stayed live,
    // "selection disabled" would only be half true and a stray ArrowUp would
    // silently re-describe the element the user deliberately froze.
    expect(h.rows().map((r) => r.key)).toEqual(before);
  });

  it('re-enables selection on a second press', () => {
    h.start();
    h.pick(buyLink());

    h.clickEye();
    expect(h.selectionOn()).toBe(false);
    h.clickEye();

    expect(h.selectionOn()).toBe(true);
    expect(h.pausedText()).toBe('');
  });

  it('picks again normally once selection is back on', () => {
    h.start();
    h.pick(buyLink());
    h.clickEye();
    h.clickEye();

    const other = new FakeEl('img', { id: 'hero', src: '/hero.png' });
    h.pick(other);

    // The gesture is genuinely restored, not merely reported as restored.
    expect(h.rows().map((r) => r.key)).toContain('src');
    expect(h.selected().some((s) => s.value === '/hero.png')).toBe(true);
  });

  it('is NOT the close button: ✕ still closes the picker', () => {
    h.start();
    h.pick(buyLink());

    const close = h.header().childNodes.filter(
      (c) => c.tagName === 'BUTTON' && c.className.split(/\s+/).indexOf('x') >= 0,
    )[0]!;
    close.fire('click');

    // The two actions must never collapse into one. Close means close.
    expect(h.isActive()).toBe(false);
    expect(h.wrap().style.display).toBe('none');
  });

  it('does not disturb the checkboxes or the armed radio', () => {
    h.start();
    h.pick(buyLink());
    h.tick('data-sku');
    h.arm('href');
    const ticked = h.rows().filter((r) => r.checkbox.checked).map((r) => r.key);

    h.clickEye();

    // Nobody would dare press a pause that could lose a selection. §16/§23's two
    // independent states both survive it untouched.
    expect(h.rows().filter((r) => r.checkbox.checked).map((r) => r.key)).toEqual(ticked);
    expect(h.row('href').radio.checked).toBe(true);
  });

  it('still sends the same single value after pausing', () => {
    h.start();
    h.pick(buyLink());
    h.arm('href');

    h.clickEye();
    h.confirm();

    // Pausing the GESTURE cannot change what the pick will deliver — otherwise
    // the toggle would silently rewrite the outbound value.
    expect(h.sent[0]!.sendAttribute).toEqual({ name: 'href', value: '/checkout' });
  });

  it('leaves the published pick intact, so the popup still sees it', () => {
    h.start();
    h.pick(buyLink());
    const before = h.stored.ab_lastPick;

    h.clickEye();

    // Cancel withdraws the pick; pausing must not. The popup is a second view of
    // the SAME pick, and it should not blank because the user paused picking.
    expect(h.stored.ab_lastPick).toEqual(before);
  });

  it('marks the two states differently, and keeps the OFF state legible', () => {
    h.start();
    h.pick(buyLink());
    const on = h.eye().className;

    h.clickEye();
    const off = h.eye().className;

    expect(on).not.toBe(off);
    // The classes the design system keys off: `on` takes the orange accent, `off`
    // is muted-but-clearly-pressable rather than dimmed to invisibility, because
    // it is a state the user will want to leave.
    expect(on).toContain('on');
    expect(off).toContain('off');

    const css = h.panelCss();
    expect(css).toContain('.hd button.ey.on');
    expect(css).toContain('.hd button.ey.off');
    // ON carries the panel's own accent, the same one the outline and the armed
    // radio use — "orange means this is live" has to hold across the whole panel.
    expect(/\.hd button\.ey\.on\{[^}]*#ff6600/.test(css)).toBe(true);
  });

  it('opens the next session with selection live again', () => {
    h.start();
    h.pick(buyLink());
    h.clickEye();
    expect(h.selectionOn()).toBe(false);

    h.stop();
    h.start();
    h.pick(buyLink());

    // A pause is a state WITHIN one picking session. Persisting it would mean the
    // next Ctrl+Shift+C opened a picker that outlines nothing and picks nothing,
    // for a reason set minutes earlier on another page.
    expect(h.selectionOn()).toBe(true);
    expect(h.pausedText()).toBe('');
  });

  it('"Pick again" un-pauses, because it is a request to pick', () => {
    h.start();
    h.pick(buyLink());
    h.clickEye();

    const again = h.header().childNodes.filter(
      (c) => c.tagName === 'BUTTON' && c.textContent === 'Pick again',
    )[0]!;
    again.fire('click');

    // Otherwise it would tear the panel down and then refuse to pick anything —
    // a dead end with no visible cause.
    expect(h.selectionOn()).toBe(true);
    h.pick(new FakeEl('img', { id: 'hero', src: '/hero.png' }));
    expect(h.rows().map((r) => r.key)).toContain('src');
  });

  it('does not move the panel when pressed', () => {
    h.start();
    h.pick(buyLink());
    const before = h.pos();

    // The header is the drag handle, so a press on a control inside it must stop
    // the gesture before it starts — or a press that wanders a pixel would move
    // the window and swallow the click.
    let stopped = false;
    (h.eye().listeners.pointerdown || []).forEach((fn) => fn({
      button: 0, pointerId: 7, clientX: before.left + 250, clientY: before.top + 10,
      preventDefault() {}, stopPropagation() { stopped = true; }, target: h.eye(),
    }));
    expect(stopped).toBe(true);
    expect(h.pos()).toEqual(before);
  });

  it('Esc still closes even while selection is paused', () => {
    h.start();
    h.pick(buyLink());
    h.clickEye();

    h.key('Escape');

    // Pausing must not strand the user: the documented way out still works.
    expect(h.isActive()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// COPY, ON EVERY DISPLAYED VALUE
//
// WHY THIS IS A FEATURE AND NOT A CONVENIENCE
// -------------------------------------------
// The values this panel shows are its entire output, and their destination is
// frequently outside this product: a colleague's message, a test file, another
// tool's selector box. Selecting a clipped one-line cell with the mouse is
// unreliable, and the panel hangs under a draggable header, so a stray selection
// gesture is worse than useless.
//
// THE RULE THAT NEEDS DEFENDING
// ----------------------------
// «Copy کردن یک row نباید مقدار row دیگری را تغییر دهد» — each button copies ITS
// OWN row. The tempting implementation is one shared handler that resolves "the
// current row" at click time, and it is precisely how a copy button ends up
// putting a neighbour's value on the clipboard after a re-render. Nothing throws;
// the user simply pastes the wrong selector.
//
// So the assertions below always check WHICH value arrived on the clipboard, for
// several different rows, including after the list has been re-rendered — never
// merely that "a copy happened".
// ════════════════════════════════════════════════════════════════
describe('inspector panel: every value carries its own Copy action', () => {
  it('gives every attribute row a copy button', () => {
    h.start();
    h.pick(buyLink());

    const all = h.rows();
    expect(all.length).toBeGreaterThan(3);
    all.forEach((r) => {
      expect(r.copy, `row "${r.key}" has no copy button`).toBeTruthy();
      expect(r.copy.tagName).toBe('BUTTON');
      expect(r.copy.type).toBe('button');
    });
  });

  it('gives every SELECTED ELEMENT entry one too', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();

    // This is the section that shows values UNCLIPPED, so it is where a user
    // reading a long CSS selector or XPath is standing when they decide to take
    // it. A copy action anywhere else would be the wrong place.
    h.selected().forEach((s) => {
      expect(() => h.selCopy(s.key), `"${s.key}" has no copy button`).not.toThrow();
    });
  });

  it('copies the exact value of the row that was pressed', () => {
    h.start();
    h.pick(buyLink());

    h.row('href').copy.fire('click');

    expect(h.clipboard).toEqual(['/checkout']);
  });

  it('copies a DIFFERENT row\'s value without disturbing the first', () => {
    h.start();
    h.pick(buyLink());

    h.row('href').copy.fire('click');
    h.row('data-sku').copy.fire('click');
    h.row('Text').copy.fire('click');

    // Each press yields its own line's value, in order. A shared "current row"
    // handler would repeat one of them here.
    expect(h.clipboard).toEqual(['/checkout', 'W-9', 'Buy now']);
  });

  it('copies the derived CSS Selector and XPath, not just DOM attributes', () => {
    h.start();
    h.pick(buyLink());

    h.row('CSS Selector').copy.fire('click');
    h.row('XPath').copy.fire('click');
    h.row('Tag Name').copy.fire('click');

    // These are the rows that say how a node FINDS the element, and they are
    // computed rather than read off it — the case a naive `getAttribute(key)`
    // implementation would return empty for.
    expect(h.clipboard).toEqual(['#buy', '//*[@id="buy"]', 'a']);
  });

  it('copies CUSTOM attributes, whatever the site called them', () => {
    const el = new FakeEl('div', {
      class: 'product-card',
      'data-order': '123',
      'data-product-id': '987',
      'tracking-id': 'trk-55',
      'custom-price': '19.99',
    });
    h.start();
    h.pick(el);
    h.selectAll();

    ['data-order', 'data-product-id', 'tracking-id', 'custom-price'].forEach((k) => {
      h.row(k).copy.fire('click');
    });

    // There is no whitelist anywhere in the extraction core, and there must be
    // none here either: a copy button that only knew a fixed set of keys would
    // silently do nothing on exactly the attributes people pick elements for.
    expect(h.clipboard).toEqual(['123', '987', 'trk-55', '19.99']);
  });

  it('copies the Class row as the class list the user can read', () => {
    h.start();
    h.pick(buyLink());

    h.row('Class').copy.fire('click');

    // Derived from `classes`, so what is copied is what the row shows — not the
    // array's toString, and not the raw attribute if the two ever differ.
    expect(h.clipboard).toEqual(['btn primary']);
  });

  it('copies the same value from the row and from the readout', () => {
    h.start();
    h.pick(buyLink());
    h.selectAll();

    h.row('XPath').copy.fire('click');
    h.selCopy('XPath').fire('click');

    // Two renderings of ONE row. If they could disagree, the panel would be
    // offering two different answers to "what is this element's XPath?".
    expect(h.clipboard).toEqual(['//*[@id="buy"]', '//*[@id="buy"]']);
  });

  it('confirms the copy briefly, on the button that was pressed', async () => {
    h.start();
    h.pick(buyLink());
    const btn = h.row('href').copy;
    const resting = btn.textContent;

    btn.fire('click');
    // The tick waits for the write to actually resolve — see settle(). Claiming
    // success before that is the one failure mode the user cannot detect.
    await h.settle();

    // A local "✓", not a toast: §16 forbids growing the picker, and the question
    // being answered ("did THAT line copy?") belongs beside that line.
    expect(btn.textContent).toBe('\u2713');
    expect(btn.title).toMatch(/copied/i);
    expect(btn.className).toContain('done');
    expect(btn.textContent).not.toBe(resting);
  });

  it('returns to its resting state afterwards', async () => {
    h.start();
    h.pick(buyLink());
    const btn = h.row('href').copy;
    const resting = btn.textContent;

    btn.fire('click');
    await h.settle();
    expect(btn.className).toContain('done');
    h.flushTimers();

    // The feedback is a moment, not a new state: a button stuck on "✓" would stop
    // reading as something that can be pressed again.
    expect(btn.textContent).toBe(resting);
    expect(btn.className).not.toContain('done');
    expect(btn.title).toMatch(/copy/i);
  });

  it('confirms on ONE row only, never on its neighbours', async () => {
    h.start();
    h.pick(buyLink());

    h.row('href').copy.fire('click');
    await h.settle();

    expect(h.row('href').copy.className).toContain('done');
    // Feedback that appeared on every row would tell the user nothing about which
    // value they actually took.
    expect(h.row('data-sku').copy.className).not.toContain('done');
    expect(h.row('XPath').copy.className).not.toContain('done');
  });

  it('lets two rows show their own feedback at the same time', async () => {
    h.start();
    h.pick(buyLink());

    h.row('href').copy.fire('click');
    h.row('data-sku').copy.fire('click');
    await h.settle();

    // Per-row timers, so a second copy does not cancel the first row's
    // confirmation — and neither one clears the other's early.
    expect(h.row('href').copy.className).toContain('done');
    expect(h.row('data-sku').copy.className).toContain('done');
  });

  it('restarts its own countdown when the same row is copied twice', async () => {
    h.start();
    h.pick(buyLink());
    const btn = h.row('href').copy;

    btn.fire('click');
    btn.fire('click');
    await h.settle();

    // Still confirming after the second press: a stacked pair of timers would let
    // the first one revert the label while the second copy was still fresh.
    expect(btn.textContent).toBe('\u2713');
    expect(h.clipboard).toEqual(['/checkout', '/checkout']);
  });

  it('does not tick or untick the row it sits on', () => {
    h.start();
    h.pick(buyLink());
    const before = h.rows().filter((r) => r.checkbox.checked).map((r) => r.key);

    h.row('data-sku').copy.fire('click');

    // The row's text is a label whose click toggles DISPLAY. A copy button inside
    // it — or one that let the click bubble — would change what the panel shows
    // every time the user took a value.
    expect(h.rows().filter((r) => r.checkbox.checked).map((r) => r.key)).toEqual(before);
    expect(h.row('data-sku').checkbox.checked).toBe(false);
  });

  it('does not change which value is SENT', () => {
    h.start();
    h.pick(buyLink());
    h.arm('href');

    h.row('data-sku').copy.fire('click');
    h.row('XPath').copy.fire('click');
    h.confirm();

    // Copying is a read. §21's single outbound value belongs to the radio and to
    // nothing else — least of all to whichever row was last copied.
    expect(h.sent[0]!.sendAttribute).toEqual({ name: 'href', value: '/checkout' });
  });

  it('does not move the panel when pressed', () => {
    h.start();
    h.pick(buyLink());
    const before = h.pos();

    let stopped = false;
    (h.row('href').copy.listeners.pointerdown || []).forEach((fn) => fn({
      button: 0, pointerId: 7, clientX: before.left + 300, clientY: before.top + 200,
      preventDefault() {}, stopPropagation() { stopped = true; }, target: h.row('href').copy,
    }));
    expect(stopped).toBe(true);
    expect(h.pos()).toEqual(before);
  });

  it('copies the right value after the list has been re-rendered', () => {
    h.start();
    h.pick(buyLink());
    // A bulk tick rebuilds every row, which is exactly when a shared handler that
    // resolved "the current row" late would start returning a stale one.
    h.selectAll();
    h.clearAll();
    h.selectAll();

    h.row('data-sku').copy.fire('click');

    expect(h.clipboard).toEqual(['W-9']);
  });

  it('copies the right value after a NEW element is picked', () => {
    h.start();
    h.pick(buyLink());
    h.row('href').copy.fire('click');

    const other = new FakeEl('img', { id: 'hero', src: '/hero.png', 'data-sku': 'OTHER' });
    h.pick(other);
    h.row('data-sku').copy.fire('click');

    // The second copy must be the SECOND element's value. A button holding a
    // captured VALUE rather than a key would still be offering the first one.
    expect(h.clipboard).toEqual(['/checkout', 'OTHER']);
  });

  it('copies the whole value, not the row\'s clipped preview', () => {
    const long = '/checkout?sku=W-9&utm_source=newsletter&utm_campaign=spring-sale-2026&ref=abcdefghijklmnop';
    const el = new FakeEl('a', { id: 'buy', href: long });
    el.innerText = 'Buy';
    h.start();
    h.pick(el);

    h.row('href').copy.fire('click');

    // The row is nowrap+ellipsis by design, so what is on screen is a preview.
    // Copying the preview would be the whole feature failing quietly.
    expect(h.clipboard).toEqual([long]);
  });

  it('copies a value the page filled with markup as literal text', () => {
    const hostile = new FakeEl('div', { id: 'q', 'data-x': '<img src=x onerror=alert(1)>' });
    h.start();
    h.pick(hostile);
    h.selectAll();

    h.row('data-x').copy.fire('click');

    // Verbatim: not parsed, not stripped, not escaped. The clipboard gets what
    // the attribute holds.
    expect(h.clipboard).toEqual(['<img src=x onerror=alert(1)>']);
  });

  it('refuses gracefully on a row with no value to copy', () => {
    // A boolean attribute is real and worth SEEING (`<ol reversed>` is
    // `reversed=""`), but there is nothing to put on a clipboard.
    const list = new FakeEl('ol', { reversed: '', start: '3' });
    h.start();
    h.pick(list);
    h.selectAll();

    const btn = h.row('reversed').copy;
    btn.fire('click');

    // Says so on the button rather than silently doing nothing, which would read
    // as the control being broken — and never copies the "(empty)" placeholder the
    // cell is displaying.
    expect(h.clipboard).toEqual([]);
    expect(btn.title).toMatch(/no value/i);
  });

  it('falls back to the legacy path when the modern clipboard is refused', async () => {
    // The panel runs in an arbitrary page: on http://, or when the document does
    // not have focus, navigator.clipboard rejects. That is an ordinary condition,
    // not an edge case, and the value still has to reach the clipboard.
    h.failClipboard(true);
    h.start();
    h.pick(buyLink());
    const btn = h.row('href').copy;

    btn.fire('click');
    await h.settle();

    expect(h.clipboard).toEqual([]);
    expect(h.legacyCopies).toEqual(['/checkout']);
    // The fallback is not a lesser path: it confirms exactly as the modern one
    // does, because from the user's side the value did reach the clipboard.
    expect(btn.textContent).toBe('\u2713');
  });

  it('leaves no scratch nodes behind in the user\'s page', () => {
    h.failClipboard(true);
    h.start();
    h.pick(buyLink());

    h.row('href').copy.fire('click');
    h.row('data-sku').copy.fire('click');

    // The fallback needs a real, selectable <textarea> in the document. Leaving
    // one behind would be litter in a page we do not own.
    expect(h.strayNodes()).toEqual([]);
  });

  it('says so when the value could not be copied at all', async () => {
    h.failClipboard(true);
    h.failLegacy(true);
    h.start();
    h.pick(buyLink());
    const btn = h.row('href').copy;

    btn.fire('click');
    await h.settle();

    // A silent failure is the worst outcome: the user pastes whatever was on the
    // clipboard before and does not find out until it is somewhere else.
    expect(btn.textContent).not.toBe('\u2713');
    expect(btn.title).toMatch(/failed/i);
  });

  it('is styled as part of the panel, not bolted onto it', () => {
    h.start();
    h.pick(buyLink());
    const css = h.panelCss();

    // Same charcoal/subtle-border/orange-accent language as everything else: at
    // rest it is muted and borderless (the values are the content, and twenty
    // resting accents would flatten the one accent that means something), and it
    // earns the accent on hover and focus.
    const rule = /\.cp\{[^}]*\}/.exec(css);
    expect(rule, '.cp rule must exist in the picker stylesheet').not.toBeNull();
    expect(rule![0]).toContain('cursor:pointer');
    expect(rule![0]).toContain('border:1px solid transparent');
    expect(css).toMatch(/\.cp:hover\{[^}]*#ff6600/);
    // Keyboard focus has to be visible: this control repeats down a list and is
    // reachable by Tab.
    expect(css).toContain('.cp:focus-visible');
    // The confirmation uses the design's --green, the same success colour the
    // footer status line uses, so "it worked" looks the same everywhere.
    expect(css).toMatch(/\.cp\.done\{[^}]*#00c853/);
  });

  it('never steals width from the value it belongs to', () => {
    h.start();
    h.pick(buyLink());
    const rule = /\.cp\{[^}]*\}/.exec(h.panelCss())!;

    // `flex:0 0 auto` in both directions: the button must not shrink under a long
    // value, and must not grow at its expense either. The row's job is to show
    // the value.
    expect(rule[0]).toContain('flex:0 0 auto');
  });

  it('names each button for its row, for anyone not seeing the glyph', () => {
    h.start();
    h.pick(buyLink());

    // A column of identical glyphs is just "button, button, button" to a screen
    // reader without this.
    expect(h.row('href').copy.getAttribute('aria-label')).toBe('Copy href');
    // Named from the row's KEY, not its visible label: the key is what the value
    // is fetched by, so a mismatch here would be the first sign a button and its
    // value had drifted apart. The rows are addressed by the label the user reads
    // ("CSS Selector"), while the button announces the key it copies ("css").
    expect(h.row('CSS Selector').copy.getAttribute('aria-label')).toBe('Copy css');
    expect(h.row('Tag Name').copy.getAttribute('aria-label')).toBe('Copy tag');
  });

  it('explains the copy mark in the panel\'s legend', () => {
    h.start();
    h.pick(buyLink());
    const host = h.wrap();
    const hint = host.childNodes.filter((c) => c.className === 'hint')[0]!;

    // The panel already explains ☑ and ◉ there. An 18px glyph repeated down the
    // list deserves the same one-word introduction rather than twenty tooltips
    // the user has to hover to discover.
    expect(hint.textContent).toMatch(/copy/i);
  });
});
