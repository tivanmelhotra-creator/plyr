import type { PlanConfig } from './config';
import { config } from './config';
import { parseBrowserOptions } from './core/BrowserOptions';

// === REGEX PATTERNS ===
const SAFE_MODULE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/;
const SAFE_USER_ID_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

// === PRIVATE IP PATTERNS (for SSRF protection) ===
const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // Loopback
  /^10\./,                           // Private Class A
  /^192\.168\./,                     // Private Class C
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // Private Class B
  /^0\./,                            // Current network
  /^169\.254\./,                     // Link-local
  /^::1$/,                           // IPv6 Loopback
  /^fc00:/i,                         // IPv6 Unique local
  /^fe80:/i,                         // IPv6 Link-local
  /^fd[0-9a-f]{2}:/i,                // IPv6 Unique local
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  '169.254.169.254',
  'metadata',
  'kubernetes.default',
];

// === INTERFACES ===
export interface StepInput {
  action: string;
  /** Skipped at run time; kept in the saved document (see AutomationStep). */
  disabled?: boolean;
  params?: Record<string, any>;
  saveAs?: string;
  condition?: any;
  then?: StepInput[];
  else?: StepInput[];
  /**
   * Mission 7 — ordered, first-match-wins branches of an `if` step. Anything
   * not mapped in mapStep() below is stripped before it reaches the pipeline,
   * so this MUST stay in sync with the recursion at the bottom of this file.
   */
  paths?: { id?: string; name?: string; condition?: any; steps?: StepInput[] }[];
  /** Router `default` port. */
  fallback?: StepInput[];
  steps?: StepInput[];
  catch?: StepInput[];
  finally?: StepInput[];
  cases?: Record<string, StepInput[]>;
  [key: string]: any;
}

// === SANITIZATION FUNCTIONS ===

export const sanitizeModuleName = (name: unknown): string => {
  if (typeof name !== 'string') {
    throw new Error('Module name must be a string');
  }

  const trimmed = name.trim();

  if (!SAFE_MODULE_NAME_REGEX.test(trimmed)) {
    throw new Error(`Invalid module name format: "${trimmed}". Use alphanumeric characters, dashes, and underscores only.`);
  }

  return trimmed;
};

export const sanitizeUserId = (id: unknown): string => {
  const str = String(id ?? '').trim();

  if (str.length === 0) {
    throw new Error('userId cannot be empty');
  }

  if (!SAFE_USER_ID_REGEX.test(str)) {
    throw new Error('Invalid userId format. Use alphanumeric characters, dashes, or underscores (1-50 chars).');
  }

  return str;
};

export const sanitizeLogMessage = (msg: unknown): string => {
  if (typeof msg !== 'string') {
    return String(msg ?? '');
  }

  return msg
    .replace(/[\r\n]/g, ' ')           // Remove newlines (log injection)
    .replace(/\x1b\[[0-9;]*m/g, '')    // Remove ANSI escape codes
    .replace(/[\x00-\x1f\x7f]/g, '')   // Remove control characters
    .substring(0, 500);                 // Limit length
};

// === PRIVATE IP CHECK (SSRF Protection) ===

const isPrivateIP = (hostname: string): boolean => {
  const lowerHost = hostname.toLowerCase();

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(lowerHost)) {
    return true;
  }

  // Check IP patterns
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  return false;
};

// === WEBHOOK VALIDATION ===

export const validateWebhookUrl = (url: unknown): string | null => {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim();

  if (trimmed.length === 0 || trimmed.length > 2048) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);

    // Only allow http/https
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }

    // Block private IPs unless explicitly allowed
    if (!config.WEBHOOK_ALLOW_PRIVATE_IPS && isPrivateIP(parsed.hostname)) {
      console.warn(`[SECURITY] Blocked webhook to private IP: ${parsed.hostname}`);
      return null;
    }

    // Block credentials in URL
    if (parsed.username || parsed.password) {
      return null;
    }

    return trimmed;
  } catch {
    return null;
  }
};

// === HEADLESS VALIDATION ===

export const validateHeadless = (value: unknown, defaultValue: boolean = true): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return defaultValue;
};

// === STEPS VALIDATION ===

