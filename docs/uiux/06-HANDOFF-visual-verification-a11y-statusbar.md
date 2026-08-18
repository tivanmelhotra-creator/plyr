# 06 — HANDOFF: visual verification, palette a11y, a real status bar

> ## ⚠ SUPERSEDED 2026-07-30 — read `07-HANDOFF-fullbleed-editor-shell.md` first
>
> § 5's headline leftover ("the editor is **not full-bleed**: the app sidebar and
> the 'Visual Editor' page header are still visible") **is now done**, together
> with the bottom dock (ACTIVITY LOG bottom-start, MINIMAP bottom-end with the
> stacked `+ − Fit` column). The remaining TODO lives in `07-HANDOFF` § 5.
>
> Everything else here — the screenshot harness (§ 2), the guard-test style, the
> anchors — is still accurate and still worth reading.

> **Written:** 2026-07-30 · **Branch:** `genspark_ai_developer` · **Base:** `origin/main` @ `db0048b`
> **Audience:** the next session, which starts with **ZERO chat history**.
>
> This file supersedes `05-HANDOFF-palette-docs-followups.md` for *status*.
> `04-HANDOFF-editor-shell-outline-activity.md` is still the best source for
> *file/line anchors* and for the substrate API, and its § 9 backlog is still the
> definition of the remaining work.
>
> **What this session was:** the follow-up list `05-HANDOFF` § 5 (F1–F6). The
> headline is that the UI could finally be **looked at** — headless Chromium now
> runs in the sandbox — and looking at it found four real defects, all fixed.

---

## 0. TL;DR

| Item (from `05-HANDOFF` § 5) | State |
| --- | --- |
| F1 — verify the palette visually | ✅ **DONE** — see § 2 for the harness |
| F1a — collapsed palette was an empty 44px gutter, not the design's icon rail | ✅ **FIXED** |
| F1b — minimap rendered one solid slab of colour on a small graph | ✅ **FIXED** |
| F1c — palette footer at ~700px height (the "known unverified risk") | ✅ **VERIFIED** — the flex column is correct; the real culprit was the drawer, see F7 |
| F2 — `.pi-star` keyboard reachability | ✅ **DONE** |
| F3 — `.palette-item` lost its button semantics | ✅ **DONE** |
| F4 — `Online Services` brand children | ⛔ **DEFERRED BY DESIGN** — do not invent them |
| F5 — status bar `Environment` was a hardcoded "Development" | ✅ **DONE** — now from `/health` |
| F6 — items **H / I / J / N** of `04-HANDOFF` § 9 | ❌ **TODO** — the whole remaining chunk, see § 5 |
| F7 *(new, found by looking)* — ACTIVITY LOG head covered the status bar | ✅ **FIXED** |
| F8 *(new, found by looking)* — empty-state card slid under the OUTLINE rail | ✅ **FIXED** |
| F9 *(new, found while adding keys)* — the whole `sb.*` block was missing from the **fa** dictionary | ✅ **FIXED** |

**Verification at the time of writing:**

- `npx vitest run` → **35 files / 657 tests passed** (was 647; +10 new guards)
- `npx tsc --noEmit` → **clean**
- `node --check` on every `public/js/*.js` → clean · `ls public/js/*.js | wc -l` → **18**
- CRLF: `public/**` = 0 CR (correct) · `src/Routes/user.routes.ts` = 1190 CR ·
  `src/pipeline.ts` = 2927 CR · `src/Routes/health.routes.ts` = 59 CR (all lines, correct)
- `#/editor` rendered at 1672×941, 1280×700 and with the palette collapsed:
  **zero console errors**, zero page errors

---

## 1. The rules that override everything

Unchanged, and repeated because a fresh session has no memory of them:

1. **Do whatever is needed and keep developing. Do not ask questions — search and
   decide yourself.**
2. **Where the written spec and the image disagree, THE IMAGE WINS.**
3. The three authoritative images are `workspace-overview.webp`,
   `state-empty-canvas.webp` (**1672×941, newest**) and
   `shell-editor-launcher-menu.webp`. A later image can contain both the
   corrections *and* untouched sections.
4. **Never build fake-successful UI.** No mock rows, no invented counts, no
   links that look live but go nowhere. If there is no backend, render it
   **disabled with a tooltip**, or print `—`.
5. Commit after every change · squash to ONE commit · force-push
   `genspark_ai_developer` · open/update the PR · **give the user the PR link**.

Plus the hard technical constraints (from the original NDV design brief):

