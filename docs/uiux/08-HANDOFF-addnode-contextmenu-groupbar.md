# 08 — HANDOFF: Add Node palette · node context menu · group toolbar

> ⚠ **SUPERSEDED for "what to do next" by
> `09-HANDOFF-item-N-per-node-run.md`** (2026-07-30) — read that file first: it
> carries the complete implementation spec for the last open item (**N**,
> per-node Run) plus four extra findings, two of which are real bugs.
> This file stays authoritative for **what already shipped** (items H / J / I),
> for the `disabled`-node semantics in § 2 and for the trap list in § 5.
>
> It supersedes `07-HANDOFF-fullbleed-editor-shell.md` (which superseded `06-…`);
> `07-…` § 4 still holds the useful code anchors for the shell/dock work and
> § 5.6 its do-not-"fix" list, both of which stay valid.
>
> Written 2026-07-30. This session closed items **H**, **J** and **I** of the
> A–N gap list. What is still open is in **§ 6**, with file/line anchors so the
> next session needs no chat history.

---

## 0. The standing rules (user instructions, not preferences)

Unchanged from `07-…` § 0, repeated because they are load-bearing:

1. **Keep developing. Never ask questions** — search and decide yourself.
2. **Image beats prose.** `docs/uiux/*.webp` (1672×941) is authoritative.
3. **Never build fake-successful UI.** No mock rows, no invented counts. If the
   backend cannot do it yet, render it **visibly disabled with a tooltip**.
4. **Do not add a front-end JS file.** `tests/unit/icons.test.ts` pins the
   **18** files in `public/js/`. Dev tooling lives in `tools/`.
5. Every i18n key must exist in **both** the `fa` and `en` dictionary.
6. Line endings: `public/**` = LF (0 CR); `src/*.ts` = CRLF. Patch CRLF files
   byte-exactly with `io.open(..., newline='')`.
7. Commit after every change; rebase on `origin/main`; squash; force-push
   `genspark_ai_developer`; open/update the PR and hand the user the link.

---

## 1. What shipped this session

| Item | Feature | State |
|------|---------|-------|
| **H** | Floating **Add Node** palette | ✅ done |
| **J** | Full nine-row **node context menu** + node annotations | ✅ done |
| **I** | **Group-selection** boundary + action toolbar | ✅ done |
| — | `disabled` node semantics in the serializer | ✅ done |
| — | Undefined-CSS-token cleanup (light theme) | ✅ done |

### 1.1 Item H — floating Add Node palette
`public/js/flow-editor.js`, anchor `var addState = null;` → `openAddPalette()`.

* Panel: `.fe-addnode` (`role="dialog"`) → `.an-head` (`.an-title` / `.an-count`
  / `.an-close`) → optional `.an-from` ("Connect from: X") → `.an-searchrow`
  → `.an-body` (`.an-cats` `role="tablist"` + `.an-list` `role="listbox"`)
  → `.an-foot` key hints.
* **Four entry points**, all verified in a browser:
  1. the empty-state CTA (`renderEmptyState` → `openAddPaletteForSelection`);
  2. the canvas toolbar pill `data-view="addnode"` (first in `.fe-view-pills`,
     `.is-primary`);
  3. the `Tab` key (global keydown toggles);
  4. **a connection dragged onto empty canvas** → opens with
     `from: { nodeId, port }` and auto-wires the pick. Dropping on chrome
     (`.fe-canvas-toolbar` / `.fe-view-pills` / `.fe-minimap-wrap` /
     `.fe-addnode`) **cancels** instead of inserting behind the widget — that is
     the `onCanvas` guard in the `mouseup` `connect` branch.
* It **reuses** `paletteItem(a, opts)` (the `onPick` option was added for this),
  `PALETTE_GROUPS`, `categoryOf()` and the same `paletteFavs` store — starring a
  row in either surface repaints both. Counts are computed, never literals.
* Keyboard: type to filter across the **whole** catalog (not just the open
  category), `↑ ↓` move, `Enter` inserts, `Esc` closes.

### 1.2 Item J — node context menu (nine rows) + node annotations
Anchor `function openNodeMenu(`. Rows, in order:

1. `Clone node` (`Ctrl/⌘+C`) — `copySelection(); pasteClipboard();`
2. `Rename` — inline `.fe-prompt` popover
3. `Disable` / `Enable` — **changes serialization** (see § 2)
4. `Change Color` — six-token swatch row + reset (`ctxColorRow`)
5. `Add / Edit Comment` — inline popover, 500-char clamp
6. `Add to / Remove from Favorites` — per **action**, says so in its tooltip
7. `Convert to Subflow` — **disabled + tooltip** (no backing)
8. `Advanced ▸` — sibling submenu: `Open settings`, `Pin/Unpin node`,
   `Copy node JSON`, `Run node` (**disabled + tooltip**)
9. `Delete node` (`Del`, danger)

Notes that cost time to get right:

* A submenu is a **sibling** `.fe-ctxmenu.is-sub`, not a nested node, and the
  window `mousedown` guard tests `ev.target.closest('.fe-ctxmenu')` — otherwise
  the outside-click teardown fires before the submenu row's `click`.
  `closeNodeMenu()` drains **all** menus in a `while` loop.
* `window.prompt` was rejected (ignores RTL/theme/i18n, invisible to
  Playwright). `.fe-prompt`: `Enter` commits (`Ctrl/⌘+Enter` in the textarea),
  `Esc` cancels, **no blur-to-cancel** (a stray click must not discard typing).
* Annotations live on the node: `label`, `note`, `color`, `disabled`. They are
  **editor metadata**: they survive localStorage but **not** a server round-trip,
  because `src/validation.ts#validateSteps` whitelists step fields. `disabled`
  is the exception — it changes what is serialized.
* The card shows them: `.fn-off` (`eye-off` + OFF badge), `.fn-note`
  (first 60 chars), `--cat-color` override, `.flow-node.is-off` hatch +
  strike-through title. The OUTLINE mirrors `is-off`.

### 1.3 Item I — group-selection boundary + toolbar (NEW)
Anchors: `function renderSelectionTools()`, `selBtn()`, `openSelectionMore()`,
`selectionBBox()`, `alignSelection()`.

`shell-add-node-palette.md` § 2 locks the inventory **in words only** — the NDV
modal covers that area of the screenshot, so the pixels are *not* locked. The
chrome therefore borrows the already-reviewed `.fe-ctxmenu` / canvas-toolbar
language rather than inventing a new one.

* `.fe-selbox` — **blue dashed** (`--info`) boundary, 16px padding around the
  selection bbox, `pointer-events: none`. Blue is deliberate: the design
  language reserves orange for the single active selection.
* `.fe-seltools` — count chip (**real** `ids.length`) + the seven spec buttons
  in spec order: `Disable · Delete · Clone · Group · Convert Subflow ·
  Add Comment · More`.
  * `Group` and `Convert Subflow` are **disabled with tooltips** — there is no
    frame/container concept in the graph model.
  * `Clone` is `copySelection(); pasteClipboard();` — the clipboard path already
    duplicates internal edges + annotations and moves the selection onto the
    copies, so there is no second implementation to drift.
  * `More ▸` reuses `ctxColorRow(ids)` + `ctxItem()`: group recolour,
    `Copy selection JSON`, `Pin all / Unpin all`, `Align in a row`.
* **Shown only for a MULTI selection (2+).** For one node the kebab menu already
  owns every one of these actions.
* Both elements are children of `.fe-world`, so pan/zoom move them for free.
  The toolbar alone cancels the zoom through `--fe-inv-scale`, published by
  `applyViewTransform()` — so zooming needs **no** re-render and the labels stay
  legible at 40% and at 200%. Verified: at 69% zoom the bar is still 36px tall.
* Never rendered mid-drag (`if (drag) return;`): a frame lagging one frame
  behind its cards reads as a rendering bug.
* Every group mutation is **one** undo step (`setSelectionDisabled`,
  `setSelectionComment`, `setSelectionColor`, `alignSelection`). Pins are view
  state, so `setSelectionPinned` takes **no** history step on purpose.

### 1.4 `ctxColorRow` now takes one id **or** an array
One renderer for the per-node menu and the group menu ⇒ one swatch inventory,
one whitelist, one "on" marker rule (a group only lights a swatch when *every*
selected node already has that colour).

