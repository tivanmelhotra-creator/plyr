# HANDOFF — six problems reported 2026-08-03 (§2 §1 §4 FIXED · §3 §6 §5 open)

> ## ⚠️ THIS FILE HAS BEEN PARTLY SUPERSEDED — read the continuation brief first
>
> A later session implemented three of the six items. **Current status:**
>
> | Item | Status | Commit |
> |---|---|---|
> | **§1** stuck heal panel | ✅ **FIXED** — probe 25/25, 37 unit tests | `05f5ee7` |
> | **§2** tabs lost on extension install | ✅ **FIXED** — probe 13/13, 19 unit tests | `7b53fc5` |
> | **§3** remote upload + download | ⬜ **NOT STARTED** | — |
> | **§4** remote clipboard | ✅ **FIXED** — 20/20 + 13/13, 28 unit tests | `00a0a80` |
> | **§5** light remote-desktop mode | ⬜ **NOT STARTED** | — |
> | **§6** picker minimize | ⬜ **NOT STARTED** | — |
>
> **→ `docs/HANDOFF-SESSION-CONTINUATION.md` is the authoritative record of where
> the work stands, what was measured, and how to continue.** Where the two files
> disagree, that one wins — it was written after measuring against a running server.
>
> **Two corrections to the text below, both established by live measurement:**
>
> 1. **§4b (the leading hypothesis for §4) is FALSE.** The clipboard permission
>    grant does *not* get lost on recovery. Struck through in §4 below. Do not
>    act on it.
> 2. **§5 has no removed implementation to restore.** `git log -- src/core/Desktop.ts`
>    has only 2 commits and `git log -S "light"` on it returns nothing, so §5's
>    "search history first" step is closed and §5 is **new work**, not a restoration.
>
> Everything else below still stands, and §3 / §6 / §5 remain the specs to implement.

---

**Status when originally written: investigation only. No product code was changed
for these six items.** The user had very little credit left and asked explicitly:

> «البته به جای انجام برو بررسی کن و راه کار هاشو روی یک md ثبت کن تا جلسه بعدی
> انجامش بدیم چون اعتبار کمی برای امشب مونده»
> …
> «فقط در نظر بگیر که درگیر دیباگ و تست نشی و هر موردی اضافه رو یادداشت کن تا
> همراه pr ذخیره بشه در گیتهاب»

So this file is the deliverable: root causes located in real source, with a fix
plan per item. **The next session should read this file first and then implement.**

---

## 0. Read this before touching anything

### 0.1 Bring the environment up (it does NOT survive a sandbox reset)

```bash
cd /home/user/webapp
bash scripts/dev-server.sh          # redis 6379 + Xvfb :99 + node dist/index.js on 3000
```

**Trap that has already cost this project real time:** the server runs `dist/`,
not `src/`. After editing `src/` you must `npx tsc` **and** re-run
`bash scripts/dev-server.sh`, or you are measuring the old binary.

`.env` is gitignored. It survives on disk but is lost on a sandbox reset; §0 of
`docs/HANDOFF-BROWSER-PARITY.md` has its four lines.

### 0.2 The verification mandate still applies

From `docs/HANDOFF-BROWSER-PARITY.md` §1:

> «هر ادعا را با تست زنده روی سرور در حال اجرا ثابت کن، نه با grep روی سورس»
> — prove every claim with a live test against the running server, not by
> grepping the source.

**The previous session proved why this matters.** It audited the toolbar buttons,
found the wiring correct, wrote *"do not fix it blind"* — and four real bugs were
living behind that correct wiring, invisible because reading source cannot find a
listener that is never reached. See `docs/HANDOFF-BROWSER-PARITY.md` §4.3b.

**Therefore: the root causes below are located but NOT all live-proven.** Each item
is marked with how strong its evidence is. Do not treat a `LOCATED (source)` item as
established fact until you have reproduced it against the running server.

### 0.3 Do not break the things that now work

The user was explicit:

> «حواست باشه بقیه رو صدمه نزنی مثل الان که بعضی موارد کار نمکنه»
> — be careful not to damage the rest, as has just happened.

That is a fair complaint: items 3, 4 and 5 below are things that **used to work**.
Before you start, capture the baseline; after each change, re-run it:

```bash
npx vitest run                                   # expect 51 files / 1185 tests
DISPLAY=:99 node tools/probe-live-parity.js      # expect 69/69
DISPLAY=:99 node tools/probe-ui-controls.js      # expect 30/30
npx tsc --noEmit                                 # clean
```

### 0.4 Project rules that apply to every change here

* **R4 git workflow** — branch `genspark_ai_developer`; commit after every change;
  fetch + rebase `origin/main`; **squash into one commit**; force-push; open/update
  the PR; **hand the user the PR link.**
* **R5 i18n parity** — every new key must exist in **both** `fa` and `en`; a test
  asserts it. Never put an English sentence on the wire: the server sends a stable
  KEY and the client translates, or the whole panel becomes untranslatable.
