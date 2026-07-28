/**
 * canvas-chrome.test.ts — regression guard for the canvas chrome added as
 * items F + G of the docs/uiux gap list.
 *
 * F. The minimap grew a real titled header ("MINIMAP") with its own
 *    zoom-out / zoom-in / fit buttons and a close [x] that collapses the
 *    widget to a restore chip.
 * G. The bottom-start corner became a floating toolbar: pointer tools
 *    (select / pan / lock / grid), the zoom cluster ([-] 100% [+] fit) and
 *    the view actions (fullscreen, Auto Layout, Focus Mode).
 *
 * flow-editor.js is a DOM-bound IIFE, so it cannot be instantiated in a
 * `{ window: {} }` sandbox the way ndv-model / graph-serialize are. These
 * tests therefore assert the two things that are actually verifiable without
 * a DOM, and that are exactly where regressions have historically crept in:
 *
 *   1. STRUCTURE — the markup/handlers/bindings the previews require are all
 *      present in the source, every advertised i18n key exists in BOTH
 *      dictionaries, and every icon name resolves in the registry (a typo'd
 *      name silently renders the `dot` fallback, which is invisible in review);
 *   2. CONTRACTS — the chrome flags must never leak into the serialized graph,
 *      the CSS the JS toggles must actually exist, and Auto Layout must reuse
 *      the serializer's single layout implementation instead of a second one.
 *
 * Behavioural verification (real geometry, aria-pressed transitions, the
 * Focus-Mode width change and the Auto-Layout no-overlap/on-grid result) was
 * done in a browser against a static server; the outcome is recorded in
 * HANDOFF_2026-07-27_ICONS_LAYOUT.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const FE = readFileSync(join(ROOT, 'public', 'js', 'flow-editor.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
const I18N_SRC = readFileSync(join(ROOT, 'public', 'js', 'i18n.js'), 'utf8');

/** Load the icon registry in a DOM-free sandbox (icons.js guards on `document`). */
function loadIcons(): any {
  const sandbox: any = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'public', 'js', 'icons.js'), 'utf8'), sandbox);
  return sandbox.window.Icons;
}

/**
 * Load i18n.js with the minimum browser shims it touches at module scope
 * (localStorage + a document stub), then return both dictionaries via t().
 */
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

/** Every i18n key the new chrome renders. */
const CHROME_KEYS = [
  'fe.canvasTools', 'fe.minimap', 'fe.minimapHide', 'fe.minimapShow',
  'fe.zoomReset', 'fe.toolSelect', 'fe.toolPan', 'fe.toolLock',
  'fe.toolLockOff', 'fe.toolFrame', 'fe.autoLayout', 'fe.autoLayoutHint',
  'fe.focusMode', 'fe.focusModeHint', 'fe.fullscreen',
];

