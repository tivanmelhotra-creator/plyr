# Workspace — Workflow Management Hub — Implementation Spec

## Status
Visual **LOCKED** (full reviewed)
Backend: **GAPS** (see § 6 — `active` / `liveBrowser` flags + aggregate stats)
Theme: **DARK ONLY** (same token family as every other shell/NDV spec)

## Files
| Kind | Path |
|------|------|
| Full | `workspace-overview.webp` (1024×576) |
| Lite | `lite/workspace-overview.jpg` (910×512) |
| Source report | `01-REPORT-ui-architecture-update.md` |
| Sibling | `shell-editor-launcher-menu.webp` (the editor half of the same change) |

---

## 0. Why this screen exists

Before this change the product sidebar carried **ten** entries, four of which
(`Live View`, `Live Browser`, `Schedules`, `Active Flow`) are not places in the
product at all — they are *capabilities of one workflow*. The result was a
navigation tree that grew with every feature and a user who had to know which
workflow a global "Live Browser" page was talking about.

The locked architecture is:

```
Workspace       = manage every automation   (this screen)
Workflow Editor = build & run one automation (shell-editor-launcher-menu.webp)
Live Browser / Schedules / Executions = per-workflow capabilities
```

So the sidebar shrinks to the six real product areas, and everything that is
scoped to a single workflow moves onto that workflow's row / editor.

---

## 1. Shared design tokens (LOCKED — identical to the shell/NDV specs)

- **Canvas background:** near-black charcoal `#0B0F14` – `#0E1218`
- **Surface / panel fill:** layered dark slate `#0F141B`, `#11161E`, `#151C25`
- **Border color:** `rgba(255,255,255,0.08)` passive; orange-tinted when selected
- **Primary accent:** vivid orange `#FF8A1F` – `#FF9A1F`
- **Secondary accent (browser / info blue):** `#2BA6FF`
- **Success:** `#2ECC71` · **Danger:** `#E45555` · **Warning/amber:** `#F5A623`
- **Violet (schedules):** `#8B7BFF` · **Text primary:** `#E8EDF4`
- **Text secondary:** `#97A2B3` · **Disabled text:** `#5E6876`
- Spacing scale **4 / 8 / 12 / 16 / 20 / 24 px**, card radius **10–12 px**,
  input height **32–36 px**, top bar **~52–56 px**

---

## 2. Visual contract (enough without opening the image)

```
┌── Sidebar 248px ──┬── Top bar ────────────────────────────────── [🔔][⚙][avatar ▾] ┐
│ ◎ Aria Automate   │ [⊞ launcher]                                                   │
│                   ├────────────────────────────────────────────────────────────────┤
│ ⌂ Home            │ Workspace                             ┌───────────────────┐    │
│ ▣ Workspace  ←ACT │ Manage all workflows, schedules,      │ + New Workflow │ ▾ │    │
│ ▤ Dashboard       │ live browsers and automation stats.   └───────────────────┘    │
│ ▦ Jobs            │                                                                │
│ ⛨ Admin           │ ┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐                    │
│ ⚙ Settings        │ │ 18 ││ 42 ││ 16 ││98.4││ 23 ││  7 ││  4 │  ← 7 stat cards     │
│                   │ └────┘└────┘└────┘└────┘└────┘└────┘└────┘                    │
│                   │ Workflows | Templates | Executions | Schedules | Connections   │
│                   │ ▔▔▔▔▔▔▔▔▔        [🔍 Search workflows…][Sort ▾][▽][▤]          │
│                   │ ┌────────────────────────────────────────────────────────────┐ │
│                   │ │ Workflow │Owner│Last Run│Success│Status│Live Br.│Sched│ ⋮  │ │
│                   │ │ ⚡ Login Flow Automation … 100% ▮▮▮▮ [ON]Active [ON]👁 5 ⋮ │ │
│                   │ │ … 6 rows …                                                 │ │
│                   │ └────────────────────────────────────────────────────────────┘ │
│ 👤 Naresh         │ Showing 1 to 6 of 42 workflows      ‹ 1 2 3 … 7 ›  10 / page ▾ │
│    Administrator ▾│                                                                │
└───────────────────┴────────────────────────────────────────────────────────────────┘
```

---

## 3. Component-by-component breakdown

