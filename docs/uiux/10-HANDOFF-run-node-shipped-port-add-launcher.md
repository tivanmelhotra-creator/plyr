# 10 — HANDOFF: item N shipped · circled `+` · minimap · launcher/brand parity

**Status doc. Start here.** Supersedes `09-HANDOFF-item-N-per-node-run.md`
(whose § 2 spec is now *implemented* — keep it only as the rationale record).

Branch `genspark_ai_developer`. Baseline at the start of this session:
`8e119b4` (origin/main), 36 test files / 711 tests. Now: **37 files / 760
tests**, `tsc --noEmit` clean, `public/js` still **18** files.

---

## 0. Standing rules (unchanged — they are instructions, not preferences)

1. Keep developing. **Never ask questions** — search, decide, document.
2. **Image beats prose.** `docs/uiux/*.webp` outranks every `.md`, including
   this one. When a region is questioned, *re-crop the image at 3x and measure*
   (`magick <png> -crop WxH+X+Y +repage -resize 300% out.png`); reading the
   prose spec is how three launcher glyphs ended up wrong — see § 3.1.
3. **Never ship fake-successful UI.** No mock rows, no invented counts. If the
   backend cannot do it, the control renders visibly **disabled with a tooltip**
   saying why.
4. **Real counts only.**
5. **Do not add a new front-end JS file** — `tests/unit/icons.test.ts` pins
   **18** files in `public/js/`. Dev-only tooling goes in `tools/`.
6. Every i18n key must exist in **both** the `fa` and `en` dictionaries of
   `public/js/i18n.js`.
7. Line endings: `public/**` = LF (0 CR). `src/Routes/user.routes.ts` = **CRLF**
   (patch byte-exactly, e.g. Python `io.open(..., newline='')`); it is at
   **1317** CR now (was 1190 before item N). `src/schemas.ts` is CR=0 — do not
   "fix" it.
8. Git: commit after every change → `git fetch origin main` → rebase → **squash
   to one commit** (`git reset --soft HEAD~N && git commit -F file`) →
   `git push -f origin genspark_ai_developer` → create/update the PR → **hand
   the user the PR link**. Never put backticks in a `-m` message; always use
   `-F /tmp/commitmsg.txt`.

---

## 1. What shipped

### 1.1 Item N — per-node Run (the last item of the A–N list)

Semantics are n8n's *Execute step*: running node *X* enqueues the **chain
prefix** — every enabled node from the trigger up to and including *X* — so the
node's INPUT column shows data that was really produced, never synthesised.
The prefix is a literal `toSteps().slice(0, idx + 1)`.

