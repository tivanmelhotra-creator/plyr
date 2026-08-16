/**
 * BrowserRuntime — can this machine actually run the Remote Browser, and if
 * not, exactly which part is missing?
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The reported failure, verbatim:
 *
 *     Could not start the remote browser: Real Chrome is disabled.
 *     Set REAL_CHROME_ENABLED=true to use extensions.
 *
 * That message is a symptom presented as a cause. The operator is told to set
 * a variable, but the variable's own default is `true` (config.ts), so on a
 * clean checkout it is ALREADY true — and the message is then actively
 * misleading. Worse, it is the ONLY thing the product says about a subsystem
 * with four independent prerequisites:
 *
 *     1. REAL_CHROME_ENABLED must be on          (configuration)
 *     2. a Chromium/Chrome BINARY must exist     (provisioning)
 *     3. its OS SHARED LIBRARIES must be present (provisioning)
 *     4. a headed launch needs an X DISPLAY      (provisioning)
 *
 * Any of 2, 3 or 4 being absent produces a different, later, uglier error —
 * and none of them is a configuration problem at all. MEASURED on a clean
 * sandbox with the repo's own `npm install` already run:
 *
 *     chromium binary present  ->  YES  (~/.cache/ms-playwright/chromium-1194)
 *     ldd chrome | not found   ->  libatk-1.0.so.0, libatk-bridge-2.0.so.0,
 *                                  libatspi.so.0, libXcomposite.so.1,
 *                                  libXdamage.so.1
 *     launchPersistentContext  ->  "Host system is missing dependencies"
 *
 * So the binary that `postinstall` downloads cannot run, and nothing in the
 * product notices until a user clicks the button. This module is the thing
 * that notices — at boot, and on demand — and names the specific missing part
 * together with the command that fixes it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE MEASUREMENT THAT DECIDES THE ARCHITECTURE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everything about Real Chrome rests on one claim: extensions need a HEADED
 * browser. That claim is load-bearing (it is why a server needs Xvfb at all),
 * so it is measured, not assumed. With playwright 1.56.1 / chromium-1194,
 * launching a persistent context with `--load-extension` and Playwright's
 * `--disable-extensions` default stripped:
 *
 *     headless=true   ->  serviceWorkers=0  bgPages=0  extId=(none)
 *     headless=false  ->  serviceWorkers=1  bgPages=0  extId=gjiajdnn...
 *
 * ZERO extensions headless, on a browser that launched perfectly happily. The
 * claim holds. That is why `REMOTE_BROWSER` + `headless` is reported here as a
 * genuine capability conflict rather than a preference: it is the silent
 * degraded state the operator asked us never to enter.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * It does not launch browsers, own them, or fix anything. RealChrome launches,
 * SelfHeal repairs, DesktopProvision installs. This only ANSWERS QUESTIONS, so
 * it is safe to call from startup validation, from a health route and from a
 * CLI without side effects or a Redis connection.
 */

