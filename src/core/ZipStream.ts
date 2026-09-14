/**
 * ZipStream — a small, dependency-free, STREAMING ZIP writer.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Download folder" / "Download workspace" / "Download the selected files" in
 * the Workflow File Workspace hand the operator ONE archive of what they see
 * in the drawer. The archive can be large (a workspace of uploads and
 * downloads runs to hundreds of megabytes), and a browser saves one thing per
 * click, so the server has to produce a single ZIP and it has to do so
 * WITHOUT first assembling it in memory or on disk. This class writes the
 * archive straight into any Writable (an HTTP response) as the files are read.
 *
 * Nothing here is clever: it is the ZIP format as specified in APPNOTE.TXT
 * (PKWARE) since 1993, restricted to what every reader supports:
 *
 *   * DEFLATE (method 8) for regular files, STORE (method 0) for directory
 *     entries. zlib's streaming Deflate does the compression; the CRC-32 comes
 *     from `zlib.crc32` (Node >= 22) with a table fallback for Node 20.
 *   * The general-purpose bit 3 "data descriptor" flag. Because sizes and the
 *     CRC are not known until a file has been streamed, the local header
 *     carries zeros and a 16-byte descriptor follows the data. That is exactly
 *     what every streaming writer (Java's ZipOutputStream, .NET's, Go's) does,
 *     and every reader since PKZIP 2.0 reads the central directory anyway.
 *   * Bit 11 UTF-8 names, so `گزارش.pdf` round-trips on Windows 10+, macOS,
 *     Linux and inside Chrome's own unzip.
 *   * ZIP64 is NOT implemented. The per-file limit of the workspace is 256 MiB
 *     (WorkflowStorage.MAX_WORKFLOW_FILE_BYTES) and the archive as a whole is
 *     capped at 4 GiB / 65535 entries here, with a clear error rather than a
 *     silently corrupt archive when either is crossed. A workspace that big is
 *     not something a browser download is the right tool for anyway.
 *
 * WHAT THE CALLER OWNS
 * --------------------
 *   * The Writable. This class writes to it and honours back-pressure (awaits
 *     'drain'); it never ends it, so the caller can set headers before and end
 *     the response after `finish()`.
 *   * Entry names. They are used as given (after `/` normalisation and a
 *     leading-slash strip); the caller is the one who knows what is
 *     workflow-relative. A directory entry gets a trailing `/`.
 *   * Errors on the input stream are re-thrown from `addFile` and mark the
 *     archive broken; nothing further is written and `finish()` refuses.
 *
 * Usage:
 *
 *     const zip = new ZipStream(res);
 *     await zip.addDirectory('docs');
 *     await zip.addFile('docs/a.txt', createReadStream(abs), { mtime });
 *     await zip.addBuffer('README.md', 'hello');
 *     await zip.finish();
 *     res.end();
 */

import { createDeflateRaw, crc32 as zlibCrc32 } from 'zlib';
import type { Readable, Writable } from 'stream';

// ── Constants ────────────────────────────────────────────────────────────────

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** High byte 3 = UNIX (so the external attributes carry a mode), low byte 20 = spec 2.0. */
const VERSION_MADE_BY = (3 << 8) | 20;
/** 2.0 is what DEFLATE + data descriptors need; every reader since 1993 has it. */
const VERSION_NEEDED = 20;

const FLAG_DATA_DESCRIPTOR = 1 << 3;
const FLAG_UTF8 = 1 << 11;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Hard limits of the classic (non-ZIP64) format. */
const MAX_ENTRIES = 0xffff;
const MAX_U32 = 0xffffffff;

/** `-rw-r--r--` for files and `drwxr-xr-x` for folders, in the UNIX high word. */
const MODE_FILE = 0o100644;
const MODE_DIR = 0o040755;

/** Longest entry name we will write (the format's field is u16, this is saner). */
const MAX_NAME_BYTES = 4096;

// ── CRC-32 ───────────────────────────────────────────────────────────────────

