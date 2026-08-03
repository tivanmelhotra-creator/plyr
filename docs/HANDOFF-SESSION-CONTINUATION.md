# HANDOFF — continuation brief (written 2026-08-03, mid-task, out of credit)

**Read this file first if you are starting a session with no chat history.**

This is a *continuation* handoff. The task was: implement the six problems recorded
in `docs/HANDOFF-SIX-REGRESSIONS.md`. **Three are done and committed. Three are not
started.** This file tells you exactly which, what was measured, what was learned
that is *not* in the original spec, and how to pick up item four without redoing
any thinking.

The original spec (`HANDOFF-SIX-REGRESSIONS.md`) is still the authoritative
description of *what* each problem is. This file is the authoritative description of
*where the work stands*. Where the two disagree, **this file wins**, because it was
written after measuring against a running server.

---

## 0. The one-paragraph version

`§2` (extension install destroyed every tab), `§1` (heal panel stranded the user
forever) and `§4` (remote clipboard) are **fixed, proven with live probes, unit
tested, and committed**. `§3` (remote upload + download), `§6` (picker minimize) and
`§5` (light remote-desktop mode) are **untouched — no code written, no probe
written**. The full test suite is green (1269/1269) and `tsc --noEmit` is clean at
the last commit, so the tree is a safe place to start from. Do **not** re-verify the
finished three; spend the budget on `§3`.

---

## 1. Bring the environment up — it does NOT survive a sandbox reset

Nothing below works until this is done, and the failure mode is confusing (probes
hang rather than error). Run in this order:

```bash
cd /home/user/webapp

# 1. redis
redis-server --daemonize yes
redis-cli ping                      # expect PONG

# 2. virtual display (Chrome is real Chrome; it needs a display)
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# 3. build — THE SERVER RUNS dist/, NOT src/
npx tsc

# 4. start the server
bash scripts/dev-server.sh

# 5. prove it
curl -s localhost:3000/health | head -40
```

`/health` must show `status: ok`, `redis: connected`, `globalBrowser.healthy: true`.

**`.env` already exists** (4 lines, gitignored). If it is missing after a reset,
that is the first thing to check — the API key in it is what every probe
authenticates with.

### The single most important operational fact

> **The server runs `dist/index.js`, not `src/`.**

After editing anything under `src/`, you must run `npx tsc` **and** re-run
`bash scripts/dev-server.sh`. Editing `src/` and re-running a probe will show you
the *old* behaviour and you will chase a ghost. This wasted time in an earlier
session; do not repeat it.

Client-side files under `public/` are served from disk, so those take effect on
reload with no build step.

---

## 2. The verification mandate (the owner's standing rule)

> «هر ادعا را با تست زنده روی سرور در حال اجرا ثابت کن، نه با grep روی سورس»

**Prove every claim with a live test against the running server, not by reading
source.** A source-level cause is a *hypothesis*; it is not established until it is
reproduced. This rule earned its keep this session: it is what caught that `§4`'s
leading documented cause was **false** (see §5.3 below). Had that been "fixed" from
source reading alone, a real bug would have been left in place and a non-bug
"fixed".

Corollary, learned the hard way this session: **a probe must prove that its own
reproduction actually bit.** See §6.4 (positive controls).

And the second standing rule:

> «حواست باشه بقیه رو صدمه نزنی» — do not damage what already works.

Re-run the baselines (§4) after each change.

---

## 3. Project rules that apply to every change (non-negotiable)

* **R4 — git ritual.** Branch `genspark_ai_developer`. Commit after every change.
  Before the PR: `git fetch origin main`, rebase, **squash all local commits into
  ONE**, force-push, open/update the PR, **give the owner the PR link.**
  Squash non-interactively: `git reset --soft HEAD~N && git commit -m "…"`.
* **R5 — the stack.** Plain CSP-safe JS on the client: **no framework, no CDN, no
  inline `<script>`, no `eval`**. **i18n parity is mandatory** — every new key goes
  in **both** the `fa` and the `en` dictionary in `public/js/i18n.js`.
