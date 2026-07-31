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
  /** `in_list` / `not_in_list` carry a real ARRAY (ConditionEngine requires it). */
  expected?: string | string[];
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
  CONDITION_OPERATORS: { id: string; dom?: boolean; list?: boolean }[];
  CONDITION_KINDS: { id: string }[];
  checkKindOf: (row: Record<string, unknown>) => string;
  applyCheckKind: (row: Record<string, unknown>, kind: string) => Record<string, string>;
  operatorsForKind: (kind: string) => { id: string }[];
  DESIGNED_NODES: Record<string, unknown>;
  CLICK_DEFAULTS: Record<string, unknown>;
  conditionSummary: (params: Record<string, unknown>, t?: (k: string) => string) => string;
  clickPayloadPreview: (params: Record<string, unknown>) => Record<string, unknown>;
  clickModifierList: (params: Record<string, unknown>) => string[];
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
    'value', 'expected'];

  it.each(['if', 'while'])('%s declares every builder param', (action) => {
    const declared = fieldKeys(action);
    expect(required.filter((k) => !declared.includes(k))).toEqual([]);
  });

  /**
   * BACKEND ↔ UI PARITY GUARD.
   *
   * This test used to require `maxDepth` and `evaluateMode` too, which is how
   * two controls that no backend code reads survived for so long: the design
   * showed them, so the UI built them, so the test froze them in place.
   *
   * The rule now runs the other way round — a param may only be offered if
   * something actually consumes it. `maxDepth` guarded a recursion depth the
   * builder cannot reach (it emits at most `any` of `all`), and `evaluateMode`
   * described the short-circuiting that `any`/`all` already do. Neither appears
   * anywhere in src/, so both are gone from the catalog and the NDV.
   */
  it.each(['if', 'while'])('%s offers no param the backend never reads', (action) => {
    const declared = fieldKeys(action);
    expect(declared).not.toContain('maxDepth');
    expect(declared).not.toContain('evaluateMode');
  });

  /**
   * The reverse leg of the same parity rule: every operator the runtime
   * implements must be reachable from the UI, except the ones deliberately
   * withheld. `in_list` / `not_in_list` were implemented in ConditionEngine but
   * had no way to be produced by the editor at all.
   *
   * `random` is the one intentional omission — a branch decided by
   * Math.random() makes a run unreproducible, so the builder refuses to offer
   * it while the engine still honours hand-written JSON that uses it.
   */
  it('surfaces every engine operator except the intentionally withheld ones', () => {
    const engine = readFileSync(
      join(__dirname, '..', '..', 'src', 'core', 'ConditionEngine.ts'), 'utf8');
    const typeBlock = engine.slice(
      engine.indexOf('export type ConditionOperator'),
      engine.indexOf('// Which part of the matched element'));
    const engineOps = Array.from(typeBlock.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    expect(engineOps).toContain('in_list');
    expect(engineOps).toContain('random');

    const uiOps: string[] = NM.CONDITION_OPERATORS.map((o: any) => o.id);
    const WITHHELD = ['random'];
    const missing = engineOps.filter(
      (op) => !uiOps.includes(op) && !WITHHELD.includes(op));
    expect(missing, 'engine operators the builder cannot produce').toEqual([]);
    for (const op of WITHHELD) expect(uiOps).not.toContain(op);
  });

  /**
   * `in_list` / `not_in_list` are only useful if they reach the engine in the
   * shape it tests for: ConditionEngine compares with `Array.isArray(expected)
   * && expected.includes(...)`, so a comma string would silently evaluate to
   * false forever. The builder edits one text field; the serialiser is the
   * single place that turns it into an array.
   */
  it('serialises an in_list row to a real array and round-trips the text', () => {
    const rows = [[{ source: 'text', selector: '.status', operator: 'in_list',
      expected: 'paid, shipped , delivered', value: '', attribute: '' }]];
    const cond: any = GS.buildCondition({ groups: JSON.stringify(rows) });
    expect(cond.operator).toBe('in_list');
    expect(cond.expected).toEqual(['paid', 'shipped', 'delivered']);

    const twoRows = [[
      { selector: '.a', operator: 'exists', source: 'text', attribute: '', value: '', expected: '' },
      { selector: '.status', operator: 'not_in_list', source: 'text', attribute: '',
        value: '', expected: 'draft\nvoid' },
    ]];
    const composite: any = GS.buildCondition({ groups: JSON.stringify(twoRows) });
    expect(composite.all[1].expected).toEqual(['draft', 'void']);
    // and back again, as the comma list the user typed
    const back = GS.conditionToGroups(composite)!;
    expect(back[0][1].expected).toBe('draft, void');
  });

  /**
   * The three check kinds are DERIVED, never stored: they exist so the NDV can
   * hide the fields the chosen runtime path ignores. If they were persisted,
   * every saved workflow would need a migration — and the serialised shape must
   * stay byte-identical, which is what this pins.
   */
  it('derives the check kind from the row and never serialises it', () => {
    expect(NM.checkKindOf({ operator: 'visible', source: 'text' })).toBe('element');
    expect(NM.checkKindOf({ operator: 'equals', source: 'variable' })).toBe('variable');
    expect(NM.checkKindOf({ operator: 'equals', source: 'attribute' })).toBe('content');

    // switching to `variable` must drop the selector the engine would ignore
    const asVar = NM.applyCheckKind(
      { operator: 'equals', source: 'text', selector: '.x', expected: 'y' }, 'variable');
    expect(asVar.source).toBe('variable');
    expect(asVar.selector).toBe('');
    // switching to `element` must drop source/attribute the DOM branch ignores
    const asEl = NM.applyCheckKind(
      { operator: 'contains', source: 'attribute', attribute: 'href', selector: '.x' }, 'element');
    expect(asEl.operator).toBe('exists');
    expect(asEl.attribute).toBe('');

    const cond: any = GS.buildCondition({
      groups: JSON.stringify([[NM.applyCheckKind(
        { operator: 'exists', selector: '.x' }, 'element')]]),
    });
    expect(Object.keys(cond).sort()).toEqual(['operator', 'selector']);
    expect('kind' in cond).toBe(false);
  });

  /** Only the four DOM operators may be offered for an `element` row. */
  it('offers only the operators each kind can evaluate', () => {
    expect(NM.operatorsForKind('element').map((o: any) => o.id))
      .toEqual(['exists', 'not_exists', 'visible', 'hidden']);
    const content = NM.operatorsForKind('content').map((o: any) => o.id);
    expect(content).not.toContain('visible');
    expect(content).toContain('in_list');
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

// The OUTPUT column of the click NDV shows a "representative result shape".
// If it drifts from what src/pipeline.ts actually pushes, the modal promises a
// payload the run never produces — invisible in the UI, confusing at runtime.
// These tests read the real pipeline source so the two cannot silently diverge.
describe('click OUTPUT preview matches the runtime payload', () => {
  let pipelineSrc: string;

  beforeAll(() => {
    pipelineSrc = readFileSync(join(__dirname, '..', '..', 'src', 'pipeline.ts'), 'utf8');
  });

  it('every key the preview shows is emitted by the pipeline click branch', () => {
    const preview = NM.clickPayloadPreview({
      selector: '#next-button', modAlt: true, offsetX: 4, offsetY: -2,
    });
    // The click step output object in pipeline.ts.
    const payloadBlock = pipelineSrc.slice(
      pipelineSrc.indexOf('clicked: true'),
      pipelineSrc.indexOf('stepStartTime', pipelineSrc.indexOf('clicked: true'))
    );
    expect(payloadBlock.length).toBeGreaterThan(0);
    for (const key of Object.keys(preview)) {
      expect(payloadBlock, `preview key "${key}" is not in the runtime payload`).toContain(key);
    }
  });

  it('modifiers/position are omitted until they are actually configured', () => {
    const plain = NM.clickPayloadPreview({ selector: '#a' });
    expect(plain).not.toHaveProperty('modifiers');
    expect(plain).not.toHaveProperty('position');
    const rich = NM.clickPayloadPreview({ selector: '#a', modCtrl: true, offsetY: 6 });
    expect(rich.modifiers).toEqual(['ControlOrMeta']);
    expect(rich.position).toEqual({ x: 0, y: 6 });
  });

  it('maps Ctrl/Cmd to the same Playwright name the runtime uses', () => {
    expect(NM.clickModifierList({ modCtrl: true })).toEqual(['ControlOrMeta']);
    expect(NM.clickModifierList({ modAlt: true, modCtrl: true, modShift: true }))
      .toEqual(['Alt', 'ControlOrMeta', 'Shift']);
    // ControlOrMeta must be what pipeline.ts emits, not plain 'Control'.
    expect(pipelineSrc).toContain("mods.push('ControlOrMeta')");
  });

  it('reflects clickType/clickCount consistency (double click never runs once)', () => {
    const dbl = NM.clickPayloadPreview({ selector: '#a', clickType: 'double' });
    expect(dbl.clickType).toBe('double');
    expect(dbl.clickCount).toBe(2);
    const triple = NM.clickPayloadPreview({ selector: '#a', clickType: 'triple' });
    expect(triple.clickCount).toBe(3);
  });
});

// Guards the other half of the "silent drop" problem: a param the runtime reads
// but the catalog never declares is stripped by coerceParams() before it can
// ever reach the engine.
describe('every click param the runtime reads is declared in the catalog', () => {
  it('pipeline.ts reads no finalParams key that the catalog omits', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'pipeline.ts'), 'utf8');
    const start = src.indexOf("if (['click', 'dblclick', 'hover', 'focus'].includes(step.action))");
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('continue stepLoop;', start));

    const read = new Set<string>();
    for (const m of branch.matchAll(/finalParams\.([A-Za-z0-9_]+)/g)) read.add(m[1]);
    expect(read.size).toBeGreaterThan(10);

    const declared = new Set(fieldKeys('click'));
    for (const key of read) {
      expect(declared.has(key), `pipeline reads finalParams.${key} but click's catalog does not declare it`).toBe(true);
    }
  });
});

