# NEXT SESSION (S31) — read this first

This is the hand-over for the next agent session. It says exactly where PR #76 (phase 1, browser profiles)
stands against the owner's brief `Task(Pull_76).md`: what is done, why it was done that way, how it
works, what is still open, and the order of the next steps.

Companion files:
- `handoffs/2026-10-14_S30_phase1-report.md`: the formal report in the brief's section-14 format
  (root-cause evidence, test matrix, 12 Windows manual steps). **This file does not repeat its tables**; it
  explains them and adds the "how to continue".
- `handoffs/2026-10-14_S30_browser-tests.txt`: raw real-Chromium test output.
- `handoffs/2026-10-14_S29_pipeline-browser-options-on-main.txt`: the pre-existing failure, on main.
- The owner's full brief + chat transcript (local only, never pushed; the repo is PUBLIC):
  `git show local/session-archive:2026-10-14_S29_conversation.txt.gz | gunzip | less`
  (brief text: search `## 0. Current state`).

---

## 0. Ground rules the owner set (do not break them)
1. **Do NOT merge PR #76.** The owner merges; Windows manual checks are pending (owner-run) and do not block the merge.
2. Push only after the owner confirms GitHub access. (Confirmed in S30; pushed, see §1.)
3. The two "Default" folders are deferred and out of scope for PR #76 (the owner deleted the containers that held them).
4. No second launcher, no CI changes, the browser tests stay out of CI, no unrelated UI layout changes.
5. Small, reviewable commits. **The sandbox resets often**: commit and `ProjectBackup` after every step,
   and give the owner the backup link. Restore = download the latest backup, untar into `/home/user`, `npm ci` if node_modules is missing.
6. Speak to the owner in Persian (fa); code, comments and commits in English.

## 1. Git state at the end of S30
- Work branch: `wip/s29-branch-model`. PR #76 head = `feat/profile-infrastructure`. **Both point to the same commit after S30's push.**
- `main` = `6094e8b` (unchanged). PR #76 is OPEN and NOT merged.
- Local-only branch `local/session-archive` holds the transcript (it lives in `.git`, so it is inside every backup).
  **Never push it.** Its push remote is set to an invalid name on purpose.
- Last backup link: see the final message of S30 (newest first; older links still work).

## 2. Environment setup after a sandbox reset (≈2 min)
```bash
cd /home/user/webapp
[ -d node_modules ] || npm ci
sudo apt-get install -y -q xvfb redis-server openbox wmctrl x11-utils xdotool \
  || (sudo apt-get update -q && sudo apt-get install -y -q xvfb redis-server openbox wmctrl x11-utils xdotool)
npx playwright install chromium && sudo npx playwright install-deps chromium
redis-server --daemonize yes
npx tsc --noEmit -p .
npx vitest run tests/unit tests/integration                          # ~5 min, expect 4616 pass / 9 skip
npx vitest run --config vitest.browser.config.ts tests/browser/profile-real-chromium.test.ts \
  tests/browser/turn-off-and-show.test.ts tests/browser/orphan-browsers.test.ts \
  tests/browser/local-browser-profile-selection.test.ts               # ~2 min, expect 18 pass
```
Pitfalls learned in this work (each one cost time):
- A HEADLESS Chromium takes no `SingletonLock`. Lock/process tests must be headed, on Xvfb.
- `SingletonLock` is a **symlink** (`<host>-<pid>`). `fs.existsSync` follows it and returns false; use `lstat`.
- Never run `pkill -f <pattern>` with a pattern that also appears in your own shell's command line: it kills the tool call.
- Run long test runs with an explicit `timeout`, and grep the results; the tool output is truncated.

## 3. The model that was built (what the next agent must understand)
- **Branch** = one Chromium user-data root `<base>/branch-NNN` (ids from an increasing counter, never reused).
  **Profile** = a folder `profile-NNN` inside it, selected ONLY with `--profile-directory`.
  Rule: one running profile per branch; different branches run in parallel. Reason: Chromium allows one process per root (measured: `ProcessSingleton`).
- Four identities, never mixed: Aria profile id `prf_<hex>` · branch id `branch-NNN` · folder `profile-NNN` · display name (free text, duplicates allowed).
- Registry: `src/core/BranchRegistry.ts` (file `<PROFILES_DIR>/<user>/branches.json`). `ProfileRegistry` is a compatibility facade:
  `dirOf()` = the branch root; `profilePathOf()` = `<root>/<folder>`.
- Lock key: one per branch (`branch:<user>/branch-NNN`), read synchronously through `ProfileIndex` (`leaseIdOf`, `resolveRunProfile`).
- Every launch: `launchPersistentContext(<root>)` + exactly one `--profile-directory=<folder>`
  (`ChromiumProfileLocation.withProfileSelection`). A registry profile never consults Local State or the pin file.
