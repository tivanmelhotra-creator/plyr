/**
 * Settings routes — change configuration from the panel, no .env, no shell.
 *
 *   GET  /auth/mode                      public. Tells the login screen whether
 *                                        to sign in by itself (AUTH_MODE=open).
 *   GET  /settings                       catalog + current value + source.
 *                                        Secrets are masked.
 *   POST /settings/reveal   {key}        the plain value of one secret.
 *   PUT  /settings          {changes}    validate ALL, then apply ALL.
 *   POST /settings/generate {key}        server-generated token/secret, applied.
 *
 * Everything but /auth/mode is mounted behind requireApiKey (see index.ts), and
 * in multi-user mode it additionally requires the env (admin) key: in a
 * multi-tenant install a tenant must not be able to rotate the instance token.
 */
import { Router, type Response } from 'express';
import { config } from '../config';
import type { AuthenticatedRequest } from '../middleware/auth';
import { isOpenAuthRequest } from '../middleware/auth';
import { saveSetting, sourceOf, envValueOf, settingsFilePath, liveRaw } from '../core/PersistedSettings';
import {
  CATALOG, specOf, validateValue, generateSecret, PUBLIC_DEFAULT_TOKEN,
  type SettingSpec, type ValidateCtx,
} from '../core/SettingsCatalog';
import { applySetting } from '../core/RuntimeSettings';

/** The value in force in THIS process (boot value for restart-type keys). */
function activeValue(key: string): string {
  const c = config as unknown as Record<string, unknown>;
  switch (key) {
    case 'APP_ENV': return config.APP_PROFILE;
    case 'AUTH_MODE': return config.AUTH_MODE_REQUESTED;
    case 'API_TOKEN': return config.API_TOKEN;
    default: {
      const v = c[key];
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return v === undefined || v === null ? '' : String(v);
    }
  }
}

/**
 * The value the operator CHOSE. Equal to activeValue() for live settings; for
 * restart settings saved in this process it is the saved value, which takes
 * effect after the next restart (`pendingRestart`).
 */
function chosenValue(key: string): string {
  const spec = specOf(key);
  if (spec?.apply === 'restart') {
    const r = liveRaw(key);
    if (r !== undefined) return (r ?? envValueOf(key) ?? '').trim() || spec.dflt;
  }
  return activeValue(key);
}

