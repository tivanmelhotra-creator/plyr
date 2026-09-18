#!/usr/bin/env bash
# Legacy compatibility wrapper. The canonical lifecycle lives in ./plyr.
# Domain configuration remains centralized in scripts/ask-domain.sh via the manager.
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT_DIR/plyr" install-and-start-dev "$@"
