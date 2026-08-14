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
  /** The status line the user reads. */
  status(): { text: string; kind: string };
  /** Everything handed to chrome.runtime.sendMessage. */
  sent: SentMessage[];
  /** What the background worker replies with; mutate before confirm(). */
  reply: { value: unknown };
  confirmButton(): FakeNode;
  timeouts: number;
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
    innerHeight: 800,
    addEventListener: (t: string, fn: (e: unknown) => void) => { (winListeners[t] ||= []).push(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      const l = winListeners[t];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };
  const chromeFake = {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      sendMessage: (msg: SentMessage, cb?: (r: unknown) => void) => {
        sent.push(msg);
        if (cb) cb(reply.value);
      },
      onMessage: { addListener: () => {} },
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

  return {
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
beforeEach(() => { h = boot(); });

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