### A. Sidebar (the whole point of the change)

- **Container**: `width: 248px`, background `#0F141B`, right border
  `1px solid rgba(255,255,255,0.08)`, full height, flex column.
- **Brand**: orange infinity/loop mark `18px` + `Aria Automate` `14px/600`.
- **Nav — EXACTLY these six rows, in this order**:

  | # | Label | Icon (registry name) | Route |
  |---|-------|----------------------|-------|
  | 1 | Home | `home` | `#/home` |
  | 2 | Workspace | `layout` | `#/workspace` |
  | 3 | Dashboard | `bar-chart` | `#/dashboard` |
  | 4 | Jobs | `layers` | `#/jobs` |
  | 5 | Admin | `shield` | `#/admin` |
  | 6 | Settings | `settings` | `#/settings` |

- **REMOVED from the sidebar (locked):** `Live View`, `Live Browser`,
  `Schedules`, `Active Flow`. They are per-workflow capabilities now and are
  reachable **only** from a workflow row / the editor. (`Run Flow`, `Visual
  Editor` and `Quota` also leave the sidebar: the editor is opened *from* a
  workflow, and Quota lives under Settings.)
- **Active row**: soft orange-tinted pill `rgba(255,138,31,0.12)`, text
  `#FF8A1F`, a `3px` orange bar hugging the inline-start edge, radius `10px`.
- **Idle row**: `#97A2B3` text + `1.7px` stroke outline icon; hover
  `rgba(255,255,255,0.04)`.
- **Row metrics**: height `40px`, padding `0 12px`, gap `10px`, `13–14px/500`.
- **Footer user block**: `32px` circular avatar, name `13px/600` `#E8EDF4`,
  role `11px` `#5E6876`, trailing `chevron-down` — opens the account menu.

### B. Top bar

- Height `52–56px`, background `#0B0F14`, bottom border `rgba(255,255,255,.08)`.
- **Inline-start:** the **App Launcher** button only (no nav links — nav links in
  the header were the thing being removed). `34×34px`, radius `9px`, a 2×2 grid
  of squares like the Windows 11 launcher. Idle: `#97A2B3` on transparent;
  hover: `rgba(255,255,255,0.06)`; **open**: solid orange `#FF8A1F` fill, dark
  glyph, `0 0 0 3px rgba(255,138,31,.18)` glow ring.
- **Inline-end:** `bell` (notifications, with a dot when unread), `settings`
  gear, `32px` avatar + `chevron-down`.
- Clicking the launcher opens the floating menu specified in
  `shell-editor-launcher-menu.md` § 2 — the **same** component on both screens.

### C. Page header

- Title `Workspace` — `26px/700`, `#E8EDF4`.
- Subtitle `Manage all workflows, schedules, live browsers and automation
  statistics.` — `13px`, `#97A2B3`, margin-top `4px`.
- **Split primary button**, inline-end aligned:
  `[ + New Workflow ] | [ ▾ ]` — orange `#FF8A1F`, white text `14px/600`,
  height `40px`, radius `10px`, a `1px rgba(0,0,0,.18)` divider before the
  caret. Main part = create blank + open editor. Caret = menu
  (`From template…`, `Import JSON…`, `Duplicate existing…`).

### D. Stat cards — 7 cards, LOCKED ORDER

Row of 7 equal cards: `background #11161E`, `border 1px rgba(255,255,255,.08)`,
`radius 12px`, `padding 14px`, `min-height 104px`, gap `12px`
(`grid-template-columns: repeat(7, minmax(0,1fr))`; wraps to 4 then 2 below
1280 / 900px).

