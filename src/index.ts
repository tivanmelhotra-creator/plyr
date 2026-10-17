'use strict';

import express from 'express';
import helmet from 'helmet';
import { Queue, Worker, Job, DelayedError } from 'bullmq';
import IORedis from 'ioredis';
import fsExtra from 'fs-extra';
import path from 'path';
import { BrowserWindowManager } from './core/BrowserWindowManager';
import fs from 'fs/promises';

import { config } from './config';
import { runPipeline } from './pipeline';
import { buildItemsFromTrigger, buildManualItems } from './core/TriggerEngine';
import { ProfileManager } from './core/ProfileManager';
import { ProfileLeases, resolveRunProfile, needsLease, registerProfileLeases, type ProfileRef } from './core/ProfileLease';
import { ProfileFailureReports, registerProfileFailureReports } from './core/ProfileFailureReports';
import { preRunProfileCheck } from './core/BranchPolicy';
import { applyAfterRun } from './core/BrowserLifecycle';
import { reapOrphans, lockedRootsUnder } from './core/OrphanBrowsers';
import { sweepStaleLocks, preRunLockCheck } from './core/ProfileLock';
import { indexedProfile } from './core/ProfileIndex';
import { runningProfileOf } from './core/BrowserSessions';
import { ProfileRegistry } from './core/ProfileRegistry';
import { ProfileReservations } from './core/ProfileReservations';
import { BrowserSessions, registerBrowserSessions, jobDependent, sessionDataDir } from './core/BrowserSessions';
import { saveBeforeClose } from './core/BrowserStateSnapshot';
import { ProfileAccess, registerProfileAccess, explainDenial } from './core/ProfileAccess';
import { ProfileCoordinator, ownerOfJob, occurrenceOf, reservationWindow } from './core/ProfileCoordinator';
import { afterRunPolicyOf, outcomeOfError, type RunOutcome } from './core/BrowserLifecycle';
import { runOriginOf, headlessFor, describeVisibility } from './core/RunPolicy';
import { stepsUseExtensions } from './core/ExtensionStep';
import { browserModes } from './core/BrowserMode';
import { GlobalBrowser } from './core/GlobalBrowser';
import { smartLimiter, pairingLimiter } from './rate-limit';
import { sanitizeLogMessage, validateSteps } from './validation';
import { WorkflowService, resolveScheduledWorkflow } from './services/workflow.service';
import {
  requireApiKey,
  isAcceptedCredential,
  AuthenticatedRequest,
  SINGLE_USER_ID
} from './middleware/auth';
import { createAuthRoutes } from './Routes/auth.routes';
import { authStore } from './core/AuthStore';

// Utils & Services
import { STATS_KEY, getUserActiveJobsKey, getLiveChannel } from './utils/redis-keys';
import { sendWebhook, sendStepWebhook } from './services/webhook.service';
import { persistJob } from './services/job.service';
import { initStorage, executionsFor, workflowStoreFor } from './services/storage';
import { closeSharedSqlite } from './core/SqliteStore';
import type { ExecutionStatus } from './services/execution.repository';

// Step 16: Live Channel (WebSocket + SSE) live job events.
import { LiveBus, JobLivePublisher } from './core/LiveBus';
import { LiveServer, authorizeLive } from './core/LiveServer';
import { buildStepWebhookPayload, buildShareToken, shouldDeliverStepEvent } from './core/StepReporter';
import { LiveBrowserManager } from './core/LiveBrowser';
import { setLiveSessionProvider } from './core/LiveSessions';
import { BrowserStreamServer } from './core/BrowserStreamServer';
import { DesktopProxy } from './core/DesktopProxy';
import { JobScreencastHub } from './core/JobScreencast';
import { createLiveFramesRouter } from './Routes/live-frames.routes';
import { createLiveControlRouter } from './Routes/live-control.routes';
import { classifyFault, FaultReporter } from './core/ProcessGuard';
import { enforceStartupValidation } from './core/StartupValidation';
// Dual browser mode: the reverse tunnel to a user's own Chrome, and the
// Element Inspector's push channel. Both share this port with /live/ws and
// /browser/ws, which is why the upgrade handler below multiplexes by path.
import { localBridges, agentConnectPath } from './core/LocalBridge';
import { InspectorSocketServer } from './core/InspectorSocket';
import { onLocalBridgeLost } from './core/BrowserAdapter';
// The Inspector's own credential store. Imported here rather than inside
// middleware/auth.ts on purpose: core/ already imports from middleware/
// (DesktopProxy, LiveServer), so the reverse direction would close an import
// cycle. Composing the two at the mount point keeps the dependency one-way.
import { inspectorAuth } from './core/InspectorAuthorization';

import { setLiveSessionRebuilder } from './Routes/browser.routes';

// Routes
import { createAllRoutes } from './Routes';
import { createSettingsRoutes } from './Routes/settings.routes';
import { runProfileIdOf } from './core/NodeProfile';
import { endContinuation, sweepExpiredGrants, registerWorkflowLookup } from './core/SessionContinuation';

// ============================================
// EXPRESS SETUP
// ============================================

const app = express();
app.set('trust proxy', 1);

// The real-Chrome desktop (noVNC) is proxied BEFORE helmet and BEFORE
// express.json on purpose:
//   - helmet's CSP is written for OUR pages; noVNC ships its own script/style
//     expectations and must be served with the headers websockify sent, not
//     ours, or the client refuses to boot.
//   - express.json would consume the request body of a request we are about to
//     re-send upstream.
// It authenticates itself (see DesktopProxy.desktopAuthOk), so sitting ahead of
// the auth middleware does not open a hole.
app.use((req, res, next) => {
  if (desktopProxy && desktopProxy.handleRequest(req, res)) return;
  next();
});

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
// UI (same-origin), external API clients and the browser extension may live on a different
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
// One run per browser profile at a time (core/ProfileLease). The lease TTL is
// the existing hard run ceiling, refreshed by the holder while it runs.
const profileLeases = new ProfileLeases(connection, Math.max(60, config.MAX_JOB_DURATION_MINUTES * 60));
registerProfileLeases(profileLeases);
// The profile infrastructure (see each module's header): identity, scheduled
// reservations, live browser sessions, and one view over all of them.
// Branches (one Chromium user-data root each) and their profiles
// (core/BranchRegistry). New branches go under the base directory
// (Settings, core/BranchBase). The Local Browser root (RealChrome) is NOT a
// branch; a stored record of it is dropped on load (brief 2.1).
const profileRegistry = new ProfileRegistry(config.PROFILES_DIR, {
  baseDir: () => config.BRANCH_BASE_DIR,
});
// Load the registry (and the profile -> branch lock index) before any run
// resolves its profile. Adopts pre-branch roots with data IN PLACE (moves
// nothing) and reconciles registry == disk under the base directory.
void profileRegistry.warm(SINGLE_USER_ID)
  // Owner brief 6.6: locks of workflows that no longer exist are removed (logged).
  .then(() => sweepStaleLocks({
    registry: profileRegistry, userId: SINGLE_USER_ID,
    workflowIds: async (u) => (await new WorkflowService(workflowStoreFor(connection)).list(u)).map((w) => w.id),
  }))
  .catch((e) => console.warn(`[PROFILES] registry not loaded: ${(e as Error).message}`));
