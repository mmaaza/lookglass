import type { ScopedMemory } from '../../core/memory.js';
import { stringBytes } from '../../core/memory.js';
import type { RpcClient } from '../../core/rpc.js';
import {
  TILE_COLS,
  TILE_ROWS,
  type CellDetail,
  type GridSheetInfo,
  type GridTile,
  type GridWorkerApi,
} from '../../workers/grid-types.js';

type GridClient = RpcClient<GridWorkerApi & Record<string, never>>;

/**
 * Tile cache over a tabular document held in a worker.
 *
 * Tiles are 128 rows by 32 columns and live in the shared byte budget, so a
 * user panning across a 200-column, million-row sheet evicts old tiles rather
 * than accumulating the sheet in the tab. Tiles are keyed by sheet, so
 * switching sheets and back reuses what is still cached.
 */
export class GridStore {
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly infos = new Map<number, Promise<GridSheetInfo>>();

  constructor(
    private readonly client: GridClient,
    private readonly memory: ScopedMemory,
  ) {}

  getVersion = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Sheet layout; parsing happens in the worker on first request. */
  sheet(index: number, signal?: AbortSignal): Promise<GridSheetInfo> {
    let info = this.infos.get(index);
    if (!info) {
      info = this.client.call('openSheet', { sheet: index } as never, { signal }) as Promise<GridSheetInfo>;
      info.catch(() => this.infos.delete(index));
      this.infos.set(index, info);
    }
    return info;
  }

  cell(sheet: number, r: number, c: number): { text: string; type: string } | undefined {
    const tile = this.memory.get<GridTile>(this.key(sheet, Math.floor(r / TILE_ROWS), Math.floor(c / TILE_COLS)));
    if (!tile) return undefined;
    return {
      text: tile.text[r - tile.r0]?.[c - tile.c0] ?? '',
      type: tile.types[r - tile.r0]?.[c - tile.c0] ?? 'z',
    };
  }

  detail(sheet: number, r: number, c: number): Promise<CellDetail> {
    return this.client.call('getCell', { sheet, r, c } as never) as Promise<CellDetail>;
  }

  /** Request every tile covering the window. Safe to call on every render. */
  ensure(sheet: number, info: GridSheetInfo, r0: number, r1: number, c0: number, c1: number): void {
    const rowTiles = [Math.floor(Math.max(0, r0) / TILE_ROWS), Math.floor(Math.max(0, r1 - 1) / TILE_ROWS)];
    const colTiles = [Math.floor(Math.max(0, c0) / TILE_COLS), Math.floor(Math.max(0, c1 - 1) / TILE_COLS)];
    for (let tr = rowTiles[0]!; tr <= rowTiles[1]!; tr++) {
      for (let tc = colTiles[0]!; tc <= colTiles[1]!; tc++) this.ensureTile(sheet, info, tr, tc);
    }
  }

  private ensureTile(sheet: number, info: GridSheetInfo, tr: number, tc: number): void {
    const key = this.key(sheet, tr, tc);
    if (this.memory.has(key)) {
      this.memory.get(key);
      return;
    }
    if (this.pending.has(key)) return;

    const r0 = tr * TILE_ROWS;
    const c0 = tc * TILE_COLS;
    if (r0 >= info.rowCount || c0 >= info.columnCount) return;
    this.pending.add(key);

    const request = this.client.call('getTile', {
      sheet,
      r0,
      r1: Math.min(info.rowCount, r0 + TILE_ROWS),
      c0,
      c1: Math.min(info.columnCount, c0 + TILE_COLS),
    } as never) as Promise<GridTile>;

    void request
      .then((tile) => {
        const bytes = tile.text.reduce(
          (sum, row) => sum + row.reduce((inner, value) => inner + stringBytes(value), 0),
          tile.types.length * 64,
        );
        this.memory.set(key, tile, bytes);
        this.revision++;
        for (const listener of this.listeners) listener();
      })
      .catch((err) => {
        if ((err as { name?: string })?.name !== 'AbortError') console.warn('[lookglass] grid tile failed', err);
      })
      .finally(() => this.pending.delete(key));
  }

  private key(sheet: number, tr: number, tc: number): string {
    return `tile:${sheet}:${tr}:${tc}`;
  }
}
