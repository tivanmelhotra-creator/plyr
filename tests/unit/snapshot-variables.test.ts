import { describe, it, expect } from 'vitest';
import { snapshotVariables } from '../../src/pipeline';

describe('snapshotVariables', () => {
  it('previews values and masks credential-like names', () => {
    const m = new Map<string, any>([['price', 9], ['api_key', 'sk-123'], ['Password', 'x'], ['list', [1, 2]]]);
    const s = snapshotVariables(m);
    expect(s.price).toBe('9');
    expect(s.list).toBe('[1,2]');
    expect(s.api_key).not.toContain('sk-123');
    expect(s.Password).not.toContain('x1');
    expect(JSON.stringify(s)).not.toContain('sk-123');
  });
  it('truncates long values, caps entries, survives circular values', () => {
    const big = new Map<string, any>([['a', 'x'.repeat(5000)]]);
    expect(snapshotVariables(big).a.length).toBeLessThanOrEqual(201);
    const many = new Map<string, any>();
    for (let i = 0; i < 80; i++) many.set('v' + i, i);
    expect(Object.keys(snapshotVariables(many)).length).toBe(50);
    const c: any = {}; c.self = c;
    expect(() => snapshotVariables(new Map([['c', c]]))).not.toThrow();
  });
  it('handles undefined', () => { expect(snapshotVariables(undefined)).toEqual({}); });
});