- **Do NOT add a new front-end JS file.** `tests/unit/icons.test.ts` pins the
  exact list of 18 files in `public/js/`.
- CSP `script-src 'self'`: no inline handlers, no `eval`, no CDN.
- Every i18n key must exist in **both** dictionaries — `t()` falls back to
  English, so a missing Persian key is invisible at runtime (this is exactly how
  F9 hid for three sessions).
- Chrome/view flags stay module-level vars, never on `state`.

---

## 2. NEW: the UI can now be seen (this is the important part)

`05-HANDOFF` § 5 said the sandbox "lacks the browser system libs" and that
`sudo npx playwright install-deps` was unavailable. **That was wrong** — `sudo -n`
works. One-time setup:

```bash
sudo apt-get update -qq && sudo npx playwright install-deps chromium
```

Two dev-only tools were added under `tools/` (NOT shipped, NOT in `public/`, so
the 18-file rule is untouched):

### `tools/ui-preview-server.js` — static server + minimal stubs

```bash
node tools/ui-preview-server.js 8788        # run with run_in_background: true
```

A plain static server is **not enough**: `app.js#boot()` re-validates the stored
API key against `/me`, so with no backend the page only ever shows the sign-in
card. This server serves `public/` and answers `/me` and `/health`, and returns
**empty arrays** for every list endpoint (`/workflows`, `/jobs`, `/schedules`,
`/executions`, `/connections`, `/templates`, …) — deliberately, so a screenshot
can never show invented rows. `/health` reports
`{ status:'ok', version:<package.json>, env:'development', mode:'multi', redis:'connected' }`.

### `tools/ui-shot.js` — headless screenshotter

```bash
node tools/ui-shot.js '#/editor' /tmp/ui.png 1672x941
node tools/ui-shot.js '#/editor' /tmp/rail.png 1672x941 '[data-pl="collapse"]'
#                     route      out-path      WxH        comma-separated clicks
```

It seeds `ab_api_key` / `ab_user_id` into `localStorage` before navigation and
prints `errors:` (console + pageerror + failed clicks) — `errors : none` is the
signal to trust.

> **Reading geometry, not just pixels.** For overlap questions, a throwaway
> Playwright script that dumps `getBoundingClientRect()` for a handful of
> selectors is far more reliable than eyeballing a PNG. Note that the app scrolls
> inside **`main.content`**, not on `window`, so
> `document.querySelector('main.content').scrollTop = 1e6` is how you get to the
> bottom of the editor. That measurement is what found F7.

> `.webp` cannot be displayed by the Read tool. Convert first:
> `python3 -c "from PIL import Image; Image.open('docs/uiux/state-empty-canvas.webp').save('/tmp/x.png')"`

---

## 3. What changed in this pass

### F1a — the collapsed palette is now the design's icon rail
`public/js/flow-editor.js` → new **`paletteRail()`** (just above
`applyPaletteCollapsed()`).

Collapsed used to be a 44px gutter holding one restore chip; the reference shell
keeps a **category icon rail**. The rail now renders a `»` restore chip plus one
40px button per `PALETTE_GROUPS` entry, each with `aria-label` = *category label ·
real member count*, tinted with the category colour. Clicking a glyph expands the
panel **and** opens that row, then scrolls it into view.

- CSS: `.fe-layout.fe-pal-collapsed` is now `64px 1fr`; `.pl-rail` / `.pl-rail-btn`
  added; the hiding rule is `> *:not(.pl-rail)`.
- The palette itself is still only **hidden by CSS**, never rebuilt — that is what
  preserves the search text and the open-group set across a collapse round trip.
- RTL: the `»` glyph is flipped with `[dir="rtl"] .pl-restore > svg`.
- Narrow viewports (`max-width: 980px`) turn the rail into a wrapping row.

### F1b — the minimap no longer blows up on a small graph
`public/js/flow-editor.js` → `renderMinimap()`, plus new `MM_MAX_SCALE = 0.14`.

Framing only `nodesBBox()` gave `scale ≈ 0.82` for a one-node workflow: the map
rendered a single ~148×52 slab of solid green and pushed `.mm-viewport` out of
sight. Two changes, both needed:

1. the framed region is the **union** of the node bbox and the **current
   viewport** (so "you are here" is always inside the picture), and
2. the scale is **capped**, so the map always reads as a miniature.

The viewport rectangle is now drawn from the same `vx/vy/vw/vh` the frame was
built from, and `v.scale || 1` guards a zero-height canvas against `NaN`.

