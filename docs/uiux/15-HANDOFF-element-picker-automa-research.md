# HANDOFF 15 — the Element Picker (crosshair → live page → panel → field), and what Automa actually does

**Supersedes:** `14-HANDOFF-backend-ui-parity-condition-disclosure.md`.
Rules 0.1 – 0.9 of HANDOFF 13/14 still apply **unchanged**; § 0 below only adds
0.10. Everything in HANDOFF 14 § 4 that has **not** shipped is restated in § 6
here, so this file alone is enough to resume with no chat history.

> **Session context:** this session ran out of credit mid-way on purpose-built
> work. Everything in § 3 is committed and green. Everything in § 6 is not
> started. Nothing is half-applied — see § 5 for the exact verification state.

---

## 0. STANDING RULES (additions only)

### 0.10 — NEW. A picker is not a viewer. Hover previews, click commits.

Any "pick something from a real page" affordance we build must separate the two
states, because they answer different questions:

* **hover** = *"is this the thing?"* — cheap, throttled, overwritable, non-destructive.
* **click / Space** = *"this is the thing"* — locks the answer, stops following the
  pointer, and is the only state from which refinement (↑/↓, editing) makes sense.

Collapsing them into one state is what makes DevTools-style pickers feel jumpy,
and it is why our panel carries an explicit `is-locked` border. Also: a picker
must always tell the user **how many elements the produced selector matches**.
A selector that silently matches 40 nodes is the single most common cause of a
"working" automation that does the wrong thing on run 2.

---

## 1. THE RESEARCH ANSWER — *does Automa have this capability?*

**Yes — but not in the form we need, and the difference is architectural, not cosmetic.**

Sources consulted (2026-07-31):

