/**
 * workspace-ui.test.ts — regression guard for the locked UI-architecture
 * change (docs/uiux/workspace-overview.md + shell-editor-launcher-menu.md).
 *
 * WHAT THIS PROTECTS
 * ------------------
 * The whole point of the change is *subtractive*: the sidebar shrank from ten
 * entries to six, and four of the removed ones (`Live View`, `Live Browser`,
 * `Schedules`, `Active Flow`) became per-workflow capabilities. Subtractive
 * changes are the easiest kind to undo by accident — someone adds "just one
 * more" nav link and the architecture is gone with no failing test.
 *
 * So these tests assert, without a DOM:
 *
 *   1. NAV SHAPE — index.html has EXACTLY the six locked routes in the locked
 *      order, and none of the retired ones;
 *   2. LAUNCHER — the header carries the launcher button + panel with the same
 *      six items and the documented a11y contract;
 *   3. WORKSPACE — the seven stat cards in the order LOCKED BY THE IMAGE, the
 *      eight table columns, the three-state Live-Browser rule, the ⋮ menu;
 *   4. CONTRACTS — every i18n key the new views render exists in BOTH
 *      dictionaries, every icon name resolves in the registry (a typo silently
 *      renders the invisible `dot` fallback), every CSS class the JS emits is
 *      actually styled, and the toggles go through PATCH (never PUT, which
 *      would bump the workflow version).
 *
 * views.js / app.js are DOM-bound IIFEs, so they are asserted at the source
 * level — the same approach as canvas-chrome.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');

const HTML = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const VIEWS = readFileSync(join(PUBLIC, 'js', 'views.js'), 'utf8');
const APP = readFileSync(join(PUBLIC, 'js', 'app.js'), 'utf8');
const API_JS = readFileSync(join(PUBLIC, 'js', 'api.js'), 'utf8');
const CSS = readFileSync(join(PUBLIC, 'css', 'styles.css'), 'utf8');
const I18N_SRC = readFileSync(join(PUBLIC, 'js', 'i18n.js'), 'utf8');

/** The six product areas, in the locked order. */
const NAV = ['home', 'workspace', 'dashboard', 'jobs', 'admin', 'settings'];

/** Retired from the chrome — they are per-workflow capabilities now. */
const RETIRED = ['live', 'browser', 'schedules', 'run', 'workflows', 'editor', 'quota'];

/** Load the icon registry in a DOM-free sandbox (icons.js guards on `document`). */
function loadIcons(): any {
  const sandbox: any = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(PUBLIC, 'js', 'icons.js'), 'utf8'), sandbox);
  return sandbox.window.Icons;
}

/** Load i18n.js with the minimal browser shims it touches at module scope. */
function loadI18n(): any {
  const sandbox: any = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => undefined },
    document: {
      documentElement: { setAttribute: () => undefined, lang: '', dir: '' },
      addEventListener: () => undefined,
      dispatchEvent: () => undefined,
      querySelectorAll: () => [],
    },
    CustomEvent: function () { /* stub */ },
  };
  vm.createContext(sandbox);
  vm.runInContext(I18N_SRC, sandbox);
  return sandbox.window.I18N;
}

const Icons = loadIcons();
const I18N = loadI18n();

/**
 * Keys must exist in BOTH dictionaries. `t()` falls back to English, so a
 * missing Persian entry is invisible at runtime — only a source-level check
 * catches it.
 */
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