const profileFailures = new ProfileFailureReports(connection);
registerProfileFailureReports(profileFailures);
const profileReservations = new ProfileReservations(connection);
const browserSessionRegistry = new BrowserSessions(connection);
registerBrowserSessions(browserSessionRegistry);
const profileAccessService = new ProfileAccess(profileRegistry, profileLeases, profileReservations, browserSessionRegistry);
registerProfileAccess(profileAccessService);
// Task View labels windows by their registry profile (user-data-dir -> name).
// One branch = one root; the window belongs to the profile RUNNING on it.
BrowserWindowManager.setProfileResolver(async (dir) => {
  const want = path.resolve(dir);
  const list = await profileRegistry.list(SINGLE_USER_ID).catch(() => []);
  const inRoot = list.filter((p) => path.resolve(profileRegistry.dirOf(SINGLE_USER_ID, p.id)) === want);
  if (!inRoot.length) return null;
  const key = indexedProfile(inRoot[0]!.id)?.leaseKey;
  const runningId = key ? runningProfileOf(key) : null;
  const p = inRoot.find((x) => x.id === runningId) || (inRoot.length === 1 ? inRoot[0]! : null);
  return p ? { id: p.id, name: p.name } : null;
});
/** Jobs executing in THIS process right now (reservation sweep evidence). */
const runningJobs = new Set<string>();
// Continue Session checks its target workflow through this (same store as the routes).
registerWorkflowLookup(async (userId, workflowId) => !!(await new WorkflowService(workflowStoreFor(connection)).get(userId, workflowId).catch(() => null)));
const profileCoordinator = new ProfileCoordinator(
  queue, profileLeases, profileReservations, browserSessionRegistry,
  async (userId, workflowId) => {
    const wf = await new WorkflowService(workflowStoreFor(connection)).get(userId, workflowId);
    if (!wf) return null;
    const d = WorkflowService.executableDesign(wf);
    return { profileId: d.profileId, name: wf.name, active: wf.active !== false, steps: d.steps };
  },
  (userId) => browserModes.modeOf(userId) === 'local',
);

// Step 16: live event bus (publishes to Redis Pub/Sub + replay buffer).
const liveBus = new LiveBus(connection);
// LiveServer (WebSocket fan-out) is created lazily in startServer once the
// HTTP server exists, so it can attach to the 'upgrade' event.
let liveServer: LiveServer | null = null;
// Step 12: interactive Live Browser View (CDP screencast + input + element picker).
const liveBrowserManager = new LiveBrowserManager(8);
// Let HTTP routes find the live session a user is looking at.
//
// The manager stays owned here -- sessions are created and destroyed by the
// socket server, which is the correct owner of their lifetime. This only
// PUBLISHES a read-only lookup, because the Remote/Local handoff arrives over a
// plain HTTP route that knows who is asking but has no way to reach this local
// binding, and it must snapshot the tabs the user can actually see rather than
// guess at them. See core/LiveSessions.ts for why registration beats exporting.
setLiveSessionProvider(liveBrowserManager);
let browserStreamServer: BrowserStreamServer | null = null;
// Serves the real Chrome's screen on this same port (see DesktopProxy).
let desktopProxy: DesktopProxy | null = null;
// The Element Inspector's push channel (/inspector/ws). Created in startServer
// for the same reason as the others: it needs the HTTP server to exist before
// it can take an upgrade.
let inspectorSockets: InspectorSocketServer | null = null;

// GLOBAL MANDATE: no user action may ever require "restart the server".
// SelfHeal stops and restarts real Chrome to load a newly installed extension.
// In that window every live session's CDP context dies. rebuildAll() re-attaches
// each session to the fresh browser and reloads its tabs, so an extension install
// costs the user a progress panel — never a lost tab. index.ts owns the manager,
// so it registers the rebuilder rather than browser.routes importing it (cycle).
setLiveSessionRebuilder(async () => {
  await liveBrowserManager.rebuildAll();
});

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
  // Crash leftovers (core/OrphanBrowsers): Chromium processes on Aria's own
  // data roots whose server died are stopped; a SingletonLock is removed only
  // when no live browser holds that root. Browsers of a running server
  // (this one or another) and personal Chrome are never touched.
  console.log('[SYSTEM] Checking for leftover browsers and stale locks...');
  try {
    const areas = [config.PROFILES_DIR, config.BRANCH_BASE_DIR, config.REAL_CHROME_USER_DATA_DIR];
    const roots = (await Promise.all(areas.map((a) => lockedRootsUnder(a)))).flat();
    const r = await reapOrphans(areas, { roots });
    if (r.skipped) console.warn(`[SYSTEM] ${r.skipped}`);
    if (r.killed.length) console.log(`[SYSTEM] Stopped ${r.killed.length} leftover browser process(es) of a previous server run: ${r.killed.map((k) => `${k.pid} (${k.userDataDir})`).join(', ')}`);
    if (r.unlocked.length) console.log(`[SYSTEM] Cleaned stale lock(s) in ${r.unlocked.length} profile root(s)`);
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

/**
 * The credential a request presents, read from every place one may arrive.
 *
 * DELIBERATELY THE SAME FOUR PLACES, IN THE SAME ORDER, as `requireApiKey`.
 * A second reader that disagreed with the first about where a credential lives
 * would authenticate one string and authorize another — so this mirrors that
 * function exactly, and returns the RAW value without judging it. Deciding what
 * the value means is the caller's job.
 */
function readPresentedKey(req: express.Request): string {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (req.query.api_key) return String(req.query.api_key);
  if (req.query.token) return String(req.query.token);
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7).trim();
  return '';
}

// Rate limiting
app.use('/run', smartLimiter);
app.use('/cancel', smartLimiter);
// Mounted BEFORE the inspector auth middleware, so a flood of guesses is
// rejected without ever reaching the code-comparison path. Scoped to the exact
// route that accepts no key — the rest of /inspector is credential-gated and
// needs no separate budget.
app.use('/inspector/pair', pairingLimiter);

// API Key authentication
app.use('/run', asyncAuthMiddleware);
app.use('/cancel', asyncAuthMiddleware);
app.use('/job', asyncAuthMiddleware);
app.use('/jobs', asyncAuthMiddleware);
app.use('/quota', asyncAuthMiddleware);
app.use('/me', asyncAuthMiddleware);
app.use('/workflows', asyncAuthMiddleware);
app.use('/workspace', asyncAuthMiddleware);
app.use('/profiles', asyncAuthMiddleware);
app.use('/browser', asyncAuthMiddleware);
// The mode switch decides which browser runs someone's automation, and the
// inspector routes carry element data read off logged-in pages. Neither may be
// reachable without a key.
app.use('/browser-mode', asyncAuthMiddleware);
// Settings page: everything but GET /auth/mode needs a key (see settings.routes.ts).
app.use('/settings', asyncAuthMiddleware);

