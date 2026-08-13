# Dual Browser Mode + Element Inspector Extension — handoff

Implements the 20-section specification
`Dual Browser Mode + Chrome-Chromium Element Inspector Extension.md`.

Two features that share one seam:

1. **Dual Browser Mode** — automation runs either on the **server's** browser
   (Remote, unchanged) or on the **user's own Chrome** (Local, new).
2. **Element Inspector** — a **Chrome MV3 extension** that picks an element off a
   real page and drops its data into the node the user is editing.

---

## 1. The two rules that shaped everything

The spec is emphatic about two things, and most design decisions below follow
from them rather than from preference.

> «Remote Browser حذف نمی‌شود و Local Browser نیز جایگزین آن نیست»
> *Remote is not removed, and Local is not its replacement.*

So Remote is untouched and remains the fallback that always works. Local is
added **beside** it. Nothing about the existing remote path was rewritten.

> «نباید دو Inspector جداگانه ساخته شود»
> *Two separate Inspectors must not be built.*

So there is exactly **one** extension, and it works in both modes. It does not
know or care which mode is active; it asks the server, which answers.

---

## 2. Why Local mode is a reverse tunnel and not an open port

The naive approach is to have the user expose Chrome's debugging port and have
the server connect to it. That is not viable, for two independent reasons:

- **CDP has no authentication at all.** Anyone who reaches port 9222 has full
  control of a logged-in browser — cookies, sessions, saved passwords. Exposing
  it to the internet hands the user's browser to whoever port-scans them first.
- **Most users cannot be connected to inbound anyway** — NAT, CGNAT, corporate
  firewalls. It would simply fail for the majority.

So the direction is inverted. The **agent dials out** to us:

```
User's machine                          Server
──────────────                          ──────
Chrome --remote-debugging-port=9222
  (bound to 127.0.0.1 -- never exposed)
        ▲
        │ loopback TCP
        │
  local-browser-agent.js  ──── WSS/443 ────▶  LocalBridgeServer
                                                    │
                                              loopback net.Server
                                              on an ephemeral port
                                                    │
                                              Playwright
                                              connectOverCDP()
```

Outbound WebSocket on 443 needs no firewall change and works behind NAT. The
port stays bound to `127.0.0.1` on the user's machine, so it is never reachable
from outside.

### Why the tunnel multiplexes streams

`chromium.connectOverCDP()` does **not** open one connection. It opens a version
probe (`/json/version`), then the browser socket, then **one more per target**.
A single pre-opened WebSocket cannot serve them.

So the bridge multiplexes, with server-allocated stream ids:

```
[uint8 opcode][uint32BE streamId][payload]
OPEN=0x01  DATA=0x02  CLOSE=0x03  ERROR=0x04
```

**Bytes are copied, never parsed.** A CDP-aware proxy would have to understand
the protocol, and would then break on every Chrome and Playwright release. This
one is indifferent to what flows through it.

---

## 3. Why there is no second automation engine

The spec forbids it (§4, §20), and it would also be a bad idea: re-implementing
the ~40 node actions for local mode would duplicate all of them and lose
Playwright's auto-waiting and locator semantics — the two things that make the
nodes reliable.

Instead **Playwright stays server-side** and reaches through the tunnel. So:

- every node (Navigate, Click, Fill, Select, Wait, Extract, Execute Script, …)
  works in both modes with **no per-node change**;
- node logic in `src/pipeline.ts` (~3100 lines) stays entirely mode-agnostic;
- the only place that knows about modes is `src/core/BrowserAdapter.ts`.

### The regression that had to be prevented

Cleanup paths used to close `context.browserContext` unconditionally. In local
mode **that is the user's own browser** — a workflow finishing would have closed
the user's Chrome, with their tabs in it.

Fixed with a `browserShared` flag on the context and guards at **all three**
close sites. Verified: `grep -c browserShared src/pipeline.ts` = 6.

Local mode also adopts `browser.contexts()[0]` and never calls `newContext()`:
on an attached Chrome that would be an incognito context, discarding the cookies
and logins that are the entire point of using your own browser.

---

## 4. Why the Inspector is an extension, not a page overlay

The spec marks this «نکته بسیار مهم» (very important) in §5. There is also a
concrete reason it *must* be: the previous approach was a `<canvas>` screencast
of one page, which can never show the extension toolbar, `chrome://` pages,
Chrome's own settings, or the native file dialog — those are not drawn by the
page compositor. The operator's verdict was to remove it.

