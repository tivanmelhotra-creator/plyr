import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════════════════
// extension/popup/popup.js — THE TWO REMOTE INPUTS, AND WHAT SURVIVES A CLOSE
//
// REPORTED, in one breath, as one complaint about the same two boxes:
//
//   «اولاً که باید خالی نشه خب، دوماً باید یه کاری کنیم یه حالت JSON اینجا چیز
//    کنیم خب، کپی رو یه حالت JSON داشته باشیم که یه Copy All بذاریم خب، وقتی
//    اونو کپی کنیم خب، روی هر کدام که پیست کنیم خب، به جای اینکه فقط یک فیلد
//    پر بشه باید هر دو تا فیلد پر بشه.»
//
//   (3a) the Base URL must not empty itself, and
//   (3b) one JSON "Copy All" must fill BOTH fields, pasted into EITHER of them.
//
// plus the tail of Issue 1, which is what made 3a expensive rather than merely
// annoying:
//
//   «هم خود Authorize ام و هم Base URL ام درسته خب بازم همون خطا را بهم
//    برمی‌گردونه»
//
// WHY THE FIELD EMPTIED ITSELF — THE MECHANISM, NOT THE SYMPTOM
// -------------------------------------------------------------
// A Chrome popup is not a window; it is a document that is DESTROYED the moment
// focus leaves it. Every REMOTE operator therefore does this:
//
//   1. open the popup, type the Base URL
//   2. leave to the dashboard to copy the authorization code   ← popup destroyed
//   3. come back — and type the address again
//
// `ab_baseUrl` could not help: it is written in exactly ONE place, inside
// inspectorPair(), AFTER a redeem has already succeeded. So on the only path
// where the value was needed, nothing had ever stored it.
//
// WHY A SECOND STORAGE KEY, AND NOT JUST `ab_baseUrl`
// --------------------------------------------------
// `ab_baseUrl` means "an address that WORKED". It is read by getSettings() and
// therefore by inspectorContext(), which resolves the address for EVERY call
// the extension makes, in BOTH environments. Persisting keystrokes there would
// publish `https://ex` as the extension's backend mid-word, and LOCAL — which
// must resolve to the server's own loopback — would start aiming at a
// half-typed remote host. `ab_authBase` is the DRAFT: popup-only, never
// consulted by the transport.
//
// HOW THIS FILE MODELS "THE POPUP CLOSED"
// ---------------------------------------
// There is no API for it, so the model is: build a NEW harness over the SAME
// storage object. Nothing else carries over — which is precisely the bug.
// ════════════════════════════════════════════════════════════════════════════

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
  checked = false;
  type = '';
  name = '';
  dataset: Record<string, string> = {};
  childNodes: El[] = [];
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  /** Set by focus(), so "focus went to the box still empty" is testable. */
  focused = false;

  static registry: El[] = [];
  constructor(id = '') { this.id = id; El.registry.push(this); }

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
  setAttribute(k: string, v: string) { this.attrs[String(k)] = String(v); }
  getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[String(k)]; }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  focus() { this.focused = true; }
  select() {}
  click() {
    const radio = this.childNodes.find((c) => c.type === 'radio');
    if (radio && !radio.disabled) {
      El.registry.forEach((el) => {
        if (el !== radio && el.type === 'radio' && el.name === radio.name) el.checked = false;
      });
      radio.checked = true;
      radio.fire('change');
    }
    this.fire('click');
  }
  fire(t: string, evt: Record<string, unknown> = {}) {
    (this.listeners[t] || []).slice().forEach((fn) => fn({
      preventDefault() {}, stopPropagation() {}, target: this, ...evt,
    }));
  }

  /** Type like a human: the value changes AND `input` fires. */
  typeInto(v: string) { this.value = v; this.fire('input'); }

  /**
   * Paste like a browser: fire `paste` carrying a clipboardData, and perform the
   * default insertion ONLY if the handler did not preventDefault().
   *
   * Modelling the default matters both ways round. A handler that recognises a
   * bundle MUST cancel it, or the raw JSON is inserted alongside the parsed
   * values; a handler that does not recognise the text MUST NOT cancel it, or
   * ordinary pasting silently stops working.
   */
  pasteInto(text: string): boolean {
    let prevented = false;
    (this.listeners.paste || []).slice().forEach((fn) => fn({
      preventDefault() { prevented = true; },
      stopPropagation() {},
      target: this,
      clipboardData: { getData: () => text },
    }));
    if (!prevented) this.value += text;
    return prevented;
  }
}

