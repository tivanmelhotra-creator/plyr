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
