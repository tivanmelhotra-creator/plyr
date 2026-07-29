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
  not three, and opens on `Execution`.
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
| `shell-editor-launcher-menu` | Header App Launcher + six-area menu | `.webp` | `lite/*.jpg` | `.md` | ✅ built · launcher + menu + six-item sidebar + workflow tab strip + Export/Save split menus + blocks-palette groups done (§ 5 corrections box records the stale claims) |
| `ndv-condition-final` | Condition NDV focused | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`ndv-nodes.js`) · backend `source`/`attribute` executed |
| `ndv-click-element-final` | Click Element NDV focused | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`ndv-nodes.js`) · backend click extras executed |
| `shell-editor-click-ndv` | Full shell + Click NDV open | `.webp` | `lite/*.jpg` | `.md` | ◐ node cards / ports / connectors / status bar / **SVG icons** / **left-to-right pipeline layout** / **minimap header** / **floating canvas toolbar** done; Outline + Activity Log + top-bar chrome pending |
| `shell-editor-condition-ndv` | Full shell + Condition NDV open | `.webp` | `lite/*.jpg` | `.md` | ◐ `True`/`False` edge pills + selection glow done; per-node Run pending |
| `shell-add-node-palette` | Shell with add-node palette | `.webp` | `lite/*.jpg` | `.md` | ◐ category-derived modal glow + node context menu (4 of 9 items) done; floating Add Node palette / group toolbar / full context menu pending |
| `state-empty-canvas` | **Refreshed: full editor shell** (stem is historical) | `.webp` **(newest)** | `lite/*.jpg` *(stale)* | `.md` *(rewritten)* | ✅ built · top bar (items A–B) + OUTLINE rail (C) + blocks palette (D) + 4-tab ACTIVITY LOG (E) + **top-end** canvas toolbar & pill row + titled minimap; empty-state card still renders when the graph is empty |

Remaining work per screen is tracked, with file/line anchors, in
`/HANDOFF_2026-07-27_ICONS_LAYOUT.md` § 4 (items A-N, ordered by visual
impact). `/HANDOFF_NEXT_SESSION.md` § 5 remains the NDV design-foundation
reference. The editor-shell items A–E are complete; see
`04-HANDOFF-editor-shell-outline-activity.md` for what each landed as and for the
decisions taken where the image described something the backend does not have.

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
