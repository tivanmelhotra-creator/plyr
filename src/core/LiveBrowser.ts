'use strict';

import type { BrowserContext, Page, CDPSession } from 'playwright';
import { GlobalBrowser } from './GlobalBrowser';
import {
  installConsentAutoDismiss,
  hasSavedSession,
  clearStorageState,
} from './BrowserProfile';

// ════════════════════════════════════════════════════════════════
// LiveBrowser (Step 12) — interactive, streamable browser sessions.
// ----------------------------------------------------------------
// Each UI client that opens the "Live Browser View" gets one
// LiveBrowserSession: a dedicated, isolated BrowserContext + Page on
// the shared (headless) Chromium, plus a CDP session running
// Page.startScreencast. Frames are pushed to a sink (the WebSocket)
// as base64 JPEG; the UI renders them on a <canvas>. Input commands
// (navigate / click / type / scroll / key) are replayed onto the
// page via CDP Input.* so the user can drive the real server browser.
//
// An Element Picker mode is injected as page script: hovering
// highlights elements and a click reports a robust CSS selector +
// XPath back over the channel (without performing a real click).
//
// Sessions are reference-counted by socket and auto-expire after an
// idle TTL so the browser is not held open forever (lifecycle mgmt).
// ════════════════════════════════════════════════════════════════

export interface ScreencastFrame {
  data: string;        // base64 JPEG
  sessionId: number;   // CDP screencast frame ack id
  width: number;
  height: number;
}

export interface PickAttr {
  name: string;
  value: string;
}

export interface PickCandidate {
  /** The selector itself, e.g. `button[data-testid="save"]`. */
  sel: string;
  /** How many elements it matches on the page right now. 1 is the goal. */
  count: number;
}

export interface PickResult {
  css: string;
  xpath: string;
  text?: string;
  tag?: string;
  // `k` routes the single page binding to the right channel event:
  //   'pick'   → the user clicked (or walked the DOM): lock this in
  //   'hover'  → the pointer merely moved over it: live preview only
  //   'verify' → the answer to a "how many elements match?" request
  k?: 'pick' | 'hover' | 'verify';
  // Attributes of the element (Automa's "Attributes" tab). Capped page-side.
  attrs?: PickAttr[];
  // How many elements the generated selector matches — 1 is what you want;
  // 0 means the selector is broken, >1 means it is ambiguous.
  count?: number;
  // Which of those matches this element is (1-based; 0 when unknown). With
  // `count` it renders as Automa's "#1 Element", but able to say "#2 of 4".
  index?: number;
  // Alternative selectors for the picked element, best-first, each with its own
  // match count — the panel's "Candidates" tab. Empty on hover: computing them
  // costs one querySelectorAll per candidate, which a ~14/sec hover cannot pay.
  candidates?: PickCandidate[];
  // Whether DOM traversal is possible from here (drives the ↑/↓ arrows).
  hasParent?: boolean;
  hasChild?: boolean;
}

type FrameSink = (frame: ScreencastFrame) => void;
type EventSink = (type: string, data: Record<string, unknown>) => void;

const IDLE_TTL_MS = 5 * 60 * 1000;     // close session after 5 min idle
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