* **Green gates:** `npx tsc --noEmit`, `node --check` on touched JS, and
  `DISPLAY=:99 npx vitest run` must all pass before a commit.
* **CSP:** `img-src 'self' data:` must **not** be widened. It is in `src/index.ts`.
* **Line endings — check before editing.** Run `file <path>`. `public/**` is LF.
  `src/**` is mostly **CRLF**, with recently-touched files converted to LF.
  Known: `src/index.ts` = **CRLF**, `src/config.ts` = **CRLF**,
  `src/core/LiveBrowser.ts` = LF, `src/core/SelfHeal.ts` = LF,
  `src/Routes/browser.routes.ts` = LF, `src/core/Desktop.ts` = LF. All `docs/**` =
  LF. Getting this wrong produces a diff that touches the whole file and hides the
  real change.

---

## 4. Baselines — the numbers you must not regress

Recorded at commit `00a0a80` with the environment of §1 up.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `DISPLAY=:99 npx vitest run` | **54 files / 1269 tests, 0 failures** |
| `node tools/probe-live-parity.js` | **69/69** |
| `node tools/probe-ui-controls.js` | **30/30** |
| `node tools/probe-restart-tabs.js` | **13/13** (§2) |
| `node tools/probe-heal-panel.js` | **25/25** (§1) |
| `node tools/probe-clipboard.js` | **20/20** (§4 server) |
| `node tools/probe-clipboard-ui.js` | **13/13** (§4 client) |

Probes need the fixture server for some cases; `tools/fixture-server.js` listens on
**port 3111** and each probe starts/stops it itself.

**Note on a documented flake:** `HANDOFF-SIX-REGRESSIONS.md` §8.4 warns that the
`picker-drive` suite is flaky. In the full run at `00a0a80` it **passed**. Treat a
single `picker-drive` failure as suspected flake — re-run it alone before believing
it — but do not use "it's flaky" to dismiss a *reproducible* failure.

---

## 5. What is DONE (do not redo — but read §5.3, it changes the spec)

### 5.1 §2 — installing an extension lost every tab — commit `7b53fc5`

The most serious item; the owner called it «مشکل بزرگیه». Chrome only reads
extensions at launch, so installing one **must** relaunch Chrome; the relaunch
persisted an empty tab list over the good one.

Fixed with `SELF_CLOSE_GRACE_MS` + a `tabsFrozen` guard in
`src/core/LiveBrowser.ts`, so a teardown in progress cannot overwrite the saved tab
strip. Proof: `tools/probe-restart-tabs.js` **13/13**, plus 19 tests in
`tests/unit/restart-tab-loss.test.ts`. A `bvp.tabsRestored` toast was added
(fa + en).

### 5.2 §1 — the heal panel stranded the user — commit `05f5ee7`

All five points of the spec's fix plan are implemented, plus a sixth defect found by
the probe that the spec did not know about.

* **The lease** — `setHealLease(phase)` in `public/js/browser-view.js`. This is the
  core fix and it follows the invariant in `HANDOFF-SIX-REGRESSIONS.md` §8.1:
  **any state set optimistically on a user action must expire on its own.** Timeout
  is 20 s for a user press and 45 s for a heal resumed from server state. On expiry
  it hides the panel, **re-enables the restart button**, sets an error status and
  toasts `bvp.healLost`.
* **The invented ETA is gone.** The code claimed `etaMs: 6000` for a step. Measured
  reality: real restarts complete in **462–1315 ms**, and end-to-end in-probe
  **3470 / 4041 ms**. The hard-coded number was replaced by an *elapsed* estimate
  that degrades to `bvp.healSlow` rather than lying. The `ETA` table in
  `src/core/SelfHeal.ts` (~line 107: `display 3000`, `chromeStart 6000`,
  `chromeStop 2000`, `verify 1500` ≈ 12.5 s total) is the figure the 20 s lease was
  reconciled against — it is a real budget, not a guess.
