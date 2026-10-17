#!/usr/bin/env node
/**
 * Report on the two "Default" data folders (owner's brief, section 12):
 * for each one its name, size, last-used time, and whether it CONTAINS
 * cookie / login data. Nothing is merged, moved or changed.
 *
 * CONTENTS ARE NEVER READ: only directory listings and file metadata (stat:
 * size, modification time). "Contains cookies" = a non-empty `Cookies` file
 * exists in a profile folder; "contains login data" = a non-empty
 * `Login Data` file exists. No file is opened.
 *
 * Usage:   node tools/default-folders-report.mjs [folder ...]
 * Default: the Local Browser root (REAL_CHROME_USER_DATA_DIR, default
 *          ./profiles/chrome-profile) and the registry's built-in default
 *          (<PROFILES_DIR>/<user>/chrome-profile, default ./profiles/local/chrome-profile).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const PROFILES_DIR = path.resolve(process.env.PROFILES_DIR || './profiles');
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => path.resolve(p))
  : [
    path.resolve(process.env.REAL_CHROME_USER_DATA_DIR || path.join(PROFILES_DIR, 'chrome-profile')),
    path.join(PROFILES_DIR, process.env.SINGLE_USER_ID || 'local', 'chrome-profile'),
  ];

async function walk(dir) {
  let size = 0; let newest = 0;
  let ents = [];
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return { size, newest }; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { const r = await walk(p); size += r.size; newest = Math.max(newest, r.newest); }
      else { size += st.size; newest = Math.max(newest, st.mtimeMs); }
    } catch { /* vanished */ }
  }
  return { size, newest };
}

const nonEmpty = async (p) => { try { const st = await fs.stat(p); return st.isFile() && st.size > 0; } catch { return false; } };
const human = (n) => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

const out = [];
for (const root of targets) {
  const row = { folder: root, exists: false };
  try { row.exists = (await fs.stat(root)).isDirectory(); } catch { /* missing */ }
  if (row.exists) {
    const { size, newest } = await walk(root);
    row.size = human(size); row.sizeBytes = size;
    row.lastUsed = newest ? new Date(newest).toISOString() : null;
    row.profiles = [];
    for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const d = path.join(root, e.name);
      if (!(await nonEmpty(path.join(d, 'Preferences')))) continue;
      row.profiles.push({
        profileFolder: e.name,
        hasCookies: (await nonEmpty(path.join(d, 'Cookies'))) || (await nonEmpty(path.join(d, 'Network', 'Cookies'))),
        hasLoginData: await nonEmpty(path.join(d, 'Login Data')),
      });
    }
    row.inUseNow = await fs.lstat(path.join(root, 'SingletonLock')).then(() => true, () => false);
  }
  out.push(row);
}
console.log(JSON.stringify(out, null, 2));
