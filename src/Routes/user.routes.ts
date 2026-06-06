import { Router } from 'express';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';

import { config } from '../config';
import type { ProfileManager } from '../core/ProfileManager';
import { UserManager } from '../core/UserManager';
import type { QuotaManager } from '../core/QuotaManager';
import {
  sanitizeUserId,
  validateSteps,
  validateWebhookUrl,
  validateHeadless
} from '../validation';
import { runBodySchema, scheduleBodySchema, workflowBodySchema, parseBody } from '../schemas';
import { isVipUser } from '../utils/helpers';
import { getUserActiveJobsKey, getIdempotencyKey, isValidIdempotencyKey, isValidWorkflowId } from '../utils/redis-keys';
import { readJobFile, readPartialJobFile } from '../services/job.service';
import { WorkflowService } from '../services/workflow.service';
import type { AuthenticatedRequest } from '../middleware/auth';

interface UserRoutesDeps {
  queue: Queue;
  connection: IORedis;
  profileManager: ProfileManager;
  quotaManager: QuotaManager;
}

const SCHEDULE_PREFIX = 'sched';


// [F3] Block until a job reaches a terminal state (completed/failed) or the
// deadline elapses, used by POST /run?wait=true. Returns the persisted job file
// (the same shape GET /job returns) on completion, or null on timeout so the
// caller can fall back to the async {jobId} response.
const waitForJobResult = async (
  queue: Queue,
  userId: string,
  jobId: string,
  maxMs: number,
  pollMs: number
): Promise<unknown | null> => {
  const deadline = Date.now() + Math.max(0, maxMs);
  // Terminal states whose result is persisted to disk by the worker.
  const TERMINAL = new Set(['completed', 'failed']);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (TERMINAL.has(state)) {
        const data = await readJobFile(userId, jobId);
        if (data) return data;
        // Result not flushed yet; give the worker a brief moment.
      }
    } else {
      // Job object already evicted (removeOnComplete) but the file may exist.
      const data = await readJobFile(userId, jobId);
      if (data) return data;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
};

