# HANDOFF 16 — Element Picker: Automa panel parity + a persistent server browser

Continues `15-HANDOFF-element-picker-automa-research.md`. That doc ended at § 6.0
("the picker modal has never been rendered"), which HANDOFF 15's own successor
session closed. This doc covers the two requests that followed:

* **(A)** Compare Automa's Element Selector panel against ours and close the gaps.
* **(B)** Make the simulated browser *robust on a server* — real session
  persistence and anti-bot hardening, so sites stop nagging about cookies and
  stop treating us as automation.

---

## 0. Rules that governed this work

Unchanged from HANDOFF 13/14/15 § 0. The ones that actually bit:

| Rule | Where it bit |
|---|---|
| 0.3 no invented data in the UI | The session chip may not claim "signed in" before the server says so; it opens pessimistic. |
| 0.10 a picker separates hover from click, and always reports the match count | Candidate rows each carry their own count; hover computes none. |
| dark + English LTR is the target, `fa` must not break | The drag grip was 30 px off-centre under RTL (measured). |
| vanilla JS, CSP-safe (`script-src 'self'`) | Panel is DOM-built; no template engine, no inline handlers. |
| `public/**` = LF; `src/*.ts` keep per-file endings | `GlobalBrowser.ts` stays CRLF (377 CR lines, final `}` still without a trailing newline, exactly as at HEAD). |

---

## 1. (A) Panel parity — what Automa had, what we have now

Reference: the user's screenshot of Automa's panel floating over Gmail.
Inventory → gap list → result:

| Automa feature | Before | Now |
|---|---|---|
| Visible drag grip above the panel | head was draggable but unmarked | `.bvp-grip` (`#bvp-drag`), icon `move`, physically centred |
| `CSS Selector` dropdown | ✔ already | ✔ |
| Selector field + ↑ / ↓ | ✔ already | ✔ |
| Two tabs | ✗ flat list | `Attributes | Candidates` |
| `#1 Element` header | ✗ | `#N Element`, or `#N of C elements` when ambiguous |
| Picked tag / text | ✗ | `<div>` + text snippet on the same header row |
| Attribute **cards** (label above, boxed value) | ✗ two-column row | ✔ |
| Per-attribute copy button | ✗ | ✔ (`stopPropagation` so it does not also "use as selector") |
| Click attribute → selector | ✗ | `tag[name="value"]`, then re-verified over the wire |
| Keyboard: Space | ✔ already | ✔ |
| Keyboard: ↑ / ↓ | ✗ panel buttons only | ✔ on the focused stage |
| Footer naming the keys | ✗ | `.bvp-kbd` with `<kbd>` chips |

### Deliberate divergences

* **No "Blocks" tab.** Still refused (HANDOFF 15 § 2.3): building steps from
  inside the picker is the flow builder's job. The second tab is **Candidates**
  instead — strictly more useful here, because Automa shows one selector and *no
  match count at all*, so a brittle `:nth-of-type` path is indistinguishable from
  a good one. Ours lists alternatives, best-first, each with its own count.
* **Counts stay Latin digits in `fa`.** No digit-localisation helper exists in
  the project and existing fa strings already render `14 المان مطابقت دارد`.
  Localising digits only inside the picker would be the inconsistency.

### Defects found by rendering, not by reading

`tools/picker-panel-shot.js` (new) stubs `window.WebSocket` and pushes a
real-shaped `ready` → `frame` → `pick` sequence, so the panel renders with data.
Two measured bugs, both fixed and re-measured:

| Defect | Measured before | After |
|---|---|---|
| `.bvp-attrs { max-height: 190px }` scrolled the list while **231 px of panel sat empty** — the user scrolled past `class` to reach `aria-label` for nothing | `panel h: 516`, `overflowBottom: -231`, 3.5 of 6 cards visible | flex child, no cap; `panel h: 620`, `overflowBottom: -127`, all 6 cards, `clipped: [0,0,0,0,0,0]` |
| Drag grip off-centre in RTL — `inset-inline-start: 50%` anchors the *right* edge under RTL while `translateX(-50%)` is direction-blind, so they compound | `gripCentered: -30` (fa) — exactly the grip's own width | `left: 50%` (physical); `gripCentered: 0` in **both** en and fa |

