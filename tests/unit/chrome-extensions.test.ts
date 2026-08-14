/**
 * Chrome extension discovery / packaging.
 *
 * The things that silently break the whole "use my cookie extension" feature
 * are covered here:
 *
 *   1. `--disable-extensions-except` must NEVER be emitted. Chromium treats it
 *      as "extensions are disabled" for the whole profile, which makes every
 *      install fail with "Installation is not enabled". This file's assertions
 *      are the regression guard for that reported bug — see the block comment
 *      on the `extensionLaunchArgs` suite below for the traced call chain.
 *   2. A .crx is not a .zip. Unzipping one without stripping the CRX header
 *      fails, and telling the user "corrupt archive" sends them the wrong way.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import {
  listExtensions,
  extensionLaunchArgs,
  crxToZip,
  safeExtensionId,
  removeExtension,
  ExtensionError,
} from '../../src/core/ChromeExtensions';
import { unpackedExtensionId } from '../../src/core/RealChrome';

let dir = '';

async function writeExt(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const p = path.join(root, name);
  await fs.mkdir(p, { recursive: true });
  await fs.writeFile(path.join(p, 'manifest.json'), JSON.stringify(manifest));
  return p;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('listExtensions', () => {
  it('returns an empty list for a directory that does not exist', async () => {
    // A fresh install has no extensions dir. That is not an error state, and
    // throwing here would break the status endpoint on first load.
    expect(await listExtensions(path.join(dir, 'nope'))).toEqual([]);
  });

  it('reads name, version and manifest version', async () => {
    await writeExt(dir, 'cookie-editor', {
      manifest_version: 3, name: 'Cookie-Editor', version: '1.2.3',
      description: 'Edit cookies',
    });
    const [ext] = await listExtensions(dir);
    expect(ext.name).toBe('Cookie-Editor');
    expect(ext.version).toBe('1.2.3');
    expect(ext.manifestVersion).toBe(3);
    expect(ext.id).toBe('cookie-editor');
  });

  it('finds the MV3 popup', async () => {
    await writeExt(dir, 'a', {
      manifest_version: 3, name: 'A', version: '1',
      action: { default_popup: 'popup.html' },
    });
    expect((await listExtensions(dir))[0].popup).toBe('popup.html');
  });

  it('finds the MV2 browser_action popup', async () => {
    await writeExt(dir, 'b', {
      manifest_version: 2, name: 'B', version: '1',
      browser_action: { default_popup: '/ui/popup.html' },
    });
    // The leading slash is stripped so the value can be concatenated onto a
    // chrome-extension://<id>/ base without producing a double slash.
    expect((await listExtensions(dir))[0].popup).toBe('ui/popup.html');
  });

  it('finds options_ui.page as well as options_page', async () => {
    await writeExt(dir, 'c', {
      manifest_version: 3, name: 'C', version: '1',
      options_ui: { page: 'options.html' },
    });
    expect((await listExtensions(dir))[0].optionsPage).toBe('options.html');
  });

  it('rescues a zip that nested everything one folder deep', async () => {
    // The single most common upload mistake: the archive contains
    // `my-ext/manifest.json` instead of `manifest.json`.
    await writeExt(path.join(dir, 'outer'), 'inner', {
      manifest_version: 3, name: 'Nested', version: '9',
    });
    const found = await listExtensions(dir);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Nested');
    expect(found[0].id).toBe('outer/inner');
  });

  it('ignores directories without a manifest, and dotfiles', async () => {
    await fs.mkdir(path.join(dir, 'not-an-extension'), { recursive: true });
    await fs.mkdir(path.join(dir, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(dir, 'loose-file.txt'), 'x');
    expect(await listExtensions(dir)).toEqual([]);
  });

  it('does not throw on a corrupt manifest', async () => {
    const p = path.join(dir, 'broken');
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, 'manifest.json'), '{ not json');
    expect(await listExtensions(dir)).toEqual([]);
  });

  it('tolerates a BOM, which hand-edited manifests often have', async () => {
    const p = path.join(dir, 'bom');
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(
      path.join(p, 'manifest.json'),
      '\uFEFF' + JSON.stringify({ manifest_version: 3, name: 'BOM', version: '1' }),
    );
    expect((await listExtensions(dir))[0].name).toBe('BOM');
  });
});

/**
 * THE "Installation is not enabled" REGRESSION GUARD.
 *
 * The operator reported that clicking "Add to Chrome" on a Chrome Web Store page
 * inside the remote browser answered "Installation is not enabled". That string
 * is Chromium's, but the CAUSE was ours: this function used to emit
 * `--disable-extensions-except`. Traced in Chromium's source (main, 2026-08-13):
 *
 *   extension_util.cc:71-74     ExtensionsDisabledViaCommandLine() is true for
 *                               --disable-extensions OR --disable-extensions-except
 *   extension_util.cc:362-367   AreExtensionsDisabled() returns that
 *   extension_registrar.cc:112  Init() forces extensions_enabled = false
 *   crx_installer.cc:404-408    !extensions_enabled_ → CrxInstallError(
 *                               DECLINED, INSTALL_NOT_ENABLED, ...)
 *
 * These tests assert the ABSENCE of that flag. An absence is easy to reintroduce
 * by accident — the flag reads like a safety measure and its old comment claimed
 * it was mandatory — so it is pinned explicitly rather than left implied.
 */
