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
 * The branches originally differed in whether an Authorization Code was issued:
 * REMOTE «نیازی به Authorization Code نیست», LOCAL issued one for that Target
 * Field the first time. That is no longer the contract. `LOCAL BROWSER` means the
 * Browser Runtime on the same Server/Infrastructure the backend runs on, so
 * NEITHER environment issues a code and the operator types nothing in either:
 *
 *   LOCAL  — «internal automatic Base URL → no API Key → no Authorization →
 *             no Alert → اتصال خودکار»
 *   REMOTE — address resolved from the server's own configuration, no code, but
 *            a Remote Approval prompt, because that browser is shared across
 *            targeting runs and the prompt names which field the next pick is for
 *
 * The requirement also insists this be genuinely implemented rather than
 * "displayed cosmetically in the Popup", so these tests assert what the dialog
 * DOES — which endpoint it drove, which tab it opened, what it wrote to the
 * clipboard — and never that a particular string appears in the source.
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

// The options fixtures mirror what `environmentOptions()` in
// src/core/BrowserEnvironment.ts actually builds, field for field. Two of those
// fields changed with the contract and the fixtures had kept the old shape,
// which is why so much of this file was asserting a UI that no longer exists:
//
//   needsAuthorization  — now the literal `false` in every option, in every
//                         state. It was `true` for a first-time LOCAL field.
//   needsRemoteApproval — new, and the ONE asymmetry left between the two
//                         environments: REMOTE raises an approval prompt in the
//                         browser it shares across runs, LOCAL never does.
//   paired              — reported `true` for both whenever the server may grant,
//                         which it now may for LOCAL too.
const OPTIONS_UNPAIRED = {
  success: true,
  pairingKey: 'tf:wf1:8f21:product_selector',
  paired: false,
  localEnabled: true,
  mode: 'remote',
  options: [
    { id: 'local', available: true, paired: true, needsAuthorization: false, needsRemoteApproval: false, note: '' },
    { id: 'remote', available: true, paired: true, needsAuthorization: false, needsRemoteApproval: true, note: '' },
  ],
};

const OPTIONS_PAIRED = {
  ...OPTIONS_UNPAIRED,
  paired: true,
  options: [
    { id: 'local', available: true, paired: true, needsAuthorization: false, needsRemoteApproval: false, note: '' },
    { id: 'remote', available: true, paired: true, needsAuthorization: false, needsRemoteApproval: true, note: '' },
  ],
};

