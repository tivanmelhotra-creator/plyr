# State — Empty Canvas — Implementation Spec

## Status
Visual LOCKED (full reviewed)
Backend: READY (no NDV payload, shell-only state)
Theme: **DARK ONLY** (locked — matches full/lite images; no light variant)

> ## ⚠ REVISED 2026-07-29 — THE IMAGE WAS REFRESHED, THIS DOC WAS REWRITTEN
>
> `state-empty-canvas.webp` (now **1672×941**) is one of the three files carrying
> the **latest** design updates. It no longer shows an empty canvas at all: it
> shows the **fully populated editor** with both top-bar split menus open, so it
> is now the authoritative reference for the editor shell — and it **overrides**
> older images and older prose wherever they disagree.
>
> Everything below § 1 has been rewritten against the refreshed pixels. The
> superseded claims are listed in § 7 so nobody "restores" them later.
>
> House rule that governed the rewrite: **where the written spec and the image
> disagree, THE IMAGE WINS.**

## Files
| Kind | Path |
|------|------|
| Full | `state-empty-canvas.webp` (1672×941 — **refreshed**) |
| Lite | `lite/state-empty-canvas.jpg` (~910×512 — **stale, pre-refresh**) |
| Related specs | `shell-editor-launcher-menu.md`, `shell-add-node-palette.md`, `shell-editor-condition-ndv.md`, `shell-editor-click-ndv.md` |
| Handoff | `04-HANDOFF-editor-shell-outline-activity.md` |
| Guard test | `tests/unit/editor-shell.test.ts`, `tests/unit/canvas-chrome.test.ts` |

---

## Shared design tokens (LOCKED — same family as all shell/NDV specs)

- **Canvas background:** near-black charcoal `#0B0F14` – `#0E1218`
- **Surface / panel fill:** layered dark slate `#0F141B`, `#11161E`, `#151C25`
- **Border color:** `rgba(255,255,255,0.08)` passive; orange-tinted for selected/focus
- **Primary accent:** vivid orange `#FF8A1F` – `#FF9A1F`
- **Secondary accent (browser / info blue):** cyan-blue `#2BA6FF`
- **Success:** `#2ECC71`
- **Danger:** `#E45555`
- **Text primary:** `#E8EDF4`
- **Text secondary:** `#97A2B3`
- **Disabled text:** `#5E6876`
- **Typeface:** Inter / SF Pro / system-ui
- **Direction:** English LTR; canvas ports physical left/right only

### Layout scale
- Spacing: **4 / 8 / 12 / 16 / 20 / 24 px**
- Card radius: **10–12 px**
- Input height: **32–36 px**
- Primary button height: **34–36 px**
- Sidebar row height: **28–30 px**
- Top bar height: **~52–56 px**

---

## 1. Visual Contract (refreshed image, 1672×941)

```
┌─ Top Bar ───────────────────────────────────────────────────────────────────────────┐
│ [A] Aria Automate │ ⌂ Home │ ▤ Workspace ▾ │ (Login Flow ●)(Scraper) (+ New) │       │
│                                    ⟲ ⟳ │ [⤓ Export ▾] [▤ Save ▾] [■ Stop] 🔔 ⚙ (◉) │
│ / Login Flow  [Draft]                                        (hairline second line) │
├──────────────┬──────────────────────────────────────────────────────────────────────┤
│ BLOCKS       │ ┌ OUTLINE ─┐                      [▦ Auto Layout] [◎ Focus Mode]     │
│ 🔍 …    ⌘ K  │ │ 1 Launch │                      [⊹][✥][⛶] │ [+][100%][-]           │
│ ★ Favorites 3│ │ 2 Goto   │                                                         │
│ BLOCKS       │ │ 3 If     │        (dot-grid canvas with the flow's nodes)           │
│ ▸ Triggers 4 │ │  3a Click│                                                         │
│ ▸ Browser 10 │ │  3b Log  │                                            ┌──────────┐ │
│ ▸ Web Int 16 │ └──────────┘                                            │ MINIMAP  │ │
│ ▸ Flow Ctl 7 │                                                         └──────────┘ │
│ ▸ Online 5   ├──────────────────────────────────────────────────────────────────────┤
│ ▸ Data 8     │ ACTIVITY LOG   3 ok / 0 err / 3 · 1240ms      Auto-scroll (●) ⤓ ⌄    │
│ ─────────    │ Runs │ Execution │ Variables │ Logs                                  │
│ ▦ Templates  │ [All Runs ▾] [Clear]                                                 │
│ ⚙ Variables  │ ● Success  job_7f3  Login Flow  manual  1.2s  14:02:11               │
│ 🔗 Connections│ …                                                                    │
│ ⚙ Settings   │                                                                      │
│ ? Help&Docs  │                                                                      │
│ ◧ Collapse   │                                                                      │
└──────────────┴──────────────────────────────────────────────────────────────────────┘
```

Measured anchors (from the coordinate-grid analysis of the refreshed image and
of `shell-editor-launcher-menu.webp`):

