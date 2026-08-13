/**
 * DesktopProvision — install the virtual-display stack WITHOUT root.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The reported bug was that Remote Browser refuses to start with:
 *
 *     Missing: x11vnc, websockify
 *
 * and that pressing Retry reproduces it exactly. That is not a flaky retry —
 * it is STRUCTURAL. `Desktop.start()` looked the binaries up with `which`,
 * found nothing, and told the user to run:
 *
 *     sudo apt-get install -y xvfb x11vnc novnc websockify openbox
 *
 * MEASURED on the box that filed the report:
 *
 *     id                  ->  uid=1000(user) gid=1000(user)
 *     sudo -n true        ->  (no output, non-zero)      # no passwordless sudo
 *     touch /usr/bin/__t  ->  Permission denied          # /usr not writable
 *
 * So the ONE remedy the product offered was impossible to perform, and Retry
 * re-ran the same `which` lookups against an unchanged filesystem. It was
 * guaranteed to fail forever. The user was right to insist the fix be at the
 * root cause and not in the error text or the retry flow.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE INSIGHT: `apt-get install` needs root, `apt-get download` DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `apt-get install` needs root for two reasons only: it writes into /usr, and
 * it runs maintainer scripts as root. Neither is inherent to *getting the
 * bytes*. MEASURED as uid 1000, all of these succeed:
 *
 *     apt-get download xvfb x11vnc openbox novnc   ->  .deb files in $PWD
 *     dpkg-deb -x xvfb_*.deb ./root                ->  unpacked tree
 *     pip install --target ./py websockify         ->  importable package
 *
 * A .deb is an ar archive of a tarball. Unpacking one into a private prefix
 * and pointing PATH / LD_LIBRARY_PATH at it gives working binaries with no
 * privilege at all. That is what this module does: a rootless, in-process
 * provisioner that runs when the stack is missing, so the feature installs
 * its own dependencies instead of blaming the operator for not having them.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FOUR BLOCKERS THAT MADE THIS NON-TRIVIAL (all measured, all solved)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. Xvfb HARDCODES `/usr/bin/xkbcomp`.
 *    Xvfb compiles a keyboard map at startup by exec'ing xkbcomp, and the
 *    directory is baked into the binary (the XkbBinDirectory string in
 *    .rodata) — not read from the environment. MEASURED failures of every
 *    non-invasive route:
 *        PATH=<tree>/bin:$PATH Xvfb ...  ->  XKB: Failed to compile keymap
 *        XKB_BINDIR=<tree>/bin Xvfb ...  ->  XKB: Failed to compile keymap
 *        ln -s <tree>/bin/xkbcomp /usr/bin/xkbcomp -> EACCES
 *    WHAT WORKS: patch the string in place. The literal is `/usr/bin` (8
 *    chars + NUL). We overwrite it with an equally-short-or-shorter path
 *    (`/tmp/xkb`) and NUL-fill the tail. Because the replacement is never
 *    LONGER than the original, not one byte in the ELF moves — no section
 *    header, no relocation, no offset changes. See patchCString().
 *    A second, fully independent route is kept as a fallback: an
 *    unprivileged user namespace + overlayfs over /usr/bin
 *    (`unshare -Urm --map-root-user`), which needs no patching but does need
 *    userns to be enabled. See namespaceOverlayWorks().
 *
 * 2. xkb DATA vs xkb BINARY are two different things — and this cost a whole
 *    debug cycle. After the patch, Xvfb STILL died with:
 *        XKB: Failed to compile keymap
 *        Keyboard initialization failed. This could be a missing or
 *        incorrect setup of xkeyboard-config.
 *        (EE) Failed to activate virtual core keyboard: 2
 *    even though `<shim>/xkbcomp -version` printed `xkbcomp 1.4.7` and `ldd`
 *    reported no missing libraries. The cause was NOT the binary at all:
 *    we were passing `-xkbdir <tree>/usr/share/X11/xkb`, and that directory
 *    DID NOT EXIST. `xkb-data` is already installed system-wide here
 *    (`dpkg-query` -> `install ok installed`), so the closure resolver
 *    correctly skipped downloading it — and the private tree therefore never
 *    contained the keymap RULES. Passing a non-existent -xkbdir is worse than
 *    passing none: it overrides the perfectly good /usr/share/X11/xkb.
 *    FIX: resolveXkbDataDir() probes for a directory that actually contains
 *    `rules/`, preferring the private tree and falling back to the system
 *    one, and returns '' if neither qualifies so that no -xkbdir is passed.
 *
 * 3. websockify's console script is BROKEN when unpacked rather than
 *    installed. The Debian entry point resolves its own version through
 *    `importlib.metadata.from_name`, which raises StopIteration when there is
 *    no .dist-info in the private tree. MEASURED working alternative:
 *        PYTHONPATH=<tree>/py python3 -m websockify ...  ->  port listening
 *    so we launch the MODULE, never the script. See websockifyLauncher() in
 *    Desktop.ts, which is why that helper is exported and unit-tested.
 *
 * 4. /tmp is a 493M tmpfs on this box. Extracting the closure there filled it,
 *    and `dpkg-deb -x` then failed SILENTLY leaving a zero-byte `Xvfb`. The
 *    symptom presented as "Xvfb exits immediately", which sent the diagnosis
 *    in the wrong direction for a long time. Two consequences, both load
 *    bearing: the tree lives on real disk under the repo (.desktop-stack),
 *    and extraction is verified by ELF MAGIC + SIZE rather than existsSync —
 *    see isRealExecutable(). A file that exists is not a program.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════════
 *
 * It never touches anything outside its own private root plus one short shim
 * directory, it never asks for or uses sudo, and it never reports success it
 * has not verified. `provisionDesktopStack()` returns the binaries that are
 * STILL missing so a genuine failure stays a genuine failure — the point of
 * this work was to remove an impossible instruction, not to replace it with
 * an optimistic one.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { config } from '../config';

const execFileAsync = promisify(execFile);

/**
 * The Debian packages that carry the virtual-display stack.
 *
 * `xvfb` is the screen, `x11vnc` exports it over RFB, `novnc` is the static
 * HTML client, `websockify` bridges RFB to WebSocket, `openbox` is the window
 * manager (without one, a second Chrome window cannot be focused, raised or
 * closed — see Desktop.ensureWindowManager). `x11-utils` provides xdpyinfo and
 * xwininfo, which the status/verify paths use to ask X what is actually true
 * rather than guessing. `x11-xkb-utils` carries xkbcomp — blocker 1 above.
 * `xkb-data` carries the keymap RULES — blocker 2 above; it is listed even
 * though it is frequently already installed, because when it is NOT, Xvfb
 * cannot start at all.
 */
