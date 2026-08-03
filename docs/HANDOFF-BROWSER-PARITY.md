# Handoff — making the simulated browser behave like real Chromium

**Branch:** `genspark_ai_developer` · **Written:** 2026-08-03

This file exists so that a session starting with **no chat history** can pick the
work up. It records what was asked, what is done, what is *measured*, what is
still open, and the rules that must keep being followed. Read it top to bottom
before touching anything.

---

## 0. How to bring the environment up

Everything below assumes a running server. Nothing works without it.

```bash
cd /home/user/webapp

# One command does the whole stack: redis 6379, Xvfb :99, then the server.
# It is idempotent — safe to run again at any time.
bash scripts/dev-server.sh          # → http://127.0.0.1:3000, log at /tmp/server.log

curl -s http://127.0.0.1:3000/health   # expect "status":"ok" and "redis":"connected"
```

### After a sandbox reset, these are ALL gone — restore in this order

```bash
sudo apt-get install -y redis-server xvfb   # both vanish on a reset
# optional, only for the noVNC view: x11vnc websockify
npm install                                  # node_modules is not in the backup
npx tsc                                      # dist/ is not in the backup either
```

`.env` is **gitignored** (`.gitignore:9`) and is lost on every reset. Recreate it
with exactly these four lines or real-Chrome mode stays off and extensions cannot
load:

```
API_TOKEN=devtoken123
DEPLOYMENT_MODE=single
DEFAULT_HEADLESS=true
REAL_CHROME_ENABLED=true
```

Build and test:

```bash
npx tsc --noEmit          # typecheck
npx tsc                   # emit dist/ — the server runs dist/index.js, NOT src/
npx vitest run            # expect 51 files / 1185 tests, all passing
```

> **`picker-drive.test.ts` and `probe-*` compete for the machine.** Running the full
> suite while a probe or a second suite is live starved `picker-drive` (a real
> Chromium suite) into three 30s timeouts — a resource failure that reads exactly
> like a product bug. It passed 16/16 in isolation moments later. Run the suite on a
> quiet box before believing a failure in that file.

> **Trap that has already cost real time:** the server runs `dist/`. After editing
> `src/` you must `npx tsc` **and** re-run `bash scripts/dev-server.sh`, or you are
> testing the old binary and drawing false conclusions from it.

> **Second trap:** the fixture server binds port 3111 and an aborted probe leaves
> it held. Always `fuser -k 3111/tcp` before running the probe, or it dies with
> `EADDRINUSE` before a single check runs.

---

## 1. The live parity probe — the thing that decides what is true

The governing rule for this task is the user's:

> «هر ادعا را با تست زنده روی سرور در حال اجرا ثابت کن، نه با grep روی سورس»
> *Prove every claim with a live test against the running server, not by grepping
> the source.*

That rule is implemented by:

```bash
bash scripts/dev-server.sh          # server must be up first
fuser -k 3111/tcp 2>/dev/null       # free the fixture port from any aborted run
node tools/probe-live-parity.js     # exit code == number of failures
```

It opens a real `/browser/ws` socket, speaks exactly the protocol
`public/js/browser-view.js` speaks, and asserts on **what the server actually
sent back**. `tools/fixture-server.js` serves the pages it drives (port 3111) and
each page reports its own state back over HTTP, because the `verify` command only
counts elements and cannot read a selection.

### The tool belt (all under `tools/`, all runnable now)

| Tool | Runtime | What it is for |
|---|---|---|
| `probe-live-parity.js` | ~2 min | **The arbiter of truth.** 69 checks, streams as it goes, exit code == failures. Run this before believing anything. |
| `probe-focus.js` | ~110 s | Only the drag + basic-auth groups. For iterating on those two without paying for the full run. A subset of the truth, never a substitute. |
| `probe-open-timing.js` | ~5 s | Timestamps every event until `ready`. `--poison` plants a dead-origin saved tab first. Answers "does the window open at all, and how fast". |
| `probe-auth-order.js` | ~80 s | Asks for a 401 three times in three different preceding states. Built to find an ordering bug; it instead proved the credential cache (§4.1b). |
| `exp-auth-cdp.js` | ~3 s | Bypasses LiveBrowser entirely: does `Fetch.authRequired` fire at all, in plain **and** `--persistent` mode? Use to split "our bug" from "CDP does not do that". |
| `exp-drag-select.js` | ~4 s | Drives one drag three ways (Playwright `page.mouse`, paced CDP, paced CDP + clickCount) against one fixture. Use to split "our event shape" from "environmental". |
| `exp-attach-order.js` | ~1 s | Replays `attachPage()`'s pre-steps and reports which throws. Use when a per-page feature silently fails to install. |

**Note the pattern in the `exp-*` tools:** each one takes LiveBrowser *out* of the
picture to establish whether the platform can do the thing at all. Both times a
failure looked like a deep product bug, one of these settled it in seconds. Reach
for them early.

### Current score: **69 / 69 — all green**

| Run | Score | What changed |
|---|---|---|
| first | 20 / 56 | probe itself was wrong (see below) |
| second | 55 / 67 | probe fixed to use a real origin |
| third | 57 / 67 | crash + deadlock fixes |
| fourth | 66 / 67 | protocol-mismatch fixes |
| **now** | **69 / 69** | drag + basic-auth resolved; 2 new checks added |

