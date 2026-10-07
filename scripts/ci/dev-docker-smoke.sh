#!/usr/bin/env bash
# Smoke test for a RUNNING Plyr instance, run by CI against the image it is
# about to publish (the image `./plyr dev-docker [--ref ...]` will pull).
#
#   dev-docker-smoke.sh probe            the same readiness gates as dev-docker
#   dev-docker-smoke.sh write            + save a workflow; prints its id
#   dev-docker-smoke.sh read <id>        the workflow is still there (after a restart)
#
# `write`/`read` go through the real storage (SQLite by default), so a native
# binding that is missing from the image fails here and not on a user's machine.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-admin123}"
USER_ID="${USER_ID:-local}"

die() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
say() { printf '[smoke] %s\n' "$*" >&2; }

json_field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=$1;process.stdout.write(v===undefined||v===null?'':String(v))}catch{process.exit(1)}})"; }

probe() {
  local body
  body="$(curl -fsS --max-time 10 "$BASE_URL/health")" || die "/health did not answer 200"
  [[ "$(json_field 'JSON.parse(s).redis' <<<"$body")" == connected ]] || die "/health: redis is not connected: $body"
  curl -fsS --max-time 20 -o /dev/null "$BASE_URL/health/browser" || die "/health/browser did not answer 200"
  say "health + browser readiness OK"
}

write() {
  local body id
  body="$(curl -fsS --max-time 15 -X POST "$BASE_URL/workflows/$USER_ID" \
    -H "x-api-key: $API_TOKEN" -H 'Content-Type: application/json' \
    --data '{"name":"ci-smoke","steps":[{"action":"goto","params":{"url":"https://example.com"}}]}')" \
    || die "saving a workflow failed (storage unavailable?)"
  id="$(json_field 'JSON.parse(s).workflow.id' <<<"$body")"
  [[ -n "$id" ]] || die "no workflow id in: $body"
  say "workflow saved: $id"
  printf '%s\n' "$id"
}

read_back() {
  local id="${1:?workflow id}" body
  body="$(curl -fsS --max-time 15 -H "x-api-key: $API_TOKEN" "$BASE_URL/workflows/$USER_ID/$id")" \
    || die "workflow $id could not be read back"
  [[ "$(json_field 'JSON.parse(s).workflow.name' <<<"$body")" == ci-smoke ]] || die "unexpected workflow: $body"
  say "workflow $id read back OK"
}

case "${1:-}" in
  probe) probe ;;
  write) probe; write ;;
  read) probe; read_back "${2:-}" ;;
  *) die "usage: $0 probe|write|read <id>" ;;
esac