interface SentMessage { type?: string; payload?: Record<string, unknown> }
type Replies = Record<string, unknown | ((msg: SentMessage) => unknown)>;

interface Harness {
  el(id: string): El;
  text(id: string): string;
  cls(id: string): string;
  sent: SentMessage[];
  sentOf(type: string): SentMessage[];
  storage: Record<string, unknown>;
  clipboard: { text: string };
  settle(): Promise<void>;
}

function htmlIds(): string[] {
  return Array.from(new Set(
    (HTML.match(/\sid="([A-Za-z0-9_-]+)"/g) || []).map((m) => m.replace(/\sid="|"$/g, '')),
  ));
}

function boot(
  replies: Replies = {},
  storage: Record<string, unknown> = {},
  clipboard: { text: string } = { text: '' },
): Harness {
  // ── THE REGISTRY MUST BE PER-POPUP, NOT PER-FILE ──────────────────────
  // `El.registry` is static, and Issue 3a is modelled by booting a SECOND
  // popup over the same storage. Left cumulative, a lookup like
  //   El.registry.find(e => e.getAttribute('data-env') === 'remote')
  // returns the FIRST remote card ever built — a node owned by an earlier,
  // already-dead popup instance. Clicking it runs THAT instance's
  // chooseEnvironment(), so the instance under test never sends
  // AB_TARGETING_BEGIN and envState.authorization stays null.
  //
  // That is a harness artefact with a nasty signature: it is invisible in every
  // test whose expectation is ALSO satisfied by paintEnvironment() inferring
  // `remote` from the lone session target, and it fails ONLY in the one test
  // that truly needs the server-supplied authorization to arrive. Clearing here
  // makes each boot a fresh document — which is what closing and reopening a
  // popup actually is.
  El.registry = [];

  const nodes = new Map<string, El>();
  htmlIds().forEach((id) => nodes.set(id, new El(id)));

  const sent: SentMessage[] = [];
  const scripted: Replies = {
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
    // The execCommand paste fallback. `false` keeps the tests on the documented
    // clipboard path unless one explicitly wants the other branch.
    execCommand: () => false,
  };

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
        // Honours the requested key list, unlike a fake that returns everything:
        // reading a key the popup never asked for would hide a MISSING key from
        // the INIT read — and the INIT read is exactly where the restore has to
        // happen.
        get: (keys: unknown, cb: (v: Record<string, unknown>) => void) => {
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            (keys as string[]).forEach((k) => {
              if (storage[k] !== undefined) out[k] = storage[k];
            });
            cb(out);
            return;
          }
          cb(storage);
        },
        set: (obj: Record<string, unknown>, cb?: () => void) => {
          Object.assign(storage, obj);
          if (cb) cb();
        },
        remove: (keys: unknown, cb?: () => void) => {
          const list = Array.isArray(keys) ? keys as string[] : [String(keys)];
          list.forEach((k) => { delete storage[k]; });
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
    navigator: {
      clipboard: {
        writeText: (t: string) => { clipboard.text = String(t); return Promise.resolve(); },
        readText: () => Promise.resolve(clipboard.text),
      },
    },
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
  vm.runInContext(CORE, sandbox);
  vm.runInContext(JS, sandbox);

  const el = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw new Error(`popup.html declares no id "${id}"`);
    return n;
  };
  const settle = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };

  return {
    el,
    text: (id: string) => el(id).textContent,
    cls: (id: string) => el(id).className,
    sent,
    sentOf: (type: string) => sent.filter((m) => m.type === type),
    storage,
    clipboard,
    settle,
  };
}

/** A session with exactly one open REMOTE field. */
function remoteSession() {
  return {
    ok: true,
    authorized: false,
    targetFieldId: '',
    target: null,
    environment: '',
    targets: [{
      nodeId: 'n1', fieldKey: 'url', label: 'URL', environment: 'remote',
      targetFieldId: 'node_n1__url__a1b2c3d4',
    }],
    data: { targets: [] },
  };
}

