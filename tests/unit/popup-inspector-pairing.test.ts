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
  attrs: Record<string, string> = {};
  // Captured rather than discarded: the Browser Environment cards identify
  // themselves with data-env, and a test that matched on their human-readable
  // label instead would keep passing if the wiring behind the label broke.
  setAttribute(k: string, v: string) { this.attrs[String(k)] = String(v); }
  getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[String(k)]; }
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

  // Enough ticks to drain the DEEPEST await chain the controller has, not just
  // the shallowest. Choosing a browser environment is
  //   click -> AB_TARGETING_BEGIN -> refreshInspector -> AB_INSPECTOR_SESSION
  //         -> paintEnvironment -> AB_TARGETING_OPTIONS -> render
  // and at 8 ticks that chain was still mid-flight when assertions ran, so a
  // status line the real popup does display looked absent. A budget that is too
  // small produces exactly the false failure that tempts someone to "fix"
  // working code, so it is generous on purpose.
  const settle = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };

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

/**
 * A session reply describing one open field this extension IS connected to.
 *
 * `targetEnv` stamps the OPEN TARGET's own environment, and it is a second
 * argument rather than part of `over` because the two are different facts that
 * the popup reads in a specific order:
 *
 *   over.environment  → res.environment, the SESSION's environment. Non-empty
 *                       only once this extension is bound to the field, because
 *                       background.js derives it from `res.target`, and that is
 *                       null until a destination is stored.
 *   targetEnv         → the environment recorded ON the open field itself.
 *
 * WHY THE SECOND ONE HAD TO EXIST. TargetFieldRegistry.register() writes an
 * `environment` on every target it creates — it is coerced, never omitted (see
 * normalizeBrowserEnvironment) — and /inspector/targeting/begin registers the
 * field BEFORE it branches on the environment. So by the time a REMOTE begin
 * answers, the server is already listing an open target stamped `remote`.
 *
 * This fixture omitted it, which made it describe a server that cannot exist,
 * and that difference was not cosmetic: on the REMOTE path nothing is stored
 * until the code is redeemed, so `res.target` is null, `res.environment` is
 * empty, and the ONLY carrier of "which browser did the operator just choose"
 * is the open target's own stamp. A fixture without it tested the one code path
 * that never runs, and it did so at the exact moment the operator is waiting
 * for the code box.
 */
