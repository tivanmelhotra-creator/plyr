/**
 * Task 3 — conditional nodes: If / Router, JOIN serialisation, graphs that
 * cannot become steps[].
 *
 * Part 1 drives the DOM-free serializer (public/js/graph-serialize.js) under a
 * node:vm `window` shim, exactly like graph-serialize.test.ts.
 * Part 2 runs the Router through the REAL pipeline (only the browser is faked)
 * using `variable`-sourced conditions, which never touch the DOM.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'events';

vi.mock('../../src/core/BrowserAdapter', async (orig) => {
  const mod = await orig<typeof import('../../src/core/BrowserAdapter')>();
  return { ...mod, acquireContext: vi.fn() };
});

import { runPipeline } from '../../src/pipeline';
import { browserModes } from '../../src/core/BrowserMode';
import { acquireContext } from '../../src/core/BrowserAdapter';
import { validateSteps } from '../../src/validation';
import { config } from '../../src/config';

interface Edge { from: string; to: string; port?: string }
interface Node { id: string; action: string; params?: Record<string, unknown>; disabled?: boolean }
interface Graph { nodes: Record<string, Node>; edges: Edge[]; nextId?: number }
interface Step { action: string; params?: Record<string, any>; condition?: any; then?: Step[]; else?: Step[];
  steps?: Step[]; paths?: { id: string; name?: string; condition?: any; steps?: Step[] }[]; fallback?: Step[];
  cases?: Record<string, Step[]>; catch?: Step[]; finally?: Step[] }
interface Issue { code: string; nodeId?: string; edge?: Edge; message: string }
interface GSApi {
  graphToSteps: (g: Graph) => Step[];
  stepsToGraph: (s: Step[]) => Graph;
  validateGraph: (g: Graph) => { ok: boolean; errors: Issue[]; warnings: Issue[] };
  outlineTree: (g: Graph) => { nodeId: string; port: string; num: string; kind: string }[];
}

let GS: GSApi;
let CATALOG: { ACTIONS: { id: string; fields: { k: string }[]; branches?: { id: string }[] }[] };

beforeAll(() => {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['actions.js', 'graph-serialize.js']) {
    vm.runInContext(readFileSync(join(__dirname, '..', '..', 'public', 'js', f), 'utf8'), sandbox, { filename: f });
  }
  GS = sandbox.window.GraphSerialize as GSApi;
  CATALOG = sandbox.window.ACTION_CATALOG as never;
});

function graph(nodes: Node[], edges: Edge[]): Graph {
  const map: Record<string, Node> = { start: { id: 'start', action: '__start__', params: {} } };
  nodes.forEach((n) => { map[n.id] = { params: {}, ...n }; });
  return { nodes: map, edges, nextId: nodes.length };
}
const L = (id: string): Node => ({ id, action: 'log', params: { message: id } });
const IF = (id: string): Node => ({ id, action: 'if', params: { operator: 'exists', selector: '.x' } });
const msgs = (steps: Step[] | undefined): string[] => (steps || []).map((s) => String(s.params?.message ?? s.action));

/** A multi-path / router `paths` blob: each path is `variable <name> equals <v>`. */
const pathsParam = (defs: [string, string, string][]) =>
  JSON.stringify(defs.map(([id, name, v]) => ({
    id, name,
    groups: [[{ source: 'variable', operator: 'equals', value: 'k', expected: v }]],
  })));
const ROUTER = (id: string, defs: [string, string, string][]): Node =>
  ({ id, action: 'router', params: { paths: pathsParam(defs) } });

