# 07 — HANDOFF: full-bleed editor shell + bottom dock

> **THIS IS THE CURRENT STATUS DOCUMENT.** It supersedes
> `06-HANDOFF-visual-verification-a11y-statusbar.md` (which superseded `05-…`).
> Read this file first, then `04-HANDOFF-editor-shell-outline-activity.md` § 9
> for the remaining feature backlog.
>
> Written 2026-07-30, at the end of a session that ran out of credits mid-way.
> Everything that was *not* finished is in **§ 5**, with the exact files, line
> anchors and reasoning needed to continue without any chat history.

---

## 0. The standing rules (they are user instructions, not preferences)

1. **Keep developing. Never ask questions.** Search the repo / the web and
   decide yourself.
2. **Where the written spec and the reference image disagree, THE IMAGE WINS.**
   The authoritative images are `docs/uiux/*.webp` (1672×941).
3. **Never build fake-successful UI.** No mock rows, no invented counts, no
   version strings, no links that look live but land nowhere. If the backend
   cannot do it yet: render it **visibly disabled with a tooltip**, or print `—`.
4. **Do NOT add a new front-end JS file.** `tests/unit/icons.test.ts` pins the
   **18** files in `public/js/`. Dev-only tooling lives in `tools/` and is never
   referenced from `src/` or `public/`.
5. Every i18n key must exist in **both** the `fa` and the `en` dictionary in
   `public/js/i18n.js`. `t()` falls back to English, so a missing `fa` key is
   invisible at runtime — that is exactly how the `sb.*` gap survived three
   sessions.
6. Line endings: `public/**` = **LF** (0 CR). `src/*.ts` = **CRLF**
   (`src/Routes/user.routes.ts` 1190 CR, `src/pipeline.ts` 2927 CR,
   `src/Routes/health.routes.ts` 59 CR). Editing a CRLF file with an editor tool
   inserts LF lines — re-normalise afterwards with Python.
7. Workflow: commit after every change → **squash to ONE commit** → force-push
   `genspark_ai_developer` → open/update the PR → **give the user the PR link**.

**The user's governing instruction right now** (verbatim, Persian):

> «من مرج کردم ولی متوجهم که هنوز به نکته نهایی تصاویر ui ارائه شده نرسیدن
> مشتاقم ببینم بعد استپ های بعدی به اون نکته میرسم یا نه / پس ادامه بدع»

= *"I merged, but I notice we still haven't reached the final state of the
provided UI images. I'm eager to see whether the next steps get us there. So
continue."* → **the goal is visual fidelity to the images, not just ticking a
checklist.**

And, from the session that produced this file:

> «اعتبارمون اخراشه … از جایی که قطع شدیم رو ادامه بدی و تا نصفه نمونه و بقیش
> رو توی یک فایل md ذخیره کنی … فقط در نظر بگیر که درگیر دیباگ و تست نشی و هر
> موردی اضافه رو یادداشت کن»

= *"credits are nearly out — continue from where we were cut off, don't leave it
half-done, and save the rest in an md file … don't get bogged down in debugging
and testing, and note every extra item."* → **that is what § 5 is for.**

---

## 1. What this session shipped

The editor is now **full-bleed** and its bottom dock matches
`state-empty-canvas.webp`. Before / after (both 1672×941, `#/editor`, empty
graph):

| | before | after |
|---|---|---|
| screenshot | <https://www.genspark.ai/api/files/s/t1p3KGzf> | <https://www.genspark.ai/api/files/s/tREcCKPN> |
| app sidebar (240px, "Automation Back…") | visible | **gone** |
| "Visual Editor" page header | visible | **gone** |
| editor top bar | started at y≈65 inside a rounded card | **starts at y=0, edge to edge** |
| status bar | trapped mid-screen, covered by the drawer | **last row of the screen, fully legible** |
| ACTIVITY LOG | full-width band pinned to the viewport bottom, painting over the status bar | **docked bottom-START inside the canvas, after both rails, clipped above the status bar** |
| MINIMAP | 180×100 chip, `+ − Fit` as 12px icons in its header | **large panel bottom-END with `+` / `−` / `FIT` stacked in a vertical column on its end edge** |

