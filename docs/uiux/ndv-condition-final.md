# Condition NDV — Implementation Spec

## Status
Visual LOCKED (full reviewed)  
Backend: see `ndv-condition-final.md`

## Files
| Kind | Path |
|------|------|
| Full | `ndv-condition-final.webp` |
| Lite | `lite/ndv-condition-final.jpg` |
| Spec (this file) | `ndv-condition-final.md` |
| Sibling click spec | `ndv-click-element-final.md` |


## Shared design tokens inferred from the screenshots
These tokens are consistent across the whole editor family. They should be treated as the default system unless a specific screen overrides them.

- **Canvas background:** near-black charcoal, approximately `#0B0F14` to `#0E1218`.
- **Surface / panel fill:** layered dark slate surfaces around `#0F141B`, `#11161E`, `#151C25`.
- **Border color:** low-opacity cool gray, roughly `rgba(255,255,255,0.08)` for passive surfaces and orange-tinted borders for selected / focused states.
- **Primary accent:** vivid orange, approximately `#FF8A1F` to `#FF9A1F`.
- **Secondary accent (browser / info blue):** bright cyan-blue around `#2BA6FF`.
- **Success:** vivid green, around `#2ECC71`.
- **Danger:** red around `#E45555`.
- **Warning / highlight:** amber and orange are used for active states, handles, and branch highlights.
- **Text primary:** very light gray / off-white around `#E8EDF4`.
- **Text secondary:** muted gray-blue around `#97A2B3`.
- **Disabled text:** desaturated gray around `#5E6876`.

### Layout scale
- Base spacing grid: **4 / 8 / 12 / 16 / 20 / 24 px**.
- Card radius: **10–12 px**.
- Modal radius: **14–16 px**.
- Input height: **32–36 px**.
- Primary button height: **34–36 px**.
- Sidebar row height: **28–30 px**.
- Section header height: **28–32 px**.
- Tabs height: **32 px**.
- Node card height: **48–58 px** depending on title/subtitle density.

### Typography
- Typeface looks like a modern geometric/neutral sans, closest to **Inter / SF Pro / system-ui**.
- Titles: semibold, 16–20 px depending on the level.
- Section labels: uppercase or small-caps feel, 11–12 px, wide tracking.
- Body text: 13–14 px.
- Micro labels and counters: 11–12 px.
- Numeric values in tables: 12–13 px, aligned for scanability.


## 1. Visual contract
This is a **logic-heavy condition editor modal** sitting on top of the workflow canvas. Compared with the Click Element modal, the center column is more structural and less form-like. The screen is intentionally organized around:
- **paths**
- **groups**
- **conditions**
- **result preview**

The modal is still a 3-column layout, but the center column is a visual builder rather than a linear property editor.

### Overall structure
- Left: input data tree
- Center: condition builder with tabs
- Right: output preview
- The builder area uses nested boxes, pills, and compact rows to express logical nesting without overwhelming the user.
- Green and red are used deliberately to represent the true / false branch outcome cards.

### Geometry notes
- Modal width is large enough that the center column can breathe; the builder is the visual focus.
- Each condition row is compact and horizontally aligned.
- Collapsed rows compress into a single chip-like summary so the builder stays readable at scale.
- The `OR` separator is centered and visually distinct from the `AND` badge used within groups.

## 2. Layout breakdown
### Header
- Title: `Check Login Status`
- Subtitle: `Condition`
- Status badge: green dot + `Idle`
- Primary action: orange `Run node`
- Close action: `X`
- The header uses the same shell rhythm as the Click Element modal, so the system feels consistent across node types.

### Left column — INPUT
- Column title: `INPUT`
- Tabs: `Schema`, `Table`, `JSON`
- Run selector: `Run 2 of 2`
- Search field: `Search input data...`
- Tree view of incoming data:
  - `response`
  - `data`
  - `meta`
- The tree exposes structured fields such as `status`, `statusCode`, `message`, `user`, `token`, `expiresAt`, `requestId`, `duration`.
- Bottom drag chips represent values that can be injected into the builder.

### Center column — Condition Builder
The center panel starts with:
- `Condition Builder`
- `Path 1` badge
- small `+` button for adding another path
- `+ Add path` on the upper-right of the builder header

#### Top-level controls
- The builder indicates the active logic mode with `All conditions must be met (AND)` for the visible group.
- Path controls support multiple groups and, visually, multiple paths.
- `Max depth` and `Evaluate mode` may appear in the companion logic spec; the screen emphasizes the visible path structure rather than raw engine tuning.

#### Group A
- Group header uses a green `AND` badge or a green semantic emphasis.
- First row is expanded and shows:
  - `Left source` dropdown: `Element attribute`
  - `Attribute name` field: `textContent`
  - `Operator` dropdown: `Not equals`
  - `Right value` field: `logged-out`
  - `fx` button on the value field
