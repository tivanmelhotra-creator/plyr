/**
 * StartupValidation — refuse to start wrong, instead of starting broken.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE RULE THIS FILE ENCODES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The operator's requirement, condensed:
 *
 *   - if a value has a sane default, USE IT and do not stop the boot;
 *   - if a value is genuinely required and absent, FAIL LOUDLY with a fix;
 *   - never enter a silently degraded state.
 *
 * Those three are in tension, and the resolution is the distinction between a
 * CONFIGURATION problem and a PROVISIONING problem:
 *
 *   configuration  — we can decide it. Default it, log the decision, continue.
 *   provisioning   — only the machine/deployer can fix it (no browser binary,
 *                    no OS libraries, no writable directory). Report it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A MISSING BROWSER DOES NOT ABORT THE PROCESS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Tempting, and wrong. This server is not only the Remote Browser: it serves
 * the dashboard, the workflow API, the n8n integration and the job queue, and
 * `SelfHeal`/`DesktopProvision` can install the missing pieces AT RUNTIME
 * without root (that is the whole point of DesktopProvision). A process that
 * exits on a missing library would take away the very UI the operator uses to
 * watch it being installed, and would turn a recoverable state into a crash
 * loop under PM2/Docker restart policies.
 *
 * So the contract is:
 *
 *   FATAL   — the application itself cannot serve anything correctly
 *             (a credential that would silently disable auth, a port that is
 *             not a port). These abort.
 *   BLOCKED — a named FEATURE cannot work. The server starts, the feature
 *             reports this exact reason instead of a mystery, and the boot log
 *             says so in full.
 *
 * `REQUIRE_BROWSER_RUNTIME=true` promotes BLOCKED to FATAL for deployments
 * that would rather fail the health check than serve a half-working instance —
 * which is the right choice behind a load balancer, and the wrong one on a
 * laptop.
 */

import { config } from '../config';
import {
  inspectBrowserRuntime,
  formatRuntimeReport,
  type BrowserRuntimeReport,
} from './BrowserRuntime';

export interface ValidationIssue {
  /** Stable key, for tests and for the UI. */
  id: string;
  /**
   * fatal   — the process must not continue.
   * blocked — a named feature is unavailable; the server still starts.
   * warn    — works, but the operator should know.
   */
  severity: 'fatal' | 'blocked' | 'warn';
  /** Which capability this is about, in the operator's language. */
  feature: string;
  /** What is wrong. */
  problem: string;
  /** What to do about it. Never empty for fatal/blocked. */
  fix: string;
}

export interface StartupReport {
  profile: string;
  profileSource: string;
  issues: ValidationIssue[];
  browser: BrowserRuntimeReport | null;
  /** True when nothing fatal was found. */
  ok: boolean;
  /** Features that will not work, by name. */
  blockedFeatures: string[];
}

/**
 * Should a broken browser runtime stop the boot?
 *
 * Read here rather than in config.ts on purpose: this is a POLICY about
 * validation, it has exactly one consumer, and adding it to the 90-variable
 * config object would be the duplicate-configuration sprawl the task forbids.
 * Defaults to false everywhere — see the file header for why aborting is the
 * wrong default even in production.
 */
