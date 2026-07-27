import { describe, it, expect, vi } from 'vitest';
import { ConditionEngine, type Condition } from '../../src/core/ConditionEngine';
import type { Page } from 'playwright';

// A minimal fake Page. The non-DOM operators tested below never touch the page
// (no selector is supplied), so a stub is enough; DOM operators are exercised
// separately with a controllable locator.
function makeEngine(vars: Record<string, unknown> = {}, page?: Partial<Page>) {
  const map = new Map<string, unknown>(Object.entries(vars));
  const fakePage = (page ?? {}) as unknown as Page;
  return new ConditionEngine(fakePage, map as Map<string, never>);
}

describe('ConditionEngine — value operators (no selector)', () => {
  const eng = makeEngine();
  it('equals / not_equals', async () => {
    expect(await eng.evaluate({ operator: 'equals', value: 'abc', expected: 'abc' })).toBe(true);
    expect(await eng.evaluate({ operator: 'equals', value: 'abc', expected: 'xyz' })).toBe(false);
    expect(await eng.evaluate({ operator: 'not_equals', value: 'a', expected: 'b' })).toBe(true);
  });
  it('contains / not_contains / starts_with / ends_with', async () => {
    expect(await eng.evaluate({ operator: 'contains', value: 'hello world', expected: 'world' })).toBe(true);
    expect(await eng.evaluate({ operator: 'not_contains', value: 'hello', expected: 'zzz' })).toBe(true);
    expect(await eng.evaluate({ operator: 'starts_with', value: 'foobar', expected: 'foo' })).toBe(true);
    expect(await eng.evaluate({ operator: 'ends_with', value: 'foobar', expected: 'bar' })).toBe(true);
  });
  it('is_empty / not_empty (trims first)', async () => {
    expect(await eng.evaluate({ operator: 'is_empty', value: '' })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_empty', value: '   ' })).toBe(true);
    expect(await eng.evaluate({ operator: 'not_empty', value: 'x' })).toBe(true);
  });
  it('numeric comparisons (with currency stripping)', async () => {
    expect(await eng.evaluate({ operator: 'greater_than', value: '10', expected: '5' })).toBe(true);
    expect(await eng.evaluate({ operator: 'less_than', value: '3', expected: '5' })).toBe(true);
    expect(await eng.evaluate({ operator: 'greater_equal', value: '5', expected: '5' })).toBe(true);
    expect(await eng.evaluate({ operator: 'less_equal', value: '4', expected: '5' })).toBe(true);
    expect(await eng.evaluate({ operator: 'greater_than', value: '$1,234', expected: '1000' })).toBe(true);
  });
  it('boolean checks', async () => {
    expect(await eng.evaluate({ operator: 'is_true', value: true })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_true', value: 'true' })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_false', value: false })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_false', value: 'false' })).toBe(true);
  });
  it('list membership', async () => {
    expect(await eng.evaluate({ operator: 'in_list', value: 'b', expected: ['a', 'b', 'c'] })).toBe(true);
    expect(await eng.evaluate({ operator: 'not_in_list', value: 'z', expected: ['a', 'b'] })).toBe(true);
    expect(await eng.evaluate({ operator: 'in_list', value: 'x', expected: 'not-an-array' })).toBe(false);
  });
  it('matches_regex (safe) and blocks unsafe ReDoS patterns', async () => {
    expect(await eng.evaluate({ operator: 'matches_regex', value: 'abc123', expected: '\\d+' })).toBe(true);
    // (a+)+$ is flagged unsafe by safe-regex2 -> blocked -> false
    expect(await eng.evaluate({ operator: 'matches_regex', value: 'aaaa', expected: '(a+)+$' })).toBe(false);
  });
  it('unknown operator returns false', async () => {
    expect(await eng.evaluate({ operator: 'bogus' as never, value: 'x' })).toBe(false);
  });
});

describe('ConditionEngine — composites', () => {
  const eng = makeEngine();
  it('all (AND)', async () => {
    const pass: Condition = { all: [
      { operator: 'equals', value: 'a', expected: 'a' },
      { operator: 'contains', value: 'abc', expected: 'b' },
    ] };
    expect(await eng.evaluate(pass)).toBe(true);
    const fail: Condition = { all: [
      { operator: 'equals', value: 'a', expected: 'a' },
      { operator: 'equals', value: 'a', expected: 'b' },
    ] };
    expect(await eng.evaluate(fail)).toBe(false);
  });
  it('any (OR)', async () => {
    const c: Condition = { any: [
      { operator: 'equals', value: 'a', expected: 'b' },
      { operator: 'equals', value: 'a', expected: 'a' },
    ] };
    expect(await eng.evaluate(c)).toBe(true);
    expect(await eng.evaluate({ any: [{ operator: 'equals', value: '1', expected: '2' }] })).toBe(false);
  });
  it('not', async () => {
    expect(await eng.evaluate({ not: { operator: 'equals', value: 'a', expected: 'b' } })).toBe(true);
    expect(await eng.evaluate({ not: { operator: 'equals', value: 'a', expected: 'a' } })).toBe(false);
  });
  it('nested composites', async () => {
    const c: Condition = { all: [
      { any: [ { operator: 'equals', value: '1', expected: '2' }, { operator: 'equals', value: '1', expected: '1' } ] },
      { not: { operator: 'is_empty', value: 'x' } },
    ] };
    expect(await eng.evaluate(c)).toBe(true);
  });
});

