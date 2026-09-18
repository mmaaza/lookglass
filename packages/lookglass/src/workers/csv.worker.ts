/// <reference lib="webworker" />
import { exposeRpc, type RpcContext } from '../core/rpc.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { Source, SourceDescriptor } from '../source/types.js';
import type { SearchHit } from '../types.js';
import { cellType, indexRows, parseRows, sniffDialect, type CsvDialect, type RowIndex } from './csv-scan.js';
import { columnLetters, hitId, type CellDetail, type GridSheetInfo, type GridTile } from './grid-types.js';

/**
 * CSV/TSV document server.
 *
 * Holds a byte-offset index of every row and serves rectangular tiles by
 * reading exactly the rows a tile needs. Parsed rows are kept in a small
 * block cache, because a wide file is tiled horizontally and the same rows
 * would otherwise be re-read once per column tile.
 */

const BLOCK_ROWS = 256;
const MAX_CACHED_BLOCKS = 24;
const WIDTH_SAMPLE_ROWS = 500;
const SEARCH_BLOCK_ROWS = 4096;
const SEARCH_HIT_LIMIT = 2000;

interface State {
  source: Source;
  dialect: CsvDialect;
  index: RowIndex;
  decoder: TextDecoder;
  /** 1 when the first file row is a header and not data. */
  dataOffset: number;
  blocks: Map<number, string[][]>;
  info: GridSheetInfo;
}

let state: State | undefined;

export interface OpenCsvArgs {
  descriptor: SourceDescriptor;
  ext?: string;
  /** `'auto'` guesses from the first two rows. */
  header?: boolean | 'auto';
}

export interface OpenCsvResult {
  info: GridSheetInfo;
  delimiter: string;
  encoding: string;
  byteLength: number;
}

const handlers = {
  async open(args: OpenCsvArgs, ctx: RpcContext): Promise<OpenCsvResult> {
    const source = sourceFromDescriptor(args.descriptor);
    const head = await source.slice(0, Math.min(source.size, 64 * 1024), ctx.signal);
    const dialect = sniffDialect(head, args.ext);

    ctx.progress({ phase: 'indexing', message: 'Indexing rows' });
    const index = await indexRows(source, dialect, {
      signal: ctx.signal,
      onProgress: (done, total, rows) =>
        ctx.progress({
          phase: 'indexing',
          bytesDone: done,
          bytesTotal: total,
          ratio: total > 0 ? done / total : undefined,
          message: `Indexing — ${rows.toLocaleString()} rows`,
        }),
    });

    const decoder = new TextDecoder(dialect.encoding, { fatal: false });
    const partial: State = {
      source,
      dialect,
      index,
      decoder,
      dataOffset: 0,
      blocks: new Map(),
      info: undefined as never,
    };
    state = partial;

    const sample = await readFileRows(partial, 0, Math.min(index.rowCount, WIDTH_SAMPLE_ROWS), ctx.signal);
    const useHeader = args.header === 'auto' || args.header === undefined ? looksLikeHeader(sample) : args.header;
    partial.dataOffset = useHeader && index.rowCount > 0 ? 1 : 0;

    const columnCount = index.maxColumns;
    const titles = useHeader ? padTo(sample[0] ?? [], columnCount) : undefined;
    partial.info = {
      index: 0,
      name: 'Data',
      rowCount: Math.max(0, index.rowCount - partial.dataOffset),
      columnCount,
      columnWidths: estimateWidths(sample.slice(partial.dataOffset), titles, columnCount),
      columnTitles: titles,
      firstRowNumber: 1,
      merges: [],
      truncated: index.truncated ? { shownRows: index.rowCount, totalRows: index.rowCount } : undefined,
    };

    return {
      info: partial.info,
      delimiter: dialect.delimiter,
      encoding: dialect.encoding,
      byteLength: source.size,
    };
  },

  openSheet(): GridSheetInfo {
    return required().info;
  },

  async getTile(
    args: { sheet: number; r0: number; r1: number; c0: number; c1: number },
    ctx: RpcContext,
  ): Promise<GridTile> {
    const current = required();
    const rows = await readDataRows(current, args.r0, args.r1, ctx.signal);
    return {
      r0: args.r0,
      c0: args.c0,
      text: rows.map((row) => row.slice(args.c0, args.c1)),
      types: rows.map((row) => {
        let types = '';
        for (let c = args.c0; c < args.c1; c++) {
          const value = row[c];
          types += value === undefined || value === '' ? 'z' : cellType(value);
        }
        return types;
      }),
    };
  },

  async getCell(args: { sheet: number; r: number; c: number }, ctx: RpcContext): Promise<CellDetail> {
    const current = required();
    const [row] = await readDataRows(current, args.r, args.r + 1, ctx.signal);
    const display = row?.[args.c] ?? '';
    const title = current.info.columnTitles?.[args.c];
    return {
      address: `${columnLetters(args.c)}${args.r + 1}${title ? ` · ${title}` : ''}`,
      display,
      type: display === '' ? 'z' : cellType(display),
    };
  },

  /**
   * Scan the data in large blocks, stopping at the hit limit. Hits carry the
   * exact cell, so the grid can scroll horizontally to it as well.
   */
  async search(
    args: { sheet: number; query: string; limit?: number },
    ctx: RpcContext,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const current = required();
    const needle = args.query.toLowerCase();
    const limit = args.limit ?? SEARCH_HIT_LIMIT;
    const hits: SearchHit[] = [];
    if (!needle) return { hits, truncated: false };

    const total = current.info.rowCount;
    for (let r0 = 0; r0 < total && hits.length < limit; r0 += SEARCH_BLOCK_ROWS) {
      ctx.signal.throwIfAborted();
      const r1 = Math.min(total, r0 + SEARCH_BLOCK_ROWS);
      // Read around the block cache: a search must not evict the rows on screen.
      const rows = await readFileRows(current, r0 + current.dataOffset, r1 + current.dataOffset, ctx.signal);
      rows.forEach((row, offset) => {
        row.forEach((value, c) => {
          if (hits.length >= limit) return;
          const at = value.toLowerCase().indexOf(needle);
          if (at === -1) return;
          const r = r0 + offset;
          hits.push({
            id: hitId(0, r, c),
            page: r + 1,
            excerpt: value.length > 120 ? `${value.slice(Math.max(0, at - 40), at + needle.length + 40)}` : value,
            excerptOffset: value.length > 120 ? Math.min(40, at) : at,
            excerptLength: needle.length,
          });
        });
      });
      ctx.progress({
        phase: 'indexing',
        ratio: r1 / Math.max(1, total),
        message: `Searched ${r1.toLocaleString()} of ${total.toLocaleString()} rows`,
      });
    }
    return { hits, truncated: hits.length >= limit };
  },

  close(): void {
    state?.source.dispose();
    state = undefined;
  },
};

