/**
 * The remote Chromium view: fills the screen, and stays connected.
 *
 * These pin the two fixes for the operator's report:
 *
 *   1. «از ۱۰۰ در ۱۰۰ صفحه فقط شاید ۶۰ درصدش رو مرورگر گرفته بود بقیه جاها
 *      الکی مشکی بودن باید مثل مرورگر واقعی کل صفحه رو بگیره»
 *      -- MEASURED: screen 1600x900, Chrome window 1288x811+10+10, i.e. 72.5%
 *      coverage. The other 27.5% is bare X root window, which is black. Fixed
 *      by asking X for the screen size and matching it, at position 0,0.
 *      After: window 1599x899+0+0 -> 99.8% coverage.
 *
 *   2. «خیلی سریع ارتباط قطع میشه ... بعد ۱۰ ثانیه مرورگر رفت و یه چیزی اومد
 *      که میگفت اتصال مجدد. این رو اعصابه هر بار قطع وصلی»
 *      -- an idle VNC WebSocket carries no traffic while the screen is still,
 *      and idle sockets are what reverse proxies reap. Fixed with
 *      websockify --heartbeat.
 *
 * WHAT THESE TESTS DO NOT DO
 * --------------------------
 * They do not grep the source for a flag. Every assertion here calls the SAME
 * function production calls to build the argument vector, and checks the vector
 * it returns -- so deleting the flag from production breaks these tests, and
 * satisfying these tests requires the flag to actually reach the process.
 *
 * The strings quoted as ground truth are verbatim output of the real binaries
 * on this machine, captured with `xdpyinfo`, `x11vnc -help` and
 * `websockify --help`.
 */

import { describe, it, expect } from 'vitest';
import {
  parseScreenSize,
  x11vncArgs,
  websockifyArgs,
  WEBSOCKET_HEARTBEAT_SEC,
  Desktop,
} from '../../src/core/Desktop';
import { windowArgs } from '../../src/core/RealChrome';
import { config } from '../../src/config';

// Verbatim stdout of `DISPLAY=:99 xdpyinfo | grep dimensions` on a real Xvfb
// started as `Xvfb :99 -screen 0 1600x900x24`.
const REAL_XDPYINFO_LINE =
  '  dimensions:    1600x900 pixels (406x229 millimeters)';

