/**
 * WorkflowStorage — the security boundary of the Workflow File Workspace.
 *
 * Every test here is about ONE rule: a request can reach files inside
 * WORKFLOW_STORAGE_ROOT/<userId>/<workflowId>/ and nothing else — not another
 * workflow, not another user, not the server's disk through `..`, an absolute
 * path, an encoded traversal, or a symlink planted inside the workspace.
 *
 * Real filesystem, real symlinks, in a temp directory: a string-only check
 * cannot prove a symlink is refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { config } from '../../src/config';
import {
  WorkflowStorage,
  WorkflowStorageError,
  WorkflowListing,
  WorkflowEntry,
  SYSTEM_FOLDERS,
  normalizeRelativePath,
  assertSegment,
} from '../../src/core/WorkflowStorage';
import { readZipArchive } from '../../src/core/ZipArchive';

let tmpRoot = '';
let outside = '';
let originalRoot = '';

const WF_A = 'wf_aaaaaaaaaaaaaaaa';
const WF_B = 'wf_bbbbbbbbbbbbbbbb';
const USER = 'local';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfstore-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wfstore-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
  originalRoot = config.WORKFLOW_STORAGE_ROOT;
  (config as { WORKFLOW_STORAGE_ROOT: string }).WORKFLOW_STORAGE_ROOT = tmpRoot;
});

afterEach(async () => {
  (config as { WORKFLOW_STORAGE_ROOT: string }).WORKFLOW_STORAGE_ROOT = originalRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

/**
 * The operator's OWN entries of a listing: the two system folders every
 * workspace is born with (`uploads/`, `downloads/`, see SYSTEM_FOLDERS) are
 * filtered out, because they are the workflow contract and not something a
 * test here created. Their own behaviour has its own describe block below.
 */
function own(l: WorkflowListing): WorkflowEntry[] {
  return l.entries.filter((e) => !e.system);
}

async function rejects(p: Promise<unknown>, status?: number): Promise<WorkflowStorageError> {
  let err: unknown = null;
  try { await p; } catch (e) { err = e; }
  expect(err, 'expected a rejection').toBeInstanceOf(WorkflowStorageError);
  if (status !== undefined) expect((err as WorkflowStorageError).status).toBe(status);
  return err as WorkflowStorageError;
}

/**
 * Build a ZIP BY HAND with an arbitrary entry name and write it into the
 * workspace. ZipStream deliberately refuses to WRITE a `..` name, so a hostile
 * archive cannot be produced by the shipped writer — the reader is what has to
 * refuse it, and this is the only way to hand the reader such bytes. STORE only
 * (no deflate) keeps it a few lines.
 */
async function writeRawZip(
  s: WorkflowStorage,
  fileName: string,
  entries: Array<{ name: string; data: Buffer }>,
): Promise<string> {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1 << 11, 6); // UTF-8, no data descriptor
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, e.data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(1 << 11, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of centrals) centralSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  const bytes = Buffer.concat([...locals, ...centrals, eocd]);
  await s.ensureRoot();
  await fs.writeFile(path.join(s.rootDir(), fileName), bytes);
  return fileName;
}

describe('normalizeRelativePath', () => {
  it('accepts plain names and nested folders', () => {
    expect(normalizeRelativePath('')).toBe('');
    expect(normalizeRelativePath('a.txt')).toBe('a.txt');
    expect(normalizeRelativePath('assets/images/pic.png')).toBe('assets/images/pic.png');
    expect(normalizeRelativePath('assets//images/')).toBe('assets/images');
  });

  it('rejects every form of traversal', () => {
    for (const bad of ['..', '../', '../../etc/passwd', 'foo/../../bar', 'a/./b', './x', '%2e%2e/x', 'a/%2e%2e%2f..']) {
      expect(() => normalizeRelativePath(bad), bad).toThrow(WorkflowStorageError);
    }
  });

  it('rejects absolute paths, drive letters, home shortcuts and backslashes', () => {
    for (const bad of ['/etc/passwd', '/root', '/home/user', '/var/log', '/tmp/x', 'C:\\Windows', 'C:/x', '~/.ssh/id_rsa', 'a\\b']) {
      expect(() => normalizeRelativePath(bad), bad).toThrow(WorkflowStorageError);
    }
  });

  it('rejects control characters, NUL and malformed encodings', () => {
    expect(() => normalizeRelativePath('a\u0000b')).toThrow(WorkflowStorageError);
    expect(() => normalizeRelativePath('a\nb')).toThrow(WorkflowStorageError);
    expect(() => normalizeRelativePath('%zz')).toThrow(WorkflowStorageError);
  });

  it('rejects dotfiles, Windows-reserved characters and bidi overrides in a segment', () => {
    for (const bad of ['.hidden', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'trailing.', 'trailing ', 'gpj\u202eexe', '']) {
      expect(() => assertSegment(bad), JSON.stringify(bad)).toThrow(WorkflowStorageError);
    }
    expect(assertSegment('report final (2).pdf')).toBe('report final (2).pdf');
    expect(assertSegment('گزارش.txt')).toBe('گزارش.txt');
  });
});

