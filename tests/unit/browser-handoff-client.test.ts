/**
 * browser-handoff-client.test.ts
 *
 * The app half of the Remote ⇄ Local switch decides what the user is told and
 * which screen they get. Those are rules, not rendering, so they are tested
 * directly against the REAL file that ships — `public/js/browser-handoff.js` is
 * required here, not reimplemented. A copy of the logic in a test proves only
 * that the copy agrees with itself.
 *
 * The file is a browser IIFE that assigns `window.BrowserHandoff`, so `window`
 * and `document` are seeded before the require, and the module's dual export
 * (`module.exports = window.BrowserHandoff`) is what comes back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(ROOT, 'public', 'js', 'browser-handoff.js');
const I18N_PATH = join(ROOT, 'public', 'js', 'i18n.js');

/**
 * A DOM stub with exactly the surface the module reads. Deliberately minimal:
 * jsdom would also work, but then a passing test would not prove the module
 * stays inside that tiny surface, and this module is meant to.
 */
function fakeDoc(attrs: Record<string, string> = {}) {
  return {
    documentElement: {
      getAttribute(name: string) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      }
    }
  };
}

type Handoff = any;
let HO: Handoff;
let savedWindow: any;
let savedDocument: any;

beforeAll(() => {
  savedWindow = (globalThis as any).window;
  savedDocument = (globalThis as any).document;

  // `t()` falls back to the key when AppUtil is absent, which is what makes the
  // wording assertions below readable: they assert on keys, so a translation
  // reword cannot break a logic test.
  (globalThis as any).window = {};
  (globalThis as any).document = fakeDoc();

  HO = require(MODULE_PATH);
});

afterAll(() => {
  (globalThis as any).window = savedWindow;
  (globalThis as any).document = savedDocument;
});

describe('browser-handoff — direction', () => {
  it('always offers the other side', () => {
    expect(HO.otherMode('remote')).toBe('local');
    expect(HO.otherMode('local')).toBe('remote');
  });

  it('treats anything that is not exactly "local" as remote, so the button offers Local', () => {
    // The guard is `mode === 'local'`, deliberately not a truthiness test. An
    // unknown/empty mode therefore reads as remote and the offer is "go local",
    // which is the safe default: remote is the mode the server can always serve,
    // so the worst case is offering a switch the user is already effectively in,
    // never hiding the escape hatch from someone stuck on a slow remote.
    expect(HO.otherMode('')).toBe('local');
    expect(HO.otherMode(undefined)).toBe('local');
    expect(HO.otherMode('LOCAL')).toBe('local');
  });
});

describe('browser-handoff — the switch button', () => {
  it('offers Local while remote', () => {
    const s = HO.switchButtonState({ mode: 'remote', modes: ['remote', 'local'] });
    expect(s.visible).toBe(true);
    expect(s.enabled).toBe(true);
    expect(s.target).toBe('local');
    expect(s.label).toBe('ho.toLocal');
    expect(s.title).toBe('ho.toLocalHint');
  });

  it('offers Remote while local — the reverse direction is not an afterthought', () => {
    const s = HO.switchButtonState({ mode: 'local', modes: ['remote', 'local'] });
    expect(s.visible).toBe(true);
    expect(s.target).toBe('remote');
    expect(s.label).toBe('ho.toRemote');
    expect(s.title).toBe('ho.toRemoteHint');
  });

  it('hides itself when the server does not offer the target mode', () => {
    // A button whose only possible outcome is an error is worse than no button.
    const s = HO.switchButtonState({ mode: 'remote', modes: ['remote'] });
    expect(s.visible).toBe(false);
    expect(s.enabled).toBe(false);
    expect(s.target).toBe('local');
  });

  it('stays visible when the server did not say which modes it has', () => {
    // An unknown mode list must not be read as "nothing available", or a server
    // that simply omits the field would lose the feature entirely.
    const s = HO.switchButtonState({ mode: 'remote' });
    expect(s.visible).toBe(true);
    expect(s.target).toBe('local');
  });

  it('survives a missing argument', () => {
    const s = HO.switchButtonState(undefined);
    expect(s.visible).toBe(true);
    expect(s.target).toBe('local');
  });
});

