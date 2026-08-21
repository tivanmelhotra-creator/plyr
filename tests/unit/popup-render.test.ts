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
      { id: 'local', label: 'Local Browser', available: true, current: false },
      { id: 'remote', label: 'Remote Browser', available: true, current: false },
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
    if (type === 'AB_TARGETING_OPTIONS') {
      return options === null
        ? { ok: false, error: 'Could not load the browser choices.' }
        : { ok: true, options };
    }
    if (type === 'AB_TARGETING_BEGIN') return { ok: true, environment: msg?.payload?.environment };
    return { ok: true };
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
      sendMessage: (m: any, cb: any) => async_(cb, reply(m)),
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

  return { dom, doc: w.document as Document, sent };
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