Also: long candidates still ellipsise in a 306 px panel (`div[aria-label="Compose
a new message"]` clipped by 22 px), so the full selector is now the row's
`title`, and long attribute values likewise. A selector you cannot read is one
you cannot choose.

### Verified by driving, not by inspection

`UI_LANG=en|fa node tools/picker-panel-shot.js`, both `errors: []`:

* tab switch → `attrsHidden: true, candsShown: true`, tab badge `4`
* click candidate → field becomes `div[role="button"]`, count re-renders as
  `14 elements match — the selector is not unique.`, `verifySent: 1` (a real
  round trip, not a local guess)
* click `aria-label` card → `div[aria-label="Compose a new message"]`, count
  `Exactly 1 element — the selector is unique.`
* keyboard on the stage → `[{pickStep,up},{pickStep,down},{key,Space}]`
* forget session → chip `Signed out`, button disabled, disclosure text swaps back
* fa: panel at `x: 209` (left, as RTL requires), `selDir: ltr`, no clipping

---

## 2. (B) The persistent server browser

### What already existed

`playwright-extra` + `puppeteer-extra-plugin-stealth` were **already** wired into
`GlobalBrowser` via `chromium.use(stealth())`. The "use a proper package"
half of the request was already satisfied; the real problems were elsewhere.

### What was actually broken

| Problem | Fix |
|---|---|
| No cookie persistence — every session started signed out (`AUTH-GAP`) | Per-user Playwright `storageState` (cookies + localStorage) under `PROFILES_DIR/sessions/<id>.json` |
| A random, hardcoded Chrome 119–121 UA per context — an inconsistent fingerprint invites challenges | `realisticUserAgent()` derives the UA from the **real** `browser.version()`, strips "Headless", and returns `''` to fall back to Playwright's own default rather than lie |
| `navigator.webdriver` and automation client hints | `--disable-blink-features=AutomationControlled` + 3 more flags. JS patching cannot reach HTTP client-hint *headers*; the launch flag can |
| Nothing handled cookie-consent walls | `CONSENT_SCRIPT` / `installConsentAutoDismiss(page)` |
| An in-modal login died with the session | `saveAndCloseContext()` writes state before closing |
| A persistent session was a one-way door | `forgetSession()` + `{t:'forgetSession'}` over the socket + a UI button |

### Design decisions worth keeping

* **Consent dismissal is a named-CMP allowlist**, not greedy text matching:
  OneTrust, TrustArc, Quantcast, Cookiebot, Usercentrics, Didomi, Osano,
  CookieYes, Termly, Complianz, Borlabs, Google Funding Choices, `#L2AGLb`. The
  fallback requires **both** an accept-word match (en + fa) **and** a
  `cookie|consent|gdpr|cmp|privacy`-named ancestor within 6 hops. A greedy
  matcher would happily click "I agree" on a checkout form, or a "Continue" that
  navigates away from the page the user is picking from. Visibility-checked, max
  3 clicks, polls every 400 ms, stops after 8 s.
* **`isTrusted` guard in `PICKER_SCRIPT`.** CDP-dispatched input is trusted;
  `el.click()` is not. Without the guard the picker's capture-phase handler
  `preventDefault()`s the consent dismisser's own programmatic click into a
  no-op — the two features would silently cancel each other.
* **Path-traversal guard.** `userId.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64)`
  before it ever becomes a filename.
* **Write-tmp-then-rename** so a partial write can never replace a good session.
* **`getContext()` left alone.** Throwaway + random fingerprint is *correct* for
  workflow runs; only the interactive picker wants persistence.
* **The disclosure text is now conditional.** HANDOFF 15 § 6.1 required the
  picker to *say* it opens a fresh anonymous browser. Now that persistence has
  landed, that sentence would be a lie half the time, so it swaps to
  `bvp.savedNote` when `ready.signedIn` is true.

---

## 3. Files touched

