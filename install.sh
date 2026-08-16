#!/usr/bin/env bash
# ============================================================================
# automation-backend — interactive installer
# ----------------------------------------------------------------------------
# One-liner (recommended):
#   curl -fsSL https://raw.githubusercontent.com/Saeedkhoshafsar/plyr/main/install.sh | bash
#
# Or clone first, then:
#   chmod +x install.sh && ./install.sh
#
# A guided, confirmation-driven wizard. Every step that changes the system
# asks for confirmation (default = Yes, just press Enter) and prints exactly
# what it is about to do. Targets:
#   1) Server (Node)     native Node + Redis + Playwright + PM2 (+ Caddy/HTTPS)
#   2) Server (Docker)   app + redis via docker compose
#   3) Server (Coolify)  guidance + files for an isolated Coolify deploy
#   4) Client (Chrome)   load the MV3 browser extension
#   5) Client (n8n)      build/install the n8n community node
#
# Non-interactive flags:
#   --server-node | --server-docker | --client | --client-n8n | --coolify
#   --domain <host>   (server-node) set the public domain for Caddy/HTTPS
#   --port <n>        (server-node) app port (default 3000)
#   -y, --yes         assume "yes" for every confirmation
#   -h, --help
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. curl | bash bootstrap
# ---------------------------------------------------------------------------
# When piped from curl, this script has no repository on disk and stdin is the
# pipe (so `read` can't reach the keyboard). We clone the repo into a temp dir
# and re-exec ourselves from there with stdin reconnected to the terminal.
# ---------------------------------------------------------------------------
REPO_URL_DEFAULT="https://github.com/Saeedkhoshafsar/plyr.git"
REPO_BRANCH_DEFAULT="main"

bootstrap_from_curl() {
  # True when there is no install.sh next to us (i.e. we were piped in).
  local self="${BASH_SOURCE[0]:-}"
  if [ -n "$self" ] && [ -f "$self" ] && [ "$self" != "bash" ] && [ "$self" != "/dev/stdin" ]; then
    return 1   # running from a real file → no bootstrap needed
  fi
  return 0
}

if bootstrap_from_curl; then
  echo ">> automation-backend installer (remote bootstrap)"
  if ! command -v git >/dev/null 2>&1; then
    echo "!! git is required for the one-liner install. Install git and retry." 1>&2
    echo "   e.g.  sudo apt-get install -y git" 1>&2
    exit 1
  fi
  TMP_DIR="$(mktemp -d)"
  echo ">> Cloning ${REPO_URL_DEFAULT} (branch ${REPO_BRANCH_DEFAULT}) ..."
  git clone --depth 1 --branch "$REPO_BRANCH_DEFAULT" "$REPO_URL_DEFAULT" "$TMP_DIR/plyr" >/dev/null 2>&1 \
    || { echo "!! git clone failed." 1>&2; exit 1; }
  chmod +x "$TMP_DIR/plyr/install.sh" 2>/dev/null || true
  echo ">> Launching interactive installer ..."
  # Re-exec from the cloned copy with the terminal reattached to stdin.
  if [ -e /dev/tty ]; then
    exec bash "$TMP_DIR/plyr/install.sh" "$@" </dev/tty
  else
    exec bash "$TMP_DIR/plyr/install.sh" "$@"
  fi
fi

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
  RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  BLUE="$(printf '\033[34m')"; CYAN="$(printf '\033[36m')"
else
  BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""
fi

info()  { printf "%s\n" "${CYAN}ℹ ${*}${RESET}"; }
ok()    { printf "%s\n" "${GREEN}✔ ${*}${RESET}"; }
warn()  { printf "%s\n" "${YELLOW}⚠ ${*}${RESET}"; }
err()   { printf "%s\n" "${RED}✗ ${*}${RESET}" 1>&2; }
title() { printf "\n%s\n%s\n" "${BOLD}${BLUE}== ${*} ==${RESET}" "${DIM}$(printf '%.0s-' {1..60})${RESET}"; }

