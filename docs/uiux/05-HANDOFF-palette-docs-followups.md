# 05 — HANDOFF: what is done, what is left, and how to continue

> **Written:** 2026-07-29 · **Branch:** `genspark_ai_developer` · **Base:** `origin/main` @ `1ed4e8d`
> **Audience:** the next session, which starts with **ZERO chat history**.
> Read this file top-to-bottom BEFORE touching code. It supersedes
> `04-HANDOFF-editor-shell-outline-activity.md` for *status*; that file is still
> the best source for *file/line anchors* and for the substrate API.
>
> **Why this file exists:** the session ran out of credit budget mid-way through
> the documentation pass. Items A–E are complete and committed, but a handful of
> small follow-ups are not. They are listed in § 5 with enough detail to be done
> without rediscovery.

---

## 0. TL;DR

| Item | State |
| --- | --- |
| A — editor top bar (nav · workflow tab strip · undo/redo · Export ▾ · Save ▾ · Run/Stop slot · bell · gear · avatar) | ✅ **DONE** |
| B — `Export ▾` / `Save ▾` split menus | ✅ **DONE** |
| C — OUTLINE panel (**START edge**, derived, collapsible) | ✅ **DONE** |
| D — blocks palette (search + ⌘K · Favorites · six computed rows · footer · Collapse) | ✅ **DONE** |
| E — ACTIVITY LOG (**FOUR** tabs · Runs table · Variables · Auto-scroll · download) | ✅ **DONE** |
| — canvas chrome relocated to **TOP-END** + labelled pill row | ✅ **DONE** |
| — guard test `tests/unit/editor-shell.test.ts` (32 tests) | ✅ **DONE** |
| — docs updated (`state-empty-canvas.md` rewritten, `shell-editor-launcher-menu.md` § 5, `README.md`, `04-HANDOFF` § 0/6.1/7) | ✅ **DONE** |
| Follow-ups F1–F6 | ❌ **TODO** — see § 5 |

**Verification at the time of writing:**
- `npx vitest run` → **35 files / 647 tests passed**
- `npx tsc --noEmit` → **clean**
- `node --check` on every `public/js/*.js` → clean
- CRLF: `public/**` = 0 CR (correct), `src/Routes/user.routes.ts` = 1190 CR,
  `src/pipeline.ts` = 2927 CR (both intact)
- Page loads with **no console errors** (checked via a real browser against a
  static server on port 8788)

---

## 1. The rules that override everything

From the user, in Persian, and from `04-HANDOFF` § 1:

1. **Do whatever is needed and keep developing. Do not ask questions — search and
   decide yourself.**
2. **Where the written spec and the image disagree, THE IMAGE WINS.**
3. **All UI images matter, but three carry the LATEST updates.** Some sections
   were revised more than once; rather than discard a whole image for one fix the
   earlier ones were kept, so a later image contains **both** the corrections
   **and** other sections. The three authoritative files:
   - `docs/uiux/workspace-overview.webp`
   - `docs/uiux/state-empty-canvas.webp` ← **1672×941, refreshed, newest**
   - `docs/uiux/shell-editor-launcher-menu.webp`
4. **Never build fake-successful UI.** No mock rows, no invented counts, no links
   that look live but go nowhere. If something has no backend, render it
   **disabled with a tooltip** or say `—`.

---

## 2. Corrections discovered this pass (do NOT undo these)

These came from measuring the refreshed images, and several **contradict** older
docs. All of them are now encoded in guard tests, so reverting one fails CI.

| Correction | Was | Evidence |
| --- | --- | --- |
| Canvas tool + zoom cluster is at the **TOP-END**, 62px from the top | bottom-start | both refreshed images |
| `Auto Layout` / `Focus Mode` are **labelled pills on their own row** above it, at a 24px inset | icon buttons inside the toolbar | refreshed `state-empty-canvas.webp` |
| OUTLINE is a **full-height rail on the START edge**, flush against the palette, 236px wide (26px collapsed) | end-edge overlay | measured bbox `[142,53,273,524]` in `shell-editor-launcher-menu.webp` |
| ACTIVITY LOG has **FOUR** tabs (`Runs · Execution · Variables · Logs`), opens on `Execution` | three | refreshed `state-empty-canvas.webp` |
| `Test Workflow` and `Stop` are **one slot, two states** | two buttons | the two images captured the two states |
| Palette has **six** rows / **fifty** actions with **computed** counts | seven rows / 128 blocks | `public/js/actions.js` is the source of truth |
| `Version 1.3.7` is **mock** — not rendered | a real version string | no front-end version constant exists |

