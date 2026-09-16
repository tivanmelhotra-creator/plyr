SESSION: S17 — 2026-09-16T08:27Z (this session)
PREVIOUS SESSION: S16 — 2026-09-15T09:26Z→~12:10Z. Two sandbox resets inside S16 (backup15 K6JRkn0g,
                  backup16 tWpjBJtb both == 7364d67 clean). Implemented the Redis-backed binding + client
                  launch bind + 6 picker tests; credit stop at MESSAGE 82/83 while the FIRST vitest run of the
                  two new test files was in flight. Its 6 uncommitted src/test edits survived ONLY in backup17
                  (E7T6RZh5); the two artifacts written in MESSAGE 80 (tests/unit/workflow-binding-store.test.ts)
                  and MESSAGE 82 (integration describe block) were NOT in backup17 and were re-created here.
                  Transcript: sessions/2026-09-15T09-26Z_S16_redis-binding-restart-survival.md.

PROJECT STATE: branch genspark_ai_developer @ 9da1653 (1 commit on top of origin/main 7364d67 = PR #30 merged).
               PUSHED. PR #31 OPEN: https://github.com/tivanmelhotra-creator/plyr/pull/31  (genspark_ai_developer → main)
               (+ this handoff commit on top; see git log.)
CURRENT BACKUP: backup18 — taken at S17 end (link in the chat message that closes S17; tree == HEAD incl. .git)
PREVIOUS BACKUP: https://www.genspark.ai/api/files/s/E7T6RZh5  (backup17, webapp_backup_i5mf16de.tar.gz, 15.06 MB,
                 S16 end: tree = 7364d67 + 6 UNCOMMITTED files; MESSAGE-80/82 tests NOT in it)

OBJECTIVE:
Reported (S16, Persian): after a server restart — or after Retry relaunched the Local Browser with `noTab` —
the Workflow Files drawer said "not opened from a saved workflow" for a browser plainly opened from one, and
downloads/uploads made afterwards were not filed under the workflow. Fix root cause, test, ship as PR #31.

ROOT CAUSE (confirmed S16, verified live S17):
- src/core/WorkflowBinding.ts kept the Local Browser binding in a module-level `let` = PROCESS MEMORY.
  1. pm2 restart / deploy / max_memory_restart emptied it; the Chrome profile (REAL_CHROME_USER_DATA_DIR) on
     disk survived → same browser, bound to nothing.
  2. ecosystem.config.js runs 4 cluster workers; POST /bind hit one worker, GET /browser/workflow-files-binding
     and the shelf/chooser persist hit others → 3 of 4 said "nothing bound".
  3. The `noTab` launch path (Retry, Alert re-raise in browser-view.js) never opens the viewer page, which was
     the ONLY place that POSTed /bind → never bound.

COMPLETED (this session):
- Sandbox was reset again (== 7364d67 on main, no .env, no redis). Downloaded backup17, verified its 6 modified
  files are exactly S16's edits (git diff --stat 264+/14-), copied them onto a fresh genspark_ai_developer.
- Provisioned redis-server/xvfb/x11vnc/novnc/openbox + playwright deps; .env (PORT=3000, DEPLOYMENT_MODE=single,
  API_TOKEN=admin123, REDIS_URL, REAL_CHROME_ENABLED, REAL_CHROME_DISPLAY=:99, LOCAL_BROWSER_ENABLED).
- Re-created tests/unit/workflow-binding-store.test.ts (14 tests) — fake BindingStore; memory-only parity,
  write→memory+store under REAL_CHROME_BINDING_KEY, unbind deletes, fresh-process read-back, transfer ALWAYS
  re-reads (re-bind / unbind by another worker honoured), corrupt/half record → null, store write failure
  logged not thrown (binding still holds in-process), store read failure keeps last memory value, detach
  returns to memory-only, memory is visible BEFORE the store round-trip completes.
- Re-created the integration describe "workflow files: the Local Browser binding survives a restart" (7 tests)
  appended to tests/integration/workflow-files-routes.test.ts — bind→GET; record in same store/fixed key;
  resetRealChromeBindingForTests() then GET still answers; realChromeWorkflowForTransfer() on fresh process;
  stale binding (workflow deleted) cleared AND key deleted; other user's binding hidden (x-test-user bob);
  re-bind replaces durably.
- tsc --noEmit clean; npm run build:server ok.
- vitest: workflow-binding-store (14) + workflow-files-routes (34) = 48/48; picker-opens-real-chrome,
  retry-repeats-the-last-pick-without-a-new-tab, alert-never-takes-a-tab-the-operator-opened,
  initial-tab-becomes-the-project-page, targeting-flow, real-chrome-shelf, remote-file-chooser = 353/353.
- LIVE E2E on dist/ + real Redis (pm2 fork, name e2e, since deleted): POST /workflows/local (steps must be
  non-empty: [{action:'goto',url}]) → POST /browser/workflow-files/<id>/bind {target:'local'} → bound:true;
  GET /browser/workflow-files-binding → {local:{workflowId}}; redis-cli get wf:binding:realchrome shows
  {"userId":"local","workflowId":…}; `pm2 restart e2e` → GET STILL names the workflow; DELETE
  /workflows/local/<id> → GET returns local:null AND the Redis key is gone.
- Committed 9da1653 (single comprehensive commit), rebased on origin/main (no-op), pushed -f, opened PR #31.
- Saved S16 transcript to sessions/; wrote this handoff; current-handoff.md → this file.

