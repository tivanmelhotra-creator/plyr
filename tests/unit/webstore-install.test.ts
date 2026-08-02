/**
 * Installing a Chrome extension straight from a Web Store link.
 *
 * The owner's ask was "let me paste the store address and have the server
 * install it", which removes the noVNC/remote-desktop detour entirely. Four
 * things silently ruin that, and each has tests here:
 *
 *   1. **Picking the wrong signing key.** A store .crx is signed by BOTH the
 *      developer and Google's publisher key, so its CRX3 header holds several
 *      proofs. Taking the first one yields a well-formed but WRONG extension
 *      id. The authoritative id is in `signed_header_data`, and the correct key
 *      is the one that hashes to it.
 *   2. **Not pinning the id at all.** Chrome derives an unpacked extension's id
 *      from its absolute path, so every `chrome-extension://<id>/…` URL saved
 *      in a workflow dies the moment the install directory moves. Writing the
 *      signing key into the manifest pins the official id forever.
 *   3. **Believing `manifest.name`.** Nearly every store extension localises
 *      its name, so the raw manifest says `__MSG_appName__`. Showing that in
 *      the panel makes two extensions indistinguishable.
 *   4. **Disagreeing about the id.** ChromeExtensions must report the same id
 *      Chrome will actually use, or "Open here" navigates to a dead URL.
 *
 * Everything here is offline: the CRX fixtures are built in-process, so the
 * suite never depends on Google being reachable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { createHash, generateKeyPairSync } from 'crypto';
import { execFileSync } from 'child_process';

import {
  webStoreIdFromInput,
  webStoreCrxUrl,
  extensionIdFromKey,
  crxPublicKey,
  installExtensionArchive,
  listExtensions,
  crxToZip,
} from '../../src/core/ChromeExtensions';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-ext-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ── protobuf/CRX fixture builders ──────────────────────────────────────────

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

/** Length-delimited protobuf field (wire type 2). */
function field(num: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);
}

function derPublicKey(): Buffer {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
}

/** Raw 16 bytes Chrome hashes into an extension id. */
function crxIdBytes(pubKey: Buffer): Buffer {
  return createHash('sha256').update(pubKey).digest().subarray(0, 16);
}

/**
 * Build a CRX3 whose header carries several proofs, exactly like a real store
 * download, with `signed_header_data` naming which one is authoritative.
 */
function buildCrx3(zip: Buffer, keys: Buffer[], signedKey: Buffer | null): Buffer {
  const proofs = keys.map((k) =>
    field(2, Buffer.concat([field(1, k), field(2, Buffer.from('fake-signature'))])),
  );
  const parts = [...proofs];
  if (signedKey) {
    parts.push(field(10000, field(1, crxIdBytes(signedKey))));
  }
  const header = Buffer.concat(parts);

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'ascii');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

