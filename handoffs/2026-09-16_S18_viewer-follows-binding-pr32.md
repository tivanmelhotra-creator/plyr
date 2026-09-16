SESSION: S18 — 2026-09-16T10:08Z → 10:26Z (S18a, two credit stops) + 10:23Z → ~10:45Z (S18b, this file)
PREVIOUS SESSION: S17 — 2026-09-16T08:27Z. Redis-backed binding shipped as PR #31 → MERGED as 2bbc299
                  (origin/main). Handoff: handoffs/2026-09-16_S17_redis-binding-pr31.md.
                  S18a transcript: sessions/2026-09-16T10-08Z_S18a_pr32-verification-credit-stops.md
                  (S18a itself began from the S17 handoff + backup18; it reached the live e2e twice and was
                  stopped by credit exhaustion both times; 1 sandbox reset inside it — backups AfCv7Bbv, GLYekxDZ).

PROJECT STATE: branch genspark_ai_developer @ 4eaf1e5 (ONE squashed commit on top of origin/main 2bbc299).
               PUSHED (-f). PR #32 OPEN: https://github.com/tivanmelhotra-creator/plyr/pull/32
               (+ this continuity commit on top; see git log.)
CURRENT BACKUP: backup20 — taken at S18b end (link in the chat message that closes S18b; tree == HEAD incl. .git)
PREVIOUS BACKUP: https://www.genspark.ai/api/files/s/GLYekxDZ  (backup19, S18a mid: == b0a331a, PR #32 pre-squash,
                 3 commits; verified byte-identical to HEAD for ChromeView.ts / real-chrome-shelf.test.ts / browser-view.js)

OBJECTIVE:
S18a found (runtime trace on main after PR #31): a viewer opened WITHOUT ?workflowId — which is what the
noTab / Retry launch path produces — kept listing workflow A after Retry had bound the shared Local Browser
to workflow B. Uploads/downloads after that were filed against / shown under the wrong workflow.
Fix root cause in the viewer, prove it in unit tests AND on the real stack, ship as PR #32.

ROOT CAUSE (src/core/ChromeView.ts, confirmed S18a):
- resolveWorkflowId() treated a FOUND server-derived id as final for the page's life (only an EMPTY answer
  was re-asked — that was the S15 fix for "opened a moment too early"). The drawer never noticed a later
  re-bind, and a listing still in flight for A could land after the switch to B.

COMPLETED:
S18a (before the credit stops; already on the branch when S18b started):
- Fix in src/core/ChromeView.ts (+46/-19): workflowIdFromUrl stays pinned; a server-derived id is re-read
  from GET /browser/workflow-files-binding on EVERY drawer open (only an in-flight lookup is shared);
  on id change reset wfmFolders/wfmOpen/wfmSelected/wfmRoot/wfmUploadInto/wfmLoadedOnce/wfmBound, close the
  menu, hide the confirm, re-render; wfmFetchFolder() records requestedWorkflowId and drops late responses
  (success AND failure) for a previous workflow; bindWorkflow() on connect binds ONLY an explicit URL id;
  lookup failure keeps the last binding.
