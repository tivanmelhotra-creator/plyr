#!/usr/bin/env python3
"""
check-references.py - broken-reference guard for docs, comments and scripts.

WHY THIS EXISTS
---------------
A documentation cleanup once deleted three handoff files and left roughly two
dozen dangling citations behind, in Markdown *and* in source comments, test
headers and probe tools. Nothing failed, so nobody noticed. This script makes
that class of rot mechanically detectable.

WHAT IT DOES
------------
Walks every tracked text file and collects two kinds of reference:

  1. Markdown links            [text](target)
  2. Bare path-ish tokens      docs/FOO.md, tools/probe-x.js, src/core/Y.ts

Each target is resolved relative to the containing file and then to the repo
root. Anything that resolves is fine. Anything that does not is reported.

Paths staged for deletion count as ABSENT, so a reference is caught in the same
commit that removes its target rather than after the fact.

It is tolerant of git's octal-quoting of non-ASCII filenames (surrogateescape),
so entries such as `extension/UI_UX/Element Inspector - ....md` do not abort it.

EXIT CODE
---------
0 when every unresolved target is covered by ALLOWED below, 1 otherwise. So it
is usable as a CI step:

    python3 tools/docverify/check-references.py

Use --list to print every unresolved target including the allowed ones.

ALLOWED entries are NOT "ignore this" - each one is a path that legitimately
does not exist at rest, with the reason recorded next to it.
"""

import os
import re
import subprocess
import sys
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

# This script's own path, relative to ROOT, so it can exclude itself.
SELF_REL = os.path.relpath(os.path.abspath(__file__), ROOT).replace(os.sep, "/")


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT, stdout=subprocess.PIPE, check=True,
    ).stdout
    names = out.decode("utf-8", "surrogateescape").split("\0")
    return [n for n in names if n]


def deleted_files():
    """Paths staged for deletion - they must be treated as absent."""
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=D", "-z"],
        cwd=ROOT, stdout=subprocess.PIPE, check=True,
    ).stdout
    names = out.decode("utf-8", "surrogateescape").split("\0")
    return {n for n in names if n}


SCAN_EXT = {
    ".md", ".ts", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml",
    ".sh", ".py", ".cmd", ".html", ".css", ".example",
}

SKIP_DIRS = ("node_modules/", "dist/", ".git/")

MD_LINK = re.compile(r"\[[^\]]*\]\(\s*([^)\s]+?)\s*\)")
# bare token: at least one '/' and a known source/doc extension.
# NOTE longer extensions first so '.json' is not truncated to '.js'.
BARE = re.compile(
    r"(?<![\w/.\-])"
    r"((?:\.{1,2}/)?(?:[\w.\-]+/)+[\w.\-]+"
    r"\.(?:md|mjs|cjs|json|yaml|yml|html|css|svg|ts|js|sh|py|cmd))(?![\w])"
)
# root-level docs referenced without a directory, e.g. PLAN.md, README.md
ROOT_DOC = re.compile(r"(?<![\w/.\-])([A-Z][A-Z0-9_\-]*\.md)(?![\w])")

URLISH = re.compile(r"^(https?:|mailto:|data:|//|#|\?)")


def is_urlish(t):
    return bool(URLISH.match(t))