// ───────────────────────────────────────────────────────────────────────────
describe('JOIN — nodes after the convergence point', () => {
  it('(a) both branches reach one node: it is emitted ONCE, after the if', () => {
    const g = graph([IF('i'), L('A'), L('B'), L('J')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'then' }, { from: 'i', to: 'B', port: 'else' },
      { from: 'A', to: 'J' }, { from: 'B', to: 'J' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps).toHaveLength(2);
    expect(steps[0].action).toBe('if');
    expect(msgs(steps[0].then)).toEqual(['A']);
    expect(msgs(steps[0].else)).toEqual(['B']);
    expect(msgs([steps[1]])).toEqual(['J']);
    expect(GS.validateGraph(g)).toMatchObject({ ok: true, warnings: [] });
  });

  it('else wired straight to the join node leaves `else` empty', () => {
    const g = graph([IF('i'), L('A'), L('J')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'then' }, { from: 'i', to: 'J', port: 'else' },
      { from: 'A', to: 'J' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(msgs(steps[0].then)).toEqual(['A']);
    expect(steps[0].else).toBeUndefined();
    expect(msgs([steps[1]])).toEqual(['J']);
  });

  it('an explicit `next` wire on the if is the join, with or without branch convergence', () => {
    const g = graph([IF('i'), L('A'), L('B'), L('J')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'then' }, { from: 'i', to: 'B', port: 'else' },
      { from: 'i', to: 'J', port: 'next' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps.map((s) => s.action)).toEqual(['if', 'log']);
    expect(msgs(steps[0].then)).toEqual(['A']);
    expect(msgs(steps[0].else)).toEqual(['B']);
  });

  it('a chain after the join (J -> K) stays in the parent chain', () => {
    const g = graph([IF('i'), L('A'), L('B'), L('J'), L('K')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'then' }, { from: 'i', to: 'B', port: 'else' },
      { from: 'A', to: 'J' }, { from: 'B', to: 'J' }, { from: 'J', to: 'K' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps.map((s) => s.action)).toEqual(['if', 'log', 'log']);
    expect(msgs(steps.slice(1))).toEqual(['J', 'K']);
  });

  it('(d) a branch that ends early keeps the other branch and the join intact', () => {
    const g = graph([IF('i'), L('A'), L('B'), L('Z')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'then' }, { from: 'A', to: 'B' },
      { from: 'i', to: 'Z', port: 'next' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(msgs(steps[0].then)).toEqual(['A', 'B']);
    expect(steps[0].else).toBeUndefined();
    expect(msgs([steps[1]])).toEqual(['Z']);
  });

  it('(b) If inside If: nested then/else, no leakage between levels', () => {
    const g = graph([IF('i'), IF('i2'), L('A'), L('B'), L('C')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'i2', port: 'then' },
      { from: 'i2', to: 'A', port: 'then' }, { from: 'i2', to: 'B', port: 'else' },
      { from: 'i', to: 'C', port: 'else' },
    ]);
    const [outer] = GS.graphToSteps(g);
    expect(outer.then).toHaveLength(1);
    expect(outer.then![0].action).toBe('if');
    expect(msgs(outer.then![0].then)).toEqual(['A']);
    expect(msgs(outer.then![0].else)).toEqual(['B']);
    expect(msgs(outer.else)).toEqual(['C']);
  });

  it('(b) nested ifs that all converge on one node: ONE copy, after the outer if', () => {
    const g = graph([IF('i'), IF('i2'), L('A'), L('B'), L('C'), L('J')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'i2', port: 'then' },
      { from: 'i2', to: 'A', port: 'then' }, { from: 'i2', to: 'B', port: 'else' },
      { from: 'i', to: 'C', port: 'else' },
      { from: 'A', to: 'J' }, { from: 'B', to: 'J' }, { from: 'C', to: 'J' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps).toHaveLength(2);
    expect(msgs([steps[1]])).toEqual(['J']);
    const flat = JSON.stringify(steps);
    expect(flat.match(/"message":"J"/g)).toHaveLength(1);
  });

  it('(b) an inner join that is NOT the outer join stays inside its branch', () => {
    // i.then -> i2 ; i2.then/else -> M ; M ends. i.else -> C. Outer never meets.
    const g = graph([IF('i'), IF('i2'), L('A'), L('B'), L('M'), L('C')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'i2', port: 'then' },
      { from: 'i2', to: 'A', port: 'then' }, { from: 'i2', to: 'B', port: 'else' },
      { from: 'A', to: 'M' }, { from: 'B', to: 'M' },
      { from: 'i', to: 'C', port: 'else' },
    ]);
    const [outer, ...rest] = GS.graphToSteps(g);
    expect(rest).toEqual([]);
    expect(outer.then!.map((s) => s.action)).toEqual(['if', 'log']);
    expect(msgs([outer.then![1]])).toEqual(['M']);
    expect(msgs(outer.else)).toEqual(['C']);
  });

  it('(c) a loop and a try inside a branch serialise inside that branch', () => {
    const g = graph([
      IF('i'),
      { id: 'L', action: 'loop', params: { count: '2' } }, L('body'), L('afterLoop'),
      { id: 'T', action: 'try', params: {} }, L('risky'), L('handler'),
    ], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'L', port: 'then' },
      { from: 'L', to: 'body', port: 'body' }, { from: 'L', to: 'afterLoop', port: 'done' },
      { from: 'i', to: 'T', port: 'else' },
      { from: 'T', to: 'risky', port: 'try' }, { from: 'T', to: 'handler', port: 'catch' },
    ]);
    const [step] = GS.graphToSteps(g);
    expect(step.then!.map((s) => s.action)).toEqual(['loop', 'log']);
    expect(msgs(step.then![0].steps)).toEqual(['body']);
    expect(msgs(step.then!.slice(1))).toEqual(['afterLoop']);
    expect(step.else![0].action).toBe('try');
    expect(msgs(step.else![0].steps)).toEqual(['risky']);
    expect(msgs(step.else![0].catch)).toEqual(['handler']);
  });

  it('a join after a SWITCH is also hoisted out of the cases', () => {
    const g = graph([
      { id: 's', action: 'switch', params: { variable: 'k', casesList: 'a,b' } }, L('A'), L('B'), L('D'), L('J'),
    ], [
      { from: 'start', to: 's' },
      { from: 's', to: 'A', port: 'case:a' }, { from: 's', to: 'B', port: 'case:b' }, { from: 's', to: 'D', port: 'default' },
      { from: 'A', to: 'J' }, { from: 'B', to: 'J' }, { from: 'D', to: 'J' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps.map((s) => s.action)).toEqual(['switch', 'log']);
    expect(Object.keys(steps[0].cases!).sort()).toEqual(['a', 'b', 'default']);
    expect(msgs(steps[0].cases!.a)).toEqual(['A']);
  });

  it('a partial join (not every branch reaches it) is duplicated and WARNED about', () => {
    // then -> A -> X ; else -> B (never reaches X) ; i.next -> X is NOT wired.
    const g = graph([IF('i'), L('A'), L('B'), L('X'), L('Y')], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'then' }, { from: 'i', to: 'B', port: 'else' },
      { from: 'A', to: 'X' }, { from: 'X', to: 'Y' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps).toHaveLength(1);
    expect(msgs(steps[0].then)).toEqual(['A', 'X', 'Y']);
    expect(msgs(steps[0].else)).toEqual(['B']);
    expect(GS.validateGraph(g).ok).toBe(true);
  });

  it('a node fed by two NON-converging branches is reported as `duplicated`', () => {
    // then -> A -> X ; else -> B -> X, but a third branch exists that skips X.
    const g = graph([ROUTER('r', [['p1', 'one', '1'], ['p2', 'two', '2']]), L('A'), L('B'), L('C'), L('X')], [
      { from: 'start', to: 'r' },
      { from: 'r', to: 'A', port: 'path:p1' }, { from: 'r', to: 'B', port: 'path:p2' }, { from: 'r', to: 'C', port: 'default' },
      { from: 'A', to: 'X' }, { from: 'B', to: 'X' },
    ]);
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.code)).toContain('duplicated');
    expect(res.warnings.find((w) => w.code === 'duplicated')!.nodeId).toBe('X');
  });

  it('a multi-path If keeps Mission-7 semantics: `next` is the neutral port, never a join', () => {
    const g = graph([
      { id: 'i', action: 'if', params: { paths: pathsParam([['p1', 'a', '1'], ['p2', 'b', '2']]) } },
      L('A'), L('B'), L('N'),
    ], [
      { from: 'start', to: 'i' },
      { from: 'i', to: 'A', port: 'path:p1' }, { from: 'i', to: 'B', port: 'path:p2' },
      { from: 'i', to: 'N', port: 'next' },
    ]);
    const steps = GS.graphToSteps(g);
    expect(steps.map((s) => s.action)).toEqual(['if', 'log']);
    expect(steps[0].paths).toHaveLength(2);
    expect(msgs(steps[0].paths![0].steps)).toEqual(['A']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('graphs that cannot be turned into steps[] are REJECTED, not silently cut', () => {
  it('(e) a back-edge is a `cycle` error that names the node and the edge', () => {
    const g = graph([L('A'), L('B')], [
      { from: 'start', to: 'A' }, { from: 'A', to: 'B' }, { from: 'B', to: 'A' },
    ]);
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(false);
    const cyc = res.errors.find((e) => e.code === 'cycle')!;
    expect(cyc.nodeId).toBe('A');
    expect(cyc.edge).toEqual({ from: 'B', to: 'A', port: 'next' });
    expect(cyc.message).toBe('val.cycle');
  });

  it('a cycle through a branch (then -> ... -> the if itself) is a cycle', () => {
    const g = graph([IF('i'), L('A')], [
      { from: 'start', to: 'i' }, { from: 'i', to: 'A', port: 'then' }, { from: 'A', to: 'i' },
    ]);
    expect(GS.validateGraph(g).errors.map((e) => e.code)).toContain('cycle');
  });

  it('a loop body is NOT a cycle: loop -> body -> (back to nothing) -> done', () => {
    const g = graph([{ id: 'L', action: 'loop', params: { count: '3' } }, L('b'), L('after')], [
      { from: 'start', to: 'L' }, { from: 'L', to: 'b', port: 'body' }, { from: 'L', to: 'after', port: 'done' },
    ]);
    expect(GS.validateGraph(g).ok).toBe(true);
  });

  it('two edges leaving ONE port are a `fanout` error (the runtime follows one)', () => {
    const g = graph([L('A'), L('B'), L('C')], [
      { from: 'start', to: 'A' }, { from: 'A', to: 'B' }, { from: 'A', to: 'C' },
    ]);
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(false);
    expect(res.errors.find((e) => e.code === 'fanout')).toMatchObject({ nodeId: 'A', edge: { from: 'A', to: 'C', port: 'next' } });
  });

  it('an edge to a node that does not exist is `dangling`', () => {
    const g = graph([L('A')], [{ from: 'start', to: 'A' }, { from: 'A', to: 'ghost' }]);
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(false);
    expect(res.errors.find((e) => e.code === 'dangling')).toMatchObject({ nodeId: 'A' });
  });

  it('every new rejection code has an i18n message key', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'i18n.js'), 'utf8');
    for (const k of ['val.cycle', 'val.fanout', 'val.dangling', 'val.duplicated', 'val.routerPaths']) {
      expect(src.match(new RegExp(`'${k.replace('.', '\\.')}':`, 'g')), k).toHaveLength(2); // fa + en
    }
  });

  it('a healthy branching graph reports no error and no warning', () => {
    const g = graph([IF('i'), L('A'), L('B')], [
      { from: 'start', to: 'i' }, { from: 'i', to: 'A', port: 'then' }, { from: 'i', to: 'B', port: 'else' },
    ]);
    expect(GS.validateGraph(g)).toMatchObject({ ok: true, errors: [], warnings: [] });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Router — serialisation, round-trip, catalog', () => {
  const routerGraph = () => graph(
    [ROUTER('r', [['vip', 'VIP', 'vip'], ['std', 'Standard', 'std']]), L('A'), L('B'), L('D'), L('J')],
    [
      { from: 'start', to: 'r' },
      { from: 'r', to: 'A', port: 'path:vip' }, { from: 'r', to: 'B', port: 'path:std' },
      { from: 'r', to: 'D', port: 'default' },
      { from: 'A', to: 'J' }, { from: 'B', to: 'J' }, { from: 'D', to: 'J' },
    ],
  );

  it('emits ordered paths + `fallback`, and the join after the router', () => {
    const steps = GS.graphToSteps(routerGraph());
    expect(steps.map((s) => s.action)).toEqual(['router', 'log']);
    const r = steps[0];
    expect(r.paths!.map((p) => p.id)).toEqual(['vip', 'std']);
    expect(r.paths![0].name).toBe('VIP');
    expect(r.paths![0].condition).toMatchObject({ source: 'variable', operator: 'equals', expected: 'vip' });
    expect(msgs(r.paths![0].steps)).toEqual(['A']);
    expect(msgs(r.fallback)).toEqual(['D']);
    expect(msgs([steps[1]])).toEqual(['J']);
  });

  it('a Router with ONE path stays a router (it has no true/false form)', () => {
    const g = graph([ROUTER('r', [['p1', 'only', '1']]), L('A')], [
      { from: 'start', to: 'r' }, { from: 'r', to: 'A', port: 'path:p1' },
    ]);
    const [r] = GS.graphToSteps(g);
    expect(r.action).toBe('router');
    expect(r.paths).toHaveLength(1);
  });

  it('steps -> graph -> steps is stable for a router (paths, fallback and join)', () => {
    const steps = GS.graphToSteps(routerGraph());
    const back = GS.graphToSteps(GS.stepsToGraph(steps));
    expect(back).toEqual(steps);
  });

  it('importing a router puts the default lane on the `default` port', () => {
    const g = GS.stepsToGraph(GS.graphToSteps(routerGraph()));
    const rNode = Object.values(g.nodes).find((n) => n.action === 'router')!;
    const ports = g.edges.filter((e) => e.from === rNode.id).map((e) => e.port);
    expect(ports.sort()).toEqual(['default', 'next', 'path:std', 'path:vip']);
  });

  it('a Router with no path is a validation ERROR; a wired-nowhere Router only a warning', () => {
    const none = graph([{ id: 'r', action: 'router', params: { paths: '[]' } }], [{ from: 'start', to: 'r' }]);
    const bad = GS.validateGraph(none);
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.code)).toContain('router-paths');
    // one path but nothing wired to any output: valid, with a warning
    const g = graph([ROUTER('r', [['p1', 'a', '1']])], [{ from: 'start', to: 'r' }]);
    const ok = GS.validateGraph(g);
    expect(ok.ok).toBe(true);
    expect(ok.warnings.map((w) => w.code)).toContain('empty-if');
  });

  it('the outline lists the router paths and the default port', () => {
    const rows = GS.outlineTree(routerGraph());
    const ports = rows.filter((r) => r.kind === 'port').map((r) => r.port);
    expect(ports).toEqual(['path:vip', 'path:std', 'default']);
    expect(rows.filter((r) => r.nodeId === 'J')).toHaveLength(1);
  });

  it('the catalog declares every param the builder writes, so none is dropped on save (R3)', () => {
    const act = CATALOG.ACTIONS.find((a) => a.id === 'router')!;
    expect(act).toBeTruthy();
    const keys = act.fields.map((f) => f.k);
    for (const k of ['groups', 'paths', 'source', 'attribute', 'selector', 'operator', 'value', 'expected']) {
      expect(keys).toContain(k);
    }
    expect(act.branches!.map((b) => b.id)).toEqual(['default']);
  });

  it('the Router shares the Condition Builder with If (one designed NDV, one engine)', () => {
    const model = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'ndv-model.js'), 'utf8');
    expect(model).toMatch(/router:\s*'ndv-condition-final'/);
    const nodes = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'ndv-nodes.js'), 'utf8');
    expect(nodes).toMatch(/action === 'router'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Runtime
class FakePage extends EventEmitter {
  closed = false;
  url() { return 'https://fake.test/page'; }
  isClosed() { return this.closed; }
  async title() { return 'Fake'; }
}
class FakeContext extends EventEmitter {
  all: FakePage[] = [new FakePage()];
  pages() { return this.all; }
  async newPage() { const p = new FakePage(); this.all.push(p); return p; }
  async close() {}
}
const plan = { quota: 1000, maxTabs: 3, maxSteps: 100, priority: 99, maxSchedules: 5, runLimit: 0 } as never;
const quotaManager = { hasQuotaRemaining: async () => true, consumeQuota: vi.fn(async () => {}) } as never;
function profileManager() {
  const outputs: unknown[] = [];
  const base: Record<string, unknown> = { getJobOutputs: () => outputs };
  return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : vi.fn()) }) as never;
}
type Ev = { type: string; data: Record<string, any> };
async function run(steps: unknown[]) {
  const events: Ev[] = [];
  const logs: string[] = [];
  let result: any; let error: any;
  try {
    result = await runPipeline({
      userId: 'tester', steps: validateSteps(steps as never, config.FULL_ACCESS_PLAN) as never,
      log: (m: string) => logs.push(m), jobId: 'job-router', profileManager: profileManager(),
      userPlan: plan, quotaManager,
      onEvent: (type: string, data?: Record<string, unknown>) => events.push({ type, data: (data || {}) as any }),
    } as never);
  } catch (e) { error = e; }
  const user = logs.filter((l) => l.startsWith('[USER] ')).map((l) => l.slice(7));
  return { result, error, events, logs, user };
}

describe('Router at runtime (real pipeline)', () => {
  beforeEach(() => {
    vi.spyOn(browserModes, 'modeOf').mockReturnValue('local');
    vi.mocked(acquireContext).mockReset();
    vi.mocked(acquireContext).mockResolvedValue({ context: new FakeContext(), mode: 'remote', shared: true, detail: 't' } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const cond = (v: string) => ({ source: 'variable', operator: 'equals', value: 'k', expected: v });
  const say = (m: string) => ({ action: 'log', params: { message: m } });
  const setK = (v: string) => ({ action: 'set_variable', params: { name: 'k', value: v } });
  const router = () => ({
    action: 'router',
    paths: [
      { id: 'p1', name: 'one', condition: cond('1'), steps: [say('path1')] },
      { id: 'p2', name: 'two', condition: cond('2'), steps: [say('path2')] },
    ],
    fallback: [say('default')],
  });

  it('the first matching path runs, the others and the default do not; the join runs after', async () => {
    const { result, user } = await run([setK('2'), router(), say('join')]);
    expect(result.success).toBe(true);
    expect(user).toEqual(['path2', 'join']);
  });

  it('FIRST match wins when several paths are true', async () => {
    const steps = [setK('1'), {
      action: 'router',
      paths: [
        { id: 'p1', condition: cond('1'), steps: [say('first')] },
        { id: 'p2', condition: cond('1'), steps: [say('second')] },
      ],
    }, say('join')];
    const { user } = await run(steps);
    expect(user).toEqual(['first', 'join']);
  });

  it('no match takes the DEFAULT branch, then the join', async () => {
    const { user, events } = await run([setK('zzz'), router(), say('join')]);
    expect(user).toEqual(['default', 'join']);
    const ev = events.find((e) => e.type === 'step.path')!;
    expect(ev.data).toMatchObject({ action: 'router', path: 'default' });
  });

  it('no match and no default: the router is a no-op and the run continues', async () => {
    const { result, user } = await run([setK('zzz'), { action: 'router', paths: [{ id: 'p1', condition: cond('1'), steps: [say('x')] }] }, say('join')]);
    expect(result.success).toBe(true);
    expect(user).toEqual(['join']);
  });

  it('an empty matched path still lets the join run', async () => {
    const { user } = await run([setK('1'), { action: 'router', paths: [{ id: 'p1', condition: cond('1') }] }, say('join')]);
    expect(user).toEqual(['join']);
  });

  it('emits step.path for the matched path and closes every step it opened', async () => {
    const { events } = await run([setK('1'), router(), say('join')]);
    const pathEv = events.find((e) => e.type === 'step.path')!;
    expect(pathEv.data).toMatchObject({ action: 'router', path: 'p1', priority: 1 });
    const started = events.filter((e) => e.type === 'step.start').map((e) => e.data.index);
    const closed = new Set(events.filter((e) => e.type === 'step.done' || e.type === 'step.error').map((e) => e.data.index));
    started.forEach((i) => expect(closed.has(i), `step ${i} left open`).toBe(true));
  });

  it('a router nested in a router branch works (If-in-If equivalent)', async () => {
    const inner = { action: 'router', paths: [{ id: 'q1', condition: cond('1'), steps: [say('inner')] }], fallback: [say('inner-default')] };
    const outer = { action: 'router', paths: [{ id: 'p1', condition: cond('1'), steps: [inner, say('after-inner')] }], fallback: [say('outer-default')] };
    const { user } = await run([setK('1'), outer, say('join')]);
    expect(user).toEqual(['inner', 'after-inner', 'join']);
  });

  it('survives validateSteps: `fallback` and nested `paths` are kept (not stripped)', () => {
    const cleaned = validateSteps([router()] as never, config.FULL_ACCESS_PLAN) as any[];
    expect(cleaned[0].paths).toHaveLength(2);
    expect(cleaned[0].fallback).toHaveLength(1);
    expect(cleaned[0].fallback[0].action).toBe('log');
  });

  it('a `break` from inside a router branch propagates out of the enclosing loop', async () => {
    const { user } = await run([setK('1'), {
      action: 'loop', params: { count: '3' }, steps: [
        { action: 'router', paths: [{ id: 'p1', condition: cond('1'), steps: [say('hit'), { action: 'break' }] }] },
        say('not-reached'),
      ],
    }, say('after-loop')]);
    expect(user).toEqual(['hit', 'after-loop']);
  });
});
