/**
 * Desktop — a virtual screen for the real Chrome, served over HTTP.
 *
 * WHY A REMOTE DESKTOP AND NOT JUST A BIGGER SCREENCAST
 * -----------------------------------------------------
 * The picker's canvas shows the PAGE. Everything an extension user actually
 * touches lives outside the page:
 *
 *   - the extension toolbar button and its popup,
 *   - chrome://extensions,
 *   - the native "choose a file" dialog you need to import a cookie export,
 *   - Chrome's own profile / cookie settings.
 *
 * None of those can be captured by Page.startScreencast, at any resolution,
 * because they are not rendered by the page's compositor. The only way to see
 * and click them is to look at the X display itself.
 *
 * The stack is the boring, universally available one:
 *
 *   Xvfb        creates display :99 in memory (no GPU, no monitor)
 *   x11vnc      exports that display over the VNC protocol on 5900
 *   websockify  wraps VNC in WebSocket and serves noVNC's HTML client on 6080
 *
 * so the operator opens http://server:6080/vnc.html and is looking at a real
 * Chrome window they can click.
 *
 * SECURITY
 * --------
 * A VNC session on the box that holds every cookie the user imported is as
 * sensitive as an SSH shell. Defaults here are conservative: processes bind to
 * localhost unless the operator opts out, and a password is strongly encouraged
 * (DESKTOP_VNC_PASSWORD). The recommended access path is an SSH tunnel.
 */

import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { config } from '../config';

const execFileAsync = promisify(execFile);

export type DesktopComponent = 'xvfb' | 'wm' | 'x11vnc' | 'novnc';

/**
 * Window managers we will use, best first.
 *
 * Any ICCCM-compliant WM fixes the bug below; these two are simply the
 * smallest ones that are packaged everywhere. Ordered, not configurable,
 * because the operator does not want to make this decision.
 */
const WM_CANDIDATES = ['openbox', 'fluxbox'] as const;

/**
 * How often websockify pings the browser, in seconds.
 *
 * 25s is chosen to sit comfortably under the shortest idle timeout that matters
 * in practice: nginx's proxy_read_timeout defaults to 60s, and hosted tunnels
 * are typically more aggressive still. See the call site for the measurement
 * and the reported symptom.
 */
export const WEBSOCKET_HEARTBEAT_SEC = 25;

export interface DesktopStatus {
  enabled: boolean;
  /** All three components up: the screen is both alive AND viewable. */
  running: boolean;
  /**
   * Only the X display (Xvfb) is up. This is the part Chrome actually needs;
   * x11vnc/noVNC merely let a human LOOK at it. Reported separately so the UI
   * can say "the browser can run, you just cannot watch it" instead of the far
   * more alarming (and wrong) "remote desktop: stopped".
   */
  displayRunning: boolean;
  display: string;
  vncPort: number;
  novncPort: number;
  /** Relative URL the browser should open; host is filled in by the client. */
  novncPath: string;
  passwordProtected: boolean;
  components: Record<DesktopComponent, { running: boolean; pid: number; missing: boolean }>;
  /** Binaries that are not installed — the actionable part of a failure. */
  missing: string[];
  installHint: string;
  lastError: string;
}

const INSTALL_HINT =
  'Install the virtual display stack: sudo apt-get install -y xvfb x11vnc novnc websockify openbox ' +
  '(or run: bash scripts/desktop.sh install). openbox is the window manager — without one, ' +
  'a second Chrome window cannot be focused, raised or closed.';

/** Just the display. Chrome needs this one; the other two are for watching. */
export const DISPLAY_INSTALL_HINT =
  'Install the virtual display: sudo apt-get install -y xvfb ' +
  '(or run: bash scripts/desktop.sh install).';

/**
 * The message a user gets when a headed Chrome has nowhere to draw.
 *
 * Pure on purpose: the wording is the whole value of this feature — an operator
 * who reads "run scripts/desktop.sh start" and runs it only to be told `Xvfb:
 * command not found` has been sent in a circle — so it is unit-tested rather
 * than left to chance inside a spawn path that no test can reach.
 */
