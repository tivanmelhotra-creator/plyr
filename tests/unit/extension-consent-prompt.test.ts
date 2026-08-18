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
 * REMOTE deliberately issues no Authorization Code, and redeeming a code was the
 * only thing that ever wrote `ab_targetFieldId`. So a REMOTE session had a
 * granted binding on the server and an empty destination on the client, and
 * `sendElement` refused before any HTTP call — surfacing as
 * `Connection failed: network`. This prompt is what supplies the destination:
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

  private _text = '';
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }

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
  /** The cards currently rendered in the closed shadow root. */
  cards(): FakeNode[];
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
 * `'remote'` is the default because that is the only browser this prompt is FOR,
 * so it is the state every pre-existing behavioural test means to describe. The
 * other values exist so the LOCAL scoping can be asserted rather than assumed:
 *
 *   'local'  — the operator's own Chrome: the reported bug, must stay silent
 *   'none'   — the worker answered nothing (asleep / just reloaded)
 *   'error'  — chrome.runtime.lastError on the gate message
 */
type EnvReply = 'remote' | 'local' | 'none' | 'error';

function boot(env: EnvReply = 'remote'): Harness {
  const documentEl = new FakeNode('html');
  const sent: Array<Record<string, unknown>> = [];
  const listQueue: unknown[] = [];
  const decideReply: { value: unknown } = { value: { ok: true, approved: true } };
  const lastError: { value: unknown } = { value: undefined };
  const hidden: { value: boolean } = { value: false };
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};

  let timers: Array<{ fn: () => void; id: number }> = [];
  let timerId = 1;

  const documentFake = {
    documentElement: documentEl,
    get hidden() { return hidden.value; },
    createElement: (tag: string) => new FakeNode(tag),
    addEventListener(t: string, fn: (e: unknown) => void) { (docListeners[t] ||= []).push(fn); },
    removeEventListener() {},
  };

  const chrome = {
    runtime: {
      get lastError() { return lastError.value; },
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
    setTimeout: (fn: () => void) => { const id = timerId++; timers.push({ fn, id }); return id; },
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
    documentElement: () => documentEl,
    host() {
      return documentEl.childNodes.filter((n) => n.id === 'ab-consent-host')[0] || null;
    },
    shadow() {
      const host = h.host();
      return host ? host.shadowRootFake : null;
    },
    cards() {
      const s = h.shadow();
      return s ? s.byClass('card') : [];
    },
    async visibility() {
      (docListeners.visibilitychange || []).slice().forEach((fn) => fn({}));
      await settle();
    },
    timerCount: () => timers.length,
    async ready() { await settle(); },
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
  const btns = h.cards()[i].byTag('button');
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
    expect(h.cards().length).toBe(0);
  });

  it('NAMES the node and the field being connected', async () => {
    // The entire point of the prompt per «توی اون الرت میگه که چه نودی، چه فیلدی».
    // A generic "allow this connection?" would leave the two-node case exactly as
    // ambiguous as the bug being fixed.
    const h = await withPrompt({ label: 'Search box', fieldKey: 'selector', action: 'click' });
    expect(h.cards().length).toBe(1);
    const text = h.cards()[0].textContent;
    expect(text).toContain('Search box');
    expect(text).toContain('selector');
    expect(text).toContain('click');
  });

  it('falls back to the node id when a node has no label', async () => {
    // Unlabelled nodes are ordinary. "a node → selector" would tell the operator
    // nothing about WHICH of two open nodes is asking.
    const h = await withPrompt({ label: '', nodeId: 'node_42' });
    expect(h.cards()[0].textContent).toContain('node_42');
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
    expect(h.cards()[0].textContent).toContain('Declined');
  });

  it('confirms by naming the field again, so the operator can verify the aim', async () => {
    // «تا کاربر با این اعلان مطمعن بشه که سیستم درست کارمیکنه» — a bare "OK"
    // would not let the operator catch a connection to the wrong node.
    const h = await withPrompt({ label: 'Login button', fieldKey: 'waitForSelector' });
    buttons(h).allow.fire('click');
    await h.tick();

    const text = h.cards()[0].textContent;
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
    expect(h.cards()[0].textContent).toContain('Connection failed');
  });

  it("surfaces the worker's own reason rather than a generic failure", async () => {
    // An expired prompt and an unreachable server need different reactions from
    // the operator, so the message must distinguish them.
    const h = await withPrompt();
    h.decideReply.value = { ok: false, reason: 'expired', error: 'That request has expired.' };
    buttons(h).allow.fire('click');
    await h.tick();
    expect(h.cards()[0].textContent).toContain('expired');
  });

  it('does not duplicate a prompt that is still on screen', async () => {
    // The poll re-lists the same pending request every 4s. Stacking a new card
    // each time would bury the page under identical questions.
    const h = boot();
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    expect(h.cards().length).toBe(1);

    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    expect(h.cards().length).toBe(1);
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

    expect(h.cards().length).toBe(2);
    expect(h.cards()[1].textContent).toContain('Node B');
    expect(h.cards()[1].textContent).toContain('waitForSelector');
    // One host, one panel — the browser was never re-created.
    expect(h.documentElement().childNodes.filter((n) => n.id === 'ab-consent-host').length).toBe(1);
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
    expect(h.cards().length).toBe(0);
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
    expect(h.cards().length).toBe(0);
    expect(h.timerCount()).toBeGreaterThan(0);

    h.lastError.value = undefined;
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();
    expect(h.cards().length).toBe(1);
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

    // And the card genuinely lives inside that root, not loose in the page.
    expect(h.cards().length).toBe(1);
    expect(h.documentElement().byClass('card').length).toBe(0);
  });

  it('writes text through textContent, never as markup', async () => {
    // A node label is operator-supplied text rendered onto someone else's page.
    // The fake has no innerHTML at all, so a card that rendered markup would
    // throw; asserting the label survives verbatim AS TEXT proves the path.
    const h = await withPrompt({ label: '<img src=x onerror=alert(1)>' });
    expect(h.cards()[0].textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('ignores a malformed entry instead of rendering a blank card', async () => {
    // Defensive: a card with no consentId could never be answered, so it would
    // be a permanent piece of furniture on the operator's page.
    const h = boot();
    h.queueList({ ok: true, count: 2, requests: [null, prompt()] });
    await h.tick();
    expect(h.cards().length).toBe(1);
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

   Reported: this Alert appeared in the operator's OWN Chrome during a LOCAL
   session, minutes after they had already authorized with an Authorization Code.
   The contract being broken:

     LOCAL  = API Key + Authorization Code      -> NO Remote Approval Alert
     REMOTE = no API Key, no Authorization Code -> Remote Approval Alert

   The Alert is NOT removed by these tests and must not be: REMOTE has no code to
   type, so the prompt is the only thing that can supply its target. What is
   asserted is that it is SCOPED — present in the server's browser, absent in the
   operator's.
   ════════════════════════════════════════════════════════════════ */
describe('the consent prompt is scoped to the REMOTE browser', () => {
  it('asks which browser it is in before polling for anything', async () => {
    // Ordering, not just outcome. If the poll were issued first and filtered
    // afterwards, a local browser would still have asked the server for pending
    // approvals — and any server that answered (an older build, a route that
    // forgot the filter) could still put an Alert on the operator's screen.
    const h = boot('local');
    await h.ready();
    const types = h.sent.map((m) => m.type);
    expect(types[0]).toBe('AB_ENVIRONMENT');
    expect(types).not.toContain('AB_CONSENT_LIST');
  });

  it('never polls, and never draws anything, in a LOCAL browser', async () => {
    const h = boot('local');
    await h.tick();
    await h.tick();

    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
    expect(h.cards().length).toBe(0);
    // No host element grafted onto the page at all: in a local session this
    // file must leave the operator's pages exactly as it found them.
    expect(h.host()).toBeNull();
    // And no timer left behind, so it cannot wake up later — the "minutes
    // later" shape of the original report.
    expect(h.timerCount()).toBe(0);
  });

  it('does poll, and does draw, in the REMOTE browser', async () => {
    // The other half of the contract. A gate that silenced both environments
    // would "fix" the report by breaking REMOTE, whose only route to a target is
    // this prompt.
    const h = boot('remote');
    h.queueList({ ok: true, count: 1, requests: [prompt()] });
    await h.tick();

    expect(h.sent.map((m) => m.type)).toContain('AB_CONSENT_LIST');
    expect(h.cards().length).toBe(1);
    expect(h.cards()[0].textContent).toContain('Search box');
  });

  it('stays silent when the worker cannot say which browser this is', async () => {
    // Asleep worker / just-reloaded extension. Silence is the safe answer: a
    // missing prompt in the remote browser is recoverable from the dashboard,
    // an Alert in a local browser is the bug.
    for (const mode of ['none', 'error'] as const) {
      const h = boot(mode);
      h.queueList({ ok: true, count: 1, requests: [prompt()] });
      await h.tick();
      await h.tick();
      expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
      expect(h.cards().length).toBe(0);
    }
  });

  it('cannot be started by a hidden LOCAL tab later becoming visible', async () => {
    // The race the `armed` flag exists for. The gate is asynchronous; the
    // visibilitychange listener is not. A tab that loads hidden and is revealed
    // before the gate answers would find "not stopped, no timer" and start
    // polling — which is exactly how a prompt surfaced minutes after the
    // operator had moved on.
    const h = boot('local');
    h.hidden.value = true;
    await h.visibility();
    h.hidden.value = false;
    await h.visibility();
    await h.tick();

    expect(h.sent.filter((m) => m.type === 'AB_CONSENT_LIST')).toEqual([]);
    expect(h.cards().length).toBe(0);
  });

  it('declares its environment to the server when it does poll', () => {
    // Source-level, because the HTTP call happens in the worker and not in the
    // page. The server filters prompts by the DECLARED environment
    // (src/core/RemoteTargetConsent.ts pendingFor), so a client that polls
    // without declaring is served remote prompts for backward compatibility —
    // which is precisely the ungated behaviour that caused the report.
    expect(BG).toContain('x-browser-environment');
    expect(BG).toContain('environment=');
  });

  it('refuses to complete a remote grant from a LOCAL browser', () => {
    // Gating the LIST alone would leave the write to `ab_targetFieldId`
    // reachable by a stale card left over from a previous remote session. In
    // LOCAL the target may arrive ONLY by redeeming an Authorization Code.
    expect(BG).toContain('wrong_environment');
  });

  it('decides the environment from the managed install, never from the URL', () => {
    // «Backend Base URL != Browser Environment». A LOCAL browser is entitled to
    // drive a REMOTE backend over a public domain, so inferring the environment
    // from a loopback base URL would classify that session as remote and hand it
    // the Alert. `AB_BOOTSTRAP.managed` is written only by the server that
    // side-loaded the extension into the browser it launched itself, so a user's
    // own Chrome cannot acquire it by configuring anything.
    expect(BG).toContain('AB_BOOTSTRAP.managed === true');
  });
});
