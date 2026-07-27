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

| Stem | Role | Full | Lite | Spec |
|------|------|------|------|------|
| `ndv-condition-final` | Condition NDV focused | `.webp` | `lite/*.jpg` | `.md` |
| `ndv-click-element-final` | Click Element NDV focused | `.webp` | `lite/*.jpg` | `.md` |
| `shell-editor-click-ndv` | Full shell + Click NDV open | `.webp` | `lite/*.jpg` | `.md` |
| `shell-editor-condition-ndv` | Full shell + Condition NDV open | `.webp` | `lite/*.jpg` | `.md` |
| `shell-add-node-palette` | Shell with add-node palette | `.webp` | `lite/*.jpg` | `.md` |
| `state-empty-canvas` | Empty canvas state | `.webp` | `lite/*.jpg` | `.md` |

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
