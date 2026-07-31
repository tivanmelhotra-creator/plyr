/**
 * element-picker.test.ts — the Element Picker contract (HANDOFF 15, Phase B).
 *
 * The crosshair on a selector field only works if FOUR layers agree, and each
 * layer used to be able to drift silently (the crosshair shipped for a while
 * calling `BrowserView.requestPick`, which did not exist — the button just
 * toasted). These tests pin the seams, not the pixels:
 *
 *   1. ndv-nodes.js calls BrowserView.requestPick, and browser-view.js exports it
 *   2. every command the client sends is handled by BrowserStreamServer
 *   3. every channel event the client switches on is emitted by LiveBrowser
 *   4. the injected page script really provides hover / traversal / attrs /
 *      match-count — the four things the panel renders
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ndvNodes = read('public/js/ndv-nodes.js');
const browserView = read('public/js/browser-view.js');
const streamServer = read('src/core/BrowserStreamServer.ts');
const liveBrowser = read('src/core/LiveBrowser.ts');
const i18n = read('public/js/i18n.js');

describe('picker wiring: NDV crosshair → BrowserView', () => {
  it('the crosshair button calls BrowserView.requestPick', () => {
    expect(ndvNodes).toContain('BrowserView.requestPick');
  });

  it('browser-view.js actually exports requestPick', () => {
    expect(browserView).toMatch(/window\.BrowserView\s*=\s*\{[^}]*requestPick/s);
  });

  it('the crosshair passes the field value + dialect + page URL', () => {
    // getOpts is read at click time; the three seeds are what make the picker
    // "refine an existing selector" instead of starting from nothing.
    expect(ndvNodes).toMatch(/function pickerBtn\(onPicked, getOpts\)/);
    expect(ndvNodes).toContain('ctx.pageUrl');
    expect(ndvNodes).toContain('o.pageUrl');
  });

  it('flow-editor supplies pageUrl from a literal goto URL only', () => {
    const fe = read('public/js/flow-editor.js');
    expect(fe).toContain('pageUrl: firstLiteralUrl()');
    // Expressions cannot be resolved before a run, so they must be skipped.
    expect(fe).toMatch(/indexOf\('\{\{'\)\s*<\s*0/);
  });
});

describe('picker wiring: client commands ↔ server handlers', () => {
  const clientCommands = Array.from(
    browserView.matchAll(/send\(\{\s*t:\s*'([a-zA-Z]+)'/g)
  ).map((m) => m[1]);

  it('sends at least the picker command set', () => {
    for (const cmd of ['navigate', 'move', 'click', 'scroll', 'picker', 'pickStep', 'verify']) {
      expect(clientCommands, `client must send ${cmd}`).toContain(cmd);
    }
  });

  it('every command the client sends has a server case', () => {
    const unhandled = Array.from(new Set(clientCommands))
      .filter((c) => !streamServer.includes(`case '${c}':`));
    expect(unhandled, 'commands with no handler in BrowserStreamServer').toEqual([]);
  });

  it('the server delegates to real LiveBrowser methods', () => {
    expect(streamServer).toContain('session.move(');
    expect(streamServer).toContain('session.pickStep(');
    expect(streamServer).toContain('session.verifySelector(');
    expect(liveBrowser).toMatch(/async move\(/);
    expect(liveBrowser).toMatch(/async pickStep\(/);
    expect(liveBrowser).toMatch(/async verifySelector\(/);
  });
});

describe('picker wiring: server events ↔ client channels', () => {
  it('hover / pick / verified are all emitted and all consumed', () => {
    // One page binding, three channels routed by `k`.
    expect(liveBrowser).toMatch(/payload && payload\.k === 'hover' \? 'hover'/);
    expect(liveBrowser).toContain("'verified'");
    for (const ev of ['hover', 'pick', 'verified']) {
      expect(browserView, `client must handle ${ev}`).toContain(`case '${ev}':`);
    }
  });
});

describe('picker page script capabilities', () => {
  it('reports hover as well as click', () => {
    expect(liveBrowser).toContain("report(el, 'hover')");
    expect(liveBrowser).toContain("report(el, 'pick')");
  });

  it('exposes DOM traversal and selector verification to the panel', () => {
    expect(liveBrowser).toContain('window.__abPickStep');
    expect(liveBrowser).toContain('window.__abVerify');
  });

  it('caps what it streams (it fires on every mouse move)', () => {
    expect(liveBrowser).toMatch(/out\.length < 12/);        // attribute count
    expect(liveBrowser).toMatch(/slice\(0, 160\)/);         // attribute value
    expect(liveBrowser).toMatch(/now - lastAt < 80/);       // hover throttle
  });

  it('carries attrs + count + traversal flags in the payload', () => {
    for (const field of ['attrs:', 'count:', 'hasParent:', 'hasChild:']) {
      expect(liveBrowser, `payload must carry ${field}`).toContain(field);
    }
  });

  it('tears every hook down again when the picker is switched off', () => {
    expect(liveBrowser).toContain('window.__abPickStep = null');
    expect(liveBrowser).toContain('window.__abVerify = null');
  });
});

describe('picker i18n + rule 0.9 labelling', () => {
  it('every bvp.* key referenced by the modal exists in BOTH dictionaries', () => {
    const used = Array.from(new Set(
      Array.from(browserView.matchAll(/t\('(bvp\.[a-zA-Z]+)'\)/g)).map((m) => m[1])
    ));
    expect(used.length).toBeGreaterThan(10);
    const fa = i18n.slice(i18n.indexOf('\n    fa: {'), i18n.indexOf('\n    en: {'));
    const en = i18n.slice(i18n.indexOf('\n    en: {'));
    for (const key of used) {
      expect(fa, `fa is missing ${key}`).toContain(`'${key}':`);
      expect(en, `en is missing ${key}`).toContain(`'${key}':`);
    }
  });

  it('the Condition selector label admits XPath, which the engine accepts', () => {
    // ConditionEngine hands the raw string to page.locator(); Playwright sniffs
    // a leading `//` as XPath. Labelling the field "CSS Selector" understated
    // the backend (rule 0.9 works in both directions).
    expect(i18n).toContain("'cb.cssSelector': 'CSS selector or XPath'");
    const engine = read('src/core/ConditionEngine.ts');
    expect(engine).toMatch(/this\.page\.locator\(selector\)/);
  });

  it('adds no selectorType param on the condition path', () => {
    // Nothing in the backend reads params.selectorType for if/while, so the
    // Condition NDV must not grow that dropdown.
    const fe = read('public/js/flow-editor.js');
    const ifList = fe.slice(fe.indexOf("action === 'if' || action === 'while'"));
    expect(ifList.slice(0, 400)).not.toContain('selectorType');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Automa panel parity (turn 2 A) + the persistent server browser (turn 2 B).
//
// The panel grew from a flat key/value list into the shape Automa uses: cards
// with per-attribute copy, an "#N Element" header, and two tabs. None of that is
// worth anything if the data it renders never arrives, so these tests pin the
// data path as well as the markup — the panel and the page script have to agree
// on `candidates`, `index`, `tag` and `text`, and the session chip has to agree
// with what LiveBrowser actually reports.
// ══════════════════════════════════════════════════════════════════════════
describe('picker panel: Automa parity', () => {
  it('renders attribute CARDS with a per-attribute copy button', () => {
    // The old row could only copy the whole selector; an aria-label had to be
    // re-typed by eye.
    expect(browserView).toContain('bvp-attr-box');
    expect(browserView).toContain('bvp-attr-copy');
    expect(browserView).toMatch(/copyText\(a\.value\)/);
    // The copy must not also trigger "use as selector" on the box beneath it.
    expect(browserView).toMatch(/ev\.stopPropagation\(\)/);
  });

  it('clicking an attribute offers tag[name="value"] and re-counts it', () => {
    expect(browserView).toMatch(/\[' \+ a\.name \+ '=' \+ JSON\.stringify\(a\.value\)/);
    // Rule 0.10: never show a selector without saying how many it matches, and
    // never guess that number locally.
    const box = browserView.slice(browserView.indexOf('box.addEventListener'));
    expect(box.slice(0, 500)).toContain("send({ t: 'verify'");
  });

  it('has exactly two tabs: Attributes and Candidates (not Blocks)', () => {
    expect(browserView).toContain('bvp-tab-attrs');
    expect(browserView).toContain('bvp-tab-cands');
    // HANDOFF 15 § 2.3: building steps from inside the picker stays refused.
    expect(browserView).not.toMatch(/bvp-tab-blocks/);
    expect(browserView).toContain("t('bvp.tabCandidates')");
  });

  it('shows the element index, tag and text', () => {
    expect(browserView).toContain('bvp.elementIndex');
    expect(browserView).toContain('bvp.elementIndexOf');
    expect(browserView).toContain('bvp-el-tag');
    expect(browserView).toContain('bvp-el-text');
    // …and the page script must actually send all three.
    expect(liveBrowser).toMatch(/index:\s*indexOf\(el, css\)/);
    expect(liveBrowser).toMatch(/tag:\s*el\.nodeName\.toLowerCase\(\)/);
  });

  it('candidates come from the page, are pick-only, and carry counts', () => {
    expect(liveBrowser).toContain('function candidatesFor(el)');
    // Hover fires ~14x/sec; computing N querySelectorAll per hover is not free.
    expect(liveBrowser).toMatch(/candidates:\s*kind === 'pick' \? candidatesFor\(el\) : \[\]/);
    // Every candidate row shows its own match count (rule 0.10).
    expect(browserView).toContain('bvp-cand-n');
    expect(browserView).toMatch(/c\.count === 1 \? 'is-ok' : 'is-warn'/);
    // A hover must not blank the list the user is reading.
    expect(browserView).toMatch(/if \(locked\) renderCands/);
  });

  it('offers a clipped candidate in full via its tooltip', () => {
    // Measured: `div[aria-label="Compose a new message"]` overflows the 306px
    // panel by 22px. A selector you cannot read is one you cannot choose.
    expect(browserView).toMatch(/b\.title = c\.sel/);
  });

  it('the stage answers ArrowUp / ArrowDown / Space', () => {
    // lastIndexOf, not indexOf: render()'s own stage also binds keydown (to
    // onStageKey) and comes first in the file.
    const stageKeys = browserView.slice(
      browserView.lastIndexOf("stage.addEventListener('keydown'")
    ).slice(0, 700);
    expect(stageKeys).toContain("dir: 'up'");
    expect(stageKeys).toContain("dir: 'down'");
    expect(stageKeys).toContain("key: 'Space'");
    // …and the footer NAMES them, or they do not exist to the user.
    expect(browserView).toContain('bvp.kbdWalk');
    expect(browserView).toContain('<kbd>Space</kbd>');
  });

  it('has a visible drag grip, and it is centred PHYSICALLY', () => {
    expect(browserView).toContain('bvp-grip');
    expect(browserView).toContain("id=\"bvp-drag\"");
    // `transform: translateX()` is not direction-aware: pairing it with
    // `inset-inline-start` put the grip 30px off centre under fa/RTL.
    const css = read('public/css/styles.css');
    const grip = css.slice(css.indexOf('.bvp-grip {'), css.indexOf('.bvp-grip:hover'));
    expect(grip).toContain('left: 50%');
    expect(grip).not.toContain('inset-inline-start: 50%');
  });

  it('lets the attribute list use the panel height instead of a 190px cap', () => {
    // Measured: the cap scrolled the list while leaving 231px of panel empty.
    const css = read('public/css/styles.css');
    const panes = css.slice(css.indexOf('.bvp-attrs,'), css.indexOf('.bvp-attr {'));
    expect(panes).toContain('overflow: auto');
    expect(panes).not.toMatch(/max-height:\s*190px/);
  });
});

describe('picker session: the persistent server browser', () => {
  const profile = read('src/core/BrowserProfile.ts');

  it('the launch flags stop navigator.webdriver at the source', () => {
    const glob = read('src/core/GlobalBrowser.ts');
    expect(profile).toContain('--disable-blink-features=AutomationControlled');
    expect(glob).toContain('ANTI_AUTOMATION_ARGS');
    // JS patching cannot reach HTTP client-hint headers; the flag can.
    expect(glob).toMatch(/stealth\(\)/);
  });

  it('cookies survive the session (the AUTH-GAP fix)', () => {
    expect(profile).toContain('storageState');
    expect(profile).toContain('export async function saveStorageState');
    // A partial write must never replace a good session file.
    expect(profile).toMatch(/rename/);
    // …and the userId can never escape the sessions directory.
    expect(profile).toMatch(/replace\(\/\[\^A-Za-z0-9_-\]\/g, '_'\)/);
    expect(liveBrowser).toContain('GlobalBrowser.getInteractiveContext');
    expect(liveBrowser).toContain('GlobalBrowser.saveAndCloseContext');
  });

  it('the UI is told whether the session was restored, and never guesses', () => {
    expect(liveBrowser).toMatch(/signedIn:\s*this\.hadSavedSession/);
    expect(browserView).toContain('setSession(msg.signedIn)');
    // Opens pessimistic: claiming "signed in" before the server says so would be
    // a lie about auth state (rule 0.3).
    expect(browserView).toMatch(/setSession\(false\);\s*\/\/ pessimistic/);
    // The disclosure paragraph must follow the real state, not be hardcoded.
    expect(browserView).toMatch(/anonEl\.textContent = signedIn \? t\('bvp\.savedNote'\) : t\('bvp\.anonNote'\)/);
  });

  it('a persistent session can be forgotten from the same window', () => {
    expect(browserView).toContain("send({ t: 'forgetSession' })");
    expect(streamServer).toContain("case 'forgetSession'");
    expect(liveBrowser).toContain('async forgetSession()');
    expect(liveBrowser).toContain('clearStorageState');
    expect(liveBrowser).toMatch(/clearCookies/);
  });

  it('cookie walls are dismissed by named CMP, not by guessing at text', () => {
    // A greedy "click anything that says Accept" would happily click an
    // "I agree" on a checkout form, or a "Continue" that navigates away from
    // the page the user is picking from.
    for (const cmp of ['onetrust', 'truste', 'cookiebot', 'usercentrics', 'didomi']) {
      expect(profile.toLowerCase(), `CMP allowlist must know ${cmp}`).toContain(cmp);
    }
    // The fallback needs BOTH an accept word and a consent-named ancestor.
    expect(profile).toMatch(/cookie\|consent\|gdpr\|cmp\|privacy/);
    expect(liveBrowser).toContain('installConsentAutoDismiss');
  });

  it('the picker cannot swallow the consent dismisser own click', () => {
    // CDP-dispatched input is trusted; el.click() is not. Without this guard the
    // capture-phase handler preventDefault()s the dismisser into a no-op.
    expect(liveBrowser).toMatch(/if \(e\.isTrusted === false\) return;/);
  });
});

/**
 * The eye is a MODE SWITCH (user request, 2026-07-31).
 *
 * The window used to send `{ t: 'picker', on: true }` the moment the session was
 * ready and never turn it off, so the injected capture-phase `onClick` swallowed
 * every real click for the whole session: links did not open, forms did not
 * submit, and the "simulated browser" could only hover. The eye button, mean-
 * while, only faded the panel — it looked like "hide", so nothing in the UI
 * offered a way out of picking mode.
 *
 * The contract now: element selection is a mode that starts OFF (a real
 * browser), the eye toggles it, and the panel goes translucent while it is off.
 */