/**
 * Pull a translation template straight out of i18n.js.
 *
 * The interpolation test below has to run against the string that actually
 * ships. Asserting against a template invented in the test would pass even if
 * the real string lost its `{n}`, which is precisely the regression worth
 * catching. `locale` picks which of the two definitions to read: 0 = fa, 1 = en.
 */
function realString(key: string, locale = 1): string {
  const i18n = readFileSync(I18N_PATH, 'utf8');
  const re = new RegExp("'" + key.replace('.', '\\.') + "':\\s*'((?:[^'\\\\]|\\\\.)*)'", 'g');
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(i18n))) found.push(m[1]);
  if (!found.length) throw new Error('no i18n definition for ' + key);
  return found[Math.min(locale, found.length - 1)];
}

describe('browser-handoff — reporting what could not be carried over', () => {
  it('says nothing when nothing was lost', () => {
    expect(HO.describeLimits(null)).toBe('');
    expect(HO.describeLimits({ notes: [] })).toBe('');
    expect(HO.describeLimits({})).toBe('');
  });

  it('reports dropped tabs with the count interpolated into the shipped string', () => {
    // `t()` is resolved per call, so a translator can be installed here and
    // removed again. It serves the REAL template, so this asserts that the
    // string users see has a substitutable `{n}` and that tf() substitutes it.
    const template = realString('ho.limitTabs');
    expect(template).toContain('{n}');
    (globalThis as any).window.AppUtil = { t: (k: string) => (k === 'ho.limitTabs' ? template : k) };
    try {
      const msg = HO.describeLimits({ tabsDropped: 3, notes: ['tabs_capped'] });
      expect(msg).toContain('3');
      // A leaked placeholder is a visible bug, so it is asserted, not assumed.
      expect(msg).not.toContain('{n}');
    } finally {
      delete (globalThis as any).window.AppUtil;
    }
  });

  it('falls back to the bare key rather than crashing when no translator is loaded', () => {
    // browser-handoff.js is loaded before AppUtil in some paths; degrading to the
    // key keeps the picker bar rendering instead of throwing mid-paint.
    expect(HO.describeLimits({ tabsDropped: 3, notes: ['tabs_capped'] })).toBe('ho.limitTabs');
  });

  it('reports lost cookies rather than letting the user think it is all broken', () => {
    // The silent-signout case: a user who is told expects it; a user who is not
    // concludes the whole handoff failed.
    expect(HO.describeLimits({ storageMissing: true, notes: ['storage_unavailable'] }))
      .toBe('ho.limitStorage');
  });

  it('joins several notes into one sentence', () => {
    const msg = HO.describeLimits({ tabsDropped: 2, notes: ['tabs_capped', 'storage_unavailable'] });
    expect(msg).toContain('ho.limitStorage');
    expect(msg.split(' ').length).toBeGreaterThan(1);
  });

  it('ignores note keys it does not know', () => {
    expect(HO.describeLimits({ notes: ['something_new'] })).toBe('');
  });
});

describe('browser-handoff — the countdown on a code that really expires', () => {
  it('counts down in whole seconds and floors at zero', () => {
    // The injected clock is the point of this test. `secondsLeft` must default
    // on "no argument given", not on "argument is falsy" — a zero timestamp is a
    // legitimate value, and the falsy form silently read the wall clock instead.
    expect(HO.secondsLeft(10_000, 0)).toBe(10);
    expect(HO.secondsLeft(10_000, 4_000)).toBe(6);
    expect(HO.secondsLeft(10_000, 9_500)).toBe(1);
    expect(HO.secondsLeft(10_000, 10_000)).toBe(0);
    // Never negative: an expired code shows 0, not "-42".
    expect(HO.secondsLeft(10_000, 99_000)).toBe(0);
  });

  it('rounds up so a code is never shown as expired while it still works', () => {
    // 1ms left must read as "1s", not "0s"; showing 0 on a live code makes the
    // user abandon a pairing that would have succeeded.
    expect(HO.secondsLeft(10_000, 9_999)).toBe(1);
  });

  it('treats junk as already expired instead of throwing mid-render', () => {
    expect(HO.secondsLeft(undefined, 0)).toBe(0);
    expect(HO.secondsLeft(null, 0)).toBe(0);
    expect(HO.secondsLeft('nonsense', 0)).toBe(0);
  });

  it('falls back to the real clock when no clock is passed', () => {
    expect(HO.secondsLeft(Date.now() + 30_000)).toBeGreaterThan(25);
    expect(HO.secondsLeft(Date.now() - 1_000)).toBe(0);
  });

  it('formats mm:ss with a padded seconds field', () => {
    expect(HO.formatCountdown(300)).toBe('5:00');
    expect(HO.formatCountdown(65)).toBe('1:05');
    expect(HO.formatCountdown(9)).toBe('0:09');
    expect(HO.formatCountdown(0)).toBe('0:00');
    expect(HO.formatCountdown(-5)).toBe('0:00');
  });
});