An extension reads the **real DOM**, so selectors are real rather than inferred
from pixels.

### Why the panel is drawn in the page, not in the popup

An extension popup **closes when it loses focus**. The first hover over the page
would dismiss it, which makes a hover-to-highlight picker impossible there.

So the panel is injected into the page inside a **`closed` shadow root**: page
CSS cannot reach in and restyle it, and page scripts cannot read what the user
picked. Two separate shadow hosts, because the highlight must be
`pointer-events: none` while the panel must be clickable.

Listeners are registered in the **capture phase** — sites call
`stopPropagation()` on exactly the interactive elements users most want to pick.

---

## 5. Attribute extraction is generic, not a whitelist

§8 is explicit: «نباید فقط Attributeهای از قبل مشخص‌شده Hardcode شوند» — a
hardcoded attribute list is not acceptable, and `data-*` must be **fully**
generic (`data-id`, `data-product`, `data-category`, anything).

So `extension/lib/ab-inspect.js` walks `el.attributes` and reports **everything
present**. `TAG_HINTS` / `GLOBAL_HINTS` exist **only to order** the list so the
useful rows sort first — they never filter. An attribute nobody anticipated is
still extracted, because the code never asks whether it recognises the name.

---

## 6. Why delivery is a session handshake

The dangerous failure here is not a lost pick — it is a pick landing in the
**wrong node**, silently. That produces a workflow that is subtly wrong and a
user who cannot tell why.

So routing is explicit, and the server **refuses rather than guesses**:

| Situation | Response |
|---|---|
| No node is waiting | `409 no_active_node` |
| The pick belongs to an older editing session | `409 stale_session` |
| No attributes were ticked | `409 empty_selection` |
| The element payload was incomplete | `409 invalid_element` |

A refusal the user can see and retry is strictly better than a mis-delivery they
cannot.

**The session id is per tab** (`sessionStorage`, not `localStorage`). Two editor
tabs are two editing sessions; `localStorage` is shared between them and would
make them indistinguishable — reintroducing the exact ambiguity above. A reload
keeps the same tab's id, so F5 does not orphan the claim.

`openNdv()` claims, `closeNdv()` releases. So *"where will my pick go?"* is
answerable by looking at the screen.

---

## 7. Why there are two transports

- The **WebSocket** (`/inspector/ws`) makes a pick appear instantly.
- The **HTTP inbox** (`GET /inspector/inbox`) makes it appear *anyway* for a user
  behind a proxy that breaks WebSocket upgrades — and for the extension, whose
  MV3 service worker is restarted at will by Chrome (maintaining a socket across
  that would be more code for less reliability).

The 3-second poll runs **only while the socket is down**, so the normal case
costs no extra requests.

Deliveries are **applied, then acked**. A crash between the two costs a
duplicate; the reverse order costs the user's pick. The inbox defaults to *peek*,
not drain, so a client that fails mid-apply has not destroyed the only copy.

---

## 8. Field mapping stops at what the node declares

`GraphSerialize.coerceParams()` copies only keys present in an action's
`fields[]`. Writing an undeclared param would therefore be **dropped on save** —
producing a node that looks configured in the editor and runs unconfigured, the
most confusing failure available here.

So `FlowEditor.applyInspectorFields()` filters to declared keys and returns
whether anything actually landed, which is what lets the UI say "added"
truthfully instead of optimistically.

Two smaller decisions:
- **One undo point per pick**, not per field: the user performed a single action
  ("confirm this element"), so one Ctrl+Z must reverse it.
- **Expression mode is cleared** on written fields: a picked value is a literal,
  and leaving the toggle on would evaluate `#buy` as an expression.

---

## 9. Files

### Server
| File | Role |
|---|---|
| `src/core/BrowserMode.ts` | Per-user mode registry; refuses with a **reason key** (never a sentence) so the UI renders fa/en itself |
| `src/core/LocalBridge.ts` | Reverse-tunnel WebSocket server; frame codec; stream multiplexing |
| `src/core/BrowserAdapter.ts` | **The only seam that knows about modes** |
| `src/core/InspectorHub.ts` | Claim/submit handshake, field mapping, bounded inbox |
| `src/core/InspectorSocket.ts` | `/inspector/ws` push channel |
| `src/Routes/mode.routes.ts` | `/browser-mode/*` + `/inspector/*` |
| `src/pipeline.ts` | `ensureLocalContext` + **3 close guards** |

