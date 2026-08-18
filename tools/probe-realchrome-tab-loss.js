/**
 * probe-realchrome-tab-loss.js — MEASURE the operator's §3.2 report.
 *
 *   «وقتی وبگردی میکردم هنگ کرد و بعدش دیگه فریز شد منم بستم مجدد باز کنم کلا
 *    نرفت به اون ادرس … بعد این خطا ظاهرا کرش میکنه و موقعی که مجدد میزنم یکی
 *    جدید بالا میاره که همه تب ها گم شدن یا بسته شدن با همون مرورگر کرش شده»
 *
 * i.e. a wedged Chromium was killed, and the browser that came up next had NO
 * tabs. The original bug report §3.2 names `clearCrashedExitState()` as the
 * prime suspect (wiping the crash flag is what would DISCARD the previous tabs)
 * and forbids guessing. This script decides it by experiment, on the same
 * launch path RealChrome uses.
 *
 * ONE SCENARIO PER PROCESS, on purpose. The box has 985 MB and an earlier
 * all-in-one version of this probe left four Chromiums resident and froze the
 * sandbox twice. Each run launches, measures, and kills its own tree.
 *
 *   node tools/probe-realchrome-tab-loss.js clean     # close cleanly, reopen
 *   node tools/probe-realchrome-tab-loss.js crash     # SIGKILL, wipe, reopen
 *   node tools/probe-realchrome-tab-loss.js nowipe    # SIGKILL, NO wipe, reopen
 *   node tools/probe-realchrome-tab-loss.js restore   # SIGKILL, wipe, ask Chrome to restore
 *   node tools/probe-realchrome-tab-loss.js prefs     # what Chrome writes to the profile
 *   node tools/probe-realchrome-tab-loss.js all       # each of the above, in sequence
 */
'use strict';

const { chromium } = require('playwright');
const { promises: fs } = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const URLS = [
  'data:text/html,<title>ONE</title><h1>one</h1>',
  'data:text/html,<title>TWO</title><h1>two</h1>',
  'data:text/html,<title>THREE</title><h1>three</h1>',
];

// ── helpers ────────────────────────────────────────────────────────────────

/** Mirrors src/core/RealChrome.ts clearCrashedExitState(). */
async function clearCrashedExitState(userDataDir) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  try {
    const raw = await fs.readFile(prefsPath, 'utf8');
    const prefs = JSON.parse(raw);
    const profile = prefs.profile;
    if (!profile) return 'no profile key';
    if (profile.exit_type === 'Normal' && profile.exited_cleanly === true) return 'already clean';
    const was = String(profile.exit_type);
    profile.exit_type = 'Normal';
    profile.exited_cleanly = true;
    const tmp = `${prefsPath}.abtmp`;
    await fs.writeFile(tmp, JSON.stringify(prefs), 'utf8');
    await fs.rename(tmp, prefsPath);
    return `rewrote exit_type ${was} -> Normal`;
  } catch (e) {
    return `nothing to clear (${e.code || e.message})`;
  }
}

async function readExitState(userDataDir) {
  try {
    const raw = await fs.readFile(path.join(userDataDir, 'Default', 'Preferences'), 'utf8');
    const p = JSON.parse(raw).profile || {};
    return { exit_type: p.exit_type, exited_cleanly: p.exited_cleanly };
  } catch (e) {
    return { error: e.code || e.message };
  }
}

/** `session.restore_on_startup` — 1 = new tab page, 4 = URL list, 5 = last session. */
async function readStartupPref(userDataDir) {
  try {
    const raw = await fs.readFile(path.join(userDataDir, 'Default', 'Preferences'), 'utf8');
    const s = JSON.parse(raw).session || {};
    return { restore_on_startup: s.restore_on_startup, startup_urls: s.startup_urls };
  } catch (e) {
    return { error: e.code || e.message };
  }
}

async function listSessionFiles(userDataDir) {
  const dir = path.join(userDataDir, 'Default', 'Sessions');
  try {
    const names = await fs.readdir(dir);
    const out = [];
    for (const n of names) {
      const st = await fs.stat(path.join(dir, n));
      out.push(`${n}:${st.size}b`);
    }
    return out.sort();
  } catch (e) {
    return [`(no Sessions dir: ${e.code})`];
  }
}

/**
 * The chrome PIDs using this exact profile.
 *
 * MEASURED: `context.browser()` returns NULL for a persistent context, so the
 * obvious `browser.process().pid` is unavailable — the first version of this
 * probe reported "no pid (could not simulate a crash)" for every crash run,
 * i.e. it measured nothing at all while looking like it had. Reading the
 * process table for --user-data-dir is the reliable route.
 */
