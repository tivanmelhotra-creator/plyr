# HANDOFF 14 — backend↔UI parity, and progressive disclosure in the Condition NDV

> **SUPERSEDED by `15-HANDOFF-element-picker-automa-research.md`.** Its § 0 rules
> (0.1–0.9) and every unfinished item of its § 4 are carried forward there.

**Supersedes:** `13-HANDOFF-ndv-reachability-scroll-density.md` (still the source of
truth for everything in its § 0 that is not amended below).

---

## 0. STANDING RULES

Rules 0.1 – 0.8 of HANDOFF 13 still apply. Read them first. Two are **amended**
and one is **new**, at the explicit instruction of the project owner.

### 0.2 — AMENDED. The WebP outranks the prose, but PARITY outranks the WebP.

HANDOFF 13 said "the `.webp` outranks every `.md`". That stays true for
*appearance* — spacing, weight, colour, glyph, order.

It does **not** decide *existence*. The mocks in `docs/uiux/` were drawn as a
design roadmap **without reference to the backend**, so they may show a control
the runtime cannot honour, and they may omit a capability the runtime already
has. When the mock and the runtime disagree about whether a control should exist
at all, the mock does not win by default — rule 0.9 decides.

### 0.9 — NEW. Backend and UI go on the two pans of one scale.

For every node (and every screen outside the nodes), the question is not "what
does the mock show?" but **"what does this node actually need?"** Put the runtime
on one pan and the mock on the other, then resolve each difference deliberately:

| Situation | Action |
| --- | --- |
| In the mock, missing from the backend | implement it in the backend — the UI is not allowed to pretend |
| In the backend, missing from the mock | surface it in the UI — a shipped capability nobody can reach is wasted |
| In neither, but genuinely needed | add it to both, and say why |
| **In the UI but nothing consumes it** | **delete it.** A control that cannot change the outcome is worse than a missing one: it spends the user's attention and teaches them that the panel's settings are not to be trusted |
| Exaggerated, or a second way to say the same thing | delete it. Nothing is decorative |

And the two UX clauses that come with it:

* **Every option must be logical, and its purpose must be legible.** If a
  developer's intent behind a control cannot be guessed from the control itself,
  the control is wrong — not the user.
* **Progressive disclosure, engineered — not "hide things to look clean".**
  Present one primary decision, then reveal only the options that decision
  actually implies. We ship pro-max capability in a shape a beginner can follow.
  A panel that shows every option at once is how a newcomer bounces off the
  Condition node.

**Verification for 0.9:** an option may only ship if you can name the file and
line that consumes it. `grep -rn '<paramName>' src/` returning nothing is a
deletion order, not a TODO.

---

## 1. THE FIRST AUDIT — Condition node (`if` / `while`)

Method: read `src/core/ConditionEngine.ts` end to end, then diff it against
`public/js/ndv-model.js` + `public/js/actions.js` + `ndv-condition-final.webp`.

### 1.1 Operators

| Operator | Engine | UI before | Now | Decision |
| --- | --- | --- | --- | --- |
| `exists` `not_exists` `visible` `hidden` | ✅ | ✅ | ✅ | keep |
| `equals` `not_equals` `contains` `not_contains` `starts_with` `ends_with` | ✅ | ✅ | ✅ | keep |
| `matches_regex` | ✅ (safe-regex2 guarded) | ✅ | ✅ | keep |
| `greater_than` `less_than` `greater_equal` `less_equal` | ✅ | ✅ | ✅ | keep |
| `is_empty` `not_empty` `is_true` `is_false` | ✅ | ✅ | ✅ | keep |
| **`in_list` / `not_in_list`** | ✅ | ❌ | ✅ | **ADDED to the UI.** Real, common need ("status is one of paid, shipped, delivered") that previously forced three hand-built OR groups. |
| **`random`** | ✅ | ❌ | ❌ | **DELIBERATELY WITHHELD.** `Math.random()*100 < expected` makes a run unreproducible and undebuggable ("why did last night's run take the other branch?"). The engine keeps it so imported JSON still runs; the builder will not help you author it. |
| `CompositeCondition.not` | ✅ | ❌ | ❌ | **WITHHELD as redundant.** Every operator ships its negative twin, so a NOT toggle would be a second way to say the same thing. |

`in_list` needed a serialiser change, not just a menu entry: the engine compares
with `Array.isArray(expected) && expected.includes(…)`, so a comma **string**
would have evaluated to `false` forever. `graph-serialize.js` now splits the
single text field on commas/newlines into a real array at the one boundary where
editor rows become backend conditions, and joins it back with `", "` on the way
in.

### 1.2 Deleted: two controls nothing consumed

`grep -rn 'maxDepth\|evaluateMode' src/` → **no matches anywhere in the
backend.** Not in `ConditionEngine`, not in the pipeline, not in the schemas.
Both were drawn in `ndv-condition-final.webp`, so they had been built and then
frozen in place by a guard test that *required* them.

* **`Max depth` (3 / 5 / 8)** — guarded "recursive evaluation depth", but this
  builder can only ever emit two levels (`any` of `all`), so every value behaved
  identically.
