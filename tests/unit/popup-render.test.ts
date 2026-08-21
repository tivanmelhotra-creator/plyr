/**
 * popup-render.test.ts — the popup, ACTUALLY RENDERED.
 *
 * WHY THIS FILE HAD TO EXIST
 * --------------------------
 * Every other popup suite in this repo inspects the source as TEXT:
 *
 *     expect(html).toContain('id="envCard"');
 *
 * That assertion passes whether the element is visible, hidden by a `hidden`
 * attribute, or hidden by script at runtime. So the suites were all green while
 * the operator was looking at a Connection tab with no LOCAL/REMOTE choice in it
 * at all:
 *
 *   «توی تب کانکشن ها فقط یک بخش وجود داره که نوشته 127.0.0.1:3000 و هیچ حق
 *    انتخابی نذاشته برام که لوکال باشه یا ریموت»
 *
 * The project had no way to execute UI: `jsdom` was not installed and
 * vitest.config.ts sets `environment: 'node'`. A whole class of defect was
 * therefore invisible to the entire test suite, and it stayed invisible through
 * two rounds of "fixed and verified" — because what was verified was the
 * presence of strings, not the behaviour of the page.
 *
 * This file builds a real DOM, runs the real scripts, stubs `chrome`, and then
 * asks the questions the operator would ask: is the choice on screen, does it
 * say what is missing, does it survive having no field open.
 *
 * THE TWO PRODUCTION BUGS IT CAUGHT
 * ---------------------------------
 * BUG A — `paintEnvironment()` hid the whole chooser whenever no field was open.
 *   But choosing a browser is the FIRST step of targeting: the choice is what
 *   PRODUCES a binding. Gating the choice on a binding inverts cause and effect
 *   and makes the control unreachable exactly when it is needed.
 *
 * BUG B — the no-field fallback read `res.data.targets`, but `inspectorSession()`
 *   in background.js copies the server's fields onto the response object itself
 *   and never builds a `data` envelope. The read was `undefined` on every call,
 *   so the fallback could never fire. Independent of BUG A; either one alone
 *   hides the chooser.
 *
 * PROOF THAT THESE ASSERTIONS BITE
 * --------------------------------
 * Run against the pre-fix popup.js, 7 of the 9 tests below fail. That check was
 * performed deliberately, because a test written after a fix can otherwise be
 * green for reasons unrelated to the fix — which is the trap the text-only
 * suites fell into.
 *
 * FOUR THINGS THIS HARNESS MUST GET RIGHT (each learned by it failing)
 * -------------------------------------------------------------------
 * 1. `runScripts: 'dangerously'`. Evaluating the script with `new Function(js)`
 *    instead leaves `document` undefined inside it.
 * 2. popup.html loads TWO scripts, in order: `../lib/ab-core.js` then
 *    `popup.js`, and popup.js reads `window.ABCore` on its first line.
 *    Injecting popup.js alone fails SILENTLY — no error, no messages, an empty
 *    chooser — which is indistinguishable from the production bug being tested.
 * 3. Every chrome API here is consumed CALLBACK-style
 *    (`chrome.runtime.sendMessage(msg, cb)`), so promise-returning stubs leave
 *    the wrappers pending forever and nothing ever renders.
 * 4. The opening message is `AB_INSPECTOR_SESSION`, not `AB_STATUS`, and its
 *    response is FLAT — no `data` envelope. Getting this wrong is what made
 *    BUG B survive.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const POPUP_HTML = resolve(ROOT, 'extension/popup/popup.html');
const POPUP_JS = resolve(ROOT, 'extension/popup/popup.js');
const CORE_JS = resolve(ROOT, 'extension/lib/ab-core.js');
const BACKGROUND_JS = resolve(ROOT, 'extension/background.js');
const POPUP_CSS = resolve(ROOT, 'extension/popup/popup.css');

/**
 * THE TESTING MISTAKE THIS FUNCTION EXISTS TO MAKE IMPOSSIBLE.
 * ----------------------------------------------------------
 * This harness used to answer `AB_TARGETING_OPTIONS` with a hand-written
 *
 *     { ok: true, options }
 *
 * and every test built on it passed. But THE REAL EXTENSION COULD NOT PRODUCE
 * THAT REPLY. background.js answered
 *
 *     { ok: false, error: 'no_target_field', options: [] }
 *
 * whenever no field was targeted \u2014 which is precisely the state a freshly
 * opened popup is in. So the suite was verifying a message shape that existed
 * nowhere except in the suite itself, while the operator was staring at the raw
 * token `no_target_field` where the two choices belong, and asked:
 *
 *   \u00abاین کجاشه فیلد های بخش ریموت؟\u00bb
 *   \u00abکجاس فیلد اتورایزشن؟\u00bb
 *   \u00abاصلا اینپوت ردیو کجاست که انتخاب کنم ریموت یا لوکالشو؟\u00bb
 *
 * A mock cannot be trusted to tell the truth about a contract it invents. So the
 * REAL function is lifted out of background.js and EXECUTED here, with only its
 * two collaborators (`apiFetch`, `inspectorContext`) stubbed. If its reply shape
 * ever drifts from what the popup can render, these tests break \u2014 which is the
 * entire point of the file.
 */
function loadBackgroundTargetingOptions() {
  const src = readFileSync(BACKGROUND_JS, 'utf8');
  const found = src.match(/async function targetingOptions\(payload\) \{[\s\S]*?\n\}/);
  if (!found) throw new Error('targetingOptions() not found in background.js \u2014 harness is stale');
  const factory = new Function('apiFetch', 'inspectorContext', `${found[0]}\nreturn targetingOptions;`);
  return (apiFetch: unknown, inspectorContext: unknown) => factory(apiFetch, inspectorContext);
}
const makeBackgroundTargetingOptions = loadBackgroundTargetingOptions();

/** One open field, shaped as the server reports it. */
const FIELD = {
  targetFieldId: 'node_node-7__prompt__f00d1234',
  pairingKey: 'tf:wf-1:node-7:prompt',
  nodeId: 'node-7',
  fieldKey: 'prompt',
  action: 'set',
  workflowId: 'wf-1',
  label: 'Prompt',
  environment: '',
};

interface SessionShape {
  ok?: boolean;
  baseUrl?: string;
  hasKey?: boolean;
  userId?: string;
  reachable?: boolean;
  environment?: string;
  targetFieldId?: string;
  authorized?: boolean;
  target?: unknown;
  targets?: unknown[];
}

interface RenderOpts {
  session?: SessionShape;
  /** Pass null to simulate a server that offers no choices. */
  options?: Array<Record<string, unknown>> | null;
}

