#!/usr/bin/env bash
# ask-domain.sh — offer to record a public domain in .env, before the server starts.
#
# WHY THIS EXISTS
# ---------------
# Pairing an extension needs the Authorization Code AND the Base URL. The server
# can detect an address, but detection cannot see a Cloudflare hostname from
# inside a container — only the operator knows that. Asking once at startup is
# the cheapest moment to capture it: the alternative is the operator discovering
# at pairing time that the address on screen is a LAN IP their extension cannot
# reach, and having to work out which of 77 environment variables to change.
#
# WHY A SHARED FILE RATHER THAN THE SAME PROMPT IN BOTH SCRIPTS
# -------------------------------------------------------------
# dev.sh and scripts/dev-server.sh both start the stack. Two copies of this
# would drift, and the failure mode of drift here is silent: one script writes
# PUBLIC_DOMAIN and the other writes BASE_URL, so whichever the operator last
# used decides whether their domain is honoured.
#
# CONTRACT
# --------
# Sourced, not executed:  . scripts/ask-domain.sh  &&  ask_public_domain
# Writes nothing unless the operator answers y AND supplies a non-empty value.
# Never fails the caller: a startup script must not abort because a prompt was
# declined, redirected from /dev/null, or answered with nonsense.

# Is this shell attached to a terminal a human can answer from?
#
# Checked because these scripts are also run by CI, by Docker entrypoints and
# under `nohup`, where `read` returns instantly at EOF. Prompting there would
# print a question nobody sees and then silently take the empty answer -- which
# looks identical to the operator declining, and hides the fact that the domain
# was never asked for at all.
_domain_can_prompt() {
  [ -t 0 ] && [ -t 1 ]
}

# Read the value currently recorded in .env, if any.
_domain_current() {
  [ -f .env ] || return 0
  # The last assignment wins, matching how dotenv itself resolves duplicates.
  grep -E '^[[:space:]]*(PUBLIC_DOMAIN|BASE_URL)=' .env 2>/dev/null \
    | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*$//'
}

# Write PUBLIC_DOMAIN into .env, replacing any existing value.
#
# Rewrites in place with awk rather than `sed -i` because the -i flag takes an
# argument on BSD/macOS sed and not on GNU, and this repo is run on both.
_domain_write() {
  domain_value="$1"
  [ -f .env ] || : > .env

  # A value with a '#' would be truncated by the server's own comment-stripping,
  # so a domain containing one is not something we can store faithfully.
  case "$domain_value" in
    *'#'*)
      printf '  ! ignoring domain containing "#" (it would be read as a comment)\n'
      return 0
      ;;
  esac

  # Reject values that are plainly not addresses.
  #
  # The question immediately before this one is a y/N, so "y" is a genuinely
  # common answer here -- and storing PUBLIC_DOMAIN=y is worse than storing
  # nothing: the panel would advertise "https://y" beside the Authorization Code,
  # the Extension could never reach it, and no message on screen would explain
  # why. Refusing hands the job back to auto-detection, which at least produces
  # a reachable address on a laptop.
  domain_bare="${domain_value#*://}"
  domain_bare="${domain_bare%%/*}"
  case "$domain_bare" in
    ""|[Yy]|[Nn]|[Yy]es|[Nn]o|true|false)
      printf '  ! "%s" is not a domain — ignoring it (this asks for an address, not y/n)\n' "$domain_value"
      return 0
      ;;
    *' '*|*"	"*)
      printf '  ! ignoring domain containing whitespace: "%s"\n' "$domain_value"
      return 0
      ;;
  esac
  # A hostname needs a dot, unless it is localhost or carries an explicit port.
  case "$domain_bare" in
    *.*|localhost|localhost:*|*:[0-9]*) ;;
    *)
      printf '  ! "%s" does not look like a domain (no dot) — ignoring it\n' "$domain_value"
      return 0
      ;;
  esac

  awk -v val="$domain_value" '
    # Drop every existing assignment of either name, then append one canonical
    # line. Leaving a stale BASE_URL behind would be worse than not writing at
    # all: the operator would see their new domain in .env and still be
    # advertised the old one, with no clue why.
    /^[[:space:]]*PUBLIC_DOMAIN=/ { next }
    /^[[:space:]]*BASE_URL=/      { next }
    { print }
    END { printf "PUBLIC_DOMAIN=%s\n", val }
  ' .env > .env.domain.tmp && mv .env.domain.tmp .env
}

# The prompt itself.
ask_public_domain() {
  # An explicit environment value means the operator has already decided --
  # through docker-compose, a systemd unit or their shell. Asking again would
  # invite them to overwrite it by pressing Enter on a question they did not
  # expect.
  if [ -n "${PUBLIC_DOMAIN:-}" ] || [ -n "${BASE_URL:-}" ]; then
    printf '  domain from environment: %s\n' "${PUBLIC_DOMAIN:-$BASE_URL}"
    return 0
  fi

  if [ -n "${AB_NO_PROMPT:-}" ] || ! _domain_can_prompt; then
    return 0
  fi

  existing="$(_domain_current)"
  if [ -n "$existing" ]; then
    printf '  domain already set in .env: %s\n' "$existing"
    return 0
  fi

  printf '\n'
  printf 'A custom domain lets the Extension connect using your own address\n'
  printf '(e.g. one you set up on Cloudflare) instead of a detected server IP.\n'
  printf 'Leave this alone and the server will detect an address by itself.\n'
  reply=''
  read -r -p "Do you want to set a custom domain? (y/N): " reply || return 0
  case "$reply" in
    [Yy]*) ;;
    *) return 0 ;;
  esac

  domain=''
  read -r -p "Enter your domain (e.g. https://my-domain.com): " domain || return 0
  # Trim, because a trailing space pasted from a browser would end up in .env.
  domain="$(printf '%s' "$domain" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  # Enter on an empty line means "skip", the same as answering n. Writing an
  # empty PUBLIC_DOMAIN would be indistinguishable from a configured one that
  # resolves to nothing.
  if [ -z "$domain" ]; then
    printf '  no domain entered — the server will detect an address\n'
    return 0
  fi

  _domain_write "$domain"
  printf '  saved PUBLIC_DOMAIN=%s to .env\n' "$domain"
}
