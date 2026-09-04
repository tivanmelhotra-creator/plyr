/**
 * extension-consent-prompt.test.ts
 *
 * WHAT IS UNDER TEST
 * ------------------
 * `extension/content/consent.js` — the prompt that appears INSIDE the browser
 * running on the server, asking the operator to connect this browser to one
 * specific node/field.
 *
 * WHY IT MATTERS
 * --------------
 * The browser the server launches issues no Authorization Code, and redeeming a
 * code was the only thing that ever wrote `ab_targetFieldId`. So that session had
 * a granted binding on the server and an empty destination on the client, and
 * `sendElement` refused before any HTTP call — surfacing as
 * `Connection failed: network`. This prompt is what supplies the destination:
 *
 * NOTE ON THE LABELS: the environment this prompt belongs to is `'local'` — the
 * browser the SERVER launched, identified by `AB_BOOTSTRAP.managed === true`.
 * `'remote'` is a browser on the operator's own desk, which authorizes with a
 * code and must never see this prompt. See the LOCAL/REMOTE BOUNDARY block at
 * the bottom of this file; earlier revisions used these two words the other way
 * round and that inversion is the bug the boundary block now pins.
 *
 *   «موقعی که کاربر مرورگر روی سرور بالا اومد توی همون صفحه مرورگر یه الرت بالا
 *    بیاد و از کاربر اجازه اتصال به نود/فیلد رو بگیره»
 *
 * and, on the repeat, without relaunching anything:
 *
 *   «مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد … و توی اون الرت میگه که چه
 *    نودی، چه فیلدی تا کاربر با این اعلان مطمعن بشه که سیستم درست کارمیکنه»
 *
 * WHAT IS ASSERTED, AND WHAT IS NOT
 * ---------------------------------
 * Behaviour, not source text: what the operator can READ in the prompt, what
 * the prompt SENDS when they answer, and that nothing is connected until they
 * do. Two source-level assertions remain at the bottom, for the two safety
 * rules that leave no runtime trace worth trusting.
 *
 * HOW: the real source runs in a `vm` against a hand-rolled fake DOM (there is
 * no jsdom in this project), matching the harness style of
 * extension-inspector-panel.test.ts. The prompt draws into a CLOSED shadow
 * root, so the fake keeps a reference to the root it handed out, the way the
 * browser keeps the real one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

const SRC = readFileSync(
  resolve(__dirname, '../../extension/content/consent.js'),
  'utf8',
);

/**
 * The service worker's source.
 *
 * Read at module scope because TWO describe blocks need it: the message-vocabulary
 * seam below, and the LOCAL/REMOTE scoping block at the bottom. The scoping block
 * asserts things that happen in the WORKER rather than in the page — the HTTP
 * call that declares the environment, and the refusal to complete a remote grant
 * from a local browser — and neither leaves a trace the fake DOM can observe.
 */
const BG = readFileSync(
  resolve(__dirname, '../../extension/background.js'),
  'utf8',
);

/* ---------------------------------------------------------------
   A fake DOM, recording exactly what the prompt sets.
   --------------------------------------------------------------- */
class FakeNode {
  tagName: string;
  id = '';
  className = '';
  disabled = false;
  attrs: Record<string, string> = {};
  childNodes: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  shadowRootFake: FakeNode | null = null;

  /**
   * The init dictionary `attachShadow` was called with. Recorded so a test can
   * assert the root was asked for CLOSED from behaviour rather than by grepping
   * the source: a fake that swallowed the argument would let `mode:'open'` ship.
   */
  shadowInit: Record<string, unknown> | null = null;

  /**
   * ── THE <dialog> SEAM ───────────────────────────────────────────────────
   * `open`, `showModal()` and `close()` are modelled because the prompt is now
   * a single `<dialog>` opened with `showModal()`, and the source's own control
   * flow READS `dialog.open`:
   *
   *   - `render()` skips a redraw only when `state.current === id && dialog.open`
   *   - the open call is guarded by `if (!dialog.open)`
   *   - `dismiss()` closes only `if (d.open)`
   *
   * A fake that left `open` permanently false would send every one of those
   * branches down its other side, so the tests would be exercising a control
   * flow the browser never takes. Worse, the source carries a `catch` that
   * falls back to `dialog.open = true` for contexts without `showModal()` — a
   * fake without the method would silently test the FALLBACK forever and let a
   * broken modal path ship.
   */
  open = false;
  modal = false;
  showModalCalls = 0;

  /**
   * Per the HTML spec: a no-op when already modal, and a throw when the dialog
   * was opened non-modally. Both matter — an unanswered prompt being replaced
   * by a newer one reaches the source with `open === true`, and the source is
   * only correct because it skips the call rather than re-opening.
   */
  showModal() {
    this.showModalCalls++;
    if (this.open && this.modal) return;
    if (this.open) throw new Error('showModal on a non-modal open dialog');
    this.open = true;
    this.modal = true;
  }

  /** Real `close()` fires a `close` event, which the source listens for. */
  close() {
    this.open = false;
    this.modal = false;
    this.fire('close');
  }

  private _text = '';
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }

  /**
   * `firstChild`, because the REPLACE is written as
   * `while (dialog.firstChild) dialog.removeChild(dialog.firstChild)`.
   *
   * Without this getter the loop condition is `undefined` on the first test, the
   * clear never runs, and the fake would accumulate every prompt's paragraphs in
   * one dialog — i.e. it would report the STACKING BUG as present no matter what
   * the source did. The measurement is only meaningful once the fake can perform
   * the removal.
   */
  get firstChild(): FakeNode | null { return this.childNodes[0] || null; }

  /** Concatenated like the real thing, so a card's whole text can be read. */
  get textContent(): string {
    if (this.childNodes.length) {
      return this._text + this.childNodes.map((c) => c.textContent).join(' ');
    }
    return this._text;
  }
  set textContent(v: string) { this._text = String(v == null ? '' : v); }

  get parentNode(): FakeNode | null { return this.parentElement; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  appendChild(c: FakeNode) { c.parentElement = this; this.childNodes.push(c); return c; }
  removeChild(c: FakeNode) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentElement = null;
    return c;
  }
  attachShadow(init?: Record<string, unknown>) {
    this.shadowInit = init ? { ...init } : {};
    this.shadowRootFake = new FakeNode('#shadow');
    this.shadowRootFake.parentElement = this;
    return this.shadowRootFake;
  }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t: string, fn: (e: unknown) => void) {
    const l = this.listeners[t];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  fire(t: string, evt: Record<string, unknown> = {}) {
    // A real browser does NOT dispatch click on a disabled button. Modelling
    // that is the whole reason the "double-click sends one decision" test means
    // anything: a fake that dispatched anyway would force the source to carry a
    // re-entrancy guard the platform already provides.
    if (t === 'click' && this.disabled) return;
    (this.listeners[t] || []).slice().forEach((fn) => fn({
      preventDefault() {}, stopPropagation() {}, target: this, ...evt,
    }));
  }

  /** Every descendant (and self) whose tag matches. */
  byTag(tag: string): FakeNode[] {
    const want = tag.toUpperCase();
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.tagName === want) out.push(n);
      n.childNodes.forEach(walk);
    };
    walk(this);
    return out;
  }

  /** Every descendant (and self) carrying `cls`. */
  byClass(cls: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.className.split(/\s+/).indexOf(cls) >= 0) out.push(n);
      n.childNodes.forEach(walk);
    };
    walk(this);
    return out;
  }
}

