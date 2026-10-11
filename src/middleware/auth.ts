/**
 * Instance access — ONE install, ONE owner.
 *
 * There are no user accounts, no roles and no per-user keys. Every request that
 * passes acts as the owner, whose fixed identity is `local`.
 *
 * WHO NEEDS A CREDENTIAL (the environment decides, it is not a setting)
 * ---------------------------------------------------------------------
 *   development  a request from THIS machine (loopback SOCKET address — never
 *                X-Forwarded-For, which a client writes) needs NOTHING: no login,
 *                no token, and no credential is looked at. A request that carries
 *                a forwarding header is not treated as local (a reverse proxy on
 *                the same host would otherwise open the whole instance).
 *                Any other peer is refused: development is a this-machine mode.
 *   production   every request needs a credential, from anywhere:
 *                  • a SESSION issued after the owner's password (POST /auth/login),
 *                  • the optional API token an operator chose on purpose
 *                    (Settings → Access & API), for scripts, or
 *                  • the INTERNAL service credential the server's own side-loaded
 *                    extension uses (never shown to anyone).
 *
 * The password is not a credential you send on every request; it is exchanged
 * once for a session. See core/AuthStore.ts.
 */
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { authStore, safeEqual } from '../core/AuthStore';

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

type PeerLike = {
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * Does keyless access apply to THIS request? Development only, and only for a
 * caller that cannot be anyone but the owner: this machine, or (with
 * ALLOW_OPEN_AUTH=true, set only by the loopback-only dev compose file) the
 * container's bridge peer.
 */
export function isOpenAuthRequest(req: PeerLike): boolean {
  if (!config.AUTH_OPEN) return false;
  const h = req.headers || {};
  // A proxy in front of us (even on this machine) says so. Such a request is
  // not "from this machine", whatever the socket looks like.
  if (h['x-forwarded-for'] || h['forwarded'] || h['x-real-ip']) return false;
  if (config.ALLOW_OPEN_AUTH) return true;
  return isLoopbackAddress(req.socket?.remoteAddress);
}

/**
 * Is `presented` a credential this server issued or was told to accept?
 * Constant-time for every comparison.
 */
export function isAcceptedCredential(presented: string | undefined | null): boolean {
  if (!presented) return false;
  const p = String(presented);
  if (authStore.verifySession(p)) return true;
  if (authStore.isServiceToken(p)) return true;
  const optional = config.API_TOKEN;
  return !!optional && safeEqual(p, optional);
}

/** @deprecated name kept for older callers/tests: same as isAcceptedCredential. */
export const isInstanceToken = isAcceptedCredential;

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

/** Machine-readable reason, so the panel can tell "sign in again" from "forbidden". */
export type AuthFailureCode = 'auth_required' | 'invalid_credential' | 'setup_required' | 'local_only' | 'auth_unavailable';

function refuse(req: Request, res: Response, presented: string | undefined): void {
  const dev = config.AUTH_OPEN;
  const st = authStore.state();
  let code: AuthFailureCode;
  let status = 401;
  let error: string;
  let hint: string;
  if (dev) {
    code = 'local_only';
    error = 'Development mode is only available from the machine the server runs on';
    hint = 'Open the panel on the server itself, or switch the environment to production to sign in with a password.';
  } else if (st === 'unavailable') {
    code = 'auth_unavailable';
    status = 503;
    error = 'The authentication store cannot be read';
    hint = authStore.unavailableReason() || 'Check the auth.json file in the data directory.';
  } else if (st === 'unset' && !presented) {
    code = 'setup_required';
    error = 'No password has been set yet';
    hint = 'Open the panel in a browser and choose a password (first-run setup).';
  } else if (!presented) {
    code = 'auth_required';
    error = 'Authentication required';
    hint = 'Sign in with your password (POST /auth/login) and send the session in the x-api-key header (or Authorization: Bearer).';
  } else {
    code = 'invalid_credential';
    status = 403;
    error = 'Invalid or expired credential';
    hint = 'Sign in again.';
  }
  res.status(status).json({ success: false, error, code, hint });
}

/** Middleware: the request must be the owner (open dev-local, or a valid credential). */
export const requireApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const apiKey = presentedKey(req);

  if (isOpenAuthRequest(req)) {
    // NOTHING is validated here: in development a local request IS the owner.
    // A presented key is kept only as the caller's identity (the side-loaded
    // extension presents the service credential, and the Inspector files its
    // bindings under it); with none, the owner is the service identity.
    req.apiKey = apiKey || authStore.serviceToken();
    req.apiKeyPrefix = 'local';
    req.apiKeyUserId = SINGLE_USER_ID;
    next();
    return;
  }
  if (!apiKey || !isAcceptedCredential(apiKey)) {
    if (apiKey) {
      const masked = apiKey.length > 8 ? apiKey.substring(0, 8) + '...' : '***';
      console.warn(`[AUTH] ❌ Invalid credential: ${masked} from ${req.ip}`);
    }
    refuse(req, res, apiKey);
    return;
  }
  req.apiKey = apiKey;
  req.apiKeyPrefix = apiKey.substring(0, Math.min(15, apiKey.length));
  req.apiKeyUserId = SINGLE_USER_ID;
  next();
};