# Resolve the directory this script lives in (project root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ASSUME_YES=0
MODE=""
OPT_DOMAIN=""
OPT_PORT=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
print_help() {
  cat <<EOF
${BOLD}automation-backend installer${RESET}

${BOLD}Targets${RESET}
  ${GREEN}server (node)${RESET}    Native Node + Redis + Playwright + PM2 (+ optional
                   Caddy reverse proxy with automatic HTTPS for your domain).
  ${GREEN}server (docker)${RESET}  Run the full stack (app + redis) with Docker Compose.
  ${GREEN}server (coolify)${RESET} Print guidance + ensure files for an isolated
                   Coolify deploy (Coolify handles domain + TLS itself).
  ${GREEN}client${RESET}           Chrome extension (load unpacked) and/or n8n node.

${BOLD}Options${RESET}
  --server-node        Non-interactive native Node server install
  --server-docker      Non-interactive Docker server install
  --coolify            Print Coolify deploy guidance
  --client             Non-interactive Chrome-extension helper
  --client-n8n         Non-interactive n8n node build/install
  --domain <host>      (server-node) public domain for Caddy/HTTPS
  --port <n>           (server-node) app port (default 3000)
  -y, --yes            Assume "yes" for all confirmations
  -h, --help           Show this help

With no flags, an interactive menu is shown.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server-docker) MODE="server-docker" ;;
    --server-node)   MODE="server-node" ;;
    --coolify)       MODE="coolify" ;;
    --client)        MODE="client" ;;
    --client-n8n)    MODE="client-n8n" ;;
    --domain)        shift; OPT_DOMAIN="${1:-}" ;;
    --port)          shift; OPT_PORT="${1:-}" ;;
    -y|--yes)        ASSUME_YES=1 ;;
    -h|--help)       print_help; exit 0 ;;
    *) err "Unknown option: $1"; print_help; exit 1 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Prompt helpers (respect --yes; read from the terminal)
# ---------------------------------------------------------------------------
confirm() {
  # confirm "Question?" [default:Y|N]
  local prompt="${1:-Proceed?}"
  local default="${2:-Y}"
  if [ "$ASSUME_YES" = "1" ]; then
    info "$prompt ${DIM}(auto-yes)${RESET}"
    return 0
  fi
  local hint="[Y/n]"; [ "$default" = "N" ] && hint="[y/N]"
  local reply
  read -r -p "${YELLOW}» ${prompt} ${hint} ${RESET}" reply || true
  reply="${reply:-$default}"
  case "$reply" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

ask() {
  # ask "Question?" "default"  -> echoes the answer (default if empty/--yes)
  local prompt="${1:-}"; local default="${2:-}"
  if [ "$ASSUME_YES" = "1" ]; then
    printf "%s" "$default"; return 0
  fi
  local reply
  read -r -p "${YELLOW}» ${prompt}${RESET} ${DIM}[${default:-skip}]${RESET} " reply || true
  printf "%s" "${reply:-$default}"
}

# ---------------------------------------------------------------------------
# Tool detection helpers
# ---------------------------------------------------------------------------
has() { command -v "$1" >/dev/null 2>&1; }

detect_pkg_mgr() {
  if has apt-get; then echo "apt"; elif has dnf; then echo "dnf";
  elif has yum; then echo "yum"; elif has pacman; then echo "pacman";
  elif has brew; then echo "brew"; else echo ""; fi
}

# Run a command with sudo only if not already root.
maybe_sudo() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi
}

# Generate a random single-user API token: tok_<48 hex>
gen_token() {
  if has node; then
    printf "tok_%s" "$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  elif has openssl; then
    printf "tok_%s" "$(openssl rand -hex 24)"
  else
    printf "tok_%s" "$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
}

# Cross-platform in-place sed.
sed_inplace() {
  local expr="$1"; local file="$2"
  if sed --version >/dev/null 2>&1; then sed -i "$expr" "$file"; else sed -i '' "$expr" "$file"; fi
}

