# HANDOFF 13 — NDV: reachability, the scroll contract, and the density pass

> **STATUS: CURRENT.** This file supersedes
> `12-HANDOFF-shell-parity-brand-mark-fa-980.md`, which supersedes
> `11-HANDOFF-labels-fit-prefs-render-compare.md`.
> Read § 0 first — it is the standing rule set — then § 5 for what to do next.

---

## 0. Standing rules (unchanged; obey these before anything else)

0.1 **Keep developing. Never ask the user questions.** Search the repo, decide,
and record the decision in this file. The only instruction the user gives is
"continue" (`ادامه بده`).

0.2 **Image beats prose.** `docs/uiux/*.webp` outranks every `.md` in this repo,
including this one. When a `.md` and a `.webp` disagree, the image wins and the
`.md` gets corrected. **Crop the WebP at 1:1 with `magick` and READ it** — see
§ 2.3 for why that turned out to matter more than anything else this session.

0.3 **Never ship fake-successful UI.** If the backend cannot deliver, the control
is disabled and carries the reason. No invented providers, no placeholder data
presented as real.

0.4 **Real counts only.** Every number in the UI is computed from the catalog or
the graph, never hardcoded from a mock.

0.5 **Do not add a new front-end JS file.** `tests/unit/icons.test.ts` pins
**exactly 18** files in `public/js/`. New code goes into an existing file. Dev
tooling goes in `tools/` (not counted); test files are not counted.

0.6 **i18n:** every key must exist in **both** `fa` and `en`, and **no English
value may sit in `fa`**. Persian compounds need ZWNJ (U+200C). Add keys with a
one-shot script in `tools/` (see `tools/patch-ndv-timeout-help.py`, written this
session) so `io.open(..., newline='')` protects the line endings.

0.7 **Line endings are pinned:** `public/**` is LF with **CR count 0**;
`src/Routes/user.routes.ts` is CRLF with **CR count exactly 1317**;
`src/schemas.ts` CR 0.

0.8 **Git flow:** commit → `git fetch origin main` → rebase → **squash to ONE
commit** (`git reset --soft HEAD~N && git commit -F /tmp/commitmsg.txt`) →
`git push -f origin genspark_ai_developer` → create/update the PR → **hand the
user the PR link**. Never put backticks inside `git commit -m`.

### The verification quartet (run before every commit)

```bash
cd /home/user/webapp
npx vitest run                              # expect 37 files / 794 tests
npx tsc --noEmit                            # must be silent
ls public/js/*.js | wc -l                   # must be 18
grep -c $'\r' src/Routes/user.routes.ts     # must be 1317
grep -rl $'\r' public/ | wc -l              # must be 0
```

### The render harness

```bash
node tools/ui-preview-server.js 8788 &      # static only; one expected 404 on #/workspace
UI_LANG=en UI_SEED=login-form UI_WAIT=1400 \
  node tools/ui-shot.js '#/editor' /tmp/render/x.png 1672x941 \
  'dbl:.flow-node:has-text("Click Element")'
```

* `UI_LANG=en|fa`, `UI_SEED=price-scrape|login-form|scheduled-screenshot`
  (`UI_SEED=list` prints the ids), `UI_WAIT=<ms>`.
* 5th CLI arg = comma-separated interaction steps: `.sel` click, `dbl:.sel`
  double-click, `key:Escape`. Playwright `:has-text("…")` works in them.
* Node cards carry **`data-node`, not `data-action`** — select them by text.
* The first `.flow-node` is `Start`, which correctly has **no** NDV.
* A probe that double-clicks twice will hang on the second attempt because the
  open modal intercepts pointer events. That is correct app behaviour.
* **Playwright probes must live inside the repo** — `require('playwright')` does
  not resolve from `/tmp`. Name them `probe-*.tmp.js` and **delete before
  committing** (both `probe980.tmp.js` and `probe-ndv.tmp.js` are gone).

---

## 1. What shipped in this commit (G7, phases B and C)

