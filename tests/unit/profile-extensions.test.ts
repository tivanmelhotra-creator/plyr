/**
 * Extensions installed from INSIDE Chrome ("Add to Chrome") live in the
 * profile, not in the side-load directory. The "Open here" list used to read
 * only the directory, so these never showed up -- not even after a restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { listProfileExtensions } from '../../src/core/ChromeExtensions';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

let root: string;

async function install(id: string, version: string, manifest: Record<string, unknown>) {
  const dir = path.join(root, 'Default', 'Extensions', id, version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version, ...manifest }));
}

async function prefs(file: string, settings: Record<string, unknown>) {
  await fs.mkdir(path.join(root, 'Default'), { recursive: true });
  await fs.writeFile(path.join(root, 'Default', file), JSON.stringify({ extensions: { settings } }));
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-ext-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('listProfileExtensions', () => {
  it('finds an extension added inside Chrome, with its popup', async () => {
    await install(ID_A, '1.0_0', { name: 'Added Later', action: { default_popup: 'popup.html' } });
    await prefs('Secure Preferences', { [ID_A]: { state: 1, location: 1, path: `${ID_A}/1.0_0` } });
    const list = await listProfileExtensions(root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: ID_A, name: 'Added Later', popup: 'popup.html', extensionId: ID_A });
  });

  it('skips disabled, component and excluded (already side-loaded) extensions', async () => {
    for (const id of [ID_A, ID_B, ID_C]) await install(id, '1.0_0', { name: id.slice(0, 1) });
    await prefs('Secure Preferences', {
      [ID_A]: { state: 0 },
      [ID_B]: { state: 1, location: 5 },
      [ID_C]: { state: 1, location: 1 },
    });
    expect((await listProfileExtensions(root)).map((e) => e.id)).toEqual([ID_C]);
    expect(await listProfileExtensions(root, [ID_C])).toEqual([]);
  });

  it('takes the newest version dir when prefs do not name one, and ignores junk', async () => {
    await install(ID_A, '1.9_0', { name: 'Old' });
    await install(ID_A, '1.10_0', { name: 'New' });
    await fs.mkdir(path.join(root, 'Default', 'Extensions', 'Temp'), { recursive: true });
    const list = await listProfileExtensions(root);
    expect(list.map((e) => e.name)).toEqual(['New']);
  });

  it('is an empty list, not an error, when there is no profile', async () => {
    expect(await listProfileExtensions(path.join(root, 'missing'))).toEqual([]);
  });
});
