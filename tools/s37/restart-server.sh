#!/usr/bin/env bash
# Restart the REAL app on :3000 from <tree> KEEPING <datadir> and Redis (server-restart persistence, brief 2.3).
# Usage: tools/s37/restart-server.sh <tree> <datadir>
TREE=$1; DATA=$2
if [ -f /tmp/s35.pgid ]; then kill -- -"$(cat /tmp/s35.pgid)" 2>/dev/null; fi
for p in $(ss -ltnp 2>/dev/null | grep ":3000 " | grep -o "pid=[0-9]*" | cut -d= -f2); do kill "$p" 2>/dev/null; done; sleep 3
cd "$TREE"
env APP_ENV=development NODE_ENV=development DEPLOYMENT_MODE=single ALLOW_OPEN_AUTH=true PORT=3000 \
  REDIS_URL=redis://127.0.0.1:6379 PUBLIC_DOMAIN=http://localhost:3000 \
  PROFILES_DIR="$DATA/profiles" BRANCH_BASE_DIR="$DATA/branches" REAL_CHROME_USER_DATA_DIR="$DATA/profiles/chrome-profile" \
  WORKFLOW_STORAGE_ROOT="$DATA/wf" SQLITE_PATH="$DATA/plyr.db" DESKTOP_NOVNC_WEB_ROOT=/usr/share/novnc \
  setsid node_modules/.bin/tsx src/index.ts >> "$DATA/server.log" 2>&1 < /dev/null &
echo $! > /tmp/s35.pgid; disown
for i in $(seq 1 90); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/health; then
    pid=$(ss -ltnp 2>/dev/null | grep ':3000 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    echo "RESTARTED after ${i}s; :3000 served by pid $pid from $(readlink /proc/$pid/cwd 2>/dev/null || echo '?')"; exit 0
  fi; sleep 1
done
echo NOT UP; tail -30 "$DATA/server.log"; exit 1
