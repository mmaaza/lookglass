import type { Source } from '../source/types.js';

/**
 * Streaming CSV/TSV indexer and field parser.
 *
 * Built for the same reason as the JSON scanner: the worker needs the byte
 * offset of every row, so that any window of a multi-gigabyte file can be
 * read directly. General CSV libraries parse to values and discard positions.
 *
 * The indexer is a state machine over code units rather than decoded text.
 * Delimiters, quotes and line breaks are all ASCII, which is safe to match
 * byte-wise in UTF-8 and single-byte encodings. UTF-16 — what Excel writes
 * for "Unicode text" exports — is scanned in two-byte units, because a
 * byte-wise scan would see a 0x0A inside unrelated characters.
 */

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface CsvDialect {
  delimiter: string;
  encoding: CsvEncoding;
  /** Bytes of byte-order mark to skip at the start of the file. */
  bomBytes: number;
}

const CHUNK = 1 << 20;
/** 4 bytes of index per row: 20 M rows is an 80 MB index, already a lot. */
export const MAX_ROWS = 20_000_000;

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

/* ------------------------------------------------------------------ *
 * Dialect detection
 * ------------------------------------------------------------------ */

export function sniffDialect(head: Uint8Array, ext?: string): CsvDialect {
  let encoding: CsvEncoding = 'utf-8';
  let bomBytes = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) bomBytes = 3;
  else if (head[0] === 0xff && head[1] === 0xfe) {
    encoding = 'utf-16le';
    bomBytes = 2;
  } else if (head[0] === 0xfe && head[1] === 0xff) {
    encoding = 'utf-16be';
    bomBytes = 2;
  } else if (!isValidUtf8(head)) {
    encoding = 'windows-1252';
  }

  const text = new TextDecoder(encoding, { fatal: false }).decode(head.subarray(bomBytes));
  const delimiter = ext === 'tsv' || ext === 'tab' ? '\t' : sniffDelimiter(text);
  return { delimiter, encoding, bomBytes };
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    // Trim a multi-byte sequence cut off at the sample edge before judging.
    let end = bytes.length;
    for (let back = 1; back <= 3 && end - back >= 0; back++) {
      const byte = bytes[end - back]!;
      if ((byte & 0xc0) === 0x80) continue;
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (needed > back) end -= back;
      break;
    }
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the delimiter that gives the most *consistent* field count across
 * sample rows. Counting occurrences alone picks commas in European CSVs that
 * use `;` separators and `,` decimals.
 */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 64 * 1024);
  let best = { delimiter: ',', score: -1 };
  for (const delimiter of [',', '\t', ';', '|']) {
    const sample = parseRows(head, delimiter, 30);
    // The last row may be cut off mid-way by the sample boundary.
    const counts = sample.slice(0, Math.max(1, sample.length - 1)).map((row) => row.length);
    if (counts.length === 0 || counts[0]! < 2) continue;
    const first = counts[0]!;
    const consistent = counts.filter((count) => count === first).length / counts.length;
    const score = consistent * 100 + Math.min(first, 50);
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/* ------------------------------------------------------------------ *
 * Row indexing
 * ------------------------------------------------------------------ */

export interface RowIndex {
  /** Byte offset of each row's first unit. */
  offsets: Uint32Array | Float64Array;
  rowCount: number;
  /** Widest row seen, in fields. */
  maxColumns: number;
  /** Byte where indexing stopped: the file end, unless truncated. */
  indexedBytes: number;
  truncated: boolean;
}

export interface IndexOptions {
  signal?: AbortSignal;
  onProgress?: (bytesDone: number, bytesTotal: number, rows: number) => void;
  maxRows?: number;
}

/**
 * Find every row start in one streaming pass.
 *
 * Quote handling follows RFC 4180 and tolerates the common malformation: a
 * quote only opens a quoted field at the start of a field, so `5" floppy`
 * in an unquoted field does not swallow the rest of the file as one row.
 */
export async function indexRows(source: Source, dialect: CsvDialect, opts: IndexOptions = {}): Promise<RowIndex> {
  const total = source.size;
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const unit = dialect.encoding === 'utf-16le' || dialect.encoding === 'utf-16be' ? 2 : 1;
  const bigEndian = dialect.encoding === 'utf-16be';
  const delimiter = dialect.delimiter.charCodeAt(0);

  // Uint32 offsets halve the index size; only files past 4 GB need Float64.
  const Offsets = total >= 2 ** 32 ? Float64Array : Uint32Array;
  let capacity = Math.max(1024, Math.min(maxRows, Math.ceil(total / 60) + 16));
  let offsets: Uint32Array | Float64Array = new Offsets(capacity);
  let rowCount = 0;
  let maxColumns = 0;
  let truncated = false;

  const pushRow = (offset: number): boolean => {
    if (rowCount >= maxRows) {
      truncated = true;
      return false;
    }
    if (rowCount >= capacity) {
      capacity = Math.min(maxRows, capacity * 2);
      const grown = new Offsets(capacity);
      grown.set(offsets);
      offsets = grown;
    }
    offsets[rowCount++] = offset;
    return true;
  };

  let inQuotes = false;
  let quotePending = false; // saw a quote while quoted: closing, or first of ""
  let atFieldStart = true;
  let fields = 1;
  let rowHasContent = false;
  let previousWasCR = false;
  let indexedBytes = total;

  pushRow(dialect.bomBytes);
  let position = dialect.bomBytes;

  outer: while (position < total) {
    opts.signal?.throwIfAborted();
    // Keep chunk boundaries unit-aligned so UTF-16 pairs never split.
    const end = Math.min(position + CHUNK - (CHUNK % unit), total);
    const chunk = await source.slice(position, end, opts.signal);

    for (let i = 0; i + unit <= chunk.length; i += unit) {
      const code = unit === 1 ? chunk[i]! : bigEndian ? (chunk[i]! << 8) | chunk[i + 1]! : chunk[i]! | (chunk[i + 1]! << 8);

      if (quotePending) {
        quotePending = false;
        if (code === QUOTE) {
          // Escaped quote inside a quoted field.
          inQuotes = true;
          continue;
        }
        // The quote closed the field; fall through to handle this unit.
      }

      if (inQuotes) {
        if (code === QUOTE) {
          inQuotes = false;
          quotePending = true;
        }
        continue;
      }

      if (code === LF && previousWasCR) {
        // Second half of CRLF; the row already ended at the CR.
        previousWasCR = false;
        const next = position + i + unit;
        offsets[rowCount - 1] = next;
        continue;
      }
      previousWasCR = false;

      if (code === LF || code === CR) {
        if (fields > maxColumns) maxColumns = fields;
        const next = position + i + unit;
        if (!pushRow(next)) {
          indexedBytes = next;
          break outer;
        }
        previousWasCR = code === CR;
        fields = 1;
        atFieldStart = true;
        rowHasContent = false;
        continue;
      }

      rowHasContent = true;
      if (code === delimiter) {
        fields++;
        atFieldStart = true;
        continue;
      }
      if (code === QUOTE && atFieldStart) {
        inQuotes = true;
        atFieldStart = false;
        continue;
      }
      atFieldStart = false;
    }

    position = end;
    opts.onProgress?.(position, total, rowCount);
  }

  // The last row start was pushed after the final line break; if nothing
  // followed it, it is not a row.
  if (!truncated && !rowHasContent && !inQuotes && rowCount > 1 && offsets[rowCount - 1]! >= total) {
    rowCount--;
  } else if (rowHasContent && fields > maxColumns) {
    maxColumns = fields;
  }

  return {
    offsets: offsets.subarray(0, rowCount),
    rowCount,
    maxColumns: Math.max(1, maxColumns),
    indexedBytes,
    truncated,
  };
}

/* ------------------------------------------------------------------ *
 * Field parsing
 * ------------------------------------------------------------------ */

/**
 * Parse decoded CSV text into rows of fields (RFC 4180).
 *
 * Used on one window at a time, so it favours clarity over raw speed; the
 * expensive whole-file work is the indexer above.
 */
export function parseRows(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let i = 0;

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    atFieldStart = true;
  };

  while (i < text.length && rows.length < maxRows) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      i++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      atFieldStart = true;
      i++;
      continue;
    }
    if (char === '\r' || char === '\n') {
      endRow();
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    atFieldStart = false;
    i++;
  }

  if (rows.length < maxRows && (field !== '' || row.length > 0)) endRow();
  return rows;
}

/** Cell type code used by the grid for alignment: number or string. */
export function cellType(value: string): 'n' | 's' {
  return /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/.test(value.trim()) && /\d/.test(value)
    ? 'n'
    : 's';
}
