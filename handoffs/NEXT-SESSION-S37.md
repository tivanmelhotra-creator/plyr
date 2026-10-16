# NEXT SESSION (S37) — read this first

Hand-over for PR #76 (`feat/profile-infrastructure`), written at the end of S36.
Owner's briefs (authoritative, in the repo):
- `handoffs/task-pull-76/Task_Pull_76.md` (main brief, sections 0-10, byte-exact CRLF original)
- `handoffs/task-pull-76/Task_Pull_76_2.md` (owner feedback A-I on the Stage-1 report)
- `handoffs/task-pull-76/reference-3-screens.jpg` (FINAL reference image: Screens A/B/C)

## 0. Ground rules (owner)
1. Do NOT merge or close PR #76. Push ONLY to `feat/profile-infrastructure` and ONLY after the owner approves (push is NOT approved yet). Never push `local/session-archive`.
2. Small commits. The sandbox resets very often: commit + `ProjectBackup` after every step and give the owner the link. No backup links in tracked files.
3. Linux only. Windows = manual checklist, NOT RUN. Do NOT install Docker in the sandbox; the owner runs `./plyr dev-docker --ref pr-76 --dev` himself.
4. No second launcher, no CI changes, browser tests stay out of CI.
5. Talk to the owner in Persian; code/comments/commits/file names in English.
6. Do not touch: Task View, Authorization Code, PUBLIC_DOMAIN, node/extension pairing, phase-2 node logic, internal names RealChrome / realchrome / /browser/real/*.
7. Report tests as RUN / NOT RUN / FAILED; skipped and failed counted separately.

## 1. Git state (end of S36)
- HEAD `6313bb3` on `feat/profile-infrastructure`; 14 local commits on top of `origin/feat/profile-infrastructure` = `491de46` (NOT pushed). `main` = `6094e8b`.
- Working tree clean.

## 2. Environment after a reset (~3 min)
```bash
# restore: download the newest backup, untar into /home/user (gives /home/user/webapp)
cd /home/user/webapp && npm ci
sudo apt-get install -y -q xvfb redis-server openbox wmctrl x11-utils xdotool x11vnc websockify novnc \
  || (sudo apt-get update -q && sudo apt-get install -y -q xvfb redis-server openbox wmctrl x11-utils xdotool x11vnc websockify novnc)
npx playwright install chromium && sudo npx playwright install-deps chromium
redis-server --daemonize yes
npx tsc --noEmit -p .
```
Pitfalls (each cost time):
- NEVER `pkill -f <pattern>` where the pattern appears in your own command line (it kills the tool call). Kill by PID / process group.
- A server started with `&`/nohup keeps the tool call open: use `setsid ... < /dev/null &` and redirect output to a file.
- Long runs: start in background and write results into `handoffs/` (files in /tmp vanish on reset). Use `tools/s35/run-all-tests.sh`.
- Do not run the full suite while a real app server / Chromium runs (timing tests fail under load; they pass alone).
- `src/core/ChromeView.ts` is ONE template literal: no backticks inside its comments.
- Comparing refs: `git worktree add -f --detach /home/user/wt-X <ref>` + `ln -s /home/user/webapp/node_modules`; `tools/s35/start-server.sh <tree> <datadir>` prints which tree really serves :3000 (an early run once measured a stale main server).

## 3. Done (with evidence files in handoffs/)
- **2.1** registry == UI == disk: the hidden Local Browser branch (cause of branch-001 missing) removed; legacy/builtIn/kind/external flags gone; no automatic Default; unlisted `branch-NNN` under the base: empty -> removed, with data -> "Branch N"; ids never reused; per-profile delete. (`d90f0bc`)
- **1.4** "Add an existing folder (outside Aria)" removed completely. (`9992156`)
- **A / 2.2** viewer tab regression. Root causes: (1) `984fa62` removed `window.close()`, `4f1cd0c` gated it on `window.opener`, which is ALWAYS null because the app sends `Cross-Origin-Opener-Policy: same-origin`; (2) the viewer drawer's "Close browser" only called `/browser/real/close` (Local Browser), so a profile browser never closed. Fixed: unconditional `window.close()` as on main, after the S27 rule (two zero answers from `/browser/sessions` >= 2 s apart, failed probe resets); "Close browser" closes the viewer's own profiles via `POST /profiles/:id/close`; when close() is refused (typed address) -> `location.replace('/')` (owner decision). Evidence: `2026-10-15_S35_viewer-regression-raw.txt` (main / 984fa62~1 / 984fa62 / b36f6ba / 491de46 / HEAD), real-Chromium tests a-g in `tests/browser/viewer-self-close.test.ts` (8/8).
- **1.5 / 2.5** no stray Default folder with explicit `--profile-directory` (real Chromium).
- **C** Local Browser MODE unchanged: opens/shows/closes, root = `REAL_CHROME_USER_DATA_DIR`, no branch created. **D** a workflow with no profile runs on `<PROFILES_DIR>/<user>/chrome-profile` with `--profile-directory=Default` and completes. (Measured S35 with `tools/s35/no-profile-and-local-browser.mjs`; the evidence file was lost in a reset -> re-run it once and commit the output.)
- **E** `491de46` == `origin/feat/profile-infrastructure`; earlier removals present (`0f1ed81`, `4f1cd0c`, `ad6b407`).
- **F** rebuilt brief differed only by 191 CRLF; original now in repo. Image is final; padlock open/closed is real per-profile lock state; NO restore icon.
- **H** tests since 491de46: 7 removed, 8 added (+1 net). Last full run at `c8f3652`: unit+integration 4630 passed / 9 skipped / 0 failed; real Chromium 28/28.
- **G.1** (`2026-10-16_S36_G1-second-profile-facts.txt`): exit 21 is NOT a Chromium limit and not a lock/namespace artifact; it is caused by Playwright's `--enable-automation` on the first browser. The app's profile launch ignores that switch, so a plain second launch with another `--profile-directory` FORWARDS into the running process. Measured: Playwright's context sees the second profile's tabs; profiles stay separate (cookies); closing the first context closes both; closing the second's window leaves the first alive; tabs are distinguishable by CDP `browserContextId`.
- **G.2 backend** (`baa4d4a`, test `6313bb3`): `src/core/ManualProfiles.ts`; `openManualProfile` in `src/core/ProfileBrowser.ts`; routes `POST /profiles/:id/open-manual` (needs `{confirm:'manual-only'}`, else 428; 409 `not_running` / `already_running`) and `POST /profiles/:id/close-manual` (closes only its windows); `branch_busy` answer now carries `manualOpenPossible: true`; branch session close clears manual profiles; pipeline skips manual tabs when it reuses the branch browser; profile view `browser.manual: true`. Real Chromium `tests/browser/manual-second-profile.test.ts` 2/2.
  Defined behaviour: manual profile = no lease, no hold, no session, never used by runs; a run of the branch waits for the branch lease as before; Stop of the manual one closes only its windows; Stop / run end / idle close of the branch's own browser closes the manual windows too (one process); the viewer follows the branch's session.

## 4. OPEN — do these next, in this order
1. **G.2 UI** (`public/js/profile-manager.js`, `i18n.js`, `styles.css`): on Play -> 409 `branch_busy` with `manualOpenPossible`, show an INSET alert in the panel (no native dialogs): title "Another browser is open in this branch"; body (a) automated runs control only ONE browser per branch, (b) this second browser is for manual use only, workflows cannot use it, (c) consequence verified: closing the branch's running browser (Stop, end of a run that owns it, idle close) also closes this one, (d) "Better: keep this profile in a different branch, so both can run at the same time." Buttons: Cancel + hold-to-confirm "I understand" (fills left->right, exactly 3 s, pointer/touch/Enter/Space, release resets, reduced motion) -> `POST /profiles/:id/open-manual {confirm:'manual-only'}`. The confirmation is for that single launch only. The existing `holdButton()` in profile-manager.js can be reused. Stop on a manual row -> `/close-manual`. Tests (jsdom + real Chromium): 2.9 s release does nothing, 3 s launches, keyboard, no native dialogs.
2. **B** Play/link semantics: Play on a closed profile launches AND opens one viewer tab; on a running profile the external-link icon only shows (never launches or relaunches), focuses an existing viewer tab or opens a new one; never a second browser/session. Verify after the Local Browser section removal, including the former realchrome browser. Tests: link twice -> one process, no duplicate tab; close viewer tab, link -> new tab shows the same browser.
3. **1.1** remove ALL remaining Local Browser SECTION/row UI strings, CSS, translation keys and dead code in the Workflow Files panel; keep the Local Browser MODE (RealChrome, /browser/real/*) intact and re-prove point C.
4. **2.3** end-to-end in real Chromium: create a profile in a NEW and in an EXISTING branch, first open, close, reopen, rename, delete, server restart -> everything persists; a failed create/launch keeps the profile with a plain error line and Play again.
5. **Launch Settings audit** (owner asked, report at Stage-1 wrap-up, BEFORE Stage 2/3 UI): list what the current Launch Settings code (`src/core/LaunchSettings.ts`, routes `/profiles/launch-options`, `/profiles/launch-settings/validate`, open `launch` input, UI in profile-manager.js) really changes in the launched browser (argv Chromium receives, window size, etc.) versus what is decorative UI with no functional effect. Verify with real Chromium (`/proc/<pid>/cmdline`, `chrome://version`).
6. Full test run (`tools/s35/run-all-tests.sh`, add the new browser test files) + re-run the C/D probe; commit results into `handoffs/`.
7. Stage-1 report to the owner in Persian (answers A-I with evidence, G result, Launch Settings breakdown, point A confirmation), then ASK before pushing. After push: update PR #76 body, write the handoff.
8. Then Stage 2 (names 3.1, lock section 6, flag catalog section 5) and Stage 3 (3-screen UI section 4), Stage 4 (tests section 8).

## 5. Known bugs recorded, not fixed
- Task View card titles: the wmctrl parser prepends the container hostname, two cards can get the same id (owner: do not fix; Task View is separate).

## 6. Where things are
| Concern | File |
|---|---|
| Registry (branches/profiles) | `src/core/BranchRegistry.ts`, `ProfileRegistry.ts`, `ProfileIndex.ts` |
| Open/close a profile browser, manual open | `src/core/ProfileBrowser.ts`, `src/core/ManualProfiles.ts` |
| Sessions | `src/core/BrowserSessions.ts`, `SharedBrowsers.ts` |
| Profile routes | `src/Routes/profile.routes.ts` |
| Viewer page | `src/core/ChromeView.ts` (endViewer, pollBrowserHealth, dclosebrowser) |
| Runs | `src/pipeline.ts` (ensureProfileBrowser), `src/index.ts` (worker) |
| UI | `public/js/profile-manager.js`, `workflow-files.js`, `i18n.js`, `css/styles.css` |
| Probes / tools | `tools/s34`, `tools/s35`, `tools/s36` |