* **An exit exists** — `#bvp-heal-close` dismiss button (`bvp.healDismiss`).
* **Resume on reopen** — `resumeHeal()` reads `/browser/status`, and
  `/browser/status` now publishes the live heal, because `SelfHeal` tracks it:
  `current`, `depth`, `isHealing()`, `currentHeal()`, `track()` and a `span()`
  wrapper with a `finally` that decrements depth. Both public entry points
  (`ensureBrowser`, `reloadExtensions`) are wrapped. Nesting is handled by depth, so
  an inner heal cannot clear the outer one's state.
* **NEW FINDING, worth more than the rest.** `#bvp-restart` was left `disabled`
  **forever**. The handler re-enabled it only in a trailing `.then()`, which never
  runs for a promise that never settles — so the one control that could have
  recovered the situation was the one the bug removed. This is why the user was
  truly stuck, not merely annoyed. It is now re-enabled by the lease.
* **The "power button" complaint was real, and the user read it correctly.** The
  restart handler and tooltip were always right. The *icon* was wrong:
  `public/js/icons.js` lines 197-198 alias **both** `close: 'power'` **and**
  `'close-browser': 'power'` — so in this product that glyph already means "shut
  down". Changed to `repeat`. Deliberately **not** `rotate-cw`, because Reload uses
  that glyph two buttons away.

Proof: `tools/probe-heal-panel.js` **25/25**, plus 37 tests in
`tests/unit/heal-panel-stuck.test.ts`.

### 5.3 §4 — remote clipboard — commit `00a0a80` — **AND THE SPEC IS WRONG**

> **⚠️ `HANDOFF-SIX-REGRESSIONS.md` §4's leading root cause (§4b) is FALSE.**
> Do not act on it. It has been struck through in that file; this is the record of
> why.

The spec proposed that `recover()` in `src/core/LiveBrowser.ts` grants clipboard
permissions **only** inside the `isContextDead` branch (line 1853; the initial grant
is line 806), so a recovery that reuses the live context would silently lose
clipboard permission. Plausible, well-localized, and it would have been a one-line
fix.

**It was measured and it does not happen.** `tools/probe-clipboard.js` tests both
directions in three phases — fresh, after a `resync` (the *predicted* failure case),
and after a real `/browser/restart` — and returns **20/20**. Permissions survive.
The one-line fix would have changed nothing and the real defect would have shipped
untouched.

**The real defect was diagnostic, not functional.** `writeLocalClipboard` returned a
bare `false` for three situations with three different remedies (insecure origin /
user-denied permission / no clipboard API at all), so the UI could only ever say
"Could not write to your clipboard" — and it **discarded text that had already
crossed the machine boundary**, which is the expensive part.

Fixed in `public/js/remote-io.js`: the function now resolves `{ok, reason}`,
`legacyCopy` returns objects and detects a missing `execCommand` (`noApi`),
`clipboardBlockedByOrigin()` names the insecure-origin case, each reason maps to its
own message (`rio.copyInsecure` / `rio.copyDenied` / `rio.copyNoApi`), and
`showCopyFallback(text)` presents a read-only, pre-selected textarea so the user can
copy by hand instead of losing the text. That textarea is built with DOM calls —
**never `innerHTML` of remote page text** — and it does not stack on repeat.

Proof: `probe-clipboard.js` **20/20** (server), `probe-clipboard-ui.js` **13/13**
(client, drives the real UI), plus 28 tests in `tests/unit/clipboard-reasons.test.ts`
which also **pin the negative result** — they assert the server still grants
permissions, so if someone later breaks that, a test says so.

---

## 6. Extra findings — recorded because the owner asked for them explicitly

> «هر موردی اضافه رو یادداشت کن تا همراه pr ذخیره بشه در گیتهاب»

These are things learned while working that are **not** in the original spec. Some
are traps; read them before writing code.

### 6.1 API surfaces that do NOT exist (I assumed them; they are not there)

Verified against `src/core/BrowserStreamServer.ts`:

