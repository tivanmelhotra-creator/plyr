/**
 * restart-tab-loss.test.ts — the regression the user called «مشکل بزرگیه».
 *
 * The report (docs/HANDOFF-SIX-REGRESSIONS.md §2):
 *
 *   «وقتی خواستم یه اکستنشن نصب کنم بعد نصب نمیدونم ریستارت شد یا چی، کل تب‌ها
 *   گم شدن ... نهایتش باید یه رفرش می‌شد»
 *   — installing an extension lost EVERY tab. At worst it should have been a
 *   reload.
 *
 * What actually happened, MEASURED live by tools/probe-restart-tabs.js before
 * the fix: three tabs went in, ONE `about:blank` came out, and the saved list on
 * disk had been overwritten with a single entry. So the loss was permanent — the
 * backup was destroyed by the very failure it exists to survive.
 *
 * Chain of causes, in the order they fire:
 *
 *   1. an extension install MUST relaunch Chrome (Chrome only reads extensions
 *      at launch), which closes every page inside it;
 *   2. `page.on('close')` treated each of those as "a background tab closed
 *      itself" and deleted the record;
 *   3. `persistTabs()` then wrote the shrunken list to disk;
 *   4. `recover()` had nothing left to restore, and only ever materialized the
 *      single ACTIVE tab anyway.
 *
 * Why these are STATIC tests
 * ──────────────────────────
 * The live proof already exists and is the primary evidence
 * (tools/probe-restart-tabs.js, 13/13). What a unit test adds is protection
 * against the fix being quietly undone by a later edit — and every step of the
 * chain above is a wiring decision (which branch runs, which guard is present,
 * what order things happen in) rather than a computation. That is exactly the
 * class of thing that drifts silently, and exactly what `browser-tabs.test.ts`
 * already pins for the earlier tab bugs, so this file follows its style.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const liveBrowser = read('src/core/LiveBrowser.ts');

/** The body of `page.on('close', …)` inside attachPage(). */
function closeHandler(): string {
  const at = liveBrowser.indexOf("page.on('close'");
  expect(at, "page.on('close') must exist — it is the tab lifecycle").toBeGreaterThan(0);
  // Bounded by the next declaration rather than a character count: a fixed
  // window is a test that breaks when the code merely grows.
  const end = liveBrowser.indexOf('private async refreshFavicon', at);
  return liveBrowser.slice(at, end > at ? end : at + 4000);
}

/** The body of `recover()`. */
function recoverBody(): string {
  const at = liveBrowser.indexOf('private async recover(reason: string)');
  expect(at, 'recover() must exist').toBeGreaterThan(0);
  const end = liveBrowser.indexOf('async resync()', at);
  return liveBrowser.slice(at, end > at ? end : at + 6000);
}

/** The body of `persistTabs()`. */
function persistBody(): string {
  const at = liveBrowser.indexOf('private async persistTabs()');
  expect(at, 'persistTabs() must exist').toBeGreaterThan(0);
  const end = liveBrowser.indexOf('// Public tab commands', at);
  return liveBrowser.slice(at, end > at ? end : at + 2000);
}

// ══════════════════════════════════════════════════════════════════════════
// A. A page dying because the BROWSER died is not a tab closing.
// ══════════════════════════════════════════════════════════════════════════

