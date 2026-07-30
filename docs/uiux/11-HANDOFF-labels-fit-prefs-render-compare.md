# HANDOFF 11 — node labels, panel-aware fit, sticky view prefs, and the first real render-vs-design comparison

> **SUPERSEDED by `12-HANDOFF-shell-parity-brand-mark-fa-980.md`. Read that file instead.**
> It carries § 0 forward verbatim and records which of the § 5 items below have shipped.
>
> Two things in this file are now known to be **wrong**, and are corrected in handoff 12:
> - **§ 3.2 / G13 describes the brand mark as the letter `A` in an orange rounded tile.** The 1672 px WebP shows
>   an orange stroked `(o)` with **no tile**. See handoff 12 § 3.
> - **§ 6's heuristic "a zoom one point off the 0.4 floor means suspect the insets"** sent the 980 px
>   investigation the wrong way. The empty canvas was an opaque toolbar stretched over the node layer; the fit was
>   correct. See handoff 12 § 2.1.
>
> Kept for history: the node-label, panel-aware-fit and sticky-prefs work it documents is still accurate.

---

## § 0. Standing rules (instructions, not preferences)

1. **Keep developing. Never ask the user questions.** Search the repo, decide, and document the decision here.
2. **Image beats prose.** `docs/uiux/*.webp` outranks every `.md` in this folder, including this one. When an
   icon or a geometry is in question, crop and zoom the WebP instead of guessing:
   ```bash
   magick docs/uiux/state-empty-canvas.webp /tmp/x.png
   magick /tmp/x.png -crop 400x160+240+60 +repage -resize 300% /tmp/zoom.png   # then read /tmp/zoom.png
   ```
3. **Never ship fake-successful UI.** No mock rows, no invented counts, no "Success" that no run produced.
   If the backend cannot do it yet, render the control **disabled with a tooltip that says why**.
4. **Real counts only.** A badge showing `12` must come from data, not from a literal.
5. **Do not add a new front-end JS file.** `tests/unit/icons.test.ts` pins **18** files in `public/js/`.
   Dev tooling goes in `tools/` (not counted). Test files are not counted either.
6. **Every i18n key must exist in BOTH the `fa` and `en` dictionaries** of `public/js/i18n.js`.
   `t()` falls back `fa → en → key`, so an en-only key silently leaks English into Persian — the default
   locale — and a key missing from both renders its own raw name in the UI. Only a source-level test sees this.
7. **Line endings.** `public/**` = LF (**0 CR**). `src/Routes/user.routes.ts` = CRLF (**CR count 1317** —
   patch it with Python `io.open(..., newline='')`). `src/schemas.ts` CR=0.
8. **Git flow, every time.** commit → `git fetch origin main` → rebase → **squash to ONE commit**
   (`git reset --soft HEAD~N && git commit -F /tmp/commitmsg.txt`) → `git push -f origin genspark_ai_developer`
   → create/update the PR → **hand the user the PR link**. Never use backticks inside `git commit -m`;
   always write the message to a file and use `-F`.

### Verification quartet (run before every commit)
```bash
cd /home/user/webapp
npx vitest run          # expect: 37 files, 768 tests passing (as of this handoff)
npx tsc --noEmit        # expect: silent
ls public/js/*.js | wc -l          # expect: 18
grep -c $'\r' src/Routes/user.routes.ts   # expect: 1317
grep -rl $'\r' public/ | head             # expect: no output
```

---

## § 1. What shipped in this session

### 1.1 Node cards now speak product language, not action ids  ✅
**The defect:** a seeded render of `#/editor` showed `goto`, `fill`, `fill`, `click`, `wait`, `extract` on the
canvas cards, in the OUTLINE list and in the blocks palette. Every locked design labels them
**Open URL / Type Text / Click Element / Wait / Extract Text**.

Two independent, both-silent causes:

* `NODE_DISPLAY_NAMES` in `public/js/flow-editor.js` covered only **14 of the 50** catalog actions.
  Unmapped actions fell through to the raw-id fallback.
* The `nk.*` keys existed **only in the `en` dictionary**. Persian (the default) therefore rendered English
  names, and any key absent from both would have rendered `nk.typeText` literally.

**Fixed:**
* `NODE_DISPLAY_NAMES` now maps **all 50** actions, grouped by category, at `flow-editor.js:1721`.
* New single labelling helper `actionLabel(actionId)` (`flow-editor.js` ~1781) — `t(NODE_DISPLAY_NAMES[id])`
  with the raw id kept as the deliberate fallback for actions added later.
