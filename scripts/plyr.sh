#!/usr/bin/env bash
# Canonical Plyr runtime manager.
# Owns install/bootstrap, native/docker lifecycle, readiness, status and doctor.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${PLYR_STATE_DIR:-$ROOT_DIR/.plyr/runtime}"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="${PLYR_ENV_FILE:-$ROOT_DIR/.env}"
mkdir -p "$STATE_DIR" "$LOG_DIR"

info() { printf '[plyr] INFO: %s\n' "$*"; }
say() { info "$@"; }
warn() { printf '[plyr] WARN: %s\n' "$*" >&2; }
error() { printf '[plyr] ERROR: %s\n' "$*" >&2; }
failed() { error "$*"; exit 1; }
fail() { failed "$@"; }
ready() { printf '[plyr] READY: %s\n' "$*"; }
not_ready() { printf '[plyr] NOT READY: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

STARTED_APP_PID=''
REDIS_STARTED_THIS_RUN=0
DESKTOP_STARTED_THIS_RUN=0

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    # .env is operator input; only source shell-compatible assignment lines.
    set -a
    # shellcheck disable=SC1090
    source <(sed 's/\r$//' "$ENV_FILE" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' || true)
    set +a
  fi
  PORT="${PORT:-3000}"
  REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
  REDIS_HOST="${REDIS_URL#*://}"; REDIS_HOST="${REDIS_HOST%%:*}"; REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
  REDIS_PORT="${REDIS_URL##*:}"; REDIS_PORT="${REDIS_PORT%%/*}"; REDIS_PORT="${REDIS_PORT:-6379}"
  REAL_CHROME_HEADLESS="${REAL_CHROME_HEADLESS:-false}"
  REAL_CHROME_DISPLAY="${REAL_CHROME_DISPLAY:-:99}"
  DESKTOP_NOVNC_PORT="${DESKTOP_NOVNC_PORT:-6080}"
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ROOT_DIR/.env.example" ]] || fail ".env.example is missing"
    cp "$ROOT_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    say "created $ENV_FILE from .env.example (existing state was preserved)"
  fi
}

pid_file() { printf '%s/%s.pid' "$STATE_DIR" "$1"; }
pid_alive() { [[ -s "$(pid_file "$1")" ]] && kill -0 "$(cat "$(pid_file "$1")")" 2>/dev/null; }
write_pid() { printf '%s\n' "$2" > "$(pid_file "$1")"; }
clear_pid() { rm -f "$(pid_file "$1")"; }

port_open() {
  local host="$1" port="$2"
  if have nc; then nc -z -w 1 "$host" "$port" >/dev/null 2>&1; return; fi
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 && { exec 3<&-; return 0; }
  return 1
}

novnc_root() {
  local dir
  for dir in "${DESKTOP_NOVNC_WEB_ROOT:-}" /usr/share/novnc /usr/share/webapps/novnc /usr/local/share/novnc /opt/novnc; do
    [[ -n "$dir" && -d "$dir" ]] && { printf '%s' "$dir"; return 0; }
  done
  return 1
}

redis_ready() {
  if have redis-cli; then redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null | grep -qx PONG; return; fi
  port_open "$REDIS_HOST" "$REDIS_PORT"
}

http_ready() {
  have curl || return 1
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

browser_http_ready() {
  have curl || return 1
  curl -fsS --max-time 8 "http://127.0.0.1:${PORT}/health/browser" >/dev/null 2>&1
}

docker_storage_ready() {
  (cd "$ROOT_DIR" && docker compose exec -T app node -e "const fs=require('fs'); const p=process.env.WORKFLOW_STORAGE_ROOT || '/app/workflow-files'; fs.mkdirSync(p,{recursive:true}); fs.accessSync(p,fs.constants.W_OK)") >/dev/null 2>&1
}

storage_ready() {
  local root="${WORKFLOW_STORAGE_ROOT:-$ROOT_DIR/workflow-files}"
  [[ "$root" = /* ]] || root="$ROOT_DIR/$root"
  mkdir -p "$root" 2>/dev/null && [[ -w "$root" ]]
}

read_active_mode() {
  [[ -s "$STATE_DIR/mode" ]] || return 1
  local mode; mode="$(tr -d '[:space:]' < "$STATE_DIR/mode")"
  case "$mode" in native|dev|build|docker) printf '%s' "$mode" ;; *) return 1 ;; esac
}

managed_docker_active() {
  docker_available || return 1
  (cd "$ROOT_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx app)
}

active_mode() {
  local mode=''
  mode="$(read_active_mode 2>/dev/null || true)"
  case "$mode" in
    docker) managed_docker_active && printf docker && return 0 ;;
    native|dev|build) pid_alive app && printf '%s' "$mode" && return 0 ;;
  esac
  return 1
}

browser_ready() {
  [[ -d "$ROOT_DIR/node_modules/playwright" ]] || return 1
  local display_env=()
  [[ "$REAL_CHROME_HEADLESS" == true ]] || display_env=(DISPLAY="$REAL_CHROME_DISPLAY")
  (cd "$ROOT_DIR" && env "${display_env[@]}" PLYR_BROWSER_HEADLESS="$REAL_CHROME_HEADLESS" node <<'NODE'
const { chromium } = require('playwright');
(async () => {
  const headless = process.env.PLYR_BROWSER_HEADLESS === 'true';
  const browser = await chromium.launch({ headless });
  await browser.close();
})().catch(() => process.exit(1));
NODE
  ) >/dev/null 2>&1
}

docker_available() {
  have docker && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && (cd "$ROOT_DIR" && docker compose config -q >/dev/null 2>&1)
}

select_mode() {
  local requested="${1:-auto}" active=''
  case "$requested" in
    native|dev|build) printf '%s' "$requested"; return ;;
    docker) docker_available || fail "Docker/Compose is not available"; printf docker; return ;;
    auto|'')
      active="$(active_mode 2>/dev/null || true)"
      [[ -n "$active" ]] && { printf '%s' "$active"; return; }
      docker_available && printf docker || printf native
      return ;;
    *) fail "unknown mode: $requested" ;;
  esac
}

native_dependencies() {
  local missing=()
  for bin in node npm redis-server; do have "$bin" || missing+=("$bin"); done
  if [[ "${REAL_CHROME_HEADLESS:-false}" != true ]]; then
    for bin in Xvfb x11vnc websockify openbox; do have "$bin" || missing+=("$bin"); done
    novnc_root >/dev/null 2>&1 || missing+=(novnc-static-files)
  fi
  [[ -d "$ROOT_DIR/node_modules/playwright" ]] || missing+=(node_modules/playwright)
  local browser_path=''
  browser_path="$(cd "$ROOT_DIR" && node -e "process.stdout.write(require('playwright').chromium.executablePath())" 2>/dev/null || true)"
  [[ -n "$browser_path" && -x "$browser_path" ]] || missing+=(playwright-chromium)
  printf '%s\n' "${missing[@]}"
  [[ ${#missing[@]} -eq 0 ]]
}

verify_native_dependencies() {
  local missing; missing="$(native_dependencies || true)"
  [[ -z "$missing" ]] && return 0
  error "Native runtime dependencies are unavailable: ${missing//$'\n'/, }"
  error "Required components must be installed before Native can be READY."
  return 1
}

system_install() {
  local packages=(redis-server)
  if [[ "${REAL_CHROME_HEADLESS:-false}" != true ]]; then packages+=(xvfb x11vnc openbox novnc websockify); fi
  local missing; missing="$(native_dependencies | grep -E '^(redis-server|Xvfb|x11vnc|openbox|websockify|novnc-static-files)$' || true)"
  [[ -z "$missing" ]] && return 0
  if have apt-get && ( [[ "$(id -u)" == 0 ]] || (have sudo && sudo -n true >/dev/null 2>&1) ); then
    local runner=(); [[ "$(id -u)" == 0 ]] || runner=(sudo)
    info "installing missing native packages: ${packages[*]}"
    "${runner[@]}" apt-get update
    "${runner[@]}" apt-get install -y "${packages[@]}"
  elif have dnf && ( [[ "$(id -u)" == 0 ]] || (have sudo && sudo -n true >/dev/null 2>&1) ); then
    local runner=(); [[ "$(id -u)" == 0 ]] || runner=(sudo)
    "${runner[@]}" dnf install -y xorg-x11-server-Xvfb x11vnc openbox novnc python3-websockify redis
  else
    error "Cannot install required native components (${missing//$'\n'/, }): no usable package manager or non-interactive privileges."
    return 1
  fi
  # Browser/package verification happens after Playwright installation below.
  return 0
}

install_native() {
  ensure_env; load_env
  if [[ -f "$ROOT_DIR/scripts/ask-domain.sh" ]]; then
    # shellcheck disable=SC1090
    source "$ROOT_DIR/scripts/ask-domain.sh"
    ask_public_domain || true
  fi
  say "[1/5] checking Node and npm"
  have node || fail "Node.js >=20 is required"
  [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] || fail "Node.js >=20 is required (found $(node --version))"
  have npm || fail "npm is required"
  say "[2/5] verifying JavaScript dependencies"
  if [[ ! -d "$ROOT_DIR/node_modules" ]] || ! (cd "$ROOT_DIR" && npm ls --depth=0 --omit=optional >/dev/null 2>&1); then
    info "installing the lockfile-defined JavaScript dependency tree"
    (cd "$ROOT_DIR" && npm ci) || failed "npm ci failed; the JavaScript dependency tree is not usable"
  else
    info "JavaScript dependencies already match package-lock.json"
  fi
  (cd "$ROOT_DIR" && npm ls --depth=0 --omit=optional >/dev/null 2>&1) || failed "npm dependency verification failed after installation"
  say "[3/5] installing/verifying native runtime dependencies"
  system_install
  say "[4/5] installing/verifying Playwright Chromium"
  local browser_path; browser_path="$(cd "$ROOT_DIR" && node -e "process.stdout.write(require('playwright').chromium.executablePath())")"
  if [[ ! -x "$browser_path" ]]; then
    if [[ "$(id -u)" == 0 ]] || { have sudo && sudo -n true >/dev/null 2>&1; }; then
      local runner=(); [[ "$(id -u)" == 0 ]] || runner=(sudo)
      (cd "$ROOT_DIR" && npx playwright install --with-deps chromium) || failed "Playwright Chromium/system dependency installation failed"
    else
      (cd "$ROOT_DIR" && npx playwright install chromium) || failed "Playwright Chromium installation failed"
    fi
  fi
  verify_native_dependencies
  say "[5/5] building application and extension"
  (cd "$ROOT_DIR" && npm run build) || failed "application build failed"
  ready "install completed and all required Native dependencies verified"
}

start_redis() {
  redis_ready && { say "Redis already ready"; return 0; }
  if have systemctl && systemctl is-active --quiet redis-server 2>/dev/null; then return 0; fi
  if have service && service redis-server status >/dev/null 2>&1; then return 0; fi
  have redis-server || { warn "Redis is unavailable; install it with ./plyr install"; return 1; }
  say "starting manager-owned Redis"
  redis-server --bind "$REDIS_HOST" --port "$REDIS_PORT" --daemonize yes --dir "$ROOT_DIR" \
    >>"$LOG_DIR/redis.log" 2>&1 || { error "Redis failed to start; see $LOG_DIR/redis.log"; return 1; }
  for _ in {1..20}; do
    if redis_ready; then touch "$STATE_DIR/redis-owned"; REDIS_STARTED_THIS_RUN=1; return 0; fi
    sleep .25
  done
  return 1
}

start_desktop() {
  [[ "$REAL_CHROME_HEADLESS" == "true" ]] && { say "headless mode: display stack not required"; return 0; }
  [[ -x "$ROOT_DIR/scripts/desktop.sh" ]] || return 1
  if [[ -e "/tmp/.X${REAL_CHROME_DISPLAY#:}-lock" ]] && port_open 127.0.0.1 "$DESKTOP_NOVNC_PORT"; then
    say "display/viewer stack already running"; return 0
  fi
  say "starting display/viewer stack"
  local had_stack=0
  if [[ -e "/tmp/.X${REAL_CHROME_DISPLAY#:}-lock" ]] || port_open 127.0.0.1 "$DESKTOP_NOVNC_PORT"; then had_stack=1; fi
  (cd "$ROOT_DIR" && bash scripts/desktop.sh start) >>"$LOG_DIR/desktop.log" 2>&1 || {
    # desktop.sh may have started only part of the stack before failing. Clean
    # that partial attempt only when no pre-existing display/viewer was found.
    (( had_stack == 0 )) && (cd "$ROOT_DIR" && bash scripts/desktop.sh stop) >>"$LOG_DIR/desktop.log" 2>&1 || true
    warn "display/viewer stack is not ready; see $LOG_DIR/desktop.log"; return 1;
  }
  touch "$STATE_DIR/desktop-owned"
  DESKTOP_STARTED_THIS_RUN=1
}

cleanup_startup() {
  [[ -n "$STARTED_APP_PID" ]] && kill "$STARTED_APP_PID" 2>/dev/null || true
  clear_pid app
  if (( REDIS_STARTED_THIS_RUN == 1 )) && have redis-cli; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    rm -f "$STATE_DIR/redis-owned"
  fi
  if (( DESKTOP_STARTED_THIS_RUN == 1 )) && [[ -x "$ROOT_DIR/scripts/desktop.sh" ]]; then
    (cd "$ROOT_DIR" && bash scripts/desktop.sh stop) >>"$LOG_DIR/desktop.log" 2>&1 || true
    rm -f "$STATE_DIR/desktop-owned"
  fi
}

start_app() {
  if pid_alive app; then say "application already running (owned pid $(cat "$(pid_file app)"))"; return 0; fi
  if http_ready; then
    error "Cannot start the application: port $PORT is already serving an unowned process. Refusing to claim or stop it."
    return 1
  fi
  local mode="$1"; local logfile="$LOG_DIR/app.log"
  if [[ "$mode" == dev ]]; then
    say "starting application in development mode"
    (cd "$ROOT_DIR" && exec npx tsx watch src/index.ts) >>"$logfile" 2>&1 &
  else
    [[ -f "$ROOT_DIR/dist/index.js" ]] || (cd "$ROOT_DIR" && npm run build)
    say "starting application in build/production-like mode"
    (cd "$ROOT_DIR" && exec node dist/index.js) >>"$logfile" 2>&1 &
  fi
  STARTED_APP_PID="$!"
  write_pid app "$STARTED_APP_PID"
}

wait_ready() {
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    redis_ready && http_ready && storage_ready && return 0
    sleep 1
  done
  return 1
}

start_native() {
  ensure_env; load_env
  STARTED_APP_PID=''; REDIS_STARTED_THIS_RUN=0; DESKTOP_STARTED_THIS_RUN=0
  start_redis || { error "Runtime failed to start. Component: Redis. See $LOG_DIR/redis.log"; cleanup_startup; return 1; }
  if [[ "$REAL_CHROME_HEADLESS" != true ]]; then
    start_desktop || { error "Runtime failed to start. Component: display/viewer stack. See $LOG_DIR/desktop.log"; cleanup_startup; return 1; }
  fi
  start_app "$1" || { cleanup_startup; return 1; }
  if ! wait_ready; then
    error "Runtime failed to become ready. Component: application/Redis/storage. See $LOG_DIR/app.log"
    cleanup_startup; return 1
  fi
  if [[ "$REAL_CHROME_HEADLESS" != true ]] && ! port_open 127.0.0.1 "$DESKTOP_NOVNC_PORT"; then
    error "Runtime failed to become ready. Component: noVNC viewer on port $DESKTOP_NOVNC_PORT"
    cleanup_startup; return 1
  fi
  if ! browser_ready; then
    error "Runtime failed to become ready. Component: Playwright/Chromium launch check"
    cleanup_startup; return 1
  fi
  if ! browser_http_ready; then
    error "Runtime failed to become ready. Component: application browser readiness endpoint"
    cleanup_startup; return 1
  fi
  printf 'native\n' > "$STATE_DIR/mode"
  ready "Native runtime is functionally usable"
}

start_docker() {
  ensure_env; load_env
  docker_available || { error "Runtime failed to start. Component: Docker/Compose is unavailable."; return 1; }
  say "starting Docker stack"
  (cd "$ROOT_DIR" && docker compose up -d --build) || { error "Runtime failed to start. Component: Docker Compose."; return 1; }
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local services; services="$(cd "$ROOT_DIR" && docker compose ps --status running --services 2>/dev/null || true)"
    if grep -qx app <<<"$services" && grep -qx redis <<<"$services" && http_ready && browser_http_ready && docker_storage_ready; then
      printf 'docker\n' > "$STATE_DIR/mode"
      ready "Docker runtime is functionally usable"; return 0
    fi
    sleep 1
  done
  error "Docker runtime is running but NOT READY. Expected app/redis services, writable Workflow Storage, and /health/browser; run ./plyr doctor."
  (cd "$ROOT_DIR" && docker compose stop) >/dev/null 2>&1 || true
  return 1
}

stop_native() {
  if pid_alive app; then
    local pid; pid="$(cat "$(pid_file app)")"
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep .1; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  clear_pid app
  # Only stop Redis/display processes explicitly owned by this manager.
  if [[ -f "$STATE_DIR/redis-owned" ]] && have redis-cli; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    rm -f "$STATE_DIR/redis-owned"
  fi
  if [[ -x "$ROOT_DIR/scripts/desktop.sh" && -f "$STATE_DIR/desktop-owned" ]]; then
    (cd "$ROOT_DIR" && bash scripts/desktop.sh stop) >>"$LOG_DIR/desktop.log" 2>&1 || true
    rm -f "$STATE_DIR/desktop-owned"
  fi
  rm -f "$STATE_DIR/mode"
  say "native runtime stopped; user data was preserved"
}

stop_runtime() {
  local requested="${1:-auto}" mode=''
  load_env
  if [[ "$requested" == auto ]]; then
    mode="$(active_mode 2>/dev/null || true)"
    [[ -n "$mode" ]] || mode="$(read_active_mode 2>/dev/null || true)"
    [[ -n "$mode" ]] || { say "no managed runtime is active"; return 0; }
  else
    mode="${requested#--}"
  fi
  case "$mode" in
    docker) docker_available || fail "Cannot stop Docker mode: Docker/Compose is unavailable"; (cd "$ROOT_DIR" && docker compose stop); rm -f "$STATE_DIR/mode" ;;
    native|dev|build) stop_native ;;
    *) fail "unknown active mode: $mode" ;;
  esac
}

status_native() {
  load_env
  local app_state=down redis_state=down display_state=down viewer_state=down http_state=down browser_state=down storage_state=down
  pid_alive app && app_state=running; redis_ready && redis_state=ready; http_ready && http_state=ready; storage_ready && storage_state=ready
  [[ "$REAL_CHROME_HEADLESS" == true || -e "/tmp/.X${REAL_CHROME_DISPLAY#:}-lock" ]] && display_state=ready
  if [[ "$REAL_CHROME_HEADLESS" == true ]] || port_open 127.0.0.1 "$DESKTOP_NOVNC_PORT"; then viewer_state=ready; fi
  browser_ready && browser_state=ready
  printf 'Plyr Runtime (native)\nApplication       %s\nRedis             %s\nStorage           %s\nDisplay           %s\nViewer            %s\nChrome/Playwright  %s\nHTTP              %s\n' "$app_state" "$redis_state" "$storage_state" "$display_state" "$viewer_state" "$browser_state" "$http_state"
  if [[ "$app_state" == running && "$redis_state" == ready && "$storage_state" == ready && "$http_state" == ready && "$display_state" == ready && "$viewer_state" == ready && "$browser_state" == ready ]]; then
    ready "Native runtime is usable"; return 0
  fi
  not_ready "Native runtime is incomplete"; return 1
}

status_docker() {
  load_env
  docker_available || { not_ready "Docker/Compose is unavailable"; return 1; }
  (cd "$ROOT_DIR" && docker compose ps)
  local services; services="$(cd "$ROOT_DIR" && docker compose ps --status running --services 2>/dev/null || true)"
  if grep -qx app <<<"$services" && grep -qx redis <<<"$services" && http_ready && browser_http_ready && docker_storage_ready; then
    ready "Docker runtime is usable"; return 0
  fi
  not_ready "Docker requires running app/redis services and /health/browser"; return 1
}

doctor() {
  local deep=false; [[ "${1:-}" == --deep ]] && deep=true
  load_env
  local failed_checks=0
  printf 'Plyr Runtime Doctor\n\n'
  if have node && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]]; then printf '[PASS] Node: available (>=20)\n'; else printf '[FAIL] Node: expected Node.js >=20; install/upgrade Node.js\n'; failed_checks=$((failed_checks+1)); fi
  if have npm; then printf '[PASS] npm: available\n'; else printf '[FAIL] npm: expected npm alongside Node.js; install Node.js/npm\n'; failed_checks=$((failed_checks+1)); fi
  if redis_ready; then printf '[PASS] Redis: reachable at %s:%s\n' "$REDIS_HOST" "$REDIS_PORT"; else printf '[FAIL] Redis: expected reachable at %s:%s; actual connection refused; start/install redis-server\n' "$REDIS_HOST" "$REDIS_PORT"; failed_checks=$((failed_checks+1)); fi
  if [[ -d "$ROOT_DIR/node_modules" ]] && (cd "$ROOT_DIR" && npm ls --depth=0 --omit=optional >/dev/null 2>&1); then printf '[PASS] npm dependencies: match package-lock.json\n'; else printf '[FAIL] npm dependencies: expected complete lockfile tree; run npm ci\n'; failed_checks=$((failed_checks+1)); fi
  local native_missing; native_missing="$(native_dependencies || true)"
  if [[ -z "$native_missing" ]]; then printf '[PASS] Native dependencies: required executables/files are present\n'; else printf '[FAIL] Native dependencies: missing %s; run ./plyr install\n' "${native_missing//$'\n'/, }"; failed_checks=$((failed_checks+1)); fi
  if http_ready; then printf '[PASS] Application: /health responds\n'; else printf '[FAIL] Application: expected /health 200; actual unavailable; start the selected mode\n'; failed_checks=$((failed_checks+1)); fi
  if storage_ready; then printf '[PASS] Workflow Storage: writable\n'; else printf '[FAIL] Workflow Storage: expected writable WORKFLOW_STORAGE_ROOT; check path/permissions\n'; failed_checks=$((failed_checks+1)); fi
  if [[ "$REAL_CHROME_HEADLESS" == true ]]; then printf '[PASS] Display: headless mode selected\n'; else [[ -e "/tmp/.X${REAL_CHROME_DISPLAY#:}-lock" ]] && printf '[PASS] Display: %s available\n' "$REAL_CHROME_DISPLAY" || { printf '[FAIL] Display: expected %s; actual display lock missing; start desktop stack\n' "$REAL_CHROME_DISPLAY"; failed_checks=$((failed_checks+1)); }; fi
  if [[ "$REAL_CHROME_HEADLESS" == true ]] || port_open 127.0.0.1 "$DESKTOP_NOVNC_PORT"; then printf '[PASS] Viewer: available or not required\n'; else printf '[FAIL] Viewer: expected noVNC on port %s; start scripts/desktop.sh\n' "$DESKTOP_NOVNC_PORT"; failed_checks=$((failed_checks+1)); fi
  if browser_ready; then printf '[PASS] Playwright/Chromium: launch probe succeeded\n'; else printf '[FAIL] Playwright/Chromium: expected launchable browser; run npx playwright install chromium and inspect DISPLAY\n'; failed_checks=$((failed_checks+1)); fi
  if $deep; then
    (cd "$ROOT_DIR" && npx tsx src/cli/doctor.ts) || { printf '[WARN] Application deep doctor reported blocked capabilities\n'; failed_checks=$((failed_checks+1)); }
    browser_http_ready && printf '[PASS] Application browser readiness: /health/browser responds\n' || printf '[FAIL] Application browser readiness: /health/browser is unavailable\n'
  fi
  if (( failed_checks == 0 )); then ready "all selected runtime checks passed"; return 0; fi
  not_ready "Runtime: NOT READY — $failed_checks runtime check(s) failed; see the actionable lines above"; return 1
}

doctor_docker() {
  local failed_checks=0
  printf 'Plyr Runtime Doctor (docker)\n\n'
  if docker_available; then printf '[PASS] Docker/Compose: available\n'; else printf '[FAIL] Docker/Compose: expected usable Docker daemon and Compose plugin\n'; return 1; fi
  local services; services="$(cd "$ROOT_DIR" && docker compose ps --status running --services 2>/dev/null || true)"
  grep -qx redis <<<"$services" && printf '[PASS] Redis service: running\n' || { printf '[FAIL] Redis service: expected running Compose service\n'; failed_checks=$((failed_checks+1)); }
  grep -qx app <<<"$services" && printf '[PASS] Application service: running\n' || { printf '[FAIL] Application service: expected running Compose service\n'; failed_checks=$((failed_checks+1)); }
  http_ready && printf '[PASS] Application: /health responds\n' || { printf '[FAIL] Application: expected /health 200\n'; failed_checks=$((failed_checks+1)); }
  browser_http_ready && printf '[PASS] Browser readiness: /health/browser responds\n' || { printf '[FAIL] Browser readiness: expected /health/browser 200\n'; failed_checks=$((failed_checks+1)); }
  docker_storage_ready && printf '[PASS] Workflow Storage: writable in app container\n' || { printf '[FAIL] Workflow Storage: expected writable app storage path\n'; failed_checks=$((failed_checks+1)); }
  if (( failed_checks == 0 )); then ready "Docker runtime checks passed"; return 0; fi
  not_ready "$failed_checks Docker check(s) failed"; return 1
}

usage() {
  cat <<'EOF'
Usage: ./plyr <command> [options]

Examples:
  ./plyr install && ./plyr start
  ./plyr status
  ./plyr doctor --deep

Commands:
  install                 Bootstrap .env, dependencies, browsers and build
  start [--dev|--build|--native|--docker]
  stop [--native|--docker]
  restart [--native|--docker]
  status [--native|--docker]
  doctor [--deep]
  logs

Policy: auto uses Docker only when Docker and Compose are usable; otherwise native.
No command flushes Redis, deletes workflows, or removes browser profiles.
EOF
}

main() {
  local command="${1:-help}"; shift || true
  case "$command" in
    install) [[ "${1:-}" == "--docker" ]] && { ensure_env; load_env; docker_available || fail "Docker/Compose is not available"; (cd "$ROOT_DIR" && docker compose build); return; }; install_native ;;
    install-and-start-dev) install_native; start_native dev ;;
    start)
      local mode=auto active=''; for arg in "$@"; do case "$arg" in --dev) mode=dev;; --build) mode=build;; --native) mode=native;; --docker) mode=docker;; esac; done
      active="$(active_mode 2>/dev/null || true)"
      mode="$(select_mode "$mode")"
      if [[ -n "$active" && "$active" != "$mode" ]]; then stop_runtime "$active"; fi
      [[ "$mode" == docker ]] && start_docker || start_native "$mode"
      ;;
    stop) local stop_mode="${1:-auto}"; stop_mode="${stop_mode#--}"; stop_runtime "$stop_mode" ;;
    restart)
      local restart_mode="${1:---auto}" current=''
      current="$(active_mode 2>/dev/null || true)"
      if [[ -n "$current" ]]; then stop_runtime "$current"; else stop_runtime "${restart_mode#--}"; fi
      [[ "$restart_mode" == --auto ]] && main start || main start "$restart_mode"
      ;;
    status)
      local mode=''
      case "${1:-}" in
        --docker) mode=docker;; --native) mode=native;; --dev) mode=dev;; --build) mode=build;;
        *) mode="$(active_mode 2>/dev/null || true)"; [[ -n "$mode" ]] || mode="$(read_active_mode 2>/dev/null || true)";;
      esac
      [[ -n "$mode" ]] || { not_ready "no managed runtime is active"; return 1; }
      [[ "$mode" == docker ]] && status_docker || status_native
      ;;
    doctor)
      local doctor_mode; doctor_mode="$(active_mode 2>/dev/null || true)"
      [[ "$doctor_mode" == docker ]] && doctor_docker "${1:-}" || doctor "${1:-}"
      ;;
    logs) tail -n 200 -f "$LOG_DIR/app.log" ;;
    help|-h|--help) usage ;;
    *) usage; return 2 ;;
  esac
}

main "$@"
