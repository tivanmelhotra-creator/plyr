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

export type DesktopComponent = 'xvfb' | 'x11vnc' | 'novnc';

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
  'Install the virtual display stack: sudo apt-get install -y xvfb x11vnc novnc websockify ' +
  '(or run: bash scripts/desktop.sh install).';

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
      const args = [
        '-display', display,
        '-rfbport', String(config.DESKTOP_VNC_PORT),
        '-localhost',      // websockify is the only client; never expose raw VNC
        '-forever',        // survive a viewer disconnecting
        '-shared',
        '-noxdamage',
        '-quiet',
      ];

      if (config.DESKTOP_VNC_PASSWORD) {
        this.passwordFile = path.join(os.tmpdir(), `.vncpass-${process.pid}`);
        await execFileAsync('x11vnc', [
          '-storepasswd', config.DESKTOP_VNC_PASSWORD, this.passwordFile,
        ]);
        // 0600: the file is a plaintext-equivalent credential.
        await fs.chmod(this.passwordFile, 0o600).catch(() => {});
        args.push('-rfbauth', this.passwordFile);
      } else {
        args.push('-nopw');
      }

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
      this.spawnTracked('novnc', 'websockify', [
        '--web', web,
        String(config.DESKTOP_NOVNC_PORT),
        `127.0.0.1:${config.DESKTOP_VNC_PORT}`,
      ]);
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
    const bins: Record<DesktopComponent, string> = {
      xvfb: 'Xvfb',
      x11vnc: 'x11vnc',
      novnc: 'websockify',
    };

    const missing: string[] = [];
    for (const bin of Object.values(bins)) {
      if (!(await which(bin))) missing.push(bin);
    }

    const xvfbUp = await this.displayUp();
    const vncUp = await portOpen(config.DESKTOP_VNC_PORT);
    const novncUp = await portOpen(config.DESKTOP_NOVNC_PORT);

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
        x11vnc: comp('x11vnc', vncUp),
        novnc: comp('novnc', novncUp),
      },
      missing,
      installHint: INSTALL_HINT,
      lastError: this.lastError,
    };
  }
}
