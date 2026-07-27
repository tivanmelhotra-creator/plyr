# Final UI/UX — Aria Automate

## Locked product chrome
- **Theme:** dark only (charcoal canvas + orange accent). No light variant in v1.
- **Language / direction:** English LTR. Canvas ports are physical left/right only.
- **Shared tokens:** see any shell/NDV `.md` “Shared design tokens” block (`#0B0F14`, `#FF8A1F`, `#E8EDF4`, …).
- **Note:** `state-empty-canvas.md` previously described light colors by mistake; it was corrected to match the locked dark image.

## How we work (token-safe)
1. **First read the paired same-stem `.md`** — not the image.
2. If the MD is enough, **do not open images**.
3. If you need visuals: open **only one lite** under `lite/`.
4. Open **full** WebP only for pixel-level decisions, one file at a time.
5. Spec lives **only in `.md`** (no separate `.txt` — avoid duplicate clutter).

See also `00-PROCESS-node-design.md`.

## Index (locked / reviewed)

All six screens have been READ. Only the two `ndv-*-final` screens are in scope
for *node design* — the four shell/state screens are read for their cross-cutting
rules (tokens, node cards, connectors, status bar, category-derived modal glow).

| Stem | Role | Full | Lite | Spec | Implementation |
|------|------|------|------|------|----------------|
| `ndv-condition-final` | Condition NDV focused | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`ndv-nodes.js`) · backend `source`/`attribute` executed |
| `ndv-click-element-final` | Click Element NDV focused | `.webp` | `lite/*.jpg` | `.md` | ✅ built (`ndv-nodes.js`) · backend click extras executed |
| `shell-editor-click-ndv` | Full shell + Click NDV open | `.webp` | `lite/*.jpg` | `.md` | ◐ node cards / ports / connectors / status bar / **SVG icons** / **left-to-right pipeline layout** / **minimap header** / **floating canvas toolbar** done; Outline + Activity Log + top-bar chrome pending |
| `shell-editor-condition-ndv` | Full shell + Condition NDV open | `.webp` | `lite/*.jpg` | `.md` | ◐ `True`/`False` edge pills + selection glow done; per-node Run pending |
| `shell-add-node-palette` | Shell with add-node palette | `.webp` | `lite/*.jpg` | `.md` | ◐ category-derived modal glow + node context menu (4 of 9 items) done; floating Add Node palette / group toolbar / full context menu pending |
| `state-empty-canvas` | Empty canvas state | `.webp` | `lite/*.jpg` | `.md` | ✅ built · empty-state card + dot grid + **titled minimap (180×128, 24px inset)** + **floating canvas toolbar** (tools · zoom · Auto Layout · Focus Mode) |

Remaining work per screen is tracked, with file/line anchors, in
`/HANDOFF_2026-07-27_ICONS_LAYOUT.md` § 4 (items A-N, ordered by visual
impact). `/HANDOFF_NEXT_SESSION.md` § 5 remains the NDV design-foundation
reference.

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
