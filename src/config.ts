import 'dotenv/config';
import path from 'path';
import os from 'os';

const cleanEnv = (val: string | undefined): string | undefined => {
  if (!val) return undefined;
  return val.split('#')[0].trim();
};

// ============================================
// Plan Configuration Interface
// ============================================
export interface PlanConfig {
  quota: number;
  maxTabs: number;
  maxSteps: number;
  priority: number;
  maxSchedules: number;  // ✅ اضافه شد
  runLimit: number;      // ✅ اضافه شد (0 = unlimited)
}

// ============================================
// Parse Plans from Environment
// ============================================
const parsePlans = (): Record<string, PlanConfig> => {
  const defaultPlans: Record<string, PlanConfig> = {
    "0": { quota: 5, maxTabs: 1, maxSteps: 5, priority: 100, maxSchedules: 2, runLimit: 100 },
    "1": { quota: 15, maxTabs: 3, maxSteps: 20, priority: 50, maxSchedules: 5, runLimit: 500 },
    "2": { quota: 60, maxTabs: 10, maxSteps: 100, priority: 10, maxSchedules: 20, runLimit: 0 },
    "3": { quota: 0, maxTabs: 20, maxSteps: 500, priority: 1, maxSchedules: 100, runLimit: 0 }
  };
  
  try {
    const raw = cleanEnv(process.env.USER_PLANS);
    if (!raw) return defaultPlans;
    
    const parsed = JSON.parse(raw);
    
    // Merge with defaults to ensure all fields exist
    const result: Record<string, PlanConfig> = {};
    for (const [level, plan] of Object.entries(parsed)) {
      const basePlan = defaultPlans[level] || defaultPlans["0"];
      result[level] = {
        quota: (plan as any).quota ?? basePlan.quota,
        maxTabs: (plan as any).maxTabs ?? basePlan.maxTabs,
        maxSteps: (plan as any).maxSteps ?? basePlan.maxSteps,
        priority: (plan as any).priority ?? basePlan.priority,
        maxSchedules: (plan as any).maxSchedules ?? basePlan.maxSchedules,
        runLimit: (plan as any).runLimit ?? basePlan.runLimit,
      };
    }
    
    // Ensure all default levels exist
    for (const [level, plan] of Object.entries(defaultPlans)) {
      if (!result[level]) {
        result[level] = plan;
      }
    }
    
    return result;
  } catch (e) {
    console.warn('[CONFIG] Failed to parse USER_PLANS, using defaults');
    return defaultPlans;
  }
};

const parseApiKeys = (): Set<string> => {
  const raw = cleanEnv(process.env.API_KEYS) || '';
  const keys = raw
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);
  return new Set(keys);
};

// ============================================
// [H — Step 18] Deployment mode (single self-hosted vs multi-tenant).
// 'single' (default): full-access single user, Quota/VIP/Plan/Level disabled,
// authenticated by one shared API_TOKEN. 'multi': original SaaS behaviour.
// ============================================
const resolveDeploymentMode = (): 'single' | 'multi' => {
  const raw = (cleanEnv(process.env.DEPLOYMENT_MODE) || 'single').toLowerCase();
  return raw === 'multi' ? 'multi' : 'single';
};
const DEPLOYMENT_MODE = resolveDeploymentMode();

// In single mode we accept one shared token.
//
// DEFAULT: `admin123`, by explicit operator request — a token you can type from
// memory on a box only you reach beats one you have to dig out of the logs after
// every restart. It replaces a random `tok_…` that was regenerated on each boot
// whenever .env was empty, which logged every existing panel out.
//
// THIS IS A WEAK, PUBLICLY-KNOWN DEFAULT. It is not a secret: it is in this
// source file and in .env.example. Whoever holds it holds the whole instance —
// this one token drives a real browser, reads and writes the download/upload
// directories, and runs workflows. So `isDefaultApiToken` is exported and
// warned about loudly at boot; anything reachable from the internet must set its
// own API_TOKEN in .env.
const DEFAULT_SINGLE_USER_API_TOKEN = 'admin123';
const resolveApiToken = (): string => {
  const explicit = cleanEnv(process.env.API_TOKEN);
  if (explicit && explicit.length > 0) return explicit;
  if (DEPLOYMENT_MODE !== 'single') return '';
  return DEFAULT_SINGLE_USER_API_TOKEN;
};
const API_TOKEN = resolveApiToken();
// Kept for the boot message and for anything that wants to nag the operator.
// Renamed in spirit, not in name: it is still "the operator did not choose this
// token", it just no longer means "and it is therefore unguessable".
const API_TOKEN_AUTO_GENERATED = DEPLOYMENT_MODE === 'single' && !cleanEnv(process.env.API_TOKEN);
const API_TOKEN_IS_DEFAULT = API_TOKEN === DEFAULT_SINGLE_USER_API_TOKEN;