Card anatomy, top to bottom:
1. Row: `32×32` rounded-`9px` icon tile (12% tint of the card's tone) + title
   `11px/600` `#97A2B3`, `letter-spacing .02em`.
2. Big value `28px/700` `#E8EDF4`, `line-height 1.1`.
3. Footer: `6px` bullet dot in the card tone + sub-label `11px` `#5E6876`.

| # | Title | Value | Sub-label | Icon | Tone |
|---|-------|-------|-----------|------|------|
| 1 | Active Schedules | `18` | Schedules running | `calendar` | violet `#8B7BFF` |
| 2 | Total Flows | `42` | All workflows | `sitemap` | blue `#2BA6FF` |
| 3 | Active Flows | `16` | Currently active | `check-circle` | green `#2ECC71` |
| 4 | Overall Success Rate | `98.4%` | Success rate | `target` | green `#2ECC71` |
| 5 | Failures | `23` | Failed runs | `alert-triangle` | red `#E45555` |
| 6 | Active Jobs | `7` | Jobs in progress | `briefcase` | amber `#F5A623` |
| 7 | Live Browsers | `4` | Browsers active | `globe` | blue `#2BA6FF` |

> The written report lists Total Flows first; the **locked image** puts Active
> Schedules first. The image wins (it is the approved artefact) — the counts,
> labels and sub-labels are exactly as tabled above.

### E. Tab bar + list controls

- Tabs: `Workflows` · `Templates` · `Executions` · `Schedules` · `Connections`.
  `13px/600`; active `#E8EDF4` with a `2px` orange underline flush to the strip
  border; idle `#97A2B3`.
- Strip has a `1px` bottom border spanning the full content width.
- Inline-end controls, all `34px` tall:
  - Search: pill (`radius 999px`), `search` icon + placeholder
    `Search workflows...`, width `~210px`, background `#11161E`.
  - Sort select: `Sort by: Last updated` + `chevron-down`
    (options: Last updated · Name · Success rate · Last run).
  - `filter` icon button in a `34×34` bordered square.
  - `layout` (columns/density) icon button in a `34×34` bordered square.

### F. Workflow table

Wrapper: `#11161E`, `border 1px rgba(255,255,255,.08)`, `radius 12px`,
`overflow hidden`. Header row `#0F141B`, `11px/600` `#97A2B3`, height `40px`;
body rows height `56px` separated by `1px rgba(255,255,255,.05)`; row hover
`rgba(255,255,255,0.02)`.

Columns (sortable ones carry a `arrows-vertical` affordance):
`Workflow` · `Owner ⇅` · `Last Run ⇅` · `Success Rate ⇅` · `Status ⇅` ·
`Live Browser ⇅` · `Schedules` · `Actions`.

Cell rules:
- **Workflow**: `32×32` radius-`9px` icon tile tinted per workflow kind, then
  name `13px/600` `#E8EDF4` over description `11px` `#5E6876` (single line,
  ellipsised).
- **Owner**: pill `rgba(255,255,255,.05)` + `1px` border, `user` icon for
  `Personal` / `users` icon for `Team`, `11px`.
- **Last Run**: status dot (`#2ECC71` success · `#E45555` failed ·
  `#F5A623` running) + relative time `12px` `#E8EDF4`, and beneath it the
  outcome word tinted to match (`Success` / `Failed`).
- **Success Rate**: percent `12px/600` above a `4px` radius-`999px` track
  (`rgba(255,255,255,.07)`) whose fill width = the percentage. Fill tone:
  `≥ 95%` green, `80–95%` amber, `< 80%` red.
- **Status**: `36×20` toggle + word. ON = orange track `#FF8A1F` + white knob +
  `Active`; OFF = `rgba(255,255,255,.12)` track + `Inactive` `#5E6876`.
- **Live Browser**: `36×20` toggle **plus** a `28×28` eye button. See § 4 for
  the three-state truth table — this is the part reviewers check first.
- **Schedules**: `calendar` icon + `N schedules` (`1 schedule` singular),
  `12px` `#97A2B3`. Clicking opens that workflow's Schedules drawer.
- **Actions**: `more-vertical` button → the per-workflow menu of § 5.

### G. Footer

- Inline-start: `Showing 1 to 6 of 42 workflows`, `12px` `#5E6876`.
- Inline-end: `chevron-left` · page chips (`28×28`, radius `8px`; active = solid
  orange, white text) · `…` gap · last page · `chevron-right`, then a
  `10 / page` select (`10 / 25 / 50 / 100`).

---

## 4. Live Browser × Active — the three locked states

`Live Browser` is a **per-workflow capability**, and a browser session can only
exist while the workflow is allowed to run. Hence:

| # | Flow status | Live Browser toggle | Eye button | Meaning |
|---|-------------|--------------------|------------|---------|
| 1 | **Active** | ON (orange) | **enabled**, `#97A2B3`, hover orange, clickable | a real session exists / will exist → open the viewer |
| 2 | **Inactive** | ON (**gray**, not orange) | **disabled**, `#3A424E`, `cursor: not-allowed`, `aria-disabled="true"` | intent is remembered, but nothing runs, so there is no browser to watch |
| 3 | **Active** | OFF | **disabled/hidden**, gray | the user opted out of streaming this workflow |

Locked consequences of `Status = Inactive` (rows 3 and 5 in the image):
- the workflow does not execute (manual run and schedules both refuse),
- it creates no Jobs,
- its Live Browser is not viewable, whatever the Live Browser toggle says.

Tooltip copy on a disabled eye: `Activate the workflow to watch its browser`.

---

## 5. Per-workflow actions menu (`⋮`)

Panel `#151C25`, `radius 10px`, `border 1px rgba(255,255,255,.08)`,
`shadow 0 8px 30px rgba(0,0,0,.45)`, width `~210px`, items `32px`,
`13px`, icon + label, destructive item in `#E45555`, one divider before it.

```
Open Editor      pencil
Live Browser     eye          (disabled per § 4)
Schedules        calendar
Executions       history
Connections      git-branch
Settings         settings
Duplicate        copy
Export           download
─────────────────────────
Delete           trash
```

These eight entries are exactly the items the report moves **off** the sidebar.

---

## 6. Params / data mapping (UI → backend)

| UI field | Source | Status |
|----------|--------|--------|
| Total Flows | `GET /workflows/:userId` → `count` | **A** ready |
| Active Schedules | `GET /schedules/:userId` → `count` | **A** ready |
| Active Flows | count of `workflow.active === true` | **B** needs the flag |
| Overall Success Rate | completed ÷ (completed+failed) over recent jobs | **B** aggregate |
| Failures | failed job count | **B** aggregate |
| Active Jobs | `waiting + active + delayed` | **B** aggregate |
| Live Browsers | `GET /health` → `browsers.total` | **A** ready |
| Row · name / description | `workflow.name` / `.description` | **A** ready |
| Row · Owner | `Personal` unless `workflow.owner === 'team'` | **B** field |
| Row · Last Run + outcome | newest job for that workflow id | **B** aggregate |
| Row · Success Rate | per-workflow completed ÷ total | **B** aggregate |
| Row · Status toggle | `workflow.active` | **B** field |
| Row · Live Browser toggle | `workflow.liveBrowser` | **B** field |
| Row · Schedules count | schedules whose name matches the workflow | **A** ready |

### B — backend additions shipped with this screen
1. `Workflow.active` (default `true`) and `Workflow.liveBrowser`
   (default `false`) persisted by `WorkflowService`, preserved across
   `update()` unless explicitly changed, and snapshotted into version history.
2. `PATCH /workflows/:userId/:workflowId/state` — toggle-only endpoint taking
   `{ active?, liveBrowser? }`. It must **not** bump the workflow version:
   flipping a switch is not a new design of the automation.
3. `GET /workspace/:userId/stats` — one call returning every number the seven
   cards need plus `perWorkflow` rollups for the table.
4. **Run gating**: `POST /workflows/:userId/:workflowId/run` returns
   `409 { error: 'Workflow is inactive' }` while `active === false`, so state 2
   of § 4 is enforced by the server and not merely by a disabled button.

### C — deferred (do not build now)
- Team ownership / sharing (`owner` is rendered, always `Personal` for now).
- `Templates`, `Executions`, `Connections` tabs beyond their empty states.
- Column chooser behind the `layout` button (button renders, opens density only).

---

## 7. Do not implement yet
- Bulk selection checkboxes / bulk enable-disable.
- Drag-reorder of rows, saved views, tag filters.
- A light theme. Dark is locked.

---

## 8. Accessibility
- Toggles are real `<button role="switch" aria-checked>`; the eye is a
  `<button aria-disabled>` that keeps its tooltip when disabled.
- The launcher button is `aria-haspopup="menu" aria-expanded`; the panel is
  `role="menu"`, arrow-key navigable, `Esc` closes and restores focus.
- The table is a real `<table>` with `<th scope="col">`; sortable headers expose
  `aria-sort`.
- Every icon stays `aria-hidden="true"` — the accessible name lives on the
  wrapping control (see `public/js/icons.js`).