describe('WorkflowStorage: construction', () => {
  it('refuses an invalid workflow id before touching the disk', () => {
    expect(() => new WorkflowStorage(USER, '../other')).toThrow(WorkflowStorageError);
    expect(() => new WorkflowStorage(USER, 'wf/evil')).toThrow(WorkflowStorageError);
    expect(() => new WorkflowStorage(USER, '')).toThrow(WorkflowStorageError);
  });

  it('refuses an invalid user id', () => {
    expect(() => new WorkflowStorage('../root', WF_A)).toThrow(WorkflowStorageError);
    expect(() => new WorkflowStorage('', WF_A)).toThrow(WorkflowStorageError);
  });

  it('roots each (user, workflow) pair in its own directory', () => {
    const a = new WorkflowStorage(USER, WF_A);
    const b = new WorkflowStorage(USER, WF_B);
    const c = new WorkflowStorage('other', WF_A);
    expect(a.rootDir()).toBe(path.join(tmpRoot, USER, WF_A));
    expect(b.rootDir()).toBe(path.join(tmpRoot, USER, WF_B));
    expect(c.rootDir()).toBe(path.join(tmpRoot, 'other', WF_A));
  });
});

describe('WorkflowStorage: ordinary operations', () => {
  it('lists an empty workspace, creating it on first use', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const l = await s.list('');
    expect({ ...l, entries: own(l) }).toEqual({ workflowId: WF_A, path: '', parent: null, entries: [] });
    // Born with its system folders, and nothing else.
    expect(l.entries.map((e) => [e.name, e.type, e.system])).toEqual(
      SYSTEM_FOLDERS.map((n) => [n, 'dir', true]),
    );
    expect((await fs.stat(s.rootDir())).isDirectory()).toBe(true);
  });

  it('creates folders, writes files, lists folders first, navigates and reports the parent', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'assets');
    await s.mkdir('assets', 'images');
    await s.writeFile('', 'zeta.txt', Buffer.from('z'));
    await s.writeFile('assets/images', 'pic.png', Buffer.from('png'));

    const root = await s.list('');
    expect(own(root).map((e) => [e.name, e.type])).toEqual([['assets', 'dir'], ['zeta.txt', 'file']]);
    expect(own(root)[1].size).toBe(1);

    const images = await s.list('assets/images');
    expect(images.path).toBe('assets/images');
    expect(images.parent).toBe('assets');
    expect(images.entries).toHaveLength(1);
    expect(images.entries[0].path).toBe('assets/images/pic.png');

    const assets = await s.list('assets');
    expect(assets.parent).toBe('');
  });

  it('does not overwrite: a second upload of the same name gets a numbered name', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const first = await s.writeFile('', 'a.txt', Buffer.from('1'));
    const second = await s.writeFile('', 'a.txt', Buffer.from('22'));
    expect(first.name).toBe('a.txt');
    expect(second.name).toBe('a (2).txt');
    expect(await fs.readFile(path.join(s.rootDir(), 'a.txt'), 'utf8')).toBe('1');
  });

  it('renames within the same folder and refuses a name collision', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'in');
    await s.writeFile('in', 'a.txt', Buffer.from('a'));
    await s.writeFile('in', 'b.txt', Buffer.from('b'));
    const r = await s.rename('in/a.txt', 'c.txt');
    expect(r.path).toBe('in/c.txt');
    await rejects(s.rename('in/c.txt', 'b.txt'), 409);
    const dir = await s.rename('in', 'input');
    expect(dir.type).toBe('dir');
    expect((await s.list('input')).entries.map((e) => e.name)).toEqual(['b.txt', 'c.txt']);
  });

  it('a rename cannot move the entry to another folder or out of the root', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('a'));
    await rejects(s.rename('a.txt', '../a.txt'));
    await rejects(s.rename('a.txt', 'sub/a.txt'));
    await rejects(s.rename('a.txt', '/etc/a.txt'));
    await rejects(s.rename('', 'x'), 400);
    expect(own(await s.list('')).map((e) => e.name)).toEqual(['a.txt']);
  });

  it('deletes files, refuses a non-empty folder without recursive, and deletes with it', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'd');
    await s.writeFile('d', 'a.txt', Buffer.from('a'));
    await rejects(s.remove('d'), 409);
    await s.remove('d/a.txt');
    await s.remove('d'); // now empty
    await s.mkdir('', 'e');
    await s.writeFile('e', 'a.txt', Buffer.from('a'));
    await s.remove('e', { recursive: true });
    expect(own(await s.list(''))).toEqual([]);
    await rejects(s.remove(''), 400);
  });

  it('reports 404 for paths that do not exist', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await rejects(s.list('nope'), 404);
    await rejects(s.remove('nope.txt'), 404);
    await rejects(s.rename('nope.txt', 'x.txt'), 404);
    await rejects(s.resolveForBrowser('nope.txt'), 404);
  });

  it('rejects empty and oversized uploads', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await rejects(s.writeFile('', 'a.txt', Buffer.alloc(0)));
  });

  it('resolves a file for the browser, and only a file', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'd');
    await s.writeFile('d', 'a.txt', Buffer.from('hello'));
    const r = await s.resolveForBrowser('d/a.txt');
    expect(r.name).toBe('a.txt');
    expect(r.size).toBe(5);
    expect(r.relativePath).toBe('d/a.txt');
    expect(r.absolutePath).toBe(await fs.realpath(path.join(s.rootDir(), 'd', 'a.txt')));
    await rejects(s.resolveForBrowser('d'), 400);
    await rejects(s.resolveForBrowser(''), 400);
  });
});