export function displayGuidance(missing: string[], display: string): string {
  const xvfbMissing = missing.includes('Xvfb');
  return (
    `Chrome needs a screen to draw on and none is available on ${display}. ` +
    'Extensions only load in a headed Chrome, so this machine needs a virtual X server. ' +
    (xvfbMissing
      ? `Xvfb is not installed — ${DISPLAY_INSTALL_HINT}`
      : 'Start it with: bash scripts/desktop.sh start') +
    ' Alternatively set REAL_CHROME_HEADLESS=true, which starts faster but loads NO extensions.'
  );
}

/** Candidate locations of noVNC's static files across distributions. */
const NOVNC_ROOTS = [
  '/usr/share/novnc',
  '/usr/share/webapps/novnc',
  '/usr/local/share/novnc',
  '/opt/novnc',
];

function which(bin: string): Promise<string> {
  return execFileAsync('which', [bin])
    .then((r) => r.stdout.trim())
    .catch(() => '');
}

/**
 * Is ANY window manager currently managing this display?
 *
 * MEASURED (2026-08-11): after the app restarted, `openbox` was alive as pid
 * 3267 and managing :99, yet /browser/desktop/status reported wm.running=false
 * — because the check asked "did *we* spawn it and is that child still ours?",
 * and a restarted process has no children. Two consequences, both bad: the UI
 * cried "no window manager" while one was plainly running, and ensureWindowManager
 * spawned a SECOND openbox that exited immediately ("another window manager is
 * already running"), leaving lastError set on a perfectly healthy desktop.
 *
 * Every EWMH window manager advertises itself by putting _NET_SUPPORTING_WM_CHECK
 * on the root window, so asking X is both correct and WM-agnostic — it also sees
 * a WM an operator started by hand, which is exactly what the user has.
 * Ownership is not the question; whether windows get managed is.
 */
export function displayIsManaged(xpropStdout: string): boolean {
  // MEASURED against the real tool on a real Xvfb (2026-08-11):
  //   no WM      → "_NET_SUPPORTING_WM_CHECK:  no such atom on any window."
  //   openbox up → "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x20011f"
  // Note the first case EXITS 0, so the exit code cannot be used to tell them
  // apart — only the presence of a window id can.
  return /window id # 0x[0-9a-f]+/i.test(xpropStdout);
}

function wmRunning(display: string): Promise<boolean> {
  return execFileAsync('xprop', ['-root', '-display', display, '_NET_SUPPORTING_WM_CHECK'])
    .then((r) => displayIsManaged(r.stdout))
    .catch(() => false); // xprop absent or display down — assume unmanaged
}

/**
 * Pull "1600x900" out of `xdpyinfo` output.
 *
 * MEASURED on the real tool, which prints exactly:
 *   "  dimensions:    1600x900 pixels (406x229 millimeters)"
 * Kept as a pure function so a test can pin the parse without an X server.
 */
