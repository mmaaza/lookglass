import { detectFormat } from '../detect/index.js';
import { formatBytes, opfsSource, opfsSupported, persistToOpfs, resolveSource } from '../source/index.js';
import type { Source, SourceInput } from '../source/types.js';
import type { DetectedFormat, LoadProgress } from '../types.js';
import { LoadToken } from './cancel.js';
import { ViewerError, isAbort } from './errors.js';
import { sharedMemory, type MemoryManager } from './memory.js';
import { registry } from './registry.js';
import { DEFAULT_RENDERER_OPTIONS, type OpenedDoc, type RendererOptions } from './renderer.js';
import { sharedWorkerPool, type WorkerPool } from './worker-pool.js';

export interface OfflineOptions {
  /**
   * Stream remote documents into OPFS on first open so later opens work with
   * no network. Local `File` inputs are never copied — they already are local.
   */
  cache: boolean;
  /** Stable cache identity. Defaults to the source URL. */
  key?: string;
  /** Version stamp (ETag) used to invalidate a cached copy. */
  version?: string;
  /** Skip caching above this size. Defaults to 2 GB. */
  maxBytes?: number;
}

export interface OpenDocumentOptions {
  source: SourceInput;
  token?: LoadToken;
  onProgress?: (update: LoadProgress) => void;
  offline?: OfflineOptions;
  options?: Partial<RendererOptions>;
  memory?: MemoryManager;
  workers?: WorkerPool;
  /** Override detection entirely, e.g. to force a text view of anything. */
  forceKind?: DetectedFormat['kind'];
}

export interface OpenDocumentResult {
  doc: OpenedDoc;
  format: DetectedFormat;
  source: Source;
  /** True when the bytes were served from the offline cache. */
  fromCache: boolean;
  dispose(): Promise<void>;
}

let docCounter = 0;

/**
 * Full open pipeline: resolve bytes -> detect -> load renderer chunk -> open.
 *
 * Every stage checks the token, so an unmount part-way through aborts the
 * fetch, skips the parse and never constructs a worker. Disposal is
 * registered as we go rather than at the end, so a failure mid-pipeline still
 * releases whatever was already acquired.
 */
export async function openDocument(opts: OpenDocumentOptions): Promise<OpenDocumentResult> {
  const token = opts.token ?? new LoadToken();
  const memory = opts.memory ?? sharedMemory();
  const workers = opts.workers ?? sharedWorkerPool();
  const docId = `doc-${++docCounter}`;
  const report = (update: LoadProgress) => opts.onProgress?.(update);

  report({ phase: 'resolving' });
  let source = resolveSource(opts.source);
  let fromCache = false;
  token.onDispose(() => source.dispose());

  try {
    // ---- offline cache -------------------------------------------------
    if (opts.offline?.cache && source.origin === 'http' && opfsSupported()) {
      const key = opts.offline.key ?? source.id;
      const cached = await opfsSource(key).catch(() => undefined);
      token.throwIfAborted();

      if (cached) {
        source = cached;
        fromCache = true;
      } else {
        report({ phase: 'persisting', message: 'Saving for offline use' });
        try {
          source = await persistToOpfs(source, {
            key,
            version: opts.offline.version,
            token,
            maxBytes: opts.offline.maxBytes,
            onProgress: (done, total) =>
              report({
                phase: 'persisting',
                bytesDone: done,
                bytesTotal: total,
                ratio: total > 0 ? done / total : undefined,
                message: `Saving for offline use — ${formatBytes(done)}`,
              }),
          });
        } catch (err) {
          if (isAbort(err)) throw err;
          // Caching is an optimisation. A full disk or a quota refusal must
          // not stop the user from viewing the document right now.
          console.warn('[lookglass] offline caching failed; continuing online', err);
        }
      }
    }

    token.throwIfAborted();

    // ---- detect --------------------------------------------------------
    report({ phase: 'detecting' });
    const detected = await detectFormat(source, { signal: token.signal });
    const format: DetectedFormat = opts.forceKind
      ? { ...detected, kind: opts.forceKind, confidence: 1, method: 'fallback' }
      : detected;

    token.throwIfAborted();

    if (format.kind === 'unknown') {
      throw new ViewerError(
        'unsupported-format',
        `${source.name} is not a file type lookglass can display.`,
        { detail: { name: source.name, size: source.size }, retryable: false },
      );
    }

    // ---- renderer ------------------------------------------------------
    report({ phase: 'parsing', message: `Loading the ${format.label.toLowerCase()} viewer` });
    const factory = await registry.resolve(format.kind);
    token.throwIfAborted();

    const rendererOptions: RendererOptions = { ...DEFAULT_RENDERER_OPTIONS, ...opts.options };
    const scoped = memory.scope(docId);
    token.onDispose(() => scoped.dispose());

    const doc = await factory.open({
      source,
      format,
      token,
      memory: scoped,
      workers,
      docId,
      onProgress: report,
      options: rendererOptions,
    });

    token.onDispose(() => doc.dispose());
    token.throwIfAborted();
    report({ phase: 'ready' });

    return {
      doc,
      format,
      source,
      fromCache,
      dispose: () => token.dispose(),
    };
  } catch (err) {
    await token.dispose();
    if (isAbort(err)) throw err;
    throw ViewerError.from(err);
  }
}