Verify with `DISPLAY=:99 node tools/probe-live-parity.js`. It streams each
result as it happens (see §1), so a hang names the check it hung on.

**Beware resource contention when interpreting a run.** One run of the full
probe scored 49/68 with 19 failures that all shared the symptom "the page
reported nothing". Nothing was broken: a second Chromium (from an experiment)
plus some hanging `curl`s were running at the same time, and the fixture's
beacon `fetch()` calls simply did not land in the sandbox's CPU budget. Re-run
it alone before believing a mass failure.

### Two lessons from the probe that must not be re-learned

1. **`data:` URLs are rejected on purpose.** The first run failed ~30 checks
   because the probe navigated to `data:text/html,...`. `normalizeTarget()`
   (`src/core/LiveBrowser.ts:222`) refuses any scheme other than
   `http(s)/chrome-extension/about` — a bare `data:`/`javascript:` arriving from a
   client is an injection vector. **The probe was wrong; the server was right.**
   Fixtures must be served over real HTTP.
2. **`tabList()` omits falsy flags.** It sends `loading` / `favicon` / `audible` /
   `muted` / `pinned` only when true (wire saving); the client reads
   `!!tab.loading`. A probe asserting `'loading' in tab` measures nothing. Assert
   that the state is *observed set at least once* instead.

Also: the probe must call its own `soloTab(c)` helper before any group that cares
which tab is active. The beforeunload group deliberately leaves a guarded tab
behind, and three checks once failed purely from that state pollution.

---

## 2. Bugs found and fixed — all found by the live probe, none visible to unit tests

These are the four real product defects. Every one needed the running server.

### 2.1 One bad command took the ENTIRE SERVER down

`src/core/BrowserStreamServer.ts` — the hot message path was:

```ts
void this.handleCommand(session, msg);   // no .catch
```

Any command that rejected became an **unhandledRejection**, and `src/index.ts`
answers unhandledRejection with a *graceful shutdown of the whole process*. So
one unlucky tab destroyed every user's live session, and the only cure was a
manual restart — precisely the loop the GLOBAL MANDATE exists to abolish. The
replay path below it always had its `.catch`; the hot path did not, which is why
this only ever bit real users and never the tests.

Now the failure is reported as `error: command_failed` on the socket that caused
it, and the session stays up.

### 2.2 A tab that lost its CDP target was the rejection

`openTab()` and `materialize()` both had a bare `await this.bindCdp(page)`. A tab
whose target is replaced between `newPage()` and the bind rejects with
`no object with guid page@…`. Both are now guarded: the tab is marked `pending`
(the strip shows it still coming up), an out-of-band `resync()` rebinds it, and
the session continues. A tab that cannot bind is **not** a dead browser.

### 2.3 A saved tab with `prompt()` deadlocked EVERY open — unrecoverable

The worst one. `page.goto` does **not** resolve while a modal dialog is open. A
restored tab whose page calls `alert()`/`confirm()`/`prompt()` on load therefore
held `start()` open forever, so `emit('ready')` never fired. The client sat on a
connected socket looking at a dead window — the exact "dead but connected" state
requirement group 6 forbids — on *every single open*, and the only cure was
deleting `profiles/sessions/<user>.tabs.json` by hand.

Fixed in two layers:

* During restore only, `materialize()` attaches a `dismissDuringRestore` dialog
  handler and removes it in a `finally`. The user's own dialogs are untouched.
* `start()` races the restore against `RESTORE_BUDGET_MS` (12s). Missing the
  deadline costs the restored *page*, never the browser; the tab stays `pending`
  so clicking it retries — "we never lose a tab".

**Verified live against the poisoned `0.tabs.json` that caused it**: the session
now self-heals with the bad file still on disk.

### 2.4 `drag` NEVER worked — a client/server protocol mismatch

`public/js/browser-view.js` has always sent:

```js
send({ t: 'drag', from: { x, y }, to: { x, y }, button, mods });
```

…while `BrowserStreamServer` read flat `msg.x, msg.y, msg.x2, msg.y2`. Every real
drag therefore arrived as **0,0 → 0,0** and did nothing at all — no
drag-to-select, no sliders, no drag & drop, no file-drag upload — *while
reporting success*. A mismatch between the only client and the only server is
invisible to any test that exercises one side alone.

Same class, also fixed: `key` sends `autoRepeat`, the server read `msg.repeat`,
so a held key never told Blink it was a repeat.

Both now accept either shape. **Every command was audited for this class**; these
two were the only ones. Repeat the audit after any protocol change:

```bash
# command names present on one side only
grep -oE "t: '[a-zA-Z]+'" public/js/browser-view.js | sed "s/t: '//;s/'//" | sort -u > /tmp/cli.txt
grep -oE "case '[a-zA-Z]+'" src/core/BrowserStreamServer.ts | sed "s/case '//;s/'//" | sort -u > /tmp/srv.txt
comm -23 /tmp/cli.txt /tmp/srv.txt
# then per command, compare the FIELD NAMES each side uses — that is where drag hid
```

Note `authAnswer` sends `username`/`password`, **not** `user`/`pass`. An earlier
version of the probe got this wrong and blamed the product for not logging in.

### 2.5 CDP drag needed pacing (partially effective)