// ───────────────────────────────────────────────────────────────────────────
describe('sidebar — exactly the six locked product areas', () => {
  const navBlock = HTML.slice(
    HTML.indexOf('<nav class="sidebar-nav">'),
    HTML.indexOf('</nav>')
  );
  const routes = [...navBlock.matchAll(/data-route="([a-z]+)"/g)].map((m) => m[1]);

  it('has six entries, in the locked order', () => {
    expect(routes).toEqual(NAV);
  });

  it('drops every retired entry (the whole point of the change)', () => {
    for (const r of RETIRED) {
      expect(routes, `"${r}" is a per-workflow capability, not a nav entry`).not.toContain(r);
    }
  });

  it('each entry links to its own hash route and carries a real icon', () => {
    for (const r of NAV) {
      expect(navBlock, `#/${r} link`).toContain(`href="#/${r}"`);
    }
    const icons = [...navBlock.matchAll(/data-icon="([a-z-]+)"/g)].map((m) => m[1]);
    expect(icons).toHaveLength(6);
    for (const name of icons) {
      expect(Icons.has(name), `sidebar icon "${name}"`).toBe(true);
    }
  });

  it('uses the icons named by the spec (§ 3A)', () => {
    // Re-read off the locked images: `Workspace` is four EQUAL squares (`grid`,
    // the launcher glyph), `Jobs` is a briefcase and `Admin` is a shield with a
    // check — the earlier `layout` / `layers` / `shield` set was a guess.
    for (const [route, icon] of Object.entries({
      home: 'home', workspace: 'grid', dashboard: 'bar-chart',
      jobs: 'briefcase', admin: 'shield-check', settings: 'settings',
    })) {
      const row = navBlock.slice(navBlock.indexOf(`data-route="${route}"`));
      expect(row.slice(0, 200), `${route} -> ${icon}`).toContain(`data-icon="${icon}"`);
    }
  });

  it('every nav label is translated in both dictionaries', () => {
    for (const r of NAV) expectKeyInBothDicts(`nav.${r}`);
  });
});

describe('app launcher — the header replacement for nav links', () => {
  it('renders one button with the documented a11y contract', () => {
    expect(HTML).toContain('id="launcher-btn"');
    expect(HTML).toContain('aria-haspopup="menu"');
    expect(HTML).toMatch(/id="launcher-btn"[\s\S]{0,400}aria-expanded="false"/);
    expect(HTML).toMatch(/id="launcher-btn"[\s\S]{0,400}aria-controls="launcher-menu"/);
    // 2x2 grid glyph, Windows-11 style
    expect(HTML).toMatch(/id="launcher-btn"[\s\S]{0,400}data-icon="grid"/);
  });

  it('renders the panel as a real role="menu", initially hidden', () => {
    const panel = HTML.slice(
      HTML.indexOf('id="launcher-menu"'),
      HTML.indexOf('</header>')
    );
    expect(panel).toContain('role="menu"');
    expect(panel).toContain('hidden');
    const items = [...panel.matchAll(/role="menuitem" data-route="([a-z]+)"/g)].map((m) => m[1]);
    // Same six areas, same order as the sidebar — it is the same architecture.
    expect(items).toEqual(NAV);
  });

  it('the header carries NO navigation links (that was the defect)', () => {
    const header = HTML.slice(HTML.indexOf('<header class="topbar">'), HTML.indexOf('</header>'));
    // Any `<a href="#/...">` in the header would be a nav link sneaking back in.
    expect(header).not.toMatch(/<a\s[^>]*href="#\//);
  });

  it('implements the full keyboard model in app.js', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) {
      expect(APP, `launcher key "${key}"`).toContain(`'${key}'`);
    }
    // Esc restores focus to the button; outside click and blur also close.
    expect(APP).toMatch(/closeLauncher\(true\)/);
    expect(APP).toMatch(/window\.addEventListener\('blur'/);
  });

  it('closes on route change and marks the current area', () => {
    expect(APP).toContain('markLauncherCurrent(area)');
    expect(APP).toMatch(/closeLauncher\(\);\s*\n\s*removeOverlay\(\)/);
    expect(APP).toContain("setAttribute('aria-current', 'page')");
  });

  it('styles the open state as the spec describes (orange + glow ring)', () => {
    const open = CSS.slice(CSS.indexOf('.launcher-btn.open'));
    expect(open.slice(0, 220)).toContain('var(--primary)');
    expect(open.slice(0, 220)).toContain('rgba(255, 138, 31, 0.18)');
  });

  /* The locked panel (docs/uiux/shell-editor-launcher-menu.webp, re-checked
     against the zoomed crop the reviewer sent) fixes three things this panel
     used to get wrong: the glyph per route, the glyph SIZE, and an open state
     that filled the button orange instead of ringing it. */
  it('uses the locked glyph for every route, at the locked 20px size', () => {
    const panel = HTML.slice(HTML.indexOf('id="launcher-menu"'), HTML.indexOf('</header>'));
    const want: Record<string, string> = {
      home: 'home',
      workspace: 'grid',        // four EQUAL squares, like the launcher button
      dashboard: 'bar-chart',
      jobs: 'briefcase',        // was `layers` — the image shows a briefcase
      admin: 'shield-check',    // was a plain shield — the image has a check
      settings: 'settings',
    };
    NAV.forEach((route) => {
      const row = panel.slice(panel.indexOf(`data-route="${route}"`));
      const m = row.slice(0, 220).match(/data-icon="([a-z-]+)" data-icon-size="(\d+)"/);
      expect(m, `launcher row "${route}" declares an icon + size`).toBeTruthy();
      expect(m![1], `launcher glyph for "${route}"`).toBe(want[route]);
      expect(m![2], `launcher glyph size for "${route}"`).toBe('20');
      expect(Icons.has(m![1]), `registry has "${m![1]}"`).toBe(true);
    });
  });

  it('the sidebar and the launcher agree glyph-for-glyph (one architecture)', () => {
    const nav = HTML.slice(HTML.indexOf('<nav class="sidebar-nav">'), HTML.indexOf('</nav>'));
    const panel = HTML.slice(HTML.indexOf('id="launcher-menu"'), HTML.indexOf('</header>'));
    NAV.forEach((route) => {
      const inNav = nav.slice(nav.indexOf(`data-route="${route}"`)).slice(0, 200)
        .match(/data-icon="([a-z-]+)"/);
      const inPanel = panel.slice(panel.indexOf(`data-route="${route}"`)).slice(0, 220)
        .match(/data-icon="([a-z-]+)"/);
      expect(inNav, `sidebar row "${route}"`).toBeTruthy();
      expect(inPanel![1], `glyph drift for "${route}"`).toBe(inNav![1]);
    });
  });

  it('the open button is RINGED, not filled (the glyph must stay readable)', () => {
    const open = CSS.slice(CSS.indexOf('.launcher-btn.open'), CSS.indexOf('.launcher-menu {'));
    // A solid orange fill inverted the glyph to near-black and lost the 2x2 grid.
    expect(open).not.toMatch(/background:\s*var\(--primary\)/);
    expect(open).toContain('background: var(--bg-elev-2)');
    expect(open).toContain('color: var(--text)');
    // The ring is a box-shadow so opening the panel cannot resize the button.
    expect(open).toMatch(/box-shadow:[^;]*1\.5px var\(--primary\)/);
    expect(open).not.toMatch(/border:\s*[^;]*var\(--primary\)/);
  });

  it('has the row geometry the panel image shows', () => {
    const item = CSS.slice(CSS.indexOf('.launcher-item {'), CSS.indexOf('.launcher-item:hover'));
    expect(item).toContain('height: 40px');
    expect(item).toContain('gap: 12px');
    expect(item).toMatch(/font: 500 14px/);
  });
});

