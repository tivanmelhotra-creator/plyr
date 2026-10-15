#!/usr/bin/env bash
# Start the REAL app from <tree> on :3000, detached (own process group), with a fresh data dir.
# Usage: tools/s35/start-server.sh <tree> <datadir>
# Prints which tree really serves :3000, so a stale server is never measured by mistake
# (S35: an early comparison silently hit the main server; this guard exists because of it).
TREE=$1; DATA=$2
if [ -f /tmp/s35.pgid ]; then kill -- -"$(cat /tmp/s35.pgid)" 2>/dev/null; fi
for p in $(ss -ltnp 2>/dev/null | grep ":3000 " | grep -o "pid=[0-9]*" | cut -d= -f2); do kill "$p" 2>/dev/null; done; sleep 2
pkill -f "user-data-dir=/tmp/s35-" 2>/dev/null; sleep 1
rm -rf "$DATA"; mkdir -p "$DATA"; redis-cli flushall >/dev/null
cd "$TREE"
env APP_ENV=development NODE_ENV=development DEPLOYMENT_MODE=single ALLOW_OPEN_AUTH=true PORT=3000 \
  REDIS_URL=redis://127.0.0.1:6379 PUBLIC_DOMAIN=http://localhost:3000 \
  PROFILES_DIR="$DATA/profiles" BRANCH_BASE_DIR="$DATA/branches" REAL_CHROME_USER_DATA_DIR="$DATA/profiles/chrome-profile" \
  WORKFLOW_STORAGE_ROOT="$DATA/wf" SQLITE_PATH="$DATA/plyr.db" DESKTOP_NOVNC_WEB_ROOT=/usr/share/novnc \
  setsid node_modules/.bin/tsx src/index.ts > "$DATA/server.log" 2>&1 < /dev/null &
echo $! > /tmp/s35.pgid; disown
for i in $(seq 1 90); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/health; then
    pid=$(ss -ltnp 2>/dev/null | grep ':3000 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    echo "UP after ${i}s; :3000 served by pid $pid from $(readlink /proc/$pid/cwd 2>/dev/null || echo '?')"; exit 0
  fi; sleep 1
done
echo NOT UP; tail -30 "$DATA/server.log"; exit 1
