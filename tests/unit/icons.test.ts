/**
 * icons.test.ts — regression guard for the inline SVG icon registry.
 *
 * The UI previously drew every glyph with an emoji character. The product font
 * stack has no emoji coverage, so the shipped screenshots showed empty boxes
 * everywhere (docs/uiux). public/js/icons.js replaced that with inline SVG.
 *
 * These tests make the defect un-reintroducible:
 *   1. every action in the catalog resolves to a REAL icon (not the `dot`
 *      fallback), and no `icon:` field carries an emoji any more;
 *   2. emitted markup is CSP-inert, uses `currentColor`, is `aria-hidden`,
 *      and keeps the shared 24x24 viewBox;
 *   3. every icon name referenced from any consumer module or `data-icon`
 *      attribute actually exists in the registry (no silent `dot` fallbacks);
 *   4. icons.js is the FIRST front-end script in index.html, so later modules
 *      can call window.Icons at definition time;
 *   5. no emoji survive on executable lines of the shipped front-end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const PUBLIC_JS = join(ROOT, 'public', 'js');
const INDEX_HTML = join(ROOT, 'public', 'index.html');

/**
 * Every shipped front-end module except icons.js itself (which is the registry,
 * not a consumer). Declared BEFORE the describe blocks on purpose: `const` is
 * block-scoped and not initialisation-hoisted, so a declaration placed below
 * would throw a TDZ ReferenceError when a test body reads it.
 */
const JS_ALL = [
  'actions.js', 'templates.js', 'i18n.js', 'api.js', 'expression.js',
  'graph-serialize.js', 'ndv-model.js', 'ndv-ui.js', 'ndv-nodes.js',
  'flow-editor.js', 'live.js', 'live-view.js', 'run-state.js', 'run-panel.js',
  'browser-view.js', 'remote-io.js', 'real-chrome.js', 'views.js', 'app.js',
];

/**
 * Emoji + dingbat + misc-symbol ranges that must not appear in shipped UI code.
 *
 * NOTE: U+2190..U+21FF (plain arrows, e.g. the "True -> Then branch" glyph in
 * i18n copy) is deliberately EXCLUDED. Those are ordinary typographic
 * characters with full coverage in the product font stack — they render fine
 * and are prose, not iconography. Only pictographic ranges are banned.
 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/**
 * Load the DOM-free part of a public module inside a `{ window: {} }` shim.
 * icons.js guards its DOMContentLoaded hook behind `typeof document`, so it
 * evaluates cleanly here.
 */
