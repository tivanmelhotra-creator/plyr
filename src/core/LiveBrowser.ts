'use strict';

import { promises as fsp } from 'fs';
import type { BrowserContext, Page, CDPSession, FileChooser } from 'playwright';
import { GlobalBrowser } from './GlobalBrowser';
import {
  installConsentAutoDismiss,
  hasSavedSession,
  clearStorageState,
} from './BrowserProfile';
import { resolveUpload, discardUploads, safeFileName } from './RemoteUploads';
import {
  downloadPathFor,
  discardDownload,
  sweepDownloads,
  mintDownloadToken,
  MAX_DOWNLOAD_BYTES,
} from './RemoteDownloads';
import {
  loadTabs,
  saveTabs,
  clearTabs,
  MAX_SAVED_TABS,
  type SavedTab,
} from './BrowserTabs';
import {
  buildKeyEvents,
  modifierMask,
  buttonsMask,
  normalizeButton,
  normalizeClickCount,
  nextZoom,
  type Mods,
  type MouseButton,
} from './BrowserInput';

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
  /**
   * True while the tab is loading — drives the spinner Chrome shows in place of
   * the favicon. Without it a slow page is a tab that just sits there, and the
   * user cannot tell "loading" from "stuck".
   */
  loading?: boolean;
  /**
   * The tab's favicon URL, or '' when it has none.
   *
   * Chrome shows this, and it is how you find a tab among twelve. Resolved from
   * `link[rel~=icon]` with a fallback to the origin's /favicon.ico.
   */
  favicon?: string;
  /** True when the tab is playing audio — Chrome's speaker badge. */
  audible?: boolean;
  /** True when the tab is muted. */
  muted?: boolean;
  /** True when the tab is pinned (narrow, icon-only, cannot be dragged past). */
  pinned?: boolean;
}