// Full-access plan used for every request in single mode (quota 0 = unlimited).
const FULL_ACCESS_PLAN: PlanConfig = {
  quota: 0, maxTabs: 50, maxSteps: 10000, priority: 1, maxSchedules: 1000, runLimit: 0,
};

// Read the real package version once at startup so /health, the admin
// stats endpoint, the boot banner and outbound User-Agent headers all report
// the SAME version as package.json (single source of truth — avoids drift).
function resolvePackageVersion(): string {
  try {
    // dist/config.js lives one level under the project root, so does src/.
    // require resolves relative to this compiled file; fall back to CWD.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* ignore — fall through to a safe default */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(process.cwd(), 'package.json'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }
  return '0.0.0';
}
const PACKAGE_VERSION = resolvePackageVersion();

export const config = {
  // ============================================
  // Version
  // ============================================
  VERSION: PACKAGE_VERSION,  // single source of truth = package.json

  // ============================================
  // [H — Step 18] Deployment mode
  // ============================================
  DEPLOYMENT_MODE,
  IS_SINGLE_USER: DEPLOYMENT_MODE === 'single',
  API_TOKEN,
  API_TOKEN_AUTO_GENERATED,
  API_TOKEN_IS_DEFAULT,
  FULL_ACCESS_PLAN,

  // ============================================
  // Server
  // ============================================
  PORT: parseInt(cleanEnv(process.env.PORT) || '3000', 10),
  NODE_ENV: cleanEnv(process.env.NODE_ENV) || 'development',
  
  // ============================================
  // Redis
  // ============================================
  REDIS_URL: cleanEnv(process.env.REDIS_URL) || 'redis://127.0.0.1:6379',
  
  // ============================================
  // Directories
  // ============================================
  PROFILES_DIR: path.resolve(cleanEnv(process.env.PROFILES_DIR) || './profiles'),
  LOGS_DIR: path.resolve(cleanEnv(process.env.LOGS_DIR) || './logs'),
  UPLOADS_DIR: path.resolve(cleanEnv(process.env.UPLOADS_DIR) || './uploads'),
  DOWNLOADS_DIR: path.resolve(cleanEnv(process.env.DOWNLOADS_DIR) || './downloads'),

  
  // ============================================
  // Chrome
  // ============================================
  // CHROME_EXE: optional. Empty => use Playwright bundled Chromium (recommended for Node-base/Linux).
  // Set CHROME_EXE only to force a system-installed Chrome/Chromium binary.
  CHROME_EXE: (() => {
    const env = cleanEnv(process.env.CHROME_EXE);
    if (env && env !== '') return env;
    return ''; // default: let Playwright resolve its bundled Chromium
  })(),

  // ============================================
  // Real Chrome  (extensions + remote access)
  // ============================================
  // The canvas "simulated browser" streams page pixels over CDP. That is enough
  // to pick a selector, but it can NEVER show a Chrome extension's toolbar
  // popup, because a popup is not part of the page. Users who rely on an
  // extension (a cookie import/export extension being the canonical case: export
  // once, import into a fresh profile, skip the login) need a genuine Chrome
  // with a genuine extension host.
  //
  // REAL_CHROME_ENABLED switches the interactive browser from a throwaway
  // BrowserContext to a PERSISTENT Chrome profile with extensions loaded.
  //
  // DEFAULT: ON (opt-OUT). It used to be opt-in, on the grounds that it costs a
  // long-lived Chrome process and, on a headless box, an X server. In practice
  // that default made the headline feature look broken: with it off, Chrome
  // loads NO extensions at all, so the cookie extension above cannot be
  // installed and the panel could only answer with a hint to edit .env and
  // restart. Paying for a Chrome process is the lesser cost.
  //
  // Set REAL_CHROME_ENABLED=false to get the old throwaway-context behaviour
  // (lighter, no X server needed, no extensions).
  REAL_CHROME_ENABLED: (cleanEnv(process.env.REAL_CHROME_ENABLED)?.toLowerCase() ?? 'true') !== 'false',

  // The persistent profile directory. This is what makes cookies imported by an
  // extension survive a restart and be visible to automation runs.
  REAL_CHROME_USER_DATA_DIR: path.resolve(
    cleanEnv(process.env.REAL_CHROME_USER_DATA_DIR) || './profiles/chrome-profile'
  ),

  // Unpacked extensions live here, one directory per extension, each containing
  // a manifest.json. Uploaded .zip/.crx files are unpacked into this directory.
  REAL_CHROME_EXTENSIONS_DIR: path.resolve(
    cleanEnv(process.env.REAL_CHROME_EXTENSIONS_DIR) || './profiles/extensions'
  ),

  // Extensions are only loaded by a HEADED Chrome. Playwright's bundled headless
  // shell has no extension host at all, so leaving this true on a server without
  // an X server is a launch failure, not a degraded mode. Run scripts/desktop.sh
  // (Xvfb) first, or point REAL_CHROME_DISPLAY at an existing display.
  REAL_CHROME_HEADLESS: cleanEnv(process.env.REAL_CHROME_HEADLESS)?.toLowerCase() === 'true',

  // X display for the headed Chrome. Ignored when a DISPLAY is already exported.
  REAL_CHROME_DISPLAY: cleanEnv(process.env.REAL_CHROME_DISPLAY) || ':99',

  // Chrome's own DevTools endpoint. This is the literal "expose the browser on a
  // port" request: with this on you can attach any CDP client, or open
  // chrome://inspect from your own Chrome and drive the remote one.
  REAL_CHROME_DEBUG_PORT: parseInt(cleanEnv(process.env.REAL_CHROME_DEBUG_PORT) || '0', 10),

  // 127.0.0.1 by default and deliberately so: an open DevTools port is remote
  // code execution and full cookie theft for anyone who can reach it. Set
  // 0.0.0.0 only behind a firewall/VPN or an authenticating reverse proxy.
  REAL_CHROME_DEBUG_BIND: cleanEnv(process.env.REAL_CHROME_DEBUG_BIND) || '127.0.0.1',

  // Window size of the real Chrome. The interactive viewport follows it.
  REAL_CHROME_WINDOW_WIDTH: parseInt(cleanEnv(process.env.REAL_CHROME_WINDOW_WIDTH) || '1280', 10),
  REAL_CHROME_WINDOW_HEIGHT: parseInt(cleanEnv(process.env.REAL_CHROME_WINDOW_HEIGHT) || '800', 10),

  // Reopen the tabs that were open when the browser last went away.
  //
  // The operator's report: «هنگ کرد و بعدش دیگه فریز شد منم بستم مجدد باز کنم
  // ... همه تب ها گم شدن». MEASURED with tools/probe-realchrome-tab-loss.js:
  // three tabs in, browser SIGKILLed, ZERO tabs back — and the same on a CLEAN
  // close, so this was never a crash-only bug.
  //
  // On by default. Losing the tabs is the reported defect, and this browser is
  // the operator's workspace: a half-finished login flow across three tabs is
  // not something to discard because the container restarted. Set false to get
  // a fresh window every time.
  REAL_CHROME_RESTORE_TABS:
    (cleanEnv(process.env.REAL_CHROME_RESTORE_TABS)?.toLowerCase() ?? 'true') !== 'false',

  // ============================================
  // Remote desktop (Xvfb + VNC + noVNC)
  // ============================================
  // Seeing the real Chrome — including extension popups, the extension toolbar
  // and native file dialogs — needs the X display itself, not a page screencast.
  // noVNC serves that display over HTTP so it opens in a normal browser tab.
  DESKTOP_ENABLED: cleanEnv(process.env.DESKTOP_ENABLED)?.toLowerCase() === 'true',
  DESKTOP_VNC_PORT: parseInt(cleanEnv(process.env.DESKTOP_VNC_PORT) || '5900', 10),
  DESKTOP_NOVNC_PORT: parseInt(cleanEnv(process.env.DESKTOP_NOVNC_PORT) || '6080', 10),
  // Empty means "no VNC password". Only acceptable when the port is bound to
  // localhost and reached through an SSH tunnel.
  DESKTOP_VNC_PASSWORD: cleanEnv(process.env.DESKTOP_VNC_PASSWORD) || '',
  DESKTOP_NOVNC_WEB_ROOT: cleanEnv(process.env.DESKTOP_NOVNC_WEB_ROOT) || '',

  // ============================================
  // Queue Settings
  // ============================================
  MAX_CONCURRENT: parseInt(cleanEnv(process.env.MAX_CONCURRENT) || '20', 10),
  MAX_QUEUED_JOBS_PER_USER: parseInt(cleanEnv(process.env.MAX_QUEUED_JOBS_PER_USER) || '3', 10),
  MAX_STORED_JOBS_PER_USER: parseInt(cleanEnv(process.env.MAX_STORED_JOBS_PER_USER) || '10', 10),
  QUEUE_DELAY_MS: parseInt(cleanEnv(process.env.QUEUE_DELAY_MS) || '200', 10),

  // ============================================
  // Timeouts
  // ============================================
  STEP_TIMEOUT_MS: parseInt(cleanEnv(process.env.STEP_TIMEOUT_MS) || '300000', 10),
  MAX_JOB_DURATION_MINUTES: parseInt(cleanEnv(process.env.MAX_JOB_DURATION_MINUTES) || '90', 10),
  BROWSER_LAUNCH_TIMEOUT_MS: parseInt(cleanEnv(process.env.BROWSER_LAUNCH_TIMEOUT_MS) || '30000', 10),

  // ============================================
  // Browser
  // ============================================
  DEFAULT_HEADLESS: cleanEnv(process.env.DEFAULT_HEADLESS)?.toLowerCase() !== 'false',
  TURBO_MODE: cleanEnv(process.env.TURBO_MODE) === 'true',

  // ============================================
  // Garbage Collector
  // ============================================
  PARTIAL_SAVE_INTERVAL: parseInt(cleanEnv(process.env.PARTIAL_SAVE_INTERVAL) || '10', 10),
  GC_CHECK_INTERVAL_MINUTES: parseInt(cleanEnv(process.env.GC_CHECK_INTERVAL_MINUTES) || '10', 10),
  GC_STALE_THRESHOLD_MINUTES: parseInt(cleanEnv(process.env.GC_STALE_THRESHOLD_MINUTES) || '15', 10),
  PARTIAL_FILE_MAX_AGE_HOURS: parseInt(cleanEnv(process.env.PARTIAL_FILE_MAX_AGE_HOURS) || '1', 10),
  JOB_OUTPUT_MAX_AGE_MS: parseInt(cleanEnv(process.env.JOB_OUTPUT_MAX_AGE_MS) || '1800000', 10),

  // ============================================
  // Rate Limiting
  // ============================================
  RATE_LIMIT_ENABLED: cleanEnv(process.env.RATE_LIMIT_ENABLED) !== 'false',
  RATE_LIMIT_PER_MINUTE: parseInt(cleanEnv(process.env.RATE_LIMIT_PER_MINUTE) || '120', 10),
  ADMIN_RATE_LIMIT_PER_MINUTE: parseInt(cleanEnv(process.env.ADMIN_RATE_LIMIT_PER_MINUTE) || '30', 10),

  // ============================================
  // CORS (F5) - explicit cross-origin control for UI / n8n / extension
  // ============================================
  // Comma-separated list of allowed origins. '*' allows any origin (no credentials).
  // Empty => same-origin only (the bundled dashboard works regardless).
  CORS_ALLOWED_ORIGINS: (cleanEnv(process.env.CORS_ALLOWED_ORIGINS) || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0),
  GOD_MODE_IPS: (cleanEnv(process.env.GOD_MODE_IPS) || '127.0.0.1,::1')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0),

  // ============================================
  // Authentication
  // ============================================
  API_KEYS_ENABLED: cleanEnv(process.env.API_KEYS_ENABLED) !== 'false',
  API_KEYS: parseApiKeys(),
  ADMIN_SECRET: cleanEnv(process.env.ADMIN_SECRET) || 'admin_secret_change_me',

  // ============================================
  // User Plans
  // ============================================
  USER_PLANS: parsePlans(),
  DEFAULT_USER_LEVEL: cleanEnv(process.env.DEFAULT_USER_LEVEL) || '0',

  // ============================================
  // Webhooks
  // ============================================
  WEBHOOK_TIMEOUT_MS: parseInt(cleanEnv(process.env.WEBHOOK_TIMEOUT_MS) || '5000', 10),
  WEBHOOK_ALLOW_PRIVATE_IPS: cleanEnv(process.env.WEBHOOK_ALLOW_PRIVATE_IPS) === 'true',
  WEBHOOK_MAX_RETRIES: parseInt(cleanEnv(process.env.WEBHOOK_MAX_RETRIES) || '3', 10),
  WEBHOOK_RETRY_BACKOFF_MS: parseInt(cleanEnv(process.env.WEBHOOK_RETRY_BACKOFF_MS) || '1000', 10),
  // [F3] Optional shared secret. When set, every outgoing webhook is signed with
  // HMAC-SHA256 over the raw JSON body; the digest is sent in the
  // `X-Signature: sha256=<hex>` header (plus `X-Webhook-Timestamp`). Empty => unsigned.
  WEBHOOK_SECRET: cleanEnv(process.env.WEBHOOK_SECRET) || '',

  // ============================================
  // Step 29: two-channel live reporting
  // ============================================
  // Per-step outbound webhook: when STEP_WEBHOOK_ENABLED is true, each
  // step.start/done/error/retry is delivered live to the job's webhookUrl
  // (same HMAC scheme as job webhooks). Disabled by default to preserve
  // existing job-only webhook behaviour.
  STEP_WEBHOOK_ENABLED: cleanEnv(process.env.STEP_WEBHOOK_ENABLED) === 'true',
  // Secret used to sign shareable live-view tokens. Falls back to
  // WEBHOOK_SECRET, then API_TOKEN, so a token can always be minted.
  LIVE_SHARE_SECRET:
    cleanEnv(process.env.LIVE_SHARE_SECRET)
    || cleanEnv(process.env.WEBHOOK_SECRET)
    || API_TOKEN
    || '',
  // Default share-link lifetime (seconds). 0 = never expires.
  LIVE_SHARE_TTL_SEC: parseInt(cleanEnv(process.env.LIVE_SHARE_TTL_SEC) || '86400', 10),

  // ============================================
  // n8n / API Integration (F3)
  // ============================================
  // Synchronous /run?wait=true: max time (ms) to block waiting for a job to
  // finish before falling back to the async {jobId} response (HTTP 202).
  RUN_WAIT_MAX_MS: parseInt(cleanEnv(process.env.RUN_WAIT_MAX_MS) || '60000', 10),
  // Poll interval (ms) used while waiting for a synchronous job to complete.
  RUN_WAIT_POLL_MS: parseInt(cleanEnv(process.env.RUN_WAIT_POLL_MS) || '500', 10),
  // Idempotency-Key TTL (seconds): how long a (userId, key) -> jobId mapping is
  // remembered so duplicate submissions return the original job instead of re-queuing.
  IDEMPOTENCY_TTL_SECONDS: parseInt(cleanEnv(process.env.IDEMPOTENCY_TTL_SECONDS) || '86400', 10),

  // ============================================
  // Workflow Storage (G2, Step 17)
  // ============================================
  // How many past versions to keep per workflow. Oldest snapshots beyond this
  // are pruned on each update. 0 disables history pruning (keep everything).
  WORKFLOW_MAX_VERSIONS: parseInt(cleanEnv(process.env.WORKFLOW_MAX_VERSIONS) || '20', 10),

  // ============================================
  // Security
  // ============================================
  MAX_TOTAL_EXECUTION_OPS: parseInt(cleanEnv(process.env.MAX_TOTAL_EXECUTION_OPS) || '5000', 10),
  MAX_REQUEST_BODY_SIZE: cleanEnv(process.env.MAX_REQUEST_BODY_SIZE) || '20mb',
  MAX_REGEX_LENGTH: parseInt(cleanEnv(process.env.MAX_REGEX_LENGTH) || '100', 10),
  USE_LUA_QUOTA: cleanEnv(process.env.USE_LUA_QUOTA) !== 'false',

  // ============================================
  // Hybrid Architecture Settings
  // ============================================
  VIP_PRIORITY_THRESHOLD: parseInt(cleanEnv(process.env.VIP_PRIORITY_THRESHOLD) || '100', 10),
  FREE_CONTEXT_MAX_LIFETIME_MS: parseInt(cleanEnv(process.env.FREE_CONTEXT_MAX_LIFETIME_MS) || '300000', 10),
  FREE_RESOURCE_BLOCKING: cleanEnv(process.env.FREE_RESOURCE_BLOCKING) !== 'false',
  FREE_FORCE_SEQUENTIAL: cleanEnv(process.env.FREE_FORCE_SEQUENTIAL) === 'true',

  // ============================================
  // Flattener Settings
  // ============================================
  FREE_FLATTENER_ENABLED: cleanEnv(process.env.FREE_FLATTENER_ENABLED) !== 'false',
  FLATTENER_URL_CAPTURE_TIMEOUT_MS: parseInt(cleanEnv(process.env.FLATTENER_URL_CAPTURE_TIMEOUT_MS) || '2000', 10),
  FLATTENER_REDIRECT_TO_MAIN: cleanEnv(process.env.FLATTENER_REDIRECT_TO_MAIN) !== 'false',

  // ============================================
  // Cancel Settings
  // ============================================
  TAB_CLOSE_TIMEOUT_MS: parseInt(cleanEnv(process.env.TAB_CLOSE_TIMEOUT_MS) || '5000', 10),
  
  // ============================================
  // Variable Size
  // ============================================
  MAX_VARIABLE_SIZE_KB: parseInt(cleanEnv(process.env.MAX_VARIABLE_SIZE_KB) || '100', 10),

  // ============================================
  // Schedule Settings (Global Fallbacks)
  // ============================================
  MAX_SCHEDULES_FREE: parseInt(cleanEnv(process.env.MAX_SCHEDULES_FREE) || '2', 10),
  MAX_SCHEDULES_VIP: parseInt(cleanEnv(process.env.MAX_SCHEDULES_VIP) || '10', 10),
  MAX_REPEAT_LIMIT_FREE: parseInt(cleanEnv(process.env.MAX_REPEAT_LIMIT_FREE) || '100', 10),

} as const;

