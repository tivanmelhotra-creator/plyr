/**
 * Code node core (src/core/CodeNode.ts).
 *
 * Pins the contract the pipeline relies on: output normalisation into
 * WorkflowItems, both execution modes, console capture, $vars write-back,
 * require filtering, error reporting, and the two timeout paths (a killable
 * worker vs an in-process race).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  runCodeNode,
  normalizeCodeOutput,
  clampTimeout,
  parseAllowModules,
  varsToObject,
  CodeNodeError,
} from '../../src/core/CodeNode';

const items = [{ json: { a: 1 } }, { json: { a: 2 } }, { json: { a: 3 } }];

describe('normalizeCodeOutput', () => {
  it('wraps a bare object as one item', () => {
    expect(normalizeCodeOutput('runOnceForAllItems', { x: 1 })).toEqual([{ json: { x: 1 } }]);
  });
  it('maps an array of objects to items, keeping { json, binary } items as they are', () => {
    const out = normalizeCodeOutput('runOnceForAllItems', [{ x: 1 }, { json: { y: 2 }, binary: { f: { path: '/a' } } }]);
    expect(out).toEqual([{ json: { x: 1 } }, { json: { y: 2 }, binary: { f: { path: '/a' } } }]);
  });
  it('treats an object that merely HAS a json key among others as data', () => {
    expect(normalizeCodeOutput('runOnceForAllItems', { json: { a: 1 }, other: 2 }))
      .toEqual([{ json: { json: { a: 1 }, other: 2 } }]);
  });
  it('null / undefined / [] mean no items', () => {
    expect(normalizeCodeOutput('runOnceForAllItems', null)).toEqual([]);
    expect(normalizeCodeOutput('runOnceForAllItems', undefined)).toEqual([]);
    expect(normalizeCodeOutput('runOnceForAllItems', [])).toEqual([]);
  });
  it('rejects primitives and nested arrays with a readable message', () => {
    expect(() => normalizeCodeOutput('runOnceForAllItems', 5)).toThrow(/must be an object \(got number\)/);
    expect(() => normalizeCodeOutput('runOnceForAllItems', 'x')).toThrow(/got string/);
    expect(() => normalizeCodeOutput('runOnceForAllItems', [[1]])).toThrow(/Returned item 0 must be an object \(got an array\)/);
  });
  it('rejects values that are not data', () => {
    expect(() => normalizeCodeOutput('runOnceForAllItems', { f: () => 1 })).toThrow(/function/);
    expect(() => normalizeCodeOutput('runOnceForAllItems', { b: BigInt(1) })).toThrow(/BigInt/);
    const c: Record<string, unknown> = {}; c.self = c;
    expect(() => normalizeCodeOutput('runOnceForAllItems', c)).toThrow(/circular/);
  });
  it('turns Dates into ISO strings and non-finite numbers into null', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(normalizeCodeOutput('runOnceForAllItems', { d, n: NaN })).toEqual([{ json: { d: d.toISOString(), n: null } }]);
  });
  it('per-item mode flattens arrays and drops null results', () => {
    const out = normalizeCodeOutput('runOnceForEachItem', [
      { index: 0, value: { a: 1 } }, { index: 1, value: null }, { index: 2, value: [{ b: 1 }, { b: 2 }] },
    ]);
    expect(out).toEqual([{ json: { a: 1 } }, { json: { b: 1 } }, { json: { b: 2 } }]);
  });
});

describe('helpers', () => {
  it('clampTimeout bounds the value and falls back on junk', () => {
    expect(clampTimeout(undefined)).toBe(30000);
    expect(clampTimeout('abc')).toBe(30000);
    expect(clampTimeout(5)).toBe(100);
    expect(clampTimeout(10 ** 9)).toBe(600000);
    expect(clampTimeout('2500')).toBe(2500);
  });
  it('parseAllowModules splits and trims', () => {
    expect(parseAllowModules(' lodash, node:fs ,,')).toEqual(['lodash', 'node:fs']);
    expect(parseAllowModules('')).toEqual([]);
  });
  it('varsToObject copies a Map and stringifies what cannot be JSON', () => {
    const m = new Map<string, unknown>([['a', 1], ['f', () => 1]]);
    const o = varsToObject(m);
    expect(o.a).toBe(1);
    expect(typeof o.f).toBe('string');
  });
});

describe('runCodeNode (worker)', () => {
  it('runs once for all items and returns items, console lines and changed vars', async () => {
    const res = await runCodeNode({
      code: 'console.log("n", $input.all().length); $vars.total = $input.all().length; return $input.all().map(i => ({ b: i.json.a * 2 }));',
      items, vars: { keep: 'same' },
    });
    expect(res.items).toEqual([{ json: { b: 2 } }, { json: { b: 4 } }, { json: { b: 6 } }]);
    expect(res.logs).toEqual([{ level: 'log', text: 'n 3' }]);
    expect(res.changedVars).toEqual({ total: 3 });
  });

  it('runs once per item with $json / $index / $item', async () => {
    const res = await runCodeNode({ code: 'return { v: $json.a + $index, same: $item.json.a === $json.a };', mode: 'runOnceForEachItem', items });
    expect(res.items.map((i) => i.json)).toEqual([{ v: 1, same: true }, { v: 3, same: true }, { v: 5, same: true }]);
  });

  it('exposes $node outputs and $execution', async () => {
    const res = await runCodeNode({
      code: 'return { x: $node["extract#2"].json.x, n: $node["extract#2"].items.length, id: $execution.id };',
      items, nodeOutputs: { 'extract#2': [{ json: { x: 'hi' } }, { json: { x: 'b' } }] }, executionId: 'job-9',
    });
    expect(res.items[0].json).toEqual({ x: 'hi', n: 2, id: 'job-9' });
  });

  it('require and fetch are available by default', async () => {
    const res = await runCodeNode({
      code: 'const r = await fetch("data:text/plain,ok"); return { os: typeof require("node:os").platform(), t: await r.text() };',
      items,
    });
    expect(res.items[0].json).toEqual({ os: 'string', t: 'ok' });
  });

  it('CODE_NODE_ALLOW_MODULES restricts require', async () => {
    await expect(runCodeNode({ code: 'require("node:os"); return {};', items, allowModules: ['path'] }))
      .rejects.toThrow(/not allowed.*CODE_NODE_ALLOW_MODULES/);
    const ok = await runCodeNode({ code: 'return { sep: require("path").sep };', items, allowModules: ['path'] });
    expect(ok.items[0].json.sep).toBe(path.sep);
  });

  it('reports a runtime error with the line inside the snippet and keeps earlier console output', async () => {
    let err: unknown;
    try {
      await runCodeNode({ code: 'console.log("before");\nconst x = null;\nreturn x.y;', items });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CodeNodeError);
    expect((err as Error).message).toMatch(/Cannot read properties of null.*\(line 3\)/);
    expect((err as CodeNodeError).logs).toEqual([{ level: 'log', text: 'before' }]);
  });

  it('reports a syntax error', async () => {
    await expect(runCodeNode({ code: 'return {', items })).rejects.toThrow(/Syntax error/);
  });

  it('rejects invalid output', async () => {
    await expect(runCodeNode({ code: 'return 42;', items })).rejects.toThrow(/must be an object/);
  });

  it('rejects empty code', async () => {
    await expect(runCodeNode({ code: '  ', items })).rejects.toThrow(/no code/);
  });

  it('kills a synchronous infinite loop on timeout', async () => {
    const t0 = Date.now();
    await expect(runCodeNode({ code: 'while (true) {}', items, timeoutMs: 300 })).rejects.toThrow(/timed out after 300ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('page/context explain how to enable them when the browser option is off', async () => {
    await expect(runCodeNode({ code: 'return { u: page.url() };', items })).rejects.toThrow(/Use browser/);
  });

  it('handles a large input', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ json: { i, s: 'x'.repeat(50) } }));
    const res = await runCodeNode({ code: 'return [{ n: $input.all().length, sum: $input.all().reduce((a, b) => a + b.json.i, 0) }];', items: big });
    expect(res.items[0].json).toEqual({ n: 5000, sum: (4999 * 5000) / 2 });
  });

  it('caps captured console lines', async () => {
    const res = await runCodeNode({ code: 'for (let i = 0; i < 50; i++) console.log(i); return null;', items, maxLogLines: 10 });
    expect(res.logs).toHaveLength(11);
    expect(res.logs[10].text).toMatch(/truncated/);
    expect(res.items).toEqual([]);
  });
});

describe('runCodeNode (in-process, useBrowser)', () => {
  it('passes page and context through', async () => {
    const page = { url: () => 'https://example.test/' };
    const res = await runCodeNode({ code: 'return { u: page.url(), c: context.name };', items, useBrowser: true, page, browserContext: { name: 'ctx' } });
    expect(res.items[0].json).toEqual({ u: 'https://example.test/', c: 'ctx' });
  });
  it('abandons an async runaway on timeout', async () => {
    await expect(runCodeNode({ code: 'await new Promise(() => {});', items, useBrowser: true, timeoutMs: 200 }))
      .rejects.toThrow(/timed out after 200ms/);
  });
});

describe('config gate', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.resetModules(); });

  async function load(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const k of ['DEPLOYMENT_MODE', 'CODE_NODE_ENABLED']) delete process.env[k];
    Object.assign(process.env, env);
    return (await import('../../src/config')).config;
  }
  it('is on by default in single mode', async () => {
    expect((await load({ DEPLOYMENT_MODE: 'single' })).CODE_NODE_ENABLED).toBe(true);
  });
  it('can be switched off in single mode', async () => {
    expect((await load({ DEPLOYMENT_MODE: 'single', CODE_NODE_ENABLED: 'false' })).CODE_NODE_ENABLED).toBe(false);
  });
  it('is always off in multi mode, even when asked for', async () => {
    expect((await load({ DEPLOYMENT_MODE: 'multi', CODE_NODE_ENABLED: 'true' })).CODE_NODE_ENABLED).toBe(false);
  });
});

describe('wiring', () => {
  const root = path.join(__dirname, '..', '..');
  it('the catalog declares the code action in the Data category with every field the runtime reads', () => {
    const win: { ACTION_CATALOG?: { ACTIONS: { id: string; cat: string; fields: { k: string }[] }[] } } = {};
    // eslint-disable-next-line no-new-func
    new Function('window', fs.readFileSync(path.join(root, 'public/js/actions.js'), 'utf8'))(win);
    const act = win.ACTION_CATALOG!.ACTIONS.find((a) => a.id === 'code')!;
    expect(act.cat).toBe('data');
    expect(act.fields.map((f) => f.k).sort()).toEqual(['code', 'mode', 'timeoutMs', 'useBrowser']);
  });
  it('the pipeline dispatches the code action and reads the code raw', () => {
    const src = fs.readFileSync(path.join(root, 'src/pipeline.ts'), 'utf8');
    expect(src).toMatch(/step\.action === 'code'/);
    expect(src).toMatch(/\(step\.params as any\)\?\.code/);
  });
});
