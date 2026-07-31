/**
 * editor-shell.test.ts — regression guard for the editor shell rebuild
 * (docs/uiux/state-empty-canvas.md + shell-editor-launcher-menu.md, items A–E
 * of docs/uiux/04-HANDOFF-editor-shell-outline-activity.md).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The rebuild replaced the editor's whole top bar, added an OUTLINE rail and a
 * four-tab ACTIVITY LOG, and regrouped the blocks palette. Three classes of
 * regression are cheap to cause and expensive to notice:
 *
 *   1. A DROPPED LEGACY ID. Six low-traffic buttons (`#fe-load`, `#fe-json`,
 *      `#fe-clear`, `#fe-save`, `#fe-save-server`, `#fe-from-run`) still have
 *      UNGUARDED `querySelector(...).addEventListener(...)` wiring further down
 *      `renderEditor`. Removing one from the markup throws a TypeError mid-render
 *      and blanks the entire editor. They live in a hidden `.fe-legacy` span
 *      precisely so the markup can look modern without breaking that wiring.
 *
 *   2. A FAKE DESTINATION. `app.js#currentRoute()` SILENTLY rewrites an unknown
 *      hash to `#/workspace`. So a plausible-looking `#/templates` does not 404
 *      — it quietly dumps the user somewhere else, which is indistinguishable
 *      from a bug and is exactly the "fake-successful UI" the house rules ban.
 *      Every `data-route` the editor emits is checked against the real route
 *      table here.
 *
 *   3. AN INVENTED COUNT. The reference image shows seven palette rows totalling
 *      128 blocks; the real catalog has six categories and fifty actions. The
 *      resolution was PRESENTATIONAL — map the image's vocabulary onto real
 *      categories and COMPUTE every count — and these tests pin that down so the
 *      mock's numbers cannot be hardcoded back in later.
 *
 * Plus the standing contracts: i18n keys in BOTH dictionaries (t() falls back to
 * English, so a missing Persian key is invisible at runtime), icon names that
 * resolve (a typo renders the invisible `dot` fallback), no emoji in shipped
 * front-end code, and chrome/view flags kept OFF `state`.
 *
 * views.js / flow-editor.js / run-panel.js are DOM-bound IIFEs, so — like
 * canvas-chrome.test.ts and workspace-ui.test.ts — they are asserted at the
 * SOURCE level.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');

const VIEWS = readFileSync(join(PUBLIC, 'js', 'views.js'), 'utf8');
const FE = readFileSync(join(PUBLIC, 'js', 'flow-editor.js'), 'utf8');
const RP = readFileSync(join(PUBLIC, 'js', 'run-panel.js'), 'utf8');
const APP = readFileSync(join(PUBLIC, 'js', 'app.js'), 'utf8');
const CSS = readFileSync(join(PUBLIC, 'css', 'styles.css'), 'utf8');
const I18N_SRC = readFileSync(join(PUBLIC, 'js', 'i18n.js'), 'utf8');
/**
 * Merged declarations of every rule whose selector list mentions BOTH
 * `.ndv-modal.is-designed` (or the selector itself, for the shared primitives)
 * and `sel`. Written as text-merging rather than a real cascade because the
 * point is only "is this declaration stated somewhere for the designed NDV",
 * which is what the G7 contract needs to survive a reorder.
 */
function designedRule(sel: string): string {
  const out: string[] = [];
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('([^{}]*' + esc + '[^{}]*)\\{([^{}]*)\\}', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    const selector = m[1].trim();
    if (!/is-designed/.test(selector)) continue;
    if (!selector.split(',').some((s) => s.trim().endsWith(sel) || s.trim() === sel)) continue;
    out.push(m[2]);
  }
  return out.join(';');
}

/**
 * Merged declarations of every rule that lists `sel` EXACTLY as one of its
 * selectors — the variant-agnostic sibling of `designedRule`, for contracts that
 * are no longer specific to the designed NDV.
 */
function ruleFor(sel: string): string {
  // Comments are stripped FIRST: a prose comment right above a rule ends up in
  // the selector capture (there is no `}` between them), and any comma inside
  // that prose would break the exact-selector match.
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('([^{}]*' + esc + '[^{}]*)\\{([^{}]*)\\}', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (!m[1].split(',').some((s) => s.trim() === sel)) continue;
    out.push(m[2]);
  }
  return out.join(';');
}

/** Load the icon registry in a DOM-free sandbox (icons.js guards on `document`). */
function loadIcons(): any {
  const sandbox: any = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(PUBLIC, 'js', 'icons.js'), 'utf8'), sandbox);
  return sandbox.window.Icons;
}
const Icons = loadIcons();

/** The real action catalog — the single source of truth for palette counts. */
function loadActions(): { actions: any[]; categories: any[] } {
  const sandbox: any = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(PUBLIC, 'js', 'actions.js'), 'utf8'), sandbox);
  const C = sandbox.window.ACTION_CATALOG;
  return { actions: C.ACTIONS, categories: C.CATEGORIES };
}
const CATALOG = loadActions();

/** i18n keys must exist in BOTH dictionaries — see the header note. */
function dictSlices(): { fa: string; en: string } {
  const faAt = I18N_SRC.indexOf('fa: {');
  const enAt = I18N_SRC.indexOf('en: {');
  expect(faAt).toBeGreaterThan(-1);
  expect(enAt).toBeGreaterThan(faAt);
  return { fa: I18N_SRC.slice(faAt, enAt), en: I18N_SRC.slice(enAt) };
}
const DICTS = dictSlices();

function expectKeyInBothDicts(key: string) {
  const needle = `'${key}':`;
  expect(DICTS.fa.includes(needle), `fa is missing "${key}"`).toBe(true);
  expect(DICTS.en.includes(needle), `en is missing "${key}"`).toBe(true);
}

/** Every route `app.js` actually accepts, plus its legacy aliases. */
function realRoutes(): string[] {
  function arr(name: string): string[] {
    const at = APP.indexOf(`var ${name} = [`);
    expect(at, `${name} not found in app.js`).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf('];', at));
    return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }
  const aliasAt = APP.indexOf('var ROUTE_ALIAS = {');
  const aliasBody = APP.slice(aliasAt, APP.indexOf('}', aliasAt));
  const aliases = [...aliasBody.matchAll(/(\w+):/g)].map((m) => m[1]);
  return arr('NAV_ROUTES').concat(arr('DEEP_ROUTES'), aliases);
}
const ROUTES = realRoutes();