function connected(over: Record<string, unknown> = {}, targetEnv = '') {
  const target = {
    targetFieldId: 'node_n1__url__a1b2c3d4',
    nodeId: 'n1', fieldKey: 'url', action: 'http_request',
    label: 'HTTP Request → url', registeredAt: Date.now(),
    ...(targetEnv ? { environment: targetEnv } : {}),
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
    // WAS 'Valid', which described a CODE the user had entered. The row is
    // labelled "Field access" now and reports whether this Inspector may write
    // to the field it is pointed at — a question about the binding, not about a
    // credential.
    expect(h.text('connAuth')).toBe('Allowed');
    await h.refresh();   // init is deliberately quiet; the user pressing ↻ is not
    expect(h.text('inspStatus')).toMatch(/ready/i);
    expect(h.text('inspStatus')).toContain('HTTP Request → url');
  });

  it('never connected: points at the crosshair, and hides Disconnect', async () => {
    // WAS 'asks for a code'. The popup has nothing to ask for: the binding is
    // made by the server when the crosshair is used. So the unbound state must
    // name where the action IS — on the field, in the project — rather than
    // sending the user to a Connection tab that no longer has an input.
    const r = connected({ targetFieldId: '', authorized: false, target: null });
    const h = boot({ AB_INSPECTOR_SESSION: r });
    await h.settle();
    expect(h.text('inspTarget')).toMatch(/not bound/i);
    expect(h.text('inspTarget')).toMatch(/target the field from the project/i);
    expect(h.hidden('inspUnpair')).toBe(true);
    await h.refresh();
    expect(h.text('inspStatus')).toMatch(/crosshair on the field/i);
    // And it must not resurrect the vocabulary of the deleted flow.
    expect(h.text('inspStatus')).not.toMatch(/Authorization Code/i);
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
    // `paired` in the popup is derived from res.targetFieldId — the ADDRESS the
    // worker reported — so the reply must still carry one for this state to be
    // reachable at all: a binding whose field has since closed.
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

// ═════════════════════════════════════════════════════════════
// §8 — THE POPUP CANNOT ESTABLISH A BINDING AT ALL.
//
// WHAT THIS DESCRIBE USED TO BE
// ----------------------------
// Nine tests drove a one-time Authorization Code: type it into #inspCode,
// press #connect, watch AB_INSPECTOR_PAIR go out, read the outcome from
// #inspPairStatus. They existed to defend one property — the popup must never
// name a target of its OWN choosing, because a popup that could send a
// targetFieldId would be a way to aim a pick at a field the user never offered.
//
// WHY IT IS REPLACED RATHER THAN REPAIRED
// --------------------------------------
// The Authorization Code architecture is gone. LOCAL binds silently, on the
// server, when the crosshair is pressed; REMOTE binds when the operator
// approves the request in the project. There is no code, no box to type it in,
// no button to submit it, and background.js no longer handles the message.
//
// So the property is not merely still true — it is now true by CONSTRUCTION,
// which is a stronger statement than "the one control we gave it behaves". A
// repaired version of these tests could only have asserted that a deleted
// control is deleted nine times over. These four assert the property itself:
// there is no input, no submit path, no message, and no code vocabulary left —
// and, critically, that the popup still cannot aim itself even though the
// server now does the aiming.
// ═════════════════════════════════════════════════════════════
describe('popup: the binding is not the popup\'s to make (§8)', () => {
  it('offers nothing to type a code into, and nothing to submit one with', () => {
    // Read off the SHIPPED markup, so this fails if the form is ever restored —
    // including by someone re-adding it "just for local testing".
    for (const id of ['inspCode', 'inspPairStatus', 'connect', 'baseUrl', 'apiKey']) {
      expect(HTML, `#${id} must not come back`).not.toContain(`id="${id}"`);
    }
  });

  it('sends AB_INSPECTOR_PAIR only when the operator submits a code, never on its own', async () => {
    // WHAT THIS TEST USED TO PROVE, AND WHY THE WEAKER-LOOKING VERSION IS
    // ACTUALLY THE STRONGER ONE.
    //
    // It used to assert the message is never sent at all, and that the worker
    // would not even answer it. That was the correct guard for a system in which
    // both environments were the server's own browser, because then nothing
    // anywhere had a code to redeem. Under the corrected naming REMOTE is the
    // operator's own machine, and redemption is the ONLY act that can prove a
    // browser the server has never seen belongs here.
    //
    // So "never sent" is no longer available, and the property that mattered is
    // restated precisely: the popup does not pair SPONTANEOUSLY. Refresh,
    // Release — every control that is not the credential form — must leave the
    // pair channel silent, because a popup that could bind a field as a side
    // effect of being opened is the original defect regardless of which
    // environment it happens on.
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_INSPECTOR_UNPAIR: { ok: true } });
    await h.settle();
    h.el('inspRefresh').fire('click');
    await h.settle();
    h.el('inspUnpair').fire('click');
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_PAIR')).toEqual([]);
    // And the ONE deliberate caller is reachable only from the submit control,
    // which cannot be pressed without a code in the box.
    const popupSrc = readFileSync(resolve(ROOT, 'extension/popup/popup.js'), 'utf8');
    expect(popupSrc).toMatch(/AB_INSPECTOR_PAIR/);
    expect(popupSrc).toMatch(/function\s+submitAuthorization/);
    // The worker answers it, because the redemption has to reach the server.
    const bgSrc = readFileSync(resolve(ROOT, 'extension/background.js'), 'utf8');
    expect(bgSrc).toContain("case 'AB_INSPECTOR_PAIR':");
  });

  it('refuses to submit an empty code, so a stray Enter cannot spend a request', async () => {
    // The other half of "never spontaneously". A form that posts an empty string
    // would turn a mis-hit Enter into a failed pairing attempt against a
    // single-use code, and the operator would be told their code was rejected
    // when it was never sent.
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    h.el('authConnect').fire('click');
    await h.settle();
    expect(h.sentOf('AB_INSPECTOR_PAIR')).toEqual([]);
    expect(h.text('authStatus')).toMatch(/code/i);
  });

  it('still names no target of its own — it only reports the server\'s', async () => {
    // The original risk, restated for the new architecture. The destination the
    // popup DISPLAYS must come from the session reply; it must not appear in any
    // outgoing message, where it would become an instruction rather than a
    // readout.
    const h = boot({ AB_INSPECTOR_SESSION: connected() });
    await h.settle();
    expect(h.text('inspFieldId')).toBe('node_n1__url__a1b2c3d4');

    const outgoing = JSON.stringify(h.sent);
    expect(outgoing).not.toContain('node_n1__url__a1b2c3d4');
    expect(outgoing).not.toContain('targetFieldId');
  });

  it('says nothing about codes anywhere on either tab', async () => {
    // The user-facing half of the deletion. Leaving the vocabulary behind would
    // send someone looking for a control that no longer exists — which is how
    // the old «enter an Authorization Code in Connection» message read after the
    // Connection tab lost its inputs.
    const h = boot({ AB_INSPECTOR_SESSION: connected({ targetFieldId: '', authorized: false, target: null }) });
    await h.settle();
    await h.refresh();
    for (const id of ['inspStatus', 'inspTarget', 'inspNode', 'ctPairing', 'ctState', 'connState', 'connAuth', 'status']) {
      expect(h.text(id), `#${id} still mentions a code`).not.toMatch(/authorization code|\bcode\b/i);
    }
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
    // It used to say "ask for a new code", which was the way back when a code
    // was the way in. The route back is now the crosshair in the project — and
    // naming it is the whole reason this message exists rather than a bare
    // "Released", which would leave the user hunting for the control that does
    // it. Read off #status because #inspPairStatus was the code widget's own
    // line and went with it.
    expect(h.text('status')).toMatch(/crosshair/i);
    expect(h.text('status')).not.toMatch(/code/i);
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
      AB_INSPECTOR_SESSION: connected(),
      AB_INSPECTOR_UNPAIR: { ok: true },
    });
    await h.settle();
    // The pair half of this drive is gone with the code box; refresh takes its
    // place as "the other thing a user can press", so the sweep still covers
    // every control on the panel rather than just the one that was left.
    h.el('inspRefresh').fire('click');
    await h.settle();
    h.el('inspUnpair').fire('click');
    await h.settle();

    const handoff = h.sent.filter((m) => String(m.type || '').startsWith('AB_HANDOFF'));
    expect(handoff).toEqual([]);
    // And it definitely did do the inspector work, so the emptiness above is
    // "sent nothing about handoff", not "sent nothing at all".
    expect(h.sentOf('AB_CHECK')).toHaveLength(1);
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
  it('says what is actually wrong, and does not blame a missing API key', async () => {
    // `no_api_key` was the commonest answer here and it is now an impossible
    // diagnosis: there is no key box, so "set the API Key" asks the user to do
    // something they cannot do. background.js reports the real condition — the
    // SERVER has not handed this browser a backend context yet — and that is
    // what has to reach the panel.
    const h = boot({ AB_INSPECTOR_SESSION: { ok: false, error: 'runtime_context_unavailable' } });
    await h.settle();
    await h.refresh();
    expect(h.text('inspStatus')).toMatch(/server/i);
    expect(h.text('inspStatus')).toMatch(/backend context/i);
    expect(h.text('inspStatus')).not.toMatch(/api key|base url/i);
    // The Connection tab must agree, in its own shorter words.
    expect(h.text('connState')).toMatch(/waiting for the server/i);
  });

  it('names an unrecognised failure verbatim instead of inventing a cause', async () => {
    // A refusal it has no special text for must still be reported as itself; a
    // generic "not connected" would cost the user the only clue they had.
    const h = boot({ AB_INSPECTOR_SESSION: { ok: false, error: 'econnrefused' } });
    await h.settle();
    await h.refresh();
    expect(h.text('inspStatus')).toMatch(/econnrefused/);
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
  // WHY THE WORDING CHANGED, AND WHAT DID NOT
  // -----------------------------------------
  // The requirement these tests defend is unchanged: «دفعات بعد … دیگر نیازی
  // نیست» — coming back to a field that is already bound must be a no-op, and
  // the panel has to SAY so, because "Connected" tracks the ADDRESS and goes
  // false on every NDV re-open even while the pairing stands.
  //
  // What changed is that the line can no longer phrase this as "no code needed
  // next time". There is no code any more, for either environment, so promising
  // its absence would describe a mechanism that does not exist — and would read
  // as though a code were still the alternative. The line now reports the fact
  // itself: bound, so this field stays targeted; or not bound, plus the ONE
  // action that binds it — which differs by environment, and that difference is
  // the substance the old "not required" wording lost.
  it('says the binding persists, without promising the absence of a code', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'local', paired: true }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/stays targeted/i);
    expect(h.cls('ctPairing')).toContain('ok');
    // The mechanism is gone, so the promise about it must be too.
    expect(h.text('ctPairing')).not.toMatch(/code/i);
  });

  it('points LOCAL at the crosshair when the field is not bound', async () => {
    // LOCAL binds by itself, on the server, the moment the crosshair is used —
    // so the crosshair IS the whole instruction. It used to warn that a code
    // "will be requested", which is now simply untrue: nothing will be.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'local', paired: false }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/not bound/i);
    expect(h.text('ctPairing')).toMatch(/crosshair/i);
    expect(h.text('ctPairing')).not.toMatch(/code/i);
  });

  it('points REMOTE at the approval prompt instead — a different action', async () => {
    // REMOTE is the one case that needs the operator to do something in the
    // project beyond aiming: approve the request. Telling a remote user to press
    // the crosshair again would send them round a loop they have already
    // completed. This distinction is why the two branches exist at all.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'remote', paired: false }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/approve/i);
    expect(h.text('ctPairing')).not.toMatch(/crosshair/i);
    expect(h.text('ctPairing')).not.toMatch(/code/i);
  });

  it('survives the address going stale — the point of the split', async () => {
    // The node was re-opened, so the ADDRESS this extension holds is no longer
    // live. The PAIRING is untouched, and reporting only the address would make
    // a standing pairing look absent — the exact misreading that made the
    // operator ask for this line.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({
        environment: 'local', paired: true, authorized: false, target: null,
      }),
    });
    await h.settle();
    expect(h.text('ctPairing')).toMatch(/stays targeted/i);
    // …while the connection line still reports the address honestly, rather than
    // being smoothed over by the good news above it.
    expect(h.text('ctState')).toMatch(/no longer open/i);
    expect(h.text('ctState')).not.toMatch(/stays targeted/i);
  });
});