### 1.5 Serializer refactor: `nodeStepJson` + `writeClipboard`
`copyNodeJson(id)` and `copySelectionJson(ids)` both go through
`nodeStepJson()` (one-node graph → `graphToSteps`, so `coerceParams` and the
condition builder run exactly as on a real save) and `writeClipboard()`
(`navigator.clipboard` with an `execCommand` fallback for non-secure contexts).
The group copy emits a JSON **array**, ordered by position along the main chain.

### 1.6 CSS token cleanup (real bug, found during review)
17 declarations used `var(--text-mute, …)`, `var(--accent, …)`,
`var(--surface-2, …)` and `var(--text-disabled, …)`. **None of those tokens
exist** in `styles.css`, so every one silently used its hardcoded fallback and
stopped following `[data-theme="light"]`. They now point at the real tokens:
`--text-faint`, `--primary`, `#1a1d24` (the reviewed `.fe-ctxmenu` surface).
`tests/unit/node-toolbox.test.ts` guards against a relapse.

---

## 2. `disabled` changes what the backend receives (n8n semantics)

`public/js/graph-serialize.js`:

* `walkChain()` — a node with `disabled === true` **emits no step** and the chain
  **passes through** its `next` port.
* `validateGraph()` — a disabled node produces a `val.disabledNode` **warning**
  and its param errors are **skipped** (otherwise an intentionally-off node with
  an unfilled required field would block the whole run).
* `outlineTree()` — rows carry `disabled` + `label`.

**Documented consequence:** disabling a *branching* node also drops its branch
children, because the chain continues through `next` only. That is intentional
and matches n8n; do not "fix" it without a spec change.

---

## 3. Files touched

| File | Change |
|---|---|
| `public/js/flow-editor.js` | items H + I + J, annotations, inline prompt, `nodeStepJson`/`writeClipboard`, `--fe-inv-scale` |
| `public/js/graph-serialize.js` | `disabled` pass-through, warning, outline flags |
| `public/js/views.js` | OUTLINE rows mirror `is-off` |
| `public/js/i18n.js` | ~48 new keys, **both** dictionaries (`fe.*`, `an.*`, `sel.*`, `val.disabledNode`) |
| `public/css/styles.css` | Add-Node palette, context menu, prompt, group toolbar; token cleanup (4381 → 4631 lines, 0 CR) |
| `tests/unit/node-toolbox.test.ts` | **new**, 42 structural/contract guards |
| `tests/unit/graph-serialize.test.ts` | +6 behavioural `disabled` tests (35 total) |
| `tests/unit/editor-shell.test.ts` | repaired `paletteItem` slice anchor |

---

## 4. Verification (all green at handoff)

```bash
cd /home/user/webapp
npx tsc --noEmit                      # TSC_OK
npx vitest run                        # 36 files / 711 tests passed
for f in public/js/*.js; do node --check "$f" || echo "FAIL $f"; done
ls public/js/*.js | wc -l             # must stay 18
# line endings
find public -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) \
  -exec sh -c 'c=$(tr -dc "\r" < "$1" | wc -c); [ "$c" -ne 0 ] && echo "CR=$c $1"' _ {} \;
for f in src/Routes/user.routes.ts src/pipeline.ts src/Routes/health.routes.ts; do
  printf "%s %s\n" "$(tr -dc '\r' < $f | wc -c)" "$f"; done   # 1190 / 2927 / 59
```

