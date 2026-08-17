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

  # Already exactly right? Then write nothing at all.
  #
  # Not an optimisation. These startup scripts run on EVERY boot, and rewriting a
  # file that already agrees has three costs an operator actually feels: the mtime
  # that deployment tooling (and Coolify's change detection) watches moves for no
  # reason; a `.env` mounted read-only makes the rewrite fail and abort a startup
  # that had nothing to do; and any concurrent reader can observe the brief window
  # where the file is being replaced. The condition is deliberately narrow —
  # EXACTLY one PUBLIC_DOMAIN line with this value, and no BASE_URL at all — so a
  # duplicate or a stale synonym is still cleaned up below.
  # `grep -c` exits 1 when the count is zero, so the idiomatic `|| echo 0` guard
  # produces the two-line string "0\n0" and the comparison silently never
  # matches — measured, and the reason this is counted with -c into a variable
  # instead. Counting through `grep | wc -l` keeps the exit status irrelevant.
  # The patterns here MUST match the awk program below, spaces included, or a
  # line written as `PUBLIC_DOMAIN = x` would be invisible to the count and
  # visible to the rewrite (or the reverse), and the two halves of this function
  # would disagree about whether the file is already correct.
  domain_pd_count="$(grep -c '^[[:space:]]*PUBLIC_DOMAIN[[:space:]]*=' .env 2>/dev/null)" || domain_pd_count=0
  domain_bu_count="$(grep -c '^[[:space:]]*BASE_URL[[:space:]]*=' .env 2>/dev/null)" || domain_bu_count=0
  if [ "${domain_pd_count:-0}" = "1" ] && [ "${domain_bu_count:-0}" = "0" ] \
    && grep -qxF "PUBLIC_DOMAIN=${domain_value}" .env 2>/dev/null; then
    return 0
  fi

  awk -v val="$domain_value" '
    # Drop every existing assignment of either name, then append one canonical
    # line. Leaving a stale BASE_URL behind would be worse than not writing at
    # all: the operator would see their new domain in .env and still be
    # advertised the old one, with no clue why.
    #
    # This is also what makes PUBLIC_DOMAIN the single source of truth in the
    # file rather than merely in the reader: config.ts accepts BASE_URL as a
    # synonym, so a file containing both would resolve by precedence instead of
    # by what the operator last typed.
    #
    # SPACE BEFORE THE "=" IS MATCHED DELIBERATELY. `PUBLIC_DOMAIN = https://x`
    # is honoured by dotenv, and by the grep in _domain_current above, but an
    # earlier version of this awk required the "=" to touch the name — so a
    # hand-edited line written with spaces SURVIVED the cleanup and the canonical
    # line was appended after it. The result was two live assignments of the same
    # key, which is precisely the duplicate configuration this file exists to
    # prevent, produced by the code meant to prevent it. Measured by test, not
    # reasoned about: the leftover line was "  PUBLIC_DOMAIN = https://c…".
    /^[[:space:]]*PUBLIC_DOMAIN[[:space:]]*=/ { next }
    /^[[:space:]]*BASE_URL[[:space:]]*=/      { next }
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
