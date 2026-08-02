#!/usr/bin/env python3
"""
Mount the real-Chrome router (src/Routes/browser.routes.ts).

Both src/Routes/index.ts and src/index.ts are CRLF, hence a byte-level patcher.
Idempotent.

Auth note: /browser/* is put behind the SAME asyncAuthMiddleware + blockCheck as
/run and /workflows. These endpoints import cookies into a profile and can hand
back an exported session, so they are at least as sensitive as running a job.
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROUTES_INDEX = ROOT / "src" / "Routes" / "index.ts"
APP_INDEX = ROOT / "src" / "index.ts"


def crlf(text: str) -> str:
    return text.replace("\n", "\r\n")


def patch_routes_index() -> bool:
    raw = ROUTES_INDEX.read_bytes().decode("utf8")
    if "createBrowserRoutes" in raw:
        return False

    raw = raw.replace(
        "import { createAdminRoutes } from './admin.routes';\r\n",
        "import { createAdminRoutes } from './admin.routes';\r\n"
        "import { createBrowserRoutes } from './browser.routes';\r\n",
        1,
    )
    raw = raw.replace(
        crlf("""    admin: createAdminRoutes({
"""),
        crlf("""    // Real Chrome / extensions / cookies / remote desktop. No deps: it talks
    // to process-level singletons (RealChrome, Desktop) rather than to Redis.
    browser: createBrowserRoutes(),
    admin: createAdminRoutes({
"""),
        1,
    )
    raw = raw.replace(
        "export { createAdminRoutes } from './admin.routes';",
        "export { createAdminRoutes } from './admin.routes';\r\n"
        "export { createBrowserRoutes } from './browser.routes';",
        1,
    )
    ROUTES_INDEX.write_bytes(raw.encode("utf8"))
    return True


def patch_app_index() -> bool:
    raw = APP_INDEX.read_bytes().decode("utf8")
    if "routes.browser" in raw:
        return False

    # 1. auth + block guards, alongside the other protected prefixes
    raw = raw.replace(
        "app.use('/workspace', asyncAuthMiddleware);\r\n",
        "app.use('/workspace', asyncAuthMiddleware);\r\n"
        "app.use('/browser', asyncAuthMiddleware);\r\n",
        1,
    )
    raw = raw.replace(
        "app.use('/workspace', blockCheck);\r\n",
        "app.use('/workspace', blockCheck);\r\n"
        "app.use('/browser', blockCheck);\r\n",
        1,
    )

    # 2. mount the router
    raw = raw.replace(
        "app.use('/admin', routes.admin);\r\n",
        "app.use('/', routes.browser);\r\n"
        "app.use('/admin', routes.admin);\r\n",
        1,
    )

    APP_INDEX.write_bytes(raw.encode("utf8"))
    return True


def main() -> int:
    changed = False
    try:
        changed |= patch_routes_index()
        changed |= patch_app_index()
    except Exception as e:  # noqa: BLE001
        print(f"[patch-wire-browser-routes] ERROR: {e}", file=sys.stderr)
        return 1

    print(
        "[patch-wire-browser-routes] mounted /browser/*"
        if changed else
        "[patch-wire-browser-routes] already applied, nothing to do"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
