'use client';

import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { withAbort } from '../../core/cancel.js';
import { BaseController } from '../../core/controller.js';
import { ViewerError, isAbort } from '../../core/errors.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import { createWorker } from '../../core/worker-pool.js';
import type { Capabilities, DocMeta, OutlineNode, SearchHit } from '../../types.js';
import { PdfPages } from './pages.js';
import { createPdfSurface } from './surface.js';
import { createSourceTransport } from './transport.js';

const CAPABILITIES: Capabilities = {
  pages: true,
  search: true,
  zoom: true,
  rotate: true,
  textSelect: true,
  outline: true,
  thumbnails: false,
  sheets: false,
  // A virtualised document has most pages unmounted, so browser print would
  // produce mostly blank sheets. Download is the honest path.
  print: false,
};

/** Bytes handed to PDF.js up front. Covers the header and linearisation dict. */
const INITIAL_BYTES = 64 * 1024;
/** Below this the whole file is passed in one go; ranges would only add latency. */
const WHOLE_FILE_BYTES = 2 * 1024 * 1024;
const RANGE_CHUNK_BYTES = 64 * 1024;
const SEARCH_HIT_LIMIT = 2000;

export interface PdfRendererOptions {
  /** Allow fonts installed on the device as substitutes. Default true. */
  useSystemFonts?: boolean;
}

export const pdfRenderer: RendererFactory = {
  id: 'lookglass/pdf',
  kinds: ['pdf'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const options = (ctx.options.rendererOptions?.['lookglass/pdf'] ?? {}) as PdfRendererOptions;
    const { token, source } = ctx;

    ctx.onProgress({ phase: 'parsing', message: 'Loading PDF engine' });
    const pdfjs = await import('pdfjs-dist');
    token.throwIfAborted();

    // One PDF.js worker per document, terminated with it — the same lifetime
    // rule as every other lookglass worker, and the only way closing a large
    // PDF reliably frees its parsed object graph.
    const worker = createWorker(
      'pdf',
      () => new Worker(new URL('../../workers/pdf.worker.js', import.meta.url), { type: 'module' }),
    );
    token.onDispose(() => worker.terminate());
    await waitForWorkerReady(worker, token.signal);
    const pdfWorker = new pdfjs.PDFWorker({ port: worker as never });
    token.onDispose(() => pdfWorker.destroy());

    ctx.onProgress({ phase: 'fetching', message: 'Reading document structure' });
    // Reading the head also resolves the size of a remote source.
    const head = await source.slice(0, INITIAL_BYTES, token.signal);
    const length = source.size >= 0 ? source.size : head.byteLength;
    const initialData = length <= WHOLE_FILE_BYTES ? await source.slice(0, length, token.signal) : head;

    let transportError: unknown;
    const { transport, stats } = createSourceTransport(
      pdfjs.PDFDataRangeTransport,
      source,
      length,
      initialData,
      token.signal,
      (err) => {
        transportError ??= err;
        void loadingTask.destroy();
      },
    );

    const base = ctx.options.assetBasePath.replace(/\/+$/, '');
    const loadingTask: PDFDocumentLoadingTask = pdfjs.getDocument({
      range: transport,
      worker: pdfWorker,
      // Only fetch what the visible pages need. Without these PDF.js reads
      // the whole file in the background after the first page appears.
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: RANGE_CHUNK_BYTES,
      // Same-origin assets copied by `lookglass-copy-assets`. Never a CDN:
      // missing cmaps mean blank CJK text, and this has to work offline.
      cMapUrl: `${base}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}/standard_fonts/`,
      wasmUrl: `${base}/wasm/`,
      iccUrl: `${base}/iccs/`,
      useSystemFonts: options.useSystemFonts ?? true,
      // Documents never run their own JavaScript or render XFA forms here.
      enableXfa: false,
    });

    let attempt = 0;
    loadingTask.onPassword = (update: (password: string) => void, reason: number) => {
      attempt++;
      if (!ctx.options.requestPassword) {
        void loadingTask.destroy();
        return;
      }
      void ctx.options.requestPassword(attempt).then(
        (password) => {
          if (password === null) void loadingTask.destroy();
          else update(password);
        },
        () => void loadingTask.destroy(),
      );
      void reason;
    };
    token.onDispose(() => loadingTask.destroy());

    let doc: PDFDocumentProxy;
    try {
      doc = await withAbort(loadingTask.promise, token.signal);
    } catch (err) {
      throw toViewerError(err, transportError, attempt, Boolean(ctx.options.requestPassword));
    }
    token.throwIfAborted();

    const first = await doc.getPage(1);
    const firstViewport = first.getViewport({ scale: 1 });
    const pages = new PdfPages(
      doc,
      ctx.memory,
      { width: firstViewport.width, height: firstViewport.height },
      ctx.options.maxDevicePixelRatio,
    );
    token.onDispose(() => pages.dispose());

    const controller = new BaseController({
      pageCount: doc.numPages,
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'width', zoom: 1 },
      runSearch: (query, emit, signal) => searchDocument(pages, query, emit, signal, ctx.onProgress),
    });

    const metadata = await doc.getMetadata().catch(() => undefined);
    const info = (metadata?.info ?? {}) as { Title?: string; Author?: string };

    const meta: DocMeta = {
      kind: 'pdf',
      capabilities: CAPABILITIES,
      pageCount: doc.numPages,
      pageLabel: 'page',
      title: info.Title?.trim() || source.name,
      author: info.Author?.trim() || undefined,
      intrinsicSize: { width: firstViewport.width, height: firstViewport.height },
      extra: {
        pages: doc.numPages,
        bytes: length,
        // How much of the file range loading actually needed to show page 1.
        bytesFetchedAtOpen: initialData.byteLength + stats.bytesRequested,
        encrypted: attempt > 0,
      },
    };

    let outline: Promise<OutlineNode[]> | undefined;

    return {
      meta,
      controller,
      Surface: createPdfSurface({ pdfjs, pages, controller }),
      outline: () => {
        outline ??= buildOutline(doc, pages);
        return outline;
      },
      dispose: () => {
        controller.dispose();
        pages.dispose();
        void doc.destroy();
      },
    };
  },
};

