/**
 * Is the virtual display MANAGED by a window manager?
 *
 * WHY THIS EXISTS
 * ---------------
 * A missing window manager was the root cause of the reported "تب ها گم میشن"
 * (tabs get lost): on a bare Xvfb nothing maps, stacks, focuses or decorates a
 * top-level window, so Chrome's second window was live and automatable but
 * completely invisible and unreachable.
 *
 * The first fix started openbox and then reported it by asking "is the child we
 * spawned still alive?". MEASURED (2026-08-11) after the app restarted:
 *
 *   pgrep -a openbox                → 3267 openbox      (managing :99)
 *   GET /browser/desktop/status     → wm.running = false
 *
 * A restarted process has no children, so a perfectly healthy desktop was
 * reported as broken — and worse, ensureWindowManager then spawned a SECOND
 * openbox, which exits instantly ("another window manager is already running")
 * and poisons lastError. Ownership was never the question; whether windows get
 * managed is. Every EWMH window manager announces itself with
 * _NET_SUPPORTING_WM_CHECK on the root window, so we ask X instead.
 *
 * The strings below are not invented. They are the verbatim stdout of the real
 * `xprop` binary against a real Xvfb, captured in both states.
 */

import { describe, it, expect } from 'vitest';
import { displayIsManaged } from '../../src/core/Desktop';

// Captured from: xprop -root -display :77 _NET_SUPPORTING_WM_CHECK
const REAL_NO_WM = '_NET_SUPPORTING_WM_CHECK:  no such atom on any window.\n';
const REAL_OPENBOX = '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x20011f\n';

describe('displayIsManaged', () => {
  it('says NO for a bare Xvfb — the state that lost the tabs', () => {
    expect(displayIsManaged(REAL_NO_WM)).toBe(false);
  });

  it('says YES once openbox is managing the display', () => {
    expect(displayIsManaged(REAL_OPENBOX)).toBe(true);
  });

  it('does not rely on the exit code, which is 0 in BOTH real cases', () => {
    // This is the trap: `xprop` succeeds even when the atom is absent, so a
    // check built on exit status would report every display as managed.
    // Both strings come back with rc=0; only the content differs.
    expect(displayIsManaged(REAL_NO_WM)).not.toBe(displayIsManaged(REAL_OPENBOX));
  });

  it('is window-manager agnostic — any EWMH WM sets the same atom', () => {
    // fluxbox / i3 / mutter differ only in the window id they publish.
    expect(displayIsManaged('_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400003\n')).toBe(true);
    expect(displayIsManaged('_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0xa00001\n')).toBe(true);
  });

  it('treats an unreachable display as unmanaged, never as managed', () => {
    // Real stderr text when the X server is not there at all.
    expect(displayIsManaged("xprop:  unable to open display ':78'\n")).toBe(false);
  });

  it('treats empty output as unmanaged', () => {
    expect(displayIsManaged('')).toBe(false);
  });

  it('does not accept the atom name alone as proof of a manager', () => {
    // The atom being mentioned is not the same as a window being published;
    // the "no such atom" line mentions it too.
    expect(displayIsManaged('_NET_SUPPORTING_WM_CHECK')).toBe(false);
  });

  it('requires a real hex id, not the word "window"', () => {
    expect(displayIsManaged('window id # none')).toBe(false);
    expect(displayIsManaged('some window somewhere')).toBe(false);
  });
});
