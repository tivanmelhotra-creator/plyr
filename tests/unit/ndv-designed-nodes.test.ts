/**
 * ndv-designed-nodes.test.ts
 *
 * Guards the contract between the two LOCKED NDV designs and the serializer:
 *   docs/uiux/ndv-click-element-final.md  -> action `click`
 *   docs/uiux/ndv-condition-final.md      -> actions `if` / `while`
 *
 * Two silent-failure modes are pinned down here, because both are invisible in
 * the UI and only show up as data loss on save/run:
 *
 *   1. `GraphSerialize.coerceParams()` copies ONLY keys declared in an action's
 *      `fields`. A control the design renders but the catalog does not declare
 *      is dropped on save. So every param the designs own must be declared.
 *
 *   2. For `while`, the Condition Builder's params are encoded into
 *      `step.condition`. If they ALSO survive in `step.params`, the same data is
 *      serialised twice and the backend receives params it cannot interpret.
 *
 * DOM-free: the three browser modules under test only touch `window`, so a tiny
 * shim is enough — no jsdom dependency is added.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Field { k: string; type?: string; internal?: boolean }
interface Action { id: string; fields: Field[] }
interface Catalog { ACTIONS: Action[] }

interface SimpleCondition {
  operator: string;
  selector?: string;
  value?: string;
  expected?: string;
  source?: string;
  attribute?: string;
}
type Condition = SimpleCondition | { all: Condition[] } | { any: Condition[] };
interface Step { action: string; params?: Record<string, unknown>; condition?: Condition }

interface GraphNode { id: string; action: string; params: Record<string, unknown>; x: number; y: number }
interface Graph { nodes: Record<string, GraphNode>; edges: { from: string; to: string; port?: string }[] }

interface Serializer {
  graphToSteps: (g: Graph) => Step[];
  buildCondition: (params: Record<string, unknown>) => Condition;
  conditionToGroups: (c: Condition) => SimpleCondition[][] | null;
  CONDITION_ONLY_PARAMS: string[];
}

interface Model {
  isDesigned: (action: string) => boolean;
  DESIGNED_NODES: Record<string, unknown>;
  CLICK_DEFAULTS: Record<string, unknown>;
  conditionSummary: (params: Record<string, unknown>, t?: (k: string) => string) => string;
}

let catalog: Catalog;
let GS: Serializer;
let NM: Model;

function loadBrowserModule(sandbox: object, name: string): void {
  const file = join(__dirname, '..', '..', 'public', 'js', name);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: name });
}

beforeAll(() => {
  const sandbox: {
    window: { ACTION_CATALOG?: Catalog; GraphSerialize?: Serializer; NdvModel?: Model };
  } = { window: {} };
  vm.createContext(sandbox);
  // actions.js must load first — graph-serialize.js reads window.ACTION_CATALOG.
  loadBrowserModule(sandbox, 'actions.js');
  loadBrowserModule(sandbox, 'ndv-model.js');
  loadBrowserModule(sandbox, 'graph-serialize.js');
  if (!sandbox.window.ACTION_CATALOG) throw new Error('actions.js did not expose window.ACTION_CATALOG');
  if (!sandbox.window.GraphSerialize) throw new Error('graph-serialize.js did not expose window.GraphSerialize');
  if (!sandbox.window.NdvModel) throw new Error('ndv-model.js did not expose window.NdvModel');
  catalog = sandbox.window.ACTION_CATALOG;
  GS = sandbox.window.GraphSerialize;
  NM = sandbox.window.NdvModel;
});

function fieldKeys(actionId: string): string[] {
  const act = catalog.ACTIONS.find((a) => a.id === actionId);
  if (!act) throw new Error(`action "${actionId}" is not in the catalog`);
  return act.fields.map((f) => f.k);
}

/** A two-group builder value: group 1 is AND of two rows, group 2 a single row. */
const GROUPS_JSON = JSON.stringify([
  [
    {
      operator: 'not_equals',
      selector: '#login-status',
      source: 'attribute',
      attribute: 'textContent',
      expected: 'logged-out',
    },
    { operator: 'exists', selector: '.user-name' },
  ],
  [{ operator: 'exists', selector: '.error-message' }],
]);

function graphWith(node: GraphNode): Graph {
  return {
    nodes: {
      start: { id: 'start', action: '__start__', params: {}, x: 0, y: 0 },
      [node.id]: node,
    },
    edges: [{ from: 'start', to: node.id, port: 'next' }],
  };
}

describe('designed NDV nodes — which actions have a locked design', () => {
  it('exactly click, if and while are marked as designed', () => {
    expect(Object.keys(NM.DESIGNED_NODES).sort()).toEqual(['click', 'if', 'while']);
    expect(NM.isDesigned('click')).toBe(true);
    expect(NM.isDesigned('if')).toBe(true);
    expect(NM.isDesigned('while')).toBe(true);
  });

  it('an action without a preview image is NOT treated as designed', () => {
    // `http-request` is informative in the shell previews but has no locked NDV,
    // so it must keep using the generic fallback editor.
    expect(NM.isDesigned('http-request')).toBe(false);
    expect(NM.isDesigned('goto')).toBe(false);
  });
});

