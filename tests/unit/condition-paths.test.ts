/**
 * condition-paths.test.ts  —  MISSION 7
 *
 * «نود شرطی یه بخش path داره که نمیشه جدید اضافه کرد … هر کدوم از path ها با
 *  اولویت بالا از بالا به پایین به ترتیب چک میشه، درست باشه اون مسیر رو میره
 *  وگرنه بعدی چک میشه. اگر هیچ کدوم کار نکرد و مسیری فعال نشه، از مسیر خنثا
 *  یعنی next میره.»
 *
 * So the contract under test is:
 *
 *   1. a condition node holds N ORDERED paths (add / rename / reorder / delete),
 *   2. they are evaluated TOP -> DOWN and the FIRST true one is the route taken,
 *   3. if none match, the run leaves through the neutral `next` port,
 *   4. and a node with ONE path still serialises exactly like it did before this
 *      feature existed (no silent migration of saved workflows).
 *
 * Four layers are pinned here because a break in any one of them is invisible
 * in the UI and only shows up as a wrong branch at run time:
 *
 *   model       public/js/ndv-model.js      readPaths / writePaths
 *   serializer  public/js/graph-serialize.js  paths <-> `path:<id>` canvas ports
 *   validation  src/validation.ts           paths survive sanitisation
 *   runtime     src/pipeline.ts             pickConditionPath (first match wins)
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { pickConditionPath } from '../../src/pipeline';
import { validateSteps } from '../../src/validation';

interface Row { operator: string; selector?: string; expected?: string | string[]; [k: string]: unknown }
interface Path { id: string; name: string; groups: Row[][] }
interface StepPath { id?: string; name?: string; condition?: any; steps?: Step[] }
interface Step {
  action: string;
  params?: Record<string, unknown>;
  condition?: any;
  then?: Step[];
  else?: Step[];
  paths?: StepPath[];
}
interface GraphNode { id: string; action: string; params: Record<string, unknown>; x: number; y: number }
interface Graph { nodes: Record<string, GraphNode>; edges: { from: string; to: string; port?: string }[] }

interface Serializer {
  graphToSteps: (g: Graph) => Step[];
  stepsToGraph: (steps: Step[]) => Graph;
  validateGraph: (g: Graph) => { ok: boolean; warnings: { code: string }[]; errors: { code: string }[] };
  outlineTree: (g: Graph) => { nodeId: string; port: string; num: string; kind: string }[];
  parsePaths: (params: Record<string, unknown>) => Path[] | null;
  pathPortId: (id: string) => string;
  CONDITION_ONLY_PARAMS: string[];
}
interface Model {
  CONDITION_MAX_PATHS: number;
  blankRow: () => Row;
  readGroups: (p: Record<string, unknown>) => Row[][];
  readPaths: (p: Record<string, unknown>) => Path[];
  writePaths: (p: Record<string, unknown>, paths: Path[]) => Record<string, unknown>;
  isMultiPath: (p: Record<string, unknown>) => boolean;
  pathLabel: (p: Path, i: number, t?: (k: string) => string) => string;
  pathsSummary: (p: Record<string, unknown>, t?: (k: string) => string) => string;
  groupsSummary: (g: Row[][], t?: (k: string) => string) => string;
}
interface Catalog { ACTIONS: { id: string; fields: { k: string; internal?: boolean }[] }[] }

let GS: Serializer;
let NM: Model;
let catalog: Catalog;

function loadBrowserModule(sandbox: object, name: string): void {
  const file = join(__dirname, '..', '..', 'public', 'js', name);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: name });
}

beforeAll(() => {
  const sandbox: {
    window: { ACTION_CATALOG?: Catalog; GraphSerialize?: Serializer; NdvModel?: Model };
  } = { window: {} };
  vm.createContext(sandbox);
  loadBrowserModule(sandbox, 'actions.js');
  loadBrowserModule(sandbox, 'ndv-model.js');
  loadBrowserModule(sandbox, 'graph-serialize.js');
  catalog = sandbox.window.ACTION_CATALOG!;
  GS = sandbox.window.GraphSerialize!;
  NM = sandbox.window.NdvModel!;
});

/** A path whose single row tests `selector` for existence. */
function existsPath(id: string, name: string, selector: string): Path {
  return { id, name, groups: [[{ operator: 'exists', selector } as Row]] };
}

