# S23 — single-instance architecture (IN PROGRESS)

BRANCH: feat/single-instance-architecture (from main 9cf7ece). Commit after every step.

## Done (compiles: `npx tsc --noEmit` = 0 errors)
- EnvProfile: only development / production (+test). `server`/`remote` = alias of production.
- Multi-tenant removed: admin routes, admin-auth, block-check, UserManager, QuotaManager, per-user API keys, /quota, VIP/Free paths, plans -> config.INSTANCE_LIMITS.
- Auth: one instance token; dev = keyless from loopback only; production = token on every request.
- core/RunPolicy.ts: origin manual = visible, automatic = hidden (new-headless `channel: 'chromium'` keeps extensions).
- core/ProfileLease.ts + worker (src/index.ts): one run per profile, busy -> moveToDelayed + DelayedError,
  token-checked release in finally, TTL refresh, releaseOrphaned() at boot. Worker concurrency = WORKER_SLOTS (not a setting).
- Routes: /run, /run-node, /workflows/:id/run take `origin` (only 'manual' = visible); schedules always automatic; profileId passed to the job.
- UI: Execute Workflow, Run node, Workspace Run send origin:'manual'.
- Settings catalog: removed AUTH_MODE, REAL_CHROME_ENABLED, DEFAULT_HEADLESS, MAX_CONCURRENT; added WORKFLOW_MAX_VERSIONS; retention live.

## State of tests
- Unit: 28 failed / 3937 passed (11 files). All failures assert REMOVED behaviour (multi mode, server profile, AUTH_MODE, headless-by-profile, admin mount, free-tier pool).

## Next (in this order)
1. Update the 28 failing unit tests to the new rules; then integration suite (remove quotaManager deps in test setups).
2. RealChrome (extension runs): visibility still from REAL_CHROME_HEADLESS -> must follow run origin (relaunch via hiddenLaunchOptions); verify extensions load in both modes.
3. Settings UI (public/js/settings-ui.js): 6 tabs General/Server/Access & API/Security/Workflow Runs/Data Retention; remove Browser + Administration tab, Logout, account login.
4. Workspace (views.js): remove Owner/Personal, Live Browser column/toggle (`liveBrowser` in workflowStateSchema), success rate "Never"; More menu Settings -> real workflow-settings dialog (profile, webhook) or remove.
5. Real tests (visible/hidden + extension, profile lock/queue/release, UI clicks), docs, final report.
