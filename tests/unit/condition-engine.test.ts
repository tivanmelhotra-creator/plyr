import { describe, it, expect, vi } from 'vitest';
import { ConditionEngine, type Condition } from '../../src/core/ConditionEngine';
import { config } from '../../src/config';
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

/**
 * Automa parity (project rule R1, MISSIONS.md — mission 5).
 *
 * Automa's `conditionBuilder.compareTypes` offers case-INSENSITIVE twins
 * (`eqi`, `cni`, `nci`) and JS-truthiness checks (`itr`, `ifl`). The builder now
 * offers all five, so the engine has to honour them — an operator the UI can
 * emit but the runtime ignores is worse than no operator at all, because the
 * workflow silently takes the wrong branch.
 */
describe('ConditionEngine — Automa parity operators', () => {
  const eng = makeEngine();

  it('equals_i folds case away (Automa eqi)', async () => {
    expect(await eng.evaluate({ operator: 'equals_i', value: 'Sign Out', expected: 'sign out' })).toBe(true);
    expect(await eng.evaluate({ operator: 'equals_i', value: 'SIGN OUT', expected: 'Sign Out' })).toBe(true);
    // still a full-string comparison, not a substring one
    expect(await eng.evaluate({ operator: 'equals_i', value: 'sign out now', expected: 'sign out' })).toBe(false);
    // and the case-SENSITIVE twin must not have changed
    expect(await eng.evaluate({ operator: 'equals', value: 'Sign Out', expected: 'sign out' })).toBe(false);
  });

  it('contains_i / not_contains_i fold case away (Automa cni / nci)', async () => {
    expect(await eng.evaluate({ operator: 'contains_i', value: 'Total: PAID', expected: 'paid' })).toBe(true);
    expect(await eng.evaluate({ operator: 'contains', value: 'Total: PAID', expected: 'paid' })).toBe(false);
    expect(await eng.evaluate({ operator: 'not_contains_i', value: 'Total: PAID', expected: 'draft' })).toBe(true);
    expect(await eng.evaluate({ operator: 'not_contains_i', value: 'Total: PAID', expected: 'PaId' })).toBe(false);
  });

  it('is_truthy / is_falsy use JS truthiness, unlike is_true / is_false', async () => {
    // "did I get a value at all" — the check you want after reading the page
    expect(await eng.evaluate({ operator: 'is_truthy', value: 'anything' })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_truthy', value: '' })).toBe(false);
    expect(await eng.evaluate({ operator: 'is_truthy', value: '   ' })).toBe(false); // trimmed => empty
    expect(await eng.evaluate({ operator: 'is_truthy', value: 0 })).toBe(false);
    expect(await eng.evaluate({ operator: 'is_truthy', value: true })).toBe(true);

    expect(await eng.evaluate({ operator: 'is_falsy', value: '' })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_falsy', value: 0 })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_falsy', value: 'x' })).toBe(false);

    // the deliberate difference from is_true/is_false: the STRING "false" is a
    // non-empty string, therefore truthy, while is_true rejects it.
    expect(await eng.evaluate({ operator: 'is_truthy', value: 'false' })).toBe(true);
    expect(await eng.evaluate({ operator: 'is_true', value: 'false' })).toBe(false);
  });

  it('the new operators resolve {{variables}} like every other operator', async () => {
    const withVars = makeEngine({ label: 'Sign Out' });
    expect(await withVars.evaluate({
      operator: 'equals_i', value: '{{label}}', expected: 'sign out',
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mission 5 Part 2: the two value types that needed measuring before building.
// Every expectation below encodes a finding from
// tools/probe-condition-value-types.js. If one of them ever fails, re-run the
// probe rather than editing the number: the probe is the source of truth.
// ---------------------------------------------------------------------------
describe('ConditionEngine — in_screen / not_in_screen', () => {
  // The real check is an IntersectionObserver evaluated IN THE PAGE. Here the
  // locator just reports what that observer would have resolved to, so the
  // engine's own branching is what is under test.
  function pageWithInScreen(parts: { count?: number; inScreen?: unknown }) {
    const locator = {
      first() { return this; },
      count: vi.fn(async () => parts.count ?? 1),
      isVisible: vi.fn(async () => true),
      innerText: vi.fn(async () => ''),
      inputValue: vi.fn(async () => ''),
      evaluate: vi.fn(async () => parts.inScreen),
    };
    return { page: { locator: vi.fn(() => locator) } as unknown as Partial<Page>, locator };
  }

  it('in_screen is true only when the element is present AND intersecting', async () => {
    const onScreen = pageWithInScreen({ count: 1, inScreen: true });
    expect(await makeEngine({}, onScreen.page)
      .evaluate({ operator: 'in_screen', selector: '#a' })).toBe(true);

    const offScreen = pageWithInScreen({ count: 1, inScreen: false });
    expect(await makeEngine({}, offScreen.page)
      .evaluate({ operator: 'in_screen', selector: '#a' })).toBe(false);
  });

  it('in_screen is false for a missing element and never touches the page', async () => {
    const absent = pageWithInScreen({ count: 0, inScreen: true });
    expect(await makeEngine({}, absent.page)
      .evaluate({ operator: 'in_screen', selector: '#gone' })).toBe(false);
    // count === 0 short-circuits: evaluating an observer on nothing is pointless
    // and would only spend the timeout budget.
    expect(absent.locator.evaluate).not.toHaveBeenCalled();
  });

  it('not_in_screen is the true complement: missing OR not intersecting', async () => {
    const absent = pageWithInScreen({ count: 0 });
    expect(await makeEngine({}, absent.page)
      .evaluate({ operator: 'not_in_screen', selector: '#gone' })).toBe(true);

    const offScreen = pageWithInScreen({ count: 1, inScreen: false });
    expect(await makeEngine({}, offScreen.page)
      .evaluate({ operator: 'not_in_screen', selector: '#a' })).toBe(true);

    const onScreen = pageWithInScreen({ count: 1, inScreen: true });
    expect(await makeEngine({}, onScreen.page)
      .evaluate({ operator: 'not_in_screen', selector: '#a' })).toBe(false);
  });

  it('passes a real FUNCTION to locator.evaluate, not a source string', async () => {
    // MEASURED (probe finding 4): locator.evaluate('<function source>') treats
    // the string as an expression, so it yields the function object and returns
    // undefined instead of calling it — a silent false for every element.
    const onScreen = pageWithInScreen({ count: 1, inScreen: true });
    await makeEngine({}, onScreen.page).evaluate({ operator: 'in_screen', selector: '#a' });
    const [fn] = onScreen.locator.evaluate.mock.calls[0] as unknown[];
    expect(typeof fn).toBe('function');
  });

  it('a non-boolean or thrown result reads as "not on screen", never as true', async () => {
    // undefined is exactly what the broken string form returns, so it must not
    // be allowed to pass as truthy anywhere.
    const undef = pageWithInScreen({ count: 1, inScreen: undefined });
    expect(await makeEngine({}, undef.page)
      .evaluate({ operator: 'in_screen', selector: '#a' })).toBe(false);

    const throwing = {
      first() { return this; },
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      evaluate: vi.fn(async () => { throw new Error('detached'); }),
    };
    const page = { locator: vi.fn(() => throwing) } as unknown as Partial<Page>;
    expect(await makeEngine({}, page).evaluate({ operator: 'in_screen', selector: '#a' })).toBe(false);
    expect(await makeEngine({}, page).evaluate({ operator: 'not_in_screen', selector: '#a' })).toBe(true);
  });

  it('in_screen without a selector is false, like every other DOM operator', async () => {
    const eng = makeEngine({}, pageWithInScreen({}).page);
    expect(await eng.evaluate({ operator: 'in_screen' })).toBe(false);
  });
});

describe("ConditionEngine — source 'code'", () => {
  function pageWithEval(impl: (script: string) => unknown) {
    const evaluate = vi.fn(async (script: unknown) => impl(String(script)));
    return { page: { evaluate } as unknown as Partial<Page>, evaluate };
  }

  it('wraps a RETURN statement so Playwright never sees an illegal return', async () => {
    // MEASURED (probe finding 1): page.evaluate('return true;') throws
    // "Illegal return statement" — and `return true;` is exactly what Automa
    // seeds its code editor with, so an unwrapped snippet is the common case.
    const { page, evaluate } = pageWithEval(() => true);
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'is_truthy', source: 'code', value: 'return true;',
    })).toBe(true);
    const script = String(evaluate.mock.calls[0][0]);
    expect(script).toContain('return true;');
    expect(script.startsWith('return')).toBe(false);
    // a statement body, NOT `return ( ... )` — that form throws on a statement
    expect(script).not.toContain('return (\nreturn true;');
  });

  it('wraps an EXPRESSION snippet in a return so it is not silently undefined', async () => {
    // MEASURED (probe finding 2): the statement wrapper yields undefined for an
    // expression-only snippet — a silently false condition, not an error.
    const { page, evaluate } = pageWithEval(() => 'Example');
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({
      operator: 'equals', source: 'code', value: 'document.title', expected: 'Example',
    })).toBe(true);
    expect(String(evaluate.mock.calls[0][0])).toContain('return (');
  });

  it('is a SOURCE, so any operator can compare what the snippet returned', async () => {
    const { page } = pageWithEval(() => 42);
    const eng = makeEngine({}, page);
    // this is the whole reason code is a source and not a boolean operator
    expect(await eng.evaluate({
      operator: 'greater_than', source: 'code', value: 'return 42;', expected: '10',
    })).toBe(true);
    expect(await eng.evaluate({
      operator: 'equals', source: 'code', value: 'return 42;', expected: '42',
    })).toBe(true);
  });

  it('resolves {{variables}} inside the snippet before it is wrapped', async () => {
    const { page, evaluate } = pageWithEval((s) => s);
    const eng = makeEngine({ target: 'checkout' }, page);
    await eng.evaluate({ operator: 'is_truthy', source: 'code', value: 'return "{{target}}";' });
    expect(String(evaluate.mock.calls[0][0])).toContain('checkout');
  });

  it('an empty editor is not an error: it reads as an empty value', async () => {
    const { page, evaluate } = pageWithEval(() => 'never');
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({ operator: 'is_empty', source: 'code', value: '   ' })).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a snippet that throws in the page reads as empty, it does not crash the run', async () => {
    const { page } = pageWithEval(() => { throw new Error('ReferenceError: x'); });
    const eng = makeEngine({}, page);
    expect(await eng.evaluate({ operator: 'is_truthy', source: 'code', value: 'return x;' })).toBe(false);
    expect(await eng.evaluate({ operator: 'is_empty', source: 'code', value: 'return x;' })).toBe(true);
  });

  it('an over-long snippet is refused before it reaches the page', async () => {
    const { page, evaluate } = pageWithEval(() => true);
    const eng = makeEngine({}, page);
    const huge = `return "${'x'.repeat(config.CONDITION_CODE_MAX_LENGTH + 10)}";`;
    expect(await eng.evaluate({ operator: 'is_truthy', source: 'code', value: huge })).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a snippet that never settles loses the race instead of hanging the run', async () => {
    // MEASURED (probe finding 7): `while (true) {}` wedges the page
    // PERMANENTLY — a later evaluate('1+1') never returns either. The race is
    // the only escape, and a timeout must report an unmet condition rather than
    // retry on a page that is already lost.
    const page = { evaluate: vi.fn(() => new Promise(() => {})) } as unknown as Partial<Page>;
    const eng = makeEngine({}, page);
    const original = config.CONDITION_CODE_TIMEOUT_MS;
    (config as { CONDITION_CODE_TIMEOUT_MS: number }).CONDITION_CODE_TIMEOUT_MS = 30;
    try {
      expect(await eng.evaluate({
        operator: 'is_truthy', source: 'code', value: 'while (true) {}',
      })).toBe(false);
    } finally {
      (config as { CONDITION_CODE_TIMEOUT_MS: number }).CONDITION_CODE_TIMEOUT_MS = original;
    }
  });
});
