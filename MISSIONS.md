# Aria Automate — Mission Ledger / فهرست ماموریت‌ها

> **What this file is / این فایل چیست**
> The single, authoritative checklist of everything the project owner asked for,
> in the order it was asked, with the exact status of each item. Items that are
> **done** are ticked; items that are **still open** are unticked and carry a
> concrete implementation plan (files + line anchors) so the next session can
> continue without re-discovering anything.
>
> این فایل تنها مرجع «چه چیزهایی خواسته شده و کدام‌ها انجام شده» است. آیتم‌های
> تیک‌خورده تمام شده‌اند، آیتم‌های بدون تیک برای جلسات بعدی مانده‌اند و برای هر
> کدام نقشه‌ی دقیق پیاده‌سازی (فایل + شماره خط) نوشته شده است.

**Repo:** `jalil-ahmadi2/plyr` · **Branch:** `genspark_ai_developer` · **PR:** #20
**Last updated:** 2026-08-02

> 🚩 **جلسه‌ی جدید بدون سابقه‌ی چت؟ اول [`NEXT-SESSION.md`](./NEXT-SESSION.md) را بخوان.**
> آنجا وضعیت دقیق فعلی، تنها ماموریت باز، تله‌های محیطی (core dump، RAM، CRLF در
> `.env`)، و دستور بالا آوردن پروژه در یک جا جمع شده است.

---

## 0. Standing project rules / قواعد ثابت پروژه

These apply to **every** future change, not just the items below.

| # | Rule | Why |
|---|------|-----|
| R1 | **Cross-check every node's options against [AutomaApp/automa](https://github.com/automaapp/automa)** before designing or "finishing" them. Its node logic is the accepted reference. | Owner's explicit instruction (mission 8). Automa's `conditionBuilder` (`valueTypes` / `compareTypes` / `inputTypes`) and its Conditions block are the parity target. |
| R2 | Nodes are the essence of the tool — a node is not "done" until it exposes the **complete** set of options its runtime can honour. | Owner's instruction (mission 5). |
| R3 | Never ship a control that changes nothing. If a knob has no backend reference, either implement the backend or delete the knob. | Precedent: `EVALUATE_MODES` / `maxDepth` were deleted rather than faked (see `public/js/ndv-model.js` ~line 347). |
| R4 | Work happens on `genspark_ai_developer`; commit after every change, rebase on `origin/main`, squash to one commit, force-push, then open/update the PR and hand the owner the PR link. | Project workflow. |
| R5 | CSP-safe vanilla JS on the client, fa/en i18n key parity, `npx tsc --noEmit` + `node --check` + `npx vitest run` green before delivery. LF line endings under `public/**` (and `src/core/LiveBrowser.ts` is LF too). | Repo conventions. |

---

## 1. Mission board / تخته‌ی ماموریت‌ها

| # | Mission (short) | Status |
|---|-----------------|--------|
| 1 | RTL/Persian graph direction reversed | ✅ Done |
| 2 | Opened node (NDV) must cover 80% of the screen — for every node | ✅ Done |
| 3 | Outline panel closed by default | ✅ Done |
| 4 | Menu collapse control at the top + slimmer collapsed rail | ✅ Done |
| 5 | Condition node option parity with Automa (grouped value types + operators) | ✅ Done (part 1 operators · part 2 value types) |
| 6 | Simulated browser must browse for real; eye = element-select mode | ✅ Done |
| 7 | Condition node with multiple prioritised paths + neutral `next` | ✅ Done |
| 8 | Standing rule: always cross-check Automa when settling node options | ✅ Done (documented as **R1** above) |
| 9 | Install a Chrome extension by pasting its Web Store link (no remote desktop) | ✅ Done |
| 10 | Dual Browser Mode (Remote **+** Local) + Element Inspector as a Chrome/Chromium extension | ✅ Done |

---

## 2. Completed missions / ماموریت‌های انجام‌شده

### ✅ 1. RTL graph direction was mirrored

**Asked:** in Persian (RTL) mode the graph is reversed — a node's *output* appears to
feed the next node's *output* section, i.e. wires enter from the wrong side.

**Root cause:** the node cards and the SVG edge layer are positioned with
**physical** coordinates (`left`/`top`, SVG `x`/`y`), but the port chips were
placed with **logical** CSS properties (`inset-inline-start` / `inset-inline-end`),
which flip under `dir="rtl"`. So the ports moved and the wires did not.