| File | Change |
|---|---|
| `public/js/browser-view.js` | `tf()` interpolation helper; session chip + forget button; grip; tabs; `#N` element head; attribute cards + per-attribute copy + attribute→selector; candidates pane; stage ↑/↓; `copyText()`; `setSession()` |
| `public/css/styles.css` | `.bvp-grip` (physical centring), `.bvp-tabs/.bvp-tab/.bvp-tab-n`, `.bvp-pane`, `.bvp-elhead/.bvp-el-*`, attribute cards, `.bvp-cand*`, `.bvp-kbd`, `.bvp-session`, panel `max-height: min(calc(100% - 24px), 620px)`, panes uncapped |
| `public/js/i18n.js` | **17** new `bvp.*` keys in fa **and** en — parity 967 / 967, verified both directions |
| `src/core/BrowserProfile.ts` | **new** — persistence, fingerprint, consent |
| `src/core/GlobalBrowser.ts` | `ANTI_AUTOMATION_ARGS`; `getInteractiveContext()`, `saveAndCloseContext()` (CRLF preserved) |
| `src/core/LiveBrowser.ts` | exported `PICKER_SCRIPT`; persistent context; consent install; `signedIn` on `ready`; `forgetSession()`; `PickCandidate` type; `index` + `candidates` + `isTrusted` in the script |
| `src/core/BrowserStreamServer.ts` | `case 'forgetSession'` |
| `tests/unit/element-picker.test.ts` | +14 seam tests (parity + session) → 31 |
| `tests/unit/picker-drive.test.ts` | +5 real-Chromium tests (candidates, index, trusted click) → 16 |
| `tools/picker-panel-shot.js` | **new** — renders + drives the panel with data |
| `.gitignore` | `.ui-shots/` |

---

## 4. Verification snapshot

```
npx tsc --noEmit              → silent
node --check public/js/*.js   → OK
npx vitest run                → 39 files / 847 tests passed   (was 38 / 816)
i18n parity                   → fa 967 = en 967, 0 one-sided keys
line endings                  → public/** 0 CR; GlobalBrowser.ts 377/377 CR (matches HEAD)
picker-panel-shot en          → gripCentered 0, panelH 620, overflowBottom -127, errors 0
picker-panel-shot fa          → gripCentered 0, panel x 209 (left), selDir ltr, errors 0
```

---

## 5. Backlog for the next session

Ordered. Nothing here is blocked.

* **§ 5.1 — Fold `render()`'s pick-card onto the same panel.** Carried from
  HANDOFF 15 § 6.2 and now *more* worth doing: the modal panel has cards, tabs,
  candidates and a match count that the inline card in `render()` does not. Two
  picker UIs is one too many.
* **§ 5.2 — Verify button beside the crosshair in the node** (HANDOFF 15 § 6.3):
  count matches for a selector already in the field without opening the modal.
* **§ 5.3 — Session management outside the picker.** The forget button only
  exists inside the modal. A user who signed a server browser into an account
  should be able to see and clear that from Settings.
* **§ 5.4 — Prove persistence end-to-end.** Everything about `storageState` is
  currently pinned by *static* tests. A real test would set a cookie, close the
  session, reopen, and assert it came back. Needs a local fixture server, not a
  live site.
* **§ 5.5 — Consent dismisser against real pages.** The allowlist is verified by
  grep only. No CMP has actually been dismissed in a test.
* **§ 5.6 — Z-order.** `.fe-ctxmenu` 1200 / `.fe-prompt` 1003 / `.fe-addnode`
  1002 sit above the picker's 800. Low risk, still wrong.
* **§ 5.7 — Carried-over audits** (HANDOFF 15 § 6.6): the `click` node audit and
  the G5 / G9 / G3 / G11 / G12 / G2 gaps.

## 6. Loose notes

* `Icons.svg('close')` fails — `close` is an alias; only registry keys are legal.
  Available and used here: `move`, `cookie`, `copy`, `check`, `eye`, `x`.
* `grep -c $'\r'` exits **1** when the count is 0 — never chain it with `&&`.
* `t()` has no interpolation. `tf(key, {n, c})` was added locally to
  `browser-view.js` because `#{n} of {c}` and `المان #{n} از {c}` do not share a
  word order, so the numbers must go *into* the translated string.
* When locating the picker's handlers in `browser-view.js` from a test, use
  `lastIndexOf` — `render()` binds `stage` keydown first and comes earlier in the
  file. (This cost one red test run.)