`Input.dispatchMouseEvent` resolves when the *browser process* accepts the event,
not when the renderer has handled it. Dispatching press → moves → release in a
tight loop delivered the whole path inside one compositor frame, so Blink saw a
teleport rather than a gesture. Moves are now paced ~16ms apart (one frame at
60Hz) with a settle gap after the press and before the release.

This fixed the **slider** (now passing). It did **not** fix drag-to-select-text —
see §4.1.

---

## 3. What is done and measured

All of the following are **PASS in the live probe**, not source assertions.

**Handshake / reconnect** — `ready` carries `zoom` and `downloads`; is followed by
`navState` and the tab list. Without `zoom` a reconnected client assumes 100% and
mis-places every click; without `downloads` saved files are unreachable forever.

**Navigation (requirement 1 + the user's final note)** — navigate / back /
forward / reload all verified to actually move. `navState` derives
`canGoBack`/`canGoForward` from `Page.getNavigationHistory` (CDP has no
`canGoBack`), so the arrows grey out instead of silently no-opping — which was the
reported "back/forward don't work" bug. `navStart`/`navEnd` bracket every
navigation, so there is no stuck spinner. Hard reload (Ctrl+Shift+R) supported.

**Input (requirement 1)** — the 9-item `NAMED_KEYS` whitelist is **deleted**.
Verified live that F1/F7, `; [ / \``, Home/End/PageDown/Insert/Delete, `Ctrl+a`
*with its ctrl flag*, and a two-modifier `Shift+Alt+ArrowRight` all reach the
page. Double-click selects exactly one word; triple-click selects the whole
paragraph. Wheel scrolls vertically; **Shift+wheel scrolls horizontally** (`dx`
honoured). Ctrl+/−/0 zoom, and zooming in **shrinks the CSS viewport**
(`innerWidth 1288 → 1280`) — proving real `Emulation.setDeviceMetricsOverride`
browser zoom, not a fake scale. Right-click reports a real context menu that
knows it hit a link (`linkUrl`, `linkText`, `imageUrl`, `editable`,
`hasSelection`).

**Page dialogs (requirement 2)** — alert / confirm / prompt all surface with kind
+ message + origin instead of locking the tab. Answering releases the tab, **and
the tab still navigates afterwards** (the original bug, explicitly re-checked).
Typed prompt text reaches the page; Cancel makes `confirm()` return `false`.
Closing a `beforeunload`-guarded tab **asks** rather than closing silently. HTTP
basic auth: a 401 raises `authRequired` naming the origin and realm, and the
correct credentials really fetch the protected page.

**Downloads (requirement 3)** — captured, reported with name and a `dl_`-prefixed
token, saved server-side, and the token **really serves the bytes over HTTP** —
while an unauthenticated fetch of the same token is refused (401/403).

**Tab strip (requirement 4)** — tabNew, tabMove (reorder), tabPin, tabMute,
tabDuplicate, Ctrl+Tab cycling, tabClose, **Ctrl+Shift+T reopen** (closed-tab
stack), and "close others" keeping pinned tabs exactly as Chrome does. Favicon and
loading are observed on the wire. Client-side: Chrome tab widths via
`flex: 1 1 0` + a JS-set `--bvp-tabmax`, pointer-driven reorder with midpoint
hit-testing (no dead zone), middle-click to close, and the full right-click menu.

**Stability (requirement 6)** — `resync` always reports back (`recovering` and/or
`recovered`) — never silence. `rebuildAll()` re-attaches every live session after
a Chrome relaunch, so installing an extension costs a progress panel and never a
lost tab. Screencast delivers frames.

**Self-healing (GLOBAL MANDATE)** — every "restart the server" string is gone from
`browser.routes.ts`, enforced by a guard-rail test. All 5
`SelfHeal.reloadExtensions` call sites pass `swapLiveSessions`; `src/index.ts`
registers the rebuilder via `setLiveSessionRebuilder` (routes cannot import the
manager — that would be a cycle, so a no-op default keeps the routes testable and
a test on `index.ts` catches a missing registration, which would otherwise
silently lose tabs forever while everything appeared to work).

---

### 2.6 Input commands failed in TOTAL SILENCE

`withPage()` and `withCdp()` — which every input command funnels through —
returned on any non-dead-target error, under the comment *"a normal failure: the
caller logs it"*. **No caller logged it.** So a click, drag, scroll or keypress
that failed for any ordinary reason produced no event, no log and no UI change:
indistinguishable from a command that was never sent.

That is exactly the failure the GLOBAL MANDATE forbids — the user acts, nothing
happens, nothing explains why. Both guards now call `inputFailed()`, emitting
`error{message:'input_failed', detail}`. It is deliberately a distinct message
from the fatal kinds, so the client shows a transient notice rather than tearing
the view down.

The payoff was immediate (see §4.1): the first run after this fix printed the
`restore_slow` / `restore_failed` events that explained a bug which had already
survived several rounds of investigation.

`installAuthHandler()` had the same disease in miniature — an empty `catch {}`,
so a page that could not get auth interception was simply unreachable on a 401
with nothing saying why. It now emits `auth_interception_unavailable`.

Both are pinned in `tests/unit/browser-tabs.test.ts`
(*"an ordinary input failure is REPORTED, never silently swallowed"*).

### 2.7 The probe itself could go silent — and did

The parity probe buffered all results and printed them only in its final summary.
A run then hung and the log contained exactly **one line**; there was no way to
tell which of 68 checks it stopped on without bisecting a two-minute run by hand.

A tool that measures a browser's liveness must not go silent while it works —
that is the same "dead but connected" failure the product is forbidden to have.
`check()` now streams each result as it is known, and the summary repeats only
failures. The very next run used this to name its own hang (`fixture.close()`)
in seconds.

---

## 4. What is still open — start here

### 4.1 Drag-to-select text — RESOLVED (the probe was wrong, twice)

`drag` works. The check passes:
`PASS mousedown→move→up selects a text range — "alpha bravo charlie delt"`.

This item is written up at length because the *shape* of the mistake is the
lesson, not the fix.

**The product was never broken. Two separate faults in the measuring
instrument made it look broken, and one of them made the other invisible.**

**Fault 1 — the probe dragged across empty padding.** The `/select` fixture
styles its paragraph `padding:40px`, inside a margined `<p>`, inside a margined
`<body>`. Its glyphs begin near **y=95**. The probe dragged along **y=55**, which
is padding. A drag across blank space correctly selects nothing. The reason this
survived so long is that it *looked* disproven: a double-click at the same
coordinates returned `"alpha"`, which seemed to prove the coordinates were fine.
It does not — a double-click snaps to the nearest word, so it tolerates being
off-target in a way a drag cannot.

The first attempt to settle this (`tools/exp-drag-select.js`) made the *same*
mistake in the *same* way, by deriving coordinates from
`p.getClientRects()[0]` plus a small offset. `getClientRects()` on the `<p>`
returns its **border box**, so `top + 26` is still padding. That run "proved"
that not even Playwright's own `page.mouse` could select text here, and very
nearly got written up as an environmental limitation of headless Chromium under
Xvfb. It had only proved that you cannot select padding.

Measuring a `Range` over the text **node** gives the real glyph boxes, and all
three gesture shapes then passed immediately: Playwright's `page.mouse`, raw
paced CDP, and raw paced CDP with `clickCount` on the moves.

The fixture now **reports its own geometry** (`R("geom", ...)`) and the probe
aims at what the page says rather than at a guessed constant. A page that
measures itself cannot lie about its own layout.

**Fault 2 — a silent swallow hid a genuine failure.** Once the coordinates were
right, drag *still* failed — and so did the slider, which had previously
passed. `withPage()` and `withCdp()` were returning on any non-dead-target error
under the comment *"a normal failure: the caller logs it"*. **No caller logged
it.** Every input command funnels through those two, so any command failing for
an ordinary reason failed in total silence.

Making them emit `input_failed` immediately produced the answer, in the probe
output, with no further debugging:

```
[server error @drag-text] {"message":"restore_slow","detail":".../secret"}
[server error @drag-text] {"message":"restore_failed: .../secret"}
```

The saved tab from a previous run pointed at `/secret`. Its restore failed, and
the CDP session stayed bound to a half-dead page: Playwright-API commands
(`click`) still worked, CDP-driven ones (`drag`) silently did not. Once restore
was healthy the drag worked and has worked since.

**The rule this earns:** when a live probe and a unit test disagree about
whether something works, suspect the probe — but when a command does nothing at
all and *nothing anywhere says why*, fix the silence first. The silence is
always a bug in its own right, regardless of what it was hiding.

**Ruled out along the way — do not re-test these:**

* `buttonsMask('left')` returns `1` correctly (`src/core/BrowserInput.ts:236`).
* Interpolation step count: `steps: 30` changes nothing.
* `button: 'none'` on the moves — what DevTools sends — **breaks the slider**
  (66/67 → 65/67). Blink wants the held button named on the move. There is a
  comment in `drag()` recording this; leave it alone.
* Event pacing is genuinely required: without a ~16ms gap between moves, Blink
  sees one teleport instead of a gesture. Keep it.

### 4.1b Basic auth — RESOLVED (real Chrome behaviour, not a bug)

All four auth checks pass. They had been failing with `no authRequired event`,
and the cause is worth recording because it is a property of real Chrome that
will bite any future test of this feature.

`tools/exp-auth-cdp.js` established, outside LiveBrowser entirely, that the
fixture really sends a 401 and that `Fetch.authRequired` really fires for this
project's exact CDP options — in both a plain context and a
`launchPersistentContext` one. So the challenge was being lost somewhere else.

The fixture was then made to log what the **server** saw per request, which
settled it in one run: every request arrived **`pre-auth-ok`**. Chrome was
sending the `Authorization` header *unprompted*, so no challenge was ever
issued and there was nothing for the product to report.

Chrome caches basic-auth credentials for the life of the **persistent profile**,
and — measured, against the common assumption — that cache is keyed by
**origin**, not by `(origin, realm)`. Both obvious mitigations failed:

| Attempt | Result |
|---|---|
| fresh path `/secret/<nonce>` | still `pre-auth-ok` |
| fresh realm in `WWW-Authenticate` | still `pre-auth-ok` |
| **fresh origin (new port)** | **`anonymous` — real challenge** |

The cache also outlives a server restart, because the profile does. So the auth
group now starts a **second fixture on a random high port** (`fixture.freshPort()`)
and there is a permanent check — *"the browser really was challenged (not
answering from cache)"* — that reads the server-side log. If the fresh-origin
trick ever stops working, that check fails loudly instead of letting four
assertions quietly measure nothing.

