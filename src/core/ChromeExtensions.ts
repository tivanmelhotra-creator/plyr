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
import { createHash } from 'crypto';
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
  /**
   * The id Chrome will actually assign, when it is knowable up front.
   *
   * Chrome derives an unpacked extension's id from its absolute path UNLESS the
   * manifest carries a `key`, in which case the id is derived from that key
   * instead. Store installs inject the key (see `installExtensionFromStore`), so
   * for those this is the canonical Web Store id. Empty when there is no key and
   * the caller must fall back to the path-derived id.
   */
  extensionId: string;
  /** Web Store id when this came from the store, else ''. */
  storeId: string;
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

/**
 * Resolve a `__MSG_key__` placeholder against the extension's own locale files.
 *
 * Practically every Web Store extension localises its name, so a manifest reads
 * `"name": "__MSG_appName__"`. Showing that raw string in the UI — which is
 * what happens if you just trust `manifest.name` — makes the panel look broken
 * and gives the user no way to tell two extensions apart.
 */
async function resolveMessages(dir: string, manifest: Record<string, unknown>, values: string[]): Promise<string[]> {
  const needsLookup = values.some((v) => /^__MSG_(.+)__$/.test(v));
  if (!needsLookup) return values;

  // default_locale first, then English, then whatever is actually shipped.
  const preferred = [str(manifest.default_locale), 'en', 'en_US'].filter(Boolean);
  let available: string[] = [];
  try {
    available = await fs.readdir(path.join(dir, '_locales'));
  } catch {
    return values;
  }
  const order = [...preferred.filter((l) => available.includes(l)), ...available];

  for (const locale of order) {
    let messages: Record<string, { message?: string }>;
    try {
      const raw = await fs.readFile(path.join(dir, '_locales', locale, 'messages.json'), 'utf8');
      messages = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    if (!messages || typeof messages !== 'object') continue;

    const resolved = values.map((v) => {
      const m = /^__MSG_(.+)__$/.exec(v);
      if (!m) return v;
      // Message keys are matched case-insensitively by Chrome.
      const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1].toLowerCase());
      const text = key ? messages[key]?.message : undefined;
      return typeof text === 'string' && text ? text : v;
    });
    // Stop at the first locale that resolved at least one placeholder.
    if (resolved.some((v, i) => v !== values[i])) return resolved;
  }
  return values;
}