### 1.1 The NDV was completely unreachable — fixed

`selectNode()` called `renderNodes()` unconditionally. `renderNodes()` removes
every `.flow-node` and builds new elements, so a **single click on a card
destroyed the element the mouse had just pressed**. A `dblclick` event is only
dispatched when both clicks share one target, therefore the documented primary
gesture — *double-click a node card to open its NDV* — **could never fire, on the
first attempt or any attempt**. Measured: after one synthetic click,
`document.body.contains(card) === false`. The NDV was reachable **only** through
the right-click menu's `ndv.open` item, and `openNdv` is **not** exported on
`window.FlowEditor`, so there was no programmatic path either.

Fix: `applySelectionPaint()` in `public/js/flow-editor.js`, inserted immediately
after `renderNodes()`. It toggles the `selected` class in place with
`classList.toggle(cls, on)` (idempotent, so an unchanged card is genuinely
untouched and any in-flight gesture on it survives), refreshes
`renderSelectionTools()` (the group boundary + floating toolbar are also a
function of the selection, and `renderNodes` used to be the only thing that
refreshed them), and **returns `false`** when the DOM and `state.nodes` disagree
so callers that mutate the graph before selecting still get a real render.
`selectNode()` is now `if (!applySelectionPaint()) renderNodes();`.

Verified by probe: `1st dblclick (node NOT yet selected) → {"modal":true,
"designed":true}`.

### 1.2 The designed NDV had no height contract — fixed

`.ndv-body` was the only `overflow: auto` anywhere in the chain, so the single
grid row stretched to its tallest child (**1118 px** of centre sections) inside a
**757 px** body and the body became the ONE scroller for the whole modal. Four
consequences, all measured:

1. the INPUT / OUTPUT column heads, `Schema|Table|JSON` tabs, run selector and
   search fields scrolled away with the data instead of staying put;
2. `.aria-col-body` — which already declares `flex: 1 1 auto; min-height: 0;
   overflow: auto` — **never scrolled**, because its column was 1118 px tall,
   i.e. taller than its own content;
3. the OUTPUT status strip that the spec pins to *"the very bottom"* of the
   column sat ~300 px **below** the modal's bottom edge;
4. `Optional modifiers` (y=988) and `Behavior` (y=1076) were outside a modal
   ending at y=881 when it opened.

Fix (all in `public/css/styles.css`, scoped to `.ndv-modal.is-designed`):
`height: min(820px, 94vh)` (a real height, not `max-height` — the columns can
only place fixed heads and a pinned footer against a height that does not depend
on which node is open), `.ndv-body { overflow: hidden; display: flex; ...;
min-height: 0 }`, `.ndv` and `.ndv-cols` get `flex: 1 1 auto; min-height: 0`,
`.ndv-cols` gets `grid-template-rows: minmax(0, 1fr)`, and `.ndv-pane` becomes
the centre column's own scroller with `overflow: auto`.

> **The rule to remember:** a percentage height only survives if **every**
> flex/grid ancestor between the scroller and the fixed-height box opts out of
> the default `min-height: auto` (flex) / `auto` row (grid). And **never give
> `.ndv-body` an `overflow` back** — that reinstates the single outer scroller
> and silently disables all three inner ones.

Below the 3-column breakpoint (`max-width: 860px`) the columns stack, so the
scroll is handed back to the body and the modal sizes to its content again.

Verified after the fix: pane `client 679 / scrollH 790`, scrolling the **pane**
(not the modal) moves `Optional modifiers` / `Behavior` / `Continue on fail` into
view while `inputHead`, `outputHead`, `tabRow` and the pinned `strip` do **not**
move.

### 1.3 The density pass (this is where the WebP crop earned its keep)

Cropping `docs/uiux/ndv-click-element-final.webp` at 1:1
(`magick … -crop 570x830+550+130`) gave the design's real numbers:

| band | design | ours now |
|---|---|---|
| Selector | 164 | 165 |
| Click options | 104 | 105 |
| Selector options | 168 | 181 |
| Position offsets | 80 | 91 |
| Optional modifiers | 62 | 64 |
| Behavior | 84 | 94 |
| Continue on fail | 39 | 28 |
| **total centre content** | **701** | **728** |

Four structural mismatches the crop exposed, all now fixed:

1. **Sections are BANDS, not cards.** One continuous bordered stack: a single
   hairline *between* neighbours, **no gap**, no doubled borders, radius only on
   the two ends. We shipped six 10px-radius cards with an 8px gap — 5 gaps + 10
   border edges, and the `.ndv-pane` `gap: 10px` added another **60 px** on its
   own. `gap: 0` on the pane, `border-radius: 0` + `border-top: 0` +
   `margin-top: 0` on adjacent bands.
2. **`Click options` is a single 4-up row** (Click type · Mouse button · Click
   count · Delay before click), not the 2×2 block we shipped. New
   `.aria-sec-body.cols-4` + `.span-4`, stepping down to 2 columns at
   `max-width: 1240px` and 1 at `1000px`.
3. **Numerics packed among toggles are INLINE** — label left, control right, one
   ~26 px row, exactly like the toggles beside them, **not** label-above-control.
   Stacking made `Timeout (ms)`, `Stable for (ms)` and `Offset X/Y (px)` 48 px
   rows instead of 26 and was the single largest source of the overflow. New
   `fieldCell(label, control, help, span, { inline: true, info })` in
   `ndv-ui.js` + `.aria-cell.is-inline`.
4. **Two distinct control heights.** `--ndv-ctl-h` (30px) stays for the
   prominent Selector fields; inline cells use the new `--ndv-row-h` (26px),
   which is what the crop shows. The written spec's "input height 32–36 px" is
   **wrong for these rows** — rule § 0.2 applies.

Also: **`Continue on fail` moved out of the Behavior card** into a bare
`.aria-footrow` closing the column, which is both what the preview shows and the
honest place for it — it is *not* a click param, it writes to
`node.errorPolicy` (read by `graph-serialize.js`) and the Error tab edits the
same source of truth.

### 1.4 The graph-validation band is now node-scoped

`appendValidation(box, onlyNodeId)`. The designed NDV passes `node.id`, which
filters to that node's errors/warnings and **suppresses the all-clear row**. The
locked crop has no graph-status band inside the modal, and a whole-**graph**
verdict is not information about the node being edited — it was costing 36 px of
the centre column's scroll height to say "Graph is valid" in a single-node
editor. Problems that belong to this node still surface. The generic
(undesigned) NDV is unchanged.

### 1.5 Guard tests

