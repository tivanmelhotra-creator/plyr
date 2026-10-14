# S30 — Phase 1 report (owner's brief "Task(Pull_76).md", section 14 format)

Branch: `wip/s29-branch-model` (= next head of `feat/profile-infrastructure`, PR #76). PR #76 NOT merged.
Tested in a Linux sandbox only (Debian 13, Node 22, Redis 7, Xvfb + openbox, Playwright Chromium 1194). **Nothing was run on Windows.**

## 1. Git state and the three re-created files
- `main` = `6094e8b`. The branch is 71 commits ahead of main; 118 files changed (+12 494 / −289).
- Commit 6e93863 (S28) is in the history. The 3 files re-created after the earlier reset —
  `src/core/ChromiumProfileLocation.ts`, `tests/unit/chromium-profile-location.test.ts`,
  `tests/browser/local-browser-profile-selection.test.ts` — matched the brief's intent with one difference, now corrected:
  S28 *pinned* a folder through a pin file and fell back to `Local State.last_used`. The brief (section 2) says
  "never rely on Local State". Now a registry profile always gets its folder from the registry
  (`resolveChromiumProfile(root, folder)` → source `registry`). No pin file is written and Local State is not read.
  Pin/adoption is used only for legacy roots (Local Browser, old profiles), so their data is found where it already is.
- GitHub: S29 was pushed to PR #76 (048f4ba). The S30 commits are **not pushed**: the GitHub authorization was revoked;
  it needs a Reconnect.

## 2. Root causes (section 1), with evidence
| Item | Root cause | Evidence / fix |
|---|---|---|
| No `--profile-directory`, helpers assumed `Default` | All three launchers called `launchPersistentContext(root)` with no flag | S28: `/proc/<pid>/cmdline` had no flag. Now `withProfileSelection` adds exactly one `--profile-directory`; real test checks argv and chrome://version |
| `last_used` decides | Chromium opens `Local State.profile.last_used` when no flag is given | Real test: `last_used` set to "Profile 7", Profile Path still `<root>/profile-001` |
| One root = one process | Chromium ProcessSingleton | Real test: a 2nd launch on one root fails with `ProcessSingleton`. Therefore branch = root, one running profile per branch |
| Turn Off hang | Pages closed one by one without a deadline | S27 bounded close; S30 real test: Turn Off answers < 25 s with 2 profile browsers open |
| One display tab per profile | `window.open('', '_blank')` per id | S27: one named viewer tab (`aria-browser-viewer`); UI test |
| Two "Default" folders | Local Browser `./profiles/chrome-profile` vs registry `./profiles/<user>/chrome-profile` | NOT merged (section 12). `tools/default-folders-report.mjs` reports them (metadata only). Both folders are absent in this sandbox; the owner must run it on Windows |
| Fixed, unvalidated flags | Hard-coded arrays | S27 `core/LaunchSettings` (presets, custom flags as argv, app-owned switches refused) |
| No project extension in new profiles | ProfileBrowser kept Playwright's `--disable-extensions` and passed no `--load-extension` | S29 fix; real test: the extension's service worker runs in a new profile |
| Local Browser does not recognize Browser Profiles | Two sources of truth (RealChrome not in BrowserSessions) | S27 one session registry; real test: `/browser/sessions` lists "Local Browser", "Shop A", "Shop B"; the Local Browser row counts profile browsers |
| Task View stale cards / labels | Labels built from folder names; old entries kept | Windows re-read every time; names come from the registry; real test: a closed profile has no card, the open one keeps its name |
| Close-button ownership unclear | Turn Off did not know about profile browsers | Turn Off = Local Browser only (409 if a run depends on it); profile Close = that profile only, refused while another dependent exists; real tests |
| Color / icon not verified | MEASURED: Chromium gives every new profile the same avatar (IDR_PROFILE_AVATAR_26) and the same color | Each profile now gets its own icon + color, derived from its folder; the panel shows the same color; real test reads them back after Chromium ran |
| "Profile 4" / "Your Chromium" | The display name is per root and was never written | Registry name written into Local State + Preferences of THAT folder; real test: name "22" |
| (found S30) Unsafe boot cleanup | Boot deleted EVERY `SingletonLock` under PROFILES_DIR, including one held by a live browser | Replaced: `core/OrphanBrowsers` (see 3) |
| (found S29) Session list showed `branch:user/branch-003` | Branch sessions carry no profile id in their key | `profileIdOfSession` uses the running profile of the branch |

## 3. Decisions (section 13)
- **One code path or two?** One. Local Browser (RealChrome) and Browser Profiles keep their launchers, but both use the same data-selection rule (`ChromiumProfileLocation`), the same session registry (`SharedBrowsers`) and the same viewer. No third launcher. Runs use the same rule in `pipeline.ensureProfileBrowser`. Reason: removing RealChrome would lose its extension/picker/consent behaviour, which section 12 says to keep.
- **Busy branch: message or queue?** Message only (`branch_busy`, names the running profile, offers to show it). No queue for manual opens. Reason: a person opening a browser wants it now. A queue would open a window later, unexpectedly, and could take the branch from a scheduled run. Scheduled runs already wait through the lease.
- **Overlapping schedules on one branch:** the later run **waits** for the first to finish. It is never refused and never started in parallel. Shown **before saving** (409 `schedule_overlap`, behaviour `wait`; saving needs `acceptOverlap`). Reason: refusing would silently skip a planned run; waiting keeps both, in order. Real test: B logs `waiting(in_use)`, starts only after A ends, with no 2nd Chromium.
- **Reservation at run end:** kept until `max(window end, real end)`, the same for every workflow. Reason: it protects the next run from a late-starting browser, and a run that overruns keeps its profile. The cost is that the profile frees a few minutes later (at most the end margin, default 10 min).
- **Creation UI:** inside the existing Browser Profiles panel (Workflow Files drawer). "New profile" opens a form with a branch selector: "New branch", existing branches, and "Add an existing folder (outside Aria)…". The word "branch" is kept, as the owner confirmed. No layout change elsewhere.
- **Default base directory:**
  Windows `%LOCALAPPDATA%\AriaBrowser\branches`: per-user, writable without admin, not roaming, not moved by OneDrive Known-Folder-Move, a different subtree from `…\Google\Chrome\User Data`.
  Linux `$XDG_DATA_HOME/aria-browser/branches` (default `~/.local/share/aria-browser/branches`): the XDG place for app data, not `~/.config/chromium`.
  Linux default created as a normal user (uid 1000): OK. Windows not verified.
- **Migration:** existing roots are adopted where they are (legacy branches, `legacy: true`). Their folder is the one Chromium already used (`last_used` / `Default`, pinned once). Nothing is moved, copied or deleted. Folders from outside Aria are added only after an explicit warning and a separate confirmation (`external: true`). Deleting such a branch only forgets it; its data is kept.
- **Crash leftovers (section 7):** a Chromium process on an Aria root with no live Node ancestor is stopped (SIGTERM, then SIGKILL). A lock is removed only when no live browser holds that root. Never touched: browsers of this server, of another server, and any browser outside Aria's folders. Windows listing (PowerShell CIM) is not tested; if listing fails, nothing is killed.

## 4. Files changed (phase 1 work)
New core: `BranchRegistry`, `BranchBase`, `BranchPolicy`, `ProfileIndex`, `ProfileRegistry` (facade), `ChromiumProfileLocation`, `ChromiumProfileName` (+look), `OrphanBrowsers`, `BrowserLifecycle` (+`applyAfterRun`), `ProfileFailureReports`, `ProfileBrowser`, `ProfileAccess`, `SharedBrowsers`, `BrowserSessions`, `LaunchSettings`, `ProfileBuild`, `ProfileLease`/`ProfileReservations`/`ProfileCoordinator`.
Changed: `src/index.ts` (boot cleanup, pre-run check, after-run), `src/pipeline.ts` (explicit folder, no silent mkdir), `RealChrome.ts`, `BrowserWindowManager.ts`, `ChromeView.ts`, routes `profile.routes.ts` (branches, deletion scan/delete, external add, base dir, reports), `user.routes.ts` (activation/schedule checks), `browser.routes.ts` (Turn Off, sessions), `SettingsCatalog`/`config` (`BRANCH_BASE_DIR`, margins, idle).
UI: `public/js/profile-manager.js` (branch chooser, grouping, delete with 3 s hold, external dialog, colors), `workflow-files.js`, `views.js`, `i18n.js`, `styles.css`.
Tools: `tools/default-folders-report.mjs`. Full list: `git diff --name-status main...HEAD`.
CI configuration not changed; the browser tests are not enabled in CI.

## 5. Test matrix (Linux = tested in the sandbox; Windows = NOT tested for every item)
Totals: unit + integration **4616 passed, 9 skipped, 0 failed**; real Chromium **18 passed**, plus 1 pre-existing failure (see 6). Raw output: `handoffs/2026-10-14_S30_browser-tests.txt`.

| Section 11 item | Test | Linux | Windows |
|---|---|---|---|
| Create branch+profile, opens in display tab, data persists | browser/profile-real-chromium (selection; 22), integration/branch-model | ✅ | not tested |
| Two branches at the same time, separate control | browser/turn-off-and-show (1), profile-real-chromium | ✅ | not tested |
| Two profiles in one branch: refused/redirected, no 2nd process | profile-real-chromium (branch model) | ✅ | not tested |
| Running profile opened again: existing window, nothing launched | profile-real-chromium (re-open raises ITS window), turn-off-and-show | ✅ | not tested |
| Overlapping schedules, one branch: waits; shown before saving | turn-off-and-show (2, real run), integration/branch-activation (409 before save) | ✅ | not tested |
| Turn Off with several profiles: completes, profile browsers named + kept | turn-off-and-show (1) | ✅ | not tested |
| Show Browser after the display tab closed: same session | turn-off-and-show (1); UI attach-only: unit/workflow-files-browser-switch | ✅ (server side; noVNC picture not pixel-checked) | not tested |
| Explicit `--profile-directory`; Profile Path = `<branch root>/<folder>` | profile-real-chromium (selection, branch model) | ✅ | not tested |
| `last_used` elsewhere changes nothing | profile-real-chromium (selection) | ✅ | not tested |
| Branch ids not reused | integration/branch-model, unit/profile-infrastructure | ✅ | not tested |
| Delete: blocked by active / scheduled; ok after reassign; 2.5 s nothing; 3 s deletes; profile starting during hold cancels | integration/branch-model, unit/branch-delete-hold | ✅ | not tested |
| Enable with missing folder refused + report | integration/branch-activation | ✅ | not tested |
| Save schedule with missing profile refused | integration/branch-activation | ✅ | not tested |
| Folder deleted outside Aria, then run: fails cleanly, `profile_broken`, notified, no empty folder | integration/branch-run-profile-broken | ✅ | not tested |
| Base dir change moves nothing; new branches in new base | integration/branch-model | ✅ | not tested |
| Keep browser open: honoured after success, ignored after error | turn-off-and-show (3, real Chromium) | ✅ | not tested |
| New profiles have the project extension | profile-real-chromium (extension) | ✅ | not tested |
| Defaults + validation, Windows and Linux paths | unit/branch-base (Windows path shapes checked as strings on Linux) | ✅ / shape only | on-disk not tested |
| Extra: crash leftovers, external folder, per-profile look, stale Task View card | browser/orphan-browsers, integration/branch-model, profile-real-chromium | ✅ | not tested |

## 6. `pipeline-browser-options` on main (exact output)
File: `handoffs/2026-10-14_S29_pipeline-browser-options-on-main.txt`. On main (6094e8b), with `vitest.browser.config.ts`:
```
 × runPipeline applies Launch Browser options > options reach the real browser, and changing them relaunches the reused VIP browser 542ms
   → Cannot read properties of undefined (reading 'evaluate')
TypeError: Cannot read properties of undefined (reading 'evaluate')
 ❯ read tests/browser/pipeline-browser-options.test.ts:58:54
      Tests  1 failed | 1 passed (2)
```
Cause (not fixed; outside this brief): the test looks up `pm.getVipContext('bo-user')` (the user id), but `ensureProfileBrowser` keys contexts by PROFILE (`profile?.id || 'default'`, main `src/pipeline.ts:667-671`). Same result on this branch.

## 7. Remaining risks and blockers
- **Windows not tested at all.** At risk: path handling (`\`, drive letters), the process listing for crash cleanup (PowerShell), the default base directory creation, and Chromium lock files.
- GitHub reconnect needed to push the S30 commits to PR #76.
- The two Default folders are not merged (by instruction). Until the owner decides, the registry's "Default" and the Local Browser remain two separate roots.
- The noVNC picture in the viewer was checked by probe only, not pixel by pixel.
- An external (outside Aria) branch whose profile is opened by Aria will have its Chromium data changed by use. The user is warned before adding it; nothing is ever deleted.
- The per-profile color uses Chromium's `browser.theme.user_color`. Chromium versions without it ignore it; the icon still differs.

## 8. Manual steps for the owner on Windows (expected result after each)
1. Pull the branch, `npm ci`, start Aria. Expected: the log says `Checking for leftover browsers and stale locks...` with no error.
2. Settings → Workflow Runs: the base directory field is empty, so the default `C:\Users\<you>\AppData\Local\AriaBrowser\branches` applies. Expected: after the first new branch, that folder exists and contains `branch-00N`.
3. Browser profiles → New profile → "New branch" → name "Shop A" → Create. Expected: one viewer tab opens; the profile shows a colored dot; the folder `…\branches\branch-00N\profile-001` exists.
4. In that browser open `chrome://version`. Expected: **Profile Path = `…\branches\branch-00N\profile-001`**, and the command line contains `--profile-directory=profile-001`.
5. New profile → choose the SAME branch → "Shop B" → Create (while Shop A is open). Expected: no second browser; the message names "Shop A" and offers to show it.
6. New profile → "New branch" → "Shop C". Expected: Shop A and Shop C run at the same time, with different avatars and colors in Chromium's profile button.
7. Turn on the Local Browser, then Turn off. Expected: it answers within seconds; Shop A/C stay open; the message names them.
8. Close the viewer tab, then press Show browser. Expected: the same windows come back; nothing new starts.
9. In Shop A, sign in somewhere; close it; open it again. Expected: still signed in.
10. Delete branch (of Shop C) while a workflow that uses it is active. Expected: blocked; the workflow is named. Deactivate it → Delete → hold 2 s and release: nothing happens. Hold 3 s: deleted, and the folder is gone.
11. Run `node tools/default-folders-report.mjs`. Expected: name, size, last-used time and cookies/login yes/no for both Default folders. Nothing is changed. Send the output to decide on merging.
12. Kill the Aria process (Task Manager) while a profile is open, then start Aria. Expected: the log says `Stopped 1 leftover browser process(es)`, and the profile opens again normally.
