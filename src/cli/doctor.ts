/**
 * `npm run doctor` — answer "why is it doing that?" without reading the source.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS COMMAND EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The reported incident was not really about a browser. It was about an
 * operator holding a one-line error —
 *
 *     Real Chrome is disabled. Set REAL_CHROME_ENABLED=true to use extensions.
 *
 * — with no way to find out whether that variable was set, where it was set,
 * what the default was, or which of the subsystem's other three prerequisites
 * were also missing. Every one of those questions has a cheap, exact answer;
 * none of them was reachable. So they guessed, and guessing on a server is how
 * `.env` files drift until two machines behave differently for reasons nobody
 * can reconstruct.
 *
 * This prints the answers. Specifically it prints PROVENANCE — not just that
 * `REAL_CHROME_HEADLESS` is `false`, but whether that is your choice, the
 * profile's choice, or a fallback. "You set this" and "the server guessed this"
 * look identical in a value dump and are completely different facts when you
 * are trying to work out why staging and production disagree.
 *
 * ── DESIGN CONSTRAINTS ─────────────────────────────────────────────────────
 *
 * 1. NO SIDE EFFECTS. It must be safe to run against a live production server:
 *    no Redis connection, no browser launch, no writes. It reads config, asks
 *    the filesystem a few questions, and prints. (`inspectBrowserRuntime` does
 *    mkdir the profile dirs — a deliberate exception, since "can I create it?"
 *    is the actual question being asked, and it is idempotent.)
 *
 * 2. EXIT CODE IS THE API. 0 = the Remote Browser will work, 1 = it will not.
 *    That makes this usable as a container HEALTHCHECK or a deploy gate, which
 *    is the difference between documentation and enforcement.
 *
 * 3. IT REPEATS THE FIX ON EVERY FAILING LINE. Not once at the bottom. The
 *    person reading this is already frustrated.
 */

import { config } from '../config';
import { describeProfile, PROFILES } from '../core/EnvProfile';
import { inspectBrowserRuntime, formatRuntimeReport } from '../core/BrowserRuntime';
import { validateStartup } from '../core/StartupValidation';

const BAR = '═'.repeat(72);
const DASH = '─'.repeat(72);

