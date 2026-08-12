import type { Locator, Page } from 'playwright';
import { config } from '../config';

// Try to load safe-regex2, fallback to always true
let isSafeRegex: (pattern: string) => boolean;
try {
  isSafeRegex = require('safe-regex2');
} catch {
  isSafeRegex = () => true;
}

// === TYPES ===

export type ConditionOperator =
  | 'exists' | 'not_exists' | 'visible' | 'hidden'
  // Automa's "Element visible in screen" / "hidden in screen" value types.
  // NOT a synonym for visible/hidden, and this is MEASURED rather than assumed
  // (tools/probe-condition-value-types.js): an element 4000px below the fold
  // reports isVisible() === true, because Playwright's "visible" means "has a
  // non-empty box and is not visibility:hidden" and says nothing about where
  // the page is scrolled to. in_screen answers "can the user see it right now".
  | 'in_screen' | 'not_in_screen'
  | 'equals' | 'equals_i' | 'not_equals'
  | 'contains' | 'contains_i' | 'not_contains' | 'not_contains_i'
  | 'starts_with' | 'ends_with' | 'matches_regex'
  | 'greater_than' | 'less_than' | 'greater_equal' | 'less_equal'
  | 'is_empty' | 'not_empty'
  | 'is_true' | 'is_false' | 'is_truthy' | 'is_falsy'
  | 'in_list' | 'not_in_list'
  | 'random';

// Which part of the matched element provides the LEFT-hand value.
// Mirrors the "Left source" dropdown in the Condition Builder NDV
// (docs/uiux/ndv-condition-final.md) and NdvModel.CONDITION_SOURCES.
//   text      -> innerText            (default; also the legacy behaviour)
//   attribute -> getAttribute(attribute)
//   value     -> inputValue()         (form controls)
//   html      -> innerHTML
//   variable  -> the context variable named by `value`
//   code      -> the JS snippet in `value`, executed IN THE PAGE (Automa's
//                "Code" value type). The snippet's RETURN VALUE becomes the
//                left-hand value, so `is_truthy` reproduces Automa's boolean
//                use while every other operator can still compare what came
//                back. Deliberately a *source* and not an operator: that is
//                what makes `code ... equals "42"` expressible.
export type ConditionSource =
  | 'text' | 'attribute' | 'value' | 'html' | 'variable' | 'code';

export interface SimpleCondition {
  operator: ConditionOperator;
  value?: any;
  expected?: any;
  selector?: string;
  /** Left-hand value source. Omitted === 'text' (engine default). */
  source?: ConditionSource;
  /** Attribute name to read when `source === 'attribute'`. */
  attribute?: string;
  /**
   * Where a `source: 'code'` snippet runs. Automa offers Background / Active
   * tab here; only 'page' exists in this product, because there is no
   * background service worker to be the other one, and a dropdown whose second
   * entry silently behaves like the first is precisely the lying control rule
   * R3 forbids. Declared (not invented) so an imported Automa workflow that
   * carries the field round-trips instead of losing it.
   */
  codeContext?: 'page';
}

export interface CompositeCondition {
  all?: (SimpleCondition | CompositeCondition)[];
  any?: (SimpleCondition | CompositeCondition)[];
  not?: SimpleCondition | CompositeCondition;
}

export type Condition = SimpleCondition | CompositeCondition;

// === CONDITION ENGINE ===

const SOURCES: ConditionSource[] = [
  'text', 'attribute', 'value', 'html', 'variable', 'code',
];

// Operators judged against the element ITSELF: no left-hand value is read and
// no `expected` is compared. One named constant because evaluateSimple()
// branches on it and a second, drifting copy is how an operator ends up
// silently evaluated by the wrong path.
const DOM_OPERATORS: ConditionOperator[] = [
  'exists', 'not_exists', 'visible', 'hidden', 'in_screen', 'not_in_screen',
];

