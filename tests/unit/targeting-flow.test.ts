/**
 * The LOCAL / REMOTE chooser that now opens BEFORE any pick.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The operator's correction was that choosing the browser environment is the
 * FIRST step of targeting, not a setting hidden in a Connection tab:
 *
 *   «وقتی روی آیکون 🎯 Target This Field کلیک می‌شود، اولین قدم باید انتخاب
 *    محیط مرورگر باشد، نه انتخاب حالت اتصال.»
 *
 * and that the two branches differ in exactly one respect:
 *
 *   REMOTE — «نیازی به Authorization Code نیست»
 *   LOCAL  — a code is issued for THAT Target Field the first time, and
 *            «دفعات بعد برای همان Extension و همان Target Field، دیگر نیازی به
 *             Authorization Code جدید نیست»
 *
 * The requirement also insists this be genuinely implemented rather than
 * "displayed cosmetically in the Popup", so these tests assert what the dialog
 * DOES — which endpoint it drove, which tab it opened, when it stops asking for
 * a code — and never that a particular string appears in the source.
 *
 * HOW THEY TEST IT
 * ----------------
 * targeting-flow.js is a browser IIFE and this repo deliberately has no jsdom
 * (vitest runs `environment: 'node'`). So the REAL source file is executed
 * inside a `vm` against a fake DOM small enough to reason about, exactly as
 * flow-editor-connect.test.ts does for the editor. What is measured is the
 * shipped module, not a re-implementation of it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'public/js/targeting-flow.js'), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// A DOM just real enough for a modal made of divs and buttons.
// ───────────────────────────────────────────────────────────────────────────

class El {
  tagName: string;
  className = '';
  type = '';
  disabled = false;
  attrs: Record<string, string> = {};
  childNodes: El[] = [];
  parentNode: El | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  /**
   * Enough of a textarea for the execCommand copy fallback.
   *
   * `style` is a plain bag because the fallback only ever writes to it (moving
   * the node off-screen), and `focus`/`select` are recorded rather than ignored:
   * an unselected textarea copies nothing, so "was it selected?" is a real
   * question about whether the fallback would have worked in a browser.
   */
  style: Record<string, string> = {};
  value = '';
  selected = false;
  focused = false;
  focus() { this.focused = true; }
  select() { this.selected = true; }
  /** Any timer the copy button parked on itself, so a test can inspect it. */
  copyTimer?: number;

  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }

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
  }

  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  appendChild(c: El) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c: El) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  addEventListener(ev: string, fn: (e: unknown) => void) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  removeEventListener(ev: string, fn: (e: unknown) => void) {
    const l = this.listeners[ev] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** Fire a listener the way a user would, including the event object. */
  fire(ev: string, e: unknown = { target: this }) {
    (this.listeners[ev] || []).slice().forEach((fn) => fn(e));
  }

  /** Every descendant (and self) carrying `cls` in its className. */
  find(cls: string): El[] {
    const out: El[] = [];
    const walk = (n: El) => {
      if (n.className.split(/\s+/).indexOf(cls) >= 0) out.push(n);
      n.childNodes.forEach(walk);
    };
    walk(this);
    return out;
  }
  text(): string { return this.textContent; }
}

type Harness = {
  win: Record<string, unknown>;
  body: El;
  flow: { start(ctx: unknown): boolean; close(): void; isOpen(): boolean };
  /** Calls made to the InspectorClient fake. */
  calls: Array<{ fn: string; args: unknown[] }>;
  /** Tabs claimed via window.open(), in order. */
  tabs: Array<{ url: string; target: string; closed: boolean }>;
  /** openRealBrowser invocations. */
  realBrowser: Array<{ url: string; gotTab: boolean }>;
  toasts: string[];
  /** onArmed(target, environment) calls the NDV would have received. */
  armed: Array<{ targetFieldId: string; environment: string }>;
  timers: Array<{ fn: () => void; ms: number; interval: boolean; id: number }>;
  /** Run every pending interval tick once. */
  tick(): Promise<void>;
  /** Run every pending timeout. */
  flushTimeouts(): Promise<void>;
  backdrop(): El | null;
  panel(): El | null;
  docListeners: Record<string, Array<(e: unknown) => void>>;
  /**
   * Everything that reached the clipboard, in order, tagged with the path taken.
   *
   * The path matters: 'api' is navigator.clipboard, 'exec' is the
   * execCommand fallback. A copy button that silently takes neither is the
   * defect these tests exist to catch, and only recording both can tell
   * "fell back" apart from "did nothing".
   */
  clipboard: Array<{ text: string; via: 'api' | 'exec' }>;
  /** Nodes appended to <body> by the execCommand path and not cleaned up. */
  strayNodes(): El[];
  /** Let a copy button's promise chain resolve before asserting on its label. */
  settle(): Promise<void>;
};

type Responses = {
  options?: unknown;
  begin?: unknown | ((env: string) => unknown);
  status?: unknown[];      // consumed one per poll
  unpair?: boolean;
  /** Make navigator.clipboard.writeText reject, as an insecure origin does. */
  clipboardFails?: boolean;
  /** Remove navigator.clipboard entirely, as a very old browser does. */
  noClipboardApi?: boolean;
  /** Make the execCommand fallback fail too — nothing can be copied. */
  execFails?: boolean;
  /**
   * What /browser/real/health says, via InspectorClient.remoteBrowserLive().
   *
   *   undefined — the method is absent entirely (an older dashboard bundle)
   *   true      — already up and answering, so it must NOT be relaunched
   *   false     — not up, or frozen, so it MUST be launched
   */
  remoteLive?: boolean;
};

