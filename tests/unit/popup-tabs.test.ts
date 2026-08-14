/**
 * popup-tabs.test.ts — the extension popup, reorganised into tabs.
 *
 * THE REPORT, VERBATIM
 * --------------------
 *   «UI/UX پاپ‌آپ افزونه Automation Helper هم بهتر کن گیج شدم و نتونستم لوکال
 *    رو تست کنم»
 *
 * WHAT WAS WRONG
 * --------------
 * Seven cards, all expanded, in a 340px column — Backend, Move session here,
 * Element Inspector, Workflows, Capture, Steps, Live run — with no grouping and
 * no primary action. Two unrelated features were both called "local" (the
 * Inspector's Local/Remote target, and the Remote→Local session handoff) and sat
 * in different cards with nothing said about how they differ, which is why Local
 * mode was never successfully tested.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The redesign is HTML and CSS only, and it is load-bearing in a way that no
 * amount of care in one file can protect: popup.js resolves EVERY id in one
 * eager `els` map at load, with no null guards, and then wires listeners to them
 * unconditionally. A single renamed or dropped id does not degrade the popup —
 * it throws on load and the whole popup goes blank. The tab mechanism is also
 * pure CSS sibling selectors, which silently stop matching if the document order
 * changes.
 *
 * So the invariants tested here are the ones a future edit can plausibly break:
 *   §1  every id popup.js reaches for still exists, exactly once
 *   §2  the CSS tab machinery can actually match the markup
 *   §3  the shared status line is not inside a panel that can be hidden
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const html = read('extension/popup/popup.html');
const css = read('extension/popup/popup.css');
const js = read('extension/popup/popup.js');

/** Every id popup.js resolves through its eager `els` map. */
function idsPopupJsNeeds(): string[] {
  const start = js.indexOf('var els = {');
  expect(start, 'popup.js must still build an els map').toBeGreaterThan(0);
  const end = js.indexOf('};', start);
  const block = js.slice(start, end);
  const found = block.match(/\$\('([A-Za-z0-9_-]+)'\)/g) || [];
  return [...new Set(found.map((m) => m.replace(/^\$\('|'\)$/g, '')))];
}

