/* ============================================================================
   RETRY — the same Picker flow, for its OWN field, without another tab.

   WHAT WAS ASKED FOR
   ------------------
     «یک دکمه Retry کنار Picker اضافه شود»
     «Retry باید دقیقاً همان کاری را انجام دهد که Picker انجام می‌دهد، با این
      تفاوت که Tab جدیدی در Browser اصلی باز نمی‌کند»

   and the correction that reshaped this file, because it is the one a careless
   implementation gets wrong while still passing a demo:

     «Retry دیگر نباید بر مبنای `lastPickerTarget` باشد … Retry باید همان Picker
      را دوباره اجرا کند، با همان target/contextی که دکمه Retry در همان موقعیت به
      آن مربوط است.»

   So Retry no longer means «repeat the last Pick». It is the button that sits
   beside ONE field, and it re-runs THAT field:

     Picker → showPickerAlert(ctx, { mayOpenTab: true  })
     Retry  → showPickerAlert(ctx, { mayOpenTab: false })

   There is no shared "last pick" slot any more, so the two entry points differ
   in exactly one thing — whether the press may put a viewer tab in the
   operator's own browser.

   WHY THE MODULE IS RUN FOR REAL
   ------------------------------
   `public/js/targeting-flow.js` is a browser IIFE, so it is evaluated in a `vm`
   against a DOM built here. The alternative — reading the source and asserting
   on its text — cannot tell whether `mayOpenTab` actually ARRIVES at
   `openRealBrowser`, and that thread through four functions is the whole point.
   ========================================================================= */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'public/js/targeting-flow.js'), 'utf8');
const NDV = readFileSync(join(ROOT, 'public/js/ndv-nodes.js'), 'utf8');

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
  style: Record<string, string> = {};
  value = '';
  selected = false;
  listeners: Record<string, Array<(e: unknown) => void>> = {};

  /**
   * WHO HOLDS THIS NODE — required, not decorative.
   *
   * `closeDialog()` in the module under test detaches its backdrop with
   * `d.backdrop.parentNode.removeChild(d.backdrop)`. Without a real
   * `parentNode` that branch does nothing, closed dialogs stay in <body>, and
   * a helper that looks up "the chooser" keeps finding the FIRST, stale one.
   */
  parentNode: El | null = null;

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
  focus() { /* nothing observable is asserted about focus here */ }
  select() { this.selected = true; }
  addEventListener(ev: string, fn: (e: unknown) => void) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  removeEventListener(ev: string, fn: (e: unknown) => void) {
    const l = this.listeners[ev] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  fire(ev: string, e: unknown = { target: this }) {
    (this.listeners[ev] || []).slice().forEach((fn) => fn(e));
  }
  find(cls: string): El[] {
    const out: El[] = [];
    const walk = (n: El) => {
      if (n.className.split(/\s+/).indexOf(cls) >= 0) out.push(n);
      n.childNodes.forEach(walk);
    };
    walk(this);
    return out;
  }
}

/** A tab claimed through window.open(), and what became of it. */
type Opened = { url: string; target: string; closed: boolean };

/** One openRealBrowser() call, including the flag this whole file is about. */
type RealCall = { url: string; gotTab: boolean; noTab: boolean | undefined };

type Flow = {
  start(ctx: unknown): boolean;
  retry(ctx: unknown): boolean;
  close(): void;
  isOpen(): boolean;
};

type Harness = {
  win: Record<string, unknown>;
  body: El;
  flow: Flow;
  calls: Array<{ fn: string; args: unknown[] }>;
  /** Tabs claimed in the OPERATOR'S browser, in order. The core assertion. */
  opens: Opened[];
  /** Calls into BrowserView, which launches the browser ON THE SERVER. */
  realBrowser: RealCall[];
  toasts: string[];
  armed: Array<{ targetFieldId: string; environment: string }>;
  panel(): El | null;
  settle(): Promise<void>;
};

