# HANDOFF 12 — shell parity (G4/G6/G1/G8/G13), the real brand mark, the Persian chrome sweep, and the 980 px pass

> **SUPERSEDED** by `13-HANDOFF-ndv-reachability-scroll-density.md`. Read that
> file instead; it carries § 0 forward verbatim and its § 5 is the live to-do
> list. This file is kept for the 980 px investigation and the anchor tables.
>
> Two statements below are now known to be **incomplete**:
> * § 6 item 1 treats G7 as "build out the NDV". The NDV was in fact already
>   built and **unreachable** — `selectNode()` destroyed the card mid-gesture, so
>   `dblclick` never fired. See handoff 13 § 1.1.
> * The design base it names is right, but it does not say to **crop the WebP at
>   1:1 and read it**. Every real parity finding this session came from the crop,
>   and the written spec's control heights contradict it. See handoff 13 § 1.3.
>
> (Historical header: it superseded `11-HANDOFF-labels-fit-prefs-render-compare.md`.)

---

## § 0. Standing rules (instructions, not preferences)

Unchanged from handoff 11. Restated here in full so this file is self-sufficient.

1. **Keep developing. Never ask the user questions.** Search the repo, decide, and document the decision here.
2. **Image beats prose.** `docs/uiux/*.webp` outranks every `.md` in this folder, including this one. When an
   icon or a geometry is in question, crop and zoom the WebP instead of guessing:
   ```bash
   magick docs/uiux/state-empty-canvas.webp /tmp/x.png
   magick /tmp/x.png -crop 400x160+240+60 +repage -resize 300% /tmp/zoom.png   # then read /tmp/zoom.png
   ```
   **This session proved the rule with a real defect: handoff 11 described the brand mark wrongly.** See § 3.
3. **Never ship fake-successful UI.** No mock rows, no invented counts, no "Success" that no run produced.
   If the backend cannot do it yet, render the control **disabled with a tooltip that says why**.
4. **Real counts only.** A badge showing `12` must come from data, not from a literal.
5. **Do not add a new front-end JS file.** `tests/unit/icons.test.ts` pins **18** files in `public/js/`.
   Dev tooling goes in `tools/` (not counted). Test files are not counted either.
6. **Every i18n key must exist in BOTH the `fa` and `en` dictionaries** of `public/js/i18n.js`.
   `t()` falls back `fa → en → key`, so an en-only key silently leaks English into Persian — the default
   locale — and a key missing from both renders its own raw name in the UI. Only a source-level test sees this.
   **A key that EXISTS in `fa` but holds an English value leaks just as badly and no previous test caught it.**
   See § 4 and the new guard.
7. **Line endings.** `public/**` = LF (**0 CR**). `src/Routes/user.routes.ts` = CRLF (**CR count 1317** —
   patch it with Python `io.open(..., newline='')`). `src/schemas.ts` CR=0.
8. **Git flow, every time.** commit → `git fetch origin main` → rebase → **squash to ONE commit**
   (`git reset --soft HEAD~N && git commit -F /tmp/commitmsg.txt`) → `git push -f origin genspark_ai_developer`
   → create/update the PR → **hand the user the PR link**. Never use backticks inside `git commit -m`;
   always write the message to a file and use `-F`.

### Verification quartet (run before every commit)
```bash
cd /home/user/webapp
npx vitest run          # expect: 37 files, 783 tests passing (as of this handoff)
npx tsc --noEmit        # expect: silent
ls public/js/*.js | wc -l                 # expect: 18
grep -c $'\r' src/Routes/user.routes.ts   # expect: 1317
grep -rl $'\r' public/ | head             # expect: no output
```