function chromePids(userDataDir) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return out.split('\n')
      .filter((l) => l.includes(`--user-data-dir=${userDataDir}`))
      .map((l) => parseInt(l.trim().split(/\s+/)[0], 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function killTree(userDataDir, signal = 'SIGKILL') {
  const pids = chromePids(userDataDir);
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
  return pids;
}

/**
 * HEADED unless told otherwise, because that is the only mode the product runs
 * in (extensions do not load in a headless shell — see RealChrome's header) and
 * because it turned out to MATTER here: session restore is a browser-window
 * feature. Set PROBE_HEADLESS=1 to compare.
 */
const HEADLESS = process.env.PROBE_HEADLESS === '1';

async function launch(userDataDir, extraArgs = []) {
  return chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
    ],
    timeout: 60_000,
  });
}

/** Titles of every page that is not a blank / new-tab placeholder. */
async function realTabs(ctx) {
  const out = [];
  for (const p of ctx.pages()) {
    const url = p.url();
    if (url === 'about:blank' || url === '' || url.startsWith('chrome://new-tab')) continue;
    out.push(await p.title().catch(() => '?'));
  }
  return out;
}

async function openThree(ctx) {
  for (let i = 0; i < URLS.length; i++) {
    const existing = ctx.pages();
    const page = i === 0 && existing[0] ? existing[0] : await ctx.newPage();
    await page.goto(URLS[i]);
  }
  // Chrome flushes its session file lazily; give it a beat to write.
  await new Promise((r) => setTimeout(r, 1500));
}

async function freshDir(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `probe-tabloss-${name}-`));
  await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
  return dir;
}

