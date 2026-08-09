/**
 * filechooser-not-lost.test.ts — an Import click must never vanish in silence,
 * and must never be answered on the wrong page's behalf.
 *
 * THE BUG (reported as «ایمپورت گم میشه» — the import gets lost)
 * -------------------------------------------------------------
 * Importing cookies through the J2TEAM Cookies extension used to work and then
 * stopped: the user clicked Import and nothing happened at all. No prompt, no
 * error, no toast.
 *
 * `LiveBrowser.attachPage` intercepted the page's file dialog like this:
 *
 *     page.on('filechooser', (chooser) => {
 *       if (page !== this.page) return;      // <- the whole bug
 *
 * The intent ("ignore a BACKGROUND tab's dialog") is reasonable; the
 * implementation is a race. `this.page` is assigned at the END of an async
 * activation — `adopt()` awaits `attachPage`, then `focus()` awaits
 * `bringToFront`, `bindCdp`, `injectPicker` and `page.title()`. An extension
 * popup opens as a NEW tab and its dialog can fire while that chain is still
 * running, so `this.page` is still the previous tab and the dialog is dropped.
 *
 * And `return` is the worst possible way to drop it: the chooser is left
 * unanswered, so nothing is emitted to the client. The prompt that is supposed
 * to ask "which of YOUR files?" never appears.
 *
 * MEASURED (real Chromium, persistent context):
 *
 *     chooser on the already-active page   -> prompt shown, file delivered
 *     chooser during a late activation     -> DROPPED silently
 *     after that drop:
 *         input.files.length               -> 0        (nothing arrived)
 *         page.title()                     -> 5ms      (page NOT wedged)
 *         clicking the input again         -> captured (a retry works)
 *
 * The last two lines chose the fix. The page is not blocked, so answering late
 * is safe; and a chooser belongs to a PAGE, so the honest question is not "is
 * this the active page right now" but "is this page one of the tabs we own".
 *
 * This is also why the extension's Export was broken in the same breath: with
 * REAL_CHROME_ENABLED an extension popup is just another tab, so its Export is
 * an ordinary download and its Import is an ordinary filechooser.
 *
 * THE HAZARD THE OLD GUARD WAS *ALSO* PROTECTING AGAINST — AND IT WAS REAL
 * -----------------------------------------------------------------------
 * An existing test («a background tab's file dialog is not answered as if it
 * were ours») failed when the guard was widened, so I measured its claim instead
 * of overruling it. It was right: `pendingChooser` is a single slot, and a
 * second tab's dialog could overwrite the first, sending the user's file to a
 * page they were not looking at.
 *
 *     sequence      : pending <- A | pending <- B
 *     A input files : 0
 *     B input files : 1        ← tab A asked, tab B received the file
 *
 * Trading a silent failure for a file delivered to the wrong page would have
 * been a worse bug than the one being fixed. So the slot is now FIRST-COME:
 * whoever asked keeps it until answered or cancelled, and a later dialog is
 * released rather than allowed to clobber it. Verified with the shipped rule:
 *
 *     sequence        : pending <- A | released 2nd (B)
 *     A input files   : 1     (the page that asked)
 *     B input files   : 0     (no theft)
 *     B after release : pending <- B   (B still works afterwards)
 *
 * WHAT THESE TESTS ARE, AND ONE THING I GOT WRONG FIRST
 * -----------------------------------------------------
 * The condition under test is a predicate inside a Playwright event handler, so
 * it cannot be imported. My first attempt re-implemented the predicate in the
 * test file and asserted against the copy — and mutation testing exposed that as
 * near-worthless: with the original bug restored in LiveBrowser.ts, only 1 of 6
 * tests failed, because five of them were testing the copy, not the code.
 *
 * So these tests EXTRACT the real listener body out of src/core/LiveBrowser.ts
 * and execute it, with `this` bound to a fake session and fake pages standing in
 * for Playwright's. If the shipped predicate changes, these fail.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
// The harness that extracts and executes the shipped guard. Shared with
// tests/unit/browser-tabs.test.ts so both suites exercise the SAME real code.
import { loadRealGuard, fakeSession, fakeChooser } from './helpers/filechooser-guard';

/** The OLD predicate, kept only to show the contrast inside one test. */
function oldGuard(self: { page: unknown }, page: unknown): 'prompt' | 'silence' {
  return page !== self.page ? 'silence' : 'prompt';
}

