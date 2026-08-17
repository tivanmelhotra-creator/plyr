import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════
// public/js/flow-editor.js — the "Connect Inspector" control (§5 / §6 / §8).
//
// WHAT THESE TESTS DEFEND
//
// Pairing is deliberately TWO-SIDED. The project issues a one-time code that
// the server has already bound to ONE Target Field; the extension redeems it
// with nothing but the code. That is the whole reason the extension can never
// aim itself at a field the user did not open (§8) — and it only holds if the
// code is issued HERE, from the field itself, using the id the SERVER minted.
//
// Three ways to break that quietly, all of which look fine in review:
//
//   1. Offer the button on every field. A code for a `boolean`/`number`/
//      `options` field is a code for a destination the server refuses, so
//      pairing "succeeds" and then every pick is rejected.
//   2. Send a client-side identifier (node.id, or nodeId + fieldKey) instead of
//      the server's targetFieldId. Everything still pairs — until a node is
//      re-opened, when the random suffix is the only thing standing between a
//      queued pick and a field the user already closed.
//   3. Let a refusal leave the button disabled. The editor looks broken and the
//      user's only recovery is a reload.
//
// None of those throw, so each is asserted by name below.
//
// HOW: the real flow-editor.js runs in a `vm` sandbox against a hand-rolled
// fake DOM (there is no jsdom in this repo — same approach as
// extension-inspector-panel.test.ts and popup-inspector-pairing.test.ts). The
// NDV is opened through FlowEditor.openNdv(), which the source exposes as the
// SAME entry point the canvas double-click uses — not a test-only shortcut.
//
// Assertions are made against the RENDERED CONTROLS and the ARGUMENTS handed to
// InspectorClient.authorizeTarget(), never against the module's internals, so a
// refactor that renames things keeps passing while one that changes the
// observable contract fails.
// ════════════════════════════════════════════════════════════════

/* ---------------------------------------------------------------
   A fake DOM: only what this render path actually touches.
   --------------------------------------------------------------- */
class El {
  tagName: string;
  type = '';
  id = '';
  className = '';
  title = '';
  value = '';
  placeholder = '';
  rows = 0;
  checked = false;
  disabled = false;
  min = '';
  max = '';
  scrollTop = 0;
  /** Set by select(); execCommand('copy') reads the last-selected node. */
  selected = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, unknown> = {
    setProperty(this: void) { /* --ndv-edge etc. */ },
    removeProperty(this: void) {},
  };
  childNodes: El[] = [];
  parentNode: El | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); }

  // The editor builds its NDV header with innerHTML and then queries INSIDE it
  // (`head.querySelector('.ndv-head-icon').style`). A setter that only stored
  // the string would make that query return null and the render would die — so
  // the fake parses the markup into real child nodes. Deliberately minimal:
  // this repo's markup is flat spans/divs with class attributes.
  private _html = '';
  get innerHTML() { return this._html; }
  set innerHTML(html: string) {
    this._html = String(html);
    this.childNodes.length = 0;
    this._text = '';
    parseInto(this, this._html);
  }

  // Assigning textContent REPLACES a node's contents, children included. A
  // plain field would have kept stale children alive — and `show()` clears the
  // output area with exactly this assignment before re-filling it, so a naive
  // fake makes a cleared message look like it is still on screen.
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
    this._html = '';
  }

  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  appendChild(c: El) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c: El) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(c: El, ref: El | null) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    c.parentNode = this;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    return c;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes; }

  // flow-editor.js flips classes through classList on the expression toggle and
  // the preview rows; without it the editor throws mid-render and every
  // assertion afterwards would be vacuous.
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

  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t: string, fn: (e: unknown) => void) {
    const l = this.listeners[t];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** Fire a listener the way a browser would. */
  fire(t: string, evt: Record<string, unknown> = {}) {
    (this.listeners[t] || []).slice().forEach((fn) => fn({
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      target: this, ...evt,
    }));
  }

  querySelectorAll(sel: string): El[] { return findAll(this, matcher(sel)); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  contains(n: El | null) {
    let cur: El | null = n;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }
  focus() {}
  // The legacy copy path is `appendChild → select() → execCommand('copy')`. The
  // fake records the selection so execCommand can copy the SAME text a browser
  // would, which is what makes "the fallback copied the right value" testable.
  select() { this.selected = true; }
  closest() { return null; }
}

/**
 * Turn a flat HTML string into fake child nodes.
 *
 * Only tags, class/style-free attributes and text are honoured — enough for the
 * NDV header/validation markup, and small enough that it cannot quietly become
 * a second DOM implementation the tests start depending on.
 */
function parseInto(parent: El, html: string) {
  const stack: El[] = [parent];
  const re = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]!;
    if (m[3] != null) {                                  // text run
      // Appended as a child so it cannot wipe the element's other children —
      // `textContent +=` would, because assignment replaces contents.
      if (m[3].trim()) {
        const txt = new El('#text');
        txt.textContent = m[3];
        top.appendChild(txt);
      }
      continue;
    }
    const tag = m[1]!;
    const selfClosing = m[0].endsWith('/>') ||
      /^(br|img|input|hr|meta|link|path|circle|rect|line|polyline|polygon|use)$/i.test(tag);
    if (m[0][1] === '/') {                               // closing tag
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new El(tag);
    for (const a of (m[2] || '').matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g)) {
      const k = a[1] ?? a[3]!;
      const v = a[2] ?? a[4]!;
      if (k === 'class') el.className = v; else el.setAttribute(k, v);
    }
    top.appendChild(el);
    if (!selfClosing) stack.push(el);
  }
}

