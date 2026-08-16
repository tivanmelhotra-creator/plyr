import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════
// extension/popup/popup.js — the Inspect panel's destination + pairing.
//
// WHAT CHANGED, AND WHY IT NEEDS DEFENDING
//
// The Inspect panel used to show a `sessionId`. That has been replaced by the
// DESTINATION — the node and field a pick actually lands in — plus the one-time
// pairing box that establishes it. Two things must hold, and neither is visible
// by reading the file:
//
//  1. The popup must never name a target itself (§8). The destination is decided
//     by the CODE, server-side. A popup that could send a targetFieldId would be
//     a way to aim a pick at a field the user never offered.
//
//  2. The three states — connected / connected-but-field-closed / never
//     connected — must stay distinguishable, because each needs a DIFFERENT
//     action from the user. Collapsing the middle into "not connected" is the
//     tempting simplification and it sends the user to fix the wrong thing.
//
// Also guarded: the Handoff panel's OWN session line (`hoSession`) is a
// different subsystem and must survive untouched — removing the Inspector's
// session id must not take Handoff's with it.
//
// HOW: popup.js runs in a `vm` sandbox against a fake DOM built from the ids
// declared in the shipped popup.html, with chrome.runtime.sendMessage faked so
// backend replies can be scripted. Assertions read the RENDERED TEXT and the
// SENT MESSAGES, never popup.js internals.
// ════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'extension/popup/popup.html'), 'utf8');
const JS = readFileSync(resolve(ROOT, 'extension/popup/popup.js'), 'utf8');
const CORE = readFileSync(resolve(ROOT, 'extension/lib/ab-core.js'), 'utf8');

class El {
  id: string;
  tagName = 'DIV';
  textContent = '';
  className = '';
  value = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  childNodes: El[] = [];
  listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(id = '') { this.id = id; }
  /**
   * popup.js drives some buttons through classList.toggle. Without this the
   * controller rejects during load — and vitest is right to call that a
   * false-positive risk rather than noise, because a controller that died
   * half-way through init could leave assertions passing on state that a real
   * popup would never reach.
   */
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
  appendChild(c: El) { this.childNodes.push(c); return c; }
  removeChild(c: El) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    return c;
  }
  get firstChild() { return this.childNodes[0] || null; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  focus() {}
  click() { this.fire('click'); }
  fire(t: string, evt: Record<string, unknown> = {}) {
    (this.listeners[t] || []).slice().forEach((fn) => fn({
      preventDefault() {}, stopPropagation() {}, target: this, ...evt,
    }));
  }
}

interface SentMessage { type?: string; payload?: Record<string, unknown> }

/** A scripted reply queue, keyed by message type. */
type Replies = Record<string, unknown | ((msg: SentMessage) => unknown)>;

interface Harness {
  el(id: string): El;
  text(id: string): string;
  cls(id: string): string;
  hidden(id: string): boolean;
  sent: SentMessage[];
  sentOf(type: string): SentMessage[];
  replies: Replies;
  /** Re-run the panel refresh, e.g. after changing the scripted replies. */
  refresh(quiet?: boolean): Promise<void>;
  /** Wait for popup.js's async handlers to settle. */
  settle(): Promise<void>;
}

/** The ids the shipped popup.html declares — the fake DOM mirrors exactly these. */
function htmlIds(): string[] {
  return Array.from(new Set(
    (HTML.match(/\sid="([A-Za-z0-9_-]+)"/g) || []).map((m) => m.replace(/\sid="|"$/g, '')),
  ));
}

