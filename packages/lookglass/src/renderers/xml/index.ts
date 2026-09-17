'use client';

import { BaseController } from '../../core/controller.js';
import type { RpcClient } from '../../core/rpc.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { Capabilities, DegradationNotice, DocMeta, SearchHit } from '../../types.js';
import type { XmlWorkerHandlers } from '../../workers/xml.worker.js';
import { createTreeSurface } from '../tree/surface.js';
import { TreeStore, type TreeClientApi } from '../tree/tree-store.js';

const CAPABILITIES: Capabilities = {
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
 * XML documents.
 *
 * Entities are never expanded — see `xml-parse.ts` for why that is a security
 * property rather than a limitation. When a document declares its own
 * entities the user is told, because references will render literally.
 */
export const xmlRenderer: RendererFactory = {
  id: 'lookglass/xml',
  kinds: ['xml'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const client = ctx.workers.lease<XmlWorkerHandlers>(
      ctx.docId,
      'tree',
      () => new Worker(new URL('../../workers/xml.worker.js', import.meta.url), { type: 'module' }),
    );
    ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

    const descriptor = await ctx.source.descriptor();
    ctx.token.throwIfAborted();

    const result = await client.call('open', { descriptor }, { signal: ctx.token.signal, onProgress: ctx.onProgress });

    const store = new TreeStore(client as unknown as RpcClient<TreeClientApi>, ctx.memory, result.visibleCount);

    const controller = new BaseController({
      pageCount: Math.max(1, result.visibleCount),
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'none', zoom: 1 },
      runSearch: async (query, emit, signal) => {
        const search = await client.call('search', { query }, { signal, onProgress: ctx.onProgress });
        // Search reveals matched nodes, which expands their ancestors; the
        // store's cached rows and row count are stale until resynced.
        await store.resync();
        controller.setPageCount(Math.max(1, store.visibleCount));
        emit(search.hits as SearchHit[]);
        return { truncated: search.truncated };
      },
    });

    const meta: DocMeta = {
      kind: 'xml',
      capabilities: CAPABILITIES,
      pageCount: Math.max(1, result.visibleCount),
      pageLabel: 'row',
      title: ctx.source.name,
      extra: {
        nodes: result.nodeCount,
        depth: result.maxDepth,
        bytes: result.byteLength,
        encoding: result.encoding ?? 'utf-8',
      },
      degraded: buildNotice(result),
    };

    const Surface = createTreeSurface({ store, controller, label: 'XML document' });

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

function buildNotice(result: {
  truncated: boolean;
  nodeCount: number;
  entitiesDeclared: boolean;
  mismatched: number;
}): DegradationNotice | undefined {
  if (result.truncated) {
    return {
      reason: 'truncated',
      message: `Only the first ${result.nodeCount.toLocaleString()} nodes are indexed. Download the file to inspect the rest.`,
      detail: { nodes: result.nodeCount },
    };
  }
  if (result.entitiesDeclared) {
    return {
      reason: 'unsupported-feature',
      message:
        'This document declares custom entities. They are shown literally and never expanded, which protects against entity-expansion and external-entity attacks.',
    };
  }
  if (result.mismatched > 0) {
    return {
      reason: 'partial-parse',
      message: `${result.mismatched} closing ${result.mismatched === 1 ? 'tag does' : 'tags do'} not match the element it closes. The structure shown is a best effort.`,
      detail: { mismatched: result.mismatched },
    };
  }
  return undefined;
}

export default xmlRenderer;