| Cluster | Position | Note |
|---|---|---|
| Labelled view actions (`Auto Layout`, `Focus Mode`) | canvas **TOP-END**, 24px inset, own pill row | 30px tall pills |
| Pointer tools + fullscreen, zoom cluster | canvas **TOP-END**, `24 + 30 + 8 = 62px` from top | icon-only |
| OUTLINE rail | canvas **START edge**, `top:0; bottom:0`, ~236px wide | bbox `[142,53,273,524]` in the launcher image |
| MINIMAP | canvas **BOTTOM-END**, 24px inset | unchanged |
| ACTIVITY LOG | docked below the canvas | 4 tabs |

---

## 2. Component Breakdown

### A. Top Bar — item A of the handoff
Left to right: brand mark, the two editor-local nav links (`Home`,
`Workspace ▾` — the **same six product areas** as the shell launcher), the
**workflow tab strip** (real workflows from `API.listWorkflows()`, a `●` dot for
unsaved, plus a dashed-orange `+ New Workflow` chip), then the action group:
undo/redo pair, `Export ▾`, `Save ▾`, the **Run/Stop slot**, bell, gear, avatar.

Breadcrumb + status badge moved to a **hairline second line** (`.fe-crumbline`)
so row one belongs to the tab strip; the images never wrap the bar into two tall
rows.

**ONE slot, TWO states.** `state-empty-canvas.webp` shows a solid red `■ Stop`
while `shell-editor-launcher-menu.webp` shows the orange `▶ Test Workflow`. The
two images are not in conflict — they captured the **two states of one button**.
Implemented as a single `#fe-run` that swaps label/icon/tone (`.fe-runslot.is-stop`).

**Six legacy button ids** (`#fe-from-run`, `#fe-load`, `#fe-json`, `#fe-clear`,
`#fe-save`, `#fe-save-server`) are still emitted inside a hidden `.fe-legacy`
span. Their listeners are unguarded, so dropping one throws mid-render and blanks
the editor. Guarded by `editor-shell.test.ts`.

### B. Export ▾ / Save ▾ — item B
- **Export**: `Export as JSON`, `Export as Template`, `Export as PDF` *(disabled)*,
  divider, `Share Link` *(disabled)*, `Publish as Template` *(disabled)*. The
  three disabled entries have no renderer / share service / template registry
  behind them, so they are **visibly disabled with a tooltip** rather than
  silently no-op.
- **Save**: `Save Changes`, `Save as New Version`, divider, `Version History`
  header + up to three **real** versions counted down from the workflow's own
  `version` field (a v2 workflow shows `v2`, `v1`, and stops), divider,
  `Auto Save` toggle. With no version at all the menu says `No versions yet`.

> The image's `Version 1.3.7` string is **mock**. `package.json` carries the real
> app version and no front-end version constant exists, so no version string is
> invented in the UI.

### C. Blocks palette (start rail) — item D
Top to bottom: a **search row** (magnifier + input + a `⌘`/`Ctrl` + `K` key
hint that follows the actual platform), a scrolling list, and a pinned footer.

The list holds a `Favorites` row (count = the number of starred blocks, persisted
in `localStorage` under `ab_palette_favs`), a `BLOCKS` header, and the
collapsible category rows. Each block row reveals a star on hover; a starred row
keeps its star visible.

**THE 6-vs-7 DECISION (do not re-litigate).** The image shows seven rows
totalling **128** blocks. The real catalog has **six** categories and **fifty**
actions. The image's rows and counts are **MOCK**. Resolution is
**presentational**: `ACTION_CATALOG` stays the single source of truth (renaming
`cat` ids would corrupt every node colour, the NDV and `graphToSteps`), the
image's row vocabulary is mapped onto real categories, and every count is
**computed** from real members:

| image row | catalog category | real count |
|---|---|---|
| Triggers | `trigger` | 4 |
| Browser | `navigation` | 10 |
| Web Interaction | `interaction` | 16 |
| Flow Control | `flow` | 7 |
| Online Services | `integration` | 5 |
| Data | `data` | 8 |

Six rows, not seven: the image's `General` and `Elements` rows have **no catalog
members**, and a row with a fake count is exactly the fake-successful UI the
house rules forbid. Any category missing from the table is swept into a final row
rather than silently dropped.

**Footer destinations must be REAL.** `app.js#currentRoute()` silently rewrites
an unknown hash to `#/workspace`, so a plausible `#/templates` would not 404 — it
would quietly dump the user elsewhere. Actual wiring:

| entry | destination |
|---|---|
| `Templates` | `#/workspace?tab=templates` (a real `WS_TABS` tab) |
| `Variables` | no route — calls `RunPanel.showTab('variables')` |
| `Connections` | `#/workspace?tab=connections` |
| `Settings` | `#/settings` |
| `Help & Docs` | **disabled** — no docs view ships yet, tooltip says so |
| `Collapse` | collapses the rail to a 44px strip with a restore chip |

### D. OUTLINE rail — item C
**START edge**, flush against the palette, `top:0; bottom:0`, 236px wide;
collapses to a 26px full-height vertical `Outline ›` tab on the same edge.