const OPTIONS = {
  success: true,
  pairingKey: 'tf:wf1:nodeA:field3',
  paired: false,
  localEnabled: true,
  mode: 'remote',
  options: [
    { id: 'local', available: true, paired: true, needsAuthorization: false, needsInPageApproval: true, opensServerBrowser: true, note: '' },
    { id: 'remote', available: true, paired: false, needsAuthorization: true, needsInPageApproval: false, opensServerBrowser: false, note: '' },
  ],
};

const TARGET = {
  targetFieldId: 'node_nodeA__field3__a73f',
  pairingKey: 'tf:wf1:nodeA:field3',
  nodeId: 'nodeA',
  fieldKey: 'field3',
  environment: 'local',
};

function boot(res: { serverLive?: boolean } = {}): Harness {
  const body = new El('body');
  const calls: Harness['calls'] = [];
  const opens: Opened[] = [];
  const realBrowser: RealCall[] = [];
  const toasts: string[] = [];
  const armed: Harness['armed'] = [];
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};

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
    execCommand: () => false,
  };

  const win: Record<string, unknown> = {
    AppUtil: {
      t: (k: string) => k,
      toast: (m: string) => { toasts.push(m); },
    },
    InspectorClient: {
      targetingOptions: (nodeId: string, fieldKey: string, opts: unknown) => {
        calls.push({ fn: 'targetingOptions', args: [nodeId, fieldKey, opts] });
        return Promise.resolve(OPTIONS);
      },
      targetingBegin: (nodeId: string, fieldKey: string, environment: string, opts: unknown) => {
        calls.push({ fn: 'targetingBegin', args: [nodeId, fieldKey, environment, opts] });
        /**
         * `openServerBrowser` IS LOAD-BEARING IN THIS FAKE.
         *
         * It is the server's own flag, and `choose()` branches on it — not on
         * the `environment` argument — to reach `openOrReuseServerBrowser()`.
         * Omitting it sends the flow down the "already bound" path instead, so
         * `openRealBrowser` is never called, `realBrowser` stays empty, and
         * every `noTab` assertion below passes VACUOUSLY over an empty array.
         */
        return Promise.resolve({
          success: true,
          target: TARGET,
          openServerBrowser: environment === 'local',
          environment,
          consent: { reused: false },
        });
      },
      targetingStatus: (targetFieldId: string) => {
        calls.push({ fn: 'targetingStatus', args: [targetFieldId] });
        return Promise.resolve({ success: true, paired: false });
      },
      targetingUnpair: () => Promise.resolve(true),
      ...(res.serverLive === undefined ? {} : {
        serverBrowserLive: () => {
          calls.push({ fn: 'serverBrowserLive', args: [] });
          return Promise.resolve(res.serverLive);
        },
      }),
    },
    BrowserView: {
      /**
       * Records the THIRD argument, which is the entire point of this file:
       * `{noTab:true}` is how Retry tells the launcher "bring the server's
       * browser up if it is down, but do not put a viewer on my screen".
       */
      openRealBrowser: (url: string, tab: unknown, o?: { noTab?: boolean }) => {
        realBrowser.push({ url, gotTab: !!tab, noTab: o ? o.noTab : undefined });
        return Promise.resolve({ success: true });
      },
    },
    open(url: string, target: string) {
      const rec: Opened = { url, target, closed: false };
      opens.push(rec);
      // `location` is assignable because openRealBrowser navigates a claimed
      // tab that way; `close()` is recorded because the flow closes a tab it
      // claimed but turned out not to need.
      return { close() { rec.closed = true; }, location: '' };
    },
  };

  const sandbox: Record<string, unknown> = {
    window: win,
    document,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    Promise,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const settleOnce = () => new Promise<void>((r) => setImmediate(r));

  const h: Harness = {
    win, body, calls, opens, realBrowser, toasts, armed,
    flow: win.TargetingFlow as Flow,
    panel() {
      // The LAST backdrop, not the first: if a close ever fails to detach, the
      // freshest dialog is still the one under test, and the test fails for the
      // right reason instead of silently reading a corpse.
      const backs = body.childNodes.filter((c) => c.className === 'tgt-backdrop');
      const b = backs[backs.length - 1];
      return b ? b.find('tgt-panel')[0] || null : null;
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) await settleOnce();
    },
  };
  return h;
}

