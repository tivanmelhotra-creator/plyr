# 04 — HANDOFF: Editor Shell (top bar) · OUTLINE panel · ACTIVITY LOG

> **Written:** 2026-07-28 · **Branch:** `genspark_ai_developer` · **Base:** `origin/main` @ `e270a0c`
> **Audience:** the next session, which starts with **zero chat history**. Everything you
> need is in this file plus the files it points at. Read this file top-to-bottom BEFORE
> touching code.

---

## 0. TL;DR — what state is the repo in?

> ### ✅ UPDATE 2026-07-29 — ITEMS A–E ARE ALL DONE
>
> The table below is the **original 2026-07-28** plan and is kept for its
> file/line anchors and rationale. Every UI item in it (A, B, C, D, E) has since
> been implemented, plus a canvas-chrome relocation that the refreshed images
> forced. Current truth:
>
> | Item | State |
> | --- | --- |
> | A — top bar | ✅ done (`views.js`) |
> | B — Export ▾ / Save ▾ | ✅ done (`views.js`) |
> | C — OUTLINE panel | ✅ done — **START edge**, not the end edge |
> | D — blocks palette | ✅ done (`flow-editor.js`) |
> | E — ACTIVITY LOG | ✅ done — **FOUR** tabs, not three |
> | — canvas chrome | ✅ relocated to the **TOP-END** + labelled pill row |
>
> **Two corrections in this very file are now WRONG. Do not implement them:**
> § 6.1 says the ACTIVITY LOG has three tabs — the refreshed
> `state-empty-canvas.webp` shows **four** (`Runs · Execution · Variables ·
> Logs`, opening on `Execution`), and the image wins. § 5 implies the OUTLINE is
> an end-edge overlay — it is a full-height rail on the **START edge** that
> occupies real canvas width (`--fe-ol-w`).
>
> Remaining work, the decisions taken, and the verification state are in
> **`05-HANDOFF-palette-docs-followups.md`** — read that first.

The work is split into a **substrate layer** (done, committed, tested) and a
**UI layer** (not started). The substrate exists precisely so the UI layer is a
rendering exercise with no algorithm design left in it.

| Layer | Status |
| --- | --- |
| `graph-serialize.js` → `outlineTree(graph)` — numbered nested outline rows | ✅ **DONE** |
| `flow-editor.js` → undo/redo snapshot stack | ✅ **DONE** |
| `flow-editor.js` → `onChange()` subscription for the shell | ✅ **DONE** |
| `flow-editor.js` → `outline() / nodeLabel() / getSelected() / revealNode()` | ✅ **DONE** |
| `flow-editor.js` → `centerOnNode()` viewport helper | ✅ **DONE** |
| Item A — top bar UI (brand · Home · Workspace ▾ · tab strip · undo/redo · Stop · bell · settings · avatar) | ❌ **TODO** |
| Item B — `Export ▾` / `Save ▾` split menus | ❌ **TODO** |
| Item C — OUTLINE panel UI | ❌ **TODO** (backend done) |
| Item D — left sidebar upgrade (search, favorites, counts, footer sections) | ❌ **TODO** |
| Item E — ACTIVITY LOG (3 tabs, auto-scroll, 6-col table) | ❌ **TODO** |
| Items H / I / J / N | ❌ **TODO** (see §9) |

**Verification state at the time of writing:**
- `npx vitest run` → **34 files / 614 tests passed** (run AFTER the substrate edits).
- `for f in public/js/*.js; do node --check "$f"; done` → all clean.
- `npx tsc --noEmit` → **not run this session** (substrate touched only front-end JS,
  which is not type-checked, but run it before you open the next PR anyway).

---

## 1. The one rule that overrides everything

The shipped product must match the locked reference designs in `docs/uiux/`
(8 `.webp` images + 8 paired `.md` specs).

> **Where the written spec and the image disagree, THE IMAGE WINS.**
> This is not a preference — it is test-locked (`docs/uiux/workspace-overview.md` §3D,
> and the card-order assertion in `tests/unit/workspace-ui.test.ts`).

The user's standing instruction, verbatim:

> «برای محقق شدن این امر هر کاری نیازه رو شروع کن به انجام دادن و توسعه رو ادامه بده.
> اگر سوالی هم پیش اومد از من نپرس خودت سرچ کن پیدا کن»
> — *do whatever is needed, keep developing, and **do not ask questions** — search and
> decide yourself.*