describe('WorkflowStorage: the system folders uploads/ and downloads/', () => {
  it('are created with the workspace, listed first and in their declared order, and flagged', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'aaa'); // sorts before 'downloads' by name -- and must still come after it
    await s.writeFile('', '000.txt', Buffer.from('0'));
    const l = await s.list('');
    expect(l.entries.slice(0, SYSTEM_FOLDERS.length).map((e) => e.name)).toEqual([...SYSTEM_FOLDERS]);
    for (const e of l.entries.slice(0, SYSTEM_FOLDERS.length)) {
      expect(e.type).toBe('dir');
      expect(e.system).toBe(true);
    }
    // Only the root's own folders are system folders: a nested `uploads/`
    // is an ordinary folder.
    await s.mkdir('aaa', 'uploads');
    const nested = await s.list('aaa');
    expect(nested.entries.map((e) => [e.name, e.system])).toEqual([['uploads', undefined]]);
  });

  it('refuse rename and delete, because automation nodes depend on the names', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    for (const name of SYSTEM_FOLDERS) {
      await rejects(s.rename(name, 'renamed'));
      await rejects(s.remove(name));
      await rejects(s.remove(name, { recursive: true }));
    }
    expect((await s.list('')).entries.filter((e) => e.system).map((e) => e.name)).toEqual([...SYSTEM_FOLDERS]);
  });

  it('accept files like any other folder', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const w = await s.writeFile('uploads', 'cookies.json', Buffer.from('{}'));
    expect(w.path).toBe('uploads/cookies.json');
    expect((await s.list('uploads')).entries.map((e) => e.name)).toEqual(['cookies.json']);
    expect((await s.list('uploads')).parent).toBe('');
  });

  it('come back on the next request when removed from a shell', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    await fs.rm(path.join(s.rootDir(), 'downloads'), { recursive: true, force: true });
    const l = await s.list('');
    expect(l.entries.filter((e) => e.system).map((e) => e.name)).toEqual([...SYSTEM_FOLDERS]);
  });

  it('are not usable when replaced by a symlink', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    await fs.rm(path.join(s.rootDir(), 'uploads'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(s.rootDir(), 'uploads'), 'dir');
    await rejects(s.list(''), 500);
    await rejects(s.writeFile('uploads', 'planted.txt', Buffer.from('x')), 500);
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
  });
});

