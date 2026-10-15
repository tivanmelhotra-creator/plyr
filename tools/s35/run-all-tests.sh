#!/usr/bin/env bash
# Full unit+integration, then the real-Chromium profile/viewer files. Output -> handoffs/ (survives resets).
cd /home/user/webapp
O=handoffs/2026-10-15_S35_tests-raw.txt
{ echo "HEAD $(git rev-parse --short HEAD)  $(date -u +%FT%TZ)"; echo "RUN npx vitest run tests/unit tests/integration"; } > $O
timeout 1200 npx vitest run tests/unit tests/integration > /tmp/u.txt 2>&1; echo "EXIT=$?" >> /tmp/u.txt
sed 's/\x1b\[[0-9;]*m//g' /tmp/u.txt | grep -E "^ +× |^ FAIL |Test Files|     Tests |EXIT=" | sort -u >> $O
echo "RUN npx vitest run --config vitest.browser.config.ts <6 profile/viewer files>" >> $O
timeout 1200 npx vitest run --config vitest.browser.config.ts tests/browser/profile-real-chromium.test.ts tests/browser/turn-off-and-show.test.ts tests/browser/orphan-browsers.test.ts tests/browser/local-browser-profile-selection.test.ts tests/browser/profile-open-turn-off.test.ts tests/browser/viewer-self-close.test.ts > /tmp/b.txt 2>&1; echo "EXIT=$?" >> /tmp/b.txt
sed 's/\x1b\[[0-9;]*m//g' /tmp/b.txt | grep -E "^ +[✓×] |^ FAIL |Test Files|     Tests |EXIT=|^\[[a-g]\]" >> $O
echo ALLDONE >> $O
