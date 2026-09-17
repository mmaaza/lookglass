'use client';

import { BaseController } from '../../core/controller.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import { createRpcClient, type RpcClient } from '../../core/rpc.js';
import { createWorker } from '../../core/worker-pool.js';
import type { Capabilities, DocMeta, SearchHit } from '../../types.js';
import type { TextWorkerHandlers } from '../../workers/text.worker.js';
import { languageFor } from '../../core/languages.js';
import { BLOCK_LINES, LineStore } from './line-store.js';
import { createTextSurface } from './surface.js';

const CAPABILITIES: Capabilities = {
  pages: true, // "page" means line here: it is what search results scroll to
  search: true,
  zoom: true,
  rotate: false,
  textSelect: true,
  outline: false,
  thumbnails: false,
  sheets: false,
  print: true,
};

export interface TextRendererOptions {
  showLineNumbers?: boolean;
  /**
   * Syntax highlighting. `'auto'` (the default) enables it for recognised
   * source extensions under 2 MB; `false` never loads the highlighter.
   */
  highlight?: boolean | 'auto';
  /** Character encoding override. Sniffed from a BOM or UTF-8 validity. */
  encoding?: string;
}

/**
 * Reference renderer for plain text and logs.
 *
 * It is the smallest complete implementation of the renderer contract, and it
 * exercises every core subsystem end to end: worker lease, RPC with progress
 * and cancellation, byte-budgeted block cache, virtualised surface, and
 * streaming search. Every later format follows this shape.
 */
export const textRenderer: RendererFactory = {
  id: 'lookglass/text',
  kinds: ['text'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const options = (ctx.options.rendererOptions?.['lookglass/text'] ?? {}) as TextRendererOptions;

    const client = ctx.workers.lease<TextWorkerHandlers>(
      ctx.docId,
      'text',
      () => new Worker(new URL('../../workers/text.worker.js', import.meta.url), { type: 'module' }),
    );
    ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

    const descriptor = await ctx.source.descriptor();
    ctx.token.throwIfAborted();

    ctx.onProgress({ phase: 'indexing', message: 'Indexing lines' });
    const result = await client.call(
      'open',
      { descriptor, encoding: options.encoding },
      { signal: ctx.token.signal, onProgress: ctx.onProgress },
    );

    const language = options.highlight === false ? undefined : languageFor(ctx.source.name, ctx.format.ext);
    let highlightNote: string | undefined;
    let highlighted = false;
    if (language) {
      ctx.onProgress({ phase: 'rendering', message: `Loading ${language} highlighting` });
      const outcome = await client.call(
        'enableHighlight',
        { language, blockLines: BLOCK_LINES },
        { signal: ctx.token.signal },
      );
      highlighted = outcome.enabled;
      highlightNote = outcome.reason;
    }

    const store = new LineStore(client, ctx.memory, result.lineCount, highlighted);

    const controller = new BaseController({
      pageCount: Math.max(1, result.lineCount),
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'none', zoom: 1 },
      runSearch: async (query, emit, signal) => {
        const search = await client.call(
          'search',
          { query },
          {
            signal,
            // Hits stream back as progress so the first matches land while a
            // multi-gigabyte scan is still running.
            onProgress: (update) => ctx.onProgress(update),
          },
        );
        emit(search.hits as SearchHit[]);
        return { truncated: search.truncated };
      },
    });

    const meta: DocMeta = {
      kind: 'text',
      capabilities: CAPABILITIES,
      pageCount: Math.max(1, result.lineCount),
      pageLabel: 'line',
      title: ctx.source.name,
      extra: {
        lines: result.lineCount,
        bytes: result.byteLength,
        encoding: result.encoding,
        ...(language ? { language, highlighted, ...(highlightNote ? { highlightNote } : {}) } : {}),
      },
      degraded: result.truncated
        ? {
            reason: 'truncated',
            message: `Only the first ${result.lineCount.toLocaleString()} lines are indexed. Download the file to see the rest.`,
            detail: { linesIndexed: result.lineCount, bytesIndexed: result.indexedBytes },
          }
        : undefined,
    };

    const Surface = createTextSurface({
      store,
      controller,
      lineCount: Math.max(1, result.lineCount),
      showLineNumbers: options.showLineNumbers ?? true,
    });

    return {
      meta,
      controller,
      Surface,
      dispose: () => {
        controller.dispose();
        void (client as RpcClient<TextWorkerHandlers>).call('close', undefined as never).catch(() => undefined);
        ctx.workers.release(ctx.docId);
      },
    };
  },
};

/**
 * Load every syntax grammar inside a throwaway text worker, so the service
 * worker caches the grammar chunks for offline use. Grammars are dynamic
 * imports *inside* the worker, which the main-thread registry preload cannot
 * reach on its own.
 */
export async function preloadHighlighting(): Promise<{ loaded: string[]; failed: string[] }> {
  const worker = createWorker(
    'text',
    () => new Worker(new URL('../../workers/text.worker.js', import.meta.url), { type: 'module' }),
  );
  const client = createRpcClient<TextWorkerHandlers>(worker, 'text worker');
  try {
    return await client.call('preloadHighlighting', undefined as never, { timeoutMs: 120_000 });
  } finally {
    client.terminate();
  }
}

export default textRenderer;
