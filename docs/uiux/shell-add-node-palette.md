# Shell Editor + Add Node Palette — Implementation Spec

## Status
Visual LOCKED (full reviewed)  
Backend: mixed shell + node configuration overlay

## Files
| Kind | Path |
|------|------|
| Full | `shell-add-node-palette.webp` |
| Lite | `lite/shell-add-node-palette.jpg` |
| Spec (this file) | `shell-add-node-palette.md` |
| Related shell states | `shell-editor-click-ndv.md`, `shell-editor-condition-ndv.md` |


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
This image represents the **editor shell** plus a **modal node editor** and a **right-side Add Node palette**. It is the most interaction-dense of the set because several layers are visible at once:
- the global shell
- the canvas with grouped nodes
- the selected node modal
- a floating context menu
- a bottom group action toolbar
- a right-side node insertion palette

The screen is a good reference for **canvas editing affordances**, not just node configuration.

## 2. Layout breakdown
### Top shell
- Brand on the far left: `Aria Automate` with orange mark.
- Main nav items across the top: `Home`, `Workspace`, active flow tab `Login Flow`, plus other workflow tabs such as `Payment Flow`, `Instagram Bot`, `Scraper`, `New Workflow`.
- Right side top actions:
  - undo / redo cluster
  - `Export`
  - `Save`
  - red `Stop`
  - notification bell
  - settings gear
  - user avatar

### Left rail
- Persistent black sidebar with:
  - search box `Search blocks...`
  - `Favorites`
  - block groups with counts: `General`, `Browser`, `Web Interaction`, `Elements`, `Flow Control`, `Online Services`, `Data`, `Templates`, `Variables`, `Connections`, `Settings`, `Help & Docs`, `Collapse`
- Icons are thin-line, monochrome with occasional brand colors.
- Counts sit flush right in a muted tone.

### Canvas
- Large dark workspace with a dotted / faint grid.
- Nodes are connected by orange, blue, or white curved connectors.
- The selected cluster is surrounded by a blue dashed group boundary.
- A selected node / area is also visually emphasized with a glowing outline.

### Center overlay: modal
- Large modal titled `HTTP Request`
- Subtitle line shows `GET https://api.example.com/login`
- Status badge on the header right is green and localized (`موفق`)
- Orange `Run node` button and `X` close icon on the right

### Right overlay: Add Node palette
- A floating panel titled `Add Node`
- Search field: `Search nodes...`
- Category list on the left:
  - `Triggers`
  - `Browser`
  - `Web Interaction`
  - `Data`
  - `AI`
  - `Flow Control`
  - `Integrations`
  - `Utilities`
- Node presets listed on the right:
  - `Webhook`
  - `Schedule`
  - `Manual Trigger`
  - `Form Trigger`
  - `Email Trigger`

### Floating context menu
Near the selected node, a dark context menu is open with:
- `Clone`
- `Delete`
- `Rename`
- `Disable`
- `Change Color` with colored dots
- `Add Comment`
- `Add to Favorites`
- `Convert to Subflow`
- `Advanced` submenu

### Bottom group toolbar
A compact toolbar appears near the selected group with:
- `Disable`
- `Delete`
- `Clone`
- `Group`
- `Convert Subflow`
- `Add Comment`
- `More`

### Bottom content
- Activity log panel spans the lower section.
- It shows tabs `Runs`, `Variables`, `Logs`.
- The visible table columns are `Status`, `Run ID`, `Workflow`, `Trigger`, `Duration`, `Finished At`.
- Status rows show green success dots.
- A minimap panel sits on the lower right with zoom controls.

## 3. Visual language
### Shell hierarchy
- Shell chrome is intentionally flatter than the modal to keep attention on the canvas.
- Orange is used for selection, active tab emphasis, important borders, and primary actions.
- Blue is used for selection groups / browser-related elements.
- The right palette uses a neutral-dark card style to avoid competing with the modal.

### Modal emphasis
- The HTTP modal uses a cool blue edge glow, distinct from the orange click/condition modals.
- This makes request-type nodes feel technically different from browser interaction nodes.
- The header icon is a globe, reinforcing that the node is network-oriented.

### Palette language
- The Add Node palette is narrow enough to remain auxiliary.
- It behaves like a quick insertion launcher rather than a full library page.
- Categories are compact, with icons on the left and node types as list items on the right.

## 4. Modal detail — HTTP Request
### Header
- Title: `HTTP Request`
- Subtitle: `GET https://api.example.com/login`
- Right badge: green `موفق`
- Actions: `Run node`, close `X`

### Left column — INPUT
- Tabs: `Schema`, `Table`, `JSON`
- Run selector: `Run 2 of 2`
- Search field: `Search input data...`
- Tree data:
  - `Trigger`
  - `body`
  - `headers`
  - `query`
  - `timestamp`
  - `executionId`
  - `retryCount`
- Bottom chips represent available variables:
  - `body`
  - `headers.authorization`
  - `query.source`
  - `timestamp`

### Center column — Instructions (localized)
The field labels are a mix of Persian and English values, and the screenshot shows that the UI supports RTL labeling while preserving technical values.

Visible sections:
- request method dropdown: `GET`
- `URL`
- `Query Parameters`
- `Headers`
- `Timeout (ms)`
- `Retry`
- `Continue On Error`

Visible values:
- URL value: `https://api.example.com/login`
- Query parameter key/value row with `source`
- Headers rows:
  - `Authorization`
  - `Content-Type`
- Timeout: `15000`
- Retry: `2`
- Continue On Error toggle enabled

### Right column — OUTPUT
- Output tree mirrors the success response schema.
- It shows:
  - `response`
  - `status`
  - `statusCode`
  - `message`
  - `data`
  - `user`
  - `meta`
- The bottom status strip shows `Status`, `Time`, `Size`.

## 5. Interaction contract
- Clicking a canvas node should open the corresponding modal.
- Right-clicking a node should open the floating context menu.
- Multi-selection or group selection should show a dashed blue rectangle around selected nodes.
- The bottom group toolbar appears only when nodes are selected as a group.
- The Add Node palette is available for fast insertion and should not block the modal unnecessarily.

## 6. Data / backend mapping
The HTTP Request modal implies the following execution payload:

```json
{
  "method": "GET",
  "url": "https://api.example.com/login",
  "query": {
    "source": "..."
  },
  "headers": {
    "Authorization": "...",
    "Content-Type": "application/json"
  },
  "timeoutMs": 15000,
  "retry": 2,
  "continueOnError": true
}
```

### Mapping rules
- The modal is a direct form-to-request mapper.
- Input tree values should be draggably bindable to query, header, and body fields.
- Output tree should display stable response keys rather than raw transport blobs.

## 7. Action levels
- **A — Ready now:** shell layout, HTTP modal, add node palette, context menu, group toolbar.
- **B — Small add:** selection-state persistence, deeper request preview formatting, palette search results ranking.
- **C — Defer:** keyboard-first node insertion and fully dynamic contextual suggestion generation.

## 8. When to open the full image
Open `shell-add-node-palette.webp` only for:
- right palette exact width
- modal overlay relationship to the canvas
- context menu spacing
- group selection rectangle proportions
- bottom activity log / minimap alignment
