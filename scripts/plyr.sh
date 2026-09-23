#!/usr/bin/env bash
# Canonical Plyr runtime manager.
# Owns install/bootstrap, native/docker lifecycle, readiness, status and doctor.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_COMPOSE_FILE="$ROOT_DIR/docker-compose.dev.yml"
DEV_PROJECT=plyr-dev
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
    if [[ -z "${AB_NO_PROMPT:-}" ]]; then
      ask_public_domain || true
    else
      info "AB_NO_PROMPT is set; install will not ask for a public domain."
    fi
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
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" shutdown save >/dev/null 2>&1 || true
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

# Explicitly disposable, separate from the persistent install/start --docker path.
# Docker installation is ONLY attempted on supported Debian/Ubuntu hosts with
# administrative access, and never removes or upgrades an existing installation.
install_dev_docker_engine() {
  [[ -r /etc/os-release ]] || { error "Cannot identify OS; install Docker Engine manually"; return 1; }
  local ID='' VERSION_CODENAME=''
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "$ID" == ubuntu || "$ID" == debian ]] || {
    error "Automatic Docker setup supports only Ubuntu/Debian; see https://docs.docker.com/engine/install/"; return 1;
  }
  [[ -n "$VERSION_CODENAME" ]] || { error "Missing OS version codename"; return 1; }
  case "$ID:$VERSION_CODENAME" in
    ubuntu:jammy|ubuntu:noble|ubuntu:resolute|debian:bookworm|debian:trixie) ;;
    *) error "Unsupported Docker repository release $ID:$VERSION_CODENAME; see https://docs.docker.com/engine/install/$ID/"; return 1 ;;
  esac
  have apt-get && have dpkg || { error "apt-get/dpkg are required for automatic setup"; return 1; }
  local admin=()
  if [[ "$(id -u)" != 0 ]]; then
    have sudo || { error "sudo is required to install Docker"; return 1; }
    admin=(sudo)
  fi
  # Do not uninstall or replace a running distro/third-party Docker installation.
  for pkg in docker.io docker-compose podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
      error "Conflicting package $pkg is installed. Refusing to replace it automatically; see https://docs.docker.com/engine/install/$ID/"
      return 1
    fi
  done
  say "installing Docker Engine and Compose from Docker's official apt repository (administrator privileges required)"
  "${admin[@]}" apt-get update
  "${admin[@]}" apt-get install -y ca-certificates curl
  "${admin[@]}" install -m 0755 -d /etc/apt/keyrings
  local key_file; key_file="$(mktemp)"
  if ! curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$key_file"; then
    rm -f "$key_file"; error "Could not download the official Docker signing key"; return 1
  fi
  "${admin[@]}" install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
  rm -f "$key_file"
  "${admin[@]}" chmod a+r /etc/apt/keyrings/docker.asc
  local arch; arch="$(dpkg --print-architecture)"
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$ID" "$VERSION_CODENAME" "$arch" \
    | "${admin[@]}" tee /etc/apt/sources.list.d/docker.sources >/dev/null
  "${admin[@]}" apt-get update
  "${admin[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

# ---------- dev-docker image source ----------
# CI (.github/workflows/docker-package.yml) publishes one image per pushed commit
# to GHCR, tagged with the full commit SHA. Pulling that image is much faster
# than building the Playwright/Chromium image locally, and it is exactly the
# image CI built. The SHA tag is immutable, so a pulled image can never be
# "the previous version" by accident.

