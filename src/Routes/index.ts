import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { ProfileManager } from '../core/ProfileManager';
import type { ProfileLeases } from '../core/ProfileLease';
import type { ProfileAccess } from '../core/ProfileAccess';
import type { ProfileCoordinator } from '../core/ProfileCoordinator';
import { createProfileRoutes } from './profile.routes';

import { createHealthRoutes } from './health.routes';
import { createUserRoutes } from './user.routes';
import { createBrowserRoutes } from './browser.routes';
import { createModeRoutes } from './mode.routes';
import { createWorkflowFilesRoutes } from './workflow-files.routes';

interface RoutesDeps {
  queue: Queue;
  connection: IORedis;
  profileManager: ProfileManager;
  profileLeases?: ProfileLeases;
  profileAccess?: ProfileAccess;
  profileCoordinator?: ProfileCoordinator;
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
      profileLeases: deps.profileLeases,
      profileCoordinator: deps.profileCoordinator,
    }),
    // Browser profiles: the one registry every surface uses (list / create /
    // rename / delete / open / close / release). See Routes/profile.routes.ts.
    profiles: deps.profileAccess
      ? createProfileRoutes({ connection: deps.connection, access: deps.profileAccess, profileManager: deps.profileManager, schedules: deps.profileCoordinator })
      : null,
    // Real Chrome / extensions / cookies / remote desktop. No deps: it talks
    // to process-level singletons (RealChrome, Desktop) rather than to Redis.
    browser: createBrowserRoutes(),
    // Browser mode switch (remote/local) + the Element Inspector's endpoints.
    // No deps for the same reason as browser: it talks to process-level
    // singletons (browserModes, localBridges, inspectorHub), because what they
    // describe — live sockets — only exists inside this process.
    mode: createModeRoutes(),
    // Workflow File Workspace: persistent per-workflow files, and the bridge
    // that hands a selected file to the browser's waiting file dialog. Needs
    // Redis to confirm the workflow belongs to the caller before any disk I/O.
    workflowFiles: createWorkflowFilesRoutes({ connection: deps.connection })
  };
};

export { createHealthRoutes } from './health.routes';
export { createUserRoutes } from './user.routes';

export { createBrowserRoutes } from './browser.routes';
export { createModeRoutes } from './mode.routes';
export { createWorkflowFilesRoutes } from './workflow-files.routes';
export { createProfileRoutes } from './profile.routes';