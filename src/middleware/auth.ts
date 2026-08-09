import type { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { randomInt } from 'crypto';
import { config } from '../config';

export interface AuthenticatedRequest extends Request {
  apiKey?: string;
  apiKeyPrefix?: string;
  apiKeyUserId?: string;
}

// Redis keys
const API_KEYS_HASH = 'api_keys:active';
const API_KEYS_META = 'api_keys:metadata';
const API_KEY_REVOKED_CHANNEL = 'api_key:revoked';

// [H — Step 18] Fixed identity for single-user self-hosted mode.
export const SINGLE_USER_ID = 'local';

// Interface for metadata
export interface ApiKeyMetadata {
  userId: string;
  note: string;
  createdAt: string;
  expiresAt: string | null;
}

// Validation result interface (NEW)
export interface ApiKeyValidationResult {
  valid: boolean;
  userId?: string;
  isEnvKey?: boolean;
}

/**
 * API Key Manager - Redis-based with caching, pub/sub, and strict user binding
 */
export class ApiKeyManager {
  private redis: Redis;
  private subscriber: Redis | null = null;
  private localCache = new Map<string, { userId: string; valid: boolean; cachedAt: number }>();
  private cacheLifetimeMs = 60000; // 1 minute

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Initialize: Load .env keys and setup pub/sub
   */
  async initialize(): Promise<void> {
    // Load keys from .env into Redis (one-time migration)
    // Changed: env_imported -> env_root for admin access
    for (const key of config.API_KEYS) {
      const exists = await this.redis.hexists(API_KEYS_HASH, key);
      if (!exists) {
        await this.addKey(key, 'env_root', 'Imported from .env (Admin Key)');
        console.log(`[AUTH] Migrated key from .env: ${key.substring(0, 15)}...`);
      }
    }

    // Setup pub/sub for multi-instance cache invalidation
    await this.setupPubSub();

    const totalKeys = await this.redis.hlen(API_KEYS_HASH);
    console.log(`[AUTH] API Key Manager initialized with ${totalKeys} key(s)`);
  }

  /**
   * Setup pub/sub for cache invalidation across instances
   */
  private async setupPubSub(): Promise<void> {
    try {
      // Create a duplicate connection for subscribing
      this.subscriber = this.redis.duplicate();

      await this.subscriber.subscribe(API_KEY_REVOKED_CHANNEL);

      this.subscriber.on('message', (channel, message) => {
        if (channel === API_KEY_REVOKED_CHANNEL) {
          this.localCache.delete(message);
          console.log(`[AUTH] Cache invalidated for key: ${message.substring(0, 15)}...`);
        }
      });

      console.log('[AUTH] Pub/Sub setup complete for cache invalidation');
    } catch (e) {
      console.warn('[AUTH] Pub/Sub setup failed, running in single-instance mode:', e);
    }
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(API_KEY_REVOKED_CHANNEL);
        await this.subscriber.quit();
      } catch (e) {
        console.error('[AUTH] Error during shutdown:', e);
      }
    }
  }

  /**
   * Validate API key AND return owner userId (NEW - for Strict Binding)
   */
  async validateAndGetOwner(apiKey: string): Promise<ApiKeyValidationResult> {
    const now = Date.now();

    // 1. Check local cache first
    const cached = this.localCache.get(apiKey);
    if (cached && (now - cached.cachedAt) < this.cacheLifetimeMs) {
      return {
        valid: cached.valid,
        userId: cached.userId,
        isEnvKey: cached.userId === 'env_root'
      };
    }

    // 2. Check .env keys (Admin keys - no specific user binding)
    if (config.API_KEYS.has(apiKey)) {
      this.localCache.set(apiKey, { userId: 'env_root', valid: true, cachedAt: now });
      return { valid: true, userId: 'env_root', isEnvKey: true };
    }

    // 3. Check Redis
    const exists = await this.redis.hexists(API_KEYS_HASH, apiKey);

    if (!exists) {
      this.localCache.set(apiKey, { userId: '', valid: false, cachedAt: now });
      return { valid: false };
    }

    // 4. Get Metadata to find owner
    const meta = await this.getKeyInfo(apiKey);

    // 5. Check expiration
    if (meta?.expiresAt) {
      const expiresAt = new Date(meta.expiresAt).getTime();
      if (now > expiresAt) {
        await this.revokeKey(apiKey);
        return { valid: false };
      }
    }

    const ownerId = meta?.userId || '';

    // 6. Cache the result WITH userId
    this.localCache.set(apiKey, { userId: ownerId, valid: true, cachedAt: now });

    return { 
      valid: true, 
      userId: ownerId, 
      isEnvKey: ownerId === 'env_root' 
    };
  }

  /**
   * Simple validation (backwards compatibility - kept from original)
   */
  async isValid(apiKey: string): Promise<boolean> {
    const result = await this.validateAndGetOwner(apiKey);
    return result.valid;
  }

  /**
   * Get key metadata with type safety
   */
  async getKeyInfo(apiKey: string): Promise<ApiKeyMetadata | null> {
    const meta = await this.redis.hget(API_KEYS_META, apiKey);
    if (!meta) return null;

    try {
      return JSON.parse(meta) as ApiKeyMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Add new API key with strict user binding
   */
  async addKey(
    apiKey: string,
    userId: string,
    note?: string,
    expiresInDays?: number
  ): Promise<void> {
    const metadata: ApiKeyMetadata = {
      userId, // This is the STRICT BINDING
      note: note || '',
      createdAt: new Date().toISOString(),
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
        : null
    };

    await this.redis.hset(API_KEYS_HASH, apiKey, '1');
    await this.redis.hset(API_KEYS_META, apiKey, JSON.stringify(metadata));

    // Clear local cache
    this.localCache.delete(apiKey);
  }

  /**
   * Revoke API key with pub/sub notification
   */
  async revokeKey(apiKey: string): Promise<boolean> {
    const deleted = await this.redis.hdel(API_KEYS_HASH, apiKey);
    await this.redis.hdel(API_KEYS_META, apiKey);

    // Clear local cache
    this.localCache.delete(apiKey);

    // Notify other instances via pub/sub
    await this.redis.publish(API_KEY_REVOKED_CHANNEL, apiKey).catch(() => {});

    return deleted > 0;
  }

  /**
   * List all keys (metadata only)
   */
  async listKeys(): Promise<Array<{ prefix: string; meta: ApiKeyMetadata | null }>> {
    const allKeys = await this.redis.hkeys(API_KEYS_HASH);
    const result: Array<{ prefix: string; meta: ApiKeyMetadata | null }> = [];

    for (const key of allKeys) {
      const meta = await this.getKeyInfo(key);
      result.push({
        prefix: key.substring(0, 15) + '...',
        meta
      });
    }

    return result;
  }

  /**
   * Get total key count
   */
  async getKeyCount(): Promise<number> {
    const redisCount = await this.redis.hlen(API_KEYS_HASH);
    return redisCount + config.API_KEYS.size;
  }

  /**
   * Clear local cache (for testing or manual refresh)
   */
  clearCache(): void {
    this.localCache.clear();
  }
}

// Global instance
let apiKeyManager: ApiKeyManager | null = null;

export const initApiKeyManager = (redis: Redis): ApiKeyManager => {
  apiKeyManager = new ApiKeyManager(redis);
  return apiKeyManager;
};

export const getApiKeyManager = (): ApiKeyManager | null => apiKeyManager;

/**
 * Generate a new API key (Secure Version using crypto)
 */
export const generateApiKey = (type: 'live' | 'test' = 'live'): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let random = '';

  for (let i = 0; i < 32; i++) {
    const randomIndex = randomInt(chars.length);
    random += chars.charAt(randomIndex);
  }

  return `sk_${type}_${random}`;
};