function boot(replies: Replies = {}): Harness {
  const nodes = new Map<string, El>();
  htmlIds().forEach((id) => nodes.set(id, new El(id)));

  const sent: SentMessage[] = [];
  const scripted: Replies = {
    // Sensible defaults; individual tests override.
    AB_INSPECTOR_SESSION: { ok: false, error: 'no_base_url' },
    ...replies,
  };

  const documentFake = {
    getElementById: (id: string) => nodes.get(id) || null,
    createElement: (tag: string) => { const e = new El(); e.tagName = tag.toUpperCase(); return e; },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [] as El[],
    querySelector: () => null,
    body: new El('body'),
  };

  const storage: Record<string, unknown> = {};
  const chromeFake = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: SentMessage, cb?: (r: unknown) => void) => {
        sent.push(msg);
        const r = scripted[String(msg.type)];
        const value = typeof r === 'function' ? (r as (m: SentMessage) => unknown)(msg) : r;
        if (cb) cb(value === undefined ? { ok: true } : value);
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: (keys: unknown, cb: (v: Record<string, unknown>) => void) => cb(storage),
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

  const windowFake: Record<string, unknown> = { close: () => {} };
  const sandbox: Record<string, unknown> = {
    window: windowFake,
    document: documentFake,
    chrome: chromeFake,
    location: { href: 'chrome-extension://x/popup.html' },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console,
    Promise,
  };
  sandbox.globalThis = sandbox;
  windowFake.window = windowFake;
  windowFake.document = documentFake;
  windowFake.chrome = chromeFake;

  vm.createContext(sandbox);
  // The real ab-core.js, so the pairing-code validator under test is the one
  // that actually ships — not a stand-in that might accept different input.
  vm.runInContext(CORE, sandbox);
  vm.runInContext(JS, sandbox);

  const el = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw new Error(`popup.html declares no id "${id}"`);
    return n;
  };

  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  return {
    el,
    text: (id: string) => el(id).textContent,
    cls: (id: string) => el(id).className,
    hidden: (id: string) => el(id).hidden,
    sent,
    sentOf: (type: string) => sent.filter((m) => m.type === type),
    replies: scripted,
    async refresh() { el('inspRefresh').fire('click'); await settle(); },
    settle,
  };
}

/** A session reply describing one open field this extension IS connected to. */
function connected(over: Record<string, unknown> = {}) {
  const target = {
    targetFieldId: 'node_n1__url__a1b2c3d4',
    nodeId: 'n1', fieldKey: 'url', action: 'http_request',
    label: 'HTTP Request → url', registeredAt: Date.now(),
  };
  return {
    ok: true,
    targetFieldId: target.targetFieldId,
    authorized: true,
    target,
    data: {
      success: true, mode: 'remote', modes: ['remote', 'local'], localAvailable: false,
      targets: [target], authorized: [{ targetFieldId: target.targetFieldId }], pending: 0,
    },
    ...over,
  };
}

describe('popup: the harness runs the real controller', () => {
  it('loads without throwing and reaches the real backend seam', async () => {
    // popup.js resolves every id eagerly with no null guards, so merely booting
    // is a meaningful assertion: one missing id blanks the whole popup.
    const h = boot();
    await h.settle();
    expect(h.sentOf('AB_INSPECTOR_SESSION').length).toBeGreaterThan(0);
  });
});

describe('popup: the Inspector shows a DESTINATION, not a session id', () => {
  it('names the node and the field separately, as the user chose them', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    // Two lines rather than one string, because the user picked a NODE and then
    // a FIELD, and the two are what they will compare against the project.
    expect(h.text('inspNodeName')).toBe('http_request');
    expect(h.text('inspFieldName')).toBe('url');
  });

  it('shows the exact server-minted Field ID, and only in the id line', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    // The id IS the destination, so it must be visible for confirmation — but it
    // is unreadable, so it must not be what NAMES the destination.
    expect(h.text('inspFieldId')).toBe('node_n1__url__a1b2c3d4');
    expect(h.text('inspNodeName')).not.toMatch(/a1b2c3d4/);
    expect(h.text('inspFieldName')).not.toMatch(/a1b2c3d4/);
    // Same field, same value, on the Connection tab: the two tabs must never
    // disagree about where a send would land.
    expect(h.text('ctFieldId')).toBe('node_n1__url__a1b2c3d4');
  });

  it('falls back to action → field when no label was registered', async () => {
    const r = connected();
    delete (r.target as Record<string, unknown>).label;
    (r.data.targets[0] as Record<string, unknown>).label = undefined;
    const h = boot({ AB_INSPECTOR_SESSION: r });
    await h.settle();
    expect(h.text('inspNode')).toBe('http_request → url');
  });

  it('never displays a session id anywhere in the popup', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    // A Target Field survives a session change and a Local/Remote switch
    // precisely because it is not a session. Showing one here would invite the
    // user to treat it as the thing identifying their destination.
    ['inspTarget', 'inspNode', 'inspStatus', 'ctState', 'connState'].forEach((id) => {
      expect(h.text(id)).not.toMatch(/\b(ui|ext|as)-[a-z0-9]/i);
    });
  });
});

