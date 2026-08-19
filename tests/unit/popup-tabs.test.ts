/**
 * popup-tabs.test.ts — the Element Inspector popup: exactly two tabs, and the
 * machinery that makes them work.
 *
 * THE DECISION THIS FILE DEFENDS, VERBATIM
 * ----------------------------------------
 *   «Popup افزونه باید دقیقاً دو تب داشته باشد: INSPECT / CONNECTION»
 *   «حذف تب ≠ حذف قابلیت»
 *   «Connection فقط Connection است.»
 *   «در Popup نهایی هیچ User ID نباید وجود داشته باشد.»
 *
 * Two things must be simultaneously true and they pull in opposite directions:
 *
 *   Element Inspector Popup            = EXACTLY TWO TABS
 *   Remote Browser / SessionHandoff    = STILL EXISTS
 *
 * A future edit can break either one without breaking the other, and neither
 * failure is visible from reading a single file. So both are asserted here:
 * §4 counts the tabs, and §5 checks that the subsystem the tabs stopped driving
 * still has a worker, a client library and a UI of its own.
 *
 * WHY THE MECHANICAL CHECKS MATTER TOO
 * ------------------------------------
 * popup.js resolves EVERY id in one eager `els` map at load, with no null
 * guards, and then wires listeners to them unconditionally. A single renamed or
 * dropped id does not degrade the popup — it throws on load and the whole popup
 * goes blank. The tab mechanism is also pure CSS sibling selectors, which
 * silently stop matching if the document order changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const html = read('extension/popup/popup.html');
const css = read('extension/popup/popup.css');
const js = read('extension/popup/popup.js');
const background = read('extension/background.js');

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

/**
 * The document with its comments removed — i.e. what a user can actually see.
 *
 * This matters more than it looks. The comments in popup.html quote the very
 * decision they implement («در Popup نهایی هیچ User ID نباید وجود داشته باشد»),
 * so a naive search for "User ID" over the raw file finds the sentence
 * FORBIDDING it and reports a violation. Testing the rendered document instead
 * of the source text is also what stops these assertions from being satisfiable
 * by deleting a comment.
 */
const visible = html.replace(/<!--[\s\S]*?-->/g, '');

/**
 * The markup of one panel, by id — to its own closing tag, counting nesting.
 *
 * A panel is a `<section>` and so is every card inside it, because that is what
 * the approved design is: a panel of cards. So this cannot stop at the first
 * `</section>` it meets — that one closes the FIRST CARD, and everything from the
 * second card onward would silently vanish from every assertion below. A test
 * that reads only the first card still passes while the rest of the tab is
 * missing entirely, which is the failure mode most worth avoiding here: these
 * assertions exist precisely to notice absent controls.
 */
