# Measured design decisions (not guessed)

Every row below was produced by a live probe in `tools/probe-cdp*.js` against the
same Chromium build the server launches. Re-run any of them to re-verify.

## Baseline: what the simulated browser was missing

`node tools/probe-baseline.js` → **7/16** Chrome behaviours present.
Missing, measured over the real `/browser/ws` socket:
`favicon` / `loading` / `audible` fields on tabs, `contextMenu`, `zoom`,
any downloads channel, `tabReopen`, `tabMove`, `tabDuplicate`.

`node tools/probe-nav.js` → back/forward/reload *do* navigate, but
`canGoBack` / `canGoForward` were **never** sent to the client, so the UI could
never grey a dead button out nor explain a no-op. Going back past the start of
history silently re-emitted `navigated(about:blank)`. A second `navigate` racing
an in-flight one produced `net::ERR_ABORTED` — commands were not serialised.

## Input (group 1) — `tools/probe-cdp.js`, all green

| Capability | Verdict |
| --- | --- |
| `Emulation.setPageScaleFactor` | pinch zoom only — see the zoom section below; **not** browser zoom. |
| `Emulation.setDeviceMetricsOverride` | **this is browser zoom** — see below. |
| `Input.dispatchKeyEvent {modifiers:2, commands:['selectAll']}` | Ctrl+A selects. Any key + any modifier works. |
| `clickCount: 2` / `3` | 2 → word selected, 3 → paragraph selected. |
| mousedown → 8×mousemove(`buttons:1`) → mouseup | text drag-selection works. |
| `mouseWheel {deltaX:250}` | `scrollX === 250` — horizontal wheel works. |
| `Input.synthesizePinchGesture` | works. |
| `DOM.getDocument` + `DOM.getNodeForLocation` | works — hit-test for the context menu. |
| `button:'right'` | fires a real `contextmenu` event in the page. |

## Zoom (group 1) — `tools/probe-zoom.js`

My first assumption was wrong, and the probe caught it. `setPageScaleFactor`
**cannot zoom out**: asking for `0.8` read back `1.0`, because that API is pinch
zoom and a desktop page's minimum pinch scale is 1. It also does not reflow —
`innerWidth` stayed at 1000 while "zoomed" to 1.25.

Real browser zoom at Z means the layout width becomes `viewport/Z`. Measured
with `Emulation.setDeviceMetricsOverride {width: vp/Z, height: vp/Z, deviceScaleFactor: Z}`:

| Zoom | `innerWidth` | expected |
| --- | --- | --- |
| 1.25 | 800 | 800 |
| 0.8 | 1250 | 1250 |
| 2 | 500 | 500 |
| reset (`clearDeviceMetricsOverride`) | 1000 | 1000 exactly |

**Consequence the client must handle** (also measured): while an override is
active, screencast frame metadata reports the *scaled* device size (667 instead
of 1000 at 1.5x). So canvas coordinates must be divided by the zoom before being
sent as CDP input, or every click after a zoom lands in the wrong place. Both
directions were proved: the divided click hit the target element, an undivided
one missed.

## Double-click: a probe bug, not a product bug — `tools/probe-dbl2.js`

Worth recording because it nearly caused a wrong fix. An early probe reported
"double-click selects nothing", and the failure survived headless *and* headed
Chrome on Xvfb, and reproduced with Playwright's own `page.mouse.dblclick` —
which looked like conclusive evidence of a Blink/CDP limitation.

It was not. The probe clicked `box.x + 40`, which is the **space between two
words**. Chromium correctly selected that space; `.trim()` turned it into `""`.
Aiming at the measured centre of a word (via a `Range` rect) makes
`clickCount:2` select exactly `"gamma"`, and the page's own `dblclick` handler
reports `detail:2` with the word already selected. `clickCount:3` selects the
paragraph. The lesson: compute the coordinate, never eyeball it.

## Downloads (group 3) — `tools/probe-cdp2.js`, `tools/probe-cdp4.js`

The decisive measurement, because it reversed my first assumption:

| Listener | persistent ctx | normal ctx |
| --- | --- | --- |
| `context.on('download')` | **0 events** | **0 events** |
| `page.on('download')` | 1 event | 1 event |

So `context.on('download')` — the obvious API, and what the original plan
called for — **never fires here**. It has to be `page.on('download')`, wired
per page as tabs are created.

CDP on a *page-level* session (we have no browser-level session for a
persistent context) works and is strictly richer:

- `Browser.setDownloadBehavior {behavior:'allow', downloadPath, eventsEnabled:true}` — accepted on a page session.
- `Browser.downloadWillBegin` → `guid`, `suggestedFilename`.
- `Browser.downloadProgress` → 7 events, `inProgress` **and** `completed`, with
  `receivedBytes` / `totalBytes`, including genuine **intermediate** values.
  That is what makes a real percentage bar possible; `page.on('download')`
  alone can only jump 0 → 100.
