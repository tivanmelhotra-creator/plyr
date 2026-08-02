#!/usr/bin/env python3
"""
Add the REAL CHROME configuration block to src/config.ts.

Why a script and not a plain edit: src/config.ts is stored with CRLF line
endings. Editing it with an LF-based tool silently rewrites every line in the
file and produces a diff nobody can review. This patcher works on the raw bytes,
inserts a CRLF block, and is idempotent so re-running it is a no-op.
"""
from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path(__file__).resolve().parents[1] / "src" / "config.ts"

ANCHOR = "  // ============================================\r\n  // Queue Settings\r\n"

BLOCK = """  // ============================================
  // Real Chrome  (extensions + remote access)
  // ============================================
  // The canvas "simulated browser" streams page pixels over CDP. That is enough
  // to pick a selector, but it can NEVER show a Chrome extension's toolbar
  // popup, because a popup is not part of the page. Users who rely on an
  // extension (a cookie import/export extension being the canonical case: export
  // once, import into a fresh profile, skip the login) need a genuine Chrome
  // with a genuine extension host.
  //
  // REAL_CHROME_ENABLED switches the interactive browser from a throwaway
  // BrowserContext to a PERSISTENT Chrome profile with extensions loaded. It is
  // opt-in because it costs a long-lived Chrome process and, on a headless box,
  // an X server.
  REAL_CHROME_ENABLED: cleanEnv(process.env.REAL_CHROME_ENABLED)?.toLowerCase() === 'true',

  // The persistent profile directory. This is what makes cookies imported by an
  // extension survive a restart and be visible to automation runs.
  REAL_CHROME_USER_DATA_DIR: path.resolve(
    cleanEnv(process.env.REAL_CHROME_USER_DATA_DIR) || './profiles/chrome-profile'
  ),

  // Unpacked extensions live here, one directory per extension, each containing
  // a manifest.json. Uploaded .zip/.crx files are unpacked into this directory.
  REAL_CHROME_EXTENSIONS_DIR: path.resolve(
    cleanEnv(process.env.REAL_CHROME_EXTENSIONS_DIR) || './profiles/extensions'
  ),

  // Extensions are only loaded by a HEADED Chrome. Playwright's bundled headless
  // shell has no extension host at all, so leaving this true on a server without
  // an X server is a launch failure, not a degraded mode. Run scripts/desktop.sh
  // (Xvfb) first, or point REAL_CHROME_DISPLAY at an existing display.
  REAL_CHROME_HEADLESS: cleanEnv(process.env.REAL_CHROME_HEADLESS)?.toLowerCase() === 'true',

  // X display for the headed Chrome. Ignored when a DISPLAY is already exported.
  REAL_CHROME_DISPLAY: cleanEnv(process.env.REAL_CHROME_DISPLAY) || ':99',

  // Chrome's own DevTools endpoint. This is the literal "expose the browser on a
  // port" request: with this on you can attach any CDP client, or open
  // chrome://inspect from your own Chrome and drive the remote one.
  REAL_CHROME_DEBUG_PORT: parseInt(cleanEnv(process.env.REAL_CHROME_DEBUG_PORT) || '0', 10),

  // 127.0.0.1 by default and deliberately so: an open DevTools port is remote
  // code execution and full cookie theft for anyone who can reach it. Set
  // 0.0.0.0 only behind a firewall/VPN or an authenticating reverse proxy.
  REAL_CHROME_DEBUG_BIND: cleanEnv(process.env.REAL_CHROME_DEBUG_BIND) || '127.0.0.1',

  // Window size of the real Chrome. The interactive viewport follows it.
  REAL_CHROME_WINDOW_WIDTH: parseInt(cleanEnv(process.env.REAL_CHROME_WINDOW_WIDTH) || '1280', 10),
  REAL_CHROME_WINDOW_HEIGHT: parseInt(cleanEnv(process.env.REAL_CHROME_WINDOW_HEIGHT) || '800', 10),

  // ============================================
  // Remote desktop (Xvfb + VNC + noVNC)
  // ============================================
  // Seeing the real Chrome — including extension popups, the extension toolbar
  // and native file dialogs — needs the X display itself, not a page screencast.
  // noVNC serves that display over HTTP so it opens in a normal browser tab.
  DESKTOP_ENABLED: cleanEnv(process.env.DESKTOP_ENABLED)?.toLowerCase() === 'true',
  DESKTOP_VNC_PORT: parseInt(cleanEnv(process.env.DESKTOP_VNC_PORT) || '5900', 10),
  DESKTOP_NOVNC_PORT: parseInt(cleanEnv(process.env.DESKTOP_NOVNC_PORT) || '6080', 10),
  // Empty means "no VNC password". Only acceptable when the port is bound to
  // localhost and reached through an SSH tunnel.
  DESKTOP_VNC_PASSWORD: cleanEnv(process.env.DESKTOP_VNC_PASSWORD) || '',
  DESKTOP_NOVNC_WEB_ROOT: cleanEnv(process.env.DESKTOP_NOVNC_WEB_ROOT) || '',

"""


def main() -> int:
    raw = TARGET.read_bytes().decode("utf8")

    if "REAL_CHROME_ENABLED" in raw:
        print("[patch-config-real-chrome] already applied, nothing to do")
        return 0

    if ANCHOR not in raw:
        print("[patch-config-real-chrome] ERROR: anchor not found", file=sys.stderr)
        return 1

    block = BLOCK.replace("\n", "\r\n")
    raw = raw.replace(ANCHOR, block + ANCHOR, 1)
    TARGET.write_bytes(raw.encode("utf8"))
    print("[patch-config-real-chrome] inserted REAL_CHROME + DESKTOP config block")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
