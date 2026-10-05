import { sweepArtifacts } from './JobArtifacts';
import type { BrowserContext, Page } from 'playwright';
import type { Redis } from 'ioredis';
import type { StepOutput } from '../types';
import { config } from '../config';
import { glob } from 'glob';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { scanKeys } from '../utils/redis-keys';

// VIP: Stored by User ID (Persistent browser)
interface VipContextEntry {
  context: BrowserContext;
  lastActivity: number;
  jobId: string;
}

// FREE: Stored by Job ID (Ephemeral context from GlobalBrowser)
interface FreeContextEntry {
  context: BrowserContext;
  createdAt: number;
  userId: string;
}

// Interface for job output tracking
interface JobOutputEntry {
  outputs: StepOutput[];
  createdAt: number;
}

// Legacy interface for backward compatibility
export interface ActiveContextEntry {
  context: BrowserContext;
  lastActivity: number;
  jobId: string;
}

export class ProfileManager {
  // VIP Contexts (Key: userId) - Persistent browsers
  private vipContexts = new Map<string, VipContextEntry>();
  
  // Free Contexts (Key: jobId) - Ephemeral contexts
  private freeContexts = new Map<string, FreeContextEntry>();

  // ✅ NEW: Job -> Page mapping (با WeakRef برای جلوگیری از memory leak)
  private jobPages = new Map<string, WeakRef<Page>>();

  private jobStepOutputs = new Map<string, JobOutputEntry>();
  private cancelFlags = new Map<string, boolean>();

  // ============================================
  // VIP CONTEXT MANAGEMENT (Persistent)
  // ============================================

  getVipContext(userId: string): VipContextEntry | undefined {
    return this.vipContexts.get(userId);
  }

  setVipContext(userId: string, context: BrowserContext, jobId: string): void {
    this.vipContexts.set(userId, {
      context,
      lastActivity: Date.now(),
      jobId
    });
  }

  removeVipContext(userId: string): void {
    this.vipContexts.delete(userId);
  }

  // ============================================
  // FREE CONTEXT MANAGEMENT (Ephemeral)
  // ============================================

  setFreeContext(jobId: string, context: BrowserContext, userId: string): void {
    this.freeContexts.set(jobId, {
      context,
      createdAt: Date.now(),
      userId
    });
  }

  getFreeContext(jobId: string): FreeContextEntry | undefined {
    return this.freeContexts.get(jobId);
  }

  removeFreeContext(jobId: string): void {
    this.freeContexts.delete(jobId);
  }

  getFreeContextCount(): number {
    return this.freeContexts.size;
  }

  // ============================================
  // ✅ NEW: PAGE REGISTRY (Job -> Page Mapping)
  // ============================================

  /**
   * Register a page for a specific job
   * Uses WeakRef to prevent memory leaks if page is garbage collected
   */
  registerPage(jobId: string, page: Page): void {
    this.jobPages.set(jobId, new WeakRef(page));
  }

  /**
   * Get the page for a specific job
   * Returns undefined if page is closed or garbage collected
   */
  getPage(jobId: string): Page | undefined {
    const ref = this.jobPages.get(jobId);
    if (!ref) return undefined;

    const page = ref.deref();
    
    // اگر page garbage collect شده یا بسته شده، از Map حذف کن
    if (!page) {
      this.jobPages.delete(jobId);
      return undefined;
    }

    // چک کن که page هنوز باز باشه
    try {
      if (page.isClosed()) {
        this.jobPages.delete(jobId);
        return undefined;
      }
    } catch {
      // اگر خطا گرفت یعنی page دیگه valid نیست
      this.jobPages.delete(jobId);
      return undefined;
    }

    return page;
  }

  /**
   * Unregister a page when job completes or is cancelled
   */
  unregisterPage(jobId: string): void {
    this.jobPages.delete(jobId);
  }

  /**
   * Check if a page is registered and still valid
   */
  hasValidPage(jobId: string): boolean {
    return this.getPage(jobId) !== undefined;
  }

  /**
   * Get count of registered pages (for stats)
   */
  getRegisteredPageCount(): number {
    // Clean up stale entries while counting
    let validCount = 0;
    for (const [jobId, ref] of this.jobPages.entries()) {
      const page = ref.deref();
      if (page && !page.isClosed()) {
        validCount++;
      } else {
        this.jobPages.delete(jobId);
      }
    }
    return validCount;
  }

  // ============================================
  // LEGACY METHODS (Backward Compatibility)
  // ============================================

