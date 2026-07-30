# Final UI/UX — Aria Automate

## Locked product chrome
- **Theme:** dark only (charcoal canvas + orange accent). No light variant in v1.
- **Language / direction:** English LTR. Canvas ports are physical left/right only.
- **Shared tokens:** see any shell/NDV `.md` “Shared design tokens” block (`#0B0F14`, `#FF8A1F`, `#E8EDF4`, …).
- **Note:** `state-empty-canvas.md` previously described light colors by mistake; it was corrected to match the locked dark image.

## ⚠ Which images carry the LATEST updates (2026-07-29)

All UI images matter, but **three carry the most recent corrections**. Some
sections were revised more than once; rather than discard a whole image for one
fix, the earlier images were kept — so a later image contains **both** the
corrections **and** other sections. Read the paired `.md` of all of them.

| Authoritative | Why |
|---|---|
| `workspace-overview.webp` | Workspace hub — matches the shipped `renderWorkspace` |
| `state-empty-canvas.webp` (**1672×941, refreshed**) | Newest capture of the editor shell. Despite the stem it **no longer shows an empty canvas** — it is the populated editor with both split menus open. Authoritative for the top bar, canvas chrome and the ACTIVITY LOG tab set. |
| `shell-editor-launcher-menu.webp` | Launcher + blocks palette + measured OUTLINE / toolbar geometry |

**Where a newer image and an older image (or any prose) disagree, the newer
IMAGE wins.** The corrections from this pass are recorded in
`state-empty-canvas.md` § 7 (superseded-claims table) and in the corrections box
in `shell-editor-launcher-menu.md` § 5 — read those before "fixing" the
implementation back to an older doc.

Headline corrections, so they are not re-litigated:

- Canvas tool + zoom cluster is **TOP-END**, not bottom-start; the two
  **labelled** view actions (`Auto Layout`, `Focus Mode`) sit on their own pill
  row above it. Only the MINIMAP is bottom-end.
- The OUTLINE rail is on the **START edge**, full height, flush against the
  palette — it occupies real canvas width, published as `--fe-ol-w`.
- The ACTIVITY LOG has **FOUR** tabs (`Runs · Execution · Variables · Logs`),
  not three, and opens on `Execution`. (`shell-editor-launcher-menu.webp` still
  draws the older THREE-tab set opening on `Runs`; the newest image wins.)
- `Test Workflow` and `Stop` are **one slot in two states**, not two buttons.
- The palette's seven rows / 128 blocks / `Version 1.3.7` are **MOCK** — see the
  6-vs-7 decision table (six real categories, fifty actions, computed counts).

## How we work (token-safe)
1. **First read the paired same-stem `.md`** — not the image.
2. If the MD is enough, **do not open images**.
3. If you need visuals: open **only one lite** under `lite/`.
4. Open **full** WebP only for pixel-level decisions, one file at a time.
5. Spec lives **only in `.md`** (no separate `.txt` — avoid duplicate clutter).
6. **Beware stale lite JPGs.** `lite/state-empty-canvas.jpg` predates the refresh
   and shows the old empty-canvas screen; for that stem use the full WebP.

See also `00-PROCESS-node-design.md`.

## Product architecture (locked 2026-07-28)

The navigation was restructured so that **Workspace is the workflow-management
hub** and everything scoped to a single workflow lives on that workflow instead
of in the global menu:

```
Sidebar = Home · Workspace · Dashboard · Jobs · Admin · Settings   (six, final)
Header  = brand + [⊞ App Launcher] → the same six areas in a floating menu
Removed from navigation: Live View · Live Browser · Schedules · Active Flow
        → they are now per-workflow capabilities (row toggles + ⋮ menu + editor)
```

The requirement of record is `01-REPORT-ui-architecture-update.md` (verbatim
product report). Its two locked screens are `workspace-overview` and
`shell-editor-launcher-menu`. Where report and image disagree, **the image
wins** — the only such case is the stat-card order, documented in
`workspace-overview.md` § 3D.

**Implementation status, open items and pick-up instructions live in
`02-HANDOFF-workspace-architecture.md`.** Read that file before touching the
Workspace hub, the App Launcher, or the `active` / `liveBrowser` workflow flags —
it records what is intentionally deferred (integration tests, placeholder tabs,
inert filter button) so those are not mistaken for bugs.

