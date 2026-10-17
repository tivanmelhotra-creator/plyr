#!/usr/bin/env bash
# Full unit+integration, results into handoffs/ (survive resets). Browser tests: tools/s37/run-browser-groups.sh.
cd /home/user/webapp
O=handoffs/2026-10-16_S38_tests-raw.txt
{ echo "HEAD $(git rev-parse --short HEAD)  $(date -u +%FT%TZ)"; echo "RUN npx vitest run tests/unit tests/integration"; } > $O
timeout 1500 npx vitest run tests/unit tests/integration > /tmp/u.txt 2>&1; echo "EXIT=$?" >> /tmp/u.txt
sed 's/\x1b\[[0-9;]*m//g' /tmp/u.txt | grep -E "^ +× |^ FAIL |Test Files|     Tests |EXIT=" | sort -u >> $O
echo ALLDONE >> $O