**Fix** — `public/css/styles.css`, right after the `.fe-world` rule:

```css
.fe-svg,
.fe-world { direction: ltr; }          /* graph geometry is physical, lock it */
.fn-title, .flow-node-sub,
.fe-edge-pill, .flow-port-label { unicode-bidi: plaintext; }
.fn-title, .flow-node-sub { text-align: left; }
```

`unicode-bidi: plaintext` keeps mixed Persian/Latin labels (selectors, URLs)
readable inside the direction-locked layer.

**Verified:** fa + en screenshots via `tools/ui-shot.js`; the owner's own
screenshot in message 3 confirms ports now read `اگر درست` / `اگر نادرست` / `بعدی`
on the correct sides.

---

### ✅ 2. NDV must be 80% of the screen for every node

**Asked:** when a node opens with its three columns (INPUT | parameters | OUTPUT)
it must cover **80% of the whole screen for every node**, no matter how many
fields it has.

**Root cause:** three competing size rules — the generic NDV was
content-sized under a `min(1080px, …)` / `min(760px, …)` ceiling, while the
"designed" NDV declared `width: min(1180px,94vw); height: min(820px,94vh)`. So
the modal resized per node.

**Fix** — `public/css/styles.css`:

* `.ndv-modal { width: 80vw; height: 80vh; max-width: 80vw; max-height: 80vh; display:flex; flex-direction:column; }`
* the designed variant's own `width`/`height`/`max-height` block was **removed**
  (replaced by an explanatory comment) so there is exactly one size rule.
* the fixed-height contract was extended to undesigned nodes:
  `.ndv-modal:not(.is-designed)` gets `overflow:hidden` on `.ndv-body`,
  `min-height:0` on **every** flex/grid ancestor, `grid-template-rows: minmax(0,1fr)`
  on `.ndv-cols`, `overflow:auto` per `.ndv-col`, and **sticky column heads**.
* `@media (max-width: 860px)`: `94vw × 92vh`, single column, outer scroll.

**Gotcha for future edits:** `.ndv-body` must **never** get `overflow` back, or
the modal collapses into one outer scroller again.

**Verified:** designed (`if`) and undesigned (`http-request`) NDVs both render at
exactly `1152 × 720` in a `1440 × 900` viewport.

---

### ✅ 3. Outline panel closed by default

**Fix** — `public/js/views.js` ~line 1562:

```js
var olOpen = AppUtil.pref ? !!AppUtil.pref('feOutlineOpen', false) : false;
```

The preference still persists the user's choice; only the **default** flipped to
closed. Applied on first render through `setOutlineOpen(olOpen, false)`.

---

### ✅ 4. Collapse control at the top of the menu + slimmer collapsed rail

**Asked:** the collapse control sits at the **end** of the menu; it must be at
the **top**. Also, when collapsed the rail still eats too much width.

**Fix:**

* `public/js/flow-editor.js` → `renderPalette()`: new `.palette-head` row that
  holds the search row **plus** a `.pl-collapse` icon button (chevron, RTL-flipped),
  so the control costs **zero extra vertical space**. The old
  "Collapse" link was removed from `.palette-foot`.
* `paletteRail()`: the `.pl-restore` expander chip is now appended **first**
  (before Favorites and the six groups) with a hairline `::after` separator.
* `public/css/styles.css`: collapsed column `64px → 44px`, rail buttons
  `40px → 32px`, `.pl-rail` gap `6px → 4px`, and the `980px` media override
  updated to match.

**Verified:** `tests/unit/editor-shell.test.ts` (new `ruleFor()` helper +
"the collapse control sits at the top of the palette, not in the footer" test,
and G8 now asserts the expander is first and the column is `44px`), plus fa/en
screenshots.

---

### ✅ 6. Real browsing in the simulated browser; the eye = element-select mode

**Asked:** clicking and browsing don't work — you can only hover and pick. The
eye icon does **not** mean "hide"; it means **toggling element-selection mode**.
Desired: browse normally; **eye ON** → selection mode (clicks disabled, hover
outlines the element); **eye OFF** → no outline, no selection, and the tool panel
becomes slightly transparent.

**Root cause:** `browser-view.js`'s `onMessage` handler for `'ready'` sent
`{ t:'picker', on:true }` unconditionally, so the injected `PICKER_SCRIPT`'s
capture-phase `onClick` (which calls `e.preventDefault()` on every trusted click)
stayed installed for the whole session. Real browsing only works when the picker
is **not** injected — the client simply never turned it off.

