#!/usr/bin/env node
/**
 * build-extension — turn `extension/` into an INSTALLABLE artifact.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Reported: the operator wants LOCAL BROWSER with their own personal Chrome,
 * and «چون هیچ Chrome Extension ساخته‌شده‌ای برای نصب ندارند» — there was no
 * built extension to install.
 *
 * MEASURED, before this script existed:
 *
 *   package.json   "build": "tsc"
 *   tsconfig.json  "include": ["src/**\/*"], "rootDir": "./src"
 *
 * So `npm run build` compiled TypeScript and nothing else. `extension/` was
 * never copied, bundled or zipped by any script. Its only consumer was
 * `seedInspectorExtension()`, which installs into `profiles/extensions/` — a
 * git-ignored runtime directory, and for the REMOTE browser only. The Dockerfile
 * has `COPY extension ./extension`, which helps container users and nobody
 * else.
 *
 * Net effect: `git clone && npm ci && npm run build` produced NOTHING a user
 * could point "Load unpacked" at. Exactly as reported.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PRODUCES
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   artifacts/element-inspector-extension/    <- Load unpacked points HERE
 *     manifest.json
 *     background.js
 *     content/{inspector,presence,recorder,selector}.js
 *     lib/{ab-core,ab-handoff,ab-inspect}.js
 *     popup/{popup.html,popup.js,popup.css}
 *     icons/{icon16,icon48,icon128}.png
 *     INSTALL.md
 *
 * NO BUNDLER, DELIBERATELY. The source is already plain MV3-compatible ES5/ES6
 * with no imports, no JSX and no node_modules dependency: `background.js` pulls
 * its helpers with `importScripts()`, and the content scripts are listed
 * individually in the manifest so Chrome loads them in order. Adding a bundler
 * would mean rewriting all of that to produce a file Chrome can already load
 * today — pure risk for no gain. What IS required is VERIFICATION, which is
 * most of this file.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE VERIFICATION IS NOT OPTIONAL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A copy step that silently drops a file produces an artifact that LOOKS built
 * and fails at "Load unpacked" with Chrome's own unhelpful error. So every path
 * the manifest names is resolved against the OUTPUT directory, and a missing
 * one fails the build with a non-zero exit. That check is what makes the CI
 * artifact trustworthy: if the workflow is green, the download installs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'artifacts');
const OUT = path.join(OUT_DIR, 'element-inspector-extension');

/**
 * Things that are SOURCE-ONLY and must not ship.
 *
 * `UI_UX/` is 3 design PNGs and a spec document (~1.5 MB of nothing Chrome
 * reads). `bootstrap.config.js` is deliberately excluded even if a stray one is
 * lying around: it is GENERATED per-install by seedInspectorExtension() for the
 * remote browser and carries an API token. Shipping a copy in a downloadable
 * artifact would publish somebody's credential.
 */
const EXCLUDE_DIRS = new Set(['UI_UX', 'node_modules', '.git']);
const EXCLUDE_FILES = new Set([
  'README.md',
  '.DS_Store',
  'bootstrap.config.js',
  '.ab-seed.json',
]);

function fail(msg) {
  console.error(`\n[build-extension] ✗ ${msg}\n`);
  process.exit(1);
}

function rmrf(target) {
  // A stale file from a previous build that is no longer in source would
  // otherwise survive for ever and be shipped as if it were current.
  fs.rmSync(target, { recursive: true, force: true });
}

/** Recursive copy honouring the exclusion lists. Returns the file count. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      count += copyTree(path.join(from, entry.name), path.join(to, entry.name));
      continue;
    }
    if (EXCLUDE_FILES.has(entry.name)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    count += 1;
  }
  return count;
}

/**
 * Collect every path the manifest references.
 *
 * This walks the manifest STRUCTURALLY rather than grepping for strings,
 * because a path that Chrome resolves and a path that merely looks like one are
 * different sets, and only the first matters at install time.
 */