function loadModules(files: string[]): Record<string, any> {
  const sandbox: any = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(readFileSync(join(PUBLIC_JS, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window;
}

const win = loadModules(['icons.js', 'actions.js']);
const Icons = win.Icons;
const CATALOG = win.ACTION_CATALOG;

/** Read a public/js module's source. */
function src(file: string): string {
  return readFileSync(join(PUBLIC_JS, file), 'utf8');
}

describe('icons.js — registry shape', () => {
  it('exposes the documented public surface on window.Icons', () => {
    expect(Icons).toBeTruthy();
    for (const fn of ['svg', 'el', 'has', 'names', 'action', 'hydrate']) {
      expect(typeof Icons[fn], `Icons.${fn}`).toBe('function');
    }
    expect(typeof Icons.ACTION_ICONS).toBe('object');
  });

  it('registers a meaningful number of icons, all lower-kebab named', () => {
    const names: string[] = Icons.names();
    expect(names.length).toBeGreaterThanOrEqual(60);
    for (const n of names) {
      expect(n, `icon name "${n}"`).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('has() is exact and names() is sorted + unique', () => {
    const names: string[] = Icons.names();
    expect(names.every((n: string) => Icons.has(n))).toBe(true);
    expect(Icons.has('definitely-not-an-icon')).toBe(false);
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('icons.js — emitted markup is CSP-inert and themeable', () => {
  const sample = Icons.names() as string[];

  it('every icon renders a single balanced <svg> root', () => {
    for (const n of sample) {
      const s: string = Icons.svg(n);
      expect(s.startsWith('<svg '), n).toBe(true);
      expect(s.endsWith('</svg>'), n).toBe(true);
      // exactly one root element
      expect(s.split('<svg ').length - 1, n).toBe(1);
      expect(s.split('</svg>').length - 1, n).toBe(1);
    }
  });

  it('inherits text colour and never hard-codes a fill colour', () => {
    for (const n of sample) {
      const s: string = Icons.svg(n);
      expect(s, n).toContain('stroke="currentColor"');
      expect(s, n).toContain('fill="none"');
      // solid dots are allowed, but only as currentColor
      const fills = [...s.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
      for (const f of fills) {
        expect(['none', 'currentColor'], `${n} fill="${f}"`).toContain(f);
      }
      expect(s, n).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('is decorative (aria-hidden, not focusable) and shares the 24x24 viewBox', () => {
    for (const n of sample) {
      const s: string = Icons.svg(n);
      expect(s, n).toContain('aria-hidden="true"');
      expect(s, n).toContain('focusable="false"');
      expect(s, n).toContain('viewBox="0 0 24 24"');
      expect(s, n).toContain('class="ic');
    }
  });

  it('carries no script, no event handler and no external reference', () => {
    for (const n of sample) {
      const s: string = Icons.svg(n);
      expect(s, n).not.toMatch(/<script/i);
      expect(s, n).not.toMatch(/\son[a-z]+=/i);
      expect(s, n).not.toMatch(/url\(/i);
      expect(s, n).not.toMatch(/https?:/i);
      expect(s, n).not.toMatch(/xlink:href/i);
    }
  });

  it('honours the size option on both width and height', () => {
    const s: string = Icons.svg('check', { size: 22 });
    expect(s).toContain('width="22"');
    expect(s).toContain('height="22"');
  });

  it('appends an extra class without dropping the base .ic class', () => {
    const s: string = Icons.svg('check', { cls: 'my-tint' });
    expect(s).toContain('class="ic my-tint"');
  });

  it('degrades unknown names to the dot fallback instead of throwing', () => {
    expect(() => Icons.svg('no-such-icon')).not.toThrow();
    expect(Icons.svg('no-such-icon')).toBe(Icons.svg('dot'));
  });
});

describe('icons.js — action catalog coverage', () => {
  const actions: any[] = CATALOG.ACTIONS;

  it('the catalog is non-trivial (sanity)', () => {
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThanOrEqual(45);
  });

  it('every action id maps to a REAL icon (never the dot fallback)', () => {
    const unmapped = actions
      .map((a) => a.id)
      .filter((id) => !Icons.ACTION_ICONS[id] || Icons.ACTION_ICONS[id] === 'dot');
    expect(unmapped, 'actions with no dedicated icon').toEqual([]);
  });

  it('every mapped icon name exists in the registry', () => {
    const dangling = Object.entries(Icons.ACTION_ICONS)
      .filter(([, name]) => !Icons.has(name as string))
      .map(([id, name]) => `${id} -> ${name}`);
    expect(dangling, 'ACTION_ICONS pointing at missing icons').toEqual([]);
  });

  it("each action's own icon field matches the ACTION_ICONS map", () => {
    const mismatched = actions
      .filter((a) => a.icon && Icons.ACTION_ICONS[a.id] !== a.icon)
      .map((a) => `${a.id}: catalog="${a.icon}" map="${Icons.ACTION_ICONS[a.id]}"`);
    expect(mismatched, 'catalog/registry drift').toEqual([]);
  });

  it('no action icon field is an emoji any more', () => {
    const emoji = actions.filter((a) => a.icon && EMOJI_RE.test(a.icon)).map((a) => a.id);
    expect(emoji, 'actions still using emoji icons').toEqual([]);
  });

  it('the Start node has its own icon', () => {
    expect(Icons.ACTION_ICONS.__start__).toBeTruthy();
    expect(Icons.has(Icons.ACTION_ICONS.__start__)).toBe(true);
  });

  it('Icons.action() falls back to dot for an unknown action id', () => {
    expect(Icons.action('nope-not-real')).toBe(Icons.svg('dot'));
  });
});

describe('icons.js — every referenced name exists', () => {
  /** Collect icon names referenced from a module's source. */
  function refsIn(source: string): Set<string> {
    const out = new Set<string>();
    const add = (n?: string) => { if (n) out.add(n); };
    // local helpers: IC('x') / ICN / BIC / LIC / LVIC / RIC / ICON is action-id, skip
    for (const m of source.matchAll(/\b(?:IC|ICN|BIC|LIC|LVIC|RIC)\(\s*'([a-z0-9-]+)'/g)) add(m[1]);
    // direct registry calls
    for (const m of source.matchAll(/Icons\.svg\(\s*'([a-z0-9-]+)'/g)) add(m[1]);
    // ternary flavours: ...? 'a' : 'b', 13)
    for (const m of source.matchAll(/\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'\s*,\s*\{?\s*size/g)) {
      add(m[1]); add(m[2]);
    }
    for (const m of source.matchAll(/\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'\s*,\s*\d+\s*\)/g)) {
      add(m[1]); add(m[2]);
    }
    return out;
  }

  it('all IC()/Icons.svg() call sites resolve to registered icons', () => {
    const missing: string[] = [];
    for (const f of JS_ALL) {
      for (const name of refsIn(src(f))) {
        if (!Icons.has(name)) missing.push(`${f}: '${name}'`);
      }
    }
    expect(missing, 'unregistered icon names referenced from consumer modules').toEqual([]);
  });

  it('all data-icon="..." placeholders in index.html resolve', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    const missing = [...html.matchAll(/data-icon="([a-z0-9-]+)"/g)]
      .map((m) => m[1])
      .filter((n) => !Icons.has(n));
    expect(missing, 'unregistered data-icon names').toEqual([]);
  });

  it('index.html actually uses declarative icons (hydration is exercised)', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    const count = [...html.matchAll(/data-icon="/g)].length;
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

describe('icons.js — load order in index.html', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const scripts = [...html.matchAll(/<script src="\/js\/([a-z0-9.-]+)"/g)].map((m) => m[1]);

  it('is the first front-end script so later modules can use window.Icons', () => {
    expect(scripts.length).toBeGreaterThan(5);
    expect(scripts[0]).toBe('icons.js');
  });

  it('is registered exactly once', () => {
    expect(scripts.filter((s) => s === 'icons.js')).toHaveLength(1);
  });
});

describe('front-end code carries no emoji glyphs any more', () => {
  /** Strip line comments, block comments and (rough) string-free code paths. */
  function executableLines(source: string): string[] {
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
    return noBlock
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim().length > 0);
  }

  it('no shipped module emits an emoji on an executable line', () => {
    const offenders: string[] = [];
    for (const f of JS_ALL) {
      executableLines(src(f)).forEach((line, i) => {
        if (EMOJI_RE.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(offenders, 'emoji still present in executable front-end code').toEqual([]);
  });

  it('index.html body markup carries no emoji', () => {
    const html = readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const offenders = html
      .split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => EMOJI_RE.test(l))
      .map(({ l, i }) => `index.html:${i + 1}  ${l.trim().slice(0, 90)}`);
    expect(offenders, 'emoji still present in index.html').toEqual([]);
  });

  it('the module list is complete (guards against a new file slipping through)', () => {
    const onDisk = readdirSync(PUBLIC_JS).filter((f) => f.endsWith('.js') && f !== 'icons.js');
    expect([...onDisk].sort()).toEqual([...JS_ALL].sort());
  });
});