/** The option list, shaped as /inspector/targeting/options returns it. */
function options() {
  return {
    ok: true,
    environment: 'remote',
    options: [
      { id: 'local', available: true, needsInPageApproval: true },
      { id: 'remote', available: true, needsAuthorization: true },
    ],
  };
}

/**
 * Put the popup in REMOTE and wait for the auth card to be painted.
 *
 * `auth` is delivered on the AB_TARGETING_BEGIN reply, which is where the real
 * server puts it — popup.js assigns
 *   envState.authorization = (env === 'remote' && res.authorization) || null;
 * Passing it through the SESSION instead would test a shape the product never
 * receives, and the first draft of this harness did exactly that: the pre-fill
 * test then failed against working code.
 */
async function remoteHarness(
  storage: Record<string, unknown> = {},
  clipboard: { text: string } = { text: '' },
  auth: Record<string, unknown> | null = null,
  extraReplies: Replies = {},
): Promise<Harness> {
  const h = boot(
    {
      AB_INSPECTOR_SESSION: remoteSession(),
      AB_TARGETING_OPTIONS: options(),
      AB_TARGETING_BEGIN: {
        ok: true, environment: 'remote', step: 'authorize', paired: false,
        openServerBrowser: false, consent: null,
        authorization: auth,
        target: null,
      },
      ...extraReplies,
    },
    storage,
    clipboard,
  );
  await h.settle();
  // Pressing the card is how a real operator reaches this form, and it is what
  // settles envState.current AND sends AB_TARGETING_BEGIN — i.e. it is what
  // makes an authorization exist at all.
  const remoteCard = El.registry.find((e) => e.getAttribute('data-env') === 'remote');
  if (remoteCard) { remoteCard.click(); await h.settle(); }
  return h;
}

/** What the dashboard's Copy All button puts on the clipboard. */
const BUNDLE = JSON.stringify({
  baseUrl: 'https://panel.example.com',
  code: 'ABCD-EFGH',
}, null, 2);