function mask(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}${'•'.repeat(8)}${v.slice(-4)}`;
}

function describe(spec: SettingSpec) {
  const value = chosenValue(spec.key);
  const active = activeValue(spec.key);
  const source = sourceOf(spec.key);
  const envValue = envValueOf(spec.key);
  const isSecret = spec.type === 'secret';
  return {
    key: spec.key,
    group: spec.group,
    type: spec.type,
    apply: spec.apply,
    fa: spec.fa, en: spec.en, hintFa: spec.hintFa, hintEn: spec.hintEn,
    options: spec.options,
    generatable: !!spec.generatable,
    clearable: !!spec.clearable,
    default: isSecret ? undefined : spec.dflt,
    value: isSecret ? mask(value) : value,
    active: isSecret ? undefined : active,
    hasValue: value !== '',
    isPublicDefault: spec.key === 'API_TOKEN' ? config.API_TOKEN_IS_DEFAULT : undefined,
    pendingRestart: spec.apply === 'restart' && value !== active,
    source,
    // The panel's value hides a different one in .env: say so, so nobody edits
    // .env and wonders why nothing changed.
    overridesEnv: source === 'panel' && envValue !== undefined && envValue.trim() !== '' && envValue.trim() !== value,
  };
}

function isAllowed(req: AuthenticatedRequest): boolean {
  if (config.IS_SINGLE_USER) return true;
  return req.apiKeyUserId === 'env_root';
}

function deny(res: Response): void {
  res.status(403).json({ success: false, error: 'Only the instance owner (admin key) can change settings' });
}

function normProfile(p: string): string {
  const v = p.toLowerCase();
  if (v === 'dev') return 'development';
  if (v === 'prod') return 'production';
  if (v === 'remote') return 'server';
  return v;
}

function ctxFor(profileAfter: string): ValidateCtx {
  return {
    profile: normProfile(profileAfter),
    allowDefaultToken: config.ALLOW_DEFAULT_API_TOKEN === true,
    // Open login is allowed only where the profile IN FORCE allows it: APP_ENV
    // needs a restart, so a pending change to development does not unlock it.
    openAllowed: config.AUTH_OPEN_ALLOWED,
    singleUser: config.IS_SINGLE_USER,
  };
}

async function applyOne(key: string, value: string | null) {
  const saved = saveSetting(key, value);
  // REAL_CHROME_ENABLED has its own in-memory override (RuntimeSettings) that
  // other code relies on; keep it in step without touching .env.
  if (key === 'REAL_CHROME_ENABLED') {
    const on = (value ?? envValueOf(key) ?? 'true').trim().toLowerCase() !== 'false';
    await applySetting('REAL_CHROME_ENABLED', on, { persist: false });
  }
  return saved;
}

export function createSettingsRoutes(): { publicRouter: Router; router: Router } {
  const publicRouter = Router();
  const router = Router();

  publicRouter.get('/auth/mode', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const open = isOpenAuthRequest(req);
    res.json({
      success: true,
      mode: open ? 'open' : 'token',
      requested: config.AUTH_MODE_REQUESTED,
      // Why "open" was requested but is not in force — the login screen says so.
      openRefused: config.AUTH_MODE_REQUESTED === 'open' && !open
        ? (config.AUTH_OPEN_ALLOWED ? 'not_local' : 'profile') : null,
      profile: config.APP_PROFILE,
      // Only to a caller open mode already treats as the owner. The panel needs
      // the real token anyway for WebSockets, download links and the extension.
      token: open ? config.API_TOKEN : undefined,
    });
  });

  router.get('/settings', (req: AuthenticatedRequest, res) => {
    if (!isAllowed(req)) return deny(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      profile: config.APP_PROFILE,
      singleUser: config.IS_SINGLE_USER,
      openAllowed: config.AUTH_OPEN_ALLOWED,
      authOpen: config.AUTH_OPEN,
      file: settingsFilePath(),
      settings: CATALOG.map(describe),
    });
  });

  router.post('/settings/reveal', (req: AuthenticatedRequest, res) => {
    if (!isAllowed(req)) return deny(res);
    const spec = specOf(String(req.body?.key || ''));
    if (!spec || spec.type !== 'secret') {
      res.status(400).json({ success: false, error: 'Not a secret setting' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, key: spec.key, value: activeValue(spec.key) });
  });

  router.put('/settings', async (req: AuthenticatedRequest, res) => {
    if (!isAllowed(req)) return deny(res);
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      res.status(400).json({ success: false, error: 'Body must be { changes: { KEY: value } }' });
      return;
    }
    const entries = Object.entries(changes as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 50) {
      res.status(400).json({ success: false, error: 'Nothing to change' });
      return;
    }
    const requestedEnv = (changes as Record<string, unknown>).APP_ENV;
    const profileAfter = normProfile(typeof requestedEnv === 'string' ? requestedEnv : chosenValue('APP_ENV'));
    const ctx = ctxFor(profileAfter);

    // Validate everything first: a half-applied change set is worse than none.
    const errors: Record<string, { error: string; errorFa: string }> = {};
    const accepted = new Map<string, string | null>();
    for (const [key, raw] of entries) {
      const spec = specOf(key);
      if (!spec) { errors[key] = { error: 'Unknown setting', errorFa: 'تنظیم ناشناخته' }; continue; }
      const r = validateValue(spec, raw, ctx);
      if ('error' in r) errors[key] = r; else accepted.set(key, r.value);
    }
    // A server profile with the public token would refuse to boot.
    if (!errors.APP_ENV && accepted.has('APP_ENV') && (profileAfter === 'server' || profileAfter === 'production')) {
      const tokenAfter = accepted.has('API_TOKEN') ? accepted.get('API_TOKEN') : config.API_TOKEN;
      if ((tokenAfter ?? PUBLIC_DEFAULT_TOKEN) === PUBLIC_DEFAULT_TOKEN && !config.ALLOW_DEFAULT_API_TOKEN) {
        errors.APP_ENV = { error: 'Generate an API token first: a server refuses to start with admin123.',
          errorFa: 'ابتدا یک توکن API بسازید؛ سرور با admin123 بالا نمی‌آید.' };
      }
      // Leaving development: login is required again.
      if ((accepted.get('AUTH_MODE') ?? config.AUTH_MODE_REQUESTED) === 'open') accepted.set('AUTH_MODE', 'token');
    }
    if (Object.keys(errors).length) {
      res.status(400).json({ success: false, error: 'Some values are not valid', errors });
      return;
    }

    const results: Record<string, { persisted: boolean; apply: string; error?: string }> = {};
    for (const [key, value] of accepted) {
      const r = await applyOne(key, value);
      results[key] = { persisted: r.persisted, apply: specOf(key)!.apply, ...(r.error ? { error: r.error } : {}) };
    }
    const restartNeeded = [...accepted.keys()].some((k) => specOf(k)!.apply === 'restart');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      results,
      restartNeeded,
      // The client stores this so the session that rotated the token stays in.
      newApiToken: accepted.has('API_TOKEN') ? config.API_TOKEN : undefined,
      settings: CATALOG.map(describe),
    });
  });

  router.post('/settings/generate', async (req: AuthenticatedRequest, res) => {
    if (!isAllowed(req)) return deny(res);
    const spec = specOf(String(req.body?.key || ''));
    if (!spec || !spec.generatable) {
      res.status(400).json({ success: false, error: 'This setting cannot be generated' });
      return;
    }
    const value = generateSecret();
    const r = await applyOne(spec.key, value);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      key: spec.key,
      value,
      persisted: r.persisted,
      error: r.error,
      newApiToken: spec.key === 'API_TOKEN' ? value : undefined,
      settings: CATALOG.map(describe),
    });
  });

  return { publicRouter, router };
}