`tests/unit/editor-shell.test.ts` gained a top-level
`describe('G7 — Node Detail View (NDV)')` with **11 tests** and a new
`designedRule(sel)` CSS helper that merges the declarations of every
`.ndv-modal.is-designed` rule matching a selector (text-merging, not a real
cascade — the contract only needs "is this stated somewhere for the designed
NDV", so it survives a reorder). File now has **65** tests; suite **794**.

---

## 2. Traps and findings worth carrying forward

**2.1 `dblclick` needs one shared target.** Any handler that re-renders on
`click` swallows `dblclick` entirely. If a double-click gesture "doesn't work",
check first whether the element still exists after the first click.

**2.2 "Rendered but unreachable" is a measurement problem, not a reading
problem.** `document.elementsFromPoint(x, y)` solved the 980 px empty-canvas bug
last session; measuring the whole ancestor chain (`clientHeight`, `scrollHeight`,
`overflowY`, `minHeight`, `flex`, `display`) solved this one. **Write the probe;
do not reason about the CSS.**

**2.3 An earlier claim in this repo's history was too strong and is corrected
here:** the tail NDV sections were *not* strictly unreachable before the fix —
`.ndv-body` did scroll (`scrollH 1155 / client 757`). They were reachable only by
scrolling the entire modal, which broke the three-column design. Say what was
measured, not what sounds worse.

**2.4 The unexplained 36 px.** `.ndv-body` has **two** children: `.ndv` and the
`.fe-validation` strip. Chasing a "missing" 36 px in `.ndv`'s height was wasted
effort until the children were listed. **List children before blaming flexbox.**

**2.5 CSS absolute-positioning trap (from last session, still true).** An
absolutely positioned box with **all four insets resolved STRETCHES**. Dock by
exactly TWO insets (one block, one inline) and pin the opposing pair to `auto`.
The base `.fe-zoom-ctrl, .fe-canvas-toolbar` rule states this as a CONTRACT
comment; any override MUST reset the pair it is not using.

**2.6 CSS token trap.** `--text-mute`, `--accent`, `--surface-2`,
`--text-disabled` **do not exist**. Valid: `--bg-elev`, `--bg-elev-2`, `--text`,
`--text-dim`, `--text-faint`, `--primary`, `--primary-soft`, `--success`,
`--danger`, `--warn`, `--border`, `--border-strong`, `--info`, `--surface-0`,
`--radius-sm`. NDV-local: `--ndv-ctl-h`, `--ndv-row-h`, `--ndv-gap`,
`--ndv-sec-bg`, `--ndv-sec-radius`, `--ndv-label`, `--ndv-val`, `--ndv-mono`,
`--ndv-edge`, `--cat-color`.

**2.7 Mutation-testing a cascade bug requires reproducing the cascade
ORDERING**, not just one declaration.

**2.8 Sticky prefs.** ONE namespaced blob `localStorage['ab_ui_prefs']` via
`AppUtil.pref(key, fallback)` / `AppUtil.setPref(key, value)`; keys
`fePaletteCollapsed`, `feOutlineOpen`, `feDockOpen`. `app.js` is the LAST script
tag, so `flow-editor.js` / `run-panel.js` must read `window.AppUtil` at CALL
time. Restoring a stored preference must never be recorded as a fresh user
choice — the `remember !== false` convention (see `setOutlineOpen(open,
remember)`).

**2.9 Panel-aware fit.** `canvasInsets(rect)` charges each overlay to the edge
costing the LEAST canvas (never nearest-edge — the 460×197 minimap would collapse
the fit to the 0.4 floor); 0.7 clamp; zoom floor 0.4 / ceiling 2. The body-level
fixed `#run-panel` dock is charged separately from its live rect.

---

## 3. Anchors (line numbers drift; grep the names)

**`public/js/flow-editor.js`** (~187 KB)
`nodeResults` L134 · `renderNode` ~840 (`data-node`, `selected` class) ·
card `click` ~1054 / `dblclick` ~1061 (`openNdv`) / `contextmenu` ~1067 ·
`ndv.open` menu item ~1268 · `renderNodes()` ~1329 · **`applySelectionPaint()`
right after it** · `appendValidation(box, onlyNodeId)` ~1418 · `ndvOpen` /
`ndvRoot()` / `closeNdv()` / `openNdv(id)` ~1749 · `statusBadgeLabel`,
`ndvSubtitle`, `ndvTitle`, `ndvEdgeTone` · **`renderInspector()` ~1897** (builds
`.ndv-backdrop` → `.ndv-modal`, adds `is-designed` when
`window.NdvModel.isDesigned(node.action) && window.NdvNodes && window.NdvUI`,
sets `--ndv-edge`, builds `.ndv-head`, then INPUT / centre / OUTPUT) ·
`selectNode` ~2320 · live re-render `if (ndvOpen === nodeId) renderInspector()`
~4375.

**`public/js/ndv-ui.js`** — `el` L34 · `section(title, cols)` L98 ·
`fieldCell(label, control, help, span, opts)` L107 · `withInfo` · `selectCell` ·
`numberCell` L156 (`.aria-input.aria-input-num`) · `toggle` · `toggleRow(label,
checked, onChange, {info, help})` L187 · `checkbox` L202 · `segmented` ·
`runSelector` · `searchField` · `dataTree` / `treeFrom` · `outputEmpty` L365 ·
`statusStrip` L379.

**`public/js/ndv-nodes.js`** — `renderInput` ~140 · `renderOutput` ~235 (ends by
appending `statusStrip`) · **`renderClick` ~296** (7 sections) ·
`renderCondition` ~430 (shared by `if` and `while`).

**`public/js/ndv-model.js`** — `isDesigned(action)`, `normalizeClickParams`,
`clickPayloadPreview`, `readGroups`. **Not yet read in detail.**

**`public/css/styles.css`** (~4900 lines) — `.ndv-cols` / `.ndv-col` base ~1532 ·
`.ndv-modal` ~1863 · `.ndv-body` ~1942 · **`.ndv-modal.is-designed` block
~2019–2130** (tokens, width+height, the fixed-height/scroll contract, the band
stack) · `.ndv-tabs` / `.ndv-pane` ~2103 · aria primitives ~2169+ (`.aria-seg`,
`.aria-runsel`, `.aria-search`, `.aria-col-body`, `.aria-sec`, `.aria-cell`,
`.aria-cell.is-inline`, `.aria-select/.aria-input`, `.aria-toggle-row`,
`.aria-footrow`, `.aria-checkrow`).

**`public/index.html`** — script order L188–206: icons, actions, templates,
i18n, api, expression, graph-serialize, **ndv-model (197), ndv-ui (198),
ndv-nodes (199), flow-editor (200)**, live, run-state, run-panel, browser-view,
views, app.

**`public/js/views.js`** — `renderEditor()` ~886 · `#fe-wftabs` ~920 ·
`#fe-statusbar` ~1016 (**present in the markup but NOT passed to `FE.mount()` —
nothing populates it**) · `RunPanel.mount()` ~1043 · `refreshWfLabel()` ~1095 ·
`renderTabs()` ~1475 · `setOutlineOpen()` ~1615 · **`refreshRunInfo()` ~1637 —
still unpopulated, this is G5.**

**`public/js/run-panel.js`** — `DOCK_PREF='feDockOpen'`, `open(remember)`,
`close(remember)`, `AL_TABS`, `showTab()`, **`getSummary()` — the intended G5
source** · `onUpdate()`.

---

## 4. Locked design references

* `docs/uiux/state-empty-canvas.webp` (1672×941) — authoritative for the editor
  shell.
* `docs/uiux/ndv-click-element-final.webp` (1672×941) + `.md` (250 lines) —
  authoritative for the Click Element NDV. **Crop it, do not trust the prose.**
  Tokens: canvas `#0B0F14`–`#0E1218`; surfaces `#0F141B` / `#11161E` / `#151C25`;
  border `rgba(255,255,255,.08)`; primary `#FF8A1F`–`#FF9A1F`; info `#2BA6FF`;
  success `#2ECC71`; danger `#E45555`; text `#E8EDF4` / `#97A2B3` / `#5E6876`.
  Spacing 4/8/12/16/20/24; card radius 10–12; modal radius 14–16; node card
  48–58. Modal ≈ 72–76 % viewport width, almost full canvas height.
* `docs/uiux/ndv-condition-final.webp` + `.md` (274 lines) — the Condition
  Builder, shared by `if` and `while`. **NOT yet rendered or compared.**
* `docs/uiux/shell-editor-click-ndv.md` (257 lines) — **not yet read.**
* `HANDOFF_NEXT_SESSION.md` (331 lines) — the original NDV design brief.

---

## 5. WHAT IS LEFT — do these in this order

For **every** item: render before and after with `tools/ui-shot.js`, compare
against the WebP (crop it 1:1), add or update a guard test, run the § 0
verification quartet, commit, and update **this** file.

### 5.1 Finish G7 (small residual, ~2 hours)

* **~50 px of residual scroll in the centre pane.** Content 728 in a 679 pane.
  The deltas are in the table in § 1.3: `Selector options` +13, `Position
  offsets` +11, `Behavior` +10. Likely levers, in order: `Behavior`'s two toggle
  rows are 48 px because each carries a `help` line — the crop shows row+help at
  ~45; the `.aria-sec` title band is ~25 px against the crop's ~28 including its
  own padding, so trim `padding`/`margin-bottom` rather than font size; and the
  `Click options` 4-up cells are 59 px tall because `Delay before click (ms)`
  wraps to two lines at 1/4 of 558 px (the crop's label is ~9.5 px, ours is
  10.5). **This is cosmetic — the pane scrolls correctly, so it is not a
  blocker.**
* **The INPUT column's chip row is missing.** The locked design shows
  `Drag values into parameters.` with `response.status`, `data.user`,
  `statusCode`, `token`, `+`. Ours is `chips: []`. This is only meaningful once
  real input data exists, so its absence does **not** violate § 0.3 — but decide
  explicitly and record the decision. If you build it, drive it from
  `nodeResults[nodeId].input`, never from a mock (§ 0.4).
* **Render and compare the Condition NDV** (`ndv-condition-final.webp`,
  `renderCondition` ~430, shared by `if` and `while`). It has never been looked
  at. Use `UI_SEED` with a template containing an `if`, or add one via the
  palette in the interaction steps.
* **Consider exporting `openNdv`** on `window.FlowEditor` so probes and tests
  have a programmatic path that does not depend on a gesture.

### 5.2 G5 — the run-info strip

`views.js#refreshRunInfo()` (~1637) exists and is **never populated**.
`RunPanel.getSummary()` in `run-panel.js` is the intended source. Real counts
only (§ 0.4); when there is no run yet the strip must read as empty, not as a
zeroed fake success (§ 0.3). Note that `#fe-statusbar` (views.js ~1016) is in the
markup but is not passed to `FE.mount()` — decide whether the run-info strip
lives there or in `#fe-result`, and wire whichever you choose.

### 5.3 G9 — running glow on node cards

`renderNode` already emits `status-<status>`. Add the pulsing edge the previews
show for a running node. Pure CSS; keep it off when `prefers-reduced-motion`.

### 5.4 G3 — workflow tab strip refinement

`#fe-wftabs` (views.js ~920), `renderTabs()` ~1475. Compare against
`state-empty-canvas.webp`'s top bar.

### 5.5 G11 — `#fe-result` placement in the full-bleed shell

### 5.6 G12 — group / convert-to-subflow, and per-node Run on branch nodes

`runNodeBlockedReason()` already gates the NDV's Run button; branch nodes must
stay **disabled with a reason** (§ 0.3), never silently no-op.

### 5.7 G2 — Online Services sub-items

The locked palette shows Google Sheets / Drive / Gmail / Slack / Discord /
Telegram / Airtable / Notion. **There are no such integrations.** They must be
either omitted or rendered disabled-with-reason. **Do not invent providers**
(§ 0.3). The count badge must be computed (§ 0.4).

---

## 6. State at the time of writing

* Branch `genspark_ai_developer`, rebased on `origin/main`. Repo
  `jalil-ahmadi2/plyr`. PR **#13**.
* **794 tests / 37 files pass**, `tsc --noEmit` silent, `public/js` = 18 files,
  `user.routes.ts` CR = 1317, `public/` CR = 0.
* Files touched by this commit: `public/css/styles.css`,
  `public/js/flow-editor.js`, `public/js/ndv-ui.js`, `public/js/ndv-nodes.js`,
  `public/js/i18n.js`, `tests/unit/editor-shell.test.ts`,
  `tools/patch-ndv-timeout-help.py` (new), this file (new),
  `12-HANDOFF-*.md` (marked superseded).
* No throwaway probes remain in the tree.
* Known cosmetic nit: the `G10 — the 980 px narrow-viewport render pass` and
  `G7 — Node Detail View (NDV)` describes are both top-level in
  `editor-shell.test.ts`, which is fine, but the file's original top-level
  describe now closes before them. Harmless; tidy it if you touch the file.
