# S33 — Turn on / Turn off removed from the UI, "Chromium Session Closed" dialog removed, viewer self-close

Branch `feat/profile-infrastructure` (PR #76). Not merged, not closed, **not pushed**.
Start `0618d5b` (verified). Commits: `0f1ed81` (UI), `4f1cd0c` (viewer), `28f40cf` (real-Chromium tests), `dea2327` (layout check), plus this report.

## 1. Removed from the UI
| File | Removed |
|---|---|
| `public/js/profile-manager.js` | Turn on / Turn off buttons (`.pm-power`, `.pm-turn-on`, `.pm-turn-off`), the result list (`.pm-off-result`: Closed / Still open / Turned off), `turnOn()`, `turnOff()`, `offLine()`, the client `api.turnOff`, the `DEFAULT_ID` constant (only Turn on used it). Nothing opens the default profile by itself; profiles open by name through Open. |
| `public/js/i18n.js` | 16 keys: `pm.turnOn`, `pm.turnOnSel`, `pm.turnOnDefault`, `pm.turnOff`, `pm.turningOff`, `pm.turnOffHint`, `pm.turnOffSlow`, `pm.offClosed`, `pm.offKept`, `pm.offUsedBy`, `pm.offFailed`, `pm.offNothing`, `pm.offDone`, `pm.offClosedN`, `pm.offKeptN`, `pm.offError`. |
| `public/css/styles.css` | `.pm-power`, `.pm-power > .btn`, `.pm-off-result` (+ `[hidden]`), `.pm-off-line.is-*` and their comment (7 rules). |
| `public/js/workflow-files.js` | Comments only (text that described Turn on / Turn off). |
| `src/core/ChromeView.ts` | The "Chromium Session Closed" dialog: markup `#ended` (`.endedcard`, Close Tab `#btnendedclose`, Relaunch `#btnendedreopen`), its CSS (`#ended`, `.endedcard`, `.endedicon`, `.endedbtns`, `.btnclose`, `.btnreopen`), both click handlers, `handleSessionClosed()`/`sessionClosedHandled`. The dialog had no translation keys (its text was in this file only). The "Close browser" item in the drawer no longer shows anything itself: the session watch decides. |
| `tests/unit/chrome-view.test.ts`, `tests/unit/browser-profiles-section.test.ts` | Tests of the removed pieces replaced by tests of their absence. |

Kept: `POST /profiles/turn-off` and its 8 integration tests (`tests/integration/profile-open-turn-off.test.ts`) plus 1 real-Chromium test. No route was removed or changed.
Per-profile Open / Close / Release / Rename / Restore tabs / Launch settings are unchanged.

## 2. When the viewer closes itself (`src/core/ChromeView.ts`)
- `pollBrowserHealth()` (line 2249), called every `WATCH_MS = 700` ms (2162) from `watchOnce()` (2295), only after the desktop connected.
- Source: ONLY `GET /browser/sessions?watch=1`. `/browser/real/health` and every other route play no part.
- "Live for this viewer" = `liveForThisViewer()` (2244): visible sessions whose `profileId` is in this tab's set (`viewProfiles`, the profiles it was opened for; sessionStorage). A viewer without a set (`attach=1`) counts every visible session.
- End = two consecutive successful answers that both say zero, the second at least `VIEWER_END_CONFIRM_MS = 2000` (2241) after the first (2268). A failed, non-OK or malformed answer resets the count (2270 and the `!j.success` branch).
- `endViewer()` (2201): `window.opener` set (2210) → `window.close()`; if that is refused, or there is no opener → `body.viewer-gone` = an empty page, no text, no buttons (CSS line 663).
- Today's case: the viewer is opened by a script (`profile-manager.js` 49: `window.open('', 'aria-browser-viewer')`, then navigated), so `window.opener` is set and the tab closes itself (test a: opener=true, closed). A tab opened by hand (address bar) gets the empty page (test d).
- One of several profiles closes → live > 0 → nothing happens; its window disappears from the shared desktop and it leaves the viewer's set (test b).

## 3. Tests
| Case | Result |
|---|---|
| Unit: removed strings absent (source + jsdom DOM) | RUN — pass (`chrome-view` 21, `browser-profiles-section` 7) |
| Rendered DOM in real Chromium (viewer + Browser Profiles panel, hidden elements and title/aria-label/placeholder included, no script source): none of "Turn on", "Turn off", "Chromium Session Closed", "Close Tab", "Relaunch" | RUN — pass |
| `POST /profiles/turn-off` still exists and works | RUN — pass (8 integration + 1 real Chromium) |
| a. one profile, window closed from outside (wmctrl -c) → viewer tab closes itself | RUN — pass: closed **2825 ms** after the window was closed |
| b. two profiles, one closed from outside | RUN — pass: viewer open, set `[A,B]` → `[B]`, B's process alive, no dialog, no empty page |
| c. failed probes | RUN — pass: answers `real, 500, network-error, zero, malformed, real…` plus `/browser/real/health` false every time → viewer did NOT close |
| d. viewer opened by hand, last browser closed | RUN — pass: `{"text":"","visibleButtons":0,"visibleElements":0,"title":""}`, tab not closed, no dialog |
| Whole unit + integration suite | RUN — 4628 passed / 9 skipped (same 9 as before) / 0 failed |
| Real Chromium suite | RUN — 25/25 (6 files) |
| Docker (`./plyr dev-docker`) | NOT RUN (no Docker in the sandbox) |
| Windows | NOT RUN |

Note on a–d: the profile browsers, `/profiles/*` and `/browser/sessions` are real, and the viewer page is the real `chromeViewHtml()` in a second real Chromium. Only noVNC's `rfb.js` is a stub that reports "connect" (no VNC server in the test). The noVNC picture itself is not part of these tests.

## 4. Layout (`tools/s33/layout-check.mjs`, zoom 100%, deviceScaleFactor 1)
- 1440 / 900 / 360 px: Open, Close, Release, Rename, Restore tabs, Launch settings, New profile — each visible, inside the drawer, reachable (the element at its centre is the button after scrolling) and enabled. Horizontal overflow: none. Removed elements present: none.
- Same arrangement as before. The removed Turn on/off row was 40 px high, so Open is now 40 px higher (292 vs 332 px inside the section). In both versions the action row sits below the first view of the 304 px section and is reached by scrolling the section; this did not change.

## 5. Open items for the owner
1. Push: nothing pushed. Commits stay local until you say so.
2. With nothing selected, Open stays disabled (as before): every profile is opened by ticking its name. If you want a per-row Open button instead of tick + Open, that is a separate change (not done; not requested).
3. "Close browser" in the viewer's drawer still closes the RealChrome session through `/browser/real/close` (unchanged). If that is now the last browser, the viewer ends through the rule above.
4. The action row is below the first view of the profile section at a window height of 800 px (unchanged from before). Not changed here.
5. Docker and Windows remain to be run by you.
