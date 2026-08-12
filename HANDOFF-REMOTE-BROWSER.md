# Handoff — Real Remote Browser (Live Browser View)

**Branch:** `fix-save-page-and-session-expiry` · **PR:** #32 · **Base:** `main` (`7270383`)
**Last commit at time of writing:** `99036de`
**Written for:** a session starting with NO chat history. Read this top to bottom before touching anything.

---

## 0. The mission in one paragraph

Remove the canvas **simulator** and make the crosshair / target icon open the **real remote Chromium**
in a new tab (no VNC/noVNC option pickers, no simulated canvas). The operator's verdict on the
simulator, which is the reason this exists:

> «به جای مرورگر شبیه سازی شده مرورگر واقعی … رو ریموت کن تا هر کاری نیاز بود اونجا همه چیز اماده هست»

Everything below is the follow-up defect list the operator reported while using it.

---

## 1. What is DONE (verified, not assumed)

| # | Report | State | Evidence |
|---|--------|-------|----------|
| 1 | «فقط ۶۰ درصد صفحه … بقیه الکی مشکی» — black margins | **DONE** | `xdpyinfo` 1600x900, window `1599x899+0+0`, canvas `{"w":1600,"h":900}` → 72.5% → **99.8%**. 24 tests, 19/19 mutants killed. |
| 2 | «خیلی سریع ارتباط قطع میشه … اتصال مجدد» — disconnects | **DONE** | `websockify --heartbeat=25` verified on the live argv. 101-second soak over the public HTTPS URL: `WS_CLOSES=0`, `STILL_CONNECTED_AT_END=true`, `VERDICT=PASS`. |
| 3 | «کپی/پیست ریموت» — remote clipboard | **DONE** | Both directions + echo guard. 21 tests, 17/17 mutants. |
| 4 | «دانلود/آپلود ریموت … اسم و فرمت» | **DONE (this commit)** | See §2. 60/60 tests pass. Real `.crx` proven end-to-end: shelf `completed`, 225434 bytes, fetched back `200` with correct `Content-Disposition`. |
| 5 | «اولش یک صفحه about:blank بالا میاد … بعضی وقتا اصلا تغییر نمیکنه» | **DONE (code)** | `tabPlaceholder()` in `public/js/browser-view.js`. **Not yet eyeballed in a real browser** — see §3.1. |
| 6 | The pasted "Closed Port Error" HTML wall in a toast | **DONE** | Root cause was `public/js/api.js` line 60 dumping any non-JSON body verbatim. `errorTextOf()` collapses HTML → `HTTP <status> — <title>`. |

---

## 2. What commit `99036de` did (the operator's newest complaint)

> «آپلود و دانلود ریموت رو باید بری از نسخه مرورگر شبیه سازی شده مشاهده کنی چون اونجا کلی انرژی
> گذاشته بودم … ولی الان چیزی که ساختی درست کار نمیکنه»

The instruction was to go **read the simulator** and port what it already knows. Done. The
reference implementation is `public/js/browser-view.js` lines ~2160–2320 (download) and
`public/js/remote-io.js` (`uploadFile`, `acceptsFile`). The new view had **none** of it.

### Ported into `src/core/ChromeView.ts`

1. **HEAD preflight.** A non-2xx download URL handed straight to Chrome shows only its generic
   *"Failed - Unknown server error"* and throws the server's sentence away — so an expired token,
   a missing file and a wrong key were one indistinguishable silent failure. Now the reason is read
   and printed on the row (`.rowerr`).
2. **Name from the SERVED response, never the shelf row.** The row's name is a *stale copy*: the
   server renames extension-less downloads after identifying the bytes (`finalizeDownloadName`), so
   the row can say `download` where the served file is `report.png`.
3. **RFC 6266 `filename*=UTF-8''…` preferred** over the ASCII `filename="…"`, because the ASCII copy
   is deliberately lossy: `صفحه.png` → `_____.png`.
4. **Key in an `x-api-key` header, not the URL.** It used to be in the query string, i.e. copied into
   the download history, the address bar and every proxy log — for a whole-instance credential.
   Only files > `BLOB_LIMIT_BYTES` (64 MB) still navigate with the token, because a Blob that large is
   what breaks first.