/** Close a context without ever hanging the probe on a wedged browser. */
async function closeSafely(ctx, dir) {
  await Promise.race([
    ctx.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  killTree(dir);
}

// ── scenarios ──────────────────────────────────────────────────────────────

async function scenarioClean() {
  const dir = await freshDir('clean');
  const r = { scenario: 'clean close then reopen' };
  let ctx = await launch(dir);
  await openThree(ctx);
  r.before = await realTabs(ctx);
  await closeSafely(ctx, dir);
  r.exitState = await readExitState(dir);
  r.startupPref = await readStartupPref(dir);
  r.sessions = await listSessionFiles(dir);
  r.clearSaid = await clearCrashedExitState(dir);
  ctx = await launch(dir);
  await new Promise((res) => setTimeout(res, 1500));
  r.after = await realTabs(ctx);
  await closeSafely(ctx, dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

async function scenarioCrash({ wipe, restoreFlag, label }) {
  const dir = await freshDir(label);
  const r = { scenario: label };
  let ctx = await launch(dir);
  await openThree(ctx);
  r.before = await realTabs(ctx);

  // "It froze, so I closed it" — a SIGKILL, which is what a wedged browser
  // being force-quit (or an OOM kill, or a container stop) actually is.
  r.killed = killTree(dir);
  await new Promise((res) => setTimeout(res, 2000));

  r.exitStateAfterCrash = await readExitState(dir);
  r.sessionsAfterCrash = await listSessionFiles(dir);
  if (wipe) {
    r.clearSaid = await clearCrashedExitState(dir);
    r.exitStateAfterClear = await readExitState(dir);
  } else {
    r.clearSaid = 'SKIPPED (control run)';
  }

  ctx = await launch(dir, restoreFlag ? ['--restore-last-session'] : []);
  await new Promise((res) => setTimeout(res, 2500));
  r.after = await realTabs(ctx);
  await closeSafely(ctx, dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

/**
 * Could we DELEGATE restoring to Chrome instead of remembering tabs ourselves?
 *
 * The best possible case for Chrome: a CLEAN close (so the Sessions files are
 * really on disk), plus `session.restore_on_startup = 5` ("continue where you
 * left off") written into Preferences before the relaunch. If even this restores
 * nothing, delegation is not an option and the product must keep its own list.
 */
async function scenarioDelegate() {
  const dir = await freshDir('delegate');
  const r = { scenario: 'clean close + restore_on_startup=5' };
  let ctx = await launch(dir);
  await openThree(ctx);
  r.before = await realTabs(ctx);
  await closeSafely(ctx, dir);
  r.sessionsOnDisk = await listSessionFiles(dir);

  const prefsPath = path.join(dir, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
    prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };
    await fs.writeFile(prefsPath, JSON.stringify(prefs), 'utf8');
    r.wrotePref = 'session.restore_on_startup=5';
  } catch (e) {
    r.wrotePref = `FAILED ${e.code || e.message}`;
  }

  ctx = await launch(dir, ['--restore-last-session']);
  await new Promise((res) => setTimeout(res, 3000));
  r.after = await realTabs(ctx);
  await closeSafely(ctx, dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

/**
 * THE CANDIDATE FIX, end to end: seed `session.restore_on_startup = 5` into a
 * BRAND NEW profile (before Chrome has ever written Preferences), then crash the
 * browser and reopen it the way RealChrome does.
 *
 * This is the case the product actually faces on a first-run profile, and the
 * one `delegate` does not cover: `delegate` proves Chrome CAN restore, but it
 * had the luxury of a clean shutdown having written Preferences for it.
 */
async function scenarioSeeded() {
  const dir = await freshDir('seeded');
  const r = { scenario: 'seed restore pref on a fresh profile, then crash' };

  // Seed BEFORE the first launch — a fresh profile has no Preferences at all.
  const prefsPath = path.join(dir, 'Default', 'Preferences');
  await fs.writeFile(prefsPath, JSON.stringify({
    session: { restore_on_startup: 5 },
    profile: { exit_type: 'Normal', exited_cleanly: true },
  }), 'utf8');
  r.seeded = await readStartupPref(dir);

  let ctx = await launch(dir, ['--restore-last-session']);
  await openThree(ctx);
  r.before = await realTabs(ctx);
  // Chrome rewrites Preferences during the session; confirm our key SURVIVED
  // that rewrite rather than being normalised away.
  r.prefAfterChromeRan = await readStartupPref(dir);

  r.killed = killTree(dir).length;
  await new Promise((res) => setTimeout(res, 2000));
  r.prefAfterCrash = await readStartupPref(dir);
  r.sessionsAfterCrash = await listSessionFiles(dir);
  r.clearSaid = await clearCrashedExitState(dir);

  ctx = await launch(dir, ['--restore-last-session']);
  await new Promise((res) => setTimeout(res, 3000));
  r.after = await realTabs(ctx);
  await closeSafely(ctx, dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

/**
 * WHICH LEVER DOES THE WORK? Isolate the two independently, so the fix ships
 * only what is load-bearing.
 *
 *   pref-only  — session.restore_on_startup=5, NO --restore-last-session
 *   flag-only  — --restore-last-session, NO pref
 *
 * Shipping both when one suffices is cargo cult, and `--restore-last-session`
 * in particular is a startup flag whose behaviour differs between "restore
 * because the user asked" and "restore because we crashed".
 */
async function scenarioLever({ pref, flag, label }) {
  const dir = await freshDir(label);
  const r = { scenario: label, usesPref: pref, usesFlag: flag };

  if (pref) {
    await fs.writeFile(path.join(dir, 'Default', 'Preferences'), JSON.stringify({
      session: { restore_on_startup: 5 },
      profile: { exit_type: 'Normal', exited_cleanly: true },
    }), 'utf8');
  }

  const args = flag ? ['--restore-last-session'] : [];
  let ctx = await launch(dir, args);
  await openThree(ctx);
  r.before = await realTabs(ctx);

  r.killed = killTree(dir).length;
  await new Promise((res) => setTimeout(res, 2000));
  r.clearSaid = await clearCrashedExitState(dir);

  ctx = await launch(dir, args);
  await new Promise((res) => setTimeout(res, 3000));
  r.after = await realTabs(ctx);
  await closeSafely(ctx, dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

/** What does Chrome actually put in this profile? Answers "why is nothing restored?" */
async function scenarioPrefs() {
  const dir = await freshDir('prefs');
  const r = { scenario: 'profile contents' };
  const ctx = await launch(dir);
  await openThree(ctx);
  await closeSafely(ctx, dir);
  r.userDataDirEntries = await fs.readdir(dir).catch((e) => [String(e.code)]);
  r.defaultEntries = await fs.readdir(path.join(dir, 'Default')).catch((e) => [String(e.code)]);
  r.sessions = await listSessionFiles(dir);
  r.exitState = await readExitState(dir);
  r.startupPref = await readStartupPref(dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

// ── main ───────────────────────────────────────────────────────────────────

const SCENARIOS = {
  clean: scenarioClean,
  crash: () => scenarioCrash({ wipe: true, restoreFlag: false, label: 'crash' }),
  nowipe: () => scenarioCrash({ wipe: false, restoreFlag: false, label: 'nowipe' }),
  restore: () => scenarioCrash({ wipe: true, restoreFlag: true, label: 'restore' }),
  delegate: scenarioDelegate,
  seeded: scenarioSeeded,
  prefonly: () => scenarioLever({ pref: true, flag: false, label: 'prefonly' }),
  flagonly: () => scenarioLever({ pref: false, flag: true, label: 'flagonly' }),
  prefs: scenarioPrefs,
};

async function main() {
  const which = process.argv[2] || 'all';
  const names = which === 'all' ? Object.keys(SCENARIOS) : [which];
  const out = {};
  for (const n of names) {
    if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}`);
    out[n] = await SCENARIOS[n]();
    console.log(`\n### ${n}\n${JSON.stringify(out[n], null, 2)}`);
  }

  if (which === 'all') {
    const n = (s) => (out[s] && out[s].after ? out[s].after.length : -1);
    const b = (s) => (out[s] && out[s].before ? out[s].before.length : -1);
    console.log('\n=== VERDICT ===');
    for (const s of ['clean', 'crash', 'nowipe', 'restore']) {
      console.log(`${s.padEnd(8)} → ${n(s)} of ${b(s)} tabs came back`);
    }
    // The suspect is only guilty if the wipe is what makes the difference.
    console.log(`\nWIPE_IS_THE_CAUSE=${n('crash') === 0 && n('nowipe') > 0}`);
    console.log(`LOST_EVEN_ON_A_CLEAN_CLOSE=${n('clean') === 0}`);
    console.log(`CHROME_RESTORE_IS_AVAILABLE_AT_ALL=${n('restore') > 0}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