// ════════════════════════════════════════════════════════════════
// THE BROWSER ENVIRONMENT CHOOSER — the regression these tests pin
//
// REPORTED: «UI فعلی دیگر هیچ انتخابی برای LOCAL BROWSER / REMOTE BROWSER
// ندارد … این انتخاب باید در ابتدای Target This Field وجود داشته باشد و state
// واقعی Browser Environment را تعیین کند.»
//
// The choice was present in the web app's own dialog but NOT on this surface,
// so an operator working from the extension could not make it at all. These
// tests fail if that state is ever restored.
//
// They also pin the two halves that must NOT come back with it: «حذف credential
// fields از Local درست است» — choosing an environment must add no Base URL, no
// API key and no Authorization Code, and LOCAL must raise no approval prompt.
// ════════════════════════════════════════════════════════════════

/** A session reply with one field OPEN but this extension not yet bound to it. */
function unbound(over: Record<string, unknown> = {}) {
  const target = {
    targetFieldId: 'node_n7__url__f00d1234',
    nodeId: 'n7', fieldKey: 'url', action: 'http_request',
    label: 'HTTP Request → url', registeredAt: Date.now(),
  };
  return {
    ok: true,
    targetFieldId: '',
    authorized: false,
    target: null,
    data: {
      success: true, mode: 'remote', modes: ['remote', 'local'], localAvailable: false,
      targets: [target], authorized: [], pending: 0,
    },
    ...over,
  };
}