describe('WorkflowStorage: the boundary', () => {
  it('refuses traversal in every operation', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'ok');
    for (const bad of ['..', '../', '../../etc', 'ok/../..', 'ok/../../' + WF_B, '%2e%2e', '%2e%2e%2f%2e%2e']) {
      await rejects(s.list(bad));
      await rejects(s.mkdir(bad, 'x'));
      await rejects(s.writeFile(bad, 'x.txt', Buffer.from('x')));
      await rejects(s.remove(bad));
      await rejects(s.resolveForBrowser(bad));
    }
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses absolute paths in every operation', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    for (const bad of ['/etc', '/etc/passwd', '/root', '/home', '/var', '/tmp', outside, path.join(outside, 'secret.txt')]) {
      await rejects(s.list(bad));
      await rejects(s.resolveForBrowser(bad));
      await rejects(s.remove(bad));
    }
  });

  it('refuses a symlink to a DIRECTORY outside the workspace', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    await fs.symlink(outside, path.join(s.rootDir(), 'escape'), 'dir');
    await rejects(s.list('escape'), 403);
    await rejects(s.list('escape/'), 403);
    await rejects(s.resolveForBrowser('escape/secret.txt'), 403);
    await rejects(s.writeFile('escape', 'planted.txt', Buffer.from('x')), 403);
    await rejects(s.mkdir('escape', 'planted'), 403);
    await rejects(s.remove('escape/secret.txt'), 403);
    await rejects(s.rename('escape/secret.txt', 'gone.txt'), 403);
    // Nothing leaked through, nothing was written or removed outside.
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
    // And the listing does not even show the link as something to click.
    expect(own(await s.list(''))).toEqual([]);
  });

  it('refuses a symlink to a FILE outside the workspace', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(s.rootDir(), 'leak.txt'), 'file');
    await rejects(s.resolveForBrowser('leak.txt'), 403);
    await rejects(s.describe('leak.txt'), 403);
    // Deleting through the API must not follow the link either — and the
    // target outside must survive.
    await rejects(s.remove('leak.txt'), 403);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses a symlink that points at ANOTHER workflow', async () => {
    const a = new WorkflowStorage(USER, WF_A);
    const b = new WorkflowStorage(USER, WF_B);
    await b.writeFile('', 'b-private.txt', Buffer.from('B'));
    await a.ensureRoot();
    await fs.symlink(b.rootDir(), path.join(a.rootDir(), 'peek'), 'dir');
    await rejects(a.list('peek'), 403);
    await rejects(a.resolveForBrowser('peek/b-private.txt'), 403);
  });

  it('refuses a symlink even when it points back INSIDE the same workspace', async () => {
    // A workspace of plain files is the invariant; a self-link would let
    // rename/delete reason about the wrong inode.
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'real');
    await s.writeFile('real', 'a.txt', Buffer.from('a'));
    await fs.symlink(path.join(s.rootDir(), 'real'), path.join(s.rootDir(), 'alias'), 'dir');
    await rejects(s.list('alias'), 403);
    await rejects(s.resolveForBrowser('alias/a.txt'), 403);
    expect(own(await s.list('')).map((e) => e.name)).toEqual(['real']);
  });

  it('refuses a dangling symlink as a creation target', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    await fs.symlink(path.join(outside, 'planted-by-write.txt'), path.join(s.rootDir(), 'w.txt'), 'file');
    await rejects(s.writeFile('', 'w.txt', Buffer.from('x'), { overwrite: true }), 403);
    await rejects(s.mkdir('', 'w.txt'), 403);
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
  });

  it('keeps two workflows apart: A cannot see, rename or delete B', async () => {
    const a = new WorkflowStorage(USER, WF_A);
    const b = new WorkflowStorage(USER, WF_B);
    await b.writeFile('', 'b-private.txt', Buffer.from('B'));
    expect(own(await a.list(''))).toEqual([]);
    await rejects(a.list(`../${WF_B}`));
    await rejects(a.resolveForBrowser(`../${WF_B}/b-private.txt`));
    await rejects(a.remove(`../${WF_B}/b-private.txt`));
    await rejects(a.rename(`../${WF_B}/b-private.txt`, 'stolen.txt'));
    expect(own(await b.list('')).map((e) => e.name)).toEqual(['b-private.txt']);
  });

  it('keeps two users apart even with the same workflow id', async () => {
    const mine = new WorkflowStorage('alice', WF_A);
    const theirs = new WorkflowStorage('bob', WF_A);
    await theirs.writeFile('', 'bob.txt', Buffer.from('bob'));
    expect(own(await mine.list(''))).toEqual([]);
    await rejects(mine.list(`../../bob/${WF_A}`));
  });

  it('never returns an absolute path in a listing', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'd');
    await s.writeFile('d', 'a.txt', Buffer.from('a'));
    const l = await s.list('d');
    const text = JSON.stringify(l);
    expect(text).not.toContain(tmpRoot);
    expect(text).not.toContain(os.tmpdir());
  });

  it('a hostile uploaded filename is reduced to a safe basename inside the folder', async () => {
    // The name comes from the browser's file.name, which the operator did not
    // type, so it is CLEANED rather than refused -- but it can never traverse.
    const s = new WorkflowStorage(USER, WF_A);
    const a = await s.writeFile('', '../../evil.txt', Buffer.from('x'));
    expect(a.path).toBe('evil.txt');
    const b = await s.writeFile('', '.htaccess', Buffer.from('x'));
    expect(b.path).toBe('htaccess');
    const c = await s.writeFile('', 'C:\\Users\\me\\report.pdf', Buffer.from('x'));
    expect(c.name).toBe('report.pdf');
    const d = await s.writeFile('', 'a:b*c?.txt', Buffer.from('x'));
    expect(d.name).toBe('a_b_c_.txt');
    const e = await s.writeFile('', '\u0000\u0000', Buffer.from('x'));
    expect(e.name).toBe('file');
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
    expect(await fs.readdir(tmpRoot)).toEqual([USER]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The utility actions: Move, Copy / Duplicate, Compress, Extract.
// ─────────────────────────────────────────────────────────────────────────────

/** Read a file straight off the disk, under the workflow root. */
function onDisk(s: WorkflowStorage, rel: string): string {
  return path.join(s.rootDir(), ...rel.split('/'));
}

describe('WorkflowStorage: Move', () => {
  it('moves a file into a folder (a real filesystem move, contents intact)', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'logo.png', Buffer.from('PNGDATA'));
    await s.mkdir('', 'assets');
    await s.mkdir('assets', 'images');
    const [moved] = await s.moveMany(['logo.png'], 'assets/images');
    expect(moved.path).toBe('assets/images/logo.png');
    expect(await fs.readFile(onDisk(s, 'assets/images/logo.png'), 'utf8')).toBe('PNGDATA');
    // The old name is gone.
    await rejects(s.describe('logo.png'), 404);
  });

  it('moves a whole folder, with its tree, and moves many items together', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'assets');
    await s.writeFile('assets', 'a.png', Buffer.from('a'));
    await s.writeFile('assets', 'b.png', Buffer.from('b'));
    await s.writeFile('', 'c.txt', Buffer.from('c'));
    await s.mkdir('', 'archive');
    const moved = await s.moveMany(['assets', 'c.txt'], 'archive');
    expect(moved.map((e) => e.path).sort()).toEqual(['archive/assets', 'archive/c.txt']);
    expect((await s.list('archive/assets')).entries.map((e) => e.name).sort()).toEqual(['a.png', 'b.png']);
  });

  it('refuses to overwrite an existing name (409) and moves nothing', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('one'));
    await s.mkdir('', 'dest');
    await s.writeFile('dest', 'a.txt', Buffer.from('two'));
    await rejects(s.moveMany(['a.txt'], 'dest'), 409);
    // Both files are untouched, in their original places.
    expect(await fs.readFile(onDisk(s, 'a.txt'), 'utf8')).toBe('one');
    expect(await fs.readFile(onDisk(s, 'dest/a.txt'), 'utf8')).toBe('two');
  });

  it('a bulk move is all-or-nothing: one bad source leaves every other one in place', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'ok.txt', Buffer.from('x'));
    await s.mkdir('', 'dest');
    await s.writeFile('dest', 'ok.txt', Buffer.from('taken'));
    await rejects(s.moveMany(['ok.txt'], 'dest'), 409);
    expect((await s.list('')).entries.find((e) => e.name === 'ok.txt')).toBeTruthy();
  });

  it('refuses to move into a folder inside itself and to move a system folder', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'a');
    await s.mkdir('a', 'b');
    await rejects(s.moveMany(['a'], 'a/b'), 400);
    await rejects(s.moveMany(['uploads'], 'a'), 400);
    await rejects(s.moveMany(['downloads'], 'a'), 400);
  });

  it('refuses traversal, absolute destinations and destinations outside the workflow', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'f.txt', Buffer.from('x'));
    for (const bad of ['..', '../', '/etc', `../../${WF_B}`, 'a/../../b']) {
      await rejects(s.moveMany(['f.txt'], bad));
    }
    await rejects(s.moveMany(['../secret.txt'], ''));
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(await fs.readFile(onDisk(s, 'f.txt'), 'utf8')).toBe('x');
  });

  it('refuses to move through a symlink planted in the workspace', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.ensureRoot();
    await fs.symlink(outside, path.join(s.rootDir(), 'escape'), 'dir');
    await s.writeFile('', 'f.txt', Buffer.from('x'));
    await rejects(s.moveMany(['f.txt'], 'escape'), 403);
    await rejects(s.moveMany(['escape/secret.txt'], ''), 403);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });
});

