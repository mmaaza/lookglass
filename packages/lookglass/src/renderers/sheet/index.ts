'use client';

import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { RpcClient } from '../../core/rpc.js';
import type { Capabilities, DocMeta } from '../../types.js';
import type { GridWorkerApi } from '../../workers/grid-types.js';
import type { SheetWorkerHandlers } from '../../workers/sheet.worker.js';
import { GRID_CAPABILITIES, createGridDocument } from '../grid/open-grid.js';

export interface SheetRendererOptions {
  /** Whole-file ceiling; workbooks are compressed and cannot be range-read. */
  maxBytes?: number;
  /** Rows parsed per sheet. The main memory lever; default 100,000. */
  maxRows?: number;
}

const CAPABILITIES: Capabilities = { ...GRID_CAPABILITIES, sheets: true };

/**
 * Excel and OpenDocument workbooks: XLSX, XLSM, XLSB, XLS and ODS.
 *
 * Opening lists the sheets without parsing any; each sheet is parsed the
 * first time it is shown. Formulas show the value cached in the file and are
 * never evaluated.
 */
export const sheetRenderer: RendererFactory = {
  id: 'lookglass/sheet',
  kinds: ['xlsx', 'xls', 'ods'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const options = (ctx.options.rendererOptions?.['lookglass/sheet'] ?? {}) as SheetRendererOptions;
    const client = ctx.workers.lease<SheetWorkerHandlers>(
      ctx.docId,
      'sheet',
      () => new Worker(new URL('../../workers/sheet.worker.js', import.meta.url), { type: 'module' }),
    );
    ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

    const descriptor = await ctx.source.descriptor();
    ctx.token.throwIfAborted();
    const book = await client.call(
      'open',
      { descriptor, maxBytes: options.maxBytes, maxRows: options.maxRows },
      { signal: ctx.token.signal, onProgress: ctx.onProgress },
    );

    // Open on the first visible sheet, as Excel does.
    const initialSheet = Math.max(
      0,
      book.sheets.findIndex((sheet) => !sheet.hidden),
    );
    const first = await client.call(
      'openSheet',
      { sheet: initialSheet },
      { signal: ctx.token.signal, onProgress: ctx.onProgress },
    );

    const { controller, Surface } = createGridDocument(
      ctx,
      client as unknown as RpcClient<GridWorkerApi & Record<string, never>>,
      { rowCount: first.rowCount, capabilities: CAPABILITIES, label: 'Spreadsheet' },
    );
    if (initialSheet > 0) controller.setSheet(initialSheet);

    const meta: DocMeta = {
      kind: ctx.format.kind,
      capabilities: CAPABILITIES,
      pageCount: Math.max(1, first.rowCount),
      pageLabel: 'row',
      title: book.title ?? ctx.source.name,
      author: book.author,
      sheets: book.sheets.map((sheet) => (sheet.hidden ? `${sheet.name} (hidden)` : sheet.name)),
      extra: { sheets: book.sheets.length, bytes: book.byteLength },
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

export default sheetRenderer;