/**
 * Extract userId from request (body, params, or query)
 */
const extractRequestUserId = (req: Request): string | undefined => {
  return req.body?.userId || req.params?.userId || (req.query?.userId as string);
};

/**
 * Middleware: Require valid API key with STRICT USER BINDING
 */
export const requireApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // Skip if auth disabled
  if (!config.API_KEYS_ENABLED) {
    return next();
  }

  // Extract API key
  let apiKey: string | undefined;

  // 1. Header: x-api-key
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) {
    apiKey = headerKey;
  }

  // 2. Query: ?api_key=xxx OR ?token=xxx (downloads/links)
  if (!apiKey && req.query.api_key) {
    apiKey = String(req.query.api_key);
  }
  if (!apiKey && req.query.token) {
    apiKey = String(req.query.token);
  }

  // 3. Authorization: Bearer xxx
  if (!apiKey) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7).trim();
    }
  }

  // ============================================
  // [H — Step 18] SINGLE-USER MODE: one shared API_TOKEN authenticates the
  // whole instance and resolves to a fixed identity. No Redis key lookup, no
  // multi-user strict binding.
  // ============================================
  if (config.IS_SINGLE_USER) {
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        hint: 'Provide the API_TOKEN via x-api-key header, api_key query param, or Bearer token'
      });
      return;
    }
    if (!config.API_TOKEN || apiKey !== config.API_TOKEN) {
      const masked = apiKey.length > 8 ? apiKey.substring(0, 8) + '...' : '***';
      console.warn(`[AUTH] ❌ Invalid API_TOKEN: ${masked} from ${req.ip}`);
      res.status(403).json({ success: false, error: 'Invalid API token' });
      return;
    }
    req.apiKey = apiKey;
    req.apiKeyPrefix = apiKey.substring(0, Math.min(15, apiKey.length));
    // استفاده از user از config API_TOKEN_USER_ID یا SINGLE_USER_ID به عنوان پیش‌فرض
    req.apiKeyUserId = (typeof process !== 'undefined' && process.env && process.env.API_TOKEN_USER_ID) || SINGLE_USER_ID;
    next();
    return;
  }

  // No key provided
  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      hint: 'Provide API key via x-api-key header, api_key query param, or Bearer token'
    });
    return;
  }

  // Validate key and get owner
  let validationResult: ApiKeyValidationResult = { valid: false };

  if (config.API_KEYS.has(apiKey)) {
    // Environment keys are admin keys
    validationResult = { valid: true, userId: 'env_root', isEnvKey: true };
  } else if (apiKeyManager) {
    validationResult = await apiKeyManager.validateAndGetOwner(apiKey);
  }

  // Invalid key
  if (!validationResult.valid) {
    const maskedKey = apiKey.length > 8 ? apiKey.substring(0, 8) + '...' : '***';
    console.warn(`[AUTH] ❌ Invalid API key: ${maskedKey} from ${req.ip}`);

    res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
    return;
  }

  // ============================================
  // ✅ NEW: STRICT USER BINDING CHECK
  // ============================================

  const requestUserId = extractRequestUserId(req);
  const keyOwnerId = validationResult.userId;
  const isEnvKey = validationResult.isEnvKey;

  // If NOT an env/admin key AND userId is provided in request
  if (!isEnvKey && requestUserId && keyOwnerId) {
    if (String(requestUserId) !== String(keyOwnerId)) {
      const maskedKey = apiKey.length > 8 ? apiKey.substring(0, 8) + '...' : '***';

      console.warn(
        `[AUTH] 🚨 SECURITY ALERT: Key owner "${keyOwnerId}" attempted to act as "${requestUserId}" | ` +
        `Key: ${maskedKey} | IP: ${req.ip} | Path: ${req.path}`
      );

      res.status(403).json({
        success: false,
        error: 'Access Denied',
        message: 'This API key is not authorized for the specified User ID.',
        hint: 'Each API key is strictly bound to its owner. You cannot use it for other users.'
      });
      return;
    }
  }

  // ============================================
  // Attach to request (same as before + userId)
  // ============================================

  req.apiKey = apiKey;
  req.apiKeyPrefix = apiKey.substring(0, Math.min(15, apiKey.length));
  req.apiKeyUserId = keyOwnerId; // NEW: for downstream use

  next();
};

/**
 * Middleware: Require Admin API key (env_root only) - NEW
 */
export const requireAdminApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // First run normal auth
  await requireApiKey(req, res, () => {
    // Then check if it's an admin key
    if (req.apiKeyUserId !== 'env_root') {
      res.status(403).json({
        success: false,
        error: 'Admin access required',
        message: 'This endpoint requires an admin API key defined in .env'
      });
      return;
    }
    next();
  });
};