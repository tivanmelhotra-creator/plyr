# current-handoff.md

Points to the newest handoff. Read that file first; then the latest backup; then continue.

LATEST HANDOFF: handoffs/2026-09-14_S15_chooser-lifecycle-uploads-identity.md
LATEST BACKUP:  https://www.genspark.ai/api/files/s/sEwkbhf9  (backup13, webapp_backup_2026-09-14_S15_p1-p4.tar.gz, tree == 45b08fe, includes .git)
BRANCH / HEAD:  genspark_ai_developer @ 9674007 (+ handoff commit) on top of origin/main 022d3ae. NOT YET PUSHED (no GitHub credential in the S15 sandbox).

NEXT ACTION: with GitHub auth available, `git fetch origin && git rebase origin/main && git push -f origin genspark_ai_developer`, open PR #30 (genspark_ai_developer → main), share the link.

Layout:
- current-handoff.md   → this pointer
- handoffs/            → compressed per-session operational states (newest wins)
- sessions/            → raw session transcripts (search by relevance, never replay blindly)
- backups/             → NOT in git; tar.gz archives shared via Genspark file links (lineage in handoffs)