**Fix:**

* `public/js/browser-view.js`: `pickState.selectMode` (default **false**) and a
  single `applySelectMode(on, quiet)` function that is the only place deciding
  what a click means — it sends `{t:'picker', on}`, clears the lock, toggles
  `is-on`/`aria-pressed` on `#bvp-eye`, `is-browse` on the panel, `is-picking`
  on the canvas, and rewrites `#bvp-modeline` + `#bvp-kbd`.
* `#bvp-ghost` (see-through) → `#bvp-eye` (select-mode toggle).
* Keyboard passthrough in browse mode: a `NAMED_KEYS` table → `{t:'key'}` and
  single characters → `{t:'type', text}`, with ctrl/meta/alt left to the OS.
* **Back / Forward / Reload** wired end-to-end: `#bvp-back` / `#bvp-fwd` /
  `#bvp-reload` → `BrowserStreamServer.handleCommand()` new
  `back`/`forward`/`reload` cases → new `LiveBrowser.back()/forward()/reload()`
  (`page.goBack/goForward/reload`, emit `navigated`).
* `public/css/styles.css`: `.bvp-canvas` default cursor with `.is-picking`
  crosshair, `.bvp-panel.is-browse { opacity:.55 }` (full opacity on
  hover/focus) replacing `.is-ghost`, `.bvp-eye.is-on`, `.bvp-modeline`.
* `public/js/i18n.js`: 10 new `bvp.*` keys in **both** fa and en
  (`selectOn/selectOff/selectedOn/selectedOff/inSelect/inBrowse/kbdBrowse/back/forward/reload`),
  `bvp.seeThrough` removed, `bvp.hint` rewritten around the browse-first flow.

**Verified:** 7 new tests in `tests/unit/element-picker.test.ts` (38/38 green) +
`tools/picker-panel-shot.js` renders with `errors: []`.

---

### ✅ 7. Condition node with multiple prioritised paths

**Asked (verbatim):** *«نود شرطی یه بخش path داره که نمیشه جدید اضافه کرد … هر
کدوم از path ها با اولویت بالا از بالا به پایین به ترتیب چک میشه، درست باشه اون
مسیر رو میره وگرنه بعدی چک میشه. اگر هیچ کدوم کار نکرد و مسیری فعال نشه، از مسیر
خنثا یعنی next میره.»*