describe('browser-handoff — detecting the extension', () => {
  it('sees the marker the content script leaves', () => {
    expect(HO.extensionPresent(fakeDoc({ 'data-ab-extension': '1' }))).toBe(true);
  });

  it('reports absent when the marker is missing or not exactly "1"', () => {
    expect(HO.extensionPresent(fakeDoc())).toBe(false);
    expect(HO.extensionPresent(fakeDoc({ 'data-ab-extension': '0' }))).toBe(false);
    expect(HO.extensionPresent(fakeDoc({ 'data-ab-extension': 'yes' }))).toBe(false);
  });

  it('does not throw on a document without an element', () => {
    // A false negative here is harmless (the user is offered an install link for
    // something they already have, and pairing still works), but an exception
    // during render would take the whole picker bar down.
    expect(HO.extensionPresent({} as any)).toBe(false);
    expect(HO.extensionPresent(null as any)).toBe(false);
  });
});

describe('browser-handoff — choosing the screen for a local switch', () => {
  const pairing = { code: 'ABCDEFGH', display: 'ABCD-EFGH', expiresAt: 1_700_000_000_000 };

  it('asks for the code when the extension is already installed', () => {
    const plan = HO.planLocalSwitch({ pairing, extensionInstalled: true });
    expect(plan.step).toBe('pair');
    // The grouped form is what gets shown, because it is what gets typed.
    expect(plan.code).toBe('ABCD-EFGH');
    expect(plan.expiresAt).toBe(pairing.expiresAt);
  });

  it('asks for the install first when it is not', () => {
    const ext = { storeUrl: 'https://example.test/x', downloadPath: '/extension/download', steps: ['a', 'b'] };
    const plan = HO.planLocalSwitch({ pairing, extension: ext, extensionInstalled: false });
    expect(plan.step).toBe('install');
    expect(plan.install).toBe(ext);
    // The code still travels with the install screen: the user installs and then
    // pairs without the server having to mint a second code.
    expect(plan.code).toBe('ABCD-EFGH');
  });

  it('falls back to the raw code when no grouped form was sent', () => {
    const plan = HO.planLocalSwitch({ pairing: { code: 'ABCDEFGH' }, extensionInstalled: true });
    expect(plan.code).toBe('ABCDEFGH');
    expect(plan.expiresAt).toBe(0);
  });

  it('refuses to show a pairing screen with no code on it', () => {
    // Without a code there is nothing the user could do on that screen, so this
    // must surface as an error rather than an empty dialog.
    expect(HO.planLocalSwitch({ extensionInstalled: true }).step).toBe('error');
    expect(HO.planLocalSwitch({ pairing: {}, extensionInstalled: true }).reason).toBe('no_pairing');
    expect(HO.planLocalSwitch(undefined).step).toBe('error');
  });
});

describe('browser-handoff — the strings it asks for exist in both languages', () => {
  it('defines every ho.* key twice in i18n.js, once per locale', () => {
    // The module names keys as literals; a missing one renders the raw key to a
    // user. Two locales ship (fa + en), so each key must appear exactly twice —
    // a key added to only one locale is the failure this catches.
    const src = readFileSync(MODULE_PATH, 'utf8');
    const i18n = readFileSync(I18N_PATH, 'utf8');

    const keys = new Set<string>();
    const re = /['"](ho\.[A-Za-z0-9_]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) keys.add(m[1]);

    expect(keys.size).toBeGreaterThan(5);

    const missing: string[] = [];
    const wrongCount: string[] = [];
    keys.forEach((k) => {
      const defs = i18n.split(`'${k}'`).length - 1 + (i18n.split(`"${k}"`).length - 1);
      if (defs === 0) missing.push(k);
      else if (defs !== 2) wrongCount.push(`${k}=${defs}`);
    });

    expect(missing).toEqual([]);
    expect(wrongCount).toEqual([]);
  });
});