export function parseScreenSize(
  xdpyinfoStdout: string,
): { width: number; height: number } | null {
  const m = /dimensions:\s*(\d+)x(\d+)\s*pixels/i.exec(xdpyinfoStdout);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * The exact argv handed to x11vnc.
 *
 * Extracted as a pure function so a test can assert on the REAL argument list
 * production uses, instead of reading the source for a string. Two flags in
 * here were wrong in an earlier draft and are pinned deliberately:
 *
 *   -timeout n     is "exit unless a client connects within the first n
 *                  seconds", so `-timeout 0` would KILL the server. Never add.
 *   -nevershared   takes NO argument, so `-nevershared no` is a parse error.
 *
 * Both were caught against `x11vnc -help` before shipping; the test exists so
 * they cannot come back.
 */
export function x11vncArgs(opts: {
  display: string;
  rfbPort: number;
  passwordFile?: string;
}): string[] {
  const args = [
    '-display', opts.display,
    '-rfbport', String(opts.rfbPort),
    '-localhost',      // websockify is the only client; never expose raw VNC
    '-forever',        // survive a viewer disconnecting
    '-shared',
    '-noxdamage',
    '-quiet',
    // Track XRANDR changes instead of assuming the screen size never moves.
    // VERIFIED against `x11vnc -help` and by starting the real binary with
    // this flag (it came up: "PORT=5901"). Note what this does NOT do: no
    // x11vnc flag makes it honour a client's SetDesktopSize, so noVNC still
    // logs "Resize is administratively prohibited". The black margins the
    // operator saw are NOT a framebuffer-size problem -- they are the Chrome
    // window not filling the screen it already has:
    //     screen 1600x900, Chrome window 1288x811 -> COVERAGE 72.5%
    // which is fixed where the window is created, not here.
    '-xrandr', 'resize',
  ];
  if (opts.passwordFile) args.push('-rfbauth', opts.passwordFile);
  else args.push('-nopw');
  return args;
}

/**
 * The exact argv handed to websockify.
 *
 * Pure for the same reason as x11vncArgs: the heartbeat is the fix for the
 * reconnect churn and a test has to be able to see the real flag.
 */
export function websockifyArgs(opts: {
  webRoot: string;
  listenPort: number;
  vncPort: number;
  heartbeatSec?: number;
}): string[] {
  return [
    '--web', opts.webRoot,
    // KEEP THE SOCKET ALIVE. The operator reported:
    //   «۱۰ ثانیه هم نشده بود که متصل شدم ... بعد ۱۰ ثانیه مرورگر رفت و یه
    //    چیزی اومد که میگفت اتصال مجدد ... این رو اعصابه هر بار قطع وصلی»
    //
    // A VNC stream carries NO traffic while the screen is still, and an idle
    // WebSocket is exactly what reverse proxies and load balancers reap
    // (nginx's default proxy_read_timeout is 60s; many CDN/tunnel front ends
    // are far more aggressive). x11vnc runs with -forever, so the moment the
    // socket dies the page dutifully reconnects -- which is the churn being
    // reported. A ping every 25s means the connection is never idle long
    // enough to be collected. VERIFIED: websockify starts with this flag and
    // listens ("HEARTBEAT_FLAG_OK=true").
    //
    // This is a keepalive, not a substitute for the page's own retry: a
    // genuinely dead desktop must still surface as a disconnect.
    `--heartbeat=${opts.heartbeatSec ?? WEBSOCKET_HEARTBEAT_SEC}`,
    String(opts.listenPort),
    `127.0.0.1:${opts.vncPort}`,
  ];
}

/** TCP liveness probe: the only honest answer to "is the port up?". */
function portOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export class DesktopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopError';
  }
}

export class Desktop {
  private static procs = new Map<DesktopComponent, ChildProcess>();
  private static lastError = '';
  private static passwordFile = '';

  static get display(): string {
    return process.env.DISPLAY || config.REAL_CHROME_DISPLAY || ':99';
  }

  static isRunning(): boolean {
    return this.procs.size > 0;
  }

  private static async novncRoot(): Promise<string> {
    if (config.DESKTOP_NOVNC_WEB_ROOT) return config.DESKTOP_NOVNC_WEB_ROOT;
    for (const root of NOVNC_ROOTS) {
      try {
        const st = await fs.stat(root);
        if (st.isDirectory()) return root;
      } catch { /* keep looking */ }
    }
    return '';
  }

  /** Which of the three binaries are not installed. */
  static async missingBinaries(): Promise<string[]> {
    const missing: string[] = [];
    for (const bin of ['Xvfb', 'x11vnc', 'websockify']) {
      if (!(await which(bin))) missing.push(bin);
    }
    return missing;
  }

