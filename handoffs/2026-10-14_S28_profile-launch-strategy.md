Historical. Superseded for phase 1 by handoffs/NEXT-SESSION-S31.md

# S28 — Browser Profiles: preferred Chromium launch strategy (branch feat/profile-infrastructure, PR #76)

Scope: align how Browser Profiles select their Chromium data with the Local Browser. Phase 1 only.
Phase 2 node logic is not touched.

## 1. What the code did before (inspected, not assumed)

| Launcher | File | user-data root | `--profile-directory` | Lifecycle |
|---|---|---|---|---|
| Local Browser | `core/RealChrome.launch()` (`playwright-extra` launchPersistentContext) | `REAL_CHROME_USER_DATA_DIR` (`./profiles/chrome-profile`) | **none** | singleton `RealChrome.context`, session `realchrome` |
| Browser Profiles | `core/ProfileBrowser.defaultLauncher` (`playwright`) | `ProfileRegistry.dirOf()` (one per profile) | **none** (refused in Custom Flags) | `ProfileManager.vipContexts[leaseId]`, BrowserSessions |
| Runs | `pipeline.ensureProfileBrowser` (`playwright-extra`) | `ProfileRef.userDataDir` (same rule) | **none** | same as Browser Profiles |

All three use the same mechanism: a persistent context on a root, with the inner profile left to Chromium. RealChrome's pref fixes,
`clearTabSessions`, `listProfileExtensions` and `ChromiumProfileName` all hard-coded `<root>/Default`.

## 2. Measurements (Chromium 1194, Xvfb)

1. **Shared root, second Playwright launch with another `--profile-directory`:** `Failed to create a ProcessSingleton`.
2. **Shared root, plain second invocation:** it is forwarded into the running process, and `Profile B` opens inside process A.
   `connectOverCDP` sees 1 context, so B cannot be leased, hidden or closed on its own.
3. **No `--profile-directory`:** after `last_used = "Profile 1"`, an unpinned launch opened `<root>/Profile 1`
   (chrome://version Profile Path + that profile's cookie), while the helpers wrote into `Default`. With
   `--profile-directory=Default`, it opened the right directory.

Conclusion: always pass `--profile-directory`. **One root per profile stays.** Concurrent, separately leased and visible
profiles need separate processes, and Chromium allows one process per root. This is the "separate roots technically
required" case. It is documented in code and in PROJECT.md 6.1, and pinned by a real-Chromium test.

## 3. Change (no new launcher)
- New `core/ChromiumProfileLocation.ts` is the selection rule for all three launchers. `resolveChromiumProfile(root)` pins the
  directory in `<root>/.plyr-chromium-profile.json`. An existing root is adopted with the directory it already used (`last_used`
  if it exists, otherwise `Default`). Nothing is moved or deleted. An unreadable pin is left untouched, and values are validated
  so a path cannot escape the root. `withProfileSelection(args, loc)` strips caller copies and appends exactly one
  `--profile-directory`. `verifyProfileSelected(loc)` is used for logging.
- RealChrome / ProfileBrowser / pipeline apply it. All `Default`-hard-coded helpers take the pinned directory (default arg
  `Default`). Launch logs show `profile-directory=<dir> (<source>)`. `RealChrome.profileLocation()` exposes the result.
- `ChromiumProfileName` writes the name for the pinned directory. The refusal text for `--profile-directory` in LaunchSettings was updated.

Identities: profile id / root / profile directory / display name. A rename changes only the name (unit test).

## 4. Tests (this sandbox)
- tsc clean. Unit: 168 files, 4142 passed (new `chromium-profile-location` 12; `chrome-tab-restore` guard updated).
- Integration (real Redis): 429 passed / 9 skipped (`profile-routes`: custom flag last user arg, then exactly one `--profile-directory`).
- Browser: `profile-real-chromium` 6/6 (3 new: chrome://version Profile Path for 2 simultaneous profiles, pin wins over
  `last_used`, adopted legacy root keeps its data, one-root-one-process evidence; run Profile Path checked).
  `local-browser-profile-selection` 2/2 (the real RealChrome: fresh root -> Default; existing `Profile 2` root adopted, no
  empty Default, prefs land in Profile 2; Browser Profile alongside).
- `pipeline-browser-options` 1 failure is **pre-existing**: it is identical with these changes stashed (the test reads
  `getVipContext('bo-user')`, while the pipeline keys by profile id `default`).

## 5. Open
- The two "Default" roots (Local Browser vs registry `default`) are still not merged. That needs the user's decision.
- The pre-existing `pipeline-browser-options` failure.
- Manual check on the real server: open a profile and look at chrome://version. Profile Path should be `<root>/Default`.