/**
 * Page-by-page search with streamed results.
 *
 * Hits for each page are emitted as soon as that page is scanned, so the
 * first matches in a 2,000-page document appear immediately. Page text is
 * cached in the byte budget, so repeat searches skip the extraction.
 */
async function searchDocument(
  pages: PdfPages,
  query: string,
  emit: (hits: SearchHit[]) => void,
  signal: AbortSignal,
  onProgress: OpenContext['onProgress'],
): Promise<{ truncated?: boolean }> {
  const needle = query.toLowerCase();
  let found = 0;

  for (let pageNumber = 1; pageNumber <= pages.pageCount; pageNumber++) {
    signal.throwIfAborted();
    let text;
    try {
      text = await pages.text(pageNumber, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      // One unreadable page must not end the whole search.
      continue;
    }

    const haystack = text.joined.toLowerCase();
    const hits: SearchHit[] = [];
    let at = haystack.indexOf(needle);
    while (at !== -1 && found + hits.length < SEARCH_HIT_LIMIT) {
      const start = Math.max(0, at - 40);
      hits.push({
        id: `${pageNumber}:${at}`,
        page: pageNumber,
        excerpt: text.joined.slice(start, at + needle.length + 40).replace(/\s+/g, ' '),
        excerptOffset: at - start,
        excerptLength: needle.length,
      });
      at = haystack.indexOf(needle, at + needle.length);
    }

    if (hits.length > 0) {
      found += hits.length;
      emit(hits);
    }
    if (found >= SEARCH_HIT_LIMIT) return { truncated: true };

    if (pageNumber % 25 === 0) {
      onProgress({
        phase: 'indexing',
        ratio: pageNumber / pages.pageCount,
        message: `Searched ${pageNumber} of ${pages.pageCount} pages`,
      });
    }
  }
  return { truncated: false };
}

async function buildOutline(doc: PDFDocumentProxy, pages: PdfPages): Promise<OutlineNode[]> {
  const raw = await doc.getOutline();
  if (!raw) return [];

  let counter = 0;
  type RawItem = { title: string; dest: string | unknown[] | null; items: RawItem[] };

  const convert = async (items: RawItem[]): Promise<OutlineNode[]> =>
    Promise.all(
      items.map(async (item) => ({
        id: `outline-${counter++}`,
        title: item.title,
        page: item.dest ? await pages.resolveDestination(item.dest) : undefined,
        children: item.items.length > 0 ? await convert(item.items) : undefined,
      })),
    );

  return convert(raw as RawItem[]);
}

/**
 * Wait for the PDF.js worker to announce itself before handing it to PDF.js.
 *
 * When `PDFWorker` is given an existing port it assumes the worker is already
 * running and posts its setup messages immediately. The worker module is over
 * a megabyte; while it is still evaluating, those messages are dispatched
 * before its listener exists and are silently lost, and the document load
 * then waits forever with no error. PDF.js's own worker bootstrap avoids this
 * by waiting for the worker's `ready` message — so this does the same.
 */
function waitForWorkerReady(worker: Worker, signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onMessage = (event: MessageEvent<{ action?: string; sourceName?: string }>) => {
      if (event.data?.action !== 'ready') return;
      cleanup();
      resolve();
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(
        new ViewerError('worker-failed', `The PDF worker failed to start: ${event.message || 'unknown error'}`, {
          retryable: true,
        }),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new ViewerError(
          'worker-failed',
          'The PDF worker did not start. If you are offline, its code may not have been cached yet.',
          { retryable: true },
        ),
      );
    }, timeoutMs);

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toViewerError(err: unknown, transportError: unknown, attempts: number, canPrompt: boolean): ViewerError {
  if (transportError) return ViewerError.from(transportError, 'network');
  if (isAbort(err)) return ViewerError.from(err);

  const name = (err as { name?: string })?.name;
  if (name === 'PasswordException') {
    if (!canPrompt) {
      return new ViewerError('password-required', 'This PDF is password protected.', { retryable: false });
    }
    return attempts > 1
      ? new ViewerError('password-wrong', 'The password was incorrect.', { retryable: true })
      : new ViewerError('password-required', 'This PDF is password protected.', { retryable: true });
  }
  if (name === 'InvalidPDFException') {
    return new ViewerError('corrupt', 'This file is not a valid PDF, or it is damaged.', { cause: err, retryable: false });
  }
  if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') {
    return new ViewerError('network', 'The PDF could not be loaded.', { cause: err, retryable: true });
  }
  // Destroying the task (cancelled password prompt) surfaces as a generic
  // "Worker was destroyed" error; report it as the cancellation it is.
  if (/destroyed/i.test(String((err as Error)?.message))) {
    return attempts > 0
      ? new ViewerError('password-required', 'This PDF is password protected.', { retryable: true })
      : new ViewerError('aborted', 'Loading was cancelled.', { cause: err });
  }
  return ViewerError.from(err);
}

export default pdfRenderer;
