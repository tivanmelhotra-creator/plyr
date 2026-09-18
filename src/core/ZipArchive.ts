/** Dependency-free ZIP reader used by WorkflowStorage extraction. */
import { inflateRawSync } from 'zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

export class ZipArchiveError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'ZipArchiveError';
  }
}

export interface ZipArchiveEntry {
  name: string;
  isDirectory: boolean;
  data: Buffer;
  uncompressedSize: number;
}

export interface ZipArchiveLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
}

const DEFAULT_LIMITS: ZipArchiveLimits = {
  maxEntries: 10000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxEntryUncompressedBytes: 1024 * 1024 * 1024,
};

function u16(buf: Buffer, off: number): number { return buf.readUInt16LE(off); }
function u32(buf: Buffer, off: number): number { return buf.readUInt32LE(off); }

function safeName(raw: string): string {
  const name = raw.replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipArchiveError('The archive contains an absolute path.');
  }
  const parts = name.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new ZipArchiveError('The archive contains an unsafe path.');
  }
  return parts.join('/') + (name.endsWith('/') ? '/' : '');
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const start = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new ZipArchiveError('The archive has no central directory.');
}

export function readZipArchive(buf: Buffer, limits: ZipArchiveLimits = DEFAULT_LIMITS): ZipArchiveEntry[] {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipArchiveError('The archive is invalid.');
  const end = findEndOfCentralDirectory(buf);
  const disk = u16(buf, end + 4);
  const entriesOnDisk = u16(buf, end + 8);
  const entries = u16(buf, end + 10);
  const directorySize = u32(buf, end + 12);
  const directoryOffset = u32(buf, end + 16);
  if (disk !== 0 || entriesOnDisk !== entries || entries > limits.maxEntries) {
    throw new ZipArchiveError(`The archive has too many entries (limit ${limits.maxEntries}).`, 413);
  }
  if (directoryOffset + directorySize > end || directoryOffset < 0) {
    throw new ZipArchiveError('The archive directory is invalid.');
  }

  const result: ZipArchiveEntry[] = [];
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buf.length || u32(buf, cursor) !== CENTRAL) throw new ZipArchiveError('The archive directory is truncated.');
    const flags = u16(buf, cursor + 8);
    const method = u16(buf, cursor + 10);
    const compressedSize = u32(buf, cursor + 20);
    const uncompressedSize = u32(buf, cursor + 24);
    const nameLength = u16(buf, cursor + 28);
    const extraLength = u16(buf, cursor + 30);
    const commentLength = u16(buf, cursor + 32);
    const localOffset = u32(buf, cursor + 42);
    const endRecord = cursor + 46 + nameLength + extraLength + commentLength;
    if (endRecord > buf.length) throw new ZipArchiveError('The archive directory is truncated.');
    if (flags & 1) throw new ZipArchiveError('Encrypted ZIP entries are not supported.');
    const name = safeName(buf.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    const isDirectory = name.endsWith('/');
    const cleanName = name.replace(/\/+$/, '');
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipArchiveError(`An archive entry exceeds the ${limits.maxEntryUncompressedBytes} byte limit.`, 413);
    }
    total += uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new ZipArchiveError(`The archive exceeds the ${limits.maxTotalUncompressedBytes} byte limit.`, 413);
    }
    if (localOffset + 30 > buf.length || u32(buf, localOffset) !== LOCAL) throw new ZipArchiveError('The archive entry is invalid.');
    const localNameLength = u16(buf, localOffset + 26);
    const localExtraLength = u16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset || dataEnd > buf.length) throw new ZipArchiveError('The archive entry is truncated.');
    const compressed = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (isDirectory) data = Buffer.alloc(0);
    else if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) {
      try { data = inflateRawSync(compressed, { maxOutputLength: limits.maxEntryUncompressedBytes }); }
      catch { throw new ZipArchiveError('The archive entry could not be decompressed.'); }
    } else throw new ZipArchiveError(`ZIP compression method ${method} is not supported.`);
    if (data.length !== uncompressedSize) throw new ZipArchiveError('The archive entry size is invalid.');
    result.push({ name: cleanName, isDirectory, data, uncompressedSize });
    cursor = endRecord;
  }
  return result;
}

export function isZipFileName(name: string): boolean { return /\.zip$/i.test(String(name || '').trim()); }
export function archiveStem(name: string): string {
  const stem = String(name || '').replace(/\.zip$/i, '').trim();
  return stem || 'extracted';
}