  /** Is there an X display to draw on right now? */
  static async displayUp(): Promise<boolean> {
    const displayNum = this.display.replace(/^:/, '').split('.')[0];
    // The lock file is X's own "this display is taken" marker, and the socket
    // proves a server is actually listening on it. Either is enough evidence
    // for a display we did not start ourselves (an operator's own Xvfb, a real
    // desktop session, an X forwarded over SSH).
    const lock = await fs.stat(`/tmp/.X${displayNum}-lock`).then(() => true).catch(() => false);
    if (lock) return true;
    return fs.stat(`/tmp/.X11-unix/X${displayNum}`).then(() => true).catch(() => false);
  }

  /**
   * Bring up ONLY the X display — the single thing a headed Chrome requires.
   *
   * Split out of `start()` because the two needs are not the same need: Chrome
   * needs the pixels to exist, a human needs to see them. Bundling them meant a
   * box with xvfb but without x11vnc/websockify (very common — those two are
   * exactly what people refuse to install on a server) could not run a headed
   * Chrome AT ALL, and failed with "Missing: x11vnc, websockify": a message
   * about a viewer, shown to someone who only asked for a browser.
   */
  static async ensureDisplay(): Promise<void> {
    if (await this.displayUp()) {
      process.env.DISPLAY = this.display;
      return;
    }

    if (!(await which('Xvfb'))) {
      this.lastError = `Missing: Xvfb. ${DISPLAY_INSTALL_HINT}`;
      throw new DesktopError(this.lastError);
    }

    const display = this.display;
    const displayNum = display.replace(/^:/, '').split('.')[0];
    const lock = `/tmp/.X${displayNum}-lock`;

    if (!this.procs.has('xvfb')) {
      const w = config.REAL_CHROME_WINDOW_WIDTH || 1280;
      const h = config.REAL_CHROME_WINDOW_HEIGHT || 800;
      this.spawnTracked('xvfb', 'Xvfb', [
        display,
        '-screen', '0', `${w}x${h}x24`,
        '-nolisten', 'tcp',      // the display itself is never on the network
        '-ac',
      ]);
      await this.waitFor(() => fs.stat(lock).then(() => true).catch(() => false), 8000,
        `Xvfb did not create ${lock}`);
    }

    // Chrome (and anything else we spawn later) must see this display.
    process.env.DISPLAY = display;

    await this.ensureWindowManager();
  }

  /**
   * Start a window manager on the display — THE FIX FOR "MY TABS DISAPPEAR".
   *
   * A bare Xvfb has no window manager. Nothing is then responsible for mapping,
   * stacking, focusing or decorating top-level windows, and X simply stacks
   * them at the coordinates the client asked for. Chrome mostly survives this
   * with ONE window, which is why the setup looked fine — until a second
   * top-level window appeared (a popup, a devtools window, an extension
   * options page, a `target=_blank` that Chrome decides to open detached, or a
   * new window instead of a new tab). That window is then unmanaged: it cannot
   * be raised, focused, moved or closed, and it is usually invisible behind or
   * outside the first one.
   *
   * MEASURED on this box, before the fix:
   *   xwininfo -root -children  ->  "Example Domain - Chromium"  1288x851+10+10
   *   /browser/tabs             ->  TWO tabs (example.com, example.org)
   *   the screenshot            ->  ONE tab visible, no title bar
   * so the second page was live, automatable and completely unreachable by the
   * human. That is exactly the reported "تب ها گم میشن".
   *
   * After starting openbox, the same check reports a decorated, managed window
   * whose tab strip shows BOTH tabs.
   *
   * Failure here is deliberately NOT fatal: a missing WM makes the desktop
   * awkward, not unusable, and refusing to start the screen over it would take
   * away the working half of the feature.
   */
  /**
   * The size of the X screen, as X itself reports it.
   *
   * WHY THIS EXISTS. The operator reported that only part of the tab showed the
   * browser and the rest was black:
   *   «از ۱۰۰ در ۱۰۰ صفحه فقط شاید ۶۰ درصدش رو مرورگر گرفته بود بقیه جاها الکی
   *    مشکی بودن باید مثل مرورگر واقعی کل صفحه رو بگیره»
   *
   * MEASURED cause -- the window is simply smaller than the screen:
   *   screen 1600x900, Chrome window 1288x811+10+10  ->  COVERAGE 72.5%
   *
   * The window size came from REAL_CHROME_WINDOW_* (default 1280x800) while the
   * screen came from the same settings only when Desktop started Xvfb. Any
   * externally started Xvfb -- which is how it runs here, and how most people
   * run it -- leaves the two disagreeing, and the difference is painted black.
   * Asking X removes the guess.
   */
  static async screenSize(): Promise<{ width: number; height: number } | null> {
    return execFileAsync('xdpyinfo', ['-display', this.display])
      .then((r) => parseScreenSize(r.stdout))
      .catch(() => null); // xdpyinfo absent or display down — caller falls back
  }