### Render harness (how every claim below was checked)
```bash
node tools/ui-preview-server.js 8788 &          # static only; ONE expected 404 on #/workspace
UI_LANG=en UI_SEED=login-form node tools/ui-shot.js '#/editor' /tmp/render/x.png 1672x941
UI_LANG=fa UI_SEED=login-form node tools/ui-shot.js '#/editor' /tmp/render/x-fa.png 980x900
```
`UI_SEED` ids: `price-scrape`, `login-form` (6 steps), `scheduled-screenshot`. `UI_WAIT=<ms>` adds settle time.
The 5th CLI argument is a comma-separated interaction list (`.sel` click, `dbl:.sel`, `key:Escape`).
Playwright needs system libs once per sandbox: `sudo npx playwright install-deps chromium`.

---

## § 1. What shipped in this session

Handoff 11 § 5 listed nine numbered items in priority order. Items **1, 2, 3, 4, 6 and 7** are done.

### 1.1 G4 — the breadcrumb row is hidden, the DOM is intact  ✅
`.fe-crumbline` is rendered with `id="fe-crumbline" hidden` in `views.js`. The element **must stay in the DOM**:
`refreshWfLabel()` writes `#fe-wf-label` / `#fe-wf-badge` unconditionally, and the six `.fe-legacy` ids below it
carry **unguarded** `addEventListener` calls — removing the row throws on route entry.

**Trap:** `hidden` alone did nothing. The class rule sets `display: flex`, which beats the UA
`[hidden] { display: none }` on specificity. An explicit `.fe-crumbline[hidden] { display: none; }` is required.

### 1.2 G6 — ACTIVITY LOG is open by default, on `Execution`, and remembers  ✅
`run-panel.js` gained `DOCK_PREF = 'feDockOpen'`, `dockPref(fallback)`, `rememberDock(open)`, and
`open(remember)` / `close(remember)`. `mount()` ends with:
```js
if (dockPref(true)) open(false); else close(false);
```
`remember !== false` is the established convention (it mirrors `setOutlineOpen(open, remember)`): **restoring a
stored preference must not be recorded as a fresh user choice**, or the first render would rewrite the blob.

Four tabs (`runs / execution / variables / logs`) with `alTab = 'execution'` as the default were already present.

**The knock-on that mattered more than the flag:** an open dock covers the bottom band of the canvas, so
`fitToScreen()` parked the tail of a long chain behind the drawer — the exact ghost-card bug panel-aware fit was
introduced to kill. `canvasInsets()` now charges the dock:
```js
var dock = document.getElementById('run-panel');
if (dock && dock.offsetHeight) {
  var dr = dock.getBoundingClientRect();
  var overlap = rect.bottom - dr.top;
  if (overlap > 0 && dr.right > rect.left && dr.left < rect.right) {
    ins.bottom = Math.max(ins.bottom, overlap + 16);
  }
}
```
It is measured from the live rect, not hard-coded to `46vh`, because the dock is a **body-level
`position: fixed` singleton** — the `dom.canvas.querySelectorAll(...)` sweep above it cannot see it — and because
the site-wide (non-full-bleed) variant sits below the fold and must therefore cost nothing.

### 1.3 G1 — the palette row vocabulary is decided  ✅
Handoff 11's comment table already claimed the image's wording, but the code still rendered `t(cat.label)`, so
the two had silently drifted. Decision, now enforced in one place:

| `actions.js` category | palette row label | i18n key | icon | real count |
|---|---|---|---|---|
| `trigger` | TRIGGERS | `pg.triggers` | `zap` | 4 |
| `navigation` | BROWSER | `pg.browser` | `globe` | 10 |
| `interaction` | WEB INTERACTION | `pg.webInteraction` | `mouse-pointer` | — |
| `flow` | FLOW CONTROL | `pg.flowControl` | `git-branch` | — |
| `integration` | ONLINE SERVICES | `pg.onlineServices` | `layers` | — |
| `data` | DATA | `pg.data` | `database` | — |

Exactly **six** rows, one per real category in `window.ACTION_CATALOG` (50 actions). **No invented rows and no
invented counts** — every badge is `members.length`. One helper stops the drift from recurring:
```js
function paletteGroupLabel(g, cat) {
  if (g && g.label) return t(g.label);
  return t((cat && cat.label) || 'cat.other');
}
```
It is called from `paletteGroupHead`, from `addCategories()` (the Add-Node panel) **and** from `paletteRail()`, so
the list, the rail and Add Node cannot disagree. The 6 `fa` + 6 `en` keys were inserted by
`tools/patch-pg-i18n.py`.

