# NEXT SESSION (S38) — read this first

PR #76 (`feat/profile-infrastructure`). Ground rules, environment and pitfalls: unchanged, see `handoffs/NEXT-SESSION-S37.md` sections 0, 2 and 6.
Owner briefs: `handoffs/task-pull-76/Task_Pull_76.md`, `Task_Pull_76_2.md`, `Task_Pull_76_3.md` (added in S37, byte-exact), `reference-3-screens.jpg`.
Push is NOT approved. Nothing pushed. Not merged.

## Done in S37 (evidence: handoffs/2026-10-16_S37_*)
1. **G.2 UI** (`ecddd19`, `27dec0f`): Play -> 409 `branch_busy` + `manualOpenPossible` -> inset alert `.pm-manual-alert` (title, a-d, Cancel, hold "I understand" exactly 3 s: pointer/touch/Enter/Space, release resets, reduced motion = whole-second steps, long-press menu suppressed) -> `POST /open-manual {confirm:'manual-only'}`; one launch only; Stop on a manual row -> `/close-manual`. jsdom 10/10, real Chromium 3/3.
2. **B** (`32c4cf8`): row icons: closed = Play; open = external-link (never /open, named viewer tab focused or opened) + Stop. Real Chromium 1/1 (dblclick Play -> 1 /open; link x2 same pid/session/tab; tab closed + link -> new tab, same pid).
3. **1.1** (`c113609`): section already removed in `ad6b407`; removed dead `removeProfile()` (native confirm), `builtIn` check, 4 unused keys; guard test. **C** re-proved (RealChrome + /browser/real/* unchanged since 491de46; root = REAL_CHROME_USER_DATA_DIR, no branch). **D**: run without profile -> completed on `<PROFILES_DIR>/local/chrome-profile`, `--profile-directory=Default`.
4. **Found additionally, fixed** (`5514039`): creating a profile in a branch whose other profile runs showed an error; now the G.2 choice.
5. **2.3** (`a3a4d5b`): `tools/s37/profile-e2e.mjs` phase1 10/10 + restart (`tools/s37/restart-server.sh`) + phase2 5/5 on the real app, real Chromium, real panel.
6. **Launch Settings audit** (`25e7609`, `2026-10-16_S37_launch-settings-audit.txt`): REAL = Custom Flags (all reach argv; --window-size 900x600 measured), Diagnostics preset, validation (400/409), relaunch with new settings. DECORATIVE = Start maximized (1280x800 either way), Automation preset (all 5 flags already Playwright defaults), categories. NOT CONNECTED = nothing stored per profile; runs never use it.
7. Full run: `tools/s37/run-all-tests.sh` -> `handoffs/2026-10-16_S37_tests-raw.txt` (see that file for the result).

## OPEN
1. If the full run has failures: fix them, re-run.
2. Stage-1 report to the owner in Persian (A-I, G result, Launch Settings breakdown, point A), then ASK before push.
3. After approval: push, PR body (2.10), then Stage 2 (3.1 names, 6 lock, 5 flag catalog — note the audit: the catalog replaces free-text Custom Flags and must be stored per profile and used by runs too, 5.10/5.11) and Stage 3 (3-screen UI).
