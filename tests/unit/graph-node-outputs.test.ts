/**
 * Phase 2 in the editor's serializer (graph-serialize.js):
 *   - a node with Settings -> "Success / Error / Timeout outputs" serialises
 *     its `error` / `timeout` port chains as errorSteps / timeoutSteps,
 *     `next` stays the success chain;
 *   - the retry policy and node timeout are written as step fields;
 *   - stepsToGraph rebuilds the node, its ports and its edges (round trip);
 *   - a node WITHOUT the setting ignores edges on those ports (no hidden branch);
 *   - control-flow nodes never get the extra ports.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

let GS: any;
beforeAll(() => {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['actions.js', 'graph-serialize.js']) {
    vm.runInContext(readFileSync(join(__dirname, '..', '..', 'public', 'js', f), 'utf8'), sandbox, { filename: f });
  }
  GS = sandbox.window.GraphSerialize;
});

function graph(nodes: any[], edges: any[]) {
  const map: Record<string, any> = { start: { id: 'start', action: '__start__', params: {} } };
  nodes.forEach((n) => { map[n.id] = { params: {}, ...n }; });
  return { nodes: map, edges, nextId: nodes.length };
}
const click = (id: string, ep?: any) => ({ id, action: 'click', params: { selector: '#b' }, ...(ep ? { errorPolicy: ep } : {}) });
const log = (id: string, m: string) => ({ id, action: 'log', params: { message: m } });

describe('Success / Error / Timeout outputs in the graph', () => {
  it('serialises the failure ports into errorSteps / timeoutSteps; next stays success', () => {
    const g = graph(
      [click('c', { outputs: true, timeoutMs: 5000, retryOnFail: true, maxTries: 3, retryOn: 'timeout', retryBackoff: 'exponential' }), log('ok', 'OK'), log('e', 'ERR'), log('t', 'TO')],
      [{ from: 'start', to: 'c', port: 'next' }, { from: 'c', to: 'ok', port: 'next' }, { from: 'c', to: 'e', port: 'error' }, { from: 'c', to: 't', port: 'timeout' }],
    );
    const steps = GS.graphToSteps(g);
    expect(steps.map((s: any) => s.action)).toEqual(['click', 'log']);
    expect(steps[0]).toMatchObject({ timeoutMs: 5000, retryOnFail: true, maxTries: 3, retryOn: 'timeout', retryBackoff: 'exponential' });
    expect(steps[0].errorSteps.map((s: any) => s.params.message)).toEqual(['ERR']);
    expect(steps[0].timeoutSteps.map((s: any) => s.params.message)).toEqual(['TO']);
    expect(GS.validateGraph(g).ok).toBe(true);
  });

  it('with the setting on but nothing wired, the node still HAS an (empty) error output', () => {
    const steps = GS.graphToSteps(graph([click('c', { outputs: true })], [{ from: 'start', to: 'c', port: 'next' }]));
    expect(steps[0].errorSteps).toEqual([]);
    expect(steps[0].timeoutSteps).toBeUndefined();
  });

  it('round trip: steps -> graph -> steps keeps the outputs, ports and policy', () => {
    const steps = [{ action: 'click', params: { selector: '#b' }, timeoutMs: 7000, errorSteps: [{ action: 'log', params: { message: 'E' } }], timeoutSteps: [{ action: 'log', params: { message: 'T' } }] }, { action: 'log', params: { message: 'N' } }];
    const g = GS.stepsToGraph(steps);
    const clickNode: any = Object.values(g.nodes).find((n: any) => n.action === 'click');
    expect(clickNode.errorPolicy).toMatchObject({ outputs: true, timeoutMs: 7000 });
    expect(g.edges.some((e: any) => e.from === clickNode.id && e.port === 'error')).toBe(true);
    expect(g.edges.some((e: any) => e.from === clickNode.id && e.port === 'timeout')).toBe(true);
    const back = GS.graphToSteps(g);
    expect(back[0].errorSteps[0].params.message).toBe('E');
    expect(back[0].timeoutSteps[0].params.message).toBe('T');
    expect(back[1].params.message).toBe('N');
    // The outline shows the two output sections.
    const rows = GS.outlineTree(g).filter((r: any) => r.kind === 'port').map((r: any) => r.port);
    expect(rows).toEqual(['error', 'timeout']);
  });

  it('without the setting, an edge on a failure port creates no hidden branch', () => {
    const g = graph([click('c'), log('e', 'ERR')], [{ from: 'start', to: 'c', port: 'next' }, { from: 'c', to: 'e', port: 'error' }]);
    const steps = GS.graphToSteps(g);
    expect(steps).toHaveLength(1);
    expect(steps[0].errorSteps).toBeUndefined();
  });

  it('control-flow nodes never get Error / Timeout ports', () => {
    expect(GS.hasFailurePorts({ action: 'if', errorPolicy: { outputs: true } })).toBe(false);
    expect(GS.hasFailurePorts({ action: 'loop', errorPolicy: { outputs: true } })).toBe(false);
    expect(GS.hasFailurePorts({ action: 'click', errorPolicy: { outputs: true } })).toBe(true);
    expect(GS.hasFailurePorts({ action: 'click' })).toBe(false);
  });
});