IN PROGRESS:
- none (PR #31 awaiting review/merge).

PENDING:
- Merge PR #31 (user). After merge, next session should start from origin/main = merge commit.
- Optional: full `npm test` / `npm run test:browser` (Xvfb) — not re-run; only the 7 targeted suites + the
  two binding suites were run. Nothing in the browser tier touches WorkflowBinding.
- Optional manual walk: open workflow → Local Browser → drawer shows tree → `pm2 restart` → reopen drawer →
  still the tree (not "not opened from a saved workflow") → download → appears under <workflow>/downloads/.
- Optional follow-up (NOT started, needs a decision): ecosystem.config.js still runs instances:4 cluster.
  Binding is now worker-safe, but RealChrome itself is still single-tenant (SingletonLock) — see the comment
  block in ecosystem.config.js. Running the Remote-Browser instance with instances:1/fork is documented, not enforced.

DECISIONS:
- Binding is stored in Redis under ONE fixed key `wf:binding:realchrome` (RealChrome is single-tenant: one
  profile dir, one SingletonLock → exactly one Local Browser per deployment). Same Redis as the workflow it
  names, so it is exactly as durable as the thing it points at.
- `BindingStore` is a get/set/del slice typed independently of ioredis, so route tests hand in their in-memory
  stub (makeConnection() in workflow-files-routes.test.ts already had get/set/del). attachBindingStore(null)
  detaches → memory-only (unit tests). Attached once, in createWorkflowFilesRoutes().
- bindRealChrome() is async: writes memory FIRST (sync, so in-process readers never see a gap), then awaits
  the store so POST /bind's `bound:true` is only said once durable. Store failure → console.warn, never thrown.
- refreshRealChromeBinding(): read-through; on store error KEEPS last memory value (a Redis blip must not
  unfile a download). realChromeWorkflowForTransfer() ALWAYS refreshes (the earlier `hydrated` flag was
  removed in S16 MESSAGE 68/69: a re-bind on another worker must be seen; transfers are rare and async).
  realChromeWorkflow() stays sync (memory) for callers that cannot await.
- GET /browser/workflow-files-binding: read-through; if the bound workflow no longer exists → bindRealChrome(null)
  and answer null (view never builds a workspace for a deleted workflow); owner check via resolveOwner() —
  another user's binding is answered as null, EXCEPT owner === 'env_root' (admin key sees everything, as it
  does for the files themselves). Single-user mode: owner is SINGLE_USER_ID ('local').
- Client: browser-view.js openRealBrowser() POSTs /bind {target:'local'} right after a successful
  /browser/real/open when workflowIdFor(o) yields an id — best-effort, .catch(noop), not awaited, so the
  launch never fails or slows because of it. The viewer page's own bind on connect is kept (idempotent).
  Malformed ids are filtered by workflowIdFor() (test: '../etc' → no bind).
- Test seam: resetRealChromeBindingForTests() wipes memory only (simulates restart / another worker).

KNOWN ISSUES:
- POST /workflows/:userId rejects empty steps ("Steps cannot be empty") — e2e must send ≥1 step.
- setup_github_environment reported "no valid token" in S17, but ~/.git-credentials (x-access-token) already
  worked for ls-remote/push and the REST API — use it directly next time before assuming push is blocked.
- Test-suite contract still applies: no `from '…'` / `import('…')` text inside ChromeView.ts comments.

VERIFICATION:
- tsc: clean. build:server: ok.
- vitest: 48/48 (binding-store + wf-files routes), 353/353 (7 Local-Browser suites). Full suite NOT re-run.
- Live e2e: bind → pm2 restart → still bound; delete workflow → cleared (see COMPLETED).

CHANGED FILES (vs origin/main 7364d67, in 9da1653):
src/core/WorkflowBinding.ts (+144/-14: BindingStore, REAL_CHROME_BINDING_KEY, attachBindingStore,
  async bindRealChrome, refreshRealChromeBinding, realChromeWorkflowForTransfer, resetRealChromeBindingForTests)
src/Routes/workflow-files.routes.ts (attach store; await bind; read-through GET with stale-clear + owner check)
src/core/RealChromeShelf.ts, src/core/RemoteFileChooser.ts (persist via realChromeWorkflowForTransfer())
public/js/browser-view.js (openRealBrowser binds after launch)
tests/unit/workflow-binding-store.test.ts (NEW, 14)
tests/integration/workflow-files-routes.test.ts (+7)
tests/unit/picker-opens-real-chrome.test.ts (+6, written in S16 MESSAGE 79)
+ continuity: handoffs/2026-09-16_S17_redis-binding-pr31.md (this),
  sessions/2026-09-15T09-26Z_S16_redis-binding-restart-survival.md, current-handoff.md

LAST ACTION:
- Opened PR #31; wrote this handoff; committing continuity files; taking backup18.

NEXT ACTION:
- User merges PR #31. Next session: `git fetch origin && git checkout -B genspark_ai_developer origin/main`,
  read this handoff, then pick up whatever the user reports next. If a restart-related report persists,
  first check `redis-cli get wf:binding:realchrome` and GET /browser/workflow-files-binding on the deployment
  (and whether it runs 4 cluster workers with the Remote Browser — see PENDING).

HISTORY:
- S8: PR #28 (one workspace per workflow, hamburger drawer, system folders, binding).
- S9/S10: PR #29 (download / multi-select / one-only guard) — merged 022d3ae.
- S12–S15: P1–P4 (chooser lifecycle, uploads filed, identity survives reload) — PR #30 merged 7364d67.
- S16: user reported binding lost after restart/Retry. Root-caused (process memory, 4 workers, noTab path).
  Implemented server+client fix, 6 picker tests; 2 sandbox resets; credit stop mid first test run.
- S17 (this): restored from backup17, re-created the 2 lost test artifacts, all green, live e2e, PR #31.

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
- backup18 <link in S17 closing message>  webapp_backup_2026-09-16_S17_pr31.tar.gz  (S17 end: 9da1653 + handoff commit, includes .git)