  private static async ensureWindowManager(): Promise<void> {
    if (this.procs.has('wm')) return;
    // Ask X, not our own process table: after an app restart a WM from the
    // previous run (or one the operator started) is still managing the display,
    // and spawning a second one just fails with "another window manager is
    // already running" while poisoning lastError. See wmRunning().
    if (await wmRunning(this.display)) return;
    for (const wm of WM_CANDIDATES) {
      if (!(await which(wm))) continue;
      // fluxbox is quieter about a missing config if told where to look; both
      // accept being run with no arguments, so keep it simple and portable.
      this.spawnTracked('wm', wm, []);
      // Give it a moment to become the manager before Chrome maps a window;
      // a WM that arrives late does not retroactively manage what X already
      // mapped without one.
      await new Promise((r) => setTimeout(r, 600));
      return;
    }
    this.lastError =
      'No window manager found (openbox/fluxbox). Extra Chrome windows may be ' +
      'unreachable. Install one: sudo apt-get install -y openbox';
  }

  /**
   * Start Xvfb → x11vnc → websockify, skipping anything already listening.
   *
   * Idempotent on purpose: the UI button is going to be pressed twice, and a
   * second Xvfb on the same display would fail with a lock error that reads
   * like a real problem.
   */
  static async start(): Promise<DesktopStatus> {
    // The display first and on its own: when the viewer packages are missing we
    // still want the screen up, because that is the half that unblocks Chrome.
    await this.ensureDisplay();

    const missing: string[] = [];
    for (const bin of ['x11vnc', 'websockify']) {
      if (!(await which(bin))) missing.push(bin);
    }
    if (missing.length) {
      this.lastError = `Missing: ${missing.join(', ')}. ${INSTALL_HINT}`;
      throw new DesktopError(this.lastError);
    }

    const display = this.display;


    // ── x11vnc ──────────────────────────────────────────────────────────────
    if (!(await portOpen(config.DESKTOP_VNC_PORT))) {
      if (config.DESKTOP_VNC_PASSWORD) {
        this.passwordFile = path.join(os.tmpdir(), `.vncpass-${process.pid}`);
        await execFileAsync('x11vnc', [
          '-storepasswd', config.DESKTOP_VNC_PASSWORD, this.passwordFile,
        ]);
        // 0600: the file is a plaintext-equivalent credential.
        await fs.chmod(this.passwordFile, 0o600).catch(() => {});
      }

      const args = x11vncArgs({
        display,
        rfbPort: config.DESKTOP_VNC_PORT,
        passwordFile: config.DESKTOP_VNC_PASSWORD ? this.passwordFile : '',
      });

      this.spawnTracked('x11vnc', 'x11vnc', args);
      await this.waitFor(() => portOpen(config.DESKTOP_VNC_PORT), 8000,
        `x11vnc did not listen on ${config.DESKTOP_VNC_PORT}`);
    }

    // ── websockify + noVNC ──────────────────────────────────────────────────
    if (!(await portOpen(config.DESKTOP_NOVNC_PORT))) {
      const web = await this.novncRoot();
      if (!web) {
        this.lastError =
          'noVNC static files were not found. Install the `novnc` package, or set ' +
          'DESKTOP_NOVNC_WEB_ROOT to the directory containing vnc.html.';
        throw new DesktopError(this.lastError);
      }
      this.spawnTracked('novnc', 'websockify', websockifyArgs({
        webRoot: web,
        listenPort: config.DESKTOP_NOVNC_PORT,
        vncPort: config.DESKTOP_VNC_PORT,
      }));
      await this.waitFor(() => portOpen(config.DESKTOP_NOVNC_PORT), 10000,
        `websockify did not listen on ${config.DESKTOP_NOVNC_PORT}`);
    }

    this.lastError = '';
    return this.status();
  }

