/**
 * Instance access — ONE install, ONE owner, ONE access token.
 *
 * There are no user accounts, no roles and no per-user keys. The access token
 * (API_TOKEN, rotatable from Settings → Access & API) is a credential for THIS
 * install; every request that presents it acts as the owner, whose fixed
 * identity is `local`. Rotating the token invalidates the old one immediately
 * (config.API_TOKEN is a live getter).
 *
 * Environment decides whether a token is needed (not a setting):
 *   development  a request from this same machine (loopback SOCKET address —
 *                never X-Forwarded-For, which a client writes) needs no token.
 *                Any other peer still needs it.
 *   production   every request needs the token, from anywhere.
 */
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';

export interface AuthenticatedRequest extends Request {
  apiKey?: string;
  apiKeyPrefix?: string;
  apiKeyUserId?: string;
}

/** The owner's fixed identity. Every route scopes data to it. */
export const SINGLE_USER_ID = 'local';

/** A loopback peer, read from the SOCKET (never from X-Forwarded-For). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

/**
 * Does keyless access apply to THIS request? Development only, and only for a
 * caller that cannot be anyone but the owner: this machine, or (with
 * ALLOW_OPEN_AUTH=true, set only by the loopback-only dev compose file) the
 * container's bridge peer.
 */
export function isOpenAuthRequest(req: { socket?: { remoteAddress?: string } }): boolean {
  if (!config.AUTH_OPEN) return false;
  if (config.ALLOW_OPEN_AUTH) return true;
  return isLoopbackAddress(req.socket?.remoteAddress);
}

/** Constant-time comparison with the instance token. */
export function isInstanceToken(presented: string | undefined | null): boolean {
  const expected = config.API_TOKEN;
  if (!presented || !expected) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/** Every place a credential may arrive, in one order (header, query, bearer). */
export function presentedKey(req: Request): string | undefined {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) return headerKey;
  if (req.query?.api_key) return String(req.query.api_key);
  if (req.query?.token) return String(req.query.token);
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7).trim();
  return undefined;
}

/** Middleware: the request must be the owner (token, or keyless dev-local). */
export const requireApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const apiKey = presentedKey(req);

  if (!apiKey && isOpenAuthRequest(req)) {
    req.apiKey = config.API_TOKEN;
    req.apiKeyPrefix = 'local';
    req.apiKeyUserId = SINGLE_USER_ID;
    next();
    return;
  }
  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      hint: 'Send the instance access token in the x-api-key header (or Authorization: Bearer).',
    });
    return;
  }
  if (!isInstanceToken(apiKey)) {
    const masked = apiKey.length > 8 ? apiKey.substring(0, 8) + '...' : '***';
    console.warn(`[AUTH] ❌ Invalid access token: ${masked} from ${req.ip}`);
    res.status(403).json({ success: false, error: 'Invalid API token' });
    return;
  }
  req.apiKey = apiKey;
  req.apiKeyPrefix = apiKey.substring(0, Math.min(15, apiKey.length));
  req.apiKeyUserId = SINGLE_USER_ID;
  next();
};