### 1.4 G8 — the collapsed rail is the full 13 glyphs  ✅
`paletteRail()` was rewritten around a `railBtn(opts)` factory (`icon, name, cls, group, act, color, disabled,
onClick`). Order, which the guard test pins arithmetically as `1 + groupRows + links + 1 === 13`:

1. **Favorites** — `star`, count `ACTIONS.filter(a => paletteFavs[a.id]).length`; opens `paletteOpen.__fav` and
   scrolls `.palette-group-head.pg-fav` into view.
2. **six group glyphs** — tooltip `paletteGroupLabel(g, cat) + ' · ' + members.length`.
3. `<span class="pl-rail-sep">` — a hairline, not a button.
4. **five footer links** from `PALETTE_LINKS`, `disabled: !!l.disabled`, tooltip `t(l.key) + ' — ' + t(l.disabled)`
   (rule § 0.3: a link the backend cannot serve is disabled **and says why**).
5. the `pl-restore` expander chip, **last**.

`railOpenGroup(groupId)` sets `paletteOpen[groupId] = true`, calls `setPaletteCollapsed(false)`,
`renderPaletteList()`, then scrolls the row into view — clicking a rail glyph expands the panel *at that group*.
Every glyph name was verified present in the registry (a miss renders the invisible `dot` fallback **silently**).

### 1.5 G13 — the brand mark is a real glyph  ✅
`icons.js` gained `aria-mark`, inserted alphabetically between `alert-triangle` and `arrow-down`
(registry now **100** entries). It is used by both shells: `views.js` (`IC('aria-mark', 22)`) and the sidebar in
`index.html` (`data-icon="aria-mark" data-icon-size="20"`). `zap` was the stand-in and was actively wrong — it is
also the **Triggers category glyph**, so the brand and a palette row rendered the same picture.

See § 3 for how the shape was determined, and why handoff 11's prose about it must not be trusted.

### 1.6 G10 (first half) — the Persian chrome sweep  ✅
39 `fa` values in the editor chrome held **English text**. Rule § 0.6 had only ever been tested for key
*presence*, so every one of them passed. All 39 are now Persian, applied by
`tools/patch-fa-shell-i18n.py` (keyed by *expected English source → Persian*, idempotent per key, refuses to
touch a value that no longer matches).

### 1.7 G10 (second half) — the 980 px pass  ✅
Two real defects, both CSS-only. Both are described in § 2 because the mechanism is worth keeping.

### 1.8 Guard tests  ✅  (suite now **783** in 37 files, from 768)
- `tests/unit/editor-shell.test.ts`: +6 for G4/G6/G1/G8/G13, +3 for the fa sweep, +6 for the 980 px pass
  (**54 in the file**). The existing rail test was updated for the `railOpenGroup` refactor.
- `tests/unit/canvas-chrome.test.ts`: one assertion **tightened** — see § 2.1.

---

## § 2. The 980 px findings (the valuable part)

Both defects were found by rendering, then diagnosed by **measuring in the live page** rather than by reading CSS
and guessing. The measurement step is what turned a wrong hypothesis into the real cause; do it this way.

```js
// throwaway probe (must live INSIDE the repo — `playwright` does not resolve from /tmp)
const stack = document.elementsFromPoint(250, 540).map(describe);   // what is actually on top
```

### 2.1 The canvas rendered as an empty grid — an opaque toolbar was stretched over the nodes
`fitToScreen` was **innocent**. Handoff 11 § 6 says "a zoom one point off the 0.4 floor means suspect the
insets"; that heuristic sent me the wrong way. The measurements:

| element | 980×900 (before) | 1672×941 (correct) |
|---|---|---|
| `.fe-zoom-ctrl` | `12,419,**932×358**`, insets `50/12/12/12` | `1330,115,318×40` |
| `.fe-canvas-toolbar` | *identical rect* | *identical rect* |
| first `.flow-node` | `212,528,79×26`, `visible`, `opacity 1` | visible |