/**
 * Is `el` inside the viewport right now? Runs IN THE PAGE, so it may only use
 * browser globals.
 *
 * MEASURED, NOT ASSUMED (tools/probe-condition-value-types.js). The obvious
 * implementation -- and the one MISSIONS.md proposed -- is boundingBox()
 * intersected with the viewport rect, and it is WRONG: an element scrolled out
 * of sight inside an `overflow:hidden` container still reports a box that lands
 * inside the viewport, so the rect test answered TRUE for something no user can
 * see. IntersectionObserver is what the browser itself uses for this question
 * and it accounts for ancestor clipping, which one rect cannot.
 *
 * The timer is not decoration: an element inside a `display:none` subtree may
 * produce no entry at all, and without a backstop this promise would never
 * settle and would hang the whole run. Resolving `false` is the honest answer
 * for an element the browser will not even lay out.
 */
function isInScreen(el: Element, budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let io: IntersectionObserver | null = null;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { if (io) io.disconnect(); } catch { /* observer already gone */ }
      resolve(v);
    };
    try {
      io = new IntersectionObserver((entries) => {
        finish(entries.length > 0 && entries[entries.length - 1].isIntersecting === true);
      });
      io.observe(el);
    } catch {
      // No IntersectionObserver (or a detached node): not on screen.
      finish(false);
    }
    setTimeout(() => finish(false), budgetMs);
  });
}

// A unique sentinel for "the code did not finish in time". A Symbol cannot
// collide with any value a snippet might legitimately return -- `null`, `false`
// and `undefined` are all things user code returns on purpose, so using one of
// those as the timeout marker would make a timeout indistinguishable from a
// real answer.
const CODE_TIMED_OUT: unique symbol = Symbol('condition.code.timeout');

/**
 * Does this snippet need a STATEMENT wrapper rather than an EXPRESSION one?
 *
 * MEASURED (tools/probe-condition-value-types.js findings 1-2): neither wrapper
 * works for both shapes, and each fails in a different, nasty way.
 *
 *   `return true;`            statement wrapper -> true   expression -> SyntaxError
 *   `document.title === ""`   statement wrapper -> undefined (SILENT false!)
 *                             expression wrapper -> the real boolean
 *
 * The undefined case is the dangerous one: no error is raised anywhere, the
 * condition simply comes out false and the workflow takes the other branch.
 *
 * `return` is checked at the START of a line (after optional whitespace) rather
 * than anywhere in the text, so an expression that merely CONTAINS the word --
 * `x.returnValue`, or a string literal 'return' -- is not misclassified. A
 * snippet with a `;` or a newline is likewise statement-shaped: an expression
 * cannot contain a top-level semicolon, and wrapping a multi-line expression
 * body in parentheses is harmless anyway.
 */
function looksLikeStatement(code: string): boolean {
  if (/^\s*return(\s|;|$)/m.test(code)) return true;
  // A trailing semicolon alone does not make it a statement (`1 + 1;` is fine
  // as an expression once the trailing `;` is inside the parens), but an
  // INTERNAL one means there is more than one statement here.
  if (/;\s*\S/.test(code)) return true;
  return /\b(?:const|let|var|if|for|while|function|throw|switch|try)\b/.test(code);
}

export class ConditionEngine {
  private page: Page;
  private variables: Map<string, any>;

  constructor(page: Page, variables: Map<string, any>) {
    this.page = page;
    this.variables = variables;
  }

  async evaluate(condition: Condition): Promise<boolean> {
    // Composite: ALL (AND)
    if ('all' in condition && Array.isArray(condition.all)) {
      for (const c of condition.all) {
        if (!(await this.evaluate(c))) {
          return false;
        }
      }
      return true;
    }

    // Composite: ANY (OR)
    if ('any' in condition && Array.isArray(condition.any)) {
      for (const c of condition.any) {
        if (await this.evaluate(c)) {
          return true;
        }
      }
      return false;
    }

    // Composite: NOT
    if ('not' in condition && condition.not) {
      return !(await this.evaluate(condition.not));
    }

    // Simple condition
    if ('operator' in condition) {
      return this.evaluateSimple(condition as SimpleCondition);
    }

    return false;
  }

