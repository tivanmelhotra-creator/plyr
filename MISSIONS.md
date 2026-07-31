# Aria Automate — Mission Ledger / فهرست ماموریت‌ها

> **What this file is / این فایل چیست**
> The single, authoritative checklist of everything the project owner asked for,
> in the order it was asked, with the exact status of each item. Items that are
> **done** are ticked; items that are **still open** are unticked and carry a
> concrete implementation plan (files + line anchors) so the next session can
> continue without re-discovering anything.
>
> این فایل تنها مرجع «چه چیزهایی خواسته شده و کدام‌ها انجام شده» است. آیتم‌های
> تیک‌خورده تمام شده‌اند، آیتم‌های بدون تیک برای جلسات بعدی مانده‌اند و برای هر
> کدام نقشه‌ی دقیق پیاده‌سازی (فایل + شماره خط) نوشته شده است.

**Repo:** `jalil-ahmadi2/plyr` · **Branch:** `genspark_ai_developer` · **PR:** #18
**Last updated:** 2026-07-31

---

## 0. Standing project rules / قواعد ثابت پروژه

These apply to **every** future change, not just the items below.

| # | Rule | Why |
|---|------|-----|
| R1 | **Cross-check every node's options against [AutomaApp/automa](https://github.com/automaapp/automa)** before designing or "finishing" them. Its node logic is the accepted reference. | Owner's explicit instruction (mission 8). Automa's `conditionBuilder` (`valueTypes` / `compareTypes` / `inputTypes`) and its Conditions block are the parity target. |
| R2 | Nodes are the essence of the tool — a node is not "done" until it exposes the **complete** set of options its runtime can honour. | Owner's instruction (mission 5). |
| R3 | Never ship a control that changes nothing. If a knob has no backend reference, either implement the backend or delete the knob. | Precedent: `EVALUATE_MODES` / `maxDepth` were deleted rather than faked (see `public/js/ndv-model.js` ~line 347). |
| R4 | Work happens on `genspark_ai_developer`; commit after every change, rebase on `origin/main`, squash to one commit, force-push, then open/update the PR and hand the owner the PR link. | Project workflow. |
| R5 | CSP-safe vanilla JS on the client, fa/en i18n key parity, `npx tsc --noEmit` + `node --check` + `npx vitest run` green before delivery. LF line endings under `public/**` (and `src/core/LiveBrowser.ts` is LF too). | Repo conventions. |

---

## 1. Mission board / تخته‌ی ماموریت‌ها

| # | Mission (short) | Status |
|---|-----------------|--------|
| 1 | RTL/Persian graph direction reversed | ✅ Done |
| 2 | Opened node (NDV) must cover 80% of the screen — for every node | ✅ Done |
| 3 | Outline panel closed by default | ✅ Done |
| 4 | Menu collapse control at the top + slimmer collapsed rail | ✅ Done |
| 5 | Condition node option parity with Automa (grouped value types + operators) | 🟡 Part 1 done (operators) · part 2 open (value types) |
| 6 | Simulated browser must browse for real; eye = element-select mode | ✅ Done |
| 7 | Condition node with multiple prioritised paths + neutral `next` | ⬜ Open |
| 8 | Standing rule: always cross-check Automa when settling node options | ✅ Done (documented as **R1** above) |

---

## 2. Completed missions / ماموریت‌های انجام‌شده

### ✅ 1. RTL graph direction was mirrored

**Asked:** in Persian (RTL) mode the graph is reversed — a node's *output* appears to
feed the next node's *output* section, i.e. wires enter from the wrong side.

**Root cause:** the node cards and the SVG edge layer are positioned with
**physical** coordinates (`left`/`top`, SVG `x`/`y`), but the port chips were
placed with **logical** CSS properties (`inset-inline-start` / `inset-inline-end`),
which flip under `dir="rtl"`. So the ports moved and the wires did not.

**Fix** — `public/css/styles.css`, right after the `.fe-world` rule:

```css
.fe-svg,
.fe-world { direction: ltr; }          /* graph geometry is physical, lock it */
.fn-title, .flow-node-sub,
.fe-edge-pill, .flow-port-label { unicode-bidi: plaintext; }
.fn-title, .flow-node-sub { text-align: left; }
```

`unicode-bidi: plaintext` keeps mixed Persian/Latin labels (selectors, URLs)
readable inside the direction-locked layer.

