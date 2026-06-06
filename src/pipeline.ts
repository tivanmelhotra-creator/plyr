import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { config, PlanConfig } from './config';
import type { AutomationContext, JobResult, StepOutput, CancelChecker, AutomationStep } from './types';
import type { ProfileManager } from './core/ProfileManager';
import { ModuleLoader } from './core/ModuleLoader';
import { ConditionEngine } from './core/ConditionEngine';
import {
  normalizeErrorPolicy,
  shouldRetry,
  retryDelayMs,
  isStopAndError,
} from './core/ErrorPolicy';
import { QuotaManager } from './core/QuotaManager';
import { GlobalBrowser } from './core/GlobalBrowser';
import {
  emptyStream,
  normalizeToItems,
  summarizeItems,
  type WorkflowItem
} from './core/WorkflowItems';

// برای Node.js < 18، این را uncomment کنید:
// import fetch from 'node-fetch';

chromium.use(stealth());

// ════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ════════════════════════════════════════════════════════════════

const moduleLoader = new ModuleLoader();
const MAX_VARIABLE_SIZE = 500 * 1024; // 500KB
const CANCEL_CHECK_INTERVAL = 100; // ms
const ALLOWED_UPLOAD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.doc', '.docx', '.txt', '.csv', '.xlsx', '.zip'];

// HTTP Constants
const HTTP_MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const HTTP_MAX_RETRIES = 3;
const HTTP_RETRY_DELAY = 1000; // ms

// URL های ممنوع برای امنیت
const BLOCKED_URL_PATTERNS = [
  /^file:\/\//i,
  /^localhost/i,
  /^127\./,
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^0\.0\.0\.0/,
  /\.local$/i,
  /^169\.254\./ // Link-local
];

// ════════════════════════════════════════════════════════════════
// CUSTOM ERRORS
// ════════════════════════════════════════════════════════════════

class WorkflowFailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowFailError';
  }
}

class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

async function savePartialOutputs(
  userId: string,
  jobId: string,
  outputs: StepOutput[],
  log: (msg: string) => void
): Promise<void> {
  const file = path.join(config.PROFILES_DIR, userId, 'jobs', `${jobId}_partial.json`);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(outputs, null, 2));
  } catch (err: any) {
    log(`[WARN] Failed to save partial outputs: ${err.message}`);
  }
}

function withStepTimeout<T>(
  promise: Promise<T>,
  stepNumber: number,
  actionName: string,
  timeoutMs: number = config.STEP_TIMEOUT_MS
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout at step ${stepNumber} (${actionName}) after ${timeoutMs}ms`)),
        timeoutMs
      )
    )
  ]);
}

async function checkBrowserHealth(browserContext: any, log?: (msg: string) => void): Promise<boolean> {
  try {
    if (!browserContext) return false;
    const pages = browserContext.pages();
    if (!pages || pages.length === 0) return false;
    if (pages[0].isClosed()) return false;
    await Promise.race([
      pages[0].title(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 3000))
    ]);
    return true;
  } catch (err: any) {
    log?.(`[BROWSER] Health check failed: ${err.message}`);
    return false;
  }
}

function isVipUser(userPlan: PlanConfig): boolean {
  return userPlan.priority < config.VIP_PRIORITY_THRESHOLD;
}

function isPageValid(page: any, context?: any): boolean {
  try {
    if (!page) return false;
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    if (context?.browserContext) {
      const pages = context.browserContext.pages();
      if (!pages || !pages.includes(page)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeStoreVariable(
  variables: Map<string, any>,
  key: string,
  value: any,
  log?: (msg: string) => void
): void {
  try {
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });

    if (serialized.length > MAX_VARIABLE_SIZE) {
      const truncatedValue = `[Data too large: ${(serialized.length / 1024).toFixed(1)}KB - truncated]`;
      variables.set(key, truncatedValue);
      log?.(`[WARN] Variable "${key}" truncated due to size limit`);
    } else {
      variables.set(key, value);
    }
  } catch (err: any) {
    const fallbackValue = String(value).substring(0, 10000);
    variables.set(key, fallbackValue);
    log?.(`[WARN] Variable "${key}" serialization failed: ${err.message}`);
  }
}

function parseBoolean(value: any): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  return Boolean(value);
}

function normalizeUrl(url: string): string {
  try {
    const obj = new URL(url);
    return `${obj.origin}${obj.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

// ════════════════════════════════════════════════════════════════
// SECURITY HELPERS
// ════════════════════════════════════════════════════════════════

function validateFilePath(filePath: string, userId: string, operation: 'upload' | 'download'): string {
  const resolved = path.resolve(filePath);

  const allowedBases = [
    path.resolve(config.PROFILES_DIR, userId),
    path.resolve(config.UPLOADS_DIR || './uploads'),
    path.resolve(config.DOWNLOADS_DIR || './downloads')
  ];

  const isAllowed = allowedBases.some(base => resolved.startsWith(base));

  if (!isAllowed) {
    throw new SecurityError(`Path traversal detected in ${operation}: ${filePath}`);
  }

  if (operation === 'upload') {
    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
      throw new SecurityError(`File type not allowed for upload: ${ext}`);
    }
  }

  return resolved;
}

function sanitizeSelector(selector: string): string {
  if (selector.includes('javascript:') || selector.includes('data:')) {
    throw new SecurityError('Invalid selector detected');
  }
  return selector;
}

function validateHttpUrl(url: string, allowInternal: boolean = false): void {
  try {
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new SecurityError(`Invalid protocol: ${parsed.protocol}. Only HTTP/HTTPS allowed.`);
    }

    if (!allowInternal) {
      const hostname = parsed.hostname.toLowerCase();
      for (const pattern of BLOCKED_URL_PATTERNS) {
        if (pattern.test(hostname) || pattern.test(url)) {
          throw new SecurityError(`Access to internal/local URLs is blocked: ${hostname}`);
        }
      }
    }
  } catch (e: any) {
    if (e instanceof SecurityError) throw e;
    throw new SecurityError(`Invalid URL: ${url}`);
  }
}