Two consequences worth knowing:

* **The probe must not poison its own next run.** The throwaway auth origin was
  being saved into the persisted tab strip, so the following run restored a tab
  whose host no longer existed. The product handles that correctly
  (`tools/probe-open-timing.js`: `ready` in **322ms**, tab kept as `pending`,
  never `dead`), but the probe now navigates back to the durable fixture before
  closing the throwaway one.
* **`server.close()` alone hangs.** Node stops accepting new connections but
  waits for existing ones, and Chrome keeps an idle keep-alive socket to every
  origin it has visited. Closing a fixture the browser had just used never
  called back and stalled a whole run at that line. `fixture.close()` now calls
  `closeAllConnections()` and has a 2s backstop.

### 4.2 J2TEAM Cookies end-to-end — requirement 5, NOT yet verified live

**This is now the top of the queue.** It is the user's own reported case and the
highest-value remaining item. The server-side pieces are in place and unit-tested;
the real end-to-end run has never happened.

Must be proved, in this order:

1. Install the extension → Chrome **auto-restarts and loads it with no button
   press** and no "restart the server" error.
2. The extension popup opens in a **NEW tab**, not over the active tab.
   (`RealChrome.extensionPageUrl()` exists for exactly this.)
3. `chrome.cookies.set` then `chrome.tabs.reload` → the tab **comes up logged in**.
4. No tab is lost across the Chrome relaunch (`rebuildAll()` should cover this —
   confirm it visibly).

