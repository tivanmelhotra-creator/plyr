/**
 * auth.routes — owner password: first-run setup, login, change.
 *
 *   GET  /auth/status           what the panel should show (no secrets, no auth)
 *   POST /auth/setup            first run only: choose the password
 *   POST /auth/login            password -> session
 *   POST /auth/change-password  signed in: current + new password
 *
 * Development (this machine) has no password at all: /auth/status answers
 * `open` and the three POSTs answer 409 `not_needed`.
 *
 * The password itself is only ever read from the request body, checked against
 * the policy in core/AuthStore (the single copy of the rules), hashed there and
 * never logged. What goes back to the browser is a SESSION, not the password.
 */
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { requireApiKey, isOpenAuthRequest, type AuthenticatedRequest } from '../middleware/auth';
import { authStore, PASSWORD_POLICY, type PasswordProblem } from '../core/AuthStore';

// ── Brute-force limiter (in-memory, per process) ─────────────────────────────
// Failures count; a success clears the counter. scrypt is deliberately slow, so
// every hashing endpoint is also capped on raw attempts.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_ATTEMPTS_PER_MIN = 30;

interface Bucket { fails: number; first: number; blockedUntil: number; recent: number[] }
const buckets = new Map<string, Bucket>();

function bucketFor(key: string, now: number): Bucket {
  let b = buckets.get(key);
  if (!b || (b.blockedUntil <= now && now - b.first > FAIL_WINDOW_MS)) {
    b = { fails: 0, first: now, blockedUntil: 0, recent: [] };
    buckets.set(key, b);
  }
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.blockedUntil <= now && now - v.first > FAIL_WINDOW_MS) buckets.delete(k);
  }
  return b;
}

/** Returns seconds to wait, or 0 when the attempt may proceed. */
function throttle(key: string): number {
  const now = Date.now();
  const b = bucketFor(key, now);
  if (b.blockedUntil > now) return Math.ceil((b.blockedUntil - now) / 1000);
  b.recent = b.recent.filter((t) => now - t < 60_000);
  if (b.recent.length >= MAX_ATTEMPTS_PER_MIN) return 60;
  b.recent.push(now);
  return 0;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const b = bucketFor(key, now);
  b.fails += 1;
  if (b.fails >= MAX_FAILURES) b.blockedUntil = now + FAIL_WINDOW_MS;
}

function recordSuccess(key: string): void { buckets.delete(key); }

export function resetAuthLimiterForTests(): void { buckets.clear(); }

// ── helpers ──────────────────────────────────────────────────────────────────

function tooMany(res: Response, seconds: number): void {
  res.setHeader('Retry-After', String(seconds));
  res.status(429).json({
    success: false, code: 'too_many_attempts',
    error: 'Too many attempts. Wait a while before trying again.',
    retryAfterSeconds: seconds,
  });
}

function policyView() {
  return {
    minLength: PASSWORD_POLICY.minLength,
    maxLength: PASSWORD_POLICY.maxLength,
    requireUpper: PASSWORD_POLICY.requireUpper,
    requireLower: PASSWORD_POLICY.requireLower,
    requireDigit: PASSWORD_POLICY.requireDigit,
  };
}

function weak(res: Response, problems: PasswordProblem[] | undefined): void {
  res.status(400).json({
    success: false, code: 'weak_password',
    error: (problems || []).map((p) => p.message).join(' ') || 'Password does not meet the policy.',
    problems: problems || [],
    policy: policyView(),
  });
}

function notNeeded(res: Response): void {
  res.status(409).json({
    success: false, code: 'not_needed',
    error: 'The development profile on this machine has no password. Use APP_ENV=production to enable one.',
  });
}

function unavailable(res: Response): void {
  res.status(503).json({
    success: false, code: 'auth_unavailable',
    error: 'The authentication store cannot be read',
    hint: authStore.unavailableReason() || 'Check auth.json in the data directory.',
  });
}

