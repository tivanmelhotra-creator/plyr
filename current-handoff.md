# current-handoff.md

Points to the newest handoff. Read that file first; then the latest backup; then continue.

LATEST HANDOFF: handoffs/2026-09-16_S18_viewer-follows-binding-pr32.md
LATEST BACKUP:  backup20 (link in the S18b closing chat message; webapp_backup_2026-09-16_S18_pr32.tar.gz, tree == HEAD, includes .git). Previous: https://www.genspark.ai/api/files/s/GLYekxDZ (backup19, S18a end, == b0a331a PR #32 pre-squash).
BRANCH / HEAD:  genspark_ai_developer @ 4eaf1e5 (+ continuity commit) on top of origin/main 2bbc299 (PR #31 merged). PUSHED. PR #32 OPEN: https://github.com/tivanmelhotra-creator/plyr/pull/32

NEXT ACTION: user merges PR #32. Next session: `git fetch origin && git checkout -B genspark_ai_developer origin/main`, read handoffs/2026-09-16_S18_viewer-follows-binding-pr32.md, continue from what the user reports. Live proof for the drawer/binding contract: `node tools/probe-workflow-binding-rebind.js` (needs dist/, Redis, Xvfb, real Chrome).

Layout:
- current-handoff.md   → this pointer
- handoffs/            → compressed per-session operational states (newest wins)
- sessions/            → raw session transcripts (search by relevance, never replay blindly)
- backups/             → NOT in git; tar.gz archives shared via Genspark file links (lineage in handoffs)