# ---------------------------------------------------------------------------
# Node.js install (offered when missing)
# ---------------------------------------------------------------------------
require_node() {
  if has node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -lt 20 ]; then
      warn "Node.js ${major}.x detected; the project targets Node >= 20."
      install_node_offer || true
    else
      ok "Node.js $(node -v) detected."
    fi
    return 0
  fi
  warn "Node.js is not installed."
  install_node_offer
}

install_node_offer() {
  local pm; pm="$(detect_pkg_mgr)"
  case "$pm" in
    apt)
      if confirm "Install Node.js 20 LTS via NodeSource (needs sudo)?"; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | maybe_sudo bash -
        maybe_sudo apt-get install -y nodejs
        ok "Node.js $(node -v) installed."
      fi ;;
    dnf|yum)
      if confirm "Install Node.js 20 via NodeSource (needs sudo)?"; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | maybe_sudo bash -
        maybe_sudo "$pm" install -y nodejs
        ok "Node.js $(node -v) installed."
      fi ;;
    pacman)
      if confirm "Install nodejs + npm via pacman (needs sudo)?"; then
        maybe_sudo pacman -S --noconfirm nodejs npm
        ok "Node.js $(node -v) installed."
      fi ;;
    brew)
      if confirm "Install node@20 via Homebrew?"; then
        brew install node@20
        ok "Node.js installed."
      fi ;;
    *)
      err "Could not detect a package manager. Install Node.js >= 20 from https://nodejs.org and retry."
      return 1 ;;
  esac
  has node || { err "Node.js still not available."; return 1; }
}

# ---------------------------------------------------------------------------
# .env bootstrap (shared by server paths) — stores token in global TOKEN_OUT
# ---------------------------------------------------------------------------
TOKEN_OUT=""
ensure_env_file() {
  if [ -f .env ]; then
    ok ".env already exists — leaving it untouched."
    TOKEN_OUT="$(grep -E '^API_TOKEN=' .env | head -1 | cut -d= -f2- || true)"
    return 0
  fi
  if [ ! -f .env.example ]; then
    err ".env.example not found; cannot create .env."
    return 1
  fi
  if confirm "Create .env (config file) from .env.example now?"; then
    cp .env.example .env
    ok "Created .env"
    if confirm "Generate a random API_TOKEN (your panel login key) and write it into .env?"; then
      local token; token="$(gen_token)"
      if grep -q '^API_TOKEN=' .env; then
        sed_inplace "s|^API_TOKEN=.*|API_TOKEN=${token}|" .env
      else
        printf "\nAPI_TOKEN=%s\n" "$token" >> .env
      fi
      TOKEN_OUT="$token"
      ok "Wrote API_TOKEN to .env"
    fi
  else
    warn "Skipped .env creation. The server needs a .env to run."
  fi
}

