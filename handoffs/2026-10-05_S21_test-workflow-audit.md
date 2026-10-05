# S21 - Test Workflow audit: every finding fixed

Source: a bug audit of the "Test Workflow" path. Fixed in stacked PRs (all merged to main).

| # | Finding | Fix | Where |
|---|---------|-----|-------|
| P0 | `step.done` was emitted only for module steps; ~39 built-ins left via `continue stepLoop`, so nodes spun forever and the run said "0 ok" | try/finally around the retry loop guarantees exactly one `step.done` (or `step.error`) per `step.start`; `__errored` prevents a double emit under continueOnFail | `src/pipeline.ts` (#62) |
| 2 | Item flow (input/output/sample) only on the module path | `applyItemFlow()` for every built-in step; trigger = pass-through; extract family maps `{count,data}` to items | `src/pipeline.ts` (#63) |
| 3 | Screenshots lost | `JobArtifacts` store (closed filename regex, containment, lstat), authenticated `GET /job/:userId/:jobId/artifact/:file`, GC sweep, UI fetches with Bearer into a `blob:` URL (strict `isArtifactUrl`) | `src/core/JobArtifacts.ts`, `user.routes.ts`, `public/js/api.js`, `flow-editor.js` (#64) |
| 5 | Logs tab showed only the step timeline | renders the real `state.log` (log/retry/path/job events, server timestamps) | `run-panel.js`, `run-state.js` (#65) |
| 6 | Last Run said "Success" after Stop | `stopped` phase; `outcome()` = success / partial / error / stopped; cancel is not an error | `run-state.js`, `views.js` (#65) |
| 7 | Variables always 0 | `step.done` carries a masked, truncated `variables` snapshot (only when changed); credential-like names never leave the worker | `pipeline.ts snapshotVariables`, `run-panel.js` (#65) |
| 8 | No Activate toggle in the editor | `Active` switch in the editor header (PATCH `/state`, no version bump); disabled with a reason for an unsaved draft | `views.js`, `flow-editor.js` |
| 9 | Test Workflow always headless | `Live browser` switch; Test Workflow sends `headless: !live`; headed launch calls `Desktop.ensureDisplay()` (degrade, never throw); free-tier shared pool says it stays headless | `views.js`, `pipeline.ts` |
| 10 | Schedule Trigger looked tested but is skipped in a manual run | note on schedule / webhook / telegram trigger nodes | `flow-editor.js`, `i18n.js` |
| 11 | Naming drift | product + package = Plyr; UI brand "Aria Automate" kept (locked design); documented in PROJECT.md | `package.json`, `PROJECT.md`, `README.md` |
| 12 | Stale handoff pointer (said S20 / PR #33) | this file + `current-handoff.md` | - |

Facts worth remembering
- Event contract: `step.start/done/error/retry/path`, `index` is 1-based; the UI reducer is `public/js/run-state.js`.
- `.env.example` must document every variable `config.ts` reads (a test enforces it): `ARTIFACT_MAX_AGE_HOURS`, `ARTIFACT_MAX_BYTES`.
- Line endings: `src/*.ts` mostly CRLF, `user.routes.ts` and `public/**` LF - detect before scripted edits.
- Two commits with the same content but different hashes (`947a504` / `72eb31c`) made PR #63 conflict; resolved by keeping the branch side (diff was empty).
- Not verified here: a real headed browser (no display in the sandbox).