function clientKey(req: Request, scope: string): string {
  return `${scope}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function bodyString(req: Request, field: string): string | undefined {
  const v = (req.body as Record<string, unknown> | undefined)?.[field];
  return typeof v === 'string' ? v : undefined;
}

export function createAuthRoutes(): Router {
  const router = Router();

  router.get('/auth/status', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (config.AUTH_OPEN) {
      if (isOpenAuthRequest(req)) { res.json({ success: true, mode: 'open', profile: config.APP_PROFILE }); return; }
      res.json({ success: true, mode: 'local_only', profile: config.APP_PROFILE });
      return;
    }
    const st = authStore.state();
    const mode = st === 'unset' ? 'setup' : st === 'set' ? 'login' : 'unavailable';
    res.json({ success: true, mode, profile: config.APP_PROFILE, policy: policyView() });
  });

  router.post('/auth/setup', async (req: Request, res: Response) => {
    if (config.AUTH_OPEN) { notNeeded(res); return; }
    const st = authStore.state();
    if (st === 'unavailable') { unavailable(res); return; }
    if (st === 'set') {
      res.status(409).json({ success: false, code: 'already_set', error: 'A password has already been set.' });
      return;
    }
    const wait = throttle(clientKey(req, 'setup'));
    if (wait) { tooMany(res, wait); return; }
    const pw = bodyString(req, 'password');
    if (pw === undefined) { weak(res, [{ code: 'too_short', message: 'A password is required.' }]); return; }
    const r = await authStore.setInitialPassword(pw);
    if (!r.ok) {
      if (r.reason === 'weak') { weak(res, r.problems); return; }
      if (r.reason === 'already_set') {
        res.status(409).json({ success: false, code: 'already_set', error: 'A password has already been set.' });
        return;
      }
      if (r.reason === 'unavailable') { unavailable(res); return; }
      res.status(500).json({ success: false, code: 'not_saved', error: 'The password could not be saved (check write access to the data directory).' });
      return;
    }
    const s = authStore.issueSession();
    res.json({ success: true, token: s.token, expiresAt: s.expiresAt });
  });

  router.post('/auth/login', async (req: Request, res: Response) => {
    if (config.AUTH_OPEN) { notNeeded(res); return; }
    const st = authStore.state();
    if (st === 'unavailable') { unavailable(res); return; }
    if (st === 'unset') {
      res.status(409).json({ success: false, code: 'setup_required', error: 'No password has been set yet.' });
      return;
    }
    const key = clientKey(req, 'login');
    const wait = throttle(key);
    if (wait) { tooMany(res, wait); return; }
    const pw = bodyString(req, 'password');
    if (!pw || !(await authStore.verifyPassword(pw))) {
      recordFailure(key);
      res.status(401).json({ success: false, code: 'invalid_password', error: 'Incorrect password.' });
      return;
    }
    recordSuccess(key);
    const s = authStore.issueSession();
    res.json({ success: true, token: s.token, expiresAt: s.expiresAt });
  });

  router.post('/auth/change-password', requireApiKey, async (req: AuthenticatedRequest, res: Response) => {
    if (config.AUTH_OPEN) { notNeeded(res); return; }
    const key = clientKey(req, 'change');
    const wait = throttle(key);
    if (wait) { tooMany(res, wait); return; }
    const current = bodyString(req, 'current');
    const next = bodyString(req, 'next');
    if (current === undefined || next === undefined) {
      res.status(400).json({ success: false, code: 'bad_request', error: 'Both "current" and "next" are required.' });
      return;
    }
    const r = await authStore.changePassword(current, next);
    if (!r.ok) {
      switch (r.reason) {
        case 'wrong_password':
          recordFailure(key);
          res.status(401).json({ success: false, code: 'invalid_password', error: 'The current password is incorrect.' });
          return;
        case 'weak': weak(res, r.problems); return;
        case 'same':
          res.status(400).json({ success: false, code: 'same_password', error: 'The new password must differ from the current one.' });
          return;
        case 'unavailable': unavailable(res); return;
        case 'not_set':
          res.status(409).json({ success: false, code: 'setup_required', error: 'No password has been set yet.' });
          return;
        default:
          res.status(500).json({ success: false, code: 'not_saved', error: 'The password could not be saved.' });
          return;
      }
    }
    recordSuccess(key);
    // Every older session died with the epoch bump; hand back a fresh one.
    const s = authStore.issueSession();
    res.json({ success: true, token: s.token, expiresAt: s.expiresAt });
  });

  return router;
}
