#!/usr/bin/env bash
# setup-wizard.sh — the questions Plyr asks when it is launched from a terminal.
#
# Sourced by scripts/plyr.sh. Every question is a NUMBERED CHOICE with the
# recommended answer marked and pre-selected: pressing Enter always does the
# sensible thing, and nobody has to know a variable name or invent a value.
# The only free-text answers are the ones that are genuinely the operator's own
# (their own token, their own domain), and each of those is optional.
#
# Non-interactive (CI, Docker entrypoints, nohup, AB_NO_PROMPT=1, --yes):
# nothing is asked; the remembered or the default answer is used.
#
# Writes:
#   ./plyr setup | start | install  -> .env                 (persistent install)
#   ./plyr dev-docker               -> .plyr/dev-docker.env  (disposable stack)
# A key written to .env is also removed from the Settings page's own file
# (data/settings.env), which would otherwise outrank it.
#
# Every value written here can be changed later in the panel:
# Settings → Server settings.

# ---------- terminal helpers ----------
_wz_tty() { [[ -z "${AB_NO_PROMPT:-}" && -z "${PLYR_YES:-}" && -t 0 && -t 1 ]]; }
_wz_bold() { if [[ -t 1 ]]; then printf '\033[1m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }
_wz_dim() { if [[ -t 1 ]]; then printf '\033[2m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }

# ask_choice RESULT_VAR "Question" DEFAULT_INDEX "Label|hint" "Label|hint" ...
# Sets RESULT_VAR to the chosen 1-based index. Enter = default.
ask_choice() {
  local __var="$1" question="$2" def="$3"; shift 3
  local -a opts=("$@")
  local n=${#opts[@]} i lbl hnt reply
  if ! _wz_tty; then printf -v "$__var" '%s' "$def"; return 0; fi
  printf '\n%s\n' "$(_wz_bold "$question")"
  for (( i = 1; i <= n; i++ )); do
    lbl="${opts[i-1]%%|*}"; hnt=''
    [[ "${opts[i-1]}" == *'|'* ]] && hnt="${opts[i-1]#*|}"
    if (( i == def )); then
      printf '  %s %s  %s\n' "$(_wz_bold "[$i]")" "$(_wz_bold "$lbl")" "$(_wz_dim '(recommended — press Enter)')"
    else
      printf '  [%s] %s\n' "$i" "$lbl"
    fi
    [[ -n "$hnt" ]] && printf '      %s\n' "$(_wz_dim "$hnt")"
  done
  while :; do
    reply=''
    read -r -p "  Choose 1-$n [$def]: " reply || { printf -v "$__var" '%s' "$def"; return 0; }
    reply="${reply//[[:space:]]/}"
    [[ -z "$reply" ]] && reply="$def"
    if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= n )); then
      printf -v "$__var" '%s' "$reply"; return 0
    fi
    printf '  Please type a number from 1 to %s.\n' "$n"
  done
}

# ask_text RESULT_VAR "Prompt" VALIDATOR_FN — empty answer = go back (returns 1).
ask_text() {
  local __var="$1" prompt="$2" validator="${3:-}" reply msg
  _wz_tty || return 1
  while :; do
    reply=''
    read -r -p "  $prompt (Enter = go back): " reply || return 1
    reply="$(printf '%s' "$reply" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [[ -z "$reply" ]] && return 1
    if [[ -n "$validator" ]] && ! msg="$("$validator" "$reply")"; then
      printf '  %s\n' "$msg"; continue
    fi
    printf -v "$__var" '%s' "$reply"; return 0
  done
}

# ---------- values ----------
# Random 48-hex-character secret.
# No `producer | head -c N` pipeline on purpose: under `set -Eeuo pipefail` the
# producer can be killed by SIGPIPE (exit 141) when `head` closes early, which
# fails the assignment and silently ends the whole script (seen on MSYS2/Git
# Bash). Every command here reads a fixed amount and every failure is handled.
wz_gen_token() {
  local t=''
  if command -v openssl >/dev/null 2>&1; then
    t="$(openssl rand -hex 24 2>/dev/null)" || t=''
    t="${t//[^0-9a-fA-F]/}"                      # drop CR/LF a Windows build may add
  fi
  if [[ ${#t} -lt 32 && -r /dev/urandom ]]; then
    t="$(od -An -N24 -tx1 /dev/urandom 2>/dev/null | tr -d ' \r\n')" || t=''
    t="${t//[^0-9a-fA-F]/}"
  fi
  if [[ ${#t} -lt 32 ]]; then
    t="$(date +%s)${RANDOM}${RANDOM}${RANDOM}${RANDOM}${RANDOM}${RANDOM}${RANDOM}${RANDOM}"
  fi
  printf '%s' "${t:0:48}"
}

wz_valid_token() {
  local v="$1"
  [[ "$v" =~ ^[A-Za-z0-9._~-]+$ ]] || { echo "Use letters, digits and . _ ~ - only."; return 1; }
  [[ "$v" == admin123 ]] && { echo "admin123 is public; choose something else."; return 1; }
  (( ${#v} >= 16 )) || { echo "Use at least 16 characters."; return 1; }
  return 0
}

wz_valid_domain() {
  local v="$1"
  [[ "$v" =~ ^(https?://)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]] \
    || { echo "Enter something like panel.example.com or https://panel.example.com"; return 1; }
  return 0
}

wz_norm_domain() {
  local v="${1%/}"
  [[ "$v" =~ ^https?:// ]] || v="https://$v"
  printf '%s' "$v"
}

wz_mask() { local v="$1"; if (( ${#v} > 8 )); then printf '%s…%s' "${v:0:4}" "${v: -4}"; else printf '••••'; fi; }

# ---------- env-file editing (one key, one line; CRLF-tolerant; GNU/BSD portable) ----------
wz_env_get() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  sed 's/\r$//' "$file" | grep -E "^[[:space:]]*${key}=" | tail -1 | cut -d= -f2- \
    | sed 's/[[:space:]]*#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' || true
}

wz_env_set() {
  local key="$1" value="$2" file="$3" tmp
  [[ -f "$file" ]] || : > "$file"
  tmp="$file.wz.tmp"
  awk -v k="$key" -v v="$value" '
    { line = $0; sub(/\r$/, "", line) }
    line ~ ("^[[:space:]]*" k "=") { if (!done) { print k "=" v; done = 1 }; next }
    { print $0 }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp" && mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

wz_env_unset() {
  local key="$1" file="$2" tmp
  [[ -f "$file" ]] || return 0
  tmp="$file.wz.tmp"
  awk -v k="$key" '{ line = $0; sub(/\r$/, "", line) } line ~ ("^[[:space:]]*" k "=") { next } { print $0 }' "$file" > "$tmp" && mv "$tmp" "$file"
}

# The Settings page's own file. Mirrors settingsFilePath() in src/core/PersistedSettings.ts.
wz_settings_file() {
  local root="$1" envf="$2" f sq
  f="${SETTINGS_FILE:-$(wz_env_get SETTINGS_FILE "$envf")}"
  if [[ -z "$f" ]]; then
    sq="${SQLITE_PATH:-$(wz_env_get SQLITE_PATH "$envf")}"; sq="${sq:-./data/plyr.db}"
    f="$(dirname "$sq")/settings.env"
  fi
  [[ "$f" = /* ]] || f="$root/${f#./}"
  printf '%s' "$f"
}

# Write to .env AND drop the same key from the panel's file, so the two agree.
wz_write() {
  local key="$1" value="$2" envf="$3" root="$4" sf
  wz_env_set "$key" "$value" "$envf"
  sf="$(wz_settings_file "$root" "$envf")"
  if [[ -f "$sf" ]] && sed 's/\r$//' "$sf" | grep -qE "^[[:space:]]*${key}="; then
    wz_env_unset "$key" "$sf"
    printf '  %s\n' "$(_wz_dim "($key had been set in the panel; the new value replaces it)")"
  fi
}

wz_env_label() {
  case "$1" in
    development|dev) printf 'Development (this computer)' ;;
    server|remote) printf 'Server (production, with Remote Browser)' ;;
    production|prod) printf 'Production (headless, no extensions)' ;;
    *) printf '%s' "$1" ;;
  esac
}

# =====================================================================
# Persistent install:  ./plyr setup   (also offered by start / install)
# =====================================================================
# plyr_setup ROOT ENV_FILE [--if-needed]
#   --if-needed: first run asks everything; later runs offer
#                "start with current settings" (Enter) or "change".
plyr_setup() {
  local root="$1" envf="$2" when="${3:-always}" marker
  marker="${STATE_DIR:-$root/.plyr/runtime}/setup-done"
  PLYR_SETUP_TOKEN_NOTE=''; PLYR_SETUP_TOKEN=''; PLYR_SETUP_AUTH=''

  local cur_env cur_auth cur_token cur_domain cur_hook
  cur_env="$(wz_env_get APP_ENV "$envf")"; [[ -n "$cur_env" ]] || cur_env="$(wz_env_get NODE_ENV "$envf")"
  case "${cur_env:-development}" in dev|development|'') cur_env=development;; prod|production) cur_env=production;; remote|server) cur_env=server;; *) cur_env=development;; esac
  cur_auth="$(wz_env_get AUTH_MODE "$envf")"; cur_auth="${cur_auth:-token}"
  cur_token="$(wz_env_get API_TOKEN "$envf")"
  cur_domain="$(wz_env_get PUBLIC_DOMAIN "$envf")"
  cur_hook="$(wz_env_get WEBHOOK_SECRET "$envf")"

  if [[ "$when" == --if-needed ]]; then
    # No terminal: never block. ensure_env already gave a fresh .env a random token.
    _wz_tty || return 0
    if [[ -f "$marker" ]]; then
      local login_desc='API token' c
      [[ "$cur_env" == development && "$cur_auth" == open ]] && login_desc='no login (this computer only)'
      ask_choice c "Start Plyr with the current settings?  $(_wz_dim "[$(wz_env_label "$cur_env") · $login_desc]")" 1 \
        "Yes, start" \
        "Change settings first|environment, login/token, domain"
      [[ "$c" == 1 ]] && return 0
    fi
  fi

  printf '\n%s\n' "$(_wz_bold '── Plyr setup ─────────────────────────────────────────────')"
  printf '%s\n' "$(_wz_dim 'Press Enter to accept the recommended answer. Everything can be changed later')"
  printf '%s\n' "$(_wz_dim 'in the panel: Settings → Server settings.')"

  # 1. Environment
  local e def=1 q=1
  case "$cur_env" in server) def=2;; production) def=3;; esac
  ask_choice e "$q) Where is Plyr running?" "$def" \
    "Development — on my own computer|Browser visible; no login needed from this computer." \
    "Server — production, with Remote Browser|A real server/VPS. Token required; extensions and Element Inspector work." \
    "Production — headless job runner|Only runs the job queue. Hidden browser, NO extensions."
  local new_env new_auth=token new_token="$cur_token" new_domain="$cur_domain" new_hook="$cur_hook" token_note=''
  case "$e" in 1) new_env=development;; 2) new_env=server;; *) new_env=production;; esac
  q=$((q + 1))

  # 2. Login (development only — servers always need the token)
  if [[ "$new_env" == development ]]; then
    local a adef=1
    [[ "$cur_auth" == token && -f "$marker" ]] && adef=2
    ask_choice a "$q) Login to the panel" "$adef" \
      "No login — open the panel directly|Only from this computer (localhost). Others on your network still need the token." \
      "Use an API token|Same as on a server."
    [[ "$a" == 1 ]] && new_auth=open
    q=$((q + 1))
  fi

  # 3. Token
  if [[ "$new_auth" == open ]]; then
    # The token still exists (WebSockets, download links, the extension); the
    # panel receives it from the server instead of asking for it.
    if [[ -z "$new_token" || "$new_token" == admin123 ]]; then new_token="$(wz_gen_token)"; token_note=generated; fi
  else
    local tk
    if [[ -n "${PLYR_ENV_FRESH:-}" && ! -f "$marker" && -n "$cur_token" && "$cur_token" != admin123 ]]; then
      # ensure_env just wrote a random token into the new .env; the user has
      # never seen it, so "keep the current token" would be a meaningless offer.
      ask_choice tk "$q) API token (your login key)" 1 \
        "Use a secure token generated for me|48 random characters, shown at the end. Recommended." \
        "I have my own token|At least 16 characters."
      token_note=generated
      if [[ "$tk" == 2 ]] && ask_text new_token "Paste your token" wz_valid_token; then token_note=own; fi
    elif [[ -z "$cur_token" || "$cur_token" == admin123 ]]; then
      ask_choice tk "$q) API token (your login key)" 1 \
        "Generate a secure token for me|48 random characters, shown at the end. Recommended." \
        "I have my own token|At least 16 characters."
      if [[ "$tk" == 2 ]] && ask_text new_token "Paste your token" wz_valid_token; then token_note=own
      else new_token="$(wz_gen_token)"; token_note=generated
      fi
    else
      ask_choice tk "$q) API token (your login key)  $(_wz_dim "[current: $(wz_mask "$cur_token")]")" 1 \
        "Keep the current token|The panel, extension and scripts keep working." \
        "Generate a new one|The old token stops working." \
        "Use my own token"
      case "$tk" in
        2) new_token="$(wz_gen_token)"; token_note=generated ;;
        3) if ask_text new_token "Paste your token" wz_valid_token; then token_note=own; else new_token="$cur_token"; fi ;;
      esac
    fi
    q=$((q + 1))
  fi

  # 4. Domain + webhook secret (servers only)
  if [[ "$new_env" != development ]]; then
    local d
    if [[ -n "$cur_domain" ]]; then
      ask_choice d "$q) Public address of this server  $(_wz_dim "[current: $cur_domain]")" 1 \
        "Keep $cur_domain" \
        "Detect automatically|Fine for a LAN or a plain IP." \
        "Enter a different domain"
      case "$d" in
        2) new_domain='' ;;
        3) if ask_text new_domain "Domain (e.g. panel.example.com)" wz_valid_domain; then new_domain="$(wz_norm_domain "$new_domain")"; else new_domain="$cur_domain"; fi ;;
      esac
    else
      ask_choice d "$q) Public address of this server" 1 \
        "Detect automatically|Fine for a LAN or a plain IP. You can add a domain later in Settings." \
        "I have a domain|e.g. panel.example.com — the Extension will connect to it."
      if [[ "$d" == 2 ]] && ask_text new_domain "Domain (e.g. panel.example.com)" wz_valid_domain; then
        new_domain="$(wz_norm_domain "$new_domain")"
      fi
    fi
    q=$((q + 1))
    if [[ -z "$cur_hook" ]]; then
      local w
      ask_choice w "$q) Signing secret for outgoing webhooks" 1 \
        "Generate one for me|Receivers can verify a webhook really came from this server." \
        "No signing"
      [[ "$w" == 1 ]] && new_hook="$(wz_gen_token)"
    fi
  fi

  # Write
  wz_write APP_ENV "$new_env" "$envf" "$root"
  wz_write AUTH_MODE "$new_auth" "$envf" "$root"
  [[ -n "$new_token" ]] && wz_write API_TOKEN "$new_token" "$envf" "$root"
  if [[ "$new_env" != development ]]; then
    wz_write PUBLIC_DOMAIN "$new_domain" "$envf" "$root"
    [[ -n "$new_hook" ]] && wz_write WEBHOOK_SECRET "$new_hook" "$envf" "$root"
  fi
  mkdir -p "$(dirname "$marker")" && : > "$marker"

  printf '\n%s\n' "$(_wz_bold '── Saved to .env ──────────────────────────────────────────')"
  printf '  Environment : %s\n' "$(wz_env_label "$new_env")"
  if [[ "$new_auth" == open ]]; then
    printf '  Login       : none — open http://localhost:%s on this computer\n' "${PORT:-3000}"
  else
    printf '  Login       : API token\n'
    if [[ -n "$token_note" ]]; then
      printf '  API token   : %s\n' "$(_wz_bold "$new_token")"
      printf '                %s\n' "$(_wz_dim 'Copy it now. It is also in .env and in the panel (Settings → Server settings).')"
    else
      printf '  API token   : unchanged (%s)\n' "$(wz_mask "$new_token")"
    fi
  fi
  [[ "$new_env" != development ]] && printf '  Address     : %s\n' "${new_domain:-detected automatically}"
  PLYR_SETUP_TOKEN_NOTE="$token_note"; PLYR_SETUP_TOKEN="$new_token"; PLYR_SETUP_AUTH="$new_auth"
  return 0
}

# =====================================================================
# Disposable dev stack:  ./plyr dev-docker
# =====================================================================
# dev_docker_setup MODE TOKEN_OPT STATE_DIR
#   MODE      '' (ask) | dev | prod
#   TOKEN_OPT '' (ask) | new | keep | <value>      (prod only)
# Writes STATE_DIR/dev-docker.env (read by docker-compose.dev.yml through
# --env-file) and sets DEV_ENV_FILE, DEV_SUMMARY_MODE/TOKEN/NOTE.
dev_docker_setup() {
  local mode="${1:-}" token_opt="${2:-}" state_dir="$3"
  local f="$state_dir/dev-docker.env" prev_mode prev_token c msg
  mkdir -p "$state_dir"
  prev_mode="$(wz_env_get PLYR_DEV_MODE "$f")"
  prev_token="$(wz_env_get PLYR_DEV_API_TOKEN "$f")"

  if [[ -z "$mode" ]]; then
    local def=1
    [[ "$prev_mode" == prod ]] && def=2
    ask_choice c "How should this test stack run?" "$def" \
      "Development — no login|Open http://localhost:3000 directly. Fastest for trying a branch or PR." \
      "Production-like — real API token|Same login as a server. A token is generated for you."
    mode=dev; [[ "$c" == 2 ]] && mode=prod
  fi

  local token='' note=''
  if [[ "$mode" == prod ]]; then
    case "$token_opt" in
      new) token="$(wz_gen_token)"; note=generated ;;
      keep) token="$prev_token"; note=kept; [[ -n "$token" ]] || { token="$(wz_gen_token)"; note=generated; } ;;
      '')
        if [[ -n "$prev_token" ]]; then
          ask_choice c "API token for this stack  $(_wz_dim "[previous: $(wz_mask "$prev_token")]")" 1 \
            "Keep the previous token|A panel/extension you already set up keeps working." \
            "Generate a new one" \
            "Use my own token"
          case "$c" in
            1) token="$prev_token"; note=kept ;;
            2) token="$(wz_gen_token)"; note=generated ;;
            3) if ask_text token "Paste your token" wz_valid_token; then note=own; else token="$prev_token"; note=kept; fi ;;
          esac
        else
          ask_choice c "API token for this stack" 1 \
            "Generate a secure token for me|Recommended." \
            "Use my own token"
          if [[ "$c" == 2 ]] && ask_text token "Paste your token" wz_valid_token; then note=own
          else token="$(wz_gen_token)"; note=generated
          fi
        fi ;;
      *)
        if msg="$(wz_valid_token "$token_opt")"; then token="$token_opt"; note=own
        else printf '[plyr] ERROR: --token: %s\n' "$msg" >&2; return 1; fi ;;
    esac
  else
    # Development: no login, but a real (random) token still exists for
    # WebSockets, download links and the extension. Kept across runs.
    token="${prev_token:-$(wz_gen_token)}"
  fi

  {
    printf '# Written by ./plyr dev-docker. Choices for the DISPOSABLE dev stack only;\n'
    printf '# never read by ./plyr start. Safe to delete.\n'
    printf 'PLYR_DEV_MODE=%s\n' "$mode"
    printf 'PLYR_DEV_AUTH_MODE=%s\n' "$([[ "$mode" == prod ]] && echo token || echo open)"
    printf 'PLYR_DEV_API_TOKEN=%s\n' "$token"
  } > "$f.tmp" && mv "$f.tmp" "$f"
  chmod 600 "$f" 2>/dev/null || true
  DEV_ENV_FILE="$f"
  DEV_SUMMARY_MODE="$mode"; DEV_SUMMARY_TOKEN="$token"; DEV_SUMMARY_NOTE="$note"
  return 0
}
