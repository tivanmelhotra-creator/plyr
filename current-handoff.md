# current-handoff.md

Points to the newest handoff. Read that file first; then continue.

LATEST HANDOFF: handoffs/NEXT-SESSION-S37.md (START HERE: state, done, open items in order) + briefs in handoffs/task-pull-76/
BRANCH / HEAD:  feat/profile-infrastructure (PR #76, phase 1).
BACKUP:         lineage is kept in the handoff files; backups are NOT in git (tar.gz shared via Genspark file links).
TRANSCRIPT:     after a sandbox reset, the owner's full chat transcript (incl. the phase-1 brief, sections 0-14) is in the
                LOCAL-ONLY git branch `local/session-archive` (inside .git, so it is in every project backup; never pushed:
                the repo is public). Read: git show local/session-archive:2026-10-14_S29_conversation.txt.gz | gunzip | less

PLAN:           docs/PLAN-node-logic-v2.md (node logic v2 + production roadmap; start with milestone M1).

NEXT ACTION: see handoffs/NEXT-SESSION-S37.md section 4 (G.2 UI first). PR #76 NOT pushed since 491de46, NOT merged.

Layout:
- current-handoff.md   -> this pointer
- handoffs/            -> compressed per-session operational states (newest wins)
- sessions/            -> raw session transcripts (search by relevance, never replay blindly)
- backups/             -> NOT in git