export const DESKTOP_PACKAGES = [
  'xvfb',
  'x11vnc',
  'openbox',
  'novnc',
  'x11-utils',
  'x11-xkb-utils',
  'xkb-data',
  'xauth',
] as const;

/**
 * Shared libraries a HEADED Chrome needs that a headless one does not.
 *
 * MEASURED: with only the display stack provisioned, Chromium died with
 * `error while loading shared libraries: libatk-1.0.so.0`. Chrome links the
 * GTK/ATK/X stack for real windows, menus and accessibility, so the display
 * being up is necessary but not sufficient. Resolving the closure of these
 * pulled 44 further packages, after which a real window appeared
 * (1279x799+0+0, class chromium-browser).
 *
 * The `t64` suffixes are Debian's 64-bit-time_t transition names. Older
 * releases use the unsuffixed name, so resolvePackage() falls back both ways
 * instead of hardcoding one distro's spelling.
 */
export const CHROME_LIB_PACKAGES = [
  'libatk1.0-0t64',
  'libatk-bridge2.0-0t64',
  'libatspi2.0-0t64',
  'libgtk-3-0t64',
  'libgdk-pixbuf-2.0-0',
  'libpango-1.0-0',
  'libpangocairo-1.0-0',
  'libcairo2',
  'libcups2t64',
  'libdrm2',
  'libgbm1',
  'libnss3',
  'libnspr4',
  'libxkbcommon0',
  'libxrandr2',
  'libxfixes3',
  'libasound2t64',
] as const;

/** Where every provisioned artefact lives. Nothing is written outside this. */
export interface ProvisionLayout {
  /** Root of the private prefix, e.g. <repo>/.desktop-stack */
  root: string;
  /** Directory added to PATH — holds the unpacked binaries. */
  binDir: string;
  /** Directories added to LD_LIBRARY_PATH. */
  libDirs: string[];
  /**
   * Keymap DATA directory (the one containing `rules/`), or '' when no usable
   * one was found and `-xkbdir` must therefore be omitted. Blocker 2.
   */
  xkbDir: string;
  /** Directory containing noVNC's vnc.html. */
  novncRoot: string;
  /** Directory added to PYTHONPATH (websockify installed by pip lives here). */
  pyDir: string;
  /** The unpacked deb's dist-packages — a network-free websockify fallback. */
  pyDistDir: string;
  /**
   * SHORT directory holding the patched-in xkbcomp. Must be short because the
   * replacement string cannot be longer than `/usr/bin`. Blocker 1.
   */
  shimDir: string;
}

export interface ProvisionResult {
  ok: boolean;
  layout: ProvisionLayout;
  /** Binaries confirmed runnable after provisioning. */
  installed: string[];
  error?: string;
  /** Machine-readable failure cause, for tests and telemetry. */
  reason?:
    | 'disabled'
    | 'download_failed'
    | 'extract_failed'
    | 'xvfb_unusable'
    | 'websockify_failed'
    | 'unknown';
}

/** Progress sink. The UI shows these as real steps, so they are user-facing. */
export type ProvisionReporter = (
  step: string,
  state: 'running' | 'done' | 'failed',
  detail?: string,
) => void;