describe('click NDV — every designed control is declared in the catalog', () => {
  it('declares every key in CLICK_DEFAULTS so coerceParams cannot drop one', () => {
    const declared = fieldKeys('click');
    const missing = Object.keys(NM.CLICK_DEFAULTS).filter((k) => !declared.includes(k));
    expect(missing).toEqual([]);
  });

  it('round-trips all click params through the serializer', () => {
    const params: Record<string, unknown> = {
      selectorType: 'css',
      selector: '#next-button',
      clickType: 'double',
      button: 'left',
      clickCount: '2',
      delayBeforeMs: '250',
      waitForSelector: true,
      timeout: '10000',
      visibleOnly: true,
      stableForMs: '300',
      offsetX: '4',
      offsetY: '-2',
      modShift: true,
      human: true,
    };
    const steps = GS.graphToSteps(graphWith({ id: 'c', action: 'click', params, x: 200, y: 0 }));
    expect(steps).toHaveLength(1);
    const out = steps[0].params as Record<string, unknown>;
    // numbers are coerced, everything else survives verbatim
    expect(out.selector).toBe('#next-button');
    expect(out.clickType).toBe('double');
    expect(out.clickCount).toBe(2);
    expect(out.delayBeforeMs).toBe(250);
    expect(out.offsetY).toBe(-2);
    expect(out.stableForMs).toBe(300);
    expect(out.modShift).toBe(true);
    expect(out.human).toBe(true);
  });
});

describe('condition NDV — if / while declare the Condition Builder params', () => {
  const required = ['groups', 'source', 'attribute', 'selector', 'operator',
    'value', 'expected', 'maxDepth', 'evaluateMode'];

  it.each(['if', 'while'])('%s declares every builder param', (action) => {
    const declared = fieldKeys(action);
    expect(required.filter((k) => !declared.includes(k))).toEqual([]);
  });

  it('marks the groups blob as internal so no generic editor renders raw JSON', () => {
    for (const action of ['if', 'while']) {
      const act = catalog.ACTIONS.find((a) => a.id === action)!;
      const groups = act.fields.find((f) => f.k === 'groups')!;
      expect(groups.internal).toBe(true);
    }
  });

  it('while keeps ONLY maxIterations in params — the rest lives in condition', () => {
    const steps = GS.graphToSteps(graphWith({
      id: 'w',
      action: 'while',
      params: { groups: GROUPS_JSON, maxIterations: '50', maxDepth: '5', evaluateMode: 'first' },
      x: 200,
      y: 0,
    }));
    expect(steps[0].params).toEqual({ maxIterations: 50 });
    // and none of the condition-only keys leaked through
    for (const k of GS.CONDITION_ONLY_PARAMS) {
      expect(steps[0].params).not.toHaveProperty(k);
    }
  });

  it('compiles two groups into any-of-all with source/attribute preserved', () => {
    const cond = GS.buildCondition({ groups: GROUPS_JSON }) as { any: Condition[] };
    expect(cond.any).toHaveLength(2);
    const first = (cond.any[0] as { all: SimpleCondition[] }).all[0];
    expect(first).toEqual({
      operator: 'not_equals',
      selector: '#login-status',
      expected: 'logged-out',
      source: 'attribute',
      attribute: 'textContent',
    });
  });

  it('omits source when it is the engine default ("text")', () => {
    const cond = GS.buildCondition({
      groups: JSON.stringify([[{ operator: 'contains', selector: '.msg', source: 'text', expected: 'hi' }]]),
    }) as SimpleCondition;
    expect(cond).not.toHaveProperty('source');
    expect(cond.expected).toBe('hi');
  });

  it('round-trips source/attribute back into builder groups', () => {
    const cond = GS.buildCondition({ groups: GROUPS_JSON });
    const groups = GS.conditionToGroups(cond);
    expect(groups).not.toBeNull();
    expect(groups!).toHaveLength(2);
    expect(groups![0][0].source).toBe('attribute');
    expect(groups![0][0].attribute).toBe('textContent');
    expect(groups![1][0]).toEqual({ operator: 'exists', selector: '.error-message' });
  });
});

describe('condition summary shown on the canvas node card', () => {
  it('renders groups as one readable AND/OR statement', () => {
    const summary = NM.conditionSummary({ groups: GROUPS_JSON }, (k) => k);
    expect(summary).toContain('#login-status');
    expect(summary).toContain(' AND ');
    expect(summary).toContain(' OR ');
    expect(summary).toContain('.error-message');
  });

  it('returns an empty string when there is nothing to summarise', () => {
    expect(NM.conditionSummary({}, (k) => k)).toBe('');
  });
});
