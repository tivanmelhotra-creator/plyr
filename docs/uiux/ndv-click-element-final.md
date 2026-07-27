# Click Element NDV — Implementation Spec

## Status
Visual LOCKED (full reviewed)  
Backend: see `ndv-click-element-final.md` / sibling engine notes in `ndv-condition-final.md`

## Files
| Kind | Path |
|------|------|
| Full | `ndv-click-element-final.webp` |
| Lite | `lite/ndv-click-element-final.jpg` |
| Spec (this file) | `ndv-click-element-final.md` |
| Sibling condition spec | `ndv-condition-final.md` |


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
This screen is a **node detail modal** for a browser automation action. The modal sits above a dark workflow editor and is centered with a strong panel border and subtle glow. The key visual idea is: **the canvas stays visible behind the modal**, but it becomes secondary while the selected node is edited.

### Overall composition
- The app shell remains visible behind the modal: top nav, left palette, canvas, and a right-side minimap are still readable.
- The modal occupies roughly **72–76% of the viewport width** and almost the full usable canvas height.
- The modal uses a **3-column layout**:
  1. **INPUT** on the left
  2. **Instructions / configuration** in the center
  3. **OUTPUT** on the right
- The modal header is one continuous bar with the node icon, title, subtitle, status badge, run action, and close action aligned on a single row.

### Visual hierarchy
1. Header title and node icon
2. Center selector configuration
3. Output empty state
4. Input data tree
5. Secondary tabs and helper text

### Geometry notes
- Modal outer border: 1px orange-tinted stroke with a soft glow.
- Corner radius: ~14px.
- Internal column separators are subtle, low-opacity lines.
- The center column is visually the densest area and receives the highest contrast.
- The right column is intentionally lighter in content density, so the empty-state illustration feels balanced and does not compete with the editor canvas.

## 2. Layout breakdown
### Header
- Left icon block: orange square tile containing a pointer / cursor glyph.
- Title: `Click Element`
- Subtitle / node key: `#next-button`
- Right side status cluster:
  - green dot + `Idle`
  - orange `Run node` button with play icon
  - close `X`
- The header aligns to the same horizontal grid as the internal columns.

### Left column — INPUT
- Column title: `INPUT`
- Tabs: `Schema`, `Table`, `JSON`
- Run selector dropdown: `Run 2 of 2`
- Search field: `Search input data...`
- Data tree with expandable groups:
  - `response`
  - `data`
  - `meta`
- Tree items use indentation, caret disclosure icons, and muted separators.
- Bottom area includes draggable chips such as `response.status`, `data.user`, `statusCode`, `token`.

### Center column — Instructions
The center column contains several stacked cards / sections:

1. **Selector**
   - `Selector type` dropdown set to `CSS Selector`
   - `CSS Selector` text input containing `#next-button`
   - target picker button to sample an element from the live page
   - `fx` icon button for expression binding
   - short helper hint under the field

2. **Click options**
   - `Click type` dropdown set to `Single click`
   - `Mouse button` dropdown set to `Left`
   - `Click count` numeric input set to `1`
   - `Delay before click (ms)` numeric input set to `0`

3. **Selector options**
   - `Wait for selector` toggle enabled
   - `Timeout (ms)` numeric field set to `10000`
   - `Scroll into view` toggle enabled
   - `Multiple matches` toggle disabled
   - `Mark / highlight element` toggle disabled
   - `Visible only` toggle enabled
   - `Stable for (ms)` numeric field set to `300`
   - tiny helper text: `Wait until element stops moving`

4. **Position offsets**
   - `Offset X (px)` input set to `0`
   - `Offset Y (px)` input set to `0`
   - helper text indicates the point is relative to element center / top-left

5. **Optional modifiers**
   - checkboxes for `Alt`, `Ctrl / Cmd`, `Shift`

6. **Behavior**
   - `Human-like movement` toggle enabled
   - `Force click` toggle disabled
   - `Continue on fail` toggle disabled