### Extension (MV3)
| File | Role |
|---|---|
| `extension/manifest.json` | Content scripts + `Ctrl+Shift+C` command |
| `extension/lib/ab-inspect.js` | **Generic** extraction core (no whitelist) |
| `extension/content/inspector.js` | Overlay, highlight, shadow panel, per-attribute checkboxes, Confirm |
| `extension/background.js` | Privileged `fetch` (avoids page CORS/CSP), session id, mode get/set |
| `extension/popup/*` | Shows what it is attached to; arms the picker |

### Dashboard
| File | Role |
|---|---|
| `public/js/inspector-client.js` | Receives picks; socket + poll; claim/release |
| `public/js/flow-editor.js` | `applyInspectorFields()`; claim on open, release on close |
| `public/js/app.js` + `public/index.html` | Mode switch in the shell header |
| `public/js/browser-view.js` | Crosshair now explains the Inspector flow |

### Agent
`tools/local-browser-agent.js` — **zero dependencies**, Node built-ins only, so a
user runs one file without an `npm install`. Finds Chrome/Edge/Chromium on
Windows/macOS/Linux, attaches to a running instance or launches one, and dials
out.

---

## 10. Two bugs worth recording

**The WebSocket GUID.** The agent hand-rolls RFC 6455 (to stay dependency-free).
I had written the magic GUID as `...95CA-5AB0DC85B11F`, transposing the `C` in
the RFC's `...95CA-C5AB0DC85B11`. That agent **could never have connected to any
server**, and no amount of re-reading it would have revealed a wrong digest.
Interop-testing it against the real `ws` server surfaced it immediately as
`bad websocket accept`. The constant now carries a warning, and a test pins the
digest to the RFC's own published example vector.

**`http.close()` and upgraded sockets.** Six tunnel tests timed out at 15s each
and looked exactly like a broken transport. Tracing showed the bytes had already
arrived — the hang was in teardown: `http.close(cb)` **never fires its callback
while an upgraded WebSocket socket is open**, because an upgraded socket is no
longer tracked as an idle HTTP connection. Terminating sockets first and not
awaiting `close()` took the suite from 91s of timeouts to 222ms of passes.

Both are lessons about probing rather than reasoning: neither was visible by
reading the code.

---

## 11. Running Local mode

```bash
# On the user's machine (Windows / macOS / Linux):
node tools/local-browser-agent.js \
  --server wss://your-server.example \
  --key    YOUR_API_KEY \
  --user   YOUR_USER_ID
```

Then pick **Local Browser** in the header switch. If no agent is connected the
switch refuses with `local_unavailable` and says how to fix it, rather than
silently running remotely.

Config: `BROWSER_MODE_DEFAULT`, `LOCAL_BROWSER_ENABLED`,
`LOCAL_BROWSER_CDP_PORT`, `LOCAL_BROWSER_CONNECT_TIMEOUT_MS` (see
`.env.example`).

---

## 12. Tests

| File | Tests | Covers |
|---|---|---|
| `tests/unit/extension-inspect.test.ts` | 20 | Generic extraction, `data-*`, no whitelist |
| `tests/unit/inspector-hub.test.ts` | 33 | Claim/submit, all 4 refusals, field mapping |
| `tests/unit/local-bridge-tunnel.test.ts` | 20 | Real agent ↔ real `ws` server over loopback; RFC vector |
| `tests/unit/inspector-client.test.ts` | 19 | Delivery rules on the real client file |

**92 tests**, all offline (no jsdom in this repo: sources are read as text and
asserted, or run in a `vm` sandbox against a hand-rolled `FakeEl`).

The tunnel tests are **interop** tests, not mocks — the real agent against the
real `ws` server the bridge uses. That is what caught the GUID bug.

### Spec §20: "prevent regression in current nodes"

The full suite caught 17 failures from this work, both real, both fixed:
- `icons.test.ts` — its "a new file slipped through" guard caught
  `inspector-client.js`; registered it rather than relaxing the guard.
- `picker-opens-real-chrome.test.ts` — 16 × `inspectorHint is not defined`; the
  harness evaluates `requestPick` as a source slice, so the new helper needed a
  declared dependency entry (the pattern that file already documents).

