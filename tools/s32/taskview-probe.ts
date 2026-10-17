// Read-only probe for the "two Task View entries with one session id" report.
// Starts Xvfb + openbox, launches the Default registry profile and the
// RealChrome root (two Chromium processes, as in the owner's report), wires
// the SAME Task View resolver as src/index.ts, and prints:
//   - the branch registry (branches.json),
//   - every Chromium browser process with its --user-data-dir / --profile-directory,
//   - what GET /browser/windows would return (BrowserWindowManager.list()).
// Changes no Task View code. Usage: npx tsx tools/s32/taskview-probe.ts
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
async function main(): Promise<void> {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-tv-'));
const DISPLAY = ':95';
process.env.DISPLAY = DISPLAY;
process.env.REAL_CHROME_USER_DATA_DIR = path.join(tmp, 'profiles', 'chrome-profile');
process.env.PROFILES_DIR = path.join(tmp, 'profiles');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const x = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
await sleep(700);
const wm = spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY } });
await sleep(700);
const { config } = await import('../../src/config');
(config as any).REAL_CHROME_USER_DATA_DIR = process.env.REAL_CHROME_USER_DATA_DIR;
const { ProfileRegistry } = await import('../../src/core/ProfileRegistry');
const { BrowserWindowManager } = await import('../../src/core/BrowserWindowManager');
const { indexedProfile } = await import('../../src/core/ProfileIndex');
const { runningProfileOf, setRunningProfile } = await import('../../src/core/BrowserSessions');
const USER = 'local';
const reg = new ProfileRegistry(config.PROFILES_DIR, { baseDir: () => path.join(tmp, 'base'), localBrowserRoot: () => config.REAL_CHROME_USER_DATA_DIR });
await reg.warm(USER);
// Same resolver as src/index.ts (copied, read-only).
BrowserWindowManager.setProfileResolver(async (dir) => {
  const want = path.resolve(dir);
  const list = await reg.list(USER, { includeLocalBrowser: true }).catch(() => []);
  const inRoot = list.filter((p) => path.resolve(reg.dirOf(USER, p.id)) === want);
  if (!inRoot.length) return null;
  const key = indexedProfile(inRoot[0]!.id)?.leaseKey;
  const runningId = key ? runningProfileOf(key) : null;
  const p = inRoot.find((q) => q.id === runningId) || (inRoot.length === 1 ? inRoot[0]! : null);
  return p ? { id: p.id, name: p.name } : null;
});
const ctxs: any[] = [];
for (const id of ['default', 'local-browser']) {
  const loc = (await reg.locationOf(USER, id))!;
  const c = await chromium.launchPersistentContext(loc.root, { headless: false, args: [`--profile-directory=${loc.folder}`] });
  setRunningProfile(indexedProfile(id)!.leaseKey, id);
  await (c.pages()[0] || await c.newPage()).goto('about:blank');
  ctxs.push(c);
}
await sleep(1500);
const procs = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => {
  try { const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return a.some((s) => s.startsWith('--user-data-dir=' + tmp)) && !a.some((s) => s.startsWith('--type=')) ? { pid: +p, udd: a.find((s) => s.startsWith('--user-data-dir='))!.slice(16).replace(tmp, '<tmp>'), dir: (a.find((s) => s.startsWith('--profile-directory=')) || '').slice(20) } : null; } catch { return null; }
}).filter(Boolean);
const regFile = JSON.parse(fs.readFileSync(path.join(config.PROFILES_DIR, USER, 'branches.json'), 'utf8'));
const windows = await BrowserWindowManager.list();
const strip = (o: unknown) => JSON.parse(JSON.stringify(o).split(tmp).join('<tmp>'));
console.log(JSON.stringify(strip({
  registry: { branches: regFile.branches.map((b: any) => ({ id: b.id, label: b.label, root: b.root, leaseKey: b.leaseKey, kind: b.kind })), profiles: regFile.profiles.map((p: any) => ({ id: p.id, branchId: p.branchId, folder: p.folder, name: p.name })) },
  processes: procs,
  windows: windows.map((w) => ({ id: w.id, pid: w.pid, profileId: w.profileId, profileName: w.profileName, title: w.title, state: w.state })),
}), null, 1));
for (const c of ctxs) await c.close().catch(() => {});
wm.kill(); x.kill();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });
