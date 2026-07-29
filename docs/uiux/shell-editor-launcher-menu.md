# Editor Shell — App Launcher Menu — Implementation Spec

## Status
Visual **LOCKED** (full reviewed)
Backend: **READY** (pure navigation chrome — no payload)
Theme: **DARK ONLY**

## Files
| Kind | Path |
|------|------|
| Full | `shell-editor-launcher-menu.webp` (1024×576) |
| Lite | `lite/shell-editor-launcher-menu.jpg` (910×512) |
| Sibling | `workspace-overview.webp` (the Workspace half of the same change) |
| Related | `shell-editor-click-ndv.md`, `shell-add-node-palette.md`, `state-empty-canvas.md` |

---

## 0. What this screen adds over the earlier shell specs

The three earlier shell screens are still authoritative for the **canvas, node
cards, palette, NDV and status bar**. This one changes exactly one thing and
must not be read as a redesign of the rest:

> The header no longer lists navigation links (`Home`, `Workspace`, …).
> It shows the brand, then a single **App Launcher** button — a 2×2 grid of
> squares, Windows-11 style — which opens a small floating menu holding the six
> product areas.

Everything else visible here (workflow tabs, Export/Save/Stop cluster, blocks
palette, outline tree, Activity Log, minimap, status bar) is documented below at
the level needed to keep the existing implementation honest.

---

## 1. Shared design tokens (LOCKED)

Identical to `state-empty-canvas.md`: canvas `#0B0F14`, panels `#0F141B` /
`#11161E` / `#151C25`, border `rgba(255,255,255,0.08)`, accent `#FF8A1F`,
info-blue `#2BA6FF`, success `#2ECC71`, danger `#E45555`, text `#E8EDF4` /
`#97A2B3` / `#5E6876`, radius `10–12px`, top bar `52–56px`.

---

## 2. The App Launcher (the locked change)

### Button
- Sits in the header immediately after the brand, `34×34px`, radius `9px`.
- Glyph: four `7×7` rounded squares on a `2×2` grid with a `3px` gutter
  (registry name **`grid`**).
- **Idle**: transparent background, `#97A2B3` glyph.
- **Hover**: `rgba(255,255,255,0.06)` background, `#E8EDF4` glyph.
- **Open (as pictured)**: solid orange `#FF8A1F` fill, near-black glyph
  (`#0B0F14`), plus a `0 0 0 3px rgba(255,138,31,0.18)` glow ring.
- `aria-haspopup="menu"`, `aria-expanded` mirrors the panel, `aria-label="Open app launcher"`.

### Floating panel
- Anchored under the button, offset `8px` down / `0` inline-start.
- `width 196px`, `padding 8px`, background `#111318` (`#11161E` family),
  `border 1px rgba(255,255,255,0.08)`, `radius 12px`,
  `box-shadow 0 18px 44px rgba(0,0,0,0.55)`, `z-index` above the canvas chrome.
- `role="menu"`; items are `role="menuitem"` buttons, height `36px`,
  `padding 0 10px`, `radius 8px`, gap `10px`, label `13px/500` `#E8EDF4`,
  icon `16px` `#97A2B3`.
- Hover / `:focus-visible`: `rgba(255,255,255,0.05)`, icon → `#E8EDF4`.
- Current area: orange-tinted (`rgba(255,138,31,0.12)` + `#FF8A1F` text) and
  `aria-current="page"`.
- **Items, in this exact order (same six as the sidebar):**

  | # | Label | Icon | Route |
  |---|-------|------|-------|
  | 1 | Home | `home` | `#/home` |
  | 2 | Workspace | `layout` | `#/workspace` |
  | 3 | Dashboard | `bar-chart` | `#/dashboard` |
  | 4 | Jobs | `layers` | `#/jobs` |
  | 5 | Admin | `shield` | `#/admin` |
  | 6 | Settings | `settings` | `#/settings` |

### Behaviour
- Toggle on click; close on outside click, on `Esc` (focus returns to the
  button), on route change, and on window blur.
- `ArrowDown` / `ArrowUp` cycle items, `Home`/`End` jump, `Enter`/`Space`
  activate. Never trap focus permanently — `Tab` closes and moves on.
- The identical component is used by the Workspace screen's header, so it lives
  in the shell (app-level), not inside the editor view.

---

## 3. Header, inline-end of the launcher

```
[◎ Aria Automate] [⊞]   ( Login Flow ● )( Payment Flow )( Instagram Bot )( Scraper )( + New Workflow )
                                        ↶ ↷  [⇪ Export ▾] [💾 Save ▾] [■ Stop] 🔔 ⚙ (avatar)
```

- **Workflow tabs**: open workflows as pill tabs, `13px`, height `30px`,
  radius `8px`. Active = `#151C25` fill, `#E8EDF4` text, `1px` orange-tinted
  border and a `6px` orange dot after the label when it has unsaved changes.
  Idle = transparent, `#97A2B3`. `+ New Workflow` is a muted ghost tab.
- **Undo / Redo**: `rotate-ccw` / `rotate-cw` icon buttons, disabled when the
  respective history stack is empty.
- **Export ▾** / **Save ▾**: dark split buttons (`#151C25`, `1px` border,
  radius `8px`, `13px`). Export menu: `JSON`, `cURL`, `n8n node`. Save menu:
  `Save`, `Save as…`, `Save version`.
- **Stop**: solid `#E45555`, white label, only present while a run is active;
  it is replaced by the orange `▶ Test Workflow` button when idle.
- Then `bell`, `settings`, `32px` avatar.

---

## 4. Left blocks palette (as pictured)

- `width 240–260px`, background `#0F141B`, right border `rgba(255,255,255,.08)`.
- Search input with `search` icon, placeholder `Search blocks...`, and a
  `⌘K` hint chip on the inline-end.
- `★ Favorites` row with count chip `12` and a chevron.
- Section label `BLOCKS` — `11px/600`, `letter-spacing .05em`, `#5E6876`.
- Category rows (`28–30px`): icon + name + count chip + `chevron-down`:
  `General 14`, `Browser 18`, `Web Interaction 24`, `Elements 20`,
  `Flow Control 16`, `Online Services 22`, `Data 14`.
- `Online Services` is expanded in the image and lists brand-tinted children:
  Google Sheets, Google Drive, Gmail, Slack, Discord, Telegram, Airtable,
  Notion. Child rows are `26px`, indented `18px`, `12–13px`.
- Bottom block, separated by a hairline: `Templates`, `Variables`,
  `Connections`, `Settings`, `Help & Docs`, then `← Collapse`, then
  `Version 1.3.7` in `11px` `#5E6876`.