/**
 * MISSION 5 (MISSIONS.md) — the condition node's option set is measured against
 * AutomaApp/automa, which is the project's accepted reference for node logic
 * (rule R1). Automa renders `conditionBuilder.compareTypes` as an <optgroup>
 * dropdown bucketed basic / number / text / boolean; a flat 26-entry list is a
 * scan, not a choice, so the grouping is part of the feature, not decoration.
 *
 * Everything here is structural: the grouping is pure data, and the two DOM
 * files are checked by source, because this suite is deliberately DOM-free.
 */
describe('condition operators — Automa parity + grouped dropdown', () => {
  const UI_SRC = readFileSync(
    join(__dirname, '..', '..', 'public', 'js', 'ndv-ui.js'), 'utf8');
  const NODES_SRC = readFileSync(
    join(__dirname, '..', '..', 'public', 'js', 'ndv-nodes.js'), 'utf8');
  const I18N_SRC = readFileSync(
    join(__dirname, '..', '..', 'public', 'js', 'i18n.js'), 'utf8');

  /** fa and en are separate objects in i18n.js; a key must appear in each. */
  function dictSlices(): { fa: string; en: string } {
    const faAt = I18N_SRC.indexOf('fa: {');
    const enAt = I18N_SRC.indexOf('en: {');
    expect(faAt).toBeGreaterThan(-1);
    expect(enAt).toBeGreaterThan(faAt);
    return { fa: I18N_SRC.slice(faAt, enAt), en: I18N_SRC.slice(enAt) };
  }

  /**
   * Automa compare type -> our operator id. Kept as an explicit table so that
   * "we match Automa" is a checked claim rather than a comment. Automa ids come
   * from utils/shared.js -> conditionBuilder.compareTypes.
   */
  const AUTOMA_COMPARE: Record<string, string> = {
    eq: 'equals', eqi: 'equals_i', nq: 'not_equals',
    gt: 'greater_than', gte: 'greater_equal', lt: 'less_than', lte: 'less_equal',
    cnt: 'contains', cni: 'contains_i', nct: 'not_contains', nci: 'not_contains_i',
    stw: 'starts_with', enw: 'ends_with', rgx: 'matches_regex',
    itr: 'is_truthy', ifl: 'is_falsy',
  };

  it('offers an operator for every one of Automa\u2019s compare types', () => {
    const ids = new Set(NM.CONDITION_OPERATORS.map((o) => o.id));
    const missing = Object.entries(AUTOMA_COMPARE)
      .filter(([, ours]) => !ids.has(ours))
      .map(([automa, ours]) => `${automa} -> ${ours}`);
    expect(missing, `Automa compare types with no Aria operator: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('gives every operator a group, so none can vanish from the dropdown', () => {
    const groups = new Set(
      ((NM as unknown as { CONDITION_OPERATOR_GROUPS: { id: string }[] })
        .CONDITION_OPERATOR_GROUPS).map((g) => g.id));
    expect(groups.size).toBeGreaterThanOrEqual(4);
    const ungrouped = (NM.CONDITION_OPERATORS as unknown as { id: string; group?: string }[])
      .filter((o) => !o.group || !groups.has(o.group))
      .map((o) => o.id);
    expect(ungrouped, `operators with no known group: ${ungrouped.join(', ')}`).toEqual([]);
  });

  it('buckets the operators without losing or duplicating a single one', () => {
    const grouped = NM as unknown as {
      groupedOperatorsForKind: (k: string) => { group: string; options: { id: string }[] }[];
    };
    for (const kind of ['element', 'content', 'variable']) {
      const buckets = grouped.groupedOperatorsForKind(kind);
      // no empty heading may survive (an <optgroup> with no <option> is a lie)
      expect(buckets.every((b) => b.options.length > 0)).toBe(true);
      const flat = buckets.flatMap((b) => b.options.map((o) => o.id));
      // exactly the same set as the ungrouped accessor, in the same order
      expect(flat).toEqual(NM.operatorsForKind(kind).map((o) => o.id));
      expect(new Set(flat).size).toBe(flat.length);
    }
    // an `element` row can only ever evaluate the four DOM operators, so it
    // must collapse to ONE bucket rather than showing six empty headings
    expect(grouped.groupedOperatorsForKind('element')).toHaveLength(1);
    expect(grouped.groupedOperatorsForKind('content').length).toBeGreaterThan(3);
  });

  it('translates every operator AND group label in both dictionaries', () => {
    const dicts = dictSlices();
    const keys = [
      ...NM.CONDITION_OPERATORS.map((o) => (o as unknown as { label: string }).label),
      ...((NM as unknown as { CONDITION_OPERATOR_GROUPS: { label: string }[] })
        .CONDITION_OPERATOR_GROUPS).map((g) => g.label),
      'opg.other', // the orphan-safety bucket must be translatable too
    ];
    const missFa = [...new Set(keys)].filter((k) => !dicts.fa.includes(`'${k}':`));
    const missEn = [...new Set(keys)].filter((k) => !dicts.en.includes(`'${k}':`));
    expect(missFa, `missing from fa: ${missFa.join(', ')}`).toEqual([]);
    expect(missEn, `missing from en: ${missEn.join(', ')}`).toEqual([]);
  });

  it('renders the grouped list through a real <optgroup>, not a fake one', () => {
    // selectCell must accept the { group, options } shape …
    expect(UI_SRC).toContain("document.createElement('optgroup')");
    expect(UI_SRC).toContain('Array.isArray(o.options)');
    // … and refuse to emit a heading with nothing under it
    expect(UI_SRC).toContain('if (!o.options.length) return;');
    // … and the condition row must actually USE it
    expect(NODES_SRC).toContain('m.groupedOperatorsForKind(kind)');
  });

  /**
   * The catalog is what `coerceParams` copies on save. An operator the builder
   * can produce but the catalog does not declare is silently dropped, so the
   * two lists have to stay in step.
   */
  it('declares every builder operator in the action catalog (if + while)', () => {
    const ids = NM.CONDITION_OPERATORS.map((o) => o.id);
    for (const action of ['if', 'while']) {
      const def = catalog.ACTIONS.find((a) => a.id === action);
      expect(def, `${action} missing from the catalog`).toBeTruthy();
      const field = def!.fields.find((f) => f.k === 'operator') as
        (Field & { options?: string[] }) | undefined;
      expect(field, `${action}.operator field missing`).toBeTruthy();
      const missing = ids.filter((id) => !(field!.options ?? []).includes(id));
      expect(missing, `${action}.operator options missing: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