The root cause of the originally reported failure is already fixed: an orphan page
with `opener() === null` is now claimable, so an extension-opened tab is adopted
instead of ignored. That fix has never been exercised against the real extension.

**Blocker found and NOT yet resolved — read this first.** Egress to the Chrome
Web Store could not be confirmed from this sandbox. Several `curl` attempts to
`clients2.google.com/service/update2/crx` and to the store page hung until the
tool timed out rather than returning a status. So before writing any test, settle
the network question:

```bash
# Does the sandbox reach the store at all? Expect a status line, not a hang.
timeout 15 curl -sS -o /tmp/j2team.crx -w 'http=%{http_code} bytes=%{size_download}\n' \
  "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=120&x=id%3Dokpidcojinmlaakglciglbpcpajaibco%26uc"
```

* **If it downloads** → drive `POST /browser/extensions/store` with the store URL
  and prove steps 1–4 above through a live `/browser/ws` session.
* **If it hangs or 403s** → do NOT keep retrying, and do not fake the result.
  Write a **local stand-in extension** instead: a tiny unpacked MV3 extension in
  `profiles/extensions/` whose `manifest.json` requests the `cookies` permission,
  whose popup calls `chrome.cookies.set(...)` then `chrome.tabs.reload()`, and
  point it at the `tools/fixture-server.js` origin with a fixture page that
  renders "logged in" only when the cookie is present. That exercises **exactly**
  the four steps above — the extension's identity is irrelevant to what is being
  proved — and it works with no egress at all. Note honestly in the PR that the
  mechanism was proved with a local extension because the store was unreachable,
  and that J2TEAM itself remains unverified.

Do not let this item stall on the network. The mechanism is the deliverable.

### 4.3 Playwright screenshots — the user's explicit method mandate

> "screenshot the UI with playwright and look at it — 'the element is visible' is
> not enough, it must *look* like Chrome"

Not done. `tools/ui-shot.js` and `tools/picker-panel-shot.js` are starting points.
Shoot: the tab strip with 1 / 3 / 8 / 12 tabs (Chrome widths + shrinking), a
pinned tab, the loading spinner, the download shelf mid-progress, all three dialog
kinds, the auth modal, the heal panel, and both context menus. Then **look at
them** and fix whatever does not look like Chrome.

New surfaces added since that list was written, which also need looking at:

* the `input_failed` transient notice (§2.6) — it must read as a passing notice,
  not as a crash, and must not shift the layout;
* `auth_interception_unavailable` — needs a sentence a non-engineer can act on.

### 4.3b The toolbar controls — CLOSED 2026-08-03. The user was right.

The user reported, in these words: *"به دکمه همه رفرش و جلو و عقب هم دقت کن ظاهرا
درست کار نمیکیند / و دکمه پلاس اضافه کردن تب جدید"* — Back, Forward, Reload and the
`+` button "apparently don't work properly".

The instrument now exists: **`tools/probe-ui-controls.js`** — real Chromium, real
clicks on `#bvp-back` / `#bvp-fwd` / `#bvp-reload` / `#bvp-tabadd`, opened through
the genuine user path (editor → `click` node → NDV → crosshair). **30/30 green**,
reproduced on three separate runs including one against a freshly built `dist/`.

> **The lesson, recorded because it will happen again: the audit below was
> correct and the buttons were still broken.** The previous session wrote *"Audited
> 2026-08-03. The wiring is correct. Do not fix it blind"* — and every word of that
> was true. `navCmd()` really does guard the socket; `#bvp-tabadd` really does route
> through `newTab()`. **Four real bugs were living behind that correct wiring**, and
> the audit could not see any of them because reading source cannot find a listener
> that is never reached. When the user contradicts a green score, the score is
> measuring the wrong layer.

**The four bugs the instrument found on its first run (25/30 → 30/30):**