/**
 * ONE product name. The locked sidebar reads "Aria Automate" next to the logo
 * mark, and the editor shell already used `fe.brand` for exactly that string —
 * so the old `app.title` ("Automation Backend") made the same shell introduce
 * itself under two names depending on which screen you were on.
 */
describe('brand — the shell has a single product name', () => {
  it('index.html falls back to the locked name', () => {
    expect(HTML).toMatch(/data-i18n="app\.title">Aria Automate</);
    expect(HTML).not.toContain('Automation Backend');
  });

  it('both dictionaries carry it, and it matches the editor brand', () => {
    // The sandbox has no stored language, so `t()` resolves through `fa`.
    expect(I18N.t('app.title')).toBe(I18N.t('fe.brand'));
    const en = I18N_SRC.slice(I18N_SRC.indexOf('    en: {'));
    expect(en).toContain("'app.title': 'Aria Automate'");
    expect(en).toContain("'fe.brand': 'Aria Automate'");
    expect(I18N_SRC).not.toContain('Automation Backend');
  });
});

describe('router — the six areas plus addressable deep routes', () => {
  it('declares the six nav routes explicitly', () => {
    expect(APP).toMatch(/var NAV_ROUTES = \['home', 'workspace', 'dashboard', 'jobs', 'admin', 'settings'\]/);
  });

  it('keeps the retired screens reachable rather than deleting them', () => {
    // Removing a nav ENTRY must not remove a working feature: the views are
    // still routable, they are just opened from a workflow instead.
    for (const r of ['workflows', 'editor', 'live', 'browser', 'schedules', 'quota']) {
      expect(APP, `deep route "${r}"`).toContain(`'${r}'`);
    }
  });

  it('highlights the parent area for a deep route', () => {
    expect(APP).toContain('ROUTE_PARENT');
    expect(APP).toMatch(/editor:\s*'workspace'/);
    expect(APP).toMatch(/quota:\s*'settings'/);
    expect(APP).toContain("var area = ROUTE_PARENT[route] || route;");
  });

  it('strips the query string so `#/jobs?job=…` still resolves', () => {
    expect(APP).toContain("var q = hash.indexOf('?');");
  });

  it('lands on Workspace, the hub, rather than a dead default', () => {
    expect(APP).toMatch(/var DEFAULT_ROUTE = 'workspace'/);
  });
});

