/**
 * every-picker-offers-the-chooser.test.ts
 *
 * THE RULE THIS FILE PINS
 * ───────────────────────
 * Stated by the operator as a standing rule, not a bug report:
 *
 *   «وقتی که من روی هر نوع نودی می‌خواد باشه، هر فیلدی می‌خواد باشه … وقتی
 *    اونو می‌زنم، باید باکسی بالا بیاد که من بتونم انتخاب کنم که این ریموت
 *    براوزر باشه یا لوکال براوزر باشه. مهم نیست که من اولش لوکال انتخاب کردم
 *    یا ریموت … هر موقع که من اونو زدم، باید اون باکس بالا بیاد»
 *
 *   «وقتی آیکون پیکر رو زدیم و لوکال براوزر رو انتخاب کردیم … باید حتماً یه
 *    دونه alert روی براوزر بالا بیاد … alert مشخصات همون فیلدیه که ما همین
 *    الان انتخابش کردیم … ولی اگر مرورگر از قبل بالا بوده باشه، دیگه مستقیماً
 *    یه alert میاد»
 *
 * So: EVERY crosshair, on EVERY node, for EVERY field, EVERY time — the chooser
 * appears, and choosing LOCAL raises an Alert naming THAT field.
 *
 * WHAT WAS ACTUALLY WRONG (measured, not inferred)
 * ────────────────────────────────────────────────
 * `pickerBtn` gates its whole chooser block on `opts.nodeId && opts.fieldKey`.
 * The condition-ROW picker deliberately passed neither, so pressing it skipped
 * the chooser AND skipped the chooser-unavailable guard, and fell straight
 * through to `BrowserView.requestPick()`, whose tail opens the server browser
 * directly. A probe on a clean server measured exactly that:
 *
 *   picker                     chooser              browser      consents
 *   top-level field            ["local","remote"]   —            raised
 *   condition row              none                 LOCAL,silent 0
 *
 * One cause, both reports: no chooser box, and — since NOTHING was registered —
 * no Alert could exist, which is why the extension still pointed at the
 * PREVIOUS node («احتمالاً نود قبلی رو هنوز set داشت»).
 *
 * WHY THE OMISSION WAS THERE, AND WHY THE FIX HAS TWO HALVES
 * ──────────────────────────────────────────────────────────
 * It was avoiding a real hazard. A condition row's selector lives in the node's
 * nested `params.groups`, but `if` and `while` ALSO declare a *top-level*
 * `selector` param (measured against ActionCatalog.declaredFields). Naively
 * supplying `fieldKey:'selector'` would let the delivered value land on the
 * wrong one. So the fix is:
 *
 *   half 1 — the row picker supplies full field identity, so the chooser opens;
 *   half 2 — it also supplies `rowPath` (`<pathId>/<groupIndex>/<rowIndex>`),
 *            which TargetingFlow records at pick-start via
 *            `FlowEditor.setPickRoute`, and which `applyInspectorFields`
 *            consumes to write into the ROW instead of the top-level param.
 *
 * Both halves are asserted below, because either one alone is a defect: half 1
 * without half 2 corrupts the wrong field; half 2 without half 1 is dead code.
 *
 * WHY STATIC ASSERTIONS
 * ─────────────────────
 * The live proof is primary and has been taken: on a clean server the chooser
 * appeared for the condition row, a consent was raised for it (n1/selector),
 * and the chooser appeared AGAIN after LOCAL had already been chosen, with no
 * browser opened silently. These tests exist so the two halves cannot be
 * quietly reverted — and both are WIRING facts (which properties cross a call
 * boundary), the same class of thing `restart-tab-loss.test.ts` pins this way.
 * The unit tier runs in `node` with no DOM, so the click path itself is not
 * executable here; the behavioural half lives in targeting-flow.test.ts, which
 * has a harness that really executes the module.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ndvNodes = read('public/js/ndv-nodes.js');
const flowEditor = read('public/js/flow-editor.js');
const targetingFlow = read('public/js/targeting-flow.js');

/**
 * Extract one function body by brace depth, so an assertion cannot be satisfied
 * by a coincidental match somewhere else in a 4000-line file.
 */
