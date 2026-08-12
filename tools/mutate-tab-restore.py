#!/usr/bin/env python3
"""
mutate-tab-restore.py — prove tests/unit/chrome-tab-restore.test.ts is real.

The repo convention: a behaviour test only counts once a deliberate mutant of the
code it guards makes it FAIL. A test that passes against a broken implementation
is documentation, not a test.

Each mutant below is a plausible mistake a future editor could actually make —
the wrong restore constant, one of the two levers dropped, an unbounded wait,
"recycle to be safe" — not a random character swap.

SAFETY. This script edits tracked source files in place. It restores them in a
`finally`, on SIGTERM/SIGINT, and via atexit, because this sandbox has frozen
under repeated vitest runs and a half-applied mutant left on disk looks exactly
like a real bug in the next session. If a run is ever killed hard anyway:

    git checkout -- src/core/RealChrome.ts src/config.ts

Usage:
    python3 tools/mutate-tab-restore.py            # every mutant
    python3 tools/mutate-tab-restore.py 3 7        # only mutants 3 and 7 (1-based)
"""
import atexit
import os
import shutil
import signal
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src', 'core', 'RealChrome.ts')
CFG = os.path.join(ROOT, 'src', 'config.ts')
RTE = os.path.join(ROOT, 'src', 'Routes', 'browser.routes.ts')
TEST = 'tests/unit/chrome-tab-restore.test.ts'

# (label, file, find, replace)
MUTANTS = [
    ("restore constant 5 -> 1 (new tab page)",
     SRC,
     "const CONTINUE_WHERE_YOU_LEFT_OFF = 5;",
     "const CONTINUE_WHERE_YOU_LEFT_OFF = 1;"),

    ("drop the CLI flag, keep the pref (measured: 0 tabs)",
     SRC,
     "...(restoreTabs ? ['--restore-last-session'] : []),",
     ""),

    ("drop the pref, keep the flag (measured: 0 tabs)",
     SRC,
     "const restoreSaid = restoreTabs ? await enableSessionRestore(userDataDir) : 'disabled';",
     "const restoreSaid = 'disabled';"),

    ("gate the flag on a DIFFERENT setting than the pref",
     SRC,
     "...(restoreTabs ? ['--restore-last-session'] : []),",
     "...(config.REAL_CHROME_HEADLESS ? ['--restore-last-session'] : []),"),

    ("replace the whole session object instead of merging it",
     SRC,
     "const session = (prefs.session || {}) as Record<string, unknown>;",
     "const session = {} as Record<string, unknown>;"),

    # The first draft of this mutant edited only a declaration and changed no
    # behaviour, so it "survived" for a meaningless reason. A mutant must break
    # something real. Skipping the read turns the merge into a replace, which
    # wipes the user's passwords and extension settings.
    ("clobber the rest of Preferences (never read the file)",
     SRC,
     "    try {\n      prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));\n    } catch {",
     "    try {\n      prefs = {};\n    } catch {"),

    ("write directly instead of temp+rename",
     SRC,
     "    const tmp = `${prefsPath}.abtmp`;\n    await fs.writeFile(tmp, JSON.stringify(prefs), 'utf8');\n    await fs.rename(tmp, prefsPath);",
     "    await fs.writeFile(prefsPath, JSON.stringify(prefs), 'utf8');"),

    ("throw instead of reporting when the profile is unwritable",
     SRC,
     "  } catch (e) {\n    return `could not set (${(e as Error).message})`;\n  }\n}",
     "  } catch (e) {\n    throw e;\n  }\n}"),

    ("remove clearCrashedExitState (the innocent suspect)",
     SRC,
     "    await clearCrashedExitState(userDataDir);\n",
     ""),

    ("isResponsive trusts the reference, like isRunning did",
     SRC,
     "  static async isResponsive(timeoutMs = 2000): Promise<boolean> {\n    const ctx = this.context;\n    if (!ctx) return false;",
     "  static async isResponsive(timeoutMs = 2000): Promise<boolean> {\n    const ctx = this.context;\n    if (!ctx) return false;\n    return true;"),

    ("isResponsive waits forever (no timeout race)",
     SRC,
     "    return Promise.race([\n      probe.catch(() => false),\n      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),\n    ]);",
     "    return probe.catch(() => false);"),

    ("one hung tab condemns the whole browser (all instead of any)",
     SRC,
     "      return Promise.any(answers).then(() => true).catch(() => false);",
     "      return Promise.all(answers).then(() => true).catch(() => false);"),

    ("treat a page-less browser as wedged",
     SRC,
     "      if (pages.length === 0) return true;",
     "      if (pages.length === 0) return false;"),

    ("recycle even a healthy browser, 'to be safe'",
     SRC,
     "    if (await this.isResponsive(probeTimeoutMs)) {\n      return { action: 'none', reason: 'browser is responsive' };\n    }",
     ""),

    ("launch a browser as a side effect of the health check",
     SRC,
     "    if (!this.context) return { action: 'not-running', reason: 'no browser to check' };",
     "    if (!this.context) { await this.getContext(); return { action: 'not-running', reason: 'started one' }; }"),

    ("recycle starts before it stops",
     SRC,
     "    await this.stop();\n    await this.getContext();\n    return {\n      action: 'recycled',",
     "    const p = this.getContext();\n    await this.stop();\n    await p;\n    return {\n      action: 'recycled',"),

    ("stop() awaits close() unbounded again",
     SRC,
     "    await Promise.race([\n      ctx.close().catch(() => { /* already gone */ }),\n      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),\n    ]);",
     "    await ctx.close().catch(() => {});"),

    ("stop() clears the reference only after a successful close",
     SRC,
     "    const ctx = this.context;\n    this.context = null;\n    this.loaded = [];\n    this.debugInfo = { version: '', ws: '' };\n    if (!ctx) return;",
     "    const ctx = this.context;\n    this.loaded = [];\n    this.debugInfo = { version: '', ws: '' };\n    if (!ctx) return;\n    const clear = () => { this.context = null; };\n    setTimeout(clear, 60_000);"),

    ("tab restore defaults to off",
     CFG,
     "    (cleanEnv(process.env.REAL_CHROME_RESTORE_TABS)?.toLowerCase() ?? 'true') !== 'false',",
     "    cleanEnv(process.env.REAL_CHROME_RESTORE_TABS)?.toLowerCase() === 'true',"),

    # ── the route wiring: the dead end the operator actually hit ──────────
    ("open route reuses the context without checking it (the dead end)",
     RTE,
     "      const recovery = RealChrome.isRunning()\n        ? await RealChrome.recycleIfWedged()\n        : { action: 'not-running' as const, reason: 'cold start' };",
     "      const recovery = { action: 'not-running' as const, reason: 'skipped' };"),

    ("open route probes AFTER reusing the context (too late to help)",
     RTE,
     "      const recovery = RealChrome.isRunning()\n        ? await RealChrome.recycleIfWedged()\n        : { action: 'not-running' as const, reason: 'cold start' };\n\n      // The screen must exist before Chrome starts: extensions only load in a\n      // HEADED browser, and a headed browser needs an X display.\n      const ctx = await RealChrome.getContext();",
     "      const ctx = await RealChrome.getContext();\n      const recovery = RealChrome.isRunning()\n        ? await RealChrome.recycleIfWedged()\n        : { action: 'not-running' as const, reason: 'cold start' };"),

    ("open route probes even on a cold start (a slow, pointless round trip)",
     RTE,
     "      const recovery = RealChrome.isRunning()\n        ? await RealChrome.recycleIfWedged()\n        : { action: 'not-running' as const, reason: 'cold start' };",
     "      const recovery = await RealChrome.recycleIfWedged();"),

    ("recycling becomes silent again",
     RTE,
     "        recovered: recovery.action === 'recycled',",
     ""),

    ("health route collapses running and responsive into one field",
     RTE,
     "        responsive: await RealChrome.isResponsive(),",
     "        responsive: RealChrome.isRunning(),"),

    ("the recovery route disappears",
     RTE,
     "  router.post('/browser/real/recover', async (_req, res) => {",
     "  router.post('/browser/real/recover-disabled', async (_req, res) => {"),
]