Three facts combine:
1. **`.fe-zoom-ctrl` and `.fe-canvas-toolbar` are the SAME element** (one node carrying both classes) — the
   identical rects are the tell.
2. **Two different `@media (max-width: 980px)` blocks docked it to opposite corners.** The one at line ~1441 said
   `inset-block-end: 12px; inset-inline-start: 12px` (bottom-start, written before the full-bleed refactor); the
   one at line ~4072 said `inset-block-start: 50px; inset-inline-end: 12px` (top-end) but **did not reset the
   pair it was not using**. Neither block is wrong when read alone. Merged, all four insets resolved.
3. An absolutely positioned box with all four insets resolved **stretches to the gap between them**. This one is
   opaque (`background: var(--bg-elev)`) at `z-index: 5`; the node layer is `z-index: 2`. The nodes were rendered,
   hit-testable, and completely covered. `align-items: center` is why the controls appeared floating in
   mid-canvas: they were centred in a 358 px-tall box.

**Fix.** The stale bottom-start override is deleted, the surviving rule restates the `auto` pair, and the base
rule states the invariant where the docking is defined:
```css
/* CONTRACT: this bar is docked by exactly TWO insets — one block, one inline — ... */
.fe-zoom-ctrl,
.fe-canvas-toolbar {
  position: absolute;
  inset-block-start: 62px;
  inset-inline-end: 24px;
  inset-block-end: auto;
  inset-inline-start: auto;
  ...
}
```
`canvas-chrome.test.ts` used to assert `expect(tb).not.toMatch(/inset-inline-start:/)` to mean "docked end, never
start". That banned the very `auto` that now guarantees it, so it was tightened to forbid a **length** and require
the `auto`. **Do not loosen it back.**

### 2.2 The palette footer was painted over by the list
`.fe-palette` is a height-capped flex column at 980 px (`max-height: 200px`). Measured:
`.palette-list` = `8,139,964×**0**` with `scrollHeight 2401`; `.palette-foot` = `10,147,960×170`, i.e. bottom
**317** against a panel bottom of **287**. Flex starved the list to zero height, the narrow-viewport override set
`overflow: visible`, and ~2400 px of rows painted straight out of the box over the footer links (the render showed
`TRIGGERS` and `Connections` written on top of each other).

**Fix** — keep the base contract (*the list is the only scroller*), give it a floor, and give the height back by
laying the 5-link footer out as a wrapping row:
```css
.fe-palette { overflow: hidden; max-height: 264px; }
.palette-list { overflow-y: auto; overflow-x: hidden; min-height: 96px; }
.palette-foot { flex-direction: row; flex-wrap: wrap; gap: 2px 4px; }
.palette-foot > .pl-link { width: auto; flex: 0 0 auto; }
```
`.pl-link` is `width: 100%` by default — without releasing it the wrap does nothing.
After: list `156px` and scrolling, footer one row ending at `338` inside a panel ending at `351`.

**Result at 980×900:** all 7 nodes and their connectors visible at 41 % (that zoom is *arithmetically correct*
for a 1710 px chain in 708 px of available width — it is not a bug), footer one clean row, no overlap. Verified in
`en` **and** `fa`/RTL, and re-verified at 1672×941 for regression.

### 2.3 The guards were mutation-tested
A guard that cannot fail is decoration. Both defects were re-introduced and the suite was re-run:

| mutation | failures |
|---|---|
| original cascade (bad rule back **and** `auto` pair removed) | 3 |
| `.palette-list { overflow: visible }` back | 1 |
| fixed stylesheet | 0 |

The first mutation attempt only restored the bad rule and the suite stayed green — **correctly**, because the
restated `auto` pair genuinely defuses it. Reproducing the original *ordering* was required to prove the guard.
Worth remembering: when mutation-testing a cascade bug, mutate the cascade, not one declaration.

---

## § 3. The brand mark, and a documentation defect in handoff 11

