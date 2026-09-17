'use client';

import { BaseController } from '../../core/controller.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { Capabilities, DocMeta, SearchHit } from '../../types.js';
import type { MarkdownWorkerHandlers } from '../../workers/markdown.worker.js';
import { createMarkdownSurface } from './surface.js';

const CAPABILITIES: Capabilities = {
  // Blocks act as pages: they are what search results and the outline target.
  pages: true,
  search: true,
  zoom: true,
  rotate: false,
  textSelect: true,
  outline: true,
  thumbnails: false,
  sheets: false,
  print: true,
};

/**
 * Markdown with GFM.
 *
 * Parsing and sanitisation both happen in the worker, so a large document
 * never blocks the main thread and no unsanitised HTML can reach the DOM even
 * transiently.
 */
export const markdownRenderer: RendererFactory = {
  id: 'lookglass/markdown',
  kinds: ['markdown'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const client = ctx.workers.lease<MarkdownWorkerHandlers>(
      ctx.docId,
      'tree',
      () => new Worker(new URL('../../workers/markdown.worker.js', import.meta.url), { type: 'module' }),
    );
    ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

    const descriptor = await ctx.source.descriptor();
    ctx.token.throwIfAborted();

    const result = await client.call('open', { descriptor }, { signal: ctx.token.signal, onProgress: ctx.onProgress });

    const controller = new BaseController({
      pageCount: Math.max(1, result.blockCount),
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'none', zoom: 1 },
      runSearch: async (query, emit, signal) => {
        const search = await client.call('search', { query }, { signal });
        emit(search.hits as SearchHit[]);
        return { truncated: search.truncated };
      },
    });

    const meta: DocMeta = {
      kind: 'markdown',
      capabilities: CAPABILITIES,
      pageCount: Math.max(1, result.blockCount),
      pageLabel: 'block',
      title: ctx.source.name,
      extra: { blocks: result.blockCount, bytes: result.byteLength },
      degraded: result.truncated
        ? {
            reason: 'size',
            message: 'Only the first 32 MB of this document is rendered. Download the file to read the rest.',
          }
        : undefined,
    };

    const Surface = createMarkdownSurface({
      client,
      controller,
      memory: ctx.memory,
      blockCount: Math.max(1, result.blockCount),
    });

    return {
      meta,
      controller,
      Surface,
      outline: () => Promise.resolve(result.outline),
      dispose: () => {
        controller.dispose();
        void client.call('close', undefined as never).catch(() => undefined);
        ctx.workers.release(ctx.docId);
      },
    };
  },
};

export default markdownRenderer;