* **There is no `eval` WS command and no `insertText` WS command.** The complete
  real dispatch list is: `navigate, back, forward, reload, click, move, drag,
  scroll, pinch, zoom, contextMenu, expandSelection, type, key, paste (line 328),
  copy (331), selectAll (334), fileAccept, fileCancel, picker, pickStep, verify,
  tab*, dialogAnswer, authAnswer, downloadClear, resync (443), ping, forgetSession`.
  If you need to run script in the page from a probe, you must do it through the
  probe's own Playwright handle, not the socket.
* **`tools/fixture-server.js`'s `start(port)` takes no custom-pages argument.** Add
  a page to the `PAGES` map in the file instead. Teardown is `close()`.

### 6.2 How to make a fixture page report its own state

The fixture pattern is a beacon: the page calls `R(k, v)` and the probe reads it back
over HTTP with `fx.report(k)`. A `/clip` page was added this session that reports
clipboard **promise outcomes** — `R("write","wrote")` vs `R("write","ERR:"+e.name)` —
which is what makes "the browser refused" distinguishable from "nothing was
written". Copy this shape for `§3`: have an upload fixture report the
**content-type it actually received** and the **byte length**, so you are not
guessing.

### 6.3 Clicking the stage centre does not focus a field

A probe bug that cost real time: `probe-clipboard-ui.js` clicked the centre of the
live stage to focus an input, which actually focuses the remote page **body**, so
paste appeared to fail. The fix is to click the field by its `#bvp-canvas`
`boundingBox()` coordinates. Before blaming the app, confirm a synthetic
`ClipboardEvent` works in isolation — that is the step that localized this to the
probe.

### 6.4 A probe must assert that its reproduction actually bit (positive control)

`probe-heal-panel.js` strands `/browser/restart` **at the network layer**: it holds
the `page.route` and never calls `continue()` or `abort()`. That is deliberate —
aborting produces a *settled* rejected promise, which is a different bug from the
one being reproduced (a promise that never settles at all).

Two consequences worth copying:

1. The probe's own held/aborted routes generate `net::ERR_FAILED` console noise. The
   right response is **not** to loosen the console assertion — it is to classify
   **self-inflicted** errors separately from app errors, so real errors still fail
   the run.
2. The probe asserts a **positive control**: that the blackhole actually took
   effect. Without it, "the panel came down" could pass simply because the restart
   succeeded normally, proving nothing at all. **Any probe that reproduces a failure
   must prove the failure was present.**

### 6.5 Three of my own bugs, each caught by measuring rather than assuming

Listed because they are the failure modes most likely to recur:

1. **Double-escaped `\\u2014`** in new `en` i18n values would have rendered
   literally as `\u2014` on screen. Fixed; a test now forbids the pattern.
2. The `fnBody(src, name)` test helper could not find TS class methods (2 false
   failures), then mis-parsed a **brace-containing return type** —
   `currentHeal(): { … } | null` — taking the return type's `{` as the body (1
   more). It now skips the parameter list *and* the return type before finding the
   body brace. The hardened version lives in `tests/unit/heal-panel-stuck.test.ts`;
   **reuse it, don't rewrite it.**
3. The probe-focus bug in §6.3.

### 6.6 §5 has no history to restore — the spec's cheapest option is closed

The spec's fix plan for `§5` opens with "search history first for a removed light
mode; prefer restoring it." **That search has now been done and it comes back
empty:**

```
git log --oneline -- src/core/Desktop.ts
  095eb4c feat(browser): start real Chrome on a headless host, …
  5352875 feat(browser): real Chrome with extensions, cookie import and a DevTools port

git log --all --oneline -S "light" -- src/core/Desktop.ts
  (no output)
```

Two commits, neither introduces or removes a light/auto mode. So **`§5` is a new
feature, not a restoration** — budget for it accordingly. What the user remembers
was most likely a different entry point or another tool.

### 6.7 §3 — the limits disagree three ways, and the spec mis-states one

The spec says `/browser/uploads` is declared with `limit: MAX_UPLOAD_BYTES`. That is
correct (line 612) — but note that a nearby route, `/browser/extensions` (line 322),
uses the string literal `'64mb'`, and the global JSON parser uses a third value.
Verified this session:

| Where | Value |
|---|---|
| `src/index.ts` line 70 — global `express.json` | `config.MAX_REQUEST_BODY_SIZE` = **`'20mb'`** (`src/config.ts` line 356) |
| `browser.routes.ts` line 612 — `/browser/uploads` raw | `MAX_UPLOAD_BYTES` = **32 MB** (`src/core/RemoteUploads.ts` line 50) |
| `browser.routes.ts` line 322 — `/browser/extensions` raw | **`'64mb'`** literal |

So a 25 MB upload's fate depends on which parser sees it first, and the user-facing
error will not name the real limit. Reconcile these to **one** source of truth and
surface it in the error message.

---

## 7. What is LEFT — start here

Recommended order: **§3 → §6 → §5.** `§3` is a live-proven bug in a feature the
owner uses (highest value). `§6` is self-contained new UI with an existing pattern to
copy (cheap, safe). `§5` is the largest and least certain, and §6.6 just made it
more expensive.

### 7.1 §3 — remote upload + download (NOT STARTED — do this first)

Full description: `HANDOFF-SIX-REGRESSIONS.md` §3. It contains two failure modes
**already reproduced with curl**, so you are not starting cold.

**Step 0 — reproduce from the real UI and read the status code.** The two modes are
distinguishable and must not be fixed blind:

* `401 Authentication required` → mode **3b** (missing API key)
* `Unexpected token 'H', "HELLOBYTES" is not valid JSON` → mode **3a** (a JSON
  content-type reached the body parser)

**Mode 3a — the client sends the wrong content-type.** The trigger is exact:

```js
// public/js/api.js line 41
if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
```

`window.API` stamps a JSON content-type on **any** request with a body, including
binary. `public/js/remote-io.js` sets `application/octet-stream` correctly on its own
`fetch`, so the break is any upload path that goes through `window.API` instead.
Fix **both** ends — the client must stop mislabelling binary bodies, **and** the
server must not depend on the client's header. Scope the global
`express.json({ limit: config.MAX_REQUEST_BODY_SIZE })` at `src/index.ts` line 70
so it cannot shadow the raw upload route (mount per-router, or skip
`/browser/uploads`). **`src/index.ts` is CRLF — check `file` before editing.**
Then reconcile the three limits from §6.7 and put the real number in the error.

**Mode 3b — the key is origin-scoped and may simply be absent.**
`public/js/api.js` line 13 reads `localStorage['ab_api_key']`; `remote-io.js` line 93
forwards `window.API.getKey()`; `/browser` sits behind `asyncAuthMiddleware`
(`src/index.ts` line 245). `localStorage` is **per-origin**, so "I upload from my
Windows machine" is precisely the case most likely to have no key stored — and it
also explains "it used to work" without any code changing. Make this an
**actionable** error: name the cause and offer the route to fix it. A 401 that
reaches the user as "upload failed" is the exact silence-instead-of-cause failure
that the whole `RemoteIO` module exists to remove (read its header comment).

**Then the part the owner actually asked for — remote/local detection**, for
**both** directions:

> «باید خود برنامه تشخیص بده که ارتباط ریموته یا لوکال»

There is no detection anywhere today (`grep isRemote|localhost|127.0.0.1` in
`public/js/remote-io.js` → nothing; it just assumes remote). Decide the rule and
**write it down in the code**:

* the streamed browser is **always** on the server, so "local" can only mean *this
  page is being viewed on the same machine as the server*;
* detect it honestly — compare the page origin's host against the **server's own
  view of itself** (add a field to `/health` or the session-attach payload). Do
  **not** infer it from `location.hostname === 'localhost'`: that is wrong for
  port-forwarded, tunnelled and containerized setups, i.e. wrong for this very
  sandbox;
* **default to remote when unsure.** Remote-mode on a local box is a harmless extra
  copy; local-mode on a remote box is a broken feature.

**Do download too.** The shelf is `browser.routes.ts` line ~662
(`router.get('/browser/downloads/:token', …)`), documented from line ~645 with
"Same identity rule as `/browser/uploads`, and for the same reason". The owner asked
for both directions; upload-only will read as half-done.