function requireBrowserRuntime(): boolean {
  const raw = (process.env.REQUIRE_BROWSER_RUNTIME || '').split('#')[0].trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * Is the Remote Browser supposed to work on this instance?
 *
 * It is, unless the operator turned it off. That asymmetry is deliberate: this
 * project's headline feature is the Remote Browser, so "nobody asked for it"
 * is not a safe assumption, and staying quiet about a broken one is exactly
 * the silent-degradation failure being fixed.
 */
function remoteBrowserWanted(): boolean {
  return config.REAL_CHROME_ENABLED === true;
}

/**
 * Run every check and decide what it means.
 *
 * Pure with respect to the process: it reads config and the filesystem, and
 * returns a verdict. It never exits — `enforceStartupValidation` does that, so
 * tests can assert on the verdict without killing the runner.
 */
export async function validateStartup(): Promise<StartupReport> {
  const issues: ValidationIssue[] = [];

  // ── Application-level configuration ──────────────────────────────────────

  // A port that is not a port. `parseInt('bananas')` is NaN, and `app.listen`
  // then quietly binds a RANDOM port — the server appears to start and is
  // unreachable at the address the operator was told to use.
  if (!Number.isInteger(config.PORT) || config.PORT <= 0 || config.PORT > 65535) {
    issues.push({
      id: 'port_invalid',
      severity: 'fatal',
      feature: 'HTTP server',
      problem: `PORT is not a valid TCP port (got ${JSON.stringify(process.env.PORT ?? '')}).`,
      fix: 'Set PORT to a number between 1 and 65535, or remove it to use the default 3000.',
    });
  }

  // Multi-tenant mode with no keys in `.env`.
  //
  // THIS WAS WRITTEN AS `fatal` AND THAT WAS A BUG — recorded because the
  // reasoning is the whole point of this file. The draft rule said "every
  // request would be rejected", which is false twice over:
  //
  //   1. `config.API_KEYS` is only the .env SEED. The real key store is Redis
  //      (`ApiKeyManager`, auth.ts:38): `initialize()` migrates .env keys INTO
  //      Redis, and `validateAndGetOwner()` falls through to Redis for anything
  //      not in .env. A server whose keys were all created through the admin
  //      API has an empty API_KEYS and a perfectly working authentication.
  //   2. `/admin` is mounted behind `requireAdminAuth` (ADMIN_SECRET) only, NOT
  //      behind API-key auth — so `POST /admin/api-keys/generate` is a working
  //      bootstrap path from a completely empty key list.
  //
  // Aborting the boot would therefore have destroyed a healthy instance and
  // removed the very endpoint used to fix the state it was complaining about.
  // It is a `warn` with the actual bootstrap command, because that is what the
  // situation is: possibly fine, and trivially fixable if not.
  if (!config.IS_SINGLE_USER && config.API_KEYS_ENABLED && config.API_KEYS.size === 0) {
    issues.push({
      id: 'no_api_keys',
      severity: 'warn',
      feature: 'Authentication',
      problem: 'DEPLOYMENT_MODE=multi but API_KEYS is empty in .env. Keys already stored in '
        + 'Redis still work; if there are none, no client can authenticate yet.',
      fix: 'Either set API_KEYS=key1,key2 in .env, or mint one with: '
        + 'curl -X POST localhost:' + config.PORT + '/admin/api-keys/generate '
        + '-H "x-admin-token: $ADMIN_SECRET" -H "Content-Type: application/json" '
        + '-d \'{"userId":"admin"}\'',
    });
  }

  // The public default credential, on a profile that means "reachable".
  // A warning rather than fatal: an operator running production behind a VPN
  // is making a defensible choice, and refusing to boot would strand them.
  if (config.API_TOKEN_IS_DEFAULT && config.APP_PROFILE === 'production') {
    issues.push({
      id: 'default_token_in_production',
      severity: 'warn',
      feature: 'Authentication',
      problem: 'API_TOKEN is the built-in public default (admin123) and the profile is production. '
        + 'This token is in .env.example and in the source; it grants full control of this instance.',
      fix: 'Set your own API_TOKEN in .env and restart.',
    });
  }

  // Worth more alarm than it first appears, which is why the consequence is
  // spelled out rather than left as "change your secret": `/admin` sits behind
  // ADMIN_SECRET ALONE (admin-auth.ts), and `POST /admin/api-keys/generate`
  // mints working API keys. A shipped-default admin secret is therefore not a
  // weak password on a minor endpoint — it is anonymous key minting on a
  // reachable box.
  if (!config.IS_SINGLE_USER && config.ADMIN_SECRET === 'admin_secret_change_me') {
    issues.push({
      id: 'default_admin_secret',
      severity: 'warn',
      feature: 'Admin API',
      problem: 'ADMIN_SECRET is still the shipped default in multi-tenant mode. This value is '
        + 'in .env.example and in the source, and /admin/api-keys/generate can mint API keys '
        + 'with it — anyone who can reach this port can issue themselves access.',
      fix: 'Set ADMIN_SECRET in .env to a value only you know, then restart.',
    });
  }

  // ── Remote Browser ───────────────────────────────────────────────────────

  let browser: BrowserRuntimeReport | null = null;

  if (!remoteBrowserWanted()) {
    // Deliberate opt-out. Say it once, at boot, so that a later "the button
    // does nothing" has a written explanation the operator can find — this is
    // the ONE case where the old `REAL_CHROME_ENABLED=true` hint was correct.
    issues.push({
      id: 'remote_browser_disabled',
      severity: 'warn',
      feature: 'Remote Browser',
      problem: 'REAL_CHROME_ENABLED=false — the Remote Browser, extension loading and the '
        + 'Element Inspector are switched off by configuration.',
      fix: 'Remove REAL_CHROME_ENABLED from .env (the default is true) to turn them back on.',
    });
  } else {
    browser = await inspectBrowserRuntime();
    const fatalIfMissing = requireBrowserRuntime();

    for (const check of browser.checks) {
      if (check.state === 'failed') {
        issues.push({
          id: `browser_${check.id}`,
          severity: fatalIfMissing ? 'fatal' : 'blocked',
          feature: 'Remote Browser',
          problem: `${check.label}: ${check.detail}`,
          fix: check.fix,
        });
      } else if (check.state === 'degraded') {
        issues.push({
          id: `browser_${check.id}`,
          severity: 'warn',
          feature: 'Remote Browser',
          problem: `${check.label}: ${check.detail}`,
          fix: check.fix,
        });
      }
    }
  }

  const blockedFeatures = [
    ...new Set(issues.filter((i) => i.severity === 'blocked').map((i) => i.feature)),
  ];

  return {
    profile: config.APP_PROFILE,
    profileSource: config.APP_PROFILE_SOURCE,
    issues,
    browser,
    ok: !issues.some((i) => i.severity === 'fatal'),
    blockedFeatures,
  };
}

/**
 * The boot banner for the verdict.
 *
 * Shape borrowed from the task's own example, because that shape is right: a
 * headline that says what happened, the environment it happened in, and a
 * numbered list of fixes. Anything a reader has to interpret is a defect.
 */
export function formatStartupReport(report: StartupReport): string {
  const out: string[] = [];
  const fatal = report.issues.filter((i) => i.severity === 'fatal');
  const blocked = report.issues.filter((i) => i.severity === 'blocked');
  const warn = report.issues.filter((i) => i.severity === 'warn');

  if (fatal.length) {
    out.push('');
    out.push('════════════════════════════════════════════════════════════════');
    out.push('APPLICATION CANNOT START');
    out.push('════════════════════════════════════════════════════════════════');
    out.push(`Environment: ${report.profile} (from ${report.profileSource})`);
    out.push('');
    fatal.forEach((i, n) => {
      out.push(`${n + 1}. [${i.feature}] ${i.problem}`);
      out.push(`   How to fix: ${i.fix}`);
    });
    out.push('════════════════════════════════════════════════════════════════');
    return out.join('\n');
  }

  if (blocked.length) {
    out.push('');
    out.push('────────────────────────────────────────────────────────────────');
    out.push(`FEATURE UNAVAILABLE: ${report.blockedFeatures.join(', ')}`);
    out.push('The server is starting, but this will not work until it is fixed.');
    out.push(`Environment: ${report.profile} (from ${report.profileSource})`);
    out.push('');
    blocked.forEach((i, n) => {
      out.push(`${n + 1}. [${i.feature}] ${i.problem}`);
      out.push(`   How to fix: ${i.fix}`);
    });
    out.push('');
    out.push('Set REQUIRE_BROWSER_RUNTIME=true to make this a startup failure instead.');
    out.push('────────────────────────────────────────────────────────────────');
  }

  for (const i of warn) {
    out.push(`[STARTUP] ⚠️  ${i.feature}: ${i.problem}`);
    if (i.fix) out.push(`[STARTUP]    → ${i.fix}`);
  }

  if (report.browser) {
    out.push('');
    out.push(formatRuntimeReport(report.browser));
  }

  return out.join('\n');
}

/**
 * Validate, print, and abort if the verdict is fatal.
 *
 * The only function here with side effects, and the only one index.ts calls —
 * so a test can exercise every rule above without a process that exits.
 */
export async function enforceStartupValidation(
  exit: (code: number) => never = process.exit as (code: number) => never,
): Promise<StartupReport> {
  const report = await validateStartup();
  const text = formatStartupReport(report);
  if (text.trim()) {
    // stderr for a refusal, stdout for information: a deployment log scraper
    // should not have to parse prose to find out whether the boot failed.
    if (!report.ok) console.error(text);
    else console.log(text);
  }
  if (!report.ok) exit(1);
  return report;
}
