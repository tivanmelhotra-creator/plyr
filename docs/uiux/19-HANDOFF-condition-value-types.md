# Handoff 19 — Condition node: grouped value types (Automa parity, part 2)

**Status:** ✅ Implemented
**Mission:** `MISSIONS.md` § 5, part 2 — the last open mission
**Reference:** `AutomaApp/automa` → `conditionBuilder.valueTypes`

---

## 1. What shipped

Mission 5 had two halves. Part 1 (all 16 grouped **operators**) landed in an
earlier session. This is part 2: the grouped **value types** — Automa's second
dropdown, the one that decides *what is being compared* rather than *how*.

Automa's list, and where each entry actually landed here:

| Automa value type | Result in Aria |
|---|---|
| Value | already covered — the `content` kind |
| Element text | already covered — `source: 'text'` |
| Element attribute value | already covered — `source: 'attribute'` |
| Element exists / not exists | kept in the `dom` **operator** bucket (§3) |
| Element visible / hidden | kept in the `dom` **operator** bucket (§3) |
| **Code** | ✅ **new** — `source: 'code'`, a JS snippet evaluated in the page; its return value is the left-hand side |
| **Data exists** | ✅ covered, deliberately with **no new control** (§3) |
| **Element visible in screen** | ✅ **new** operator `in_screen` |
| **Element hidden in screen** | ✅ **new** operator `not_in_screen` |

Two genuinely new capabilities, then: a **code** value type and an
**in-viewport** test. Everything else was already reachable and only needed to
be *findable*, which is what the grouped dropdown is for.

---

## 2. Measure first — the probe, and the seven findings

`tools/probe-condition-value-types.js` (23 checks, real Chromium) was written
**before** any implementation and is committed rather than thrown away, because
**four of its seven findings fail silently** — they produce a wrong branch, not
an error. A condition that quietly answers `false` is the worst possible bug in
an automation tool: the workflow takes the wrong path and nothing is logged.

```bash
node tools/probe-condition-value-types.js   # → 23/23 checks, VERDICT=PASS
```

| # | Finding | Silent? | Consequence for the implementation |
|---|---|---|---|
| 1 | `page.evaluate('return true;')` **throws** *Illegal return statement* — and `return true;` is Automa's own editor seed | no | every snippet must be wrapped in a function body |
| 2 | No single wrapper works: a statement wrapper yields `undefined` for `1 + 1`, an expression wrapper throws on `const a = 1; return a;` | **yes** (the `undefined` half) | `looksLikeStatement()` picks the wrapper per snippet |
| 3 | A strict `script-src 'self'` CSP does **not** block `page.evaluate` — Playwright injects over the debugger protocol, not via a `<script>` tag | — | the code value type works on hardened sites; no bypass needed |
| 4 | `locator.evaluate('<function source>')` treats the string as an *expression*, so it evaluates to the function object and returns `undefined` instead of calling it | **yes** | the observer helper is passed as a **real function**, never as source text |
| 5 | `in_screen` is **not** a synonym for `visible` — an element 4000 px below the fold reports `isVisible() === true` | **yes** | the new operators are genuinely new behaviour, not an alias |
| 6 | The `IntersectionObserver` promise never settles for a **detached** element (when it does fire, it takes ~71 ms) | **yes** | a `setTimeout` backstop resolves `false` |
| 7 | A runaway snippet (`while (true) {}`) wedges the page **permanently** — a later `evaluate('1+1')` never returns either | no (it hangs) | the call is raced against a timeout, and a timeout reports an unmet condition instead of retrying a page that is already lost |

### Finding 5 overturned the plan in `MISSIONS.md`

The mission text proposed `locator.boundingBox()` ∩ viewport for the in-screen
test. **Measured, that is wrong.** For an element scrolled out of sight inside
an `overflow: hidden` container, the box test reports IN-VIEW —
`{x:10, y:410, w:200, h:30}` inside an 800×600 viewport — while
`IntersectionObserver` correctly reports `false`. A single rectangle cannot
account for ancestor clipping. The document's own suggestion was discarded on
the evidence.

---

## 3. The two decisions this mission was asked to make

**Do the DOM operators move into the value-type dropdown, the way Automa does?
→ No.**

Automa expresses "Element exists" as a *value type*, and then has nothing left
to compare, so its operator dropdown sits unused on those rows. Aria's split is
different and deliberate: `checkKindOf` chooses the **runtime path**, the
operator chooses **how to compare**. That is why an `element` row shows two
fields rather than five. Moving the DOM operators would mean the *same* choice
appears in two dropdowns — precisely the duplicate/ambiguous control that rule
R3 exists to prevent. So `in_screen` / `not_in_screen` joined the existing `dom`
**operator** bucket, and an `element` row still collapses to a single
`<optgroup>`.

**Does "Data exists" need its own value type? → No, it already exists twice
over.**

`is_truthy` / `is_falsy` (JS truthiness) and `is_empty` / `not_empty` (trimmed
emptiness) both answer that question, and both compose with every kind —
including the new one. **`code` → `is_truthy` *is* Automa's "Data exists".** A
third spelling would be a control the user has to tell apart from two others
that behave identically.

---

## 4. The four check kinds

"Check kind" is **derived, never persisted**. `checkKindOf(row)` reads it back
out of the row's own fields and `applyCheckKind(row, kind)` rewrites them. This
matters: `params.groups` for already-saved workflows stays **byte-identical**,
so this mission cannot migrate or corrupt existing data.

| Kind | Group | Row shape | Runtime path in `ConditionEngine.evaluateSimple` |
|---|---|---|---|
| `element` | Element | selector + DOM operator | DOM path — `exists` / `visible` / `in_screen` … |
| `content` | Element | selector + `source` (`text`/`attribute`/`value`/`html`) + operator + expected | `readFromElement` |
| `variable` | Value | `source: 'variable'` + name + operator + expected | variable path |
| `code` | Value | **JS snippet** + operator + expected | `readFromCode` ← **new** |