describe('ConditionEngine — resolveVariables', () => {
  const eng = makeEngine({ name: 'Ada', count: 7 });
  it('substitutes {{var}} tokens from the variable map', () => {
    expect(eng.resolveVariables('Hello {{name}}!')).toBe('Hello Ada!');
    expect(eng.resolveVariables('n={{count}}')).toBe('n=7');
  });
  it('replaces unknown tokens with empty string', () => {
    expect(eng.resolveVariables('x={{missing}}')).toBe('x=');
  });
  it('returns non-strings unchanged', () => {
    expect(eng.resolveVariables(42 as never)).toBe(42);
    const arr = [1, 2, 3];
    expect(eng.resolveVariables(arr as never)).toBe(arr);
  });
  it('resolves variables inside an equals comparison', async () => {
    expect(await eng.evaluate({ operator: 'equals', value: '{{name}}', expected: 'Ada' })).toBe(true);
  });
});

describe('ConditionEngine — DOM operators (controllable locator)', () => {
  function pageWith(count: number, visible = true): Partial<Page> {
    const locator = {
      first() { return this; },
      count: vi.fn(async () => count),
      isVisible: vi.fn(async () => visible),
      innerText: vi.fn(async () => ''),
      inputValue: vi.fn(async () => ''),
    };
    return { locator: vi.fn(() => locator) } as unknown as Partial<Page>;
  }
  it('exists / not_exists based on element count', async () => {
    const present = makeEngine({}, pageWith(1));
    const absent = makeEngine({}, pageWith(0));
    expect(await present.evaluate({ operator: 'exists', selector: '#a' })).toBe(true);
    expect(await absent.evaluate({ operator: 'exists', selector: '#a' })).toBe(false);
    expect(await absent.evaluate({ operator: 'not_exists', selector: '#a' })).toBe(true);
  });
  it('visible / hidden', async () => {
    const shown = makeEngine({}, pageWith(1, true));
    const hiddenEl = makeEngine({}, pageWith(1, false));
    expect(await shown.evaluate({ operator: 'visible', selector: '#a' })).toBe(true);
    expect(await hiddenEl.evaluate({ operator: 'hidden', selector: '#a' })).toBe(true);
  });
  it('DOM operator without selector returns false', async () => {
    const eng = makeEngine({}, pageWith(1));
    expect(await eng.evaluate({ operator: 'exists' })).toBe(false);
  });
});

