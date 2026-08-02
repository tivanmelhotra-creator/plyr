/**
 * Desktop — the display half of the virtual screen.
 *
 * These tests are about WORDS, not processes. The bug they guard against was
 * never a crash: a headed Chrome could not start, and every message the user
 * saw pointed at something that would not fix it —
 *
 *   Chrome  → "Missing X server"                (no package, no command)
 *   the app → "run bash scripts/desktop.sh start"
 *   that script → "Xvfb: command not found"     (back where we started)
 *
 * So the guidance string is extracted as a pure function and pinned here: it
 * must name the package when the package is what is missing, and must always
 * offer the headless escape hatch together with its cost (no extensions).
 */

import { describe, it, expect } from 'vitest';
import { displayGuidance, DISPLAY_INSTALL_HINT, Desktop } from '../../src/core/Desktop';

describe('displayGuidance', () => {
  it('names the apt package when Xvfb itself is missing', () => {
    const msg = displayGuidance(['Xvfb', 'x11vnc', 'websockify'], ':99');
    expect(msg).toContain('apt-get install -y xvfb');
    // Telling someone to start a script whose binary is absent is the loop.
    expect(msg).not.toContain('desktop.sh start');
  });

  it('tells you to start the screen when the binary IS installed', () => {
    const msg = displayGuidance(['x11vnc'], ':99');
    expect(msg).toContain('bash scripts/desktop.sh start');
    expect(msg).not.toContain('apt-get install -y xvfb');
  });

  it('always states the display it tried, so :99 vs :0 is visible', () => {
    expect(displayGuidance([], ':7')).toContain(':7');
    expect(displayGuidance(['Xvfb'], 'unset')).toContain('unset');
  });

  it('offers headless as an escape hatch AND states what it costs', () => {
    const msg = displayGuidance(['Xvfb'], ':99');
    expect(msg).toContain('REAL_CHROME_HEADLESS=true');
    expect(msg).toMatch(/NO extensions/i);
  });

  it('explains why a headed browser is needed at all', () => {
    expect(displayGuidance([], ':99')).toMatch(/extensions only load in a headed chrome/i);
  });
});

describe('DISPLAY_INSTALL_HINT', () => {
  it('asks only for xvfb — the viewer packages are a separate decision', () => {
    expect(DISPLAY_INSTALL_HINT).toContain('xvfb');
    expect(DISPLAY_INSTALL_HINT).not.toContain('x11vnc');
    expect(DISPLAY_INSTALL_HINT).not.toContain('websockify');
  });
});

describe('Desktop.status', () => {
  it('reports the display separately from the whole viewable desktop', async () => {
    const st = await Desktop.status();
    // The contract the UI depends on: "can Chrome draw?" is answerable even
    // when x11vnc/websockify were never installed.
    expect(typeof st.displayRunning).toBe('boolean');
    expect(typeof st.running).toBe('boolean');
    // A viewable desktop implies a display; the reverse is not implied.
    if (st.running) expect(st.displayRunning).toBe(true);
  });

  it('lists missing binaries by their real command names', async () => {
    const missing = await Desktop.missingBinaries();
    for (const bin of missing) {
      expect(['Xvfb', 'x11vnc', 'websockify']).toContain(bin);
    }
  });
});
