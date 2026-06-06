/**
 * action-catalog.test.ts — Step 23
 *
 * The visual editor (public/js/flow-editor.js) colour-codes and groups palette
 * nodes by each action's `cat` (category). This test loads the browser-side
 * catalog (public/js/actions.js) under a minimal `window` shim and asserts the
 * Step 23 category contract:
 *   - every action declares a `cat`
 *   - every `cat` maps to a defined CATEGORY (no dangling references)
 *   - categoryById() falls back safely for unknown ids
 *   - the catalog is internally consistent (unique ids, valid fields)
 *
 * It is intentionally DOM-free: actions.js only touches `window`, so a tiny
 * shim is enough — no jsdom dependency is added to the project.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Field { k: string; label: string; type: string; ph?: string; options?: string[] }
interface Action { id: string; icon: string; cat?: string; fields: Field[] }
interface Category { id: string; color: string; label: string }
interface Catalog {
  ACTIONS: Action[];
  CATEGORIES: Category[];
  actionById: (id: string) => Action;
  categoryById: (id: string) => Category;
  ids: () => string[];
}

let catalog: Catalog;

beforeAll(() => {
  const file = join(__dirname, '..', '..', 'public', 'js', 'actions.js');
  const code = readFileSync(file, 'utf8');
  const sandbox: { window: { ACTION_CATALOG?: Catalog } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'actions.js' });
  if (!sandbox.window.ACTION_CATALOG) throw new Error('actions.js did not expose window.ACTION_CATALOG');
  catalog = sandbox.window.ACTION_CATALOG;
});

describe('action catalog — Step 23 category contract', () => {
  it('exposes ACTIONS, CATEGORIES and helper functions', () => {
    expect(Array.isArray(catalog.ACTIONS)).toBe(true);
    expect(catalog.ACTIONS.length).toBeGreaterThan(0);
    expect(Array.isArray(catalog.CATEGORIES)).toBe(true);
    expect(catalog.CATEGORIES.length).toBeGreaterThan(0);
    expect(typeof catalog.actionById).toBe('function');
    expect(typeof catalog.categoryById).toBe('function');
  });

  it('every action declares a category', () => {
    const missing = catalog.ACTIONS.filter((a) => !a.cat);
    expect(missing.map((a) => a.id)).toEqual([]);
  });

  it('every action category maps to a defined CATEGORY', () => {
    const defined = new Set(catalog.CATEGORIES.map((c) => c.id));
    const dangling = catalog.ACTIONS
      .map((a) => a.cat as string)
      .filter((cat) => !defined.has(cat));
    expect(dangling).toEqual([]);
  });

  it('each CATEGORY has an id, a hex colour and an i18n label key', () => {
    catalog.CATEGORIES.forEach((c) => {
      expect(c.id).toBeTruthy();
      expect(c.color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      expect(c.label).toMatch(/^cat\./);
    });
  });

  it('categoryById returns the matching category for a known id', () => {
    const nav = catalog.categoryById('navigation');
    expect(nav.id).toBe('navigation');
    expect(nav.color).toMatch(/^#/);
  });

  it('categoryById falls back to a safe "other" category for unknown ids', () => {
    const other = catalog.categoryById('does-not-exist');
    expect(other.id).toBe('other');
    expect(other.color).toMatch(/^#/);
    expect(other.label).toBe('cat.other');
  });

  it('action ids are unique', () => {
    const ids = catalog.ids();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every action has an icon and a fields array', () => {
    catalog.ACTIONS.forEach((a) => {
      expect(typeof a.icon).toBe('string');
      expect(a.icon.length).toBeGreaterThan(0);
      expect(Array.isArray(a.fields)).toBe(true);
    });
  });

  it('actionById resolves a known id and falls back to the first action', () => {
    const first = catalog.ACTIONS[0];
    expect(catalog.actionById(first.id).id).toBe(first.id);
    // unknown id -> fallback (first action), never undefined
    expect(catalog.actionById('nope')).toBeTruthy();
  });
});