/** One row of the download shelf, as the client renders it. */
export interface DownloadInfo {
  id: string;
  name: string;
  url: string;
  tabId: string;
  state: 'inProgress' | 'completed' | 'failed' | 'cancelled';
  /** Bytes so far, and the total when the server told us one (0 = unknown). */
  received: number;
  total: number;
  error?: string;
  /** Present once the file is on disk: hand this to the fetch route. */
  token?: string;
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

/**
 * How long a restored tab may take before start() gives up waiting on it.
 *
 * `materialize` already gives its own `goto` 30s. This budget is deliberately
 * SHORTER, because it is protecting a different thing: not the page load, but
 * the user's window opening at all. A restore that is merely slow must not turn
 * into a browser that never appears, so this is the point at which the strip
 * shows the tab as still coming up and hands control back to the user.
 */
const RESTORE_BUDGET_MS = 12_000;

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
 * How often to sample "is this tab making noise".
 *
 * Slower than the liveness poll on purpose: it runs an evaluate per tab, and a
 * speaker badge appearing 3s late costs nothing, whereas a per-tab evaluate
 * every 10s across fifteen tabs is real work for a cosmetic result.
 */
const AUDIO_POLL_MS = 3_000;

/**
 * How long to wait before believing that a background tab closed ITSELF.
 *
 * MEASURED 2026-08-03 (tools/probe-restart-tabs.js), and this is the constant
 * behind the user's «مشکل بزرگیه»: relaunching Chrome for an extension install
 * closes every page in it, one after another. A `close` handler that decides
 * "the browser is still alive, so this tab is gone" is asking a question that
 * cannot be answered yet — the sibling pages have not finished dying, so the
 * context still reports itself healthy, and the tabs were deleted (and then
 * PERSISTED) one by one until nothing was left.
 *
 * Waiting a moment makes the same question answerable, because by then the
 * context either is or is not gone. 400ms is chosen to be longer than a
 * multi-page teardown and far shorter than a human notices a chip lingering; and
 * the cost of it being too short is only a tab kept as `pending`, never a tab
 * lost, because the freeze means nothing has been written to disk either way.
 */
const SELF_CLOSE_GRACE_MS = 400;

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
 * `https://example.com:8443/a/b?c` → `https://example.com:8443`.
 *
 * Used to tell the user WHICH site is asking for their password. A credentials
 * prompt without an origin is a prompt nobody should type into, so this must
 * always produce something: on an unparseable URL it returns the raw string
 * rather than an empty label.
 */
function originOf(url: string): string {
  try { return new URL(String(url || '')).origin; } catch { return String(url || ''); }
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
/** Server-side download record. `path` never leaves the server. */
interface LiveDownload {
  id: string;
  /** Opaque handle the client uses to fetch the bytes. Never a path. */
  token: string;
  name: string;
  url: string;
  tabId: string;
  state: 'inProgress' | 'completed' | 'failed' | 'cancelled';
  received: number;
  total: number;
  path: string;
  error: string;
}

interface LiveTab {
  id: string;
  page: Page | null;
  url: string;
  title: string;
  pending: boolean;
  dead: boolean;
  /** Loading right now — the spinner Chrome puts where the favicon goes. */
  loading?: boolean;
  favicon?: string;
  audible?: boolean;
  muted?: boolean;
  pinned?: boolean;
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
  /**
   * A page dialog waiting on the user.
   *
   * Exactly one, for the same reason as the file chooser: Chrome will not open
   * a second dialog while the first is up. MEASURED: while this is unanswered
   * the page blocks completely — even `page.title()` times out — so this field
   * being non-null is the single most dangerous state in the session, and every
   * exit path has to clear it.
   */
  private pendingDialog: import('playwright').Dialog | null = null;
  /**
   * Set while we are closing a tab and want the page's `beforeunload` to be
   * ASKED rather than steamrolled. MEASURED: dismissing a beforeunload dialog
   * really does keep the tab open, so "Leave / Stay" can be honest.
   */
  private closingTabId = '';
  /**
   * The 401 currently waiting on credentials, with the CDP session that owns it.
   *
   * One at a time, like dialogs: Chrome does not stack credential prompts, and a
   * list would only raise the unanswerable question of which site the password
   * the user typed was meant for.
   */
  private pendingAuth: { cdp: CDPSession; requestId: string; page: Page } | null = null;
  /** Per-page auth CDP sessions, kept separate from the screencast session. */
  private authCdp = new Map<Page, CDPSession>();
  /**
   * The closed-tab stack behind Ctrl+Shift+T, newest last.
   *
   * `index` is where the tab was in the strip, because putting a mistakenly
   * closed tab back at the far right is only half a restoration.
   */
  private closedTabs: Array<{ url: string; title: string; index: number; pinned: boolean }> = [];
  /** The download shelf for this session. */
  private downloads: LiveDownload[] = [];
  private downloadSeq = 0;
  /** Uploads handed to a chooser in this session, deleted when it ends. */
  private consumedUploads: string[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  /** Liveness probe. See `startHealthWatch()` for why polling is the right tool. */
  private healthTimer: NodeJS.Timeout | null = null;
  private audioTimer: NodeJS.Timeout | null = null;
  private recovering: Promise<boolean> | null = null;
  /**
   * "Do not write the tab list to disk right now."
   *
   * MEASURED 2026-08-03 (tools/probe-restart-tabs.js): a Chrome relaunch closes
   * every page at once, and the old code let each of those closures shrink
   * `this.tabs` and then persist the result — so the on-disk backup was
   * destroyed by the exact failure it existed to survive, and three tabs came
   * back as one `about:blank`.
   *
   * A recovery is precisely the window in which the in-memory list is least
   * trustworthy: pages are dying, records are being re-marked `pending`, and
   * nothing is settled until the rebuild finishes. So the saved list is FROZEN
   * for the duration and unfrozen deliberately, once, by whoever finishes the
   * recovery — never by a `finally`, because a `finally` would also unfreeze on
   * the failure paths this is protecting against.
   *
   * A separate flag from `this.recovering` on purpose: that one is a promise
   * used to serialise concurrent recoveries, and overloading it as a data guard
   * would mean a caller awaiting it could clear the guard as a side effect.
   */
  private tabsFrozen = false;
  private closed = false;
  public readonly userId: string;
  private vp = { ...DEFAULT_VIEWPORT };
  /**
   * Current browser zoom (1 = 100%).
   *
   * Kept on the session, not only in the client, because the SERVER has to
   * divide incoming pointer coordinates by it (see `toPagePoint`). A zoom level
   * the two ends disagree about means every click lands somewhere else.
   */
  private zoom = 1;
  // Whether this user already had a saved browser session when we started;
  // the UI shows it so "why am I logged out" is never a mystery.
  private hadSavedSession = false;
  /** Pages we created or adopted, so an unrelated session's page is never stolen. */
  private owned = new Set<Page>();
  /**
   * Until when an ownerless new page should be treated as ours.
   *
   * Set for a short window whenever this session does something that is
   * EXPECTED to produce a tab it does not open itself — clicking an extension's
   * icon, importing cookies, a page calling `chrome.tabs.create`. Measured:
   * those pages arrive with `opener() === null`, indistinguishable from another
   * session's tab, so a time-boxed claim is what separates "the tab I just
   * asked for" from "somebody else's browsing".
   */
  private expectOrphanUntil = 0;

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
      ...(t.loading ? { loading: true } : {}),
      ...(t.favicon ? { favicon: t.favicon } : {}),
      ...(t.audible ? { audible: true } : {}),
      ...(t.muted ? { muted: true } : {}),
      ...(t.pinned ? { pinned: true } : {}),
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

        // ── Why an orphan page is adopted too ────────────────────────────────
        // MEASURED (tools/probe-cdp2.js): a page created by an EXTENSION —
        // `chrome.tabs.create`, which is how a cookie extension opens its popup
        // — has `opener() === null`. The old rule was "adopt only if the opener
        // is one of our pages", so every extension tab was silently dropped:
        // the tab existed in Chrome, nothing streamed it, and the user saw
        // nothing happen when they clicked their extension. That is the exact
        // reported bug, and this is its root cause.
        //
        // The rule the old code was protecting is still real: the real-Chrome
        // context is SHARED between sessions, so blindly adopting every page
        // would show one user another user's tabs. So an orphan is adopted only
        // when this session is the one that can legitimately claim it:
        //   - a single-session server (nothing to leak to), or
        //   - an extension page (chrome-extension://), which is the case that
        //     was broken and is never another user's browsing, or
        //   - a page opened while WE were the session that asked for one.
        if (!opener || !this.owned.has(opener)) {
          const url = (() => { try { return p.url(); } catch { return ''; } })();
          const isExtensionPage = /^chrome-extension:\/\//i.test(url);
          const claimable = isExtensionPage || this.expectOrphanUntil > Date.now();
          if (!claimable) return;
        }

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
      //
      // The timeout is the load-bearing part. `materialize` already survives a
      // failed `goto`, but "failed" is not the dangerous case — HUNG is. A saved
      // page that blocks (a dialog, a never-settling load, a renderer that stops
      // answering) would otherwise hold start() open forever, and a client that
      // never receives `ready` shows a connected socket and a dead window with no
      // way out. So restore gets a deadline, and missing it costs the restored
      // page, never the browser.
      const ok = await Promise.race([
        this.materialize(restoreTarget).catch(() => false),
        new Promise<boolean>((r) => { setTimeout(() => r(false), RESTORE_BUDGET_MS); }),
      ]);
      if (!ok) {
        // Keep the tab in the strip as `pending`, NOT dead: the user asked for
        // this page, and clicking it retries. "We never lose a tab."
        restoreTarget.pending = true;
        this.emit('error', { message: 'restore_slow', detail: restoreTarget.url });
        // Only open a blank tab if the slow restore left us with no live page at
        // all; otherwise we would add an unwanted tab on every slow open.
        if (!this.page || this.page.isClosed()) {
          await this.openTab('about:blank', { activate: true }).catch(() => null);
        }
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
      // A reconnecting client knows NOTHING about these two, and both are server
      // state that outlived its socket:
      //
      //   zoom      — every canvas coordinate is divided by it on the client, so
      //               a client that assumes 1 after resyncing into a page the
      //               user had zoomed to 150% silently sends every click to the
      //               wrong place. Worse than a visual glitch: a pointer that
      //               lies.
      //   downloads — the shelf. The files are on OUR disk; if the reconnected
      //               client is not told they exist, they are unreachable
      //               forever and the user is never even told they were saved.
      zoom: this.zoom,
      downloads: this.downloadList() as unknown as Record<string, unknown>[],
    });
    this.emitTabs();
    // And the history state, so Back/Forward are correctly greyed from the very
    // first frame rather than after the first navigation.
    void this.emitNavState().catch(() => {});
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

    // ── Page dialogs: alert / confirm / prompt / beforeunload ───────────────
    // MEASURED (tools/probe-cdp3.js), and it corrected my understanding of the
    // reported bug:
    //   * With NO 'dialog' listener, Playwright AUTO-DISMISSES — `evaluate`
    //     returned in 15ms. So the tab was never locked by Playwright.
    //   * With a listener that does not ANSWER, everything blocks: `confirm`
    //     was still pending after 1202ms and an unrelated `page.title()` timed
    //     out too. That is the reported "tab silently locks", reproduced.
    //   * Answering it fully recovers the page.
    // So the rule is: the moment we take responsibility for dialogs we owe the
    // user a way to answer every single one, or we have built the lock-up
    // ourselves. Hence `pendingDialog` + an explicit `answerDialog`, and a
    // safety net in `close()`.
    page.on('dialog', (dialog) => {
      const tab = this.tabOfPage(page);
      // A dialog from a BACKGROUND tab cannot be shown over the active one
      // without lying about which page is asking. Chrome handles this by
      // switching to that tab, so we do the same: bring it to the front and
      // then ask. That also guarantees the dialog is answerable at all.
      const showAndAsk = async () => {
        if (tab && tab.id !== this.activeId) {
          await this.focus(tab).catch(() => {});
        }
        this.pendingDialog = dialog;
        this.emit('dialog', {
          kind: dialog.type(),                 // alert | confirm | prompt | beforeunload
          message: dialog.message(),
          defaultValue: dialog.defaultValue() || '',
          tabId: tab ? tab.id : this.activeId,
          url: (() => { try { return page.url(); } catch { return ''; } })(),
        });
      };
      void showAndAsk();
    });

    // ── HTTP basic auth (the 401 nobody could answer) ───────────────────────
    // A server that replies 401 with `WWW-Authenticate: Basic` makes Chrome open
    // a NATIVE credentials window — drawn by the browser, not the page. Like the
    // file dialog above, that window can never appear in a screencast, so the
    // canvas just showed a blank or an error page and the site was simply
    // unreachable. Answering it needs CDP.
    //
    // MEASURED (tools/probe-cdp3.js / probe-cdp4.js): `Fetch.authRequired` only
    // fires for requests matching an enabled pattern, and the cost of the pattern
    // is real — `urlPattern: '*'` paused 8 requests on one ordinary page, while
    // restricting it to Documents paused exactly 1 and still delivered the auth
    // event. So: Documents only, always on. Always on rather than
    // enabled-on-demand because there is no way to know a 401 is coming until it
    // has already happened.
    await this.installAuthHandler(page);

    // ── Downloads ───────────────────────────────────────────────────────────
    // MEASURED (tools/probe-cdp4.js): `context.on('download')` NEVER fires in
    // this setup — 0 events in a persistent context AND in a normal one, while
    // `page.on('download')` fired every time. The obvious API is the wrong one,
    // which is precisely the sort of thing that cannot be settled by reading
    // docs. Per-page it is.
    page.on('download', (dl) => {
      void this.trackDownload(dl, page);
    });

    // ── Loading state, so the strip can show a spinner ──────────────────────
    // Chrome replaces a tab's favicon with a spinner while it loads. Without
    // this the strip cannot distinguish "still loading" from "stuck", which is
    // the difference between waiting patiently and reaching for Reload.
    page.on('load', () => {
      const t = this.tabOfPage(page);
      if (!t) return;
      t.loading = false;
      this.emitTabs();
      void this.refreshFavicon(t);
      if (page === this.page) void this.emitNavState();
    });
    page.on('domcontentloaded', () => {
      const t = this.tabOfPage(page);
      if (t) { t.loading = false; this.emitTabs(); }
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
        // A navigation invalidates the old site's icon. Clearing it first stops
        // the previous site's favicon sitting on the new page's tab.
        tab.favicon = '';
        void this.refreshFavicon(tab);
      }
      if (page !== this.page) { this.emitTabs(); void this.persistTabs(); return; }
      this.emit('navigated', { url: frame.url() });
      this.emitTabs();
      void this.persistTabs();
      // Back/Forward availability changes on every navigation, including the
      // ones the PAGE initiates (a link, a redirect, an extension) — not just
      // the ones we command. This is why it is emitted here and not only in
      // the nav commands.
      void this.emitNavState();
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
      if (page === this.page) {
        tab.dead = true;
        this.page = null;
        void this.recover('closed');
        return;
      }
      // ── MEASURED 2026-08-03 (tools/probe-restart-tabs.js) ──────────────────
      // THIS LINE WAS THE «مشکل بزرگیه»: installing an extension lost EVERY tab.
      //
      // Relaunching Chrome (which an extension install MUST do — Chrome only
      // reads extensions at launch) closes every page inside it, so every tab
      // fires `close` in the same tick. The old code treated each of those as
      // "a background tab closed itself, it is just gone", deleted it from
      // `this.tabs`, and then `persistTabs()` wrote the shrunken list STRAIGHT
      // TO DISK — destroying the very backup that existed to survive this. By
      // the time `recover()` ran there was nothing left to restore, which is why
      // the measured result was a single `about:blank`, not even the one tab the
      // handoff predicted.
      //
      // The distinction that was missing: a page closing because THE PAGE asked
      // to (window.close(), a link with target=_blank that closes itself) is a
      // real tab closure and the tab should go. A page closing because THE
      // BROWSER UNDER IT went away is not a tab closure at all — the user's tab
      // still exists, it has just lost its renderer, and the honest response is
      // the one `materialize()` already implements: keep the record, mark it
      // `pending`, and rebuild the page on demand.
      //
      // `isContextDead()` is how we tell those apart, and it is reliable here
      // precisely because a relaunch takes the whole context with it.
      if (this.closed) { tab.dead = true; return; }
      // Provisionally: the tab STAYS, and only its page is forgotten. This is
      // the safe order — a tab wrongly kept for 400ms is invisible, a tab
      // wrongly deleted is the bug being fixed, and `persistTabs()` is not
      // called here so nothing reaches disk on a guess.
      tab.pending = true;
      tab.dead = false;
      this.emitTabs();
      // ── Why a grace window and not an immediate `isContextDead()` ──────────
      // MEASURED 2026-08-03 (tools/probe-restart-tabs.js): checking it inline
      // was WRONG and still lost the tabs. `isContextDead()` reads
      // `context.pages().length === 0`, but when Chrome is relaunched the pages
      // close one at a time, so the first `close` handler still sees two live
      // siblings and concludes the browser is fine. The verdict was being asked
      // for at the one moment it cannot be known.
      //
      // So the question is deferred instead of guessed. After a short grace the
      // answer is unambiguous: either the context has finished dying (a
      // relaunch — keep every tab, they come back `pending`) or it is still
      // serving pages (that one page really did call `window.close()` — reap the
      // record, exactly as before).
      //
      // A recovery already in flight is the same answer arriving early.
      setTimeout(() => {
        if (this.closed) return;
        if (!this.tabs.includes(tab)) return;         // already reaped elsewhere
        const browserGone = !this.context || isContextDead(this.context);
        if (browserGone || this.recovering || this.tabsFrozen) {
          // The browser went, not the tab. «نهایتش باید یه رفرش می‌شد» — at
          // worst a reload. The record is already `pending`; `recover()` puts
          // the strip back and clicking a chip reloads that page.
          return;
        }
        // A background tab that genuinely closed itself is gone.
        tab.dead = true;
        this.tabs = this.tabs.filter((t) => t !== tab);
        this.emitTabs();
        void this.persistTabs();
      }, SELF_CLOSE_GRACE_MS);
    });
  }