  private static spawnTracked(key: DesktopComponent, bin: string, args: string[]): void {
    const child = spawn(bin, args, {
      // Detached so a restart of this Node process does not tear the screen
      // (and the Chrome on it) down mid-session.
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: this.display },
    });
    child.unref();
    child.on('exit', () => { this.procs.delete(key); });
    child.on('error', (e) => {
      this.lastError = `${bin}: ${e.message}`;
      this.procs.delete(key);
    });
    this.procs.set(key, child);
  }

  private static async waitFor(
    probe: () => Promise<boolean>,
    timeoutMs: number,
    failMessage: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.lastError = failMessage;
    throw new DesktopError(failMessage);
  }

  static async stop(): Promise<void> {
    for (const [key, child] of [...this.procs.entries()]) {
      this.procs.delete(key);
      try {
        // Negative pid = the whole detached process group, otherwise
        // websockify's child python survives and keeps the port.
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }
    }
    if (this.passwordFile) {
      await fs.unlink(this.passwordFile).catch(() => {});
      this.passwordFile = '';
    }
  }

  static async status(): Promise<DesktopStatus> {
    // The WM is reported against whichever candidate is installed, so the UI
    // can say "openbox missing" rather than naming one the operator never
    // chose. Reported separately from the others because a missing WM degrades
    // the desktop instead of breaking it.
    let wmBin = '';
    for (const wm of WM_CANDIDATES) {
      if (await which(wm)) { wmBin = wm; break; }
    }

    const bins: Record<DesktopComponent, string> = {
      xvfb: 'Xvfb',
      wm: wmBin || WM_CANDIDATES[0],
      x11vnc: 'x11vnc',
      novnc: 'websockify',
    };

    const missing: string[] = [];
    for (const bin of ['Xvfb', 'x11vnc', 'websockify']) {
      if (!(await which(bin))) missing.push(bin);
    }
    if (!wmBin) missing.push(WM_CANDIDATES[0]);

    const xvfbUp = await this.displayUp();
    const vncUp = await portOpen(config.DESKTOP_VNC_PORT);
    const novncUp = await portOpen(config.DESKTOP_NOVNC_PORT);
    // A WM we spawned and that is still alive. `procs` is the honest source:
    // an operator-started WM we did not spawn is not ours to report as ours.
    // Whether the display is MANAGED, not whether we own the manager. A WM
    // left over from a previous run of this app manages windows just as well.
    const wmUp = xvfbUp && (await wmRunning(this.display));

    const comp = (key: DesktopComponent, up: boolean) => ({
      running: up,
      pid: this.procs.get(key)?.pid ?? 0,
      missing: missing.includes(bins[key]),
    });

    return {
      enabled: config.DESKTOP_ENABLED === true,
      running: xvfbUp && vncUp && novncUp,
      displayRunning: xvfbUp,
      display: this.display,
      vncPort: config.DESKTOP_VNC_PORT,
      novncPort: config.DESKTOP_NOVNC_PORT,
      // `resize=remote` makes the noVNC canvas ask the server to match the
      // browser window, so the Chrome window is not letterboxed in a corner.
      novncPath: '/vnc.html?autoconnect=1&resize=remote',
      passwordProtected: !!config.DESKTOP_VNC_PASSWORD,
      components: {
        xvfb: comp('xvfb', xvfbUp),
        wm: comp('wm', wmUp),
        x11vnc: comp('x11vnc', vncUp),
        novnc: comp('novnc', novncUp),
      },
      missing,
      installHint: INSTALL_HINT,
      lastError: this.lastError,
    };
  }
}