function panel(id: string): string {
  const start = visible.indexOf(`id="${id}"`);
  expect(start, `panel ${id} must exist`).toBeGreaterThan(0);
  const rest = visible.slice(start);

  let depth = 1;
  const tag = /<(\/?)section\b/gi;
  let m = tag.exec(rest);
  while (m) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return rest.slice(0, m.index);
    m = tag.exec(rest);
  }
  return rest;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('§1 — the controller still finds everything it reaches for', () => {
  it('every id in the eager els map exists in the document', () => {
    const need = idsPopupJsNeeds();
    const have = new Set(idsInHtml());
    // Not a formality: `els.connect.addEventListener(...)` on a null throws
    // during load, before any listener is wired, so ONE missing id blanks the
    // entire popup rather than disabling one button.
    const missing = need.filter((id) => !have.has(id));
    expect(missing, 'popup.js would throw on load for these ids').toEqual([]);
    // Sanity floor: if the map ever parses to almost nothing, this whole test
    // would pass vacuously. The re-scope shrank the map, so the floor moved
    // down with it — but it still has to find a real map.
    expect(need.length).toBeGreaterThan(15);
  });

  it('no id appears twice', () => {
    const all = idsInHtml();
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    // getElementById returns the FIRST match, so a duplicate means the
    // controller silently drives the wrong element — the hardest kind of UI bug
    // to see, because everything still looks wired up.
    expect([...new Set(dupes)]).toEqual([]);
  });

  it('the controller reaches for no id the document has dropped', () => {
    // The mirror of the first test, and the one that catches a half-finished
    // deletion: markup removed while the code that drives it stayed.
    const need = new Set(idsPopupJsNeeds());
    const orphans = idsInHtml().filter(
      (id) => !need.has(id) && !id.startsWith('tab-') && !id.startsWith('p-'),
    );
    expect(orphans, 'these ids are in the HTML but nothing drives them').toEqual([]);
  });

  it('keeps the elements popup.js reveals as plain hidden attributes', () => {
    // popup.js shows these with `hidden = false` / `hidden = true`. That only
    // works while nothing in the CSS gives them a competing `display`, because a
    // stylesheet `display: block` beats the `hidden` attribute.
    for (const id of ['inspUnpair']) {
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
  const tabs = ['inspect', 'connection'];

  it('has one radio and one panel per tab', () => {
    for (const tab of tabs) {
      expect(html, `radio for ${tab}`).toContain(`id="tab-${tab}"`);
      expect(html, `panel for ${tab}`).toContain(`id="p-${tab}"`);
      expect(html, `label pointing at ${tab}`).toContain(`for="tab-${tab}"`);
    }
  });

  it('every panel has a rule that can reveal it', () => {
    for (const tab of tabs) {
      // The generic `.panel { display: none }` hides both. Without a matching
      // :checked rule a tab would open onto an empty popup.
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
    // popup.js has ONE setStatus() writing to #status, called from both tabs.
    // Inside a panel it would answer "did my key work?" into a hidden tab.
    const panelsEnd = html.indexOf('<footer class="foot">');
    expect(panelsEnd).toBeGreaterThan(0);
    expect(
      html.indexOf('id="status"'),
      '#status must live in the footer, after every panel',
    ).toBeGreaterThan(panelsEnd);
  });

  it('the per-panel status lines stay in their own panels', () => {
    // Written by setInspStatus/setPairStatus, which are each only called from
    // one tab, so they belong next to the controls they describe.
    for (const id of ['inspStatus', 'inspPairStatus']) {
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
describe('§4 — the popup is EXACTLY two tabs, and they are the right two', () => {
  it('the strip holds two labels, INSPECT then CONNECTION', () => {
    const nav = html.slice(html.indexOf('<nav class="tabs">'), html.indexOf('</nav>'));
    const labels = nav.match(/<label\b/g) || [];
    // «هیچ Tab سوم یا چهارمی اضافه نکن.» The active-tab underline is also
    // addressed by position, so an extra label would shift every rule after it
    // onto the wrong tab.
    expect(labels.length).toBe(2);
    const order = (nav.match(/for="tab-([a-z]+)"/g) || []).map((m) =>
      m.replace(/for="tab-|"/g, ''),
    );
    expect(order).toEqual(['inspect', 'connection']);
  });

  it('the document declares two tab radios and two panels, no more', () => {
    // Counted independently of the strip: a radio or panel left behind after a
    // tab was dropped from the nav is invisible but still selectable by CSS.
    expect((html.match(/class="tabin"/g) || []).length).toBe(2);
    expect((html.match(/<section class="panel"/g) || []).length).toBe(2);
  });

  it('the Run, Local and Setup tabs are gone', () => {
    for (const dead of ['tab-run', 'tab-local', 'tab-setup', 'p-run', 'p-local', 'p-setup']) {
      expect(html, `${dead} must not survive`).not.toContain(dead);
      // Also gone from the stylesheet: a leftover `#tab-run:checked ~ …` rule
      // is dead weight that the next reader has to prove is dead.
      expect(css, `${dead} must not survive in CSS`).not.toContain(dead);
    }
  });

  it('no <label for> points at a tab that no longer exists', () => {
    // A dangling `for=` is a link that silently does nothing, which is worse
    // than no link: the user concludes the popup is broken.
    const targets = [...new Set(
      (html.match(/for="tab-[a-z-]+"/g) || []).map((m) => m.replace(/for="|"/g, '')),
    )];
    const declared = new Set(
      (html.match(/id="tab-[a-z-]+"/g) || []).map((m) => m.replace(/id="|"/g, '')),
    );
    expect(targets.filter((t) => !declared.has(t))).toEqual([]);
  });

  it('carries no User ID anywhere in the popup', () => {
    // §25: «There is NO: username, user ID, password, login form.» Identity
    // comes from backend authentication; a user-typed identity here would be a
    // second, contradictable source of truth.
    expect(html).not.toMatch(/id="userId"/);
    expect(visible, 'no visible text may ask for a user id').not.toMatch(/user\s*id/i);
    // The storage key and the /me resolver go too. Leaving them would keep a
    // user id alive as invisible state that the UI can no longer show or
    // correct — the worst of both arrangements. Comments are stripped first for
    // the same reason as `visible`: this file's own explanation of the rule
    // must not be able to trip the rule.
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the controller must not read or write a user id').not.toMatch(/ab_userId/);
    expect(code).not.toMatch(/resolveUserId/);
  });

  it('the header names the product, not the old helper', () => {
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('Element Inspector');
    expect(header).not.toMatch(/Automation Helper/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§5 — removing the tabs did NOT remove the capabilities', () => {
  it('the Session Handoff client library still ships', () => {
    // «حذف تب ≠ حذف قابلیت». The old Local tab was one UI for Session Handoff,
    // not the subsystem itself.
    expect(existsSync(join(root, 'extension/lib/ab-handoff.js'))).toBe(true);
  });

  it('the background worker still answers every handoff and run message', () => {
    // The popup stopped SENDING these. The worker must not stop HANDLING them:
    // it is the only thing standing between the manifest and the backend, and a
    // handler removed here cannot be re-added by a caller.
    for (const type of [
      'AB_HANDOFF_PAIR', 'AB_HANDOFF_APPLY', 'AB_HANDOFF_STATUS', 'AB_HANDOFF_UNPAIR',
      'AB_MODE_GET', 'AB_MODE_SET',
      'AB_SEND_FLOW', 'AB_RUN_SAVED', 'AB_LIST_WORKFLOWS', 'AB_LIVE_START', 'AB_LIVE_STOP',
      'AB_RELAY', 'AB_OPEN_PANEL',
    ]) {
      expect(background, `${type} must still be handled`).toContain(`case '${type}':`);
    }
  });

  it('the web app keeps its own handoff UI, so the subsystem has a real user', () => {
    // This is the fact that makes "two tabs" and "handoff survives"
    // non-contradictory: switching a session between Remote and Local is driven
    // from the app, and never needed this popup.
    const appUi = read('public/js/browser-handoff.js');
    expect(appUi).toContain('/browser-mode/handoff/start');
    expect(appUi).toContain('/browser-mode/handoff/complete');
    expect(read('public/index.html')).toContain('/js/browser-handoff.js');
  });

  it('the picker and recorder content scripts are still registered', () => {
    // They are reached through AB_RELAY rather than from a popup button now.
    // Dropping them from the manifest would take the capability with them.
    const manifest = read('extension/manifest.json');
    for (const script of ['content/selector.js', 'content/inspector.js', 'content/recorder.js']) {
      expect(manifest, `${script} must stay registered`).toContain(script);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§6 — Connection is only Connection', () => {
  it('reports the resolved connection, and offers nothing to fill in', () => {
    // WHAT THIS TEST USED TO REQUIRE, and why it had to change: it demanded
    // #modeLocal, #modeRemote, #baseUrl, #apiKey, #inspCode and #connect be
    // present on this panel — that is, it required by name every field the
    // requirement forbids:
    //
    //     «LOCAL UI نباید این موارد را داشته باشد:
    //      Base URL / API Key / Authorization Code / Remote Approval»
    //
    // So the panel is now a REPORT rather than a form. What it must still show
    // is the outcome — where the backend is, whether the field will accept a
    // pick, and which field that is — because a connection whose destination is
    // unstated is the one failure mode worse than no connection: the send works
    // and lands somewhere else.
    const p = panel('p-connection');
    for (const id of [
      'connState', 'connBackend', 'connAuth',
      'ctNode', 'ctField', 'ctFieldId',
    ]) {
      expect(p, `Connection must contain #${id}`).toContain(`id="${id}"`);
    }
  });

  it('contains no credential input of any kind', () => {
    // The inverse, asserted by name. Listing the exact removed ids means a
    // future change that reintroduces any one of them fails here rather than
    // being noticed by the user as a form that came back.
    const p = panel('p-connection');
    for (const dead of ['modeLocal', 'modeRemote', 'baseUrl', 'apiKey', 'inspCode', 'connect']) {
      expect(p, `Connection must not contain #${dead}`).not.toContain(`id="${dead}"`);
    }
    // No free-text entry at all: an <input> or <textarea> here is something to
    // type into, whatever it happens to be called.
    expect(p).not.toMatch(/<input\b/i);
    expect(p).not.toMatch(/<textarea\b/i);
  });

  it('says plainly that there is nothing to enter', () => {
    // An empty panel is indistinguishable from a panel that failed to render. A
    // user who remembers typing an address needs to be told that not typing one
    // is now the correct state, or the fix reads as a bug.
    expect(panel('p-connection')).toMatch(/nothing to enter/i);
  });


  it('hosts no Handoff, Session or Run control', () => {
    const p = panel('p-connection');
    // «Connection فقط Connection است.» Migrating the old controls in here would
    // rebuild the Automation Helper panel the re-scope removes — the outcome
    // explicitly rejected as "option B".
    for (const dead of [
      'hoCode', 'hoPair', 'hoApply', 'hoUnpair', 'hoStatus', 'hoState', 'hoSession',
      'wflist', 'refreshWf', 'sendFlow', 'steps', 'clearSteps',
      'liveCard', 'livesteps', 'modeSwitch', 'openPanel',
    ]) {
      expect(p, `Connection must not contain #${dead}`).not.toContain(`id="${dead}"`);
    }
    expect(p).not.toMatch(/handoff/i);
    expect(p).not.toMatch(/workflow/i);
  });

  it('offers no backend chooser, and still never mentions a Remote Browser', () => {
    const p = panel('p-connection');
    // The rule this test enforces is unchanged and permanent: the three concepts
    // must not be conflated. BrowserEnvironment (LOCAL/REMOTE) decides which
    // browser does the picking, TargetField decides where the data lands, and
    // the Inspector sends one value.
    //
    // What changed is that the popup's own Local/Remote control — a BACKEND URL
    // choice, §1's, unrelated to BrowserEnvironment despite the identical words —
    // is gone, because the backend address is resolved internally now. Removing
    // it removes the likeliest source of the confusion this test guards against,
    // so the first two assertions invert while the last two stand.
    expect(p).not.toMatch(/Local Backend/);
    expect(p).not.toMatch(/Remote Backend/);
    expect(p).not.toMatch(/Remote Browser/i);
    expect(p).not.toMatch(/move (a |your )?(running )?session/i);
  });


  it('shows the exact Target Field id, which is what a send is aimed at', () => {
    const p = panel('p-connection');
    // §26: «The target confirmation is essential.» A connection that is up but
    // pointed somewhere unexpected is worse than none, because the send works.
    expect(p).toContain('id="ctFieldId"');
    expect(p).toMatch(/Connected to target/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§7 — Inspect is about one pick reaching one field', () => {
  it('names the destination before it offers the button', () => {
    const p = panel('p-inspect');
    // A pick that cannot be delivered is the first thing a user needs to know
    // about, not something to discover after clicking.
    expect(p.indexOf('id="inspTarget"')).toBeLessThan(p.indexOf('id="inspect"'));
    for (const id of ['inspNodeName', 'inspFieldName', 'inspFieldId']) {
      expect(p, `Inspect must show #${id}`).toContain(`id="${id}"`);
    }
  });

  it('shows no session id, because the destination is not a session', () => {
    // The Target Field survives a session change and a Local/Remote switch
    // precisely because it is not one. Showing a session here would invite the
    // user to treat it as the thing that identifies their destination.
    expect(panel('p-inspect')).not.toMatch(/session/i);
    expect(js).not.toMatch(/AB_INSPECTOR_SESSION'.*sessionId/);
  });

  it('sends the user to Connection when there is nothing to pick into', () => {
    // A real <label for>, so it switches tabs with no script — and the only
    // place a destination can be established is the Connection tab.
    expect(panel('p-inspect')).toContain('for="tab-connection"');
  });
});