  /**
   * Find the tab's favicon the way a browser does — and hand it over as BYTES.
   *
   * Order matters and mirrors the spec: an explicit `<link rel="icon">` wins
   * (a site that declares one means it), and only if there is none do we fall
   * back to the well-known `/favicon.ico`. The URL is resolved against the
   * document so a relative href works.
   *
   * WHY A `data:` URL AND NOT THE ICON'S OWN URL
   * MEASURED 2026-08-03 (tools/probe-ui-controls.js): this used to send the
   * remote http(s) URL, and the client's own Content-Security-Policy
   * (`img-src 'self' data:`, src/index.ts) refused every single one of them:
   *   Refused to load the image 'http://…/favicon.ico' because it violates the
   *   following Content Security Policy directive: "img-src 'self' data:"
   * So NO tab in the strip could ever show a real favicon — the strip silently
   * fell back to the generic globe for every site, and the console filled with
   * refusals on every navigation. Widening the CSP to allow arbitrary remote
   * images would trade a cosmetic bug for a real XSS-exfiltration surface, and
   * a server-side proxy endpoint would be an SSRF hole pointed at our own
   * network. Reading the bytes INSIDE THE PAGE is neither: it is the page
   * fetching its own icon, with its own cookies and its own origin, so
   * authenticated and intranet favicons work too, and the result travels as a
   * `data:` URL the CSP already permits.
   *
   * Best-effort throughout, and capped: a missing favicon is a cosmetic detail
   * and must never be able to throw inside a navigation handler, nor put a
   * megabyte of base64 into every `tabs` frame.
   */
  private async refreshFavicon(tab: LiveTab): Promise<void> {
    const page = tab.page;
    if (!page || page.isClosed()) return;
    try {
      const icon = await page.evaluate(async () => {
        const links = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'))
          .map((l) => (l as HTMLLinkElement).href)
          .filter(Boolean);
        let href = links[0] || '';
        if (!href) {
          try { href = new URL('/favicon.ico', location.origin).href; } catch { return ''; }
        }
        // Already inline: hand it straight over, it is what we are producing.
        if (/^data:image\//i.test(href)) return href.length <= 32768 ? href : '';
        if (!/^https?:\/\//i.test(href)) return '';
        try {
          const res = await fetch(href, { credentials: 'include' });
          if (!res.ok) return '';
          const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
          // Only real image types. An HTML 404 page served with 200 is the
          // commonest "favicon" on the web and must not become a broken glyph.
          if (!/^image\//i.test(type)) return '';
          const buf = await res.arrayBuffer();
          if (!buf.byteLength || buf.byteLength > 24576) return '';
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
          return 'data:' + type + ';base64,' + btoa(bin);
        } catch { return ''; }
      });
      const url = String(icon || '');
      // `data:` only. Anything else would be refused by the client's CSP, and
      // sending something the client provably cannot render is worse than
      // sending nothing: the strip would show a broken image instead of the
      // globe fallback that is actually correct.
      if (!/^data:image\//i.test(url)) return;
      if (tab.favicon === url) return;
      tab.favicon = url;
      this.emitTabs();
    } catch { /* page navigated mid-read, or an about: page with no document */ }
  }

  /**
   * Which tabs are making noise.
   *
   * Chrome puts a speaker badge on an audible tab, and it is the only way to
   * find the tab that started playing a video by itself. There is no CDP event
   * for it, so it is sampled — cheaply, and only for tabs that have a page.
   */
  private async refreshAudio(): Promise<void> {
    let changed = false;
    for (const tab of this.tabs) {
      const page = tab.page;
      if (!page || page.isClosed()) continue;
      try {
        const audible = await page.evaluate(() => {
          const media = Array.from(document.querySelectorAll('video,audio')) as HTMLMediaElement[];
          return media.some((m) => !m.paused && !m.muted && m.volume > 0 && m.currentTime > 0);
        });
        if (!!tab.audible !== !!audible) { tab.audible = audible; changed = true; }
      } catch { /* not readable right now */ }
    }
    if (changed) this.emitTabs();
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
      // Same reasoning as openTab(): a bind that fails is a pending stream, not
      // a reason to abandon a working page — and never a reason to reject out of
      // start(), which would leave the client waiting for a `ready` that is
      // never coming.
      try {
        await this.bindCdp(page);
      } catch {
        tab.pending = true;
      }
    }
    const target = tab.url && tab.url !== 'about:blank' ? tab.url : '';
    if (target) {
      // MEASURED 2026-08-03: a saved tab whose page calls alert()/confirm()/
      // prompt() on load DEADLOCKED THE WHOLE SESSION. `page.goto` does not
      // resolve while a modal dialog is open, so start() never reached
      // `emit('ready')`; the client sat on a connected socket that had sent a
      // `dialog` event nobody could answer yet, because the UI is only wired up
      // after `ready`. The user's browser was "dead but connected" on every
      // single open, and the only cure was deleting the saved-tab file by hand:
      // exactly the unrecoverable loop the GLOBAL MANDATE forbids.
      //
      // During RESTORE only, a dialog is auto-dismissed. It belongs to a page the
      // user is only now getting back, nobody has asked to interact with it yet,
      // and dismissing is what Chrome effectively does when it restores a tab.
      // The real `page.on('dialog')` handler attached by attachPage() takes over
      // for everything the user goes on to do.
      const dismissDuringRestore = (d: import('playwright').Dialog) => {
        void d.dismiss().catch(() => {});
      };
      page.on('dialog', dismissDuringRestore);
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        // The page exists and is usable; only the restore target failed. Say so
        // instead of throwing away a working tab.
        this.emit('error', { message: 'restore_failed: ' + target });
      } finally {
        page.off('dialog', dismissDuringRestore);
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
    // MEASURED 2026-08-03 (tools/probe-ui-controls.js): this was missing, and it
    // is the "Back/Forward don't work" report in full. History is PER TAB, but
    // the client only ever learns canGoBack/canGoForward from a `navState`
    // frame — and switching tabs emitted `tabs` + `navigated` and nothing else.
    // So the arrows kept showing the PREVIOUS tab's history: switch from a tab
    // you had browsed into a fresh one and Back stayed lit, pressing it did
    // nothing (correctly — there is no history), and the button looked broken.
    // Every path that changes which tab is streamed must re-answer this.
    await this.emitNavState();
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
      // MEASURED 2026-08-03 (tools/probe-live-parity.js): this await used to be
      // bare, and it TOOK THE WHOLE SERVER DOWN. A tab opened while an extension
      // (or the page itself) immediately replaces the target loses its guid, so
      // `newCDPSession` rejects with "no object with guid page@…". Nothing caught
      // it, so it surfaced as an unhandledRejection, which src/index.ts treats as
      // fatal and answers with a graceful shutdown — every other user's session
      // destroyed by one unlucky tab, and the only cure a manual restart. That is
      // precisely the loop the GLOBAL MANDATE forbids.
      //
      // A tab whose stream could not be bound is not a dead browser: the page is
      // usually fine, and `resync`/the health poll rebind it. So it is marked
      // `pending` (the strip shows it as still coming up) and the session
      // continues. Self-healing means the failure costs a spinner, not a server.
      try {
        await this.bindCdp(page);
      } catch (e) {
        tab.pending = true;
        this.emit('error', {
          message: 'tab_stream_pending',
          detail: (e as Error).message || 'cdp_bind_failed',
          tabId: tab.id,
        });
        // Ask for a rebind out of band. If the page really is gone, `recover()`
        // inside resync() rebuilds it; if it is alive, the stream simply resumes.
        setTimeout(() => { void this.resync().catch(() => {}); }, 250);
      }
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
    // A newly activated tab has its OWN (empty) history. Without this the strip
    // gained a tab while the toolbar still described the tab the user left — see
    // the note in focus(). Only when we actually took over the stream: a
    // background tab must not repaint the active tab's arrows.
    if (opts.activate !== false) await this.emitNavState();
    return tab;
  }

  /**
   * Persist the strip so the next open of this window is not a blank slate.
   *
   * Refuses while the list is frozen (see `tabsFrozen`). That guard mirrors the
   * existing `if (this.closed) return` on the same function and exists for the
   * same class of reason: there are moments when the in-memory list is not the
   * truth, and writing it then is worse than not writing at all — a saved list
   * is only useful if it survives the failure it is meant to insure against.
   */
  private async persistTabs(): Promise<void> {
    if (this.closed) return;
    if (this.tabsFrozen) return;
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

  /**
   * Close a tab — ASKING first if the page has unsaved work.
   *
   * A page with a `beforeunload` handler is Chrome's "Leave site? Changes you
   * made may not be saved." The old code called `page.close()` and threw that
   * work away without a word. MEASURED (tools/probe-cdp3.js): dismissing a
   * `beforeunload` dialog really does keep the page alive (`isClosed() === false`
   * afterwards), so asking is not a cosmetic gesture — Cancel genuinely saves
   * the tab.
   *
   * `runBeforeUnload: true` is what makes Chrome fire the handler at all; without
   * it the close is unconditional. If a handler exists, our `page.on('dialog')`
   * gets a `beforeunload` dialog and `answerDialog` calls us back with
   * `force: true`. If no handler exists nothing fires, so we must not wait for a
   * dialog that is never coming — hence the short grace period and then a plain
   * close.
   */
  async closeTab(id: string, opts: { force?: boolean } = {}): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab) return;

    if (!opts.force && tab.page && !tab.page.isClosed()) {
      const page = tab.page;
      this.closingTabId = tab.id;
      // Ask the page to unload. Either a dialog arrives (and `answerDialog`
      // finishes the job), or the page just goes.
      const asked = page.close({ runBeforeUnload: true }).catch(() => {});
      await Promise.race([asked, new Promise((r) => setTimeout(r, 400))]);
      if (this.pendingDialog) {
        // A dialog is up and the user has to answer it. The tab stays exactly
        // where it is until they do; the close resumes from `answerDialog`.
        return;
      }
      this.closingTabId = '';
      // No handler, or it let us go: fall through and reap the record.
    }
    this.closingTabId = '';

    const wasActive = tab.id === this.activeId;
    const idx = this.tabs.indexOf(tab);
    this.tabs = this.tabs.filter((t) => t !== tab);
    // Remember it so Ctrl+Shift+T can bring it back. Chrome keeps a stack of
    // these, and "I closed the wrong tab" is one of the most common things a
    // person does in a browser — without this the only recovery is remembering
    // the URL, which is exactly what the tab was remembering FOR them.
    if (/^https?:/i.test(tab.url) || /^chrome-extension:/i.test(tab.url)) {
      this.closedTabs.push({ url: tab.url, title: tab.title, index: idx, pinned: !!tab.pinned });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
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

  /**
   * Ctrl+Shift+T — reopen the most recently closed tab, where it was.
   *
   * Restoring the INDEX matters more than it sounds: a tab you closed by mistake
   * reappearing at the far right of a strip of fifteen is a tab you then have to
   * go and find. Chrome puts it back in its place, so we do too.
   */
  async reopenClosedTab(): Promise<void> {
    this.touch();
    const last = this.closedTabs.pop();
    if (!last) {
      // Say so rather than doing nothing. A shortcut that silently no-ops is
      // indistinguishable from a shortcut that is broken.
      this.emit('tabReopenEmpty', {});
      return;
    }
    const tab = await this.openTab(last.url, { activate: true });
    if (!tab) return;
    tab.pinned = last.pinned;
    const from = this.tabs.indexOf(tab);
    const to = Math.max(0, Math.min(last.index, this.tabs.length - 1));
    if (from >= 0 && from !== to) {
      this.tabs.splice(to, 0, ...this.tabs.splice(from, 1));
    }
    this.normalizeTabOrder();
    this.emitTabs();
    void this.persistTabs();
  }

  /**
   * Drag-to-reorder.
   *
   * Pinned tabs are kept to the left, as Chrome does: a pinned tab dragged into
   * the middle of the unpinned ones snaps back, because "pinned" IS a position as
   * much as it is a state.
   */
  async moveTab(id: string, index: number): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab) return;
    const from = this.tabs.indexOf(tab);
    const to = Math.max(0, Math.min(Math.trunc(Number(index) || 0), this.tabs.length - 1));
    if (from < 0 || from === to) return;
    this.tabs.splice(to, 0, ...this.tabs.splice(from, 1));
    this.normalizeTabOrder();
    this.emitTabs();
    void this.persistTabs();
  }

  /** Duplicate — a new tab on the same URL, immediately to the right, as Chrome. */
  async duplicateTab(id: string): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab) return;
    const at = this.tabs.indexOf(tab);
    const copy = await this.openTab(tab.url, { activate: true });
    if (!copy) return;
    const from = this.tabs.indexOf(copy);
    if (from >= 0 && at >= 0 && from !== at + 1) {
      this.tabs.splice(at + 1, 0, ...this.tabs.splice(from, 1));
    }
    this.normalizeTabOrder();
    this.emitTabs();
    void this.persistTabs();
  }

  /** Pin / unpin. Pinning also moves the tab left, which is what pinning means. */
  async pinTab(id: string, pinned?: boolean): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab) return;
    tab.pinned = pinned === undefined ? !tab.pinned : !!pinned;
    this.normalizeTabOrder();
    this.emitTabs();
    void this.persistTabs();
  }

  /** Mute / unmute a tab — the speaker icon in the strip is a button in Chrome. */
  async muteTab(id: string, muted?: boolean): Promise<void> {
    this.touch();
    const tab = this.findTab(String(id || ''));
    if (!tab) return;
    tab.muted = muted === undefined ? !tab.muted : !!muted;
    const page = tab.page;
    if (page && !page.isClosed()) {
      const want = !!tab.muted;
      // There is no CDP "mute tab", so mute the elements. Also re-applied on
      // navigation by `refreshAudio`, because a new document brings new elements.
      await page.evaluate((m) => {
        for (const el of Array.from(document.querySelectorAll('video,audio'))) {
          (el as HTMLMediaElement).muted = m;
        }
      }, want).catch(() => {});
    }
    this.emitTabs();
  }

  /** Close every tab except this one (Chrome's "Close other tabs"). */
  async closeOtherTabs(id: string): Promise<void> {
    this.touch();
    const keep = this.findTab(String(id || ''));
    if (!keep) return;
    // Snapshot first: `closeTab` mutates the list we would otherwise iterate.
    // Pinned tabs survive, exactly as they do in Chrome.
    const doomed = this.tabs.filter((t) => t !== keep && !t.pinned).map((t) => t.id);
    for (const tid of doomed) await this.closeTab(tid, { force: true });
    await this.selectTab(keep.id);
  }

  /** Close everything to the right of this tab. */
  async closeTabsToRight(id: string): Promise<void> {
    this.touch();
    const from = this.findTab(String(id || ''));
    if (!from) return;
    const at = this.tabs.indexOf(from);
    if (at < 0) return;
    const doomed = this.tabs.slice(at + 1).filter((t) => !t.pinned).map((t) => t.id);
    for (const tid of doomed) await this.closeTab(tid, { force: true });
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab — cycle, wrapping round as Chrome does. */
  async cycleTab(dir: 1 | -1): Promise<void> {
    this.touch();
    if (this.tabs.length < 2) return;
    const at = this.tabs.findIndex((t) => t.id === this.activeId);
    const base = at < 0 ? 0 : at;
    const next = (base + dir + this.tabs.length) % this.tabs.length;
    await this.focus(this.tabs[next]);
  }

  /** Pinned left, unpinned right, order otherwise preserved. */
  private normalizeTabOrder(): void {
    const pinned = this.tabs.filter((t) => t.pinned);
    const rest = this.tabs.filter((t) => !t.pinned);
    this.tabs = [...pinned, ...rest];
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
        // Freeze the saved list for the whole rebuild. See `tabsFrozen`.
        this.tabsFrozen = true;
        this.emit('recovering', { reason });
        // A pending dialog belongs to a page we are about to replace, and an
        // unanswered one blocks that page against being closed at all. Clear it
        // before touching anything else. Same for a paused auth request.
        await this.drainDialog();
        await this.drainAuth();
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
        // The ACTIVE tab first, always: it is the one the user is looking at, so
        // it is the one whose wait they actually feel.
        const ok = await this.materialize(target).catch(() => false);
        if (!ok) {
          // The active tab could not come back. Keep it in the strip as
          // `pending` rather than deleting it: the user asked for that page, and
          // clicking the chip retries. Deleting it here is what turned "one page
          // failed to reload" into "my tab is gone" — and, via persistTabs(),
          // into permanent loss.
          target.page = null;
          target.pending = true;
          target.dead = false;
          const fresh = await this.openTab('about:blank', { activate: true });
          this.emit('recovered', { reason, url: 'about:blank', tabId: fresh ? fresh.id : '' });
          // Only NOW is the list trustworthy again, and it still has every tab.
          this.tabsFrozen = false;
          void this.persistTabs();
          return true;
        }
        await this.focus(target);
        this.emit('recovered', { reason, url: target.url, tabId: target.id });
        // ── The other tabs ────────────────────────────────────────────────────
        // `index.ts` promises "an extension install costs the user a progress
        // panel — never a lost tab", and MEASURED 2026-08-03 it was restoring
        // exactly one. The tab RECORDS survive a context swap (url + title are
        // ours, not Chrome's); what they lose is their page. So re-announce the
        // full strip and let each chip materialize on demand, which is the same
        // lazy path a restored session already uses on startup.
        //
        // Lazily, and deliberately: eagerly reloading fifteen pages inside a
        // browser that has only just come back is how a recovery turns into a
        // second outage. What must be immediate is the LIST — losing a page is
        // recoverable by clicking it, losing the list is not.
        const restored = this.tabs.filter((t) => t !== target && !t.dead);
        for (const t of restored) {
          if (!t.page || t.page.isClosed()) { t.page = null; t.pending = true; }
        }
        this.emitTabs();
        // The recovery is over, so the in-memory list is trustworthy again and
        // may be written. Lifting the freeze here rather than in `finally` is
        // what lets this write through the guard in persistTabs().
        this.tabsFrozen = false;
        void this.persistTabs();
        // Tell the client how much survived, so an extension install reads as
        // "3 tabs restored" instead of as silence after a scare.
        this.emit('tabsRestored', { count: this.tabs.filter((t) => !t.dead).length });
        return true;
      } catch (e) {
        this.emit('error', { message: 'recover_failed: ' + (e as Error).message });
        return false;
      } finally {
        this.recovering = null;
        // A freeze that outlives the recovery would silently stop this session
        // ever saving its tabs again — the opposite failure, and just as quiet.
        // So the freeze always lifts here, but NOTHING is written from this
        // path: an aborted rebuild is exactly the state whose list must not be
        // trusted. The next real tab action (a focus, an open, a close) writes a
        // list that still contains every record, because nothing deletes them
        // any more.
        this.tabsFrozen = false;
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

    // The speaker badge. There is no CDP event for "this tab is audible", so it
    // has to be sampled; a separate, slower timer keeps it off the liveness path
    // (a poll that decides whether to REBUILD the session must not also be doing
    // cosmetic work that can make it slow).
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = setInterval(() => {
      if (this.closed || this.recovering) return;
      void this.refreshAudio().catch(() => { /* cosmetic */ });
    }, AUDIO_POLL_MS);
    if (this.audioTimer.unref) this.audioTimer.unref();
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
        // MEASURED 2026-08-03: this branch used to `return` under a comment
        // saying "a normal failure: the caller logs it". No caller logs it.
        // Every input command funnels through here, so any command that failed
        // for a reason OTHER than a dead target failed in total silence — the
        // user saw a click that did nothing and there was no evidence anywhere
        // that it had even been attempted. Silence is the one thing this
        // codebase is not allowed to do: the mandate is that real state is
        // always visible. Say so instead.
        if (!isDeadTargetError(e)) { this.inputFailed(e); return; }
      }
    }
    const ok = await this.recover('command');
    if (!ok || !this.page) return;
    try { await fn(this.page); } catch (e) { this.inputFailed(e); }
  }

  /** Same contract as `withPage`, for the CDP-driven input commands. */
  private async withCdp(fn: (cdp: CDPSession) => Promise<void>): Promise<void> {
    if (this.cdp) {
      try { await fn(this.cdp); return; }
      catch (e) {
        if (!isDeadTargetError(e)) { this.inputFailed(e); return; }
      }
    }
    const ok = await this.recover('command');
    if (!ok || !this.cdp) return;
    try { await fn(this.cdp); } catch (e) { this.inputFailed(e); }
  }

  /**
   * An input command failed for an ordinary reason. Nothing is broken enough to
   * recover, but the user is owed the truth: they pressed something and it did
   * not happen. `input_failed` is deliberately distinct from the fatal error
   * kinds so the client can show it as a transient notice rather than tearing
   * the view down.
   */
  private inputFailed(e: unknown): void {
    const detail = (e as Error)?.message || String(e);
    this.emit('error', { message: 'input_failed', detail: detail.slice(0, 300) });
  }

  /**
   * Navigate the ACTIVE tab. Scheme handling lives in `normalizeTarget`, which
   * is also what `openTab` uses — one allowlist, so a new tab and an address-bar
   * entry can never disagree about what is loadable.
   */
  /**
   * Run navigations one at a time, per session.
   *
   * MEASURED (tools/probe-nav.js): two `navigate` commands close together made
   * the second abort the first, and the session reported
   * `page.goto: net::ERR_ABORTED` — an error the user did nothing wrong to
   * cause. A double-clicked Go button, or Enter in the address bar while a
   * click on a link was still loading, was enough. Chrome does not show you an
   * error for that; it just goes to the last place you asked for.
   *
   * So navigations queue instead of racing, and a superseded one is dropped
   * rather than reported as a failure.
   */
  private navQueue: Promise<void> = Promise.resolve();
  private navSeq = 0;

  private queueNav(fn: () => Promise<void>): Promise<void> {
    this.navSeq += 1;
    const mine = this.navSeq;
    const run = this.navQueue.then(async () => {
      // Someone asked for something newer while we were waiting: their intent
      // wins, and this one never happened as far as the user is concerned.
      if (this.closed || mine !== this.navSeq) return;
      await fn();
    });
    // Keep the chain alive even when a link fails, or one bad navigation would
    // wedge every later one.
    this.navQueue = run.catch(() => {});
    return run;
  }

  /** True while a navigation this session started is still in flight. */
  private navigating = false;

  /**
   * Run a navigation with honest progress reporting.
   *
   * The user's mandate: whenever they have to wait, the UI must say what is
   * happening. So a navigation announces itself, and always announces its end —
   * including when it ends in a failure, because a spinner that never stops is
   * the thing that made them feel "dazed and confused".
   */
  private async runNav(label: string, fn: (page: Page) => Promise<unknown>): Promise<void> {
    await this.queueNav(async () => {
      this.navigating = true;
      this.emit('navStart', { kind: label, tabId: this.activeId });
      const tab = this.findTab(this.activeId);
      if (tab) tab.loading = true;
      this.emitTabs();
      try {
        await this.withPage(async (page) => {
          try {
            await fn(page);
            this.emit('navigated', { url: page.url() });
          } catch (e) {
            if (isDeadTargetError(e)) throw e;   // let withPage recover and retry
            const msg = (e as Error).message || '';
            // A navigation that was replaced by a newer one is not a failure the
            // user needs to see — it is them changing their mind.
            if (/ERR_ABORTED|net::ERR_ABORTED/.test(msg)) return;
            this.emit('error', { message: msg });
          }
        });
      } finally {
        this.navigating = false;
        const t = this.findTab(this.activeId);
        if (t) t.loading = false;
        await this.syncActiveTab();
        this.emit('navEnd', { kind: label, tabId: this.activeId });
      }
    });
  }

  async navigate(url: string): Promise<void> {
    this.touch();
    const target = normalizeTarget(url);
    if (!target) {
      // Silence here is what made a mistyped address look like a dead browser.
      this.emit('error', { message: 'unsupported_url' });
      return;
    }
    await this.runNav('navigate', async (page) => {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    await this.emitNavState();
  }

  /**
   * Tell the client whether Back and Forward would actually DO anything.
   *
   * Measured (tools/probe-nav.js): the old session never sent this, so the
   * client could not grey the buttons out and could not explain a no-op. The
   * user's report that "back/forward don't work correctly" is exactly this —
   * pressing Back at the start of history silently re-emitted
   * `navigated(about:blank)`, which looks like a broken button rather than the
   * end of the history list.
   *
   * There is no CDP "canGoBack", so it is derived from the real history:
   * `Page.getNavigationHistory` returns the entries and the current index.
   */
  private async emitNavState(): Promise<void> {
    const state = await this.navState();
    this.emit('navState', state as unknown as Record<string, unknown>);
  }

  private async navState(): Promise<{ canGoBack: boolean; canGoForward: boolean; url: string; zoom: number }> {
    const url = this.page && !this.page.isClosed() ? this.page.url() : 'about:blank';
    let canGoBack = false;
    let canGoForward = false;
    if (this.cdp) {
      try {
        const hist = await this.cdp.send('Page.getNavigationHistory') as {
          currentIndex: number;
          entries: Array<{ url: string }>;
        };
        canGoBack = hist.currentIndex > 0;
        canGoForward = hist.currentIndex < hist.entries.length - 1;
      } catch { /* a dead target answers nothing; both stay false, which is honest */ }
    }
    return { canGoBack, canGoForward, url, zoom: this.zoom };
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
  /**
   * Back / Forward.
   *
   * Both check FIRST whether there is anywhere to go, and say so rather than
   * pretending. `goBack` resolving to `null` at the start of history used to be
   * followed by an unconditional `navigated` event carrying the SAME url, which
   * is indistinguishable from a broken button — the reported symptom.
   */
  async back(): Promise<void> {
    this.touch();
    const st = await this.navState();
    if (!st.canGoBack) {
      this.emit('navBlocked', { kind: 'back', reason: 'history_start' });
      await this.emitNavState();
      return;
    }
    await this.runNav('back', async (page) => {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
    });
  }

  async forward(): Promise<void> {
    this.touch();
    const st = await this.navState();
    if (!st.canGoForward) {
      this.emit('navBlocked', { kind: 'forward', reason: 'history_end' });
      await this.emitNavState();
      return;
    }
    await this.runNav('forward', async (page) => {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
    });
  }

  /** Reload. `hard` bypasses the cache, which is what Ctrl+Shift+R means. */
  async reload(opts: { hard?: boolean } = {}): Promise<void> {
    this.touch();
    if (opts.hard) {
      // Playwright's reload() always uses the cache; a real hard reload is a
      // CDP call, and the user asking for one usually means "the cached copy is
      // wrong", so quietly giving them a soft reload would be the wrong answer.
      let done = false;
      await this.withCdp(async (cdp) => {
        await cdp.send('Page.reload', { ignoreCache: true });
        done = true;
      });
      if (done) {
        this.emit('navStart', { kind: 'reloadHard', tabId: this.activeId });
        // Give the load a moment to settle, then report where we ended up.
        await this.withPage(async (page) => {
          await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
          this.emit('navigated', { url: page.url() });
        });
        await this.syncActiveTab();
        this.emit('navEnd', { kind: 'reloadHard', tabId: this.activeId });
        return;
      }
    }
    await this.runNav('reload', async (page) => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    });
  }

  /**
   * Map a point the client measured on the CANVAS into the page's own
   * coordinate space.
   *
   * Zoom makes this necessary. Measured (tools/probe-zoom.js): while a device
   * metrics override is active the page's layout is `viewport / zoom` wide, and
   * CDP input coordinates are in that layout space — while the canvas the user
   * clicked is still viewport-sized. Sending the raw canvas point at 150% zoom
   * therefore lands 1.5x too far right and down, so every click after a zoom
   * would hit the wrong element and the browser would look broken. The probe
   * proved both directions: divided → hit, undivided → miss.
   */
  private toPagePoint(x: number, y: number): { x: number; y: number } {
    const z = this.zoom || 1;
    return { x: Math.round(Number(x) / z), y: Math.round(Number(y) / z) };
  }

  /**
   * A click, with everything Chrome puts on one: which button, how many times,
   * and which modifiers were held.
   *
   * The old signature was `click(x, y)` with `button:'left', clickCount:1`
   * hardcoded, which made Ctrl+Click, Shift+Click, middle-click, right-click,
   * double-click and triple-click all impossible — six ordinary browser
   * gestures behind one missing parameter.
   *
   * Sending clickCount 1..n rather than just n is what Chromium expects: the
   * count RISES across a multi-click, exactly as a real mouse reports it.
   * Measured: cc=2 on a word selects that word, cc=3 selects the paragraph.
   */
  async click(
    x: number,
    y: number,
    opts: { button?: unknown; clickCount?: unknown; mods?: Mods } = {},
  ): Promise<void> {
    this.touch();
    const p = this.toPagePoint(x, y);
    const button = normalizeButton(opts.button);
    const count = normalizeClickCount(opts.clickCount);
    const modifiers = modifierMask(opts.mods);
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: p.x, y: p.y, modifiers, buttons: 0,
      });
      for (let i = 1; i <= count; i += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: p.x, y: p.y, button,
          buttons: buttonsMask(button), clickCount: i, modifiers,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: p.x, y: p.y, button,
          buttons: 0, clickCount: i, modifiers,
        });
      }
    });
  }

  /**
   * A drag: press, move in steps, release.
   *
   * One CDP call per phase would not do it — Blink starts a selection or a drag
   * only when it sees intermediate `mouseMoved` events WITH the button still
   * held (`buttons: 1`). Measured: press → 10 moves → release selects a text
   * range; press → release does nothing. This is the same primitive behind text
   * selection, a range slider, HTML5 drag & drop and dragging a file onto a
   * drop zone, so it is worth getting exactly right once.
   */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts: { button?: unknown; mods?: Mods; steps?: number } = {},
  ): Promise<void> {
    this.touch();
    const a = this.toPagePoint(from.x, from.y);
    const b = this.toPagePoint(to.x, to.y);
    const button = normalizeButton(opts.button);
    const modifiers = modifierMask(opts.mods);
    // Enough steps that Blink treats it as a gesture, few enough to stay cheap.
    const steps = Math.min(Math.max(Math.round(Number(opts.steps) || 12), 4), 30);
    // MEASURED (tools/probe-live-parity.js, 2026-08-03): sending press → moves →
    // release with NO gap made both drag-to-select-text and drag-a-slider do
    // nothing at all. `Input.dispatchMouseEvent` resolves as soon as the browser
    // process has accepted the event, NOT when the renderer has handled it, so a
    // tight loop delivers the whole path inside one compositor frame and Blink
    // treats it as a single teleport rather than a gesture. A human drag spans
    // hundreds of milliseconds; Blink's selection and its slider both need to
    // observe the pointer at intermediate positions to build a range or track a
    // thumb. So each step yields long enough for a frame to be produced.
    const gap = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: a.x, y: a.y, modifiers, buttons: 0,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: a.x, y: a.y, button,
        buttons: buttonsMask(button), clickCount: 1, modifiers,
      });
      // Let the press land and focus/hit-test settle before the pointer leaves.
      await gap(24);
      for (let i = 1; i <= steps; i += 1) {
        // MEASURED 2026-08-03: `button: 'none'` on the moves (what DevTools sends,
        // since `button` names the button that CHANGED state and during a move
        // none did) was tried here and made things WORSE — it broke the slider
        // that `button: 'left'` gets right, taking the probe from 66/67 to 65/67.
        // So Blink wants the held button named on the move. Keep it.
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(a.x + ((b.x - a.x) * i) / steps),
          y: Math.round(a.y + ((b.y - a.y) * i) / steps),
          button, buttons: buttonsMask(button), modifiers,
        });
        // ~16ms is one frame at 60Hz. Cheap, and it is the difference between a
        // gesture Blink acts on and a jump it ignores.
        await gap(16);
      }
      // The release must not race the last move either: a slider commits its
      // value on the release, and it has to see the final position first.
      await gap(16);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: b.x, y: b.y, button,
        buttons: 0, clickCount: 1, modifiers,
      });
    });
  }

  // Pointer movement without a click. The Element Picker needs this: its
  // page-side highlight + hover preview are driven by mousemove, and the
  // client streams a canvas image, not the real cursor.
  //
  // NOT routed through `withCdp`: a hover fires ~14 times a second, and letting
  // each one trigger a recovery would turn a single dead page into a storm of
  // context rebuilds. The health poll and the next real click both notice.
  async move(x: number, y: number, opts: { mods?: Mods; buttons?: number } = {}): Promise<void> {
    this.touch();
    if (!this.cdp) return;
    const p = this.toPagePoint(x, y);
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: p.x, y: p.y,
        modifiers: modifierMask(opts.mods),
        buttons: Number(opts.buttons) || 0,
      });
    } catch { /* ignore */ }
  }

  /**
   * Wheel scroll in BOTH axes.
   *
   * `deltaX` was hardcoded to 0, which silently removed horizontal scrolling —
   * Shift+Wheel, a trackpad swipe, and any horizontally scrolling pane (a wide
   * table, a timeline, a code block) had no way to move. Measured: a `deltaX`
   * of 260 moves `scrollX` to 260.
   */
  async scroll(
    x: number,
    y: number,
    dy: number,
    opts: { dx?: number; mods?: Mods } = {},
  ): Promise<void> {
    this.touch();
    const p = this.toPagePoint(x, y);
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: p.x, y: p.y,
        deltaX: Math.round(Number(opts.dx) || 0),
        deltaY: Math.round(Number(dy) || 0),
        modifiers: modifierMask(opts.mods),
      });
    });
  }

  /**
   * Pinch zoom, for a trackpad pinch or a touch gesture on the canvas.
   *
   * This is the one place `synthesizePinchGesture` is right: it is a GESTURE,
   * not a zoom level. Ctrl +/-/0 go through `setZoom` instead, because those
   * must reflow the page (see `setZoom`).
   */
  async pinch(x: number, y: number, scale: number): Promise<void> {
    this.touch();
    const p = this.toPagePoint(x, y);
    const s = Math.min(Math.max(Number(scale) || 1, 0.2), 8);
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.synthesizePinchGesture', { x: p.x, y: p.y, scaleFactor: s });
    });
  }

  /**
   * Browser zoom — Ctrl+Plus / Ctrl+Minus / Ctrl+0.
   *
   * Uses `Emulation.setDeviceMetricsOverride`, NOT `setPageScaleFactor`.
   * Measured (tools/probe-zoom.js): `setPageScaleFactor` is pinch zoom, so it
   * physically cannot go below 100% on a desktop page (asking for 0.8 reads
   * back 1.0) and does not reflow the page at all. Real zoom changes the layout
   * width: at 125% a 1000px viewport lays out at 800px, at 80% at 1250px, and
   * `clearDeviceMetricsOverride` restores 100% exactly.
   *
   * The level is echoed to the client because the client MUST know it to scale
   * pointer coordinates — see `toPagePoint`.
   */
  async setZoom(dirOrLevel: 'in' | 'out' | 'reset' | number): Promise<void> {
    this.touch();
    const level = typeof dirOrLevel === 'number'
      ? Math.min(Math.max(dirOrLevel, 0.25), 5)
      : nextZoom(this.zoom, dirOrLevel);
    await this.withCdp(async (cdp) => {
      if (Math.abs(level - 1) < 1e-6) {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
      } else {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: Math.round(this.vp.width / level),
          height: Math.round(this.vp.height / level),
          deviceScaleFactor: level,
          mobile: false,
        });
      }
      this.zoom = level;
      this.emit('zoom', { level });
    });
  }

  /**
   * What is under the pointer, so the client can draw a context menu whose
   * items make sense for the thing right-clicked.
   *
   * Chrome's own context menu is drawn by the OS and can never appear in a
   * screencast, so the menu has to be HTML on the client. But a menu that shows
   * "Open link in new tab" over a paragraph, or omits "Copy" over a selection,
   * is a stage prop. This asks the page what is actually there — link href,
   * image src, whether an editable field or a selection is involved — and the
   * client builds the real menu from the answer.
   */
  async contextMenuAt(x: number, y: number): Promise<void> {
    this.touch();
    const p = this.toPagePoint(x, y);
    // Fire the real event too: a page with its own custom menu (Google Docs,
    // a file manager, a canvas app) must still see the right-click.
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: p.x, y: p.y, button: 'right',
        buttons: buttonsMask('right'), clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: p.x, y: p.y, button: 'right',
        buttons: 0, clickCount: 1,
      });
    });
    let info: Record<string, unknown> = {};
    await this.withPage(async (page) => {
      info = await page.evaluate(({ px, py }: { px: number; py: number }) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null;
        const link = el ? (el.closest('a[href]') as HTMLAnchorElement | null) : null;
        const img = el ? (el.closest('img') as HTMLImageElement | null) : null;
        const media = el ? (el.closest('video,audio') as HTMLMediaElement | null) : null;
        const editable = !!(el && (
          el.isContentEditable
          || el.tagName === 'INPUT'
          || el.tagName === 'TEXTAREA'
        ));
        const sel = String(window.getSelection() || '');
        return {
          tag: el ? el.tagName.toLowerCase() : '',
          linkUrl: link ? link.href : '',
          linkText: link ? (link.textContent || '').trim().slice(0, 80) : '',
          imageUrl: img ? img.currentSrc || img.src : '',
          mediaUrl: media ? media.currentSrc || media.src : '',
          editable,
          selection: sel.slice(0, 200),
          hasSelection: sel.trim().length > 0,
        };
      }, { px: p.x, py: p.y });
    });
    // `x`/`y` echoed back in CANVAS space: that is where the menu must appear.
    this.emit('contextMenu', { x: Math.round(Number(x)), y: Math.round(Number(y)), ...info });
  }

  /**
   * Expand the current selection to a word or a paragraph.
   *
   * `Selection.modify` is Blink's own word/paragraph boundary logic, so this
   * gives the client an exact-selection path that does not depend on hitting a
   * glyph rather than the space between two words.
   */
  async expandSelection(unit: 'word' | 'paragraph'): Promise<void> {
    this.touch();
    const granularity = unit === 'paragraph' ? 'paragraph' : 'word';
    await this.withPage(async (page) => {
      await page.evaluate((g: string) => {
        const s = window.getSelection();
        if (!s || !s.rangeCount) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sm = s as any;
        sm.modify('move', 'backward', g);
        sm.modify('extend', 'forward', g);
      }, granularity);
    });
  }

  // Type a string by inserting text (works for most inputs/contenteditable).
  async type(text: string): Promise<void> {
    this.touch();
    await this.withCdp(async (cdp) => {
      await cdp.send('Input.insertText', { text: String(text) });
    });
  }

  /**
   * Send ONE keystroke — any key, with any modifiers.
   *
   * This replaces `page.keyboard.press(name)`, which could only take a key NAME
   * and therefore could not express "Ctrl+Shift+K" or "the character ب", and
   * was fed by a client-side allowlist of nine key names that dropped anything
   * with Ctrl/Alt/Meta held. Between them that removed most of a keyboard:
   * Home/End/PageUp/PageDown, F1-F11, every non-Latin character, and every
   * shortcut a page or an extension might listen for.
   *
   * `buildKeyEvents` supplies what Chromium actually requires — the physical
   * `code`, the virtual key code accelerators match on, and the editing
   * `commands` without which Ctrl+A/C/V/X/Z arrive but do nothing. All measured
   * in tools/probe-input-real.js (9/9).
   */
  async key(name: string, mods: Mods = {}, opts: { autoRepeat?: boolean } = {}): Promise<void> {
    this.touch();
    const spec = buildKeyEvents(String(name || ''), mods, opts);
    if (!spec.events.length) return;
    await this.withCdp(async (cdp) => {
      for (const ev of spec.events) {
        await cdp.send('Input.dispatchKeyEvent', ev);
      }
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

  /**
   * Select everything in the focused field/page — the other half of Ctrl+A.
   *
   * Routed through the same key translator as every other keystroke, so there
   * is ONE implementation of "Ctrl+A" rather than two that can drift apart.
   * The translator names the `selectAll` editing command, which is the part
   * Chromium actually acts on (measured: without it the event arrives and
   * nothing is selected).
   */
  async selectAll(): Promise<void> {
    await this.key('a', process.platform === 'darwin' ? { meta: true } : { ctrl: true });
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

  // ════════════════════════════════════════════════════════════════════════
  // Downloads
  //
  // Chrome shows a shelf with a name, a size and a progress bar, and the file
  // ends up somewhere you can open it. Here the file lands on the SERVER, so the
  // shelf also has to offer a way to fetch it — otherwise a download is a file
  // the user can neither see nor reach.
  //
  // Two channels, because measurement showed neither is sufficient alone:
  //   * `page.on('download')` (probe-cdp4) is the only Playwright event that
  //     fires at all here — `context.on('download')` never did. It gives the
  //     suggested filename and can save the bytes.
  //   * page-level CDP `Browser.downloadProgress` (probe-cdp2) is the only
  //     source of INTERMEDIATE progress — 7 events with real receivedBytes /
  //     totalBytes. Without it a progress bar can only jump 0 -> 100.
  // They conflict if both own the file (measured: with CDP behavior set,
  // `saveAs` fails), so Playwright saves the bytes and CDP only reports.
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Record a download and stream its progress to the client.
   *
   * `suggestedFilename` is sanitised before it touches the filesystem: it comes
   * from a remote server's Content-Disposition, so treating it as a path would
   * be a directory-traversal bug with extra steps.
   */
  private async trackDownload(dl: import('playwright').Download, page: Page): Promise<void> {
    const tab = this.tabOfPage(page);
    this.downloadSeq += 1;
    const id = `d${this.downloadSeq}`;
    const suggested = String(dl.suggestedFilename() || 'download');
    // The name shown on the shelf. Sanitised HERE and not only at save time,
    // because it is also going into the UI, and a name with a bidi override in
    // it can make `report.exe` read as `report.txt` on the shelf.
    const safe = safeFileName(suggested) || 'download';
    const entry: LiveDownload = {
      id,
      // A token, minted per download, is what the client is given. The id is a
      // per-session counter and would collide across sessions on disk.
      token: mintDownloadToken(),
      name: safe,
      url: (() => { try { return dl.url(); } catch { return ''; } })(),
      tabId: tab ? tab.id : this.activeId,
      state: 'inProgress',
      received: 0,
      total: 0,
      path: '',
      error: '',
    };
    this.downloads.push(entry);
    // Cap the shelf: a page in a download loop must not grow this without bound.
    if (this.downloads.length > 40) this.downloads.splice(0, this.downloads.length - 40);
    this.emit('download', this.downloadInfo(entry) as unknown as Record<string, unknown>);

    try {
      const target = await downloadPathFor(this.userId, entry.token, safe);
      await dl.saveAs(target);
      entry.path = target;
      entry.state = 'completed';
      try {
        const st = await fsp.stat(target);
        entry.received = st.size;
        entry.total = st.size;
      } catch { /* size is a nicety, not a requirement */ }
      if (entry.total > MAX_DOWNLOAD_BYTES) {
        // Over the cap: delete it rather than keep a quarter-gigabyte the user
        // did not agree to store, and say why instead of offering a dead link.
        await discardDownload(this.userId, entry.token).catch(() => {});
        entry.state = 'failed';
        entry.path = '';
        entry.error = 'download_too_large';
      }
      void sweepDownloads(this.userId).catch(() => { /* best-effort housekeeping */ });
    } catch (e) {
      // A cancelled or failed download must SAY so. A shelf row stuck at
      // "in progress" forever is the kind of thing that makes a user wait for
      // something that is never going to happen.
      entry.state = 'failed';
      entry.error = (e as Error).message || 'download_failed';
    }
    this.emit('download', this.downloadInfo(entry) as unknown as Record<string, unknown>);
  }

  private downloadInfo(d: LiveDownload): DownloadInfo {
    return {
      id: d.id,
      name: d.name,
      url: d.url,
      tabId: d.tabId,
      state: d.state,
      received: d.received,
      total: d.total,
      ...(d.error ? { error: d.error } : {}),
      // A token, never a path: the fetch route resolves it, so the client can
      // never name a file on the server's disk.
      ...(d.state === 'completed' ? { token: d.token } : {}),
    };
  }

  /** The shelf, for a client that just connected or resynced. */
  downloadList(): DownloadInfo[] {
    return this.downloads.map((d) => this.downloadInfo(d));
  }

  /**
   * Resolve a download token to a path on disk, for the fetch route.
   *
   * Deliberately looks the token up in THIS session's own list rather than
   * trusting the token's shape: a token that was minted for another user is not
   * in here, so there is no way to reach it even though the on-disk layout would
   * technically allow the name to resolve.
   */
  downloadFile(token: string): { path: string; name: string } | null {
    const d = this.downloads.find((x) => x.token === String(token || ''));
    if (!d || d.state !== 'completed' || !d.path) return null;
    return { path: d.path, name: d.name };
  }

  /** Forget one shelf row (Chrome's little x on a download) and delete the file. */
  clearDownload(token: string): void {
    this.touch();
    const tok = String(token || '');
    const gone = this.downloads.filter((d) => d.token === tok);
    this.downloads = this.downloads.filter((d) => d.token !== tok);
    for (const d of gone) {
      // Removing the row removes the file too. Keeping the bytes after the user
      // dismissed the row would be storing something they believe is gone.
      void discardDownload(this.userId, d.token).catch(() => {});
    }
    this.emit('downloadCleared', { token: tok, id: gone[0] ? gone[0].id : '' });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Page dialogs
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Answer the dialog the page is blocked on.
   *
   * `accept` maps to OK, anything else to Cancel; `text` is the prompt's value.
   * MEASURED: `accept('typed value')` really delivers that string to the page's
   * `window.prompt`, and `accept()` makes `window.confirm` return true — so the
   * UI's OK/Cancel buttons mean exactly what they say.
   *
   * Errors are swallowed deliberately: a dialog whose page has since navigated
   * away can no longer be answered, and the only thing that matters then is
   * that we stop believing one is pending.
   */
  async answerDialog(accept: boolean, text = ''): Promise<void> {
    this.touch();
    const dialog = this.pendingDialog;
    this.pendingDialog = null;
    if (!dialog) return;
    const kind = dialog.type();
    try {
      if (accept) await dialog.accept(String(text || ''));
      else await dialog.dismiss();
    } catch { /* the page moved on; nothing left to answer */ }
    this.emit('dialogDone', { kind, accepted: !!accept });

    // A beforeunload we raised because the USER asked to close the tab: OK means
    // "leave", so the close they wanted now goes through. Cancel means "stay",
    // and the tab must survive — which is the behaviour the mandate asked for
    // ("beforeunload on tab close must ASK, not silently close").
    if (kind === 'beforeunload' && this.closingTabId) {
      const id = this.closingTabId;
      this.closingTabId = '';
      if (accept) await this.closeTab(id, { force: true });
      else this.emit('tabCloseCancelled', { id });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // HTTP basic auth
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Intercept 401s on this page so the credentials prompt becomes answerable.
   *
   * The interception is deliberately narrow. `Fetch.enable` with a pattern
   * means every matching request is PAUSED until we continue it, which is a
   * latency tax on the whole page and a hang risk if we ever fail to answer.
   * Measured cost: `'*'` = 8 pauses on one page, Document-only = 1, and the auth
   * event arrived either way. So Document-only, and every non-auth pause is
   * continued immediately and unconditionally.
   *
   * Its own CDP session, not the screencast one: the screencast session is torn
   * down and rebuilt on every tab switch, and auth must keep working on a
   * background tab that is still loading.
   */
  private async installAuthHandler(page: Page): Promise<void> {
    if (!this.context) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      this.authCdp.set(page, cdp);

      cdp.on('Fetch.requestPaused', (ev: { requestId: string }) => {
        // Not an auth pause: let it through at once. A paused request the user
        // is waiting on is indistinguishable from a hung server.
        void cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
      });

      cdp.on('Fetch.authRequired', (ev: {
        requestId: string;
        request: { url: string };
        authChallenge: { origin?: string; realm?: string; scheme?: string; source?: string };
      }) => {
        const proxy = ev.authChallenge && ev.authChallenge.source === 'Proxy';
        this.pendingAuth = { cdp, requestId: ev.requestId, page };
        const tab = this.tabOfPage(page);
        // The UI needs the origin and the realm to be honest about WHO is asking.
        // "Enter your password" with no indication of the site is exactly the
        // kind of prompt a person should refuse to answer.
        this.emit('authRequired', {
          origin: (ev.authChallenge && ev.authChallenge.origin) || originOf(ev.request.url),
          realm: (ev.authChallenge && ev.authChallenge.realm) || '',
          scheme: (ev.authChallenge && ev.authChallenge.scheme) || 'basic',
          proxy: !!proxy,
          url: ev.request.url,
          tabId: tab ? tab.id : this.activeId,
        });
      });

      await cdp.send('Fetch.enable', {
        handleAuthRequests: true,
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      });

      // A page that closes takes its CDP session with it; drop the reference so
      // the map does not grow one dead session per tab for the life of the
      // session.
      page.once('close', () => {
        this.authCdp.delete(page);
        if (this.pendingAuth && this.pendingAuth.page === page) this.pendingAuth = null;
      });
    } catch (e) {
      // Auth interception is an enhancement, not a precondition: a page that
      // cannot get it still works for everything that is not a 401. Failing
      // `attachPage` over this would break tab creation itself.
      //
      // But it must not fail INVISIBLY. MEASURED 2026-08-03: when this threw,
      // the only symptom was that a 401 produced no prompt at all — the site
      // was simply unreachable and nothing anywhere said why. Report it.
      this.emit('error', {
        message: 'auth_interception_unavailable',
        detail: ((e as Error)?.message || String(e)).slice(0, 300),
      });
    }
  }

  /**
   * Answer the credentials prompt.
   *
   * Cancel is `CancelAuth`, which is what makes Chrome show the server's own 401
   * body instead of hanging — a user who does not have the password must still
   * get a page, not a spinner.
   */
  async answerAuth(accept: boolean, username = '', password = ''): Promise<void> {
    this.touch();
    const pending = this.pendingAuth;
    this.pendingAuth = null;
    if (!pending) return;
    try {
      await pending.cdp.send('Fetch.continueWithAuth', {
        requestId: pending.requestId,
        authChallengeResponse: accept
          ? { response: 'ProvideCredentials', username: String(username || ''), password: String(password || '') }
          : { response: 'CancelAuth' },
      });
    } catch { /* the request was abandoned; nothing left to answer */ }
    // Never echo the password back, not even a length.
    this.emit('authDone', { accepted: !!accept });
  }

  /**
   * Fail-safe: cancel any auth challenge still waiting.
   *
   * Same reasoning as `drainDialog`: a paused request holds its page, and a page
   * that is held cannot be closed cleanly.
   */
  private async drainAuth(): Promise<void> {
    const pending = this.pendingAuth;
    this.pendingAuth = null;
    if (!pending) return;
    try {
      await pending.cdp.send('Fetch.continueWithAuth', {
        requestId: pending.requestId,
        authChallengeResponse: { response: 'CancelAuth' },
      });
    } catch { /* already gone */ }
  }

  /**
   * Fail-safe: answer anything still pending.
   *
   * Called before teardown and before a recovery. A dialog left unanswered
   * blocks its page forever, and since a blocked page also cannot be closed
   * cleanly, forgetting this would turn one unanswered prompt into a leaked
   * Chrome tab that nothing can collect.
   */
  private async drainDialog(): Promise<void> {
    const dialog = this.pendingDialog;
    this.pendingDialog = null;
    if (!dialog) return;
    try { await dialog.dismiss(); } catch { /* already gone */ }
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
    if (this.audioTimer) { clearInterval(this.audioTimer); this.audioTimer = null; }
    // MEASURED (tools/probe-cdp3.js): a page blocked on an unanswered dialog
    // cannot even be closed — `page.title()` timed out and the close hung. So the
    // dialog is answered FIRST, or this teardown leaks a Chrome tab that nothing
    // will ever collect.
    await this.drainDialog();
    await this.drainAuth();
    this.authCdp.clear();
    // Save the strip BEFORE anything is torn down. This is the whole point of
    // "show me my tabs when the browser comes up": the list has to be written on
    // the way out, including when the way out is an idle timeout rather than the
    // user clicking Close.
    //
    // `this.closed` is already true, so `persistTabs()` would refuse — the write
    // is done inline for that reason.
    //
    // But it honours the same freeze, and it has to: closing the window while a
    // recovery is still in flight (which is precisely what a frightened user
    // does when Chrome has just restarted under them) would otherwise write the
    // half-rebuilt list over the good one, and the on-disk list is at that
    // moment strictly better than anything in memory. Skipping the write keeps
    // it — see `tabsFrozen`.
    try {
      if (!this.tabsFrozen) {
        const list: SavedTab[] = this.tabs
          .filter((t) => !t.dead)
          .map((t) => ({
            url: t.url,
            title: t.title,
            ...(t.id === this.activeId ? { active: true } : {}),
          }));
        await saveTabs(this.userId, list);
      }
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

  /**
   * "We never lose a tab."
   *
   * Relaunching real Chrome destroys every page inside it, including the ones
   * these sessions are streaming. Nothing about the WebSocket changes, so
   * without this the user is left staring at a perfectly good last frame of a
   * page whose browser no longer exists — connected, unbroken-looking, and
   * completely dead. That is the single worst state in this whole system,
   * because there is nothing on screen to tell them to do anything about it.
   *
   * So whoever relaunches Chrome calls this immediately afterwards, and every
   * live session rebuilds itself onto the new browser with its tab list intact.
   * `resync()` is the existing, tested path for exactly this: it finds the
   * context dead, builds a fresh one, marks every tab `pending`, reloads the
   * active one and re-arms the screencast — reporting `recovering` then
   * `recovered` over each session's own socket, so each client narrates its own
   * repair.
   *
   * Failures are swallowed PER SESSION on purpose: one user's page that refuses
   * to come back must not stop everyone else's from being rebuilt.
   */
  async rebuildAll(): Promise<number> {
    const all = Array.from(this.sessions.values());
    const results = await Promise.all(
      all.map((s) => s.resync().then(() => true).catch(() => false)),
    );
    return results.filter(Boolean).length;
  }
}