### F2 + F3 — a block row is operable by keyboard
`paletteItem()` gains `role="button"`, `tabindex="0"` and an Enter/Space
`keydown` handler that bails out when `ev.target !== item` (otherwise activating
the nested star would ALSO drop a node). CSS gains
`.palette-item:focus-visible` (a `<div>` has no default ring) and
`.palette-item:focus-within .pi-star` — without the latter the star was
focusable but invisible, which is worse than not being reachable at all.

### F5 — `Environment` now tells the truth
It rendered `t('sb.envDev')` with a **green** dot unconditionally: on a
production box the status bar cheerfully claimed "Development".

- `src/Routes/health.routes.ts` → the payload now carries
  `env: config.NODE_ENV` and `mode: config.DEPLOYMENT_MODE`.
- `public/js/app.js` → keeps the last payload in `lastHealth`, exposes
  `AppUtil.health()`, and dispatches a **`health:change`** document event. A
  failed probe sets it back to `null` — a cached `production` badge next to an
  OFFLINE indicator would be worse than no badge.
- `public/js/views.js` → new `environmentCell()`: unknown ⇒ `—` with a neutral
  dot; green **only** for a real `production`; an env name outside `ENV_LABEL`
  is printed verbatim rather than mapped to a friendly guess; `· <mode>` is
  appended only when the server reported one. It re-renders on `health:change`,
  registered through `onDoc` so `unmount` cannot leak a listener.
- `Version` was already real (the open workflow's version, `unsaved` when there
  is none). **`1.3.7` is mock and must never be printed** — a test now asserts
  that, ignoring comments.

### F7 — the ACTIVITY LOG head no longer sits on the status bar
`.run-panel` is `position: fixed; bottom: 0` with a collapsed
`translateY(calc(100% - 42px))`, so its head owns the last 42px of the
**viewport**. At ~700px height the editor is taller than the screen, and
scrolling to the bottom parked the status bar *and* the palette's `Collapse` row
permanently underneath it. The 42px is now the token **`--rp-head-h`** with three
consumers (`.run-panel` transform, `.rp-head` min-height, and a new
`padding-bottom` on `.fe-shell`), so the overlap cannot silently come back.

This also settles F1c: `.fe-palette`'s flex column was **correct** all along
(`min-height: 0` on both the panel and `.palette-list`); measured at 700px the
footer sits at `507 → 677` inside a panel ending at `689`.

### F8 — the empty-state card is centred in the FREE canvas
`.fe-outline` is `position: absolute` over the canvas, so it consumes no layout
space; `.fe-empty-card { left: 50% }` therefore slid the card under the rail on a
narrow canvas ("…t building your workflow"). It now uses
`inset-inline-start: calc(var(--fe-ol-w) + (100% - var(--fe-ol-w)) / 2)` and a
width that subtracts the rail, so it tracks the rail's open (236px) and collapsed
(26px) widths for free. `transform` is physical while `inset-inline-start` is
not, so `[dir="rtl"] .fe-empty-card` pulls the other way.

### F9 — the `sb.*` keys existed only in English
All eight status-bar keys were missing from the **fa** dictionary and silently
fell back to English. Added, along with `sb.envProd` / `sb.envTest` /
`sb.envStaging` in both dictionaries. The guard test now walks `sb.*` the same
way it already walked `pl.*` and `sh.*` — including the
`t(cond ? 'sb.on' : 'sb.off')` ternary and the bare-string `ENV_LABEL` table,
neither of which the old `t\('…'\)` regex would have caught.

---

## 4. New guard tests (+10, 647 → 657)

`tests/unit/editor-shell.test.ts`
- *the collapsed rail lists the same real categories as the panel* — rail is built
  from `PALETTE_GROUPS`, skips empty categories, computes counts, has
  `aria-label`s, opens the row it was clicked for, and hides the panel by CSS
  (which is what preserves the search text).
- *a block row is operable by keyboard* — `role`/`tabindex`/Enter+Space/
  `preventDefault`/the `ev.target !== item` guard/`:focus-visible`/`:focus-within`.
- *the collapsed rail keeps a restore affordance* — updated `44px` → `64px`.
- new describe **status bar — the Environment cell tells the truth**: the route
  reports `env`+`mode`; `app.js` keeps and clears the payload and announces it;
  `views.js` renders `—`+neutral when unknown, green only for `production`,
  verbatim for an unmapped name, and subscribes via `onDoc`; the old hardcode is
  banned; `1.3.7` may appear only in comments; every `sb.*` key is in both dicts.

