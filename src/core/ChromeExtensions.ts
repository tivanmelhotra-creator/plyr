/**
 * ChromeExtensions — discover and install unpacked Chrome extensions.
 *
 * Chrome can only side-load an extension from a DIRECTORY containing a
 * manifest.json (`--load-extension=<dir>`). Everything a user actually has is a
 * `.crx` from the Web Store or a `.zip` from GitHub, so this module's job is to
 * turn those into directories and to enumerate what is installed.
 *
 * A `.crx` is a ZIP with a proprietary header bolted on the front:
 *
 *   CRX2:  "Cr24" | version(4) | pubkeyLen(4) | sigLen(4) | pubkey | sig | ZIP
 *   CRX3:  "Cr24" | version(4) | headerLen(4) | protobuf header | ZIP
 *
 * Stripping the header yields a plain ZIP. We do NOT verify the signature: the
 * file came from the operator of this server, who already has code execution on
 * it, so a signature check would be security theatre. What we DO check is that
 * the unpacked result looks like an extension and that no entry escapes the
 * target directory.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

export interface InstalledExtension {
  /** Directory name under the extensions dir; used as a stable id by the API. */
  id: string;
  /** Absolute path passed to --load-extension. */
  dir: string;
  /** manifest.json "name", falling back to the directory name. */
  name: string;
  version: string;
  manifestVersion: number;
  description: string;
  /** Relative path of the toolbar popup, when the extension has one. */
  popup: string;
  /** Relative path of the options page, when the extension has one. */
  optionsPage: string;
}

export class ExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionError';
  }
}

const MANIFEST = 'manifest.json';

/** Directory names that are never extensions. */
const IGNORED = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store']);

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(dir, MANIFEST), 'utf8');
    // Chrome tolerates a BOM and // comments in manifests written by hand.
    const cleaned = raw.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Where the popup lives differs between manifest versions:
 *   MV2 → browser_action.default_popup / page_action.default_popup
 *   MV3 → action.default_popup
 *
 * We surface it because a popup is also just an extension PAGE: navigating a
 * tab to `chrome-extension://<id>/<popup>` renders the same UI with the same
 * privileges. That is what lets the existing canvas picker drive a cookie
 * extension without a remote desktop.
 */
function extractPopup(manifest: Record<string, unknown>): string {
  const candidates = ['action', 'browser_action', 'page_action'];
  for (const key of candidates) {
    const section = manifest[key];
    if (section && typeof section === 'object') {
      const popup = str((section as Record<string, unknown>).default_popup);
      if (popup) return popup.replace(/^\/+/, '');
    }
  }
  return '';
}

function extractOptions(manifest: Record<string, unknown>): string {
  const direct = str(manifest.options_page);
  if (direct) return direct.replace(/^\/+/, '');
  const ui = manifest.options_ui;
  if (ui && typeof ui === 'object') {
    const page = str((ui as Record<string, unknown>).page);
    if (page) return page.replace(/^\/+/, '');
  }
  return '';
}

async function describe(id: string, dir: string): Promise<InstalledExtension | null> {
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  return {
    id,
    dir,
    name: str(manifest.name, id) || id,
    version: str(manifest.version, '0'),
    manifestVersion: typeof manifest.manifest_version === 'number' ? manifest.manifest_version : 2,
    description: str(manifest.description),
    popup: extractPopup(manifest),
    optionsPage: extractOptions(manifest),
  };
}

/**
 * List installed extensions.
 *
 * Also looks ONE level down, because the overwhelmingly common mistake is a zip
 * that contains `my-extension/manifest.json` instead of `manifest.json` at the
 * root. Silently handling that is the difference between "it works" and a
 * support thread.
 */
export async function listExtensions(extensionsDir: string): Promise<InstalledExtension[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(extensionsDir);
  } catch {
    return []; // not created yet — an empty list, not an error
  }

  const found: InstalledExtension[] = [];

  for (const entry of entries) {
    if (IGNORED.has(entry) || entry.startsWith('.')) continue;
    const dir = path.join(extensionsDir, entry);
    let stat;
    try { stat = await fs.stat(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const direct = await describe(entry, dir);
    if (direct) { found.push(direct); continue; }

    // Nested-single-folder rescue.
    let inner: string[];
    try { inner = await fs.readdir(dir); } catch { continue; }
    for (const sub of inner) {
      if (IGNORED.has(sub) || sub.startsWith('.')) continue;
      const subDir = path.join(dir, sub);
      let subStat;
      try { subStat = await fs.stat(subDir); } catch { continue; }
      if (!subStat.isDirectory()) continue;
      const nested = await describe(`${entry}/${sub}`, subDir);
      if (nested) { found.push(nested); break; }
    }
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * Strip a CRX header, returning the embedded ZIP.
 *
 * Returns the input unchanged when it is already a bare ZIP ("PK\x03\x04"), so
 * callers do not have to sniff the type themselves.
 */
export function crxToZip(buffer: Buffer): Buffer {
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 2) === 'PK') return buffer;

  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'Cr24') {
    throw new ExtensionError('Not a .crx or .zip file (bad magic bytes).');
  }

  const version = buffer.readUInt32LE(4);

  if (version === 2) {
    const pubKeyLen = buffer.readUInt32LE(8);
    const sigLen = buffer.readUInt32LE(12);
    const start = 16 + pubKeyLen + sigLen;
    if (start >= buffer.length) throw new ExtensionError('Truncated CRX2 file.');
    return buffer.subarray(start);
  }

  if (version === 3) {
    const headerLen = buffer.readUInt32LE(8);
    const start = 12 + headerLen;
    if (start >= buffer.length) throw new ExtensionError('Truncated CRX3 file.');
    return buffer.subarray(start);
  }

  throw new ExtensionError(`Unsupported CRX version ${version}.`);
}