1. **Every control inside a tab chip was silently un-clickable** — the X, the mute
   button, all of them. Not even in the original report, and the worst of the four.
   `mouseup` fires **before** `click`, and the tab-drag handler redrew the whole
   strip on mouseup, so the pressed element was detached and replaced before the
   browser could dispatch its click. The click had no target and the listener never
   ran. Fix: `if (moved) renderTabs(...)` — redraw only when a drag actually
   started. Diagnosed by printing the sent-command list: `navigate,picker,tabNew`
   with no `tabClose` anywhere.
2. **`navState` was never re-emitted when the streamed tab changed** — *this is the
   user's report, exactly.* History is **per tab**, but the client only ever learns
   `canGoBack`/`canGoForward` from a `navState` frame, and switching tabs emitted
   `tabs` + `navigated` and nothing else. So the arrows kept describing the tab the
   user had **left**: Back stayed lit on a brand-new tab, and pressing it did
   nothing — correctly, since there was no history. Fix: `await this.emitNavState()`
   at the end of `focus()`, and in `openTab()` guarded by `activate !== false` so a
   background tab cannot repaint the active tab's arrows.
3. **The busy spinner could spin forever.** `navBusy` was set optimistically on
   press and cleared only by `navStart`/`navEnd`/`navBlocked`; drop the command on
   the wire and none of the three ever arrives. Proven by swallowing the command in
   the probe's WebSocket tap and watching `is-busy` never clear — the "dead but
   connected" lie this whole effort exists to remove. Fix: the busy state is now a
   **lease, never a promise** — `setNavBusy(on, phase)` with two phases, because one
   timeout cannot serve both: `press` = 6s (only a round trip on an open socket is
   outstanding) and `server` = 35s (outlives the server's own 30s navigation
   timeout, so a genuinely slow page keeps its spinner). On expiry it clears itself
   and says so via `bvp.navLost` (fa + en), because a spinner that quietly gives up
   teaches the user the button does nothing.
4. **No tab could ever show a real favicon.** The strict CSP (`img-src 'self'
   data:`) refused every remote icon URL, logging a refusal on every navigation.
   Both "easy" fixes are worse than the bug — widening the CSP buys an exfiltration
   surface, proxying arbitrary URLs buys an SSRF hole — so the **page** fetches the
   bytes itself with its own cookies and returns a capped `data:` URL
   (content-type must be `image/*`, ≤ 24576 bytes). The CSP stays strict.

**Why this probe can be trusted (the design worth copying):** it never asserts that
an element exists — only that the page changed, via three witnesses, none of which
is "the client says so":

1. the fixture pages report their own identity over HTTP (`/p1`, `/p2`, and
   `/nonce`, which announces a **new** value on every execution — Reload has no
   other observable outcome, since the URL does not change);
2. the server's own frames, tapped passively off the page's WebSocket (frames are
   filtered out of the tap: ~50KB of base64 at ~15/sec would OOM it and prove
   nothing);
3. the toolbar's computed DOM state — `disabled`, `is-dim`, `is-busy`,
   `pointer-events`, and `elementFromPoint` to catch a transparent overlay stealing
   the click, which no other layer can see.

It also verifies its **own** preconditions: the dropped-command check asserts that
it really did swallow the command, because a test that silently fails to reproduce
its precondition passes for the wrong reason.

**One probe bug was found and honestly classified as such:** the "server confirms
the Back landed" check failed intermittently, because the fixture beacon and the
`navigated` frame travel different routes and either can land first. Fixed by
polling instead of reading the tap once. A probe that cries wolf teaches the reader
to distrust real failures too.

**Regression cover:** `tests/unit/toolbar-controls.test.ts` (28 tests) pins the
shape of all four fixes so they cannot be quietly undone between probe runs. Its
header says out loud that it is the **secondary** guard and the probe is the
primary one. Every assertion in it was **mutation-tested**: eight mutants — one per
fix, plus the four tempting *wrong* fixes (widen the CSP, collapse the lease to a
single timeout, drop the `data:` acceptance gate, emit `navState` unguarded) — and
all eight were killed. Assertions that pass on broken code are worse than no
assertions, so this is worth redoing if you extend that file.

**Still open from the original item:** step 4, screenshots — see §4.3.

### 4.4 Smaller open items

* **Pinch-zoom** (`Input.synthesizePinchGesture`) is wired but has no live probe
  check. Add one.
* **File-drag upload** — was blocked behind §4.1, which is now **resolved**, so
  this is unblocked. `drag()` is proven to work; use the glyph-geometry lesson
  (ask the page where its drop target is, never hard-code coordinates).
* **Tab crash / renderer crash / CDP disconnect** are handled in code and unit-
  tested but not yet forced live. Force them (kill the renderer via CDP) and
  confirm the UI shows a real state (loading / live / recovering / dead) and never
  "dead but connected".
* The probe leaves `downloads/` and `profiles/sessions/*.tabs.json` behind. A
  poisoned tabs file is now *survivable* rather than fatal — keep it that way; it
  is a good regression fixture.
* Nothing is known-broken at the protocol level **or at the click level**.
  Typecheck clean, full suite green (51 files / 1185 tests), live parity probe
  69/69, toolbar probe 30/30. §4.3b is now **closed** — the sentence that used to
  live here ("the toolbar buttons have no end-to-end coverage at all") was the
  warning that paid off: four real bugs were hiding behind it. The remaining
  un-instrumented layer is **visual appearance** (§4.3), so "nothing known-broken"
  is still a weaker claim than the scores suggest — just for a different reason.