* **R5 line endings** — `public/**` is LF; `src/**` is generally CRLF but files
  touched recently are LF. **Check with `file <path>` before editing.** Note
  `src/index.ts` is CRLF and `src/core/LiveBrowser.ts` is LF.
* **CSP is a constraint to design within, not to weaken.** `img-src 'self' data:`
  in `src/index.ts`. Item 4's favicon fix went *around* it deliberately; do not
  "solve" anything here by widening it.

---

## 1. The picker gets stuck on "Getting the browser ready / Starting Chrome"

> ✅ **FIXED — commit `05f5ee7`.** All five fix-plan points landed (lease, honest
> ETA, dismiss control, resume-on-reopen, icon audit), plus a sixth defect the
> investigation missed: **`#bvp-restart` was left `disabled` forever**, because the
> handler re-enabled it only in a trailing `.then()` that never runs for a promise
> that never settles — so the bug removed the one control that could have recovered.
> The `power` glyph complaint was real: `icons.js` aliases `close: 'power'`, so that
> symbol already means "shut down" here; changed to `repeat`. Real restarts measured
> at **462–1315 ms**, against an invented `etaMs: 6000`.
> Proof: `tools/probe-heal-panel.js` **25/25** + `tests/unit/heal-panel-stuck.test.ts`
> (37 tests). Details: continuation brief §5.2.

### What the user reported

Opened the simulated browser from a node's crosshair icon, pressed the **off / power
button**, and got:

```
Getting the browser ready
Starting Chrome
about 6 seconds
This happens by itself — nothing for you to do.
```

…and it **stuck there**. Not understanding what it meant, they closed the modal and
reopened it from the same node — and could not connect, apparently stuck the same
way. In their words:

> «باید حداقل نیاز به زمان داره اطلاع بده یا خلاصه اگر نیازه ترمیم بشه ترمیم بشه
> خلاصه کاربر نباید گیر کنه»
> — at minimum it must say how long it needs, and if it needs healing it should
> heal; the bottom line is **the user must never get stuck.**

### Root cause — LOCATED (source), high confidence

`public/js/browser-view.js`:

| Line | What is there |
|---|---|
| 1863 | `function showHeal(steps)` — renders the checklist |
| 1905 | `function hideHeal()` — hides it |
| 1986 | `hideHeal()` — called on a server frame |
| 2482 | `showHeal([{ key:'startingChrome', state:'running', …, etaMs: 6000 }])` |
| 2490-2491 | on success: `showHeal(r.steps)` then `setTimeout(hideHeal, 1800)` |
| 2502-2504 | on failure: `showHeal([… state:'failed' …])` then `setTimeout(hideHeal, 6000)` |