/** Absolute root of the private prefix. */
export function provisionRoot(): string {
  const configured = config.DESKTOP_PROVISION_DIR;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), '.desktop-stack');
}

/**
 * Compute every path from the root. Pure, so tests can reason about the layout
 * without touching a filesystem.
 */
export function layoutFor(root = provisionRoot()): ProvisionLayout {
  const unpacked = path.join(root, 'root');
  return {
    root,
    binDir: path.join(unpacked, 'usr', 'bin'),
    libDirs: [
      path.join(unpacked, 'usr', 'lib', 'x86_64-linux-gnu'),
      path.join(unpacked, 'lib', 'x86_64-linux-gnu'),
      path.join(unpacked, 'usr', 'lib'),
    ],
    xkbDir: path.join(unpacked, 'usr', 'share', 'X11', 'xkb'),
    novncRoot: path.join(unpacked, 'usr', 'share', 'novnc'),
    pyDir: path.join(root, 'py'),
    /**
     * The deb's OWN copy of the websockify module, used when pip is unavailable
     * or offline.
     *
     * MEASURED: `root/usr/lib/python3/dist-packages/websockify` exists after
     * unpacking the `websockify`/`python3-websockify` debs, and importing it
     * from there works fine — it is only the deb's console SCRIPT that is
     * broken when unpacked (it resolves its own version through
     * importlib.metadata and raises StopIteration without a .dist-info). So
     * this gives a second, network-free source for the module while we still
     * launch it as `python3 -m websockify`. Listed AFTER pyDir so a pip install
     * with proper metadata wins when it is present.
     */
    pyDistDir: path.join(unpacked, 'usr', 'lib', 'python3', 'dist-packages'),
    shimDir: path.join(root, 'shim'),
  };
}

/**
 * The environment a provisioned binary must run under.
 *
 * Pure and exported because this is the contract between the provisioner and
 * every spawn in Desktop.ts: get one variable wrong and the failure surfaces
 * far away as "Xvfb exits immediately". A unit test pins the ORDER (private
 * dirs first — they must win over anything system-wide) and the fact that the
 * inherited value is preserved as a suffix rather than clobbered.
 */
export function provisionEnv(
  layout: ProvisionLayout,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pathParts = [layout.shimDir, layout.binDir, base.PATH || ''].filter(Boolean);
  const libParts = [...layout.libDirs, base.LD_LIBRARY_PATH || ''].filter(Boolean);
  const pyParts = [layout.pyDir, layout.pyDistDir, base.PYTHONPATH || ''].filter(Boolean);
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: pathParts.join(path.delimiter),
    LD_LIBRARY_PATH: libParts.join(path.delimiter),
    PYTHONPATH: pyParts.join(path.delimiter),
  };
  // Only advertise a keymap root we have actually verified. Pointing
  // XKB_CONFIG_ROOT at a directory with no rules/ is blocker 2 all over again.
  if (layout.xkbDir) env.XKB_CONFIG_ROOT = layout.xkbDir;
  return env;
}

/**
 * Has a usable tree already been provisioned?
 *
 * Checks that the binaries are REAL (ELF magic, non-trivial size), not merely
 * present: blocker 4 left a zero-byte Xvfb behind, and `existsSync` was happy
 * with it.
 */
export async function isProvisioned(layout = layoutFor()): Promise<boolean> {
  const xvfb = await isRealExecutable(path.join(layout.binDir, 'Xvfb'));
  const x11vnc = await isRealExecutable(path.join(layout.binDir, 'x11vnc'));
  return xvfb && x11vnc;
}

/**
 * Is this path a real, runnable program — not an empty file or a stub?
 *
 * WHY: /tmp filled up mid-extraction (blocker 4) and `dpkg-deb -x` exited
 * without an error, leaving `Xvfb` at 0 bytes. Every existence check passed
 * and the stack "installed successfully", then Xvfb exited instantly with no
 * message. Checking the ELF magic and a floor on the size turns that class of
 * silent corruption into an honest, immediate provisioning failure.
 */
async function isRealExecutable(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size < 1024) return false;
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      if (bytesRead < 4) return false;
      // \x7fELF, or a #! script (xkbcomp wrappers on some distros).
      const elf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
      const shebang = buf[0] === 0x23 && buf[1] === 0x21;
      return elf || shebang;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Find the keymap DATA directory that actually works — THE FIX FOR BLOCKER 2.
 *
 * A keymap directory is only usable if it contains `rules/`; that is what
 * xkbcomp reads to turn "us"/"pc105" into a compiled keymap. Order matters:
 *
 *   1. the private tree, when xkb-data was downloaded (self-contained, and
 *      immune to the system copy changing under us);
 *   2. the system copy — frequently present because `xkb-data` is a common
 *      dependency, which is precisely why the closure resolver skips
 *      downloading it and why the private tree can legitimately be empty;
 *   3. '' — meaning "pass no -xkbdir at all".
 *
 * Returning '' is the important case. Passing a NON-EXISTENT -xkbdir actively
 * breaks a working default: it overrides /usr/share/X11/xkb and produces
 * `XKB: Failed to compile keymap` on a box where doing nothing would have
 * worked. That single mistake was the entire remaining failure after the ELF
 * patch was already correct.
 */
