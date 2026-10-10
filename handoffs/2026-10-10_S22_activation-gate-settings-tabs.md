# S22 — Activation test gate, URL check, Import label, tabbed Settings, single-user cleanup

Branch: feat/settings-tabs-activation-gate (off main 69a49b0).

## Activation (n8n "publish" model)
- core/TestRunGate.ts: designFingerprint(runnable steps; disabled nodes dropped).
- POST /run with a verified workflowId stamps `__testOf` + `__testFingerprint`;
  worker (index.ts recordTestOutcome) stores `workflow.lastTest` {status, fingerprint, error, failedStep}.
- PATCH /state active:true -> 422 `activation_untested` unless lastTest is success AND matches
  the current design. Static ActivationCheck still runs first (422 activation_invalid).
- ActivationCheck.urlProblem: URL without scheme (arena.ai, localhost:3000) / bad scheme refused.
- Editor flushes autosave before activating. Tests: tests/helpers/test-run.ts markTested().

## Settings
- public/js/settings-ui.js owns the page: 7 tabs (General, Server, Access & Login, Security,
  Browser, Workflow Runs, Data Retention). Administration tab intentionally NOT created.
- Removed (single-user): Admin view/route/launcher item/i18n, admin token in api.js, Quota view,
  no-op language switch, WORKFLOW_MAX_VERSIONS setting (manual versions are never trimmed).
- /admin router mounted only when DEPLOYMENT_MODE=multi (ADMIN_SECRET default is public).

## Verified
tsc clean; vitest 4340 passed / 2 skipped; real-browser e2e of the gate; Playwright
functional check of Settings (14/14).
