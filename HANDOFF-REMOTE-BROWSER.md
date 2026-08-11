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

### 3.1 Verify the blank-tab fix in a real browser (small)
Code is committed (`ba57400`) but never eyeballed. The tab must be opened **synchronously** inside the
click gesture (popup blockers), which is why a blank tab is unavoidable; the fix is that it is now
*written into* immediately, and is **kept open with the reason** on failure instead of being closed
(it is usually the foreground window, so closing it made the explanation invisible).
Steps: start the stack (§5), press the crosshair, confirm the placeholder text appears instantly and
is replaced by the view, and that the "Retry / Open the remote browser view" link works.

### 3.2 🔴 Crash + all-tabs-lost on reopen — NOT INVESTIGATED
The operator's exact report:
> «مرورگر ریموت رو بالا اوردم ولی وقتی وبگردی میکردم هنگ کرد و بعدش دیگه فریز شد منم بستم مجدد باز
> کنم کلا نرفت به اون ادرس … بعد این خطا ظاهرا کرش میکنه و موقعی که مجدد میزنم یکی جدید بالا میاره
> که همه تب ها گم شدن یا بسته شدن با همون مرورگر کرش شده»

This is the **largest remaining item**. Leads already located, do not re-search for them:
- `src/core/RealChrome.ts` → `clearCrashedExitState(userDataDir)` at **line 660**. Read it first:
  a wedged Chromium normally reopens with a "restore pages?" bubble, and wiping the crashed exit
  state is exactly what would *discard* the previous tabs. Check whether it is being called on every
  start rather than only when needed.
- `src/core/RealChrome.ts` `context.on('close')` at ~**405** drops `this.shelf = null` and the loaded
  extension list. Confirm a hung-but-alive Chromium is actually detected (a frozen page does not
  necessarily close the context, so `isRunning()` may still say true while nothing responds).
- `public/js/real-chrome.js` already has a **"Live tabs"** section that reads `/browser/tabs` with a
  per-row `POST /browser/tabs/close` "Kill" button. That is the existing recovery surface — decide
  whether to expose it in the new view instead of building another.
- Consider a health probe before reuse: if the context exists but a trivial `evaluate` times out, the
  browser is wedged and should be recycled deliberately (with the profile preserved) instead of a new
  one silently appearing.

### 3.3 Optional feature: true remote file-chooser auto-fill
Only if the operator asks. It requires attaching a Playwright/CDP filechooser bridge to `RealChrome`
the way `LiveBrowser` has one, plus a UI for "a page is asking for a file". Note the measured hazard
already documented in `LiveBrowser.ts` ~1095: `pendingChooser` holds exactly **one** dialog and a
second one used to steal the answer — the slot must be **first-come**, released rather than clobbered.

### 3.4 Housekeeping
- **Full suite + `npx tsc --noEmit` with memory free.** Baseline was `68 files / 1511 tests` at
  `191ca7b`; this branch adds 3 files / ~62 tests. `tsc` is clean as of `99036de`, and
  `real-chrome-shelf.test.ts` is 60/60. **The full suite has not been re-run since `191ca7b`.**
- **Mutation-test the 12 new tests** (the repo convention: a behaviour test is only proven real when a
  deliberate mutant kills it). Not yet done for this commit.
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

---

## 7. Definition of done for the remaining work

1. §3.2 root-caused with a **measurement** (not a theory) and fixed, with a behaviour test.
2. Blank-tab fix eyeballed once in a real browser.
3. Full suite green + `tsc --noEmit` clean, run with memory free.
4. New tests mutation-checked.
5. Squash → force-push → PR #32 updated → link handed to the operator.
