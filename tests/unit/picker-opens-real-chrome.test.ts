/**
 * The crosshair must open the REAL Chromium, not the canvas simulator.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The operator asked for the simulator to be gone, and specifically for the
 * crosshair itself to be what brings up the remote browser:
 *
 *   «من گفتم کلا شبیه ساز رو حذف کن و به جاش وقتی روی ایکن هدف گیری یا پیکره
 *    چیه همون کلیک میشه باید به جای شبیه ساز یه تب جدید خود جوش باز بشه رو
 *    مرورگرم و کرومیوم ریموت رو بالا بیاره»
 *
 * A previous round satisfied the letter of that by adding a button INSIDE the
 * simulator, which is not what was asked. These tests pin the behaviour so it
 * cannot quietly slide back.
 *
 * HOW THEY TEST IT
 * ----------------
 * browser-view.js is a browser IIFE that touches `window`, `document` and
 * `WebSocket` at load, and this repo deliberately has no jsdom (vitest runs
 * `environment: 'node'`; see the note in ab-core.test.ts). So rather than
 * import it, each test EXECUTES the one function under test in isolation with
 * fakes for the handful of globals it uses, and asserts on what that function
 * DID — which tab it opened, which endpoint it called, where it navigated.
 * That is behaviour, not a grep for a string in the source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'public/js/browser-view.js'), 'utf8');

/** Cut one top-level `function name(...) { ... }` out of the file by brace depth. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * Return the BODY of the click handler registered for `q('<id>')`.
 *
 * An earlier version of this file matched the handler with a regex carrying a
 * `{0,200}` character budget. That is brittle for a reason worth naming: it
 * silently stops matching as soon as anyone adds a comment or a line to the
 * handler, and the resulting failure ("expected null not to be null") points at
 * the test rather than at the code. Scanning braces instead makes the helper
 * indifferent to length and formatting.
 */
function extractClickHandlerBody(src: string, id: string): string {
  const anchor = `q('${id}').addEventListener('click'`;
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`no click handler registered for ${id}`);
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error(`click handler for ${id} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in the ${id} click handler`);
}

/** Cut one top-level `var name = <literal>;` out of the file. */
function extractVar(src: string, name: string): string {
  const m = new RegExp(`var ${name} = [^;]+;`).exec(src);
  if (!m) throw new Error(`var ${name} not found`);
  return m[0];
}

/**
 * The functions `openRealBrowser` depends on, in the order they must be defined.
 *
 * WHY THIS LIST EXISTS. The harness used to inject `openRealBrowser` alone, and
 * when the blank-tab placeholder was added the sandbox started throwing
 * `ReferenceError: tabPlaceholder is not defined` — eleven tests failing on a
 * missing fake rather than on the behaviour they describe. A single list keeps
 * the harness honest: add a dependency to the source and it is declared here,
 * not discovered by a confusing failure.
 *
 * `stillStarting` joined the list when openRealBrowser learned to retry a cold
 * start, and it proved the note above: four tests began failing with
 * `ReferenceError: stillStarting is not defined`, pointing at the harness rather
 * than at any behaviour.
 */
const OPEN_REAL_BROWSER_DEPS = ['tabPlaceholder', 'directViewHref', 'stillStarting'] as const;

/**
 * The retry budget, EXTRACTED rather than restated.
 *
 * Taking these from the source keeps the harness from asserting against numbers
 * the shipped file no longer uses. Tests that exercise the retry path reassign
 * the backoff (they are plain `var`s in the injected scope) so a wait measured
 * in seconds in production is measured in a millisecond here.
 */
const OPEN_REAL_BROWSER_VARS = ['REAL_OPEN_ATTEMPTS', 'REAL_OPEN_BACKOFF_MS'] as const;

function openRealBrowserSource(): string {
  return [
    ...OPEN_REAL_BROWSER_VARS.map((n) => extractVar(SRC, n)),
    ...OPEN_REAL_BROWSER_DEPS.map((n) => extractFunction(SRC, n)),
    extractFunction(SRC, 'openRealBrowser'),
  ].join('\n');
}

/**
 * The same rule, for `requestPick`'s own helpers.
 *
 * `inspectorHint` is the Element Inspector's discoverability hint: the crosshair
 * opens the real browser and then says how to finish the pick there (Ctrl+Shift+
 * C), because the canvas simulator that used to do the picking is gone and the
 * extension replaced it. It is a separate list from OPEN_REAL_BROWSER_DEPS on
 * purpose -- filing a requestPick dependency under openRealBrowser would make
 * the next reader believe openRealBrowser needs it, which it does not.
 *
 * Kept as a declared list for the reason the note above gives: a dependency the
 * harness does not know about surfaces as `ReferenceError: inspectorHint is not
 * defined` across a dozen tests, pointing at the harness instead of at the code.
 */
const REQUEST_PICK_DEPS = ['inspectorHint'] as const;

function requestPickSource(): string {
  return [
    ...REQUEST_PICK_DEPS.map((n) => extractFunction(SRC, n)),
    extractFunction(SRC, 'requestPick'),
  ].join('\n');
}

type Recorder = {
  opened: Array<{ url: string; target: string }>;
  navigated: string[];
  closed: number;
  posted: Array<{ path: string; body: unknown }>;
  toasts: string[];
  /** Every document.write() the placeholder performed into the new tab. */
  wrote: string[];
  /** What was put in the `.e` error slot, via textContent (never markup). */
  errors: string[];
  /** href set on the self-service links, keyed by element id. */
  links: Record<string, string>;
  /** Elements whose `hidden` was set false, keyed by id (the install hint). */
  unhidden: Record<string, boolean>;
  /** Interleaved trace: 'write' / 'post' / 'navigate' / 'close'. */
  order: string[];
};

/**
 * A document just real enough for `tabPlaceholder`.
 *
 * It is not a DOM: it records the written markup and exposes only the two
 * lookups the placeholder performs (`.e` for the error text, `#direct` /
 * `#again` for the self-service links). Anything richer would be fidelity we do
 * not need and cannot verify.
 */