function graphWithNode(node: GraphNode, extra: GraphNode[] = [],
  edges: { from: string; to: string; port?: string }[] = []): Graph {
  const nodes: Record<string, GraphNode> = {
    start: { id: 'start', action: '__start__', params: {}, x: 0, y: 0 },
    [node.id]: node,
  };
  extra.forEach((n) => { nodes[n.id] = n; });
  return {
    nodes,
    edges: [{ from: 'start', to: node.id, port: 'next' }].concat(edges),
  };
}

function logStep(id: string, message: string): GraphNode {
  return { id, action: 'log', params: { message }, x: 0, y: 0 };
}

// ===========================================================================
// 1. MODEL — the ordered list itself
// ===========================================================================
describe('mission 7 · model — the ordered path list', () => {
  it('a node that never used paths still reads as exactly one path', () => {
    const params = { groups: JSON.stringify([[{ operator: 'exists', selector: '.a' }]]) };
    const paths = NM.readPaths(params);
    expect(paths).toHaveLength(1);
    expect(paths[0].groups[0][0].selector).toBe('.a');
    expect(NM.isMultiPath(params)).toBe(false);
  });

  it('a completely empty node still yields one path with one blank row', () => {
    const paths = NM.readPaths({});
    expect(paths).toHaveLength(1);
    expect(paths[0].groups).toHaveLength(1);
    expect(paths[0].groups[0]).toHaveLength(1);
  });

  it('writing ONE path leaves no `paths` key behind (saved workflows are untouched)', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', '', '.only')]);
    expect(params.paths).toBeUndefined();
    // …and the legacy mirror is still written, so the card summary and the
    // single-condition fallback keep working.
    expect(params.selector).toBe('.only');
    expect(params.operator).toBe('exists');
  });

  it('dropping back from two paths to one removes the `paths` key again', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', 'A', '.a'), existsPath('p2', 'B', '.b')]);
    expect(typeof params.paths).toBe('string');
    NM.writePaths(params, [existsPath('p1', 'A', '.a')]);
    expect(params.paths).toBeUndefined();
  });

  it('writing N paths round-trips order, names and ids', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [
      existsPath('p1', 'VIP', '.vip'),
      existsPath('p2', 'Member', '.member'),
      existsPath('p3', '', '.guest'),
    ]);
    const back = NM.readPaths(params);
    expect(back.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(back.map((p) => p.name)).toEqual(['VIP', 'Member', '']);
    expect(back[1].groups[0][0].selector).toBe('.member');
    expect(NM.isMultiPath(params)).toBe(true);
  });

  it('path 1 is always mirrored into the legacy flat fields', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', 'first', '.first'), existsPath('p2', 'second', '.second')]);
    expect(params.selector).toBe('.first');
    expect(NM.readGroups(params)[0][0].selector).toBe('.first');
  });

  it('duplicate ids are re-keyed, so two paths can never share a canvas port', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', 'a', '.a'), existsPath('p1', 'b', '.b')]);
    const ids = NM.readPaths(params).map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('a hostile id (with a colon) cannot break the `path:<id>` port key', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [
      existsPath('p1', 'ok', '.a'),
      { id: 'evil:port', name: 'x', groups: [[{ operator: 'exists', selector: '.b' } as Row]] },
    ]);
    NM.readPaths(params).forEach((p) => expect(p.id).not.toContain(':'));
  });

  it('the list is capped at 20 paths (Automa parity, rule R1)', () => {
    expect(NM.CONDITION_MAX_PATHS).toBe(20);
    const many: Path[] = [];
    for (let i = 0; i < 30; i++) many.push(existsPath('p' + (i + 1), 'n' + i, '.s' + i));
    const params: Record<string, unknown> = {};
    NM.writePaths(params, many);
    expect(NM.readPaths(params)).toHaveLength(20);
  });

  it('pathLabel falls back to "Path n" and pathsSummary skips unconfigured paths', () => {
    const t = (k: string) => (k === 'cb.path' ? 'Path' : k);
    expect(NM.pathLabel({ id: 'p2', name: '  ', groups: [] } as Path, 1, t)).toBe('Path 2');
    expect(NM.pathLabel({ id: 'p2', name: 'VIP', groups: [] } as Path, 1, t)).toBe('VIP');

    const params: Record<string, unknown> = {};
    NM.writePaths(params, [
      existsPath('p1', 'VIP', '.vip'),
      { id: 'p2', name: 'Empty', groups: [[NM.blankRow()]] },
    ]);
    const sum = NM.pathsSummary(params, t);
    expect(sum).toContain('VIP');
    expect(sum).not.toContain('Empty');
  });
});

