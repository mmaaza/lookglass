import type { SearchHit } from '../types.js';

/**
 * Contract between a tabular worker (CSV or workbook) and the shared grid.
 *
 * Both formats serve the same shapes, so the grid surface, its tile cache,
 * selection, formula bar and search highlighting are written once. Adding
 * another tabular format means writing a worker, not a UI.
 */

/** Cells served per tile. Rows are cheap to add; columns are what make tiles wide. */
export const TILE_ROWS = 128;
export const TILE_COLS = 32;

export interface CellRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface GridSheetInfo {
  index: number;
  name: string;
  rowCount: number;
  columnCount: number;
  /** Per-column width in CSS px at 100% zoom. Missing entries use the default. */
  columnWidths: number[];
  /** Header labels. Absent means spreadsheet letters (A, B, ... AA). */
  columnTitles?: string[];
  /** Number shown on the first data row; 1 for workbooks, 1 or 2 for CSV. */
  firstRowNumber: number;
  merges: CellRange[];
  /** Set when fewer rows were loaded than the sheet holds. */
  truncated?: { shownRows: number; totalRows: number };
}

/**
 * One rectangular window of cells.
 *
 * `types` holds one character per cell — `n` number, `s` string, `b` boolean,
 * `d` date, `e` error, `z` empty — packed per row, which is far cheaper to
 * post across threads than an object per cell.
 */
export interface GridTile {
  r0: number;
  c0: number;
  text: string[][];
  types: string[];
}

export interface CellDetail {
  /** A1-style address, or `R12 C3` style for CSV without letters. */
  address: string;
  /** Display text. */
  display: string;
  /** Formula source, when the cell has one. Never evaluated. */
  formula?: string;
  type: string;
}

export interface GridWorkerApi {
  openSheet(args: { sheet: number }): Promise<GridSheetInfo>;
  getTile(args: { sheet: number; r0: number; r1: number; c0: number; c1: number }): Promise<GridTile>;
  getCell(args: { sheet: number; r: number; c: number }): Promise<CellDetail>;
  search(args: { sheet: number; query: string; limit?: number }): Promise<{ hits: SearchHit[]; truncated: boolean }>;
}

/** Spreadsheet column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Search hit ids carry the cell, so the grid can highlight it. */
export function hitId(sheet: number, r: number, c: number): string {
  return `${sheet}:${r}:${c}`;
}

export function parseHitId(id: string): { sheet: number; r: number; c: number } | undefined {
  const [sheet, r, c] = id.split(':').map(Number);
  if (![sheet, r, c].every((value) => Number.isFinite(value))) return undefined;
  return { sheet: sheet!, r: r!, c: c! };
}