# ghcr.io/<owner>/<repo> derived from origin (GHCR names must be lowercase).
dev_docker_registry_image() {
  if [[ -n "${PLYR_DEV_IMAGE_REPO:-}" ]]; then printf '%s' "$PLYR_DEV_IMAGE_REPO"; return 0; fi
  local url slug
  url="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
  slug="$(sed -E 's#^(https?://[^/]*github\.com/|git@github\.com:|ssh://git@github\.com/)##; s#\.git$##' <<<"$url")"
  [[ "$slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  printf 'ghcr.io/%s' "$(tr '[:upper:]' '[:lower:]' <<<"$slug")"
}

# Resolve --ref (branch, tag, SHA or pr-N) to a full commit SHA on origin.
dev_docker_resolve_ref() {
  local ref="$1" sha=''
  if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$ref"; return 0; fi
  if [[ "$ref" =~ ^pr-([0-9]+)$ ]]; then
    sha="$(git -C "$ROOT_DIR" ls-remote origin "refs/pull/${BASH_REMATCH[1]}/head" 2>/dev/null | awk 'NR==1{print $1}')"
  else
    sha="$(git -C "$ROOT_DIR" ls-remote origin "refs/heads/$ref" "refs/tags/$ref" 2>/dev/null | awk 'NR==1{print $1}')"
    [[ -n "$sha" ]] || sha="$(git -C "$ROOT_DIR" rev-parse --verify --quiet "$ref^{commit}" 2>/dev/null || true)"
  fi
  [[ -n "$sha" ]] || return 1
  printf '%s' "$sha"
}

# Returns 0 after tagging the published image as plyr-dev:local; 1 = use a local build.
dev_docker_pull_prebuilt() {
  local source="$1" ref="$2" repo sha arch
  repo="$(dev_docker_registry_image)" || { info "origin is not a GitHub repository; building locally"; return 1; }
  arch="$("${docker_cmd[@]}" version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  if [[ -n "$arch" && "$arch" != amd64 ]]; then
    info "published images are linux/amd64 only (this Docker is $arch); building locally"; return 1
  fi
  if [[ -n "$ref" ]]; then
    sha="$(dev_docker_resolve_ref "$ref")" || { error "Cannot resolve '$ref' on origin (branch, tag, SHA or pr-N)"; return 1; }
  else
    have git && git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1 || { info "no git checkout; building locally"; return 1; }
    if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
      info "working tree has uncommitted changes; building locally so the test uses them"; return 1
    fi
    sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  fi
  say "pulling the CI-built image for commit ${sha:0:7} ($repo:$sha)"
  local out
  if out="$("${docker_cmd[@]}" pull "$repo:$sha" 2>&1)"; then
    "${docker_cmd[@]}" tag "$repo:$sha" plyr-dev:local || return 1
    return 0
  fi
  if grep -qiE 'unauthorized|denied' <<<"$out"; then
    warn "registry refused the pull. Make the GHCR package public once (GitHub > Packages > Package settings > Change visibility) or run: docker login ghcr.io"
  else
    warn "no published image for ${sha:0:7} yet (not pushed, or CI still building)"
  fi
  [[ "$source" == prebuilt ]] && { error "Prebuilt image unavailable: $repo:$sha"; return 1; }
  info "falling back to a local build"
  return 1
}

dev_docker_build_local() {
  local fresh="$1"
  if [[ "$fresh" == 1 ]]; then
    say "building development image from the current checkout (fresh: --no-cache --pull)"
    "${dc[@]}" build --no-cache --pull app || { error "Image build failed; previous stack was not removed"; return 1; }
  else
    # Docker's layer cache is keyed on file content: any change to src/, package-lock.json,
    # Dockerfile, etc. rebuilds from that step, so cached builds still test the current code.
    say "building development image from the current checkout (layer cache enabled)"
    "${dc[@]}" build app || { error "Image build failed; previous stack was not removed"; return 1; }
  fi
}

dev_docker() {
  local source=auto ref='' fresh=0
  while (( $# )); do
    case "$1" in
      --build) source=build ;;
      --fresh) source=build; fresh=1 ;;
      --prebuilt) source=prebuilt ;;
      --ref) [[ $# -ge 2 ]] || fail "--ref needs a branch, tag, SHA or pr-N"; ref="$2"; source=prebuilt; shift ;;
      --ref=*) ref="${1#--ref=}"; source=prebuilt ;;
      *) fail "unknown dev-docker option: $1 (use --build, --fresh, --prebuilt or --ref <branch|sha|pr-N>)" ;;
    esac
    shift
  done
  [[ -f "$DEV_COMPOSE_FILE" ]] || fail "Missing docker-compose.dev.yml"
  have docker || install_dev_docker_engine || return 1
  local docker_cmd=(docker)
  if ! docker info >/dev/null 2>&1; then
    if have systemctl && [[ "$(id -u)" == 0 || -S /run/systemd/private ]]; then
      if [[ "$(id -u)" == 0 ]]; then systemctl start docker || true
      elif have sudo; then sudo systemctl start docker || true; fi
    fi
    if ! docker info >/dev/null 2>&1; then
      if [[ "$(id -u)" != 0 ]] && have sudo && sudo docker info >/dev/null 2>&1; then
        docker_cmd=(sudo docker)
      else
        error "Docker daemon is unavailable; start Docker or grant daemon access."
        return 1
      fi
    fi
  fi
  if ! "${docker_cmd[@]}" compose version >/dev/null 2>&1; then
    error "Docker Compose plugin is missing: https://docs.docker.com/compose/install/linux/"
    return 1
  fi
  local dc=("${docker_cmd[@]}" compose --project-name "$DEV_PROJECT" --file "$DEV_COMPOSE_FILE")
  "${dc[@]}" config --quiet || { error "Invalid development Compose configuration"; return 1; }

  # Obtain the image first: a failed pull/build must leave the previous working
  # stack intact. Either path ends with the image tagged as plyr-dev:local.
  if [[ "$source" != build ]] && dev_docker_pull_prebuilt "$source" "$ref"; then
    :
  elif [[ "$source" == prebuilt ]]; then
    return 1
  else
    dev_docker_build_local "$fresh" || return 1
  fi
  say "removing the previous dev stack and its disposable data volumes"
  "${dc[@]}" down --volumes --remove-orphans || return 1
  say "starting fresh app and Redis containers"
  "${dc[@]}" up -d --no-build --force-recreate --wait --wait-timeout 180 || {
    error "Development stack did not become healthy; inspect with: docker compose -p plyr-dev -f docker-compose.dev.yml logs"
    return 1
  }
  # /health is a cheap liveness check; /health/browser verifies the browser
  # prerequisites separately (and Redis connectivity is reported by /health).
  if ! "${dc[@]}" exec -T app node -e "const h=require('http'); h.get('http://127.0.0.1:3000/health',r=>{let s='';r.on('data',x=>s+=x);r.on('end',()=>{try{process.exit(r.statusCode===200&&JSON.parse(s).redis==='connected'?0:1)}catch{process.exit(1)}})}).on('error',()=>process.exit(1))"; then
    error "Application is up but Redis is not ready; inspect dev Compose logs"; return 1
  fi
  if ! "${dc[@]}" exec -T app node -e "require('http').get('http://127.0.0.1:3000/health/browser',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then
    error "Browser runtime is not ready; inspect dev Compose logs"; return 1
  fi
  ready "Development Docker stack: http://localhost:3000 (API_TOKEN=admin123; loopback only)"
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
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" shutdown save >/dev/null 2>&1 || true
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
  ./plyr dev-docker     # disposable, loopback-only test stack (pulls CI image when available)
  ./plyr dev-docker --ref pr-47   # test a pushed branch/PR/SHA without checking it out

Commands:
  dev-docker [--build|--fresh|--prebuilt|--ref <branch|sha|pr-N>]
                          Get image (CI-built for clean HEAD, else cached local build),
                          replace dev stack, wait for health. --fresh = --no-cache --pull.
  install                 Bootstrap .env, dependencies, browsers and build
  start [--dev|--build|--native|--docker]
  stop [--native|--docker]
  restart [--native|--docker]
  status [--native|--docker]
  doctor [--deep]
  logs

Policy: auto uses Docker only when Docker and Compose are usable; otherwise native.
Normal lifecycle commands preserve Redis, workflows and browser profiles.
Only dev-docker replaces its isolated development stack and discards its data.
EOF
}

main() {
  local command="${1:-help}"; shift || true
  case "$command" in
    dev-docker) dev_docker "$@" ;;
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
