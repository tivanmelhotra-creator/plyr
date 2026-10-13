# S27 — phase 1 root-cause analysis (shared browser infrastructure), branch feat/profile-infrastructure (PR #76)

Scope: PHASE 1 ONLY (profiles, sessions, viewer, Local Browser <-> Browser Profiles, launch settings).
Phase 2 (Launch Browser / Continue Session / Success-Error-Timeout / retry) is NOT touched.
Status: analysis done and partly reproduced on a real server (Redis + Xvfb + openbox + x11vnc + websockify
+ Playwright chromium-1194, sandbox). NO code changed yet in this session.

## How a Chromium is started today (two independent launchers)

| Path | Launcher | user-data-dir | Registry of the live context | Session record |
|---|---|---|---|---|
| Local Browser (Turn on / Show browser / picker) | `RealChrome.launch()` (singleton, `RealChrome.context`) | `config.REAL_CHROME_USER_DATA_DIR` = `./profiles/chrome-profile` | `RealChrome.context` | NONE (not in BrowserSessions) |
| Browser Profiles (Open browser) | `ProfileBrowser.defaultLauncher` | `ProfileRegistry.dirOf()`: default -> `<PROFILES_DIR>/<user>/chrome-profile`, others -> `<PROFILES_DIR>/<user>/browser-profiles/<id>` | `ProfileManager.vipContexts[leaseId]` | `BrowserSessions` |
| Workflow run (no extensions) | `pipeline.ensureProfileBrowser` | same as Browser Profiles | `ProfileManager.vipContexts[leaseId]` | `BrowserSessions` (`job:<id>`) |
| Workflow run (extensions) | attaches to `RealChrome` | REAL_CHROME dir | `RealChrome.context` | lease `realchrome` only |

Ids: profile id = `ProfileRegistry` (`default` or `prf_<hex>`, meta `.plyr-profile.json` inside the dir);
lease/session id = `leaseIdOf()` (`default` / `named:<id>`); X window id = wmctrl; viewer = a browser tab
on `/desktop/chrome[?profile=<id>]` (one noVNC socket onto the ONE Xvfb display :99, it shows the whole desktop).
"Running" is decided by: Local Browser row -> `GET /browser/real/health` = `RealChrome.isRunning()` only;
profile panel -> `BrowserSessions` only. Two sources of truth.

## Root causes

1. **Viewer tab closes itself 1-2 s after a profile is opened (Local Browser off).**
   `ChromeView` (`/desktop/chrome`), after the VNC socket connects, polls `GET /browser/real/health?watch=1`
   every 700 ms and calls `handleSessionClosed()` -> `window.close()` when `running === false`.
   That endpoint reports ONLY `RealChrome`. A profile view has no RealChrome -> `running:false` on the first
   tick -> the tab closes. REPRODUCED: `/profiles/:id/open` -> 200, window on display, `/browser/real/health`
   -> `{"running":false}`. This is also why it "works" when Local Browser is on (hidden precondition).
2. **Turn off hangs / leaves inconsistent state with profile sessions open.**
   `POST /browser/real/close` -> `LiveBrowserSession.closeBrowser()` or `RealChrome.closeBrowser()`:
   closes pages one by one with no bound (`page.close()` on a page blocked by a dialog never returns), and
   never consults BrowserSessions (does not know about profile browsers / runs). The client's `busy='stop'`
   is only cleared when that request settles -> permanent "Stopping…". Profile windows stay up while the
   row says "Off" (REPRODUCED: after Turn off, 2 windows of profile browsers remain, row = Off).
3. **Two different "default" profiles.** Local Browser uses `./profiles/chrome-profile`; the registry's
   built-in `default` is `./profiles/local/chrome-profile`. Same label "Default", two user-data-dirs ->
   "Default Profile" / "chrome-profile.Default Profile" in Task View (BrowserWindowManager labels a window
   `basename(user-data-dir) · <Chromium profile name>`, i.e. `prf_aa91b811ffd7 · Default Profile`).
   Those labels come from directory names, not from the registry.
4. **"Your Chromium" / name 22 not shown in Chromium.** A new profile = new user-data-dir with Chromium's
   inner profile `Default`; nothing writes the display name into Chromium's own data
   (`Local State` -> `profile.info_cache.Default.name` + `Default/Preferences` -> `profile.name`), so
   Chromium shows its generic name. Independence itself is real: one process per user-data-dir
   (verified: `/proc/<pid>/cmdline --user-data-dir=` differs per profile).