## Index (locked / reviewed)

All eight screens have been READ. Only the two `ndv-*-final` screens are in scope
for *node design* — the shell/state screens are read for their cross-cutting
rules (tokens, node cards, connectors, status bar, category-derived modal glow),
and the two 2026-07-28 screens define the product-level navigation.

| Stem | Role | Full | Lite | Spec | Implementation |
|------|------|------|------|------|----------------|
| `workspace-overview` | Workspace = workflow hub (7 stat cards, table, toggles) | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`views.js` → `renderWorkspace`) · backend `active`/`liveBrowser` + `/workspace/:userId/stats` executed |
| `shell-editor-launcher-menu` | Header App Launcher + six-area menu | `.webp` | `lite/*.jpg` | `.md` | ✅ built · launcher + menu + six-item sidebar + workflow tab strip + Export/Save split menus + blocks-palette groups done; panel re-measured at 3x in 2026-07-30 → locked glyphs (`grid` / `briefcase` / `shield-check`), 40px rows / 20px glyphs, **ringed** (not filled) open button, one product name (§ 5 corrections box records the stale claims) |
| `ndv-condition-final` | Condition NDV focused | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`ndv-nodes.js`) · backend `source`/`attribute` executed |
| `ndv-click-element-final` | Click Element NDV focused | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`ndv-nodes.js`) · backend click extras executed |
| `shell-editor-click-ndv` | Full shell + Click NDV open | `.webp` | `lite/*.jpg` | `.md` | ◐ node cards / ports / connectors / status bar / **SVG icons** / **left-to-right pipeline layout** / **minimap header** / **floating canvas toolbar** done; Outline + Activity Log + top-bar chrome pending |
| `shell-editor-condition-ndv` | ⚠ **stem is wrong** — this is the annotated **context-menu / group-toolbar / Add-Node** screen (not a Condition NDV) | `.webp` | `lite/*.jpg` | `.md` | ✅ `True`/`False` edge pills + selection glow + nine-row context menu + group toolbar + **per-node Run** (item N) done |
| `shell-add-node-palette` | ⚠ **stem is wrong** — this is an **HTTP Request NDV**, not an add-node palette | `.webp` | `lite/*.jpg` | `.md` | ◐ category-derived modal glow + full context menu + floating Add Node palette (**five** entry points, incl. the circled `+` on a free output port) done; NDV `Run 2 of 2` selector + OUTPUT footer pending |
| `state-empty-canvas` | **Refreshed: full editor shell** (stem is historical) | `.webp` **(newest)** | `lite/*.jpg` *(stale)* | `.md` *(rewritten)* | ✅ built · top bar (items A–B) + OUTLINE rail (C) + blocks palette (D) + 4-tab ACTIVITY LOG (E) + **top-end** canvas toolbar & pill row + titled minimap; empty-state card still renders when the graph is empty |

Remaining work per screen is tracked, with file/line anchors, in
`/HANDOFF_2026-07-27_ICONS_LAYOUT.md` § 4 (items A-N, ordered by visual
impact). `/HANDOFF_NEXT_SESSION.md` § 5 remains the NDV design-foundation
reference. The editor-shell items A–E are complete; see
`04-HANDOFF-editor-shell-outline-activity.md` for what each landed as and for the
decisions taken where the image described something the backend does not have.

**Current status doc: `11-HANDOFF-labels-fit-prefs-render-compare.md`** —
start here. It is written to be readable with no prior context. This pass closed
three defects that only a **real render** could surface: node cards were labelled
with raw action ids (`fill`, `wait`, `extract`) because `NODE_DISPLAY_NAMES`
covered 14 of 50 actions and the `nk.*` keys existed only in `en`; `fitToScreen`
ignored the overlays that live *inside* the canvas, sliding the first node under
the OUTLINE panel; and the palette/OUTLINE collapse state was not persisted
(`AppUtil.pref` / `setPref` over one `ab_ui_prefs` blob).

