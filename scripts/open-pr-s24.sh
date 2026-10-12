#!/usr/bin/env bash
# Push feat/profile-infrastructure and open its PR against main.
# Needs a working GitHub login (gh auth status / git credentials).
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH=feat/profile-infrastructure
git checkout "$BRANCH"
git push -u origin "$BRANCH"
if gh pr view "$BRANCH" >/dev/null 2>&1; then
  echo "PR already exists:"; gh pr view "$BRANCH" --json url -q .url
else
  gh pr create --base main --head "$BRANCH" \
    --title "feat(profiles): phase 1 — shared browser-profile infrastructure (registry, reservations, sessions, lifecycle)" \
    --body-file handoffs/PR-S24-profile-infrastructure.md
fi