5. **One viewer tab per selected profile.** `profile-manager.js openProfiles()` does
   `window.open('', '_blank')` per id. The desktop is one display, so N tabs show the same picture.
6. **"New profile" flashes a tab that closes.** Create works server-side (dir + meta, listed). The pre-opened
   tab is navigated to the profile view and then closed by cause 1; when open fails the tab is closed
   by the client as well. Profile is kept (correct) but the user sees a vanishing tab.
7. **Launch flags exist only for RealChrome** (`ChromeFlags.ts`, `/browser/real/flags`), held as process
   state; ProfileBrowser and pipeline have their own hard-coded arg arrays. No custom flags, no validation
   against app-controlled switches (`--user-data-dir`, `--remote-debugging-*`, `--headless`, `--profile-directory`).

## Target architecture (minimal change)

- `BrowserSessions` becomes the ONE source of live-browser state: RealChrome registers as session
  `realchrome` (createdBy `operator:local-browser`) on launch/close; profile browsers and runs already do.
- `GET /browser/sessions` (summary: id, profile name, visibility, dependents count — no paths, no URLs).
  The viewer's liveness poll uses it: close/"ended" only when NO session the view belongs to is open
  (profile view -> that profile's session; plain view -> any session). Show browser = attach to the
  existing viewer, never launch.
- Turn off = close the Local Browser session through the shared decision (`canClose` with requester
  `operator:local-browser`); refused (409, list of dependents) when a run depends on it; profile browsers
  opened from the panel are NOT closed by Turn off (different owner) and the answer says so.
  Every close is bounded (per-page timeout + context close timeout), always answers, UI always settles.
- Viewer: ONE named window (`window.open(href, 'aria-viewer')`) shared by Local Browser and Browser
  Profiles; opening more profiles reuses it and only raises the requested window.
- `core/LaunchSettings`: presets (Standard / Automation / Diagnostics), categorized options, Custom Flags
  parsed into an argv array (no shell), validated: app-controlled switches rejected with a reason,
  known conflicts reported. Used by ProfileBrowser (and RealChrome's existing catalogue stays the
  Local Browser's choice). Launch settings never change the profile id or its data dir.
- Profile display name written into the profile's Chromium data before launch (Local State info_cache
  name + Preferences profile.name), only for the inner `Default` profile of a registry-owned dir; the
  default/Local Browser dir is not rewritten.
- Window labels in Task View from the registry (user-data-dir -> registry name).
- Default profile data: NOT moved or deleted. Decision needed whether the registry `default` should point
  at `REAL_CHROME_USER_DATA_DIR` (one default) — non-destructive, needs the user's OK because the two dirs
  may both contain data today.

## Environment notes (sandbox)
- apt: xvfb openbox wmctrl redis-server x11-utils xdotool x11vnc novnc websockify; chromium-1194 from Playwright.
- `.env` used for the manual server: REAL_CHROME_ENABLED=true, API_KEYS_ENABLED=false, DESKTOP_AUTO_PROVISION=false.
- GitHub token NOT configured in this session (setup_github_environment failed) -> push to GitHub/PR #76
  needs the user to authorize GitHub. Genspark git backup works.

---

# S27 — IMPLEMENTED (phase 1 only; phase 2 code untouched except the minimal ProfileBuild hook)

## Changes (files)
- `src/core/SharedBrowsers.ts` (new): RealChrome registers in `BrowserSessions` as session `realchrome`
  (dependent `operator:local-browser`); `summarize()` for UI (names, counts, no paths/URLs);
  `closeContextBounded()` (per-page + context deadlines) used by every manual close.
- `src/core/RealChrome.ts`: opened/closed hooks into the shared registry; `stop()` / `closeBrowser()` bounded
  (pages closed in parallel, 2 s each) -> Turn off can no longer hang on a dialog-blocked page.
- `src/Routes/browser.routes.ts`: `POST /browser/real/close` (Turn off) decided by ownership: refused 409 when a run
  depends on the Local Browser; profile browsers are NOT closed and listed in `otherSessions`; 20 s server cap (504
  retryable). New `GET /browser/sessions`.
- `src/core/ChromeView.ts` (viewer): liveness from `/browser/sessions` (root cause 1); ends only after 2 empty polls;
  never `window.close()`s itself (shows "ended" + Relaunch); profile views / `attach=1` never launch a browser;
  the tab keeps its set of shown profiles (sessionStorage) and its VNC socket carries `?profiles=a,b`.
- `src/core/ProfileViewers.ts` + `DesktopProxy.ts`: `viewersOf()` — one socket attaches/detaches every shown profile
  (30 s grace kept; hold never released by closing the viewer).
- `src/core/LaunchSettings.ts` (new): presets Standard / Automation / Diagnostics, categorized options, Custom Flags
  parser (argv, quotes only group, no shell), validation (app-controlled refused, conflicts/duplicates reported,
  risky need `acknowledgeRisk`), hash.
- `src/core/ChromiumProfileName.ts` (new): writes registry name into `Local State` info_cache.Default + `Default/Preferences`
  (merge, atomic, corrupt files untouched) before launch -> Chromium shows "22", not "Your Chromium".
- `src/core/ProfileBuild.ts` (new) + `src/pipeline.ts` (3 lines): one build record for operator + runs; a run without
  options reuses an operator's visible browser (before: always "built differently").
- `src/core/ProfileBrowser.ts`: launcher takes validated args; display name; relaunch with other settings only without
  other dependents (`in_use_settings` 409 otherwise); bounded close.
- `src/Routes/profile.routes.ts`: `launch` in `/open` validated BEFORE hold/launch (400 / 409 needs_confirmation);
  `GET /profiles/launch-options`, `POST /profiles/launch-settings/validate`; response `settingsApplied`, `relaunched`.
- `src/core/BrowserWindowManager.ts` + `src/index.ts`: Task View labels windows with registry names; Local Browser dir
  labelled "Local Browser"; shutdown saves every profile browser's tabs (`reason: shutdown`).
- UI `public/js/profile-manager.js`: ONE named viewer tab (`aria-browser-viewer`) for every open/create/Show browser;
  Launch settings panel (preset, options, Custom Flags, live validation, risk tick). `public/js/workflow-files.js`:
  row reads `/browser/sessions` (shows profile browsers count), Show browser = attach only, Turn off always settles
  (25 s client cap) and says which profile browsers stay open. i18n keys added; CSS.

## Tests (actually run, sandbox: Redis 7, Xvfb+openbox+wmctrl+x11vnc+websockify, Playwright chromium-1194)
- tsc clean.
- unit: launch-settings (18 new), profile-manager-ui 12 (1 changed: one viewer; 1 new: launch settings sent),
  workflow-files-browser-switch 15, browser-options 85 (source check moved to ProfileBuild).
- FULL unit suite (4 chunks, 1 GB RAM): 3953 passed / 0 failed + real-chrome-shelf 177/177 after the fixture fix.
- FULL integration (real Redis): 427 passed / 9 skipped; api.test 2 failures only with the sandbox's local `.env`
  (API_KEYS_ENABLED=false for the manual server) — 8/8 pass without it.
- integration (real Redis): profile-routes 13 (3 new), profile-admission 21, coordinator 4, schedules 7, continuation 4.
- browser (real Chromium + Xvfb): profile-real-chromium 3/3 (1 new: Chromium name "22", preset+custom flag in the real
  /proc argv, no --headless, independent cookies, close one keeps the other, reopen keeps cookie, Task View names).
- real server e2e: `handoffs/2026-10-13_S27_e2e.txt`; viewer probe before/after: `handoffs/2026-10-13_S27_viewer-probe.txt`
  (ee94f6b: endedShown=true + /browser/real/health; now: viewer stays connected, polls /browser/sessions).

## NOT done / open
- Default profile duplication (Local Browser `./profiles/chrome-profile` vs registry `default` `./profiles/<user>/chrome-profile`)
  is NOT merged: both dirs can hold data; merging needs the user's decision (non-destructive plan: point registry `default`
  at REAL_CHROME_USER_DATA_DIR only when the per-user dir has no data, otherwise list it as a separate profile).
- Wait-cap policy for a scheduled run waiting on a busy profile: unchanged (waits until free) — not configurable yet.
- noVNC picture itself verified only via the probe (VNC canvas created, socket connected); no pixel check.
- `tests/unit/real-chrome-shelf.test.ts`: CORRECTION — not pre-existing. Its fake server had no `/browser/sessions`
  answer, so the viewer's new liveness poll fell into the fake's upload branch and counted as a 2nd concurrent upload
  (CI: `expected 2 to be 1`). Fixed in the fixture; 177/177 pass. (Locally it only looked like a hang: slow 1 GB box.)
- GitHub push / PR #76 update: GitHub token not configured in this sandbox; needs authorization.
