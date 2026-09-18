/// <reference lib="webworker" />
import * as cpexcel from '../../vendor/sheetjs/cpexcel.full.mjs';
import * as XLSX from '../../vendor/sheetjs/xlsx.mjs';
import { ViewerError } from '../core/errors.js';
import { exposeRpc, type RpcContext } from '../core/rpc.js';
import { formatBytes } from '../source/blob.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { SourceDescriptor } from '../source/types.js';
import type { SearchHit } from '../types.js';
import { hitId, type CellDetail, type GridSheetInfo, type GridTile } from './grid-types.js';

/**
 * Workbook server for XLSX, XLSM, XLS, XLSB and ODS, via vendored SheetJS.
 *
 * Unlike CSV, a workbook is a compressed container with shared-string and
 * style tables, so it cannot be range-read: the file is read whole, and
 * that is what the size ceiling protects. What *can* be lazy is parsing.
 * Opening a workbook only lists its sheets; each sheet is parsed the first
 * time it is shown, and only the two most recent parsed sheets are kept.
 *
 * Formulas are never evaluated. SheetJS returns the value Excel cached when
 * the file was saved, which is what the author saw, and nothing in a
 * document can make the viewer compute anything.
 */

// The whole module, not its `cptable` export: SheetJS calls `.utils.decode`
// on it, and legacy .xls files crash on open without that.
XLSX.set_cptable(cpexcel);

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/**
 * Parsed cells cost on the order of 100 bytes each, so row count is the
 * memory lever. Beyond this the sheet is truncated with a visible notice; the
 * CSV viewer streams and has no such limit.
 */
const DEFAULT_MAX_ROWS = 100_000;
const MAX_PARSED_SHEETS = 2;
const DEFAULT_COLUMN_PX = 80;
const SEARCH_HIT_LIMIT = 2000;

type Sheet = XLSX.WorkSheet & { '!data'?: (XLSX.CellObject | undefined)[][] };

interface State {
  bytes: Uint8Array;
  names: string[];
  hidden: boolean[];
  maxRows: number;
  /** Parsed sheets, most recently used last. */
  parsed: Map<number, { sheet: Sheet; info: GridSheetInfo }>;
}

let state: State | undefined;

export interface OpenWorkbookArgs {
  descriptor: SourceDescriptor;
  maxBytes?: number;
  maxRows?: number;
}

export interface OpenWorkbookResult {
  sheets: { name: string; hidden: boolean }[];
  byteLength: number;
  title?: string;
  author?: string;
}

const handlers = {
  async open(args: OpenWorkbookArgs, ctx: RpcContext): Promise<OpenWorkbookResult> {
    const source = sourceFromDescriptor(args.descriptor);
    const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
    if (source.size > maxBytes) {
      throw new ViewerError(
        'too-large',
        `This workbook is ${formatBytes(source.size)}, over the ${formatBytes(maxBytes)} limit for spreadsheets. Export the sheet as CSV to view it in full.`,
        { detail: { size: source.size, maxBytes }, retryable: false },
      );
    }

    ctx.progress({ phase: 'fetching', message: 'Reading workbook' });
    const bytes = await source.bytes({
      maxBytes,
      signal: ctx.signal,
      onProgress: (done, total) =>
        ctx.progress({ phase: 'fetching', bytesDone: done, bytesTotal: total, ratio: total > 0 ? done / total : undefined }),
    });
    source.dispose();

    ctx.progress({ phase: 'parsing', message: 'Reading sheet list' });
    let book: XLSX.WorkBook;
    try {
      // Workbook metadata only: `sheets: []` parses no cells but, unlike
      // `bookSheets`, still reads which sheets are hidden.
      book = XLSX.read(bytes, { type: 'array', sheets: [] });
    } catch (err) {
      throw asWorkbookError(err);
    }

    const names = book.SheetNames;
    if (names.length === 0) throw new ViewerError('corrupt', 'This workbook has no sheets.', { retryable: false });
    const hidden = names.map((_, index) => Boolean(book.Workbook?.Sheets?.[index]?.Hidden));

    state = {
      bytes,
      names,
      hidden,
      maxRows: args.maxRows ?? DEFAULT_MAX_ROWS,
      parsed: new Map(),
    };

    return {
      sheets: names.map((name, index) => ({ name, hidden: hidden[index]! })),
      byteLength: bytes.byteLength,
      title: book.Props?.Title || undefined,
      author: book.Props?.Author || undefined,
    };
  },

  openSheet(args: { sheet: number }, ctx: RpcContext): GridSheetInfo {
    return loadSheet(args.sheet, ctx).info;
  },

  getTile(args: { sheet: number; r0: number; r1: number; c0: number; c1: number }, ctx: RpcContext): GridTile {
    const { sheet } = loadSheet(args.sheet, ctx);
    const data = sheet['!data'] ?? [];
    const text: string[][] = [];
    const types: string[] = [];
    for (let r = args.r0; r < args.r1; r++) {
      const row = data[r];
      const values: string[] = [];
      let rowTypes = '';
      for (let c = args.c0; c < args.c1; c++) {
        const cell = row?.[c];
        values.push(cell ? display(cell) : '');
        rowTypes += cell ? typeCode(cell) : 'z';
      }
      text.push(values);
      types.push(rowTypes);
    }
    return { r0: args.r0, c0: args.c0, text, types };
  },

  getCell(args: { sheet: number; r: number; c: number }, ctx: RpcContext): CellDetail {
    const { sheet } = loadSheet(args.sheet, ctx);
    const cell = sheet['!data']?.[args.r]?.[args.c];
    return {
      address: XLSX.utils.encode_cell({ r: args.r, c: args.c }),
      display: cell ? display(cell) : '',
      formula: cell?.f ? `=${cell.f}` : undefined,
      type: cell ? typeCode(cell) : 'z',
    };
  },

  /** Current sheet only: searching every sheet would force parsing them all. */
  search(args: { sheet: number; query: string; limit?: number }, ctx: RpcContext): { hits: SearchHit[]; truncated: boolean } {
    const { sheet } = loadSheet(args.sheet, ctx);
    const needle = args.query.toLowerCase();
    const limit = args.limit ?? SEARCH_HIT_LIMIT;
    const hits: SearchHit[] = [];
    if (!needle) return { hits, truncated: false };

    const data = sheet['!data'] ?? [];
    for (let r = 0; r < data.length && hits.length < limit; r++) {
      if (r % 2000 === 0) ctx.signal.throwIfAborted();
      const row = data[r];
      if (!row) continue;
      for (let c = 0; c < row.length && hits.length < limit; c++) {
        const cell = row[c];
        if (!cell) continue;
        const value = display(cell);
        const at = value.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        hits.push({
          id: hitId(args.sheet, r, c),
          page: r + 1,
          excerpt: value.length > 120 ? value.slice(Math.max(0, at - 40), at + needle.length + 40) : value,
          excerptOffset: value.length > 120 ? Math.min(40, at) : at,
          excerptLength: needle.length,
        });
      }
    }
    return { hits, truncated: hits.length >= limit };
  },

  close(): void {
    state = undefined;
  },
};

