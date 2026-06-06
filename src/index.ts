'use strict';

import express from 'express';
import helmet from 'helmet';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import fsExtra from 'fs-extra';
import path from 'path';
import fs from 'fs/promises';
import { glob } from 'glob';

import { config } from './config';
import { runPipeline } from './pipeline';
import { buildItemsFromTrigger, buildManualItems } from './core/TriggerEngine';
import { ProfileManager } from './core/ProfileManager';
import { UserManager } from './core/UserManager';
import { QuotaManager } from './core/QuotaManager';
import { GlobalBrowser } from './core/GlobalBrowser';
import { smartLimiter, adminLimiter } from './rate-limit';
import { sanitizeLogMessage } from './validation';
import {
  requireApiKey,
  initApiKeyManager,
  getApiKeyManager,
  AuthenticatedRequest
} from './middleware/auth';
import { asyncBlockCheck } from './middleware/block-check';

// Utils & Services
import { isVipUser } from './utils/helpers';
import { STATS_KEY, getUserActiveJobsKey, getLiveChannel } from './utils/redis-keys';
import { sendWebhook, sendStepWebhook } from './services/webhook.service';
import { persistJob } from './services/job.service';

// Step 16: Live Channel (WebSocket + SSE) live job events.
import { LiveBus, JobLivePublisher } from './core/LiveBus';
import { LiveServer, authorizeLive } from './core/LiveServer';
import { buildStepWebhookPayload, buildShareToken, shouldDeliverStepEvent } from './core/StepReporter';
import { LiveBrowserManager } from './core/LiveBrowser';
import { BrowserStreamServer } from './core/BrowserStreamServer';

// Routes
import { createAllRoutes } from './Routes';

// ============================================
// EXPRESS SETUP
// ============================================

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],  // Step 16: live channel (WebSocket) + same-origin SSE
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: config.MAX_REQUEST_BODY_SIZE }));

// ============================================
// CORS (F5) - explicit, configurable cross-origin control
// ============================================
// UI (same-origin), n8n and the browser extension may live on a different
// origin. We echo back an allowed origin and short-circuit pre-flight.
const corsAllowed = new Set(config.CORS_ALLOWED_ORIGINS);
const corsAllowAny = corsAllowed.has('*');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (corsAllowAny || corsAllowed.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', corsAllowAny ? '*' : origin);
    if (!corsAllowAny) {
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, x-api-key, x-admin-token, Idempotency-Key'
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ============================================
// REDIS & QUEUE
// ============================================

const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  retryStrategy: (times) => {
    if (times > 10) {
      console.error('[REDIS] Max retries reached, giving up');
      return null;
    }
    return Math.min(times * 200, 5000);
  }
});

connection.on('connect', () => console.log('[REDIS] Connected'));
connection.on('error', (err) => console.error('[REDIS] Error:', err.message));

const queue = new Queue('automation-jobs', { connection });
const profileManager = new ProfileManager();
const quotaManager = new QuotaManager(connection);
const apiKeyManager = initApiKeyManager(connection);

// Step 16: live event bus (publishes to Redis Pub/Sub + replay buffer).
const liveBus = new LiveBus(connection);
// LiveServer (WebSocket fan-out) is created lazily in startServer once the
// HTTP server exists, so it can attach to the 'upgrade' event.
let liveServer: LiveServer | null = null;
// Step 12: interactive Live Browser View (CDP screencast + input + element picker).
const liveBrowserManager = new LiveBrowserManager(config.MAX_CONCURRENT > 0 ? Math.min(config.MAX_CONCURRENT, 8) : 8);
let browserStreamServer: BrowserStreamServer | null = null;

// ============================================
// LUA SCRIPTS
// ============================================

let checkOlderJobsScriptSha: string | null = null;

const LUA_CHECK_OLDER_JOBS = `
local key = KEYS[1]
local currentId = tonumber(ARGV[1])
if not currentId then return 0 end
local members = redis.call('SMEMBERS', key)
for i, id in ipairs(members) do
  local idNum = tonumber(id)
  if idNum and idNum < currentId then return 1 end
end
return 0
`;