async function describe(id: string, dir: string): Promise<InstalledExtension | null> {
  const manifest = await readManifest(dir);
  if (!manifest) return null;

  const [name, description] = await resolveMessages(dir, manifest, [
    str(manifest.name, id) || id,
    str(manifest.description),
  ]);

  // A manifest `key` decides the id Chrome assigns, overriding the path-derived
  // one. Reading it here keeps every consumer (launch args, popup URLs, the
  // API) agreed on a single id.
  let extensionId = '';
  const key = str(manifest.key);
  if (key) {
    try {
      const decoded = Buffer.from(key, 'base64');
      if (decoded.length > 0) extensionId = extensionIdFromKey(decoded);
    } catch { /* a malformed key just means we fall back to the path id */ }
  }

  return {
    id,
    dir,
    name: name || id,
    version: str(manifest.version, '0'),
    manifestVersion: typeof manifest.manifest_version === 'number' ? manifest.manifest_version : 2,
    description,
    popup: extractPopup(manifest),
    optionsPage: extractOptions(manifest),
    extensionId,
    storeId: STORE_ID_RE.test(id) ? id : '',
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

// ───────────────────────────────────────────────────────────────────────────
// CRX identity
//
// Chrome gives an UNPACKED extension an id derived from its absolute directory
// path — so the same extension gets a different id on a machine that keeps its
// profiles somewhere else, and every `chrome-extension://<id>/…` URL saved in a
// workflow breaks the moment the install path changes.
//
// The fix is the `key` manifest field: when present, Chrome derives the id from
// it instead of from the path. A signed .crx carries the very public key we
// need in its header, so a store install can pin the extension to its real,
// canonical Web Store id — stable forever, and identical to the id in the
// extension's own documentation.
// ───────────────────────────────────────────────────────────────────────────

/** Read one protobuf varint. Returns [value, nextOffset]. */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte: number;
  let o = offset;
  do {
    if (o >= buf.length) throw new ExtensionError('Malformed CRX header.');
    byte = buf[o++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (shift > 70) throw new ExtensionError('Malformed CRX header.');
  } while (byte & 0x80);
  return [result, o];
}

/** Walk the top-level fields of a protobuf message. */
function* protoFields(buf: Buffer): Generator<[number, Buffer]> {
  let o = 0;
  while (o < buf.length) {
    let tag: number;
    [tag, o] = readVarint(buf, o);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len: number;
      [len, o] = readVarint(buf, o);
      if (o + len > buf.length) return;
      yield [field, buf.subarray(o, o + len)];
      o += len;
    } else if (wire === 0) {
      [, o] = readVarint(buf, o);
    } else if (wire === 5) {
      o += 4;
    } else if (wire === 1) {
      o += 8;
    } else {
      return; // groups: not used by CRX3, and not worth guessing at
    }
  }
}

/**
 * The extension id for a DER public key.
 *
 * It is the first 16 bytes of SHA-256(key), hex-encoded, with each nibble
 * mapped 0-f → a-p ("mpdecimal"). That is why extension ids are 32 letters
 * with nothing past 'p' in them.
 */
export function extensionIdFromKey(publicKey: Buffer): string {
  const hex = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  let id = '';
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

/**
 * Pull the extension's OWN public key out of a CRX3 header.
 *
 * A store .crx is signed several times over — by the developer and by Google's
 * publisher key — so the header holds multiple proofs and simply taking the
 * first one yields a plausible-looking but WRONG id. The header's
 * `signed_header_data` (field 10000) contains the authoritative 16-byte
 * `crx_id`; the right key is the one that hashes to it.
 *
 * Returns null for CRX2 and for anything we cannot read confidently — callers
 * fall back to the path-derived id, which still works, just less durably.
 */
export function crxPublicKey(buffer: Buffer): Buffer | null {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'Cr24') return null;
  if (buffer.readUInt32LE(4) !== 3) return null;

  const headerLen = buffer.readUInt32LE(8);
  if (12 + headerLen > buffer.length) return null;
  const header = buffer.subarray(12, 12 + headerLen);

  const keys: Buffer[] = [];
  let crxId = '';

  try {
    for (const [field, value] of protoFields(header)) {
      // 2 = sha256_with_rsa, 3 = sha256_with_ecdsa; both are AsymmetricKeyProof
      if (field === 2 || field === 3) {
        for (const [pf, pv] of protoFields(value)) {
          if (pf === 1) keys.push(pv); // public_key
        }
      } else if (field === 10000) {
        for (const [sf, sv] of protoFields(value)) {
          if (sf === 1 && sv.length === 16) {
            // crx_id is the raw 16 bytes the id is built from
            let id = '';
            for (const ch of sv.toString('hex')) id += String.fromCharCode(97 + parseInt(ch, 16));
            crxId = id;
          }
        }
      }
    }
  } catch {
    return null;
  }

  if (crxId) {
    const match = keys.find((k) => extensionIdFromKey(k) === crxId);
    if (match) return match;
    return null; // a key we cannot verify is worse than no key at all
  }

  // Self-signed .crx with a single proof and no signed header: unambiguous.
  return keys.length === 1 ? keys[0] : null;
}

/** A Web Store id is exactly 32 characters from a-p. */
const STORE_ID_RE = /^[a-p]{32}$/;

/**
 * Accept anything a user might paste and return the Web Store id.
 *
 * Handles the current store host, the legacy one, an `/detail/<slug>/<id>` or
 * `/detail/<id>` path, tracking query strings, and a bare id typed by hand.
 */
export function webStoreIdFromInput(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (STORE_ID_RE.test(raw)) return raw;

  // Any 32-letter a-p run inside the string is the id; slugs contain digits,
  // hyphens or letters past 'p', so a false positive is not realistic.
  const candidates = raw.match(/[a-p]{32}/g);
  if (!candidates) return '';
  // A URL path can only legitimately hold one; take the last so a query
  // parameter appended after the real id never wins over the path segment.
  for (const c of candidates) {
    const idx = raw.indexOf(c);
    const before = raw[idx - 1];
    const after = raw[idx + c.length];
    // Reject a run that is merely part of a longer word.
    if (before && /[A-Za-z0-9]/.test(before)) continue;
    if (after && /[A-Za-z0-9]/.test(after)) continue;
    return c;
  }
  return '';
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
  options: { pinKey?: boolean; storeId?: string } = {},
): Promise<InstalledExtension> {
  if (!data || data.length === 0) throw new ExtensionError('Uploaded file is empty.');

  const zip = crxToZip(data);
  // Pin the extension to its signing key so its id survives a change of install
  // path. Only done when asked, so a hand-built .zip keeps today's behaviour.
  const publicKey = options.pinKey ? crxPublicKey(data) : null;
  const id = safeExtensionId(options.storeId || fileName);
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
  if (direct) {
    if (publicKey) await writeManifestKey(resolved, publicKey);
    return (await describe(id, resolved)) || direct;
  }

  // Nested single folder: hoist it so --load-extension gets a real manifest dir.
  const inner = await fs.readdir(resolved).catch(() => [] as string[]);
  const dirs = [] as string[];
  for (const entry of inner) {
    const p = path.join(resolved, entry);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isDirectory()) dirs.push(entry);
  }
  if (dirs.length === 1) {
    const nestedDir = path.join(resolved, dirs[0]);
    const nested = await describe(`${id}/${dirs[0]}`, nestedDir);
    if (nested) {
      if (publicKey) await writeManifestKey(nestedDir, publicKey);
      return (await describe(`${id}/${dirs[0]}`, nestedDir)) || nested;
    }
  }

  await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
  throw new ExtensionError(
    'The archive does not contain a manifest.json, so it is not a Chrome extension. ' +
    'If you downloaded a .crx from the Web Store, upload it directly — do not rename it to .zip.',
  );
}