- **Note:** the palette's `Settings` / `Connections` entries are *editor-scoped*
  (this workflow's settings and credentials) — they are not the sidebar's
  product-level Settings. Keep the labels, but route them to the workflow.

---

## 5. Canvas, outline, Activity Log, minimap, status bar

These match the earlier shell specs; recorded here only as a consistency check.

> ### ⚠ CORRECTIONS 2026-07-29 (this section had three stale claims)
>
> `state-empty-canvas.webp` was refreshed and is now the **newer** capture of the
> same shell. Where the two disagree, the refreshed one wins. Also, some claims
> below were simply mis-transcribed from *this* image. Corrected:
>
> | stale claim in this section | corrected |
> |---|---|
> | Activity Log tabs are `Runs · Variables · Logs` (three) | **FOUR**: `Runs · Execution · Variables · Logs`, opening on `Execution` (refreshed image) |
> | Outline tree is an overlay "on the canvas inline-start" | It is a **full-height rail on the START edge**, flush against the palette — measured bbox `[142,53,273,524]` in *this* image. It occupies real canvas width (`--fe-ol-w`: 236px open / 26px collapsed), it is not a floating overlay. |
> | (unstated) canvas tool + zoom controls sit near the minimap | They are in the canvas **TOP-END** corner — measured bbox `[788,80,977,114]` here — with the two **labelled** view actions (`Auto Layout`, `Focus Mode`) on their own pill row directly above at a 24px inset. The minimap alone is bottom-end. |
>
> The palette counts in § 4 are **MOCK** — see the 6-vs-7 decision table in
> `state-empty-canvas.md` § 2C and `04-HANDOFF` § 8. Six real categories, fifty
> actions, every count computed. `General` and `Elements` have no catalog members
> and are therefore not rendered at all.
>
> § 4's routing note ("route them to the workflow") could not be honoured either:
> there is no workflow-scoped settings or credentials view. `Settings` goes to the
> product-level `#/settings`, `Connections` and `Templates` deep-link real
> Workspace tabs (`#/workspace?tab=…`), `Variables` opens the ACTIVITY LOG's
> Variables tab, and `Help & Docs` renders **disabled** because no docs view
> ships. `app.js#currentRoute()` silently rewrites unknown hashes to
> `#/workspace`, so an invented route would have looked like it worked.
>
> `Version 1.3.7` and the status-bar values are mock; no front-end version
> constant exists.

- **Nodes**: `#151C25` cards, radius `10px`, `1px` border (orange-tinted while
  selected), a category-tinted `28×28` icon tile, title `13px/600`, subtitle
  `11px` `#5E6876`, a `more-vertical` button, and a small state badge
  (`check` green / `x` red) on the inline-end of the header.
- **Edges**: orange `#FF8A1F` for the happy path; the Condition node emits two
  labelled pills — `True` on `rgba(46,204,113,.15)`/`#2ECC71` and `False` on
  `rgba(228,85,85,.15)`/`#E45555`.
- **Outline tree** (full-height rail on the canvas START edge, *not* a floating
  overlay — see the corrections box above): numbered steps
  (`4.1.1`, `4.1.2.1`, …) with `11–12px` rows, `14px` indent per level, the
  branch labels `True` / `False` as group headers.
- **Activity Log** (bottom dock): tabs `Runs` · `Execution` · `Variables` ·
  `Logs` — **four**, per the refreshed `state-empty-canvas.webp`; this image
  shows three, and the newer one wins
  (active = orange underline), an `Auto-scroll` switch (orange when on), a
  `download` button and a `chevron-up/down` collapse. Below: an `All Runs`
  select + `Clear` button, then a table
  `Status · Run ID · Workflow · Trigger · Duration · Finished At` with
  `#2ECC71` / `#E45555` dots and `12px` monospace-ish ids.
- **Minimap** (bottom inline-end): titled header `MINIMAP` + close `x`,
  `180×128` body with `24px` inset, vertical `+` / `-` / `fit` cluster.
- **Status bar**: `Version 1.3.7` · `Auto-save enabled ●` · `Last saved:
  10:24:32` · `Workflow ID: wf_login_001` · `Environment: Production ●`.
  Values must be real; never fake a placeholder.

---

## 6. Params mapping

| UI element | Backend / source | Status |
|------------|------------------|--------|
| Launcher menu items | static route table | **A** ready |
| Workflow tabs | open-workflow list (client state) + `GET /workflows/:userId` | **A** ready |
| Save / Save as | `PUT` / `POST /workflows/:userId` | **A** ready |
| Stop | `DELETE /cancel/:userId/:jobId` | **A** ready |
| Activity Log rows | `GET /jobs/:userId` + live SSE/WS stream | **A** ready |
| Status bar cells | open workflow record + last-saved clock | **A** ready |
| Palette counts | `ACTION_CATALOG` group sizes | **A** ready |
| Online Services children | integration catalog | **C** later |

---

## 7. Do not implement yet
- Real integration nodes behind `Online Services` (icons only for now).
- Multi-tab persistence of open workflows across reloads.
- Collaborative cursors / presence in the header.

---

## 8. Accessibility
- Launcher: `aria-haspopup`, `aria-expanded`, `role="menu"`, arrow keys, `Esc`.
- Workflow tabs: `role="tablist"` / `role="tab"` with `aria-selected`.
- `Stop` announces `aria-live="polite"` run-state changes.
- Icons stay `aria-hidden`; names live on the controls.