The dropdown is now built from `CONDITION_KIND_GROUPS` via
`groupedCheckKinds()`, which carries an `cvg.other` orphan bucket so a kind
added later without a group still renders instead of vanishing.

`applyCheckKind` clears in **both** directions between `code` and `variable`
(switching either way must not leave the other's `source` behind), and the
`content` branch resets both back to `'text'`.

> **Latent bug fixed on the way.** `ndv-nodes.js` copied `applyCheckKind`'s
> result onto the row *without removing keys the result no longer has*, so a
> stale `attribute` or `variable` could survive a kind switch. It now deletes
> absent keys first.

---

## 5. The `code` value type

The snippet is evaluated in the page and **its return value becomes the
left-hand side** — so it composes with the whole operator list, not just
truthiness. `code` seeds with Automa's own `return true;`
(`CONDITION_CODE_SEED`).

* `{{variable}}` references are resolved **before** evaluation, so a snippet can
  read workflow state.
* The wrapper is chosen by `looksLikeStatement()` (findings 1 + 2) — a `return`,
  a `;` followed by more code, or a `const`/`let`/`if`/`for`/… keyword means
  statement body; otherwise the snippet is wrapped as an expression.
* Length is capped by `CONDITION_CODE_MAX_LENGTH`.
* The call is raced against `CONDITION_CODE_TIMEOUT_MS` using a `CODE_TIMED_OUT`
  sentinel symbol (finding 7), and the timer is always cleared in `finally`.

### `codeContext` — carried, not offered

Automa has a Background / Active-tab dropdown. Aria's backend has exactly one
context (the page), so **no dropdown was added** — rule R3 forbids shipping a
control the backend ignores. But `codeContext: 'page'` *is* accepted, preserved
through serialisation in both directions, and declared in `actions.js` as an
`internal` param, so an imported Automa workflow does not silently lose it.

It is deliberately **not** in `blankRow()`. A key there would land on every
newly serialised row and change `params.groups` for every saved workflow — the
exact thing §4 protects. Tests assert both halves: `'page'` survives a
round-trip, and a bogus `'background'` is rejected.

### The editor cell

`NdvUI.codeCell()` — a monospace `textarea`, `spellcheck=false`, `wrap="off"`,
LTR-forced even in the Persian RTL layout, auto-fitting between 3 and 12 rows.
Tab inserts two spaces **only when the field is non-empty**, so the field is
still escapable by keyboard from empty (a11y).

---

## 6. Behaviour when things go wrong

No new failure mode throws out of the engine. Each resolves to a definite
branch, chosen so that "we could not tell" never reads as "yes":

| Situation | Result |
|---|---|
| Selector matches nothing | `not_exists` / `hidden` / `not_in_screen` → `true`; everything else → `false` |
| Element is detached mid-check | observer never fires → backstop → `not_in_screen` semantics (finding 6) |
| Snippet throws | left-hand value is `''` — the operator then decides |
| Snippet exceeds `CONDITION_CODE_TIMEOUT_MS` | left-hand value is `''`, **no retry** (finding 7) |
| Snippet longer than `CONDITION_CODE_MAX_LENGTH` | rejected before evaluation |

---

## 7. Tunables

Three knobs in `src/config.ts`, documented in `.env.example`, each default
justified by a measurement rather than a guess:

| Env var | Default | Why |
|---|---|---|
| `CONDITION_IN_SCREEN_TIMEOUT_MS` | `1000` | the observer settles in ~71 ms when it fires at all (finding 6) |
| `CONDITION_CODE_MAX_LENGTH` | `5000` | a condition snippet is a predicate, not a program |
| `CONDITION_CODE_TIMEOUT_MS` | `5000` | a wedged page is unrecoverable, so cap it (finding 7) |

---

## 8. Verification

```bash
cd /home/user/webapp
npx tsc --noEmit                                  # ✅ clean
node --check public/js/ndv-model.js               # and every touched client file
npx vitest run --pool=forks --poolOptions.forks.maxForks=1
node tools/probe-condition-value-types.js         # ✅ 23/23, VERDICT=PASS
```

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `node --check` on all touched client files | ✅ clean |
| `tests/unit/condition-engine.test.ts` | ✅ 52/52 (+14) |
| `tests/unit/ndv-designed-nodes.test.ts` | ✅ 39/39 (+9) |
| full `npx vitest run` | ✅ **72 files / 1700 tests** (baseline 1677) |
| `node tools/probe-condition-value-types.js` | ✅ 23/23, VERDICT=PASS |
| i18n parity | ✅ 11 new keys, each present exactly twice (fa + en) |
| line endings | ✅ `public/**` LF, `src/**` CRLF preserved |

A **stale assertion was fixed, not deleted**:
`operatorsForKind('element')` expected 4 operators and now expects 6.
`groupedOperatorsForKind('element')` still returns exactly one group — correct,
since both new operators belong to the `dom` bucket (§3).

---

## 9. Not in scope / next

* **A Background-context dropdown for `code`.** The value is carried
  (`codeContext`), but the backend has one context, so no control is shown.
  Wiring a real second context is backend work first (R3).
* **`in_screen` threshold / partial visibility.** The observer's default
  `isIntersecting` is used, so *any* overlap counts as in-screen. A configurable
  ratio would need a new UI control and was not asked for.
* **Snippet autocomplete or syntax highlighting.** `codeCell` is a plain
  textarea by design — R5 rules out a CDN editor, and a hand-rolled highlighter
  is a mission of its own.