describe('Workspace — the seven stat cards', () => {
  const block = VIEWS.slice(VIEWS.indexOf('var WS_CARDS'), VIEWS.indexOf('var WS_TABS'));
  const keys = [...block.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);

  it('renders seven cards in the order LOCKED BY THE IMAGE', () => {
    // The written report lists Total Flows first; the approved image puts
    // Active Schedules first. The image is the artefact that was signed off.
    expect(keys).toEqual([
      'activeSchedules', 'totalFlows', 'activeFlows', 'successRate',
      'failures', 'activeJobs', 'liveBrowsers',
    ]);
  });

  it('uses the tones and icons the spec tables (§ 3D)', () => {
    const expected: Record<string, [string, string]> = {
      activeSchedules: ['calendar', 'violet'],
      totalFlows: ['sitemap', 'blue'],
      activeFlows: ['check-circle', 'green'],
      successRate: ['target', 'green'],
      failures: ['alert-triangle', 'red'],
      activeJobs: ['briefcase', 'amber'],
      liveBrowsers: ['globe', 'blue'],
    };
    for (const [key, [icon, tone]] of Object.entries(expected)) {
      const row = block.slice(block.indexOf(`key: '${key}'`));
      expect(row.slice(0, 200), `${key} icon`).toContain(`icon: '${icon}'`);
      expect(row.slice(0, 200), `${key} tone`).toContain(`tone: '${tone}'`);
      expect(Icons.has(icon), `card icon "${icon}"`).toBe(true);
    }
  });

  it('titles and sub-labels exist in both dictionaries', () => {
    for (const k of keys) {
      expectKeyInBothDicts(`ws.card.${k}`);
      expectKeyInBothDicts(`ws.sub.${k}`);
    }
  });

  it('lays the row out as seven equal columns that collapse gracefully', () => {
    const cards = CSS.slice(CSS.indexOf('.ws-cards {'));
    expect(cards.slice(0, 200)).toContain('repeat(7, minmax(0, 1fr))');
    expect(CSS).toContain('@media (max-width: 1280px) { .ws-cards');
    expect(CSS).toContain('@media (max-width: 900px) { .ws-cards');
  });

  it('renders an em dash rather than 0 when a counter is unknown', () => {
    // 0 is a claim ("nothing failed"); unknown is not the same statement.
    expect(VIEWS).toMatch(/raw == null \? '—'/);
  });
});

describe('Workspace — the workflow table', () => {
  it('renders the eight locked columns, in order', () => {
    expect(VIEWS).toContain(
      "var cols = ['workflow', 'owner', 'lastRun', 'successRate', 'status', 'liveBrowser', 'schedules', 'actions'];"
    );
    for (const c of ['workflow', 'owner', 'lastRun', 'successRate', 'status', 'liveBrowser', 'schedules', 'actions']) {
      expectKeyInBothDicts(`ws.col.${c}`);
    }
  });

  it('is a real table with scoped headers (a11y § 8)', () => {
    expect(VIEWS).toContain('<th scope="col">');
    expect(VIEWS).toContain('<table class="ws-table">');
  });

  it('tints the success-rate fill by the documented thresholds', () => {
    const fn = VIEWS.slice(VIEWS.indexOf('function wsSuccessTone'), VIEWS.indexOf('function wsSuccessTone') + 320);
    expect(fn).toContain('pct >= 95');
    expect(fn).toContain('pct >= 80');
    expect(fn).toContain("return 'red'");
    // null (nothing ran yet) must not be painted as a failure
    expect(fn).toMatch(/pct == null\) return 'muted'/);
  });

  it('the five tabs are declared and translated', () => {
    for (const tab of ['workflows', 'templates', 'executions', 'schedules', 'connections']) {
      expect(VIEWS, `tab "${tab}"`).toContain(`id: '${tab}'`);
      expectKeyInBothDicts(`ws.tab.${tab}`);
    }
  });

  it('paginates with the documented footer', () => {
    expectKeyInBothDicts('ws.showing');
    expectKeyInBothDicts('ws.perPage');
    expect(VIEWS).toContain('[10, 25, 50, 100]');
    expect(CSS).toContain('.ws-page-btn.active');
  });
});