The tree is **derived, never stored**: `FE.outline()` wraps
`GraphSerialize.outlineTree(graph)`. The panel keeps no second copy and does not
poll — it re-renders through `FE.onChange()`. Clicking a row calls
`FE.revealNode()`.

Because the rail occupies real canvas width, the canvas publishes it as
`--fe-ol-w` (236px open / 26px closed) and start-anchored overlays offset off
that variable instead of hardcoding a gap.

### E. Canvas chrome
Two stacked rows in the **top-end** corner: the labelled pills
(`Auto Layout`, `Focus Mode`) at 24px, and the icon-only tool + zoom cluster at
62px. The MINIMAP stays bottom-end. Below 980px the pills drop their text and
the rows tighten to a 12px inset.

### F. ACTIVITY LOG — item E
Header row: static `ACTIVITY LOG` label, the run tally in its **own** sibling
element (`#al-counts` — it used to be concatenated into the panel name), an
`Auto-scroll` switch, a download button, and the collapse chevron.

**FOUR tabs**: `Runs` · `Execution` · `Variables` · `Logs`, opening on
`Execution`. (The older launcher image showed three; the refreshed image wins.)

- **Runs** — six columns (Status, Run ID, Workflow, Trigger, Duration,
  Finished At) from `API.listJobs()`. No mock rows; an empty list says so.
- **Variables** — three columns (Name, Value, Source). `RunState` has **no**
  `variables` bag, and inventing one would store derived state twice. The
  truthful source is the graph: every `variable` action declares a name, so the
  set of variables **is** the set of those nodes. A runtime value comes from that
  step's output sample; until a run produces one the value column reads `—`.

---

## 3. Interactive UX Behavior

1. **Empty graph** — the centred empty-state card still renders when
   `nodes.length === 0` (`Start building your workflow` + `+ Add First Node`).
   The refreshed image simply does not capture that state any more.
2. **`⌘K` / `Ctrl+K`** — focuses the palette search, expanding the rail first if
   it was collapsed. Bound ahead of the "ignore while typing" guard so it works
   from anywhere.
3. **Search** — implicitly expands matching category rows (otherwise results
   would hide inside collapsed rows) and hides zero-hit rows rather than showing
   a `0`.
4. **Drag & drop** — ghost preview at `opacity: 0.7`; on drop the empty card
   fades out and the node renders at the drop coords.
5. **Undo / redo** — snapshot history, `HISTORY_LIMIT = 60`, enablement driven by
   `FE.canUndo()` / `FE.canRedo()`, cleared on document identity change.

---

## 4. Graph Serialization State (empty document)

```json
{
  "name": "E-commerce Price Monitor & Alert",
  "status": "draft",
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [],
  "edges": [],
  "steps": []
}
```

Chrome/view flags (`canvasTool`, `canvasLocked`, `gridVisible`, `minimapOpen`,
`paletteFavs`, `paletteOpen`, `paletteCollapsed`) are **module-level vars, never
on `state`** — they must not be serialised into a workflow or captured by an undo
snapshot. Guarded by test.

---

## 5. Implementation Status

| Item | Scope | State |
|---|---|---|
| A | Top bar: nav, tab strip, undo/redo, Run/Stop slot, bell/gear/avatar | **done** |
| B | Export ▾ / Save ▾ menus | **done** |
| C | OUTLINE rail (start edge, derived, collapsible) | **done** |
| D | Blocks palette: search + ⌘K, Favorites, six computed rows, footer, Collapse | **done** |
| E | ACTIVITY LOG: 4 tabs, Runs table, Variables, Auto-scroll, download | **done** |
| — | Canvas chrome relocated to top-end + pill row | **done** |

---

## 6. What is MOCK in this image (never implement)

| In the image | Why it is mock |
|---|---|
| Seven palette rows / 128 blocks | Catalog has six categories, fifty actions |
| `General`, `Elements` rows | No catalog members at all |
| `Version 1.3.7` | No front-end version constant exists |
| Per-row block counts (14/18/24/20/16/22/14) | Counts are computed from real members |

---

## 7. Superseded claims from the pre-refresh version of this doc

Recorded so they are not "restored" by someone reading an old copy:

| Old claim | Corrected |
|---|---|
| Canvas controls sit **bottom-right** | Tool + zoom cluster is **TOP-END**; only the MINIMAP is bottom-end |
| `Auto Layout` / `Focus Mode` live in the toolbar | They are a **separate labelled pill row ABOVE** it |
| OUTLINE is on the end edge | It is on the **START edge**, full height, flush to the palette |
| ACTIVITY LOG has three tabs | **Four** — `Runs`, `Execution`, `Variables`, `Logs` |
| Sidebar categories are `Triggers / Browser Actions / Flow Control / Data & Logic` with invented members | Six **real** catalog categories with computed counts |
| Two separate `Test Workflow` and `Stop` buttons | **One slot, two states** |
| Screen shows only the empty-canvas state | Refreshed image shows the **populated editor** with both split menus open |

## When to open full image
Only for pixel-level RGB of gradients/shadows. The layout is transcribed above,
including the corrected cluster anchors.
