# S23 — single-instance architecture (PR #73, branch feat/single-instance-architecture)

## Architecture now
- One install = one owner. No accounts, roles, Admin API, plans, quotas, per-user keys, Logout.
- Access: ONE instance token (API_TOKEN). development = keyless only from loopback; production = token on every request.
- Environments: development / production (+test). `server`/`remote`/`prod` = production. The environment never decides browser visibility.
- Browser visibility = WHO started the run (core/RunPolicy): editor Execute/Run node and Workspace Run send origin=manual -> visible;
  schedules, triggers, API -> hidden. Hidden = Chromium NEW headless (`channel: 'chromium'`), extensions load (measured, tests/browser/run-visibility-extensions.test.ts).
  Real Chrome (extension runs) follows the same rule via RealChrome.ensureVisibility(); the operator's viewer brings it back visible unless a run holds it.
- Profiles (core/ProfileLease): one run per profile; busy -> job back to delayed set (no slot held); different profiles run in parallel;
  token-checked release in worker finally (success/fail/cancel); TTL = MAX_JOB_DURATION_MINUTES refreshed by holder; boot frees leases of a dead process.
  Profile per workflow = Workflow Settings `profileId` (validated path segment). Extension runs use the Real Chrome profile.
- Settings: General · Server · Access & API · Security · Workflow Runs · Data Retention. Removed: AUTH_MODE, REAL_CHROME_ENABLED, DEFAULT_HEADLESS, MAX_CONCURRENT.
  WORKFLOW_MAX_VERSIONS not offered (it only trims hidden autosaves; manual versions are never trimmed).
- Workspace: no Owner, no Live Browser column/toggle/eye/filter. Columns: Workflow, Last run (Never), Success rate (— when none), Status(Active), Now (running / waiting for profile / idle + profile), Schedules, ⋮.
  ⋮: Open editor, Settings (real dialog: name, description, webhook, profile), Schedules, Executions (filtered), Duplicate, Export, Delete.

## Verified (real)
- tsc 0 errors; vitest unit+integration 4335 passed / 9 skipped; browser tier run-visibility-extensions 3/3.
- Live server (APP_ENV=production): no token 401, wrong 403, right 200, /admin 404.
- manual run visible, automatic hidden; same profile queued then run; shopA+shopB parallel, 2nd shopA waits; lease freed after success, failure, cancel; stale lease freed at boot.
- Extension (Real Chrome): manual + automatic both open the extension page and read its content; automatic process had --headless + --load-extension.

## Open decisions (not invented)
- Wait time/expiry for a run waiting on a busy profile: none (waits until free, arrival order of BullMQ delayed set).
- A manual run while a hidden automatic run holds Real Chrome waits for it (no preemption).