export const createUserRoutes = (deps: UserRoutesDeps): Router => {
  const router = Router();
  const { queue, connection, profileManager, quotaManager } = deps;
  const workflowService = new WorkflowService(connection);

  // ══════════════════════
  // GET /me - identity probe for the UI login flow.
  // Requires a valid API key (mounted under auth in index.ts) but performs
  // NO strict user-binding check, so any valid key resolves to its owner.
  // ══════════════════════
  router.get('/me', (req: AuthenticatedRequest, res) => {
    const userId = req.apiKeyUserId || '';
    res.json({
      success: true,
      userId,
      isAdmin: config.IS_SINGLE_USER ? false : userId === 'env_root',
      keyPrefix: req.apiKeyPrefix || null,
      mode: config.DEPLOYMENT_MODE,
      isSingleUser: config.IS_SINGLE_USER
    });
  });

  // ══════════════════════════════════════════
  // POST /run - Submit new job (Instant)
  // ══════════════════════════════════════════
  router.post('/run', async (req: AuthenticatedRequest, res) => {
    try {
      // [C4] Zod validates the request envelope first (unified 400 errors);
      // the deep step tree is then sanitized by validateSteps() below.
      const body = parseBody(runBodySchema, req.body, res);
      if (!body) return;

      const userId = sanitizeUserId(body.userId);
      const headless = validateHeadless(body.headless, config.DEFAULT_HEADLESS);

      const plan = await UserManager.getUserPlan(connection, userId);
      const steps = validateSteps(body.steps, plan);
      const webhookUrl = validateWebhookUrl(body.webhookUrl);
      // Step 28: optional trigger data to seed the first node's input items.
      const triggerData = (body.triggerData && typeof body.triggerData === 'object')
        ? body.triggerData
        : undefined;

      // [F3] Sync mode + idempotency are opt-in via query / header.
      const wait = req.query.wait === 'true' || req.query.wait === '1';
      const rawIdemKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
      let idemKey: string | null = null;
      if (rawIdemKey) {
        if (!isValidIdempotencyKey(rawIdemKey)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid Idempotency-Key. Allowed: [A-Za-z0-9_.:-], max 200 chars.'
          });
        }
        idemKey = rawIdemKey;
        // Return the original job for a previously-seen key instead of re-queuing.
        const existingJobId = await connection.get(getIdempotencyKey(userId, idemKey));
        if (existingJobId) {
          if (wait) {
            const result = await waitForJobResult(
              queue, userId, existingJobId, config.RUN_WAIT_MAX_MS, config.RUN_WAIT_POLL_MS
            );
            if (result) return res.json({ ...(result as object), idempotent: true });
          }
          return res.status(200).json({
            success: true,
            jobId: existingJobId,
            idempotent: true,
            message: 'Duplicate request - returning original job'
          });
        }
      }

      // Check quota
      const hasQuota = await quotaManager.hasQuotaRemaining(userId, plan.quota);
      if (!hasQuota) {
        const usage = await quotaManager.getUsage(userId);
        return res.status(429).json({
          success: false,
          error: 'Daily quota exhausted',
          quotaMinutes: plan.quota,
          usedMinutes: Math.round(usage.usedSeconds / 60)
        });
      }

      // Check queue limit
      const currentActiveCount = await connection.scard(getUserActiveJobsKey(userId));

      if (currentActiveCount >= config.MAX_QUEUED_JOBS_PER_USER) {
        const waiting = await queue.getJobs(['waiting', 'delayed', 'active']);
        const realCount = waiting.filter(j => String(j.data.userId) === userId).length;

        if (realCount >= config.MAX_QUEUED_JOBS_PER_USER) {
          return res.status(429).json({
            success: false,
            error: `Queue limit reached. You have ${realCount}/${config.MAX_QUEUED_JOBS_PER_USER} active jobs.`
          });
        }
      }

      // Add job to queue
      const job = await queue.add(
        'run',
        { userId, steps, headless, webhookUrl, triggerData },
        { priority: plan.priority }
      );

      // [C1/C2] Add to the active set FIRST, then derive the job number from the
      // authoritative post-add count. sadd is idempotent (the worker may re-add
      // scheduled jobs), so this avoids the read-before-write race on concurrent /run.
      const activeKey = getUserActiveJobsKey(userId);
      await connection.sadd(activeKey, job.id!);
      await connection.expire(activeKey, 90 * 60);
      const thisJobNumber = await connection.scard(activeKey);

      // [F3] Remember the idempotency mapping so retries return this same job.
      if (idemKey) {
        await connection.set(
          getIdempotencyKey(userId, idemKey),
          job.id!,
          'EX',
          config.IDEMPOTENCY_TTL_SECONDS
        );
      }

      const isVip = isVipUser(plan.priority, config.VIP_PRIORITY_THRESHOLD);

      // [F3] Synchronous mode: block until the job finishes (bounded), then return
      // the full result inline. On timeout, fall through to the async 202 response
      // so long jobs are still pollable via GET /job/:userId/:jobId.
      if (wait) {
        const result = await waitForJobResult(
          queue, userId, job.id!, config.RUN_WAIT_MAX_MS, config.RUN_WAIT_POLL_MS
        );
        if (result) {
          return res.json({
            ...(result as object),
            jobId: job.id,
            waited: true
          });
        }
        return res.status(202).json({
          success: true,
          jobId: job.id,
          waited: true,
          completed: false,
          message: `Job still running after ${config.RUN_WAIT_MAX_MS}ms; poll GET /job/${userId}/${job.id}`,
          pollUrl: `/job/${userId}/${job.id}`
        });
      }

      res.json({
        success: true,
        jobId: job.id,
        message: 'Job queued successfully',
        yourJobNumber: thisJobNumber,
        queueLimit: config.MAX_QUEUED_JOBS_PER_USER,
        priority: plan.priority,
        userType: isVip ? 'VIP' : 'Free',
        webhookEnabled: !!webhookUrl
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // POST /schedule - Submit recurring job
  // ══════════════════════════════════════════
  router.post('/schedule', async (req: AuthenticatedRequest, res) => {
    try {
      // [C4] Zod validates envelope + cron shape (unified 400 errors).
      const body = parseBody(scheduleBodySchema, req.body, res);
      if (!body) return;

      const userId = sanitizeUserId(body.userId);
      const cron = body.cron.trim();
      const scheduleName = body.name
        ? String(body.name).substring(0, 50).replace(/[^a-zA-Z0-9_-]/g, '_')
        : `job_${Date.now()}`;

      // ── Get User Plan (includes overrides) ──
      const plan = await UserManager.getUserPlan(connection, userId);
      const isVip = isVipUser(plan.priority, config.VIP_PRIORITY_THRESHOLD);

      // ── Check Schedule Limit (From User's Plan) ──
      const maxSchedules = plan.maxSchedules;
      
      const existingSchedules = await queue.getRepeatableJobs();
      const userScheduleCount = existingSchedules.filter(
        job => job.id?.startsWith(`${SCHEDULE_PREFIX}:${userId}:`)
      ).length;

      if (userScheduleCount >= maxSchedules) {
        return res.status(429).json({
          success: false,
          error: `Schedule limit reached. You have ${userScheduleCount}/${maxSchedules} active schedules.`,
          hint: isVip ? 'Contact support to increase limit' : 'Upgrade to VIP for more schedules'
        });
      }

      // ── Validate Steps (deep) ──
      const headless = validateHeadless(body.headless, config.DEFAULT_HEADLESS);
      const steps = validateSteps(body.steps, plan);
      const webhookUrl = validateWebhookUrl(req.body.webhookUrl);

      // ── Create Schedule ID ──
      const scheduleId = `${SCHEDULE_PREFIX}:${userId}:${Date.now()}:${scheduleName}`;

      // ── Add Repeatable Job (Using Plan's runLimit) ──
      await queue.add(
        'run',
        { 
          userId, 
          steps, 
          headless, 
          webhookUrl,
          __scheduled: true,
          __scheduleName: scheduleName,
          __scheduleId: scheduleId
        },
        {
          priority: plan.priority,
          repeat: { 
            pattern: cron,
            // 0 means unlimited, undefined also means unlimited
            limit: plan.runLimit > 0 ? plan.runLimit : undefined
          },
          jobId: scheduleId
        }
      );

      // ── Calculate Next Run ──
      const repeatableJobs = await queue.getRepeatableJobs();
      const thisSchedule = repeatableJobs.find(j => j.id === scheduleId);

      res.json({
        success: true,
        message: 'Job scheduled successfully',
        schedule: {
          id: scheduleId,
          key: thisSchedule?.key || null,
          name: scheduleName,
          cron,
          nextRun: thisSchedule && thisSchedule.next ? new Date(thisSchedule.next).toISOString() : 'pending',
          runsLimit: plan.runLimit > 0 ? plan.runLimit : 'unlimited'
        },
        currentSchedules: userScheduleCount + 1,
        maxSchedules,
        userType: isVip ? 'VIP' : 'Free'
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /schedules/:userId - List active schedules
  // ══════════════════════════════════════════
  router.get('/schedules/:userId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      
      // Get user's plan (includes personal limits)
      const plan = await UserManager.getUserPlan(connection, userId);
      const isVip = isVipUser(plan.priority, config.VIP_PRIORITY_THRESHOLD);
      const maxSchedules = plan.maxSchedules;

      // Get all repeatable jobs
      const repeatableJobs = await queue.getRepeatableJobs();
      
      // Filter jobs belonging to this user
      const userSchedules = repeatableJobs.filter(
        job => job.id?.startsWith(`${SCHEDULE_PREFIX}:${userId}:`)
      );

      // Parse schedule info from ID
      const schedules = userSchedules.map(job => {
        const parts = job.id?.split(':') || [];
        const name = parts[3] || 'Unknown';
        const createdAt = parts[2] ? parseInt(parts[2]) : 0;

        return {
          key: job.key,
          scheduleId: job.id,
          name,
          cron: job.pattern,
          nextRun: job.next ? new Date(job.next).toISOString() : 'pending',
          createdAt: createdAt ? new Date(createdAt).toISOString() : null,
          timezone: job.tz || 'UTC'
        };
      });

      res.json({
        success: true,
        userId,
        userType: isVip ? 'VIP' : 'Free',
        count: schedules.length,
        limit: maxSchedules,
        remaining: maxSchedules - schedules.length,
        runLimit: plan.runLimit > 0 ? plan.runLimit : 'unlimited',
        schedules
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // DELETE /schedule/:userId/:key - Remove schedule
  // ══════════════════════════════════════════
  router.delete('/schedule/:userId/:key(*)', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const key = decodeURIComponent(req.params.key);

      const repeatableJobs = await queue.getRepeatableJobs();
      const schedule = repeatableJobs.find(j => j.key === key);

      if (!schedule) {
        return res.status(404).json({ 
          success: false, 
          error: 'Schedule not found',
          hint: 'Use GET /schedules/:userId to see valid keys'
        });
      }

      if (!schedule.id?.startsWith(`${SCHEDULE_PREFIX}:${userId}:`)) {
        return res.status(403).json({ 
          success: false, 
          error: 'Access denied - this schedule belongs to another user'
        });
      }

      const removed = await queue.removeRepeatableByKey(key);

      if (!removed) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to remove schedule'
        });
      }

      const parts = schedule.id.split(':');
      const name = parts[3] || 'Unknown';

      res.json({
        success: true,
        message: 'Schedule removed successfully',
        removed: {
          key,
          scheduleId: schedule.id,
          name,
          cron: schedule.pattern
        }
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // DELETE /cancel/:userId/:jobId
  // ══════════════════════════════════════════
  router.delete('/cancel/:userId/:jobId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const jobId = req.params.jobId;

      const closeBrowser = req.query.closeBrowser === 'true';
      const closeTab = req.query.closeTab === 'true';

      const job = await queue.getJob(jobId);
      if (!job || String(job.data.userId) !== userId) {
        return res.status(404).json({ success: false, message: 'Job not found' });
      }

      profileManager.setCancelFlag(jobId);
      await job.updateData({ ...job.data, __cancelledByUser: true });

      const state = await job.getState();
      let actionTaken = 'signal_sent';
      let browserClosed = false;
      let tabClosed = false;
      let contextClosed = false;

      const freeEntry = profileManager.getFreeContext(jobId);
      if (freeEntry) {
        console.log(`[CANCEL] 🧹 Cleaning up Free context for job ${jobId}`);
        try {
          await freeEntry.context.close();
          contextClosed = true;
        } catch {}
        profileManager.removeFreeContext(jobId);
      }

      if (closeBrowser) {
        const vipEntry = profileManager.getVipContext(userId);
        if (vipEntry) {
          console.log(`[CANCEL] 🔴 Closing VIP browser for user ${userId}`);
          await vipEntry.context.close().catch(() => {});
          profileManager.removeVipContext(userId);
          browserClosed = true;
        }
        profileManager.unregisterPage(jobId);
        actionTaken = browserClosed ? 'browser_closed' : 'context_closed';
      } else if (closeTab) {
        const page = profileManager.getPage(jobId);

        if (page && !page.isClosed()) {
          console.log(`[CANCEL] 🟡 Closing specific tab for job ${jobId}`);
          try {
            await page.close();
            tabClosed = true;
            actionTaken = 'tab_closed';
          } catch (e: unknown) {
            const error = e as Error;
            console.log(`[CANCEL] Failed to close tab: ${error.message}`);
          }
        } else {
          actionTaken = contextClosed ? 'context_closed' : 'page_not_found';
        }
        profileManager.unregisterPage(jobId);
      } else {
        console.log(`[CANCEL] 🟢 Soft cancel signal sent for job ${jobId}`);
        actionTaken = contextClosed ? 'context_cleaned' : 'signal_sent';
      }

      if (['waiting', 'delayed'].includes(state)) {
        await job.remove();
        await connection.srem(getUserActiveJobsKey(userId), jobId);

        return res.json({
          success: true,
          removed: true,
          previousState: state,
          action: actionTaken,
          contextClosed,
          browserClosed,
          tabClosed
        });
      }

      res.json({
        success: true,
        message: 'Cancellation processed',
        state,
        action: actionTaken,
        contextClosed,
        browserClosed,
        tabClosed,
        hint: contextClosed
          ? 'Context cleaned up'
          : browserClosed
            ? 'Browser forcefully closed'
            : tabClosed
              ? 'Tab closed, job will stop at next step'
              : 'Job will stop at next cancellation check'
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /quota/:userId
  // ══════════════════════════════════════════
  router.get('/quota/:userId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);

      const status = await UserManager.getSubscriptionStatus(connection, userId);
      const userLevel = await UserManager.getUserLevel(connection, userId);
      const userSettings = await UserManager.getUserSettings(connection, userId);

      const usage = await quotaManager.getUsage(userId);
      const remaining = await quotaManager.getRemainingSeconds(userId, status.plan.quota);

      const isVip = isVipUser(status.plan.priority, config.VIP_PRIORITY_THRESHOLD);

      res.json({
        success: true,
        userId,
        date: usage.date,
        userType: isVip ? 'VIP' : 'Free',
        forceSequential: userSettings.forceSequential || false,
        plan: {
          level: userLevel,
          quotaMinutes: status.plan.quota,
          maxTabs: status.plan.maxTabs,
          maxSteps: status.plan.maxSteps,
          priority: status.plan.priority,
          maxSchedules: status.plan.maxSchedules,
          runLimit: status.plan.runLimit > 0 ? status.plan.runLimit : 'unlimited',
          hasOverrides: status.hasOverrides,
          subscription: status.type === 'lifetime'
            ? 'Lifetime'
            : (status.daysLeft ? `${status.daysLeft} Days` : 'Free')
        },
        usage: {
          usedSeconds: usage.usedSeconds,
          usedMinutes: parseFloat((usage.usedSeconds / 60).toFixed(2)),
          limitMinutes: status.plan.quota,
          remainingSeconds: remaining === Infinity ? -1 : remaining,
          remainingMinutes: remaining === Infinity ? -1 : parseFloat((remaining / 60).toFixed(2)),
          unlimited: status.plan.quota <= 0
        }
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /jobs/:userId - List user's jobs
  // ══════════════════════════════════════════
  router.get('/jobs/:userId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      const jobs = await queue.getJobs(
        ['waiting', 'active', 'delayed', 'completed', 'failed'],
        0,
        1000,
        true
      );

      const userJobs = jobs
        .filter(j => String(j.data?.userId) === userId)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, limit);

      const list = await Promise.all(userJobs.map(async j => ({
        jobId: j.id,
        state: await j.getState(),
        progress: j.progress || 0,
        timestamp: j.timestamp ? new Date(j.timestamp).toISOString() : null,
        failedReason: j.failedReason,
        isScheduled: !!j.data.__scheduled,
        scheduleName: j.data.__scheduleName || null
      })));

      res.json({
        success: true,
        userId,
        total: list.length,
        jobs: list
      });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /job/:userId/:jobId - Get job details
  // ══════════════════════════════════════════
  router.get('/job/:userId/:jobId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const jobId = req.params.jobId;

      const job = await queue.getJob(jobId);

      if (job && String(job.data?.userId) === userId) {
        const state = await job.getState();

        if (profileManager.hasJobOutputs(jobId)) {
          let liveUrl = null;

          const vipEntry = profileManager.getVipContext(userId);
          const freeEntry = profileManager.getFreeContext(jobId);
          const entry = vipEntry || freeEntry;

          if (entry && entry.context.pages().length > 0) {
            try {
              liveUrl = entry.context.pages()[0].url();
            } catch {}
          }

          return res.json({
            success: true,
            jobId,
            state: 'active',
            progress: job.progress,
            isScheduled: !!job.data.__scheduled,
            scheduleName: job.data.__scheduleName || null,
            liveStatus: {
              message: 'Processing...',
              currentUrl: liveUrl || 'Loading...',
              stepIndex: profileManager.getJobOutputs(jobId).length || 0
            },
            stepOutputs: profileManager.getJobOutputs(jobId) || []
          });
        }

        if (['waiting', 'delayed'].includes(state)) {
          const counts = await queue.getJobCounts('waiting', 'delayed');
          return res.json({
            success: true,
            jobId,
            state,
            progress: 0,
            isScheduled: !!job.data.__scheduled,
            queueInfo: {
              totalWaiting: counts.waiting + counts.delayed,
              message: 'In Queue'
            }
          });
        }

        if (['completed', 'failed'].includes(state)) {
          const jobData = await readJobFile(userId, jobId);
          if (jobData) return res.json(jobData);
        }
      }

      const jobData = await readJobFile(userId, jobId);
      if (jobData) return res.json(jobData);

      const partialData = await readPartialJobFile(userId, jobId);
      if (partialData) {
        return res.json({
          success: false,
          state: 'failed',
          recovered: true,
          message: 'Recovered from partial crash log',
          stepOutputs: partialData,
          jobId,
          userId
        });
      }

      res.status(404).json({ success: false, message: 'Job not found' });

    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });


  // ══════════════════════════════════════════════════════════
  // WORKFLOW STORAGE (Step 17, category G2)
  // Saved, versioned, re-runnable workflows. Ownership is enforced by the auth
  // middleware via the :userId path param (strict API-key binding), so every
  // workflow is scoped to its owner. The n8n node, the Chrome extension and the
  // UI all read/write through these same endpoints.
  // ══════════════════════════════════════════════════════════

  // POST /workflows/:userId — create a new saved workflow (version 1).
  router.post('/workflows/:userId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const body = parseBody(workflowBodySchema, req.body, res);
      if (!body) return;

      // Deep-validate the step tree against the user's plan (same pass as /run).
      const plan = await UserManager.getUserPlan(connection, userId);
      const steps = validateSteps(body.steps, plan);
      const webhookUrl = validateWebhookUrl(body.webhookUrl);

      const wf = await workflowService.create(userId, {
        name: body.name,
        description: body.description ?? null,
        steps,
        headless: body.headless ?? null,
        webhookUrl,
      });
      return res.status(201).json({ success: true, workflow: wf });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // GET /workflows/:userId — list the user's saved workflows (newest first).
  router.get('/workflows/:userId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const workflows = await workflowService.list(userId);
      return res.json({ success: true, count: workflows.length, workflows });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /workflows/:userId/:workflowId — fetch one saved workflow.
  router.get('/workflows/:userId/:workflowId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const workflowId = req.params.workflowId;
      if (!isValidWorkflowId(workflowId)) {
        return res.status(400).json({ success: false, error: 'Invalid workflow id' });
      }
      const wf = await workflowService.get(userId, workflowId);
      if (!wf) return res.status(404).json({ success: false, error: 'Workflow not found' });
      return res.json({ success: true, workflow: wf });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /workflows/:userId/:workflowId/versions — version history (newest first).
  router.get('/workflows/:userId/:workflowId/versions', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const workflowId = req.params.workflowId;
      if (!isValidWorkflowId(workflowId)) {
        return res.status(400).json({ success: false, error: 'Invalid workflow id' });
      }
      const wf = await workflowService.get(userId, workflowId);
      if (!wf) return res.status(404).json({ success: false, error: 'Workflow not found' });
      const versions = await workflowService.listVersions(userId, workflowId);
      return res.json({ success: true, workflowId, count: versions.length, versions });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // PUT /workflows/:userId/:workflowId — replace editable fields, bump version,
  // and snapshot the new state into history.
  router.put('/workflows/:userId/:workflowId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const workflowId = req.params.workflowId;
      if (!isValidWorkflowId(workflowId)) {
        return res.status(400).json({ success: false, error: 'Invalid workflow id' });
      }
      const body = parseBody(workflowBodySchema, req.body, res);
      if (!body) return;

      const plan = await UserManager.getUserPlan(connection, userId);
      const steps = validateSteps(body.steps, plan);
      const webhookUrl = validateWebhookUrl(body.webhookUrl);

      const wf = await workflowService.update(userId, workflowId, {
        name: body.name,
        description: body.description ?? null,
        steps,
        headless: body.headless ?? null,
        webhookUrl,
      });
      if (!wf) return res.status(404).json({ success: false, error: 'Workflow not found' });
      return res.json({ success: true, workflow: wf });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // DELETE /workflows/:userId/:workflowId — remove a workflow + its history.
  router.delete('/workflows/:userId/:workflowId', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const workflowId = req.params.workflowId;
      if (!isValidWorkflowId(workflowId)) {
        return res.status(400).json({ success: false, error: 'Invalid workflow id' });
      }
      const removed = await workflowService.remove(userId, workflowId);
      if (!removed) return res.status(404).json({ success: false, error: 'Workflow not found' });
      return res.json({ success: true, deleted: true, workflowId });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /workflows/:userId/:workflowId/run — enqueue a job from a saved workflow.
  // Honours the same ?wait=true (sync) and Idempotency-Key contract as POST /run.
  router.post('/workflows/:userId/:workflowId/run', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = sanitizeUserId(req.params.userId);
      const workflowId = req.params.workflowId;
      if (!isValidWorkflowId(workflowId)) {
        return res.status(400).json({ success: false, error: 'Invalid workflow id' });
      }
      const wf = await workflowService.get(userId, workflowId);
      if (!wf) return res.status(404).json({ success: false, error: 'Workflow not found' });

      // Re-validate the stored steps against the CURRENT plan (plan limits may
      // have changed since the workflow was saved). Request body may optionally
      // override headless/webhookUrl for this run only.
      const plan = await UserManager.getUserPlan(connection, userId);
      const steps = validateSteps(wf.steps, plan);
      const headless = validateHeadless(
        req.body?.headless !== undefined ? req.body.headless : wf.headless,
        config.DEFAULT_HEADLESS
      );
      const webhookUrl = validateWebhookUrl(
        req.body?.webhookUrl !== undefined ? req.body.webhookUrl : wf.webhookUrl
      );
      // Step 28: optional trigger data passed at run time (manual/webhook).
      const triggerData = (req.body?.triggerData && typeof req.body.triggerData === 'object')
        ? req.body.triggerData
        : undefined;

      const wait = req.query.wait === 'true' || req.query.wait === '1';
      const rawIdemKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
      let idemKey: string | null = null;
      if (rawIdemKey) {
        if (!isValidIdempotencyKey(rawIdemKey)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid Idempotency-Key. Allowed: [A-Za-z0-9_.:-], max 200 chars.'
          });
        }
        idemKey = rawIdemKey;
        const existingJobId = await connection.get(getIdempotencyKey(userId, idemKey));
        if (existingJobId) {
          if (wait) {
            const result = await waitForJobResult(
              queue, userId, existingJobId, config.RUN_WAIT_MAX_MS, config.RUN_WAIT_POLL_MS
            );
            if (result) return res.json({ ...(result as object), idempotent: true });
          }
          return res.status(200).json({
            success: true,
            jobId: existingJobId,
            workflowId,
            idempotent: true,
            message: 'Duplicate request - returning original job'
          });
        }
      }

      // Quota check (same as /run).
      const hasQuota = await quotaManager.hasQuotaRemaining(userId, plan.quota);
      if (!hasQuota) {
        const usage = await quotaManager.getUsage(userId);
        return res.status(429).json({
          success: false,
          error: 'Daily quota exhausted',
          quotaMinutes: plan.quota,
          usedMinutes: Math.round(usage.usedSeconds / 60)
        });
      }

      // Queue limit check (same as /run).
      const activeKey = getUserActiveJobsKey(userId);
      const currentActiveCount = await connection.scard(activeKey);
      if (currentActiveCount >= config.MAX_QUEUED_JOBS_PER_USER) {
        const waiting = await queue.getJobs(['waiting', 'delayed', 'active']);
        const realCount = waiting.filter((j) => String(j.data.userId) === userId).length;
        if (realCount >= config.MAX_QUEUED_JOBS_PER_USER) {
          return res.status(429).json({
            success: false,
            error: `Queue limit reached. You have ${realCount}/${config.MAX_QUEUED_JOBS_PER_USER} active jobs.`
          });
        }
      }

      // Enqueue, tagging the job with its source workflow for traceability.
      const job = await queue.add(
        'run',
        { userId, steps, headless, webhookUrl, triggerData, __workflowId: workflowId, __workflowVersion: wf.version },
        { priority: plan.priority }
      );
      await connection.sadd(activeKey, job.id!);
      await connection.expire(activeKey, 90 * 60);
      const thisJobNumber = await connection.scard(activeKey);

      if (idemKey) {
        await connection.set(
          getIdempotencyKey(userId, idemKey),
          job.id!,
          'EX',
          config.IDEMPOTENCY_TTL_SECONDS
        );
      }

      const isVip = isVipUser(plan.priority, config.VIP_PRIORITY_THRESHOLD);

      if (wait) {
        const result = await waitForJobResult(
          queue, userId, job.id!, config.RUN_WAIT_MAX_MS, config.RUN_WAIT_POLL_MS
        );
        if (result) {
          return res.json({ ...(result as object), jobId: job.id, workflowId, waited: true });
        }
        return res.status(202).json({
          success: true,
          jobId: job.id,
          workflowId,
          waited: true,
          completed: false,
          message: `Job still running after ${config.RUN_WAIT_MAX_MS}ms; poll GET /job/${userId}/${job.id}`,
          pollUrl: `/job/${userId}/${job.id}`
        });
      }

      return res.json({
        success: true,
        jobId: job.id,
        workflowId,
        workflowVersion: wf.version,
        message: 'Workflow job queued successfully',
        yourJobNumber: thisJobNumber,
        queueLimit: config.MAX_QUEUED_JOBS_PER_USER,
        priority: plan.priority,
        userType: isVip ? 'VIP' : 'Free',
        webhookEnabled: !!webhookUrl
      });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(400).json({ success: false, error: error.message });
    }
  });
  return router;
};