/**
 * Render the popup for real and hand back the live document.
 *
 * `sent` records every message the popup dispatched, so a test can assert on
 * what the popup ASKED as well as on what it drew.
 */
async function render(opts: RenderOpts = {}) {
  const html = readFileSync(POPUP_HTML, 'utf8');
  const core = readFileSync(CORE_JS, 'utf8');
  const js = readFileSync(POPUP_JS, 'utf8');

  const session: SessionShape = {
    ok: true,
    baseUrl: 'http://127.0.0.1:3000',
    hasKey: true,
    userId: 'u-1',
    reachable: true,
    environment: '',
    targetFieldId: '',
    authorized: false,
    target: null,
    targets: [],
    ...(opts.session || {}),
  };

  const options = opts.options === undefined
    ? [
      // MIRRORS src/core/BrowserEnvironment.ts environmentOptions() FIELD FOR
      // FIELD. An abbreviated stub was what made the previous version of this
      // harness lie: `needsInPageApproval` was missing, so the popup silently
      // took its fallback branch and a test asserting LOCAL's approval wording
      // failed against CORRECT product code. A fixture that is not shaped like
      // the real payload tests the fixture, not the product.
      {
        id: 'local', label: 'Local Browser', available: true, current: false,
        paired: true, needsAuthorization: false, needsInPageApproval: true,
        opensServerBrowser: true, note: '',
      },
      {
        id: 'remote', label: 'Remote Browser', available: true, current: false,
        paired: false, needsAuthorization: true, needsInPageApproval: false,
        opensServerBrowser: false, note: '',
      },
    ]
    : opts.options;

  const dom = new JSDOM(html, {
    url: 'https://popup.test/',
    runScripts: 'dangerously',
  });
  const w = dom.window as unknown as Record<string, any>;
  const sent: any[] = [];

  // The response is FLAT — inspectorSession() copies the server's fields onto
  // the response object and never builds a `data` envelope. Reproducing that
  // exactly is what makes BUG B detectable here.
  function reply(msg: any) {
    sent.push(msg);
    const type = msg && msg.type;
    if (type === 'AB_INSPECTOR_SESSION') return session;
    // Deferred to the REAL background function \u2014 see
    // loadBackgroundTargetingOptions(). Inventing a reply shape here is exactly
    // the error that let `no_target_field` reach the screen unnoticed.
    if (type === 'AB_TARGETING_OPTIONS') return '__background__';
    if (type === 'AB_TARGETING_BEGIN') return { ok: true, environment: msg?.payload?.environment };
    return { ok: true };
  }

  // The real background function, with only its two collaborators stubbed. The
  // stub speaks the same shape apiFetch() returns, so the branch that queries the
  // server WITHOUT a query string is the branch actually exercised.
  const backgroundTargetingOptions = makeBackgroundTargetingOptions(
    async () => (options === null
      ? { ok: false, error: 'network', data: {} }
      : { ok: true, data: { options, localEnabled: true, paired: false, pairingKey: '' } }),
    async () => ({ base: 'http://127.0.0.1:3000', apiKey: 'k' }),
  );

  async function reply2(msg: any) {
    const v = reply(msg);
    return v === '__background__' ? await backgroundTargetingOptions(msg && msg.payload) : v;
  }

  // Callback-style, asynchronously — matching how chrome actually behaves. A
  // promise here would leave popup.js's wrappers pending forever.
  const async_ = (cb: any, val: any) => {
    if (typeof cb === 'function') setTimeout(() => cb(val), 0);
  };

  const store: Record<string, unknown> = {};
  w.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      sendMessage: (m: any, cb: any) => { reply2(m).then((v) => async_(cb, v)); },
      getURL: (p: string) => 'chrome-extension://test/' + p,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: {
      local: {
        get: (_keys: any, cb: any) => async_(cb, { ...store }),
        set: (obj: any, cb: any) => { Object.assign(store, obj); async_(cb, undefined); },
        remove: (_k: any, cb: any) => async_(cb, undefined),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    tabs: {
      query: (_q: any, cb: any) => async_(cb, [{ id: 1, url: 'https://example.test/' }]),
      sendMessage: (_id: any, _m: any, cb: any) => async_(cb, { ok: true }),
      create: (_o: any, cb: any) => async_(cb, { id: 2 }),
    },
  };

  // ORDER MATTERS: ab-core.js defines window.ABCore, which popup.js reads on
  // its very first line. Loading popup.js alone fails silently.
  for (const src of [core, js]) {
    const el = w.document.createElement('script');
    el.textContent = src;
    w.document.body.appendChild(el);
  }

  // Drain the microtask/timer queue so every callback chain settles.
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));

  /** Drain again — needed after firing an event that starts a fetch chain. */
  const settle = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  };

  return { dom, doc: w.document as Document, sent, win: w, settle };
}

/** Visible in the sense the operator means: not `hidden`, and no hidden ancestor. */
function isShown(el: Element | null): boolean {
  if (!el) return false;
  let node: HTMLElement | null = el as HTMLElement;
  while (node) {
    if (node.hidden) return false;
    node = node.parentElement;
  }
  return true;
}

function textOf(el: Element | null): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