### 4.4b The coverage shape — know what the green numbers do NOT mean

Worth internalising before trusting any score in this document:

| Layer | Covered by | Status |
|---|---|---|
| WebSocket protocol / server commands | `probe-live-parity.js` | 69/69 green |
| Server internals, string/shape contracts | vitest, 1185 tests | green |
| Real clicks on real DOM controls | `probe-ui-controls.js` | 30/30 green — closed §4.3b |
| **Visual appearance vs real Chrome** | **nothing** | **gap — §4.3** |

The row that used to read *"Real clicks on real DOM controls — nothing — gap"* is
now closed, and closing it **immediately produced four real bugs** in a tree that
was 69/69 and 1157/1157 green (§4.3b). That is the whole thesis of this table, now
with evidence: **a layer with no instrument is a layer where bugs survive.** The one
remaining gap is the other row the user keeps reporting problems about, which is not
a coincidence either.

When the user says a button is broken and the probe says green, **believe the user
and suspect the missing instrument**, not the report. Note that the previous session
audited the wiring, found it correct, and wrote so in good faith — the bugs were
still there. Do not let a careful source audit stand in for an instrument.

---

## 4.5 Where the last session stopped, exactly

Earlier work is in PR #24 / #25. The §4.3b work below is on
`genspark_ai_developer`.

**Finished and measured in the previous session:**

* `drag` (text selection **and** slider) — §4.1
* HTTP basic auth, all four checks — §4.1b
* input failures are now visible (`input_failed`) — §2.6
* the probe streams its results — §2.7
* `fixture.close()` no longer hangs; auth uses a fresh origin per run
* the probe no longer poisons its own next run

**Finished and measured in THIS session (§4.3b, now closed):**

* `tools/probe-ui-controls.js` — the missing click-level instrument: **30/30**,
  reproduced on three runs, the last against a freshly built `dist/`