# ---------------------------------------------------------------------------
# Caddy reverse proxy + automatic HTTPS (server-node, when a domain is given)
# ---------------------------------------------------------------------------
setup_caddy() {
  local domain="$1"; local port="$2"
  title "Reverse proxy + HTTPS (Caddy) for ${domain}"

  cat <<EOF
${BOLD}Before continuing, make sure your DNS is ready:${RESET}
  • Create an ${BOLD}A record${RESET}:  ${CYAN}${domain}${RESET}  →  this server's public IP
  • On Cloudflare: set it to ${BOLD}DNS only${RESET} (grey cloud / proxy ${BOLD}OFF${RESET})
    so Caddy can obtain the Let's Encrypt certificate directly.
EOF
  if ! confirm "Is the A record for ${domain} created and pointing here?"; then
    warn "Skipping Caddy. Create the DNS record, then re-run with: ./install.sh --server-node --domain ${domain}"
    return 0
  fi

  if ! has caddy; then
    local pm; pm="$(detect_pkg_mgr)"
    case "$pm" in
      apt)
        if confirm "Install Caddy via the official apt repo (needs sudo)?"; then
          maybe_sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
          curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | maybe_sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
          curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | maybe_sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
          maybe_sudo apt-get update
          maybe_sudo apt-get install -y caddy
          ok "Caddy installed."
        fi ;;
      dnf|yum)
        if confirm "Install Caddy via ${pm} (needs sudo)?"; then
          maybe_sudo "$pm" install -y 'dnf-command(copr)' || true
          maybe_sudo "$pm" copr enable -y @caddy/caddy || true
          maybe_sudo "$pm" install -y caddy
          ok "Caddy installed."
        fi ;;
      brew)
        if confirm "Install Caddy via Homebrew?"; then brew install caddy; ok "Caddy installed."; fi ;;
      *)
        warn "Could not auto-install Caddy. Install it from https://caddyserver.com/docs/install and re-run." ;;
    esac
  else
    ok "Caddy already installed."
  fi

  if has caddy; then
    local caddyfile="/etc/caddy/Caddyfile"
    info "Writing ${caddyfile} for ${domain} -> 127.0.0.1:${port}"
    maybe_sudo mkdir -p /etc/caddy /var/log/caddy
    # Generate the Caddyfile from our template.
    if [ -f Caddyfile.example ]; then
      sed -e "s|YOUR_DOMAIN|${domain}|g" -e "s|127.0.0.1:3000|127.0.0.1:${port}|g" \
        Caddyfile.example | maybe_sudo tee "$caddyfile" >/dev/null
    else
      printf '%s {\n\treverse_proxy 127.0.0.1:%s\n\tencode zstd gzip\n}\n' "$domain" "$port" \
        | maybe_sudo tee "$caddyfile" >/dev/null
    fi
    maybe_sudo systemctl reload caddy 2>/dev/null || maybe_sudo systemctl restart caddy 2>/dev/null || true
    ok "Caddy configured. HTTPS will be issued automatically on first request."
    PANEL_URL="https://${domain}"
  fi
}

# ---------------------------------------------------------------------------
# SERVER — native Node path
# ---------------------------------------------------------------------------
install_redis_native() {
  if has redis-server || has redis-cli; then
    ok "Redis appears to be installed."
    return 0
  fi
  warn "Redis is not installed."
  local pm; pm="$(detect_pkg_mgr)"
  case "$pm" in
    apt)
      if confirm "Install redis-server via apt-get (needs sudo)?"; then
        maybe_sudo apt-get update
        maybe_sudo apt-get install -y redis-server
        maybe_sudo systemctl enable --now redis-server 2>/dev/null || true
        ok "Redis installed."
      fi ;;
    dnf|yum)
      if confirm "Install redis via ${pm} (needs sudo)?"; then
        maybe_sudo "$pm" install -y redis
        maybe_sudo systemctl enable --now redis 2>/dev/null || true
        ok "Redis installed."
      fi ;;
    pacman)
      if confirm "Install redis via pacman (needs sudo)?"; then
        maybe_sudo pacman -S --noconfirm redis
        maybe_sudo systemctl enable --now redis 2>/dev/null || true
        ok "Redis installed."
      fi ;;
    brew)
      if confirm "Install redis via Homebrew?"; then
        brew install redis
        brew services start redis 2>/dev/null || true
        ok "Redis installed."
      fi ;;
    *)
      warn "Could not detect a package manager. Install Redis manually, or run it with Docker:"
      printf "    docker run -d --name redis -p 6379:6379 redis:7-alpine\n" ;;
  esac
}