- The file lands in our `downloadPath` on the server by itself.

**Conflict measured:** once CDP download behavior is set, `download.saveAs()`
fails (`size=-2`) because CDP already owns the file.

**Decision:** CDP is the primary channel (progress % + file on disk); `page.on('download')`
is kept only as a metadata/fallback source and we never call `saveAs()` when the
CDP path is live.

## Basic auth / 401 (group 2) — `tools/probe-cdp3.js`, `tools/probe-cdp4.js`

- `Fetch.authRequired` does **not** fire for a non-matching `patterns` entry
  (measured: 0 events) — so auth is not free, the pattern must match.
- `patterns: [{urlPattern:'*'}]` → **8 pauses for one ordinary page**. A real tax.
- `patterns: [{urlPattern:'*', resourceType:'Document', requestStage:'Request'}]`
  → **1 pause per navigation**, and `Fetch.authRequired` is still delivered,
  and `Fetch.continueWithAuth` still authenticates (`authed as joe:s3cret`).
- A 401 is *also* observable with **no** interception at all, via
  `page.on('response')` (`401 protected`), and headless Chromium simply renders
  the 401 body rather than showing a native prompt.

**Decision:** always-on `Fetch.enable` with the **Document-only** pattern.
One pause per navigation is negligible, and it gives us `authRequired`
synchronously so we can show a real credentials modal.

## Dialogs (group 2) — `tools/probe-cdp3.js`

- With **no** listener, Playwright auto-dismisses; `evaluate` returned in 15 ms.
  So the reported "tab silently locks" is **our own handler gap**, not Playwright.
- With a listener that does not answer, the dialog **blocks everything**:
  `window.confirm` still pending after 1202 ms, and an unrelated `page.title()`
  timed out too. That is exactly the reported lock-up, reproduced.
- Answering it fully recovers the page (`page.title()` resolves).
- `type` / `message` / `defaultValue` are all available.
- `prompt` + `accept('typed value')` → the page receives `'typed value'`.
- `confirm` + `accept()` → the page receives `true`.

**beforeunload:**
- `page.close({runBeforeUnload:true})` fires a `beforeunload` dialog and does
  not hang.
- **dismissing it keeps the tab open** (`isClosed === false`) — so we really can
  *ask* the user instead of silently closing, which is what Chrome does.

## Stability / "we never lose a tab" (group 6) — `tools/probe-cdp2.js`