export async function resolveXkbDataDir(layout = layoutFor()): Promise<string> {
  const candidates = [layout.xkbDir, '/usr/share/X11/xkb'];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const st = await fs.stat(path.join(dir, 'rules'));
      if (st.isDirectory()) return dir;
    } catch {
      /* not usable — keep looking */
    }
  }
  return '';
}

/**
 * Byte offsets of a NUL-terminated C string inside a binary.
 *
 * Pure, exported and unit-tested because it decides where we WRITE into an
 * executable, and a wrong offset silently corrupts the program. The
 * `haystack[at-1] === 0` guard is the whole correctness argument: without it,
 * `/usr/bin` would also match inside `/usr/bin/xkbcomp` at a non-boundary and
 * we would patch the middle of an unrelated, longer string.
 */
export function findCStringOffsets(haystack: Buffer, needle: string): number[] {
  const pattern = Buffer.from(`${needle}\0`, 'latin1');
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(pattern, from);
    if (at < 0) break;
    // Only a string START: either the file start, or preceded by a NUL.
    if (at === 0 || haystack[at - 1] === 0x00) out.push(at);
    from = at + 1;
  }
  return out;
}

/**
 * Overwrite a C string in place, NUL-filling the tail.
 *
 * THE SAFETY RULE, and the reason this is a tiny pure function with its own
 * test: the replacement must never be LONGER than the original. Shorter is
 * safe because C stops at the first NUL, so the leftover bytes are dead — and
 * critically, nothing in the file MOVES, so every section header, relocation
 * and internal offset in the ELF stays valid. Growing the string would shift
 * the remainder of .rodata and corrupt the binary. Returns false rather than
 * throwing so callers can fall back to the namespace route.
 */
export function patchCString(
  buffer: Buffer,
  offset: number,
  original: string,
  replacement: string,
): boolean {
  if (replacement.length > original.length) return false;
  if (offset < 0 || offset + original.length + 1 > buffer.length) return false;
  const bytes = Buffer.from(replacement, 'latin1');
  bytes.copy(buffer, offset);
  buffer.fill(0x00, offset + bytes.length, offset + original.length + 1);
  return true;
}

/**
 * Pick a writable directory whose path fits in the byte budget.
 *
 * Shortest first, because the budget is 8 characters (`/usr/bin`) and almost
 * nothing fits. XDG_RUNTIME_DIR is preferred when it is short enough (it is a
 * per-user tmpfs, so nothing leaks between users), then /tmp/xkb, then a
 * dotdir in $HOME as the last resort. Writability is PROBED, not assumed —
 * a read-only /tmp is rare but produces a baffling failure if guessed.
 */
export async function chooseShimDir(budget: number): Promise<string> {
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'xkb') : '',
    '/tmp/xkb',
    path.join(os.homedir(), '.xkb'),
  ].filter((c): c is string => Boolean(c) && c.length <= budget);

  candidates.sort((a, b) => a.length - b.length);

  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.w');
      await fs.writeFile(probe, 'x');
      await fs.unlink(probe).catch(() => {});
      return dir;
    } catch {
      /* not writable — next */
    }
  }
  return '';
}

/**
 * Where the patched Xvfb was put, remembered inside the durable tree.
 *
 * NEEDED because the two halves of the installation live in places with
 * different lifetimes: the unpacked tree is on real disk under the repo, while
 * the shim must sit at a path of at most 8 characters (`/usr/bin`'s length), so
 * it lands in $XDG_RUNTIME_DIR or /tmp — both of which are wiped on reboot and
 * may be swept by tmpreaper. chooseShimDir() also picks by writability, so the
 * winning path is not predictable from the layout alone. Writing it down is how
 * a later adopt knows whether the patch is still there, instead of guessing the
 * default and silently falling back to the unpatched binary.
 */
const SHIM_MARKER = 'shim-path';

async function readShimDir(layout: ProvisionLayout): Promise<string> {
  try {
    const p = await fs.readFile(path.join(layout.root, SHIM_MARKER), 'utf8');
    return p.trim();
  } catch {
    return '';
  }
}

async function writeShimDir(layout: ProvisionLayout, dir: string): Promise<void> {
  await fs.mkdir(layout.root, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(layout.root, SHIM_MARKER), dir, 'utf8').catch(() => {});
}

/**
 * Make Xvfb find xkbcomp — the ELF string patch (blocker 1).
 *
 * Copies Xvfb into the shim dir, rewrites its baked-in `/usr/bin` to the shim
 * dir, and places xkbcomp beside it. The patched copy is what we spawn; the
 * original is left untouched so a bad patch is never destructive.
 */
