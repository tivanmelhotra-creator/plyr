'use strict';

import type { BrowserContext, Page, CDPSession, FileChooser } from 'playwright';
import { GlobalBrowser } from './GlobalBrowser';
import {
  installConsentAutoDismiss,
  hasSavedSession,
  clearStorageState,
} from './BrowserProfile';
import { resolveUpload, discardUploads } from './RemoteUploads';
import {
  loadTabs,
  saveTabs,
  clearTabs,
  MAX_SAVED_TABS,
  type SavedTab,
} from './BrowserTabs';

// ════════════════════════════════════════════════════════════════
// LiveBrowser (Step 12) — interactive, streamable browser sessions.
// ----------------------------------------------------------------
// Each UI client that opens the "Live Browser View" gets one
// LiveBrowserSession: a BrowserContext with a LIST OF TABS on the
// shared Chromium, plus a CDP session running Page.startScreencast on
// whichever tab is in front. Frames are pushed to a sink (the
// WebSocket) as base64 JPEG; the UI renders them on a <canvas>. Input
// commands (navigate / click / type / scroll / key) are replayed onto
// the active tab via CDP Input.* so the user can drive the real
// server browser.
//
// An Element Picker mode is injected as page script: hovering
// highlights elements and a click reports a robust CSS selector +
// XPath back over the channel (without performing a real click).
//
// ── MULTIPLE TABS (why this is not optional) ────────────────────
// The session used to own exactly ONE Page, and every "open this
// somewhere" reused it. Two everyday actions were therefore
// destructive rather than additive:
//
//   * opening an extension's popup (chrome-extension://…/popup.html)
//     replaced the page the user was working on — the page they wanted
//     the cookies FOR;
//   * anything the page opened itself (target=_blank, window.open, an
//     OAuth window) appeared as a Page nobody was watching, so the
//     login the user had just started was invisible and unreachable.
//
// So a session now holds a TAB LIST with one active tab, adopts pages
// the context opens on its own, and reports the strip to the client —
// the behaviour of the browser it is impersonating.
//
// ── SURVIVING A RELOAD / CRASH ──────────────────────────────────
// A cookie-import extension REFRESHES the tab (often the whole
// browser) the moment it writes cookies. The old session bound its
// CDP screencast to one Page for its whole life, so anything that
// replaced or killed that Page left a socket that was open, a UI that
// looked connected, and a browser that answered nothing. The only way
// out was closing the window and opening it again.
//
// Recovery is now explicit and automatic: `crash` / `close` on a Page
// re-binds onto a live tab (or opens a fresh one), the CDP transport
// is rebuilt rather than reused, and a frame watchdog re-arms a
// screencast that silently stopped producing frames. `resync` is the
// same routine on demand, which is what the client's Reconnect button
// calls instead of tearing down the socket.
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

/** One entry of the tab strip, as the client renders it. */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
  /** True while the tab is a restored placeholder that has not loaded yet. */
  pending?: boolean;
  /** True when the page behind it is gone (crashed/closed) but the tab remains. */
  dead?: boolean;
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

// How often to ask the active page "are you still there?".
//
// `page.isClosed()` is not enough. When a cookie-import extension reloads the
// tab, or the renderer behind it is replaced, Playwright can keep a Page handle
// that reports `isClosed() === false` while every call through it rejects with
// "Target closed". Nothing pushes an event for that, so the only way to notice
// is to poke it on a timer — otherwise the UI happily shows a frozen last frame
// and every click silently goes nowhere. 10s is a compromise: fast enough that
// the user does not sit in front of a dead canvas for long, slow enough that
// the extra CDP round-trip is free.
const HEALTH_POLL_MS = 10_000;

/**
 * Turn whatever the user typed into something `page.goto` accepts.
 *
 * The allowlist is exactly three schemes:
 *   https?://          — the normal case
 *   chrome-extension:// — an extension's own page (this is how a cookie
 *                         import/export extension's popup gets driven from
 *                         inside the canvas; a toolbar popup is not part of any
 *                         page and cannot be screencast)
 *   about:             — about:blank, for a genuinely empty new tab
 *
 * `file://` is deliberately absent. Navigate commands arrive over a WebSocket,
 * and letting one read the server's filesystem would turn the picker into an
 * exfiltration tool. Anything else gets `https://` prepended, so typing
 * "example.com" works like it does in a real address bar.
 */
function normalizeTarget(url: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (/^(https?:\/\/|chrome-extension:\/\/|about:)/i.test(raw)) return raw;
  // A bare "javascript:"/"data:"/"file:" (or any other scheme) must not slip
  // through by being prefixed into something that looks valid, so reject it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
  return 'https://' + raw;
}

/**
 * Is this page still able to answer? See HEALTH_POLL_MS for why `isClosed()`
 * cannot be trusted on its own.
 *
 * `page.title()` is the cheapest round-trip that actually reaches the renderer.
 * A short timeout matters: a page that is merely busy (a long synchronous
 * script) must not be declared dead and torn down, but a page whose target is
 * gone rejects immediately rather than timing out — so the timeout only ever
 * fires on "slow", and "slow" is treated as alive.
 */
async function isPageAlive(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    await Promise.race([
      page.title(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('__slow')), 4000)),
    ]);
    return true;
  } catch (e) {
    // "__slow" means busy, not dead — keep it.
    return (e as Error)?.message === '__slow';
  }
}

/**
 * Has the whole context gone, rather than just one page?
 *
 * Playwright has no public `context.isClosed()`, but a closed context has no
 * browser and reports zero pages, and reading `.browser()` never throws. When
 * this is true a new page cannot be opened and the context has to be rebuilt
 * from the saved storageState.
 */
