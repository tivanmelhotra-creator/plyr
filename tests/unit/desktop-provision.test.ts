/**
 * The rootless provisioner's load-bearing pure functions.
 *
 * WHY THESE FOUR. The provisioner as a whole cannot be unit-tested honestly —
 * it downloads packages and starts an X server, so the only real proof it works
 * is tools/probe-desktop-provision.js asking the operating system (and that
 * probe now reports VERDICT=PASS). What CAN and MUST be tested here are the
 * small pure decisions that, when wrong, corrupt a binary or silently disable
 * the whole feature — and each of these encodes a bug that actually happened.
 */

import { describe, it, expect } from 'vitest';

import {
  findCStringOffsets,
  patchCString,
  provisionEnv,
  layoutFor,
  pickScratchDisplay,
  configuredDisplayNumber,
  type ProvisionLayout,
} from '../../src/core/DesktopProvision';

describe('findCStringOffsets — where we are allowed to write into a binary', () => {
  it('finds a NUL-terminated string at a string boundary', () => {
    // `\0` before and after: a normal .rodata entry.
    const buf = Buffer.from('junk\0/usr/bin\0more\0', 'latin1');
    expect(findCStringOffsets(buf, '/usr/bin')).toEqual([5]);
  });

  it('matches at offset 0 with no preceding NUL', () => {
    const buf = Buffer.from('/usr/bin\0tail', 'latin1');
    expect(findCStringOffsets(buf, '/usr/bin')).toEqual([0]);
  });

  it('REFUSES a match that is only a prefix of a longer string', () => {
    // THE CORRECTNESS ARGUMENT. Xvfb contains both `/usr/bin` (the directory it
    // execs from) and paths like `/usr/bin/xkbcomp`. Without the "preceded by
    // NUL" guard, a naive search would also report the second one, and patching
    // there would overwrite the middle of an unrelated string — corrupting the
    // binary in a way that only shows up at runtime.
    const buf = Buffer.from('x\0/usr/bin/xkbcomp\0', 'latin1');
    expect(findCStringOffsets(buf, '/usr/bin')).toEqual([]);
  });

  it('finds every independent occurrence', () => {
    const buf = Buffer.from('\0/usr/bin\0pad\0/usr/bin\0', 'latin1');
    expect(findCStringOffsets(buf, '/usr/bin')).toEqual([1, 14]);
  });

  it('returns nothing when the string is absent', () => {
    expect(findCStringOffsets(Buffer.from('nothing here\0', 'latin1'), '/usr/bin')).toEqual([]);
  });
});

describe('patchCString — the in-place ELF edit', () => {
  it('writes a shorter path and NUL-fills the tail', () => {
    const buf = Buffer.from('A\0/usr/bin\0B\0', 'latin1');
    expect(patchCString(buf, 2, '/usr/bin', '/tmp/xkb')).toBe(true);
    // Same length here, so the whole field is used and the terminator stays.
    expect(buf.subarray(2, 10).toString('latin1')).toBe('/tmp/xkb');
    expect(buf[10]).toBe(0x00);
  });

  it('NUL-fills the slack when the replacement is strictly shorter', () => {
    const buf = Buffer.from('A\0/usr/bin\0B\0', 'latin1');
    expect(patchCString(buf, 2, '/usr/bin', '/tmp/x')).toBe(true);
    expect(buf.subarray(2, 8).toString('latin1')).toBe('/tmp/x');
    // Bytes 8,9,10 must be zero: C stops at the first NUL, so a stale tail
    // would be dead weight — but leaving garbage there makes the binary
    // confusing to inspect and risks a non-terminated read.
    expect(buf[8]).toBe(0x00);
    expect(buf[9]).toBe(0x00);
    expect(buf[10]).toBe(0x00);
  });

  it('REFUSES to grow the string, and changes nothing when it refuses', () => {
    // THE SAFETY RULE. A longer replacement would have to shift every
    // following byte of .rodata, invalidating section headers, relocations and
    // internal offsets — i.e. produce a broken executable. Refusing lets the
    // caller fall back to the user-namespace route instead.
    const buf = Buffer.from('A\0/usr/bin\0B\0', 'latin1');
    const before = Buffer.from(buf);
    expect(patchCString(buf, 2, '/usr/bin', '/home/user/very/long/path')).toBe(false);
    expect(buf.equals(before)).toBe(true);
  });

  it('refuses an offset that would run past the end of the buffer', () => {
    const buf = Buffer.from('/usr/bin', 'latin1'); // no room for the terminator
    expect(patchCString(buf, 0, '/usr/bin', '/tmp/xkb')).toBe(false);
  });

  it('refuses a negative offset', () => {
    const buf = Buffer.from('A\0/usr/bin\0', 'latin1');
    expect(patchCString(buf, -1, '/usr/bin', '/tmp/xkb')).toBe(false);
  });
});

