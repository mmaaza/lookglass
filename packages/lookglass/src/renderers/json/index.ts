'use client';

import { BaseController } from '../../core/controller.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { Capabilities, DocMeta, SearchHit } from '../../types.js';
import type { JsonWorkerHandlers } from '../../workers/json.worker.js';
import { createTreeSurface } from '../tree/surface.js';
import { TreeStore, type TreeClientApi } from '../tree/tree-store.js';

const CAPABILITIES: Capabilities = {
  // "Pages" are visible rows, which is what search results scroll to.
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

/**
 * JSON and JSON Lines.
 *
 * No `JSON.parse` anywhere in the path: the worker scans the bytes once into
 * an offset table, and values are decoded per visible row. That is what keeps
 * a 500 MB document openable — `JSON.parse` on one allocates an object graph
 * several times the file size and blocks the thread for tens of seconds
 * before it either succeeds or throws.
 */
export const jsonRenderer: RendererFactory = {
  id: 'lookglass/json',
  kinds: ['json', 'jsonl'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const client = ctx.workers.lease<JsonWorkerHandlers>(
      ctx.docId,
      'tree',
      () => new Worker(new URL('../../workers/json.worker.js', import.meta.url), { type: 'module' }),
    );
    ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

    const descriptor = await ctx.source.descriptor();
    ctx.token.throwIfAborted();

    const result = await client.call(
      'open',
      { descriptor, ndjson: ctx.format.kind === 'jsonl' },
      { signal: ctx.token.signal, onProgress: ctx.onProgress },
    );

    const store = new TreeStore(client as never as import('../../core/rpc.js').RpcClient<TreeClientApi>, ctx.memory, result.visibleCount);

    const controller = new BaseController({
      pageCount: Math.max(1, result.visibleCount),
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'none', zoom: 1 },
      runSearch: async (query, emit, signal) => {
        const search = await client.call('search', { query }, { signal, onProgress: ctx.onProgress });
        // Search expands ancestors of every hit, so the visible row count has
        // changed underneath the store and the cached rows are stale.
        await store.resync();
        controller.setPageCount(Math.max(1, store.visibleCount));
        emit(search.hits as SearchHit[]);
        return { truncated: search.truncated };
      },
    });

    const meta: DocMeta = {
      kind: ctx.format.kind,
      capabilities: CAPABILITIES,
      pageCount: Math.max(1, result.visibleCount),
      pageLabel: 'row',
      title: ctx.source.name,
      extra: {
        nodes: result.nodeCount,
        depth: result.maxDepth,
        bytes: result.byteLength,
      },
      degraded: result.truncated
        ? {
            reason: 'truncated',
            message: `Only the first ${result.nodeCount.toLocaleString()} nodes are indexed. Download the file to inspect the rest.`,
            detail: { nodes: result.nodeCount },
          }
        : undefined,
    };

    const Surface = createTreeSurface({
      store,
      controller,
      label: ctx.format.kind === 'jsonl' ? 'JSON Lines document' : 'JSON document',
    });

    // Expanding or collapsing changes how many rows exist, and the controller
    // owns the count the toolbar and search rely on.
    const unsubscribe = store.subscribe(() => {
      const count = Math.max(1, store.visibleCount);
      if (count !== controller.getState().pageCount) controller.setPageCount(count);
    });

    return {
      meta,
      controller,
      Surface,
      dispose: () => {
        unsubscribe();
        controller.dispose();
        void client.call('close', undefined as never).catch(() => undefined);
        ctx.workers.release(ctx.docId);
      },
    };
  },
};

export default jsonRenderer;