describe('Live Browser × Active — the three locked states (§ 4)', () => {
  const cell = VIEWS.slice(VIEWS.indexOf('function liveCell'), VIEWS.indexOf('function ownerCell'));

  it('the eye is watchable only when the flow is active AND streaming is on', () => {
    expect(cell).toContain('var watchable = active && on;');
  });

  it('state 2: an ON toggle on an INACTIVE flow renders gray, not orange', () => {
    // The intent is remembered, but nothing runs, so the accent colour would
    // be a lie about there being a live session.
    expect(cell).toContain("(on && !active ? ' muted-on' : '')");
    expect(CSS).toContain('.ws-switch.muted-on');
  });

  it('states 2 and 3: the eye is disabled but keeps its explanatory tooltip', () => {
    expect(cell).toContain('aria-disabled="true"');
    expect(cell).toMatch(/title="' \+ esc\(tip\)/);
    expect(CSS).toContain('.ws-eye.disabled');
    expect(CSS).toContain('cursor: not-allowed');
  });

  it('swaps to the eye-off glyph when nothing can be watched', () => {
    expect(cell).toContain("IC(watchable ? 'eye' : 'eye-off', 15)");
    expect(Icons.has('eye-off')).toBe(true);
  });

  it('explains WHY the eye is disabled, differently per cause', () => {
    expectKeyInBothDicts('ws.watchDisabledInactive');
    expectKeyInBothDicts('ws.watchDisabledOff');
    expectKeyInBothDicts('ws.watchBrowser');
  });

  it('the click handler re-checks the rule instead of trusting the markup', () => {
    expect(VIEWS).toMatch(/if \(wf\.active === false \|\| wf\.liveBrowser !== true\)/);
  });

  it('both switches are real role="switch" buttons with aria-checked', () => {
    expect(VIEWS).toMatch(/role="switch" aria-checked="/);
    expect(VIEWS).toMatch(/role="switch"\s*'?\s*\+?/);
    const sw = CSS.slice(CSS.indexOf('.ws-switch {'));
    expect(sw.slice(0, 260)).toContain('width: 36px'); // 36x20 per § 3F
    expect(sw.slice(0, 260)).toContain('height: 20px');
  });
});

describe('per-workflow ⋮ menu — the entries the sidebar gave up', () => {
  const block = VIEWS.slice(VIEWS.indexOf('var WS_ROW_MENU'), VIEWS.indexOf('var wsState'));
  const ids = [...block.matchAll(/id: '(\w+)'/g)].map((m) => m[1]);

  it('lists the eight locked actions plus Delete, in order', () => {
    expect(ids).toEqual([
      'editor', 'live', 'schedules', 'executions',
      'connections', 'settings', 'duplicate', 'export', 'delete',
    ]);
  });

  it('every menu icon resolves in the registry', () => {
    for (const m of block.matchAll(/icon: '([a-z-]+)'/g)) {
      expect(Icons.has(m[1]), `menu icon "${m[1]}"`).toBe(true);
    }
  });

  it('every menu label is translated in both dictionaries', () => {
    // Label keys are not always the entry id ('editor' -> 'ws.menu.openEditor'),
    // so read the keys the source actually declares instead of deriving them.
    const labels = [...block.matchAll(/label: '([\w.]+)'/g)].map((m) => m[1]);
    expect(labels).toHaveLength(ids.length);
    for (const key of labels) {
      expect(key.startsWith('ws.menu.'), `menu label "${key}" must live under ws.menu.*`).toBe(true);
      expectKeyInBothDicts(key);
    }
  });

  it('disables Live Browser in the menu under the same rule as the eye', () => {
    expect(VIEWS).toMatch(
      /var dis = m\.id === 'live' && !\(wf\.active !== false && wf\.liveBrowser === true\)/
    );
  });

  it('marks Delete as destructive and separates it', () => {
    expect(block).toContain('danger: true');
    expect(CSS).toContain('.ws-row-menu button.danger');
  });
});

describe('toggles go through PATCH, never PUT', () => {
  it('api.js exposes a PATCH verb and the state helper', () => {
    expect(API_JS).toContain("method: 'PATCH'");
    expect(API_JS).toContain('function setWorkflowState(');
    expect(API_JS).toMatch(/setWorkflowState: setWorkflowState/);
    expect(API_JS).toContain("'/state'");
  });

  it('the state helper targets the toggle-only endpoint', () => {
    expect(API_JS).toMatch(/patch\(wfBase\(userId\) \+ '\/' \+ encodeURIComponent\(workflowId\) \+ '\/state'/);
  });

  it('the Workspace view uses setWorkflowState (a PUT would bump the version)', () => {
    expect(VIEWS).toContain('API.setWorkflowState(uid, id, patch)');
    const setState = VIEWS.slice(VIEWS.indexOf('function setState(id, patch, btn)'));
    expect(setState.slice(0, 1200)).not.toContain('updateWorkflow');
  });

  it('reads the aggregate stats endpoint in one call', () => {
    expect(API_JS).toContain('function workspaceStats(');
    expect(API_JS).toMatch(/'\/workspace\/' \+ encodeURIComponent\(userId\) \+ '\/stats'/);
    expect(VIEWS).toContain('API.workspaceStats(uid)');
  });

  it('degrades to list-only counters if the stats endpoint fails', () => {
    // The cards must never block the table: a workflow list alone can already
    // prove Total Flows and Active Flows.
    expect(VIEWS).toMatch(/API\.workspaceStats\(uid\)\.catch\(function \(\) \{ return null; \}\)/);
  });
});

describe('Workspace / Home / Settings — style + i18n completeness', () => {
  /** Every `ws.*` / `home.*` / `settings.*` key the two modules render. */
  const referenced = new Set<string>();
  for (const src of [VIEWS, APP]) {
    for (const m of src.matchAll(/t\('((?:ws|home|settings)\.[\w.]+)'\)/g)) referenced.add(m[1]);
  }

  it('references a meaningful number of new keys (sanity)', () => {
    expect(referenced.size).toBeGreaterThanOrEqual(40);
  });

  it('every referenced key exists in BOTH dictionaries', () => {
    const missing: string[] = [];
    for (const k of referenced) {
      const needle = `'${k}':`;
      if (!DICTS.fa.includes(needle)) missing.push(`fa: ${k}`);
      if (!DICTS.en.includes(needle)) missing.push(`en: ${k}`);
    }
    expect(missing, 'untranslated keys').toEqual([]);
  });

  it('every referenced key actually resolves through t() at runtime', () => {
    const unresolved = [...referenced].filter((k) => I18N.t(k) === k);
    expect(unresolved, 'keys returning themselves').toEqual([]);
  });

  it('every CSS class the views emit is styled', () => {
    const classes = new Set<string>();
    for (const src of [VIEWS, APP]) {
      for (const m of src.matchAll(/class="((?:ws|home|split|page)-[a-z-]+)/g)) classes.add(m[1]);
    }
    const unstyled = [...classes].filter((c) => !CSS.includes('.' + c));
    expect(unstyled, 'classes with no CSS rule').toEqual([]);
  });

  it('every icon the new views draw resolves in the registry', () => {
    const names = new Set<string>();
    for (const src of [VIEWS, APP]) {
      for (const m of src.matchAll(/\b(?:IC|ICN)\(\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
    }
    const missing = [...names].filter((n) => !Icons.has(n));
    expect(missing, 'unregistered icon names').toEqual([]);
  });

  it('Workspace and Settings are wired into the view router', () => {
    expect(VIEWS).toContain("case 'workspace': return renderWorkspace(root);");
    expect(VIEWS).toContain("case 'settings': return renderSettings(root);");
  });

  it('Home is a set of doors, not a second dashboard', () => {
    // Duplicating operational data on a landing page is how landing pages rot.
    const tiles = APP.slice(APP.indexOf('var HOME_TILES'), APP.indexOf('function renderHome'));
    const routes = [...tiles.matchAll(/route: '(\w+)'/g)].map((m) => m[1]);
    expect(routes).toEqual(['workspace', 'dashboard', 'jobs', 'admin', 'settings']);
  });
});
