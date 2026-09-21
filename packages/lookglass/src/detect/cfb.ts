import type { Source } from '../source/types.js';

/**
 * Just enough of the Compound File Binary format to tell its users apart.
 *
 * Legacy `.doc`, `.xls` and `.ppt` files and *password-protected* OOXML files
 * all use this container, so the magic number alone says very little. The
 * names of the top-level streams say which it is:
 *
 * | stream               | written by                          |
 * | -------------------- | ----------------------------------- |
 * | `EncryptedPackage`   | an encrypted .docx/.xlsx/.pptx      |
 * | `WordDocument`       | Word 97-2003                        |
 * | `Workbook` / `Book`  | Excel 97-2003 / Excel 5             |
 * | `PowerPoint Document`| PowerPoint 97-2003                  |
 *
 * Only the first few directory sectors are read, in one range request, and
 * the sector chain is not followed. The streams above are created first, so
 * they sit at the start of the directory in files written by Office. When
 * they are not found, detection falls back to the extension, as before.
 */

export type CfbFlavour = 'encrypted' | 'doc' | 'xls' | 'ppt';

const DIRECTORY_ENTRY_BYTES = 128;
const MAX_DIRECTORY_BYTES = 16 * 1024;

/** Stream names found in the first directory sectors. Empty when unreadable. */
export async function cfbStreamNames(source: Source, head: Uint8Array, signal?: AbortSignal): Promise<string[]> {
  if (head.byteLength < 0x34) return [];
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const sectorShift = view.getUint16(0x1e, true);
  // Version 3 files use 512-byte sectors and version 4 files 4096-byte ones.
  if (sectorShift !== 9 && sectorShift !== 12) return [];
  const sectorSize = 1 << sectorShift;
  const firstDirectorySector = view.getUint32(0x30, true);
  // Values from 0xFFFFFFFA up are special markers, never a sector number.
  if (firstDirectorySector >= 0xfffffffa) return [];

  const start = (firstDirectorySector + 1) * sectorSize;
  const length = Math.min(MAX_DIRECTORY_BYTES, sectorSize * 4);
  if (source.size >= 0 && start >= source.size) return [];

  let bytes: Uint8Array;
  if (start + length <= head.byteLength) {
    bytes = head.subarray(start, start + length);
  } else {
    bytes = await source.slice(start, start + length, signal);
  }
  return readDirectoryNames(bytes);
}

/** Decode the names of directory entries from raw directory sector bytes. */
export function readDirectoryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + DIRECTORY_ENTRY_BYTES <= bytes.byteLength; offset += DIRECTORY_ENTRY_BYTES) {
    const type = bytes[offset + 0x42];
    // 1 = storage, 2 = stream, 5 = root. 0 is an unused slot.
    if (type !== 1 && type !== 2 && type !== 5) continue;
    const nameBytes = view.getUint16(offset + 0x40, true);
    if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0) continue;
    let name = '';
    // The length includes the terminating NUL.
    for (let i = 0; i < nameBytes - 2; i += 2) name += String.fromCharCode(view.getUint16(offset + i, true));
    names.push(name);
  }
  return names;
}

export function classifyCfb(names: string[]): CfbFlavour | undefined {
  const set = new Set(names);
  if (set.has('EncryptedPackage')) return 'encrypted';
  if (set.has('WordDocument')) return 'doc';
  if (set.has('Workbook') || set.has('Book')) return 'xls';
  if (set.has('PowerPoint Document')) return 'ppt';
  return undefined;
}
