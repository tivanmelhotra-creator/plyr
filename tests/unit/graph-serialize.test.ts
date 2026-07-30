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
interface ErrorPolicy { continueOnFail?: boolean; retryOnFail?: boolean; maxTries?: number; waitBetweenTriesMs?: number }
interface Node { id: string; action: string; params?: Record<string, unknown>; x?: number; y?: number; errorPolicy?: ErrorPolicy;
  /** Item J annotations: `disabled` changes serialisation, `label` is a name. */
  disabled?: boolean; label?: string }
interface Graph { nodes: Record<string, Node>; edges: Edge[]; nextId?: number }
interface Step { action: string; params?: Record<string, unknown>; condition?: any;
  then?: Step[]; else?: Step[]; steps?: Step[]; catch?: Step[]; finally?: Step[];
  cases?: Record<string, Step[]>;
  continueOnFail?: boolean; retryOnFail?: boolean; maxTries?: number; waitBetweenTriesMs?: number }
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

describe('graph-serialize — Step 27 error policy', () => {
  it('emits continueOnFail / retryOnFail (+ maxTries/wait) as top-level step fields', () => {
    const g = graph(
      [{
        id: 'a', action: 'click', params: { selector: '.x' },
        errorPolicy: { continueOnFail: true, retryOnFail: true, maxTries: 5, waitBetweenTriesMs: 2000 },
      }],
      [{ from: 'start', to: 'a', port: 'next' }],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0]).toEqual({
      action: 'click',
      params: { selector: '.x' },
      continueOnFail: true,
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTriesMs: 2000,
    });
  });

  it('omits error-policy fields entirely for a plain node', () => {
    const g = graph(
      [{ id: 'a', action: 'click', params: { selector: '.x' } }],
      [{ from: 'start', to: 'a', port: 'next' }],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0]).toEqual({ action: 'click', params: { selector: '.x' } });
    expect('continueOnFail' in steps[0]).toBe(false);
    expect('retryOnFail' in steps[0]).toBe(false);
  });

  it('does not emit maxTries/wait when retryOnFail is off', () => {
    const g = graph(
      [{ id: 'a', action: 'click', params: { selector: '.x' }, errorPolicy: { continueOnFail: true } }],
      [{ from: 'start', to: 'a', port: 'next' }],
    );
    const steps = GS.graphToSteps(g);
    expect(steps[0].continueOnFail).toBe(true);
    expect('retryOnFail' in steps[0]).toBe(false);
    expect('maxTries' in steps[0]).toBe(false);
  });

  it('round-trips error policy: steps -> graph -> steps', () => {
    const original: Step[] = [
      { action: 'goto', params: { url: 'https://x.com' }, retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 1000 },
      { action: 'click', params: { selector: '.btn' }, continueOnFail: true },
    ];
    const g = GS.stepsToGraph(original);
    const back = GS.graphToSteps(g);
    expect(back[0].retryOnFail).toBe(true);
    expect(back[0].maxTries).toBe(3);
    expect(back[0].waitBetweenTriesMs).toBe(1000);
    expect(back[1].continueOnFail).toBe(true);
    expect('retryOnFail' in back[1]).toBe(false);
  });
});

/**
 * Layout is part of the product surface, not an implementation detail: the
 * reference design (docs/uiux) reads a workflow as a LEFT-TO-RIGHT pipeline.
 * An earlier build advanced +Y per step at a fixed X, which produced the tall
 * vertical stack visible in the shipped screenshots. These tests lock the
 * pipeline geometry so it cannot silently regress.
 */
