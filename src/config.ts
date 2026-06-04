import 'dotenv/config';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';

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

// In single mode we accept one shared token. If API_TOKEN is not set we
// auto-generate a strong random one at boot (printed once to the logs).
const resolveApiToken = (): string => {
  const explicit = cleanEnv(process.env.API_TOKEN);
  if (explicit && explicit.length > 0) return explicit;
  if (DEPLOYMENT_MODE !== 'single') return '';
  return `tok_${randomBytes(24).toString('hex')}`;
};
const API_TOKEN = resolveApiToken();
const API_TOKEN_AUTO_GENERATED = DEPLOYMENT_MODE === 'single' && !cleanEnv(process.env.API_TOKEN);

// Full-access plan used for every request in single mode (quota 0 = unlimited).
const FULL_ACCESS_PLAN: PlanConfig = {
  quota: 0, maxTabs: 50, maxSteps: 10000, priority: 1, maxSchedules: 1000, runLimit: 0,
};

export const config = {
  // ============================================
  // Version
  // ============================================
  VERSION: '40.0.0',  // ✅ Updated for Schedule feature

  // ============================================
  // [H — Step 18] Deployment mode
  // ============================================
  DEPLOYMENT_MODE,
  IS_SINGLE_USER: DEPLOYMENT_MODE === 'single',
  API_TOKEN,
  API_TOKEN_AUTO_GENERATED,
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
  if (config.API_TOKEN_AUTO_GENERATED) {
    console.warn(
      '[CONFIG] 🔐 No API_TOKEN set — generated a random one for this run:\n' +
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