/** The server's environmentOptions() shape, as /inspector/targeting/options returns it. */
function options(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    paired: false,
    localEnabled: true,
    // Mirrors what src/core/BrowserEnvironment.ts#environmentOptions() actually
    // emits, flag names included. Both were previously `needsRemoteApproval`,
    // set on the wrong environment — so this fixture was quietly asserting the
    // inverted contract and every test built on it passed.
    //
    //   LOCAL  the server's own browser: it launches, it grants, and it raises
    //          the in-page approval that names the field.
    //   REMOTE the operator's own browser: a code and a Base URL, no launch,
    //          no approval, and `paired` reports the field's REAL state.
    options: [
      { id: 'local', available: true, paired: true, needsAuthorization: false, needsInPageApproval: true, opensServerBrowser: true, note: '' },
      { id: 'remote', available: true, paired: false, needsAuthorization: true, needsInPageApproval: false, opensServerBrowser: false, note: '' },
    ],
    ...over,
  };
}

/** The cards currently rendered into #envGrid, in document order. */
function cards(h: Harness): El[] {
  return h.el('envGrid').childNodes;
}
function envIds(h: Harness): string[] {
  return cards(h).map((c) => c.attrs['data-env'] || '');
}

describe('§1 — the chooser EXISTS on this surface and offers both browsers', () => {
  it('popup.html declares the Browser Environment card and its grid', () => {
    // The regression was structural: no container, so nothing could render into
    // one. Asserted against the shipped markup, not against the controller.
    expect(HTML).toContain('id="envCard"');
    expect(HTML).toContain('id="envGrid"');
    expect(HTML).toMatch(/Browser environment/i);
  });

  it('renders exactly LOCAL and REMOTE, from the server\'s own option list', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
    });
    await h.settle();

    expect(envIds(h)).toEqual(['local', 'remote']);
    // Named with the word "Browser" so neither can be read as the Connection
    // tab's backend-location rows.
    const text = cards(h).map((c) => c.childNodes.map((k) => k.textContent).join(' | '));
    expect(text[0]).toContain('Local Browser');
    expect(text[1]).toContain('Remote Browser');
  });

  it('asks the server which environments are available, for the OPEN field', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
    });
    await h.settle();

    const asked = h.sentOf('AB_TARGETING_OPTIONS');
    expect(asked.length).toBeGreaterThan(0);
    // nodeId + fieldKey, never a targetFieldId: asking which browsers exist must
    // not mint a destination as a side effect.
    expect(asked[0].payload).toMatchObject({ nodeId: 'n1', fieldKey: 'url' });
    expect(JSON.stringify(asked[0].payload)).not.toContain('targetFieldId');
  });

  it('offers the choice BEFORE any binding exists — the moment it is needed', async () => {
    // The reported flow starts at "Target This Field", i.e. with a field open and
    // nothing bound yet. A chooser that only appeared after binding would be
    // unreachable exactly when the operator needs it.
    const h = boot({
      AB_INSPECTOR_SESSION: unbound(),
      AB_TARGETING_OPTIONS: options(),
    });
    await h.settle();

    expect(h.hidden('envCard')).toBe(false);
    expect(envIds(h)).toEqual(['local', 'remote']);
    expect(h.sentOf('AB_TARGETING_OPTIONS')[0].payload).toMatchObject({ nodeId: 'n7', fieldKey: 'url' });
  });

  it('hides the card when there is no field to target, rather than binding a guess', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: { ok: true, targetFieldId: '', authorized: false, target: null, data: { targets: [] } },
      AB_TARGETING_OPTIONS: options(),
    });
    await h.settle();

    expect(h.hidden('envCard')).toBe(true);
    expect(h.sentOf('AB_TARGETING_OPTIONS')).toHaveLength(0);
  });

  it('says so when the options cannot be loaded, instead of showing an empty chooser', async () => {
    // An empty grid is indistinguishable from the regression itself, so silence
    // here is not an option.
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: { ok: false, error: 'network', options: [] },
    });
    await h.settle();

    expect(cards(h)).toHaveLength(0);
    expect(h.text('envStatus')).toMatch(/network|could not/i);
    expect(h.cls('envStatus')).toContain('bad');
  });
});