And, from the message that opened this session:

> «توسعه رو ادامه بدع فقط حتما به تصاویر ui نگاه بنداز که به بی راهه سمت نگیریم»
> — *continue development, but **always look at the UI images** so we don't drift.*

**So: your first action in the next session is to LOOK AT THE IMAGES.** Do not code from
this document's prose alone. Recipe:

```bash
cd /home/user/webapp
# The lite JPGs are small enough to read directly with the image-reading tool:
#   docs/uiux/lite/shell-editor-click-ndv.jpg     <- the editor shell (items A, C, E)
#   docs/uiux/lite/shell-add-node-palette.jpg     <- items D, H
#   docs/uiux/lite/state-empty-canvas.jpg         <- empty-canvas state
#   docs/uiux/lite/workspace-overview.jpg         <- reference for the ACTIVITY LOG table
# For detail work, crop the FULL-RES .webp (the lite JPGs lose small text):
python3 - <<'PY'
from PIL import Image
im = Image.open('docs/uiux/shell-editor-click-ndv.webp')
print('full size', im.size)          # was 3024x1730 at the time of writing
im.crop((0, 0, im.width, 60)).resize((im.width, 60)).save('/tmp/topbar.png')
im.crop((0, 120, 480, 1300)).save('/tmp/outline.png')
im.crop((470, 1180, 2560, 1730)).save('/tmp/activity.png')
PY
```
Then read `/tmp/topbar.png`, `/tmp/outline.png`, `/tmp/activity.png` with the image tool.
(`/tmp` is fine for throwaway crops — never commit them.)

---

## 2. What I already built (do NOT rebuild it)

### 2.1 `public/js/graph-serialize.js` — `outlineTree(graph)`

DOM-free, therefore unit-testable, and it is the **single** numbering implementation.
Exported as `window.GraphSerialize.outlineTree` alongside the new
`OUTLINE_MAX_ROWS = 2000` cycle guard.

**Row shape:**
```js
{ nodeId, action, port, num, depth, kind }
// kind: 'node' — an actual graph node row
// kind: 'port' — a branch-port header row (then/else/case:<v>/body/try/catch/finally)
// num:  '1' | '2' | '3.1' | '3.1.1' …   (depth === num.split('.').length - 1)
// port: '' for kind==='node', the port id for kind==='port'
```

**Semantics, all deliberate:**
- Walk starts at `start` / port `next`.
- A node continues via `done` when `DONE_PORT[action]` (`loop`, `foreach`, `while`),
  otherwise via `next`.
- Branch ports other than `next` become their own `kind:'port'` row, then the walk
  recurses INTO that port with the port row's number as the prefix.
- **An empty port emits no row** — the reference image shows no dangling `[else]`
  headers for unconnected ports.
- `switch` adds its dynamic `case:<v>` ports by scanning `edgesFrom()`.
- `seen{}` + `guard` + `OUTLINE_MAX_ROWS` make a cyclic graph terminate instead of
  hanging the browser.

**Verified against the image:** the reference outline's numbering
(`4 Condition → 4.1 Check Login Status → 4.1.1 True → 4.1.1.1 Extract Data`) is
reproduced exactly by this function. That check is the reason the function exists in
`graph-serialize.js` and not inside the view.

### 2.2 `public/js/flow-editor.js` — undo/redo

```js
var HISTORY_LIMIT = 60;
var undoStack = [], redoStack = [];
var historySuspended = false;
```

Why a **snapshot** stack and not a command stack: every mutation path in this editor
(`addNode`, `connect`, `removeNode`, `removeSelection`, `pasteClipboard`, edge-click
delete, `autoLayout`, node drag, NDV field commit) would otherwise need a hand-written
inverse, and any one of them getting the inverse subtly wrong corrupts the graph
silently. A snapshot is the **same JSON `serialize()` that `saveLocal()` already
persists**, so undo can never restore a shape the editor cannot load.

Public API added:
```js
undo, redo, canUndo, canRedo,      // history
onChange(fn) -> unsubscribe,       // fires after every renderAll() / param commit
outline(),                         // -> outlineTree(state)
nodeLabel(nodeId),                 // same label the node card shows
getSelected(),                     // -> nodeId | null
revealNode(nodeId),                // select + centerOnNode; returns bool
```