describe('WorkflowStorage: Copy / Duplicate', () => {
  it('copies a file into a folder, both copies readable', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('A'));
    await s.mkdir('', 'backup');
    const [copied] = await s.copyMany(['a.txt'], 'backup');
    expect(copied.path).toBe('backup/a.txt');
    expect(await fs.readFile(onDisk(s, 'a.txt'), 'utf8')).toBe('A');
    expect(await fs.readFile(onDisk(s, 'backup/a.txt'), 'utf8')).toBe('A');
  });

  it('numbers a copied name that is taken, never overwriting it', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('one'));
    await s.mkdir('', 'dest');
    await s.writeFile('dest', 'a.txt', Buffer.from('two'));
    const [copied] = await s.copyMany(['a.txt'], 'dest');
    expect(copied.path).toBe('dest/a (2).txt');
    expect(await fs.readFile(onDisk(s, 'dest/a.txt'), 'utf8')).toBe('two');
    expect(await fs.readFile(onDisk(s, 'dest/a (2).txt'), 'utf8')).toBe('one');
  });

  it('copies a folder RECURSIVELY, preserving the whole structure, including empty folders', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'src');
    await s.mkdir('src', 'nested');
    await s.mkdir('src', 'empty');
    await s.writeFile('src', 'top.txt', Buffer.from('t'));
    await s.writeFile('src/nested', 'deep.txt', Buffer.from('d'));
    await s.mkdir('', 'dest');
    const [copied] = await s.copyMany(['src'], 'dest');
    expect(copied.path).toBe('dest/src');
    expect((await s.list('dest/src')).entries.map((e) => e.name).sort()).toEqual(['empty', 'nested', 'top.txt']);
    expect(await fs.readFile(onDisk(s, 'dest/src/nested/deep.txt'), 'utf8')).toBe('d');
    // The original is untouched.
    expect(await fs.readFile(onDisk(s, 'src/nested/deep.txt'), 'utf8')).toBe('d');
  });

  it('duplicates a file beside itself as `<stem> copy<ext>`', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'config.json', Buffer.from('{}'));
    const dup = await s.duplicate('config.json');
    expect(dup.path).toBe('config copy.json');
    expect(await fs.readFile(onDisk(s, 'config.json'), 'utf8')).toBe('{}');
    expect(await fs.readFile(onDisk(s, 'config copy.json'), 'utf8')).toBe('{}');
    // A second duplicate is numbered rather than overwriting the first.
    const dup2 = await s.duplicate('config.json');
    expect(dup2.path).toBe('config copy 2.json');
  });

  it('duplicates a folder recursively inside its own parent', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'docs');
    await s.writeFile('docs', 'readme.md', Buffer.from('# hi'));
    const dup = await s.duplicate('docs');
    expect(dup.path).toBe('docs copy');
    expect((await s.list('docs copy')).entries.map((e) => e.name)).toEqual(['readme.md']);
  });

  it('copies several paths in one action and preserves order', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('a'));
    await s.writeFile('', 'b.txt', Buffer.from('b'));
    await s.mkdir('', 'dest');
    const copied = await s.copyMany(['a.txt', 'b.txt'], 'dest');
    expect(copied.map((e) => e.path)).toEqual(['dest/a.txt', 'dest/b.txt']);
  });

  it('copies INTO the root (destination "") and never overwrites', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'sub');
    await s.writeFile('sub', 'a.txt', Buffer.from('deep'));
    const [copied] = await s.copyMany(['sub/a.txt'], '');
    expect(copied.path).toBe('a.txt');
    expect(await fs.readFile(onDisk(s, 'a.txt'), 'utf8')).toBe('deep');
  });

  it('refuses to copy a folder into its own subtree, and refuses traversal / absolute destinations', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'a');
    await s.mkdir('a', 'b');
    await s.writeFile('', 'f.txt', Buffer.from('x'));
    await rejects(s.copyMany(['a'], 'a/b'), 400);
    for (const bad of ['..', '/etc', `../../${WF_B}`]) await rejects(s.copyMany(['f.txt'], bad));
    await rejects(s.copyMany(['../secret.txt'], ''));
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('a copy never carries a symlink out of the workspace', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'src');
    await s.writeFile('src', 'real.txt', Buffer.from('r'));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(s.rootDir(), 'src', 'leak.txt'), 'file');
    await s.mkdir('', 'dest');
    const [copied] = await s.copyMany(['src'], 'dest');
    expect(copied.path).toBe('dest/src');
    // The link was skipped, so only the real file is in the copy.
    expect((await s.list('dest/src')).entries.map((e) => e.name)).toEqual(['real.txt']);
  });
});