describe('popup: the three connection states stay distinguishable', () => {
  it('connected: says picks are ready, and offers Disconnect', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    expect(h.text('inspTarget')).toMatch(/connected to this field/i);
    expect(h.cls('inspTarget')).toContain('ok');          // the "good" tint
    expect(h.hidden('inspUnpair')).toBe(false);
    // The Connection tab must reach the same verdict from the same reply.
    expect(h.text('connAuth')).toBe('Valid');
    await h.refresh();   // init is deliberately quiet; the user pressing ↻ is not
    expect(h.text('inspStatus')).toMatch(/ready/i);
    expect(h.text('inspStatus')).toContain('HTTP Request → url');
  });

  it('never connected: asks for a code, and hides Disconnect', async () => {
    const r = connected({ targetFieldId: '', authorized: false, target: null });
    const h = boot({ AB_INSPECTOR_SESSION: r });
    await h.settle();
    expect(h.text('inspTarget')).toMatch(/not connected/i);
    expect(h.hidden('inspUnpair')).toBe(true);
    await h.refresh();
    expect(h.text('inspStatus')).toMatch(/Authorization Code/i);
  });

  it('paired but the field has closed: says THAT, not "not connected"', async () => {
    // The distinction that matters: the pairing is fine, the destination is
    // gone. Reporting "not connected" would send the user hunting for a code
    // when what they need is to re-open or re-connect the field.
    const r = connected({ authorized: false, target: null });
    (r.data as Record<string, unknown>).targets = [{
      targetFieldId: 'node_other__body__ffff0000', nodeId: 'other',
      fieldKey: 'body', action: 'http_request', label: 'Other → body',
    }];
    const h = boot({ AB_INSPECTOR_SESSION: r });
    await h.settle();
    expect(h.text('inspTarget')).toMatch(/no longer open/i);
    await h.refresh();
    expect(h.text('inspStatus')).toMatch(/no longer open/i);
    expect(h.text('inspStatus')).not.toMatch(/^not connected/i);
    // Still offers Disconnect, because a stale pairing is a thing to clear.
    expect(h.hidden('inspUnpair')).toBe(false);
  });

  it('no fields open at all: points at the project, not at the code box', async () => {
    const r = connected({ targetFieldId: '', authorized: false, target: null });
    (r.data as Record<string, unknown>).targets = [];
    const h = boot({ AB_INSPECTOR_SESSION: r });
    await h.settle();
    expect(h.text('inspNode')).toMatch(/no fields open/i);
    await h.refresh();
    expect(h.text('inspStatus')).toMatch(/open a node/i);
  });

  it('reports how many fields are open when there are several', async () => {
    const r = connected();
    (r.data as Record<string, unknown>).targets = [
      { targetFieldId: 'a', nodeId: 'n1', fieldKey: 'url', action: 'http_request', label: 'A → url' },
      { targetFieldId: 'b', nodeId: 'n2', fieldKey: 'body', action: 'http_request', label: 'B → body' },
    ];
    const h = boot({ AB_INSPECTOR_SESSION: r });
    await h.settle();
    // Several destinations coexisting is normal, so the panel must not imply
    // there is only ever one.
    expect(h.text('inspNode')).toBe('2 fields open');
  });
});