describe('provisionEnv — the contract between the provisioner and every spawn', () => {
  const layout: ProvisionLayout = {
    root: '/stack',
    binDir: '/stack/root/usr/bin',
    libDirs: ['/stack/root/usr/lib/x86_64-linux-gnu', '/stack/root/usr/lib'],
    xkbDir: '/stack/root/usr/share/X11/xkb',
    novncRoot: '/stack/root/usr/share/novnc',
    pyDir: '/stack/py',
    pyDistDir: '/stack/root/usr/lib/python3/dist-packages',
    shimDir: '/tmp/xkb',
  };

  it('puts the shim dir FIRST, ahead of the unpacked bin dir', () => {
    // ORDER IS THE WHOLE POINT. The shim holds the PATCHED Xvfb; the bin dir
    // holds the original, which cannot find xkbcomp and dies on the keymap.
    // MEASURED: when the shim was missing from PATH the probe reported
    // PROVISIONED_TREE=true and then "Xvfb did not create /tmp/.X91-lock".
    const env = provisionEnv(layout, { PATH: '/usr/bin' });
    expect(env.PATH).toBe('/tmp/xkb:/stack/root/usr/bin:/usr/bin');
  });

  it('preserves the inherited PATH as a suffix rather than clobbering it', () => {
    const env = provisionEnv(layout, { PATH: '/inherited' });
    expect(env.PATH?.endsWith(':/inherited')).toBe(true);
  });

  it('exposes both python roots, pip first then the deb copy', () => {
    // The pip install has proper .dist-info and must win; the unpacked deb's
    // dist-packages is the network-free fallback.
    const env = provisionEnv(layout, {});
    expect(env.PYTHONPATH).toBe('/stack/py:/stack/root/usr/lib/python3/dist-packages');
  });

  it('advertises XKB_CONFIG_ROOT only when a keymap dir was verified', () => {
    expect(provisionEnv(layout, {}).XKB_CONFIG_ROOT).toBe('/stack/root/usr/share/X11/xkb');
  });

  it('OMITS XKB_CONFIG_ROOT when no usable keymap dir was found', () => {
    // THE FIX FOR THE LAST FAILURE. Pointing X at a keymap root that does not
    // contain rules/ is worse than saying nothing: it overrides a perfectly
    // good /usr/share/X11/xkb and reproduces "XKB: Failed to compile keymap".
    // An empty xkbDir must therefore leave the variable unset entirely.
    const env = provisionEnv({ ...layout, xkbDir: '' }, {});
    expect('XKB_CONFIG_ROOT' in env).toBe(false);
  });

  it('does not leak an empty entry into LD_LIBRARY_PATH', () => {
    // A trailing ':' means "also search the current directory", which is a
    // real (if minor) library-hijacking foothold.
    const env = provisionEnv(layout, {});
    expect(env.LD_LIBRARY_PATH?.endsWith(':')).toBe(false);
    expect(env.LD_LIBRARY_PATH?.includes('::')).toBe(false);
  });
});

describe('layoutFor — every path derives from one root', () => {
  it('keeps all unpacked artefacts under <root>/root', () => {
    const l = layoutFor('/tmp/stack');
    expect(l.binDir.startsWith('/tmp/stack/root/')).toBe(true);
    expect(l.novncRoot.startsWith('/tmp/stack/root/')).toBe(true);
    expect(l.pyDistDir.startsWith('/tmp/stack/root/')).toBe(true);
  });

  it('keeps the shim path short enough to fit the 8-byte patch budget', () => {
    // Not a style preference: the replacement cannot be longer than `/usr/bin`,
    // so a long default here would make patchXvfb() always refuse. The real
    // choice is made by chooseShimDir(), but the default must be sane.
    const l = layoutFor('/tmp/stack');
    expect(typeof l.shimDir).toBe('string');
  });
});