**Instrument to write:** `tools/probe-upload.js`. Assert the *content-type actually
received* and the byte length (use the §6.2 beacon), a 401 that names its cause, an
over-limit file that reports the real limit, and a download round-trip. Include a
positive control (§6.4).

### 7.2 §6 — make the element picker minimizable (NOT STARTED)

Full description: `HANDOFF-SIX-REGRESSIONS.md` §6. This is **new UI** — `grep
minimize|minimiz|bvp-min|collapse` in `browser-view.js` returns nothing.

**Reuse the proven pattern; do not invent one.** The minimap already does exactly
this — titled header, `[x]` that collapses to a **restore chip**. Anchors verified
this session in `public/js/flow-editor.js`:

* header markup: `.fe-mm-head` / `.fe-mm-title` / `.fe-mm-actions`, lines ~4198-4211
* the collapse button: `.fe-mm-close` with `data-mm="close"`, line 4201
* the restore chip: `chip.className = 'fe-mm-restore'`, line 4219
* the toggle: `setMinimapOpen()` line ~4297, whose contract is
  `dom.minimapWrap.hidden = !minimapOpen` / `dom.minimapRestore.hidden = minimapOpen`
* the view-preference flag `minimapOpen` (line 149) lives **outside** graph state —
  copy that separation
* the contract is documented by tests: `tests/unit/canvas-chrome.test.ts`, item F,
  lines ~161-232

**Anchor the chip next to the `bvp.sessionSaved` line above the tab bar**, as
requested. That string is rendered at `public/js/browser-view.js` line 1205
(`sessEl.textContent = signedIn ? t('bvp.sessionSaved') : t('bvp.sessionAnon')`);
the dictionary entries are `i18n.js` line 429 (fa) and 1742 (en).

**The one thing that would turn this into a data-loss bug:** minimize must **not**
tear down the session. `closePick()` destroys `pickState`, the WebSocket **and now
the heal lease and `healEtaTimers`**. Minimize is a *view* state, not a *lifecycle*
state. Unit-test that distinction explicitly.

Also: 2 new i18n keys in **both** dictionaries (minimize + restore); `aria-expanded`
and a real label; keyboard reachable. **Verify the icon name resolves** — `icons.js`
silently renders a `dot` for an unknown name, which is invisible in review;
`canvas-chrome.test.ts` line ~335 already asserts this for other icons, copy it.
`chevron-down` (line 63) and `chevron-up` (66) are registered and are the natural
candidates. Do **not** use `x`/`close`: per §5.2, `close` aliases to `power` and
already means "shut down" here.

### 7.3 §5 — light remote-desktop mode (NOT STARTED, and now known to be new work)

Full description: `HANDOFF-SIX-REGRESSIONS.md` §5. **Read §6.6 above first: there is
no removed implementation to restore.**

Critically, the owner clarified what they mean, and it narrows the job:

> «ئر مورد مرورگر ریموت هم منظورم همون کرومیوم پلی رایت هست که موقع اتوماسیون روی
> اون کار میکنی … ریموت مستقیم به پلی رایت باعث میشع راحت تر مشکل رو حل کینم»

So the view must show **the actual Playwright-driven Chromium that automation
drives** — not an Ubuntu desktop, and not a second browser. Its purpose is
**diagnosis**: the owner cannot currently tell whether the real tabs are still alive
after a restart. (Note this is *why* `§5` was requested — and `§2` being genuinely
fixed lowers its urgency, which is why it is last.)

Structural facts verified in `src/core/Desktop.ts` (LF, 392 lines):

* line 46: `export type DesktopComponent = 'xvfb' | 'x11vnc' | 'novnc'`
* line 227: the stack is Xvfb → x11vnc → websockify, exporting **the whole display**
* line 380: `novncPath: '/vnc.html?autoconnect=1&resize=remote'`
* routes: `GET /browser/desktop/status` (line ~697), `POST /browser/desktop/start`
  (~703), `POST /browser/desktop/stop` (~709) in `browser.routes.ts`