describe('graph-serialize — stepsToGraph pipeline layout', () => {
  const NODE_W = 190; // flow-editor.js card width
  const NODE_H = 64;  // flow-editor.js NODE_H_MIN

  /** Every generated node except the implicit Start. */
  function laidOut(steps: Step[]): Node[] {
    const g = GS.stepsToGraph(steps);
    return Object.values(g.nodes).filter((n) => n.id !== 'start');
  }

  const linear: Step[] = [
    { action: 'launch', params: {} },
    { action: 'goto', params: { url: 'https://example.com' } },
    { action: 'click', params: { selector: '#submit' } },
    { action: 'close-browser', params: {} },
  ];

  it('lays a linear workflow out as one horizontal row', () => {
    const ns = laidOut(linear);
    expect(ns).toHaveLength(4);
    const ys = new Set(ns.map((n) => n.y));
    expect(ys.size, 'a linear chain must stay on a single row').toBe(1);
  });

  it('advances strictly rightwards, one node per column', () => {
    const xs = laidOut(linear).map((n) => n.x as number).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1], 'column pitch must clear the card width').toBeGreaterThanOrEqual(NODE_W);
    }
    expect(new Set(xs).size, 'no two sequential nodes share a column').toBe(xs.length);
  });

  it('starts the chain to the right of the Start node, on its row', () => {
    const g = GS.stepsToGraph(linear);
    const start = g.nodes.start;
    const first = Object.values(g.nodes).filter((n) => n.id !== 'start')
      .sort((a, b) => (a.x as number) - (b.x as number))[0];
    expect(first.x as number).toBeGreaterThan(start.x as number);
    expect(first.y, 'the trunk is one straight row through Start').toBe(start.y);
  });

  it('drops if/else branches into separate lanes below the parent', () => {
    const g = GS.stepsToGraph([
      { action: 'goto', params: { url: 'u' } },
      {
        action: 'if',
        condition: { operator: 'exists', selector: '#ok' },
        then: [{ action: 'log', params: { message: 'yes' } }],
        else: [{ action: 'log', params: { message: 'no' } }],
      },
    ]);
    const byMsg = (m: string) => Object.values(g.nodes)
      .find((n) => n.params && (n.params as any).message === m)!;
    const ifNode = Object.values(g.nodes).find((n) => n.action === 'if')!;
    const yes = byMsg('yes');
    const no = byMsg('no');

    // both branches live one column right of the parent...
    expect(yes.x as number).toBeGreaterThan(ifNode.x as number);
    expect(no.x as number).toBeGreaterThan(ifNode.x as number);
    // ...on their own lanes, below it, and never on top of each other
    expect(yes.y as number).toBeGreaterThan(ifNode.y as number);
    expect(no.y as number).toBeGreaterThan(yes.y as number);
  });

  it('places the step after a branch clear of the whole subtree', () => {
    const g = GS.stepsToGraph([
      {
        action: 'if',
        condition: { operator: 'exists', selector: '#a' },
        then: [
          { action: 'log', params: { message: 'a' } },
          { action: 'log', params: { message: 'b' } },
        ],
        else: [{ action: 'log', params: { message: 'c' } }],
      },
      { action: 'close-browser', params: {} },
    ]);
    const nodes = Object.values(g.nodes);
    const after = nodes.find((n) => n.action === 'close-browser')!;
    const branchNodes = nodes.filter((n) => n.action === 'log');
    const rightmostBranch = Math.max(...branchNodes.map((n) => n.x as number));
    expect(after.x as number,
      'the continuation must not sit on top of the branch subtree')
      .toBeGreaterThan(rightmostBranch);
  });

  it('never overlaps two node cards, even with nested branches', () => {
    const ns = laidOut([
      { action: 'goto', params: { url: 'u' } },
      {
        action: 'if',
        condition: { operator: 'exists', selector: '#a' },
        then: [
          {
            action: 'if',
            condition: { operator: 'exists', selector: '#b' },
            then: [{ action: 'log', params: { message: 'deep' } }],
            else: [{ action: 'log', params: { message: 'deep2' } }],
          },
          { action: 'click', params: { selector: '.after' } },
        ],
        else: [{ action: 'log', params: { message: 'e' } }],
      },
      { action: 'while', condition: { operator: 'exists', selector: '#w' }, steps: [{ action: 'click', params: { selector: '.n' } }] },
      { action: 'close-browser', params: {} },
    ]);
    const clashes: string[] = [];
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i]; const b = ns[j];
        if (Math.abs((a.x as number) - (b.x as number)) < NODE_W
          && Math.abs((a.y as number) - (b.y as number)) < NODE_H) {
          clashes.push(`${a.action}@${a.x},${a.y} vs ${b.action}@${b.x},${b.y}`);
        }
      }
    }
    expect(clashes, 'overlapping node cards').toEqual([]);
  });

  it('snaps every generated node onto the editor 20px grid', () => {
    const offGrid = laidOut([
      { action: 'goto', params: { url: 'u' } },
      {
        action: 'if',
        condition: { operator: 'exists', selector: '#a' },
        then: [{ action: 'log', params: { message: 'x' } }],
        else: [{ action: 'log', params: { message: 'y' } }],
      },
      { action: 'close-browser', params: {} },
    ]).filter((n) => (n.x as number) % 20 !== 0 || (n.y as number) % 20 !== 0);
    expect(offGrid.map((n) => `${n.action}@${n.x},${n.y}`)).toEqual([]);
  });

  it('keeps the structural round-trip intact after re-layout', () => {
    const original: Step[] = [
      { action: 'goto', params: { url: 'https://example.com' } },
      {
        action: 'if',
        condition: { operator: 'exists', selector: '#ok' },
        then: [{ action: 'click', params: { selector: '.a' } }],
        else: [{ action: 'click', params: { selector: '.b' } }],
      },
    ];
    expect(GS.graphToSteps(GS.stepsToGraph(original))).toEqual(original);
  });
});