// The picker script is injected into the page. It draws an overlay,
// highlights the hovered element, and reports a CSS path + XPath through a
// single binding exposed by Playwright. It does NOT navigate or trigger the
// element's own handlers (capture + preventDefault + stopPropagation).
//
// Three channels share the one binding, distinguished by `k`:
//   hover  — throttled, fires as the pointer moves (live preview in the panel)
//   pick   — a real click, or a ↑/↓ DOM-traversal step (the locked answer)
//   verify — the reply to __abVerify(sel): how many elements that selector hits
//
// Everything reported is capped page-side (attribute count, value/text length,
// selector depth) because it travels over a WebSocket on every mouse move.
// Exported so tests can inject the REAL script into a real page instead of a
// copy that can drift from it (tests/unit/picker-drive.test.ts). Nothing in
// `src/` imports it by name; it is used here through `page.evaluate` below.
export const PICKER_SCRIPT = `(() => {
  if (window.__abPickerActive) return;
  window.__abPickerActive = true;
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f8cff;background:rgba(79,140,255,.15);box-shadow:0 0 0 1px #fff;transition:all .03s;';
  document.documentElement.appendChild(box);
  var locked = null;      // element fixed by a click (traversal starts here)
  var lastHover = null;   // last element reported on the hover channel
  var lastAt = 0;         // hover throttle stamp
  function cssPath(el){
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 6){
      var sel = el.nodeName.toLowerCase();
      if (el.id){ parts.unshift('#' + CSS.escape(el.id)); break; }
      var cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0,2);
      if (cls.length) sel += '.' + cls.map(function(c){return CSS.escape(c);}).join('.');
      var parent = el.parentNode;
      if (parent){
        var sibs = Array.prototype.filter.call(parent.children, function(c){return c.nodeName === el.nodeName;});
        if (sibs.length > 1){ sel += ':nth-of-type(' + (sibs.indexOf(el)+1) + ')'; }
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function xPath(el){
    if (el && el.id) return '//*[@id="' + el.id + '"]';
    var parts = [];
    while (el && el.nodeType === 1){
      var idx = 1, sib = el.previousSibling;
      while (sib){ if (sib.nodeType === 1 && sib.nodeName === el.nodeName) idx++; sib = sib.previousSibling; }
      parts.unshift(el.nodeName.toLowerCase() + '[' + idx + ']');
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }
  // Attributes, in source order, capped: a Gmail node can carry a 2 KB jslog.
  function attrsOf(el){
    var out = [];
    var list = el && el.attributes ? el.attributes : [];
    for (var i = 0; i < list.length && out.length < 12; i++){
      out.push({ name: list[i].name, value: String(list[i].value || '').slice(0, 160) });
    }
    return out;
  }
  // How many nodes a selector hits. Anything starting with / ( or . . is XPath;
  // that is the same sniffing Playwright's locator() does, so the count the
  // panel shows is the count the run will see.
  function matchCount(sel){
    if (!sel) return 0;
    try {
      if (/^\\s*[(/]|^\\s*\\.\\./.test(sel)){
        var r = document.evaluate(sel, document, null, 7, null);
        return r.snapshotLength;
      }
      return document.querySelectorAll(sel).length;
    } catch (e) { return -1; }   // -1 = the selector itself is invalid
  }
  // Which of the selector's matches is THIS element (1-based, 0 = unknown).
  // Automa's panel shows a bare "#1 Element"; pairing the index with the count
  // answers the more useful question: "the selector hits 4 nodes and I am on
  // the 2nd" — which is what tells you the selector is too loose.
  function indexOf(el, sel){
    if (!sel) return 0;
    try {
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++){ if (nodes[i] === el) return i + 1; }
    } catch (e) {}
    return 0;
  }
  // Candidate selectors, best-first, each with its own match count.
  //
  // Why: cssPath() walks up to 6 ancestors gluing 2 classes + :nth-of-type at
  // every level. That is correct today and broken after the next re-render —
  // framework class hashes and sibling order are the two least stable things on
  // a page. A test id or a name attribute survives both. So we offer the stable
  // hooks FIRST and let the panel show what each one actually matches, instead
  // of handing over one brittle path and hoping.
  //
  // Deliberately cheap: attribute lookups + querySelectorAll on a handful of
  // candidates, computed only for the locked element and the hovered one.
  function candidatesFor(el){
    if (!(el instanceof Element)) return [];
    var tag = el.nodeName.toLowerCase();
    var out = [];
    var seen = {};
    function add(sel){
      if (!sel || seen[sel]) return;
      seen[sel] = 1;
      var n = matchCount(sel);
      if (n <= 0) return;                     // never offer something that misses
      out.push({ sel: sel, count: n });
    }
    function attr(name){
      var v = el.getAttribute(name);
      return v && v.length < 120 ? v : '';
    }
    if (el.id) add('#' + CSS.escape(el.id));
    // Purpose-built hooks, in the order a human would trust them.
    var byAttr = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa',
                  'name', 'aria-label', 'placeholder', 'title', 'type', 'href'];
    for (var i = 0; i < byAttr.length; i++){
      var v = attr(byAttr[i]);
      if (!v) continue;
      add(tag + '[' + byAttr[i] + '=' + JSON.stringify(v) + ']');
    }
    var role = attr('role');
    if (role) add(tag + '[role=' + JSON.stringify(role) + ']');
    // A single class is more durable than a chain of two plus nth-of-type.
    var cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
    for (var c = 0; c < cls.length && c < 3; c++){
      // Skip the hashed/util classes that change on every build.
      if (/^(css-|sc-|jsx-|_)/.test(cls[c]) || /\\d{4,}/.test(cls[c])) continue;
      add(tag + '.' + CSS.escape(cls[c]));
    }
    add(cssPath(el));
    // Unique wins, then the shortest — a short unique selector is the one a
    // human can read and a re-render is least likely to break.
    out.sort(function(a, b){
      if ((a.count === 1) !== (b.count === 1)) return a.count === 1 ? -1 : 1;
      return a.sel.length - b.sel.length;
    });
    return out.slice(0, 6);
  }
  function payload(el, kind){
    var css = cssPath(el);
    return {
      k: kind,
      css: css,
      xpath: xPath(el),
      tag: el.nodeName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      attrs: attrsOf(el),
      count: matchCount(css),
      index: indexOf(el, css),
      // Only for a real pick: computing candidates on every throttled hover
      // frame would run querySelectorAll ~7x at 12 Hz for nothing, since the
      // panel's Candidates tab is about the element you committed to.
      candidates: kind === 'pick' ? candidatesFor(el) : [],
      hasParent: !!(el.parentElement && el.parentElement.nodeName !== 'HTML'),
      hasChild: !!el.firstElementChild
    };
  }
  function outline(el){
    if (!el) return;
    var r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }
  function report(el, kind){
    try { window.__abReportPick(payload(el, kind)); } catch (err) {}
  }
  function onMove(e){
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box) return;
    window.__abPickHover = el;
    if (!locked) outline(el);
    // Throttle: the panel only needs ~12 updates/sec, not one per pixel.
    var now = Date.now();
    if (el === lastHover && now - lastAt < 400) return;
    if (now - lastAt < 80) return;
    lastHover = el; lastAt = now;
    report(el, 'hover');
  }
  function onClick(e){
    // Only a REAL pointer click picks. Programmatic clicks (el.click()) are not
    // trusted, and swallowing them would break anything the page — or our own
    // cookie-consent auto-dismisser — does to itself while the picker is armed.
    // CDP-dispatched input IS trusted, so the user's clicks still arrive.
    if (e.isTrusted === false) return;
    e.preventDefault(); e.stopPropagation();
    var el = window.__abPickHover || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    locked = el;
    outline(el);
    report(el, 'pick');
  }
  // Space selects whatever is under the pointer — Automa's shortcut, and the
  // only way to pick an element that disappears on mouse-out (menus, tooltips).
  function onKey(e){
    if (e.code !== 'Space' && e.key !== ' ') return;
    var el = window.__abPickHover;
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    locked = el; outline(el); report(el, 'pick');
  }
  // ↑ / ↓ in the panel: walk to the parent or the first child of the locked
  // element. Selecting a whole row/card is usually one step up from the text
  // node you can actually see, which is why this exists.
  window.__abPickStep = function(dir){
    var base = locked || window.__abPickHover;
    if (!base) return false;
    var next = dir === 'down' ? base.firstElementChild : base.parentElement;
    if (!next || next.nodeName === 'HTML') return false;
    locked = next; outline(next); report(next, 'pick');
    return true;
  };
  // The panel's double-check button: count matches for a hand-typed selector
  // and flash an outline over each of them (capped, so 5 000 rows can't hang).
  window.__abVerify = function(sel){
    var n = matchCount(sel);
    try {
      window.__abReportPick({ k: 'verify', css: String(sel || ''), xpath: '', count: n });
    } catch (e) {}
    if (n > 0){
      var nodes = [];
      try {
        if (/^\\s*[(/]|^\\s*\\.\\./.test(sel)){
          var r = document.evaluate(sel, document, null, 7, null);
          for (var i = 0; i < r.snapshotLength && i < 40; i++) nodes.push(r.snapshotItem(i));
        } else {
          nodes = Array.prototype.slice.call(document.querySelectorAll(sel), 0, 40);
        }
      } catch (e) { nodes = []; }
      var marks = nodes.map(function(el){
        var rr = el.getBoundingClientRect();
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #22c55e;background:rgba(34,197,94,.12);left:' + rr.left + 'px;top:' + rr.top + 'px;width:' + rr.width + 'px;height:' + rr.height + 'px;';
        document.documentElement.appendChild(d);
        return d;
      });
      setTimeout(function(){ marks.forEach(function(d){ if (d.parentNode) d.parentNode.removeChild(d); }); }, 1400);
    }
    return n;
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__abStopPicker = function(){
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (box && box.parentNode) box.parentNode.removeChild(box);
    window.__abPickerActive = false;
    window.__abPickStep = null;
    window.__abVerify = null;
  };
})();`;