function manifestPaths(manifest) {
  const paths = [];
  const add = (p, where) => {
    if (typeof p === 'string' && p.length > 0) paths.push({ p, where });
  };

  add(manifest.background && manifest.background.service_worker, 'background.service_worker');
  add(manifest.action && manifest.action.default_popup, 'action.default_popup');
  add(manifest.options_page, 'options_page');
  add(manifest.devtools_page, 'devtools_page');

  for (const [size, p] of Object.entries(manifest.icons || {})) {
    add(p, `icons.${size}`);
  }
  for (const [size, p] of Object.entries(
    (manifest.action && manifest.action.default_icon) || {},
  )) {
    add(p, `action.default_icon.${size}`);
  }

  (manifest.content_scripts || []).forEach((cs, i) => {
    (cs.js || []).forEach((p, j) => add(p, `content_scripts[${i}].js[${j}]`));
    (cs.css || []).forEach((p, j) => add(p, `content_scripts[${i}].css[${j}]`));
  });

  (manifest.web_accessible_resources || []).forEach((war, i) => {
    (war.resources || []).forEach((p, j) => {
      // Globs are legal here and cannot be resolved to a single file.
      if (!p.includes('*')) add(p, `web_accessible_resources[${i}].resources[${j}]`);
    });
  });

  return paths;
}

/**
 * Every path referenced by an HTML page it ships.
 *
 * popup.html pulls popup.css, ../lib/ab-core.js and popup.js. None of those
 * appear in the manifest, so a manifest-only check would happily bless an
 * artifact whose popup is blank the moment a user clicks the toolbar icon.
 */
