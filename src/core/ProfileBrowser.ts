/**
 * ProfileBrowser — open / close the live browser of ONE profile by hand.
 *
 * The SAME persistent context the runs use (ProfileManager's per-profile map,
 * keyed by the lease id), so an operator's browser and a later run on the same
 * profile are one browser, never two processes fighting for one user-data-dir.
 * Opened VISIBLE on the existing X desktop and shown through the existing
 * remote view (/desktop/chrome?profile=<id>): no new viewer, no second
 * mechanism.
 *
 * Opening is idempotent: concurrent opens of one profile share one launch
 * (`starting`), and an open browser is reused. Every launch / close updates
 * core/BrowserSessions. A visibility mismatch (a hidden automatic run's
 * browser) is NOT silently relaunched under a dependent: the caller is told.
 */
import fs from 'fs';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { config } from '../config';
import type { ProfileManager } from './ProfileManager';
import { browserSessions, operatorDependent, setSessionDataDir, sessionDataDir } from './BrowserSessions';
import { saveBeforeClose } from './BrowserStateSnapshot';
import { withUtf8Locale } from './BrowserProfile';
import { Desktop } from './Desktop';

export class ProfileBrowserError extends Error {
  constructor(message: string, readonly code: 'in_use_hidden' | 'launch_failed') {
    super(message);
    this.name = 'ProfileBrowserError';
  }
}

const starting = new Map<string, Promise<BrowserContext>>();

/** Injectable launcher (tests replace it; production launches Chromium). */
export type Launcher = (userDataDir: string) => Promise<BrowserContext>;

export const defaultLauncher: Launcher = async (userDataDir) => {
  await Desktop.ensureDisplay().catch(() => { /* the launch error says what is missing */ });
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    timeout: config.BROWSER_LAUNCH_TIMEOUT_MS,
    ...(config.CHROME_EXE ? { executablePath: config.CHROME_EXE } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
    env: withUtf8Locale(process.env),
  });
};

let launcher: Launcher = defaultLauncher;
export function setProfileLauncherForTests(l: Launcher | null): void { launcher = l || defaultLauncher; }

/**
 * Open (or reuse) the visible browser of a profile for workflow `owner`.
 * The caller has ALREADY taken the operator hold (ProfileLeases.hold).
 */
export async function openProfileBrowser(pm: ProfileManager, input: {
  leaseId: string; userId: string; userDataDir: string; owner: string;
}): Promise<{ reused: boolean; visibility: 'visible' | 'hidden' }> {
  const sessions = browserSessions();
  const dep = operatorDependent(input.owner);
  const existing = pm.getVipContext(input.leaseId);
  if (existing) {
    let alive = true;
    try { existing.context.pages(); } catch { alive = false; }
    const rec = sessions.get(input.leaseId);
    if (alive && rec && rec.visibility === 'hidden') {
      // A hidden browser cannot be shown. Relaunch it visible only when nobody
      // else depends on it; otherwise say why.
      const d = sessions.canClose(input.leaseId, dep);
      if (!d.ok && d.reason === 'in_use') {
        throw new ProfileBrowserError('This profile\'s browser is running hidden for a run right now; open it again when the run has finished.', 'in_use_hidden');
      }
      await saveBeforeClose(existing.context, sessionDataDir(input.leaseId) || input.userDataDir, 'relaunch');
      await existing.context.close().catch(() => {});
      pm.removeVipContext(input.leaseId);
      sessions.closed(input.leaseId);
    } else if (alive) {
      if (!rec) sessions.opened(input.leaseId, { userId: input.userId, visibility: 'visible', createdBy: dep });
      sessions.attach(input.leaseId, dep);
      pm.updateActivity(input.leaseId);
      return { reused: true, visibility: rec?.visibility || 'visible' };
    } else {
      pm.removeVipContext(input.leaseId);
      sessions.closed(input.leaseId);
    }
  }

  let p = starting.get(input.leaseId);
  if (!p) {
    p = (async () => {
      await fs.promises.mkdir(input.userDataDir, { recursive: true });
      const ctx = await launcher(input.userDataDir);
      if (!ctx.pages().length) await ctx.newPage().catch(() => null);
      pm.setVipContext(input.leaseId, ctx, `operator:${input.owner}`);
      sessions.opened(input.leaseId, { userId: input.userId, visibility: 'visible', createdBy: dep });
      setSessionDataDir(input.leaseId, input.userDataDir);
      ctx.on('close', () => {
        if (pm.getVipContext(input.leaseId)?.context === ctx) pm.removeVipContext(input.leaseId);
        if (!pm.getVipContext(input.leaseId)) sessions.closed(input.leaseId);
      });
      return ctx;
    })().finally(() => starting.delete(input.leaseId));
    starting.set(input.leaseId, p);
  }
  try {
    await p;
  } catch (e) {
    throw new ProfileBrowserError(`Could not start the browser: ${(e as Error).message.split('\n')[0]}`, 'launch_failed');
  }
  sessions.attach(input.leaseId, dep);
  return { reused: false, visibility: 'visible' };
}

/**
 * Close the browser of a profile for `requester`. Refused while anyone else
 * depends on it (a run, another operator view). NEVER releases the hold.
 */
export async function closeProfileBrowser(pm: ProfileManager, leaseId: string, requester: string):
  Promise<{ closed: boolean; reason?: 'in_use' | 'not_open'; dependents?: string[] }> {
  const sessions = browserSessions();
  const entry = pm.getVipContext(leaseId);
  if (!entry) { sessions.closed(leaseId); return { closed: false, reason: 'not_open' }; }
  const d = sessions.canClose(leaseId, requester);
  if (!d.ok && d.reason === 'in_use') return { closed: false, reason: 'in_use', dependents: d.dependents };
  // Recoverable: tabs + storage are saved into the profile before it closes.
  await saveBeforeClose(entry.context, sessionDataDir(leaseId), 'operator');
  await entry.context.close().catch(() => {});
  pm.removeVipContext(leaseId);
  sessions.closed(leaseId);
  return { closed: true };
}