/**
 * The pick context ndv-nodes.js supplies. Defaults to Node A / Field 3.
 *
 * BOTH `start` and `retry` now take this: the field travels WITH the call
 * rather than being remembered between presses.
 */
function ctx(h: Harness, over: Record<string, unknown> = {}) {
  return {
    nodeId: 'nodeA',
    fieldKey: 'field3',
    action: 'click',
    workflowId: 'wf1',
    label: 'Click → field3',
    url: 'https://shop.example/p/1',
    onArmed: (target: { targetFieldId?: string }, environment: string) => {
      h.armed.push({ targetFieldId: (target && target.targetFieldId) || '', environment });
    },
    ...over,
  };
}

function localCard(h: Harness): El {
  const p = h.panel();
  if (!p) throw new Error('no panel rendered');
  const found = p.find('tgt-card').filter((c) => c.getAttribute('data-env') === 'local');
  if (!found.length) throw new Error('no local card');
  return found[0];
}

/** Press a field's crosshair and let the options round-trip paint the chooser. */
async function picker(h: Harness, over: Record<string, unknown> = {}) {
  const ok = h.flow.start(ctx(h, over));
  await h.settle();
  return ok;
}

/** Press Retry — handing it THIS field's context, as the button does. */
async function retry(h: Harness, over: Record<string, unknown> = {}) {
  const ok = h.flow.retry(ctx(h, over));
  await h.settle();
  return ok;
}

/** Choose LOCAL — the server's own browser. */
async function chooseLocal(h: Harness) {
  localCard(h).fire('click');
  await h.settle();
}

