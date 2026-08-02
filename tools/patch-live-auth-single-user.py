#!/usr/bin/env python3
"""Patch src/core/LiveServer.ts: teach authorizeLive() the single-user mode.

WHY: the HTTP middleware (src/middleware/auth.ts) has an explicit
`config.IS_SINGLE_USER` branch that accepts the one shared API_TOKEN and
resolves it to the fixed identity `local`. `authorizeLive()` — which guards
BOTH WebSocket channels (`/live/ws` and `/browser/ws`) — never learned about
it, so on the DEFAULT self-hosted deployment (DEPLOYMENT_MODE=single) every
upgrade was answered with 403: the Live Browser View never streamed a frame
and the live run channel never opened.

The file is CRLF; this patcher keeps it that way.
"""
import io
import re
import sys
import pathlib

p = pathlib.Path(__file__).resolve().parents[1] / 'src' / 'core' / 'LiveServer.ts'
src = p.read_bytes().decode('utf-8')

if 'IS_SINGLE_USER' in src:
    print('already patched')
    sys.exit(0)

anchor = (
    "  // If auth is globally disabled, allow (dev/self-hosted convenience).\r\n"
    "  if (!config.API_KEYS_ENABLED) {\r\n"
    "    return { ok: true };\r\n"
    "  }\r\n"
)
if anchor not in src:
    print('ANCHOR NOT FOUND', file=sys.stderr)
    sys.exit(1)

addition = anchor + (
    "  // ============================================================\r\n"
    "  // Single-user self-hosted mode (DEPLOYMENT_MODE=single, the DEFAULT).\r\n"
    "  // ------------------------------------------------------------\r\n"
    "  // One shared API_TOKEN authenticates the whole instance and resolves to\r\n"
    "  // the fixed identity `local` (see middleware/auth.ts § SINGLE-USER MODE).\r\n"
    "  // There is no Redis key record for it and it is NOT in config.API_KEYS,\r\n"
    "  // so the multi-tenant path below rejected it with `invalid_api_key` and\r\n"
    "  // the upgrade was answered 403 — which killed BOTH WebSocket channels on\r\n"
    "  // the default deployment: /browser/ws (Live Browser View + the Element\r\n"
    "  // Picker: no frames, no navigation) and /live/ws (live run events).\r\n"
    "  // The token is instance-wide, so any userId it asks for is its own.\r\n"
    "  if (config.IS_SINGLE_USER) {\r\n"
    "    if (apiKey && config.API_TOKEN && apiKey === config.API_TOKEN) {\r\n"
    "      return { ok: true };\r\n"
    "    }\r\n"
    "    return { ok: false, reason: apiKey ? 'invalid_api_key' : 'missing_api_key' };\r\n"
    "  }\r\n"
)

src = src.replace(anchor, addition, 1)
p.write_bytes(src.encode('utf-8'))
print('patched', p)