/** A pending prompt as the SERVER sends it — note: no targetFieldId, ever. */
function prompt(over: Record<string, unknown> = {}) {
  return {
    consentId: 'cns_a1b2c3d4e5f6a1b2c3d4e5f6',
    state: 'pending',
    nodeId: 'node_7',
    fieldKey: 'selector',
    label: 'Search box',
    action: 'click',
    requestedAt: 1700000000000,
    expiresAt: 1700000300000,
    ...over,
  };
}

/* ---------------------------------------------------------------
   The harness: real source, fake page, fake service worker.
   --------------------------------------------------------------- */
interface Harness {
  /** Messages the prompt sent to the service worker, in order. */
  sent: Array<Record<string, unknown>>;
  /** Queue the reply the worker gives to the NEXT AB_CONSENT_LIST. */
  queueList(res: unknown): void;
  /** What the worker answers AB_CONSENT_DECIDE with. */
  decideReply: { value: unknown };
  /** Run every pending timer once (the poll loop re-arms itself). */
  tick(): Promise<void>;
  /** Run only the POLL timer, leaving an armed dismiss still pending. */
  tickPolls(): Promise<void>;
  /** Run only the DISMISS timers, as the clock passing 2600ms would. */
  tickDismiss(): Promise<void>;
  /**
   * The prompts currently on screen inside the closed shadow root.
   *
   * ── WHY THIS IS NOT `cards()` ANY MORE ──────────────────────────────────
   * It used to be `shadow().byClass('card')`, one element per pending request,
   * appended into a scrolling list. That structure WAS the reported bug —
   *
   *   «Alert 1 → Picker دوباره اجرا شد → Alert 1 removed/replaced → Alert 2»
   *
   * — because a container that can hold two things will eventually hold two
   * things. The prompt is now a single `<dialog>` whose children are cleared
   * before each render, so this returns the dialog itself when it is showing a
   * prompt and an empty array when it is not: length is 0 or 1 BY CONSTRUCTION,
   * and any test asserting 2 is asserting the defect.
   */
  prompts(): FakeNode[];
  /** The one `<dialog>` element, once the panel has been built. */
  dialog(): FakeNode | null;
  shadow(): FakeNode | null;
  /** The host element the prompt grafts onto documentElement, if any. */
  host(): FakeNode | null;
  /** The page root, to prove the host attaches there and not into <body>. */
  documentElement(): FakeNode;
  hidden: { value: boolean };
  /** Fire visibilitychange the way the browser does. */
  visibility(): Promise<void>;
  timerCount(): number;
  /** chrome.runtime.lastError for the next message reply. */
  lastError: { value: unknown };
  /**
   * Deliver a message FROM the service worker, as `chrome.runtime.onMessage`
   * would — the push the worker sends when the active tab changes
   * (`AB_CONSENT_OWNER_CHANGED`). Settles the microtasks it triggers.
   */
  push(msg: Record<string, unknown>): Promise<void>;
  /** The `data-ab-owner` mirror on the host, or null when no host exists. */
  owner(): string | null;
  /**
   * Settle the `AB_ENVIRONMENT` gate the prompt asks on load.
   *
   * Needed only by tests that manipulate `lastError`, because the gate is a
   * message like any other and would otherwise consume a failure the test meant
   * for the POLL. Ordinary tests do not call it: their first `tick()` settles the
   * gate as a side effect.
   */
  ready(): Promise<void>;
}

/**
 * How the worker answers `AB_ENVIRONMENT` — the gate the prompt asks before it
 * does anything at all.
 *
 * ── THE POLARITY OF THIS DEFAULT WAS THE STALE HALF OF THE FIX ──────────────
 * This file used to default to `'remote'` and describe `'local'` as "the
 * operator's own Chrome: the reported bug, must stay silent". That reading was
 * inherited from the era when the server's side-loaded browser was labelled
 * REMOTE, and it is the reading the shipped code has since abandoned — for a
 * reason recorded in three places that now agree:
 *
 *   - `browserEnvironment()` (extension/background.js) answers `'local'` for
 *     exactly the browser the server launched (`AB_BOOTSTRAP.managed === true`),
 *     and `'remote'` for a browser on the operator's own desk;
 *   - `consentList()` / `consentDecide()` admit `'local'` and turn everything
 *     else away;
 *   - `RemoteTargetConsent.request()` stamps a prompt `'local'` by default and
 *     `pendingFor()` serves LOCAL prompts to a LOCAL (or undeclared) poller.
 *
 * So the prompt belongs to the SERVER's own browser, because that is the one
 * window which outlives a targeting run and can still be holding the previous
 * field's address. A browser on the operator's machine acquires its target by
 * redeeming an Authorization Code that named exactly one field — there is
 * nothing left to ask it.
 *
 * Leaving the old default in place is what produced 23 failures: the harness
 * declared the environment the code refuses to poll in, so every behavioural
 * test booted a prompt that correctly never started. Flipping the default is
 * therefore not "making the test pass" — it is making the harness describe the
 * environment the feature is FOR.
 *
 *   'local'  — the browser the SERVER launched: the prompt's only home
 *   'remote' — the operator's own Chrome: must stay silent (the reported bug)
 *   'none'   — the worker answered nothing (asleep / just reloaded)
 *   'error'  — chrome.runtime.lastError on the gate message
 */
type EnvReply = 'remote' | 'local' | 'none' | 'error';