Invariants you must not break:
- `pushHistory()` is called **BEFORE** mutating, never after.
- Identical consecutive snapshots are collapsed → no per-keystroke undo spam.
- NDV field commit only pushes when the value actually **differs**
  (`if (node.params[f.k] !== v) pushHistory();`).
- Node drag stores `snapshot: serialize(), snapshotPushed: false` on mousedown and
  commits it on the **first real movement** in mousemove → exactly one undo per drag,
  not one per mouse event.
- `renderAll()` ends with `emitChange()`; `undo()`/`redo()` do
  `if (dom) renderAll(); else emitChange();` so the shell is notified **exactly once**.
- History is cleared whenever the document changes identity (`reset`, `loadLocal`,
  `openWorkflow`) — undoing across two different workflows would paste one workflow's
  nodes into another.
- `unmount()` sets `chromeListeners = []` so a torn-down view cannot leak a closure
  over dead DOM.

### 2.3 `public/js/flow-editor.js` — `centerOnNode(nodeId)`

Added right after `zoomBy()` (~line 484). **Pans only, never zooms** — clicking an
outline row must not change the user's zoom level.

```js
function centerOnNode(nodeId) {
  if (!dom || !state || !state.nodes[nodeId]) return false;
  var n = state.nodes[nodeId];
  var rect = dom.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;   // hidden canvas: nothing to do
  var s = state.view.scale || 1;
  var cx = n.x + nodeW() / 2;
  var cy = n.y + nodeH(n) / 2;
  state.view.x = rect.width / 2 - cx * s;
  state.view.y = rect.height / 2 - cy * s;
  applyViewTransform();
  return true;
}
```

---

## 3. Item A — the top bar (NEXT TASK, start here)

### 3.1 What the image shows, left → right

```
[◉ Aria Automate]  [⛶ Home]  [▣ Workspace ▾]  │ ( Login Flow ● ) ( Payment Flow ) ( Instagram Bot ) ( Scraper ) ( + New Workflow ) │  ⟲ ⟳ │ [⤓ Export ▾] [▤ Save ▾] [■ Stop] 🔔 ⚙ (avatar)
```

Measured / observed details from the crop — these are the acceptance criteria:

- **Brand**: round orange mark + `Aria Automate` in **bold white**. Existing
  `.fe-brand` + `.fe-brand-mark` already render this; keep them.
- **`Home`** and **`Workspace ▾`**: ghost items with a leading 15px icon, `--text-dim`
  label. `Workspace` carries a `chevron-down`. These are **navigation**, so they must
  drive the real router (`location.hash = '#/'` and `'#/workspace'`), not fake buttons.
- **Workflow tab strip**: the active tab (`Login Flow`) has a **lighter surface,
  a 1px border, a white label, and a solid orange dot** after the text. Inactive tabs
  are label-only on the bar background, `--text-dim`, no border. Last chip is
  `+ New Workflow` with a `plus` icon.
- **undo / redo**: a pair of ghost icon buttons (`rotate-ccw`, `rotate-cw`). In the
  image **redo is visibly dimmer than undo** — i.e. they reflect real
  `canUndo()`/`canRedo()` state. Wire them to `FE.undo()`/`FE.redo()` and refresh
  their `disabled` attribute from `FE.onChange()`.
- **`Export ▾`** and **`Save ▾`**: bordered ghost buttons with a leading icon and a
  trailing chevron → split menus (item B, §4).
- **`Stop`**: **solid red** (`--danger` / `#E45555`), white label, `square`/`stop-circle`
  icon. It is the only filled button in the bar in this screenshot **because a run is
  in progress**. When idle it must be the primary orange **Run/Test Workflow** button
  (that is what `state-empty-canvas.webp` shows). So: one slot, two states, driven by
  whether `RunPanel` has a live job.
- **bell / settings / avatar**: ghost icon buttons + a 26–28px round avatar with a
  small green presence dot at its bottom-right.