describe('a relaunched Chrome must not delete tab records', () => {
  it('keeps the record and only forgets the page when a background page closes', () => {
    const body = closeHandler();
    // The provisional state is "the tab stays, its page is gone". That ordering
    // is the fix: a tab wrongly kept for a moment is invisible, a tab wrongly
    // deleted is the reported bug.
    expect(body).toMatch(/tab\.pending = true/);
    expect(body).toMatch(/tab\.dead = false/);
  });

  it('does NOT decide a tab is gone synchronously inside the close handler', () => {
    const body = closeHandler();
    // MEASURED: deciding inline was wrong and STILL lost the tabs.
    // `isContextDead()` reads `context.pages().length === 0`, but a relaunch
    // closes pages one at a time, so the first handler to run still sees live
    // siblings and wrongly concludes the browser is healthy. The verdict has to
    // be deferred until it is answerable.
    expect(body).toContain('SELF_CLOSE_GRACE_MS');
    expect(body).toMatch(/setTimeout\(/);
    // The deletion must live INSIDE the deferred check, never before it.
    const deferred = body.slice(body.indexOf('setTimeout('));
    expect(deferred).toMatch(/this\.tabs = this\.tabs\.filter/);
    const beforeDefer = body.slice(0, body.indexOf('setTimeout('));
    expect(
      /this\.tabs = this\.tabs\.filter/.test(beforeDefer),
      'no tab may be dropped before the browser-vs-tab question is answerable',
    ).toBe(false);
  });

  it('treats a recovery in flight as proof the browser went, not the tab', () => {
    const body = closeHandler();
    const deferred = body.slice(body.indexOf('setTimeout('));
    expect(deferred).toMatch(/isContextDead\(this\.context\)/);
    // A recovery already running is the same answer arriving early.
    expect(deferred).toMatch(/this\.recovering/);
    expect(deferred).toMatch(/this\.tabsFrozen/);
  });

  it('never writes the tab list from the provisional half of the handler', () => {
    const body = closeHandler();
    const beforeDefer = body.slice(0, body.indexOf('setTimeout('));
    // Comments are stripped first. The first version of this assertion matched
    // the words `persistTabs()` inside the comment that EXPLAINS the rule, and
    // failed — a test measuring prose instead of behaviour. Only a real call
    // counts, so the match is anchored on the receiver.
    const code = beforeDefer
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    // Persisting a guess is how a scare became permanent loss.
    expect(
      /this\.persistTabs\(/.test(code),
      'nothing may reach disk while the browser-vs-tab question is still open',
    ).toBe(false);
  });

  it('still reaps a tab that genuinely closed itself', () => {
    // The fix must not turn window.close() into a tab that never goes away —
    // that would be the opposite bug, and just as wrong.
    const deferred = closeHandler();
    expect(deferred).toMatch(/tab\.dead = true/);
    expect(deferred).toMatch(/this\.tabs = this\.tabs\.filter\(\(t\) => t !== tab\)/);
    expect(deferred).toMatch(/void this\.persistTabs\(\)/);
  });

  it('has a documented grace constant, not a bare number', () => {
    expect(liveBrowser).toMatch(/const SELF_CLOSE_GRACE_MS = \d+/);
    // The reason has to survive next to the number, or the next reader deletes
    // it as a mystery sleep.
    const at = liveBrowser.indexOf('const SELF_CLOSE_GRACE_MS');
    const doc = liveBrowser.slice(Math.max(0, at - 1400), at);
    expect(doc).toMatch(/MEASURED/);
    expect(doc).toMatch(/relaunch|extension/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. The saved list must survive the failure it exists to survive.
// ══════════════════════════════════════════════════════════════════════════

describe('the saved tab list is frozen while it cannot be trusted', () => {
  it('persistTabs() refuses while frozen, next to the closed guard', () => {
    const body = persistBody();
    expect(body).toMatch(/if \(this\.closed\) return;/);
    expect(body).toMatch(/if \(this\.tabsFrozen\) return;/);
  });

  it('recover() freezes the list for the whole rebuild', () => {
    const body = recoverBody();
    expect(body).toMatch(/this\.tabsFrozen = true/);
    // Frozen before anything starts dying, or the first close writes through it.
    const froze = body.indexOf('this.tabsFrozen = true');
    const emitted = body.indexOf("this.emit('recovering'");
    expect(froze).toBeGreaterThan(0);
    expect(froze).toBeLessThan(emitted);
  });

  it('lifts the freeze on success AND on the failure paths', () => {
    const body = recoverBody();
    // Three lifts: the active-tab-failed path, the success path, and the
    // finally. A freeze that outlives its recovery would silently stop the
    // session ever saving tabs again — the opposite failure, equally quiet.
    const lifts = body.match(/this\.tabsFrozen = false/g) || [];
    expect(lifts.length).toBeGreaterThanOrEqual(3);
    expect(body).toMatch(/finally \{[\s\S]*this\.tabsFrozen = false[\s\S]*\}/);
  });

  it('close() honours the freeze even though it writes inline', () => {
    const at = liveBrowser.indexOf('async close(): Promise<void>');
    const body = liveBrowser.slice(at, at + 3000);
    // Closing the window mid-recovery is exactly what a frightened user does.
    // The on-disk list is better than anything in memory at that moment.
    expect(body).toMatch(/if \(!this\.tabsFrozen\)/);
    expect(body).toMatch(/saveTabs\(this\.userId, list\)/);
  });

  it('documents why a flag separate from `recovering` is used', () => {
    const at = liveBrowser.indexOf('private tabsFrozen');
    const doc = liveBrowser.slice(Math.max(0, at - 1800), at);
    expect(doc).toMatch(/MEASURED/);
    // `recovering` is a promise used to serialise; overloading it as a data
    // guard would let any awaiting caller clear the guard as a side effect.
    expect(doc).toMatch(/serialise|serialize/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C. recover() restores the SET, not just the tab in front.
// ══════════════════════════════════════════════════════════════════════════

describe('recover() restores the whole strip', () => {
  it('materializes the active tab first, then re-announces the rest', () => {
    const body = recoverBody();
    const materialize = body.indexOf('this.materialize(target)');
    const rest = body.indexOf('const restored = this.tabs.filter');
    expect(materialize).toBeGreaterThan(0);
    expect(rest).toBeGreaterThan(materialize);   // the user's own tab wins the race
    expect(body).toMatch(/this\.emitTabs\(\)/);
  });

  it('marks the other tabs pending rather than dropping them', () => {
    const body = recoverBody();
    const rest = body.slice(body.indexOf('const restored = this.tabs.filter'));
    expect(rest).toMatch(/t\.pending = true/);
    // Lazily on purpose: eagerly reloading fifteen pages inside a browser that
    // has only just come back turns a recovery into a second outage.
    expect(rest).not.toMatch(/await this\.materialize\(t\)/);
  });

  it('keeps the active tab in the strip even when its page cannot come back', () => {
    const body = recoverBody();
    const fail = body.slice(body.indexOf('if (!ok) {'), body.indexOf('await this.focus(target)'));
    // The old code deleted it here. That is what turned "one page failed to
    // reload" into "my tab is gone", and via persistTabs() into permanent loss.
    expect(fail).toMatch(/target\.pending = true/);
    expect(fail).not.toMatch(/this\.tabs = this\.tabs\.filter/);
  });

  it('tells the client how much survived', () => {
    // Silence after a scare is what made a reload feel like data loss.
    expect(recoverBody()).toMatch(/this\.emit\('tabsRestored'/);
  });

  it('honours the promise index.ts makes to the user', () => {
    // index.ts states the contract in words; this asserts the words are still
    // there, because they are the reason the code above looks the way it does.
    const index = read('src/index.ts');
    expect(index).toMatch(/never a lost tab/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D. An extension install must not be able to reach "forget everything".
// ══════════════════════════════════════════════════════════════════════════

describe('an extension install cannot clear the saved session', () => {
  it('clearTabs() is only reachable from forgetSession()', () => {
    // clearTabs() exists for "sign out of everything". If an install could ever
    // reach it, the tabs would be gone from disk before any recovery could run —
    // a different route to the same reported symptom.
    const uses = liveBrowser.split('clearTabs(').length - 1;
    // One import, one call inside forgetSession().
    expect(uses).toBeLessThanOrEqual(2);
    const at = liveBrowser.indexOf('async forgetSession()');
    const body = liveBrowser.slice(at, at + 900);
    expect(body).toContain('clearTabs(');
  });

  it('the install/restart routes never touch the tab store', () => {
    const routes = read('src/Routes/browser.routes.ts');
    expect(routes).not.toContain('clearTabs');
    expect(routes).not.toContain('forgetSession');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// E. The live instrument has to keep existing.
// ══════════════════════════════════════════════════════════════════════════

describe('the live proof is checked in', () => {
  it('ships a probe that forces a real relaunch under a real session', () => {
    // §8.2 of the handoff: "a layer with no instrument is a layer where bugs
    // survive" — the restart path had unit tests and no live instrument, and
    // that is precisely where this bug lived.
    const probe = read('tools/probe-restart-tabs.js');
    expect(probe).toContain('/browser/restart');
    expect(probe).toMatch(/tabs\.json/);            // asserts the on-disk backup
    expect(probe).toMatch(/three tabs/i);
    // It must check the tab that was active is still active, not merely count.
    expect(probe).toMatch(/still the active one/i);
  });
});