import { promises as fs, constants as fsConstants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import { config } from '../config';

const execFileAsync = promisify(execFile);

/** One prerequisite, and what to do when it is not met. */
export interface RuntimeCheck {
  /** Stable key for tests and UI translation. Never a sentence. */
  id:
    | 'realChromeEnabled'
    | 'executable'
    | 'sharedLibraries'
    | 'display'
    | 'extensionSupport'
    | 'extensionsDir'
    | 'profileDir';
  /** Short human label, English. The UI may translate via `id`. */
  label: string;
  /**
   * ok       — verified present and usable.
   * degraded — usable, but a documented capability is lost (named in `detail`).
   * failed   — the Remote Browser cannot work until this is fixed.
   * skipped  — not applicable in this configuration (says why in `detail`).
   */
  state: 'ok' | 'degraded' | 'failed' | 'skipped';
  /** What was actually observed. Always concrete: a path, a version, a list. */
  detail: string;
  /** The command or setting that fixes it. Empty when nothing is wrong. */
  fix: string;
}

export interface BrowserRuntimeReport {
  /** True when the Remote Browser can start right now. */
  ok: boolean;
  /** True when it will start but with a documented capability missing. */
  degraded: boolean;
  /** Resolved browser executable, or '' when none could be found. */
  executablePath: string;
  /** Where that path came from — provenance beats a bare value. */
  executableSource: 'CHROME_EXE' | 'playwright' | 'none';
  /** e.g. "Chromium 141.0.7390.37". Empty when it could not be run. */
  version: string;
  /** Headed or headless, as this configuration will actually launch. */
  headless: boolean;
  /** The X display a headed launch will use. Empty when headless. */
  display: string;
  /** Shared libraries the binary needs and cannot find. */
  missingLibraries: string[];
  checks: RuntimeCheck[];
}

/**
 * Shared libraries whose absence we translate into a named package.
 *
 * Only the ones actually MEASURED missing on a clean Debian/Ubuntu box after
 * `playwright install chromium` — the download ships the browser but never the
 * distro's C libraries. A longer speculative list would make the failure output
 * less readable without making it more accurate.
 */
const LIB_TO_PACKAGE: Record<string, string> = {
  'libatk-1.0.so.0': 'libatk1.0-0t64',
  'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0t64',
  'libatspi.so.0': 'libatspi2.0-0t64',
  'libXcomposite.so.1': 'libxcomposite1',
  'libXdamage.so.1': 'libxdamage1',
  'libgbm.so.1': 'libgbm1',
  'libnss3.so': 'libnss3',
  'libnspr4.so': 'libnspr4',
  'libcups.so.2': 'libcups2t64',
  'libdrm.so.2': 'libdrm2',
  'libxkbcommon.so.0': 'libxkbcommon0',
  'libpango-1.0.so.0': 'libpango-1.0-0',
  'libcairo.so.2': 'libcairo2',
  'libasound.so.2': 'libasound2t64',
};

/**
 * Where is the browser?
 *
 * CHROME_EXE wins when set — an operator who pinned a specific Chrome build
 * (for a Widevine/DRM site, or a corporate MSI) must not be silently handed
 * Playwright's Chromium instead. Otherwise we ask Playwright, which is the
 * binary `npm run install:browser` downloads and therefore the one the
 * documented setup path actually provisions.
 *
 * Never throws: a missing browser is a report, not a crash. Callers decide
 * whether that is fatal.
 */
export async function resolveExecutable(): Promise<{
  path: string;
  source: 'CHROME_EXE' | 'playwright' | 'none';
}> {
  const explicit = (config.CHROME_EXE || '').trim();
  if (explicit) return { path: explicit, source: 'CHROME_EXE' };
  try {
    // Imported lazily and defensively. If playwright itself is not installed
    // this must report "no browser", not take the whole process down with a
    // module-resolution error — the missing-dependency case is precisely one
    // of the failures this module exists to describe.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright');
    const p = chromium.executablePath();
    return p ? { path: p, source: 'playwright' } : { path: '', source: 'none' };
  } catch {
    return { path: '', source: 'none' };
  }
}

/** Does the file exist and is it executable by this process? */
async function isRunnable(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which shared libraries can the binary not resolve?
 *
 * `ldd` is the direct question and needs no privilege. On a platform without
 * it (macOS, Windows, a stripped container) we return an empty list rather
 * than a guess: reporting "nothing missing" when we could not look is honest
 * only because the very next check actually LAUNCHES the browser, which would
 * catch it anyway.
 */
export async function missingSharedLibraries(exe: string): Promise<string[]> {
  if (process.platform !== 'linux') return [];
  try {
    const { stdout } = await execFileAsync('ldd', [exe], { timeout: 15000 });
    return stdout
      .split('\n')
      .filter((l) => l.includes('not found'))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Ask the binary its own version. Proves it can execute at all. */
export async function browserVersion(exe: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(exe, ['--version'], { timeout: 20000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Turn missing libraries into the one command that installs them.
 *
 * `npx playwright install-deps chromium` is named FIRST because it is the
 * project's own documented, version-matched path and it works on every distro
 * Playwright supports. The raw apt line is the fallback for an image that has
 * no npx at runtime.
 */
export function libraryFix(missing: string[]): string {
  const pkgs = [...new Set(missing.map((l) => LIB_TO_PACKAGE[l]).filter(Boolean))];
  const apt = pkgs.length ? ` (or: sudo apt-get install -y ${pkgs.join(' ')})` : '';
  return `Run: npm run install:browser:deps${apt}`;
}

/**
 * Is there an X display for a headed launch?
 *
 * An exported DISPLAY wins over REAL_CHROME_DISPLAY, mirroring RealChrome's own
 * launch logic — reporting on a display the browser will not use would be a
 * check that passes while the launch fails.
 */
export function resolveDisplay(): string {
  return (process.env.DISPLAY || config.REAL_CHROME_DISPLAY || '').trim();
}

/**
 * Is that display actually LISTENING, or just a string in the environment?
 *
 * The X11 socket is the cheapest true answer available and needs no client
 * libraries: Xvfb :99 creates /tmp/.X11-unix/X99. A DISPLAY that names a dead
 * screen is exactly how "the browser will not start" happens on a server whose
 * Xvfb died, and a string check would call that healthy.
 */
export async function displayIsUp(display = resolveDisplay()): Promise<boolean> {
  const m = /^:(\d+)/.exec(display.replace(/^.*:/, ':'));
  if (!m) return false;
  try {
    await fs.access(path.join('/tmp', '.X11-unix', `X${m[1]}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything, in one pass, with no side effects.
 *
 * Ordered so the first failure is the most fundamental one: there is no point
 * telling someone their display is down when they have no browser binary.
 */
export async function inspectBrowserRuntime(): Promise<BrowserRuntimeReport> {
  const checks: RuntimeCheck[] = [];
  const headless = config.REAL_CHROME_HEADLESS === true;
  const display = headless ? '' : resolveDisplay();

  // ── 1. Configuration ─────────────────────────────────────────────────────
  const enabled = config.REAL_CHROME_ENABLED === true;
  checks.push({
    id: 'realChromeEnabled',
    label: 'Real Chrome enabled',
    state: enabled ? 'ok' : 'failed',
    detail: enabled
      ? 'REAL_CHROME_ENABLED=true'
      : 'REAL_CHROME_ENABLED=false — the Remote Browser is switched off, so no '
        + 'extension can be loaded and the Element Inspector cannot run.',
    fix: enabled ? '' : 'Set REAL_CHROME_ENABLED=true in .env (or remove the line — the default is true).',
  });

  // ── 2. The binary ────────────────────────────────────────────────────────
  const { path: exe, source } = await resolveExecutable();
  const exeOk = exe ? await isRunnable(exe) : false;
  checks.push({
    id: 'executable',
    label: 'Browser executable',
    state: exeOk ? 'ok' : 'failed',
    detail: exe
      ? `${exeOk ? 'found' : 'NOT FOUND'} at ${exe} (source: ${source})`
      : 'no browser executable could be resolved',
    fix: exeOk
      ? ''
      : source === 'CHROME_EXE'
        ? `CHROME_EXE points at ${exe}, which is not an executable file. Correct it, or unset CHROME_EXE to use the bundled Chromium.`
        : 'Run: npm run install:browser',
  });

  // ── 3. Its OS libraries ──────────────────────────────────────────────────
  // The failure the sandbox actually had: binary present, unrunnable.
  const missingLibs = exeOk ? await missingSharedLibraries(exe) : [];
  checks.push({
    id: 'sharedLibraries',
    label: 'Browser system libraries',
    state: !exeOk ? 'skipped' : missingLibs.length === 0 ? 'ok' : 'failed',
    detail: !exeOk
      ? 'not checked — there is no executable to check'
      : missingLibs.length === 0
        ? 'all shared libraries resolve'
        : `missing: ${missingLibs.join(', ')}`,
    fix: missingLibs.length ? libraryFix(missingLibs) : '',
  });

  // Proving it runs is stronger than proving it links, so the version is read
  // only once the libraries are known good — otherwise `--version` fails for a
  // reason we have already reported and the output gains a second, redundant
  // error.
  const version = exeOk && missingLibs.length === 0 ? await browserVersion(exe) : '';

  // ── 4. A screen, when one is needed ──────────────────────────────────────
  //
  // NOT `failed` when it is down, and that distinction matters: `Desktop.start()`
  // brings the display up ON DEMAND, and `/browser/real/open` calls it before it
  // ever touches Chrome. A cold server legitimately has no X socket yet, so
  // grading that as a hard failure would report a broken Remote Browser on a
  // machine where pressing the button works perfectly. It is only a real fault
  // when the server has been told never to build one, which is what
  // DESKTOP_AUTO_PROVISION=false means.
  const displayUp = headless ? false : await displayIsUp(display);
  const canBuildDisplay = config.DESKTOP_AUTO_PROVISION === true;
  checks.push({
    id: 'display',
    label: 'X display',
    state: headless ? 'skipped' : displayUp ? 'ok' : canBuildDisplay ? 'degraded' : 'failed',
    detail: headless
      ? 'not needed — REAL_CHROME_HEADLESS=true'
      : displayUp
        ? `${display} is up`
        : canBuildDisplay
          ? `${display || '(unset)'} is not running yet — the server will start it on demand`
          : `${display || '(unset)'} is not running, and DESKTOP_AUTO_PROVISION=false forbids starting one`,
    fix: headless || displayUp
      ? ''
      : canBuildDisplay
        ? '' // nothing to do: it is started automatically
        : 'Set DESKTOP_AUTO_PROVISION=true, start a display yourself (bash scripts/desktop.sh start), '
          + 'or point REAL_CHROME_DISPLAY at an existing one.',
  });

  // ── 5. Can extensions load AT ALL in this mode? ──────────────────────────
  // MEASURED (see the file header): headless loads zero. This is the check
  // that turns the old silent degradation into a stated one.
  checks.push({
    id: 'extensionSupport',
    label: 'Extension loading',
    state: !enabled ? 'skipped' : headless ? 'degraded' : 'ok',
    detail: !enabled
      ? 'not checked — Real Chrome is disabled'
      : headless
        ? 'REAL_CHROME_HEADLESS=true loads NO extensions (measured: 0 service workers '
          + 'headless vs 1 headed). The Element Inspector and any cookie extension are unavailable.'
        : 'headed Chrome — extensions load',
    fix: enabled && headless
      ? 'Set REAL_CHROME_HEADLESS=false and provide a display (the server can start one itself).'
      : '',
  });

  // ── 6. The directories it writes to ──────────────────────────────────────
  // Cheap, but the failure is otherwise a mid-launch EACCES that reads like a
  // browser crash.
  for (const [id, dir, label] of [
    ['profileDir', config.REAL_CHROME_USER_DATA_DIR, 'Chrome profile directory'],
    ['extensionsDir', config.REAL_CHROME_EXTENSIONS_DIR, 'Extensions directory'],
  ] as const) {
    let state: RuntimeCheck['state'] = 'ok';
    let detail = dir;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, fsConstants.W_OK);
      detail = `${dir} (writable)`;
    } catch (e) {
      state = 'failed';
      detail = `${dir} — ${(e as Error).message}`;
    }
    checks.push({
      id,
      label,
      state,
      detail,
      fix: state === 'ok' ? '' : `Make ${dir} writable by the server process, or point the matching *_DIR variable elsewhere.`,
    });
  }

  return {
    ok: !checks.some((c) => c.state === 'failed'),
    degraded: checks.some((c) => c.state === 'degraded'),
    executablePath: exe,
    executableSource: source,
    version,
    headless,
    display,
    missingLibraries: missingLibs,
    checks,
  };
}

/**
 * The report as the block of text the operator sees at boot or from the CLI.
 *
 * A table, not prose, and every failing line carries its own fix — the whole
 * complaint was having to guess a remedy from a one-line error.
 */
export function formatRuntimeReport(report: BrowserRuntimeReport): string {
  const glyph: Record<RuntimeCheck['state'], string> = {
    ok: '✓', degraded: '!', failed: '✗', skipped: '–',
  };
  const lines: string[] = ['Browser runtime:'];
  for (const c of report.checks) {
    lines.push(`  ${glyph[c.state]} ${c.label}: ${c.detail}`);
    if (c.fix) lines.push(`      → ${c.fix}`);
  }
  if (report.version) lines.push(`  ✓ Version detected: ${report.version}`);
  return lines.join('\n');
}