function boot(res: Responses): Harness {
  const body = new El('body');
  const calls: Harness['calls'] = [];
  const tabs: Harness['tabs'] = [];
  const realBrowser: Harness['realBrowser'] = [];
  const toasts: string[] = [];
  const armed: Harness['armed'] = [];
  const timers: Harness['timers'] = [];
  let timerId = 1;
  const statusQueue = (res.status || []).slice();
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const clipboard: Harness['clipboard'] = [];

  const document = {
    createElement: (tag: string) => new El(tag),
    body,
    addEventListener(ev: string, fn: (e: unknown) => void) {
      (docListeners[ev] = docListeners[ev] || []).push(fn);
    },
    removeEventListener(ev: string, fn: (e: unknown) => void) {
      const l = docListeners[ev] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    /**
     * The legacy copy path. Reads from whatever textarea is currently SELECTED,
     * which is how the real thing behaves — so a fallback that forgot to call
     * select() records nothing here and the test fails, exactly as the browser
     * would have.
     */
    execCommand(cmd: string) {
      if (cmd !== 'copy') return false;
      if (res.execFails) return false;
      const ta = body.childNodes.filter((c) => c.selected).pop();
      if (!ta) return false;
      clipboard.push({ text: ta.value, via: 'exec' });
      return true;
    },
  };

  const win: Record<string, unknown> = {
    AppUtil: {
      // Identity translation: the assertions are about WHICH key was shown,
      // not about the Persian or English wording, which lives in i18n.js and
      // is covered by its own tests.
      t: (k: string) => k,
      toast: (m: string) => { toasts.push(m); },
    },
    InspectorClient: {
      targetingOptions: (nodeId: string, fieldKey: string, opts: unknown) => {
        calls.push({ fn: 'targetingOptions', args: [nodeId, fieldKey, opts] });
        return Promise.resolve(res.options === undefined ? null : res.options);
      },
      targetingBegin: (nodeId: string, fieldKey: string, environment: string, opts: unknown) => {
        calls.push({ fn: 'targetingBegin', args: [nodeId, fieldKey, environment, opts] });
        const b = typeof res.begin === 'function'
          ? (res.begin as (e: string) => unknown)(environment)
          : res.begin;
        return Promise.resolve(b === undefined ? null : b);
      },
      targetingStatus: (targetFieldId: string) => {
        calls.push({ fn: 'targetingStatus', args: [targetFieldId] });
        return Promise.resolve(
          statusQueue.length ? statusQueue.shift() : { success: true, paired: false },
        );
      },
      targetingUnpair: (nodeId: string, fieldKey: string, opts: unknown) => {
        calls.push({ fn: 'targetingUnpair', args: [nodeId, fieldKey, opts] });
        return Promise.resolve(res.unpair !== false);
      },
      // Installed only when the test says so, because "this dashboard has no
      // liveness probe" is a real state the flow has to survive by falling back
      // to the old launch-every-time behaviour.
      ...(res.remoteLive === undefined ? {} : {
        remoteBrowserLive: () => {
          calls.push({ fn: 'remoteBrowserLive', args: [] });
          return Promise.resolve(res.remoteLive);
        },
      }),
    },
    BrowserView: {
      openRealBrowser: (url: string, tab: unknown) => {
        realBrowser.push({ url, gotTab: !!tab });
        return Promise.resolve({ success: true });
      },
    },
    open(url: string, target: string) {
      const tab = { url, target, closed: false };
      tabs.push(tab);
      return { close() { tab.closed = true; } };
    },
  };

  // The modern clipboard, with the two ways it actually fails in the field:
  // absent (very old browser) and rejecting (insecure origin, or a document
  // without focus). Both are ordinary on a plain-http LAN address, which is
  // exactly where an operator copies a Base URL from.
  const clipboardApi = res.noClipboardApi ? undefined : {
    writeText: (text: string) => {
      if (res.clipboardFails) return Promise.reject(new Error('not allowed'));
      clipboard.push({ text: String(text), via: 'api' as const });
      return Promise.resolve();
    },
  };

  const sandbox: Record<string, unknown> = {
    window: win,
    document,
    navigator: { clipboard: clipboardApi },
    setInterval: (fn: () => void, ms: number) => {
      const id = timerId++;
      timers.push({ fn, ms, interval: true, id });
      return id;
    },
    clearInterval: (id: number) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = timerId++;
      timers.push({ fn, ms, interval: false, id });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    Promise,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const settleOnce = () => new Promise<void>((r) => setImmediate(r));

  const h: Harness = {
    win, body, calls, tabs, realBrowser, toasts, armed, timers, docListeners,
    flow: win.TargetingFlow as Harness['flow'],
    async tick() {
      timers.filter((x) => x.interval).slice().forEach((x) => x.fn());
      await settleOnce();
    },
    async flushTimeouts() {
      timers.filter((x) => !x.interval).forEach((x) => {
        const i = timers.indexOf(x);
        if (i >= 0) timers.splice(i, 1);
        x.fn();
      });
      await settleOnce();
    },
    backdrop: () => body.childNodes.filter((c) => c.className === 'tgt-backdrop')[0] || null,
    panel() {
      const b = h.backdrop();
      return b ? b.find('tgt-panel')[0] || null : null;
    },
    clipboard,
    // Anything the fallback left behind. A textarea that survives the copy would
    // be a growing pile of hidden nodes and, worse, one that a later copy could
    // read from instead of the intended value.
    strayNodes: () => body.childNodes.filter((c) => c.tagName === 'TEXTAREA'),
    // Drained rather than counted: the copy path is
    // writeText -> then -> render, and a fixed number of awaits would depend on
    // the length of that chain, which is an implementation detail.
    async settle() {
      for (let i = 0; i < 8; i += 1) await settleOnce();
    },
  };
  return h;
}

const settle = () => new Promise<void>((r) => setImmediate(r));

/** The chooser's own context, matching what ndv-nodes.js supplies. */
function ctx(h: Harness, over: Record<string, unknown> = {}) {
  return {
    nodeId: '8f21',
    fieldKey: 'product_selector',
    action: 'click',
    workflowId: 'wf1',
    label: 'Click → product_selector',
    url: 'https://shop.example/p/1',
    onArmed: (target: { targetFieldId?: string }, environment: string) => {
      h.armed.push({ targetFieldId: (target && target.targetFieldId) || '', environment });
    },
    ...over,
  };
}

const OPTIONS_UNPAIRED = {
  success: true,
  pairingKey: 'tf:wf1:8f21:product_selector',
  paired: false,
  localEnabled: true,
  mode: 'remote',
  options: [
    { id: 'local', available: true, paired: false, needsAuthorization: true, note: 'pairing_required' },
    { id: 'remote', available: true, paired: true, needsAuthorization: false, note: 'server_owned_browser' },
  ],
};

const OPTIONS_PAIRED = {
  ...OPTIONS_UNPAIRED,
  paired: true,
  options: [
    { id: 'local', available: true, paired: true, needsAuthorization: false, note: 'already_paired' },
    { id: 'remote', available: true, paired: true, needsAuthorization: false, note: 'server_owned_browser' },
  ],
};

const OPTIONS_LOCAL_OFF = {
  ...OPTIONS_UNPAIRED,
  localEnabled: false,
  options: [
    { id: 'local', available: false, paired: false, needsAuthorization: true, note: 'local_disabled' },
    { id: 'remote', available: true, paired: true, needsAuthorization: false, note: 'server_owned_browser' },
  ],
};

const TARGET = {
  targetFieldId: 'node_8f21__product_selector__a73f',
  pairingKey: 'tf:wf1:8f21:product_selector',
  nodeId: '8f21',
  fieldKey: 'product_selector',
  environment: 'local',
};

/** Open the chooser and wait for the options round-trip to paint it. */
async function openChooser(h: Harness, over: Record<string, unknown> = {}) {
  h.flow.start(ctx(h, over));
  await settle();
}

/** The card for one environment. */
function card(h: Harness, env: 'local' | 'remote'): El {
  const p = h.panel();
  if (!p) throw new Error('no panel rendered');
  const found = p.find('tgt-card').filter((c) => c.getAttribute('data-env') === env);
  if (!found.length) throw new Error(`no ${env} card`);
  return found[0];
}

// ═══════════════════════════════════════════════════════════════════════════
describe('§1 — the chooser is the FIRST step, before any browser opens', () => {
  let h: Harness;
  beforeEach(() => { h = boot({ options: OPTIONS_UNPAIRED }); });

  it('exposes start/close/isOpen', () => {
    expect(typeof h.flow.start).toBe('function');
    expect(typeof h.flow.close).toBe('function');
    expect(h.flow.isOpen()).toBe(false);
  });

  it('asks the server for the options for THIS field', async () => {
    await openChooser(h);
    const call = h.calls.filter((c) => c.fn === 'targetingOptions')[0];
    expect(call).toBeTruthy();
    expect(call.args[0]).toBe('8f21');
    expect(call.args[1]).toBe('product_selector');
    // The workflow id travels too: it is part of the STABLE pairing key, and
    // without it the same node id in two workflows would share one pairing.
    expect(call.args[2]).toEqual({ workflowId: 'wf1' });
  });

  it('renders a dialog offering exactly LOCAL and REMOTE', async () => {
    await openChooser(h);
    const envs = h.panel()!.find('tgt-card').map((c) => c.getAttribute('data-env'));
    expect(envs.sort()).toEqual(['local', 'remote']);
  });

  it('opens NO browser tab merely by being opened', async () => {
    // The whole bug: the crosshair used to reach the server's Chromium with no
    // decision point in between.
    await openChooser(h);
    expect(h.tabs).toEqual([]);
    expect(h.realBrowser).toEqual([]);
  });

  it('registers nothing until an environment is chosen', async () => {
    await openChooser(h);
    expect(h.calls.some((c) => c.fn === 'targetingBegin')).toBe(false);
  });

  it('refuses to start without a field identity', async () => {
    expect(h.flow.start({ nodeId: '', fieldKey: '' })).toBe(false);
    await settle();
    expect(h.calls).toEqual([]);
  });

  it('does NOT fall back to opening the remote browser when the client is absent', async () => {
    // Reinstating the old always-remote path whenever InspectorClient is
    // missing would make the original bug reappear under exactly the
    // conditions nobody exercises.
    const bare = boot({ options: OPTIONS_UNPAIRED });
    delete (bare.win as Record<string, unknown>).InspectorClient;
    expect(bare.flow.start(ctx(bare))).toBe(false);
    await settle();
    expect(bare.tabs).toEqual([]);
    expect(bare.realBrowser).toEqual([]);
    expect(bare.toasts).toContain('tgt.failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§2 — REMOTE needs no Authorization Code', () => {
  let h: Harness;
  beforeEach(() => {
    h = boot({
      options: OPTIONS_UNPAIRED,
      begin: (env: string) => (env === 'remote'
        ? {
          success: true, environment: 'remote', step: 'targeting',
          target: { ...TARGET, environment: 'remote' }, paired: true, openRemoteBrowser: true,
        }
        : null),
    });
  });

  it('the remote card advertises that no code is needed', async () => {
    await openChooser(h);
    expect(card(h, 'remote').find('tgt-card-note')[0].text()).toBe('tgt.noCode');
  });

  it('goes straight to targeting — no code screen', async () => {
    await openChooser(h);
    card(h, 'remote').fire('click');
    await settle();
    const begin = h.calls.filter((c) => c.fn === 'targetingBegin')[0];
    expect(begin.args[2]).toBe('remote');
    expect(h.flow.isOpen()).toBe(false);
  });

  it('opens the Remote Browser and hands it the pre-claimed tab', async () => {
    await openChooser(h);
    card(h, 'remote').fire('click');
    await settle();
    expect(h.realBrowser.length).toBe(1);
    expect(h.realBrowser[0].url).toBe('https://shop.example/p/1');
    expect(h.realBrowser[0].gotTab).toBe(true);
  });

  it('claims that tab SYNCHRONOUSLY, before the server is asked', async () => {
    // THE POPUP-BLOCKER RULE: window.open() only survives inside the click
    // gesture, so a tab opened after the await is silently blocked.
    await openChooser(h);
    card(h, 'remote').fire('click');
    expect(h.tabs.length).toBe(1);            // already open, still inside the click
    expect(h.calls.filter((c) => c.fn === 'targetingBegin').length).toBe(1);
    expect(h.realBrowser.length).toBe(0);     // the await has not resolved yet
    await settle();
    expect(h.realBrowser.length).toBe(1);
  });

  it('arms the field as remote', async () => {
    await openChooser(h);
    card(h, 'remote').fire('click');
    await settle();
    expect(h.armed).toEqual([
      { targetFieldId: 'node_8f21__product_selector__a73f', environment: 'remote' },
    ]);
    expect(h.toasts).toContain('tgt.readyRemote');
  });

  it('does not claim a tab for the LOCAL branch', async () => {
    const local = boot({
      options: OPTIONS_PAIRED,
      begin: {
        success: true, environment: 'local', step: 'targeting',
        target: TARGET, paired: true, rebound: 1, openRemoteBrowser: false,
      },
    });
    await openChooser(local);
    card(local, 'local').fire('click');
    await settle();
    expect(local.tabs).toEqual([]);
    expect(local.realBrowser).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§3 — LOCAL, first time for this field: a code is issued', () => {
  function bootUnpaired(status: unknown[] = []) {
    return boot({
      options: OPTIONS_UNPAIRED,
      begin: {
        success: true, environment: 'local', step: 'authorize', target: TARGET,
        paired: false, openRemoteBrowser: false,
        code: '48219930', display: '4821-9930',
        expiresAt: Date.now() + 300000, expiresInMs: 300000,
      },
      status,
    });
  }

  it('the local card warns a code is coming, BEFORE it is clicked', async () => {
    const h = bootUnpaired();
    await openChooser(h);
    expect(card(h, 'local').find('tgt-card-note')[0].text()).toBe('tgt.needsCode');
  });

  it('shows the code screen instead of starting the pick', async () => {
    const h = bootUnpaired();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    expect(h.flow.isOpen()).toBe(true);
    expect(h.panel()!.find('tgt-code')[0].text()).toBe('4821-9930');
    // Nothing is armed yet: the extension has not accepted the code.
    expect(h.armed).toEqual([]);
  });

  it('polls the server for the pairing, addressed by targetFieldId', async () => {
    const h = bootUnpaired([{ success: true, paired: false }]);
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    await h.tick();
    const poll = h.calls.filter((c) => c.fn === 'targetingStatus');
    expect(poll.length).toBe(1);
    expect(poll[0].args[0]).toBe('node_8f21__product_selector__a73f');
  });

  it('arms the field once the extension accepts the code', async () => {
    const h = bootUnpaired([{ success: true, paired: true, target: TARGET }]);
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    await h.tick();
    expect(h.panel()!.find('tgt-status')[0].text()).toBe('tgt.pairedNow');
    await h.flushTimeouts();
    expect(h.flow.isOpen()).toBe(false);
    expect(h.armed).toEqual([
      { targetFieldId: 'node_8f21__product_selector__a73f', environment: 'local' },
    ]);
    expect(h.toasts).toContain('tgt.readyLocal');
  });

  it('never opens the remote browser on the LOCAL path', async () => {
    const h = bootUnpaired([{ success: true, paired: true }]);
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    await h.tick();
    await h.flushTimeouts();
    expect(h.realBrowser).toEqual([]);
    expect(h.tabs).toEqual([]);
  });

  it('stops polling once the dialog is cancelled', async () => {
    const h = bootUnpaired([{ success: true, paired: false }]);
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    h.flow.close();
    await h.tick();
    // A timer outliving its dialog would arm a field the operator cancelled.
    expect(h.calls.filter((c) => c.fn === 'targetingStatus').length).toBe(0);
    expect(h.armed).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BOTH values, each with a Copy that really copies.
//
//   «Authorization UI باید هم AUTHORIZATION CODE و هم BASE URL را نمایش دهد،
//    هرکدام با یک Copy واقعی.»
//
// "Real" is the operative word, and it is why these tests watch the CLIPBOARD
// rather than the existence of a button. The previous code's Copy called
// navigator.clipboard.writeText inside a try/catch and rendered nothing at all:
// on an insecure origin — a plain-http LAN address, which is precisely where an
// operator reads a Base URL from — the promise rejected, the catch swallowed it,
// and the button looked exactly like a button that had worked. The operator then
// pasted whatever was on the clipboard before into the extension, and the
// pairing failed for a reason nowhere on screen.
// ═══════════════════════════════════════════════════════════════════════════
describe('§8 — the code and the Base URL are both copyable', () => {
  const OFFER = {
    success: true, environment: 'local', step: 'authorize', target: TARGET,
    paired: false, openRemoteBrowser: false,
    code: '48219930', display: '4821-9930',
    expiresAt: Date.now() + 300000, expiresInMs: 300000,
    baseUrl: 'https://panel.example.com', baseUrlSource: 'configured',
  };

  /** Open the code screen with a given clipboard environment. */
  async function codeScreen(over: Partial<Responses> = {}) {
    const h = boot({ options: OPTIONS_UNPAIRED, begin: OFFER, ...over });
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    return h;
  }

  const copyButtons = (h: Harness) => h.panel()!.find('tgt-btn')
    .filter((b) => b.className.indexOf('tgt-code-copy') >= 0
      || b.className.indexOf('tgt-base-copy') >= 0);
  const codeCopy = (h: Harness) => h.panel()!.find('tgt-code-copy')[0];
  const baseCopy = (h: Harness) => h.panel()!.find('tgt-base-copy')[0];

  it('shows both values on the same screen', async () => {
    const h = await codeScreen();
    expect(h.panel()!.find('tgt-code')[0].text()).toBe('4821-9930');
    expect(h.panel()!.find('tgt-base-url')[0].text()).toBe('https://panel.example.com');
  });

  it('gives each value its OWN Copy button', async () => {
    const h = await codeScreen();
    // Two buttons, not one that copies both: they go into two different fields
    // in the extension, so a combined copy would only have to be pulled apart
    // again by hand.
    expect(copyButtons(h).length).toBe(2);
    expect(codeCopy(h)).toBeTruthy();
    expect(baseCopy(h)).toBeTruthy();
  });

  it('labels the code, now that it is not the only value on screen', async () => {
    const h = await codeScreen();
    const labels = h.panel()!.find('tgt-base-label').map((n) => n.text());
    expect(labels).toContain('tgt.authCode');
    expect(labels).toContain('tgt.baseUrl');
  });

  it('copies the RAW code, not the grouped display form', async () => {
    const h = await codeScreen();
    codeCopy(h).fire('click');
    await h.settle();
    // The separators are cosmetic and the server normalises them away; pasting
    // them back is one more thing that can go wrong.
    expect(h.clipboard).toEqual([{ text: '48219930', via: 'api' }]);
  });

  it('copies the Base URL exactly as advertised', async () => {
    const h = await codeScreen();
    baseCopy(h).fire('click');
    await h.settle();
    expect(h.clipboard).toEqual([{ text: 'https://panel.example.com', via: 'api' }]);
  });

  it('confirms ON the button, so a click is distinguishable from a no-op', async () => {
    const h = await codeScreen();
    const b = codeCopy(h);
    expect(b.text()).toBe('insp.copy');
    b.fire('click');
    await h.settle();
    expect(b.text()).toBe('tgt.copied');
  });

  it('confirms only AFTER the write resolved, never before', async () => {
    const h = await codeScreen();
    const b = codeCopy(h);
    b.fire('click');
    // Not settled yet: a "Copied" here would be a claim the operator only
    // discovers to be false when they paste.
    expect(b.text()).toBe('insp.copy');
    await h.settle();
    expect(b.text()).toBe('tgt.copied');
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    // An insecure origin, or a document without focus. Both ordinary here.
    const h = await codeScreen({ clipboardFails: true });
    baseCopy(h).fire('click');
    await h.settle();
    expect(h.clipboard).toEqual([{ text: 'https://panel.example.com', via: 'exec' }]);
    expect(baseCopy(h).text()).toBe('tgt.copied');
  });

  it('falls back when the clipboard API is missing entirely', async () => {
    const h = await codeScreen({ noClipboardApi: true });
    codeCopy(h).fire('click');
    await h.settle();
    expect(h.clipboard).toEqual([{ text: '48219930', via: 'exec' }]);
  });

  it('leaves no textarea behind after the fallback', async () => {
    const h = await codeScreen({ clipboardFails: true });
    codeCopy(h).fire('click');
    await h.settle();
    // A survivor would be a hidden node a later copy could read from instead of
    // the intended value.
    expect(h.strayNodes()).toEqual([]);
  });

  it('says so, and how to recover, when nothing can be copied', async () => {
    const h = await codeScreen({ clipboardFails: true, execFails: true });
    const b = codeCopy(h);
    b.fire('click');
    await h.settle();
    expect(h.clipboard).toEqual([]);
    // Silence here is the worst outcome: the operator pastes the previous
    // clipboard contents and the pairing fails for an invisible reason.
    expect(b.text()).toBe('tgt.copyManual');
  });

  it('keeps the failure visible longer than a success', async () => {
    const ok = await codeScreen();
    codeCopy(ok).fire('click');
    await ok.settle();
    const okMs = ok.timers.filter((x) => !x.interval).map((x) => x.ms).pop();

    const bad = await codeScreen({ clipboardFails: true, execFails: true });
    codeCopy(bad).fire('click');
    await bad.settle();
    const badMs = bad.timers.filter((x) => !x.interval).map((x) => x.ms).pop();

    // "Copied" is a glance; an instruction to press Ctrl+C has to be read.
    expect(badMs!).toBeGreaterThan(okMs!);
  });

  it('still shows the code screen when the server sent no Base URL', async () => {
    // An older server. The address is omitted rather than invented — a made-up
    // Base URL presented this confidently is worse than none.
    const h = boot({
      options: OPTIONS_UNPAIRED,
      begin: { ...OFFER, baseUrl: undefined, baseUrlSource: undefined },
    });
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    expect(h.panel()!.find('tgt-code')[0].text()).toBe('4821-9930');
    expect(h.panel()!.find('tgt-base-url').length).toBe(0);
    expect(copyButtons(h).length).toBe(1);
  });

  it('names where the address came from, so a guess is not read as a fact', async () => {
    const h = await codeScreen();
    expect(h.panel()!.find('tgt-base-src')[0].text()).toBe('tgt.baseConfigured');

    const detected = boot({
      options: OPTIONS_UNPAIRED,
      begin: { ...OFFER, baseUrl: 'http://192.168.1.50:3000', baseUrlSource: 'detected' },
    });
    await openChooser(detected);
    card(detected, 'local').fire('click');
    await settle();
    expect(detected.panel()!.find('tgt-base-src')[0].text()).toBe('tgt.baseDetected');
  });

  it('the box disappears and success is announced once the code is accepted', async () => {
    const h = boot({
      options: OPTIONS_UNPAIRED,
      begin: OFFER,
      status: [{ success: true, paired: true, target: TARGET }],
    });
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    // Both values are on screen while the pairing is pending…
    expect(h.panel()!.find('tgt-code').length).toBe(1);
    expect(h.panel()!.find('tgt-base-url').length).toBe(1);

    await h.tick();
    await h.flushTimeouts();

    // …and gone once it lands, with a toast rather than a silent close. A
    // one-time code left on screen invites the operator to type it again.
    expect(h.flow.isOpen()).toBe(false);
    expect(h.backdrop()).toBeNull();
    expect(h.toasts).toContain('tgt.readyLocal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§4 — LOCAL again for the SAME field: no second code', () => {
  let h: Harness;
  beforeEach(() => {
    h = boot({
      options: OPTIONS_PAIRED,
      begin: {
        success: true, environment: 'local', step: 'targeting', target: TARGET,
        paired: true, rebound: 1, openRemoteBrowser: false,
      },
    });
  });

  it('the local card says "already paired" rather than warning about a code', async () => {
    await openChooser(h);
    expect(card(h, 'local').find('tgt-card-note')[0].text()).toBe('tgt.paired');
  });

  it('goes straight to targeting, showing no code at all', async () => {
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    expect(h.flow.isOpen()).toBe(false);
    expect(h.armed).toEqual([
      { targetFieldId: 'node_8f21__product_selector__a73f', environment: 'local' },
    ]);
    // The persistence requirement, stated as behaviour: nothing was polled,
    // because nothing was pending.
    expect(h.calls.some((c) => c.fn === 'targetingStatus')).toBe(false);
  });

  it('offers Unpair only when a pairing exists', async () => {
    await openChooser(h);
    expect(h.panel()!.find('tgt-btn').map((b) => b.text())).toContain('tgt.unpair');

    const fresh = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(fresh);
    expect(fresh.panel()!.find('tgt-btn').map((b) => b.text())).not.toContain('tgt.unpair');
  });

  it('unpairing is the ONE thing that brings the code back', async () => {
    await openChooser(h);
    const unpair = h.panel()!.find('tgt-btn').filter((b) => b.text() === 'tgt.unpair')[0];
    unpair.fire('click');
    await settle();
    const call = h.calls.filter((c) => c.fn === 'targetingUnpair')[0];
    expect(call.args[0]).toBe('8f21');
    expect(call.args[1]).toBe('product_selector');
    expect(call.args[2]).toEqual({ workflowId: 'wf1' });
    expect(h.toasts).toContain('tgt.unpaired');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§5 — a DIFFERENT field is a different pairing', () => {
  it("the operator's own scenario: product_selector paired, product_url is not", async () => {
    // «اگر کاربر یک Target Field جدید انتخاب کند، آن هدف جدید نیاز به
    //  Authorization/Pairing جدید دارد.»
    const paired = boot({ options: OPTIONS_PAIRED });
    await openChooser(paired);
    expect(card(paired, 'local').find('tgt-card-note')[0].text()).toBe('tgt.paired');

    const other = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(other, { nodeId: '92aa', fieldKey: 'product_url' });
    expect(card(other, 'local').find('tgt-card-note')[0].text()).toBe('tgt.needsCode');

    const asked = other.calls.filter((c) => c.fn === 'targetingOptions')[0];
    expect(asked.args[0]).toBe('92aa');
    expect(asked.args[1]).toBe('product_url');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§6 — refusals are loud, never a silent downgrade', () => {
  it('a disabled Local Browser is shown as unavailable and cannot be clicked', async () => {
    const h = boot({ options: OPTIONS_LOCAL_OFF });
    await openChooser(h);
    const local = card(h, 'local');
    expect(local.disabled).toBe(true);
    expect(local.find('tgt-card-note')[0].text()).toBe('tgt.localDisabled');
    local.fire('click');
    await settle();
    expect(h.calls.some((c) => c.fn === 'targetingBegin')).toBe(false);
  });

  it('a server refusal reports its reason and does NOT switch to remote', async () => {
    const h = boot({
      options: OPTIONS_UNPAIRED,
      begin: { success: false, reason: 'local_unavailable' },
    });
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    expect(h.toasts).toContain('tgt.localUnavailable');
    expect(h.realBrowser).toEqual([]);
    expect(h.armed).toEqual([]);
  });

  it('a failed remote begin closes the tab it optimistically claimed', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED, begin: null });
    await openChooser(h);
    card(h, 'remote').fire('click');
    await settle();
    expect(h.tabs.length).toBe(1);
    expect(h.tabs[0].closed).toBe(true);
    expect(h.toasts).toContain('tgt.failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§7 — the dialog behaves like a dialog', () => {
  it('only one chooser exists at a time', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(h);
    await openChooser(h);
    expect(h.body.childNodes.filter((c) => c.className === 'tgt-backdrop').length).toBe(1);
  });

  it('cancel removes it from the document', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(h);
    h.panel()!.find('tgt-btn').filter((b) => b.text() === 'tgt.cancel')[0].fire('click');
    expect(h.flow.isOpen()).toBe(false);
    expect(h.backdrop()).toBeNull();
  });

  it('a click on the backdrop cancels, but a click inside does not', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(h);
    const bd = h.backdrop()!;
    // A click that started on a card and drifted onto the backdrop must not be
    // read as "cancel".
    bd.fire('click', { target: h.panel() });
    expect(h.flow.isOpen()).toBe(true);
    bd.fire('click', { target: bd });
    expect(h.flow.isOpen()).toBe(false);
  });

  it('Escape closes it', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(h);
    h.docListeners.keydown.slice().forEach((fn) => fn({ key: 'Escape', preventDefault() {} }));
    expect(h.flow.isOpen()).toBe(false);
  });

  it('is marked up as a modal dialog', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(h);
    expect(h.panel()!.getAttribute('role')).toBe('dialog');
    expect(h.panel()!.getAttribute('aria-modal')).toBe('true');
  });

  it('names the field being targeted', async () => {
    const h = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(h);
    expect(h.panel()!.find('tgt-sub')[0].text()).toContain('Click → product_selector');
  });

  it('reports a failed options lookup instead of rendering an empty dialog', async () => {
    const h = boot({ options: null });
    await openChooser(h);
    expect(h.flow.isOpen()).toBe(false);
    expect(h.toasts).toContain('tgt.failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11 — REMOTE, THE SECOND TIME: DO NOT RELAUNCH A BROWSER THAT IS ALREADY UP
//
// Reported:
//
//   «اگر کاربر مرورگر رو نبنده و برم نود بعدی رو باز کنه و گیج میشه که الان من
//    مرورگرم بالا هست ایا نیازه مجدد ایکون پیکر رو بزنم تا مرورگر بالا بیاد
//    اگرم بیاد بهینه نیست»
//
//   «یعنی مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد در دفعالت تکراری و توی اون
//    الرت میگه که چه نودی، چه فیلدی»
//
// Two separate promises live here, and they pull in opposite directions:
//
//   1. When the browser IS up, do not relaunch it — the operator loses the page
//      they were working on and pays a cold start for nothing. The consent prompt
//      is already rendering in the tab they are looking at.
//   2. When anything is uncertain, DO launch. A spurious "already up" is the one
//      failure that strands the flow with no way forward, so every doubtful case
//      below asserts the old behaviour is preserved.
// ═══════════════════════════════════════════════════════════════════════════
describe('§11 — a live Remote Browser is reused, not relaunched', () => {
  /** REMOTE plan + a consent prompt, which is what the server now returns. */
  function remotePlan(over: Record<string, unknown> = {}) {
    return {
      success: true, environment: 'remote', step: 'targeting',
      target: { ...TARGET, environment: 'remote' }, paired: true,
      openRemoteBrowser: true,
      consent: { consentId: 'cns_' + 'a1b2c3d4e5f6a1b2c3d4e5f6', state: 'pending', reused: false },
      ...over,
    };
  }

  /**
   * `planOver` patches the SERVER'S PLAN; `over` patches the harness.
   *
   * Kept as two arguments on purpose. An earlier version funnelled both through
   * `Responses.begin`, so patching the plan also overwrote the `begin` function
   * with a plain object — targetingBegin() then resolved to that object, the flow
   * saw no `success`, and the test "failed" on tgt.failed while appearing to
   * measure the toast wording. Two parameters make that mistake unexpressible.
   */
  function bootRemote(over: Partial<Responses> = {}, planOver: Record<string, unknown> = {}) {
    return boot({
      options: OPTIONS_UNPAIRED,
      ...over,
      begin: (env: string) => (env === 'remote' ? remotePlan(planOver) : null),
    });
  }

  async function pickRemote(h: Harness) {
    await openChooser(h);
    card(h, 'remote').fire('click');
    await settle();
    await settle();
  }

  it('does NOT relaunch when the browser is already up and answering', async () => {
    const h = bootRemote({ remoteLive: true });
    await pickRemote(h);

    // THE FIX: «مرورگر مجدد بالا نمیاد».
    expect(h.realBrowser.length).toBe(0);
    // And the field is still armed — skipping the launch must not skip the arming.
    expect(h.armed.length).toBe(1);
    expect(h.armed[0].environment).toBe('remote');
  });

  it('DOES launch when the browser is not up', async () => {
    const h = bootRemote({ remoteLive: false });
    await pickRemote(h);
    expect(h.realBrowser.length).toBe(1);
    expect(h.realBrowser[0].gotTab).toBe(true);
    expect(h.armed.length).toBe(1);
  });

  it('closes the speculatively-claimed tab when it turns out not to be needed', async () => {
    // The tab is claimed synchronously to beat the popup blocker. If the browser
    // is already up that tab is surplus, and leaving it would park a blank window
    // on screen — indistinguishable, to the operator, from the broken relaunch
    // this whole branch exists to prevent.
    const h = bootRemote({ remoteLive: true });
    await pickRemote(h);
    expect(h.tabs.length).toBe(1);
    expect(h.tabs[0].closed).toBe(true);
  });

  it('still claims the tab synchronously — the popup-blocker rule is untouched', async () => {
    const h = bootRemote({ remoteLive: true });
    await openChooser(h);
    card(h, 'remote').fire('click');
    // No await: the tab must exist before the server is ever asked, or the
    // browser would have blocked it.
    expect(h.tabs.length).toBe(1);
  });

  it('tells the operator to answer in the browser, not that one is opening', async () => {
    const h = bootRemote({ remoteLive: true });
    await pickRemote(h);
    // «فقط الرت بالا میاد» — the honest instruction. Announcing "opening the
    // Remote Browser…" would promise a tab that never appears.
    expect(h.toasts).toContain('tgt.consentAsked');
    expect(h.toasts).not.toContain('tgt.readyRemote');
  });

  it('says "still waiting" when the server refreshed an existing prompt', async () => {
    // reused=true means the operator pressed the picker twice for the SAME field.
    // There is no second question to answer, so claiming a new prompt arrived
    // would send them looking for one.
    const h = bootRemote(
      { remoteLive: true },
      { consent: { consentId: 'cns_x', state: 'pending', reused: true } },
    );
    await pickRemote(h);
    expect(h.toasts).toContain('tgt.consentWaiting');
    expect(h.toasts).not.toContain('tgt.consentAsked');
  });

  it('keeps the original wording when it actually launches', async () => {
    const h = bootRemote({ remoteLive: false });
    await pickRemote(h);
    expect(h.toasts).toContain('tgt.readyRemote');
    expect(h.toasts).not.toContain('tgt.consentAsked');
  });

  it('launches when the dashboard has no liveness probe at all', async () => {
    // An older bundle without remoteBrowserLive() must behave exactly as before
    // rather than silently never opening a browser again.
    const h = bootRemote({}); // remoteLive undefined -> method absent
    await pickRemote(h);
    expect(h.calls.some((c) => c.fn === 'remoteBrowserLive')).toBe(false);
    expect(h.realBrowser.length).toBe(1);
    expect(h.toasts).toContain('tgt.readyRemote');
  });

  it('asks the probe exactly once per pick', async () => {
    // A probe per pick, not per poll: this runs on a user gesture and must not
    // turn into background traffic.
    const h = bootRemote({ remoteLive: true });
    await pickRemote(h);
    expect(h.calls.filter((c) => c.fn === 'remoteBrowserLive').length).toBe(1);
  });

  it('never probes on the LOCAL branch', async () => {
    // LOCAL has nothing to relaunch; asking would be a pointless request and a
    // confusing dependency between two independent paths.
    const h = boot({
      options: OPTIONS_PAIRED,
      remoteLive: true,
      begin: (env: string) => (env === 'local'
        ? {
          success: true, environment: 'local', step: 'targeting',
          target: TARGET, paired: true, openRemoteBrowser: false,
        }
        : null),
    });
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    await settle();
    expect(h.calls.some((c) => c.fn === 'remoteBrowserLive')).toBe(false);
    expect(h.realBrowser.length).toBe(0);
    expect(h.toasts).toContain('tgt.readyLocal');
  });

  it('arms the field even when there is no BrowserView to open one with', async () => {
    // Nothing can be launched AND nothing can be reused, so the only correct
    // outcome is to arm the field anyway rather than drop the pick silently.
    const h = bootRemote({ remoteLive: true });
    delete (h.win as Record<string, unknown>).BrowserView;
    await pickRemote(h);
    expect(h.realBrowser.length).toBe(0);
    expect(h.armed.length).toBe(1);
  });
});
