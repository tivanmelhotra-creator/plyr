# Shell Editor + Click Element Flow — Implementation Spec

## Status
Visual LOCKED (full reviewed)  
Backend: shell canvas state only

## Files
| Kind | Path |
|------|------|
| Full | `shell-editor-click-ndv.webp` |
| Lite | `lite/shell-editor-click-ndv.jpg` |
| Spec (this file) | `shell-editor-click-ndv.md` |
| Node modal spec | `ndv-click-element-final.md` |


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
This image is the **main workflow editor shell** with the canvas fully visible. Unlike the modal screenshots, the focus here is on:
- canvas composition
- node chain readability
- outline tree structure
- activity log density
- minimap behavior

The canvas contains a live automation flow with a strong hierarchy: trigger, initialization, authentication, conditional branch, cleanup.

## 2. Layout breakdown
### Top shell bar
- Left brand: `Aria Automate`
- Workspace / navigation row:
  - `Home`
  - `Workspace`
  - active flow `Login Flow`
  - `Payment Flow`
  - `Instagram Bot`
  - `Scraper`
  - `+ New Workflow`
- Right top actions:
  - undo / redo
  - `Export`
  - `Save`
  - red `Stop`
  - bell
  - settings
  - user avatar
- Top bar height is compact; it never dominates the canvas.

### Left sidebar
- Search box: `Search blocks...`
- Category list:
  - `Favorites`
  - `General`
  - `Browser`
  - `Web Interaction`
  - `Elements`
  - `Flow Control`
  - `Online Services`
  - `Data`
  - `Templates`
  - `Variables`
  - `Connections`
  - `Settings`
  - `Help & Docs`
  - `Collapse`
- Counts appear right-aligned beside categories.

### Outline panel (left inner panel)
The outline is open and shows the workflow structure as a nested tree:
- `Trigger`
  - `Webhook`
- `Initialize`
  - `Launch Browser`
  - `Open URL`
- `Authentication`
  - `Wait Element`
  - `Type Text`
  - `Click Element`
- `Condition`
  - `Check Login Status`
  - `True`
    - `Extract Data`
    - `Parse JSON`
    - `Google Sheets`
    - `Webhook`
  - `False`
    - `Delay`
    - `Click Element`
- `Cleanup`
  - `Close Browser`

This outline acts as a structural mirror of the canvas graph and should remain synchronized with it.

### Canvas graph
- Dark dotted grid background.
- Nodes are arranged in a left-to-right pipeline for the main route.
- The upper lane contains:
  - `Trigger` / `Webhook`
  - `Launch Browser`
  - `Open URL`
  - `Wait Element`
  - `Type Text`
  - `Click Element`
- A lower route contains:
  - `Webhook`
  - `Google Sheets`
  - `Parse JSON`
  - `Extract Data`
  - `Check Login Status`
  - branch output nodes
- A cleanup node `Close Browser` sits lower on the canvas and is connected with a long white connector.
- Branch outputs are shown with colored path labels: `True` in green and `False` in red.
- Node cards are rounded rectangles with an orange border, small icon tile, title, and subtitle.

### Bottom activity log
- Panel title: `ACTIVITY LOG`
- Tabs: `Runs`, `Variables`, `Logs`
- `Runs` is active.
- `Auto-scroll` toggle sits in the header.
- Table columns:
  - `Status`
  - `Run ID`
  - `Workflow`
  - `Trigger`
  - `Duration`
  - `Finished At`
- Rows show recent successful runs with green status dots.
- The table is compact but legible and uses muted separators.

### Minimap
- Bottom right box titled `MINIMAP`
- Shows the full canvas in miniature.
- Zoom controls appear next to it: plus, minus, fit / focus control.
- The minimap reflects current viewport bounds.

## 3. Visual language
### Node cards
- Node cards are dark with warm orange borders.
- Icons are color-coded by category:
  - trigger: orange lightning or webhook icon
  - browser: cyan globe
  - logic / condition: purple branching glyph
  - delay: purple hourglass / clock
  - data / sheets: green spreadsheet icon
- Selected or active nodes show a brighter border and a faint glow.

### Connectors
- Connectors are curved and smooth, with small circular ports at endpoints.
- The visual language intentionally avoids sharp angles.
- Orange connector segments communicate active routes and selection emphasis.

### Outline tree
- The outline tree uses indentation, small icons, and numbered sections.
- Group labels like `Authentication` and `Condition` are visually distinct from the child nodes.
- Selected items in the outline should mirror the selection on the canvas.

## 4. Component behavior
### Workflow editing
- The canvas is the source of truth for the visible automation structure.
- The outline is a navigational mirror, not a separate model.
- Clicking a node in the canvas should focus it and preserve its branch connections.

### Activity log
- Runs should show live execution history in a stable table format.
- Auto-scroll can be toggled to keep the newest run visible.
- Users need to be able to switch to variables and logs without losing canvas context.

### Minimap
- The minimap should update when the canvas pans or zooms.
- It supports quick navigation across a wide graph.
- Its border and chrome are intentionally subtle so it does not compete with the main graph.

## 5. Data / backend mapping
This screen is mostly UI shell and graph state, but it implies the following metadata structure:

```json
{
  "workflowName": "Login Flow",
  "shell": {
    "topBar": true,
    "leftPalette": true,
    "outline": true,
    "activityLog": true,
    "minimap": true
  },
  "graph": {
    "nodes": [],
    "connections": [],
    "selectedNodeId": "click-element",
    "selectedGroupId": null,
    "viewport": {
      "zoom": 1,
      "panX": 0,
      "panY": 0
    }
  }
}
```

### Mapping rules
- Shell chrome is global and persists across node modal states.
- Outline tree and canvas graph should be derived from the same workflow model.
- Activity log rows should be fed by execution metadata rather than canvas state.
- Minimap should be a read-only projection of the graph.

## 6. Interaction contract
- Clicking a node opens its NDV modal in other states, but here the canvas is the focus.
- Clicking the outline should jump to the corresponding canvas node.
- The selected node should display an orange glow and a visible node border.
- The top-right `Stop` action is workflow-scoped, not node-scoped.
- The bottom log should remain usable while the canvas is being edited.

## 7. Action levels
- **A — Ready now:** shell structure, outline tree, node ordering, activity log, minimap.
- **B — Small add:** selection syncing between outline and canvas, better log filtering.
- **C — Defer:** advanced canvas search, multi-select batching, keyboard shortcuts beyond basic editor controls.

## 8. When to open the full image
Open `shell-editor-click-ndv.webp` only for:
- exact outline indentation
- node spacing in the graph
- connector routing
- minimap size and position
- activity log row density