describe('popup: pairing is by CODE only (§8)', () => {
  it('sends only the code — never a target of its own choosing', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, targetFieldId: 'node_n1__url__a1b2c3d4', target: { label: 'HTTP Request → url' } },
    });
    await h.settle();

    h.el('inspCode').value = 'ABCD-EFGH';
    h.el('connect').fire('click');
    await h.settle();

    const pair = h.sentOf('AB_INSPECTOR_PAIR');
    expect(pair).toHaveLength(1);
    // The whole point: a targetFieldId here would let the extension aim at a
    // field the user never offered.
    expect(Object.keys(pair[0]!.payload || {})).toEqual(['code']);
    expect((pair[0]!.payload as Record<string, unknown>).code).toMatch(/ABCD-?EFGH/);
  });

  it('names the field it connected to, rather than just "connected"', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, target: { label: 'HTTP Request → url' } },
    });
    await h.settle();
    h.el('inspCode').value = 'ABCDEFGH';
    h.el('connect').fire('click');
    await h.settle();
    // Otherwise the user has to trust that the code pointed where they thought.
    expect(h.text('inspPairStatus')).toContain('HTTP Request → url');
    expect(h.cls('inspPairStatus')).toContain('ok');
  });

  it('refuses a malformed code locally, without a round trip', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }) });
    await h.settle();
    h.el('inspCode').value = 'nope';
    h.el('connect').fire('click');
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_PAIR')).toHaveLength(0);
    expect(h.cls('inspPairStatus')).toContain('bad');
    expect(h.text('inspPairStatus')).toMatch(/8-character/i);
  });

  it('shows the backend\'s specific refusal verbatim', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: {
        ok: false, reason: 'AUTHORIZATION_EXPIRED',
        error: 'That authorization code has expired. Ask for a new one.',
      },
    });
    await h.settle();
    h.el('inspCode').value = 'ABCDEFGH';
    h.el('connect').fire('click');
    await h.settle();

    // "expired" and "invalid" call for different actions, so a generic failure
    // message would cost the user the right next step.
    expect(h.text('inspPairStatus')).toMatch(/expired/i);
    expect(h.cls('inspPairStatus')).toContain('bad');
  });

  it('re-enables the button after a refusal so the code can be retried', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: false, reason: 'INVALID_AUTHORIZATION_CODE', error: 'No.' },
    });
    await h.settle();
    h.el('inspCode').value = 'ABCDEFGH';
    h.el('connect').fire('click');
    await h.settle();
    expect(h.el('connect').disabled).toBe(false);
  });

  it('clears the box after success, so a spent code cannot be re-sent', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, target: { label: 'HTTP Request → url' } },
    });
    await h.settle();
    h.el('inspCode').value = 'ABCDEFGH';
    h.el('connect').fire('click');
    await h.settle();
    // The code is one-time; leaving it on screen invites a second, failing try.
    expect(h.el('inspCode').value).toBe('');
  });

  it('re-reads the destination after pairing instead of trusting itself', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, target: { label: 'HTTP Request → url' } },
    });
    await h.settle();
    const before = h.sentOf('AB_INSPECTOR_SESSION').length;

    h.el('inspCode').value = 'ABCDEFGH';
    h.el('connect').fire('click');
    await h.settle();

    // The server is the authority on what this key may write to; a locally
    // assumed success could show a destination that does not exist.
    expect(h.sentOf('AB_INSPECTOR_SESSION').length).toBeGreaterThan(before);
  });

  it('submits on Enter, because the code is pasted and it expires', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, target: { label: 'X → y' } },
    });
    await h.settle();
    h.el('inspCode').value = 'ABCDEFGH';
    h.el('inspCode').fire('keydown', { key: 'Enter' });
    await h.settle();
    expect(h.sentOf('AB_INSPECTOR_PAIR')).toHaveLength(1);
  });

  it('formats the code as it is typed, without changing what is sent', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, target: null },
    });
    await h.settle();
    h.el('inspCode').value = 'abcdefgh';
    h.el('inspCode').fire('input');
    // Cosmetic grouping only — the server normalises separators away.
    expect(h.el('inspCode').value).toBe('ABCD-EFGH');
  });
});

describe('popup: disconnecting', () => {
  it('is a local action that then re-reads the truth from the server', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_INSPECTOR_UNPAIR: { ok: true } });
    await h.settle();
    const before = h.sentOf('AB_INSPECTOR_SESSION').length;

    h.el('inspUnpair').fire('click');
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_UNPAIR')).toHaveLength(1);
    expect(h.sentOf('AB_INSPECTOR_SESSION').length).toBeGreaterThan(before);
  });

  it('tells the user how to get back, not just that it happened', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_INSPECTOR_UNPAIR: { ok: true } });
    await h.settle();
    h.el('inspUnpair').fire('click');
    await h.settle();
    expect(h.text('inspPairStatus')).toMatch(/new code/i);
  });

  it('carries no target id when disconnecting', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_INSPECTOR_UNPAIR: { ok: true } });
    await h.settle();
    h.el('inspUnpair').fire('click');
    await h.settle();
    const msg = h.sentOf('AB_INSPECTOR_UNPAIR')[0]!;
    expect(msg.payload).toBeUndefined();
  });
});