// ═══════════════════════════════════════════════════════════════════════════
describe('Issue 3a — the Base URL must not clear when the popup closes', () => {
  it('the harness really does reach the REMOTE auth card', async () => {
    // A precondition, asserted once. Every test below would pass trivially
    // against a card that was never painted, so this is what makes the rest of
    // the file meaningful.
    const h = await remoteHarness();
    expect(h.el('authCard').hidden).toBe(false);
  });

  it('THE REPORTED CASE: what was typed is still there after the popup is destroyed and rebuilt', async () => {
    // «اولاً که باید خالی نشه خب»
    const storage: Record<string, unknown> = {};
    const first = await remoteHarness(storage);
    first.el('authBase').typeInto('https://panel.example.com');
    await first.settle();

    // Chrome tears the popup down. There is no API for that — the document
    // simply stops existing — so: a NEW harness over the SAME storage.
    const second = await remoteHarness(storage);

    expect(
      second.el('authBase').value,
      'the address the operator typed was lost when the popup closed — the reported bug',
    ).toBe('https://panel.example.com');
  });

  it('persists on `input`, so leaving mid-word still keeps the characters', async () => {
    const storage: Record<string, unknown> = {};
    const h = await remoteHarness(storage);
    h.el('authBase').typeInto('https://half-typed');
    await h.settle();
    // Written ALREADY — not on blur, not on submit. The popup can be destroyed
    // by the very next click, so there is no later moment to rely on.
    expect(Object.values(storage)).toContain('https://half-typed');
  });

  it('persists on `change` too, for autofill that never fires `input`', async () => {
    const storage: Record<string, unknown> = {};
    const h = await remoteHarness(storage);
    const base = h.el('authBase');
    base.value = 'https://autofilled.example';
    base.fire('change');
    await h.settle();
    expect(Object.values(storage)).toContain('https://autofilled.example');
  });

  it('does NOT write the draft to ab_baseUrl — that key means "an address that worked"', async () => {
    // The separation that makes per-keystroke persistence safe at all.
    const storage: Record<string, unknown> = {};
    const h = await remoteHarness(storage);
    h.el('authBase').typeInto('https://ha');
    await h.settle();
    expect(storage.ab_baseUrl).toBeUndefined();
  });

  it("the operator's own address outranks the server's suggestion", async () => {
    // A REMOTE operator's reachable address is frequently the one the server
    // cannot resolve — that is the entire reason this input exists. If the
    // suggestion overrode the remembered value, the address that WORKS would be
    // silently replaced on every open by the one that does not.
    const storage: Record<string, unknown> = {};
    const first = await remoteHarness(storage);
    first.el('authBase').typeInto('https://the-one-that-works.example');
    await first.settle();

    const second = await remoteHarness(storage, { text: '' }, {
      code: 'ABCD-EFGH',
      baseUrl: 'https://what-the-server-guessed.example',
      label: 'URL', fieldKey: 'url', nodeId: 'n1',
    });
    expect(second.el('authBase').value).toBe('https://the-one-that-works.example');
  });

  it('still pre-fills from the server when the operator has typed nothing', async () => {
    // The guard against overcorrecting: pre-filling is a real convenience on
    // the common path and must survive. Only the PRECEDENCE changed.
    const h = await remoteHarness({}, { text: '' }, {
      code: 'ABCD-EFGH',
      baseUrl: 'https://server-knows.example',
      label: 'URL', fieldKey: 'url', nodeId: 'n1',
    });
    expect(h.el('authBase').value).toBe('https://server-knows.example');
  });

  it('never overwrites a value already on screen', async () => {
    // refreshInspector() repaints on every poll. An in-progress edit replaced
    // by a repaint is the same data loss as the reported bug, just faster.
    const h = await remoteHarness({}, { text: '' }, {
      code: 'ABCD-EFGH',
      baseUrl: 'https://server-knows.example',
      label: 'URL', fieldKey: 'url', nodeId: 'n1',
    });
    h.el('authBase').typeInto('https://mid-edit.example');
    await h.settle();
    expect(h.el('authBase').value).toBe('https://mid-edit.example');
  });

  it('LOCAL still has no authorization surface at all', async () => {
    // The invariant most at risk from every edit in this area. LOCAL is the
    // server's own browser: it is approved by an in-page Alert, never by a code.
    const h = boot({
      AB_INSPECTOR_SESSION: {
        ok: true, authorized: false, targetFieldId: '', target: null,
        environment: 'local',
        targets: [{
          nodeId: 'n1', fieldKey: 'url', label: 'URL', environment: 'local',
          targetFieldId: 'node_n1__url__a1b2c3d4',
        }],
        data: { targets: [] },
      },
      AB_TARGETING_OPTIONS: { ...options(), environment: 'local' },
    });
    await h.settle();
    expect(h.el('authCard').hidden).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Issue 3b — one JSON paste fills BOTH fields, in EITHER field', () => {
  it('THE REPORTED CASE: pasting into the CODE box fills both', async () => {
    // «روی هر کدام که پیست کنیم … باید هر دو تا فیلد پر بشه»
    const h = await remoteHarness();
    const prevented = h.el('authCode').pasteInto(BUNDLE);
    await h.settle();

    expect(h.el('authBase').value).toBe('https://panel.example.com');
    expect(h.el('authCode').value).toBe('ABCDEFGH');
    // The raw JSON must NOT also be inserted, or the box holds both.
    expect(prevented, 'a recognised bundle must cancel the default insertion').toBe(true);
  });

  it('THE REPORTED CASE: pasting into the BASE URL box also fills both', async () => {
    // "either" is the whole point — the operator should not have to know which
    // box the JSON belongs in.
    const h = await remoteHarness();
    h.el('authBase').pasteInto(BUNDLE);
    await h.settle();

    expect(h.el('authBase').value).toBe('https://panel.example.com');
    expect(h.el('authCode').value).toBe('ABCDEFGH');
  });

  it('a bundle paste is persisted too, so it survives the popup as well', async () => {
    const storage: Record<string, unknown> = {};
    const first = await remoteHarness(storage);
    first.el('authCode').pasteInto(BUNDLE);
    await first.settle();

    const second = await remoteHarness(storage);
    expect(second.el('authBase').value).toBe('https://panel.example.com');
  });

  it('the Paste BUTTON understands the bundle from the clipboard', async () => {
    // The existing button read the clipboard and treated it as a bare code.
    const h = await remoteHarness({}, { text: BUNDLE });
    h.el('authPaste').fire('click');
    await h.settle();

    expect(h.el('authBase').value).toBe('https://panel.example.com');
    expect(h.el('authCode').value).toBe('ABCDEFGH');
  });

  it('the code is normalized out of the JSON, so the box shows what will be SENT', async () => {
    // The dashboard DISPLAYS `ABCD-EFGH`; redeem() strips non-alphanumerics
    // before comparing. Normalizing on arrival means the string on screen is
    // the string compared — a code cannot then fail for a reason the operator
    // can see but cannot explain.
    const h = await remoteHarness();
    h.el('authCode').pasteInto(JSON.stringify({ baseUrl: 'https://x.example', code: 'ab cd-ef gh' }));
    await h.settle();
    expect(h.el('authCode').value).toBe('ABCDEFGH');
  });

  it('a bundle carrying only ONE value fills that one and says the other is missing', async () => {
    // Silently filling one of two boxes is how the operator ends up pressing
    // Connect against a half-filled form and blaming the code.
    const h = await remoteHarness();
    h.el('authCode').pasteInto(JSON.stringify({ code: 'ABCD-EFGH' }));
    await h.settle();

    expect(h.el('authCode').value).toBe('ABCDEFGH');
    expect(h.el('authBase').value).toBe('');
    expect(h.text('authStatus')).toMatch(/missing/i);
  });

  it('accepts the aliases the product itself uses on screen', async () => {
    // base_url / authorizationCode appear in this project's own payloads and
    // docs. Accepting only the canonical pair would reject text the operator
    // reasonably copied from elsewhere in the same product.
    const h = await remoteHarness();
    h.el('authCode').pasteInto(JSON.stringify({
      base_url: 'https://alias.example', authorizationCode: 'ZZZZ-9999',
    }));
    await h.settle();

    expect(h.el('authBase').value).toBe('https://alias.example');
    expect(h.el('authCode').value).toBe('ZZZZ9999');
  });

  it('an ordinary code paste is left completely alone', async () => {
    // The regression risk of intercepting `paste`. A plain code must still
    // insert natively, keeping the caret and undo behaviour Chrome provides.
    const h = await remoteHarness();
    const prevented = h.el('authCode').pasteInto('ABCD-EFGH');
    await h.settle();
    expect(prevented, 'non-bundle text must keep the browser default').toBe(false);
  });

  it('junk that merely looks JSON-ish does not wipe the fields', async () => {
    const h = await remoteHarness();
    h.el('authBase').typeInto('https://already-here.example');
    await h.settle();
    h.el('authCode').pasteInto('{ not really json');
    await h.settle();
    expect(h.el('authBase').value).toBe('https://already-here.example');
  });

  it('the dashboard emits exactly the shape this parser reads', async () => {
    // THE CONTRACT. Producer and consumer are in different files, shipped to
    // different runtimes, and nothing else in the suite would notice them
    // drifting apart — the operator would just find that Copy All stopped
    // filling both boxes.
    const flow = readFileSync(resolve(ROOT, 'public/js/targeting-flow.js'), 'utf8');
    const m = flow.match(/function authBundleJson\(auth\)\s*\{[\s\S]*?\n  \}/);
    expect(m, 'public/js/targeting-flow.js no longer defines authBundleJson()').toBeTruthy();

    const produce = new Function(
      `${m![0]}; return authBundleJson({ baseUrl: 'https://real.example', code: 'WXYZ-1234' });`,
    ) as () => string;
    const emitted = produce();

    const h = await remoteHarness();
    h.el('authCode').pasteInto(emitted);
    await h.settle();
    expect(h.el('authBase').value).toBe('https://real.example');
    expect(h.el('authCode').value).toBe('WXYZ1234');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Issue 1 — Connect must be honest about what failed', () => {
  it('THE REPORTED CASE: no request is sent with an empty Base URL', async () => {
    // This is the state 3a produced, and the popup used to submit it anyway.
    // background.js then fell back to loopback — a port on the OPERATOR's
    // laptop — and the refusal was reported as a bad authorization code.
    const h = await remoteHarness();
    h.el('authCode').value = 'ABCD-EFGH';
    h.el('authBase').value = '';
    h.el('authConnect').fire('click');
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_PAIR'), 'nothing may be sent without an address').toEqual([]);
    expect(h.text('authStatus')).toMatch(/Base URL/i);
  });

  it('focus goes to the field that is actually missing', async () => {
    const h = await remoteHarness();
    h.el('authCode').value = 'ABCD-EFGH';
    h.el('authBase').value = '';
    h.el('authConnect').fire('click');
    await h.settle();
    expect(h.el('authBase').focused).toBe(true);
  });

  it('a network failure KEEPS the code on screen', async () => {
    // The code is single-use but was never sent, so it is still valid. Clearing
    // it would force a needless trip to the dashboard for a replacement the
    // operator does not need.
    //
    // The box is left EXACTLY as typed, dash and all. The normalized form is
    // what goes over the wire (asserted separately below); rewriting what is on
    // screen during a failure would be a second, gratuitous surprise in the
    // middle of an error the operator is already trying to understand.
    const h = await remoteHarness({}, { text: '' }, null, {
      AB_INSPECTOR_PAIR: { ok: false, reason: 'network', error: 'Could not reach https://panel.example.com.' },
    });
    h.el('authBase').value = 'https://panel.example.com';
    h.el('authCode').value = 'ABCD-EFGH';
    h.el('authConnect').fire('click');
    await h.settle();

    expect(h.el('authCode').value).toBe('ABCD-EFGH');
  });

  it('but a SUCCESSFUL connect clears the code, which is now spent', async () => {
    // The other half of the same rule, and the reason the test above cannot
    // simply assert "the value is non-empty": a code is single-use, so leaving
    // it on screen after a redeem invites a second attempt that can only fail.
    const h = await remoteHarness({}, { text: '' }, null, {
      AB_INSPECTOR_PAIR: { ok: true, paired: true, targetFieldId: 'node_n1__url__a1b2c3d4' },
    });
    h.el('authBase').value = 'https://panel.example.com';
    h.el('authCode').value = 'ABCD-EFGH';
    h.el('authConnect').fire('click');
    await h.settle();

    expect(h.el('authCode').value).toBe('');
  });

  it('the code is normalized on the WIRE even when the box shows the dash', async () => {
    // What the box displays and what redeem() compares are deliberately
    // different, and this is the pair of facts that makes that safe.
    const h = await remoteHarness({}, { text: '' }, null, {
      AB_INSPECTOR_PAIR: { ok: true, paired: true, targetFieldId: 'node_n1__url__a1b2c3d4' },
    });
    h.el('authBase').value = 'https://panel.example.com';
    h.el('authCode').value = ' abcd-efgh ';
    h.el('authConnect').fire('click');
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_PAIR')[0].payload?.code).toBe('ABCDEFGH');
  });

  it("the worker's explanation is shown verbatim, not paraphrased", async () => {
    // Only the server knows whether a code expired, was already used, or was
    // issued for a different field. Overwriting that with a generic line is
    // what sent the operator to re-copy a good code repeatedly.
    const h = await remoteHarness({}, { text: '' }, null, {
      AB_INSPECTOR_PAIR: {
        ok: false, reason: 'network',
        error: 'Could not reach https://panel.example.com. The authorization code was never sent, so it is still valid.',
      },
    });
    h.el('authBase').value = 'https://panel.example.com';
    h.el('authCode').value = 'ABCD-EFGH';
    h.el('authConnect').fire('click');
    await h.settle();

    expect(h.text('authStatus')).toContain('still valid');
  });

  it('the typed address is the one handed to the worker', async () => {
    // The popup must not "helpfully" substitute a stored or resolved address:
    // the operator's box is the only source on this path.
    const h = await remoteHarness({}, { text: '' }, null, {
      AB_INSPECTOR_PAIR: { ok: true, paired: true, targetFieldId: 'node_n1__url__a1b2c3d4' },
    });
    h.el('authBase').value = 'https://typed-by-hand.example';
    h.el('authCode').value = 'ABCD-EFGH';
    h.el('authConnect').fire('click');
    await h.settle();

    const sent = h.sentOf('AB_INSPECTOR_PAIR');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload?.baseUrl).toBe('https://typed-by-hand.example');
  });

  it('a missing code is still reported as a missing code', async () => {
    const h = await remoteHarness();
    h.el('authBase').value = 'https://panel.example.com';
    h.el('authCode').value = '';
    h.el('authConnect').fire('click');
    await h.settle();

    expect(h.sentOf('AB_INSPECTOR_PAIR')).toEqual([]);
    expect(h.text('authStatus')).toMatch(/code/i);
  });
});
