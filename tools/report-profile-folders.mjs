#!/usr/bin/env node
/**
 * Owner's brief, section 12: report the Chromium profile folders WITHOUT
 * reading their contents. For each folder: name, size on disk, last-used time
 * (newest modification time of any file), and whether a Cookies / Login Data
 * file EXISTS (existence only; the files are never opened).
 *
 * Usage:  node tools/report-profile-folders.mjs <folder> [<folder> ...]
 *   e.g.  node tools/report-profile-folders.mjs "profiles/chrome-profile/Default" "profiles/local/browser-profiles/prf_aa91b811ffd7/Default"
 * With no argument it lists every "Default" folder under ./profiles (depth <= 5).
 * Read-only: nothing is created, changed, moved or deleted.
 */
import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE = [
  ['cookies', ['Cookies', path.join('Network', 'Cookies')]],
  ['loginData', ['Login Data', 'Login Data For Account']],
];

function walk(dir, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue; // never follow (SingletonLock etc.)
    if (st.isDirectory()) walk(p, acc);
    else { acc.size += st.size; acc.files++; if (st.mtimeMs > acc.newest) acc.newest = st.mtimeMs; }
  }
}

export function reportFolder(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { folder: abs, exists: false };
  const acc = { size: 0, files: 0, newest: 0 };
  walk(abs, acc);
  const out = { folder: abs, name: path.basename(abs), exists: true, files: acc.files, sizeBytes: acc.size,
    sizeHuman: `${(acc.size / 1024 / 1024).toFixed(1)} MB`, lastUsed: acc.newest ? new Date(acc.newest).toISOString() : null };
  for (const [key, names] of SENSITIVE) out[key] = names.some((n) => { try { return fs.statSync(path.join(abs, n)).size > 0; } catch { return false; } });
  return out;
}

function findDefaults(root, depth, acc) {
  if (depth < 0) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (e.name === 'Default') acc.push(p); else findDefaults(p, depth - 1, acc);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('report-profile-folders.mjs')) {
  let dirs = process.argv.slice(2);
  if (!dirs.length) { const acc = []; findDefaults(path.resolve('profiles'), 5, acc); dirs = acc; }
  if (!dirs.length) { console.log('No profile folders found.'); process.exit(0); }
  for (const d of dirs) console.log(JSON.stringify(reportFolder(d)));
}
