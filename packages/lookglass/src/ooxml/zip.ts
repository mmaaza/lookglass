import { ViewerError } from '../core/errors.js';
import type { Source } from '../source/types.js';

/**
 * A ZIP reader that works over byte ranges.
 *
 * OOXML packages are ZIP files, and the usual way to open one is to read the
 * whole file into memory and hand it to JSZip. That makes a 200 MB deck with
 * one slide on screen cost 200 MB before anything is shown. This reader reads
 * the central directory from the end of the file, then reads each part only
 * when it is asked for — so over HTTP, only the XML and the images actually
 * displayed are ever downloaded.
 *
 * Inflation uses the platform's `DecompressionStream('deflate-raw')`, which
 * every supported browser has, so no inflate library ships with lookglass.
 * Output is bounded while it streams: an entry that inflates past its
 * declared size, or past the caller's limit, is stopped rather than allowed
 * to fill memory.
 */

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
/** Local headers usually repeat the central directory's extra field; slack covers the rest. */
const LOCAL_HEADER_SLACK = 256;

export class ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  private readonly source: Source;

  private constructor(source: Source, entries: Map<string, ZipEntry>) {
    this.source = source;
    this.entries = entries;
  }

  /** Read the directory. Costs one or two range reads at the end of the file. */
  static async open(source: Source, signal?: AbortSignal): Promise<ZipArchive> {
    // A 1-byte probe resolves the size of a remote source.
    if (source.size < 0) await source.slice(0, 1, signal);
    const size = source.size;
    if (size < EOCD_MIN_BYTES) throw corrupt('the file is too small to be a ZIP package');

    const tailStart = Math.max(0, size - (EOCD_MIN_BYTES + MAX_COMMENT_BYTES + 20));
    const tail = await source.slice(tailStart, size, signal);
    const tailView = view(tail);
    const eocd = findEocd(tailView);
    if (eocd < 0) throw corrupt('no ZIP directory was found');

    let count = tailView.getUint16(eocd + 10, true);
    let directorySize = tailView.getUint32(eocd + 12, true);
    let directoryOffset = tailView.getUint32(eocd + 16, true);

    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tailView.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
        throw corrupt('the ZIP64 directory locator is missing');
      }
      const recordOffset = Number(tailView.getBigUint64(locator + 8, true));
      const record = view(await source.slice(recordOffset, recordOffset + 56, signal));
      if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) throw corrupt('the ZIP64 directory is damaged');
      count = Number(record.getBigUint64(32, true));
      directorySize = Number(record.getBigUint64(40, true));
      directoryOffset = Number(record.getBigUint64(48, true));
    }

    if (directoryOffset + directorySize > size) throw corrupt('the ZIP directory points past the end of the file');
    const directory =
      directoryOffset >= tailStart
        ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
        : await source.slice(directoryOffset, directoryOffset + directorySize, signal);

    const entries = new Map<string, ZipEntry>();
    for (const entry of parseCentralDirectory(directory, count)) {
      if (entry.name.endsWith('/')) continue; // folder entries carry no data
      // Names are case-insensitive in OPC; keep the first of any duplicates.
      const key = normaliseName(entry.name);
      if (!entries.has(key)) entries.set(key, entry);
    }
    return new ZipArchive(source, entries);
  }

  has(name: string): boolean {
    return this.entries.has(normaliseName(name));
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.get(normaliseName(name));
  }

  /** Inflated bytes of one entry. */
  async read(name: string, opts: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const entry = this.entry(name);
    if (!entry) throw corrupt(`the part ${name} is missing`);
    if (entry.flags & 1) {
      throw new ViewerError('password-required', 'This file uses ZIP encryption, which cannot be opened in the browser.', {
        retryable: false,
      });
    }
    const limit = Math.min(opts.maxBytes ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (entry.uncompressedSize > limit) {
      throw new ViewerError('too-large', `The part ${name} inflates to ${entry.uncompressedSize} bytes, above the limit.`, {
        retryable: false,
        detail: { part: name, bytes: entry.uncompressedSize, limit },
      });
    }

    const guess = 30 + entry.name.length + LOCAL_HEADER_SLACK + entry.compressedSize;
    let chunk = await this.source.slice(entry.localHeaderOffset, entry.localHeaderOffset + guess, opts.signal);
    const header = view(chunk);
    if (chunk.byteLength < 30 || header.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw corrupt(`the header of ${name} is damaged`);
    }
    const dataStart = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > chunk.byteLength) {
      chunk = await this.source.slice(entry.localHeaderOffset, entry.localHeaderOffset + dataEnd, opts.signal);
    }
    const data = chunk.subarray(dataStart, dataEnd);

    if (entry.method === 0) return data.slice();
    if (entry.method !== 8) throw corrupt(`${name} uses an unsupported compression method (${entry.method})`);
    // The declared size is a hint that can lie; the limit cannot be exceeded.
    return inflateRaw(data, Math.min(limit, Math.max(entry.uncompressedSize, 1) * 2 + 1024), opts.signal);
  }

  async text(name: string, opts: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<string> {
    return decodeXmlText(await this.read(name, opts));
  }
}