* **`Evaluate mode` (first match / evaluate all)** — described short-circuiting,
  which is already how `any`/`all` behave. Never a decision a user needed.

Removed from: `ndv-nodes.js` (the `.cb-foot` strip), `ndv-model.js`
(`EVALUATE_MODES`), `actions.js` (both `if` and `while` field lists),
`flow-editor.js` (the param whitelist), `styles.css` (`.cb-foot`), `i18n.js`
(7 keys in each language). They stay in `graph-serialize.js`'s
`CONDITION_ONLY_PARAMS` **strip list** for one release, so a workflow saved by an
older build sheds them cleanly instead of leaking two orphan params into
`step.params`.

**This is the one place where the locked mock is deliberately not followed.**

### 1.3 The disclosure model — the row's three kinds

`ConditionEngine.evaluateSimple` has exactly three paths, and each ignores
different fields:

| Path | Engine site | Reads | Ignores |
| --- | --- | --- | --- |
| DOM | L111, `operator ∈ exists/not_exists/visible/hidden` | `selector` | `source`, `attribute`, `expected` |
| variable | L140, `source === 'variable'` | the variable **named by** `value` | `selector` |
| content | `readFromElement`, L211 | `selector` + `source` (+ `attribute`) | `value` |

The old row rendered all five controls for every kind. So a row set to
`visible` still asked the user to configure a "Left source" the run throws away,
and a `variable` row still asked for a "CSS Selector" the run throws away. That
is not clutter — **it is a UI that lies about what the run will do.**

`NdvModel.CONDITION_KINDS` turns those three paths into the row's one primary
question, *"What do you want to check?"*:

| Kind | Fields shown | Operators offered |
| --- | --- | --- |
| `element` — an element exists or is visible | CSS Selector · Operator | the 4 DOM operators only |
| `content` — an element's content | CSS Selector · What to read · [Attribute name] · Operator · [Value] | the 17 comparison operators |
| `variable` — a workflow variable | Variable name · Operator · [Value] | the 17 comparison operators |

Measured (`probe-cond-kinds`): an "is this element on the page?" row is now **2
fields instead of 5**, and **no field is ever shown that the run will ignore**.

`kind` is **derived, never stored** (`checkKindOf(row)`), so `params.groups`, the
backend contract and every already-saved workflow are byte-identical — verified
by a test asserting the serialised keys of an `element` row are exactly
`['operator','selector']` and that no `kind` appears.

Switching kind calls `applyCheckKind`, which clears exactly the fields the new
path cannot use — leaving a stale `selector` on a variable row would be the same
lie in reverse.

Two renames that came out of the same audit: **"Left source" → "What to read"**
(it asks which *part of the element* to read, and `variable` is no longer a value
smuggled into that dropdown), and the ⓘ hint on every field now explains the
choice rather than restating the label.

---

## 2. ALSO LANDED IN THIS SESSION (the § 5.1 tail of HANDOFF 13)