- 9 new tests in tests/unit/real-chrome-shelf.test.ts (runView() got an `interceptFetch` seam).
S18b (this session):
- Restored: checked out origin/genspark_ai_developer (b0a331a), verified backup19 (GLYekxDZ) == tree.
- Provisioned runtime WITHOUT root (apt-get download + dpkg-deb -x into artifacts/runtime/root; proot for
  Xvfb's /tmp/.X11-unix; unshare -Urm mount --bind for the app). Redis 127.0.0.1:6379, Xvfb :99, app on :3000
  from dist/ with REAL_CHROME_ENABLED, LOCAL_BROWSER_ENABLED, DEPLOYMENT_MODE=single, random API_TOKEN in
  artifacts/runtime/token. Health: redis connected.
- tsc --noEmit clean; npm run build ok.
- Targeted vitest: real-chrome-shelf + workflow-binding-store + flow-editor-workflow-identity +
  picker-opens-real-chrome = 230/230.
- FULL vitest (REDIS_URL=redis://127.0.0.1:6379/15): 127 files / 3418 tests PASSED, 194 s.
- LIVE E2E on the real stack: PASSED all 9 steps + no page errors (see VERIFICATION). Two harness-only fixes
  were needed on the way (NOT product bugs): (1) setInputFiles on the bare #wfmup input bypasses the toolbar's
  target → file landed in workspace root, not uploads/; the real operator path is click #wfmupload → native
  chooser → uploads/ (probe now does that via waitForEvent('filechooser')); (2) the harness's own
  addInitScript threw "Failed to read the 'localStorage' property" in an opaque-origin popup frame — wrapped
  in try/catch; the product itself produced zero page errors.
- Promoted the e2e to a committed, env-parametrised probe: tools/probe-workflow-binding-rebind.js
  (PLYR_BASE / PLYR_API_KEY or PLYR_TOKEN_FILE / PLYR_OUT; exits non-zero on failure). Ran it: PASSED.
- Squashed 3 commits + probe into ONE (4eaf1e5), rebased on origin/main (no-op), pushed -f, PR #32 title and
  body rewritten with root cause, fix, tests and the verification table.
- Saved S18a transcript to sessions/; wrote this handoff; current-handoff.md → this file.

IN PROGRESS:
- none (PR #32 awaiting review/merge).

PENDING:
- Merge PR #32 (user). Next session starts from origin/main = merge commit.
- Optional: `npm run test:browser` (vitest.browser.config.ts, needs Xvfb) was NOT run this session; nothing in
  the browser tier touches the drawer's binding logic (it lives in ChromeView.ts, covered by the jsdom-style
  real-chrome-shelf suite).
- Carried from S17 (untouched): ecosystem.config.js still runs instances:4 cluster while RealChrome is
  single-tenant (SingletonLock) — running the Remote-Browser instance fork/instances:1 is documented, not enforced.
- Optional: wire tools/probe-workflow-binding-rebind.js into .github/workflows-pending/ci.yml once that
  workflow is un-parked (needs the Xvfb/Redis job that PR-CI does not have yet).

DECISIONS:
- Viewer identity has two sources with different lifetimes: an EXPLICIT URL id is pinned for the page's life
  (a viewer opened from workflow A must keep showing A even if the shared browser is later bound to B); a
  SERVER-DERIVED id is a snapshot of "what is the Local Browser bound to right now" and is re-read on every
  drawer open. This replaces S15's "only an empty answer is re-asked" rule, which was half of the truth.
- Re-resolving is cheap (one GET per drawer open) and only happens on the derived path; no polling, no
  websocket message, no Redis pub/sub — the drawer is the only consumer and it is opened by a click.
- Workspace-scoped UI state (selection, tree cache, open folders, upload target, pending delete) is reset on
  id change, never carried across workflows. A stale listing for the previous id is discarded, not merged.
- A derived id is never POSTed back to /bind on connect (it IS the server's answer). Only the explicit URL id
  binds — same as before; the S17 client-side bind in browser-view.js openRealBrowser() covers the noTab path.
- Lookup failure ≠ unbind: keep the last id, ask again next time (a Redis blip must not blank the drawer).
- Live proof is committed as a tools/probe-*.js (project convention), not as a vitest file: it needs the
  whole stack (dist/, Redis, Xvfb, real Chrome) and takes ~10 s; vitest stays fake-Playwright.
- Runtime provisioning in a root-less sandbox: apt-get download + dpkg-deb -x into artifacts/runtime/root
  (gitignored), proot to bind /tmp for Xvfb, `unshare -Urm` + `mount --bind` for the app so Chrome finds
  /tmp/.X11-unix/X99. Works; keep using it instead of apt-get install.

KNOWN ISSUES:
- POST /workflows/:userId rejects empty steps — e2e must send ≥1 step (S17).
- Test-suite contract still applies: no `from '…'` / `import('…')` text inside ChromeView.ts comments.
- Sandbox has ~985 MB RAM: do NOT run the full vitest suite and a Playwright Chromium at the same time
  (S18b waited for vitest to finish before launching the live probe).
- The bare <input id="wfmup"> has no upload target; only #wfmupload / context-menu "Upload Here" set
  wfmUploadInto. Harness code must click the button (documented in the probe). Not a product bug.
- gh CLI auth worked directly this session (no setup_github_environment needed).

VERIFICATION:
- tsc: clean. build: ok.
- vitest targeted: 230/230. vitest FULL: 127 files / 3418 tests passed (Redis attached).
- Live probe tools/probe-workflow-binding-rebind.js on dist/ + Redis + real Chrome on Xvfb :99 — all PASS:
  1 saved workflow identity survives reload; 2 library → picker → viewer pinned to A, lists only-A.txt;
  3 derived viewer (no URL id) lists A, Select-All shows a count; 4 openRealBrowser('',null,{noTab,workflowId:B})
  opens NO new tab, GET binding → B, derived viewer lists only-B.txt, only-A.txt count 0, #dcount empty;
  5 toolbar Upload → uploads/uploaded-B.txt under B only (not A); 6 Download returns 'exact upload bytes\n';
  7 pinned viewer still lists only-A.txt, no only-B.txt; 8 DELETE B → binding null, drawer says
  "not opened from a saved workflow"; 9 POST /bind A → same viewer lists only-A.txt again; 10 zero pageerrors.
  Screenshot: artifacts/runtime/workflow-B-verified.png (drawer shows uploads/uploaded-B.txt + only-B.txt).

CHANGED FILES (vs origin/main 2bbc299, in 4eaf1e5):
src/core/ChromeView.ts (+46/-19: workflowIdFromUrl, re-resolving resolveWorkflowId, workspace reset on id
  change, requestedWorkflowId guard in wfmFetchFolder, bindWorkflow only for URL id)
tests/unit/real-chrome-shelf.test.ts (+135: interceptFetch seam, 9 tests)
tools/probe-workflow-binding-rebind.js (NEW, live proof)
+ continuity: handoffs/2026-09-16_S18_viewer-follows-binding-pr32.md (this),
  sessions/2026-09-16T10-08Z_S18a_pr32-verification-credit-stops.md, current-handoff.md

LAST ACTION:
- PR #32 body updated at 4eaf1e5; writing continuity files; committing; taking backup20.

NEXT ACTION:
- User merges PR #32. Next session: `git fetch origin && git checkout -B genspark_ai_developer origin/main`,
  read this handoff, continue from what the user reports. If a "wrong workflow's files" report persists,
  first run tools/probe-workflow-binding-rebind.js against the deployment (PLYR_BASE + PLYR_API_KEY) and
  check `redis-cli get wf:binding:realchrome`.

HISTORY:
- S8: PR #28 (one workspace per workflow, hamburger drawer, system folders, binding).
- S9/S10: PR #29 (download / multi-select / one-only guard) — merged 022d3ae.
- S12–S15: P1–P4 (chooser lifecycle, uploads filed, identity survives reload) — PR #30 merged 7364d67.
- S16/S17: binding lost after restart/Retry → Redis-backed binding + client bind on launch — PR #31 merged 2bbc299.
- S18a: traced remaining bug (derived viewer stuck on A after rebind to B), fixed + 9 tests, 3 commits pushed to
  PR #32; two credit stops during the live e2e; one sandbox reset (backups AfCv7Bbv, GLYekxDZ).
- S18b (this): restored, full suite green, live e2e green, probe committed, squashed 4eaf1e5, PR #32 finalised.

BACKUP LINEAGE:
- backup9  BpvqsjcH  webapp_backup_isteb32b.tar.gz  (S8→S9 start)
- backup10 zQ9nUMQv  webapp_backup_i6oivnl9.tar.gz  (S9 end, c0183b0 clean)
- backup11 H1BgI2mK  webapp_backup_2026-09-14_S10_pr29.tar.gz  (S10 end: 53c279b + 84d3ffe)
- backup12 YNwHDINY  webapp_backup_ijsxiwud.tar.gz  (S14 end: 022d3ae + 5 uncommitted src/test files)
- backup13 sEwkbhf9  webapp_backup_2026-09-14_S15_p1-p4.tar.gz  (S15 end: 9674007 + handoff 45b08fe)
- backup14 kWH1BI8A  (S15→S16 start; == 7364d67 after PR #30 merge)
- backup15 K6JRkn0g  webapp_backup_icleiyd1.tar.gz  (S16 mid, sandbox reset; 7364d67 clean)
- backup16 tWpjBJtb  webapp_backup_iz4r9rwy.tar.gz  (S16 mid, sandbox reset; 7364d67 clean)
- backup17 E7T6RZh5  webapp_backup_i5mf16de.tar.gz  (S16 end: 7364d67 + 6 uncommitted files; MSG-80/82 tests missing)
- backup18 bZJuAgJm  latest_runtime_backup.tar.gz  (S17 end: 9da1653 + handoff commit; == 2bbc299 tree after merge)
- backup18b AfCv7Bbv recovery_2026-09-16.tar.gz  (S18a mid, sandbox reset; == 2bbc299 clean)
- backup19 GLYekxDZ  (S18a end: == b0a331a, PR #32 pre-squash, 3 commits, clean)
- backup20 <link in S18b closing message>  webapp_backup_2026-09-16_S18_pr32.tar.gz  (S18b end: 4eaf1e5 + continuity commit, includes .git)