describe('the Connection tab, as the operator actually sees it', () => {
  beforeAll(() => {
    // Fail loudly rather than mysteriously if the harness is pointed at files
    // that have moved.
    for (const p of [POPUP_HTML, POPUP_JS, CORE_JS]) readFileSync(p, 'utf8');
  });

  it('offers the LOCAL / REMOTE choice on a cold popup, with nothing yet targeted', async () => {
    const { doc } = await render();
    const card = doc.querySelector('#envCard');
    const grid = doc.querySelector('#envGrid');

    // THE REPORTED BUG, STATED AS AN ASSERTION. Before the fix this was
    // `hidden: true` with an empty grid — the operator's «هیچ حق انتخابی
    // نذاشته برام که لوکال باشه یا ریموت».
    expect(isShown(card)).toBe(true);
    expect(grid?.children.length).toBeGreaterThan(0);

    const shown = textOf(grid).toLowerCase();
    expect(shown).toContain('local');
    expect(shown).toContain('remote');
  });

  it('says what is missing when nothing is targeted, instead of going quiet', async () => {
    const { doc } = await render();
    // An empty chooser is indistinguishable from one that failed to load. The
    // page must name the missing precondition.
    expect(textOf(doc.querySelector('#envStatus'))).toMatch(/no field|crosshair/i);
  });

  it('still shows the resolved backend, alongside the choice rather than instead of it', async () => {
    const { doc } = await render();
    // The user's screenshot showed ONLY the backend address. Both belong on
    // screen: the address is information, the chooser is a control.
    expect(textOf(doc.querySelector('#connBackend'))).toContain('127.0.0.1:3000');
    expect(isShown(doc.querySelector('#envCard'))).toBe(true);
  });

  it('picks up the single open field, so the choice applies to it', async () => {
    const { doc } = await render({
      session: { targets: [FIELD], target: null, targetFieldId: '' },
    });

    expect(isShown(doc.querySelector('#envCard'))).toBe(true);

    // Proves BUG B is fixed: the fallback can only have fired by reading
    // `res.targets`. Against `res.data.targets` this stayed on the no-field
    // sentence, because the read was undefined.
    expect(textOf(doc.querySelector('#envStatus'))).toMatch(/choose a browser/i);
  });

  it('marks the environment already on record, so the current choice is visible', async () => {
    const { doc } = await render({
      session: { environment: 'remote', targets: [FIELD] },
    });
    const grid = doc.querySelector('#envGrid');
    expect(grid?.children.length).toBeGreaterThan(0);
    const marked = grid?.querySelector('.is-on, [aria-pressed="true"], [data-current="true"]');
    expect(marked || textOf(grid).length > 0).toBeTruthy();
  });

  it("describes REMOTE as the operator's OWN machine, not the server's", async () => {
    const { doc } = await render();
    const remote = doc.querySelector('#envGrid [data-env="remote"]');
    const local = doc.querySelector('#envGrid [data-env="local"]');
    expect(remote).not.toBeNull();

    // The user's mockups label the REMOTE card "Server browser" — a leftover of
    // the inverted UI, where REMOTE wrongly meant the server's own browser.
    // The shipped copy must say the opposite, because REMOTE is the browser on
    // the OPERATOR'S machine. Asserted on the RENDERED card rather than on a
    // source string, so an edit that reintroduces the swap is caught here.
    const remoteText = textOf(remote).toLowerCase();
    expect(remoteText).toMatch(/your own machine|your machine/);
    expect(remoteText).not.toMatch(/server browser/);

    // And LOCAL is the one that lives on the server.
    expect(textOf(local).toLowerCase()).toMatch(/server/);
  });

  it('does not force the Authorization card open — that is a separate concern', async () => {
    const { doc } = await render();
    // «Connection UI ≠ Authorization UI». The chooser appearing must not drag
    // the authorization surface on screen with it; in particular LOCAL has no
    // authorization at all.
    expect(isShown(doc.querySelector('#authCard'))).toBe(false);
  });

  it('says something when the server offers no choices, rather than going blank', async () => {
    const { doc } = await render({ options: null });
    expect(textOf(doc.querySelector('#envStatus')).length).toBeGreaterThan(0);
  });

  it('loads both scripts and reaches the backend without throwing', async () => {
    const { sent } = await render();
    // If ab-core.js had not loaded first, popup.js would have died on its first
    // line and NO messages would have been sent — silently.
    const types = sent.map((m) => m && m.type);
    expect(types).toContain('AB_INSPECTOR_SESSION');
    expect(types).toContain('AB_TARGETING_OPTIONS');
  });
});

// ===================================================================
// The four controls the operator named, one test each
// ===================================================================

describe('the controls the operator asked for, by name', () => {
  it('has two real radio inputs, mutually exclusive, one per browser', async () => {
    const { doc } = await render();
    const radios = Array.from(
      doc.querySelectorAll('#envGrid input[type="radio"]'),
    ) as HTMLInputElement[];

    // \u00abاصلا اینپوت ردیو کجاست که انتخاب کنم ریموت یا لوکالشو؟\u00bb \u2014 asserted as the
    // tag it has to be, not merely as "something clickable".
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.value)).toEqual(['local', 'remote']);
    // ONE shared name is what makes the two mutually exclusive with no script at
    // all, and is what buys keyboard arrow-key movement for free.
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[0].name).toBeTruthy();
  });

  it('reveals the Base URL and the Authorization Code when REMOTE is chosen', async () => {
    const { doc, win, settle } = await render();
    const remote = doc.querySelector('#envGrid [data-env="remote"] input[type="radio"]') as HTMLInputElement;
    expect(remote).not.toBeNull();

    // A `change` event, because that is the event a radio actually emits \u2014
    // including when it is reached with the arrow keys. Listening for `click`
    // would silently drop keyboard selection.
    remote.checked = true;
    remote.dispatchEvent(new win.Event('change', { bubbles: true }));
    await settle();

    // \u00abاین کجاشه فیلد های بخش ریموت؟\u00bb / \u00abکجاس فیلد اتورایزشن؟\u00bb
    expect(isShown(doc.querySelector('#authCard'))).toBe(true);
    expect(isShown(doc.querySelector('#authBase'))).toBe(true);
    expect(isShown(doc.querySelector('#authCode'))).toBe(true);
    // Visible AND usable. A shown-but-disabled field answers the question with a
    // technicality.
    expect((doc.querySelector('#authBase') as HTMLInputElement).disabled).toBe(false);
    expect((doc.querySelector('#authCode') as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps every credential field away from LOCAL, always', async () => {
    const { doc, win, settle } = await render();
    const local = doc.querySelector('#envGrid [data-env="local"] input[type="radio"]') as HTMLInputElement;
    local.checked = true;
    local.dispatchEvent(new win.Event('change', { bubbles: true }));
    await settle();

    // LOCAL's credential surface is empty BY DEFINITION, not merely empty for now.
    expect(isShown(doc.querySelector('#authCard'))).toBe(false);
    expect(isShown(doc.querySelector('#authBase'))).toBe(false);
    expect(isShown(doc.querySelector('#authCode'))).toBe(false);
  });

  it('never prints a raw error token where a control belongs', async () => {
    const { doc } = await render();
    const status = textOf(doc.querySelector('#envStatus'));

    // THE EXACT REGRESSION THE OPERATOR SAW. `no_target_field` is a wire
    // sentinel; it is not a sentence and it told them nothing. The generic
    // snake_case guard catches its siblings too, so the next such leak fails here
    // rather than on screen.
    expect(status).not.toMatch(/no_target_field|invalid_node_id|[a-z]+_[a-z]+_[a-z]+/);
    expect(status.length).toBeGreaterThan(0);
  });
});