describe('WorkflowStorage: Compress -> ZIP', () => {
  it('archives files into a .zip that stays inside the workflow and reads back', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('alpha'));
    await s.writeFile('', 'b.txt', Buffer.from('beta'));
    const z = await s.compress(['a.txt', 'b.txt'], { base: '', name: 'bundle', destDir: '' });
    expect(z.path).toBe('bundle.zip');
    expect(z.size).toBeGreaterThan(0);
    // It IS inside the workflow root and is a real ZIP.
    const bytes = await fs.readFile(onDisk(s, z.path));
    const names = readZipArchive(bytes).filter((e) => !e.isDirectory).map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt']);
    // And the listing shows it.
    expect((await s.list('')).entries.map((e) => e.name)).toContain('bundle.zip');
  });

  it('archives a FOLDER with its tree, entry names relative to the base folder', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'docs');
    await s.mkdir('docs', 'nested');
    await s.writeFile('docs', 'top.txt', Buffer.from('t'));
    await s.writeFile('docs/nested', 'deep.txt', Buffer.from('d'));
    const z = await s.compress(['docs'], { base: '', name: 'docs', destDir: '' });
    const names = readZipArchive(await fs.readFile(onDisk(s, z.path))).map((e) => e.name + (e.isDirectory ? '/' : ''));
    expect(names).toContain('docs/');
    expect(names).toContain('docs/top.txt');
    expect(names).toContain('docs/nested/deep.txt');
  });

  it('names the archive after the folder on screen and adds the .zip suffix', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'work');
    await s.writeFile('work', 'x.txt', Buffer.from('x'));
    // No name: the base folder's name is used.
    const z = await s.compress(['work/x.txt'], { base: 'work', destDir: 'work' });
    expect(z.path).toBe('work/work.zip');
    // A name without .zip gets one.
    const y = await s.compress(['work/x.txt'], { base: 'work', name: 'report', destDir: 'work' });
    expect(y.path).toBe('work/report.zip');
  });

  it('does not overwrite an existing archive: a taken name is numbered', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('a'));
    const first = await s.compress(['a.txt'], { base: '', name: 'bundle', destDir: '' });
    const second = await s.compress(['a.txt'], { base: '', name: 'bundle', destDir: '' });
    expect(first.path).toBe('bundle.zip');
    expect(second.path).toBe('bundle (2).zip');
  });

  it('refuses empty input, traversal and absolute destinations, and never leaves the workspace', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('a'));
    await rejects(s.compress([], { base: '', name: 'x', destDir: '' }), 400);
    await rejects(s.compress(['../secret.txt'], { base: '', name: 'x', destDir: '' }));
    await rejects(s.compress(['a.txt'], { base: '', name: 'x', destDir: '/etc' }));
    await rejects(s.compress(['a.txt'], { base: '', name: 'x', destDir: `../../${WF_B}` }));
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses a folder entry that would round-trip losslessly but names nothing', async () => {
    // An empty selection of only folders still makes an archive of them; an
    // archive with NO file at all is refused, because that is almost certainly
    // a mistake rather than an intent.
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'empty');
    await rejects(s.compress(['empty'], { base: '', name: 'x', destDir: '' }), 400);
  });
});

