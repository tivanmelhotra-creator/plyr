/**
 * ProfileBrowser — open / close the live browser of ONE profile by hand.
 *
 * The SAME persistent context the runs use (ProfileManager's per-profile map,
 * keyed by the lease id), so an operator's browser and a later run on the same
 * profile are one browser, never two processes fighting for one user-data-dir.
 * Opened VISIBLE on the shared X desktop and shown through the ONE shared
 * viewer (/desktop/chrome): no second mechanism.
 *
 * Opening is idempotent: concurrent opens of one profile share one launch
 * (`starting`), and an open browser is reused. Every launch / close updates
 * core/BrowserSessions. A visibility mismatch (a hidden automatic run's
 * browser) is NOT silently relaunched under a dependent: the caller is told.
 *
 * LAUNCH SETTINGS (core/LaunchSettings) are validated by the caller and given
 * here as the final argv + its hash. They decide HOW the process starts, never
 * which data: the user-data-dir is always the profile's own. A running browser
 * started with different settings is relaunched only when nobody else depends
 * on it (state saved first); otherwise the caller is told why.
 *
 * DISPLAY NAME. Before each launch the profile's registry name is written into
 * Chromium's own profile data (core/ChromiumProfileName), so the window, the
 * avatar menu and Task View show "22" instead of "Your Chromium".
 *
 * DATA SELECTION. Same rule as the Local Browser (core/ChromiumProfileLocation):
 * the profile's user-data root plus its pinned `--profile-directory`, so the
 * data Chromium opens never depends on Chromium's own `last_used`.
 */
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { config } from '../config';
import type { ProfileManager } from './ProfileManager';
import { browserSessions, operatorDependent, setSessionDataDir, sessionDataDir, setRunningProfile, runningProfileOf } from './BrowserSessions';
import { saveBeforeClose } from './BrowserStateSnapshot';
import { withUtf8Locale, IGNORED_DEFAULT_ARGS } from './BrowserProfile';
import { listExtensions, extensionLaunchArgs } from './ChromeExtensions';
import { seedInspectorExtension } from './InspectorExtension';
import { Desktop } from './Desktop';
import { buildLaunchArgs } from './LaunchSettings';
import { buildKey, getBuild, setBuild, forgetBuild } from './ProfileBuild';
import { applyChromiumProfileName, applyChromiumProfileLook } from './ChromiumProfileName';
import { resolveChromiumProfile, withProfileSelection, verifyProfileSelected } from './ChromiumProfileLocation';
import { closeContextBounded } from './SharedBrowsers';

export class ProfileBrowserError extends Error {
  constructor(message: string, readonly code: 'in_use_hidden' | 'in_use_settings' | 'launch_failed' | 'branch_busy',
    /** For branch_busy: the profile of the branch that is running now. */
    readonly runningProfileId?: string) {
    super(message);
    this.name = 'ProfileBrowserError';
  }
}

const starting = new Map<string, Promise<BrowserContext>>();

/** Injectable launcher (tests replace it; production launches Chromium). `args` = validated launch settings. */
export type Launcher = (userDataDir: string, args: string[]) => Promise<BrowserContext>;

/** The Standard preset: exactly the arguments this launcher always used. */
export const STANDARD_LAUNCH = buildLaunchArgs({});

export const defaultLauncher: Launcher = async (userDataDir, args) => {
  await Desktop.ensureDisplay().catch(() => { /* the launch error says what is missing */ });
  return chromium.launchPersistentContext(userDataDir, {
    // Always visible: a browser opened by hand is opened to be seen. Not
    // settable by a flag (core/LaunchSettings refuses --headless).
    headless: false,
    viewport: null,
    timeout: config.BROWSER_LAUNCH_TIMEOUT_MS,
    ...(config.CHROME_EXE ? { executablePath: config.CHROME_EXE } : {}),
    // An ARRAY handed to execve by Playwright: no shell ever sees it.
    args,
    // Same as the Local Browser (core/RealChrome): Playwright's default
    // --disable-extensions would make --load-extension a silent no-op, so the
    // project extension never reached a profile browser.
    ignoreDefaultArgs: [...IGNORED_DEFAULT_ARGS],
    env: withUtf8Locale(process.env),
  });
};