Because x11vnc exports a whole display, **"light" is a launch-composition choice,
not a VNC choice**: nothing else on that display — no window manager, no desktop —
just the browser sized to fill it. Make the mode explicit and remembered
(`light` | `auto`) with **`light` as the default**. Note the shared-context
constraint: `RealChrome` provides **one shared persistent `BrowserContext`**
(`isSharedContext()` — **never close it**), launched with `--load-extension`; the
light view must attach to that existing Chrome, not spawn a rival.

State the honest caveat in the UI: the light view shows the *real* Chrome display, so
what the user sees is the truth — but a `data:`/`about:blank` tab looks alarming
while being perfectly healthy. One line of explanation prevents the next false bug
report.

**Cheaper alternative worth offering the owner first:** a plain "what is actually
open right now" readout (real tab count + URLs, server-side truth). That answers the
underlying question — *are my tabs still alive?* — without VNC at all, for a
fraction of the cost. If credit is short, do this instead and say so.

---

## 8. Cross-cutting patterns to keep applying

### 8.1 The lease invariant (the bug shape that keeps recurring)

> **Any state set optimistically on a user action must expire on its own.**

Three separate bugs in this project have been this same shape. There are now two
reference implementations in `public/js/browser-view.js`: `setNavBusy(on, phase)`
(pre-existing) and `setHealLease(phase)` (added this session). **When `§3` or `§6`
sets a spinner, a disabled button, or a busy flag, give it a lease.** And note the
sharpest lesson from §5.2: the lease must restore **every** control it disabled — the
stuck restart button is what turned an annoyance into a dead end.

### 8.2 A layer with no instrument is a layer where bugs survive

This is the coverage-shape argument from `HANDOFF-SIX-REGRESSIONS.md` §8.2, and it
held again: `§4`'s real defect lived in the layer that had no probe, while the
documented-but-false cause lived in a layer that did. Write the probe for the layer
you are about to change.

Per the parity handoff's own queue, **screenshots remain the only layer in the §4.4b
coverage table with no instrument** — that is the standing next item after these six.

### 8.3 Static tests are for pinning *wiring*, not behaviour

Several suites here read source text to assert that a decision stayed made
(`heal-panel-stuck.test.ts`, `clipboard-reasons.test.ts`, `canvas-chrome.test.ts`).
That is deliberate: wiring is the class of thing that drifts silently and that a
behavioural test will not catch. Live behaviour is proven by probes; *decisions* are
pinned by these. Keep both, and keep them separate.

---

## 9. Exact state of the tree as this file is written

Branch **`genspark_ai_developer`**, working tree clean apart from this file and the
`§4b` correction to the spec.

```
00a0a80  fix(browser): a clipboard failure now names its cause (§4)
05f5ee7  fix(browser): the heal panel can no longer strand the user (§1)
7b53fc5  fix(browser): an extension install no longer loses every tab (§2)
2d370d2  (origin/main) Merge pull request #27 …
```

Per **R4** these are squashed into a single commit before the PR, so on `main` you
will see one commit covering §2 + §1 + §4 + these docs. The three hashes above are
recorded here because the squash destroys them and they are the only remaining map
from a change to the reasoning behind it.

### Files changed by the finished work