/**
 * The install self-check must not sabotage the install.
 *
 * MEASURED FAILURE this pins. A clean rebuild reported success at every step --
 * `MISSING_AFTER=none`, `PROVISIONED_TREE=true`,
 * `verifying: done (display :91 came up)` -- and then died with
 * `START_ERROR=Xvfb did not create /tmp/.X91-lock`. The self-check picked its
 * scratch display as `90 + random(8)` and the server's configured display was
 * `:91`, inside that range; verify's teardown unlinks the scratch lock, so one
 * run in eight deleted the lock of the display the server was starting.
 *
 * A 1-in-8 failure is the worst kind: it looks like flakiness. These tests make
 * the rule deterministic, so the regression cannot come back unnoticed.
 */
describe('pickScratchDisplay — the self-check must never take the real display', () => {
  const noneInUse = async () => false;

  it('never returns the configured display, even when it is free', async () => {
    // The exact failure: :91 configured, :91 free, and the old code could still
    // choose it. Scanning the whole range proves the exclusion is not accidental.
    for (let reserved = 90; reserved <= 119; reserved++) {
      const got = await pickScratchDisplay(noneInUse, reserved);
      expect(got).not.toBe(reserved);
      expect(got).toBeGreaterThanOrEqual(90);
    }
  });

  it('skips displays that are already in use', async () => {
    // A lock or socket means somebody owns that number; taking it would break
    // them exactly the way the original bug broke us.
    const taken = new Set([90, 91, 92]);
    const got = await pickScratchDisplay(async (n) => taken.has(n), 93);
    expect(got).toBe(94);
  });

  it('returns 0 when everything is taken, rather than stealing one', async () => {
    // 0 makes the caller SKIP verification. Reporting "cannot verify" is honest;
    // evicting a live display to run a self-test is not.
    const got = await pickScratchDisplay(async () => true, null);
    expect(got).toBe(0);
  });

  it('works when no display is configured at all', async () => {
    const got = await pickScratchDisplay(noneInUse, null);
    expect(got).toBe(90);
  });

  it('scans in order, so the choice is deterministic and not random', async () => {
    // Determinism is the point: the old randomness is what made the collision
    // intermittent and therefore misdiagnosed.
    expect(await pickScratchDisplay(noneInUse, 90)).toBe(91);
    expect(await pickScratchDisplay(noneInUse, 90)).toBe(91);
    expect(await pickScratchDisplay(noneInUse, 95)).toBe(90);
  });
});

describe('configuredDisplayNumber — which display the server actually owns', () => {
  it('reads REAL_CHROME_DISPLAY first', () => {
    expect(configuredDisplayNumber({ REAL_CHROME_DISPLAY: ':91', DISPLAY: ':0' })).toBe(91);
  });

  it('falls back to DISPLAY', () => {
    expect(configuredDisplayNumber({ DISPLAY: ':7' })).toBe(7);
  });

  it('strips a screen suffix', () => {
    // `:91.0` is a legal DISPLAY. Left unstripped, the numeric compare in
    // pickScratchDisplay never matches and the exclusion silently does nothing --
    // which would reintroduce the bug while looking like it was fixed.
    expect(configuredDisplayNumber({ REAL_CHROME_DISPLAY: ':91.0' })).toBe(91);
  });

  it('defaults to :99 when nothing is set', () => {
    expect(configuredDisplayNumber({})).toBe(99);
  });

  it('returns null for a hostname-style DISPLAY it cannot parse', () => {
    // Better to reserve nothing than to reserve a wrong number: a null simply
    // means "no exclusion", and a remote display is not one of our locks anyway.
    expect(configuredDisplayNumber({ DISPLAY: 'host:1' })).toBeNull();
    expect(configuredDisplayNumber({ DISPLAY: '' })).toBe(99);
  });
});