describe('§2 — LOCAL: internal, automatic, and free of every credential', () => {
  it('pressing LOCAL sends environment:local and nothing resembling a credential', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: {
        ok: true, environment: 'local', step: 'targeting', paired: true,
        runtime: 'server-local', openRemoteBrowser: false, consent: null,
        target: { targetFieldId: 'node_n1__url__a1b2c3d4', pairingKey: 'tf:_:n1:url', nodeId: 'n1', fieldKey: 'url', action: 'http_request', environment: 'local' },
      },
    });
    await h.settle();

    cards(h)[0].click();
    await h.settle();

    const began = h.sentOf('AB_TARGETING_BEGIN');
    expect(began).toHaveLength(1);
    expect(began[0].payload).toMatchObject({ environment: 'local', nodeId: 'n1', fieldKey: 'url' });

    // The whole substance of the LOCAL contract, asserted on the wire.
    const wire = JSON.stringify(began[0].payload).toLowerCase();
    for (const banned of ['baseurl', 'apikey', 'api_key', 'code', 'authorization', 'token', 'password']) {
      expect(wire, `LOCAL must not send ${banned}`).not.toContain(banned);
    }
  });

  it('reports the connection as established, with no approval to answer', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: {
        ok: true, environment: 'local', step: 'targeting', paired: true,
        runtime: 'server-local', openRemoteBrowser: false, consent: null,
        target: { targetFieldId: 'node_n1__url__a1b2c3d4', pairingKey: 'tf:_:n1:url', nodeId: 'n1', fieldKey: 'url', action: 'http_request', environment: 'local' },
      },
    });
    await h.settle();

    cards(h)[0].click();
    await h.settle();

    // «Connected to Target → Ready to Send», and explicitly not an approval.
    expect(h.text('envStatus')).toMatch(/connected to the target/i);
    expect(h.text('envStatus')).not.toMatch(/approve|approval|code/i);
    expect(h.cls('envStatus')).toContain('ok');
  });

  it('the LOCAL card advertises itself as automatic before it is pressed', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_TARGETING_OPTIONS: options() });
    await h.settle();

    const local = cards(h)[0].childNodes.map((k) => k.textContent).join(' ');
    expect(local).toMatch(/automatic/i);
    expect(local).toMatch(/nothing to enter/i);
    expect(local).not.toMatch(/code|api key|base url/i);
  });

  it('a disabled LOCAL is shown with the server\'s reason and cannot be pressed', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options({
        options: [
          { id: 'local', available: false, paired: false, needsAuthorization: false, needsRemoteApproval: false, note: 'local_disabled' },
          { id: 'remote', available: true, paired: true, needsAuthorization: false, needsRemoteApproval: true, note: '' },
        ],
      }),
    });
    await h.settle();

    // Still OFFERED — the pair must remain visible — but refused locally rather
    // than pressed into a 409.
    expect(envIds(h)).toEqual(['local', 'remote']);
    expect(cards(h)[0].disabled).toBe(true);
    expect(cards(h)[0].childNodes.map((k) => k.textContent).join(' ')).toMatch(/switched off/i);

    cards(h)[0].click();
    await h.settle();
    expect(h.sentOf('AB_TARGETING_BEGIN')).toHaveLength(0);
  });
});

