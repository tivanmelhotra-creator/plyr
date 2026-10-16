#!/usr/bin/env bash
# The 8 real-Chromium profile/viewer files, in small groups (the sandbox has ~1 GB RAM; one process for all 8 froze it in S37).
cd /home/user/webapp
O=handoffs/2026-10-16_S37_browser-tests.txt
echo "HEAD $(git rev-parse --short HEAD)  $(date -u +%FT%TZ)  (groups, one vitest process each)" > $O
for g in "tests/browser/profile-real-chromium.test.ts tests/browser/turn-off-and-show.test.ts" \
         "tests/browser/orphan-browsers.test.ts tests/browser/local-browser-profile-selection.test.ts tests/browser/profile-open-turn-off.test.ts" \
         "tests/browser/viewer-self-close.test.ts" \
         "tests/browser/manual-second-profile.test.ts" \
         "tests/browser/play-link-semantics.test.ts"; do
  echo "RUN npx vitest run --config vitest.browser.config.ts $g" >> $O
  timeout 900 npx vitest run --config vitest.browser.config.ts $g > /tmp/bg.txt 2>&1; echo "EXIT=$?" >> /tmp/bg.txt
  sed 's/\x1b\[[0-9;]*m//g' /tmp/bg.txt | grep -E "^ +[✓×] |^ FAIL |Test Files|     Tests |EXIT=|→" >> $O
done
echo ALLDONE >> $O