function fn(src: string, name: string): string {
  const at = src.indexOf('function ' + name + '(');
  expect(at, `function ${name}() must exist`).toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces while reading ${name}()`);
}

describe('the condition-row crosshair reaches the chooser like every other one', () => {
  it('supplies the node identity and field key the chooser gate requires', () => {
    const body = fn(ndvNodes, 'conditionRow');
    expect(
      /nodeId:\s*o\.nodeId/.test(body),
      'the condition row picker must pass nodeId: pickerBtn opens the chooser only '
        + 'when `opts.nodeId && opts.fieldKey` are both present, and without it the '
        + 'click silently falls through to requestPick() and opens a browser with no '
        + 'choice offered',
    ).toBe(true);
    expect(
      /fieldKey:\s*'selector'/.test(body),
      "the condition row picker must pass fieldKey:'selector' — `selector` is declared "
        + 'by both `if` and `while`, so the server accepts the registration and a '
        + 'consent (the Alert) can be raised for it',
    ).toBe(true);
  });

  it('carries the row address so the value cannot land on the top-level param', () => {
    const body = fn(ndvNodes, 'conditionRow');
    expect(
      /rowPath:\s*o\.rowPath/.test(body),
      'fieldKey alone is ambiguous for condition nodes — `if`/`while` declare a '
        + 'top-level `selector` AND hold row selectors in params.groups — so rowPath '
        + 'must travel with the pick to disambiguate the destination',
    ).toBe(true);
  });

  it('builds that address from the path, group and row actually pressed', () => {
    const body = fn(ndvNodes, 'renderCondition');
    expect(
      /rowPath:/.test(body) && /\+\s*'\/'\s*\+\s*gi\s*\+\s*'\/'\s*\+\s*ri/.test(body),
      'renderCondition must compose rowPath as <pathId>/<groupIndex>/<rowIndex>: '
        + 'that is the exact shape applyToConditionRow walks',
    ).toBe(true);
    expect(
      /nodeId:\s*node\.id/.test(body),
      'renderCondition must pass the node identity down to the row, or conditionRow '
        + 'has nothing to forward',
    ).toBe(true);
  });

  it('pickerBtn forwards the row address, and still gates on identity', () => {
    const body = fn(ndvNodes, 'pickerBtn');
    expect(
      /rowPath:\s*opts\.rowPath/.test(body),
      'pickerBtn must forward rowPath into the targeting context, otherwise the '
        + 'address is discarded at the boundary and delivery misroutes',
    ).toBe(true);
    // The gate is deliberately left in place: it is what produces the
    // chooser-unavailable toast for a field that genuinely has no identity,
    // rather than opening a browser behind the operator's back.
    expect(
      /opts\.nodeId\s*&&\s*opts\.fieldKey/.test(body),
      'the identity gate must remain: it is the branch that either offers the '
        + 'chooser or reports that it cannot, and removing it restores the silent '
        + 'fall-through that caused this defect',
    ).toBe(true);
  });
});

describe('a delivery is routed to the row that was picked from', () => {
  it('TargetingFlow records the route at the moment the pick starts', () => {
    // READS `showPickerAlert`, WHICH IS WHERE THIS NOW LIVES.
    //
    // The body this used to read was `start()`. It was split so that Picker and
    // Retry could share one alert renderer — the requirement being «هدف این است
    // که showPickerAlert() برای هر دو یکی باشد» — and `start()` became a thin
    // wrapper that records the retry target and delegates.
    //
    // The route recording deliberately stayed on the SHARED side, so a Retry
    // re-records the row address instead of losing it. Pointing this assertion
    // at the wrapper would report a defect that does not exist; pointing it at
    // the shared function keeps it guarding the real behaviour for BOTH paths.
    const body = fn(targetingFlow, 'showPickerAlert');
    expect(
      /setPickRoute\(\s*c\.nodeId\s*,\s*c\.fieldKey\s*,\s*c\.rowPath\s*\|\|\s*''\s*\)/.test(body),
      'pick-start is the only moment anyone knows WHICH crosshair was pressed — the '
        + 'delivery arrives later, asynchronously, carrying only node+field — so the '
        + 'row address has to be recorded here',
    ).toBe(true);
  });

  it('records even an empty route, so an ordinary field clears a stale one', () => {
    const body = fn(flowEditor, 'setPickRoute');
    expect(
      /String\(\s*rowPath\s*\|\|\s*''\s*\)/.test(body),
      "setPickRoute must store '' rather than skipping: if a row pick were followed "
        + 'by a top-level pick on the same field, an un-cleared route would divert the '
        + "second delivery into the first pick's row",
    ).toBe(true);
  });

  it('applyInspectorFields consults the route before anything else', () => {
    const body = fn(flowEditor, 'applyInspectorFields');
    expect(body.includes('pickRoutes['), 'the route must be looked up').toBe(true);
    expect(
      body.includes('applyToConditionRow('),
      'a routed delivery must be handed to the row writer',
    ).toBe(true);
    expect(
      body.includes('delete pickRoutes['),
      'the route must be consumed on use, or a later unrelated delivery to the same '
        + 'node+field would be misrouted by the stale address',
    ).toBe(true);
  });

  it('refuses rather than straying when the addressed row is gone', () => {
    const apply = fn(flowEditor, 'applyInspectorFields');
    const rk = apply.indexOf('pickRoutes[');
    const tail = apply.slice(rk);
    expect(
      /return false;/.test(tail),
      'when the row cannot be found the delivery must fail — rows can be reordered, '
        + 'cloned or deleted while the operator is off in the browser picking, and '
        + 'writing to the top-level param the operator never pointed at is worse than '
        + 'reporting non-delivery',
    ).toBe(true);

    const row = fn(flowEditor, 'applyToConditionRow');
    expect(
      /parts\.length\s*!==\s*3/.test(row),
      'the address must be validated as three parts before being trusted',
    ).toBe(true);
    expect(
      /!groups\[gi\]\[ri\]/.test(row),
      'the addressed row must be proven to exist before it is written',
    ).toBe(true);
  });

  it('writes through the model, for `if` paths and `while` groups alike', () => {
    const row = fn(flowEditor, 'applyToConditionRow');
    expect(
      /writePaths\(/.test(row) && /writeGroups\(/.test(row),
      '`if` is multiCapable and stores rows under params.paths, while `while` uses '
        + 'params.groups — both shapes must be written through NdvModel rather than '
        + 'mutated ad hoc',
    ).toBe(true);
    expect(
      /pushHistory\(\)/.test(row),
      'a delivered pick is an operator edit and must be undoable like any other',
    ).toBe(true);
  });

  it('exposes setPickRoute on the public API TargetingFlow calls', () => {
    expect(
      /setPickRoute:\s*setPickRoute/.test(flowEditor),
      'TargetingFlow reaches this through window.FlowEditor, so an unexported '
        + 'function makes the whole routing half silently inert',
    ).toBe(true);
  });
});

/**
 * The SECOND way the rule could break, closed pre-emptively rather than after
 * another report. `inspector-client.js` collapses every failure of the options
 * read into `null` — non-200, network drop, unparseable body — and `start()`
 * used to answer that with a toast and no dialog. The operator would have
 * pressed a crosshair and got no box: the reported symptom exactly, from an
 * unrelated cause.
 */
describe('a failed options read still yields a chooser', () => {
  it('inspector-client really does hide failures as null (the premise)', () => {
    const body = fn(read('public/js/inspector-client.js'), 'targetingOptions');
    expect(
      /\.catch\(function\s*\(\)\s*\{\s*return null;\s*\}\)/.test(body),
      'this assertion documents WHY the fallback exists: if targetingOptions ever '
        + 'starts reporting failures distinguishably, the fallback should be '
        + 'reconsidered rather than left to mask a real error',
    ).toBe(true);
  });

  it('showPickerAlert() falls back instead of returning with nothing on screen', () => {
    // Renamed with the function it reads (see the note above). The fallback has
    // to live on the shared side, or a Retry against a failed options read would
    // show nothing — the very symptom this rule exists to forbid.
    const body = fn(targetingFlow, 'showPickerAlert');
    expect(
      /res\s*\|\|\s*fallbackOptions\(\)/.test(body),
      'a null options read must still open the box — the rule is «هر موقع که من '
        + 'اونو زدم، باید اون باکس بالا بیاد», with no exception for a failed read',
    ).toBe(true);
    expect(
      /renderChooser\(/.test(body),
      'the fallback is pointless unless the chooser is actually drawn from it',
    ).toBe(true);
  });

  it('the fallback offers both environments, and neither is disabled', () => {
    const body = fn(targetingFlow, 'fallbackOptions');
    expect(/id:\s*'local'/.test(body), 'LOCAL must be offered').toBe(true);
    expect(/id:\s*'remote'/.test(body), 'REMOTE must be offered').toBe(true);
    // Two greyed-out cards would satisfy the letter of the rule and defeat its
    // purpose: the operator could see a box but not use it.
    expect(
      (body.match(/available:\s*true/g) || []).length,
      'both cards must be pressable; the authoritative refusal belongs to '
        + '/inspector/targeting/begin, which choose() already surfaces by reason',
    ).toBe(2);
    expect(
      /degraded:\s*true/.test(body),
      'the fallback must mark itself, so the UI can admit the badges are unverified '
        + 'rather than inventing confidence it does not have',
    ).toBe(true);
  });

  it('the chooser says so when it was built from the fallback', () => {
    const body = fn(targetingFlow, 'renderChooser');
    expect(
      /res\.degraded/.test(body) && /tgt\.optionsDegraded/.test(body),
      'offering unverified options silently would make a stale "available" badge '
        + 'look like a fact the server had confirmed',
    ).toBe(true);
  });

  it('the notice is translated in both languages and is visible', () => {
    const i18n = read('public/js/i18n.js');
    expect(
      (i18n.match(/'tgt\.optionsDegraded'/g) || []).length,
      'fa and en both — an untranslated key renders as the key itself',
    ).toBe(2);
    const css = read('public/css/styles.css');
    expect(
      /\.tgt-note\s*\{/.test(css) && /\.tgt-note\.is-warn/.test(css),
      'an unstyled class is an invisible warning: .tgt-note is a new class, not one '
        + 'the dialog already had',
    ).toBe(true);
  });
});