/**
 * The project's extensions for a profile browser: the shipped Element
 * Inspector is seeded into the extensions dir (as the Local Browser does) and
 * everything there is loaded. Never blocks a launch: on failure the profile
 * opens without extensions and the reason is logged.
 */
export async function projectExtensionArgs(extensionsDir = config.REAL_CHROME_EXTENSIONS_DIR): Promise<string[]> {
  try {
    const seeded = await seedInspectorExtension(extensionsDir);
    if (seeded.reason === 'failed') console.warn(`[PROFILES] Inspector extension not seeded: ${(seeded as { error?: string }).error || 'unknown'}`);
    return extensionLaunchArgs(await listExtensions(extensionsDir));
  } catch (e) {
    console.warn(`[PROFILES] extensions not loaded: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Pure check of the branch launch rule: `root` must not be the profile folder
 * itself (nor end in it), and `folder` must be a plain directory name.
 * Throws a launch_failed ProfileBrowserError otherwise.
 */
export function assertBranchLaunch(root: string, folder: string): void {
  const r = path.resolve(root);
  if (!folder || folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') {
    throw new ProfileBrowserError(`Invalid profile folder "${String(folder).slice(0, 80)}".`, 'launch_failed');
  }
  if (path.basename(r) === folder) {
    throw new ProfileBrowserError(`Refusing to launch: the data directory "${path.basename(r)}" is the profile folder itself, not its branch root.`, 'launch_failed');
  }
}

/**
 * Open a SECOND profile of a branch whose browser is running (owner brief 2 /
 * G.2): a plain Chromium invocation on the same root with this profile's
 * --profile-directory. Chromium forwards it into the running process (measured,
 * S36 G.1) and the invocation exits 0 at once. Injectable for tests.
 */
export type ForwardLauncher = (root: string, folder: string) => Promise<{ code: number | null; stderr: string }>;
export const defaultForwardLauncher: ForwardLauncher = async (root, folder) => {
  const { spawn } = await import('child_process');
  const exe = config.CHROME_EXE || chromium.executablePath();
  return new Promise((resolve) => {
    // An argv ARRAY (no shell). --no-sandbox only when the running browser was
    // started with it (container/root); otherwise Chromium keeps its sandbox.
    const args = [`--user-data-dir=${root}`, `--profile-directory=${folder}`, '--no-first-run', '--no-default-browser-check'];
    if (process.getuid?.() === 0 || process.env.PLYR_CHROME_NO_SANDBOX === '1' || process.env.CI) args.push('--no-sandbox');
    args.push('about:blank');
    const c = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], env: withUtf8Locale(process.env), detached: false });
    let err = '';
    c.stderr?.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve({ code: null, stderr: err }); }, 15_000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr: err }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stderr: String(e.message) }); });
  });
};
let forwardLauncher: ForwardLauncher = defaultForwardLauncher;
export function setForwardLauncherForTests(l: ForwardLauncher | null): void { forwardLauncher = l || defaultForwardLauncher; }

/**
 * Launch `profileId` (folder `folder`) by hand INSIDE the running browser of
 * its branch. Manual-only (core/ManualProfiles): never leased, never a session
 * of its own, never used by automation. The caller has checked the owner's
 * explicit confirmation (G.2: hold-to-confirm, valid for this one launch).
 */
export async function openManualProfile(pm: ProfileManager, input: { leaseId: string; root: string; folder: string; profileId: string }): Promise<{ windowOpened: boolean }> {
  const { markManualOpen, learnManualContext, forgetManual } = await import('./ManualProfiles');
  const entry = pm.getVipContext(input.leaseId);
  if (!entry) throw new ProfileBrowserError('The browser of this branch is not running any more. Press Play again to open this profile normally.', 'launch_failed');
  // Local State belongs to the RUNNING process now: it is not written here
  // (Chromium would overwrite it on exit). The display name / look are applied
  // at this profile's next normal launch.
  markManualOpen(input.leaseId, input.profileId, input.folder);
  const r = await forwardLauncher(input.root, input.folder);
  if (r.code !== 0) {
    forgetManual(input.leaseId, input.profileId);
    const line = r.stderr.split('\n').find((l) => /ERROR/.test(l)) || '';
    throw new ProfileBrowserError(`Chromium did not open this profile next to the running one (exit ${r.code ?? 'timeout'})${line ? `: ${line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 160)}` : ''}.`, 'launch_failed');
  }
  const ctxId = await learnManualContext(input.leaseId, input.profileId, entry.context);
  return { windowOpened: !!ctxId };
}

let launcher: Launcher = defaultLauncher;
export function setProfileLauncherForTests(l: Launcher | null): void { launcher = l || defaultLauncher; }

/**
 * Open (or reuse) the visible browser of a profile for workflow `owner`.
 * The caller has ALREADY taken the operator hold (ProfileLeases.hold).
 */
export async function openProfileBrowser(pm: ProfileManager, input: {
  leaseId: string; userId: string; userDataDir: string; owner: string;
  /** Chromium --profile-directory inside the branch root (core/BranchRegistry). */
  profileDirectory?: string;
  /** Registry profile id: recorded as the RUNNING profile of the branch. */
  profileId?: string;
  /** Registry display name, written into Chromium's profile data before launch. */
  displayName?: string;
  /** Validated launch settings (core/LaunchSettings). Absent = Standard, and an open browser is reused as it is. */
  launch?: { args: string[]; hash: string; explicit: boolean };
}): Promise<{ reused: boolean; visibility: 'visible' | 'hidden'; relaunched?: boolean; launchHash: string; settingsApplied: boolean }> {
  const sessions = browserSessions();
  const dep = operatorDependent(input.owner);
  const launch = input.launch || { args: STANDARD_LAUNCH.args, hash: STANDARD_LAUNCH.hash, explicit: false };
  const wantKey = buildKey({ headless: false, launchHash: launch.hash });
  let relaunched = false;
  const existing = pm.getVipContext(input.leaseId);
  if (existing) {
    let alive = true;
    try { existing.context.pages(); } catch { alive = false; }
    // ONE running profile per branch. Another profile of the same branch is
    // running: never launch a second Chromium on the root, never switch the
    // running one under its users. The caller names it and offers to show it.
    const running = runningProfileOf(input.leaseId);
    if (alive && input.profileId && running && running !== input.profileId) {
      throw new ProfileBrowserError('Another profile of this branch is running.', 'branch_busy', running);
    }
    const rec = sessions.get(input.leaseId);
    const built = getBuild(input.leaseId);
    // The operator asked for specific launch settings and the running browser
    // was started otherwise (or by a run, whose build we know): relaunch, but
    // never under another dependent.
    const settingsDiffer = alive && rec && rec.visibility !== 'hidden' && launch.explicit
      && (!built || !built.endsWith(`|launch=${launch.hash}`));
    if (settingsDiffer) {
      const d = sessions.canClose(input.leaseId, dep);
      if (!d.ok && d.reason === 'in_use') {
        throw new ProfileBrowserError('This profile\'s browser is already open and in use (a run or another view), so it cannot be restarted with other launch settings now. Open it without changing the settings, or close it when it is free.', 'in_use_settings');
      }
      await saveBeforeClose(existing.context, sessionDataDir(input.leaseId) || input.userDataDir, 'relaunch');
      await closeContextBounded(existing.context);
      pm.removeVipContext(input.leaseId);
      sessions.closed(input.leaseId);
      forgetBuild(input.leaseId);
      relaunched = true;
    } else if (alive && rec && rec.visibility === 'hidden') {
      // A hidden browser cannot be shown. Relaunch it visible only when nobody
      // else depends on it; otherwise say why.
      const d = sessions.canClose(input.leaseId, dep);
      if (!d.ok && d.reason === 'in_use') {
        throw new ProfileBrowserError('This profile\'s browser is running hidden for a run right now; open it again when the run has finished.', 'in_use_hidden');
      }
      await saveBeforeClose(existing.context, sessionDataDir(input.leaseId) || input.userDataDir, 'relaunch');
      await closeContextBounded(existing.context);
      pm.removeVipContext(input.leaseId);
      sessions.closed(input.leaseId);
      forgetBuild(input.leaseId);
      relaunched = true;
    } else if (alive) {
      if (!rec) sessions.opened(input.leaseId, { userId: input.userId, visibility: 'visible', createdBy: dep });
      sessions.attach(input.leaseId, dep);
      pm.updateActivity(input.leaseId);
      const b = getBuild(input.leaseId) || '';
      return { reused: true, visibility: rec?.visibility || 'visible', launchHash: b.split('|launch=')[1] || '', settingsApplied: !launch.explicit || b.endsWith(`|launch=${launch.hash}`) };
    } else {
      pm.removeVipContext(input.leaseId);
      sessions.closed(input.leaseId);
    }
  }

  // Branch model guard (before anything is created on disk): the root is the
  // BRANCH root and the folder is selected with --profile-directory. A root
  // that IS the profile folder (<root>/<folder> passed as --user-data-dir)
  // would make Chromium create a nested profile inside the profile's data.
  if (input.profileDirectory) assertBranchLaunch(input.userDataDir, input.profileDirectory);

  let p = starting.get(input.leaseId);
  if (!p) {
    p = (async () => {
      await fs.promises.mkdir(input.userDataDir, { recursive: true });
      // Explicit folder = registry profile: Local State and the pin file are
      // not read (core/ChromiumProfileLocation 'registry' source).
      const loc = await resolveChromiumProfile(input.userDataDir, input.profileDirectory);
      if (input.displayName) {
        const named = await applyChromiumProfileName(loc.userDataRoot, input.displayName, loc.profileDirectory);
        if (!named.ok) console.warn(`[PROFILES] Chromium display name not set for ${input.leaseId}: ${named.skipped || 'unknown'}`);
      }
      // A registry profile (explicit folder) gets its own icon + color.
      if (input.profileDirectory) {
        const look = await applyChromiumProfileLook(loc.userDataRoot, loc.profileDirectory);
        if (!look.ok) console.warn(`[PROFILES] Chromium profile look not set for ${input.leaseId}: ${look.skipped || 'unknown'}`);
      }
      const ctx = await launcher(loc.userDataRoot, withProfileSelection([...(await projectExtensionArgs()), ...launch.args], loc));
      if (!(await verifyProfileSelected(loc))) console.warn(`[PROFILES] ${input.leaseId}: expected Chromium profile path ${loc.profilePath} was not created`);
      if (!ctx.pages().length) await ctx.newPage().catch(() => null);
      pm.setVipContext(input.leaseId, ctx, `operator:${input.owner}`);
      sessions.opened(input.leaseId, { userId: input.userId, visibility: 'visible', createdBy: dep });
      // Per-profile state (tab snapshots) lives in the profile's OWN folder.
      setSessionDataDir(input.leaseId, loc.profilePath);
      setRunningProfile(input.leaseId, input.profileId || null);
      setBuild(input.leaseId, wantKey);
      ctx.on('close', () => {
        if (pm.getVipContext(input.leaseId)?.context === ctx) { pm.removeVipContext(input.leaseId); forgetBuild(input.leaseId); }
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
  return { reused: false, visibility: 'visible', relaunched, launchHash: launch.hash, settingsApplied: true };
}

/**
 * Close the browser of a profile for `requester`. Refused while anyone else
 * depends on it (a run, another operator view). NEVER releases the hold.
 */
export async function closeProfileBrowser(pm: ProfileManager, leaseId: string, requester: string):
  Promise<{ closed: boolean; reason?: 'in_use' | 'not_open'; dependents?: string[]; timedOut?: boolean }> {
  const sessions = browserSessions();
  const entry = pm.getVipContext(leaseId);
  if (!entry) { sessions.closed(leaseId); return { closed: false, reason: 'not_open' }; }
  const d = sessions.canClose(leaseId, requester);
  if (!d.ok && d.reason === 'in_use') return { closed: false, reason: 'in_use', dependents: d.dependents };
  // Recoverable: tabs + storage are saved into the profile before it closes.
  await saveBeforeClose(entry.context, sessionDataDir(leaseId), 'operator');
  // Bounded: a context whose close never returns (wedged renderer) is
  // abandoned rather than holding the request — and the UI — forever.
  const r = await closeContextBounded(entry.context);
  pm.removeVipContext(leaseId);
  sessions.closed(leaseId);
  forgetBuild(leaseId);
  return { closed: true, ...(r.timedOut ? { timedOut: true } : {}) };
}