- Second line in the same row includes:
  - `CSS Selector`: `#login-status`
  - target picker icon
  - `fx` shortcut
- Row 2 is collapsed into a summary chip: `exists · .user-name`
- `+ AND` add button appears beneath the group to append another condition.

#### Between groups
- A centered `OR` pill divides group A and group B.
- The separator is visually stronger than a simple line because it changes the logical scope.

#### Group B
- Second group is another AND group.
- Rows are collapsed chip summaries:
  - `exists · .error-message`
  - `Contains · .error-message` / `textContent Contains "Error"` depending on the row state
- `+ AND` add button appears below this group as well.

#### Path footer
- Large dashed or bordered `+ OR (New group)` / `+ Add Group (OR)` area appears at the bottom of the builder.
- Two result cards are shown underneath:
  - True path (green)
  - False path (red)
- These cards communicate the branch outcome even before execution.

### Right column — OUTPUT
- Column title: `OUTPUT`
- Tabs mirror the left column: `Schema`, `Table`, `JSON`
- Search field: `Search output data...`
- The main output area is an empty-state style panel with a neutral illustration.
- Lower status strip shows:
  - `Status`
  - `Time`
  - `Size`

## 3. Pixel-level UI language
### Builder rows
- Expanded rows are multi-line cards with strong internal grid alignment.
- Collapsed rows are much shorter and function as summary chips.
- Left-to-right reading order matters: source → attribute → operator → expected → selector.
- Icons for duplicate / delete / collapse are compact and align to the far right of the row header.
- The builder has a subtle vertical rhythm that keeps nested content scannable.

### Path and branch colors
- `AND` inside a group: green semantic cue.
- `OR` between groups / add path: neutral or slightly blue-gray semantic cue.
- True path: green card, green accent outline.
- False path: red card, red accent outline.

### Empty output
- The output illustration sits in the middle of the panel.
- The panel is intentionally quiet so the data tree and builder remain primary.
- This screen is a logic editor; output is preview-only until execution.

## 4. Component behavior
### Expanded row
The visible expanded row should be treated as the canonical layout for a complex condition:
1. selector / source type
2. attribute name
3. operator
4. expected value
5. selector target line beneath
6. helper controls (`fx`, picker, etc.)

### Collapsed row
A collapsed row must read as a tiny logical statement:
- `exists · .user-name`
- `exists · .error-message`
- `contains · .error-message`

The summary string should be concise, human-readable, and serializable.

### Action icons
- Duplicate, delete, and collapse icons are positioned on the right edge of the row header.
- They should be small enough not to fight the row content.
- The row header itself remains clickable and feels like the primary interaction target.

### Path controls
- `+ Add path` increases the number of branches.
- `+ Add Group (OR)` adds another branch-level logical section.
- `+ AND` inserts another condition into the current group.
- These actions must be visually distinct so users do not confuse a row-level add with a path-level add.

## 5. Data / backend mapping
The visible screen suggests the following normalized condition model:

```json
{
  "paths": [
    {
      "groups": [
        {
          "logic": "AND",
          "conditions": [
            {
              "selector": "#login-status",
              "source": "textContent",
              "operator": "not_equals",
              "expected": "logged-out"
            },
            {
              "selector": ".user-name",
              "operator": "exists"
            }
          ]
        },
        {
          "logic": "AND",
          "conditions": [
            {
              "selector": ".error-message",
              "operator": "exists"
            },
            {
              "selector": ".error-message",
              "source": "textContent",
              "operator": "contains",
              "expected": "Error"
            }
          ]
        }
      ]
    }
  ],
  "resultShape": {
    "result": "boolean",
    "matchedPath": "string|null",
    "matchedGroup": "string|null",
    "evaluatedConditions": [],
    "paths": []
  }
}
```

### Mapping rules
- `Element attribute` + `textContent` should be treated as text extraction in v1.
- `Not equals` maps to `not_equals`.
- `Exists` maps to a simple selector existence check.
- `Contains` maps to substring search on visible text or extracted text content.
- The `fx` button indicates expression-bound values.
- The target picker icon indicates selector capture from the page.

## 6. Interaction contract
- The modal opens when the corresponding canvas node is selected.
- The builder should support fast expansion/collapse.
- Running the node should evaluate the builder and return the output schema on the right.
- The output preview should reflect the first matched path or the boolean false case.
- Unsaved changes should trigger confirm-on-close behavior.

## 7. Action levels
- **A — Ready now:** path/group/condition structure, true/false result cards, tree input, output tabs.
- **B — Small add:** stronger output JSON preview and visible path summarization in the right column.
- **C — Defer:** advanced expression engine beyond `fx`, nested path visualization beyond the current tree depth.

## 8. When to open the full image
Open `ndv-condition-final.webp` only for:
- exact group spacing
- path card dimensions
- row collapse / expand proportions
- `OR` divider thickness
- icon button sizing and placement