# ---------------------------------------------------------------------------
# ALLOWED - targets that do not resolve at rest, each for a recorded reason.
#
# This is an evidence list, not a mute button. Anything added here must have a
# reason that survives review; anything NOT here and unresolved fails the run.
# ---------------------------------------------------------------------------
ALLOWED = {
    # -- paths INSIDE the Chrome extension, written relative to extension/ or
    #    to the built artifacts/element-inspector-extension/ root. They are
    #    manifest-relative by definition (MV3 resolves them that way), and
    #    tests/unit/extension-artifact.test.ts proves each one ships.
    "content/inspector.js", "content/presence.js", "content/recorder.js",
    "content/selector.js", "content/consent.js",
    "lib/ab-core.js", "lib/ab-handoff.js", "lib/ab-inspect.js",
    "../lib/ab-core.js",
    "popup/popup.html", "popup/popup.js", "popup/popup.css",
    "ui/popup.html",
    "_locales/en/messages.json",
    "./artifacts/element-inspector-extension/manifest.json",
    # INSTALL.md is GENERATED into the artifact by scripts/build-extension.js
    # (see the INSTALL_MD constant); it is intentionally not a repo file.
    "INSTALL.md",

    # -- build output. dist/ is produced by `tsc` and is .gitignore'd.
    "dist/index.js", "./dist/index.js", "dist/config.js", "dist/cli/doctor.js",

    # -- third-party bin stubs quoted inside package-lock.json
    "dist/esm/bin.mjs", "dist/cli.mjs", "bin/download-prebuilds.js",
    "bin/nanoid.cjs", "bin/semver.js", "bin/vite.js",

    # -- TypeScript module specifiers / src-relative prose. These resolve from
    #    inside src/, e.g. src/core/BrowserRuntime.ts says "core/RuntimeSettings".
    "core/RuntimeSettings.ts", "core/ConditionEngine.ts",
    "middleware/auth.ts", "services/workflow.service.ts",
    "Routes/user.routes.ts", "cli/doctor.ts",

    # -- noVNC assets served by DesktopProxy from the novnc package at runtime,
    #    never checked in here.
    "core/rfb.js", "./core/rfb.js",

    # -- URL fragments the regex sees as paths: "localhost:8788/index.html",
    #    "localhost:6080/vnc.html".
    "8788/index.html", "6080/vnc.html",

    # -- shell/CI variable expansions, not literals
    "TMP_DIR/plyr/install.sh",       # "$TMP_DIR/plyr/install.sh" in install.sh
    "DIR/bootstrap.config.js",       # "$DIR/bootstrap.config.js" in ci.yml

    # -- regex source text captured by the link/bare patterns
    "[^'\"]+", "[^\"']+", "ho\\.[A-Za-z0-9_]+", "snap",

    # -- deliberate test fixtures: path-traversal and arbitrary-path inputs that
    #    MUST NOT exist for the security assertions to mean anything.
    "../../etc/evil.json", "a/b/c.json",
    "my-ext/manifest.json", "my-extension/manifest.json",

    # -- Automa's own source file, named as the parity reference (external repo)
    "utils/shared.js",

    # -- PROJECT.md's directory listing prints bare filenames under a "docs/"
    #    heading; they are prose, and the same docs are properly linked in the
    #    Related-documentation table.
    "API.md", "COOLIFY.md", "END_TO_END_GUIDE.md", "MEASURED-DECISIONS.md",
}


def main():
    gone = deleted_files()
    files = tracked_files()
    present = set(files) - gone

    def exists(rel):
        if rel in gone:
            return False
        if rel in present:
            return True
        return os.path.exists(os.path.join(ROOT, rel))

    broken = defaultdict(list)
    scanned = 0

    for rel in files:
        if rel in gone:
            continue
        # Skip this file. Its docstring documents the patterns it looks for and
        # ALLOWED quotes the very paths that are meant not to resolve, so
        # scanning itself would report its own documentation as broken.
        if rel == SELF_REL:
            continue
        if any(rel.startswith(d) or ("/" + d) in rel for d in SKIP_DIRS):
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext not in SCAN_EXT and os.path.basename(rel) != ".env.example":
            continue
        path = os.path.join(ROOT, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="surrogateescape") as fh:
                lines = fh.read().splitlines()
        except (OSError, UnicodeError):
            continue
        scanned += 1
        d = os.path.dirname(rel)

        for i, line in enumerate(lines, 1):
            cands = []
            for m in MD_LINK.finditer(line):
                cands.append((m.group(1), "link"))
            for m in BARE.finditer(line):
                cands.append((m.group(1), "bare"))
            for m in ROOT_DOC.finditer(line):
                cands.append((m.group(1), "rootdoc"))

            for target, kind in cands:
                if is_urlish(target) or target.startswith("@"):
                    continue
                t = target.split("#", 1)[0].split("?", 1)[0]
                if not t or t.startswith("/"):
                    continue
                if kind == "rootdoc":
                    candidates = [t, os.path.normpath(os.path.join(d, t))]
                else:
                    candidates = [os.path.normpath(os.path.join(d, t)), t]
                if any(exists(c) for c in candidates):
                    continue
                broken[t].append((rel, i, kind))

    show_all = "--list" in sys.argv
    offenders = {t: r for t, r in broken.items() if t not in ALLOWED}

    print("scanned files:        %d" % scanned)
    print("unresolved targets:   %d  (%d allowed, %d unexplained)"
          % (len(broken), len(broken) - len(offenders), len(offenders)))
    print()

    to_print = broken if show_all else offenders
    for target in sorted(to_print, key=lambda k: (-len(to_print[k]), k)):
        refs = to_print[target]
        tag = "  [ALLOWED]" if target in ALLOWED else ""
        print("%-56s  %d ref(s)%s" % (target, len(refs), tag))
        for rel, ln, kind in refs:
            print("        %s:%d  [%s]" % (rel, ln, kind))

    if offenders:
        print("\nFAIL - %d unexplained broken reference target(s)." % len(offenders))
        print("Fix the citation, or add the path to ALLOWED with a reason.")
        return 1

    print("PASS - every reference resolves, or is an explained exception.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