Height is compact (spec §2: *"Top bar height is compact; it never dominates the
canvas"*). Current `.fe-topbar` min-height is 52px — that is right; do not grow it.
Put the tab strip in a horizontally-scrollable flex row (`overflow-x:auto`,
`scrollbar-width:none`) so many workflows never wrap the bar to two lines.

### 3.2 Where the code goes

`public/js/views.js` → `renderEditor(root)` (starts ~line 886). Current markup:

```
.fe-shell
  .fe-topbar        <- REPLACE THIS. brand + '/' + #fe-wf-label + #fe-wf-badge
                       + .fe-topbar-actions[ #fe-from-run #fe-load #fe-json
                         #fe-clear #fe-save #fe-save-server #fe-run ]
  .fe-layout ( .fe-palette#fe-palette | .fe-canvas#fe-canvas[ svg#fe-svg + #fe-world ]
             | aside.fe-inspector[ #fe-inspector ] )
  .fe-statusbar#fe-statusbar
  .muted.small.fe-hint
  #fe-result
```

**Critical: the seven existing buttons all have live listeners further down
`renderEditor` (`#fe-save-server` ~line 998, then `#fe-save`, `#fe-load`, `#fe-clear`,
`#fe-from-run`, `#fe-json`, `#fe-run`).** Those listeners use
`root.querySelector('#id').addEventListener(...)` with **no null guard** — if you
delete an id from the markup, `renderEditor` throws and the whole editor view goes
blank. So either:
- keep every id present (move the low-traffic ones into the `Export ▾` / `Save ▾`
  menus, which is exactly what item B wants), **or**
- add null guards at each listener site.

Recommended: fold them in as follows, which satisfies A and B at once and loses no
functionality:
- `#fe-json` → `Export ▾ → JSON`
- `#fe-from-run` → `Export ▾ → Import from run form` (or keep as a small ghost icon)
- `#fe-save` (localStorage) → `Save ▾ → Save Changes`
- `#fe-save-server` → `Save ▾ → Save As New Version`
- `#fe-clear` → node context/canvas menu or `Save ▾` footer; keep the id alive
- `#fe-run` → the Run/Stop slot
- `#fe-load` → `Save ▾ → Version History` entry point (keeps the id alive)

### 3.3 Helpers already available inside `renderEditor` — reuse, don't rewrite

`IC(name, size)` (icon), `t(key)` (i18n), `esc()`, `effectiveUserId()`, `U().toast()`,
`statusCell()`, `refreshStatusBar()`, `refreshWfLabel()`, `fill()`, `fmtRel()`,
`track()`. `pendingWorkflowToOpen` is the hand-off from the Workspace view.

### 3.4 The tab strip's data source

Do **not** hardcode `Login Flow / Payment Flow / Instagram Bot / Scraper` — those are
the mock names in the reference image. Real source:

```js
API.listWorkflows(effectiveUserId())   // public/js/api.js line 171
```
Render the returned workflows as tabs, mark the one from
`FE.getCurrentWorkflow()` active, and on click reuse the same path the Workspace view
uses to open a workflow (`FE.openWorkflow(wf, wf.steps || [])` + `refreshWfLabel()`).
`+ New Workflow` → `FE.reset()` + clear the current-workflow identity.

If there is no API key / user id, render just the current draft tab. **Never render a
fake list** — that is the trap `docs/uiux/README.md` calls out (real values, never
faked placeholders).

---

## 4. Item B — `Export ▾` and `Save ▾` split menus

Menu contents are locked by the spec + image:

**Export ▾**: `JSON` · `Template` · `PDF` · `Share Link` · `Publish`
**Save ▾**: `Save Changes` · `Save As New Version` · `Version History` · `Auto Save` (toggle)

Rules:
- Anything not yet implementable on the backend must be **visibly disabled** with a
  tooltip, not silently inert, and not fake-successful. (`PDF`, `Publish` and
  `Share Link` have no backend today — disable them.)
- There is already a menu idiom in this codebase — the Workspace per-row kebab
  (`WS_ROW_MENU` + its open/close/outside-click/Escape handling in `views.js`) and
  `#launcher-menu` in `app.js` (`markLauncherCurrent`). **Copy that idiom** so
  keyboard/Escape/outside-click behaviour is consistent; do not invent a third
  dropdown implementation.
- CSP: `script-src 'self'`, **no inline handlers**. Every menu item gets an
  `addEventListener`.

---

## 5. Item C — the OUTLINE panel (backend is DONE)

### 5.1 What the image shows

A panel titled **`OUTLINE`** (uppercase, letter-spaced, white) with an `✕` at the far
right, above a nested tree. Per row:

- a **number gutter on the far left** — the top-level number is repeated **twice**:
  once dim/grey in a left rail, once **coloured by category** (`1` violet for
  Trigger, `2` blue for Initialize, `3` orange for Authentication, `4` green for
  Condition, `5` green for Cleanup). Child rows show only the dotted number
  (`4.1.1.2`) in `--text-dim`.
- **orange indent rails** — an L-shaped `└` connector per child, vertical rails
  running down through the group.
- a small **category-coloured action icon** in a rounded tinted square.
- the **label**: group/port rows are white, node rows are `--text-dim`.
- the **selected row** (`4.1.1 True` in the image) is **orange and bold**, with a
  chevron marker; branch-port rows are collapsible (`⌄`).

### 5.2 How to build it

```js
var rows = FE.outline();      // [{ nodeId, action, port, num, depth, kind }]
```
- `kind:'node'` → label = `FE.nodeLabel(row.nodeId)`; icon = the action's icon;
  colour = its category tone (`ACTION_CATALOG.actionById(row.action)` →
  `.category` → `ACTION_CATALOG.categoryById(...)`).
- `kind:'port'` → label = `t('port.' + row.port)` (keys exist: `port.next/then/else/`
  `body/done/try/catch/finally/default` at i18n lines 460–468 fa, 1144–1152 en).
  For a dynamic `case:<v>` port, label = `t('port.case')` **+ the value** — note
  `port.case` **does not exist yet, you must add it to both `fa` and `en`**.
- Indentation = `row.depth` × a fixed step (16–18px), applied as a padding/`style`
  hook or a `data-depth` attribute + CSS `[data-depth="n"]` rules.
- Click a `kind:'node'` row → `FE.revealNode(row.nodeId)` (already selects + centres).
- Click a `kind:'port'` row → collapse/expand its subtree (pure view state, keep it
  in a module-level `outlineCollapsed = {}` keyed by `nodeId + '|' + port`).
- `✕` → hide the panel (and remember it, like `minimapOpen` does in `flow-editor.js`).

### 5.3 Keeping it in sync — this is the whole point of the panel

```js
var off = FE.onChange(function () { renderOutline(); });
// …and call off() when the view is torn down.
```
`onChange` already fires after every `renderAll()` and every NDV param commit.
Selection mirroring is bidirectional: canvas → outline comes free via `onChange` +
`FE.getSelected()`; outline → canvas is `FE.revealNode()`.

**Do not poll.** **Do not store a second copy of the tree.** The outline is derived
state; the graph is the only source of truth.

### 5.4 Where it lives in the layout

The spec calls it *"left inner panel"* and the image shows it floating over the canvas'
left edge, overlapping the sidebar's right boundary, with the canvas dot-grid visible
around it. Simplest faithful implementation: an absolutely-positioned panel inside
`.fe-canvas` (like the existing minimap overlay, `buildOverlay()` in
`flow-editor.js` ~line 2400), NOT a third grid column — `.fe-layout` is
`grid-template-columns: 240px 1fr` and there is already a `.fe-layout.fe-focus`
variant at styles.css:1146; adding a column would fight both.

---

## 6. Item E — the ACTIVITY LOG

### 6.1 What the image shows (crop `/tmp/activity.png`)

> **⚠ SUPERSEDED 2026-07-29 — the tab count is WRONG below.** This transcription
> came from `shell-editor-launcher-menu.webp`, which shows three tabs. The
> refreshed `state-empty-canvas.webp` shows **FOUR**:
> `Runs · Execution · Variables · Logs`, and the panel opens on **`Execution`**.
> As implemented: `AL_TABS = ['runs','execution','variables','logs']`,
> `alTab = 'execution'` in `run-panel.js`. Guarded by `editor-shell.test.ts`.
>
> Also corrected: the run tally is NOT concatenated into the panel title (that
> produced `Run — 3 ok / 0 err / 3`). The title is the static `ACTIVITY LOG`
> label the image shows, and the tally lives in its own `#al-counts` sibling.
>
> And: **`RunState` has no `variables` bag.** The `Variables` tab derives its rows
> from the graph's `variable` action nodes (`alVariables()`), with runtime values
> read from the matching step's output sample; unknown values print `—`.
> Inventing a `state.variables` would have stored derived state twice.

```
ACTIVITY LOG
Runs | Variables | Logs                       Auto-scroll (●=on, orange)  [⤓] [⌃⌄]
[ All Runs ▾ ]  [ Clear ]
┌────────┬─────────┬────────────┬──────────┬──────────┬─────────────────────────┐
│ Status │ Run ID  │ Workflow   │ Trigger  │ Duration │ Finished At             │
│ ● Succ │ #10243  │ Login Flow │ Webhook  │ 12.45s   │ May 12, 2025 10:24:31AM │
```

Details that matter:
- **exactly 3 tabs** — `Runs`, `Variables`, `Logs`. The written report mentions a
  fourth; **the image wins: three.** The active tab is orange with a 2px orange
  underline.
- `Auto-scroll` is a **pill switch**, orange when on, with the knob on the right.
- Two square ghost icon buttons at the right: `download`, and a collapse control drawn
  as a stacked chevron pair (`⌃⌄` — use `arrows-vertical` or `chevron-up`+`chevron-down`).
- Filter row: a `All Runs ▾` select and a `Clear` button.
- Table: **6 columns** `Status / Run ID / Workflow / Trigger / Duration / Finished At`.
  Status = a coloured dot + coloured word (`Success` green). Run ID is `#`-prefixed.
  Duration is seconds with 2 decimals. Finished At is an absolute long timestamp
  (`May 12, 2025 10:24:31 AM`) — **not** the relative `fmtRel()` used in Workspace.

### 6.2 Reuse, do not reimplement

`public/js/views.js` already has **`execRow`** in the Workspace section, which renders
an execution row from a job object (status tone, id, workflow name, trigger, duration,
timestamp). The Executions tab shipped in PR #6 uses it. **Reuse `execRow`'s logic**
(extract it if needed) so the two tables can never disagree about what "Success" or a
duration means. Data comes from `API.listJobs(userId, limit, workflowId)`
(`api.js` line 143) — pass the open workflow's id so the editor's log is scoped to the
workflow being edited.

Host it in `public/js/run-panel.js`, which is already the bottom drawer and already
owns run state: `window.RunPanel = { mount, unmount, open, close, toggle, startJob,
stop, loadLastRun, pin, unpin, getPins }` with helpers `RIC(name,size)`,
`paintNodes()`, `renderTimeline()`, `statusIcon()`, and module vars `dom, client,
state, currentWfId, pins, LAST_RUN_KEY='ab_last_run'`. The `Logs` tab is essentially
the existing timeline; `Runs` is the new 6-column table; `Variables` shows the
workflow's variables.

---

## 7. Item D — left sidebar upgrade

> ### ✅ DONE 2026-07-29 — and the counts below are MOCK
>
> **THE 6-vs-7 DECISION (do not re-litigate).** The image shows seven rows
> totalling **128** blocks. The real catalog has **six** categories and **fifty**
> actions. The image's rows and counts are **mock**.
>
> Resolution: **presentational**. `ACTION_CATALOG` stays the single source of
> truth — no invented categories, no renamed `cat` ids, no padded action list
> (renaming `cat` would corrupt every node colour, the NDV and `graphToSteps`).
> The image's row vocabulary is mapped onto real categories and **every count is
> computed** from real members:
>
> | image row | catalog category | real count |
> |---|---|---|
> | Triggers | `trigger` | 4 |
> | Browser | `navigation` | 10 |
> | Web Interaction | `interaction` | 16 |
> | Flow Control | `flow` | 7 |
> | Online Services | `integration` | 5 |
> | Data | `data` | 8 |
>
> **Six rows, not seven**: the image's `General` and `Elements` rows have no
> catalog members at all, and a row with a fake count is exactly the
> fake-successful UI § 8 forbids. Any category missing from the table is swept
> into a final row rather than silently dropped. `Triggers` leads because that is
> what a flow starts with. The full reasoning is written into `flow-editor.js`
> above `PALETTE_GROUPS` so it survives without this doc.
>
> **Footer routes had to change too.** `app.js#currentRoute()` **silently**
> rewrites an unknown hash to `#/workspace` — so a plausible `#/templates` does
> not 404, it quietly dumps the user elsewhere, which is indistinguishable from a
> bug. Also, § 4's note about routing `Settings` / `Connections` "to the workflow"
> could not be honoured: no workflow-scoped settings or credentials view exists.
> As shipped: `Templates` -> `#/workspace?tab=templates`, `Connections` ->
> `#/workspace?tab=connections` (both real `WS_TABS` ids; `renderWorkspace` now
> honours `?tab=` via `applyTabQuery()`), `Variables` -> `RunPanel.showTab('variables')`,
> `Settings` -> `#/settings`, `Help & Docs` -> **disabled with a tooltip** because
> no docs view ships. `Version 1.3.7` is mock and was not rendered.

From the spec §2 "Left sidebar", in order:
`Search blocks...` (+ a `⌘K` hint chip) · `Favorites` · `General` · `Browser` ·
`Web Interaction` · `Elements` · `Flow Control` · `Online Services` · `Data` ·
then a footer group: `Templates` · `Variables` · `Connections` · `Settings` ·
`Help & Docs` · `Collapse`. **Counts are right-aligned beside categories.**

⚠️ **Mismatch you must resolve deliberately:** `public/js/actions.js` has **6**
categories (`navigation`, `interaction`, `data`, `flow`, `integration`, `trigger`), the
image shows **7** block categories + `Favorites`. Do **not** invent new action
categories to force a 1:1 match. Map the existing six onto the image's labels and drop
the label that has no actions behind it, or group by a new presentational grouping
table in `views.js`/`flow-editor.js` while `ACTION_CATALOG` stays the data truth.
Whatever you choose, **write the decision down in this file** — the next session must
not re-litigate it.

The palette is currently rendered by `renderPalette()` inside `flow-editor.js`, and
`fe.searchNode` (i18n 420 / 1104) already exists as a search placeholder.

---

## 8. Non-negotiable house rules (these are what break builds here)

1. **CSP**: `script-src 'self'`. No inline `onclick`, no `javascript:`, no `eval`,
   no CDN. Every handler is `addEventListener`.
2. **No framework, no bundler.** Vanilla IIFE modules on `window.*`. Keep the
   `public/index.html` script order; **`icons.js` must stay FIRST** because later
   modules call `window.Icons.*` at definition time.
3. **i18n**: every new user-visible string needs a key in **BOTH** `fa` and `en` in
   `public/js/i18n.js` (`en:` block starts line 664; `fe.*` keys live at fa 395–499 and
   en 1063+). `DEFAULT_LANG='en'`. There is a test that fails on a key present in one
   language only.
4. **CSS**: every class you emit needs a real rule in `public/css/styles.css`
   (3293 lines). Anchors: `.fe-shell` 1753, `.fe-statusbar` 1767,
   `.fe-layout.fe-focus` 1146, canvas toolbar 1027, `@media (max-width:980px)` 1262.
   Use the locked tokens — canvas `#0B0F14`; surfaces `#0F141B` / `#11161E` / `#151C25`;
   border `rgba(255,255,255,0.08)`; primary orange `#FF8A1F`→`#FF9A1F`; info blue
   `#2BA6FF`; success `#2ECC71`; danger `#E45555`; text `#E8EDF4` / `#97A2B3` /
   `#5E6876`; 20px dot grid.
5. **Icons must exist.** `tests/unit/icons.test.ts` asserts every icon name referenced
   by any consumer module is in the registry, **and it has a hardcoded `JS_ALL` list of
   `public/js/*.js` files — adding a new front-end file breaks that test until you add
   the file to the list.** Available names (registry `P` in `icons.js` lines 33–131):
   `alert-circle alert-triangle arrow-down arrow-up arrows-vertical bar-chart bell
   book-open braces briefcase calendar camera check check-circle chevron-down
   chevron-left chevron-right chevron-up clipboard clock cookie copy corner-down-left
   database dot download eye eye-off file-text filter folder frame gauge git-branch
   globe grab grid hand help-circle history home hourglass image-frame infinity
   keyboard layers layout lock map maximize message-square minus more-vertical
   mouse-pointer mouse-pointer-2 move octagon-alert palette panel-left paperclip
   pencil pin play play-circle plus power repeat rocket rotate-ccw rotate-cw save
   search send settings shield shuffle sitemap sliders sparkles square square-check
   square-x stop-circle tag target terminal trash upload user users variable wand
   webhook x x-circle zap` (+ action-specific ones like `launch-browser`,
   `extract-data`, `parse-json`, `wait-element`, `switch-tab`, …).
   Everything item A needs is present: `home`, `rotate-ccw`, `rotate-cw`, `download`,
   `save`, `stop-circle`, `bell`, `settings`, `plus`, `chevron-down`, `user`.
6. **CRLF discipline.** Two backend files are CRLF and must stay that way; `views.js`
   must stay LF. Sanity checks:
   ```bash
   grep -c $'\r' src/Routes/user.routes.ts   # ≈1190
   grep -c $'\r' src/pipeline.ts             # ≈2922
   grep -c $'\r' public/js/views.js          # MUST be 0
   ```
7. **Front-end tests are source-level guards.** The front-end is DOM-bound, so tests
   `readFileSync` the source and assert on strings; DOM-free modules (`icons.js`,
   `i18n.js`, `graph-serialize.js`, `ndv-model.js`) get real `node:vm` sandboxes.
   Templates to copy: `tests/unit/canvas-chrome.test.ts`, `tests/unit/workspace-ui.test.ts`
   (note the CSS-block slicing idiom `CSS.indexOf('.sel {')`).

---

## 9. Remaining backlog beyond A–E

| Item | What |
| --- | --- |
| **H** | Floating **Add Node** palette (see `docs/uiux/shell-add-node-palette.md` + `.webp`) |
| **I** | Group-selection toolbar (appears when >1 node is box-selected) |
| **J** | Full **9-item** node context menu (currently partial: clone/pin/unpin exist — `fe.nodeMenu`, `fe.cloneNode`, `fe.pinNode`, `fe.unpinNode` are already in i18n) |
| **N** | Single-node **Run node**: a backend endpoint + `API.runNode()` + NDV wiring (the NDV already has a run button shell, `.ndv-run-btn` in CSS at ~1740) |
| — | Priority-1 guard tests named in `03-HANDOFF`: `tests/unit/workspace-tabs.test.ts` |

---

## 10. Suggested order for the next session

1. **Look at the images** (§1 recipe). Non-negotiable.
2. `npx vitest run` to confirm you start green (expect 34 files / 614 tests).
3. **Item A** — rewrite the `.fe-topbar` markup in `views.js#renderEditor`, keeping
   all seven existing button ids alive (§3.2). Add CSS + i18n as you go.
4. **Item B** — the two split menus, copying the Workspace kebab idiom.
5. **Item C** — the OUTLINE panel; it is pure rendering now, `FE.outline()` +
   `FE.onChange()` + `FE.revealNode()` do all the thinking.
6. **Item E** — ACTIVITY LOG in `run-panel.js`, reusing `execRow`.
7. Guard test `tests/unit/editor-shell.test.ts` — assert: outline numbering
   (via a `node:vm` sandbox of `graph-serialize.js`, the real test-worthy logic),
   the presence of the top-bar structure/ids, undo/redo contract strings, the
   **3**-tab activity log, and the 6 column headers.
8. `npx tsc --noEmit` + `npx vitest run` + the `node --check` loop.
9. Commit → `git fetch origin main` → rebase → **squash into one commit** →
   `git push -f` → open/update the PR → **paste the PR URL for the user**.

---

## 11. Verification command block (copy-paste)

```bash
cd /home/user/webapp
npx tsc --noEmit
npx vitest run
for f in public/js/*.js; do node --check "$f" || echo "FAIL: $f"; done
grep -c $'\r' src/Routes/user.routes.ts   # ≈1190
grep -c $'\r' src/pipeline.ts             # ≈2922
grep -c $'\r' public/js/views.js          # must be 0
```

---

## 12. Session log — extra findings worth keeping

- `flow-editor.js` had **no** undo/redo of any kind before this session
  (`grep -n "undo\|redo\|history"` returned nothing). Anything that claims otherwise
  is stale.
- `revealNode()` shipped calling a `centerOnNode()` that did not exist for a short
  while; it is now implemented (§2.3). If you ever see a `centerOnNode is not defined`
  runtime error, the file was reverted.
- `.fe-layout` is `grid-template-columns: 240px 1fr` with height
  `calc(100vh - 250px)`. The image shows a **full-bleed** editor. Making it truly
  full-bleed means the shell must escape the page's normal content padding — expect to
  touch the container rule as well as `.fe-shell`, and to re-check the
  `@media (max-width:980px)` block at styles.css:1262 and the `.fe-focus` variant at
  1146.
- The editor's seven toolbar listeners have **no null guards** — the single most likely
  cause of "the editor view went blank" while doing item A. (§3.2)
- `public/index.html` sidebar has exactly **six** `.nav-item`s
  (home/workspace/dashboard/jobs/admin/settings) and `#launcher-menu` mirrors the same
  six. Item A's `Home` / `Workspace ▾` must route to those existing routes
  (`NAV_ROUTES` / `DEEP_ROUTES` / `ROUTE_PARENT` / `handleRoute()` in `app.js`), not
  add new ones.
