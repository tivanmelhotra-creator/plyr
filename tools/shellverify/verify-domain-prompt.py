#!/usr/bin/env python3
"""
tools/shellverify/verify-domain-prompt.py — behavioural verification of the
optional PUBLIC_DOMAIN prompt used by every startup path.

WHAT IT COVERS
--------------
Task 2 of the spec asks that dev.sh, scripts/dev-server.sh and install.sh all
offer to record a custom domain. Three of those share scripts/ask-domain.sh;
install.sh has its own persist_public_domain(). Both writers are exercised here,
against real .env files, by extracting the real functions from the real scripts
rather than reimplementing them -- so this cannot pass against a stale copy.

WHY A PTY, NOT A PIPE
---------------------
ask_public_domain() deliberately refuses to prompt unless stdin AND stdout are
terminals (`_domain_can_prompt`), because these scripts also run under CI,
Docker entrypoints and nohup, where `read` returns instantly at EOF -- printing
a question nobody sees and then silently taking the empty answer.

A test that pipes stdin therefore never enters the prompt at all. The first
version of this harness did exactly that: it reported six green checks for
"declining leaves the file alone" and "nonsense is rejected" while the function
had returned at line 115 every time. Those passes were vacuous -- they would
have stayed green even if the validation were deleted. Everything below runs
through pty.fork(), and the first check asserts that both questions were
actually asked, so the suite fails loudly if it ever stops reaching the code.

THE BUG THIS SUITE EXISTS FOR
-----------------------------
Every neighbouring installer question is a y/N, so "y" is a very common answer
to "Enter your domain". Storing PUBLIC_DOMAIN=y is worse than storing nothing:
the panel would advertise "https://y" beside the Authorization Code, the
Extension could never reach it, and nothing on screen would explain why. Both
writers refuse such values, and the refusals are asserted here.

NOTE ON AN EQUIVALENT MUTANT
----------------------------
Deleting the y/n arm of the first guard in _domain_write does NOT break the
"is refused" checks, because every value it catches is also dotless and the
second guard rejects it anyway. What the arm uniquely provides is the MESSAGE
-- naming the y/N confusion instead of complaining about a missing dot. So the
message is asserted too; otherwise the arm's actual purpose is untested.

Usage:
    python3 tools/shellverify/verify-domain-prompt.py
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


def chk(name, got, want):
    ok = got == want
    results.append(ok)
    print(("  ok   " if ok else "  FAIL ") + name
          + ("" if ok else f"\n         got [{got}] want [{want}]"))


def _public_domain_line(env_path):
    """The effective PUBLIC_DOMAIN line, or None if the file has none."""
    if not os.path.exists(env_path):
        return None
    line = None
    for l in io.open(env_path, encoding="utf-8", newline="").read().split("\n"):
        if re.match(r"^\s*PUBLIC_DOMAIN=", l):
            line = l.strip().replace("\r", "")
    return line


def run_case(answers, seed_env=True, env=None, extra_env_lines=""):
    """Drive ask_public_domain in a pty, answering each prompt in turn.

    Returns (transcript, effective PUBLIC_DOMAIN line, prompts_answered).
    """
    d = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(d, "scripts"), exist_ok=True)
        shutil.copy(os.path.join(REPO, "scripts", "ask-domain.sh"),
                    os.path.join(d, "scripts", "ask-domain.sh"))
        if seed_env:
            shutil.copy(os.path.join(REPO, ".env.example"), os.path.join(d, ".env"))
            if extra_env_lines:
                with io.open(os.path.join(d, ".env"), "a", encoding="utf-8", newline="") as fh:
                    fh.write(extra_env_lines)

        environ = dict(os.environ)
        # Inherited values would suppress the prompt and quietly void the case.
        for k in ("PUBLIC_DOMAIN", "BASE_URL", "AB_NO_PROMPT"):
            environ.pop(k, None)
        if env:
            environ.update(env)

        pid, fd = pty.fork()
        if pid == 0:  # child
            os.chdir(d)
            os.execvpe("bash", ["bash", "-c",
                                ". scripts/ask-domain.sh && ask_public_domain; echo __DONE__"],
                       environ)

        # Answer on prompt TEXT, not on a timer: matching the two distinct
        # questions proves they were asked, and in order.
        want = [re.compile(r"custom domain\?\s*\(y/N\):"),
                re.compile(r"Enter your domain[^:]*:")]
        transcript, pending, seen = "", list(answers), 0
        deadline = time.time() + 20
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
            if "__DONE__" in transcript:
                break
            if seen < len(want) and pending and want[seen].search(transcript):
                os.write(fd, (pending.pop(0) + "\n").encode())
                seen += 1
                time.sleep(0.2)
        try:
            os.close(fd)
        except OSError:
            pass
        os.waitpid(pid, 0)
        return transcript, _public_domain_line(os.path.join(d, ".env")), seen
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _extract(script, names):
    """Pull real function bodies out of a shell script."""
    src = io.open(os.path.join(REPO, script), encoding="utf-8", newline="").read()
    out = []
    for fn in names:
        m = re.search(r"^" + fn + r"\(\) \{.*?^\}", src, re.S | re.M)
        assert m, f"could not extract {fn} from {script}"
        out.append(m.group(0))
    return out


def install_case(domain, seed=".env.example", pre_lines=""):
    """Call install.sh's own persist_public_domain() in isolation."""
    d = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(d, "scripts"), exist_ok=True)
        shutil.copy(os.path.join(REPO, "scripts", "ask-domain.sh"),
                    os.path.join(d, "scripts", "ask-domain.sh"))
        if seed:
            shutil.copy(os.path.join(REPO, seed), os.path.join(d, ".env"))
        if pre_lines:
            with io.open(os.path.join(d, ".env"), "a", encoding="utf-8", newline="") as fh:
                fh.write(pre_lines)
        stub = ("warn(){ printf '  warn: %s\\n' \"$*\"; }\n"
                "ok(){ printf '  ok: %s\\n' \"$*\"; }\n"
                "info(){ printf '  info: %s\\n' \"$*\"; }\n")
        body = "\n".join(_extract("install.sh",
                                  ["sed_inplace", "persist_public_domain", "domain_to_url"]))
        p = subprocess.run(["bash", "-c", stub + body + f'\npersist_public_domain "{domain}"\n'],
                           cwd=d, capture_output=True, text=True)
        return p.stdout + p.stderr, _public_domain_line(os.path.join(d, ".env"))
    finally:
        shutil.rmtree(d, ignore_errors=True)