const initLuaScripts = async (): Promise<void> => {
  try {
    checkOlderJobsScriptSha = await connection.script('LOAD', LUA_CHECK_OLDER_JOBS) as string;
    console.log('[REDIS] ✓ Lua scripts loaded');
  } catch (e) {
    console.warn('[REDIS] ⚠️ Failed to load Lua scripts, using fallback');
    checkOlderJobsScriptSha = null;
  }
};

const luaScriptsLoaded = (): boolean => checkOlderJobsScriptSha !== null;

const hasOlderJobs = async (userId: string, currentJobId: string): Promise<boolean> => {
  const key = getUserActiveJobsKey(userId);
  const currentIdNum = parseInt(currentJobId);

  if (isNaN(currentIdNum)) return false;

  if (checkOlderJobsScriptSha) {
    try {
      const result = await connection.evalsha(checkOlderJobsScriptSha, 1, key, currentJobId);
      return result === 1;
    } catch (e: unknown) {
      const error = e as Error;
      if (error.message?.includes('NOSCRIPT')) {
        await initLuaScripts();
      }
    }
  }

  // Fallback
  const activeIds = await connection.smembers(key);
  return activeIds.some(id => {
    const idNum = parseInt(id);
    return !isNaN(idNum) && idNum < currentIdNum;
  });
};

// ============================================
// CLEANUP
// ============================================

const cleanupSystem = async (): Promise<void> => {
  console.log('[SYSTEM] Cleaning up stale locks...');
  try {
    const locks = await glob(path.join(config.PROFILES_DIR, '**/SingletonLock'));
    for (const lock of locks) {
      await fs.unlink(lock).catch(() => {});
    }
    if (locks.length > 0) {
      console.log(`[SYSTEM] Cleaned ${locks.length} stale lock(s)`);
    }
  } catch (e) {
    console.error('[SYSTEM] Cleanup error:', e);
  }
};

// ============================================
// MIDDLEWARES
// ============================================

const asyncAuthMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  requireApiKey(req as AuthenticatedRequest, res, next).catch(next);
};

// Rate limiting
app.use('/run', smartLimiter);
app.use('/cancel', smartLimiter);
app.use('/admin', adminLimiter);

// API Key authentication
app.use('/run', asyncAuthMiddleware);
app.use('/cancel', asyncAuthMiddleware);
app.use('/job', asyncAuthMiddleware);
app.use('/jobs', asyncAuthMiddleware);
app.use('/quota', asyncAuthMiddleware);
app.use('/me', asyncAuthMiddleware);
app.use('/workflows', asyncAuthMiddleware);

// Block check
const blockCheck = asyncBlockCheck(connection);
app.use('/run', blockCheck);
app.use('/cancel', blockCheck);
app.use('/job', blockCheck);
app.use('/jobs', blockCheck);
app.use('/quota', blockCheck);
app.use('/me', blockCheck);
app.use('/workflows', blockCheck);

// ============================================
// INITIALIZATION
// ============================================

fsExtra.ensureDirSync(config.PROFILES_DIR);
fsExtra.ensureDirSync(config.LOGS_DIR);

// ============================================
// STATIC UI (public/) - served at site root
// ============================================
// 'public' lives at the project root (outside src/), so resolve from cwd.
// Works for both `tsx watch src/index.ts` (dev) and `node dist/index.js` (prod),
// since both are launched from the project root.
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  extensions: ['html'],
  maxAge: config.NODE_ENV === 'production' ? '1h' : 0,
}));

// ============================================
// ROUTES
// ============================================

const routes = createAllRoutes({
  queue,
  connection,
  profileManager,
  quotaManager,
  luaScriptsLoaded,
  reloadLuaScripts: initLuaScripts
});

app.use('/', routes.health);
app.use('/', routes.user);
app.use('/admin', routes.admin);

