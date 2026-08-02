#!/usr/bin/env python3
"""
Route the INTERACTIVE browser through RealChrome when REAL_CHROME_ENABLED=true.

src/core/GlobalBrowser.ts is a CRLF file, so it is patched here on raw bytes
instead of through an LF-based editor that would rewrite every line.

Three edits, all idempotent:

  1. import RealChrome.
  2. getInteractiveContext()  -> hand back the shared persistent Chrome
     (extensions loaded, cookies on disk) instead of a throwaway context.
  3. saveAndCloseContext()/closeContext() -> never CLOSE the shared context.
     Closing it would kill the one Chrome window the user is looking at in the
     remote desktop, and take every other session with it.
"""
from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path(__file__).resolve().parents[1] / "src" / "core" / "GlobalBrowser.ts"

IMPORT_ANCHOR = (
    "import {\r\n"
    "  ANTI_AUTOMATION_ARGS,\r\n"
    "  interactiveContextOptions,\r\n"
    "  saveStorageState,\r\n"
    "} from './BrowserProfile';\r\n"
)
IMPORT_ADD = "import { RealChrome } from './RealChrome';\r\n"

# Inserted at the very TOP of getInteractiveContext, before the shared-browser
# health check: in real-Chrome mode the shared headless browser is not needed at
# all, and launching one just to throw it away wastes ~200MB per boot.
INTERACTIVE_ANCHOR = (
    "  static async getInteractiveContext(\r\n"
    "    userId: string,\r\n"
    "    viewport?: { width: number; height: number },\r\n"
    "  ): Promise<BrowserContext> {\r\n"
)

REAL_CHROME_BRANCH = """    // REAL CHROME MODE
    // ----------------
    // A throwaway context can never load an extension, so when the operator has
    // asked for real extensions we hand back the shared PERSISTENT Chrome
    // instead. Same profile as the remote desktop, which is the entire point:
    // cookies a user imports through their cookie extension are immediately the
    // cookies this picker — and every automation run — sees.
    if (RealChrome.isEnabled()) {
      return RealChrome.getContext();
    }

"""

SAVE_ANCHOR = """  static async saveAndCloseContext(context: BrowserContext, userId: string): Promise<boolean> {
    let saved = false;
    try { saved = await saveStorageState(context, userId); } catch { saved = false; }
    await this.closeContext(context);
    return saved;
  }
"""

SAVE_NEW = """  static async saveAndCloseContext(context: BrowserContext, userId: string): Promise<boolean> {
    let saved = false;
    try { saved = await saveStorageState(context, userId); } catch { saved = false; }
    // The shared real-Chrome context outlives every session that borrows it.
    // Closing it here would shut the browser the user is watching in the remote
    // desktop, and evict every other live session with it. Its state is already
    // durable in the on-disk profile, so there is nothing to close for.
    if (RealChrome.isSharedContext(context)) return saved;
    await this.closeContext(context);
    return saved;
  }
"""

CLOSE_ANCHOR = """  static async closeContext(context: BrowserContext): Promise<void> {
    try {
"""

CLOSE_NEW = """  static async closeContext(context: BrowserContext): Promise<void> {
    // Guard the shared persistent context here too: closeContext is called from
    // several places (GC, error paths) that have no idea the context is shared.
    if (RealChrome.isSharedContext(context)) return;
    try {
"""


def crlf(text: str) -> str:
    return text.replace("\n", "\r\n")


def main() -> int:
    raw = TARGET.read_bytes().decode("utf8")
    changed = False

    if "RealChrome" not in raw:
        if IMPORT_ANCHOR not in raw:
            print("[patch-globalbrowser] ERROR: import anchor not found", file=sys.stderr)
            return 1
        raw = raw.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_ADD, 1)
        changed = True

    if "RealChrome.isEnabled()" not in raw:
        if INTERACTIVE_ANCHOR not in raw:
            print("[patch-globalbrowser] ERROR: interactive anchor not found", file=sys.stderr)
            return 1
        raw = raw.replace(
            INTERACTIVE_ANCHOR, INTERACTIVE_ANCHOR + crlf(REAL_CHROME_BRANCH), 1
        )
        changed = True

    if "RealChrome.isSharedContext(context)) return saved" not in raw:
        anchor = crlf(SAVE_ANCHOR)
        if anchor not in raw:
            print("[patch-globalbrowser] ERROR: saveAndCloseContext anchor not found", file=sys.stderr)
            return 1
        raw = raw.replace(anchor, crlf(SAVE_NEW), 1)
        changed = True

    if "closeContext is called from" not in raw:
        anchor = crlf(CLOSE_ANCHOR)
        if anchor not in raw:
            print("[patch-globalbrowser] ERROR: closeContext anchor not found", file=sys.stderr)
            return 1
        raw = raw.replace(anchor, crlf(CLOSE_NEW), 1)
        changed = True

    if not changed:
        print("[patch-globalbrowser] already applied, nothing to do")
        return 0

    TARGET.write_bytes(raw.encode("utf8"))
    print("[patch-globalbrowser] wired GlobalBrowser to RealChrome")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
