/**
 * toolbar-controls.test.ts — regression guard for the four dead-button bugs
 * found by driving the picker's toolbar with a real mouse in a real browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE ADDING TO THIS FILE
 *
 * These tests exist BECAUSE source-reading tests were not enough. All four bugs
 * below were live in a tree where `npx vitest run` was green and
 * `tools/probe-live-parity.js` was 69/69, because:
 *
 *   • the protocol probe drives the WebSocket and never clicks a button, so a
 *     control that is un-clickable in the DOM is invisible to it;
 *   • vitest reads source text and cannot run a listener, so wiring that is
 *     perfectly written but never reached still reads as correct.
 *
 * The instrument that actually caught them is `tools/probe-ui-controls.js`
 * (real Chromium, real clicks, observable outcomes). That probe is the PRIMARY
 * guard and this file is the cheap SECONDARY one: it pins the shapes of the
 * fixes so they cannot be quietly undone between probe runs, and it must never
 * be mistaken for proof that the buttons work. If you change any behaviour
 * here, re-run the probe — a green run in this file proves only that the source
 * still has the right shape.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The four bugs, all MEASURED 2026-08-03:
 *
 *   1. Every control inside a tab chip (the X, the mute button) was silently
 *      un-clickable. `mouseup` fires BEFORE `click`, and the tab-drag handler
 *      redrew the whole strip on mouseup — detaching the pressed element before
 *      the browser could dispatch its click.
 *   2. `navState` was never re-emitted when the streamed tab changed. History is
 *      PER TAB, so the Back/Forward arrows kept describing the tab the user had
 *      left. This is the user's original "Back and Forward don't work" report.
 *   3. The optimistic busy spinner had no way to expire: drop a nav command on
 *      the wire and it spun forever while the session was perfectly alive — the
 *      "dead but connected" lie the browser-parity work exists to remove.
 *   4. No tab could ever show a real favicon: the strict CSP (`img-src 'self'
 *      data:`) refused every remote icon URL, logging a refusal per navigation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const BV = readFileSync(join(ROOT, 'public', 'js', 'browser-view.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'src', 'core', 'LiveBrowser.ts'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
const PROBE = readFileSync(join(ROOT, 'tools', 'probe-ui-controls.js'), 'utf8');
const I18N_SRC = readFileSync(join(ROOT, 'public', 'js', 'i18n.js'), 'utf8');

/**
 * Load i18n.js with the minimum browser shims it touches at module scope.
 * (Pattern borrowed from canvas-chrome.test.ts.)
 */
function loadI18n(): any {
  const sandbox: any = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => undefined },
    document: {
      documentElement: { setAttribute: () => undefined, lang: '', dir: '' },
      addEventListener: () => undefined,
      dispatchEvent: () => undefined,
      querySelectorAll: () => [],
    },
    CustomEvent: function () { /* stub */ },
  };
  vm.createContext(sandbox);
  vm.runInContext(I18N_SRC, sandbox);
  return sandbox.window.I18N;
}

/** Slice out one function body by name, so an assertion cannot pass on a
 *  match that lives somewhere else entirely in a 2700-line file. */
function bodyOf(src: string, signature: string, end = '\n    }'): string {
  const at = src.indexOf(signature);
  expect(at, `could not find ${signature}`).toBeGreaterThan(-1);
  const after = src.slice(at);
  return after.slice(0, after.indexOf(end) + end.length);
}