export type CsvWorkerHandlers = typeof handlers;

function required(): State {
  if (!state) throw new Error('CSV document is not open.');
  return state;
}

/** Data rows `[r0, r1)`, i.e. excluding a header row, via the block cache. */
async function readDataRows(current: State, r0: number, r1: number, signal?: AbortSignal): Promise<string[][]> {
  const out: string[][] = [];
  for (let block = Math.floor(r0 / BLOCK_ROWS); block * BLOCK_ROWS < r1; block++) {
    let rows = current.blocks.get(block);
    if (!rows) {
      const start = block * BLOCK_ROWS;
      rows = await readFileRows(
        current,
        start + current.dataOffset,
        Math.min(current.info.rowCount, start + BLOCK_ROWS) + current.dataOffset,
        signal,
      );
      current.blocks.set(block, rows);
      if (current.blocks.size > MAX_CACHED_BLOCKS) {
        current.blocks.delete(current.blocks.keys().next().value as number);
      }
    } else {
      // Refresh recency.
      current.blocks.delete(block);
      current.blocks.set(block, rows);
    }
    const blockStart = block * BLOCK_ROWS;
    for (let r = Math.max(r0, blockStart); r < Math.min(r1, blockStart + rows.length); r++) {
      out.push(rows[r - blockStart]!);
    }
  }
  return out;
}

/** File rows `[r0, r1)` straight from the index: one read, one decode. */
async function readFileRows(current: State, r0: number, r1: number, signal?: AbortSignal): Promise<string[][]> {
  const { index } = current;
  const start = Math.max(0, Math.min(r0, index.rowCount));
  const end = Math.max(start, Math.min(r1, index.rowCount));
  if (start === end) return [];
  const byteStart = index.offsets[start]!;
  const byteEnd = end < index.rowCount ? index.offsets[end]! : index.indexedBytes;
  const bytes = await current.source.slice(byteStart, byteEnd, signal);
  const rows = parseRows(current.decoder.decode(bytes), current.dialect.delimiter, end - start);
  // A blank line parses to no row at all; keep indices aligned with the index.
  while (rows.length < end - start) rows.push([]);
  return rows;
}

/**
 * Header heuristic: the first row is all non-numeric text, and some column
 * below it holds numbers. A file of all text is ambiguous, so it is treated
 * as having a header when the first row's values are all distinct.
 */
function looksLikeHeader(rows: string[][]): boolean {
  const [first, ...rest] = rows;
  if (!first || rest.length === 0) return false;
  if (first.some((value) => value.trim() === '' || cellType(value) === 'n')) return false;
  const numericBelow = first.some((_, c) => rest.slice(0, 50).some((row) => row[c] && cellType(row[c]!) === 'n'));
  return numericBelow || new Set(first).size === first.length;
}

function estimateWidths(rows: string[][], titles: string[] | undefined, columns: number): number[] {
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    let longest = titles?.[c]?.length ?? 0;
    for (const row of rows) {
      const length = row[c]?.length ?? 0;
      if (length > longest) longest = length;
    }
    // ~7 px per character at 13 px, plus padding; clamped so one long note
    // does not make a column wider than the viewport.
    widths.push(Math.max(56, Math.min(360, longest * 7 + 20)));
  }
  return widths;
}

function padTo(row: string[], length: number): string[] {
  const out = row.slice(0, length);
  while (out.length < length) out.push('');
  return out;
}

exposeRpc(handlers as never);
