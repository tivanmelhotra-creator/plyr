# S32 — Merging the browser switch into Browser Profiles, Turn on / Turn off, the Open path

Branch `feat/profile-infrastructure` (PR #76; not merged, not closed). Starting point `da1a2a8`.
Commits: `73430c2` (Open + turn-off route), `ad6b407` (UI + layout), `3e72750` (real-Chromium test), plus this report.

## 1. UI removal and routes
- Removed (UI only): the `.wfm-browser` row in `public/js/workflow-files.js` (`browserRow`, `paintBrowser`, `readBrowser`,
  `startBrowserWatch`/`stopBrowserWatch`, `toggleBrowser`, `showBrowser`), its CSS (`.wfm-browser`, `.wfm-br-*`) and its
  `wfm.browser*` keys (14 keys) in `i18n.js`. No visible UI text names it any more (checked in a test and in real Chromium).
- Removed test: `tests/unit/workflow-files-browser-switch.test.ts` (it tested the deleted row). Replaced by `tests/unit/browser-profiles-section.test.ts`.
- Routes: **no route was removed or changed.** `/browser/real/open`, `/browser/real/close` (= `/browser/close`), `/browser/real/health`,
  `/browser/sessions`, `/browser/windows*` and everything else stay as they were (pinned by a test).
- Route **changed**: `POST /profiles/:id/open` (internal behaviour only, same request/response; new 409 `needs_review` when the registry
  does not know the profile's branch/folder).
- Route **added**: `POST /profiles/turn-off`.
- Label: the list's label used to be per branch header `Branch: <name>`; now there is one `Branches` label above the list and the
  header shows only the branch name. Panel title `Browser profiles` → `Browser Profiles`.

## 2. Old launch method
- `src/Routes/profile.routes.ts` (at `da1a2a8`) line 488: `userDataDir: access.registry.dirOf(userId, profileId)` and line 490:
  `profileDirectory: entry?.folder`; line 513 `focusByUserDataDir(access.registry.dirOf(userId, id))`.
  `dirOf()` (`src/core/BranchRegistry.ts` 308) falls back to `legacyProfileDir()` (one root per profile, i.e. the old
  method) when the in-memory index has no entry, and an empty `folder` makes `resolveChromiumProfile()` read `Local State` /
  the pin file (`ChromiumProfileLocation.ts` 113–131).
- Replacement: `BranchRegistry.locationOf(userId, id)` (new, `BranchRegistry.ts` 318) reads root + folder from the registry file; the Open
  route (`profile.routes.ts` 469, 501, 503, 526) uses only it, and refuses with 409 `needs_review` if either is missing (before any hold
  or launch). `ProfileBrowser.assertBranchLaunch()` (`ProfileBrowser.ts` ~103, called at 196) refuses the profile folder itself as the
  `--user-data-dir`.
- Running profile: the reuse path in `openProfileBrowser` is unchanged → `reused: true`, same pid.

## 3. Turn on / Turn off
- Turn on: the selected profiles; with nothing selected, `default`. Same function as Open (`openProfiles` → `POST /profiles/:id/open`).
- Turn off: `POST /profiles/turn-off`. For each session that Browser Profiles opened (`createdBy = operator:<owner>`, not
  `operator:local-browser`): if it has a `job:` or `grant:` dependent → `keptOpen` with the profile name and the workflow name
  (from the lease owner or the grant); otherwise this panel's views are detached and it is closed with `closeProfileBrowser`
  (bounded). Other sessions (realchrome, a run's own browser) → `notOpenedHere`, untouched. Holds are not released.
  The UI shows the result in the panel itself (`.pm-off-result`), not only as a toast.

## 5. Shared session id 487a8594ff11 — evidence and conclusion (no Task View code changed)
- `487a8594ff11` does not exist anywhere in the code or the data (grep across all branches = 0).
- `BrowserWindowManager.scanX11()` uses `wmctrl -l -p -x`. Measured on Xvfb+openbox: the line is
  `0x00400003  0 5480   chromium-browser (...).Chromium-browser  sandbox.local about:blank - Chromium` — the 5th column is the
  **hostname** (here `sandbox.local`). The parser (`parseWmctrlList`) treats only the 5th column as the host and puts the rest in
  `title`, but with `-x` the class column itself contains a space (`chromium-browser (<path>).Chromium-browser`), so the host
  ends up at the start of the title. Feeding the real line with host `487a8594ff11` (= a Docker container's hostname format:
  12 hex chars) into the parser itself (`tools/s32/wmctrl-parse-check.ts`): title = `487a8594ff11 about:blank` for **both** windows,
  with different windowId/pid.
- Two-process probe (`tools/s32/taskview-probe.ts`, Default + the RealChrome root): registry = 2 branches (`branch-001` realchrome
  `<…>/profiles/chrome-profile`, `branch-002` default `<…>/profiles/local/chrome-profile`); processes = 2 distinct pids, each on
  its own `--user-data-dir`; `/browser/windows` = 2 cards: `Default` (pid 5245) and `Local Browser` (pid 5348), both
  `active`, both titled `sandbox.local about:blank`.
- Conclusion: **two separate processes**, not one session listed twice, and not a duplicate session id. `487a8594ff11`
  is the container's hostname that appears in the card title because of how `wmctrl -x` is parsed. (Repro in the sandbox with the hostname
  `sandbox.local`; the owner's own registry/processes were not available here, so the final confirmation should come from his `/proc`.)

## 6. Tests
- tsc: clean.
- Unit + integration (real Redis): 202 files, **4629 passed / 9 skipped / 0 failed** (the 9 skips are the same as the baseline).
  New: `tests/integration/profile-open-turn-off.test.ts` (8), `tests/unit/browser-profiles-section.test.ts` (8).
- Real Chromium (Xvfb, Linux): **20/20**: `profile-real-chromium` 9, `turn-off-and-show` 3, `orphan-browsers` 4,
  `local-browser-profile-selection` 2, new `profile-open-turn-off` 2 (cmdline: `--user-data-dir=<…>/branch-002`,
  `--profile-directory=profile-001`, chrome://version Profile Path `<…>/branch-002/profile-001`, reused=true with the same pid;
  Turn off 124 ms: closed `Free real`, keptOpen `Used real` ← `Real nightly`). Output: `handoffs/2026-10-14_S32_browser-tests-open-turnoff.txt`.
- Layout (real Chromium, zoom 100%, widths 1440 / 900 / 360): `tools/s32/layout-shot.mjs`.
- Docker (`./plyr dev-docker`): **NOT RUN** (no Docker in the sandbox: no `docker` binary, no `/var/run/docker.sock`).
- Windows: **NOT RUN**.