PANEL_URL=""
install_server_node() {
  title "Server install — native Node.js + PM2"
  PANEL_URL=""

  local port="${OPT_PORT:-}"
  [ -z "$port" ] && port="$(ask "Which port should the panel listen on?" "3000")"
  [ -z "$port" ] && port="3000"

  # [1/6] Dependencies
  title "[1/6] System dependencies (Node 20+, Redis, Playwright)"
  require_node || return 1
  install_redis_native

  info "About to install npm dependencies (npm install)."
  if confirm "Install project dependencies now?"; then
    npm install
    ok "Dependencies installed."
  else
    warn "Skipped npm install — the server cannot run without it."
  fi

  # [2/6] Playwright browser
  title "[2/6] Browser engine (Playwright Chromium)"
  if confirm "Install the Playwright Chromium browser now?"; then
    if confirm "Also install system libraries for Chromium (needs sudo, recommended on a fresh server)?"; then
      npm run install:browser:deps
    else
      npm run install:browser
    fi
    ok "Browser ready."
  fi

  # [3/6] .env + token
  title "[3/6] Configuration (.env + API token)"
  ensure_env_file
  # Honour chosen port in .env
  if [ -f .env ] && [ "$port" != "3000" ]; then
    if grep -q '^PORT=' .env; then sed_inplace "s|^PORT=.*|PORT=${port}|" .env; else printf "\nPORT=%s\n" "$port" >> .env; fi
  fi

  # [4/6] Build
  title "[4/6] Build the project"
  if confirm "Build now (compile TypeScript -> dist/)?"; then
    npm run build
    ok "Build complete."
  fi

  # [5/6] Domain + HTTPS (optional)
  title "[5/6] Public domain + HTTPS (optional)"
  local domain="${OPT_DOMAIN:-}"
  if [ -z "$domain" ]; then
    domain="$(ask "Your domain for the panel (e.g. panel.example.com) — leave empty for IP:port only" "")"
  fi
  if [ -n "$domain" ]; then
    setup_caddy "$domain" "$port"
  else
    info "No domain given — the panel will be reachable on http://<server-ip>:${port}"
    PANEL_URL="http://localhost:${port}"
  fi

  # [6/6] Run under PM2
  title "[6/6] Run the server (PM2, auto-restart)"
  if confirm "Start the server under PM2 (cluster mode, auto-restart)?"; then
    if ! has pm2; then
      if confirm "PM2 is not installed. Install it globally (npm i -g pm2)?"; then
        npm install -g pm2 || maybe_sudo npm install -g pm2
      fi
    fi
    if has pm2; then
      pm2 start ecosystem.config.js
      pm2 save || true
      ok "Server started under PM2."
      info "Status: pm2 status   |   Logs: pm2 logs Hybrid-Automation --nostream"
      if confirm "Make PM2 start on boot (systemd unit)?"; then
        pm2 startup || warn "Run the command PM2 printed above (it needs sudo) to finish."
      fi
    else
      warn "PM2 unavailable. You can run the server directly with: npm start"
    fi
  else
    info "Start it later with:  pm2 start ecosystem.config.js   (or  npm start )"
  fi

  print_server_summary "$port"
}

# ---------------------------------------------------------------------------
# SERVER — Docker path
# ---------------------------------------------------------------------------
install_server_docker() {
  title "Server install — Docker Compose (app + redis)"
  PANEL_URL=""

  if ! has docker; then
    err "Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/"
    return 1
  fi
  local COMPOSE=""
  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose";
  elif has docker-compose; then COMPOSE="docker-compose";
  else err "Docker Compose not found. Install the Compose plugin: https://docs.docker.com/compose/install/"; return 1; fi
  ok "Using: ${COMPOSE}"

  ensure_env_file

  info "About to build and start the stack:  ${COMPOSE} up -d --build"
  if ! confirm "Build and start the Docker stack now?"; then
    warn "Aborted. Run later with: ${COMPOSE} up -d --build"
    return 0
  fi
  $COMPOSE up -d --build
  ok "Stack started."

  PANEL_URL="http://localhost:3000"
  if [ -f .env ] && grep -q '^API_TOKEN=$' .env 2>/dev/null; then
    warn "API_TOKEN is empty in .env — a random one is generated at boot."
    info "Reveal it with: ${COMPOSE} logs app | grep API_TOKEN"
  fi
  info "Follow logs:    ${COMPOSE} logs -f app"
  info "Stop the stack: ${COMPOSE} down"
  print_server_summary "3000"
}