* `paletteItem` renders `esc(actionLabel(a.id))` and keeps `item.title = a.id`, so the raw action id is still
  discoverable as a tooltip for anyone writing steps by hand.
* `public/js/i18n.js` now carries the full set in **both** dictionaries: **52 fa** + **36 new en** entries.
* `tools/patch-nk-i18n.py` records exactly how the dictionaries were patched. Persian compounds need ZWNJ
  (U+200C, نیم‌فاصله) — invisible in a diff — so the script writes it as a visible `~` placeholder and
  substitutes on the way out. Re-runnable reference for the next dictionary insert.

### 1.2 `fitToScreen` is panel-aware  ✅
**The defect:** the OUTLINE panel, the run-info strip and the minimap are absolutely positioned **inside**
`.fe-canvas`, so the *visible* canvas is smaller than its own box. Fitting to the full box slid the first node
underneath the OUTLINE overlay — a seeded render showed the **Start** card as a dim "ghost" behind the panel.
(It was mis-diagnosed in handoff 10 as a stale empty-state card. It is not: `renderEmptyState()` is correct.)

**Fixed:** new `canvasInsets(rect)` in `flow-editor.js` (just above `fitToScreen`, ~line 516) measures live
overlay rects and charges each overlay to **one** edge.

> **Trap — do not "simplify" this to nearest-edge.** The minimap is a *corner* overlay at 460×197. Charging it
> to the nearest edge picked the end edge and consumed **496 px of width**, collapsing the fit to the 0.4 zoom
> floor (rendered at 40 %). Each overlay is charged to the edge that costs the **least canvas**: the minimap
> costs 233 px on the bottom vs 496 px on the right, so bottom wins. Measured, not hard-coded, so it stays
> correct under RTL (where OUTLINE hugs the opposite edge) and when a panel is collapsed.
> A `0.7` clamp stops overlays from eating the whole canvas on small viewports.

Result: 1672×941 seeded render fits at **65 %** with the whole chain clear of every overlay.

### 1.3 Sticky view preferences  ✅
`AppUtil.pref(key, fallback)` / `AppUtil.setPref(key, value)` added in `public/js/app.js`, backed by **one**
namespaced blob `localStorage['ab_ui_prefs']` (JSON). Malformed values are tolerated — a hand-edited blob must
not break booting. Rationale recorded in the code: a key per switch grows an unbounded set of `ab_*` keys that
nothing cleans up and makes "reset my layout" impossible.

Wired:
* `fePaletteCollapsed` — the palette footer `Collapse` control (`setPaletteCollapsed`).
* `feOutlineOpen` — the OUTLINE panel (`setOutlineOpen(open, remember)` in `views.js`; `remember === false`
  on the initial restore pass so re-applying stored state is not recorded as a fresh user choice).

> **Trap:** `app.js` is the **LAST** `<script>` tag, so `window.AppUtil` does **not** exist while
> `flow-editor.js` evaluates its module scope. `prefGet` / `prefSet` in `flow-editor.js` therefore read
> `window.AppUtil` at **call** time and no-op until it exists; `hydrateViewPrefs()` is called from
> `renderPalette()` (per editor mount). Do not move the read to module scope.

> **Decision — the collapse DEFAULT stays "expanded".** The locked images disagree with each other:
> `state-empty-canvas.webp` shows the palette collapsed to a 13-glyph rail and the OUTLINE collapsed to a
> vertical tab, while `shell-add-node-palette.webp` shows both fully expanded. Two images, two states ⇒ this is
> a **user preference, not a design constant**. Persistence was the real requirement. Do not "fix" the default
> to collapsed on the strength of one image.

### 1.4 Render harness upgrades  ✅
`tools/ui-shot.js` (dev only, not counted against the 18-file pin):
* `UI_LANG=en|fa` — the locked images are LTR English; the product default is fa/RTL.
* `UI_SEED=<templateId>` — loads a **real** template's steps through the product's own
  `FlowEditor.loadSteps()`, so the render shows genuine serializer output rather than a hand-drawn mock.
  `UI_SEED=list` prints the available ids. Ids: `price-scrape`, `login-form` (6 steps), `scheduled-screenshot`.
