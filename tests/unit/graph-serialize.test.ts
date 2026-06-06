/**
 * graph-serialize.test.ts — Step 24
 *
 * The visual editor serialises a NON-LINEAR node graph (with branching nodes:
 * if/switch/loop/foreach/while/try) into the backend's nested AutomationStep
 * shape (then/else/cases/steps/catch/finally) and back. That logic lives in the
 * DOM-free module public/js/graph-serialize.js.
 *
 * This test loads actions.js (for window.ACTION_CATALOG) + graph-serialize.js
 * under a minimal `window` shim via node:vm (no jsdom dependency) and asserts:
 *   - linear graphs round-trip unchanged
 *   - if/switch/loop/foreach/while/try produce the exact backend nesting
 *   - deserialize(serialize(x)) is structurally stable for branching graphs
 *   - validateGraph flags orphan nodes, empty graphs and missing params
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Edge { from: string; to: string; port?: string }
interface Node { id: string; action: string; params?: Record<string, unknown>; x?: number; y?: number }
interface Graph { nodes: Record<string, Node>; edges: Edge[]; nextId?: number }
interface Step { action: string; params?: Record<string, unknown>; condition?: any;
  then?: Step[]; else?: Step[]; steps?: Step[]; catch?: Step[]; finally?: Step[];
  cases?: Record<string, Step[]> }
interface ValResult { ok: boolean; errors: { code: string; nodeId?: string }[]; warnings: { code: string; nodeId?: string }[] }
interface GS {
  graphToSteps: (g: Graph) => Step[];
  stepsToGraph: (s: Step[]) => Graph;
  validateGraph: (g: Graph) => ValResult;
}

let GS: GS;

beforeAll(() => {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['actions.js', 'graph-serialize.js']) {
    const code = readFileSync(join(__dirname, '..', '..', 'public', 'js', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  GS = sandbox.window.GraphSerialize as GS;
  if (!GS) throw new Error('graph-serialize.js did not expose window.GraphSerialize');
});

// Build a graph from a compact node list + edges (start node added implicitly).
function graph(nodes: Node[], edges: Edge[]): Graph {
  const map: Record<string, Node> = {
    start: { id: 'start', action: '__start__', params: {} },
  };
  nodes.forEach((n) => { map[n.id] = { params: {}, ...n }; });
  return { nodes: map, edges, nextId: nodes.length };
}

describe('graph-serialize — Step 24 non-linear serialization', () => {
  it('exposes graphToSteps / stepsToGraph / validateGraph', () => {
    expect(typeof GS.graphToSteps).toBe('function');
    expect(typeof GS.stepsToGraph).toBe('function');
    expect(typeof GS.validateGraph).toBe('function');
  });

  it('serialises a linear chain in order', () => {
    const g = graph(
      [
        { id: 'a', action: 'goto', params: { url: 'https://x.com' } },
        { id: 'b', action: 'click', params: { selector: '.btn' } },
      ],
      [
        { from: 'start', to: 'a', port: 'next' },
        { from: 'a', to: 'b', port: 'next' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps).toEqual([
      { action: 'goto', params: { url: 'https://x.com' } },
      { action: 'click', params: { selector: '.btn' } },
    ]);
  });

  it('coerces number fields to integers and drops empty params', () => {
    const g = graph(
      [{ id: 'a', action: 'wait', params: { ms: '1500', selector: '' } }],
      [{ from: 'start', to: 'a', port: 'next' }],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0]).toEqual({ action: 'wait', params: { ms: 1500 } });
  });

  it('serialises an IF node into condition + then/else groups', () => {
    const g = graph(
      [
        { id: 'i', action: 'if', params: { selector: '.modal', operator: 'visible' } },
        { id: 't', action: 'click', params: { selector: '.close' } },
        { id: 'e', action: 'log', params: { message: 'no modal' } },
        { id: 'after', action: 'screenshot', params: {} },
      ],
      [
        { from: 'start', to: 'i', port: 'next' },
        { from: 'i', to: 't', port: 'then' },
        { from: 'i', to: 'e', port: 'else' },
        { from: 'i', to: 'after', port: 'next' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps).toHaveLength(2);
    expect(steps[0].action).toBe('if');
    expect(steps[0].condition).toEqual({ operator: 'visible', selector: '.modal' });
    expect(steps[0].then).toEqual([{ action: 'click', params: { selector: '.close' } }]);
    expect(steps[0].else).toEqual([{ action: 'log', params: { message: 'no modal' } }]);
    // the 'next' port continues the main chain after the if
    expect(steps[1]).toEqual({ action: 'screenshot', params: {} });
  });

  it('serialises a LOOP node with body[] and continues on the done port', () => {
    const g = graph(
      [
        { id: 'l', action: 'loop', params: { count: '3' } },
        { id: 'b', action: 'click', params: { selector: '.next' } },
        { id: 'd', action: 'log', params: { message: 'loop done' } },
      ],
      [
        { from: 'start', to: 'l', port: 'next' },
        { from: 'l', to: 'b', port: 'body' },
        { from: 'l', to: 'd', port: 'done' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0]).toEqual({
      action: 'loop',
      params: { count: 3 },
      steps: [{ action: 'click', params: { selector: '.next' } }],
    });
    expect(steps[1]).toEqual({ action: 'log', params: { message: 'loop done' } });
  });

  it('serialises a FOREACH node with items/itemVar params + body', () => {
    const g = graph(
      [
        { id: 'fe', action: 'foreach', params: { items: 'rows', itemVar: 'row' } },
        { id: 'b', action: 'log', params: { message: 'x' } },
      ],
      [
        { from: 'start', to: 'fe', port: 'next' },
        { from: 'fe', to: 'b', port: 'body' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0].action).toBe('foreach');
    expect(steps[0].params).toEqual({ items: 'rows', itemVar: 'row' });
    expect(steps[0].steps).toEqual([{ action: 'log', params: { message: 'x' } }]);
  });

  it('serialises a WHILE node into condition + maxIterations + body', () => {
    const g = graph(
      [
        { id: 'w', action: 'while', params: { selector: '.more', operator: 'exists', maxIterations: '50' } },
        { id: 'b', action: 'click', params: { selector: '.more' } },
      ],
      [
        { from: 'start', to: 'w', port: 'next' },
        { from: 'w', to: 'b', port: 'body' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0].action).toBe('while');
    expect(steps[0].condition).toEqual({ operator: 'exists', selector: '.more' });
    // condition-only keys must NOT leak into params; maxIterations stays
    expect(steps[0].params).toEqual({ maxIterations: 50 });
    expect(steps[0].steps).toEqual([{ action: 'click', params: { selector: '.more' } }]);
  });

  it('serialises a SWITCH node into cases{} (default + named cases)', () => {
    const g = graph(
      [
        { id: 's', action: 'switch', params: { variable: 'status' } },
        { id: 'd', action: 'log', params: { message: 'default' } },
        { id: 'c1', action: 'log', params: { message: 'ok' } },
      ],
      [
        { from: 'start', to: 's', port: 'next' },
        { from: 's', to: 'd', port: 'default' },
        { from: 's', to: 'c1', port: 'case:ok' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0].action).toBe('switch');
    expect(steps[0].params).toEqual({ variable: 'status' });
    expect(steps[0].cases).toEqual({
      default: [{ action: 'log', params: { message: 'default' } }],
      ok: [{ action: 'log', params: { message: 'ok' } }],
    });
  });

  it('serialises a TRY node into steps/catch/finally + continues on next', () => {
    const g = graph(
      [
        { id: 'tr', action: 'try', params: {} },
        { id: 't', action: 'click', params: { selector: '.risky' } },
        { id: 'c', action: 'log', params: { message: 'failed' } },
        { id: 'f', action: 'log', params: { message: 'cleanup' } },
        { id: 'n', action: 'screenshot', params: {} },
      ],
      [
        { from: 'start', to: 'tr', port: 'next' },
        { from: 'tr', to: 't', port: 'try' },
        { from: 'tr', to: 'c', port: 'catch' },
        { from: 'tr', to: 'f', port: 'finally' },
        { from: 'tr', to: 'n', port: 'next' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0].action).toBe('try');
    expect(steps[0].steps).toEqual([{ action: 'click', params: { selector: '.risky' } }]);
    expect(steps[0].catch).toEqual([{ action: 'log', params: { message: 'failed' } }]);
    expect(steps[0].finally).toEqual([{ action: 'log', params: { message: 'cleanup' } }]);
    expect(steps[1]).toEqual({ action: 'screenshot', params: {} });
  });

  it('stops at a cycle without infinite-looping', () => {
    const g = graph(
      [
        { id: 'a', action: 'log', params: { message: '1' } },
        { id: 'b', action: 'log', params: { message: '2' } },
      ],
      [
        { from: 'start', to: 'a', port: 'next' },
        { from: 'a', to: 'b', port: 'next' },
        { from: 'b', to: 'a', port: 'next' }, // cycle back
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps).toEqual([
      { action: 'log', params: { message: '1' } },
      { action: 'log', params: { message: '2' } },
    ]);
  });

  it('round-trips a branching graph: steps -> graph -> steps', () => {
    const original: Step[] = [
      { action: 'goto', params: { url: 'https://x.com' } },
      {
        action: 'if',
        condition: { operator: 'visible', selector: '.modal' },
        then: [{ action: 'click', params: { selector: '.close' } }],
        else: [{ action: 'log', params: { message: 'no modal' } }],
      },
      {
        action: 'loop',
        params: { count: 2 },
        steps: [{ action: 'click', params: { selector: '.next' } }],
      },
    ];
    const g = GS.stepsToGraph(original);
    const back = GS.graphToSteps(g);
    expect(back).toEqual(original);
  });

  it('deserialises switch + try and re-serialises identically', () => {
    const original: Step[] = [
      {
        action: 'switch',
        params: { variable: 'status' },
        cases: {
          ok: [{ action: 'log', params: { message: 'ok' } }],
          default: [{ action: 'log', params: { message: 'def' } }],
        },
      },
      {
        action: 'try',
        steps: [{ action: 'click', params: { selector: '.x' } }],
        catch: [{ action: 'log', params: { message: 'err' } }],
        finally: [{ action: 'screenshot', params: {} }],
      },
    ];
    const back = GS.graphToSteps(GS.stepsToGraph(original));
    expect(back).toEqual(original);
  });
});

describe('graph-serialize — Step 24 validation', () => {
  it('flags an empty graph (nothing connected to start)', () => {
    const g = graph([], []);
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'empty')).toBe(true);
  });

  it('passes a well-formed linear graph', () => {
    const g = graph(
      [{ id: 'a', action: 'goto', params: { url: 'https://x.com' } }],
      [{ from: 'start', to: 'a', port: 'next' }],
    );
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('warns about an orphan node not reachable from start', () => {
    const g = graph(
      [
        { id: 'a', action: 'goto', params: { url: 'https://x.com' } },
        { id: 'orphan', action: 'click', params: { selector: '.z' } },
      ],
      [{ from: 'start', to: 'a', port: 'next' }],
    );
    const res = GS.validateGraph(g);
    expect(res.warnings.some((w) => w.code === 'orphan' && w.nodeId === 'orphan')).toBe(true);
  });

  it('errors when foreach lacks an items variable', () => {
    const g = graph(
      [{ id: 'fe', action: 'foreach', params: {} }],
      [{ from: 'start', to: 'fe', port: 'next' }],
    );
    const res = GS.validateGraph(g);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'foreach-items')).toBe(true);
  });

  it('errors when switch lacks a variable name', () => {
    const g = graph(
      [{ id: 's', action: 'switch', params: {} }],
      [{ from: 'start', to: 's', port: 'next' }],
    );
    const res = GS.validateGraph(g);
    expect(res.errors.some((e) => e.code === 'switch-var')).toBe(true);
  });
});