* **Condition NDV rendered and crop-compared for the first time.** It had never
  been looked at. Nine structural deltas from `ndv-condition-final.webp` found
  and fixed: plain text tokens instead of coloured pills (`.cb-row-toks`), plain
  group letter instead of an orange badge, 22px circular row number, neutral
  `OR` pill, only the first row expanded by default, `+ AND` inside the last
  expanded row's body, ⓘ dots on every field, an `Attribute name` combobox
  (`NdvUI.comboCell`, free text + suggestions — a `<select>` would have removed
  the runtime's ability to read *any* attribute), `.cb-builder` de-scrollered.
* **The group-header trash button was removed** — 1:1 crops of both group heads
  show only the letter and the AND label. Deleting a group's last row already
  splices the group out, so it was redundant as well as off-design.
* **`window.FlowEditor.openNdv` / `closeNdv` / `ndvOpenFor` exported.** The NDV
  was reachable only by double-clicking a card, which made it unrenderable for
  the shot harness and any DOM probe. Same internal function the double-click
  handler calls — one code path, not a test-only shortcut.
* **`tools/ui-shot.js`**: new `UI_STEPS=<json>` (push a real backend `steps[]`
  through `FlowEditor.loadSteps`, needed because no template contains an `if`)
  and a new `ndv:<action>` / `ndv:#<id>` interaction step that opens the NDV
  without canvas hit-testing.
* **The ⓘ glyph is now `info` (an "i"), not `help-circle` (a "?")** — a new icon
  in `icons.js`; the crops show an ⓘ. The `'⌄'` fallback in `comboCell` was
  removed: the product font has no coverage for U+2304, so it rendered an empty
  box, and `icons.test.ts` correctly caught it.
* **Rule 0.6 debt paid**: 138 Persian keys added for the previously English-only
  NDV block, plus the new keys from this session. **fa 929 = en 929**, no key
  missing from either dictionary, ZWNJ used in Persian compounds. Persian RTL
  render verified.
* **`.cb-line-1` is now weighted by cell count** (`:has()`), because the selector
  cell carries two inline buttons and an even split truncated `#login-status`
  to `#login·`.

---

## 3. VERIFICATION AT THE END OF THIS SESSION

```
npx vitest run          → 37 files / 800 tests passed   (was 794; +6 guard tests)
npx tsc --noEmit        → silent
ls public/js/*.js | wc  → 18                            (rule 0.5)
grep -c $'\r' src/Routes/user.routes.ts → 1317           (rule 0.7)
grep -rl $'\r' public/ | wc -l          → 0              (rule 0.7)
```

New guard tests in `tests/unit/ndv-designed-nodes.test.ts`:

1. `if`/`while` offer **no** param the backend never reads (the inverse of the
   test that had frozen `maxDepth`/`evaluateMode` in place — it now parses
   `ConditionEngine.ts` itself);
2. every engine operator is reachable from the builder **except** the
   intentionally withheld `random`;
3. an `in_list` row serialises to a real **array** and round-trips back to the
   comma text the user typed;
4. the check kind is derived and never serialised;
5. each kind offers only the operators it can evaluate.

---

## 4. WHAT IS LEFT — in this order

### 4.1 Audit the remaining nodes against rule 0.9 — do this BEFORE more pixels

The Condition audit found one dead control pair, two unreachable operators and a
lying panel **in the one node we looked at**. Assume the same per node. Run the
same method on, in order of blast radius:

1. **`click`** — the other locked design. `ndv-click-element-final.webp` shows
   many controls (`stableForMs`, `human`, `force`, `modAlt/Ctrl/Shift`,
   `highlightElement`, `visibleOnly`, `multipleMatches`, offsets). For **each**,
   `grep -rn '<key>' src/` and classify with the 0.9 table. Expect deletions.
2. **`switch`** — `dynamicBranches: 'cases'`; check the engine actually honours
   every case shape the UI can build, and whether it shares
   `ConditionEngine`'s operators (if so, it needs the same kind treatment).
3. **`goto` / `wait` / `screenshot` / `extract`** — the everyday nodes, where a
   missing option costs the most.
4. **Outside the nodes**: the run panel, the export menu, the settings screen.
   The same rule applies — HANDOFF 13 § 5.7's "no invented providers" for Online
   Services is exactly rule 0.9 stated for one screen.

Record every audit as a table like § 1.1 in the next handoff. **Do not delete a
backend capability to make a table balance** — withhold it in the UI with a
written reason, as `random` is.

### 4.2 Then the deferred shell items from HANDOFF 13 § 5

Unchanged, and each now also needs a 0.9 pass before it is built:

* **G5** run-info strip — wire `views.js#refreshRunInfo()` from
  `RunPanel.getSummary()`; decide `#fe-statusbar` vs `#fe-result`. Real counts
  only; **empty, not zeroed**, before the first run. `#fe-statusbar` exists in
  the markup at `views.js` ~1016 but is never passed to `FE.mount()`.
* **G9** running glow · **G3** tab strip · **G11** `#fe-result` ·
  **G12** group/subflow · **G2** Online Services (disabled-with-reason).
* **INPUT column chip row** (§ 5.1): still `chips: []`. Decision recorded:
  **not** a § 0.3 violation, because there is no real input data to draw before a
  run. When built, drive it from `nodeResults[nodeId].input` — never invent rows.
* Residual Condition density: our bands sit 24–44px higher than the crop's
  because the design's shell has the G3 workflow tab strip we have not built
  (design NDV top edge y=68, ours y=54). Re-measure **after** G3 lands rather
  than compensating for it now. Foot geometry already matches (design ~824,
  ours 821 before the strip was deleted).

### 4.3 Per-item protocol (unchanged from HANDOFF 13 § 5)

Render before and after with `tools/ui-shot.js` (now: `UI_STEPS` + `ndv:` steps),
crop the WebP 1:1 and compare, **audit against rule 0.9**, add or update a guard
test, run the § 0 verification quartet, commit, and supersede **this** file.

---

## 5. ANCHORS ADDED THIS SESSION

| What | Where |
| --- | --- |
| check kinds, derivation, kind→operator filter, list splitter | `public/js/ndv-model.js` — `CONDITION_KINDS`, `checkKindOf`, `applyCheckKind`, `operatorsForKind`, `contentSources`, `parseListValue` |
| the disclosed row | `public/js/ndv-nodes.js` — `conditionRow`, "PROGRESSIVE DISCLOSURE" block |
| list ⇄ array boundary | `public/js/graph-serialize.js` — `LIST_OPERATORS`, `splitListValue`, `buildSimpleCondition`, `simpleRow` |
| gesture-free NDV | `public/js/flow-editor.js` — `openNdv` / `closeNdv` / `ndvOpenFor` exports |
| harness | `tools/ui-shot.js` — `UI_STEPS`, `ndv:` step |
| combobox primitive, ⓘ dot | `public/js/ndv-ui.js` — `comboCell`, `withInfo` |
| `info` glyph | `public/js/icons.js` |
| parity guard tests | `tests/unit/ndv-designed-nodes.test.ts` — the `condition NDV` describe |

Probes used and then deleted (rule: they live in the repo so the CSP-safe static
server can serve them, and are removed before commit):
`probe-cond-geom.tmp.js`, `probe-cond-font.tmp.js`, `probe-cond-kinds.tmp.js`.
