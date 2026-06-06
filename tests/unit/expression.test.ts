/**
 * expression.test.ts — Step 25
 *
 * Tests the browser-side, DOM-free, SAFE expression engine
 * (public/js/expression.js). Three concerns:
 *
 *   (A) CORRECTNESS  — template interpolation, $json/$node/$now/$today/$index/
 *                      $vars, arithmetic, ternary, whitelisted methods, native
 *                      type preservation for whole-string expressions.
 *   (B) MAPPING      — mapParams() maps a params object to backend-shaped params,
 *                      collecting per-key errors and never throwing.
 *   (C) SANDBOX      — the n8n CVE lesson: NO path to constructor / __proto__ /
 *                      prototype / Function / globalThis / process / require, and
 *                      non-whitelisted methods (Array.map etc.) are rejected.
 *
 * Like action-catalog.test.ts / graph-serialize.test.ts, this is DOM-free: the
 * engine touches only `window`, so a tiny `window` shim under node:vm is enough.
 * No jsdom dependency is added. The vm context is created WITHOUT exposing any
 * Node globals — so if a sandbox escape existed it could not even reach `process`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface EvalCtx {
  json?: Record<string, unknown>;
  node?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  index?: number;
  now?: Date;
}
interface Engine {
  isExpression: (s: unknown) => boolean;
  evaluate: (body: string, ctx?: EvalCtx) => unknown;
  evaluateTemplate: (str: string, ctx?: EvalCtx) => unknown;
  mapParams: (
    params: Record<string, unknown>,
    ctx?: EvalCtx
  ) => { params: Record<string, unknown>; errors: Record<string, string> };
}

let E: Engine;

beforeAll(() => {
  const file = join(__dirname, '..', '..', 'public', 'js', 'expression.js');
  const code = readFileSync(file, 'utf8');
  // Deliberately bare sandbox: only `window`. No process/require/global leak.
  const sandbox: { window: { ExpressionEngine?: Engine } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'expression.js' });
  if (!sandbox.window.ExpressionEngine) {
    throw new Error('expression.js did not expose window.ExpressionEngine');
  }
  E = sandbox.window.ExpressionEngine;
});

// ===========================================================================
// (A) CORRECTNESS
// ===========================================================================
describe('expression engine — correctness', () => {
  it('isExpression detects {{ }} templates only', () => {
    expect(E.isExpression('{{ $json.x }}')).toBe(true);
    expect(E.isExpression('hi {{ x }} bye')).toBe(true);
    expect(E.isExpression('plain text')).toBe(false);
    expect(E.isExpression('')).toBe(false);
    expect(E.isExpression(123 as unknown as string)).toBe(false);
    expect(E.isExpression(null as unknown as string)).toBe(false);
  });

  it('reads $json members', () => {
    const ctx: EvalCtx = { json: { name: 'Ada', count: 3 } };
    expect(E.evaluate('$json.name', ctx)).toBe('Ada');
    expect(E.evaluate('$json["count"]', ctx)).toBe(3);
  });

  it('reads $node["Name"].json.x', () => {
    const ctx: EvalCtx = { node: { 'HTTP Request': { json: { status: 200 } } } };
    expect(E.evaluate('$node["HTTP Request"].json.status', ctx)).toBe(200);
  });

  it('exposes $vars, $index, $now, $today', () => {
    const now = new Date('2026-06-06T12:34:56.000Z');
    const ctx: EvalCtx = { vars: { api: 'https://x' }, index: 7, now };
    expect(E.evaluate('$vars.api', ctx)).toBe('https://x');
    expect(E.evaluate('$index', ctx)).toBe(7);
    expect(E.evaluate('$now', ctx)).toBe('2026-06-06T12:34:56.000Z');
    expect(E.evaluate('$today', ctx)).toBe('2026-06-06');
  });

  it('arithmetic, precedence, parens, unary', () => {
    expect(E.evaluate('1 + 2 * 3')).toBe(7);
    expect(E.evaluate('(1 + 2) * 3')).toBe(9);
    expect(E.evaluate('-5 + 2')).toBe(-3);
    expect(E.evaluate('10 % 3')).toBe(1);
    expect(E.evaluate('!false')).toBe(true);
  });

  it('comparison + logical operators', () => {
    expect(E.evaluate('1 < 2 && 2 <= 2')).toBe(true);
    expect(E.evaluate('1 === 1')).toBe(true);
    expect(E.evaluate('1 !== "1"')).toBe(true);
    expect(E.evaluate('0 || "fallback"')).toBe('fallback');
  });

  it('ternary', () => {
    const ctx: EvalCtx = { json: { n: 5 } };
    expect(E.evaluate('$json.n > 3 ? "big" : "small"', ctx)).toBe('big');
  });

  it('array literals + index + length', () => {
    expect(E.evaluate('[1, 2, 3].length')).toBe(3);
    expect(E.evaluate('[10, 20, 30][1]')).toBe(20);
  });

  it('whitelisted string methods', () => {
    const ctx: EvalCtx = { json: { name: 'ada lovelace' } };
    expect(E.evaluate('$json.name.toUpperCase()', ctx)).toBe('ADA LOVELACE');
    expect(E.evaluate('"  hi  ".trim()')).toBe('hi');
    expect(E.evaluate('"a,b,c".split(",").length', ctx)).toBe(3);
    expect(E.evaluate('"hello".slice(0, 2)')).toBe('he');
  });

  it('whitelisted Math + JSON + casting globals', () => {
    expect(E.evaluate('Math.max(2, 9, 4)')).toBe(9);
    expect(E.evaluate('Math.round(2.6)')).toBe(3);
    expect(E.evaluate('Number("42")')).toBe(42);
    expect(E.evaluate('String(7)')).toBe('7');
    expect(E.evaluate('JSON.stringify([1,2])')).toBe('[1,2]');
  });

  it('evaluateTemplate interpolates and stringifies', () => {
    const ctx: EvalCtx = { json: { name: 'Ada' }, index: 0 };
    expect(E.evaluateTemplate('Hi {{ $json.name }}, row {{ $index + 1 }}', ctx)).toBe(
      'Hi Ada, row 1'
    );
  });

  it('whole-string template preserves native type', () => {
    const ctx: EvalCtx = { json: { count: 3 } };
    const out = E.evaluateTemplate('{{ $json.count }}', ctx);
    expect(out).toBe(3);
    expect(typeof out).toBe('number');
  });

  it('non-expression strings pass through evaluateTemplate unchanged', () => {
    expect(E.evaluateTemplate('plain', {})).toBe('plain');
  });

  it('evaluate throws on syntax error', () => {
    expect(() => E.evaluate('1 +', {})).toThrow();
    expect(() => E.evaluate('"unterminated', {})).toThrow();
    expect(() => E.evaluate('$json.x )', {})).toThrow();
  });

  it('member access on null/undefined yields undefined (no throw)', () => {
    expect(E.evaluate('$json.missing.deep', { json: {} })).toBeUndefined();
  });
});

// ===========================================================================
// (B) MAPPING to backend params
// ===========================================================================
describe('expression engine — mapParams', () => {
  it('maps expression values and passes through plain values', () => {
    const ctx: EvalCtx = { json: { url: 'https://api.test', n: 2 } };
    const r = E.mapParams(
      { selector: '#btn', url: '{{ $json.url }}', count: '{{ $json.n * 5 }}' },
      ctx
    );
    expect(r.params.selector).toBe('#btn');
    expect(r.params.url).toBe('https://api.test');
    expect(r.params.count).toBe(10);
    expect(Object.keys(r.errors)).toEqual([]);
  });

  it('collects per-key errors without throwing', () => {
    const r = E.mapParams({ a: 'ok', bad: '{{ 1 + }}' }, {});
    expect(r.params.a).toBe('ok');
    // failed expression keeps its raw text so backend sees something sane
    expect(r.params.bad).toBe('{{ 1 + }}');
    expect(r.errors.bad).toBeTruthy();
  });

  it('handles empty / nullish params', () => {
    expect(E.mapParams({}, {}).params).toEqual({});
    expect(E.mapParams(undefined as unknown as Record<string, unknown>, {}).params).toEqual({});
  });

  it('leaves non-string param values untouched', () => {
    const r = E.mapParams({ flag: true, n: 5, list: [1, 2] } as Record<string, unknown>, {});
    expect(r.params.flag).toBe(true);
    expect(r.params.n).toBe(5);
    expect(r.params.list).toEqual([1, 2]);
  });
});

// ===========================================================================
// (C) SANDBOX SECURITY  — the n8n CVE lesson
// ===========================================================================
describe('expression engine — sandbox security (no escape)', () => {
  it('blocks .constructor access', () => {
    expect(() => E.evaluate('"".constructor', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('(1).constructor', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('[].constructor', {})).toThrow(/not allowed/i);
  });

  it('blocks __proto__ access', () => {
    expect(() => E.evaluate('$json.__proto__', { json: {} })).toThrow(/not allowed/i);
    expect(() => E.evaluate('$json["__proto__"]', { json: {} })).toThrow(/not allowed/i);
  });

  it('blocks prototype access', () => {
    expect(() => E.evaluate('$json.prototype', { json: {} })).toThrow(/not allowed/i);
  });

  it('blocks the classic constructor.constructor("...")() escape', () => {
    // The hallmark of n8n-style RCE: reach Function via .constructor twice.
    // The first `.constructor` member access is what gets blocked — the escape
    // can never even be parsed into a reachable callee.
    expect(() => E.evaluate('"".constructor.constructor("return process")()', {})).toThrow();
    expect(() => E.evaluate('[].constructor.constructor', {})).toThrow(/not allowed/i);
  });

  it('blocks __defineGetter__ / __lookupGetter__ etc.', () => {
    expect(() => E.evaluate('$json.__defineGetter__', { json: {} })).toThrow(/not allowed/i);
    expect(() => E.evaluate('$json.__lookupGetter__', { json: {} })).toThrow(/not allowed/i);
  });

  it('has NO access to Function / eval / globalThis / process / require', () => {
    expect(() => E.evaluate('Function', {})).toThrow(/unknown identifier/i);
    expect(() => E.evaluate('eval', {})).toThrow(/unknown identifier/i);
    expect(() => E.evaluate('globalThis', {})).toThrow(/unknown identifier/i);
    expect(() => E.evaluate('process', {})).toThrow(/unknown identifier/i);
    expect(() => E.evaluate('require', {})).toThrow(/unknown identifier/i);
    expect(() => E.evaluate('window', {})).toThrow(/unknown identifier/i);
    expect(() => E.evaluate('global', {})).toThrow(/unknown identifier/i);
  });

  it('rejects calling Function/eval even via () syntax', () => {
    expect(() => E.evaluate('Function("return 1")', {})).toThrow();
    expect(() => E.evaluate('eval("1+1")', {})).toThrow();
  });

  it('rejects non-whitelisted array methods (no user-fn execution)', () => {
    // Use a literal arg so the failure is the method-whitelist check, not the
    // (also-safe) "unknown identifier" rejection of a bare callback name.
    expect(() => E.evaluate('[1,2,3].map(1)', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('[1,2,3].filter(1)', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('[1,2,3].forEach(1)', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('[1,2,3].reduce(1)', {})).toThrow(/not allowed/i);
    // a bare callback identifier is ALSO rejected (no user fns in scope)
    expect(() => E.evaluate('[1,2,3].map(x)', {})).toThrow();
  });

  it('rejects non-whitelisted string/number methods', () => {
    // bind/call/apply must never be reachable
    expect(() => E.evaluate('"x".bind()', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('"x".call()', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('"x".apply()', {})).toThrow(/not allowed/i);
    expect(() => E.evaluate('(5).valueOf()', {})).toThrow(/not allowed/i);
  });

  it('cannot reach toString to leak the engine internals', () => {
    // toString is not in the string/array whitelist (only number whitelist),
    // and there is no Object base whitelist.
    expect(() => E.evaluate('[].toString()', {})).toThrow(/not allowed/i);
  });

  it('a context object cannot be mutated through the expression', () => {
    const json: Record<string, unknown> = { a: 1 };
    // assignment is not even in the grammar — this is a parse error, not a write
    expect(() => E.evaluate('$json.a = 2', { json })).toThrow();
    expect(json.a).toBe(1);
  });

  it('cannot pollute Object.prototype via mapParams', () => {
    const before = ({} as Record<string, unknown>).polluted;
    E.mapParams({ x: '{{ $json["__proto__"]["polluted"] }}' }, { json: {} });
    expect(({} as Record<string, unknown>).polluted).toBe(before);
  });
});
