/**
 * heal-panel-stuck.test.ts — «کاربر نباید گیر کنه».
 *
 * The report (six-regressions bug report, item 1):
 *
 *   The user opened the simulated browser, pressed what looked like an off
 *   button, and got a panel reading "Getting the browser ready / Starting Chrome
 *   / about 6 seconds" — which then stuck. They closed the window and reopened
 *   it, and it looked dead the same way. In their words:
 *
 *   «باید حداقل نیاز به زمان داره اطلاع بده یا خلاصه اگر نیازه ترمیم بشه ترمیم
 *   بشه خلاصه کاربر نباید گیر کنه»
 *   — at minimum say how long it needs; if it needs healing, heal; the bottom
 *   line is the user must never get stuck.
 *
 * What was MEASURED live by tools/probe-heal-panel.js before the fix, by holding
 * the restart POST open so it never settled:
 *
 *   ✗ the panel offered no way out            (hasClose=false)
 *   ✗ the panel was STILL SHOWING after 45s
 *   ✗ NO TOAST AT ALL — the user was never told anything
 *   ✗ `#bvp-restart` was left `disabled` FOREVER
 *
 * That last one is the real trap, and it was not in the original report: the user
 * had not merely lost a panel, they had lost the only control that could have
 * recovered from it. And the "about 6 seconds" was invented on the client while
 * the server publishes real measured budgets — a restart here actually takes
 * 462-1315ms, so the number was wrong even on success.
 *
 * Four causes, and the fix addresses each:
 *
 *   1. `showHeal` had no lease — it could only be taken down by an explicit later
 *      event (`.then`, `.catch`, or a `ready` frame), none of which run for a
 *      promise that never settles.
 *   2. `etaMs: 6000` was hard-coded on the client.
 *   3. there was no dismiss control at all.
 *   4. a heal was reported only down the request that started it, so a reopened
 *      window was structurally incapable of learning one was in flight.
 *
 * Why these are STATIC tests
 * ──────────────────────────
 * The live proof is the primary evidence (tools/probe-heal-panel.js, 25/25). What
 * these add is protection against the fix being quietly undone, and every item
 * above is a wiring decision — which guard exists, which timer is cleared, what
 * is on the wire — rather than a computation. That is the class that drifts
 * silently, so this file follows the style of restart-tab-loss.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const VIEW = read('public', 'js', 'browser-view.js');
const I18N = read('public', 'js', 'i18n.js');
const SELF_HEAL = read('src', 'core', 'SelfHeal.ts');
const ROUTES = read('src', 'Routes', 'browser.routes.ts');

/** Strip comments so an assertion can never be satisfied by prose ABOUT the rule. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const VIEW_CODE = code(VIEW);

/**
 * The body of a named function OR class method, brace-matched.
 *
 * Both forms are needed: the client's are plain `function foo()`, while
 * SelfHeal's are `static foo()` / `private static async foo<T>()`. A helper that
 * silently returned '' for the second form would make an assertion about the
 * server pass or fail for the wrong reason — which it did, on first run.
 */
