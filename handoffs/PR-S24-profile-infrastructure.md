## Phase 1 — shared browser-profile infrastructure

Builds the shared layer for browser profiles, browser sessions, scheduled reservations and the browser lifecycle. Node logic is NOT changed here; that is phase 2.

### Problem
A profile *was* its name: the string typed in Workflow Settings was both the directory and the lock name, so renaming would break every reference. There was no reservation around scheduled runs, and nothing stopped a browser from being closed while another run or view depended on it.

### What changes
| Concept | Module | Storage |
| --- | --- | --- |
| Profile (stable id + renamable name) | `core/ProfileRegistry` | meta file inside the profile dir |
| Live browser session + dependents | `core/BrowserSessions` | memory, mirrored to Redis |
| Run | BullMQ job (unchanged) | Redis |
| Claim: lease / operator hold / reservation / grant | `core/ProfileLease`, `core/ProfileReservations` | Redis |

- **One atomic Lua admission** for every claim; each claim has an owner (the workflow). Claims of the same owner are compatible; any other owner's are refused, with the reason. Grants are explicit only (for phase 2's continue-session node).
- **Scheduled reservations**: `[t − before, t + after]`, default 10/10, configurable in Settings → Workflow Runs. States are planned → fired → settled | missed. A fired reservation blocks until the real end of its run, so a 10:00 run lasting until 10:20 is not freed at 10:10. Reservations are resolved only from queue evidence. Inactive workflows reserve nothing.
- **Lifecycle**: closing a browser never releases a claim, and releasing a claim never closes a browser. A browser that someone else depends on is never closed. New Workflow setting `afterRun` = keep | close; errors and timeouts keep the browser. Idle close after `BROWSER_IDLE_CLOSE_MIN` (default 10); a Wait node does not count as idle.
- **Visibility unchanged** (`core/RunPolicy`): a manual run is visible, automatic runs are hidden.
- **Boot recovery**: orphaned leases and holds are released, stale sessions are reported, reservations are kept.
- **API** `/profiles`: list, create, rename, delete (refused with blockers), open (hold + bounded start; a retryable 503 means the cold start continues), hold refresh, release, close.
- **UI**: profile panel inside the existing Workflow Files drawer. It supports multi-select, opening one viewer tab per profile, create followed by an automatic open (a failed open keeps the profile and can be retried), and shows the reason when a profile is unavailable. Workflow Settings picks the profile from the registry and offers "Browser after the run".
- Legacy `profileId` values are adopted unchanged (old name = id). No data migration.

### Tests
- New: `profile-admission` (21, real Redis: 50 concurrent claimants → 1 winner, run vs operator race, reservations, the 10:00→10:20 case, grants, sweep, recovery), `profile-routes` (9), `profile-coordinator` (4, real BullMQ), `profile-infrastructure` (27), `profile-manager-ui` (8).
- Full suite: integration 414 passed, unit 4078 passed; tsc clean.
- Bugs found by the new tests and fixed: schedule data not found in BullMQ 5 (no reservation would ever have been made); undeclared `cron-parser`; open hanging with no display.

### Not verified / follow-ups
- A real Chromium open in a new tab was not verified (the sandbox has no Xvfb). It needs one manual check on a real server.
- Overlapping schedules are only logged; there is no UI warning yet.
- An operator hold outlives a closed tab for up to `OPERATOR_HOLD_MINUTES` (30), capped at the next reservation.
- Phase 2: node settings, Success/Error/Timeout outputs, per-node retry, and the continue-session node via `ProfileLeases.grant`.