/**
 * INSPECTOR AUTH — an API key, OR a credential the Inspector itself issued.
 *
 * ── THE BUG THIS FIXES ─────────────────────────────────────────────────────
 * REPORTED, with a correct Base URL and a correct code:
 *
 *   «در حالت ریموت وقتی ادرس و کد اتورایز رو وارد کردم این ارور رو داد در حالی
 *    که هر دو درست بودن — That authorization code was not accepted.»
 *
 * The code was never looked at. `/inspector/*` sat behind `asyncAuthMiddleware`
 * wholesale, and a REMOTE extension is one the operator installed BY HAND from
 * artifacts/ — it has no `bootstrap.config.js`, so it holds no API key. The
 * request was refused with 401 before `/inspector/pair` ever ran, and the popup
 * reported its generic fallback ("not accepted"), naming the code for what was
 * really a missing credential.
 *
 * That was a circular requirement, not a missing key: REMOTE exists precisely
 * because the two machines share no channel but the operator, so demanding the
 * far end already hold this server's key in order to redeem a code makes the
 * code meaningless — whoever has the key needs no code, and whoever lacks it
 * cannot redeem one.
 *
 * ── WHAT IS OPENED, AND WHAT IS EMPHATICALLY NOT ───────────────────────────
 * EXACTLY TWO PATHS relax, and only to the extent that the caller presents
 * something this server itself minted:
 *
 *   POST /inspector/pair     — may be called with NO key. The one-time code IS
 *                              the credential; the route hands back a scoped
 *                              client token. Codes are single-use, 5-minute,
 *                              8 chars from a 31-symbol alphabet, and rate
 *                              limited below, so this is not a guessing surface.
 *
 *   POST /inspector/element  — accepted with a client token in place of a key.
 *   GET  /inspector/target*  — the token identifies the CLIENT; the server still
 *   GET  /inspector/consent* — decides from its binding table which fields that
 *                              client may touch.
 *
 * Everything else under /inspector — and in particular
 * `/inspector/targeting/begin`, the route that MINTS codes — still requires a
 * real API key. That asymmetry is the whole security argument: minting is a
 * dashboard act by an authenticated operator, redeeming is a transcription act
 * by the human holding the other browser. A token can never mint itself a new
 * code, so it cannot escalate from "one field I was given" to "any field".
 *
 * The standing rule is untouched: «The Extension must NEVER be able to choose an
 * arbitrary Target Field.» The token says WHO; the server decides WHAT.
 */
// Every entry is a route that actually exists in mode.routes.ts — verified
// against it, because a name that matches nothing is a silent hole in the other
// direction: it looks like the token was granted a path when in fact the request
// 404s, and a genuinely needed path stays refused with a confusing 401.
const inspectorTokenPaths = new Set([
  // The route this whole subsystem exists for: submit the picked element.
  '/element',
  // Acknowledge a delivery, and read what is queued for this client.
  '/ack',
  '/inbox',
  // Session/target bookkeeping the extension does on its own behalf.
  '/session',
  '/target',
  '/target/release',
  // Poll for the outcome of the pairing this token came from.
  '/targeting/status',
  // The in-page approval prompt. Included because the SERVER's own browser may
  // run a hand-installed copy too, and a prompt it cannot poll for is a prompt
  // that never appears — bug #3's failure mode, arriving by a different road.
  '/consent',
  '/consent/decide',
  '/consent/status',
]);

const inspectorAuthMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // `req.path` here is relative to the mount point ('/pair', '/element', …).
  const sub = req.path || '';

  // ── 0. The consent HOST page: no credential, because none is possible ─────
  //
  // This is the page the server's own browser is navigated to so that the
  // extension's content script has somewhere legal to run. It must be loadable
  // by a Chromium window that has just started and has authenticated nothing:
  // a browser navigating to a URL sends no x-api-key header, so gating it means
  // it serves a 401 JSON body, no content script is injected, and the consent
  // Alert has nowhere to render at all.
  //
  // MEASURED against the running server, which is the only way this surfaced.
  // The route's own integration tests mount the router directly and so never
  // pass through this middleware — they reported 200 while the real server
  // reported 401 with «Authentication required». A route can be correct and
  // still be unreachable; only the live request proves reachability.
  //
  // SAFE because the page is a blank canvas. It embeds no consent, no field, no
  // node, no token and no account, and carries no script of its own — see
  // ConsentHostPage.ts, and the pair of tests in targeting-routes.test.ts that
  // hold it that way. The consent itself is still fetched AUTHENTICATED by the
  // content script from GET /inspector/consent, which is not exempted here.
  // If this page ever starts rendering prompt data, this exemption must go.
  if (sub === '/consent-host') return next();

  // ── 1. The pairing route: no credential required, by design ───────────────
  //
  // The route itself still validates the code and still refuses a bad one — see
  // `redeem()`. What changes is only that a keyless caller now REACHES it.
  if (sub === '/pair') {
    // A key is still read when present, so a dashboard or a server-seeded
    // extension keeps its identity and its existing bindings instead of being
    // handed a second, anonymous one.
    const presented = readPresentedKey(req);
    if (presented && config.IS_SINGLE_USER && isAcceptedCredential(presented)) {
      (req as AuthenticatedRequest).apiKey = presented;
      (req as AuthenticatedRequest).apiKeyUserId = SINGLE_USER_ID;
    }
    return next();
  }

  // ── 2. A client token, on the paths it is scoped to ───────────────────────
  if (inspectorTokenPaths.has(sub)) {
    const presented = readPresentedKey(req);
    const ct = presented ? inspectorAuth.resolveClientToken(presented) : null;
    if (ct) {
      // Adopted as this request's identity. Downstream code reads `req.apiKey`
      // to look up bindings, and the token's client id is derived from this
      // exact string — so the binding table resolves to the same client that
      // redeemed the code, and to no other.
      (req as AuthenticatedRequest).apiKey = presented;
      (req as AuthenticatedRequest).apiKeyUserId = ct.userId;
      (req as AuthenticatedRequest).apiKeyPrefix = presented.slice(0, 15);
      return next();
    }
  }

  // ── 3. Everything else: unchanged. A real API key or nothing ──────────────
  return asyncAuthMiddleware(req, res, next);
};

app.use('/inspector', inspectorAuthMiddleware);


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
  profileLeases,
  profileAccess: profileAccessService,
  profileCoordinator,
  luaScriptsLoaded,
  reloadLuaScripts: initLuaScripts
});