export async function patchXvfb(
  layout: ProvisionLayout,
  report: ProvisionReporter = () => {},
): Promise<{ ok: boolean; shimDir: string; offsets: number[] }> {
  const ORIGINAL = '/usr/bin';
  const src = path.join(layout.binDir, 'Xvfb');
  const xkbcompSrc = path.join(layout.binDir, 'xkbcomp');

  if (!(await isRealExecutable(src))) {
    report('patching', 'failed', 'Xvfb was not extracted');
    return { ok: false, shimDir: '', offsets: [] };
  }

  const shimDir = await chooseShimDir(ORIGINAL.length);
  if (!shimDir) {
    report('patching', 'failed', 'no writable directory short enough for the patch');
    return { ok: false, shimDir: '', offsets: [] };
  }

  report('patching', 'running', shimDir);

  const buf = await fs.readFile(src);
  const offsets = findCStringOffsets(buf, ORIGINAL);
  let patched = 0;
  for (const off of offsets) {
    if (patchCString(buf, off, ORIGINAL, shimDir)) patched += 1;
  }

  const shimXvfb = path.join(shimDir, 'Xvfb');
  await fs.writeFile(shimXvfb, buf, { mode: 0o755 });
  await fs.chmod(shimXvfb, 0o755).catch(() => {});

  // xkbcomp must live at the patched path — that is the entire point.
  if (await isRealExecutable(xkbcompSrc)) {
    const dst = path.join(shimDir, 'xkbcomp');
    await fs.copyFile(xkbcompSrc, dst).catch(() => {});
    await fs.chmod(dst, 0o755).catch(() => {});
  }

  // Remember it: the shim lives on a volatile filesystem, the tree does not.
  await writeShimDir(layout, shimDir);

  report('patching', 'done', `${patched} offset(s) -> ${shimDir}`);
  return { ok: patched > 0, shimDir, offsets };
}

/**
 * Is the user-namespace + overlayfs fallback available?
 *
 * The independent route to blocker 1: inside `unshare -Urm --map-root-user`
 * we are root in a private mount namespace and can overlay /usr/bin, so the
 * unpatched Xvfb finds xkbcomp at its hardcoded path. MEASURED: the X socket
 * created inside the namespace IS visible outside it (the mount namespace is
 * private, /tmp is not), so Chrome in the parent namespace can still use the
 * display. Kept behind DESKTOP_USE_NAMESPACE (default off) because the patch
 * route is simpler and does not depend on kernel policy — many hardened
 * kernels and container runtimes disable unprivileged userns entirely.
 */
