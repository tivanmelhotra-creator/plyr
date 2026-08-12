import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { ProfileManager } from '../core/ProfileManager';
import type { QuotaManager } from '../core/QuotaManager';

import { createHealthRoutes } from './health.routes';
import { createUserRoutes } from './user.routes';
import { createAdminRoutes } from './admin.routes';
import { createBrowserRoutes } from './browser.routes';
import { createModeRoutes } from './mode.routes';

interface RoutesDeps {
  queue: Queue;
  connection: IORedis;
  profileManager: ProfileManager;
  quotaManager: QuotaManager;
  luaScriptsLoaded: () => boolean;
  reloadLuaScripts: () => Promise<void>;
}

export const createAllRoutes = (deps: RoutesDeps) => {
  return {
    health: createHealthRoutes({
      connection: deps.connection,
      profileManager: deps.profileManager,
      luaScriptsLoaded: deps.luaScriptsLoaded
    }),
    user: createUserRoutes({
      queue: deps.queue,
      connection: deps.connection,
      profileManager: deps.profileManager,
      quotaManager: deps.quotaManager
    }),
    // Real Chrome / extensions / cookies / remote desktop. No deps: it talks
    // to process-level singletons (RealChrome, Desktop) rather than to Redis.
    browser: createBrowserRoutes(),
    // Browser mode switch (remote/local) + the Element Inspector's endpoints.
    // No deps for the same reason as browser: it talks to process-level
    // singletons (browserModes, localBridges, inspectorHub), because what they
    // describe — live sockets — only exists inside this process.
    mode: createModeRoutes(),
    admin: createAdminRoutes({
      queue: deps.queue,
      connection: deps.connection,
      profileManager: deps.profileManager,
      quotaManager: deps.quotaManager,
      luaScriptsLoaded: deps.luaScriptsLoaded,
      reloadLuaScripts: deps.reloadLuaScripts
    })
  };
};

export { createHealthRoutes } from './health.routes';
export { createUserRoutes } from './user.routes';
export { createAdminRoutes } from './admin.routes';
export { createBrowserRoutes } from './browser.routes';
export { createModeRoutes } from './mode.routes';