### Right column — OUTPUT
- Column title: `OUTPUT`
- Tabs: `Schema`, `Table`, `JSON`
- Run selector dropdown: `Run 2 of 2`
- Search field: `Search output data...`
- Empty-state illustration placed in a centered card.
- Below the illustration:
  - headline: `Run node to see output`
  - supporting text: `The output will appear here after you run this node.`
- At the very bottom is a muted status strip with `Status`, `Time`, and `Size`.
- A compact code-style preview appears in the lower output area, showing a representative result shape.

## 3. Pixel-level UI language
### Surfaces and contrast
- The modal panel is a slightly lighter dark surface than the canvas behind it.
- All major controls are separated by 1px lines and faint shadows.
- Orange is reserved for active selections, header emphasis, primary action, and key node borders.
- Cyan / blue is used only for browser-related iconography and selected utility accents.
- Green appears for successful status and enabled / positive conditions.
- Red is reserved for danger / false states.

### Button language
- Primary button (`Run node`): orange fill, white text, subtle rounded rectangle.
- Secondary buttons (`Schema`, `Table`, `JSON`): dark fill with a lighter active state.
- Small icon buttons (`fx`, picker, close): square / rounded-square, minimal stroke.
- Dropdowns are dark fields with subtle down-arrow chevrons.

### Inputs
- Input fields are tall enough to remain touchable, with rounded corners and a narrow border.
- Selected fields have brighter borders and sometimes a warm accent glow.
- Numeric fields are compact and visually aligned to reduce cognitive load.

## 4. Component behavior
### Input tree
- Tree nodes expand with a down-caret and collapse with a right-caret.
- Values appear in a two-column tree style: label left, value right.
- Chips at the bottom are draggable tokens and are color coded by source group.
- Drag affordance should be obvious but not flashy.

### Selector picker
- The target picker button is a small square icon button with orange emphasis.
- Its purpose is to let the user capture a CSS selector from the live page.
- The `fx` button is visually equivalent in size but semantically distinct: it binds a computed value.

### Toggle switches
- Enabled state: orange track, white knob.
- Disabled state: dark track, gray knob.
- Toggler position changes are immediately visible and do not require extra labels.

### Output empty state
- The illustration is centered and sized to leave breathing room.
- It acts as a placeholder rather than an error.
- The wording is instructional and invites a run action.

## 5. Data / backend mapping
The visible screen implies the following canonical execution payload:

```json
{
  "selectorType": "css",
  "selector": "#next-button",
  "clickType": "single",
  "mouseButton": "left",
  "clickCount": 1,
  "delayBeforeClickMs": 0,
  "waitForSelector": true,
  "timeoutMs": 10000,
  "scrollIntoView": true,
  "multipleMatches": false,
  "highlightElement": false,
  "visibleOnly": true,
  "stableForMs": 300,
  "offsetX": 0,
  "offsetY": 0,
  "modifiers": {
    "alt": false,
    "ctrlOrCmd": false,
    "shift": false
  },
  "behavior": {
    "humanLikeMovement": true,
    "forceClick": false,
    "continueOnFail": false
  }
}
```

### Mapping rules
- `CSS Selector` field maps directly to runtime selector.
- `fx` buttons indicate a value can be transformed or bound from expression context.
- `Visible only` and `Wait for selector` are gating flags for execution stability.
- Output data should reflect actual click status, selector used, button mode, and click count.

## 6. Interaction contract
- Clicking a node on the canvas opens this modal.
- Clicking outside the modal should close only if there are no unsaved changes, or after confirmation if dirty.
- `Run node` executes the selected node in isolation or the node’s subgraph scope.
- Close `X` uses the same unsaved-change logic as outside clicks.
- The editor shell behind the modal remains visible but inert.

## 7. Action levels
- **A — Ready now:** layout, field grouping, toggle states, output placeholder, header actions.
- **B — Small add:** richer output JSON preview and live selector capture messaging.
- **C — Defer:** advanced multi-click automation, per-element retry policies, and more sophisticated geometry-based click offsets.

## 8. When to open the full image
Open `ndv-click-element-final.webp` only for:
- exact spacing between the selector fields
- precise output illustration sizing
- tiny border radius choices
- exact icon proportions
- active / hover / focus border weight comparisons
