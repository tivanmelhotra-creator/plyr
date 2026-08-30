import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { config } from './config';

const isGodMode = (req: Request): boolean => {
  const ip = req.ip || req.socket.remoteAddress || '';
  return config.GOD_MODE_IPS.some(godIp =>
    ip === godIp ||
    ip === `::ffff:${godIp}` ||
    ip.endsWith(godIp)
  );
};

export const smartLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.RATE_LIMIT_PER_MINUTE,
  message: {
    success: false,
    error: 'Too many requests, please slow down.',
    retryAfter: 60
  },
  skip: (req) => !config.RATE_LIMIT_ENABLED || isGodMode(req),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
});

/**
 * POST /inspector/pair — the one Inspector route that accepts no API key.
 *
 * WHY IT NEEDS ITS OWN, TIGHTER LIMIT. Every other route under /inspector is
 * behind a credential, so the API key is itself the anti-guessing measure.
 * Pairing cannot be: the whole point is that a hand-installed extension on
 * another machine has no key yet, and the one-time code is what it presents
 * instead. That makes this the only endpoint where an unauthenticated caller
 * gets to submit a secret, so it is the only one where guessing is even
 * conceivable and the only one that needs a budget.
 *
 * The arithmetic, so the number is not a vibe: a code is 8 characters from a
 * 31-symbol alphabet (`CODE_ALPHABET`, ambiguous glyphs already removed), which
 * is 31^8 ≈ 8.5e11 possibilities, and it is valid for 5 minutes and consumed on
 * first use. At 10 attempts/minute an attacker covers ~3e-9 % of the space
 * inside a code's lifetime. The limit is therefore not the primary defence — the
 * entropy is — it exists so that a script cannot turn a 5-minute window into
 * millions of tries, and so the attempt shows up as refusals rather than as
 * silent load.
 *
 * Keyed by IP and NOT skipped for GOD_MODE_IPS: an operator's own address is
 * exactly where a misbehaving extension retry loop would come from, and this
 * limit protects a secret rather than a resource, so there is nobody it should
 * be waived for.
 */
export const pairingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    success: false,
    reason: 'TOO_MANY_ATTEMPTS',
    error: 'Too many authorization attempts. Wait a minute, then get a fresh code.',
    retryAfter: 60
  },
  skip: () => !config.RATE_LIMIT_ENABLED,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
});

export const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.ADMIN_RATE_LIMIT_PER_MINUTE,
  message: {
    success: false,
    error: 'Too many admin requests.',
    retryAfter: 60
  },
  skip: (req) => isGodMode(req),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
});