export const validateSteps = (
  input: unknown,
  userPlan?: PlanConfig,
  opts: { allowEmpty?: boolean } = {}
): StepInput[] => {
  if (!Array.isArray(input)) {
    throw new Error('Steps must be an array');
  }

  // A saved (not run) workflow may be empty; see workflowBodySchema.
  if (input.length === 0 && opts.allowEmpty) return [];

  if (input.length === 0) {
    throw new Error('Steps cannot be empty');
  }

  const maxSteps = userPlan?.maxSteps || 200;
  if (input.length > maxSteps) {
    throw new Error(`Maximum ${maxSteps} steps allowed for your plan`);
  }

  // Check total size
  const jsonSize = JSON.stringify(input).length;
  if (jsonSize > 1024 * 100) { // 100KB
    throw new Error('Steps data too large (max 100KB)');
  }

  const mapStep = (step: any, index: number): StepInput => {
    if (typeof step !== 'object' || step === null) {
      throw new Error(`Step at index ${index} must be an object`);
    }

    // Validate action name
    const action = sanitizeModuleName(step.action);

    // Extract params
    let params: Record<string, any> = {};

    if (step.params && typeof step.params === 'object' && !Array.isArray(step.params)) {
      params = step.params;
    } else {
      // Legacy format: params are in step directly
      const {
        action: _,
        saveAs: __,
        condition: ___,
        then: ____,
        else: _____,
        steps: ______,
        catch: _______,
        finally: ________,
        cases: _________,
        paths: __________,
        fallback: _________f,
        disabled: _________d,
        continueOnFail: _c1,
        retryOnFail: _c2,
        maxTries: _c3,
        waitBetweenTriesMs: _c4,
        ...rest
      } = step;

      if (Object.keys(rest).length > 0) {
        params = rest;
      }
    }

    // Launch Browser options: validated against the shared catalog at the API
    // boundary, so a typo or an out-of-range value is a readable 400 now, not a
    // silently ignored setting at run time.
    if (/^launch([-_]browser)?$/.test(action) && params.browserOptions !== undefined
        && params.browserOptions !== null && params.browserOptions !== '') {
      const parsed = parseBrowserOptions(params.browserOptions);
      if (!parsed.ok) {
        throw new Error(`Step at index ${index}: invalid browser options - ${parsed.errors.join('; ')}`);
      }
      params = { ...params, browserOptions: parsed.options };
    }

    const cleanStep: StepInput = { action, params };

    // Optional fields
    if (step.saveAs && typeof step.saveAs === 'string') {
      cleanStep.saveAs = step.saveAs.trim();
    }

    if (step.condition) {
      cleanStep.condition = step.condition;
    }

    if (step.disabled === true) cleanStep.disabled = true;

    // Per-node error policy (core/ErrorPolicy). These used to be dropped here,
    // so Continue/Retry On Fail set in the editor never reached the runtime.
    // Values are clamped later by normalizeErrorPolicy(); only the types are
    // checked at this boundary.
    if (step.continueOnFail === true) cleanStep.continueOnFail = true;
    if (step.retryOnFail === true) cleanStep.retryOnFail = true;
    if (typeof step.maxTries === 'number' && Number.isFinite(step.maxTries)) cleanStep.maxTries = step.maxTries;
    if (typeof step.waitBetweenTriesMs === 'number' && Number.isFinite(step.waitBetweenTriesMs)) {
      cleanStep.waitBetweenTriesMs = step.waitBetweenTriesMs;
    }

    if (step.cases && typeof step.cases === 'object') {
      cleanStep.cases = {};
      for (const [key, steps] of Object.entries(step.cases)) {
        if (Array.isArray(steps)) {
          cleanStep.cases[key] = steps.map((s: any, i: number) => mapStep(s, i));
        }
      }
    }

    // Mission 7 — recurse into every prioritised path. A path keeps only the
    // four fields the runtime understands (id / name / condition / steps); its
    // nested steps go through the very same validation as any other branch.
    if (Array.isArray(step.paths)) {
      cleanStep.paths = step.paths
        .filter((p: any) => p && typeof p === 'object')
        .map((p: any, pi: number) => {
          const cleanPath: { id?: string; name?: string; condition?: any; steps?: StepInput[] } = {};
          if (typeof p.id === 'string') cleanPath.id = p.id.trim().slice(0, 24);
          if (typeof p.name === 'string') cleanPath.name = p.name.slice(0, 120);
          if (p.condition) cleanPath.condition = p.condition;
          if (Array.isArray(p.steps)) {
            cleanPath.steps = p.steps.map((s: any, i: number) => mapStep(s, i));
          }
          if (!cleanPath.id) cleanPath.id = `p${pi + 1}`;
          return cleanPath;
        });
    }

    // Router `default` port — same recursive validation as any other branch.
    if (Array.isArray(step.fallback)) {
      cleanStep.fallback = step.fallback.map((s: any, i: number) => mapStep(s, i));
    }

    // Recursive validation for nested steps
    if (Array.isArray(step.then)) {
      cleanStep.then = step.then.map((s: any, i: number) => mapStep(s, i));
    }

    if (Array.isArray(step.else)) {
      cleanStep.else = step.else.map((s: any, i: number) => mapStep(s, i));
    }

    if (Array.isArray(step.steps)) {
      cleanStep.steps = step.steps.map((s: any, i: number) => mapStep(s, i));
    }

    if (Array.isArray(step.catch)) {
      cleanStep.catch = step.catch.map((s: any, i: number) => mapStep(s, i));
    }

    if (Array.isArray(step.finally)) {
      cleanStep.finally = step.finally.map((s: any, i: number) => mapStep(s, i));
    }

    return cleanStep;
  };

  return input.map((step, index) => mapStep(step, index));
};