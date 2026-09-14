/**
 * core/ZipStream — the streaming ZIP writer behind "Download folder / workspace /
 * selection" in the Workflow File Workspace.
 *
 * The archive is checked by an independent READER (a minimal central-directory
 * parser here, plus `unzip -t` when the binary is present), not by comparing
 * bytes against what the writer says it wrote: the whole point is that Windows
 * Explorer, macOS Archive Utility and Chrome's own unzip open it.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough, Readable, Writable } from 'stream';
import { inflateRawSync, crc32 as zlibCrc32 } from 'zlib';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { ZipStream, ZipStreamError } from '../../src/core/ZipStream';

/** Collect everything a ZipStream writes. */
async function build(fn: (z: ZipStream) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  const z = new ZipStream(out);
  await fn(z);
  await z.finish();
  await new Promise<void>((r) => out.end(r));
  return Buffer.concat(chunks);
}

interface Entry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttrs: number;
  data: Buffer;
}

/** Read the archive the way a real reader does: EOCD -> central directory -> local headers. */
function readZip(buf: Buffer): Entry[] {
  // EOCD is the last 22 bytes when there is no comment.
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  expect(cdStart + cdSize).toBe(eocd);

  const entries: Entry[] = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    // Local header agrees on the name; the data follows it.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    expect(buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('utf8')).toBe(name);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(uncompressedSize);
    expect(zlibCrc32(data) >>> 0).toBe(crc);
    // With bit 3 set, the descriptor follows the data and repeats the numbers.
    if (flags & 8) {
      const d = dataStart + compressedSize;
      expect(buf.readUInt32LE(d)).toBe(0x08074b50);
      expect(buf.readUInt32LE(d + 4)).toBe(crc);
      expect(buf.readUInt32LE(d + 8)).toBe(compressedSize);
      expect(buf.readUInt32LE(d + 12)).toBe(uncompressedSize);
    }
    entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset, externalAttrs, data });
  }
  return entries;
}

function hasUnzip(): boolean {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('ZipStream: a reader opens what the writer streamed', () => {
  it('files (deflated), folders (kept when empty), UTF-8 names, and a stored entry', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 'abc');
    const buf = await build(async (z) => {
      await z.addDirectory('docs');
      await z.addDirectory('empty/');
      await z.addBuffer('docs/a.txt', 'hello world\n'.repeat(100));
      await z.addBuffer('گزارش.txt', 'سلام');
      await z.addFile('big.bin', Readable.from([big.subarray(0, 1 << 20), big.subarray(1 << 20)]));
      await z.addBuffer('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { store: true });
      expect(z.entryCount).toBe(6);
    });

    const entries = readZip(buf);
    expect(entries.map((e) => e.name)).toEqual(['docs/', 'empty/', 'docs/a.txt', 'گزارش.txt', 'big.bin', 'photo.png']);

    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['docs/'].method).toBe(0);
    expect(byName['docs/'].uncompressedSize).toBe(0);
    expect((byName['docs/'].externalAttrs >>> 16) & 0o170000).toBe(0o040000); // a directory
    expect((byName['docs/a.txt'].externalAttrs >>> 16) & 0o170000).toBe(0o100000); // a regular file
    expect(byName['docs/a.txt'].method).toBe(8);
    expect(byName['docs/a.txt'].data.toString()).toBe('hello world\n'.repeat(100));
    expect(byName['گزارش.txt'].flags & (1 << 11)).toBeTruthy(); // UTF-8 bit
    expect(byName['گزارش.txt'].data.toString()).toBe('سلام');
    expect(byName['big.bin'].data.equals(big)).toBe(true);
    expect(byName['big.bin'].compressedSize).toBeLessThan(big.length / 100); // it really was deflated
    expect(byName['photo.png'].method).toBe(0);
    expect(byName['photo.png'].compressedSize).toBe(7);
  });

  it('is accepted by unzip -t when the binary is available', async () => {
    if (!hasUnzip()) return;
    const buf = await build(async (z) => {
      await z.addDirectory('d');
      await z.addBuffer('d/x.txt', 'x'.repeat(5000));
      await z.addBuffer('پرونده.md', '# سلام\n');
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zs-'));
    const file = path.join(dir, 't.zip');
    await fs.writeFile(file, buf);
    try {
      const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
      expect(out).toContain('No errors detected');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('honours back-pressure: a slow output throttles the writer instead of buffering everything', async () => {
    let buffered = 0;
    let maxBuffered = 0;
    const out = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk, _enc, cb) {
        buffered += chunk.length;
        maxBuffered = Math.max(maxBuffered, buffered);
        setTimeout(() => { buffered -= chunk.length; cb(); }, 1);
      },
    });
    const z = new ZipStream(out);
    // Incompressible data so the deflated stream is as big as the input.
    const chunks: Buffer[] = [];
    for (let i = 0; i < 64; i++) {
      const b = Buffer.alloc(64 * 1024);
      for (let j = 0; j < b.length; j++) b[j] = (i * 7919 + j * 104729) & 0xff;
      chunks.push(b);
    }
    await z.addFile('noise.bin', Readable.from(chunks), { store: true });
    await z.finish();
    await new Promise<void>((r) => out.end(r));
    expect(z.bytesWritten).toBeGreaterThan(64 * 64 * 1024);
    // Never more than a couple of chunks in flight.
    expect(maxBuffered).toBeLessThan(4 * 64 * 1024);
  });
});

describe('ZipStream: refusals are errors, never a corrupt archive', () => {
  it('rejects ".." before a byte is written (the archive stays usable), and strips a leading slash', async () => {
    const buf = await build(async (z) => {
      await expect(z.addBuffer('../x', 'a')).rejects.toBeInstanceOf(ZipStreamError);
      await expect(z.addBuffer('a/../../x', 'a')).rejects.toBeInstanceOf(ZipStreamError);
      expect(z.bytesWritten).toBe(0);
      await z.addBuffer('/leading/slash.txt', 'a');
    });
    expect(readZip(buf).map((e) => e.name)).toEqual(['leading/slash.txt']);

    await expect(build(async (z) => {
      await z.addBuffer('same.txt', 'a');
      await z.addBuffer('same.txt', 'b');
    })).rejects.toThrow(/Duplicate/);
  });

  it('an input stream error aborts the entry and marks the archive broken', async () => {
    const out = new PassThrough();
    out.resume();
    const z = new ZipStream(out);
    const bad = new Readable({
      read() { this.destroy(new Error('disk gone')); },
    });
    await expect(z.addFile('a.txt', bad)).rejects.toThrow('disk gone');
    await expect(z.finish()).rejects.toThrow('disk gone');
  });

  it('a closed output is reported instead of silently swallowing the rest', async () => {
    const out = new PassThrough();
    out.resume();
    const z = new ZipStream(out);
    await z.addBuffer('a.txt', 'a');
    out.destroy();
    await expect(z.addBuffer('b.txt', 'b')).rejects.toBeInstanceOf(ZipStreamError);
  });

  it('finish() twice is a no-op; adding after finish is refused', async () => {
    const out = new PassThrough();
    out.resume();
    const z = new ZipStream(out);
    await z.addBuffer('a.txt', 'a');
    await z.finish();
    const n = z.bytesWritten;
    await z.finish();
    expect(z.bytesWritten).toBe(n);
    await expect(z.addBuffer('b.txt', 'b')).rejects.toThrow(/already finished/);
  });
});