// ===================================================================
// The supplied mockups, element by element
//
//   \u00abاین تصاویری که اپلود کردم باید در نهایت ب این برسیم یعنی مثل این تصاویر
//    بخش هاشو دیزاین کنی\u00bb
//
// The two images differ STRUCTURALLY, and that difference is the specification:
//   image 1 (REMOTE chosen) \u2014 four cards, an orange down-arrow between each
//     adjacent pair, and CONNECTION STATUS drawn as an inset box with real values.
//   image 2 (LOCAL chosen)  \u2014 the REMOTE BROWSER CONNECTION card is ABSENT, so
//     there are fewer arrows, and CONNECTION STATUS carries em-dashes instead.
// So the layout is not one fixed picture; it is a FUNCTION of the choice. These
// tests assert the function, not a snapshot.
// ===================================================================

describe('the final target design', () => {
  it('gives every card the mockup three lines: name, readiness dot, sub-label', async () => {
    const { doc } = await render();
    const cards = Array.from(doc.querySelectorAll('#envGrid .envcard'));
    expect(cards).toHaveLength(2);

    for (const card of cards) {
      expect(textOf(card.querySelector('.envname')).length).toBeGreaterThan(0);
      // The mockup's green dot + "Ready" under each name.
      expect(textOf(card.querySelector('.envstate'))).toMatch(/ready/i);
      expect(textOf(card.querySelector('.envdesc')).length).toBeGreaterThan(0);
    }
  });

  it('keeps LOCAL=server / REMOTE=your-machine, against the mockup own label', async () => {
    const { doc } = await render();
    const local = textOf(doc.querySelector('#envGrid [data-env="local"] .envdesc')).toLowerCase();
    const remote = textOf(doc.querySelector('#envGrid [data-env="remote"] .envdesc')).toLowerCase();

    // THE ONE PLACE THE MOCKUP IS DELIBERATELY NOT FOLLOWED, AND WHY.
    // Both mockups print "Server browser" under REMOTE. That label is a survivor
    // of the inverted UI the operator themselves reported \u2014 \u00abوقتی لوکال می\u200cزنم
    // باید مرورگر لوکال سرور بالا بیاد ولی برعکسه\u00bb \u2014 and it contradicts the LOCAL
    // card beside it in the very same image, which reads "Connected
    // automatically". Copying the word would restore the bug that was fixed. The
    // mockup's LAYOUT is followed exactly; this one WORD is not.
    expect(local).toMatch(/server/);
    expect(remote).toMatch(/your own machine|your machine/);
    expect(remote).not.toMatch(/server browser/);
  });

  it('states BOTH of LOCAL promises: nothing to type, one thing to approve', async () => {
    const { doc } = await render();
    const local = textOf(doc.querySelector('#envGrid [data-env="local"] .envdesc')).toLowerCase();

    // Dropping the approval was a REAL REGRESSION caught by another suite: the
    // previous card said "Automatic \u2014 just approve it in that browser", and LOCAL
    // genuinely does wait for an in-page approval. Both halves are load-bearing:
    // without the first, LOCAL looks like it might ask for a credential; without
    // the second, the binding appears to hang for no stated reason.
    expect(local).toMatch(/nothing to enter/);
    expect(local).toMatch(/approve/);
    // And still no credential is ever named on the LOCAL card.
    expect(local).not.toMatch(/base url|api key|\bcode\b/);
  });

  it('shows the Connection Active pill only when a binding is actually live', async () => {
    const cold = await render();
    // Cold: the pill is EMPTY, so the stylesheet's `:empty` rule removes it. The
    // mockup draws this as a switch, but it REPORTS state and never sets it \u2014 so
    // it is deliberately not interactive, or it would read as a control that can
    // turn a live binding off.
    expect(textOf(cold.doc.querySelector('#ctLive'))).toBe('');

    const live = await render({
      session: {
        environment: 'remote', targetFieldId: FIELD.targetFieldId,
        target: FIELD, targets: [FIELD], authorized: true,
      },
    });
    const pill = live.doc.querySelector('#ctLive');
    expect(textOf(pill)).toMatch(/connection active/i);
    expect(pill?.className || '').toContain('ok');
  });

  it('draws the orange arrows by adjacency, so a hidden card takes its arrow with it', async () => {
    const { doc } = await render();
    const css = readFileSync(POPUP_CSS, 'utf8');

    // NOT asserted via getComputedStyle(el, '::before'): jsdom does not implement
    // pseudo-element styles \u2014 it logs "Not implemented" and returns nothing, so
    // such an assertion passes no matter what the stylesheet says. That exact
    // vacuous test was written here once and caught by reading the suite's own
    // stderr. Two checkable claims replace it.
    //
    // Claim 1: the rule exists, draws U+2193, and is anchored on ADJACENCY.
    // Adjacency is the mechanism that reproduces BOTH mockups from ONE rule: a
    // card that is `hidden` stops being the adjacent sibling, so its arrow
    // vanishes with it and image 2 falls out automatically.
    const rule = css.match(/\.panel \.card \+ \.card[^{]*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('2193');
    expect(rule?.[0]).toContain('::before');

    // Claim 2: the selector matches real elements in the real document \u2014 so the
    // rule is not merely present, it actually applies.
    const arrowed = doc.querySelectorAll('#p-connection .card + .card:not([hidden])');
    expect(arrowed.length).toBeGreaterThan(0);

    // And the FIRST card has no arrow above it, exactly as the mockups show.
    const first = doc.querySelector('#p-connection .card');
    expect(Array.from(arrowed)).not.toContain(first);
  });

  it('reproduces image 2 exactly: LOCAL removes the REMOTE card and its arrow', async () => {
    const { doc, win, settle } = await render();
    const local = doc.querySelector('#envGrid [data-env="local"] input[type="radio"]') as HTMLInputElement;
    local.checked = true;
    local.dispatchEvent(new win.Event('change', { bubbles: true }));
    await settle();

    const authCard = doc.querySelector('#authCard');
    // The structural difference between the two supplied images, asserted as a
    // CONSEQUENCE of the choice rather than as a second hard-coded layout.
    expect(isShown(authCard)).toBe(false);
    expect(authCard?.hasAttribute('hidden')).toBe(true);

    // Because the connector is `:not([hidden])`-guarded and adjacency-anchored,
    // the hidden card drops out of the arrow set \u2014 so no arrow is left pointing
    // at nothing. This is the property that lets ONE stylesheet rule render BOTH
    // mockups.
    const arrowed = Array.from(doc.querySelectorAll('#p-connection .card + .card:not([hidden])'));
    expect(arrowed).not.toContain(authCard);
    expect(arrowed.length).toBeGreaterThan(0);
  });

  it('names the five CONNECTED TO TARGET rows the mockup names, in order', async () => {
    const { doc } = await render();
    const ct = doc.querySelector('#ctNode')?.closest('.card');
    expect(ct).not.toBeNull();

    // Both mockups list exactly these five rows, in this order, each with a left
    // icon. Asserted on the rendered document so a reordering or a dropped row is
    // caught here rather than by eye.
    const labels = Array.from(ct!.querySelectorAll('.idlabel')).map((n) => textOf(n).toLowerCase());
    expect(labels).toEqual(['node', 'field', 'field id', 'browser', 'binding']);
    // Every row carries its icon, which is what makes the list scannable.
    expect(ct!.querySelectorAll('.idrow .idicon').length).toBe(5);
  });

  it('shows an em-dash, never a blank, for a value that is not yet known', async () => {
    const { doc } = await render();
    // Image 2's rows all read em-dash. A BLANK would be indistinguishable from a
    // row that failed to render, which is the same class of defect as printing a
    // raw error token: the UI stops saying anything at all.
    for (const id of ['ctNode', 'ctField', 'ctFieldId']) {
      expect(textOf(doc.querySelector('#' + id))).toBe('\u2014');
    }
  });
});

describe('the two reference images, as STATE and not as decoration', () => {
  /**
   * THE RULE THESE TESTS ENCODE, IN THE OPERATOR'S OWN WORDS
   * -------------------------------------------------------
   *   «هیچ 127.0.0.1:3000 یا Backend Local نباید به‌عنوان Remote Backend
   *    نمایش داده شود.»
   *
   * The BACKEND row answers "where did this data actually go". In LOCAL that is
   * the server's own loopback address and printing it is correct and useful. In
   * REMOTE it is a machine across a network that the operator has not named yet,
   * and the loopback address is not merely unhelpful there — it is FALSE. It
   * names this very machine as the remote backend, which is the one reading it
   * would rule out the very misconfiguration the row exists to expose.
   *
   * The value has to come from the environment's own state, so these tests drive
   * the real radio and read the real rendered row.
   */
  const pick = async (h: Awaited<ReturnType<typeof render>>, id: string) => {
    const radio = (Array.from(h.doc.querySelectorAll('.envradio')) as any[])
      .find((r) => r.value === id);
    expect(radio).toBeTruthy();
    radio.checked = true;
    radio.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.settle();
  };

  it('never reports the server\'s own loopback address as the REMOTE backend', async () => {
    const h = await render();
    await pick(h, 'remote');

    const backend = textOf(h.doc.querySelector('#connBackend'));
    // The precise string the operator called out, and the general shape of it,
    // because a different port is the same lie.
    expect(backend).not.toContain('127.0.0.1');
    expect(backend).not.toContain('localhost');
    expect(backend).not.toMatch(/127\.0\.0\.1:\d+/);
  });

  it('says the REMOTE backend is not known yet, rather than showing a blank', async () => {
    const h = await render();
    await pick(h, 'remote');

    // A blank row is indistinguishable from a row that failed to render — the
    // same defect class as printing `no_target_field`. With no Base URL entered
    // there IS no remote backend yet, and that is what it must say.
    const backend = textOf(h.doc.querySelector('#connBackend'));
    expect(backend).not.toBe('');
    expect(backend).toMatch(/\u2014|not set|not connected/i);
  });

  it('does not claim CONNECTED for a REMOTE browser that was never connected', async () => {
    const h = await render();
    await pick(h, 'remote');

    // The session that answered here is the SERVER-LOCAL one; it proves the
    // server is up, and it says nothing whatever about a remote browser that has
    // not been given an address or a code. Reporting its reachability as the
    // remote connection state is how a REMOTE tab came to read "Connected" while
    // nothing remote existed at all.
    const state = textOf(h.doc.querySelector('#connState'));
    expect(state).not.toMatch(/^\u25cf Connected$/);
  });

  it('still reports the real loopback backend under LOCAL, where it is the truth', async () => {
    const h = await render();
    await pick(h, 'local');

    // The counterweight. If the fix above were done by blanking the row for
    // everyone, this would fail — and the row would have stopped doing its job
    // in the one environment where its value is both known and correct.
    expect(textOf(h.doc.querySelector('#connBackend'))).toContain('127.0.0.1:3000');
    expect(textOf(h.doc.querySelector('#connState'))).toMatch(/connected/i);
  });

  it('shows the REMOTE backend the operator typed, once they type one', async () => {
    const h = await render();
    await pick(h, 'remote');

    const base = h.doc.querySelector('#authBase') as HTMLInputElement;
    expect(isShown(base)).toBe(true);
    base.value = 'https://ops.example.com';
    base.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    await h.settle();

    // «Base URL قابل تنطیم باشد» — and the BACKEND row is where the
    // operator confirms the address took effect. Left stale, the one field they
    // can set has no visible consequence.
    expect(textOf(h.doc.querySelector('#connBackend'))).toContain('ops.example.com');
  });

  it('keeps LOCAL free of every authorization surface, in both directions', async () => {
    const h = await render();
    await pick(h, 'remote');
    expect(isShown(h.doc.querySelector('#authCard'))).toBe(true);

    // Switching BACK is the direction that regresses unnoticed: a card revealed
    // once and never re-hidden leaves LOCAL showing an Authorization Code box,
    // which the spec forbids outright — «Local هیچ Authorization‌ای ندارد».
    await pick(h, 'local');
    expect(isShown(h.doc.querySelector('#authCard'))).toBe(false);
    expect(isShown(h.doc.querySelector('#authBase'))).toBe(false);
    expect(isShown(h.doc.querySelector('#authCode'))).toBe(false);
  });
});

describe('the footnote box, which the connectors had quietly wrecked', () => {
  it('draws no flow arrow above the footnote, because neither reference has one', async () => {
    const css = readFileSync(POPUP_CSS, 'utf8');

    // ── WHY THIS ONE LINE OF CSS DID TWO KINDS OF DAMAGE ──────────────
    // `.note` is a GRID: `grid-template-columns: 16px minmax(0, 1fr)` — a 16px
    // column for the circled-i glyph, then the sentence. A `::before` on a grid
    // container is not an overlay; it is a GRID ITEM, and it is the FIRST one. So
    // the arrow took the 16px icon column, shoved the icon into the text column
    // and the sentence into the 16px one, and the footnote rendered as a column
    // of single words with a stray orange arrow where its icon belonged.
    //
    // Both references were checked before removing it, and both agree: the arrow
    // belongs BETWEEN CARDS, which are the steps of one act. The footnote is not
    // a step — it is a standing remark about all of them — so there is nothing
    // for an arrow to point from.
    //
    // Asserted against the stylesheet because the defect lives in the cascade,
    // not in the DOM: the markup was already correct, which is exactly why the
    // whole suite stayed green while the box was visibly broken.
    // COMMENTS STRIPPED FIRST. The naive `expect(css).not.toMatch(...)` failed the
    // moment the deleted rule was replaced by a comment EXPLAINING the deletion —
    // the words were still in the file, so a grep over raw text called a correct
    // stylesheet broken. A rule is only a rule outside a comment, and the check has
    // to be made where the cascade actually reads.
    const live = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(live).not.toMatch(/\+\s*\.note::before/);
    // Sanity-check the stripper itself, so this cannot pass by removing everything.
    expect(live).toContain('.note {');

    // The card-to-card connectors must SURVIVE — image 1 shows three of them.
    // Deleting the arrows wholesale would satisfy the line above and lose the
    // feature, so the counterweight is asserted in the same test.
    const cardRule = live.match(/\.panel \.card \+ \.card[^{]*\{[^}]*\}/);
    expect(cardRule).not.toBeNull();
    expect(cardRule![0]).toContain('2193');
  });

  it('keeps the footnote a two-column grid: icon beside the sentence', async () => {
    const { doc } = await render();
    const note = doc.querySelector('.note');
    expect(note).not.toBeNull();

    // MY FIRST VERSION OF THIS ASSERTION WAS WRONG, and worth recording. It read
    // `expect(note!.children.length).toBe(2)` on the theory that the grid holds an
    // icon and a sentence. It does — but the sentence is a bare TEXT NODE, which
    // grid wraps in an anonymous item that `children` does not count. So the
    // assertion failed against correct markup, and had I "fixed" the product to
    // satisfy it I would have wrapped the prose in a pointless span to please a
    // test that had simply mismeasured the page.
    //
    // What actually matters is WHICH element sits in the 16px column first, because
    // the defect was a generated arrow stealing that slot:
    const icon = note!.querySelector('.nicon');
    expect(icon).not.toBeNull();
    expect(note!.firstElementChild).toBe(icon);
    expect(note!.children.length).toBe(1);

    // And it still says its piece, in full.
    expect(textOf(note)).toMatch(/inspected data will be sent to the configured backend/i);
  });
});

describe('three defects only a screenshot could find', () => {
  const pickEnv = async (h: Awaited<ReturnType<typeof render>>, id: string) => {
    const r = (Array.from(h.doc.querySelectorAll('.envradio')) as any[]).find((x) => x.value === id);
    r.checked = true;
    r.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.settle();
  };

  it('draws exactly ONE status dot per state line, not two', async () => {
    const css = readFileSync(POPUP_CSS, 'utf8');
    const { doc } = await render();

    // ── THE DOUBLE DOT ────────────────────────────────────────
    // Two mechanisms were independently drawing the same bullet:
    //   1. `.tfstate::before` — a 7px CSS disc, coloured by the tone class. This
    //      is the one the references show, and the one that can be tinted green
    //      or orange by state.
    //   2. the STRING, which began with a literal ● / ○ glyph.
    // Neither is wrong on its own; together they render "● ● Connected", which
    // is what the built artifact actually showed. Both mockups show ONE dot.
    //
    // The CSS disc is the one kept: it is what the tone classes colour, and a
    // glyph baked into the text cannot be restyled by state at all.
    expect(css).toContain('.tfstate::before');

    // Asserted on the RENDERED text, which is where the duplicate lived.
    for (const id of ['connState', 'ctState']) {
      const t = textOf(doc.querySelector('#' + id));
      expect(t).not.toMatch(/[\u25cf\u25cb]/);
    }
  });

  it('never claims a binding is active while every target row is blank', async () => {
    const h = await render();
    await pickEnv(h, 'remote');

    // ── THE CONTRADICTION INSIDE ONE CARD ────────────────────────
    // CONNECTED TO TARGET carries a BINDING row and, beneath it, a summary state
    // line. On a cold popup the rows are all em-dashes — correctly, nothing is
    // bound — and the summary said "Not bound", also correctly. But the artifact
    // showed the pill reading "Connection Active" beside them, and in the REMOTE
    // shot the BINDING row said "Not bound — approve the request in the project"
    // while the summary said "Connection active".
    //
    // A card cannot report both. Whatever it says, it must say once.
    const bindingRow = textOf(h.doc.querySelector('#ctPairing'));
    const summary = textOf(h.doc.querySelector('#ctState'));
    const pill = textOf(h.doc.querySelector('#ctLive'));

    const rowsBlank = ['ctNode', 'ctField', 'ctFieldId']
      .every((id) => textOf(h.doc.querySelector('#' + id)) === '\u2014');

    if (rowsBlank) {
      expect(pill).toBe('');
      expect(summary).not.toMatch(/active|connected/i);
      expect(bindingRow).not.toMatch(/^\s*active\s*$/i);
    }
    // And the two lines may never disagree with each other.
    const bound = /not bound/i.test(bindingRow);
    if (bound) expect(summary).not.toMatch(/connection active/i);
  });

  it('does not offer RELEASE THIS FIELD when there is no field to release', async () => {
    const h = await render();

    // TWO WRONG GUESSES OF MINE ARE RECORDED HERE, because both would have led to
    // "fixing" code that was already right:
    //   • I looked for `#ctRelease`. The button's real id is `#inspUnpair`.
    //     Querying a non-existent id returns null, and an assertion about null is
    //     an assertion about nothing.
    //   • I then expected `disabled`. The product uses `hidden`, wired at
    //     `els.inspUnpair.hidden = !paired` — which is CORRECT, and matches the
    //     references: image 2 shows the whole card as em-dashes, and offering a
    //     live RELEASE button for a field that is not bound invites a click whose
    //     only possible outcome is an error.
    // So this test now pins the behaviour that exists, in the place it exists.
    const btn = h.doc.querySelector('#inspUnpair') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(isShown(btn)).toBe(false);

    // ...and it must come back when something IS bound, or hiding it would just
    // mean "this button never works".
    const h2 = await render({
      session: {
        environment: 'remote', targetFieldId: 'fld_7a2b9c3e', authorized: true,
        target: {
          nodeId: 'n1', fieldKey: 'username', action: 'http_request',
          nodeName: 'div#c > input#username', fieldName: 'Username',
          fieldId: 'fld_7a2b9c3e', environment: 'remote',
        },
      },
    });
    expect(isShown(h2.doc.querySelector('#inspUnpair'))).toBe(true);
  });
});

describe('the CONNECTED TO TARGET card, and a mockup text I was wrong to copy', () => {
  // WHY THESE THREE TESTS WERE REWRITTEN
  // ------------------------------------
  // I first transcribed this card literally: image 1's BINDING row reads `Active`,
  // image 2's reads an em-dash, so I asserted a bare value with no bullet. The
  // product changed to match, and five tests elsewhere went red.
  //
  // Those five were right and I was wrong, by the operator's OWN precedence rule:
  // Layout, card order and which sections appear come from the references, but
  // «منطق فنی و State را از اسپک قبلی بگیر، نه از متن‌های داخل Mockup. اگر یک متن
  // داخل Mockup با منطق نهایی تناقض دارد، منطق نهایی اولویت دارد.» `Active` is a
  // TEXT inside the mockup, and it contradicts the final logic.
  //
  // Concretely: this row is the only surface that reports the DURABLE pairing,
  // which stays true across NDV re-opens, while "Connected" tracks the LIVE
  // address and goes false on every re-open. `Active` is indistinguishable from
  // "the address is up" — it would re-create the exact conflation that made the
  // operator ask for a separate line. So these tests now pin the DISTINCTION,
  // which is state, and no longer the mockup's wording, which is not.
  it('reports the durable pairing in words the live address cannot borrow', async () => {
    const h = await render({
      session: {
        environment: 'remote', targetFieldId: 'fld_7a2b9c3e', authorized: true, paired: true,
        target: {
          nodeId: 'n1', fieldKey: 'username', action: 'http_request',
          nodeName: 'div#c > input#username', fieldName: 'Username',
          fieldId: 'fld_7a2b9c3e', environment: 'remote',
        },
      },
    });

    const binding = textOf(h.doc.querySelector('#ctPairing'));
    // The fact, not the mockup's shorthand for it.
    expect(binding).toMatch(/stays targeted/i);
    // No code is ever requested now, so the row must not imply one is the
    // alternative.
    expect(binding).not.toMatch(/code/i);
  });

  it('names the environment-specific next action when nothing is bound', async () => {
    // An em-dash — image 2's literal content — names no action at all, and the
    // action genuinely differs: LOCAL binds the instant the crosshair is used,
    // REMOTE is already aimed and waits on an approval in the project. Telling a
    // remote operator to press the crosshair again is a loop they have finished.
    const local = await render({ session: { environment: 'local', paired: false } });
    const localText = textOf(local.doc.querySelector('#ctPairing'));
    expect(localText).toMatch(/not bound/i);
    expect(localText).toMatch(/crosshair/i);

    const remote = await render({ session: { environment: 'remote', paired: false } });
    const remoteText = textOf(remote.doc.querySelector('#ctPairing'));
    expect(remoteText).toMatch(/not bound/i);
    expect(remoteText).toMatch(/approve/i);
    expect(remoteText).not.toMatch(/crosshair/i);
  });

  it('keeps ONE dot on the row, because .ivalue draws none in CSS', async () => {
    // The double-dot defect was real, but it lived on `.tfstate`, whose ::before
    // paints a disc the tone class recolours. This row is `.ivalue`, which has no
    // ::before at all — so its glyph is the row's ONLY dot, and stripping it here
    // would leave the row dotless rather than fixing a duplicate. That asymmetry
    // is the whole reason stateLine() strips and value() does not.
    const css = readFileSync(POPUP_CSS, 'utf8');
    const ivalueBefore = /\.ivalue[^{]*::before/.test(css);
    expect(ivalueBefore).toBe(false);

    const h = await render({ session: { environment: 'local', paired: true } });
    const binding = textOf(h.doc.querySelector('#ctPairing'));
    const dots = (binding.match(/[\u25cf\u25cb]/g) || []).length;
    expect(dots).toBe(1);
  });

  it('never lets the header pill and the BINDING row contradict each other', async () => {
    const live = await render({
      session: {
        environment: 'remote', targetFieldId: 'f1', authorized: true, paired: true,
        target: {
          nodeId: 'n1', fieldKey: 'username', action: 'http_request',
          nodeName: 'div#c > input#username', fieldName: 'Username',
          fieldId: 'f1', environment: 'remote',
        },
      },
    });
    expect(textOf(live.doc.querySelector('#ctLive'))).toMatch(/connection active/i);
    expect(textOf(live.doc.querySelector('#ctPairing'))).toMatch(/stays targeted/i);

    // Cold: no pill, and the row must not claim a binding it does not have.
    const cold = await render();
    expect(textOf(cold.doc.querySelector('#ctLive'))).toBe('');
    expect(textOf(cold.doc.querySelector('#ctPairing'))).toMatch(/not bound/i);
  });

  it('says "Connection active" ONCE, not in the pill and again underneath', async () => {
    // ── FOUND BY COMPARING THE RENDER TO REFERENCE IMAGE 1 ────────────────
    // Both references draw the live state EXACTLY ONCE, as the pill beside the
    // toggle at the card's top-right. The render printed it twice: the pill said
    // "Connection Active" and `#ctState`, at the bottom-left of the very same
    // card, said "Connection active" again — same fact, same card, two lines
    // apart, differing only in capitalisation.
    //
    // WHY THIS IS A DEFECT AND NOT MERE REDUNDANCY
    // -------------------------------------------
    // `#ctState` is the line that has to carry the BAD news: "Bound, but that
    // field is no longer open". Spending it on a restatement of the pill when
    // things are fine means the card has two lines saying one thing in the good
    // case, and the operator has no way to learn that the second line is the one
    // that changes. A line that is silent when there is nothing to add is what
    // makes it legible when it speaks.
    //
    // WHAT THIS TEST DOES **NOT** DO
    // ------------------------------
    // It does not delete `#ctState`. The 'survives the address going stale' test
    // in popup-inspector-pairing.test.ts requires this element to report
    // /no longer open/i while `#ctPairing` still reports /stays targeted/i —
    // that split is the whole point of having both. So the rule asserted here is
    // narrow: when the binding is LIVE, the summary adds nothing and stays
    // empty; when it is NOT live, it must still speak.
    const live = await render({
      session: {
        environment: 'remote', targetFieldId: 'f1', authorized: true, paired: true,
        target: {
          nodeId: 'n1', fieldKey: 'username', action: 'http_request',
          nodeName: 'div#c > input#username', fieldName: 'Username',
          fieldId: 'f1', environment: 'remote',
        },
      },
    });

    const pill = textOf(live.doc.querySelector('#ctLive'));
    const summary = textOf(live.doc.querySelector('#ctState'));

    // The pill still carries the fact, exactly as both references show.
    expect(pill).toMatch(/connection active/i);
    // …and the card does not then repeat it underneath.
    expect(summary).not.toMatch(/connection active/i);

    // Counted on the WHOLE card, so the claim cannot reappear in a third place.
    const card = live.doc.querySelector('#ctCard') || live.doc.querySelector('#p-connection .card:last-of-type');
    const occurrences = ((card?.textContent || '').match(/connection\s+active/gi) || []).length;
    expect(occurrences).toBe(1);
  });

  it('still speaks on that same line when the field is no longer open', async () => {
    // THE COUNTERWEIGHT. Silencing the summary while live must not silence it
    // when it has something to report, or the fix above would have removed a
    // diagnostic instead of a duplicate.
    const stale = await render({
      session: {
        environment: 'local', targetFieldId: 'f1', authorized: false,
        paired: true, target: null,
      },
    });
    expect(textOf(stale.doc.querySelector('#ctState'))).toMatch(/no longer open/i);
    // And the pill is gone, because the address is not live.
    expect(textOf(stale.doc.querySelector('#ctLive'))).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// TWO LAYOUT DEFECTS THE REFERENCES EXPOSED
//
// Both are pure LAYOUT — the state behind them was already correct — and both
// were invisible to every DOM assertion in this file, because the markup was
// valid and the stylesheet parsed. Only rendering the built artifact in Chromium
// and comparing it to the mockups side by side surfaced them.
//
// These tests assert against the STYLESHEET TEXT rather than computed style,
// because jsdom does not implement getComputedStyle(el, '::before'): it logs
// "Error: Not implemented" and returns nothing, so a pseudo-element assertion
// here would pass vacuously and pin nothing at all.
describe('the flow connector, which its own card was clipping', () => {
  const css = () => readFileSync(POPUP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('does not let .card clip the arrow that hangs outside it', () => {
    const live = css();
    // Sanity-check the comment stripper, so this test cannot pass by reading an
    // empty string — the mistake that made an earlier assertion here vacuous.
    expect(live).toContain('.card {');

    // The arrow is a ::before on the FOLLOWING card, pulled UP by a negative
    // margin so it sits in the 12px gutter — i.e. OUTSIDE its own card's box.
    // `.card { overflow: hidden }` therefore cut it off, leaving the orange
    // sliver the reference comparison flagged. Chromium confirmed it directly:
    // marginTopOfBefore "-8px" with overflow "hidden".
    const cardRule = live.slice(live.indexOf('.card {'), live.indexOf('}', live.indexOf('.card {')));
    expect(cardRule).not.toMatch(/overflow:\s*hidden/);
  });

  it('still clips the card CONTENT, which is what overflow was there for', () => {
    // overflow:hidden was not decoration — it keeps the children inside the
    // rounded corners. Removing it outright would let a child square off the
    // radius, so the clipping has to move to an inner surface rather than vanish.
    const live = css();
    expect(live).toMatch(/overflow:\s*hidden/);
  });
});

describe('a URL is one token, and must not be broken mid-word', () => {
  it('wraps the backend address at boundaries rather than anywhere', () => {
    const live = readFileSync(POPUP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(live).toContain('.ivalue.mono {');
    const rule = live.slice(
      live.indexOf('.ivalue.mono {'),
      live.indexOf('}', live.indexOf('.ivalue.mono {')),
    );
    // `overflow-wrap: anywhere` split "https://ops.example.com" so the final "m"
    // sat alone on its own line, directly under a BACKEND label — which reads as
    // a corrupted address in the one row whose whole job is to be trusted.
    // `break-word` only breaks a token that cannot otherwise fit.
    expect(rule).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/overflow-wrap:\s*break-word/);
  });
});

describe('the BACKEND column is sized for an address, not for a word', () => {
  it('gives the address column more room than the status word', () => {
    const live = readFileSync(POPUP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const start = live.indexOf('.statebox:has(.tfstate.ok) {');
    expect(start).toBeGreaterThan(-1);
    const rule = live.slice(start, live.indexOf('}', start));

    // WHY A RATIO AND NOT A PIXEL COUNT
    // The row holds two very unequal things: a one-word status ("Connected") and
    // a full URL. Splitting them near-evenly (1fr / 1.15fr) left the address just
    // 164px in a 460px popup, so Chromium broke "https://ops.example.com" and put
    // the final "m" alone on the next line, directly under a BACKEND label. The
    // address is the longest value on the card and must get the larger share.
    const m = rule.match(/grid-template-columns:\s*minmax\(0,\s*([\d.]+)fr\)\s+minmax\(0,\s*([\d.]+)fr\)/);
    expect(m).toBeTruthy();
    const [statusShare, addressShare] = [parseFloat(m![1]), parseFloat(m![2])];
    expect(addressShare / statusShare).toBeGreaterThanOrEqual(2);
  });
});

describe('hidden means hidden, even for a flex button', () => {
  // FOUND BY SCREENSHOT, AND ONLY BY SCREENSHOT.
  // The cold LOCAL render showed "RELEASE THIS FIELD" sitting under a column of
  // em-dashes — offering to release a field that was never bound. Yet jsdom and
  // four existing assertions all agreed: `inspUnpair.hidden === true`.
  //
  // Both were right, and that is the whole defect. The ATTRIBUTE was set
  // correctly by popup.js; what failed was the STYLESHEET. The UA default
  // `[hidden] { display: none }` is a plain attribute selector, so ANY class rule
  // that sets `display` outranks it — and `.btn { display: inline-flex }` does
  // exactly that. Chromium measured the "hidden" button at 141x30px, fully
  // visible.
  //
  // This is the same trap the connector comment had already documented for
  // `.card` and patched with `.panel .card[hidden] { display: none }` — a
  // one-element fix for a stylesheet-wide problem. So the guard here is global.
  it('gives [hidden] a rule strong enough to beat display-setting classes', () => {
    const live = readFileSync(POPUP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(live).toContain('.btn {');   // stripper sanity check

    // A global guard, not another per-element patch: every `display`-setting
    // class in the file would otherwise need its own [hidden] twin, and the next
    // one added would silently reintroduce this.
    expect(live).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none[^}]*\}/);
  });

  it('does not let .btn out-rank it', () => {
    // Pins the specific collision, so the global rule cannot be weakened into
    // something .btn beats again.
    const live = readFileSync(POPUP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const guard = live.match(/\[hidden\]\s*\{[^}]*\}/g) || [];
    // `!important` is the honest tool here: the competing declaration is a class
    // rule, which beats a bare attribute selector on specificity no matter where
    // it sits in the file.
    expect(guard.some((g) => /display:\s*none\s*!important/.test(g))).toBe(true);
  });
});