* Automa docs, *Element Selector* — <https://automa-docs-old.vercel.app/guide/element-selector.html>
  Verbatim: *"This feature allows you to generate the XPath or CSS Selector of an
  element. To use the element selector, you need to open a website first and at
  the Automa popup, click the 'Element selector' button. **this feature won't
  work if you're on a new tab or a website where the URL starts with `chrome://`
  or `chrome-extension://`**"*. The panel documents exactly three parts:
  **Element Selector Input** ("you also can write a custom XPath or CSS Selector
  in this input"), **Attributes**, **Blocks** ("Execute a block to the selected
  element").
* Automa docs, *Condition builder* — <https://automa-docs-old.vercel.app/api-reference/condition-builder.html>
  Documents only **Value**, and under **Element**: Element Selector ("The CSS
  selector or XPath of the element"), Element Text, Element Visible, Element
  Invisible, Element Attribute Value.

### 1.1 What that means concretely

| Question | Automa | Us |
|---|---|---|
| Is there an in-page picker panel? | **Yes** — the floating panel in the Gmail screenshot | Yes (now) |
| Where does it run? | A **content script inside the user's own tab** | A **server-side Chromium** streamed to a `<canvas>` |
| How is it opened? | Extension popup → "Element selector"; or the crosshair on a block's selector input | Crosshair on any selector field |
| Can it open an arbitrary URL for you? | **No.** You must already be on the page; Automa cannot pick on `chrome://`, `chrome-extension://` or a new tab | **Yes** — the modal has a URL bar and navigates the server browser for you |
| Does hovering record? | Highlights on hover, commits on click / Space | Hover previews **and streams the payload**; click/Space locks |
| DOM walking? | Yes (the ↑/↓ arrows in the screenshot) | Yes (`__abPickStep`) |
| Attributes list? | Yes ("Attributes" tab) | Yes (capped at 12 attrs × 160 chars) |
| "Blocks" tab? | Yes — run a block against the selected element | **No, and deliberately not** — see § 2.3 |
| Match count / "is this unique?" | Not documented | Yes (`__abVerify`, the ✓ button) |

**The honest conclusion:** the *capability* is not novel — Automa, SelectorsHub,
Selenium IDE and Playwright's own codegen inspector all do a version of it. What
Automa **cannot** do is the thing the user actually asked for: *"a browser should
appear at the page/URL where we want to pick the selector."* Automa is bound to
the tab you are standing in. We stream a browser we own, so **we can navigate to
the URL on the user's behalf** — and the workflow usually already knows that URL
(its `goto` node). That is our advantage, and § 3.4 exploits it.

The mirror-image weakness is equally honest and must be written down: Automa
picks on the user's **logged-in** session, so it works on Gmail (as the
screenshot proves). Our server browser is a **fresh, anonymous context** — it
cannot see the user's Gmail. See § 6.1 (`AUTH-GAP`), the single most important
open item.

---

## 2. THE PERSPECTIVE ON IMAGES 1–2 (what to copy, what to refuse)

The user sent the Automa condition row "شاید یه دیدگاهی بده". Here is the
evaluation, measured against rule 0.9 and the disclosure work of HANDOFF 14.

### 2.1 Automa's single optgrouped dropdown vs our derived 3 kinds

Automa puts **one** dropdown in front of everything, grouped:

```
value   → Value · Code · Data exists
element → Element text · Element exists · Element not exists · Element visible ·
          Element visible in screen · Element hidden in screen · Element attribute value
```

**What is genuinely better about it:** it is *one* decision. The user picks
"Element text" and is done — no second thought about "which part do I read" and
no chance of an incoherent pair (e.g. `source: attribute` with a DOM-only
operator). It also reads as a sentence, which is very legible for a beginner.

**What is worse, and must not be copied:**

1. **It fuses two orthogonal axes into one enum, so the enum grows multiplicatively.**
   `element × {text, exists, visible, attribute}` is already 7 entries; add
   "value" and "html" as readable parts and it becomes unmaintainable. Our
   `kind → (source, operator)` split keeps it additive.
2. **`Element visible` vs `Element visible in screen` vs `Element hidden in screen`
   is an accretion artefact, not a design.** Three near-identical labels for
   CSS-visibility vs viewport-intersection. A beginner cannot guess which is
   which — a direct violation of the legibility rule ("if the developer's intent
   behind an option can't be guessed, the option is wrong"). If we ever need
   viewport checks, it is **one** operator plus an explicit *"only if scrolled
   into view"* toggle, not three enum members.
3. **The operator dropdown stays visible even when it is irrelevant.** In image 1
   "Element text / Equals / Value" is coherent, but pick "Element exists" and
   Automa still shows an operator and a value input that mean nothing. Our
   `operatorsForKind()` filter (HANDOFF 14) is strictly better and stays.
4. **The collapsed summary line ("element#text Equals Empty") is excellent and we
   should steal it** — it is the same idea as our collapsed condition row, but
   Automa renders the *machine* form (`element#text`). Ours must render the
   *human* form.

**Verdict:** keep our derived-kind model (zero migration, additive, filtered
operators). Adopt **one** thing from Automa's row: the **two buttons beside the
selector input** — crosshair (pick) *and* a second button that verifies the
selector. That second button is the "double-check" in image 1, and it is now
implemented as the ✓ inside our picker panel (§ 3.2). Adopt **one** label:
`"CSS selector or XPath"` — see § 3.5.

### 2.2 Image 3 (the Gmail panel) — what we took, item by item

| Automa panel element | Our equivalent | Note |
|---|---|---|
| Draggable floating panel + title | `.bvp-panel` + `#bvp-drag` | drag implemented |
| eye icon | `#bvp-ghost` → `.is-ghost` (opacity 0.22) | fades, does not close — the target underneath stays visible |
| close icon | `#bvp-close` / backdrop click / `Escape` | three ways out |
| "CSS Selector" mode dropdown | `#bvp-mode` (CSS / XPath) | switches which of the two computed strings is shown |
| list + gear icons | **refused** | undocumented in Automa's own docs; nothing behind them for us = decoration (rule 0.9) |
| computed selector field, copyable | `#bvp-sel` (editable) + `#bvp-copy` | editable on purpose: a hand-fix is the common case |
| ↑ / ↓ DOM walk | `#bvp-up` / `#bvp-down` → `pickStep` | disabled when there is no parent/child |
| Attributes / Blocks tabs | Attributes only | see § 2.3 |
| per-attribute copy button | **not yet** | see § 6.4 |
| "Click or press Space to select an element" footer | `.bvp-hint` (`bvp.hint`) | Space is wired page-side |

### 2.3 Why we refuse Automa's "Blocks" tab

Automa's picker can execute a block against the selected element. For us that
would mean running a pipeline step against a **throwaway anonymous session** that
is not the session the workflow will run in — so a green result in the picker
would not predict a green result in the run. That is worse than no feature:
it is a *misleading* feature. The equivalent value, delivered honestly, is the
**match count** (§ 3.2): it answers "will this selector find the right thing?"
without pretending to have run the workflow.

---

## 3. WHAT SHIPPED THIS SESSION

The crosshair was **dead** before this session: `pickerBtn` called
`window.BrowserView.requestPick(...)`, and `browser-view.js` exported only
`{ render, stop }`. Pressing it fell through to a toast. That is now closed
end-to-end.

### 3.1 `src/core/LiveBrowser.ts` — the page-injected picker, upgraded

* `PickResult` gained `k`, `attrs`, `count`, `hasParent`, `hasChild`; new
  `PickAttr`.
* **One** `exposeBinding('__abReportPick')` now routes three channels by `k`:
  `hover` → event `hover`, `verify` → event `verified`, anything else → `pick`.
  (One binding, not three: fewer page-side globals to leak.)
* `PICKER_SCRIPT` rewritten:
  * `attrsOf(el)` — max **12** attributes, values sliced to **160** chars
    (a Gmail node's `jslog` is ~2 KB and this travels on every mouse move).
  * `matchCount(sel)` — `document.evaluate` when the string starts with `/`,
    `(` or `..`, else `querySelectorAll`; returns **-1** for an invalid selector.
    This is deliberately the *same* sniffing Playwright's `locator()` does, so
    the count the panel shows is the count the run will see.
  * `onMove` → throttled `hover` reports (**80 ms** floor, plus a 400 ms
    re-report ceiling for the same element).
  * `onClick` → `locked = el` + `pick`. `onKey` → Space does the same.
  * `window.__abPickStep(dir)` — `'up'` = `parentElement`, `'down'` =
    `firstElementChild`; refuses to leave `HTML`; reports on the `pick` channel
    so **there is exactly one code path that produces a selector**.
  * `window.__abVerify(sel)` — counts, and flashes a green outline over up to
    **40** matches for 1.4 s.
  * `__abStopPicker` now nulls `__abPickStep` / `__abVerify` too.
* New session methods: `move(x, y)` (CDP `mouseMoved` — the picker's highlight is
  mousemove-driven and the client streams an image, not a cursor),
  `pickStep(dir)`, `verifySelector(sel)` (injects the script if the overlay is off).

### 3.2 `public/js/browser-view.js` — `BrowserView.requestPick(onPicked, opts)`

A modal (`.bvp-backdrop` → `.bvp-shell`) containing a URL bar, the `<canvas>`
page stream, and the floating `.bvp-panel`. It is a modal over **our** app, not
an injected panel, for a reason worth remembering: the page is a server-rendered
image, there is no page DOM here to inject into, and our CSP (`script-src 'self'`)
would forbid it anyway.

* `opts` = `{ value, mode: 'css'|'xpath', url }`. `value` seeds the field so the
  picker **refines** an existing selector; `url` seeds the URL bar.
* URL memory: `localStorage['abPickerUrl']` — pick twice from the same site and
  the second time it is already filled in.
* Auto-arms the picker on `ready` (`send({t:'picker', on:true})`) — the picker *is*
  the point of this modal, so making the user press a second button is friction.
* Canvas: throttled `move` (**70 ms**), `click`, `wheel`; Space forwards as a key.
* `paint(data, locked)` is the single render routine. `pickState.locked` stops
  hover from overwriting; `pickState.edited` stops **anything** from overwriting
  after the user types.
* `renderCount` → 4 states: `bvp.matchOne` (green) / `n bvp.matchMany` (amber) /
  `bvp.matchNone` (red) / `bvp.matchBad` (red).
* "Use this selector" → `onPicked(value)` then closes. Escape / backdrop / × cancel.
* `stop()` now also calls `closePick()`, so a route change cannot orphan the modal
  or its socket.
* `copyVal` was hoisted to module scope (the `render()` local duplicate was deleted).

**Note, not a bug:** `#bv-picker` on the standalone `#/browser` page renders with
`disabled` in the markup and is enabled by `setEnabled(true)` on `ready`. That is
correct — you cannot arm a picker before a page exists. HANDOFF 14's open
question "why is it disabled?" is hereby answered and closed.

### 3.3 `src/core/BrowserStreamServer.ts`

New inbound commands: `move`, `pickStep`, `verify`. Header comment updated to
list the full command set (it is the only place the protocol is written down).

### 3.4 `public/js/flow-editor.js` — the picker knows which page to open

`ndvContext()` now carries `pageUrl: firstLiteralUrl()`: the first `goto` node in
the graph whose `params.url` is a **literal** (no `{{ }}`). Expressions are
skipped on purpose — they are unresolvable before a run, and guessing would be
worse than asking. This is what turns the user's request from "type the URL every
time" into "press the crosshair and you are already on the right page".

### 3.5 `public/js/ndv-nodes.js` — the crosshair, and a rule-0.9 label fix

* `pickerBtn(onPicked, getOpts)` — `getOpts` is read at **click** time, so the
  seed is never stale.
* Click node: seeds `value: p.selector`, `mode` from `p.selectorType`, `url`.
* Condition row: seeds `value: row.selector`, and **sniffs** the dialect
  (`/^\s*(\/\/|\.\.|\()/` → `xpath`).
* **We did NOT add `selectorType` to the condition row**, and this is the correct
  rule-0.9 answer, not laziness: `ConditionEngine` calls
  `this.page.locator(selector)` directly (L115, L143, L220) and Playwright already
  sniffs a leading `//` as XPath. So *one field already accepts both* and a
  dropdown would be a control **no backend line reads**. What was genuinely wrong
  was the **label**: `cb.cssSelector` said "CSS Selector" and understated the
  backend. It now reads **"CSS selector or XPath"** — exactly Automa's wording,
  and the help text says so too. Rule 0.9 cuts both ways: fix the label, not the
  parameter list.

### 3.6 i18n / CSS / tests

* `tools/patch-picker-i18n.py` (one-shot, idempotent) added the 20-key `bvp.*`
  block after the `bv.expired` anchor in both dicts, and relabelled
  `cb.cssSelector` / `cb.cssSelectorHelp`. **fa 949 = en 949**, CR 0.
* `public/css/styles.css` — the `.bvp-*` block appended (backdrop, shell, bar,
  stage, panel, `.is-locked`, `.is-ghost`, attrs rows, count colours, and a
  `max-width: 720px` rule that turns the panel into a bottom sheet).
* `tests/unit/element-picker.test.ts` — **16 new tests** that pin the seams:
  crosshair → `requestPick`; every `send({t:...})` has a `case` in
  BrowserStreamServer; every `case '...'` the client handles is emitted by
  LiveBrowser; the page script really has hover/traversal/attrs/count; the caps
  exist; `bvp.*` keys are in both dicts; the condition label admits XPath and the
  `if`/`while` param list has no `selectorType`.
* `icons.test.ts` caught `BIC('close')` — `close` is an **alias** (`close: 'power'`),
  not a registry entry, and the test only accepts registry names. Changed to `x`.
  *(Worth knowing: aliases are not valid arguments to `Icons.svg`.)*

---

## 4. FILES TOUCHED THIS SESSION

| File | Change |
|---|---|
| `src/core/LiveBrowser.ts` | `PickAttr`/`PickResult`; 3-channel binding; rewritten `PICKER_SCRIPT`; `move`/`pickStep`/`verifySelector` |
| `src/core/BrowserStreamServer.ts` | `move`, `pickStep`, `verify` cases; protocol comment |
| `public/js/browser-view.js` | `requestPick` modal + panel; `copyVal` hoisted; `stop()` closes the modal; `BrowserView` exports `requestPick` |
| `public/js/flow-editor.js` | `pageUrl: firstLiteralUrl()` in `ndvContext`; `firstLiteralUrl()` |
| `public/js/ndv-nodes.js` | `pickerBtn(onPicked, getOpts)`; seeds at both call sites; `pageUrl` threaded into `conditionRow` |
| `public/css/styles.css` | `.bvp-*` block |
| `public/js/i18n.js` | +20 `bvp.*` per dict; `cb.cssSelector*` relabelled |
| `tools/patch-picker-i18n.py` | new, committed, idempotent |
| `tests/unit/element-picker.test.ts` | new, 16 tests |
| `docs/uiux/15-HANDOFF-element-picker-automa-research.md` | this file |
| `docs/uiux/14-HANDOFF-backend-ui-parity-condition-disclosure.md` | header marked SUPERSEDED |

---

## 5. VERIFICATION STATE AT SESSION END

```
npx tsc --noEmit                → silent
npx vitest run                  → 38 files / 816 tests passed   (was 37 / 800)
ls public/js/*.js | wc -l       → 18            (rule 0.5 holds)
grep -c $'\r' src/Routes/user.routes.ts → 1317  (rule 0.7 holds)
grep -rl $'\r' public/ | wc -l  → 0             (rule 0.7 holds)
grep -c $'\r' src/schemas.ts    → 0             (rule 0.7 holds)
i18n keys                       → fa 949 = en 949
```

**NOT done, and it matters:** the picker modal has **never been rendered**. No
`tools/ui-shot.js` screenshot, no live socket test. Everything above is
statically verified only. § 6.0 is therefore the first task of the next session.

---

## 6. WHAT IS LEFT — in this order

### 6.0 FIRST: render it, then drive it once (½ session)

1. `node tools/ui-preview-server.js &` (port 8788), then
   `UI_STEPS="ndv:if,ndv:#<id>" node tools/ui-shot.js ...` and add a step that
   clicks `.is-picker` so the modal actually paints. Check both `UI_LANG=en` and
   `UI_LANG=fa` (RTL: the panel uses `inset-inline-end`, so it must land on the
   *left* in fa — verify, do not assume).
2. Expect to fix: panel/canvas z-order, the `.bvp-shell` height when the canvas
   is 720 px tall inside a 96 vh shell, and the drag clamp (it currently uses the
   stage rect captured at `mousedown`, which is wrong after a resize).
3. Then a real end-to-end run against `http://localhost:8788` as the target URL
   (a local page, so no network flakiness): connect → hover → click → ↑ → ✓ →
   Use. Confirm `row.selector` actually changes in the graph JSON.
4. Known risk to look at first: `Input.dispatchMouseEvent{mouseMoved}` at 14 Hz
   plus a JPEG screencast on the same CDP session may starve frames. If it does,
   drop the client throttle to 120 ms rather than removing hover.

### 6.1 `AUTH-GAP` — the picker cannot see logged-in pages (**highest value**)

Automa's screenshot is Gmail *because* it runs in the user's own tab. Our server
context is anonymous, so every selector behind a login is unpickable — which is
most of the interesting ones. Options, in order of honesty:

* **(a)** Reuse the workflow's stored session/cookies for the picker session, if
  the project already persists them (**check `src/core/GlobalBrowser.ts` and any
  storage-state/cookie feature first — there is a `cookie` icon in the registry,
  so something exists**). This is the right answer if it exists.
* **(b)** Let the user log in *inside* the modal — the canvas already forwards
  clicks/typing, so this works today; it just needs saying out loud in the UI.
* **(c)** Hand the job to `extension/content/selector.js` (we already ship a
  browser extension with `ABSelector.cssPath/xPath`, tested by
  `tests/unit/extension-selector.test.ts`) and let the picker run in the user's
  real tab, Automa-style, when the extension is installed. **This is the only
  option that fully matches Automa.**
* Until one of these lands, the picker must **say** it opens a fresh anonymous
  browser. Do not let a user discover it by staring at a login wall.

### 6.2 Bring the two picker implementations to one

`browser-view.js` now has the old `render()` pick-card (CSS + XPath + copy + "add
step") **and** the new modal. The page-side script feeds both. Fold `render()`'s
card onto the same panel component so there is one picker UI, one set of strings,
one place to fix. Also: the standalone page never sends `move`, so hover does not
work there — folding fixes that for free.

### 6.3 The second button from Automa's image 1, on the field itself

Right now "verify" lives *inside* the modal. Automa also puts it **next to the
input in the node**, so you can check a hand-typed selector without opening the
picker. Add a second `iconBtn` beside the crosshair that opens the modal
pre-navigated and immediately fires `verify`. Cheap, and it is the single most
useful button for someone debugging a selector.

### 6.4 Panel polish (small, do after 6.0)

* Per-attribute copy button (Automa has it) — and clicking an attribute row
  should offer `[name="value"]` as a selector candidate, which is often better
  than our generated path.
* Show `tag` and the picked `text` in the panel head (`msg.tag` / `msg.text` are
  already on the wire and currently unused by the modal).
* `#1 Element` style header when traversing, so the user knows where they are.
* Keyboard: ↑/↓ arrows while the stage is focused should call `pickStep`.

### 6.5 Selector quality (`cssPath` is 6 levels of `:nth-of-type`)

`cssPath` caps at 6 ancestors and uses 2 classes + `:nth-of-type`, which is
brittle against re-renders. Now that the panel reports a **match count** we can
afford a smarter generator: prefer `[data-testid]`, `[name]`, `[aria-label]`,
then `[role]`, then fall back to the path — and pick the **shortest candidate
whose count is 1**. This is a self-contained, testable function; put it next to
`extension/content/selector.js` so the extension and the server share it (there
is already a test proving they agree — keep it that way).

### 6.6 Carried over from HANDOFF 14 § 4, still not started

* **§ 4.1 audits (rule 0.9), in order:** `click` (expect deletions among
  `stableForMs`, `human`, `force`, `modAlt/Ctrl/Shift`, `highlightElement`,
  `visibleOnly`, `multipleMatches`, offsets) → `switch` → the everyday nodes →
  the non-node screens.
* **§ 4.2 gaps:** **G5** run-info strip (`views.js#refreshRunInfo()` ~L1637 ←
  `RunPanel.getSummary()`; decide `#fe-statusbar` (~L1016, in markup but *not*
  passed to `FE.mount()`) vs `#fe-result`; must read *empty*, not zeroed, before
  the first run) · **G9** running glow · **G3** tab strip (re-measure the
  Condition NDV bands after this lands — they sit 24–44 px high without it) ·
  **G11** `#fe-result` · **G12** group/subflow · **G2** Online Services
  (disabled-with-reason, no invented providers).
* Condition NDV `chips: []` on the INPUT column is **not** a § 0.3 violation
  (decision recorded in 14 § 4.2); drive it from `nodeResults[nodeId].input`
  when that exists.

---

## 7. ANCHORS (verified this session)

| Thing | Where |
|---|---|
| Crosshair button | `public/js/ndv-nodes.js` `pickerBtn` ~L121 |
| Crosshair call sites | click node ~L338, condition row ~L709 |
| Picker modal | `public/js/browser-view.js` `requestPick` ~L320 |
| Modal markup | `pickerMarkup()` ~L343 |
| Modal teardown | `closePick()` ~L334, and `stop()` at EOF |
| Page-side picker script | `src/core/LiveBrowser.ts` `PICKER_SCRIPT` ~L60 |
| The one binding | `exposeBinding('__abReportPick')` in `start()` |
| WS protocol | `src/core/BrowserStreamServer.ts` header + `handleCommand()` |
| Condition engine's selector use | `src/core/ConditionEngine.ts` L115 / L143 / L220 (`page.locator(selector)`) |
| Click node's `selectorType` | `public/js/actions.js` L74 → consumed by `buildEngineSelector` in `src/pipeline.ts` L246 |
| Extension-side selector twin | `extension/content/selector.js` + `tests/unit/extension-selector.test.ts` |
| Picker seam tests | `tests/unit/element-picker.test.ts` |
| Automa element-selector doc | <https://automa-docs-old.vercel.app/guide/element-selector.html> |
| Automa condition-builder doc | <https://automa-docs-old.vercel.app/api-reference/condition-builder.html> |

---

## 8. LOOSE NOTES worth keeping (they cost a session each to rediscover)

1. `Icons.svg('close')` fails `icons.test.ts` — `close` is an **alias**. Only
   registry keys are legal arguments. `x`, `target`, `eye`, `copy`, `check`,
   `chevron-up`, `chevron-down`, `attribute`, `info` are all registry keys.
2. `grep -c $'\r' src/schemas.ts` returns 0 **and exits 1** — that exit code is
   not a failure, it is grep telling you the count was zero. Do not chain it with
   `&&` at the end of a verification command.
3. `page.evaluate(...)` runs through CDP and is **not** blocked by the target
   page's own CSP, which is why the injected picker works on hardened sites.
4. `in_list` / `not_in_list` need a real `Array`; the conversion lives **only** in
   `public/js/graph-serialize.js` (`splitListValue`). Do not add a second one.
5. `CONDITION_ONLY_PARAMS` in `graph-serialize.js` still lists `maxDepth` /
   `evaluateMode` **on purpose** — it is a strip list for one release, then delete.
6. The NDV can be opened without a pointer gesture:
   `FlowEditor.openNdv(id)` / `closeNdv()` / `ndvOpenFor()`, and
   `UI_STEPS="ndv:if"` in `tools/ui-shot.js`.
7. `tools/*.py` patchers must use `io.open(..., newline='')` or they will rewrite
   line endings and break rule 0.7.