Handoff 11 described the mark as *the letter `A` in an orange rounded tile*. **That is wrong.** Cropping and
zooming `state-empty-canvas.webp` (1672 px, the authoritative editor reference) shows an orange **`(o)`**: two
opposed arcs around a small ringed pupil, drawn as strokes, **with no filled tile at all**.

```js
'aria-mark': [
  '<path d="M9.6 4.9a7.6 7.6 0 0 0 0 14.2"/>',
  '<path d="M14.4 4.9a7.6 7.6 0 0 1 0 14.2"/>',
  '<circle cx="12" cy="12" r="3.1"/>',
  '<circle cx="12" cy="12" r="1" fill="currentColor"/>',
]
```
```css
.fe-brand-mark { width:24px; height:24px; display:inline-flex; align-items:center;
                 justify-content:center; color: var(--primary); }
.fe-brand-mark .ic { stroke-width: 2.1; }
```
The glyph itself carries `--primary`; a guard test asserts there is **no** `background: var(--primary)` on
`.fe-brand-mark`, because that is exactly the tile handoff 11's prose would have produced.

`workspace-overview.webp` shows a *different*, network-like glyph in the same slot. It is the lower-resolution
image, so it loses (§ 0.2). If a future session re-traces this, use the 1672 px file.

**Tooling note.** `understand_images` could **not** read local `/tmp/*.png` crops (it resolved the path against
AI Drive and failed). The plain **Read tool renders local images fine** — use it for crop inspection.

---

## § 4. The fa/RTL sweep, and the hole in rule § 0.6

`ab_lang` defaults to `en` in the harness but the **product default is `fa`**, so an English string sitting in the
`fa` dictionary is what most users actually see. 39 keys under `al.* / ol.* / pl.* / sh.*` were in that state and
every existing test passed, because the tests only ever checked that the key *existed in both dicts*.

New guard, in `editor-shell.test.ts`:
```ts
const LATIN_BY_DESIGN = new Set(['pl.shortcut']);   // the `K` of `Ctrl K` — a key cap, not a word
// every fa value for (al|ol|pl|sh).* must contain Persian, unless listed above
// ...and the en dictionary must contain no Persian (the reverse mistake)
```
It immediately earned its place: my own ASCII sweep missed `pl.search` because the value ended in **U+2026**
(`Search blocks…`), not `...`. **Anything added to `LATIN_BY_DESIGN` needs a written reason next to it.**

Persian compounds need **ZWNJ (U+200C)**. Both patch scripts write it as a `~` placeholder in the table and
expand it on write, which keeps the source readable:
`'pl.search': ('Search blocks\u2026', 'جست~وجوی بلوک~ها\u2026')`. Both use `io.open(..., newline='')` (rule § 0.7).

---

## § 5. Anchor table (verified this session)

| what | where |
|---|---|
| editor shell markup | `views.js` `renderEditor()` ~886 |
| `.fe-crumbline` (hidden) | `views.js` ~915 |
| `#fe-wftabs` tab strip (real, from `API.listWorkflows`) | `views.js` ~920 |
| `RunPanel.mount()` call | `views.js` ~1043 |
| `refreshWfLabel()` | `views.js` ~1095 |
| `renderTabs()` | `views.js` ~1475 |
| `setOutlineOpen(open, remember)` | `views.js` ~1615 |
| `refreshRunInfo()` — **G5 still unpopulated** | `views.js` ~1637 |
| `prefGet / prefSet / hydrateViewPrefs` | `flow-editor.js` 95–120 |
| `PORT_ADD_R = 9` | `flow-editor.js` ~397 |
| `publishDockGutter()` | `flow-editor.js` ~495 |
| `canvasInsets()` — incl. the dock charge | `flow-editor.js` ~553 |
| `fitToScreen()` | `flow-editor.js` ~600 |
| `NODE_DISPLAY_NAMES` (50 actions) | `flow-editor.js` ~1721 |
| `actionLabel()` | `flow-editor.js` ~1781 |
| `PALETTE_GROUPS` + `paletteGroupLabel()` | `flow-editor.js` (before `renderPalette`) |
| `PALETTE_LINKS` | `flow-editor.js` ~3115 |
| `renderPalette()` | `flow-editor.js` ~3124 |
| `railBtn()` / `railOpenGroup()` / `paletteRail()` | `flow-editor.js` after `renderPalette` |
| `AL_TABS`, `alTab`, `showTab()`, `getSummary()`, `onUpdate()` | `run-panel.js` |
| `DOCK_PREF` / `dockPref` / `rememberDock` | `run-panel.js` |
| `PREFS_KEY = 'ab_ui_prefs'`, `readPrefs / pref / setPref` | `app.js` 47–83 |
| `window.AppUtil` | `app.js` ~630 |
| `CATEGORIES` (6, with `color` + `label:'cat.*'`) | `actions.js` ~390 |
| toolbar docking CONTRACT | `styles.css` ~1143 |
| narrow-viewport block A | `styles.css` ~1431 |
| narrow-viewport block B (toolbar dock) | `styles.css` ~4061 |
| narrow-viewport block C (palette) | `styles.css` ~4398 |

