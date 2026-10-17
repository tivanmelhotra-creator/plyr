#!/usr/bin/env bash
# tools/s35/run-ref.sh <tree> <label> <drawer|window> : fresh server from <tree>, then the viewer scenario.
TREE=$1; LABEL=$2; MODE=$3; HERE=$(cd "$(dirname "$0")" && pwd)
bash "$HERE/start-server.sh" "$TREE" /tmp/s35-run > /tmp/s35-start.txt 2>&1 < /dev/null || { cat /tmp/s35-start.txt; exit 1; }
cat /tmp/s35-start.txt
curl -s -X POST localhost:3000/browser/desktop/start -H 'content-type: application/json' -d '{}' >/dev/null
cp "$HERE/viewer-scenario.mjs" "$TREE/.s35-viewer-scenario.mjs"
cd "$TREE" && timeout 200 node .s35-viewer-scenario.mjs "$LABEL" "$MODE" 2>&1 | grep -v '^$' | tail -30
rm -f "$TREE/.s35-viewer-scenario.mjs"