### 4.1 Visual verification
Redis is not installed, so `npm start` cannot run. Use the static preview:

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 libxdamage1
node tools/ui-preview-server.js 8788 &
node tools/ui-shot.js '#/editor' /tmp/a.png 1672x941
node tools/ui-shot.js '#/editor' /tmp/b.png 1672x941 '.fe-view-pill[data-view="addnode"]'
```

`ui-shot.js` takes a 5th argument: a comma-separated list of selectors to click
before the shot. For richer interaction write a throwaway Playwright script and
run it with `NODE_PATH=/home/user/webapp/node_modules node /tmp/x.js` (module
resolution is relative to the *script*, not the cwd).

**Trap found while writing those scripts:** the default language is `fa`, so the
canvas is **RTL** — "top-end" is the top **LEFT** and the minimap is bottom
**left**. A pointer drag from a corner lands on chrome. Dispatch the marquee
directly at `.fe-canvas` with `shiftKey: true` (Shift is required for
box-select), or aim at the middle of the canvas.

Confirmed by browser this session: palette insert + auto-connect; 9-row menu +
submenu; group disable of 3 nodes undone in **one** step; group recolour undone
in one step; counter-scale at 69% zoom; single selection shows **no** group
chrome; console clean (`errors: none`) in every run.

---

## 5. Traps (carried forward + new)

1. `coerceParams()` only copies **declared** `fields` keys — an undeclared param
   is silently dropped on save.
2. `.ic` must never get an explicit width/height.
3. `'fx'` is text, not an icon.
4. `display: none` on a grid column zeroes the canvas — use `width: 0` +
   `visibility: hidden`.
5. Redis is absent: `npm start` fails. Use `tools/ui-preview-server.js`.
6. `icons.js` must stay the **first** script (CSP `scriptSrc ['self']`, no eval).
7. There is **no** `log-out` icon — use `power`. There is **no** `ellipsis` —
   use `more-vertical`.
8. **NEW** `--text-mute`, `--accent`, `--surface-2`, `--text-disabled` are NOT
   tokens. Use `--text-dim`, `--text-faint`, `--primary`, `--border`,
   `--info`, `--danger(-soft)`, or the literal `#1a1d24` for popover surfaces.
9. **NEW** Box-select needs **Shift**; a plain drag pans.
10. **NEW** `indexOf("if (drag.type === 'connect')")` hits the **mousemove**
    branch (`} else if …`) first. Use `lastIndexOf` for the mouseup branch.
11. **NEW** Slicing a source range by `indexOf(fn) + N` can overrun into the
    next function and count its `pushHistory()`. Slice to `'\n  function '`.

---

## 6. Still open (in priority order)

### 6.1 Item **N** — per-node Run (needs backend first)
> **Now fully specified in `09-HANDOFF-item-N-per-node-run.md` § 2** — endpoint
> contract, zod schema, front-end wiring, i18n keys and the tests to write are
> all written out there. The summary below is kept for context only.
The `Run node` rows (context menu ▸ Advanced, and the NDV header button) are
rendered **disabled with `fe.runNodeSoon`**. To finish:
1. add a `POST /api/user/workflows/run-step` (or `/nodes/:id/run`) endpoint in
   `src/Routes/user.routes.ts` (**CRLF file, 1190 CR bytes**) that runs a single
   `AutomationStep` through the existing pipeline and returns its result;
2. add a zod schema in `src/schemas.ts`;
3. `API.runNode()` in `public/js/api.js`;
4. drop `disabled` from both rows and paint the result into the NDV OUTPUT
   column via the existing `nodeResults` store.

### 6.2 § 5.0 follow-ups inherited from `07-…`
* 980px render pass; RTL dock pass; `#fe-result` inside full-bleed; ACTIVITY LOG
  open-state check.

### 6.3 § 5.1 visual deltas inherited from `07-…`
* palette/outline collapse **defaults** + persistence;
* the 13-glyph icon rail;
* **minimap proportions** — and one thing spotted this session: with few nodes
  the `.mm-viewport` rect fills nearly the whole widget with `--primary-soft`,
  which reads as an orange block. Clamp it or soften the fill.

### 6.4 New, noticed in the locked image while working on H
`shell-add-node-palette.webp` shows a **circled `+` on a free output port**
(right of the node, on the connector stub). That is a fifth Add Node entry point
and it is cheap now that `openAddPalette({ from })` exists: render the chip on
free ports and open the palette pre-wired to that port.

---

## 7. Where the reference material lives

| Kind | Path |
|---|---|
| Locked shell + palette + menu + group toolbar | `docs/uiux/shell-add-node-palette.{webp,md}` |
| Editor shell (authoritative chrome) | `docs/uiux/state-empty-canvas.{webp,md}` |
| Launcher + measured geometry | `docs/uiux/shell-editor-launcher-menu.{webp,md}` |
| Previous status doc | `docs/uiux/07-HANDOFF-fullbleed-editor-shell.md` |
| Items A–N table + traps | icon-registry / shell-layout brief (superseded by `04-HANDOFF-…`) |
