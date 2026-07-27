# Shell Editor + Condition NDV — Implementation Spec

## Status
Visual LOCKED (full reviewed)
Backend: see `ndv-condition-final.md`

## Files
| Kind | Path |
|------|------|
| Full | `shell-editor-condition-ndv.webp` |
| Lite | `lite/shell-editor-condition-ndv.jpg` (~910×512) |
| Spec (condition) | `ndv-condition-final.md` |
| Spec (sibling click) | `shell-editor-click-ndv.md` |

---

## 1. Visual Contract (enough without opening the image)

### Layout diagram
```
┌─ Shell (top bar) ───────────────────────────────────────────┐
│ Logo · Workflow name · [Test][Save][Settings]            │
├──────┬─────────────────────────────────────────────────────┤
│ Side │  Canvas (graph + bezier wires + mini-map)        │
│ bar  │   ┌──────── Modal (Condition NDV) ─────────────┐  │
│ list │   │ Header: Condition / Check Login Status     │  │
│      │   │  ┌ INPUT │ CONDITION │ OUTPUT ┐            │  │
│      │   │  └───────┴───────────┴────────┘            │  │
│      │   └────────────────────────────────────────────┘  │
└──────┴─────────────────────────────────────────────────────┘
```

### Shell chrome (shared with all editor states)
- **Top bar**: logo (left) · workflow title `Aria Automate / E-commerce Price Monitor & Alert` · status `Draft` + last-saved timestamp · right actions `[Test Workflow]` (primary), `[Save]`, `[Settings]`, user avatar.
- **Left sidebar (node palette)**:
  - search box `Search nodes…`
  - accordion categories: `Triggers` · `Browser Actions` · `Flow Control` · `Data & Logic`
  - each item: icon + label + short hint on hover
- **Canvas**:
  - dot-grid background
  - nodes drawn as labelled rounded rectangles
  - wires are bezier curves, colour-coded by status (default/ok/error)
  - two `True` / `False` branch outputs when a Condition node is selected
  - **mini-map** at bottom-right (pan/zoom controls next to it)
- The modal sits **above** the canvas with the canvas blurred behind.

### Modal shell
- **Header**: title `Condition` · subtitle `Check Login Status` · status badge `Idle` · `[Run Node]` (primary) · `[X]` close.
- **3 columns**: `INPUT DATA` | `CONDITION` (Instructions tabs) | `OUTPUT`.
- Tabs (middle column): `Instructions` (active) · `Advanced` · `Error` · `Test`.

---

## 2. Field-by-field UI (in the visible Condition)

### INPUT DATA
- Tabs: `Schema` | `Table` | `JSON`
- Search box for incoming fields
- Tree of previous-node data; entries are **drag-chips** (drag into condition fields)

### CONDITION builder (middle column)
Top controls:
- `Evaluate mode` dropdown → `First match` / `All groups` (current: `First match`)
- `Max depth` number input (current: `5`) — UI recursion guard

Group 1 — `AND` (green badge, label `IF ALL match (AND)`):
- **Row 1 (expanded)**:
  - L1: `[Left source: Element attribute ▾]` · `[Attribute name: textContent]` · `[Operator: not equals ▾]` · `[Expected: logged-out]` · `fx`
  - L2: `[Selector: #login-status]` (full-width) · picker 🎯 · `fx`
- **Row 2 (collapsed)**: chip `exists · .user-name`
- `[+ Add condition (AND)]`

Divider: badge `OR` (slate-grey, between groups)

Group 2 — `AND` (green badge):
- Row 1 (collapsed): chip `exists · .error-message`
- Row 2 (collapsed): chip `contains · .error-message`
- `[+ Add condition (AND)]`

Footer: `[+ Add Group (OR)]` (multi-path UI is v2; v1 runtime = true/false only)

### OUTPUT (right column)
- Tabs: `Schema` | `Table` | `JSON` (mirror of INPUT)
- For Condition: shows evaluation result shape — see `ndv-condition-final.md` § "OUTPUT Data Schema"
  - `result`, `matchedPath`, `matchedGroup`, `evaluatedConditions[]` (each: `actual`, `result`), `paths[]`

---

## 3. Visual → Spec (L1 mapping)

Group 1, Row 1 (expanded):
- L1 source `Element attribute` + attr `textContent` ⇒ treat as **Element text** path (compile to `{operator, selector, expected}`); no `attribute` field is sent to backend in v1
- L1 operator `not equals`, expected `logged-out` ⇒ `not_equals`
- L2 selector `#login-status` ⇒ `selector: "#login-status"`
- Serialised → `{operator: "not_equals", selector: "#login-status", expected: "logged-out"}` (backend reads `innerText`)

Group 1, Row 2 (collapsed): `exists · .user-name` ⇒ `{operator: "exists", selector: ".user-name"}`

Group 2, Row 1: `exists · .error-message` ⇒ `{operator: "exists", selector: ".error-message"}`
Group 2, Row 2: `contains · .error-message` ⇒ `{operator: "contains", selector: ".error-message", expected: "Error"}` (default suggestion; user-editable)

Group combinator `AND` ⇒ `all[]`, divider `OR` ⇒ `any[]`.

Full engine rules (A/B/C, serialize, multi-path) → `ndv-condition-final.md` § 3–7. Do not duplicate here.

---

## 4. Click + selection behaviour (canvas ↔ modal)

- Click a node on canvas → it is **highlighted** (border + glow), its NDV opens in a modal.
- Click a different node → previous modal closes, new one opens.
- Click on the canvas background (outside modal) → **close with confirm** if dirty (unsaved changes).
- Modal `Run Node` (header): runs pipeline **only on this node's sub-graph**, distinct from `Test Workflow` in the top bar.
- Modal `[X]`: same close-with-confirm rule.

`[X]` and `Run Node` are per-node; the top bar `Test` and `Save` are workflow-scoped.

---

## 5. Params mapping (UI → backend)
- All condition-field A/B/C and serialize rules → `ndv-condition-final.md` § 3.
- Canvas interactions (drag, zoom, mini-map, pan): not backend-relevant; UI-only behaviour.

---

## 6. Action levels
- **A — Ready now**: open modal, show all fields per spec; wire condition engine per `ndv-condition-final.md` § 4.
- **B — Small add**: canvas-level `Run Node` (per-node run) — needs runner API to take a sub-graph.
- **C — Defer**: undo/redo of canvas drag; multi-select nodes; keyboard shortcuts beyond `Esc`/`Delete`.

---

## 7. Cross-references
- Condition UI, levels, serialize, OUTPUT schema: `ndv-condition-final.md`
- Sibling shell (Click Element open): `shell-editor-click-ndv.md` (same shell chrome, different modal payload)
- Shell chrome (canvas, sidebar, top bar) is shared across all `shell-editor-*.md` states — keep consistent.

---

## When to open full image
For any pixel-level decision (spacing, typography of group badges, modal border radius, sidebar icon sizes). Otherwise this spec + `ndv-condition-final.md` is enough.
