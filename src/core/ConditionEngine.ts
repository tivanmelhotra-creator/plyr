import type { Page } from 'playwright';
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
export type ConditionSource = 'text' | 'attribute' | 'value' | 'html' | 'variable';

export interface SimpleCondition {
  operator: ConditionOperator;
  value?: any;
  expected?: any;
  selector?: string;
  /** Left-hand value source. Omitted === 'text' (engine default). */
  source?: ConditionSource;
  /** Attribute name to read when `source === 'attribute'`. */
  attribute?: string;
}

export interface CompositeCondition {
  all?: (SimpleCondition | CompositeCondition)[];
  any?: (SimpleCondition | CompositeCondition)[];
  not?: SimpleCondition | CompositeCondition;
}

export type Condition = SimpleCondition | CompositeCondition;

// === CONDITION ENGINE ===

const SOURCES: ConditionSource[] = ['text', 'attribute', 'value', 'html', 'variable'];

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
    if (['exists', 'not_exists', 'visible', 'hidden'].includes(operator)) {
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
          default:
            return false;
        }
      } catch {
        return operator === 'not_exists' || operator === 'hidden';
      }
    }

    // Get actual value (from selector or direct)
    let actualValue = resolvedValue;

    // `source: 'variable'` reads straight from the run context and never touches
    // the DOM, so it also works in non-browser steps.
    if (source === 'variable') {
      actualValue = this.readVariable(value);
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