* **four real bugs found and fixed** — dead tab-chip controls, `navState` not
  re-emitted on tab change (the user's actual report), a spinner that could spin
  forever, and favicons the CSP refused. Full write-up in §4.3b.
* `tests/unit/toolbar-controls.test.ts` — 28 tests pinning all four fixes,
  **mutation-tested 8/8 mutants killed**
* self-reporting fixture pages `/p1`, `/p2`, `/nonce`, kept deliberately separate
  from `/one|/two|/three` so the two probes cannot poison each other

**Current scores, all re-measured after the fixes:**

* toolbar probe: **30 / 30**
* live parity probe: **69 / 69** (no regression from the `navState`/favicon changes)
* `npx tsc --noEmit`: clean
* `npx vitest run`: **51 files / 1185 tests, all passing**

**The single next action: §4.2 — the J2TEAM extension install.**

Start with the Web Store network check; if the store is unreachable go straight to
the local stand-in extension, and do **not** spend the session retrying curl.

After §4.2: **§4.3 (screenshots)**, which is now the only layer in the §4.4b table
with no instrument at all — and the §4.3b result is the argument for doing it
properly rather than eyeballing one PNG. Take the shots **and look at them**; a
screenshot nobody opens is not coverage. Then §4.4.

---

## 5. Rules that must keep being followed

From the user, still in force:

* **GLOBAL MANDATE:** no restart may **ever** be required. Every place the code
  would say "restart the server" must fix the problem itself — bring the display
  up, relaunch Chrome, load the extension. The user said this loop has exhausted
  him. Two of the four fixes above were violations of exactly this.
* **Prove it live**, not by grepping source.
* **Tests must measure behaviour, not string presence.** Six brittle tests broke
  *because the code got better* — every one was a fixed-size source window or an
  assertion that old code still existed. Bound slices by code landmarks (the next
  declaration), never by a character count.
* **Ask "what does real Chrome do here?" before every UI decision.** Infer the
  logic; do not wait to be told item by item.
  («نمیخام دونه دونه بگم … مثل یک مرورگر واقعی باشه نه فقط چند تا چیز میز خیلی سطحی»)
* **Never conditionally hide an element with no alternative access path** — the
  "+ button lesson".
* **Waiting must be explained completely**: who, what, how long. The past pain was
  "must restart" with no indication *which* restart, leaving the user
  «گیج و منگ». The heal panel exists for this: the server sends a stable **key**
  (`heal.startingChrome`), never a sentence, so the panel can be Persian.
* **We never lose a tab.**
* **Persian *and* English** in the UI, both dictionaries kept in parity.
* **SVG icons only** — emoji are forbidden and `tests/unit/icons.test.ts`
  enforces it. `public/js/icons.js` must stay the first script in `index.html`.
* **CSP-clean**: no inline handlers, no `eval`.
* **Periodically give a Persian progress report** of done / in-progress /
  remaining. The user asked for this explicitly.

---

### Rules earned the hard way this session — these are not optional

1. **Never hard-code a coordinate into a probe.** Make the page report its own
   geometry. Two separate investigations were derailed by coordinates that aimed
   at padding, and one of them nearly shipped a false conclusion that headless
   Chromium "cannot select text". A page that measures itself cannot lie.
2. **A double-click passing does not prove coordinates are right.** It snaps to
   the nearest word; a drag does not. Do not use one to validate the other.
3. **Fix silence before you investigate anything else.** Both of this session's
   product bugs were empty `catch` blocks. A command that fails invisibly costs
   more than a command that fails loudly, every time, and the mandate forbids it
   outright.
4. **Take the product out of the picture before blaming it.** The `exp-*` tools
   exist for this. Twice, a "deep product bug" was settled in seconds by asking
   whether raw Playwright/CDP could do the thing at all.
5. **A test may not poison the state it runs in.** The auth group was saving a
   throwaway origin into the persisted tab strip and hanging its own next run.
6. **Interpret a mass failure with suspicion.** 19 simultaneous failures, all
   shaped "the page reported nothing", were caused by a second Chromium competing
   for the sandbox — not by the product. Re-run alone before believing it.
7. **Do not bound a source-reading test by a character count.** Bound it by the
   next code landmark. A fixed window fails the moment someone adds a comment,
   which is exactly the brittleness the user warned about.


## 6. Map of the code

| File | Role |
|---|---|
| `src/core/LiveBrowser.ts` | the session: tabs, nav, input, dialogs, downloads, auth, recovery. `LiveBrowserManager.rebuildAll()` at the bottom |
| `src/core/BrowserStreamServer.ts` | the WS protocol — 39 commands. **Field names here must match `browser-view.js` exactly** (§2.4) |
| `src/core/BrowserInput.ts` | `buttonsMask`, `modifierMask`, `normalizeButton` — see §4.1 hypothesis 1 |
| `src/core/SelfHeal.ts` | `reloadExtensions(report, onSwap)`; `HealStep = { key, state, index, total, etaMs? }` |
| `src/core/RealChrome.ts` | persistent headed Chrome, `--load-extension`, `extensionPageUrl()` |
| `src/core/RemoteDownloads.ts` | token minting, `GET /browser/downloads/:token`, 256MB cap |
| `src/Routes/browser.routes.ts` | `setLiveSessionRebuilder` / `swapLiveSessions` |
| `src/index.ts` | **CRLF line endings** — preserve them when editing |
| `public/js/browser-view.js` | the whole client UI (~125KB) |
| `public/js/icons.js` / `i18n.js` | 105 icons; parallel fa/en dictionaries |
| `tools/probe-live-parity.js` | **the arbiter of truth** |
| `tools/fixture-server.js` | pages the probe drives, port 3111 |
| `tools/bvclient.js` | scriptable `/browser/ws` client |
| `docs/MEASURED-DECISIONS.md` | every earlier verdict with its evidence |

Measured CDP facts worth not re-discovering: `page.on('download')` fires but
`context.on('download')` **never** does. `Page.startScreencast` is **delta-based**
— a static page emits one frame then nothing, so "no frames" is not evidence of a
broken stream. `Emulation.setDeviceMetricsOverride` is real zoom (canvas coords
must be divided by it); `setPageScaleFactor` is pinch only. Extensions load only
in headed Chrome, hence Xvfb.

---

## 7. Commits on this branch

This branch is **one squashed commit** on top of `origin/main` (`9e70b37`):

```
feat(browser): make the simulated browser behave like real Chromium
42 files changed, ~11000 insertions(+), 191 deletions(-)
```

Check the current hash with `git log --oneline -1` rather than trusting a hash
written here — this commit is force-pushed on every amend, so any hash in this
document goes stale the moment it is written. It is pushed, and it is the head of
**PR #24**
(<https://github.com/jalil-ahmadi2/plyr/pull/24>). The PR description carries the
same summary as this document, including the still-open list in §4.2–§4.5.

Earlier in the work there were six intermediate commits (`6acced8` icons/i18n,
`680d2ec`, `0fe3005` client rebuild, `5e37626` never-lose-a-tab, `27b3f22` the two
whole-server crashes, `b00a0fa` the drag/key protocol mismatch). **Those hashes no
longer exist** — the squash replaced them. Do not try to `git show` them; every
change they contained is in `7bb0d85`. They are listed only so that a reference to
one of them in an older note can be recognised.

The branch is kept as a single squashed commit deliberately, per the project's
workflow. If you add work, commit normally and then re-squash onto `origin/main`
before updating the PR:

```bash
git fetch origin main
git rebase origin/main          # resolve conflicts preferring remote
git reset --soft origin/main && git commit -m "…"
git push -f origin genspark_ai_developer
```

**Build state at the end of that commit:**

* `npx tsc --noEmit` — clean
* `npx tsc` — success, `dist/index.js` 32497 bytes
* `npx vitest run` — **50 files / 1157 tests, all passing** (21.0 s)
* `npx vitest run tests/unit/browser-tabs.test.ts` — 65 / 65
* `DISPLAY=:99 node tools/probe-live-parity.js` — **69 / 69, 0 failed**
* all 8 `tools/*.js` — `node --check` OK

**Build state at the end of the §4.3b session (2026-08-03), all re-measured after
the four fixes and against a freshly built `dist/`:**

* `npx tsc --noEmit` — clean
* `npx vitest run` — **51 files / 1185 tests, all passing** (22.6 s)
* `npx vitest run tests/unit/toolbar-controls.test.ts` — 28 / 28, and
  **8 / 8 mutants killed** when each fix was deliberately reverted
* `DISPLAY=:99 node tools/probe-ui-controls.js` — **30 / 30, exit 0**
* `DISPLAY=:99 node tools/probe-live-parity.js` — **69 / 69, 0 failed**
* `node --check` on every touched client file — OK