/** A deliberately small selector engine: `.class`, `tag`, `[attr]`, comma lists. */
function matcher(sel: string): (n: El) => boolean {
  const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
  const one = (raw: string) => {
    // Only the LAST simple selector matters for the queries this file makes
    // (".ndv-backdrop .ndv-body" -> ".ndv-body"); descendant precision is not
    // needed and pretending otherwise would be a second implementation to trust.
    const last = raw.split(/\s+/).filter(Boolean).pop() || raw;
    if (last.startsWith('.')) {
      const want = last.slice(1);
      return (n: El) => n.className.split(/\s+/).indexOf(want) >= 0;
    }
    if (last.startsWith('[')) {
      const key = last.slice(1, -1).replace(/[\]"']/g, '');
      return (n: El) => n.attrs[key] != null;
    }
    const tag = last.toUpperCase();
    return (n: El) => n.tagName === tag;
  };
  const preds = parts.map(one);
  return (n: El) => preds.some((p) => p(n));
}

function findAll(root: El, pred: (n: El) => boolean): El[] {
  const out: El[] = [];
  const visit = (n: El) => { if (pred(n)) out.push(n); n.childNodes.forEach(visit); };
  root.childNodes.forEach(visit);
  return out;
}

/* ---------------------------------------------------------------
   Harness
   --------------------------------------------------------------- */
const root = resolve(__dirname, '../..');
const readSrc = (p: string) => readFileSync(resolve(root, p), 'utf8');

/** One authorizeTarget call, as the editor made it. */
type AuthCall = { targetFieldId: string };

interface Harness {
  win: Record<string, unknown>;
  doc: El;
  /** Fields the fake server has minted ids for: nodeId -> fieldKey -> id. */
  minted: Record<string, Record<string, string>>;
  authCalls: AuthCall[];
  /** What authorizeTarget resolves to; override per test. */
  authReply: (id: string) => unknown;
  openNode: (action: string, params?: Record<string, unknown>) => string;
  /** Every rendered field row, in order. */
  rows: () => Array<{ label: string; connect: El | null; out: El | null }>;
  row: (label: string) => { label: string; connect: El | null; out: El | null };
  connectFor: (label: string) => El;
  outFor: (label: string) => El;
  /** Text of the message span, and of the <code> chip, in the row's output. */
  msgFor: (label: string) => string;
  codeFor: (label: string) => string;
  /** The Base URL chip's text, or '' when no address was shown. */
  baseFor: (label: string) => string;
  /** The Copy buttons in one row's output, in render order. */
  copiesFor: (label: string) => El[];
  /** Everything that reached the clipboard, tagged with the path taken. */
  clipboard: Array<{ text: string; via: 'api' | 'exec' }>;
  /** Toasts the editor raised, as {text, kind}. */
  toasts: Array<{ text: string; kind: string }>;
  /** Replies for targetingStatus, consumed one per poll (last one repeats). */
  statusQueue: Array<unknown>;
  /** targetingStatus calls, so a test can prove the row polls at all. */
  statusCalls: string[];
  /** Run every pending interval once, then let its promise chain settle. */
  tick: () => Promise<void>;
  /** Pending intervals, so a test can prove a timer was cleared. */
  intervals: () => number;
  /** Textareas still parented to <body>: the fallback must clean up after itself. */
  strayNodes: () => El[];
  /**
   * Break the clipboard the way a real browser does.
   *  - noClipboardApi: navigator.clipboard absent (plain-http origin).
   *  - clipboardFails: writeText() REJECTS (document not focused).
   *  - execFails:      execCommand('copy') returns false.
   */
  breakClipboard: (how: { noClipboardApi?: boolean; clipboardFails?: boolean; execFails?: boolean }) => void;
  /** Drop targetingStatus entirely, as an older inspector-client would. */
  dropTargetingStatus: () => void;
}

function boot(opts: { client?: boolean } = {}): Harness {
  const body = new El('body');
  const docEl = new El('html');
  const minted: Record<string, Record<string, string>> = {};
  const authCalls: AuthCall[] = [];
  const clipboard: Harness['clipboard'] = [];
  const toasts: Harness['toasts'] = [];
  const statusCalls: string[] = [];
  const statusQueue: Array<unknown> = [];
  // Intervals are captured rather than run: a 1000ms poll driven by real time
  // would make every test that watches it slow AND flaky, and "the timer was
  // cleared" is only observable if the harness owns the registry.
  const timers: Array<{ fn: () => void; id: number }> = [];
  let timerId = 1;
  const broken = { noClipboardApi: false, clipboardFails: false, execFails: false };

  const doc = new El('#document');
  const documentFake: Record<string, unknown> = {
    body,
    documentElement: docEl,
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    createTextNode: (txt: string) => { const n = new El('#text'); n.textContent = txt; return n; },
    createDocumentFragment: () => new El('#fragment'),
    querySelectorAll: (sel: string) => findAll(body, matcher(sel)),
    querySelector: (sel: string) => findAll(body, matcher(sel))[0] || null,
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    elementFromPoint: () => null,
    // A browser copies whatever is SELECTED. Reading the last selected textarea
    // (rather than trusting the call) is what lets a test catch a fallback that
    // appends the node but forgets to put the value in it.
    execCommand: (cmd: string) => {
      if (String(cmd).toLowerCase() !== 'copy') return false;
      if (broken.execFails) return false;
      const ta = body.childNodes.filter((c) => c.selected).pop();
      if (!ta) return false;
      clipboard.push({ text: ta.value, via: 'exec' });
      return true;
    },
    exitFullscreen: () => {},
    fullscreenElement: null,
    activeElement: null,
  };
  // `doc` mirrors body so tests can query the whole tree with one object.
  doc.childNodes = body.childNodes;

  const h: Harness = {
    win: {}, doc, minted, authCalls,
    authReply: (id: string) => ({
      code: 'ABCDEFGH', display: 'ABCD-EFGH',
      target: { targetFieldId: id }, expiresAt: 0, expiresInMs: 300000,
    }),
    openNode: () => '',
    rows: () => [], row: () => ({ label: '', connect: null, out: null }),
    connectFor: () => new El(), outFor: () => new El(),
    msgFor: () => '', codeFor: () => '',
    baseFor: () => '', copiesFor: () => [],
    clipboard, toasts, statusQueue, statusCalls,
    tick: async () => {},
    intervals: () => timers.length,
    strayNodes: () => [],
    breakClipboard: (how) => { Object.assign(broken, how); },
    dropTargetingStatus: () => {},
  };

  // A faithful stand-in for inspector-client.js: registerTarget mints an id the
  // way the SERVER does (opaque, per registration), and myTargets reports the
  // same {targetFieldId, nodeId, fieldKey} shape the real export returns.
  let seq = 0;
  const inspectorClient = {
    registerTarget(nodeId: string, fieldKey: string) {
      seq += 1;
      const id = 'node_' + nodeId + '__' + fieldKey + '__srv' + seq;
      (minted[nodeId] ||= {})[fieldKey] = id;
      return id;
    },
    releaseNode(nodeId: string) { delete minted[nodeId]; },
    releaseTarget() {},
    myTargets() {
      const out: Array<{ targetFieldId: string; nodeId: string; fieldKey: string }> = [];
      Object.keys(minted).forEach((nodeId) => {
        Object.keys(minted[nodeId]!).forEach((fieldKey) => {
          out.push({ targetFieldId: minted[nodeId]![fieldKey]!, nodeId, fieldKey });
        });
      });
      return out;
    },
    authorizeTarget(targetFieldId: string) {
      authCalls.push({ targetFieldId });
      // Deferred into the promise chain on purpose. The real authorizeTarget is
      // async, so a failure surfaces as a REJECTION; calling authReply inline
      // would let a test's `throw` escape synchronously and would then be
      // testing the harness rather than the editor's .catch().
      return Promise.resolve().then(() => h.authReply(targetFieldId));
    },
    /**
     * The server is the only party that sees BOTH browsers, so this is how the
     * dashboard learns the extension redeemed the code. Replies are queued; the
     * last one repeats, so "not paired yet" can be held for several polls.
     */
    targetingStatus(targetFieldId: string) {
      statusCalls.push(targetFieldId);
      const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
      return Promise.resolve().then(() => {
        if (next instanceof Error) throw next;
        return next === undefined ? { paired: false } : next;
      });
    },
  };

  const windowFake: Record<string, unknown> = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn: () => void) => { void fn; return 0 as unknown; },
    clearTimeout: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    API: { getUserId: () => 'local' },
    location: { href: 'http://localhost/', search: '' },
    navigator: { platform: 'Linux', userAgent: 'node' },
  };
  // Defined as a getter so a test can remove the whole API *after* boot, which
  // is the plain-http case: `navigator.clipboard` is simply not there.
  Object.defineProperty(windowFake.navigator as object, 'clipboard', {
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
  if (opts.client !== false) windowFake.InspectorClient = inspectorClient;

  const store: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    window: windowFake,
    document: documentFake,
    navigator: windowFake.navigator,
    localStorage: {
      getItem: (k: string) => (store[k] != null ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
    },
    console,
    setTimeout, clearTimeout,
    // The poll is captured, not scheduled. `tick()` drives it, so a test can
    // say "one poll happened, and after the pairing landed no more did".
    setInterval: (fn: () => void) => {
      const id = timerId++;
      timers.push({ fn, id });
      return id;
    },
    clearInterval: (id: number) => {
      const i = timers.findIndex((tm) => tm.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    JSON, Math, Date, String, Number, Boolean, Object, Array, Error, RegExp, Promise,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    CustomEvent: class { constructor(public type: string, public init?: unknown) {} },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // The real catalogue and the real i18n table: a fixture here would let a
  // renamed key or a missing translation pass unnoticed.
  vm.runInContext(readSrc('public/js/actions.js'), ctx, { filename: 'actions.js' });
  vm.runInContext(readSrc('public/js/i18n.js'), ctx, { filename: 'i18n.js' });
  const I18N = (windowFake.I18N as { t: (k: string) => string });
  windowFake.AppUtil = {
    t: (k: string) => I18N.t(k),
    esc: (s: unknown) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    toast: (text: unknown, kind?: unknown) => {
      toasts.push({ text: String(text == null ? '' : text), kind: String(kind == null ? '' : kind) });
    },
  };
  vm.runInContext(readSrc('public/js/flow-editor.js'), ctx, { filename: 'flow-editor.js' });

  const FE = windowFake.FlowEditor as {
    loadSteps: (s: unknown[]) => void;
    openNdv: (id: string) => boolean;
    closeNdv: () => boolean;
    getState: () => { nodes: Record<string, { action: string }> };
  };

  h.win = windowFake;

  h.openNode = (action: string, params: Record<string, unknown> = {}) => {
    FE.loadSteps([{ action, params }]);
    const nodes = FE.getState().nodes;
    const id = Object.keys(nodes).filter((k) => nodes[k]!.action === action)[0]!;
    // The same call the canvas double-click makes.
    FE.openNdv(id);
    return id;
  };

  h.rows = () => findAll(body, matcher('.ndv-row')).map((r) => {
    const label = (findAll(r, matcher('label'))[0]?.textContent) || '';
    const connect = findAll(r, matcher('.ndv-connect-btn'))[0] || null;
    const out = findAll(r, matcher('.ndv-connect-out'))[0] || null;
    return { label, connect, out };
  });
  h.row = (label: string) => {
    const found = h.rows().filter((r) => r.label === label)[0];
    if (!found) throw new Error('no field row labelled "' + label + '" (have: ' +
      h.rows().map((r) => r.label).join(', ') + ')');
    return found;
  };
  h.connectFor = (label: string) => {
    const c = h.row(label).connect;
    if (!c) throw new Error('field "' + label + '" has no Connect button');
    return c;
  };
  h.outFor = (label: string) => {
    const o = h.row(label).out;
    if (!o) throw new Error('field "' + label + '" has no output area');
    return o;
  };
  h.msgFor = (label: string) =>
    (findAll(h.outFor(label), matcher('.ndv-connect-msg'))[0]?.textContent) || '';
  h.codeFor = (label: string) =>
    (findAll(h.outFor(label), matcher('.ndv-connect-code'))[0]?.textContent) || '';
  // The Base URL carries its own class so it is addressable independently of the
  // code — the point of item 5 is that they are TWO values, not one blob.
  h.baseFor = (label: string) =>
    (findAll(h.outFor(label), matcher('.ndv-connect-base'))[0]?.textContent) || '';
  h.copiesFor = (label: string) =>
    findAll(h.outFor(label), matcher('.ndv-connect-copy'));

  h.tick = async () => {
    // A copy of the list: a handler that clears its own interval must not
    // reshuffle the array being iterated.
    timers.slice().forEach((tm) => {
      if (timers.indexOf(tm) >= 0) tm.fn();
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  h.strayNodes = () => body.childNodes.filter((c) => c.tagName === 'TEXTAREA');
  h.dropTargetingStatus = () => {
    delete (inspectorClient as Record<string, unknown>).targetingStatus;
  };

  return h;
}

/** Let the authorizeTarget promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Translate a dictionary key with the real i18n table. */
let T: (k: string) => string;
/**
 * The visible label of a field, looked up through the real catalogue and the
 * real dictionary. Hard-coding either the `p.` key prefix or the English string
 * would make these tests fail on a harmless rename, so the label is derived the
 * same way the editor derives it.
 */
let L: (action: string, fieldKey: string) => string;

describe('flow-editor: connecting the Inspector to one field', () => {
  let h: Harness;
  beforeEach(() => {
    h = boot();
    T = (k: string) => (h.win.I18N as { t: (k: string) => string }).t(k);
    L = (action: string, fieldKey: string) => {
      const CAT = h.win.ACTION_CATALOG as { ACTIONS: Array<{ id: string; fields?: Array<{ k: string; label: string }> }> };
      const act = CAT.ACTIONS.filter((a) => a.id === action)[0]!;
      const f = (act.fields || []).filter((x) => x.k === fieldKey)[0]!;
      return T(f.label);
    };
  });

  // ── the harness itself ────────────────────────────────────────
  describe('the harness runs the real editor', () => {
    it('opens a real NDV built by flow-editor.js, not a stub', () => {
      h.openNode('extract-data');
      // Field rows only exist if the real render path ran end to end.
      expect(h.rows().length).toBeGreaterThan(0);
      expect(h.rows().map((r) => r.label)).toContain(L('extract-data', 'selector'));
    });

    it('registers a server-minted id for each pickable field on open', () => {
      const id = h.openNode('extract-data');
      // Proves the fake client is wired the way the editor expects.
      expect(Object.keys(h.minted[id] || {}).sort()).toEqual(['attribute', 'property', 'selector']);
    });
  });

  // ── §5: only fields that can receive a pick ───────────────────
  describe('which fields offer a connection', () => {
    it('offers Connect on a field that can hold a picked value', () => {
      h.openNode('extract-data');
      expect(h.row(L('extract-data', 'selector')).connect).not.toBeNull();
    });

    it('never offers Connect on a checkbox', () => {
      h.openNode('extract-data');
      // `multiple` is a boolean: a CSS selector or attribute value cannot live
      // there, and the server refuses it as a destination.
      expect(h.row(L('extract-data', 'multiple')).connect).toBeNull();
    });

    it('never offers Connect on a number field', () => {
      h.openNode('extract-data');
      expect(h.row(L('extract-data', 'timeout')).connect).toBeNull();
    });

    it('never offers Connect on a fixed dropdown', () => {
      h.openNode('cookie');
      // `op` is an options list — a picked element is never one of its members.
      expect(h.row(L('cookie', 'op')).connect).toBeNull();
    });

    it('offers Connect on exactly the fields the server would accept', () => {
      const id = h.openNode('extract-data');
      const offered = h.rows().filter((r) => r.connect).map((r) => r.label).sort();
      const registered = Object.keys(h.minted[id] || {})
        .map((k) => L('extract-data', k)).sort();
      // The two sets are derived independently — one from the rendered DOM, one
      // from what was registered — so a drift in either direction fails.
      expect(offered).toEqual(registered);
    });

    it('offers a connection on every pickable field, not just the first', () => {
      h.openNode('extract-data');
      expect(h.rows().filter((r) => r.connect).length).toBe(3);
    });
  });

  // ── §8: the destination is the server's, never the client's ───
  describe('what the button asks the server for', () => {
    it('asks for a code only when pressed', () => {
      h.openNode('extract-data');
      expect(h.authCalls).toEqual([]);
    });

    it('sends the server-minted id for that exact field', async () => {
      const id = h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.authCalls).toEqual([{ targetFieldId: h.minted[id]!.selector! }]);
    });

    it('sends a different id for a different field of the same node', async () => {
      const id = h.openNode('extract-data');
      h.connectFor(L('extract-data', 'attribute')).fire('click');
      await settle();
      expect(h.authCalls[0]!.targetFieldId).toBe(h.minted[id]!.attribute!);
      // Field-level, not node-level: the two fields must not share a code.
      expect(h.authCalls[0]!.targetFieldId).not.toBe(h.minted[id]!.selector!);
    });

    it('never sends the node id or the field key as the destination', async () => {
      const id = h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      const sent = h.authCalls[0]!.targetFieldId;
      expect(sent).not.toBe(id);
      expect(sent).not.toBe('selector');
      expect(sent).not.toBe(id + '__selector');
    });

    it('uses the NEW id after the node is re-opened', async () => {
      const first = h.openNode('extract-data');
      const stale = h.minted[first]!.selector!;
      // Re-opening mints fresh ids; the stale one is what a queued pick would
      // resolve against, and it must not be what the editor hands out.
      const again = h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.authCalls[0]!.targetFieldId).toBe(h.minted[again]!.selector!);
      expect(h.authCalls[0]!.targetFieldId).not.toBe(stale);
    });
  });

  // ── §24-style feedback: what the user is told ─────────────────
  describe('what the user is shown', () => {
    it('shows the code to type into the extension', async () => {
      h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.codeFor(L('extract-data', 'selector'))).toBe('ABCD-EFGH');
    });

    it('says what to do with the code and how long it lasts', async () => {
      h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      const msg = h.msgFor(L('extract-data', 'selector'));
      expect(msg).toContain(T('insp.codeReady'));
      // A code with no stated lifetime looks broken rather than expired.
      expect(msg).toContain(T('insp.codeExpires'));
    });

    it('prefers the grouped display form over the raw code', async () => {
      h.openNode('extract-data');
      h.authReply = (id) => ({ code: 'ABCDEFGH', display: 'ABCD-EFGH', target: { targetFieldId: id } });
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.codeFor(L('extract-data', 'selector'))).toBe('ABCD-EFGH');
      expect(h.codeFor(L('extract-data', 'selector'))).not.toBe('ABCDEFGH');
    });

    it('renders the code as text, never as markup', async () => {
      h.openNode('extract-data');
      h.authReply = () => ({ code: 'X', display: '<img src=x onerror=1>' });
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      const chip = findAll(h.outFor(L('extract-data', 'selector')), matcher('.ndv-connect-code'))[0]!;
      expect(chip.textContent).toBe('<img src=x onerror=1>');
      expect(chip.innerHTML).toBe('');
    });

    it('shows the code only in the row whose field it belongs to', async () => {
      h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.codeFor(L('extract-data', 'selector'))).toBe('ABCD-EFGH');
      // A code shown next to the wrong field is a pick delivered to the wrong
      // place, as far as the user can tell.
      expect(h.codeFor(L('extract-data', 'attribute'))).toBe('');
      expect(h.codeFor(L('extract-data', 'property'))).toBe('');
    });

    it('says nothing until the button is pressed', () => {
      h.openNode('extract-data');
      expect(h.msgFor(L('extract-data', 'selector'))).toBe('');
      expect(h.codeFor(L('extract-data', 'selector'))).toBe('');
    });
  });

  // ── refusals must leave the editor usable ─────────────────────
  describe('when the code cannot be issued', () => {
    it('reports the failure instead of showing a blank chip', async () => {
      h.openNode('extract-data');
      h.authReply = () => null;
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.msgFor(L('extract-data', 'selector'))).toBe(T('insp.codeFailed'));
      expect(h.codeFor(L('extract-data', 'selector'))).toBe('');
    });

    it('re-enables the button so the user can retry', async () => {
      h.openNode('extract-data');
      h.authReply = () => null;
      const btn = h.connectFor(L('extract-data', 'selector'));
      btn.fire('click');
      await settle();
      // Left disabled, the only recovery is a page reload.
      expect(btn.disabled).toBe(false);
    });

    it('survives a rejected request and still re-enables', async () => {
      h.openNode('extract-data');
      h.authReply = () => { throw new Error('offline'); };
      const btn = h.connectFor(L('extract-data', 'selector'));
      // A throw inside authorizeTarget models the client rejecting.
      expect(() => btn.fire('click')).not.toThrow();
      await settle();
      expect(btn.disabled).toBe(false);
      expect(h.msgFor(L('extract-data', 'selector'))).toBe(T('insp.codeFailed'));
    });

    it('marks a refusal as an error, not a success', async () => {
      h.openNode('extract-data');
      h.authReply = () => null;
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.outFor(L('extract-data', 'selector')).className).toContain('err');
      expect(h.outFor(L('extract-data', 'selector')).className).not.toContain('ok');
    });

    it('marks a success as a success', async () => {
      h.openNode('extract-data');
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.outFor(L('extract-data', 'selector')).className).toContain('ok');
      expect(h.outFor(L('extract-data', 'selector')).className).not.toContain('err');
    });

    it('a retry after a refusal can still succeed', async () => {
      h.openNode('extract-data');
      h.authReply = () => null;
      const btn = h.connectFor(L('extract-data', 'selector'));
      btn.fire('click');
      await settle();
      h.authReply = (id) => ({ code: 'ZZZZZZZZ', display: 'ZZZZ-ZZZZ', target: { targetFieldId: id } });
      btn.fire('click');
      await settle();
      expect(h.codeFor(L('extract-data', 'selector'))).toBe('ZZZZ-ZZZZ');
      expect(h.msgFor(L('extract-data', 'selector'))).not.toBe(T('insp.codeFailed'));
    });
  });

  // ── no registered target = no code, and no request ────────────
  describe('when the field has no registered destination', () => {
    it('refuses without asking the server', async () => {
      const id = h.openNode('extract-data');
      // Emulate the registration having been lost (server restart, expiry).
      delete h.minted[id];
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      // Asking with no id would let the server pick a destination for us.
      expect(h.authCalls).toEqual([]);
    });

    it('names the reason it cannot connect', async () => {
      const id = h.openNode('extract-data');
      delete h.minted[id];
      h.connectFor(L('extract-data', 'selector')).fire('click');
      await settle();
      expect(h.msgFor(L('extract-data', 'selector'))).toBe(T('insp.err.TARGET_FIELD_NOT_FOUND'));
    });

    it('refuses when the Inspector client is not on the page at all', async () => {
      const bare = boot({ client: false });
      bare.openNode('extract-data');
      const btn = bare.connectFor(L('extract-data', 'selector'));
      expect(() => btn.fire('click')).not.toThrow();
      await settle();
      expect(bare.msgFor(L('extract-data', 'selector'))).toBe(T('insp.err.TARGET_FIELD_NOT_FOUND'));
      expect(bare.authCalls).toEqual([]);
    });
  });

  // ── the words are translated ──────────────────────────────────
  describe('the words shown to the user', () => {
    it('labels the button from the dictionary, in both languages', () => {
      h.openNode('extract-data');
      const en = h.connectFor(L('extract-data', 'selector')).textContent;
      expect(en).toBe(T('insp.connect'));
      expect(en).not.toBe('insp.connect');   // a missing key renders as its key

      const I = h.win.I18N as { t: (k: string) => string; setLang: (l: string) => void };
      I.setLang('fa');
      const fa = I.t('insp.connect');
      expect(fa).not.toBe('insp.connect');
      expect(fa).not.toBe(en);               // present in fa, and actually translated
      I.setLang('en');
    });

    it('explains what the button does, on hover', () => {
      h.openNode('extract-data');
      const btn = h.connectFor(L('extract-data', 'selector'));
      expect(btn.title).toBe(T('insp.connectHint'));
      expect(btn.title).not.toBe('insp.connectHint');
    });

    it('translates every message this control can show', () => {
      const I = h.win.I18N as { t: (k: string) => string; setLang: (l: string) => void };
      const keys = ['insp.connect', 'insp.connectHint', 'insp.codeReady',
        'insp.codeExpires', 'insp.codeFailed', 'insp.err.TARGET_FIELD_NOT_FOUND'];
      (['en', 'fa'] as const).forEach((lang) => {
        I.setLang(lang);
        keys.forEach((k) => {
          // A key that falls through renders as itself — visible as debug text.
          expect(I.t(k), lang + ' is missing ' + k).not.toBe(k);
        });
      });
      I.setLang('en');
    });
  });

  // ── the button is a button, not a form submit ─────────────────
  describe('the control itself', () => {
    it('is type=button so it cannot submit anything', () => {
      h.openNode('extract-data');
      expect(h.connectFor(L('extract-data', 'selector')).type).toBe('button');
    });

    it('disables itself while the request is in flight', () => {
      h.openNode('extract-data');
      let release: ((v: unknown) => void) | null = null;
      h.authReply = () => new Promise((r) => { release = r; });
      const btn = h.connectFor(L('extract-data', 'selector'));
      btn.fire('click');
      // Still pending: a second press would burn a second one-time code.
      expect(btn.disabled).toBe(true);
      if (release) (release as (v: unknown) => void)(null);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // §5 — the code and the Base URL are BOTH shown, and BOTH copyable.
  //
  // The extension asks for two things before it can pair: an address to talk to
  // and a code to prove the user opened the field. This row used to print only
  // the code, which is a dead end — the operator has the secret and nowhere to
  // spend it. And the one Copy it did have was fire-and-forget: on a plain-http
  // LAN origin `navigator.clipboard` is undefined, so the button did nothing at
  // all and said nothing about it.
  // ══════════════════════════════════════════════════════════════
  describe('§5 — both pairing values are shown and both can be copied', () => {
    const SEL = () => L('extract-data', 'selector');
    /** The reply shape the route actually sends, code AND address. */
    const withBase = (id: string) => ({
      code: 'ABCDEFGH', display: 'ABCD-EFGH',
      baseUrl: 'https://auto.example.com', baseUrlSource: 'configured',
      target: { targetFieldId: id }, expiresInMs: 300000,
    });

    it('shows the Base URL next to the code, not just the code', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      expect(h.codeFor(SEL())).toBe('ABCD-EFGH');
      // Without this, the user holds a secret and no address to spend it at.
      expect(h.baseFor(SEL())).toBe('https://auto.example.com');
    });

    it('gives each value its own Copy button', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      // Two values, two buttons. One button for both would copy a blob that
      // fits neither of the extension's two input boxes.
      expect(h.copiesFor(SEL()).length).toBe(2);
    });

    it('labels each value so the two are not mixed up', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      const labels = findAll(h.outFor(SEL()), matcher('.ndv-connect-label'))
        .map((n) => n.textContent);
      expect(labels).toContain(T('tgt.authCode'));
      expect(labels).toContain(T('tgt.baseUrl'));
    });

    it('copies the code when its Copy is pressed', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.copiesFor(SEL())[0]!.fire('click');
      await settle();
      expect(h.clipboard.map((c) => c.text)).toEqual(['ABCD-EFGH']);
    });

    it('copies the exact Base URL, with no trailing slash invented', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.copiesFor(SEL())[1]!.fire('click');
      await settle();
      // A pasted address that differs by one character is a failed pairing with
      // no diagnostic, so this is asserted exactly rather than with `toContain`.
      expect(h.clipboard.map((c) => c.text)).toEqual(['https://auto.example.com']);
    });

    it('falls back to execCommand when the clipboard API rejects', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      // A rejection is what an unfocused document gives you — routine, not exotic.
      h.breakClipboard({ clipboardFails: true });
      h.copiesFor(SEL())[1]!.fire('click');
      await settle();
      expect(h.clipboard).toEqual([{ text: 'https://auto.example.com', via: 'exec' }]);
    });

    it('falls back to execCommand when there is no clipboard API at all', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      // The plain-http LAN case — exactly when someone is copying a Base URL.
      h.breakClipboard({ noClipboardApi: true });
      h.copiesFor(SEL())[0]!.fire('click');
      await settle();
      expect(h.clipboard).toEqual([{ text: 'ABCD-EFGH', via: 'exec' }]);
    });

    it('leaves no textarea behind after the fallback runs', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.breakClipboard({ noClipboardApi: true });
      h.copiesFor(SEL())[0]!.fire('click');
      await settle();
      // A leaked off-screen textarea steals focus and breaks the next keystroke.
      expect(h.strayNodes()).toEqual([]);
    });

    it('removes the textarea even when execCommand itself fails', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.breakClipboard({ noClipboardApi: true, execFails: true });
      h.copiesFor(SEL())[0]!.fire('click');
      await settle();
      expect(h.clipboard).toEqual([]);
      // Cleanup must not be conditional on success.
      expect(h.strayNodes()).toEqual([]);
    });

    it('shows one Copy when the server sent a code but no address', async () => {
      h.openNode('extract-data');
      h.authReply = (id) => ({ code: 'ABCDEFGH', display: 'ABCD-EFGH', target: { targetFieldId: id } });
      h.connectFor(SEL()).fire('click');
      await settle();
      // An address invented client-side would be shown with the same confidence
      // as a configured one and be wrong more often, so none is shown.
      expect(h.baseFor(SEL())).toBe('');
      expect(h.copiesFor(SEL()).length).toBe(1);
    });

    it('renders the Base URL as text, never as markup', async () => {
      h.openNode('extract-data');
      h.authReply = (id) => ({
        code: 'X', display: 'X', baseUrl: '<img src=x onerror=1>',
        target: { targetFieldId: id },
      });
      h.connectFor(SEL()).fire('click');
      await settle();
      const chip = findAll(h.outFor(SEL()), matcher('.ndv-connect-base'))[0]!;
      expect(chip.textContent).toBe('<img src=x onerror=1>');
      expect(chip.innerHTML).toBe('');
    });

    it('marks the Copy buttons up as buttons, with an accessible name', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.copiesFor(SEL()).forEach((b) => {
        // Inside the NDV a submit-type button would close the dialog.
        expect(b.type).toBe('button');
        // Two identically-named "Copy" buttons are indistinguishable to a
        // screen reader, so each says WHICH value it copies.
        expect(b.getAttribute('aria-label')).toContain(T('insp.copy'));
      });
      expect(h.copiesFor(SEL())[0]!.getAttribute('aria-label'))
        .not.toBe(h.copiesFor(SEL())[1]!.getAttribute('aria-label'));
    });

    it('clears both values when a later attempt fails', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      expect(h.baseFor(SEL())).not.toBe('');
      h.authReply = () => { throw new Error('nope'); };
      h.connectFor(SEL()).fire('click');
      await settle();
      // A stale address next to an error message invites a retry against the
      // wrong server.
      expect(h.codeFor(SEL())).toBe('');
      expect(h.baseFor(SEL())).toBe('');
      expect(h.msgFor(SEL())).toBe(T('insp.codeFailed'));
    });
  });

  // ══════════════════════════════════════════════════════════════
  // §9b — the box goes away when the extension accepts the code.
  //
  //   «توقع داشتم وقتی ارتباط برقرار میشه باکسی که کد اتورایز و بیس یو ار ال رو
  //    نمایش میاد ... خارج میشد و انتظار یک الرت موفقیت بودم ولی هیچ اتفاقی
  //    نیوفتاد»
  //
  // And nothing did: this row printed a code and then never asked about it
  // again. The two browsers cannot see each other, so the server — the only
  // party that sees both — has to be polled. The chooser dialog already did
  // this; this row never had it.
  // ══════════════════════════════════════════════════════════════
  describe('§9b — the row notices the pairing and puts the box away', () => {
    const SEL = () => L('extract-data', 'selector');
    const withBase = (id: string) => ({
      code: 'ABCDEFGH', display: 'ABCD-EFGH',
      baseUrl: 'https://auto.example.com',
      target: { targetFieldId: id }, expiresInMs: 300000,
    });

    it('starts asking the server about the code it just issued', async () => {
      const id = h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();
      // Polled with the SERVER's id for this field — a client-side id would ask
      // about a destination that does not exist.
      expect(h.statusCalls).toEqual([h.minted[id]!.selector!]);
    });

    it('does not poll before a code has been issued', async () => {
      h.openNode('extract-data');
      await h.tick();
      // A row nobody pressed must not generate traffic.
      expect(h.statusCalls).toEqual([]);
      expect(h.intervals()).toBe(0);
    });

    it('keeps the box up while the extension has not paired yet', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.statusQueue.push({ paired: false });
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();
      await h.tick();
      // Two polls, still unpaired: the code is the user's only way in and
      // clearing it early would strand them.
      expect(h.codeFor(SEL())).toBe('ABCD-EFGH');
      expect(h.baseFor(SEL())).toBe('https://auto.example.com');
      expect(h.statusCalls.length).toBe(2);
    });

    it('empties the box once the pairing lands', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.statusQueue.push({ paired: false }, { paired: true });
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();                    // not yet
      expect(h.codeFor(SEL())).toBe('ABCD-EFGH');
      await h.tick();                    // paired
      // The content was a ONE-TIME code and an address to spend it at. Both are
      // spent; leaving them up invites a second, failing attempt.
      expect(h.codeFor(SEL())).toBe('');
      expect(h.baseFor(SEL())).toBe('');
      expect(h.msgFor(SEL())).toBe('');
      expect(h.copiesFor(SEL())).toEqual([]);
    });

    it('says out loud that the extension connected', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.statusQueue.push({ paired: true });
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();
      // «انتظار یک الرت موفقیت بودم» — a box that merely vanishes is
      // indistinguishable from a box that crashed.
      expect(h.toasts).toEqual([{ text: T('insp.pairedNow'), kind: 'ok' }]);
      expect(h.toasts[0]!.text).not.toBe('insp.pairedNow');
    });

    it('stops polling after the pairing lands', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.statusQueue.push({ paired: true });
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();
      expect(h.intervals()).toBe(0);
      const seen = h.statusCalls.length;
      await h.tick();
      // A timer that outlives its answer polls forever, once per open node.
      expect(h.statusCalls.length).toBe(seen);
      expect(h.toasts.length).toBe(1);
    });

    it('keeps polling through a failed poll', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.statusQueue.push(new Error('offline'), { paired: true });
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();                    // rejects
      expect(h.codeFor(SEL())).toBe('ABCD-EFGH');
      await h.tick();                    // recovers, pairs
      // One dropped request must not strand the user with a live code and a
      // dead watcher.
      expect(h.codeFor(SEL())).toBe('');
      expect(h.toasts.length).toBe(1);
    });

    it('stops watching when the node is closed underneath it', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      expect(h.intervals()).toBe(1);
      (h.win.FlowEditor as { closeNdv: () => boolean }).closeNdv();
      await h.tick();
      // The id the timer holds is no longer a live destination, so it must not
      // keep asking about it — one leaked timer per opened field otherwise.
      expect(h.intervals()).toBe(0);
    });

    it('replaces the old watcher when a second code is issued', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.connectFor(SEL()).fire('click');
      await settle();
      // Two presses, one watcher: otherwise every retry doubles the polling and
      // the toast fires once per stacked timer.
      expect(h.intervals()).toBe(1);
      h.statusQueue.push({ paired: true });
      await h.tick();
      expect(h.toasts.length).toBe(1);
    });

    it('does not start a watcher when the code could not be issued', async () => {
      h.openNode('extract-data');
      h.authReply = () => null;
      h.connectFor(SEL()).fire('click');
      await settle();
      expect(h.msgFor(SEL())).toBe(T('insp.codeFailed'));
      // Nothing was issued, so there is nothing to watch for.
      expect(h.intervals()).toBe(0);
    });

    it('still shows the code when the client is too old to poll', async () => {
      h.openNode('extract-data');
      h.dropTargetingStatus();
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      // Degraded, not broken: the box simply stays up, and copying still works.
      expect(h.codeFor(SEL())).toBe('ABCD-EFGH');
      expect(h.baseFor(SEL())).toBe('https://auto.example.com');
      expect(h.intervals()).toBe(0);
      await h.tick();
      expect(h.statusCalls).toEqual([]);
    });

    it('ignores an answer that does not say it paired', async () => {
      h.openNode('extract-data');
      h.authReply = withBase;
      h.statusQueue.push(null);
      h.connectFor(SEL()).fire('click');
      await settle();
      await h.tick();
      // An empty or malformed reply is not consent; treating it as success would
      // clear a code the extension never received.
      expect(h.codeFor(SEL())).toBe('ABCD-EFGH');
      expect(h.toasts).toEqual([]);
    });

    it('watches each field separately', async () => {
      const id = h.openNode('extract-data');
      h.authReply = withBase;
      h.connectFor(SEL()).fire('click');
      await settle();
      h.connectFor(L('extract-data', 'attribute')).fire('click');
      await settle();
      expect(h.intervals()).toBe(2);
      h.statusQueue.push({ paired: true });
      await h.tick();
      // Both cleared, and each asked about its OWN destination.
      expect(h.statusCalls.slice(0, 2).sort())
        .toEqual([h.minted[id]!.attribute!, h.minted[id]!.selector!].sort());
      expect(h.codeFor(SEL())).toBe('');
      expect(h.codeFor(L('extract-data', 'attribute'))).toBe('');
    });
  });
});