- Legacy roots (Local Browser `./profiles/chrome-profile`, the old Default, old named profiles) are **adopted in place** as `legacy` branches:
  their folder = what Chromium already used (pinned once). Nothing is moved.
- Base directory: `BRANCH_BASE_DIR` (Settings → Workflow Runs). Default: Windows `%LOCALAPPDATA%\AriaBrowser\branches`,
  Linux `$XDG_DATA_HOME/aria-browser/branches`. `core/BranchBase` validates it. Changing it only affects branches created afterwards.

## 4. Brief, section by section: DONE / OPEN, with why and how
Legend: ✅ done + tested on Linux · 🟡 done, but not verified where the brief requires it · ❌ open.
**Every item is NOT TESTED ON WINDOWS** (no Windows machine in the sandbox). That is the main open item (§5).

### §0 Current state
- ✅ Git verified; the 3 re-created S28 files were checked. The one difference (pin file / `last_used` fallback) was corrected:
  registry profiles use the registry folder only.
- ✅ `pipeline-browser-options` fixed in S31 (context read by profile id `'default'`, and `ProfileBuild.buildCompatible` relaunches when run-specific options are cleared).

### §1 Root causes: all addressed (evidence in the S30 report, section 2)
- ✅ **"Two Default folders"**: deferred by the owner and out of scope for PR #76 (the owner deleted the containers that held them). `tools/default-folders-report.mjs` is kept unchanged.
- ✅ The rest: explicit `--profile-directory`, `last_used` ignored, one process per root, Turn Off bounded, one viewer tab, flags validated,
  extension in new profiles, one session registry, no stale Task View cards, close ownership, per-profile icon + color, Chromium display name.

### §2 Target model: ✅ fully (see §3 above)

### §3 Settings / base directory
- ✅ Per-OS default, validation (absolute; not a drive root; not "User Data"; not OneDrive/Dropbox; not a Chromium data folder; writable), moves nothing.
- ✅ Reservation margins before/after (default 10/10) are global settings.
- 🟡 "Verify the defaults by creating them as a normal user on Windows **and** Linux": Linux verified (uid 1000). **Windows OPEN** (Windows manual step 2).
- ✅ "Remove `$root` from global settings": **resolved** — there is no `$root` setting in the app; the base directory setting is `BRANCH_BASE_DIR`.

### §4 Creating a branch / profile: ✅
- UI: Browser Profiles panel → New profile → branch selector ("New branch", existing branches, "Add an existing folder (outside Aria)…") → name → Create → it opens in the shared viewer.
- Outside Aria: `POST /profiles/branches/external/inspect` (read-only) → dialog with warnings → separate confirmation
  `POST /profiles/branches/external {root, confirm: <same root>}` (428 otherwise). Such a branch is `external: true`; deleting it only forgets it.

### §5 Opening / concurrency: ✅
- Idle → launch. Already running → reuse (no 2nd process). Same branch busy → `branch_busy` (409) names the running profile and offers to show it. **Decision: message only, no queue** (reason in the S30 report, section 3).
- Same-branch overlapping schedules → **the later run waits** (lease), shown before saving (409 `schedule_overlap`, saving with `acceptOverlap`). Real test: `turn-off-and-show.test.ts` #2.
- One shared display tab for every profile.

### §6 Local Browser and Browser Profiles: ✅
- Same launch rule, same session registry, same viewer; no third launcher. Turn Off = Local Browser only, bounded, names the profile browsers that stay open. Show Browser = attach only.
- 🟡 Show Browser: verified on the server side (same session/process/page). The noVNC **picture** was checked by probe only, not pixel by pixel.

### §7 Lifecycle: ✅
- `afterRun` default close; keep honoured after success, ignored after error/timeout (state saved first). Code: `BrowserLifecycle.applyAfterRun`, used by the worker.
- Idle close: `BROWSER_IDLE_CLOSE_MIN` (existing, every minute, only browsers nobody depends on).
- Crash: `core/OrphanBrowsers.reapOrphans()` at boot. It stops a Chromium on an Aria root with no Node owner; it removes a lock only when no live browser holds it.
  (Before this, boot deleted every lock, even a live one.)
  🟡 The Windows process listing (PowerShell `Get-CimInstance`) is written but **NOT tested**. If listing fails, nothing is killed.
- Closing the viewer never releases a reservation (S27, unit-tested).
- 🟡 Dev vs prod differences: none were found in this code path; there is no explicit test for that sentence of the brief.

### §8 Delete branch: ✅
- Scan → blocked by active/scheduled/running (named, "Reassign profile") → confirmation (name, count, inactive workflows, "deleted permanently";
  an external branch says "kept on disk") → 3-second hold (pointer + Enter/Space, progress, release resets) → server rescan → delete.
  Inactive workflows get `profileMissing`. Other branches are untouched.