**Token trap (unchanged).** `--text-mute`, `--accent`, `--surface-2`, `--text-disabled` **do not exist**. Valid:
`--bg-elev`, `--bg-elev-2`, `--text`, `--text-dim`, `--text-faint`, `--primary`, `--primary-soft`, `--success`,
`--danger`, `--warn`, `--border`, `--border-strong`, `--info`, `--surface-0`, `--radius-sm`.

**Sticky prefs.** ONE namespaced blob `localStorage['ab_ui_prefs']` via `AppUtil.pref(k, fallback)` /
`AppUtil.setPref(k, v)`. Keys so far: `fePaletteCollapsed`, `feOutlineOpen`, `feDockOpen`. `app.js` is the **last**
script tag, so `flow-editor.js` and `run-panel.js` must read `window.AppUtil` at **call** time, never at load time.

---

## § 6. What to do next — priority order

Handoff 11's list, minus what shipped. For every item: **render before and after with `tools/ui-shot.js`, compare
against the WebP, add or update a guard test, run the § 0 verification quartet, commit, and update this file.**

1. **G7 — NDV build-out.** The largest remaining gap by far. Design base is the original NDV design brief plus
   `ndv-click-element-final.webp` / `ndv-condition-final.webp`; intended layering
   `ndv-model → ndv-ui → ndv-nodes → flow-editor`. **Remember the 18-file pin** (§ 0.5) — new NDV code goes into
   existing files unless a file is retired in the same change. Open it in a render with
   `'dbl:.flow-node'` as the 5th `ui-shot.js` argument.
2. **G5 — the run-info strip.** `refreshRunInfo()` (`views.js` ~1637) is wired but renders nothing.
   `RunPanel.getSummary()` already exists and is the intended source. Real values only — no placeholder run.
3. **G9 — the running glow** on node cards. Purely presentational; drive it off the status class the run panel
   already sets (`status-*`), never off a timer.
4. **G3 — workflow tab strip refinement.** The strip is already real data; compare it against the WebP.
5. **G11 — `#fe-result` placement** in the full-bleed shell.
6. **G12 — group / convert-to-subflow**, and per-node Run on branch nodes.
7. **G2 — Online Services sub-items.** There are no real integrations, so under § 0.3 these stay **disabled with
   a reason, or omitted**. Do not invent providers.

### Loose ends (nothing hidden)
- `tools/ui-preview-server.js` is static-only, so `#/workspace` logs **one expected 404**. Not a bug.
- A throwaway Playwright probe must be created **inside the repo** (`playwright` will not resolve from `/tmp`).
  Delete it before committing — it would otherwise be an uncommitted stray, and it is not counted by the 18-file
  pin only because that pin counts `public/js/*.js`.
- Renders under `/tmp/render/` are verification artefacts and are **never committed**.
- `41 %` zoom at 980 px with the `login-form` seed is correct, not a floor collapse. Do not "fix" it.