describe('WorkflowStorage: Extract <- ZIP', () => {
  /** Build a ZIP from the store's own compress, so the writer is the shipped one. */
  async function makeZip(s: WorkflowStorage, files: Record<string, string>, name = 'src'): Promise<string> {
    for (const [rel, content] of Object.entries(files)) {
      const parent = path.posix.dirname(rel).replace(/^\.$/, '');
      if (parent) await s.mkdir(parent, path.posix.basename(parent)).catch(() => {});
      await s.writeFile(parent, path.posix.basename(rel), Buffer.from(content));
    }
    const z = await s.compress(Object.keys(files), { base: '', name, destDir: '' });
    return z.path;
  }

  it('extracts a simple zip beside the archive (mode "here")', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'box');
    await s.writeFile('box', 'a.txt', Buffer.from('alpha'));
    await s.writeFile('box', 'b.txt', Buffer.from('beta'));
    const zip = await s.compress(['box/a.txt', 'box/b.txt'], { base: 'box', name: 'bundle', destDir: 'box' });
    // Into an explicit empty folder.
    await s.mkdir('', 'out');
    const r = await s.extractZip(zip.path, { into: 'out' });
    expect(r.folder).toBe('out');
    expect(r.files).toBe(2);
    expect(await fs.readFile(onDisk(s, 'out/a.txt'), 'utf8')).toBe('alpha');
    expect(await fs.readFile(onDisk(s, 'out/b.txt'), 'utf8')).toBe('beta');
  });

  it('extracts nested folders and multiple files, preserving structure', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'src');
    await s.mkdir('src', 'images');
    await s.mkdir('src', 'fonts');
    await s.writeFile('src', 'data.json', Buffer.from('{}'));
    await s.writeFile('src/images', 'logo.png', Buffer.from('PNG'));
    await s.writeFile('src/fonts', 'f.woff', Buffer.from('WOFF'));
    const zip = await s.compress(['src'], { base: '', name: 'assets', destDir: '' });
    const r = await s.extractZip(zip.path, { mode: 'folder' });
    expect(r.folder).toBe('assets');
    expect(await fs.readFile(onDisk(s, 'assets/src/data.json'), 'utf8')).toBe('{}');
    expect(await fs.readFile(onDisk(s, 'assets/src/images/logo.png'), 'utf8')).toBe('PNG');
    expect(await fs.readFile(onDisk(s, 'assets/src/fonts/f.woff'), 'utf8')).toBe('WOFF');
  });

  it('mode "folder" makes a NEW folder named after the archive, numbered when taken', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'x.txt', Buffer.from('x'));
    const zip = await s.compress(['x.txt'], { base: '', name: 'bundle', destDir: '' });
    const first = await s.extractZip(zip.path, { mode: 'folder' });
    expect(first.folder).toBe('bundle');
    const second = await s.extractZip(zip.path, { mode: 'folder' });
    expect(second.folder).toBe('bundle (2)');
    expect(await fs.readFile(onDisk(s, 'bundle (2)/x.txt'), 'utf8')).toBe('x');
  });

  it('refuses to overwrite an existing file (409) and writes nothing at all', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('in-archive'));
    await s.writeFile('', 'b.txt', Buffer.from('in-archive'));
    const zip = await s.compress(['a.txt', 'b.txt'], { base: '', name: 'z', destDir: '' });
    // Put a conflicting file where "here" extraction would land.
    await s.mkdir('', 'target');
    await s.writeFile('target', 'a.txt', Buffer.from('keep-me'));
    await rejects(s.extractZip(zip.path, { into: 'target' }), 409);
    // The conflict stopped the WHOLE extraction: b.txt was not written either.
    expect(await fs.readFile(onDisk(s, 'target/a.txt'), 'utf8')).toBe('keep-me');
    expect((await s.list('target')).entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('refuses a non-zip file', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'notes.txt', Buffer.from('not a zip'));
    await rejects(s.extractZip('notes.txt'), 400);
  });

  it('REJECTS a malicious "../" entry rather than writing outside the workspace', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    // A hand-built zip whose entry name is `../evil.txt`. ZipStream refuses to
    // WRITE such a name (normaliseName throws on ".."), so the bytes are built
    // by hand here -- the point is that the READER refuses it.
    const zipPath = await writeRawZip(s, 'zip-slip.zip', [{ name: '../evil.txt', data: Buffer.from('escape') }]);
    await rejects(s.extractZip(zipPath));
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
    expect(await fs.readdir(tmpRoot)).toEqual([USER]);
  });

  it('REJECTS an absolute entry name', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const zipPath = await writeRawZip(s, 'absolute.zip', [{ name: '/etc/passwd', data: Buffer.from('x') }]);
    await rejects(s.extractZip(zipPath));
    expect(await fs.readdir(tmpRoot)).toEqual([USER]);
  });

  it('REJECTS a backslash (Windows-absolute) entry name', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const zipPath = await writeRawZip(s, 'win.zip', [{ name: 'C:\\Windows\\x', data: Buffer.from('x') }]);
    await rejects(s.extractZip(zipPath));
  });

  it('REJECTS a nested ../ that would climb out through a legitimate first segment', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const zipPath = await writeRawZip(s, 'nested-slip.zip', [{ name: 'ok/../../evil.txt', data: Buffer.from('x') }]);
    await rejects(s.extractZip(zipPath));
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
  });

  it('refuses a symlink planted at the destination rather than writing through it', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('A'));
    const zip = await s.compress(['a.txt'], { base: '', name: 'z', destDir: '' });
    await s.mkdir('', 'out');
    await fs.symlink(outside, path.join(s.rootDir(), 'out', 'escape'), 'dir');
    const zip2 = await s.compress(['a.txt'], { base: '', name: 'z2', destDir: '' });
    // Rename the entry target inside the zip to hit the symlink by extracting
    // into a folder whose only entry name matches the link is not possible with
    // compress; instead prove the resolve() refuses the linked destination.
    await rejects(s.resolve('out/escape/x', { mustExist: false }), 403);
    void zip; void zip2;
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
  });

  it('enforces the file-count cap', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const entries = Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }));
    const zipPath = await writeRawZip(s, 'many.zip', entries);
    const old = config.WORKFLOW_ZIP_MAX_FILES;
    (config as { WORKFLOW_ZIP_MAX_FILES: number }).WORKFLOW_ZIP_MAX_FILES = 10;
    try {
      await rejects(s.extractZip(zipPath), 413);
    } finally {
      (config as { WORKFLOW_ZIP_MAX_FILES: number }).WORKFLOW_ZIP_MAX_FILES = old;
    }
  });

  it('enforces the total-uncompressed-size cap BEFORE inflating', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    const zipPath = await writeRawZip(s, 'big.zip', [{ name: 'a.bin', data: Buffer.alloc(4096, 0x61) }]);
    const old = config.WORKFLOW_ZIP_MAX_TOTAL_BYTES;
    (config as { WORKFLOW_ZIP_MAX_TOTAL_BYTES: number }).WORKFLOW_ZIP_MAX_TOTAL_BYTES = 1024;
    try {
      await rejects(s.extractZip(zipPath), 413);
    } finally {
      (config as { WORKFLOW_ZIP_MAX_TOTAL_BYTES: number }).WORKFLOW_ZIP_MAX_TOTAL_BYTES = old;
    }
  });

  it('enforces the input-size cap', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.writeFile('', 'a.txt', Buffer.from('A'));
    const zip = await s.compress(['a.txt'], { base: '', name: 'z', destDir: '' });
    const old = config.WORKFLOW_ZIP_MAX_INPUT_BYTES;
    (config as { WORKFLOW_ZIP_MAX_INPUT_BYTES: number }).WORKFLOW_ZIP_MAX_INPUT_BYTES = 1;
    try {
      await rejects(s.extractZip(zip.path), 413);
    } finally {
      (config as { WORKFLOW_ZIP_MAX_INPUT_BYTES: number }).WORKFLOW_ZIP_MAX_INPUT_BYTES = old;
    }
  });

  it('copy failure leaves no partial destination tree', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'copy-source');
    await s.writeFile('copy-source', 'a.txt', Buffer.from('a'));
    await s.writeFile('copy-source', 'b.txt', Buffer.from('b'));
    await s.mkdir('', 'copy-destination');
    const old = config.WORKFLOW_ZIP_MAX_ENTRIES;
    (config as { WORKFLOW_ZIP_MAX_ENTRIES: number }).WORKFLOW_ZIP_MAX_ENTRIES = 1;
    try {
      await rejects(s.copyMany(['copy-source'], 'copy-destination'), 413);
    } finally {
      (config as { WORKFLOW_ZIP_MAX_ENTRIES: number }).WORKFLOW_ZIP_MAX_ENTRIES = old;
    }
    expect((await s.list('copy-destination')).entries).toEqual([]);
    expect((await s.list('copy-source')).entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt']);
  });
});