function boot(env: EnvReply = 'local'): Harness {
  const documentEl = new FakeNode('html');
  const sent: Array<Record<string, unknown>> = [];
  const listQueue: unknown[] = [];
  const decideReply: { value: unknown } = { value: { ok: true, approved: true } };
  const lastError: { value: unknown } = { value: undefined };
  const hidden: { value: boolean } = { value: false };
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};

  let timers: Array<{ fn: () => void; id: number; delay: number }> = [];
  let timerId = 1;

  const documentFake = {
    documentElement: documentEl,
    get hidden() { return hidden.value; },
    createElement: (tag: string) => new FakeNode(tag),
    // The icons are inline SVG built with createElementNS — never innerHTML,
    // because the dialog shows operator-supplied text. Namespaced elements
    // are plain nodes to this fake; the tag is all the census looks at.
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    addEventListener(t: string, fn: (e: unknown) => void) { (docListeners[t] ||= []).push(fn); },
    removeEventListener() {},
  };

  const workerListeners: Array<(m: unknown) => void> = [];

  const chrome = {
    runtime: {
      get lastError() { return lastError.value; },
      onMessage: {
        addListener(fn: (m: unknown) => void) { workerListeners.push(fn); },
      },
      sendMessage(msg: Record<string, unknown>, cb?: (r: unknown) => void) {
        sent.push(msg);
        // Async like the real one, so a test cannot accidentally depend on a
        // synchronous reply the browser would never give.
        Promise.resolve().then(() => {
          if (!cb) return;
          if (msg.type === 'AB_ENVIRONMENT') {
            // Modelled the way the real worker replies, including the failure
            // shapes: `lastError` set with no reply, and a reply that is absent
            // entirely. Both must read as "do not poll".
            if (env === 'error') {
              lastError.value = { message: 'worker asleep' };
              cb(undefined);
              lastError.value = undefined;
              return;
            }
            if (env === 'none') { cb(undefined); return; }
            cb({ ok: true, environment: env });
            return;
          }
          if (msg.type === 'AB_CONSENT_LIST') {
            cb(listQueue.length ? listQueue.shift() : { ok: true, count: 0, requests: [] });
          } else if (msg.type === 'AB_CONSENT_DECIDE') {
            cb(decideReply.value);
          } else {
            cb(undefined);
          }
        });
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    document: documentFake,
    chrome,
    // The DELAY is recorded, not just the callback, because this file arms two
    // kinds of timer with very different meanings and a test that fires both at
    // once cannot express the order they really occur in:
    //
    //   POLL      4000ms / 20000ms  — asks the worker for pending requests
    //   DISMISS   1800ms / 2600ms   — clears an ANSWERED prompt off the screen
    //
    // The stale-dismiss hazard only exists in the window between them: an answer
    // arms a dismiss, a NEW pick arrives before it fires, and the timer must not
    // then close a question nobody has answered. A `tick()` that fires every
    // timer collapses that window to nothing and silently passes whether the
    // guard is present or not — which is exactly what a mutation run showed.
    setTimeout: (fn: () => void, delay?: number) => {
      const id = timerId++;
      timers.push({ fn, id, delay: Number(delay) || 0 });
      return id;
    },
    clearTimeout: (id: number) => { timers = timers.filter((x) => x.id !== id); },
    Promise,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'consent.js' });

  const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

  const h: Harness = {
    sent, decideReply, lastError, hidden,
    queueList: (res: unknown) => { listQueue.push(res); },
    async tick() {
      const due = timers.slice();
      timers = [];
      due.forEach((x) => x.fn());
      await settle();
    },
    /**
     * Fire ONLY the poll timer, leaving any armed dismiss pending.
     *
     * A dismiss is armed at 1800ms/2600ms and the poll re-arms at 4000ms, so in
     * real time a dismiss ALWAYS falls due before the next poll. This models the
     * one ordering that matters for the guard: a new pick is delivered while the
     * previous answer's dismiss is still on the clock.
     */
    async tickPolls() {
      const due = timers.filter((x) => x.delay >= 4000);
      timers = timers.filter((x) => x.delay < 4000);
      due.forEach((x) => x.fn());
      await settle();
    },
    /** Fire only the dismiss timers, as the clock reaching 2600ms would. */
    async tickDismiss() {
      const due = timers.filter((x) => x.delay > 0 && x.delay < 4000);
      timers = timers.filter((x) => !(x.delay > 0 && x.delay < 4000));
      due.forEach((x) => x.fn());
      await settle();
    },
    documentElement: () => documentEl,
    host() {
      return documentEl.childNodes.filter((n) => n.id === 'ab-consent-host')[0] || null;
    },
    shadow() {
      const host = h.host();
      return host ? host.shadowRootFake : null;
    },
    dialog() {
      const s = h.shadow();
      if (!s) return null;
      return s.byTag('dialog')[0] || null;
    },
    prompts() {
      const d = h.dialog();
      // An EMPTY dialog is not a prompt. `dismiss()` clears the children and
      // closes it, and the element itself is deliberately kept for reuse — so
      // presence of the <dialog> must not be mistaken for a visible question,
      // or "the prompt went away after the grant" could never be asserted.
      if (!d || d.childNodes.length === 0) return [];
      return [d];
    },
    async visibility() {
      (docListeners.visibilitychange || []).slice().forEach((fn) => fn({}));
      await settle();
    },
    timerCount: () => timers.length,
    async ready() { await settle(); },
    async push(msg: Record<string, unknown>) {
      workerListeners.slice().forEach((fn) => fn(msg));
      await settle();
    },
    owner() {
      const host = h.host();
      return host ? host.getAttribute('data-ab-owner') : null;
    },
  };
  return h;
}

/** Boot, deliver one prompt, and settle — the ordinary starting state. */
async function withPrompt(over: Record<string, unknown> = {}) {
  const h = boot();
  h.queueList({ ok: true, count: 1, requests: [prompt(over)] });
  await h.tick();
  return h;
}

/** The Allow / "Not now" buttons of the Nth card. */
function buttons(h: Harness, i = 0) {
  const btns = h.prompts()[i].byTag('button');
  return { allow: btns[0], deny: btns[1], all: btns };
}

// ════════════════════════════════════════════════════════════════

