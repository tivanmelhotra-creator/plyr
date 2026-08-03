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