export type SheetWorkerHandlers = typeof handlers;

function loadSheet(index: number, ctx?: RpcContext): { sheet: Sheet; info: GridSheetInfo } {
  const current = required();
  const hit = current.parsed.get(index);
  if (hit) {
    current.parsed.delete(index);
    current.parsed.set(index, hit);
    return hit;
  }

  const name = current.names[index];
  if (name === undefined) throw new ViewerError('internal', `Sheet ${index} does not exist.`);
  ctx?.progress({ phase: 'parsing', message: `Reading sheet “${name}”` });

  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(current.bytes, {
      type: 'array',
      sheets: [name],
      dense: true,
      // Needed for column widths and hidden columns; costs a style reference
      // per cell, which readable column widths are worth.
      cellStyles: true,
      cellDates: true,
      sheetRows: current.maxRows + 1,
    });
  } catch (err) {
    throw asWorkbookError(err);
  }

  const sheet = book.Sheets[name] as Sheet | undefined;
  const info = describe(index, name, sheet, current.maxRows);
  const entry = { sheet: sheet ?? ({} as Sheet), info };

  current.parsed.set(index, entry);
  if (current.parsed.size > MAX_PARSED_SHEETS) {
    current.parsed.delete(current.parsed.keys().next().value as number);
  }
  return entry;
}

function describe(index: number, name: string, sheet: Sheet | undefined, maxRows: number): GridSheetInfo {
  if (!sheet?.['!ref']) {
    // Chart sheets and genuinely empty sheets have no range.
    return { index, name, rowCount: 0, columnCount: 0, columnWidths: [], firstRowNumber: 1, merges: [] };
  }

  // Rows and columns start at A1, not at the first used cell, so addresses in
  // the grid match what the author sees in Excel.
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const full = sheet['!fullref'] ? XLSX.utils.decode_range(sheet['!fullref']) : range;
  const rowCount = Math.min(range.e.r + 1, maxRows);
  const columnCount = range.e.c + 1;

  const cols = sheet['!cols'] ?? [];
  const columnWidths: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    const col = cols[c];
    if (col?.hidden) columnWidths.push(0);
    else if (col?.wpx) columnWidths.push(Math.round(col.wpx * 1.1));
    else if (col?.wch) columnWidths.push(Math.round(col.wch * 7 + 10));
    else columnWidths.push(DEFAULT_COLUMN_PX);
  }

  const totalRows = full.e.r + 1;
  return {
    index,
    name,
    rowCount,
    columnCount,
    columnWidths,
    firstRowNumber: 1,
    merges: (sheet['!merges'] ?? []).filter((merge) => merge.s.r < rowCount),
    truncated: totalRows > rowCount ? { shownRows: rowCount, totalRows } : undefined,
  };
}

/** Excel's own formatted text first; it already applies the number format. */
function display(cell: XLSX.CellObject): string {
  if (cell.w !== undefined) return cell.w;
  if (cell.v === undefined || cell.v === null) return '';
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v);
}

function typeCode(cell: XLSX.CellObject): string {
  switch (cell.t) {
    case 'n':
    case 'b':
    case 'd':
    case 'e':
      return cell.t;
    case 'z':
      return 'z';
    default:
      return 's';
  }
}

function required(): State {
  if (!state) throw new Error('Workbook is not open.');
  return state;
}

function asWorkbookError(err: unknown): ViewerError {
  const message = err instanceof Error ? err.message : String(err);
  if (/password|encrypt/i.test(message)) {
    // SheetJS Community Edition cannot decrypt protected workbooks.
    return new ViewerError(
      'password-required',
      'This workbook is password protected. Encrypted workbooks cannot be previewed; open it in Excel instead.',
      { cause: err, retryable: false },
    );
  }
  return new ViewerError('corrupt', 'This workbook could not be read. It may be damaged or in an unsupported format.', {
    cause: err,
    retryable: false,
  });
}

exposeRpc(handlers as never);
