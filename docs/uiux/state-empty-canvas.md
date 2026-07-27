# State — Empty Canvas — Implementation Spec

## Status
Visual LOCKED (full reviewed)  
Backend: READY (no NDV payload, shell-only state)  
Theme: **DARK ONLY** (locked — matches full/lite images; no light variant)

## Files
| Kind | Path |
|------|------|
| Full | `state-empty-canvas.webp` |
| Lite | `lite/state-empty-canvas.jpg` (~910×512) |
| Related specs | `shell-add-node-palette.md`, `shell-editor-condition-ndv.md`, `shell-editor-click-ndv.md` |

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

## 1. Visual Contract (enough without opening the image)

### Comprehensive Layout Diagram
```
┌─ Top Bar (Shell Chrome, dark) ──────────────────────────────────────────────────────────────┐
│ [Logo orange] Aria Automate / E-commerce Price Monitor & Alert  [Draft] [Saved 2m] [Test][Save][⚙][User] │
├──────────────────────┬──────────────────────────────────────────────────────────────────────┤
│ Left Sidebar dark    │ Canvas Area (Dot-Grid on charcoal)                                   │
│ ┌──────────────────┐ │                                                                      │
│ │ 🔍 Search nodes… │ │                     ┌─────────────────────────────────┐              │
│ ├──────────────────┤ │                     │       [ ⚡ Icon Circle ]        │              │
│ │ ▼ Triggers       │ │                     │   Start building your workflow  │              │
│ │   • Webhook      │ │                     │  Add a trigger node to begin, or│              │
│ │   • Schedule     │ │                     │ drag nodes from the left panel. │              │
│ │ ▼ Browser        │ │                     │                                 │              │
│ │   • Launch       │ │                     │    [ + Add First Node ]         │              │
│ │   • Open URL     │ │                     └─────────────────────────────────┘              │
│ │   • Click        │ │                                                                      │
│ │   • Type Text    │ │                                                            ┌───────┐ │
│ │ ▼ Flow Control   │ │                                                            │MiniMap│ │
│ │   • Condition    │ │                                                            └───────┘ │
│ │ ▼ Data & Logic   │ │                                                            [ +][100%][-] │
│ └──────────────────┘ │                                                                      │
└──────────────────────┴──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component-by-Component Pixel & Visual Breakdown

### A. Top Bar (Header Chrome)
- **Container**: `height: 52–56px`, background `#0F141B` / `#11161E`, bottom border `1px solid rgba(255,255,255,0.08)`.
- **Left Group**:
  - Logo: `24x24px` orange brand mark (`#FF8A1F`).
  - Breadcrumb / Title: `14px`, weight `600`, color `#E8EDF4`. Format: `Aria Automate / <Workflow Title>`.
  - Status Badge: `Draft` pill — amber/orange tint on dark surface (`padding: 2px 8px`, `border-radius: 12px`, font `12px`).
  - Auto-save indicator: `Saved 2 minutes ago` in `#97A2B3`, size `12px`.
- **Right Action Group**:
  - `[Test Workflow]`: primary accent button — orange `#FF8A1F`, dark/near-black text or white text, rounded `6–8px`.
  - `[Save]`: secondary dark button, border `rgba(255,255,255,0.12)`, text `#E8EDF4`.
  - `[Settings]`: gear icon button muted.
  - User Avatar: `32x32px` circular.

### B. Left Sidebar (Node Palette Drawer)
- **Container**: `width: 240–260px`, background `#0F141B` / `#11161E`, right border `1px solid rgba(255,255,255,0.08)`.
- **Search Bar**:
  - Input on dark surface, magnifying glass icon, placeholder `Search nodes…`, text `#E8EDF4`, placeholder `#5E6876`.
  - Clear button `(x)` appears on keypress.