def to_url(value):
    body = _extract("install.sh", ["domain_to_url"])[0]
    p = subprocess.run(["bash", "-c", body + f'\ndomain_to_url "{value}"'],
                       capture_output=True, text=True)
    return p.stdout.strip()


# ---------------------------------------------------------------------------

print("== the prompt is actually reached (guards against a vacuous suite) ==")
t, line, seen = run_case(["y", "https://panel.acme.io"])
chk("both questions were asked", seen, 2)
chk("the wording is exactly what the spec asked for",
    bool(re.search(r"Do you want to set a custom domain\?\s*\(y/N\):", t)), True)
chk("the second prompt matches the spec too",
    bool(re.search(r"Enter your domain \(e\.g\. https://my-domain\.com\):", t)), True)
chk("y + a real domain is stored", line, "PUBLIC_DOMAIN=https://panel.acme.io")

print("\n== values that should be accepted ==")
chk("a bare host is stored verbatim", run_case(["y", "panel.acme.io"])[1],
    "PUBLIC_DOMAIN=panel.acme.io")
chk("localhost:PORT is accepted", run_case(["y", "localhost:3000"])[1],
    "PUBLIC_DOMAIN=localhost:3000")
chk("surrounding whitespace is trimmed",
    run_case(["y", "   https://x.example.com   "])[1], "PUBLIC_DOMAIN=https://x.example.com")

print("\n== declining must leave .env untouched ==")
chk("answering n changes nothing", run_case(["n"])[1], "PUBLIC_DOMAIN=")
chk("bare Enter changes nothing", run_case([""])[1], "PUBLIC_DOMAIN=")
chk("y then an empty line changes nothing", run_case(["y", ""])[1], "PUBLIC_DOMAIN=")

print("\n== the y/N confusion: refused AND explained as such ==")
for bad in ["y", "Y", "n", "no", "yes", "true", "false"]:
    t, line, _ = run_case(["y", bad])
    chk(f'"{bad}" is not stored', line, "PUBLIC_DOMAIN=")
    chk(f'"{bad}" is told this asks for an address, not y/n',
        bool(re.search(r"not a domain.*address, not y/n", t, re.S)), True)
t, line, _ = run_case(["y", "wat"])
chk("a dotless word gets the dotless message instead", bool(re.search(r"no dot", t)), True)
chk("and is still refused", line, "PUBLIC_DOMAIN=")
chk("a '#' in the domain is refused", run_case(["y", "a.com#x"])[1], "PUBLIC_DOMAIN=")