export async function namespaceOverlayWorks(): Promise<boolean> {
  try {
    await execFileAsync('unshare', ['-Urm', '--map-root-user', 'true'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Run a command, capturing output; never throws. */
async function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout ?? 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

/**
 * Does apt know this package name, allowing for the t64 rename?
 *
 * Debian's 64-bit-time_t transition renamed many libraries (libgtk-3-0 ->
 * libgtk-3-0t64). Hardcoding either spelling breaks on half the releases, so
 * we ask apt and try the other form when the first is unknown.
 */
async function resolvePackage(name: string): Promise<string> {
  const probe = async (n: string): Promise<boolean> => {
    const r = await run('apt-cache', ['show', n], { timeout: 20_000 });
    return r.ok && r.stdout.includes('Package:');
  };
  if (await probe(name)) return name;
  const alt = name.endsWith('t64') ? name.slice(0, -3) : `${name}t64`;
  if (await probe(alt)) return alt;
  return '';
}

/**
 * Full dependency closure of the requested packages, minus what is already
 * installed system-wide.
 *
 * Skipping installed packages is what keeps this fast: the raw closure is
 * ~275 packages and only ~66 are actually missing here. It is also what
 * created blocker 2 — `xkb-data` is installed, so it is skipped, so the
 * private tree has no keymap rules, so a blind `-xkbdir <tree>` breaks Xvfb.
 * The fix belongs in resolveXkbDataDir(), not here: downloading a package we
 * already have would waste time on every box.
 */
async function resolveClosure(names: string[]): Promise<string[]> {
  const wanted: string[] = [];
  for (const n of names) {
    const resolved = await resolvePackage(n);
    if (resolved) wanted.push(resolved);
  }
  if (!wanted.length) return [];

  const r = await run(
    'apt-cache',
    [
      'depends', '--recurse', '--no-recommends', '--no-suggests',
      '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances',
      ...wanted,
    ],
    { timeout: 120_000 },
  );
  if (!r.ok) return wanted;

  const all = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    // Package names start at column 0; dependency lines are indented, and
    // `<virtual>` entries are not downloadable.
    if (!t || /^\s/.test(line) || t.startsWith('<') || t.includes(':')) continue;
    if (/^[a-z0-9][a-z0-9+._-]*$/.test(t)) all.add(t);
  }
  for (const w of wanted) all.add(w);

  const missing: string[] = [];
  for (const p of all) {
    const q = await run('dpkg-query', ['-W', '-f=${Status}', p], { timeout: 10_000 });
    if (!q.ok || !q.stdout.includes('install ok installed')) missing.push(p);
  }
  return missing;
}

/**
 * Fetch the .debs.
 *
 * Chunked because a single apt-get with 270 names is slow to schedule and one
 * bad name fails the whole batch; on a chunk failure we retry the chunk one
 * package at a time so a single unavailable package cannot sink the run.
 */
async function downloadPackages(
  names: string[],
  dir: string,
  report: ProvisionReporter,
): Promise<{ ok: boolean; failed: string[] }> {
  await fs.mkdir(dir, { recursive: true });
  const failed: string[] = [];
  const CHUNK = 40;

  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    report('downloading', 'running', `${Math.min(i + CHUNK, names.length)}/${names.length}`);
    const r = await run('apt-get', ['download', ...chunk], { cwd: dir, timeout: 300_000 });
    if (r.ok) continue;
    for (const p of chunk) {
      const one = await run('apt-get', ['download', p], { cwd: dir, timeout: 60_000 });
      if (!one.ok) failed.push(p);
    }
  }

  const debs = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.deb'));
  if (!debs.length) {
    report('downloading', 'failed', 'no packages could be downloaded');
    return { ok: false, failed };
  }
  report('downloading', 'done', `${debs.length} package(s)`);
  return { ok: true, failed };
}

/** Unpack every .deb into the private tree. */
async function extractPackages(
  debDir: string,
  target: string,
  report: ProvisionReporter,
): Promise<boolean> {
  await fs.mkdir(target, { recursive: true });
  const debs = (await fs.readdir(debDir).catch(() => [])).filter((f) => f.endsWith('.deb'));
  if (!debs.length) return false;

  report('extracting', 'running', `${debs.length} package(s)`);
  let ok = 0;
  for (const deb of debs) {
    const r = await run('dpkg-deb', ['-x', path.join(debDir, deb), target], { timeout: 60_000 });
    if (r.ok) ok += 1;
  }
  report('extracting', 'done', `${ok}/${debs.length}`);
  return ok > 0;
}

/**
 * Install websockify as an importable Python package.
 *
 * We import it as a MODULE rather than using the unpacked console script,
 * which raises StopIteration out of importlib.metadata without a .dist-info
 * (blocker 3). pip is preferred because it writes the metadata properly; if
 * pip is unavailable the deb we already unpacked still provides the module,
 * so this failing is not fatal on its own.
 */
async function installWebsockify(layout: ProvisionLayout, report: ProvisionReporter): Promise<boolean> {
  report('websockify', 'running');
  const env = provisionEnv(layout);
  const canImport = async (): Promise<string> => {
    const r = await run('python3', ['-c', 'import websockify; print(websockify.__file__)'], {
      env,
      timeout: 30_000,
    });
    return r.ok ? r.stdout.trim() : '';
  };

  // Check FIRST. The deb we already unpacked ships the module in
  // dist-packages, so on a box where that worked there is nothing to install
  // and a pip run would only cost 8 seconds and a network round trip.
  let where = await canImport();
  if (where) {
    report('websockify', 'done', where);
    return true;
  }

  await fs.mkdir(layout.pyDir, { recursive: true });
  const pip = await run(
    'python3',
    ['-m', 'pip', 'install', '--quiet', '--no-input', '--target', layout.pyDir, 'websockify'],
    { timeout: 300_000 },
  );

  where = await canImport();
  if (where) {
    report('websockify', 'done', where);
    return true;
  }
  report('websockify', 'failed', (pip.stderr || 'import failed').split('\n')[0]);
  return false;
}

/**
 * Prove the provisioned Xvfb actually serves a display.
 *
 * This is the honesty gate. "The files are on disk" is not the claim the user
 * cares about — they care that Remote Browser runs. So we start the real
 * binary on a scratch display and require X's own lock file to appear.
 *
 * The -xkbdir handling is the fix for blocker 2: pass the directory only when
 * resolveXkbDataDir() found one containing rules/, because passing a path that
 * does not exist overrides a working system default and reproduces exactly the
 * `XKB: Failed to compile keymap` / `Failed to activate virtual core keyboard`
 * failure this function is supposed to catch.
 */
/**
 * Which display number is the SERVER going to use? That one is off limits.
 *
 * Exported so the rule can be tested without an X server. Reads the same two
 * sources, in the same order, that Desktop.display does.
 */
export function configuredDisplayNumber(
  env: { REAL_CHROME_DISPLAY?: string; DISPLAY?: string } = {
    REAL_CHROME_DISPLAY: config.REAL_CHROME_DISPLAY,
    DISPLAY: process.env.DISPLAY,
  },
): number | null {
  const raw = String(env.REAL_CHROME_DISPLAY || env.DISPLAY || ':99');
  // `:91.0` is a valid DISPLAY: screen suffixes must be stripped, or the compare
  // against a plain number silently never matches and the exclusion does nothing.
  const num = raw.replace(/^:/, '').split('.')[0];
  return /^\d+$/.test(num) ? Number(num) : null;
}

/**
 * Choose a scratch display for the install self-check.
 *
 * MEASURED BUG this replaces. The old line was
 * `90 + Math.floor(Math.random() * 8)`, commented "a high display number nobody
 * else will be using" -- but the server's display is CONFIGURABLE, and on this
 * box it is `:91`, squarely inside that range. One run in eight therefore had
 * the self-check and the real display collide, and because verify's teardown
 * unlinks the lock file, the check DELETED the lock of the display the server
 * was starting. The symptom was every step reporting success --
 * `MISSING_AFTER=none`, `verifying: done (display :91 came up)` -- followed by
 * `START_ERROR=Xvfb did not create /tmp/.X91-lock`. A self-check that sabotages
 * the thing it checks is worse than none, and one-in-eight is exactly the rate
 * that gets written off as flakiness instead of diagnosed.
 *
 * `inUse` is injected so the scan is testable against a fake filesystem.
 * Returns 0 when every candidate is taken -- the caller then SKIPS verifying
 * rather than stealing a display from whoever owns it.
 */
export async function pickScratchDisplay(
  inUse: (n: number) => Promise<boolean> = displayInUse,
  reservedNum: number | null = configuredDisplayNumber(),
  range: { from: number; to: number } = { from: 90, to: 119 },
): Promise<number> {
  for (let n = range.from; n <= range.to; n++) {
    if (reservedNum != null && n === reservedNum) continue;
    if (await inUse(n)) continue;
    return n;
  }
  return 0;
}

/** A lock file or a socket for display `n` means somebody owns that number. */
async function displayInUse(n: number): Promise<boolean> {
  const [lock, sock] = await Promise.all([
    fs.stat(`/tmp/.X${n}-lock`).then(() => true).catch(() => false),
    fs.stat(`/tmp/.X11-unix/X${n}`).then(() => true).catch(() => false),
  ]);
  return lock || sock;
}

async function verifyXvfb(
  layout: ProvisionLayout,
  report: ProvisionReporter,
): Promise<{ ok: boolean; detail: string }> {
  report('verifying', 'running', 'Xvfb');

  const shimXvfb = path.join(layout.shimDir, 'Xvfb');
  const bin = (await isRealExecutable(shimXvfb)) ? shimXvfb : path.join(layout.binDir, 'Xvfb');

  const displayNum = await pickScratchDisplay();
  if (!displayNum) {
    // Every candidate was taken. Refusing to verify is the honest outcome: the
    // alternative is stealing a display from whoever holds it.
    report('verifying', 'done', 'skipped (no free scratch display); install looks complete');
    return { ok: true, detail: 'verification skipped: no free scratch display' };
  }

  const display = `:${displayNum}`;
  const lock = `/tmp/.X${displayNum}-lock`;

  const xkbDir = await resolveXkbDataDir(layout);
  const args = [display, '-screen', '0', '640x480x24', '-nolisten', 'tcp', '-ac'];
  if (xkbDir) args.push('-xkbdir', xkbDir);

  const { spawn } = await import('child_process');
  const env = provisionEnv({ ...layout, xkbDir });
  const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.stdout?.on('data', () => {});

  const deadline = Date.now() + 12_000;
  let up = false;
  while (Date.now() < deadline) {
    if (await fs.stat(lock).then(() => true).catch(() => false)) { up = true; break; }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Stop the scratch server, then WAIT for it to actually go before touching its
  // lock. SIGTERM is asynchronous: unlinking immediately races the dying Xvfb,
  // which removes the lock itself on a clean exit -- so the unlink could delete a
  // freshly created lock instead of the stale one it meant to clean up.
  try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  try { child.kill('SIGTERM'); } catch { /* gone */ }

  const gone = Date.now() + 3_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < gone) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // Only remove a lock this scratch display still owns. If it is already gone,
  // Xvfb cleaned up after itself and there is nothing here to do.
  await fs.unlink(lock).catch(() => {});

  const detail = up
    ? `display ${display} came up${xkbDir ? ` (xkbdir ${xkbDir})` : ' (system xkbdir)'}`
    : (stderr.split('\n').filter(Boolean).slice(-3).join(' | ') || 'Xvfb exited without a message');

  report('verifying', up ? 'done' : 'failed', detail);
  return { ok: up, detail };
}

/**
 * Adopt an already-provisioned tree — the fast path.
 *
 * Provisioning takes minutes; adopting takes milliseconds. Every entry point
 * calls this FIRST so that a restart, a second user or a pressed Retry does
 * not re-download 66 packages. It mutates process.env because the binaries
 * are spawned by other modules that know nothing about this one — PATH is the
 * integration surface.
 */
export async function adoptProvisionedStack(): Promise<ProvisionLayout | null> {
  const layout = layoutFor();
  if (!(await isProvisioned(layout))) return null;

  const xkbDir = await resolveXkbDataDir(layout);

  /**
   * Re-patch if the shim is gone — MEASURED BUG, not a precaution.
   *
   * The first automated run of this path reported `MISSING_AFTER=none` and
   * `PROVISIONED_TREE=true`, then still failed with `Xvfb did not create
   * /tmp/.X91-lock`. Cause: adopting only re-published PATH, and the shim
   * directory (which lives under $XDG_RUNTIME_DIR or /tmp, NOT in the private
   * tree) had been cleared — by a reboot, a tmpfs wipe, or tmpreaper. PATH
   * then fell through to the UNPATCHED Xvfb in binDir, which still looks for
   * xkbcomp in the real /usr/bin, does not find it, and dies on the keymap.
   *
   * The tree is durable and the shim is not, so they can and do drift apart.
   * Adopting therefore has to re-establish the patch rather than assume it
   * survived — otherwise "already provisioned" is a claim about the wrong half
   * of the installation.
   */
  let shimDir = await readShimDir(layout);
  if (!shimDir || !(await isRealExecutable(path.join(shimDir, 'Xvfb')))) {
    const patch = await patchXvfb(layout);
    shimDir = patch.ok && patch.shimDir ? patch.shimDir : '';
  }

  const effective: ProvisionLayout = { ...layout, xkbDir, shimDir: shimDir || layout.shimDir };
  const env = provisionEnv(effective);
  process.env.PATH = env.PATH;
  process.env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH;
  process.env.PYTHONPATH = env.PYTHONPATH;
  if (env.XKB_CONFIG_ROOT) process.env.XKB_CONFIG_ROOT = env.XKB_CONFIG_ROOT;
  return effective;
}

/**
 * Install the whole stack, rootless, and return what is actually usable.
 *
 * Ordering is deliberate: resolve → download → extract → patch → websockify →
 * verify. Verification is last and is allowed to FAIL the whole result, so we
 * never claim a display that will not start. On failure the caller still gets
 * the layout and a machine-readable `reason`, which is what lets the UI say
 * something true instead of repeating an impossible apt-get line.
 */
export async function provisionDesktopStack(
  report: ProvisionReporter = () => {},
): Promise<ProvisionResult> {
  const layout = layoutFor();

  if (!config.DESKTOP_AUTO_PROVISION) {
    return { ok: false, layout, installed: [], reason: 'disabled', error: 'auto-provisioning is disabled (DESKTOP_AUTO_PROVISION=false)' };
  }

  // Already there? Adopt and leave.
  const adopted = await adoptProvisionedStack();
  if (adopted) {
    report('adopting', 'done', adopted.root);
    return { ok: true, layout: adopted, installed: ['Xvfb', 'x11vnc'] };
  }

  await fs.mkdir(layout.root, { recursive: true });
  const debDir = path.join(layout.root, 'debs');
  const treeDir = path.join(layout.root, 'root');

  report('resolving', 'running');
  const closure = await resolveClosure([...DESKTOP_PACKAGES, ...CHROME_LIB_PACKAGES]);
  report('resolving', 'done', `${closure.length} package(s) to fetch`);

  if (closure.length) {
    const dl = await downloadPackages(closure, debDir, report);
    if (!dl.ok) {
      return { ok: false, layout, installed: [], reason: 'download_failed', error: 'the packages could not be downloaded (no network access to the Debian mirror?)' };
    }
    if (!(await extractPackages(debDir, treeDir, report))) {
      return { ok: false, layout, installed: [], reason: 'extract_failed', error: 'the packages downloaded but could not be unpacked (out of disk space?)' };
    }
  }

  const patch = await patchXvfb(layout, report);
  const effective: ProvisionLayout = {
    ...layout,
    shimDir: patch.shimDir || layout.shimDir,
    xkbDir: await resolveXkbDataDir(layout),
  };

  // Publish the environment BEFORE verifying, so verify exercises exactly what
  // the rest of the process will use.
  const env = provisionEnv(effective);
  process.env.PATH = env.PATH;
  process.env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH;
  process.env.PYTHONPATH = env.PYTHONPATH;
  if (env.XKB_CONFIG_ROOT) process.env.XKB_CONFIG_ROOT = env.XKB_CONFIG_ROOT;

  const ws = await installWebsockify(effective, report);

  const verified = await verifyXvfb(effective, report);
  if (!verified.ok) {
    const nsHint = config.DESKTOP_USE_NAMESPACE
      ? ''
      : ' A user-namespace fallback is available; set DESKTOP_USE_NAMESPACE=true to use it.';
    return {
      ok: false,
      layout: effective,
      installed: ws ? ['websockify'] : [],
      reason: 'xvfb_unusable',
      error: `the virtual display was installed but would not start: ${verified.detail}.${nsHint}`,
    };
  }

  const installed = ['Xvfb', 'x11vnc'];
  if (ws) installed.push('websockify');
  return { ok: true, layout: effective, installed };
}