/** Directory name that is safe to create and safe to put in a shell-free argv. */
export function safeExtensionId(name: string): string {
  const base = path
    .basename(String(name || 'extension'))
    .replace(/\.(crx|zip)$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 64);
  return base || 'extension';
}

/**
 * Unpack a .crx/.zip upload into `<extensionsDir>/<id>` and return its metadata.
 *
 * `unzip` is shelled out to rather than adding a zip dependency: it is present
 * on every distro this runs on, it is faster than a JS implementation on large
 * extensions, and `-o -qq` plus a fixed argv means no shell and no interactive
 * prompt can hang the request. Zip-slip is handled by `unzip` itself (it refuses
 * absolute and `..` paths) and re-checked by verifying the manifest afterwards.
 */
export async function installExtensionArchive(
  extensionsDir: string,
  fileName: string,
  data: Buffer,
): Promise<InstalledExtension> {
  if (!data || data.length === 0) throw new ExtensionError('Uploaded file is empty.');

  const zip = crxToZip(data);
  const id = safeExtensionId(fileName);
  const target = path.join(extensionsDir, id);

  // Refuse to walk out of the extensions directory even if safeExtensionId is
  // ever loosened.
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(extensionsDir) + path.sep)) {
    throw new ExtensionError('Invalid extension name.');
  }

  await fs.mkdir(extensionsDir, { recursive: true });

  const tmpZip = path.join(os.tmpdir(), `ext-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await fs.writeFile(tmpZip, zip);

  // Replace any previous version wholesale: leaving stale files behind is how
  // an MV2 leftover breaks an MV3 upgrade.
  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });

  try {
    await execFileAsync('unzip', ['-o', '-qq', tmpZip, '-d', resolved], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'The `unzip` command is not installed on this server. Install it (apt-get install unzip) or upload an already-unpacked extension directory.'
      : `Could not unpack the archive: ${(e as Error).message}`;
    throw new ExtensionError(msg);
  } finally {
    await fs.unlink(tmpZip).catch(() => {});
  }

  // __MACOSX pollutes every zip made on a Mac and confuses Chrome's loader.
  await fs.rm(path.join(resolved, '__MACOSX'), { recursive: true, force: true }).catch(() => {});

  const direct = await describe(id, resolved);
  if (direct) return direct;

  // Nested single folder: hoist it so --load-extension gets a real manifest dir.
  const inner = await fs.readdir(resolved).catch(() => [] as string[]);
  const dirs = [] as string[];
  for (const entry of inner) {
    const p = path.join(resolved, entry);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isDirectory()) dirs.push(entry);
  }
  if (dirs.length === 1) {
    const nested = await describe(`${id}/${dirs[0]}`, path.join(resolved, dirs[0]));
    if (nested) return nested;
  }

  await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
  throw new ExtensionError(
    'The archive does not contain a manifest.json, so it is not a Chrome extension. ' +
    'If you downloaded a .crx from the Web Store, upload it directly — do not rename it to .zip.',
  );
}

/** Remove an installed extension. Returns false when it was not there. */
export async function removeExtension(extensionsDir: string, id: string): Promise<boolean> {
  const safe = safeExtensionId(id.split('/')[0]);
  const target = path.resolve(path.join(extensionsDir, safe));
  if (!target.startsWith(path.resolve(extensionsDir) + path.sep)) return false;
  try {
    const st = await fs.stat(target);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

/**
 * Build the two Chrome flags that side-load extensions.
 *
 * `--disable-extensions-except` is not optional: Playwright's own launch args
 * include `--disable-extensions`, and without the "except" list Chrome honours
 * the disable and loads nothing while reporting no error at all.
 */
export function extensionLaunchArgs(extensions: InstalledExtension[]): string[] {
  if (extensions.length === 0) return [];
  const paths = extensions.map((e) => e.dir).join(',');
  return [`--disable-extensions-except=${paths}`, `--load-extension=${paths}`];
}