/**
 * Item J's `Disable` row. A disabled node is EDITOR state that changes what the
 * backend receives, so the contract is asserted here (behaviourally) and not
 * only in a source-shape guard:
 *   - the node emits no step and the chain continues through its `next` port
 *   - its missing required params can no longer fail validation (it never runs)
 *   - it still WARNS, so a silently skipped node is discoverable
 */
describe('graph-serialize — disabled nodes (item J)', () => {
  it('skips a disabled node and passes the chain through it', () => {
    const g = graph(
      [
        { id: 'a', action: 'goto', params: { url: 'https://x.com' } },
        { id: 'b', action: 'click', params: { selector: '.btn' }, disabled: true },
        { id: 'c', action: 'type', params: { selector: '#q', text: 'hi' } },
      ],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    const steps = GS.graphToSteps(g);
    expect(steps.map((s) => s.action)).toEqual(['goto', 'type']);
  });

  it('a disabled FIRST node still lets the rest of the flow serialise', () => {
    const g = graph(
      [
        { id: 'a', action: 'goto', params: { url: 'https://x.com' }, disabled: true },
        { id: 'b', action: 'click', params: { selector: '.btn' } },
      ],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }],
    );
    expect(GS.graphToSteps(g).map((s) => s.action)).toEqual(['click']);
  });

  it('a disabled BRANCHING node drops its branches too (documented consequence)', () => {
    const g = graph(
      [
        { id: 'i', action: 'if', params: { left: '1', operator: 'equals', right: '1' }, disabled: true },
        { id: 't', action: 'click', params: { selector: '.t' } },
        { id: 'n', action: 'goto', params: { url: 'https://after.example' } },
      ],
      [
        { from: 'start', to: 'i' },
        { from: 'i', to: 't', port: 'then' },
        { from: 'i', to: 'n', port: 'next' },
      ],
    );
    // The `then` child is only reachable THROUGH the skipped node, so it goes
    // with it; the main chain continues at the `next` target.
    expect(GS.graphToSteps(g).map((s) => s.action)).toEqual(['goto']);
  });

  it('warns about a disabled node instead of erroring on its params', () => {
    const g = graph(
      [{ id: 'a', action: 'goto', params: {}, disabled: true } as Node],
      [{ from: 'start', to: 'a' }],
    );
    const res = GS.validateGraph(g);
    expect(res.warnings.some((w) => w.code === 'disabled' && w.nodeId === 'a')).toBe(true);
    expect(res.errors.filter((e) => e.nodeId === 'a')).toEqual([]);
  });

  it('an ENABLED node with the same missing params is still validated', () => {
    const g = graph(
      [{ id: 's', action: 'switch', params: {} }],
      [{ from: 'start', to: 's' }],
    );
    const res = GS.validateGraph(g);
    expect(res.errors.some((e) => e.code === 'switch-var' && e.nodeId === 's')).toBe(true);
  });

  it('outlineTree marks disabled rows so the OUTLINE can mirror the canvas', () => {
    const g = graph(
      [{ id: 'a', action: 'goto', params: {}, disabled: true, label: 'Login page' } as Node],
      [{ from: 'start', to: 'a' }],
    );
    const outline = (GS as unknown as { outlineTree: (x: Graph) => any[] }).outlineTree(g);
    const row = outline.find((r) => r.nodeId === 'a');
    expect(row.disabled).toBe(true);
    expect(row.label).toBe('Login page');
  });
});