/** The node+field pairs the flow asked the server for, in order. */
function askedFields(h: Harness): string[] {
  return h.calls
    .filter((c) => c.fn === 'targetingOptions')
    .map((c) => String(c.args[0]) + '/' + String(c.args[1]));
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Retry runs ITS OWN field, and no longer "the last pick"', () => {
  let h: Harness;
  beforeEach(() => { h = boot({ serverLive: true }); });

  it('exposes start and retry — and NOT a shared last-pick slot', () => {
    expect(typeof h.flow.start).toBe('function');
    expect(typeof h.flow.retry).toBe('function');
    // The removed API. `canRetry`/`lastTarget` only existed to read the shared
    // slot; with no slot there is nothing for them to mean.
    expect((h.flow as unknown as Record<string, unknown>).canRetry).toBeUndefined();
    expect((h.flow as unknown as Record<string, unknown>).lastTarget).toBeUndefined();
  });

  it('does not depend on any prior pick — Retry works with a target of its own', async () => {
    // No crosshair has ever been pressed, yet Retry runs: proof it reads its
    // argument, not a remembered slot.
    expect(h.calls.filter((c) => c.fn === 'targetingOptions')).toHaveLength(0);
    const ok = await retry(h, { fieldKey: 'field1' });
    expect(ok).toBe(true);
    expect(askedFields(h)).toEqual(['nodeA/field1']);
  });

  it('RUNS ITS OWN FIELD even when a DIFFERENT field was picked last', async () => {
    // The defect this change exists to remove: the operator last pressed
    // field3, but this Retry sits beside field1 — so it must run field1.
    await picker(h, { fieldKey: 'field3', label: 'Click → field3' });
    h.calls.length = 0;

    await retry(h, { fieldKey: 'field1', label: 'Click → field1' });

    expect(askedFields(h)).toEqual(['nodeA/field1']);
  });

  it('never re-runs the other fields of the node behind the operator back', async () => {
    await picker(h, { fieldKey: 'field1' });
    await picker(h, { fieldKey: 'field2' });
    await picker(h, { fieldKey: 'field3' });
    h.calls.length = 0;

    await retry(h, { fieldKey: 'field2' });

    // Exactly one field asked, and it is the one Retry was handed.
    expect(askedFields(h)).toEqual(['nodeA/field2']);
  });

  it('follows each button independently across nodes', async () => {
    await picker(h, { nodeId: 'nodeA', fieldKey: 'field1' });
    h.calls.length = 0;
    await retry(h, { nodeId: 'nodeB', fieldKey: 'field2' });
    expect(askedFields(h)).toEqual(['nodeB/field2']);
  });

  it('refuses, without opening anything, when handed no field identity', async () => {
    expect(h.flow.retry({})).toBe(false);
    expect(h.flow.retry({ nodeId: 'nodeA' })).toBe(false);
    await h.settle();
    expect(h.flow.isOpen()).toBe(false);
    expect(h.calls.filter((c) => c.fn === 'targetingOptions')).toHaveLength(0);
  });

  it('never asks the operator which field again', async () => {
    await retry(h);
    // The chooser it opens is the ENVIRONMENT chooser (local/remote). No field
    // picker appears, because the field came with the call.
    const p = h.panel();
    expect(p).toBeTruthy();
    expect((p as El).find('tgt-card').length).toBe(2);
  });

  it('keeps the ROW ADDRESS, so a retried condition-row pick lands in the row', async () => {
    // Without rowPath a retried pick delivers into the action's top-level
    // `selector` — the row-routing defect arriving through a new door.
    await retry(h, { rowPath: 'p1/0/2' });
    await chooseLocal(h);
    const begun = h.calls.filter((c) => c.fn === 'targetingBegin')[0];
    expect(begun).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Retry opens NO tab in the operator's own browser", () => {
  let h: Harness;
  beforeEach(() => { h = boot({ serverLive: true }); });

  it('PICKER may claim a tab — that is part of its flow', async () => {
    await picker(h);
    await chooseLocal(h);
    expect(h.opens.length).toBe(1);
  });

  it('RETRY claims none', async () => {
    await picker(h);
    await chooseLocal(h);
    const afterPicker = h.opens.length;

    await retry(h);
    await chooseLocal(h);

    expect(h.opens.length).toBe(afterPicker);
  });

  it('launches NOTHING when the server browser is already live', async () => {
    // With the browser up and `mayOpenTab:false`, no tab was claimed, so the
    // already-live branch has no tab to bring forward and deliberately has no
    // `else`. The Alert this pick raised renders as an OVERLAY inside the page
    // that browser is showing, so there is nothing to launch and nothing to
    // display: «صفر Tab جدید / صفر navigation».
    await picker(h);
    await chooseLocal(h);
    h.realBrowser.length = 0;

    await retry(h);
    await chooseLocal(h);

    expect(h.realBrowser).toEqual([]);
    expect(h.opens).toHaveLength(1); // still only the PICKER's tab
  });

  it('does NOT set noTab on the picker path', async () => {
    await picker(h);
    await chooseLocal(h);
    expect(h.realBrowser.length).toBeGreaterThan(0);
    h.realBrowser.forEach((c) => expect(c.noTab).toBe(false));
  });

  it('still ensures the browser is UP when it was closed by hand', async () => {
    // serverLive:false means the server's browser is down. Retry must relaunch
    // it — silently, with noTab — or the Alert would have nowhere to appear.
    const down = boot({ serverLive: false });
    await picker(down);
    await chooseLocal(down);
    down.realBrowser.length = 0;
    down.opens.length = 0;

    await retry(down);
    await chooseLocal(down);

    expect(down.realBrowser.length).toBeGreaterThan(0);
    expect(down.realBrowser.every((c) => c.noTab === true)).toBe(true);
    expect(down.opens.length).toBe(0);
  });

  it('opens no tab even when Retry is pressed repeatedly', async () => {
    await picker(h);
    await chooseLocal(h);
    const afterPicker = h.opens.length;

    for (let i = 0; i < 5; i += 1) {
      await retry(h);
      await chooseLocal(h);
    }

    expect(h.opens.length).toBe(afterPicker);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Picker and Retry are ONE flow — same Alert, same calls', () => {
  let h: Harness;
  beforeEach(() => { h = boot({ serverLive: true }); });

  it('both reach the same chooser, card for card', async () => {
    await picker(h);
    const viaPicker = (h.panel() as El).find('tgt-card').map((c) => c.getAttribute('data-env'));
    h.flow.close();

    await retry(h);
    const viaRetry = (h.panel() as El).find('tgt-card').map((c) => c.getAttribute('data-env'));

    expect(viaRetry).toEqual(viaPicker);
  });

  it('both ask the server for the SAME field\'s options', async () => {
    await picker(h);
    const a = h.calls.filter((c) => c.fn === 'targetingOptions').pop();
    h.calls.length = 0;
    await retry(h);
    const b = h.calls.filter((c) => c.fn === 'targetingOptions').pop();
    expect(b?.args[0]).toEqual(a?.args[0]);
    expect(b?.args[1]).toEqual(a?.args[1]);
  });

  it('both register the pick through targetingBegin identically', async () => {
    await picker(h);
    await chooseLocal(h);
    const a = h.calls.filter((c) => c.fn === 'targetingBegin').pop();

    h.calls.length = 0;
    await retry(h);
    await chooseLocal(h);
    const b = h.calls.filter((c) => c.fn === 'targetingBegin').pop();

    expect(b?.args).toEqual(a?.args);
  });

  it('both arm the field, so the Alert can be answered either way', async () => {
    await picker(h);
    await chooseLocal(h);
    expect(h.armed.length).toBeGreaterThan(0);

    const beforeRetry = h.armed.length;
    await retry(h);
    await chooseLocal(h);
    expect(h.armed.length).toBeGreaterThan(beforeRetry);
  });

  it('exposes ONE alert renderer, not a second Retry-only path', () => {
    // A structural guard for «هدف این است که showPickerAlert() برای هر دو یکی
    // باشد». `start` and `retry` are thin wrappers that differ only in the
    // options object, so there is exactly one place the Alert is built.
    //
    // Comments in that module DISCUSS showPickerAlert by name (they quote the
    // required design), so counting raw matches counts prose. Strip comments
    // first, or the test measures documentation instead of code.
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const shown = (code.match(/showPickerAlert\(/g) || []).length;
    // one definition + one call from start + one call from retry
    expect(shown).toBe(3);
    expect(SRC).toMatch(/showPickerAlert\(c,\s*\{\s*mayOpenTab:\s*true\s*\}\)/);
    expect(SRC).toMatch(/showPickerAlert\(c,\s*\{\s*mayOpenTab:\s*false\s*\}\)/);
  });

  it('has NO shared last-pick slot left to steer Retry', () => {
    // The architectural correction, pinned so it cannot quietly return:
    // «Retry دیگر نباید بر مبنای lastPickerTarget باشد».
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('lastPickerTarget');
    expect(code).not.toContain('rememberTarget');
    expect(code).not.toContain('canRetry');
    expect(code).not.toContain('lastTarget');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the Retry button passes its OWN field into the shared flow', () => {
  /**
   * `retryBtn` is bound to UI().iconBtn and a live NDV column, so it is read as
   * source rather than executed; the DECISION it makes — which context, which
   * flow entry point — is a wiring property and that is what is asserted.
   */
  it('retryBtn takes the field factory and calls flow.retry with its context', () => {
    const at = NDV.indexOf('function retryBtn(');
    expect(at, 'retryBtn() must exist').toBeGreaterThan(-1);
    const open = NDV.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (let i = open; i < NDV.length; i++) {
      if (NDV[i] === '{') depth++;
      else if (NDV[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const body = NDV.slice(at, end);
    expect(body, 'Retry must be handed the field its crosshair uses').toContain('retryBtn(getOpts)');
    expect(body, 'and build the same destination through pickContext()').toContain('pickContext(opts)');
    expect(body, 'and drive the SAME flow entry point, not a remembered one').toContain('flow.retry(');
    expect(body, 'with the field identity gate its crosshair uses').toContain('opts.nodeId');
  });

  it('both buttons beside a field share one context factory', () => {
    // Every call site pairs `pickerBtn(..., X), retryBtn(X)`. If they ever take
    // different factories the two buttons would target different destinations.
    const pairs = NDV.match(/\},\s*([A-Za-z0-9_$]+)\),\s*retryBtn\(\1\)\]/g) || [];
    expect(pairs.length, 'both the click-selector and the condition-row call site must '
      + 'hand Picker and Retry the same factory').toBe(2);
  });
});