---

## Addendum — audit 2026-08-13: two defects this handoff did not know about

This document described the feature as complete, and the code it described was
mostly there. Two things it claimed were **not true at run time**, both found by
driving the product rather than re-reading it. Both are fixed; the tests that
prove it are named below so the next reader can check rather than trust.

### 1. «Confirm & Add to Node» never delivered anything

The requirement — a pick lands in the **active node**, session-based — was
implemented on both sides, and the two sides could not agree:

| side | id it used | where |
|------|-----------|-------|
| dashboard | `ui-<random>` (per browser tab, `sessionStorage`) | `public/js/inspector-client.js` |
| extension | `ext-<random>` (per installation, `chrome.storage.local`) | `extension/background.js` |

`InspectorHub.submit` compares them for equality:

```ts
if (!sessionId || sessionId !== session.sessionId) return { ok: false, reason: 'stale_session' };
```

Two independently minted strings are never equal, so **every** pick was refused.
The refusal was correct behaviour reached for the wrong reason, which is why it
never looked like a crash — the popup showed a plausible session id (its own) and
the user saw a generic failure.

**Fix:** the extension no longer authors a session. `claimedSessionId()` reads
`activeNode.sessionId` from `GET /inspector/session` immediately before
submitting, so the id it sends is the one the project is actually editing — and a
claim that moved while the user was hunting for the element is honoured rather
than overridden. The installation id is still reported to the popup, but under a
separate name (`installId`) and never as the claim.

**Why the guard is still safe:** its purpose is to stop a pick landing in a node
the user is no longer editing. That protection lives in the **claim**, not in who
authored the string — a submission with no claim open is still refused with
`no_active_node`, now without a round trip.

**Test:** `tests/unit/inspector-session-handoff.test.ts` — 9 tests. It runs the
real `background.js` in a `vm` with a fake `chrome`, routes its `fetch` into a
real `InspectorHub`, and drives a pick through the real `onMessage` handler.
Reverting `submitElement` to `getSessionId()` turns **4** assertions red.

### 2. The extension was absent from Remote mode

Line 29 of this document — «exactly one extension, works in both modes» — was the
requirement, and it held only in Local mode. In Remote mode Chromium is launched
with `--load-extension` pointed at `REAL_CHROME_EXTENSIONS_DIR`
(`profiles/extensions`), and **nothing in the codebase ever wrote the Inspector
there**. The directory did not even exist on a fresh clone, so the remote browser
launched with no Inspector at all, silently.

**Fix:** `src/core/InspectorExtension.ts` seeds the authored `extension/`
directory into `REAL_CHROME_EXTENSIONS_DIR` during `RealChrome.launch()`, before
`listExtensions` runs. Details worth knowing:

- The freshness check is a **SHA-256 content fingerprint**, not mtime, so a
  `git checkout` does not retrigger a copy — but changing `PORT` or `API_TOKEN`
  *does*, because the generated bootstrap text is part of the fingerprint.
- It writes a generated `bootstrap.config.js` so the popup inside a remote desktop
  is pre-configured. Those values are applied as **defaults only** — a value the
  user typed is never overwritten, on this launch or any later one.
- It **never throws**. A failure to seed logs and lets the browser start; an
  Inspector that is missing is worse than one that is missing *and* takes the
  browser down with it.
- `profiles/` is gitignored, so the repo stays clean.

**Verified in a real headed Chromium (Xvfb)**, not statically: the service worker
was live at `chrome-extension://…/background.js`, `ABInspect` / `ABSelector` were
present in the page, generic extraction returned
`["id=buy","href=/checkout","data-sku=SKU-1","data-anything=yes"]` — including a
`data-*` attribute nothing in this codebase has ever heard of, which is the
no-whitelist requirement — and the bootstrap storage read back
`{"baseUrl":"http://127.0.0.1:3000","hasKey":true,"userId":"local"}`. Idempotency
was exercised as fresh → unchanged → updated.

### Not a defect: the download-shelf «12/24»

For completeness, since it was investigated in the same pass and briefly written
into a code comment as a bug: the claim that the dashboard's download shelf lost
half of all real filenames was **wrong**, and has been retracted. The number came
from a probe launching Chromium without the product's environment. See
`docs/MEASURED-DECISIONS.md` § «The 12/24 that never existed» for the full
retraction and the corrected measurements.
