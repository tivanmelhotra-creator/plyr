/**
 * OrphanBrowsers — leftover Chromium processes after a crash (owner's brief,
 * section 7: "Crash: detect leftover processes and clean them up safely.
 * Never kill a browser owned by another active run.").
 *
 * WHAT IS AN ORPHAN (all must hold):
 *   1. a Chromium BROWSER process (not a renderer / GPU child: no --type=)
 *   2. its --user-data-dir is inside one of Aria's own areas (the branch base
 *      directory, PROFILES_DIR, the Local Browser root). A personal Chrome is
 *      never inside them, so it is never touched.
 *   3. it is NOT a descendant of this server process (every browser this
 *      process launched — runs, profile browsers, the Local Browser — is a
 *      Playwright child of it and belongs to an active owner here)
 *   4. no ancestor is another live Node process (another Aria server on the
 *      same machine owns it). An orphan's parent died with the crashed
 *      server, so it was re-parented to init / a subreaper.
 *
 * Cleanup: SIGTERM, then SIGKILL after a grace period. Only then is a stale
 * `SingletonLock` of that root removed — never while a live process holds it
 * (removing it would let a second Chromium open the same data).
 *
 * Process listing: Linux reads /proc (tested). Windows uses PowerShell
 * Get-CimInstance Win32_Process (NOT tested); on any listing failure nothing
 * is killed and nothing is unlocked.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export interface ProcInfo { pid: number; ppid: number; args: string[] }
export interface Orphan { pid: number; userDataDir: string }

// Linux/macOS: Singleton*; Windows: `lockfile` (Chromium's ProcessSingleton on Windows).
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];

function userDataDirOf(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--user-data-dir=')) return a.slice('--user-data-dir='.length).replace(/^"|"$/g, '');
    if (a === '--user-data-dir' && args[i + 1]) return args[i + 1]!;
  }
  return null;
}

const isChromiumBrowser = (args: string[]) =>
  !!args.length && /chrom(e|ium)|headless_shell|msedge/i.test(path.win32.basename(args[0]!)) && !args.some((a) => a.startsWith('--type='));
const isNode = (args: string[]) => !!args.length && /(^|[\\/])node(\.exe)?$/i.test(args[0]!);

const resolveFor = (p: string, platform = process.platform) =>
  platform === 'win32' ? path.win32.resolve(p) : path.resolve(p);

const inside = (dir: string, area: string, platform = process.platform) => {
  if (platform === 'win32') {
    const d = path.win32.resolve(dir).toLowerCase();
    const a = path.win32.resolve(area).toLowerCase();
    const sep = path.win32.sep;
    return d === a || d.startsWith(a.endsWith(sep) ? a : a + sep);
  }
  const d = path.resolve(dir); const a = path.resolve(area);
  return d === a || d.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

/** Pure: which processes of `procs` are orphaned Aria browsers. */
export function findOrphans(procs: ProcInfo[], areas: string[], selfPid: number, platform = process.platform): Orphan[] {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const));
  const out: Orphan[] = [];
  for (const p of procs) {
    if (!isChromiumBrowser(p.args)) continue;
    const udd = userDataDirOf(p.args);
    if (!udd || !areas.some((a) => a && inside(udd, a, platform))) continue;
    let owned = false;
    const seen = new Set<number>();
    for (let cur = byPid.get(p.ppid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
      seen.add(cur.pid);
      if (cur.pid === selfPid || isNode(cur.args)) { owned = true; break; }
    }
    if (p.ppid === selfPid) owned = true;
    if (!owned) out.push({ pid: p.pid, userDataDir: resolveFor(udd, platform) });
  }
  return out;
}

async function listLinux(): Promise<ProcInfo[]> {
  const out: ProcInfo[] = [];
  for (const d of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = await fs.readFile(`/proc/${d}/cmdline`, 'utf8');
      const stat = await fs.readFile(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      out.push({ pid: Number(d), ppid, args: cmd.split('\0').filter(Boolean) });
    } catch { /* process ended meanwhile */ }
  }
  return out;
}

/** Pure: parse PowerShell `Get-CimInstance Win32_Process | ... | ConvertTo-Json` stdout into ProcInfo[]. */
export function parseWindowsCimProcesses(stdout: string): ProcInfo[] {
  const rows = ([] as any[]).concat(JSON.parse(stdout || '[]'));
  return rows.filter((r) => r && r.CommandLine).map((r) => ({
    pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId),
    // Good enough for our checks: exe path + switches (quoted paths kept whole).
    args: (String(r.CommandLine).match(/(?:"[^"]*"|[^\s"])+/g) || []).map((s) => s.replace(/"/g, '')),
  }));
}

function listWindows(): Promise<ProcInfo[]> {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(parseWindowsCimProcesses(stdout));
      } catch (e) { reject(e); }
    });
  });
}

export async function listProcesses(platform = process.platform): Promise<ProcInfo[]> {
  return platform === 'win32' ? listWindows() : listLinux();
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Kill the orphans inside `areas`, then remove stale Singleton* files of the
 * given roots (and of every orphan's root) that no live process holds.
 * Never throws; returns what it did.
 */
export async function reapOrphans(areas: string[], opts: { roots?: string[]; graceMs?: number; list?: () => Promise<ProcInfo[]>; selfPid?: number } = {}):
  Promise<{ killed: Orphan[]; unlocked: string[]; skipped?: string }> {
  let procs: ProcInfo[];
  try { procs = await (opts.list || listProcesses)(); } catch (e) {
    return { killed: [], unlocked: [], skipped: `could not list processes (${(e as Error).message.split('\n')[0]}); nothing was killed or unlocked` };
  }
  const orphans = findOrphans(procs, areas, opts.selfPid ?? process.pid);
  for (const o of orphans) { try { process.kill(o.pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + (opts.graceMs ?? 3000);
  while (orphans.some((o) => alive(o.pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const o of orphans) if (alive(o.pid)) { try { process.kill(o.pid, 'SIGKILL'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, orphans.length ? 200 : 0));

  // Roots still used by a live browser process (ours or another server's).
  let live: ProcInfo[] = [];
  try { live = await (opts.list || listProcesses)(); } catch { return { killed: orphans, unlocked: [], skipped: 'could not re-list processes; locks left as they are' }; }
  const busy = new Set(live.filter((p) => isChromiumBrowser(p.args)).map((p) => userDataDirOf(p.args)).filter(Boolean).map((d) => path.resolve(d!)));
  const unlocked: string[] = [];
  for (const root of new Set([...(opts.roots || []), ...orphans.map((o) => o.userDataDir)].map((r) => path.resolve(r)))) {
    if (busy.has(root)) continue;
    let did = false;
    for (const f of SINGLETON_FILES) {
      const p = path.join(root, f);
      if (await fs.lstat(p).then(() => true, () => false)) { await fs.unlink(p).catch(() => {}); did = true; }
    }
    if (did) unlocked.push(root);
  }
  return { killed: orphans, unlocked };
}

/** Every root (dir containing a Singleton* file) up to `depth` levels below `area`. */
export async function lockedRootsUnder(area: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, d: number) => {
    let ents: import('fs').Dirent[] = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => SINGLETON_FILES.includes(e.name))) { out.push(dir); return; }
    if (d <= 0) return;
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name), d - 1);
  };
  await walk(area, depth);
  return out;
}