# ---------------------------------------------------------------------------
# SERVER — Coolify guidance
# ---------------------------------------------------------------------------
install_coolify() {
  title "Server deploy — Coolify (isolated)"
  if [ ! -f docker-compose.coolify.yml ]; then
    err "docker-compose.coolify.yml is missing from this repo."
    return 1
  fi
  ok "Found docker-compose.coolify.yml (ready for Coolify)."
  cat <<EOF

${BOLD}Deploy on Coolify (each app runs isolated; Coolify handles domain + TLS):${RESET}

  ${BOLD}1.${RESET} Coolify → ${BOLD}+ New${RESET} → ${BOLD}Docker Compose${RESET} (from your Git repo).
  ${BOLD}2.${RESET} Repository:  ${CYAN}${REPO_URL_DEFAULT}${RESET}   Branch: ${CYAN}${REPO_BRANCH_DEFAULT}${RESET}
  ${BOLD}3.${RESET} Compose file:  ${CYAN}docker-compose.coolify.yml${RESET}
  ${BOLD}4.${RESET} Set the exposed ${BOLD}Port${RESET} to ${CYAN}3000${RESET} and attach your ${BOLD}domain${RESET}.
     Coolify requests a Let's Encrypt certificate automatically.
  ${BOLD}5.${RESET} Environment Variables (Coolify UI):
       ${CYAN}DEPLOYMENT_MODE=single${RESET}
       ${CYAN}API_TOKEN=$(gen_token)${RESET}   ${DIM}# or leave empty -> auto at boot${RESET}
       ${CYAN}NODE_ENV=production${RESET}
  ${BOLD}6.${RESET} Deploy, then open ${BOLD}https://your-domain/${RESET} and log in with the API_TOKEN.

${BOLD}Cloudflare note:${RESET} create an A record → server IP, set it to
${BOLD}DNS only${RESET} (grey cloud / proxy OFF) so Coolify can issue the certificate.
EOF
  ok "Coolify guidance printed. (No local changes were made.)"
}