// ───────────────────────────────────────────────────────────────────────────
describe('item A — editor top bar', () => {
  const bar = VIEWS.slice(
    VIEWS.indexOf("'<div class=\"fe-topbar\">'"),
    VIEWS.indexOf("'<div class=\"fe-layout\">'")
  );

  it('emits the new shell controls', () => {
    [
      'fe-nav-home', 'fe-nav-ws', 'fe-wftabs', 'fe-undo', 'fe-redo',
      'fe-export-btn', 'fe-export-menu', 'fe-save-btn', 'fe-save-menu',
      'fe-run', 'fe-bell', 'fe-gear', 'fe-avatar',
    ].forEach((id) => {
      expect(bar, `top bar is missing #${id}`).toContain(`id="${id}"`);
    });
  });

  /**
   * The single most breakable thing in the file. See note 1 in the header: the
   * listeners for these ids are unguarded, so a missing id is a TypeError that
   * blanks the editor — not a cosmetic loss.
   */
  it('keeps ALL SIX legacy button ids alive inside the hidden .fe-legacy span', () => {
    const legacy = bar.slice(
      bar.indexOf('class="fe-legacy"'),
      bar.indexOf('</span>', bar.indexOf('id="fe-save-server"'))
    );
    ['fe-from-run', 'fe-load', 'fe-json', 'fe-clear', 'fe-save', 'fe-save-server'].forEach((id) => {
      expect(legacy, `.fe-legacy no longer carries #${id}`).toContain(`id="${id}"`);
    });
    // Hidden, not deleted — and hidden by CSS too, so `hidden` alone being
    // stripped by a stylesheet reset cannot make six blank buttons appear.
    expect(bar).toContain('<span class="fe-legacy" hidden>');
    expect(CSS).toContain('.fe-legacy { display: none !important; }');
  });

  it('routes the nav links to routes that actually exist', () => {
    const hashes = [...bar.matchAll(/data-route="#\/([a-z]*)"/g)].map((m) => m[1]);
    expect(hashes.length).toBeGreaterThan(0);
    hashes.forEach((h) => {
      // '' is `#/` — the home route.
      if (h === '') return;
      expect(ROUTES, `#/${h} is not a real route`).toContain(h);
    });
  });

  /**
   * ONE slot, TWO states. The two reference images disagree about this button
   * because they captured `Test Workflow` and `Stop` — not two buttons.
   */
  it('uses a single Run/Stop slot rather than two buttons', () => {
    expect(bar).toContain('fe-runslot');
    expect(bar).not.toContain('id="fe-stop"');
    expect(CSS).toContain('.fe-runslot.is-stop');
  });

  it('undo/redo enablement is driven by FE, not guessed', () => {
    expect(VIEWS).toMatch(/FE\.canUndo/);
    expect(VIEWS).toMatch(/FE\.canRedo/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('item B — Export / Save split menus', () => {
  it('Export lists the two real actions and disables what does not exist', () => {
    const m = VIEWS.slice(
      VIEWS.indexOf('function renderExportMenu()'),
      VIEWS.indexOf('bindMenu(exportBtn')
    );
    expect(m).toContain("menuItem(t('sh.exportJson')");
    expect(m).toContain("menuItem(t('sh.exportTemplate')");
    // No PDF renderer, no share service, no template registry ships — so these
    // are disabled, never silently no-op.
    ['sh.exportPdf', 'sh.shareLink', 'sh.publishTemplate'].forEach((k) => {
      expect(m).toContain(`t('${k}')`);
    });
    expect((m.match(/disabled: true/g) || []).length).toBe(3);
  });

  it('Save lists REAL versions only, never invented history', () => {
    const m = VIEWS.slice(
      VIEWS.indexOf('function renderSaveMenu()'),
      VIEWS.indexOf('bindMenu(saveMenuBtn')
    );
    // Versions come from the workflow's own `version` field, counting DOWN and
    // stopping at 1 — a v2 workflow shows v2, v1 and nothing else.
    expect(m).toMatch(/cur\.version/);
    expect(m).toMatch(/v\s*-\s*i\s*>\s*0/);
    // With no version there is no history, and the menu says so.
    expect(m).toContain("t('sh.noVersions')");
    expect(m).toContain("data-act=\"autosave\"");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('item C — OUTLINE panel', () => {
  const ol = VIEWS.slice(
    VIEWS.indexOf('function renderOutline()'),
    VIEWS.indexOf('function renderOutline()') + 2600
  );

  /**
   * The tree is DERIVED. Keeping a second copy in the panel is the bug this
   * asserts against: it would drift from the graph the moment a node moved.
   */
  it('derives its rows from FE.outline() and never caches a tree', () => {
    expect(ol).toContain('FE.outline');
    expect(VIEWS).not.toMatch(/outlineTree\s*=\s*/);
    expect(VIEWS).not.toMatch(/setInterval\([^)]*renderOutline/);
  });

  it('stays in sync through FE.onChange, not a poll', () => {
    expect(VIEWS).toMatch(/FE\.onChange\(/);
  });

  it('clicking a row reveals that node on the canvas', () => {
    expect(VIEWS).toMatch(/FE\.revealNode/);
  });

  /**
   * CORRECTED 2026-07-29: both refreshed images put the rail on the START edge,
   * flush against the palette and nearly full height — not the end edge, where
   * it collided with the minimap and the relocated canvas toolbar.
   */
  it('is anchored to the START edge and publishes its width to the canvas', () => {
    const block = CSS.slice(CSS.indexOf('.fe-outline {'), CSS.indexOf('.fe-ol-tab {'));
    expect(block).toMatch(/inset-inline-start:\s*0/);
    expect(block).not.toMatch(/inset-inline-end:/);
    // The rail occupies real width, so start-anchored overlays offset off the
    // variable instead of hardcoding a gap that would drift.
    expect(CSS).toMatch(/--fe-ol-w:\s*236px/);
    expect(CSS).toMatch(/\.fe-canvas\.fe-ol-closed\s*\{\s*--fe-ol-w:\s*26px/);
    expect(CSS).toMatch(/inset-inline-start:\s*calc\(var\(--fe-ol-w/);
    // ...and the JS actually toggles that class, or the variable never changes.
    expect(VIEWS).toContain("olCanvas.classList.toggle('fe-ol-closed', !olOpen)");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('item E — ACTIVITY LOG', () => {
  /**
   * FOUR tabs. `04-HANDOFF` § 6.1 recorded three from the older image; the
   * refreshed `state-empty-canvas.webp` shows four, and the image wins.
   */
  it('has exactly four tabs and opens on Execution', () => {
    expect(RP).toContain("var AL_TABS = ['runs', 'execution', 'variables', 'logs']");
    expect(RP).toContain("var alTab = 'execution'");
    ['al.runs', 'al.execution', 'al.variables', 'al.logs'].forEach(expectKeyInBothDicts);
  });

  it('renders REAL jobs — the Runs table has no mock rows', () => {
    const tbl = RP.slice(
      RP.indexOf('function renderRunsTable()'),
      RP.indexOf('function renderRunsTable()') + 2000
    );
    expect(tbl).toContain('alRuns');
    // An empty list says so rather than showing placeholder rows.
    expect(tbl).toContain("t('al.noRuns')");
    expect(RP).toMatch(/API\(\)\.listJobs|listJobs\(/);
  });

  /**
   * `RunState` deliberately has NO `variables` bag — inventing one would store
   * derived state twice. The truthful source is the graph's `variable` nodes.
   */
  it('derives Variables from the graph, not from an invented state bag', () => {
    expect(RP).toContain('function alVariables()');
    expect(RP).toMatch(/n\.action !== 'variable'/);
    expect(RP).not.toMatch(/state\.variables/);
    ['al.varName', 'al.varValue', 'al.varSource'].forEach(expectKeyInBothDicts);
  });

  /**
   * The tally used to be concatenated into the panel name (`Run — 3 ok / …`).
   * The image shows a static `ACTIVITY LOG` label, so the tally needs its own
   * element or the two fight over one node.
   */
  it('keeps the run tally out of the static title', () => {
    expect(RP).toContain('id="al-counts"');
    expect(RP).toContain('dom.counts.textContent');
  });

  /** A `stop()` that left `phase === 'running'` would latch the top-bar slot. */
  it('stop() forces a terminal phase and notifies subscribers', () => {
    const stop = RP.slice(RP.indexOf('function stop()'), RP.indexOf('function stop()') + 900);
    expect(stop).toMatch(/state\.phase = 'done'/);
    expect(stop).toContain('emitUpdate()');
  });

  it('exposes the shell-facing surface', () => {
    ['getSummary:', 'onUpdate:', 'refreshRuns:', 'showTab:'].forEach((k) => {
      expect(RP, `RunPanel export is missing ${k}`).toContain(k);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('item D — blocks palette', () => {
  const groupsBlock = FE.slice(FE.indexOf('var PALETTE_GROUPS = ['), FE.indexOf('];', FE.indexOf('var PALETTE_GROUPS = [')));
  const groupIds = [...groupsBlock.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);

  /**
   * See note 3 in the header. Six rows, not the image's seven: `General` and
   * `Elements` have no catalog members, and a row with a fake count is worse
   * than no row.
   */
  it('maps rows onto REAL catalog categories only', () => {
    const real = CATALOG.categories.map((c: any) => c.id);
    expect(groupIds.length).toBe(6);
    groupIds.forEach((id) => {
      expect(real, `PALETTE_GROUPS references unknown category "${id}"`).toContain(id);
    });
    // Triggers lead, because that is what a flow starts with.
    expect(groupIds[0]).toBe('trigger');
  });

  it('COMPUTES every count from real members — no number from the mock', () => {
    const list = FE.slice(FE.indexOf('function renderPaletteList()'), FE.indexOf('function applyPaletteCollapsed()'));
    expect(list).toContain('members.length');
    expect(list).toContain('favIds.length');
    // The mock's figures must appear nowhere near the palette code.
    ['128', "'14'", "'18'", "'24'", "'20'", "'22'"].forEach((n) => {
      expect(list, `palette hardcodes the mock count ${n}`).not.toContain(n);
    });
    // An empty category is skipped rather than rendered with a count.
    expect(list).toContain('if (!members.length) return;');
    // ...and a category missing from the table is swept up, not dropped.
    expect(list).toContain('leftovers');
  });

  it('the six rows really do cover all fifty catalog actions', () => {
    const covered = CATALOG.actions.filter((a: any) => groupIds.indexOf(a.cat || 'other') !== -1);
    expect(CATALOG.actions.length).toBe(50);
    expect(covered.length).toBe(50);
  });

  /**
   * Note 2 in the header: an unknown hash does NOT 404, it silently becomes
   * `#/workspace`. So the footer's destinations are checked against the real
   * table, and anything unbacked must be visibly disabled instead.
   */
  it('every footer destination exists — or is disabled with a reason', () => {
    const links = FE.slice(FE.indexOf('var PALETTE_LINKS = ['), FE.indexOf('];', FE.indexOf('var PALETTE_LINKS = [')));
    const hashes = [...links.matchAll(/route:\s*'#\/([a-z]+)/g)].map((m) => m[1]);
    expect(hashes.length).toBeGreaterThan(0);
    hashes.forEach((h) => {
      expect(ROUTES, `palette footer points at non-existent #/${h}`).toContain(h);
    });
    // The invented hashes that used to be here must never come back.
    ['#/templates', '#/browsers', '#/docs', '#/variables'].forEach((bad) => {
      expect(links, `palette footer resurrected the dead route ${bad}`).not.toContain(bad);
    });
    // `Help & Docs` has no view yet, so it renders disabled AND explains why.
    expect(links).toContain("disabled: 'pl.helpSoon'");
    expect(FE).toContain('aria-disabled="true"');
    expect(CSS).toContain('.pl-link:disabled');
  });

  it('deep-links Workspace tabs that actually exist', () => {
    const links = FE.slice(FE.indexOf('var PALETTE_LINKS = ['), FE.indexOf('];', FE.indexOf('var PALETTE_LINKS = [')));
    const tabs = [...links.matchAll(/\?tab=([a-z]+)'/g)].map((m) => m[1]);
    const wsTabs = FE ? [...VIEWS.slice(VIEWS.indexOf('var WS_TABS = ['), VIEWS.indexOf('];', VIEWS.indexOf('var WS_TABS = [')))
      .matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]) : [];
    expect(tabs.length).toBeGreaterThan(0);
    tabs.forEach((tab) => {
      expect(wsTabs, `#/workspace?tab=${tab} is not a real WS_TABS id`).toContain(tab);
    });
    // ...and Workspace must actually honour the query, or the link lands on
    // whatever tab happened to be open last.
    expect(VIEWS).toContain('function applyTabQuery()');
    expect(VIEWS).toMatch(/parseHashQuery\(\)\.tab/);
  });

  /** `Variables` has no route at all — it points at the ACTIVITY LOG tab. */
  it('the Variables entry opens the real panel tab instead of a dead hash', () => {
    expect(FE).toContain("act: 'variables'");
    expect(FE).toContain("RP.showTab('variables')");
    // ...and if the drawer is not mounted it SAYS so rather than doing nothing.
    expect(FE).toContain("t('pl.varsUnavailable')");
  });

  it('search row carries a platform-correct shortcut hint that is wired up', () => {
    expect(FE).toContain('var MOD_KEY');
    expect(FE).toMatch(/Mac\|iPhone\|iPad\|iPod/);
    expect(FE).toContain("searchRow.className = 'palette-searchrow'");
    // The hint would be a lie if the shortcut were not bound.
    expect(FE).toMatch(/ev\.ctrlKey \|\| ev\.metaKey\) && \(ev\.key === 'k'/);
  });

  /**
   * The control that hides the panel must not be the LAST thing in it. It used
   * to sit at the bottom of `.palette-foot`, below five destination links, where
   * a short viewport could push it under the fold. It now shares the search
   * row's line at the very top — same line, so the list lost no height.
   */
  it('the collapse control sits at the top of the palette, not in the footer', () => {
    expect(FE).toContain("head.className = 'palette-head'");
    // The head row is appended before the list, and the button is inside it.
    expect(FE.indexOf("head.className = 'palette-head'"))
      .toBeLessThan(FE.indexOf("listWrap.className = 'palette-list'"));
    expect(FE).toContain("colBtn.className = 'pl-collapse'");
    expect(FE.indexOf("colBtn.className = 'pl-collapse'"))
      .toBeLessThan(FE.indexOf("foot.className = 'palette-foot'"));
    // ...and the footer no longer carries a Collapse link at all.
    expect(FE).not.toContain('data-pl="collapse"');
    // An icon-only control still has to say what it does.
    expect(FE).toContain("colBtn.title = t('pl.collapse')");
    expect(FE).toContain("colBtn.setAttribute('aria-label', t('pl.collapse'))");
    // The glyph points at the edge it hides behind, so it flips in RTL.
    expect(CSS).toMatch(/\[dir="rtl"\] \.pl-collapse > svg\s*\{\s*transform:\s*scaleX\(-1\)/);
  });

  it('favourites persist and the star lives inside the row', () => {
    expect(FE).toContain("var PAL_FAV_KEY = 'ab_palette_favs'");
    expect(FE).toContain('function savePaletteFavs()');
    expect(FE).toContain("class=\"pi-star");
    // Clicking the star must NOT also drop a node on the canvas.
    expect(FE).toContain(".closest('.pi-star')) return;");
  });

  it('styles every class the palette emits', () => {
    [
      '.palette-searchrow', '.ps-ic', '.ps-kbd', '.palette-list',
      '.palette-group-head', '.pg-ic', '.pg-label', '.pg-count', '.pg-caret',
      '.palette-group-body', '.pg-empty', '.pi-star', '.palette-foot',
      '.pl-link', '.pl-link-ic', '.pl-collapse', '.pl-restore',
      '.palette-head', '.fe-layout.fe-pal-collapsed',
    ].forEach((sel) => {
      expect(CSS, `${sel} is emitted but never styled`).toContain(sel);
    });
  });

  /**
   * Collapsing must not reuse `.fe-focus`, which zeroes the column entirely —
   * that would leave no room for the restore chip and strand the user.
   */
  it('the collapsed rail keeps a restore affordance', () => {
    expect(CSS).toMatch(/\.fe-layout\.fe-pal-collapsed\s*\{\s*grid-template-columns:\s*44px 1fr/);
    expect(FE).toContain('function setPaletteCollapsed(');
    expect(FE).toContain("chip.className = 'pl-restore'");
  });

  /**
   * ...and it is an ICON RAIL, not an empty gutter: the reference shell keeps
   * every category glyph reachable while collapsed. A rail with only a restore
   * button forces expand-then-hunt for a one-click destination the design has.
   */
  it('the collapsed rail lists the same real categories as the panel', () => {
    expect(FE).toContain('function paletteRail()');
    expect(FE).toContain("rail.className = 'pl-rail'");
    expect(FE).toContain("b.className = 'pl-rail-btn'");
    // Built from PALETTE_GROUPS, so the rail can never drift from the panel.
    const rail = FE.slice(FE.indexOf('function paletteRail()'), FE.indexOf('function applyPaletteCollapsed()'));
    expect(rail).toContain('PALETTE_GROUPS.forEach');
    // Empty categories are skipped here too, and counts stay computed.
    expect(rail).toContain('if (!members.length) return;');
    expect(rail).toContain('members.length');
    // Icon-only buttons must carry an accessible name.
    expect(rail).toContain('aria-label');
    // Clicking a glyph expands AND opens that row — not just expands. The body
    // moved into `railOpenGroup()` when the rail grew its footer glyphs (G8), so
    // assert the call here and the behaviour on the helper.
    expect(rail).toContain('railOpenGroup(g.id)');
    const openGroup = FE.slice(FE.indexOf('function railOpenGroup('), FE.indexOf('function paletteRail()'));
    expect(openGroup).toContain('paletteOpen[groupId] = true');
    expect(openGroup).toContain('setPaletteCollapsed(false)');
    ['.pl-rail', '.pl-rail-btn'].forEach((sel) => {
      expect(CSS, `${sel} is emitted but never styled`).toContain(sel);
    });
    // Hiding by CSS (not rebuilding) is what preserves the search text.
    expect(CSS).toContain('.fe-layout.fe-pal-collapsed > .fe-palette > *:not(.pl-rail)');
  });

  /**
   * `.palette-item` is a <div> only because it HOSTS the star <button> (nested
   * buttons are invalid HTML). Everything a real <button> supplied has to be
   * re-supplied by hand, or blocks become mouse-only.
   */
  it('a block row is operable by keyboard', () => {
    // The signature grew an `opts` argument when the floating Add Node palette
    // (item H) started reusing this renderer — slice on the name only, so the
    // guard follows the function instead of its argument list.
    const item = FE.slice(FE.indexOf('function paletteItem(a'), FE.indexOf('var ADD_ALL ='));
    expect(item).toContain("item.setAttribute('role', 'button')");
    expect(item).toContain("item.setAttribute('tabindex', '0')");
    // Enter AND Space, because both activate a button.
    expect(item).toMatch(/ev\.key !== 'Enter' && ev\.key !== ' '/);
    // Activation goes through `pick()`, which is `placeNewNode` by default and
    // the caller's `onPick` when the Add Node palette hosts the row.
    expect(item).toContain('pick()');
    expect(item).toContain('placeNewNode(a.id)');
    // Space scrolls the list unless the default is suppressed.
    expect(item).toContain('ev.preventDefault()');
    // Keys pressed while the nested star has focus must not ALSO drop a node.
    expect(item).toContain('if (ev.target !== item) return;');
    // A <div> has no default focus ring, so focus must be styled.
    expect(CSS).toContain('.palette-item:focus-visible');
    // ...and the star has to become VISIBLE when the row is focused, otherwise
    // the next Tab stop is an invisible control.
    expect(CSS).toContain('.palette-item:focus-within .pi-star');
  });
});

// ───────────────────────────────────────────────────────────────────────────
/**
 * The status bar's `Environment` cell used to render a hardcoded
 * `t('sb.envDev')` with a GREEN dot — on a production deployment the bar
 * cheerfully claimed "Development". A read-only telemetry cell that cannot be
 * wrong is the whole point, so its value now comes from `/health` and the wiring
 * is pinned end to end: route -> app.js -> views.js.
 */
describe('status bar — the Environment cell tells the truth', () => {
  const HEALTH = readFileSync(join(ROOT, 'src', 'Routes', 'health.routes.ts'), 'utf8');

  it('the server actually reports env and mode', () => {
    expect(HEALTH).toContain('env: config.NODE_ENV');
    expect(HEALTH).toContain('mode: config.DEPLOYMENT_MODE');
  });

  it('app.js keeps the payload and announces changes', () => {
    expect(APP).toContain('var lastHealth = null');
    expect(APP).toContain("document.dispatchEvent(new CustomEvent('health:change'");
    expect(APP).toMatch(/health: function \(\) \{ return lastHealth; \}/);
    // A failed probe must CLEAR it: a cached `production` badge beside an
    // OFFLINE indicator is worse than no badge.
    const fail = APP.slice(APP.indexOf("setSysIndicator('bad'"), APP.indexOf('function startHealthPolling'));
    expect(fail).toContain('setHealth(null)');
  });

  it('views.js renders the reported value, or an explicit dash', () => {
    const cell = VIEWS.slice(VIEWS.indexOf('function environmentCell()'), VIEWS.indexOf('function refreshStatusBar()'));
    expect(cell.length).toBeGreaterThan(100);
    expect(cell).toContain('U().health()');
    // unknown -> a dash and a NEUTRAL dot, never a green guess
    expect(cell).toMatch(/statusCell\(t\('sb\.environment'\), '—', 'idle'\)/);
    // green only for a real production report
    expect(cell).toContain("env.toLowerCase() === 'production' ? 'good' : 'idle'");
    // an unmapped env name is printed verbatim rather than guessed at
    expect(cell).toContain('key ? t(key) : env');
    // the old hardcode must never come back
    const bar = VIEWS.slice(VIEWS.indexOf('function statusCell('), VIEWS.indexOf('function refreshWfLabel()'));
    expect(bar).not.toMatch(/statusCell\(t\('sb\.environment'\), t\('sb\.envDev'\)/);
    // ...and the cell has to follow the 10s poll, without leaking a listener
    expect(VIEWS).toContain("onDoc('health:change', refreshStatusBar)");
  });

  it('never renders the mock version string from the preview image', () => {
    // `Version 1.3.7` in the reference is a mock; the real value is the open
    // workflow's version, and `unsaved` when there is none. The figure may
    // appear in a COMMENT (it documents the image's reading order) but never as
    // a string literal that could reach the DOM.
    expect(VIEWS.replace(/^\s*\/\/.*$/gm, '')).not.toContain('1.3.7');
    expect(VIEWS).toContain("cur && cur.version ? 'v' + cur.version : t('sb.unsaved')");
  });

  it('every sb.* key exists in both dictionaries', () => {
    // Three shapes: `t('sb.x')`, the `t(cond ? 'sb.on' : 'sb.off')` ternary, and
    // the ENV_LABEL table, whose values are bare key strings.
    const keys = new Set<string>([...VIEWS.matchAll(/'(sb\.[A-Za-z]+)'/g)].map((m) => m[1]));
    expect(keys.size).toBeGreaterThanOrEqual(12);
    keys.forEach(expectKeyInBothDicts);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('standing contracts', () => {
  it('every icon the shell names resolves in the registry', () => {
    const names = new Set<string>();
    [VIEWS, FE, RP].forEach((src) => {
      [...src.matchAll(/\bIC?\(\s*'([a-z0-9-]+)'/g)].forEach((m) => names.add(m[1]));
      [...src.matchAll(/\bRIC\(\s*'([a-z0-9-]+)'/g)].forEach((m) => names.add(m[1]));
    });
    expect(names.size).toBeGreaterThan(20);
    names.forEach((n) => {
      // A missing name silently renders the invisible `dot` fallback, so this is
      // the only place a typo can be caught.
      expect(Icons.has ? Icons.has(n) : !!Icons.svg(n), `icon "${n}" is not in the registry`).toBe(true);
    });
  });

  it('every pl.* key exists in both dictionaries', () => {
    // Two shapes to collect: rendered directly as `t('pl.x')`, and referenced
    // indirectly from the PALETTE_LINKS table (`key:` / `disabled:`) where the
    // literal never appears next to a `t(` call.
    const keys = new Set<string>([
      ...[...FE.matchAll(/t\('(pl\.[A-Za-z]+)'\)/g)].map((m) => m[1]),
      ...[...FE.matchAll(/(?:key|disabled):\s*'(pl\.[A-Za-z]+)'/g)].map((m) => m[1]),
    ]);
    expect(keys.size).toBeGreaterThanOrEqual(13);
    keys.forEach(expectKeyInBothDicts);
  });

  it('every sh.* key the top bar renders exists in both dictionaries', () => {
    const keys = new Set<string>([...VIEWS.matchAll(/t\('(sh\.[A-Za-z]+)'\)/g)].map((m) => m[1]));
    expect(keys.size).toBeGreaterThan(15);
    keys.forEach(expectKeyInBothDicts);
  });

  /**
   * Chrome/view flags are NOT document state: they must never be serialised
   * into a workflow or captured by an undo snapshot.
   */
  it('keeps palette view flags off `state`', () => {
    ['paletteFavs', 'paletteOpen', 'paletteCollapsed'].forEach((f) => {
      expect(FE, `${f} leaked onto state`).not.toContain(`state.${f}`);
      expect(FE).toMatch(new RegExp(`var ${f}\\b`));
    });
  });

  it('ships no emoji in the front-end shell code', () => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    [['views.js', VIEWS], ['flow-editor.js', FE], ['run-panel.js', RP]].forEach(([name, src]) => {
      // Comments are prose for maintainers; only EMITTED strings matter. Both
      // block comments and line comments are stripped — including TRAILING ones
      // (`var x = 1; // a 📌 note`), which an anchored `^\s*//` misses. A `//`
      // inside a string literal is not a concern here: this codebase writes no
      // URLs in the front-end shell files.
      const code = (src as string)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect(EMOJI.test(code), `${name} emits an emoji`).toBe(false);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Handoff 11 § 5 items — G4 breadcrumb, G6 dock default, G1 palette row names,
// G8 the full collapsed rail, G13 the brand mark.
// ───────────────────────────────────────────────────────────────────────────
describe('shell parity items G4 / G6 / G1 / G8 / G13', () => {
  /**
   * G4. NO locked image has a second bar row — the canvas starts immediately
   * under the top bar — so the hairline breadcrumb is hidden. It must still be
   * IN the DOM: `#fe-wf-label` / `#fe-wf-badge` are written unconditionally by
   * `refreshWfLabel()`, and the six `.fe-legacy` ids have unguarded listeners,
   * so deleting the row throws mid-render and blanks the editor.
   */
  it('G4 hides the breadcrumb row without removing it', () => {
    expect(VIEWS).toContain('class="fe-crumbline" id="fe-crumbline" hidden');
    // The base rule sets display:flex, which BEATS the UA `[hidden]` rule, so
    // the attribute selector is what actually hides it.
    expect(CSS).toMatch(/\.fe-crumbline\[hidden\]\s*\{\s*display:\s*none/);
    // Still emitted, still written to.
    ['fe-wf-label', 'fe-wf-badge'].forEach((id) => {
      expect(VIEWS).toContain(`id="${id}"`);
    });
    ['fe-from-run', 'fe-load', 'fe-json', 'fe-clear', 'fe-save', 'fe-save-server'].forEach((id) => {
      expect(VIEWS, `${id} disappeared with the breadcrumb row`).toContain(`id="${id}"`);
    });
    expect(VIEWS).toContain('class="fe-legacy" hidden');
  });

  /**
   * G6. The refreshed `state-empty-canvas.webp` shows the ACTIVITY LOG OPEN on
   * `Execution`. It is a preference, not a constant: the drawer is unmounted and
   * remounted on every editor mount, so a collapse that is not persisted silently
   * reverts on the next route change.
   */
  it('G6 opens the ACTIVITY LOG by default and remembers a collapse', () => {
    expect(RP).toContain("var DOCK_PREF = 'feDockOpen'");
    expect(RP).toMatch(/dockPref\(true\)\s*\)\s*open\(false\);\s*else\s*close\(false\)/);
    // Persisted through the ONE namespaced prefs blob, like the palette/OUTLINE.
    expect(RP).toContain('u.setPref(DOCK_PREF');
    expect(APP).toContain("var PREFS_KEY = 'ab_ui_prefs'");
    // The restore pass must not be recorded as a fresh user choice.
    expect(RP).toContain('if (remember !== false) rememberDock(true)');
    expect(RP).toContain('if (remember !== false) rememberDock(false)');
    // Four tabs, opening on Execution — unchanged, pinned here so a later edit
    // cannot quietly drop back to three.
    expect(RP).toContain("var AL_TABS = ['runs', 'execution', 'variables', 'logs']");
    expect(RP).toContain("var alTab = 'execution'");
  });

  /**
   * ...and an open dock must be charged to the fit, or `fitToScreen` parks the
   * tail of a chain behind it. The drawer is a body-level fixed singleton, so the
   * in-canvas overlay query cannot see it.
   */
  it('G6 keeps fitToScreen honest about the open dock', () => {
    const insets = FE.slice(FE.indexOf('function canvasInsets('), FE.indexOf('function fitToScreen('));
    expect(insets).toContain("document.getElementById('run-panel')");
    expect(insets).toContain('ins.bottom = Math.max(ins.bottom');
    // Measured, never hard-coded: a literal 46vh here would go stale the moment
    // the CSS changes.
    expect(insets).toContain('dock.getBoundingClientRect()');
  });

  /**
   * G1. The palette adopts the image's row vocabulary (Triggers / Browser / Web
   * Interaction / Flow Control / Online Services / Data) while every count stays
   * computed from real catalog members. ONE helper, so the expanded list, the
   * collapsed rail and the Add Node palette cannot drift apart.
   */
  it('G1 renders the design row names with real counts', () => {
    expect(FE).toContain('function paletteGroupLabel(g, cat)');
    const PG = ['pg.triggers', 'pg.browser', 'pg.webInteraction', 'pg.flowControl',
      'pg.onlineServices', 'pg.data'];
    PG.forEach((k) => {
      expect(FE, `${k} is not wired into PALETTE_GROUPS`).toContain(`label: '${k}'`);
      expectKeyInBothDicts(k);
    });
    // Exactly six rows, one per real category — no invented `General` /
    // `Elements` rows, which have no catalog members at all.
    const groups = FE.slice(FE.indexOf('var PALETTE_GROUPS = ['), FE.indexOf('function paletteGroupLabel('));
    expect([...groups.matchAll(/label: 'pg\./g)]).toHaveLength(6);
    const catIds = new Set(CATALOG.categories.map((c: any) => c.id));
    [...groups.matchAll(/\{ id: '([a-z]+)'/g)].forEach((m) => {
      expect(catIds.has(m[1]), `PALETTE_GROUPS row "${m[1]}" is not a real category`).toBe(true);
    });
    // Counts still come from members, never from a literal.
    expect(FE).toContain("name: paletteGroupLabel(g, cat) + ' · ' + members.length");
    // And the design's mock totals must never be pasted back in. Comments are
    // stripped first: the mock's `128 blocks` is DOCUMENTED in the source as the
    // number we deliberately do not ship, and that prose must stay readable.
    const code = FE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ['128 blocks', 'count: 128', 'count: 24', 'count: 12,'].forEach((lit) => {
      expect(code.includes(lit), `invented palette count ${lit}`).toBe(false);
    });
  });

  /**
   * G8. The collapsed rail is the full glyph column the image shows — the
   * expander FIRST, then Favorites, the six real groups and the five footer
   * destinations — built from the same two tables as the expanded panel.
   *
   * The expander moved from the bottom edge to the top on 2026-07-31, together
   * with the collapse button in the expanded panel: the two halves of one toggle
   * now occupy the same corner instead of trading places across the full height
   * of the panel every time it is used.
   */
  it('G8 builds the full collapsed rail from real surfaces', () => {
    const rail = FE.slice(FE.indexOf('function railBtn('), FE.indexOf('function applyPaletteCollapsed()'));
    expect(rail).toContain("icon: 'star'");                 // Favorites
    expect(rail).toContain('PALETTE_GROUPS.forEach');       // the six groups
    expect(rail).toContain('PALETTE_LINKS.forEach');        // the five links
    expect(rail).toContain("rail.className = 'pl-rail'");
    // The expander is appended BEFORE Favorites, i.e. it is the first glyph.
    expect(rail.indexOf("chip.className = 'pl-restore'")).toBeLessThan(rail.indexOf("icon: 'star'"));
    // Favorites count is the real number of starred blocks.
    expect(rail).toContain('ACTIONS.filter(function (a) { return paletteFavs[a.id]; }).length');
    // A disabled destination stays disabled AND explained in the rail too.
    expect(rail).toContain('disabled: !!l.disabled');
    expect(rail).toContain("t(l.key) + ' — ' + t(l.disabled)");
    // Icon-only controls need names, and the new classes need styling.
    expect(rail).toContain("b.setAttribute('aria-label', opts.name)");
    ['.pl-rail-sep', '.pl-rail-link', '.pl-rail-btn[disabled]'].forEach((sel) => {
      expect(CSS, `${sel} is emitted but never styled`).toContain(sel);
    });
    // The expander sits at the TOP of the column, separated from the glyphs it
    // is not one of, and the rail is narrow enough to be worth collapsing to.
    expect(CSS).not.toMatch(/\.pl-rail > \.pl-restore\s*\{\s*margin-block-start:\s*auto/);
    expect(CSS).toMatch(/\.pl-rail > \.pl-restore::after\s*\{/);
    expect(CSS).toMatch(/\.fe-layout\.fe-pal-collapsed\s*\{\s*grid-template-columns:\s*44px/);
    // Twelve glyphs + the expander = the image's thirteen.
    const groupRows = CATALOG.categories.filter((c: any) =>
      CATALOG.actions.some((a: any) => (a.cat || 'other') === c.id)).length;
    const links = [...FE.matchAll(/\{ key: 'pl\.[A-Za-z]+',/g)].length;
    expect(1 + groupRows + links + 1).toBe(13);
  });

  /**
   * G13. The brand mark is the product's own glyph, traced from the 1672px
   * locked image: two facing arcs around a ringed pupil. Not a letter in a tile,
   * and not `zap` (which the palette already uses for the Triggers category).
   */
  it('G13 ships a real brand mark in both shells', () => {
    expect(Icons.has ? Icons.has('aria-mark') : !!Icons.svg('aria-mark')).toBe(true);
    const svg = Icons.svg('aria-mark', { size: 22 });
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="none"');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);   // colour comes from CSS
    // Editor shell: the glyph replaced the invented orange tile with a letter.
    expect(VIEWS).toContain("IC('aria-mark', 22)");
    expect(VIEWS).not.toContain('<span class="fe-brand-mark">A</span>');
    expect(CSS).not.toMatch(/\.fe-brand-mark\s*\{[^}]*background:\s*var\(--primary\)/);
    // App shell sidebar uses the same mark.
    const HTML = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    expect(HTML).toContain('data-icon="aria-mark"');
    expect(HTML).not.toContain('class="brand-logo" data-icon="zap"');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G10 — the fa/RTL render pass. Its finding was not a layout bug: 38 `fa`
// entries carried the ENGLISH string, so the whole editor chrome rendered in
// English inside an RTL frame. The both-dicts test cannot see this (the keys
// exist), and `t()` cannot either (it returns what the dictionary holds), so
// only a render or this guard catches it.
// ───────────────────────────────────────────────────────────────────────────
describe('G10 fa/RTL localisation of the editor chrome', () => {
  const PERSIAN = /[\u0600-\u06FF]/;
  /**
   * `pl.shortcut` is the `K` of `Ctrl K` — a key cap, not a word. Anything else
   * added here needs a reason written next to it.
   */
  const LATIN_BY_DESIGN = new Set(['pl.shortcut']);

  it('ships no English-only value for the shell chrome keys', () => {
    const faEntries = [...DICTS.fa.matchAll(/'((?:al|ol|pl|sh)\.[A-Za-z0-9]+)':\s*'([^']*)'/g)];
    expect(faEntries.length).toBeGreaterThan(60);
    const leaks = faEntries
      .filter(([, key, val]) => val && !LATIN_BY_DESIGN.has(key) && !PERSIAN.test(val))
      .map(([, key, val]) => `${key} = "${val}"`);
    expect(leaks, `untranslated fa values:\n  ${leaks.join('\n  ')}`).toEqual([]);
  });

  /** ...and the English dictionary must not have been Persian-ised by mistake. */
  it('keeps the en dictionary in English', () => {
    const enEntries = [...DICTS.en.matchAll(/'((?:al|ol|pl|sh)\.[A-Za-z0-9]+)':\s*'([^']*)'/g)];
    const wrong = enEntries.filter(([, , val]) => PERSIAN.test(val)).map(([, key]) => key);
    expect(wrong).toEqual([]);
  });

  /** The one-shot patch scripts stay in `tools/` — they are not counted JS. */
  it('records how the dictionaries were patched', () => {
    const tools = readFileSync(join(ROOT, 'tools', 'patch-fa-shell-i18n.py'), 'utf8');
    // The ZWNJ placeholder convention is the part a future session must not lose.
    expect(tools).toContain("ZWNJ = '\\u200c'");
    expect(tools).toContain("newline=''");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Handoff 11 § 5 item G10 — the 980 px render pass.
//
// The pass surfaced two real defects, and both were CSS-only, so both are
// guarded by parsing the stylesheet rather than by eyeballing a PNG:
//
//   1. `.fe-zoom-ctrl` and `.fe-canvas-toolbar` are the SAME element. Two
//      separate `max-width: 980px` blocks docked it to opposite corners, so all
//      FOUR insets resolved (`50px/12px/12px/12px`) and the absolutely
//      positioned box stretched to 932x358. It is opaque (`--bg-elev`) at
//      `z-index: 5`; the node layer is `z-index: 2`. Result: a canvas that
//      rendered as an empty grid with all seven nodes hidden underneath.
//
//   2. `.fe-palette` is a height-capped flex column at 980 px. The cap left
//      `.palette-list` a computed height of ZERO against ~2400 px of content,
//      and the narrow-viewport override set `overflow: visible`, so the list
//      painted its rows straight over the footer links.
// ───────────────────────────────────────────────────────────────────────────
describe('G10 — the 980 px narrow-viewport render pass', () => {
  /** Brace-matched body of every `@media (max-width: 980px)` block, in order. */
  function mediaBlocks980(): string[] {
    const out: string[] = [];
    const re = /@media\s*\(max-width:\s*980px\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(CSS))) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < CSS.length && depth > 0) {
        if (CSS[i] === '{') depth++;
        else if (CSS[i] === '}') depth--;
        i++;
      }
      out.push(CSS.slice(start, i - 1));
    }
    return out;
  }

  /**
   * Declarations that `sel` collects across every 980 px block, merged in
   * document order so the LAST declaration wins — which is what the cascade
   * does at equal specificity, and the reason defect 1 was invisible when
   * reading either block on its own.
   */
  function decls980(sel: string): Record<string, string> {
    const merged: Record<string, string> = {};
    mediaBlocks980().forEach((body) => {
      const src = body.replace(/\/\*[\s\S]*?\*\//g, '');
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const hit = m[1]
          .split(',')
          .map((s) => s.trim().replace(/\s+/g, ' '))
          .some((s) => s === sel);
        if (!hit) continue;
        m[2].split(';').forEach((d) => {
          const i = d.indexOf(':');
          if (i < 0) return;
          merged[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        });
      }
    });
    return merged;
  }

  it('finds the narrow-viewport blocks it is asserting against', () => {
    // If the media query is ever reworded (`980px` -> a token, say) every
    // assertion below would vacuously pass, so prove the parse found something.
    expect(mediaBlocks980().length).toBeGreaterThanOrEqual(2);
  });

  /**
   * The invariant, stated positively: the bar is docked by ONE block inset and
   * ONE inline inset. Both members of the opposing pair must be absent or
   * `auto` — never a length.
   */
  it('never resolves all four insets on the canvas toolbar', () => {
    ['.fe-zoom-ctrl', '.fe-canvas-toolbar'].forEach((sel) => {
      const d = decls980(sel);
      const blockPair = ['inset-block-start', 'inset-block-end'];
      const inlinePair = ['inset-inline-start', 'inset-inline-end'];
      [blockPair, inlinePair].forEach((pair) => {
        const lengths = pair.filter((p) => d[p] && d[p] !== 'auto');
        expect(
          lengths.length,
          `${sel} resolves BOTH of ${pair.join(' + ')} to a length ` +
            `(${lengths.map((p) => `${p}: ${d[p]}`).join(', ')}) — the box will ` +
            'stretch and paint over the nodes',
        ).toBeLessThan(2);
      });
    });
  });

  /** The same contract restated where the docking is defined, so it is findable. */
  it('pins the opposing inset pair to `auto` on the base rule', () => {
    const base = CSS.slice(CSS.indexOf('.fe-zoom-ctrl,\n.fe-canvas-toolbar {'));
    const body = base.slice(0, base.indexOf('}'));
    expect(body).toContain('inset-block-end: auto');
    expect(body).toContain('inset-inline-start: auto');
    // ...and the reason, so nobody "tidies" the two autos away again.
    expect(CSS).toContain('CONTRACT: this bar is docked by exactly TWO insets');
  });

  /**
   * The palette keeps its base contract at 980 px: the LIST is the only
   * scroller. `overflow: visible` on a flex child that the cap has starved to
   * zero height is what let it paint over the footer.
   */
  it('keeps the palette list scrolling, never `visible`, at 980 px', () => {
    const list = decls980('.palette-list');
    expect(list['overflow']).not.toBe('visible');
    expect(list['overflow-y']).toBe('auto');
    // A floor so flex can never resolve the list to zero height again.
    const floor = parseInt(list['min-height'] || '0', 10);
    expect(floor, 'the list needs a min-height floor at 980px').toBeGreaterThan(0);

    const pal = decls980('.fe-palette');
    expect(pal['overflow'], 'the panel must not become the scroller').toBe('hidden');
    const cap = parseInt(pal['max-height'] || '0', 10);
    // The cap has to clear the list floor plus the 32px search row plus a
    // one-row footer, or the footer is pushed out of the panel again.
    expect(cap, `max-height ${cap}px cannot hold a ${floor}px list + chrome`).toBeGreaterThanOrEqual(floor + 120);
  });

  /**
   * Five stacked destination links are 170px tall — taller than the whole panel
   * is allowed to be at 980px. They wrap into a row instead, which is only
   * possible if `.pl-link`'s default `width: 100%` is released.
   */
  it('lays the palette footer out as a wrapping row at 980 px', () => {
    const foot = decls980('.palette-foot');
    expect(foot['flex-direction']).toBe('row');
    expect(foot['flex-wrap']).toBe('wrap');
    const link = decls980('.palette-foot > .pl-link');
    expect(link['width'], '`.pl-link` is width:100% by default — one link per line').toBe('auto');
  });

  /**
   * The stale rule that caused defect 1 must not come back. It is named
   * explicitly because a future session reading only the first media block
   * would think re-docking the bar bottom-start is a harmless improvement.
   */
  it('does not re-dock the toolbar bottom-start on narrow viewports', () => {
    mediaBlocks980().forEach((body) => {
      expect(body.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
        /\.fe-zoom-ctrl[^{}]*\{[^{}]*inset-block-end:\s*\d/,
      );
    });
  });
});

describe('G7 — Node Detail View (NDV)', () => {
  /* ==========================================================================
   * reachability + the fixed-height / per-column scroll contract
   * ======================================================================= */
    const NDV_UI = readFileSync(join(PUBLIC, 'js', 'ndv-ui.js'), 'utf8');
    const NDV_NODES = readFileSync(join(PUBLIC, 'js', 'ndv-nodes.js'), 'utf8');

    it('repaints selection in place instead of rebuilding every card', () => {
      // THE BUG THIS PINS: `selectNode` used to call `renderNodes()`, which wipes
      // and rebuilds every `.flow-node`. A `dblclick` is only dispatched when
      // both clicks share ONE target, so the first click destroyed the element
      // the mouse had just pressed and the documented "double-click a node to
      // open its NDV" gesture could never fire — measured, after one synthetic
      // click: document.body.contains(card) === false.
      expect(FE).toMatch(/function applySelectionPaint\(/);
      const fn = FE.slice(FE.indexOf('function selectNode('));
      const body = fn.slice(0, fn.indexOf('\n  }'));
      expect(body).toMatch(/if \(!applySelectionPaint\(\)\) renderNodes\(\);/);
      // ...and it must NOT call renderNodes unconditionally any more.
      expect(body).not.toMatch(/^\s*renderNodes\(\);/m);
    });

    it('keeps the in-place paint and the selection tools in step', () => {
      // The group boundary + floating toolbar are also a function of the
      // selection; `renderNodes` used to be the only thing refreshing them.
      const fn = FE.slice(FE.indexOf('function applySelectionPaint('));
      const body = fn.slice(0, fn.indexOf('\n  }'));
      expect(body).toMatch(/renderSelectionTools\(\)/);
      // It must bail out (never paint a stale DOM) when the graph disagrees.
      expect(body).toMatch(/cards\.length !== Object\.keys\(state\.nodes\)\.length/);
      expect(body).toMatch(/return false/);
    });

    it('does not leave the designed NDV body as the single scroller', () => {
      // MEASURED: `.ndv-body` was the only `overflow: auto` in the chain, so the
      // grid row stretched to its tallest child (1118px of centre sections) in a
      // 757px body and the whole modal scrolled as one — the column heads
      // scrolled away, `.aria-col-body` never scrolled, and the OUTPUT status
      // strip sat ~300px below the modal's bottom edge.
      const rule = designedRule('.ndv-body');
      expect(rule).toMatch(/overflow:\s*hidden/);
      expect(rule).toMatch(/display:\s*flex/);
      expect(rule).toMatch(/min-height:\s*0/);
    });

    /**
     * The fixed height used to belong to `.ndv-modal.is-designed` alone, which
     * is precisely why the modal resized when you moved between a designed node
     * and a generic one. It is now ONE rule on `.ndv-modal` — 80% of the
     * viewport in both axes, for every node — so the columns can place fixed
     * heads and a pinned OUTPUT strip against a height that never depends on
     * which node is open, and the designed variant has nothing to override.
     */
    it('sizes every NDV at 80% of the viewport, designed or not', () => {
      const base = ruleFor('.ndv-modal');
      expect(base).toMatch(/(^|\s)width:\s*80vw/);
      expect(base).toMatch(/(^|\s)height:\s*80vh/);
      expect(base).toMatch(/max-height:\s*80vh/);
      // No per-variant size may reintroduce the jump.
      const designed = designedRule('.ndv-modal.is-designed');
      expect(designed).not.toMatch(/(^|\s)width:\s*min\(/);
      expect(designed).not.toMatch(/(^|\s)height:\s*min\(/);
    });

    /**
     * ...and the generic path gets the SAME fixed-height contract the designed
     * one already had, otherwise an 80vh modal would simply mean 80vh of one
     * outer scroller with the INPUT / Parameters / OUTPUT heads sliding away.
     */
    it('gives undesigned NDVs per-column scrolling and pinned heads', () => {
      const body = ruleFor('.ndv-modal:not(.is-designed) .ndv-body');
      expect(body).toMatch(/overflow:\s*hidden/);
      expect(body).toMatch(/min-height:\s*0/);
      expect(ruleFor('.ndv-modal:not(.is-designed) .ndv')).toMatch(/min-height:\s*0/);
      const cols = ruleFor('.ndv-modal:not(.is-designed) .ndv-cols');
      expect(cols).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
      const col = ruleFor('.ndv-modal:not(.is-designed) .ndv-col');
      expect(col).toMatch(/overflow:\s*auto/);
      expect(col).toMatch(/min-height:\s*0/);
      expect(ruleFor('.ndv-modal:not(.is-designed) .ndv-col-head'))
        .toMatch(/position:\s*sticky/);
    });

    it('completes the min-height:0 chain down to the scrollers', () => {
      // A percentage height only survives if EVERY flex/grid ancestor opts out
      // of the default `min-height: auto` / `auto` grid row.
      expect(designedRule('.ndv')).toMatch(/min-height:\s*0/);
      const cols = designedRule('.ndv-cols');
      expect(cols).toMatch(/min-height:\s*0/);
      expect(cols).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
      expect(designedRule('.ndv-col')).toMatch(/min-height:\s*0/);
      // the centre column's own scroller
      const pane = designedRule('.ndv-pane');
      expect(pane).toMatch(/overflow:\s*auto/);
      expect(pane).toMatch(/gap:\s*0/);
      // INPUT / OUTPUT keep theirs
      expect(CSS).toMatch(/\.aria-col-body\s*\{[^}]*overflow:\s*auto/);
    });

    it('stacks the centre sections as one bordered band group, not gapped cards', () => {
      // Read off the 1:1 crop of ndv-click-element-final.webp: a single hairline
      // BETWEEN neighbours, no gap, radius only on the two ends.
      expect(designedRule('.aria-sec')).toMatch(/border-radius:\s*0/);
      const adj = designedRule('.aria-sec + .aria-sec');
      expect(adj).toMatch(/margin-top:\s*0/);
      expect(adj).toMatch(/border-top:\s*0/);
    });

    it('offers an inline field cell and uses it for the packed numerics', () => {
      // Label-above-control made Timeout / Stable for / Offset X|Y 48px rows
      // where the preview shows ~26px — the largest single source of overflow.
      expect(NDV_UI).toMatch(/o\.inline \? ' is-inline' : ''/);
      expect(CSS).toMatch(/\.aria-cell\.is-inline\s*\{/);
      // every numeric that shares a grid row with toggles must opt in
      ['p.timeout', 'click.stableFor', 'click.offsetX', 'click.offsetY'].forEach((key) => {
        const at = NDV_NODES.indexOf("t('" + key + "')");
        expect(at, key).toBeGreaterThan(-1);
        expect(NDV_NODES.slice(at, at + 320), key).toMatch(/inline:\s*true/);
      });
    });

    it('lays Click options out 4-up, as the preview does', () => {
      expect(NDV_NODES).toMatch(/ui\.section\(t\('click\.secClickOptions'\), 4\)/);
      expect(CSS).toMatch(/\.aria-sec-body\.cols-4\s*\{[^}]*repeat\(4,\s*1fr\)/);
      // and it must still collapse on narrow viewports
      expect(CSS).toMatch(/cols-4[^{}]*\{\s*grid-template-columns:\s*1fr 1fr/);
    });

    it('puts Continue on fail outside the Behavior card, writing to errorPolicy', () => {
      expect(NDV_NODES).toMatch(/aria-footrow/);
      const at = NDV_NODES.indexOf('aria-footrow');
      expect(NDV_NODES.slice(at, at + 600)).toMatch(/node\.errorPolicy\.continueOnFail = v === true/);
    });

    it('scopes the NDV validation strip to the node being edited', () => {
      // A whole-GRAPH "Graph is valid" band inside a single-node editor is not
      // information about that node, and the locked preview has no such row.
      expect(FE).toMatch(/function appendValidation\(box, onlyNodeId\)/);
      expect(FE).toMatch(/appendValidation\(body, designed \? node\.id : null\)/);
    });

    it('has the new help string in BOTH dictionaries, translated', () => {
      const { fa, en } = DICTS;
      expect(fa).toMatch(/'help\.timeoutMs':/);
      expect(en).toMatch(/'help\.timeoutMs':/);
      const faVal = /'help\.timeoutMs':\s*'([^']*)'/.exec(fa)![1];
    expect(faVal).not.toMatch(/^[\x20-\x7E]+$/); // must not be an English value in `fa`
  });
});