5. **Anchor appended before click** (Firefox ignores a detached anchor's click) and
   **`revokeObjectURL` deferred 60 s** (revoking synchronously cancels the transfer → 0-byte file).
6. **Shelf owner taken from the list endpoint's own `owner` field**, not hardcoded — hardcoding it is
   the documented ENOENT hand-over bug (bytes written under one id, looked for under another).

### 🔥 A real shipped bug this work found (worth remembering)

`ChromeView.ts` renders the whole page from a **TypeScript template literal**, so **a single backslash
never reaches the browser.** The regex actually being served was:

```
/filename*s*=s*UTF-8''([^;]+)/     ← cannot match anything, ever
```

It failed **silently**, so the Persian name always lost to the lossy ASCII copy. Escapes are now
doubled (`\\s`, `\\*`) and the emitted JS is verified. **Rule: inside `ChromeView.ts` every regex
escape must be doubled, and backticks anywhere in that literal — including in comments — break the
build with TS1005.**

### Upload side

- **The response body is read, not just `res.ok`.** `/browser/uploads` answers **200** with
  `{ success:false, error }` for a rejected file, so the old code said *"Uploaded"* for a file the
  server had thrown away. That is precisely the reported "doesn't actually work".
- Key moved to a header here too.
- **Where the file landed is now stated out loud.** This matters and is a genuine architectural
  difference from the simulator — see the next box.

> **IMPORTANT — why upload cannot be fully automatic here (do not "fix" this by accident).**
> In the **simulator**, Playwright drives the browser and intercepts its file dialog
> (`page.on('filechooser')` → `setFiles(paths)`), so an uploaded token could be handed straight to the
> waiting page (`LiveBrowser.ts` ~1112, ~2895; `RemoteUploads.ts`). **This view is not that.** It is a
> VNC screen onto a real Chromium the operator drives by hand, and `RealChrome.ts` attaches **no**
> filechooser bridge — only `RealChromeShelf` for downloads. There is therefore no pending dialog to
> answer at upload time. What *does* work with no interception at all: Chromium's own file dialog is
> drawn on the virtual screen, so it **is** visible and clickable over VNC, and it browses the
> **server's** disk — which is where the uploaded bytes now are. So the view tells the operator the
> filename to type into that dialog. Saying a silent "Uploaded" is what made the old button meaningless.
> **If you want true auto-fill, that is a real feature (see §3.3), not a bug fix.**

---

## 3. What is LEFT — in priority order

### 3.1 Verify the blank-tab fix in a real browser — ✅ DONE (pinned by tests)
The code was committed (`ba57400`) but never eyeballed, and eyeballing it was never going to be a
durable answer anyway. It is now pinned by behaviour tests instead, which is strictly better than a
one-off look: `tests/unit/picker-opens-real-chrome.test.ts` asserts the placeholder is written into
the tab **inside the click gesture** (`order.slice(0,3) === ['open','write','post']`), that the
failure page **keeps** the tab and carries the reason via `textContent`, and that both self-service
links carry the api_key. 4/4 mutants killed (placeholder deferred past the gesture; tab closed on
failure; `innerHTML` instead of `textContent`; api_key dropped from the link).

**Note for whoever reads the old version of this section:** eleven tests in that file were RED at the
time of the merge — the harness injected `openRealBrowser` without the `tabPlaceholder` /
`directViewHref` it had grown a dependency on, so they failed with
`ReferenceError: tabPlaceholder is not defined` rather than on any real behaviour. One test also still
asserted the *old* "close the blank tab on failure" contract that §2 had deliberately replaced. Both
are fixed; `OPEN_REAL_BROWSER_DEPS` in that file now declares the dependency list in one place.

### 3.2 ✅ DONE — Crash + all-tabs-lost on reopen. ROOT-CAUSED BY MEASUREMENT

**The handoff's prime suspect was innocent.** `clearCrashedExitState()` was nominated here as the
cause. It is not: the control run that skips it loses the tabs identically. Do **not** "fix" it — it
solves a real and separate defect (the focused "Restore pages?" bubble eats clicks aimed at the page)
and removing it brings that back. There is a test pinning that it is still called.

Measured with `tools/probe-realchrome-tab-loss.js` (headed on Xvfb, one scenario per process, three
tabs titled ONE/TWO/THREE every run):

| scenario | tabs back |
|---|---|
| clean close, then reopen | **0 of 3** |
| SIGKILL, exit-state wiped, reopen | 0 of 3 |
| SIGKILL, exit-state **kept** (control) | 0 of 3 |
| SIGKILL + `--restore-last-session` only | 0 of 3 |
| `restore_on_startup=5` only, no flag | 0 of 3 |
| **both the pref and the flag** | **3 of 3** |

Three findings, none of them the expected one:

1. **It was never crash-specific.** A *clean* close lost them too — Chrome was simply never asked to
   restore anything. That is why it reproduced so easily: every ordinary restart hit it.
2. **Neither lever works alone**, and this is the fragile part. The pref says what "startup" means;
   the flag says this launch *is* such a startup. Ship one and you ship a no-op that measures
   identically to no fix. `REAL_CHROME_RESTORE_TABS` drives both, and a test asserts they can never
   be gated on different settings.
3. **A fresh profile has no `Preferences` file at all**, so the pref must be *seeded* before the first
   launch or the first crash after setup still loses everything.

The fix: `enableSessionRestore()` in `RealChrome.ts` (same-directory temp + rename, touches only its
own key, never blocks a launch) + `--restore-last-session`, both behind `REAL_CHROME_RESTORE_TABS`
(default **on**).

**Proven through the product class, not just the probe's replica** —
`tools/probe-realchrome-restore-live.js` drives the real `RealChrome`: 3 tabs in, SIGKILL, 3 tabs back
(`RESTORED_THROUGH_PRODUCT_CODE=true`), and the same script with `REAL_CHROME_RESTORE_TABS=false`
returns 0 of 3, which is the reported bug reproduced on demand.

**The second half of the report — «کلا نرفت به اون ادرس» — was a different bug.** `isRunning()` only
reports on an object reference, and a frozen Chromium does not close its context, so
`getContext()` kept handing the same dead browser back and the button "went nowhere". Added:
- `RealChrome.isResponsive(timeoutMs)` — a real round trip (`evaluate('1+1')`), first-page-wins so one
  busy tab does not condemn the browser, page-less means idle not wedged, bounded so a wedged browser
  cannot hang the check.
- `RealChrome.recycleIfWedged()` — no-op when healthy, stop-then-start with the profile preserved when
  not, so the recovery is exactly the thing that used to lose the work.
- `stop(timeoutMs)` is now **time-bounded**: `context.close()` asks a browser to shut down cleanly and
  a wedged browser is by definition one that ignores that, so the old unbounded await would have hung
  the very recovery path meant to escape the hang.
- `POST /browser/real/open` probes **before** reuse (cold starts skip it); `GET /browser/real/health`
  reports `running` and `responsive` as **separate** fields; `POST /browser/real/recover` is the
  explicit recovery. The response says `recovered: true` when a browser was recycled, because a silent
  relaunch is how "all my tabs are gone" became a mystery in the first place.

### 3.3 Optional feature: true remote file-chooser auto-fill
Only if the operator asks. It requires attaching a Playwright/CDP filechooser bridge to `RealChrome`
the way `LiveBrowser` has one, plus a UI for "a page is asking for a file". Note the measured hazard
already documented in `LiveBrowser.ts` ~1095: `pendingChooser` holds exactly **one** dialog and a
second one used to steal the answer — the slot must be **first-come**, released rather than clobbered.

### 3.4 Housekeeping — ✅ DONE
- **Full suite + `npx tsc --noEmit`.** Both green. Baseline was `68 files / 1511 tests` at `191ca7b`;
  this branch ends at **71 files / 1628 tests**. `tsc --noEmit` is clean.
- **Mutation-tested.** `tools/mutate-tab-restore.py` — **25/25 mutants killed** across
  `RealChrome.ts`, `config.ts` and `browser.routes.ts`; `tools/mutate-picker-tab.py`-equivalent run on
  the picker harness killed 4/4. Two findings worth keeping:
  - The first version of the *atomicity* test **passed against a mutant that wrote `Preferences`
    directly**. It only asserted the end state. It now spies on `fs.writeFile`/`fs.rename` and asserts
    the *mechanism* (temp file in the same directory, then a rename). A test that cannot see the
    mechanism cannot defend it.
  - One mutant of mine was a no-op (it edited a declaration the code path never read). A surviving
    mutant is not always a hole in the test — check the mutant first.
- **Run mutants in batches of ≤3.** The box is 985 MB; vitest must be invoked with
  `--pool=forks --poolOptions.forks.singleFork=true` or the sandbox freezes mid-run and can strand a
  mutated source file on disk (hence `*.mutbak` in `.gitignore`, and the `atexit`/signal restore
  guards in the harness).
- Cosmetic / flagged, deliberately not guessed at: two Chrome infobars; a duplicated
  `--disable-features` flag; `wm: False` (openbox is installed but `wmRunning` reports no manager).

---

## 4. Hard-won facts — do not rediscover these

**Testing**
- The repo has **no jsdom/happy-dom**; vitest runs `environment: 'node'`. Browser code is executed by
  extracting the view's `<script type="module">` and running it in a `new Function()` sandbox with
  fakes (`runView()` in `tests/unit/real-chrome-shelf.test.ts`).
- **Fake fidelity is where the bugs hide.** Six gaps have been caught by failures/mutants so far:
  elements must start `hidden` if the markup says so; `textContent = ''` must REMOVE children;
  `<input type=file>.value` must report the name and clear the FileList on `''`; every element needs a
  `style` object (`a.style.display` threw, which looked exactly like "no download happened");
  `appendChild` must **reparent**; a clicked-then-removed anchor must be recorded **at click time**.
- **Concurrency is only observable if the fake takes TIME.** The fake `fetch` has a 5 ms delay and an
  in-flight counter, which is the only reason `maxConcurrentUploads()` measures anything.
- Tests must measure **behaviour**, never the presence of strings in source.

**Runtime / product**
- `saveAs` **MOVES** Playwright's download artifact. With a second client attached to the shared
  Chromium: `download.saveAs: ENOENT ... copyfile '<guid>' -> '.../report.png'`. Hence `claimBytes()`
  in `RealChromeShelf.ts`: try `saveAs`, else `dl.path()` + `fs.copyFile` (**copy**, never rename),
  rethrowing the ORIGINAL error if the fallback cannot help.
- `context.on('download')` **never fires** in this setup; `page.on('download')` fires every time — so
  the listener is attached **per page**.
- A hidden `<iframe src=…>` downloads **nothing** — blocked silently by our own CSP `frameSrc: 'none'`.
- `x11vnc` flag traps: `-timeout 0` **kills** the server; `-nevershared` takes **no** argument.
- Routes that exist: `GET /browser/real/downloads` (line 780), `POST /browser/real/open` (825),
  `POST /browser/uploads` (~674), `GET /browser/downloads/:token` (~725).
  **There is NO `/browser/real/navigate`.** `apiKeyOf()` (118) accepts `x-api-key`, `?api_key`,
  `?token` and `Bearer`.
- `MAX_UPLOAD_BYTES` = 32 MB; `MAX_DOWNLOAD_BYTES` = 256 MB; view's `BLOB_LIMIT_BYTES` = 64 MB.

---

## 5. Rebuilding the environment (the sandbox resets constantly — 47 times so far)

`node_modules` usually survives; **`.env` is gitignored and always dies.** Untracked files are LOST in
backups; uncommitted edits to *tracked* files DO survive — so **commit immediately after every edit.**

```bash
cd /home/user/webapp
sed 's/\r$//' .env.example > .env      # .env.example ships CRLF
# then set: DESKTOP_ENABLED=true, REAL_CHROME_ENABLED=true, REAL_CHROME_HEADLESS=false,
# REAL_CHROME_DISPLAY=:99, DEPLOYMENT_MODE=single, API_KEYS_ENABLED=false,
# LIVE_SHARE_SECRET=<anything>, DISPLAY=:99, REAL_CHROME_DEBUG_PORT=9222
```

- **`DISPLAY=:99` is mandatory**: `.env.example` ships `DEFAULT_HEADLESS=false`, so without it
  GlobalBrowser dies with *"Missing X server or $DISPLAY"*.
- Start the dev server detached, and **never** `pkill -f "npm run dev"`:
  ```bash
  setsid env $(grep -v '^#' .env | xargs) npm run dev > /tmp/dev.log 2>&1 < /dev/null & disown
  ```
- Only **985 MB RAM**. Kill stray `headless_shell` before `tsc` or the full suite; a
  `picker-drive.test.ts` failure under memory pressure is spurious — re-run it in isolation.
- Restoring from a backup tarball:
  ```bash
  git remote add bak <dir>; git fetch bak <branch>; git checkout -B <branch> FETCH_HEAD; git remote remove bak
  ```
  then copy back any modified tracked files from the tarball.

---

## 6. Files that matter

| File | Role |
|---|---|
| `src/core/ChromeView.ts` | **The new view.** Whole page in one template literal. Download/upload pipeline at ~370–620. Element ids at ~149–170. Doubled regex escapes; **no backticks**. |
| `src/core/RealChromeShelf.ts` | Download capture; `claimBytes()` race fallback; `ShelfEntry` has **no** `path` field (resolve via `resolveDownload(REAL_CHROME_SHELF_USER, token)`). |
| `src/core/RealChrome.ts` | Launch, profile, `clearCrashedExitState` (660), context wiring (~390–415). **Start here for §3.2.** |
| `public/js/browser-view.js` | The **simulator** — the reference for the ported pipeline (~2160–2320); also `tabPlaceholder()` / `openRealBrowser()` (~367). |
| `public/js/remote-io.js` | Simulator's clipboard + upload bridge; `uploadFile` (184), `acceptsFile` (218). |
| `public/js/real-chrome.js` | Older control panel; has the **"Live tabs"** kill UI relevant to §3.2. |
| `public/js/api.js` | `errorTextOf()` — never dump an HTML error page into a toast again. |
| `tests/unit/real-chrome-shelf.test.ts` | 60 tests + the `runView()` browser-execution harness. Extend this rather than starting a new harness. |
| `tests/unit/chrome-tab-restore.test.ts` | 30 tests pinning §3.2: the preference (incl. atomicity *mechanism*), the launch flag, `isResponsive`/`recycleIfWedged`/bounded `stop()`, and the route wiring. |
| `tools/probe-realchrome-tab-loss.js` | The measurement that root-caused §3.2. One scenario per process (`clean crash nowipe restore prefonly flagonly …`). Two traps it already fell into: `ctx.browser()` is **null** for persistent contexts (find PIDs via `ps`), and **headless writes no `Preferences` and no `Sessions` at all** — measure headed on Xvfb or you measure nothing. |
| `tools/probe-realchrome-restore-live.js` | Proves the fix through the real product class, not a replica: `getContext()` → 3 tabs → SIGKILL → `getContext()` → `tabs()`. |
| `tools/mutate-tab-restore.py` | 25-mutant harness with crash-safe restore. Takes 1-based indices so batches stay small enough not to freeze the box. A subprocess **timeout counts as a failure**, never a pass. |

---

## 7. Definition of done — ✅ ALL MET

1. ✅ §3.2 root-caused with a **measurement**, not a theory — and the measurement **overturned this
   document's own prime suspect**. `clearCrashedExitState()` is innocent (control run loses the tabs
   identically). Chrome was simply never asked to restore, and needs **both** `restore_on_startup=5`
   **and** `--restore-last-session`; each alone restores 0 of 3 tabs. Fixed and behaviour-tested.
2. ✅ Blank-tab fix verified — better than an eyeball: pinned by tests. The merge had left the picker
   harness stale (11 red, `ReferenceError: tabPlaceholder is not defined`, plus one test still
   asserting the *deleted* "close the tab on failure" contract). Now 20/20, 4/4 mutants killed.
3. ✅ Full suite green (**71 files / 1628 tests**) + `tsc --noEmit` clean.
4. ✅ New tests mutation-checked — **25/25 mutants killed**; one real hole in my own test was found and
   closed this way.
5. ✅ Squashed → force-pushed → PR updated → link handed to the operator.

### What was deliberately NOT done
§3.3 (remote file-chooser auto-fill) is untouched. This document scopes it "only if the operator asks",
and the operator did not ask. It is a feature, not a defect, and it needs a UI decision that is not
mine to guess.

### The one-line summary for whoever comes next
Tabs come back now because Chrome is *asked* to bring them back (pref **and** flag, behind
`REAL_CHROME_RESTORE_TABS`), and a wedged Chromium is no longer handed back to the caller —
`isResponsive()` proves liveness with a real `1+1` round trip and `recycleIfWedged()` replaces it.
`GET /browser/real/health` and `POST /browser/real/recover` expose that from outside.