// ═════════════════════════════════════════════════════════════════════════════
// BUG 1 — a mouseup redraw ate the click
// ═════════════════════════════════════════════════════════════════════════════
describe('bug 1: pressing a control inside a tab chip must reach its click handler', () => {
  /**
   * The fix is one word (`if (moved)`) and it is entirely invisible in review,
   * so it needs a test that says why it is there. Live proof:
   * probe-ui-controls.js, "the extra tab is closed again".
   */
  it('redraws on mouseup ONLY when a drag actually started', () => {
    const onUp = bodyOf(BV, 'function onUp(u) {', '\n      }');
    const calls = onUp.match(/renderTabs\(/g) || [];
    expect(calls.length).toBe(1);
    // Unconditional is the bug. The guard is the fix.
    expect(onUp).toMatch(/if \(moved\) renderTabs\(pickState\.tabs, pickState\.activeTab\)/);
  });

  it('returns early after a reorder so it cannot also fall through to a redraw', () => {
    const onUp = bodyOf(BV, 'function onUp(u) {', '\n      }');
    const reorder = onUp.indexOf("send({ t: 'tabMove'");
    expect(reorder).toBeGreaterThan(-1);
    // The server answers a tabMove with a fresh `tabs` frame; redrawing here as
    // well would be a second, racing repaint.
    expect(onUp.slice(reorder)).toMatch(/^[\s\S]{0,80}return;/);
  });

  it('keeps the drag threshold, so a click is never read as a 1px drag', () => {
    const onMove = bodyOf(BV, 'function onMove(m) {', '\n      }');
    expect(onMove).toMatch(/Math\.abs\(m\.clientX - startX\) < 4/);
  });

  it('records the measurement that justifies the guard', () => {
    // A fix whose reason is not written down is a fix someone "simplifies" back
    // into a bug six months later.
    const onUp = bodyOf(BV, 'function onUp(u) {', '\n      }');
    expect(onUp).toMatch(/mouseup` fires BEFORE `click`/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 2 — navState was not re-emitted when the streamed tab changed
// ═════════════════════════════════════════════════════════════════════════════
describe('bug 2: the arrows must describe the tab actually on screen', () => {
  /**
   * This is the user's report in full: history is per tab, and the client only
   * ever learns canGoBack/canGoForward from a `navState` frame. Switching tabs
   * emitted `tabs` + `navigated` and nothing else, so Back stayed lit on a
   * brand-new tab and pressing it did nothing at all.
   */
  it('focus() re-emits navState after switching the streamed page', () => {
    const focus = bodyOf(LB, 'private async focus(tab: LiveTab)', '\n  }');
    expect(focus).toMatch(/await this\.emitNavState\(\)/);
  });

  it('openTab() emits navState too — but only when it actually activates', () => {
    const open = bodyOf(LB, 'private async openTab(', '\n  }');
    expect(open).toMatch(/if \(opts\.activate !== false\) await this\.emitNavState\(\)/);
    // A background tab must not repaint the arrows of the tab in view.
    expect(open).not.toMatch(/^\s+await this\.emitNavState\(\);$/m);
  });

  it('still derives history from the CDP navigation entries, not a guess', () => {
    // There is no CDP `canGoBack`; it comes from where we sit in the entry list.
    // Note the indirection: emitNavState only wraps navState(), which is where
    // the derivation lives — asserting on the wrapper passes vacuously.
    const emit = bodyOf(LB, 'private async emitNavState()', '\n  }');
    expect(emit).toMatch(/this\.navState\(\)/);
    expect(emit).toMatch(/this\.emit\('navState'/);

    const derive = bodyOf(LB, 'private async navState()', '\n  }');
    expect(derive).toMatch(/Page\.getNavigationHistory/);
    expect(derive).toMatch(/canGoBack = hist\.currentIndex > 0/);
    expect(derive).toMatch(/canGoForward = hist\.currentIndex < hist\.entries\.length - 1/);
    // A dead target must report "nowhere to go" rather than throwing, so the
    // arrows fail closed instead of leaving the last tab's state on screen.
    expect(derive).toMatch(/let canGoBack = false/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 3 — the optimistic busy state had no way to expire
// ═════════════════════════════════════════════════════════════════════════════
describe('bug 3: the nav spinner must be a lease, never a promise', () => {
  /**
   * `navBusy` is set optimistically on press so the click is acknowledged on the
   * next frame instead of a round trip later. It was only ever cleared by
   * navStart/navEnd/navBlocked, so a dropped nav command left the toolbar
   * spinning forever — a direct breach of the no-restart mandate, which says
   * the UI must correct itself rather than sit there lying.
   *
   * Live proof: probe-ui-controls.js, "a DROPPED navigation still un-sticks the
   * spinner by itself" — verified honestly, by swallowing the command on the
   * wire and then asserting that it really did swallow it.
   */
  it('every navBusy write goes through setNavBusy', () => {
    // Direct assignments are the regression: one of them ANYWHERE ELSE and the
    // lease can be bypassed, which is exactly the bug — a busy flag set by a
    // path that never arms a timer is a spinner with no way to stop.
    //
    // So the check is positional, not a count. setNavBusy legitimately writes
    // twice (`= !!on` on entry, `= false` when the lease expires); what must
    // never exist is a third write outside it. Counting was tried first and was
    // wrong: it failed on correct code, and an assertion that fires on correct
    // code gets deleted rather than believed.
    const fn = bodyOf(BV, 'function setNavBusy(on, phase) {');
    const all = (BV.match(/pickState\.navBusy = /g) || []).length;
    const inside = (fn.match(/pickState\.navBusy = /g) || []).length;
    expect(inside).toBeGreaterThan(0);
    expect(all).toBe(inside);                    // nothing writes it elsewhere

    // ...and the initial value still lives in the pickState literal, so the flag
    // is defined before the first paint rather than arriving as undefined.
    expect(BV).toMatch(/^\s+navBusy: false,$/m);
  });

  it('arms a timer whenever it goes busy, and clears it whenever it does not', () => {
    const fn = bodyOf(BV, 'function setNavBusy(on, phase) {');
    expect(fn).toMatch(/clearTimeout\(pickState\.navBusyTimer\)/);
    expect(fn).toMatch(/pickState\.navBusyTimer = setTimeout\(/);
    // The expiry must actually clear the flag and repaint, not merely log.
    expect(fn).toMatch(/pickState\.navBusy = false/);
    expect(fn).toMatch(/applyNavState\(\)/);
  });

  it('tells the user rather than silently giving up', () => {
    // A spinner that quietly stops teaches the user the button does nothing.
    const fn = bodyOf(BV, 'function setNavBusy(on, phase) {');
    expect(fn).toMatch(/toast\(t\('bvp\.navLost'\)/);
  });

  it('has two phases: a short ack wait and a long load wait', () => {
    const fn = bodyOf(BV, 'function setNavBusy(on, phase) {');
    // One timeout cannot serve both: 6s is "was that even heard?" on an open
    // socket; 35s outlives the server's own 30s navigation timeout so a
    // genuinely slow page keeps its spinner.
    expect(fn).toMatch(/phase === 'server' \? 35000 : 6000/);
    // The press arms the short phase; navStart hands the lease to the long one.
    expect(BV).toMatch(/setNavBusy\(true, 'press'\)/);
    expect(BV).toMatch(/setNavBusy\(true, 'server'\)/);
  });

  it('the long phase really is longer than the server timeout it covers', () => {
    // If someone lowers the navigation timeout or raises the lease, these two
    // numbers must be re-reconciled rather than left to drift into a spinner
    // that expires while the page is still legitimately loading.
    expect(LB).toMatch(/timeout: 30000/);
    expect(BV).toMatch(/35000/);
  });

  it('clears the flag on every terminal frame the server can send', () => {
    // navEnd is the happy path; navBlocked is the one that used to be forgotten.
    expect(BV).toMatch(/case 'navEnd':[\s\S]{0,120}setNavBusy\(false\)/);
    expect(BV).toMatch(/case 'navBlocked':[\s\S]{0,120}setNavBusy\(false\)/);
  });

  it('does not outlive the modal that owns it', () => {
    // Otherwise the toast fires about a window that is no longer on screen.
    const close = bodyOf(BV, 'function closePick(', '\n  }');
    expect(close).toMatch(/clearTimeout\(ps\.navBusyTimer\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 4 — the CSP refused every favicon
// ═════════════════════════════════════════════════════════════════════════════
describe('bug 4: favicons must arrive as bytes, not as a remote URL', () => {
  /**
   * `img-src 'self' data:` means a remote icon URL can never render. The two
   * "easy" fixes are both worse than the bug: widening the CSP buys an
   * exfiltration surface, and proxying arbitrary URLs through the server is an
   * SSRF hole. So the page fetches the bytes itself, with its own cookies, and
   * hands back a capped data: URL.
   */
  it('leaves the CSP strict — the fix belongs on the other side of the wire', () => {
    expect(INDEX).toMatch(/imgSrc: \["'self'", "data:"\]/);
    expect(INDEX).not.toMatch(/imgSrc:[^\]]*\*/);
    expect(INDEX).not.toMatch(/imgSrc:[^\]]*https:/);
  });

  it('reads the icon inside the page, with the page own credentials', () => {
    // A cookie-gated favicon 404s for an anonymous fetcher.
    const fn = bodyOf(LB, 'private async refreshFavicon(', '\n  }');
    expect(fn).toMatch(/fetch\(href, \{ credentials: 'include' \}\)/);
  });

  it('accepts only images, and only as data: URLs', () => {
    const fn = bodyOf(LB, 'private async refreshFavicon(', '\n  }');
    // The commonest "favicon" on the web is a 200 response containing an HTML
    // 404 page; without this it would be base64'd and handed to an <img>.
    expect(fn).toMatch(/\/\^image\\\//);
    // The acceptance gate: anything that is not a data: image never reaches a tab.
    expect(fn).toMatch(/if \(!\/\^data:image\\\/\/i\.test\(url\)\) return;/);
  });

  it('caps the size, so one hostile page cannot flood the socket', () => {
    const fn = bodyOf(LB, 'private async refreshFavicon(', '\n  }');
    expect(fn).toMatch(/buf\.byteLength > 24576/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The probe itself — the instrument has to stay honest to be worth anything
// ═════════════════════════════════════════════════════════════════════════════
describe('the probe must assert outcomes, not the presence of elements', () => {
  it('clicks all four controls the user reported', () => {
    for (const id of ['#bvp-back', '#bvp-fwd', '#bvp-reload', '#bvp-tabadd']) {
      expect(PROBE).toContain(`page.click('${id}')`);
    }
  });

  it('asks the PAGE where it is, not the address bar', () => {
    // The address bar is client state: it can say /p1 while the page never
    // moved. The fixture pages report their own identity over HTTP instead.
    expect(PROBE).toMatch(/\/p1/);
    expect(PROBE).toMatch(/nonce/);
    expect(PROBE).toMatch(/the PAGE says/);
  });

  it('cross-checks the client against the server frames', () => {
    // Two independent witnesses: the fixture's beacon and the server's own
    // navState/navigated frames, tapped passively off the page's WebSocket.
    expect(PROBE).toMatch(/lastEv\('navState'\)/);
    expect(PROBE).toMatch(/lastEv\('navigated'\)/);
    expect(PROBE).toMatch(/not a guess|not a client-side fake/);
  });

  it('checks the controls are actually reachable by a real pointer', () => {
    // A button can be present, enabled and still un-clickable because something
    // transparent sits on top of it. No other test layer can see that.
    expect(PROBE).toContain('elementFromPoint');
    expect(PROBE).toContain('pointerEvents');
  });

  it('verifies its own dropped-command trick actually dropped something', () => {
    // A test that silently fails to reproduce its own precondition passes for
    // the wrong reason. This is the assertion that keeps it honest.
    expect(PROBE).toMatch(/window\.__bvDropped/);
    expect(PROBE).toMatch(/this test is honest/);
  });

  it('never keeps screencast frames in its event tap', () => {
    // Frames are ~50KB of base64 at ~15/sec: keeping them would OOM the tap and
    // prove nothing. The tap must filter them out AND bound what it does keep.
    expect(PROBE).toMatch(/\.t !== 'frame'/);
    expect(PROBE).toMatch(/__bvEvents\.length > \d+/);
    expect(PROBE).toMatch(/__bvEvents\.splice\(/);
  });

  it('waits for outcomes instead of sleeping a fixed amount', () => {
    // The two witnesses travel different routes and either can land first; a
    // fixed sleep turns that into a flake, and a probe that cries wolf teaches
    // the reader to distrust real failures too.
    expect(PROBE).toMatch(/async function until\(|const until = /);
  });

  it('leaves the session as it found it', () => {
    // A probe that leaves tabs behind poisons the next probe's measurements —
    // the lesson already recorded as `soloTab` in probe-live-parity.js.
    expect(PROBE).toMatch(/the extra tab is closed again/);
  });

  it('exits with the failure count so CI can gate on it', () => {
    expect(PROBE).toMatch(/process\.exit\(fails\.length\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// i18n parity (project rule R5)
// ═════════════════════════════════════════════════════════════════════════════
describe('the new string exists in both languages', () => {
  it('bvp.navLost is translated, not copied or stubbed', () => {
    const I18N = loadI18n();
    I18N.setLang('fa');
    const fa = I18N.t('bvp.navLost');
    I18N.setLang('en');
    const en = I18N.t('bvp.navLost');

    // A missing key returns the key itself, which is the failure this catches.
    expect(fa).not.toBe('bvp.navLost');
    expect(en).not.toBe('bvp.navLost');
    expect(fa).not.toBe(en);
    expect(fa.length).toBeGreaterThan(8);
    expect(en.length).toBeGreaterThan(8);
    // It has to tell the user what to do next, not just that something failed.
    expect(en).toMatch(/again/i);
  });
});
