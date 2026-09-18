/** Dependency-free ZIP reader used by WorkflowStorage extraction. */
import { inflateRawSync } from 'zlib';

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;
export const MAX_ENTRIES = 10000;

export class ZipArchiveError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'ZipArchiveError';
  }
}

export interface ZipReadLimits {
  maxEntries?: number;
  maxTotalUncompressedBytes?: number;
  maxEntryUncompressedBytes?: number;
}

export interface ZipArchiveEntry {
  name: string;
  isDirectory: boolean;
  data: Buffer;
}

function fail(message: string, status = 400): never { throw new ZipArchiveError(message, status); }

export function normalizeEntryName(input: string): { name: string; isDirectory: boolean } {
  const raw = String(input || '');
  if (!raw || raw.includes('\\') || raw.startsWith('/')) fail('The archive contains an unsafe entry name.');
  const isDirectory = raw.endsWith('/');
  const trimmed = raw.replace(/\/+$/g, '');
  if (!trimmed) return { name: '', isDirectory: true };
  const segments = trimmed.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) fail('The archive contains a traversal entry.');
  if (segments.some((s) => /[\u0000-\u001f\u007f]/.test(s))) fail('The archive contains an invalid entry name.');
  return { name: segments.join('/'), isDirectory };
}

function findEnd(buf: Buffer): number {
  const start = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= start; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

export function readZipArchive(buffer: Buffer, limits: ZipReadLimits = {}): ZipArchiveEntry[] {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('The archive is not a valid ZIP.');
  const eocd = findEnd(buffer);
  if (eocd < 0) fail('The archive is not a valid ZIP.');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  if (count > maxEntries) fail(`The archive contains more than ${maxEntries} entries.`, 413);
  if (centralOffset + centralSize > buffer.length) fail('The ZIP directory is truncated.');
  const maxTotal = limits.maxTotalUncompressedBytes ?? Infinity;
  const maxEntry = limits.maxEntryUncompressedBytes ?? maxTotal;
  const entries: ZipArchiveEntry[] = [];
  let pos = centralOffset;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) fail('The ZIP directory is invalid.');
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    if (nameStart + nameLen + extraLen + commentLen > buffer.length) fail('The ZIP directory is truncated.');
    const rawName = buffer.subarray(nameStart, nameStart + nameLen).toString((flags & 0x800) ? 'utf8' : 'utf8');
    const normalized = normalizeEntryName(rawName);
    if (uncompressedSize > maxEntry || total + uncompressedSize > maxTotal) fail('The archive expands beyond the configured limit.', 413);
    total += uncompressedSize;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) fail('The ZIP entry is invalid.');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buffer.length) fail('The ZIP entry is truncated.');
    let data = Buffer.alloc(0);
    if (!normalized.isDirectory) {
      if (flags & 1) fail('Encrypted ZIP archives are not supported.');
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        if (method === METHOD_STORE) data = Buffer.from(compressed);
        else if (method === METHOD_DEFLATE) {
          const opts = Number.isFinite(maxEntry) ? { maxOutputLength: Math.max(1, Math.floor(maxEntry)) } : undefined;
          data = inflateRawSync(compressed, opts);
        } else fail(`ZIP compression method ${method} is not supported.`);
      } catch (e) {
        if (e instanceof ZipArchiveError) throw e;
        fail('The ZIP entry could not be decompressed.');
      }
      if (data.length > maxEntry || data.length > maxTotal) fail('The archive expands beyond the configured limit.', 413);
    }
    entries.push({ name: normalized.name, isDirectory: normalized.isDirectory, data });
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function looksLikeZip(buffer: Buffer): boolean { return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50; }
export function isEncryptedArchive(_buffer: Buffer): boolean { return false; }
export function isZipFileName(name: string): boolean { return /\.zip$/i.test(String(name || '').trim()); }
export function archiveStem(name: string): string {
  const stem = String(name || '').replace(/\.zip$/i, '').trim();
  return stem || 'extracted';
}