# ---------------------------------------------------------------------------
# CLIENT — Chrome extension
# ---------------------------------------------------------------------------
install_client() {
  title "Client — Chrome extension (load unpacked)"
  if [ ! -d extension ]; then
    warn "extension/ folder not found — skipping."
    return 0
  fi

  # Build the verified, installable artifact so the user selects a folder that
  # has already been checked for a valid manifest and complete runtime files —
  # rather than the raw source tree, which may carry dev-only extras.
  local ext_dir="${SCRIPT_DIR}/extension"
  if command -v node >/dev/null 2>&1 && [ -f scripts/build-extension.js ]; then
    info "Building the extension artifact…"
    if node scripts/build-extension.js; then
      ext_dir="${SCRIPT_DIR}/artifacts/element-inspector-extension"
      ok "Artifact ready: ${ext_dir}"
    else
      warn "Artifact build failed — falling back to the extension/ source folder."
    fi
  else
    warn "Node not found — falling back to the extension/ source folder."
  fi

  cat <<EOF
${BOLD}Load the Chrome extension on this PC:${RESET}
  1. Open  ${CYAN}chrome://extensions${RESET}
  2. Enable ${BOLD}Developer mode${RESET} (top-right toggle)
  3. Click ${BOLD}Load unpacked${RESET}
  4. Select this folder:
       ${CYAN}${ext_dir}${RESET}
  5. Open the extension popup and set:
       • Server URL   (e.g. https://panel.example.com)
       • API token    (your single-user API_TOKEN)
EOF
  ok "Chrome extension instructions printed."
}

# ---------------------------------------------------------------------------
# CLIENT — n8n community node
# ---------------------------------------------------------------------------
install_client_n8n() {
  title "Client — n8n community node"
  if [ ! -d n8n-node ]; then
    warn "n8n-node/ folder not found — skipping."
    return 0
  fi
  require_node || return 1
  info "This builds the n8n node package (TypeScript -> dist) in ./n8n-node."
  if confirm "Install deps and build the n8n node now?"; then
    ( cd n8n-node && npm install && npm run build )
    ok "n8n node built at ${SCRIPT_DIR}/n8n-node/dist"
    local N8N_CUSTOM="${HOME}/.n8n/custom"
    info "n8n loads community nodes from: ${N8N_CUSTOM}"
    if confirm "Install the built node into ${N8N_CUSTOM} now?"; then
      mkdir -p "$N8N_CUSTOM"
      ( cd "$N8N_CUSTOM" && { [ -f package.json ] || npm init -y >/dev/null 2>&1; } && npm install "${SCRIPT_DIR}/n8n-node" )
      ok "Installed into ${N8N_CUSTOM}. Restart n8n to pick it up."
    else
      info "Manual: in n8n install community node 'n8n-nodes-automationbackend',"
      info "or run:  cd ~/.n8n/custom && npm install \"${SCRIPT_DIR}/n8n-node\""
    fi
  fi
  ok "n8n client done."
}

# ---------------------------------------------------------------------------
# Final summary for server installs
# ---------------------------------------------------------------------------
print_server_summary() {
  local port="${1:-3000}"
  [ -z "$PANEL_URL" ] && PANEL_URL="http://localhost:${port}"
  printf "\n%s\n" "${GREEN}${BOLD}============================================================${RESET}"
  printf "%s\n" "${GREEN}${BOLD}  ✅ Server is ready!${RESET}"
  printf "%s\n" "${GREEN}${BOLD}============================================================${RESET}"
  printf "  %s %s\n" "${BOLD}Panel URL:${RESET}" "${CYAN}${PANEL_URL}${RESET}"
  printf "  %s %s\n" "${BOLD}Health:   ${RESET}" "${CYAN}${PANEL_URL}/health${RESET}"
  if [ -n "$TOKEN_OUT" ]; then
    printf "  %s %s\n" "${BOLD}API Token:${RESET}" "${YELLOW}${TOKEN_OUT}${RESET}"
    printf "  %s\n" "${DIM}Open the panel, then paste this token on the login screen.${RESET}"
  else
    printf "  %s\n" "${DIM}API Token: see your .env (API_TOKEN=...) — if empty, check the startup logs.${RESET}"
  fi
  printf "%s\n\n" "${GREEN}${BOLD}============================================================${RESET}"
}

# ---------------------------------------------------------------------------
# Interactive menu
# ---------------------------------------------------------------------------
menu() {
  title "automation-backend installer"
  cat <<EOF
What are you installing on ${BOLD}this machine${RESET}?

  ${BOLD}1)${RESET} Server (Node)     ${DIM}— native Node + Redis + Playwright + PM2 (+ HTTPS)${RESET}
  ${BOLD}2)${RESET} Server (Docker)   ${DIM}— app + redis via docker compose${RESET}
  ${BOLD}3)${RESET} Server (Coolify)  ${DIM}— isolated deploy guidance + files${RESET}
  ${BOLD}4)${RESET} Client (Chrome)   ${DIM}— load the browser extension on this PC${RESET}
  ${BOLD}5)${RESET} Client (n8n)      ${DIM}— build/install the n8n community node${RESET}
  ${BOLD}6)${RESET} Quit
EOF
  local choice
  choice="$(ask "Choose [1-6]" "1")"
  case "$choice" in
    1) install_server_node ;;
    2) install_server_docker ;;
    3) install_coolify ;;
    4) install_client ;;
    5) install_client_n8n ;;
    6|q|Q) info "Bye."; exit 0 ;;
    *) err "Invalid choice."; exit 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
main() {
  case "$MODE" in
    server-docker) install_server_docker ;;
    server-node)   install_server_node ;;
    coolify)       install_coolify ;;
    client)        install_client ;;
    client-n8n)    install_client_n8n ;;
    "")            menu ;;
  esac
  printf "\n%s\n" "${GREEN}${BOLD}Done.${RESET}"
}

main "$@"