* `UI_WAIT=<ms>` — extra settle time (default 1200).
* The 5th CLI argument is now a comma-separated list of **interaction steps**, applied in order:
  `.some-btn` (click), `dbl:.flow-node` (double-click — this is how the NDV opens), `key:Escape`.
  Failures are reported, never swallowed: a shot of a panel that never opened looks identical to a shot of a
  broken panel.

### 1.5 Guard tests  ✅  (+8, suite now **768** in 37 files)
Appended to `tests/unit/action-catalog.test.ts` — the file that already owns the catalog contract, so no new
test file was needed:
* every catalog action has a display name (no card can fall back to a raw id);
* no dangling entries (a renamed action cannot leave a dead mapping);
* every entry points at an `nk.` key;
* every key resolves in **fa** and in **en**, checked at source level;
* the palette row renders `actionLabel()`, never `esc(a.id)`;
* `actionLabel` exists as the single labelling path.

---

## § 2. Contracts and invariants worth not rediscovering

| Thing | Contract |
|---|---|
| `window.ACTION_CATALOG` (`public/js/actions.js`) | **50** actions, **6** categories (`navigation`, `interaction`, `data`, `integration`, `flow`, `trigger`). Field objects are keyed **`k`**, e.g. `{ k: 'selector', label: 'p.selector' }`. Source of truth for the display-name coverage test. |
| Icon registry (`public/js/icons.js`) | `P` map of stroke-only 24×24 paths; `names()` = `Object.keys(P).sort()`; `svg(name)` falls back to `dot`; `hydrate()` reads `data-icon` + `data-icon-size`. Tests require ≥60 icons, lower-kebab names, sorted+unique, `stroke="currentColor"`, `fill="none"`, **no hex colours**. |
| i18n | `DICT = { fa: {...}, en: {...} }`, `STORAGE_KEY = 'ab_lang'`, `DEFAULT_LANG = 'en'`, `t(key)` falls back fa→en→key. **`I18N.t()` takes NO lang argument** — to compare locales in a test, string-slice the dictionaries (`dictSlices()` idiom in `workspace-ui.test.ts` / `action-catalog.test.ts`). |
| CSS token trap | `--text-mute`, `--accent`, `--surface-2`, `--text-disabled` **do not exist**. Valid: `--bg-elev-2` (#151C25), `--text-faint` (#5E6876), `--primary`, `--primary-soft`, `--success`, `--danger`, `--border`, `--info`, `--text`. |
| Per-node Run ("item N") | Running node *X* enqueues the **chain prefix** `toSteps().slice(0, idx+1)` via `POST /run-node`; job tagged `__runNode` + `__nodeIndex`, deliberately **no** `__workflowId` (keeps Executions and stats honest) and **no** `webhookUrl`. |
| Chain vs step index | `chainNodeIds()` includes disabled nodes; `graphToSteps()` skips them. Use `stepChainIds()` (enabled-only) and the inverse `chainStepIndex()` for every index→id resolution. |
| Minimap idiom | frame = `union(nodes, viewport)`; the viewport rect is an **outline + `box-shadow: 0 0 0 9999px rgba(0,0,0,0.42)` scrim** (clipped by `.fe-minimap { overflow: hidden }`), never a `--primary-soft` fill. |
| Launcher parity | Open button = dark interior (`--bg-elev-2`) + 1.5 px orange **ring via `box-shadow`** (never a border → no layout shift) + light glyph. 40 px rows, 20 px glyphs, 14 px labels, 12 px gap, panel 184 px wide with 6 px padding. |
| Add Node entry points | **Five**: toolbar CTA, empty-state CTA, canvas context menu, keyboard, and the circled `+` on a free output port (`PORT_ADD_R = 9`, only on ports with no edge, reuses `openAddPalette({ world: slotAfter(id), from: { nodeId, port } })`). `tests/unit/node-toolbox.test.ts` pins all five. |
| View state hygiene | `paletteFavs` / `paletteOpen` / `paletteCollapsed` are module-level **view** state, never on `state`, so they cannot leak into `saveLocal()` / `serialize()` / `steps[]`. |

---

## § 3. Render-vs-design comparison — findings (the valuable part)

Harness used (preview server must be running):
```bash
node tools/ui-preview-server.js 8788 &        # log: /tmp/preview.log
UI_LANG=en UI_SEED=login-form node tools/ui-shot.js '#/editor' /tmp/render/editor.png 1672x941
UI_LANG=en node tools/ui-shot.js '#/workspace' /tmp/render/ws.png 1672x941 '#launcher-btn'
UI_LANG=en UI_SEED=login-form node tools/ui-shot.js '#/editor' /tmp/render/ndv.png 1672x941 'dbl:.flow-node:not(.is-start)'
for f in docs/uiux/*.webp; do magick "$f" "/tmp/locked/$(basename "$f" .webp).png"; done
```

> **Note:** the launcher does **not** exist on `#/editor` — that route is a full-bleed shell with its own
> header. Shoot `#launcher-btn` on `#/workspace` (or any app-shell route) instead. A previous session lost
> time to `CLICK FAILED #launcher-btn` for exactly this reason.

### 3.1 Confirmed correct (do not "fix")
* Node display names on cards, OUTLINE and palette (after § 1.1).
* Card anatomy: colour-coded icon + title + subtitle + kebab; ports and connectors.
* Minimap: orange viewport outline + scrim over node bars, `FIT` / `+` / `−` controls.
* Bottom status bar structure — and it tells the **truth** (`Version unsaved`, `Auto-save off`,
  `Last saved —`, `Workflow ID —`, `Environment Development · multi`) where the design mock shows a fictional
  `v1.3.7 / wf_login_001 / Production`. **Keep ours honest** (§ 0 rule 3).
* `Test Workflow` (orange) is the idle state; the design's red `Stop` is the running state.

### 3.2 Open gaps, in the order they cost the most visual parity

| # | Gap | Locked evidence | Where to work |
|---|---|---|---|
| **G1** | **Palette taxonomy is wrong.** Ours groups by catalog category: `TRIGGER 4`, `NAVIGATION 10`, `INTERACTION`, `DATA`, `INTEGRATION`, `FLOW`. The design groups by *product* domain: `Favorites 12`, then `General 14`, `Browser 18`, `Web Interaction 24`, `Elements 20`, `Flow Control 16`, `Online Services 22`, `Data 14`. | `shell-add-node-palette.webp` (left rail) | `PALETTE_GROUPS` in `flow-editor.js` (~3090). **Counts must be real** (§ 0 rule 4) — the design's numbers imply many actions we do not have, so either group the 50 we own under these names and show true counts, or keep our taxonomy. **Decide and record the decision here.** |
| **G2** | **`Online Services` has real sub-items** — Google Sheets, Google Drive, Gmail, Slack, Discord, Telegram, Airtable, Notion — as a nested list with brand glyphs. We have none of these actions. | same image | Backend has no such integrations. Per § 0 rule 3 these must be **disabled rows with a "not connected yet" tooltip**, or omitted. Do **not** render them as if they work. |
| **G3** | **Top bar has a workflow TAB STRIP**: `Login Flow ●` (active pill), `Payment Flow`, `Instagram Bot`, `Scraper`, `+ New Workflow`. Ours shows a single `Untitled workflow ●` + `+ New Workflow`. | all four shell images | Real multi-workflow tabs need a list endpoint + open-tab state. Real counts only: show the workflows that actually exist. |
| **G4** | **The breadcrumb second row is not in any locked image.** Ours renders `/ Untitled workflow (Draft)` as a hairline row under the tab strip, costing ~24 px of canvas. | `state-empty-canvas.webp` — canvas starts immediately under the bar | `views.js:959` `.fe-crumbline`. It also hosts the hidden `.fe-legacy` buttons (`#fe-from-run`, `#fe-load`, `#fe-json`, `#fe-clear`, `#fe-save`, `#fe-save-server`) whose ids other code and tests still bind — **keep the element, hide the row**, do not delete it. |
| **G5** | **Run-info strip never appears.** `#fe-runinfo` exists in markup and `refreshRunInfo()` correctly refuses to invent a run, but nothing ever populates it. Design: `Last Run: Success / Duration: 342 ms / Variables: 3` top-start of canvas. | `state-empty-canvas.webp` | `views.js` ~1636. Needs `RunPanel.getSummary()` to return a real summary after a run. Correct as-is on an empty canvas — do not fake it. |
| **G6** | **ACTIVITY LOG default state.** Design: **open**, with **4** tabs `Runs / Execution / Variables / Logs`, opened on **Execution**, showing real rows. Ours: collapsed, showing `Idle — Auto-scroll`. An older image in this folder shows only **3** tabs — the 4-tab version is newer and wins. | `state-empty-canvas.webp` | Dock code in `flow-editor.js` (`syncDock`, `publishDockGutter`). Open-state should use the new `AppUtil.pref` blob (suggested key `feDockOpen`). |
| **G7** | **NDV is far from final.** Design: 3-pane modal — `INPUT` (Schema/Table/JSON toggle, `Run 2 of 2` selector, search, tree with item counts, draggable value chips `body` / `headers.authorization` / `query.source` / `timestamp`, "Drag values into parameters" hint) · centre (4 tabs, `fx` expression buttons, `Retry`, `Timeout (ms)`, `Continue On Error` toggle, `+ Add Parameter` / `+ Add Header` repeaters) · `OUTPUT` (same toggles + `Run 2 of 2`, tree, and a footer `Status: 200 OK  Time: 342ms  Size: 1.2 KB`). Header: icon + title + `GET https://…` subtitle + green status dot + `Run node` + `✕`. | `shell-add-node-palette.webp`, `ndv-click-element-final.webp`, `ndv-condition-final.webp`, `shell-editor-click-ndv.webp` | `public/js/ndv-*.js`. Biggest remaining chunk. `Run 2 of 2` and the Status/Time/Size footer must come from real run data or be **disabled**. |
| **G8** | **13-glyph collapsed icon rail.** Design's collapsed palette is a rail of 13 glyphs, top→bottom: star, `</>`, globe, crop/frame, `T`, sitemap, cloud, database, file-text, `{}`, link, gear, and `»` (expand) at the bottom. | `state-empty-canvas.webp` left edge | `pl-rail` / `applyPaletteCollapsed()` in `flow-editor.js` (~3284). Verify each glyph exists in the registry — a typo silently renders the `dot` fallback. |
| **G9** | **Node cards lack the running "glow".** Design cards carry an orange border-glow while a run is in flight, and the icon sits in a rounded colour tile. | all shell images | `styles.css` `.flow-node`. Must be driven by real run state, never always-on. |
| **G10** | **980 px and RTL passes never done.** No render has been taken at 980 px, and none in fa/RTL beyond a smoke shot. | — | `UI_LANG=fa` and `1672x941` → `980x900`. |
| **G11** | `#fe-result` is not placed in the full-bleed shell. | — | carried over from handoff 09 § 5 |
| **G12** | Group / Convert-to-Subflow actions, and per-node Run on **branch** nodes (`if`/`switch`/`loop`/`foreach`/`while`/`try`), are unimplemented. | — | `runNodeBlockedReason()` (`flow-editor.js` ~2054) already returns a reason; keep it disabled-with-tooltip until real. |
| **G13** | **No brand logo mark.** Design shows an orange rounded-square glyph left of "Aria Automate"; ours renders the letter `A` in a tile. | `workspace-overview.webp`, all shell images | `index.html` `sidebar-brand` + `views.js` editor header. |

### 3.3 Documentation defects found in this folder
* **`shell-add-node-palette.webp` is mis-named** — it shows the **NDV modal** (HTTP Request) over the editor,
  *not* the Add Node palette. Its value is the fully expanded left palette and the complete NDV anatomy.
  Do not go looking for an Add-Node-palette design in it.
* Its centre tabs are rendered in **Persian** (`تعلیمات`, `تعلیمات پیشرفته`, `خطا`, `تست`) while the rest of the
  frame is English — the mock is bilingual, so do not treat the tab strip as an LTR spec.
* One older activity-log image shows **3** tabs; the current design has **4**. Newer wins.

---

## § 4. Anchor table (verified this session)

| File | Anchor | Line ≈ |
|---|---|---|
| `public/js/flow-editor.js` | `canvasInsets(rect)` + `fitToScreen()` | 516 |
| | `prefGet` / `prefSet` / `hydrateViewPrefs` | 95–120 |
| | `PORT_ADD_R = 9` | 397 |
| | circled `+` chip inside `ports.forEach` | ~894–925 |
| | `NODE_DISPLAY_NAMES` (50 actions) | 1721 |
| | `actionLabel(actionId)` | ~1781 |
| | `renderEmptyState()` (correct — not the ghost-card cause) | 1261 |
| | `stepChainIds` / `chainStepIndex` / `runNodeBlockedReason` / `runUserId` / `runNode` | 2030 / 2045 / 2054 / 2063 / 2079 |
| | `renderPalette()` (calls `hydrateViewPrefs()`) | ~3104 |
| | `PALETTE_GROUPS` footer + `Collapse` wiring | ~3090–3115 |
| | `applyPaletteCollapsed()` / `setPaletteCollapsed()` | ~3284 / ~3333 |
| `public/js/app.js` | `PREFS_KEY = 'ab_ui_prefs'`, `readPrefs` / `pref` / `setPref` | 47–83 |
| | `window.AppUtil` (extend here) | ~630 |
| | launcher logic | 454–545 |
| `public/js/views.js` | `.fe-crumbline` breadcrumb row (G4) | 959 |
| | editor shell markup (`#fe-palette`, `.fe-outline`, `#fe-ol-tab`, `#fe-runinfo`) | 976–998 |
| | `olOpen` restored from prefs | ~1540 |
| | `setOutlineOpen(open, remember)` | ~1615 |
| | `refreshRunInfo()` (G5) | ~1637 |
| `public/js/i18n.js` | fa dict starts / ends | 9 / 826 |
| | en dict starts | 827 |
| | `nk.*` blocks (both dicts) | after fa `'admin.disconnect'` and after en `'nk.loopCondition'` |
| `tests/unit/action-catalog.test.ts` | display-name guards (8) | tail of file |
| `tools/ui-shot.js` | `UI_LANG` / `UI_SEED` / `UI_WAIT`, step runner | header + ~83 |
| `tools/patch-nk-i18n.py` | dictionary patcher, `~` = ZWNJ | — |

---

## § 5. What to do next — priority order

1. **G4 — hide the breadcrumb row.** Smallest change with visible parity gain. Keep `.fe-legacy` in the DOM.
2. **G6 — ACTIVITY LOG default open on `Execution`, 4 tabs**, persisted via `AppUtil.pref('feDockOpen', …)`.
3. **G1 / G2 — decide the palette taxonomy.** Either adopt the design's domain groups with **true** counts, or
   keep the catalog categories and record *why* in this file. Do not ship invented counts or fake integrations.
4. **G8 — the 13-glyph collapsed rail** (verify every glyph resolves in the registry).
5. **G7 — NDV build-out**: OUTPUT empty state, `Status / Time / Size` footer, `Run N of M` selector. Anything
   without real data ⇒ **disabled + tooltip**.
6. **G13 — brand logo mark**, then **G9** running glow.
7. **G10 — 980 px and fa/RTL render passes**; fix what they surface.
8. **G3 — workflow tab strip** (needs a real workflow list).
9. **G5 / G11 / G12** — run-info population, `#fe-result` placement, group/subflow + branch-node run.

For every item: render before **and** after with `tools/ui-shot.js`, compare against the WebP, add or update a
guard test, run the § 0 verification quartet, commit, and update this file.

---

## § 6. Loose ends and notes (nothing hidden)

* **`tools/patch-nk-i18n.py` is a one-shot script that has already been applied.** Re-running it will fail its
  own "appears exactly twice" assertion (that guard is intentional). It is kept as the reference recipe for the
  next dictionary insert, not as part of the build.
* A previous session's `/tmp/patch_nk.py` failed on a bad anchor; that file is gone and irrelevant.
  The anchors that actually work are in the § 4 table.
* No new front-end JS file was added; `public/js` is still **18** files.
* No screenshots are committed. All renders live in `/tmp/render/` and `/tmp/locked/` and are
  **internal verification only** — regenerate them with the § 3 commands.
* `tools/ui-preview-server.js 8788` must be running for any render. It serves the static `public/` build;
  there is **no backend**, so `#/workspace` legitimately logs one `404` for its data fetch. That 404 is
  expected and is not a bug to chase.
* The debug helper used to measure overlay rects was temporary and deliberately not committed. If needed
  again: a short Playwright script that `page.evaluate()`s `getBoundingClientRect()` on
  `.fe-outline, .fe-runinfo, .fe-minimap-wrap`. It must live in the project root (or `tools/`) because
  `playwright` resolves from `node_modules` there, not from `/tmp`.
* Measured geometry at 1672×941, for reference: canvas `l=240 t=84 w=1432 h=828`;
  OUTLINE `240→476` (full height); minimap `1200→1660`, `703→900`.
* `fitToScreen`'s zoom floor is `0.4` and ceiling `2` — if a fit ever renders at exactly 40 %, suspect the
  insets, not the graph.