export class LiveBrowserSession {
  public readonly id: string;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private frameSink: FrameSink | null = null;
  private eventSink: EventSink | null = null;
  private pickerOn = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  public readonly userId: string;
  private vp = { ...DEFAULT_VIEWPORT };
  // Whether this user already had a saved browser session when we started;
  // the UI shows it so "why am I logged out" is never a mystery.
  private hadSavedSession = false;

  constructor(id: string, userId: string) {
    this.id = id;
    this.userId = userId;
  }

  setSinks(frameSink: FrameSink, eventSink: EventSink): void {
    this.frameSink = frameSink;
    this.eventSink = eventSink;
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Bring up an isolated context + page and start the CDP screencast.
  async start(): Promise<void> {
    if (this.closed) throw new Error('session_closed');
    // A PERSISTENT context, not a throwaway one: this session has a human in
    // it. Cookies from last time come back, so a page the user logged into
    // stays logged in instead of greeting them with a login wall every open
    // (HANDOFF 15 AUTH-GAP). The fingerprint is stable for the same reason.
    this.hadSavedSession = await hasSavedSession(this.userId);
    this.context = await GlobalBrowser.getInteractiveContext(this.userId, this.vp);
    this.page = await this.context.newPage();
    await this.page.setViewportSize(this.vp).catch(() => {});

    // Consent walls cover the very elements the user is trying to pick, so they
    // are dismissed before the page's own scripts run. Named-CMP allowlist only
    // — see BrowserProfile.CONSENT_SCRIPT for why a text match would be unsafe.
    await installConsentAutoDismiss(this.page);

    // Expose the ONE binding the picker uses. `k` decides which channel event
    // the UI receives, so hover previews cannot be mistaken for a real pick.
    await this.page.exposeBinding('__abReportPick', (_src, payload: PickResult) => {
      const kind = payload && payload.k === 'hover' ? 'hover'
        : payload && payload.k === 'verify' ? 'verified'
          : 'pick';
      this.emit(kind, payload as unknown as Record<string, unknown>);
    }).catch(() => {});

    // CDP screencast (JPEG frames).
    this.cdp = await this.context.newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', async (params: {
      data: string;
      sessionId: number;
      metadata: { deviceWidth?: number; deviceHeight?: number };
    }) => {
      // Acknowledge so Chromium keeps sending frames.
      try { await this.cdp!.send('Page.screencastFrameAck', { sessionId: params.sessionId }); }
      catch { /* ignore */ }
      if (this.frameSink) {
        this.frameSink({
          data: params.data,
          sessionId: params.sessionId,
          width: params.metadata.deviceWidth || this.vp.width,
          height: params.metadata.deviceHeight || this.vp.height,
        });
      }
    });

    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.vp.width,
      maxHeight: this.vp.height,
      everyNthFrame: 1,
    });

    // Re-inject picker after navigations if it was on.
    this.page.on('framenavigated', async (frame) => {
      if (frame === this.page!.mainFrame() && this.pickerOn) {
        await this.injectPicker().catch(() => {});
      }
    });

    this.touch();
    // `signedIn` tells the panel whether cookies were restored, so the UI can
    // stop claiming "fresh, signed-out browser" once that is no longer true.
    this.emit('ready', {
      url: this.page.url(),
      width: this.vp.width,
      height: this.vp.height,
      signedIn: this.hadSavedSession,
    });
  }

  private emit(type: string, data: Record<string, unknown>): void {
    if (this.eventSink) {
      try { this.eventSink(type, data); } catch { /* best-effort */ }
    }
  }

  // Reset idle timer; close the session if no activity for IDLE_TTL_MS.
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.emit('expired', {});
      void this.close();
    }, IDLE_TTL_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async navigate(url: string): Promise<void> {
    this.touch();
    if (!this.page) return;
    let target = String(url || '').trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    try {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.emit('navigated', { url: this.page.url() });
    } catch (e) {
      this.emit('error', { message: (e as Error).message });
    }
  }

  async click(x: number, y: number): Promise<void> {
    this.touch();
    if (!this.cdp) return;
    const px = Math.round(x);
    const py = Math.round(y);
    try {
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
    } catch { /* ignore */ }
  }

  // Pointer movement without a click. The Element Picker needs this: its
  // page-side highlight + hover preview are driven by mousemove, and the
  // client streams a canvas image, not the real cursor.
  async move(x: number, y: number): Promise<void> {
    this.touch();
    if (!this.cdp) return;
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(x), y: Math.round(y),
      });
    } catch { /* ignore */ }
  }

  async scroll(x: number, y: number, dy: number): Promise<void> {
    this.touch();
    if (!this.cdp) return;
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(dy),
      });
    } catch { /* ignore */ }
  }

  // Type a string by inserting text (works for most inputs/contenteditable).
  async type(text: string): Promise<void> {
    this.touch();
    if (!this.cdp) return;
    try {
      await this.cdp.send('Input.insertText', { text: String(text) });
    } catch { /* ignore */ }
  }

  // Send a single special key (Enter, Backspace, Tab, etc.).
  async key(name: string): Promise<void> {
    this.touch();
    if (!this.page) return;
    try {
      await this.page.keyboard.press(name);
    } catch { /* ignore */ }
  }

  private async injectPicker(): Promise<void> {
    if (!this.page) return;
    try { await this.page.evaluate(PICKER_SCRIPT); } catch { /* ignore */ }
  }

  async setPicker(on: boolean): Promise<void> {
    this.touch();
    this.pickerOn = !!on;
    if (!this.page) return;
    if (on) {
      await this.injectPicker();
    } else {
      try { await this.page.evaluate('window.__abStopPicker && window.__abStopPicker()'); } catch { /* ignore */ }
    }
    this.emit('picker', { on: this.pickerOn });
  }

  // Walk the picked element to its parent ('up') or first child ('down').
  // The page script reports the new element on the 'pick' channel itself, so
  // there is exactly one code path producing a selector.
  async pickStep(dir: string): Promise<void> {
    this.touch();
    if (!this.page || !this.pickerOn) return;
    const arg = dir === 'down' ? 'down' : 'up';
    try {
      await this.page.evaluate(
        `window.__abPickStep && window.__abPickStep(${JSON.stringify(arg)})`
      );
    } catch { /* ignore */ }
  }

  // Count (and flash) the elements a hand-typed selector matches. Answers on
  // the 'verified' channel. Works without the picker overlay being on.
  async verifySelector(selector: string): Promise<void> {
    this.touch();
    if (!this.page) return;
    const sel = String(selector || '');
    if (!sel) return;
    try {
      if (!this.pickerOn) await this.injectPicker();
      await this.page.evaluate(`window.__abVerify && window.__abVerify(${JSON.stringify(sel)})`);
    } catch { /* ignore */ }
  }

  /**
   * Drop this user's saved cookies/localStorage and clear the live context,
   * i.e. "sign out of everything" for the picker browser. Needed because a
   * persistent session that cannot be reset is a trap: a half-broken login
   * would follow the user around with no way to start clean.
   */
  async forgetSession(): Promise<void> {
    await clearStorageState(this.userId);
    this.hadSavedSession = false;
    try { if (this.context) await this.context.clearCookies(); } catch { /* ignore */ }
    this.emit('session', { signedIn: false, cleared: true });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try { if (this.cdp) await this.cdp.send('Page.stopScreencast').catch(() => {}); } catch { /* ignore */ }
    try { if (this.cdp) await this.cdp.detach().catch(() => {}); } catch { /* ignore */ }
    try { if (this.page) await this.page.close().catch(() => {}); } catch { /* ignore */ }
    // Save BEFORE closing, or the login the user just performed inside the
    // picker dies with the context — which was exactly the old behaviour.
    try {
      if (this.context) await GlobalBrowser.saveAndCloseContext(this.context, this.userId);
    } catch { /* ignore */ }
    this.cdp = null; this.page = null; this.context = null;
  }
}

// Registry of active sessions (one per connected socket). Keeps a cap
// so a single server can't be exhausted by too many live views.
export class LiveBrowserManager {
  private sessions = new Map<string, LiveBrowserSession>();
  private seq = 0;
  constructor(private readonly maxSessions = 8) {}

  count(): number { return this.sessions.size; }

  create(userId: string): LiveBrowserSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error('too_many_sessions');
    }
    this.seq += 1;
    const id = `lb_${Date.now().toString(36)}_${this.seq}`;
    const s = new LiveBrowserSession(id, userId);
    this.sessions.set(id, s);
    return s;
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      await s.close();
    }
  }

  async shutdown(): Promise<void> {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close().catch(() => {})));
  }
}
