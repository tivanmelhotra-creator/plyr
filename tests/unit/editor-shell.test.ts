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
      '.fe-layout.fe-pal-collapsed',
    ].forEach((sel) => {
      expect(CSS, `${sel} is emitted but never styled`).toContain(sel);
    });
  });

  /**
   * Collapsing must not reuse `.fe-focus`, which zeroes the column entirely —
   * that would leave no room for the restore chip and strand the user.
   */
  it('the collapsed rail keeps a restore affordance', () => {
    expect(CSS).toMatch(/\.fe-layout\.fe-pal-collapsed\s*\{\s*grid-template-columns:\s*64px 1fr/);
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
    // Clicking a glyph expands AND opens that row — not just expands.
    expect(rail).toContain('paletteOpen[g.id] = true');
    expect(rail).toContain('setPaletteCollapsed(false)');
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
    const item = FE.slice(FE.indexOf('function paletteItem(a)'), FE.indexOf('var PALETTE_GROUPS = ['));
    expect(item).toContain("item.setAttribute('role', 'button')");
    expect(item).toContain("item.setAttribute('tabindex', '0')");
    // Enter AND Space, because both activate a button.
    expect(item).toMatch(/ev\.key !== 'Enter' && ev\.key !== ' '/);
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