describe('canvas chrome — item G: floating toolbar', () => {
  it('renders one toolbar with an accessible role and label', () => {
    expect(FE).toContain("'fe-zoom-ctrl fe-canvas-toolbar'");
    expect(FE).toContain("ctrl.setAttribute('role', 'toolbar')");
    expect(FE).toMatch(/setAttribute\('aria-label',\s*esc\(t\('fe\.canvasTools'\)\)\)/);
  });

  it('exposes all four pointer tools, each with an initial aria-pressed state', () => {
    for (const tool of ['select', 'pan', 'lock', 'grid']) {
      expect(FE, `tool "${tool}"`).toContain(`data-tool="${tool}"`);
    }
    // select + grid start on, pan + lock start off
    expect(FE).toMatch(/data-tool="select"\s+aria-pressed="true"/);
    expect(FE).toMatch(/data-tool="pan"\s+aria-pressed="false"/);
    expect(FE).toMatch(/data-tool="lock"\s+aria-pressed="false"/);
    expect(FE).toMatch(/data-tool="grid"\s+aria-pressed="true"/);
  });

  it('exposes the full zoom cluster including the reset affordance', () => {
    for (const z of ['out', 'in', 'fit', 'reset']) {
      expect(FE, `zoom action "${z}"`).toContain(`data-z="${z}"`);
    }
    // the "100%" pill IS the reset button, so it must be a real <button>
    expect(FE).toMatch(/<button class="fe-zoom-label" data-z="reset"/);
  });

  it('exposes the three view actions', () => {
    for (const v of ['fullscreen', 'autolayout', 'focus']) {
      expect(FE, `view action "${v}"`).toContain(`data-view="${v}"`);
    }
  });

  it('binds each control group by attribute, not by shared class', () => {
    // .fe-zbtn is reused by the zoom cluster AND a view action, so binding by
    // class alone would cross-wire them. Guard the attribute selectors.
    expect(FE).toContain("ctrl.querySelectorAll('[data-z]')");
    expect(FE).toContain("ctrl.querySelectorAll('.fe-tool')");
    expect(FE).toContain("ctrl.querySelectorAll('[data-view]')");
  });

  it('stops mousedown on every control so the canvas pan handler cannot fire', () => {
    // one guard per bound group (zoom, tools, view, minimap buttons, chip)
    const guards = FE.match(/addEventListener\('mousedown', function \(ev\) \{ ev\.stopPropagation\(\); \}\)/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps Shift+drag box-selecting even while the Pan tool is active', () => {
    // The pan tool must not trap the user out of making a selection: the
    // shiftKey branch has to be evaluated BEFORE any tool check.
    const mdIdx = FE.indexOf("on(dom.canvas, 'mousedown'");
    expect(mdIdx).toBeGreaterThan(-1);
    const body = FE.slice(mdIdx, mdIdx + 900);
    expect(body).toContain('ev.shiftKey');
    expect(body).toMatch(/type: 'box'/);
  });

  it('maps the advertised V / H shortcuts to the tools, without eating Ctrl+V', () => {
    expect(FE).toMatch(/!meta && \(ev\.key === 'v' \|\| ev\.key === 'V'\)/);
    expect(FE).toMatch(/!meta && \(ev\.key === 'h' \|\| ev\.key === 'H'\)/);
    expect(FE).toContain("setTool('select')");
    expect(FE).toContain("setTool('pan')");
    // the paste shortcut must still be guarded on meta and come first
    expect(FE.indexOf("meta && (ev.key === 'v'")).toBeLessThan(
      FE.indexOf("!meta && (ev.key === 'v'"));
  });
});

describe('canvas chrome — item F: minimap header', () => {
  it('wraps the minimap body in a titled header container', () => {
    expect(FE).toContain("'fe-minimap-wrap'");
    expect(FE).toContain('fe-mm-head');
    expect(FE).toContain('fe-mm-title');
    expect(FE).toContain("t('fe.minimap')");
    // the body must still exist and be queried out of the wrapper
    expect(FE).toContain("wrap.querySelector('.fe-minimap')");
  });

  it('offers zoom-out / zoom-in / fit / close in the header', () => {
    for (const a of ['out', 'in', 'fit', 'close']) {
      expect(FE, `minimap action "${a}"`).toContain(`data-mm="${a}"`);
    }
  });

  it('collapses to a restore chip instead of vanishing', () => {
    expect(FE).toContain('fe-mm-restore');
    expect(FE).toContain("setMinimapOpen(false)");
    expect(FE).toContain("setMinimapOpen(true)");
    // the chip starts hidden and the two are mutually exclusive
    expect(FE).toContain("chip.setAttribute('hidden', 'hidden')");
    expect(FE).toMatch(/dom\.minimapWrap\.hidden = !minimapOpen/);
    expect(FE).toMatch(/dom\.minimapRestore\.hidden = minimapOpen/);
  });

  it('re-renders the minimap when it is reopened', () => {
    // reopening a stale widget would show the pre-collapse graph
    const idx = FE.indexOf('function setMinimapOpen');
    expect(idx).toBeGreaterThan(-1);
    expect(FE.slice(idx, idx + 400)).toContain('renderMinimap()');
  });

  it('sweeps the whole widget on re-mount, not just the body', () => {
    // .fe-minimap is now nested, so cleaning only that selector would leave
    // the wrapper and the chip behind, stacking one per re-mount.
    const idx = FE.indexOf('var stale = refs.canvas.querySelectorAll');
    expect(idx).toBeGreaterThan(-1);
    const sweep = FE.slice(idx, idx + 300);
    for (const cls of ['.fe-canvas-toolbar', '.fe-minimap-wrap', '.fe-mm-restore']) {
      expect(sweep, `sweep must include ${cls}`).toContain(cls);
    }
  });
});

describe('canvas chrome — behaviour contracts', () => {
  it('keeps chrome flags OUT of the serialized graph', () => {
    // These are workspace preferences, not graph data. If they were stored on
    // `state` they would reach saveLocal()/serialize() and the steps[] shape.
    for (const flag of ['canvasTool', 'canvasLocked', 'gridVisible', 'minimapOpen']) {
      expect(FE, `${flag} must be a module-level var`).toMatch(
        new RegExp(`^\\s*var ${flag} = `, 'm'));
      expect(FE, `${flag} must never be read off state`).not.toContain(`state.${flag}`);
    }
  });

  it('canvas lock freezes geometry only — selection still works', () => {
    const idx = FE.indexOf('if (canvasLocked) return;');
    expect(idx).toBeGreaterThan(-1);
    // selectNode() must run BEFORE the lock bail-out, so a locked canvas can
    // still be inspected and its NDV opened.
    const before = FE.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain('selectNode(node.id)');
  });

  it('Auto Layout reuses the serializer layout rather than a second one', () => {
    const idx = FE.indexOf('function autoLayout');
    expect(idx).toBeGreaterThan(-1);
    const body = FE.slice(idx, FE.indexOf('function toggleFocusMode'));
    expect(body).toContain('toSteps()');
    expect(body).toContain('stepsToGraph');
    // it must not hand-roll its own column/row constants
    expect(body).not.toMatch(/COL_W|ROW_H|ORIGIN_X/);
    // and it must re-render + persist the result
    expect(body).toContain('renderAll()');
    expect(body).toContain('saveLocal()');
  });

  it('Auto Layout preserves nodes unreachable from start', () => {
    const idx = FE.indexOf('function autoLayout');
    const body = FE.slice(idx, FE.indexOf('function toggleFocusMode'));
    // stepsToGraph() only sees the chain from `start`, so orphans must be
    // re-attached explicitly or the operation would silently delete them.
    expect(body).toContain('orphans');
    expect(body).toMatch(/reachable/);
    expect(body).toMatch(/state\.nodes\[n\.id\] = n/);
  });

  it('Auto Layout keeps re-parked orphans on the 20px grid', () => {
    const idx = FE.indexOf('function autoLayout');
    const body = FE.slice(idx, FE.indexOf('function toggleFocusMode'));
    expect(body).toMatch(/n\.x = snap\(ox\); n\.y = oy/);
    expect(body).toMatch(/var oy = snap\(/);
  });

  it('fullscreen degrades gracefully where the API is unavailable', () => {
    const idx = FE.indexOf('function toggleFullscreen');
    expect(idx).toBeGreaterThan(-1);
    const body = FE.slice(idx, idx + 700);
    expect(body).toContain('try {');
    // requestFullscreen() returns a promise that rejects in sandboxed iframes
    expect(body).toMatch(/typeof p\.catch === 'function'/);
  });

  it('syncChrome() keeps aria-pressed and the lock tooltip honest', () => {
    const idx = FE.indexOf('function syncChrome');
    expect(idx).toBeGreaterThan(-1);
    const body = FE.slice(idx, FE.indexOf('function setMinimapOpen'));
    expect(body).toContain("setAttribute('aria-pressed'");
    expect(body).toContain("classList.toggle('is-active'");
    expect(body).toMatch(/fe\.toolLockOff.*fe\.toolLock|canvasLocked \? 'fe\.toolLockOff' : 'fe\.toolLock'/);
    // and it must run on mount so the DOM matches the flags from the start
    expect(FE).toMatch(/attachCanvasHandlers\(\);\s*\n\s*syncChrome\(\);/);
  });

  it('Focus Mode re-renders the minimap because the canvas box changed', () => {
    const idx = FE.indexOf('function toggleFocusMode');
    const body = FE.slice(idx, FE.indexOf('function toggleFullscreen'));
    expect(body).toContain("classList.toggle('fe-focus'");
    expect(body).toContain('renderMinimap()');
  });
});

describe('canvas chrome — i18n and icon coverage', () => {
  it('every chrome label exists in BOTH dictionaries (no key fallthrough)', () => {
    const I18N = loadI18n();
    for (const k of CHROME_KEYS) {
      I18N.setLang('en');
      const en = I18N.t(k);
      I18N.setLang('fa');
      const fa = I18N.t(k);
      expect(en, `en missing ${k}`).not.toBe(k);
      expect(fa, `fa missing ${k}`).not.toBe(k);
      // a fa value identical to en means the fa entry is missing and t() fell
      // back to the en table
      expect(fa, `fa fell back to en for ${k}`).not.toBe(en);
    }
    I18N.setLang('en');
  });

  it('every icon the chrome asks for resolves to a real icon', () => {
    const Icons = loadIcons();
    // names passed to IC(...) inside buildOverlay + the restore chip
    const used = ['mouse-pointer-2', 'hand', 'lock', 'frame', 'minus', 'plus',
      'maximize', 'layout', 'target', 'map', 'x'];
    const dot = Icons.svg('dot', { size: 16 });
    for (const n of used) {
      expect(Icons.has(n), `icon "${n}" is not registered`).toBe(true);
      expect(Icons.svg(n, { size: 16 }), `icon "${n}" fell back to dot`).not.toBe(dot);
    }
  });

  it('the toolbar/minimap icon names in source are all registered', () => {
    const Icons = loadIcons();
    // scan only the overlay builder so unrelated call sites cannot mask a typo
    const start = FE.indexOf('function buildOverlay');
    const end = FE.indexOf('function setTool');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = FE.slice(start, end);
    const names = new Set<string>();
    const re = /IC\('([a-z0-9-]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(region)) !== null) names.add(m[1]);
    expect(names.size).toBeGreaterThanOrEqual(10);
    for (const n of names) {
      expect(Icons.has(n), `buildOverlay references unregistered icon "${n}"`).toBe(true);
    }
  });
});

describe('canvas chrome — the CSS the JS toggles actually exists', () => {
  it('ships a rule for every class the JS adds to the canvas', () => {
    for (const sel of ['.fe-canvas.fe-tool-pan', '.fe-canvas.fe-locked',
      '.fe-canvas.fe-nogrid', '.fe-layout.fe-focus']) {
      expect(CSS, `missing CSS for ${sel}`).toContain(sel);
    }
  });

  it('styles the new toolbar and minimap parts', () => {
    for (const sel of ['.fe-canvas-toolbar', '.fe-tb-group', '.fe-tb-sep',
      '.fe-tb-btn', '.fe-minimap-wrap', '.fe-mm-head', '.fe-mm-title',
      '.fe-mm-btn', '.fe-mm-restore']) {
      expect(CSS, `missing CSS for ${sel}`).toContain(sel);
    }
  });

  it('gives the active tool and the focus toggle a visible pressed state', () => {
    expect(CSS).toMatch(/\.fe-zbtn\.is-active[\s,]/);
    expect(CSS).toMatch(/\.fe-tb-btn\.is-active/);
  });

  it('keeps the minimap body at the 100px spec height inside its wrapper', () => {
    const idx = CSS.indexOf('.fe-minimap {');
    expect(idx).toBeGreaterThan(-1);
    const block = CSS.slice(idx, CSS.indexOf('}', idx));
    expect(block).toMatch(/height:\s*100px/);
  });

  it('anchors both clusters 24px from the canvas edges (spec inset)', () => {
    // the toolbar rule is a selector GROUP (legacy .fe-zoom-ctrl + the new
    // .fe-canvas-toolbar), so anchor on the block, not on one exact selector
    const tb = CSS.slice(CSS.indexOf('.fe-canvas-toolbar {'), CSS.indexOf('.fe-tb-group'));
    expect(tb).toMatch(/inset-block-end:\s*24px/);
    expect(tb).toMatch(/inset-inline-start:\s*24px/);
    const mm = CSS.slice(CSS.indexOf('.fe-minimap-wrap {'), CSS.indexOf('.fe-minimap-wrap[hidden]'));
    expect(mm).toMatch(/inset-block-end:\s*24px/);
    expect(mm).toMatch(/inset-inline-end:\s*24px/);
  });

  it('collapses the Focus-Mode palette by width, never display:none', () => {
    // `display: none` drops the aside out of the grid, so the canvas slides
    // into the 0px first column and measures 0px wide. Regression guard.
    const idx = CSS.indexOf('.fe-layout.fe-focus > .fe-palette');
    expect(idx).toBeGreaterThan(-1);
    const block = CSS.slice(idx, CSS.indexOf('}', idx));
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).toMatch(/width:\s*0/);
    expect(block).toMatch(/visibility:\s*hidden/);
  });

  it('hides the whole minimap widget (not just its body) on narrow canvases', () => {
    const mq = CSS.slice(CSS.indexOf('@media (max-width: 980px)'));
    const block = mq.slice(0, mq.indexOf('\n}'));
    expect(block).toContain('.fe-minimap-wrap');
    expect(block).toContain('.fe-mm-restore');
  });
});
