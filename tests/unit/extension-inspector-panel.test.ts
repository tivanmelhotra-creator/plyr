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
}

interface Harness {
  /** Arm the picker, exactly as Ctrl+Shift+C or the popup does. */
  start(): void;
  stop(): void;
  isActive(): boolean;
  /** Click a page element while picking — freezes it and opens the panel. */
  pick(el: FakeEl): void;
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

  const documentFake = {
    documentElement: documentEl,
    body,
    title: 'Shop',
    createElement: (tag: string) => new FakeNode(tag),
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
    setTimeout: () => { timeouts += 1; return 0; },
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
      // The row's identity as the USER sees it: the key column's text.
      const keyCell = label ? label.childNodes[0] : undefined;
      return { key: keyCell ? keyCell.textContent : '', checkbox, radio, label };
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