describe('the in-page consent prompt', () => {
  it('polls the worker for questions on its own, unprompted', async () => {
    // Nothing in the page tells it to start: the operator was sent to an
    // arbitrary URL by the dashboard, so the prompt has to arrive by itself.
    const h = boot();
    await h.tick();
    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length).toBeGreaterThan(0);
  });

  it('renders nothing at all when there is nothing to ask', async () => {
    // A browser parked on a page must look untouched. Drawing an empty panel on
    // every third-party page would be a visible defect in its own right.
    const h = boot();
    await h.tick();
    expect(h.host()).toBeNull();
    expect(h.prompts().length).toBe(0);
  });

  it('NAMES the node and the field being connected', async () => {
    // The entire point of the prompt per «توی اون الرت میگه که چه نودی، چه فیلدی».
    // A generic "allow this connection?" would leave the two-node case exactly as
    // ambiguous as the bug being fixed.
    const h = await withPrompt({ label: 'Search box', fieldKey: 'selector', action: 'click' });
    expect(h.prompts().length).toBe(1);
    const text = h.prompts()[0].textContent;
    expect(text).toContain('Search box');
    expect(text).toContain('selector');
    expect(text).toContain('click');
  });

  it('falls back to the node id when a node has no label', async () => {
    // Unlabelled nodes are ordinary. "a node → selector" would tell the operator
    // nothing about WHICH of two open nodes is asking.
    const h = await withPrompt({ label: '', nodeId: 'node_42' });
    expect(h.prompts()[0].textContent).toContain('node_42');
  });

  it('offers exactly two answers, and connects nothing before one is given', async () => {
    const h = await withPrompt();
    const b = buttons(h);
    expect(b.all.length).toBe(2);
    expect(b.allow.textContent).toBe('Allow');
    expect(b.deny.textContent).toBe('Not now');
    // Crucially: rendering a question must not itself decide anything.
    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_DECIDE').length).toBe(0);
  });

  it('sends the handle and an explicit approval — and nothing else', async () => {
    // The prompt never sees a targetFieldId (the server withholds it), so it
    // cannot leak or choose one. It answers with the opaque handle only.
    const h = await withPrompt();
    buttons(h).allow.fire('click');
    await h.tick();

    const decide = h.sent.filter((m) => m.type === 'AB_CONSENT_DECIDE');
    expect(decide.length).toBe(1);
    const payload = decide[0].payload as Record<string, unknown>;
    expect(payload.consentId).toBe('cns_a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(payload.approve).toBe(true);
    expect(Object.keys(payload).sort()).toEqual(['approve', 'consentId']);
    expect(JSON.stringify(payload)).not.toContain('tf_');
  });

  it('sends approve:false for "Not now", never a silent accept', async () => {
    // A deny that quietly approved would be the worst possible outcome: a pick
    // landing in a field the operator explicitly refused.
    const h = await withPrompt();
    h.decideReply.value = { ok: true, approved: false };
    buttons(h).deny.fire('click');
    await h.tick();

    const payload = h.sent.filter((m) => m.type === 'AB_CONSENT_DECIDE')[0]
      .payload as Record<string, unknown>;
    expect(payload.approve).toBe(false);
    expect(h.prompts()[0].textContent).toContain('Declined');
  });

  it('confirms by naming the field again, so the operator can verify the aim', async () => {
    // «تا کاربر با این اعلان مطمعن بشه که سیستم درست کارمیکنه» — a bare "OK"
    // would not let the operator catch a connection to the wrong node.
    const h = await withPrompt({ label: 'Login button', fieldKey: 'waitForSelector' });
    buttons(h).allow.fire('click');
    await h.tick();

    const text = h.prompts()[0].textContent;
    expect(text).toContain('Connected');
    expect(text).toContain('Login button');
    expect(text).toContain('waitForSelector');
  });

  it('disables both buttons while an answer is in flight', async () => {
    // Double-clicking Allow must not fire two decisions: the second would hit a
    // consumed one-time handle and report a failure for a success.
    const h = await withPrompt();
    const b = buttons(h);
    b.allow.fire('click');
    expect(b.allow.disabled).toBe(true);
    expect(b.deny.disabled).toBe(true);
    b.allow.fire('click'); // ignored by the browser on a disabled button
    await h.tick();
    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_DECIDE').length).toBe(1);
  });

  it('re-enables the buttons when the answer fails, keeping it answerable', async () => {
    // A transient blip must not strand the prompt, or the operator is back to
    // "it did nothing" with no way forward.
    const h = await withPrompt();
    h.decideReply.value = { ok: false, reason: 'network', error: 'Connection failed' };
    const b = buttons(h);
    b.allow.fire('click');
    await h.tick();

    expect(b.allow.disabled).toBe(false);
    expect(b.deny.disabled).toBe(false);
    expect(h.prompts()[0].textContent).toContain('Connection failed');
  });

  it("surfaces the worker's own reason rather than a generic failure", async () => {
    // An expired prompt and an unreachable server need different reactions from
    // the operator, so the message must distinguish them.
    const h = await withPrompt();
    h.decideReply.value = { ok: false, reason: 'expired', error: 'That request has expired.' };
    buttons(h).allow.fire('click');
    await h.tick();
    expect(h.prompts()[0].textContent).toContain('expired');
  });

  it('does not duplicate a prompt that is still on screen', async () => {
    // The poll re-lists the same pending request every 4s. Stacking a new card
    // each time would bury the page under identical questions.
    const h = boot();
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    expect(h.prompts().length).toBe(1);

    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    expect(h.prompts().length).toBe(1);
  });

  it('raises a SECOND question for a second field, with no relaunch', async () => {
    // The reported repeat case: «مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد».
    // Same page, same tab, a new question naming the new field.
    const h = boot();
    h.queueList({ ok: true, count: 1, requests: [prompt({ label: 'Node A', fieldKey: 'selector' })] });
    await h.tick();

    h.queueList({
      ok: true,
      count: 1,
      requests: [prompt({
        consentId: 'cns_ffffffffffffffffffffffff',
        label: 'Node B',
        fieldKey: 'waitForSelector',
      })],
    });
    await h.tick();

    // ── THIS ASSERTION WAS INVERTED, AND THE OLD ONE WAS THE BUG ───────────
    // It used to read `expect(h.cards().length).toBe(2)` and reach into
    // `cards()[1]` — i.e. it REQUIRED the second question to be appended
    // alongside the first. That is precisely the behaviour that was then
    // reported as broken:
    //
    //   «Alert 1 → Picker دوباره اجرا شد → Alert 1 removed/replaced → Alert 2»
    //   «در هر لحظه فقط یک picker confirmation فعال باشد»
    //
    // The requirement kept from the original report is unchanged — a new field
    // raises a new question in the SAME page with no relaunch — but the new
    // question must REPLACE the old one rather than pile onto it.
    expect(h.prompts().length).toBe(1);
    const text = h.prompts()[0].textContent;
    expect(text).toContain('Node B');
    expect(text).toContain('waitForSelector');

    // And the superseded question is genuinely GONE, not merely outnumbered.
    expect(text).not.toContain('Node A');
    expect(text).not.toContain('selector\n');

    // One host, one panel, one dialog — the browser was never re-created and
    // the prompt did not acquire a second surface to draw on.
    expect(h.documentElement().childNodes.filter((n) => n.id === 'ab-consent-host').length).toBe(1);
    expect((h.shadow() as FakeNode).byTag('dialog').length).toBe(1);
  });

  it('keeps polling after an answer, ready for the next field', async () => {
    // If it stopped after one grant, switching nodes would go back to silence.
    const h = await withPrompt();
    buttons(h).allow.fire('click');
    await h.tick();
    const before = h.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length;
    await h.tick();
    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length).toBeGreaterThan(before);
  });

  it('stays quiet and keeps trying when the extension is not configured', async () => {
    // Content scripts run on every page, including for users who never set a
    // base URL. That must be silent, and must not stop polling forever.
    const h = boot();
    h.queueList({ ok: false, reason: 'no_base_url', requests: [] });
    await h.tick();
    expect(h.prompts().length).toBe(0);
    expect(h.timerCount()).toBeGreaterThan(0);
  });

  it('survives a sleeping service worker and retries later', async () => {
    // MV3 workers idle out; the first poll after that fails with lastError.
    const h = boot();
    // Let the environment gate answer BEFORE the worker "sleeps", so the failure
    // below lands on the poll rather than on the gate. A gate that cannot be
    // answered deliberately declines to poll at all (asserted separately), which
    // is a different behaviour from the retry this test is about.
    await h.ready();
    h.lastError.value = { message: 'Could not establish connection.' };
    await h.tick();
    expect(h.prompts().length).toBe(0);
    expect(h.timerCount()).toBeGreaterThan(0);

    h.lastError.value = undefined;
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    expect(h.prompts().length).toBe(1);
  });

  it('pauses polling while the tab is hidden and resumes when shown', async () => {
    // A parked background tab is not somewhere an operator can answer anything.
    const h = boot();
    await h.tick();
    expect(h.timerCount()).toBeGreaterThan(0);

    h.hidden.value = true;
    await h.visibility();
    expect(h.timerCount()).toBe(0);

    h.hidden.value = false;
    await h.visibility();
    expect(h.timerCount()).toBeGreaterThan(0);
  });

  it('draws into a CLOSED shadow root, isolated from the page', async () => {
    // The prompt appears on an arbitrary third-party page. A closed root keeps
    // that page's scripts from reading or clicking a security prompt, and
    // `all:initial` keeps its CSS from dragging it off-screen.
    const h = await withPrompt();

    // Grafted onto documentElement — not into <body>, which a page is free to
    // replace wholesale.
    const host = h.host();
    expect(host).toBeTruthy();
    expect((host as FakeNode).parentElement).toBe(h.documentElement());

    // Asked for CLOSED, asserted from the recorded init rather than source text.
    expect((host as FakeNode).shadowInit).toEqual({ mode: 'closed' });
    expect((host as FakeNode).getAttribute('style')).toContain('all:initial');

    // And the prompt genuinely lives inside that root, not loose in the page:
    // the <dialog> is reachable through the shadow root and NOWHERE in the
    // page's own tree. Searched by tag now that there is no `.card` wrapper.
    expect(h.prompts().length).toBe(1);
    expect(h.documentElement().byTag('dialog').length).toBe(0);
  });

  it('writes text through textContent, never as markup', async () => {
    // A node label is operator-supplied text rendered onto someone else's page.
    // The fake has no innerHTML at all, so a card that rendered markup would
    // throw; asserting the label survives verbatim AS TEXT proves the path.
    const h = await withPrompt({ label: '<img src=x onerror=alert(1)>' });
    expect(h.prompts()[0].textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('ignores a malformed entry instead of rendering a blank card', async () => {
    // Defensive: a card with no consentId could never be answered, so it would
    // be a permanent piece of furniture on the operator's page.
    const h = boot();
    h.queueList({ ok: true, count: 2, requests: [null, prompt()] });
    await h.tick();
    expect(h.prompts().length).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ONE PROMPT, AND ONLY EVER ONE.

   These cover the acceptance criteria that came with the withdrawal of the
   Alert-Tab design:

     7.  «تکرار Picker نباید چند Alert همزمان بسازد»
     8.  «Alert جدید باید Alert قبلی را replace کند»
     15. «اگر Alert dismiss شد، Retry همچنان باید قابل استفاده باشد»

   They are behavioural: every one drives the real consent.js through the fake
   page and MEASURES the shadow tree afterwards. None of them greps the source.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('the prompt is a singleton, so repeated picks cannot pile up', () => {
  /** Deliver a distinct pending request, as a fresh pick would. */
  async function pick(h: Harness, n: number, over: Record<string, unknown> = {}) {
    h.queueList({
      ok: true,
      count: 1,
      requests: [prompt({
        // 24 hex chars, the shape the server issues, distinct per pick.
        consentId: 'cns_' + String(n).padStart(24, 'abcdef01234567890abcdef0'.slice(0, 0) + '0'),
        label: 'Node ' + n,
        fieldKey: 'field' + n,
        ...over,
      })],
    });
    await h.tick();
  }

  it('holds exactly ONE dialog after ten different picks', async () => {
    // AC7. Ten picks is the shape of the report: the operator ran the picker
    // repeatedly while nothing had been answered yet. The old list-and-append
    // panel would be holding ten questions at this point.
    const h = boot();
    for (let n = 1; n <= 10; n++) await pick(h, n);

    const shadow = h.shadow() as FakeNode;
    expect(shadow.byTag('dialog').length).toBe(1);
    expect(h.prompts().length).toBe(1);
  });

  it('shows the NEWEST pick and none of the ones it superseded', async () => {
    // AC8. Counting one dialog is not enough on its own — a single dialog that
    // appended into itself would also count one. The content has to have been
    // swapped, so the previous questions must be unreadable afterwards.
    const h = boot();
    await pick(h, 1);
    expect(h.prompts()[0].textContent).toContain('Node 1');

    await pick(h, 2);
    await pick(h, 3);

    const text = h.prompts()[0].textContent;
    expect(text).toContain('Node 3');
    expect(text).toContain('field3');
    expect(text).not.toContain('Node 1');
    expect(text).not.toContain('Node 2');
    expect(text).not.toContain('field1');
  });

  it('offers exactly two buttons after a replacement, not two sets of two', async () => {
    // The precise failure mode of an append: the operator sees an Allow button,
    // clicks it, and answers a request they are no longer looking at. Counting
    // buttons catches it whether the stacking is a card or a bare paragraph run.
    const h = boot();
    await pick(h, 1);
    await pick(h, 2);
    await pick(h, 3);

    const btns = (h.shadow() as FakeNode).byTag('button');
    expect(btns.length).toBe(2);
    expect(btns[0].textContent).toBe('Allow');
    expect(btns[1].textContent).toBe('Not now');
  });

  it('never grafts a second host onto the page, however many picks arrive', async () => {
    // The host is the only thing this file adds to someone else's document. A
    // second one would be a second surface, which is the DOM-level equivalent
    // of the Alert Tab that was just removed from the architecture.
    const h = boot();
    for (let n = 1; n <= 5; n++) await pick(h, n);
    expect(h.documentElement().childNodes.filter((n) => n.id === 'ab-consent-host').length).toBe(1);
  });

  it('opens the dialog MODALLY, and does not re-open one already showing', async () => {
    // showModal() is the Option-B mechanism: it is what puts the prompt in
    // Chrome's top layer with its own backdrop and focus trap, instead of a
    // z-index guess that any page can outbid. Re-opening on each replacement
    // would flash the backdrop and throw, so the second pick must NOT call it.
    const h = boot();
    await pick(h, 1);
    const d = h.dialog() as FakeNode;
    expect(d.open).toBe(true);
    expect(d.modal).toBe(true);
    expect(d.showModalCalls).toBe(1);

    await pick(h, 2);
    expect(d.showModalCalls).toBe(1);
    expect(d.open).toBe(true);
  });

  it('mirrors the dialog census onto the host so a probe can count it', async () => {
    // The root is mode:'closed', so NOTHING outside can enumerate its contents
    // — including tools/probe-page-lifecycle.mjs, which has to prove in a real
    // Chrome that repeated pickers left one dialog. These attributes are the
    // only channel through which "one dialog, and it is open" is observable.
    const h = boot();
    await pick(h, 1);
    const host = h.host() as FakeNode;
    expect(host.getAttribute('data-ab-dialogs')).toBe('1');
    expect(host.getAttribute('data-ab-open')).toBe('1');

    await pick(h, 2);
    expect(host.getAttribute('data-ab-dialogs')).toBe('1');
  });

  /*
   * ── A NOTE FROM THE MUTATION RUN, SO IT IS NOT REDISCOVERED ──────────────
   * AC15 is protected TWICE over, and deliberately:
   *
   *   1. the `close` listener clears `state.current`, so a dismissed request is
   *      no longer the "current" one and the next poll redraws it;
   *   2. the redraw guard is `state.current === id && dialog.open`, so even with
   *      a stale `current` a CLOSED dialog is still redrawn.
   *
   * Removing either one alone leaves the test below passing, because the other
   * still delivers the behaviour — they are equivalent mutants, not a gap in
   * coverage. Removing BOTH fails it. That is the correct outcome for redundant
   * defences: the test pins the BEHAVIOUR, not one particular line, and it would
   * be wrong to weaken it into asserting a specific mechanism.
   */
  it('re-shows a prompt after the operator dismissed the dialog with Esc', async () => {
    // AC15: «اگر Alert dismiss شد، Retry همچنان باید قابل استفاده باشد».
    // Esc closes a modal <dialog> for free, and silently. If `current` kept
    // pointing at the closed request, the next poll would see an unchanged id
    // and skip the redraw — the prompt would be gone for good and Retry would
    // appear to do nothing, with no page to reload because it has no page.
    const h = boot();
    await pick(h, 1);
    const d = h.dialog() as FakeNode;

    d.close();                    // exactly what Esc does
    expect(d.open).toBe(false);
    // The census must follow the dialog down, or a probe would report an open
    // prompt on a screen that has none.
    expect((h.host() as FakeNode).getAttribute('data-ab-open')).toBe('0');

    // The server keeps returning the SAME pending request; that must redraw.
    await pick(h, 1);
    expect(d.open).toBe(true);
    expect(h.prompts().length).toBe(1);
    expect(h.prompts()[0].textContent).toContain('Node 1');
  });

  it('leaves the dialog reusable — and empty — after an answer', async () => {
    // The element is deliberately kept for the next pick (nothing is created
    // per prompt), but it must not be left holding a stale, answered question:
    // the operator would come back to a dead Allow button.
    const h = boot();
    await pick(h, 1);
    buttons(h).allow.fire('click');
    await h.tick();

    // The grant confirmation is still readable for a moment...
    expect(h.prompts()[0].textContent).toContain('Connected');

    // ...then the dismiss timer fires and empties it, without removing it.
    await h.tick();
    await h.tick();
    const d = h.dialog() as FakeNode;
    expect(d).toBeTruthy();
    expect(d.childNodes.length).toBe(0);
    expect(h.prompts().length).toBe(0);

    // And a later pick still lands in that same element.
    await pick(h, 2);
    expect((h.shadow() as FakeNode).byTag('dialog').length).toBe(1);
    expect(h.prompts()[0].textContent).toContain('Node 2');
  });

  it('will not let a stale dismiss timer close a NEWER question', async () => {
    // The timer is armed when an answer lands and fires seconds later. If the
    // operator picked again in between, an unguarded timer would close a prompt
    // that had never been answered — a disappearing Alert, which is how this
    // whole class of bug gets reported.
    const h = boot();
    await pick(h, 1);
    buttons(h).allow.fire('click');
    await h.tick();

    // A new pick supersedes it BEFORE the dismiss timer runs. Delivered with
    // tickPolls(), which fires ONLY the poll — the dismiss armed above is still
    // sitting on the clock, which is the entire point of this test. Using the
    // ordinary tick() here would fire both at once and pass either way.
    h.queueList({
      ok: true,
      count: 1,
      requests: [prompt({ consentId: 'cns_ffffffffffffffffffffffff', label: 'Node 2', fieldKey: 'field2' })],
    });
    await h.tickPolls();
    expect(h.prompts()[0].textContent).toContain('Node 2');

    // NOW the stale dismiss falls due. It was armed for Node 1's consentId, so
    // it must recognise that the dialog has moved on and leave it alone.
    await h.tickDismiss();

    expect(h.prompts().length).toBe(1);
    expect(h.prompts()[0].textContent).toContain('Node 2');
    expect((h.dialog() as FakeNode).open).toBe(true);
  });
});

describe('the shipped source keeps its safety contract', () => {
  it('contains no innerHTML assignment', () => {
    // Enforced on the text because this file renders operator-supplied strings
    // onto arbitrary pages: the rule must hold for code paths no test reaches.
    expect(/\.innerHTML\s*=/.test(SRC)).toBe(false);
  });

  it('opens the shadow root CLOSED', () => {
    expect(SRC).toContain("mode: 'closed'");
  });
});

describe('the prompt and the worker agree on a message vocabulary', () => {
  // WHY THIS EXISTS
  // A previous attempt at this feature (PR #13) shipped a banner that sent
  // AB_CONSENT_PENDING / AB_CONSENT_ACCEPT / AB_CONSENT_REJECT while
  // background.js listened for none of them. Every test it had passed, because
  // they all exercised the server registry and never the extension. The banner
  // was therefore inert in the browser: the operator saw nothing, and the
  // original «Connection failed: network» remained.
  //
  // No amount of server-side testing can catch that, so the seam itself is
  // asserted here: every type the content script sends must be handled.
  // (`BG` is read at module scope — the scoping block below needs it too.)

  function typesSentBy(src: string): string[] {
    const out = new Set<string>();
    const re = /type:\s*'(AB_[A-Z_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.add(m[1]);
    return [...out];
  }

  it('sends only message types the service worker actually handles', () => {
    const sentTypes = typesSentBy(SRC);
    expect(sentTypes.length).toBeGreaterThan(0);
    const unhandled = sentTypes.filter((t) => !BG.includes(`'${t}'`));
    expect(unhandled).toEqual([]);
  });

  it('has a worker handler for both halves of the handshake', () => {
    // Listing questions and answering them are separate messages; shipping one
    // without the other strands the prompt.
    expect(SRC).toContain('AB_CONSENT_LIST');
    expect(SRC).toContain('AB_CONSENT_DECIDE');
    expect(BG).toContain("'AB_CONSENT_LIST'");
    expect(BG).toContain("'AB_CONSENT_DECIDE'");
  });
});

/* ════════════════════════════════════════════════════════════════
   THE LOCAL / REMOTE BOUNDARY

   Reported first: this Alert appeared in a browser it had no business appearing
   in, minutes after the operator had already authorized with a code.

   Reported second, after the labels were corrected: «در حالت لوکال هیچ الرتی
   نیومد … اسم نود و فیلد هم خالی بودند» — no Alert appeared in the environment
   that actually needs it.

   Both reports are the SAME defect seen from two sides, and the resolution fixed
   the polarity rather than the plumbing. The contract, with the labels the code
   now uses everywhere:

     LOCAL  = the browser the SERVER launched (AB_BOOTSTRAP.managed === true)
              -> IT is what the approval Alert is for. It is the one shared
                 window that outlives a targeting run, so it is the only browser
                 that can be holding a previous field's address and therefore
                 the only one that has to be ASKED which field a pick is for.

     REMOTE = a browser on the operator's own desk
              -> NO Alert. Its target arrived with the Authorization Code it
                 redeemed, and that code named exactly one field, so there is
                 nothing left to ask.

   The Alert is NOT removed by these tests and must not be: LOCAL binds its field
   through this prompt and through nothing else. What is asserted is that it is
   SCOPED — present in the server's browser, absent in the operator's.
   ════════════════════════════════════════════════════════════════ */
describe('the consent prompt is scoped to the LOCAL (server-launched) browser', () => {
  it('asks which browser it is in before polling for anything', async () => {
    // Ordering, not just outcome. If the poll were issued first and filtered
    // afterwards, the operator's own browser would still have asked the server
    // for pending approvals — and any server that answered (an older build, a
    // route that forgot the filter) could still put an Alert on their screen.
    const h = boot('remote');
    await h.ready();
    const types = h.sent.map((m) => m.type);
    expect(types[0]).toBe('AB_ENVIRONMENT');
    expect(types).not.toContain('AB_CONSENT_LIST');
  });

  it("never polls, and never draws anything, in the operator's own (REMOTE) browser", async () => {
    const h = boot('remote');
    await h.tick();
    await h.tick();

    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
    expect(h.prompts().length).toBe(0);
    // No host element grafted onto the page at all: on the operator's own
    // machine this file must leave their pages exactly as it found them.
    expect(h.host()).toBeNull();
    // And no timer left behind, so it cannot wake up later — the "minutes
    // later" shape of the original report.
    expect(h.timerCount()).toBe(0);
  });

  it("does poll, and does draw, in the server's own (LOCAL) browser", async () => {
    // The other half of the contract, and the second report. A gate that
    // silenced both environments "fixes" the first report by making the Alert
    // unreachable everywhere — which is precisely what was observed when this
    // file gated on `!== 'remote'` while consentList() admitted only 'local'.
    const h = boot('local');
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();

    expect(h.sent.map((m) => m.type)).toContain('AB_CONSENT_LIST');
    expect(h.prompts().length).toBe(1);
    expect(h.prompts()[0].textContent).toContain('Search box');
  });

  it('stays silent when the worker cannot say which browser this is', async () => {
    // Asleep worker / just-reloaded extension. Silence is the safe answer: a
    // missing prompt in the server's browser is recoverable from the dashboard,
    // an Alert in the operator's own browser is the bug.
    for (const mode of ['none', 'error'] as const) {
      const h = boot(mode);
      h.queueList({ ok: true, count: 1, requests: [prompt()] });
      await h.tick();
      await h.tick();
      expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
      expect(h.prompts().length).toBe(0);
    }
  });

  it('cannot be started by a hidden REMOTE tab later becoming visible', async () => {
    // The race the `armed` flag exists for. The gate is asynchronous; the
    // visibilitychange listener is not. A tab that loads hidden and is revealed
    // before the gate answers would find "not stopped, no timer" and start
    // polling — which is exactly how a prompt surfaced minutes after the
    // operator had moved on.
    const h = boot('remote');
    h.hidden.value = true;
    await h.visibility();
    h.hidden.value = false;
    await h.visibility();
    await h.tick();

    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
    expect(h.prompts().length).toBe(0);
  });

  it('gates on the exact string the worker and the server both use', async () => {
    // WHY A FOURTH ASSERTION ON THE SAME GATE.
    //
    // The original defect was not a MISSING gate — there was one — it was a gate
    // whose comparison pointed the opposite way to consentList(). Two gates that
    // are each individually reasonable and mutually contradictory make the
    // feature unreachable while every test that exercises only one side passes.
    // That is exactly how this suite went 23-red without the shipped code being
    // at fault: the harness declared the environment the code refuses to poll in.
    //
    // So this pins the AGREEMENT rather than either side alone: whatever value
    // this page requires before it polls must be the value the worker admits.
    expect(SRC).toContain("'local'");
    // The worker's two gates (consentList / consentDecide) admit 'local' only.
    expect(/env\s*!==\s*'local'/.test(BG)).toBe(true);
    // The inverted form is what shipped broken; neither side may carry it again.
    expect(/env\s*!==\s*'remote'/.test(SRC)).toBe(false);
    expect(/env\s*!==\s*'remote'/.test(BG)).toBe(false);

    // And the behavioural consequence, so the strings above cannot be satisfied
    // by a comment alone: 'local' polls, 'remote' does not.
    const local = boot('local');
    await local.tick();
    expect(local.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length)
      .toBeGreaterThan(0);

    const remote = boot('remote');
    await remote.tick();
    expect(remote.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
  });

  it('declares its environment to the server when it does poll', () => {
    // Source-level, because the HTTP call happens in the worker and not in the
    // page. The server filters prompts by the DECLARED environment
    // (src/core/RemoteTargetConsent.ts pendingFor), so a poll that declares
    // nothing degrades to LOCAL — deliberately, since the browser the server
    // side-loads may be running an older build that sends nothing, and starving
    // THAT would break the one environment the prompt exists for.
    expect(BG).toContain('x-browser-environment');
    expect(BG).toContain('environment=');
  });

  it("refuses to complete the grant from anything but the server's browser", () => {
    // Gating the LIST alone would leave the write to `ab_targetFieldId`
    // reachable by a stale card left over in a tab from an earlier session. On
    // the operator's own machine the target may arrive ONLY by redeeming an
    // Authorization Code, so consentDecide() mirrors consentList() exactly.
    expect(BG).toContain('wrong_environment');
  });

  it('decides the environment from the managed install, never from the URL', () => {
    // «Backend Base URL != Browser Environment». A browser on the operator's own
    // desk is entitled to drive a hosted backend over a public domain, so
    // inferring the environment from a loopback base URL would misclassify that
    // session and hand it the Alert. `AB_BOOTSTRAP.managed` is written only by
    // the server that side-loaded the extension into the browser it launched
    // itself, so a user's own Chrome cannot acquire it by configuring anything.
    expect(BG).toContain('AB_BOOTSTRAP.managed === true');
  });
});

/* ════════════════════════════════════════════════════════════════
   ONE ALERT, OWNED BY THE ACTIVE TAB

   THE REPORTED BUG
     «Alert در تمام Tabها نمایش داده می‌شود» — with three tabs open in the
     Local Browser, all three showed the dialog. Expected: Tab 2 active →
     0 / 1 / 0, and switching to Tab 3 → 0 / 0 / 1 (MOVED, not duplicated).

   WHY THE PAGE CANNOT DECIDE THIS ITSELF
     Measured in the real Chrome: all three tabs of one window report
     `document.visibilityState === 'visible'` and two of them `hasFocus()`
     true, while `chrome.tabs.query({active:true})` names exactly ONE. So the
     verdict lives in the service worker, which knows `sender.tab.id`, and it
     travels in the poll reply as `owner: true|false` — plus a push
     (`AB_CONSENT_OWNER_CHANGED`) the moment the active tab changes, so the
     Alert leaves the old tab and appears in the new one in the same breath.

   The content script's contract, asserted here:
     - `owner:false` reply  → draw nothing, and take down anything drawn
     - push owner:false     → take it down NOW, without waiting for a tick
     - push owner:true      → ask NOW (one poll loop, not two)
     - the host mirrors ownership as `data-ab-owner` for the CDP census
   ════════════════════════════════════════════════════════════════ */
describe('the Alert belongs to the ACTIVE tab only', () => {
  it('draws NOTHING in a tab the worker says is not the active one', async () => {
    // Tabs 1 and 3 in the bug report. Their poll reaches the worker, the
    // worker answers owner:false with an empty list — and the page stays
    // untouched: no host, no dialog, no census attribute to mirror.
    const h = boot();
    h.queueList({ ok: true, count: 0, requests: [], owner: false, skipped: 'not_active_tab' });
    await h.tick();
    expect(h.prompts().length).toBe(0);
    expect(h.host()).toBeNull();
  });

  it('draws the prompt in the tab the worker says IS the active one, and says so on the host', async () => {
    const h = boot();
    h.queueList({ ok: true, count: 1, requests: [prompt()], owner: true });
    await h.tick();
    expect(h.prompts().length).toBe(1);
    expect(h.dialog()!.open).toBe(true);
    expect(h.owner()).toBe('1');
  });

  it('takes the prompt DOWN when the next poll says another tab is active now', async () => {
    // Tab 2 held the Alert; the operator clicked Tab 3. Tab 2's next poll
    // comes back owner:false. The old Alert must not remain visible there.
    const h = await withPrompt();
    expect(h.prompts().length).toBe(1);

    h.queueList({ ok: true, count: 0, requests: [], owner: false, skipped: 'not_active_tab' });
    await h.tickPolls();

    expect(h.prompts().length).toBe(0);
    expect(h.dialog()!.open).toBe(false);
    expect(h.owner()).toBe('0');
    expect(h.host()!.getAttribute('data-ab-open')).toBe('0');
  });

  it('takes the prompt down IMMEDIATELY on the worker\'s owner:false push, before any tick', async () => {
    // Waiting up to 4s for the next poll would leave two Alerts on screen for
    // that long. The push closes the window.
    const h = await withPrompt();
    expect(h.prompts().length).toBe(1);

    await h.push({ type: 'AB_CONSENT_OWNER_CHANGED', owner: false });

    expect(h.prompts().length).toBe(0);
    expect(h.dialog()!.open).toBe(false);
    expect(h.owner()).toBe('0');
  });

  it('asks the worker AT ONCE on an owner:true push, and keeps exactly one poll loop', async () => {
    const h = boot();
    await h.tick();                 // gate settled, loop armed, one poll timer waiting
    const before = h.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length;
    expect(h.timerCount()).toBe(1);

    h.queueList({ ok: true, count: 1, requests: [prompt()], owner: true });
    await h.push({ type: 'AB_CONSENT_OWNER_CHANGED', owner: true });

    // One more poll went out without a timer firing …
    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length).toBe(before + 1);
    // … the Alert is up in the newly active tab …
    expect(h.prompts().length).toBe(1);
    // … and the previously armed timer was cancelled: still ONE loop.
    expect(h.timerCount()).toBe(1);
  });

  it('does not let an owner:true push START a loop the environment gate refused', async () => {
    // A push reaches every tab in the browser, including one whose gate said
    // REMOTE. It must stay silent: the gate, not the push, decides whether the
    // prompt exists in this browser at all.
    const h = boot('remote');
    await h.tick();
    h.queueList({ ok: true, count: 1, requests: [prompt()], owner: true });
    await h.push({ type: 'AB_CONSENT_OWNER_CHANGED', owner: true });
    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST').length).toBe(0);
    expect(h.prompts().length).toBe(0);
  });

  it('a tab that goes hidden gives the Alert up (hidden is never active)', async () => {
    const h = await withPrompt();
    h.hidden.value = true;
    await h.visibility();
    expect(h.prompts().length).toBe(0);
    expect(h.owner()).toBe('0');
  });

  it('the WORKER answers the poll with an ownership verdict and gates on it', () => {
    // The seam again (see the vocabulary block): the content script's
    // behaviour above is only real if the worker actually produces
    // `owner:false` for a non-active sender and pushes the change.
    expect(BG).toContain("skipped: 'not_active_tab'");
    expect(BG).toMatch(/owner:\s*false/);
    expect(BG).toMatch(/owner:\s*true/);
    expect(BG).toMatch(/chrome\.tabs\.query\(\{\s*active:\s*true/);
    expect(BG).toContain('chrome.tabs.onActivated.addListener');
    expect(BG).toContain('chrome.windows.onFocusChanged.addListener');
    expect(BG).toContain("'AB_CONSENT_OWNER_CHANGED'");
    expect(SRC).toContain("'AB_CONSENT_OWNER_CHANGED'");
  });

  it('the dialog is content-sized, not a full-height sheet', () => {
    // BUG 2: `all:initial` + `inset:0` with no height stretched the dialog to
    // the whole viewport (measured 310×660). The size must come from the
    // content, capped at a confirm-box width.
    expect(SRC).toMatch(/dialog\{[^}]*height:fit-content/);
    expect(SRC).toMatch(/dialog\{[^}]*width:fit-content/);
    expect(SRC).toMatch(/dialog\{[^}]*max-width:min\(4\d0px/);
    expect(SRC).not.toMatch(/dialog\{[^}]*min-height/);
  });

  it('pins its own writing direction, so an RTL host page cannot mirror it', () => {
    // Measured on the Persian live-view page: an inherited `direction:rtl`
    // reversed the flow strip and swapped the buttons to `[Allow] [Not now]`.
    // The Alert is one fixed English UI on every page it overlays.
    expect(SRC).toMatch(/dialog\{[^}]*direction:ltr/);
    expect(SRC).toMatch(/dialog\{[^}]*text-align:left/);
  });
});
