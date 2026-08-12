import { describe, it, expect, beforeEach } from 'vitest';
import {
  InspectorHub,
  valueForKey,
  mapSelectionToFields,
  normalizeElement,
  summarizeSelection,
  type InspectorElement,
} from '../../src/core/InspectorHub';

// ════════════════════════════════════════════════════════════════
// InspectorHub — the routing layer between a picked element and a node.
//
// Two behaviours are load-bearing and get the most attention here:
//
//   1. A submission that cannot be placed CORRECTLY must be refused, never
//      delivered somewhere plausible. A selector in the wrong node fails
//      silently at run time, which is far more expensive to debug than an
//      error message at pick time.
//   2. Attribute lookup must be generic. `valueForKey` falling back to the
//      element's own attribute list is what makes data-* work; a refactor to a
//      switch-only implementation would break the requirement invisibly.
// ════════════════════════════════════════════════════════════════

function el(over: Partial<InspectorElement> = {}): InspectorElement {
  return {
    tag: 'a',
    id: 'buy',
    classes: ['btn', 'primary'],
    css: 'a#buy',
    xpath: '//*[@id="buy"]',
    text: 'Buy now',
    value: '',
    name: '',
    role: 'link',
    type: '',
    attrs: [
      { name: 'href', value: '/checkout' },
      { name: 'data-sku', value: 'SKU-1' },
      { name: 'data-anything-at-all', value: 'yes' },
    ],
    ...over,
  };
}

describe('valueForKey: computed keys', () => {
  const e = el();
  it('serves the identity and content keys', () => {
    expect(valueForKey(e, 'tag')).toBe('a');
    expect(valueForKey(e, 'id')).toBe('buy');
    expect(valueForKey(e, 'class')).toBe('btn primary');
    expect(valueForKey(e, 'css')).toBe('a#buy');
    expect(valueForKey(e, 'xpath')).toBe('//*[@id="buy"]');
    expect(valueForKey(e, 'text')).toBe('Buy now');
    expect(valueForKey(e, 'role')).toBe('link');
  });
  it('accepts the aliases the extension may send', () => {
    expect(valueForKey(e, 'tagName')).toBe('a');
    expect(valueForKey(e, 'cssSelector')).toBe('a#buy');
    expect(valueForKey(e, 'innerText')).toBe('Buy now');
    expect(valueForKey(e, 'className')).toBe('btn primary');
  });
});

describe('valueForKey: the generic attribute path', () => {
  it('resolves any attribute by name, with no hardcoded list', () => {
    const e = el();
    expect(valueForKey(e, 'href')).toBe('/checkout');
    expect(valueForKey(e, 'data-sku')).toBe('SKU-1');
    // The whole point: an attribute this codebase has never heard of.
    expect(valueForKey(e, 'data-anything-at-all')).toBe('yes');
  });
  it('is case-insensitive about the key', () => {
    expect(valueForKey(el(), 'DATA-SKU')).toBe('SKU-1');
  });
  it('returns empty for an attribute the element does not have', () => {
    expect(valueForKey(el(), 'colspan')).toBe('');
  });
});

describe('normalizeElement', () => {
  it('requires only a tag', () => {
    const n = normalizeElement({ tag: 'div' });
    expect(n).toBeTruthy();
    expect(n!.tag).toBe('div');
  });
  it('rejects junk instead of inventing an element', () => {
    expect(normalizeElement(null)).toBeNull();
    expect(normalizeElement({})).toBeNull();
    expect(normalizeElement({ tag: '   ' })).toBeNull();
  });
  it('de-duplicates attribute names case-insensitively', () => {
    const n = normalizeElement({
      tag: 'div',
      attrs: [{ name: 'DATA-ID', value: 'a' }, { name: 'data-id', value: 'b' }],
    })!;
    expect(n.attrs).toHaveLength(1);
    expect(n.attrs![0]!.name).toBe('data-id');
  });
  it('collapses whitespace in text', () => {
    expect(normalizeElement({ tag: 'p', text: 'a  \n b' })!.text).toBe('a b');
  });
});

describe('mapSelectionToFields: selector precedence', () => {
  it('prefers the CSS path', () => {
    const f = mapSelectionToFields(el(), ['css']);
    expect(f.selector).toBe('a#buy');
    expect(f.selectorType).toBe('css');
  });
  it('uses xpath when css was not ticked', () => {
    const f = mapSelectionToFields(el({ css: '' }), ['xpath']);
    expect(f.selector).toBe('//*[@id="buy"]');
    expect(f.selectorType).toBe('xpath');
  });
  it('falls back to #id so an id-only pick is still actionable', () => {
    const f = mapSelectionToFields(el({ css: '', xpath: '' }), ['id']);
    expect(f.selector).toBe('#buy');
    expect(f.selectorType).toBe('css');
  });
  it('falls back to the first class', () => {
    const f = mapSelectionToFields(el({ css: '', xpath: '', id: '' }), ['class']);
    expect(f.selector).toBe('.btn');
  });
  it('always produces a selector, even with no identity key ticked', () => {
    // A pick that yields no selector would leave the user hand-editing a field.
    const f = mapSelectionToFields(el(), ['href']);
    expect(f.selector).toBe('a#buy');
  });
  it('keeps xpath separately when css won the selector slot', () => {
    const f = mapSelectionToFields(el(), ['css', 'xpath']);
    expect(f.selector).toBe('a#buy');
    expect(f.xpath).toBe('//*[@id="buy"]');
  });
});

