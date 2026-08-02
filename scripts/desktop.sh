#!/usr/bin/env bash
#
# desktop.sh — virtual screen for the REAL Chrome, viewable in a browser tab.
#
#   Xvfb        an X display that exists only in RAM (no GPU, no monitor)
#   x11vnc      exports that display over VNC, bound to localhost
#   websockify  wraps VNC in WebSocket and serves the noVNC HTML client
#
# WHY: Chrome only loads extensions when it is HEADED, and an extension's
# toolbar popup / chrome://extensions / the native file-open dialog are not part
# of any page, so they can never appear in the app's canvas screencast. Looking
# at the X display is the only way to click them.
#
#   bash scripts/desktop.sh install     # apt-get the three packages
#   bash scripts/desktop.sh start
#   bash scripts/desktop.sh status
#   bash scripts/desktop.sh stop
#
# Then open  http://<server>:6080/vnc.html
#
# SECURITY: this screen holds every cookie you import. x11vnc is bound to
# 127.0.0.1 here and only websockify is reachable. Do NOT publish port 6080 on a
# public interface without a password and TLS — tunnel it instead:
#
#   ssh -N -L 6080:127.0.0.1:6080 you@server
#
set -euo pipefail

DISPLAY_NUM="${REAL_CHROME_DISPLAY:-:99}"
SCREEN_W="${REAL_CHROME_WINDOW_WIDTH:-1280}"
SCREEN_H="${REAL_CHROME_WINDOW_HEIGHT:-800}"
VNC_PORT="${DESKTOP_VNC_PORT:-5900}"
NOVNC_PORT="${DESKTOP_NOVNC_PORT:-6080}"
VNC_PASSWORD="${DESKTOP_VNC_PASSWORD:-}"

# Load .env if present so the script and the server agree on ports.
# The repo's .env files are CRLF (Windows-authored), and sourcing one directly
# leaves a literal \r on every value — which turns ":99" into ":99\r" and makes
# Xvfb fail with an error that names no cause at all. Strip them first.
if [ -f .env ]; then
  _envtmp="$(mktemp)"
  sed 's/\r$//' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "$_envtmp" || true
  # shellcheck disable=SC1090
  set -a; . "$_envtmp"; set +a
  rm -f "$_envtmp"
  DISPLAY_NUM="${REAL_CHROME_DISPLAY:-$DISPLAY_NUM}"
  VNC_PORT="${DESKTOP_VNC_PORT:-$VNC_PORT}"
  NOVNC_PORT="${DESKTOP_NOVNC_PORT:-$NOVNC_PORT}"
  VNC_PASSWORD="${DESKTOP_VNC_PASSWORD:-$VNC_PASSWORD}"
fi

DNUM="${DISPLAY_NUM#:}"
DNUM="${DNUM%%.*}"
RUN_DIR="${TMPDIR:-/tmp}/ab-desktop"
mkdir -p "$RUN_DIR"

log() { printf '\033[36m[desktop]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[desktop]\033[0m %s\n' "$*" >&2; }

novnc_root() {
  for d in /usr/share/novnc /usr/share/webapps/novnc /usr/local/share/novnc /opt/novnc; do
    [ -d "$d" ] && { echo "$d"; return 0; }
  done
  return 1
}

port_open() {
  # bash's /dev/tcp needs no extra tooling and is exact about "is it listening".
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && exec 3<&- && return 0
  return 1
}

cmd_install() {
  log "installing xvfb, x11vnc, novnc, websockify …"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify unzip
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y xorg-x11-server-Xvfb x11vnc novnc python3-websockify unzip
  else
    err "Unsupported package manager. Install manually: Xvfb, x11vnc, novnc, websockify, unzip."
    exit 1
  fi
  log "done."
}

