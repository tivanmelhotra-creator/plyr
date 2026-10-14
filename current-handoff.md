# current-handoff.md

Points to the newest handoff. Read that file first; then continue.

LATEST HANDOFF: handoffs/NEXT-SESSION-S31.md (START HERE: done/open per brief + how to continue) -> then handoffs/2026-10-14_S30_phase1-report.md (section-14 report)
BRANCH / HEAD:  feat/profile-infrastructure (PR #76, phase 1).
BACKUP:         lineage is kept in the handoff files; backups are NOT in git (tar.gz shared via Genspark file links).
TRANSCRIPT:     after a sandbox reset, the owner's full chat transcript (incl. the phase-1 brief, sections 0-14) is in the
                LOCAL-ONLY git branch `local/session-archive` (inside .git, so it is in every project backup; never pushed:
                the repo is public). Read: git show local/session-archive:2026-10-14_S29_conversation.txt.gz | gunzip | less

PLAN:           docs/PLAN-node-logic-v2.md (node logic v2 + production roadmap; start with milestone M1).

NEXT ACTION: see handoffs/NEXT-SESSION-S31.md (Windows manual checks are owner-run and non-blocking). PR #76 pushed, NOT merged.

Layout:
- current-handoff.md   -> this pointer
- handoffs/            -> compressed per-session operational states (newest wins)
- sessions/            -> raw session transcripts (search by relevance, never replay blindly)
- backups/             -> NOT in git