### Why the OUTLINE move mattered
At the end edge it collided with the minimap **and** with the relocated toolbar.
Because the rail now occupies real canvas width, the canvas publishes that width
as `--fe-ol-w` (236px open / 26px closed) and start-anchored overlays offset off
the variable instead of hardcoding a gap that would drift.

### THE 6-vs-7 DECISION (written down so it is not re-litigated)
The image shows seven rows totalling 128 blocks. The catalog has **six**
categories and **fifty** actions. The image is **mock**. Resolution is
**presentational**: `ACTION_CATALOG` stays the single source of truth (renaming a
`cat` id would corrupt every node colour, the NDV and `graphToSteps`), the
image's row vocabulary maps onto real categories, and **every count is computed**:

| image row | catalog category | real count |
|---|---|---|
| Triggers | `trigger` | 4 |
| Browser | `navigation` | 10 |
| Web Interaction | `interaction` | 16 |
| Flow Control | `flow` | 7 |
| Online Services | `integration` | 5 |
| Data | `data` | 8 |

Six rows, not seven: `General` and `Elements` have **no** catalog members, and a
row with a fake count is exactly the fake-successful UI rule 4 forbids. A
category missing from the table is swept into a final row, never dropped. The
reasoning is duplicated in a comment above `PALETTE_GROUPS` in `flow-editor.js`.

### The route trap (cost real time — do not step in it again)
`public/js/app.js#currentRoute()` **silently** rewrites an unknown hash to
`DEFAULT_ROUTE = 'workspace'`:

```js
var NAV_ROUTES  = ['home','workspace','dashboard','jobs','admin','settings'];
var DEEP_ROUTES = ['workflows','editor','run','live','browser','schedules','quota'];
var ROUTE_ALIAS = { flows:'workspace', library:'workspace', account:'settings' };
return ROUTES.indexOf(hash) !== -1 ? hash : DEFAULT_ROUTE;
```

So a plausible `#/templates` does **not** 404 — it quietly dumps the user on the
Workspace, indistinguishable from a bug. The palette footer originally used
`#/templates`, `#/browsers`, `#/docs`; all three were invalid. As shipped:

| footer entry | destination |
|---|---|
| `Templates` | `#/workspace?tab=templates` (real `WS_TABS` id) |
| `Variables` | no route — `RunPanel.showTab('variables')` |
| `Connections` | `#/workspace?tab=connections` |
| `Settings` | `#/settings` |
| `Help & Docs` | **disabled** + tooltip `pl.helpSoon` (no docs view ships) |
| `Collapse` | collapses the rail to a 44px strip with a restore chip |

`renderWorkspace()` gained `applyTabQuery()` so `?tab=` is actually honoured;
without it the link would open whatever tab was last used — a link that *looks*
like it worked. `editor-shell.test.ts` cross-checks every emitted `data-route`
against the real route table and asserts the three dead hashes never return.

---

## 3. Architecture constraints (violating these breaks the build)

- **Vanilla JS, no framework, no bundler.** IIFE modules on `window.*`, loaded by
  ordered `<script>` tags in `public/index.html`. **`icons.js` must stay FIRST.**
- **CSP-safe**: `script-src 'self'`. No inline handlers, no `eval`/`Function`, no
  CDN. Every handler via `addEventListener`.
- **🚫 DO NOT ADD A NEW FRONT-END JS FILE.** `tests/unit/icons.test.ts` has a
  **hardcoded `JS_ALL` array** (line ~34) listing exactly:
  `actions.js, templates.js, i18n.js, api.js, expression.js, graph-serialize.js,
  ndv-model.js, ndv-ui.js, ndv-nodes.js, flow-editor.js, live.js, live-view.js,
  run-state.js, run-panel.js, browser-view.js, views.js, app.js`.
  A new file fails that test. Put new code in an existing file.
- **i18n keys must exist in BOTH `fa` and `en`.** `t()` falls back to English, so
  a missing Persian key is invisible at runtime — only a source-level test catches
  it. `DEFAULT_LANG='en'`; v1 ships English LTR, dark theme only.
- **Emoji are banned** from shipped front-end code (comments are fine).
- **Chrome/view flags are module-level vars, NEVER on `state`**: `canvasTool`,
  `canvasLocked`, `gridVisible`, `minimapOpen`, `paletteFavs`, `paletteOpen`,
  `paletteCollapsed`. They must not be serialised into a workflow or captured by
  an undo snapshot. Guarded by test.
- **Derived state is never stored twice.** `FE.outline()` wraps
  `GraphSerialize.outlineTree(graph)`; the OUTLINE panel keeps no copy and does
  not poll — it syncs via `FE.onChange()`.
- **Line endings**: `public/**` = **LF**; `src/*.ts` = **CRLF**
  (`src/Routes/user.routes.ts` ≈1190 CR, `src/pipeline.ts` ≈2927 CR);
  `tests/unit/*.test.ts` = LF natively. **Do not convert.**
