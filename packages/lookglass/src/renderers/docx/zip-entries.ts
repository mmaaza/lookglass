/**
 * Read a ZIP central directory without inflating anything.
 *
 * DOCX is a ZIP of XML parts, and the parser needs `word/document.xml` fully
 * inflated and parsed on the main thread. Its compressed size says little: a
 * 2 MB file can hold a 2 GB XML part, and inflating that freezes and then
 * kills the tab. The central directory records every entry's uncompressed
 * size, so it is checked first and an oversized package is refused before
 * any work is done.
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
/** The EOCD record ends with a comment of at most 65,535 bytes. */
const MAX_COMMENT_BYTES = 0xffff;

/** Entries of the archive, or `undefined` when it has no readable directory. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) return undefined;

  let count = view.getUint16(eocd + 10, true);
  let directoryOffset = view.getUint32(eocd + 16, true);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) return undefined;
    const record = Number(view.getBigUint64(locator + 8, true));
    if (record + 56 > bytes.byteLength || view.getUint32(record, true) !== ZIP64_EOCD_SIGNATURE) return undefined;
    count = Number(view.getBigUint64(record + 32, true));
    directoryOffset = Number(view.getBigUint64(record + 48, true));
  }

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return undefined;
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength > bytes.byteLength) return undefined;
    const name = decoder.decode(bytes.subarray(nameStart, extraStart));

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      // ZIP64 extra field: the 64-bit sizes appear in this order, and only
      // for the fields whose 32-bit value is the 0xFFFFFFFF placeholder.
      let cursor = extraStart;
      const end = extraStart + extraLength;
      while (cursor + 4 <= end) {
        const id = view.getUint16(cursor, true);
        const size = view.getUint16(cursor + 2, true);
        if (id === 0x0001) {
          let field = cursor + 4;
          if (uncompressedSize === 0xffffffff && field + 8 <= end) {
            uncompressedSize = Number(view.getBigUint64(field, true));
            field += 8;
          }
          if (compressedSize === 0xffffffff && field + 8 <= end) {
            compressedSize = Number(view.getBigUint64(field, true));
          }
          break;
        }
        cursor += 4 + size;
      }
    }

    entries.push({ name, compressedSize, uncompressedSize });
    offset = extraStart + extraLength + commentLength;
  }
  return entries;
}

function findEocd(view: DataView): number {
  const last = view.byteLength - EOCD_MIN_BYTES;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);
  for (let offset = last; offset >= first; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}
