import { Router } from 'express';
import type IORedis from 'ioredis';
import type { ProfileManager } from '../core/ProfileManager';
import { GlobalBrowser } from '../core/GlobalBrowser';
import { config } from '../config';

interface HealthRoutesDeps {
  connection: IORedis;
  profileManager: ProfileManager;
  luaScriptsLoaded: () => boolean;
}

export const createHealthRoutes = (deps: HealthRoutesDeps): Router => {
  const router = Router();
  const { connection, profileManager, luaScriptsLoaded } = deps;

  router.get('/health', async (_req, res) => {
    let redisStatus = 'disconnected';
    try {
      await connection.ping();
      redisStatus = 'connected';
    } catch {}

    const globalBrowserStatus = GlobalBrowser.getHealthStatus();

    res.json({
      status: 'ok',
      version: config.VERSION,
      // The editor status bar shows an `Environment` cell. It used to render a
      // hardcoded "Development" string, which is exactly the fake-successful UI
      // the house rules forbid: on a production box the bar would have lied.
      // These two fields are the ONLY source that cell is allowed to read, and
      // when they are absent the cell renders `—` instead of guessing.
      env: config.NODE_ENV,
      // The PROFILE is what actually decides behaviour; NODE_ENV is only what
      // tooling happened to write. Both are reported because they can disagree
      // (a container may be NODE_ENV=production and APP_ENV=server), and that
      // disagreement is deliberate and worth being able to see.
      profile: config.APP_PROFILE,
      profileSource: config.APP_PROFILE_SOURCE,
      mode: config.DEPLOYMENT_MODE,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      redis: redisStatus,
      luaScripts: luaScriptsLoaded() ? 'loaded' : 'fallback',
      browsers: {
        vip: profileManager.getVipBrowserCount(),
        free: profileManager.getFreeContextCount(),
        total: profileManager.getActiveBrowserCount(),
        registeredPages: profileManager.getRegisteredPageCount(),
        globalBrowser: globalBrowserStatus
      },
      features: {
        flattenerEnabled: config.FREE_FLATTENER_ENABLED,
        resourceBlocking: config.FREE_RESOURCE_BLOCKING,
        turboMode: config.TURBO_MODE,
        webhookRetries: config.WEBHOOK_MAX_RETRIES,
        freeForceSequential: config.FREE_FORCE_SEQUENTIAL,
        planOverrides: true,
        unifiedUserManagement: true
      }
    });
  });

  /**
   * Can the Remote Browser actually run, and if not, exactly what is missing?
   *
   * SEPARATE FROM /health ON PURPOSE. `/health` is hit by the container
   * healthcheck every 30 seconds and must stay cheap; this runs `ldd` and
   * `chrome --version`, which are far too slow for that budget. Putting them
   * together would either make the healthcheck expensive or make this check
   * too shallow to be worth having.
   *
   * The status code is the API: 200 = ready, 503 = a prerequisite is missing.
   * That makes it usable as a readiness probe (as opposed to a liveness probe)
   * for anyone who wants the browser proven before traffic arrives — while
   * `/health` keeps reporting the PROCESS as alive, which it is.
   *
   * Deliberately unauthenticated, like /health: it returns no secrets, only
   * paths and library names, and a probe that needs a token is a probe that
   * gets disabled.
   */
  router.get('/health/browser', async (_req, res) => {
    // Imported here rather than at module load: this pulls in the browser
    // inspection code, and /health must not pay for it.
    const { inspectBrowserRuntime } = await import('../core/BrowserRuntime');
    const report = await inspectBrowserRuntime();
    res.status(report.ok ? 200 : 503).json({
      ready: report.ok,
      degraded: report.degraded,
      profile: config.APP_PROFILE,
      executable: report.executablePath,
      executableSource: report.executableSource,
      version: report.version,
      headless: report.headless,
      display: report.display,
      missingLibraries: report.missingLibraries,
      // Every check with its own fix, so an operator reading a 503 in a log
      // aggregator has the remedy in the same payload as the symptom.
      checks: report.checks,
    });
  });

  return router;
};