- `location.href` swap (what a cookie extension's `chrome.tabs.update` does):
  the **same** `Page` object stays alive, no `close` event, and `framenavigated`
  fires — so we can re-sync url/title instead of losing the tab.
- `chrome.tabs.reload`-style reload: `Page` stays alive, one `framenavigated`.
- **An extension-created tab has `opener() === null`.** The existing rule
  "adopt only if `opener()` is owned" therefore **drops every extension tab** —
  measured root cause of the disappearing popup/extension tab.
- A page stays usable after its CDP session is detached, and a **fresh** CDP
  session can be re-bound to the same page — recovery does not need a new tab.

## Remote file transfer: "the remote browser must feel local" (2026-08-12)

The operator's requirement, in full: a file chosen inside the remote browser must
travel **Windows → server → website** with no manual step, and a download must
travel **website → server → Windows** *keeping the real name and the real
extension, generically, for every format*. The previous simulator got the name
wrong (files called `file`, missing suffixes, extensions supported only for a
hardcoded handful).

Every design decision below is a measurement, not a preference. Probes are in
`tools/probe-dl-*.js`, `tools/probe-upload-vnc.js`, `tools/probe-chooser-hold.js`,
`tools/probe-activation-window.js`, `tools/probe-auto-download.js`.

### The filename source — `tools/probe-dl-final.js`

40 cases: 8 real `Content-Disposition` shapes × 5 ways a site can start a
download (anchor, same-tab navigation, `target=_blank`, form POST, `window.open`).

| source of the name | correct |
|---|---|
| `download.suggestedFilename()` (what the shelf used) | **25/40 (63%)** |
| the response's own `Content-Disposition`, read by us | **40/40 (100%)** |

`suggestedFilename()` collapses to the literal string `download` for **every**
name carried in RFC 5987 form (`filename*=UTF-8''…`) and for every raw-UTF-8
header — 15 of 40 cases, including `فاکتور.xlsx`. **This is the root cause of
the reported "wrong name / no extension / everything called `file`".** It is not
a locale bug and it is not fixable downstream: by the time Playwright reports the
name, the real one is already gone.

So the name is now taken from the header, and `suggestedFilename()` is only a
fallback. Sniffing bytes and mapping MIME types are fallbacks *below that*,
because a name the site actually declared needs no guessing at all.

### Why not CDP — `tools/probe-dl-cdp.js`

`Browser.downloadWillBegin` looked like the authoritative source. Measured, it is
strictly worse: **4/15** correct, and enabling
`Browser.setDownloadBehavior{eventsEnabled:true}` **suppressed Playwright's own
`download` event** (`(NO EVENT)` in 6/18 rows) — i.e. it would have broken the
working shelf to get worse names. Rejected on evidence.

`context.on('response')` is used rather than `page.on('response')`: a per-page
listener missed **8/20** downloads in `tools/probe-dl-names2.js`, all of them the
ones that open a new tab, because the page did not exist yet when it was attached.
`context.on('download')` never fires at all (**30/30** misses) — only
`page.on('download')` does, which is why the shelf still attaches per page.

### Upload can be fully automatic — the handoff doc was wrong

`HANDOFF-REMOTE-BROWSER.md` §2 states upload *cannot* be automatic here, because
Playwright "is not holding its dialogs open" when the operator clicks with their
own mouse over VNC, and concludes the operator must type a filename into the
server's own dialog. **Measured false** (`tools/probe-upload-vnc.js`): headed
Chromium on Xvfb, the input clicked with `xdotool` — a genuine X11 event from
outside the browser, exactly what a VNC client delivers:

```
FILECHOOSER_EVENT_FIRED    = true
CHOOSER_ANSWERED_BY_SERVER = true
PAGE_SEES_FILE             = GOT:probe-upload-src.txt:25
NATIVE_GTK_DIALOG_OPEN     = no
```

Interception is a property of the CDP connection, not of who moved the mouse. So
the dialog can be answered with bytes uploaded from the operator's machine, and
the server's filesystem is never shown.

### The dialog survives a human — `tools/probe-chooser-hold.js`

Holding it unanswered for **47.8 s** (while the operator browses their own disk):
`SET_FILES_AFTER_DELAY_OK = true`, the page received the file, and
`RENDERER_RESPONSIVE_WHILE_PENDING = true` — the remote view does not freeze
while the dialog waits.

### The local picker may open by itself — `tools/probe-activation-window.js`

The viewer raises the operator's *own* picker after the server reports a pending
dialog, so it needs transient user activation to survive the round trip.
Measured window: **works up to 4900 ms, fails at 6000 ms.** The poll interval is
set well inside that, and the fallback is a visible button — never a dead end.

### Saving many files needs no per-file click — `tools/probe-auto-download.js`

`BLOB_ANCHOR_DOWNLOADS_DELIVERED = 5/5`, names intact. Chrome's
"multiple automatic downloads" gate does not block the blob+anchor route, so a
page that emits several files still lands all of them.

### End to end on the real stack — `tools/probe-e2e-transfer.js`

The nine probes above each measured **one** question. This one runs the whole
chain with the **real product classes** (`RealChromeShelf`, `RemoteFileChooser`,
`resolveDownload`, `saveUpload`), a **real headed Chromium on Xvfb**, and a real
HTTP server declaring names the way real sites declare them. It asserts and
exits non-zero, so it is a check rather than something to read by eye.

**ALL CHECKS PASSED.** Eight download shapes, every name exact:

```
["calendar.ics","contract.docx","bundle_v2.zip","quarterly",
 "گزارش.pdf","فاکتور.xlsx","invoice_2026.xlsx","report_final.pdf"]
```

- The operator's own two examples land verbatim: `report_final.pdf`,
  `invoice_2026.xlsx`.
- **`فاکتور.xlsx` and `گزارش.pdf` are the decisive rows.** `suggestedFilename()`
  answers the literal `download` for an RFC 5987 name, so these could only have
  come from the declared header. Both header orders work
  (`filename` first, and `filename*` first).
- **`quarterly` keeps no extension.** The body was `application/octet-stream`;
  inventing `.bin` would have been the wrong-suffix bug in a new coat.
- **`calendar.ics` had no declared filename at all** — the extension came from the
  MIME database, which is what "generic for all formats" means.
- Bytes are reachable behind every token, and the stored basename equals the
  declared name.
- Upload: a path is refused **and the page released**, the page can then ask
  again, and the website ends up with the operator's own bytes:
  `GOT|my notes.txt|36|operator-file-contents-…`.

**Two bugs this probe found in ITSELF, both worth recording** — because both
looked exactly like catastrophic product failures on the first run:

1. `shelf.list()` is **newest-first**. Reading `rows[rows.length - 1]` compared
   every case against the *oldest* row, so all eight reported `report_final.pdf`
   and it read as "the name is never updated". The product had been right the
   whole time.
2. Asserting `declaredCount() > 0` at the end **failed correctly**: `track()`
   calls `headers.forget(url)` when a download completes, so the index is empty
   by design. That assertion was demanding a memory leak.

The lesson is the one this file exists for: a measurement that disagrees with the
code is not automatically a bug in the code.

---

## The «12/24» that never existed — an audit finding retracted

**Date:** 2026-08-13 · **Files:** `src/core/LiveBrowser.ts`,
`tools/probe-livebrowser-names.js`, `tests/unit/live-browser-download-names.test.ts`

This entry records a **wrong** measurement of mine and the correct one that
replaced it, because the wrong one was already in a code comment and on its way
into an audit report, and the previous entry's own closing line applies to it:
*a measurement that disagrees with the code is not automatically a bug in the code.*

### What I claimed

That the dashboard's Live Browser shelf lost half of all real filenames:

```
suggestedFilename()             12/24  (50%)
declared Content-Disposition    24/24 (100%)
```

and therefore that `LiveBrowser.trackDownload` was **broken** in the same way
`RealChromeShelf` had been — the reported
«فایل بدون Extension / نام اشتباه / همه با نام file» defect, still live on a
second surface.

### Why it was wrong

The probe launched its own browser:

```js
const browser = await chromium.launch();          // bare environment
```

The product launches, at **both** sites a live session can be handed a browser —
`GlobalBrowser` (line ~92) and `RealChrome` (line ~646):

```ts
env: withUtf8Locale(process.env)                  // LANG=C.UTF-8
```

The locale is the entire variable. Chromium builds a download's filename as a
`base::FilePath`, a byte string on POSIX; with no UTF-8 locale it cannot
represent a non-ASCII name and discards the **whole** name, extension included,
for its hardcoded fallback. Isolated to that one variable:

```
no LANG          «فاکتور.xlsx»  ->  "download"
LANG=C.UTF-8     «فاکتور.xlsx»  ->  "فاکتور.xlsx"
```

Re-measured **with the product's environment**, 8 Content-Disposition shapes × 3
ways a site starts a download:

```
suggestedFilename()             24/24 (100%)
declared Content-Disposition    24/24 (100%)
```

**There is no 50% loss on the real code path.** Reporting one would have been a
false audit finding — a bug that only exists in the harness that looked for it.
`tools/probe-livebrowser-names.js` now launches with the product's environment,
and takes `AB_PROBE_BARE_ENV=1` to reproduce the old number deliberately, as a
demonstration of the dependency rather than a claim about shipped code.

### What the declared-header index is actually worth here

Two things, and they are worth keeping — but as robustness and a narrow fix, not
as a 50%→100% rescue:

**1. Defence in depth.** The 24/24 above is contingent on an environment variable
set in a *different file*. A deployment exporting a non-UTF-8 `LC_ALL`, a service
manager with a scrubbed environment, or a refactor that drops `withUtf8Locale`
silently returns every filename to `download`. The declared header cannot be lost
that way, because it is read off the wire before any filesystem is involved.
`tests/unit/live-browser-download-names.test.ts` therefore asserts the locale fix
is present at **both** launch sites — a removal is caught by a test rather than by
a user.

**2. A narrow, real extension rescue.** The declared `Content-Type` is passed to
`ensureUsableExtension`. My first figure for this — "4/4 otherwise-extensionless
downloads" — was **also** measured wrongly, by calling the function directly
instead of through the browser. Chromium *already* appends a suffix from the
response type when it invents the whole name itself:

```
attachment, no filename, text/html   ->  d.html      (no help needed)
```

The argument only changes the outcome when the **site named the file and the name
had no extension** — because then the site's name must be kept (that is the
requirement) and Chromium's own suffixed guess is discarded along with it.
MEASURED through `trackDownload` itself, 7 tricky shapes:

```
                          with declared type    without it
filename="export"    csv     export.csv           export
filename="data"      json    data.json            data
filename*=گزارش      csv     گزارش.csv            گزارش
filename="report"    rtf     report.rtf           report
attachment (no name) html    d.html               d.html      (unchanged)
filename="notes"  /f.bin     notes.bin            notes.bin   (URL answered)
filename="x"       octet     x                    x           (nothing to say)
```

**4/7 rescued**, and the three that do not move are cases no argument could help.
The four that do are exactly the reported «فایل بدون Extension». The tests were
rewritten to those shapes after the original ones were found to pass **either
way** — a test that cannot fail proves nothing, and this one was verified to turn
4 assertions red when the argument is removed.

### The transferable lesson

A probe is a program, and a program launched differently from the product measures
a different program. Before a measurement is allowed to call shipped code broken,
it has to be shown to run on the **same code path** — same launcher, same
environment, same call order. Both wrong numbers here came from skipping that
check, and both were caught only by asking "does the fix still look necessary if I
put it back?"