// ============================================
// Helper: Get Plan by Level
// ============================================
export const getPlanByLevel = (level: number): PlanConfig => {
  const key = String(level);
  return config.USER_PLANS[key] || config.USER_PLANS["0"] || {
    quota: 5,
    maxTabs: 1,
    maxSteps: 5,
    priority: 100,
    maxSchedules: 2,
    runLimit: 100
  };
};

// ============================================
// Validation Warnings
// ============================================
// Note: in 'single' mode auth uses the shared API_TOKEN, not the multi-tenant
// API_KEYS list, so an empty API_KEYS set is expected and harmless. Only warn
// in 'multi' mode where API_KEYS actually gates per-user access.
if (config.DEPLOYMENT_MODE === 'multi' && config.API_KEYS_ENABLED && config.API_KEYS.size === 0) {
  console.warn('[CONFIG] ⚠️ API_KEYS_ENABLED is true but no API_KEYS defined!');
}

if (config.DEPLOYMENT_MODE === 'multi' && config.ADMIN_SECRET === 'admin_secret_change_me') {
  console.warn('[CONFIG] ⚠️ Using default ADMIN_SECRET in multi mode! Change it in production.');
}

if (config.IS_SINGLE_USER) {
  console.log('[CONFIG] 🏠 DEPLOYMENT_MODE=single — full-access, single-user self-hosted.');
  if (config.API_TOKEN_IS_DEFAULT) {
    // Loud, and it says what the risk actually is. The old message said "we
    // generated a random one", which was reassuring; this default is the
    // opposite of reassuring and the log must not pretend otherwise.
    console.warn(
      '[CONFIG] 🔓 API_TOKEN is the built-in default (API_TOKEN=admin123).\n' +
      '        This token is PUBLIC — it is in .env.example and in the source.\n' +
      '        It grants full control of this instance: it drives a real browser,\n' +
      '        reads/writes the download and upload directories, and runs workflows.\n' +
      '        Fine on a machine only you can reach. If this host is reachable from\n' +
      '        the internet, set your own API_TOKEN in .env and restart.'
    );
  } else if (config.API_TOKEN_AUTO_GENERATED) {
    console.warn(
      '[CONFIG] 🔐 No API_TOKEN set — using a generated one for this run:\n' +
      `        API_TOKEN=${config.API_TOKEN}\n` +
      '        Set API_TOKEN in your .env to keep it stable across restarts.'
    );
  }
} else {
  console.log('[CONFIG] 🏢 DEPLOYMENT_MODE=multi — multi-tenant (plans/quotas/admin enabled).');
}

// ============================================
// Type Export
// ============================================
export type Config = typeof config;