// ===========================================================================
// 2. SERIALIZER — canvas ports <-> backend steps
// ===========================================================================
describe('mission 7 · serializer — `path:<id>` ports become ordered step paths', () => {
  it('the catalog declares `paths` as an INTERNAL field (else it is dropped on save)', () => {
    const act = catalog.ACTIONS.find((a) => a.id === 'if')!;
    const f = act.fields.find((x) => x.k === 'paths');
    expect(f, '`if` must declare a `paths` field').toBeTruthy();
    expect(f!.internal, '`paths` is a JSON blob, never a raw text input').toBe(true);
  });

  it('`paths` is stripped from step.params — it lives in step.paths only', () => {
    expect(GS.CONDITION_ONLY_PARAMS).toContain('paths');
  });

  it('a single-path node still serialises to the classic then/else shape', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', '', '.only')]);
    const node: GraphNode = { id: 'n1', action: 'if', params, x: 0, y: 0 };
    const steps = GS.graphToSteps(graphWithNode(node, [logStep('n2', 'yes')],
      [{ from: 'n1', to: 'n2', port: 'then' }]));
    const ifStep = steps.find((s) => s.action === 'if')!;
    expect(ifStep.paths).toBeUndefined();
    expect(ifStep.then).toHaveLength(1);
    expect(ifStep.condition).toEqual({ operator: 'exists', selector: '.only' });
  });

  it('a multi-path node emits ordered `paths`, each with its own branch steps', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [
      existsPath('p1', 'VIP', '.vip'),
      existsPath('p2', 'Member', '.member'),
    ]);
    const node: GraphNode = { id: 'n1', action: 'if', params, x: 0, y: 0 };
    const graph = graphWithNode(node, [logStep('a', 'vip'), logStep('b', 'member'), logStep('c', 'neutral')], [
      { from: 'n1', to: 'a', port: 'path:p1' },
      { from: 'n1', to: 'b', port: 'path:p2' },
      { from: 'n1', to: 'c', port: 'next' },
    ]);
    const steps = GS.graphToSteps(graph);
    const ifStep = steps.find((s) => s.action === 'if')!;

    expect(ifStep.paths).toHaveLength(2);
    expect(ifStep.paths!.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(ifStep.paths!.map((p) => p.name)).toEqual(['VIP', 'Member']);
    expect(ifStep.paths![0].condition).toEqual({ operator: 'exists', selector: '.vip' });
    expect(ifStep.paths![0].steps![0].params!.message).toBe('vip');
    expect(ifStep.paths![1].steps![0].params!.message).toBe('member');
    // then/else must NOT also be emitted, or the backend could run both routings
    expect(ifStep.then).toBeUndefined();
    expect(ifStep.else).toBeUndefined();
    // the neutral chain continues AFTER the node, as the `next` port always did
    expect(steps[steps.length - 1].params!.message).toBe('neutral');
  });

  it('the condition params never leak into step.params of a multi-path node', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', 'a', '.a'), existsPath('p2', 'b', '.b')]);
    const node: GraphNode = { id: 'n1', action: 'if', params, x: 0, y: 0 };
    const ifStep = GS.graphToSteps(graphWithNode(node)).find((s) => s.action === 'if')!;
    const keys = Object.keys(ifStep.params || {});
    GS.CONDITION_ONLY_PARAMS.forEach((k) => expect(keys).not.toContain(k));
  });

  it('parsePaths returns null for one path and the list for many', () => {
    const one: Record<string, unknown> = {};
    NM.writePaths(one, [existsPath('p1', '', '.a')]);
    expect(GS.parsePaths(one)).toBeNull();

    const two: Record<string, unknown> = {};
    NM.writePaths(two, [existsPath('p1', '', '.a'), existsPath('p2', '', '.b')]);
    expect(GS.parsePaths(two)).toHaveLength(2);
    expect(GS.pathPortId('p2')).toBe('path:p2');
  });

  it('an imported multi-path workflow round-trips back to the same steps', () => {
    const original: Step[] = [
      {
        action: 'if',
        paths: [
          { id: 'p1', name: 'VIP', condition: { operator: 'exists', selector: '.vip' }, steps: [{ action: 'log', params: { message: 'vip' } }] },
          { id: 'p2', name: 'Member', condition: { operator: 'exists', selector: '.member' }, steps: [{ action: 'log', params: { message: 'member' } }] },
        ],
      },
      { action: 'log', params: { message: 'neutral' } },
    ];
    const graph = GS.stepsToGraph(original);
    const back = GS.graphToSteps(graph);
    const ifStep = back.find((s) => s.action === 'if')!;
    expect(ifStep.paths!.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(ifStep.paths!.map((p) => p.name)).toEqual(['VIP', 'Member']);
    expect(ifStep.paths![0].condition).toEqual({ operator: 'exists', selector: '.vip' });
    expect(ifStep.paths![1].steps![0].params!.message).toBe('member');
    expect(back[back.length - 1].params!.message).toBe('neutral');
  });

  it('the outline mirrors one row per path, in priority order', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', 'VIP', '.vip'), existsPath('p2', 'Member', '.member')]);
    const node: GraphNode = { id: 'n1', action: 'if', params, x: 0, y: 0 };
    const graph = graphWithNode(node, [logStep('a', 'vip'), logStep('b', 'member')], [
      { from: 'n1', to: 'a', port: 'path:p1' },
      { from: 'n1', to: 'b', port: 'path:p2' },
    ]);
    const ports = GS.outlineTree(graph).filter((r) => r.kind === 'port').map((r) => r.port);
    expect(ports).toEqual(['path:p1', 'path:p2']);
  });

  it('a multi-path node with every path unwired warns "empty-if", and stops warning once one is wired', () => {
    const params: Record<string, unknown> = {};
    NM.writePaths(params, [existsPath('p1', 'a', '.a'), existsPath('p2', 'b', '.b')]);
    const node: GraphNode = { id: 'n1', action: 'if', params, x: 0, y: 0 };

    const bare = GS.validateGraph(graphWithNode(node));
    expect(bare.warnings.some((w) => w.code === 'empty-if')).toBe(true);

    const wired = GS.validateGraph(graphWithNode(node, [logStep('a', 'x')],
      [{ from: 'n1', to: 'a', port: 'path:p2' }]));
    expect(wired.warnings.some((w) => w.code === 'empty-if')).toBe(false);
  });
});