cmd_start() {
  local missing=()
  for bin in Xvfb x11vnc websockify; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    err "missing: ${missing[*]}  →  run: bash scripts/desktop.sh install"
    exit 1
  fi

  # ── Xvfb ──────────────────────────────────────────────────────────────────
  if [ -e "/tmp/.X${DNUM}-lock" ]; then
    log "display ${DISPLAY_NUM} already up"
  else
    log "starting Xvfb on ${DISPLAY_NUM} (${SCREEN_W}x${SCREEN_H}x24)"
    Xvfb "$DISPLAY_NUM" -screen 0 "${SCREEN_W}x${SCREEN_H}x24" -nolisten tcp -ac \
      >"$RUN_DIR/xvfb.log" 2>&1 &
    echo $! > "$RUN_DIR/xvfb.pid"
    for _ in $(seq 1 40); do [ -e "/tmp/.X${DNUM}-lock" ] && break; sleep 0.2; done
    [ -e "/tmp/.X${DNUM}-lock" ] || { err "Xvfb failed; see $RUN_DIR/xvfb.log"; exit 1; }
  fi

  # ── x11vnc ────────────────────────────────────────────────────────────────
  if port_open "$VNC_PORT"; then
    log "VNC already listening on ${VNC_PORT}"
  else
    local auth_args=(-nopw)
    if [ -n "$VNC_PASSWORD" ]; then
      x11vnc -storepasswd "$VNC_PASSWORD" "$RUN_DIR/vncpass" >/dev/null 2>&1
      chmod 600 "$RUN_DIR/vncpass"
      auth_args=(-rfbauth "$RUN_DIR/vncpass")
    else
      err "WARNING: no DESKTOP_VNC_PASSWORD set — the screen has no password."
    fi
    log "starting x11vnc on ${VNC_PORT} (localhost only)"
    x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -localhost \
      -forever -shared -noxdamage -quiet "${auth_args[@]}" \
      >"$RUN_DIR/x11vnc.log" 2>&1 &
    echo $! > "$RUN_DIR/x11vnc.pid"
    for _ in $(seq 1 40); do port_open "$VNC_PORT" && break; sleep 0.2; done
    port_open "$VNC_PORT" || { err "x11vnc failed; see $RUN_DIR/x11vnc.log"; exit 1; }
  fi

  # ── noVNC ─────────────────────────────────────────────────────────────────
  if port_open "$NOVNC_PORT"; then
    log "noVNC already listening on ${NOVNC_PORT}"
  else
    local web
    if ! web="$(novnc_root)"; then
      err "noVNC static files not found. Install the 'novnc' package, or set DESKTOP_NOVNC_WEB_ROOT."
      exit 1
    fi
    log "starting websockify on ${NOVNC_PORT} (web root: $web)"
    websockify --web "$web" "$NOVNC_PORT" "127.0.0.1:${VNC_PORT}" \
      >"$RUN_DIR/novnc.log" 2>&1 &
    echo $! > "$RUN_DIR/novnc.pid"
    for _ in $(seq 1 50); do port_open "$NOVNC_PORT" && break; sleep 0.2; done
    port_open "$NOVNC_PORT" || { err "websockify failed; see $RUN_DIR/novnc.log"; exit 1; }
  fi

  echo
  log "ready →  http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"
  log "export DISPLAY=${DISPLAY_NUM} before launching Chrome, or set REAL_CHROME_DISPLAY."
}

cmd_stop() {
  for name in novnc x11vnc xvfb; do
    if [ -f "$RUN_DIR/$name.pid" ]; then
      pid="$(cat "$RUN_DIR/$name.pid")"
      if kill -0 "$pid" 2>/dev/null; then
        log "stopping $name (pid $pid)"
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$RUN_DIR/$name.pid"
    fi
  done
  rm -f "$RUN_DIR/vncpass"
  log "stopped."
}

cmd_status() {
  printf 'display  %-10s %s\n' "$DISPLAY_NUM" \
    "$([ -e "/tmp/.X${DNUM}-lock" ] && echo up || echo down)"
  printf 'vnc      %-10s %s\n' "$VNC_PORT"   "$(port_open "$VNC_PORT"   && echo up || echo down)"
  printf 'novnc    %-10s %s\n' "$NOVNC_PORT" "$(port_open "$NOVNC_PORT" && echo up || echo down)"
}

case "${1:-start}" in
  install) cmd_install ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  *) err "usage: $0 {install|start|stop|restart|status}"; exit 1 ;;
esac