**Verified:** fa + en screenshots via `tools/ui-shot.js`; the owner's own
screenshot in message 3 confirms ports now read `اگر درست` / `اگر نادرست` / `بعدی`
on the correct sides.

---

### ✅ 2. NDV must be 80% of the screen for every node

**Asked:** when a node opens with its three columns (INPUT | parameters | OUTPUT)
it must cover **80% of the whole screen for every node**, no matter how many
fields it has.

**Root cause:** three competing size rules — the generic NDV was
content-sized under a `min(1080px, …)` / `min(760px, …)` ceiling, while the
"designed" NDV declared `width: min(1180px,94vw); height: min(820px,94vh)`. So
the modal resized per node.

**Fix** — `public/css/styles.css`:

* `.ndv-modal { width: 80vw; height: 80vh; max-width: 80vw; max-height: 80vh; display:flex; flex-direction:column; }`
* the designed variant's own `width`/`height`/`max-height` block was **removed**
  (replaced by an explanatory comment) so there is exactly one size rule.
* the fixed-height contract was extended to undesigned nodes:
  `.ndv-modal:not(.is-designed)` gets `overflow:hidden` on `.ndv-body`,
  `min-height:0` on **every** flex/grid ancestor, `grid-template-rows: minmax(0,1fr)`
  on `.ndv-cols`, `overflow:auto` per `.ndv-col`, and **sticky column heads**.
* `@media (max-width: 860px)`: `94vw × 92vh`, single column, outer scroll.

**Gotcha for future edits:** `.ndv-body` must **never** get `overflow` back, or
the modal collapses into one outer scroller again.

**Verified:** designed (`if`) and undesigned (`http-request`) NDVs both render at
exactly `1152 × 720` in a `1440 × 900` viewport.

---

### ✅ 3. Outline panel closed by default

**Fix** — `public/js/views.js` ~line 1562:

```js
var olOpen = AppUtil.pref ? !!AppUtil.pref('feOutlineOpen', false) : false;
```

The preference still persists the user's choice; only the **default** flipped to
closed. Applied on first render through `setOutlineOpen(olOpen, false)`.

---

### ✅ 4. Collapse control at the top of the menu + slimmer collapsed rail

**Asked:** the collapse control sits at the **end** of the menu; it must be at
the **top**. Also, when collapsed the rail still eats too much width.

**Fix:**

* `public/js/flow-editor.js` → `renderPalette()`: new `.palette-head` row that
  holds the search row **plus** a `.pl-collapse` icon button (chevron, RTL-flipped),
  so the control costs **zero extra vertical space**. The old
  "Collapse" link was removed from `.palette-foot`.
* `paletteRail()`: the `.pl-restore` expander chip is now appended **first**
  (before Favorites and the six groups) with a hairline `::after` separator.
* `public/css/styles.css`: collapsed column `64px → 44px`, rail buttons
  `40px → 32px`, `.pl-rail` gap `6px → 4px`, and the `980px` media override
  updated to match.

**Verified:** `tests/unit/editor-shell.test.ts` (new `ruleFor()` helper +
"the collapse control sits at the top of the palette, not in the footer" test,
and G8 now asserts the expander is first and the column is `44px`), plus fa/en
screenshots.

---

### ✅ 6. Real browsing in the simulated browser; the eye = element-select mode

**Asked:** clicking and browsing don't work — you can only hover and pick. The
eye icon does **not** mean "hide"; it means **toggling element-selection mode**.
Desired: browse normally; **eye ON** → selection mode (clicks disabled, hover
outlines the element); **eye OFF** → no outline, no selection, and the tool panel
becomes slightly transparent.

**Root cause:** `browser-view.js`'s `onMessage` handler for `'ready'` sent
`{ t:'picker', on:true }` unconditionally, so the injected `PICKER_SCRIPT`'s
capture-phase `onClick` (which calls `e.preventDefault()` on every trusted click)
stayed installed for the whole session. Real browsing only works when the picker
is **not** injected — the client simply never turned it off.

**Fix:**

* `public/js/browser-view.js`: `pickState.selectMode` (default **false**) and a
  single `applySelectMode(on, quiet)` function that is the only place deciding
  what a click means — it sends `{t:'picker', on}`, clears the lock, toggles
  `is-on`/`aria-pressed` on `#bvp-eye`, `is-browse` on the panel, `is-picking`
  on the canvas, and rewrites `#bvp-modeline` + `#bvp-kbd`.
