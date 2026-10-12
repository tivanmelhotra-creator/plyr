# S25 — phase 1 remaining items (part), branch feat/profile-infrastructure (PR #76)

GitHub was NOT reachable from the sandbox (setup_github_environment: no valid authorization),
so these commits are LOCAL ONLY (in the backup). First action next session: authorize GitHub, then
`git push origin feat/profile-infrastructure` (the branch is ahead of origin) and `gh pr checks 76`.

## Done (NEXT-SESSION-PROMPT §3 items 3 and 6)
- Item 3 overlap warnings: ProfileCoordinator.overlaps() -> GET /profiles returns `overlaps[]` and
  `profiles[i].overlaps` (one per schedule pair, workflow names, no ids/paths). Shown in the drawer
  (.pm-overlap on the row) and in Workflow Settings under the profile select.
- Item 6 unknown schedules: ProfileCoordinator.unresolvedSchedules() (repeat with no job carrying
  its data). GET /profiles -> `unknownSchedules[]` (drawer .pm-notes); GET /schedules -> each row has
  `reservation: planned|unknown` (+ note), Schedules view shows a badge.
- BUG FOUND + FIXED: BullMQ 5.63 getRepeatableJobs() has no `id`, so every
  `job.id?.startsWith('sched:<user>:')` in user.routes matched nothing (Schedules list empty, DELETE
  /schedule 403, schedule limit never hit, workspace scheduleCount 0). Fixed by `repeatablesWithIds()`
  using scheduleIdsByKey() (id from the next job's data via repeatJobKey).
- Tests: tests/integration/profile-schedules.test.ts (7, real Redis + BullMQ), profile-manager-ui +3.
  tsc clean; integration suite 420 passed / 9 skipped; profile/unit subsets green.

## Still open (do next, in order)
- §3 item 4: save storageState / tab list before automatic close (afterRun=close, idle) — not done.
- §3 item 5: detach operator dependent when the desktop WebSocket closes. ASK THE USER first whether
  the hold should stay (until OPERATOR_HOLD_MINUTES) or be released when the viewer tab closes.
- §3 item 2: real Chromium verification (Xvfb) + focus the profile's window for ?profile=<id>
  (BrowserWindowManager.restore by user-data-dir). Not done; sandbox has chromium-1194 but no Xvfb.
- §4 phase 2 entirely not started.