### §9 Activation / schedules: ✅
- Activation check per referenced profile (`record_missing` / `branch_missing` / `folder_missing`) → 422 naming each profile, `assign_profile`, failure report.
- A schedule with a missing profile is refused.
- Reservation at run end: held until `max(window end, real end)`, the same for every workflow (decision + trade-off in the S30 report).
- A folder removed outside Aria → `BranchPolicy.preRunProfileCheck` before the lease/launch → run fails, `profile_broken` report, live-log notification, no folder created. The pipeline refuses as a second line of defence.

### §10 Phase 2: untouched ✅
Phase 1 provides a per-branch lease, a reliable launch (explicit root + folder) and a reliable release (lease released on every exit path; after-run close bounded).
Phase 2 reference: `handoffs/2026-10-13_S26_phase2-nodes.md`. Do not start it before the owner says so.

### §11 Tests: ✅ on Linux, ❌ on Windows. Matrix: S30 report section 5.

### §12 Constraints: respected (no merge; no Default merge; no hardcoded `C:\` test paths; no second launcher; no CI change).

### §13 Decisions: all taken and explained in the S30 report, section 3.

### §14 Report: `handoffs/2026-10-14_S30_phase1-report.md`.

## 5. What is OPEN, in priority order (do these next)
1. **Windows manual verification by the owner (non-blocking, owner-run).** The 12 manual steps in the S30 report, section 8, stay pending for the owner to run on Windows later and do **not** block merging PR #76. Windows-specific code (`BranchBase`, `OrphanBrowsers` CIM parsing, `lockfile` vs `SingletonLock`, `inspectExternal` personal-folder check) is tested with simulated Windows inputs on Linux.
2. **Two Default folders**: deferred by the owner and out of scope for PR #76 (the owner deleted the containers that held them). `tools/default-folders-report.mjs` stays unchanged.
3. **`$root`**: resolved (no such setting exists in the app; the base directory setting is `BRANCH_BASE_DIR`).
4. **`pipeline-browser-options`**: fixed and passing (2/2).
5. Optional: a pixel check of the noVNC viewer after Show Browser (screenshot of the canvas), Linux only.
6. Then the owner reviews and merges PR #76 themselves. Phase 2 (nodes) starts only after that.

## 6. Where things are (quick map)
| Concern | File |
|---|---|
| Branches / profiles registry | `src/core/BranchRegistry.ts`, `ProfileIndex.ts`, `ProfileRegistry.ts` |
| Base directory | `src/core/BranchBase.ts`, setting `BRANCH_BASE_DIR` (`SettingsCatalog`, `config.ts`) |
| Which folder Chromium opens | `src/core/ChromiumProfileLocation.ts` |
| Name, icon, color in Chromium | `src/core/ChromiumProfileName.ts` |
| Open / close a profile browser | `src/core/ProfileBrowser.ts` (extensions: `projectExtensionArgs`) |
| Local Browser | `src/core/RealChrome.ts` (+ `SharedBrowsers.ts` session `realchrome`) |
| Sessions, dependents | `src/core/BrowserSessions.ts` |
| Leases / holds / reservations | `src/core/ProfileLease.ts`, `ProfileReservations.ts`, `ProfileCoordinator.ts` |
| Activation, deletion scan, overlaps, pre-run check | `src/core/BranchPolicy.ts` |
| After-run close / keep | `src/core/BrowserLifecycle.ts` |
| Crash leftovers | `src/core/OrphanBrowsers.ts` (called by `cleanupSystem` in `src/index.ts`) |
| Failure reports | `src/core/ProfileFailureReports.ts` |
| HTTP | `src/Routes/profile.routes.ts` (/profiles, /profiles/branches…), `browser.routes.ts` (Turn Off, /browser/sessions), `user.routes.ts` (activation, /schedule) |
| UI | `public/js/profile-manager.js`, `workflow-files.js`, `views.js` (Workflow Settings), `i18n.js`, `css/styles.css` |
| Real-Chromium tests | `tests/browser/profile-real-chromium`, `turn-off-and-show`, `orphan-browsers`, `local-browser-profile-selection` |
| Integration / unit tests | `tests/integration/branch-*.test.ts`, `profile-routes`, `tests/unit/branch-*`, `profile-*` |

## 7. Start prompt for the next session (paste as the first message)
> Restore the newest backup link I give you into /home/user/webapp (untar into /home/user), set up the environment as in
> handoffs/NEXT-SESSION-S31.md §2, read that file and handoffs/2026-10-14_S30_phase1-report.md, then do §5 in order.
> Do not merge PR #76. Commit + ProjectBackup after every step and give me the link. Answer me in Persian.