describe('picker: browse mode vs element-selection mode', () => {
  it('does not force the picker on when the session becomes ready', () => {
    // Comments stripped: the removed line is DOCUMENTED at the call site, and
    // that explanation has to stay readable.
    const code = browserView.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain("send({ t: 'picker', on: true })");
    // ...it pushes whatever mode the UI is actually in.
    expect(browserView).toContain('applySelectMode(pickState.selectMode, true)');
  });

  it('starts in browse mode, not in select mode', () => {
    expect(browserView).toMatch(/selectMode:\s*false/);
  });

  it('the eye toggles the mode and drives the page-side picker', () => {
    expect(browserView).toMatch(/function applySelectMode\(on, quiet\)/);
    expect(browserView).toContain("send({ t: 'picker', on: ps.selectMode })");
    expect(browserView).toContain('applySelectMode(!pickState.selectMode)');
    // It is a toggle, so it has to report its state to assistive tech.
    expect(browserView).toMatch(/aria-pressed', ps\.selectMode \? 'true' : 'false'/);
  });

  it('makes the panel translucent while selection is off', () => {
    expect(browserView).toMatch(/classList\.toggle\('is-browse', !ps\.selectMode\)/);
    const css = read('public/css/styles.css');
    expect(css).toMatch(/\.bvp-panel\.is-browse\s*\{\s*opacity:\s*0\.55/);
    // ...and back to full opacity when the pointer or focus is on it, otherwise
    // its own controls would be the thing you cannot read.
    expect(css).toMatch(/\.bvp-panel\.is-browse:hover/);
    // The cursor states the mode before you click.
    expect(css).toMatch(/\.bvp-canvas\.is-picking\s*\{\s*cursor:\s*crosshair/);
  });

  it('sends the keyboard to the page while browsing', () => {
    // Space/↑/↓ belong to the picker ONLY in select mode; in browse mode they
    // are how you scroll and how you fill in a login form.
    expect(browserView).toMatch(/if \(pickState\.selectMode\) \{/);
    expect(browserView).toMatch(/send\(\{ t: 'type', text: ev\.key \}\)/);
    expect(browserView).toMatch(/NAMED_KEYS\[ev\.key\]/);
    // Never steal the real browser's own shortcuts.
    expect(browserView).toMatch(/if \(ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.altKey\) return;/);
  });

  it('ships history controls, wired end to end', () => {
    for (const cmd of ['back', 'forward', 'reload']) {
      expect(browserView, `client must send ${cmd}`).toContain("send({ t: '" + cmd + "' })");
      expect(streamServer, `server must handle ${cmd}`).toContain("case '" + cmd + "'");
      expect(liveBrowser, `LiveBrowser must implement ${cmd}`).toContain('async ' + cmd + '()');
    }
    expect(liveBrowser).toContain('goBack(');
    expect(liveBrowser).toContain('goForward(');
  });

  it('names both modes in both languages', () => {
    for (const key of ['bvp.selectOn', 'bvp.selectOff', 'bvp.inBrowse', 'bvp.inSelect',
      'bvp.kbdBrowse', 'bvp.back', 'bvp.forward', 'bvp.reload']) {
      const hits = i18n.split("'" + key + "'").length - 1;
      expect(hits, `${key} must exist in fa AND en`).toBe(2);
    }
  });
});