/** Secrets must never be printed. Show enough to identify, not to use. */
function mask(v: string): string {
  if (!v) return '(empty)';
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

async function main(): Promise<void> {
  const out: string[] = [];

  out.push('');
  out.push(BAR);
  out.push(`  AUTOMATION BACKEND — DOCTOR   (v${config.VERSION})`);
  out.push(BAR);

  // ── 1. Which profile, and how did we decide? ─────────────────────────────
  const profile = describeProfile();
  const meta = PROFILES.find((p) => p.id === profile.profile);
  out.push('');
  out.push('ENVIRONMENT');
  out.push(DASH);
  out.push(`  Profile:        ${profile.profile}  (detected from ${profile.detectedFrom})`);
  if (meta) out.push(`  Meaning:        ${meta.summary}`);
  out.push(`  APP_ENV:        ${process.env.APP_ENV || '(unset)'}`);
  out.push(`  NODE_ENV:       ${process.env.NODE_ENV || '(unset)'}`);
  if (profile.detectedFrom === 'default') {
    out.push('  NOTE:           Neither APP_ENV nor NODE_ENV is set, so this fell back to');
    out.push('                  development. On a server set APP_ENV=server.');
  }

  // ── 2. Every profile-managed value, with provenance ──────────────────────
  out.push('');
  out.push('RESOLVED CONFIGURATION  (explicit > profile > default)');
  out.push(DASH);
  const width = Math.max(...profile.values.map((v) => v.name.length));
  for (const v of profile.values) {
    const tag = v.source === 'explicit'
      ? (v.overridden ? 'YOU SET  (overrides profile)' : 'YOU SET')
      : v.source === 'profile' ? `profile:${profile.profile}` : 'built-in default';
    // `undefined` renders when the ACTIVE profile has no opinion on a variable
    // that some other profile does (the row set is the union of all profiles,
    // so the table does not reshuffle when you switch between them). Printing
    // the literal string "undefined" reads as a bug; "(not set)" states the
    // actual situation — no profile default and no explicit value, so the
    // fallback inside config.ts is what applies.
    const shown = v.value === undefined || v.value === '' ? '(not set)' : String(v.value);
    out.push(`  ${v.name.padEnd(width)}  = ${shown.padEnd(9)}  [${tag}]`);
    if (v.overridden) {
      out.push(`  ${' '.repeat(width)}    ${profile.profile} would have chosen: ${v.profileValue}`);
    }
  }

  // ── 3. The things that are not profile-managed but decide everything ─────
  out.push('');
  out.push('KEY SETTINGS');
  out.push(DASH);
  out.push(`  PORT                       = ${config.PORT}`);
  out.push(`  DEPLOYMENT_MODE            = ${config.DEPLOYMENT_MODE}`);
  out.push(`  REAL_CHROME_ENABLED        = ${config.REAL_CHROME_ENABLED}`
    + (process.env.REAL_CHROME_ENABLED ? '   [explicit in env]' : '   [default]'));
  out.push(`  CHROME_EXE                 = ${config.CHROME_EXE || '(unset — uses bundled Chromium)'}`);
  out.push(`  REAL_CHROME_DISPLAY        = ${config.REAL_CHROME_DISPLAY}`);
  out.push(`  DESKTOP_AUTO_PROVISION     = ${config.DESKTOP_AUTO_PROVISION}`);
  out.push(`  REAL_CHROME_USER_DATA_DIR  = ${config.REAL_CHROME_USER_DATA_DIR}`);
  out.push(`  REAL_CHROME_EXTENSIONS_DIR = ${config.REAL_CHROME_EXTENSIONS_DIR}`);
  out.push(`  API_TOKEN                  = ${mask(config.API_TOKEN)}`
    + (config.API_TOKEN_IS_DEFAULT ? '   ⚠️  SHIPPED DEFAULT' : ''));
  out.push(`  ADMIN_SECRET               = ${mask(config.ADMIN_SECRET)}`);
  out.push(`  API_KEYS                   = ${config.API_KEYS.size} key(s) in .env`);

  // ── 4. Can the browser actually run? ─────────────────────────────────────
  out.push('');
  out.push('BROWSER RUNTIME');
  out.push(DASH);
  const runtime = await inspectBrowserRuntime();
  out.push(formatRuntimeReport(runtime).split('\n').map((l) => `  ${l}`).join('\n'));

  // ── 5. The verdict, in the same words the server will use at boot ────────
  const startup = await validateStartup();
  out.push('');
  out.push('VERDICT');
  out.push(DASH);

  const fatal = startup.issues.filter((i) => i.severity === 'fatal');
  const blocked = startup.issues.filter((i) => i.severity === 'blocked');
  const warn = startup.issues.filter((i) => i.severity === 'warn');

  if (fatal.length) {
    out.push('  ✗ THE SERVER WILL NOT START.');
    for (const i of fatal) {
      out.push(`     [${i.feature}] ${i.problem}`);
      out.push(`     → ${i.fix}`);
    }
  } else if (blocked.length) {
    out.push(`  ✗ The server will start, but these will NOT work: ${startup.blockedFeatures.join(', ')}`);
    for (const i of blocked) {
      out.push(`     [${i.feature}] ${i.problem}`);
      out.push(`     → ${i.fix}`);
    }
  } else if (runtime.degraded) {
    out.push('  ! The server will start and the Remote Browser will run, with a capability missing.');
  } else {
    out.push('  ✓ Configuration is complete and the Remote Browser can run.');
  }

  for (const i of warn) {
    out.push(`  ⚠️  [${i.feature}] ${i.problem}`);
    if (i.fix) out.push(`     → ${i.fix}`);
  }

  out.push('');
  out.push(BAR);
  out.push('');

  console.log(out.join('\n'));

  // Exit code as contract — see the header. `degraded` is deliberately a 0:
  // headless-without-extensions is a legitimate, documented deployment, and a
  // CI gate that fails on it would be crying wolf.
  process.exit(fatal.length || blocked.length ? 1 : 0);
}

main().catch((e) => {
  // The doctor itself failing must not look like the patient failing.
  console.error('[doctor] Could not complete the check:', e);
  process.exit(2);
});
