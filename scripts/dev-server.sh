#!/usr/bin/env bash
# Legacy compatibility wrapper. The canonical lifecycle is ../plyr.
# Domain configuration remains centralized in scripts/ask-domain.sh.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/plyr" start --dev "$@"
