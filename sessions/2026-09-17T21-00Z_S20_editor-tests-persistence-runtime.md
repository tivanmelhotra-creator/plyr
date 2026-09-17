# S20 — 2026-09-17 ~21:00Z → 22:00Z — editor tests, real persistence, runtime (condensed; raw transcript not exported)

Context: continuation of S19b (sessions/2026-09-17T20-52Z_S19b_editor-issue1-issue2.md), which ended on credit exhaustion
after 7e713ed with 15 shelf tests failing and E1–E12 unwritten. User's 6-stage instruction is MESSAGE 109 of that file.

Timeline:
1. Sandbox was on main (pre-PR#33). `git fetch && git checkout -B genspark_ai_developer origin/genspark_ai_developer`
   → 7e713ed. backup21 (wdBOCFOo) diffed clean against it.
2. Ran real-chrome-shelf: 159 tests, 15 failed (164 s). 14× "clickFileRow is not defined", 1× menu-Select assertion.
   Ran the same file at ef2265c in a worktree: 4 of those tests already failed there (pre-PR#33 expectations).
3. Hoisted rowByPath/clickFileRow to file scope, added clickFileName; rewrote the 4 stale-model tests to assert the
   PR#33 model in both intents (no loosening; NORMAL selection test added). Files pane 45/45.
4. Appended describe "Workflow Files Editor (E1-E12) and the Issue 1 latency rule" (17 tests). Harness: fileContent(),
   document keydown recorded → h.key('Escape'). 17/17. Mutation check: strip the 3 same-tick wfmSyncSelection() → only
   the latency test fails → restored.
5. Sandbox RESET (#1). Restored branch; backup21b (2VDZBjIA) == 7e713ed; edits above had to be redone → they were
   (same content). Added integration describe "the editor's content pair" (6 tests) against real WorkflowStorage;
   fixed test app json limit to 20mb and moved seed file into ed/ so a sibling from another test did not pollute.
6. Sandbox RESET (#2). Restored branch; backup22 (RGUKEb3O) contained ALL of steps 3–5 uncommitted → overlaid via tar,
   committed fa83215, pushed immediately (lesson: checkpoint-push early).
7. integration 40/40; tsc 0; npm run build 0; 7 suites 329/0/0 (181 s for the shelf file).
8. Runtime: sudo apt-get redis-server xvfb x11vnc novnc websockify openbox; .env single-user admin123; redis; desktop.sh
   start; openbox; node dist/index.js; /health ok; /browser/real/open ok; workflow wf_6e6e264744d33b32 created, notes.txt
   POST→GET→PUT→GET verified live, empty.md, bind local; public URL captured; viewer loads (1 harmless noVNC warning).
9. Handoff S20 + pointer + this file; commit; push; backup23.