/**
 * `zlib.crc32` landed in Node 22.2 / 20.15. `engines.node` says >= 20, so a
 * table fallback keeps an older 20.x honest instead of throwing at runtime.
 */
let crcTable: Uint32Array | null = null;
function tableCrc32(data: Uint8Array, seed: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const crc32: (data: Uint8Array, seed: number) => number =
  typeof zlibCrc32 === 'function'
    ? (data, seed) => zlibCrc32(data, seed) >>> 0
    : tableCrc32;

// ── Time ─────────────────────────────────────────────────────────────────────

/** MS-DOS date/time, the only timestamp the classic format has (2-second resolution, 1980–2107). */
function dosDateTime(d: Date): { date: number; time: number } {
  let y = d.getFullYear();
  if (y < 1980) return { date: (1 << 5) | 1, time: 0 }; // 1980-01-01 00:00
  if (y > 2107) y = 2107;
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ZipEntryOptions {
  /** Modification time recorded in the archive. Defaults to now. */
  mtime?: Date;
  /** Store instead of deflate (for already-compressed data). Default: deflate for files. */
  store?: boolean;
}

interface CentralRecord {
  nameBytes: Buffer;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  dosDate: number;
  dosTime: number;
  externalAttrs: number;
  localHeaderOffset: number;
}

export class ZipStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipStreamError';
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

export class ZipStream {
  private readonly out: Writable;
  private readonly records: CentralRecord[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private finished = false;
  private broken: Error | null = null;
  private busy = false;

  constructor(out: Writable) {
    this.out = out;
  }

  /** Entries written so far (files + directories). */
  get entryCount(): number {
    return this.records.length;
  }

  /** Bytes handed to the Writable so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** A directory entry (kept so empty folders survive). Trailing `/` added. */
  async addDirectory(name: string, opts: ZipEntryOptions = {}): Promise<void> {
    const clean = this.normaliseName(name, true);
    if (!clean) return; // the root itself is not an entry
    await this.guarded(async () => {
      const nameBytes = this.nameBytesOf(clean);
      const when = dosDateTime(opts.mtime ?? new Date());
      const localHeaderOffset = this.offset;
      await this.write(this.localHeader(nameBytes, METHOD_STORE, FLAG_UTF8, when, 0, 0, 0));
      this.records.push({
        nameBytes,
        method: METHOD_STORE,
        flags: FLAG_UTF8,
        crc: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        dosDate: when.date,
        dosTime: when.time,
        externalAttrs: (MODE_DIR << 16) >>> 0,
        localHeaderOffset,
      });
    });
  }

  /** A file whose bytes are already in hand. */
  async addBuffer(name: string, data: Buffer | string, opts: ZipEntryOptions = {}): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const { Readable } = await import('stream');
    await this.addFile(name, Readable.from([buf]), opts);
  }

  /**
   * A file streamed from a Readable. The local header goes out first with a
   * data-descriptor flag, then the (deflated) bytes as they arrive, then the
   * descriptor with the real CRC and sizes. Back-pressure from the output is
   * honoured, so a slow client throttles the disk read instead of filling RAM.
   */
  async addFile(name: string, input: Readable, opts: ZipEntryOptions = {}): Promise<void> {
    const clean = this.normaliseName(name, false);
    if (!clean) throw new ZipStreamError('A file entry needs a name.');
    await this.guarded(async () => {
      const nameBytes = this.nameBytesOf(clean);
      const when = dosDateTime(opts.mtime ?? new Date());
      const method = opts.store ? METHOD_STORE : METHOD_DEFLATE;
      const flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
      const localHeaderOffset = this.offset;
      await this.write(this.localHeader(nameBytes, method, flags, when, 0, 0, 0));

      let crc = 0;
      let uncompressed = 0;
      let compressed = 0;

      const onChunk = async (chunk: Buffer): Promise<void> => {
        compressed += chunk.length;
        if (compressed > MAX_U32) throw new ZipStreamError('Archive entry exceeds 4 GiB; ZIP64 is not supported.');
        await this.write(chunk);
      };

      if (method === METHOD_DEFLATE) {
        const deflate = createDeflateRaw({ level: 6 });
        // Pump: input -> (crc, count) -> deflate -> output, awaiting each write.
        // If the OUTPUT side fails first, the input loop must stop too, which
        // is what `outFailed` is for; and a failing input must not leave the
        // pump's rejection unobserved (destroying the deflate makes it reject
        // with "Premature close"), hence the catch that records it.
        let outFailed: Error | null = null;
        const pumpOut = (async () => {
          for await (const chunk of deflate) await onChunk(chunk as Buffer);
        })().catch((e: Error) => { outFailed = e; try { input.destroy(); } catch { /* fine */ } });
        try {
          for await (const raw of input) {
            if (outFailed) throw outFailed;
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
            crc = crc32(chunk, crc);
            uncompressed += chunk.length;
            if (uncompressed > MAX_U32) throw new ZipStreamError('File exceeds 4 GiB; ZIP64 is not supported.');
            if (!deflate.write(chunk)) {
              await new Promise<void>((r) => { deflate.once('drain', r); deflate.once('close', r); });
            }
          }
          deflate.end();
          await pumpOut;
          if (outFailed) throw outFailed;
        } catch (e) {
          // Whichever side failed FIRST is the error worth reporting: an
          // output failure that stopped the loop, or the input's own.
          const first = outFailed ?? e;
          deflate.destroy();
          await pumpOut; // already caught; just wait for it to settle
          try { input.destroy(); } catch { /* already gone */ }
          throw first;
        }
      } else {
        try {
          for await (const raw of input) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
            crc = crc32(chunk, crc);
            uncompressed += chunk.length;
            if (uncompressed > MAX_U32) throw new ZipStreamError('File exceeds 4 GiB; ZIP64 is not supported.');
            await onChunk(chunk);
          }
        } catch (e) {
          try { input.destroy(); } catch { /* already gone */ }
          throw e;
        }
      }

      // Data descriptor (with signature, which every modern reader expects).
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(SIG_DESCRIPTOR, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(compressed, 8);
      desc.writeUInt32LE(uncompressed, 12);
      await this.write(desc);

      this.records.push({
        nameBytes,
        method,
        flags,
        crc: crc >>> 0,
        compressedSize: compressed,
        uncompressedSize: uncompressed,
        dosDate: when.date,
        dosTime: when.time,
        externalAttrs: (MODE_FILE << 16) >>> 0,
        localHeaderOffset,
      });
    });
  }

  /** Write the central directory and the end record. Idempotent; refuses after an error. */
  async finish(): Promise<void> {
    if (this.finished) return;
    await this.guarded(async () => {
      const start = this.offset;
      for (const r of this.records) await this.write(this.centralHeader(r));
      const size = this.offset - start;
      if (start > MAX_U32 || size > MAX_U32) {
        throw new ZipStreamError('Archive exceeds 4 GiB; ZIP64 is not supported.');
      }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(SIG_END, 0);
      eocd.writeUInt16LE(0, 4); // this disk
      eocd.writeUInt16LE(0, 6); // disk with central dir
      eocd.writeUInt16LE(this.records.length, 8);
      eocd.writeUInt16LE(this.records.length, 10);
      eocd.writeUInt32LE(size, 12);
      eocd.writeUInt32LE(start, 16);
      eocd.writeUInt16LE(0, 20); // comment length
      await this.write(eocd);
      this.finished = true;
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** One operation at a time; a broken or finished archive refuses more. */
  private async guarded(fn: () => Promise<void>): Promise<void> {
    if (this.broken) throw this.broken;
    if (this.finished) throw new ZipStreamError('The archive is already finished.');
    if (this.busy) throw new ZipStreamError('ZipStream entries must be added one at a time (await each call).');
    if (this.records.length >= MAX_ENTRIES) {
      throw new ZipStreamError(`At most ${MAX_ENTRIES} entries per archive; ZIP64 is not supported.`);
    }
    this.busy = true;
    try {
      await fn();
    } catch (e) {
      this.broken = e instanceof Error ? e : new ZipStreamError(String(e));
      throw this.broken;
    } finally {
      this.busy = false;
    }
  }

  /** Forward slashes, no leading slash, no `.`/`..` segments, no NUL. */
  private normaliseName(name: string, isDir: boolean): string {
    let s = String(name ?? '').replace(/\\/g, '/');
    s = s.split('/').filter((seg) => seg !== '' && seg !== '.').join('/');
    if (s.split('/').some((seg) => seg === '..')) throw new ZipStreamError('Entry names may not contain "..".');
    // eslint-disable-next-line no-control-regex
    if (/[\x00]/.test(s)) throw new ZipStreamError('Entry names may not contain NUL.');
    if (!s) return '';
    return isDir ? `${s}/` : s;
  }

  private nameBytesOf(clean: string): Buffer {
    const bytes = Buffer.from(clean, 'utf8');
    if (bytes.length > MAX_NAME_BYTES) throw new ZipStreamError('Entry name is too long.');
    if (this.names.has(clean)) throw new ZipStreamError(`Duplicate entry name: ${clean}`);
    this.names.add(clean);
    return bytes;
  }

  private localHeader(
    nameBytes: Buffer,
    method: number,
    flags: number,
    when: { date: number; time: number },
    crc: number,
    compressed: number,
    uncompressed: number,
  ): Buffer {
    const h = Buffer.alloc(30 + nameBytes.length);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(VERSION_NEEDED, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(when.time, 10);
    h.writeUInt16LE(when.date, 12);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(compressed, 18);
    h.writeUInt32LE(uncompressed, 22);
    h.writeUInt16LE(nameBytes.length, 26);
    h.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(h, 30);
    return h;
  }

  private centralHeader(r: CentralRecord): Buffer {
    const h = Buffer.alloc(46 + r.nameBytes.length);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE(VERSION_MADE_BY, 4);
    h.writeUInt16LE(VERSION_NEEDED, 6);
    h.writeUInt16LE(r.flags, 8);
    h.writeUInt16LE(r.method, 10);
    h.writeUInt16LE(r.dosTime, 12);
    h.writeUInt16LE(r.dosDate, 14);
    h.writeUInt32LE(r.crc >>> 0, 16);
    h.writeUInt32LE(r.compressedSize, 20);
    h.writeUInt32LE(r.uncompressedSize, 24);
    h.writeUInt16LE(r.nameBytes.length, 28);
    h.writeUInt16LE(0, 30); // extra length
    h.writeUInt16LE(0, 32); // comment length
    h.writeUInt16LE(0, 34); // disk number start
    h.writeUInt16LE(0, 36); // internal attrs
    h.writeUInt32LE(r.externalAttrs >>> 0, 38);
    h.writeUInt32LE(r.localHeaderOffset, 42);
    r.nameBytes.copy(h, 46);
    return h;
  }

  /** Write with back-pressure: wait for 'drain' when the Writable asks. Errors on the Writable abort. */
  private write(buf: Buffer): Promise<void> {
    if (buf.length === 0) return Promise.resolve();
    if (this.offset + buf.length > MAX_U32) {
      return Promise.reject(new ZipStreamError('Archive exceeds 4 GiB; ZIP64 is not supported.'));
    }
    this.offset += buf.length;
    return new Promise<void>((resolve, reject) => {
      const out = this.out as Writable & { destroyed?: boolean; writableEnded?: boolean };
      if (out.destroyed || out.writableEnded) {
        reject(new ZipStreamError('The output was closed before the archive was complete.'));
        return;
      }
      const onError = (e: Error) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new ZipStreamError('The output closed mid-archive.')); };
      const cleanup = () => {
        out.off('error', onError);
        out.off('close', onClose);
        out.off('drain', onDrain);
      };
      const onDrain = () => { cleanup(); resolve(); };
      out.once('error', onError);
      out.once('close', onClose);
      const ok = out.write(buf);
      if (ok) { cleanup(); resolve(); return; }
      out.once('drain', onDrain);
    });
  }
}