function isContextDead(context: BrowserContext): boolean {
  try {
    const browser = context.browser();
    if (browser && !browser.isConnected()) return true;
    // A live context always has at least the page we opened; an empty page list
    // together with a missing browser handle means it is gone.
    return !browser && context.pages().length === 0;
  } catch {
    return true;
  }
}

/**
 * Does this error mean "the thing you were talking to no longer exists", as
 * opposed to an ordinary failure like a 404 or a selector that matched nothing?
 *
 * Only the first kind is worth a recover-and-retry. Retrying the second kind
 * would tear down a perfectly good browser because a page happened to 500.
 */
function isDeadTargetError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e || '');
  return /Target (?:closed|crashed|page, context or browser has been closed)/i.test(msg)
    || /Target closed/i.test(msg)
    || /Session closed/i.test(msg)
    || /has been closed/i.test(msg)
    || /Protocol error/i.test(msg)
    || /Execution context was destroyed/i.test(msg)
    || /page has been closed/i.test(msg)
    || /browser has been closed/i.test(msg)
    || /Connection closed/i.test(msg)
    || /crashed/i.test(msg);
}

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

/**
 * One tab of a session.
 *
 * `page` is nullable on purpose. A tab RESTORED from the previous session is a
 * URL and a title with no page behind it yet — the same thing Chrome shows after
 * a restart, and for the same reason: reopening twelve pages at once would cost
 * twelve page loads nobody asked for. The page is created the moment the tab is
 * activated (`pending` → false).
 */
interface LiveTab {
  id: string;
  page: Page | null;
  url: string;
  title: string;
  pending: boolean;
  dead: boolean;
}

