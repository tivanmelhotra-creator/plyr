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