describe('a file dialog from one of our tabs is always answered', () => {
  it('prompts when the dialog arrives on the already-active tab', async () => {
    const guard = await loadRealGuard();
    const home = { name: 'home' };
    const { self, emitted } = fakeSession([home], home);
    guard(self, home, fakeChooser('c1'));
    expect(emitted).toEqual(['filechooser']);
    expect(self.pendingChooser).not.toBeNull();
  });

  it('prompts for a tab that is still mid-activation — the reported bug', async () => {
    // The exact measured race: the popup is already in `tabs` (adopt() pushed it)
    // but `this.page` still points at the previous tab because focus() has not
    // finished awaiting bringToFront/bindCdp/title.
    const guard = await loadRealGuard();
    const home = { name: 'home' };
    const popup = { name: 'extension-popup' };
    const { self, emitted } = fakeSession([home, popup], home);

    guard(self, popup, fakeChooser('c1'));
    expect(emitted).toEqual(['filechooser']);       // the prompt the user needs
    expect(self.pendingChooser).not.toBeNull();

    // Same inputs, old predicate: total silence. That is the whole bug.
    expect(oldGuard(self, popup)).toBe('silence');
  });

  it('releases a dialog from a page we do NOT own, instead of ignoring it', async () => {
    // The Real Chrome context is shared between sessions, so a foreign page must
    // still be refused — but an unanswered chooser leaves that page's <input>
    // waiting forever. Refusing means answering with an empty selection.
    const guard = await loadRealGuard();
    const ours = { name: 'ours' };
    const foreign = { name: 'another-session' };
    const { self, emitted } = fakeSession([ours], ours);
    const chooser = fakeChooser('c-foreign');
    guard(self, foreign, chooser);
    expect(emitted).toEqual([]);                     // correctly not our prompt
    expect(chooser.calls).toEqual(['setFiles([])']); // but released, not dropped
  });

  it('answers a background tab too, because the user can switch to it', async () => {
    // A tab we own is a tab the user can see and click. Waiting for it to become
    // active before acknowledging its dialog is what produced the silence.
    const guard = await loadRealGuard();
    const home = { name: 'home' };
    const background = { name: 'background' };
    const { self, emitted } = fakeSession([home, background], home);
    guard(self, background, fakeChooser('c'));
    expect(emitted).toEqual(['filechooser']);
  });

  it('records WHICH page asked, so the answer can be aimed correctly', async () => {
    const guard = await loadRealGuard();
    const a = { name: 'a' };
    const b = { name: 'b' };
    const { self } = fakeSession([a, b], a);
    const cb = fakeChooser('from-b');
    guard(self, b, cb);
    expect(self.pendingChooser).toBe(cb);
    expect(self.pendingChooserPage).toBe(b);
  });
});

describe('one outstanding dialog cannot be hijacked by another tab', () => {
  it('keeps the first asker and RELEASES the second — measured theft, prevented', async () => {
    // Without this, tab A opened the prompt and tab B's file input received the
    // file the user chose (measured: A=0 files, B=1). The single slot belongs to
    // whoever asked first.
    const guard = await loadRealGuard();
    const a = { name: 'a' };
    const b = { name: 'b' };
    const { self, emitted } = fakeSession([a, b], a);

    const first = fakeChooser('A-asked-first');
    guard(self, a, first);
    expect(self.pendingChooser).toBe(first);
    expect(self.pendingChooserPage).toBe(a);

    const second = fakeChooser('B-tries-to-steal');
    guard(self, b, second);
    // The slot is untouched…
    expect(self.pendingChooser).toBe(first);
    expect(self.pendingChooserPage).toBe(a);
    // …the intruder is released rather than left hanging…
    expect(second.calls).toEqual(['setFiles([])']);
    // …and the user is not shown a second prompt they did not ask for.
    expect(emitted).toEqual(['filechooser']);
  });

  it('lets the SAME page re-open its dialog (a retry is not a hijack)', async () => {
    // Clicking Import twice on one page must not lock the page out of importing.
    const guard = await loadRealGuard();
    const a = { name: 'a' };
    const { self, emitted } = fakeSession([a], a);
    guard(self, a, fakeChooser('first'));
    const again = fakeChooser('second-from-same-page');
    guard(self, a, again);
    expect(self.pendingChooser).toBe(again);   // replaced, not refused
    expect(again.calls).toEqual([]);           // and NOT released
    expect(emitted).toEqual(['filechooser', 'filechooser']);
  });

  it('frees the slot once the dialog is answered, so the next tab can import', async () => {
    const guard = await loadRealGuard();
    const a = { name: 'a' };
    const b = { name: 'b' };
    const { self } = fakeSession([a, b], a);
    guard(self, a, fakeChooser('A'));
    // What acceptFiles/cancelFileChooser do: release the slot AND its owner.
    self.pendingChooser = null;
    self.pendingChooserPage = null;
    const fromB = fakeChooser('B-later');
    guard(self, b, fromB);
    expect(self.pendingChooser).toBe(fromB);   // B is served now
    expect(fromB.calls).toEqual([]);
  });
});

describe('the shipped handler in LiveBrowser', () => {
  it('gates on tab ownership and no longer on the active page', async () => {
    // Source-level, and narrow on purpose: the subject is which predicate the
    // real listener uses. Its CORRECTNESS is covered behaviourally above.
    const src = await readFile('src/core/LiveBrowser.ts', 'utf8');
    const handler = /page\.on\('filechooser'[\s\S]{0,900}/.exec(src)?.[0] ?? '';
    expect(handler).toContain('this.tabs.some');
    // The regression itself: a bare active-page comparison must not return.
    expect(handler).not.toMatch(/if \(page !== this\.page\) return;/);
    // And a refused dialog must be released rather than abandoned.
    expect(handler).toContain('setFiles([])');
  });

  it('clears the owner everywhere it clears the slot', async () => {
    // A stale owner would refuse every later dialog from a different tab — the
    // silent-import bug wearing a new hat. Every release site must clear both.
    const src = await readFile('src/core/LiveBrowser.ts', 'utf8');
    const slotClears = (src.match(/this\.pendingChooser = null;/g) || []).length;
    const ownerClears = (src.match(/this\.pendingChooserPage = null;/g) || []).length;
    expect(slotClears).toBeGreaterThan(0);
    expect(ownerClears).toBeGreaterThanOrEqual(slotClears);
  });

  it('releases the slot when the owning tab is closed', async () => {
    // Otherwise a closed tab holds the single slot forever and no tab can import
    // again for the life of the session.
    const src = await readFile('src/core/LiveBrowser.ts', 'utf8');
    const onClose = src.slice(src.indexOf("page.on('close'"));
    expect(onClose.slice(0, 1200)).toContain('page === this.pendingChooserPage');
  });
});