describe('mapSelectionToFields: attribute and value', () => {
  it('puts the attribute NAME in attribute and its value in value', () => {
    // The node must read the attribute live at run time, so the name is what it
    // needs; the value is shown so the user can confirm they picked correctly.
    const f = mapSelectionToFields(el(), ['css', 'data-sku']);
    expect(f.attribute).toBe('data-sku');
    expect(f.value).toBe('SKU-1');
  });
  it('handles href the same generic way', () => {
    const f = mapSelectionToFields(el(), ['href']);
    expect(f.attribute).toBe('href');
    expect(f.value).toBe('/checkout');
  });
  it('fills text when ticked', () => {
    expect(mapSelectionToFields(el(), ['text']).text).toBe('Buy now');
  });
  it('derives a safe variable name for extract nodes', () => {
    const f = mapSelectionToFields(el(), ['css', 'data-sku'], 'extract');
    expect(f.name).toBe('data_sku');
  });
  it('does not invent a name for non-extract nodes', () => {
    expect(mapSelectionToFields(el(), ['css'], 'click').name).toBeUndefined();
  });
});

describe('summarizeSelection', () => {
  it('names the element and the ticked keys', () => {
    expect(summarizeSelection(el(), ['css', 'href'])).toBe('a#buy — css, href');
  });
});

describe('InspectorHub: claim / submit routing', () => {
  let hub: InspectorHub;
  beforeEach(() => { hub = new InspectorHub(); });

  it('refuses a submission when no node is waiting', () => {
    const r = hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_active_node');
  });

  it('refuses a submission from a stale session rather than mis-delivering', () => {
    // THE core guarantee: a pick that cannot be placed correctly is not placed.
    hub.claim('u1', { sessionId: 's2', nodeId: 'n2' });
    const r = hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stale_session');
  });

  it('refuses an empty selection', () => {
    hub.claim('u1', { sessionId: 's1', nodeId: 'n1' });
    const r = hub.submit('u1', { sessionId: 's1', element: el(), selected: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty_selection');
  });

  it('refuses an unusable element', () => {
    hub.claim('u1', { sessionId: 's1', nodeId: 'n1' });
    const r = hub.submit('u1', { sessionId: 's1', element: {} as never, selected: ['css'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_element');
  });

  it('delivers to the claimed node with fields already mapped', () => {
    hub.claim('u1', { sessionId: 's1', nodeId: 'n1', action: 'click' });
    const r = hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css', 'href'] });
    expect(r.ok).toBe(true);
    expect(r.delivery!.session.nodeId).toBe('n1');
    expect(r.delivery!.fields.selector).toBe('a#buy');
    expect(r.delivery!.fields.attribute).toBe('href');
  });

  it('requires both sessionId and nodeId to claim', () => {
    expect(hub.claim('u1', { sessionId: '', nodeId: 'n' })).toBeNull();
    expect(hub.claim('u1', { sessionId: 's', nodeId: '' })).toBeNull();
  });

  it('keeps users separate', () => {
    hub.claim('u1', { sessionId: 's1', nodeId: 'n1' });
    // u2 never claimed, so u2's submission must not ride u1's claim.
    const r = hub.submit('u2', { sessionId: 's1', element: el(), selected: ['css'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_active_node');
  });

  it('release is ignored when a newer session holds the claim', () => {
    // A stale tab closing must not release the claim a newer tab just made.
    hub.claim('u1', { sessionId: 'new', nodeId: 'n1' });
    expect(hub.release('u1', 'old')).toBe(false);
    expect(hub.activeNode('u1')!.sessionId).toBe('new');
    expect(hub.release('u1', 'new')).toBe(true);
    expect(hub.activeNode('u1')).toBeNull();
  });
});

describe('InspectorHub: inbox', () => {
  let hub: InspectorHub;
  beforeEach(() => {
    hub = new InspectorHub();
    hub.claim('u1', { sessionId: 's1', nodeId: 'n1' });
  });

  it('peek does not consume, drain does', () => {
    // A client that asks and then fails to apply must not have destroyed the
    // only copy of the pick.
    hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css'] });
    expect(hub.peek('u1')).toHaveLength(1);
    expect(hub.peek('u1')).toHaveLength(1);
    expect(hub.drain('u1')).toHaveLength(1);
    expect(hub.peek('u1')).toHaveLength(0);
  });

  it('ack removes exactly one delivery', () => {
    const a = hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css'] });
    hub.submit('u1', { sessionId: 's1', element: el(), selected: ['text'] });
    expect(hub.ack('u1', a.delivery!.id)).toBe(true);
    expect(hub.ack('u1', a.delivery!.id)).toBe(false);
    expect(hub.peek('u1')).toHaveLength(1);
  });

  it('notifies subscribers', () => {
    const seen: string[] = [];
    hub.subscribe((userId, d) => { seen.push(`${userId}:${d.fields.selector}`); });
    hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css'] });
    expect(seen).toEqual(['u1:a#buy']);
  });

  it('a throwing subscriber does not break delivery', () => {
    hub.subscribe(() => { throw new Error('bad listener'); });
    const r = hub.submit('u1', { sessionId: 's1', element: el(), selected: ['css'] });
    expect(r.ok).toBe(true);
    expect(hub.peek('u1')).toHaveLength(1);
  });
});