// The Condition Builder NDV (docs/uiux/ndv-condition-final.md) adds a
// "Left source" dropdown + "Attribute name" field to every row. They travel to
// the engine as SimpleCondition.source / .attribute. Anything not covered here
// would be a UI control the runtime silently ignores.
describe('ConditionEngine — Left source (source / attribute)', () => {
  function pageWithElement(parts: {
    count?: number;
    innerText?: string;
    inputValue?: string;
    innerHTML?: string;
    attributes?: Record<string, string>;
  }) {
    const locator = {
      first() { return this; },
      count: vi.fn(async () => parts.count ?? 1),
      isVisible: vi.fn(async () => true),
      innerText: vi.fn(async () => parts.innerText ?? ''),
      inputValue: vi.fn(async () => parts.inputValue ?? ''),
      innerHTML: vi.fn(async () => parts.innerHTML ?? ''),
      getAttribute: vi.fn(async (name: string) =>
        parts.attributes && name in parts.attributes ? parts.attributes[name] : null),
    };
    return { page: { locator: vi.fn(() => locator) } as unknown as Partial<Page>, locator };
  }

  it('source omitted === text: reads innerText (legacy behaviour)', async () => {
    const { page, locator } = pageWithElement({ innerText: 'Logged out' });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({ operator: 'equals', selector: '#s', expected: 'Logged out' })).toBe(true);
    expect(locator.innerText).toHaveBeenCalled();
    expect(locator.getAttribute).not.toHaveBeenCalled();
  });

  it("source 'text' still falls back to inputValue when there is no text", async () => {
    const { page } = pageWithElement({ innerText: '', inputValue: 'typed@example.com' });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'equals', selector: 'input', source: 'text', expected: 'typed@example.com',
    })).toBe(true);
  });

  it("source 'attribute' reads getAttribute(attribute) and NOT the text", async () => {
    const { page, locator } = pageWithElement({
      innerText: 'visible label', attributes: { 'data-state': 'ready', href: '/next' },
    });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'equals', selector: '#s', source: 'attribute', attribute: 'data-state', expected: 'ready',
    })).toBe(true);
    expect(locator.getAttribute).toHaveBeenCalledWith('data-state');
    // The element's text must not leak into the comparison.
    expect(await eng.evaluate({
      operator: 'equals', selector: '#s', source: 'attribute', attribute: 'data-state',
      expected: 'visible label',
    })).toBe(false);
  });

  it("source 'attribute' with a missing attribute compares as empty", async () => {
    const { page } = pageWithElement({ innerText: 'hi', attributes: {} });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'is_empty', selector: '#s', source: 'attribute', attribute: 'data-missing',
    })).toBe(true);
  });

  it("source 'attribute' with no attribute name falls back to text", async () => {
    const { page } = pageWithElement({ innerText: 'fallback' });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'equals', selector: '#s', source: 'attribute', expected: 'fallback',
    })).toBe(true);
  });

  it('the attribute name itself supports {{variable}} interpolation', async () => {
    const { page, locator } = pageWithElement({ attributes: { 'data-role': 'admin' } });
    const eng = makeEngine({ attr: 'data-role' }, page);
    expect(await eng.evaluate({
      operator: 'equals', selector: '#s', source: 'attribute', attribute: '{{attr}}', expected: 'admin',
    })).toBe(true);
    expect(locator.getAttribute).toHaveBeenCalledWith('data-role');
  });

  it("source 'value' reads inputValue even when the element has text", async () => {
    const { page, locator } = pageWithElement({ innerText: 'placeholder text', inputValue: 'ada' });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'equals', selector: 'input', source: 'value', expected: 'ada',
    })).toBe(true);
    expect(locator.inputValue).toHaveBeenCalled();
    expect(locator.innerText).not.toHaveBeenCalled();
  });

  it("source 'html' reads innerHTML so markup can be matched", async () => {
    const { page } = pageWithElement({ innerText: 'Bold', innerHTML: '<b>Bold</b>' });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'contains', selector: '#s', source: 'html', expected: '<b>',
    })).toBe(true);
  });

  it("source 'variable' reads the run context and never touches the DOM", async () => {
    const { page } = pageWithElement({ innerText: 'from-dom' });
    const eng = makeEngine({ status: 'ok' }, page);
    expect(await eng.evaluate({
      operator: 'equals', source: 'variable', value: 'status', expected: 'ok',
    })).toBe(true);
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("source 'variable' also accepts the {{token}} form", async () => {
    const eng = makeEngine({ count: 12 });
    expect(await eng.evaluate({
      operator: 'greater_than', source: 'variable', value: '{{count}}', expected: '10',
    })).toBe(true);
  });

  it("source 'variable' with an unknown name compares as empty", async () => {
    const eng = makeEngine({});
    expect(await eng.evaluate({ operator: 'is_empty', source: 'variable', value: 'nope' })).toBe(true);
  });

  it('an unknown source value degrades to text instead of failing', async () => {
    const { page } = pageWithElement({ innerText: 'safe' });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'equals', selector: '#s', source: 'bogus' as never, expected: 'safe',
    })).toBe(true);
  });

  it('source is ignored by the DOM-only operators (exists/visible)', async () => {
    const { page, locator } = pageWithElement({ count: 1 });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'exists', selector: '#s', source: 'attribute', attribute: 'href',
    })).toBe(true);
    expect(locator.getAttribute).not.toHaveBeenCalled();
  });

  it('a missing element yields empty for every source', async () => {
    const { page } = pageWithElement({ count: 0, innerText: 'ignored' });
    const eng = makeEngine({}, page);
    for (const source of ['text', 'attribute', 'value', 'html'] as const) {
      expect(await eng.evaluate({
        operator: 'is_empty', selector: '#gone', source, attribute: 'href',
      })).toBe(true);
    }
  });

  it('source/attribute work inside a composite condition (AND of two sources)', async () => {
    const { page } = pageWithElement({
      innerText: 'Ready', inputValue: 'ada', attributes: { 'data-state': 'ready' },
    });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({ all: [
      { operator: 'equals', selector: '#s', expected: 'Ready' },
      { operator: 'equals', selector: '#s', source: 'attribute', attribute: 'data-state', expected: 'ready' },
      { operator: 'equals', selector: '#s', source: 'value', expected: 'ada' },
    ] })).toBe(true);
  });
});