`tests/unit/canvas-chrome.test.ts`
- *frames the union of nodes AND viewport, with a capped scale*.
- *centres the empty-state card in the FREE canvas, clear of the OUTLINE rail*.
- *reserves the collapsed drawer head so the shell cannot hide behind it*.

---

## 5. TODO — what is actually left

### F6 / `04-HANDOFF` § 9 — the remaining feature work (in priority order)

| id | item | notes |
| --- | --- | --- |
| **H** | floating **Add Node** palette | spec: `docs/uiux/shell-add-node-palette.md` + `.webp`. The `+ Add First Node` CTA and the canvas `+` should open it. Reuse `ACTIONS` / `categoryOf()` / `paletteItem()` — do **not** fork a second catalog. |
| **J** | full **9-item node context menu** | i18n keys already exist: `fe.nodeMenu`, `fe.cloneNode`, `fe.pinNode`, `fe.unpinNode`. Anything without a backend must render **disabled with a tooltip**. |
| **I** | group-selection toolbar | appears when >1 node is selected (align / distribute / group-delete). Box-select already exists (`Shift`+drag). |
| **N** | per-node **Run** | needs a real backend endpoint **first** (`API.runNode()` does not exist). `.ndv-run-btn` CSS is already at `styles.css` ~1740. Without the endpoint this is a fake-successful button — do not ship the button alone. |

### F4 — still deferred
`shell-editor-launcher-menu.md` § 4 shows brand-tinted `Online Services`
children (Google Sheets, Slack, Notion…). The real `integration` category has
five actions and none of those brands. **Do not invent them.**

### Smaller, honest leftovers seen in the screenshots
- The editor is **not full-bleed**: the app sidebar and the "Visual Editor" page
  header are still visible, whereas the design replaces them with the shell's own
  top bar. Making it full-bleed means touching `.fe-layout`
  (`grid-template-columns: 240px 1fr`, `height: calc(100vh - 250px)`), `.fe-shell`,
  the `@media (max-width: 980px)` block, and `.fe-focus` — see `04-HANDOFF` § 12
  before starting. It is a layout-wide change, not a tweak.
- At 1280×700 the editor exceeds the viewport and `main.content` scrolls. That is
  survivable (and now safe, per F7), but the `calc(100vh - 250px)` height is the
  thing to revisit when the full-bleed change happens.

---

## 6. Verification command block (copy-paste)

```bash
cd /home/user/webapp

# syntax of every shipped front-end file + the 18-file rule
for f in public/js/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
ls public/js/*.js | wc -l          # must print 18

# types + tests
npx tsc --noEmit                   # must be silent
npx vitest run                     # must be 35 files / 657 tests

# line endings must NOT flip
for f in public/js/*.js public/css/styles.css; do
  [ "$(grep -c $'\r' "$f")" = "0" ] || echo "CR leaked into $f";
done
grep -c $'\r' src/Routes/user.routes.ts   # 1190
grep -c $'\r' src/pipeline.ts             # 2927

# look at it (see § 2)
node tools/ui-preview-server.js 8788 &    # prefer run_in_background: true
node tools/ui-shot.js '#/editor' /tmp/ui.png 1672x941   # expect "errors : none"
```

---

## 7. Anchors touched this session

| file | anchor |
| --- | --- |
| `public/js/flow-editor.js` | `MM_MAX_SCALE` + `renderMinimap()` ~547 · `paletteItem()` ~1869 · `paletteRail()` ~2195 · `applyPaletteCollapsed()` ~2236 |
| `public/js/views.js` | `statusCell()` ~1031 · `ENV_LABEL` / `environmentCell()` ~1041 · `refreshStatusBar()` ~1072 · `onDoc('health:change', …)` ~1292 |
| `public/js/app.js` | `lastHealth` / `setHealth()` / `fetchHealth()` ~165 · `AppUtil.health()` ~575 |
| `public/js/i18n.js` | `sb.*` fa block (after `fe.unsaved`) · `sb.env*` en block |
| `public/css/styles.css` | `.fe-empty-card` ~681 · `.palette-item:focus-visible` ~650 · `.fe-shell` padding ~1795 · `:root{--rp-head-h}` + `.run-panel` ~1486 · `.pi-star` focus-within ~4075 · `.pl-rail*` / `.fe-pal-collapsed` ~4130 |
| `src/Routes/health.routes.ts` | `res.json({ … env, mode … })` (**CRLF file**) |
| `tools/ui-shot.js`, `tools/ui-preview-server.js` | new, dev-only |