/** ids actually present in the document, in order of appearance. */
function idsInHtml(): string[] {
  return (html.match(/\sid="([A-Za-z0-9_-]+)"/g) || []).map((m) =>
    m.replace(/\sid="|"$/g, ''),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
describe('§1 — the controller still finds everything it reaches for', () => {
  it('every id in the eager els map exists in the document', () => {
    const need = idsPopupJsNeeds();
    const have = new Set(idsInHtml());
    // Not a formality: `els.saveCfg.addEventListener(...)` on a null throws
    // during load, before any listener is wired, so ONE missing id blanks the
    // entire popup rather than disabling one button.
    const missing = need.filter((id) => !have.has(id));
    expect(missing, 'popup.js would throw on load for these ids').toEqual([]);
    // Sanity floor: if the map ever parses to almost nothing, this whole test
    // would pass vacuously.
    expect(need.length).toBeGreaterThan(30);
  });

  it('no id appears twice', () => {
    const all = idsInHtml();
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    // getElementById returns the FIRST match, so a duplicate means the
    // controller silently drives the wrong element — the hardest kind of UI bug
    // to see, because everything still looks wired up.
    expect([...new Set(dupes)]).toEqual([]);
  });

  it('keeps the elements popup.js reveals as plain hidden attributes', () => {
    // popup.js shows these with `hidden = false` / `hidden = true`. That only
    // works while nothing in the CSS gives them a competing `display`, because a
    // stylesheet `display: block` beats the `hidden` attribute.
    for (const id of ['liveCard', 'pickedBox', 'hoApply', 'hoUnpair', 'modeSwitch']) {
      expect(html, `${id} must ship hidden`).toMatch(
        new RegExp(`id="${id}"[^>]*\\bhidden\\b|\\bhidden\\b[^>]*id="${id}"`),
      );
      expect(
        css.includes(`#${id} {`),
        `#${id} must not get a display rule that would defeat hidden`,
      ).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§2 — the CSS-only tab strip can actually match the markup', () => {
  const tabs = ['inspect', 'run', 'local', 'setup'];

  it('has one radio and one panel per tab', () => {
    for (const tab of tabs) {
      expect(html, `radio for ${tab}`).toContain(`id="tab-${tab}"`);
      expect(html, `panel for ${tab}`).toContain(`id="p-${tab}"`);
      expect(html, `label pointing at ${tab}`).toContain(`for="tab-${tab}"`);
    }
  });

  it('every panel has a rule that can reveal it', () => {
    for (const tab of tabs) {
      // The generic `.panel { display: none }` hides all four. Without a
      // matching :checked rule a tab would open onto an empty popup.
      const rule = new RegExp(`#tab-${tab}:checked\\s*~\\s*\\.panels\\s+#p-${tab}\\b`);
      expect(css, `#p-${tab} must have a reveal rule`).toMatch(rule);
    }
    expect(css, 'panels must start hidden').toMatch(/\.panel\s*\{[^}]*display:\s*none/);
  });

  it('exactly one radio is checked, so the popup never opens blank', () => {
    const checked = (html.match(/class="tabin"[^>]*\bchecked\b/g) || []).length;
    expect(checked).toBe(1);
    // Inspect is the reason the extension exists, so it is the landing tab.
    expect(html).toMatch(/id="tab-inspect"[^>]*\bchecked\b/);
  });

  it('the radios precede the strip and the panels in document order', () => {
    // `~` only looks FORWARD among siblings. If a future edit moves the radios
    // below .tabs or .panels the selectors keep parsing and silently match
    // nothing, leaving a popup whose tabs do nothing at all.
    const lastRadio = html.lastIndexOf('class="tabin"');
    expect(lastRadio).toBeGreaterThan(0);
    expect(lastRadio, 'radios must precede .tabs').toBeLessThan(
      html.indexOf('<nav class="tabs">'),
    );
    expect(lastRadio, 'radios must precede .panels').toBeLessThan(
      html.indexOf('<div class="panels">'),
    );
  });

  it('the strip holds exactly the four labels its nth-of-type rules assume', () => {
    const nav = html.slice(
      html.indexOf('<nav class="tabs">'),
      html.indexOf('</nav>'),
    );
    const labels = nav.match(/<label\b/g) || [];
    // The active-tab underline is addressed by position. Any extra label inside
    // .tabs shifts every rule after it onto the wrong tab.
    expect(labels.length).toBe(4);
    const order = (nav.match(/for="tab-([a-z]+)"/g) || []).map((m) =>
      m.replace(/for="tab-|"/g, ''),
    );
    expect(order).toEqual(tabs);
  });

  it('the radios stay reachable by keyboard', () => {
    // Hidden with position/opacity, NOT `display: none` or `visibility: hidden`,
    // either of which removes them from the tab order and makes the strip
    // unusable without a mouse.
    const rule = css.slice(css.indexOf('.tabin {'), css.indexOf('}', css.indexOf('.tabin {')));
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§3 — feedback lands where the user can see it', () => {
  it('the shared status line sits outside the panels', () => {
    // popup.js has ONE setStatus() writing to #status, called from three tabs:
    // Setup ("Connected as …", "Connection failed: …"), Inspect ("Picked <a>",
    // "Copied.") and Run ("Queued ✓"). Inside a panel it would answer "did my
    // key work?" into a hidden tab — a silent failure of the same kind as the
    // dead Save button that started this whole report.
    const panelsEnd = html.indexOf('<footer class="foot">');
    expect(panelsEnd).toBeGreaterThan(0);
    expect(
      html.indexOf('id="status"'),
      '#status must live in the footer, after every panel',
    ).toBeGreaterThan(panelsEnd);
  });

  it('the per-panel status lines stay in their own panels', () => {
    // These two are written by setInspStatus/setHoStatus, which are only ever
    // called from their own tab, so they belong next to the controls they
    // describe rather than in the shared footer.
    for (const id of ['inspStatus', 'hoStatus']) {
      expect(html.indexOf(`id="${id}"`)).toBeLessThan(
        html.indexOf('<footer class="foot">'),
      );
    }
  });

  it('the footer reserves height so the popup does not jump', () => {
    const foot = css.slice(css.indexOf('.foot {'), css.indexOf('}', css.indexOf('.foot {')));
    expect(foot).toMatch(/min-height/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§4 — Local mode is now something a user can follow', () => {
  it('spells out the procedure, not just the input box', () => {
    const panel = html.slice(html.indexOf('id="p-local"'), html.indexOf('id="p-setup"'));
    // The box was always there; «نتونستم لوکال رو تست کنم» was about not knowing
    // where the code comes from, that it expires, or what to press.
    expect(panel).toContain('<ol class="howto">');
    expect(panel).toMatch(/Switch to Local/);
    expect(panel).toMatch(/five minutes/);
    const steps = panel.slice(panel.indexOf('<ol class="howto">'), panel.indexOf('</ol>'));
    expect((steps.match(/<li>/g) || []).length).toBe(3);
  });

  it('says how pairing differs from the Inspector target', () => {
    const panel = html.slice(html.indexOf('id="p-local"'), html.indexOf('id="p-setup"'));
    // The two features share the word "local" and were the main source of
    // confusion, so the difference is written on the page rather than left to be
    // inferred.
    expect(panel).toMatch(/not the same/i);
    expect(panel).toContain('for="tab-inspect"');
  });
});