* `#bvp-ghost` (see-through) → `#bvp-eye` (select-mode toggle).
* Keyboard passthrough in browse mode: a `NAMED_KEYS` table → `{t:'key'}` and
  single characters → `{t:'type', text}`, with ctrl/meta/alt left to the OS.
* **Back / Forward / Reload** wired end-to-end: `#bvp-back` / `#bvp-fwd` /
  `#bvp-reload` → `BrowserStreamServer.handleCommand()` new
  `back`/`forward`/`reload` cases → new `LiveBrowser.back()/forward()/reload()`
  (`page.goBack/goForward/reload`, emit `navigated`).
* `public/css/styles.css`: `.bvp-canvas` default cursor with `.is-picking`
  crosshair, `.bvp-panel.is-browse { opacity:.55 }` (full opacity on
  hover/focus) replacing `.is-ghost`, `.bvp-eye.is-on`, `.bvp-modeline`.
* `public/js/i18n.js`: 10 new `bvp.*` keys in **both** fa and en
  (`selectOn/selectOff/selectedOn/selectedOff/inSelect/inBrowse/kbdBrowse/back/forward/reload`),
  `bvp.seeThrough` removed, `bvp.hint` rewritten around the browse-first flow.

**Verified:** 7 new tests in `tests/unit/element-picker.test.ts` (38/38 green) +
`tools/picker-panel-shot.js` renders with `errors: []`.

---

### ✅ 8. Standing rule — always cross-check Automa

**Asked:** *«حتما موقع تنظیم اپشن های هر نود به پروژه automa … مراجعه کن، چون منطق
نودهاشو قبول دارم»* — whenever the options of a node are being settled, consult
Automa, because its node logic is endorsed.

**Recorded as rule R1** in section 0 of this file (the authoritative project-rules
table). Concretely, the reference surfaces are:

* `src/components/block/BlockConditions.vue` + `blocks/handlers/handlerConditions.js`
  → the Conditions block: an **ordered** `data.conditions[]`, each entry with its
  own `id` / `name` / condition tree; **first match wins** and its output id is
  taken; if nothing matches, the `'fallback'` output is used. Optional
  `retryConditions` / `retryCount` / `retryTimeout`. UI is a draggable list
  (max 20) with add / edit / delete.
* `utils/shared.js → conditionBuilder`:
  * **`valueTypes`** grouped as *value* (Value, Code, Data exists) and *element*
    (Element text, Element exists, Element not exists, Element visible,
    Element visible in screen, Element hidden in screen, Element attribute value).
  * **`compareTypes`** grouped as *basic* (`eq`, `eqi`, `nq`), *number*
    (`gt`, `gte`, `lt`, `lte`), *text* (`cnt`, `cni`, `nct`, `nci`, `stw`, `enw`,
    `rgx`) and *boolean* (`itr`, `ifl`).
  * `inputTypes` decides whether the right-hand side is a text box, a number box,
    a code editor or nothing at all.

---

## 3. Open missions / ماموریت‌های باقی‌مانده

### 🟡 5. Condition node: full option parity with Automa

**Asked:** nodes are the essence of the tool and deserve top priority — every node
must expose complete options. Specifically the condition node must be able to
express "anything conditional", matching Automa's grouped dropdowns and row UI
(`element#text Equals Empty` header, "CSS selector or XPath" field with the
crosshair + verify icons, `+ AND` / `+ OR`).

#### ✅ Part 1 — grouped operator dropdown + the missing operators (shipped)

All 16 of Automa's `compareTypes` are now reachable, and the dropdown is bucketed
like Automa's:

| Automa | Aria operator | Status |
|--------|---------------|--------|
| `eq` / `nq` | `equals` / `not_equals` | already existed |
| **`eqi`** | **`equals_i`** | ✅ added (model + engine) |
| `gt` / `gte` / `lt` / `lte` | `greater_than` / `greater_equal` / `less_than` / `less_equal` | already existed |
| `cnt` / `nct` | `contains` / `not_contains` | already existed |
| **`cni`** / **`nci`** | **`contains_i`** / **`not_contains_i`** | ✅ added (model + engine) |
| `stw` / `enw` / `rgx` | `starts_with` / `ends_with` / `matches_regex` | already existed |
| **`itr`** / **`ifl`** | **`is_truthy`** / **`is_falsy`** | ✅ added — JS truthiness, deliberately *not* the same as the existing `is_true` / `is_false` (which only accept the boolean or the literal string `"true"`) |

