Historical. Superseded for phase 1 by handoffs/NEXT-SESSION-S31.md

# S25 — phase 1 completed (remaining items), branch feat/profile-infrastructure (PR #76)

Pushed to GitHub (PR #76 updated). CI green on the pushed head (run 38380583190 and later).

## Done (NEXT-SESSION-PROMPT §3 "remaining items")
1. PR — already open (#76), updated by every push.
2. Real browser verification — DONE in the sandbox with Xvfb + openbox + wmctrl and Playwright's
   chromium-1194: tests/browser/profile-real-chromium.test.ts (2 tests, pass):
   - two created profiles open as two VISIBLE Chromium windows, one per user-data-dir;
   - re-opening reuses the same browser (reused=true, no 2nd process);
   - BrowserWindowManager.focusByUserDataDir raises THAT profile's window (verified via
     _NET_ACTIVE_WINDOW -> pid -> --user-data-dir); POST /profiles/:id/open now calls it (focused:true|false);
   - manual run on a named profile = visible window on the display; scheduled (automatic) run on the
     same profile = hidden (relaunched hidden on the same dir, no window).
   NOT verified: the noVNC picture itself (x11vnc/websockify not installed here; the view is the
   existing /desktop/chrome mechanism). Pending CI workflow installs xvfb/openbox/wmctrl (needs the
   user to activate .github/workflows-pending — the App cannot push workflow files).
3. Overlap warnings in UI — GET /profiles `overlaps[]` + per profile; drawer row + Workflow Settings.
4. State saved before closing — core/BrowserStateSnapshot: tabs (http/https) + Playwright
   storageState into <profile>/.plyr-state/ (0600), before after-run close, idle close, GC close,
   Close Browser node, operator close and relaunch. Empty/crashed context never overwrites a good
   snapshot; 4 s budget. Recovery: POST /profiles/:id/restore + "Restore tabs" in the drawer; the list
   shows only the count (URLs never leave the server, never logged).
5. Viewer tab closed -> core/ProfileViewers: the profile view tags its VNC socket
   (?profile=&workflowId=); when the last socket closes and 30 s pass, operator:<owner> is DETACHED from
   the browser (idle collector may close it later). DECISION TAKEN (user was not available to ask):
   the HOLD is KEPT until it expires (OPERATOR_HOLD_MINUTES) or Release is pressed — closing a tab must
   not hand the profile to another workflow silently. Easy to change: release in ProfileViewers' timer.
6. Legacy schedules without a delayed job -> "unknown" in /profiles (drawer note) and /schedules (badge).
- BUG FIXED on the way: BullMQ 5 repeatables have no `id` -> Schedules list/delete/limit were blind.

## Tests
tsc clean. Integration 422 passed / 9 skipped. Unit 4093 passed (3 chunks). Browser: profile-real-chromium 2/2.
New: tests/unit/{browser-state-snapshot,profile-viewers}.test.ts, tests/integration/profile-schedules.test.ts,
tests/browser/profile-real-chromium.test.ts; profile-routes +1, profile-manager-ui +3.

## Next: phase 2 (NEXT-SESSION-PROMPT §4) — not started.