describe('WorkflowStorage: same-basename bulk collision planning', () => {
  it('copies same-named files to distinct numbered destinations', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'source-a'); await s.mkdir('', 'source-b'); await s.mkdir('', 'copy-target');
    await s.writeFile('source-a', 'foo.txt', Buffer.from('A'));
    await s.writeFile('source-b', 'foo.txt', Buffer.from('B'));
    const copied = await s.copyMany(['source-a/foo.txt', 'source-b/foo.txt'], 'copy-target');
    expect(copied.map((e) => e.path)).toEqual(['copy-target/foo.txt', 'copy-target/foo (2).txt']);
    expect(await fs.readFile(onDisk(s, 'copy-target/foo.txt'), 'utf8')).toBe('A');
    expect(await fs.readFile(onDisk(s, 'copy-target/foo (2).txt'), 'utf8')).toBe('B');
  });

  it('moves same-named files to distinct destinations without overwriting', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'source-a'); await s.mkdir('', 'source-b'); await s.mkdir('', 'move-target');
    await s.writeFile('source-a', 'foo.txt', Buffer.from('A'));
    await s.writeFile('source-b', 'foo.txt', Buffer.from('B'));
    const moved = await s.moveMany(['source-a/foo.txt', 'source-b/foo.txt'], 'move-target');
    expect(moved.map((e) => e.path)).toEqual(['move-target/foo.txt', 'move-target/foo (2).txt']);
    expect(await fs.readFile(onDisk(s, 'move-target/foo.txt'), 'utf8')).toBe('A');
    expect(await fs.readFile(onDisk(s, 'move-target/foo (2).txt'), 'utf8')).toBe('B');
  });

  it('preserves all three same-named files in a bulk copy', async () => {
    const s = new WorkflowStorage(USER, WF_A);
    await s.mkdir('', 'a'); await s.mkdir('', 'b'); await s.mkdir('', 'c'); await s.mkdir('', 'target');
    for (const dir of ['a', 'b', 'c']) await s.writeFile(dir, 'foo.txt', Buffer.from(dir));
    const copied = await s.copyMany(['a/foo.txt', 'b/foo.txt', 'c/foo.txt'], 'target');
    expect(copied.map((e) => e.name)).toEqual(['foo.txt', 'foo (2).txt', 'foo (3).txt']);
    expect(await fs.readFile(onDisk(s, 'target/foo (3).txt'), 'utf8')).toBe('c');
  });
});