Its **§ 3 is the first systematic render-vs-design comparison** — G1…G13, ordered
by how much visual parity they cost, with the locked image that proves each one.
Its § 4 is a verified anchor table and § 5 the priority order. § 6 lists every
loose end, including the traps (`app.js` loads last, so `AppUtil` is absent at
module scope; the minimap must be charged to the cheapest canvas edge, not the
nearest; `shell-add-node-palette.webp` actually shows the NDV).

Previous status doc: `10-HANDOFF-run-node-shipped-port-add-launcher.md` — item
**N (per-node Run)** shipped (`POST /run-node` runs the chain *prefix*, tagged
`__runNode` with no `__workflowId` so a partial run never pollutes Executions or
the workspace stats), plus the chain-index/step-index fix, the circled `+` on
free output ports (the fifth Add Node entry point), the minimap viewport fix and
the launcher/brand parity pass.

Older status doc: `09-HANDOFF-item-N-per-node-run.md` — the implementation
spec and rationale for item N: why the *prefix* is sent rather than the single
step (the INPUT column would otherwise lie) and why it is not routed through
`API.runFlow()` (the server could not tell a partial run from a real one). Keep
it for the rejected-alternatives record; its § 2 is now history.

Previous status doc: `08-HANDOFF-addnode-contextmenu-groupbar.md` — closes
items **H**, **J** and **I**: the floating **Add Node** palette (four entry
points, including a connection dropped on empty canvas), the full nine-row
**node context menu** with node annotations (`label` / `note` / `color` /
`disabled`), and the **group-selection** blue dashed boundary + seven-button
action toolbar. `disabled` is honest: it changes what the serializer emits
(n8n-style pass-through). Read § 6 of that file for the remaining TODO — item
**N** (per-node Run, backend first), the 980px / RTL passes, the collapse
defaults, the 13-glyph icon rail, the minimap proportions, and the newly-spotted
circled `+` on free output ports.

Older status doc: `07-HANDOFF-fullbleed-editor-shell.md` — the editor is now
**full-bleed** (no app sidebar, no page heading; its own top bar starts at y=0,
the ACTIVITY LOG docks bottom-start inside the canvas and the MINIMAP sits
bottom-end with a stacked `+ − Fit` column, the status bar closes the screen),
exactly as `state-empty-canvas.webp` draws it. Its § 4 code anchors and § 5.6
do-not-"fix" list are still current.

Oldest kept status doc: `06-HANDOFF-visual-verification-a11y-statusbar.md` — it
supersedes `05-HANDOFF-palette-docs-followups.md`, records the palette a11y pass,
the collapsed icon rail, the minimap fix and the real `/health`-backed status bar,
and — most usefully — documents the **working headless-browser harness**
(`tools/ui-preview-server.js` + `tools/ui-shot.js`) that makes the UI verifiable
instead of assumed. The only remaining editor backlog is items **H / I / J / N**
of `04-HANDOFF` § 9.

Guard tests for this work: `tests/unit/editor-shell.test.ts` (top bar incl. the
six legacy ids, split menus, OUTLINE derivation, palette grouping + computed
counts, footer routes, ACTIVITY LOG contracts) and
`tests/unit/canvas-chrome.test.ts` (cluster anchors).

Every glyph in the UI is now an inline SVG served from `public/js/icons.js`
(82 icons, `currentColor`, CSP-safe). Emoji are banned from shipped front-end
code by `tests/unit/icons.test.ts`, and the generated node layout is locked to
a left-to-right pipeline by `tests/unit/graph-serialize.test.ts`.

## Rename map (history)
| Old name | New name |
|----------|----------|
| `candidate.webp` | `ndv-condition-final.webp` |
| `ui_ux (1) copy.webp` | `shell-editor-click-ndv.webp` |
| `ui_ux (2) copy.webp` | `shell-editor-condition-ndv.webp` |
| `ui_ux (3) copy.webp` | `shell-add-node-palette.webp` |
| `ui_ux (4) copy.webp` | `state-empty-canvas.webp` |
| `ndv-*-final.txt` | merged into matching `.md` then removed |

Lite JPGs renamed the same way inside `lite/`.

## Next product order
Type Text → Wait Element → Open URL → Launch Browser → Trigger  
(see process doc)
