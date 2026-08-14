/**
 * remote-downloads.test.ts — the download shelf's storage layer, exercised for
 * real against a temp directory.
 *
 * WHY THESE ARE BEHAVIOUR TESTS AND NOT STRING CHECKS
 * ---------------------------------------------------
 * The mandate for this work was explicit: «تست‌ها باید رفتار را بسنجند نه وجود
 * رشته در سورس» — tests must measure behaviour, not the presence of a string in
 * the source. Every assertion below therefore calls the real function and looks
 * at the real filesystem. A `grep` for `path.resolve` would have passed against
 * a module that resolved paths and then ignored the result.
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * -----------------------------
 * A download's filename comes out of a remote server's `Content-Disposition`
 * header. It is attacker-controlled input that we are about to turn into a path
 * on our own disk. The failure mode is not a cosmetic bug, it is writing
 * outside the user's directory or serving a file back that was never downloaded
 * — so the traversal, containment and cross-user cases are pinned individually
 * rather than being trusted to one sanitiser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import os from 'node:os';

describe('RemoteDownloads storage', () => {
  let dir = '';
  let mod: typeof import('../../src/core/RemoteDownloads');
  let cfg: typeof import('../../src/config');

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'abdl-'));
    cfg = await import('../../src/config');
    // The path helpers read the config at CALL time, so pointing it at a temp
    // directory here is enough — no module-cache surgery required.
    //
    // BOTH roots are set, because downloads are EPHEMERAL by default now
    // (DOWNLOADS_EPHEMERAL, added for «tmp باشند خوبه تا دائمی»): the live root
    // is DOWNLOADS_TMP_DIR unless an operator asks for durable storage, and a
    // test that only redirected DOWNLOADS_DIR would silently write into the real
    // OS temp directory instead of its own sandbox.
    (cfg.config as { DOWNLOADS_DIR: string }).DOWNLOADS_DIR = dir;
    (cfg.config as { DOWNLOADS_TMP_DIR: string }).DOWNLOADS_TMP_DIR = dir;
    mod = await import('../../src/core/RemoteDownloads');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // ────────────────────────────────────────────────────────────────────────
  // Tokens
  // ────────────────────────────────────────────────────────────────────────

  it('mints unguessable, distinct tokens', () => {
    const a = mod.mintDownloadToken();
    const b = mod.mintDownloadToken();
    expect(a).not.toBe(b);
    expect(mod.DOWNLOAD_TOKEN_RE.test(a)).toBe(true);
    // 12 random bytes = 24 hex chars. Long enough that guessing another user's
    // token is not an attack, which matters because the token IS the capability.
    expect(a.length).toBe(3 + 24);
  });

  it('refuses a token it did not mint', async () => {
    for (const bad of [
      '',
      'dl_',
      'up_abc',                      // an UPLOAD token is not a download token
      'dl_XYZ',                      // not hex
      'dl_' + 'a'.repeat(23),        // too short
      'dl_' + 'a'.repeat(25),        // too long
      '../etc',
      'dl_../../../../etc/passwd',
    ]) {
      await expect(mod.resolveDownload('u1', bad)).rejects.toThrow();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Where the bytes land
  // ────────────────────────────────────────────────────────────────────────

  it('keeps each user in their own directory', () => {
    const a = mod.downloadDirFor('alice');
    const b = mod.downloadDirFor('bob');
    expect(a).not.toBe(b);
    expect(a.startsWith(dir)).toBe(true);
    expect(b.startsWith(dir)).toBe(true);
  });

  it('cannot be escaped by a hostile user id', () => {
    // A user id is used as a directory name, so it gets sanitised like one.
    const escaped = mod.downloadDirFor('../../../../etc');
    expect(escaped.startsWith(dir)).toBe(true);
    expect(escaped).not.toContain('..');
  });

  it('creates the directory and returns a path inside it', async () => {
    const token = mod.mintDownloadToken();
    const p = await mod.downloadPathFor('u1', token, 'report.pdf');
    expect(p.startsWith(dir)).toBe(true);
    expect(basename(p)).toBe('report.pdf');
    // The directory must exist by the time we return it: the caller is about to
    // write into it, and `saveAs` does not create parents.
    const st = await fs.stat(dirname(p));
    expect(st.isDirectory()).toBe(true);
  });

  it('neutralises a traversal in the SERVER-supplied filename', async () => {
    // This is the real attack: the name comes from Content-Disposition.
    const token = mod.mintDownloadToken();
    for (const hostile of [
      '../../../../etc/passwd',
      '..\\..\\windows\\system32\\config',
      '/etc/shadow',
      '....//....//escape.txt',
    ]) {
      const p = await mod.downloadPathFor('u1', token, hostile);
      expect(p.startsWith(dir), `${hostile} escaped the sandbox`).toBe(true);
      // One path segment below the token directory, and no traversal left in it.
      expect(basename(p)).not.toContain('/');
      expect(basename(p)).not.toContain('\\');
      expect(basename(p).startsWith('.')).toBe(false);
    }
  });

  it('never produces an empty filename', async () => {
    const token = mod.mintDownloadToken();
    for (const empty of ['', '...', '/', '\\', '   ']) {
      const p = await mod.downloadPathFor('u1', token, empty);
      expect(basename(p).length).toBeGreaterThan(0);
    }
  });

  it('gives two downloads of the same name separate files', async () => {
    // Chrome's `cookies (1).json` behaviour, achieved by a directory per
    // download: without this the second download silently overwrites the first,
    // and the first shelf row becomes a link to the wrong bytes.
    const t1 = mod.mintDownloadToken();
    const t2 = mod.mintDownloadToken();
    const p1 = await mod.downloadPathFor('u1', t1, 'cookies.json');
    const p2 = await mod.downloadPathFor('u1', t2, 'cookies.json');
    expect(p1).not.toBe(p2);
    await fs.writeFile(p1, 'first');
    await fs.writeFile(p2, 'second');
    expect(await fs.readFile(p1, 'utf8')).toBe('first');
    expect(await fs.readFile(p2, 'utf8')).toBe('second');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Reading them back
  // ────────────────────────────────────────────────────────────────────────

  it('round-trips: save, then resolve by token alone', async () => {
    const token = mod.mintDownloadToken();
    const p = await mod.downloadPathFor('u1', token, 'report.pdf');
    await fs.writeFile(p, 'PDF-BYTES');
    const found = await mod.resolveDownload('u1', token);
    expect(found.path).toBe(p);
    // The NAME survives, because the user chose to download `report.pdf` and
    // should receive `report.pdf`, not the token.
    expect(found.name).toBe('report.pdf');
    expect(found.size).toBe('PDF-BYTES'.length);
  });

  it('will not hand user A\'s download to user B', async () => {
    // The token is the capability, so this is the test that matters most: a
    // leaked or guessed token must still be useless under another identity.
    const token = mod.mintDownloadToken();
    const p = await mod.downloadPathFor('alice', token, 'secret.json');
    await fs.writeFile(p, 'alice-only');
    await expect(mod.resolveDownload('bob', token)).rejects.toThrow();
    // and alice can still read her own
    expect((await mod.resolveDownload('alice', token)).name).toBe('secret.json');
  });

  it('reports a missing download as missing, not as an empty file', async () => {
    const token = mod.mintDownloadToken();
    await expect(mod.resolveDownload('u1', token)).rejects.toThrow();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Housekeeping
  // ────────────────────────────────────────────────────────────────────────

  it('deleting a shelf row really deletes the bytes', async () => {
    // Keeping a file the user believes is gone is not something a browser should
    // do, and these are frequently credentials (a cookie export).
    const token = mod.mintDownloadToken();
    const p = await mod.downloadPathFor('u1', token, 'cookies.json');
    await fs.writeFile(p, 'SESSION=abc');
    await mod.discardDownload('u1', token);
    await expect(fs.stat(p)).rejects.toThrow();
    await expect(mod.resolveDownload('u1', token)).rejects.toThrow();
  });

  it('discarding an invalid token is a no-op, not a crash', async () => {
    // Called from a WS command, so a malformed token is routine input.
    await expect(mod.discardDownload('u1', '../../etc')).resolves.toBeUndefined();
    await expect(mod.discardDownload('u1', '')).resolves.toBeUndefined();
  });

  it('sweeps old downloads and keeps fresh ones', async () => {
    const oldTok = mod.mintDownloadToken();
    const newTok = mod.mintDownloadToken();
    const oldPath = await mod.downloadPathFor('u1', oldTok, 'old.bin');
    const newPath = await mod.downloadPathFor('u1', newTok, 'new.bin');
    await fs.writeFile(oldPath, 'x');
    await fs.writeFile(newPath, 'y');
    // Age the old one by hand rather than waiting a day.
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(dirname(oldPath), past, past);

    const removed = await mod.sweepDownloads('u1');
    expect(removed).toBe(1);
    await expect(mod.resolveDownload('u1', oldTok)).rejects.toThrow();
    expect((await mod.resolveDownload('u1', newTok)).name).toBe('new.bin');
  });

  it('sweeping a user with no downloads is not an error', async () => {
    await expect(mod.sweepDownloads('nobody')).resolves.toBe(0);
  });

  it('sweeping ignores directories it did not create', async () => {
    // Defensive: the sweep deletes recursively, so it must only ever touch names
    // matching its own token pattern.
    const userDir = mod.downloadDirFor('u1');
    await fs.mkdir(join(userDir, 'not-ours'), { recursive: true });
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(join(userDir, 'not-ours'), past, past);
    await mod.sweepDownloads('u1');
    expect((await fs.stat(join(userDir, 'not-ours'))).isDirectory()).toBe(true);
  });

  it('has a size cap, and it is a number the shelf can enforce', () => {
    expect(mod.MAX_DOWNLOAD_BYTES).toBeGreaterThan(1024 * 1024);
    expect(Number.isFinite(mod.MAX_DOWNLOAD_BYTES)).toBe(true);
  });
});