**The panel is opened optimistically at line 2482, before the request is sent** —
which was a deliberate and good decision (an empty-but-visible panel answers "yes,
something is happening"). The `etaMs: 6000` is a **hard-coded guess**, not a
measurement, which is where "about 6 seconds" comes from.

The bug is the same class as the spinner bug fixed in §4.3b of the parity handoff:

> **`showHeal` has no lease.** It is only ever taken down by an explicit later
> event: the `.then`, the `.catch`, or a server frame at line 1986. If the POST
> never settles — socket dropped mid-flight, the page suspended, the server
> restarting Chrome and dying, the modal closed and reopened while a relaunch is
> still in flight — **nothing takes the panel down.** It sits there claiming
> "about 6 seconds" forever, and it is `role="status"` over the canvas, so the
> user reads it as "the app is stuck".

Second, compounding cause: **the ETA counts down from a fixed 6000 ms and is never
reconciled with reality.** Once 6 s have passed the panel is actively lying, which
is exactly what destroys trust in a progress indicator.

Third: **reopening the modal does not resume anything.** `closePick()` tears down
`pickState`; a relaunch still running server-side has no way to re-announce itself
to the new modal, so the second open looks dead too — precisely what the user saw.

### Fix plan

1. **Give `showHeal` a lease, exactly like `setNavBusy`.** Reuse that shape — it is
   already proven and already unit-tested:
   * arm a timer on every `showHeal(...)`;
   * clear it in `hideHeal()` and in `closePick()` (the parity handoff records why:
     a lease that outlives its modal fires a toast about a window that is gone);
   * on expiry, take the panel down, set a real status, and **tell the user what to
     do next** — a new i18n key (`bvp.healLost`, fa + en) in the same voice as
     `bvp.navLost`: *"no answer came back — press Reconnect."*
   * two phases again, and for the same reason one timeout cannot serve both: a
     short wait for the POST to be *acknowledged*, a longer one while Chrome is
     genuinely relaunching. Reconcile the long phase with the server's own timeout
     rather than inventing a number.
2. **Stop hard-coding `etaMs: 6000`.** Either have `/browser/restart` return a real
   measured ETA (SelfHeal already reports steps with timings — see
   `src/Routes/browser.routes.ts` ~line 171, "finished checklist"), or drop the
   number and show an indeterminate state. **A wrong ETA is worse than none**: at
   t=20 s a panel saying "about 6 seconds" has taught the user the app is broken.
3. **Make the panel dismissible.** It is `role="status"` with no close affordance.
   Even with a lease, the user must be able to get out from under it — otherwise the
   design still relies on the happy path. Add a close/dismiss control that leaves
   the operation running but returns the canvas.
4. **Make a reopened modal resume the truth instead of guessing.** On `connect()`,
   ask the server for the current heal state (or have the server push it on attach)
   so the second open shows either real progress or a clean, actionable error. This
   is the actual "user got stuck" fix; the lease only bounds the damage.
5. **Audit the off/power button itself.** The user pressed *off*, not *restart*, and
   got a *starting Chrome* checklist. Either that is a mislabelled control or the
   wrong handler is wired — check what `#bv-picker` / the off button does versus
   `#bvp-restart` (line 2473). **Live-verify this one**, because §4.3b is the
   standing proof that this exact class of thing reads as correct in source.

### How to prove it is fixed

Extend `tools/probe-ui-controls.js` — it already has the WebSocket tap that can
**swallow a command on the wire**, which is exactly the reproduction needed here:
drop the restart POST / its response and assert the panel comes down by itself with
an actionable message. That tap is how the spinner bug was proven; reuse it rather
than writing a new instrument.

---

## 2. Installing an extension loses ALL tabs — the most serious item

> ✅ **FIXED — commit `7b53fc5`.** `SELF_CLOSE_GRACE_MS` + a `tabsFrozen` guard in
> `src/core/LiveBrowser.ts` stop a teardown in progress from persisting an empty tab
> list over the good one. A `bvp.tabsRestored` toast was added (fa + en).
> Proof: `tools/probe-restart-tabs.js` **13/13** +
> `tests/unit/restart-tab-loss.test.ts` (19 tests).

### What the user reported

> «وقتی خواستم یه اکستنشن نصب کنم بعد نصب نمیدونم ریستارت شد یا چی، کل تب‌ها گم
> شدن در حالی که نباید گم می‌شدن. نهایتش باید یه رفرش می‌شد، تب فعالی که روش بودم
> رفرش می‌شد، ولی کل تب‌ها برای من گم شدن و این مشکل بزرگیه»

Expected: at worst the active tab reloads. Actual: **every tab disappeared.**

### Root cause — LOCATED (source), high confidence, and the code even documents the intent it violates

The chain:

1. `src/Routes/browser.routes.ts` ~line 315 — extension upload/install. Chrome only
   reads extensions at launch, so the install **must** relaunch Chrome. That is
   correct and unavoidable.
2. It calls `SelfHeal.reloadExtensions(report, onSwap)` with
   `swapLiveSessions` (~line 88) as `onSwap`.
3. `src/index.ts` line 140 registers the rebuilder, with a comment stating the
   intended contract explicitly:

   > *"rebuildAll() re-attaches each session to the fresh browser and reloads its
   > tabs, so an extension install costs the user a progress panel — **never a lost
   > tab**."*

4. `LiveBrowser.ts` line 3116 — `rebuildAll()` maps every session to `s.resync()`.
5. `resync()` finds the page dead (Chrome is new), falls through to
   `recover('resync')`.
6. **`recover()` is where the tabs die.** Reading it:

```ts
if (!this.context || isContextDead(this.context)) {
  this.context = await GlobalBrowser.getInteractiveContext(this.userId, this.vp);
  …
  for (const t of this.tabs) { t.page = null; t.pending = true; t.dead = false; }
  …
}
let target: LiveTab | null = this.findTab(this.activeId) || null;
…
this.activeId = target.id;
const ok = await this.materialize(target).catch(() => false);
…
await this.focus(target);
```

`recover()` **only materializes `target` — the single active tab.** Every other tab
is left `pending: true` with `page: null`. Nothing in this path ever re-materializes
them. So `rebuildAll()` does exactly half of what `index.ts` promises: the session
comes back, on one tab.

Then the kill shot — `persistTabs()` (line 1470):

```ts
const list: SavedTab[] = this.tabs
  .filter((t) => !t.dead)
  .map(…)
```

`recover()` is followed by `focus(target)`, and `focus()` ends with
`emitTabs()` / `persistTabs()` (that `emitNavState()` call added in §4.3b is at the
end of the same function). Any path that drops a tab from `this.tabs` — e.g. the
`if (!ok)` branch, `this.tabs = this.tabs.filter((t) => t !== dead)` — is then
**written to disk**, overwriting the good saved list. The on-disk backup that could
have restored the tabs is destroyed by the very failure it should protect against.

So there are two distinct defects:

* **2a.** `recover()` restores one tab, not the tab set. The `pending` flag exists
  for lazy materialization, but nothing re-materializes them after a context swap.
* **2b.** `persistTabs()` will happily persist a *shrunken* list produced by a
  failed recovery, so the loss becomes permanent.

### Fix plan

1. **Make `recover()` restore the whole tab set, not just the active one.** The tab
   objects survive (URL + title are in `this.tabs`); what is missing is re-creating
   their pages. Materialize the active tab **first** (the user is looking at it),
   then the rest — lazily is fine, as long as the chips are present and clicking one
   materializes it. Losing a *page* is recoverable; losing the *list* is not.
2. **Make `persistTabs()` refuse to shrink the saved list during a recovery.** A
   recovery in progress is precisely when the in-memory list is least trustworthy.
   Options, in order of preference:
   * skip persisting while `this.recovering` is set (cheapest, and mirrors the
     existing `if (this.closed) return` guard on the same function);
   * or write only *growth* until the recovery reports success;
   * or keep a `.tabs.json.bak` generation so a bad write is survivable.
   Whichever you pick, **the saved list must never be destroyed by the failure it
   exists to survive.**
3. **Tell the user what happened.** An extension install that relaunches Chrome
   should say so — the progress panel from item 1, then "3 tabs restored". Silence
   is what made this feel like data loss rather than a reload.
4. **Check `clearTabs()` is not on this path at all.** It exists for "forget this
   browser session" and must never be reachable from an extension install.

### How to prove it is fixed

This is a protocol-level behaviour, so `tools/probe-live-parity.js` is the right
instrument (it already covers tab commands, and the parity handoff records the
`soloTab()` state-pollution lesson):

1. open 3 tabs at distinguishable fixture URLs;
2. install the local stand-in extension (see §4.2 of the parity handoff — do **not**
   burn the session retrying the Web Store);
3. assert **3 tabs** come back, that the previously-active one is active, and that
   `profiles/sessions/*.tabs.json` still lists 3.

Add a unit test too: a poisoned/shrunken tabs file is already a known-good
regression fixture per §4.4 of the parity handoff.

---

## 3. Remote upload is broken (it used to work)

> ⬜ **NOT STARTED — this is the next item to implement.** The spec below is intact
> and its two failure modes are already curl-reproduced, so start from Step 0 of the
> fix plan (read the *status code*: 401 = 3b, "not valid JSON" = 3a).
>
> **One correction:** the limits disagree **three** ways, not two — global
> `express.json` `'20mb'` (`src/index.ts` 70 / `src/config.ts` 356), `/browser/uploads`
> `MAX_UPLOAD_BYTES` = **32 MB** (`browser.routes.ts` 612 / `RemoteUploads.ts` 50),
> and `/browser/extensions` a literal `'64mb'` (`browser.routes.ts` 322). Reconcile to
> one source of truth and surface it in the error. Download shelf is at
> `browser.routes.ts` ~662. See continuation brief §7.1 for the worked plan.

### What the user reported

> «رفتم یه چیزی آپلود کنم، قبلاً درست کار می‌کرد ولی الان آپلود خراب شده. آپلود
> ریموت که من به پروژه که روی سرور است از ویندوزم فایل آپلود می‌کردم، قبلاً — الان
> نمی‌شه.»

And the requirement, which is broader than the bug:

> «اگر از روی خود سرور که خب نیازی نیست ریموت باشه، ولی اگر مثل من از یه فضای
> غیر لوکال فایل آپلود می‌کنم ریموت باشه آپلود. و همچنین دانلود هم همینطور. باید
> خود برنامه تشخیص بده که ارتباط ریموته یا لوکال.»
> — the program itself must detect whether the connection is remote or local, for
> **both** upload and download.

### Root cause — TWO failure modes, both LIVE-PROVEN against the running server

Measured with curl against `http://localhost:3000/browser/uploads`:

```
# correct content-type, no key:
{"success":false,"error":"Authentication required",
 "hint":"Provide the API_TOKEN via x-api-key header, api_key query param, or Bearer token"}

# json content-type (i.e. if anything sets it):
{"success":false,"error":"Unexpected token 'H', \"HELLOBYTES\" is not valid JSON"}
```

**3a — the global JSON body parser sits in front of the raw upload route.**
`src/index.ts` line 70:

```ts
app.use(express.json({ limit: config.MAX_REQUEST_BODY_SIZE }));   // '20mb'
```

This is registered **before** the browser router, whose upload route declares its
own parser (`browser.routes.ts` line 606):

```ts
express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })
```

`express.json()` only claims `application/json`, so the octet-stream path *should*
pass through — and it does. **But the JSON parser's `20mb` limit and the raw route's
`MAX_UPLOAD_BYTES` are two different numbers governing the same endpoint**, and any
request that arrives with a JSON content-type is consumed and rejected as malformed
JSON before the raw parser is ever reached. The second curl above is that failure,
reproduced. Verify which content-type the client actually sends in the failing flow
before fixing — `remote-io.js` line 91 sets `application/octet-stream`, but
`public/js/api.js` line 41 sets `application/json` **whenever `opts.body` is
defined**, so any upload that goes through `window.API` instead of `RemoteIO`'s own
`fetch` hits exactly this.

**3b — the API key is read from `localStorage` and may simply be absent.**
`public/js/api.js` line 13:

```js
function getKey() { return localStorage.getItem('ab_api_key') || ''; }
```

and `remote-io.js` line 93 forwards `window.API.getKey()`. `/browser` is behind
`asyncAuthMiddleware` (`src/index.ts` line 245) — confirmed live: `/browser/extensions`
also returns `Authentication required`. So on a browser profile where that key was
never stored, cleared, or stored under a different origin (**http vs https, or a
different host — which is exactly the "from my Windows machine" case**), every
upload 401s. The user's flow is remote by definition, so it is the flow most likely
to have no key.

Note this is also consistent with "it used to work": nothing about the upload code
needs to have changed for it to break — a cleared `localStorage` or a changed origin
is enough.

### Fix plan

1. **Live-reproduce first, from the actual UI**, and read the *status code* and the
   *content-type actually sent*. The two failure modes above are distinguishable:
   401 = item 3b, "not valid JSON" = item 3a. Do not fix both blind.
2. **3a:** either scope the global JSON parser so it cannot shadow the upload route
   (mount it per-router, or skip it for `/browser/uploads`), or ensure the client
   never sends a JSON content-type for binary bodies. Prefer **both**: the server
   must not depend on the client sending the right header.
   **Reconcile the two limits** (`MAX_REQUEST_BODY_SIZE` = `'20mb'` vs
   `MAX_UPLOAD_BYTES`) and surface the real limit in the error, so a too-large file
   says so instead of failing as malformed JSON.
3. **3b:** make a missing/rejected key an **actionable** error in the UI, not a
   silent failure — "no API key stored for this origin; paste your token" with a
   route to fix it. A 401 that reaches the user as "upload failed" is the same
   silence-instead-of-cause failure the whole RemoteIO module was written to remove
   (see its header comment).
4. **The remote/local detection the user actually asked for.** Today `RemoteIO`
   assumes remote and there is no detection anywhere (`grep` for
   `isRemote|localhost|127.0.0.1` in `public/js/remote-io.js` returns **nothing**).
   Decide the rule and write it down:
   * the browser being streamed is **always** on the server, so "local" can only
     mean *this page is being viewed on the same machine as the server*;
   * detect it honestly — compare the page origin's host against the server's own
     view of itself (add a field to `/health` or the session attach payload); do
     **not** infer it from `location.hostname === 'localhost'`, which is wrong for
     port-forwarded, tunnelled and container setups (exactly this sandbox);
   * when local, a direct path is legitimate; when remote, bytes must travel.
     **Default to remote when unsure** — remote-mode on a local box is merely a
     copy, local-mode on a remote box is a broken feature.
5. **Do the same for download.** The download shelf is at `browser.routes.ts` ~line
   645 ("Same identity rule as `/browser/uploads`, and for the same reason"). The
   user asked for both directions; fixing only upload will read as half-done.

---

## 4. Remote copy / paste is broken (it used to work)

> ✅ **FIXED — commit `00a0a80` — BUT THE ROOT CAUSE BELOW WAS WRONG.**
> §4b was disproved live (**20/20**); see the struck-through block below for the
> measurement. The actual defect was that a failure never named its cause and threw
> away text that had already crossed the machine boundary. Fixed in
> `public/js/remote-io.js` with `{ok, reason}`, a distinct message per reason
> (`rio.copyInsecure` / `rio.copyDenied` / `rio.copyNoApi`) and a manual-copy
> fallback box built with DOM calls (never `innerHTML` of remote text).
> Proof: `tools/probe-clipboard.js` **20/20**, `tools/probe-clipboard-ui.js` **13/13**,
> `tests/unit/clipboard-reasons.test.ts` (28 tests). Details: continuation brief §5.3.

### What the user reported

> «قبلاً می‌تونستم ریموت کپی یا پیست کنم ولی اینم خراب شده»

### Root cause — LOCATED (source), medium confidence; needs live reproduction

`public/js/remote-io.js` lines 45-76 already handles the well-known trap, and its
comment is worth keeping:

```js
/**
 * navigator.clipboard is unavailable on plain http:// origins (a self-hosted
 * server on a LAN is exactly that), so the execCommand path is not legacy
 * cruft — it is the only path that works for a large share of this project's
 * deployments.
 */
```

So `writeLocalClipboard` degrades to `execCommand('copy')`. That covers **writing**.
The suspects for the reported breakage, in order:

* **4a — reading.** Paste needs the *local* clipboard read, and there is no
  `execCommand` fallback for reading (there cannot be). On a non-secure origin
  `navigator.clipboard.readText` is unavailable, so paste can only work via a real
  `paste` event. Check that the handler is bound to an element that can actually
  receive one, and that the canvas being focused does not swallow it.
* ~~**4b — permissions after a context rebuild.** `LiveBrowser.recover()` calls
  `grantPermissions(['clipboard-read','clipboard-write'])` **only inside the
  `isContextDead` branch**. Any recovery that does *not* rebuild the context skips
  it. If a rebuild happened without that grant, remote clipboard reads fail — and
  this ties item 4 to items 1 and 2: *the extension install / restart is plausibly
  what broke it.* That would explain "it used to work" without any clipboard code
  having changed.~~
  > **❌ DISPROVED BY LIVE MEASUREMENT — this does not happen.**
  > `tools/probe-clipboard.js` tests both directions in three phases — fresh, after
  > a `resync` (**the exact case predicted to fail**), and after a real
  > `/browser/restart` — and returns **20/20**. Permissions survive every recovery
  > path. The proposed one-line fix would have changed nothing while the real defect
  > shipped untouched. `tests/unit/clipboard-reasons.test.ts` now pins this negative
  > result, so a future regression in the grant would be caught by a test rather
  > than by re-deriving this hypothesis.
  >
  > **The real defect was diagnostic, not functional:** `writeLocalClipboard`
  > returned a bare `false` for three situations with three different remedies
  > (insecure origin / user-denied / no clipboard API), so the UI could only say
  > "Could not write to your clipboard" — **and it discarded text that had already
  > crossed the machine boundary.** Fixed with an `{ok, reason}` result, a message
  > per reason, and a manual-copy fallback box. See the continuation brief §5.3.
* **4c — `document.execCommand` is deprecated** and removal is a live risk in new
  Chrome. Worth confirming which side is actually failing before assuming this.

### Fix plan

1. **Reproduce and localize first — which direction fails?** Copy-from-remote and
   paste-into-remote are different code paths with different browser constraints.
   The transcript says "copy or paste", which is ambiguous.
2. **Report the reason instead of failing silently.** `legacyCopy` returns a bare
   `false` (line 75) and `writeLocalClipboard` resolves `false` — a caller that
   ignores it produces exactly "it's broken" with no cause. Surface a real message,
   in both languages.
3. ~~**Move the permission grant out of the `isContextDead` branch** so every recovery
   path re-grants it. It is idempotent and cheap; making it conditional is what lets
   a recovered session come back subtly less capable than it started. **This is my
   leading hypothesis and it is the cheapest thing to verify.**~~
   **→ Verified and NOT the cause (20/20). Not changed.** Item 2 above turned out to
   be the whole fix. Worth keeping as a lesson: the cheapest hypothesis to verify is
   not the same thing as the likeliest, and it was right to verify before editing.
4. **If the origin is not a secure context, say so once, clearly**, with the
   remedy (serve over https, or use the localhost exemption). Silent degradation on
   http:// will keep generating this same report forever.

---

## 5. Bring back the "light" remote-desktop mode (browser only, no Ubuntu desktop)

> ⬜ **NOT STARTED — and step 1 of the fix plan is now closed.** The history search
> has been done: `git log -- src/core/Desktop.ts` has **2 commits**, neither adds or
> removes a light/auto mode, and `git log --all -S "light"` on that file returns
> **nothing**. So there is nothing to restore — **§5 is new work.**
>
> The owner also clarified the target: the view must show **the actual
> Playwright-driven Chromium that automation drives**, for **diagnosis** («ریموت
> مستقیم به پلی رایت»). Mind the constraint that `RealChrome` owns **one shared
> persistent context** — the light view must attach to that Chrome, never spawn a
> rival. A far cheaper alternative that answers the same underlying question ("are my
> tabs still alive?") is a server-side tab-count + URL readout — consider offering it
> first. See continuation brief §7.3.

### What the user reported

> «قبلاً ما دسترسی ریموت به مرورگر اصلی هم داشتیم ولی متأسفانه به جای لایت که فقط
> مرورگر رو بالا میاورد، دیفالتش اتو بود که اوبونتو باز می‌شد بعدش مرورگر داخلش
> بالا میومد که برام مناسب نبود. ولی لایتش که مستقیم فقط مرورگر رو بالا میاورد
> حداقل می‌تونستیم ببینیم پشت صحنه چه خبره.»

And the reason it matters — it is a **diagnostic** need, not a preference:

> «چون الان نمی‌دونم وقتی گم می‌شه یا ریستارت می‌شه تب‌های اصلی هنوز فعالن پس
> زمینه یا نه»
> — when tabs are lost or something restarts, they cannot tell whether the real
> tabs are still alive behind the scenes.

**Note how this connects to item 2:** the light mode is how the user would have
diagnosed the lost tabs themselves. Restoring it has value beyond convenience.

### Root cause — LOCATED (source): there is no mode switch at all

`src/core/Desktop.ts`:

* line 46: `export type DesktopComponent = 'xvfb' | 'x11vnc' | 'novnc';`
* line 380: `novncPath: '/vnc.html?autoconnect=1&resize=remote'`
* the stack is Xvfb → x11vnc → websockify (line 227), exporting **the whole
  display**.

`grep` for `light|auto|mode` in that file returns only the `autoconnect=1` in the
noVNC URL — i.e. **there is no light/auto concept in the current code.** Whatever
the user remembers has either been removed or was a different entry point. Nothing
here bare-launches a browser window as the only client of the display.

So: this is a **restoration/feature** item, not a regression to bisect. Check
`git log -- src/core/Desktop.ts` for a removed mode before rebuilding it from
scratch — recovering the old implementation is cheaper and less risky than a
redesign, and it will match what the user remembers.

### Fix plan

1. **Search history first** for a removed light mode; prefer restoring it.
2. If it must be rebuilt: with x11vnc exporting a whole display, "light" means
   *nothing else on that display* — no window manager, no desktop, just Chrome
   sized to the display so it fills the frame. That is a launch-composition choice,
   not a VNC choice.
3. **Make the mode explicit and remembered** (`light` | `auto`), with **`light` as
   the default**, since that is what the user wants and it is strictly cheaper.
4. **State the honest caveat in the UI:** the light view shows the *real* Chrome
   display. The picker streams a page from that same Chrome, so what the user sees
   is the truth — but a `data:`/`about:blank` tab looks alarming while perfectly
   healthy. A one-line explanation prevents the next false bug report.
5. **Related, and worth doing with item 2:** expose a plain "what is actually open
   right now" readout (real tab count + URLs, server-side truth). That answers the
   user's underlying question without needing VNC at all, and it is far cheaper.

---

## 6. Make the element picker minimizable

> ⬜ **NOT STARTED.** Spec below is intact. Anchors verified for the minimap pattern
> to copy: `public/js/flow-editor.js` header `.fe-mm-head` ~4198-4211, close button
> `data-mm="close"` 4201, restore chip `'fe-mm-restore'` 4219, toggle
> `setMinimapOpen()` ~4297, view-preference flag `minimapOpen` 149; contract tests in
> `tests/unit/canvas-chrome.test.ts` item F ~161-232. Anchor text rendered at
> `browser-view.js` **line 1205**. Icon: `chevron-down`/`chevron-up` are registered —
> **do not use `x`/`close`, which alias to `power`** (see §1). Note `closePick()` now
> also destroys the heal lease and `healEtaTimers`, so the minimize-vs-teardown
> distinction matters more than when this was written. See continuation brief §7.2.

### What the user reported

> «این pick elementor هم دست‌وپاگیره. می‌خوام مواقعی که نیاز نیست بشه مینی‌مایزش
> کرد که بره کنار این نوشته بالای تب بار مرورگر، مینی‌مایز بشه با آیکن مناسب»
> `Saved session restored`

So: a minimize control that collapses the picker panel to a chip **next to the
"Saved session restored" line above the tab bar**, with a suitable icon.

### Current state — LOCATED (source): no minimize exists

* `grep "minimize|minimiz|bvp-min|collapse"` in `public/js/browser-view.js` →
  **no matches.** Nothing to fix; this is new UI.
* The anchor text the user pointed at is `bvp.sessionSaved` —
  `public/js/i18n.js` line 1726 (`'Saved session restored'`), with the explanatory
  `bvp.savedNote` at line 1913.

### Fix plan

1. **There is a proven pattern in this codebase — reuse it, do not invent one.**
   The minimap does exactly this: a titled header with a close `[x]` that collapses
   the widget to a **restore chip**. See item F in `tests/unit/canvas-chrome.test.ts`
   and `public/js/flow-editor.js`. Matching it gives consistent behaviour, icons and
   i18n shape for free, and that test file documents the contract.
2. Collapse to a chip beside the `bvp.sessionSaved` line, per the request.
3. **Minimize must not tear down the session.** `closePick()` destroys `pickState`,
   the WebSocket, and (after item 1) the heal lease. Minimize must keep all of it
   alive — it is a *view* state, not a lifecycle state. Getting this wrong would
   turn a convenience into a data-loss bug, so unit-test the distinction.
4. Two i18n keys (`fa` + `en`): minimize, and restore.
5. Pick the icon from the existing registry and **verify the name resolves** — the
   registry silently renders a `dot` fallback for a typo, which is invisible in
   review. `canvas-chrome.test.ts` already asserts this for other icons; copy that
   assertion.
6. Add `aria-expanded` / a real label, and keep it keyboard reachable.

---

## 7. Suggested order for the next session

> **Progress against this plan:** rows 1, 2 and 4 (**§2, §1, §4**) are **done**. The
> remaining order is **§3 → §6 → §5**, exactly as the table below has it. Note that
> row 4's premise ("plausibly caused by §2, so re-test after §2 lands — it may already
> be fixed") was tested: §4 was **not** fixed by §2, and its documented cause was
> false. Row 6's premise ("its diagnostic value drops once §2 is genuinely fixed")
> now holds, which is why §5 stays last.

Dependencies first, cheapest-and-highest-value first:

| # | Item | Why this position |
|---|---|---|
| 1 | **§2 tabs lost on extension install** | The user called it «مشکل بزرگیه». Data loss beats everything, and the fix (`recover()` + `persistTabs()` guard) is well localized. |
| 2 | **§1 stuck heal panel** | Same "user is stuck with no way out" class; the lease pattern is already proven in `setNavBusy`, so it is cheap. Also, §1 and §2 are the two halves of one bad restart experience. |
| 3 | **§3 upload** | Two concrete, live-proven failure modes. Fix 3a/3b first (small), then the remote/local detection (larger, and needs a decision written down). |
| 4 | **§4 clipboard** | Likely one line (the permission grant), and plausibly caused by §2 — so re-test it *after* §2 lands, since it may already be fixed. |
| 5 | **§6 minimize** | Self-contained new UI with an existing pattern to copy. Safe to do any time. |
| 6 | **§5 light desktop mode** | Largest and least certain (may be a restoration). Its diagnostic value drops once §2 is genuinely fixed. |

**Then:** the parity handoff's own queue resumes — §4.2 (J2TEAM install), then §4.3
(screenshots, still the only layer in the §4.4b coverage table with no instrument).

---

## 8. Cross-cutting notes worth keeping

### 8.1 The same bug shape keeps recurring: optimistic state with no lease

Three instances so far:

| Where | Symptom | Status |
|---|---|---|
| `navBusy` (nav spinner) | spun forever on a dropped command | **fixed** — §4.3b, two-phase lease |
| `showHeal` (heal panel) | stuck on "about 6 seconds" | **item 1 above** |
| tab list during recovery | one tab survives, the list is overwritten | **item 2 above** |

The rule this project has arrived at, worth stating as a standing invariant:

> **Any state set optimistically on a user action must expire on its own.** If only
> a later message can clear it, then a lost message is a permanently wrong UI — and
> per the no-restart mandate, the UI must correct itself rather than sit there lying.

Before adding any new optimistic state, ask what takes it down when nothing arrives.

### 8.2 The coverage-shape argument, again

From §4.4b of the parity handoff: **a layer with no instrument is a layer where bugs
survive.** Note where these six reports fall:

* items 3, 4, 5 (upload, clipboard, remote desktop) — **no probe covers any of
  them.** No instrument, and all three are reported broken.
* items 1, 2 (heal panel, tab loss on restart) — the *restart/recovery* path has
  unit tests but has never been forced live end-to-end. §4.4 of the parity handoff
  lists exactly this as still open: *"Tab crash / renderer crash / CDP disconnect
  are handled in code and unit-tested but not yet forced live."*

That is not a coincidence, and it is the second time this prediction has paid off.
**Consider extending the probes as part of these fixes, not after them.** A fix with
no instrument is a fix that will be reported broken again.

### 8.3 Do not trust "the wiring looks correct"

Recorded again because it is the single most expensive lesson in this repo: the
previous session audited the toolbar buttons, correctly concluded the wiring was
fine, and four real bugs were live behind it (§4.3b). For every item above, the
source-level root cause is a **hypothesis to reproduce**, not a conclusion.

### 8.4 An operational trap noticed while measuring

Running the full vitest suite while a probe or a second suite is live starved
`tests/unit/picker-drive.test.ts` (a real-Chromium suite) into three 30 s timeouts —
a resource failure that reads exactly like a product bug. It passed 16/16 in
isolation moments later. **Run the suite on a quiet box before believing a failure in
that file.** Now also recorded in the parity handoff's build-and-test section.

---

## 9. State of the tree as this file is written

*(Historical — the state when this file was first written. For the current state see
§10 below, and `docs/HANDOFF-SESSION-CONTINUATION.md` §9.)*

* Branch `genspark_ai_developer`, one squashed commit `7befaf4` on top of
  `origin/main` (`0c17fe2`), pushed. **PR #26** —
  <https://github.com/jalil-ahmadi2/plyr/pull/26>
* That PR is the §4.3b work (four toolbar bugs + the click-level probe). It is
  **unrelated to the six items above**, none of which have been fixed.
* Measured at that commit: toolbar probe **30/30**, parity probe **69/69**, vitest
  **51 files / 1185 tests**, `tsc --noEmit` clean, zero browser console errors.
* **No product code was changed for items 1-6.** The only change accompanying this
  document is the document itself.
* Server was left running for the user's own review on port 3000.

---

## 10. State of the tree after the implementation session (2026-08-03, later)

* Branch `genspark_ai_developer`. **§2, §1 and §4 implemented** — three commits
  (`7b53fc5`, `05f5ee7`, `00a0a80`) squashed into one for the PR. The hashes are
  recorded here and in the continuation brief because the squash destroys them, and
  they are the only remaining map from a change to the reasoning behind it.
* Measured at `00a0a80`: `tsc --noEmit` **clean**; `DISPLAY=:99 npx vitest run`
  **54 files / 1269 tests, 0 failures**; live probes
  `probe-live-parity` **69/69**, `probe-ui-controls` **30/30**,
  `probe-restart-tabs` **13/13**, `probe-heal-panel` **25/25**,
  `probe-clipboard` **20/20**, `probe-clipboard-ui` **13/13**.
* The `picker-drive` flake documented in §8.4 **did not reproduce** in that full run.
  Treat a lone `picker-drive` failure as suspected flake and re-run it alone — but
  never use "it's flaky" to dismiss a reproducible failure.
* **§3, §6 and §5 have no code and no probes yet.**
* **→ Continue from `docs/HANDOFF-SESSION-CONTINUATION.md`**, which carries the
  environment bring-up, the per-item worked plans with verified line anchors, and the
  extra findings (non-existent `eval`/`insertText` WS commands, the fixture `R(k,v)`
  beacon pattern, the positive-control lesson, the `close: 'power'` icon alias, and
  the three self-inflicted bugs worth not repeating).
