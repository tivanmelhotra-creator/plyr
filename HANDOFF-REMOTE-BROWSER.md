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
- **Upload is now fully automatic.** Pick a file on Windows and it reaches the website. See the box
  below for the claim this replaced.

> ## ⚠️ CORRECTED — upload IS fully automatic. The box that used to be here was WRONG.
>
> **What this box used to say**, and what the code and a unit test were both built to match:
>
> > *"In the simulator, Playwright drives the browser and intercepts its file dialog, so an uploaded
> > token could be handed straight to the waiting page. **This view is not that.** It is a VNC screen
> > onto a real Chromium the operator drives by hand … There is therefore no pending dialog to answer
> > at upload time … So the view tells the operator the filename to type into that dialog."*
>
> **It is false.** The reasoning sounds right and is not: it assumes interception depends on *who moved
> the mouse*. It does not. **Interception is a property of the CDP connection.** Chromium reports a file
> dialog over CDP whenever a debugger client has asked for it, no matter whether the click came from
> Playwright, from a human, or from `xdotool`.
>
> **MEASURED**, `tools/probe-upload-vnc.js` — headed Chromium on Xvfb, a genuine X11 click from
> `xdotool`, and **no Playwright click anywhere**:
>
> ```
> FILECHOOSER_EVENT_FIRED    = true
> CHOOSER_ANSWERED_BY_SERVER = true
> PAGE_SEES_FILE             = GOT:probe-upload-src.txt:25
> NATIVE_GTK_DIALOG_OPEN     = no
> ```
>
> The event fires, the server answers it, the page really receives the bytes, and **no native dialog
> ever opens** — so there was never a filename to type or a server disk to browse.
>
> **The cost of believing it.** The instruction it produced ("press Browse and type this name into the
> dialog on screen") *was* the manual round trip the operator explicitly refused:
> «کاربر نباید مجبور باشد ابتدا فایل را دستی روی سرور Upload کند و بعد از سرور آن را روی سایت بفرستد».
> A false architectural claim in a handoff document is more expensive than a bug: it had been copied
> into the product text **and into a unit test that asserted the wrong behaviour**, so the test defended
> the defect. Both are now corrected.
>
> **What is true now.** `RealChrome.ts` attaches `RemoteFileChooser` (`src/core/RemoteFileChooser.ts`)
> alongside `RealChromeShelf`. A page asking for a file becomes a pending request; the viewer polls
> `GET /browser/real/chooser`, opens the **operator's own** picker, uploads what they choose, and hands
> it over with `POST /browser/real/chooser` — by token, never by path. §3.3 below is **done**, not
> optional.
>
> **The transferable lesson:** the box was written from plausible reasoning about an API, not from a
> measurement of it. `docs/MEASURED-DECISIONS.md` exists for exactly this reason.

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

### 3.3 True remote file-chooser auto-fill — ✅ DONE (the operator did ask)
This was scoped "only if the operator asks", and they asked: «Windows کاربر → Backend/Server →
Website … این انتقال باید در Backend مدیریت شود». Built as described, plus the measurement that made it
possible at all (see the corrected box in §2 — the premise that it *couldn't* be done was false).

- **`src/core/RemoteFileChooser.ts`** — the bridge. Ports the simulator's first-come guard rather than
  reinventing it: the hazard documented at `LiveBrowser.ts` ~1095 is real, so the slot holds exactly
  **one** dialog and a second page's dialog is **released with `setFiles([])`**, never left waiting and
  never allowed to steal the answer. `CHOOSER_TTL_MS = 3 min` on an unref'd timer releases a dialog
  nobody answers. Tokens only — `accept()` resolves `up_…` handles through `resolveUpload`, so a
  filesystem path is refused *and the page is released*: a route that took a path would be an
  arbitrary-file-read.
- **`RealChrome.ts`** — creates and watches it in the launch block, nulls it on `context.on('close')`.
- **Routes** — `GET` (what is pending, `null` is the ordinary answer), `POST` (answer with tokens),
  `DELETE` (cancel) on `/browser/real/chooser`. `FileChooserError` → **409**: the request was well
  formed, the dialog simply moved on.
- **`ChromeView.ts`** — polls every `WATCH_MS = 700`, well inside the **measured 4900 ms** transient
  activation window (`tools/probe-activation-window.js`), and opens the **operator's own** picker with
  the page's own `accept`/`multiple` mirrored onto it. A visible "Choose file" button is the fallback
  when activation has expired, so the request is never a dead end.
- **Tests** — `tests/unit/remote-file-chooser.test.ts` (24) drives the real class with fake Playwright
  objects and **real** upload tokens on a real disk; 22 viewer tests in `real-chrome-shelf.test.ts`
  cover the automatic behaviour end to end.

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
| `src/core/RealChromeShelf.ts` | Download capture; `claimBytes()` race fallback; `ShelfEntry` has **no** `path` field (resolve via `resolveDownload(REAL_CHROME_SHELF_USER, token)`). Also `preferDeclaredName()` — the website's declared name beats `suggestedFilename()`. |
| `src/core/DownloadHeaders.ts` | **Why filenames are right now.** A context-level `response` listener remembering each declared `Content-Disposition` name + content-type, because `download.suggestedFilename()` is LOSSY: it answers the literal `download` for every RFC 5987 name (MEASURED 25/40 vs 40/40). 200-entry LRU. |
| `src/core/RemoteFileChooser.ts` | **The upload bridge** (§3.3). First-come single slot, 3-min TTL, tokens-never-paths. |
| `src/core/RealChrome.ts` | Launch, profile, `clearCrashedExitState` (660), context wiring (~390–415). **Start here for §3.2.** |
| `public/js/browser-view.js` | The **simulator** — the reference for the ported pipeline (~2160–2320); also `tabPlaceholder()` / `openRealBrowser()` (~367). |
| `public/js/remote-io.js` | Simulator's clipboard + upload bridge; `uploadFile` (184), `acceptsFile` (218). |
| `public/js/real-chrome.js` | Older control panel; has the **"Live tabs"** kill UI relevant to §3.2. |
| `public/js/api.js` | `errorTextOf()` — never dump an HTML error page into a toast again. |
| `tests/unit/real-chrome-shelf.test.ts` | 85 tests + the `runView()` browser-execution harness. Extend this rather than starting a new harness. Hooks for the automatic half: `setPendingChooser`, `chooserCalls`, `ticks(n)`, `watch` (background traffic held apart from operator-caused `fetches`). |
| `tests/unit/remote-file-chooser.test.ts` | 24 tests driving the real `RemoteFileChooser` with fake Playwright objects and **real** upload tokens on a real disk. The token→path half is security-critical, so none of it is mocked. |
| `tests/unit/declared-filename.test.ts` | 26 tests: the header index, `preferDeclaredName`, generic MIME→extension, and the parse/sanitise boundary (`filenameFromContentDisposition` returns VERBATIM; `safeFileName` is the sanitiser one layer down). |
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

### What was deliberately NOT done — ⚠️ SUPERSEDED
> This used to read: *"§3.3 (remote file-chooser auto-fill) is untouched … the operator did not ask."*
> They asked, in the very next round: «Windows کاربر → Backend/Server → Website». §3.3 is now **done**,
> and so is the automatic download direction. See §9.

### The one-line summary for whoever comes next
Tabs come back now because Chrome is *asked* to bring them back (pref **and** flag, behind
`REAL_CHROME_RESTORE_TABS`), and a wedged Chromium is no longer handed back to the caller —
`isResponsive()` proves liveness with a real `1+1` round trip and `recycleIfWedged()` replaces it.
`GET /browser/real/health` and `POST /browser/real/recover` expose that from outside.

---

## 8. Configuration that tunes itself (the operator's follow-up request)

> «متغییر ها خیلی شدن و الان بخام یه حالت استاندارد برسم باید کلی متغیر سروکله زد در حالی که من میخام
> نسبت به موقعیت متغیر ها تنظیم بشن … به جای اینکه من بخام دونه دونه سرچ کنم تگ ها رو پیدا کنم … حواسمون
> به کاربران تازه کار هم باشه … من نمیخام کاربر با متغییر ها درگیر بشه که نفهمه این متغییر چه گزینه هایی
> میتونه داشته باشه و گیج بشه»

Two complaints, one theme: **77 environment variables, and no way to know what any of them may be set to.**

### 8.1 Profiles — `src/core/EnvProfile.ts`

One word decides the situation, and the situational variables follow it:

| | development | production | test |
|---|---|---|---|
| `REAL_CHROME_HEADLESS` | `false` — you need to SEE it | `true` — nothing is watching | `true` — CI has no screen |
| `DESKTOP_ENABLED` | `true` | `false` | `false` |
| `RATE_LIMIT_ENABLED` | `false` | `true` | `false` |
| `REAL_CHROME_DEBUG_PORT` | — | `0` | `0` |
| `TURBO_MODE` | `false` | — | — |

Precedence, in one line: **explicit env var → profile default → built-in default.** `''` counts as absent;
`false` is explicit and wins. So the profile can never take a decision away from you.

**`APP_ENV`, not `NODE_ENV`.** `NODE_ENV` is written by everything — vitest forces `test`, bundlers force
`production` — so it cannot express *your* intent. `APP_ENV` is yours and wins; `NODE_ENV` is still
honoured when `APP_ENV` is absent. Short forms `dev` / `prod` / `ci` work.

**Provenance is the feature, not the values.** `GET /config/profile` returns, per variable, the `value`,
the `source` (`explicit` / `profile` / `default`), a bilingual `why`, what the profile *would* have chosen
(`profileValue`), and `overridden`. "You set this" and "development set this for you" must never look
alike, or the operator debugs the wrong layer — which is how this project lost days.

### 8.2 The flag catalogue — `src/core/ChromeFlags.ts`

The hard-coded launch-argument array is gone. **15 switches**, each with a stable id, a group, bilingual
label and reason, and a `risk` (`safe` / `caution` / `dangerous`); **6 groups**; **5 presets**.

- **Beginners** pick a preset: `standard` **(recommended, pre-ticked)**, `stealth`, `lean`, `debug`.
- **Experts** tick individual boxes, or choose `custom`.
- `required` flags (e.g. `--no-sandbox` in a container) are **never offered as a checkbox** — a tick box
  that bricks the browser is a trap. Trying to switch one off is reported back in `forced`.
- Unknown ids are **reported in `unknown`, never silently dropped**. A flag the operator believes they set
  and the browser never received is precisely the failure class that cost this project days.

`standard` is byte-identical to the array it replaced, minus one accidental duplicate of
`--no-default-browser-check` — pinned by a regression test that reconstructs the old list from git history.

### 8.3 It applies without asking for a restart

`POST /browser/real/flags` first answered `restartRequired: true`. That violates this repo's mandate —
*never ask the user to do something we could have done* — and `tests/unit/self-heal.test.ts` fails the
build on exactly that. The route now relaunches Chrome itself via `SelfHeal.reloadExtensions(report,
swapLiveSessions)`, rebuilding live sessions so **tabs survive the swap**, and only when the selection
actually changed *and* a browser is running.

### 8.4 Two real bugs this work found in itself

1. **`.env.example` defeated the whole system.** It set all six self-tuning variables explicitly, and
   explicit always wins — so anyone following the documented "copy it to `.env`" step would have been back
   to editing six variables by hand. They are now commented out, each annotated with what the profile
   picks and why.
2. **The `test` profile overturned a shipped default.** It set `REAL_CHROME_RESTORE_TABS='false'`
   ("a test should start from a known state"). vitest sets `NODE_ENV=test`, so the entire suite began
   asserting against a configuration no operator ever runs, and it quietly reversed the §3.2 fix above.
   `chrome-tab-restore.test.ts` caught it. **Rule learned: a profile may tune what is environmental; it
   may not flip a product decision that other tests pin.** A guard now fails if any profile re-adds it.

### 8.5 Verified

- **72 files / 1677 tests green**, `tsc --noEmit` clean.
- Proven end-to-end through the **real router** and the **live `config` object**, not replicas: dev →
  `headless:false, desktop:true`; prod → `headless:true, desktop:false, rateLimit:true`;
  `APP_ENV=production REAL_CHROME_HEADLESS=false` → `false [explicit] overridden=true`.
- `.env.example` loaded as dotenv would: one word changed, six behaviours followed.
- i18n parity checked mechanically: **75 `rc.*` keys in both `fa` and `en`**, every key the UI asks for
  defined in both.
- New guards mutation-tested — re-adding the profile entry and dropping the flag from the recommended
  preset each fail loudly.

### 8.6 If you extend this

Add a variable to `PROFILE_DEFAULTS` **only if its best value genuinely differs by situation**, and give
it a real `why` in both languages — the `why` is what the operator reads instead of searching the web.
Add a flag to `FLAG_CATALOGUE` with an honest `risk` and a reason that says **what it costs**, not just
what it does. Do not add a flag to a preset without saying why in the preset's `summary`.

---

## 9. File transfer that behaves like a local browser (the operator's third request)

> «وقتی کاربر از داخل Remote Browser روی یک سایت، فایل را برای Upload انتخاب می‌کند: **Windows کاربر →
> Backend/Server → Website**. این انتقال باید در Backend مدیریت شود و کاربر نباید مجبور باشد ابتدا فایل
> را دستی روی سرور Upload کند و بعد از سرور آن را روی سایت بفرستد.»
>
> «کلیک روی Download → فایل مستقیماً روی Windows کاربر ذخیره شود … نباید کاربر مجبور باشد ابتدا فایل را
> روی Server دانلود کند و بعد آن را جداگانه از Server دریافت کند.»
>
> «این قابلیت باید به صورت Generic برای همه فرمت‌ها کار کند، نه اینکه برای PDF یک منطق جدا و برای ZIP یک
> منطق جدا نوشته شود.»

Both directions are automatic now, and the naming bug that was the operator's central complaint is fixed
at its **cause**, which turned out not to be where anyone had been looking.

### 9.1 The naming bug: `suggestedFilename()` is lossy, and no downstream fix could have worked

Files had arrived with **no extension**, with the **wrong name**, and for a while **every file was named
`file`**. Later a fix made extensions work for a *limited set of formats* — which the operator correctly
rejected, because a curated list is not "generic".

The cause was never locale, and never the extension table. It is that
**`download.suggestedFilename()` throws the name away**. MEASURED across 40 real download shapes
(`tools/probe-dl-names.js`, `probe-dl-final.js`):

| Source | Correct names |
|---|---|
| `download.suggestedFilename()` | **25 / 40 (63%)** |
| `Content-Disposition` header | **40 / 40 (100%)** |

For every RFC 5987 name (`filename*=UTF-8''…`) and every raw-UTF-8 name, Playwright answers the literal
string `download`. That is where `file` came from. **No amount of post-processing can recover a name that
was already discarded** — so the fix had to be to stop asking that question.

- **`src/core/DownloadHeaders.ts`** — a **context-level** `response` listener remembers what each URL
  *declared*. Context level is also measured, not guessed: `context.on('download')` **never** fires
  (0/30) and per-page `response` listeners **missed 8/20** downloads, all of them new-tab
  (`probe-dl-ctxresp.js`). 200-entry LRU so a long session cannot grow without bound.
- **`preferDeclaredName()`** in `RealChromeShelf.ts` — the declared name wins. A declared name *without*
  an extension borrows Chrome's suffix **only when the stems match** (`export` + `export.rtf` →
  `export.rtf`; but `quarterly` + `somethingelse.pdf` → `quarterly`, because those are two different
  files and guessing would be inventing one).

### 9.2 Generic for all formats — a database, not a list

`extensionFromContentType` keeps a **curated table only where the IANA answer is not what a user
expects** (`.jpg` over `.jpeg`, `.mp3` over `.mpga`), then delegates everything else to **`mime-types`**
(~1000 IANA types). So no format has "its own logic".

**Opaque types yield no extension at all** — `application/octet-stream`, `binary/octet-stream`,
`application/force-download`, `*/*` and friends. They mean *"I will not say"*, and inventing `.bin` from
them is how a `.docx` became unopenable. **A missing suffix is recoverable; a wrong one is a lie.**

`tests/unit/declared-filename.test.ts` asserts `image/tiff` → **`.tif`** (not `.tiff`) on purpose: that
row *proves* the mapping is the database's and not hand-written.

### 9.3 Both directions, with no press in the file bar

The trigger for each happens **inside** the remote page, where the viewer cannot see it, so the viewer
polls (`WATCH_MS = 700`) and completes each direction itself.

- **Up:** page asks → `GET /browser/real/chooser` → the operator's **own** picker opens with the page's
  `accept`/`multiple` mirrored → upload → `POST /browser/real/chooser` with **tokens** → the site has the
  file. One gesture. A file uploaded *before* the page asked is reused rather than asked for twice.
- **Down:** a completed download is fetched and saved on its own, and the name is read from the
  **served response's** `Content-Disposition` (`filename*` preferred) — not from the shelf row — so a row
  reading `download` still lands as `فاکتور.xlsx`. The **first poll seeds** instead of delivering:
  opening a viewer must not dump a previous session's files into the operator's Downloads folder.

### 9.4 Measurements that set the constants (do not "tidy" these away)

| Measured | Value | What it decided |
|---|---|---|
| Transient activation window | picker opens at **4900 ms**, fails at **6000 ms** | `WATCH_MS = 700`, an order of magnitude inside the budget |
| Blob+anchor deliveries | **5/5** names intact | Chrome's "multiple automatic downloads" gate does not block this route |
| Filechooser under a real X11 click | **fires**, no GTK dialog | Interception is a property of the **CDP connection**, not of who moved the mouse — §2 |
| `context.on('download')` | **0/30** | Downloads must be watched **per page** |
| Per-page `response` | **missed 8/20** | Header index must be **context**-level |

### 9.5 The two traps in this area

1. **`res.setHeader` throws `ERR_INVALID_CHAR` for bytes > 0xff.** A real filename like `فاکتور.xlsx`
   cannot go into a header raw — hence `contentDispositionAttachment()`, which emits both an ASCII
   `filename` and an RFC 5987 `filename*`.
2. **Parse and sanitise are deliberately separate layers.** `filenameFromContentDisposition` returns the
   declared name **verbatim**, including `../../../etc/passwd`; `safeFileName` (`RemoteUploads.ts`) is the
   sanitiser one layer down (→ `passwd`, while `فاکتور.xlsx` survives intact). Do not "harden" the parser
   — a parser that sanitises cannot report what the server actually said, and the boundary is pinned by
   test.