function fnBody(src: string, name: string): string {
  let sig = src.indexOf(`function ${name}(`);
  if (sig < 0) {
    // A class method. Anchored to the line start and allowing only modifiers
    // before the name, so a CALL to `name(...)` is never mistaken for its
    // definition.
    const m = new RegExp(
      `^[ \\t]*(?:(?:public|private|protected|static|async)[ \\t]+)*${name}\\s*(?:<[^>]*>)?\\s*\\(`,
      'm',
    ).exec(src);
    sig = m ? m.index : -1;
  }
  if (sig < 0) return '';

  // Step past the parameter list by matching ITS parens. Doing this first is what
  // makes a brace-containing return type harmless: `currentHeal(): { step: … } |
  // null` would otherwise be brace-matched as though the type were the body, and
  // the assertion would be made against the signature instead of the code.
  let i = src.indexOf('(', sig);
  for (let paren = 0; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') { paren -= 1; if (paren === 0) { i += 1; break; } }
  }

  // The body opens at the LAST `{` before the first newline that follows the
  // signature — an inline return type is closed on that same line, so whatever
  // brace is still open when the line ends is the body's.
  const eol = src.indexOf('\n', i);
  const head = src.slice(i, eol < 0 ? src.length : eol);
  let open = -1;
  for (let depth = 0, k = 0; k < head.length; k += 1) {
    if (head[k] === '{') { depth += 1; open = i + k; }
    else if (head[k] === '}') { depth -= 1; if (depth === 0) open = -1; }
  }
  if (open < 0) open = src.indexOf('{', i);
  if (open < 0) return '';

  for (let depth = 0, k = open; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') { depth -= 1; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}

describe('§1 the heal panel can never strand the user', () => {
  // ── The lease: the panel must be able to take ITSELF down ─────────────────
  describe('the panel is on a lease, like every other optimistic state here', () => {
    it('has a setHealLease that arms a timer', () => {
      expect(VIEW_CODE).toContain('function setHealLease(');
      const body = fnBody(VIEW_CODE, 'setHealLease');
      expect(body).toContain('setTimeout(');
      expect(body).toContain('pickState.healTimer');
    });

    it('takes the panel DOWN when the lease expires', () => {
      const body = fnBody(VIEW_CODE, 'setHealLease');
      expect(body).toContain('hideHeal()');
    });

    it('tells the user what happened, rather than vanishing silently', () => {
      // A panel that disappears without a word still leaves them not knowing
      // whether the restart happened. This is the same contract bvp.navLost
      // already keeps for a lost navigation.
      const body = fnBody(VIEW_CODE, 'setHealLease');
      expect(body).toMatch(/toast\(\s*t\('bvp\.healLost'\)/);
    });

    it('RE-ENABLES the restart button on expiry — the trap the probe found', () => {
      // The handler disables its own button and re-enables it in a trailing
      // `.then`, which never runs for a promise that never settles. Telling the
      // user to "press it again" is only honest if pressing is possible.
      const body = fnBody(VIEW_CODE, 'setHealLease');
      expect(body).toMatch(/bvp-restart/);
      expect(body).toMatch(/disabled\s*=\s*false/);
    });

    it('uses two phases, because one timeout cannot serve both', () => {
      const body = fnBody(VIEW_CODE, 'setHealLease');
      expect(body).toMatch(/phase\s*===\s*'server'/);
    });

    it("the 'press' phase is longer than the server's own worst case", () => {
      // Reconciled, not invented: SelfHeal budgets stop 2s + display 3s +
      // start 6s + verify 1.5s ≈ 12.5s, so a lease shorter than that could cut
      // off a restart that was merely slow — replacing a stuck panel with a
      // false alarm, which is not an improvement.
      const body = fnBody(VIEW_CODE, 'setHealLease');
      const nums = [...body.matchAll(/(\d{4,})/g)].map((m) => Number(m[1]));
      expect(nums.length).toBeGreaterThan(0);
      const shortest = Math.min(...nums);
      expect(shortest).toBeGreaterThan(12_500);
    });

    it('arms the lease on the press, not only after the answer', () => {
      // Arming it after the response would leave the exact gap the bug lived in.
      const i = VIEW_CODE.indexOf("setHealLease('press')");
      const j = VIEW_CODE.indexOf("window.API.post('/browser/restart'");
      expect(i).toBeGreaterThan(0);
      expect(j).toBeGreaterThan(0);
      expect(i).toBeLessThan(j);
    });
  });

  // ── The lease must not outlive what it describes ──────────────────────────
  describe('the lease is dropped whenever the panel goes', () => {
    it('hideHeal clears it', () => {
      // Otherwise a successful restart still gets a "no answer came back" toast.
      const body = fnBody(VIEW_CODE, 'hideHeal');
      expect(body).toContain('healTimer');
      expect(body).toMatch(/clearTimeout/);
    });

    it('closePick clears it, and the per-step countdowns too', () => {
      // The standing rule recorded for navBusyTimer: a lease that outlives its
      // modal fires a toast about a window that is no longer on screen.
      const body = fnBody(VIEW_CODE, 'closePick');
      expect(body).toContain('healTimer');
      expect(body).toContain('healEtaTimers');
    });

    it('pickState declares both fields, so neither is an accident', () => {
      expect(VIEW_CODE).toMatch(/healTimer:\s*0/);
      expect(VIEW_CODE).toMatch(/healEtaTimers:\s*\[\]/);
    });
  });

  // ── The ETA must not lie ─────────────────────────────────────────────────
  describe('the ETA is honest or absent', () => {
    it('the invented 6-second ETA is gone', () => {
      expect(VIEW).not.toContain('etaMs: 6000');
    });

    it('the optimistic first step carries NO etaMs at all', () => {
      // An indeterminate spinner promises nothing and so cannot be wrong; the
      // server's real numbers replace it the moment it answers.
      const m = VIEW_CODE.match(/showHeal\(\[\{\s*key:\s*'startingChrome',\s*state:\s*'running'[^\]]*\]\)/);
      expect(m).toBeTruthy();
      expect(m![0]).not.toContain('etaMs');
    });

    it('stops quoting a number once the estimate has elapsed', () => {
      // At t=20s a line reading "about 6 seconds" is not optimistic, it is false,
      // and a progress indicator caught lying once is not believed again.
      const body = fnBody(VIEW_CODE, 'showHeal');
      expect(body).toContain("t('bvp.healSlow')");
    });

    it('per-step countdowns are tracked so a re-render cannot leak them', () => {
      expect(VIEW_CODE).toContain('function clearHealEtaTimers(');
      const body = fnBody(VIEW_CODE, 'showHeal');
      expect(body).toContain('clearHealEtaTimers()');
    });

    it('still renders the server ETA when there is one', () => {
      // The fix removes the client's GUESS, not the feature.
      const body = fnBody(VIEW_CODE, 'showHeal');
      expect(body).toContain("tf('bvp.healEta'");
    });
  });

  // ── There must be a way out by hand ──────────────────────────────────────
  describe('the panel is dismissible', () => {
    it('renders a close control', () => {
      expect(VIEW_CODE).toContain('bvp-heal-close');
    });

    it('the close control hides the panel', () => {
      const i = VIEW_CODE.indexOf("q('bvp-heal-close').addEventListener");
      expect(i).toBeGreaterThan(0);
      expect(VIEW_CODE.slice(i, i + 300)).toContain('hideHeal()');
    });

    it('dismissing does NOT close the picker or the socket', () => {
      // Turning a convenience into data loss would be worse than the bug.
      const i = VIEW_CODE.indexOf("q('bvp-heal-close').addEventListener");
      const handler = VIEW_CODE.slice(i, i + 300);
      expect(handler).not.toContain('closePick');
      expect(handler).not.toMatch(/ws\.close|\.detach\(/);
    });
  });

  // ── The button must not look like an off switch ───────────────────────────
  describe('the control the user pressed says what it does', () => {
    it('is not drawn with the power glyph', () => {
      // icons.js aliases BOTH `close` and `close-browser` to `power`, so in this
      // product that symbol already means "shut it down". The user reporting "I
      // pressed off" was reading the icon correctly; the icon was wrong.
      const i = VIEW_CODE.indexOf("id=\"bvp-restart\"");
      expect(i).toBeGreaterThan(0);
      expect(VIEW_CODE.slice(i, i + 400)).not.toContain("BIC('power'");
    });

    it('still names itself a restart in title AND aria-label', () => {
      const i = VIEW_CODE.indexOf("id=\"bvp-restart\"");
      const markup = VIEW_CODE.slice(i - 200, i + 400);
      expect(markup).toContain("t('bvp.restartBrowser')");
      expect(markup).toContain('aria-label');
    });

    it('does not reuse the Reload glyph one button away', () => {
      // Two identical glyphs a button apart read as a duplicate, and these do
      // very different things (reload the PAGE vs relaunch the BROWSER).
      const i = VIEW_CODE.indexOf("id=\"bvp-restart\"");
      expect(VIEW_CODE.slice(i, i + 400)).not.toContain("BIC('rotate-cw'");
    });
  });

  // ── A reopened window must learn the truth ────────────────────────────────
  describe('a reopened window resumes instead of guessing', () => {
    it('the server tracks the live heal', () => {
      expect(SELF_HEAL).toContain('static currentHeal(');
      expect(SELF_HEAL).toContain('static isHealing(');
    });

    it('a finished heal reports NOTHING, not its last step', () => {
      // A window resuming into "loading extensions ✓" from a heal that ended ten
      // minutes ago would be shown a panel about nothing.
      const body = fnBody(code(SELF_HEAL), 'currentHeal');
      expect(body).toMatch(/return null/);
    });

    it('the in-flight flag is released even when a heal throws', () => {
      // Otherwise the server claims forever that it is healing, and every client
      // that connects is shown a panel for dead work — the same never-ending
      // progress bug, moved to the server.
      const span = fnBody(code(SELF_HEAL), 'span');
      expect(span).toContain('finally');
      expect(span).toMatch(/depth\s*-=\s*1/);
    });

    it('BOTH public heal entry points are tracked', () => {
      // A step that has to opt in is a step that will be added later without
      // opting in, and then the resume path silently has a hole.
      const c = code(SELF_HEAL);
      const ensure = c.slice(c.indexOf('static ensureBrowser('), c.indexOf('static ensureBrowser(') + 200);
      const reload = c.slice(c.indexOf('static reloadExtensions('), c.indexOf('static reloadExtensions(') + 400);
      expect(ensure).toContain('this.track(');
      expect(reload).toContain('this.track(');
      expect(ensure).toContain('this.span(');
      expect(reload).toContain('this.span(');
    });

    it('/browser/status publishes it', () => {
      expect(code(ROUTES)).toMatch(/SelfHeal\.currentHeal\(\)/);
      expect(code(ROUTES)).toMatch(/res\.json\(\{[^}]*heal/s);
    });

    it('the client asks on open', () => {
      expect(VIEW_CODE).toContain('function resumeHeal(');
      expect(VIEW_CODE).toMatch(/resumeHeal\(\);/);
      const body = fnBody(VIEW_CODE, 'resumeHeal');
      expect(body).toContain("'/browser/status'");
    });

    it('the client shows NOTHING when no heal is running', () => {
      // A reopened window that puts up a spinner "just in case" is the same lie
      // in a new place.
      const body = fnBody(VIEW_CODE, 'resumeHeal');
      expect(body).toMatch(/if\s*\(!h[^)]*\)\s*return/);
    });

    it('an adopted heal gets the long lease, not the short one', () => {
      // The server has SAID it is working, so the "was the press even heard?"
      // timeout does not apply.
      const body = fnBody(VIEW_CODE, 'resumeHeal');
      expect(body).toContain("setHealLease('server')");
    });

    it('a stale response cannot paint a window that moved on', () => {
      const body = fnBody(VIEW_CODE, 'resumeHeal');
      expect(body).toMatch(/pickState\s*!==\s*mine/);
    });
  });

  // ── i18n parity: every new key in BOTH dictionaries ───────────────────────
  describe('every new string exists in fa and en', () => {
    const keys = [
      'bvp.healLost', 'bvp.healSlow', 'bvp.healDismiss',
      'bvp.healDismissed', 'bvp.healResumed',
    ];
    for (const k of keys) {
      it(`${k} is defined twice`, () => {
        const hits = I18N.split(`'${k}':`).length - 1;
        expect(hits).toBe(2);
      });
    }

    it('no key was left with a doubled unicode escape', () => {
      // A `\\u2014` in a single-quoted JS string renders the literal characters
      // \u2014 on screen instead of an em dash.
      for (const k of keys) {
        const re = new RegExp(`'${k.replace('.', '\\.')}':\\s*'([^']*)'`, 'g');
        for (const m of I18N.matchAll(re)) expect(m[1]).not.toContain('\\\\u');
      }
    });
  });

  // ── The instrument is checked in ──────────────────────────────────────────
  it('the live probe for this bug is committed', () => {
    const probe = read('tools', 'probe-heal-panel.js');
    expect(probe).toContain('/browser/restart');
    // It must reproduce the bug by STRANDING the request, not by aborting it:
    // an abort takes the `.catch` path, which always worked and proves nothing.
    expect(probe).toContain('held.push(route)');
  });
});
