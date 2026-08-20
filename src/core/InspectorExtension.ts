/**
 * InspectorExtension — put the Element Inspector INSIDE the remote browser.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The spec is explicit that there must be exactly ONE Inspector and that it must
 * serve BOTH browser modes:
 *
 *   «نباید دو Inspector جداگانه ساخته شود»  — do not build two separate
 *   Inspectors; the same one works in Remote and in Local mode.
 *
 * In LOCAL mode that is already true for free: the extension is installed in the
 * user's own Chrome, so `Ctrl+Shift+C` works on whatever they are looking at.
 *
 * In REMOTE mode it was NOT true. The remote browser is a Chromium this server
 * launches, and it only side-loads extensions found in
 * `config.REAL_CHROME_EXTENSIONS_DIR` (`./profiles/extensions` by default). This
 * repository ships the extension in `extension/`, and NOTHING ever copied it
 * there — the directory did not even exist on a fresh checkout. So the remote
 * Chromium launched with no Inspector at all, and the only way to get one was
 * for the user to zip `extension/` by hand and upload it through the panel.
 *
 * A feature that requires the user to manually re-package a directory that is
 * already in the repo is not a delivered feature. This module makes the shipped
 * extension present automatically, so Remote mode gets the SAME Inspector Local
 * mode has — one extension, one source directory, no copies to keep in sync.
 *
 * WHY COPY INSTEAD OF POINTING CHROME AT `extension/`
 * ---------------------------------------------------
 * `--load-extension` could name the repo path directly, and that was tried
 * first. Two reasons it is the wrong answer:
 *
 *  1. Chrome WRITES into a loaded unpacked extension's neighbourhood (metadata,
 *     and on some builds a `_metadata/` directory inside it). Pointing it at the
 *     working tree makes the browser dirty the repo, which then shows up in
 *     `git status` as an unexplained change.
 *  2. The copy is what gets PRECONFIGURED (see `bootstrap.config.js` below).
 *     Writing that file into `extension/` would bake this server's own API token
 *     into the repository.
 *
 * So: one authored source (`extension/`), one generated install
 * (`profiles/extensions/ab-inspector`), refreshed whenever the source changes.
 *
 * WHY THE COPY IS PRECONFIGURED
 * -----------------------------
 * A freshly side-loaded extension has an EMPTY `chrome.storage.local`: no base
 * URL, no API key. Its popup would open in the remote browser asking the user to
 * type in the address and token of the very server that just launched it — which
 * they cannot know from inside a remote desktop, and which they should not have
 * to. So the install carries a generated `bootstrap.config.js` naming this
 * server's own loopback address and token, and `background.js` applies it as
 * DEFAULTS only (see `applyBootstrapDefaults` there): anything the user has
 * already saved wins, so this can never overwrite a deliberate setting.
 *
 * Is writing the token to disk a new exposure? No. It is written under
 * `profiles/`, on the machine that already holds it in `.env`, and extension
 * files are reachable only through `chrome-extension://` URLs — the manifest
 * declares no `web_accessible_resources`, so no visited page can read it.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { config } from '../config';

/**
 * The install directory name, and therefore the id the panel/API sees.
 *
 * Fixed rather than generated: `listExtensions` uses the directory name as the
 * extension's stable id, and a name that changed between launches would show up
 * in the panel as a different extension every restart.
 */
export const INSPECTOR_EXTENSION_ID = 'ab-inspector';

/** Files that must never be copied into a loaded extension. */
const SKIP = new Set([
  // Chrome tolerates it, but it is documentation, not code, and it is the one
  // file most likely to be edited for reasons that have nothing to do with the
  // install (which would otherwise trigger a pointless re-seed).
  'README.md',
  '.git',
  'node_modules',
  '.DS_Store',
  // Generated INTO the install, never read from the source.
  'bootstrap.config.js',
  '.ab-seed.json',
]);

/** The stamp that records what was installed, so re-seeding is not blind. */
const STAMP = '.ab-seed.json';

export interface SeedResult {
  /** Did anything get written this time? */
  seeded: boolean;
  /** Why — `fresh`, `updated`, `unchanged`, or a failure reason. */
  reason: 'fresh' | 'updated' | 'unchanged' | 'no_source' | 'failed';
  /** Absolute install directory. `''` when nothing was installed. */
  dir: string;
  /** Version from the source manifest, for logs and the panel. */
  version: string;
  /** Present only when `reason === 'failed'`. */
  error?: string;
}

/** Where the authored extension lives. Resolved from cwd, like `public/`. */
export function inspectorSourceDir(): string {
  return path.resolve(process.cwd(), 'extension');
}

/**
 * Every file in the authored extension, relative to its root, sorted.
 *
 * Sorted because the list feeds a fingerprint: a stable order is what makes the
 * same tree produce the same hash on every platform.
 */
async function sourceFiles(root: string, rel = ''): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const child = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...await sourceFiles(root, child));
    else out.push(child);
  }
  return out;
}

/**
 * A fingerprint of the authored extension plus the settings baked into it.
 *
 * Content-based and not mtime-based on purpose: `git checkout` rewrites mtimes
 * of files whose content did not change, and a copy on every branch switch is
 * noise. Equally, the fingerprint includes the base URL and token, so changing
 * `PORT` or `API_TOKEN` in `.env` DOES re-seed — otherwise the install would
 * keep pointing the remote browser at a server that is no longer there.
 */