  private async evaluateSimple(cond: SimpleCondition): Promise<boolean> {
    const { operator, value, expected, selector, attribute } = cond;
    const source: ConditionSource = SOURCES.includes(cond.source as ConditionSource)
      ? (cond.source as ConditionSource)
      : 'text';

    // Resolve variables
    const resolvedValue = this.resolveVariables(value);
    const resolvedExpected = this.resolveVariables(expected);

    // DOM-based conditions
    if (DOM_OPERATORS.includes(operator)) {
      if (!selector) return false;

      try {
        const locator = this.page.locator(selector).first();
        const count = await locator.count();

        switch (operator) {
          case 'exists':
            return count > 0;
          case 'not_exists':
            return count === 0;
          case 'visible':
            return count > 0 && await locator.isVisible();
          case 'hidden':
            return count === 0 || !(await locator.isVisible());
          // A missing element is not on screen, so in_screen is false and its
          // negative twin is true -- decided BEFORE evaluating, because
          // locator.evaluate() on zero matches would throw.
          case 'in_screen':
            return count > 0 && await this.readInScreen(locator);
          case 'not_in_screen':
            return count === 0 || !(await this.readInScreen(locator));
          default:
            return false;
        }
      } catch {
        // A selector that cannot even be parsed means the element is not there;
        // only the operators that ASSERT absence may pass on that basis.
        return operator === 'not_exists' || operator === 'hidden'
          || operator === 'not_in_screen';
      }
    }

    // Get actual value (from selector or direct)
    let actualValue = resolvedValue;

    // `source: 'variable'` reads straight from the run context and never touches
    // the DOM, so it also works in non-browser steps.
    if (source === 'variable') {
      actualValue = this.readVariable(value);
    } else if (source === 'code') {
      // The snippet's own return value IS the left-hand value, so it needs no
      // selector -- `code` describes where the value comes from, not which
      // element it is read off.
      actualValue = await this.readFromCode(value);
    } else if (selector) {
      actualValue = await this.readFromElement(selector, source, attribute);
    }

    // Convert to strings for comparison
    const strActual = String(actualValue ?? '').trim();
    const strExpected = String(resolvedExpected ?? '').trim();

    // Convert to numbers for numeric comparisons
    const numActual = parseFloat(strActual.replace(/[^0-9.-]/g, '')) || 0;
    const numExpected = parseFloat(strExpected.replace(/[^0-9.-]/g, '')) || 0;

    switch (operator) {
      // String comparisons
      case 'equals':
        return strActual === strExpected;
      // Automa `eqi`: the same comparison with case folded away. Kept next to
      // its sensitive twin so the two can never drift apart.
      case 'equals_i':
        return strActual.toLowerCase() === strExpected.toLowerCase();
      case 'not_equals':
        return strActual !== strExpected;
      case 'contains':
        return strActual.includes(strExpected);
      case 'contains_i':
        return strActual.toLowerCase().includes(strExpected.toLowerCase());
      case 'not_contains':
        return !strActual.includes(strExpected);
      case 'not_contains_i':
        return !strActual.toLowerCase().includes(strExpected.toLowerCase());
      case 'starts_with':
        return strActual.startsWith(strExpected);
      case 'ends_with':
        return strActual.endsWith(strExpected);

      // Empty checks
      case 'is_empty':
        return strActual.length === 0;
      case 'not_empty':
        return strActual.length > 0;

      // Numeric comparisons
      case 'greater_than':
        return numActual > numExpected;
      case 'less_than':
        return numActual < numExpected;
      case 'greater_equal':
        return numActual >= numExpected;
      case 'less_equal':
        return numActual <= numExpected;

      // Boolean checks
      case 'is_true':
        return actualValue === true || strActual.toLowerCase() === 'true';
      case 'is_false':
        return actualValue === false || strActual.toLowerCase() === 'false';

      // Automa `itr` / `ifl`: JS TRUTHINESS, deliberately different from
      // is_true/is_false above. is_true only accepts the boolean true or the
      // literal string "true"; is_truthy answers "did I get a value at all",
      // which is the check you want after reading text out of the page.
      // Note the raw value is tested, not the trimmed string, so `0` and the
      // empty string are falsy while "false" is truthy — exactly JS rules.
      case 'is_truthy':
        return Boolean(typeof actualValue === 'string' ? strActual : actualValue);
      case 'is_falsy':
        return !Boolean(typeof actualValue === 'string' ? strActual : actualValue);

      // List checks
      case 'in_list':
        return Array.isArray(resolvedExpected) && resolvedExpected.includes(actualValue);
      case 'not_in_list':
        return Array.isArray(resolvedExpected) && !resolvedExpected.includes(actualValue);

      // Random (for A/B testing)
      case 'random':
        return Math.random() * 100 < numExpected;

      // Regex
      case 'matches_regex':
        return this.safeRegexTest(strExpected, strActual);

      default:
        return false;
    }
  }

  // ---- in-screen -----------------------------------------------------------
  //
  // `isInScreen` is passed as a REAL FUNCTION, never as a source string.
  // MEASURED (tools/probe-condition-value-types.js finding 4):
  // locator.evaluate('<function source>') evaluates the string as an
  // EXPRESSION, so it produces the function object and returns undefined
  // instead of calling it -- a silent `false` for every element.
  //
  // A failed read is `false` rather than a thrown error: a condition exists to
  // pick a branch, and "I could not look" is not on screen.
  private async readInScreen(locator: Locator): Promise<boolean> {
    try {
      const budget = config.CONDITION_IN_SCREEN_TIMEOUT_MS;
      return await locator.evaluate(isInScreen, budget) === true;
    } catch {
      return false;
    }
  }

  // ---- code ----------------------------------------------------------------
  //
  // Runs the user's snippet in the page and returns whatever it produced, so
  // any operator can then compare it (`code ... equals "42"`), not only
  // is_truthy. Three measured facts shape this (see the probe):
  //
  //  1. `page.evaluate("return true;")` throws "Illegal return statement" --
  //     and `return true;` is exactly what Automa seeds its editor with, so a
  //     snippet MUST be wrapped before Playwright ever sees it.
  //  2. No single wrapper works. A statement body silently yields `undefined`
  //     for an expression-only snippet (`document.title === ""`), and an
  //     expression body throws on a statement one. Hence looksLikeStatement().
  //  3. A runaway snippet (`while (true) {}`) wedges the page PERMANENTLY: a
  //     later evaluate('1+1') never returns either. So this is RACED, and a
  //     timeout reports a failed condition rather than retrying -- a retry
  //     would simply hang again on a page that is already lost.
  private async readFromCode(raw: any): Promise<any> {
    const code = typeof raw === 'string' ? raw.trim() : '';
    // An empty editor is not an error, it is just no value yet. '' keeps
    // is_empty true and equals false, exactly like every other source.
    if (code === '') return '';
    if (code.length > config.CONDITION_CODE_MAX_LENGTH) {
      console.warn(`[SECURITY] Condition code too long: ${code.length} chars `
        + `(max: ${config.CONDITION_CODE_MAX_LENGTH})`);
      return '';
    }

    // {{variables}} are resolved BEFORE wrapping, so a workflow value can be
    // injected the same way it can in every other field.
    const resolved = String(this.resolveVariables(code));
    const wrapped = looksLikeStatement(resolved)
      ? `(async () => {\n${resolved}\n})()`
      : `(async () => { return (\n${resolved}\n); })()`;

    const timeout = config.CONDITION_CODE_TIMEOUT_MS;
    const TIMED_OUT = CODE_TIMED_OUT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.page.evaluate(wrapped),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeout);
        }),
      ]);
      if (result === TIMED_OUT) {
        console.warn(`[CONDITION] Code did not finish within ${timeout}ms; `
          + 'treating the condition as unmet.');
        return '';
      }
      return result;
    } catch (e: any) {
      // A snippet that threw has produced no value. '' rather than a rethrow,
      // so one broken condition cannot abort the whole workflow, and the
      // reason is logged instead of swallowed.
      console.warn(`[CONDITION] Code threw: ${e && e.message ? e.message : e}`);
      return '';
    } finally {
      // Without this the pending timer keeps the event loop (and the worker)
      // alive for the full budget after a fast snippet already answered.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Read the left-hand value out of the first element matching `selector`,
  // honouring the "Left source" contract. A missing element / failed read
  // yields '' so the comparison operators behave predictably (is_empty passes,
  // equals fails) instead of throwing mid-workflow.
  private async readFromElement(
    selector: string,
    source: ConditionSource,
    attribute?: string
  ): Promise<any> {
    try {
      const locator = this.page.locator(selector).first();
      if (await locator.count() === 0) return '';

      switch (source) {
        case 'attribute': {
          const name = String(this.resolveVariables(attribute) ?? '').trim();
          // No attribute name configured yet: fall back to text rather than
          // silently comparing against ''.
          if (!name) return await locator.innerText().catch(() => '');
          const attr = await locator.getAttribute(name).catch(() => null);
          return attr === null ? '' : attr;
        }
        case 'value':
          return await locator.inputValue().catch(() => '');
        case 'html':
          return await locator.innerHTML().catch(() => '');
        case 'text':
        default: {
          // Legacy-compatible: prefer innerText, fall back to the form value so
          // conditions written before the "Left source" control keep working.
          const text = await locator.innerText().catch(() => null);
          if (text !== null && text !== '') return text;
          return await locator.inputValue().catch(() => '');
        }
      }
    } catch {
      return '';
    }
  }

  // For `source: 'variable'` the row's own `value` field NAMES the variable.
  // Both the bare `status` and the templated `{{status}}` / `count={{n}}` forms
  // are accepted. An unknown bare name resolves to '' — the same way an unknown
  // `{{token}}` does — so a typo reads as "empty" instead of silently comparing
  // against the literal variable name.
  private readVariable(raw: any): any {
    if (typeof raw !== 'string') return raw;
    const name = raw.trim();
    if (name === '') return '';
    if (/\{\{.+?\}\}/.test(name)) return this.resolveVariables(name);
    return this.variables.has(name) ? this.variables.get(name) : '';
  }

  private safeRegexTest(pattern: string, input: string): boolean {
    try {
      // Length check
      if (pattern.length > config.MAX_REGEX_LENGTH) {
        console.warn(`[SECURITY] Regex too long: ${pattern.length} chars (max: ${config.MAX_REGEX_LENGTH})`);
        return false;
      }

      // Safety check (ReDoS prevention)
      if (!isSafeRegex(pattern)) {
        console.warn(`[SECURITY] Potentially unsafe regex blocked: ${pattern}`);
        return false;
      }

      const regex = new RegExp(pattern, 'i');

      // Limit input length for regex testing
      const testInput = input.length > 10000 ? input.substring(0, 10000) : input;

      return regex.test(testInput);
    } catch (e) {
      console.warn(`[REGEX] Invalid pattern: ${pattern}`);
      return false;
    }
  }

  public resolveVariables(text: any): any {
    if (typeof text !== 'string') {
      return text;
    }

    return text.replace(/\{\{(.+?)\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      const val = this.variables.get(trimmedKey);
      return val !== undefined ? String(val) : '';
    });
  }
}