* `public/js/ndv-model.js` — new `CONDITION_OPERATOR_GROUPS`
  (`dom` / `basic` / `number` / `text` / `state` / `boolean` / `list`), a `group`
  on every operator, and `groupedOperatorsForKind(kind)` which buckets the list,
  drops empty buckets and has an orphan safety net (`opg.other`) so an operator
  added without a group can never silently vanish from the dropdown. The group
  order mirrors the registry order, so the grouped and flat views cannot disagree.
* `public/js/ndv-ui.js` — `selectCell` now accepts
  `[{ group, options: [...] }]` and renders real `<optgroup>`s (native,
  screen-reader-announced, no custom popup). An empty bucket is skipped.
* `public/js/ndv-nodes.js` — the operator dropdown uses
  `m.groupedOperatorsForKind(kind)`. An `element` row still collapses to a single
  bucket rather than six empty headings.
* `src/core/ConditionEngine.ts` — `ConditionOperator` union + compare `switch`
  extended with the five new operators (rule R3: no UI-only knobs).
* `public/js/actions.js` — the `operator` enum of **both** `if` and `while`
  extended, otherwise `coerceParams` would drop the new values on save.
* `public/js/i18n.js` — fa + en for 5 operators + 8 group labels.
* Tests — `condition-engine.test.ts` (+4: case folding, truthiness vs is_true,
  variable resolution) and `ndv-designed-nodes.test.ts` (+6: an explicit
  Automa-`compareTypes`→Aria mapping table, every operator has a known group,
  bucketing loses/duplicates nothing and keeps registry order, fa+en label
  parity, real `<optgroup>` in the source, catalog declares every operator).

#### ⬜ Part 2 — grouped **value types** (still open)

Automa's `conditionBuilder.valueTypes` is the second dropdown, grouped *value* /
*element*. What is left:

| Automa value type | Aria today | Work needed |
|-------------------|-----------|-------------|
| Value | `content` kind | already covered |
| Element text / attribute value | `source: 'text'` / `'attribute'` | capability exists; must appear as first-class entries in one grouped value-type dropdown |
| Element exists / not exists / visible / hidden | `exists` / `not_exists` / `visible` / `hidden` | covered by the `dom` operator bucket; decide whether to *move* them into the value-type dropdown as Automa does |
| **Code** | ✗ | a JS expression evaluated in the page; Automa adds a **Background / Active tab** execution-context dropdown and seeds the editor with `return true;` |
| **Data exists** | partially (`is_empty` / `not_empty`) | an explicit "data exists" value type over a variable / expression |
| **Element visible in screen** / **hidden in screen** | ✗ | in-viewport check (`locator.boundingBox()` ∩ viewport, or an in-page `IntersectionObserver`) — genuinely different from `visible` / `hidden` |

**Implementation order for part 2 (do not skip the backend):**

1. `public/js/ndv-model.js` — a grouped `CONDITION_VALUE_TYPES` registry beside
   the operator one; keep `checkKindOf` / `applyCheckKind` honest (they are
   *better* than Automa: they hide the fields the runtime would throw away).
2. `src/core/ConditionEngine.ts` — new `ConditionSource` entries (L31) +
   `SOURCES` (L56) + `readFromElement` (L209+), and the viewport / code paths.
3. `public/js/graph-serialize.js` — `buildCondition` / `conditionToGroups` /
   `CONDITION_ONLY_PARAMS` round-trip for every new field.
4. `public/js/actions.js` — declare every new param (else it is dropped on save).
5. `public/js/i18n.js` — fa + en keys (parity is asserted by tests).
6. Tests — model, engine and round-trip.

---

### ⬜ 7. Condition node with multiple prioritised paths

**Asked (verbatim):** *«نود شرطی یه بخش path داره که نمیشه جدید اضافه کرد … هر
کدوم از path ها با اولویت بالا از بالا به پایین به ترتیب چک میشه، درست باشه اون
مسیر رو میره وگرنه بعدی چک میشه. اگر هیچ کدوم کار نکرد و مسیری فعال نشه، از مسیر
خنثا یعنی next میره.»*

So: **N ordered paths, evaluated top → bottom, first true path is the route
taken; if none match, execution leaves through the neutral `next` port.**