function buildAuthHeaders(auth: any): Record<string, string> {
  if (!auth) return {};

  const headers: Record<string, string> = {};

  if (auth.type === 'bearer' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth.type === 'basic' && auth.username && auth.password) {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (auth.type === 'api-key' && auth.key && auth.value && auth.in !== 'query') {
    headers[auth.key] = auth.value;
  }

  return headers;
}

function appendApiKeyToUrl(url: string, auth: any): string {
  if (auth?.type === 'api-key' && auth.in === 'query' && auth.key && auth.value) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${encodeURIComponent(auth.key)}=${encodeURIComponent(auth.value)}`;
  }
  return url;
}

async function httpWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number,
  retryDelay: number,
  log: (msg: string) => void
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status >= 500 && attempt < maxRetries) {
        log(`[HTTP] Server error ${response.status}, retrying (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, retryDelay * attempt));
        continue;
      }

      return response;
    } catch (e: any) {
      lastError = e;

      if (attempt < maxRetries && (e.name === 'TypeError' || e.code === 'ECONNRESET')) {
        log(`[HTTP] Network error, retrying (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, retryDelay * attempt));
        continue;
      }

      throw e;
    }
  }

  throw lastError || new Error('HTTP request failed after retries');
}

// ════════════════════════════════════════════════════════════════
// HUMAN-LIKE MOUSE MOVEMENT
// ════════════════════════════════════════════════════════════════

async function humanMouseMove(
  page: any,
  targetX: number,
  targetY: number,
  speed: 'slow' | 'natural' | 'fast' = 'natural'
): Promise<void> {
  const stepsMap = { slow: 25, natural: 15, fast: 8 };
  const baseSteps = stepsMap[speed];
  const randomSteps = baseSteps + Math.floor(Math.random() * 5);

  const jitterX = (Math.random() - 0.5) * 2;
  const jitterY = (Math.random() - 0.5) * 2;

  await page.mouse.move(targetX + jitterX, targetY + jitterY, { steps: randomSteps });
}

async function humanClick(
  page: any,
  el: any,
  options: { force?: boolean; timeout?: number } = {}
): Promise<void> {
  const box = await el.boundingBox();

  if (box) {
    const offsetX = box.width * (0.3 + Math.random() * 0.4);
    const offsetY = box.height * (0.3 + Math.random() * 0.4);
    const targetX = box.x + offsetX;
    const targetY = box.y + offsetY;

    await humanMouseMove(page, targetX, targetY, 'natural');
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    await page.mouse.click(targetX, targetY, { delay: 30 + Math.random() * 50 });
  } else {
    await el.click({ force: options.force, timeout: options.timeout });
  }
}

// ════════════════════════════════════════════════════════════════
// SMART WAIT HELPER
// ════════════════════════════════════════════════════════════════

async function smartWait(
  ms: number,
  isCancelled: CancelChecker,
  checkInterval: number = CANCEL_CHECK_INTERVAL
): Promise<void> {
  const endTime = Date.now() + ms;

  while (Date.now() < endTime) {
    const remaining = endTime - Date.now();
    const waitTime = Math.min(checkInterval, remaining);

    if (waitTime <= 0) break;

    await new Promise(r => setTimeout(r, waitTime));

    if (await isCancelled()) {
      throw new Error('CANCELLED_BY_USER');
    }
  }
}

// ════════════════════════════════════════════════════════════════
// STEP OUTPUT HELPER
// ════════════════════════════════════════════════════════════════

function createStepOutput(
  stepNumber: number,
  action: string,
  success: boolean,
  result: any,
  startTime: number,
  error?: string
): StepOutput {
  return {
    step: stepNumber,
    action,
    success,
    result,
    error,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime
  };
}

// ════════════════════════════════════════════════════════════════
// STEP 11 HELPERS — safe userId for FS, safe log text, CSV serializer
// ════════════════════════════════════════════════════════════════

function pipelineSafeUserId(id: string): string {
  const s = String(id ?? '').trim();
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  return cleaned.length > 0 ? cleaned : 'anon';
}

function pipelineSafeLog(msg: string): string {
  return String(msg ?? '')
    .replace(/[\r\n]/g, ' ')
    .replace(/\x1b\[[0-9;]*m/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .substring(0, 500);
}

export function csvEscape(value: any): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'object') {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(data: any): string {
  // Array of objects -> rows with union of keys; array of scalars -> single column;
  // single object -> key,value pairs; scalar -> single cell.
  if (Array.isArray(data)) {
    if (data.length === 0) return '';
    const allObjects = data.every(r => r !== null && typeof r === 'object' && !Array.isArray(r));
    if (allObjects) {
      const keys: string[] = [];
      data.forEach((row: any) => {
        Object.keys(row).forEach(k => { if (keys.indexOf(k) === -1) keys.push(k); });
      });
      const header = keys.map(csvEscape).join(',');
      const lines = data.map((row: any) => keys.map(k => csvEscape(row[k])).join(','));
      return [header, ...lines].join('\r\n');
    }
    return data.map((v: any) => csvEscape(v)).join('\r\n');
  }
  if (data !== null && typeof data === 'object') {
    const lines = Object.keys(data).map(k => csvEscape(k) + ',' + csvEscape(data[k]));
    return ['key,value', ...lines].join('\r\n');
  }
  return csvEscape(data);
}

// ════════════════════════════════════════════════════════════════
// VIP BROWSER SETUP
// ════════════════════════════════════════════════════════════════

async function ensureVipBrowser(context: AutomationContext): Promise<void> {
  const { userId, profileManager, log, userPlan, jobId, headless } = context;
  const profileDir = path.join(config.PROFILES_DIR, userId, 'chrome-profile');

  await fs.promises.mkdir(profileDir, { recursive: true });

  if (await context.isCancelled()) throw new Error('CANCELLED_BY_USER');

  const existing = profileManager.getVipContext(userId);

  if (existing) {
    try {
      if (await checkBrowserHealth(existing.context, log)) {
        const pages = existing.context.pages();
        const currentPageCount = pages.length;

        if (currentPageCount > userPlan.maxTabs) {
          for (let i = currentPageCount - 1; i >= userPlan.maxTabs; i--) {
            try {
              await pages[i].close();
            } catch (err: any) {
              log(`[BROWSER] Failed to close extra tab: ${err.message}`);
            }
          }
        }

        context.browserContext = existing.context;
        context.page = existing.context.pages()[0];
        profileManager.setVipContext(userId, existing.context, jobId);
        profileManager.registerPage(jobId, context.page);
        profileManager.updateActivity(userId);
        log('[BROWSER] Reusing VIP browser');
        return;
      }
    } catch (err: any) {
      log(`[BROWSER] Error checking existing context: ${err.message}`);
    }

    try {
      await existing.context.close();
      log('[BROWSER] Closed unhealthy VIP context');
    } catch (err: any) {
      log(`[BROWSER] Error closing unhealthy context: ${err.message}`);
    }
    profileManager.removeVipContext(userId);
  }

  if (await context.isCancelled()) throw new Error('CANCELLED_BY_USER');

  log('[BROWSER] Launching new VIP browser...');

  try {
    const browserContext = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 720 },
      timeout: config.BROWSER_LAUNCH_TIMEOUT_MS,
      // Use a system Chrome only if CHROME_EXE is set; otherwise Playwright bundled Chromium.
      ...(config.CHROME_EXE ? { executablePath: config.CHROME_EXE } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage'
      ]
    });

    if (await context.isCancelled()) {
      await browserContext.close().catch((e: any) => log(`[BROWSER] Error closing on cancel: ${e.message}`));
      throw new Error('CANCELLED_BY_USER');
    }

    if (config.TURBO_MODE) {
      await browserContext.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['font', 'media', 'stylesheet', 'image'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
    }

    const page = browserContext.pages()[0] || await browserContext.newPage();

    profileManager.setVipContext(userId, browserContext, jobId);
    profileManager.registerPage(jobId, page);

    context.browserContext = browserContext;
    context.page = page;

    log('[BROWSER] VIP browser ready');

  } catch (err: any) {
    throw new BrowserError(`Failed to launch VIP browser: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
// FREE BROWSER SETUP
// ════════════════════════════════════════════════════════════════

async function ensureFreeContext(context: AutomationContext): Promise<void> {
  const { userId, profileManager, log, jobId } = context;

  if (await context.isCancelled()) throw new Error('CANCELLED_BY_USER');

  if (!GlobalBrowser.isHealthy()) {
    log('[BROWSER] GlobalBrowser not healthy, waiting...');
    await new Promise(r => setTimeout(r, 3000));

    if (!GlobalBrowser.isHealthy()) {
      throw new BrowserError('GlobalBrowser unavailable after retry');
    }
  }

  log('[BROWSER] Acquiring Free Context...');

  let browserContext: any;

  try {
    browserContext = await GlobalBrowser.getContext();
  } catch (err: any) {
    throw new BrowserError(`Failed to get free context: ${err.message}`);
  }

  if (await context.isCancelled()) {
    await browserContext.close().catch((e: any) => log(`[BROWSER] Error closing on cancel: ${e.message}`));
    throw new Error('CANCELLED_BY_USER');
  }

  profileManager.setFreeContext(jobId, browserContext, userId);

  if (config.FREE_RESOURCE_BLOCKING) {
    await browserContext.route('**/*', (route: any) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });
  }

  if (config.FREE_FLATTENER_ENABLED) {
    await browserContext.addInitScript(() => {
      (window as any).open = (url?: string) => {
        if (url && typeof url === 'string' && url !== 'about:blank') {
          try {
            window.location.href = url;
          } catch { }
        }
        return null;
      };

      const fixLinks = () => {
        document.querySelectorAll('a[target="_blank"]').forEach(link => {
          link.setAttribute('target', '_self');
        });
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fixLinks);
      } else {
        fixLinks();
      }
    });
  }

  const page = await browserContext.newPage();

  if (config.FREE_FLATTENER_ENABLED) {
    browserContext.on('page', async (newPage: any) => {
      if (browserContext.pages().length > 1) {
        let url: string | null = null;

        try {
          await newPage.waitForLoadState('domcontentloaded', { timeout: 2000 });
          url = newPage.url();
        } catch (err: any) {
          log(`[BROWSER] Popup load error: ${err.message}`);
        }

        try {
          await newPage.close();
        } catch { }

        if (url && url !== 'about:blank') {
          const mainPage = browserContext.pages().find((p: any) => !p.isClosed());
          if (mainPage) {
            await mainPage.goto(url).catch((e: any) => log(`[BROWSER] Redirect error: ${e.message}`));
          }
        }
      }
    });
  }

  profileManager.registerPage(jobId, page);
  context.browserContext = browserContext;
  context.page = page;

  log('[BROWSER] Free context ready');
}

// ════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ════════════════════════════════════════════════════════════════

export async function runPipeline(params: {
  userId: string;
  steps: AutomationStep[];
  headless?: boolean;
  log: (msg: string) => void;
  jobId: string;
  job?: any;
  isCancelled?: CancelChecker;
  profileManager: ProfileManager;
  userPlan: PlanConfig;
  quotaManager: QuotaManager;
  onEvent?: (type: string, data?: Record<string, unknown>) => void;
}): Promise<JobResult> {
  const {
    userId,
    steps,
    headless = true,
    log,
    jobId,
    job,
    isCancelled,
    profileManager,
    userPlan,
    quotaManager,
    onEvent
  } = params;

  if (isCancelled && await isCancelled()) {
    return { success: false, message: 'CANCELLED_BY_USER', durationMs: 0 };
  }

  const stepOutputs = profileManager.getJobOutputs(jobId);

  const context: AutomationContext = {
    userId,
    profileManager,
    log,
    jobId,
    job,
    getModule: (name) => moduleLoader.load(name),
    headless,
    stepOutputs,
    isCancelled: isCancelled ?? (async () => false),
    browserContext: undefined as any,
    page: undefined as any,
    data: {},
    userPlan,
    variables: new Map<string, any>(),
    globalLoopCounter: 0,
    quotaManager,
    onEvent,
    // Step 21: start every workflow with a single empty item, like n8n,
    // so the first node always has exactly one input item to act on.
    items: emptyStream(),
    nodeOutputs: {}
  };

  let globalStepNumber = 0;

  if (!(await quotaManager.hasQuotaRemaining(userId, userPlan.quota))) {
    throw new Error('Daily quota exhausted');
  }

  const isVip = isVipUser(userPlan);

  try {
    if (isVip) {
      await ensureVipBrowser(context);
    } else {
      await ensureFreeContext(context);
    }

    if (await context.isCancelled()) {
      throw new Error('CANCELLED_BY_USER');
    }
  } catch (e: any) {
    if (e.message === 'CANCELLED_BY_USER') {
      return { success: false, message: 'CANCELLED_BY_USER', durationMs: 0 };
    }
    throw e;
  }

  const startTime = Date.now();
  let lastQuotaCheck = Date.now();
  let quotaExhausted = false;
  let lastTouchTime = Date.now();
  let watchdogActive = true;

  const getConditionEngine = () => new ConditionEngine(context.page!, context.variables);

  const watchdog = setInterval(async () => {
    if (!watchdogActive) return;

    try {
      if (await context.isCancelled()) {
        watchdogActive = false;
        clearInterval(watchdog);
        return;
      }

      const now = Date.now();

      if (now - lastQuotaCheck > 5000) {
        const elapsed = Math.round((now - lastQuotaCheck) / 1000);
        const hasQuota = await quotaManager.consumeQuota(userId, elapsed, userPlan.quota);

        if (!hasQuota) {
          quotaExhausted = true;
          watchdogActive = false;
          clearInterval(watchdog);
          log('[QUOTA] Quota exhausted');
        }

        lastQuotaCheck = now;
      }
    } catch (err: any) {
      log(`[WATCHDOG] Error: ${err.message}`);
    }
  }, 5000);

  // ════════════════════════════════════════════════════════════════
  // STEP EXECUTION ENGINE
  // ════════════════════════════════════════════════════════════════

  const executeStepGroup = async (
    stepsToRun: AutomationStep[]
  ): Promise<{ break?: boolean; continue?: boolean; return?: boolean; returnValue?: any } | void> => {

    stepLoop:
    for (let i = 0; i < stepsToRun.length; i++) {
      const step = stepsToRun[i];
      const stepStartTime = Date.now();
      // Step 16: live event - announce this step starting.
      const __outLenBefore = stepOutputs.length;
      context.onEvent?.('step.start', { index: globalStepNumber + 1, action: step.action });

      context.globalLoopCounter++;

      if (context.globalLoopCounter > config.MAX_TOTAL_EXECUTION_OPS) {
        throw new Error('Safety Stop: Maximum operations exceeded');
      }

      if (quotaExhausted) {
        throw new Error('QUOTA_EXHAUSTED');
      }

      if (await context.isCancelled()) {
        throw new Error('CANCELLED_BY_USER');
      }

      if (!isPageValid(context.page, context)) {
        throw new Error('PAGE_CLOSED_BY_USER');
      }

      if (job && Date.now() - lastTouchTime > 30000) {
        try {
          await job.touch();
        } catch (err: any) {
          log(`[JOB] Touch failed: ${err.message}`);
        }
        lastTouchTime = Date.now();
      }

      const finalParams: Record<string, any> = step.params ? { ...step.params } : {};
      const engine = getConditionEngine();

      for (const key in finalParams) {
        finalParams[key] = engine.resolveVariables(finalParams[key]);
      }

      // ── Step 27: per-step error policy (retry / continue-on-fail) ──
      const __policy = normalizeErrorPolicy(step);
      const __sgBefore = globalStepNumber;
      const __soBefore = stepOutputs.length;
      let __attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
      __attempt++;
      try {
        // ════════════════════════════════════════════════════════════════
        // 1. FAIL
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'fail') {
          throw new WorkflowFailError(String(finalParams.message || 'Terminated by user'));
        }

        // Step 27: STOP AND ERROR — deliberate, conditional failure.
        if (isStopAndError(step)) {
          const __msg = String(finalParams.message || finalParams.errorMessage || 'Stopped by Stop-And-Error');
          throw new Error(__msg);
        }

        // ════════════════════════════════════════════════════════════════
        // 2. LOG
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'log') {
          const message = String(finalParams.message || '');
          log(`[USER] ${message}`);
          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'log', true, { message }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 3. IF
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'if' && step.condition) {
          const result = await engine.evaluate(step.condition);

          if (result && step.then) {
            const res = await executeStepGroup(step.then);
            if (res) return res;
          } else if (!result && step.else) {
            const res = await executeStepGroup(step.else);
            if (res) return res;
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 4. WHILE
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'while' && step.condition && step.steps) {
          const maxIter = parseInt(finalParams.maxIterations) || 100;
          let iter = 0;

          while (iter < maxIter) {
            if (!isPageValid(context.page, context)) {
              throw new Error('PAGE_CLOSED_BY_USER');
            }

            const conditionResult = await getConditionEngine().evaluate(step.condition);
            if (!conditionResult) break;

            context.variables.set('loop_index', iter);

            const res = await executeStepGroup(step.steps);
            if (res?.return) return res;
            if (res?.break) break;

            iter++;
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 5. LOOP
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'loop' && step.steps) {
          const count = parseInt(finalParams.count) || 1;

          for (let k = 0; k < count; k++) {
            if (!isPageValid(context.page, context)) {
              throw new Error('PAGE_CLOSED_BY_USER');
            }

            context.variables.set('loop_index', k);

            const res = await executeStepGroup(step.steps);
            if (res?.return) return res;
            if (res?.break) break;
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 6. FOREACH
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'foreach' && step.steps && finalParams.items) {
          const itemsKey = String(finalParams.items);
          const items = context.variables.get(itemsKey);
          const itemVar = String(finalParams.itemVar || 'item');

          if (!Array.isArray(items)) {
            log(`[WARN] foreach: "${itemsKey}" is not an array, skipping`);
            continue stepLoop;
          }

          for (let k = 0; k < items.length; k++) {
            if (!isPageValid(context.page, context)) {
              throw new Error('PAGE_CLOSED_BY_USER');
            }

            context.variables.set(itemVar, items[k]);
            context.variables.set('loop_index', k);

            const res = await executeStepGroup(step.steps);
            if (res?.return) return res;
            if (res?.break) break;
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 7. SWITCH
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'switch' && finalParams.variable && step.cases) {
          const val = String(context.variables.get(finalParams.variable) ?? 'default');
          const caseSteps = step.cases[val] || step.cases['default'];

          if (caseSteps) {
            const res = await executeStepGroup(caseSteps);
            if (res) return res;
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 8. TRY-CATCH-FINALLY
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'try' && step.steps) {
          try {
            const res = await executeStepGroup(step.steps);
            if (res) return res;
          } catch (err: any) {
            context.variables.set('error_message', err.message);
            log(`[TRY] Caught error: ${err.message}`);

            if (step.catch) {
              const res = await executeStepGroup(step.catch);
              if (res) return res;
            }
          } finally {
            if (step.finally) {
              const res = await executeStepGroup(step.finally);
              if (res) return res;
            }
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 9-11. CONTROL FLOW
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'break') return { break: true };
        if (step.action === 'continue') return { continue: true };
        if (step.action === 'return') return { return: true, returnValue: finalParams.value };

        // ════════════════════════════════════════════════════════════════
        // 12. SET_VARIABLE
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'set_variable' && finalParams.name) {
          let val = finalParams.value;

          if (finalParams.selector && isPageValid(context.page, context)) {
            try {
              val = await context.page!.locator(finalParams.selector).innerText();
            } catch (err: any) {
              log(`[WARN] Failed to get text from selector: ${err.message}`);
              val = '';
            }
          }

          safeStoreVariable(context.variables, String(finalParams.name), val, log);
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 13. ATTRIBUTE
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'attribute' || step.action === 'mark' || step.action === 'mark-elements') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error('Selector required for attribute');

          const method = String(finalParams.method || 'set');
          const name = String(finalParams.name || finalParams.attribute || 'data-marked');
          const value = String(finalParams.value ?? 'true');

          log(`[ATTRIBUTE] ${method.toUpperCase()} "${name}" on "${selector}"`);

          const locator = context.page!.locator(selector);

          try {
            await locator.first().waitFor({ state: 'attached', timeout: 5000 });
          } catch {
            if (parseBoolean(finalParams.optional)) {
              globalStepNumber++;
              stepOutputs.push(createStepOutput(globalStepNumber, 'attribute', true, { skipped: true }, stepStartTime));
              continue stepLoop;
            }
            throw new Error(`Element not found: ${selector}`);
          }

          let resultData: any = null;

          if (method === 'get') {
            resultData = await locator.first().getAttribute(name);
            if (step.saveAs) {
              safeStoreVariable(context.variables, step.saveAs, resultData, log);
            }
          } else {
            const count = await locator.evaluateAll(
              (els: Element[], { m, n, v }: { m: string; n: string; v: string }) => {
                let c = 0;
                els.forEach(el => {
                  if (m === 'remove') {
                    if (el.hasAttribute(n)) {
                      el.removeAttribute(n);
                      c++;
                    }
                  } else {
                    el.setAttribute(n, v);
                    c++;
                  }
                });
                return c;
              },
              { m: method, n: name, v: value }
            );
            resultData = { count, action: method };
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'attribute', true, resultData, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 14-15. REMOVE / HIDE
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'remove-element' || step.action === 'remove' || step.action === 'hide') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error('Selector is required');

          log(`[DOM] ${step.action.toUpperCase()} on "${selector}"`);

          const locator = context.page!.locator(selector);
          const elementCount = await locator.count();

          if (elementCount === 0) {
            if (parseBoolean(finalParams.optional)) {
              globalStepNumber++;
              stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, { skipped: true, count: 0 }, stepStartTime));
              continue stepLoop;
            }
            throw new Error(`Element not found: ${selector}`);
          }

          const actionType = step.action === 'hide' ? 'hide' : 'remove';

          const count = await locator.evaluateAll((els: Element[], action: string) => {
            let c = 0;
            els.forEach(el => {
              if (action === 'remove') {
                el.remove();
                c++;
              } else {
                (el as HTMLElement).style.display = 'none';
                (el as HTMLElement).style.visibility = 'hidden';
                (el as HTMLElement).style.opacity = '0';
                c++;
              }
            });
            return c;
          }, actionType);

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, { count, action: actionType }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 16. ADD-STYLE / CSS
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'add-style' || step.action === 'css' || step.action === 'inject-css') {
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : '';
          const style = String(finalParams.style || finalParams.css || '');
          const global = parseBoolean(finalParams.global);

          if (!style) throw new Error('Style/CSS content is required');

          log(`[CSS] Injecting style${selector ? ` to "${selector}"` : ' globally'}`);

          if (global || !selector) {
            await context.page!.addStyleTag({ content: style });
          } else {
            await context.page!.evaluate(({ sel, css }) => {
              document.querySelectorAll(sel).forEach((el: Element) => {
                (el as HTMLElement).style.cssText += css;
              });
            }, { sel: selector, css: style });
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'add-style', true, { applied: true }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 17. EXTRACT / SCRAPE
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'extract' || step.action === 'scrape' || step.action === 'get-data') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error('Selector required for extract');

          const multiple = parseBoolean(finalParams.multiple || finalParams.all);
          const attribute = finalParams.attribute ? String(finalParams.attribute) : undefined;
          const property = finalParams.property ? String(finalParams.property) : undefined;
          const timeout = parseInt(finalParams.timeout) || 30000;

          log(`[EXTRACT] "${selector}" (multiple: ${multiple})`);

          try {
            await context.page!.waitForSelector(selector, { timeout, state: 'attached' });
          } catch {
            if (parseBoolean(finalParams.optional)) {
              const emptyResult = multiple ? [] : null;
              globalStepNumber++;
              stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, emptyResult, stepStartTime));
              if (step.saveAs) safeStoreVariable(context.variables, step.saveAs, emptyResult, log);
              continue stepLoop;
            }
            throw new Error(`Element not found: ${selector}`);
          }

          let result: any;
          const locator = context.page!.locator(selector);

          if (attribute) {
            result = multiple
              ? await locator.evaluateAll((els, attr) => els.map(el => el.getAttribute(attr)), attribute)
              : await locator.first().getAttribute(attribute);
          } else if (property) {
            result = multiple
              ? await locator.evaluateAll((els, prop) => els.map(el => (el as any)[prop] || ''), property)
              : await locator.first().evaluate((el, prop) => (el as any)[prop] || '', property);
          } else {
            const extractFn = (el: Element) => {
              const attrs: Record<string, string> = {};
              for (const name of el.getAttributeNames()) {
                attrs[name] = el.getAttribute(name) || '';
              }
              return {
                tagName: el.tagName.toLowerCase(),
                text: el.textContent?.trim() || '',
                innerText: (el as HTMLElement).innerText?.trim() || '',
                innerHTML: el.innerHTML || '',
                value: (el as HTMLInputElement).value || '',
                href: (el as HTMLAnchorElement).href || attrs.href || null,
                src: (el as HTMLImageElement).src || attrs.src || null,
                attributes: attrs,
                classes: Array.from(el.classList),
                id: el.id || null,
                isVisible: (el as HTMLElement).offsetParent !== null
              };
            };

            result = multiple
              ? await locator.evaluateAll((els) => els.map(extractFn))
              : await locator.first().evaluate(extractFn);
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(
            globalStepNumber,
            step.action,
            true,
            Array.isArray(result) ? { count: result.length, data: result } : result,
            stepStartTime
          ));

          if (step.saveAs) {
            safeStoreVariable(context.variables, step.saveAs, result, log);
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 18-21. CLICK / DBLCLICK / HOVER / FOCUS
        // ════════════════════════════════════════════════════════════════
        if (['click', 'dblclick', 'hover', 'focus'].includes(step.action)) {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error(`Selector required for ${step.action}`);

          const timeout = parseInt(finalParams.timeout) || 30000;
          const force = parseBoolean(finalParams.force);
          const human = parseBoolean(finalParams.human);

          log(`[${step.action.toUpperCase()}] "${selector}" (human: ${human})`);

          const el = context.page!.locator(selector).first();
          await el.waitFor({ state: 'visible', timeout });

          if (step.action === 'click') {
            if (human && !force) {
              await humanClick(context.page, el, { force, timeout });
            } else {
              await el.click({ timeout, force });
            }
          } else if (step.action === 'dblclick') {
            if (human && !force) {
              const box = await el.boundingBox();
              if (box) {
                await humanMouseMove(context.page, box.x + box.width / 2, box.y + box.height / 2);
                await context.page!.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
              } else {
                await el.dblclick({ timeout, force });
              }
            } else {
              await el.dblclick({ timeout, force });
            }
          } else if (step.action === 'hover') {
            if (human) {
              const box = await el.boundingBox();
              if (box) {
                await humanMouseMove(context.page, box.x + box.width / 2, box.y + box.height / 2);
              } else {
                await el.hover({ timeout, force });
              }
            } else {
              await el.hover({ timeout, force });
            }
          } else if (step.action === 'focus') {
            await el.focus({ timeout });
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, { selector, human }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 22. MOUSE-MOVE
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'mouse-move' || step.action === 'mouse' || step.action === 'move-mouse') {
          const x = parseFloat(finalParams.x) || 0;
          const y = parseFloat(finalParams.y) || 0;
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : undefined;
          const human = finalParams.human !== undefined ? parseBoolean(finalParams.human) : true;
          const speed = (finalParams.speed || 'natural') as 'slow' | 'natural' | 'fast';

          let targetX = x;
          let targetY = y;

          if (selector) {
            const el = context.page!.locator(selector).first();
            await el.waitFor({ state: 'visible', timeout: 10000 });
            const box = await el.boundingBox();
            if (box) {
              targetX = box.x + box.width / 2;
              targetY = box.y + box.height / 2;
            }
          }

          log(`[MOUSE] Move to ${targetX},${targetY} (human: ${human})`);

          if (human) {
            await humanMouseMove(context.page, targetX, targetY, speed);
          } else {
            await context.page!.mouse.move(targetX, targetY);
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'mouse-move', true, { x: targetX, y: targetY, human }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 23. DRAG-DROP
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'drag-drop' || step.action === 'drag' || step.action === 'dragAndDrop') {
          const source = sanitizeSelector(String(finalParams.source || finalParams.selector || ''));
          const target = finalParams.target ? sanitizeSelector(String(finalParams.target)) : '';
          const targetX = finalParams.targetX !== undefined ? parseFloat(finalParams.targetX) : undefined;
          const targetY = finalParams.targetY !== undefined ? parseFloat(finalParams.targetY) : undefined;
          const human = parseBoolean(finalParams.human);

          if (!source) throw new Error('Source selector required for drag-drop');
          if (!target && targetX === undefined && targetY === undefined) {
            throw new Error('Target selector or coordinates required for drag-drop');
          }

          log(`[DRAG] "${source}" to "${target || `(${targetX},${targetY})`}"`);

          if (target) {
            if (human) {
              const sourceEl = context.page!.locator(source).first();
              const targetEl = context.page!.locator(target).first();

              const sourceBox = await sourceEl.boundingBox();
              const targetBox = await targetEl.boundingBox();

              if (sourceBox && targetBox) {
                const startX = sourceBox.x + sourceBox.width / 2;
                const startY = sourceBox.y + sourceBox.height / 2;
                const endX = targetBox.x + targetBox.width / 2;
                const endY = targetBox.y + targetBox.height / 2;

                await humanMouseMove(context.page, startX, startY);
                await context.page!.mouse.down();
                await humanMouseMove(context.page, endX, endY, 'slow');
                await context.page!.mouse.up();
              } else {
                await context.page!.dragAndDrop(source, target);
              }
            } else {
              await context.page!.dragAndDrop(source, target);
            }
          } else if (targetX !== undefined && targetY !== undefined) {
            const sourceEl = context.page!.locator(source).first();
            const sourceBox = await sourceEl.boundingBox();

            if (sourceBox) {
              const startX = sourceBox.x + sourceBox.width / 2;
              const startY = sourceBox.y + sourceBox.height / 2;

              if (human) {
                await humanMouseMove(context.page, startX, startY);
              } else {
                await context.page!.mouse.move(startX, startY);
              }

              await context.page!.mouse.down();

              if (human) {
                await humanMouseMove(context.page, targetX, targetY, 'slow');
              } else {
                await context.page!.mouse.move(targetX, targetY);
              }

              await context.page!.mouse.up();
            }
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'drag-drop', true, { source, target: target || `(${targetX},${targetY})` }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 24-26. FILL / TYPE / PRESS
        // ════════════════════════════════════════════════════════════════
        if (['fill', 'type', 'press'].includes(step.action)) {
          const text = String(finalParams.text || finalParams.key || '');
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : null;
          const delay = parseInt(finalParams.delay) || 50;

          if (step.action === 'press') {
            if (!text) throw new Error('Key required for press');
            log(`[PRESS] ${text}`);
            await context.page!.keyboard.press(text, { delay });
          } else {
            if (!selector) throw new Error('Selector required');
            const el = context.page!.locator(selector).first();
            await el.waitFor({ state: 'visible' });

            if (step.action === 'fill') {
              log(`[FILL] "${selector}"`);
              await el.fill(text);
            } else {
              log(`[TYPE] "${selector}"`);
              await el.pressSequentially(text, { delay });
            }
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, { text: text.substring(0, 20) }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 27. SCROLL
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'scroll') {
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : undefined;
          const x = parseFloat(finalParams.x) || 0;
          const y = parseFloat(finalParams.y) || 0;
          const human = parseBoolean(finalParams.human);
          const direction = String(finalParams.direction || '').toLowerCase();

          let scrollResult = '';

          if (selector) {
            const el = context.page!.locator(selector).first();
            await el.waitFor({ state: 'attached', timeout: 30000 });
            await el.scrollIntoViewIfNeeded();
            scrollResult = `element: ${selector}`;
            log(`[SCROLL] To element: "${selector}"`);
          } else if (x !== 0 || y !== 0) {
            if (human) {
              const steps = 10;
              for (let s = 0; s < steps; s++) {
                await context.page!.mouse.wheel(x / steps, y / steps);
                await new Promise(r => setTimeout(r, 50));
              }
              scrollResult = `human: x=${x}, y=${y}`;
            } else {
              await context.page!.mouse.wheel(x, y);
              scrollResult = `instant: x=${x}, y=${y}`;
            }
            log(`[SCROLL] By: x=${x}, y=${y}`);
          } else if (direction) {
            const scrollAmount = parseInt(finalParams.amount) || 500;
            const scrollMap: Record<string, [number, number]> = {
              'up': [0, -scrollAmount],
              'down': [0, scrollAmount],
              'left': [-scrollAmount, 0],
              'right': [scrollAmount, 0],
              'top': [0, -99999],
              'bottom': [0, 99999]
            };
            const [dx, dy] = scrollMap[direction] || [0, scrollAmount];

            if (direction === 'top') {
              await context.page!.evaluate(() => window.scrollTo(0, 0));
            } else if (direction === 'bottom') {
              await context.page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            } else if (human) {
              const steps = 10;
              for (let s = 0; s < steps; s++) {
                await context.page!.mouse.wheel(dx / steps, dy / steps);
                await new Promise(r => setTimeout(r, 50));
              }
            } else {
              await context.page!.mouse.wheel(dx, dy);
            }
            scrollResult = `direction: ${direction}`;
            log(`[SCROLL] Direction: ${direction}`);
          } else {
            await context.page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            scrollResult = 'bottom';
            log('[SCROLL] To bottom');
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'scroll', true, { scrolled: scrollResult }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 28. SCREENSHOT
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'screenshot') {
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : undefined;
          const fullPage = parseBoolean(finalParams.fullPage);
          const type = (finalParams.type === 'jpeg' || finalParams.type === 'png') ? finalParams.type : 'png';
          const quality = finalParams.quality ? parseInt(finalParams.quality) : undefined;

          let buffer: Buffer;
          let targetDesc = fullPage ? 'Full Page' : 'Viewport';

          if (selector) {
            const el = context.page!.locator(selector).first();
            const isVisible = await el.isVisible().catch(() => false);

            if (isVisible) {
              buffer = await el.screenshot({
                type: type as 'png' | 'jpeg',
                quality: type === 'jpeg' ? quality : undefined
              });
              targetDesc = `Element: ${selector}`;
            } else {
              buffer = await context.page!.screenshot({
                fullPage,
                type: type as 'png' | 'jpeg',
                quality: type === 'jpeg' ? quality : undefined
              });
            }
          } else {
            buffer = await context.page!.screenshot({
              fullPage,
              type: type as 'png' | 'jpeg',
              quality: type === 'jpeg' ? quality : undefined
            });
          }

          const base64 = buffer.toString('base64');
          const sizeKB = Math.round(buffer.length / 1024);
          log(`[SCREENSHOT] ${targetDesc} - ${sizeKB}KB`);

          if (step.saveAs) {
            safeStoreVariable(context.variables, step.saveAs, base64, log);
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'screenshot', true, { sizeKB, type, target: targetDesc }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 29. SELECT
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'select') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error('Selector required');

          log(`[SELECT] "${selector}"`);
          const el = context.page!.locator(selector).first();

          if (finalParams.value !== undefined) {
            await el.selectOption({ value: String(finalParams.value) });
          } else if (finalParams.label !== undefined) {
            await el.selectOption({ label: String(finalParams.label) });
          } else if (finalParams.index !== undefined) {
            await el.selectOption({ index: parseInt(finalParams.index) });
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'select', true, { selector }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 30-31. CHECK / UNCHECK
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'check' || step.action === 'uncheck') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error('Selector required');

          log(`[${step.action.toUpperCase()}] "${selector}"`);
          const el = context.page!.locator(selector).first();

          if (step.action === 'check') {
            await el.check();
          } else {
            await el.uncheck();
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, { selector }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 32. UPLOAD
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'upload' || step.action === 'upload-file') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          const filePaths = finalParams.files || finalParams.filePath;

          if (!selector) throw new Error('Selector is required for upload');
          if (!filePaths) throw new Error('File path(s) required for upload');

          const files = Array.isArray(filePaths) ? filePaths.map(String) : [String(filePaths)];

          const validatedFiles: string[] = [];
          for (const f of files) {
            const validated = validateFilePath(f, userId, 'upload');
            if (!fs.existsSync(validated)) {
              throw new Error(`File not found: ${f}`);
            }
            validatedFiles.push(validated);
          }

          log(`[UPLOAD] ${validatedFiles.length} file(s) to "${selector}"`);

          const element = context.page!.locator(selector).first();
          const tagName = await element.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

          if (tagName === 'input') {
            await element.setInputFiles(validatedFiles);
          } else {
            const [fileChooser] = await Promise.all([
              context.page!.waitForEvent('filechooser', { timeout: 10000 }),
              element.click()
            ]);
            await fileChooser.setFiles(validatedFiles);
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'upload', true, { files: validatedFiles.map(f => path.basename(f)) }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 33. DOWNLOAD
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'download' || step.action === 'download-file') {
          const selector = sanitizeSelector(String(finalParams.selector || ''));
          if (!selector) throw new Error('Selector required for download');

          const timeout = parseInt(finalParams.timeout) || 60000;
          const customFileName = finalParams.fileName ? String(finalParams.fileName) : undefined;

          log(`[DOWNLOAD] Waiting for download via "${selector}"`);

          const downloadDir = path.join(config.PROFILES_DIR, userId, 'downloads');
          await fs.promises.mkdir(downloadDir, { recursive: true });

          const [download] = await Promise.all([
            context.page!.waitForEvent('download', { timeout }),
            context.page!.locator(selector).first().click()
          ]);

          const suggestedName = download.suggestedFilename();

          const sanitizedFileName = (customFileName || suggestedName)
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .substring(0, 200);

          const finalPath = path.join(downloadDir, sanitizedFileName);

          await download.saveAs(finalPath);

          const stats = await fs.promises.stat(finalPath);
          const fileSizeKB = Math.round(stats.size / 1024);

          log(`[DOWNLOAD] Saved: ${sanitizedFileName} (${fileSizeKB}KB)`);

          const resultData = {
            fileName: sanitizedFileName,
            path: finalPath,
            sizeKB: fileSizeKB,
            suggestedName
          };

          if (step.saveAs) {
            safeStoreVariable(context.variables, step.saveAs, resultData, log);
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'download', true, resultData, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 34. NAVIGATE / GOTO
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'navigate' || step.action === 'goto' || step.action === 'goto-url') {
          const url = String(finalParams.url || '');
          if (!url) throw new Error('URL required');

          const timeout = parseInt(finalParams.timeout) || 60000;
          const waitUntil = (finalParams.waitUntil || 'domcontentloaded') as 'load' | 'domcontentloaded' | 'networkidle';
          const force = parseBoolean(finalParams.force);
          const newTab = parseBoolean(finalParams.newTab);
          const smartStay = finalParams.smartStay !== undefined ? parseBoolean(finalParams.smartStay) : true;

          const targetNorm = normalizeUrl(url);
          const currentNorm = context.page ? normalizeUrl(context.page.url()) : '';
          let navAction = 'navigated';

          if (context.page && currentNorm === targetNorm && !force) {
            log(`[NAV] Already on page: ${url}`);
            navAction = 'stayed';
          } else if (context.page && currentNorm === targetNorm && force) {
            log(`[NAV] Force reload: ${url}`);
            await context.page.reload({ waitUntil, timeout });
            navAction = 'reloaded';
          } else if (smartStay && context.browserContext) {
            let found = false;

            for (const p of context.browserContext.pages()) {
              if (!p.isClosed() && normalizeUrl(p.url()) === targetNorm) {
                context.page = p;
                await p.bringToFront();
                profileManager.registerPage(jobId, p);
                navAction = 'switched';
                found = true;
                break;
              }
            }

            if (!found) {
              if (newTab && isVip) {
                const newPage = await context.browserContext.newPage();
                await newPage.goto(url, { waitUntil, timeout });
                context.page = newPage;
                profileManager.registerPage(jobId, newPage);
                navAction = 'new_tab';
              } else {
                await context.page!.goto(url, { waitUntil, timeout });
              }
            }
          } else {
            log(`[NAV] Going to: ${url}`);
            await context.page!.goto(url, { waitUntil, timeout });
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'navigate', true, { action: navAction, url: context.page?.url() }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 35. SWITCH-FRAME
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'switch-frame' || step.action === 'switch_frame') {
          const target = String(finalParams.target || 'frame');
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : undefined;
          const index = parseInt(finalParams.index) || 0;
          const url = finalParams.url ? String(finalParams.url) : undefined;
          const name = finalParams.name ? String(finalParams.name) : undefined;

          if (!context.data._rootPage) {
            context.data._rootPage = context.page;
          }
          const rootPage = context.data._rootPage as any;

          if (target === 'main') {
            if (!rootPage) throw new Error('Root page reference lost');
            context.page = rootPage;
            log('[FRAME] Switched back to main page');
            globalStepNumber++;
            stepOutputs.push(createStepOutput(globalStepNumber, 'switch-frame', true, { target: 'main' }, stepStartTime));
            continue stepLoop;
          }

          let frame: any = null;

          if (selector) {
            try {
              const elementHandle = await rootPage.locator(selector).nth(index).elementHandle();
              if (elementHandle) {
                frame = await elementHandle.contentFrame();
              }
            } catch (err: any) {
              log(`[FRAME] Selector lookup failed: ${err.message}`);
            }
          }

          if (!frame && (url || name)) {
            const findFrame = (frames: any[]): any => {
              for (const f of frames) {
                if (name && f.name() === name) return f;
                if (url && f.url().includes(url)) return f;
                const child = findFrame(f.childFrames());
                if (child) return child;
              }
              return null;
            };
            frame = findFrame(rootPage.frames());
          }

          if (!frame && finalParams.index !== undefined) {
            const allFrames = rootPage.frames();
            if (index >= 0 && index < allFrames.length) {
              frame = allFrames[index];
            }
          }

          if (!frame) {
            throw new Error(`Frame not found: ${selector || url || name || `index:${index}`}`);
          }

          try {
            if (!(frame as any).mouse) {
              Object.defineProperty(frame, 'mouse', {
                value: rootPage.mouse,
                writable: true,
                configurable: true
              });
            }
            if (!(frame as any).keyboard) {
              Object.defineProperty(frame, 'keyboard', {
                value: rootPage.keyboard,
                writable: true,
                configurable: true
              });
            }
          } catch (err: any) {
            log(`[FRAME] Warning: Could not inject mouse/keyboard: ${err.message}`);
          }

          context.page = frame;
          log(`[FRAME] Switched to frame: ${frame.url()}`);

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'switch-frame', true, { url: frame.url(), name: frame.name() || null }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 36. CLIPBOARD
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'clipboard') {
          const action = String(finalParams.action || 'paste');
          const text = finalParams.text ? String(finalParams.text) : undefined;
          const selector = finalParams.selector ? sanitizeSelector(String(finalParams.selector)) : undefined;
          const human = finalParams.human !== undefined ? parseBoolean(finalParams.human) : true;

          log(`[CLIPBOARD] ${action}`);

          const execClipboard = async (type: string, val?: string): Promise<string | boolean> => {
            return await context.page!.evaluate(async ({ type, val }) => {
              try {
                if (type === 'write' && val) {
                  await navigator.clipboard.writeText(val);
                  return true;
                }
                if (type === 'read') {
                  return await navigator.clipboard.readText();
                }
              } catch { }

              let el = document.getElementById('___clipboard_helper') as HTMLTextAreaElement;
              if (!el) {
                el = document.createElement('textarea');
                el.id = '___clipboard_helper';
                el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
                document.body.appendChild(el);
              }

              if (type === 'write' && val) {
                el.value = val;
                el.select();
                document.execCommand('copy');
                return true;
              }

              if (type === 'read') {
                el.value = '';
                el.focus();
                document.execCommand('paste');
                return el.value;
              }

              return '';
            }, { type, val });
          };

          let resultData: any = null;

          if (action === 'set') {
            if (!text) throw new Error('Text required for clipboard set');
            await execClipboard('write', text);
            resultData = { set: true };
          } else if (action === 'get') {
            resultData = await execClipboard('read');
            if (step.saveAs) {
              safeStoreVariable(context.variables, step.saveAs, resultData, log);
            }
          } else if (action === 'paste' && selector) {
            const el = context.page!.locator(selector).first();
            await el.focus();

            if (human) {
              const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
              await context.page!.keyboard.down(mod);
              await context.page!.keyboard.press('v');
              await context.page!.keyboard.up(mod);
            } else {
              const clipboardText = text || await execClipboard('read') as string;
              await el.fill(clipboardText);
            }
            resultData = { pasted: true };
          } else if (action === 'copy' && selector) {
            const el = context.page!.locator(selector).first();

            const selectedText = await el.evaluate((element) => {
              if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                return element.value;
              }
              return element.textContent || '';
            });

            if (human) {
              await el.click({ clickCount: 3 });
              const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
              await context.page!.keyboard.down(mod);
              await context.page!.keyboard.press('c');
              await context.page!.keyboard.up(mod);
            } else {
              await execClipboard('write', selectedText);
            }

            resultData = { copied: true, text: selectedText.substring(0, 100) };
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'clipboard', true, { action, data: resultData }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 37. HTTP REQUEST (Like n8n)
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'http-request' || step.action === 'http' || step.action === 'fetch' || step.action === 'api') {
          let url = String(finalParams.url || '');
          if (!url) throw new Error('URL is required for http-request');

          const method = String(finalParams.method || 'GET').toUpperCase();
          const customHeaders: Record<string, string> = finalParams.headers || {};
          const body = finalParams.body;
          const timeout = parseInt(finalParams.timeout) || 30000;
          const validateStatus = parseBoolean(finalParams.validateStatus ?? true);
          const retries = Math.min(parseInt(finalParams.retries) || 0, HTTP_MAX_RETRIES);
          const retryDelay = parseInt(finalParams.retryDelay) || HTTP_RETRY_DELAY;
          const auth = finalParams.auth;
          const responseType = String(finalParams.responseType || 'auto');
          const followRedirects = parseBoolean(finalParams.followRedirects ?? true);
          const allowInternal = parseBoolean(finalParams.allowInternal);

          validateHttpUrl(url, allowInternal && isVip);

          url = appendApiKeyToUrl(url, auth);

          const headers: Record<string, string> = {
            'User-Agent': `AutomationBot/${config.VERSION || '1.0'}`,
            ...buildAuthHeaders(auth),
            ...customHeaders
          };

          if (body && !headers['Content-Type'] && !headers['content-type']) {
            if (typeof body === 'object') {
              headers['Content-Type'] = 'application/json';
            } else if (typeof body === 'string') {
              headers['Content-Type'] = 'text/plain';
            }
          }

          let requestBody: string | undefined;
          if (body) {
            if (typeof body === 'object') {
              requestBody = JSON.stringify(body);
            } else {
              requestBody = String(body);
            }
          }

          log(`[HTTP] ${method} ${url.substring(0, 100)}${url.length > 100 ? '...' : ''}`);

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          try {
            const fetchOptions: RequestInit = {
              method,
              headers,
              body: requestBody,
              signal: controller.signal,
              redirect: followRedirects ? 'follow' : 'manual'
            };

            const response = retries > 0
              ? await httpWithRetry(url, fetchOptions, retries + 1, retryDelay, log)
              : await fetch(url, fetchOptions);

            clearTimeout(timeoutId);

            const contentLength = response.headers.get('content-length');
            if (contentLength && parseInt(contentLength) > HTTP_MAX_RESPONSE_SIZE) {
              throw new Error(`Response too large: ${contentLength} bytes (max: ${HTTP_MAX_RESPONSE_SIZE})`);
            }

            const contentType = response.headers.get('content-type') || '';
            let responseData: any;

            if (responseType === 'buffer' || responseType === 'binary') {
              const buffer = await response.arrayBuffer();
              responseData = Buffer.from(buffer).toString('base64');
            } else if (responseType === 'text') {
              responseData = await response.text();
            } else if (responseType === 'json') {
              responseData = await response.json();
            } else {
              if (contentType.includes('application/json')) {
                try {
                  responseData = await response.json();
                } catch {
                  responseData = await response.text();
                }
              } else if (contentType.includes('text/')) {
                responseData = await response.text();
              } else {
                const buffer = await response.arrayBuffer();
                if (buffer.byteLength < 1024 * 1024) {
                  responseData = Buffer.from(buffer).toString('base64');
                } else {
                  responseData = `[Binary data: ${buffer.byteLength} bytes]`;
                }
              }
            }

            const result = {
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              headers: Object.fromEntries(response.headers.entries()),
              data: responseData,
              url: response.url
            };

            if (validateStatus && !response.ok) {
              const errorPreview = typeof responseData === 'string'
                ? responseData.substring(0, 200)
                : JSON.stringify(responseData).substring(0, 200);
              throw new Error(`HTTP Error ${response.status} ${response.statusText}: ${errorPreview}`);
            }

            log(`[HTTP] ✓ ${response.status} ${response.statusText}`);

            if (step.saveAs) {
              safeStoreVariable(context.variables, step.saveAs, result.data, log);
            }

            if (finalParams.saveAsResponse) {
              safeStoreVariable(context.variables, String(finalParams.saveAsResponse), result, log);
            }

            context.variables.set('_http_status', response.status);
            context.variables.set('_http_ok', response.ok);

            globalStepNumber++;
            stepOutputs.push(createStepOutput(
              globalStepNumber,
              'http-request',
              true,
              {
                status: result.status,
                statusText: result.statusText,
                ok: result.ok,
                url: result.url
              },
              stepStartTime
            ));

          } catch (e: any) {
            clearTimeout(timeoutId);

            let errorMsg: string;
            if (e.name === 'AbortError') {
              errorMsg = `Request timeout after ${timeout}ms`;
            } else if (e instanceof SecurityError) {
              throw e;
            } else {
              errorMsg = e.message;
            }

            context.variables.set('_http_error', errorMsg);
            context.variables.set('_http_ok', false);

            throw new Error(`HTTP Request Failed: ${errorMsg}`);
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 38. CLOSE BROWSER
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'close-browser' || step.action === 'close_browser') {
          log('[BROWSER] Manual close requested');

          if (context.browserContext) {
            try {
              const pages = context.browserContext.pages();
              for (const p of pages) {
                await p.close().catch(() => { });
              }
              await context.browserContext.close();
            } catch (err: any) {
              log(`[BROWSER] Error during close: ${err.message}`);
            }
          }

          if (isVip) {
            profileManager.removeVipContext(userId);
          } else {
            profileManager.removeFreeContext(jobId);
          }
          profileManager.unregisterPage(jobId);

          context.browserContext = undefined as any;
          context.page = undefined as any;

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'close-browser', true, 'Closed', stepStartTime));
          return { return: true, returnValue: 'Browser Closed' };
        }

        // ════════════════════════════════════════════════════════════════
        // 39. CLOSE TAB
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'close-tab' || step.action === 'close_tab') {
          if (!context.browserContext) throw new Error('No browser context');

          const pages = context.browserContext.pages();
          if (pages.length === 0) {
            log('[TAB] No tabs to close');
            continue stepLoop;
          }

          const hasTarget = finalParams.url || finalParams.title || finalParams.urlContains ||
            finalParams.index !== undefined || finalParams.allExcept;
          const closeCurrent = !hasTarget || parseBoolean(finalParams.current);

          let closed = 0;
          let currentClosed = false;
          const currentPage = context.page;

          for (const p of [...pages]) {
            if (p.isClosed()) continue;

            let shouldClose = false;
            const url = p.url();
            const title = await p.title().catch(() => '');
            const isCurrent = p === currentPage;

            if (closeCurrent && isCurrent && !hasTarget) {
              shouldClose = true;
            } else if (finalParams.url && url === finalParams.url) {
              shouldClose = true;
            } else if (finalParams.urlContains && url.includes(finalParams.urlContains)) {
              shouldClose = true;
            } else if (finalParams.title && title === finalParams.title) {
              shouldClose = true;
            }

            if (finalParams.allExcept) {
              const ex = finalParams.allExcept;
              const keep = (ex.current && isCurrent) ||
                (ex.url && url === ex.url) ||
                (ex.urlContains && url.includes(ex.urlContains));
              shouldClose = !keep;
            }

            if (shouldClose) {
              if (isCurrent) currentClosed = true;
              try {
                await p.close();
                closed++;
              } catch (err: any) {
                log(`[TAB] Failed to close tab: ${err.message}`);
              }
            }
          }

          if (currentClosed) {
            const remaining = context.browserContext.pages();
            if (remaining.length > 0) {
              context.page = remaining[remaining.length - 1];
              await context.page.bringToFront().catch(() => { });
              profileManager.registerPage(jobId, context.page);
            } else {
              context.page = undefined as any;
            }
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(
            globalStepNumber,
            'close-tab',
            true,
            { closed, remaining: context.browserContext.pages().length },
            stepStartTime
          ));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 40. SWITCH TAB
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'switch-tab' || step.action === 'switch_tab') {
          if (!context.browserContext) throw new Error('No browser context');

          const pages = context.browserContext.pages();
          let target: any = null;

          if (finalParams.index !== undefined) {
            const idx = parseInt(finalParams.index);
            if (idx >= 0 && idx < pages.length) {
              target = pages[idx];
            }
          } else {
            for (const p of pages) {
              if (p.isClosed()) continue;
              const url = p.url();
              const title = await p.title().catch(() => '');

              if ((finalParams.url && url === finalParams.url) ||
                (finalParams.urlContains && url.includes(finalParams.urlContains)) ||
                (finalParams.title && title === finalParams.title)) {
                target = p;
                break;
              }
            }
          }

          if (!target && finalParams.createIfNotFound && isVip) {
            target = await context.browserContext.newPage();
            if (finalParams.newTabUrl) {
              await target.goto(finalParams.newTabUrl);
            }
            profileManager.registerPage(jobId, target);
          }

          if (!target) {
            throw new Error('Tab not found');
          }

          context.page = target;
          await target.bringToFront();

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'switch-tab', true, { url: target.url() }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 41. HANDLE DIALOG
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'handle-dialog' || step.action === 'handle_dialog') {
          const action = String(finalParams.action || 'accept');
          const promptText = finalParams.promptText ? String(finalParams.promptText) : undefined;

          context.page!.removeAllListeners('dialog');

          context.page!.on('dialog', async (dialog) => {
            try {
              log(`[DIALOG] Handling ${dialog.type()}: ${dialog.message()}`);
              if (action === 'accept') {
                await dialog.accept(promptText);
              } else {
                await dialog.dismiss();
              }
            } catch (err: any) {
              log(`[DIALOG] Error handling dialog: ${err.message}`);
            }
          });

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'handle-dialog', true, { handler: action }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 42. WAIT
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'wait') {
          let waitResult: any = {};

          try {
            if (finalParams.selector) {
              const timeout = parseInt(finalParams.timeout) || 30000;
              const state = (finalParams.state || 'visible') as 'visible' | 'attached' | 'hidden';
              const selector = sanitizeSelector(String(finalParams.selector));

              log(`[WAIT] Element: ${selector}`);
              await context.page!.waitForSelector(selector, { state, timeout });
              waitResult = { type: 'selector', found: true };

            } else if (finalParams.url || finalParams.urlContains) {
              const timeout = parseInt(finalParams.timeout) || 30000;

              if (finalParams.url) {
                await context.page!.waitForURL(finalParams.url, { timeout });
              } else {
                await context.page!.waitForURL(u => u.href.includes(finalParams.urlContains), { timeout });
              }
              waitResult = { type: 'url' };

            } else if (finalParams.load) {
              const timeout = parseInt(finalParams.timeout) || 30000;
              await context.page!.waitForLoadState(finalParams.load, { timeout });
              waitResult = { type: 'load', state: finalParams.load };

            } else if (finalParams.fn || finalParams.function) {
              const timeout = parseInt(finalParams.timeout) || 30000;
              await context.page!.waitForFunction(
                String(finalParams.fn || finalParams.function),
                null,
                { timeout }
              );
              waitResult = { type: 'function' };

            } else {
              const ms = parseInt(finalParams.ms) || 1000;
              log(`[WAIT] ${ms}ms`);
              await smartWait(ms, context.isCancelled);
              waitResult = { type: 'time', ms };
            }

            globalStepNumber++;
            stepOutputs.push(createStepOutput(globalStepNumber, 'wait', true, waitResult, stepStartTime));

          } catch (e: any) {
            if (parseBoolean(finalParams.optional) && e.message?.includes('Timeout')) {
              globalStepNumber++;
              stepOutputs.push(createStepOutput(
                globalStepNumber,
                'wait',
                true,
                { ...waitResult, timedOut: true },
                stepStartTime
              ));
            } else {
              throw e;
            }
          }
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 40. COOKIE (get / set / getAll / clear) — [E2 Automa-style]
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'cookie' || step.action === 'cookies') {
          const op = String(finalParams.op || finalParams.action || 'getAll').toLowerCase();
          const ctx = context.page!.context();
          let resultData: any = null;

          log(`[COOKIE] ${op}`);

          if (op === 'set') {
            const name = String(finalParams.name || '').trim();
            if (!name) throw new Error('Cookie name required for set');
            const value = String(finalParams.value ?? '');
            let url = finalParams.url ? String(finalParams.url) : undefined;
            const domain = finalParams.domain ? String(finalParams.domain) : undefined;
            if (!url && !domain) {
              url = context.page!.url();
            }
            const cookie: any = { name, value };
            if (url) cookie.url = url;
            if (domain) {
              cookie.domain = domain;
              cookie.path = finalParams.path ? String(finalParams.path) : '/';
            }
            if (finalParams.expires) cookie.expires = parseInt(finalParams.expires, 10);
            await ctx.addCookies([cookie]);
            resultData = { set: true, name };
          } else if (op === 'get') {
            const name = String(finalParams.name || '').trim();
            const all = await ctx.cookies();
            const found = all.find(c => c.name === name) || null;
            resultData = found ? found.value : null;
            if (step.saveAs) safeStoreVariable(context.variables, step.saveAs, resultData, log);
          } else if (op === 'clear') {
            await ctx.clearCookies();
            resultData = { cleared: true };
          } else {
            // getAll (default)
            const all = await ctx.cookies();
            resultData = all.map(c => ({ name: c.name, value: c.value, domain: c.domain }));
            if (step.saveAs) safeStoreVariable(context.variables, step.saveAs, resultData, log);
          }

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'cookie', true, { op, data: resultData }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 41. VARIABLE TRANSFORM (regex / slice / sort / split / replace) — [E2]
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'variable' || step.action === 'transform' || step.action === 'set-variable') {
          const op = String(finalParams.op || 'set').toLowerCase();
          const target = String(finalParams.name || finalParams.target || '').trim();
          if (!target) throw new Error('Variable name required');

          // Source value: explicit "value", or read from an existing variable "from"
          let src: any = finalParams.value;
          if (finalParams.from) {
            src = context.variables.get(String(finalParams.from));
          }

          let out: any = src;

          if (op === 'set') {
            out = src;
          } else if (op === 'regex') {
            // Safe regex with length + flag guards (anti-ReDoS: cap input size)
            const patternStr = String(finalParams.pattern || '');
            if (patternStr.length > 1000) throw new Error('Regex pattern too long');
            const rawFlags = String(finalParams.flags || '');
            const flags = (rawFlags.match(/[gimsu]/g) || []).join('').slice(0, 6);
            const input = String(src ?? '').slice(0, 100000);
            const re = new RegExp(patternStr, flags);
            if (flags.includes('g')) {
              out = input.match(re) || [];
            } else {
              const m = re.exec(input);
              out = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
            }
          } else if (op === 'replace') {
            const patternStr = String(finalParams.pattern || '');
            if (patternStr.length > 1000) throw new Error('Pattern too long');
            const rawFlags = String(finalParams.flags || 'g');
            const flags = (rawFlags.match(/[gimsu]/g) || []).join('').slice(0, 6);
            const replacement = String(finalParams.replacement ?? '');
            const input = String(src ?? '').slice(0, 100000);
            out = input.replace(new RegExp(patternStr, flags), replacement);
          } else if (op === 'slice') {
            const start = parseInt(finalParams.start, 10) || 0;
            const end = finalParams.end !== undefined && finalParams.end !== ''
              ? parseInt(finalParams.end, 10) : undefined;
            if (Array.isArray(src)) {
              out = src.slice(start, end);
            } else {
              out = String(src ?? '').slice(start, end);
            }
          } else if (op === 'split') {
            const sep = finalParams.separator !== undefined ? String(finalParams.separator) : ',';
            out = String(src ?? '').split(sep);
          } else if (op === 'join') {
            const sep = finalParams.separator !== undefined ? String(finalParams.separator) : ',';
            out = Array.isArray(src) ? src.join(sep) : String(src ?? '');
          } else if (op === 'sort') {
            const arr = Array.isArray(src) ? src.slice() : String(src ?? '').split(/\r?\n/);
            const numeric = parseBoolean(finalParams.numeric);
            const desc = parseBoolean(finalParams.desc);
            arr.sort((a: any, b: any) => {
              if (numeric) return Number(a) - Number(b);
              return String(a).localeCompare(String(b));
            });
            if (desc) arr.reverse();
            out = arr;
          } else {
            throw new Error(`Unknown variable op: ${op}`);
          }

          safeStoreVariable(context.variables, target, out, log);
          log(`[VARIABLE] ${op} -> ${target}`);

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'variable', true, { op, name: target }, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 42. EXPORT DATA (json / csv to downloads dir) — [E3]
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'export-data' || step.action === 'export_data' || step.action === 'export') {
          const format = String(finalParams.format || 'json').toLowerCase();
          // Data: explicit "data", or from a variable name, or whole variable store
          let data: any = finalParams.data;
          if (finalParams.from) {
            data = context.variables.get(String(finalParams.from));
          }
          if (data === undefined || data === null) {
            data = Object.fromEntries(context.variables);
          }

          const safeName = String(finalParams.filename || `export_${jobId}`)
            .replace(/[^a-zA-Z0-9_.-]/g, '_')
            .slice(0, 80);
          const ext = format === 'csv' ? '.csv' : '.json';
          const baseName = safeName.endsWith(ext) ? safeName : safeName + ext;

          const userDownloadsDir = path.resolve(config.DOWNLOADS_DIR || './downloads', pipelineSafeUserId(userId));
          await fs.promises.mkdir(userDownloadsDir, { recursive: true });
          const outPath = validateFilePath(path.join(userDownloadsDir, baseName), userId, 'download');

          let content = '';
          if (format === 'csv') {
            content = toCsv(data);
          } else {
            content = JSON.stringify(data, null, 2);
          }

          if (content.length > MAX_VARIABLE_SIZE) {
            throw new Error('Export data too large (max 500KB)');
          }

          await fs.promises.writeFile(outPath, content, 'utf-8');
          log(`[EXPORT] ${format} -> ${baseName} (${content.length} bytes)`);

          const resultData = { file: baseName, format, bytes: content.length };
          if (step.saveAs) safeStoreVariable(context.variables, step.saveAs, resultData, log);

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'export-data', true, resultData, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 43. NOTIFICATION (server-side log + step output) — [E2]
        // ════════════════════════════════════════════════════════════════
        if (step.action === 'notification' || step.action === 'notify') {
          const title = pipelineSafeLog(String(finalParams.title || 'Notification'));
          const message = pipelineSafeLog(String(finalParams.message || finalParams.body || ''));
          const level = String(finalParams.level || 'info').toLowerCase();

          log(`[NOTIFY:${level}] ${title}${message ? ' — ' + message : ''}`);

          const resultData = { title, message, level };
          if (step.saveAs) safeStoreVariable(context.variables, step.saveAs, resultData, log);

          globalStepNumber++;
          stepOutputs.push(createStepOutput(globalStepNumber, 'notification', true, resultData, stepStartTime));
          continue stepLoop;
        }

        // ════════════════════════════════════════════════════════════════
        // 43. EXTERNAL MODULE (Fallback)
        // ════════════════════════════════════════════════════════════════
        const loadedModule = moduleLoader.load(step.action);

        if (!loadedModule || typeof loadedModule.run !== 'function') {
          throw new Error(`Action "${step.action}" not found`);
        }

        log(`[MODULE] Running: ${step.action}`);

        const result = await withStepTimeout(
          loadedModule.run(context, finalParams),
          globalStepNumber + 1,
          step.action
        );

        globalStepNumber++;
        stepOutputs.push(createStepOutput(globalStepNumber, step.action, true, result, stepStartTime));

        // Step 21: maintain the uniform item stream. Normalize this
        // step's result into items; when a step yields nothing usable
        // (e.g. a click) the previous stream passes through unchanged.
        {
          const __inputItems: WorkflowItem[] = context.items;
          const __produced = normalizeToItems(result);
          const __outputItems: WorkflowItem[] =
            __produced.length > 0 ? __produced : __inputItems;
          context.items = __outputItems;
          // Remember this node's output for future $node["key"].json refs.
          const __nodeKey = step.saveAs || `${step.action}#${globalStepNumber}`;
          context.nodeOutputs[__nodeKey] = __outputItems;
          // Attach item-flow metadata to the StepOutput we just pushed.
          const __so = stepOutputs[stepOutputs.length - 1];
          const __sum = summarizeItems(__outputItems);
          __so.inputItemCount = __inputItems.length;
          __so.outputItemCount = __sum.itemCount;
          __so.outputSample = __sum.sample;
          __so.outputTruncated = __sum.truncated;
        }

        if (step.saveAs) {
          safeStoreVariable(context.variables, step.saveAs, result, log);
        }

        if (globalStepNumber % config.PARTIAL_SAVE_INTERVAL === 0) {
          await savePartialOutputs(userId, jobId, stepOutputs, log);
        }

        if (isVip) {
          profileManager.updateActivity(userId);
        }

      } catch (stepError: any) {
        // Step 27: never retry/swallow fatal control-flow errors.
        const __fatal = stepError instanceof WorkflowFailError
          || /^(CANCELLED_BY_USER|PAGE_CLOSED_BY_USER|QUOTA_EXHAUSTED|Safety Stop)/.test(String(stepError && stepError.message));
        // Retry-on-fail: roll back this attempt's bookkeeping and try again.
        if (!__fatal && __policy.retryOnFail && shouldRetry(__attempt, __policy.maxTries)) {
          globalStepNumber = __sgBefore;
          stepOutputs.length = __soBefore;
          const __delay = retryDelayMs(__attempt, __policy.waitBetweenTriesMs);
          log(`[RETRY] Step '${step.action}' failed (attempt ${__attempt}/${__policy.maxTries}): ${stepError.message}. Retrying in ${__delay}ms...`);
          context.onEvent?.('step.retry', { index: globalStepNumber + 1, action: step.action, attempt: __attempt, maxTries: __policy.maxTries, error: String(stepError.message || stepError) });
          await new Promise(r => setTimeout(r, __delay));
          continue; // retry the step body (while loop)
        }
        // Record the failed step output + emit step.error.
        globalStepNumber++;
        stepOutputs.push(createStepOutput(
          globalStepNumber,
          step.action,
          false,
          null,
          stepStartTime,
          stepError.message
        ));
        context.onEvent?.('step.error', { index: globalStepNumber, action: step.action, error: String(stepError.message || stepError) });
        // Continue-on-fail: swallow the (non-fatal) error and carry on.
        if (!__fatal && __policy.continueOnFail) {
          log(`[CONTINUE-ON-FAIL] Step '${step.action}' failed but continueOnFail is set; continuing.`);
          if (step.saveAs) {
            safeStoreVariable(context.variables, step.saveAs, { error: String(stepError.message || stepError) }, log);
          }
          break; // leave the retry loop; the for-loop advances to next step
        }
        throw stepError;
      }
      break; // attempt succeeded — leave the retry loop
      } // end Step 27 retry while-loop

      // Step 16: live event - announce step completion (best-effort).
      if (stepOutputs.length > __outLenBefore) {
        const __last = stepOutputs[stepOutputs.length - 1];
        context.onEvent?.('step.done', {
          index: __last.step,
          action: __last.action,
          success: __last.success,
          durationMs: __last.durationMs,
          // Step 21: per-step item flow for the NDV-style live panel.
          inputItemCount: __last.inputItemCount,
          outputItemCount: __last.outputItemCount,
          outputSample: __last.outputSample,
          outputTruncated: __last.outputTruncated
        });
      }
    }
  };

  // ════════════════════════════════════════════════════════════════
  // EXECUTION & CLEANUP
  // ════════════════════════════════════════════════════════════════

  try {
    const finalResult = await executeStepGroup(steps);

    watchdogActive = false;
    clearInterval(watchdog);

    const finalElapsed = Math.round((Date.now() - lastQuotaCheck) / 1000);
    if (finalElapsed > 0) {
      await quotaManager.consumeQuota(userId, finalElapsed, userPlan.quota);
    }

    if (context.browserContext) {
      if (!isVip) {
        try {
          await context.browserContext.close();
        } catch (err: any) {
          log(`[BROWSER] Error closing context: ${err.message}`);
        }
        profileManager.removeFreeContext(jobId);
      }
      profileManager.unregisterPage(jobId);
    }

    if (finalResult?.return) {
      return {
        success: true,
        message: 'Completed',
        result: finalResult.returnValue,
        durationMs: Date.now() - startTime
      };
    }

    return {
      success: true,
      message: 'All steps completed',
      durationMs: Date.now() - startTime
    };

  } catch (err: any) {
    watchdogActive = false;
    clearInterval(watchdog);

    const finalElapsed = Math.round((Date.now() - lastQuotaCheck) / 1000);
    if (finalElapsed > 0) {
      try {
        await quotaManager.consumeQuota(userId, finalElapsed, userPlan.quota);
      } catch { }
    }

    await savePartialOutputs(userId, jobId, stepOutputs, log).catch(() => { });

    if (context.browserContext) {
      if (!isVip) {
        try {
          await context.browserContext.close();
        } catch { }
        profileManager.removeFreeContext(jobId);
      }
      profileManager.unregisterPage(jobId);
    }

    if (err.message === 'QUOTA_EXHAUSTED') {
      throw new Error('Daily quota exhausted');
    }

    if (err instanceof WorkflowFailError) {
      return {
        success: false,
        message: err.message,
        failedByUser: true,
        durationMs: Date.now() - startTime
      };
    }

    if (err instanceof SecurityError) {
      log(`[SECURITY] ${err.message}`);
      throw err;
    }

    throw err;
  }
}