// ============================================
// LIVE CHANNEL - SSE fallback (Step 16)
// ============================================
// GET /live/sse/:userId/:jobId?api_key=...  -> text/event-stream
// Replays the recent buffer, then streams new events via Redis Pub/Sub.
// WebSocket (/live/ws) is preferred; this is the fallback for environments
// where WS is blocked (e.g. some corporate proxies).
// ============================================
// LIVE SHARE LINK (Step 29)
// ============================================
// POST /live/share/:userId/:jobId  -> mint a signed share token + URL.
// Requires normal API-key auth (only the owner can create a share link).
// The returned link embeds the token in the query string so it can be
// opened by anyone without exposing the API key.
app.post('/live/share/:userId/:jobId', async (req, res) => {
  const userId = String(req.params.userId);
  const jobId = String(req.params.jobId);
  const apiKey = (req.headers['x-api-key'] as string | undefined)
    || (req.body && req.body.api_key ? String(req.body.api_key) : undefined);
  const auth = await authorizeLive(apiKey, userId);
  if (!auth.ok) {
    res.status(auth.reason === 'missing_api_key' ? 401 : 403).json({
      success: false, error: 'Share denied', reason: auth.reason
    });
    return;
  }
  if (!config.LIVE_SHARE_SECRET) {
    res.status(503).json({ success: false, error: 'Share secret not configured' });
    return;
  }
  let ttl = config.LIVE_SHARE_TTL_SEC;
  const reqTtl = req.body && req.body.ttlSec;
  if (typeof reqTtl === 'number' && Number.isFinite(reqTtl)) ttl = Math.floor(reqTtl);
  const token = buildShareToken(userId, jobId, config.LIVE_SHARE_SECRET, ttl);
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/live/view/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}?share=${encodeURIComponent(token)}`;
  res.json({ success: true, token, url, expiresInSec: ttl });
});

// GET /live/view/:userId/:jobId  -> serve the shareable read-only live page.
// Auth happens client-side via the share token (or api_key) against the
// SSE/WS endpoints; this route only serves the static HTML shell.
app.get('/live/view/:userId/:jobId', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'live-view.html'));
});

app.get('/live/sse/:userId/:jobId', async (req, res) => {
  const userId = String(req.params.userId);
  const jobId = String(req.params.jobId);
  const apiKey = (req.headers['x-api-key'] as string | undefined)
    || (req.query.api_key ? String(req.query.api_key) : undefined);
  // Step 29: optional shareable-link token (read-only access).
  const share = req.query.share ? String(req.query.share) : undefined;

  const auth = await authorizeLive(apiKey, userId, { share, jobId });
  if (!auth.ok) {
    res.status(auth.reason === 'missing_api_key' ? 401 : 403).json({
      success: false,
      error: 'Live access denied',
      reason: auth.reason
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');

  const channel = getLiveChannel(userId, jobId);
  // Dedicated subscriber connection for this SSE client.
  const sub = connection.duplicate();

  const sendEvent = (payload: string) => {
    try { res.write(`data: ${payload}\n\n`); } catch { /* client gone */ }
  };

  // Replay recent buffer first.
  try {
    const buffer = await liveBus.getBuffer(userId, jobId);
    for (const ev of buffer) sendEvent(JSON.stringify(ev));
  } catch { /* best-effort */ }

  sub.on('message', (_chan: string, message: string) => sendEvent(message));
  sub.subscribe(channel).catch(() => { /* best-effort */ });

  // Heartbeat comment every 25s to keep proxies from closing the stream.
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);

  const cleanup = () => {
    clearInterval(hb);
    sub.unsubscribe(channel).catch(() => {});
    sub.quit().catch(() => {});
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// ============================================
// WORKER
// ============================================

const worker = new Worker('automation-jobs', async (job: Job) => {
  const userId = String(job.data.userId);
  const webhookUrl = job.data.webhookUrl;

  // Immediate cancel check
  if (job.data.__cancelledByUser || profileManager.isCancelledLocally(job.id!)) {
    console.log(`[JOB:${job.id}] ⚡ Already cancelled - skipping`);
    await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
    return;
  }

  const userPlan = await UserManager.getUserPlan(connection, userId);
  const userSettings = await UserManager.getUserSettings(connection, userId);
  const isVip = isVipUser(userPlan.priority, config.VIP_PRIORITY_THRESHOLD);

  // Block check
  if (userSettings.blockAccess) {
    console.log(`[JOB:${job.id}] ⛔ User ${userId} blocked - job rejected`);
    await connection.srem(getUserActiveJobsKey(userId), job.id!);
    await persistJob(userId, job.id!, [], {
      success: false,
      message: 'Account blocked by administrator',
      blocked: true
    });

    if (webhookUrl) {
      sendWebhook(webhookUrl, {
        event: 'job.blocked',
        jobId: job.id!,
        userId,
        success: false,
        message: 'Account blocked by administrator',
        timestamp: new Date().toISOString()
      });
    }
    return;
  }

  // [C1] Ensure the job is tracked in the active set. Idempotent: /run already adds
  // immediate jobs, but SCHEDULED (repeatable) jobs are enqueued by BullMQ and never
  // pass through /run, so this is their only registration point. The finally{} block
  // below is the single removal point for both paths.
  await connection.sadd(getUserActiveJobsKey(userId), job.id!);
  await connection.expire(getUserActiveJobsKey(userId), 90 * 60);

  const shouldLock = isVip || config.FREE_FORCE_SEQUENTIAL || userSettings.forceSequential;
  // [C5] Hold the lock token returned by tryLockUser so we can release it conditionally.
  let lockToken: string | null = null;

  if (shouldLock) {
    lockToken = await profileManager.tryLockUser(connection, userId);
    if (!lockToken) {
      await job.moveToDelayed(Date.now() + config.QUEUE_DELAY_MS);
      return;
    }

    if (await hasOlderJobs(userId, job.id!)) {
      console.log(`[ORDER] Waiting for older jobs -> User ${userId}`);
      await profileManager.unlockUser(connection, userId, lockToken);
      await job.moveToDelayed(Date.now() + 1000);
      return;
    }
  }

  profileManager.initJobOutputs(job.id!);

  // Step 16: per-job live publisher (best-effort fan-out to subscribers).
  const livePub = new JobLivePublisher(liveBus, userId, job.id!);

  const log = (msg: string) => {
    const safe = sanitizeLogMessage(msg);
    console.log(`[JOB:${job.id}] ${safe}`);
    livePub.emit('log', { message: safe });
  };

  try {
    livePub.emit('job.start', { isVip, lock: shouldLock });
    log(`Started (${isVip ? 'VIP' : 'Free'}) [Lock: ${shouldLock}]`);

    connection.incr(STATS_KEY.TOTAL_JOBS).catch(() => {});

    const steps = job.data.steps;
    if (Array.isArray(steps)) {
      connection.incrby(STATS_KEY.TOTAL_STEPS, steps.length).catch(() => {});

      const pipeline = connection.pipeline();
      steps.forEach((s: { action?: string }) => {
        if (s.action) {
          pipeline.zincrby(STATS_KEY.MODULE_USAGE_ZSET, 1, s.action);
        }
      });
      pipeline.exec().catch(() => {});
    }

    // Step 28: a trigger may carry data to seed the first node's input
    // stream. `triggerData` shape: { source, body?, headers?, query?, method?, data? }.
    let initialItems;
    const td = job.data.triggerData;
    if (td && typeof td === 'object') {
      if (td.source === 'webhook' || td.headers || td.query || (td.body !== undefined)) {
        initialItems = buildItemsFromTrigger({
          body: td.body,
          headers: td.headers,
          query: td.query,
          method: td.method
        });
      } else if (td.data !== undefined) {
        initialItems = buildManualItems(td.data);
      }
    }

    const result = await runPipeline({
      userId,
      steps: job.data.steps,
      initialItems,
      headless: job.data.headless ?? config.DEFAULT_HEADLESS,
      log,
      jobId: job.id!,
      job,
      profileManager,
      isCancelled: async () => {
        if (profileManager.isCancelledLocally(job.id!)) return true;
        try {
          const f = await queue.getJob(job.id!);
          return !!f?.data?.__cancelledByUser;
        } catch {
          return false;
        }
      },
      userPlan,
      quotaManager,
      // Step 16: forward step-level live events from the pipeline.
      // Step 29: ALSO deliver per-step events to the job webhook URL
      // (channel 1 of two-channel live reporting) when enabled.
      onEvent: (type: string, data?: Record<string, unknown>) => {
        livePub.emit(type as Parameters<typeof livePub.emit>[0], data);
        if (webhookUrl && config.STEP_WEBHOOK_ENABLED && shouldDeliverStepEvent(type)) {
          const stepPayload = buildStepWebhookPayload({ type, jobId: job.id!, userId, data });
          if (stepPayload) {
            // fire-and-forget; sendStepWebhook never throws into the pipeline.
            void sendStepWebhook(webhookUrl, stepPayload);
          }
        }
      }
    });

    livePub.emit('job.done', { durationMs: result.durationMs });
    log('Completed');
    connection.incr(STATS_KEY.TOTAL_SUCCESS).catch(() => {});

    const outputs = profileManager.getJobOutputs(job.id!);
    await persistJob(userId, job.id!, outputs, { ...result, success: true });

    if (webhookUrl) {
      sendWebhook(webhookUrl, {
        event: 'job.completed',
        jobId: job.id!,
        userId,
        success: true,
        durationMs: result.durationMs,
        stepsCount: outputs.length,
        timestamp: new Date().toISOString()
      });
    }

  } catch (err: unknown) {
    const error = err as Error;
    connection.incr(STATS_KEY.TOTAL_FAILED).catch(() => {});

    const outputs = profileManager.getJobOutputs(job.id!);

    let cancelled = profileManager.isCancelledLocally(job.id!);
    if (!cancelled) {
      try {
        const f = await queue.getJob(job.id!);
        cancelled = !!f?.data?.__cancelledByUser;
      } catch {}
    }

    if (cancelled || error.message === 'CANCELLED_BY_USER' || error.message === 'QUOTA_EXHAUSTED') {
      livePub.emit('job.error', { reason: error.message === 'QUOTA_EXHAUSTED' ? 'quota_exhausted' : 'cancelled', message: error.message });
      log(error.message === 'QUOTA_EXHAUSTED' ? 'Quota Exhausted' : 'Cancelled');

      await persistJob(userId, job.id!, outputs, {
        success: false,
        message: error.message,
        cancelledByUser: cancelled,
        userCancelled: cancelled
      });

      if (webhookUrl) {
        sendWebhook(webhookUrl, {
          event: cancelled ? 'job.cancelled' : 'job.quota_exhausted',
          jobId: job.id!,
          userId,
          success: false,
          message: error.message,
          stepsCompleted: outputs.length,
          timestamp: new Date().toISOString()
        });
      }
      return;
    }

    // Browser crash handling
    if (error.message.includes('Session closed') || error.message.includes('Protocol error')) {
      log('Browser crashed - cleaning up');

      if (isVip) {
        const entry = profileManager.getVipContext(userId);
        if (entry) {
          await entry.context.close().catch(() => {});
        }
        profileManager.removeVipContext(userId);
      } else {
        const entry = profileManager.getFreeContext(job.id!);
        if (entry) {
          await entry.context.close().catch(() => {});
        }
        profileManager.removeFreeContext(job.id!);
      }
    }

    livePub.emit('job.error', { message: sanitizeLogMessage(error.message) });
    log(`Failed: ${sanitizeLogMessage(error.message)}`);

    await persistJob(userId, job.id!, outputs, {
      success: false,
      message: error.message
    });

    if (webhookUrl) {
      sendWebhook(webhookUrl, {
        event: 'job.failed',
        jobId: job.id!,
        userId,
        success: false,
        error: error.message,
        stepsCompleted: outputs.length,
        timestamp: new Date().toISOString()
      });
    }

    throw err;

  } finally {
    if (shouldLock) {
      await profileManager.unlockUser(connection, userId, lockToken);
      if (isVip) {
        profileManager.updateActivity(userId);
      }
    }

    profileManager.clearJobOutputs(job.id!);
    profileManager.clearCancelFlag(job.id!);
    profileManager.unregisterPage(job.id!);
    await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
  }
}, {
  connection,
  concurrency: config.MAX_CONCURRENT,
  lockDuration: 300000,
  lockRenewTime: 60000,
  maxStalledCount: 0,
});

worker.on('failed', (job, err) => {
  if (job) {
    console.error(`[WORKER] Job ${job.id} failed:`, err.message);
  }
});

worker.on('error', (err) => {
  console.error('[WORKER] Error:', err.message);
});

// ============================================
// ERROR HANDLERS
// ============================================

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({
    success: false,
    error: config.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
  });
});

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// ============================================
// GARBAGE COLLECTOR
// ============================================

setInterval(async () => {
  try {
    await profileManager.runGarbageCollector(config.GC_STALE_THRESHOLD_MINUTES);
  } catch (e) {
    console.error('[GC] Error:', e);
  }
}, config.GC_CHECK_INTERVAL_MINUTES * 60 * 1000);

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[SHUTDOWN] ${signal} received, starting graceful shutdown...`);

  try {
    if (liveServer) {
      console.log('[SHUTDOWN] Closing live server...');
      await liveServer.shutdown();
    }

    console.log('[SHUTDOWN] Closing worker...');
    await worker.close();

    console.log('[SHUTDOWN] Closing queue...');
    await queue.close();

    console.log('[SHUTDOWN] Closing API Key Manager...');
    const manager = getApiKeyManager();
    if (manager) {
      await manager.shutdown();
    }

    console.log('[SHUTDOWN] Closing Live Browser sessions...');
    if (browserStreamServer) await browserStreamServer.shutdown();
    if (liveServer) await liveServer.shutdown();

    console.log('[SHUTDOWN] Closing Global Browser...');
    await GlobalBrowser.shutdown();

    console.log('[SHUTDOWN] Closing Redis connection...');
    await connection.quit();

    console.log('[SHUTDOWN] Closing all browsers...');
    await profileManager.shutdownAll();

    console.log('[SHUTDOWN] Graceful shutdown completed');
    process.exit(0);

  } catch (e) {
    console.error('[SHUTDOWN] Error during shutdown:', e);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  // [C3] Harmonized with uncaughtException: an unhandled rejection leaves the
  // process in an undefined state, so we shut down gracefully and let the
  // supervisor (PM2 / Docker restart policy) bring a clean instance back up.
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// ============================================
// START SERVER
// ============================================

const startServer = async () => {
  await cleanupSystem();
  await apiKeyManager.initialize();
  await quotaManager.initialize();
  await GlobalBrowser.initialize();
  await initLuaScripts();

  const server = app.listen(config.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log(`║     🚀 AUTOMATION BACKEND v${config.VERSION} - MODULAR EDITION             ║`);
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log(`║  Port:              ${String(config.PORT).padEnd(47)}║`);
    console.log(`║  Environment:       ${config.NODE_ENV.padEnd(47)}║`);
    console.log(`║  Concurrency:       ${String(config.MAX_CONCURRENT).padEnd(47)}║`);
    console.log(`║  API Auth:          ${(config.API_KEYS_ENABLED ? '✓ Enabled' : '✗ Disabled').padEnd(47)}║`);
    console.log(`║  Turbo Mode:        ${(config.TURBO_MODE ? '✓ Enabled' : '✗ Disabled').padEnd(47)}║`);
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log('║  📁 Modular Structure:                                          ║');
    console.log('║    routes/         - API endpoints                              ║');
    console.log('║    services/       - Business logic                             ║');
    console.log('║    middleware/     - Auth & validation                          ║');
    console.log('║    utils/          - Helpers                                    ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log('');
  });

  server.on('error', (err) => {
    console.error('[SERVER] Error:', err);
    process.exit(1);
  });

  // Step 16: attach the WebSocket live server to this HTTP server.
  liveServer = new LiveServer(liveBus, connection);
  liveServer.attach(server);
  console.log('[LIVE] WebSocket live channel ready at /live/ws (SSE fallback at /live/sse/:userId/:jobId)');

  // Step 12: interactive browser stream (separate upgrade path /browser/ws).
  browserStreamServer = new BrowserStreamServer(liveBrowserManager);
  browserStreamServer.attach(server);
  console.log('[LIVE] Interactive Live Browser View ready at /browser/ws');

  return server;
};

const server = startServer();

export { app, server, queue, connection, profileManager, quotaManager, liveBus };