function htmlAssetPaths(htmlFile, outRoot) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const dir = path.dirname(htmlFile);
  const found = [];
  const re = /<(?:script[^>]+src|link[^>]+href|img[^>]+src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ref = m[1];
    if (/^(https?:|data:|#|mailto:)/i.test(ref)) continue;
    const abs = path.resolve(dir, ref);
    found.push({
      ref,
      abs,
      where: `${path.relative(outRoot, htmlFile)} -> ${ref}`,
    });
  }
  return found;
}

/** All .html files in the built artifact. */
function htmlFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, acc);
    else if (entry.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

/**
 * Every file `background.js` loads with importScripts().
 *
 * The service worker dies instantly if one of these is missing, and Chrome
 * reports that as a generic "Service worker registration failed" — a error
 * message that has cost people hours. Cheaper to check here.
 *
 * `bootstrap.config.js` is the deliberate exception: it is generated at seed
 * time for the remote browser and background.js already wraps every
 * importScripts() in try/catch precisely so a local install works without it.
 */
function importScriptPaths(workerFile, outRoot) {
  const js = fs.readFileSync(workerFile, 'utf8');
  const re = /importScripts\(\s*['"]([^'"]+)['"]\s*\)/g;
  const found = [];
  let m;
  while ((m = re.exec(js)) !== null) {
    if (m[1] === 'bootstrap.config.js') continue;
    found.push({
      ref: m[1],
      abs: path.resolve(outRoot, m[1]),
      where: `background.js -> importScripts('${m[1]}')`,
    });
  }
  return found;
}

const INSTALL_MD = `# Element Inspector — install in your own Chrome

This folder is a **ready-to-install, unpacked Chrome extension**. Nothing here
needs building, unzipping or editing.

## Install

1. Build the project (this folder is produced by it):

       npm ci
       npm run build

2. Open Chrome and go to:

       chrome://extensions

3. Turn on **Developer mode** (top-right toggle).

4. Click **Load unpacked**.

5. Select this folder:

       artifacts/element-inspector-extension

   Select the FOLDER ITSELF, not \`manifest.json\` inside it.

"Element Inspector" now appears in your extensions list and in the toolbar.

## Use it with a Target Field

1. In the app, open the field you want to fill and choose
   **Target This Field → LOCAL BROWSER**.
2. The app shows an **Authorization Code**.
3. Click the Element Inspector toolbar icon and enter that code once.
4. Inspect any element in your own Chrome; the value is sent to that exact
   Target Field.

The pairing is **durable**: the same extension and the same Target Field will
not ask for a code again. A *different* Target Field requests a new pairing.

## Updating

Re-run \`npm run build\`, then press **Reload** (⟳) on the extension card in
\`chrome://extensions\`. The folder path never changes.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Manifest file is missing or unreadable" | A file was selected instead of the folder. Select \`artifacts/element-inspector-extension\`. |
| Extension does not appear after Load unpacked | Developer mode is off. |
| "Service worker registration failed" | Re-run \`npm run build\` — the artifact is verified at build time and will fail loudly if incomplete. |
`;

function main() {
  console.log('[build-extension] building the installable Chrome extension…');

  if (!fs.existsSync(SRC)) fail(`source directory not found: ${SRC}`);
  const manifestSrc = path.join(SRC, 'manifest.json');
  if (!fs.existsSync(manifestSrc)) fail(`no manifest.json in ${SRC}`);

  // ── 1. Clean, then copy ────────────────────────────────────────────────
  rmrf(OUT);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const copied = copyTree(SRC, OUT);
  console.log(`[build-extension]   copied ${copied} files -> ${path.relative(ROOT, OUT)}`);

  // ── 2. The manifest must exist in the OUTPUT and be valid JSON ─────────
  const manifestOut = path.join(OUT, 'manifest.json');
  if (!fs.existsSync(manifestOut)) fail('manifest.json is missing from the built artifact');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestOut, 'utf8'));
  } catch (e) {
    fail(`manifest.json in the artifact is not valid JSON: ${e.message}`);
  }
  if (manifest.manifest_version !== 3) {
    fail(`expected manifest_version 3, found ${manifest.manifest_version}`);
  }
  if (!manifest.name || !manifest.version) {
    fail('manifest.json must declare both "name" and "version"');
  }

  // ── 3. Every path the manifest names must resolve inside the artifact ──
  const missing = [];
  for (const { p, where } of manifestPaths(manifest)) {
    if (!fs.existsSync(path.join(OUT, p))) missing.push(`${where}: ${p}`);
  }

  // ── 4. …and every asset the shipped HTML pulls in ──────────────────────
  for (const file of htmlFiles(OUT)) {
    for (const { abs, where } of htmlAssetPaths(file, OUT)) {
      if (!fs.existsSync(abs)) missing.push(where);
    }
  }

  // ── 5. …and every importScripts() the service worker performs ──────────
  const worker = manifest.background && manifest.background.service_worker;
  if (worker && fs.existsSync(path.join(OUT, worker))) {
    for (const { abs, where } of importScriptPaths(path.join(OUT, worker), OUT)) {
      if (!fs.existsSync(abs)) missing.push(where);
    }
  }

  if (missing.length > 0) {
    fail(
      'the artifact is incomplete — Chrome would reject it at "Load unpacked".\n' +
        missing.map((m) => `        missing: ${m}`).join('\n'),
    );
  }

  // ── 6. Nothing secret may ride along ───────────────────────────────────
  // bootstrap.config.js holds a real API token when seeded for the remote
  // browser. An artifact uploaded to CI is downloadable by anyone with repo
  // access, so this is a hard failure rather than a warning.
  if (fs.existsSync(path.join(OUT, 'bootstrap.config.js'))) {
    fail('bootstrap.config.js leaked into the artifact — it can contain an API token');
  }

  // ── 7. Ship the install instructions WITH the thing being installed ────
  fs.writeFileSync(path.join(OUT, 'INSTALL.md'), INSTALL_MD);

  const total = manifestPaths(manifest).length;
  console.log(`[build-extension]   verified ${total} manifest paths + html assets + importScripts`);
  console.log(`[build-extension] ✓ ${manifest.name} v${manifest.version} is ready`);
  console.log('');
  console.log('    Load it in Chrome:');
  console.log('      chrome://extensions → Developer mode → Load unpacked');
  console.log(`      → ${path.relative(ROOT, OUT)}`);
  console.log('');
}

main();