### 1.1 `public/js/app.js`

```js
var FULLBLEED_ROUTES = ['editor'];              // ~line 245, next to ROUTE_ALIAS
…
// inside handleRoute(), right after the page title is set:
document.body.classList.toggle('route-fullbleed',
  FULLBLEED_ROUTES.indexOf(route) !== -1);
```

* `showLogin()` does `document.body.classList.remove('route-fullbleed')` — the
  login screen must not inherit it.
* `window.AppUtil` gained **`logout: doLogout`**. Hiding `.topbar` took the
  Logout button off the screen; a second logout implementation would drift
  (one clears `ab_session_only`, one wouldn't), so the real one is exposed.

### 1.2 `public/css/styles.css` — new section at the very END of the file

Search for `FULL-BLEED EDITOR ROUTE`. Five numbered parts:

0. `body.route-fullbleed` defines `--fe-mm-w: clamp(220px,30vw,460px)`,
   `--fe-dock-gap: 12px`, `--fe-sb-h: 28px`.
1. `.sidebar` / `.topbar` → `display:none`; `.app` → one column;
   `.content` → `padding:0; overflow:hidden`.
2. `.fe-shell` → `display:flex; height:100vh; padding-bottom:0` (the
   `--rp-head-h` reserve from F7 is *not* needed here because the dock now sits
   above the bar). `.fe-shell .fe-layout` → `height:auto` (kills the site-wide
   `calc(100vh - 250px)`), `flex:1 1 auto`, `min-height:0`, `order:2`.
   `#fe-result` → `order:3`, `max-height:34vh`, `overflow:auto`,
   **`:empty{display:none}`**. `.fe-statusbar` → `order:4`. `.fe-hint` →
   `display:none` (the design has nothing after the status bar and the
   empty-state card already carries the same sentence).
3. `.run-panel` in this route: `inset-inline-start: calc(var(--fe-dock-start) +
   12px)`, `inset-inline-end: calc(var(--fe-mm-w) + 24px + 12px)`,
   `inset-block-end: var(--fe-sb-h)`, and — **the important bit** —
   `transform:none; max-height: var(--rp-head-h)` with
   `.open { max-height: 46vh }`.
4. `.fe-minimap-wrap` → `width: var(--fe-mm-w)`, 12px insets;
   `.fe-minimap` → `height: clamp(96px,18vh,176px)`;
   `.fe-mm-zoom` → 38px; `.fe-mm-btn` → 24×24.
5. `@media (max-width:980px)` → the log spans the screen again and the map
   shrinks back to a chip.

Also **outside** that section (they apply in both modes, because the markup
changed globally):

* `.fe-mm-body { display:flex }`, `.fe-mm-zoom { flex-direction:column; width:26px;
  border-inline-start:1px solid var(--border) }`, `.fe-mm-fit` (word button,
  9px uppercase). `.fe-minimap` gained `flex:1 1 auto; min-width:0`.
* `.fe-avatar` gained `cursor:pointer`, `:hover`, `.open`, `:focus-visible`;
  new `.fe-acct { position:relative; display:inline-flex }`.

> **WHY the collapse mechanism differs on this route** (do not "simplify" it
> back): site-wide the drawer collapses with
> `transform: translateY(calc(100% - var(--rp-head-h)))`. A translated box still
> **paints** its full height, so on the full-bleed route the hidden tail (tabs
> row, filter row) was drawn straight over the status bar — measured with a
> Playwright probe: panel box `871 → 1073.6`, status bar `913 → 941`, tabs
> visible at 917. Clamping `max-height` makes `overflow:hidden` actually clip.

### 1.3 `public/js/flow-editor.js`

* **New `publishDockGutter()`** (just above `applyViewTransform`, ~line 450).
  Measures `dom.canvas.getBoundingClientRect()` + the canvas' own `--fe-ol-w`
  and publishes the logical start gutter as **`--fe-dock-start`** on
  `document.documentElement`.
  *Why:* the ACTIVITY LOG is a body-level `position:fixed` singleton shared with
  the Workspace view, so it cannot see how wide the nested rails are — and there
  are four combinations (palette 240/64/0 × outline 236/26). It is **derived
  every time, never stored**. RTL-aware (`vw - rect.right`).
* Called from the **top of `renderMinimap()`** — every caller of `renderMinimap`
  is exactly a "the canvas box may have changed" moment — plus explicitly in
  `setPaletteCollapsed()`.
* Exposed as **`FlowEditor.syncDock`** so views.js can call it after the OUTLINE
  rail collapses (that rail is rendered by views.js, not the editor).
* **Minimap markup restructured** (`buildOverlay`, ~line 2560): the head keeps
  only the title + close `[x]`; a new `.fe-mm-body` holds `.fe-minimap` next to
  a `.fe-mm-zoom` column containing `+`, `−`, and a word button `FIT`. The click
  handler already bound by `wrap.querySelectorAll('[data-mm]')`, so moving the
  buttons could not unbind them.

### 1.4 `public/js/views.js`

* `setOutlineOpen()` now calls `FE.syncDock()`.
* A `window` `resize` listener calls `FE.syncDock()`; removed in
  `root.__feShellCleanup`.
* **The avatar became a real Account menu.** Was a decorative `<span>`; now
  `<button id="fe-avatar" aria-haspopup="menu">` inside `.fe-acct` with a
  sibling `#fe-acct-menu`, bound through the existing `bindMenu()` idiom right
  after `bindMenu(saveMenuBtn, …)`. Items: **Settings** (`#/settings`),
  **Language** (`I18N.toggle()`, badge = `I18N.meta().label`), separator,
  **Logout** (`AppUtil.logout()`, `danger`, and **disabled when
  `AppUtil.logout` is absent** — an avatar that opens nothing on the only screen
  where Logout is otherwise unreachable would be fake chrome).
  The logout glyph is **`power`**, not `log-out`: the registry has no `log-out`
  key and `IC()` silently falls back to a dot.

### 1.5 `public/js/i18n.js`

Added **`fe.fitShort`** to both dictionaries (`fa: 'جا'`, `en: 'Fit'`). The
minimap column used `t('fe.fit')`, whose real value is the tooltip sentence
*"Fit to screen"* — it overflowed the 38px column (visible in the first
screenshot as `FIT TO SCREEN` bleeding outside the panel).

### 1.6 `tests/unit/canvas-chrome.test.ts`

New `describe('full-bleed editor route')` with **6 tests**: the route table
owns the class (and `showLogin` clears it); the chrome is dropped and the shell
owns the viewport (incl. the two neutralised heights and `#fe-result:empty`);
the drawer clips instead of translating; the gutter is measured and re-published
from all three places; the minimap's stacked column + the short Fit label
(asserting `fe.fitShort` appears **twice** in i18n.js = both dicts); the avatar
is a real menu whose Logout is gated on `AppUtil.logout`.

Suite: **657 → 663 tests, 35 files, all passing.**

---

## 2. Verification actually performed

```bash
cd /home/user/webapp
npx tsc --noEmit                                  # TSC_OK
npx vitest run                                    # 35 files / 663 tests passed
for f in public/js/*.js; do node --check "$f"; done   # clean
ls public/js/*.js | wc -l                         # 18   (hard constraint)
python3 -c "import glob;print([p for p in glob.glob('public/**/*.*',recursive=True) if b'\r' in open(p,'rb').read()])"   # []
```

Visual (the harness is dev-only, `tools/`, never shipped):

```bash
# 1. serve the static build (needs run_in_background: true)
node tools/ui-preview-server.js 8788
# 2. shoot.  args: route  out.png  WxH  [comma-separated selectors to click]
node tools/ui-shot.js '#/editor' /tmp/fb.png 1672x941
node tools/ui-shot.js '#/editor' /tmp/small.png 1280x700
node tools/ui-shot.js '#/editor' /tmp/pal.png 1672x941 '[data-pl="collapse"]'
```

`errors : none` at 1672×941. **The 1280×700 and RTL passes were NOT re-run this
session — see § 5.0.**

Geometry probes: `playwright` cannot be required from `/tmp`, so a probe script
must be written into the repo root and deleted afterwards. It must seed the API
key or it lands on the login gate and `.run-panel` does not exist yet:

```js
await p.addInitScript(() => {
  localStorage.setItem('ab_api_key', 'dev-preview-key');
  localStorage.setItem('ab_user_id', 'dev-preview');
});
await p.goto('http://localhost:8788/index.html#/editor', { waitUntil: 'domcontentloaded' });
```

Headless Chromium deps (once per sandbox):
`sudo apt-get update -qq && sudo npx playwright install-deps chromium`

---

## 3. Design reference, re-read this session

```bash
python3 -c "from PIL import Image; \
Image.open('docs/uiux/state-empty-canvas.webp').save('/tmp/design.png'); \
Image.open('docs/uiux/shell-add-node-palette.webp').save('/tmp/design-addnode.png')"
```

`state-empty-canvas.webp` measured (in the 1568-wide rendering of the 1672px
image): left icon rail `0→66`; top bar `0→53`; ACTIVITY LOG `x 105→990,
y 565→800`; MINIMAP `x 1005→1560, y 565→795` with the `+ − Fit` column at
`x 1470→1505`; status bar `y 828→865`.

Note the design captures the palette **collapsed to the 64px icon rail** and the
OUTLINE **collapsed to its vertical tab**. Both states exist in the build; the
build simply *defaults* to expanded. That is a defaults question, not a missing
feature — see § 5.1.

---

## 4. Where the code is (anchors that save a grep)

| what | file : anchor |
|---|---|
| route tables, `FULLBLEED_ROUTES`, `handleRoute` | `public/js/app.js` ~199–265, ~400 |
| `AppUtil` (`health`, `logout`, `toast`, `t`) | `public/js/app.js` ~585 |
| whole editor shell markup (top bar → statusbar) | `public/js/views.js` ~908–1005 |
| `menuItem()` / `bindMenu()` / `closeMenus()` | `public/js/views.js` ~1253–1315 |
| Export ▾ / Save ▾ / **Account ▾** bindings | `public/js/views.js` ~1345 / ~1431 / ~1433 |
| `setOutlineOpen()` (+ `FE.syncDock`) | `public/js/views.js` ~1575 |
| editor cleanup (`__feShellCleanup`) | `public/js/views.js` ~1690 |
| `environmentCell()` / `refreshStatusBar()` | `public/js/views.js` (search `ENV_LABEL`) |
| `publishDockGutter()` | `public/js/flow-editor.js` ~450 |
| `renderMinimap()` + `MM_MAX_SCALE` | `public/js/flow-editor.js` ~547–615 |
| `ACTIONS`, `categoryOf()` | `public/js/flow-editor.js` / `actions.js` |
| `paletteItem()` (a11y: role/tabindex/Enter-Space) | `public/js/flow-editor.js` ~1900 |
| `PALETTE_GROUPS` (6 real categories) | `public/js/flow-editor.js` ~1970 |
| `renderPalette()` / `renderPaletteList()` | `public/js/flow-editor.js` ~2005 / ~2100 |
| `paletteRail()` (64px collapsed icon rail) | `public/js/flow-editor.js` ~2225 |
| `applyPaletteCollapsed()` / `setPaletteCollapsed()` | `public/js/flow-editor.js` ~2262 |
| `buildOverlay()` — pills / toolbar / minimap | `public/js/flow-editor.js` ~2455–2620 |
| `toggleFocusMode()` | `public/js/flow-editor.js` ~2790 |
| `FlowEditor` public API | `public/js/flow-editor.js` ~2880 |
| empty-state card builder | `public/js/flow-editor.js` ~971 |
| `.fe-layout` / `.fe-topbar` | `public/css/styles.css` ~510 / ~534 |
| `.fe-focus`, minimap wrap, `.fe-minimap` | `public/css/styles.css` ~1198 / ~1211 / ~1300 |
| `--rp-head-h`, `.run-panel`, `.rp-head` | `public/css/styles.css` ~1500–1530 |
| `.fe-shell` / `.fe-statusbar` | `public/css/styles.css` ~1818 / ~1832 |
| `.fe-menu` / `.fe-mi` / `.fe-avatar` | `public/css/styles.css` ~3476 / ~3490 / ~3561 |
| `.fe-canvas { --fe-ol-w }` | `public/css/styles.css` ~3633 |
| `.fe-pal-collapsed`, `.pl-rail`, `.pl-restore` | `public/css/styles.css` ~4152–4230 |
| **FULL-BLEED section** | `public/css/styles.css` **end of file** |
| `.ndv-run-btn` (for item N) | `public/css/styles.css` ~1740 |

---

## 5. WHAT IS LEFT — the actual TODO, in priority order

### 5.0 Cheap follow-ups to the work just shipped (do these first, ~30 min)

- [ ] **Re-shoot at 1280×700 and at 980px.** Only 1672×941 was verified after
      the dock change. The `@media (max-width:980px)` branch of the new section
      is written but has **never been rendered**.
- [ ] **RTL pass.** `publishDockGutter()` reads
      `document.documentElement.getAttribute('dir') === 'rtl'`. Confirm that is
      how the app actually sets direction (check `i18n.js#apply()`); if it sets
      `dir` on `<body>` instead, the RTL dock lands on the wrong edge.
      Take one screenshot with the Persian dictionary active.
- [ ] **`#fe-result` in full-bleed.** It is re-ordered above the status bar with
      `max-height:34vh`. Never exercised — click `Export ▾ → Export as JSON` in
      the harness and confirm it does not squash the canvas to nothing.
- [ ] **Open the ACTIVITY LOG in full-bleed** (`.rp-head` click) and confirm the
      `max-height: 46vh` open state looks like the design's expanded panel
      (`Runs / Execution / Variables / Logs`, `Execution` active).
- [ ] Consider adding the two shipped screenshots to `docs/uiux/` so the next
      session has a committed before/after (the genspark file URLs in § 1 are
      session-scoped and will 403 for anyone else).

### 5.1 Remaining *visual* deltas vs `state-empty-canvas.webp`

- [ ] **Defaults.** The design shows the palette collapsed to the 64px icon rail
      *and* the OUTLINE collapsed to its vertical tab. The build defaults both to
      expanded. Decide deliberately (and write it down): either default to
      collapsed to match the image, or persist the last state in
      `localStorage` next to `ab_palette_favs`. **Do not** hardcode collapsed
      without persistence — a user who expands the palette should not find it
      collapsed again on every navigation.
- [ ] **Icon rail contents.** `paletteRail()` currently renders one button per
      `PALETTE_GROUPS` entry (6). The design's rail has ~13 glyphs: Favorites +
      the categories + the footer destinations (Templates / Variables /
      Connections / Settings) + the `»` expander at the bottom. Adding the
      footer icons to the rail is honest (they are the same real destinations
      listed in `state-empty-canvas.md` § 2C) and closes most of the visible gap.
- [ ] **Minimap proportions.** At 460×~197 the map body has a lot of dead space
      because `MM_MAX_SCALE = 0.14` caps the zoom. The design's map fills its
      frame. Revisit the cap *only* together with the union-with-viewport
      framing (see `06-HANDOFF` § 3) — the cap exists so a 1-node graph does not
      render as a solid slab.
- [ ] **Top bar detail.** The design shows the workflow **tab strip** with
      several tabs and a dashed `+ New Workflow` chip. Ours renders real data
      from `API.listWorkflows()`, so with the stub server it shows one tab. That
      is correct behaviour, not a bug — but check it against a seeded backend
      before "fixing" anything.

### 5.2 Item **H** — floating **Add Node** palette (highest feature value)

Reference: `docs/uiux/shell-add-node-palette.webp` + `.md`
(convert: `Image.open(...).save('/tmp/design-addnode.png')`).

Opened by **`+ Add First Node`** on the empty-state card and by the canvas `+`
affordance. Reuse `ACTIONS`, `categoryOf()`, `PALETTE_GROUPS` and
`paletteItem()` — do **not** write a second catalog renderer. Search + `⌘K`
behaviour already exists in `renderPalette()`; lift the shared parts rather
than copying them. Counts must be computed from real members (the image's
counts are mock — `state-empty-canvas.md` § 6).

### 5.3 Item **J** — full 9-item node context menu

i18n keys `fe.nodeMenu`, `fe.cloneNode`, `fe.pinNode`, `fe.unpinNode` already
exist in both dicts. Anything with no backing must render **disabled with a
tooltip** (`menuItem(..., { disabled: true })` already does exactly this).

### 5.4 Item **I** — group-selection toolbar

Appears when `Object.keys(state.selSet).length > 1`. Box-select already
maintains `state.selSet` (`applyBoxSelection()`, flow-editor.js ~2432).

### 5.5 Item **N** — per-node Run — **BACKEND FIRST**

`API.runNode()` does not exist and there is no endpoint. `.ndv-run-btn` CSS is
already at `styles.css` ~1740. **Shipping the button alone would be
fake-successful UI — build the endpoint first.**

### 5.6 Deferred by design (do not "fix")

* **F4** — do not invent brand children (Google Sheets / Slack / Notion) under
  `Online Services`. The catalog has 5 real `integration` actions.
* The image's `Version 1.3.7`, its 7 palette rows / 128 blocks, its
  `General` + `Elements` rows and its per-row counts are **all mock**. See
  `state-empty-canvas.md` § 6.

---

## 6. Copy-paste verification block for the next session

```bash
cd /home/user/webapp
git log --oneline -3
git status --porcelain

npx tsc --noEmit && echo TSC_OK
npx vitest run 2>&1 | tail -6                       # expect 35 files / 663 tests
for f in public/js/*.js; do node --check "$f" || echo "FAIL $f"; done
ls public/js/*.js | wc -l                           # MUST be 18
python3 -c "import glob;print('CR:',[p for p in glob.glob('public/**/*.*',recursive=True) if b'\r' in open(p,'rb').read()])"
python3 -c "print('user',open('src/Routes/user.routes.ts','rb').read().count(b'\r'))"      # 1190
python3 -c "print('pipeline',open('src/pipeline.ts','rb').read().count(b'\r'))"            # 2927
python3 -c "print('health',open('src/Routes/health.routes.ts','rb').read().count(b'\r'))"  # 59

# visual
node tools/ui-preview-server.js 8788        # run_in_background: true
node tools/ui-shot.js '#/editor' /tmp/a.png 1672x941
node tools/ui-shot.js '#/editor' /tmp/b.png 1280x700
```

---

## 7. Session ledger (files touched, 2026-07-30)

| file | change |
|---|---|
| `public/js/app.js` | `FULLBLEED_ROUTES`, `route-fullbleed` toggle in `handleRoute`, cleared in `showLogin`, `AppUtil.logout` |
| `public/js/views.js` | avatar → real Account menu (`#fe-acct-menu`, `renderAcctMenu`, `bindMenu`); `setOutlineOpen` calls `FE.syncDock`; window `resize` → `syncDock` (+ removed in cleanup) |
| `public/js/flow-editor.js` | `publishDockGutter()`, hooked into `renderMinimap` + `setPaletteCollapsed`, exported as `syncDock`; minimap markup → `.fe-mm-body` + vertical `.fe-mm-zoom` column, `FIT` uses `fe.fitShort` |
| `public/js/i18n.js` | `fe.fitShort` in **both** dictionaries |
| `public/css/styles.css` | `.fe-mm-body` / `.fe-mm-zoom` / `.fe-mm-fit`; `.fe-minimap` flex; `.fe-avatar` button states + `.fe-acct`; **new FULL-BLEED section at end of file** |
| `tests/unit/canvas-chrome.test.ts` | +6 guard tests (`describe('full-bleed editor route')`) |
| `docs/uiux/07-HANDOFF-fullbleed-editor-shell.md` | **this file** |
| `docs/uiux/README.md` | points here |
| `docs/uiux/06-HANDOFF-…md` | superseded banner |

Untouched but relevant: `public/js/icons.js` (registry `P`; **no** `log-out`
key — use `power`), `tools/ui-shot.js`, `tools/ui-preview-server.js`
(`/health` stub returns `env:'development', mode:'multi'`; every list endpoint
returns EMPTY data on purpose).