- `src/schemas.ts` — `runNodeBodySchema` / `RunNodeBody`.
- `src/Routes/user.routes.ts` — `POST /run-node` (line ~242). Copies the quota +
  queue-limit checks from `POST /run`; adds the job with
  `{ __runNode: true, __nodeIndex }`, and deliberately **no `__workflowId`**
  (a partial run must never be attributed to a saved workflow, or it pollutes
  the Executions tab and `GET /workspace/:userId/stats`) and **no `webhookUrl`**
  (a node test must not fire the user's webhook). Supports `?wait=true`
  (200 inline / 202 + `pollUrl`). 400s when `nodeIndex !== steps.length - 1`.
- `GET /jobs/:userId` — every row now reports `partial`, `nodeIndex` and a
  widened `trigger` (`node` | `schedule` | `workflow` | `manual`).
- `public/js/api.js` — `API.runNode(userId, body)`.
- `public/js/flow-editor.js` — `runNode(nodeId)` (2079), `runUserId()` (2063),
  `runNodeBlockedReason(nodeId)` (2054). The context-menu row is no longer
  hard-disabled: it is enabled when the node is on the enabled main chain and
  otherwise disabled **with the reason** (`fe.runNodeDisabled` /
  `fe.runNodeBranch`). Both entry points read the *same* reason function, so
  the menu and the NDV header can never disagree.
- The NDV header `Run node` button used to do
  `closeNdv(); document.getElementById('fe-run').click()` — it said "Run node"
  and ran the **whole flow**. That fake success is gone; a blocked button is
  styled dead (`.ndv-run-btn:disabled`, styles.css 1911) rather than merely
  dimmed.
- Docs: `POST /run-node` in `docs/openapi.yaml` and `docs/API.md`.
- Tests: `tests/integration/run-node.test.ts` (10), `schemas.test.ts` (+7),
  `node-toolbox.test.ts` item-N + step-index describes (+14).

### 1.2 Bug fix — chain index vs step index (was `09` § 3.1)

`chainNodeIds()` **includes** disabled nodes but `graphToSteps()` **skips**
them, so once any node was disabled every status halo, NDV result and pin after
it was painted on the **wrong card**. Fixed with `stepChainIds()` (2030,
enabled-only) plus its exact inverse `chainStepIndex()` (2045); all five
index→id resolvers (`setNodeStatus`, `setNodeResultsByIndex`,
`selectByChainIndex`, `pinByIndex`, `isPinnedByIndex`) go through it.
`copySelectionJson`'s `chainNodeIds()` is left alone on purpose — that is
display ordering, not step addressing.

### 1.3 Circled `+` on free output ports — the FIFTH Add Node entry point

Visible in six of the eight locked images, right of a node on a short connector
stub. It is the only entry point that pre-wires **one specific branch port**, so
`else` / `catch` / `case:N` can be extended by a click instead of a drag.

- `flow-editor.js` 894-925 inside `ports.forEach`, `PORT_ADD_R = 9` at 397.
- Rendered **only on a port with no edge yet** (offering "add" on a taken port
  would silently replace that connection — same rule as
  `openAddPaletteForSelection`).
- Reuses `openAddPalette({ world: slotAfter(node.id), from: { nodeId, port } })`
  — still one palette, one insert path.
- Real `<button>`, `title` + `aria-label` from `fe.addFromPort`, registry `plus`
  glyph, `mousedown`/`click` `stopPropagation` so it neither drags the node nor
  opens the NDV.
- CSS `.flow-port-add` (styles.css 917): logical `inset-inline-end` (RTL-safe),
  `::before` connector stub, per-port colours **matched to the port dot**
  (`then`/`body`/`try` success, `else`/`catch` danger, `done`/`finally`
  `#f5a623`, `case-*` `#06b6d4`), hidden by `.fe-canvas.fe-locked`.

### 1.4 Minimap viewport indicator (was `09` § 5.1)

The frame is `union(nodes, viewport)`, so on a small graph the filled
`--primary-soft` rect covered the node dots and read as one orange smear. It is
now an outline with a transparent interior plus
`box-shadow: 0 0 0 9999px rgba(0,0,0,0.42)` dimming the **outside**, clipped by
`.fe-minimap { overflow: hidden }` (styles.css 1409).

### 1.5 App launcher parity + one product name (reviewer-flagged region)

Re-measured against `shell-editor-launcher-menu.webp` at 3x. Four deltas, all
fixed (see § 3.1 for why they existed):

| Was | Now |
|---|---|
| Workspace `layout`, Jobs `layers`, Admin `shield` | `grid`, `briefcase`, **`shield-check`** (new registry icon) — in the launcher **and** the sidebar |
| 16px glyphs, 36px rows, 13px labels | `data-icon-size="20"`, 40px rows, 14px labels, 12px gap, 6px panel padding, width 196 → 184px |
| open button = solid orange fill, near-black glyph | dark interior + **1.5px orange ring** (`box-shadow`, so the button cannot resize) + light glyph |
| `app.title` = "Automation Backend" while `fe.brand` = "Aria Automate" | one product name everywhere (`<title>`, login title, sidebar, editor) |

Guards: `tests/unit/workspace-ui.test.ts` — locked glyph + 20px size per route,
**sidebar/launcher glyph parity** (they can never drift again), ring-not-fill
(asserts the *absence* of `background: var(--primary)`), row geometry, and a
`brand` describe pinning one name across `index.html` and both dictionaries.

---

## 2. Contracts that must not be broken

1. **A partial run is not a run.** `__runNode` jobs carry no `__workflowId`;
   Executions and workspace stats must keep ignoring them.
2. **`validateSteps` whitelists `AutomationStep` fields**, so the item-J
   annotations (`label` / `note` / `color`) do **not** survive a server round
   trip. The NDV OUTPUT column must therefore be keyed by `nodeIndex`, never by
   a label.
3. **Step index ≠ chain index.** Anything that maps a number from the server
   back onto a card goes through `stepChainIds()` / `chainStepIndex()`.
4. **One palette, one insert path.** New entry points call `openAddPalette`.
5. **Same route ⇒ same glyph** in the sidebar and the launcher.
6. CSS tokens that do **not** exist: `--text-mute`, `--accent`, `--surface-2`,
   `--text-disabled`. Valid: `--bg-elev-2` `#151C25`, `--text-faint` `#5E6876`,
   `--primary`, `--primary-soft` `rgba(255,138,31,.12)`, `--success`,
   `--danger`, `--border`, `--info`.

---

## 3. Findings about the image inventory itself

### 3.1 Why three launcher glyphs were wrong

They were taken from the prose spec's names, not from the image. The lesson is
mechanical: **for any icon or geometry question, crop and zoom the WebP**. The
harness is two commands (`magick … -crop … -resize 300%`, then read the PNG).

### 3.2 Two image stems are mis-described in `README.md`

- `shell-add-node-palette.webp` is **not** an add-node palette screen — it is an
  **HTTP Request NDV**.
- `shell-editor-condition-ndv.webp` is the **annotated context-menu /
  group-toolbar / Add-Node** screen.

The README table was corrected in this session; the *file names* were kept
(renaming them would break every `.md` cross-reference).

### 3.3 The brand logo MARK is still not the locked one

`workspace-overview.webp` draws an orange loop/infinity mark; the shell renders
`zap`. The editor header in `shell-editor-launcher-menu.webp` draws a
circle-with-dot. Deliberately **not** guessed — inventing vector art from a
blurry mock is worse than a consistent placeholder. Open item.

### 3.4 The ACTIVITY LOG tab set differs between two locked images

`shell-editor-launcher-menu.webp` shows **three** tabs (`Runs · Variables ·
Logs`) opening on `Runs`; `state-empty-canvas.webp` (the newest capture) shows
**four** (`Runs · Execution · Variables · Logs`) opening on `Execution`. The
newest image wins, which is what ships. Do not "fix" it back.

---

## 4. Verification recipe (run all of it before committing)

```bash
cd /home/user/webapp
npx tsc --noEmit                          # must print nothing
npx vitest run                            # 37 files / 760 tests
for f in public/js/*.js; do node --check "$f" || echo "FAIL $f"; done
ls public/js/*.js | wc -l                 # must stay 18
grep -c $'\r' src/Routes/user.routes.ts   # must stay 1317
for f in public/index.html public/css/styles.css public/js/*.js; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" = 0 ] || echo "CR in $f: $n"; done
```

Visual check (Playwright; the system libs are installed with
`sudo apt-get install -y libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 libxdamage1`):

```bash
node tools/ui-preview-server.js 8788 &
node tools/ui-shot.js '#/editor'    /tmp/a.png 1672x941
node tools/ui-shot.js '#/workspace' /tmp/b.png 1400x800 '#launcher-btn'
magick /tmp/b.png -crop 420x330+0+0 +repage -resize 300% /tmp/b-zoom.png
```

**RTL trap:** the default language is `fa`, so "top-end" is top-**left**.

---

## 5. Still open (priority order)

1. **NDV `Run 2 of 2` per-run selector** — in all three NDV images, on the
   INPUT *and* OUTPUT columns. Needs a per-node run history (the data exists:
   `partial` + `nodeIndex` on `GET /jobs`). Highest-value remaining NDV gap.
2. **NDV OUTPUT empty-state copy** + the footer `Status / Time / Size` strip.
3. **Palette / OUTLINE collapse defaults with persistence.** Both are
   session-only today (`paletteCollapsed` at flow-editor.js 95, `olOpen` at
   views.js 1540), so a reload throws the choice away. The locked images show
   palette **expanded**, OUTLINE **open**, minimap **open**, ACTIVITY LOG
   **open**. Suggested shape: one `AppUtil.pref(key, fallback)` /
   `AppUtil.setPref(key, value)` pair in `app.js` over a single
   `ab_ui_prefs` JSON blob — do **not** add a JS file (rule 5), and do not
   scatter more `localStorage` keys.
4. **The 13-glyph icon rail** and the **980 px** + **RTL dock** render passes.
5. `#fe-result` inside the full-bleed shell; ACTIVITY LOG default open state.
6. **Group** / **Convert Subflow** — honestly disabled; they need a real
   container concept in the graph model first.
7. Branch-node per-node run — lift the main-chain-only restriction in
   `runNodeBlockedReason` once `graphToSteps` can serialise a branch prefix.
8. The brand logo mark (§ 3.3).

---

## 6. Anchor table (as of commit `a26b749`)

| What | Where |
|---|---|
| `POST /run-node` | `src/Routes/user.routes.ts` 242-… |
| `runNodeBodySchema` | `src/schemas.ts` (after `runBodySchema`) |
| `PORT_ADD_R` / circled `+` chip | `public/js/flow-editor.js` 397 / 894-925 |
| `stepChainIds` / `chainStepIndex` | `public/js/flow-editor.js` 2030 / 2045 |
| `runNodeBlockedReason` / `runUserId` / `runNode` | 2054 / 2063 / 2079 |
| `.flow-port-add` | `public/css/styles.css` 917 |
| `.mm-viewport` | `public/css/styles.css` 1409 |
| `.ndv-run-btn:disabled` | `public/css/styles.css` 1911 |
| `.launcher-btn.open` / `.launcher-menu` / `.launcher-item` | 2889 / 2899 / 2915 |
| `shield-check` icon | `public/js/icons.js` (after `shield`) |
| `fe.addFromPort`, `fe.runNode*` | `public/js/i18n.js` 430 / 432 (fa), 1259 / 1261 (en) |
| Guards | `tests/unit/node-toolbox.test.ts` (68), `tests/unit/workspace-ui.test.ts` (81), `tests/integration/run-node.test.ts` (10) |