app.use('/', routes.health);
app.use('/', routes.user);
app.use('/', routes.browser);
app.use('/', routes.mode);
app.use('/', routes.workflowFiles);
if (routes.profiles) app.use('/', routes.profiles);
// Owner-password setup / login (public by design; change-password self-guards).
app.use('/', createAuthRoutes());
const settingsRoutes = createSettingsRoutes();
app.use('/', settingsRoutes.publicRouter);
app.use('/', settingsRoutes.router);

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
  const auth = await authorizeLive(apiKey, userId, { req });
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

// View-only picture of the job's page (CDP screencast, server -> client only).
// Same gate as /live/sse: a share token bound to this job, or an API key.
// In-process by design: the page lives in THIS process's ProfileManager, so a
// split web/worker deployment would need the worker to serve this route.
const jobScreencast = new JobScreencastHub({ getPage: (jobId) => profileManager.getPage(jobId) as any });
app.use('/live/frames', createLiveFramesRouter({ hub: jobScreencast, authorize: authorizeLive }));

// Live run tab: the run's plan (share token) and Restart (owner only).
// Stop reuses DELETE /cancel. See src/Routes/live-control.routes.ts.
app.use('/live/restart', smartLimiter);
app.use('/', createLiveControlRouter({
  authorize: authorizeLive,
  getJob: async (jobId) => (await queue.getJob(jobId)) as any,
  workflowName: async (owner, workflowId) => {
    const wf = await new WorkflowService(workflowStoreFor(connection)).get(owner, workflowId);
    return wf ? wf.name : null;
  },
  cancel: async (job) => {
    const id = String(job.id);
    profileManager.setCancelFlag(id);
    const j = await queue.getJob(id);
    if (!j) return;
    await j.updateData({ ...j.data, __cancelledByUser: true });
    const st = await j.getState();
    if (st === 'waiting' || st === 'delayed' || st === 'prioritized') {
      await j.remove().catch(() => {});
      await connection.srem(getUserActiveJobsKey(String(j.data.userId)), id).catch(() => {});
    }
  },
  enqueue: async (data) => {
    const job = await queue.add('run', data, { priority: config.INSTANCE_LIMITS.priority });
    const key = getUserActiveJobsKey(String(data.userId));
    await connection.sadd(key, job.id!);
    await connection.expire(key, 90 * 60);
    return String(job.id);
  },
  shareToken: (userId, jobId) => config.LIVE_SHARE_SECRET
    ? buildShareToken(userId, jobId, config.LIVE_SHARE_SECRET, config.LIVE_SHARE_TTL_SEC)
    : null,
}));

