#!/usr/bin/env node
/**
 * postinstall — provision the browser, and be HONEST when it could not.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS REPLACES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The previous one-liner was:
 *
 *     playwright install chromium || echo "[postinstall] Skipped Chromium
 *     download (run npm run install:browser manually)."
 *
 * Two defects, and both were load-bearing in the reported incident.
 *
 * 1. `|| echo` CONVERTS FAILURE INTO SUCCESS. A download that failed — proxy,
 *    air-gap, disk full — printed one grey line in the middle of npm's own
 *    scroll and exited 0. `npm ci` went green. The operator had every reason
 *    to believe the install worked, and found out at the first click.
 *
 * 2. IT INSTALLS THE BINARY, NEVER THE OS LIBRARIES. `playwright install
 *    chromium` downloads a browser; it does not install the distro packages
 *    that browser links against. MEASURED on this sandbox after a clean,
 *    fully successful `npm install`:
 *
 *        binary present ........ yes (~/.cache/ms-playwright/chromium-1194)
 *        ldd chrome ............ libatk-1.0.so.0        => not found
 *                                libatk-bridge-2.0.so.0 => not found
 *                                libatspi.so.0          => not found
 *                                libXcomposite.so.1     => not found
 *                                libXdamage.so.1        => not found
 *        launch ................ "Host system is missing dependencies"
 *
 *    So the documented setup path produced a machine that CANNOT run the
 *    headline feature, and reported nothing at all.
 *
 * ── WHAT THIS DOES INSTEAD ─────────────────────────────────────────────────
 *
 * Still never fails the install. That part was right: `npm ci` must work on a
 * CI box that will only ever run unit tests, behind a proxy, on an image whose
 * browsers are already baked in. Failing there would be worse than the disease.
 *
 * But it stops LYING. On failure it prints a boxed, unmissable warning naming
 * the exact command to run, and — crucially — it checks the SHARED LIBRARIES
 * too, because that is the failure the old script could not even detect.
 *
 * The escape hatch stays `SKIP_BROWSER_INSTALL=1` (used by the Dockerfile,
 * whose base image already ships browsers AND their dependencies).
 */

'use strict';

const { execFileSync, execSync } = require('child_process');

const BOX = '─'.repeat(70);

function warn(lines) {
  console.warn('');
  console.warn(BOX);
  for (const l of lines) console.warn(l);
  console.warn(BOX);
  console.warn('');
}

if (process.env.SKIP_BROWSER_INSTALL) {
  console.log('[postinstall] SKIP_BROWSER_INSTALL set — leaving the browser alone.');
  process.exit(0);
}

// ── 1. The browser binary ───────────────────────────────────────────────────
let installed = false;
try {
  execSync('npx --no-install playwright install chromium', { stdio: 'inherit' });
  installed = true;
} catch {
  warn([
    '[postinstall] ⚠️  COULD NOT DOWNLOAD CHROMIUM.',
    '',
    'The install itself succeeded, but the Remote Browser will NOT work until',
    'the browser is present. This is usually a proxy, an air-gapped host, or',
    'no disk space.',
    '',
    '  To fix:   npm run install:browser:deps',
    '  To check: npm run doctor',
  ]);
}

// ── 2. The OS libraries that binary needs ───────────────────────────────────
// The half the old script never looked at. Only meaningful on Linux, and only
// worth doing when we actually have a binary to inspect.
if (installed && process.platform === 'linux') {
  try {
    const exe = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"],
      { encoding: 'utf8', timeout: 30000 },
    ).trim();

    const ldd = execFileSync('ldd', [exe], { encoding: 'utf8', timeout: 30000 });
    const missing = ldd
      .split('\n')
      .filter((l) => l.includes('not found'))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);

    if (missing.length) {
      warn([
        '[postinstall] ⚠️  CHROMIUM IS INSTALLED BUT CANNOT RUN.',
        '',
        'The browser downloaded correctly, but the system libraries it needs',
        'are missing, so any attempt to launch it will fail:',
        '',
        ...missing.map((m) => `    ✗ ${m}`),
        '',
        '  To fix:   npm run install:browser:deps',
        '            (needs root; without root the server can provision these',
        '             itself at runtime — see DESKTOP_AUTO_PROVISION)',
        '  To check: npm run doctor',
      ]);
    } else {
      console.log('[postinstall] ✓ Chromium installed and all system libraries resolve.');
    }
  } catch {
    // ldd absent, or a non-glibc distro. Not an error: `npm run doctor` asks
    // the same question later and more thoroughly.
    console.log('[postinstall] Chromium installed (library check unavailable on this host).');
  }
}

process.exit(0);