- **Locked design tokens** live in `:root` at `public/css/styles.css` lines 10–35
  (`--bg:#0B0F14`, `--primary:#FF8A1F`, `--radius:12px`, …). Use the variables.
- **Undo/redo** is snapshot-based, `HISTORY_LIMIT=60`, `pushHistory()` before a
  mutation, identical snapshots collapsed, cleared on document identity change.

---

## 4. What changed in this pass (file by file)

| File | Change |
|---|---|
| `public/js/views.js` | New top bar (nav · tab strip · undo/redo · `Export ▾` · `Save ▾` · Run/Stop slot · bell · gear · avatar) with all **six** legacy ids preserved in a hidden `.fe-legacy` span; canvas markup gained `#fe-runinfo`, `#fe-outline`, `#fe-ol-tab`; module-scope `execStateTone`/`alDuration`/`AL_MONTHS`/`alStamp`; shell wiring at the end of `renderEditor`; `setOutlineOpen()` toggles `fe-ol-closed` on `#fe-canvas`; **`applyTabQuery()`** added to `renderWorkspace` for `?tab=` deep links |
| `public/js/run-panel.js` | `AL_TABS` (4 tabs) + `alTab='execution'` + `alAutoScroll`/`alRuns`/`alFilter`/`subscribers`; full ACTIVITY LOG render suite; **`alVariables()`** derives variables from graph `variable` nodes (there is no `state.variables`); `renderHeader()` writes a separate `#al-counts`; `stop()` forces a terminal phase + `emitUpdate()`; exports gained `getSummary`, `onUpdate`, `refreshRuns`, **`showTab`** |
| `public/js/flow-editor.js` | `MOD_KEY` (⌘ vs Ctrl by platform); palette view state + `localStorage` favourites (`ab_palette_favs`); `buildOverlay()` split into `.fe-view-pills` + toolbar with `[pills, ctrl].forEach` binding; `paletteItem()` → `<div>` hosting a `.pi-star`; `PALETTE_GROUPS` / `PALETTE_LINKS` + the 6-vs-7 decision comment; rewritten `renderPalette()` / `paletteGroupHead()` / `renderPaletteList()`; `applyPaletteCollapsed()` / `setPaletteCollapsed()`; `⌘K`/`Ctrl+K` shortcut |
| `public/js/icons.js` | added `link` and `star` to registry `P` |
| `public/js/i18n.js` | ~70 `sh.*` / `ol.*` / `al.*` / `port.case` keys + ~15 `pl.*` keys, in **both** dictionaries |
| `public/css/styles.css` | 3293 → ~4142 lines. `EDITOR SHELL` block; toolbar relocated to `inset-block-start:62px; inset-inline-end:24px`; `.fe-view-pills`/`.fe-view-pill`; OUTLINE moved to the START edge with `--fe-ol-w`; full `BLOCKS PALETTE` block (search row, group rows, `.pi-star`, footer, collapsed rail) |
| `tests/unit/canvas-chrome.test.ts` | 3 stale assertions corrected for the top-end layout, pill-row test added, `.fe-view-pills` added to the sweep |
| `tests/unit/editor-shell.test.ts` | **NEW** — 32 tests |
| `docs/uiux/state-empty-canvas.md` | **rewritten** — was describing a screen that no longer exists; § 7 lists every superseded claim |
| `docs/uiux/shell-editor-launcher-menu.md` | § 5 corrections box (3 stale claims) |
| `docs/uiux/README.md` | new "which images carry the LATEST updates" section + index rows refreshed |
| `docs/uiux/04-HANDOFF-…md` | § 0 status box, § 6.1 four-tab correction, § 7 the 6-vs-7 decision + route fix |

### Guard-test design note
`editor-shell.test.ts` is **source-level** (these are DOM-bound IIFEs, same
approach as `canvas-chrome.test.ts`). It protects the three regressions that are
cheap to cause and expensive to notice:
1. **A dropped legacy id** — the six `#fe-*` listeners are *unguarded*, so a
   missing id throws mid-render and **blanks the whole editor**.
2. **A fake destination** — every `data-route` is checked against the real table.
3. **An invented count** — the mock's figures (`128`, `'14'`, `'18'`, …) must not
   appear in the palette code.

Both guards were **mutation-tested**: changing a route to `#/docs` and renaming
`#fe-json` each produced exactly one failing test.

---

## 5. TODO — follow-ups, in priority order

Nothing here is blocking; the build is green and the UI works. These are the
loose ends the credit budget cut short.