async function fingerprint(root: string, files: string[], bootstrap: string): Promise<string> {
  const h = createHash('sha256');
  h.update(bootstrap);
  for (const f of files) {
    h.update(f);
    h.update('\0');
    try {
      h.update(await fs.readFile(path.join(root, f)));
    } catch {
      // A file that cannot be read changes the fingerprint by its absence,
      // which is the correct outcome: the next seed will try again.
      h.update('<unreadable>');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * The address the SERVER-LOCAL browser should use to reach this server.
 *
 * Loopback, deliberately, and this is the LOCAL environment — the browser this
 * server launches on its own infrastructure:
 *
 *   «خود پروژه باید این امکان ارتباط با پلاگین موجود در مرورگر لوکال رو تشخیص
 *    بده و روی 127.0.0.1:پورت پروژه که بالا آمده رو خودش ست کنه»
 *
 * `127.0.0.1` is both the shortest path and the one that cannot be affected by
 * how the server is reached from outside (a proxy, a tunnel, a changed domain).
 *
 * THE PORT IS `config.PORT`, never a literal. It is the port this process is
 * actually listening on, so a deployment that sets `PORT=8080` seeds a browser
 * that reaches 8080. A hardcoded 3000 here would silently point the browser at
 * nothing on every non-default deployment — see the matching fallback in
 * extension/background.js, which had exactly that bug.
 *
 * NOT used for REMOTE. A browser on the operator's own desktop cannot reach this
 * server's loopback; it is given the resolved public address instead (see
 * PublicBaseUrl, used by the REMOTE branch of /inspector/targeting/begin).
 */
function serverBaseUrl(): string {
  return `http://127.0.0.1:${config.PORT}`;
}

/**
 * The generated settings file the install carries.
 *
 * Plain `var` assignments, no JSON parsing, no `eval`: it is pulled in by the
 * service worker with `importScripts`, which is the CSP-safe way to hand data to
 * an MV3 worker.
 */
function bootstrapSource(): string {
  const base = JSON.stringify(serverBaseUrl());
  const token = JSON.stringify(config.API_TOKEN);
  const userId = JSON.stringify(config.IS_SINGLE_USER ? 'local' : '');
  const port = JSON.stringify(config.PORT);
  return `/* GENERATED by src/core/InspectorExtension.ts — do not edit.
 *
 * This copy of the extension is side-loaded into the SERVER-LOCAL browser (the
 * LOCAL environment) by the server, so it is told where that server is instead
 * of asking anyone to type it in. Applied as DEFAULTS only: a value the user has
 * saved is never overwritten (see applyBootstrapDefaults in background.js) —
 * which is what lets an operator's own browser, in the REMOTE environment, keep
 * the address it was given when it redeemed its Authorization Code.
 */
'use strict';
var AB_BOOTSTRAP = {
  baseUrl: ${base},
  apiKey: ${token},
  userId: ${userId},
  // The port this server is ACTUALLY listening on, carried separately so the
  // extension can rebuild a loopback address itself rather than falling back to
  // a guessed one. See LOOPBACK_PORT_FALLBACK in background.js.
  port: ${port},
  managed: true
};
`;
}

/**
 * Make the shipped Inspector present in the remote browser's extensions
 * directory, refreshing it when the source or the server settings changed.
 *
 * Idempotent and cheap on the common path: it hashes the source tree and returns
 * `unchanged` without writing anything when the install already matches.
 *
 * NEVER THROWS. It is called on the launch path of the remote browser, and a
 * failure to seed an extension must degrade to "no Inspector in remote mode",
 * not to "the browser will not start".
 */
export async function seedInspectorExtension(
  extensionsDir = config.REAL_CHROME_EXTENSIONS_DIR,
): Promise<SeedResult> {
  const src = inspectorSourceDir();
  const dest = path.join(extensionsDir, INSPECTOR_EXTENSION_ID);

  try {
    const files = await sourceFiles(src);
    if (!files.includes('manifest.json')) {
      // No authored extension to install (a `dist/`-only deployment that did not
      // ship `extension/`). Not an error, and not something to keep retrying
      // loudly — Remote mode simply has no Inspector until the directory exists.
      return { seeded: false, reason: 'no_source', dir: '', version: '' };
    }

    let version = '';
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(src, 'manifest.json'), 'utf8'));
      version = String(manifest?.version || '');
    } catch { /* a version is for logs only */ }

    const bootstrap = bootstrapSource();
    const want = await fingerprint(src, files, bootstrap);

    // Already installed and identical? Then do nothing at all: re-copying on
    // every launch would make Chrome treat the extension as changed and drop
    // its storage, which is exactly how a configured Inspector loses its
    // settings for no visible reason.
    try {
      const stamp = JSON.parse(await fs.readFile(path.join(dest, STAMP), 'utf8'));
      if (stamp?.fingerprint === want) {
        return { seeded: false, reason: 'unchanged', dir: dest, version };
      }
    } catch { /* no stamp — a fresh or a half-written install */ }

    const existed = await fs.stat(dest).then(() => true).catch(() => false);

    // Replace wholesale rather than merge. A file REMOVED from the source must
    // disappear from the install too, and copying over the top would leave the
    // old one behind to be loaded by a manifest that no longer mentions it.
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest, { recursive: true });

    for (const f of files) {
      const to = path.join(dest, f);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(path.join(src, f), to);
    }

    await fs.writeFile(path.join(dest, 'bootstrap.config.js'), bootstrap, 'utf8');
    // The stamp is written LAST, so an interrupted seed leaves no stamp and is
    // redone next launch instead of being mistaken for a complete install.
    await fs.writeFile(
      path.join(dest, STAMP),
      JSON.stringify({ fingerprint: want, version, at: new Date().toISOString() }, null, 2),
      'utf8',
    );

    return { seeded: true, reason: existed ? 'updated' : 'fresh', dir: dest, version };
  } catch (e) {
    return {
      seeded: false,
      reason: 'failed',
      dir: '',
      version: '',
      error: String((e as Error)?.message || e),
    };
  }
}