function fakeTabDocument(rec: Recorder) {
  const slots: Record<string, { setAttribute(n: string, v: string): void }> = {};
  return {
    open() { /* starts a new document */ },
    write(html: string) {
      rec.wrote.push(html);
      rec.order.push('write');
    },
    close() { /* ends it */ },
    querySelector(sel: string) {
      if (sel !== '.e') return null;
      // Only present on the failure page, which is the page that has an error.
      if (!/class="e"/.test(rec.wrote[rec.wrote.length - 1] || '')) return null;
      return { set textContent(v: string) { rec.errors.push(v); } };
    },
    getElementById(id: string) {
      const last = rec.wrote[rec.wrote.length - 1] || '';
      if (!new RegExp(`id="${id}"`).test(last)) return null;
      if (!slots[id]) {
        slots[id] = {
          setAttribute(name: string, value: string) {
            if (name === 'href') rec.links[id] = value;
          },
          // The install hint is revealed by clearing `hidden`, not by an
          // attribute, so the fake has to record that assignment or the
          // "only for a Missing: failure" rule cannot be tested at all.
          set hidden(v: boolean) { rec.unhidden[id] = v === false; },
        };
      }
      return slots[id];
    },
  };
}

function newRecorder(): Recorder {
  return {
    opened: [], navigated: [], closed: 0, posted: [], toasts: [],
    wrote: [], errors: [], links: {}, unhidden: {}, order: [],
  };
}

/** The fakes `openRealBrowser` runs against, wired to one recorder. */
function sandboxFor(
  rec: Recorder,
  postResult: { ok: true; viewPath: string } | { ok: false; error: string },
) {
  const fakeTab = {
    document: fakeTabDocument(rec),
    set location(href: string) { rec.navigated.push(href); rec.order.push('navigate'); },
    close() { rec.closed++; rec.order.push('close'); },
  };

  return {
    window: {
      open(url: string, target: string) {
        rec.opened.push({ url, target });
        rec.order.push('open');
        return fakeTab;
      },
    },
    API: {
      getKey: () => 'THE-KEY',
      post: (path: string, body: unknown) => {
        rec.posted.push({ path, body });
        rec.order.push('post');
        return postResult.ok
          ? Promise.resolve({ success: true, viewPath: postResult.viewPath })
          : Promise.resolve({ success: false, error: postResult.error });
      },
    },
    t: (k: string) => k,
    toast: (m: string) => { rec.toasts.push(m); },
  };
}

/**
 * Run `requestPick` (and the `openRealBrowser` it delegates to) against fakes,
 * and report everything they did.
 *
 * `postResult` lets a test choose whether the server call succeeds or fails.
 */
async function runRequestPick(
  opts: unknown,
  postResult: { ok: true; viewPath: string } | { ok: false; error: string },
): Promise<Recorder> {
  const rec = newRecorder();
  const sandbox = sandboxFor(rec, postResult);

  const body = `
    ${openRealBrowserSource()}
    ${requestPickSource()}
    return requestPick(function () {}, OPTS);
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('window', 'API', 't', 'toast', 'OPTS', body);
  try {
    await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, opts);
  } catch { /* the failure path rethrows on purpose; the recorder is what matters */ }
  // Let the promise chain settle.
  await new Promise((r) => setTimeout(r, 0));
  return rec;
}

describe('clicking the crosshair', () => {
  it('opens a new tab', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.opened.length).toBe(1);
    expect(rec.opened[0].target).toBe('_blank');
  });

  it('opens that tab SYNCHRONOUSLY, before the server is asked', async () => {
    // THE POPUP-BLOCKER RULE. window.open() only survives inside the click
    // gesture; opening it after the await is silently blocked and the crosshair
    // appears to do nothing. Asserting the ORDER is what pins this — the tab
    // must already exist by the time the POST goes out.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.order.filter((s) => s === 'open' || s === 'post')).toEqual(['open', 'post']);
  });

  it('writes the placeholder into that tab BEFORE the server is asked', async () => {
    // §3.1 of the handoff. The blank tab is unavoidable (popup blockers), so the
    // fix is that it is never a mystery: it must be written into inside the same
    // gesture, not after the await, or the operator stares at about:blank while
    // Chrome boots and cannot tell "slow" from "dead".
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.order.slice(0, 3)).toEqual(['open', 'write', 'post']);
    expect(rec.wrote[0]).toContain('Starting the remote browser');
  });

  it('gives the waiting tab a link it can use itself', async () => {
    // «اصلا تغییر نمیکنه about:blank و در واقع نمی تونم به مرورگر ریموت دسترسی
    //  پیدا کنم» — if this page's own attempt to navigate the tab never lands,
    // the operator must still have a way in, with the api_key a freshly opened
    // tab cannot send as a header.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.links.direct).toBe('/desktop/chrome?api_key=THE-KEY');
  });

  it('navigates that tab to the BARE Chromium view, with the api key', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.navigated).toEqual(['/desktop/chrome?api_key=THE-KEY']);
  });

  it('never sends the operator to a noVNC client', async () => {
    // The complaint was «نمیخام به گزینه های مثل vnc یا novnc روبرو بشم».
    // vnc.html ships 64 noVNC UI elements; vnc_lite.html still has a status bar.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    for (const href of rec.navigated) {
      expect(href).not.toMatch(/vnc\.html|vnc_lite|novnc/i);
    }
  });

  it('asks the server to bring the real browser up', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.posted.map((p) => p.path)).toEqual(['/browser/real/open']);
  });

  it('carries the URL the caller seeded, so the tab lands on the right page', async () => {
    const rec = await runRequestPick(
      { url: 'https://example.com/login' },
      { ok: true, viewPath: '/desktop/chrome' },
    );
    expect(rec.posted[0].body).toEqual({ url: 'https://example.com/login' });
  });

  it('sends an empty url rather than undefined when nothing was seeded', async () => {
    // `{ url: undefined }` serialises to `{}` but a literal string 'undefined'
    // would be navigated to, so this is worth pinning.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.posted[0].body).toEqual({ url: '' });
  });

  it('respects a viewPath that already has a query string', async () => {
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome?x=1' });
    expect(rec.navigated).toEqual(['/desktop/chrome?x=1&api_key=THE-KEY']);
  });

  it('KEEPS the tab on failure and explains itself inside it', async () => {
    // This test used to assert the opposite (`closed === 1`). Closing the tab
    // was meant to be tidy and measured badly: the new tab is in the FOREGROUND
    // while the page that opened it is not, so the operator saw a window vanish
    // and never read the toast that explained why — the failure was
    // indistinguishable from the hang this whole change exists to end.
    const rec = await runRequestPick({}, { ok: false, error: 'desktop_not_running' });
    expect(rec.closed).toBe(0);
    expect(rec.navigated).toEqual([]);
    expect(rec.wrote[rec.wrote.length - 1]).toContain('did not start');
    // The reason is put in via textContent, never markup: `detail` is a
    // server/proxy message and may itself BE an HTML document (the closed-port
    // error page is exactly that).
    expect(rec.errors).toEqual(['desktop_not_running']);
    // And a Retry the operator can press from the tab they are looking at.
    expect(rec.links.again).toBe('/desktop/chrome?api_key=THE-KEY');
  });

  it('still tells the operator via a toast as well', async () => {
    const rec = await runRequestPick({}, { ok: false, error: 'desktop_not_running' });
    expect(rec.toasts.join(' ')).toContain('desktop_not_running');
  });
});

/**
 * The reported dead end:
 *
 *   «The remote browser did not start / Missing: Xvfb …
 *    بعد من همین Retry رو میزنم شروع میکنه به starting cromium... ولی باز فقط
 *    میچرخه و چیزی بالا نمیاد»
 *
 * Two halves. Retry has to lead somewhere that STARTS the stack — which is now
 * true of the view itself (ChromeView.startThenConnect), so the link is correct
 * only as long as it points at the view and the view keeps that behaviour;
 * tools/probe-remote-browser-retry.js pins the second half. And a failure that
 * NO button can fix has to say what will fix it, instead of offering a retry
 * that is guaranteed to fail again.
 */
describe('a failure the operator can actually act on', () => {
  it('explains the missing-package failure when, and only when, packages are missing', async () => {
    const missing = await runRequestPick(
      {},
      { ok: false, error: 'Missing: Xvfb. Install the virtual display: sudo apt-get install -y xvfb' },
    );
    // Revealed for this failure...
    expect(missing.unhidden.deps).toBe(true);
    const page = missing.wrote[missing.wrote.length - 1];

    // This assertion CHANGED, and the reason is the whole point of it. It used to
    // require the page to print `scripts/desktop.sh install`, i.e. to tell the
    // user to run a root command by hand. The server now provisions the display
    // stack itself, rootlessly, into its own directory, so that instruction is no
    // longer true -- and telling a user without sudo to run sudo is exactly the
    // dead end the original bug report was about. What must survive is the
    // guard's INTENT: this screen has to say what will actually fix it.
    //
    // So: Retry is now the real remedy, and the page must say so...
    expect(page).toContain('Retry');
    // ...must warn that the first attempt is slow, or the user aborts a working
    // provision at 40 seconds thinking it hung...
    expect(page).toMatch(/minute/i);
    // ...must name the two things that genuinely stop it, since those are the
    // only cases left where a human has to intervene...
    expect(page).toContain('DESKTOP_AUTO_PROVISION');
    expect(page).toMatch(/mirror/i);
    // ...and must NOT resurrect the manual root instruction.
    expect(page).not.toContain('scripts/desktop.sh install');
    expect(page).not.toContain('apt-get install');

    // The server's own wording is still preserved, since it names the package.
    expect(missing.errors[0]).toContain('Missing: Xvfb');

    // ...but NOT for an unrelated failure, where it would read as "your server
    // is broken" on a box that has everything installed.
    const other = await runRequestPick({}, { ok: false, error: 'desktop_not_running' });
    expect(other.unhidden.deps).toBeUndefined();
  });

  it('sends Retry to a destination that starts the stack, not to a dead end', async () => {
    const rec = await runRequestPick({}, { ok: false, error: 'boom' });
    // The view is the correct target ONLY because it now starts the stack on
    // load. If this ever points at something inert again, the operator is back
    // to a Retry that cannot recover.
    expect(rec.links.again).toBe('/desktop/chrome?api_key=THE-KEY');
  });

  it('no longer claims a retry is all that is needed', async () => {
    // The old copy said "Close this tab and press the crosshair again", which
    // for a missing package is advice that cannot work.
    const rec = await runRequestPick({}, { ok: false, error: 'Missing: Xvfb.' });
    const page = rec.wrote[rec.wrote.length - 1];
    expect(page).not.toContain('press the crosshair again');
  });
});

describe('the canvas simulator is no longer the crosshair destination', () => {
  it('requestPick does not build the picker overlay', async () => {
    // The old implementation created a `.bvp-backdrop` div and appended it to
    // document.body. The fakes above provide NO document at all, so if
    // requestPick still touched it this would throw -- and, more directly,
    // nothing was appended anywhere.
    const rec = await runRequestPick({}, { ok: true, viewPath: '/desktop/chrome' });
    expect(rec.opened.length).toBe(1); // it opened a tab...
    expect(rec.posted.length).toBe(1); // ...and called the server, nothing else
  });

  it('requestPick contains no canvas/WebSocket streaming machinery', () => {
    const fn = extractFunction(SRC, 'requestPick');
    for (const token of ['bvp-canvas', 'bvp-backdrop', 'getContext', 'WebSocket', 'pickerMarkup']) {
      expect(fn, `requestPick still references ${token}`).not.toContain(token);
    }
  });

  it('keeps the canvas picker available under its own name', () => {
    // Renamed, not deleted: it is ~2000 lines of selector generation, and
    // removing it in the same change that redirects the crosshair would be two
    // risky edits at once.
    expect(SRC).toContain('function requestPickCanvas(');
    expect(SRC).toMatch(/window\.BrowserView\s*=\s*\{[\s\S]*requestPickCanvas/);
  });
});

/**
 * THE BROWSER-ENVIRONMENT CHOICE COMES FIRST.
 *
 * Everything above pins what happens once REMOTE is the answer. This block
 * pins the step in front of it. The operator's correction was that the
 * crosshair must not decide the environment on the user's behalf:
 *
 *   «وقتی روی آیکون 🎯 Target This Field کلیک می‌شود، اولین قدم باید انتخاب
 *    محیط مرورگر باشد، نه انتخاب حالت اتصال.»
 *
 * So `requestPick` now hands off to TargetingFlow whenever it knows WHICH
 * FIELD is being targeted, and only opens the server's Chromium when there is
 * no field identity to pair against (the canvas-level picker and older call
 * sites), which is why the tests above still describe real behaviour.
 */
describe('requestPick defers to the LOCAL / REMOTE chooser', () => {
  /** Run `requestPick` with a TargetingFlow present, and report what it did. */
  async function runWithFlow(opts: unknown, flowStarts: boolean) {
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, { ok: true, viewPath: '/desktop/chrome' });
    const started: unknown[] = [];
    (sandbox.window as Record<string, unknown>).TargetingFlow = {
      start(ctx: unknown) { started.push(ctx); return flowStarts; },
    };

    const body = `
      ${openRealBrowserSource()}
      ${requestPickSource()}
      return requestPick(function () {}, OPTS);
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', 'OPTS', body);
    try {
      await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, opts);
    } catch { /* the recorder is what matters */ }
    await new Promise((r) => setTimeout(r, 0));
    return { rec, started };
  }

  const FIELD = {
    nodeId: '8f21',
    fieldKey: 'product_selector',
    action: 'click',
    workflowId: 'wf1',
    url: 'https://shop.example/p/1',
  };

  it('opens NO browser when a field identity is supplied', async () => {
    // The regression this whole change exists to prevent: reaching the remote
    // Chromium before the operator has chosen an environment.
    const { rec, started } = await runWithFlow(FIELD, true);
    expect(started.length).toBe(1);
    expect(rec.opened).toEqual([]);
    expect(rec.posted).toEqual([]);
  });

  it('passes the field identity through to the chooser', async () => {
    const { started } = await runWithFlow(FIELD, true);
    expect(started[0]).toMatchObject({
      nodeId: '8f21',
      fieldKey: 'product_selector',
      action: 'click',
      // Part of the STABLE pairing key: without it the same node id in two
      // workflows would share one pairing.
      workflowId: 'wf1',
      url: 'https://shop.example/p/1',
    });
  });

  it('still opens the Remote Browser when there is no field to pair against', async () => {
    // The canvas-level picker has no declared field, so there is nothing a
    // pairing could be filed under and REMOTE is the only possible answer.
    // Preserved deliberately — the requirement was to ADD the choice in front
    // of the flow, not to delete the Remote Browser path.
    const { rec, started } = await runWithFlow({ url: 'https://example.com' }, true);
    expect(started).toEqual([]);
    expect(rec.opened.length).toBe(1);
    expect(rec.posted[0].path).toBe('/browser/real/open');
  });

  it('opens NOTHING when the chooser declines — it must not choose for the user', async () => {
    // ══════════════════════════════════════════════════════════════════════
    // THIS TEST PREVIOUSLY ASSERTED THE DEFECT, VERBATIM: it required that a
    // declining chooser fall back to opening the server's browser. That
    // fallback IS the reported bug:
    //
    //   «بعد از اینکه من Local Browser رو انتخاب می‌کنم، دیگه مجبورم می‌کنه
    //    همیشه وقتی روی اون آیکون Picker که میزنم، اون باکس بالا نمیاد که من
    //    Remote Browser رو این بار انتخاب کنم. وقتی روی اون آیکون Picker
    //    می‌زنم مستقیماً Local Browser رو واسم باز می‌کنه که این افتضاحه»
    //
    // It reads as a remembered preference and is not one — nothing in this
    // codebase stores an environment, and the chooser renders unconditionally.
    // What happens is this: `flow.start()` returns false while InspectorClient
    // is still resolving (the ordinary state for the first clicks after a
    // reload), control fell through to the tail of requestPick, and the server's
    // browser opened with no dialog at all. Silent LOCAL, every time.
    //
    // The old test's reasoning — \"leaving the crosshair dead would be worse\" —
    // had the right instinct and the wrong remedy. The crosshair is not left
    // dead: it REPORTS, via pick.chooserUnavailable, and the operator's next
    // click typically succeeds. Choosing an environment silently on their behalf
    // is strictly worse than saying \"not yet\", because it is unfalsifiable from
    // the outside — which is exactly why this shipped.
    // ══════════════════════════════════════════════════════════════════════
    const { rec, started } = await runWithFlow(FIELD, false);
    expect(started.length).toBe(1);
    // No browser, and no server call to open one.
    expect(rec.opened).toEqual([]);
    expect(rec.posted).toEqual([]);
  });

  it('tells the operator WHY, instead of failing silently', async () => {
    // A refusal nobody can see is a dead crosshair, which is the failure mode
    // the old fallback was (rightly) afraid of. The toast is what makes the
    // refusal honest rather than mute, so it is part of the contract.
    const { rec } = await runWithFlow(FIELD, false);
    expect(rec.toasts).toContain('pick.chooserUnavailable');
  });

  it('does not report a chooser problem when the chooser worked', async () => {
    // The complement, so the message cannot decay into an always-on warning.
    const { rec } = await runWithFlow(FIELD, true);
    expect(rec.toasts).not.toContain('pick.chooserUnavailable');
  });

  it('still opens the browser directly when TargetingFlow is absent entirely', async () => {
    // A host page that never loaded targeting-flow.js has no chooser to wait
    // for, so refusing would leave it with no way to reach a browser at all.
    // \"No chooser exists\" and \"the chooser is not ready\" are different states
    // and must not collapse into one another.
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, { ok: true, viewPath: '/desktop/chrome' });
    const body = `
      ${openRealBrowserSource()}
      ${requestPickSource()}
      return requestPick(function () {}, OPTS);
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', 'OPTS', body);
    try {
      await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, FIELD);
    } catch { /* the recorder is what matters */ }
    await new Promise((r) => setTimeout(r, 0));

    expect(rec.opened.length).toBe(1);
    expect(rec.toasts).not.toContain('pick.chooserUnavailable');
  });
});

/**
 * THE CROSSHAIR IN ndv-nodes.js MUST REFUSE THE SAME WAY.
 *
 * requestPick is the second line of defence; `pickerBtn` is the button the
 * operator actually presses, and it consults TargetingFlow itself before ever
 * reaching BrowserView. Fixing only requestPick would leave the reported path
 * intact, because pickerBtn's own fall-through called requestPick WITHOUT a
 * field identity's protection — it passed the full opts, so requestPick would
 * have re-entered the flow branch, but on a host where `start()` keeps declining
 * the net effect was still a silent LOCAL open.
 *
 * Driven as source rather than executed: pickerBtn is bound to UI().iconBtn and
 * a live NDV column, and standing that up would test the harness rather than the
 * decision. The decision is a control-flow property — does the declining branch
 * reach requestPick? — and that is what is asserted, on the extracted handler
 * only, never on the file as a whole.
 */
describe('the NDV picker button refuses rather than choosing an environment', () => {
  const ndv = readFileSync(join(ROOT, 'public/js/ndv-nodes.js'), 'utf8');

  /** The body of `pickerBtn`, by brace depth — length- and comment-proof. */
  const pickerBtnSrc = (() => {
    const start = ndv.indexOf('function pickerBtn(');
    if (start < 0) throw new Error('pickerBtn not found');
    const open = ndv.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < ndv.length; i++) {
      if (ndv[i] === '{') depth++;
      else if (ndv[i] === '}') { depth--; if (depth === 0) return ndv.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces in pickerBtn');
  })();

  it('reports the unavailable chooser from the button itself', () => {
    expect(pickerBtnSrc).toContain('pick.chooserUnavailable');
  });

  it('returns on a declining chooser instead of continuing to requestPick', () => {
    // The control-flow property that matters: between `if (started) return;`
    // and the BrowserView fallback there must be an unconditional `return`, or
    // a declining chooser still ends in a silent browser launch.
    const afterStarted = pickerBtnSrc.slice(pickerBtnSrc.indexOf('if (started) return;'));
    const guard = afterStarted.indexOf('return;', 'if (started) return;'.length);
    const fallback = afterStarted.indexOf('BrowserView.requestPick');
    expect(guard).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fallback);
  });

  it('keeps the BrowserView fallback for callers with no field identity', () => {
    // The condition-row picker genuinely has no nodeId/fieldKey to pair
    // against, so it must still be able to reach a browser. Deleting the
    // fallback would break it — the fix is a guard INSIDE the flow branch, not
    // the removal of the branch after it.
    expect(pickerBtnSrc).toContain('BrowserView.requestPick');
  });
});

describe('the crosshair wiring still lines up end to end', () => {
  const ndv = readFileSync(join(ROOT, 'public/js/ndv-nodes.js'), 'utf8');

  it('ndv-nodes.js calls the export browser-view.js provides', () => {
    expect(ndv).toContain('BrowserView.requestPick');
    expect(SRC).toMatch(/window\.BrowserView\s*=\s*\{[\s\S]*requestPick:/);
  });

  it('the crosshair reaches TargetingFlow before it reaches the browser', () => {
    // Both layers must agree: ndv-nodes.js tries the chooser first, and
    // browser-view.js refuses to be the shortcut around it.
    expect(ndv).toContain('TargetingFlow');
    expect(extractFunction(SRC, 'requestPick')).toContain('TargetingFlow');
  });

  it('both entry points share one implementation', () => {
    // The in-panel button and the crosshair must not drift apart.
    expect(SRC).toContain('function openRealBrowser(');
    expect(extractClickHandlerBody(SRC, 'bvp-real')).toContain('openRealBrowser');
    expect(extractFunction(SRC, 'requestPick')).toContain('openRealBrowser');
  });
});

describe('a failed launch does not escape as an unhandled rejection', () => {
  /**
   * MEASURED, not assumed. `openRealBrowser` rethrows on purpose so that a
   * caller which awaits it can react. But the two call sites that actually
   * exist — the crosshair (`requestPick`) and the in-panel button — are
   * fire-and-forget. Running that exact shape in a real Chromium produced:
   *
   *   EVENTS=["TOAST_SHOWN","UNHANDLED:desktop_not_running"]
   *   RAISES_UNHANDLED=true
   *
   * i.e. the operator IS told what went wrong (good), and the rejection then
   * escapes anyway (bad) and trips page-level error reporting. The fix belongs
   * at the fire-and-forget call sites, not inside openRealBrowser — removing
   * the rethrow there would silently disarm every awaiting caller.
   *
   * Node reports the same condition as process 'unhandledRejection', so that
   * is what these tests listen for.
   */
  async function unhandledFrom(source: string): Promise<Error[]> {
    const caught: Error[] = [];
    const onUnhandled = (reason: unknown) => { caught.push(reason as Error); };

    // Take over rejection reporting for the duration of this test so vitest's
    // own handler does not also fire.
    const previous = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', onUnhandled);
    try {
      const rec = newRecorder();
      const sandbox = sandboxFor(rec, { ok: false, error: 'desktop_not_running' });
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('window', 'API', 't', 'toast', source);
      fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast);
      // Rejections are reported on a later turn; give the loop time to do it.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      for (const l of previous) {
        process.on('unhandledRejection', l as (r: unknown, p: Promise<unknown>) => void);
      }
    }
    return caught;
  }

  it('the crosshair swallows the rejection after the toast', async () => {
    const caught = await unhandledFrom(`
      ${openRealBrowserSource()}
      ${requestPickSource()}
      requestPick(function () {}, {});
    `);
    expect(
      caught.map((e) => e && e.message),
      'requestPick let a rejection escape; it must .catch() its own call',
    ).toEqual([]);
  });

  it('the in-panel button swallows it too', async () => {
    // Same shape as the bvp-real click handler: call, ignore the promise.
    const caught = await unhandledFrom(`
      ${openRealBrowserSource()}
      var urlIn = { value: 'https://example.com' };
      ${extractClickHandlerBody(SRC, 'bvp-real')}
    `);
    expect(
      caught.map((e) => e && e.message),
      'the bvp-real button let a rejection escape',
    ).toEqual([]);
  });

  it('openRealBrowser STILL rethrows, so awaiting callers can react', async () => {
    // The swallow must live at the call sites. If it migrated into
    // openRealBrowser, a future caller that awaits it would treat a failed
    // launch as a success.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', `
      ${openRealBrowserSource()}
      return openRealBrowser('');
    `);
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, { ok: false, error: 'desktop_not_running' });
    const p = fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast);
    await expect(p).rejects.toThrow('desktop_not_running');
  });
});

/* ===========================================================================
   A COLD START IS NOT A FAILURE — «هیچ مرورگری بالا نمیاد»

   REPORTED: «وقتی می‌زنم که Local رو انتخاب کنم خب اولش باید اینجوری باشه که
   روی یک تب جدیدی مرورگر Local سرور بالا بیاد … ولی هیچ مرورگری بالا نمیاد».

   MEASURED against the running server, first-ever start:

     POST /browser/real/open -> 503
       {"success":false,"error":"remote_browser_starting","retryable":true,
        "startedMs":25001,"desktop":{"enabled":false,"xvfb":{"missing":true}}}
     … ~30s later, identical request -> 200 {"success":true,
        "viewPath":"/desktop/chrome"}

   The browser starts fine. The FIRST call loses a race against the desktop
   stack provisioning itself, and the server says so in the most explicit way
   available to it: `retryable: true`, plus a dedicated error token. This client
   treated that as terminal, so the tab never left the placeholder and the
   operator's only evidence was a window that never became a browser.

   These tests measure the LOOP, not the wording: how many times the endpoint was
   asked, and whether the tab was eventually navigated. A comment claiming a
   retry cannot satisfy them.
   =========================================================================== */
describe('a cold start is retried instead of reported as a failure', () => {
  /**
   * A sandbox whose POST answers from a SCRIPT — one entry per attempt.
   *
   * The script is what makes "the second attempt succeeds" expressible at all.
   * `sandboxFor` returns one fixed answer forever, which can only describe a
   * server that is permanently up or permanently down — neither of which is the
   * cold start being fixed here.
   */
  function scriptedSandbox(
    rec: Recorder,
    script: Array<
      | { kind: 'ok'; viewPath: string }
      | { kind: 'starting' }        // 503 + retryable, as a REJECTION (api.js throws)
      | { kind: 'gateway'; status: number }
      | { kind: 'fatal'; error: string }
    >,
  ) {
    const fakeTab = {
      document: fakeTabDocument(rec),
      set location(href: string) { rec.navigated.push(href); rec.order.push('navigate'); },
      close() { rec.closed++; rec.order.push('close'); },
    };
    let n = 0;
    return {
      window: {
        open(url: string, target: string) {
          rec.opened.push({ url, target });
          rec.order.push('open');
          return fakeTab;
        },
      },
      API: {
        getKey: () => 'THE-KEY',
        post: (path: string, body: unknown) => {
          rec.posted.push({ path, body });
          rec.order.push('post');
          // The last entry repeats, so a script does not have to be as long as
          // the retry budget to describe "it never comes up".
          const step = script[Math.min(n, script.length - 1)];
          n++;
          if (step.kind === 'ok') {
            return Promise.resolve({ success: true, viewPath: step.viewPath });
          }
          if (step.kind === 'starting') {
            // EXACTLY what the server sends, and exactly how api.js surfaces
            // it: request() throws on any non-2xx, attaching the parsed body.
            // This fidelity is the point — the old code's bug was in the
            // REJECTION branch, so a fake that resolved would have missed it.
            const err = Object.assign(new Error('remote_browser_starting'), {
              status: 503,
              body: {
                success: false,
                error: 'remote_browser_starting',
                retryable: true,
                startedMs: 25001,
              },
            });
            return Promise.reject(err);
          }
          if (step.kind === 'gateway') {
            const err = Object.assign(new Error('HTTP ' + step.status), {
              status: step.status,
              // A gateway page is not our JSON: there is no body to read a
              // `retryable` flag out of. The status alone has to carry it.
              body: undefined,
            });
            return Promise.reject(err);
          }
          const err = Object.assign(new Error(step.error), {
            status: 503,
            body: { success: false, error: step.error, retryable: false },
          });
          return Promise.reject(err);
        },
      },
      t: (k: string) => k,
      toast: (m: string) => { rec.toasts.push(m); },
    };
  }

  /**
   * Run openRealBrowser against a script, with the backoff collapsed to ~0.
   *
   * The reassignment is why OPEN_REAL_BROWSER_VARS extracts these as `var`s
   * rather than inlining them: the production wait is 2.5s per attempt, and a
   * test that honoured it would take 20 seconds to prove one loop.
   */
  async function runScripted(
    script: Parameters<typeof scriptedSandbox>[1],
    overrides = 'REAL_OPEN_BACKOFF_MS = 1;',
  ): Promise<{ rec: Recorder; error: Error | null }> {
    const rec = newRecorder();
    const sandbox = scriptedSandbox(rec, script);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', `
      ${openRealBrowserSource()}
      ${overrides}
      return openRealBrowser('https://example.com');
    `);
    let error: Error | null = null;
    try {
      await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast);
    } catch (e) {
      error = e as Error;
    }
    return { rec, error };
  }

  it('THE REPORTED CASE: a 503 remote_browser_starting is retried, and the tab opens', async () => {
    // This is the exact sequence measured on the box: one refusal while the
    // desktop stack provisions, then success.
    const { rec, error } = await runScripted([
      { kind: 'starting' },
      { kind: 'ok', viewPath: '/desktop/chrome' },
    ]);

    expect(error, 'a retryable cold start must not surface as an error').toBe(null);
    // Asked twice — the proof that a retry happened at all.
    expect(rec.posted.length).toBe(2);
    // And the tab was actually sent to the browser view. THIS is «مرورگر بالا
    // بیاد»: before the fix this array was empty and the tab sat on a failure
    // page forever.
    expect(rec.navigated.length).toBe(1);
    expect(rec.navigated[0]).toContain('/desktop/chrome');
    // No failure page was ever painted.
    expect(rec.errors).toEqual([]);
  });

  it('keeps waiting across several refusals, then opens', async () => {
    const { rec, error } = await runScripted([
      { kind: 'starting' },
      { kind: 'starting' },
      { kind: 'starting' },
      { kind: 'ok', viewPath: '/desktop/chrome' },
    ]);
    expect(error).toBe(null);
    expect(rec.posted.length).toBe(4);
    expect(rec.navigated[0]).toContain('/desktop/chrome');
  });

  it('the tab keeps its "starting" page for the whole wait — it is never told the launch failed', async () => {
    const { rec } = await runScripted([
      { kind: 'starting' },
      { kind: 'starting' },
      { kind: 'ok', viewPath: '/desktop/chrome' },
    ]);
    // The placeholder is written ONCE, up front, in the click gesture. A retry
    // must not repaint it — and above all must not paint the FAILED variant,
    // which is what the operator was seeing.
    expect(rec.wrote.length).toBe(1);
    expect(rec.wrote[0]).toContain('Starting the remote browser');
    expect(rec.wrote.join('')).not.toContain('did not start');
  });

  it('a gateway 502/504 is also treated as "still starting"', async () => {
    // A proxy that stopped waiting says nothing about the start having failed,
    // and it arrives with no JSON body to carry `retryable`.
    const { rec, error } = await runScripted([
      { kind: 'gateway', status: 504 },
      { kind: 'ok', viewPath: '/desktop/chrome' },
    ]);
    expect(error).toBe(null);
    expect(rec.posted.length).toBe(2);
    expect(rec.navigated[0]).toContain('/desktop/chrome');
  });

  it('a NON-retryable failure still fails immediately — the loop is not a blanket retry', async () => {
    // The guard against overcorrecting. `remote_browser_disabled` is a
    // configuration refusal: retrying it eight times would turn an instant,
    // actionable message into a 20-second hang ending in the same message.
    const { rec, error } = await runScripted([{ kind: 'fatal', error: 'remote_browser_disabled' }]);
    expect(error && error.message).toContain('remote_browser_disabled');
    expect(rec.posted.length, 'a non-retryable refusal must be asked exactly once').toBe(1);
    // And the operator is told, in the tab they are looking at.
    expect(rec.errors.join(' ')).toContain('remote_browser_disabled');
  });

  it('gives up after the budget rather than retrying forever', async () => {
    // A stack that never comes up must end in a reported failure, not a silent
    // infinite loop against the server.
    const { rec, error } = await runScripted([{ kind: 'starting' }]);
    expect(error, 'an endless cold start must eventually be reported').not.toBe(null);
    expect(rec.posted.length).toBe(8);   // REAL_OPEN_ATTEMPTS
    expect(rec.errors.join(' ')).toContain('remote_browser_starting');
  });

  it('the retry decision reads the SERVER\'s flag, not a guess about the message', async () => {
    // MUTATION CHECK, expressed as behaviour: `retryable: true` with an error
    // token this client has never heard of must still be retried. A predicate
    // that string-matched 'remote_browser_starting' alone would fail here, and
    // the route sets retryable on its runtime-repair path with a different
    // token (`remote_browser_disabled` + fixable steps).
    const rec = newRecorder();
    let n = 0;
    const sandbox = {
      window: {
        open() {
          rec.order.push('open');
          return {
            document: fakeTabDocument(rec),
            set location(href: string) { rec.navigated.push(href); },
            close() { rec.closed++; },
          };
        },
      },
      API: {
        getKey: () => 'K',
        post: () => {
          rec.posted.push({ path: '/browser/real/open', body: {} });
          if (n++ === 0) {
            return Promise.reject(Object.assign(new Error('some_new_token'), {
              status: 503,
              body: { success: false, error: 'some_new_token', retryable: true },
            }));
          }
          return Promise.resolve({ success: true, viewPath: '/desktop/chrome' });
        },
      },
      t: (k: string) => k,
      toast: () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', `
      ${openRealBrowserSource()}
      REAL_OPEN_BACKOFF_MS = 1;
      return openRealBrowser('');
    `);
    await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast);
    expect(rec.posted.length).toBe(2);
    expect(rec.navigated[0]).toContain('/desktop/chrome');
  });

  it('every attempt hits the SAME idempotent endpoint — no second browser is started', async () => {
    const { rec } = await runScripted([
      { kind: 'starting' },
      { kind: 'starting' },
      { kind: 'ok', viewPath: '/desktop/chrome' },
    ]);
    const paths = rec.posted.map((p) => p.path);
    expect(paths).toEqual([
      '/browser/real/open', '/browser/real/open', '/browser/real/open',
    ]);
    // The url is carried unchanged on every attempt, so a retry lands on the
    // page the operator asked for rather than on about:blank.
    for (const p of rec.posted) {
      expect(p.body).toEqual({ url: 'https://example.com' });
    }
  });

  it('opens the tab ONCE, synchronously, and reuses it across retries', async () => {
    // The popup-blocker rule still holds: window.open() only survives inside
    // the click gesture. A retry must not try to open a second tab — that one
    // would be blocked, and the operator would be left watching the first.
    const { rec } = await runScripted([
      { kind: 'starting' },
      { kind: 'starting' },
      { kind: 'ok', viewPath: '/desktop/chrome' },
    ]);
    expect(rec.opened.length).toBe(1);
    expect(rec.order[0]).toBe('open');
    expect(rec.order.indexOf('post')).toBeGreaterThan(rec.order.indexOf('open'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * `noTab` — THE LAUNCH WITHOUT A VIEWER.
 *
 * WHY THIS BLOCK EXISTS, STATED PLAINLY
 * -------------------------------------
 * Retry's contract is «Retry هیچ Tab جدیدی در Browser اصلی ایجاد نمی‌کند», and
 * it keeps that promise by calling `openRealBrowser(url, null, {noTab:true})`.
 * The Retry tests cover the CALL — that the flag is threaded from the button
 * down to here — but they replace `openRealBrowser` with a fake, so they
 * cannot see whether the real implementation honours the flag.
 *
 * That gap was measured, not assumed: deleting `o.noTab ? null :` from
 * `browser-view.js` killed ZERO tests across the whole suite. A promise the
 * suite cannot check is a promise the next refactor breaks silently.
 *
 * There are TWO places a viewer can appear, and both need pinning, because
 * fixing only the first leaves `null` meaning "open one later":
 *   1. on entry   — `target || window.open('', '_blank')`
 *   2. on success — the `else` that opened a viewer when no tab was claimed
 */
describe('openRealBrowser honours noTab — the launch Retry depends on', () => {
  /**
   * Run `openRealBrowser` directly, rather than through `requestPick`.
   *
   * Retry does not go through the crosshair, so testing it via `requestPick`
   * would test a path Retry never takes — and `requestPick` always claims a
   * tab of its own, which would mask the very thing being asserted.
   */
  async function runOpenRealBrowser(
    target: unknown,
    opts: unknown,
    postResult: { ok: true; viewPath: string } | { ok: false; error: string } =
      { ok: true, viewPath: '/desktop/chrome' },
  ): Promise<Recorder> {
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, postResult);
    const body = `
      ${openRealBrowserSource()}
      return openRealBrowser('https://example.com', TARGET, OPTS);
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', 'TARGET', 'OPTS', body);
    try {
      await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, target, opts);
    } catch { /* the failure path rethrows on purpose; the recorder is what matters */ }
    await new Promise((r) => setTimeout(r, 0));
    return rec;
  }

  it('opens NOTHING when noTab is set and no tab is handed in', async () => {
    const rec = await runOpenRealBrowser(null, { noTab: true });
    expect(rec.opened).toEqual([]);
  });

  it('still ASKS THE SERVER to bring the browser up', async () => {
    // The point of the flag is "launch, but do not show me" — a Retry after the
    // browser was closed by hand still needs it running, or the Alert has
    // nowhere to render.
    const rec = await runOpenRealBrowser(null, { noTab: true });
    expect(rec.posted.map((p) => p.path)).toEqual(['/browser/real/open']);
    expect(rec.posted[0].body).toEqual({ url: 'https://example.com' });
  });

  it('opens no viewer ON THE SUCCESS PATH either', async () => {
    // The second half. `if (tab) ... else window.open(...)` would fire here,
    // AFTER the POST resolves, so an entry-only guard is not enough.
    const rec = await runOpenRealBrowser(null, { noTab: true });
    expect(rec.opened).toEqual([]);
    expect(rec.navigated).toEqual([]);
  });

  it('navigates nothing and closes nothing when noTab is set', async () => {
    // Zero navigation and zero closes are explicit in the spec: «صفر
    // navigation برای Alert / صفر close برای Tabهای دیگر».
    const rec = await runOpenRealBrowser(null, { noTab: true });
    expect(rec.navigated).toEqual([]);
    expect(rec.closed).toBe(0);
  });

  it('opens no viewer even when the launch FAILS', async () => {
    const rec = await runOpenRealBrowser(null, { noTab: true }, { ok: false, error: 'boom' });
    expect(rec.opened).toEqual([]);
  });

  it('DOES claim a tab when noTab is absent — the crosshair path is unchanged', async () => {
    // The complement, and the reason this is a flag rather than a rewrite: the
    // Picker must keep showing the operator the browser it just launched.
    const rec = await runOpenRealBrowser(null, undefined);
    expect(rec.opened.length).toBe(1);
    expect(rec.opened[0].target).toBe('_blank');
    expect(rec.navigated.length).toBe(1);
  });

  it('DOES claim a tab when noTab is explicitly false', async () => {
    const rec = await runOpenRealBrowser(null, { noTab: false });
    expect(rec.opened.length).toBe(1);
  });

  it('uses a tab it was HANDED without opening another', async () => {
    // The popup-blocker path: the caller claimed the tab inside the gesture.
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, { ok: true, viewPath: '/desktop/chrome' });
    const handed = {
      document: fakeTabDocument(rec),
      set location(href: string) { rec.navigated.push(href); rec.order.push('navigate'); },
      close() { rec.closed++; },
    };
    const body = `
      ${openRealBrowserSource()}
      return openRealBrowser('https://example.com', TARGET, OPTS);
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', 'TARGET', 'OPTS', body);
    await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, handed, undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.opened).toEqual([]);
    expect(rec.navigated.length).toBe(1);
  });

  it('IGNORES a handed-in tab when noTab is set, rather than navigating it', async () => {
    // A caller that passes both a tab and `noTab` is contradicting itself, and
    // the flag wins: Retry must never navigate a tab the operator is using.
    const rec = newRecorder();
    const sandbox = sandboxFor(rec, { ok: true, viewPath: '/desktop/chrome' });
    const handed = {
      document: fakeTabDocument(rec),
      set location(href: string) { rec.navigated.push(href); rec.order.push('navigate'); },
      close() { rec.closed++; },
    };
    const body = `
      ${openRealBrowserSource()}
      return openRealBrowser('https://example.com', TARGET, OPTS);
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', 'API', 't', 'toast', 'TARGET', 'OPTS', body);
    await fn(sandbox.window, sandbox.API, sandbox.t, sandbox.toast, handed, { noTab: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.opened).toEqual([]);
    expect(rec.navigated).toEqual([]);
  });
});
