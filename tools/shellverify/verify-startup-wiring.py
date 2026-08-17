#!/usr/bin/env python3
"""
tools/shellverify/verify-startup-wiring.py — proves the domain prompt is
actually REACHED by each startup script, in the right order.

verify-domain-prompt.py tests the helper. That is not the same as testing that
dev.sh and scripts/dev-server.sh reach it: a perfectly correct helper wired in
after the server has already been launched, or placed after an early `exit`,
would pass every helper test and still never ask the operator anything useful.

So each script is executed for real in a pty and stopped the moment the question
appears. Stub binaries are placed ahead of the real ones on PATH so `npm`,
`node`, `redis-server` and friends are no-ops -- the goal is to walk the script's
own control flow to the prompt without booting a stack.

Two ordering claims are asserted, not merely "a prompt appeared":

  1. The prompt must come BEFORE anything boots the server. Asking afterwards is
     useless: the port is already bound and the value is read at boot, so it
     would not take effect until the next restart, with nothing saying so.

  2. For dev.sh, a .env must already exist when it asks. dev.sh owns .env
     creation (section ۲) and the prompt is section ۲.۵; the helper deliberately
     refuses to create the file, so reversing that order would silently discard
     the operator's answer. (dev-server.sh restarts an installed stack and does
     not create .env, so it is seeded here instead -- matching real use.)

THREE HARNESS BUGS WORTH REMEMBERING
------------------------------------
1. `sudo` must be stubbed too, and stubbing it naively is not enough: real sudo
   resets PATH to secure_path, so every other stub is bypassed and
   `sudo npx playwright install-deps` runs for real. The first version of this
   harness did that, took 78 seconds, and timed out before dev.sh ever reached
   the prompt -- which is indistinguishable from a missing prompt.

2. calls.log must be snapshotted AT the prompt, before answering. Reading it
   afterwards shows everything the script goes on to do once unblocked, so
   "the server had not started yet" would always be false.

3. dev-server.sh does not create .env. Asserting that it does was an assumption
   about the script rather than an observation of it.

Usage:
    python3 tools/shellverify/verify-startup-wiring.py
Exit code 0 only if every check passed.
"""

import io
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
results = []

PROMPT = re.compile(r"custom domain\?\s*\(y/N\):")

# Anything that would boot a stack, block, or take minutes.
STUBS = ["npm", "node", "npx", "redis-server", "redis-cli", "docker", "docker-compose",
         "systemctl", "pm2", "caddy", "tsc", "curl", "nc", "lsof", "pkill", "sleep",
         "Xvfb", "ss", "setsid", "service", "apt-get"]


def chk(name, got, want):
    ok = got == want
    results.append(ok)
    print(("  ok   " if ok else "  FAIL ") + name
          + ("" if ok else f"\n         got [{got}] want [{want}]"))