  /**
   * @deprecated Use getVipContext instead. Kept for backward compatibility.
   */
  getContext(userId: string): ActiveContextEntry | undefined {
    // First check VIP contexts
    const vip = this.vipContexts.get(userId);
    if (vip) {
      return {
        context: vip.context,
        lastActivity: vip.lastActivity,
        jobId: vip.jobId
      };
    }
    
    // For Free contexts, search by userId (less efficient)
    for (const [jobId, entry] of this.freeContexts.entries()) {
      if (entry.userId === userId) {
        return {
          context: entry.context,
          lastActivity: entry.createdAt,
          jobId
        };
      }
    }
    
    return undefined;
  }

  /**
   * @deprecated Use setVipContext instead. Kept for backward compatibility.
   */
  setContext(userId: string, context: BrowserContext, jobId: string): void {
    this.setVipContext(userId, context, jobId);
  }

  /**
   * @deprecated Use removeVipContext instead. Kept for backward compatibility.
   */
  removeContext(userId: string): void {
    this.removeVipContext(userId);
  }

  // ============================================
  // COMMON UTILS
  // ============================================

  updateActivity(userId: string): void {
    const entry = this.vipContexts.get(userId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
    // Free contexts don't update activity (they have TTL)
  }

  getActiveBrowserCount(): number {
    return this.vipContexts.size + this.freeContexts.size;
  }

  getVipBrowserCount(): number {
    return this.vipContexts.size;
  }

  // ============================================
  // USER LOCKING (Only for VIPs)
  // ============================================

  // [C5] Safe distributed lock. tryLockUser stores a unique token as the lock value;
  // unlockUser releases ONLY if the stored token still matches (compare-and-del via Lua),
  // so a job whose lock already expired can never delete another job's fresh lock.
  // Returns the token on success, or null if the lock is already held.
  async tryLockUser(redis: Redis, userId: string): Promise<string | null> {
    const key = `lock:user:${userId}`;
    const ttlSeconds = config.MAX_JOB_DURATION_MINUTES * 60;
    const token = randomUUID();
    const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? token : null;
  }

  // Conditional release: only deletes the key if its value equals our token.
  // If token is omitted (legacy/unknown), we DO NOT delete to avoid stealing a lock.
  async unlockUser(redis: Redis, userId: string, token?: string | null): Promise<void> {
    const key = `lock:user:${userId}`;
    if (!token) return; // never blindly DEL someone else's lock
    const lua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await redis.eval(lua, 1, key, token);
  }

  async isUserLocked(redis: Redis, userId: string): Promise<boolean> {
    return (await redis.exists(`lock:user:${userId}`)) === 1;
  }

  // [C6] Non-blocking count via SCAN (KEYS is O(N) and blocks the Redis event loop).
  async getLockedUserCount(redis: Redis): Promise<number> {
    return (await scanKeys(redis as any, 'lock:user:*')).length;
  }

  // ============================================
  // JOB OUTPUTS
  // ============================================

  initJobOutputs(jobId: string): void {
    this.jobStepOutputs.set(jobId, {
      outputs: [],
      createdAt: Date.now()
    });
  }

  getJobOutputs(jobId: string): StepOutput[] {
    const entry = this.jobStepOutputs.get(jobId);
    return entry ? entry.outputs : [];
  }

  addJobOutput(jobId: string, output: StepOutput): void {
    const entry = this.jobStepOutputs.get(jobId);
    if (entry) {
      entry.outputs.push(output);
    }
  }

  clearJobOutputs(jobId: string): void {
    this.jobStepOutputs.delete(jobId);
  }

  hasJobOutputs(jobId: string): boolean {
    return this.jobStepOutputs.has(jobId);
  }

  getJobOutputStats(): { count: number; oldestAgeMs: number } {
    let oldestAge = 0;
    const now = Date.now();

    for (const entry of this.jobStepOutputs.values()) {
      const age = now - entry.createdAt;
      if (age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      count: this.jobStepOutputs.size,
      oldestAgeMs: oldestAge
    };
  }

  // ============================================
  // CANCELLATION
  // ============================================

  setCancelFlag(jobId: string): void {
    this.cancelFlags.set(jobId, true);
  }

  isCancelledLocally(jobId: string): boolean {
    return this.cancelFlags.get(jobId) === true;
  }

  clearCancelFlag(jobId: string): void {
    this.cancelFlags.delete(jobId);
  }

  // ============================================
  // GARBAGE COLLECTOR (Updated for Hybrid)
  // ============================================

  async runGarbageCollector(staleThresholdMinutes: number): Promise<void> {
    const now = Date.now();
    const vipThresholdMs = staleThresholdMinutes * 60 * 1000;
    const freeMaxLifeMs = config.FREE_CONTEXT_MAX_LIFETIME_MS || 600000; // 10 min default

    let closedVip = 0;
    let closedFree = 0;
    let cleanedJobOutputs = 0;
    let cleanedCancelFlags = 0;
    let cleanedPages = 0;

    // 1. Clean VIP contexts (Activity based)
    for (const [userId, entry] of this.vipContexts.entries()) {
      let shouldClose = false;

      try {
        const pages = entry.context.pages();
        if (pages.length === 0) {
          shouldClose = true;
        }
      } catch {
        // Context is corrupted
        shouldClose = true;
      }

      if (!shouldClose && (now - entry.lastActivity > vipThresholdMs)) {
        shouldClose = true;
      }

      if (shouldClose) {
        console.log(`[GC] Closing stale VIP browser for user: ${userId}`);
        try {
          await entry.context.close();
        } catch {}
        this.vipContexts.delete(userId);
        closedVip++;
      }
    }

    // 2. Clean Free contexts (TTL based - strict)
    for (const [jobId, entry] of this.freeContexts.entries()) {
      if (now - entry.createdAt > freeMaxLifeMs) {
        console.log(`[GC] Closing expired Free context for job: ${jobId}`);
        try {
          await entry.context.close();
        } catch {}
        this.freeContexts.delete(jobId);
        this.unregisterPage(jobId); // ✅ همچنین page رو هم پاک کن
        closedFree++;
      }
    }

    // 3. Clean job outputs (Memory Leak Fix)
    const jobOutputMaxAge = config.JOB_OUTPUT_MAX_AGE_MS || 3600000;
    for (const [jobId, entry] of this.jobStepOutputs.entries()) {
      if (now - entry.createdAt > jobOutputMaxAge) {
        this.jobStepOutputs.delete(jobId);
        cleanedJobOutputs++;
      }
    }

    // 4. Clean cancel flags
    for (const jobId of this.cancelFlags.keys()) {
      if (!this.jobStepOutputs.has(jobId)) {
        this.cancelFlags.delete(jobId);
        cleanedCancelFlags++;
      }
    }

    // ✅ 5. Clean stale page references
    for (const [jobId, ref] of this.jobPages.entries()) {
      const page = ref.deref();
      if (!page || page.isClosed()) {
        this.jobPages.delete(jobId);
        cleanedPages++;
      }
    }

    // 6. Cleanup partial files
    await this.cleanupPartialFiles();
    await sweepArtifacts().catch((e) => console.error('[GC] Error sweeping artifacts:', e));

    // Log results
    if (closedVip > 0 || closedFree > 0 || cleanedJobOutputs > 0 || cleanedPages > 0) {
      console.log(
        `[GC] Cleanup: ${closedVip} VIP, ${closedFree} Free, ` +
        `${cleanedJobOutputs} outputs, ${cleanedCancelFlags} flags, ${cleanedPages} pages`
      );
    }
  }

  private async cleanupPartialFiles(): Promise<void> {
    try {
      const pattern = path.join(config.PROFILES_DIR, '**/*_partial.json');
      const partialFiles = await glob(pattern);

      const now = Date.now();
      const maxAgeMs = config.PARTIAL_FILE_MAX_AGE_HOURS * 60 * 60 * 1000;
      let deletedCount = 0;

      for (const file of partialFiles) {
        try {
          const stats = await fs.stat(file);
          const age = now - stats.mtimeMs;

          if (age > maxAgeMs) {
            await fs.unlink(file);
            deletedCount++;
          }
        } catch {}
      }

      if (deletedCount > 0) {
        console.log(`[GC] Cleaned up ${deletedCount} old partial file(s)`);
      }
    } catch (e) {
      console.error('[GC] Error cleaning partial files:', e);
    }
  }

  // ============================================
  // SHUTDOWN
  // ============================================

  async shutdownAll(): Promise<void> {
    console.log('[ProfileManager] Shutting down all browsers...');

    const closePromises: Promise<void>[] = [];

    // Close VIP contexts
    for (const [userId, entry] of this.vipContexts.entries()) {
      closePromises.push(
        entry.context.close().catch((e) => {
          console.error(`[ProfileManager] Error closing VIP browser for ${userId}:`, e);
        })
      );
    }

    // Close Free contexts
    for (const [jobId, entry] of this.freeContexts.entries()) {
      closePromises.push(
        entry.context.close().catch((e) => {
          console.error(`[ProfileManager] Error closing Free context for ${jobId}:`, e);
        })
      );
    }

    await Promise.allSettled(closePromises);

    this.vipContexts.clear();
    this.freeContexts.clear();
    this.jobPages.clear(); // ✅ پاک کردن page registry
    this.jobStepOutputs.clear();
    this.cancelFlags.clear();

    console.log('[ProfileManager] All browsers closed');
  }
}