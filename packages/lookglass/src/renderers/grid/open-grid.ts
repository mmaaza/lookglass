'use client';

import { BaseController } from '../../core/controller.js';
import type { OpenContext } from '../../core/renderer.js';
import type { RpcClient } from '../../core/rpc.js';
import type { Capabilities, SearchHit } from '../../types.js';
import type { GridWorkerApi } from '../../workers/grid-types.js';
import { GridStore } from './grid-store.js';
import { createGridSurface } from './surface.js';

export const GRID_CAPABILITIES: Capabilities = {
  // "Pages" are rows: search hits, the toolbar and keyboard nav address rows.
  pages: true,
  search: true,
  zoom: true,
  rotate: false,
  textSelect: true,
  outline: false,
  thumbnails: false,
  sheets: false,
  print: false,
};

type GridClient = RpcClient<GridWorkerApi & Record<string, never>>;

/**
 * Controller, store and surface for any tabular worker. CSV and workbooks
 * differ in how they open; everything after that is this.
 */
export function createGridDocument(
  ctx: OpenContext,
  client: GridClient,
  opts: { rowCount: number; capabilities: Capabilities; label: string },
) {
  const store = new GridStore(client, ctx.memory);
  const controller = new BaseController({
    pageCount: Math.max(1, opts.rowCount),
    capabilities: opts.capabilities,
    initialViewport: { fit: 'none', zoom: 1 },
    runSearch: async (query, emit, signal) => {
      // Search covers the sheet on screen; hits carry their cell address.
      const sheet = controller.getState().sheet;
      const result = (await client.call('search', { sheet, query } as never, {
        signal,
        onProgress: ctx.onProgress,
      })) as { hits: SearchHit[]; truncated: boolean };
      emit(result.hits);
      return { truncated: result.truncated };
    },
  });
  const Surface = createGridSurface({ store, controller, label: opts.label });
  return { store, controller, Surface };
}