**Delivered:** N ordered paths (cap 20, Automa's own cap), evaluated top → bottom,
**first true path wins and routes exclusively**; when nothing matches, execution
leaves through the neutral `next` port. The two hard-disabled `+ Add path`
controls are gone — the NDV now shows a real list with add / rename / reorder
(↑ ↓) / delete, visible priority numbers and a non-deletable neutral trailing row.

| Layer | File | Change |
|-------|------|--------|
| Model | `public/js/ndv-model.js` | `CONDITION_MAX_PATHS`, `normalizePath`, `readPaths`, `writePaths`, `isMultiPath`, `pathLabel`, `pathsSummary`; `groupsSummary` split out of `conditionSummary`. |
| Catalog | `public/js/actions.js` | `if` declares `{ k:'paths', internal:true }` — undeclared params are dropped by `coerceParams`. |
| Serializer | `public/js/graph-serialize.js` | `parsePaths` / `pathPortId`, multi-path `buildNode`, import in `stepsToGraph`, path rows in `outlineTree`, path-aware `empty-if`, `'paths'` in `CONDITION_ONLY_PARAMS`. |
| Canvas | `public/js/flow-editor.js` | `path:<id>` ports + neutral `next`, priority labels, `clipPortLabel`, `tone-path` edge pills, card summary. |
| NDV | `public/js/ndv-nodes.js` | Real path list, `pathResultCard`, `neutralResultCard`; active index kept in a module-level `ACTIVE_PATH` map, never on the serialised node. |
| i18n / CSS | `public/js/i18n.js`, `public/css/styles.css` | 14 new `cb.*` keys + `port.path` (fa+en), `cb.addPathV2` retired, `val.emptyIf` reworded; path-list + result-card + pill styles. |
| Backend | `src/types.ts`, `src/validation.ts`, `src/pipeline.ts` | `ConditionPath` type, `mapStep` recursion into `paths[].steps`, exported `pickConditionPath()` and the exclusive routing branch (`break stepLoop`) in `executeStepGroup`. |
| Tests | `tests/unit/condition-paths.test.ts` | 29 tests: model, serializer, validation, runtime. |

**Backwards compatible:** a single-path node writes **no** `paths` key and still
serialises to the classic `{ condition, then, else }`, so every saved workflow is
byte-identical.

**Full write-up:** [`docs/uiux/17-HANDOFF-condition-paths.md`](docs/uiux/17-HANDOFF-condition-paths.md).

---

### ✅ 8. Standing rule — always cross-check Automa

**Asked:** *«حتما موقع تنظیم اپشن های هر نود به پروژه automa … مراجعه کن، چون منطق
نودهاشو قبول دارم»* — whenever the options of a node are being settled, consult
Automa, because its node logic is endorsed.

**Recorded as rule R1** in section 0 of this file (the authoritative project-rules
table). Concretely, the reference surfaces are:

* `src/components/block/BlockConditions.vue` + `blocks/handlers/handlerConditions.js`
  → the Conditions block: an **ordered** `data.conditions[]`, each entry with its
  own `id` / `name` / condition tree; **first match wins** and its output id is
  taken; if nothing matches, the `'fallback'` output is used. Optional
  `retryConditions` / `retryCount` / `retryTimeout`. UI is a draggable list
  (max 20) with add / edit / delete.
* `utils/shared.js → conditionBuilder`:
  * **`valueTypes`** grouped as *value* (Value, Code, Data exists) and *element*
    (Element text, Element exists, Element not exists, Element visible,
    Element visible in screen, Element hidden in screen, Element attribute value).
  * **`compareTypes`** grouped as *basic* (`eq`, `eqi`, `nq`), *number*
    (`gt`, `gte`, `lt`, `lte`), *text* (`cnt`, `cni`, `nct`, `nci`, `stw`, `enw`,
    `rgx`) and *boolean* (`itr`, `ifl`).
  * `inputTypes` decides whether the right-hand side is a text box, a number box,
    a code editor or nothing at all.

---

### ✅ 9. Install an extension from a Chrome Web Store link

**Asked (verbatim):** *«این مشکل رو داشتم و ظاهرا دردسرش زیاده — من فقط نیازه که
براش آدرس پلاگین رو بدم نصبش کنه خودش … و بتونه پلای‌رایت ازش استفاده کنه»*, with
the J2TEAM Cookies store links.

**Problem:** getting an extension in required either a `.crx` file the Web Store
never offers you, or the whole noVNC remote-desktop stack
(`xvfb x11vnc novnc websockify`), which was reported as *stopped* behind a red
"install the virtual display stack" hint.

**Delivered:** a URL field in `Real Chrome ▸ Extensions`. The server downloads
the signed `.crx` from Google's own update endpoint, unpacks it, pins its
identity and hands it to Playwright via `--load-extension`. Only `xvfb` (or
`REAL_CHROME_HEADLESS=true`) is needed — **no VNC stack at all**.

Four traps handled, each covered by tests:

1. **The wrong signing key.** A store `.crx` carries several proofs (developer +
   Google publisher). Taking the first yields a well-formed but WRONG id — on
   the owner's extension, `lfoeajg…` instead of `okpidco…`. `crxPublicKey()`
   reads `signed_header_data` for the authoritative `crx_id` and returns the key
   that hashes to it, or `null` rather than guessing.
2. **Path-derived ids.** Chrome ids an unpacked extension by its absolute path,
   so `chrome-extension://<id>/…` URLs in saved workflows would die on redeploy.
   The signing key is written into the manifest as `key`, pinning the official
   Web Store id permanently.
3. **`__MSG_appName__`.** Most store manifests localise their name; `describe()`
   resolves placeholders from `_locales/`, so the panel shows "J2TEAM Cookies".
4. **Id disagreement.** `RealChrome.loadedExtensions()` used the path id, which
   would have made "Open here" navigate nowhere for a pinned extension. It now
   prefers the manifest-key id and exposes it as `runtimeId`.

| Layer | File |
|-------|------|
| Core | `src/core/ChromeExtensions.ts` — store URL parsing, CRX3 protobuf reader, key pinning, `_locales` name resolution, download + install |
| Browser | `src/core/RealChrome.ts` — key-aware runtime id |
| API | `src/Routes/browser.routes.ts` — `POST /browser/extensions/store` |
| UI | `public/js/real-chrome.js`, `public/js/i18n.js` (fa+en), `public/css/styles.css` |
| Tests | `tests/unit/webstore-install.test.ts` — 28 offline tests |

**Verified live:** both of the owner's URL forms install; the browser starts with
`runtimeId = okpidcojinmlaakglciglbpcpajaibco`; the popup renders in a page with
`chrome.cookies` available — which is why the canvas "Open here" button is enough
and the desktop is now marked optional.

**Full write-up:** [`docs/uiux/18-HANDOFF-webstore-extension-install.md`](docs/uiux/18-HANDOFF-webstore-extension-install.md).

---

### ✅ 10. Dual Browser Mode + Element Inspector extension

**Asked** (20-section Persian spec, `Dual Browser Mode + Chrome-Chromium Element
Inspector Extension.md`), with two demands stated emphatically:

> «Remote Browser حذف نمی‌شود و Local Browser نیز جایگزین آن نیست»
> «نباید دو Inspector جداگانه ساخته شود»

So: add a **Local Browser Mode** beside Remote (not replacing it), and build the
Element Inspector as a **real Chrome/Chromium extension** — exactly one of them,
working in both modes.

**How Local mode works.** The user's machine dials **out** to the server over
WSS/443, and the server runs CDP *backwards* through that tunnel:

| Decision | Why not the obvious alternative |
|---|---|
| Reverse tunnel, agent dials out | Exposing port 9222 hands a logged-in browser to anyone who scans it — **CDP has no authentication at all**. And NAT/CGNAT makes inbound impossible for most users regardless. |
| Multiplexed streams, `[op][streamId][payload]` | `connectOverCDP()` opens **several** connections (version probe, browser socket, one per target), so a single socket cannot serve it. |
| Bytes copied, never parsed | A CDP-aware proxy would break on every Chrome/Playwright release. |
| **No second automation engine** | Playwright stays server-side and reaches *through* the tunnel, so all ~40 node actions work in both modes unchanged. Re-implementing them would also lose auto-waiting and locators. |
| Local adopts `contexts()[0]`, never `newContext()` | On an attached Chrome the latter is **incognito**, discarding the cookies and logins that are the entire point of using your own browser. |

**The regression that had to be stopped.** Cleanup paths closed
`context.browserContext` unconditionally — in local mode *that is the user's own
Chrome*. A finishing workflow would have closed their browser, with their tabs in
it. Fixed with `browserShared` + guards at **all three** close sites
(`grep -c browserShared src/pipeline.ts` = 6).

**Why the Inspector is an extension.** A `<canvas>` screencast can never show the
extension toolbar, `chrome://` pages, Chrome's settings or the native file dialog
— those are not drawn by the page compositor. An extension reads the **real DOM**,
so selectors are real rather than inferred from pixels.

**Why its panel is in the page, not the popup.** An extension popup **closes on
focus loss**, so the first hover would dismiss it. The panel is injected into a
**`closed` shadow root**: page CSS cannot restyle it, page scripts cannot read
the picks. Listeners run in the **capture phase**, because sites call
`stopPropagation()` on exactly the elements users most want to pick.

**Attributes are generic, never a whitelist** (§8 forbids hardcoding):
`extension/lib/ab-inspect.js` walks `el.attributes` and reports everything
present. `TAG_HINTS`/`GLOBAL_HINTS` only **order** the rows — an attribute nobody
anticipated is still extracted.

**Delivery refuses rather than guesses.** The dangerous failure is a pick landing
in the *wrong* node silently, so the server answers `409` with
`no_active_node` / `stale_session` / `empty_selection` / `invalid_element`. The
session id is per **tab** (`sessionStorage`), because `localStorage` is shared
between tabs and would make two editing sessions indistinguishable.

| Area | Files |
|---|---|
| Server | `src/core/BrowserMode.ts`, `LocalBridge.ts`, `BrowserAdapter.ts`, `InspectorHub.ts`, `InspectorSocket.ts`, `src/Routes/mode.routes.ts`, `src/pipeline.ts` |
| Extension | `extension/manifest.json`, `lib/ab-inspect.js`, `content/inspector.js`, `background.js`, `popup/*` |
| Dashboard | `public/js/inspector-client.js`, `flow-editor.js`, `app.js`, `browser-view.js`, `index.html` |
| Agent | `tools/local-browser-agent.js` — **zero dependencies**, so the user runs one file with no `npm install` |
| Tests | `extension-inspect` (20), `inspector-hub` (33), `local-bridge-tunnel` (20), `inspector-client` (19) = **92** |

**Two bugs only probing could find.** (1) The agent's hand-rolled RFC 6455 GUID
was mistyped `...95CA-5AB0DC85B11F` instead of `...95CA-C5AB0DC85B11` — that
agent **could never have connected to anything**, and re-reading it would never
have shown a wrong digest; interop-testing against the real `ws` server did, at
once. (2) `http.close(cb)` **never fires while an upgraded socket is open**, which
turned into 91s of timeouts that looked exactly like a broken tunnel (tracing
proved the bytes had already arrived). Fixing teardown: 91s → 222ms.

**Full write-up:** [`docs/uiux/20-HANDOFF-dual-browser-mode-inspector.md`](docs/uiux/20-HANDOFF-dual-browser-mode-inspector.md).

---

## 3. Open missions / ماموریت‌های باقی‌مانده

### 🟡 5. Condition node: full option parity with Automa

**Asked:** nodes are the essence of the tool and deserve top priority — every node
must expose complete options. Specifically the condition node must be able to
express "anything conditional", matching Automa's grouped dropdowns and row UI
(`element#text Equals Empty` header, "CSS selector or XPath" field with the
crosshair + verify icons, `+ AND` / `+ OR`).

#### ✅ Part 1 — grouped operator dropdown + the missing operators (shipped)

All 16 of Automa's `compareTypes` are now reachable, and the dropdown is bucketed
like Automa's:

| Automa | Aria operator | Status |
|--------|---------------|--------|
| `eq` / `nq` | `equals` / `not_equals` | already existed |
| **`eqi`** | **`equals_i`** | ✅ added (model + engine) |
| `gt` / `gte` / `lt` / `lte` | `greater_than` / `greater_equal` / `less_than` / `less_equal` | already existed |
| `cnt` / `nct` | `contains` / `not_contains` | already existed |
| **`cni`** / **`nci`** | **`contains_i`** / **`not_contains_i`** | ✅ added (model + engine) |
| `stw` / `enw` / `rgx` | `starts_with` / `ends_with` / `matches_regex` | already existed |
| **`itr`** / **`ifl`** | **`is_truthy`** / **`is_falsy`** | ✅ added — JS truthiness, deliberately *not* the same as the existing `is_true` / `is_false` (which only accept the boolean or the literal string `"true"`) |

* `public/js/ndv-model.js` — new `CONDITION_OPERATOR_GROUPS`
  (`dom` / `basic` / `number` / `text` / `state` / `boolean` / `list`), a `group`
  on every operator, and `groupedOperatorsForKind(kind)` which buckets the list,
  drops empty buckets and has an orphan safety net (`opg.other`) so an operator
  added without a group can never silently vanish from the dropdown. The group
  order mirrors the registry order, so the grouped and flat views cannot disagree.
* `public/js/ndv-ui.js` — `selectCell` now accepts
  `[{ group, options: [...] }]` and renders real `<optgroup>`s (native,
  screen-reader-announced, no custom popup). An empty bucket is skipped.
* `public/js/ndv-nodes.js` — the operator dropdown uses
  `m.groupedOperatorsForKind(kind)`. An `element` row still collapses to a single
  bucket rather than six empty headings.
* `src/core/ConditionEngine.ts` — `ConditionOperator` union + compare `switch`
  extended with the five new operators (rule R3: no UI-only knobs).
* `public/js/actions.js` — the `operator` enum of **both** `if` and `while`
  extended, otherwise `coerceParams` would drop the new values on save.
* `public/js/i18n.js` — fa + en for 5 operators + 8 group labels.
* Tests — `condition-engine.test.ts` (+4: case folding, truthiness vs is_true,
  variable resolution) and `ndv-designed-nodes.test.ts` (+6: an explicit
  Automa-`compareTypes`→Aria mapping table, every operator has a known group,
  bucketing loses/duplicates nothing and keeps registry order, fa+en label
  parity, real `<optgroup>` in the source, catalog declares every operator).

#### ✅ Part 2 — grouped **value types** (done)

Automa's `conditionBuilder.valueTypes` is the second dropdown, grouped *value* /
*element*. Where each entry landed:

| Automa value type | Result |
|-------------------|--------|
| Value | already covered by the `content` kind |
| Element text / attribute value | already covered by `source: 'text'` / `'attribute'` inside the `content` kind |
| Element exists / not exists / visible / hidden | kept in the `dom` **operator** bucket — see the decision below |
| **Code** | ✅ new `source: 'code'`, a JS snippet run in the page; its RETURN VALUE is the left-hand value |
| **Data exists** | ✅ covered, deliberately without a new control — see the decision below |
| **Element visible in screen** / **hidden in screen** | ✅ new `in_screen` / `not_in_screen` operators, via an in-page `IntersectionObserver` |

Full write-up: `docs/uiux/19-HANDOFF-condition-value-types.md`.

**Two decisions this mission was told to make, and the answers:**

*Do the DOM operators move into the value-type dropdown, as Automa does?* **No.**
Automa expresses "Element exists" as a *value type* and then has nothing to
compare, so its operator dropdown goes unused for those rows. Our split is
`checkKindOf` (which runtime path) × operator (how to compare), which is why an
`element` row shows two fields instead of five. Moving them would mean the same
choice appears in two dropdowns — the duplicate control problem rule R3 exists
to prevent. `in_screen`/`not_in_screen` therefore joined the `dom` **operator**
bucket, and an `element` row still collapses to a single `<optgroup>`.

*Does "Data exists" need its own value type?* **No — it already exists twice
over.** `is_truthy`/`is_falsy` (JS truthiness) and `is_empty`/`not_empty`
(trimmed emptiness) both answer it, and they compose with every kind including
the new `code` one: `code → is_truthy` IS Automa's "Data exists". A third
spelling of the same test would be a control the user has to distinguish from
two others that behave identically.

**Everything below was MEASURED before it was built** —
`tools/probe-condition-value-types.js`, 23 checks, run against a real Chromium.
Four of the seven findings fail *silently* (a wrong branch, not an error), which
is why the probe is committed rather than thrown away:

1. `page.evaluate('return true;')` **throws** *Illegal return statement* — and
   `return true;` is exactly Automa's editor seed. Every snippet must be wrapped.
2. No single wrapper works: a statement body yields `undefined` for an
   expression-only snippet, an expression body throws on a statement. Hence
   `looksLikeStatement()`.
3. A strict `script-src 'self'` CSP does **not** block `page.evaluate` —
   Playwright injects through the debugger, not a `<script>` tag.
4. `locator.evaluate('<function source>')` evaluates the string as an
   *expression*, so it yields the function object and returns `undefined`
   instead of calling it. The observer must be passed as a **real function**.
5. `in_screen` is **not** a synonym for `visible`: an element 4000px below the
   fold reports `isVisible() === true`.
6. The observer promise needs a timeout backstop — it never fires for a detached
   element (it settles in ~71 ms when it does fire).
7. A runaway snippet (`while (true) {}`) wedges the page **permanently**: a later
   `evaluate('1+1')` never returns either. So the call is raced, and a timeout
   must report an unmet condition rather than retry a page that is already lost.

Finding 5 also **overturned this document's own plan**: the suggested
`locator.boundingBox()` ∩ viewport test reports IN-VIEW for an element scrolled
out of sight inside an `overflow:hidden` container, because a single rect cannot
account for ancestor clipping. `IntersectionObserver` gets it right.

Shipped across: `src/core/ConditionEngine.ts`, `src/config.ts` + `.env.example`
(3 tunables), `public/js/ndv-model.js` (4th kind + `CONDITION_KIND_GROUPS`),
`ndv-nodes.js`, `ndv-ui.js` (`codeCell`), `graph-serialize.js` (`codeContext`
round-trip), `actions.js` (`if` **and** `while`), `i18n.js` (11 keys × 2
languages), `styles.css`. Tests: +14 engine, +9 model (suite 1677 → 1700).

---

## 4. How to verify / روش تست

```bash
cd /home/user/webapp
npx tsc --noEmit                       # TypeScript
node --check public/js/flow-editor.js  # and every touched client file
npx vitest run                         # baseline: 43 files / 949 tests
node tools/ui-preview-server.js 8788 &                       # visual harness
UI_LANG=fa node tools/ui-shot.js '/editor' .ui-shots/fa.png 1440x900
node tools/picker-panel-shot.js                              # picker panel
```

`tools/ui-shot.js` accepts `UI_LANG`, `UI_SEED`, `UI_STEPS`, `UI_WAIT`; the
`steps` argument understands `dbl:`, `ndv:<action>`, `ndv:#id` and `key:`.
Every shot must report `errors: none`.

---

## 5. Current build/test state

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ clean |
| `node --check` (touched client files) | ✅ clean |
| `tests/unit/element-picker.test.ts` | ✅ 38/38 |
| `tests/unit/editor-shell.test.ts` | ✅ 67/67 |
| `tests/unit/condition-engine.test.ts` | ✅ 52/52 |
| `tests/unit/ndv-designed-nodes.test.ts` | ✅ 39/39 |
| `tests/unit/condition-paths.test.ts` | ✅ 29/29 |
| `tests/unit/webstore-install.test.ts` | ✅ 28/28 |
| full `npx vitest run` | ✅ **80 files / 1898 tests** |
| `node tools/probe-condition-value-types.js` | ✅ **23/23 checks, VERDICT=PASS** |
| `node tools/ui-shot.js` (3 shots) | ✅ `errors: none` |
| line endings | ✅ `public/**` LF, `src/**` CRLF preserved |
| Git | branch `genspark_ai_developer` (the old GitHub account was banned; republished as a fresh repo) |
| Live smoke test | ✅ store install + browser launch + popup render |

---

## 6. Audit of the two browser missions (2026-08-13)

Both missions were re-audited end to end against the running code, not against
their own commit messages. **Two real defects and one false alarm** came out of
it. The false alarm is listed with the same weight as the defects on purpose: a
retracted finding is part of the audit result, not an embarrassment to hide.

| # | Finding | Status | Proof |
|---|---------|--------|-------|
| **BUG 1** | Every «Confirm & Add to Node» was refused with `stale_session`, so the Element Inspector could pick an element but never deliver it. The dashboard claims a node under a per-tab id it mints (`ui-…`); the extension submitted under an id **it** minted (`ext-…`); `InspectorHub.submit` compares the two for equality. Two independently generated strings are never equal. | **FIXED** | `tests/unit/inspector-session-handoff.test.ts` — 9 tests. Reverting the fix turns **4** of them red. |
| **GAP 2** | The Inspector extension was never present in Remote mode. `REAL_CHROME_EXTENSIONS_DIR` (`profiles/extensions`) was expected to contain it and **nothing ever wrote it there**, so the one-inspector-for-both-modes requirement held only in Local mode. | **FIXED** | `src/core/InspectorExtension.ts` seeds it (SHA-256 fingerprint, generated `bootstrap.config.js`). Verified in a real headed Chromium: service worker live, `ABInspect` present, generic extraction returned `["id=buy","href=/checkout","data-sku=SKU-1","data-anything=yes"]`. |
| **~~BUG 3~~** | *Claimed:* the dashboard's download shelf lost half of all real filenames (`suggestedFilename()` 12/24). **RETRACTED — the code was already correct.** The 12/24 was measured by a probe launching Chromium with a bare environment; the product launches with `withUtf8Locale(process.env)` at **both** browser sites, and re-measured that way it is **24/24**. | **NOT A BUG** | `docs/MEASURED-DECISIONS.md` § «The 12/24 that never existed». |

What was kept from the retracted item, because it is independently justified:

- The **declared-header lookup** stays as defence in depth — the 24/24 depends on
  an environment variable set in another file, and the header cannot be lost that
  way. The tests now assert `withUtf8Locale` is present at both launch sites, so
  a removal fails a test instead of reaching a user.
- The **`contentType` argument** to `ensureUsableExtension` stays because it is a
  measured fix, though a narrow one: **4/7** tricky shapes. It matters only when
  the site named the file and the name had no extension (`export` → `export.csv`,
  `گزارش` → `گزارش.csv`). Verified to bite: removing it turns 4 behavioural
  assertions red.

Everything else specified in the two missions was found **implemented and
working**: the upload gesture (Windows → backend → website in one motion), the
auto-download return path, RFC 6266/5987 name parsing with the documented source
priority, Remote mode surviving alongside Local mode, the single Playwright
automation engine behind a Browser Adapter, the MV3 extension being a real
installable extension rather than browser-UI furniture, `Ctrl+Shift+C` picking,
hover highlight, fully generic `data-*` extraction with no whitelist,
multi-attribute selection, and the explicit refusal set
(`no_active_node` / `stale_session` / `empty_selection` / `invalid_element`).
The deleted Simulated Browser was **not** resurrected.