/** A real zip, because installExtensionArchive shells out to `unzip`. */
function buildZip(files: Record<string, string>): Buffer {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stage = path.join(os.tmpdir(), `zip-src-${suffix}`);
  const out = path.join(os.tmpdir(), `zip-${suffix}.zip`);
  try {
    for (const [rel, body] of Object.entries(files)) {
      const target = path.join(stage, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    execFileSync('zip', ['-q', '-r', out, '.'], { cwd: stage });
    return readFileSync(out);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────

describe('webStoreIdFromInput', () => {
  const ID = 'okpidcojinmlaakglciglbpcpajaibco';

  it('accepts the /detail/<slug>/<id> form the store shows today', () => {
    expect(webStoreIdFromInput(`https://chromewebstore.google.com/detail/j2team-cookies/${ID}`))
      .toBe(ID);
  });

  it('accepts the share form with no slug and a tracking query', () => {
    expect(webStoreIdFromInput(
      `https://chromewebstore.google.com/detail/${ID}?utm_source=item-share-cb`,
    )).toBe(ID);
  });

  it('accepts the legacy chrome.google.com/webstore URL', () => {
    expect(webStoreIdFromInput(
      `https://chrome.google.com/webstore/detail/j2team-cookies/${ID}?hl=en`,
    )).toBe(ID);
  });

  it('accepts a bare id typed by hand, with stray whitespace', () => {
    expect(webStoreIdFromInput(`  ${ID}  `)).toBe(ID);
  });

  it('ignores a trailing path segment after the id', () => {
    expect(webStoreIdFromInput(`https://chromewebstore.google.com/detail/x/${ID}/reviews`)).toBe(ID);
  });

  it('returns empty for a link that has no id in it', () => {
    expect(webStoreIdFromInput('https://chromewebstore.google.com/category/extensions')).toBe('');
  });

  it('returns empty for junk, rather than guessing', () => {
    expect(webStoreIdFromInput('')).toBe('');
    expect(webStoreIdFromInput('not a url')).toBe('');
    expect(webStoreIdFromInput('https://example.com/')).toBe('');
  });

  it('rejects a 32-letter run that contains letters past p', () => {
    // Extension ids are base-16 remapped to a-p; 'z' can never appear.
    expect(webStoreIdFromInput('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe('');
  });

  it('does not pick an id out of the middle of a longer word', () => {
    expect(webStoreIdFromInput(`x${'a'.repeat(32)}x`)).toBe('');
  });
});

describe('webStoreCrxUrl', () => {
  it('asks for a redirect and accepts both CRX formats', () => {
    const url = webStoreCrxUrl('okpidcojinmlaakglciglbpcpajaibco');
    expect(url).toContain('response=redirect');
    expect(url).toContain('acceptformat=crx2,crx3');
  });

  it('url-encodes the id inside the x parameter', () => {
    // `x` carries its own `k=v&k=v` string, so its separators must be escaped
    // or the outer query eats them.
    const url = webStoreCrxUrl('okpidcojinmlaakglciglbpcpajaibco');
    expect(url).toContain('x=id%3Dokpidcojinmlaakglciglbpcpajaibco%26installsource%3Dondemand%26uc');
  });
});

describe('extensionIdFromKey', () => {
  it('maps the sha256 prefix into the a-p alphabet', () => {
    const id = extensionIdFromKey(Buffer.from('anything'));
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is deterministic, and different for a different key', () => {
    expect(extensionIdFromKey(Buffer.from('a'))).toBe(extensionIdFromKey(Buffer.from('a')));
    expect(extensionIdFromKey(Buffer.from('a'))).not.toBe(extensionIdFromKey(Buffer.from('b')));
  });
});

describe('crxPublicKey', () => {
  it('picks the key named by signed_header_data, not merely the first one', () => {
    const googleKey = derPublicKey();   // publisher proof, listed first
    const authorKey = derPublicKey();   // the extension's real key
    const crx = buildCrx3(Buffer.from('PK\x03\x04zip'), [googleKey, authorKey], authorKey);

    const found = crxPublicKey(crx);
    expect(found).not.toBeNull();
    expect(extensionIdFromKey(found!)).toBe(extensionIdFromKey(authorKey));
    expect(extensionIdFromKey(found!)).not.toBe(extensionIdFromKey(googleKey));
  });

  it('accepts a lone self-signed proof with no signed header', () => {
    const key = derPublicKey();
    const crx = buildCrx3(Buffer.from('PK\x03\x04zip'), [key], null);
    expect(extensionIdFromKey(crxPublicKey(crx)!)).toBe(extensionIdFromKey(key));
  });

  it('refuses to guess when several proofs exist and none is named', () => {
    const crx = buildCrx3(Buffer.from('PK\x03\x04zip'), [derPublicKey(), derPublicKey()], null);
    expect(crxPublicKey(crx)).toBeNull();
  });

  it('returns null when no proof matches the signed id', () => {
    // A tampered header must not silently pin some other extension's id.
    const crx = buildCrx3(Buffer.from('PK\x03\x04zip'), [derPublicKey()], derPublicKey());
    expect(crxPublicKey(crx)).toBeNull();
  });

  it('returns null for CRX2 and for a plain zip', () => {
    const crx2 = Buffer.alloc(20);
    crx2.write('Cr24', 0, 'ascii');
    crx2.writeUInt32LE(2, 4);
    expect(crxPublicKey(crx2)).toBeNull();
    expect(crxPublicKey(Buffer.from('PK\x03\x04'))).toBeNull();
  });

  it('does not throw on a truncated or garbage header', () => {
    const bad = Buffer.alloc(16);
    bad.write('Cr24', 0, 'ascii');
    bad.writeUInt32LE(3, 4);
    bad.writeUInt32LE(0xffff, 8); // claims a header far longer than the file
    expect(() => crxPublicKey(bad)).not.toThrow();
    expect(crxPublicKey(bad)).toBeNull();
  });
});

describe('installing a store .crx', () => {
  const manifest = {
    manifest_version: 3,
    name: '__MSG_appName__',
    description: '__MSG_appDescription__',
    version: '1.0.5',
    default_locale: 'en',
    action: { default_popup: 'popup.html' },
  };

  const messages = {
    appName: { message: 'J2TEAM Cookies' },
    appDescription: { message: 'Export and import cookies.' },
  };

  function storeCrx(key: Buffer) {
    const zip = buildZip({
      'manifest.json': JSON.stringify(manifest),
      'popup.html': '<html></html>',
      '_locales/en/messages.json': JSON.stringify(messages),
    });
    return buildCrx3(zip, [derPublicKey(), key], key);
  }

  it('pins the manifest key so Chrome uses the official id', async () => {
    const key = derPublicKey();
    const id = extensionIdFromKey(key);

    const ext = await installExtensionArchive(dir, `${id}.crx`, storeCrx(key), {
      pinKey: true,
      storeId: id,
    });

    expect(ext.extensionId).toBe(id);
    expect(ext.storeId).toBe(id);

    const written = JSON.parse(await fs.readFile(path.join(ext.dir, 'manifest.json'), 'utf8'));
    expect(Buffer.from(written.key, 'base64').equals(key)).toBe(true);
  });

  it('resolves __MSG_ placeholders so the panel shows a real name', async () => {
    const key = derPublicKey();
    const ext = await installExtensionArchive(dir, 'x.crx', storeCrx(key), { pinKey: true });

    expect(ext.name).toBe('J2TEAM Cookies');
    expect(ext.description).toBe('Export and import cookies.');
  });

  it('reports the same name again when the directory is re-listed', async () => {
    // describe() runs on both paths; a resolver that only worked at install
    // time would make the name revert to __MSG_appName__ after a restart.
    const key = derPublicKey();
    await installExtensionArchive(dir, 'x.crx', storeCrx(key), { pinKey: true });

    const [listed] = await listExtensions(dir);
    expect(listed.name).toBe('J2TEAM Cookies');
    expect(listed.extensionId).toBe(extensionIdFromKey(key));
  });

  it('leaves the id unpinned when the caller does not ask for it', async () => {
    const key = derPublicKey();
    const ext = await installExtensionArchive(dir, 'x.crx', storeCrx(key));

    expect(ext.extensionId).toBe('');
    const written = JSON.parse(await fs.readFile(path.join(ext.dir, 'manifest.json'), 'utf8'));
    expect(written.key).toBeUndefined();
  });

  it('does not overwrite a key the extension already declares', async () => {
    const own = derPublicKey();
    const signing = derPublicKey();
    const zip = buildZip({
      'manifest.json': JSON.stringify({ ...manifest, key: own.toString('base64') }),
      '_locales/en/messages.json': JSON.stringify(messages),
    });
    const ext = await installExtensionArchive(
      dir, 'x.crx', buildCrx3(zip, [signing], signing), { pinKey: true },
    );

    expect(ext.extensionId).toBe(extensionIdFromKey(own));
  });

  it('reinstalling the same id replaces rather than duplicates', async () => {
    const key = derPublicKey();
    const id = extensionIdFromKey(key);
    await installExtensionArchive(dir, `${id}.crx`, storeCrx(key), { pinKey: true, storeId: id });
    await installExtensionArchive(dir, `${id}.crx`, storeCrx(key), { pinKey: true, storeId: id });

    expect(await listExtensions(dir)).toHaveLength(1);
  });

  it('names the directory after the store id, not the download filename', async () => {
    const key = derPublicKey();
    const id = extensionIdFromKey(key);
    const ext = await installExtensionArchive(
      dir, 'download (1).crx', storeCrx(key), { pinKey: true, storeId: id },
    );

    expect(ext.id).toBe(id);
    expect(path.basename(ext.dir)).toBe(id);
  });

  it('still unpacks when the crx header names a key we cannot verify', async () => {
    // A pinned id is a nicety; failing the whole install over it would be worse
    // than falling back to the path-derived id.
    const zip = buildZip({ 'manifest.json': JSON.stringify({ ...manifest, default_locale: undefined }) });
    const crx = buildCrx3(zip, [derPublicKey()], derPublicKey());

    const ext = await installExtensionArchive(dir, 'x.crx', crx, { pinKey: true });
    expect(ext.extensionId).toBe('');
    expect(ext.version).toBe('1.0.5');
  });

  it('produces a zip the existing crxToZip agrees with', async () => {
    const key = derPublicKey();
    const crx = storeCrx(key);
    expect(crxToZip(crx).toString('ascii', 0, 2)).toBe('PK');
  });
});
