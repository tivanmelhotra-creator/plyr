Historical. Superseded for phase 1 by handoffs/NEXT-SESSION-S31.md

# S24 — shared profile / browser infrastructure (phase 1), branch feat/profile-infrastructure

## What exists now
- Profiles = stable id + renamable name (core/ProfileRegistry). Legacy `profileId: "shop"` adopted unchanged (id = old name).
- Claims (core/ProfileLease): run lease, operator hold, reservation, explicit grant — one atomic Lua admission. Owner = workflow id.
- Scheduled reservations (core/ProfileReservations): window [t-before, t+after], settings PROFILE_RESERVE_BEFORE_MIN / AFTER_MIN (10/10).
  planned -> fired -> settled | missed. Fired blocks until the run settles; settled blocks until max(end, real end). Sweep = evidence only.
- Sessions (core/BrowserSessions): dependents gate every close. Idle close BROWSER_IDLE_CLOSE_MIN (10, 0=never).
- After-run policy per workflow `afterRun` keep|close (core/BrowserLifecycle). Errors/timeouts keep for inspection.
- /profiles routes (create, rename, delete with blockers, open = hold + bounded start, hold refresh, release, close).
- UI: profile panel in the Workflow Files drawer (multi-select, create -> auto open, failed open kept + retry, reasons shown).
  Workflow Settings: profile <select> from the registry + "Browser after the run".
- Visibility policy untouched (core/RunPolicy: manual visible, automatic hidden).

## Verified
- tsc clean. New tests: profile-admission (21, real Redis), profile-routes (9), profile-coordinator (4, real BullMQ),
  profile-infrastructure (27), profile-manager-ui (8). Full suite run in chunks (RAM 1 GB sandbox).
- Real server boot: /profiles list/create OK. Real Chromium open NOT verified here: sandbox has no Xvfb; the route now
  answers within the start budget (retryable 503) instead of hanging.

## Open / phase 2
- Continue-session node uses ProfileLeases.grant (exists, not wired to any node).
- Overlapping schedules on one profile are detected and logged at boot; no UI warning yet.
- Hold refresh is driven by the open drawer (5 min); closing the tab leaves the hold until it expires (OPERATOR_HOLD_MINUTES=30).
- Schedules created before this change with an unknown template job reserve nothing until their next delayed job exists.
