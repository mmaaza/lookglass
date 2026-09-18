'use client';

import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { RpcClient } from '../../core/rpc.js';
import type { DocMeta } from '../../types.js';
import type { CsvWorkerHandlers } from '../../workers/csv.worker.js';
import type { GridWorkerApi } from '../../workers/grid-types.js';
import { GRID_CAPABILITIES, createGridDocument } from '../grid/open-grid.js';

export interface CsvRendererOptions {
  /** Treat the first row as column titles. Default `'auto'` guesses. */
  header?: boolean | 'auto';
}

const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' };

/**
 * CSV and TSV of any size.
 *
 * The worker indexes row offsets in one streaming pass and serves tiles by
 * reading only the rows on screen, so a multi-gigabyte export opens without
 * ever being held in memory. Sorting and filtering are deliberately absent:
 * both need every row materialised, which is exactly what this avoids.
 */
export const csvRenderer: RendererFactory = {
  id: 'lookglass/csv',
  kinds: ['csv'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const options = (ctx.options.rendererOptions?.['lookglass/csv'] ?? {}) as CsvRendererOptions;
    const client = ctx.workers.lease<CsvWorkerHandlers>(
      ctx.docId,
      'sheet',
      () => new Worker(new URL('../../workers/csv.worker.js', import.meta.url), { type: 'module' }),
    );
    ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

    const descriptor = await ctx.source.descriptor();
    ctx.token.throwIfAborted();
    const result = await client.call(
      'open',
      { descriptor, ext: ctx.format.ext, header: options.header ?? 'auto' },
      { signal: ctx.token.signal, onProgress: ctx.onProgress },
    );

    const { controller, Surface } = createGridDocument(
      ctx,
      client as unknown as RpcClient<GridWorkerApi & Record<string, never>>,
      { rowCount: result.info.rowCount, capabilities: GRID_CAPABILITIES, label: 'Table' },
    );

    const meta: DocMeta = {
      kind: 'csv',
      capabilities: GRID_CAPABILITIES,
      pageCount: Math.max(1, result.info.rowCount),
      pageLabel: 'row',
      title: ctx.source.name,
      extra: {
        rows: result.info.rowCount,
        columns: result.info.columnCount,
        delimiter: DELIMITER_NAMES[result.delimiter] ?? result.delimiter,
        encoding: result.encoding,
        bytes: result.byteLength,
      },
      degraded: result.info.truncated
        ? {
            reason: 'truncated',
            message: `Only the first ${result.info.truncated.shownRows.toLocaleString()} rows are indexed.`,
            detail: { rows: result.info.truncated.shownRows },
          }
        : undefined,
    };

    return {
      meta,
      controller,
      Surface,
      dispose: () => {
        controller.dispose();
        void client.call('close', undefined as never).catch(() => undefined);
        ctx.workers.release(ctx.docId);
      },
    };
  },
};

export default csvRenderer;