_backups = {}


def _restore_all():
    """Put every touched file back. Safe to call more than once."""
    for path, bak in list(_backups.items()):
        try:
            if os.path.exists(bak):
                shutil.copy(bak, path)
                os.remove(bak)
        except OSError:
            pass
        _backups.pop(path, None)


atexit.register(_restore_all)
for _sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    try:
        signal.signal(_sig, lambda *_: (_restore_all(), sys.exit(130)))
    except (ValueError, OSError):
        pass


def run_tests():
    """One test file, one fork — the box has 985 MB and dies under more."""
    try:
        r = subprocess.run(
            ['npx', 'vitest', 'run', TEST, '--reporter=dot',
             '--pool=forks', '--poolOptions.forks.singleFork=true'],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        return r.returncode == 0, (r.stdout + r.stderr)
    except subprocess.TimeoutExpired:
        # A timeout is not a pass. Treating it as one would silently mark every
        # mutant "killed" the moment the machine got slow.
        return False, 'TIMEOUT'


def main():
    wanted = [int(a) for a in sys.argv[1:] if a.isdigit()]
    mutants = [MUTANTS[i - 1] for i in wanted] if wanted else MUTANTS

    ok, out = run_tests()
    if not ok:
        print('BASELINE IS RED — fix the tests before mutating.')
        print(out[-3000:])
        return 1
    print('baseline: green\n')

    for f in {m[1] for m in mutants}:
        bak = f + '.mutbak'
        shutil.copy(f, bak)
        _backups[f] = bak

    killed, survived = 0, []
    try:
        for n, (label, f, find, repl) in enumerate(mutants, 1):
            src = open(f, encoding='utf-8').read()
            if find not in src:
                # A pattern that no longer exists means the code moved on and
                # this mutant is testing nothing. That is a failure of the
                # mutation suite, so report it rather than quietly skipping.
                print(f'  STALE     {label}  [pattern not found]')
                survived.append(f'{label}  [PATTERN NOT FOUND]')
                continue
            open(f, 'w', encoding='utf-8').write(src.replace(find, repl, 1))

            passed, _ = run_tests()
            shutil.copy(_backups[f], f)   # restore before judging

            if passed:
                print(f'  SURVIVED  {label}')
                survived.append(label)
            else:
                print(f'  killed    {label}')
                killed += 1
    finally:
        _restore_all()

    total = len(mutants)
    print(f'\n=== {killed}/{total} mutants killed ===')
    if survived:
        print('SURVIVORS (each is a hole in the tests):')
        for s in survived:
            print(f'  - {s}')
        return 1

    ok, _ = run_tests()
    print('restored baseline:', 'green' if ok else 'RED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