print("\n== it must not ask when the answer is already known ==")
t, _, seen = run_case(["y", "https://nope.example.com"],
                      env={"PUBLIC_DOMAIN": "https://env.example.com"})
chk("an env PUBLIC_DOMAIN suppresses the prompt", seen, 0)
chk("and is reported to the operator", "https://env.example.com" in t, True)
chk("an env BASE_URL also suppresses it",
    run_case(["y", "https://nope.example.com"], env={"BASE_URL": "https://legacy.example.com"})[2], 0)
chk("AB_NO_PROMPT suppresses it",
    run_case(["y", "https://nope.example.com"], env={"AB_NO_PROMPT": "1"})[2], 0)
# Without this, an operator holding Enter through startup would silently erase
# the domain they configured last week.
t, line, seen = run_case(["y", "https://nope.example.com"],
                         extra_env_lines="PUBLIC_DOMAIN=https://already.example.com\r\n")
chk("a domain already in .env suppresses the prompt", seen, 0)
chk("and that existing value survives", line, "PUBLIC_DOMAIN=https://already.example.com")

print("\n== the writer leaves no duplicate or stale keys ==")
d = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(d, "scripts"), exist_ok=True)
    shutil.copy(os.path.join(REPO, "scripts", "ask-domain.sh"),
                os.path.join(d, "scripts", "ask-domain.sh"))
    with io.open(os.path.join(d, ".env"), "w", encoding="utf-8", newline="") as fh:
        fh.write("A=1\r\nPUBLIC_DOMAIN=old.example.com\r\nB=2\r\n"
                 "BASE_URL=stale.example.com\r\nC=3\r\n")
    subprocess.run(["bash", "-c",
                    ". scripts/ask-domain.sh && _domain_write https://new.example.com"],
                   cwd=d, check=True, capture_output=True)
    body = io.open(os.path.join(d, ".env"), encoding="utf-8", newline="").read()
    chk("exactly one PUBLIC_DOMAIN remains",
        len(re.findall(r"^\s*PUBLIC_DOMAIN=", body, re.M)), 1)
    chk("it holds the new value",
        bool(re.search(r"^PUBLIC_DOMAIN=https://new\.example\.com", body, re.M)), True)
    # A surviving BASE_URL would win or lose unpredictably, so the operator
    # would see their new domain in .env and still be advertised the old one.
    chk("the stale BASE_URL is dropped", len(re.findall(r"^\s*BASE_URL=", body, re.M)), 0)
    chk("unrelated keys are preserved", all(k in body for k in ("A=1", "B=2", "C=3")), True)
finally:
    shutil.rmtree(d, ignore_errors=True)

print("\n== install.sh persist_public_domain() (a second, independent writer) ==")
chk("a real domain is stored", install_case("https://panel.acme.io")[1],
    "PUBLIC_DOMAIN=https://panel.acme.io")
chk("a bare host is stored", install_case("panel.acme.io")[1], "PUBLIC_DOMAIN=panel.acme.io")
chk("an empty domain is a no-op", install_case("")[1], "PUBLIC_DOMAIN=")
for bad in ["y", "n", "no", "yes", "true"]:
    chk(f'"{bad}" is refused by the installer too', install_case(bad)[1], "PUBLIC_DOMAIN=")
chk("a dotless word is refused", install_case("wat")[1], "PUBLIC_DOMAIN=")
out, line = install_case("a.com#frag")
chk("a '#' domain is refused", line, "PUBLIC_DOMAIN=")
chk("and the refusal is explained", "#" in out, True)
out, line = install_case("https://new.example.com", pre_lines="BASE_URL=stale.example.com\r\n")
chk("a stale BASE_URL is dropped here too", line, "PUBLIC_DOMAIN=https://new.example.com")
# Creating a .env from nothing would yield a file with one key and none of the
# ~77 others the server needs, which fails later and further from the cause.
out, line = install_case("https://panel.acme.io", seed=None)
chk("with no .env it refuses to invent one", line, None)
chk("and says what to add by hand", "PUBLIC_DOMAIN=https://panel.acme.io" in out, True)

print("\n== install.sh domain_to_url() ==")
chk("https is preserved", to_url("https://a.com"), "https://a.com")
chk("http is NOT silently upgraded", to_url("http://a.com"), "http://a.com")
chk("a bare host is assumed https", to_url("a.com"), "https://a.com")

print(f"\n{'PASS' if all(results) else 'FAIL'} — {sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
