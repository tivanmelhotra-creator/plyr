#!/usr/bin/env bash
# Bring the whole dev stack up from nothing, idempotently.
#
# The point of this script is that there is exactly ONE command to run, and it
# never leaves the operator guessing which half is missing:
#   * Redis on 6379           (queues, users, tabs)
#   * Xvfb on :99             (a headed Chrome needs pixels to exist)
#   * node dist/index.js      (the API + /browser/ws)
#
# Everything is checked before it is started, so running it twice is safe.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
PORT="${PORT:-3000}"

say() { printf '[dev] %s\n' "$*"; }

# ── Public domain (optional) ─────────────────────────────────────────────────
# Asked BEFORE the server starts, because this value is read at boot and is what
# gets shown beside the Authorization Code. Asking afterwards would mean the
# first pairing of the session still advertised a detected address.
#
# Silent and non-blocking when there is no terminal, so CI and nohup runs are
# unaffected — see scripts/ask-domain.sh.
# shellcheck source=scripts/ask-domain.sh
. "${ROOT}/scripts/ask-domain.sh"
ask_public_domain

# ── Redis ────────────────────────────────────────────────────────────────────
if redis-cli -p 6379 ping >/dev/null 2>&1; then
  say "redis already up on 6379"
else
  say "starting redis on 6379"
  redis-server --daemonize yes --port 6379 --save '' --appendonly no >/dev/null 2>&1
  for _ in $(seq 1 20); do
    redis-cli -p 6379 ping >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

# ── Xvfb ─────────────────────────────────────────────────────────────────────
if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; then
  say "display :${DISPLAY_NUM} already up"
else
  say "starting Xvfb on :${DISPLAY_NUM}"
  Xvfb ":${DISPLAY_NUM}" -screen 0 1280x800x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  for _ in $(seq 1 30); do
    [ -e "/tmp/.X${DISPLAY_NUM}-lock" ] && break
    sleep 0.3
  done
fi

# ── the server ───────────────────────────────────────────────────────────────
# Kill by port, not by pattern: `pkill -f dist/index.js` also matches the shell
# that is running this script when it was invoked with -c.
OLD="$(ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)"
if [ -n "${OLD:-}" ]; then
  say "stopping old server (pid ${OLD})"
  kill "${OLD}" 2>/dev/null
  for _ in $(seq 1 30); do
    kill -0 "${OLD}" 2>/dev/null || break
    sleep 0.3
  done
  kill -9 "${OLD}" 2>/dev/null
fi

say "starting server on ${PORT} (DISPLAY=:${DISPLAY_NUM})"
setsid env DISPLAY=":${DISPLAY_NUM}" node "${ROOT}/dist/index.js" \
  >/tmp/server.log 2>&1 < /dev/null &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  say "up: http://127.0.0.1:${PORT}  (log: /tmp/server.log)"
else
  say "server did not answer /health — see /tmp/server.log"
  tail -30 /tmp/server.log
  exit 1
fi