// ===========================================================================
// 3. VALIDATION — paths must survive server-side sanitisation
// ===========================================================================
describe('mission 7 · validation — paths reach the pipeline intact', () => {
  it('keeps id / name / condition and recurses into every path\'s steps', () => {
    const clean = validateSteps([
      {
        action: 'if',
        paths: [
          { id: 'p1', name: 'VIP', condition: { operator: 'exists', selector: '.vip' }, steps: [{ action: 'log', params: { message: 'vip' } }] },
          { id: 'p2', name: 'Member', condition: { operator: 'exists', selector: '.m' }, steps: [{ action: 'log', params: { message: 'm' } }] },
        ],
      },
    ]) as unknown as Step[];
    const paths = clean[0].paths!;
    expect(paths).toHaveLength(2);
    expect(paths[0].id).toBe('p1');
    expect(paths[0].name).toBe('VIP');
    expect(paths[0].condition).toEqual({ operator: 'exists', selector: '.vip' });
    expect(paths[0].steps![0].action).toBe('log');
    expect(paths[1].steps![0].params!.message).toBe('m');
  });

  it('never turns `paths` into a params blob on a legacy-shaped step', () => {
    const clean = validateSteps([
      { action: 'if', paths: [{ id: 'p1', condition: { operator: 'exists' } }], selector: '.a' },
    ]) as unknown as Step[];
    expect(clean[0].params!.paths).toBeUndefined();
    expect(clean[0].paths).toHaveLength(1);
  });

  it('a path missing an id still gets one, so routing stays addressable', () => {
    const clean = validateSteps([
      { action: 'if', paths: [{ condition: { operator: 'exists' } }, { condition: { operator: 'exists' } }] },
    ]) as unknown as Step[];
    expect(clean[0].paths!.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});

// ===========================================================================
// 4. RUNTIME — first match wins, otherwise the neutral port
// ===========================================================================
describe('mission 7 · runtime — pickConditionPath', () => {
  const P = (id: string, flag: string): StepPath => ({ id, condition: { operator: 'exists', selector: flag } });

  it('takes the FIRST true path even when a later one is also true', async () => {
    const truthy = new Set(['.b', '.c']);
    const idx = await pickConditionPath([P('p1', '.a'), P('p2', '.b'), P('p3', '.c')],
      (c) => truthy.has(c.selector));
    expect(idx).toBe(1);
  });

  it('short-circuits: nothing below the winner is evaluated', async () => {
    const seen: string[] = [];
    const evaluate = vi.fn((c: any) => { seen.push(c.selector); return c.selector === '.b'; });
    const idx = await pickConditionPath([P('p1', '.a'), P('p2', '.b'), P('p3', '.c')], evaluate);
    expect(idx).toBe(1);
    expect(seen).toEqual(['.a', '.b']);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('returns -1 when no path matches — the run leaves through the neutral `next`', async () => {
    const idx = await pickConditionPath([P('p1', '.a'), P('p2', '.b')], () => false);
    expect(idx).toBe(-1);
  });

  it('respects order after a reorder (priority is the array order, nothing else)', async () => {
    const paths = [P('p1', '.a'), P('p2', '.b')];
    const truthy = (c: any) => c.selector === '.a' || c.selector === '.b';
    expect(await pickConditionPath(paths, truthy)).toBe(0);
    expect(await pickConditionPath([paths[1], paths[0]], truthy)).toBe(0);
    expect((await pickConditionPath([paths[1], paths[0]], truthy)) === 0 ? paths[1].id : '').toBe('p2');
  });

  it('a path with no condition can never claim the route', async () => {
    const idx = await pickConditionPath([{ id: 'p1' }, P('p2', '.b')], (c) => c.selector === '.b');
    expect(idx).toBe(1);
    expect(await pickConditionPath([{ id: 'p1' }], () => true)).toBe(-1);
  });

  it('awaits async evaluators (the real ConditionEngine is async)', async () => {
    const idx = await pickConditionPath([P('p1', '.a'), P('p2', '.b')],
      async (c) => { await new Promise((r) => setTimeout(r, 1)); return c.selector === '.b'; });
    expect(idx).toBe(1);
  });

  it('an absent or empty list is not a route', async () => {
    expect(await pickConditionPath(undefined, () => true)).toBe(-1);
    expect(await pickConditionPath([], () => true)).toBe(-1);
  });
});