const OPTIONS_LOCAL_OFF = {
  ...OPTIONS_UNPAIRED,
  localEnabled: false,
  options: [
    { id: 'local', available: false, paired: false, needsAuthorization: false, needsRemoteApproval: false, note: 'local_disabled' },
    { id: 'remote', available: true, paired: true, needsAuthorization: false, needsRemoteApproval: true, note: '' },
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
describe('§2 — REMOTE needs no Authorization Code either, only an approval', () => {
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

  it('advertises the approval prompt, which is the only thing left to warn about', async () => {
    // WAS `tgt.noCode` — a badge that said "no Authorization Code needed" and
    // only made sense while the OTHER card still produced one. Neither does, so
    // the phrase distinguishes nothing; what genuinely differs is that REMOTE
    // asks the operator to approve inside the browser it shares across runs.
    await openChooser(h);
    expect(card(h, 'remote').find('tgt-card-note')[0].text()).toBe('tgt.needsApproval');
  });

  it('never says a code is coming, in either card', async () => {
    await openChooser(h);
    const notes = [
      card(h, 'local').find('tgt-card-note')[0].text(),
      card(h, 'remote').find('tgt-card-note')[0].text(),
    ];
    expect(notes).not.toContain('tgt.needsCode');
    expect(notes).not.toContain('tgt.noCode');
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
describe('§3 — LOCAL, first time for this field: attached automatically', () => {
  // WHAT THIS SECTION USED TO ASSERT, and why every test in it changed.
  //
  // It described the reported defect. A first-time LOCAL field came back with
  // `step: 'authorize'` plus `code` / `display` / `expiresAt`, the dialog drew a
  // code screen, and it then POLLED `targetingStatus` once a second until the
  // operator had retyped that code into their extension popup. Only then was the
  // field armed.
  //
  // The requirement is that LOCAL is the Browser Runtime on the same server Plyr
  // runs on. There is no second machine to authorize to, so `begin` attaches the
  // field itself and answers `paired: true, runtime: 'server-local'`. The dialog
  // now renders what the server ALREADY did — runtime ready, context resolved,
  // target resolved, connected — arms the field immediately, and closes itself.
  //
  // The tests were rewritten rather than deleted because the properties they
  // guarded still matter: nothing is polled, no code is shown, no remote browser
  // is opened, and the flow still ends at an armed crosshair.
  function bootLocal() {
    return boot({
      options: OPTIONS_UNPAIRED,
      begin: {
        success: true, environment: 'local', step: 'targeting', target: TARGET,
        paired: true, rebound: 0, openRemoteBrowser: false,
        runtime: 'server-local', consent: null,
      },
    });
  }

  it('the local card promises an automatic connection, BEFORE it is clicked', async () => {
    const h = bootLocal();
    await openChooser(h);
    // WAS `tgt.needsCode` — "an Authorization Code will be shown".
    expect(card(h, 'local').find('tgt-card-note')[0].text()).toBe('tgt.automatic');
  });

  it('shows the resolved steps instead of a code screen', async () => {
    const h = bootLocal();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();

    // The progression the requirement spells out: detect the runtime, resolve
    // the internal backend context, resolve the target.
    const names = h.panel()!.find('tgt-step-name').map((n) => n.text());
    expect(names).toEqual(['tgt.stepRuntime', 'tgt.stepContext', 'tgt.stepTarget']);
    // And nothing to copy, in either of the two shapes it used to take.
    expect(h.panel()!.find('tgt-code')).toHaveLength(0);
    expect(h.panel()!.find('tgt-base-url')).toHaveLength(0);
  });

  it('names what it connected to, so "Connected to Target" is not a bare claim', async () => {
    const h = bootLocal();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();

    const values = h.panel()!.find('tgt-target-value').map((n) => n.text());
    expect(values).toContain('8f21');
    expect(values).toContain('product_selector');
    expect(values).toContain('node_8f21__product_selector__a73f');
    expect(h.panel()!.find('tgt-status')[0].text()).toBe('tgt.readyToSend');
  });

  it('polls nothing at all, because nothing is pending', async () => {
    const h = bootLocal();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    await h.tick();

    // WAS: exactly one targetingStatus call per tick, addressed by
    // targetFieldId, until the code was redeemed.
    expect(h.calls.filter((c) => c.fn === 'targetingStatus')).toHaveLength(0);
  });

  it('arms the field on the spot, then closes itself', async () => {
    const h = bootLocal();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();

    // Armed BEFORE the dialog goes away: the dialog is a report, not a gate.
    expect(h.armed).toEqual([
      { targetFieldId: 'node_8f21__product_selector__a73f', environment: 'local' },
    ]);
    expect(h.toasts).toContain('tgt.readyLocal');

    expect(h.flow.isOpen()).toBe(true);
    await h.flushTimeouts();
    expect(h.flow.isOpen()).toBe(false);
    expect(h.backdrop()).toBeNull();
  });

  it('never opens the remote browser on the LOCAL path', async () => {
    const h = bootLocal();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    await h.flushTimeouts();
    expect(h.realBrowser).toEqual([]);
    expect(h.tabs).toEqual([]);
  });

  it('leaves no timer behind when the dialog is cancelled', async () => {
    // The old worry was a poll outliving its dialog and arming a field the
    // operator had cancelled. The self-close timeout raises the same question,
    // so it is asked the same way.
    const h = bootLocal();
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    h.flow.close();
    await h.flushTimeouts();

    expect(h.flow.isOpen()).toBe(false);
    expect(h.backdrop()).toBeNull();
    expect(h.calls.filter((c) => c.fn === 'targetingStatus')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 — THE SCREEN THOSE COPY BUTTONS SERVED NO LONGER EXISTS
//
// WHAT WAS HERE. Fifteen tests over the LOCAL Authorization Code dialog and its
// two Copy buttons, written against this requirement:
//
//   «Authorization UI باید هم AUTHORIZATION CODE و هم BASE URL را نمایش دهد،
//    هرکدام با یک Copy واقعی.»
//
// They were good tests of a real defect: the old Copy called
// navigator.clipboard.writeText inside a try/catch and rendered nothing, so on an
// insecure origin — a plain-http LAN address, exactly where an operator reads a
// Base URL from — the promise rejected, the catch swallowed it, and the button
// looked like one that had worked.
//
// WHY THEY ARE GONE. That requirement was superseded by the one this change
// implements: `LOCAL BROWSER` is the Browser Runtime on the SAME server the
// backend runs on. Both values it asked the operator to carry — the code and the
// address — are now resolved internally and never displayed:
//
//   «LOCAL BROWSER → Browser روی همان Server → internal automatic Base URL →
//    no API Key → no Authorization → no Alert → automatic connection»
//
// So targeting-flow.js has no writeClipboard(), copyButton() or baseUrlRow() left
// to test. Fifteen tests of a deleted screen are replaced by three that pin the
// deletion, because that is the property worth defending now: nothing in this
// dialog may ever ask the operator to copy a credential again.
//
// The clipboard machinery in the harness above is deliberately KEPT. It records
// every write and the path taken, which is what makes "copies nothing" provable
// rather than merely unobserved.
describe('§8 — the LOCAL flow asks the operator to copy nothing', () => {
  /** Drive the full LOCAL path, in the automatic form it now takes. */
  async function localFlow(over: Partial<Responses> = {}) {
    const h = boot({
      options: OPTIONS_UNPAIRED,
      begin: {
        success: true, environment: 'local', step: 'targeting', target: TARGET,
        paired: true, openRemoteBrowser: false, runtime: 'server-local', consent: null,
      },
      ...over,
    });
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();
    return h;
  }

  it('renders no Copy button, and no value to copy', async () => {
    const h = await localFlow();
    const panel = h.panel()!;
    // The four nodes the deleted screen was made of.
    expect(panel.find('tgt-code')).toHaveLength(0);
    expect(panel.find('tgt-code-copy')).toHaveLength(0);
    expect(panel.find('tgt-base-url')).toHaveLength(0);
    expect(panel.find('tgt-base-copy')).toHaveLength(0);
  });

  it('writes to the clipboard on no path, neither API nor fallback', async () => {
    const h = await localFlow();
    await h.settle();

    // Recorded from BOTH paths, so this cannot pass merely because the modern
    // API was unavailable and the execCommand fallback quietly took over.
    expect(h.clipboard).toEqual([]);
    expect(h.strayNodes()).toEqual([]);
  });

  it('completes normally on an origin where copying would have failed', async () => {
    // The old screen's worst case: an insecure origin, where writeText rejects
    // and execCommand fails too. It used to strand the operator with a code they
    // could not copy. Nothing is copied now, so the same environment must simply
    // be irrelevant — the field still arms.
    const h = await localFlow({ clipboardFails: true, execFails: true });
    await h.settle();

    expect(h.clipboard).toEqual([]);
    expect(h.armed).toEqual([
      { targetFieldId: 'node_8f21__product_selector__a73f', environment: 'local' },
    ]);
    expect(h.toasts).toContain('tgt.readyLocal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§4 — LOCAL again for the SAME field: still nothing to do', () => {
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

  it('reads the same on the second visit as on the first', async () => {
    // WAS `tgt.paired` ("already paired") — the second half of a pair of badges
    // whose only job was to tell the operator whether a code was coming this
    // time. With no code in either case there is nothing to distinguish, and
    // `environmentOptions()` reports LOCAL as paired whenever the server may
    // grant, which is always. Two badges that promise the same thing in
    // different words would only invite the reader to look for a difference.
    await openChooser(h);
    expect(card(h, 'local').find('tgt-card-note')[0].text()).toBe('tgt.automatic');
  });

  it('goes straight to targeting, showing no code at all', async () => {
    await openChooser(h);
    card(h, 'local').fire('click');
    await settle();

    // The field is armed the moment the server answers. The report dialog is
    // still on screen at this point — it closes itself on a timer, which is
    // asserted in §3 — so `isOpen()` is checked AFTER that timer runs rather
    // than expected to be false already.
    expect(h.armed).toEqual([
      { targetFieldId: 'node_8f21__product_selector__a73f', environment: 'local' },
    ]);
    expect(h.panel()!.find('tgt-code')).toHaveLength(0);

    await h.flushTimeouts();
    expect(h.flow.isOpen()).toBe(false);

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

  it('unpairing still reaches the route that deliberately forgets a pairing', async () => {
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
describe('§5 — a DIFFERENT field is a different pairing, and needs no setup either', () => {
  it("the operator's own scenario: product_selector attached, product_url the same", async () => {
    // WAS: the paired field showed `tgt.paired`, the new one `tgt.needsCode`,
    // against «اگر کاربر یک Target Field جدید انتخاب کند، آن هدف جدید نیاز به
    // Authorization/Pairing جدید دارد» — a new field meant a new code.
    //
    // The PAIRING is still per-field: the pairingKey is built from workflow, node
    // and field, and the server mints and binds a separate one for the second
    // field. What is gone is the SETUP that used to accompany it. So the property
    // under test moves from "a new field asks for a code" to "a new field is a
    // distinct destination, resolved just as automatically as the first".
    const paired = boot({ options: OPTIONS_PAIRED });
    await openChooser(paired);
    expect(card(paired, 'local').find('tgt-card-note')[0].text()).toBe('tgt.automatic');

    const other = boot({ options: OPTIONS_UNPAIRED });
    await openChooser(other, { nodeId: '92aa', fieldKey: 'product_url' });
    expect(card(other, 'local').find('tgt-card-note')[0].text()).toBe('tgt.automatic');

    // The part that must NOT collapse: the second field is asked about on its
    // own identity, never inheriting the first one's answer.
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
