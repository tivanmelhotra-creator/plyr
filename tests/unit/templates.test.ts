/**
 * templates.test.ts — Step 32
 *
 * Starter workflow templates (public/js/templates.js) must stay in lock-step
 * with the action catalog (public/js/actions.js) and the i18n contract. This
 * test loads BOTH browser-side modules under a minimal `window` shim (the same
 * jsdom-free `vm` pattern used by action-catalog.test.ts and ab-core.test.ts)
 * and asserts:
 *   - the template catalog shape (list / byId / toWorkflowBody / ids)
 *   - exactly the three required starter templates exist, with unique ids
 *   - each template has i18n name/description keys (tpl.*), an icon and steps
 *   - EVERY action used by a template exists in the action catalog
 *     (so a template can never reference a node the UI/backend cannot run)
 *   - toWorkflowBody() returns a deep copy in /workflows shape that does not
 *     alias the template's own steps, and degrades safely for unknown ids
 *
 * It is intentionally DOM-free: templates.js + actions.js only touch `window`,
 * so a tiny shim is enough — no jsdom dependency is added to the project.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Action { id: string; icon: string; cat?: string; fields: unknown[] }
interface Catalog { ACTIONS: Action[]; ids: () => string[] }

interface Step { action: string; params: Record<string, unknown> }
interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  headless: boolean;
  steps: Step[];
}
interface WorkflowBody {
  name: string;
  description: string | null;
  steps: Step[];
  headless: boolean;
}
interface Templates {
  list: () => Template[];
  byId: (id: string) => Template | null;
  toWorkflowBody: (id: string, nameOverride?: string) => WorkflowBody | null;
  ids: () => string[];
}

let catalog: Catalog;
let templates: Templates;

beforeAll(() => {
  // A single shared `window` shim so templates.js can (optionally) see the
  // catalog, exactly like the browser load order in index.html.
  const sandbox: { window: { ACTION_CATALOG?: Catalog; TEMPLATES?: Templates } } = { window: {} };
  vm.createContext(sandbox);

  const actionsFile = join(__dirname, '..', '..', 'public', 'js', 'actions.js');
  vm.runInContext(readFileSync(actionsFile, 'utf8'), sandbox, { filename: 'actions.js' });
  if (!sandbox.window.ACTION_CATALOG) throw new Error('actions.js did not expose window.ACTION_CATALOG');
  catalog = sandbox.window.ACTION_CATALOG;

  const templatesFile = join(__dirname, '..', '..', 'public', 'js', 'templates.js');
  vm.runInContext(readFileSync(templatesFile, 'utf8'), sandbox, { filename: 'templates.js' });
  if (!sandbox.window.TEMPLATES) throw new Error('templates.js did not expose window.TEMPLATES');
  templates = sandbox.window.TEMPLATES;
});

describe('templates catalog — Step 32', () => {
  it('exposes list / byId / toWorkflowBody / ids helpers', () => {
    expect(typeof templates.list).toBe('function');
    expect(typeof templates.byId).toBe('function');
    expect(typeof templates.toWorkflowBody).toBe('function');
    expect(typeof templates.ids).toBe('function');
  });

  it('ships exactly the three required starter templates', () => {
    const ids = templates.ids();
    expect(ids).toEqual(expect.arrayContaining(['price-scrape', 'login-form', 'scheduled-screenshot']));
    expect(ids.length).toBe(3);
  });

  it('template ids are unique', () => {
    const ids = templates.ids();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('list() returns a fresh array (not the internal one)', () => {
    expect(templates.list()).not.toBe(templates.list());
    expect(templates.list().length).toBe(3);
  });

  it('each template has an i18n name/description, an icon and non-empty steps', () => {
    templates.list().forEach((t) => {
      expect(t.name, `name for ${t.id}`).toMatch(/^tpl\./);
      expect(t.description, `description for ${t.id}`).toMatch(/^tpl\./);
      expect(typeof t.icon).toBe('string');
      expect(t.icon.length).toBeGreaterThan(0);
      expect(Array.isArray(t.steps)).toBe(true);
      expect(t.steps.length, `steps for ${t.id}`).toBeGreaterThan(0);
      t.steps.forEach((s) => {
        expect(typeof s.action, `action string in ${t.id}`).toBe('string');
        expect(s.action.length).toBeGreaterThan(0);
        expect(typeof s.params, `params object in ${t.id}`).toBe('object');
      });
    });
  });

  it('every action used by a template exists in the action catalog', () => {
    const known = new Set(catalog.ids());
    const offenders: string[] = [];
    templates.list().forEach((t) => {
      t.steps.forEach((s) => {
        if (!known.has(s.action)) offenders.push(`${t.id}:${s.action}`);
      });
    });
    expect(offenders, `template steps not in catalog: ${offenders.join(', ')}`).toEqual([]);
  });

  it('byId returns the matching template or null for unknown ids', () => {
    const tpl = templates.byId('price-scrape');
    expect(tpl).toBeTruthy();
    expect(tpl!.id).toBe('price-scrape');
    expect(templates.byId('does-not-exist')).toBeNull();
  });

  it('toWorkflowBody returns a /workflows-shaped body and a deep copy of steps', () => {
    const body = templates.toWorkflowBody('login-form', 'My login flow');
    expect(body).toBeTruthy();
    expect(body!.name).toBe('My login flow');
    expect(body!.description).toBeNull();
    expect(typeof body!.headless).toBe('boolean');
    expect(Array.isArray(body!.steps)).toBe(true);
    expect(body!.steps.length).toBeGreaterThan(0);

    // Deep copy: mutating the produced body must not affect the source template.
    const source = templates.byId('login-form')!;
    const sourceLen = source.steps.length;
    body!.steps.push({ action: 'log', params: {} });
    (body!.steps[0].params as Record<string, unknown>).url = 'mutated';
    expect(source.steps.length).toBe(sourceLen);
    expect((source.steps[0].params as Record<string, unknown>).url).not.toBe('mutated');
  });

  it('toWorkflowBody falls back to the template id as name and null for unknown id', () => {
    const body = templates.toWorkflowBody('scheduled-screenshot');
    expect(body!.name).toBe('scheduled-screenshot');
    expect(templates.toWorkflowBody('nope')).toBeNull();
  });
});