describe('§3 — REMOTE: the operator’s own machine, so a code and an address', () => {
  it('pressing REMOTE sends environment:remote and receives a code to redeem', async () => {
    const h = boot({
      // The open field is stamped `remote`, because the route registers it with
      // the chosen environment BEFORE it branches. That stamp is the only thing
      // that says "remote" here: no destination is stored until the code is
      // redeemed, so the session's own `environment` is still empty.
      AB_INSPECTOR_SESSION: connected({}, 'remote'),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: {
        ok: true, environment: 'remote', step: 'authorize', paired: false,
        openServerBrowser: false,
        consent: null,
        authorization: { code: 'ABCD-1234', baseUrl: 'https://panel.example.com', label: 'URL', fieldKey: 'url', nodeId: 'n1' },
        target: { targetFieldId: 'node_n1__url__a1b2c3d4', pairingKey: 'tf:_:n1:url', nodeId: 'n1', fieldKey: 'url', action: 'http_request', environment: 'remote' },
      },
    });
    await h.settle();

    cards(h)[1].click();
    await h.settle();

    const began = h.sentOf('AB_TARGETING_BEGIN');
    expect(began).toHaveLength(1);
    expect(began[0].payload).toMatchObject({ environment: 'remote' });

    // THE INVERSION, AT THE ONE PLACE THE OPERATOR MEETS IT. This used to expect
    // /approve/i and to BAN the word "code" outright. The approval belongs to the
    // server's own shared window, which is LOCAL; the code belongs here, because
    // the browser being connected is on another machine.
    expect(h.text('envStatus')).toMatch(/code/i);

    // WHAT IS STILL BANNED, AND IT IS THE PART THAT ALWAYS MATTERED: the popup
    // sends the CHOICE and nothing else. Every credential travels server → popup,
    // never popup → server, so nothing here can assert its own way in.
    const wire = JSON.stringify(began[0].payload).toLowerCase();
    for (const banned of ['baseurl', 'apikey', 'authorization', 'token']) {
      expect(wire, `REMOTE must not send ${banned}`).not.toContain(banned);
    }
    // And the credential card is now on screen, pre-filled from the server.
    expect(h.hidden('authCard')).toBe(false);
    expect(h.el('authBase').value).toBe('https://panel.example.com');
  });

  it('shows the code box off the OPEN FIELD\'s environment, with no session env yet', async () => {
    // THE REGRESSION THIS EXISTS TO CATCH, and it is a production one rather
    // than a wording one.
    //
    // REMOTE deliberately stores nothing at `begin` — the destination is written
    // when the code is redeemed, not when it is issued. So at the moment the
    // operator needs the two inputs, background.js has no `ab_targetFieldId`,
    // `res.target` is null and `res.environment` is ''. If the credential card
    // were gated on the SESSION's environment alone it would stay hidden exactly
    // then, and the flow would dead-end with a code the operator has nowhere to
    // type. paintEnvironment()'s single-open-field fallback is what carries the
    // choice across that gap.
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: '', authorized: false, targetFieldId: '' }, 'remote'),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: {
        ok: true, environment: 'remote', step: 'authorize', paired: false,
        openServerBrowser: false, consent: null,
        authorization: { code: 'EFGH-5678', baseUrl: 'https://panel.example.com', label: 'URL', fieldKey: 'url', nodeId: 'n1' },
        target: null,
      },
    });
    await h.settle();

    cards(h)[1].click();
    await h.settle();

    expect(h.hidden('authCard')).toBe(false);
    // And it names WHICH field the code is for, because a single-use code with
    // no destination on screen is one the operator cannot check before spending.
    expect(h.text('authHint')).toMatch(/url/i);
  });

  it('the REMOTE card names the code, and never an approval, before being pressed', async () => {
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_TARGETING_OPTIONS: options() });
    await h.settle();

    const remote = cards(h)[1].childNodes.map((k) => k.textContent).join(' ');
    // Said BEFORE the press, because a card promising "connects automatically"
    // that then produces a credential form is worse than one that warns.
    expect(remote).toMatch(/code/i);
    expect(remote).not.toMatch(/approv/i);
  });

  it('the LOCAL card names the approval, and never a code', async () => {
    // The mirror, asserted on the same fixture so the two cards cannot both drift
    // in the same direction — which is exactly how the inversion stayed hidden.
    const h = boot({ AB_INSPECTOR_SESSION: connected(), AB_TARGETING_OPTIONS: options() });
    await h.settle();

    const local = cards(h)[0].childNodes.map((k) => k.textContent).join(' ');
    expect(local).toMatch(/approv/i);
    expect(local).not.toMatch(/\bcode\b/i);
  });

  it('LOCAL leaves the credential card hidden, whatever REMOTE did before it', async () => {
    // The card is REMOTE's alone. Leaving it up after a switch back to LOCAL
    // would put two inputs in front of somebody on the path defined by having
    // none — and it would do so with a spent code still in the box.
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: {
        ok: true, environment: 'local', step: 'targeting', paired: true,
        openServerBrowser: true, authorization: null,
        consent: { consentId: 'c1', nodeId: 'n1', fieldKey: 'url' },
        target: { targetFieldId: 'node_n1__url__a1b2c3d4', pairingKey: 'tf:_:n1:url', nodeId: 'n1', fieldKey: 'url', action: 'http_request', environment: 'local' },
      },
    });
    await h.settle();
    cards(h)[0].click();
    await h.settle();
    expect(h.hidden('authCard')).toBe(true);
  });

  it('does not open a second browser for a second field — the choice is all it sends', async () => {
    // REMOTE TARGET REUSE: switching fields must go through the same route with
    // the same body shape, so the server can reuse the running browser. A popup
    // that carried any "open a new browser" instruction of its own would defeat
    // that from the client side.
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: { ok: true, environment: 'remote', openRemoteBrowser: true, paired: true, target: null },
    });
    await h.settle();

    cards(h)[1].click();
    await h.settle();

    const payload = h.sentOf('AB_TARGETING_BEGIN')[0].payload || {};
    // `workflowId` belongs here: pairingKeyFor(nodeId, fieldKey, workflowId) is
    // what makes a binding survive the node being re-opened, so omitting it
    // would mean a new pairing — and a new prompt — every time.
    expect(Object.keys(payload).sort()).toEqual(['action', 'environment', 'fieldKey', 'nodeId', 'workflowId']);
    expect(JSON.stringify(payload)).not.toMatch(/launch|newBrowser|restart|spawn/i);
  });
});