describe('popup: the Handoff subsystem is left alone', () => {
  // WHY THESE TESTS CHANGED SHAPE
  // -----------------------------
  // They used to prove Handoff survived by reading the popup's OWN handoff
  // lines (#hoSession, #hoState). The popup no longer has any: the Local tab
  // was one UI for Session Handoff, and it has been removed so the popup can be
  // exactly two tabs.
  //
  // The invariant they were protecting did NOT change — «حذف تب ≠ حذف قابلیت».
  // What changed is where it can honestly be observed. Re-pointing them at
  // #hoSession would have meant re-adding a handoff line to the popup purely to
  // keep a test green, which is the tail wagging the dog. So each one now
  // checks the same property at the place that actually owns it, and the pair
  // of "does not disturb" tests keep running through the real controller,
  // because that is still exactly where an accidental cross-effect would occur.

  it('the Inspector never speaks for the Handoff subsystem', async () => {
    // The strongest form of "left alone" this popup can demonstrate: booting it
    // and driving a full pair+unpair emits no handoff traffic whatsoever. It
    // cannot disturb a subsystem it never addresses.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }),
      AB_INSPECTOR_PAIR: { ok: true, target: { label: 'X → y' } },
      AB_INSPECTOR_UNPAIR: { ok: true },
    });
    await h.settle();
    h.el('inspCode').value = 'ABCDEFGH';
    h.el('connect').fire('click');
    await h.settle();
    h.el('inspUnpair').fire('click');
    await h.settle();

    const handoff = h.sent.filter((m) => String(m.type || '').startsWith('AB_HANDOFF'));
    expect(handoff).toEqual([]);
    // And it definitely did do the inspector work, so the emptiness above is
    // "sent nothing about handoff", not "sent nothing at all".
    expect(h.sentOf('AB_INSPECTOR_PAIR')).toHaveLength(1);
    expect(h.sentOf('AB_INSPECTOR_UNPAIR')).toHaveLength(1);
  });

  it('the background worker still answers every handoff message', () => {
    // Where the capability actually lives now. The popup stopped SENDING these;
    // the worker must not stop HANDLING them, because it is the only path from
    // the extension to /browser-mode/handoff/*.
    const bgSrc = readFileSync(resolve(ROOT, 'extension/background.js'), 'utf8');
    for (const type of ['AB_HANDOFF_PAIR', 'AB_HANDOFF_APPLY', 'AB_HANDOFF_STATUS', 'AB_HANDOFF_UNPAIR']) {
      expect(bgSrc, `${type} must still be handled`).toContain(`case '${type}':`);
    }
    // The client library the worker delegates to must still be there too.
    expect(existsSync(resolve(ROOT, 'extension/lib/ab-handoff.js'))).toBe(true);
  });

  it("the handoff keeps its own `as_…` session id, which was never the Inspector's", () => {
    // Two independent namespaces. Removing the Inspector's session id must not
    // take the Handoff's with it — the handoff genuinely MOVES a session, so an
    // `as_…` is the correct thing for it to carry, and it still does.
    const handoffLib = readFileSync(resolve(ROOT, 'extension/lib/ab-handoff.js'), 'utf8');
    expect(handoffLib).toMatch(/sessionId/);
  });

  it('the web app still drives the handoff itself, so it kept a real user', () => {
    // This is the fact that makes "exactly two tabs" and "handoff survives"
    // non-contradictory rather than a compromise: switching a session between
    // Remote and Local is done from the app, and never needed this popup.
    const appUi = readFileSync(resolve(ROOT, 'public/js/browser-handoff.js'), 'utf8');
    expect(appUi).toContain('/browser-mode/handoff/start');
    expect(appUi).toContain('/browser-mode/handoff/complete');
    expect(readFileSync(resolve(ROOT, 'public/index.html'), 'utf8')).toContain('/js/browser-handoff.js');
  });
});

