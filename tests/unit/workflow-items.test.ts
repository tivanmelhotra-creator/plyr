import { describe, it, expect } from 'vitest';
import {
  emptyItem,
  emptyStream,
  isWorkflowItem,
  toItem,
  normalizeToItems,
  resolveOutputStream,
  itemsToJson,
  summarizeItems,
  type WorkflowItem
} from '../../src/core/WorkflowItems';

// ════════════════════════════════════════════════════════════════
// Step 21 — uniform, item-based data model.
// The contract: data flowing between steps is ALWAYS an array of items
// shaped { json: object, binary?: {...} }. These tests lock that down and
// guard backward-compatibility behaviours (pass-through, primitives, etc.).
// ════════════════════════════════════════════════════════════════

describe('WorkflowItems — empty stream / item', () => {
  it('emptyItem() is a single item with an empty json object', () => {
    const it0 = emptyItem();
    expect(it0).toEqual({ json: {} });
    expect(isWorkflowItem(it0)).toBe(true);
  });

  it('emptyStream() is exactly one empty item (n8n-style first input)', () => {
    const s = emptyStream();
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({ json: {} });
  });

  it('emptyStream() returns fresh objects (no shared reference)', () => {
    const a = emptyStream();
    const b = emptyStream();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    a[0].json.x = 1;
    expect(b[0].json).toEqual({});
  });
});

describe('WorkflowItems — isWorkflowItem guard', () => {
  it('accepts a well-formed item', () => {
    expect(isWorkflowItem({ json: { a: 1 } })).toBe(true);
    expect(isWorkflowItem({ json: {}, binary: {} })).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isWorkflowItem(null)).toBe(false);
    expect(isWorkflowItem(undefined)).toBe(false);
    expect(isWorkflowItem(42)).toBe(false);
    expect(isWorkflowItem('hi')).toBe(false);
    expect(isWorkflowItem([])).toBe(false);
    expect(isWorkflowItem({})).toBe(false); // no json
    expect(isWorkflowItem({ json: [] })).toBe(false); // json must be object, not array
    expect(isWorkflowItem({ json: 5 })).toBe(false);
  });
});

describe('WorkflowItems — toItem', () => {
  it('wraps a plain object as json (copied, not aliased)', () => {
    const src = { a: 1, b: 'x' };
    const item = toItem(src);
    expect(item).toEqual({ json: { a: 1, b: 'x' } });
    item.json.a = 999;
    expect(src.a).toBe(1); // original untouched
  });

  it('wraps a primitive under a `value` key', () => {
    expect(toItem(42)).toEqual({ json: { value: 42 } });
    expect(toItem('hello')).toEqual({ json: { value: 'hello' } });
    expect(toItem(true)).toEqual({ json: { value: true } });
  });

  it('wraps an array under a `value` key', () => {
    expect(toItem([1, 2, 3])).toEqual({ json: { value: [1, 2, 3] } });
  });

  it('passes through an existing item but copies it', () => {
    const orig: WorkflowItem = { json: { a: 1 }, binary: { f: { fileName: 'a.txt' } } };
    const copy = toItem(orig);
    expect(copy).toEqual(orig);
    expect(copy).not.toBe(orig);
    expect(copy.json).not.toBe(orig.json);
    expect(copy.binary).not.toBe(orig.binary);
  });
});

describe('WorkflowItems — normalizeToItems', () => {
  it('null / undefined produce an empty array (no output)', () => {
    expect(normalizeToItems(null)).toEqual([]);
    expect(normalizeToItems(undefined)).toEqual([]);
  });

  it('a single object becomes one item', () => {
    expect(normalizeToItems({ title: 'X' })).toEqual([{ json: { title: 'X' } }]);
  });

  it('a primitive becomes one wrapped item', () => {
    expect(normalizeToItems(7)).toEqual([{ json: { value: 7 } }]);
  });

  it('an array of objects becomes one item PER element (n-item fan-out)', () => {
    const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const items = normalizeToItems(arr);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ json: { id: 1 } });
    expect(items[2]).toEqual({ json: { id: 3 } });
  });

  it('an array of primitives becomes one wrapped item per element', () => {
    const items = normalizeToItems(['a', 'b']);
    expect(items).toEqual([{ json: { value: 'a' } }, { json: { value: 'b' } }]);
  });

  it('an empty array produces no items', () => {
    expect(normalizeToItems([])).toEqual([]);
  });

  it('an array of pre-shaped items is preserved (copied)', () => {
    const items = normalizeToItems([{ json: { a: 1 } }, { json: { a: 2 } }]);
    expect(items).toEqual([{ json: { a: 1 } }, { json: { a: 2 } }]);
  });
});

describe('WorkflowItems — resolveOutputStream (pass-through behaviour)', () => {
  it('uses produced items when the step yields data', () => {
    const prev = [{ json: { from: 'prev' } }];
    const out = resolveOutputStream([{ done: true }], prev);
    expect(out).toEqual([{ json: { done: true } }]);
  });

  it('passes through the previous stream when the step yields nothing', () => {
    const prev = [{ json: { from: 'prev' } }];
    expect(resolveOutputStream(null, prev)).toBe(prev);
    expect(resolveOutputStream(undefined, prev)).toBe(prev);
    expect(resolveOutputStream([], prev)).toBe(prev);
  });
});

describe('WorkflowItems — itemsToJson', () => {
  it('extracts just the json payloads', () => {
    const items = [{ json: { a: 1 } }, { json: { b: 2 } }];
    expect(itemsToJson(items)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('WorkflowItems — summarizeItems', () => {
  it('summarizes count + a capped sample', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ json: { i } }));
    const sum = summarizeItems(items, 5);
    expect(sum.itemCount).toBe(12);
    expect(sum.sample).toHaveLength(5);
    expect(sum.sample[0]).toEqual({ i: 0 });
    expect(sum.truncated).toBe(true);
  });

  it('is not truncated when items fit within the sample', () => {
    const items = [{ json: { a: 1 } }, { json: { a: 2 } }];
    const sum = summarizeItems(items, 5);
    expect(sum.itemCount).toBe(2);
    expect(sum.sample).toHaveLength(2);
    expect(sum.truncated).toBe(false);
  });

  it('handles undefined / empty safely', () => {
    expect(summarizeItems(undefined)).toEqual({ itemCount: 0, sample: [], truncated: false });
    expect(summarizeItems([])).toEqual({ itemCount: 0, sample: [], truncated: false });
  });

  it('caps oversized samples by dropping items', () => {
    // Each item carries a large string; the ~8KB cap should drop the sample.
    const big = 'x'.repeat(5000);
    const items = Array.from({ length: 5 }, () => ({ json: { big } }));
    const sum = summarizeItems(items, 5);
    expect(sum.itemCount).toBe(5);
    expect(sum.truncated).toBe(true);
    // sample is reduced below the requested 5 because of the size cap
    expect(sum.sample.length).toBeLessThan(5);
    expect(sum.sample.length).toBeGreaterThanOrEqual(1);
  });
});