describe('§4 — the chooser reflects the SERVER\'s record, not a local guess', () => {
  it('marks the environment the server has on record as the one in force', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected({ environment: 'remote' }),
      AB_TARGETING_OPTIONS: options(),
    });
    await h.settle();

    expect(cards(h)[1].className).toContain('is-on');
    expect(cards(h)[0].className).not.toContain('is-on');
    expect(h.text('envStatus')).toMatch(/remote browser/i);
  });

  it('re-reads the server after a choice instead of trusting what it asked for', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: { ok: true, environment: 'local', paired: true, runtime: 'server-local', target: null },
    });
    await h.settle();
    const before = h.sentOf('AB_INSPECTOR_SESSION').length;

    cards(h)[0].click();
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_SESSION').length).toBeGreaterThan(before);
  });

  it('passes a refusal through with the server\'s own sentence', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: { ok: false, reason: 'local_disabled', error: 'Local targeting is switched off for this instance.' },
    });
    await h.settle();

    cards(h)[0].click();
    await h.settle();

    expect(h.text('envStatus')).toContain('Local targeting is switched off');
    expect(h.cls('envStatus')).toContain('bad');
  });
});

describe('§5 — restoring the chooser did NOT restore the credentials', () => {
  it('declares none of the DELETED credential controls, and no secret box at all', () => {
    // The correction is explicit that removing these was CORRECT, and every one
    // of them stays removed by name. Re-adding a chooser must not smuggle any
    // back, and neither must re-adding REMOTE's two inputs.
    //
    // #baseUrl and #apiKey were the BACKEND form's — an address and a key for
    // reaching the server, asked of every user on every path. #modeLocal /
    // #modeRemote chose between two hardcoded backend URLs. #inspCode and
    // #connect were the per-field code row. All eight are gone and stay gone;
    // what REMOTE has instead is #authBase and #authCode, which are scoped to one
    // browser, live in a card that ships hidden, and exist only because the
    // machines are genuinely different.
    for (const dead of ['modeLocal', 'modeRemote', 'modeLocalUrl', 'modeRemoteUrl', 'baseUrl', 'apiKey', 'inspCode', 'connect']) {
      expect(HTML, `#${dead} must stay deleted`).not.toContain(`id="${dead}"`);
    }
    // NO API KEY AND NO PASSWORD, ANYWHERE, ON EITHER PATH. This is the
    // assertion that did not change and must not: the extension already
    // authenticates with its own key, so asking for one again would be asking the
    // operator to re-supply something we hold.
    expect(HTML).not.toMatch(/type="password"/i);
    expect(HTML).not.toMatch(/API key\s*<\/(label|span)>/i);
    expect(HTML).not.toMatch(/id="authKey"/i);
    // The Authorization Code label IS present now, and exactly once — a second
    // one would mean a code box had appeared somewhere outside the REMOTE card.
    expect((HTML.match(/Authorization code\s*<\/label>/gi) || []).length).toBe(1);
  });

  it('the Inspect panel has no text input at all', () => {
    const inspect = HTML.slice(HTML.indexOf('id="p-inspect"'), HTML.indexOf('id="p-connection"'));
    expect(inspect).not.toMatch(/<input(?![^>]*type="(radio|checkbox)")/i);
  });

  it('the chooser sends only the four facts the server needs', async () => {
    const h = boot({
      AB_INSPECTOR_SESSION: connected(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: { ok: true, environment: 'local', paired: true, target: null },
    });
    await h.settle();

    cards(h)[0].click();
    await h.settle();

    // Nothing beyond the five facts the server needs to identify the field and
    // the browser — and in particular nothing the user could have typed.
    expect(Object.keys(h.sentOf('AB_TARGETING_BEGIN')[0].payload || {}).sort())
      .toEqual(['action', 'environment', 'fieldKey', 'nodeId', 'workflowId']);
  });
});
