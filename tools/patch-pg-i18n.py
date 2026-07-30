#!/usr/bin/env python3
"""
Insert the palette ROW-NAME keys (`pg.*`) into BOTH dictionaries of
public/js/i18n.js.

Why a script and not a hand edit:

  * every key must exist in `fa` AND `en` (t() falls back fa -> en -> key, so an
    en-only key silently leaks English into the DEFAULT locale);
  * the Persian strings need ZWNJ (U+200C, نیم‌فاصله), which is INVISIBLE in a
    diff — it is written here as a `~` placeholder and substituted on the way
    out, so a reviewer can actually see where it goes;
  * public/** must stay LF-only, so the file is read and written with
    io.open(..., newline='') and explicit '\n' joins.

Idempotent: refuses to run if the keys are already present.

  python3 tools/patch-pg-i18n.py
"""
import io
import sys

PATH = 'public/js/i18n.js'
ZWNJ = '\u200c'

# The anchor is the LAST line of the `cat.*` block, which exists exactly twice
# (once per dictionary) — fa first, then en.
ANCHOR = "'cat.other':"

FA = [
    ("pg.triggers", "تریگرها"),
    ("pg.browser", "مرورگر"),
    ("pg.webInteraction", "تعامل وب"),
    ("pg.flowControl", "کنترل جریان"),
    ("pg.onlineServices", "سرویس~های آنلاین"),
    ("pg.data", "داده"),
]

EN = [
    ("pg.triggers", "Triggers"),
    ("pg.browser", "Browser"),
    ("pg.webInteraction", "Web Interaction"),
    ("pg.flowControl", "Flow Control"),
    ("pg.onlineServices", "Online Services"),
    ("pg.data", "Data"),
]

COMMENT = [
    "      // Palette ROW NAMES (G1). The locked `shell-add-node-palette.webp`",
    "      // groups blocks by product domain, not by catalog category id; the",
    "      // rows map 1:1 onto the six real categories and every count stays",
    "      // computed from real members, so only the wording changes.",
]


def block(pairs, indent='      '):
    out = list(COMMENT)
    for key, val in pairs:
        out.append("%s'%s': '%s'," % (indent, key, val.replace('~', ZWNJ)))
    return out


def main():
    with io.open(PATH, 'r', encoding='utf-8', newline='') as fh:
        text = fh.read()
    if 'pg.triggers' in text:
        sys.exit('pg.* keys already present — nothing to do (this script is one-shot).')
    if '\r' in text:
        sys.exit('CR found in %s — public/** must be LF only.' % PATH)

    lines = text.split('\n')
    hits = [i for i, ln in enumerate(lines) if ANCHOR in ln]
    if len(hits) != 2:
        sys.exit('expected the anchor %r exactly twice (fa, en), found %d' % (ANCHOR, len(hits)))

    # Insert from the BOTTOM up so the first index stays valid.
    fa_at, en_at = hits
    lines[en_at + 1:en_at + 1] = block(EN)
    lines[fa_at + 1:fa_at + 1] = block(FA)

    with io.open(PATH, 'w', encoding='utf-8', newline='') as fh:
        fh.write('\n'.join(lines))
    print('inserted %d fa + %d en keys' % (len(FA), len(EN)))


if __name__ == '__main__':
    main()