app.get('/live/sse/:userId/:jobId', async (req, res) => {
  const userId = String(req.params.userId);
  const jobId = String(req.params.jobId);
  const apiKey = (req.headers['x-api-key'] as string | undefined)
    || (req.query.api_key ? String(req.query.api_key) : undefined);
  // Step 29: optional shareable-link token (read-only access).
  const share = req.query.share ? String(req.query.share) : undefined;

  const auth = await authorizeLive(apiKey, userId, { share, jobId, req });
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

const worker = new Worker('automation-jobs', async (job: Job, token?: string) => {
  const userId = String(job.data.userId);
  const webhookUrl = job.data.webhookUrl;

  // Immediate cancel check
  if (job.data.__cancelledByUser || profileManager.isCancelledLocally(job.id!)) {
    console.log(`[JOB:${job.id}] ⚡ Already cancelled - skipping`);
    await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
    return;
  }

  // A schedule bound to a saved workflow follows that workflow's CURRENT state
  // at every fire: inactive -> skipped (no run, no history entry); active ->
  // runs the frozen activation snapshot, never the live Editor design.
  if (job.data.__scheduled && typeof job.data.__scheduleWorkflowId === 'string') {
    try {
      const svc = new WorkflowService(workflowStoreFor(connection));
      // Same owner lookup the /schedule route used when it accepted the binding.
      const r = await resolveScheduledWorkflow(svc, userId, job.data.__scheduleWorkflowId);
      if ('skip' in r) {
        console.log(`[JOB:${job.id}] schedule skipped: ${r.skip} (${job.data.__scheduleWorkflowId})`);
        // The occurrence will not run: its reservation (if any) stops blocking.
        const occ = occurrenceOf(job);
        if (occ && typeof job.data.__scheduleId === 'string') {
          for (const [leaseId, list] of await profileReservations.all().catch(() => new Map())) {
            if (list.some((x: { scheduleId?: string; occurrence: number }) => x.scheduleId === job.data.__scheduleId && x.occurrence === occ)) {
              await profileReservations.markMissed(leaseId, job.data.__scheduleId, occ).catch(() => {});
            }
          }
        }
        await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
        return;
      }
      job.data.steps = validateSteps(r.steps, config.INSTANCE_LIMITS);
      if (r.profileId !== undefined) job.data.profileId = r.profileId;
      job.data.__workflowVersion = r.version;
    } catch (e) {
      console.warn(`[JOB:${job.id}] schedule could not resolve its workflow: ${(e as Error).message}`);
      await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
      return;
    }
  }

  const userPlan = config.INSTANCE_LIMITS;

  // [C1] Ensure the job is tracked in the active set. Idempotent: /run already adds
  // immediate jobs, but SCHEDULED (repeatable) jobs are enqueued by BullMQ and never
  // pass through /run, so this is their only registration point. The finally{} block
  // below is the single removal point for both paths.
  await connection.sadd(getUserActiveJobsKey(userId), job.id!);
  await connection.expire(getUserActiveJobsKey(userId), 90 * 60);

  // WHO started this run decides whether its browser is shown (core/RunPolicy):
  // the operator's click = visible, everything else = hidden. Stamped by the
  // route that enqueued the job; a schedule never carries 'manual'.
  const origin = runOriginOf(job.data.__scheduled ? 'automatic' : job.data.__origin);
  const headless = headlessFor(origin);

  // WHICH profile this run needs, and its lease (core/ProfileLease). A busy
  // profile sends the job back to the delayed set: it waits without holding a
  // worker slot, and runs on other, free profiles are not affected.
  const profile: ProfileRef = resolveRunProfile({
    userId,
    // A Launch Browser node may name its own profile (core/NodeProfile).
    profileId: runProfileIdOf(job.data.steps, typeof job.data.profileId === 'string' ? job.data.profileId : null),
    usesExtensions: stepsUseExtensions(job.data.steps),
    localMode: browserModes.modeOf(userId) === 'local',
    profilesDir: config.PROFILES_DIR,
    realChromeDir: config.REAL_CHROME_USER_DATA_DIR,
  });
  // WHO the run works for: holds and reservations of the same owner (its
  // workflow) are compatible with it, any other owner's are not.
  const runOwner = ownerOfJob(job.data, String(job.id));

  // The profile must still exist BEFORE anything is launched (section 9): a
  // folder removed outside Aria fails this run cleanly, is reported, and is
  // NEVER silently recreated as an empty folder.
  // A saved workflow whose profile was deleted with its branch: refuse instead
  // of silently running on the Default profile.
  const ownWfId = typeof (job.data.__workflowId || job.data.__scheduleWorkflowId) === 'string' ? String(job.data.__workflowId || job.data.__scheduleWorkflowId) : null;
  if (ownWfId && profile.profileId === 'default' && !job.data.profileId) {
    const owner = job.data.__workspace?.owner || userId;
    const wfRec = await new WorkflowService(workflowStoreFor(connection)).get(String(owner), ownWfId).catch(() => null);
    if (wfRec?.profileMissing && !wfRec.profileId) {
      const msg = `The browser profile of workflow "${wfRec.name}" ("${wfRec.profileMissing.profileName || wfRec.profileMissing.profileId}") was deleted with its branch. Assign a profile first.`;
      await profileFailures.record(userId, { reason: 'profile_missing', detail: 'record_missing', stage: 'run', workflowId: ownWfId, workflowName: wfRec.name,
        profileId: wfRec.profileMissing.profileId, profileName: wfRec.profileMissing.profileName ?? null, jobId: String(job.id), message: msg });
      void liveBus.publish({ type: 'log', userId, jobId: String(job.id), seq: 0, data: { message: msg } }).catch(() => {});
      await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
      throw new Error(`PROFILE_MISSING: ${msg}`);
    }
  }
  {
    const broken = await preRunProfileCheck({
      registry: profileRegistry, userId, profile,
      workflowId: typeof (job.data.__workflowId || job.data.__scheduleWorkflowId) === 'string' ? String(job.data.__workflowId || job.data.__scheduleWorkflowId) : null,
      workflowName: job.data.__scheduleName || null, jobId: String(job.id),
      record: (u, r) => profileFailures.record(u, r),
      notify: (message) => { void liveBus.publish({ type: 'log', userId, jobId: String(job.id), seq: 0, data: { message } }).catch(() => {}); },
    });
    if (broken) {
      await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
      throw new Error(`PROFILE_BROKEN: ${broken.message}`);
    }
  }
  // PROFILE LOCK (owner brief 6.5): a profile locked to ANOTHER workflow is
  // never used by this run, whatever started it. Before any lease.
  {
    const locked = await preRunLockCheck({
      registry: profileRegistry, userId, profileId: profile.profileId, workflowId: ownWfId,
      workflowName: job.data.__scheduleName || null, jobId: String(job.id),
      workflowNameOf: async (id) => (await new WorkflowService(workflowStoreFor(connection)).get(userId, id))?.name,
      record: (u, r) => profileFailures.record(u, r),
      notify: (message) => { void liveBus.publish({ type: 'log', userId, jobId: String(job.id), seq: 0, data: { message } }).catch(() => {}); },
    });
    if (locked) {
      await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
      throw new Error(`PROFILE_LOCKED: ${locked.message}`);
    }
  }
  const occurrence = job.data.__scheduled ? occurrenceOf(job) : null;
  let leaseToken: string | null = null;
  if (needsLease(profile)) {
    const got = await profileLeases.acquire(profile.id, String(job.id), { owner: runOwner });
    if (!got.ok) {
      // Waiting reason, said once per reason (in use / held / reserved).
      const why = explainDenial(got.reason, {
        lease: got.holder ? { jobId: got.holder.jobId } : null,
        hold: got.hold ? { until: got.hold.expiresAt } : null,
        reservation: got.reservation || null,
      }) || 'busy';
      const waitKey = `${profile.id}|${got.reason}`;
      if (job.data.__waitingFor !== waitKey) {
        await job.updateData({ ...job.data, __waitingFor: waitKey }).catch(() => {});
        console.log(`[JOB:${job.id}] waiting: profile "${profile.label}" - ${why}`);
        void liveBus.publish({ type: 'log', userId, jobId: String(job.id), seq: 0,
          data: { message: `Waiting: browser profile "${profile.label}" - ${why}` } }).catch(() => {});
      }
      await job.moveToDelayed(Date.now() + Math.max(500, config.QUEUE_DELAY_MS), token);
      throw new DelayedError();
    }
    leaseToken = got.token;
    // A scheduled occurrence that is now running: its reservation is FIRED
    // (blocking until this run settles it, however long it lasts).
    if (occurrence && typeof job.data.__scheduleId === 'string') {
      await profileReservations.markFired(profile.id, {
        scheduleId: job.data.__scheduleId, owner: runOwner, ownerName: job.data.__scheduleName,
      }, occurrence, String(job.id), reservationWindow()).catch((e: Error) => {
        console.warn(`[JOB:${job.id}] could not mark its reservation fired: ${e.message}`);
      });
    }
  }
  runningJobs.add(String(job.id));
  let runOutcome: RunOutcome = 'error';
  const leaseRefresh = leaseToken
    ? setInterval(() => { void profileLeases.refresh(profile.id, leaseToken!).catch(() => {}); }, 60_000)
    : null;
  if (leaseRefresh && typeof leaseRefresh.unref === 'function') leaseRefresh.unref();

  profileManager.initJobOutputs(job.id!);

  // Step 16: per-job live publisher (best-effort fan-out to subscribers).
  const livePub = new JobLivePublisher(liveBus, userId, job.id!);

  // Execution history (SQLite). StepOutputs carry no item counts/samples;
  // those arrive on `step.done`, so they are collected here by step index.
  const stepItems = new Map<number, Record<string, unknown>>();
  const startedIso = new Date().toISOString();
  const recordExecution = (status: ExecutionStatus, error?: string | null) => {
    const repo = executionsFor(connection);
    if (!repo || job.data.__runNode) return; // a per-node test is not an execution
    try {
      const outs = profileManager.getJobOutputs(job.id!) || [];
      repo.record({
        jobId: String(job.id),
        userId,
        workflowId: job.data.__workflowId ? String(job.data.__workflowId) : null,
        workflowVersion: typeof job.data.__workflowVersion === 'number' ? job.data.__workflowVersion : null,
        trigger: job.data.__scheduled ? 'schedule' : (job.data.__workflowId ? 'workflow' : 'manual'),
        status,
        startedAt: startedIso,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedIso),
        error: error ?? null,
        steps: outs.map((o) => ({ ...o, ...(stepItems.get(o.step) || {}) })),
      });
    } catch (e) {
      console.warn(`[JOB:${job.id}] could not record execution history: ${(e as Error).message}`);
    }
  };

  // Execute Workflow of a saved workflow = its test run. The outcome and the
  // fingerprint of the design that ran are stored on the workflow; activation
  // is refused until the CURRENT design has a successful test (TestRunGate).
  const recordTestOutcome = async (status: ExecutionStatus, error?: string | null) => {
    const t = job.data.__testOf;
    if (!t || typeof t.workflowId !== 'string' || typeof job.data.__testFingerprint !== 'string') return;
    try {
      const outs = profileManager.getJobOutputs(job.id!) || [];
      const failed = outs.find((o) => o && o.success === false);
      await new WorkflowService(workflowStoreFor(connection)).recordTestResult(String(t.owner || userId), t.workflowId, {
        status,
        fingerprint: job.data.__testFingerprint,
        jobId: String(job.id),
        finishedAt: new Date().toISOString(),
        error: status === 'success' ? null : (error ? String(error).slice(0, 1000) : null),
        failedStep: status === 'success' || !failed ? null
          : { step: failed.step, action: failed.action, error: failed.error ? String(failed.error).slice(0, 500) : undefined },
      });
    } catch (e) {
      console.warn(`[JOB:${job.id}] could not record the test result: ${(e as Error).message}`);
    }
  };

  // Executions view: what the run SAID (its log lines) and the last variables
  // bag it reported are kept with the job file, so a finished run can still
  // show its Logs and Variables tabs after the live stream is gone. Bounded:
  // RUN_LOG_CAP lines, each already sanitized and clipped.
  const RUN_LOG_CAP = 500;
  const runLog: Array<{ t: string; level: 'info' | 'warn' | 'error'; text: string }> = [];
  let runVariables: Record<string, unknown> | null = null;
  const runMeta = {
    origin,
    visibility: describeVisibility(headless),
    profile: profile.label,
    startedAt: new Date().toISOString(),
  };
  const log = (msg: string) => {
    const safe = sanitizeLogMessage(msg);
    console.log(`[JOB:${job.id}] ${safe}`);
    livePub.emit('log', { message: safe });
    const level = /\b(fail|error|exception)/i.test(safe) ? 'error'
      : /\b(warn|retry|skip|timeout)/i.test(safe) ? 'warn' : 'info';
    runLog.push({ t: new Date().toISOString(), level, text: safe.slice(0, 2000) });
    if (runLog.length > RUN_LOG_CAP) runLog.splice(0, runLog.length - RUN_LOG_CAP);
  };
  const runExtras = () => ({ runLog: runLog.slice(), variables: runVariables, runMeta });

  try {
    livePub.emit('job.start', { origin, visibility: describeVisibility(headless), profile: profile.label });
    log(`Started (${origin} run, ${describeVisibility(headless)} browser, profile "${profile.label}")`);

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
      headless,
      origin,
      profile,
      // Phase 2 Continue Session: proof of the lease + the run's owner.
      leaseToken,
      owner: runOwner,
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
      // Step 16: forward step-level live events from the pipeline.
      // Step 29: ALSO deliver per-step events to the job webhook URL
      // (channel 1 of two-channel live reporting) when enabled.
      onEvent: (type: string, data?: Record<string, unknown>) => {
        livePub.emit(type as Parameters<typeof livePub.emit>[0], data);
        if (type === 'step.done' && data && data.variables && typeof data.variables === 'object') {
          runVariables = data.variables as Record<string, unknown>;
        }
        if (type === 'step.done' && data && typeof data.index === 'number') {
          stepItems.set(data.index, {
            inputItemCount: data.inputItemCount,
            outputItemCount: data.outputItemCount,
            outputSample: data.outputSample,
          });
        }
        if (webhookUrl && config.STEP_WEBHOOK_ENABLED && shouldDeliverStepEvent(type)) {
          const stepPayload = buildStepWebhookPayload({ type, jobId: job.id!, userId, data });
          if (stepPayload) {
            // fire-and-forget; sendStepWebhook never throws into the pipeline.
            void sendStepWebhook(webhookUrl, stepPayload);
          }
        }
      }
    });

    runOutcome = 'success';
    livePub.emit('job.done', { durationMs: result.durationMs });
    log('Completed');
    connection.incr(STATS_KEY.TOTAL_SUCCESS).catch(() => {});

    const outputs = profileManager.getJobOutputs(job.id!);
    await persistJob(userId, job.id!, outputs, { ...result, ...runExtras(), success: true });
    recordExecution('success');
    await recordTestOutcome('success');

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

    runOutcome = outcomeOfError(error.message, cancelled);
    if (cancelled || error.message === 'CANCELLED_BY_USER') {
      livePub.emit('job.error', { reason: 'cancelled', message: error.message });
      log('Cancelled');

      await persistJob(userId, job.id!, outputs, {
        ...runExtras(),
        success: false,
        message: error.message,
        cancelledByUser: cancelled,
        userCancelled: cancelled
      });
      recordExecution('cancelled', error.message);
      await recordTestOutcome('cancelled', error.message);

      if (webhookUrl) {
        sendWebhook(webhookUrl, {
          event: 'job.cancelled',
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

      const entry = profileManager.getVipContext(profile.id);
      if (entry) {
        await entry.context.close().catch(() => {});
      }
      profileManager.removeVipContext(profile.id);
      browserSessionRegistry.closed(profile.id);
    }

    livePub.emit('job.error', { message: sanitizeLogMessage(error.message) });
    log(`Failed: ${sanitizeLogMessage(error.message)}`);

    await persistJob(userId, job.id!, outputs, {
      ...runExtras(),
      success: false,
      message: error.message
    });
    recordExecution('error', error.message);
    await recordTestOutcome('error', error.message);

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
    // 1. The BROWSER (core/BrowserLifecycle): the workflow's "after the run"
    //    policy, applied only when no one else depends on the browser. This
    //    is independent of the lease below: closing never releases a claim.
    const dep = jobDependent(String(job.id));
    try {
      let policy = afterRunPolicyOf(undefined);
      const wfId = job.data.__workflowId || job.data.__workspace?.workflowId || job.data.__scheduleWorkflowId;
      if (typeof wfId === 'string') {
        const owner = job.data.__workspace?.owner || userId;
        const wf = await new WorkflowService(workflowStoreFor(connection)).get(String(owner), wfId).catch(() => null);
        policy = afterRunPolicyOf(wf?.afterRun);
      }
      const r = await applyAfterRun({
        sessionId: profile.id, dependent: dep, policy, outcome: runOutcome,
        ownBrowser: profile.kind === 'run' || profile.kind === 'named',
        sessions: browserSessionRegistry, manager: profileManager,
        save: async (ctx) => {
          // Recoverable: tabs + storage are saved into the profile first.
          const saved = await saveBeforeClose(ctx as never, sessionDataDir(profile.id) || profile.userDataDir, 'after_run');
          if (saved) console.log(`[JOB:${job.id}] saved ${saved.tabs} tab(s) of profile "${profile.label}" for recovery`);
        },
        log: (m) => console.log(`[JOB:${job.id}] ${m} (profile "${profile.label}")`),
      });
      if (r.closed) console.log(`[JOB:${job.id}] closed the browser of profile "${profile.label}" after the run (${runOutcome}, setting ${policy})`);
    } catch (e) {
      console.warn(`[JOB:${job.id}] after-run browser policy failed: ${(e as Error).message}`);
    }
    // 2. The RESERVATION of a scheduled occurrence: settled at the REAL end
    //    of the run, so it keeps blocking until max(window end, now).
    if (leaseToken && occurrence && typeof job.data.__scheduleId === 'string') {
      await profileReservations.markSettled(profile.id, job.data.__scheduleId, occurrence, String(job.id)).catch((e: Error) => {
        console.warn(`[JOB:${job.id}] could not settle its reservation: ${e.message}`);
      });
    }
    runningJobs.delete(String(job.id));
    // 2b. A continued session (core/SessionContinuation): grants TO this
    //     run's workflow on this profile are consumed now that it ran.
    if (leaseToken) {
      await endContinuation({ leases: profileLeases, sessions: browserSessionRegistry }, profile.id, runOwner).catch(() => 0);
    }
    // 3. The LEASE, on EVERY exit path (success, failure, cancel). The
    // release is compare-and-delete on this run's token, so it can never free
    // a lease another run holds.
    if (leaseRefresh) clearInterval(leaseRefresh);
    if (leaseToken) {
      await profileLeases.release(profile.id, leaseToken).catch((e: Error) => {
        console.warn(`[JOB:${job.id}] could not release profile "${profile.id}": ${e.message}`);
      });
      profileManager.updateActivity(profile.id);
    }

    profileManager.clearJobOutputs(job.id!);
    profileManager.clearCancelFlag(job.id!);
    profileManager.unregisterPage(job.id!);
    await connection.srem(getUserActiveJobsKey(userId), job.id!).catch(() => {});
  }
}, {
  connection,
  // Not a run limit: runs are limited by their profiles (one run per
  // profile). This is only the in-process ceiling on simultaneous jobs.
  concurrency: config.WORKER_SLOTS,
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
    // Profile browsers are NOT collected by the legacy activity timer any
    // more: only sessions nobody depends on, after BROWSER_IDLE_CLOSE_MIN
    // (below). Everything else the collector does is unchanged.
    await profileManager.runGarbageCollector(config.GC_STALE_THRESHOLD_MINUTES, {
      beforeVipClose: (key, ctx) => saveBeforeClose(ctx, sessionDataDir(key), 'gc').then(() => undefined),
      mayCloseVip: (key) => browserSessionRegistry.canClose(key, '').ok && !runningJobs.has(profileManager.getVipContext(key)?.jobId || ''),
      onVipClosed: (key) => browserSessionRegistry.closed(key),
      idleMs: Math.max(0, config.BROWSER_IDLE_CLOSE_MIN) * 60_000,
    });
  } catch (e) {
    console.error('[GC] Error:', e);
  }
}, config.GC_CHECK_INTERVAL_MINUTES * 60 * 1000);

// Reservations follow the schedules and are settled from evidence; unused
// browsers are closed after the idle timeout. Every minute.
const profileSweep = setInterval(async () => {
  try {
    await sweepExpiredGrants({ leases: profileLeases, sessions: browserSessionRegistry }).catch(() => 0);
    await profileCoordinator.sweep((id) => runningJobs.has(id), async (sess) => {
      const entry = profileManager.getVipContext(sess.leaseId);
      if (entry) {
        await saveBeforeClose(entry.context, sessionDataDir(sess.leaseId), 'idle');
        await entry.context.close().catch(() => {});
      }
      profileManager.removeVipContext(sess.leaseId);
      browserSessionRegistry.closed(sess.leaseId);
      console.log(`[PROFILES] Closed the idle browser of profile "${sess.leaseId}"`);
    });
  } catch (e) {
    console.warn('[PROFILES] sweep failed:', (e as Error).message);
  }
}, 60_000);
if (typeof profileSweep.unref === 'function') profileSweep.unref();

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

    console.log('[SHUTDOWN] Closing Live Browser sessions...');
    if (browserStreamServer) await browserStreamServer.shutdown();
    // Drop agent tunnels and inspector sockets before the browser goes: a
    // client told the server is leaving reconnects, one left hanging does not.
    if (inspectorSockets) inspectorSockets.shutdown();
    localBridges.shutdown();
    if (liveServer) await liveServer.shutdown();

    console.log('[SHUTDOWN] Closing Global Browser...');
    await GlobalBrowser.shutdown();

    console.log('[SHUTDOWN] Closing Redis connection...');
    await connection.quit();

    try { closeSharedSqlite(); } catch { /* best-effort */ }

    console.log('[SHUTDOWN] Closing all browsers...');
    // Service restart is one of the close paths too: every profile browser's
    // tabs + storage are saved into its profile first (bounded, in parallel).
    await Promise.all(browserSessionRegistry.list().map((r) => {
      const entry = profileManager.getVipContext(r.leaseId);
      return entry ? saveBeforeClose(entry.context, sessionDataDir(r.leaseId), 'shutdown').catch(() => null) : null;
    }));
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

// ============================================
// FAULT CONTAINMENT (not blanket shutdown)
// ============================================
//
// REPORTED: "Remote Browser start fails -> the process/server/port terminates
// -> after refresh the whole project no longer comes up."
//
// The cause was here, and it was policy, not a bug in the browser code. Both
// last-resort handlers used to call shutdown() -> process.exit(0) for EVERY
// asynchronous fault in the process. A remote browser that would not launch,
// a websockify that was not listening yet, an operator closing the noVNC tab
// mid-stream: each of those is an ordinary, recoverable, request-scoped
// outcome, and each of them used to release the listening port.
//
// The required behaviour is:
//
//   Remote Browser start -> FAIL -> controlled error -> main app STAYS ALIVE
//
// So the handlers now ASK before they act. ProcessGuard.classifyFault() holds
// a closed list of faults known to be operational and locally scoped; those
// are logged (rate-limited, so a wedged desktop cannot fill the disk) and the
// server keeps serving. Anything unrecognised is still fatal, because a guard
// that swallows the unknown is how a half-dead process serves wrong answers.
const faultReporter = new FaultReporter();

process.on('uncaughtException', (err) => {
  const verdict = classifyFault(err);
  if (verdict.disposition === 'survive') {
    faultReporter.report(verdict, err);
    return;
  }
  console.error('[FATAL] Uncaught Exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  const verdict = classifyFault(reason);
  if (verdict.disposition === 'survive') {
    faultReporter.report(verdict, reason);
    return;
  }
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// ============================================
// START SERVER
// ============================================

const startServer = async () => {
  // FIRST, before anything expensive, and before the port is bound.
  //
  // Ordering is the entire value here. Redis connections, browser pools and Lua
  // scripts all take time and all produce their own errors, so a configuration
  // fault discovered after them arrives buried under unrelated noise — which is
  // exactly how "Real Chrome is disabled" ended up being the first and only
  // thing an operator learned about a four-part subsystem. Validating before
  // `app.listen` also means a fatally misconfigured instance never accepts a
  // request it cannot serve, instead of failing one caller at a time.
  //
  // It aborts ONLY on genuinely fatal configuration. A missing browser binary
  // or a downed display is reported in full and the server still starts, so the
  // dashboard and the job queue keep working and SelfHeal can repair the
  // browser at runtime. See StartupValidation for that distinction.
  await enforceStartupValidation();

  // Durable storage first: routes below read workflows through it, and the
  // one-time Redis -> SQLite import must finish before the first request.
  // Without its store the server must not start: serving requests from an
  // empty or different store would look like "all my workflows are gone".
  try {
    await initStorage(connection);
  } catch (e) {
    console.error(`[FATAL] [STORAGE] ${(e as Error).message}`);
    process.exit(1);
  }

  await cleanupSystem();
  // Leases of an earlier incarnation of this server cannot still be running
  // (their browser died with that process): free them before the worker runs.
  try {
    const rec = await profileCoordinator.recoverAtBoot();
    if (rec.leases.length) console.log(`[PROFILES] Released ${rec.leases.length} lease(s) left by a previous run of the server: ${rec.leases.join(', ')}`);
    if (rec.holds.length) console.log(`[PROFILES] Released ${rec.holds.length} manual hold(s) of a previous run of the server: ${rec.holds.join(', ')}`);
    if (rec.sessions.length) console.log(`[PROFILES] ${rec.sessions.length} browser session(s) of a previous run of the server are gone: ${rec.sessions.join(', ')}`);
    const sync = await profileCoordinator.syncReservations();
    if (sync.overlaps.length) {
      for (const o of sync.overlaps) console.warn(`[PROFILES] Schedules overlap on profile "${o.leaseId}": ${o.a.ownerName || o.a.owner} and ${o.b.ownerName || o.b.owner} (the later one waits).`);
    }
  } catch (e) {
    console.warn(`[PROFILES] Could not check for orphaned profile leases: ${(e as Error).message}`);
  }
  await GlobalBrowser.initialize();
  await initLuaScripts();

  const server = app.listen(config.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log(`║     🚀 AUTOMATION BACKEND v${config.VERSION} - MODULAR EDITION             ║`);
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log(`║  Port:              ${String(config.PORT).padEnd(47)}║`);
    // The PROFILE, not NODE_ENV. NODE_ENV is what tooling wrote; the profile is
    // what actually decides whether this box runs a headed browser that can
    // load extensions. Printing the weaker of the two was part of how a
    // container silently running headless went unnoticed. The source is shown
    // because "production (from NODE_ENV)" and "server (from APP_ENV)" are
    // different facts and only one of them was chosen deliberately.
    console.log(`║  Environment:       ${`${config.APP_PROFILE} (from ${config.APP_PROFILE_SOURCE})`.padEnd(47)}║`);
    console.log(`║  Remote Browser:    ${(config.REAL_CHROME_ENABLED
      ? (config.REAL_CHROME_HEADLESS ? '! headless — extensions OFF' : '✓ headed — extensions ON')
      : '✗ disabled').padEnd(47)}║`);
    console.log(`║  Runs:              ${'one per browser profile (queued when busy)'.padEnd(47)}║`);
    console.log(`║  Access:            ${(config.AUTH_OPEN ? 'no login (development, this machine)' : authStore.state() === 'set' ? 'owner password' : authStore.state() === 'unset' ? 'SETUP REQUIRED: open the panel' : 'auth file unusable').padEnd(47)}║`);
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

  // A LISTEN failure is fatal; a runtime socket error on an accepted
  // connection is not. The old handler exited on both, so a client that hung
  // up mid-response could free the port and take the whole app down with it.
  server.on('error', (err) => {
    const verdict = classifyFault(err);
    if (verdict.disposition === 'survive') {
      faultReporter.report(verdict, err);
      return;
    }
    console.error('[SERVER] Error:', err);
    process.exit(1);
  });

  // Errors on individual client sockets never reach the request handler, so
  // without this listener Node re-emits them as uncaughtException. Harmless
  // per-connection resets (a closed noVNC tab) are absorbed here.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    faultReporter.report(classifyFault(err), err);
    if (socket && !socket.destroyed) {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* already gone */ }
    }
  });

  // Step 16: attach the WebSocket live server to this HTTP server.
  liveServer = new LiveServer(liveBus, connection);
  liveServer.attach(server);
  console.log('[LIVE] WebSocket live channel ready at /live/ws (SSE fallback at /live/sse/:userId/:jobId)');

  // Step 12: interactive browser stream (separate upgrade path /browser/ws).
  browserStreamServer = new BrowserStreamServer(liveBrowserManager);
  browserStreamServer.attach(server);
  console.log('[LIVE] Interactive Live Browser View ready at /browser/ws');

  // The REAL Chrome desktop, served through THIS port.
  //
  // websockify listens on its own port (6080), which is unreachable whenever
  // the app is published through a single port — a sandbox URL, a PaaS, a
  // reverse proxy, or a one-port SSH tunnel. Mounting it at /desktop means the
  // operator never needs a second hostname to see the real browser.
  desktopProxy = new DesktopProxy();

  // The Element Inspector's push channel, and the tunnel a local browser agent
  // dials in on.
  inspectorSockets = new InspectorSocketServer();

  // ── ONE upgrade listener for three paths ──────────────────────────────────
  // Each of these servers exposes matches() and returns without destroying a
  // socket it does not recognise, so they can share a port. That is not
  // politeness: a listener that destroyed foreign upgrades would silently kill
  // /live/ws and /browser/ws, and the symptom would be 'the live view stopped
  // working when I installed the agent'.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url || '', 'http://localhost').pathname; }
    catch { return; }

    if (localBridges.matches(pathname)) {
      localBridges.handleUpgrade(req, socket, head);
      return;
    }
    if (inspectorSockets && inspectorSockets.matches(pathname)) {
      inspectorSockets.handleUpgrade(req, socket, head);
      return;
    }
    if (desktopProxy && desktopProxy.matches(pathname)) {
      desktopProxy.handleUpgrade(req, socket, head);
      return;
    }
    // Not ours: LiveServer and BrowserStreamServer have their own listeners.
  });

  // A dropped agent must also drop the Playwright attachment built on top of
  // it, or the next node would be handed a handle to a browser that is gone.
  localBridges.onChange((userId, connected) => {
    if (!connected) onLocalBridgeLost(userId);
  });
  console.log('[LIVE] Real Chrome desktop proxied at /desktop/vnc.html');
  console.log('[LIVE] Element Inspector channel ready at /inspector/ws');
  console.log(`[LIVE] Local Browser agents may connect at ${agentConnectPath()}` + (config.LOCAL_BROWSER_ENABLED ? '' : ' (disabled by LOCAL_BROWSER_ENABLED=false)'));

  return server;
};

const server = startServer();

export { app, server, queue, connection, profileManager, profileLeases, liveBus, profileAccessService, profileCoordinator };