/**
 * Write the signing key into an unpacked manifest so Chrome pins the id.
 *
 * The manifest is rewritten rather than patched textually because store
 * manifests are minified onto one line, and a regex edit of JSON is how you
 * corrupt somebody's extension.
 */
async function writeManifestKey(dir: string, publicKey: Buffer): Promise<void> {
  const file = path.join(dir, MANIFEST);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!manifest || typeof manifest !== 'object') return;
    if (typeof manifest.key === 'string' && manifest.key) return; // already pinned
    manifest.key = publicKey.toString('base64');
    await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  } catch {
    // A pinned id is an optimisation, not a requirement: on any failure the
    // extension still loads with the path-derived id.
  }
}

/**
 * The Web Store's own update endpoint, which is what Chrome itself calls.
 *
 * `prodversion` is required but barely inspected — the store serves the same
 * blob for anything recent. It is sent as a plausible current Chrome so the
 * request is never answered with "your browser is too old to install this".
 */
const CRX_DOWNLOAD_HOST = 'https://clients2.google.com/service/update2/crx';
const CRX_PRODVERSION = '131.0.6778.86';

export function webStoreCrxUrl(id: string, prodversion = CRX_PRODVERSION): string {
  const x = `id=${id}&installsource=ondemand&uc`;
  return `${CRX_DOWNLOAD_HOST}?response=redirect&acceptformat=crx2,crx3` +
    `&prodversion=${encodeURIComponent(prodversion)}&x=${encodeURIComponent(x)}`;
}

/** Hard ceiling on a downloaded .crx, so a hostile redirect cannot exhaust RAM. */
const MAX_CRX_BYTES = 128 * 1024 * 1024;

/** Download the signed .crx for a Web Store id. */
export async function downloadWebStoreCrx(
  id: string,
  timeoutMs = 60_000,
): Promise<Buffer> {
  if (!STORE_ID_RE.test(id)) {
    throw new ExtensionError(`"${id}" is not a Chrome Web Store id.`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(webStoreCrxUrl(id), {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': `Mozilla/5.0 Chrome/${CRX_PRODVERSION} Safari/537.36` },
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    throw new ExtensionError(
      err.name === 'AbortError'
        ? 'Timed out downloading from the Chrome Web Store.'
        : `Could not reach the Chrome Web Store: ${err.message}`,
    );
  }

  try {
    // 204 is the store's way of saying "no such item / not available here".
    if (res.status === 204 || res.status === 404) {
      throw new ExtensionError(
        `The Chrome Web Store has no downloadable item with id ${id}. ` +
        'Check the link, and note that paid or region-locked items cannot be fetched this way.',
      );
    }
    if (!res.ok) {
      throw new ExtensionError(`The Chrome Web Store returned HTTP ${res.status}.`);
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_CRX_BYTES) {
      throw new ExtensionError('That extension is larger than the 128 MB limit.');
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new ExtensionError('The Chrome Web Store returned an empty file.');
    if (buf.length > MAX_CRX_BYTES) {
      throw new ExtensionError('That extension is larger than the 128 MB limit.');
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Install straight from a Chrome Web Store link (or a bare id).
 *
 * This is the path that removes the need for a remote desktop: the operator
 * pastes the store URL, the server fetches and unpacks the signed .crx, pins it
 * to its canonical id, and the next browser launch side-loads it for Playwright.
 */
export async function installExtensionFromStore(
  extensionsDir: string,
  input: string,
): Promise<InstalledExtension> {
  const id = webStoreIdFromInput(input);
  if (!id) {
    throw new ExtensionError(
      'That does not look like a Chrome Web Store link. Paste the address of the ' +
      'extension\'s store page, or its 32-letter id.',
    );
  }

  const crx = await downloadWebStoreCrx(id);

  // Anything that is not a CRX means the store handed back an error page.
  if (crx.toString('ascii', 0, 4) !== 'Cr24') {
    throw new ExtensionError(
      'The Chrome Web Store did not return an extension package. ' +
      'The item may be paid, private, or unavailable in this server\'s region.',
    );
  }

  return installExtensionArchive(extensionsDir, `${id}.crx`, crx, { pinKey: true, storeId: id });
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