/** Decode a part as text, honouring a UTF-16 byte-order mark (rare, but legal in OPC). */
export function decodeXmlText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseCentralDirectory(directory: Uint8Array, count: number): ZipEntry[] {
  const directoryView = view(directory);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directory.byteLength || directoryView.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw corrupt('the ZIP directory is damaged');
    }
    const flags = directoryView.getUint16(offset + 8, true);
    const method = directoryView.getUint16(offset + 10, true);
    let compressedSize = directoryView.getUint32(offset + 20, true);
    let uncompressedSize = directoryView.getUint32(offset + 24, true);
    const nameLength = directoryView.getUint16(offset + 28, true);
    const extraLength = directoryView.getUint16(offset + 30, true);
    const commentLength = directoryView.getUint16(offset + 32, true);
    let localHeaderOffset = directoryView.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLength;
    const extraEnd = extraStart + extraLength;
    if (extraEnd > directory.byteLength) throw corrupt('the ZIP directory is truncated');
    const name = decoder.decode(directory.subarray(nameStart, extraStart));

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      // ZIP64 extra field: 64-bit values, in this order, for each field whose
      // 32-bit value is the 0xFFFFFFFF placeholder.
      for (let cursor = extraStart; cursor + 4 <= extraEnd; ) {
        const id = directoryView.getUint16(cursor, true);
        const size = directoryView.getUint16(cursor + 2, true);
        if (id === 0x0001) {
          let field = cursor + 4;
          const next = () => {
            const value = field + 8 <= extraEnd ? Number(directoryView.getBigUint64(field, true)) : 0;
            field += 8;
            return value;
          };
          if (uncompressedSize === 0xffffffff) uncompressedSize = next();
          if (compressedSize === 0xffffffff) compressedSize = next();
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
          break;
        }
        cursor += 4 + size;
      }
    }

    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    offset = extraEnd + commentLength;
  }
  return entries;
}

/** Entries of an in-memory archive, or undefined when it has no readable directory. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | undefined {
  const bytesView = view(bytes);
  const eocd = findEocd(bytesView);
  if (eocd < 0) return undefined;
  let count = bytesView.getUint16(eocd + 10, true);
  let directoryOffset = bytesView.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || bytesView.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) return undefined;
    const record = Number(bytesView.getBigUint64(locator + 8, true));
    if (record + 56 > bytes.byteLength || bytesView.getUint32(record, true) !== ZIP64_EOCD_SIGNATURE) return undefined;
    count = Number(bytesView.getBigUint64(record + 32, true));
    directoryOffset = Number(bytesView.getBigUint64(record + 48, true));
  }
  if (directoryOffset > bytes.byteLength) return undefined;
  try {
    return parseCentralDirectory(bytes.subarray(directoryOffset), count);
  } catch {
    return undefined;
  }
}

async function inflateRaw(data: Uint8Array, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new ViewerError('too-large', 'A part of this file inflates to far more than its declared size.', {
          retryable: false,
          detail: { limit },
        });
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof ViewerError || (err as { name?: string })?.name === 'AbortError') throw err;
    throw corrupt('a compressed part is damaged');
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function findEocd(dataView: DataView): number {
  const last = dataView.byteLength - EOCD_MIN_BYTES;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);
  for (let offset = last; offset >= first; offset--) {
    if (dataView.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

export function normaliseName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function corrupt(reason: string): ViewerError {
  return new ViewerError('corrupt', `This file is damaged: ${reason}.`, { retryable: false });
}