export class LiveBrowserSession {
  public readonly id: string;
  private context: BrowserContext | null = null;
  /**
   * The ACTIVE tab's page. Every input command already went through `this.page`,
   * so keeping this field as "whatever is in front" is what let tabs be added
   * without rewriting navigate/click/type/scroll/key.
   */
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  /** Which page `cdp` is attached to — a CDP session does not follow a rebind. */
  private cdpPage: Page | null = null;
  private frameSink: FrameSink | null = null;
  private eventSink: EventSink | null = null;
  private pickerOn = false;
  /** The tab strip, in display order. */
  private tabs: LiveTab[] = [];
  private activeId = '';
  private tabSeq = 0;
  /**
   * A file dialog the page opened and that is now waiting on us.
   *
   * Only one can be outstanding: Chrome will not open a second dialog while the
   * first is up, and holding a list would only create the question of which one
   * a user's file was meant for.
   */
  private pendingChooser: FileChooser | null = null;
  /** Uploads handed to a chooser in this session, deleted when it ends. */
  private consumedUploads: string[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  /** Liveness probe. See `startHealthWatch()` for why polling is the right tool. */
  private healthTimer: NodeJS.Timeout | null = null;
  private recovering: Promise<boolean> | null = null;
  private closed = false;
  public readonly userId: string;
  private vp = { ...DEFAULT_VIEWPORT };
  // Whether this user already had a saved browser session when we started;
  // the UI shows it so "why am I logged out" is never a mystery.
  private hadSavedSession = false;
  /** Pages we created or adopted, so an unrelated session's page is never stolen. */
  private owned = new Set<Page>();

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

  /** The tab strip as the client renders it. Exposed for tests and for `emitTabs`. */
  tabList(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.id === this.activeId,
      ...(t.pending ? { pending: true } : {}),
      ...(t.dead ? { dead: true } : {}),
    }));
  }

  activeTabId(): string { return this.activeId; }

  // ════════════════════════════════════════════════════════════════════════
  // Start-up
  // ════════════════════════════════════════════════════════════════════════

  // Bring up the context, restore the user's tabs and start the CDP screencast.
  async start(): Promise<void> {
    if (this.closed) throw new Error('session_closed');
    // A PERSISTENT context, not a throwaway one: this session has a human in
    // it. Cookies from last time come back, so a page the user logged into
    // stays logged in instead of greeting them with a login wall every open
    // (HANDOFF 15 AUTH-GAP). The fingerprint is stable for the same reason.
    this.hadSavedSession = await hasSavedSession(this.userId);
    this.context = await GlobalBrowser.getInteractiveContext(this.userId, this.vp);

    // Reading the page's clipboard needs permission, and the page's own
    // clipboard is the ONLY place some extensions put their output (a cookie
    // exporter's "Export" is a `navigator.clipboard.writeText` — on the server,
    // where the user cannot reach it). Best-effort: a context that refuses the
    // grant still supports selection-based copy.
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write'])
      .catch(() => { /* older Chromium, or an origin that cannot be granted */ });

    // ── Tabs the page opens for itself ──────────────────────────────────────
    // `target="_blank"`, `window.open`, an OAuth popup: Chrome puts these in a
    // NEW tab, and the old session simply never looked at them. The login the
    // user had just started was then invisible — the page existed, nothing was
    // streaming it, and the canvas kept showing the tab they had left.
    //
    // Only pages OPENED BY ONE OF OUR TABS are adopted. The real-Chrome context
    // is shared between sessions, so adopting every new page in the context
    // would show one user the tabs of another — and would explain "extra tabs
    // appeared out of nowhere".
    this.context.on('page', (p: Page) => {
      void (async () => {
        if (this.closed || this.owned.has(p)) return;
        let opener: Page | null = null;
        try { opener = await p.opener(); } catch { opener = null; }
        if (!opener || !this.owned.has(opener)) return;
        const tab = await this.adopt(p, { activate: true });
        if (tab) this.emit('tabOpened', { id: tab.id, url: tab.url });
      })();
    });

    // ── Session restore ─────────────────────────────────────────────────────
    // The tabs the user had last time come back: the active one loads now, the
    // rest are placeholders that load when clicked. Without this, "a browser"
    // meant one blank tab every single open.
    const saved = await loadTabs(this.userId).catch(() => [] as SavedTab[]);
    for (const s of saved) {
      this.tabSeq += 1;
      this.tabs.push({
        id: `t${this.tabSeq}`,
        page: null,
        url: s.url,
        title: s.title || s.url,
        pending: true,
        dead: false,
      });
    }
    const restoreTarget = this.tabs.find((t) => saved.some((s) => s.url === t.url && s.active))
      || this.tabs[0]
      || null;

    if (restoreTarget) {
      this.activeId = restoreTarget.id;
      // A restore must never be able to stop the window from opening: if the
      // saved page 404s, times out or has since started requiring a login, we
      // still owe the user a working browser.
      const ok = await this.materialize(restoreTarget).catch(() => false);
      if (!ok) {
        restoreTarget.dead = true;
        await this.openTab('about:blank', { activate: true });
      }
    } else {
      await this.openTab('about:blank', { activate: true });
    }

    this.startHealthWatch();
    this.touch();
    // `signedIn` tells the panel whether cookies were restored, so the UI can
    // stop claiming "fresh, signed-out browser" once that is no longer true.
    this.emit('ready', {
      url: this.page ? this.page.url() : 'about:blank',
      width: this.vp.width,
      height: this.vp.height,
      signedIn: this.hadSavedSession,
      restoredTabs: saved.length,
    });
    this.emitTabs();
  }

  private emit(type: string, data: Record<string, unknown>): void {
    if (this.eventSink) {
      try { this.eventSink(type, data); } catch { /* best-effort */ }
    }
  }

  /** Push the whole strip. One event, because the client redraws it wholesale. */
  private emitTabs(): void {
    this.emit('tabs', {
      tabs: this.tabList() as unknown as Record<string, unknown>[],
      activeId: this.activeId,
    });
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

  // ════════════════════════════════════════════════════════════════════════
  // Tab plumbing
  // ════════════════════════════════════════════════════════════════════════

  private findTab(id: string): LiveTab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  private tabOfPage(page: Page): LiveTab | undefined {
    return this.tabs.find((t) => t.page === page);
  }

  /** Wire the per-page listeners. Must run for EVERY page, restored or adopted. */
  private async attachPage(page: Page): Promise<void> {
    this.owned.add(page);
    await page.setViewportSize(this.vp).catch(() => {});

    // Consent walls cover the very elements the user is trying to pick, so they
    // are dismissed before the page's own scripts run. Named-CMP allowlist only
    // — see BrowserProfile.CONSENT_SCRIPT for why a text match would be unsafe.
    await installConsentAutoDismiss(page);

    // Expose the ONE binding the picker uses. `k` decides which channel event
    // the UI receives, so hover previews cannot be mistaken for a real pick.
    // Per PAGE, not per context: a binding is a page-level thing, and a picker
    // that only worked on the first tab would be a bug the user reads as "the
    // crosshair stopped working".
    await page.exposeBinding('__abReportPick', (_src, payload: PickResult) => {
      const kind = payload && payload.k === 'hover' ? 'hover'
        : payload && payload.k === 'verify' ? 'verified'
          : 'pick';
      this.emit(kind, payload as unknown as Record<string, unknown>);
    }).catch(() => { /* already exposed on a reused page */ });

    // ── The file dialog the canvas can never show ───────────────────────────
    // A native "choose a file" window is drawn by the OS, not by the page, so
    // no screencast at any resolution can contain it — and the file it browses
    // is on the SERVER's disk, which is not where the user's file is. Attaching
    // this listener makes Playwright intercept the dialog instead of opening
    // it, which turns "nothing happens when I click Import" into a question the
    // UI can ask: which of YOUR files?
    page.on('filechooser', (chooser) => {
      if (page !== this.page) return;   // a background tab's dialog is not ours to answer
      this.pendingChooser = chooser;
      void (async () => {
        // The accept filter belongs to the input, and repeating it in the UI is
        // what stops someone uploading a .png into a cookie importer.
        let accept = '';
        let name = '';
        try {
          const el = chooser.element();
          accept = (await el.getAttribute('accept')) || '';
          name = (await el.getAttribute('name')) || '';
        } catch { /* the element may already be gone; the prompt still stands */ }
        this.emit('filechooser', {
          multiple: chooser.isMultiple(),
          accept,
          name,
        });
      })();
    });

    // Re-inject picker after navigations if it was on, and tell the client
    // where we ended up.
    //
    // The `navigated` event used to be emitted ONLY by our own navigate/back/
    // forward/reload commands, so the moment the user followed a link or a
    // form redirected them, the address bar in the picker window kept showing
    // the page they had left. That is not a cosmetic detail: the URL bar is
    // how you know where you are before you start picking selectors.
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      const tab = this.tabOfPage(page);
      if (tab) {
        tab.url = frame.url();
        tab.title = (await page.title().catch(() => tab.title)) || tab.url;
      }
      if (page !== this.page) { this.emitTabs(); void this.persistTabs(); return; }
      this.emit('navigated', { url: frame.url() });
      this.emitTabs();
      void this.persistTabs();
      if (this.pickerOn) {
        await this.injectPicker().catch(() => {});
      }
    });

    // ── The two events that used to strand the whole window ─────────────────
    // A cookie-import extension reloads — sometimes REPLACES — the tab as soon
    // as it writes its cookies. When that killed the page the CDP screencast was
    // bound to, the old session had no listener for it: the socket stayed open,
    // the UI still said "connected", and every command silently went nowhere.
    // Restarting from inside the window did not help either, because the restart
    // ran against the same dead handle. Reopening the window was the only cure.
    //
    // Now the tab is either re-bound (crash: Chrome keeps the tab, we reload it)
    // or dropped and replaced (close), and the client is TOLD which happened.
    page.on('crash', () => {
      const tab = this.tabOfPage(page);
      this.emit('tabCrashed', { id: tab ? tab.id : '', url: tab ? tab.url : '' });
      void this.recover('crash');
    });
    page.on('close', () => {
      const tab = this.tabOfPage(page);
      this.owned.delete(page);
      if (page === this.cdpPage) { this.cdp = null; this.cdpPage = null; }
      if (!tab) return;
      tab.page = null;
      tab.dead = true;
      if (page === this.page) {
        this.page = null;
        void this.recover('closed');
      } else {
        // A background tab that closed itself is just gone.
        this.tabs = this.tabs.filter((t) => t !== tab);
        this.emitTabs();
        void this.persistTabs();
      }
    });
  }

  /** Take ownership of a page the context produced, and give it a tab. */
  private async adopt(page: Page, opts: { activate?: boolean } = {}): Promise<LiveTab | null> {
    if (this.closed) return null;
    if (this.tabs.length >= MAX_SAVED_TABS) {
      // Refuse rather than grow without bound: a page in a redirect loop can
      // call window.open() faster than a human can close tabs.
      this.emit('error', { message: 'too_many_tabs' });
      await page.close().catch(() => {});
      return null;
    }
    await this.attachPage(page);
    this.tabSeq += 1;
    const tab: LiveTab = {
      id: `t${this.tabSeq}`,
      page,
      url: page.url() || 'about:blank',
      title: (await page.title().catch(() => '')) || page.url() || 'about:blank',
      pending: false,
      dead: false,
    };
    this.tabs.push(tab);
    if (opts.activate) await this.focus(tab);
    else { this.emitTabs(); void this.persistTabs(); }
    return tab;
  }

  /** Create the real page behind a restored placeholder and load its URL. */
  private async materialize(tab: LiveTab): Promise<boolean> {
    if (!this.context) return false;
    if (tab.page && !tab.page.isClosed()) return true;
    const page = await this.context.newPage();
    await this.attachPage(page);
    tab.page = page;
    tab.pending = false;
    tab.dead = false;
    if (tab.id === this.activeId) {
      this.page = page;
      await this.bindCdp(page);
    }
    const target = tab.url && tab.url !== 'about:blank' ? tab.url : '';
    if (target) {
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        // The page exists and is usable; only the restore target failed. Say so
        // instead of throwing away a working tab.
        this.emit('error', { message: 'restore_failed: ' + target });
      }
    }
    tab.url = page.url();
    tab.title = (await page.title().catch(() => '')) || tab.url;
    return true;
  }

  /**
   * Make `tab` the streamed one: rebuild the CDP screencast on its page, bring
   * it to the front so the page's own visibility/focus logic behaves, and tell
   * the client both the new URL and the new strip.
   */
  private async focus(tab: LiveTab): Promise<void> {
    this.activeId = tab.id;
    if (!tab.page || tab.page.isClosed()) {
      const ok = await this.materialize(tab).catch(() => false);
      if (!ok) { this.emitTabs(); return; }
    }
    const page = tab.page!;
    this.page = page;
    // A background tab is throttled and reports itself hidden; a screencast of
    // one is a still image of whatever it last painted.
    await page.bringToFront().catch(() => {});
    await this.bindCdp(page);
    // The picker script lives in the page, so switching tabs has to re-arm it —
    // otherwise select mode is silently off on the tab you just opened.
    if (this.pickerOn) await this.injectPicker().catch(() => {});
    tab.url = page.url();
    tab.title = (await page.title().catch(() => '')) || tab.url;
    this.emit('navigated', { url: tab.url });
    this.emitTabs();
    void this.persistTabs();
  }

  /**
   * (Re)attach the screencast.
   *
   * Always a FRESH CDPSession. Reusing the old one across a page swap was the
   * quiet half of the "browser is dead" bug: the transport still existed, so
   * nothing threw, and every `Input.dispatchMouseEvent` went to a target that no
   * longer had a renderer.
   */
  private async bindCdp(page: Page): Promise<void> {
    if (!this.context) return;
    if (this.cdp && this.cdpPage === page) {
      // Same page, but the screencast may have been stopped by a navigation into
      // a new renderer process; restarting it is idempotent and cheap.
      await this.startScreencast().catch(() => {});
      return;
    }
    const old = this.cdp;
    const oldPage = this.cdpPage;
    this.cdp = null;
    this.cdpPage = null;
    if (old) {
      if (oldPage && !oldPage.isClosed()) {
        try { await old.send('Page.stopScreencast'); } catch { /* target already gone */ }
      }
      try { await old.detach(); } catch { /* already detached */ }
    }
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;
    this.cdpPage = page;
    cdp.on('Page.screencastFrame', async (params: {
      data: string;
      sessionId: number;
      metadata: { deviceWidth?: number; deviceHeight?: number };
    }) => {
      // Acknowledge so Chromium keeps sending frames.
      try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); }
      catch { /* ignore */ }
      // A frame from the tab that is no longer in front would paint the wrong
      // page over the one the user is looking at.
      if (cdp !== this.cdp) return;
      if (this.frameSink) {
        this.frameSink({
          data: params.data,
          sessionId: params.sessionId,
          width: params.metadata.deviceWidth || this.vp.width,
          height: params.metadata.deviceHeight || this.vp.height,
        });
      }
    });
    await this.startScreencast();
  }

  private async startScreencast(): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.vp.width,
      maxHeight: this.vp.height,
      everyNthFrame: 1,
    });
  }

  /** Open a new tab. This is what "open in a new tab" means for every caller. */
  private async openTab(url: string, opts: { activate?: boolean } = {}): Promise<LiveTab | null> {
    if (!this.context) return null;
    if (this.tabs.length >= MAX_SAVED_TABS) {
      this.emit('error', { message: 'too_many_tabs' });
      return null;
    }
    const page = await this.context.newPage();
    await this.attachPage(page);
    this.tabSeq += 1;
    const tab: LiveTab = {
      id: `t${this.tabSeq}`,
      page,
      url: 'about:blank',
      title: 'about:blank',
      pending: false,
      dead: false,
    };
    this.tabs.push(tab);
    if (opts.activate !== false) {
      this.activeId = tab.id;
      this.page = page;
      await page.bringToFront().catch(() => {});
      await this.bindCdp(page);
    }
    const target = normalizeTarget(url);
    if (target && target !== 'about:blank') {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch (e) { this.emit('error', { message: (e as Error).message }); }
      tab.url = page.url();
      tab.title = (await page.title().catch(() => '')) || tab.url;
    }
    if (opts.activate !== false && this.pickerOn) await this.injectPicker().catch(() => {});
    this.emitTabs();
    void this.persistTabs();
    return tab;
  }

  /** Persist the strip so the next open of this window is not a blank slate. */
  private async persistTabs(): Promise<void> {
    if (this.closed) return;
    const list: SavedTab[] = this.tabs
      .filter((t) => !t.dead)
      .map((t) => ({
        url: t.url,
        title: t.title,
        ...(t.id === this.activeId ? { active: true } : {}),
      }));
    await saveTabs(this.userId, list).catch(() => {});
  }

  // ════════════════════════════════════════════════════════════════════════
  // Public tab commands (driven from BrowserStreamServer)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Open a URL in a NEW tab instead of over the top of the current one.
   *
   * This is what the Real Chrome panel's "Open here" now calls for an extension
   * popup. Reusing the active tab meant that opening your cookie extension threw
   * away the page you wanted the cookies for — you imported the cookies and then
   * had to navigate back by hand, having lost whatever state that page held.
   */
  async newTab(url = ''): Promise<void> {
    this.touch();
    await this.openTab(url, { activate: true });
  }

  async selectTab(id: string): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab || tab.id === this.activeId) return;
    await this.focus(tab);
  }

  async closeTab(id: string): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab) return;
    const wasActive = tab.id === this.activeId;
    const idx = this.tabs.indexOf(tab);
    this.tabs = this.tabs.filter((t) => t !== tab);
    if (tab.page) {
      const page = tab.page;
      tab.page = null;
      this.owned.delete(page);
      if (page === this.cdpPage) { this.cdp = null; this.cdpPage = null; }
      if (page === this.page) this.page = null;
      await page.close().catch(() => {});
    }
    if (!this.tabs.length) {
      // Never leave a window with no tabs: Chrome would have closed, and this
      // window cannot. A blank tab is the honest equivalent.
      await this.openTab('about:blank', { activate: true });
      return;
    }
    if (wasActive) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      await this.focus(next);
      return;
    }
    this.emitTabs();
    void this.persistTabs();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Recovery
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Put the session back on a live page, whatever happened to the old one.
   *
   * Called from `crash`/`close`, from the liveness probe, and from the client's
   * Reconnect button (`resync`). Serialised through `this.recovering` because
   * three of those can fire within the same tick — an extension that reloads the
   * tab produces a close AND a failing probe — and two concurrent recoveries
   * would race two CDP sessions onto two different pages.
   */
  private async recover(reason: string): Promise<boolean> {
    if (this.closed) return false;
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      try {
        this.emit('recovering', { reason });
        if (!this.context || isContextDead(this.context)) {
          // The whole context went with it (a Chrome restart, or the shared
          // real-Chrome profile being restarted from the panel). Rebuild.
          this.context = await GlobalBrowser.getInteractiveContext(this.userId, this.vp);
          await this.context.grantPermissions(['clipboard-read', 'clipboard-write'])
            .catch(() => {});
          for (const t of this.tabs) { t.page = null; t.pending = true; t.dead = false; }
          this.owned.clear();
          this.cdp = null;
          this.cdpPage = null;
          this.page = null;
        }
        // Prefer the tab that was in front; it is the page the user was using.
        let target: LiveTab | null = this.findTab(this.activeId) || null;
        if (target && target.page && target.page.isClosed()) {
          target.page = null;
          target.pending = true;
        }
        if (!target) {
          target = this.tabs.find((t) => t.page && !t.page.isClosed()) || this.tabs[0] || null;
        }
        if (!target) {
          const fresh = await this.openTab('about:blank', { activate: true });
          this.emit('recovered', { reason, url: 'about:blank', tabId: fresh ? fresh.id : '' });
          return true;
        }
        this.activeId = target.id;
        const ok = await this.materialize(target).catch(() => false);
        if (!ok) {
          const dead = target;
          this.tabs = this.tabs.filter((t) => t !== dead);
          const fresh = await this.openTab('about:blank', { activate: true });
          this.emit('recovered', { reason, url: 'about:blank', tabId: fresh ? fresh.id : '' });
          return true;
        }
        await this.focus(target);
        this.emit('recovered', { reason, url: target.url, tabId: target.id });
        return true;
      } catch (e) {
        this.emit('error', { message: 'recover_failed: ' + (e as Error).message });
        return false;
      } finally {
        this.recovering = null;
      }
    })();
    return this.recovering;
  }

  /**
   * Rebuild the stream on demand — the server half of the client's Reconnect.
   *
   * Deliberately NOT "close the socket and open a new one": that threw away the
   * tab list and the picker state, which is why the old advice ("close the
   * window and reopen it") cost the user their tabs every time an extension
   * refreshed the page.
   */
  async resync(): Promise<void> {
    this.touch();
    const page = this.page;
    if (page && !page.isClosed() && await isPageAlive(page)) {
      // The page is fine; it is the STREAM that stopped. Rebuild only that.
      try {
        this.cdp = null; this.cdpPage = null;
        await this.bindCdp(page);
        this.emit('recovered', { reason: 'resync', url: page.url(), tabId: this.activeId });
        this.emitTabs();
        return;
      } catch { /* fall through to a full recovery */ }
    }
    await this.recover('resync');
  }

  /**
   * Answer "is the stream actually broken, or is the page just not repainting?"
   *
   * Page.startScreencast is DELTA based: it emits a frame when the compositor
   * repaints. A static page (the overwhelming majority of pages a selector is
   * picked on) therefore paints once on load and then sends nothing at all —
   * measured, not assumed: a reload of such a page yields exactly one frame, and
   * a click that changes no pixels yields zero.
   *
   * So "no frames for a while" is NOT evidence of the reported bug. The client
   * needs a cheap way to disambiguate before it announces a recovery, otherwise
   * every quiet page gets a "reconnecting" banner and a pointless resync on a
   * timer. This asks the page itself, and only escalates to a real recovery when
   * the page cannot answer.
   */
  async ping(): Promise<void> {
    this.touch();
    const page = this.page;
    const alive = !!page && !page.isClosed() && await isPageAlive(page);
    if (!alive) {
      // This is the genuine failure the user reported: a page that is gone while
      // the socket is still happily open.
      await this.recover('ping');
      return;
    }
    // The page answers, so the only thing that can still be wrong is the
    // screencast having been detached by a renderer swap. Restarting it is
    // idempotent, and forcing one frame proves the pipe end to end.
    try {
      await this.startScreencast();
      const shot = await page!.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
      if (shot && this.frameSink) {
        this.frameSink({
          data: shot.toString('base64'),
          sessionId: 0,   // not a screencast frame: nothing to acknowledge
          width: this.vp.width,
          height: this.vp.height,
        });
      }
      this.emit('alive', { url: page!.url(), tabId: this.activeId });
    } catch (e) {
      if (isDeadTargetError(e)) await this.recover('ping');
      else this.emit('alive', { url: page!.url(), tabId: this.activeId });
    }
  }

  /**
   * Poll the active page for liveness.
   *
   * Why a poll and not only the events: `crash` fires for a renderer crash and
   * `close` for a closed target, but a tab that is REPLACED (an extension
   * calling `chrome.tabs.update`, a `window.location` swap into a new renderer,
   * or a debugger detaching) can leave a Page object whose CDP transport is dead
   * while Playwright still believes it is open. That state produced exactly the
   * reported symptom: no error anywhere, and nothing works. A one-expression
   * evaluate every 10s is the cheapest way to notice.
   */
  private startHealthWatch(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      if (this.closed || this.recovering) return;
      const page = this.page;
      if (!page) { void this.recover('no_page'); return; }
      if (page.isClosed()) { void this.recover('page_closed'); return; }
      void isPageAlive(page).then((alive) => {
        if (!alive && !this.closed && !this.recovering) void this.recover('page_unreachable');
      });
    }, HEALTH_POLL_MS);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  /**
   * Run a page action, and recover once if the page turns out to be gone.
   *
   * Every input command goes through this. Without it, the first click after an
   * extension refreshed the tab threw "Target closed", was swallowed by the
   * command's own catch, and the window stayed broken until it was reopened.
   */
  private async withPage(fn: (page: Page) => Promise<void>): Promise<void> {
    const page = this.page;
    if (page && !page.isClosed()) {
      try { await fn(page); return; }
      catch (e) {
        if (!isDeadTargetError(e)) return;    // a normal failure: the caller logs it
      }
    }
    const ok = await this.recover('command');
    if (!ok || !this.page) return;
    try { await fn(this.page); } catch { /* one retry is enough */ }
  }

  /** Same contract as `withPage`, for the CDP-driven input commands. */
  private async withCdp(fn: (cdp: CDPSession) => Promise<void>): Promise<void> {
    if (this.cdp) {
      try { await fn(this.cdp); return; }
      catch (e) {
        if (!isDeadTargetError(e)) return;
      }
    }
    const ok = await this.recover('command');
    if (!ok || !this.cdp) return;
    try { await fn(this.cdp); } catch { /* one retry is enough */ }
  }

  /**
   * Navigate the ACTIVE tab. Scheme handling lives in `normalizeTarget`, which
   * is also what `openTab` uses — one allowlist, so a new tab and an address-bar
   * entry can never disagree about what is loadable.
   */
  async navigate(url: string): Promise<void> {
    this.touch();
    const target = normalizeTarget(url);
    if (!target) return;
    await this.withPage(async (page) => {
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
        this.emit('navigated', { url: page.url() });
        await this.syncActiveTab();
      } catch (e) {
        if (isDeadTargetError(e)) throw e;   // let withPage recover and retry
        this.emit('error', { message: (e as Error).message });
      }
    });
  }

  /** Refresh the active tab's cached url/title and push the strip. */
  private async syncActiveTab(): Promise<void> {
    const tab = this.findTab(this.activeId);
    if (!tab || !tab.page) return;
    tab.url = tab.page.url();
    tab.title = (await tab.page.title().catch(() => '')) || tab.url;
    this.emitTabs();
    void this.persistTabs();
  }

  /**
   * Browser history. The picker window is a real browser now (element selection
   * is a MODE, not the permanent state it used to be), and a browser without
   * Back is a dead end: following a link into the wrong page used to leave
   * retyping the URL as the only way out.
   *
   * `goBack`/`goForward` resolve to `null` when there is nothing in that
   * direction, which is not an error — it is the button being a no-op, exactly
   * as a greyed-out Back is.
   */
  async back(): Promise<void> {
    this.touch();
    await this.withPage(async (page) => {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      this.emit('navigated', { url: page.url() });
      await this.syncActiveTab();
    });
  }

  async forward(): Promise<void> {
    this.touch();
    await this.withPage(async (page) => {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      this.emit('navigated', { url: page.url() });
      await this.syncActiveTab();
    });
  }

  async reload(): Promise<void> {
    this.touch();
    await this.withPage(async (page) => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      this.emit('navigated', { url: page.url() });
      await this.syncActiveTab();
    });
  }

  async click(x: number, y: number): Promise<void> {
    this.touch();
    const px = Math.round(x);
    const py = Math.round(y);
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
    });
  }

  // Pointer movement without a click. The Element Picker needs this: its
  // page-side highlight + hover preview are driven by mousemove, and the
  // client streams a canvas image, not the real cursor.
  //
  // NOT routed through `withCdp`: a hover fires ~14 times a second, and letting
  // each one trigger a recovery would turn a single dead page into a storm of
  // context rebuilds. The health poll and the next real click both notice.
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
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(dy),
      });
    });
  }

  // Type a string by inserting text (works for most inputs/contenteditable).
  async type(text: string): Promise<void> {
    this.touch();
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.insertText', { text: String(text) });
    });
  }

  // Send a single special key (Enter, Backspace, Tab, etc.).
  async key(name: string): Promise<void> {
    this.touch();
    await this.withPage(async (page) => {
      await page.keyboard.press(name);
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Clipboard bridge
  //
  // Two machines, two clipboards. Ctrl+C in the canvas copies from the LOCAL
  // browser (which holds a JPEG of a page, i.e. nothing), and the remote page's
  // own clipboard lives on the server where nobody can paste from it. Both
  // directions therefore have to be carried explicitly over the socket.
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Paste the user's local clipboard text into the remote page.
   *
   * Both halves matter. `Input.insertText` puts the text where the cursor is —
   * that is a paste as far as any input, textarea or contenteditable is
   * concerned. Writing the remote clipboard as well serves the OTHER kind of
   * paste: an extension with a "Load from clipboard" button reads
   * `navigator.clipboard.readText()`, and would otherwise read whatever the
   * server last copied.
   */
  async paste(text: string): Promise<void> {
    this.touch();
    const value = String(text || '');
    if (!value) return;
    await this.withPage(async (page) => {
      await page.evaluate(
        (v: string) => navigator.clipboard.writeText(v).catch(() => {}),
        value,
      ).catch(() => { /* no permission: the insert below is still a paste */ });
    });
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.insertText', { text: value });
    });
  }

  /**
   * Read text out of the remote page and answer on the `clipboard` channel.
   *
   * Order matters: the SELECTION comes first because it is what a user means by
   * Ctrl+C, and the page clipboard is the fallback because that is where a
   * "copy to clipboard" button in the page has just put its output. An empty
   * answer is still sent — the UI has to be able to say "there was nothing to
   * copy" instead of silently doing nothing.
   */
  async readClipboard(): Promise<void> {
    this.touch();
    // A dead page here is worth recovering from before reading: the answer is
    // sent unconditionally, and "" would be indistinguishable from "you had
    // nothing selected" — the user would blame their selection, not the browser.
    if (!this.page || this.page.isClosed()) await this.recover('clipboard');
    if (!this.page) { this.emit('clipboard', { text: '', source: 'selection' }); return; }
    let text = '';
    let source = 'selection';
    try {
      text = await this.page.evaluate(() => {
        const a = document.activeElement as HTMLInputElement | null;
        // An input's selection is NOT part of window.getSelection().
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
          && typeof a.selectionStart === 'number' && a.selectionStart !== a.selectionEnd) {
          return String(a.value).slice(a.selectionStart, a.selectionEnd ?? undefined);
        }
        return String(window.getSelection() || '');
      });
    } catch { /* page navigated mid-read */ }

    if (!text) {
      source = 'clipboard';
      try {
        text = await this.page.evaluate(
          () => navigator.clipboard.readText().catch(() => ''),
        );
      } catch { /* permission denied; answer with the empty string */ }
    }
    this.emit('clipboard', { text: String(text || ''), source });
  }

  /** Select everything in the focused field/page — the other half of Ctrl+A. */
  async selectAll(): Promise<void> {
    this.touch();
    await this.withPage(async (page) => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // File chooser
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Hand uploaded files to the dialog the page is waiting on.
   *
   * Tokens, never paths: see RemoteUploads. Anything that fails to resolve is
   * dropped rather than passed through, so a crafted token cannot make Chrome
   * read a file the uploader never uploaded.
   */
  async acceptFiles(tokens: string[]): Promise<void> {
    this.touch();
    const chooser = this.pendingChooser;
    if (!chooser) {
      this.emit('fileChooserDone', { ok: false, reason: 'no_pending_chooser' });
      return;
    }
    this.pendingChooser = null;

    const paths: string[] = [];
    for (const token of Array.isArray(tokens) ? tokens.slice(0, 10) : []) {
      // Async: the token names a directory and the file inside it keeps the
      // user's own name, so the real path has to be read off the disk.
      try { paths.push(await resolveUpload(this.userId, String(token))); }
      catch { /* not a token we minted, or already swept */ }
    }
    if (!paths.length) {
      await chooser.setFiles([]).catch(() => {});
      this.emit('fileChooserDone', { ok: false, reason: 'no_valid_files' });
      return;
    }

    try {
      await chooser.setFiles(chooser.isMultiple() ? paths : [paths[0]]);
      // Remember, do not delete yet: Chrome reads the file when the page asks,
      // which can be long after setFiles resolves.
      this.consumedUploads.push(...(tokens || []).map(String));
      this.emit('fileChooserDone', { ok: true, count: paths.length });
    } catch (e) {
      this.emit('fileChooserDone', { ok: false, reason: (e as Error).message });
    }
  }

  /** Dismiss the dialog. `setFiles([])` is what "Cancel" means to the page. */
  async cancelFileChooser(): Promise<void> {
    this.touch();
    const chooser = this.pendingChooser;
    this.pendingChooser = null;
    if (!chooser) return;
    await chooser.setFiles([]).catch(() => {});
    this.emit('fileChooserDone', { ok: false, reason: 'cancelled' });
  }

  private async injectPicker(): Promise<void> {
    if (!this.page) return;
    try { await this.page.evaluate(PICKER_SCRIPT); } catch { /* ignore */ }
  }

  async setPicker(on: boolean): Promise<void> {
    this.touch();
    this.pickerOn = !!on;
    if (on) {
      // Through `withPage`, because turning select mode ON is usually the FIRST
      // thing a user does after an extension has quietly killed the tab. Failing
      // silently here is what made the whole window look bricked.
      await this.withPage(async () => { await this.injectPicker(); });
    } else if (this.page && !this.page.isClosed()) {
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
    const sel = String(selector || '');
    if (!sel) return;
    await this.withPage(async (page) => {
      if (!this.pickerOn) await this.injectPicker();
      await page.evaluate(`window.__abVerify && window.__abVerify(${JSON.stringify(sel)})`);
    });
  }

  /**
   * Drop this user's saved cookies/localStorage and clear the live context,
   * i.e. "sign out of everything" for the picker browser. Needed because a
   * persistent session that cannot be reset is a trap: a half-broken login
   * would follow the user around with no way to start clean.
   */
  async forgetSession(): Promise<void> {
    await clearStorageState(this.userId);
    // The tab list goes too. "Sign out of everything" that leaves a strip of
    // logged-in-looking tabs behind is a lie, and restoring those URLs on the
    // next open would be a second surprise on top of it.
    await clearTabs(this.userId).catch(() => {});
    this.hadSavedSession = false;
    try { if (this.context) await this.context.clearCookies(); } catch { /* ignore */ }
    this.emit('session', { signedIn: false, cleared: true });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    // Save the strip BEFORE anything is torn down. This is the whole point of
    // "show me my tabs when the browser comes up": the list has to be written on
    // the way out, including when the way out is an idle timeout rather than the
    // user clicking Close.
    //
    // `this.closed` is already true, so `persistTabs()` would refuse — the write
    // is done inline for that reason.
    try {
      const list: SavedTab[] = this.tabs
        .filter((t) => !t.dead)
        .map((t) => ({
          url: t.url,
          title: t.title,
          ...(t.id === this.activeId ? { active: true } : {}),
        }));
      await saveTabs(this.userId, list);
    } catch { /* a lost tab list must never block the teardown below */ }
    // A file the user uploaded for one dialog must not outlive the window they
    // uploaded it in: cookie exports are credentials.
    if (this.consumedUploads.length) {
      const tokens = this.consumedUploads.splice(0);
      await discardUploads(this.userId, tokens).catch(() => {});
    }
    this.pendingChooser = null;
    try { if (this.cdp) await this.cdp.send('Page.stopScreencast').catch(() => {}); } catch { /* ignore */ }
    try { if (this.cdp) await this.cdp.detach().catch(() => {}); } catch { /* ignore */ }
    // EVERY tab, not just the active one. The old code closed `this.page` only,
    // which with a tab list would leak a page per background tab into the shared
    // Chromium on every window close — and in real-Chrome mode the context is
    // never closed, so nothing else would ever collect them.
    for (const tab of this.tabs) {
      const page = tab.page;
      tab.page = null;
      if (!page) continue;
      this.owned.delete(page);
      try { await page.close(); } catch { /* already gone */ }
    }
    this.tabs = [];
    // Save BEFORE closing, or the login the user just performed inside the
    // picker dies with the context — which was exactly the old behaviour.
    try {
      if (this.context) await GlobalBrowser.saveAndCloseContext(this.context, this.userId);
    } catch { /* ignore */ }
    this.cdp = null; this.cdpPage = null; this.page = null; this.context = null;
    this.owned.clear();
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