describe('extensionLaunchArgs', () => {
  const two = [
    { id: 'a', dir: '/x/a', name: 'A', version: '1', manifestVersion: 3, description: '', popup: '', optionsPage: '', extensionId: '', storeId: '' },
    { id: 'b', dir: '/x/b', name: 'B', version: '1', manifestVersion: 3, description: '', popup: '', optionsPage: '', extensionId: '', storeId: '' },
  ];

  it('emits nothing when there are no extensions', () => {
    expect(extensionLaunchArgs([])).toEqual([]);
  });

  it('side-loads with --load-extension alone', () => {
    expect(extensionLaunchArgs(two)).toEqual(['--load-extension=/x/a,/x/b']);
  });

  it('NEVER emits --disable-extensions-except, which blocks every install', () => {
    // The whole bug in one assertion. Chromium reads this switch as "extensions
    // are disabled" for the entire profile and then declines every install with
    // INSTALL_NOT_ENABLED, so a webstore "Add to Chrome" could never succeed.
    const args = extensionLaunchArgs(two);
    expect(args.some((a) => a.startsWith('--disable-extensions-except'))).toBe(false);
  });

  it('NEVER emits --disable-extensions either, for the same reason', () => {
    // Same Chromium predicate, other half of the OR. Playwright adds this one by
    // default, which is why IGNORED_DEFAULT_ARGS deletes it; we must not put it
    // back.
    const args = extensionLaunchArgs(two);
    expect(args.some((a) => a === '--disable-extensions' || a.startsWith('--disable-extensions='))).toBe(false);
  });

  it('passes directories verbatim, so Chrome derives the ids we predict', () => {
    // The unpacked id is the hash of the absolute path, so a rewritten or
    // reordered path list would silently change every chrome-extension:// URL
    // the picker builds.
    expect(extensionLaunchArgs(two)[0]).toBe('--load-extension=/x/a,/x/b');
  });
});

describe('crxToZip', () => {
  const zipBody = Buffer.from('PK\x03\x04rest-of-the-zip', 'binary');

  it('passes a plain zip through untouched', () => {
    expect(crxToZip(zipBody).equals(zipBody)).toBe(true);
  });

  it('strips a CRX3 header', () => {
    const header = Buffer.alloc(12 + 5);
    header.write('Cr24', 0, 'ascii');
    header.writeUInt32LE(3, 4);
    header.writeUInt32LE(5, 8); // 5-byte protobuf header
    const crx = Buffer.concat([header, zipBody]);
    expect(crxToZip(crx).equals(zipBody)).toBe(true);
  });

  it('strips a CRX2 header', () => {
    const header = Buffer.alloc(16 + 4 + 6);
    header.write('Cr24', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(4, 8);  // pubkey length
    header.writeUInt32LE(6, 12); // signature length
    const crx = Buffer.concat([header, zipBody]);
    expect(crxToZip(crx).equals(zipBody)).toBe(true);
  });

  it('rejects a file that is neither', () => {
    expect(() => crxToZip(Buffer.from('this is a text file'))).toThrow(ExtensionError);
  });

  it('rejects a truncated CRX rather than returning garbage', () => {
    const header = Buffer.alloc(12);
    header.write('Cr24', 0, 'ascii');
    header.writeUInt32LE(3, 4);
    header.writeUInt32LE(9999, 8);
    expect(() => crxToZip(Buffer.concat([header, zipBody]))).toThrow(/Truncated/i);
  });
});

describe('safeExtensionId', () => {
  it('strips the archive extension', () => {
    expect(safeExtensionId('Cookie-Editor.crx')).toBe('Cookie-Editor');
    expect(safeExtensionId('cookie_editor.zip')).toBe('cookie_editor');
  });

  it('refuses to produce a path traversal', () => {
    // The name arrives from a query parameter, so it is attacker-controlled.
    expect(safeExtensionId('../../etc/passwd')).toBe('passwd');
    expect(safeExtensionId('/etc/shadow')).toBe('shadow');
    expect(safeExtensionId('..')).toBe('extension');
  });

  it('never returns an empty string', () => {
    expect(safeExtensionId('')).toBe('extension');
    expect(safeExtensionId('!!!')).toBe('extension');
  });
});

describe('removeExtension', () => {
  it('removes an installed extension', async () => {
    await writeExt(dir, 'gone', { manifest_version: 3, name: 'Gone', version: '1' });
    expect(await removeExtension(dir, 'gone')).toBe(true);
    expect(await listExtensions(dir)).toEqual([]);
  });

  it('returns false for something that is not there', async () => {
    expect(await removeExtension(dir, 'missing')).toBe(false);
  });

  it('cannot be used to delete a directory outside the extensions dir', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'keepme-'));
    try {
      await removeExtension(dir, `../${path.basename(outside)}`);
      await expect(fs.stat(outside)).resolves.toBeTruthy();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('unpackedExtensionId', () => {
  it('derives Chrome\'s own id from the absolute path', () => {
    // Chrome hashes the path, takes 16 bytes, and maps each nibble 0→a … f→p.
    // Knowing this lets the UI build a chrome-extension:// URL before the
    // extension has ever run — which is what makes "open the popup as a tab"
    // possible without querying the browser.
    const id = unpackedExtensionId('/tmp/probe-chrome-extensions/probe-cookie-tool');
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is stable for the same path and different for another', () => {
    expect(unpackedExtensionId('/a/b')).toBe(unpackedExtensionId('/a/b'));
    expect(unpackedExtensionId('/a/b')).not.toBe(unpackedExtensionId('/a/c'));
  });
});