/** Read the value of a `--flag=value` / `--flag value` style argument. */
function flagValue(argv: string[], flag: string): string | null {
  for (const a of argv) {
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return null;
}

describe('parseScreenSize — how big is the screen really?', () => {
  it('reads the real xdpyinfo line', () => {
    expect(parseScreenSize(REAL_XDPYINFO_LINE)).toEqual({ width: 1600, height: 900 });
  });

  it('is not fooled by the millimetre pair that follows on the same line', () => {
    // "406x229 millimeters" must never be mistaken for the pixel size, or the
    // window would be built 406px wide and the screen would be ~99% black.
    const got = parseScreenSize(REAL_XDPYINFO_LINE);
    expect(got).not.toEqual({ width: 406, height: 229 });
  });

  it('finds the line inside the full multi-line xdpyinfo report', () => {
    const full = [
      'name of display:    :99',
      'version number:    11.0',
      'screen #0:',
      REAL_XDPYINFO_LINE,
      '  resolution:    100x100 dots per inch',
    ].join('\n');
    expect(parseScreenSize(full)).toEqual({ width: 1600, height: 900 });
  });

  it('returns null when there is no dimensions line at all', () => {
    // xdpyinfo failing (no display, not installed) must not become a 0x0 window.
    expect(parseScreenSize('')).toBeNull();
    expect(parseScreenSize('xdpyinfo: unable to open display ":99".')).toBeNull();
  });

  it('returns null for a degenerate 0x0 screen rather than a zero-size window', () => {
    expect(parseScreenSize('  dimensions:    0x0 pixels (0x0 millimeters)')).toBeNull();
  });
});

describe('Desktop.screenSize — against the live X server', () => {
  it('reports the size of the display it is pointed at, or null with no display', async () => {
    const got = await Desktop.screenSize();
    // The suite must pass on a box with no X at all, so both outcomes are
    // legal -- but a non-null answer has to be a usable, positive size.
    if (got === null) return;
    expect(got.width).toBeGreaterThan(0);
    expect(got.height).toBeGreaterThan(0);
  });

  it('never throws when xdpyinfo cannot answer', async () => {
    // Point it at a display that does not exist. A rejection here would
    // propagate into Chrome's launch and take the whole browser down instead
    // of falling back to the configured size.
    const prev = process.env.DISPLAY;
    process.env.DISPLAY = ':4242';
    try {
      await expect(Desktop.screenSize()).resolves.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prev;
    }
  });
});

describe('windowArgs — the browser fills the screen', () => {
  it('sizes the window to the screen X reported, not to the configured default', () => {
    const argv = windowArgs({ width: 1600, height: 900 });
    expect(flagValue(argv, '--window-size')).toBe('1600,900');
    // The bug was the window following REAL_CHROME_WINDOW_* (1280x800) while
    // the screen was 1600x900. If the configured size wins, the margin is back.
    expect(flagValue(argv, '--window-size')).not.toBe(
      `${config.REAL_CHROME_WINDOW_WIDTH},${config.REAL_CHROME_WINDOW_HEIGHT}`,
    );
  });

  it('pins the window to the top-left corner', () => {
    // A window sized to the whole screen but offset by +10+10 still hangs off
    // the bottom-right, leaving an L-shaped black margin. MEASURED: the window
    // really was at +10+10.
    expect(windowArgs({ width: 1600, height: 900 })).toContain('--window-position=0,0');
  });

  it('covers essentially the whole screen — measured as an area ratio', () => {
    const screen = { width: 1600, height: 900 };
    const size = flagValue(windowArgs(screen), '--window-size') || '';
    const [w, h] = size.split(',').map(Number);
    const coverage = (w * h) / (screen.width * screen.height);
    // BEFORE this fix the same calculation gave 0.725 (72.5%), which is the
    // "60 percent" the operator was describing.
    expect(coverage).toBeGreaterThan(0.99);
  });

  it('falls back to the configured size when there is no display to ask', () => {
    // headless, or xdpyinfo missing: screenSize() returns null and the
    // configured size is the only information available.
    const argv = windowArgs(null);
    expect(flagValue(argv, '--window-size')).toBe(
      `${config.REAL_CHROME_WINDOW_WIDTH},${config.REAL_CHROME_WINDOW_HEIGHT}`,
    );
  });

  it('never emits a zero or negative window size', () => {
    for (const screen of [null, { width: 0, height: 0 }, { width: 1600, height: 900 }]) {
      const size = flagValue(windowArgs(screen), '--window-size') || '';
      const [w, h] = size.split(',').map(Number);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });

  it('tracks a screen that is not the one we measured, proving nothing is hardcoded', () => {
    expect(flagValue(windowArgs({ width: 2560, height: 1440 }), '--window-size'))
      .toBe('2560,1440');
  });
});

describe('websockifyArgs — the socket stays alive', () => {
  it('sends a heartbeat, so an idle screen does not look like a dead connection', () => {
    const argv = websockifyArgs({ webRoot: '/usr/share/novnc', listenPort: 6080, vncPort: 5900 });
    // `--heartbeat=INTERVAL  send a ping to the client every INTERVAL seconds`
    // -- verbatim from `websockify --help` on this machine.
    const hb = flagValue(argv, '--heartbeat');
    expect(hb, 'no --heartbeat in the websockify argv').not.toBeNull();
    expect(Number(hb)).toBe(WEBSOCKET_HEARTBEAT_SEC);
  });

  it('pings well inside the idle timeouts that actually reap sockets', () => {
    // nginx's proxy_read_timeout defaults to 60s and hosted tunnels are more
    // aggressive still. A heartbeat only helps if it fires several times inside
    // that window, so it must be comfortably below it -- and above zero, since
    // websockify treats 0 as "no heartbeat".
    expect(WEBSOCKET_HEARTBEAT_SEC).toBeGreaterThan(0);
    expect(WEBSOCKET_HEARTBEAT_SEC).toBeLessThan(30);
  });

  it('serves the noVNC root it was given and bridges to the VNC port', () => {
    const argv = websockifyArgs({ webRoot: '/opt/novnc', listenPort: 6081, vncPort: 5901 });
    expect(flagValue(argv, '--web')).toBe('/opt/novnc');
    // Positional: [listen] [target]. Order matters to websockify.
    expect(argv).toContain('6081');
    expect(argv).toContain('127.0.0.1:5901');
    expect(argv.indexOf('6081')).toBeLessThan(argv.indexOf('127.0.0.1:5901'));
  });

  it('bridges to loopback only — the raw VNC port is never dialled over the network', () => {
    const argv = websockifyArgs({ webRoot: '/usr/share/novnc', listenPort: 6080, vncPort: 5900 });
    const target = argv[argv.length - 1];
    expect(target.startsWith('127.0.0.1:')).toBe(true);
  });
});

describe('x11vncArgs — the flags that were nearly wrong', () => {
  it('never passes -timeout, which would make the server exit on its own', () => {
    // Verbatim from `x11vnc -help`:
    //   "-timeout n   Exit unless a client connects within the first n seconds
    //    after startup."
    // An earlier draft added `-timeout 0` believing it meant "no timeout". It
    // does not; it kills the server. This is the guard against that returning.
    const argv = x11vncArgs({ display: ':99', rfbPort: 5900 });
    expect(argv).not.toContain('-timeout');
  });

  it('never passes -nevershared, which takes no argument and contradicts -shared', () => {
    // `-nevershared   never treat new clients as shared` -- a bare flag, so
    // `-nevershared no` is a parse error, and the semantics are the opposite
    // of the -shared we rely on.
    const argv = x11vncArgs({ display: ':99', rfbPort: 5900 });
    expect(argv).not.toContain('-nevershared');
    expect(argv).toContain('-shared');
  });

  it('follows XRANDR resizes instead of assuming the screen never moves', () => {
    const argv = x11vncArgs({ display: ':99', rfbPort: 5900 });
    expect(flagValue(argv, '-xrandr')).toBe('resize');
  });

  it('survives a viewer disconnecting, so a reconnect finds the desktop still there', () => {
    expect(x11vncArgs({ display: ':99', rfbPort: 5900 })).toContain('-forever');
  });

  it('binds to localhost — websockify is the only client', () => {
    expect(x11vncArgs({ display: ':99', rfbPort: 5900 })).toContain('-localhost');
  });

  it('uses the password file when there is one, and -nopw only when there is not', () => {
    const withPw = x11vncArgs({ display: ':99', rfbPort: 5900, passwordFile: '/tmp/.vncpass-1' });
    expect(flagValue(withPw, '-rfbauth')).toBe('/tmp/.vncpass-1');
    expect(withPw).not.toContain('-nopw');

    const noPw = x11vncArgs({ display: ':99', rfbPort: 5900 });
    expect(noPw).toContain('-nopw');
    expect(noPw).not.toContain('-rfbauth');
  });

  it('serves the display and port it was told to', () => {
    const argv = x11vncArgs({ display: ':7', rfbPort: 5999 });
    expect(flagValue(argv, '-display')).toBe(':7');
    expect(flagValue(argv, '-rfbport')).toBe('5999');
  });
});