- **Accordion Categories**:
  - Header: uppercase, `11px`, letter-spacing `0.05em`, color `#97A2B3`.
  - **Triggers**: Webhook, Schedule, Event Trigger.
  - **Browser Actions**: Launch Browser, Open URL, Click Element, Type Text, Wait Element, Extract Data, Close Browser.
  - **Flow Control**: Condition (If/Else), Loop (While), Delay, Branch.
  - **Data & Logic**: Parse JSON, Set Variable, JavaScript Code.
- **Node Item Card in Sidebar**:
  - Padding: `8px 12px`, hover background `rgba(255,255,255,0.04)`, cursor `grab`.
  - Left: `20x20px` category icon (thin-line, monochrome or category-tinted).
  - Title: `13px`, weight `500`, `#E8EDF4`.
  - Right: 6-dot drag handle muted.

### C. Canvas (Empty State Center Card & Grid)
- **Grid Background**:
  - Background color: `#0B0F14` – `#0E1218`.
  - Pattern: Dot-grid (`radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)`), spacing `20px × 20px`.
- **Center Empty State Card**:
  - Position: centered on canvas (`top: 50%`, `left: 50%`, `transform: translate(-50%, -50%)`).
  - Width: `~420px`, padding `32px 24px`, background `#151C25` / `#11161E`, border-radius `12px`, border `1px solid rgba(255,255,255,0.08)`, soft dark shadow.
  - Elements inside card (top to bottom):
    1. **Icon Container**: `64x64px` circle, background `rgba(255,138,31,0.12)`, icon `⚡` in orange `#FF8A1F`.
    2. **Headline**: `Start building your workflow`, `18px`, weight `600`, color `#E8EDF4`, centered, margin-top `16px`.
    3. **Helper**: `Click below to add a trigger node, or drag any node from the left sidebar to start execution.`, `13px`, color `#97A2B3`, line-height `1.5`, centered, margin `8px 0 24px`.
    4. **Primary CTA**: `[ + Add First Node ]`, orange `#FF8A1F`, dark text or white, weight `500`, padding `10px 20px`, rounded `8px`, hover slightly brighter orange.

### D. Canvas Controls (Bottom Right)
- **Mini-Map Widget**:
  - Position: `bottom: 24px`, `right: 24px`, size `~160x100px`, background `#151C25`, border `1px solid rgba(255,255,255,0.08)`.
- **Pan / Zoom Floating Toolbar**:
  - Adjacent to mini-map.
  - Buttons: `[+]`, `[100%]`, `[-]` on dark surface, muted borders, text `#E8EDF4`.

---

## 3. Interactive UX Behavior & State Transitions

1. **State 0: First Load (This Screen)**
   - Graph empty (`nodes: []`, `edges: []`).
   - Center Empty State Card visible.
   - Top Bar `[Test Workflow]` disabled or hints "Add at least one node to test".

2. **Trigger Action 1: Click `[+ Add First Node]`**
   - Opens Add Node Palette (see `shell-add-node-palette.md`) or focuses left sidebar search.

3. **Trigger Action 2: Drag & Drop Node from Sidebar**
   - Ghost preview `opacity: 0.7`.
   - On drop: empty card fades out (`opacity 200ms`).
   - Node renders at drop coords with default handles.

4. **Trigger Action 3: Keyboard**
   - `/` or `Ctrl+K` / `Cmd+K` opens quick node picker (later).

---

## 4. Graph Serialization State (Initial Clean-room)

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

---

## 5. Implementation Checklist & Action Levels

- **A — Ready Now (Clean-room DOM & CSS `.ex-*`)**:
  - Render `.ex-editor-shell` with TopBar, Sidebar, Canvas (dark tokens only).
  - Render `.ex-empty-canvas-card` when `nodes.length === 0`.
  - Bind CTA → open palette / focus search.
  - Bind canvas drop for first node (S1+).

- **B — Small Additions**:
  - Fade empty → first node.
  - Enable/disable Test by node count.

- **C — Later**:
  - Template cards / AI prompt in empty state.

---

## When to open full image
Only for pixel-level RGB of gradients/shadows against `state-empty-canvas.webp`. Spec already matches the locked dark visual.