### F1 — verify the palette visually (LOW effort, do this first)
No screenshot was ever taken of the finished palette. Playwright is installed
but the **sandbox lacks the browser system libs** (`sudo npx playwright
install-deps` is not available). What *does* work:

```bash
cd /home/user/webapp/public && python3 -m http.server 8788   # then GetServiceUrl
```
and the `PlaywrightConsoleCapture` tool against that public URL (this is how the
"no console errors" result above was obtained). Load `#/editor` and eyeball:
the search row, the `Favorites` row, the six category rows with counts, the star
on hover, the footer, and `Collapse` → restore.

**Known unverified risk:** `.fe-palette` was changed to
`display:flex; flex-direction:column; overflow:hidden` so only `.palette-list`
scrolls. If the rail's height is not constrained by `.fe-layout` in some viewport,
the footer could be pushed out of view. Check at ~700px height.

### F2 — `pi-star` keyboard reachability (SMALL)
`.pi-star` is `opacity: 0` until `.palette-item:hover`. There is a
`.pi-star:focus-visible { opacity: 1 }` rule, but tab order through 50 rows was
never exercised. Consider making the star visible when its row has focus-within.

### F3 — `.palette-item` is now a `<div>` (SMALL, a11y)
It changed from `<button>` to `<div>` so the nested star button is legal HTML.
It kept its click handler but **lost implicit button semantics**. Add
`role="button"` + `tabindex="0"` + an Enter/Space handler, or reshape the markup
so the row is a button and the star is a sibling overlay.

### F4 — `Online Services` children (DEFERRED by design)
`shell-editor-launcher-menu.md` § 4 lists brand-tinted children (Google Sheets,
Slack, Notion, …). The `integration` category has **five** real actions
(`cookie, clipboard, notification, log, http-request`) and none of those brands.
`04-HANDOFF` § 6 params table already marks this **level C — later**. Do not
invent them.

### F5 — status bar values (DEFERRED)
`shell-editor-launcher-menu.md` § 5 describes a status bar
(`Version 1.3.7 · Auto-save enabled · Last saved · Workflow ID · Environment`).
`Version` and `Environment` have **no real source**; `package.json` is
`"version": "37.1.0"` and is not exposed to the front end. Either surface a real
version constant or leave the row out. **Do not print `1.3.7`.**

### F6 — items H / I / J / N from `04-HANDOFF` § 9
Untouched by this pass: floating Add Node palette, group toolbar, the full
9-item node context menu, per-node Run. Read `04-HANDOFF` § 9 for anchors.

---

## 6. Verification command block (copy-paste)

```bash
cd /home/user/webapp

# 1. syntax of every front-end module
for f in public/js/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done

# 2. types + full suite  (expect: 35 files / 647 tests passed)
npx tsc --noEmit && npx vitest run

# 3. line endings — public/** MUST be 0, the two src files MUST keep their CRLF
grep -c $'\r' public/js/*.js public/css/styles.css | grep -v ':0$' || echo "public OK (all LF)"
grep -c $'\r' src/Routes/user.routes.ts src/pipeline.ts   # expect ~1190 and ~2927

# 4. no new front-end JS file was added (would break icons.test.ts)
ls public/js/*.js | wc -l    # expect 18 (17 in JS_ALL + icons.js)
```

---

## 7. Git state and workflow

**Branch:** `genspark_ai_developer`, based on `origin/main` @ `1ed4e8d`.

Commits in this pass (before the final squash):
```
83adbbb feat(editor): shell top bar, OUTLINE panel and 4-tab ACTIVITY LOG
7c1dcf3 style(editor): CSS for shell top bar, split menus, OUTLINE and ACTIVITY LOG
75479f8 fix(canvas): move Auto Layout/Focus Mode to top-end pill row, OUTLINE to start edge
907b012 feat(editor): blocks palette groups, favorites and real footer routes
dbda79a style(editor): blocks palette search row, group rows, favorites and footer
4ed804b test(editor): guard the shell, OUTLINE, ACTIVITY LOG and palette contracts
+ docs commit
```

The house workflow for every change: commit → `git fetch origin main` → rebase →
**squash to ONE commit** (`git reset --soft HEAD~N && git commit`) → `git push -f`
→ open/update the PR → **share the PR URL with the user**.

---

## 8. Where to look first next session

1. This file, § 2 (corrections) and § 5 (TODO).
2. `docs/uiux/state-empty-canvas.md` — the rewritten authoritative shell spec;
   § 7 is the superseded-claims table.
3. `docs/uiux/04-HANDOFF-editor-shell-outline-activity.md` — still the best
   source for substrate API and file/line anchors; its § 0 box tells you which of
   its own claims are now wrong.
4. `tests/unit/editor-shell.test.ts` — the executable form of every contract
   above. If you are unsure whether something is allowed, this file answers it.