**Why it is blocked today** (both anchors confirmed by reading the files):

* `public/js/ndv-model.js:319` — `var CONDITION_MAX_PATHS_V1 = 1;` with the
  comment *"v1 runtime executes a single path … kept as a constant so the UI can
  label the disabled `+ Add path` control honestly."*
* `public/js/ndv-nodes.js:457` — `renderCondition()` builds `.cb-addpath` with
  `addPath.disabled = true` and `.cb-path-plus` with `pathPlus.disabled = true`
  (title `cb.addPathV2`). This is exactly the "path section with no way to add a
  new one" that was reported.

**Design decided (Automa-parity, list-engine friendly):**

* **Model:** the node holds an ordered `paths` array — `[{ id, name, groups }]` —
  where `groups` is the existing AND/OR structure. One default path keeps every
  saved workflow byte-identical.
* **Ports** (`public/js/flow-editor.js` → `portsOf()` ~line 428):
  * exactly 1 path → keep today's `then` / `else` / `next` (`اگر درست` /
    `اگر نادرست` / `بعدی`) so nothing existing breaks;
  * ≥ 2 paths → one `path:<id>` port per path, labelled with the path name,
    plus `next` as the **neutral / fallback** port (no `else`).
* **Serialisation** (`public/js/graph-serialize.js`):
  `{ action:'if', paths:[{ id, name, condition, steps:[…] }] }`; a single-path
  node still serialises to the legacy `{ action:'if', condition, then, else }`.
* **Runtime** (`src/pipeline.ts`, the `if` branch at ~line 981 inside
  `executeStepGroup`, which is labelled `stepLoop:` at line 893):
  when `step.paths` is a non-empty array, evaluate each path's condition in
  order; the **first** truthy one runs its `steps` and then leaves the group
  (exclusive routing — the neutral chain must not also run); if none match, fall
  through so the steps following the node (the `next` chain) execute.
  Note `executeStepGroup` already has a control-signal convention
  (`res.return` / `res.break`) to build on.
* **Validation** (`src/validation.ts`): `StepInput` (~line 32) needs
  `paths?: { id, name, condition, steps }[]`, and `mapStep` (~line 240) must
  recurse into `paths[].steps` exactly like it does for `then` / `else` / `cases`.
  Anything not mapped there is stripped before it reaches the pipeline.
* **UI** (`public/js/ndv-nodes.js:457`): lift the two `disabled` flags, make the
  `.cb-pathrow` a real list — add / rename / reorder (↑↓) / delete, priority
  numbers visible, Automa's cap of 20 — and show the neutral path as a
  non-deletable trailing row so the fallback is never invisible.
* **Also touch:** `public/css/styles.css` (path-list styles),
  `public/js/i18n.js` (fa + en path keys, and retire `cb.addPathV2`),
  `NdvModel.conditionSummary` + the canvas card summary, and
  `graph-serialize.js → outlineTree` so the Outline shows each path.

---

## 4. How to verify / روش تست

```bash
cd /home/user/webapp
npx tsc --noEmit                       # TypeScript
node --check public/js/flow-editor.js  # and every touched client file
npx vitest run                         # baseline: 39 files / 847 tests
node tools/ui-preview-server.js 8788 &                       # visual harness
UI_LANG=fa node tools/ui-shot.js '/editor' .ui-shots/fa.png 1440x900
node tools/picker-panel-shot.js                              # picker panel
```

`tools/ui-shot.js` accepts `UI_LANG`, `UI_SEED`, `UI_STEPS`, `UI_WAIT`; the
`steps` argument understands `dbl:`, `ndv:<action>`, `ndv:#id` and `key:`.
Every shot must report `errors: none`.

---

## 5. Current build/test state

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ clean |
| `node --check` (touched client files) | ✅ clean |
| `tests/unit/element-picker.test.ts` | ✅ 38/38 |
| `tests/unit/editor-shell.test.ts` | ✅ 67/67 |
| `tests/unit/condition-engine.test.ts` | ✅ 38/38 |
| `tests/unit/ndv-designed-nodes.test.ts` | ✅ 30/30 |
| full `npx vitest run` | ✅ **39 files / 866 tests** |
| line endings | ✅ `public/**` LF, `ConditionEngine.ts` CRLF preserved |
| Git | branch `genspark_ai_developer`, PR **#18** open against `main` |