def make_sandbox():
    """A throwaway copy of the repo's scripts, with stub binaries on PATH."""
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "scripts"), exist_ok=True)
    os.makedirs(os.path.join(d, "bin"), exist_ok=True)
    shutil.copy(os.path.join(REPO, "dev.sh"), os.path.join(d, "dev.sh"))
    os.chmod(os.path.join(d, "dev.sh"), 0o755)
    for f in ("ask-domain.sh", "dev-server.sh"):
        src = os.path.join(REPO, "scripts", f)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(d, "scripts", f))
            os.chmod(os.path.join(d, "scripts", f), 0o755)
    shutil.copy(os.path.join(REPO, ".env.example"), os.path.join(d, ".env.example"))
    shutil.copy(os.path.join(REPO, "package.json"), os.path.join(d, "package.json"))
    # dev.sh skips `npm install` when node_modules exists; an empty dir is enough.
    os.makedirs(os.path.join(d, "node_modules"), exist_ok=True)

    for name in STUBS:
        p = os.path.join(d, "bin", name)
        with io.open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("#!/usr/bin/env bash\n"
                     f'echo "STUB:{name} $*" >> "$SANDBOX/calls.log"\n'
                     "exit 0\n")
        os.chmod(p, 0o755)

    # See harness bug #1 in the module docstring: sudo resets PATH, so it must
    # re-exec the command with ours rather than the system one.
    sudo = os.path.join(d, "bin", "sudo")
    with io.open(sudo, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("#!/usr/bin/env bash\n"
                 'echo "STUB:sudo $*" >> "$SANDBOX/calls.log"\n'
                 'while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done\n'
                 '[ $# -eq 0 ] && exit 0\n'
                 'exec "$@"\n')
    os.chmod(sudo, 0o755)
    return d


def run_until_prompt(script_argv, seed_env=False, timeout=90, answer=None):
    """Run a startup script in a pty; stop at the prompt.

    If `answer` is (reply, domain), the prompt is answered and the resulting
    .env read back -- which together with the at-prompt snapshot establishes
    that the value is persisted before anything boots.
    """
    d = make_sandbox()
    try:
        if seed_env:
            shutil.copy(os.path.join(REPO, ".env.example"), os.path.join(d, ".env"))

        environ = dict(os.environ)
        # Inherited values would suppress the prompt and void the case.
        for k in ("PUBLIC_DOMAIN", "BASE_URL", "AB_NO_PROMPT"):
            environ.pop(k, None)
        environ["SANDBOX"] = d
        environ["PATH"] = os.path.join(d, "bin") + os.pathsep + environ.get("PATH", "")

        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(d)
            os.execvpe("bash", ["bash"] + script_argv, environ)

        transcript = ""
        reached = False
        deadline = time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.4)
            if r:
                try:
                    chunk = os.read(fd, 4096).decode("utf-8", "replace")
                except OSError:
                    break
                if not chunk:
                    break
                transcript += chunk
            if PROMPT.search(transcript):
                reached = True
                break

        # Snapshot the world AT THE PROMPT (harness bug #2).
        calls_path = os.path.join(d, "calls.log")
        calls_at_prompt = (io.open(calls_path, encoding="utf-8").read()
                           if os.path.exists(calls_path) else "")
        env_at_prompt = os.path.exists(os.path.join(d, ".env"))

        stored = None
        if reached and answer is not None:
            reply, domain = answer
            os.write(fd, (reply + "\n").encode())
            time.sleep(0.3)
            if domain is not None:
                d2 = time.time() + 10
                while time.time() < d2 and not re.search(r"Enter your domain", transcript):
                    r, _, _ = select.select([fd], [], [], 0.3)
                    if r:
                        try:
                            transcript += os.read(fd, 4096).decode("utf-8", "replace")
                        except OSError:
                            break
                os.write(fd, (domain + "\n").encode())
                time.sleep(0.6)
            env_path = os.path.join(d, ".env")
            if os.path.exists(env_path):
                for l in io.open(env_path, encoding="utf-8", newline="").read().split("\n"):
                    if re.match(r"^\s*PUBLIC_DOMAIN=", l):
                        stored = l.strip().replace("\r", "")

        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass

        return {
            "reached": reached,
            "transcript": transcript,
            "calls": calls_at_prompt,
            "env_existed_at_prompt": env_at_prompt,
            "stored": stored,
        }
    finally:
        shutil.rmtree(d, ignore_errors=True)


def started_server(calls):
    """Did anything that boots the app get invoked?"""
    return bool(re.search(r"STUB:(npm (run )?(dev|start|build)|node .*index|pm2 |setsid )", calls))


print("== dev.sh ==")
r = run_until_prompt(["dev.sh"])
chk("dev.sh asks for a domain", r["reached"], True)
chk("it asks BEFORE anything boots the server", started_server(r["calls"]), False)
chk("a .env exists by the time it asks", r["env_existed_at_prompt"], True)
r = run_until_prompt(["dev.sh"], answer=("y", "https://dev-sh.example.com"))
chk("dev.sh persists the answer", r["stored"], "PUBLIC_DOMAIN=https://dev-sh.example.com")

print("\n== scripts/dev-server.sh ==")
r2 = run_until_prompt(["scripts/dev-server.sh"], seed_env=True)
chk("dev-server.sh asks for a domain", r2["reached"], True)
chk("it asks BEFORE anything boots the server", started_server(r2["calls"]), False)
r2 = run_until_prompt(["scripts/dev-server.sh"], seed_env=True,
                      answer=("y", "https://dev-server.example.com"))
chk("dev-server.sh persists the answer", r2["stored"],
    "PUBLIC_DOMAIN=https://dev-server.example.com")

print("\n== non-interactive startup must not stall ==")
# A startup script that blocks on a prompt under nohup or CI hangs a deployment,
# which is a worse failure than never asking at all.
for script in ("dev.sh", "scripts/dev-server.sh"):
    d = make_sandbox()
    try:
        shutil.copy(os.path.join(REPO, ".env.example"), os.path.join(d, ".env"))
        environ = dict(os.environ)
        for k in ("PUBLIC_DOMAIN", "BASE_URL", "AB_NO_PROMPT"):
            environ.pop(k, None)
        environ["SANDBOX"] = d
        environ["PATH"] = os.path.join(d, "bin") + os.pathsep + environ.get("PATH", "")
        try:
            p = subprocess.run(["bash", script], cwd=d, env=environ,
                               stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=60)
            out = p.stdout + p.stderr
            stalled = False
        except subprocess.TimeoutExpired as e:
            out = ""
            if isinstance(getattr(e, "stdout", None), (bytes, str)):
                out = e.stdout.decode() if isinstance(e.stdout, bytes) else e.stdout
            stalled = True
        chk(f"{script} does not stall without a TTY", stalled, False)
        chk(f"{script} prints no unanswerable prompt", bool(PROMPT.search(out)), False)
    finally:
        shutil.rmtree(d, ignore_errors=True)

print(f"\n{'PASS' if all(results) else 'FAIL'} — {sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