| File | What changed | Note for the next session |
|---|---|---|
| `public/js/browser-view.js` | §1: `setHealLease`, `clearHealEtaTimers`, `resumeHeal`, dismiss button, `repeat` glyph, `etaMs` removed, `pickState.healTimer`/`healEtaTimers`, `closePick` cleanup | **This is also the file `§6` edits.** LF |
| `src/core/SelfHeal.ts` | §1: `current`, `depth`, `isHealing()`, `currentHeal()`, `track()`, `span()` | LF |
| `src/Routes/browser.routes.ts` | §1: `/browser/status` returns `heal` | **`§3` edits this** (upload 612, download ~662, desktop ~697 for `§5`). LF |
| `public/js/remote-io.js` | §4: `{ok, reason}`, `clipboardBlockedByOrigin()`, per-reason messages, `showCopyFallback()` | **`§3` edits this** (upload ~91, key ~93). LF |
| `public/js/i18n.js` | 5 `bvp.heal*` + 5 `rio.copy*` keys, **fa and en** | `§3`/`§6`/`§5` all need new keys here. LF |
| `public/css/styles.css` | `.bvp-heal-close`, `.rio-copy-fallback*` | LF |
| `src/core/LiveBrowser.ts` | §2: `SELF_CLOSE_GRACE_MS`, `tabsFrozen` | `grantPermissions` 806 + 1853, `paste()` ~2661, `readClipboard()` ~2685. LF |
| `tools/fixture-server.js` | added the `/clip` beacon page | `start(port)` takes no pages arg |
| `tools/probe-heal-panel.js` | **new** — §1 instrument, 25/25 | positive-control pattern (§6.4) |
| `tools/probe-clipboard.js` | **new** — §4 server, 20/20 | **this is what disproved §4b** |
| `tools/probe-clipboard-ui.js` | **new** — §4 client, 13/13 | canvas-boundingBox click (§6.3) |
| `tests/unit/heal-panel-stuck.test.ts` | **new** — 37 tests | has the hardened `fnBody` helper |
| `tests/unit/clipboard-reasons.test.ts` | **new** — 28 tests | pins that §4b is false |
| `tools/probe-restart-tabs.js` | **new** (earlier session) — §2, 13/13 | |
| `tests/unit/restart-tab-loss.test.ts` | **new** (earlier session) — 19 tests | |
| `docs/HANDOFF-SIX-REGRESSIONS.md` | status banners added; **§4b struck through** | still the spec for §3/§6/§5 |
| `docs/HANDOFF-SESSION-CONTINUATION.md` | this file | |

### Useful read-only anchors

* `tools/bvclient.js` — `connect({userId, key, port})` → `{send, waitFor(t, ms, from),
  all, last, events, frames, close}`. This is how a probe speaks `/browser/ws`.
* `src/index.ts` — **CRLF**. Line 70 global `express.json` (§3a), line 140 the "never
  a lost tab" contract, line 245 `asyncAuthMiddleware`, and the CSP.
* `public/js/icons.js` — `power` 135, `repeat` 136, `rotate-cw` 139, `x` 176,
  `chevron-down` 63, `chevron-up` 66; **`close: 'power'` and
  `'close-browser': 'power'` at 197-198**; unknown names silently fall back to `dot`.
* `src/core/BrowserStreamServer.ts` — the WS dispatch. See §6.1 for what is *not*
  there.
* **CDP screencast is delta-based** (`Page.startScreencast` over `/browser/ws`): a
  static page paints once and then goes quiet. **"No frames" does not mean broken** —
  this has caused false alarms before.
* `LiveBrowserSession` persists its tab strip to
  `profiles/sessions/<user>.tabs.json` as `{v:1, savedAt, tabs:[…]}` — inspect that
  file directly when reasoning about `§2`-adjacent behaviour.

---

## 10. Checklist to carry forward

```
[x] §2  tabs lost on extension install   — fixed, probe 13/13, 19 tests   (7b53fc5)
[x] §1  stuck heal panel                 — fixed, probe 25/25, 37 tests   (05f5ee7)
[x] §4  remote clipboard                 — fixed, 20/20 + 13/13, 28 tests (00a0a80)
        └─ §4b hypothesis DISPROVED — spec corrected
[ ] §3  remote upload + download          — NOT STARTED  ← start here (§7.1)
[ ] §6  picker minimize to a chip         — NOT STARTED  (§7.2)
[ ] §5  light remote mode → Playwright Chromium — NOT STARTED, is new work (§7.3)
[ ] then: parity queue resumes — §4.2 (J2TEAM install), §4.3 (screenshots, the last
    uninstrumented layer)
```

**Before finishing any session:** `npx tsc --noEmit`, `DISPLAY=:99 npx vitest run`
(expect ≥1269 passing), the affected probes, then the **R4** ritual — rebase on
`origin/main`, squash to ONE commit, force-push, update the PR, **hand the owner the
link.**
