#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""One-shot inserter for the `help.timeoutMs` i18n key (G7 / NDV density pass).

The preview `docs/uiux/ndv-click-element-final.webp` puts a small info dot after
`Timeout (ms)` inside the Selector options group, so the string has to exist in
BOTH dictionaries (standing rule 0.6: no key in one dict only, and no English
value sitting in `fa`).

Conventions this repo enforces, and why this is a script rather than an edit:
  * `io.open(..., newline='')` so the file's existing line endings survive
    verbatim - `public/**` is pinned to LF with a CR count of 0.
  * Persian compounds need a ZWNJ (U+200C). It is written `~` in the literals
    below and substituted once, so the placeholder stays readable in the diff.
  * Idempotent: re-running it is a no-op.
"""
import io
import sys

PATH = 'public/js/i18n.js'
ZWNJ = '\u200c'

FA_ANCHOR = "      'help.ms': 'مدت انتظار به میلی~ثانیه (۱۰۰۰ = یک ثانیه).',\n".replace('~', ZWNJ)
FA_NEW = "      'help.timeoutMs': 'حداکثر زمان انتظار برای پیدا شدن عنصر، به میلی~ثانیه.',\n".replace('~', ZWNJ)

EN_ANCHOR = "      'help.ms': 'How long to wait, in milliseconds (1000 = one second).',\n"
EN_NEW = "      'help.timeoutMs': 'Longest time to wait for the element, in milliseconds.',\n"


def main():
    src = io.open(PATH, encoding='utf-8', newline='').read()
    if "'help.timeoutMs'" in src:
        print('already present - nothing to do')
        return 0
    for anchor, new in ((FA_ANCHOR, FA_NEW), (EN_ANCHOR, EN_NEW)):
        if src.count(anchor) != 1:
            print('anchor not found exactly once: %r' % anchor[:40])
            return 1
        src = src.replace(anchor, anchor + new)
    io.open(PATH, 'w', encoding='utf-8', newline='').write(src)
    print('inserted help.timeoutMs into both dictionaries')
    return 0


if __name__ == '__main__':
    sys.exit(main())
