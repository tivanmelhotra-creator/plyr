#!/usr/bin/env python3
"""Line-ending-preserving search/replace for this repo (mixed CRLF/LF, see R5).

usage: python3 tools/dev/rep.py FILE [--all] < spec
spec  = OLD \n@@@@\n NEW   (several blocks separated by \n%%%%\n)

Each OLD is matched in the file's CRLF form first, then LF, so a one-line edit
never rewrites a file's line endings. Fails loudly when OLD is missing or (without
--all) ambiguous.
"""
import sys
f = sys.argv[1]; allf = '--all' in sys.argv
spec = sys.stdin.read()
s = open(f, 'rb').read().decode('utf-8')
for blk in spec.split('\n%%%%\n'):
    o, n = blk.split('\n@@@@\n')
    if n.endswith('\n') and not o.endswith('\n'):
        n = n[:-1]
    ok = False
    for nl in ('\r\n', '\n'):
        oo = o.replace('\n', nl); nn = n.replace('\n', nl)
        c = s.count(oo)
        if c == 0:
            continue
        if c > 1 and not allf:
            sys.exit(f'AMBIGUOUS({c}) {f}: {o[:60]!r}')
        s = s.replace(oo, nn) if allf else s.replace(oo, nn, 1); ok = True; break
    if not ok:
        sys.exit(f'NOT FOUND {f}: {o[:80]!r}')
open(f, 'wb').write(s.encode('utf-8')); print('ok', f)
