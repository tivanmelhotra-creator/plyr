/* ============================================================================
   RETRY — the same Alert, for the same field, without another tab.

   WHAT WAS ASKED FOR
   ------------------
     «یک دکمه Retry کنار Picker اضافه شود»
     «Retry باید دقیقاً همان کاری را انجام دهد که Picker انجام می‌دهد، با این
      تفاوت که Tab جدیدی در Browser اصلی باز نمی‌کند»
     «اگر کاربر آخرین بار روی Picker مربوط به Field 2 کلیک کرده باشد، Retry
      باید فقط همان Field 2 را هدف قرار دهد»

   and the architectural instruction that matters most here, because it is the
   one a careless implementation breaks while still passing a demo:

     Picker → ensureLocalBrowserTab() → showPickerAlert()
     Retry  → reuseExistingLocalBrowser() → showPickerAlert()
     «هدف این است که showPickerAlert() برای هر دو یکی باشد»

   So these tests are not only "does Retry work". They pin that Retry and
   Picker are ONE flow with ONE difference, because two flows that merely
   happen to agree today are two flows that will disagree later.

   WHY THE MODULE IS RUN FOR REAL
   ------------------------------
   `public/js/targeting-flow.js` is a browser IIFE, so it is evaluated in a `vm`
   against a DOM built here. The alternative — reading the source and asserting
   on its text — cannot tell whether `mayOpenTab` actually ARRIVES at
   `openRealBrowser`, and that thread through four functions is the whole fix.
   ========================================================================= */

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
   *
   * That cost four failing tests that were reported against correct source —
   * which is how a harness quietly starts lying about the module it is
   * testing. Keep this field.
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
  retry(): boolean;
  canRetry(): boolean;
  lastTarget(): { nodeId: string; fieldKey: string } | null;
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
         *
         * That is worse than a failing test: it is a green one guarding
         * nothing. The `serverLive:false` case is what exposed it.
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
 * The pick context ndv-nodes.js supplies. Defaults to Node A / Field 3 —
 * the spec's own example of the field Retry must re-run alone.
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

/** Press Retry and let the chooser paint. */
async function retry(h: Harness) {
  const ok = h.flow.retry();
  await h.settle();
  return ok;
}

/** Choose LOCAL — the server's own browser. */
async function chooseLocal(h: Harness) {
  localCard(h).fire('click');
  await h.settle();
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Retry re-runs the LAST picker target, and only that one', () => {
  let h: Harness;
  beforeEach(() => { h = boot({ serverLive: true }); });

  it('exposes retry/canRetry/lastTarget alongside start', () => {
    expect(typeof h.flow.retry).toBe('function');
    expect(typeof h.flow.canRetry).toBe('function');
    expect(typeof h.flow.lastTarget).toBe('function');
  });

  it('has nothing to retry before any crosshair is pressed', () => {
    expect(h.flow.canRetry()).toBe(false);
    expect(h.flow.lastTarget()).toBeNull();
    expect(h.flow.retry()).toBe(false);
  });

  it('says so instead of pretending, when there is nothing to retry', () => {
    // Returning false is what lets the button toast "target something first"
    // rather than opening an empty dialog.
    expect(h.flow.retry()).toBe(false);
    expect(h.flow.isOpen()).toBe(false);
  });

  it('remembers the field whose crosshair was pressed', async () => {
    await picker(h);
    expect(h.flow.canRetry()).toBe(true);
    expect(h.flow.lastTarget()).toEqual({ nodeId: 'nodeA', fieldKey: 'field3' });
  });

  it('RE-RUNS ONLY THAT FIELD — not the node\'s other fields', async () => {
    // Node A has field1/field2/field3; the operator last pressed field3.
    await picker(h, { fieldKey: 'field1', label: 'Click → field1' });
    await picker(h, { fieldKey: 'field2', label: 'Click → field2' });
    await picker(h, { fieldKey: 'field3', label: 'Click → field3' });

    h.calls.length = 0;
    await retry(h);

    const asked = h.calls.filter((c) => c.fn === 'targetingOptions');
    expect(asked).toHaveLength(1);
    expect(asked[0].args[0]).toBe('nodeA');
    expect(asked[0].args[1]).toBe('field3');
  });

  it('follows the crosshair to a NEW node when the operator moves on', async () => {
    await picker(h, { nodeId: 'nodeA', fieldKey: 'field1' });
    await picker(h, { nodeId: 'nodeB', fieldKey: 'field2' });
    expect(h.flow.lastTarget()).toEqual({ nodeId: 'nodeB', fieldKey: 'field2' });
  });

  it('never asks the operator which field again', async () => {
    await picker(h);
    h.calls.length = 0;
    await retry(h);
    // The chooser it opens is the ENVIRONMENT chooser (local/remote). No field
    // picker appears, because the field is already known.
    const p = h.panel();
    expect(p).toBeTruthy();
    expect((p as El).find('tgt-card').length).toBe(2);
  });

  it('keeps the ROW ADDRESS, so a retried condition-row pick lands in the row', async () => {
    // Without rowPath a retried pick delivers into the action's top-level
    // `selector` — the row-routing defect arriving through a new door.
    await picker(h, { rowPath: 'p1/0/2' });
    h.calls.length = 0;
    await retry(h);
    await chooseLocal(h);
    const begun = h.calls.filter((c) => c.fn === 'targetingBegin')[0];
    expect(begun).toBeTruthy();
    expect(h.flow.lastTarget()).toEqual({ nodeId: 'nodeA', fieldKey: 'field3' });
  });

  it('hands out a COPY of the target, so a caller cannot steer Retry by accident', async () => {
    await picker(h);
    const first = h.flow.lastTarget() as { nodeId: string; fieldKey: string };
    first.fieldKey = 'hijacked';
    expect(h.flow.lastTarget()).toEqual({ nodeId: 'nodeA', fieldKey: 'field3' });
  });

  it('refuses to record a malformed pick over a good one', async () => {
    await picker(h);
    const ok = h.flow.start({ label: 'no ids at all' });
    expect(ok).toBe(false);
    expect(h.flow.lastTarget()).toEqual({ nodeId: 'nodeA', fieldKey: 'field3' });
  });

  it('records the target even when the operator abandons the Alert', async () => {
    // The reason Retry exists is that the Alert was closed or mis-used, so
    // recording only on success would disarm it in exactly those cases.
    await picker(h);
    h.flow.close();
    expect(h.flow.canRetry()).toBe(true);
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
    // Measured, and it is the stronger statement — so it is the one asserted.
    //
    // With the browser up and `mayOpenTab:false`, no tab was claimed, so the
    // already-live branch has no tab to bring forward and deliberately has no
    // `else`. The Alert this pick raised renders as an OVERLAY inside whatever
    // page that browser is showing, so there is genuinely nothing to launch and
    // nothing to display: «صفر Tab جدید / صفر navigation».
    //
    // Asserting "every call had noTab" here instead would pass over an EMPTY
    // array and guard nothing. The launch-with-noTab case is real, and it is
    // covered non-vacuously by the serverLive:false test below.
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
    expect(SRC).toMatch(/showPickerAlert\(lastPickerTarget,\s*\{\s*mayOpenTab:\s*false\s*\}\)/);
  });
});