describe('popup: an unreachable or unconfigured project', () => {
  it('says what to fix rather than showing a bare failure', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: { ok: false, error: 'no_api_key' } });
    await h.settle();
    h.el('inspRefresh').fire('click');
    await h.settle();
    expect(h.text('inspStatus')).toMatch(/api key/i);
  });

  it('still reports the connection state it knows locally', async () => {
    // The pairing lives in the extension, so it is knowable even when the
    // project cannot be reached — and saying so beats a row of dashes.
    const h = boot({
      AB_INSPECTOR_SESSION: { ok: false, error: 'unreachable', targetFieldId: 'node_n1__url__a1b2c3d4' },
    });
    await h.settle();
    expect(h.hidden('inspUnpair')).toBe(false);
    expect(h.text('inspTarget')).not.toBe('—');
  });
});

// ════════════════════════════════════════════════════════════════
// BROWSER ENVIRONMENT and the DURABLE PAIRING.
//
// Two facts the popup could not previously express, both required by the
// operator's correction:
//
//   1. WHICH BROWSER the field is being targeted in. The Connection tab already
//      shows a "local / remote" pair, but that one is derived from whether the
//      Base URL is loopback — where the SERVER is. Reading it as the browser
//      environment is exactly the conflation the requirement forbids:
//
//        Browser Environment = LOCAL / REMOTE
//        Session / Handoff   = infrastructure only
//        targetFieldId       = the data destination
//
//   2. Whether the pairing is DURABLE. "Connected" tracks the ADDRESS, which is
//      re-minted on every NDV open and expires in hours. The operator's actual
//      question — «دفعات بعد ... دیگر نیازی به Authorization Code جدید نیست» —
//      is about the pairing, which lasts for days and survives those re-opens.
//      Reporting only the address made a live pairing look absent.
//
// These assertions read the RENDERED TEXT, so they describe what the operator
// is told, not how popup.js is written.
// ════════════════════════════════════════════════════════════════
describe('popup: Browser Environment', () => {
  it('names the LOCAL browser in full, on both cards', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected({ environment: 'local' }) });
    await h.settle();
    // "Local Browser", not a bare "local": the word Browser is what keeps it
    // from being read as the backend-location setting shown just above.
    expect(h.text('inspEnv')).toBe('Local Browser');
    expect(h.text('ctEnv')).toBe('Local Browser');
  });

  it('names the REMOTE browser in full, on both cards', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected({ environment: 'remote' }) });
    await h.settle();
    expect(h.text('inspEnv')).toBe('Remote Browser');
    expect(h.text('ctEnv')).toBe('Remote Browser');
  });

  it('shows a dash rather than guessing when the environment is unknown', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    expect(h.text('inspEnv')).toBe('\u2014');
    expect(h.cls('inspEnv')).toContain('none');
  });

  it('the two cards can never disagree', async () => {
    // They are painted from one value in one function precisely so that a
    // targeting environment cannot be reported two different ways.
    for (const env of ['local', 'remote']) {
      const h = boot({ AB_INSPECTOR_SESSION: connected({ environment: env }) });
      await h.settle();
      expect(h.text('inspEnv')).toBe(h.text('ctEnv'));
    }
  });
});

describe('popup: the durable pairing', () => {
  it('states that no code will be needed next time', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'local', paired: true }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/no code needed/i);
    expect(h.cls('ctPairing')).toContain('ok');
  });

  it('warns that a code WILL be requested when the field is not paired', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'local', paired: false }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/code will be requested/i);
  });

  it('says a pairing is not required at all for the Remote Browser', async () => {
    // REMOTE never issues a code, so claiming either "paired" or "not paired"
    // would describe a pairing that does not exist.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'remote', paired: false }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/not required/i);
  });

  it('survives the address going stale — the point of the split', async () => {
    // The node was re-opened, so the ADDRESS this extension holds is no longer
    // live (`authorized: false`, no `target`). The PAIRING is untouched, and
    // the operator must be told so: this is the exact state in which the old
    // popup wrongly implied another code was coming.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({
        environment: 'local', paired: true, authorized: false, target: null,
      }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/no code needed/i);
    // …while the connection line still reports the address honestly.
    expect(h.text('ctState')).not.toMatch(/no code needed/i);
  });
});
